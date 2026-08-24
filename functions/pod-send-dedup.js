/**
 * POD auto-send deduplication — avoid duplicate Primus POD emails for the
 * same load + recipient within a configurable window.
 */
"use strict";

const admin = require("firebase-admin");

const POD_SEND_LOG_COLLECTION = "podSendLog";
const DEFAULT_DEDUP_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * @return {number} Dedup window in milliseconds.
 */
function getDedupWindowMs() {
  const raw = process.env.POD_SEND_DEDUP_WINDOW_HOURS;
  if (raw != null && raw !== "") {
    const hours = Number(raw);
    if (!isNaN(hours) && hours > 0) {
      return hours * 60 * 60 * 1000;
    }
  }
  return DEFAULT_DEDUP_WINDOW_MS;
}

/**
 * @param {string|null|undefined} email Recipient email.
 * @return {string|null}
 */
function normalizeRecipientEmail(email) {
  const norm = String(email || "").trim().toLowerCase();
  return norm || null;
}

/**
 * @param {string} loadNumber Load / BOL number.
 * @param {string} recipientEmail Recipient email.
 * @return {string|null} Firestore doc id.
 */
function podSendLogDocId(loadNumber, recipientEmail) {
  const load = String(loadNumber || "").trim();
  const email = normalizeRecipientEmail(recipientEmail);
  if (!load || !email) return null;
  return `${load}__${email}`;
}

/**
 * True when Jerry should not auto-send a POD to this address.
 * @param {string|null|undefined} email Recipient email.
 * @return {boolean}
 */
function isBlockedPodRecipient(email) {
  const norm = normalizeRecipientEmail(email);
  if (!norm) return false;
  if (norm === "quickbooks@notification.intuit.com") return true;
  if (/noreply|donotreply|no-reply|do-not-reply/.test(norm)) return true;
  return false;
}

/**
 * @param {object} tenant Tenant config.
 * @param {object} db Firestore instance.
 * @return {FirebaseFirestore.CollectionReference}
 */
function podSendLogCollection(tenant, db) {
  const prefix = tenant && tenant.collectionPrefix;
  const name = prefix ?
    `${prefix}_${POD_SEND_LOG_COLLECTION}` : POD_SEND_LOG_COLLECTION;
  return db.collection(name);
}

/**
 * @param {object|null} sentAt Firestore Timestamp or Date-like value.
 * @param {number} [nowMs] Current time for tests.
 * @return {number|null}
 */
function sentAtToMs(sentAt, nowMs) {
  if (!sentAt) return null;
  if (typeof sentAt.toMillis === "function") return sentAt.toMillis();
  const ms = new Date(sentAt).getTime();
  return isNaN(ms) ? null : ms;
}

/**
 * @param {object|null} record Stored send record.
 * @param {number} [nowMs] Current time for tests.
 * @return {boolean}
 */
function isRecentPodSend(record, nowMs) {
  if (!record) return false;
  const sentMs = sentAtToMs(record.sentAt, nowMs);
  if (sentMs == null) return false;
  const now = nowMs != null ? nowMs : Date.now();
  return now - sentMs <= getDedupWindowMs();
}

/**
 * Returns a recent POD send for load + recipient, or null.
 * @param {object} db Firestore instance.
 * @param {object} tenant Tenant config.
 * @param {string} loadNumber Load number.
 * @param {string} recipientEmail Recipient email.
 * @param {number} [nowMs] Current time for tests.
 * @return {Promise<object|null>}
 */
async function findRecentPodSend(db, tenant, loadNumber, recipientEmail,
    nowMs) {
  const docId = podSendLogDocId(loadNumber, recipientEmail);
  if (!docId) return null;
  const snap = await podSendLogCollection(tenant, db).doc(docId).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  if (!isRecentPodSend(data, nowMs)) return null;
  return {...data, id: snap.id};
}

/**
 * Records a successful POD send for deduplication.
 * @param {object} db Firestore instance.
 * @param {object} tenant Tenant config.
 * @param {object} record loadNumber, recipientEmail, messageId, sentAt?
 * @return {Promise<void>}
 */
async function recordPodSend(db, tenant, record) {
  const docId = podSendLogDocId(record.loadNumber, record.recipientEmail);
  if (!docId) return;
  const payload = {
    loadNumber: String(record.loadNumber || "").trim(),
    recipientEmail: normalizeRecipientEmail(record.recipientEmail),
    messageId: record.messageId || null,
    sentAt: record.sentAt ||
      admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await podSendLogCollection(tenant, db).doc(docId).set(payload, {merge: true});
}

module.exports = {
  POD_SEND_LOG_COLLECTION,
  DEFAULT_DEDUP_WINDOW_MS,
  getDedupWindowMs,
  normalizeRecipientEmail,
  podSendLogDocId,
  isBlockedPodRecipient,
  podSendLogCollection,
  sentAtToMs,
  isRecentPodSend,
  findRecentPodSend,
  recordPodSend,
};
