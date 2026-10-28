/**
 * Dismisses open dashboard tasks that are exact duplicates of the same
 * additional charge (same type, load, amount within $0.01, and reason).
 * Keeps the newest copy, or the in-dispute copy when one exists.
 * Also resolves extra unresolved follow-ups so the task list does not
 * synthesize them back into rows.
 *
 * Dry-run by default.
 *   node scripts/dismiss-duplicate-dashboard-tasks.js
 *   node scripts/dismiss-duplicate-dashboard-tasks.js --apply
 */
"use strict";

const admin = require("firebase-admin");
const dedupe = require("../dashboard-dedupe");

const PROJECT = "tai-invoice-automation";
const TASKS = "dashboardTasks";
const FOLLOW_UPS = "additionalCharges";
const NOTIFS = "dashboardNotifications";

/**
 * @param {*} value Timestamp-like value.
 * @return {string|null}
 */
function iso(value) {
  const ms = dedupe.timestampMs(value);
  return ms == null ? null : new Date(ms).toISOString();
}

/**
 * @param {FirebaseFirestore.QueryDocumentSnapshot[]} docs Docs.
 * @param {Map<string, object>} followUps Follow-ups by id.
 * @return {object[]}
 */
function taskItems(docs, followUps) {
  return docs.map((doc) => {
    const row = doc.data() || {};
    const fu = row.followUpId ? followUps.get(row.followUpId) : null;
    const amount = row.chargesTotal != null ? row.chargesTotal :
      (fu ? fu.chargesTotal : null);
    return {
      id: doc.id,
      ref: doc.ref,
      type: row.type || "additional_charge",
      loadNumber: row.loadNumber || null,
      reason: row.reason || (fu && fu.category) || null,
      chargesTotal: amount,
      messageId: row.messageId || null,
      followUpId: row.followUpId || null,
      chargePhase: row.chargePhase || (fu && fu.chargePhase) || null,
      followUpStatus: row.followUpStatus || (fu && fu.status) || null,
      createdAt: iso(row.createdAt),
      receivedAt: iso(row.receivedAt || row.emailReceivedAt),
      storedAmount: row.chargesTotal,
    };
  });
}

/**
 * @param {FirebaseFirestore.Firestore} db Firestore.
 * @param {FirebaseFirestore.DocumentReference[]} refs Refs.
 * @param {object[]} patches Patches aligned with refs.
 * @return {Promise<void>}
 */
async function commitPairs(db, refs, patches) {
  const chunkSize = 400;
  for (let i = 0; i < refs.length; i += chunkSize) {
    const batch = db.batch();
    refs.slice(i, i + chunkSize).forEach((ref, idx) => {
      batch.update(ref, patches[i + idx]);
    });
    // eslint-disable-next-line no-await-in-loop
    await batch.commit();
  }
}

/**
 * @return {Promise<void>}
 */
