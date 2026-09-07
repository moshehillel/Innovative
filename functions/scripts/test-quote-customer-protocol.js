#!/usr/bin/env node
/**
 * Regression: Primus shipping-location remarks (customer protocol)
 * merge into quote special instructions.
 */
"use strict";

const assert = require("assert");
const rateShop = require("../quote-rate-shop");

const SANDERS_REMARKS =
  "WAREHOUSE MGR- TOMMY (347)675-5894\r\n" +
  "M-TH 0900-1700/ F 0900-1300- IF NEED EXTRA TIME CALL MGR TO ADVISE\r\n" +
  "FREIGHT ALWAYS READY, NO NEED TO RECONFIRM\r\n" +
  "DO NOT USE XPO- TOO MANY RECLASSIFICATIONS";

let failed = 0;

/**
 * @param {string} name
 * @param {Function} fn
 * @return {void}
 */
function test(name, fn) {
  try {
    fn();
    console.log("ok -", name);
  } catch (err) {
    failed += 1;
    console.error("FAIL -", name, err && err.message || err);
  }
}

test("formatShippingLocationRemarks normalizes CRLF", () => {
  const out = rateShop.formatShippingLocationRemarks(SANDERS_REMARKS);
  assert.ok(!out.includes("\r"));
  assert.ok(out.includes("WAREHOUSE MGR- TOMMY"));
  assert.ok(out.includes("DO NOT USE XPO"));
});

test("empty remarks leave instructions unchanged", () => {
  assert.strictEqual(
      rateShop.mergeProtocolRemarksIntoInstructions("Liftgate needed", ""),
      "Liftgate needed");
  assert.strictEqual(
      rateShop.mergeProtocolRemarksIntoInstructions("", null),
      "");
});

test("empty SI gets protocol only", () => {
  const out = rateShop.mergeProtocolRemarksIntoInstructions(
      "", SANDERS_REMARKS);
  assert.ok(out.startsWith("WAREHOUSE MGR- TOMMY"));
  assert.ok(out.includes("DO NOT USE XPO"));
});

test("existing SI appends protocol once", () => {
  const once = rateShop.mergeProtocolRemarksIntoInstructions(
      "Appointment required at delivery.", SANDERS_REMARKS);
  assert.ok(once.includes("Appointment required at delivery."));
  assert.ok(once.includes("DO NOT USE XPO"));
  const twice = rateShop.mergeProtocolRemarksIntoInstructions(
      once, SANDERS_REMARKS);
  assert.strictEqual(twice, once);
});

test("partial distinctive line already present skips re-append", () => {
  const partial =
    "FREIGHT ALWAYS READY, NO NEED TO RECONFIRM — confirmed with WH";
  const out = rateShop.mergeProtocolRemarksIntoInstructions(
      partial, SANDERS_REMARKS);
  assert.strictEqual(out, partial);
});

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll customer-protocol merge tests passed.");
