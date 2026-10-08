/* eslint-disable no-console */
"use strict";

/**
 * Subject-line ZIP fill: only empty lane sides, never PO/phone/quote ids.
 */

const intake = require("../quote-intake");

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

/**
 * @param {string} subject Email subject.
 * @param {object} shipper Shipper party.
 * @param {object} consignee Consignee party.
 * @return {object}
 */
function run(subject, shipper, consignee) {
  const extracted = {
    shipper: {...shipper},
    lanes: [{
      laneKey: "LANE",
      shipper: {...shipper},
      consignee: {...consignee},
      freightInfo: [{
        qty: 1, weight: 500, weightType: "total",
        length: 40, width: 48, height: 48, dimType: "PLT",
      }],
    }],
  };
  intake.finishExtract(extracted, {
    subject,
    body: "Please quote 1 pallet 40x48x48, 500 lbs. No zips in the body.",
    from: "ops@example.com",
  });
  const lane = extracted.lanes[0];
  return {
    ship: (lane.shipper && lane.shipper.zipCode) || "",
    dest: (lane.consignee && lane.consignee.zipCode) || "",
    warned: (extracted.extractionWarnings || []).includes("zip from subject"),
  };
}

const emptyShip = {city: "Lakewood", state: "NJ", zipCode: ""};
const emptyDest = {city: "Charlottesville", state: "VA", zipCode: ""};

check("from/to subject fills both empty sides",
    run("Quote from 08701 to 22911", emptyShip, emptyDest),
    {ship: "08701", dest: "22911", warned: true});

check("arrow subject fills both empty sides",
    run("RFQ 08701 → 22911", emptyShip, emptyDest),
    {ship: "08701", dest: "22911", warned: true});

check("hyphenated lane is origin then dest, not ZIP+4",
    run("Quote 08701-22911", emptyShip, emptyDest),
    {ship: "08701", dest: "22911", warned: true});

check("ZIP+4 stays one origin and does not guess a side",
    run("Quote 08701-1234", emptyShip, emptyDest),
    {ship: "", dest: "", warned: false});

check("pickup/delivery words assign sides",
    run("pickup 08701 delivery 22911", emptyShip, emptyDest),
    {ship: "08701", dest: "22911", warned: true});

check("does not overwrite body/AI zips",
    run("Quote from 08701 to 22911",
        {city: "Newark", state: "NJ", zipCode: "07102"},
        {city: "Miami", state: "FL", zipCode: "33101"}),
    {ship: "07102", dest: "33101", warned: false});

check("fills only the empty origin",
    run("Quote from 08701 to 22911",
        emptyShip,
        {city: "Charlottesville", state: "VA", zipCode: "22911"}),
    {ship: "08701", dest: "22911", warned: true});

check("single subject zip fills the empty side",
    run("Need rate 22911",
        {city: "Lakewood", state: "NJ", zipCode: "08701"},
        emptyDest),
    {ship: "08701", dest: "22911", warned: true});

check("single subject zip does not guess when both empty",
    run("Need rate 22911", emptyShip, emptyDest),
    {ship: "", dest: "", warned: false});

check("PO number is not a ZIP",
    run("PO 30516 from 08701 to 22911", emptyShip, emptyDest),
    {ship: "08701", dest: "22911", warned: true});

check("quote id hash is not a ZIP",
    run("Quote #26753 — 08701 to 22911", emptyShip, emptyDest),
    {ship: "08701", dest: "22911", warned: true});

check("phone fragment is not a ZIP",
    run("call 555-08701 deliver 22911",
        {city: "Lakewood", state: "NJ", zipCode: "07001"},
        emptyDest),
    {ship: "07001", dest: "22911", warned: true});

check("weight is not a ZIP",
    run("08701 to 22911 13000 lbs", emptyShip, emptyDest),
    {ship: "08701", dest: "22911", warned: true});

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll subject ZIP checks passed.");
