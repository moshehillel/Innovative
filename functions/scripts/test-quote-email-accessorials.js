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
    "Need liftgate and residential.");
checkNotHas("liftgate unspecified not LFO", codes, "LFO");
checkHas("liftgate unspecified → LFD", codes, "LFD");
checkHas("residential → RSD", codes, "RSD");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "LIFTGATE NEEDED");
checkHas("bare LIFTGATE NEEDED → LFD", codes, "LFD");
checkNotHas("bare LIFTGATE NEEDED not LFO", codes, "LFO");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "Need appointment delivery.");
checkHas("appointment → APD", codes, "APD");
checkNotHas("appointment at dest does not add APO", codes, "APO");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "Lift gate needed for delivery.");
checkHas("liftgate for delivery → LFD", codes, "LFD");
checkNotHas("liftgate for delivery not LFO", codes, "LFO");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "These need liftgates. Lift gate needed for delivery.");
checkHas("these need liftgates + delivery → LFD", codes, "LFD");
checkNotHas("these need liftgates + delivery not LFO", codes, "LFO");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "Need liftgate and appointment delivery, residential.");
checkHas("liftgate near delivery word → LFD", codes, "LFD");
checkNotHas("liftgate near delivery word not LFO", codes, "LFO");
checkHas("appointment → APD (with liftgate)", codes, "APD");
checkHas("residential with liftgate → RSD", codes, "RSD");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "Dock 4. Mon-Fri 8:30am - 4:30pm. No Appointment necessary.");
checkNotHas("no appointment necessary does not add APD", codes, "APD");
checkNotHas("no appointment necessary does not add APO", codes, "APO");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "no appt needed, liftgate at delivery");
checkNotHas("no appt needed does not add APD", codes, "APD");
checkHas("no appt needed still adds LFD", codes, "LFD");
checkNotHas("liftgate at delivery not LFO", codes, "LFO");

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
checkNotHas("disclose limited access charges does not add LAD",
    codes, "LAD");
checkNotHas("disclose limited access charges does not add LAO",
    codes, "LAO");
check("disclose-only detect",
    emailAcc.isLimitedAccessDiscloseOnly(
        "Please include limited access charges in the quote."), true);

codes = emailAcc.extractRequestedAccessorialsFromText(
    "Please include any additional charges applicable for " +
    "restricted or limited delivery directly in the quote email.");
checkNotHas("restricted/limited delivery disclose does not add LAD",
    codes, "LAD");
check("core home disclose-only",
    emailAcc.isLimitedAccessDiscloseOnly(
        "Please include any additional charges applicable for " +
        "restricted or limited delivery directly in the quote email."),
    true);

codes = emailAcc.extractRequestedAccessorialsFromText(
    "any applicable limited access charges");
checkNotHas("any applicable LAD charges does not add LAD", codes, "LAD");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "if limited access applies, include in quote");
checkNotHas("if limited access applies does not add LAD", codes, "LAD");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "Needs limited access.");
checkHas("needs limited access → LAD", codes, "LAD");
checkNotHas("needs limited access not LAO", codes, "LAO");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "limited access delivery required");
checkHas("limited access delivery required → LAD", codes, "LAD");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "restricted access");
checkHas("bare restricted access → LAD", codes, "LAD");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "LAD please");
checkHas("LAD please → LAD", codes, "LAD");

const discloseAi = emailAcc.attachRequestedAccessorials({
  specialInstructionsGlobal:
    "Please include any additional charges applicable for " +
    "restricted or limited delivery directly in the quote email.",
  customerRequest: {
    wantsLimitedAccessInQuote: true,
    requestedAccessorials: ["LAD"],
  },
  lanes: [],
}, {
  subject: "RFQ",
  body: "Please include any additional charges applicable for " +
    "restricted or limited delivery directly in the quote email.",
});
checkNotHas("AI LAD stripped for disclose-only boilerplate",
    discloseAi.customerRequest.requestedAccessorials, "LAD");
check("wantsLimitedAccess cleared for disclose-only",
    discloseAi.customerRequest.wantsLimitedAccessInQuote, false);

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

const refinedDelivery = emailAcc.applyEmailRequestedAccessorials(
    {accessorials: ["LFO", "LFD"], appliedRules: []},
    ["LFD"],
    (c) => c.join(", "),
    "Lift gate needed for delivery.");
checkHas("refine delivery keeps LFD", refinedDelivery.accessorials, "LFD");
checkNotHas("refine delivery strips LFO", refinedDelivery.accessorials, "LFO");

const aiBothDelivery = emailAcc.attachRequestedAccessorials({
  specialInstructionsGlobal: "Lift gate needed for delivery.",
  customerRequest: {requestedAccessorials: ["LFO", "LFD"]},
  lanes: [],
}, {subject: "RFQ", body: "Lift gate needed for delivery."});
checkHas("AI keeps LFD when delivery-only email",
    aiBothDelivery.customerRequest.requestedAccessorials, "LFD");
checkNotHas("AI LFO stripped when delivery-only",
    aiBothDelivery.customerRequest.requestedAccessorials, "LFO");

const aiBothBare = emailAcc.attachRequestedAccessorials({
  specialInstructionsGlobal: "LIFTGATE NEEDED",
  customerRequest: {requestedAccessorials: ["LFO", "LFD"]},
  lanes: [],
}, {subject: "RFQ", body: "LIFTGATE NEEDED"});
checkHas("AI keeps LFD on bare liftgate",
    aiBothBare.customerRequest.requestedAccessorials, "LFD");
