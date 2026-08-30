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

const D7365_BODY = [
  "Shipment 1:",
  "",
  "BJS WHOLESALES CLUB 0800",
  "869 QUAKER HWY",
  "UXBRIDGE MA 015692252 US",
  "",
  "PO# 117785611//PT# 2354258",
  "52ctns - 2pallets",
  "48*40*54 - 27ctns - 923lbs (canned air)",
  "48*45*39 - 25ctns - 262lbs (charging cables)",
  "1185lbs",
  "",
  "Shipment 2:",
  "",
  "BJS WHOLESALES CLUB 0820",
  "BURLINGTON NJ 08016 US",
  "",
  "PO# 117785717//PT# 2354259",
  "97ctns - 4pallets",
  "48*40*54 - 30ctns - 1020lbs",
  "48*41*39 - 26ctns - 276lbs",
  "48*40*44 - 18ctns - 464lbs",
  "48*41*39 - 23ctns - 241lbs",
  "2001lbs",
].join("\n");

const d7365Sections = intake.extractNumberedShipmentSections(D7365_BODY);
check("D7365 two shipment sections", d7365Sections.length, 2);
const d7365TypoBody = D7365_BODY.replace(
    "48*41*39 - 23ctns - 241lbs",
    "48*41*39 - 23ctns - 241ctns (charging cables)");
check("D7365 typo 241ctns parsed",
    intake.extractNumberedShipmentSections(d7365TypoBody)[1].blocks.map((r) => r.weight),
    [1020, 276, 464, 241]);
check("D7365 shipment 1 zip", d7365Sections[0].zip, "01569");
check("D7365 shipment 2 zip", d7365Sections[1].zip, "08016");
check("D7365 shipment 1 blocks", d7365Sections[0].blocks.map((r) => r.weight),
    [923, 262]);
check("D7365 shipment 2 blocks", d7365Sections[1].blocks.map((r) => r.weight),
    [1020, 276, 464, 241]);

const d7365Split = {
  lanes: [
    {
      laneKey: "BJS_UXBRIDGE_MA",
      consignee: {city: "UXBRIDGE", state: "MA", zipCode: "01569"},
      freightInfo: [{qty: 1, weight: 923, dimType: "PLT"}],
    },
    {
      laneKey: "BJS_BURLINGTON_NJ",
      consignee: {city: "BURLINGTON", state: "NJ", zipCode: "08016"},
      freightInfo: [{qty: 1, weight: 1020, dimType: "PLT"}],
    },
  ],
};
intake.applyEmailPalletBlocks(d7365Split, {body: D7365_BODY});
const d7365Lane1Qty = d7365Split.lanes[0].freightInfo
    .reduce((s, r) => s + (Number(r.qty) || 0), 0);
const d7365Lane2Qty = d7365Split.lanes[1].freightInfo
    .reduce((s, r) => s + (Number(r.qty) || 0), 0);
check("D7365 lane1 pallet count 2", d7365Lane1Qty, 2);
check("D7365 lane2 pallet count 4", d7365Lane2Qty, 4);
check("D7365 lane1 weights", d7365Split.lanes[0].freightInfo.map((r) => r.weight),
    [923, 262]);
check("D7365 lane2 weights", d7365Split.lanes[1].freightInfo.map((r) => r.weight),
    [1020, 276, 464, 241]);

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

const altBody =
  "Please quote 1 skid class 65 2040 lbs 48x48x65. " +
  "Then also quote 2 skids class 70 3050 lbs. 2 rates needed.";
check("parseInformalPalletCount null on alternate qty RFQ",
    intake.parseInformalPalletCount(altBody), null);
check("parseInformalPalletCount still reads plain 2 pallets",
    intake.parseInformalPalletCount("Need rates for 2 pallets to Dallas"),
    2);

const altNorm = intake.normalizeExtractedQuote({
  shipper: {name: "WH", city: "Edison", state: "NJ", zipCode: "08817"},
  lanes: [
    {
      laneKey: "OPT1",
      consignee: {city: "Baxter", state: "MN", zipCode: "56425"},
      freightInfo: [{qty: 1, weight: 2040, class: "65", dimType: "PLT"}],
    },
    {
      laneKey: "OPT2",
      consignee: {city: "Baxter", state: "MN", zipCode: "56425"},
      freightInfo: [{qty: 2, weight: 3050, class: "70", dimType: "PLT"}],
    },
  ],
}, {subject: "RFQ", body: altBody});
check("normalize stamps alternateQuantityQuotes",
    !!(altNorm.flags && altNorm.flags.alternateQuantityQuotes), true);
