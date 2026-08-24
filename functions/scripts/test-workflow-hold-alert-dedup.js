/* eslint-disable no-console */
"use strict";

const workflowErrors = require("../workflow-error-messages");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

check("cannot-email codes are hold alerts",
    workflowErrors.isCannotEmailHoldAlert("CUSTOMER_EMAIL_FAILED") &&
    workflowErrors.isCannotEmailHoldAlert("MISSING_POD"));
check("workflow crash is not a cannot-email hold",
    !workflowErrors.isCannotEmailHoldAlert("WORKFLOW_FAILED"));
check("extra-charge codes are not cannot-email holds",
    !workflowErrors.isCannotEmailHoldAlert("ADDITIONAL_CHARGE_A"));

check("maps no-POD emailBOLDocs error",
    workflowErrors.holdReasonKey(
        "No POD document on Primus — customer email blocked") === "no_pod");
check("maps missing accounting email",
    workflowErrors.holdReasonKey("No customer accounting email found") ===
    "missing_accounting_email");
check("maps invalid recipient",
    workflowErrors.holdReasonKey("Invalid recipient email") ===
    "invalid_recipient");
check("maps not issued via UI",
    workflowErrors.holdReasonKey(
        "Customer invoice was not issued via UI; " +
        "Missing Primus customer invoice ID") === "not_issued");

check("first cannot-email on a fresh invoice is sent",
    !workflowErrors.shouldSuppressRepeatHoldAlert({
      code: "CUSTOMER_EMAIL_FAILED",
      errorMessage: "Customer invoice was not issued via UI",
      priorInvoice: {
        decisionStage: "ready_to_approve",
        finalWorkflowStatus: "created",
      },
    }));

check("already paused on same not-issued reason is skipped",
    workflowErrors.shouldSuppressRepeatHoldAlert({
      code: "CUSTOMER_EMAIL_FAILED",
      errorMessage: "Customer invoice was not issued via UI; " +
        "Missing Primus customer invoice ID",
      priorInvoice: {
        decisionStage: "customer_email_failed",
        decisionReason: "Customer invoice was not issued via UI; " +
          "Missing Primus customer invoice ID",
        finalWorkflowStatus: "customer_email_failed",
      },
    }));

check("bulk resume re-hitting no-POD after a prior cannot-email is skipped",
    workflowErrors.shouldSuppressRepeatHoldAlert({
      code: "CUSTOMER_EMAIL_FAILED",
      errorMessage: "No POD document on Primus — customer email blocked",
      priorInvoice: {
        decisionStage: "customer_email_failed",
        decisionReason: "Customer invoice was not issued via UI",
        finalWorkflowStatus: "customer_email_failed",
      },
    }));

check("existing outbound of same code+reason is skipped",
    workflowErrors.shouldSuppressRepeatHoldAlert({
      code: "CUSTOMER_EMAIL_FAILED",
      errorMessage: "Customer invoice was not issued via UI",
      priorInvoice: {decisionStage: "ready_to_approve"},
      existingAlerts: [{
        alertCode: "CUSTOMER_EMAIL_FAILED",
        type: "customer_email_failed",
        alertContext: {
          errorMessage: "Customer invoice was not issued via UI; " +
            "Missing Primus customer invoice ID",
        },
      }],
    }));

check("first missing-POD alert is sent",
    !workflowErrors.shouldSuppressRepeatHoldAlert({
      code: "MISSING_POD",
      errorMessage: "Carrier invoice has no POD — cannot continue without one",
      priorInvoice: {decisionStage: "ready_to_approve"},
    }));

check("repeat missing-POD on the same hold is skipped",
    workflowErrors.shouldSuppressRepeatHoldAlert({
      code: "MISSING_POD",
      errorMessage: "Carrier invoice has no POD — cannot continue without one",
      priorInvoice: {
        decisionStage: "missing_pod",
        decisionReason: "Carrier invoice has no POD — cannot continue without one",
        finalWorkflowStatus: "waiting_manual",
      },
    }));

check("stamped lastHoldAlert with same reason is skipped",
    workflowErrors.shouldSuppressRepeatHoldAlert({
      code: "CUSTOMER_EMAIL_FAILED",
      errorMessage: "No customer accounting email found",
      priorInvoice: {
        decisionStage: "ready_to_approve",
        lastHoldAlertCode: "CUSTOMER_EMAIL_FAILED",
        lastHoldAlertReason: "No customer accounting email found",
      },
    }));

check("workflow-failed is never suppressed by hold dedup",
    !workflowErrors.shouldSuppressRepeatHoldAlert({
      code: "WORKFLOW_FAILED",
      errorMessage: "fetch failed",
      priorInvoice: {
        decisionStage: "customer_email_failed",
        decisionReason: "fetch failed",
      },
    }));

if (failures) {
  process.exit(1);
}
console.log("OK");
