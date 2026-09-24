/* eslint-disable no-console */
"use strict";

/**
 * Amount mismatch must upload the carrier bill and POD before the billing
 * email, and must not auto-invoice the mismatched amount.
 * Intake used to set finalStatus = "unmatched_amount" and email immediately,
 * before an invoice existed, so uploadPaperworkEarly never ran.
 */

const fs = require("fs");
const path = require("path");
const gate = require("../intake-amount-mismatch-gate");

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}` +
    (ok ? "" : ` (got ${JSON.stringify(actual)}, ` +
      `expected ${JSON.stringify(expected)})`));
};

const mismatch = gate.planAmountMismatchIntake({unmatched: true});
check("mismatch is detected", mismatch.isMismatch, true);
check("mismatch creates an invoice for paperwork",
    mismatch.createInvoiceForPaperwork, true);
check("mismatch does not email before upload",
    mismatch.notifyBeforeWorkflow, false);
check("mismatch does not auto-invoice", mismatch.autoInvoice, false);

const clear = gate.planAmountMismatchIntake(null);
check("no mismatch does not create a paperwork invoice",
    clear.createInvoiceForPaperwork, false);

check("first pass stays paused after upload",
    gate.amountMismatchStillBlocks({paperworkPaused: false}, {
      ok: true,
      validAmount: true,
    }),
    true);
check("resume stays paused while Primus still mismatches",
    gate.amountMismatchStillBlocks({paperworkPaused: true}, {
      ok: true,
      validAmount: false,
    }),
    true);
check("resume continues only after the held amount matches",
    gate.amountMismatchStillBlocks({paperworkPaused: true}, {
      ok: true,
      validAmount: true,
    }),
    false);
check("released hold does not block",
    gate.amountMismatchStillBlocks({released: true, paperworkPaused: false},
        null),
    false);

check("email still sends when the workflow pauses",
    gate.shouldSendDeferredAmountMismatchEmail({
      isMismatch: true,
      workflowStatus: "unmatched_amount",
    }),
    true);
check("email still sends when the workflow never started",
    gate.shouldSendDeferredAmountMismatchEmail({
      isMismatch: true,
      workflowStatus: null,
    }),
    true);
check("no email after billing completed",
    gate.shouldSendDeferredAmountMismatchEmail({
      isMismatch: true,
      workflowStatus: "completed",
    }),
    false);
check("no email when the amount matched",
    gate.shouldSendDeferredAmountMismatchEmail({
      isMismatch: false,
      workflowStatus: null,
    }),
    false);

const indexSrc = fs.readFileSync(
    path.join(__dirname, "..", "index.js"), "utf8");
const lumperIdx = indexSrc.indexOf("Lumper charges do not reconcile");
const profitCheckIdx = indexSrc.indexOf("Profit / margin check");
const primusFailIdx = indexSrc.indexOf(
    "Invoice amount does not match the shipment rate");
const createIdx = indexSrc.indexOf("const shouldCreateInvoice");
const workflowStartIdx = indexSrc.indexOf(
    "Starting ${tenant.tms} workflow for new invoice");
const deferredSendIdx = indexSrc.indexOf(
    "shouldSendDeferredAmountMismatchEmail");
check("lumper mismatch is deferred, not emailed inline",
    lumperIdx >= 0 && profitCheckIdx > lumperIdx &&
    !indexSrc.slice(lumperIdx, profitCheckIdx).includes("forwardToHumanReview"),
    true);
check("primus mismatch is deferred, not emailed inline",
    primusFailIdx >= 0 && primusFailIdx < createIdx &&
    !indexSrc.slice(primusFailIdx, createIdx).includes("forwardToHumanReview"),
    true);
check("invoice creation includes the mismatch paperwork path",
    indexSrc.slice(createIdx, createIdx + 500)
        .includes("createInvoiceForPaperwork"),
    true);
check("mismatch email is sent after the workflow starts",
    deferredSendIdx > workflowStartIdx, true);
check("mismatch alert subject is unchanged",
    indexSrc.includes("Invoice amount does not match the shipment rate"),
    true);

const primusSrc = fs.readFileSync(
    path.join(__dirname, "..", "innovative-primus.js"), "utf8");
const uploadIdx = primusSrc.indexOf("await uploadPaperworkEarly({");
const holdIdx = primusSrc.indexOf("amountMismatchStillBlocks");
const billIdx = primusSrc.indexOf("Generating customer invoice");
check("workflow pauses for mismatch after paperwork upload",
    uploadIdx >= 0 && holdIdx > uploadIdx && billIdx > holdIdx, true);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll amount-mismatch paperwork-before-hold checks passed.");
