/**
 * Dashboard ops console — notifications for emails that would go to Lisa /
 * reviewers, plus unhandled-email actions (reply / delete / flag).
 *
 * Env:
 *   DASHBOARD_OPS_PRIMARY — default OFF (emails must go out). Set true only
 *     with explicit Moshe approval. When true, park unhandled / ops alerts
 *     on the dashboard instead of emailing; forwardToHumanReview skips SMTP
 *     after writing a notification. Never flip this on in a deploy without
 *     that approval.
 */

"use strict";

const admin = require("firebase-admin");

const NOTIF_COLLECTION = "dashboardNotifications";

/** Every field serializeNotif reads except the email body. */
const NOTIF_LIST_FIELDS = [
  "tenantId", "type", "status", "title", "subject", "from", "to", "cc",
  "messageId", "invoiceId", "followUpId", "loadNumber", "proNumber",
  "carrierName", "department", "reason", "emailType", "chargesTotal",
  "chargeOptions", "emailSent", "ownerBucket", "awaitingReplyFrom",
  "dispatcherEmail", "dispatcherName", "dispatcherKey", "receivedAt",
  "emailReceivedAt", "createdAt", "dismissedAt", "flaggedAt", "flagNote",
];

const NOTIF_TYPE = Object.freeze({
  OPS_EMAIL: "ops_email",
  UNHANDLED_EMAIL: "unhandled_email",
  ADDITIONAL_CHARGE: "additional_charge",
});

const NOTIF_STATUS = Object.freeze({
  OPEN: "open",
  DISMISSED: "dismissed",
  FLAGGED: "flagged",
  ACTED: "acted",
});

/**
 * @return {boolean} True when dashboard is the primary ops surface.
 */
