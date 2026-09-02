"use strict";
/**
 * Unit checks for closed-prior insurance bill detection.
 */
const bridge = require("../primus-ui-bridge");
const {isClosedPriorInsuranceBill} = bridge;

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(ok ? "PASS" : "FAIL", name, "=>", actual);
  if (!ok) failed++;
}

check("empty not closed", isClosedPriorInsuranceBill("", "1414"), false);
check("null not closed", isClosedPriorInsuranceBill(null, "1414"), false);
check("same invoice not prior", isClosedPriorInsuranceBill("1414", "1414"),
    false);
check("prior short Redkik is closed", isClosedPriorInsuranceBill("1400", "1414"),
    true);
check("REDKIK fallback is closed",
    isClosedPriorInsuranceBill("REDKIK-123", "1414"), true);
check("carrier PRO not closed Redkik",
    isClosedPriorInsuranceBill("96915434", "1414"), false);
check("long PRO not closed",
    isClosedPriorInsuranceBill("812515631", "1414"), false);
check("6-digit prior still closed",
    isClosedPriorInsuranceBill("123456", "1414"), true);
check("7-digit not treated as Redkik bill",
    isClosedPriorInsuranceBill("1234567", "1414"), false);

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll passed");
