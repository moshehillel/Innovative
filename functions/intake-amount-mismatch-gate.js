"use strict";

/**
 * Amount-mismatch intake must not skip the Primus paperwork upload.
 * processPrimusWorkflow uploads the carrier bill and POD first, then pauses
 * without creating a customer invoice. Intake sends the billing email after
 * that upload (the alert still goes out if the workflow never starts).
 */

/** Workflow invoiced. The mismatch hold was cleared and billing finished. */
const WORKFLOW_FINISHED_BILLING = new Set([
  "completed",
]);

/**
 * @param {object|null} mismatch Intake mismatch signal.
 * @return {{isMismatch: boolean, createInvoiceForPaperwork: boolean,
 *   notifyBeforeWorkflow: boolean, autoInvoice: boolean}}
 */
function planAmountMismatchIntake(mismatch) {
  const isMismatch = !!(mismatch && mismatch.unmatched);
  return {
    isMismatch,
    createInvoiceForPaperwork: isMismatch,
    notifyBeforeWorkflow: false,
    autoInvoice: false,
  };
}

/**
 * Whether this workflow pass must stay paused for an amount mismatch.
 * The first pass always pauses after paperwork upload. A later resume
 * continues only when Primus now matches the amount intake compared.
 * @param {object|null} hold Invoice amountMismatchHold.
 * @param {object|null} recheck validateAmountWithPrimus result on resume.
 * @return {boolean}
 */
function amountMismatchStillBlocks(hold, recheck) {
  if (!hold || hold.released) return false;
  if (!hold.paperworkPaused) return true;
  return !(recheck && recheck.ok === true && recheck.validAmount === true);
}

/**
 * Whether intake should send the amount-mismatch billing email.
 * False only when the workflow already finished billing (the hold cleared).
 * @param {object} opts
 * @param {boolean} opts.isMismatch
 * @param {string|null} opts.workflowStatus
 * @return {boolean}
 */
function shouldSendDeferredAmountMismatchEmail(opts) {
  if (!opts || !opts.isMismatch) return false;
  const status = String(opts.workflowStatus || "");
  if (WORKFLOW_FINISHED_BILLING.has(status)) return false;
  return true;
}

module.exports = {
  planAmountMismatchIntake,
  amountMismatchStillBlocks,
  shouldSendDeferredAmountMismatchEmail,
};
