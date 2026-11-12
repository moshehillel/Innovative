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
const ownership = require("./dashboard-ownership");

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
      // Plain words for dashboard search, so search never reads the HTML.
      searchText: notificationSearchTextFromBody(data.body),
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
    bodySearchText(row),
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
    // Every open row (daily digest). List fields only: no email HTML.
    const docs = await collectNotifPage(base.select(...NOTIF_LIST_FIELDS));
    const notifications = uniqueNotificationsById(
        sortNotifications(docs.map(serializeNotif), opts.sort, opts.now));
    return {
      notifications,
      openCount: notifications.length,
      hasMore: false,
    };
  }
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
  const offset = Math.max(0, Number(opts.offset) || 0);
  if (q) {
    // Every open row is searched, through the small searchText field.
    // Older rows saved before searchText have short plain bodies; only
    // those bodies are read.
    const docs = await collectNotifPage(
        base.select(...NOTIF_LIST_FIELDS, "searchText"));
    const searchRows = docs.map((doc) => {
      const data = doc.data() || {};
      const row = serializeNotif(doc);
      row.searchText = data.searchText || null;
      return {row, ref: doc.ref};
    });
    const legacy = searchRows.filter((entry) =>
      !entry.row.searchText && entry.ref);
    if (legacy.length && typeof db.getAll === "function") {
      for (let i = 0; i < legacy.length; i += 100) {
        const chunk = legacy.slice(i, i + 100);
        // eslint-disable-next-line no-await-in-loop
        const snaps = await db.getAll(...chunk.map((entry) => entry.ref), {
          fieldMask: ["body"],
        }).catch(() => []);
        snaps.forEach((snap, idx) => {
          const body = snap && snap.exists ? (snap.data() || {}).body : null;
          if (body) {
            chunk[idx].row.searchText =
              notificationSearchTextFromBody(body);
          }
        });
      }
    }
    const now = Number(opts.now) || Date.now();
    let rows = uniqueNotificationsById(searchRows.map((entry) => {
      const row = entry.row;
      row.body = null;
      return row;
    })).filter((row) =>
      notificationMatchesQuery(row, q) &&
      notificationInRange(row, opts.range, now));
    rows.forEach((row) => {
      delete row.searchText;
    });
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
  // Pages do not carry email HTML. The dashboard loads it with
  // loadNotificationDetail when a row is opened. Load more asks for the
  // next offset, so read through offset + limit (list fields only) and
  // report hasMore and the real open count; the old first-page-only read
  // repeated the same rows and showed the page size as the open count.
  const countPromise = typeof base.count === "function" ?
    base.count().get().then((snap) => {
      const data = snap && typeof snap.data === "function" ? snap.data() : null;
      return data && Number.isFinite(Number(data.count)) ?
        Number(data.count) : null;
    }).catch(() => null) : Promise.resolve(null);
  const [docs, counted] = await Promise.all([
    collectNotifPage(base.select(...NOTIF_LIST_FIELDS), offset + limit + 1),
    countPromise,
  ]);
  const rows = sortNotifications(
      docs.map(serializeNotif), opts.sort, opts.now);
  const notifications = rows.slice(offset, offset + limit);
  const hasMore = rows.length > offset + limit;
  return {
    notifications,
    openCount: counted != null ? counted : rows.length,
    hasMore,
    nextOffset: offset + notifications.length,
    offset,
    limit,
  };
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
  const stored = data.body || null;
  // Older charge notices saved only a one-line summary. Show the approval
  // email instead: the saved copy on the follow-up, or a rebuilt one.
  const isCharge = data.type === NOTIF_TYPE.ADDITIONAL_CHARGE ||
    data.emailType === "additional_charge_approval";
  const looksLikeEmail = /<\/?[a-z][\s\S]*>/i.test(String(stored || ""));
  if (isCharge && data.followUpId && !looksLikeEmail) {
    try {
      const dashboardTasks = require("./dashboard-tasks");
      const additionalCharges = require("./additional-charges");
      const detail = await dashboardTasks.loadItemDetail(
          db, additionalCharges, {
            id: String(data.followUpId),
            source: "additionalCharges",
            tenantId,
          });
      if (detail && detail.ok && detail.body) {
        return {ok: true, body: detail.body};
      }
    } catch (err) {
      console.error("[loadNotificationDetail] charge email:", err.message);
    }
  }
  return {ok: true, body: stored};
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
  if (opts.tenantId && !ownership.sameTenant(data.tenantId, opts.tenantId)) {
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
  if (opts.tenantId && !ownership.sameTenant(data.tenantId, opts.tenantId)) {
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
 * Plain-text copy of a notification body for search, capped at 3000 chars.
 * @param {*} body Body HTML or text.
 * @return {string|null}
 */
function notificationSearchTextFromBody(body) {
  if (!body) return null;
  const text = String(body).replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
  return text ? text.slice(0, 3000) : null;
}

/**
 * Notification body as plain words for search (bodies are saved as HTML).
 * @param {object} row Notification fields.
 * @return {string}
 */
function bodySearchText(row) {
  if (row && row.searchText) return String(row.searchText);
  const body = row && row.body;
  if (!body) return "";
  return String(body).replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ");
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
  const text = `${row && row.subject || ""} ${bodySearchText(row)} ` +
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
    if (!ownership.sameTenant(data.tenantId, tenantId)) continue;
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

const NOTICE_ISSUE = Object.freeze({
  POD: "pod",
  RATE: "rate",
  PROFIT: "profit",
  GTG: "gtg",
  LOAD_NUMBER: "load_number",
  CHARGE_APPROVAL: "charge_approval",
  DISPUTE: "dispute",
});

/**
 * Subject, title, and reason with dashes folded to a hyphen.
 * Email HTML is left out so a mention in the body cannot match.
 * @param {object} row Notification or task.
 * @return {string}
 */
function noticePlainText(row) {
  return [
    row && row.subject,
    row && row.reason,
    row && row.title,
    row && row.decisionReason,
    row && row.emailType,
    row && row.type,
  ].filter((part) => part != null && String(part) !== "")
      .join("\n")
      .replace(/[\u2014\u2013\u2012\u2212]/g, "-")
      .toLowerCase();
}
/**
 * @param {object} row Notification.
 * @return {boolean}
 */
function isOpenNotice(row) {
  const status = String((row && row.status) || "open").toLowerCase();
  return status === NOTIF_STATUS.OPEN;
}
/**
 * One problem per notice. A different problem on the same load
 * gets a different key and is left open.
 * @param {object} row Notification or task.
 * @return {string|null}
 */
function noticeIssueKey(row) {
  if (!row) return null;
  const type = String(row.type || "").toLowerCase();
  const emailType = String(row.emailType || "").toLowerCase();
  const text = noticePlainText(row);
  const phase = String(row.chargePhase || "").toLowerCase();
  const follow = String(row.followUpStatus || "").toLowerCase();
  const decision = String(row.decision || "").toLowerCase();
  const dispute = emailType === "carrier_dispute_draft" ||
    /dispute draft/.test(text) ||
    phase === "dispute" ||
    follow === "disputing" ||
    follow === "disputed" ||
    decision === "d";
  if (emailType.indexOf("drayage_gtg") === 0 || /gtg stopped/.test(text)) {
    return NOTICE_ISSUE.GTG;
  }
  if (emailType === "missing_load_number" ||
      /enter load\s*(#|number)\b/.test(text)) {
    return NOTICE_ISSUE.LOAD_NUMBER;
  }
  if (dispute && (type === "additional_charge" ||
      emailType === "carrier_dispute_draft" ||
      /dispute draft/.test(text))) {
    return NOTICE_ISSUE.DISPUTE;
  }
  if (emailType === "additional_charge_approval" ||
      type === "additional_charge" ||
      /approval needed\s*-\s*additional charge/.test(text)) {
    return NOTICE_ISSUE.CHARGE_APPROVAL;
  }
  if (type === "missing_pod" ||
      /action needed\s*-\s*no pod\b/.test(text) ||
      /\bpod needed\b/.test(text)) {
    return NOTICE_ISSUE.POD;
  }
  if (type === "low_margin" ||
      type === "low_profit" ||
      emailType === "low_profit_dispatcher" ||
      emailType === "low_margin" ||
      /low\/negative profit|low margin|customer rate too low/.test(text) ||
      /rate too low/.test(text)) {
    return NOTICE_ISSUE.PROFIT;
  }
  const reason = String(row.reason || row.decisionReason || "");
  if (type === "missing_rate" ||
      type === "rate_missing" ||
      emailType === "rate_missing" ||
      reason.toUpperCase() === "MISSING_RATE" ||
      /no customer rate|missing customer rate|missing carrier rate/
          .test(text)) {
    return NOTICE_ISSUE.RATE;
  }
  return null;
}
/**
 * Which notice the set-rate form finished. Missing rate and low
 * margin are different problems.
 * @param {object} inv Invoice fields before the rate is saved.
 * @return {string|null}
 */
function noticeIssueForRateSave(inv) {
  if (!inv) return null;
  const rate = Number(inv.customerRate);
  const missing = !Number.isFinite(rate) || rate <= 0;
  const blob = [inv.decisionReason, inv.decisionStage, inv.reason]
      .filter((part) => part != null && String(part) !== "")
      .join(" ")
      .toLowerCase();
  const low = /too low|low margin|low_margin|negative profit|low profit/
      .test(blob);
  const rateText = /missing customer rate|missing_rate|no customer rate/
      .test(blob);
  if (missing || (rateText && !low)) return NOTICE_ISSUE.RATE;
  if (low) return NOTICE_ISSUE.PROFIT;
  return null;
}
/**
 * @param {object} data Notice fields.
 * @param {string} loadNumber Requested load.
 * @return {boolean}
 */
function sameNoticeLoad(data, loadNumber) {
  const want = String(loadNumber || "").trim();
  const got = String(data && data.loadNumber == null ?
    "" : data.loadNumber).trim();
  return Boolean(want) && want === got;
}
/**
 * @param {object} data Notice fields.
 * @param {object} request issue, loadNumber, invoiceId, messageId,
 *   followUpId.
 * @return {boolean}
 */
function notificationMatchesCompletedIssue(data, request) {
  if (!isOpenNotice(data)) return false;
  if (noticeIssueKey(data) !== request.issue) return false;
  const issue = request.issue;
  if (issue === NOTICE_ISSUE.LOAD_NUMBER) {
    const mid = String(request.messageId || "").trim();
    if (!mid) return false;
    if (String(data.messageId || "") === mid) return true;
    if (mid.length < 8) return false;
    const blob = [data.subject, data.title, data.body]
        .filter((part) => part != null && String(part) !== "")
        .join("\n");
    return blob.includes(mid);
  }
  if (issue === NOTICE_ISSUE.CHARGE_APPROVAL ||
      issue === NOTICE_ISSUE.DISPUTE) {
    const wantFollow = String(request.followUpId || "").trim();
    const gotFollow = String(data.followUpId || "").trim();
    if (wantFollow && gotFollow && wantFollow !== gotFollow) return false;
    const wantInvoice = String(request.invoiceId || "").trim();
    const gotInvoice = String(data.invoiceId || "").trim();
    if (wantInvoice && gotInvoice && wantInvoice !== gotInvoice) {
      return false;
    }
    if (wantFollow && gotFollow === wantFollow) return true;
    if (wantInvoice && gotInvoice === wantInvoice) return true;
  }
  const wantInvoice = String(request.invoiceId || "").trim();
  const gotInvoice = String(data.invoiceId || "").trim();
  if (wantInvoice && gotInvoice === wantInvoice) return true;
  return sameNoticeLoad(data, request.loadNumber);
}
/**
 * @param {object} db Firestore.
 * @param {string} field Field name.
 * @param {string|number} value Field value.
 * @return {Promise<object[]>}
 */
async function loadNotifDocs(db, field, value) {
  const snap = await db.collection(NOTIF_COLLECTION)
      .where(field, "==", value)
      .limit(40)
      .get();
  return snap.docs || [];
}
/**
 * Dismisses open notices for one completed problem on a load.
 * A different problem on that load stays open.
 * @param {object} db Firestore.
 * @param {object} opts issue, tenantId, loadNumber, invoiceId,
 *   messageId, followUpId.
 * @return {Promise<object>}
 */
async function dismissOpenIssueNotifications(db, opts) {
  const request = opts || {};
  const issue = String(request.issue || "").trim();
  if (!db || !issue) return {ok: true, dismissed: 0, ids: []};
  const tenantId = request.tenantId || "default";
  const loadNumber = String(request.loadNumber || "").trim();
  const invoiceId = String(request.invoiceId || "").trim();
  const messageId = String(request.messageId || "").trim();
  const followUpId = String(request.followUpId || "").trim();
  const lookups = [];
  if (invoiceId) lookups.push(["invoiceId", invoiceId]);
  if (loadNumber) {
    lookups.push(["loadNumber", loadNumber]);
    if (/^\d+$/.test(loadNumber)) {
      lookups.push(["loadNumber", Number(loadNumber)]);
    }
  }
  if (messageId) lookups.push(["messageId", messageId]);
  if (followUpId) lookups.push(["followUpId", followUpId]);
  if (issue === NOTICE_ISSUE.LOAD_NUMBER) {
    lookups.push(["emailType", "missing_load_number"]);
  }
  if (!lookups.length) return {ok: true, dismissed: 0, ids: []};
  const seen = new Set();
  const ids = [];
  const match = {
    issue,
    loadNumber,
    invoiceId,
    messageId,
    followUpId,
  };
  for (const pair of lookups) {
    let docs = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      docs = await loadNotifDocs(db, pair[0], pair[1]);
    } catch (err) {
      console.error("[dismissOpenIssueNotifications]",
          err && err.message);
      continue;
    }
    for (const doc of docs) {
      if (!doc || seen.has(doc.id)) continue;
      seen.add(doc.id);
      const data = doc.data() || {};
      if (!ownership.sameTenant(data.tenantId, tenantId)) continue;
      if (!notificationMatchesCompletedIssue(data, match)) continue;
      // eslint-disable-next-line no-await-in-loop
      const result = await dismissNotification(db, {
        id: doc.id,
        tenantId: data.tenantId || tenantId,
      });
      if (result && result.ok) ids.push(doc.id);
    }
  }
  return {ok: true, dismissed: ids.length, ids};
}

module.exports = {
  NOTICE_ISSUE,
  noticeIssueKey,
  noticeIssueForRateSave,
  dismissOpenIssueNotifications,
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
