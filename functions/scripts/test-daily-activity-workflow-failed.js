/* eslint-disable no-console */
"use strict";

const report = require("../daily-activity-report");
const workflowErrors = require("../workflow-error-messages");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const logs = [
  {
    message: "Primus workflow failed after retries",
    details: {
      loadNumber: "266499",
      carrierName: "Alrossa",
      error: "fetch failed",
      invoiceId: "IytvSeAdHW2p9A0fWR6N",
    },
  },
  {
    message: "Primus workflow failed — scheduling retry",
    details: {loadNumber: "266500", error: "fetch failed"},
  },
  {
    message: "UI billing flow failed",
    details: {loadNumber: "111", error: "missing reference"},
  },
  {
    message: "Primus workflow failed",
    details: {loadNumber: "222", error: "fetch failed"},
  },
  {
    message: "Carrier bill entered and invoice issued via manage.php",
    details: {loadNumber: "222", invoiceNumber: "99", invoiceAmount: 100},
  },
];

const agg = report.aggregateDailyActivity(logs);
const lines = report.buildDeterministicBullets(agg);

check("workflowFailures includes exhausted crash",
    agg.workflowFailures.some((f) => f.load === "266499"));
check("scheduling retry is not a digest item",
    !agg.workflowFailures.some((f) => f.load === "266500"));
check("recovered same-day fail is omitted",
    !agg.workflowFailures.some((f) => f.load === "222"));
check("digest bullet uses Workflow failed wording",
    lines.some((l) => l.startsWith("Workflow failed — load 266499") &&
      l.includes("fetch failed")));
check("UI billing still uses Billing failed",
    lines.some((l) => l.startsWith("Billing failed — load 111")));
check("fetch failed is treated as transient",
    workflowErrors.isTransientNetworkError("TypeError: fetch failed"));
check("delayed retry is offered on first transient fail",
    workflowErrors.shouldDelayWorkflowRetry({
      errorMessage: "fetch failed",
      delayedRetryCount: 0,
    }));
check("no second delayed retry",
    !workflowErrors.shouldDelayWorkflowRetry({
      errorMessage: "fetch failed",
      delayedRetryCount: 1,
    }));

if (failures) {
  process.exit(1);
}
console.log("OK");