async function main() {
  const apply = process.argv.includes("--apply");
  if (!admin.apps.length) {
    admin.initializeApp({projectId: PROJECT});
  }
  try {
    admin.firestore().settings({preferRest: true});
  } catch (_) {
    // already configured
  }
  const db = admin.firestore();
  const taskSnap = await db.collection(TASKS)
      .where("type", "==", "additional_charge")
      .get();
  const followSnap = await db.collection(FOLLOW_UPS).get();
  const notifSnap = await db.collection(NOTIFS)
      .where("type", "==", "additional_charge")
      .get();

  const followUps = new Map();
  followSnap.docs.forEach((doc) => {
    followUps.set(doc.id, doc.data() || {});
  });

  const openTaskDocs = taskSnap.docs.filter((doc) =>
    (doc.data() || {}).status === "open");
  const items = taskItems(openTaskDocs, followUps);
  const plan = dedupe.selectDuplicateDismissals(items);
  const dismissIds = new Set(plan.dismiss.map((item) => item.id));
  const kept = plan.keep.filter((item) => !dismissIds.has(item.id));

  const taskRefs = [];
  const taskPatches = [];
  const now = admin.firestore.FieldValue.serverTimestamp();
  for (const item of plan.dismiss) {
    const winner = kept.find((row) => dedupe.sameExactCharge(row, item) ||
      (item.followUpId && row.followUpId === item.followUpId) ||
      (item.messageId && row.messageId === item.messageId));
    taskRefs.push(item.ref);
    taskPatches.push({
      status: "dismissed",
      dismissedAt: now,
      dismissReason: "exact_duplicate",
      supersededBy: winner ? winner.id : null,
      updatedAt: now,
    });
  }

  const amountRefs = [];
  const amountPatches = [];
  for (const item of kept) {
    if (item.storedAmount != null) continue;
    if (item.chargesTotal == null) continue;
    if (!dismissIds.size && plan.dismiss.length === 0) continue;
    const groupHadDupes = plan.dismiss.some((row) =>
      dedupe.sameExactCharge(row, item));
    if (!groupHadDupes) continue;
    amountRefs.push(item.ref);
    amountPatches.push({
      chargesTotal: item.chargesTotal,
      updatedAt: now,
    });
  }

  const keptFollowUps = new Set(kept.map((item) => item.followUpId)
      .filter(Boolean));
  const followRefs = [];
  const followPatches = [];
  const unresolved = followSnap.docs.filter((doc) =>
    (doc.data() || {}).resolved !== true);

  unresolved.forEach((doc) => {
    const row = doc.data() || {};
    const fuItem = {
      id: doc.id,
      type: "additional_charge",
      loadNumber: row.loadNumber || null,
      reason: row.category || null,
      chargesTotal: row.chargesTotal,
      chargePhase: row.chargePhase || null,
      followUpStatus: row.status || null,
      createdAt: iso(row.createdAt),
      receivedAt: iso(row.receivedAt),
    };
    const keeper = kept.find((item) => dedupe.sameExactCharge(item, fuItem));
    if (keeper) {
      if (keeper.followUpId === doc.id) return;
      if (row.status === "disputing" && !dedupe.isDisputeItem(keeper)) return;
    } else if (!keptFollowUps.has(doc.id)) {
      return;
    } else {
      return;
    }
    const note = "Superseded as an exact duplicate of an open additional charge.";
    const prev = String(row.notes || "");
    if (prev.includes(note)) return;
    followRefs.push(doc.ref);
    followPatches.push({
      resolved: true,
      status: "resolved",
      supersededDuplicate: true,
      notes: prev ? `${prev}\n${note}` : note,
      updatedAt: now,
    });
  });

  const uncovered = unresolved.filter((doc) => {
    const row = doc.data() || {};
    const fuItem = {
      type: "additional_charge",
      loadNumber: row.loadNumber,
      reason: row.category,
      chargesTotal: row.chargesTotal,
    };
    return !kept.some((item) => dedupe.sameExactCharge(item, fuItem));
  }).map((doc) => {
    const row = doc.data() || {};
    return {
      id: doc.id,
      ref: doc.ref,
      type: "additional_charge",
      loadNumber: row.loadNumber || null,
      reason: row.category || null,
      chargesTotal: row.chargesTotal,
      chargePhase: row.chargePhase || null,
      followUpStatus: row.status || null,
      createdAt: iso(row.createdAt),
      receivedAt: iso(row.receivedAt),
      notes: row.notes || "",
    };
  });
  const extraFollow = dedupe.selectDuplicateDismissals(uncovered);
  const note = "Superseded as an exact duplicate of an open additional charge.";
  for (const item of extraFollow.dismiss) {
    if (String(item.notes || "").includes(note)) continue;
    if (item.followUpStatus === "disputing") continue;
    followRefs.push(item.ref);
    followPatches.push({
      resolved: true,
      status: "resolved",
      supersededDuplicate: true,
      notes: item.notes ? `${item.notes}\n${note}` : note,
      updatedAt: now,
    });
  }

  const openNotifDocs = notifSnap.docs.filter((doc) =>
    (doc.data() || {}).status === "open");
  const notifItems = openNotifDocs.map((doc) => {
    const row = doc.data() || {};
    return {
      id: doc.id,
      ref: doc.ref,
      type: row.type || "additional_charge",
      loadNumber: row.loadNumber || null,
      reason: row.reason || null,
      chargesTotal: row.chargesTotal,
      messageId: row.messageId || null,
      followUpId: row.followUpId || null,
      createdAt: iso(row.createdAt),
      receivedAt: iso(row.receivedAt),
    };
  });
  const notifPlan = dedupe.selectDuplicateDismissals(notifItems);
  const notifRefs = [];
  const notifPatches = [];
  for (const item of notifPlan.dismiss) {
    notifRefs.push(item.ref);
    notifPatches.push({
      status: "dismissed",
      dismissedAt: now,
      dismissReason: "exact_duplicate",
      updatedAt: now,
    });
  }

  const byLoad = {};
  for (const item of plan.dismiss) {
    const key = `${item.loadNumber}|${item.reason}|${item.chargesTotal}`;
    byLoad[key] = (byLoad[key] || 0) + 1;
  }
  const focus = "265879";
  console.log(JSON.stringify({
    apply,
    openAdditionalChargeTasks: openTaskDocs.length,
    tasksToDismiss: plan.dismiss.length,
    tasksToKeep: kept.length,
    followUpsToResolve: followRefs.length,
    notificationsToDismiss: notifPlan.dismiss.length,
    amountsToBackfill: amountRefs.length,
    dismissByLoad: byLoad,
    keep265879: kept.filter((item) => item.loadNumber === focus).map((item) => ({
      id: item.id,
      amount: item.chargesTotal,
      reason: item.reason,
      createdAt: item.createdAt,
      followUpId: item.followUpId,
    })),
    dismiss265879: plan.dismiss.filter((item) => item.loadNumber === focus).length,
  }, null, 2));

  if (!apply) {
    console.log("Dry run only. Re-run with --apply to write.");
    return;
  }

  await commitPairs(db, taskRefs, taskPatches);
  await commitPairs(db, amountRefs, amountPatches);
  await commitPairs(db, followRefs, followPatches);
  await commitPairs(db, notifRefs, notifPatches);
  console.log("Applied.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
