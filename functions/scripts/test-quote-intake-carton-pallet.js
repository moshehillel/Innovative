/* eslint-disable no-console */
"use strict";

const intake = require("../quote-intake");
const freightRules = require("../quote-freight-rules");

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

const D8986_BODY = [
  "Total Cartons – 35",
  "Total weight – 137",
  "Number of Pallet -1",
  "Pallet dimensions – 48*40*28",
].join("\n");

const labeled = intake.parseLabeledFreightTotals(D8986_BODY);
check("labeled cartonCount 35", labeled.cartonCount, 35);
check("labeled palletCount 1", labeled.palletCount, 1);
check("labeled weight 137", labeled.weight, 137);
check("labeled length 48", labeled.length, 48);
check("labeled width 40", labeled.width, 40);
check("labeled height 28", labeled.height, 28);

const aiWrong = {
  lanes: [{
    laneKey: "NN_VA",
    freightInfo: [{
      qty: 35,
      weight: 137,
      dimType: "PLT",
      length: 48,
      width: 40,
      height: 28,
    }],
    flags: {suspiciousPalletCount: true},
  }],
};
intake.correctCartonVsPalletFreight(aiWrong, D8986_BODY);
check("AI 35 PLT → qty 1", aiWrong.lanes[0].freightInfo[0].qty, 1);
check("AI 35 PLT → dimType PLT",
    aiWrong.lanes[0].freightInfo[0].dimType, "PLT");
check("AI 35 PLT → weight 137",
    aiWrong.lanes[0].freightInfo[0].weight, 137);
check("AI 48x40 → 40x48", [
  aiWrong.lanes[0].freightInfo[0].length,
  aiWrong.lanes[0].freightInfo[0].width,
  aiWrong.lanes[0].freightInfo[0].height,
], [40, 48, 28]);
check("AI total weight → weightType total",
    aiWrong.lanes[0].freightInfo[0].weightType, "total");

const heuristicBody = [
  "Pickup Location:",
  "Weida Freight System",
  "9050 Hermosa Ave",
  "Rancho Cucamonga, CA 91730",
  "Shipping To:",
  "AAFES DDDC Newport News",
  "123 Warehouse Rd",
  "Newport News, VA 23602",
  "Special Instructions: none",
  "Sales Order #: SO-1",
  D8986_BODY,
].join("\n");
const heuristic = intake.heuristicExtractQuote({
  subject: "RFQ",
  body: heuristicBody,
});
check("heuristic qty 1 not 35",
    heuristic && heuristic.lanes[0].freightInfo[0].qty, 1);
check("heuristic dimType PLT",
    heuristic && heuristic.lanes[0].freightInfo[0].dimType, "PLT");
check("heuristic weight 137",
    heuristic && heuristic.lanes[0].freightInfo[0].weight, 137);
check("heuristic dims 40x48x28 not 48x40", [
  heuristic && heuristic.lanes[0].freightInfo[0].length,
  heuristic && heuristic.lanes[0].freightInfo[0].width,
  heuristic && heuristic.lanes[0].freightInfo[0].height,
], [40, 48, 28]);
check("heuristic weightType total",
    heuristic && heuristic.lanes[0].freightInfo[0].weightType, "total");

const extracted = {
  shipper: {
    name: "Weida",
    address1: "9050 Hermosa Ave",
    city: "Rancho Cucamonga",
    state: "CA",
    zipCode: "91730",
  },
  lanes: [{
    laneKey: "NN_VA",
    consignee: {
      name: "AAFES",
      city: "Newport News",
      state: "VA",
      zipCode: "23602",
    },
    freightInfo: [{qty: 35, weight: 137, dimType: "PLT"}],
  }],
};
intake.correctCartonVsPalletFreight(extracted, D8986_BODY);
const ruled = freightRules.applyFreightRules(extracted);
check("no 26-cap split after carton fix", ruled.lanes.length, 1);
check("ruled qty still 1 pallet",
    ruled.lanes[0].freightInfo[0].qty, 1);

check("infer total weight",
    intake.inferWeightTypeFromBody("Total weight – 2000"), "total");
