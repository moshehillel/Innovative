/* eslint-disable no-console */
"use strict";

const adm = require("../administrative-email-intake");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const emodalBody =
  "Today's eModal Broadcasts\nPier E: LBCT Terminal Rules\nautomated email";
check("eModal broadcast",
    adm.isEmodalBroadcast("Today's eModal Broadcasts", "emodal@x.com", emodalBody));

const rtsSubject = "RTS Financial NOA: JAYKHUN CARGO LLC MC# 1357866";
const rtsBody = "Notice of Assignment\nREMIT TO ADDRESS\nRTS Financial";
check("RTS NOA email",
    adm.isRtsNoaEmail(rtsSubject, "NOA@rtsinc.com", rtsBody));
check("RTS NOA attachments NOA only",
    adm.rtsNoaAttachmentsLookNoaOnly([
      {filename: "NOA-Jaykhun.pdf", mimeType: "application/pdf"},
      {filename: "Notice_of_Assignment.pdf", mimeType: "application/pdf"},
    ]));
check("RTS with invoice filename not ignored",
    !adm.rtsNoaAttachmentsLookNoaOnly([
      {filename: "carrier_invoice_123.pdf", mimeType: "application/pdf"},
      {filename: "NOA.pdf", mimeType: "application/pdf"},
    ]));
check("evaluate eModal",
    adm.evaluateAdministrativeIgnore("", "emodal@x.com", emodalBody, []).ignore);
check("evaluate RTS NOA with NOA filename",
    adm.evaluateAdministrativeIgnore(
        rtsSubject, "NOA@rtsinc.com", rtsBody,
        [{filename: "NOA.pdf", mimeType: "application/pdf"}]).status ===
    "noa_ignored");

const ithriveSubject =
  "iThrive Funding - Notice of Assignment for First Family Trucking LLC " +
  "(MC 1115353) - Please Confirm Receipt";
const genericNoaPdf = [{filename: "1115.pdf", mimeType: "application/pdf"}];
check("FactorView iThrive NOA content detected",
    adm.isNoticeOfAssignmentEmail(
        ithriveSubject,
        "iThrive Funding <notification@factorview.com>",
        "Please confirm receipt of Notice of Assignment"));
check("generic PDF + NOA not ignored before classification",
    !adm.evaluateAdministrativeIgnore(
        ithriveSubject,
        "notification@factorview.com",
        "Notice of Assignment",
        genericNoaPdf).ignore);
check("generic PDF + NOA ignored after scan finds no invoice",
    adm.shouldIgnoreNoaOnlyPackage(
        ithriveSubject,
        "Notice of Assignment",
        genericNoaPdf,
        0));
check("FactorView invoice from same sender is NOT NOA",
    !adm.isNoticeOfAssignmentEmail(
        "Invoice 23493 - Load 265708",
        "notification@factorview.com",
        "Please see attached invoice"));
check("FactorView invoice evaluate not ignored",
    !adm.evaluateAdministrativeIgnore(
        "Invoice 23494 - Load 265798",
        "Chugh Capital, LLC <notification@factorview.com>",
        "Invoice attached",
        [{filename: "1116.pdf", mimeType: "application/pdf"}]).ignore);
check("invoice PDF count blocks NOA ignore even with NOA subject",
    !adm.shouldIgnoreNoaOnlyPackage(
        ithriveSubject,
        "Notice of Assignment",
        genericNoaPdf,
        1));
check("invoice filename blocks NOA ignore",
    !adm.shouldIgnoreNoaOnlyPackage(
        ithriveSubject,
        "Notice of Assignment",
        [{filename: "carrier_invoice.pdf", mimeType: "application/pdf"}],
        0));

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nAll administrative email tests passed");
