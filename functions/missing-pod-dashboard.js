"use strict";

/**
 * Missing POD rows on the dashboard.
 *
 * Done only hides a row. POD done resumes the invoice the same way a POD
 * arrival does, and drops the row only after that hold is actually gone.
 * The twice-weekly job does that only when Primus already has a POD file.
 * It does not email the customer. A finished hold clears open No-POD
 * and POD-needed notices. A hold that is still missing stays up.
 */

const scope = require("./dashboard-scope");
const ownership = require("./dashboard-ownership");
const daily = require("./missing-pod-daily");
const workflowErrors = require("./workflow-error-messages");

const TASK_COLLECTION = "dashboardTasks";
const DEFAULT_BUDGET_MS = 8 * 60 * 1000;

let deps = {};

/**
 * @param {object} bundle Runtime dependencies.
 */
function init(bundle) {
  deps = bundle || {};
}

/**
 * @param {object|null|undefined} row Queue or task row.
 * @return {string}
 */
function rowType(row) {
  return String((row && (row.type || row.emailType)) || "")
      .toLowerCase();
}

/**
 * Open missing-POD dashboard item.
 * Signed POD, discrepancies, charges, and disputes are not this list.
 * @param {object|null|undefined} row Queue or task row.
 * @return {boolean}
 */
function isMissingPodDashboardItem(row) {
  if (!row || scope.isOptionDDispute(row)) return false;
  const status = String(row.status || "open").toLowerCase();
  if (status && status !== "open") return false;
  const type = rowType(row);
  if (type === "signed_pod" || type === "pod_discrepancy") return false;
  if (type === "additional_charge") return false;
  if (type === "missing_rate" || type === "rate_missing") return false;
  if (type === "human_review" || type === "unhandled_email") return false;
  const issue = row.issueType || scope.classifyIssue(row);
  if (issue !== scope.ISSUE.MISSING_POD) return false;
  if (type === "missing_pod" || type === "invoice_hold") return true;
  const stage = String(row.decisionStage || "").toLowerCase();
  if (/missing_pod|needs_pod|awaiting_pod/.test(stage)) return true;
  return !type;
}

/**
 * @param {object|null|undefined} invoice Invoice fields.
 * @return {boolean} True when the missing-POD hold is gone.
 */
function workflowLeftMissingPod(invoice) {
  const gate = daily.classifyMissingPodHold(invoice);
  return gate.reason === "already_completed" ||
    gate.reason === "not_missing_pod_hold";
}

/**
 * @param {object} row Row.
 * @param {object} opts Request fields.
 * @return {string}
 */
function invoiceIdOf(row, opts) {
  const explicit = String(
      (opts && opts.invoiceId) || (row && row.invoiceId) || "",
  ).trim();
  const taskId = String(
      (opts && opts.taskId) || (row && row.id) || "",
  ).trim();
  const source = String(
      (opts && opts.source) || (row && row.source) || "",
  );
  if (source === "invoice" || taskId.startsWith("invoice:")) {
    const parsed = taskId.startsWith("invoice:") ?
      taskId.slice("invoice:".length).trim() : "";
    return parsed || explicit;
  }
  return explicit;
}

/**
 * @param {object} resumed kickPrimusWorkflow-shaped result.
 * @return {string|null} User-facing failure, or null when the call
 *   itself did not report a failure.
 */
function resumeFailureMessage(resumed) {
  const status = Number(resumed && resumed.status || 0);
  const payload = (resumed && resumed.payload) || {};
  if (payload.error === "ALREADY_COMPLETED" ||
      payload.workflowStatus === "completed") {
    return null;
  }
  const httpOk = status >= 200 && status < 300;
  const interpreted = workflowErrors.interpretWorkflowResumeResult(
      httpOk, payload);
  if (interpreted.ok) return null;
  return interpreted.userMessage ||
    "The POD workflow did not finish.";
}

/**
 * @param {object} opts tenant, invoiceId, loadNumber, tenantId.
 * @return {Promise<number>} Tasks closed.
 */