check("normalize stamps lane doNotCombine",
    !!(altNorm.lanes[0].flags && altNorm.lanes[0].flags.doNotCombine), true);

// Q#D6062: WEIGHT- 139\nPallets- 1 must not become 139 PLT (→ 6 trailers).
const D6062_BODY = [
  "Ship To:",
  "",
  "Shipment 1:",
  "",
  "SE Retail Dist Ctr",
  "BLDG 781 PAGE ROAD",
  "PENSACOLA FL 32508 US",
  "",
  "PO# 0038255607//PT# 2353976",
  "Total Cartons – 28",
  "Total Weight – 129",
  "1 pallet – 48x40x15",
  "",
  "PO# 0038267626//PT# 2354719",
  "CTNS- 28",
  "WEIGHT- 139",
  "Pallets- 1",
  "48x40x15",
  "",
  "Shipment 2:",
  "",
  "WC Retail Dist Ctr",
  "4250 EUCALYPTUS AVE",
  "CHINO CA 917109704 US",
  "",
  "PO# 0038255612//PT# 2353978",
  "Total Cartons – 18",
  "Total Weight – 101",
  "1 pallet – 48x40x10",
].join("\n");

check("D6062 informal ignores WEIGHT\\nPallets",
    intake.parseInformalPalletCount(D6062_BODY), 1);
check("D6062 labeled Pallets- 1",
    intake.parseLabeledFreightTotals(
        "CTNS- 28\nWEIGHT- 139\nPallets- 1\n48x40x15").palletCount,
    1);
check("D6062 labeled does not read dim 48 as pallets",
    intake.parseLabeledFreightTotals("1 pallet – 48x40x15").palletCount,
    1);

const d6062Extracted = {
  shipper: {
    name: "DCG FULFILLMENT REDLANDS",
    city: "REDLANDS", state: "CA", zipCode: "92374",
  },
  lanes: [
    {
      consignee: {
        name: "SE Retail Dist Ctr",
        city: "PENSACOLA", state: "FL", zipCode: "32508",
      },
      freightInfo: [
        {qty: 1, weight: 129, dimType: "PLT", length: 48, width: 40, height: 15},
        {qty: 1, weight: 139, dimType: "PLT", length: 48, width: 40, height: 15},
      ],
      flags: {},
      specialInstructions: "Total Cartons – 28",
    },
    {
      consignee: {
        name: "WC Retail Dist Ctr",
        city: "CHINO", state: "CA", zipCode: "91710",
      },
      // Simulate under-count that applyEmailPalletBlocks used to inflate
      // from WEIGHT-139\\nPallets via informal max.
      freightInfo: [
        {qty: 1, weight: 101, dimType: "PLT", length: 48, width: 40, height: 10},
      ],
      flags: {},
      specialInstructions: "Total Cartons – 18",
    },
  ],
};
const d6062Norm = intake.normalizeExtractedQuote(d6062Extracted, {
  subject: "LFW-NEXCOM WEST COAST",
  body: D6062_BODY,
});
const d6062Chino = (d6062Norm.lanes || []).find((l) =>
  /chino/i.test(String((l.consignee && l.consignee.city) || "")));
const d6062ChinoQty = (d6062Chino && d6062Chino.freightInfo || [])
    .reduce((s, r) => s + (Number(r.qty) || 0), 0);
check("D6062 normalize Chino stays 1 PLT", d6062ChinoQty, 1);

const d6062Ruled = freightRules.applyFreightRules(d6062Norm, {maxPallets: 26});
const d6062ChinoLanes = (d6062Ruled.lanes || []).filter((l) =>
  /chino/i.test(JSON.stringify(l.consignee || {})));
check("D6062 freight rules no Chino trailer split",
    d6062ChinoLanes.length, 1);
check("D6062 Chino ruled qty 1",
    freightRules.countPallets(d6062ChinoLanes[0].freightInfo), 1);

// applyEmailPalletBlocks must not promote WEIGHT\\nPallets into qty.
const bleed = {
  lanes: [{
    consignee: {city: "CHINO", state: "CA", zipCode: "91710"},
    freightInfo: [{qty: 1, weight: 101, dimType: "PLT"}],
    flags: {},
  }],
};
intake.applyEmailPalletBlocks(bleed, {body: D6062_BODY});
check("D6062 applyEmailPalletBlocks no 139 inflate",
    bleed.lanes[0].freightInfo[0].qty, 1);

