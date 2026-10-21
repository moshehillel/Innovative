"use strict";

const assert = require("assert");
const {
  manageLoadVendorName,
  billingVendorNameHint,
  applyLoadVendorToCostLine,
} = require("../primus-ui-bridge");

const quote = {
  carrierName: "ESTES",
  vendorName: "Worldwide Express",
  vendorNameActual: "Worldwide Express",
};
assert.strictEqual(manageLoadVendorName(quote), "Worldwide Express");
assert.strictEqual(
    manageLoadVendorName({vendorNameActual: "", vendorName: "ESTES"}),
    "ESTES",
);
assert.strictEqual(manageLoadVendorName(null), "");
assert.strictEqual(
    manageLoadVendorName({vendorNameActual: "Worldwide Express"}),
    "Worldwide Express",
);

assert.strictEqual(billingVendorNameHint({
  loadVendorName: "Worldwide Express",
  restVendorName: "ESTES",
  extractedCarrierName: "ESTES",
}), "Worldwide Express");
assert.strictEqual(billingVendorNameHint({
  restVendorName: "ESTES",
  extractedCarrierName: "XPO",
}), "ESTES");
assert.strictEqual(billingVendorNameHint({
  extractedCarrierName: "XPO",
}), "XPO");

const estesLine = {carrierId: "82651", carrierName: "ESTES", total: "167.40"};
const moved = applyLoadVendorToCostLine(estesLine, "ESTES", {
  id: "999",
  name: "Worldwide Express",
});
assert.strictEqual(moved.carrierId, "999");
assert.strictEqual(moved.carrierName, "Worldwide Express");
assert.strictEqual(estesLine.carrierName, "ESTES");

const insurance = {carrierId: "108637", carrierName: "Redkik USA", total: "12"};
const kept = applyLoadVendorToCostLine(insurance, "ESTES", {
  id: "999",
  name: "Worldwide Express",
});
assert.strictEqual(kept, insurance);

const direct = applyLoadVendorToCostLine(estesLine, "ESTES", {
  id: "82651",
  name: "ESTES",
});
assert.strictEqual(direct, estesLine);

console.log("load vendor billing checks passed");
