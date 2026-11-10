/**
 * One operational list: open tasks plus invoice holds, one row per load/issue.
 */

"use strict";

const scope = require("./dashboard-scope");
const ownership = require("./dashboard-ownership");
const podDash = require("./missing-pod-dashboard");

const HOLD_STAGES = [
  "needs_customer_rate_review",
  "missing_pod",
  "needs_pod",
  "awaiting_pod",
];

/** Same windows as the dashboard Day / Week / Month / Year control. */
const SEARCH_RANGE_DAYS = Object.freeze({
  day: 1,
  week: 7,
  month: 30,
  year: 365,
});

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
 * Loads every open hold for one folder. The mixed newest-task scan misses
 * older missing-POD and missing-rate rows, which made those folders look empty.
 * @param {object} db Firestore.
 * @param {object} deps tcol.
 * @param {object} tenant Tenant.
 * @param {string} tenantId Tenant id.
 * @param {string} issue missing_pod or missing_rate.
 * @return {Promise<object[]|null>} Null when the lookup cannot run.
 */
async function loadIssueRows(db, deps, tenant, tenantId, issue) {
  if (typeof deps.tcol !== "function") return null;
  const stages = issue === scope.ISSUE.MISSING_POD ?
    ["missing_pod", "needs_pod", "awaiting_pod"] :
    ["needs_customer_rate_review"];
  const taskType = issue === scope.ISSUE.MISSING_POD ?
    "missing_pod" : "missing_rate";
  try {
    const invSnap = await deps.tcol(tenant, "invoices")
        .where("decisionStage", "in", stages)
        .select(...INVOICE_HOLD_FIELDS)
        .limit(800)
        .get();
    let taskDocs = [];
    try {
      const taskSnap = await deps.tcol(tenant, "dashboardTasks")
          .where("status", "==", "open")
          .where("type", "==", taskType)
          .limit(500)
          .get();
      taskDocs = taskSnap.docs || [];
    } catch (taskErr) {
      console.warn("[loadIssueRows] tasks", taskErr && taskErr.message);
    }
    const invoices = [];
    invSnap.forEach((doc) => {
      const row = invoiceHoldRow(doc, tenantId);
      if (row) invoices.push(row);
    });
    const tasks = taskDocs.map((doc) => {
      const data = doc.data() || {};
      const row = {
        id: doc.id,
        source: "dashboardTasks",
        type: data.type || taskType,
        status: data.status || "open",
        tenantId: data.tenantId || tenantId,
        loadNumber: data.loadNumber || null,
        proNumber: data.proNumber || null,
        carrierName: data.carrierName || null,
        title: data.title || null,
        reason: data.reason || null,
        subject: data.subject || null,
        description: data.description || null,
        ownerEmail: data.ownerEmail || null,
        dispatcherEmail: data.dispatcherEmail || null,
        dispatcherName: data.dispatcherName || null,
        createdAt: data.createdAt && data.createdAt.toDate ?
          data.createdAt.toDate().toISOString() : (data.createdAt || null),
        invoiceId: data.invoiceId || null,
      };
      row.issueType = scope.classifyIssue(row);
      return row;
    }).filter((row) => scope.rowBelongsToTenant(row, tenantId));
    const visible = invoices.length || tasks.length ?
      await omitRowsClosedByDismissedTask(
          db, tasks.concat(invoices), tenantId) :
      [];
    return scope.mergeQueueItems(visible)
        .map((row) => ownership.applyOwnerDefaults(row))
        .filter((row) => issue === scope.ISSUE.MISSING_POD ?
          podDash.isMissingPodDashboardItem(row) :
          row.issueType === scope.ISSUE.MISSING_RATE);
  } catch (err) {
    console.warn("[loadIssueRows]", err && err.message);
    return null;
  }
}

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
 * @param {object} row Queue row.
 * @return {number|null} Millis, or null when the row has no timestamp.
 */