check("infer each pallet",
    intake.inferWeightTypeFromBody("weight per pallet 500"), "each");
check("total wins over each",
    intake.inferWeightTypeFromBody(
        "4 pallets, weight per pallet, Total weight – 2000"), "total");

const missingDims = {
  lanes: [{
    freightInfo: [{
      qty: 4, weight: 2000, dimType: "PLT", weightType: "each",
    }],
  }],
};
intake.normalizeFreightOnExtract(missingDims, "Total weight – 2000");
check("missing pallet dims → 40x48x60", [
  missingDims.lanes[0].freightInfo[0].length,
  missingDims.lanes[0].freightInfo[0].width,
  missingDims.lanes[0].freightInfo[0].height,
], [40, 48, 60]);
check("total-weight email forces weightType total",
    missingDims.lanes[0].freightInfo[0].weightType, "total");

const explicit = {
  lanes: [{
    freightInfo: [{
      qty: 1, weight: 400, length: 42, width: 36, height: 30, dimType: "PLT",
    }],
  }],
};
intake.normalizeFreightOnExtract(explicit, "1 pallet 42x36x30");
check("explicit non-standard dims kept", [
  explicit.lanes[0].freightInfo[0].length,
  explicit.lanes[0].freightInfo[0].width,
  explicit.lanes[0].freightInfo[0].height,
], [42, 36, 30]);

const cartons = {
  lanes: [{
    freightInfo: [{qty: 10, weight: 100, dimType: "CTN"}],
  }],
};
intake.normalizeFreightOnExtract(cartons, "10 cartons");
check("cartons do not get pallet defaults", [
  cartons.lanes[0].freightInfo[0].length || null,
  cartons.lanes[0].freightInfo[0].width || null,
  cartons.lanes[0].freightInfo[0].height || null,
], [null, null, null]);

const stripped = {
  lanes: [{
    freightInfo: [{
      qty: 19, weight: 814605, dimType: "PLT", weightType: "each",
    }],
  }],
};
intake.normalizeFreightOnExtract(stripped, "Total weight – 8146");
check("stripped decimals 814605 → 8146.05",
    stripped.lanes[0].freightInfo[0].weight, 8146.05);
check("stripped weight still total",
    stripped.lanes[0].freightInfo[0].weightType, "total");

const D9338_BODY = [
  "From: Alrossa Warehouse <warehouse@alrossa.com>",
  "Subject: pls qout to 90723 and 11216",
  "",
  "EvoBox",
  "5020 W 2700 N",
  "Lehi, UT 84045",
  "Dock 4",
  "Mon-Fri 8:30am - 4:30pm",
  "No Appointment necessary",
  "",
  "Pallet 1",
  "40x48x70",
  "1822 lbs",
  "",
  "Pallet 2",
  "40x48x66",
  "1702 lbs",
].join("\n");

const d9338Blocks = intake.extractCompactPalletBlocks(D9338_BODY);
check("D9338 compact Pallet 1+2", d9338Blocks.map((r) => ({
  qty: r.qty, weight: r.weight, length: r.length, width: r.width,
  height: r.height, dimType: r.dimType,
})), [
  {qty: 1, weight: 1822, length: 40, width: 48, height: 70, dimType: "PLT"},
  {qty: 1, weight: 1702, length: 40, width: 48, height: 66, dimType: "PLT"},
]);
check("D9338 labeled palletCount 2 not 1",
    intake.parseLabeledFreightTotals(D9338_BODY).palletCount, 2);

const d9338Split = {
  lanes: [
    {
      laneKey: "90723",
      consignee: {zipCode: "90723", city: "Paramount", state: "CA"},
      freightInfo: [{
        qty: 1, weight: 1822, length: 40, width: 48, height: 70,
        dimType: "PLT",
      }],
    },
    {
      laneKey: "11216",
      consignee: {zipCode: "11216", city: "Brooklyn", state: "NY"},
      freightInfo: [{
        qty: 1, weight: 1702, length: 40, width: 48, height: 66,
        dimType: "PLT",
      }],
    },
  ],
};
intake.applyEmailPalletBlocks(d9338Split, {
  subject: "FW: pls qout to 90723 and 11216",
  body: D9338_BODY,
});
check("D9338 dest 90723 gets both pallets",
    d9338Split.lanes[0].freightInfo.map((r) => r.weight), [1822, 1702]);
