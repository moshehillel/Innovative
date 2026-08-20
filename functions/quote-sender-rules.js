/**
 * Sender-specific quote intake rules (customer attach + pallet dim defaults).
 * Match From email case-insensitively. Global pallet default remains 40×48×60.
 */

"use strict";

const {
  STANDARD_PALLET_LENGTH,
  STANDARD_PALLET_WIDTH,
  DEFAULT_PALLET_HEIGHT,
} = require("./quote-freight-dims");

/**
 * Map of normalized From email → rule.
 * defaultDims only fill missing L/W/H (and may replace AI-invented global
 * 40×48×60 when the email body has no explicit height).
 * @type {Object<string, {customerName?: string,
 *   defaultDims?: {length: number, width: number, height: number}}>}
 */
const SENDER_RULES = {
  "jared.berman@corehome.com": {
    customerName: "Brumis Imports Inc",
    defaultDims: {length: 40, width: 48, height: 62},
  },
};

/**
 * Extract a bare email from a From header / display string.
 * @param {string} from Raw From.
 * @return {string} Lowercase email or "".
 */
function extractSenderEmail(from) {
  const raw = String(from || "").trim();
  if (!raw) return "";
  const angle = raw.match(/<([^>]+@[^>]+)>/);
  if (angle) return String(angle[1]).trim().toLowerCase();
  const bare = raw.match(/[\w.+-]+@[\w.-]+/);
  return bare ? String(bare[0]).trim().toLowerCase() : "";
}

/**
 * @param {string} from Raw From header.
 * @return {object|null} Sender rule or null.
 */
function resolveSenderRule(from) {
  const email = extractSenderEmail(from);
  if (!email) return null;
  const rule = SENDER_RULES[email];
  return rule && typeof rule === "object" ? {...rule} : null;
}

/**
 * True when the RFQ body includes an explicit L×W×H or height value.
 * @param {string} body Email body.
 * @return {boolean}
 */
function bodyHasExplicitPalletHeight(body) {
  const text = String(body || "");
  if (/\b\d{2}\s*[x×*]\s*\d{2}\s*[x×*]\s*\d{2,3}\b/i.test(text)) {
    return true;
  }
  if (/\b(?:height|hgt|ht)\s*[:=]?\s*\d{2,3}\b/i.test(text)) return true;
  return false;
}

/**
 * Dim opts for normalizePalletDims / normalizePalletFreightRows.
 * @param {string} from Raw From.
 * @return {object} `{defaultDims}` or `{}`.
 */
function dimOptsForSender(from) {
  const rule = resolveSenderRule(from);
  if (!rule || !rule.defaultDims) return {};
  return {defaultDims: {...rule.defaultDims}};
}

/**
 * Replace AI-invented global 40×48×60 with sender defaults when the body
 * never stated a height. Explicit body heights / dims are left alone.
 * @param {object} extracted Intake payload.
 * @param {string} from Raw From.
 * @param {string} body Email body.
 * @return {object}
 */
function applySenderDefaultedDimOverrides(extracted, from, body) {
  const rule = resolveSenderRule(from);
  if (!rule || !rule.defaultDims || !extracted ||
      !Array.isArray(extracted.lanes)) {
    return extracted;
  }
  if (bodyHasExplicitPalletHeight(body)) return extracted;
  const d = rule.defaultDims;
  const wantL = Number(d.length) || STANDARD_PALLET_LENGTH;
  const wantW = Number(d.width) || STANDARD_PALLET_WIDTH;
  const wantH = Number(d.height);
  if (!(wantH > 0) || wantH === DEFAULT_PALLET_HEIGHT) return extracted;

  for (const lane of extracted.lanes) {
    if (!lane || !Array.isArray(lane.freightInfo)) continue;
    lane.freightInfo = lane.freightInfo.map((row) => {
      if (!row || typeof row !== "object") return row;
      const L = Number(row.length);
      const W = Number(row.width);
      const H = Number(row.height);
      const isGlobalDefault =
        L === STANDARD_PALLET_LENGTH &&
        W === STANDARD_PALLET_WIDTH &&
        H === DEFAULT_PALLET_HEIGHT;
      if (!isGlobalDefault) return row;
      return {...row, length: wantL, width: wantW, height: wantH};
    });
  }
  return extracted;
}

/**
 * Force customerName / shippingLocationName from sender rule when set.
 * @param {object} extracted Intake payload.
 * @param {string} from Raw From.
 * @return {object}
 */
function applySenderCustomerOverride(extracted, from) {
  const rule = resolveSenderRule(from);
  if (!rule || !rule.customerName || !extracted ||
      typeof extracted !== "object") {
    return extracted;
  }
  const name = String(rule.customerName).trim();
  if (!name) return extracted;
  extracted.customerName = name;
  extracted.shippingLocationName = name;
  return extracted;
}

module.exports = {
  SENDER_RULES,
  extractSenderEmail,
  resolveSenderRule,
  bodyHasExplicitPalletHeight,
  dimOptsForSender,
  applySenderDefaultedDimOverrides,
  applySenderCustomerOverride,
};
