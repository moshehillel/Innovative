/**
 * Dashboard task list — tracks items that need Lisa / ops attention
 * (human-review forwards, additional charges, signed POD requests, etc.).
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
    const doc = await db.collection(TASK_COLLECTION).add({
      tenantId: data.tenantId || "default",
      type: data.type || TASK_TYPE.HUMAN_REVIEW,
      title: data.title || "Action required",
      description: data.description || null,
      loadNumber: data.loadNumber || null,
      proNumber: data.proNumber || null,
      carrierName: data.carrierName || null,
      messageId: data.messageId || null,
      invoiceId: data.invoiceId || null,
      followUpId: data.followUpId || null,
      department: data.department || null,
      reason: data.reason || null,
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
    loadNumber: d.loadNumber || null,
    proNumber: d.proNumber || null,
    carrierName: d.carrierName || null,
    messageId: d.messageId || null,
    invoiceId: d.invoiceId || null,
    followUpId: d.followUpId || null,
    department: d.department || null,
    reason: d.reason || null,
    status: d.status || null,
    createdAt: d.createdAt && d.createdAt.toDate ?
      d.createdAt.toDate().toISOString() : null,
    dismissedAt: d.dismissedAt && d.dismissedAt.toDate ?
      d.dismissedAt.toDate().toISOString() : null,
  };
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

  const tasks = taskSnap.docs.map(serializeTaskDoc);
  const linkedFollowUpIds = new Set(
      tasks.map((t) => t.followUpId).filter(Boolean),
  );

  const chargeSnap = await db
      .collection(additionalChargesMod.FOLLOW_UP_COLLECTION)
      .where("resolved", "==", false)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

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
