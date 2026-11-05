/**
 * One QuickBooks post per customer invoice number.
 * Run: node scripts/test-customer-invoice-qb-guard.js
 */
"use strict";

const assert = require("assert");
const guard = require("../customer-invoice-qb-guard");

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

/**
 * @return {object} In-memory Firestore.
 */
function fakeDb() {
  const docs = {};
  /**
   * @param {string} id Document id.
   * @return {object}
   */
  function refFor(id) {
    return {
      id,
      get: async () => ({
        exists: Object.prototype.hasOwnProperty.call(docs, id),
        data: () => docs[id],
      }),
      set: async (data) => {
        docs[id] = Object.assign({}, docs[id] || {}, data);
      },
    };
  }
  return {
    docs,
    collection() {
      return {doc: (id) => refFor(id)};
    },
    async runTransaction(fn) {
      return fn({
        get: async (ref) => ref.get(),
        set: (ref, data) => {
          docs[ref.id] = Object.assign({}, docs[ref.id] || {}, data);
        },
      });
    },
  };
}

const now = Date.now();

check("first post is allowed", () => {
  const decision = guard.decideQuickBooksPost(null, now);
  assert.strictEqual(decision.skip, false);
});

check("posted invoice is not posted again", () => {
  const decision = guard.decideQuickBooksPost({status: "posted"}, now);
  assert.strictEqual(decision.skip, true);
  assert.strictEqual(decision.reason, "qb_already_posted");
});

check("fresh claim blocks a parallel post", () => {
  const decision = guard.decideQuickBooksPost({
    status: "posting",
    claimedAtMs: now - 1000,
  }, now);
  assert.strictEqual(decision.skip, true);
  assert.strictEqual(decision.reason, "qb_post_in_progress");
});

check("stale claim can be retried", () => {
  const decision = guard.decideQuickBooksPost({
    status: "posting",
    claimedAtMs: now - (11 * 60 * 1000),
  }, now);
  assert.strictEqual(decision.skip, false);
});

check("doc id is the invoice number", () => {
  assert.strictEqual(guard.postDocId({
    invoiceNumber: "31302",
    customerInvoiceId: "3646445",
  }), "num-31302");
  assert.strictEqual(guard.postDocId({
    invoiceNumber: "0",
    customerInvoiceId: "3646445",
  }), "id-3646445");
});

/**
 * @return {Promise<void>}
 */
async function checkClaimRace() {
  const db = fakeDb();
  const args = {
    customerInvoiceId: "3646445",
    invoiceNumber: "31302",
    loadNumber: "268803",
    sourceInvoiceId: "GYXUz3RZRMEyoNBgGe2R",
  };
  const first = await guard.claimQuickBooksPost(db, args);
  const second = await guard.claimQuickBooksPost(db, args);
  assert.strictEqual(first.skip, false);
  assert.ok(first.claim);
  assert.strictEqual(second.skip, true);
  assert.strictEqual(second.reason, "qb_post_in_progress");
  await guard.finishQuickBooksPost(first.claim, "posted");
  const third = await guard.claimQuickBooksPost(db, args);
  assert.strictEqual(third.skip, true);
  assert.strictEqual(third.reason, "qb_already_posted");
  passed++;
  console.log("ok", "only one QuickBooks claim wins for 31302");
}

/**
 * @return {Promise<void>}
 */
async function checkAlreadyIssuedRecord() {
  const db = fakeDb();
  await guard.recordSkippedAlreadyIssued(db, {
    customerInvoiceId: "3012168",
    invoiceNumber: "17188",
    loadNumber: "253716",
  });
  const row = db.docs["num-17188"];
  assert.strictEqual(row.status, "skipped_already_issued");
  row.status = "posted";
  await guard.recordSkippedAlreadyIssued(db, {
    customerInvoiceId: "3012168",
    invoiceNumber: "17188",
    loadNumber: "253716",
  });
  assert.strictEqual(db.docs["num-17188"].status, "posted");
  passed++;
  console.log("ok", "already-issued skip does not erase a real post");
}

checkClaimRace()
    .then(checkAlreadyIssuedRecord)
    .then(() => {
      console.log(passed + " passed");
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
