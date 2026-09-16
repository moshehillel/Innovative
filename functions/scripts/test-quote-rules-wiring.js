/* eslint-disable no-console */
"use strict";

/**
 * Tests: chat-shaped Active rules are wired into the runtime
 * (sender-scoped accessorials, city/address aliases, unwired fail-loud).
 */

const quoteRules = require("../quote-accessorial-rules");
const chat = require("../quote-rules-chat");

let failures = 0;
const checkTrue = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

// --- Supported proposal still saves (not rejected) ---
const createOk = chat.validateRuleProposal({
  action: "propose_create_rule",
  ruleId: "sender_mike_add_apd",
  patch: {
    name: "Mike emails → Appointment delivery",
    match: {fromEmails: ["mike.oseback@ediexpressinc.com"]},
    addAccessorials: ["APD"],
    removeAccessorials: [],
    identifyVia: "email",
    notes: "When Mike sends a quote, add appointment delivery.",
  },
});
checkTrue("supported sender+accessorial proposal validates", createOk.ok === true);

const carrierNoteOk = chat.validateRuleProposal({
  action: "propose_create_rule",
  ruleId: "roadrunner_transit_delay_note",
  patch: {
    name: "Roadrunner transit delay note",
    match: {carrierNameContains: ["roadrunner"]},
    notes: "has lots of delays in transit.",
    addAccessorials: [],
    identifyVia: "email",
  },
});
checkTrue("carrier note proposal validates", carrierNoteOk.ok === true);

const fromNamesCreate = chat.validateRuleProposal({
  action: "propose_create_rule",
  ruleId: "sender_jared_fromnames",
  patch: {
    name: "Sender → Brumis",
    ruleKind: "sender_customer",
    match: {fromEmails: ["jared.berman@corehome.com"]},
    fromNames: ["jared berman"],
    customerName: "Brumis Imports Inc",
    addAccessorials: [],
    identifyVia: "email",
  },
});
checkTrue("create patch keeps fromNames",
    fromNamesCreate.ok === true &&
    Array.isArray(fromNamesCreate.patch.fromNames) &&
    fromNamesCreate.patch.fromNames.includes("jared berman"));

// --- Sender-scoped accessorial rule actually applies ---
const senderApd = {
  id: "sender_mike_add_apd",
  active: true,
  priority: 40,
  name: "Mike → APD",
  identifyVia: "email",
  match: {fromEmails: ["mike.oseback@ediexpressinc.com"]},
  addAccessorials: ["APD"],
  applyTo: "dest",
};
const lane = {
  consignee: {name: "Acme", city: "Dallas", state: "TX"},
  shipper: {},
  specialInstructions: "",
  flags: {},
  accessorials: [],
};
const outSender = quoteRules.applyRulesToLane(lane, [senderApd], {
  fromEmail: "mike.oseback@ediexpressinc.com",
});
checkTrue("sender+APD rule applies when From matches",
    outSender.accessorials.includes("APD") &&
    (outSender.appliedRules || []).some((r) =>
      r.ruleId === "sender_mike_add_apd"));

const outSenderMiss = quoteRules.applyRulesToLane(lane, [senderApd], {
  fromEmail: "other@example.com",
});
checkTrue("sender+APD rule skips when From does not match",
    !outSenderMiss.accessorials.includes("APD"));

checkTrue("sender+APD is not treated as pure sender skip",
    quoteRules.isPureSenderCustomerRule(senderApd) === false);
checkTrue("sender+APD wiring path is accessorial",
    quoteRules.analyzeRuleWiring(senderApd).wired === true &&
    quoteRules.analyzeRuleWiring(senderApd).enginePath === "accessorial");

// --- City / shipperAddress aliases ---
const cityLad = {
  id: "dallas_limited",
  active: true,
  priority: 40,
  name: "Dallas dest → LAD",
  identifyVia: "address_text",
  match: {consigneeCityContains: ["dallas"], consigneeState: "TX"},
  addAccessorials: ["LAD"],
  applyTo: "dest",
};
const outCity = quoteRules.applyRulesToLane(lane, [cityLad], {});
checkTrue("consigneeCityContains accessorial rule fires",
    outCity.accessorials.includes("LAD"));

const shipperAddr = {
  id: "origin_warehouse_liftgate",
  active: true,
  priority: 40,
  name: "Warehouse address → LFO",
  identifyVia: "address_text",
  applyTo: "origin",
  match: {shipperAddressContains: ["dock 9"]},
  addAccessorials: ["LFO"],
};
const outShip = quoteRules.applyRulesToLane({
  shipper: {name: "STG", address1: "100 Dock 9 Ave", city: "La Mirada"},
  consignee: {name: "Acme"},
  specialInstructions: "",
  flags: {},
  accessorials: [],
}, [shipperAddr], {});
checkTrue("shipperAddressContains origin rule fires",
    outShip.accessorials.includes("LFO"));

// --- Carrier note / clean still wired ---
checkTrue("Roadrunner note rule wiring",
    quoteRules.analyzeRuleWiring({
      id: "roadrunner_transit_delay_note",
      active: true,
      match: {carrierNameContains: ["roadrunner"]},
      notes: "has lots of delays in transit.",
      addAccessorials: [],
    }).enginePath === "carrier_note");

checkTrue("J&I clean rule wiring",
    quoteRules.analyzeRuleWiring({
      id: "clean_ji",
      active: true,
      ruleKind: "carrier_display_clean",
      match: {carrierNameContains: ["j&i", "j-i"]},
      notes: "omit the added J&I wording",
      addAccessorials: [],
    }).enginePath === "carrier_display_clean");

// --- Unwired Active rule produces warning ---
const phantom = {
  id: "phantom_foo",
  active: true,
  name: "Phantom unsupported match",
  match: {totallyFakeMatchField: ["x"]},
  addAccessorials: ["APD"],
};
const wiring = quoteRules.analyzeRuleWiring(phantom);
checkTrue("phantom match keys marked unwired",
    wiring.wired === false &&
    wiring.unknownMatchKeys.includes("totallyFakeMatchField"));

const warns = quoteRules.collectUnwiredActiveWarnings([phantom]);
checkTrue("Active unwired rule produces warning",
    warns.length === 1 && warns[0].ruleId === "phantom_foo");

const pureSender = {
  id: "sender_mike_oseback",
  active: true,
  ruleKind: "sender_customer",
  match: {fromEmails: ["mike.oseback@ediexpressinc.com"]},
  customerName: "Mike Oseback",
  addAccessorials: [],
};
checkTrue("pure sender rule is wired (intake path)",
    quoteRules.analyzeRuleWiring(pureSender).enginePath === "sender_customer");

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll quote-rules wiring tests passed.");
