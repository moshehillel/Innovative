/**
 * Jerry alerts when Primus (or TAI) has no carrier rate / vendor cost entered.
 * Billing stays To; the load dispatcher is always CC'd when resolved.
 */

"use strict";

/**
 * True when amount validation failed because the TMS has no carrier cost.
 * @param {object|null|undefined} result validateAmountWithPrimus/Tai result.
 * @return {boolean}
 */
function isMissingCarrierCostResult(result) {
  if (!result || typeof result !== "object") return false;
  const err = String(result.error || result.reason || "");
  return /no carrier cost/i.test(err);
}

/**
 * Merges an address into a CC list without duplicating To or existing CCs.
 * @param {string|string[]|null|undefined} existing Existing CC.
 * @param {string|null|undefined} email Address to add.
 * @param {string|null|undefined} to Primary recipient (excluded from CC).
 * @return {string|undefined} Comma-separated CC or undefined when empty.
 */
function mergeDispatcherCc(existing, email, to) {
  const add = String(email || "").trim();
  if (!add || !add.includes("@")) {
    const kept = normalizeCcList(existing);
    return kept.length ? kept.join(", ") : undefined;
  }
  const toLower = String(to || "").trim().toLowerCase();
  const addLower = add.toLowerCase();
  if (toLower && addLower === toLower) {
    const kept = normalizeCcList(existing);
    return kept.length ? kept.join(", ") : undefined;
  }
  const list = normalizeCcList(existing);
  if (!list.some((e) => e.toLowerCase() === addLower)) {
    list.push(add);
  }
  return list.length ? list.join(", ") : undefined;
}

/**
 * @param {string|string[]|null|undefined} cc Raw CC.
 * @return {string[]}
 */
function normalizeCcList(cc) {
  if (!cc) return [];
  const raw = Array.isArray(cc) ? cc : String(cc).split(/[,;]/);
  const out = [];
  for (const part of raw) {
    const email = String(part).trim();
    if (email && email.includes("@")) out.push(email);
  }
  return out;
}

/**
 * Builds the deferred human-review payload for a missing carrier rate.
 * @param {object} opts Alert inputs.
 * @param {string} [opts.loadNumber] Load / BOL number.
 * @param {string} [opts.carrierName] Carrier display name.
 * @param {number|string|null} [opts.invoiceAmount] Carrier invoice total.
 * @param {string} [opts.emailBody] Original email body.
 * @param {string} [opts.dispatcherEmail] Already-resolved dispatcher.
 * @param {string} [opts.department] Review department (default billing).
 * @return {object} Deferred mismatch payload (kind missing_carrier_rate).
 */
function buildMissingCarrierRateAlert(opts) {
  const loadNumber = opts && opts.loadNumber != null ?
    String(opts.loadNumber) : "";
  const carrierName = (opts && opts.carrierName) || "this carrier";
  const amountNum = Number(opts && opts.invoiceAmount);
  const amountLabel = Number.isFinite(amountNum) ?
    `$${amountNum.toFixed(2)}` : "—";
  const dispatcherEmail = opts && opts.dispatcherEmail ?
    String(opts.dispatcherEmail).trim() : "";

  const reason = "Carrier rate is not entered in Primus";
  const notes =
    `I received an invoice from ${carrierName} for load ` +
    `${loadNumber || "—"}. The carrier billed ${amountLabel}, but no ` +
    `carrier rate / cost is entered on the Primus shipment. Please enter ` +
    `the carrier rate in ShipPrimus so Jerry can validate and continue.`;

  const options = {
    department: (opts && opts.department) || "billing",
    extractedData: {
      "Carrier": (opts && opts.carrierName) || "—",
      "Load Number": loadNumber || "—",
      "Invoice Amount": amountLabel,
      "Primus Carrier Cost": "Not entered",
    },
  };
  if (opts && opts.emailBody) options.emailBody = opts.emailBody;
  if (dispatcherEmail) {
    options.cc = dispatcherEmail;
  }

  return {
    kind: "missing_carrier_rate",
    reason,
    notes,
    options,
    submittedAmount: Number.isFinite(amountNum) ? amountNum : null,
    expectedAmount: null,
    difference: null,
    loadNumber: loadNumber || null,
  };
}

/**
 * Ensures review options CC the dispatcher when this is a missing-rate alert.
 * @param {object|null|undefined} deferred Deferred mismatch payload.
 * @param {string|null|undefined} dispatcherEmail Resolved dispatcher.
 * @param {string|null|undefined} reviewTo Billing / review To address.
 * @return {object|null|undefined} Same object with options.cc updated.
 */
function applyDispatcherCcToDeferredAlert(deferred, dispatcherEmail, reviewTo) {
  if (!deferred || deferred.kind !== "missing_carrier_rate") return deferred;
  const options = Object.assign({}, deferred.options || {});
  options.cc = mergeDispatcherCc(
      options.cc, dispatcherEmail, reviewTo);
  return Object.assign({}, deferred, {options});
}

module.exports = {
  isMissingCarrierCostResult,
  mergeDispatcherCc,
  buildMissingCarrierRateAlert,
  applyDispatcherCcToDeferredAlert,
};
