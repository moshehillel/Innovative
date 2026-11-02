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
      chargePhase: data.chargePhase || null,
      followUpStatus: data.followUpStatus || null,
      decision: data.decision || null,
      disputeNotes: data.disputeNotes || null,
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
    chargePhase: d.chargePhase || null,
    followUpStatus: d.followUpStatus || null,
    decision: d.decision || null,
    disputeNotes: d.disputeNotes || null,
    createdAt: d.createdAt && d.createdAt.toDate ?
      d.createdAt.toDate().toISOString() : null,
    dismissedAt: d.dismissedAt && d.dismissedAt.toDate ?
      d.dismissedAt.toDate().toISOString() : null,
  };
}

/**
 * Option D / carrier dispute. Other open work stays off this list.
 * Matches the Jerry dashboard client filter.
 * @param {object} task Row.
 * @return {boolean}
 */
function isOptionDDispute(task) {
  const type = String((task && task.type) || "").toLowerCase();
  const source = String((task && task.source) || "");
  if (type !== "additional_charge" && source !== "additionalCharges") {
    return false;
  }
  const phase = String(task.chargePhase || "").toLowerCase();
  const follow = String(task.followUpStatus || "").toLowerCase();
  const decision = String(task.decision || "").toLowerCase();
  const status = String(task.status || "").toLowerCase();
  return decision === "d" || phase === "dispute" ||
    follow === "disputing" || follow === "disputed" ||
    status === "disputed" || status === "disputing";
}

/**
 * @param {object} data Additional-charge follow-up fields.
 * @return {boolean}
 */
function followUpIsDispute(data) {
  return isOptionDDispute({
    type: "additional_charge",
    source: "additionalCharges",
    chargePhase: data && data.chargePhase,
    followUpStatus: data && data.status,
    decision: data && data.decision,
    status: data && data.status,
  });
}

/**
 * Copies dispute markers from a follow-up onto a dashboard task.
 * @param {object} task Serialized task.
 * @param {object} data Follow-up fields.
 * @return {object}
 */
function applyFollowUpDispute(task, data) {
  if (!task || !data) return task;
  if (data.status) task.followUpStatus = data.status;
  if (data.decision) task.decision = data.decision;
  if (data.disputeNotes) task.disputeNotes = data.disputeNotes;
  if (!followUpIsDispute(data)) return task;
  task.chargePhase = "dispute";
  task.followUpStatus = data.status || task.followUpStatus || "disputing";
  task.status = "disputing";
  return task;
}

/**
 * @param {string} id Follow-up id.
 * @param {object} data Follow-up fields.
 * @param {string} tenantId Tenant.
 * @return {object}
 */
function chargeTaskFromFollowUp(id, data, tenantId) {
  const dispute = followUpIsDispute(data);
  const created = data.createdAt && data.createdAt.toDate ?
    data.createdAt.toDate().toISOString() : null;
  return applyFollowUpDispute({
    id,
    source: "additionalCharges",
    tenantId: data.tenantId || tenantId,
    type: TASK_TYPE.ADDITIONAL_CHARGE,
    title: dispute ?
      `Charge in dispute — Load ${data.loadNumber || "—"}` :
      `Additional charge — Load ${data.loadNumber || "—"}`,
    description: data.notes || null,
    loadNumber: data.loadNumber || null,
    proNumber: null,
    carrierName: data.carrierName || null,
    messageId: null,
    invoiceId: data.invoiceId || null,
    followUpId: id,
    department: null,
    reason: data.category || data.status || null,
    status: dispute ? "disputing" : "open",
    chargesTotal: data.chargesTotal || null,
    invoiceAmount: data.invoiceAmount || null,
    chargePhase: dispute ? "dispute" : null,
    followUpStatus: data.status || null,
    decision: data.decision || null,
    disputeNotes: data.disputeNotes || null,
    createdAt: created,
    dismissedAt: null,
  }, data);
}

/**
 * Work excludes option D. In Dispute is only those rows.
 * @param {object[]} tasks Merged rows, newest first.
 * @param {object} opts chargePhase, limit, offset.
 * @return {object}
 */
