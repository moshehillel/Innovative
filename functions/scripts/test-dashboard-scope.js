"use strict";

const assert = require("assert");
const scope = require("../dashboard-scope");
const ownership = require("../dashboard-ownership");

assert.strictEqual(
    scope.tenantIdForDashboardOrigin("https://innovative-jerry.netlify.app"),
    "default");
assert.strictEqual(
    scope.tenantIdForDashboardOrigin("https://www.advancedautomations.net/"),
    "aa");
assert.strictEqual(
    scope.tenantIdForDashboardOrigin("https://evil.example"),
    false);
assert.strictEqual(scope.tenantIdForDashboardOrigin(""), null);

assert.strictEqual(scope.rowBelongsToTenant({tenantId: "aa"}, "default"), false);
assert.strictEqual(scope.rowBelongsToTenant({tenantId: "default"}, "default"), true);
assert.strictEqual(scope.rowBelongsToTenant({}, "default"), true);
assert.strictEqual(scope.rowBelongsToTenant({}, "aa"), false);

assert.strictEqual(scope.classifyIssue({type: "additional_charge"}), "charge_mismatch");
assert.strictEqual(scope.classifyIssue({
  decisionStage: "missing_pod",
}), "missing_pod");
assert.strictEqual(scope.classifyIssue({
  type: "missing_rate",
  reason: "MISSING_RATE",
}), "missing_rate");
assert.strictEqual(scope.classifyIssue({
  type: "low_margin",
  reason: "Customer rate too low",
}), "miscellaneous");

const owner = ownership.classifyDashboardOwner({
  type: "missing_rate",
  reason: "MISSING_RATE",
  to: "Lisa@innovativecarriers.com",
  dispatcherEmail: "pat@innovativecarriers.com",
  dispatcherName: "Pat",
});
assert.strictEqual(owner.ownerBucket, "dispatch");
assert.strictEqual(owner.dispatcherEmail, "pat@innovativecarriers.com");

const sarah = ownership.classifyDashboardOwner({
  type: "additional_charge",
  to: "Sarah@innovativecarriers.com",
});
assert.strictEqual(sarah.ownerBucket, "sarah");

const merged = scope.mergeQueueItems([
  {
    id: "invoice:1",
    source: "invoice",
    loadNumber: "100",
    issueType: "missing_rate",
    dispatcherEmail: null,
  },
  {
    id: "task1",
    source: "dashboardTasks",
    loadNumber: "100",
    type: "missing_rate",
    issueType: "missing_rate",
    dispatcherEmail: "pat@innovativecarriers.com",
  },
]);
assert.strictEqual(merged.length, 1);
assert.strictEqual(merged[0].id, "task1");
assert.strictEqual(merged[0].dispatcherEmail, "pat@innovativecarriers.com");

assert.strictEqual(scope.dispatcherMatches({
  dispatcherName: "Pat Dispatcher",
  dispatcherEmail: "pat@innovativecarriers.com",
}, "pat@"), true);
assert.strictEqual(scope.dispatcherMatches({
  dispatcherName: "Other",
}, "pat"), false);

assert.strictEqual(scope.isOpenNotification({
  status: "open",
  type: "unhandled_email",
}), true);
assert.strictEqual(scope.isOpenNotification({
  status: "dismissed",
  type: "unhandled_email",
}), false);
assert.strictEqual(scope.isOpenNotification({
  status: "open",
  emailType: "noa_ignored",
}), false);

const recipients = require("../dashboard-notification-digest").digestRecipients(
    {tenantId: "default"},
    [{dispatcherEmail: "pat@innovativecarriers.com"}]);
assert.ok(recipients.some((e) => /lisa@innovativecarriers.com/i.test(e)));
assert.ok(recipients.some((e) => /sarah@innovativecarriers.com/i.test(e)));
assert.ok(recipients.some((e) => /pat@innovativecarriers.com/i.test(e)));

const other = require("../dashboard-notification-digest").digestRecipients(
    {tenantId: "aa", alertEmail: "ops@aa.example"},
    [{dispatcherEmail: "disp@aa.example"}]);
assert.ok(!other.some((e) => /innovativecarriers.com/i.test(e)));
assert.ok(other.includes("ops@aa.example"));
assert.ok(other.includes("disp@aa.example"));

console.log("ok");
