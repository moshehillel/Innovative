/* eslint-disable no-console */
"use strict";

/**
 * Unit tests: market-fallback applies per-customer FAK (map + live resolve).
 */

const rateShop = require("../quote-rate-shop");
const quoteAutomation = require("../quote-automation");

rateShop.setDensityRulesCacheForTest(rateShop.FALLBACK_DENSITY_RULES);
rateShop.clearFakPricingLiveCacheForTest();

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

const origFetch = rateShop.fetchMultipleRates;
const origEnsure = rateShop.ensureDensityRulesLoaded;

async function withStubbedRates(fn) {
  rateShop.ensureDensityRulesLoaded = async () => {};
  rateShop.fetchMultipleRates = async (params) => {
    if (params && params.customerId) {
      return {
        rates: [],
        noRates: [{error: "Customer Profile not found"}],
      };
    }
    return {
      rates: [{
        name: "Test Carrier",
        SCAC: "TEST",
        total: 300,
        transitDays: 3,
        quoteNumber: "Q1",
      }],
      noRates: [],
    };
  };
  try {
    return await fn();
  } finally {
    rateShop.fetchMultipleRates = origFetch;
    rateShop.ensureDensityRulesLoaded = origEnsure;
  }
}

(async () => {
  const lane = {
    shipper: {city: "Edison", state: "NJ", zipCode: "08817", country: "US"},
    consignee: {city: "Baxter", state: "MN", zipCode: "56425", country: "US"},
    freightInfo: [{
      qty: 1,
      weight: 2040,
      length: 48,
      width: 48,
      height: 65,
      class: "65",
      dimType: "PLT",
    }],
  };

  // --- pickFakPricingFromCarrierMarkups (Primus manage.php shape) ---
  const mikeMarkupRows = [{
    id: "1602055",
    shippingLocationId: "827367",
    carrier: "0",
    min: "80",
    rate: "15",
    type: "P",
    active: "1",
    erased: "0",
    carrierName: "All",
  }];
  check("pickFak from Primus P/All row → 15%/min80",
      JSON.stringify(rateShop.pickFakPricingFromCarrierMarkups(mikeMarkupRows)),
      JSON.stringify({rate: 15, type: "profit%", min: 80}));
  check("pickFak empty markups → null",
      rateShop.pickFakPricingFromCarrierMarkups([]), null);
  check("pickFak prefers All over specific carrier",
      JSON.stringify(rateShop.pickFakPricingFromCarrierMarkups([
        {carrier: "99", carrierName: "XPO", rate: "25", min: "50",
          type: "P", active: "1", erased: "0"},
        {carrier: "0", carrierName: "All", rate: "12", min: "70",
          type: "P", active: "1", erased: "0"},
      ])),
      JSON.stringify({rate: 12, type: "profit%", min: 70}));
  check("normalizeFak type P → profit%",
      JSON.stringify(rateShop.normalizeFakPricing({rate: 10, min: 40, type: "P"})),
      JSON.stringify({rate: 10, type: "profit%", min: 40}));
  check("normalizeFak type F → flat",
      JSON.stringify(rateShop.normalizeFakPricing({rate: 55, min: 55, type: "F"})),
      JSON.stringify({rate: 55, type: "flat", min: 55}));

  await withStubbedRates(async () => {
    const mike = await quoteAutomation.rateLane(lane, {
      shippingLocationId: "779538209",
      shippingLocationName: "Mike Oseback protocol only",
      rules: [],
      from: "mike.oseback@ediexpressinc.com",
    });
    check("Mike fallback rateSource is market_fallback_fak",
        mike.rateSource, "market_fallback_fak");
    check("Mike sell uses FAK 15%/min80 on $300 cost",
        mike.options && mike.options[0] && mike.options[0].sellRate, 380);
    check("Mike warning mentions FAK",
        String(mike.rateWarning || "").includes("FAK markup"), true);
    check("Mike fakPricing on lane",
        JSON.stringify(mike.fakPricing),
        JSON.stringify({rate: 15, type: "profit%", min: 80}));
  });

  await withStubbedRates(async () => {
    rateShop.setFetchFakPricingImplForTest(async () => null);
    const plain = await quoteAutomation.rateLane(lane, {
      shippingLocationId: "111111111",
      rules: [],
    });
    check("Unknown customer stays market_fallback",
        plain.rateSource, "market_fallback");
    check("Unknown customer uses default market markup $30",
        plain.options && plain.options[0] && plain.options[0].sellRate, 330);
    check("Unknown customer warning is market tariffs text",
        String(plain.rateWarning || "")
            .startsWith("Primus customer matched but no customer tariffs"),
        true);
  });
  rateShop.setFetchFakPricingImplForTest(null);

  // Multi-customer live resolve: map miss → stubbed Primus FAK per id.
  const liveFakById = {
    "627276080": {rate: 18, type: "profit%", min: 90},
    "555555555": {rate: 20, type: "profit%", min: 100},
  };
  rateShop.setFetchFakPricingImplForTest(async (id) => {
    return liveFakById[String(id)] || null;
  });

  await withStubbedRates(async () => {
    const ravitz = await quoteAutomation.rateLane(lane, {
      shippingLocationId: "627276080",
      shippingLocationName: "Ravitz Books",
      rules: [],
    });
    check("Ravitz (stub live FAK) rateSource market_fallback_fak",
        ravitz.rateSource, "market_fallback_fak");
    check("Ravitz sell uses 18%/min90 on $300 → 390",
        ravitz.options && ravitz.options[0] && ravitz.options[0].sellRate, 390);
    check("Ravitz fakPricing from live resolve",
        JSON.stringify(ravitz.fakPricing),
        JSON.stringify({rate: 18, type: "profit%", min: 90}));
  });

  await withStubbedRates(async () => {
    const other = await quoteAutomation.rateLane(lane, {
      shippingLocationId: "555555555",
      shippingLocationName: "Other FAK Only Co",
      rules: [],
    });
    check("Second FAK-only customer rateSource market_fallback_fak",
        other.rateSource, "market_fallback_fak");
    check("Second customer sell uses 20%/min100 on $300 → 400",
        other.options && other.options[0] && other.options[0].sellRate, 400);
  });

  await withStubbedRates(async () => {
    // Live stub returns null → plain market (not FAK).
    rateShop.setFetchFakPricingImplForTest(async () => null);
    const emptyFak = await quoteAutomation.rateLane(lane, {
      shippingLocationId: "999888777",
      shippingLocationName: "FAK type but no markup rows",
      rules: [],
    });
    check("Empty live FAK stays market_fallback",
        emptyFak.rateSource, "market_fallback");
    check("Empty live FAK uses default market sell",
        emptyFak.options && emptyFak.options[0] &&
          emptyFak.options[0].sellRate, 330);
  });

  // Map override still wins over live stub for Mike.
  rateShop.setFetchFakPricingImplForTest(async () => ({
    rate: 99, type: "profit%", min: 1,
  }));
  await withStubbedRates(async () => {
    const mikeOverride = await quoteAutomation.rateLane(lane, {
      shippingLocationId: "779538209",
      shippingLocationName: "Mike Oseback protocol only",
      rules: [],
    });
    check("Map override beats live stub for Mike",
        JSON.stringify(mikeOverride.fakPricing),
        JSON.stringify({rate: 15, type: "profit%", min: 80}));
    check("Map override Mike sell still 380",
        mikeOverride.options && mikeOverride.options[0] &&
          mikeOverride.options[0].sellRate, 380);
  });

  rateShop.setFetchFakPricingImplForTest(null);

  await withStubbedRates(async () => {
    // Customer rates returned — must not apply FAK / market path.
    rateShop.fetchMultipleRates = async () => ({
      rates: [{
        name: "Contract Carrier",
        SCAC: "CONT",
        total: 400,
        billTo: {total: 420},
        transitDays: 2,
      }],
      noRates: [],
    });
    const contracted = await quoteAutomation.rateLane(lane, {
      shippingLocationId: "779538209",
      rules: [],
    });
    check("Customer rates keep rateSource customer",
        contracted.rateSource, "customer");
    check("Customer billTo sell passes through",
        contracted.options && contracted.options[0] &&
          contracted.options[0].sellRate, 420);
  });

  // Async resolve unit checks without rateLane
  rateShop.setFetchFakPricingImplForTest(async (id) => {
    if (String(id) === "627276080") {
      return {rate: 18, type: "profit%", min: 90};
    }
    return null;
  });
  const asyncRavitz = await rateShop.resolveFakPricingForCustomerAsync(
      "627276080", {customerName: "Ravitz Books"});
  check("resolveFakPricingForCustomerAsync live path",
      JSON.stringify(asyncRavitz),
      JSON.stringify({rate: 18, type: "profit%", min: 90}));
  const asyncMikeMap = await rateShop.resolveFakPricingForCustomerAsync(
      "779538209", {customerName: "Mike"});
  check("resolveFakPricingForCustomerAsync map still for Mike",
      JSON.stringify(asyncMikeMap),
      JSON.stringify({rate: 15, type: "profit%", min: 80}));

  rateShop.setFetchFakPricingImplForTest(null);
  rateShop.clearFakPricingLiveCacheForTest();

  if (failures) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll assertions passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
