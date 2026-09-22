/* eslint-disable no-console */
"use strict";

const queue = require("../mail-intake-queue");
const workflowErrors = require("../workflow-error-messages");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const summary = queue.buildIntakeSummary({
  outcome: queue.OUTCOME.FAILED,
  outcomeReason: queue.OUTCOME_REASON.WORKFLOW_FAILED,
  error: "fetch failed",
  _rebuildSummary: true,
});
check("summary uses workflow_failed digest text",
    summary === "Failed — invoice workflow system error");
check("outcomeReason constant is workflow_failed",
    queue.OUTCOME_REASON.WORKFLOW_FAILED === "workflow_failed");

const parentIds = queue.resolveIntakeIdsFromInvoice({
  gmailMessageId: "msg-parent",
  loadNumber: "266499",
});
check("parent invoice maps to emailIntake messageId",
    parentIds.parentMessageId === "msg-parent" &&
    parentIds.queueDocId === "msg-parent");

const childIds = queue.resolveIntakeIdsFromInvoice({
  gmailMessageId: "msg-parent",
  itemIndex: 1,
});
check("split child maps to gmailQueue item id",
    childIds.parentMessageId === "msg-parent" &&
    childIds.queueDocId === "msg-parent__item_1");

check("fetch failed is a system / transient crash",
    workflowErrors.isTransientNetworkError("fetch failed") === true &&
    workflowErrors.looksLikeSystemError("fetch failed") === true);
check("expired Firestore lock is transient",
    workflowErrors.isTransientNetworkError(
        "3 INVALID_ARGUMENT: The referenced transaction has expired " +
        "or is no longer valid.") === true);
check("expired Firestore lock schedules a delayed retry",
    workflowErrors.shouldDelayWorkflowRetry({
      errorMessage:
        "3 INVALID_ARGUMENT: The referenced transaction has expired " +
        "or is no longer valid.",
      delayedRetryCount: 0,
    }) === true);
check("missing POD is not a system crash",
    workflowErrors.isTransientNetworkError("MISSING_POD") === false &&
    workflowErrors.looksLikeSystemError("No POD document") === false);
check("unmatched amount is not a system crash",
    workflowErrors.looksLikeSystemError(
        "Submitted $100 vs Primus $90 (diff $10.00)") === false);
check("billtoId missing is ops Bill-To (not system)",
    workflowErrors.isBilltoResolutionError(
        "Could not resolve billtoId from booking") === true &&
    workflowErrors.looksLikeSystemError(
        "Could not resolve billtoId from booking") === false &&
    workflowErrors.isSystemAlertCode("UI_BILLING_FAILED", {
      errorMessage: "Could not resolve billtoId from booking",
    }) === false);
check("Bill-To shipping location missing is ops (not manage.php system)",
    workflowErrors.isBilltoResolutionError(
        "Could not find Bill-To shipping location \"B & C\" in ShipPrimus") ===
      true &&
    workflowErrors.looksLikeSystemError(
        "Could not map bill-to party \"B & C\" to manage.php " +
        "shipping location") === false &&
    workflowErrors.isSystemAlertCode("UI_BILLING_FAILED", {
      errorMessage:
        "Could not map bill-to party \"B & C\" to manage.php " +
        "shipping location",
    }) === false);
const billtoAlert = workflowErrors.buildWorkflowAlertEmail({
  code: "UI_BILLING_FAILED",
  context: {
    loadNumber: "267852",
    carrierName: "Central Transport",
    customerName: "B & C Industries",
    errorMessage: "Could not resolve billtoId from booking",
    billtoPartyName: "B & C Industries",
  },
  baseUrl: "https://example.test",
  invoiceId: "inv-267852",
});
check("billto alert subject is Bill-To missing",
    /Bill-To missing on Load 267852/.test(billtoAlert.subject));
check("billto alert tells Lisa how to fix in ShipPrimus",
    /set Bill To/i.test(billtoAlert.html) &&
    /Resume Workflow/i.test(billtoAlert.html) &&
    billtoAlert.action === workflowErrors.ACTION.RESUME);
check("ops holds skip delayed retry",
    workflowErrors.shouldDelayWorkflowRetry({
      errorMessage: "fetch failed",
      extraChargePending: true,
    }) === false &&
    workflowErrors.shouldDelayWorkflowRetry({
      errorMessage: "fetch failed",
      podHold: true,
    }) === false &&
    workflowErrors.shouldDelayWorkflowRetry({
      errorMessage: "fetch failed",
      missingAccountingEmail: true,
    }) === false);

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("All intake workflow-failed checks passed.");
