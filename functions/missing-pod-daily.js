"use strict";

/**
 * Daily check for Innovative invoices paused on missing POD.
 *
 * LTL (and Power Only) loads are held at decisionStage "missing_pod" until a
 * POD exists. Truckload missing-POD is a separate carrier chase and is not
 * queried here. When Primus now has a usable POD, this hands the invoice back
 * to processPrimusWorkflow the same way Resume Workflow does.
 */

const CHECK_CONCURRENCY = 4;
const PAGE_SIZE = 40;
const MAX_INVOICES = 200;
const DEFAULT_BUDGET_MS = 8 * 60 * 1000;

const CHECK_FAILURE_REASONS = new Set([
  "booking_not_found",
  "pod_check_failed",
  "pod_check_unavailable",
  "manage.php off",
  "missing booking or load",
  "Could not resolve manage.php bookingId",
]);

let deps = {};

/**
 * @param {object} bundle Runtime dependencies.
 */
function init(bundle) {
  deps = bundle || {};
}

/**
 * @param {object|null|undefined} invoice Invoice document data.
 * @return {{action: string, reason: string}} check or skip.
 */
function classifyMissingPodHold(invoice) {
  if (!invoice) {
    return {action: "skip", reason: "missing_invoice"};
  }
  const stage = String(invoice.decisionStage || "");
  const status = String(invoice.finalWorkflowStatus || "");
  if (status === "completed" ||
      status === "completed_no_customer_email" ||
      stage === "completed") {
    return {action: "skip", reason: "already_completed"};
  }
  if (stage !== "missing_pod") {
    return {action: "skip", reason: "not_missing_pod_hold"};
  }
  if (invoice.processingLock === true || status === "running") {
    return {action: "skip", reason: "already_processing"};
  }
  if (!invoice.loadNumber) {
    return {action: "skip", reason: "no_load_number"};
  }
  return {action: "check", reason: "missing_pod"};
}

/**
 * POD already stored on the invoice (local extract or a prior Primus mark).
 * @param {object} invoice Invoice document data.
 * @return {boolean}
 */
function invoiceHasUsablePod(invoice) {
  if (!invoice) return false;
  if (invoice.podOnlyFile && invoice.podOnlyFile.storagePath) return true;
  if (invoice.podOnPrimusAlready) return true;
  return Boolean(invoice.primusSteps && invoice.primusSteps.podUploaded);
}

/**
 * @param {object} invoice Invoice document data.
 * @return {string} Resume step for processPrimusWorkflow.
 */
function resumeStepFor(invoice) {
  const step = invoice && invoice.workflowPausedAtStep;
  return step ? String(step) : "pod_extraction";
}

/**
 * @param {string} reason Primus check reason.
 * @return {boolean} True when the lookup failed rather than confirmed no POD.
 */
function isCheckFailure(reason) {
  const text = String(reason || "");
  if (!text || text === "no_pod" || text === "no POD on booking") {
    return false;
  }
  if (CHECK_FAILURE_REASONS.has(text)) return true;
  return /fail|error|timed out|timeout|econn|socket/i.test(text);
}

/**
 * @param {object|null|undefined} result kickPrimusWorkflow result.
 * @return {{bucket: string, reason: string}}
 */
function classifyResumeResult(result) {
  if (!result) {
    return {bucket: "failed", reason: "no_result"};
  }
  const status = Number(result.status || 0);
  const code = (result.payload && result.payload.error) || "";
  if (status === 409 && code === "ALREADY_COMPLETED") {
    return {bucket: "skipped", reason: "already_completed"};
  }
  if (status === 409 && code === "ALREADY_PROCESSING") {
    return {bucket: "skipped", reason: "already_processing"};
  }
  if (status >= 500 || status === 0) {
    return {bucket: "failed", reason: code || "workflow_http_error"};
  }
  return {bucket: "resumed", reason: code || "resumed"};
}

/**
 * @param {string} loadNumber Primus load / BOL number.
 * @return {Promise<object>} {found, reason, driveIds}.
 */
async function lookupPrimusPod(loadNumber) {
  if (typeof deps.fetchPrimusBooking !== "function" ||
      typeof deps.checkBookingHasPod !== "function") {
    return {
      found: false,
      reason: "pod_check_unavailable",
      driveIds: [],
    };
  }
  const booking = await deps.fetchPrimusBooking(loadNumber);
  if (!booking) {
    return {found: false, reason: "booking_not_found", driveIds: []};
  }
  const podCheck = await deps.checkBookingHasPod({
    booking,
    loadNumber,
  });
  if (!podCheck) {
    return {found: false, reason: "pod_check_failed", driveIds: []};
  }
  return {
    found: Boolean(podCheck.found),
    reason: podCheck.reason ||
      (podCheck.found ? "pod_on_booking" : "no_pod"),
    driveIds: podCheck.driveIds || [],
  };
}

/**
 * @param {object} invoice Invoice document data.
 * @return {Promise<object>} Decision. resume true only when a POD is usable.
 */
