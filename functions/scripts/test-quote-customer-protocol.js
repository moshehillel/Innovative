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

test("partial distinctive line already present still appends full protocol", () => {
  const partial =
    "FREIGHT ALWAYS READY, NO NEED TO RECONFIRM — confirmed with WH";
  const out = rateShop.mergeProtocolRemarksIntoInstructions(
      partial, SANDERS_REMARKS);
  assert.ok(out.includes(partial));
  assert.ok(out.includes("DO NOT USE XPO"));
  assert.ok(out.includes("WAREHOUSE MGR- TOMMY"));
});

test("isFedExRateRow detects common FedEx labels", () => {
  assert.strictEqual(rateShop.isFedExRateRow({name: "FedEx Freight"}), true);
  assert.strictEqual(rateShop.isFedExRateRow({SCAC: "FXFE"}), true);
  assert.strictEqual(rateShop.isFedExRateRow({name: "XPO"}), false);
});

test("ensureFedExInOptions restores Economy/Priority cut by top-N", () => {
  const cheap = [];
  for (let i = 0; i < 20; i++) {
    cheap.push({
      id: `c${i}`, name: `Carrier ${i}`, SCAC: `C${i}`,
      total: 100 + i, sellRate: 110 + i,
    });
  }
  const economy = {
    id: "fxnl", name: "FEDEX FREIGHT ECONOMY", SCAC: "FXNL",
    total: 635, sellRate: 691,
  };
  const priority = {
    id: "fxfe", name: "FEDEX FREIGHT PRIORITY", SCAC: "FXFE",
    total: 713, sellRate: 769,
  };
  const ji = {
    id: "fxji", name: "FedEx J&I ECONOMY", SCAC: "FXFE",
    total: 900, sellRate: 1010,
  };
  const all = [...cheap, economy, priority, ji];
  const top = rateShop.pickTopOptions(all, 20, {mode: "cheapest"});
  assert.strictEqual(top.some((r) => rateShop.isFedExRateRow(r)), false);
  const ensured = rateShop.ensureFedExInOptions(top, all, {maxAdd: 2});
  assert.ok(ensured.some((r) => r.SCAC === "FXNL"));
  assert.ok(ensured.some((r) =>
    r.SCAC === "FXFE" && /PRIORITY/i.test(r.name)));
  assert.strictEqual(
      ensured.some((r) => /J&I/i.test(r.name)), false);
  assert.ok(ensured.length >= 21);
});

test("isPreferredFedExRateRow skips Spot and J&I tags", () => {
  assert.strictEqual(rateShop.isPreferredFedExRateRow({
    name: "FEDEX FREIGHT ECONOMY", SCAC: "FXNL",
  }), true);
  assert.strictEqual(rateShop.isPreferredFedExRateRow({
    name: "FedEx Freight Spot", SCAC: "FXFE",
  }), false);
  assert.strictEqual(rateShop.isPreferredFedExRateRow({
    name: "FedEx J&I ECONOMY", SCAC: "FXFE",
  }), false);
});

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll customer-protocol merge tests passed.");
