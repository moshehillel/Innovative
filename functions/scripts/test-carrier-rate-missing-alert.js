#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Unit tests for missing-carrier-rate alerts (dispatcher always CC'd).
 * Run: node scripts/test-carrier-rate-missing-alert.js
 */
const alert = require("../carrier-rate-missing-alert");

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}` +
    (ok ? "" : ` got=${JSON.stringify(actual)} exp=${JSON.stringify(expected)}`));
};

check("detects Primus no-cost error",
    alert.isMissingCarrierCostResult({
      ok: false,
      validAmount: false,
      error: "No carrier cost on Primus record",
    }), true);

check("detects TAI no-cost error",
    alert.isMissingCarrierCostResult({
      ok: false,
      error: "No carrier cost on TAI shipment",
    }), true);

check("ignores normal amount mismatch",
    alert.isMissingCarrierCostResult({
      ok: true,
      validAmount: false,
      amount: 500,
      reason: "Submitted $600 vs Primus $500",
    }), false);

check("ignores not-found",
    alert.isMissingCarrierCostResult({
      ok: false,
      reason: "Load not found in Primus",
    }), false);

check("ignores null",
    alert.isMissingCarrierCostResult(null), false);

const built = alert.buildMissingCarrierRateAlert({
  loadNumber: "268391",
  carrierName: "AAA Cooper",
  invoiceAmount: 786.05,
  emailBody: "body",
  dispatcherEmail: "mike@innovativecarriers.com",
});
check("kind is missing_carrier_rate", built.kind, "missing_carrier_rate");
check("reason mentions rate not entered",
    /rate is not entered/i.test(built.reason), true);
check("notes ask to enter carrier rate",
    /enter the carrier rate/i.test(built.notes), true);
check("notes include invoice amount",
    built.notes.includes("$786.05"), true);
check("extracted Primus cost says not entered",
    built.options.extractedData["Primus Carrier Cost"], "Not entered");
check("options.cc is dispatcher",
    built.options.cc, "mike@innovativecarriers.com");
check("expectedAmount is null", built.expectedAmount, null);
check("department is billing", built.options.department, "billing");

const noDisp = alert.buildMissingCarrierRateAlert({
  loadNumber: "1",
  invoiceAmount: 10,
});
check("no dispatcher → no cc field",
    noDisp.options.cc === undefined, true);

check("merge adds dispatcher",
    alert.mergeDispatcherCc(undefined, "d@x.com", "billing@x.com"),
    "d@x.com");
check("merge keeps existing + dispatcher",
    alert.mergeDispatcherCc("lisa@x.com", "d@x.com", "billing@x.com"),
    "lisa@x.com, d@x.com");
check("merge skips duplicate",
    alert.mergeDispatcherCc("d@x.com", "D@x.com", "billing@x.com"),
    "d@x.com");
check("merge skips when dispatcher is To",
    alert.mergeDispatcherCc(undefined, "billing@x.com", "billing@x.com"),
    undefined);

const applied = alert.applyDispatcherCcToDeferredAlert(
    built, "new-disp@innovativecarriers.com", "Lisa@innovativecarriers.com");
check("apply keeps kind", applied.kind, "missing_carrier_rate");
check("apply merges new dispatcher",
    applied.options.cc.includes("new-disp@innovativecarriers.com") &&
    applied.options.cc.includes("mike@innovativecarriers.com"), true);

const skipped = alert.applyDispatcherCcToDeferredAlert(
    {kind: "primus", options: {}}, "d@x.com");
check("apply ignores non-missing-rate kinds",
    skipped.options.cc === undefined, true);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll carrier-rate-missing alert checks passed.");
