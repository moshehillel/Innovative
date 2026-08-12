/**
 * Quote email intake — AI extraction from customer RFQ emails.
 */

"use strict";

const Anthropic = require("@anthropic-ai/sdk");

/**
 * @param {object} opts subject, from, body.
 * @return {Promise<object>} Parsed quote request.
 */
async function extractQuoteRequest(opts) {
  const subject = String(opts.subject || "");
  const from = String(opts.from || "");
  const body = String(opts.body || "").slice(0, 12000);
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
    fallback.error = "ANTHROPIC_API_KEY not configured";
    return fallback;
  }

  const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
  const res = await client.messages.create({
    model: "claude-sonnet-5",
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
      "",
      "Rules:",
      "- Group table rows by destination city/state/zip into one lane each.",
      "- Sum weight and pallets per lane when table groups freight blocks.",
      "- weightType should be total unless clearly per-piece.",
      "- If class missing, set flags.missingClass true on that lane.",
      "- If pallet count seems wrong (>20), suspiciousPalletCount true.",
      "- Detect liftgate / no dock in global or lane instructions.",
      "- If customer asks for guaranteed + standard options,",
      "  set customerRequest.wantsGuaranteedOptions true.",
      "- If customer asks for carrier expiration days,",
      "  set customerRequest.wantsCarrierExpiration true.",
      "- If customer asks for limited/restricted delivery charges",
      "  in the quote email, set wantsLimitedAccessInQuote true.",
    ].join("\n"),
    messages: [{
      role: "user",
      content: JSON.stringify({subject, from, body}),
    }],
  });

  const raw = String(
      res.content && res.content[0] && res.content[0].text || "",
  ).trim();
  const jsonText = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed.lanes)) parsed.lanes = [];
    if (!parsed.flags) parsed.flags = {};
    return parsed;
  } catch (err) {
    fallback.error = `Parse failed: ${err.message}`;
    fallback.raw = raw.slice(0, 500);
    return fallback;
  }
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

module.exports = {
  extractQuoteRequest,
  looksLikeQuoteRequest,
};
