/* eslint-disable no-console */
"use strict";

const quoteRules = require("../quote-accessorial-rules");
const addressEnrichment = require("../quote-address-enrichment");

let failures = 0;

/**
 * @param {string} name Check name.
 * @param {*} got Actual.
 * @param {*} exp Expected.
 * @return {void}
 */
function check(name, got, exp) {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) {
    console.log(`  got: ${JSON.stringify(got)}`);
    console.log(`  exp: ${JSON.stringify(exp)}`);
  }
}

/**
 * @param {string} name Check name.
 * @param {Array<string>} arr Codes.
 * @param {string} code Expected code.
 * @return {void}
 */
function checkHas(name, arr, code) {
  const pass = Array.isArray(arr) && arr.includes(code);
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) console.log(`  missing ${code} in ${JSON.stringify(arr)}`);
}

/**
 * @param {string} name Check name.
 * @param {Array<string>} arr Codes.
 * @param {string} code Forbidden code.
 * @return {void}
 */
function checkNotHas(name, arr, code) {
  const pass = Array.isArray(arr) && !arr.includes(code);
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) {
    console.log(`  unexpectedly has ${code} in ${JSON.stringify(arr)}`);
  }
}

const rules = quoteRules.DEFAULT_RULES.map((r) => ({...r, active: true}));

const d8986 = {
  shipper: {
    name: "Weida Freight System",
    address1: "9050 Hermosa Ave",
    city: "Rancho Cucamonga",
    state: "CA",
    zipCode: "91730",
  },
  consignee: {
    name: "AAFES DDDC Newport News",
    address1: "123 Warehouse Rd",
    city: "Newport News",
    state: "VA",
    zipCode: "23602",
  },
  flags: {},
  siteType: "aafes_military",
  originSiteType: "other",
  enrichmentMeta: {
    classifiedAs: "aafes_military",
    source: "name_heuristic",
    side: "dest",
  },
  originEnrichmentMeta: {
    classifiedAs: "other",
    source: "name_heuristic",
    side: "origin",
    placeName: "Weida warehouse",
  },
};

const outD8986 = quoteRules.applyRulesToLane(d8986, rules, {});
checkHas("D8986 dest military → LAD", outD8986.accessorials, "LAD");
checkHas("D8986 dest military → APD", outD8986.accessorials, "APD");
checkNotHas("D8986 warehouse origin not LAO", outD8986.accessorials, "LAO");
checkNotHas("D8986 warehouse origin not RSO", outD8986.accessorials, "RSO");
checkNotHas("D8986 dest military not remapped to APO",
    outD8986.accessorials, "APO");
const destMilitary = (outD8986.appliedRules || [])
    .filter((r) => r.ruleId === "aafes_military");
check("D8986 military rule dest-only",
    destMilitary.every((r) => r.applyTo === "dest"), true);
check("D8986 no origin military pickup rule",
    (outD8986.appliedRules || [])
        .some((r) => r.ruleId === "aafes_military_pickup"),
    false);

const originMilitary = {
  shipper: {name: "Fort Liberty AAFES", city: "Fort Liberty", state: "NC"},
  consignee: {name: "Acme Warehouse", city: "Dallas", state: "TX"},
  flags: {},
  originSiteType: "aafes_military",
  siteType: "other",
  originEnrichmentMeta: {
    classifiedAs: "aafes_military",
    source: "name_heuristic",
    side: "origin",
  },
  enrichmentMeta: {
    classifiedAs: "other",
    source: "default",
    side: "dest",
  },
};
const outOriginMil = quoteRules.applyRulesToLane(originMilitary, rules, {});
checkHas("origin military → LAO", outOriginMil.accessorials, "LAO");
checkNotHas("origin military not LAD", outOriginMil.accessorials, "LAD");
checkNotHas("origin military not APD", outOriginMil.accessorials, "APD");

const destAmazon = {
  shipper: {name: "Weida warehouse", city: "Rancho Cucamonga", state: "CA"},
  consignee: {name: "Amazon FBA HGR6", city: "Hagerstown", state: "MD"},
  flags: {},
  siteType: "amazon_fc",
  originSiteType: "other",
  enrichmentMeta: {classifiedAs: "amazon_fc", source: "name_heuristic"},
  originEnrichmentMeta: {classifiedAs: "other", source: "name_heuristic"},
};
const outAmz = quoteRules.applyRulesToLane(destAmazon, rules, {});
checkHas("dest Amazon → APD", outAmz.accessorials, "APD");
checkNotHas("dest Amazon origin warehouse not APO",
    outAmz.accessorials, "APO");