function queueRowTime(row) {
  const raw = row && (row.receivedAt || row.createdAt || row.emailReceivedAt);
  const parsed = Date.parse(raw || "");
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Search text across the fields a dispatcher would type.
 * @param {object} row Queue row.
 * @param {string} query Search box text.
 * @return {boolean}
 */
function queueRowMatchesQuery(row, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  const load = String(row && row.loadNumber == null ? "" : row.loadNumber)
      .trim().toLowerCase();
  if (load && (load === needle || load.includes(needle))) return true;
  const hay = [
    row && row.carrierName,
    row && row.customerName,
    row && row.title,
    row && row.reason,
    row && row.proNumber,
    row && row.subject,
    row && row.description,
    row && row.invoiceId,
  ].filter((part) => part != null && String(part).trim() !== "")
      .join(" ")
      .toLowerCase();
  return hay.includes(needle);
}

/**
 * Selected Day/Week/Month/Year window. No range means no time cut.
 * Rows with no timestamp stay visible so a match is not dropped.
 * @param {object} row Queue row.
 * @param {string} range day|week|month|year.
 * @param {number} now Clock millis.
 * @return {boolean}
 */
function queueRowInRange(row, range, now) {
  const days = SEARCH_RANGE_DAYS[String(range || "").toLowerCase()];
  if (!days) return true;
  const at = queueRowTime(row);
  if (at == null) return true;
  const clock = Number(now) || Date.now();
  return at >= clock - days * 24 * 60 * 60 * 1000;
}

/**
 * Work vs In Dispute vs Missing POD stays. A search query ignores the
 * issue sub-filter and the dispatcher filter, and urgent sort never
 * removes non-urgent matches.
 * @param {object[]} merged Rows already merged.
 * @param {object} opts q, range, chargePhase, issue, dispatcher, sort.
 * @return {object}
 */
function selectOperationalRows(merged, opts) {
  const sort = String((opts && opts.sort) || "").toLowerCase();
  const q = String((opts && opts.q) || "").trim();
  const searching = Boolean(q);
  const now = Number(opts && opts.now) || Date.now();
  let rows = Array.isArray(merged) ? merged.slice() : [];
  if (searching) {
    rows = rows.filter((row) =>
      queueRowMatchesQuery(row, q) &&
      queueRowInRange(row, opts.range, now));
  }
  const phase = String((opts && opts.chargePhase) || "").toLowerCase();
  const issue = String((opts && opts.issue) || "all").toLowerCase();
  const disputeRows = rows.filter((row) => scope.isOptionDDispute(row));
  const disputeCount = disputeRows.length;
  const missingPodRows = rows.filter((row) =>
    podDash.isMissingPodDashboardItem(row));
  const missingPodCount = missingPodRows.length;
  if (phase === "dispute") {
    rows = disputeRows;
  } else if (phase === "missing_pod") {
    rows = missingPodRows;
    if (!searching) {
      rows = rows.filter((row) => scope.dispatcherMatches(
          row, opts.dispatcher || opts.dispatcherKey));
    }
  } else if (!searching && issue === scope.ISSUE.MISSING_RATE) {
    rows = rows.filter((row) => row.issueType === scope.ISSUE.MISSING_RATE);
    rows = rows.filter((row) => scope.dispatcherMatches(
        row, opts.dispatcher || opts.dispatcherKey));
  } else if (!searching && issue === scope.ISSUE.MISSING_POD) {
    rows = missingPodRows.filter((row) => scope.dispatcherMatches(
        row, opts.dispatcher || opts.dispatcherKey));
  } else {
    rows = rows.filter((row) => !scope.isOptionDDispute(row));
    if (!searching && issue && issue !== "all") {
      rows = rows.filter((row) => row.issueType === issue);
    }
    if (!searching) {
      rows = rows.filter((row) => scope.dispatcherMatches(
          row, opts.dispatcher || opts.dispatcherKey));
    }
  }
  const page = ownership.filterSortPaginate(rows, {
    offset: opts && opts.offset,
    limit: (opts && opts.limit) || 50,
    maxLimit: 100,
    sort,
    urgentFirst: opts && opts.urgentFirst !== false,
  });
  return {
    page,
    disputeCount,
    missingPodCount,
    searching,
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
  const sort = String(opts.sort || "").toLowerCase();
  const q = String(opts.q || "").trim();
  const searching = Boolean(q);
  const loadSearch = /^\d{5,}$/.test(q);
  const requestedScan = Number(opts.scanLimit) || 0;
  // A search has to see the whole open set for the tab, not the first
  // page of whatever sort is active. Load numbers are a direct lookup.
  const fetchLimit = loadSearch ? 40 :
    (searching ? 2000 :
      (requestedScan > 0 ? Math.min(requestedScan, 800) :
        (Number(opts.offset) > 0 ? 800 : 220)));

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
  const phase = String(opts.chargePhase || "").toLowerCase();
  const issue = String(opts.issue || "all").toLowerCase();
  const scannedDisputeCount = merged.filter((row) =>
    scope.isOptionDDispute(row)).length;
  // The mixed scan is only the newest open tasks. Missing POD and missing
  // rate live further back, so those folders load their own holds.
  // Search stays on the current tab, but does not switch to a status
  // folder just because that sub-filter is selected.
  const wantsMissingPod = phase === "missing_pod" ||
    (!searching && issue === scope.ISSUE.MISSING_POD);
  let replacedWithFolder = false;
  if (wantsMissingPod) {
    const targeted = await loadIssueRows(
        db, deps, tenant, tenantId, scope.ISSUE.MISSING_POD);
    if (targeted && targeted.length) {
      merged = targeted;
      replacedWithFolder = true;
    }
  } else if (!searching && phase !== "dispute" &&
      issue === scope.ISSUE.MISSING_RATE) {
    const targeted = await loadIssueRows(
        db, deps, tenant, tenantId, scope.ISSUE.MISSING_RATE);
    if (targeted && targeted.length) {
      merged = targeted;
      replacedWithFolder = true;
    }
  }

  const selected = selectOperationalRows(merged, {
    q,
    range: opts.range,
    now: opts.now,
    chargePhase: phase,
    issue,
    dispatcher: opts.dispatcher || opts.dispatcherKey || "",
    sort,
    offset: opts.offset,
    limit: opts.limit || 50,
    urgentFirst: opts.urgentFirst,
  });
  const page = selected.page;
  const disputeCount = (!searching || replacedWithFolder) ?
    scannedDisputeCount : selected.disputeCount;
  const missingPodCount = selected.missingPodCount;
  // Email HTML is loaded when a row is opened, not with every page.
  page.items.forEach((item) => {
    if (item) item.body = null;
  });
  const payload = {
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
  // Only the Missing POD folder has the full count. Other views scan the
  // newest tasks and would replace that badge with a short number.
  if (wantsMissingPod) payload.missingPodCount = missingPodCount;
  return payload;
}

module.exports = {
  listOperationalQueue,
  invoiceHoldRow,
  holdIssueForInvoice,
  queueRowMatchesQuery,
  queueRowInRange,
  selectOperationalRows,
  SEARCH_RANGE_DAYS,
};
