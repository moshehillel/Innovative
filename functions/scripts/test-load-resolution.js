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
check("Schneider billing ref promoted to broker load",
    schneider.loadNumber, "263645");

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

const flock = lr.normalizeCarrierReferenceFields({
  loadNumber: "FBA19FXCCFZT",
  carrierName: "Flock Freight Inc.",
  invoiceAmount: 1017,
});
check("FBA ref moved to shipmentReference",
    flock.shipmentReference, "FBA19FXCCFZT");
check("FBA ref clears broker load", flock.loadNumber, "");

const flockKeys = lr.buildPrimusLookupKeys({
  shipmentReference: "FBA19FXCCFZT",
});
check("FBA in lookup keys", flockKeys[0].ref, "FBA19FXCCFZT");

const trackingRow = {
  BOL: "263750",
  bookingTotal: "1017",
  vendorName: "Flock Freight ",
  consigneeReferenceNumber: "FBA19FXCCFZT",
};
const picked = lr.pickTrackingSearchMatch([trackingRow], {
  invoiceAmount: 1017,
  carrierName: "Flock Freight Inc.",
});
check("tracking search resolves load",
    picked && picked.loadNumber, "263750");

const review = lr.carrierReferenceReviewFields({
  loadNumber: "",
  proNumber: "",
  carrierBolNumber: "263645",
  carrierOrderNumber: "2054707475",
  poNumber: "012030303437",
});
check("review shows shipment ref",
    review["Shipment / customer ref"], "none");
check("review shows BOL not PRO",
    review["Carrier PRO"], "none");
check("review shows carrier BOL",
    review["Carrier BOL #"], "263645");

const factorviewSubject = lr.extractLoadHintsFromEmailText(
    "Invoice 23493 - Load 265708", "");
check("FactorView subject extracts load 265708",
    factorviewSubject.loadNumber, "265708");

const emptyInvoice = lr.applyEmailLoadHintsToInvoice({
  loadNumber: "",
  proNumber: "",
  carrierBolNumber: "",
  carrierName: "KJH Carriers Corp",
}, "Invoice 23493 - Load 265708", "");
check("empty invoice gets subject load",
    emptyInvoice.loadNumber, "265708");
check("subject load source tagged",
    emptyInvoice.loadNumberSource, "email_subject");

const keepExisting = lr.applyEmailLoadHintsToInvoice({
  loadNumber: "264200",
}, "Invoice 23493 - Load 265708", "");
check("existing broker load not overwritten",
    keepExisting.loadNumber, "264200");

const billingRef = lr.normalizeCarrierReferenceFields({
  loadNumber: "",
  carrierBolNumber: "265798",
  carrierName: "KJH Carriers Corp",
});
check("billing reference promoted to broker load",
    billingRef.loadNumber, "265798");

const factorview798 = lr.applyEmailLoadHintsToInvoice({
  loadNumber: "",
  carrierBolNumber: "",
  carrierName: "KJH Carriers Corp",
}, "Invoice 23494 - Load 265798", "");
check("FactorView 23494 subject load",
    factorview798.loadNumber, "265798");

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
