/**
 * Dashboard task list — items Lisa / Sarah / Dispatch must act on
 * (additional charges, signed POD requests, POD discrepancies, etc.).
 * Unhandled "Jerry doesn't understand" emails are notifications only.
 */

"use strict";

const admin = require("firebase-admin");
const ownership = require("./dashboard-ownership");

const TASK_COLLECTION = "dashboardTasks";

const TASK_TYPE = Object.freeze({
  HUMAN_REVIEW: "human_review",
  ADDITIONAL_CHARGE: "additional_charge",
  SIGNED_POD: "signed_pod",
  POD_DISCREPANCY: "pod_discrepancy",
});

const TASK_STATUS = Object.freeze({
  OPEN: "open",
  DISMISSED: "dismissed",
});

/**
 * Creates an open dashboard task (fire-and-forget safe).
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
    const doc = await db.collection(TASK_COLLECTION).add({
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
      status: TASK_STATUS.OPEN,
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
 * Lists open tasks for a tenant plus unresolved additional-charge follow-ups.
 * @param {object} db Firestore instance.
 * @param {object} additionalChargesMod additional-charges module.
 * @param {object} opts tenantId, limit, offset, ownerBucket, dispatcherKey.
 * @return {Promise<object>}
 */
async function listDashboardTasks(db, additionalChargesMod, opts) {
  const tenantId = String(opts.tenantId || "default");
  // Fetch a wider window so folder filters still have enough rows.
  const fetchLimit = Math.min(Math.max(Number(opts.fetchLimit) || 300, 50), 500);

  const taskSnap = await db.collection(TASK_COLLECTION)
      .where("tenantId", "==", tenantId)
      .where("status", "==", TASK_STATUS.OPEN)
      .orderBy("createdAt", "desc")
      .limit(fetchLimit)
      .get();

  // Drop legacy human_review rows — those belong in Notifications.
  const tasks = taskSnap.docs.map(serializeTaskDoc)
      .filter((t) => t.type !== TASK_TYPE.HUMAN_REVIEW);
  const linkedFollowUpIds = new Set(
      tasks.map((t) => t.followUpId).filter(Boolean),
  );

  const chargeSnap = await db
      .collection(additionalChargesMod.FOLLOW_UP_COLLECTION)
      .where("resolved", "==", false)
      .orderBy("createdAt", "desc")
      .limit(fetchLimit)
      .get();

  // Enrich linked dashboardTasks that are missing the approval email body.
  for (const task of tasks) {
    if (task.type !== TASK_TYPE.ADDITIONAL_CHARGE) continue;
    let fuDoc = task.followUpId ?
      chargeSnap.docs.find((x) => x.id === task.followUpId) : null;
    if (task.followUpId && !fuDoc) {
      // eslint-disable-next-line no-await-in-loop
      const snap = await db
          .collection(additionalChargesMod.FOLLOW_UP_COLLECTION)
          .doc(task.followUpId).get();
      if (snap.exists) fuDoc = snap;
    }
    if (fuDoc) {
      const d = fuDoc.data() || {};
      if (!task.body) {
        task.body = d.emailHtml ||
          buildAdditionalChargeFallbackHtml(additionalChargesMod, d);
      }
      task.subject = task.subject || d.emailSubject || null;
      task.to = task.to || d.emailTo || null;
      task.cc = task.cc || d.emailCc || null;
      if (task.chargesTotal == null) task.chargesTotal = d.chargesTotal || null;
      task.dispatcherEmail = task.dispatcherEmail || d.dispatcherEmail || null;
      task.dispatcherName = task.dispatcherName || d.dispatcherName || null;
      task.ownerBucket = task.ownerBucket || d.ownerBucket || null;
      task.awaitingReplyFrom = task.awaitingReplyFrom ||
        d.awaitingReplyFrom || null;
    }
  }

  chargeSnap.forEach((doc) => {
    if (linkedFollowUpIds.has(doc.id)) return;
    const d = doc.data() || {};
    if (d.tenantId && d.tenantId !== tenantId) return;
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
      body: d.emailHtml ||
        buildAdditionalChargeFallbackHtml(additionalChargesMod, d),
      subject: d.emailSubject || null,
      from: null,
      to: d.emailTo || null,
      cc: d.emailCc || null,
      loadNumber: d.loadNumber || null,
      proNumber: null,
      carrierName: d.carrierName || null,
      messageId: null,
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
    task.followUpStatus = d.status || task.followUpStatus || null;
    if (d.status === additionalChargesMod.FOLLOW_UP_STATUS.DISPUTING ||
        d.chargePhase === "dispute" || task.chargePhase === "dispute") {
      task.chargePhase = "dispute";
    }
  }

  const chargePhase = String(opts.chargePhase || "").toLowerCase();
  let working = tasks;
  if (chargePhase === "dispute") {
    working = tasks.filter((t) => t.chargePhase === "dispute");
  } else if (chargePhase === "open" || !chargePhase) {
    // Default task folders hide items already in dispute.
    working = tasks.filter((t) => t.chargePhase !== "dispute");
  }

  const disputeCount = tasks.filter((t) => t.chargePhase === "dispute").length;

  const page = ownership.filterSortPaginate(working, {
    ownerBucket: chargePhase === "dispute" ?
      null : (opts.ownerBucket || null),
    dispatcherKey: chargePhase === "dispute" ?
      null : (opts.dispatcherKey || null),
    offset: opts.offset,
    limit: opts.limit || 50,
    urgentFirst: opts.urgentFirst,
  });

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
  if (opts.tenantId && data.tenantId &&
      data.tenantId !== opts.tenantId) {
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
    if (snap.exists) {
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
    if (snap.exists) {
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
      await ref.update(ownership.handoffToDispatchUpdate(data, {
        reason: "sarah_dashboard_action",
        option,
      }));
      updates.push("task");
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
      await ref.update(ownership.handoffToDispatchUpdate(data, {
        reason: "sarah_dashboard_action",
        option,
      }));
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
      const data = doc.data() || {};
      if (opts.tenantId && data.tenantId && data.tenantId !== opts.tenantId) {
        continue;
      }
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

module.exports = {
  TASK_COLLECTION,
  TASK_TYPE,
  TASK_STATUS,
  createDashboardTask,
  listDashboardTasks,
  dismissDashboardTask,
  handoffTaskToDispatch,
  markTaskInDispute,
};
