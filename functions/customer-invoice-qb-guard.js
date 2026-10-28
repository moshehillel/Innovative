"use strict";

const admin = require("firebase-admin");

const COLLECTION = "customerInvoiceQbPosts";
const POSTING_WINDOW_MS = 10 * 60 * 1000;

/**
 * @param {*} value Invoice number.
 * @return {string} Blank when missing or the unissued placeholder.
 */
function normalizeInvoiceNumber(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text || text === "0") return "";
  return text;
}

/**
 * One QuickBooks post per printed invoice number.
 * @param {object} args Invoice identity.
 * @return {string} Firestore document id, or blank.
 */
function postDocId(args) {
  const num = normalizeInvoiceNumber(args && args.invoiceNumber);
  if (num) return "num-" + num;
  const id = String((args && args.customerInvoiceId) || "").trim();
  if (!id || id === "0") return "";
  return "id-" + id;
}

/**
 * @param {*} claimedAt Firestore timestamp, Date, or millis.
 * @return {number}
 */
function claimedMs(claimedAt) {
  if (claimedAt && typeof claimedAt.toDate === "function") {
    return claimedAt.toDate().getTime();
  }
  if (claimedAt instanceof Date) return claimedAt.getTime();
  if (typeof claimedAt === "number") return claimedAt;
  return 0;
}

/**
 * @param {object|null} record Post record.
 * @param {number} nowMs Clock.
 * @return {boolean}
 */
function isFreshPosting(record, nowMs) {
  const ms = Number(record && record.claimedAtMs) ||
    claimedMs(record && record.claimedAt);
  if (!ms) return false;
  return (nowMs - ms) < POSTING_WINDOW_MS;
}

/**
 * A second post of the same invoice number does nothing.
 * A stale claim can be taken over after the window.
 * @param {object|null} record Existing post record.
 * @param {number} nowMs Clock.
 * @return {object}
 */
function decideQuickBooksPost(record, nowMs) {
  const status = record && record.status;
  if (status === "posted") {
    return {skip: true, reason: "qb_already_posted"};
  }
  if (status === "posting" && isFreshPosting(record, nowMs)) {
    return {skip: true, reason: "qb_post_in_progress"};
  }
  return {skip: false, reason: null};
}

/**
 * @param {object} args Invoice identity.
 * @return {object}
 */
function identityFields(args) {
  return {
    customerInvoiceId: String(args.customerInvoiceId || ""),
    invoiceNumber: normalizeInvoiceNumber(args.invoiceNumber),
    loadNumber: args.loadNumber || null,
    sourceInvoiceId: args.sourceInvoiceId || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

/**
 * Records that an already-issued invoice must not be posted.
 * Does not overwrite a post that is in progress or finished.
 * @param {FirebaseFirestore.Firestore} db Firestore.
 * @param {object} args Invoice identity.
 * @return {Promise<void>}
 */
async function recordSkippedAlreadyIssued(db, args) {
  const id = postDocId(args);
  if (!db || !id) return;
  const ref = db.collection(COLLECTION).doc(id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? (snap.data() || {}) : null;
    const status = data && data.status;
    if (status === "posted" || status === "posting") return;
    tx.set(ref, Object.assign(identityFields(args), {
      status: "skipped_already_issued",
    }), {merge: true});
  });
}

/**
 * Atomically claims the only QuickBooks post for this invoice number.
 * @param {FirebaseFirestore.Firestore} db Firestore.
 * @param {object} args Invoice identity.
 * @return {Promise<object>}
 */
async function claimQuickBooksPost(db, args) {
  const id = postDocId(args);
  if (!db || !id) return {skip: false, claim: null};
  const ref = db.collection(COLLECTION).doc(id);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? (snap.data() || {}) : null;
    const decision = decideQuickBooksPost(data, Date.now());
    if (decision.skip) return decision;
    tx.set(ref, Object.assign(identityFields(args), {
      status: "posting",
      claimedAt: admin.firestore.FieldValue.serverTimestamp(),
      claimedAtMs: Date.now(),
    }), {merge: true});
    return {skip: false};
  });
  if (result.skip) {
    return {skip: true, reason: result.reason, claim: null};
  }
  return {
    skip: false,
    claim: {
      ref,
      customerInvoiceId: String(args.customerInvoiceId || ""),
    },
  };
}

/**
 * @param {object} claim Claim returned by claimQuickBooksPost.
 * @param {string} status posted or failed.
 * @return {Promise<void>}
 */
async function finishQuickBooksPost(claim, status) {
  if (!claim || !claim.ref) return;
  const next = status === "posted" ? "posted" : "failed";
  await claim.ref.set({
    status: next,
    customerInvoiceId: claim.customerInvoiceId || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
}

module.exports = {
  decideQuickBooksPost,
  claimQuickBooksPost,
  finishQuickBooksPost,
  recordSkippedAlreadyIssued,
  postDocId,
  isFreshPosting,
};
