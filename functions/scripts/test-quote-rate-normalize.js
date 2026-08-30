/* eslint-disable no-console */
"use strict";

const rateShop = require("../quote-rate-shop");

// Use Primus company density bands for all class lookups in this suite.
rateShop.setDensityRulesCacheForTest(rateShop.FALLBACK_DENSITY_RULES);

let failures = 0;
const check = (name, got, exp) => {
  const pass = got === exp;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) {
    console.log(`  got: ${JSON.stringify(got)}`);
    console.log(`  exp: ${JSON.stringify(exp)}`);
  }
};

check("USA → US", rateShop.normalizeIsoCountry("USA"), "US");
check("usa → US", rateShop.normalizeIsoCountry("usa"), "US");
check("inches → PLT", rateShop.normalizeDimType("inches"), "PLT");
check("United States → US", rateShop.normalizeIsoCountry("United States"), "US");
check("US → US", rateShop.normalizeIsoCountry("US"), "US");
check("empty → US", rateShop.normalizeIsoCountry(""), "US");
check("CAN → CA", rateShop.normalizeIsoCountry("CAN"), "CA");
check("Canada → CA", rateShop.normalizeIsoCountry("Canada"), "CA");
check("MEX → MX", rateShop.normalizeIsoCountry("MEX"), "MX");
check("Mexico → MX", rateShop.normalizeIsoCountry("Mexico"), "MX");

check("pallet → PLT", rateShop.normalizeDimType("pallet"), "PLT");
check("pallets → PLT", rateShop.normalizeDimType("pallets"), "PLT");
check("skid → PLT", rateShop.normalizeDimType("skid"), "PLT");
check("in → PLT", rateShop.normalizeDimType("in"), "PLT");
check("carton → CTN", rateShop.normalizeDimType("carton"), "CTN");
check("crate → CRT", rateShop.normalizeDimType("crate"), "CRT");
check("drum → DRM", rateShop.normalizeDimType("drum"), "DRM");
check("box → BOX", rateShop.normalizeDimType("box"), "BOX");
check("bundle → BDL", rateShop.normalizeDimType("bundle"), "BDL");
check("envelope → ENV", rateShop.normalizeDimType("envelope"), "ENV");
check("cylinder → CYL", rateShop.normalizeDimType("cylinder"), "CYL");
check("case → CAS", rateShop.normalizeDimType("case"), "CAS");
check("truckload → TRUCK LOAD", rateShop.normalizeDimType("truckload"),
    "TRUCK LOAD");
check("tl → TRUCK LOAD", rateShop.normalizeDimType("tl"), "TRUCK LOAD");
check("ftl → TRUCK LOAD", rateShop.normalizeDimType("ftl"), "TRUCK LOAD");
check("unknown → OTH", rateShop.normalizeDimType("unknown"), "OTH");
check("blank + weight → PLT",
    rateShop.normalizeDimType("", {weight: 500, length: 48, width: 40}),
    "PLT");

const q = rateShop.buildRateMultipleQuery({
  shipper: {city: "A", state: "NY", zipCode: "10913", country: "USA"},
  consignee: {city: "B", state: "MA", zipCode: "01040", country: "United States"},
  freightInfo: [{qty: 1, weight: 100, dimType: "pallet"}],
}, {UOM: "US"});
check("query originCountry US", q.originCountry, "US");
check("query destinationCountry US", q.destinationCountry, "US");
const freight = JSON.parse(q.freightInfo);
check("query freight dimType PLT", freight[0].dimType, "PLT");

const swapped = rateShop.buildRateMultipleQuery({
  shipper: {city: "A", state: "NY", zipCode: "10913", country: "US"},
  consignee: {city: "B", state: "MA", zipCode: "01040", country: "US"},
  freightInfo: [{
    qty: 1, weight: 137, weightType: "total",
    length: 48, width: 40, height: 28, dimType: "PLT",
  }],
}, {UOM: "US"});
const swappedFreight = JSON.parse(swapped.freightInfo);
check("rate payload 48x40 → L 40", swappedFreight[0].length, 40);
check("rate payload 48x40 → W 48", swappedFreight[0].width, 48);
check("rate payload height kept", swappedFreight[0].height, 28);

const missingDimsQ = rateShop.buildRateMultipleQuery({
  shipper: {city: "A", state: "NY", zipCode: "10913", country: "US"},
  consignee: {city: "B", state: "MA", zipCode: "01040", country: "US"},
  freightInfo: [{qty: 1, weight: 500, dimType: "PLT"}],
}, {UOM: "US"});
const missingFreight = JSON.parse(missingDimsQ.freightInfo);
check("missing dims default L 40", missingFreight[0].length, 40);
check("missing dims default W 48", missingFreight[0].width, 48);
check("missing dims default H 60", missingFreight[0].height, 60);
check("missing dims weightType total", missingFreight[0].weightType, "total");

