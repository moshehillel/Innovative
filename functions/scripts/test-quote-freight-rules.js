/* eslint-disable no-console */
"use strict";

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

const checkTrue = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const shipA = {
  name: "WH A", address1: "100 Main", city: "Dallas", state: "TX",
  zipCode: "75201",
};
const consB = {
  name: "Store B", address1: "200 Oak", city: "Austin", state: "TX",
  zipCode: "78701",
};
const consC = {
  name: "Store C", address1: "300 Elm", city: "Houston", state: "TX",
  zipCode: "77001",
};

// --- countPallets ---
check("PLT qty", freightRules.countPallets([{qty: 10, dimType: "PLT"}]), 10);
check("pallet alias",
    freightRules.countPallets([{qty: 5, dimType: "pallet", weight: 100}]), 5);
check("ignore CTN",
    freightRules.countPallets([{qty: 40, dimType: "CTN", weight: 200}]), 0);
check("ambiguous single line → pallets",
    freightRules.countPallets([{qty: 30, weight: 3000}]), 30);
check("multi PLT sum", freightRules.countPallets([
  {qty: 10, dimType: "PLT"},
  {qty: 4, dimType: "skid"},
]), 14);

checkTrue("max default 26", freightRules.getMaxPalletsPerTrailer() === 26);

// --- split ---
{
  const lane = {
    laneKey: "AUS",
    label: "TO Austin, TX",
    shipper: shipA,
    consignee: consB,
    freightInfo: [{qty: 40, weight: 4000, class: "70", dimType: "PLT"}],
  };
  const {lanes, applied} = freightRules.splitLaneByPallets(lane, 26);
  check("split → 2 trailers", lanes.length, 2);
  check("trailer1 qty 26", lanes[0].freightInfo[0].qty, 26);
  check("trailer2 qty 14", lanes[1].freightInfo[0].qty, 14);
  check("weight1 proportional", lanes[0].freightInfo[0].weight, 2600);
  check("weight2 proportional", lanes[1].freightInfo[0].weight, 1400);
  checkTrue("split applied rules", applied.length === 2);
  checkTrue("label has Trailer 1",
      String(lanes[0].label).includes("Trailer 1 of 2"));
  checkTrue("laneKey T1", lanes[0].laneKey === "AUS_T1");
  checkTrue("laneKey T2", lanes[1].laneKey === "AUS_T2");
}

{
  const lane = {
    laneKey: "BIG",
    label: "TO Houston, TX",
    shipper: shipA,
    consignee: consC,
    freightInfo: [{qty: 60, weight: 6000, dimType: "PLT"}],
  };
  const {lanes} = freightRules.splitLaneByPallets(lane, 26);
  check("60 PLT → 3 trailers", lanes.length, 3);
  check("T3 qty 8", lanes[2].freightInfo[0].qty, 8);
}

{
  const lane = {
    laneKey: "OK",
    shipper: shipA,
    consignee: consB,
    freightInfo: [{qty: 20, weight: 2000, dimType: "PLT"}],
  };
  const {lanes} = freightRules.splitLaneByPallets(lane, 26);
  check("no split under max", lanes.length, 1);
}

// --- combine ---
{
  const lanes = [
    {
      laneKey: "A1",
      label: "TO Austin A",
      shipper: shipA,
      consignee: consB,
      freightInfo: [{qty: 10, weight: 1000, dimType: "PLT"}],
      referenceNumbers: ["PO-1"],
    },
    {
      laneKey: "A2",
      label: "TO Austin B",
      shipper: {...shipA},
      consignee: {...consB},
      freightInfo: [{qty: 12, weight: 1200, dimType: "PLT"}],
      referenceNumbers: ["PO-2"],
    },
  ];
  const {lanes: out, applied} = freightRules.combineSameOdLanes(lanes, 26);
  check("combine 10+12 → 1 lane", out.length, 1);
  check("combined pallet count",
      freightRules.countPallets(out[0].freightInfo), 22);
  checkTrue("combine note present",
      applied.length === 1 && /Combined 2 shipments/.test(applied[0].notes));
  checkTrue("refs merged",
      (out[0].referenceNumbers || []).includes("PO-1") &&
      (out[0].referenceNumbers || []).includes("PO-2"));
}

