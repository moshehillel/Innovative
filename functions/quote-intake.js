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

/** Max plain-text body kept for extract / queue persistence. */
const QUOTE_BODY_STORE_MAX = 20000;

/**
 * Flatten HTML / MIME bodies into plain text for heuristics + AI.
 * Strips styles/scripts and data-URI blobs so huge HTML never reaches
 * Firestore queue docs or the model prompt.
 * @param {string} input Raw body.
 * @return {string}
 */
function toPlainText(input) {
  let text = String(input || "");
  // Drop embedded base64 / data-URI blobs before tag stripping.
  text = text.replace(/data:[a-z0-9.+/-]+;base64,[a-z0-9+/=\s]+/gi, " ");
  if (/<[a-z][\s\S]*>/i.test(text)) {
    text = text
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
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
 * Plain-text body capped for queue / extract storage.
 * @param {string} input Raw or HTML body.
 * @param {number} [max] Max chars (default QUOTE_BODY_STORE_MAX).
 * @return {string}
 */
function sanitizeEmailBodyForStore(input, max) {
  const cap = Math.max(1000, Number(max) || QUOTE_BODY_STORE_MAX);
  return toPlainText(input).slice(0, cap);
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
  applyStgShippingFromSections(next, opts && opts.body);
  fillShipperFromLaneLabelOrigin(next);
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
  let cleaned = String(raw || "")
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
  if (!cleaned) return "";
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }
  // Trailing commas before } or ] break JSON.parse.
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
  return cleaned;
}

/**
 * Salvage complete lane objects from truncated/broken extract JSON.
 * @param {string} raw Model text.
 * @return {Array<object>}
 */
function salvageQuoteLanes(raw) {
  const src = String(raw || "");
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] !== "{") {
      i += 1;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === "\"") inStr = false;
        continue;
      }
      if (c === "\"") {
        inStr = true;
        continue;
      }
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) {
      i += 1;
      continue;
    }
    const chunk = src.slice(i, end + 1);
    try {
      const obj = JSON.parse(chunk.replace(/,\s*([}\]])/g, "$1"));
      if (obj && typeof obj === "object" && !Array.isArray(obj) &&
          (obj.consignee || obj.freightInfo || obj.laneKey || obj.label)) {
        out.push(obj);
      }
    } catch (_) {
      // skip non-lane objects
    }
    i = end + 1;
  }
  return out;
}

/**
 * Parse model extract JSON with trailing-comma + truncated-lane salvage.
 * @param {string} raw Model text.
 * @return {object|null}
 */
