#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Unit tests for broker-commission no-cost-basis guard
 * (approved-charge invoices must not trigger a 10% swap).
 */
const brokerCommission = require("../broker-commission");

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}` +
    (ok ? "" : ` got=${JSON.stringify(actual)} exp=${JSON.stringify(expected)}`));
};

(async () => {
  const logs = [];
  let swapCalled = false;

  brokerCommission.init({
    writeLog: async (level, cat, msg, data) => {
      logs.push({level, cat, msg, data});
    },
    primusUiBridge: {
      isManagePhpEnabled: () => true,
      fetchAllCorporateSalesPeople: async () => {
        throw new Error("catalog should not load for no_cost_basis");
      },
      getBookingSalesRep: async () => {
        throw new Error("sales rep should not be fetched");
      },
      resolveManageBookingId: () => "1",
      swapBookingSalesRep: async () => {
        swapCalled = true;
        return {ok: true};
      },
    },
  });

  // Reproduce 264422 tiny approved-charge invoice path
  const r1 = await brokerCommission.adjustBrokerCommissionForLowMargin({
    loadNumber: "264422",
    margin: 0,
    profit: 649,
    customerRate: 649,
    carrierCost: 0,
    vendorCost: 0,
    invoiceAmount: 4.06,
    trigger: "pre_billing",
  });
  check("approved-charge invoice → no_cost_basis", r1.reason, "no_cost_basis");
  check("approved-charge invoice → not adjusted", r1.adjusted, false);
  check("approved-charge invoice → swap not called", swapCalled, false);

  const r2 = await brokerCommission.adjustBrokerCommissionForLowMargin({
    loadNumber: "264422",
    margin: 0,
    profit: 649,
    vendorCost: 0,
    trigger: "pre_billing",
  });
  check("vendorCost 0 alone → no_cost_basis", r2.reason, "no_cost_basis");

  const r3 = await brokerCommission.adjustBrokerCommissionForLowMargin({
    loadNumber: "264422",
    margin: 55,
    profit: 356,
    vendorCost: 293,
    trigger: "pre_billing",
  });
  check("healthy margin → margin_ok", r3.reason, "margin_ok");
  check("healthy margin → not adjusted", r3.adjusted, false);

  // Genuine low margin still proceeds past the cost-basis guard
  // (will stop at catalog_failed with our mock)
  const r4 = await brokerCommission.adjustBrokerCommissionForLowMargin({
    loadNumber: "999001",
    margin: 5,
    profit: 20,
    vendorCost: 400,
    trigger: "pre_billing",
  });
  check("real low margin passes cost guard", r4.reason, "catalog_failed");

  // Skip log when no cost basis
  const skipLog = logs.find((l) =>
    l.msg === "Low margin — broker swap skipped (no freight cost basis)");
  check("emits no_cost_basis log", !!skipLog, true);

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
