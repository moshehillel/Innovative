/**
 * Dashboard ops console — notifications for emails that would go to Lisa /
 * reviewers, plus unhandled-email actions (reply / delete / flag).
 *
 * Env:
 *   DASHBOARD_OPS_PRIMARY=true — park unhandled / ops alerts in the
 *     dashboard instead of (or in addition to) emailing humans. When set,
 *     forwardToHumanReview skips SMTP send after writing a notification.
 */

"use strict";

const admin = require("firebase-admin");
const ownership = require("./dashboard-ownership");
const mailFiles = require("./dashboard-email-files");
const dedupe = require("./dashboard-dedupe");

const NOTIF_COLLECTION = "dashboardNotifications";

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

/** List fields. Email HTML is loaded when a notification is opened. */
const NOTIF_LIST_FIELDS = [
  "tenantId", "type", "status", "title", "subject", "from", "to", "cc",
  "messageId", "invoiceId", "followUpId", "loadNumber", "proNumber",
  "carrierName", "department", "reason", "emailType", "chargesTotal",
  "emailSent", "ownerBucket", "awaitingReplyFrom", "dispatcherEmail",
  "dispatcherName", "dispatcherKey", "ownershipHistory", "receivedAt",
  "receivedAtSource", "emailReceivedAt", "attachments", "mailboxLookupAt",
  "createdAt", "dismissedAt", "flaggedAt", "flagNote",
];

const FOLLOW_LIST_FIELDS = [
  "tenantId", "emailSubject", "emailTo", "emailCc", "dispatcherEmail",
  "dispatcherName", "ownerBucket", "receivedAt", "emailReceivedAt",
  "receivedAtSource", "attachments",
];

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
    ownershipHistory: Array.isArray(d.ownershipHistory) ?
      d.ownershipHistory : [],
    ...mailFiles.serializeMailFields(d),
    createdAt: tsIso(d.createdAt),
    dismissedAt: tsIso(d.dismissedAt),
    flaggedAt: tsIso(d.flaggedAt),
    flagNote: d.flagNote || null,
  };
}

/**
 * Finds an open notification for the same charge or the same message.
 * @param {object} db Firestore.
 * @param {object} data Incoming notification fields.
 * @return {Promise<object|null>}
 */
async function findOpenDuplicateNotification(db, data) {
  const loadNumber = String(data.loadNumber || "").trim();
  const messageId = String(data.messageId || "").trim();
  const followUpId = String(data.followUpId || "").trim();
  const tenantId = String(data.tenantId || "default");
  const type = data.type || NOTIF_TYPE.OPS_EMAIL;
  let docs = [];
  if (loadNumber) {
    const snap = await db.collection(NOTIF_COLLECTION)
        .where("loadNumber", "==", loadNumber)
        .limit(80)
        .get();
    docs = snap.docs;
  } else if (messageId) {
    const snap = await db.collection(NOTIF_COLLECTION)
        .where("messageId", "==", messageId)
        .limit(20)
        .get();
    docs = snap.docs;
  } else if (followUpId) {
    const snap = await db.collection(NOTIF_COLLECTION)
        .where("followUpId", "==", followUpId)
        .limit(20)
        .get();
    docs = snap.docs;
  } else {
    return null;
  }

  const incoming = {
    type,
    loadNumber: loadNumber || null,
    reason: data.reason || data.category || null,
    chargesTotal: data.chargesTotal,
    messageId: messageId || null,
    followUpId: followUpId || null,
  };
  let best = null;
  for (const doc of docs) {
    const row = doc.data() || {};
    if ((row.status || "") !== NOTIF_STATUS.OPEN) continue;
    if (String(row.tenantId || "default") !== tenantId) continue;
    const candidate = {
      type: row.type || null,
      loadNumber: row.loadNumber || null,
      reason: row.reason || null,
      chargesTotal: row.chargesTotal,
      messageId: row.messageId || null,
      followUpId: row.followUpId || null,
      createdAt: tsIso(row.createdAt),
      receivedAt: mailFiles.toIso(row.receivedAt),
      emailReceivedAt: mailFiles.toIso(row.emailReceivedAt),
    };
    if (!dedupe.isExactDuplicateItem(incoming, candidate)) continue;
    if (!best ||
        dedupe.compareDuplicatePreference(candidate, best.item) > 0) {
      best = {id: doc.id, ref: doc.ref, data: row, item: candidate};
    }
  }
  return best;
}

