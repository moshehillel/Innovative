/* eslint-disable no-console */
"use strict";

/**
 * Resume Workflow (MISSING_POD) — billing pipeline must run after pod_extraction
 * resume, and continueWorkflow must surface POD-still-missing clearly.
 */

const workflowErrors = require("../workflow-error-messages");

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}` +
    (ok ? "" : ` (got ${JSON.stringify(actual)}, ` +
      `expected ${JSON.stringify(expected)})`));
};

const {shouldRunBillingPipelineOnResume, interpretWorkflowResumeResult,
  buildWorkflowAlertEmail, ACTION} = workflowErrors;

check("fresh start runs billing pipeline",
    shouldRunBillingPipelineOnResume(null), true);
check("pod_extraction resume runs billing pipeline",
    shouldRunBillingPipelineOnResume("pod_extraction"), true);
check("customer_invoice resume runs billing pipeline",
    shouldRunBillingPipelineOnResume("customer_invoice"), true);
check("mark_delivered resume runs billing pipeline",
    shouldRunBillingPipelineOnResume("mark_delivered"), true);
check("send_customer_email resume does not run billing alone",
    shouldRunBillingPipelineOnResume("send_customer_email"), false);

const missingPodAlert = buildWorkflowAlertEmail({
  code: "MISSING_POD",
  invoiceId: "inv-266605",
  baseUrl: "https://example.com",
  context: {
    loadNumber: "266605",
    carrierName: "2 DAY TRANSPORTATION INC",
    proNumber: "2090647",
  },
});
check("MISSING_POD alert uses RESUME action",
    missingPodAlert.action, ACTION.RESUME);
check("MISSING_POD alert includes Resume Workflow button",
    missingPodAlert.html.includes("Resume Workflow"), true);
check("MISSING_POD alert links continueWorkflow",
    missingPodAlert.html.includes("/continueWorkflow?invoiceId=inv-266605"),
    true);

const podStillMissing = interpretWorkflowResumeResult(true, {
  ok: false,
  error: "MISSING_POD",
  workflowStatus: "missing_pod",
});
check("interpret MISSING_POD is failure", podStillMissing.ok, false);
check("interpret MISSING_POD code", podStillMissing.code, "MISSING_POD");
check("interpret MISSING_POD mentions ShipPrimus",
    podStillMissing.userMessage.includes("ShipPrimus"), true);

const podFound = interpretWorkflowResumeResult(true, {
  ok: true,
  workflowStatus: "completed",
  customerInvoiceId: "12345",
});
check("interpret completed resume is success", podFound.ok, true);
check("interpret completed resume code", podFound.code, "ALREADY_COMPLETED");

const resumed = interpretWorkflowResumeResult(true, {
  ok: true,
  workflowStatus: "running",
});
check("interpret generic success", resumed.ok, true);
check("interpret generic success mentions resumed",
    resumed.userMessage.toLowerCase().includes("resumed"), true);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll resume-workflow POD checks passed.");