function isDashboardOpsPrimary() {
  const v = String(process.env.DASHBOARD_OPS_PRIMARY || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * @param {FirebaseFirestore.Timestamp|Date|null} ts Timestamp.
 * @return {string|null}
 */
function tsIso(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate().toISOString();
  if (ts instanceof Date) return ts.toISOString();
  return null;
}

/**
 * @param {object} doc Firestore doc.
 * @return {object}
 */
function serializeNotif(doc) {
  const d = doc.data() || {};
  return {
    id: doc.id,
    tenantId: d.tenantId || null,
    type: d.type || null,
    status: d.status || null,
    title: d.title || null,
    body: d.body || null,
    subject: d.subject || null,
    from: d.from || null,
    to: d.to || null,
    cc: d.cc || null,
    messageId: d.messageId || null,
    invoiceId: d.invoiceId || null,
    followUpId: d.followUpId || null,
    loadNumber: d.loadNumber || null,
    proNumber: d.proNumber || null,
    carrierName: d.carrierName || null,
    department: d.department || null,
    reason: d.reason || null,
    emailType: d.emailType || null,
    chargesTotal: d.chargesTotal != null ? d.chargesTotal : null,
    chargeOptions: Array.isArray(d.chargeOptions) ? d.chargeOptions : null,
    emailSent: d.emailSent === true,
    ownerBucket: d.ownerBucket || null,
    awaitingReplyFrom: d.awaitingReplyFrom || null,
    dispatcherEmail: d.dispatcherEmail || null,
    dispatcherName: d.dispatcherName || null,
    dispatcherKey: d.dispatcherKey || null,
    receivedAt: tsIso(d.receivedAt) || tsIso(d.emailReceivedAt) || null,
    createdAt: tsIso(d.createdAt),
    dismissedAt: tsIso(d.dismissedAt),
    flaggedAt: tsIso(d.flaggedAt),
    flagNote: d.flagNote || null,
  };
}

/**
 * Reads a query in chunks of 200 until no rows remain.
 * @param {object} baseQuery Firestore query, newest first.
 * @param {number} [maxDocs] Optional stop.
 * @return {Promise<object[]>}
 */
async function collectNotifPage(baseQuery, maxDocs) {
  const pageSize = 200;
  const docs = [];
  let last = null;
  const cap = Number(maxDocs);
  const bounded = Number.isFinite(cap) && cap > 0;
  while (!bounded || docs.length < cap) {
    const room = bounded ?
      Math.min(pageSize, cap - docs.length) : pageSize;
    let query = baseQuery.limit(room);
    if (last) query = query.startAfter(last);
    // eslint-disable-next-line no-await-in-loop
    const snap = await query.get();
    if (snap.empty) break;
    docs.push(...snap.docs);
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < room) break;
  }
  return docs;
}

/**
 * @param {object} db Firestore.
 * @param {object} data Notification fields.
 * @return {Promise<string|null>} Existing open id, if this is a retry.
 */
async function findOpenDuplicateNotification(db, data) {
  const tenantId = String((data && data.tenantId) || "default");
  const followUpId = String((data && data.followUpId) || "").trim();
  const messageId = String((data && data.messageId) || "").trim();
  const type = String((data && data.type) || "").trim();
  let snap = null;
  if (followUpId) {
    snap = await db.collection(NOTIF_COLLECTION)
        .where("followUpId", "==", followUpId)
        .limit(10)
        .get();
  } else if (messageId) {
    snap = await db.collection(NOTIF_COLLECTION)
        .where("messageId", "==", messageId)
        .limit(10)
        .get();
  }
  if (!snap) return null;
  let found = null;
  snap.forEach((doc) => {
    if (found) return;
    const row = doc.data() || {};
    if (row.status !== NOTIF_STATUS.OPEN) return;
    if (String(row.tenantId || "default") !== tenantId) return;
    if (type && row.type && row.type !== type) return;
    found = doc.id;
  });
  return found;
}

/**
 * Creates an open dashboard notification.
 * Reuses an open row for the same follow-up or email.
 * @param {object} db Firestore.
 * @param {object} data Fields.
 * @return {Promise<string|null>}
 */
async function createNotification(db, data) {
  try {
    try {
      const existingId = await findOpenDuplicateNotification(db, data);
      if (existingId) {
        console.log(
            "[dashboard-ops] reused open notification",
            existingId,
            data.loadNumber || "",
            data.type || "");
        return existingId;
      }
    } catch (dedupeErr) {
      console.error("[dashboard-ops] notification dedupe failed:",
          dedupeErr.message);
    }
    const ref = await db.collection(NOTIF_COLLECTION).add({
      tenantId: data.tenantId || "default",
      type: data.type || NOTIF_TYPE.OPS_EMAIL,
      status: NOTIF_STATUS.OPEN,
      title: data.title || "Notification",
      body: data.body || null,
      subject: data.subject || null,
      from: data.from || null,
      to: data.to || null,
      cc: data.cc || null,
      messageId: data.messageId || null,
      invoiceId: data.invoiceId || null,
      followUpId: data.followUpId || null,
      loadNumber: data.loadNumber || null,
      proNumber: data.proNumber || null,
      carrierName: data.carrierName || null,
      department: data.department || null,
      reason: data.reason || null,
      emailType: data.emailType || null,
      chargesTotal: data.chargesTotal != null ? data.chargesTotal : null,
      chargeOptions: data.chargeOptions || null,
      emailSent: data.emailSent === true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      dismissedAt: null,
      flaggedAt: null,
      flagNote: null,
      deleteAt: admin.firestore.Timestamp.fromDate(
          new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)),
    });
    return ref.id;
  } catch (err) {
    console.error("[dashboard-ops] createNotification failed:", err.message);
    return null;
  }
}

const NOTIF_RANGE_DAYS = Object.freeze({
  day: 1,
  week: 7,
  month: 30,
  year: 365,
});

/**
 * @param {object} row Notification.
 * @param {string} query Search text.
 * @return {boolean}
 */
