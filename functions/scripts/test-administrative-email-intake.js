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
check("evaluate RTS NOA",
    adm.evaluateAdministrativeIgnore(
        rtsSubject, "NOA@rtsinc.com", rtsBody,
        [{filename: "NOA.pdf", mimeType: "application/pdf"}]).status ===
    "rts_noa_ignored");

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nAll administrative email tests passed");