function parseQuoteExtractJson(raw) {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (_) {
    // fall through to salvage
  }
  const lanes = salvageQuoteLanes(raw);
  if (!lanes.length) return null;
  return {
    format: "multi_lane_table",
    customerRef: null,
    readyDate: null,
    shipper: null,
    lanes,
    specialInstructionsGlobal: "",
    flags: {needsDispatcherReview: true},
    extractionSource: "json_lane_salvage",
  };
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
    "      chain_store | nursing_home | hotel | residential | other,",
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
    "- Standard GMA pallet footprint is 40 x 48 (length 40, width 48).",
    "  If the email says 48*40 or 48x40, store length:40, width:48.",
    "  Non-standard footprints (e.g. 48*45*39) keep the stated L and W",
    "  (length 48, width 45, height 39) — do NOT collapse to 40x48.",
    "  Height is unchanged. If pallet L/W/H are missing, use 40x48x60",
    "  and dimType PLT — do not invent dims over explicit values.",
    "- Multiple \"Shipping From STG <city>, <ST>\" sections in one email",
    "  mean separate origin warehouses. Create one lane per origin +",
    "  destination row — never merge freight from different STG origins",
    "  into one lane. Each lane shipper must have that section's city/state.",
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
    "- REPLY / thin follow-ups: when the latest message is short (e.g.",
    "  \"it's floor loaded\", \"please check rates\", \"adding quoting",
    "  team\") but the quoted thread still has origin + destination",
    "  and/or freight, EXTRACT lanes from the thread history. Do not",
    "  return empty lanes just because the newest reply is thin.",
    "- Informal OD: \"Pick up at <addr>\", \"from X to Y\", \"from",
    "  Newark airport/port to Staten Island\", \"Vancouver port to",
    "  Toronto\" are valid origins/destinations.",
    "- Informal freight: \"1 pallet: 48x68.5x40, 300 lbs\" or",
    "  \"Each pallet is 48*40*90\" still fill freightInfo.",
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
    // Multi-lane Target/table RFQs need headroom; 4k truncates mid-JSON.
    max_tokens: 16000,
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
    max_completion_tokens: 16000,
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
  const cartonPattern = new RegExp(
      "([\\d.]+)\\s*[x×*]\\s*([\\d.]+)\\s*[x×*]\\s*([\\d.]+)\\s*" +
      "[–\\-—]\\s*(\\d+)\\s*ctns?\\s*" +
      "[–\\-—]\\s*([\\d.,]+)\\s*(?:lbs|ctns)\\b",
      "gi");
  let cm;
  while ((cm = cartonPattern.exec(String(body || ""))) !== null) {
    const key = [cm[1], cm[2], cm[3], cm[5]].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    const weight = Number(String(cm[5]).replace(/,/g, ""));
    freight.push(freightDims.normalizePalletDims({
      qty: 1,
      weight: Number.isFinite(weight) ? weight : null,
      weightType: "total",
      class: null,
      length: Number(cm[1]),
      width: Number(cm[2]),
      height: Number(cm[3]),
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
  // Do not span newlines — zip codes above a "pallet:" line (e.g. 91601)
  // were being read as pallet counts.
  const re = /\b(\d{1,3})\s+(?:pallets?|plts?|skids?)\b/gi;
  let max = null;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n < 1 || n > 200) continue;
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
 * Split "Shipment 1:" / "Shipment 2:" RFQs into per-destination sections.
 * @param {string} body Plain text body.
 * @return {Array<object>}
 */
function extractNumberedShipmentSections(body) {
  const text = String(body || "");
  const headerRe = /\bShipment\s+(\d+)\s*:?\s*(?:\r?\n|$)/gi;
  const headers = [...text.matchAll(headerRe)];
  if (headers.length < 2) return [];

  const sections = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const start = h.index + h[0].length;
    const end = i + 1 < headers.length ? headers[i + 1].index : text.length;
    const block = text.slice(start, end);
    const addr = block.match(
        /\b([A-Za-z][A-Za-z.\s]+?)\s+([A-Z]{2})\s+(\d{5})\d*\b/);
    sections.push({
      num: Number(h[1]),
      text: block,
      city: addr ? addr[1].trim() : "",
      state: addr ? addr[2].toUpperCase() : "",
      zip: addr ? addr[3] : "",
      blocks: extractCompactPalletBlocks(block),
    });
  }
  return sections;
}

/**
 * Match a lane consignee to a numbered shipment section.
 * @param {object} lane Extracted lane.
 * @param {object} section Parsed shipment section.
 * @return {boolean}
 */
function laneMatchesShipmentSection(lane, section) {
  const consignee = lane && lane.consignee;
  if (!consignee || !section) return false;
  const laneZip = String(consignee.zipCode || "")
      .replace(/\D/g, "").slice(0, 5);
  if (laneZip.length === 5 && section.zip === laneZip) return true;
  const laneCity = String(consignee.city || "").trim().toUpperCase();
  const laneState = String(consignee.state || "").trim().toUpperCase();
  const secCity = String(section.city || "").trim().toUpperCase();
  const secState = String(section.state || "").trim().toUpperCase();
  return !!(laneCity && secCity && laneState && secState &&
    laneCity === secCity && laneState === secState);
}

/**
 * Assign carton/pallet dim rows from numbered shipment sections to lanes.
 * Prevents Shipment 2 freight from bleeding into Shipment 1 lanes.
 * @param {object} extracted Parsed quote request.
 * @param {string} body Plain text body.
 * @return {boolean} True when per-shipment assignment ran.
 */
function applyNumberedShipmentPalletBlocks(extracted, body) {
  if (!extracted || !Array.isArray(extracted.lanes)) return false;
  const sections = extractNumberedShipmentSections(body);
  if (sections.length < 2) return false;

  let matched = 0;
  for (const lane of extracted.lanes) {
    if (!lane || typeof lane !== "object") continue;
    const section = sections.find((s) => laneMatchesShipmentSection(lane, s));
    if (!section || !section.blocks.length) continue;
    lane.freightInfo = section.blocks.map((row) => ({...row}));
    matched++;
  }
  return matched > 0;
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
  if (applyNumberedShipmentPalletBlocks(extracted, body)) {
    return extracted;
  }
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
 * Build a single-lane extract payload from shipper/consignee/freight.
 * @param {object} opts subject, shipper, consignee, freightInfo, body, flags.
 * @return {object}
 */
function buildSingleLaneExtract(opts) {
  const subject = String(opts.subject || "");
  const shipper = opts.shipper || null;
  const consignee = opts.consignee || null;
  const body = String(opts.body || "");
  let freightInfo = Array.isArray(opts.freightInfo) ? opts.freightInfo : [];
  if (!freightInfo.length) {
    freightInfo = extractInformalPalletFreight(body);
  }
  if (!freightInfo.length) {
    freightInfo = extractPalletFreight(body);
  }
  const labeled = parseLabeledFreightTotals(body);
  if (labeled.palletCount != null || labeled.cartonCount != null ||
      labeled.weight != null || labeled.length != null) {
    freightInfo = applyLabeledFreightTotals(freightInfo, labeled);
  }
  if (!freightInfo.length) {
    const cartonM = body.match(/(\d+)\s*cartons?\b/i);
    const pltM = body.match(
        /(?:^|\b)(?:1\s+pallet|one\s+pallet|\d+\s*pallets?)\b/i);
    freightInfo = [freightDims.normalizePalletDims({
      qty: pltM && /\d+/.test(pltM[0]) ?
        Number(pltM[0].match(/\d+/)[0]) : (cartonM ? 1 : 1),
      weight: null,
      weightType: "total",
      class: null,
      length: null,
      width: null,
      height: null,
      dimType: cartonM && !pltM ? "CTN" : "PLT",
    })];
    if (cartonM) {
      freightInfo[0].qty = Number(cartonM[1]) || 1;
      freightInfo[0].dimType = "CTN";
    }
  }
  freightInfo = freightInfo.map((r) => freightDims.normalizePalletDims({
    ...r,
    weightType: r.weightType || "total",
  }));

  const city = consignee && consignee.city || "destination";
  const state = consignee && consignee.state || "";
  const laneKey = `${city}_${state || "XX"}`
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_");
  const special = [];
  if (/lift\s*gate/i.test(body)) special.push("Liftgate required");
  if (/residential/i.test(body)) special.push("Residential delivery");
  if (/no loading dock|no dock/i.test(body)) special.push("No loading dock");
  if (/floor\s*loaded/i.test(body)) special.push("Floor loaded");
  if (/live\s*unload/i.test(body)) special.push("Live unload");
  if (/drayage/i.test(body)) special.push("Drayage");

  return {
    format: "single_shipment",
    customerRef: subject.slice(0, 120),
    readyDate: null,
    shipper,
    lanes: [{
      laneKey,
      label: `TO ${city}${state ? `, ${state}` : ""}`.trim(),
      consignee: consignee || {
        name: "", address1: "", city: "", state: "", zipCode: "",
        country: "US", phone: null,
      },
      siteType: /furniture|residential/i.test(body) ? "residential" : "other",
      freightInfo,
      referenceNumbers: [],
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
    extractionSource: opts.extractionSource || "heuristic_fallback",
  };
}

/**
 * Informal "1 pallet: LxWxH, N lbs" / "Each pallet is L*W*H".
 * @param {string} body Body text.
 * @return {Array<object>}
 */
function extractInformalPalletFreight(body) {
  const text = String(body || "");
  const freight = [];
  const seen = new Set();
  const patterns = [
    // eslint-disable-next-line max-len
    /(\d+)\s*pallets?\s*:\s*([\d.]+)\s*[x×*]\s*([\d.]+)\s*[x×*]\s*([\d.]+)\s*,?\s*([\d.,]+)\s*lbs/gi,
    // eslint-disable-next-line max-len
    /(?:^|\b)(?:1|one)\s+pallet\s*:\s*([\d.]+)\s*[x×*]\s*([\d.]+)\s*[x×*]\s*([\d.]+)\s*,?\s*([\d.,]+)\s*lbs/gi,
    // eslint-disable-next-line max-len
    /each\s+pallet\s+is\s+([\d.]+)\s*[x×*]\s*([\d.]+)\s*[x×*]\s*([\d.]+)/gi,
    // eslint-disable-next-line max-len
    /Order\s+\d+\s+Pallet\s+\d+\s*:\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+in\s+([\d.,]+)\s*lbs/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const key = m[0].slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      if (m.length >= 6 && /\d+\s*pallets?\s*:/i.test(m[0])) {
        freight.push(freightDims.normalizePalletDims({
          qty: Number(m[1]) || 1,
          length: Number(m[2]),
          width: Number(m[3]),
          height: Number(m[4]),
          weight: Number(String(m[5]).replace(/,/g, "")),
          weightType: "total",
          dimType: "PLT",
        }));
      } else if (/^1\s+pallet|^one\s+pallet/i.test(m[0].trim()) ||
          /(?:^|\b)(?:1|one)\s+pallet/i.test(m[0])) {
        freight.push(freightDims.normalizePalletDims({
          qty: 1,
          length: Number(m[1]),
          width: Number(m[2]),
          height: Number(m[3]),
          weight: Number(String(m[4]).replace(/,/g, "")),
          weightType: "total",
          dimType: "PLT",
        }));
      } else if (/each\s+pallet/i.test(m[0])) {
        freight.push(freightDims.normalizePalletDims({
          qty: 1,
          length: Number(m[1]),
          width: Number(m[2]),
          height: Number(m[3]),
          weight: null,
          weightType: "total",
          dimType: "PLT",
        }));
      } else if (/Order\s+\d+\s+Pallet/i.test(m[0])) {
        freight.push(freightDims.normalizePalletDims({
          qty: 1,
          length: Number(m[1]),
          width: Number(m[2]),
          height: Number(m[3]),
          weight: Number(String(m[4]).replace(/,/g, "")),
          weightType: "total",
          dimType: "PLT",
        }));
      }
    }
  }
  return freight;
}

/**
 * Parse a loose city / city+state / city+state+zip fragment.
 * @param {string} text Address-ish text.
 * @return {object|null}
 */
function parseLoosePlace(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  // Street-number lines first (before city/state/zip eats the whole string).
  // eslint-disable-next-line max-len
  const streetCity = raw.match(
      // eslint-disable-next-line max-len
      /^(\d{1,6}\s+(?:[A-Za-z0-9.'#-]+\s+){0,6}(?:st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|way|ln|lane|ct|court|pl|place|hwy|highway)\.?)\s*,?\s*([A-Za-z .'-]+?)(?:\s+([A-Z]{2}))?(?:\s+(\d{5}(?:-\d{4})?))?\s*$/i);
  if (streetCity) {
    return {
      name: "",
      address1: streetCity[1].trim(),
      city: streetCity[2].replace(/,/g, "").trim(),
      state: streetCity[3] ? streetCity[3].toUpperCase() : "",
      zipCode: streetCity[4] || "",
      country: "US",
      phone: null,
    };
  }
  // eslint-disable-next-line max-len
  const streetLoose = raw.match(
      // eslint-disable-next-line max-len
      /^(\d{1,6}\s+[A-Za-z0-9 .'#-]+?)\s+([A-Za-z .'-]{2,40}?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/i);
  if (streetLoose) {
    return {
      name: "",
      address1: streetLoose[1].trim(),
      city: streetLoose[2].replace(/,/g, "").trim(),
      state: streetLoose[3].toUpperCase(),
      zipCode: streetLoose[4],
      country: "US",
      phone: null,
    };
  }
  const block = parseAddressBlock(raw.replace(/,\s*/g, "\n"));
  if (block) return block;
  const csz = parseCityStateZip(raw);
  if (csz) {
    return {
      name: "",
      address1: "",
      city: csz.city,
      state: csz.state,
      zipCode: csz.zipCode,
      country: "US",
      phone: null,
    };
  }
  const citySt = raw.match(/^(.+?),?\s+([A-Z]{2})\s*$/i);
  if (citySt) {
    return {
      name: "",
      address1: "",
      city: citySt[1].replace(/,/g, "").trim(),
      state: citySt[2].toUpperCase(),
      zipCode: "",
      country: "US",
      phone: null,
    };
  }
  // City-only known metros / ports (ZIP fill later).
  const cityOnly = raw.match(new RegExp(
      "^(san francisco|los angeles|north hollywood|staten island|" +
      "toronto|vancouver|newark|new york|brooklyn|chicago)\\b", "i"));
  if (cityOnly) {
    const city = cityOnly[1].replace(/\b\w/g, (c) => c.toUpperCase());
    const stateMap = {
      "san francisco": "CA", "los angeles": "CA", "north hollywood": "CA",
      "staten island": "NY", "toronto": "ON", "vancouver": "BC",
      "newark": "NJ", "new york": "NY", "brooklyn": "NY", "chicago": "IL",
    };
    return {
      name: "",
      address1: "",
      city,
      state: stateMap[cityOnly[1].toLowerCase()] || "",
      zipCode: "",
      country: /toronto|vancouver/i.test(city) ? "CA" : "US",
      phone: null,
    };
  }
  return null;
}

/**
 * Heuristic: "Pick up at <origin>" + following destination lines.
 * @param {object} opts subject, body.
 * @return {object|null}
 */
function heuristicPickUpAt(opts) {
  const subject = String(opts.subject || "");
  const body = String(opts.body || "");
  const pick = body.match(/Pick\s*up\s*at\s+([^\n]+)/i);
  if (!pick) return null;
  const shipper = parseLoosePlace(pick[1].trim()) ||
    parseAddressBlock(pick[1].replace(/,\s*/g, "\n"));
  if (!shipper || !(shipper.city || shipper.zipCode || shipper.address1)) {
    return null;
  }

  const after = body.slice(pick.index + pick[0].length);
  const destLines = after
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !/^(pallet|pallets|plt|skid)\b/i.test(l))
      .filter((l) => !/^\d+\s*pallets?\s*:/i.test(l))
      .filter((l) => !/^(please|thank|hi+|hello)\b/i.test(l))
      .filter((l) => !/@/.test(l))
      .filter((l) => !/^www\./i.test(l))
      .slice(0, 6);

  let consignee = null;
  for (let i = 0; i < destLines.length; i++) {
    const line = destLines[i];
    // Prefer street-number lines; allow city-only after.
    const joined = i + 1 < destLines.length ?
      `${line}, ${destLines[i + 1]}` : line;
    consignee = parseLoosePlace(joined) || parseLoosePlace(line);
    if (consignee && (consignee.city || consignee.address1) &&
        !/pallet|lbs|price/i.test(consignee.city || "")) {
      // If city looks like freight noise, skip.
      break;
    }
    consignee = null;
  }
  if (!consignee) {
    // Fall back: known city name anywhere after pickup.
    const cityHit = after.match(new RegExp(
        "\\b(San Francisco|Los Angeles|Staten Island|New York|" +
        "Toronto|Vancouver|Newark)\\b", "i"));
    if (cityHit) consignee = parseLoosePlace(cityHit[1]);
  }
  if (!consignee) return null;

  // Contact name/phone on a "pallet:Name (phone)" line → consignee name.
  const contact = after.match(
      /pallet\s*:\s*([^(\n]+?)\s*\(?(\d{3}[^)\n]{0,20}\d{4})\)?/i);
  if (contact) {
    consignee.name = contact[1].trim();
    if (contact[2]) {
      consignee.phone = contact[2].replace(/[^\d+()-]/g, "").trim();
    }
  }

  return buildSingleLaneExtract({
    subject,
    body,
    shipper,
    consignee,
    extractionSource: "heuristic_pickup_at",
  });
}

/**
 * Heuristic: "from X to Y" / "from X airport/port to Y".
 * @param {object} opts subject, body.
 * @return {object|null}
 */
function heuristicFromTo(opts) {
  const subject = String(opts.subject || "");
  const body = String(opts.body || "");
  const blob = `${subject}\n${body}`;

  // Prefer explicit warehouse / UP address blocks when present.
  const upAddr = body.match(/UP\s+address\.?\s*([^\n]+)/i);
  let whCity = null;
  const whRe = /Warehouse\s+in\s+([^\n.]+)/gi;
  let whM;
  while ((whM = whRe.exec(body)) !== null) {
    const cand = String(whM[1] || "").trim();
    if (/los\s*angel/i.test(cand) || /^[A-Za-z .'-]{2,40}$/.test(cand)) {
      whCity = cand;
      if (/los\s*angel/i.test(cand)) break;
    }
  }
  if (upAddr && whCity) {
    let originText = whCity;
    if (/los\s*angel/i.test(originText)) originText = "Los Angeles, CA";
    const shipper = parseLoosePlace(originText);
    const consignee = parseLoosePlace(upAddr[1].trim());
    if (shipper && consignee &&
        (consignee.address1 || consignee.city || consignee.zipCode)) {
      return buildSingleLaneExtract({
        subject,
        body,
        shipper,
        consignee,
        extractionSource: "heuristic_from_to",
      });
    }
  }

  const patterns = [
    // eslint-disable-next-line max-len
    /(?:transfer\s+)?from\s+((?:[^.\n]{0,40}?\b)?(?:port|airport|warehouse|van)\b[^.\n]{0,40}?)\s+to\s+([^.\n?]{3,80})/i,
    /from\s+([^.\n]{3,60}?)\s+to\s+([^.\n?]{3,60})/i,
    /drayage[^\n]{0,40}?from\s+([^.\n]{3,60}?)\s+to\s+([^.\n?]{3,60})/i,
  ];
  for (const re of patterns) {
    const m = blob.match(re);
    if (!m) continue;
    let originText = m[1].trim()
        .replace(/^(?:an?\s+)?(?:empty\s+)?/i, "")
        .trim();
    let destText = m[2].trim()
        .replace(/\s+about\s+\d.*$/i, "")
        .replace(/\s+and\s+also\b.*$/i, "")
        .replace(/\s+to\s+load\b.*$/i, "")
        .trim();
    if (upAddr) destText = upAddr[1].trim();
    if (whCity && /los\s*angel/i.test(whCity)) {
      originText = "Los Angeles, CA";
    }
    // Normalize "Newark airport/port" / "Vancouver port".
    originText = originText
        .replace(/\b(airport|port)\b/ig, "")
        .replace(/\s+/g, " ")
        .trim() || originText;
    destText = destText
        .replace(/\b(airport|port)\b/ig, "")
        .replace(/\s+/g, " ")
        .trim() || destText;

    const shipper = parseLoosePlace(originText);
    const consignee = parseLoosePlace(destText);
    const shipOk = shipper && (shipper.city || shipper.address1 ||
      shipper.zipCode);
    const consOk = consignee && (consignee.city || consignee.address1 ||
      consignee.zipCode);
    if (!shipOk || !consOk) continue;
    return buildSingleLaneExtract({
      subject,
      body,
      shipper,
      consignee,
      extractionSource: "heuristic_from_to",
    });
  }
  return null;
}

/**
 * Deterministic fallback when AI returns empty/invalid JSON.
 * Handles Pickup Location + Shipping To, Pick up at, and from→to RFQs.
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
  if (pickupMatch && shipToMatch) {
    const shipper = parseAddressBlock(pickupMatch[1]);
    const consignee = parseAddressBlock(shipToMatch[1]);
    if (shipper && consignee) {
      const soMatch = body.match(/Sales Order\s*#?:\s*([A-Z0-9-]+)/i) ||
        body.match(/Please quote\s+([A-Z0-9-]+)/i);
      const built = buildSingleLaneExtract({
        subject: (soMatch && soMatch[1]) || subject,
        body,
        shipper,
        consignee,
        extractionSource: "heuristic_fallback",
      });
      built.customerRef = (soMatch && soMatch[1]) || subject.slice(0, 120);
      return built;
    }
  }

  const pickUpAt = heuristicPickUpAt(opts);
  if (pickUpAt) return pickUpAt;

  const fromTo = heuristicFromTo(opts);
  if (fromTo) return fromTo;

  // Thread has freight dims + any two address-like lines → review lane.
  const freight = extractInformalPalletFreight(body);
  const labeled = parseLabeledFreightTotals(body);
  const hasFreight = freight.length > 0 ||
    labeled.palletCount != null || labeled.weight != null ||
    /\d+\s*cartons?\b/i.test(body);
  if (!hasFreight) return null;

  // Try to find two place-like lines with street numbers.
  const lines = body.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const places = [];
  for (const line of lines) {
    if (places.length >= 2) break;
    if (!/\d/.test(line)) continue;
    if (/^[A-Z]{2}\s+\d{5}/i.test(line)) continue;
    const place = parseLoosePlace(line);
    if (place && (place.address1 || place.zipCode ||
        (place.city && place.state))) {
      places.push(place);
    }
  }
  if (places.length < 2 && !fromTo) {
    // Review skeleton when freight is clear (dispatcher fills OD).
    if (freight.length || labeled.palletCount != null) {
      return buildSingleLaneExtract({
        subject,
        body,
        shipper: null,
        consignee: places[0] || null,
        freightInfo: freight,
        extractionSource: "heuristic_freight_only",
      });
    }
    return null;
  }
  return buildSingleLaneExtract({
    subject,
    body,
    shipper: places[0] || null,
    consignee: places[1] || places[0] || null,
    freightInfo: freight,
    extractionSource: "heuristic_thread_places",
  });
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
 * Fill empty lane shipper from "(STG City, ST)" in the lane label.
 * @param {object} extracted Parsed quote request.
 * @return {object}
 */
function fillShipperFromLaneLabelOrigin(extracted) {
  if (!extracted || !Array.isArray(extracted.lanes)) return extracted;
  for (const lane of extracted.lanes) {
    if (!lane || typeof lane !== "object") continue;
    const ship = lane.shipper && typeof lane.shipper === "object" ?
      lane.shipper : {};
    const hasOd = String(ship.city || "").trim() &&
      String(ship.state || "").trim();
    if (hasOd) continue;
    const label = String(lane.label || lane.laneKey || "");
    const m = label.match(/\(STG\s+([^,]+),\s*([A-Z]{2})\)/i);
    if (!m) continue;
    lane.shipper = {
      ...ship,
      name: ship.name || "STG",
      city: m[1].trim(),
      state: m[2].toUpperCase(),
      country: ship.country || "US",
    };
  }
  return extracted;
}

/**
 * Parse one Core Home STG table row for a known destination.
 * Supports tab-separated rows and newline-separated (one field per line).
 * @param {string} block STG origin section text.
 * @param {object} dest Destination descriptor.
 * @return {object|null}
 */
function parseStgRowForDest(block, dest) {
  const cityEsc = dest.city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const zipEsc = dest.zip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const anchorRe = new RegExp(
      cityEsc + "[\\s\\n]+" + dest.state + "[\\s\\n]+" + zipEsc,
      "i");
  const anchor = anchorRe.exec(block);
  if (!anchor) return null;

  const before = block.slice(0, anchor.index);
  const tailRe = new RegExp(
      "(\\d[\\d,]*(?:\\.\\d+)?)[\\s\\n]+(\\d+)[\\s\\n]+(\\d+)" +
      "[\\s\\n]+\\d{2}/\\d{2}/\\d{2,4}\\b",
      "gi");
  let tail = null;
  let tailMatch;
  while ((tailMatch = tailRe.exec(before)) !== null) {
    tail = tailMatch;
  }
  if (!tail) return null;

  const weight = Number(String(tail[1]).replace(/,/g, ""));
  const pallets = Number(tail[3]);
  if (!(pallets > 0) || !(weight > 0)) return null;

  const head = before.slice(0, tail.index);
  let freightClass = null;
  const classRe =
    /(?:^|[\n\r])\s*(\d+(?:\.\d+)?)\s*(?:[\n\r]|\t)\s*LIDL/gi;
  let classMatch;
  while ((classMatch = classRe.exec(head)) !== null) {
    freightClass = Number(classMatch[1]);
  }
  if (freightClass == null) {
    const classMatch2 = head.match(/(?:^|\n)\s*(\d+(?:\.\d+)?)\b/);
    if (classMatch2) freightClass = Number(classMatch2[1]);
  }

  return {weight, pallets, freightClass};
}

/**
 * Core Home STG multi-warehouse table: rebuild lanes per origin section.
 * @param {object} extracted Parsed quote request.
 * @param {string} body Email body.
 * @return {object}
 */
function applyStgShippingFromSections(extracted, body) {
  if (!extracted || typeof extracted !== "object") return extracted;
  const text = String(body || "");
  const headerRe = /Shipping\s+From\s+STG\s+([^,\n]+),\s*([A-Z]{2})\b/gi;
  const headers = [...text.matchAll(headerRe)];
  if (headers.length < 2) return extracted;

  const dests = [
    {key: "FREDERICKSBURG", city: "Fredericksburg", state: "VA", zip: "22407",
      name: "Lidl US, RDC Fredericksburg"},
    {key: "GRAHAM", city: "Mebane", state: "NC", zip: "27302",
      name: "Lidl US, RDC Graham"},
    {key: "PERRYVILLE", city: "Perryville", state: "MD", zip: "21903",
      name: "Lidl US, RDC Perryville"},
  ];

  const lanes = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const start = h.index + h[0].length;
    const end = i + 1 < headers.length ? headers[i + 1].index : text.length;
    const block = text.slice(start, end);
    const originCity = h[1].trim();
    const originState = h[2].toUpperCase();
    const shipper = {
      name: "STG",
      city: originCity,
      state: originState,
      country: "US",
    };

    for (const dest of dests) {
      const row = parseStgRowForDest(block, dest);
      if (!row) continue;
      lanes.push({
        // eslint-disable-next-line max-len
        laneKey: `STG_${originCity.replace(/\s+/g, "_").toUpperCase()}_${dest.key}`,
        // eslint-disable-next-line max-len
        label: `TO ${dest.name}, ${dest.state} ${dest.zip} (STG ${originCity}, ${originState})`,
        shipper: {...shipper},
        consignee: {
          name: dest.name,
          city: dest.city,
          state: dest.state,
          zipCode: dest.zip,
          country: "US",
        },
        freightInfo: [{
          qty: row.pallets,
          weight: row.weight,
          weightType: "total",
          class: row.freightClass,
          length: 40,
          width: 48,
          height: 60,
          dimType: "PLT",
        }],
        flags: {},
      });
    }
  }

  if (lanes.length >= 3) {
    extracted.lanes = lanes;
    extracted.format = "multi_lane_table";
    pushExtractWarning(extracted, "stg multi-origin rebuild");
  }
  return extracted;
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
  const body = sanitizeEmailBodyForStore(opts.body, 12000);
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
      const parsed = parseQuoteExtractJson(raw);
      if (!parsed) {
        lastErr = new Error("empty model response");
        continue;
      }
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
    if (lastErr) {
      pushExtractWarning(heuristic,
          `AI extract failed (${lastErr.message}); used heuristic`);
    }
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
  QUOTE_BODY_STORE_MAX,
  getQuoteExtractModel,
  isOpenAiExtractModel,
  quoteExtractSystemPrompt,
  callQuoteExtractionModel,
  extractJsonObject,
  parseQuoteExtractJson,
  salvageQuoteLanes,
  extractQuoteRequest,
  looksLikeQuoteRequest,
  classifyIsQuoteRequest,
  toPlainText,
  sanitizeEmailBodyForStore,
  normalizeSoleAddressToConsignee,
  fillShipperFromLaneLabelOrigin,
  applyStgShippingFromSections,
  partyHasPhysicalAddress,
  finishExtract,
  normalizeExtractedQuote,
  pushExtractWarning,
  parseLabeledFreightTotals,
  applyLabeledFreightTotals,
  correctCartonVsPalletFreight,
  extractCompactPalletBlocks,
  extractPalletFreight,
  extractInformalPalletFreight,
  extractNumberedShipmentSections,
  applyNumberedShipmentPalletBlocks,
  applyEmailPalletBlocks,
  parseInformalPalletCount,
  heuristicExtractQuote,
  heuristicPickUpAt,
  heuristicFromTo,
  inferWeightTypeFromBody,
  normalizeFreightOnExtract,
};