function notificationMatchesQuery(row, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  const load = String(row && row.loadNumber == null ? "" : row.loadNumber)
      .trim().toLowerCase();
  if (load && (load === needle || load.includes(needle))) return true;
  const hay = [
    row && row.subject,
    row && row.title,
    row && row.reason,
    row && row.carrierName,
    row && row.from,
    row && row.to,
    row && row.proNumber,
    row && row.body,
    row && row.invoiceId,
  ].filter((part) => part != null && String(part).trim() !== "")
      .join(" ")
      .toLowerCase();
  return hay.includes(needle);
}

/**
 * @param {object} row Notification.
 * @param {string} range day|week|month|year. Blank keeps every row.
 * @param {number} now Clock millis.
 * @return {boolean}
 */
function notificationInRange(row, range, now) {
  const days = NOTIF_RANGE_DAYS[String(range || "").toLowerCase()];
  if (!days) return true;
  const raw = row && (row.receivedAt || row.createdAt);
  const at = Date.parse(raw || "");
  if (!Number.isFinite(at)) return true;
  const clock = Number(now) || Date.now();
  return at >= clock - days * 24 * 60 * 60 * 1000;
}

/**
 * Urgent-first orders old rows ahead. It does not drop the rest.
 * @param {object[]} rows Notifications.
 * @param {string} sort newest|oldest|urgent|amount.
 * @param {number} now Clock millis.
 * @return {object[]}
 */
function sortNotifications(rows, sort, now) {
  const key = String(sort || "").toLowerCase();
  const clock = Number(now) || Date.now();
  const urgentMs = 14 * 24 * 60 * 60 * 1000;
  const timeOf = (row) => {
    const at = Date.parse((row && (row.receivedAt || row.createdAt)) || "");
    return Number.isFinite(at) ? at : 0;
  };
  const amountOf = (row) => {
    const n = Number(row && row.chargesTotal);
    return Number.isFinite(n) ? n : 0;
  };
  const urgent = (row) => {
    const at = timeOf(row);
    return Boolean(at) && (clock - at) >= urgentMs;
  };
  return rows.slice().sort((a, b) => {
    if (key === "amount") return amountOf(b) - amountOf(a);
    if (key === "urgent") {
      if (urgent(a) !== urgent(b)) return urgent(a) ? -1 : 1;
    }
    const ta = timeOf(a);
    const tb = timeOf(b);
    return key === "oldest" ? ta - tb : tb - ta;
  });
}

/**
 * Lists open notifications for a tenant.
 * opts.all returns every open row (daily unfinished digest).
 * A search query scans the open set inside the selected time range
 * and does not drop rows just because sort is urgent-first.
 * @param {object} db Firestore.
 * @param {object} opts tenantId, limit, type, all, q, range, sort, offset.
 * @return {Promise<object>}
 */
async function listNotifications(db, opts) {
  const tenantId = String(opts.tenantId || "default");
  const returnAll = opts && opts.all === true;
  const q = String((opts && opts.q) || "").trim();
  let base = db.collection(NOTIF_COLLECTION)
      .where("tenantId", "==", tenantId)
      .where("status", "==", NOTIF_STATUS.OPEN)
      .orderBy("createdAt", "desc");
  if (opts.type) {
    base = db.collection(NOTIF_COLLECTION)
        .where("tenantId", "==", tenantId)
        .where("status", "==", NOTIF_STATUS.OPEN)
        .where("type", "==", String(opts.type))
        .orderBy("createdAt", "desc");
  }
  if (returnAll) {
    const docs = await collectNotifPage(base);
    const notifications = docs.map(serializeNotif);
    return {notifications, openCount: notifications.length};
  }
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
  const offset = Math.max(0, Number(opts.offset) || 0);
  if (q) {
    const docs = await collectNotifPage(base, 2000);
    const now = Number(opts.now) || Date.now();
    let rows = docs.map(serializeNotif).filter((row) =>
      notificationMatchesQuery(row, q) &&
      notificationInRange(row, opts.range, now));
    rows = sortNotifications(rows, opts.sort, now);
    const page = rows.slice(offset, offset + limit);
    return {
      notifications: page,
      openCount: rows.length,
      filteredCount: rows.length,
      hasMore: offset + page.length < rows.length,
      nextOffset: offset + page.length,
      offset,
      limit,
    };
  }
  // The first page does not carry email HTML. The dashboard loads it with
  // loadNotificationDetail when a row is opened.
  const docs = await collectNotifPage(
      base.select(...NOTIF_LIST_FIELDS), limit);
  const notifications = sortNotifications(
      docs.map(serializeNotif), opts.sort, opts.now);
  return {notifications, openCount: notifications.length};
}

