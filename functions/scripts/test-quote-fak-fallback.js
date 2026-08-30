/* eslint-disable no-console */
"use strict";

/**
 * Unit tests: market-fallback path applies customer FAK (Mike) sell math.
 */

const rateShop = require("../quote-rate-shop");
const quoteAutomation = require("../quote-automation");

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

  await withStubbedRates(async () => {
    const mike = await quoteAutomation.rateLane(lane, {
      shippingLocationId: "779538209",
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

  if (failures) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll assertions passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
