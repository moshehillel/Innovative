/**
 * Quote email intake — AI extraction from customer RFQ emails.
 */

"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai");
const {DEFAULT_OPENAI_MODEL} = require("./openai-models");

const QUOTE_CLASSIFY_BODY_MAX = 12000;

/**
 * Flatten HTML / MIME bodies into plain text for heuristics + AI.
 * @param {string} input Raw body.
 * @return {string}
 */
function toPlainText(input) {
  let text = String(input || "");
  if (/<[a-z][\s\S]*>/i.test(text)) {
    text = text
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<\/div>/gi, "\n")
        .replace(/<\/tr>/gi, "\n")
        .replace(/<\/li>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&quot;/gi, "\"");
  }
  return text
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
}

/**
 * Pull the first JSON object from a model response.
 * @param {string} raw Model text.
 * @return {string}
 */
function extractJsonObject(raw) {
  const cleaned = String(raw || "")
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  if (!cleaned) return "";
  if (cleaned.startsWith("{") && cleaned.endsWith("}")) return cleaned;
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) return cleaned.slice(start, end + 1);
  return cleaned;
}

/**
 * @param {object} client Anthropic client.
 * @param {object} payload subject/from/body.
 * @return {Promise<string>} Raw model text.
 */
async function callQuoteExtractionModel(client, payload) {
  const res = await client.messages.create({
    model: process.env.QUOTE_EXTRACT_MODEL || "claude-haiku-4-5",
    max_tokens: 4000,
    system: [
      "You extract LTL freight quote requests for a freight broker.",
      "Return ONLY valid JSON (no markdown).",
      "",
      "Keys:",
      "- format: multi_lane_table | single_shipment | unknown",
      "- customerRef: PO / sales order / subject reference",
      "- readyDate: YYYY-MM-DD or null",
      "- shipper: {name, address1, city, state, zipCode, country, phone}",
      "- lanes: array of {",
      "    laneKey: stable id e.g. PIONEER_OH,",
      "    label: e.g. TO PIONEER, OH,",
      "    consignee: {name, address1, city, state, zipCode, country, phone},",
      "    siteType: menards_dc | amazon_fc | aafes_military |",
      "      nursing_home | hotel | residential | other,",
      "    freightInfo: [{qty, weight, class, length, width, height,",
      "      dimType}],",
      "    referenceNumbers: [PO numbers],",
      "    specialInstructions: string,",
      "    flags: {missingClass, suspiciousPalletCount, residentialDelivery}",
      "  }",
      "- specialInstructionsGlobal: pickup/delivery notes for all lanes",
      "- customerRequest: {",
      "    wantsGuaranteedOptions: boolean,",
      "    wantsCarrierExpiration: boolean,",
      "    wantsLimitedAccessInQuote: boolean",
      "  }",
      "- flags: {needsDispatcherReview: boolean}",
      "",
      "Real patterns to recognize:",
      "- Ship From / Ship To blocks (Coreforce, warehouse quotes)",
      "- Inline origin + destination (GPA Perris CA → HGR6 Hagerstown MD)",
      "- Amazon FC codes: HGR6, FBA shipment ids in body",
      "- AAFES / military exchange DC names",
      "- Multi-pallet lines: 1 pallet 48x40x65 @ 602.5 lbs",
      "- Pickup address blocks without Ship From label (Petra / CTA Digital)",
      "- Subject may be just \"Quote\" — still extract shipper/consignee",
      "  from Pickup Location / Shipping To blocks in the body.",
      "",
      "Rules:",
      "- Group table rows by destination city/state/zip into one lane each.",
      "- Sum weight and pallets per lane when table groups freight blocks.",
      "- weightType should be total unless clearly per-piece.",
      "- dimType must be Primus packaging enum (not inch/cm):",
      "  PLT, CTN, CRT, DRM, CON, BOX, BDL, ENV, CYL, CAS, OTH, TOT,",
      "  or TRUCK LOAD. Use PLT for pallets/skids. Country codes ISO2",
      "  (US/CA/MX), never USA.",
      "- If class missing, set flags.missingClass true on that lane.",
      "- If pallet count seems wrong (>20), suspiciousPalletCount true.",
      "- Detect liftgate / no dock in global or lane instructions.",
      "- If email mentions accessorials (liftgate, residential,",
      "  appointment, limited access, inside delivery, etc.), copy",
      "  those phrases into specialInstructions /",
      "  specialInstructionsGlobal so quote rules can apply them.",
      "- Set flags.residentialDelivery true when residential/",
      "  home delivery is requested.",
      "- If customer asks for guaranteed + standard options,",
      "  set customerRequest.wantsGuaranteedOptions true.",
      "- If customer asks for carrier expiration days,",
      "  set customerRequest.wantsCarrierExpiration true.",
      "- If customer asks for limited/restricted delivery charges",
      "  in the quote email, set wantsLimitedAccessInQuote true.",
      "- Always return at least one lane when pickup + delivery addresses",
      "  are present, even if freight dims/class/weight are missing.",
    ].join("\n"),
    messages: [{
      role: "user",
      content: JSON.stringify(payload),
    }],
  });
  return (res.content || [])
      .filter((b) => b && b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n")
      .trim();
}

/**
 * Parse a US-style city/state/zip line.
 * @param {string} line Address line.
 * @return {object|null}
 */
function parseCityStateZip(line) {
  const m = String(line || "").match(
      /^(.+?),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/i);
  if (!m) return null;
  return {
    city: m[1].replace(/,/g, "").trim(),
    state: m[2].toUpperCase(),
    zipCode: m[3],
  };
}

/**
 * Parse a freeform address block into name/address/city/state/zip/phone.
 * @param {string} block Address block text.
 * @return {object|null}
 */
function parseAddressBlock(block) {
  const lines = String(block || "")
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !/^united states$/i.test(l));
  if (lines.length < 2) return null;

  let phone = null;
  const phoneIdx = lines.findIndex((l) =>
    /^[\d\s().+-]{7,}$/.test(l.replace(/\s/g, "")) ||
    /^\d{10,}$/.test(l.replace(/\D/g, "")));
  if (phoneIdx >= 0) {
    phone = lines[phoneIdx].replace(/[^\d+()-]/g, "").trim();
    lines.splice(phoneIdx, 1);
  }

  let csz = null;
  let cszIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    csz = parseCityStateZip(lines[i]);
    if (csz) {
      cszIdx = i;
      break;
    }
  }
  if (!csz) return null;

  const before = lines.slice(0, cszIdx);
  const address1 = before.length ? before[before.length - 1] : "";
  const nameParts = before.slice(0, Math.max(0, before.length - 1));
  return {
    name: nameParts.join(" ").trim() || address1 || "Unknown",
    address1: address1 || nameParts[nameParts.length - 1] || "",
    city: csz.city,
    state: csz.state,
    zipCode: csz.zipCode,
    country: "US",
    phone,
  };
}

