/**
 * Quote email intake — AI extraction from customer RFQ emails.
 */

"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai");
const {DEFAULT_OPENAI_MODEL} = require("./openai-models");
const emailAccessorials = require("./quote-email-accessorials");
const freightDims = require("./quote-freight-dims");
const senderRules = require("./quote-sender-rules");

const QUOTE_CLASSIFY_BODY_MAX = 12000;
// Live bake-off tied (Haiku / Sonnet 4.5 / Sonnet 5 / luna / sol / gpt-4o
// all 17/17). Keep Haiku. Override with QUOTE_EXTRACT_MODEL (Claude or gpt-*).
const DEFAULT_QUOTE_EXTRACT_MODEL = "claude-haiku-4-5";

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
 * Append a unique dispatcher-visible extraction warning.
 * @param {object} extracted Intake payload.
 * @param {string} msg Warning text.
 * @return {void}
 */
function pushExtractWarning(extracted, msg) {
  if (!extracted || typeof extracted !== "object") return;
  const text = String(msg || "").trim();
  if (!text) return;
  const list = Array.isArray(extracted.extractionWarnings) ?
    extracted.extractionWarnings : [];
  if (!list.includes(text)) list.push(text);
  extracted.extractionWarnings = list;
}

/**
 * Deterministic post-processor that ALWAYS runs after AI (and heuristic)
 * extract. Does not trust the LLM for cartons vs pallets, Pallet N
 * blocks, 40×48 dims, total-weight, or accessorial negation.
 * @param {object} extracted extractQuoteRequest result.
 * @param {object} [opts] subject, body, from.
 * @return {object}
 */
function normalizeExtractedQuote(extracted, opts) {
  if (!extracted || typeof extracted !== "object") return extracted;
  const next = extracted;
  if (!Array.isArray(next.extractionWarnings)) {
    next.extractionWarnings = [];
  }
  if (opts && opts.subject) {
    next._sourceSubject = String(opts.subject);
  }
  if (opts && opts.body) {
    next._sourceBody = String(opts.body).slice(0, 12000);
  }
  const from = opts && opts.from != null ? String(opts.from) : "";
  const senderFrom = senderRules.resolveQuoteSenderFrom(
      from, opts && opts.body);
  const recipientOpts = {
    cc: opts && opts.cc,
    to: opts && opts.to,
  };
  const dimOpts = senderRules.dimOptsForSender(
      senderFrom, undefined, recipientOpts);
  senderRules.applySenderCustomerOverride(
      next, senderFrom, undefined, recipientOpts);
  const missingDimsBefore = palletRowsMissingDims(next);
  normalizeSoleAddressToConsignee(next);
  applyEmailPalletBlocks(next, opts);
  correctCartonVsPalletFreight(next, opts && opts.body);
  normalizeFreightOnExtract(next, opts && opts.body, dimOpts);
  senderRules.applySenderDefaultedDimOverrides(
      next, senderFrom, opts && opts.body, undefined, recipientOpts);
  if (missingDimsBefore && !palletRowsMissingDims(next)) {
    pushExtractWarning(next, "defaulted dims");
  }
  emailAccessorials.attachRequestedAccessorials(next, {
    subject: opts && opts.subject,
    body: opts && opts.body,
  });
  const declined = emailAccessorials.detectDeclinedAccessorials(
      emailAccessorials.extractedAccessorialText(next, opts));
  for (const w of declined.warnings || []) {
    pushExtractWarning(next, w);
  }
  return next;
}

/**
 * True when any pallet freight row is missing L, W, or H.
 * @param {object} extracted Intake payload.
 * @return {boolean}
 */
