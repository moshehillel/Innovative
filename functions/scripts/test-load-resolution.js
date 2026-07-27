/* eslint-disable no-console */
const lr = require("../invoice-load-resolution");

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}` +
    (ok ? "" : `\n  got: ${JSON.stringify(actual)}` +
      `\n  exp: ${JSON.stringify(expected)}`));
};

// Schneider legacy mis-bucketing: order → load, BOL → PRO
const schneider = lr.normalizeCarrierReferenceFields({
  loadNumber: "2054707475",
  proNumber: "263645",
  carrierName: "Schneider National, Inc.",
});
check("Schneider order moved to carrierOrderNumber",
    schneider.carrierOrderNumber, "2054707475");
check("Schneider BOL moved out of PRO",
    schneider.carrierBolNumber, "263645");
check("Schneider PRO cleared", schneider.proNumber, "");
check("Schneider broker load cleared", schneider.loadNumber, "");

// Explicit new-field extraction
const explicit = lr.normalizeCarrierReferenceFields({
  loadNumber: "",
  proNumber: "",
  carrierBolNumber: "263645",
  carrierOrderNumber: "2054707475",
  poNumber: "012030303437",
});
check("explicit BOL kept", explicit.carrierBolNumber, "263645");
check("explicit PO kept", explicit.poNumber, "012030303437");

// BOL duplicated in proNumber with explicit carrierBol
const dup = lr.normalizeCarrierReferenceFields({
  loadNumber: "264200",
  proNumber: "263645",
  carrierBolNumber: "263645",
});
check("duplicate BOL clears PRO", dup.proNumber, "");
check("broker load kept", dup.loadNumber, "264200");

check("valid 6-digit load passes",
    lr.evaluateLoadCandidate("264200", "", 264175).ok, true);
check("10-digit rejected",
    lr.evaluateLoadCandidate("2054707475", "", 264175).ok, false);
check("same as pro rejected",
    lr.evaluateLoadCandidate("263645", "263645", 264175).ok, false);

const keys = lr.buildPrimusLookupKeys({
  proNumber: "",
  carrierBolNumber: "263645",
  carrierOrderNumber: "2054707475",
  poNumber: "012030303437",
});
check("lookup key order",
    keys.map((k) => k.label),
    ["carrier_bol", "carrier_order", "po"]);

const review = lr.carrierReferenceReviewFields({
  loadNumber: "",
  proNumber: "",
  carrierBolNumber: "263645",
  carrierOrderNumber: "2054707475",
  poNumber: "012030303437",
});
check("review shows BOL not PRO",
    review["Carrier PRO"], "none");
check("review shows carrier BOL",
    review["Carrier BOL #"], "263645");

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
