#!/usr/bin/env node
/**
 * Regression: CSV report includes completed quotes by default,
 * and completed rows date-filter on completedAt.
 * Usage: node scripts/test-quote-dispatcher-report.js
 */
"use strict";

const assert = require("assert");
const quoteAutomation = require("../quote-automation");

let passed = 0;
let failed = 0;

/**
 * @param {string} label Test name.
 * @param {Function} fn Assertion body.
 * @return {void}
 */
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${label}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${label}`);
    console.error(`  ${err.message}`);
  }
}

check("default statuses include completed", () => {
  assert.deepStrictEqual(
      quoteAutomation.REPORT_DEFAULT_STATUSES,
      ["draft_ready", "sent", "completed"]);
});

check("completed anchor prefers completedAt", () => {
  const completedAt = new Date("2026-09-08T12:00:00Z");
  const createdAt = new Date("2026-07-01T12:00:00Z");
  const sentAt = new Date("2026-07-02T12:00:00Z");
  const got = quoteAutomation.reportAnchorDate("completed", {
    completedAt, createdAt, sentAt,
  });
  assert.strictEqual(got.toISOString(), completedAt.toISOString());
});

check("completed falls back to sentAt then createdAt", () => {
  const createdAt = new Date("2026-07-01T12:00:00Z");
  const sentAt = new Date("2026-07-02T12:00:00Z");
  const viaSent = quoteAutomation.reportAnchorDate("completed", {
    createdAt, sentAt,
  });
  assert.strictEqual(viaSent.toISOString(), sentAt.toISOString());
  const viaCreated = quoteAutomation.reportAnchorDate("completed", {
    createdAt,
  });
  assert.strictEqual(viaCreated.toISOString(), createdAt.toISOString());
});

check("sent anchor uses sentAt", () => {
  const createdAt = new Date("2026-07-01T12:00:00Z");
  const sentAt = new Date("2026-07-02T12:00:00Z");
  const got = quoteAutomation.reportAnchorDate("sent", {createdAt, sentAt});
  assert.strictEqual(got.toISOString(), sentAt.toISOString());
});

check("draft_ready anchor uses createdAt", () => {
  const createdAt = new Date("2026-07-01T12:00:00Z");
  const got = quoteAutomation.reportAnchorDate("draft_ready", {createdAt});
  assert.strictEqual(got.toISOString(), createdAt.toISOString());
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
