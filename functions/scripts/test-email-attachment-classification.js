/* eslint-disable no-console */
"use strict";

const adm = require("../administrative-email-intake");
const emailAtt = require("../email-attachment-classification");

let failures = 0;
const check = (name, got, exp) => {
  const pass = got === exp;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) {
    console.log(`  got: ${JSON.stringify(got)}`);
    console.log(`  exp: ${JSON.stringify(exp)}`);
  }
};

const rmCapitalBody =
  "RM Capital Inc. sent an invoice for reference #264969 and requested " +
  "confirmation of receipt.";

check("Lisa FW REF# + RM Capital body recognized as invoice content",
    adm.looksLikeInvoiceEmailContent("FW: REF# 264969", rmCapitalBody), true);

check("Lisa FW REF# without invoice word not recognized",
    adm.looksLikeInvoiceEmailContent("FW: REF# 264969", "Please review."), false);

const lisaFrom = "Lisa <lisa@innovativecarriers.com>";
const rmPdf = [{filename: "invoice.pdf", mimeType: "application/pdf"}];

const overridden = emailAtt.overrideClassificationIfInvoicePackage(
    {intent: "unknown", confidence: "low"},
    "FW: REF# 264969", lisaFrom, rmCapitalBody, rmPdf);
check("Unknown classifier overridden to carrier_invoice for RM Capital FW",
    overridden.intent, "carrier_invoice");

const resolved = emailAtt.resolveAttachmentDocType("OTHER", {
  subject: "FW: REF# 264969",
  from: lisaFrom,
  body: rmCapitalBody,
  filename: "invoice.pdf",
  pageCount: 1,
  emailClassification: overridden,
});
check("OTHER PDF promoted to INVOICE when email is carrier_invoice",
    resolved.docType, "INVOICE");
check("OTHER promotion flagged",
    resolved.promoted, true);

const resolvedHeuristic = emailAtt.resolveAttachmentDocType("OTHER", {
  subject: "FW: REF# 264627",
  from: lisaFrom,
  body: "RM Capital Inc. sent an invoice for reference #264627.",
  filename: "doc.pdf",
  pageCount: 1,
  emailClassification: {intent: "unknown", confidence: "low"},
});
check("OTHER promoted via body heuristic without classifier",
    resolvedHeuristic.docType, "INVOICE");

const resolvedPod = emailAtt.resolveAttachmentDocType("OTHER", {
  subject: "POD for load 264969",
  from: "carrier@example.com",
  body: "Attached is the signed BOL.",
  filename: "pod.pdf",
  pageCount: 1,
  emailClassification: {intent: "pod_delivery", confidence: "high"},
});
check("OTHER not promoted when classifier says pod_delivery",
    resolvedPod.docType, "OTHER");

check("emailClassificationSupportsInvoicePdf medium confidence",
    emailAtt.emailClassificationSupportsInvoicePdf(
        {intent: "carrier_invoice", confidence: "medium"},
        {subject: "FW: REF# 264862", body: rmCapitalBody}), true);

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nAll email-attachment-classification tests passed.");
