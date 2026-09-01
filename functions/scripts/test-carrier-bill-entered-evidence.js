/* eslint-disable no-console */
"use strict";

/**
 * Pure helper mirroring isCarrierBillAlreadyEnteredInPrimus evidence rules.
 */

/**
 * @param {object} args Evidence inputs.
 * @return {boolean} True when THIS carrier invoice appears entered.
 */
function carrierBillEnteredFromEvidence(args) {
  const carrierInvNum = String(args.carrierInvoiceNumber || "").trim();
  const carrierRef = String(args.carrierRef || "").trim();
  const normalize = (v) => String(v || "").replace(/[\s-]/g, "")
      .toLowerCase();

  if (carrierInvNum && carrierRef &&
      normalize(carrierInvNum) === normalize(carrierRef)) {
    return true;
  }
  const invoices = Array.isArray(args.invoices) ? args.invoices : [];
  for (const inv of invoices) {
    const vin = String(
        inv.vendorInvoiceNumber || inv.carrierInvoiceNumber || "",
    ).trim();
    if (carrierInvNum && vin &&
        normalize(carrierInvNum) === normalize(vin)) {
      return true;
    }
  }
  if (args.hasCarrierBillDocument) return true;
  return false;
}

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}` +
    (ok ? "" : ` got=${actual} exp=${expected}`));
};

check("matches vendor invoice on booking carrierRef",
    carrierBillEnteredFromEvidence({
      carrierInvoiceNumber: "689094959",
      carrierRef: "689094959",
      invoices: [{status: {generated: true}}],
    }), true);

check("matches vendor invoice number on Primus invoice row",
    carrierBillEnteredFromEvidence({
      carrierInvoiceNumber: "OTR-24633649",
      invoices: [{
        vendorInvoiceNumber: "OTR-24633649",
        status: {generated: true},
      }],
    }), true);

check("PRO match alone is NOT carrier bill entered",
    carrierBillEnteredFromEvidence({
      carrierInvoiceNumber: "111",
      proNumber: "696469179",
      bookingPro: "696469179",
      invoices: [],
    }), false);

check("customer invoice generated alone is NOT carrier bill entered",
    carrierBillEnteredFromEvidence({
      carrierInvoiceNumber: "689300632",
      invoices: [{
        vendorInvoiceNumber: "",
        status: {generated: true},
      }],
    }), false);

check("carrier bill document counts",
    carrierBillEnteredFromEvidence({
      carrierInvoiceNumber: "688914393",
      invoices: [{status: {generated: true}}],
      hasCarrierBillDocument: true,
    }), true);

check("booked vendor cost matching invoice amount is NOT bill entered",
    carrierBillEnteredFromEvidence({
      carrierInvoiceNumber: "7826",
      vendorCost: 500,
      invoiceAmount: 500,
      carrierRef: "",
      invoices: [{
        status: {generated: false, actualCosts: false},
      }],
    }), false);

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("All carrier-bill evidence checks passed.");

module.exports = {carrierBillEnteredFromEvidence};