/**
 * Creates an open dashboard notification.
 * Reuses an open row when this is the same email or additional charge.
 * @param {object} db Firestore.
 * @param {object} data Fields.
 * @return {Promise<string|null>}
 */
async function createNotification(db, data) {
  try {
    const digestMail = require("./dashboard-notification-digest");
    if (digestMail.isInboundDigestEmail(data)) {
      console.log("[createNotification] skipped digest email",
          (data && (data.subject || data.messageId)) || "");
      return null;
    }
    const MAX_BODY = 120000;
    let body = data.body != null ? String(data.body) : null;
    if (body && body.length > MAX_BODY) body = body.slice(0, MAX_BODY);
    const owner = ownership.ownershipFieldsForCreate({
      ...data,
      type: data.type || NOTIF_TYPE.OPS_EMAIL,
    });
    const mail = mailFiles.fieldsForCreate(data);
    try {
      const existing = await findOpenDuplicateNotification(db, data);
      if (existing) {
        const patch = {};
        if (body) patch.body = body;
        if (data.subject) patch.subject = data.subject;
        if (data.chargesTotal != null &&
            existing.data.chargesTotal == null) {
          patch.chargesTotal = data.chargesTotal;
        }
        if (data.followUpId && !existing.data.followUpId) {
          patch.followUpId = data.followUpId;
        }
        const incomingMs = dedupe.timestampMs(
            data.receivedAt || data.emailReceivedAt || null) || 0;
        const existingMs = dedupe.timestampMs(existing.data.receivedAt) || 0;
        if (mail.receivedAt && incomingMs > existingMs) {
          patch.receivedAt = mail.receivedAt;
          if (mail.receivedAtSource) {
            patch.receivedAtSource = mail.receivedAtSource;
          }
        }
        const hasFiles = Array.isArray(existing.data.attachments) &&
          existing.data.attachments.length;
        if (Array.isArray(mail.attachments) && mail.attachments.length &&
            !hasFiles) {
          patch.attachments = mail.attachments;
        }
        if (Object.keys(patch).length) {
          patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
          await existing.ref.update(patch);
        }
        console.log(
            "[createNotification] exact duplicate — reused",
            existing.id, data.loadNumber || "", data.messageId || "");
        return existing.id;
      }
    } catch (dedupeErr) {
      console.error("[dashboard-ops] dedupe lookup failed:",
          dedupeErr.message);
    }
    const ref = await db.collection(NOTIF_COLLECTION).add({
      tenantId: data.tenantId || "default",
      type: data.type || NOTIF_TYPE.OPS_EMAIL,
      status: NOTIF_STATUS.OPEN,
      title: data.title || "Notification",
      body,
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
      ...owner,
      ...mail,
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

/**
 * Wraps a thin stored body with the same Action Required chrome the review
 * email uses (for legacy rows that only saved the original message HTML).
 * @param {object} n Serialized notification.
 * @return {string}
 */
function enrichUnhandledNotifBody(n) {
  const body = String(n.body || "").trim();
  const reason = String(n.reason || "").trim();
  if (!body && !reason) return body;
  if (/Action Required/i.test(body) && /Original (Email|Message)/i.test(body)) {
    return body;
  }
  const esc = (v) => String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const notes = reason ?
    `Jerry could not auto-handle this email (${esc(reason)}). ` +
    `Please review and take action.` :
    `Jerry could not auto-handle this email. Please review and take action.`;
  return `<div style="font-family:Arial,sans-serif;max-width:620px;` +
    `color:#111827;font-size:14px;">` +
    `<div style="background:#dc2626;color:#fff;padding:14px 18px;` +
    `border-radius:6px 6px 0 0;font-size:15px;font-weight:700;">` +
    `&#9888; Action Required — ${esc(reason || "Review needed")}</div>` +
    `<div style="border:1px solid #e5e7eb;border-top:none;padding:18px;` +
    `border-radius:0 0 6px 6px;">` +
    `<p style="margin:0 0 16px;color:#374151;line-height:1.6;">${notes}</p>` +
    `<h3 style="margin:20px 0 8px;font-size:13px;text-transform:uppercase;` +
    `letter-spacing:.05em;color:#374151;">Original Email</h3>` +
    `<table style="border-collapse:collapse;font-size:13px;">` +
    (n.from ?
      `<tr><td style="padding:4px 14px 4px 0;color:#6b7280;font-weight:600;">` +
      `From</td><td>${esc(n.from)}</td></tr>` : "") +
    (n.subject ?
      `<tr><td style="padding:4px 14px 4px 0;color:#6b7280;font-weight:600;">` +
      `Subject</td><td>${esc(n.subject)}</td></tr>` : "") +
    (n.messageId ?
      `<tr><td style="padding:4px 14px 4px 0;color:#6b7280;font-weight:600;">` +
      `Message&nbsp;ID</td>` +
      `<td style="font-family:monospace;font-size:11px;">` +
      `${esc(n.messageId)}</td></tr>` : "") +
    `</table>` +
    (body ?
      `<h3 style="margin:20px 0 8px;font-size:13px;text-transform:uppercase;` +
      `letter-spacing:.05em;color:#374151;">Original Message</h3>` +
      `<div style="background:#f9fafb;border:1px solid #e5e7eb;` +
      `border-radius:6px;padding:14px;font-size:13px;line-height:1.6;` +
      `color:#374151;">${body}</div>` : "") +
    `</div></div>`;
}

/**
 * Copies routing fields from follow-ups. Does not read email HTML.
 * @param {object} db Firestore.
 * @param {object[]} notifications Open notifications.
 * @param {object|null} additionalChargesMod Follow-up module.
 * @param {string} tenantId Tenant.
 * @return {Promise<void>}
 */
async function enrichChargeNotificationFields(
    db, notifications, additionalChargesMod, tenantId) {
  if (!additionalChargesMod) return;
  const need = (notifications || []).filter((n) =>
    n && n.type === NOTIF_TYPE.ADDITIONAL_CHARGE && n.followUpId &&
    (!n.subject || !n.to || !n.receivedAt || !n.dispatcherEmail ||
      !Array.isArray(n.attachments)));
  if (!need.length) return;
  const ids = [...new Set(need.map((n) => n.followUpId))];
  const map = new Map();
  const chunks = [];
  for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));
  try {
    const concurrency = 8;
    for (let i = 0; i < chunks.length; i += concurrency) {
      const batch = chunks.slice(i, i + concurrency);
      // eslint-disable-next-line no-await-in-loop
      const snaps = await Promise.all(batch.map((chunk) =>
        db.collection(additionalChargesMod.FOLLOW_UP_COLLECTION)
            .where(admin.firestore.FieldPath.documentId(), "in", chunk)
            .select(...FOLLOW_LIST_FIELDS)
            .get()));
      snaps.forEach((snap) => {
        snap.forEach((doc) => map.set(doc.id, doc.data() || {}));
      });
    }
  } catch (err) {
    console.error("[listNotifications] charge enrich:", err.message);
    return;
  }
  for (const n of need) {
    const data = map.get(n.followUpId);
    if (!data || !ownership.sameTenant(data.tenantId, n.tenantId || tenantId)) {
      continue;
    }
    n.subject = n.subject || data.emailSubject || null;
    n.to = n.to || data.emailTo || null;
    n.cc = n.cc || data.emailCc || null;
    n.dispatcherEmail = n.dispatcherEmail || data.dispatcherEmail || null;
    n.dispatcherName = n.dispatcherName || data.dispatcherName || null;
    n.ownerBucket = n.ownerBucket || data.ownerBucket || null;
    if (!n.receivedAt) {
      const iso = mailFiles.toIso(data.receivedAt || data.emailReceivedAt);
      if (iso) {
        n.receivedAt = iso;
        n.receivedAtSource = data.receivedAtSource || "mailbox";
      }
    }
    if (!Array.isArray(n.attachments) && Array.isArray(data.attachments)) {
      n.attachments = mailFiles.publicAttachments(data.attachments);
    }
  }
}

/**
 * Email HTML for one notification. Other tenants get not-found.
 * @param {object} db Firestore.
 * @param {object} opts id, tenantId, additionalChargesMod.
 * @return {Promise<object>}
 */
async function loadNotificationDetail(db, opts) {
  const id = String((opts && opts.id) || "").trim();
  const tenantId = String((opts && opts.tenantId) || "default");
  if (!id) return {ok: false, error: "Not found."};
  const snap = await db.collection(NOTIF_COLLECTION).doc(id).get();
  if (!snap.exists) return {ok: false, error: "Not found."};
  const data = snap.data() || {};
  if (!ownership.sameTenant(data.tenantId, tenantId)) {
    return {ok: false, error: "Not found."};
  }
  const n = serializeNotif(snap);
  if (n.type === NOTIF_TYPE.UNHANDLED_EMAIL) {
    n.body = enrichUnhandledNotifBody(n);
  } else if (n.type === NOTIF_TYPE.ADDITIONAL_CHARGE && !n.body &&
      n.followUpId && opts.additionalChargesMod) {
    const follow = await db
        .collection(opts.additionalChargesMod.FOLLOW_UP_COLLECTION)
        .doc(n.followUpId)
        .get();
    if (follow.exists) {
      const followData = follow.data() || {};
      if (ownership.sameTenant(followData.tenantId, tenantId) &&
          followData.emailHtml) {
        n.body = String(followData.emailHtml);
      }
    }
  }
  let body = n.body != null ? String(n.body) : null;
  if (body && body.length > 120000) body = body.slice(0, 120000);
  return {ok: true, body};
}

/**
 * Reads a query in chunks of 200 until no rows remain.
 * Pass maxDocs only to stop early. The dashboard does not.
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
 * Load-number search matches the stored load, or subject, title, or
 * reason text when older rows never saved loadNumber.
 * @param {object} row Serialized notification.
 * @param {string} q Search text, already known to be 5+ digits.
 * @return {boolean}
 */
function notificationMatchesLoadQuery(row, q) {
  const needle = String(q || "").trim();
  if (!needle) return false;
  if (String((row && row.loadNumber) || "") === needle) return true;
  const text = [
    row && row.subject,
    row && row.title,
    row && row.reason,
  ].filter(Boolean).join(" ");
  return text.includes(needle);
}

/**
 * One row per notification document. A load-number lookup must not
 * append a doc the open-status query already returned.
 * @param {object[]} items Serialized notifications.
 * @return {object[]}
 */
function uniqueNotificationsById(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const id = item && item.id ? String(item.id) : "";
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(item);
  }
  return out;
}

/**
 * Lists open notifications for a tenant.
 * Reads every open row. opts.all returns that full set in one page.
 * @param {object} db Firestore.
 * @param {object} opts tenantId, limit, all, sort, q.
 * @return {Promise<object>}
 */
async function listNotifications(db, opts) {
  const tenantId = String(opts.tenantId || "default");
  const q = String(opts.q || "").trim();
  // Newest first, in chunks, until the open set is empty. A 200-row
  // page and a 2,000-row window both hid open mail once the queue
  // grew past them.
  const scope = require("./dashboard-scope");
  const notifName = scope.collectionName({
    collectionPrefix: opts.collectionPrefix,
  }, NOTIF_COLLECTION);
  let base = db.collection(notifName)
      .where("tenantId", "==", tenantId)
      .where("status", "==", NOTIF_STATUS.OPEN)
      .orderBy("createdAt", "desc")
      .select(...NOTIF_LIST_FIELDS);
  if (opts.type) {
    base = db.collection(notifName)
        .where("tenantId", "==", tenantId)
        .where("status", "==", NOTIF_STATUS.OPEN)
        .where("type", "==", String(opts.type))
        .orderBy("createdAt", "desc")
        .select(...NOTIF_LIST_FIELDS);
  }
  const docs = await collectNotifPage(base);
  const notifications = docs.map(serializeNotif)
      .filter((n) => ownership.sameTenant(n.tenantId, tenantId))
      .filter((n) => scope.isOpenNotification(n));

  for (const n of notifications) {
    if (n.type !== NOTIF_TYPE.UNHANDLED_EMAIL) continue;
    if (n.reason && n.subject &&
        !/^\[ACTION REQUIRED\]/i.test(String(n.subject))) {
      n.subject = `[ACTION REQUIRED] ${n.reason} — ${n.subject}`;
    }
    n.body = null;
  }
  await enrichChargeNotificationFields(
      db, notifications, opts.additionalChargesMod, tenantId);

  if (typeof opts.backfillMail === "function") {
    await opts.backfillMail(notifications);
  }

  let visibleNotifications =
    dedupe.collapseExactDuplicateItems(notifications);
  if (/^\d{5,}$/.test(q)) {
    const values = [q, Number(q)];
    const seen = new Set(visibleNotifications.map((n) => n.id));
    for (const value of values) {
      // eslint-disable-next-line no-await-in-loop
      const extraDocs = await collectNotifPage(
          db.collection(notifName)
              .where("loadNumber", "==", value)
              .select(...NOTIF_LIST_FIELDS));
      extraDocs.forEach((doc) => {
        if (seen.has(doc.id)) return;
        const row = serializeNotif(doc);
        if (row.status && row.status !== NOTIF_STATUS.OPEN &&
            row.status !== "open") {
          return;
        }
        if (!ownership.sameTenant(row.tenantId, tenantId)) return;
        seen.add(doc.id);
        visibleNotifications.push(row);
      });
    }
    // A load-number search used to leave the current page in place and only
    // append matches, so the emailed load never stood out. Keep matches only.
    visibleNotifications = visibleNotifications.filter((n) =>
      notificationMatchesLoadQuery(n, q));
  } else if (q) {
    const needle = q.toLowerCase();
    visibleNotifications = visibleNotifications.filter((n) => {
      const hay = [n.loadNumber, n.subject, n.title, n.reason, n.from, n.to]
          .filter(Boolean).join(" ").toLowerCase();
      return hay.includes(needle);
    });
  }
  visibleNotifications = uniqueNotificationsById(visibleNotifications);

  const returnAll = opts.all === true;
  const fullCount = Math.max(visibleNotifications.length, 1);
  const page = ownership.filterSortPaginate(visibleNotifications, {
    ownerBucket: opts.ownerBucket || null,
    dispatcherKey: opts.dispatcherKey || null,
    offset: returnAll ? 0 : opts.offset,
    limit: returnAll ? fullCount : (opts.limit || 50),
    maxLimit: returnAll ? fullCount : opts.maxLimit,
    hardCap: returnAll ? fullCount : null,
    sort: opts.sort || null,
    urgentFirst: opts.urgentFirst,
  });
  page.items.forEach((item) => {
    if (item) item.body = null;
  });

  return {
    notifications: page.items,
    openCount: page.openCount,
    filteredCount: page.filteredCount,
    hasMore: page.hasMore,
    nextOffset: page.nextOffset,
    offset: page.offset,
    limit: page.limit,
    bucketCounts: page.bucketCounts,
    dispatchers: page.dispatchers,
  };
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
  if (!ownership.sameTenant(data.tenantId, opts.tenantId)) {
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
  if (!ownership.sameTenant(data.tenantId, opts.tenantId)) {
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
  const data = snap.data() || {};
  if (!ownership.sameTenant(data.tenantId, opts.tenantId)) {
    return {ok: false, error: "Notification not found."};
  }
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
  let query = db.collection(NOTIF_COLLECTION)
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

module.exports = {
  NOTIF_COLLECTION,
  NOTIF_TYPE,
  NOTIF_STATUS,
  isDashboardOpsPrimary,
  createNotification,
  listNotifications,
  notificationMatchesLoadQuery,
  uniqueNotificationsById,
  loadNotificationDetail,
  dismissNotification,
  flagNotification,
  markActed,
  findOpenByRef,
  serializeNotif,
};
