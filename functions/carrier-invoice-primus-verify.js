"use strict";

/**
 * Normalizes carrier PRO / invoice # for comparison (strip dashes/spaces).
 * @param {string|null|undefined} value Raw reference.
 * @return {string}
 */
function normalizeCarrierReference(value) {
  return String(value || "").replace(/[\s-]/g, "").trim().toLowerCase();
}

/**
 * True when the carrier invoice number from email appears in Primus fields.
 * PDF / file-type upload alone does not count.
 * @param {object} args Evidence inputs.
 * @param {string} [args.carrierInvoiceNumber] Carrier freight bill number.
 * @param {string} [args.carrierRef] booking.vendor.carrierRef.
 * @param {Array<object>} [args.invoices] REST /invoice/bolnumber rows.
 * @param {Array<object>} [args.actualCosts] manage.php actual cost lines.
 * @return {{ok: boolean, present: boolean, source?: string, reason?: string,
 *   hasCarrierBillFileType?: boolean}}
 */
function carrierInvoiceNumberPresentInPrimusEvidence(args) {
  const carrierInvNum = String(args.carrierInvoiceNumber || "").trim();
  if (!carrierInvNum) {
    return {
      ok: false,
      present: false,
      reason: "missing_carrier_invoice_number",
    };
  }
  const norm = normalizeCarrierReference(carrierInvNum);

  const carrierRef = String(args.carrierRef || "").trim();
  if (carrierRef && normalizeCarrierReference(carrierRef) === norm) {
    return {ok: true, present: true, source: "booking_carrierRef"};
  }

  const invoices = Array.isArray(args.invoices) ? args.invoices : [];
  for (const inv of invoices) {
    const vin = String(
        inv.vendorInvoiceNumber || inv.carrierInvoiceNumber || "",
    ).trim();
    if (vin && normalizeCarrierReference(vin) === norm) {
      return {ok: true, present: true, source: "invoice_vendorInvoiceNumber"};
    }
  }

  const actualCosts = Array.isArray(args.actualCosts) ? args.actualCosts : [];
  for (const line of actualCosts) {
    const vin = String(line.vendorInvoiceNumber || "").trim();
    if (vin && normalizeCarrierReference(vin) === norm) {
      return {
        ok: true,
        present: true,
        source: "actual_cost_vendorInvoiceNumber",
      };
    }
  }

  return {
    ok: true,
    present: false,
    reason: "carrier_invoice_number_not_in_primus",
    hasCarrierBillFileType: !!args.hasCarrierBillFileType,
  };
}

/**
 * True when carrier bill is entered in Primus — requires invoice # in fields.
 * @param {object} args Same shape as carrierInvoiceNumberPresentInPrimusEvidence.
 * @return {boolean}
 */
function carrierBillEnteredInPrimusEvidence(args) {
  return carrierInvoiceNumberPresentInPrimusEvidence(args).present === true;
}

module.exports = {
  normalizeCarrierReference,
  carrierInvoiceNumberPresentInPrimusEvidence,
  carrierBillEnteredInPrimusEvidence,
};
