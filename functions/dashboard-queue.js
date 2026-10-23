/**
 * One operational list: open tasks plus invoice holds, one row per load/issue.
 */

"use strict";

const scope = require("./dashboard-scope");
const ownership = require("./dashboard-ownership");

const HOLD_STAGES = [
  "needs_customer_rate_review",
  "missing_pod",
  "needs_pod",
  "awaiting_pod",
];

/** Invoice fields the work list needs. Skips extracted bodies and mail HTML. */
const INVOICE_HOLD_FIELDS = [
  "tenantId", "finalWorkflowStatus", "decisionStage", "decisionReason",
  "dashboardDismissedIssues", "createdAt", "loadNumber", "proNumber",
  "carrierName", "invoiceAmount", "dispatcherEmail", "dispatcherName",
  "emailReceivedAt", "customerRate",
];

/** Task fields used to hide rows someone already marked done. No email HTML. */
const DISMISS_LOOKUP_FIELDS = [
  "status", "tenantId", "invoiceId", "loadNumber", "type", "emailType",
  "reason", "decisionReason", "decisionStage", "displayStatus",
  "finalWorkflowStatus", "title",
];

/**
 * Issue a live invoice hold would show, before dashboard dismissal.
 * @param {object} data Invoice fields.
 * @return {string|null}
 */
function holdIssueForInvoice(data) {
  const wf = String((data && data.finalWorkflowStatus) || "");
  const stage = String((data && data.decisionStage) || "");
  if (wf === "completed" || stage === "completed") return null;
  const issueType = scope.classifyIssue({
    decisionStage: stage,
    finalWorkflowStatus: wf,
    decisionReason: data && data.decisionReason,
    reason: data && data.decisionReason,
  });
  if (issueType === scope.ISSUE.MISCELLANEOUS &&
      !HOLD_STAGES.includes(stage)) {
    return null;
  }
  return issueType;
}

/**
 * Drops rows the dispatcher already marked done.
 * A dismissed task used to leave the invoice hold or a new copy on the list.
 * @param {object} db Firestore.
 * @param {object[]} rows Queue rows with issueType.
 * @param {string} tenantId Tenant.
 * @return {Promise<object[]>}
 */
async function omitRowsClosedByDismissedTask(db, rows, tenantId) {
  const list = Array.isArray(rows) ? rows : [];
  const invoiceIds = [...new Set(list.map((row) =>
    String((row && row.invoiceId) || "").trim()).filter(Boolean))];
  const loads = [...new Set(list.map((row) =>
    String((row && row.loadNumber) || "").trim()).filter(Boolean))];
  const closed = new Set();
  const remember = (data) => {
    if ((data.status || "") !== "dismissed") return;
    if (!ownership.sameTenant(data.tenantId, tenantId)) return;
    const issue = scope.classifyIssue(data);
    const invoiceId = String(data.invoiceId || "").trim();
    const load = String(data.loadNumber || "").trim();
    if (invoiceId) closed.add(`${invoiceId}|${issue}`);
    if (load) closed.add(`load:${load}|${issue}`);
  };
  const pull = async (field, values) => {
    const chunks = [];
    for (let i = 0; i < values.length; i += 10) {
      const chunk = values.slice(i, i + 10);
      if (chunk.length) chunks.push(chunk);
    }
    const concurrency = 8;
    for (let i = 0; i < chunks.length; i += concurrency) {
      const batch = chunks.slice(i, i + concurrency);
      // eslint-disable-next-line no-await-in-loop
      const snaps = await Promise.all(batch.map((chunk) =>
        db.collection("dashboardTasks")
            .where(field, "in", chunk)
            .select(...DISMISS_LOOKUP_FIELDS)
            .get()));
      snaps.forEach((snap) => {
        snap.forEach((doc) => remember(doc.data() || {}));
      });
    }
  };
  try {
    const numeric = loads.filter((load) => /^\d+$/.test(load)).map(Number);
    await Promise.all([
      pull("invoiceId", invoiceIds),
      pull("loadNumber", loads),
      pull("loadNumber", numeric),
    ]);
  } catch (err) {
    console.error("[dashboard-queue] dismissed rows:", err.message);
    return list;
  }
  return list.filter((row) => {
    const issue = row.issueType || scope.classifyIssue(row);
    const invoiceId = String(row.invoiceId || "").trim();
    const load = String(row.loadNumber || "").trim();
    const closedRow = (invoiceId && closed.has(`${invoiceId}|${issue}`)) ||
      (load && closed.has(`load:${load}|${issue}`));
    if (!closedRow) return true;
    if (row.source === "invoice") return false;
    const type = String(row.type || "");
    if (type === "missing_rate" || type === "rate_missing" ||
        type === "missing_pod" || type === "signed_pod" ||
        type === "pod_discrepancy" || type === "invoice_hold") {
      return false;
    }
    return true;
  });
}