async function closeMissingPodTasks(opts) {
  if (!deps.db || typeof deps.db.collection !== "function") return 0;
  const tenantId = opts.tenantId || "default";
  const invoiceId = String(opts.invoiceId || "").trim();
  const loadNumber = String(opts.loadNumber || "").trim();
  const loads = [];
  if (invoiceId) loads.push(["invoiceId", invoiceId]);
  if (loadNumber) {
    loads.push(["loadNumber", loadNumber]);
    if (/^\d+$/.test(loadNumber)) {
      loads.push(["loadNumber", Number(loadNumber)]);
    }
  }
  const seen = new Set();
  let closed = 0;
  for (const [field, value] of loads) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await deps.db.collection(TASK_COLLECTION)
        .where(field, "==", value)
        .limit(40)
        .get();
    for (const doc of snap.docs || []) {
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      const data = doc.data() || {};
      if (!ownership.sameTenant(data.tenantId, tenantId)) continue;
      if (!isMissingPodDashboardItem(data)) continue;
      const stamp = deps.FieldValue &&
        deps.FieldValue.serverTimestamp ?
        deps.FieldValue.serverTimestamp() : new Date().toISOString();
      // eslint-disable-next-line no-await-in-loop
      await doc.ref.update({
        status: "dismissed",
        dismissedAt: stamp,
        missingPodClosedBy: opts.closedBy || "pod_done",
      });
      closed += 1;
    }
  }
  return closed;
}

/**
 * Clears open No-POD notices after the hold is actually finished.
 * @param {object} item Dashboard row.
 * @param {object|null} invoice Invoice fields.
 * @param {string} tenantId Tenant id.
 * @return {Promise<number>} Notices dismissed.
 */
async function clearPodNotices(item, invoice, tenantId) {
  if (typeof deps.dismissOpenPodNotifications !== "function") return 0;
  const loadNumber = (invoice && invoice.loadNumber) ||
    (item && item.loadNumber) || "";
  const invoiceId = invoiceIdOf(item, item);
  if (!loadNumber && !invoiceId) return 0;
  try {
    const result = await deps.dismissOpenPodNotifications({
      loadNumber: loadNumber || null,
      invoiceId: invoiceId || null,
      tenantId: tenantId || "default",
    });
    return Number(result && result.dismissed) || 0;
  } catch (err) {
    await logRow("error", "Missing POD notice clear failed", {
      invoiceId: invoiceId || null,
      loadNumber: loadNumber || null,
      error: (err && err.message) || "dismiss_failed",
    });
    return 0;
  }
}

/**
 * @param {string} level info or error.
 * @param {string} message Log title.
 * @param {object} details Structured fields.
 * @return {Promise<void>}
 */
async function logRow(level, message, details) {
  if (typeof deps.writeLog !== "function") return;
  try {
    await deps.writeLog(level, "workflow", message, details || {});
  } catch (_) {
    // Logging must not block the rest of the rows.
  }
}

/**
 * @param {object} opts tenant, taskId, source, invoiceId, loadNumber.
 * @return {Promise<object>} {ok, error?, removed?}
 */
