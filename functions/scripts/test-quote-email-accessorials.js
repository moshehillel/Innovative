/* eslint-disable no-console */
"use strict";

const emailAcc = require("../quote-email-accessorials");

let failures = 0;
const check = (name, got, exp) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) {
    console.log(`  got: ${JSON.stringify(got)}`);
    console.log(`  exp: ${JSON.stringify(exp)}`);
  }
};

const checkHas = (name, arr, code) => {
  const pass = Array.isArray(arr) && arr.includes(code);
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) {
    console.log(`  missing ${code} in ${JSON.stringify(arr)}`);
  }
};

const checkNotHas = (name, arr, code) => {
  const pass = Array.isArray(arr) && !arr.includes(code);
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) {
    console.log(`  unexpectedly has ${code} in ${JSON.stringify(arr)}`);
  }
};

let codes = emailAcc.extractRequestedAccessorialsFromText(
    "Need liftgate and appointment delivery, residential.");
checkHas("liftgate unspecified → LFO", codes, "LFO");
checkHas("liftgate unspecified → LFD", codes, "LFD");
checkHas("appointment → APD", codes, "APD");
checkHas("residential → RSD", codes, "RSD");
checkNotHas("appointment at dest does not add APO", codes, "APO");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "Dock 4. Mon-Fri 8:30am - 4:30pm. No Appointment necessary.");
checkNotHas("no appointment necessary does not add APD", codes, "APD");
checkNotHas("no appointment necessary does not add APO", codes, "APO");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "no appt needed, liftgate at delivery");
checkNotHas("no appt needed does not add APD", codes, "APD");
checkHas("no appt needed still adds LFD", codes, "LFD");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "appointment not required");
checkNotHas("appointment not required does not add APD", codes, "APD");

check("declines no appointment necessary",
    emailAcc.declinesAppointmentDelivery("No Appointment necessary"), true);
check("does not decline bare appointment",
    emailAcc.declinesAppointmentDelivery("appointment delivery required"),
    false);

const declinedAi = emailAcc.attachRequestedAccessorials({
  specialInstructionsGlobal: "No Appointment necessary",
  customerRequest: {requestedAccessorials: ["APD"]},
  lanes: [],
}, {subject: "RFQ", body: "No Appointment necessary"});
checkNotHas("AI APD stripped when email says no appt",
    declinedAi.customerRequest.requestedAccessorials, "APD");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "Liftgate at pickup only");
checkHas("liftgate pickup → LFO", codes, "LFO");
checkNotHas("liftgate pickup not LFD", codes, "LFD");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "Please include limited access charges in the quote.");
checkHas("limited access → LAD", codes, "LAD");
checkNotHas("limited access not LAO", codes, "LAO");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "Inside delivery required. Also insurance.");
checkHas("inside delivery → IND", codes, "IND");
checkHas("insurance → INS", codes, "INS");

const extracted = emailAcc.attachRequestedAccessorials({
  specialInstructionsGlobal: "",
  lanes: [],
  customerRequest: {wantsLimitedAccessInQuote: true},
}, {subject: "RFQ", body: "Please quote this load."});
checkHas("wantsLimitedAccessInQuote → LAD",
    extracted.customerRequest.requestedAccessorials, "LAD");
check("wantsLimitedAccess flag stays true",
    extracted.customerRequest.wantsLimitedAccessInQuote, true);

const rulesOut = {
  accessorials: ["LFO", "LFD"],
  accessorialsWithData: [],
  appliedRules: [{ruleId: "liftgate_no_dock", name: "Liftgate"}],
  filterCarrierWarnings: [],
  requiresConfirm: false,
};
const merged = emailAcc.applyEmailRequestedAccessorials(
    rulesOut, ["LFO", "LFD", "LAD"], (codes) => codes.join(", "));
check("no duplicate LFO/LFD", merged.accessorials.sort(),
    ["LAD", "LFD", "LFO"].sort());
checkHas("added LAD", merged.accessorials, "LAD");
const emailWhy = (merged.appliedRules || [])
    .find((r) => r.ruleId === "email_requested");
check("email why present", !!emailWhy, true);
check("email why name", emailWhy && emailWhy.name, "Requested in email");

const noNew = emailAcc.applyEmailRequestedAccessorials(
    rulesOut, ["LFO", "LFD"], (codes) => codes.join(", "));
check("no extra why when all already from rules",
    (noNew.appliedRules || []).some((r) => r.ruleId === "email_requested"),
    false);

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll assertions passed");