/**
 * @param {object} doc Invoice snapshot.
 * @param {string} tenantId Tenant id.
 * @return {object|null}
 */
function invoiceHoldRow(doc, tenantId) {
  const data = doc.data() || {};
  if (!scope.rowBelongsToTenant(data, tenantId) &&
      !ownership.sameTenant(data.tenantId, tenantId)) {
    return null;
  }
  const issueType = holdIssueForInvoice(data);
  if (!issueType) return null;
  if (scope.isIssueDismissed(data, issueType)) return null;
  const stage = String(data.decisionStage || "");
  const wf = String(data.finalWorkflowStatus || "");
  const rateHold = ownership.isMissingCarrierRateHold(data) ||
    scope.isRateHold({
      decisionStage: stage,
      reason: data.decisionReason,
      type: issueType === scope.ISSUE.MISSING_RATE ? "missing_rate" : "",
    });
  const createdAt = data.createdAt && data.createdAt.toDate ?
    data.createdAt.toDate().toISOString() : null;
  return {
    id: `invoice:${doc.id}`,
    source: "invoice",
    tenantId,
    type: issueType === scope.ISSUE.MISSING_RATE ? "missing_rate" :
      (issueType === scope.ISSUE.MISSING_POD ? "missing_pod" : "invoice_hold"),
    title: data.decisionReason || scope.issueLabel(issueType),
    reason: data.decisionReason || stage,
    loadNumber: data.loadNumber || null,
    proNumber: data.proNumber || null,
    carrierName: data.carrierName || null,
    invoiceId: doc.id,
    invoiceAmount: data.invoiceAmount || null,
    chargesTotal: data.invoiceAmount || null,
    ownerBucket: rateHold ? "dispatch" : "accounting",
    dispatcherEmail: data.dispatcherEmail || null,
    dispatcherName: data.dispatcherName || null,
    dispatcherKey: data.dispatcherEmail ?
      String(data.dispatcherEmail).trim().toLowerCase() : null,
    decisionStage: stage,
    finalWorkflowStatus: wf,
    issueType,
    createdAt,
    receivedAt: data.emailReceivedAt && data.emailReceivedAt.toDate ?
      data.emailReceivedAt.toDate().toISOString() :
      (typeof data.emailReceivedAt === "string" ? data.emailReceivedAt : null),
    status: "open",
  };
}

/**
 * Invoice holds for the work list. Field mask only — invoice docs are large.
 * @param {object} deps tcol.
 * @param {object} tenant Tenant.
 * @param {string} tenantId Tenant id.
 * @param {string} q Search text.
 * @param {boolean} loadSearch True when q is a load number.
 * @param {number} fetchLimit Cap.
 * @return {Promise<object[]>}
 */