// Q#I1083 family: Lifeworks/BJ's — Shipment 1 drops 327lb when the
// second dash is missing; Shipment 2 drops "(x2) … each" dim lines.
const I1083_BODY = [
  "Shipment 1:",
  "",
  "BJS WHOLESALES CLUB 0800",
  "869 QUAKER HWY",
  "UXBRIDGE MA 015692252 US",
  "",
  "PO# 117803919//PT# 2356497",
  "158ctns – 5pallets",
  "48*41*59 – 37ctns – 366lbs (charging cables)",
  "48*40*52 – 28ctns – 207lbs (charging cables)",
  "48*40*53 – 28ctns – 955lbs (canned air)",
  "48*40*50 – 32ctns 327lbs (charging cables)",
  "48*40*59 – 33ctns – 629lbs (charging cables & canned air)",
  "2484lbs",
  "",
  "Shipment 2:",
  "",
  "BJS WHOLESALES CLUB 0820",
  "309 DULTY'S LANE",
  "BURLINGTON NJ 08016 US",
  "",
  "PO# 117803228 //PT# 2356495",
  "163ctns – 6pallets",
  "(x2) 48*40*54 – 30ctns each – 1020lbs each ( canned air )",
  "48*40*39 – 21ctns – 419lbs (charging cables & canned air )",
  "48*40*52 – 33ctns – 286lbs (charging cables)",
  "48*40*39 – 24ctns – 247lbs (charging cables)",
  "48*40*42 – 25ctns – 265lbs (charging cables)",
  "3257lbs",
  "",
  "Shipment 3:",
  "",
  "BJS WHOLESALES CLUB 0840",
  "4500 DIRECTORS RD",
  "JACKSONVILLE FL 322202864 US",
  "",
  "PO# 117803499//PT# 2356496",
  "137ctns – 5pallets",
  "48*40*40 – 26ctns – 263lbs (charging cables)",
  "48*41*39 – 25ctns – 268lbs (charging cables)",
  "48*40*41 – 24ctns – 184lbs (charging cables)",
  "48*40*53 – 29ctns – 988lbs ( canned air )",
  "48*40*59 – 33ctns – 667lbs (charging cables & canned air )",
  "2370lbs",
].join("\n");

const i1083Sections = intake.extractNumberedShipmentSections(I1083_BODY);
check("I1083 three shipment sections", i1083Sections.length, 3);
check("I1083 ship1 includes 327lbs (no 2nd dash)",
    i1083Sections[0].blocks.map((r) => r.weight),
    [366, 207, 955, 327, 629]);
check("I1083 ship1 pallet qty 5",
    i1083Sections[0].blocks.reduce((s, r) => s + (Number(r.qty) || 0), 0),
    5);
check("I1083 ship2 (x2) 1020lbs each",
    i1083Sections[1].blocks.map((r) => ({
      qty: r.qty, weight: r.weight, weightType: r.weightType,
    })),
    [
      {qty: 2, weight: 1020, weightType: "each"},
      {qty: 1, weight: 419, weightType: "total"},
      {qty: 1, weight: 286, weightType: "total"},
      {qty: 1, weight: 247, weightType: "total"},
      {qty: 1, weight: 265, weightType: "total"},
    ]);
check("I1083 ship2 pallet qty 6",
    i1083Sections[1].blocks.reduce((s, r) => s + (Number(r.qty) || 0), 0),
    6);
check("I1083 ship3 pallet qty 5",
    i1083Sections[2].blocks.reduce((s, r) => s + (Number(r.qty) || 0), 0),
    5);

const i1083Split = {
  lanes: [
    {
      laneKey: "BJS_UXBRIDGE_MA",
      consignee: {city: "UXBRIDGE", state: "MA", zipCode: "01569"},
      freightInfo: [{qty: 1, weight: 366, dimType: "PLT"}],
    },
    {
      laneKey: "BJS_BURLINGTON_NJ",
      consignee: {city: "BURLINGTON", state: "NJ", zipCode: "08016"},
      freightInfo: [{qty: 1, weight: 419, dimType: "PLT"}],
    },
    {
      laneKey: "BJS_JACKSONVILLE_FL",
      consignee: {city: "JACKSONVILLE", state: "FL", zipCode: "32220"},
      freightInfo: [{qty: 1, weight: 263, dimType: "PLT"}],
    },
  ],
};
intake.applyEmailPalletBlocks(i1083Split, {body: I1083_BODY});
check("I1083 applyEmail Uxbridge 5 PLT",
    i1083Split.lanes[0].freightInfo
        .reduce((s, r) => s + (Number(r.qty) || 0), 0),
    5);
