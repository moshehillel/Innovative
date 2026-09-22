/* eslint-disable no-console */
"use strict";

const invoiceLoadEntry = require("../invoice-load-entry");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

check("amount match applies manual load",
    invoiceLoadEntry.shouldUseLisaManualLoad({
      manualLoad: "267736",
      itemIndex: 2,
      manualItemIndex: 0,
      aiResult: {invoiceAmount: 1288.09, loadNumber: ""},
      pendingAmount: 1288.09,
    }) === true);

check("index match applies when no amount",
    invoiceLoadEntry.shouldUseLisaManualLoad({
      manualLoad: "267736",
      itemIndex: 0,
      manualItemIndex: 0,
      aiResult: {invoiceAmount: 1288.09, loadNumber: ""},
      pendingAmount: null,
    }) === true);

check("does not override existing load",
    invoiceLoadEntry.shouldUseLisaManualLoad({
      manualLoad: "267736",
      itemIndex: 0,
      manualItemIndex: 0,
      aiResult: {invoiceAmount: 1288.09, loadNumber: "267480"},
      pendingAmount: 1288.09,
    }) === false);

check("wrong amount and wrong index skipped",
    invoiceLoadEntry.shouldUseLisaManualLoad({
      manualLoad: "267736",
      itemIndex: 1,
      manualItemIndex: 0,
      aiResult: {invoiceAmount: 389.23, loadNumber: ""},
      pendingAmount: 1288.09,
    }) === false);

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("All Lisa manual-load match checks passed.");