{
  const lanes = [
    {
      laneKey: "A1",
      shipper: shipA,
      consignee: consB,
      freightInfo: [{qty: 20, weight: 2000, dimType: "PLT"}],
    },
    {
      laneKey: "A2",
      shipper: shipA,
      consignee: consB,
      freightInfo: [{qty: 10, weight: 1000, dimType: "PLT"}],
    },
  ];
  const {lanes: out} = freightRules.combineSameOdLanes(lanes, 26);
  check("no combine when >26", out.length, 2);
}

{
  const lanes = [
    {
      laneKey: "A1",
      shipper: shipA,
      consignee: consB,
      freightInfo: [{qty: 5, weight: 500, dimType: "PLT"}],
    },
    {
      laneKey: "C1",
      shipper: shipA,
      consignee: consC,
      freightInfo: [{qty: 5, weight: 500, dimType: "PLT"}],
    },
  ];
  const {lanes: out} = freightRules.combineSameOdLanes(lanes, 26);
  check("no combine different OD", out.length, 2);
}

{
  const lanes = [
    {
      laneKey: "A1",
      label: "1 skid option",
      shipper: shipA,
      consignee: consB,
      freightInfo: [{qty: 1, weight: 2040, class: "65", dimType: "PLT"}],
      flags: {alternateQuantityQuote: true, doNotCombine: true},
    },
    {
      laneKey: "A2",
      label: "2 skid option",
      shipper: {...shipA},
      consignee: {...consB},
      freightInfo: [{qty: 2, weight: 3050, class: "70", dimType: "PLT"}],
      flags: {alternateQuantityQuote: true, doNotCombine: true},
    },
  ];
  const {lanes: out, applied} = freightRules.combineSameOdLanes(lanes, 26);
  check("alternate flags → no combine", out.length, 2);
  check("alternate no applied combine", applied.length, 0);
  check("lane1 qty stays 1",
      freightRules.countPallets(out[0].freightInfo), 1);
  check("lane2 qty stays 2",
      freightRules.countPallets(out[1].freightInfo), 2);
}

{
  const body =
    "Please quote 1 skid class 65 2040 lbs. " +
    "Then also quote 2 skids class 70 3050 lbs. 2 rates needed.";
  checkTrue("detect also quote / 2 rates needed",
      freightRules.isAlternateQuantityQuote(body));
  const extracted = {
    _sourceBody: body,
    shipper: shipA,
    lanes: [
      {
        laneKey: "OPT1",
        consignee: consB,
        freightInfo: [{qty: 1, weight: 2040, class: "65", dimType: "PLT"}],
      },
      {
        laneKey: "OPT2",
        consignee: consB,
        freightInfo: [{qty: 2, weight: 3050, class: "70", dimType: "PLT"}],
      },
    ],
  };
  const out = freightRules.applyFreightRules(extracted, {maxPallets: 26});
  check("e2e alternate keeps 2 lanes", out.lanes.length, 2);
  checkTrue("e2e alternate meta flag",
      !!(out.freightRulesMeta &&
        out.freightRulesMeta.alternateQuantityQuotes));
  checkTrue("e2e no combine rule",
      !(out.freightRulesMeta.appliedRules || [])
          .some((r) => r.ruleId === "combine_same_od"));
}

// --- applyFreightRules end-to-end ---
{
  const extracted = {
    shipper: shipA,
    lanes: [
      {
        laneKey: "L1",
        consignee: consB,
        freightInfo: [{qty: 10, weight: 1000, dimType: "PLT"}],
      },
      {
        laneKey: "L2",
        consignee: consB,
        freightInfo: [{qty: 8, weight: 800, dimType: "PLT"}],
      },
      {
        laneKey: "L3",
        consignee: consC,
        freightInfo: [{qty: 40, weight: 4000, dimType: "PLT"}],
      },
    ],
  };
  const out = freightRules.applyFreightRules(extracted, {maxPallets: 26});
  // L1+L2 combine → 1; L3 splits → 2; total 3
  check("e2e lane count", out.lanes.length, 3);
  checkTrue("e2e has combine meta",
      (out.freightRulesMeta.appliedRules || [])
          .some((r) => r.ruleId === "combine_same_od"));
  checkTrue("e2e has split meta",
      (out.freightRulesMeta.appliedRules || [])
          .some((r) => r.ruleId === "split_max_pallets"));
  const houston = out.lanes.filter((l) =>
    String(l.laneKey || "").startsWith("L3"));
  check("e2e houston trailers", houston.length, 2);
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll assertions passed");