check("D9338 dest 11216 gets both pallets",
    d9338Split.lanes[1].freightInfo.map((r) => r.weight), [1822, 1702]);

const assigned = {
  lanes: [
    {
      consignee: {zipCode: "90723"},
      freightInfo: [{qty: 1, weight: 1822, dimType: "PLT"}],
    },
    {
      consignee: {zipCode: "11216"},
      freightInfo: [{qty: 1, weight: 1702, dimType: "PLT"}],
    },
  ],
};
intake.applyEmailPalletBlocks(assigned, {
  subject: "RFQ",
  body: "Pallet 1 to 90723\n40x48x70\n1822 lbs\nPallet 2 to 11216\n" +
    "40x48x66\n1702 lbs",
});
check("assigned Pallet 1 stays on 90723",
    assigned.lanes[0].freightInfo.map((r) => r.weight), [1822]);
check("assigned Pallet 2 stays on 11216",
    assigned.lanes[1].freightInfo.map((r) => r.weight), [1702]);

const twoPalletsPhrase = {
  lanes: [{
    freightInfo: [{qty: 1, weight: 2000, dimType: "PLT"}],
  }],
};
intake.applyEmailPalletBlocks(twoPalletsPhrase, "please quote 2 pallets");
check("2 pallets phrase does not collapse to 1",
    twoPalletsPhrase.lanes[0].freightInfo[0].qty, 2);

const normalized = intake.normalizeExtractedQuote({
  lanes: [{
    laneKey: "NN_VA",
    freightInfo: [{
      qty: 35, weight: 137, dimType: "PLT", length: 48, width: 40, height: 28,
    }],
  }],
}, {subject: "RFQ", body: D8986_BODY});
check("normalizeExtractedQuote qty 1 not 35",
    normalized.lanes[0].freightInfo[0].qty, 1);
check("normalizeExtractedQuote 40x48", [
  normalized.lanes[0].freightInfo[0].length,
  normalized.lanes[0].freightInfo[0].width,
], [40, 48]);
check("normalizeExtractedQuote weightType total",
    normalized.lanes[0].freightInfo[0].weightType, "total");
check("normalizeExtractedQuote defaulted dims warning absent when dims given",
    (normalized.extractionWarnings || []).includes("defaulted dims"), false);

const missingNorm = intake.normalizeExtractedQuote({
  lanes: [{freightInfo: [{qty: 2, weight: 400, dimType: "PLT"}]}],
}, {body: "2 pallets total weight 400"});
check("normalizeExtractedQuote defaults 40x48x60", [
  missingNorm.lanes[0].freightInfo[0].length,
  missingNorm.lanes[0].freightInfo[0].width,
  missingNorm.lanes[0].freightInfo[0].height,
], [40, 48, 60]);
check("normalizeExtractedQuote warns defaulted dims",
    (missingNorm.extractionWarnings || []).includes("defaulted dims"), true);

const noApptNorm = intake.normalizeExtractedQuote({
  lanes: [{
    specialInstructions: "No Appointment necessary",
    freightInfo: [{qty: 1, weight: 100, dimType: "PLT"}],
  }],
  customerRequest: {requestedAccessorials: ["APD"]},
}, {subject: "RFQ", body: "No Appointment necessary"});
check("normalizeExtractedQuote strips APD warning",
    (noApptNorm.extractionWarnings || [])
        .includes("stripped APD: customer said no appt"), true);
check("normalizeExtractedQuote declined APD persisted",
    (noApptNorm.customerDeclinedAccessorials || []).includes("APD"), true);
check("normalizeExtractedQuote requestedAccessorials no APD",
    !(noApptNorm.customerRequest.requestedAccessorials || []).includes("APD"),
    true);

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nAll carton-vs-pallet checks passed");
