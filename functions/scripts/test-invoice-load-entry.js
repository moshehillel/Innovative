/* eslint-disable no-console */
"use strict";

const loadEntry = require("../invoice-load-entry");

let failures = 0;
const check = (name, got, exp) => {
  const pass = got === exp;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) {
    console.log(`  got: ${JSON.stringify(got)}`);
    console.log(`  exp: ${JSON.stringify(exp)}`);
  }
};

check("regular missing load offers Lisa entry",
    loadEntry.shouldOfferLisaLoadEntry(
        {invoiceAmount: 500, carrierName: "XPO"}, true),
    true);
check("Mark Evans name alone does not skip Lisa entry",
    loadEntry.shouldOfferLisaLoadEntry(
        {invoiceAmount: 500, carrierName: "Mark Evans Delivery"}, true),
    true);
check("container number alone does not skip Lisa entry",
    loadEntry.shouldOfferLisaLoadEntry(
        {invoiceAmount: 500, carrierName: "Averitt Express",
          containerNumber: "AVRT1467163"}, true),
    true);
check("Primus drayage vendor type skips Lisa entry",
    loadEntry.shouldOfferLisaLoadEntry(
        {invoiceAmount: 500, drayageByVendorType: true}, true),
    false);
check("Leo-validated drayage skips Lisa entry",
    loadEntry.shouldOfferLisaLoadEntry(
        {invoiceAmount: 500, drayageLeoValidated: true}, true),
    false);
check("load ok skips Lisa entry",
    loadEntry.shouldOfferLisaLoadEntry({invoiceAmount: 500}, false),
    false);
check("normalize 6-digit", loadEntry.normalizeManualLoadNumber("265551"),
    "265551");
check("normalize 5-digit leading 2",
    loadEntry.normalizeManualLoadNumber("65551"), "265551");
check("invalid load rejected",
    loadEntry.normalizeManualLoadNumber("abc"), null);

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nAll invoice load entry tests passed");
