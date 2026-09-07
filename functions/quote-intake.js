/**
 * Quote email intake — AI extraction from customer RFQ emails.
 */

"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai");
const {DEFAULT_OPENAI_MODEL} = require("./openai-models");
const emailAccessorials = require("./quote-email-accessorials");
const freightDims = require("./quote-freight-dims");
const freightRules = require("./quote-freight-rules");
const customerNameUtil = require("./quote-customer-name");
const senderRules = require("./quote-sender-rules");

const QUOTE_CLASSIFY_BODY_MAX = 12000;
// Bake-off winner: Cursor Grok bot (grok-4.5) scored 19/20 vs Sonnet 4.6
// Agent SDK 18/20 and Haiku+patches 9/20. Override with QUOTE_EXTRACT_MODEL.
const DEFAULT_QUOTE_EXTRACT_MODEL = "grok-4.5";
/** Haiku fallback when Cursor Agent extract fails. */
const FALLBACK_QUOTE_EXTRACT_MODEL = "claude-haiku-4-5";

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
 * Deterministic traffic-cop after AI (and heuristic) extract.
 * AI owns freight lines / dims / weights; code validates consistency,
 * fills truly missing fields, and may expand collapsed AI into labeled
 * mixed-dim detail. Does not blindly rewrite coherent AI freight.
 * @param {object} extracted extractQuoteRequest result.
 * @param {object} [opts] subject, body, from, deferConsistencyFlags.
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
  // Strip mailbox local-part guesses (gershon@gmail → "Gerson") before
  // sender rules can supply a real Primus customer name.
  customerNameUtil.sanitizeExtractedCustomerName(next, senderFrom || from);
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
  applyCoreHomePoTableFreight(next, opts && opts.body);
  fillShipperFromLaneLabelOrigin(next);
  applyEmailPalletBlocks(next, opts);
  correctCartonVsPalletFreight(next, opts && opts.body);
  applyMixedPalletDimLines(next, opts && opts.body);
  applyPerPalletWeightTable(next, opts && opts.body);
  normalizeFreightOnExtract(next, opts && opts.body, dimOpts);
  redistributeEvenTotalWeight(next, opts && opts.body);
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
  stampAlternateQuantityQuoteFlags(next, opts);
  if (!(opts && opts.deferConsistencyFlags)) {
    flagFreightConsistencyIssues(next, opts && opts.body);
  }
  return next;
}

/**
 * Mark alternate qty RFQs so freight combine never merges them.
 * @param {object} extracted Intake payload (mutated).
 * @param {object} [opts] subject, body.
 * @return {void}
 */
