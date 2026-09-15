/* eslint-disable no-console */
"use strict";

/**
 * Unit tests for removeAccessorials in applyRulesToLane.
 */

const quoteRules = require("../quote-accessorial-rules");

let failures = 0;
const checkTrue = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const laneBase = {
  consignee: {name: "AAFES Fort Example", address: "1 Base Rd"},
  shipper: {},
  specialInstructions: "",
  flags: {},
  siteType: "aafes_military",
  enrichmentMeta: {classifiedAs: "aafes_military", source: "name_heuristic"},
  accessorials: ["NTD"],
  accessorialsWithData: [{code: "NTD", note: "call ahead"}],
};

const addApd = {
  id: "military_apd",
  active: true,
  priority: 10,
  name: "Military → APD+LAD",
  identifyVia: "both",
  match: {siteType: "aafes_military"},
  addAccessorials: ["LAD", "APD"],
  applyTo: "dest",
};

const removeNtd = {
  id: "apd_no_ntd",
  active: true,
  priority: 90,
  name: "Appointment context — no notification",
  identifyVia: "both",
  match: {siteType: "aafes_military"},
  addAccessorials: [],
  removeAccessorials: ["NTD"],
  applyTo: "dest",
};

const out = quoteRules.applyRulesToLane(laneBase, [addApd, removeNtd], {});
checkTrue("adds APD and LAD",
    out.accessorials.includes("APD") && out.accessorials.includes("LAD"));
checkTrue("removes NTD after adds",
    !out.accessorials.includes("NTD"));
checkTrue("strips NTD from accessorialsWithData",
    !(out.accessorialsWithData || []).some((r) =>
      String(r && r.code) === "NTD"));
checkTrue("records both applied rules",
    (out.appliedRules || []).some((r) => r.ruleId === "military_apd") &&
    (out.appliedRules || []).some((r) => r.ruleId === "apd_no_ntd"));

// Same-rule add APD + remove NTD (appointment email text).
const apptLane = {
  consignee: {name: "Store", address: "1 Main"},
  shipper: {},
  specialInstructions: "delivery appointment required",
  flags: {},
  siteType: null,
  accessorials: ["NTD", "LFD"],
  accessorialsWithData: [
    {code: "NTD"},
    {code: "LFD"},
  ],
};
const combined = {
  id: "appt_apd_no_ntd",
  active: true,
  priority: 40,
  name: "Appointment → APD, never NTD",
  identifyVia: "address_text",
  match: {
    instructionsContains: [
      "appointment", "delivery appointment", "appt required",
    ],
  },
  addAccessorials: ["APD"],
  removeAccessorials: ["NTD"],
  applyTo: "dest",
};
const out2 = quoteRules.applyRulesToLane(apptLane, [combined], {});
checkTrue("combined rule adds APD", out2.accessorials.includes("APD"));
checkTrue("combined rule removes NTD", !out2.accessorials.includes("NTD"));
checkTrue("combined rule keeps LFD", out2.accessorials.includes("LFD"));
checkTrue("combined withData keeps LFD only",
    (out2.accessorialsWithData || []).length === 1 &&
    out2.accessorialsWithData[0].code === "LFD");

// Removes win even when a later rule would have added NTD first in priority
// (all adds, then all removes).
const addNtdLate = {
  id: "always_ntd",
  active: true,
  priority: 99,
  name: "Always notify",
  identifyVia: "both",
  match: {siteType: "aafes_military"},
  addAccessorials: ["NTD"],
  applyTo: "dest",
};
const out3 = quoteRules.applyRulesToLane(
    {...laneBase, accessorials: [], accessorialsWithData: []},
    [addApd, removeNtd, addNtdLate],
    {});
checkTrue("remove wins over later add of NTD",
    !out3.accessorials.includes("NTD") &&
    out3.accessorials.includes("APD"));

// Inactive / non-matching remove rule does nothing.
const inactiveRemove = {...removeNtd, id: "off", active: false};
const out4 = quoteRules.applyRulesToLane(
    {...laneBase, accessorials: ["NTD"]},
    [addApd, inactiveRemove],
    {});
checkTrue("inactive remove leaves NTD", out4.accessorials.includes("NTD"));

// --- Never-add-insurance: synthetic insuranceRequested flag ---
const neverIns = {
  id: "never_add_insurance",
  active: true,
  priority: 40,
  name: "Never add insurance to quotes",
  identifyVia: "ai",
  match: {flags: ["insuranceRequested"]},
  addAccessorials: [],
  removeAccessorials: ["INS"],
  applyTo: "dest",
};

const insLane = {
  consignee: {name: "Acme", address: "1 Main"},
  shipper: {},
  specialInstructions: "Please include insurance",
  flags: {},
  siteType: null,
  // No enrichmentMeta — identifyVia ai must still match synthetic flags.
  accessorials: ["INS", "LFD"],
  accessorialsWithData: [{code: "INS"}, {code: "LFD"}],
};
const outIns = quoteRules.applyRulesToLane(insLane, [neverIns], {
  emailBody: "Need cargo insurance on this shipment",
});
checkTrue("never-ins removes INS with identifyVia ai + no enrichment",
    !outIns.accessorials.includes("INS"));
checkTrue("never-ins keeps LFD", outIns.accessorials.includes("LFD"));
checkTrue("never-ins records applied rule",
    (outIns.appliedRules || []).some((r) =>
      r.ruleId === "never_add_insurance"));

const insLaneCodesOnly = {
  ...insLane,
  specialInstructions: "",
  accessorials: ["INS"],
  accessorialsWithData: [{code: "INS"}],
};
const outIns2 = quoteRules.applyRulesToLane(insLaneCodesOnly, [neverIns], {});
checkTrue("never-ins matches when INS already on lane (no email text)",
    !outIns2.accessorials.includes("INS"));

// Email merge re-adds INS → applyRemoveAccessorialRules strips again.
const afterEmail = {
  accessorials: ["INS", "LFD"],
  accessorialsWithData: [{code: "INS"}, {code: "LFD"}],
  appliedRules: [{ruleId: "email_requested", name: "Requested in email"}],
};
const stripped = quoteRules.applyRemoveAccessorialRules(
    {consignee: {name: "Acme"}, specialInstructions: "insurance please"},
    afterEmail,
    [neverIns],
    {emailBody: "insurance please"});
checkTrue("post-email remove strips re-added INS",
    !stripped.accessorials.includes("INS") &&
    stripped.accessorials.includes("LFD"));
checkTrue("post-email remove records never_add_insurance",
    (stripped.appliedRules || []).some((r) =>
      r.ruleId === "never_add_insurance"));

// Name-only never-ins rule (no flags) still always strips INS.
const neverInsByName = {
  id: "never_ins_name",
  active: true,
  priority: 40,
  name: "Never add insurance",
  identifyVia: "email",
  match: {},
  addAccessorials: [],
  removeAccessorials: ["INS"],
  applyTo: "dest",
};
const outInsName = quoteRules.applyRulesToLane({
  consignee: {name: "Acme"},
  shipper: {},
  accessorials: ["INS", "APD"],
  accessorialsWithData: [{code: "INS"}, {code: "APD"}],
}, [neverInsByName], {});
checkTrue("never-ins by name always strips INS",
    !outInsName.accessorials.includes("INS") &&
    outInsName.accessorials.includes("APD"));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll removeAccessorials engine checks passed.");
