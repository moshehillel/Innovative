"use strict";

/**
 * Low-profit intake must not stop the Primus workflow.
 * processPrimusWorkflow uploads the carrier bill and POD first, then pauses
 * and emails the dispatcher. Intake sends that email only when the workflow
 * did not already send it (so a $0-profit hold still reaches Karen).
 */

/** Workflow already emailed the dispatcher after paperwork upload. */
const WORKFLOW_ALREADY_NOTIFIED = new Set([
  "needs_customer_rate_review",
]);

/** Workflow invoiced. The early profit figure was not the final hold. */
const WORKFLOW_FINISHED_BILLING = new Set([
  "completed",
]);

/**
 * @param {object|null} profitCheck Result of checkProfitMargin.
 * @return {{isLowProfit: boolean, blockWorkflow: boolean,
 *   notifyBeforeWorkflow: boolean}}
 */
function planLowProfitIntake(profitCheck) {
  const isLowProfit = !!(profitCheck &&
    (profitCheck.lowProfit || profitCheck.noRate));
  return {
    isLowProfit,
    blockWorkflow: false,
    notifyBeforeWorkflow: false,
  };
}

/**
 * Whether intake should still send the low-profit dispatcher email.
 * False when the workflow already paused for low margin / missing rate
 * (that email is sent after paperwork upload) or when billing completed.
 * @param {object} opts
 * @param {boolean} opts.isLowProfit
 * @param {string|null} opts.workflowStatus
 * @return {boolean}
 */
function shouldSendDeferredLowProfitEmail(opts) {
  if (!opts || !opts.isLowProfit) return false;
  const status = String(opts.workflowStatus || "");
  if (WORKFLOW_ALREADY_NOTIFIED.has(status)) return false;
  if (WORKFLOW_FINISHED_BILLING.has(status)) return false;
  return true;
}

module.exports = {
  planLowProfitIntake,
  shouldSendDeferredLowProfitEmail,
};