const originAmazon = {
  shipper: {name: "Amazon FC", city: "Phoenix", state: "AZ"},
  consignee: {name: "Retail Store", city: "Dallas", state: "TX"},
  flags: {},
  originSiteType: "amazon_fc",
  siteType: "other",
  originEnrichmentMeta: {classifiedAs: "amazon_fc", source: "name_heuristic"},
  enrichmentMeta: {classifiedAs: "other", source: "default"},
};
const outOriginAmz = quoteRules.applyRulesToLane(originAmazon, rules, {});
checkNotHas("origin Amazon does not get dest APD",
    outOriginAmz.accessorials, "APD");
checkNotHas("origin Amazon does not auto APO",
    outOriginAmz.accessorials, "APO");

const noApptLane = {
  consignee: {name: "Warehouse", city: "Paramount", state: "CA"},
  shipper: {name: "EvoBox", city: "Lehi", state: "UT"},
  specialInstructions: "No Appointment necessary",
  flags: {},
  siteType: "other",
};
const outNoAppt = quoteRules.applyRulesToLane(noApptLane, rules, {
  specialInstructionsGlobal: "No Appointment necessary",
});
checkNotHas("no appointment necessary does not add APD",
    outNoAppt.accessorials, "APD");

const amzNoAppt = {
  ...destAmazon,
  specialInstructions: "appointment not required",
};
const outAmzNoAppt = quoteRules.applyRulesToLane(amzNoAppt, rules, {
  specialInstructionsGlobal: "appointment not required",
});
checkNotHas("Amazon dest + no appt still no APD",
    outAmzNoAppt.accessorials, "APD");
check("Amazon dest + no appt records suppress",
    (outAmzNoAppt.appliedRules || [])
        .some((r) => r.ruleId === "email_no_appointment"), true);

const destChain = {
  consignee: {
    name: "ALBERTSONS LLC / SAFEWAY INC",
    city: "Auburn",
    state: "WA",
    zipCode: "98047",
  },
  shipper: {name: "STG", city: "Santa Fe Springs", state: "CA"},
  flags: {},
  siteType: "chain_store",
  enrichmentMeta: {classifiedAs: "chain_store", source: "name_heuristic"},
};
const outChain = quoteRules.applyRulesToLane(destChain, rules, {});
checkHas("dest Albertsons/Safeway → APD", outChain.accessorials, "APD");
check("chain rule applied",
    (outChain.appliedRules || [])
        .some((r) => r.ruleId === "chain_store_appointment"), true);

const chainNoAppt = {
  ...destChain,
  specialInstructions: "no appt needed",
};
const outChainNoAppt = quoteRules.applyRulesToLane(chainNoAppt, rules, {
  specialInstructionsGlobal: "no appt needed",
});
checkNotHas("chain + no appt strips APD", outChainNoAppt.accessorials, "APD");

const walmartH = addressEnrichment.classifyFromNameHeuristics({
  name: "Walmart Supercenter #1234",
});
check("Walmart heuristic chain_store",
    walmartH && walmartH.siteType, "chain_store");
const tjH = addressEnrichment.classifyFromNameHeuristics({
  name: "TJ Maxx Store",
});
check("TJ Maxx heuristic chain_store",
    tjH && tjH.siteType, "chain_store");

const milNoAppt = {
  ...d8986,
  specialInstructions: "No Appointment necessary",
};
const outMilNoAppt = quoteRules.applyRulesToLane(milNoAppt, rules, {
  specialInstructionsGlobal: "No Appointment necessary",
});
checkHas("military + no appt still LAD", outMilNoAppt.accessorials, "LAD");
checkNotHas("military + no appt strips APD", outMilNoAppt.accessorials, "APD");

