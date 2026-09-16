/* eslint-disable no-console */
"use strict";

/**
 * Zip-only address fill hardening (pad + fail warning).
 */

const enrichment = require("../quote-address-enrichment");

let failures = 0;
const checkTrue = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

checkTrue("partyNeedsCityStateFromZip detects zip-only",
    enrichment.partyNeedsCityStateFromZip({zipCode: "08701"}));
checkTrue("partyNeedsCityStateFromZip false when complete",
    !enrichment.partyNeedsCityStateFromZip({
      city: "Lakewood", state: "NJ", zipCode: "08701",
    }));

// Google labels Lakewood NJ 08701 as neighborhood (not locality).
const lakewoodComps = [
  {long_name: "08701", short_name: "08701", types: ["postal_code"]},
  {long_name: "Lakewood", short_name: "Lakewood",
    types: ["neighborhood", "political"]},
  {long_name: "New Jersey", short_name: "NJ",
    types: ["administrative_area_level_1", "political"]},
];
const lakewoodParsed = enrichment.parseGoogleAddressComponents(
    lakewoodComps, "", "");
checkTrue("Google neighborhood ZIP yields city+state",
    lakewoodParsed &&
    lakewoodParsed.city === "Lakewood" &&
    lakewoodParsed.state === "NJ" &&
    lakewoodParsed.zipCode === "08701");

(async () => {
  const lane = {extractionWarnings: []};
  // padStart path: 4-digit ZIP should become 08701 via Zippopotam or fail
  // loudly — never silent.
  const party = {zipCode: "8701"};
  const out = await enrichment.fillPartyCityStateFromZip(party, lane);
  const filled = !!(out.city && out.state);
  const warnedFail = (lane.extractionWarnings || [])
      .includes("zip fill failed");
  const warnedOk = (lane.extractionWarnings || []).includes("zip filled");
  checkTrue("4-digit ZIP either fills or flags zip fill failed",
      filled ? warnedOk : warnedFail);
  if (filled) {
    checkTrue("padded ZIP stored as 5 digits",
        String(out.zipCode) === "08701");
  }

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll zip-fill harden checks passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