async function evaluateHold(invoice) {
  const gate = classifyMissingPodHold(invoice);
  if (gate.action !== "check") {
    return {bucket: "skipped", reason: gate.reason, resume: false};
  }
  if (invoiceHasUsablePod(invoice)) {
    return {
      bucket: "resumed",
      reason: "pod_already_on_invoice",
      resume: true,
      driveIds: [],
    };
  }
  try {
    const pod = await lookupPrimusPod(invoice.loadNumber);
    if (pod.found) {
      return {
        bucket: "resumed",
        reason: "pod_on_primus",
        resume: true,
        driveIds: pod.driveIds || [],
      };
    }
    if (isCheckFailure(pod.reason)) {
      return {bucket: "failed", reason: pod.reason, resume: false};
    }
    return {
      bucket: "stillMissing",
      reason: pod.reason || "no_pod",
      resume: false,
    };
  } catch (err) {
    return {
      bucket: "failed",
      reason: (err && err.message) || "primus_check_failed",
      resume: false,
    };
  }
}

/**
 * @param {Array<object>} items Items.
 * @param {number} limit Max in flight.
 * @param {function(object, number): Promise<*>} fn Worker.
 * @return {Promise<Array<*>>}
 */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = [];
  const count = Math.min(limit, items.length);
  for (let i = 0; i < count; i++) {
    workers.push((async () => {
      while (next < items.length) {
        const idx = next++;
        results[idx] = await fn(items[idx], idx);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

/**
 * @return {object} Innovative invoices collection.
 */
function invoicesCollection() {
  if (typeof deps.invoicesCollection !== "function") {
    throw new Error("missing-pod daily: invoicesCollection is not configured");
  }
  return deps.invoicesCollection();
}

/**
 * @param {string|null} startAfterId Last document id, if paging.
 * @param {number} pageSize Page size.
 * @return {Promise<Array<object>>}
 */
async function fetchHoldPage(startAfterId, pageSize) {
  let query = invoicesCollection()
      .where("decisionStage", "==", "missing_pod")
      .orderBy(deps.FieldPath.documentId())
      .limit(pageSize);
  if (startAfterId) query = query.startAfter(startAfterId);
  const snap = await query.get();
  return snap.docs || [];
}

/**
 * @return {Promise<string|null>}
 */
async function readCursor() {
  if (typeof deps.settingsDoc !== "function") return null;
  const snap = await deps.settingsDoc().get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  return data.cursorId || null;
}

/**
 * @param {string|null} cursorId Next start-after id, or null to restart.
 * @return {Promise<void>}
 */
async function writeCursor(cursorId) {
  if (typeof deps.settingsDoc !== "function") return;
  if (!deps.FieldValue || !deps.FieldValue.serverTimestamp) return;
  await deps.settingsDoc().set({
    cursorId: cursorId || null,
    updatedAt: deps.FieldValue.serverTimestamp(),
  }, {merge: true});
}

/**
 * Pages missing_pod invoices, continuing from the saved cursor and wrapping
 * once so a long queue still gets a full pass across runs.
 * @param {number} deadlineMs Epoch ms budget.
 * @param {object} opts pageSize, maxInvoices.
 * @return {Promise<object>} {docs, nextCursor, truncated}.
 */
async function collectHolds(deadlineMs, opts) {
  const pageSize = opts.pageSize;
  const maxInvoices = opts.maxInvoices;
  const cursor = await readCursor();
  const docs = [];
  const seen = new Set();
  let start = cursor;
  let wrapped = false;
  let truncated = false;
  while (docs.length < maxInvoices) {
    if (Date.now() >= deadlineMs) {
      truncated = true;
      break;
    }
    const page = await fetchHoldPage(start, pageSize);
    if (!page.length) {
      if (start && !wrapped) {
        start = null;
        wrapped = true;
        continue;
      }
      break;
    }
    let looped = false;
    for (const doc of page) {
      if (seen.has(doc.id)) {
        looped = true;
        break;
      }
      seen.add(doc.id);
      docs.push(doc);
      start = doc.id;
      if (docs.length >= maxInvoices) break;
    }
    if (looped) break;
    if (page.length < pageSize) {
      if (cursor && !wrapped) {
        start = null;
        wrapped = true;
        continue;
      }
      break;
    }
  }
  const nextCursor = (truncated || docs.length >= maxInvoices) ? start : null;
  return {docs, nextCursor, truncated};
}

/**
 * @param {object} doc Invoice snapshot.
 * @param {string} result Stamp value.
 * @return {Promise<void>}
 */
async function stampCheck(doc, result) {
  if (!doc.ref || typeof doc.ref.update !== "function") return;
  if (!deps.FieldValue || !deps.FieldValue.serverTimestamp) return;
  await doc.ref.update({
    missingPodLastCheckedAt: deps.FieldValue.serverTimestamp(),
    missingPodLastCheckResult: result,
    updatedAt: deps.FieldValue.serverTimestamp(),
  });
}

/**
 * @param {object} row Per-invoice outcome.
 * @return {Promise<void>}
 */
async function logRow(row) {
  if (typeof deps.writeLog !== "function") return;
  const stillMissing = row.bucket === "stillMissing";
  await deps.writeLog(
      stillMissing ? "info" : (row.bucket === "failed" ? "error" : "info"),
      "workflow",
      "Daily missing-POD check",
      {
        invoiceId: row.invoiceId,
        loadNumber: row.loadNumber,
        result: row.stamp,
        reason: row.reason,
        driveIds: row.driveIds || [],
        resumeFrom: row.resumeFrom || null,
      },
  );
}

/**
 * Looks up POD only. Resume happens afterward, one invoice at a time.
 * @param {object} doc Invoice snapshot.
 * @return {Promise<object>}
 */
async function inspectHold(doc) {
  const invoice = doc.data() || {};
  const decision = await evaluateHold(invoice);
  const stamp = decision.bucket === "stillMissing" ?
    "still_missing" : decision.bucket;
  return {
    doc,
    invoiceId: doc.id,
    loadNumber: invoice.loadNumber || null,
    bucket: decision.bucket,
    reason: decision.reason,
    driveIds: decision.driveIds || [],
    resume: decision.resume === true,
    resumeFrom: decision.resume ? resumeStepFor(invoice) : null,
    stamp,
  };
}

/**
 * @param {object} row Per-invoice outcome. Mutated with the workflow result.
 * @return {Promise<void>}
 */
async function resumeHold(row) {
  try {
    const resumed = await deps.resumeWorkflow(row.invoiceId, row.resumeFrom);
    const classified = classifyResumeResult(resumed);
    row.bucket = classified.bucket === "skipped" ?
      "skipped" : classified.bucket;
    row.reason = classified.reason || row.reason;
    row.stamp = classified.bucket === "resumed" ?
      "resumed" : classified.bucket;
  } catch (err) {
    row.bucket = "failed";
    row.reason = (err && err.message) || "resume_failed";
    row.stamp = "failed";
  }
}

/**
 * @param {object} [options] dryRun, timeBudgetMs, pageSize, maxInvoices.
 * @return {Promise<object>} Counts for the run.
 */
async function runMissingPodDailyCheck(options) {
  const opts = options || {};
  const dryRun = opts.dryRun === true;
  const budgetMs = Number(opts.timeBudgetMs) > 0 ?
    Number(opts.timeBudgetMs) : DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const maxInvoices = opts.maxInvoices || MAX_INVOICES;
  const collected = await collectHolds(deadline, {
    pageSize: opts.pageSize || PAGE_SIZE,
    maxInvoices,
  });
  const rows = await mapPool(
      collected.docs,
      opts.concurrency || CHECK_CONCURRENCY,
      (doc) => inspectHold(doc),
  );
  for (const row of rows) {
    if (!row.resume) continue;
    if (dryRun) {
      row.bucket = "resumed";
      row.stamp = "pod_found";
      row.dryRun = true;
      continue;
    }
    if (Date.now() >= deadline) {
      row.bucket = "deferred";
      row.stamp = "pod_found";
      row.reason = "time_budget";
      continue;
    }
    await resumeHold(row);
  }
  for (const row of rows) {
    try {
      await stampCheck(row.doc, row.stamp);
    } catch (stampErr) {
      row.stampError = stampErr && stampErr.message;
    }
    try {
      await logRow(row);
    } catch (_) {
      // Logging must not block the rest of the holds.
    }
  }
  const summary = {
    ok: true,
    dryRun,
    checked: rows.length,
    stillMissing: 0,
    resumed: 0,
    skipped: 0,
    failed: 0,
    deferred: 0,
    truncated: collected.nextCursor != null,
    resumedInvoiceIds: [],
  };
  for (const row of rows) {
    if (row.bucket === "stillMissing") summary.stillMissing++;
    else if (row.bucket === "resumed") {
      summary.resumed++;
      summary.resumedInvoiceIds.push(row.invoiceId);
    } else if (row.bucket === "skipped") summary.skipped++;
    else if (row.bucket === "deferred") summary.deferred++;
    else summary.failed++;
  }
  try {
    await writeCursor(collected.nextCursor);
  } catch (cursorErr) {
    summary.cursorError = cursorErr && cursorErr.message;
  }
  if (typeof deps.writeLog === "function") {
    try {
      await deps.writeLog("info", "workflow",
          "Daily missing-POD check finished", {
            checked: summary.checked,
            stillMissing: summary.stillMissing,
            resumed: summary.resumed,
            skipped: summary.skipped,
            failed: summary.failed,
            deferred: summary.deferred,
            truncated: summary.truncated,
            dryRun,
            resumedInvoiceIds: summary.resumedInvoiceIds,
          });
    } catch (_) {
      // Summary log is best-effort.
    }
  }
  summary.rows = rows;
  return summary;
}

exports.init = init;
exports.classifyMissingPodHold = classifyMissingPodHold;
exports.invoiceHasUsablePod = invoiceHasUsablePod;
exports.resumeStepFor = resumeStepFor;
exports.classifyResumeResult = classifyResumeResult;
exports.isCheckFailure = isCheckFailure;
exports.evaluateHold = evaluateHold;
exports.runMissingPodDailyCheck = runMissingPodDailyCheck;