const milNoLift = {
  ...d8986,
  specialInstructions: "no liftgate needed",
};
const outMilNoLift = quoteRules.applyRulesToLane(milNoLift, rules, {
  specialInstructionsGlobal: "no liftgate needed",
});
checkHas("military + no liftgate still LAD", outMilNoLift.accessorials, "LAD");
checkHas("military + no liftgate still APD", outMilNoLift.accessorials, "APD");
checkNotHas("military + no liftgate no LFD", outMilNoLift.accessorials, "LFD");

const destRes = {
  consignee: {name: "Jane Doe", city: "Austin", state: "TX"},
  shipper: {name: "Weida warehouse", city: "Rancho Cucamonga", state: "CA"},
  flags: {residentialDelivery: true},
  siteType: "residential",
  originSiteType: "other",
  enrichmentMeta: {classifiedAs: "residential", source: "name_heuristic"},
  originEnrichmentMeta: {classifiedAs: "other", source: "name_heuristic"},
};
const outDestRes = quoteRules.applyRulesToLane(destRes, rules, {});
checkHas("dest residential → RSD", outDestRes.accessorials, "RSD");
checkNotHas("dest residential not RSO", outDestRes.accessorials, "RSO");

const originRes = {
  shipper: {name: "Private residence", city: "Austin", state: "TX"},
  consignee: {name: "Acme DC", city: "Dallas", state: "TX"},
  flags: {residentialPickup: true},
  originSiteType: "residential",
  siteType: "other",
  originEnrichmentMeta: {classifiedAs: "residential", source: "name_heuristic"},
  enrichmentMeta: {classifiedAs: "other", source: "default"},
};
const outOriginRes = quoteRules.applyRulesToLane(originRes, rules, {});
checkHas("origin residential → RSO", outOriginRes.accessorials, "RSO");
checkNotHas("origin residential not RSD", outOriginRes.accessorials, "RSD");

const bothRes = {
  shipper: {name: "Private residence", city: "Austin", state: "TX"},
  consignee: {name: "Home delivery", city: "Dallas", state: "TX"},
  flags: {residentialPickup: true, residentialDelivery: true},
  originSiteType: "residential",
  siteType: "residential",
  originEnrichmentMeta: {classifiedAs: "residential", source: "ai"},
  enrichmentMeta: {classifiedAs: "residential", source: "ai"},
};
const outBoth = quoteRules.applyRulesToLane(bothRes, rules, {});
checkHas("both residential → RSO", outBoth.accessorials, "RSO");
checkHas("both residential → RSD", outBoth.accessorials, "RSD");

check("remap RSD → RSO",
    quoteRules.accessorialsForSide(["RSD", "LAD"], "origin").sort(),
    ["LAO", "RSO"].sort());
check("dest side keeps dest codes",
    quoteRules.accessorialsForSide(["RSD", "LAD"], "dest").sort(),
    ["LAD", "RSD"].sort());

const destLane = {flags: {}, consignee: {name: "Home"}};
addressEnrichment.mergeClassificationOntoLane(destLane, {
  siteType: "residential",
  residentialDelivery: true,
  source: "name_heuristic",
  confidence: 0.9,
  placeName: "Residence",
  addressKey: "1 main|austin|tx",
});
check("dest merge siteType", destLane.siteType, "residential");
check("dest merge RSD flag", destLane.flags.residentialDelivery, true);
check("dest merge not origin", destLane.originSiteType, undefined);

const originLane = {flags: {}, shipper: {name: "Home"}};
addressEnrichment.mergeClassificationOntoLane(originLane, {
  siteType: "residential",
  residentialDelivery: true,
  source: "name_heuristic",
  confidence: 0.9,
  placeName: "Residence",
  addressKey: "1 main|austin|tx",
}, {side: "origin"});
check("origin merge originSiteType", originLane.originSiteType, "residential");
check("origin merge RSO flag", originLane.flags.residentialPickup, true);
check("origin merge does not set dest siteType", originLane.siteType,
    undefined);
check("origin merge does not set dest RSD",
    !!originLane.flags.residentialDelivery, false);
check("origin meta side", originLane.originEnrichmentMeta.side, "origin");

const weida = addressEnrichment.classifyFromNameHeuristics({
  name: "Weida Freight System warehouse",
  address1: "9050 Hermosa Ave",
  city: "Rancho Cucamonga",
  state: "CA",
});
check("Weida warehouse heuristic not residential",
    weida && weida.residentialDelivery, false);