// Density → class (Primus companydensityrules bands)
check("density 24.375 → 65", rateShop.classFromDensity(24.375), 65);
check("density 12.36 → 85", rateShop.classFromDensity(12.36), 85);
check("density 8.34 → 100", rateShop.classFromDensity(8.342), 100);
check("density 5.69 → 175", rateShop.classFromDensity(5.6889), 175);
check("density 2.05 → 250", rateShop.classFromDensity(2.05), 250);
check("density 3.5 → 250", rateShop.classFromDensity(3.5), 250);
check("137 lb 40x48x60 → 250", rateShop.ensureFreightClasses([{
  qty: 1, weight: 137, weightType: "total",
  length: 40, width: 48, height: 60, dimType: "PLT",
}]).freightInfo[0].class, 250);
check("density 6.576 → 125", rateShop.classFromDensity(6.576), 125);
check("453 lb 40x48x62 → 125", rateShop.ensureFreightClasses([{
  qty: 1, weight: 453, weightType: "total",
  length: 40, width: 48, height: 62, dimType: "PLT", class: 175,
}]).freightInfo[0].class, 125);
check("503 lb 40x48x62 → 125", rateShop.ensureFreightClasses([{
  qty: 1, weight: 503, weightType: "total",
  length: 40, width: 48, height: 62, dimType: "PLT", class: 150,
}]).freightInfo[0].class, 125);
check("549 lb 40x48x62 → 125", rateShop.ensureFreightClasses([{
  qty: 1, weight: 549, weightType: "total",
  length: 40, width: 48, height: 62, dimType: "PLT", class: 250,
}]).freightInfo[0].class, 125);
check("valid class 70", rateShop.isValidFreightClass(70), true);
check("invalid class null", rateShop.isValidFreightClass(null), false);
check("invalid class 0", rateShop.isValidFreightClass(0), false);

const ruelily = rateShop.ensureFreightClasses([{
  qty: 2, weight: 1205, weightType: "total",
  length: 48, width: 40, height: 65, dimType: "PLT", class: null,
}]);
check("ruelily filled class 100", ruelily.freightInfo[0].class, 100);
check("ruelily filled count", ruelily.filled, 1);
check("ruelily unresolved", ruelily.unresolved.length, 0);
check("ruelily classSource density", ruelily.freightInfo[0].classSource,
    "density");

const noDims = rateShop.ensureFreightClasses([{
  qty: 1, weight: 500, dimType: "PLT", class: null,
}]);
check("no dims unresolved", noDims.unresolved.length, 1);
check("no dims filled", noDims.filled, 0);

const emailClass = rateShop.ensureFreightClasses([{
  qty: 2, weight: 1205, weightType: "total",
  length: 48, width: 40, height: 65, dimType: "PLT", class: 70,
}]);
check("email class overwritten to 100", emailClass.freightInfo[0].class, 100);
check("email class preserved", emailClass.freightInfo[0].emailClass, 70);
check("email class overwritten count", emailClass.overwritten, 1);

const keepEmail = rateShop.ensureFreightClasses([{
  qty: 1, weight: 500, dimType: "PLT", class: 70,
}]);
check("keep email class without dims", keepEmail.freightInfo[0].class, 70);
check("keep email classSource", keepEmail.freightInfo[0].classSource, "email");
check("keep email unresolved", keepEmail.unresolved.length, 0);

const qFilled = rateShop.buildRateMultipleQuery({
  shipper: {city: "A", state: "NY", zipCode: "10913", country: "US"},
  consignee: {city: "B", state: "MA", zipCode: "01040", country: "US"},
  freightInfo: [{
    qty: 2, weight: 1205, weightType: "total",
    length: 48, width: 40, height: 65, dimType: "PLT",
  }],
}, {UOM: "US"});
const freightFilled = JSON.parse(qFilled.freightInfo);
check("query auto class 100", freightFilled[0].class, 100);

const kadraHits = [{
  id: 1410005738, name: "Kadra Kitchenware", customer: true,
}];
check("Kadra Warehouse → Kitchenware",
    (rateShop.pickBestCustomerMatch(kadraHits, {
      customerName: "Kadra Warehouse",
    }) || {}).id, 1410005738);
check("Kadra → Kitchenware",
    (rateShop.pickBestCustomerMatch(kadraHits, {
      customerName: "Kadra",
    }) || {}).id, 1410005738);
check("Acme Warehouse does not match Acme Industries",
    rateShop.pickBestCustomerMatch([{
      id: 9, name: "Acme Industries", customer: true,
    }], {customerName: "Acme Warehouse"}), null);
check("Ruelily → Ruelily Inc",
    (rateShop.pickBestCustomerMatch([{
      id: 2, name: "Ruelily Inc", customer: true,
    }], {customerName: "Ruelily"}) || {}).id, 2);
check("expand Kadra Warehouse includes Kadra",
    rateShop.expandCustomerSearchTerms("Kadra Warehouse").join("|"),
    "Kadra Warehouse|kadra");
check("expand skips zip-only",
    rateShop.expandCustomerSearchTerms("22911").join("|"), "");
