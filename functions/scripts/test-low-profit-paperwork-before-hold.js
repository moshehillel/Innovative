/* eslint-disable no-console */
"use strict";

/**
 * Low profit must not skip Primus paperwork upload.
 * Intake used to set finalStatus = "no_rate" and email the dispatcher
 * before an invoice existed, so uploadPaperworkEarly never ran (load 267127).
 */

const fs = require("fs");
const path = require("path");
const gate = require("../intake-profit-gate");

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}` +
    (ok ? "" : ` (got ${JSON.stringify(actual)}, ` +
      `expected ${JSON.stringify(expected)})`));
};

const low = gate.planLowProfitIntake({
  noRate: false,
  lowProfit: true,
  profit: 0,
});
check("low profit is detected", low.isLowProfit, true);
check("low profit does not block workflow", low.blockWorkflow, false);
check("low profit does not email before upload",
    low.notifyBeforeWorkflow, false);

const missing = gate.planLowProfitIntake({
  noRate: true,
  lowProfit: true,
  profit: 0,
});
check("missing rate does not block workflow", missing.blockWorkflow, false);

const healthy = gate.planLowProfitIntake({
  noRate: false,
  lowProfit: false,
  profit: 40,
});
check("healthy margin is not a hold", healthy.isLowProfit, false);

check("no second email after workflow rate pause",
    gate.shouldSendDeferredLowProfitEmail({
      isLowProfit: true,
      workflowStatus: "needs_customer_rate_review",
    }),
    false);
check("no email when workflow already billed",
    gate.shouldSendDeferredLowProfitEmail({
      isLowProfit: true,
      workflowStatus: "completed",
    }),
    false);
check("email still sends when workflow never ran",
    gate.shouldSendDeferredLowProfitEmail({
      isLowProfit: true,
      workflowStatus: null,
    }),
    true);
check("no email when profit is fine",
    gate.shouldSendDeferredLowProfitEmail({
      isLowProfit: false,
      workflowStatus: null,
    }),
    false);

const indexSrc = fs.readFileSync(
    path.join(__dirname, "..", "index.js"), "utf8");
const profitIdx = indexSrc.indexOf("Profit / margin check");
const validationIdx = indexSrc.indexOf(
    "Only run Primus validation if earlier checks");
const slice = profitIdx >= 0 && validationIdx > profitIdx ?
  indexSrc.slice(profitIdx, validationIdx) : "";
check("profit check is wired to the gate",
    slice.includes("planLowProfitIntake"), true);
check("profit check does not set no_rate",
    slice.includes("no_rate"), false);
check("validation still runs after a low-profit hold",
    validationIdx > profitIdx, true);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll low-profit paperwork-before-hold checks passed.");
