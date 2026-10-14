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
  const wf = String(data.finalWorkflowStatus || "");
  const stage = String(data.decisionStage || "");
  if (wf === "completed" || stage === "completed") return null;
  const issueType = scope.classifyIssue({
    decisionStage: stage,
    finalWorkflowStatus: wf,
    decisionReason: data.decisionReason,
    reason: data.decisionReason,
  });
  if (issueType === scope.ISSUE.MISCELLANEOUS &&
      !HOLD_STAGES.includes(stage)) {
    return null;
  }
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
 * @param {object} db Firestore.
 * @param {object} deps tenant, tcol, dashboardTasks, additionalCharges.
 * @param {object} opts issue, dispatcher, limit, offset.
 * @return {Promise<object>}
 */
async function listOperationalQueue(db, deps, opts) {
  const tenant = deps.tenant;
  const tenantId = tenant.tenantId;
  const listed = await deps.dashboardTasks.listDashboardTasks(
      db, deps.additionalCharges, {
        tenantId,
        collectionPrefix: tenant.collectionPrefix,
        limit: 2000,
        maxLimit: 2000,
        offset: 0,
        chargePhase: "all",
        urgentFirst: true,
        skipHydrate: true,
      });
  const tasks = (listed.tasks || []).map((task) => ({
    ...task,
    issueType: scope.classifyIssue(task),
  }));

  const invoiceRows = [];
  if (typeof deps.tcol === "function") {
    try {
      const snap = await deps.tcol(tenant, "invoices")
          .where("decisionStage", "in", HOLD_STAGES)
          .limit(500)
          .get();
      snap.forEach((doc) => {
        const row = invoiceHoldRow(doc, tenantId);
        if (row) invoiceRows.push(row);
      });
    } catch (err) {
      console.error("[dashboard-queue] invoice holds:", err.message);
    }
  }

  let merged = scope.mergeQueueItems(tasks.concat(invoiceRows))
      .map((row) => ownership.applyOwnerDefaults(row));
  const issue = String(opts.issue || "all").toLowerCase();
  if (issue && issue !== "all") {
    merged = merged.filter((row) => row.issueType === issue);
  }
  const dispatcher = opts.dispatcher || opts.dispatcherKey || "";
  merged = merged.filter((row) => scope.dispatcherMatches(row, dispatcher));

  const page = ownership.filterSortPaginate(merged, {
    offset: opts.offset,
    limit: opts.limit || 50,
    maxLimit: 100,
    urgentFirst: opts.urgentFirst !== false,
  });
  if (typeof deps.dashboardTasks.hydratePageBodies === "function") {
    await deps.dashboardTasks.hydratePageBodies(
        db, deps.additionalCharges, page.items, tenant.tenantId);
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
    disputeCount: listed.disputeCount || 0,
  };
}

module.exports = {
  listOperationalQueue,
  invoiceHoldRow,
};
