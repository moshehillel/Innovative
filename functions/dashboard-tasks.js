/**
 * Dashboard task list — items Lisa / Sarah / Dispatch must act on
 * (additional charges, signed POD requests, POD discrepancies, etc.).
 * Unhandled "Jerry doesn't understand" emails are notifications only.
 */

"use strict";

const admin = require("firebase-admin");
const ownership = require("./dashboard-ownership");
const mailFiles = require("./dashboard-email-files");
const dedupe = require("./dashboard-dedupe");

const scope = require("./dashboard-scope");

const TASK_COLLECTION = "dashboardTasks";
const FOLLOW_UP_COLLECTION = "additionalCharges";
const OPEN_SCAN_CAP = 2000;

const TASK_TYPE = Object.freeze({
  HUMAN_REVIEW: "human_review",
  ADDITIONAL_CHARGE: "additional_charge",
  SIGNED_POD: "signed_pod",
  POD_DISCREPANCY: "pod_discrepancy",
  MISSING_RATE: "missing_rate",
});

const TASK_STATUS = Object.freeze({
  OPEN: "open",
  DISMISSED: "dismissed",
});

/**
 * @param {*} value Firestore timestamp or date-like value.
 * @return {string|null}
 */
function isoFrom(value) {
  const ms = dedupe.timestampMs(value);
  return ms == null ? null : new Date(ms).toISOString();
}

/**
 * Loads chargesTotal for follow-ups when the task row did not store it.
 * @param {object} db Firestore.
 * @param {string[]} ids Follow-up ids.
 * @return {Promise<Map<string, *>>}
 */
async function loadFollowUpAmounts(db, ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  const chunks = [];
  for (let i = 0; i < unique.length; i += 10) {
    chunks.push(unique.slice(i, i + 10));
  }
  const snaps = (await Promise.all(chunks.map((chunk) => {
    const refs = chunk.map((id) =>
      db.collection(FOLLOW_UP_COLLECTION).doc(id));
    return db.getAll(...refs);
  }))).flat();
  const amounts = new Map();
  snaps.forEach((snap) => {
    if (!snap.exists) return;
    const total = (snap.data() || {}).chargesTotal;
    if (total != null) amounts.set(snap.id, total);
  });
  return amounts;
}

/**
 * Finds an open task for the same charge, follow-up, or message.
 * @param {object} db Firestore.
 * @param {object} data Incoming task fields.
 * @return {Promise<object|null>}
 */