check("Weida warehouse heuristic not military",
    weida && weida.siteType !== "aafes_military", true);

const aafes = addressEnrichment.classifyFromNameHeuristics({
  name: "AAFES DDDC Newport News",
  city: "Newport News",
  state: "VA",
});
check("AAFES dest heuristic military", aafes && aafes.siteType,
    "aafes_military");

const nexDc = addressEnrichment.classifyFromNameHeuristics({
  name: "NEX NE DC Suffolk",
  address1: "1000 Kenyon Court",
  city: "Suffolk",
  state: "VA",
});
check("NEX DC heuristic military", nexDc && nexDc.siteType, "aafes_military");

const wcRetail = addressEnrichment.classifyFromNameHeuristics({
  name: "WC Retail Dist Ctr",
  address1: "4250 EUCALYPTUS AVE",
  city: "CHINO",
  state: "CA",
});
check("WC Retail Dist Ctr heuristic military",
    wcRetail && wcRetail.siteType, "aafes_military");

// Email mislabeled chain_store; enrichment says aafes — do not apply
// chain_store_appointment from the conflicting email siteType.
const conflictChainVsAafes = {
  consignee: {
    name: "WC Retail Dist Ctr",
    city: "CHINO",
    state: "CA",
    zipCode: "91710",
  },
  shipper: {name: "Weida Freight System"},
  flags: {},
  siteType: "aafes_military",
  enrichmentMeta: {
    classifiedAs: "aafes_military",
    emailSiteType: "chain_store",
    source: "name_heuristic",
    side: "dest",
  },
};
const outConflict = quoteRules.applyRulesToLane(conflictChainVsAafes, rules, {});
checkHas("conflict email chain vs aafes → APD", outConflict.accessorials, "APD");
checkHas("conflict email chain vs aafes → LAD", outConflict.accessorials, "LAD");
check("conflict skips chain_store rule",
    !(outConflict.appliedRules || [])
        .some((r) => r.ruleId === "chain_store_appointment"), true);
check("conflict applies aafes rule",
    (outConflict.appliedRules || [])
        .some((r) => r.ruleId === "aafes_military"), true);

const laMiradaShipper = {
  name: "STG",
  city: "La Mirada",
  state: "CA",
  zipCode: "90638",
};
const laMiradaFixed = addressEnrichment.applyKnownWarehouseZipOverride(
    laMiradaShipper, {});
check("La Mirada warehouse override → 90670",
    laMiradaFixed && laMiradaFixed.zipCode, "90670");

const laMiradaRule = quoteRules.DEFAULT_RULES.find(
    (r) => r.id === "zip_fill_la_mirada_stg");
const laMiradaLane = {
  shipper: {name: "STG", city: "La Mirada", state: "CA", zipCode: "90638"},
  consignee: {name: "Lidl US", city: "Mebane", state: "NC", zipCode: "27302"},
};
if (laMiradaRule) {
  quoteRules.applyZipFillRules(laMiradaLane, [laMiradaRule], laMiradaLane);
  check("zip fill rule overrides La Mirada 90638",
      laMiradaLane.shipper.zipCode, "90670");
}

const brumisScopedRule = {
  ...laMiradaRule,
  customerName: "Brumis Imports Inc",
  identifyVia: "both",
};
const brumisLane = {
  shipper: {name: "STG", city: "La Mirada", state: "CA", zipCode: "90638"},
  consignee: {name: "Lidl US", city: "Mebane", state: "NC", zipCode: "27302"},
};
if (brumisScopedRule) {
  quoteRules.applyZipFillRules(
      brumisLane, [brumisScopedRule], brumisLane,
      {customerName: "Brumis Imports Inc"});
  check("zip fill with Brumis customer applies",
      brumisLane.shipper.zipCode, "90670");
  const otherCustLane = {
    shipper: {name: "STG", city: "La Mirada", state: "CA", zipCode: "90638"},
    consignee: {name: "Other", city: "Mebane", state: "NC", zipCode: "27302"},
  };
  quoteRules.applyZipFillRules(
      otherCustLane, [brumisScopedRule], otherCustLane,
      {customerName: "Other Customer LLC"});
  check("zip fill with Brumis customer skips other customer",
      otherCustLane.shipper.zipCode, "90638");
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nAll origin/dest enrichment rule checks passed");
