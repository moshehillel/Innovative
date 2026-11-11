/**
 * Dashboard task list — tracks items that need Lisa / ops attention
 * (human-review forwards, additional charges, signed POD requests, etc.).
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
  RATE_MISSING: "rate_missing",
  MISSING_POD: "missing_pod",
});

const TASK_STATUS = Object.freeze({
  OPEN: "open",
  DISMISSED: "dismissed",
});

const AMOUNT_TOLERANCE_CENTS = 1;

/** Task fields the list reads. Mirrors serializeTaskDoc. */
const TASK_LIST_FIELDS = [
  "tenantId", "type", "title", "description", "from", "to", "cc",
  "loadNumber", "proNumber", "carrierName", "messageId", "invoiceId",
  "followUpId", "department", "reason", "chargesTotal", "chargeSignature",
  "status", "ownerBucket", "awaitingReplyFrom", "dispatcherEmail",
  "dispatcherName", "dispatcherKey", "chargePhase", "followUpStatus",
  "decision", "disputeNotes", "createdAt", "dismissedAt",
];

/** Follow-up fields the list reads. Leaves out email HTML. */
const FOLLOW_UP_LIST_FIELDS = [
  "tenantId", "status", "resolved", "chargePhase", "decision",
  "disputeNotes", "notes", "chargesTotal", "invoiceAmount", "category",
  "charges", "to", "cc", "dispatcherEmail", "dispatcherName",
  "dispatcherKey", "ownerBucket", "loadNumber", "carrierName", "invoiceId",
  "createdAt",
];

/** Notification fields used to find To/Cc for tasks with no dispatcher. */
const NOTIFICATION_ROUTING_FIELDS = [
  "to", "cc", "followUpId", "messageId", "loadNumber",
];

/**
 * @param {*} value Dollar amount.
 * @return {number|null} Integer cents, or null when unknown.
 */
function amountCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/**
 * @param {*} value Label text.
 * @return {string}
 */
function normText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Stable identity for the charge lines on one work item.
 * @param {Array<object>|null} charges Charge rows.
 * @return {string}
 */
function chargeLineSignature(charges) {
  if (!Array.isArray(charges) || !charges.length) return "";
  const parts = [];
  charges.forEach((line) => {
    if (!line || typeof line !== "object") return;
    const label = normText(
        line.label || line.name || line.type || line.description);
    const cents = amountCents(
        line.amount != null ? line.amount : line.charge);
    if (!label && cents == null) return;
    parts.push(`${label}:${cents == null ? "" : cents}`);
  });
  parts.sort();
  return parts.join("|");
}

/**
 * @param {object} item Task or follow-up shaped fields.
 * @return {object}
 */
function workIdentity(item) {
  const row = item || {};
  return {
    type: normText(row.type),
    loadNumber: String(row.loadNumber || "").trim(),
    reason: normText(row.reason || row.category),
    cents: amountCents(row.chargesTotal),
    signature: row.chargeSignature || chargeLineSignature(row.charges) || "",
    followUpId: String(row.followUpId || "").trim(),
    messageId: String(row.messageId || "").trim(),
  };
}

/**
 * True when two rows are the same work item.
 * Same follow-up or email collapses even when the amount was not stored.
 * Same load + kind + charge lines (or amount) collapses retry copies.
 * A different amount, charge line set, or email stays visible.
 * @param {object} a Item.
 * @param {object} b Item.
 * @return {boolean}
 */
function isSameWorkItem(a, b) {
  return isSameIdentity(workIdentity(a), workIdentity(b));
}

/**
 * Same rule as isSameWorkItem, on identities that were already computed.
 * @param {object} left workIdentity of the first row.
 * @param {object} right workIdentity of the second row.
 * @return {boolean}
 */
function isSameIdentity(left, right) {
  if (!left.type || left.type !== right.type) return false;
  if (left.followUpId && right.followUpId &&
      left.followUpId === right.followUpId) {
    return true;
  }
  if (left.messageId && right.messageId) {
    return left.messageId === right.messageId;
  }
  if (!left.loadNumber || left.loadNumber !== right.loadNumber) return false;
  if (!left.reason || left.reason !== right.reason) return false;
  // Same lines collapse even when a retry forgot to store the total.
  if (left.signature && right.signature &&
      left.signature === right.signature) {
    return true;
  }
  // Same dollar amount is the same charge. A different total stays.
  // Line wording can drift across retries ("Over Dim" vs "OVER DIM"),
  // so a signature mismatch does not keep a second row.
  if (left.cents == null || right.cents == null) return false;
  return Math.abs(left.cents - right.cents) <= AMOUNT_TOLERANCE_CENTS;
}

/**
 * @param {object} item Row.
 * @return {number}
 */