async function findOpenDuplicateTask(db, data) {
  const loadNumber = String(data.loadNumber || "").trim();
  const messageId = String(data.messageId || "").trim();
  const followUpId = String(data.followUpId || "").trim();
  const tenantId = String(data.tenantId || "default");
  const type = data.type || TASK_TYPE.HUMAN_REVIEW;
  const tasksCol = tenantCollection(db, TASK_COLLECTION, data);
  const invoiceId = String(data.invoiceId || "").trim();
  if (ownership.isMissingRateType(type) && invoiceId) {
    const byInvoice = await tasksCol
        .where("invoiceId", "==", invoiceId)
        .limit(20)
        .get();
    const match = byInvoice.docs.find((doc) => {
      const row = doc.data() || {};
      if ((row.status || "") !== TASK_STATUS.OPEN) return false;
      if (!ownership.sameTenant(row.tenantId, tenantId)) return false;
      return ownership.isMissingRateType(row.type);
    });
    if (match) {
      return {
        id: match.id,
        ref: match.ref,
        data: match.data() || {},
        item: {},
      };
    }
  }
  let docs = [];
  if (loadNumber) {
    const snap = await tasksCol
        .where("loadNumber", "==", loadNumber)
        .limit(200)
        .get();
    docs = snap.docs;
  } else if (messageId) {
    const snap = await tasksCol
        .where("messageId", "==", messageId)
        .limit(20)
        .get();
    docs = snap.docs;
  } else if (followUpId) {
    const snap = await tasksCol
        .where("followUpId", "==", followUpId)
        .limit(20)
        .get();
    docs = snap.docs;
  } else {
    return null;
  }

  const openDocs = docs.filter((doc) => {
    const row = doc.data() || {};
    if ((row.status || "") !== TASK_STATUS.OPEN) return false;
    return String(row.tenantId || "default") === tenantId;
  });
  const amounts = await loadFollowUpAmounts(db, openDocs
      .filter((doc) => {
        const row = doc.data() || {};
        return row.chargesTotal == null && row.followUpId;
      })
      .map((doc) => doc.data().followUpId));
  const incoming = {
    type,
    loadNumber: loadNumber || null,
    reason: data.reason || data.category || null,
    chargesTotal: data.chargesTotal,
    messageId: messageId || null,
    followUpId: followUpId || null,
  };
  let best = null;
  for (const doc of openDocs) {
    const row = doc.data() || {};
    const candidate = {
      type: row.type || null,
      loadNumber: row.loadNumber || null,
      reason: row.reason || null,
      chargesTotal: row.chargesTotal != null ? row.chargesTotal :
        amounts.get(row.followUpId),
      messageId: row.messageId || null,
      followUpId: row.followUpId || null,
      chargePhase: row.chargePhase || null,
      followUpStatus: row.followUpStatus || null,
      createdAt: isoFrom(row.createdAt),
      receivedAt: isoFrom(row.receivedAt),
      emailReceivedAt: isoFrom(row.emailReceivedAt),
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
 * Creates an open dashboard task (fire-and-forget safe).
 * Reuses an open task when this is the same additional charge.
 * @param {object} db Firestore instance.
 * @param {object} data Task fields.
 * @return {Promise<string|null>} Doc id or null on failure.
 */
async function createDashboardTask(db, data) {
  try {
    const MAX_BODY = 120000;
    let body = data.body != null ? String(data.body) : null;
    if (body && body.length > MAX_BODY) body = body.slice(0, MAX_BODY);
    const owner = ownership.ownershipFieldsForCreate(data);
    const mail = mailFiles.fieldsForCreate(data);
    try {
      const existing = await findOpenDuplicateTask(db, data);
      if (existing) {
        const patch = {};
        if (body) patch.body = body;
        if (data.subject) patch.subject = data.subject;
        if (data.chargesTotal != null &&
            existing.data.chargesTotal == null) {
          patch.chargesTotal = data.chargesTotal;
        }
        if (data.messageId && !existing.data.messageId) {
          patch.messageId = data.messageId;
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
        if (ownership.isMissingRateType(data.type)) {
          if (data.dispatcherEmail && !existing.data.dispatcherEmail) {
            patch.dispatcherEmail = ownership.normEmail(data.dispatcherEmail);
            patch.dispatcherName = data.dispatcherName ||
              existing.data.dispatcherName || null;
            patch.dispatcherKey = patch.dispatcherEmail ||
              (patch.dispatcherName ?
                String(patch.dispatcherName).trim().toLowerCase() : null);
          }
          if (existing.data.ownerBucket !== ownership.OWNER_BUCKET.DISPATCH) {
            patch.ownerBucket = ownership.OWNER_BUCKET.DISPATCH;
            patch.awaitingReplyFrom = ownership.OWNER_BUCKET.DISPATCH;
          }
          if (data.dispatcherResolved && !existing.data.dispatcherResolved) {
            patch.dispatcherResolved = true;
          }
        }
        if (Object.keys(patch).length) {
          patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
          await existing.ref.update(patch);
        }
        console.log(
            "[createDashboardTask] exact duplicate open task — reused",
            existing.id, data.loadNumber || "", data.chargesTotal,
            data.reason || "");
        return existing.id;
      }
    } catch (dedupeErr) {
      console.error("[createDashboardTask] dedupe lookup failed:",
          dedupeErr.message);
    }
    const doc = await tenantCollection(db, TASK_COLLECTION, data).add({
      tenantId: data.tenantId || "default",
      type: data.type || TASK_TYPE.HUMAN_REVIEW,
      title: data.title || "Action required",
      description: data.description || null,
      body,
      subject: data.subject || null,
      from: data.from || null,
      to: data.to || null,
      cc: data.cc || null,
      loadNumber: data.loadNumber || null,
      proNumber: data.proNumber || null,
      carrierName: data.carrierName || null,
      messageId: data.messageId || null,
      invoiceId: data.invoiceId || null,
      followUpId: data.followUpId || null,
      department: data.department || null,
      reason: data.reason || null,
      chargesTotal: data.chargesTotal != null ? data.chargesTotal : null,
      ...owner,
      ...mail,
      status: TASK_STATUS.OPEN,
      ...(data.dispatcherResolved ? {dispatcherResolved: true} : {}),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      dismissedAt: null,
    });
    return doc.id;
  } catch (err) {
    console.error("[createDashboardTask] failed:", err.message);
    return null;
  }
}

/**
 * @param {object} doc Firestore document snapshot.
 * @return {object}
 */
function serializeTaskDoc(doc) {
  const d = doc.data() || {};
  return {
    id: doc.id,
    source: "dashboardTasks",
    tenantId: d.tenantId || null,
    type: d.type || null,
    title: d.title || null,
    description: d.description || null,
    body: d.body || null,
    subject: d.subject || null,
    from: d.from || null,
    to: d.to || null,
    cc: d.cc || null,
    loadNumber: d.loadNumber || null,
    proNumber: d.proNumber || null,
    carrierName: d.carrierName || null,
    messageId: d.messageId || null,
    invoiceId: d.invoiceId || null,
    followUpId: d.followUpId || null,
    department: d.department || null,
    reason: d.reason || null,
    status: d.status || null,
      chargesTotal: d.chargesTotal != null ? d.chargesTotal : null,
      ownerBucket: d.ownerBucket || null,
      awaitingReplyFrom: d.awaitingReplyFrom || null,
      dispatcherEmail: d.dispatcherEmail || null,
      dispatcherName: d.dispatcherName || null,
      dispatcherKey: d.dispatcherKey || null,
      chargePhase: d.chargePhase || null,
      followUpStatus: d.followUpStatus || null,
      ownershipHistory: Array.isArray(d.ownershipHistory) ?
        d.ownershipHistory : [],
      ...mailFiles.serializeMailFields(d),
      createdAt: d.createdAt && d.createdAt.toDate ?
        d.createdAt.toDate().toISOString() : null,
      dismissedAt: d.dismissedAt && d.dismissedAt.toDate ?
        d.dismissedAt.toDate().toISOString() : null,
  };
}

/**
 * Rebuilds the same additional-charge approval HTML the email uses when the
 * original body was not stored on the follow-up / task.
 * @param {object} additionalChargesMod additional-charges module.
 * @param {object} d Follow-up doc data.
 * @return {string}
 */
function buildAdditionalChargeFallbackHtml(additionalChargesMod, d) {
  try {
    const baseUrl = process.env.FUNCTION_BASE_URL ||
      "https://us-central1-tai-invoice-automation.cloudfunctions.net";
    const email = additionalChargesMod.buildAdditionalChargeApprovalEmail({
      baseUrl,
      invoiceId: d.invoiceId || "unknown",
      tenantId: d.tenantId || "default",
      loadNumber: d.loadNumber,
      carrierName: d.carrierName,
      customerName: d.customerName,
      invoiceAmount: d.invoiceAmount,
      primusAmount: d.primusAmount != null ? d.primusAmount : null,
      charges: Array.isArray(d.charges) ? d.charges : [],
      chargesTotal: d.chargesTotal,
      category: d.category,
      freightMismatch: d.freightMismatch || null,
      hasCertificate: Boolean(d.hasCertificate),
      dispatcherName: d.dispatcherName || null,
      rateValidation: d.rateValidation || null,
      customerRate: d.customerRate != null ? d.customerRate : null,
      excludedInPrimusCount: d.excludedInPrimusCount || 0,
    });
    if (email && email.html) return String(email.html);
  } catch (err) {
    console.error("[buildAdditionalChargeFallbackHtml]", err.message);
  }
  const esc = (v) => String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const money = (n) => {
    const num = Number(n);
    return Number.isFinite(num) ? `$${num.toFixed(2)}` : "—";
  };
  const charges = Array.isArray(d.charges) ? d.charges : [];
  const rows = charges.map((c) => {
    const name = esc(c.name || c.description || c.type || "Charge");
    const amt = money(c.amount != null ? c.amount : c.total);
    return `<tr><td style="padding:6px 12px 6px 0">${name}</td>` +
      `<td style="padding:6px 0;text-align:right">${amt}</td></tr>`;
  }).join("");
  return `<div style="font-family:Arial,sans-serif;color:#111827;font-size:15px;line-height:1.55">` +
    `<p style="margin:0 0 12px"><strong>Additional charge approval</strong></p>` +
    `<table style="border-collapse:collapse;font-size:14px;margin:0 0 14px">` +
    `<tr><td style="padding:4px 16px 4px 0;color:#6b7280;font-weight:600">Load</td>` +
    `<td>${esc(d.loadNumber || "—")}</td></tr>` +
    `<tr><td style="padding:4px 16px 4px 0;color:#6b7280;font-weight:600">Carrier</td>` +
    `<td>${esc(d.carrierName || "—")}</td></tr>` +
    (d.customerName ?
      `<tr><td style="padding:4px 16px 4px 0;color:#6b7280;font-weight:600">Customer</td>` +
      `<td>${esc(d.customerName)}</td></tr>` : "") +
    `<tr><td style="padding:4px 16px 4px 0;color:#6b7280;font-weight:600">Category</td>` +
    `<td>${esc(d.category || d.status || "—")}</td></tr>` +
    `<tr><td style="padding:4px 16px 4px 0;color:#6b7280;font-weight:600">Invoice amount</td>` +
    `<td>${money(d.invoiceAmount)}</td></tr>` +
    `<tr><td style="padding:4px 16px 4px 0;color:#6b7280;font-weight:600">Charges total</td>` +
    `<td><strong>${money(d.chargesTotal)}</strong></td></tr>` +
    `</table>` +
    (rows ?
      `<p style="margin:0 0 6px;font-weight:700">Charge lines</p>` +
      `<table style="border-collapse:collapse;width:100%;max-width:420px">${rows}</table>` :
      "") +
    (d.notes ?
      `<p style="margin:14px 0 0"><em>${esc(d.notes)}</em></p>` : "") +
    `<p style="margin:16px 0 0;color:#374151">Choose A–E below to decide.</p>` +
    `</div>`;
}

/**
 * Copies mailbox time and attachments from a follow-up onto a task row.
 * @param {object} target Serialized task.
 * @param {object} source Follow-up data.
 * @return {void}
 */
function applyStoredMail(target, source) {
  if (!target || !source) return;
  if (!target.receivedAt) {
    const iso = mailFiles.toIso(source.receivedAt || source.emailReceivedAt);
    if (iso) {
      target.receivedAt = iso;
      target.receivedAtSource = source.receivedAtSource || "mailbox";
    }
  }
  if (!Array.isArray(target.attachments)) {
    const raw = Array.isArray(source.attachments) ? source.attachments :
      (Array.isArray(source.mailboxAttachments) ?
        source.mailboxAttachments : null);
    if (raw) target.attachments = mailFiles.publicAttachments(raw);
  }
}

/** Fields needed to filter, sort, and count. Email HTML is loaded later. */
const TASK_LIST_FIELDS = [
  "tenantId", "type", "title", "description", "subject", "from", "to", "cc",
  "loadNumber", "proNumber", "carrierName", "messageId", "invoiceId",
  "followUpId", "department", "reason", "status", "chargesTotal",
  "ownerBucket", "awaitingReplyFrom", "dispatcherEmail", "dispatcherName",
  "dispatcherKey", "chargePhase", "followUpStatus", "ownershipHistory",
  "receivedAt", "receivedAtSource", "emailReceivedAt", "attachments",
  "mailboxLookupAt", "createdAt", "dismissedAt",
];

/** Follow-up fields for list/merge. Excludes emailHtml. */
const CHARGE_LIST_FIELDS = [
  "tenantId", "status", "chargePhase", "notes", "emailSubject", "emailTo",
  "emailCc", "loadNumber", "carrierName", "messageId", "invoiceId",
  "category", "chargesTotal", "invoiceAmount", "ownerBucket",
  "awaitingReplyFrom", "dispatcherEmail", "dispatcherName", "dispatcherKey",
  "ownershipHistory", "receivedAt", "emailReceivedAt", "receivedAtSource",
  "attachments", "mailboxAttachments", "createdAt", "resolved",
];

const PAGE_BODY_CAP = 120000;

/**
 * @param {*} value Email HTML or text.
 * @return {string|null}
 */
function capEmailBody(value) {
  if (value == null || value === "") return null;
  const text = String(value);
  if (text.length <= PAGE_BODY_CAP) return text;
  return text.slice(0, PAGE_BODY_CAP);
}

/**
 * @param {object} db Firestore.
 * @param {string} collectionName Collection.
 * @param {string[]} ids Document ids.
 * @return {Promise<Map<string, object>>}
 */
async function loadDocsById(db, collectionName, ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  const snaps = [];
  for (let i = 0; i < unique.length; i += 50) {
    const refs = unique.slice(i, i + 50).map((id) =>
      db.collection(collectionName).doc(id));
    // eslint-disable-next-line no-await-in-loop
    snaps.push(...await db.getAll(...refs));
  }
  const map = new Map();
  snaps.forEach((snap) => {
    if (snap.exists) map.set(snap.id, snap.data() || {});
  });
  return map;
}

/**
 * Loads email HTML only for the rows that will be returned.
 * The list query omits bodies so a few hundred open tasks cannot
 * exceed the function memory limit.
 * @param {object} db Firestore.
 * @param {object} additionalChargesMod additional-charges module.
 * @param {object[]} items Page items.
 * @return {Promise<void>}
 */
async function hydratePageBodies(db, additionalChargesMod, items, tenantId) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return;
  const taskIds = [];
  const followIds = [];
  for (const item of list) {
    if (item.source !== "additionalCharges" && item.id) taskIds.push(item.id);
    const followId = item.followUpId ||
      (item.source === "additionalCharges" ? item.id : null);
    if (followId) followIds.push(followId);
  }
  const [taskDocs, followDocs] = await Promise.all([
    loadDocsById(db, TASK_COLLECTION, taskIds),
    loadDocsById(
        db, additionalChargesMod.FOLLOW_UP_COLLECTION, followIds),
  ]);
  for (const item of list) {
    const followId = item.followUpId ||
      (item.source === "additionalCharges" ? item.id : null);
    let follow = followId ? followDocs.get(followId) : null;
    if (follow && tenantId &&
        !ownership.sameTenant(follow.tenantId, tenantId)) {
      follow = null;
    }
    const taskDoc = item.source !== "additionalCharges" ?
      taskDocs.get(item.id) : null;
    const stored = taskDoc ? capEmailBody(taskDoc.body) : null;
    const emailHtml = follow ? capEmailBody(follow.emailHtml) : null;
    if (item.source === "additionalCharges") {
      item.body = emailHtml || (follow ?
        buildAdditionalChargeFallbackHtml(additionalChargesMod, follow) :
        null);
    } else if (stored || emailHtml) {
      item.body = stored || emailHtml;
    } else if (follow && item.type === TASK_TYPE.ADDITIONAL_CHARGE) {
      item.body = buildAdditionalChargeFallbackHtml(
          additionalChargesMod, follow);
    }
  }
}

/**
 * Pages a descending query so open work is not cut off at the newest N rows.
 * @param {FirebaseFirestore.Query} baseQuery Query with orderBy already set.
 * @param {number} maxDocs Cap.
 * @return {Promise<object[]>}
 */
async function collectPaged(baseQuery, maxDocs) {
  const pageSize = 200;
  const docs = [];
  let last = null;
  while (docs.length < maxDocs) {
    let query = baseQuery.limit(Math.min(pageSize, maxDocs - docs.length));
    if (last) query = query.startAfter(last);
    // eslint-disable-next-line no-await-in-loop
    const snap = await query.get();
    if (snap.empty) break;
    docs.push(...snap.docs);
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < pageSize) break;
  }
  return docs;
}

/**
 * @param {object} db Firestore.
 * @param {string} base Collection base name.
 * @param {object} opts collectionPrefix.
 * @return {FirebaseFirestore.CollectionReference}
 */
function tenantCollection(db, base, opts) {
  const name = scope.collectionName({
    collectionPrefix: opts && opts.collectionPrefix,
  }, base);
  return db.collection(name);
}

/**
 * Loads open rows for the shared collection. Tasks and charges are stored
 * once and separated by tenantId, so a prefixed collection is included only
 * when it is a different name.
 * @param {object} db Firestore.
 * @param {string} base Collection name.
 * @param {object} opts collectionPrefix.
 * @param {Function} buildQuery Receives a collection and returns a query.
 * @param {number} maxDocs Cap.
 * @return {Promise<object[]>}
 */
async function loadScopedPages(db, base, _opts, buildQuery, maxDocs) {
  const cap = Math.min(Math.max(Number(maxDocs) || 2000, 1), 2000);
  // Shared collections are partitioned by tenantId. A prefixed name is a
  // different collection and is not indexed for these list queries.
  return collectPaged(buildQuery(db.collection(base)), cap);
}

async function listDashboardTasks(db, additionalChargesMod, opts) {
  const tenantId = String(opts.tenantId || "default");
  // Open rows are kept until someone finishes them. The old 300-row cap
  // hid anything older than about two weeks once the queue filled up.
  const fetchLimit = Math.min(
      Math.max(Number(opts.fetchLimit) || 2000, 50), 2000);

  const taskDocs = await loadScopedPages(db, TASK_COLLECTION, opts, (col) =>
    col.where("tenantId", "==", tenantId)
        .where("status", "==", TASK_STATUS.OPEN)
        .orderBy("createdAt", "desc")
        .select(...TASK_LIST_FIELDS), fetchLimit);
  const taskSnap = {docs: taskDocs};

  // Drop legacy human_review rows — those belong in Notifications.
  const tasks = taskSnap.docs.map(serializeTaskDoc)
      .filter((t) => t.type !== TASK_TYPE.HUMAN_REVIEW)
      .filter((t) => ownership.sameTenant(t.tenantId, tenantId));
  const linkedFollowUpIds = new Set(
      tasks.map((t) => t.followUpId).filter(Boolean),
  );

  const chargeDocs = await loadScopedPages(
      db, additionalChargesMod.FOLLOW_UP_COLLECTION, opts, (col) =>
        col.where("resolved", "==", false)
            .orderBy("createdAt", "desc")
            .select(...CHARGE_LIST_FIELDS), fetchLimit);
  const chargeSnap = {docs: chargeDocs};

  // Copy routing fields onto linked tasks. Email HTML stays off this path.
  for (const task of tasks) {
    if (task.type !== TASK_TYPE.ADDITIONAL_CHARGE) continue;
    let fuDoc = task.followUpId ?
      chargeSnap.docs.find((x) => x.id === task.followUpId) : null;
    if (task.followUpId && !fuDoc) {
      // eslint-disable-next-line no-await-in-loop
      const missed = await db
          .collection(additionalChargesMod.FOLLOW_UP_COLLECTION)
          .where(admin.firestore.FieldPath.documentId(), "==",
              task.followUpId)
          .select(...CHARGE_LIST_FIELDS)
          .limit(1)
          .get();
      if (!missed.empty) fuDoc = missed.docs[0];
    }
    if (fuDoc) {
      const d = fuDoc.data() || {};
      if (!ownership.sameTenant(d.tenantId, tenantId)) continue;
      task.subject = task.subject || d.emailSubject || null;
      task.to = task.to || d.emailTo || null;
      task.cc = task.cc || d.emailCc || null;
      if (task.chargesTotal == null) task.chargesTotal = d.chargesTotal || null;
      task.dispatcherEmail = task.dispatcherEmail || d.dispatcherEmail || null;
      task.dispatcherName = task.dispatcherName || d.dispatcherName || null;
      task.ownerBucket = task.ownerBucket || d.ownerBucket || null;
      task.awaitingReplyFrom = task.awaitingReplyFrom ||
        d.awaitingReplyFrom || null;
      applyStoredMail(task, d);
    }
  }

  chargeSnap.docs.forEach((doc) => {
    if (linkedFollowUpIds.has(doc.id)) return;
    const d = doc.data() || {};
    // Shared collection. A missing tenantId is the legacy default tenant,
    // not a pass for every client.
    if (!ownership.sameTenant(d.tenantId, tenantId)) return;
    const isDispute = d.status ===
      additionalChargesMod.FOLLOW_UP_STATUS.DISPUTING ||
      d.chargePhase === "dispute";
    tasks.push({
      id: doc.id,
      source: "additionalCharges",
      tenantId: d.tenantId || tenantId,
      type: TASK_TYPE.ADDITIONAL_CHARGE,
      title: isDispute ?
        `Charge in dispute — Load ${d.loadNumber || "—"}` :
        `Additional charge — Load ${d.loadNumber || "—"}`,
      description: d.notes || null,
      body: null,
      subject: d.emailSubject || null,
      from: null,
      to: d.emailTo || null,
      cc: d.emailCc || null,
      loadNumber: d.loadNumber || null,
      proNumber: null,
      carrierName: d.carrierName || null,
      messageId: d.messageId || null,
      invoiceId: d.invoiceId || null,
      followUpId: doc.id,
      department: null,
      reason: d.category || d.status || null,
      status: "open",
      chargesTotal: d.chargesTotal || null,
      invoiceAmount: d.invoiceAmount || null,
      ownerBucket: d.ownerBucket || null,
      awaitingReplyFrom: d.awaitingReplyFrom || null,
      dispatcherEmail: d.dispatcherEmail || null,
      dispatcherName: d.dispatcherName || null,
      dispatcherKey: d.dispatcherKey || null,
      chargePhase: isDispute ? "dispute" : (d.chargePhase || null),
      followUpStatus: d.status || null,
      ownershipHistory: Array.isArray(d.ownershipHistory) ?
        d.ownershipHistory : [],
      ...mailFiles.serializeMailFields({
        ...d,
        receivedAt: d.receivedAt || d.emailReceivedAt || null,
      }),
      createdAt: d.createdAt && d.createdAt.toDate ?
        d.createdAt.toDate().toISOString() : null,
      dismissedAt: null,
    });
  });

  // Enrich linked tasks with follow-up dispute status.
  for (const task of tasks) {
    if (task.type !== TASK_TYPE.ADDITIONAL_CHARGE || !task.followUpId) continue;
    const fuDoc = chargeSnap.docs.find((x) => x.id === task.followUpId);
    if (!fuDoc) continue;
    const d = fuDoc.data() || {};
    if (!ownership.sameTenant(d.tenantId, tenantId)) continue;
    task.followUpStatus = d.status || task.followUpStatus || null;
    if (d.status === additionalChargesMod.FOLLOW_UP_STATUS.DISPUTING ||
        d.chargePhase === "dispute" || task.chargePhase === "dispute") {
      task.chargePhase = "dispute";
    }
  }

  if (typeof opts.backfillMail === "function" && !opts.skipHydrate) {
    await opts.backfillMail(tasks);
  }

  const visibleTasks = dedupe.collapseExactDuplicateItems(tasks);

  const chargePhase = String(opts.chargePhase || "").toLowerCase();
  let working = visibleTasks;
  if (chargePhase === "dispute") {
    working = visibleTasks.filter((t) => t.chargePhase === "dispute");
  } else if (chargePhase === "all") {
    working = visibleTasks;
  } else if (chargePhase === "open" || !chargePhase) {
    // Default task folders hide items already in dispute.
    working = visibleTasks.filter((t) => t.chargePhase !== "dispute");
  }

  const disputeCount = visibleTasks.filter((t) =>
    t.chargePhase === "dispute").length;

  if (opts.unpaged) {
    return {
      tasks: working.map((task) => ({
        ...task,
        issueType: task.issueType || scope.classifyIssue(task),
      })),
      disputeCount,
      openCount: working.length,
    };
  }

  const page = ownership.filterSortPaginate(working, {
    ownerBucket: chargePhase === "dispute" ?
      null : (opts.ownerBucket || null),
    dispatcherKey: chargePhase === "dispute" ?
      null : (opts.dispatcherKey || null),
    offset: opts.offset,
    limit: opts.limit || 50,
    maxLimit: opts.maxLimit,
    urgentFirst: opts.urgentFirst,
  });

  if (!opts.skipHydrate) {
    await hydratePageBodies(db, additionalChargesMod, page.items, tenantId);
  }

  return {
    tasks: page.items,
    openCount: page.openCount,
    filteredCount: page.filteredCount,
    hasMore: page.hasMore,
    nextOffset: page.nextOffset,
    offset: page.offset,
    limit: page.limit,
    bucketCounts: page.bucketCounts,
    dispatchers: page.dispatchers,
    disputeCount,
  };
}

/**
 * Dismisses a dashboard task or resolves an additional-charge follow-up.
 * @param {object} db Firestore instance.
 * @param {object} additionalChargesMod additional-charges module.
 * @param {object} opts taskId, source, tenantId.
 * @return {Promise<object>} {ok: boolean, error?: string}
 */
async function dismissDashboardTask(db, additionalChargesMod, opts) {
  const taskId = String(opts.taskId || "").trim();
  const source = String(opts.source || "dashboardTasks");
  if (!taskId) {
    return {ok: false, error: "taskId is required."};
  }

  if (source === "additionalCharges") {
    const ref = db.collection(additionalChargesMod.FOLLOW_UP_COLLECTION)
        .doc(taskId);
    const snap = await ref.get();
    if (!snap.exists) {
      return {ok: false, error: "Task not found."};
    }
    const charge = snap.data() || {};
    if (!ownership.sameTenant(charge.tenantId, opts.tenantId)) {
      return {ok: false, error: "Task not found."};
    }
    await ref.update({
      resolved: true,
      status: additionalChargesMod.FOLLOW_UP_STATUS.RESOLVED,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return {ok: true};
  }

  const ref = db.collection(TASK_COLLECTION).doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) {
    return {ok: false, error: "Task not found."};
  }
  const data = snap.data() || {};
  if (!ownership.sameTenant(data.tenantId, opts.tenantId)) {
    return {ok: false, error: "Task not found."};
  }
  await ref.update({
    status: TASK_STATUS.DISMISSED,
    dismissedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return {ok: true};
}

/**
 * Keeps a charge task open and marks it as in dispute (option D).
 * @param {object} db Firestore.
 * @param {object} additionalChargesMod Module.
 * @param {object} opts taskId?, followUpId?, invoiceId?, tenantId, source?
 * @return {Promise<object>}
 */
async function markTaskInDispute(db, additionalChargesMod, opts) {
  const updates = [];
  const patch = {
    chargePhase: "dispute",
    followUpStatus: additionalChargesMod.FOLLOW_UP_STATUS.DISPUTING,
    awaitingReplyFrom: "accounting",
    ownerBucket: ownership.OWNER_BUCKET.ACCOUNTING,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (opts.taskId && opts.source !== "additionalCharges") {
    const ref = db.collection(TASK_COLLECTION).doc(String(opts.taskId));
    const snap = await ref.get();
    if (snap.exists &&
        ownership.sameTenant((snap.data() || {}).tenantId, opts.tenantId)) {
      await ref.update(patch);
      updates.push("task");
    }
  }

  const followUpId = opts.followUpId ||
    (opts.source === "additionalCharges" ? opts.taskId : null);
  if (followUpId) {
    const ref = db.collection(additionalChargesMod.FOLLOW_UP_COLLECTION)
        .doc(String(followUpId));
    const snap = await ref.get();
    if (snap.exists &&
        ownership.sameTenant((snap.data() || {}).tenantId, opts.tenantId)) {
      await ref.update({
        status: additionalChargesMod.FOLLOW_UP_STATUS.DISPUTING,
        chargePhase: "dispute",
        resolved: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      updates.push("followUp");
    }
  }

  if (opts.invoiceId) {
    const q = await db.collection(TASK_COLLECTION)
        .where("invoiceId", "==", String(opts.invoiceId))
        .where("status", "==", TASK_STATUS.OPEN)
        .limit(10)
        .get();
    for (const doc of q.docs) {
      const row = doc.data() || {};
      if (!ownership.sameTenant(row.tenantId, opts.tenantId)) continue;
      // eslint-disable-next-line no-await-in-loop
      await doc.ref.update(patch);
      updates.push(doc.id);
    }
  }

  return {ok: true, updates};
}

/**
 * Moves a Sarah-owned task into the dispatcher folder after dashboard action.
 * @param {object} db Firestore.
 * @param {object} additionalChargesMod Module.
 * @param {object} opts taskId?, followUpId?, invoiceId?, tenantId, option.
 * @return {Promise<object>}
 */
async function handoffTaskToDispatch(db, additionalChargesMod, opts) {
  const option = String(opts.option || "").toLowerCase();
  const updates = [];

  if (opts.taskId && opts.source !== "additionalCharges") {
    const ref = db.collection(TASK_COLLECTION).doc(String(opts.taskId));
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() || {};
      if (ownership.sameTenant(data.tenantId, opts.tenantId)) {
        await ref.update(ownership.handoffToDispatchUpdate(data, {
          reason: "sarah_dashboard_action",
          option,
        }));
        updates.push("task");
      }
    }
  }

  const followUpId = opts.followUpId ||
    (opts.source === "additionalCharges" ? opts.taskId : null);
  if (followUpId) {
    const ref = db.collection(additionalChargesMod.FOLLOW_UP_COLLECTION)
        .doc(String(followUpId));
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() || {};
      if (ownership.sameTenant(data.tenantId, opts.tenantId)) {
        await ref.update(ownership.handoffToDispatchUpdate(data, {
          reason: "sarah_dashboard_action",
          option,
        }));
        updates.push("followUp");
      }
    }
  }

  if (opts.invoiceId) {
    const q = await db.collection(TASK_COLLECTION)
        .where("invoiceId", "==", String(opts.invoiceId))
        .where("status", "==", TASK_STATUS.OPEN)
        .limit(10)
        .get();
    for (const doc of q.docs) {
      const data = doc.data() || {};
      if (!ownership.sameTenant(data.tenantId, opts.tenantId)) continue;
      // eslint-disable-next-line no-await-in-loop
      await doc.ref.update(ownership.handoffToDispatchUpdate(data, {
        reason: "sarah_dashboard_action",
        option,
      }));
      updates.push(doc.id);
    }
  }

  return {ok: true, updates};
}

/**
 * Fields for a dispatcher-owned missing-rate task.
 * @param {object} opts Load and dispatcher fields.
 * @return {object}
 */
function missingRateTaskPayload(opts) {
  const loadNumber = opts.loadNumber || null;
  const dispatcherEmail = opts.dispatcherEmail ?
    ownership.normEmail(opts.dispatcherEmail) : null;
  const dispatcherName = opts.dispatcherName ?
    String(opts.dispatcherName).trim() : null;
  return {
    tenantId: opts.tenantId || "default",
    collectionPrefix: opts.collectionPrefix || "",
    type: TASK_TYPE.MISSING_RATE,
    title: `Missing carrier rate — Load ${loadNumber || "—"}`,
    description: "The carrier rate is missing. The dispatcher needs to reply.",
    body: opts.body || null,
    subject: opts.subject ||
      `Action needed — missing carrier rate — Load ${loadNumber || "—"}`,
    to: dispatcherEmail,
    cc: opts.cc || null,
    loadNumber,
    proNumber: opts.proNumber || null,
    carrierName: opts.carrierName || null,
    invoiceId: opts.invoiceId || null,
    reason: "MISSING_RATE",
    invoiceAmount: opts.invoiceAmount != null ? opts.invoiceAmount : null,
    ownerBucket: ownership.OWNER_BUCKET.DISPATCH,
    dispatcherEmail,
    dispatcherName,
    ownershipReason: "missing_carrier_rate",
    dispatcherResolved: opts.dispatcherResolved === true,
  };
}

/**
 * Opens dispatcher tasks for invoices already held on a missing rate.
 * Does not move low-margin holds. Dispatcher lookup is capped per call.
 * @param {object} db Firestore.
 * @param {object} invoicesCol Tenant invoice collection.
 * @param {object} opts tenantId, resolveDispatcher(inv).
 * @return {Promise<object>}
 */
async function ensureMissingRateDispatchTasks(db, invoicesCol, opts) {
  if (!invoicesCol || typeof invoicesCol.where !== "function") {
    return {ensured: 0};
  }
  const tenantId = String((opts && opts.tenantId) || "default");
  let snap;
  try {
    snap = await invoicesCol
        .where("decisionStage", "==", "needs_customer_rate_review")
        .limit(40)
        .get();
  } catch (err) {
    console.error("[ensureMissingRateDispatchTasks]", err.message);
    return {ensured: 0};
  }
  let ensured = 0;
  let lookupsLeft = 5;
  for (const doc of snap.docs) {
    const inv = doc.data() || {};
    if (!ownership.isMissingCarrierRateHold(inv)) continue;
    try {
    // eslint-disable-next-line no-await-in-loop
    const existing = await findOpenDuplicateTask(db, {
      tenantId,
      collectionPrefix: opts.collectionPrefix,
      type: TASK_TYPE.MISSING_RATE,
      invoiceId: doc.id,
      loadNumber: inv.loadNumber || null,
      reason: "MISSING_RATE",
    });
    if (existing && (existing.data.dispatcherEmail ||
        existing.data.dispatcherResolved)) {
      continue;
    }
    let dispatcherEmail = inv.dispatcherEmail || null;
    let dispatcherName = inv.dispatcherName || null;
    let lookedUp = false;
    if (!dispatcherEmail && lookupsLeft > 0 &&
        typeof opts.resolveDispatcher === "function") {
      lookupsLeft -= 1;
      lookedUp = true;
      try {
        // eslint-disable-next-line no-await-in-loop
        const found = await opts.resolveDispatcher(inv);
        if (found && found.email) {
          dispatcherEmail = found.email;
          dispatcherName = found.name || dispatcherName;
        }
      } catch (err) {
        console.error("[ensureMissingRateDispatchTasks] dispatcher:",
            err.message);
      }
    }
    if (existing && !dispatcherEmail) {
      if (lookedUp) {
        // eslint-disable-next-line no-await-in-loop
        await existing.ref.update({
          dispatcherResolved: true,
          ownerBucket: ownership.OWNER_BUCKET.DISPATCH,
          awaitingReplyFrom: ownership.OWNER_BUCKET.DISPATCH,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const id = await createDashboardTask(db, missingRateTaskPayload({
      tenantId,
      collectionPrefix: opts.collectionPrefix,
      loadNumber: inv.loadNumber,
      proNumber: inv.proNumber,
      carrierName: inv.carrierName,
      invoiceId: doc.id,
      invoiceAmount: inv.invoiceAmount,
      dispatcherEmail,
      dispatcherName,
      dispatcherResolved: lookedUp || Boolean(dispatcherEmail),
    }));
    if (id) ensured += 1;
    } catch (err) {
      console.error("[ensureMissingRateDispatchTasks] row:", err.message);
    }
  }
  return {ensured};
}

/**
 * Moves a task to accounting, Sarah, or a dispatcher and records history.
 * Does not send email; the HTTP handler does that once.
 * @param {object} db Firestore.
 * @param {object} opts taskId, source, tenantId, collectionPrefix, bucket,
 *   dispatcherEmail, dispatcherName.
 * @return {Promise<object>}
 */
async function reassignDashboardWork(db, opts) {
  const bucket = String(opts.bucket || "").toLowerCase();
  if (!["accounting", "sarah", "dispatch"].includes(bucket)) {
    return {ok: false, error: "Pick accounting, Sarah, or a dispatcher."};
  }
  const dispatcherEmail = ownership.normEmail(opts.dispatcherEmail) || null;
  const dispatcherName = opts.dispatcherName ?
    String(opts.dispatcherName).trim() : null;
  if (bucket === "dispatch" && !dispatcherEmail && !dispatcherName) {
    return {ok: false, error: "Enter the dispatcher name or email."};
  }
  const taskId = String(opts.taskId || "").trim();
  if (!taskId) return {ok: false, error: "taskId is required."};

  const source = String(opts.source || "dashboardTasks");
  const colName = source === "additionalCharges" ?
    (opts.followUpCollection || "additionalCharges") : TASK_COLLECTION;
  const ref = tenantCollection(db, colName, opts).doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) return {ok: false, error: "Task not found."};
  const data = snap.data() || {};
  if (!ownership.sameTenant(data.tenantId, opts.tenantId || "default")) {
    return {ok: false, error: "Task not found."};
  }
  const history = Array.isArray(data.ownershipHistory) ?
    data.ownershipHistory.slice() : [];
  history.push({
    bucket,
    at: new Date().toISOString(),
    reason: "dashboard_reassign",
    dispatcherEmail,
  });
  const patch = {
    ownerBucket: bucket,
    awaitingReplyFrom: bucket,
    ownershipHistory: history,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (bucket === "dispatch") {
    patch.dispatcherEmail = dispatcherEmail;
    patch.dispatcherName = dispatcherName;
    patch.dispatcherKey = dispatcherEmail ||
      (dispatcherName ? dispatcherName.toLowerCase() : null);
  }
  await ref.update(patch);
  const issue = scope.classifyIssue({...data, type: data.type});
  return {
    ok: true,
    loadNumber: data.loadNumber || null,
    subject: data.subject || data.title || null,
    issue,
    issueLabel: scope.issueLabel(issue),
    emailTo: bucket === "dispatch" ? dispatcherEmail :
      (bucket === "sarah" ? ownership.sarahEmail() :
        (process.env.HUMAN_REVIEW_EMAIL ||
          "Lisa@innovativecarriers.com")),
  };
}

module.exports = {
  TASK_COLLECTION,
  TASK_TYPE,
  TASK_STATUS,
  createDashboardTask,
  listDashboardTasks,
  hydratePageBodies,
  dismissDashboardTask,
  handoffTaskToDispatch,
  markTaskInDispute,
  missingRateTaskPayload,
  ensureMissingRateDispatchTasks,
  reassignDashboardWork,
  tenantCollection,
};