async function finishFromDashboard(opts) {
  const request = opts || {};
  let row = {
    id: request.taskId || "",
    source: request.source || "",
    type: request.type || "",
    issueType: request.issueType || request.issue || "",
    decisionStage: request.decisionStage || "",
    status: "open",
    loadNumber: request.loadNumber || "",
    invoiceId: request.invoiceId || "",
    chargePhase: request.chargePhase || "",
    decision: request.decision || "",
    followUpStatus: request.followUpStatus || "",
  };
  const source = String(request.source || "");
  const taskId = String(request.taskId || "");
  if (typeof deps.loadTask === "function" && taskId &&
      source !== "invoice" && !taskId.startsWith("invoice:")) {
    const task = await deps.loadTask(taskId);
    if (task) row = {...row, ...task, id: taskId};
  }
  const invoiceId = invoiceIdOf(row, request);
  if (!invoiceId || typeof deps.loadInvoice !== "function") {
    return {
      ok: false,
      removed: false,
      error: "This missing POD item is not tied to a workflow.",
    };
  }
  const before = await deps.loadInvoice(request.tenant, invoiceId);
  if (!before) {
    return {
      ok: false,
      removed: false,
      error: "Could not find the invoice for this load.",
    };
  }
  if (!row.type) {
    const issue = scope.classifyIssue({
      decisionStage: before.decisionStage,
      finalWorkflowStatus: before.finalWorkflowStatus,
      decisionReason: before.decisionReason,
      reason: before.decisionReason,
    });
    row.issueType = row.issueType || issue;
    row.type = issue === scope.ISSUE.MISSING_POD ?
      "missing_pod" : (issue || "");
  }
  row.decisionStage = row.decisionStage || before.decisionStage || "";
  row.loadNumber = row.loadNumber || before.loadNumber || "";
  row.invoiceId = invoiceId;
  if (!isMissingPodDashboardItem(row)) {
    return {
      ok: false,
      removed: false,
      error: "This is not an open missing POD item.",
    };
  }
  const gate = daily.classifyMissingPodHold(before);
  if (gate.reason === "already_processing") {
    return {
      ok: false,
      removed: false,
      error: "This load is already being processed. " +
        "It stays on the dashboard until that finishes.",
    };
  }
  if (gate.action !== "check") {
    if (!workflowLeftMissingPod(before)) {
      return {
        ok: false,
        removed: false,
        error: "This load is not waiting on a POD.",
      };
    }
    await closeMissingPodTasks({
      tenantId: request.tenantId,
      invoiceId,
      loadNumber: row.loadNumber,
      closedBy: "pod_done",
    });
    return {ok: true, removed: true, reason: gate.reason};
  }
  if (typeof deps.resumeWorkflow !== "function") {
    return {
      ok: false,
      removed: false,
      error: "POD workflow finish is not available.",
    };
  }
  let resumed;
  try {
    resumed = await deps.resumeWorkflow(
        request.tenant,
        invoiceId,
        daily.resumeStepFor(before),
    );
  } catch (err) {
    return {
      ok: false,
      removed: false,
      error: (err && err.message) ||
        "The POD workflow did not finish.",
    };
  }
  const after = await deps.loadInvoice(request.tenant, invoiceId);
  if (!workflowLeftMissingPod(after)) {
    return {
      ok: false,
      removed: false,
      error: resumeFailureMessage(resumed) ||
        "POD is still missing on this load. It stays on the dashboard.",
    };
  }
  await closeMissingPodTasks({
    tenantId: request.tenantId,
    invoiceId,
    loadNumber: row.loadNumber || (after && after.loadNumber),
    closedBy: "pod_done",
  });
  return {ok: true, removed: true, reason: "workflow_finished"};
}

/**
 * @param {object} item Dashboard row.
 * @param {string} reason Skip or fail reason.
 * @param {string} bucket completed, skipped, or failed.
 * @return {Promise<void>}
 */
async function logCheck(item, reason, bucket) {
  const failed = bucket === "failed";
  const title = bucket === "completed" ?
    "Missing POD dashboard check finished workflow" :
    (failed ?
      "Missing POD dashboard check could not finish" :
      "Missing POD dashboard check skipped");
  await logRow(failed ? "error" : "info", title, {
    invoiceId: invoiceIdOf(item, item),
    loadNumber: item && item.loadNumber || null,
    taskId: item && item.id || null,
    result: bucket,
    reason: reason || null,
  });
}

/**
 * Twice a week: open missing-POD dashboard rows only.
 * Completes a row only when Primus documents already include a POD.
 * @param {object} [options] timeBudgetMs.
 * @return {Promise<object>}
 */
