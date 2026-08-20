/**
 * Quote mail queue — discover quote RFQs from dispatcher Outlook, then
 * process them separately from Jerry's invoice gmailQueue.
 */

"use strict";

const admin = require("firebase-admin");

const QUEUE_STATUS = Object.freeze({
  QUEUED: "queued",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
});

/**
 * @param {string} dispatcherId Dispatcher id.
 * @param {string} outlookMessageId Outlook message id.
 * @return {string}
 */
function queueDocId(dispatcherId, outlookMessageId) {
  return `outlook_${String(dispatcherId)}_${String(outlookMessageId)}`;
}

/**
 * @param {Function} tcol Tenant collection helper.
 * @param {object} tenant Tenant.
 * @return {FirebaseFirestore.CollectionReference}
 */
function queueCol(tcol, tenant) {
  return tcol(tenant, "quoteMailQueue");
}

/**
 * @param {number} [days=30] TTL days.
 * @return {FirebaseFirestore.Timestamp}
 */
function deleteAt(days) {
  const ms = Date.now() + Number(days || 30) * 24 * 60 * 60 * 1000;
  return admin.firestore.Timestamp.fromDate(new Date(ms));
}

/**
 * Enqueue a Luna-classified quote email for processing.
 * @param {object} opts tcol, tenant, dispatcher, message fields.
 * @return {Promise<object>} {ok, docId, reason?}
 */
async function enqueueQuoteEmail(opts) {
  const tcol = opts.tcol;
  const tenant = opts.tenant;
  const dispatcher = opts.dispatcher || {};
  const outlookMessageId = String(opts.outlookMessageId || "");
  const dispatcherId = String(dispatcher.id || opts.dispatcherId || "");
  if (!outlookMessageId || !dispatcherId) {
    return {ok: false, reason: "missing_ids"};
  }

  const docId = queueDocId(dispatcherId, outlookMessageId);
  const ref = queueCol(tcol, tenant).doc(docId);
  const snap = await ref.get();
  if (snap.exists) {
    const prev = snap.data() || {};
    const status = String(prev.status || "");
    if (status === QUEUE_STATUS.QUEUED ||
      status === QUEUE_STATUS.PROCESSING ||
      status === QUEUE_STATUS.COMPLETED) {
      return {ok: false, reason: "already_queued", docId};
    }
    if (status === QUEUE_STATUS.FAILED && !opts.forceReprocess) {
      // Allow re-enqueue of failed jobs when forceReprocess is set.
      return {ok: false, reason: "already_failed", docId};
    }
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const payload = {
    docId,
    source: "dispatcher_outlook",
    tenantId: tenant.tenantId,
    dispatcherId,
    dispatcherEmail: dispatcher.email || null,
    outlookMessageId,
    subject: String(opts.subject || "").slice(0, 500),
    from: String(opts.from || "").slice(0, 500),
    to: String(opts.to || "").slice(0, 1000),
    cc: String(opts.cc || "").slice(0, 1000),
    emailBody: String(opts.emailBody || "").slice(0, 50000),
    receivedMailboxEmail: opts.receivedMailboxEmail ||
      dispatcher.outlookConnectedEmail || dispatcher.email || null,
    classify: opts.classify || null,
    status: QUEUE_STATUS.QUEUED,
    quoteId: null,
    error: null,
    discoveredAt: now,
    createdAt: snap.exists && snap.data().createdAt ?
      snap.data().createdAt : now,
    updatedAt: now,
    deleteAt: deleteAt(30),
  };

  await ref.set(payload, {merge: true});
  return {ok: true, docId};
}

/**
 * List queued jobs for a dispatcher (oldest first).
 * @param {Function} tcol Tenant collection helper.
 * @param {object} tenant Tenant.
 * @param {string} dispatcherId Dispatcher id.
 * @param {number} [limit=10] Max docs.
 * @return {Promise<Array<object>>}
 */
async function listQueuedForDispatcher(tcol, tenant, dispatcherId, limit) {
  const max = Math.max(1, Math.min(Number(limit) || 10, 25));
  // Single-field query avoids a composite index requirement.
  const snap = await queueCol(tcol, tenant)
      .where("dispatcherId", "==", String(dispatcherId))
      .limit(Math.max(max * 5, 40))
      .get();
  return snap.docs
      .map((d) => ({id: d.id, ...d.data()}))
      .filter((d) => d.status === QUEUE_STATUS.QUEUED)
      .slice(0, max);
}

/**
 * Claim a queued job for processing.
 * @param {Function} tcol Tenant collection helper.
 * @param {object} tenant Tenant.
 * @param {string} docId Queue doc id.
 * @return {Promise<object|null>} Claimed data or null if not claimable.
 */
async function claimQueuedJob(tcol, tenant, docId) {
  const ref = queueCol(tcol, tenant).doc(String(docId));
  return admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data() || {};
    if (data.status !== QUEUE_STATUS.QUEUED &&
      data.status !== QUEUE_STATUS.FAILED) {
      return null;
    }
    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.set(ref, {
      status: QUEUE_STATUS.PROCESSING,
      claimedAt: now,
      processingStartedAt: now,
      updatedAt: now,
      error: null,
    }, {merge: true});
    return {id: snap.id, ...data, status: QUEUE_STATUS.PROCESSING};
  });
}

/**
 * Mark queue job completed after processQuoteEmail.
 * @param {Function} tcol Tenant collection helper.
 * @param {object} tenant Tenant.
 * @param {string} docId Queue doc id.
 * @param {object} extra quoteId, finalStatus, etc.
 * @return {Promise<void>}
 */
async function completeQueuedJob(tcol, tenant, docId, extra = {}) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  await queueCol(tcol, tenant).doc(String(docId)).set({
    status: QUEUE_STATUS.COMPLETED,
    quoteId: extra.quoteId || null,
    finalStatus: extra.finalStatus || "quote_processed",
    finishedAt: now,
    updatedAt: now,
    error: null,
  }, {merge: true});
}

/**
 * Mark queue job failed.
 * @param {Function} tcol Tenant collection helper.
 * @param {object} tenant Tenant.
 * @param {string} docId Queue doc id.
 * @param {string} error Error message.
 * @return {Promise<void>}
 */
async function failQueuedJob(tcol, tenant, docId, error) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  await queueCol(tcol, tenant).doc(String(docId)).set({
    status: QUEUE_STATUS.FAILED,
    error: String(error || "").slice(0, 1000),
    finishedAt: now,
    updatedAt: now,
  }, {merge: true});
}

module.exports = {
  QUEUE_STATUS,
  queueDocId,
  enqueueQuoteEmail,
  listQueuedForDispatcher,
  claimQueuedJob,
  completeQueuedJob,
  failQueuedJob,
};
