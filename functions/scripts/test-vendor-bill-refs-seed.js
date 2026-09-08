/* eslint-disable no-console */
"use strict";

/**
 * Ensures bill-entry payloads always carry the carrier invoice # from email
 * (Moshe: when you enter the bill also add the invoice number).
 */
const bridge = require("../primus-ui-bridge");

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}` +
    (ok ? "" : ` got=${JSON.stringify(actual)} exp=${JSON.stringify(expected)}`));
};

const vendor = {id: "99", name: "Amfast", cost: 100, PRO: "PRO-ONLY"};

const refs = bridge._internal.resolveVendorBillRefs({
  vendorInvoiceNumber: "175128",
  proNumber: "PRO-ONLY",
  loadNumber: "267009",
}, vendor);
check("resolveVendorBillRefs prefers carrier invoice #",
    refs.vendorInvoiceNumber, "175128");
check("resolveVendorBillRefs keeps distinct PRO",
    refs.proNumber, "PRO-ONLY");

const refsFromInvoiceField = bridge._internal.resolveVendorBillRefs({
  invoiceNumber: "175128",
  proNumber: "",
  loadNumber: "267009",
}, vendor);
check("resolveVendorBillRefs accepts invoiceNumber alias",
    refsFromInvoiceField.vendorInvoiceNumber, "175128");

const bill = {
  vendorInvoiceNumber: refs.vendorInvoiceNumber,
  proNumber: refs.proNumber,
  total: 412.5,
  billDate: "2026-09-08",
  billDueDate: "2026-10-08",
};
const billsInfo = bridge._internal.buildBillsInfo(vendor, bill);
check("billsInfo.vendorInvoiceNumber seeded",
    billsInfo.vendorInvoiceNumber, "175128");

const actualCosts = bridge._internal.buildActualCosts(vendor, bill);
check("actualCosts[0].vendorInvoiceNumber seeded",
    actualCosts[0].vendorInvoiceNumber, "175128");
check("actualCosts length >= 1", actualCosts.length >= 1, true);

const fallbackPro = bridge._internal.resolveVendorBillRefs({
  proNumber: "689094959",
  loadNumber: "267009",
}, vendor);
check("missing invoice # falls back to PRO",
    fallbackPro.vendorInvoiceNumber, "689094959");

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("All vendor bill ref seed checks passed.");