check("I1083 applyEmail Burlington 6 PLT",
    i1083Split.lanes[1].freightInfo
        .reduce((s, r) => s + (Number(r.qty) || 0), 0),
    6);
check("I1083 applyEmail Jacksonville 5 PLT",
    i1083Split.lanes[2].freightInfo
        .reduce((s, r) => s + (Number(r.qty) || 0), 0),
    5);
check("I1083 Uxbridge includes 327",
    i1083Split.lanes[0].freightInfo.map((r) => r.weight).includes(327),
    true);

// Leo: Total weight + mixed dims → even lbs/pallet (not dump total on
// line 1 and invent 1 lb on line 2). Screenshot: 3@1300 total + 1@1.
const LEO_MIXED_BODY = [
  "Total Cartons – 166",
  "Total weight – 1,300 with pallets",
  "Number of Pallets - 4",
  "Pallet dimensions (L *W *H) – 3 plts @ 48x40x85, 48x40x66",
].join("\n");

const leoLabeled = intake.parseLabeledFreightTotals(LEO_MIXED_BODY);
check("Leo labeled weight 1300 not 1", leoLabeled.weight, 1300);
check("Leo labeled palletCount 4", leoLabeled.palletCount, 4);
check("Leo labeled no single dim (mixed)", leoLabeled.length, null);

const leoMixed = intake.extractMixedQtyAtDimLines(
    LEO_MIXED_BODY, leoLabeled.palletCount);
check("Leo mixed lines qty", leoMixed.map((r) => r.qty), [3, 1]);
check("Leo mixed heights", leoMixed.map((r) => r.height), [85, 66]);
check("Leo mixed GMA 40x48", [
  leoMixed[0].length, leoMixed[0].width,
  leoMixed[1].length, leoMixed[1].width,
], [40, 48, 40, 48]);

const leoAiWrong = {
  lanes: [{
    laneKey: "DEST",
    freightInfo: [
      {
        qty: 3, weight: 1300, weightType: "total",
        length: 40, width: 48, height: 85, dimType: "PLT",
      },
      {
        qty: 1, weight: 1, weightType: "total",
        length: 40, width: 48, height: 66, dimType: "PLT",
      },
    ],
  }],
};
intake.normalizeExtractedQuote(leoAiWrong, {body: LEO_MIXED_BODY});
const leoRows = leoAiWrong.lanes[0].freightInfo;
check("Leo fix qty 3+1", leoRows.map((r) => r.qty), [3, 1]);
check("Leo fix weight 325 each", leoRows.map((r) => r.weight), [325, 325]);
check("Leo fix weightType each",
    leoRows.map((r) => r.weightType), ["each", "each"]);
check("Leo fix heights preserved",
    leoRows.map((r) => r.height), [85, 66]);

const leoCollapsed = {
  lanes: [{
    laneKey: "DEST",
    freightInfo: [{
      qty: 4, weight: 1300, weightType: "total",
      length: 40, width: 48, height: 85, dimType: "PLT",
    }],
  }],
};
intake.normalizeExtractedQuote(leoCollapsed, {body: LEO_MIXED_BODY});
const leoSplit = leoCollapsed.lanes[0].freightInfo;
check("Leo collapsed → 2 dim lines", leoSplit.length, 2);
check("Leo collapsed qty 3+1", leoSplit.map((r) => r.qty), [3, 1]);
check("Leo collapsed 325 each",
    leoSplit.map((r) => r.weight), [325, 325]);
check("Leo collapsed weightType each",
    leoSplit.map((r) => r.weightType), ["each", "each"]);

// Per-line lbs already present → do not overwrite with even split.
const coreforceKeep = {
  lanes: [{
    freightInfo: [
      {qty: 2, weight: 1020, weightType: "each", dimType: "PLT",
        length: 40, width: 48, height: 54},
      {qty: 1, weight: 419, weightType: "total", dimType: "PLT",
        length: 40, width: 48, height: 39},
    ],
  }],
};
intake.redistributeEvenTotalWeight(coreforceKeep,
    "Total weight – 2459\n" +
    "(x2) 48*40*54 – 30ctns each – 1020lbs each\n" +
    "48*40*39 – 21ctns – 419lbs\n");
check("explicit per-line lbs kept",
    coreforceKeep.lanes[0].freightInfo.map((r) => r.weight),
    [1020, 419]);

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nAll carton-vs-pallet checks passed");