function stampAlternateQuantityQuoteFlags(extracted, opts) {
  if (!extracted || typeof extracted !== "object") return;
  const blob = [
    opts && opts.subject,
    opts && opts.body,
    extracted._sourceSubject,
    extracted._sourceBody,
    extracted.specialInstructionsGlobal,
    ...(Array.isArray(extracted.lanes) ?
      extracted.lanes.map((l) => l && l.specialInstructions) : []),
  ].filter(Boolean).join("\n");
  if (!freightRules.isAlternateQuantityQuote(blob) &&
      !(extracted.flags && extracted.flags.alternateQuantityQuotes)) {
    return;
  }
  extracted.flags = extracted.flags && typeof extracted.flags === "object" ?
    {...extracted.flags} : {};
  extracted.flags.alternateQuantityQuotes = true;
  if (!Array.isArray(extracted.lanes)) return;
  for (const lane of extracted.lanes) {
    if (!lane || typeof lane !== "object") continue;
    lane.flags = lane.flags && typeof lane.flags === "object" ?
      {...lane.flags} : {};
    lane.flags.doNotCombine = true;
    lane.flags.alternateQuantityQuote = true;
  }
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
 * Sync path (tests / callers that skip AI repair). Prefer
 * finishExtractAsync when extract API keys are available so a single
 * freight repair pass can run on consistency failure.
 * @param {object} extracted Intake payload.
 * @param {object} opts subject, body, from.
 * @return {object}
 */
function finishExtract(extracted, opts) {
  return normalizeExtractedQuote(extracted, opts);
}

/**
 * Normalize, optionally run one AI freight repair pass on failing lanes,
 * then flag consistency. Max one repair attempt per quote.
 * @param {object} extracted Intake payload.
 * @param {object} opts subject, body, from.
 * @return {Promise<object>}
 */
async function finishExtractAsync(extracted, opts) {
  const next = normalizeExtractedQuote(extracted, {
    ...(opts || {}),
    deferConsistencyFlags: true,
  });
  await maybeRepairFreightExtract(next, opts);
  flagFreightConsistencyIssues(next, opts && opts.body);
  return next;
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
 * Configured extract model (Cursor Grok/Composer, Claude, or OpenAI slug).
 * @return {string}
 */
function getQuoteExtractModel() {
  return process.env.QUOTE_EXTRACT_MODEL || DEFAULT_QUOTE_EXTRACT_MODEL;
}

/**
 * Cursor API key. Prefer CRSR_API_KEY (project convention); also accept
 * CURSOR_API_KEY (SDK / docs name).
 * @return {string|null}
 */
function getCursorApiKey() {
  const key = process.env.CRSR_API_KEY || process.env.CURSOR_API_KEY || null;
  return key && String(key).trim() ? String(key).trim() : null;
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
 * True for Cursor Agent SDK extract models (Grok bot / Composer).
 * @param {string} model Model slug.
 * @return {boolean}
 */
function isCursorExtractModel(model) {
  const m = String(model || "").toLowerCase();
  return m.startsWith("grok-") || m.startsWith("composer-");
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
    "- customerName: bill-to / account / company requesting the quote.",
    "  Prefer signature company, body bill-to / account, or letterhead.",
    "  NEVER invent customerName from the email local-part (before @).",
    "  Example: gershon@gmail.com → customerName null (not Gerson,",
    "  Gershon, or Gmail). Freemail hosts (gmail/yahoo/hotmail/",
    "  outlook/icloud/aol/me.com/etc.) are never company names.",
    "  Company domains only: when no better signal exists, the org",
    "  label after @ may be used (jane@acme.com → Acme;",
    "  ops@mail.acme.com → Acme).",
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
    "- flags: {needsDispatcherReview: boolean,",
    "    alternateQuantityQuotes: boolean}",
    "",
    "WORKED EXAMPLES (follow these exactly):",
    "1) \"No Appointment necessary\" / \"no appt needed\" /",
    "   \"appointment not required\" / \"FIRST COME, FIRST SERVED\" /",
    "   \"FCFS\" → do NOT put APD or APO in",
    "   requestedAccessorials. Put \"APD\" in",
    "   customerDeclinedAccessorials. Copy the phrase into",
    "   specialInstructions only. The word \"appointment\" is not a",
    "   request when it is negated or when receiving is FCFS.",
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
    "6) \"Total weight – 8146.05\" (or 8146) on many pallets with ONE",
    "   freight line (same dims) → weight 8146.05 (or 8146),",
    "   weightType \"total\". Never strip the decimal (814605 is wrong).",
    "   Keep thousands commas as numbers (\"1,300\" → 1300, not 1).",
    "6b) Total weight + mixed pallet dims (e.g. \"Total weight – 1,300\",",
    "   \"Number of Pallets - 4\", \"3 plts @ 48x40x85, 48x40x66\") →",
    "   TWO freight lines with dims preserved; divide total evenly per",
    "   pallet: weight 325, weightType \"each\" on EVERY line",
    "   (1300/4). Do NOT put 1300 on the first line and invent 1 lb",
    "   on the second. Do NOT put the full total on only one dim group.",
    "6c) \"Number of Pallets - 3\" + \"3 plts @ 40x48x84, 40x48x87,",
    "   40x48x47\" → THREE freight lines qty 1 each (total 3 pcs),",
    "   not 3+1+1=5 or 3+2+1=6. Divide total weight by 3 per pallet.",
    "7) Zip-only \"from 08701 to 22911\" → shipper.zipCode 08701 and",
    "   consignee.zipCode 22911 even if city/state are blank.",
    "8) \"Please include any additional charges applicable for",
    "   restricted or limited delivery directly in the quote email\"",
    "   / \"any applicable limited access charges\" / \"if limited",
    "   access applies, include in quote\" → do NOT set",
    "   wantsLimitedAccessInQuote and do NOT put LAD in",
    "   requestedAccessorials. That is disclose-if-needed boilerplate,",
    "   not a request to apply limited access.",
    "9) \"needs limited access\" / \"limited access delivery required\"",
    "   / \"restricted access\" / \"LAD please\" →",
    "   wantsLimitedAccessInQuote true AND LAD in",
    "   requestedAccessorials.",
    "10) \"Lift gate needed for delivery\" / liftgate near the word",
    "   delivery → LFD only. Do NOT also add LFO.",
    "11) \"quote 1 skid … Then also quote 2 skids\" / \"2 rates needed\"",
    "   / alternate qty on the SAME origin+dest → TWO separate lanes",
    "   (lane A qty 1 with that line's weight/class/dims; lane B qty 2",
    "   with its own weight/class/dims). Never put qty 2 on the 1-skid",
    "   line. Never merge into one shipment. Set flags",
    "   alternateQuantityQuotes true on the top-level flags object.",
    "",
    "FALSE POSITIVES (never treat these as requests):",
    "- Limited-access disclose boilerplate (Core Home / RFQ templates)",
    "  that asks to show charges IF limited access applies.",
    "- \"No appointment necessary\" / \"no appt needed\" /",
    "  \"FIRST COME FIRST SERVED\" / FCFS (decline APD).",
    "- Liftgate scoped to delivery only (do not invent LFO).",
    "- Confidentiality / legal \"please notify the sender\" —",
    "  not notification delivery (NTD).",
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
    "  If the email says Total weight / \"total weight – N\" and there is",
    "  ONE freight line (same dims for all pallets), weightType MUST be",
    "  \"total\" even when qty > 1. If there are MULTIPLE dim lines /",
    "  mixed heights and only a shipment total weight (no per-line lbs),",
    "  divide total/palletCount per piece and use weightType \"each\".",
    "- Standard GMA pallet footprint is 40 x 48 (length 40, width 48).",
    "  Store L×W×H. If dims are labeled — Length/Width/Height OR just",
    "  L/W/H (L: 40, W 57, H 48, 40L x 57H x 48W, L 40 x H 57 x W 48)",
    "  — map by label, not written order. L/W/H means the same as",
    "  length/width/height. If they put the order in parentheses after",
    "  the numbers — e.g. 36 x 22 x 45 in (W x H x L) — that is the",
    "  order of the three numbers (store length 45, width 36, height 22).",
    "  If the email says 48*40 or 48x40, store length:40, width:48.",
    "  If unlabeled numbers include 40 and 48 anywhere (e.g. 40x57x48",
    "  or 57x40x48), those are L and W (store 40x48); the other number",
    "  is height.",
    "  If first and last match (e.g. 45x79x45), that pair is the base",
    "  and the middle number is height (45x45x79).",
    "  Non-standard footprints (e.g. 48*45*39) keep the stated L and W",
    "  (length 48, width 45, height 39) — do NOT collapse to 40x48.",
    "  Do NOT assume the largest number is height when 40 and 48 are",
    "  absent (96x48x48 stays length 96).",
    "  Height is unchanged otherwise. If pallet L/W/H are missing,",
    "  use 40x48x60 and dimType PLT — do not invent dims over",
    "  explicit values.",
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
    "  liftgate pickup/origin → LFO; liftgate delivery /",
    "  liftgate needed for delivery / liftgate near the word",
    "  delivery → LFD only (do NOT also add LFO); bare",
    "  liftgate/no dock with no side (e.g. LIFTGATE NEEDED) →",
    "  LFD only (do NOT add LFO unless pickup/origin is explicit);",
    "  appointment",
    "  → APD (APO if pickup) UNLESS the email says no appointment",
    "  / no appt needed / appointment not required / FCFS /",
    "  first come first served;",
    "  residential → RSD; limited/restricted",
    "  access → LAD (LAO if pickup) ONLY when clearly requested",
    "  (needs limited access, limited access delivery required,",
    "  restricted access, LAD please). Do NOT add LAD for",
    "  disclose-if-applicable charge boilerplate;",
    "  inside delivery → IND;",
    "  inside pickup → INO; insurance → INS; hazmat → HAZ;",
    "  notification delivery / notify before delivery /",
    "  notify consignee / call ahead → NTD. Do NOT add NTD for",
    "  bare \"notify\" / \"notification\" (e.g. confidentiality",
    "  \"please notify the sender\").",
    "- Set flags.residentialDelivery true when residential/",
    "  home delivery is requested.",
    "- Military bases, forts, AFB, naval/Marine stations, AAFES,",
    "  NEX / NEXCOM / Navy Exchange / MCX / commissary DCs",
    "  (including names like \"NEX NE DC\" or \"WC Retail Dist Ctr\"",
    "  on NEXCOM RFQs) → siteType aafes_military. Do NOT use",
    "  chain_store for military exchange retail DCs.",
    "- If customer asks for guaranteed + standard options,",
    "  set customerRequest.wantsGuaranteedOptions true.",
    "- If customer asks for carrier expiration days,",
    "  set customerRequest.wantsCarrierExpiration true.",
    "- wantsLimitedAccessInQuote: true ONLY when the customer",
    "  clearly requests limited/restricted access be applied.",
    "  False for \"include any additional charges applicable for",
    "  restricted or limited delivery\" / \"any applicable limited",
    "  access charges\" / \"if limited access applies, include in",
    "  quote\" — those ask to disclose charges if needed, not to",
    "  add LAD.",
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
 * @param {string} [systemPrompt] Override system prompt.
 * @return {Promise<string>} Raw model text.
 */
async function callClaudeQuoteExtraction(payload, model, systemPrompt) {
  const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
  const res = await client.messages.create({
    model,
    // Multi-lane Target/table RFQs need headroom; 4k truncates mid-JSON.
    max_tokens: 16000,
    system: systemPrompt || quoteExtractSystemPrompt(),
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
 * @param {string} [systemPrompt] Override system prompt.
 * @return {Promise<string>} Raw model text.
 */
async function callOpenAiQuoteExtraction(payload, model, systemPrompt) {
  const apiKey = getQuoteClassifyOpenAiKey();
  if (!apiKey) throw new Error("OpenAI API key not configured");
  const client = new OpenAI({apiKey});
  const completion = await client.chat.completions.create({
    model,
    max_completion_tokens: 16000,
    response_format: {type: "json_object"},
    messages: [
      {role: "system", content: systemPrompt || quoteExtractSystemPrompt()},
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
 * Cursor Agent SDK extract (same path as bake-off winner grok-4.5).
 * @param {object} payload subject/from/body.
 * @param {string} model Cursor model id (e.g. grok-4.5).
 * @param {string} [systemPrompt] Override system prompt.
 * @return {Promise<string>} Raw model text.
 */
async function callCursorQuoteExtraction(payload, model, systemPrompt) {
  const apiKey = getCursorApiKey();
  if (!apiKey) throw new Error("CRSR_API_KEY not configured");
  let Agent;
  let Cursor;
  try {
    ({Agent, Cursor} = require("@cursor/sdk"));
  } catch (err) {
    throw new Error(
        `@cursor/sdk not installed (${err.message}). ` +
        "Run npm install in functions/",
    );
  }
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const {spawnSync} = require("child_process");

  // Bake-off fix: HTTP/1 avoids intermittent local Protocol errors.
  try {
    Cursor.configure({local: {useHttp1ForAgent: true}});
  } catch (_) {
    // older SDK — ignore
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "quote-cursor-"));
  try {
    spawnSync("git", ["init"], {cwd: scratch, stdio: "ignore"});
    const prompt = [
      systemPrompt || quoteExtractSystemPrompt(),
      "",
      "Return ONLY the extract JSON object. Do not edit files. Do not use tools.",
      "No markdown fences. No explanation.",
      "",
      "EMAIL:",
      JSON.stringify(payload),
    ].join("\n");
    const result = await Agent.prompt(prompt, {
      apiKey,
      model: {id: model},
      tools: [],
      local: {
        cwd: scratch,
        settingSources: [],
        enableAgentRetries: true,
      },
    });

    let text = "";
    if (result && typeof result.stream === "function") {
      try {
        for await (const event of result.stream()) {
          if (event && event.type === "assistant" && event.message &&
              Array.isArray(event.message.content)) {
            for (const block of event.message.content) {
              if (block && block.type === "text" && block.text) {
                text += block.text;
              }
            }
          }
        }
      } catch (_) {
        // fall through to wait/result
      }
    }
    const waited = result && typeof result.wait === "function" ?
      await result.wait() : result;
    const resultText = String(
        (waited && waited.result) || (waited && waited.text) || "",
    ).trim();
    if (resultText && resultText.length > text.length) text = resultText;
    text = String(text || "").trim();

    if (waited && waited.status === "error") {
      const msg = (waited.error && waited.error.message) ||
        "Cursor Agent run error";
      throw new Error(msg);
    }
    if (!text) throw new Error("Cursor Agent returned empty extract");
    return text;
  } finally {
    try {
      fs.rmSync(scratch, {recursive: true, force: true});
    } catch (_) {
      // ignore cleanup
    }
  }
}

/**
 * @param {object} payload subject/from/body or repair payload.
 * @param {string} [model] Override model slug.
 * @param {string} [systemPrompt] Override system prompt.
 * @return {Promise<string>} Raw model text.
 */
async function callQuoteExtractionModel(payload, model, systemPrompt) {
  const slug = model || getQuoteExtractModel();
  if (isCursorExtractModel(slug)) {
    return callCursorQuoteExtraction(payload, slug, systemPrompt);
  }
  if (isOpenAiExtractModel(slug)) {
    return callOpenAiQuoteExtraction(payload, slug, systemPrompt);
  }
  return callClaudeQuoteExtraction(payload, slug, systemPrompt);
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
  const text = normalizeDirtyFreightText(body);
  const pattern = new RegExp(
      "Pallet\\s+(\\d+)\\s*[:.\\-]?\\s+" +
      "([\\d.]+)\\s*" + DIRTY_DIM_SEP + "\\s*([\\d.]+)\\s*" +
      DIRTY_DIM_SEP + "\\s*([\\d.]+)\\s*,?\\s*" +
      "([\\d.,]+)\\s*lbs",
      "gi");
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const n = Number(m[1]);
    if (seen.has(n)) continue;
    seen.add(n);
    const weight = parseLooseNumber(m[5]);
    freight.push(freightDims.normalizePalletDims({
      qty: 1,
      weight: weight != null ? weight : null,
      weightType: "total",
      class: null,
      length: Number(m[2]),
      width: Number(m[3]),
      height: Number(m[4]),
      dimType: "PLT",
    }));
  }
  // Coreforce dim lines: "48*40*50 – 32ctns – 327lbs", optional second
  // dash ("32ctns 327lbs"), optional "(x2) … 30ctns each – 1020lbs each".
  // Also accept "tns" / "tn" (missing leading c) — common Coreforce typo
  // that used to drop a pallet line and overwrite a correct AI extract.
  const cartonPattern = new RegExp(
      "(?:\\(\\s*x\\s*(\\d+)\\s*\\)\\s*)?" +
      "([\\d.]+)\\s*" + DIRTY_DIM_SEP + "\\s*([\\d.]+)\\s*" +
      DIRTY_DIM_SEP + "\\s*([\\d.]+)\\s*" +
      "-\\s*(\\d+)\\s*" + DIRTY_CTN_UNIT + "\\s*" +
      "(?:each\\s*)?" +
      "-?\\s*([\\d.,]+)\\s*(?:lbs|" + DIRTY_CTN_UNIT + ")\\b" +
      "(?:\\s*each\\b)?",
      "gi");
  let cm;
  while ((cm = cartonPattern.exec(text)) !== null) {
    const mult = cm[1] != null ? Number(cm[1]) : 1;
    const qty = Number.isFinite(mult) && mult >= 1 ? mult : 1;
    const key = [cm[2], cm[3], cm[4], cm[6], qty].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    const weight = parseLooseNumber(cm[6]);
    const isEach = /\beach\b/i.test(cm[0]);
    freight.push(freightDims.normalizePalletDims({
      qty,
      weight: weight != null ? weight : null,
      weightType: isEach ? "each" : "total",
      class: null,
      length: Number(cm[2]),
      width: Number(cm[3]),
      height: Number(cm[4]),
      dimType: "PLT",
    }));
  }
  return freight;
}

/**
 * "2 pallets" / "2 plt" / "2 skids" — number before the word.
 * Does not treat "Pallet 1" as qty 1.
 * Returns null for alternate quantity RFQs ("also quote 2 skids") so
 * we never overwrite a 1-skid line with the max mentioned qty.
 * @param {string} text Body.
 * @return {number|null}
 */
function parseInformalPalletCount(text) {
  const blob = String(text || "");
  if (freightRules.isAlternateQuantityQuote(blob)) return null;
  // Same-line only — never span newlines. Otherwise WEIGHT- 139\nPallets- 1
  // (and zip codes above a "pallet:" line) become fake pallet counts.
  const re = /\b(\d{1,3})[^\S\r\n]+(?:pallets?|plts?|skids?)\b/gi;
  let max = null;
  let m;
  while ((m = re.exec(blob)) !== null) {
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
  // "Shipment 1:" / "Shipment 2 (Chino CA):" — optional city paren before :.
  const headerRe = /\bShipment\s+(\d+)\s*(?:\([^)]*\))?\s*:?\s*(?:\r?\n|$)/gi;
  const headers = [...text.matchAll(headerRe)];
  if (headers.length < 2) return [];

  const sections = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const start = h.index + h[0].length;
    const end = i + 1 < headers.length ? headers[i + 1].index : text.length;
    const block = text.slice(start, end);
    // "UXBRIDGE MA 01569" or "Suffolk, VA 23434"
    const addr = block.match(
        /\b([A-Za-z][A-Za-z.'\s]*?),?\s+([A-Z]{2})\s+(\d{5})\d*\b/);
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
function freightInfoQty(rows) {
  return (Array.isArray(rows) ? rows : []).reduce((sum, r) =>
    sum + (Math.max(0, Number(r && r.qty) || 0)), 0);
}

/**
 * Sum of implied shipment pounds across freight rows.
 * @param {Array<object>} rows Freight lines.
 * @return {number}
 */
function freightInfoWeightSum(rows) {
  return (Array.isArray(rows) ? rows : []).reduce((sum, r) =>
    sum + lineImpliedTotalWeight(r), 0);
}

/**
 * Weight tolerance when comparing AI freight sum to labeled Total weight.
 * @param {number} labeledWeight Labeled total lbs.
 * @return {number}
 */
function labeledWeightTolerance(labeledWeight) {
  const w = Number(labeledWeight) || 0;
  return Math.max(25, w * 0.08);
}

/**
 * True when freight rows look complete enough to trust vs a regex fill.
 * @param {Array<object>} rows Freight lines.
 * @return {boolean}
 */
function freightRowsHaveDims(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return false;
  return list.every((r) =>
    Number(r && r.length) > 0 &&
    Number(r && r.width) > 0 &&
    Number(r && r.height) > 0);
}

/**
 * True when AI freight already has usable dims + qty ≥ 1 (default keep).
 * @param {Array<object>} rows Freight lines.
 * @return {boolean}
 */
function aiFreightLooksComplete(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return freightInfoQty(list) >= 1 && freightRowsHaveDims(list);
}

/**
 * True when AI (or candidate) freight is consistent with labeled
 * Number of Pallets + Total weight (within tolerance). Empty AI is never
 * coherent.
 * @param {Array<object>} rows Freight lines.
 * @param {object} labeled parseLabeledFreightTotals result.
 * @return {boolean}
 */
function freightCoherentWithLabels(rows, labeled) {
  const list = Array.isArray(rows) ? rows : [];
  const qty = freightInfoQty(list);
  if (!(qty > 0)) return false;
  const lab = labeled || {};
  if (lab.palletCount != null && qty !== lab.palletCount) return false;
  if (lab.weight != null && lab.weight > 0) {
    const sum = freightInfoWeightSum(list);
    if (!(sum > 0)) return false;
    if (Math.abs(sum - lab.weight) > labeledWeightTolerance(lab.weight)) {
      return false;
    }
  }
  // Near-zero lbs with normal dims is not coherent (class-400 trap).
  for (const r of list) {
    if (!freightDims.isPalletPackaging(r)) continue;
    const per = lineImpliedTotalWeight(r) /
      Math.max(1, Number(r.qty) || 1);
    const h = Number(r.height) || 0;
    const substantial = h >= 24 ||
      freightDims.isStandardPalletFootprint(r.length, r.width);
    if (substantial && per > 0 && per < 25) return false;
  }
  return true;
}

/**
 * AI-first overwrite policy for deterministic post-processors.
 * Default: keep AI freight when it has dims + qty ≥ 1. Deterministic
 * overwrite only when AI is empty/incomplete OR candidate clearly matches
 * labeled totals better (never replace coherent AI with a partial regex).
 * @param {Array<object>} aiRows Existing (usually AI) freight.
 * @param {Array<object>} candidateRows Deterministic parse.
 * @param {object} labeled parseLabeledFreightTotals for this lane scope.
 * @return {boolean} True when candidate should replace AI.
 */
function shouldOverwriteAiFreight(aiRows, candidateRows, labeled) {
  const ai = Array.isArray(aiRows) ? aiRows : [];
  const cand = Array.isArray(candidateRows) ? candidateRows : [];
  const aiQty = freightInfoQty(ai);
  const candQty = freightInfoQty(cand);
  const lab = labeled || {};
  if (!(candQty > 0) || !cand.length) return false;
  if (!(aiQty > 0) || !ai.length) return true;

  const aiComplete = aiFreightLooksComplete(ai);
  const aiCoherent = freightCoherentWithLabels(ai, lab);
  const candCoherent = freightCoherentWithLabels(cand, lab);

  // AI already matches labeled pallet count; regex under-counted (typo).
  if (lab.palletCount != null &&
      aiQty === lab.palletCount &&
      candQty < lab.palletCount) {
    return false;
  }

  if (aiCoherent || (aiComplete && !candCoherent &&
      (lab.palletCount == null || aiQty === lab.palletCount))) {
    // Expand collapsed AI (one lumped line) into mixed dim detail when
    // the deterministic parse matches labeled pallet count.
    if (ai.length <= 1 && cand.length >= 2 &&
        (candCoherent ||
          (lab.palletCount != null && candQty === lab.palletCount))) {
      return true;
    }
    // Expand multi-qty lines into per-pallet unit rows (weight table).
    if (cand.length > ai.length && candCoherent &&
        cand.every((r) => Math.max(0, Number(r.qty) || 0) === 1) &&
        ai.some((r) => Math.max(0, Number(r.qty) || 0) > 1)) {
      return true;
    }
    // Keep coherent / complete AI — never replace with a worse regex.
    if (aiCoherent) return false;
    // Complete AI matching labeled qty: keep unless candidate is better.
    if (aiComplete && !candCoherent) return false;
  }

  if (candCoherent) return true;

  // Neither fully coherent: prefer candidate only when it matches the
  // labeled pallet count and AI does not (or AI is missing dims).
  if (lab.palletCount != null) {
    if (candQty === lab.palletCount && aiQty !== lab.palletCount) {
      return true;
    }
  }
  if (!freightRowsHaveDims(ai) && freightRowsHaveDims(cand)) return true;
  // Default AI-primary: do not overwrite complete AI with incomplete cand.
  if (aiComplete) return false;
  return false;
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
    const labeled = parseLabeledFreightTotals(section.text);
    if (!shouldOverwriteAiFreight(
        lane.freightInfo, section.blocks, labeled)) {
      matched++;
      continue;
    }
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
  const sections = extractNumberedShipmentSections(body);
  for (const lane of extracted.lanes) {
    if (!lane || typeof lane !== "object") continue;
    const rows = Array.isArray(lane.freightInfo) ? lane.freightInfo : [];
    const qty = rows.reduce((sum, r) =>
      sum + (Math.max(0, Number(r.qty) || 0)), 0);
    const sameCount = rows.length === blocks.length && qty === emailQty;
    if (sameCount) continue;
    const scope = resolveLaneFreightScope(lane, body, sections);
    if (!shouldOverwriteAiFreight(rows, blocks, scope.labeled)) continue;
    lane.freightInfo = blocks.map((row) => ({...row}));
  }
  return extracted;
}

/** Dim axis separators accepted in RFQ text (ascii x, multiply, star). */
const DIRTY_DIM_SEP = "[x×*]";
/** Carton OCR: "ctns" / "tns" / "tn" (missing leading c). */
const DIRTY_CTN_UNIT = "c?tns?";
/** Dash / colon separators after labels. */
const DIRTY_LABEL_SEP = "[-–—:=]";

/**
 * Shared dirty-text normalizer for weight/qty/dim parsers.
 * Unifies curly/em dashes, nbsp thousands spaces, and ×/star dims so
 * callers do not invent one-off regexes.
 * @param {*} text Raw email / SI slice.
 * @return {string}
 */
function normalizeDirtyFreightText(text) {
  return String(text || "")
      .replace(/[\u2013\u2014\u2212]/g, "-")
      .replace(/\u00D7/g, "x")
      .replace(/[\u00A0\u202F\u2007\u2009\u200A]/g, " ");
}

/**
 * Parse a labeled integer/float after a heading (colon, dash, em dash).
 * Strips thousands commas ("1,300" → 1300).
 * @param {string} text Body.
 * @param {RegExp} re Pattern with one capture group.
 * @return {number|null}
 */
function matchLabeledNumber(text, re) {
  const m = normalizeDirtyFreightText(text).match(re);
  if (!m) return null;
  return parseLooseNumber(m[1]);
}

/**
 * Number from a capture that may include thousands commas or spaced
 * groups ("6 245", "6 245" narrow nbsp). HTML/PDF→text often uses spaces
 * instead of commas; without this, Total weight becomes 6 and every
 * pallet line inherits that absurd weight.
 * @param {*} raw Raw capture.
 * @return {number|null}
 */
function parseLooseNumber(raw) {
  if (raw == null || raw === "") return null;
  let s = normalizeDirtyFreightText(raw).trim();
  // Drop currency / unit tails accidentally captured.
  s = s.replace(/(?:lbs?|pounds?|kg|kgs)\b.*$/i, "").trim();
  // Keep digits, dots, commas, and spaces (thousands).
  s = s.replace(/[^\d.,\s]/g, "");
  // "6 245" / "6,245" / "6.245.000" (EU) → strip grouping, keep decimal.
  if (/^\d{1,3}([.,\s]\d{3})+$/.test(s)) {
    s = s.replace(/[.,\s]/g, "");
  } else {
    s = s.replace(/,/g, "");
    s = s.replace(/\s+/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * True when a parsed shipment total is too light for the pallet count
 * (e.g. space-thousands bug: "6 245" → 6 on 12 pallets).
 * @param {number|null} weight Lbs.
 * @param {number|null} palletCount Pieces.
 * @return {boolean}
 */
function isImplausibleShipmentWeight(weight, palletCount) {
  if (!(weight > 0) || !Number.isFinite(weight)) return true;
  const pcs = palletCount != null && palletCount > 0 ? palletCount : 1;
  return (weight / pcs) < 25;
}

/**
 * Parse Total Cartons / Number of Pallet(s) / weight / pallet dims.
 * Carton count is pieces; pallet count is PLT qty.
 * @param {string} body Plain text body.
 * @return {object}
 */
function parseLabeledFreightTotals(body) {
  const text = normalizeDirtyFreightText(body);
  let palletCount = matchLabeledNumber(text,
      new RegExp("Number\\s+of\\s+Pallets?\\s*" + DIRTY_LABEL_SEP +
        "?\\s*(\\d+)", "i"));
  if (palletCount == null) {
    palletCount = matchLabeledNumber(text,
        new RegExp("Pallet\\s+Counts?\\s*" + DIRTY_LABEL_SEP +
          "?\\s*(\\d+)", "i"));
  }
  // "Pallets- 1" / "Pallet: 2" — not "1 pallet – 48x40x15" dims.
  if (palletCount == null) {
    palletCount = matchLabeledNumber(text,
        new RegExp("\\bPallets?\\s*" + DIRTY_LABEL_SEP +
          "\\s*(\\d+)(?!\\d)(?!\\s*" + DIRTY_DIM_SEP + ")", "i"));
  }
  if (palletCount == null) {
    const blocks = extractCompactPalletBlocks(text);
    if (blocks.length) {
      palletCount = blocks.reduce((sum, r) =>
        sum + (Math.max(0, Number(r.qty) || 0)), 0);
    }
  }
  if (palletCount == null) {
    const mixed = extractMixedQtyAtDimLines(text, null);
    if (mixed.length) {
      palletCount = mixed.reduce((sum, r) =>
        sum + (Math.max(0, Number(r.qty) || 0)), 0);
    }
  }
  if (palletCount == null) {
    palletCount = parseInformalPalletCount(text);
  }
  let cartonCount = matchLabeledNumber(text,
      new RegExp("Total\\s+Cartons?\\s*" + DIRTY_LABEL_SEP +
        "?\\s*(\\d+)", "i"));
  if (cartonCount == null) {
    cartonCount = matchLabeledNumber(text,
        new RegExp("\\bCTNS?\\s*" + DIRTY_LABEL_SEP + "\\s*(\\d+)\\b", "i"));
  }
  // Allow space / nbsp thousands: "Total weight – 6 245" → 6245.
  const weightNum =
      "([\\d,][\\d,\\s]*(?:\\.\\d+)?)";
  let weight = matchLabeledNumber(text,
      new RegExp("Total\\s+[Ww]eight\\s*" + DIRTY_LABEL_SEP + "?\\s*" +
        weightNum, "i"));
  if (weight == null) {
    weight = matchLabeledNumber(text,
        new RegExp("\\bWEIGHT\\s*" + DIRTY_LABEL_SEP + "\\s*" +
          weightNum + "\\b", "i"));
  }
  if (weight == null) {
    const tableWeights = extractNumberedPalletWeightTable(text);
    if (tableWeights.length >= 2) {
      weight = tableWeights.reduce((sum, w) => sum + w, 0);
    }
  }
  // Reject "6" from "Total weight – 6 245" when spaces were lost mid-parse,
  // or "Total weight – 6 pallets totaling 6245".
  if (weight != null && isImplausibleShipmentWeight(weight, palletCount)) {
    const totaling = text.match(
        /Total\s+[Ww]eight[^.\n]{0,40}?(?:totaling|totalling|=)\s*([\d,]+(?:\.\d+)?)/i);
    if (totaling) {
      const alt = parseLooseNumber(totaling[1]);
      if (alt != null &&
          !isImplausibleShipmentWeight(alt, palletCount)) {
        weight = alt;
      } else {
        weight = null;
      }
    } else {
      weight = null;
    }
  }
  const dim = text.match(new RegExp(
      "Pallet\\s+Dimensions?\\s*" + DIRTY_LABEL_SEP + "?\\s*" +
      "([\\d.]+)\\s*" + DIRTY_DIM_SEP + "\\s*" +
      "([\\d.]+)\\s*" + DIRTY_DIM_SEP + "\\s*([\\d.]+)",
      "i"));
  // Prefer single LxWxH only when not a mixed dim list / "N plts @ …".
  const dimLine = text.match(new RegExp(
      "Pallet\\s+[Dd]imensions?\\s*(?:\\([^)]*\\))?\\s*" +
      DIRTY_LABEL_SEP + "\\s*([^\\n\\r]+)"));
  const dimBlob = dimLine ? dimLine[1] : "";
  const dimVariants = (dimBlob.match(new RegExp(
      "[\\d.]+\\s*" + DIRTY_DIM_SEP + "\\s*[\\d.]+\\s*" +
      DIRTY_DIM_SEP + "\\s*[\\d.]+", "gi")) || []).length;
  const mixedDims = /\d+\s*plts?\s*@/i.test(dimBlob) || dimVariants >= 2;
  return {
    cartonCount,
    palletCount,
    weight,
    length: (!mixedDims && dim) ? Number(dim[1]) : null,
    width: (!mixedDims && dim) ? Number(dim[2]) : null,
    height: (!mixedDims && dim) ? Number(dim[3]) : null,
  };
}

/**
 * "3 plts @ 48x40x85, 48x40x66" / "3 plts @ 48x40x85, 1 plt @ 48x40x66".
 * Bare trailing dims get remaining pallet qty when hint is known.
 * "N plts @ A, B, C" with N dim variants → 1 each (N is total, not
 * first-line qty). Labeled pallet count caps over-counted @ qtys.
 * @param {string} body Email body.
 * @param {number|null} palletCountHint Number of Pallets from labels.
 * @return {Array<object>}
 */
function extractMixedQtyAtDimLines(body, palletCountHint) {
  const text = normalizeDirtyFreightText(body);
  const dimLine = text.match(new RegExp(
      "Pallet\\s+[Dd]imensions?\\s*(?:\\([^)]*\\))?\\s*" +
      DIRTY_LABEL_SEP + "\\s*([^\\n\\r]+)"));
  const blob = dimLine ? dimLine[1] : text;
  const hasQtyAt = /\d+\s*(?:plts?|pallets?|skids?)?\s*@\s*[\d.]+/i.test(blob);

  const freight = [];
  const covered = [];
  let m;
  let explicitQtyAtCount = 0;

  if (hasQtyAt) {
    const qtyAtRe = new RegExp(
        "(\\d+)\\s*(?:plts?|pallets?|skids?)?\\s*@\\s*" +
        "([\\d.]+)\\s*" + DIRTY_DIM_SEP + "\\s*([\\d.]+)\\s*" +
        DIRTY_DIM_SEP + "\\s*([\\d.]+)",
        "gi");
    while ((m = qtyAtRe.exec(blob)) !== null) {
      const qty = Number(m[1]);
      if (!(qty > 0)) continue;
      explicitQtyAtCount += 1;
      covered.push([m.index, m.index + m[0].length]);
      freight.push(freightDims.normalizePalletDims({
        qty,
        weight: null,
        weightType: "total",
        class: null,
        length: Number(m[2]),
        width: Number(m[3]),
        height: Number(m[4]),
        dimType: "PLT",
      }));
    }
  }

  // Bare "48x40x90, 48x40x87, …" (no @) when Pallet dimensions lists
  // multiple variants — one HU per dim (Lifeworks / Nexcom style).
  const allDims = new RegExp(
      "([\\d.]+)\\s*" + DIRTY_DIM_SEP + "\\s*([\\d.]+)\\s*" +
      DIRTY_DIM_SEP + "\\s*([\\d.]+)", "gi");
  while ((m = allDims.exec(blob)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (covered.some(([a, b]) => start >= a && end <= b)) continue;
    freight.push(freightDims.normalizePalletDims({
      qty: 1,
      weight: null,
      weightType: "total",
      class: null,
      length: Number(m[1]),
      width: Number(m[2]),
      height: Number(m[3]),
      dimType: "PLT",
    }));
  }

  if (!freight.length) return [];
  // Bare comma list only from an explicit Pallet dimensions line with
  // 2+ variants (never scan the whole email for random LxWxH).
  if (!hasQtyAt) {
    if (!dimLine || freight.length < 2) return [];
    if (palletCountHint != null && palletCountHint > 0 &&
        freight.length !== palletCountHint &&
        freight.length > palletCountHint) {
      freight.length = palletCountHint;
    }
    if (palletCountHint != null && palletCountHint > 0 &&
        freight.length !== palletCountHint &&
        freight.length < palletCountHint) {
      // Don't invent missing heights — leave for AI / other paths.
      return [];
    }
  }

  // "3 plts @ A, B, C" → leading 3 is the shipment total listing three
  // dim variants (1 each), not qty 3 of A plus bare B/C.
  if (explicitQtyAtCount === 1 && freight.length >= 2) {
    const leadQty = Math.max(0, Number(freight[0].qty) || 0);
    if (leadQty === freight.length) {
      for (const row of freight) row.qty = 1;
    }
  }

  if (palletCountHint != null && palletCountHint > 0) {
    let sum = freight.reduce((s, r) =>
      s + (Math.max(0, Number(r.qty) || 0)), 0);
    if (sum < palletCountHint) {
      const last = freight[freight.length - 1];
      last.qty = (Math.max(0, Number(last.qty) || 0)) +
        (palletCountHint - sum);
    } else if (sum > palletCountHint) {
      // Number of Pallets wins over inflated @ multipliers (e.g. AI/email
      // "3 @ A, 2 @ B, 1 @ C" when labeled total is 3).
      if (freight.length === palletCountHint) {
        for (const row of freight) row.qty = 1;
      } else if (freight.length < palletCountHint) {
        for (const row of freight) row.qty = 1;
        const last = freight[freight.length - 1];
        last.qty += palletCountHint - freight.length;
      } else {
        freight.length = palletCountHint;
        for (const row of freight) row.qty = 1;
      }
    }
  }
  return freight;
}

/**
 * "pallet weight" numbered table: "1 217" / "2 227" … (iRedeem style).
 * @param {string} body Email body.
 * @return {Array<number>} Sequential lbs per pallet (1..N).
 */
function extractNumberedPalletWeightTable(body) {
  const text = String(body || "");
  const header = text.match(/\bpallet\s+weights?\s*:?\s*(?:\r?\n|$)/i);
  if (!header) return [];
  const slice = text.slice(header.index + header[0].length);
  const entries = [];
  for (const line of slice.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (entries.length) break;
      continue;
    }
    const m = trimmed.match(
        /^(\d{1,3})\s+([\d,]+(?:\.\d+)?)\s*(?:lbs?\b)?\s*$/i);
    if (!m) {
      if (entries.length) break;
      continue;
    }
    const num = Number(m[1]);
    const weight = parseLooseNumber(m[2]);
    if (!Number.isFinite(num) || num < 1 || !(weight > 0)) {
      if (entries.length) break;
      continue;
    }
    entries.push({num, weight});
  }
  if (entries.length < 2) return [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].num !== i + 1) return [];
  }
  return entries.map((e) => e.weight);
}

/**
 * Expand mixed dim rows (6+1) into unit qty with per-pallet lbs.
 * @param {Array<object>} dimRows Mixed PLT dim lines.
 * @param {Array<number>} weights Sequential lbs per pallet.
 * @return {Array<object>}
 */
function expandFreightWithPerPalletWeights(dimRows, weights) {
  const list = [];
  let wi = 0;
  for (const row of Array.isArray(dimRows) ? dimRows : []) {
    const qty = Math.max(0, Number(row.qty) || 0);
    for (let i = 0; i < qty; i++) {
      list.push(freightDims.normalizePalletDims({
        qty: 1,
        weight: weights[wi],
        weightType: "each",
        class: row.class != null ? row.class : null,
        length: row.length,
        width: row.width,
        height: row.height,
        dimType: row.dimType || "PLT",
      }));
      wi++;
    }
  }
  return list;
}

/**
 * Flatten freight rows to qty=1 each (preserve order).
 * @param {Array<object>} rows Freight lines.
 * @return {Array<object>}
 */
function flattenFreightToUnitQty(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const qty = Math.max(0, Number(row.qty) || 0) || 1;
    for (let i = 0; i < qty; i++) {
      out.push({...row, qty: 1});
    }
  }
  return out;
}

/**
 * Implied shipment pounds for one freight row.
 * @param {object} row Freight row.
 * @return {number}
 */
function lineImpliedTotalWeight(row) {
  const w = Number(row && row.weight);
  if (!(w > 0) || !Number.isFinite(w)) return 0;
  const qty = Math.max(1, Number(row.qty) || 1);
  const wt = String(row.weightType || "total").trim().toLowerCase();
  const isEach = wt === "each" || wt === "perpiece" || wt === "per-piece";
  return isEach ? w * qty : w;
}

/**
 * True when the RFQ already lists distinct per-line lbs (not just a
 * shipment total).
 * @param {string} body Email body.
 * @return {boolean}
 */
function bodyHasExplicitPerLineWeights(body) {
  const text = String(body || "");
  if (isCoreHomePoTable(text) && parseCoreHomeTableRows(text).length >= 2) {
    return true;
  }
  if (/plts?\s*@[^.\n]{0,40}\d[\d,]*\s*lbs/i.test(text)) return true;
  if (extractNumberedPalletWeightTable(text).length >= 2) return true;
  const blocks = extractCompactPalletBlocks(text);
  if (blocks.length < 2) return false;
  const labeled = parseLabeledFreightTotals(text);
  const total = labeled.weight;
  const withWeight = blocks.filter((b) => Number(b.weight) > 0);
  if (withWeight.length < 2) return false;
  if (total == null) return true;
  return withWeight.some((b) => Math.abs(Number(b.weight) - total) > 0.5);
}

/**
 * Even lbs/pallet from a shipment total (Leo: 1300/4 = 325 each).
 * @param {Array<object>} rows Freight lines.
 * @param {number} totalWeight Shipment total lbs.
 * @return {Array<object>}
 */
function assignEvenWeightPerPallet(rows, totalWeight) {
  const list = (Array.isArray(rows) ? rows : []).map((r) =>
    (r && typeof r === "object" ? {...r} : {}));
  const qtySum = list.reduce((s, r) =>
    s + (Math.max(0, Number(r.qty) || 0)), 0);
  if (!(qtySum > 0) || !(totalWeight > 0)) return list;
  const exact = totalWeight / qtySum;
  const per = Number.isInteger(totalWeight) && Number.isInteger(qtySum) &&
    (totalWeight % qtySum === 0) ?
    (totalWeight / qtySum) :
    Math.round(exact * 100) / 100;
  return list.map((r) => freightDims.normalizePalletDims({
    ...r,
    weight: per,
    weightType: "each",
  }));
}

/**
 * When Total weight + mixed dim lines (no per-line lbs), divide total
 * evenly per pallet with weightType "each".
 * Prefer skipping when AI per-line weights already look intentional and
 * consistent with the lane-scoped total (within tolerance).
 * @param {Array<object>} rows Freight lines.
 * @param {string} body Email body.
 * @param {object} [labeled] parseLabeledFreightTotals result.
 * @return {boolean}
 */
function shouldEvenSplitTotalWeight(rows, body, labeled) {
  const text = String(body || "");
  if (isCoreHomePoTable(text) && parseCoreHomeTableRows(text).length >= 2) {
    return false;
  }
  const lab = labeled || parseLabeledFreightTotals(body);
  if (lab.weight == null || !(lab.weight > 0)) return false;
  if (!/total\s+weight/i.test(text)) return false;
  const list = Array.isArray(rows) ? rows : [];
  if (list.length < 2) return false;
  const qtySum = list.reduce((s, r) =>
    s + (Math.max(0, Number(r.qty) || 0)), 0);
  if (qtySum < 2) return false;
  if (lab.palletCount != null && qtySum !== lab.palletCount) return false;
  if (bodyHasExplicitPerLineWeights(body)) return false;

  const per = lab.weight / qtySum;
  const allEachOk = list.every((r) => {
    const wt = String(r.weightType || "").trim().toLowerCase();
    const isEach = wt === "each" || wt === "perpiece" || wt === "per-piece";
    return isEach && Math.abs(Number(r.weight) - per) < 1;
  });
  if (allEachOk) return false;

  const implied = list.map(lineImpliedTotalWeight);
  const sum = implied.reduce((a, b) => a + b, 0);
  const anyMissing = implied.some((w) => !(w > 0));
  // Missing/junk-cleared weights → fill from labeled total.
  if (anyMissing) return true;

  const anyHoldsFullTotal = list.some((r) => {
    const w = Number(r.weight);
    const qty = Math.max(0, Number(r.qty) || 0);
    const wt = String(r.weightType || "total").trim().toLowerCase();
    const isEach = wt === "each" || wt === "perpiece" || wt === "per-piece";
    return !isEach && Math.abs(w - lab.weight) < 0.5 && qty < qtySum;
  });
  // AI often parks the shipment total on line 1 and invents 1–2 lb stubs
  // on the rest (Lifeworks 2428 + four×2). Treat tiny vs even-share as
  // dump-on-first even when stubs make the row-sum ≈ labeled total.
  const stubMax = Math.max(5, per * 0.05);
  const anyStub = implied.some((w) => w > 0 && w <= stubMax);
  if (anyHoldsFullTotal || anyStub) return true;

  // Intentional AI per-line weights already consistent with labeled total.
  if (Math.abs(sum - lab.weight) <= labeledWeightTolerance(lab.weight) &&
      implied.every((w) => w > stubMax)) {
    return false;
  }
  return true;
}

/**
 * Replace collapsed AI freight with mixed dim lines when the email
 * states them (N plts @ … or bare comma-separated LxWxH list).
 * Uses per-Shipment sections so lane 2 is not overwritten by lane 1 dims.
 * @param {object} extracted Parsed quote.
 * @param {string} body Email body.
 * @return {object}
 */
function applyMixedPalletDimLines(extracted, body) {
  if (!extracted || typeof extracted !== "object") return extracted;
  if (!Array.isArray(extracted.lanes)) return extracted;
  const sections = extractNumberedShipmentSections(body);
  for (const lane of extracted.lanes) {
    if (!lane || typeof lane !== "object") continue;
    const scope = resolveLaneFreightScope(lane, body, sections);
    const labeled = scope.labeled;
    const sectionBody = scope.text;
    const mixed = extractMixedQtyAtDimLines(
        sectionBody, labeled.palletCount);
    if (mixed.length < 2) continue;
    const mixedQty = mixed.reduce((s, r) =>
      s + (Math.max(0, Number(r.qty) || 0)), 0);
    const rows = Array.isArray(lane.freightInfo) ? lane.freightInfo : [];
    const qty = rows.reduce((s, r) =>
      s + (Math.max(0, Number(r.qty) || 0)), 0);
    const sameShape = rows.length === mixed.length && qty === mixedQty &&
      rows.every((r, i) =>
        Number(r.height) === Number(mixed[i].height) &&
        Math.max(0, Number(r.qty) || 0) ===
          Math.max(0, Number(mixed[i].qty) || 0));
    if (sameShape) continue;
    if (rows.length >= 2 && qty === mixedQty) continue;
    // Mixed dims often lack weights — compare qty/dims only vs labels.
    const labeledForOverwrite = {
      ...labeled,
      weight: null,
    };
    if (!shouldOverwriteAiFreight(rows, mixed, labeledForOverwrite)) {
      continue;
    }
    lane.freightInfo = mixed.map((row) => ({...row}));
  }
  return extracted;
}

/**
 * Expand mixed dims + numbered "pallet weight" table into unit rows.
 * Per-Shipment sections when the RFQ has Shipment 1 / 2 blocks.
 * @param {object} extracted Parsed quote.
 * @param {string} body Email body.
 * @return {object}
 */
function applyPerPalletWeightTable(extracted, body) {
  if (!extracted || typeof extracted !== "object") return extracted;
  if (!Array.isArray(extracted.lanes)) return extracted;
  const sections = extractNumberedShipmentSections(body);
  for (const lane of extracted.lanes) {
    if (!lane || typeof lane !== "object") continue;
    const scope = resolveLaneFreightScope(lane, body, sections);
    const sectionBody = scope.text;
    const weights = extractNumberedPalletWeightTable(sectionBody);
    if (weights.length < 2) continue;
    const labeled = scope.labeled;
    const dimRows = extractMixedQtyAtDimLines(
        sectionBody, labeled.palletCount);
    const dimQty = dimRows.reduce((s, r) =>
      s + (Math.max(0, Number(r.qty) || 0)), 0);
    if (dimRows.length && dimQty === weights.length) {
      const expanded = expandFreightWithPerPalletWeights(
          dimRows, weights);
      if (shouldOverwriteAiFreight(
          lane.freightInfo, expanded, labeled)) {
        lane.freightInfo = expanded;
      }
      continue;
    }
    const rows = Array.isArray(lane.freightInfo) ? lane.freightInfo : [];
    const flat = flattenFreightToUnitQty(rows);
    if (flat.length === weights.length) {
      const expanded = flat.map((row, i) =>
        freightDims.normalizePalletDims({
          ...row,
          qty: 1,
          weight: weights[i],
          weightType: "each",
        }));
      if (shouldOverwriteAiFreight(rows, expanded, labeled)) {
        lane.freightInfo = expanded;
      }
    } else if (rows.length === 1 &&
        Math.max(0, Number(rows[0].qty) || 0) === weights.length) {
      const base = rows[0];
      const expanded = weights.map((w) =>
        freightDims.normalizePalletDims({
          ...base,
          qty: 1,
          weight: w,
          weightType: "each",
        }));
      if (shouldOverwriteAiFreight(rows, expanded, labeled)) {
        lane.freightInfo = expanded;
      }
    }
  }
  return extracted;
}

/**
 * Destination-local body slice for multi-dest RFQs without Shipment N
 * headers ("TO WACO TX:" … next "TO …" or EOF).
 * @param {object} lane Extracted lane.
 * @param {string} body Full email body.
 * @return {string|null}
 */
function extractDestinationLocalSlice(lane, body) {
  const text = String(body || "");
  const consignee = lane && lane.consignee;
  if (!consignee || !text) return null;
  const city = String(consignee.city || "").trim();
  const state = String(consignee.state || "").trim().toUpperCase();
  if (!city || city.length < 2) return null;
  const cityEsc = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const statePart = state ? `(?:\\s+${state})?` : "";
  const headerRe = new RegExp(
      `(?:^|\\n)\\s*TO\\s+${cityEsc}${statePart}\\b[^\\n]*:?\\s*(?:\\r?\\n|$)`,
      "i");
  const m = headerRe.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const nextTo = rest.search(/(?:\n)\s*TO\s+[A-Za-z]/i);
  const slice = nextTo >= 0 ? rest.slice(0, nextTo) : rest;
  return String(slice || "").trim() || null;
}

/**
 * Body text + labeled totals scoped to one lane.
 * Prefer Shipment N sections, else lane specialInstructions when it has
 * Total weight / pallet labels, else destination-local "TO CITY" slice,
 * else full body (last resort — multi-dest RFQs without Shipment headers
 * otherwise bleed the first Total weight onto every lane).
 * @param {object} lane Extracted lane.
 * @param {string} body Full email body.
 * @param {Array<object>} sections Numbered shipment sections.
 * @return {{text: string, labeled: object}}
 */
function resolveLaneFreightScope(lane, body, sections) {
  const useSections = Array.isArray(sections) && sections.length >= 2;
  if (useSections) {
    const section = sections.find((s) =>
      laneMatchesShipmentSection(lane, s));
    if (section) {
      return {
        text: section.text,
        labeled: parseLabeledFreightTotals(section.text),
      };
    }
  }
  const si = String((lane && lane.specialInstructions) || "").trim();
  if (si &&
      (/total\s+weight/i.test(si) ||
        /number\s+of\s+pallets?/i.test(si) ||
        /pallet\s+counts?/i.test(si))) {
    const labeled = parseLabeledFreightTotals(si);
    if ((labeled.weight != null && labeled.weight > 0) ||
        labeled.palletCount != null) {
      return {text: si, labeled};
    }
  }
  const destSlice = extractDestinationLocalSlice(lane, body);
  if (destSlice) {
    const labeled = parseLabeledFreightTotals(destSlice);
    if ((labeled.weight != null && labeled.weight > 0) ||
        labeled.palletCount != null ||
        labeled.cartonCount != null) {
      return {text: destSlice, labeled};
    }
  }
  return {
    text: String(body || ""),
    labeled: parseLabeledFreightTotals(body),
  };
}

/**
 * Deterministic: Total weight + mixed PLT lines → even lbs each.
 * Per-Shipment labeled totals when the RFQ has Shipment 1 / 2 blocks.
 * @param {object} extracted Parsed quote.
 * @param {string} body Email body.
 * @return {object}
 */
function redistributeEvenTotalWeight(extracted, body) {
  if (!extracted || typeof extracted !== "object") return extracted;
  if (!Array.isArray(extracted.lanes)) return extracted;
  const sections = extractNumberedShipmentSections(body);
  for (const lane of extracted.lanes) {
    if (!lane || typeof lane !== "object") continue;
    const scope = resolveLaneFreightScope(lane, body, sections);
    const labeled = scope.labeled;
    const sectionBody = scope.text;
    if (labeled.weight == null || !(labeled.weight > 0)) continue;
    const rows = Array.isArray(lane.freightInfo) ? lane.freightInfo : [];
    if (!shouldEvenSplitTotalWeight(rows, sectionBody, labeled)) continue;
    lane.freightInfo = assignEvenWeightPerPallet(rows, labeled.weight);
  }
  return extracted;
}

/**
 * Fill missing weight/dims on a freight row from labeled totals.
 * @param {object} row Freight row.
 * @param {object} labeled Parsed labeled totals.
 * @param {object} [opts] skipWeight — do not copy shipment total onto row.
 * @return {object}
 */
function fillLabeledFreightFields(row, labeled, opts) {
  const next = row && typeof row === "object" ? {...row} : {};
  const lab = labeled || {};
  const skipWeight = opts && opts.skipWeight;
  if (!skipWeight && next.weight == null && lab.weight != null) {
    next.weight = lab.weight;
  }
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

  // Multi-line: fill dims only — never dump shipment total onto every row.
  // redistributeEvenTotalWeight assigns even per-pallet lbs afterward.
  // When AI invents 3+2+1 across three dim lines but Number of Pallets is 3,
  // collapse qtys to 1 each so total pieces match the label.
  if (palletCount != null && rows.length >= 2 &&
      rows.length === palletCount) {
    const totalQty = rows.reduce((sum, r) =>
      sum + (Math.max(0, Number(r.qty) || 0)), 0);
    if (totalQty !== palletCount) {
      rows = rows.map((r) => ({...r, qty: 1}));
    }
  }
  return rows.map((r) => {
    const filled = fillLabeledFreightFields(r, lab, {skipWeight: true});
    if (lab.weight != null && rows.length >= 2) {
      // leave weightType for redistribute; keep existing if present
      if (filled.weightType == null) filled.weightType = "total";
    } else if (lab.weight != null) {
      filled.weightType = "total";
    }
    return freightDims.normalizePalletDims(filled);
  });
}

/**
 * Correct AI/heuristic PLT qty when the email labeled cartons vs pallets.
 * Mutates extracted lanes in place. Uses per-Shipment N sections when
 * present so WEIGHT/Pallets from shipment 1 cannot bleed into shipment 2.
 * @param {object} extracted Parsed quote request.
 * @param {string} body Email body.
 * @return {object}
 */
function correctCartonVsPalletFreight(extracted, body) {
  if (!extracted || typeof extracted !== "object") return extracted;
  if (!Array.isArray(extracted.lanes)) return extracted;
  const sections = extractNumberedShipmentSections(body);
  let anyLabeled = false;
  for (const lane of extracted.lanes) {
    if (!lane || typeof lane !== "object") continue;
    const scope = resolveLaneFreightScope(lane, body, sections);
    const labeled = scope.labeled;
    if (labeled.palletCount == null && labeled.cartonCount == null &&
        labeled.weight == null && labeled.length == null) {
      continue;
    }
    anyLabeled = true;
    const before = Array.isArray(lane.freightInfo) ?
      lane.freightInfo.map((r) => ({...r})) : [];
    const after = applyLabeledFreightTotals(before, labeled);
    // AI-first: when AI freight already matches labeled pallet count +
    // weight, only fill missing fields — do not collapse/replace rows.
    if (before.length >= 2 &&
        freightCoherentWithLabels(before, labeled) &&
        freightInfoQty(before) === freightInfoQty(after) &&
        before.length === after.length) {
      lane.freightInfo = before.map((r) =>
        freightDims.normalizePalletDims(
            fillLabeledFreightFields(r, labeled, {skipWeight: true})));
    } else {
      lane.freightInfo = after;
    }
    if (labeled.palletCount != null && labeled.cartonCount != null &&
        labeled.cartonCount !== labeled.palletCount && lane.flags) {
      lane.flags.suspiciousPalletCount = false;
    }
  }
  if (!anyLabeled) return extracted;
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
      wantsLimitedAccessInQuote:
        emailAccessorials.isLimitedAccessClearRequest(body) ||
        (/limited\s*access|restricted\s*access/i.test(body) &&
          !emailAccessorials.isLimitedAccessDiscloseOnly(body)),
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
 * True for Jared Berman / Core Home STG PO tables (Total Weight + Pallets cols).
 * @param {string} body Email body.
 * @return {boolean}
 */
function isCoreHomePoTable(body) {
  const text = String(body || "");
  return /shipping\s+from\s+stg\b/i.test(text) &&
    /\btotal\s+weight\b/i.test(text) &&
    /\bpallets\b/i.test(text) &&
    /\bpo\s+number\b/i.test(text);
}

/**
 * Count "Shipping From STG" origin headers in the email.
 * @param {string} body Email body.
 * @return {number}
 */
function countStgOriginHeaders(body) {
  const text = String(body || "");
  return [...text.matchAll(
      /Shipping\s+From\s+STG\s+([^,\n]+),\s*([A-Z]{2})\b/gi)].length;
}

/**
 * Parse freight class from text before a weight/ctns/pallets tail.
 * @param {string} head Text before the numeric tail.
 * @return {number|null}
 */
function parseCoreHomeTableFreightClass(head) {
  let freightClass = null;
  const classRe = /(?:^|[\n\r])\s*(\d+(?:\.\d+)?)\s*(?:[\n\r]|\t)/g;
  let classMatch;
  while ((classMatch = classRe.exec(head)) !== null) {
    const n = Number(classMatch[1]);
    if (n >= 50 && n <= 500) freightClass = n;
  }
  return freightClass;
}

/**
 * Parse all Core Home / Menards PO table rows (weight + pallets per PO line).
 * Each row ends with City / State / Zip; numeric tail is
 * Total Weight, Total Ctns, Pallets, In House Date.
 * @param {string} body Email body.
 * @return {Array<object>}
 */
function parseCoreHomeTableRows(body) {
  const text = String(body || "");
  if (!isCoreHomePoTable(text)) return [];
  const destRe = new RegExp(
      "([A-Za-z][A-Za-z .'\\-/()&]{1,48})\\s*[\\n\\r]+\\s*" +
      "([A-Z]{2})\\s*[\\n\\r]+\\s*(\\d{5})(?:-\\d{4})?\\b",
      "g");
  const tailRe = new RegExp(
      "(\\d[\\d,]*(?:\\.\\d+)?)[\\s\\n]+(\\d+)[\\s\\n]+(\\d+)" +
      "[\\s\\n]+\\d{2}/\\d{2}/\\d{2,4}\\b",
      "gi");
  const rows = [];
  let destMatch;
  while ((destMatch = destRe.exec(text)) !== null) {
    const city = destMatch[1].trim();
    const state = destMatch[2].toUpperCase();
    const zip = destMatch[3];
    const before = text.slice(0, destMatch.index);
    let tail = null;
    let tailMatch;
    while ((tailMatch = tailRe.exec(before)) !== null) {
      tail = tailMatch;
    }
    if (!tail) continue;
    const weight = Number(String(tail[1]).replace(/,/g, ""));
    const cartons = Number(tail[2]);
    const pallets = Number(tail[3]);
    if (!(weight > 0) || !(pallets > 0)) continue;
    const head = before.slice(0, tail.index);
    let po = null;
    const poRe = new RegExp(
        "(?:^|[\\n\\r])\\s*([A-Z]{2,8}\\d{6,}|\\d{10,14})\\s*" +
        "[\\n\\r]+\\s*010\\s*[\\n\\r]",
        "gi");
    let poMatch;
    while ((poMatch = poRe.exec(head)) !== null) {
      po = poMatch[1].trim().toUpperCase();
    }
    rows.push({
      po,
      city,
      state,
      zip,
      weight,
      cartons,
      pallets,
      freightClass: parseCoreHomeTableFreightClass(head),
    });
  }
  return rows;
}

/**
 * Build one freight line from a parsed Core Home table row.
 * Multi-pallet rows: per-HU lbs with weightType "each".
 * @param {object} row Parsed table row.
 * @return {object}
 */
function freightLineFromCoreHomeRow(row) {
  const pallets = Math.max(1, Number(row.pallets) || 1);
  const totalWeight = Number(row.weight);
  const line = {
    qty: pallets,
    class: row.freightClass != null ? row.freightClass : null,
    length: 40,
    width: 48,
    height: 60,
    dimType: "PLT",
  };
  if (pallets > 1) {
    const exact = totalWeight / pallets;
    line.weight = Number.isInteger(totalWeight) &&
      totalWeight % pallets === 0 ?
      totalWeight / pallets :
      Math.round(exact * 100) / 100;
    line.weightType = "each";
  } else {
    line.weight = totalWeight;
    line.weightType = "total";
  }
  return line;
}

/**
 * Lane consignee zip (5 digits).
 * @param {object} lane Lane.
 * @return {string}
 */
function laneConsigneeZip5(lane) {
  const z = lane && lane.consignee &&
    (lane.consignee.zipCode || lane.consignee.zip);
  return String(z || "").replace(/\D/g, "").slice(0, 5);
}

/**
 * Apply parsed Core Home PO table freight per destination zip.
 * Fixes multi-pallet rows where AI divided weight once then weightType
 * was forced to "total" (728/2=364 total → Primus 182 ea).
 * @param {object} extracted Parsed quote request.
 * @param {string} body Email body.
 * @return {object}
 */
function applyCoreHomePoTableFreight(extracted, body) {
  if (!extracted || typeof extracted !== "object") return extracted;
  if (!Array.isArray(extracted.lanes)) return extracted;
  const text = String(body || "");
  if (!isCoreHomePoTable(text)) return extracted;
  // Multi-origin STG rebuild (Lidl) owns lane freight entirely.
  if (countStgOriginHeaders(text) >= 2) return extracted;

  const parsed = parseCoreHomeTableRows(text);
  if (!parsed.length) return extracted;

  const byZip = new Map();
  for (const row of parsed) {
    const z = String(row.zip || "").slice(0, 5);
    if (!z) continue;
    if (!byZip.has(z)) byZip.set(z, []);
    byZip.get(z).push(row);
  }

  let applied = 0;
  for (const lane of extracted.lanes) {
    if (!lane || typeof lane !== "object") continue;
    const z = laneConsigneeZip5(lane);
    const tableRows = byZip.get(z);
    if (!tableRows || !tableRows.length) continue;
    const lanesForZip = extracted.lanes.filter(
        (l) => laneConsigneeZip5(l) === z);
    if (lanesForZip.length !== 1) continue;
    lane.freightInfo = tableRows.map((row) =>
      freightDims.normalizePalletDims(freightLineFromCoreHomeRow(row)));
    applied++;
  }

  if (applied > 0) {
    pushExtractWarning(extracted, "core home po table freight");
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
  if (extractNumberedPalletWeightTable(text).length >= 2) return "each";
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
      const withLegend = freightDims.applyEmailDimOrderLegend(base, body);
      const next = freightDims.normalizePalletDims(withLegend, dimOpts);
      if (freightDims.palletDimsWereDefaulted(base, next)) {
        defaultedDims = true;
      }
      const raw = String(next.weightType || "").trim().toLowerCase();
      const rawIsEach = raw === "each" || raw === "perpiece" ||
        raw === "per-piece";
      if (weightType === "total") {
        if (bodyHasExplicitPerLineWeights(body) && rawIsEach) {
          next.weightType = "each";
        } else {
          next.weightType = "total";
        }
      } else if (rawIsEach) {
        next.weightType = "each";
      } else {
        next.weightType = weightType;
      }
      return clearImplausibleLowPalletWeight(
          freightDims.sanitizeImplausiblePalletWeight(next));
    });
  }
  if (defaultedDims) pushExtractWarning(extracted, "defaulted dims");
  return extracted;
}

/**
 * Clear absurdly low per-pallet lbs (GPA/LBE1 screenshot: every line
 * "6 total" → Primus class 400). redistributeEvenTotalWeight refills
 * from a real Total weight afterward.
 * @param {object} row Freight row.
 * @return {object}
 */
function clearImplausibleLowPalletWeight(row) {
  if (!row || typeof row !== "object") return row;
  if (!freightDims.isPalletPackaging(row)) return row;
  const qty = Math.max(1, Number(row.qty) || 1);
  const w = Number(row.weight);
  if (!(w > 0) || !Number.isFinite(w)) return row;
  const wt = String(row.weightType || "total").trim().toLowerCase();
  const isEach = wt === "each" || wt === "perpiece" || wt === "per-piece";
  const total = isEach ? w * qty : w;
  const per = total / qty;
  const h = Number(row.height) || 0;
  const substantial = h >= 24 ||
    freightDims.isStandardPalletFootprint(row.length, row.width);
  if (substantial && per > 0 && per < 25) {
    return {...row, weight: null};
  }
  return row;
}

/**
 * Pure: collect per-lane freight consistency problems vs labeled totals.
 * Used by flagging and to decide whether an AI repair pass is needed.
 * @param {object} extracted Parsed quote.
 * @param {string} body Email body.
 * @return {Array<{laneIndex: number, reasons: string[], labeled: object,
 *   qty: number, weightSum: number}>}
 */
function collectFreightConsistencyIssues(extracted, body) {
  const issues = [];
  if (!extracted || !Array.isArray(extracted.lanes)) return issues;
  const sections = extractNumberedShipmentSections(body);
  for (let laneIndex = 0; laneIndex < extracted.lanes.length; laneIndex++) {
    const lane = extracted.lanes[laneIndex];
    if (!lane || typeof lane !== "object") continue;
    const scope = resolveLaneFreightScope(lane, body, sections);
    const labeled = scope.labeled;
    const rows = Array.isArray(lane.freightInfo) ? lane.freightInfo : [];
    const qty = freightInfoQty(rows);
    const sum = freightInfoWeightSum(rows);
    const reasons = [];

    if (labeled.palletCount != null && qty > 0 &&
        qty !== labeled.palletCount) {
      reasons.push(
          `freight qty ${qty} ≠ labeled ${labeled.palletCount} pallets`);
    }
    if (labeled.weight != null && labeled.weight > 0 && sum > 0 &&
        Math.abs(sum - labeled.weight) >
          labeledWeightTolerance(labeled.weight)) {
      reasons.push(
          `freight weight ${Math.round(sum)} ≠ labeled total ` +
          `${labeled.weight}`);
    }
    for (const r of rows) {
      if (!freightDims.isPalletPackaging(r)) continue;
      const per = lineImpliedTotalWeight(r) /
        Math.max(1, Number(r.qty) || 1);
      const h = Number(r.height) || 0;
      const substantial = h >= 24 ||
        freightDims.isStandardPalletFootprint(r.length, r.width);
      if (substantial && per > 0 && per < 25) {
        reasons.push("implausible pallet weight < 25 lb with normal dims");
        break;
      }
    }
    if (labeled.weight != null && labeled.weight > 0 &&
        rows.some((r) => freightDims.isPalletPackaging(r) &&
          !(lineImpliedTotalWeight(r) > 0))) {
      reasons.push(
          "missing pallet weight vs labeled total (class 400 risk)");
    }
    if (!(labeled.weight > 0) && rows.some((r) => {
      if (!freightDims.isPalletPackaging(r)) return false;
      const h = Number(r.height) || 0;
      const substantial = h >= 24 ||
        freightDims.isStandardPalletFootprint(r.length, r.width);
      const w = Number(r.weight);
      return substantial && Number.isFinite(w) && w > 0 && w < 25;
    })) {
      reasons.push("near-zero pallet weight may force class 400");
    }
    if (reasons.length) {
      issues.push({laneIndex, reasons, labeled, qty, weightSum: sum});
    }
  }
  return issues;
}

/**
 * True when collectFreightConsistencyIssues found failing lanes.
 * @param {object} extracted Parsed quote.
 * @param {string} body Email body.
 * @return {boolean}
 */
function freightNeedsAiRepair(extracted, body) {
  return collectFreightConsistencyIssues(extracted, body).length > 0;
}

/**
 * After normalize: flag qty/weight/density mismatches for dispatcher
 * review instead of silently shipping bad freight.
 * @param {object} extracted Parsed quote.
 * @param {string} body Email body.
 * @return {object}
 */
function flagFreightConsistencyIssues(extracted, body) {
  if (!extracted || typeof extracted !== "object") return extracted;
  const issues = collectFreightConsistencyIssues(extracted, body);
  if (!issues.length) return extracted;
  for (const issue of issues) {
    for (const reason of issue.reasons) {
      pushExtractWarning(extracted, reason);
    }
  }
  extracted.flags = extracted.flags && typeof extracted.flags === "object" ?
    {...extracted.flags} : {};
  extracted.flags.needsDispatcherReview = true;
  return extracted;
}

/**
 * Short system prompt for a single freight repair pass (failing lanes only).
 * @return {string}
 */
function quoteFreightRepairSystemPrompt() {
  return [
    "You repair LTL freightInfo for a freight broker quote extract.",
    "Return ONLY valid JSON (no markdown):",
    "{\"lanes\":[{\"laneIndex\":0,\"freightInfo\":[{qty,weight,weightType,",
    "class,length,width,height,dimType}]}]}",
    "",
    "Rules:",
    "- Fix ONLY the listed failing lanes. Match labeled Number of Pallets",
    "  and Total weight exactly (sum of line weights = Total weight).",
    "- Preserve pallet dims from the email / current freight when sane.",
    "- Cartons ≠ pallets. qty is pallet pieces, not carton count.",
    "- Never invent <25 lb/pallet on normal 40x48 dims.",
    "- Prefer weightType \"each\" when dividing a shipment total across",
    "  multiple pallet lines; use \"total\" for a single lumped line.",
    "- Do not invent shipper/consignee/accessorials — freightInfo only.",
  ].join("\n");
}

/**
 * Build repair user payload for failing lanes only.
 * @param {object} extracted Normalized extract.
 * @param {object} opts subject, from, body.
 * @param {Array<object>} issues collectFreightConsistencyIssues result.
 * @return {object}
 */
function buildFreightRepairPayload(extracted, opts, issues) {
  const lanes = (issues || []).map((issue) => {
    const lane = extracted.lanes[issue.laneIndex] || {};
    return {
      laneIndex: issue.laneIndex,
      problems: issue.reasons,
      labeled: issue.labeled,
      consignee: lane.consignee || null,
      specialInstructions: lane.specialInstructions || "",
      currentFreightInfo: Array.isArray(lane.freightInfo) ?
        lane.freightInfo : [],
    };
  });
  return {
    repair: true,
    subject: opts && opts.subject || "",
    from: opts && opts.from || "",
    body: String(opts && opts.body || "").slice(0, 8000),
    lanes,
  };
}

/**
 * Merge repaired freightInfo into extracted lanes by laneIndex.
 * @param {object} extracted Mutated extract.
 * @param {object} repairedParsed {lanes:[{laneIndex, freightInfo}]}.
 * @return {boolean} True when at least one lane freight was replaced.
 */
function mergeRepairedFreightLanes(extracted, repairedParsed) {
  if (!extracted || !Array.isArray(extracted.lanes)) return false;
  const repairs = repairedParsed && Array.isArray(repairedParsed.lanes) ?
    repairedParsed.lanes : [];
  let merged = false;
  for (const entry of repairs) {
    if (!entry || typeof entry !== "object") continue;
    const idx = Number(entry.laneIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= extracted.lanes.length) {
      continue;
    }
    const freight = Array.isArray(entry.freightInfo) ? entry.freightInfo : [];
    if (!freight.length) continue;
    const lane = extracted.lanes[idx];
    if (!lane || typeof lane !== "object") continue;
    lane.freightInfo = freight.map((r) =>
      freightDims.normalizePalletDims(
          r && typeof r === "object" ? {...r} : {}));
    merged = true;
  }
  return merged;
}

/**
 * Whether extract API keys allow a model call for the given slug.
 * @param {string} model Model slug.
 * @return {boolean}
 */
function canCallQuoteExtractModel(model) {
  const slug = model || getQuoteExtractModel();
  if (isCursorExtractModel(slug)) return Boolean(getCursorApiKey());
  if (isOpenAiExtractModel(slug)) return Boolean(getQuoteClassifyOpenAiKey());
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Optional second AI pass: re-extract freight for failing lanes only.
 * Max one attempt per quote. On failure / unavailable model, keep AI +
 * existing warnings (do not Haiku-overwrite blindly).
 * @param {object} extracted Mutated extract (post first normalize).
 * @param {object} opts subject, body, from.
 * @return {Promise<boolean>} True when repair merged and re-normalized.
 */
async function maybeRepairFreightExtract(extracted, opts) {
  if (!extracted || typeof extracted !== "object") return false;
  if (extracted._freightRepairAttempted) return false;
  extracted._freightRepairAttempted = true;
  const body = opts && opts.body;
  const issues = collectFreightConsistencyIssues(extracted, body);
  if (!issues.length) return false;

  const primaryModel = extracted.extractModel &&
    !String(extracted.extractModel).includes("heuristic") ?
    String(extracted.extractModel).split("+")[0] :
    getQuoteExtractModel();
  if (!canCallQuoteExtractModel(primaryModel)) {
    pushExtractWarning(extracted,
        "freight repair skipped (extract model unavailable)");
    return false;
  }

  try {
    const payload = buildFreightRepairPayload(extracted, opts, issues);
    const raw = await callQuoteExtractionModel(
        payload, primaryModel, quoteFreightRepairSystemPrompt());
    const parsed = parseQuoteExtractJson(raw);
    if (!parsed || !mergeRepairedFreightLanes(extracted, parsed)) {
      pushExtractWarning(extracted, "AI freight repair returned no usable lanes");
      return false;
    }
    normalizeExtractedQuote(extracted, {
      ...(opts || {}),
      deferConsistencyFlags: true,
    });
    const base = String(extracted.extractModel || primaryModel)
        .replace(/\+repair$/, "");
    extracted.extractModel = `${base}+repair`;
    pushExtractWarning(extracted, "AI freight repair pass ran");
    return true;
  } catch (err) {
    pushExtractWarning(extracted,
        `AI freight repair failed (${(err && err.message) || "unknown"})`);
    return false;
  }
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
  let canCallModel = canCallQuoteExtractModel(extractModel);
  let missingKeyError = "extract API key not configured";
  if (isCursorExtractModel(extractModel)) {
    missingKeyError = "CRSR_API_KEY not configured";
  } else if (isOpenAiExtractModel(extractModel)) {
    missingKeyError = "OpenAI API key not configured";
  } else {
    missingKeyError = "ANTHROPIC_API_KEY not configured";
  }
  if (!canCallModel) {
    const heuristic = heuristicExtractQuote({subject, from, body});
    if (heuristic) {
      heuristic.extractModel = "heuristic";
      return finishExtractAsync(heuristic, {subject, body, from});
    }
    fallback.error = missingKeyError;
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
        return finishExtractAsync(parsed, {subject, body, from});
      }
      lastErr = new Error("model returned zero lanes");
    } catch (err) {
      lastErr = err;
    }
  }

  // Cursor path: fall back to Haiku so quoting still works if Agent fails.
  if (isCursorExtractModel(extractModel) && process.env.ANTHROPIC_API_KEY) {
    try {
      raw = await callClaudeQuoteExtraction(
          {subject, from, body}, FALLBACK_QUOTE_EXTRACT_MODEL);
      const parsed = parseQuoteExtractJson(raw);
      if (parsed && Array.isArray(parsed.lanes) && parsed.lanes.length) {
        if (!parsed.flags) parsed.flags = {};
        parsed.extractModel = FALLBACK_QUOTE_EXTRACT_MODEL;
        pushExtractWarning(parsed,
            `Cursor extract failed (${(lastErr && lastErr.message) || "unknown"}); used Haiku fallback`);
        return finishExtractAsync(parsed, {subject, body, from});
      }
    } catch (fallbackErr) {
      lastErr = fallbackErr;
    }
  }

  const heuristic = heuristicExtractQuote({subject, from, body});
  if (heuristic) {
    heuristic.extractModel = "heuristic";
    if (lastErr) {
      pushExtractWarning(heuristic,
          `AI extract failed (${lastErr.message}); used heuristic`);
    }
    return finishExtractAsync(heuristic, {subject, body, from});
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
  FALLBACK_QUOTE_EXTRACT_MODEL,
  QUOTE_BODY_STORE_MAX,
  getQuoteExtractModel,
  getCursorApiKey,
  isOpenAiExtractModel,
  isCursorExtractModel,
  quoteExtractSystemPrompt,
  quoteFreightRepairSystemPrompt,
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
  isCoreHomePoTable,
  parseCoreHomeTableRows,
  applyCoreHomePoTableFreight,
  partyHasPhysicalAddress,
  finishExtract,
  finishExtractAsync,
  normalizeExtractedQuote,
  sanitizeExtractedCustomerName:
    customerNameUtil.sanitizeExtractedCustomerName,
  pushExtractWarning,
  parseLabeledFreightTotals,
  parseLooseNumber,
  normalizeDirtyFreightText,
  isImplausibleShipmentWeight,
  applyLabeledFreightTotals,
  correctCartonVsPalletFreight,
  extractCompactPalletBlocks,
  extractMixedQtyAtDimLines,
  extractPalletFreight,
  extractInformalPalletFreight,
  extractNumberedShipmentSections,
  applyNumberedShipmentPalletBlocks,
  applyEmailPalletBlocks,
  applyMixedPalletDimLines,
  applyPerPalletWeightTable,
  extractNumberedPalletWeightTable,
  expandFreightWithPerPalletWeights,
  resolveLaneFreightScope,
  extractDestinationLocalSlice,
  shouldOverwriteAiFreight,
  aiFreightLooksComplete,
  freightCoherentWithLabels,
  collectFreightConsistencyIssues,
  freightNeedsAiRepair,
  flagFreightConsistencyIssues,
  buildFreightRepairPayload,
  mergeRepairedFreightLanes,
  maybeRepairFreightExtract,
  redistributeEvenTotalWeight,
  assignEvenWeightPerPallet,
  shouldEvenSplitTotalWeight,
  parseInformalPalletCount,
  heuristicExtractQuote,
  heuristicPickUpAt,
  heuristicFromTo,
  inferWeightTypeFromBody,
  normalizeFreightOnExtract,
};