check("empty noRates retries market",
    rateShop.shouldRetryRatesWithoutCustomer([]), true);
check("null noRates retries market",
    rateShop.shouldRetryRatesWithoutCustomer(null), true);
check("customer profile error retries market",
    rateShop.shouldRetryRatesWithoutCustomer([
      {error: "Customer Profile not found"},
      {error: "Customer Profile not found"},
    ]), true);
check("any empty rates retries market",
    rateShop.shouldRetryRatesWithoutCustomer([
      {error: "Destination city is required"},
      {error: "Invalid zipcode"},
    ]), true);
check("market fallback warning text",
    String(rateShop.MARKET_FALLBACK_WARNING || "")
        .startsWith(
            "Primus customer matched but no customer tariffs — showing " +
            "market rates."),
    true);

check("market sell uses min($55, 10%) — low cost",
    rateShop.computeSellRate(300), 330);
check("market sell uses min($55, 10%) — high cost",
    rateShop.computeSellRate(2000), 2055);
check("market sell at crossover",
    rateShop.computeSellRate(550), 605);
check("customer billTo passes through below floor",
    rateShop.computeSellRate(300, {billToTotal: 320}), 320);
check("customer rateSource passes through without floor",
    rateShop.computeSellRate(400, {rateSource: "customer"}), 400);
check("market_fallback applies markup",
    rateShop.computeSellRate(300, {rateSource: "market_fallback"}), 330);
check("sell rate ceils fractional market markup",
    rateShop.computeSellRate(301.1), 332);
check("sell rate ceils fractional billTo",
    rateShop.computeSellRate(300, {billToTotal: 753.15}), 754);
check("sell rate keeps whole billTo",
    rateShop.computeSellRate(300, {billToTotal: 754}), 754);
check("customer rateSource ceils fractional",
    rateShop.computeSellRate(400.01, {rateSource: "customer"}), 401);

// FAK (Primus Pricing tab): profit = max(cost×rate%, min$) — floor, not cap.
const mikeFak = {rate: 15, type: "profit%", min: 80};
check("Mike FAK map for 779538209",
    JSON.stringify(rateShop.getCustomerFakPricing("779538209")),
    JSON.stringify(mikeFak));
check("unknown customer has no FAK",
    rateShop.getCustomerFakPricing("999"), null);
check("FAK sell low cost uses min $80",
    rateShop.computeSellRate(300, {fak: mikeFak}), 380);
check("FAK sell high cost uses 15%",
    rateShop.computeSellRate(1000, {fak: mikeFak}), 1150);
check("FAK sell at crossover cost=$533.34 → 15%>80",
    rateShop.computeSellRate(533.34, {fak: mikeFak}), 614);
check("FAK computeFakSellRate matches",
    rateShop.computeFakSellRate(300, mikeFak), 380);
check("FAK billTo still wins over FAK markup",
    rateShop.computeSellRate(300, {billToTotal: 350, fak: mikeFak}), 350);
check("FAK warning mentions FAK markup",
    String(rateShop.marketFallbackFakWarning(mikeFak))
        .includes("FAK markup") &&
    String(rateShop.marketFallbackFakWarning(mikeFak)).includes("15%") &&
    String(rateShop.marketFallbackFakWarning(mikeFak)).includes("min $80"),
    true);
check("isMarketFallbackRateSource market",
    rateShop.isMarketFallbackRateSource("market_fallback"), true);
check("isMarketFallbackRateSource fak",
    rateShop.isMarketFallbackRateSource("market_fallback_fak"), true);
check("isMarketFallbackRateSource customer false",
    rateShop.isMarketFallbackRateSource("customer"), false);
check("resolveFakPricing prefers opts override",
    JSON.stringify(rateShop.resolveFakPricingForCustomer("779538209", {
      fakPricing: {rate: 20, type: "profit%", min: 100},
    })),
    JSON.stringify({rate: 20, type: "profit%", min: 100}));
check("parseFak from empty SL is null",
    rateShop.parseFakPricingFromShippingLocation({id: 1, name: "x"}), null);
check("normalizeFak rejects bad rows",
    rateShop.normalizeFakPricing({rate: "x", min: 80}), null);

const slim = rateShop.normalizeRateRow({
  id: "Rabc123",
  name: "Roadrunner J&I",
  SCAC: "RDFS",
  total: 3033.23,
  transitDays: 5,
  quoteNumber: "103785203",
  billTo: {total: 3397.22, extra: "drop-me"},
  rateRemarks: ["Charges Grocery fee for Walmart $9 per 100 lbs, min $60."],
  hugeNested: {x: 1},
});
check("slim keeps id alias", slim.id, "Rabc123");
check("slim keeps rateId", slim.rateId, "Rabc123");
check("slim drops nested junk", slim.hugeNested, undefined);
check("slim billTo total only",
    JSON.stringify(slim.billTo), "{\"total\":3397.22}");

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll assertions passed");
