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

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nAll carton-vs-pallet checks passed");
