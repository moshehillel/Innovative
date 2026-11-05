/* eslint-disable no-console */
"use strict";

const fs = require("fs");
const path = require("path");
const workflowErrors = require("../workflow-error-messages");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const miss = {
  errorMessage: "Could not resolve billtoId from booking",
  loadNumber: "267852",
  carrierName: "Central Transport",
  customerName: "B & C Industries",
  draftInvoiceId: "3610437",
};

check("bill-to miss is this alert class",
    workflowErrors.isBilltoBookingFixAlert("UI_BILLING_FAILED", miss));
check("bill-to miss is not a system alert",
    !workflowErrors.isSystemAlertCode("UI_BILLING_FAILED", miss));
check("location-not-found source is this class",
    workflowErrors.isBilltoBookingFixAlert("UI_BILLING_FAILED", {
      billtoSource: "manage_location_not_found",
      errorMessage: "Could not map bill-to party \"B & C Industries\" " +
        "to manage.php shipping location",
    }));
check("manage.php bill-to text is not a system alert",
    !workflowErrors.isSystemAlertCode("UI_BILLING_FAILED", {
      errorMessage: "Could not resolve manage.php bill-to shipping location",
      step: "resolveBillto",
    }));
check("other UI billing crashes stay system alerts",
    workflowErrors.isSystemAlertCode("UI_BILLING_FAILED", {
      errorMessage: "TypeError: Cannot read properties of undefined",
      step: "saveInvoice",
    }));
check("unrelated codes are not bill-to alerts",
    !workflowErrors.isBilltoBookingFixAlert("WORKFLOW_FAILED", miss));

const email = workflowErrors.buildWorkflowAlertEmail({
  code: "UI_BILLING_FAILED",
  context: miss,
  baseUrl: "https://example.test",
  invoiceId: "inv-267852",
});
check("subject names the load",
    email.subject.includes("267852") &&
    /bill-to missing/i.test(email.subject));
check("explains the location was not found",
    email.html.includes("was not found"));
check("names carrier and customer",
    email.html.includes("Central Transport") &&
    email.html.includes("B &amp; C Industries"));
check("tells Lisa what to select and to resume",
    /select the real customer/i.test(email.html) &&
    /draft invoice/i.test(email.html) &&
    /Bill To is/i.test(email.html) &&
    email.html.includes("3610437") &&
    email.html.includes("Resume Workflow"));
check("lisa address constant",
    workflowErrors.BILLTO_BOOKING_FIX_EMAIL ===
    "lisa@innovativecarriers.com");

const primus = fs.readFileSync(
    path.join(__dirname, "..", "innovative-primus.js"), "utf8");
check("workflow pins this alert to Lisa and forces send",
    primus.includes("isBilltoBookingFixAlert") &&
    primus.includes("BILLTO_BOOKING_FIX_EMAIL") &&
    primus.includes("forceRecipient") &&
    primus.includes("forceSend") &&
    primus.includes("billto_booking_fix"));

if (failures) {
  console.error(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
