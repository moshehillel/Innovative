"use strict";
/**
 * Unit checks: Redkik insurance saveInvoice must close actual/vendor cost
 * only — never the customer cost section (costClosed).
 */
const bridge = require("../primus-ui-bridge");
const {insuranceSaveInvoiceCloseFlags} = bridge;

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(ok ? "PASS" : "FAIL", name, "=>", actual);
  if (!ok) failed++;
}

const flags = insuranceSaveInvoiceCloseFlags();
check("does not close customer cost section", flags.costClosed, "0");
check("closes actual/vendor cost", flags.costActualClosed, "1");
check("marks readyToInvoice", flags.readyToInvoice, "1");

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll passed");