/**
 * Extract pallet dims/weights from LTLFlow-style bodies.
 * @param {string} body Plain text body.
 * @return {Array<object>}
 */
function extractPalletFreight(body) {
  const freight = [];
  const pattern = new RegExp(
      "Pallet\\s+(\\d+)\\s*[\\s\\S]*?Weight:\\s*([\\d.]+)\\s*lbs" +
      "[\\s\\S]*?Length:\\s*([\\d.]+)\\s*in" +
      "[\\s\\S]*?Width:\\s*([\\d.]+)\\s*in" +
      "[\\s\\S]*?Height:\\s*([\\d.]+)\\s*in",
      "gi");
  let m;
  while ((m = pattern.exec(String(body || ""))) !== null) {
    freight.push({
      qty: 1,
      weight: Number(m[2]),
      class: null,
      length: Number(m[3]),
      width: Number(m[4]),
      height: Number(m[5]),
      dimType: "PLT",
    });
  }
  return freight;
}

/**
 * Deterministic fallback when AI returns empty/invalid JSON.
 * Handles Pickup Location + Shipping To quote emails.
 * @param {object} opts subject, from, body.
 * @return {object|null}
 */
function heuristicExtractQuote(opts) {
  const subject = String(opts.subject || "");
  const body = String(opts.body || "");
  const pickupMatch = body.match(
      /Pickup Location:\s*([\s\S]*?)(?:Shipping To:|Ship To:|$)/i);
  // eslint-disable-next-line max-len
  const shipToMatch = body.match(/(?:Shipping To:|Ship To:)\s*([\s\S]*?)(?:Special Instructions:|Sales Order|Number of Pallets|Pallet Details|$)/i);
  if (!pickupMatch || !shipToMatch) return null;

  const shipper = parseAddressBlock(pickupMatch[1]);
  const consignee = parseAddressBlock(shipToMatch[1]);
  if (!shipper || !consignee) return null;

  const soMatch = body.match(/Sales Order\s*#?:\s*([A-Z0-9-]+)/i) ||
    body.match(/Please quote\s+([A-Z0-9-]+)/i);
  const customerRef = (soMatch && soMatch[1]) || subject.slice(0, 120);
  let freightInfo = extractPalletFreight(body);
  if (!freightInfo.length) {
    const pallets = body.match(/Number of Pallets:\s*(\d+)/i);
    freightInfo = [{
      qty: pallets ? Number(pallets[1]) : 1,
      weight: null,
      class: null,
      length: null,
      width: null,
      height: null,
      dimType: "PLT",
    }];
  }

  const special = [];
  // eslint-disable-next-line max-len
  const si = body.match(/Special Instructions:\s*([\s\S]*?)(?:LTLFlow|Shipment Data|Sales Order|$)/i);
  if (si) special.push(si[1].replace(/\s+/g, " ").trim());
  if (/lift\s*gate/i.test(body)) special.push("Liftgate required");
  if (/no loading dock|no dock/i.test(body)) special.push("No loading dock");

  const laneKey = `${consignee.city}_${consignee.state}`
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_");

  return {
    format: "single_shipment",
    customerRef,
    readyDate: null,
    shipper,
    lanes: [{
      laneKey,
      label: `TO ${consignee.city}, ${consignee.state}`,
      consignee,
      siteType: /furniture|residential/i.test(body) ? "residential" : "other",
      freightInfo,
      referenceNumbers: customerRef ? [customerRef] : [],
      specialInstructions: special.filter(Boolean).join("; "),
      flags: {
        missingClass: true,
        suspiciousPalletCount: false,
        residentialDelivery: /furniture|residential|lift\s*gate/i.test(body),
      },
    }],
    specialInstructionsGlobal: special.filter(Boolean).join("; "),
    flags: {needsDispatcherReview: true},
    customerRequest: {
      wantsGuaranteedOptions: false,
      wantsCarrierExpiration: false,
      wantsLimitedAccessInQuote: false,
    },
    extractionSource: "heuristic_fallback",
  };
}

/**
 * @param {object} opts subject, from, body.
 * @return {Promise<object>} Parsed quote request.
 */
async function extractQuoteRequest(opts) {
  const subject = String(opts.subject || "");
  const from = String(opts.from || "");
  const body = toPlainText(opts.body).slice(0, 12000);
  const fallback = {
    format: "unknown",
    customerRef: subject.slice(0, 120),
    readyDate: null,
    shipper: null,
    lanes: [],
    specialInstructionsGlobal: "",
    flags: {needsDispatcherReview: true},
    error: null,
  };

  if (!process.env.ANTHROPIC_API_KEY) {
    const heuristic = heuristicExtractQuote({subject, from, body});
    if (heuristic) return heuristic;
    fallback.error = "ANTHROPIC_API_KEY not configured";
    return fallback;
  }

  const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
  let raw = "";
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      raw = await callQuoteExtractionModel(client, {subject, from, body});
      const jsonText = extractJsonObject(raw);
      if (!jsonText) {
        lastErr = new Error("empty model response");
        continue;
      }
      const parsed = JSON.parse(jsonText);
      if (!Array.isArray(parsed.lanes)) parsed.lanes = [];
      if (!parsed.flags) parsed.flags = {};
      if (parsed.lanes.length) return parsed;
      lastErr = new Error("model returned zero lanes");
    } catch (err) {
      lastErr = err;
    }
  }

  const heuristic = heuristicExtractQuote({subject, from, body});
  if (heuristic) return heuristic;

  fallback.error = `Parse failed: ${(lastErr && lastErr.message) || "unknown"}`;
  fallback.raw = raw.slice(0, 500);
  return fallback;
}

