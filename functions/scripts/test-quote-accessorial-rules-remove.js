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

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll removeAccessorials engine checks passed.");