function recencyMs(item) {
  const ms = item && item.createdAt ? Date.parse(item.createdAt) : 0;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Positive when `a` should be kept instead of `b`.
 * An in-dispute copy wins, otherwise the newest row.
 * @param {object} a Item.
 * @param {object} b Item.
 * @return {number}
 */
function compareDuplicatePreference(a, b) {
  const aDispute = isOptionDDispute(a) ? 1 : 0;
  const bDispute = isOptionDDispute(b) ? 1 : 0;
  if (aDispute !== bDispute) return aDispute - bDispute;
  const recency = recencyMs(a) - recencyMs(b);
  if (recency !== 0) return recency;
  const aAmt = a && a.chargesTotal != null ? 1 : 0;
  const bAmt = b && b.chargesTotal != null ? 1 : 0;
  return aAmt - bAmt;
}

/**
 * Collapses retry copies of the same work item.
 * @param {object[]} items Rows.
 * @return {object[]}
 */
function collapseDuplicateTasks(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length < 2) return list.slice();
  const parent = list.map((_, i) => i);
  /**
   * @param {number} i Index.
   * @return {number}
   */
  const find = (i) => {
    let x = i;
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  /**
   * @param {number} a Index.
   * @param {number} b Index.
   * @return {void}
   */
  const union = (a, b) => {
    const pa = find(a);
    const pb = find(b);
    if (pa !== pb) parent[pb] = pa;
  };
  // Identities are computed once, and only rows that share a follow-up id,
  // an email id, or a type + load can be the same work item, so only those
  // pairs are compared. Every true branch of isSameIdentity needs one of
  // those three keys, so the groups are the same as comparing every pair.
  const identities = list.map(workIdentity);
  const buckets = new Map();
  const bucketFor = (key) => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    return bucket;
  };
  identities.forEach((identity, i) => {
    if (!identity.type) return;
    if (identity.followUpId) bucketFor(`f|${identity.followUpId}`).push(i);
    if (identity.messageId) bucketFor(`m|${identity.messageId}`).push(i);
    if (identity.loadNumber) {
      bucketFor(`l|${identity.type}|${identity.loadNumber}`).push(i);
    }
  });
  for (const bucket of buckets.values()) {
    for (let x = 0; x < bucket.length; x++) {
      for (let y = x + 1; y < bucket.length; y++) {
        const i = bucket[x];
        const j = bucket[y];
        if (find(i) === find(j)) continue;
        if (isSameIdentity(identities[i], identities[j])) union(i, j);
      }
    }
  }
  const groups = new Map();
  const order = [];
  list.forEach((item, i) => {
    const root = find(i);
    if (!groups.has(root)) {
      groups.set(root, []);
      order.push(root);
    }
    groups.get(root).push(item);
  });
  return order.map((root) => {
    const group = groups.get(root);
    return group.reduce((best, item) =>
      compareDuplicatePreference(item, best) > 0 ? item : best);
  });
}

/**
 * @param {object} db Firestore.
 * @param {object} data Incoming task fields.
 * @return {Promise<object|null>} Open duplicate doc, if any.
 */
async function findOpenDuplicateTask(db, data) {
  const tenantId = String((data && data.tenantId) || "default");
  const loadNumber = String((data && data.loadNumber) || "").trim();
  const messageId = String((data && data.messageId) || "").trim();
  const followUpId = String((data && data.followUpId) || "").trim();
  let snap = null;
  if (loadNumber) {
    snap = await db.collection(TASK_COLLECTION)
        .where("loadNumber", "==", loadNumber)
        .limit(200)
        .get();
  } else if (messageId) {
    snap = await db.collection(TASK_COLLECTION)
        .where("messageId", "==", messageId)
        .limit(20)
        .get();
  } else if (followUpId) {
    snap = await db.collection(TASK_COLLECTION)
        .where("followUpId", "==", followUpId)
        .limit(20)
        .get();
  }
  if (!snap) return null;
  let found = null;
  snap.forEach((doc) => {
    if (found) return;
    const row = doc.data() || {};
    if ((row.status || "") !== TASK_STATUS.OPEN) return;
    if (String(row.tenantId || "default") !== tenantId) return;
    if (!isSameWorkItem(data, row)) return;
    found = {id: doc.id, ref: doc.ref, data: row};
  });
  return found;
}

/**
 * Creates an open dashboard task (fire-and-forget safe).
 * Reuses an open task when this is the same work item.
 * @param {object} db Firestore instance.
 * @param {object} data Task fields.
 * @return {Promise<string|null>} Doc id or null on failure.
 */