function partitionByChargePhase(tasks, opts) {
  const phase = String((opts && opts.chargePhase) || "").toLowerCase();
  const limit = Math.min(Math.max(Number(opts && opts.limit) || 50, 1), 100);
  const offset = Math.max(0, Number(opts && opts.offset) || 0);
  const rows = Array.isArray(tasks) ? tasks : [];
  const disputes = rows.filter(isOptionDDispute);
  let working = rows;
  if (phase === "dispute") working = disputes;
  else if (phase !== "all") {
    working = rows.filter((task) => !isOptionDDispute(task));
  }
  const page = working.slice(offset, offset + limit);
  return {
    tasks: page,
    openCount: working.length,
    disputeCount: disputes.length,
    filteredCount: working.length,
    hasMore: offset + page.length < working.length,
    nextOffset: offset + page.length,
    offset,
    limit,
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
  const offset = Math.max(0, Number(opts.offset) || 0);
  // Page size used to cap both queries, so older disputes never left the
  // shared first page. Scan a wider window, then split by charge phase.
  const scan = 200;

  const taskSnap = await db.collection(TASK_COLLECTION)
      .where("tenantId", "==", tenantId)
      .where("status", "==", TASK_STATUS.OPEN)
      .orderBy("createdAt", "desc")
      .limit(scan)
      .get();

  const tasks = taskSnap.docs.map(serializeTaskDoc);
  const followById = new Map();

  const chargeSnap = await db
      .collection(additionalChargesMod.FOLLOW_UP_COLLECTION)
      .where("resolved", "==", false)
      .orderBy("createdAt", "desc")
      .limit(scan)
      .get();

  chargeSnap.forEach((doc) => {
    const data = doc.data() || {};
    if (data.tenantId && data.tenantId !== tenantId) return;
    followById.set(doc.id, data);
  });

  const missingIds = [];
  tasks.forEach((task) => {
    if (task.type !== TASK_TYPE.ADDITIONAL_CHARGE || !task.followUpId) return;
    if (!followById.has(task.followUpId)) missingIds.push(task.followUpId);
  });
  if (missingIds.length && typeof db.getAll === "function") {
    const refs = missingIds.slice(0, 100).map((id) =>
      db.collection(additionalChargesMod.FOLLOW_UP_COLLECTION).doc(id));
    const snaps = await db.getAll(...refs);
    snaps.forEach((snap) => {
      if (!snap.exists) return;
      const data = snap.data() || {};
      if (data.tenantId && data.tenantId !== tenantId) return;
      if (data.resolved === true) return;
      followById.set(snap.id, data);
    });
  }

  tasks.forEach((task) => {
    if (!task.followUpId) return;
    const data = followById.get(task.followUpId);
    if (data) applyFollowUpDispute(task, data);
  });

  const linkedFollowUpIds = new Set(
      tasks.map((task) => task.followUpId).filter(Boolean),
  );
  followById.forEach((data, id) => {
    if (linkedFollowUpIds.has(id)) return;
    tasks.push(chargeTaskFromFollowUp(id, data, tenantId));
  });

  tasks.sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  });

  return partitionByChargePhase(tasks, {
    chargePhase: opts.chargePhase,
    limit,
    offset,
  });
}

/**
 * Marks open additional-charge tasks for a follow-up as In Dispute.
 * @param {object} db Firestore.
 * @param {object} opts followUpId, invoiceId, tenantId, decision, disputeNotes.
 * @return {Promise<number>} Updated task count.
 */
async function markTasksInDispute(db, opts) {
  const followUpId = String((opts && opts.followUpId) || "").trim();
  const invoiceId = String((opts && opts.invoiceId) || "").trim();
  let snap = null;
  if (followUpId) {
    snap = await db.collection(TASK_COLLECTION)
        .where("followUpId", "==", followUpId)
        .limit(10)
        .get();
  } else if (invoiceId) {
    snap = await db.collection(TASK_COLLECTION)
        .where("invoiceId", "==", invoiceId)
        .limit(10)
        .get();
  }
  if (!snap || snap.empty) return 0;
  const tenantId = opts.tenantId || null;
  let updated = 0;
  const writes = [];
  snap.forEach((doc) => {
    const data = doc.data() || {};
    if (data.type && data.type !== TASK_TYPE.ADDITIONAL_CHARGE) return;
    if (tenantId && data.tenantId && data.tenantId !== tenantId) return;
    if (data.status === TASK_STATUS.DISMISSED) return;
    writes.push(doc.ref.update({
      chargePhase: "dispute",
      followUpStatus: "disputing",
      decision: opts.decision || data.decision || "D",
      disputeNotes: opts.disputeNotes || data.disputeNotes || null,
    }));
    updated += 1;
  });
  await Promise.all(writes);
  return updated;
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
  markTasksInDispute,
  isOptionDDispute,
  partitionByChargePhase,
  applyFollowUpDispute,
  chargeTaskFromFollowUp,
};