/**
 * Email body for one notification. Other tenants get not-found.
 * @param {object} db Firestore.
 * @param {object} opts id, tenantId.
 * @return {Promise<object>}
 */
async function loadNotificationDetail(db, opts) {
  const id = String((opts && opts.id) || "").trim();
  const tenantId = String((opts && opts.tenantId) || "default");
  if (!id) return {ok: false, error: "Not found."};
  const snap = await db.collection(NOTIF_COLLECTION).doc(id).get();
  if (!snap.exists) return {ok: false, error: "Not found."};
  const data = snap.data() || {};
  if (String(data.tenantId || "default") !== tenantId) {
    return {ok: false, error: "Not found."};
  }
  return {ok: true, body: data.body || null};
}

/**
 * @param {object} db Firestore.
 * @param {object} opts id, tenantId.
 * @return {Promise<object>}
 */
async function dismissNotification(db, opts) {
  const id = String(opts.id || "").trim();
  if (!id) return {ok: false, error: "id is required."};
  const ref = db.collection(NOTIF_COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return {ok: false, error: "Notification not found."};
  const data = snap.data() || {};
  if (opts.tenantId && data.tenantId && data.tenantId !== opts.tenantId) {
    return {ok: false, error: "Notification not found."};
  }
  await ref.update({
    status: NOTIF_STATUS.DISMISSED,
    dismissedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return {ok: true};
}

/**
 * Flags a notification and emails the system owner with the note.
 * @param {object} db Firestore.
 * @param {object} opts id, tenantId, note, sendFlagEmail(fn).
 * @return {Promise<object>}
 */
async function flagNotification(db, opts) {
  const id = String(opts.id || "").trim();
  const note = String(opts.note || "").trim();
  if (!id) return {ok: false, error: "id is required."};
  if (note.length < 5) {
    return {ok: false, error: "Please describe the error (at least 5 chars)."};
  }
  const ref = db.collection(NOTIF_COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return {ok: false, error: "Notification not found."};
  const data = snap.data() || {};
  if (opts.tenantId && data.tenantId && data.tenantId !== opts.tenantId) {
    return {ok: false, error: "Notification not found."};
  }
  await ref.update({
    status: NOTIF_STATUS.FLAGGED,
    flaggedAt: admin.firestore.FieldValue.serverTimestamp(),
    flagNote: note,
  });
  if (typeof opts.sendFlagEmail === "function") {
    await opts.sendFlagEmail({
      notification: serializeNotif(snap),
      note,
    });
  }
  return {ok: true};
}

/**
 * Marks a notification as acted (e.g. after charge decision or reply).
 * @param {object} db Firestore.
 * @param {object} opts id, tenantId, extra.
 * @return {Promise<object>}
 */
async function markActed(db, opts) {
  const id = String(opts.id || "").trim();
  if (!id) return {ok: false, error: "id is required."};
  const ref = db.collection(NOTIF_COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return {ok: false, error: "Notification not found."};
  await ref.update({
    status: NOTIF_STATUS.ACTED,
    actedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...(opts.extra || {}),
  });
  return {ok: true};
}

/**
 * Finds open unhandled/charge notifications for an invoice or message.
 * @param {object} db Firestore.
 * @param {object} opts tenantId, invoiceId?, messageId?, type?
 * @return {Promise<object[]>}
 */
async function findOpenByRef(db, opts) {
  const tenantId = String(opts.tenantId || "default");
  const query = db.collection(NOTIF_COLLECTION)
      .where("tenantId", "==", tenantId)
      .where("status", "==", NOTIF_STATUS.OPEN)
      .limit(20);
  const snap = await query.get();
  return snap.docs.map(serializeNotif).filter((n) => {
    if (opts.invoiceId && n.invoiceId !== opts.invoiceId) return false;
    if (opts.messageId && n.messageId !== opts.messageId) return false;
    if (opts.type && n.type !== opts.type) return false;
    return true;
  });
}

/**
 * Open "POD needed" / "No POD" notices. Rate, margin, GTG, charge, and
 * escalation mail is left alone.
 * @param {object} row Notification fields.
 * @return {boolean}
 */
function isClearablePodNotification(row) {
  if (!row) return false;
  if (String(row.status || "").toLowerCase() !== "open") return false;
  const text = `${row.subject || ""} ${row.reason || ""} ${row.title || ""}`;
  if (/escalat|customer rate|low margin|gtg|enter load|additional charge/i
      .test(text)) {
    return false;
  }
  return /no pod|pod needed/i.test(text);
}

/**
 * @param {object} row Notification fields.
 * @param {string} query Load number.
 * @return {boolean}
 */
function notificationMatchesLoadQuery(row, query) {
  const needle = String(query || "").trim();
  if (!needle) return false;
  if (row && String(row.loadNumber || "") === needle) return true;
  const text = `${row && row.subject || ""} ${row && row.body || ""} ` +
    `${row && row.reason || ""} ${row && row.title || ""}`;
  return new RegExp(`\\b${needle}\\b`).test(text);
}

/**
 * @param {object[]} rows Notification rows.
 * @return {object[]}
 */
function uniqueNotificationsById(rows) {
  const seen = new Set();
  const out = [];
  (rows || []).forEach((row) => {
    const id = row && row.id;
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(row);
  });
  return out;
}

/**
 * Clears open POD notices for a load once the POD is found.
 * @param {object} db Firestore.
 * @param {object} opts loadNumber, invoiceId, tenantId.
 * @return {Promise<{dismissed: number, ids: string[]}>}
 */
async function dismissOpenPodNotifications(db, opts) {
  const loadNumber = String((opts && opts.loadNumber) || "").trim();
  const invoiceId = String((opts && opts.invoiceId) || "").trim();
  if (!loadNumber && !invoiceId) return {dismissed: 0, ids: []};
  const tenantId = (opts && opts.tenantId) || "default";
  const snap = await db.collection(NOTIF_COLLECTION)
      .where("status", "==", NOTIF_STATUS.OPEN)
      .limit(500)
      .get();
  const ids = [];
  for (const doc of snap.docs || []) {
    const data = doc.data() || {};
    if (data.tenantId && data.tenantId !== tenantId) continue;
    const row = {
      id: doc.id,
      ...data,
      loadNumber: data.loadNumber,
      invoiceId: data.invoiceId,
      status: data.status || NOTIF_STATUS.OPEN,
    };
    const sameLoad = loadNumber &&
      String(row.loadNumber == null ? "" : row.loadNumber) === loadNumber;
    const sameInvoice = invoiceId &&
      String(row.invoiceId || "") === invoiceId;
    if (!sameLoad && !sameInvoice) continue;
    if (!isClearablePodNotification(row)) continue;
    await db.collection(NOTIF_COLLECTION).doc(doc.id).update({
      status: NOTIF_STATUS.DISMISSED,
      dismissedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    ids.push(doc.id);
  }
  return {dismissed: ids.length, ids};
}

module.exports = {
  NOTIF_COLLECTION,
  NOTIF_TYPE,
  NOTIF_STATUS,
  isDashboardOpsPrimary,
  createNotification,
  listNotifications,
  loadNotificationDetail,
  dismissNotification,
  dismissOpenPodNotifications,
  isClearablePodNotification,
  notificationMatchesLoadQuery,
  notificationMatchesQuery,
  notificationInRange,
  sortNotifications,
  uniqueNotificationsById,
  flagNotification,
  markActed,
  findOpenByRef,
  serializeNotif,
};
