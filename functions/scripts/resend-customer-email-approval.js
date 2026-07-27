#!/usr/bin/env node
/**
 * Print a fresh signed customer-email approval link for a load whose email
 * button failed (broken HTML encoding in the original message).
 *
 * Usage:
 *   node scripts/resend-customer-email-approval.js <loadNumber>
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS or gcloud application-default login.
 */
"use strict";

const admin = require("firebase-admin");
const emailActionTokens = require("../email-action-tokens");

const loadNumber = process.argv[2];

if (!loadNumber) {
  console.error("Usage: node scripts/resend-customer-email-approval.js " +
    "<loadNumber>");
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

/**
 * @param {string} num Load number.
 * @return {Promise<object|null>}
 */
async function findInvoiceByLoad(num) {
  const snap = await db.collection("invoices")
      .where("loadNumber", "==", String(num))
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return {id: doc.id, data: doc.data()};
}

/**
 * @param {object} invoice Invoice data.
 * @param {string} invoiceId Firestore id.
 * @return {{approveUrl: string, rejectUrl: string}}
 */
function buildUrls(invoiceId, tenantId) {
  const baseUrl = emailActionTokens.publicFunctionsBaseUrl();
  const approveUrl = emailActionTokens.buildConfirmUrl({
    baseUrl,
    path: "approveCustomerEmail",
    action: "customerEmailApproval",
    invoiceId,
    option: "approve",
    tenantId: tenantId || null,
  });
  const rejectUrl = emailActionTokens.buildConfirmUrl({
    baseUrl,
    path: "approveCustomerEmail",
    action: "customerEmailApproval",
    invoiceId,
    option: "reject",
    tenantId: tenantId || null,
  });
  return {approveUrl, rejectUrl};
}

/**
 * @return {Promise<void>}
 */
async function main() {
  const row = await findInvoiceByLoad(loadNumber);
  if (!row) {
    console.error(`No invoice found for load ${loadNumber}`);
    process.exit(1);
  }
  const {id: invoiceId, data: invoice} = row;
  const tenantId = invoice.tenantId || "default";
  const approval = invoice.customerEmailApproval || null;

  if (approval === "approved") {
    console.log(`Load ${loadNumber} (${invoiceId}): already approved.`);
    process.exit(0);
  }
  if (approval === "rejected") {
    console.log(`Load ${loadNumber} (${invoiceId}): was rejected.`);
    process.exit(0);
  }

  const {approveUrl, rejectUrl} = buildUrls(invoiceId, tenantId);
  console.log(`Load ${loadNumber} invoiceId=${invoiceId}`);
  console.log(`Approval status: ${approval || "pending"}`);
  console.log(`\nApprove URL:\n${approveUrl}\n`);
  console.log(`Reject URL:\n${rejectUrl}\n`);
  console.log("Open the Approve URL in your browser, then click Confirm.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