async function createDashboardTask(db, data) {
  try {
    const signature = data.chargeSignature ||
      chargeLineSignature(data.charges);
    const incoming = Object.assign({}, data, {
      chargeSignature: signature || null,
    });
    try {
      const existing = await findOpenDuplicateTask(db, incoming);
      if (existing) {
        const patch = {};
        if (data.chargesTotal != null &&
            existing.data.chargesTotal == null) {
          patch.chargesTotal = Number(data.chargesTotal);
        }
        if (signature && !existing.data.chargeSignature) {
          patch.chargeSignature = signature;
        }
        if (data.followUpId && !existing.data.followUpId) {
          patch.followUpId = data.followUpId;
        }
        if (data.messageId && !existing.data.messageId) {
          patch.messageId = data.messageId;
        }
        if (data.invoiceId && !existing.data.invoiceId) {
          patch.invoiceId = data.invoiceId;
        }
        if (data.description && !existing.data.description) {
          patch.description = data.description;
        }
        if (!existing.data.dispatcherKey && !existing.data.dispatcherEmail) {
          const owner = ownership.ownershipFieldsForCreate(data);
          if (owner.dispatcherKey || owner.dispatcherEmail) {
            patch.ownerBucket = owner.ownerBucket;
            patch.awaitingReplyFrom = owner.awaitingReplyFrom;
            patch.dispatcherEmail = owner.dispatcherEmail;
            patch.dispatcherName = owner.dispatcherName;
            patch.dispatcherKey = owner.dispatcherKey;
          }
        }
        if (Object.keys(patch).length) {
          await existing.ref.update(patch);
        }
        console.log(
            "[createDashboardTask] reused open task",
            existing.id,
            data.loadNumber || "",
            data.reason || data.type || "");
        return existing.id;
      }
    } catch (dedupeErr) {
      console.error("[createDashboardTask] dedupe lookup failed:",
          dedupeErr.message);
    }
    const owner = ownership.ownershipFieldsForCreate(data);
    const doc = await db.collection(TASK_COLLECTION).add({
      tenantId: data.tenantId || "default",
      type: data.type || TASK_TYPE.HUMAN_REVIEW,
      title: data.title || "Action required",
      description: data.description || null,
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
      chargesTotal: data.chargesTotal != null ?
        Number(data.chargesTotal) : null,
      chargeSignature: signature || null,
      ...owner,
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
  return ownership.applyOwnerDefaults({
    id: doc.id,
    source: "dashboardTasks",
    tenantId: d.tenantId || null,
    type: d.type || null,
    title: d.title || null,
    description: d.description || null,
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
    chargesTotal: d.chargesTotal != null ? d.chargesTotal : null,
    chargeSignature: d.chargeSignature || null,
    status: d.status || null,
    ownerBucket: d.ownerBucket || null,
    awaitingReplyFrom: d.awaitingReplyFrom || null,
    dispatcherEmail: d.dispatcherEmail || null,
    dispatcherName: d.dispatcherName || null,
    dispatcherKey: d.dispatcherKey || null,
    chargePhase: d.chargePhase || null,
    followUpStatus: d.followUpStatus || null,
    decision: d.decision || null,
    disputeNotes: d.disputeNotes || null,
    createdAt: d.createdAt && d.createdAt.toDate ?
      d.createdAt.toDate().toISOString() : null,
    dismissedAt: d.dismissedAt && d.dismissedAt.toDate ?
      d.dismissedAt.toDate().toISOString() : null,
  });
}

/**
 * Match a dispatcher filter (key, email, or name). Blank matches all.
 * @param {object} item Task row.
 * @param {string} query Filter text.
 * @return {boolean}
 */
function dispatcherMatches(item, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const roster = ownership.OPS_DISPATCHERS.find((person) =>
    person.key === q || person.email === q ||
    person.name.toLowerCase() === q);
  const needles = roster ?
    [roster.key, roster.email, roster.name.toLowerCase()] : [q];
  const fields = [
    item && item.dispatcherKey,
    item && item.dispatcherEmail,
    item && item.dispatcherName,
    item && item.to,
    item && item.cc,
  ];
  return fields.some((value) => {
    const text = String(value || "").trim().toLowerCase();
    if (!text) return false;
    return needles.some((needle) =>
      text === needle || text.includes(needle));
  });
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
  const owner = ownership.ownershipFieldsForCreate({
    type: TASK_TYPE.ADDITIONAL_CHARGE,
    to: data.to || null,
    cc: data.cc || null,
    dispatcherEmail: data.dispatcherEmail || null,
    dispatcherName: data.dispatcherName || null,
  });
  return applyFollowUpDispute(ownership.applyOwnerDefaults({
    id,
    source: "additionalCharges",
    tenantId: data.tenantId || tenantId,
    type: TASK_TYPE.ADDITIONAL_CHARGE,
    title: dispute ?
      `Charge in dispute — Load ${data.loadNumber || "—"}` :
      `Additional charge — Load ${data.loadNumber || "—"}`,
    description: data.notes || null,
    to: data.to || null,
    cc: data.cc || null,
    loadNumber: data.loadNumber || null,
    proNumber: null,
    carrierName: data.carrierName || null,
    messageId: null,
    invoiceId: data.invoiceId || null,
    followUpId: id,
    department: null,
    reason: data.category || data.status || null,
    status: dispute ? "disputing" : "open",
    chargesTotal: data.chargesTotal != null ? data.chargesTotal : null,
    chargeSignature: chargeLineSignature(data.charges) || null,
    invoiceAmount: data.invoiceAmount || null,
    ownerBucket: data.ownerBucket || owner.ownerBucket,
    dispatcherEmail: data.dispatcherEmail || owner.dispatcherEmail,
    dispatcherName: data.dispatcherName || owner.dispatcherName,
    dispatcherKey: data.dispatcherKey || owner.dispatcherKey,
    chargePhase: dispute ? "dispute" : null,
    followUpStatus: data.status || null,
    decision: data.decision || null,
    disputeNotes: data.disputeNotes || null,
    createdAt: created,
    dismissedAt: null,
  }), data);
}

/**
 * Missing-POD queue row (mirrors Jerry dashboard isMissingPodItem).
 * @param {object} task Row.
 * @return {boolean}
 */
function isMissingPodItem(task) {
  if (!task || isOptionDDispute(task)) return false;
  const status = String(task.status || "open").toLowerCase();
  if (status && status !== "open") return false;
  const type = String(task.type || task.emailType || "").toLowerCase();
  if (type === "signed_pod" || type === "pod_discrepancy") return false;
  if (type === "additional_charge") return false;
  if (type === "missing_rate" || type === "rate_missing") return false;
  if (type === "human_review" || type === "unhandled_email") return false;
  const issue = String(task.issueType || "").toLowerCase();
  const stage = String(task.decisionStage || task.reason || "").toLowerCase();
  const missing = type === "missing_pod" || issue === "missing_pod" ||
    /missing_pod|needs_pod|awaiting_pod/.test(stage);
  if (!missing) return false;
  if (type === "missing_pod" || type === "invoice_hold") return true;
  if (/missing_pod|needs_pod|awaiting_pod/.test(
      String(task.decisionStage || ""))) {
    return true;
  }
  return !type && issue === "missing_pod";
}

/**
 * Work subnav issue filters (Charges don't match / Missing POD / rate / misc).
 * @param {object} task Row.
 * @param {string} issue Filter key from the dashboard.
 * @return {boolean}
 */
function matchesIssueFilter(task, issue) {
  const key = String(issue || "all").toLowerCase().trim();
  if (!key || key === "all") return true;
  const type = String((task && task.type) || "").toLowerCase();
  const reason = String((task && task.reason) || "").toLowerCase();
  if (key === "missing_rate") {
    return type === "missing_rate" || type === "rate_missing" ||
      reason === "missing_rate" ||
      /missing\s*customer\s*rate/i.test(reason);
  }
  if (key === "missing_pod") {
    return isMissingPodItem(task);
  }
  if (key === "charge_mismatch") {
    return type === "additional_charge" ||
      String((task && task.source) || "") === "additionalCharges";
  }
  if (key === "miscellaneous") {
    if (type === "additional_charge" ||
        String((task && task.source) || "") === "additionalCharges") {
      return false;
    }
    if (isMissingPodItem(task) || type === "pod_discrepancy" ||
        type === "signed_pod") {
      return false;
    }
    if (type === "missing_rate" || type === "rate_missing" ||
        reason === "missing_rate") {
      return false;
    }
    return true;
  }
  return true;
}

/**
 * Work excludes option D. In Dispute is only those rows.
 * Missing POD tab is only missing-POD holds.
 * @param {object[]} tasks Merged rows, newest first.
 * @param {object} opts chargePhase, issue, dispatcher, limit, offset.
 * @return {object}
 */
function partitionByChargePhase(tasks, opts) {
  const phase = String((opts && opts.chargePhase) || "").toLowerCase();
  const issue = String((opts && opts.issue) || "all").toLowerCase();
  const dispatcher = String(
      (opts && (opts.dispatcher || opts.dispatcherKey)) || "").trim();
  const limit = Math.min(Math.max(Number(opts && opts.limit) || 50, 1), 100);
  const offset = Math.max(0, Number(opts && opts.offset) || 0);
  const rows = Array.isArray(tasks) ? tasks : [];
  const disputes = rows.filter(isOptionDDispute);
  const missingPods = rows.filter(isMissingPodItem);
  let pool = rows;
  if (phase === "dispute") pool = disputes;
  else if (phase === "missing_pod") pool = missingPods;
  else if (phase !== "all") {
    pool = rows.filter((task) => !isOptionDDispute(task));
  }
  if (dispatcher) {
    pool = pool.filter((task) => dispatcherMatches(task, dispatcher));
  }
  // Issue subnav narrows the page only; Work badge stays on the full pool.
  let working = pool;
  if (phase !== "dispute" && phase !== "missing_pod" &&
      issue && issue !== "all") {
    working = pool.filter((task) => matchesIssueFilter(task, issue));
  }
  const page = working.slice(offset, offset + limit);
  return {
    tasks: page,
    openCount: pool.length,
    disputeCount: disputes.length,
    missingPodCount: missingPods.length,
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
  // Search asks for the open set (up to 2000), not the first page.
  const scan = Math.min(
      Math.max(Number(opts.fetchLimit) || 200, 50), 2000);

  // The open tasks, the open follow-ups, and the notification routing rows
  // do not depend on each other, so they are read together. Field masks keep
  // email HTML and other large fields out of memory; only the fields below
  // are ever read from these rows.
  const routingPromise = loadNotificationRouting(db, tenantId);
  const [taskSnap, chargeSnap] = await Promise.all([
    db.collection(TASK_COLLECTION)
        .where("tenantId", "==", tenantId)
        .where("status", "==", TASK_STATUS.OPEN)
        .orderBy("createdAt", "desc")
        .select(...TASK_LIST_FIELDS)
        .limit(scan)
        .get(),
    db.collection(additionalChargesMod.FOLLOW_UP_COLLECTION)
        .where("resolved", "==", false)
        .orderBy("createdAt", "desc")
        .select(...FOLLOW_UP_LIST_FIELDS)
        .limit(scan)
        .get(),
  ]);

  const tasks = taskSnap.docs.map(serializeTaskDoc);
  const followById = new Map();

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
    const snaps = await db.getAll(...refs, {
      fieldMask: FOLLOW_UP_LIST_FIELDS,
    });
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
    if (!data) return;
    applyFollowUpDispute(task, data);
    if (task.chargesTotal == null && data.chargesTotal != null) {
      task.chargesTotal = data.chargesTotal;
    }
    if (!task.reason && data.category) task.reason = data.category;
    const signature = chargeLineSignature(data.charges);
    if (signature && !task.chargeSignature) task.chargeSignature = signature;
    if (!task.dispatcherKey && !task.dispatcherEmail) {
      const enriched = ownership.applyOwnerDefaults({
        ...task,
        to: task.to || data.to || null,
        cc: task.cc || data.cc || null,
        dispatcherEmail: data.dispatcherEmail || null,
        dispatcherName: data.dispatcherName || null,
      });
      task.to = enriched.to;
      task.cc = enriched.cc;
      task.ownerBucket = enriched.ownerBucket;
      task.dispatcherEmail = enriched.dispatcherEmail;
      task.dispatcherName = enriched.dispatcherName;
      task.dispatcherKey = enriched.dispatcherKey;
    }
  });

  const linkedFollowUpIds = new Set(
      tasks.map((task) => task.followUpId).filter(Boolean),
  );
  followById.forEach((data, id) => {
    if (linkedFollowUpIds.has(id)) return;
    tasks.push(chargeTaskFromFollowUp(id, data, tenantId));
  });

  await enrichTasksFromNotifications(db, tasks, tenantId, routingPromise);

  const visible = collapseDuplicateTasks(tasks);
  visible.sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  });

  if (opts.unpaged) {
    const phase = String(opts.chargePhase || "").toLowerCase();
    let working = visible;
    if (phase === "dispute") {
      working = visible.filter(isOptionDDispute);
    } else if (phase === "missing_pod") {
      working = visible.filter(isMissingPodItem);
    } else if (phase !== "all") {
      working = visible.filter((task) => !isOptionDDispute(task));
    }
    return {
      tasks: working,
      openCount: working.length,
      disputeCount: visible.filter(isOptionDDispute).length,
      missingPodCount: visible.filter(isMissingPodItem).length,
    };
  }

  return partitionByChargePhase(visible, {
    chargePhase: opts.chargePhase,
    issue: opts.issue || "all",
    dispatcher: opts.dispatcher || opts.dispatcherKey || "",
    limit,
    offset,
  });
}

