/**
 * Lisa manual load entry for regular invoices missing load / PRO resolution.
 * Drayage is identified by Primus vendor type (or Leo-validated), not
 * container number or a hardcoded carrier list.
 */
"use strict";

const podFollowup = require("./pod-followup");

const LISA_EMAIL_DEFAULT = podFollowup.LISA_EMAIL;

/**
 * @param {object|null|undefined} item Classified invoice row.
 * @return {boolean}
 */
function isDrayageInvoiceItem(item) {
  if (!item || typeof item !== "object") return false;
  if (item.drayageLeoValidated) return true;
  if (item.drayageByVendorType) return true;
  return false;
}

/**
 * @param {object} aiResult Invoice row.
 * @param {boolean} loadGateFailed Load resolution failed.
 * @return {boolean}
 */
function shouldOfferLisaLoadEntry(aiResult, loadGateFailed) {
  if (!loadGateFailed) return false;
  if (isDrayageInvoiceItem(aiResult)) return false;
  const amount = Number(aiResult && aiResult.invoiceAmount);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  if (aiResult && aiResult.status === "error") return false;
  return true;
}

/**
 * @param {string|null|undefined} loadNumber Raw load digits.
 * @return {string|null}
 */
function normalizeManualLoadNumber(loadNumber) {
  const digits = String(loadNumber || "").replace(/[\s-]/g, "").trim();
  if (/^\d{6}$/.test(digits)) return digits;
  if (/^\d{5}$/.test(digits)) return "2" + digits;
  return null;
}

/**
 * @param {string|null|undefined} loadNumber Normalized load.
 * @return {boolean}
 */
function isValidManualLoadNumber(loadNumber) {
  return /^\d{6}$/.test(String(loadNumber || ""));
}

module.exports = {
  LISA_EMAIL_DEFAULT,
  isDrayageInvoiceItem,
  shouldOfferLisaLoadEntry,
  normalizeManualLoadNumber,
  isValidManualLoadNumber,
};
