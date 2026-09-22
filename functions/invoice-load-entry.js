/**
 * Lisa manual load entry for regular invoices missing load / PRO resolution.
 * Drayage is identified by Primus vendor type / Leo validation — not container #.
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

/**
 * True when this classifier item should receive Lisa's manually entered load.
 * Matches by pending invoice amount first (stable across re-classify order),
 * then by itemIndex. Never overrides an item that already has a load #.
 * @param {object} opts Match inputs.
 * @param {string|null|undefined} opts.manualLoad Normalized 6-digit load.
 * @param {number} opts.itemIndex Current loop index.
 * @param {number|null|undefined} opts.manualItemIndex Stored item index.
 * @param {object} opts.aiResult Classifier invoice row.
 * @param {number|null|undefined} opts.pendingAmount Amount from Lisa email.
 * @return {boolean}
 */
function shouldUseLisaManualLoad(opts) {
  const o = opts || {};
  if (!isValidManualLoadNumber(o.manualLoad)) return false;
  const existing = String((o.aiResult && o.aiResult.loadNumber) || "")
      .replace(/\D/g, "");
  if (existing.length >= 5) return false;

  const pendingAmt = Number(o.pendingAmount);
  const itemAmt = Number(o.aiResult && o.aiResult.invoiceAmount);
  if (Number.isFinite(pendingAmt) && pendingAmt > 0 &&
      Number.isFinite(itemAmt) && Math.abs(itemAmt - pendingAmt) < 0.02) {
    return true;
  }

  const manualIdx = Number(o.manualItemIndex);
  const itemIdx = Number(o.itemIndex);
  if (Number.isFinite(manualIdx) && Number.isFinite(itemIdx) &&
      manualIdx === itemIdx) {
    return true;
  }
  return false;
}

module.exports = {
  LISA_EMAIL_DEFAULT,
  isDrayageInvoiceItem,
  shouldOfferLisaLoadEntry,
  normalizeManualLoadNumber,
  isValidManualLoadNumber,
  shouldUseLisaManualLoad,
};
