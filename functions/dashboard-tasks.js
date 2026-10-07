/**
 * Dashboard task list — items Lisa must act on
 * (additional charges, signed POD requests, POD discrepancies, etc.).
 * Unhandled "Jerry doesn't understand" emails are notifications only.
 */

"use strict";

const admin = require("firebase-admin");

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
 * @param {object} opts tenantId, limit.
 * @return {Promise<{tasks: object[], openCount: number}>}
 */
async function listDashboardTasks(db, additionalChargesMod, opts) {
  const tenantId = String(opts.tenantId || "default");
  const limit = Math.min(Number(opts.limit) || 50, 100);

  const taskSnap = await db.collection(TASK_COLLECTION)
      .where("tenantId", "==", tenantId)
      .where("status", "==", TASK_STATUS.OPEN)
      .orderBy("createdAt", "desc")
      .limit(limit)
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
      .limit(limit)
      .get();

  // Enrich linked dashboardTasks that are missing the approval email body.
  for (const task of tasks) {
    if (task.type !== TASK_TYPE.ADDITIONAL_CHARGE || task.body) continue;
    if (!task.followUpId) continue;
    let fuDoc = chargeSnap.docs.find((x) => x.id === task.followUpId);
    if (!fuDoc) {
      // eslint-disable-next-line no-await-in-loop
      const snap = await db
          .collection(additionalChargesMod.FOLLOW_UP_COLLECTION)
          .doc(task.followUpId).get();
      if (snap.exists) fuDoc = snap;
    }
    if (!fuDoc) continue;
    const d = fuDoc.data() || {};
    task.body = d.emailHtml ||
      buildAdditionalChargeFallbackHtml(additionalChargesMod, d);
    task.subject = task.subject || d.emailSubject || null;
    task.to = task.to || d.emailTo || null;
    task.cc = task.cc || d.emailCc || null;
    if (task.chargesTotal == null) task.chargesTotal = d.chargesTotal || null;
  }

  chargeSnap.forEach((doc) => {
    if (linkedFollowUpIds.has(doc.id)) return;
    const d = doc.data() || {};
    if (d.tenantId && d.tenantId !== tenantId) return;
    tasks.push({
      id: doc.id,
      source: "additionalCharges",
      tenantId: d.tenantId || tenantId,
      type: TASK_TYPE.ADDITIONAL_CHARGE,
      title: `Additional charge — Load ${d.loadNumber || "—"}`,
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
      createdAt: d.createdAt && d.createdAt.toDate ?
        d.createdAt.toDate().toISOString() : null,
      dismissedAt: null,
    });
  });

  tasks.sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  });

  return {
    tasks: tasks.slice(0, limit),
    openCount: tasks.length,
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

module.exports = {
  TASK_COLLECTION,
  TASK_TYPE,
  TASK_STATUS,
  createDashboardTask,
  listDashboardTasks,
  dismissDashboardTask,
};
