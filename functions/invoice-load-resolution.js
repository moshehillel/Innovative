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
 * Validates a load number is exactly 6 digits (Innovative Primus BOL).
 * @param {string|null|undefined} loadNumber Raw load number.
 * @return {boolean} True if valid.
 */
function isValidLoadNumber(loadNumber) {
  const normalized = normalizeLoadNumber(loadNumber);
  return /^\d{6}$/.test(normalized);
}

/**
 * True for Amazon FBA IDs, PT# shipper refs, and similar shipment keys.
 * @param {string|null|undefined} value Raw reference.
 * @return {boolean}
 */
function looksLikeShipmentReference(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  const upper = raw.toUpperCase();
  if (/^FBA[A-Z0-9]{8,}$/.test(upper.replace(/[\s-]/g, ""))) return true;
  if (/^PT#?\s*\d+/i.test(raw)) return true;
  if (/^[A-Z]{2,5}\d{5,}[A-Z0-9]*$/i.test(raw.replace(/[\s-]/g, ""))) {
    return true;
  }
  return false;
}

/**
 * @param {string|null|undefined} value Raw reference.
 * @return {string}
 */
function normalizeShipmentReference(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

/**
 * Separates broker load, carrier BOL, order, PO, PRO, and shipment ref fields.
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
  out.shipmentReference = normalizeShipmentReference(out.shipmentReference);

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

  // Alphanumeric shipment ref mis-placed as broker load (e.g. FBA19FXCCFZT).
  if (out.loadNumber && !isValidLoadNumber(out.loadNumber)) {
    if (looksLikeShipmentReference(out.loadNumber)) {
      if (!out.shipmentReference) {
        out.shipmentReference = normalizeShipmentReference(out.loadNumber);
      }
    } else if (!out.carrierOrderNumber) {
      out.carrierOrderNumber = out.loadNumber;
    }
    out.loadNumber = "";
  } else if (out.carrierOrderNumber &&
      out.loadNumber === out.carrierOrderNumber) {
    out.loadNumber = "";
  }

  if (out.carrierOrderNumber &&
      looksLikeShipmentReference(out.carrierOrderNumber) &&
      !out.shipmentReference) {
    out.shipmentReference = normalizeShipmentReference(out.carrierOrderNumber);
  }

  // Factored invoices (FactorView, Chugh, Apex): billing reference is often
  // the broker Primus load when no separate load # field is shown.
  if (!isValidLoadNumber(out.loadNumber) &&
      isValidLoadNumber(out.carrierBolNumber)) {
    out.loadNumber = out.carrierBolNumber;
  }

  // LTL carriers (e.g. Central Transport) stamp a short account # on every
  // invoice — not the broker Primus load. Prefer PRO lookup when present.
  const proDigits = normalizeLoadNumber(out.proNumber);
  if (out.loadNumber && proDigits.length >= 8 &&
      /^\d{5}$/.test(out.loadNumber)) {
    if (!out.carrierOrderNumber) {
      out.carrierOrderNumber = out.loadNumber;
    }
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
  if (lastKnownLoadNumber !== null &&
      Number.isFinite(lastKnownLoadNumber) &&
      Number.isFinite(loadNumberInt) &&
      Math.abs(loadNumberInt - lastKnownLoadNumber) > 100000) {
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
  const addDigits = (ref, label) => {
    const value = normalizeLoadNumber(ref);
    if (!value) return;
    if (keys.some((k) => k.ref === value)) return;
    keys.push({ref: value, label});
  };
  const addText = (ref, label) => {
    const value = normalizeShipmentReference(ref);
    if (!value) return;
    if (keys.some((k) => k.ref === value)) return;
    keys.push({ref: value, label});
  };
  addDigits(refs.proNumber, "pro");
  addDigits(refs.carrierBolNumber, "carrier_bol");
  addText(refs.shipmentReference, "shipment_ref");
  addText(refs.carrierOrderNumber, "carrier_order");
  addDigits(refs.poNumber, "po");
  return keys;
}

/**
 * Picks the best getBookingsForTracking row for a reference search.
 * @param {Array<object>} rows Tracking search results.
 * @param {object} [hints] invoiceAmount, carrierName.
 * @return {object|null} {loadNumber, row, source}
 */
function pickTrackingSearchMatch(rows, hints = {}) {
  if (!Array.isArray(rows) || !rows.length) return null;
  let candidates = rows.slice();
  const amt = Number(hints.invoiceAmount);
  if (Number.isFinite(amt) && amt > 0) {
    const tol = Math.max(1, amt * 0.02);
    const byAmt = candidates.filter((r) =>
      Math.abs(Number(r.bookingTotal || r.total || 0) - amt) <= tol);
    if (byAmt.length) candidates = byAmt;
  }
  if (hints.carrierName) {
    const needle = String(hints.carrierName).toLowerCase()
        .replace(/[^a-z0-9]+/g, " ");
    const tokens = needle.split(/\s+/).filter((t) => t.length > 2);
    if (tokens.length) {
      const byCarrier = candidates.filter((r) => {
        const hay = [
          r.vendorName,
          r.carrierName,
          r.carrierNameOriginal,
          r.carrierSCAC,
        ].map((s) => String(s || "").toLowerCase()).join(" ");
        return tokens.some((t) => hay.includes(t));
      });
      if (byCarrier.length) candidates = byCarrier;
    }
  }
  const row = candidates[0];
  if (!row || !row.BOL) return null;
  const loadNumber = normalizeLoadNumber(row.BOL);
  if (!isValidLoadNumber(loadNumber)) return null;
  return {loadNumber, row, source: "tracking_search"};
}

/**
 * Extracts a likely load/BOL or PRO from email subject/body text.
 * @param {string} subject Subject line.
 * @param {string} body Email body.
 * @param {object} [hints] Optional AI hints (loadNumberHint, proNumberHint).
 * @return {object} {loadNumber, proNumber}
 */
function extractLoadHintsFromEmailText(subject, body, hints) {
  const hintPro = hints && hints.proNumberHint ?
    String(hints.proNumberHint).trim() : "";
  const text = `${subject || ""}\n${body || ""}`;
  const proLabeled = text.match(
      /(?:pro|beyond\s*pro)\s*[#:]?\s*([A-Z0-9-]{5,})/i);
  return {
    loadNumber: null,
    proNumber: hintPro || (proLabeled ? proLabeled[1] : null),
  };
}

/**
 * Applies explicitly labeled PRO hints from email text when PDF left PRO empty.
 * Never fills loadNumber from subject/body (batch numbers, unlabeled digits).
 * @param {object} aiResult AI classification row.
 * @param {string} subject Email subject.
 * @param {string} body Email body.
 * @param {object} [hints] Optional AI hints.
 * @return {object} Copy with proNumber filled when applicable.
 */
function applyEmailLoadHintsToInvoice(aiResult, subject, body, hints) {
  const out = {...(aiResult || {})};
  const emailHints = extractLoadHintsFromEmailText(subject, body, hints);
  if (!out.proNumber && emailHints.proNumber) {
    out.proNumber = String(emailHints.proNumber).trim();
  }
  return out;
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
    "Shipment / customer ref": refs.shipmentReference || "none",
    "Carrier order #": refs.carrierOrderNumber || "none",
    "PO #": refs.poNumber || "none",
  };
}

module.exports = {
  normalizeLoadNumber,
  isValidLoadNumber,
  looksLikeShipmentReference,
  normalizeShipmentReference,
  normalizeCarrierReferenceFields,
  evaluateLoadCandidate,
  buildPrimusLookupKeys,
  pickTrackingSearchMatch,
  extractLoadHintsFromEmailText,
  applyEmailLoadHintsToInvoice,
  carrierReferenceReviewFields,
};