checkNotHas("AI LFO stripped on bare liftgate",
    aiBothBare.customerRequest.requestedAccessorials, "LFO");

const refinedBare = emailAcc.applyEmailRequestedAccessorials(
    {accessorials: ["LFO", "LFD"], appliedRules: []},
    ["LFO", "LFD"],
    (c) => c.join(", "),
    "LIFTGATE NEEDED");
checkHas("refine bare keeps LFD", refinedBare.accessorials, "LFD");
checkNotHas("refine bare strips LFO", refinedBare.accessorials, "LFO");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "No liftgate needed. Dock available.");
checkNotHas("no liftgate does not add LFD", codes, "LFD");
checkNotHas("no liftgate does not add LFO", codes, "LFO");
check("declines liftgate",
    emailAcc.declinesLiftgate("no liftgate needed"), true);
check("does not decline loading dock as liftgate",
    emailAcc.declinesLiftgate("no loading dock"), false);

codes = emailAcc.extractRequestedAccessorialsFromText(
    "No limited access. Warehouse with dock.");
checkNotHas("no limited access does not add LAD", codes, "LAD");
checkNotHas("no limited access does not add LAO", codes, "LAO");
check("declines limited access",
    emailAcc.declinesLimitedAccess("no limited access"), true);

codes = emailAcc.extractRequestedAccessorialsFromText(
    "Deliver to Golden Moon Hotel and Casino, Choctaw MS.");
checkNotHas("facility name hotel does not add HOD", codes, "HOD");
checkNotHas("facility name hotel does not add LAD from name alone", codes, "LAD");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "Please quote hotel delivery to the consignee.");
checkHas("explicit hotel delivery → LAD", codes, "LAD");
checkNotHas("explicit hotel delivery not HOD", codes, "HOD");

check("HOD normalizes to LAD",
    emailAcc.normalizeHotelCasinoAccessorials(["HOD", "LFD"]).sort(),
    ["LAD", "LFD"].sort());

const declinedLift = emailAcc.attachRequestedAccessorials({
  specialInstructionsGlobal: "No liftgate needed",
  customerRequest: {requestedAccessorials: ["LFD", "LFO"]},
  lanes: [],
}, {subject: "RFQ", body: "No liftgate needed"});
checkNotHas("AI LFD stripped when email says no liftgate",
    declinedLift.customerRequest.requestedAccessorials, "LFD");
check("persisted declined LFD",
    (declinedLift.customerDeclinedAccessorials || []).includes("LFD"), true);

const inquiryQ = "Are there any accessorials needed (liftgate, inside " +
    "delivery etc.)";
codes = emailAcc.extractRequestedAccessorialsFromText(inquiryQ);
checkNotHas("questionnaire liftgate not LFD", codes, "LFD");
checkNotHas("questionnaire liftgate not LFO", codes, "LFO");
checkNotHas("questionnaire inside not IND", codes, "IND");
check("questionnaire is inquiry",
    emailAcc.hasAccessorialInquiryLanguage(inquiryQ), true);

codes = emailAcc.extractRequestedAccessorialsFromText(
    "Does liftgate apply?");
checkNotHas("does liftgate apply not LFD", codes, "LFD");
checkNotHas("does liftgate apply not LFO", codes, "LFO");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "Please advise if inside delivery is required.");
checkNotHas("advise if inside not IND", codes, "IND");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "any accessorials?");
check("any accessorials? extracts none", codes, []);

codes = emailAcc.extractRequestedAccessorialsFromText(
    "if any accs fees apply, include in the quote");
checkNotHas("if any accs fees apply not LFD", codes, "LFD");
checkNotHas("if any accs fees apply not IND", codes, "IND");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "Are there any accessorials needed (liftgate, inside delivery etc.)\n" +
    "Liftgate needed for delivery. Inside delivery required.");
checkHas("inquiry + request still LFD", codes, "LFD");
checkNotHas("inquiry + delivery request not LFO", codes, "LFO");
checkHas("inquiry + request still IND", codes, "IND");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "Please notify the sender immediately by telephone.");
checkNotHas("notify the sender not NTD", codes, "NTD");

codes = emailAcc.extractRequestedAccessorialsFromText(
    "Notification before delivery required.");
checkHas("notification before delivery → NTD", codes, "NTD");

const ediThread =
    "Hi Alan\nIt was a pleasure speaking with you.\n" +
    "Please provide the following info for your shipments\n" +
    "· Pallets dimensions\n· Total weight\n" +
    "· Are there any accessorials needed (liftgate, inside delivery etc.)\n" +
    "· Origin zip code\n· Destination zip code\n· Commodity\n" +
    "Please notify the sender immediately if received in error.";
codes = emailAcc.extractRequestedAccessorialsFromText(ediThread);
check("EDI questionnaire extracts none", codes, []);

const inquiryAi = emailAcc.attachRequestedAccessorials({
  specialInstructionsGlobal: "",
  customerRequest: {requestedAccessorials: ["LFO", "LFD", "IND", "NTD"]},
  lanes: [],
}, {subject: "FW: Re:", body: ediThread});
check("AI codes stripped for accessorial question",
    inquiryAi.customerRequest.requestedAccessorials, []);

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll assertions passed");
