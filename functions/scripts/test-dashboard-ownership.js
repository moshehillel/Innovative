/**
 * Tenant boundary and missing-rate ownership.
 * Run: node scripts/test-dashboard-ownership.js
 */
"use strict";

const assert = require("assert");
const ownership = require("../dashboard-ownership");

let passed = 0;

/**
 * @param {string} name Test name.
 * @param {Function} fn Assertion.
 */
function check(name, fn) {
  fn();
  passed++;
  console.log("ok", name);
}

check("missing tenant id belongs only to the default tenant", () => {
  assert.strictEqual(ownership.sameTenant(null, "default"), true);
  assert.strictEqual(ownership.sameTenant("", "default"), true);
  assert.strictEqual(ownership.sameTenant(undefined, "acme"), false);
  assert.strictEqual(ownership.sameTenant("acme", "default"), false);
  assert.strictEqual(ownership.sameTenant("acme", "acme"), true);
});

check("missing carrier rate is dispatch even when accounting is CC'd", () => {
  const owner = ownership.classifyDashboardOwner({
    type: "missing_rate",
    to: "dispatcher@innovativecarriers.com",
    cc: "Lisa@innovativecarriers.com",
    dispatcherEmail: "dispatcher@innovativecarriers.com",
    dispatcherName: "Alex Dispatcher",
    ownerBucket: "accounting",
  });
  assert.strictEqual(owner.ownerBucket, "dispatch");
  assert.strictEqual(owner.awaitingReplyFrom, "dispatch");
  assert.strictEqual(owner.dispatcherKey, "dispatcher@innovativecarriers.com");
  assert.strictEqual(owner.dispatcherName, "Alex Dispatcher");
});

check("missing rate without a dispatcher stays on dispatch, not Sarah", () => {
  const owner = ownership.classifyDashboardOwner({
    type: "rate_missing",
    to: "Sarah@innovativecarriers.com",
    cc: "accounting@innovativecarriers.com",
  });
  assert.strictEqual(owner.ownerBucket, "dispatch");
  assert.strictEqual(owner.dispatcherKey, null);
});

check("additional charges still route to Sarah", () => {
  const owner = ownership.classifyDashboardOwner({
    type: "additional_charge",
    to: "Sarah@innovativecarriers.com",
  });
  assert.strictEqual(owner.ownerBucket, "sarah");
});

check("accounting recipients stay accounting", () => {
  const owner = ownership.classifyDashboardOwner({
    type: "pod_discrepancy",
    to: "Lisa@innovativecarriers.com",
  });
  assert.strictEqual(owner.ownerBucket, "accounting");
});

check("missing rate hold is not a low-margin hold", () => {
  assert.strictEqual(ownership.isMissingCarrierRateHold({
    decisionStage: "needs_customer_rate_review",
    decisionReason: "Missing customer rate",
    customerRate: 0,
  }), true);
  assert.strictEqual(ownership.isMissingCarrierRateHold({
    decisionStage: "needs_customer_rate_review",
    decisionReason: "Customer rate too low",
    customerRate: 50,
  }), false);
  assert.strictEqual(ownership.isMissingCarrierRateHold({
    decisionStage: "additional_charge_pending_approval",
    decisionReason: "Missing customer rate",
  }), false);
});

console.log(passed + " passed");
