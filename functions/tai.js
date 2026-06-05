/**
 * TAI TMS integration.
 *
 * This file is reserved for clients whose freight software runs on TAI.
 * When a TAI client is onboarded, build the equivalent workflow functions here
 * following the same pattern as the Primus workflow in index.js.
 *
 * Expected env vars (per client or shared):
 *   TAI_BASE_URL       - Base URL of the TAI REST API
 *   TAI_VALIDATE_URL   - TAI amount-validation endpoint (if separate)
 *
 * Functions to implement:
 *   validateAmountWithTai(loadNumber, amount)
 *   addProNumberToLoad(loadNumber, proNumber)
 *   getCustomerRate(loadNumber)
 *   markShipmentDelivered(loadNumber, proNumber)
 *   approveCarrierBill(billData)
 *   generateCustomerInvoice(invoiceData)
 *   addChargeToCustomerInvoice(customerInvoiceId, charge)
 *   exports.processTaiWorkflow  - onRequest Cloud Function
 */

"use strict";

// TAI integration — not yet implemented.
