/* eslint-disable no-console */
"use strict";

/**
 * Unit tests: Primus incomplete-rate retry + merge (D6181-style).
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

const checkTruthy = (name, got) => {
  const pass = !!got;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) console.log(`  got: ${JSON.stringify(got)}`);
};

// --- pure merge / shouldRetry ---
check(
    "dedupe key uses SCAC+service+rateType+mode",
    rateShop.primusRateDedupeKey({
      SCAC: "ctii", name: "J&I Central", serviceType: "LTL",
      rateType: "STANDARD", mode: "LTL",
    }),
    "CTII|ltl|standard|ltl");

const firstOnly = [
  {name: "Worldwide Express Central", SCAC: "WWEX", total: 520,
    rateType: "STANDARD", serviceType: "LTL", mode: "LTL"},
];
const retryAddsJi = [
  {name: "Worldwide Express Central", SCAC: "WWEX", total: 520,
    rateType: "STANDARD", serviceType: "LTL", mode: "LTL"},
  {name: "J&I Transportation Central", SCAC: "CTII", total: 268,
    rateType: "STANDARD", serviceType: "LTL", mode: "LTL"},
];
const merged = rateShop.mergePrimusRateRows(firstOnly, retryAddsJi);
check("merge adds missing J&I", merged.length, 2);
check("merge keeps WWEX", merged.some((r) => r.SCAC === "WWEX"), true);
check("merge keeps cheaper J&I",
    merged.find((r) => r.SCAC === "CTII").total, 268);

const cheaperRetry = rateShop.mergePrimusRateRows(
    [{SCAC: "CTII", name: "J&I", total: 300, rateType: "STANDARD",
      serviceType: "LTL", mode: "LTL"}],
    [{SCAC: "CTII", name: "J&I", total: 268, rateType: "STANDARD",
      serviceType: "LTL", mode: "LTL"}],
);
check("merge keeps cheaper total", cheaperRetry[0].total, 268);

check("shouldRetry: customer + rates → true",
    rateShop.shouldRetryIncompleteCustomerRates(firstOnly, {
      customerId: "123",
    }), true);
check("shouldRetry: no customer → false",
    rateShop.shouldRetryIncompleteCustomerRates(firstOnly, {
      customerId: null,
    }), false);
check("shouldRetry: empty rates → false",
    rateShop.shouldRetryIncompleteCustomerRates([], {
      customerId: "123",
    }), false);
check("shouldRetry: minRates sparse → true",
    rateShop.shouldRetryIncompleteCustomerRates(
        [{SCAC: "A", total: 1}], {customerId: "1", minRates: 10}), true);
check("shouldRetry: minRates enough → false",
    rateShop.shouldRetryIncompleteCustomerRates(
        Array.from({length: 12}, (_, i) => ({SCAC: "C" + i, total: i})),
        {customerId: "1", minRates: 10}), false);

const prevRetryEnv = process.env.QUOTE_PRIMUS_RATE_RETRY;
process.env.QUOTE_PRIMUS_RATE_RETRY = "0";
check("shouldRetry: disabled via env",
    rateShop.shouldRetryIncompleteCustomerRates(firstOnly, {
      customerId: "123",
    }), false);
if (prevRetryEnv == null) delete process.env.QUOTE_PRIMUS_RATE_RETRY;
else process.env.QUOTE_PRIMUS_RATE_RETRY = prevRetryEnv;

const noMerged = rateShop.mergePrimusNoRates(
    [{SCAC: "CTII", name: "J&I", error: "timeout"}],
    [{SCAC: "CTII", name: "J&I", error: "timeout"},
      {SCAC: "SAIA", name: "SAIA", error: "lane"}],
);
check("noRates dedupe", noMerged.length, 2);

(async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    if (calls === 1) {
      return {ok: true, rates: firstOnly, noRates: []};
    }
    return {ok: true, rates: retryAddsJi, noRates: []};
  };

  const withRetry = await rateShop.fetchMultipleRatesWithCustomerRetry(
      {customerId: "999", originZip: "76701"}, {fetchFn});
  check("withRetry called twice", calls, 2);
  checkTruthy("withRetry flagged", withRetry.primusRateRetried);
  check("withRetry merged count", (withRetry.rates || []).length, 2);
  check("withRetry has J&I 268",
      withRetry.rates.find((r) => r.SCAC === "CTII").total, 268);

  calls = 0;
  const noCust = await rateShop.fetchMultipleRatesWithCustomerRetry(
      {originZip: "76701"}, {fetchFn});
  check("no customerId → one call", calls, 1);
  check("no customerId → not retried", noCust.primusRateRetried, false);

  // rateLane integration: first Primus miss of cheap J&I, retry fills it
  const origFetch = rateShop.fetchMultipleRates;
  const origEnsure = rateShop.ensureDensityRulesLoaded;
  let laneCalls = 0;
  rateShop.ensureDensityRulesLoaded = async () => {};
  rateShop.fetchMultipleRates = async (params) => {
    if (!(params && params.customerId)) {
      return {rates: [], noRates: []};
    }
    laneCalls++;
    if (laneCalls === 1) {
      return {ok: true, rates: firstOnly, noRates: []};
    }
    return {ok: true, rates: retryAddsJi, noRates: []};
  };

  try {
    const lane = {
      shipper: {city: "Waco", state: "TX", zipCode: "76701", country: "US"},
      consignee: {
        city: "Edison", state: "NJ", zipCode: "08817", country: "US",
      },
      freightInfo: [{
        qty: 1, weight: 500, length: 48, width: 40, height: 48,
        class: "70", dimType: "PLT",
      }],
    };
    const rated = await quoteAutomation.rateLane(lane, {
      shippingLocationId: "cust-waco",
      rules: [],
    });
    checkTruthy("rateLane primusRateRetried", rated.primusRateRetried);
    check("rateLane retried once", laneCalls, 2);
    const ji = (rated.options || []).find((o) =>
      /CTII/i.test(String(o.SCAC || "")) ||
      /j\s*&\s*i/i.test(String(o.name || "")));
    checkTruthy("rateLane options include J&I after merge", ji);
    const warn = (rated.extractionWarnings || []).some((w) =>
      /primus rate retry/i.test(String(w)));
    checkTruthy("rateLane warns retry merged", warn);
  } finally {
    rateShop.fetchMultipleRates = origFetch;
    rateShop.ensureDensityRulesLoaded = origEnsure;
  }

  console.log(failures ? `\n${failures} FAILED` : "\nAll passed");
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
