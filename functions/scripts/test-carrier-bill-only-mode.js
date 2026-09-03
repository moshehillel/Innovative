/* eslint-disable no-console */
"use strict";

/**
 * Pure helper mirroring carrier-bill-only detection in innovative-primus.js.
 * @param {boolean} customerInvoiceIssued Issued customer invoice in Primus.
 * @param {boolean} carrierBillEntered Carrier bill already entered in Primus.
 * @return {boolean}
 */
function isCarrierBillOnlyScenario(customerInvoiceIssued, carrierBillEntered) {
  return !!(customerInvoiceIssued && !carrierBillEntered);
}

/**
 * Mirrors resolveBillingSkipAction action selection for Primus billing state.
 * @param {object} args Inputs.
 * @return {string} Action name.
 */
function billingSkipActionFromPrimusState(args) {
  const inFirestore = !!(args.firestoreCustomerInvoice &&
    args.firestoreCarrierEntered);
  const inPrimus = inFirestore || !!(args.primusCustomerInvoiceIssued &&
    args.primusCarrierBillEntered);
  if (!inPrimus) {
    if (isCarrierBillOnlyScenario(
        args.primusCustomerInvoiceIssued,
        args.primusCarrierBillEntered)) {
      return "carrier_bill_only";
    }
    return "continue";
  }
  if (args.customerEmailRejected) return "skip_entirely";
  if (!inFirestore && args.primusCustomerInvoiceIssued &&
      args.primusCarrierBillEntered) {
    return "skip_entirely";
  }
  return "customer_email_only";
}

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}` +
    (ok ? "" : ` got=${actual} exp=${expected}`));
};

check("pre-issued invoice + no carrier bill => carrier_bill_only",
    billingSkipActionFromPrimusState({
      primusCustomerInvoiceIssued: true,
      primusCarrierBillEntered: false,
    }), "carrier_bill_only");

check("both complete in Primus but fresh Firestore => skip_entirely",
    billingSkipActionFromPrimusState({
      primusCustomerInvoiceIssued: true,
      primusCarrierBillEntered: true,
      firestoreCustomerInvoice: false,
      firestoreCarrierEntered: false,
    }), "skip_entirely");

check("both complete in Firestore => customer_email_only",
    billingSkipActionFromPrimusState({
      primusCustomerInvoiceIssued: true,
      primusCarrierBillEntered: true,
      firestoreCustomerInvoice: true,
      firestoreCarrierEntered: true,
    }), "customer_email_only");

check("neither issued => continue",
    billingSkipActionFromPrimusState({
      primusCustomerInvoiceIssued: false,
      primusCarrierBillEntered: false,
    }), "continue");

check("carrier entered but invoice not issued => continue",
    billingSkipActionFromPrimusState({
      primusCustomerInvoiceIssued: false,
      primusCarrierBillEntered: true,
    }), "continue");

check("isCarrierBillOnlyScenario true only when invoice issued first",
    isCarrierBillOnlyScenario(true, false), true);
check("isCarrierBillOnlyScenario false when carrier already entered",
    isCarrierBillOnlyScenario(true, true), false);
check("isCarrierBillOnlyScenario false when invoice not issued",
    isCarrierBillOnlyScenario(false, false), false);

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("All carrier-bill-only mode checks passed.");

module.exports = {isCarrierBillOnlyScenario, billingSkipActionFromPrimusState};
