/* eslint-disable no-console */
"use strict";

/**
 * Evidence rules for isCarrierBillAlreadyEnteredInPrimus (shared verify module).
 */
const verify = require("../carrier-invoice-primus-verify");

function carrierBillEnteredFromEvidence(args) {
  return verify.carrierBillEnteredInPrimusEvidence({
    carrierInvoiceNumber: args.carrierInvoiceNumber,
    carrierRef: args.carrierRef,
    invoices: args.invoices,
    actualCosts: args.actualCosts,
    hasCarrierBillFileType: args.hasCarrierBillDocument ||
      args.hasCarrierBillFileType,
  });
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

check("carrier bill document alone is NOT bill entered",
    carrierBillEnteredFromEvidence({
      carrierInvoiceNumber: "688914393",
      invoices: [{status: {generated: true}}],
      hasCarrierBillDocument: true,
    }), false);

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
