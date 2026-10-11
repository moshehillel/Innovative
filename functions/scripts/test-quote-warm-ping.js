#!/usr/bin/env node
/**
 * GET ?warm=1 with no quote id returns 200 before auth and does not mutate.
 * Usage: node scripts/test-quote-warm-ping.js
 */
"use strict";

const assert = require("assert");
const quoteDashboard = require("../quote-dashboard");
const quoteAutomation = require("../quote-automation");

let passed = 0;
let failed = 0;
let dismissCalls = 0;
let completeCalls = 0;
let reviewCalls = 0;

const origDismiss = quoteAutomation.dismissQuote;
const origComplete = quoteAutomation.setQuoteCompleted;
const origReview = quoteAutomation.setQuoteForReview;
quoteAutomation.dismissQuote = async () => {
  dismissCalls++;
  return {ok: true, mutated: true};
};
quoteAutomation.setQuoteCompleted = async () => {
  completeCalls++;
  return {ok: true, mutated: true};
};
quoteAutomation.setQuoteForReview = async () => {
  reviewCalls++;
  return {ok: true, mutated: true};
};

quoteDashboard.init({
  applyDashboardCors: () => false,
  resolveDashboardTenant: async () => ({tenantId: "default"}),
  getTenant: async () => ({tenantId: "default"}),
  writeLog: () => {},
  db: {},
  tcol: () => {
    throw new Error("tcol should not run on a warm ping");
  },
  getPrimusToken: async () => {
    throw new Error("primus should not run on a warm ping");
  },
});

/**
 * @param {string} label Test name.
 * @param {Function} fn Assertion body.
 * @return {Promise<void>}
 */
async function check(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${label}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${label}`);
    console.error(`  ${err.message}`);
  }
}

/**
 * @return {object} Mock response.
 */
function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

/**
 * @param {string} method HTTP method.
 * @param {object} query Query string.
 * @param {object} [body] JSON body.
 * @return {object}
 */
function mockReq(method, query, body) {
  return {
    method,
    query: query || {},
    body: body || {},
    headers: {},
  };
}

const warmHandlers = [
  ["dismissQuote", quoteDashboard.handleDismissQuote],
  ["completeQuote", quoteDashboard.handleCompleteQuote],
  ["generateQuoteEmail", quoteDashboard.handleGenerateQuoteEmail],
  ["getQuoteAccessorialCatalog",
    quoteDashboard.handleGetQuoteAccessorialCatalog],
  ["getQuoteDispatcherData", quoteDashboard.handleGetQuoteDispatcherData],
  ["getQuoteDispatcherInbox", quoteDashboard.handleGetQuoteDispatcherInbox],
  ["getQuoteDispatcherProfile",
    quoteDashboard.handleGetQuoteDispatcherProfile],
  ["markQuoteForReview", quoteDashboard.handleMarkQuoteForReview],
  ["rerunQuoteRates", quoteDashboard.handleRerunQuoteRates],
  ["saveQuoteSelections", quoteDashboard.handleSaveQuoteSelections],
];

/**
 * @return {Promise<void>}
 */
async function main() {
  for (const [name, handler] of warmHandlers) {
    await check(`${name} GET warm=1 returns 200`, async () => {
      const res = mockRes();
      await handler(mockReq("GET", {warm: "1", tenantId: "default"}), res);
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.body, {ok: true, warm: true});
    });
  }

  await check("dismiss POST without auth stays 401", async () => {
    const res = mockRes();
    await quoteDashboard.handleDismissQuote(
        mockReq("POST", {tenantId: "default"}, {quoteId: "q1"}), res);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.ok, false);
  });

  await check("dismiss GET without warm stays 405", async () => {
    const res = mockRes();
    await quoteDashboard.handleDismissQuote(
        mockReq("GET", {tenantId: "default"}), res);
    assert.strictEqual(res.statusCode, 405);
  });

  await check("dismiss GET warm=1 with quote id is not a warm ping",
      async () => {
        const res = mockRes();
        await quoteDashboard.handleDismissQuote(
            mockReq("GET", {warm: "1", quoteId: "q1", tenantId: "default"}),
            res);
        assert.notStrictEqual(res.statusCode, 200);
        assert.notDeepStrictEqual(res.body, {ok: true, warm: true});
      });

  await check("dispatcher data GET without warm and id stays 400",
      async () => {
        const res = mockRes();
        await quoteDashboard.handleGetQuoteDispatcherData(
            mockReq("GET", {tenantId: "default"}), res);
        assert.strictEqual(res.statusCode, 400);
      });

  await check("inbox GET without warm stays 401", async () => {
    const res = mockRes();
    await quoteDashboard.handleGetQuoteDispatcherInbox(
        mockReq("GET", {tenantId: "default"}), res);
    assert.strictEqual(res.statusCode, 401);
  });

  await check("warm pings did not dismiss, complete, or mark", () => {
    assert.strictEqual(dismissCalls, 0);
    assert.strictEqual(completeCalls, 0);
    assert.strictEqual(reviewCalls, 0);
  });

  quoteAutomation.dismissQuote = origDismiss;
  quoteAutomation.setQuoteCompleted = origComplete;
  quoteAutomation.setQuoteForReview = origReview;

  if (failed) {
    console.log(`${failed} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