async function loadInvoiceHoldRows(
    deps, tenant, tenantId, q, loadSearch, fetchLimit) {
  if (typeof deps.tcol !== "function") return [];
  const rows = [];
  try {
    let snap;
    if (loadSearch) {
      const values = [q, Number(q)];
      const docs = [];
      for (const value of values) {
        // eslint-disable-next-line no-await-in-loop
        const part = await deps.tcol(tenant, "invoices")
            .where("loadNumber", "==", value)
            .select(...INVOICE_HOLD_FIELDS)
            .limit(15)
            .get();
        docs.push(...part.docs);
      }
      snap = {forEach: (fn) => docs.forEach(fn)};
    } else {
      snap = await deps.tcol(tenant, "invoices")
          .where("decisionStage", "in", HOLD_STAGES)
          .select(...INVOICE_HOLD_FIELDS)
          .limit(fetchLimit)
          .get();
    }
    snap.forEach((doc) => {
      const row = invoiceHoldRow(doc, tenantId);
      if (row) rows.push(row);
    });
  } catch (err) {
    console.error("[dashboard-queue] invoice holds:", err.message);
  }
  return rows;
}

/**
 * @param {object} db Firestore.
 * @param {object} deps tenant, tcol, dashboardTasks, additionalCharges.
 * @param {object} opts issue, dispatcher, limit, offset.
 * @return {Promise<object>}
 */
async function listOperationalQueue(db, deps, opts) {
  const tenant = deps.tenant;
  const tenantId = tenant.tenantId;
  const sort = String(opts.sort || "").toLowerCase();
  const q = String(opts.q || "").trim();
  const loadSearch = /^\d{5,}$/.test(q);
  const fetchLimit = loadSearch ? 40 :
    (Number(opts.offset) > 0 ? 800 : 220);

  const invoicePromise = loadInvoiceHoldRows(
      deps, tenant, tenantId, q, loadSearch, fetchLimit);

  let listedPromise;
  if (loadSearch &&
      typeof deps.dashboardTasks.searchOpenByLoadNumber === "function") {
    listedPromise = deps.dashboardTasks.searchOpenByLoadNumber(
        db, deps.additionalCharges, {tenantId, q}).then((listed) => {
      listed.disputeCount = (listed.tasks || []).filter((t) =>
        scope.isOptionDDispute(t)).length;
      return listed;
    });
  } else {
    listedPromise = deps.dashboardTasks.listDashboardTasks(
        db, deps.additionalCharges, {
          tenantId,
          collectionPrefix: tenant.collectionPrefix,
          chargePhase: "all",
          unpaged: true,
          skipHydrate: true,
          fetchLimit,
        });
  }
  const [listed, invoiceRows] = await Promise.all([
    listedPromise, invoicePromise,
  ]);
  const tasks = (listed.tasks || []).map((task) => ({
    ...task,
    issueType: scope.classifyIssue(task),
  }));

  const visible = await omitRowsClosedByDismissedTask(
      db, tasks.concat(invoiceRows), tenantId);
  let merged = scope.mergeQueueItems(visible)
      .map((row) => ownership.applyOwnerDefaults(row));
  if (q && !loadSearch) {
    const needle = q.toLowerCase();
    merged = merged.filter((row) => {
      const hay = [
        row.loadNumber, row.carrierName, row.title, row.reason,
        row.proNumber, row.subject, row.description,
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(needle);
    });
  }
  const phase = String(opts.chargePhase || "").toLowerCase();
  const disputeRows = merged.filter((row) =>
    scope.isOptionDDispute(row));
  const disputeCount = disputeRows.length;
  if (phase === "dispute") {
    merged = disputeRows;
  } else {
    merged = merged.filter((row) => !scope.isOptionDDispute(row));
    const issue = String(opts.issue || "all").toLowerCase();
    if (issue && issue !== "all") {
      merged = merged.filter((row) => row.issueType === issue);
    }
    const dispatcher = opts.dispatcher || opts.dispatcherKey || "";
    merged = merged.filter((row) => scope.dispatcherMatches(row, dispatcher));
  }

  const page = ownership.filterSortPaginate(merged, {
    offset: opts.offset,
    limit: opts.limit || 50,
    maxLimit: 100,
    sort,
    urgentFirst: opts.urgentFirst !== false,
  });
  // Email HTML is loaded when a row is opened, not with every page.
  page.items.forEach((item) => {
    if (item) item.body = null;
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

module.exports = {
  listOperationalQueue,
  invoiceHoldRow,
  holdIssueForInvoice,
};
