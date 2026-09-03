/* eslint-disable no-console */
"use strict";

const verify = require("../carrier-invoice-primus-verify");

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}` +
    (ok ? "" : ` got=${JSON.stringify(actual)} exp=${JSON.stringify(expected)}`));
};

check("carrierRef match",
    verify.carrierInvoiceNumberPresentInPrimusEvidence({
      carrierInvoiceNumber: "689094959",
      carrierRef: "689094959",
    }).present, true);

check("vendorInvoiceNumber on REST invoice row",
    verify.carrierInvoiceNumberPresentInPrimusEvidence({
      carrierInvoiceNumber: "OTR-24633649",
      invoices: [{vendorInvoiceNumber: "OTR-24633649"}],
    }).present, true);

check("actual cost line vendorInvoiceNumber",
    verify.carrierInvoiceNumberPresentInPrimusEvidence({
      carrierInvoiceNumber: "7826",
      actualCosts: [{vendorInvoiceNumber: "7826", carrierId: "1"}],
    }).present, true);

check("PDF file type alone is NOT entered",
    verify.carrierBillEnteredInPrimusEvidence({
      carrierInvoiceNumber: "688914393",
      hasCarrierBillFileType: true,
      invoices: [{status: {generated: true}}],
    }), false);

check("PDF + empty vendor fields is NOT present",
    verify.carrierInvoiceNumberPresentInPrimusEvidence({
      carrierInvoiceNumber: "688914393",
      hasCarrierBillFileType: true,
      invoices: [{vendorInvoiceNumber: "", status: {generated: true}}],
    }).present, false);

check("normalize strips dashes",
    verify.normalizeCarrierReference("OTR-24633649"),
    "otr24633649");

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("All carrier invoice number verify checks passed.");
