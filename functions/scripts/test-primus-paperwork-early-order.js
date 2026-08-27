/* eslint-disable no-console */
"use strict";

/**
 * Documents and asserts the Primus workflow step order for paperwork upload.
 * Paperwork (carrier bill + POD) must run after load resolution and before
 * amount / additional-charge / rate review holds.
 */

const PRIMUS_WORKFLOW_STEP_ORDER = [
  "resolve_load_booking",
  "pod_extraction",
  "upload_paperwork_early", // carrier bill + POD (idempotent)
  "additional_charge_gate",
  "unrecognized_charges_check",
  "charges_proof_check",
  "amount_validation",
  "unmatched_amount_or_continue",
  "extra_charges_pending_review",
  "customer_rate_check",
  "ui_billing_flow", // may skip uploads already done
];

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}` +
    (ok ? "" : ` (got ${JSON.stringify(actual)}, ` +
      `expected ${JSON.stringify(expected)})`));
};

const uploadIdx = PRIMUS_WORKFLOW_STEP_ORDER.indexOf("upload_paperwork_early");
const amountIdx = PRIMUS_WORKFLOW_STEP_ORDER.indexOf("amount_validation");
const chargeGateIdx = PRIMUS_WORKFLOW_STEP_ORDER.indexOf(
    "additional_charge_gate");
const unmatchedIdx = PRIMUS_WORKFLOW_STEP_ORDER.indexOf(
    "unmatched_amount_or_continue");
const rateIdx = PRIMUS_WORKFLOW_STEP_ORDER.indexOf("customer_rate_check");
const billingIdx = PRIMUS_WORKFLOW_STEP_ORDER.indexOf("ui_billing_flow");

check("upload step present", uploadIdx >= 0, true);
check("upload before additional charge gate", uploadIdx < chargeGateIdx, true);
check("upload before amount validation", uploadIdx < amountIdx, true);
check("upload before unmatched hold", uploadIdx < unmatchedIdx, true);
check("upload before customer rate hold", uploadIdx < rateIdx, true);
check("upload before UI billing", uploadIdx < billingIdx, true);
check("charge gate before amount validation", chargeGateIdx < amountIdx, true);

/**
 * Mirrors uploadPaperworkEarly skip logic for already-uploaded flags.
 * @param {object} steps primusSteps flags.
 * @return {{needCarrierBill: boolean, needPod: boolean}}
 */
function paperworkUploadNeeds(steps) {
  return {
    needCarrierBill: !steps.carrierBillUploaded,
    needPod: !steps.podUploaded,
  };
}

check("idempotent skip when both done",
    JSON.stringify(paperworkUploadNeeds({
      carrierBillUploaded: true,
      podUploaded: true,
    })),
    JSON.stringify({needCarrierBill: false, needPod: false}));
check("needs carrier bill only",
    JSON.stringify(paperworkUploadNeeds({
      carrierBillUploaded: false,
      podUploaded: true,
    })),
    JSON.stringify({needCarrierBill: true, needPod: false}));
check("needs pod only",
    JSON.stringify(paperworkUploadNeeds({
      carrierBillUploaded: true,
      podUploaded: false,
    })),
    JSON.stringify({needCarrierBill: false, needPod: true}));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll paperwork-early order checks passed.");