/**
 * Newest open notifications, only the fields that route a task to a person.
 * Never rejects: a failed read just skips the routing step.
 * @param {object} db Firestore.
 * @param {string} tenantId Tenant.
 * @return {Promise<object|null>} Query snapshot, or null on failure.
 */
async function loadNotificationRouting(db, tenantId) {
  try {
    return await db.collection("dashboardNotifications")
        .where("tenantId", "==", tenantId)
        .where("status", "==", "open")
        .orderBy("createdAt", "desc")
        .select(...NOTIFICATION_ROUTING_FIELDS)
        .limit(200)
        .get();
  } catch (err) {
    console.error("[enrichTasksFromNotifications]", err.message);
    return null;
  }
}

/**
 * Older tasks lack dispatcher fields. Open notifications still store To/Cc
 * from the approval email, so reuse those to assign roster owners at list time.
 * @param {object} db Firestore.
 * @param {object[]} tasks Task rows.
 * @param {string} tenantId Tenant.
 * @param {Promise<object>=} preloaded Routing read started earlier.
 * @return {Promise<void>}
 */
async function enrichTasksFromNotifications(
    db, tasks, tenantId, preloaded) {
  const need = (tasks || []).filter((task) =>
    task && !task.dispatcherKey && !task.dispatcherEmail);
  if (!need.length) return;
  const snap = preloaded ?
    await preloaded : await loadNotificationRouting(db, tenantId);
  if (!snap || snap.empty) return;
  const byFollowUp = new Map();
  const byMessage = new Map();
  const byLoad = new Map();
  snap.docs.forEach((doc) => {
    const d = doc.data() || {};
    const row = {to: d.to || null, cc: d.cc || null};
    if (d.followUpId) byFollowUp.set(String(d.followUpId), row);
    if (d.messageId) byMessage.set(String(d.messageId), row);
    if (d.loadNumber && !byLoad.has(String(d.loadNumber))) {
      byLoad.set(String(d.loadNumber), row);
    }
  });
  need.forEach((task) => {
    const hit = (task.followUpId && byFollowUp.get(String(task.followUpId))) ||
      (task.messageId && byMessage.get(String(task.messageId))) ||
      (task.loadNumber && byLoad.get(String(task.loadNumber))) ||
      null;
    if (!hit) return;
    const enriched = ownership.applyOwnerDefaults({
      ...task,
      to: task.to || hit.to,
      cc: task.cc || hit.cc,
    });
    task.to = enriched.to;
    task.cc = enriched.cc;
    task.ownerBucket = enriched.ownerBucket;
    task.dispatcherEmail = enriched.dispatcherEmail;
    task.dispatcherName = enriched.dispatcherName;
    task.dispatcherKey = enriched.dispatcherKey;
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
/**
 * Loads charge totals for tasks that were saved before amounts were stored.
 * @param {object} db Firestore.
 * @param {object} additionalChargesMod Follow-up module.
 * @param {object[]} docs Task snapshots.
 * @return {Promise<Map<string, object>>}
 */
async function loadFollowUpSeeds(db, additionalChargesMod, docs) {
  const seeds = new Map();
  if (!additionalChargesMod || typeof db.getAll !== "function") return seeds;
  const ids = [];
  docs.forEach((doc) => {
    const row = doc.data ? doc.data() : doc;
    const id = String((row && row.followUpId) || "").trim();
    if (!id || seeds.has(id)) return;
    if (row.chargesTotal != null &&
        (row.chargeSignature || chargeLineSignature(row.charges))) {
      return;
    }
    ids.push(id);
  });
  if (!ids.length) return seeds;
  const refs = ids.slice(0, 100).map((id) =>
    db.collection(additionalChargesMod.FOLLOW_UP_COLLECTION).doc(id));
  const snaps = await db.getAll(...refs);
  snaps.forEach((snap) => {
    if (!snap.exists) return;
    seeds.set(snap.id, snap.data() || {});
  });
  return seeds;
}

/**
 * @param {object} row Task fields.
 * @param {object|null} follow Follow-up fields.
 * @return {object}
 */
function taskWithFollowUpAmount(row, follow) {
  const data = follow || {};
  return {
    type: row.type || null,
    loadNumber: row.loadNumber || data.loadNumber || null,
    reason: row.reason || data.category || null,
    chargesTotal: row.chargesTotal != null ?
      row.chargesTotal : data.chargesTotal,
    charges: data.charges || null,
    chargeSignature: row.chargeSignature || null,
    followUpId: row.followUpId || null,
    messageId: row.messageId || null,
    tenantId: row.tenantId || data.tenantId || null,
    chargePhase: row.chargePhase || null,
    followUpStatus: row.followUpStatus || data.status || null,
    decision: row.decision || data.decision || null,
    status: row.status || data.status || null,
  };
}

/**
 * Dismisses other open tasks that are the same work item.
 * @param {object} db Firestore.
 * @param {object} additionalChargesMod Follow-up module.
 * @param {object} seed Task identity.
 * @return {Promise<number>}
 */
async function dismissDuplicateOpenTasks(db, additionalChargesMod, seed) {
  const loadNumber = String((seed && seed.loadNumber) || "").trim();
  const messageId = String((seed && seed.messageId) || "").trim();
  const followUpId = String((seed && seed.followUpId) || "").trim();
  let snap = null;
  if (loadNumber) {
    snap = await db.collection(TASK_COLLECTION)
        .where("loadNumber", "==", loadNumber)
        .limit(200)
        .get();
  } else if (messageId) {
    snap = await db.collection(TASK_COLLECTION)
        .where("messageId", "==", messageId)
        .limit(20)
        .get();
  } else if (followUpId) {
    snap = await db.collection(TASK_COLLECTION)
        .where("followUpId", "==", followUpId)
        .limit(20)
        .get();
  }
  if (!snap) return 0;
  const openDocs = [];
  snap.forEach((doc) => {
    const row = doc.data() || {};
    if (row.status === TASK_STATUS.DISMISSED) return;
    if (seed.tenantId && row.tenantId && row.tenantId !== seed.tenantId) {
      return;
    }
    openDocs.push(doc);
  });
  const follows = await loadFollowUpSeeds(
      db, additionalChargesMod, openDocs);
  const writes = [];
  openDocs.forEach((doc) => {
    const row = doc.data() || {};
    const follow = follows.get(row.followUpId) || null;
    const candidate = taskWithFollowUpAmount(row, follow);
    if (!isSameWorkItem(seed, candidate)) return;
    writes.push(doc.ref.update({
      status: TASK_STATUS.DISMISSED,
      dismissedAt: admin.firestore.FieldValue.serverTimestamp(),
    }));
  });
  await Promise.all(writes);
  return writes.length;
}

/**
 * Resolves unresolved follow-ups that are the same charge.
 * @param {object} db Firestore.
 * @param {object} additionalChargesMod Follow-up module.
 * @param {object} seed Charge identity.
 * @return {Promise<number>}
 */
async function resolveDuplicateFollowUps(db, additionalChargesMod, seed) {
  const loadNumber = String((seed && seed.loadNumber) || "").trim();
  if (!loadNumber || !additionalChargesMod) return 0;
  const snap = await db.collection(additionalChargesMod.FOLLOW_UP_COLLECTION)
      .where("loadNumber", "==", loadNumber)
      .limit(200)
      .get();
  const writes = [];
  snap.forEach((doc) => {
    const row = doc.data() || {};
    if (row.resolved === true) return;
    if (seed.tenantId && row.tenantId && row.tenantId !== seed.tenantId) {
      return;
    }
    const candidate = {
      type: TASK_TYPE.ADDITIONAL_CHARGE,
      loadNumber: row.loadNumber,
      reason: row.category,
      chargesTotal: row.chargesTotal,
      charges: row.charges,
      followUpId: doc.id,
    };
    if (!isSameWorkItem(seed, candidate)) return;
    writes.push(doc.ref.update({
      resolved: true,
      status: additionalChargesMod.FOLLOW_UP_STATUS.RESOLVED,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }));
  });
  await Promise.all(writes);
  return writes.length;
}

/**
 * Dismisses a dashboard task or resolves an additional-charge follow-up.
 * Also clears open retry copies of that same work item.
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
    const row = snap.data() || {};
    if (opts.tenantId && row.tenantId && row.tenantId !== opts.tenantId) {
      return {ok: false, error: "Task not found."};
    }
    await ref.update({
      resolved: true,
      status: additionalChargesMod.FOLLOW_UP_STATUS.RESOLVED,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const seed = {
      type: TASK_TYPE.ADDITIONAL_CHARGE,
      tenantId: row.tenantId || opts.tenantId || null,
      loadNumber: row.loadNumber || null,
      reason: row.category || null,
      chargesTotal: row.chargesTotal,
      charges: row.charges,
      followUpId: taskId,
    };
    await resolveDuplicateFollowUps(db, additionalChargesMod, seed);
    await dismissDuplicateOpenTasks(db, additionalChargesMod, seed);
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
  let seed = taskWithFollowUpAmount(data, null);
  if (data.type === TASK_TYPE.ADDITIONAL_CHARGE && data.followUpId &&
      additionalChargesMod) {
    const followSnap = await db
        .collection(additionalChargesMod.FOLLOW_UP_COLLECTION)
        .doc(String(data.followUpId))
        .get();
    const follow = followSnap.exists ? (followSnap.data() || {}) : null;
    seed = taskWithFollowUpAmount(data, follow);
    seed.type = TASK_TYPE.ADDITIONAL_CHARGE;
    await resolveDuplicateFollowUps(db, additionalChargesMod, seed);
  }
  await dismissDuplicateOpenTasks(db, additionalChargesMod, seed);
  return {ok: true};
}

/**
 * Open tasks and unresolved charges for one load number.
 * Used when the search box is a load id so the result does not depend
 * on which page the current sort would have returned.
 * @param {object} db Firestore.
 * @param {object} additionalChargesMod additional-charges module.
 * @param {object} opts tenantId, q.
 * @return {Promise<{tasks: object[]}>}
 */
async function searchOpenByLoadNumber(db, additionalChargesMod, opts) {
  const raw = String((opts && opts.q) || "").trim();
  const tenantId = String((opts && opts.tenantId) || "default");
  if (!raw) return {tasks: []};
  const values = [raw];
  if (/^\d+$/.test(raw)) values.push(Number(raw));
  const tasks = [];
  const seen = new Set();
  const followCollection = additionalChargesMod &&
    additionalChargesMod.FOLLOW_UP_COLLECTION;
  // All four lookups start together; rows are still added in the old order
  // (tasks for each value, then follow-ups for each value).
  const taskSnaps = values.map((value) =>
    db.collection(TASK_COLLECTION)
        .where("loadNumber", "==", value)
        .limit(40)
        .get());
  const followSnaps = followCollection ? values.map((value) =>
    db.collection(followCollection)
        .where("loadNumber", "==", value)
        .limit(20)
        .get()) : [];
  await Promise.all([...taskSnaps, ...followSnaps]);
  for (const pending of taskSnaps) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await pending;
    snap.forEach((doc) => {
      if (seen.has(doc.id)) return;
      const data = doc.data() || {};
      if ((data.status || "") !== TASK_STATUS.OPEN) return;
      if (!ownership.sameTenant(data.tenantId, tenantId)) return;
      seen.add(doc.id);
      tasks.push(serializeTaskDoc(doc));
    });
  }
  if (followCollection) {
    for (const pending of followSnaps) {
      // eslint-disable-next-line no-await-in-loop
      const snap = await pending;
      snap.forEach((doc) => {
        if (seen.has(`fu:${doc.id}`)) return;
        const data = doc.data() || {};
        if (data.resolved === true) return;
        if (!ownership.sameTenant(data.tenantId, tenantId)) return;
        seen.add(`fu:${doc.id}`);
        tasks.push(chargeTaskFromFollowUp(doc.id, data, tenantId));
      });
    }
  }
  return {tasks};
}

const DETAIL_BODY_CAP = 120000;

/**
 * @param {*} value Email HTML or text.
 * @return {string|null}
 */
function capDetailBody(value) {
  if (value == null || value === "") return null;
  const text = String(value);
  return text.length <= DETAIL_BODY_CAP ? text :
    text.slice(0, DETAIL_BODY_CAP);
}

/**
 * Rebuilds the additional-charge approval HTML when the email was not saved.
 * @param {object} additionalChargesMod additional-charges module.
 * @param {object} d Follow-up doc data.
 * @return {string}
 */
function buildChargeFallbackHtml(additionalChargesMod, d) {
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
    console.error("[buildChargeFallbackHtml]", err.message);
  }
  const esc = (v) => String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const money = (n) => {
    const num = Number(n);
    return Number.isFinite(num) ? `$${num.toFixed(2)}` : "—";
  };
  const rows = (Array.isArray(d.charges) ? d.charges : []).map((c) => {
    const name = esc(c.name || c.description || c.type || "Charge");
    const amt = money(c.amount != null ? c.amount : c.total);
    return `<tr><td style="padding:6px 12px 6px 0">${name}</td>` +
      `<td style="padding:6px 0;text-align:right">${amt}</td></tr>`;
  }).join("");
  return `<div style="font-family:Arial,sans-serif;color:#111827;` +
    `font-size:15px;line-height:1.55">` +
    `<p style="margin:0 0 12px"><strong>Additional charge approval` +
    `</strong></p>` +
    `<p style="margin:0 0 6px">Load ${esc(d.loadNumber || "—")} · ` +
    `${esc(d.carrierName || "—")}</p>` +
    `<p style="margin:0 0 12px">Charges total ` +
    `<strong>${money(d.chargesTotal)}</strong></p>` +
    (rows ? `<table style="border-collapse:collapse;width:100%;` +
      `max-width:420px">${rows}</table>` : "") +
    `<p style="margin:16px 0 0;color:#374151">Choose A–E below to ` +
    `decide.</p></div>`;
}

/**
 * Email HTML and charge lines for one open row. Tenant-checked.
 * The work list does not carry this payload; the dashboard asks for it when
 * a row is opened.
 * @param {object} db Firestore.
 * @param {object} additionalChargesMod additional-charges module.
 * @param {object} opts id, source, tenantId.
 * @return {Promise<object>}
 */
async function loadItemDetail(db, additionalChargesMod, opts) {
  const id = String((opts && opts.id) || "").trim();
  const source = String((opts && opts.source) || "dashboardTasks");
  const tenantId = String((opts && opts.tenantId) || "default");
  if (!id) return {ok: false, error: "Not found."};
  if (source === "invoice" || id.startsWith("invoice:")) {
    return {ok: true, body: null, charges: []};
  }
  const followCollection = additionalChargesMod &&
    additionalChargesMod.FOLLOW_UP_COLLECTION;
  let taskData = null;
  let followId = null;
  let type = null;
  if (source === "additionalCharges") {
    followId = id;
    type = TASK_TYPE.ADDITIONAL_CHARGE;
  } else {
    const snap = await db.collection(TASK_COLLECTION).doc(id).get();
    if (!snap.exists) return {ok: false, error: "Not found."};
    taskData = snap.data() || {};
    if (!ownership.sameTenant(taskData.tenantId, tenantId)) {
      return {ok: false, error: "Not found."};
    }
    followId = taskData.followUpId || null;
    type = taskData.type || null;
  }
  let follow = null;
  if (followId && followCollection) {
    const snap = await db.collection(followCollection).doc(followId).get();
    if (snap.exists) follow = snap.data() || {};
  }
  if (source === "additionalCharges" && !follow) {
    return {ok: false, error: "Not found."};
  }
  if (follow && !ownership.sameTenant(follow.tenantId, tenantId)) {
    if (source === "additionalCharges") {
      return {ok: false, error: "Not found."};
    }
    follow = null;
  }
  const stored = taskData ? capDetailBody(taskData.body) : null;
  const emailHtml = follow ? capDetailBody(follow.emailHtml) : null;
  let body = null;
  if (source === "additionalCharges") {
    body = emailHtml || buildChargeFallbackHtml(additionalChargesMod, follow);
  } else if (stored || emailHtml) {
    body = stored || emailHtml;
  } else if (follow && type === TASK_TYPE.ADDITIONAL_CHARGE) {
    body = buildChargeFallbackHtml(additionalChargesMod, follow);
  }
  // Charge lines are left out on purpose. The A-F form seeds its lines from
  // them, and this production line has never sent them, so the form keeps
  // starting with one empty line exactly as it does today.
  return {ok: true, body, charges: []};
}

module.exports = {
  loadItemDetail,
  TASK_COLLECTION,
  TASK_TYPE,
  TASK_STATUS,
  createDashboardTask,
  listDashboardTasks,
  dismissDashboardTask,
  markTasksInDispute,
  isOptionDDispute,
  isMissingPodItem,
  matchesIssueFilter,
  isSameWorkItem,
  collapseDuplicateTasks,
  chargeLineSignature,
  partitionByChargePhase,
  applyFollowUpDispute,
  chargeTaskFromFollowUp,
  dispatcherMatches,
  searchOpenByLoadNumber,
};