function palletRowsMissingDims(extracted) {
  if (!extracted || !Array.isArray(extracted.lanes)) return false;
  for (const lane of extracted.lanes) {
    const rows = lane && Array.isArray(lane.freightInfo) ?
      lane.freightInfo : [];
    for (const row of rows) {
      if (!freightDims.isPalletPackaging(row)) continue;
      if (!(Number(row.length) > 0) || !(Number(row.width) > 0) ||
          !(Number(row.height) > 0)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Normalize sole-address + stamp email-requested accessorial codes.
 * @param {object} extracted Intake payload.
 * @param {object} opts subject, body, from.
 * @return {object}
 */
function finishExtract(extracted, opts) {
  return normalizeExtractedQuote(extracted, opts);
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
 * Configured extract model (Claude or OpenAI slug).
 * @return {string}
 */
function getQuoteExtractModel() {
  return process.env.QUOTE_EXTRACT_MODEL || DEFAULT_QUOTE_EXTRACT_MODEL;
}

/**
 * True for OpenAI chat-completions extract models.
 * @param {string} model Model slug.
 * @return {boolean}
 */
function isOpenAiExtractModel(model) {
  const m = String(model || "").toLowerCase();
  return m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3") ||
    m.startsWith("o4");
}

/**
 * Shared RFQ extract system prompt (Claude + OpenAI).
 * Understand English meaning; do not substring-match keywords.
 * @return {string}
 */
function quoteExtractSystemPrompt() {
  return [
    "You extract LTL freight quote requests for a freight broker.",
    "Return ONLY valid JSON (no markdown).",
    "Understand English meaning (negation, packing type, totals).",
    "Do NOT substring-match keywords. Read the whole phrase.",
    "",
    "Keys:",
    "- format: multi_lane_table | single_shipment | unknown",
    "- customerRef: PO / sales order / subject reference",
    "- customerName: bill-to / account / company requesting the quote",
    "- readyDate: YYYY-MM-DD or null",
    "- shipper: {name, address1, city, state, zipCode, country, phone}",
    "- lanes: array of {",
    "    laneKey: stable id e.g. PIONEER_OH,",
    "    label: e.g. TO PIONEER, OH,",
    "    consignee: {name, address1, city, state, zipCode, country, phone},",
    "    siteType: menards_dc | amazon_fc | aafes_military |",
    "      nursing_home | hotel | residential | other,",
    "    freightInfo: [{qty, weight, weightType, class, length, width,",
    "      height, dimType}],",
    "    referenceNumbers: [PO numbers],",
    "    specialInstructions: string,",
    "    flags: {missingClass, suspiciousPalletCount, residentialDelivery}",
    "  }",
    "- specialInstructionsGlobal: pickup/delivery notes for all lanes",
    "- customerRequest: {",
    "    wantsGuaranteedOptions: boolean,",
    "    wantsCarrierExpiration: boolean,",
    "    wantsLimitedAccessInQuote: boolean,",
    "    requestedAccessorials: string[]  // Primus codes, e.g.",
    "      [\"LAD\",\"LFD\",\"APD\",\"RSD\",\"IND\"]",
    "  }",
    "- customerDeclinedAccessorials: string[]  // e.g. [\"APD\"] when the",
    "    customer said appointment is NOT needed",
    "- flags: {needsDispatcherReview: boolean}",
    "",
    "WORKED EXAMPLES (follow these exactly):",
    "1) \"No Appointment necessary\" / \"no appt needed\" /",
    "   \"appointment not required\" → do NOT put APD or APO in",
    "   requestedAccessorials. Put \"APD\" in",
    "   customerDeclinedAccessorials. Copy the phrase into",
    "   specialInstructions only. The word \"appointment\" is not a",
    "   request when it is negated.",
    "2) \"Delivery appointment required\" / \"must call to schedule\"",
    "   → requestedAccessorials MUST include APD. Do not decline it.",
    "3) Pallet 1 (40x48x70, 1822 lbs) and Pallet 2 (40x48x66, 1702 lbs)",
    "   quoted to BOTH 90723 and 11216 (same freight, two dests) →",
    "   two lanes; EACH lane has TWO freight lines (qty 1 each).",
    "   Not 1 pallet. Do not split Pallet 1 to dest A and Pallet 2",
    "   to dest B unless the email assigns them.",
    "4) \"2 pallets\" → qty 2 (or two qty-1 PLT lines), never qty 1.",
    "5) Total Cartons 35, Number of Pallet 1, weight 137,",
    "   Pallet dimensions 48*40*28 → one freight line",
    "   [{qty:1, weight:137, weightType:\"total\", length:40, width:48,",
    "   height:28, dimType:\"PLT\"}]. Cartons ≠ pallets. Mention 35",
    "   cartons in specialInstructions only.",
    "6) \"Total weight – 8146.05\" (or 8146) on many pallets →",
    "   weight 8146.05 (or 8146), weightType \"total\". Never per-pallet",
    "   / each. Never strip the decimal (814605 is wrong).",
    "7) Zip-only \"from 08701 to 22911\" → shipper.zipCode 08701 and",
    "   consignee.zipCode 22911 even if city/state are blank.",
    "",
    "Real patterns to recognize:",
    "- Ship From / Ship To blocks (Coreforce, warehouse quotes)",
    "- Inline origin + destination (GPA Perris CA → HGR6 Hagerstown MD)",
    "- Amazon FC codes: HGR6, FBA shipment ids in body",
    "- AAFES / military bases / forts / AFB / naval stations / exchanges",
    "- Multi-pallet lines: 1 pallet 40x48x65 @ 602.5 lbs",
    "- Pickup address blocks without Ship From label (Petra / CTA Digital)",
    "- Subject may be just \"Quote\" — still extract shipper/consignee",
    "  from Pickup Location / Shipping To blocks in the body.",
    "",
    "Rules:",
    "- Group table rows by destination city/state/zip into one lane each.",
    "- Sum weight and pallets per lane when table groups freight blocks.",
    "- weightType should be total unless clearly per-piece.",
    "  If the email says Total weight / \"total weight – N\", weightType",
    "  MUST be \"total\" (never per-pallet / each), even when qty > 1.",
    "- Pallet L×W is always 40 x 48 (length 40, width 48), never 48x40.",
    "  If the email says 48*40 or 48x40, store length:40, width:48.",
    "  Height is unchanged. If pallet L/W/H are missing, use 40x48x60",
    "  and dimType PLT — do not invent dims over explicit values.",
    "- dimType must be Primus packaging enum (not inch/cm):",
    "  PLT, CTN, CRT, DRM, CON, BOX, BDL, ENV, CYL, CAS, OTH, TOT,",
    "  or TRUCK LOAD. Use PLT for pallets/skids. Country codes ISO2",
    "  (US/CA/MX), never USA.",
    "- Cartons are NOT pallets. qty on a PLT line is the pallet/skid",
    "  COUNT, never carton/piece/box count. Carton totals are pieces,",
    "  not trailer qty.",
    "- Pallet 1 / Pallet 2 / Pallet N blocks are separate freight",
    "  lines (qty 1 each) with that line's dims and weight. Do not",
    "  drop Pallet 2. Do not collapse to qty 1 unless the email",
    "  explicitly says 1 pallet (Number of Pallet - 1).",
    "- If class missing, set flags.missingClass true on that lane.",
    "- If pallet count seems wrong (>20), suspiciousPalletCount true.",
    "- Detect liftgate / no dock in global or lane instructions.",
    "- If email mentions accessorials (liftgate, residential,",
    "  appointment, limited access, inside delivery, insurance,",
    "  etc.), copy those phrases into specialInstructions /",
    "  specialInstructionsGlobal AND map them to Primus codes in",
    "  customerRequest.requestedAccessorials:",
    "  liftgate pickup/origin → LFO; liftgate delivery or bare",
    "  liftgate/no dock → LFD (+ LFO if unspecified); appointment",
    "  → APD (APO if pickup) UNLESS the email says no appointment",
    "  / no appt needed / appointment not required;",
    "  residential → RSD; limited/restricted",
    "  access → LAD (LAO if pickup); inside delivery → IND;",
    "  inside pickup → INO; insurance → INS; hazmat → HAZ.",
    "- Set flags.residentialDelivery true when residential/",
    "  home delivery is requested.",
    "- Military bases, forts, AFB, naval/Marine stations, AAFES",
    "  exchanges → siteType aafes_military.",
    "- If customer asks for guaranteed + standard options,",
    "  set customerRequest.wantsGuaranteedOptions true.",
    "- If customer asks for carrier expiration days,",
    "  set customerRequest.wantsCarrierExpiration true.",
    "- If customer asks for limited/restricted delivery charges",
    "  in the quote email, set wantsLimitedAccessInQuote true",
    "  and include LAD in requestedAccessorials.",
    "- Always return at least one lane when pickup + delivery addresses",
    "  are present, even if freight dims/class/weight are missing.",
    "- Zip-only origin/dest is valid: keep the 5-digit zipCode even",
    "  when city and state are missing.",
    "- Sole address → consignee (destination / Ship To): when the email",
    "  contains only ONE physical address (street/city/state/zip), put",
    "  it on lanes[].consignee. Leave shipper null/empty (or name-only",
    "  from a known customer profile) — do NOT put the sole address on",
    "  shipper by default. Multi-address emails (Ship From + Ship To,",
    "  or clear origin + destination) still map normally.",
  ].join("\n");
}

/**
 * @param {object} payload subject/from/body.
 * @param {string} model Claude model slug.
 * @return {Promise<string>} Raw model text.
 */
async function callClaudeQuoteExtraction(payload, model) {
  const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
  const res = await client.messages.create({
    model,
    max_tokens: 4000,
    system: quoteExtractSystemPrompt(),
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
 * @param {object} payload subject/from/body.
 * @param {string} model OpenAI model slug.
 * @return {Promise<string>} Raw model text.
 */
async function callOpenAiQuoteExtraction(payload, model) {
  const apiKey = getQuoteClassifyOpenAiKey();
  if (!apiKey) throw new Error("OpenAI API key not configured");
  const client = new OpenAI({apiKey});
  const completion = await client.chat.completions.create({
    model,
    max_completion_tokens: 4000,
    response_format: {type: "json_object"},
    messages: [
      {role: "system", content: quoteExtractSystemPrompt()},
      {role: "user", content: JSON.stringify(payload)},
    ],
  });
  return String(
      completion.choices &&
      completion.choices[0] &&
      completion.choices[0].message &&
      completion.choices[0].message.content || "",
  ).trim();
}

/**
 * @param {object} payload subject/from/body.
 * @param {string} [model] Override model slug.
 * @return {Promise<string>} Raw model text.
 */
async function callQuoteExtractionModel(payload, model) {
  const slug = model || getQuoteExtractModel();
  if (isOpenAiExtractModel(slug)) {
    return callOpenAiQuoteExtraction(payload, slug);
  }
  return callClaudeQuoteExtraction(payload, slug);
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
 * Compact Pallet N + LxWxH + lbs lines (not LTLFlow Weight:/Length:).
 * @param {string} body Plain text body.
 * @return {Array<object>}
 */
function extractCompactPalletBlocks(body) {
  const freight = [];
  const seen = new Set();
  const pattern = new RegExp(
      "Pallet\\s+(\\d+)\\s*[:.\\-]?\\s+" +
      "([\\d.]+)\\s*[x×*]\\s*([\\d.]+)\\s*[x×*]\\s*([\\d.]+)\\s*,?\\s*" +
      "([\\d.,]+)\\s*lbs",
      "gi");
  let m;
  while ((m = pattern.exec(String(body || ""))) !== null) {
    const n = Number(m[1]);
    if (seen.has(n)) continue;
    seen.add(n);
    const weight = Number(String(m[5]).replace(/,/g, ""));
    freight.push(freightDims.normalizePalletDims({
      qty: 1,
      weight: Number.isFinite(weight) ? weight : null,
      weightType: "total",
      class: null,
      length: Number(m[2]),
      width: Number(m[3]),
      height: Number(m[4]),
      dimType: "PLT",
    }));
  }
  return freight;
}

/**
 * "2 pallets" / "2 plt" / "2 skids" — number before the word.
 * Does not treat "Pallet 1" as qty 1.
 * @param {string} text Body.
 * @return {number|null}
 */
function parseInformalPalletCount(text) {
  const re = /\b(\d+)\s*(?:pallets?|plts?|skids?)\b/gi;
  let max = null;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n < 1) continue;
    if (max == null || n > max) max = n;
  }
  return max;
}

/**
 * Extract pallet dims/weights from LTLFlow-style bodies, then compact
 * Pallet N / LxWxH / lbs blocks.
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
    freight.push(freightDims.normalizePalletDims({
      qty: 1,
      weight: Number(m[2]),
      weightType: "total",
      class: null,
      length: Number(m[3]),
      width: Number(m[4]),
      height: Number(m[5]),
      dimType: "PLT",
    }));
  }
  if (freight.length) return freight;
  return extractCompactPalletBlocks(body);
}

/**
 * True when the email maps a pallet number to a destination zip.
 * @param {string} text Subject + body.
 * @param {Array<object>} lanes Extracted lanes.
 * @return {boolean}
 */
function emailAssignsPalletsToDestinations(text, lanes) {
  const blob = String(text || "");
  const zips = [...new Set((lanes || []).map((lane) => {
    const zip = String((lane && lane.consignee &&
      lane.consignee.zipCode) || "").replace(/\D/g, "").slice(0, 5);
    return zip.length === 5 ? zip : "";
  }).filter(Boolean))];
  if (zips.length < 2) return false;
  for (const zip of zips) {
    const re = new RegExp(
        "pallet\\s*\\d+[\\s\\S]{0,80}" + zip + "|" +
        zip + "[\\s\\S]{0,80}pallet\\s*\\d+",
        "i");
    if (re.test(blob)) return true;
  }
  return false;
}

/**
 * Copy Pallet 1 + Pallet 2 (+ …) onto every lane when the RFQ lists
 * them without assigning a pallet to a destination zip.
 * @param {object} extracted Parsed quote request.
 * @param {object|string} opts subject/body or body string.
 * @return {object}
 */
function applyEmailPalletBlocks(extracted, opts) {
  if (!extracted || typeof extracted !== "object") return extracted;
  if (!Array.isArray(extracted.lanes) || !extracted.lanes.length) {
    return extracted;
  }
  const body = typeof opts === "string" ? opts :
    (opts && opts.body) || "";
  const subject = typeof opts === "string" ? "" :
    (opts && opts.subject) || "";
  const blob = [subject, body].filter(Boolean).join("\n");
  let blocks = extractPalletFreight(body);
  if (!blocks.length) blocks = extractCompactPalletBlocks(body);
  const informal = parseInformalPalletCount(blob);
  if (!blocks.length && informal != null && informal > 1) {
    for (const lane of extracted.lanes) {
      if (!lane || typeof lane !== "object") continue;
      const rows = Array.isArray(lane.freightInfo) ? lane.freightInfo : [];
      const qty = rows.reduce((sum, r) =>
        sum + (Math.max(0, Number(r.qty) || 0)), 0);
      if (qty <= 1 && rows.length <= 1) {
        const base = rows[0] && typeof rows[0] === "object" ? rows[0] : {};
        lane.freightInfo = [freightDims.normalizePalletDims({
          ...base,
          qty: informal,
          dimType: "PLT",
          weightType: base.weightType || "total",
        })];
      }
    }
    return extracted;
  }
  if (blocks.length < 2) return extracted;
  if (emailAssignsPalletsToDestinations(blob, extracted.lanes)) {
    return extracted;
  }
  const emailQty = blocks.reduce((sum, r) =>
    sum + (Math.max(0, Number(r.qty) || 0)), 0);
  for (const lane of extracted.lanes) {
    if (!lane || typeof lane !== "object") continue;
    const rows = Array.isArray(lane.freightInfo) ? lane.freightInfo : [];
    const qty = rows.reduce((sum, r) =>
      sum + (Math.max(0, Number(r.qty) || 0)), 0);
    const sameCount = rows.length === blocks.length && qty === emailQty;
    if (sameCount) continue;
    lane.freightInfo = blocks.map((row) => ({...row}));
  }
  return extracted;
}

/**
 * Parse a labeled integer/float after a heading (colon, dash, em dash).
 * @param {string} text Body.
 * @param {RegExp} re Pattern with one capture group.
 * @return {number|null}
 */
function matchLabeledNumber(text, re) {
  const m = String(text || "").match(re);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse Total Cartons / Number of Pallet(s) / weight / pallet dims.
 * Carton count is pieces; pallet count is PLT qty.
 * @param {string} body Plain text body.
 * @return {object}
 */
function parseLabeledFreightTotals(body) {
  const text = String(body || "");
  let palletCount = matchLabeledNumber(text,
      /Number\s+of\s+Pallets?\s*[-–—:=]?\s*(\d+)/i);
  if (palletCount == null) {
    palletCount = matchLabeledNumber(text,
        /Pallet\s+Counts?\s*[-–—:=]?\s*(\d+)/i);
  }
  if (palletCount == null) {
    const blocks = extractCompactPalletBlocks(text);
    if (blocks.length) palletCount = blocks.length;
  }
  if (palletCount == null) {
    palletCount = parseInformalPalletCount(text);
  }
  const cartonCount = matchLabeledNumber(text,
      /Total\s+Cartons?\s*[-–—:=]?\s*(\d+)/i);
  const weight = matchLabeledNumber(text,
      /Total\s+[Ww]eight\s*[-–—:=]?\s*([\d.]+)/i);
  const dim = text.match(new RegExp(
      "Pallet\\s+Dimensions?\\s*[-–—:=]?\\s*([\\d.]+)\\s*[x×*]\\s*" +
      "([\\d.]+)\\s*[x×*]\\s*([\\d.]+)",
      "i"));
  return {
    cartonCount,
    palletCount,
    weight,
    length: dim ? Number(dim[1]) : null,
    width: dim ? Number(dim[2]) : null,
    height: dim ? Number(dim[3]) : null,
  };
}

/**
 * Fill missing weight/dims on a freight row from labeled totals.
 * @param {object} row Freight row.
 * @param {object} labeled Parsed labeled totals.
 * @return {object}
 */
function fillLabeledFreightFields(row, labeled) {
  const next = row && typeof row === "object" ? {...row} : {};
  const lab = labeled || {};
  if (next.weight == null && lab.weight != null) next.weight = lab.weight;
  if (next.length == null && lab.length != null) next.length = lab.length;
  if (next.width == null && lab.width != null) next.width = lab.width;
  if (next.height == null && lab.height != null) next.height = lab.height;
  return next;
}

/**
 * When the RFQ lists carton count AND pallet count, qty is pallets.
 * @param {Array<object>} freightInfo Existing freight lines.
 * @param {object} labeled Parsed labeled totals.
 * @return {Array<object>}
 */
function applyLabeledFreightTotals(freightInfo, labeled) {
  const lab = labeled || {};
  const src = Array.isArray(freightInfo) ? freightInfo : [];
  const palletCount = lab.palletCount;
  const cartonCount = lab.cartonCount;
  const both = palletCount != null && cartonCount != null &&
    palletCount !== cartonCount;

  let rows = src.length ? src.map((r) => ({...r})) : [];
  if (!rows.length) {
    rows = [{
      qty: palletCount != null ? palletCount : 1,
      weight: lab.weight != null ? lab.weight : null,
      weightType: "total",
      class: null,
      length: lab.length != null ? lab.length : null,
      width: lab.width != null ? lab.width : null,
      height: lab.height != null ? lab.height : null,
      dimType: "PLT",
    }];
    return rows.map((r) => freightDims.normalizePalletDims(r));
  }

  if (both) {
    const totalQty = rows.reduce((sum, r) =>
      sum + (Math.max(0, Number(r.qty) || 0)), 0);
    const usedCartonsAsQty = totalQty === cartonCount ||
      rows.some((r) => Number(r.qty) === cartonCount);
    if (usedCartonsAsQty) {
      const base = fillLabeledFreightFields(rows[0], lab);
      const corrected = {
        qty: palletCount,
        weight: lab.weight != null ? lab.weight : (base.weight || null),
        class: base.class != null ? base.class : null,
        length: lab.length != null ? lab.length : (base.length || null),
        width: lab.width != null ? lab.width : (base.width || null),
        height: lab.height != null ? lab.height : (base.height || null),
        dimType: "PLT",
        weightType: "total",
      };
      return [freightDims.normalizePalletDims(corrected)];
    }
  }

  if (palletCount != null && rows.length === 1) {
    const row = fillLabeledFreightFields(rows[0], lab);
    const dim = String(row.dimType || "").trim().toUpperCase();
    const packagingIsPallet = !dim || dim === "PLT" || dim === "OTH";
    if (packagingIsPallet) {
      row.qty = palletCount;
      row.dimType = "PLT";
    }
    if (lab.weight != null) row.weightType = "total";
    return [freightDims.normalizePalletDims(row)];
  }

  return rows.map((r) => {
    const filled = fillLabeledFreightFields(r, lab);
    if (lab.weight != null) filled.weightType = "total";
    return freightDims.normalizePalletDims(filled);
  });
}

/**
 * Correct AI/heuristic PLT qty when the email labeled cartons vs pallets.
 * Mutates extracted lanes in place.
 * @param {object} extracted Parsed quote request.
 * @param {string} body Email body.
 * @return {object}
 */
function correctCartonVsPalletFreight(extracted, body) {
  if (!extracted || typeof extracted !== "object") return extracted;
  const labeled = parseLabeledFreightTotals(body);
  if (labeled.palletCount == null && labeled.cartonCount == null &&
      labeled.weight == null && labeled.length == null) {
    return extracted;
  }
  if (!Array.isArray(extracted.lanes)) return extracted;
  for (const lane of extracted.lanes) {
    if (!lane || typeof lane !== "object") continue;
    lane.freightInfo = applyLabeledFreightTotals(
        lane.freightInfo, labeled);
    if (labeled.palletCount != null && labeled.cartonCount != null &&
        labeled.cartonCount !== labeled.palletCount && lane.flags) {
      lane.flags.suspiciousPalletCount = false;
    }
  }
  return extracted;
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
  const labeled = parseLabeledFreightTotals(body);
  const hasLabeledFreight = labeled.palletCount != null ||
    labeled.cartonCount != null || labeled.weight != null ||
    labeled.length != null;
  if (hasLabeledFreight) {
    freightInfo = applyLabeledFreightTotals(freightInfo, labeled);
  } else if (!freightInfo.length) {
    const pallets = body.match(/Number of Pallets:\s*(\d+)/i);
    freightInfo = [freightDims.normalizePalletDims({
      qty: pallets ? Number(pallets[1]) : 1,
      weight: null,
      weightType: "total",
      class: null,
      length: null,
      width: null,
      height: null,
      dimType: "PLT",
    })];
  }
  freightInfo = freightInfo.map((r) => freightDims.normalizePalletDims({
    ...r,
    weightType: r.weightType || "total",
  }));

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
      wantsLimitedAccessInQuote: /limited\s*access|restricted\s*access/i
          .test(body),
      requestedAccessorials: [],
    },
    extractionSource: "heuristic_fallback",
  };
}

/**
 * True when a party has enough location fields to count as a physical
 * address (not name/phone alone).
 * @param {object|null|undefined} party Address party.
 * @return {boolean}
 */
function partyHasPhysicalAddress(party) {
  if (!party || typeof party !== "object") return false;
  const zip = String(
      party.zipCode || party.zipcode || party.zip || "").trim();
  const city = String(party.city || "").trim();
  const state = String(party.state || "").trim();
  const address1 = String(party.address1 || "").trim();
  return Boolean(zip || (city && state) || address1);
}

/**
 * Compact key for comparing two address blocks.
 * @param {object|null|undefined} party Address party.
 * @return {string}
 */
function physicalAddressKey(party) {
  if (!partyHasPhysicalAddress(party)) return "";
  const zip = String(
      party.zipCode || party.zipcode || party.zip || "")
      .trim()
      .toLowerCase();
  const city = String(party.city || "").trim().toLowerCase();
  const state = String(party.state || "").trim().toLowerCase();
  const address1 = String(party.address1 || "").trim().toLowerCase();
  return [address1, city, state, zip].filter(Boolean).join("|");
}

/**
 * Keep name/phone; clear street/city/state/zip/country.
 * @param {object|null|undefined} party Address party.
 * @return {object|null}
 */
function clearPhysicalAddressFields(party) {
  if (!party || typeof party !== "object") return null;
  const name = String(party.name || "").trim();
  const phone = String(party.phone || "").trim();
  if (!name && !phone) return null;
  return {
    name: name || "",
    address1: "",
    address2: "",
    city: "",
    state: "",
    zipCode: "",
    country: "",
    phone: phone || "",
  };
}

/**
 * Copy location fields onto a consignee, preserving an existing name.
 * @param {object} fromParty Source address (often mis-labeled shipper).
 * @param {object|null|undefined} consignee Existing consignee.
 * @return {object}
 */
function moveAddressOntoConsignee(fromParty, consignee) {
  const base = consignee && typeof consignee === "object" ? consignee : {};
  return {
    name: String(base.name || fromParty.name || "").trim(),
    address1: String(fromParty.address1 || "").trim(),
    address2: String(fromParty.address2 || "").trim(),
    city: String(fromParty.city || "").trim(),
    state: String(fromParty.state || "").trim(),
    zipCode: String(
        fromParty.zipCode || fromParty.zipcode || fromParty.zip || "")
        .trim(),
    country: String(fromParty.country || "US").trim() || "US",
    phone: String(base.phone || fromParty.phone || "").trim() || null,
  };
}

/**
 * Default: a sole physical address in an RFQ is the destination
 * (consignee / Ship To), not the shipper pickup.
 * Future sender-specific rules may override this to treat the sole
 * address as pickup for some mailboxes.
 * Does not alter true multi-address extracts (distinct Ship From + Ship To).
 * @param {object} extracted Parsed quote request.
 * @return {object} Same object, normalized in place.
 */
function normalizeSoleAddressToConsignee(extracted) {
  if (!extracted || typeof extracted !== "object") return extracted;
  if (!Array.isArray(extracted.lanes)) extracted.lanes = [];
  const shipper = extracted.shipper;
  const shipperHas = partyHasPhysicalAddress(shipper);
  const shipperKey = physicalAddressKey(shipper);

  const laneConsignees = extracted.lanes.map((lane) =>
    lane && lane.consignee ? lane.consignee : null);
  const consigneesWithAddr = laneConsignees.filter(partyHasPhysicalAddress);
  const uniqueConsigneeKeys = [...new Set(
      consigneesWithAddr.map(physicalAddressKey).filter(Boolean))];

  // Distinct shipper + consignee(s) → leave multi-address extracts alone.
  if (shipperHas && uniqueConsigneeKeys.length) {
    const onlySameAsShipper = uniqueConsigneeKeys.length === 1 &&
      uniqueConsigneeKeys[0] === shipperKey;
    if (!onlySameAsShipper) return extracted;
    // Same sole block on both sides → keep consignee, clear shipper addr.
    extracted.shipper = clearPhysicalAddressFields(shipper);
    return extracted;
  }

  // Sole address on shipper, all consignees empty → move to destination.
  if (shipperHas && !consigneesWithAddr.length) {
    if (!extracted.lanes.length) {
      extracted.lanes = [{
        laneKey: "DEST",
        label: "TO destination",
        consignee: moveAddressOntoConsignee(shipper, null),
        freightInfo: [],
        flags: {},
      }];
    } else {
      for (const lane of extracted.lanes) {
        if (!lane || typeof lane !== "object") continue;
        lane.consignee = moveAddressOntoConsignee(shipper, lane.consignee);
        if (!lane.label && lane.consignee.city) {
          lane.label = `TO ${lane.consignee.city}` +
            (lane.consignee.state ? `, ${lane.consignee.state}` : "");
        }
      }
    }
    extracted.shipper = clearPhysicalAddressFields(shipper);
    return extracted;
  }

  // Consignee(s) already hold the only address — nothing to do.
  return extracted;
}

/**
 * Total weight in the RFQ wins over per-pallet / each.
 * @param {string} body Email body.
 * @return {"total"|"each"}
 */
function inferWeightTypeFromBody(body) {
  const text = String(body || "");
  if (/total\s+weight/i.test(text)) return "total";
  if (/(?:weight\s+(?:per|each)|per[\s-]*(?:pallet|piece|skid)|each\s+pallet)/i
      .test(text)) {
    return "each";
  }
  return "total";
}

/**
 * Pallet 40×48 (not 48×40), default missing pallet dims to 40×48×60
 * (or sender-specific defaults via dimOpts), and force weightType total
 * when the email gives a total weight.
 * @param {object} extracted Parsed quote request.
 * @param {string} body Email body.
 * @param {object} [dimOpts] defaultDims from sender rules.
 * @return {object}
 */
function normalizeFreightOnExtract(extracted, body, dimOpts = {}) {
  if (!extracted || typeof extracted !== "object") return extracted;
  const weightType = inferWeightTypeFromBody(body);
  if (!Array.isArray(extracted.lanes)) return extracted;
  let defaultedDims = false;
  for (const lane of extracted.lanes) {
    if (!lane || typeof lane !== "object") continue;
    const rows = Array.isArray(lane.freightInfo) ? lane.freightInfo : [];
    lane.freightInfo = rows.map((row) => {
      const base = row && typeof row === "object" ? {...row} : {};
      const next = freightDims.normalizePalletDims(base, dimOpts);
      if (freightDims.palletDimsWereDefaulted(base, next)) {
        defaultedDims = true;
      }
      const raw = String(next.weightType || "").trim().toLowerCase();
      if (weightType === "total") {
        next.weightType = "total";
      } else if (raw === "each" || raw === "perpiece" || raw === "per-piece") {
        next.weightType = "each";
      } else {
        next.weightType = weightType;
      }
      return freightDims.sanitizeImplausiblePalletWeight(next);
    });
  }
  if (defaultedDims) pushExtractWarning(extracted, "defaulted dims");
  return extracted;
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

  const extractModel = getQuoteExtractModel();
  const canCallModel = isOpenAiExtractModel(extractModel) ?
    Boolean(getQuoteClassifyOpenAiKey()) :
    Boolean(process.env.ANTHROPIC_API_KEY);
  if (!canCallModel) {
    const heuristic = heuristicExtractQuote({subject, from, body});
    if (heuristic) {
      heuristic.extractModel = "heuristic";
      return finishExtract(heuristic, {subject, body, from});
    }
    fallback.error = isOpenAiExtractModel(extractModel) ?
      "OpenAI API key not configured" :
      "ANTHROPIC_API_KEY not configured";
    fallback.extractModel = extractModel;
    return fallback;
  }

  let raw = "";
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      raw = await callQuoteExtractionModel({subject, from, body}, extractModel);
      const jsonText = extractJsonObject(raw);
      if (!jsonText) {
        lastErr = new Error("empty model response");
        continue;
      }
      const parsed = JSON.parse(jsonText);
      if (!Array.isArray(parsed.lanes)) parsed.lanes = [];
      if (!parsed.flags) parsed.flags = {};
      parsed.extractModel = extractModel;
      if (parsed.lanes.length) {
        return finishExtract(parsed, {subject, body, from});
      }
      lastErr = new Error("model returned zero lanes");
    } catch (err) {
      lastErr = err;
    }
  }

  const heuristic = heuristicExtractQuote({subject, from, body});
  if (heuristic) {
    heuristic.extractModel = "heuristic";
    return finishExtract(heuristic, {subject, body, from});
  }

  fallback.error = `Parse failed: ${(lastErr && lastErr.message) || "unknown"}`;
  fallback.raw = raw.slice(0, 500);
  fallback.extractModel = extractModel;
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
    "\\bquote\\b", "rfq",
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
  // PO/ref-only subjects (e.g. "0444524") with freight dims in body.
  const hasFreightDims =
    /\b\d+\s*x\s*\d+(\s*x\s*\d+)?\b/.test(text) &&
    /\b(pallet|pallets|plt|skid|lbs?|pounds|class\s*\d+)\b/.test(text);
  const hasOdHints =
    /\b[A-Z]{2}\s+\d{5}\b/i.test(`${subject}\n${body}`) ||
    /\b(ca|ny|nj|tx|fl|il|oh|pa|ga|nc|md)\b.*\b\d{5}\b/i.test(text);
  if (hasFreightDims && hasOdHints) {
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
    // gpt-5.6-luna rejects temperature (only default 1). Omit it.
    const completion = await client.chat.completions.create({
      model,
      max_completion_tokens: 200,
      response_format: {type: "json_object"},
      messages: [
        {
          role: "system",
          content: [
            "You classify inbound emails for a freight broker quote desk.",
            "Return ONLY valid JSON:",
            "{\"isQuote\":boolean,\"confidence\":\"high|medium|low\",",
            "\"reasoning\":\"one short sentence\"}",
            "",
            "isQuote=true when the sender is asking for a NEW LTL",
            "freight rate/quote (origins, destinations, pallets, weight,",
            "class, ready date, PO/SO tables, ship from/to blocks).",
            "Subjects that are only a PO/ref number can still be quotes",
            "when the body has ship-from/to and freight details.",
            "Also isQuote=true for incomplete RFQ pastes that include",
            "a shipper/pickup block plus pallet/weight/dims even if the",
            "destination is missing — dispatchers complete those.",
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
  DEFAULT_QUOTE_EXTRACT_MODEL,
  getQuoteExtractModel,
  isOpenAiExtractModel,
  quoteExtractSystemPrompt,
  callQuoteExtractionModel,
  extractJsonObject,
  extractQuoteRequest,
  looksLikeQuoteRequest,
  classifyIsQuoteRequest,
  toPlainText,
  normalizeSoleAddressToConsignee,
  partyHasPhysicalAddress,
  finishExtract,
  normalizeExtractedQuote,
  pushExtractWarning,
  parseLabeledFreightTotals,
  applyLabeledFreightTotals,
  correctCartonVsPalletFreight,
  extractCompactPalletBlocks,
  extractPalletFreight,
  applyEmailPalletBlocks,
  parseInformalPalletCount,
  heuristicExtractQuote,
  inferWeightTypeFromBody,
  normalizeFreightOnExtract,
};
