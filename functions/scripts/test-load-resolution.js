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
check("5-digit rejected when recent loads are 6-digit",
    lr.evaluateLoadCandidate("24673", "", 265708).ok, false);
check("6-digit within range passes",
    lr.evaluateLoadCandidate("265718", "", 265708).ok, true);
check("6-digit out of range rejected",
    lr.evaluateLoadCandidate("365718", "", 265708).ok, false);
check("7-digit rejected",
    lr.evaluateLoadCandidate("5416296", "", 265708).ok, false);
check("5-digit format rejected",
    lr.isValidLoadNumber("24673"), false);
check("6-digit format accepted",
    lr.isValidLoadNumber("265708"), true);

const ctAccount = lr.normalizeCarrierReferenceFields({
  loadNumber: "24673",
  proNumber: "422025965",
  carrierName: "Central Transport",
});
check("CT 5-digit account demoted when long PRO present",
    ctAccount.loadNumber, "");
check("CT account kept as carrier order",
    ctAccount.carrierOrderNumber, "24673");
check("CT PRO kept", ctAccount.proNumber, "422025965");

const ctMisread = lr.normalizeCarrierReferenceFields({
  loadNumber: "5416296",
  proNumber: "422025965",
  carrierName: "Central Transport",
});
check("CT 7-digit misread demoted from load",
    ctMisread.loadNumber, "");
check("CT 7-digit kept as carrier order",
    ctMisread.carrierOrderNumber, "5416296");

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

const batchSubject = lr.extractLoadHintsFromEmailText(
    "Batch 24673", "");
check("Batch subject does not extract load",
    batchSubject.loadNumber, null);

const labeledPro = lr.extractLoadHintsFromEmailText(
    "Invoice for load", "PRO # 422025965");
check("labeled PRO extracted from body",
    labeledPro.proNumber, "422025965");
check("body without load label has no load",
    labeledPro.loadNumber, null);

const emptyInvoice = lr.applyEmailLoadHintsToInvoice({
  loadNumber: "",
  proNumber: "",
  carrierBolNumber: "",
  carrierName: "KJH Carriers Corp",
}, "Invoice 23493 - Load 265708", "");
check("empty invoice does not get subject load",
    emptyInvoice.loadNumber, "");
check("subject load source not tagged",
    emptyInvoice.loadNumberSource, undefined);

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
check("FactorView subject does not fill load",
    factorview798.loadNumber, "");

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
