#!/usr/bin/env node
"use strict";

const {
  invoiceChargesIncludeReference,
  sanitizeBillToReferenceText,
} = require("../primus-ui-bridge")._internal;

function check(label, cond) {
  if (!cond) {
    console.error("FAIL:", label);
    process.exit(1);
  }
  console.log("ok:", label);
}

const ref = "UNIT \u00a0HV86\u00a0 S/N\u00a03H3V532C1ET368023";
const mojibakeDesc =
  "FREIGHT CHARGE - UNIT \u00c5 HV86\u00c2 S/N\u00c2 3H3V532C1ET368023";

check("sanitize nbsp reference",
    sanitizeBillToReferenceText(ref) ===
    "UNIT HV86 S/N 3H3V532C1ET368023");
check("sanitize mojibake read-back",
    sanitizeBillToReferenceText(
        "UNIT \u00c5 HV86\u00c2 S/N\u00c2 3H3V532C1ET368023") ===
    "UNIT HV86 S/N 3H3V532C1ET368023");

check("exact normalized match",
    invoiceChargesIncludeReference(
        [{description: `FREIGHT CHARGE - ${ref}`}], ref));
check("mojibake Primus read-back",
    invoiceChargesIncludeReference([{description: mojibakeDesc}], ref));
check("serial-only on charge line",
    invoiceChargesIncludeReference(
        [{description: "FREIGHT CHARGE - trailer 3H3V532C1ET368023"}], ref));
check("missing unit fails",
    !invoiceChargesIncludeReference(
        [{description: "FREIGHT CHARGE"}], ref));

console.log("\nAll unit reference match tests passed");