/**
 * Heuristic: email looks like a quote request (before full AI).
 * @param {string} subject Subject.
 * @param {string} body Body.
 * @return {boolean}
 */
function looksLikeQuoteRequest(subject, body) {
  const text = `${subject}\n${body}`.toLowerCase();
  const quotePhrases = new RegExp([
    "please quote", "provide quote", "need quote", "quotation",
    "rate quote", "quote request", "freight quote", "shipping rate",
    "let us know the shipping rate", "get a freight quote",
  ].join("|"));
  if (quotePhrases.test(text)) {
    return true;
  }
  const hasOrigin = new RegExp([
    "shipping from", "ship from", "pickup location", "pickup at",
    "freight class", "pallet count", "ready date", "warehouse", "shipper",
  ].join("|"));
  const hasDest = /shipping to|ship to|consignee|deliver to|ship to:/;
  if (hasOrigin.test(text) && hasDest.test(text)) {
    return true;
  }
  return false;
}

/**
 * OpenAI API key for quote classification (Luna).
 * @return {string|null}
 */
function getQuoteClassifyOpenAiKey() {
  return process.env.QUOTE_CLASSIFY_OPENAI_API_KEY ||
    process.env.SUPPORT_CHAT_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    null;
}

/**
 * Classify whether an inbound email is a new LTL freight quote RFQ.
 * Sends subject, from, and body to OpenAI Luna. Falls back to heuristic
 * if the API key/model call fails.
 * @param {object} opts subject, from, body.
 * @return {Promise<object>} {isQuote, confidence, reasoning, source}.
 */
