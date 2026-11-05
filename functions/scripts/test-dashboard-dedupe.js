/**
 * Pure tests for exact duplicate task/notification collapsing.
 * Run: node scripts/test-dashboard-dedupe.js
 */
"use strict";

const assert = require("assert");
const dedupe = require("../dashboard-dedupe");

const base = {
  type: "additional_charge",
  loadNumber: "265879",
  reason: "weight_inspection",
  chargesTotal: 440,
  carrierName: "A. Duie Pyle, Inc.",
};

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

check("three identical charges collapse to the newest", () => {
  const items = [
    {...base, id: "old", createdAt: "2026-09-16T22:10:13.743Z"},
    {...base, id: "mid", createdAt: "2026-09-16T22:40:10.898Z"},
    {...base, id: "new", createdAt: "2026-09-16T22:50:08.219Z"},
  ];
  const out = dedupe.collapseExactDuplicateItems(items);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, "new");
});

check("equal received time keeps the later logged copy", () => {
  const items = [
    {
      ...base,
      id: "older-log",
      createdAt: "2026-09-16T22:10:13.743Z",
      receivedAt: "2026-09-16T22:10:00.000Z",
    },
    {
      ...base,
      id: "newer-log",
      createdAt: "2026-10-05T22:50:08.713Z",
      receivedAt: "2026-09-16T22:10:00.000Z",
    },
  ];
  const out = dedupe.collapseExactDuplicateItems(items);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, "newer-log");
});

check("receivedAt beats an older createdAt", () => {
  const items = [
    {
      ...base,
      id: "logged-later",
      createdAt: "2026-10-05T22:50:08.713Z",
      receivedAt: "2026-09-16T22:10:00.000Z",
    },
    {
      ...base,
      id: "mail-later",
      createdAt: "2026-09-16T22:10:13.743Z",
      receivedAt: "2026-09-16T22:50:00.000Z",
    },
  ];
  const out = dedupe.collapseExactDuplicateItems(items);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, "mail-later");
});

check("different amount stays", () => {
  const items = [
    {...base, id: "a", chargesTotal: 440, createdAt: "2026-10-05T22:50:08.713Z"},
    {...base, id: "b", chargesTotal: 515, createdAt: "2026-08-20T20:20:32.927Z"},
  ];
  const out = dedupe.collapseExactDuplicateItems(items);
  assert.strictEqual(out.length, 2);
});

check("different reason stays", () => {
  const items = [
    {...base, id: "a", reason: "weight_inspection"},
    {...base, id: "b", reason: "lumper", chargesTotal: 440},
  ];
  const out = dedupe.collapseExactDuplicateItems(items);
  assert.strictEqual(out.length, 2);
});

check("missing amount is not merged with a known amount", () => {
  const items = [
    {...base, id: "known", chargesTotal: 440},
    {...base, id: "unknown", chargesTotal: null},
  ];
  const out = dedupe.collapseExactDuplicateItems(items);
  assert.strictEqual(out.length, 2);
});

check("one cent tolerance matches and two cents do not", () => {
  assert.strictEqual(dedupe.amountsWithinTolerance(440, 440.01), true);
  assert.strictEqual(dedupe.amountsWithinTolerance(440, 440.02), false);
  const within = dedupe.collapseExactDuplicateItems([
    {...base, id: "a", chargesTotal: 440},
    {...base, id: "b", chargesTotal: 440.01},
  ]);
  assert.strictEqual(within.length, 1);
  const apart = dedupe.collapseExactDuplicateItems([
    {...base, id: "a", chargesTotal: 440},
    {...base, id: "b", chargesTotal: 440.02},
  ]);
  assert.strictEqual(apart.length, 2);
});

check("same message id collapses even without an amount", () => {
  const items = [
    {
      type: "additional_charge",
      id: "a",
      loadNumber: "265879",
      messageId: "msg-1",
      chargesTotal: null,
      createdAt: "2026-09-16T22:10:00.000Z",
    },
    {
      type: "additional_charge",
      id: "b",
      loadNumber: "265879",
      messageId: "msg-1",
      chargesTotal: null,
      createdAt: "2026-09-16T22:50:00.000Z",
    },
  ];
  const out = dedupe.collapseExactDuplicateItems(items);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, "b");
});

check("same follow-up id collapses", () => {
  const items = [
    {...base, id: "task", followUpId: "fu-1", source: "dashboardTasks"},
    {
      ...base,
      id: "fu-1",
      followUpId: "fu-1",
      source: "additionalCharges",
      chargesTotal: null,
    },
  ];
  const out = dedupe.collapseExactDuplicateItems(items);
  assert.strictEqual(out.length, 1);
});

check("an in-dispute copy beats a newer duplicate", () => {
  const items = [
    {...base, id: "new", createdAt: "2026-10-05T22:50:08.713Z"},
    {
      ...base,
      id: "dispute",
      createdAt: "2026-09-16T22:10:13.743Z",
      chargePhase: "dispute",
    },
  ];
  const out = dedupe.collapseExactDuplicateItems(items);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, "dispute");
});

check("dismiss plan keeps one and lists the rest", () => {
  const items = [
    {...base, id: "a", createdAt: "2026-09-16T22:10:13.743Z"},
    {...base, id: "b", createdAt: "2026-09-16T22:40:10.898Z"},
    {...base, id: "c", createdAt: "2026-09-16T22:50:08.219Z"},
    {...base, id: "other", chargesTotal: 515, createdAt: "2026-08-20T20:20:32.927Z"},
  ];
  const plan = dedupe.selectDuplicateDismissals(items);
  const dismissIds = plan.dismiss.map((item) => item.id).sort();
  assert.deepStrictEqual(dismissIds, ["a", "b"]);
  assert.ok(plan.keep.some((item) => item.id === "c"));
  assert.ok(plan.keep.some((item) => item.id === "other"));
});

check("reason spacing does not split the same charge", () => {
  const items = [
    {...base, id: "a", reason: "Weight Inspection"},
    {...base, id: "b", reason: "weight  inspection"},
  ];
  const out = dedupe.collapseExactDuplicateItems(items);
  assert.strictEqual(out.length, 1);
});

console.log(`\n${passed} passed`);
