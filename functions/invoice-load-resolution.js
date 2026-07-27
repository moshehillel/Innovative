/**
 * Carrier reference normalization and load-number gate checks for invoice
 * intake. Primus lookups stay in index.js; this module handles field
 * semantics so BOL / order / PRO are not collapsed into one bucket.
 */

/**
 * Normalizes a load number by stripping spaces and dashes.
 * @param {string|null|undefined} loadNumber Raw load number.
 * @return {string} Normalized load number.
 */
function normalizeLoadNumber(loadNumber) {
  return String(loadNumber || "").replace(/[\s-]/g, "").trim();
}

/**
 * Validates a load number is 5–9 digits.
 * @param {string|null|undefined} loadNumber Raw load number.
 * @return {boolean} True if valid.
 */
function isValidLoadNumber(loadNumber) {
  const normalized = normalizeLoadNumber(loadNumber);
  return /^\d{5,9}$/.test(normalized);
}

/**
 * Separates broker load, carrier BOL, order number, PO, and PRO fields.
 * Fixes common AI mis-bucketing (e.g. Schneider order → load, BOL → PRO).
 * @param {object} aiResult AI classification row.
 * @return {object} Sanitized copy.
 */
function normalizeCarrierReferenceFields(aiResult) {
  const out = {...(aiResult || {})};
  out.loadNumber = normalizeLoadNumber(out.loadNumber);
  out.proNumber = normalizeLoadNumber(out.proNumber);
  out.carrierBolNumber = normalizeLoadNumber(out.carrierBolNumber);
  out.carrierOrderNumber = normalizeLoadNumber(out.carrierOrderNumber);
  out.poNumber = normalizeLoadNumber(out.poNumber);

  // BOL duplicated in proNumber — keep BOL, clear PRO.
  if (out.proNumber && out.carrierBolNumber &&
      out.proNumber === out.carrierBolNumber) {
    out.proNumber = "";
  }

  // Legacy extraction: 6-digit BOL in proNumber, 10-digit order in loadNumber.
  if (out.proNumber && !out.carrierBolNumber &&
      isValidLoadNumber(out.proNumber) &&
      out.loadNumber && !isValidLoadNumber(out.loadNumber)) {
    out.carrierBolNumber = out.proNumber;
    out.proNumber = "";
  }

  // Order number mis-placed as broker load.
  if (out.loadNumber && !isValidLoadNumber(out.loadNumber)) {
    if (!out.carrierOrderNumber) out.carrierOrderNumber = out.loadNumber;
    out.loadNumber = "";
  } else if (out.carrierOrderNumber &&
      out.loadNumber === out.carrierOrderNumber) {
    out.loadNumber = "";
  }

  return out;
}

/**
 * Whether a candidate Primus BOL passes format and range gates.
 * @param {string} candidate Normalized load digits.
 * @param {string} normalizedProNumber PRO digits (must differ from load).
 * @param {number|null} lastKnownLoadNumber Recent Primus load, if known.
 * @return {object} Result with ok flag and optional loadNumber.
 */
function evaluateLoadCandidate(
    candidate, normalizedProNumber, lastKnownLoadNumber) {
  const normalized = normalizeLoadNumber(candidate);
  if (!isValidLoadNumber(normalized)) {
    return {ok: false, reason: "invalid_format"};
  }
  if (normalizedProNumber && normalized === normalizedProNumber) {
    return {ok: false, reason: "same_as_pro"};
  }
  const loadNumberInt = Number(normalized);
  const sameDigitLength = lastKnownLoadNumber === null ? true :
    String(loadNumberInt).length === String(lastKnownLoadNumber).length;
  const withinRange = lastKnownLoadNumber === null ? true :
    (!sameDigitLength || (Number.isFinite(loadNumberInt) &&
      Math.abs(loadNumberInt - lastKnownLoadNumber) <= 100000));
  if (!withinRange) {
    return {ok: false, reason: "out_of_range"};
  }
  return {ok: true, loadNumber: normalized, loadNumberInt};
}

/**
 * Ordered Primus lookup keys derived from sanitized invoice references.
 * @param {object} refs Sanitized reference fields.
 * @return {Array<{ref: string, label: string}>}
 */
function buildPrimusLookupKeys(refs) {
  const keys = [];
  const add = (ref, label) => {
    const value = normalizeLoadNumber(ref);
    if (!value) return;
    if (keys.some((k) => k.ref === value)) return;
    keys.push({ref: value, label});
  };
  add(refs.proNumber, "pro");
  add(refs.carrierBolNumber, "carrier_bol");
  add(refs.carrierOrderNumber, "carrier_order");
  add(refs.poNumber, "po");
  return keys;
}

/**
 * Human-readable summary of reference fields for ops review emails.
 * @param {object} refs Sanitized reference fields.
 * @return {object} Label → value map.
 */
function carrierReferenceReviewFields(refs) {
  return {
    "Broker load # (Primus)": refs.loadNumber || "none",
    "Carrier PRO": refs.proNumber || "none",
    "Carrier BOL #": refs.carrierBolNumber || "none",
    "Carrier order #": refs.carrierOrderNumber || "none",
    "PO #": refs.poNumber || "none",
  };
}

module.exports = {
  normalizeLoadNumber,
  isValidLoadNumber,
  normalizeCarrierReferenceFields,
  evaluateLoadCandidate,
  buildPrimusLookupKeys,
  carrierReferenceReviewFields,
};