async function classifyIsQuoteRequest(opts) {
  const subject = String(opts.subject || "");
  const from = String(opts.from || "");
  const body = toPlainText(opts.body).slice(0, QUOTE_CLASSIFY_BODY_MAX);
  const apiKey = getQuoteClassifyOpenAiKey();
  if (!apiKey) {
    const isQuote = looksLikeQuoteRequest(subject, body);
    return {
      isQuote,
      confidence: "low",
      reasoning: "OpenAI key missing; used heuristic fallback",
      source: "heuristic_fallback",
    };
  }

  try {
    const client = new OpenAI({apiKey});
    const model = process.env.QUOTE_CLASSIFY_MODEL || DEFAULT_OPENAI_MODEL;
    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      max_completion_tokens: 200,
      messages: [
        {
          role: "system",
          content: [
            "You classify inbound emails for a freight broker quote desk.",
            "Return ONLY valid JSON:",
            "{\"isQuote\":boolean,\"confidence\":\"high|medium|low\",",
            "\"reasoning\":\"one short sentence\"}",
            "",
            "isQuote=true ONLY when the sender is asking for a NEW LTL",
            "freight rate/quote (origins, destinations, pallets, weight,",
            "class, ready date, PO/SO tables, ship from/to blocks).",
            "",
            "isQuote=false for: carrier invoices, PODs, booking/accepting",
            "a prior quote, questions about rates already sent, thank-yous,",
            "marketing, internal chatter, or unclear mail.",
            "Read the email BODY carefully; do not decide from subject alone.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({subject, from, body}),
        },
      ],
    });
    const raw = String(
        completion.choices &&
        completion.choices[0] &&
        completion.choices[0].message &&
        completion.choices[0].message.content || "",
    ).trim();
    const jsonText = extractJsonObject(raw);
    const parsed = JSON.parse(jsonText);
    return {
      isQuote: Boolean(parsed.isQuote),
      confidence: String(parsed.confidence || "medium"),
      reasoning: String(parsed.reasoning || "").slice(0, 300),
      source: "openai_luna",
    };
  } catch (err) {
    const isQuote = looksLikeQuoteRequest(subject, body);
    return {
      isQuote,
      confidence: "low",
      reasoning: `Luna failed (${err.message}); used heuristic fallback`,
      source: "heuristic_fallback",
    };
  }
}

module.exports = {
  extractQuoteRequest,
  looksLikeQuoteRequest,
  classifyIsQuoteRequest,
  toPlainText,
};