async function runTwiceWeeklyCheck(options) {
  const opts = options || {};
  const budgetMs = Number(opts.timeBudgetMs) > 0 ?
    Number(opts.timeBudgetMs) : DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const tenant = opts.tenant || deps.tenant || null;
  const tenantId = (tenant && tenant.tenantId) ||
    opts.tenantId || "default";
  if (typeof deps.listOpenMissingPodItems !== "function") {
    throw new Error("missing-pod dashboard: list is not configured");
  }
  const items = await deps.listOpenMissingPodItems() || [];
  const summary = {
    ok: true,
    checked: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
    completedInvoiceIds: [],
    notificationsDismissed: 0,
  };
  for (const item of items) {
    if (!isMissingPodDashboardItem(item)) {
      summary.skipped += 1;
      // eslint-disable-next-line no-await-in-loop
      await logCheck(item, "not_missing_pod", "skipped");
      continue;
    }
    if (Date.now() >= deadline) {
      summary.skipped += 1;
      // eslint-disable-next-line no-await-in-loop
      await logCheck(item, "time_budget", "skipped");
      continue;
    }
    summary.checked += 1;
    const invoiceId = invoiceIdOf(item, item);
    const invoice = invoiceId && typeof deps.loadInvoice === "function" ?
      // eslint-disable-next-line no-await-in-loop
      await deps.loadInvoice(tenant, invoiceId) : null;
    const gate = daily.classifyMissingPodHold(invoice);
    if (gate.action !== "check") {
      if (gate.reason === "already_completed") {
        // eslint-disable-next-line no-await-in-loop
        const finished = await finishFromDashboard({
          tenant,
          tenantId,
          taskId: item.id,
          source: item.source,
          invoiceId,
          loadNumber: item.loadNumber,
          type: item.type,
          issueType: item.issueType,
          decisionStage: item.decisionStage,
        });
        if (finished.ok) {
          summary.completed += 1;
          summary.completedInvoiceIds.push(invoiceId);
          // eslint-disable-next-line no-await-in-loop
          summary.notificationsDismissed +=
            await clearPodNotices(item, invoice, tenantId);
          // eslint-disable-next-line no-await-in-loop
          await logCheck(item, gate.reason, "completed");
        } else {
          summary.failed += 1;
          // eslint-disable-next-line no-await-in-loop
          await logCheck(item, finished.error, "failed");
        }
      } else {
        summary.skipped += 1;
        // eslint-disable-next-line no-await-in-loop
        await logCheck(item, gate.reason, "skipped");
      }
      continue;
    }
    let pod = null;
    try {
      if (typeof deps.lookupPrimusPod !== "function") {
        pod = {found: false, reason: "pod_check_unavailable"};
      } else {
        // eslint-disable-next-line no-await-in-loop
        pod = await deps.lookupPrimusPod(invoice.loadNumber);
      }
    } catch (err) {
      summary.skipped += 1;
      // eslint-disable-next-line no-await-in-loop
      await logCheck(
          item,
          (err && err.message) || "primus_check_failed",
          "skipped",
      );
      continue;
    }
    if (!pod || !pod.found) {
      summary.skipped += 1;
      // eslint-disable-next-line no-await-in-loop
      await logCheck(item, (pod && pod.reason) || "no_pod", "skipped");
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const finished = await finishFromDashboard({
      tenant,
      tenantId,
      taskId: item.id,
      source: item.source,
      invoiceId,
      loadNumber: item.loadNumber || invoice.loadNumber,
      type: item.type,
      issueType: item.issueType,
      decisionStage: item.decisionStage || invoice.decisionStage,
    });
    if (finished.ok) {
      summary.completed += 1;
      summary.completedInvoiceIds.push(invoiceId);
      // eslint-disable-next-line no-await-in-loop
      summary.notificationsDismissed +=
        await clearPodNotices(item, invoice, tenantId);
      // eslint-disable-next-line no-await-in-loop
      await logCheck(item, finished.reason || "pod_on_primus", "completed");
    } else {
      summary.failed += 1;
      // eslint-disable-next-line no-await-in-loop
      await logCheck(
          item,
          finished.error || "workflow_failed",
          "failed",
      );
    }
  }
  await logRow("info", "Missing POD dashboard check finished", {
    checked: summary.checked,
    completed: summary.completed,
    skipped: summary.skipped,
    failed: summary.failed,
    notificationsDismissed: summary.notificationsDismissed,
    completedInvoiceIds: summary.completedInvoiceIds,
  });
  return summary;
}

exports.init = init;
exports.isMissingPodDashboardItem = isMissingPodDashboardItem;
exports.workflowLeftMissingPod = workflowLeftMissingPod;
exports.finishFromDashboard = finishFromDashboard;
exports.runTwiceWeeklyCheck = runTwiceWeeklyCheck;
