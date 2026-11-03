/* Unit tests: customer invoice email attaches insurance COI (and W&I)
 * drive docs from Primus booking documents. No Firebase / Primus needed.
 * Run: node scripts/test-invoice-email-coi-attachments.js
 */
"use strict";

const bridge = require("../primus-ui-bridge");
const ac = require("../additional-charges");

const {
  listInsuranceCoiDriveFileIds,
  listInspectionCertDriveFileIds,
  listPodDriveFileIds,
  matchCoiFileType,
  matchInspectionCertFileType,
} = bridge._internal;

let passed = 0;
let failed = 0;

/**
 * @param {string} name
 * @param {*} actual
 * @param {*} expected
 */
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(` FAIL ${name}`);
    console.log(`      expected ${JSON.stringify(expected)}`);
    console.log(`      actual   ${JSON.stringify(actual)}`);
  }
}

/**
 * @param {string} name
 * @param {boolean} cond
 */
function checkTrue(name, cond) {
  check(name, !!cond, true);
}

console.log("1. match COI / W&I file types from Primus getFileTypes rows");
const fileTypes = [
  {id: "372", name: "Carrier Bill", code: "OB", external: "0"},
  {id: "0", name: "POD - Proof of Delivery", code: "POD", external: "1"},
  {id: "367", name: "Certificate of Insurance", code: "COI", external: "1"},
  {id: "1", name: "Certificate of Insurance", code: "COI", external: "1"},
  {id: "381", name: "Reweigh/Reclass Certificate", code: "WI", external: "1"},
  {id: "13", name: "Weight and Research", code: "WNR", external: "0"},
  {id: "407", name: "Carrier Cargo Insurance ", code: "CCI", external: "0"},
];

const coi = matchCoiFileType(fileTypes);
checkTrue("COI match present", !!coi);
check("COI collects both Primus type ids",
    (coi.ids || []).slice().sort(), ["1", "367"]);
checkTrue("COI marked external", coi.external === "1");

const wi = matchInspectionCertFileType(fileTypes);
checkTrue("W&I match present", !!wi);
check("W&I prefers code WI id 381", wi.id, "381");
checkTrue("W&I does not pick Weight and Research", wi.id !== "13");

console.log("2. list COI / POD / W&I from load-270384-shaped documents");
// Shape mirrors getBookingDocuments for BOL 270384 (COI type 1 on Primus).
const doc270384 = {
  files: [
    {
      id: "1aPNXEH3L0P8YtGWD7a_cNUrmyXYoFJFX",
      type: "1",
      name: "COI_BOL%23270384.pdf",
    },
    {
      id: "17FZmeiS7-0mLPhokfogjnBCP6EW_lE1x",
      type: "0",
      name: "270384_POD.pdf",
    },
    {
      id: "1KkbpMn5WmYfIX_N4oRVILi_LKyYuVTs8",
      type: "372",
      name: "INV97763032-2362325.PDF",
    },
  ],
};

const coiIds = listInsuranceCoiDriveFileIds(doc270384, coi.ids, "372");
check("270384 COI drive id selected",
    coiIds, ["1aPNXEH3L0P8YtGWD7a_cNUrmyXYoFJFX"]);

const podIds = listPodDriveFileIds(doc270384, "0", "372");
check("270384 POD drive id selected",
    podIds, ["17FZmeiS7-0mLPhokfogjnBCP6EW_lE1x"]);

const wiIdsEmpty = listInspectionCertDriveFileIds(doc270384, wi.ids, "372");
check("270384 has no W&I cert to attach", wiIdsEmpty, []);

console.log("3. COI also matches by filename when type id unknown");
const byName = listInsuranceCoiDriveFileIds({
  files: [{
    driveFileId: "coi-drive-xyz",
    type: "999",
    name: "Certificate of Insurance - load 1.pdf",
  }],
}, [], "372");
check("filename COI match", byName, ["coi-drive-xyz"]);

console.log("4. carrier bill never selected as COI");
const blocked = listInsuranceCoiDriveFileIds({
  files: [{
    id: "carrier-bill-id",
    type: "372",
    name: "COI_lookalike_but_carrier_bill.pdf",
  }],
}, ["1", "367"], "372");
check("carrier bill excluded from COI list", blocked, []);

console.log("5. W&I cert selected by type; priced-upload rule still pure");
const withWi = {
  files: [
    {
      id: "wi-drive-1",
      type: "381",
      name: "reweigh-reclass.pdf",
    },
    {
      id: "carrier-bill-id",
      type: "372",
      name: "invoice.pdf",
    },
  ],
};
check("W&I drive id selected",
    listInspectionCertDriveFileIds(withWi, ["381"], "372"),
    ["wi-drive-1"]);

check("no-pricing cert may attach",
    ac.certificateTextHasPricing(
        "Weight 4372 lbs Class 70 Dims 40 x 48 x 30").hasPricing,
    false);
check("Daylight-style priced cert withheld by text scan",
    ac.certificateTextHasPricing(
        "Inspection Certificate Total Charges $85.00").hasPricing,
    true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
