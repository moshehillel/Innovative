/* Children's Apparel invoice rate. No Firebase.
 * Run: node scripts/test-childrens-apparel-invoice.js */
"use strict";

const ca = require("../childrens-apparel-invoice");

let failures = 0;
/**
 * @param {string} name Label.
 * @param {*} actual Value.
 * @param {*} expected Expected value.
 */
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${actual}` +
    (ok ? "" : ` (expected ${expected})`));
}

check("min profit", ca.MIN_PROFIT, 225);
check("markup", ca.MARKUP_RATE, 0.35);
check("tolerance", ca.COST_MATCH_TOLERANCE, 25);

check("floor below $600",
    ca.customerRateFromCarrierCost(100), 325);
check("floor at $600",
    ca.customerRateFromCarrierCost(600), 825);
check("35% above the floor",
    ca.customerRateFromCarrierCost(700), 945);
check("35% on 1000",
    ca.customerRateFromCarrierCost(1000), 1350);
check("rejects zero",
    ca.customerRateFromCarrierCost(0), null);

check("match 25", ca.costsMatchWithinTolerance(125, 100), true);
check("miss 25.01", ca.costsMatchWithinTolerance(125.02, 100), false);
check("under by 118 is not a match",
    ca.costsMatchWithinTolerance(907, 1025), false);

const network = "Childrens Apparel Network";
const other = "Scent Theory";

const auto = ca.autoCustomerRate({
  customerName: network,
  carrierCost: 306.68,
  expectedCost: 306.68,
  hasPod: true,
});
check("auto rate", auto && auto.customerRate, 531.68);
check("auto source", auto && auto.rateSource, "childrens_apparel_markup");

check("no pod", ca.autoCustomerRate({
  customerName: network,
  carrierCost: 306.68,
  expectedCost: 306.68,
  hasPod: false,
}), null);

check("other customer", ca.autoCustomerRate({
  customerName: other,
  carrierCost: 306.68,
  expectedCost: 306.68,
  hasPod: true,
}), null);

check("outside band", ca.autoCustomerRate({
  customerName: network,
  carrierCost: 400,
  expectedCost: 300,
  hasPod: true,
}), null);

const widened = ca.acceptCostMatch(network, {
  ok: true,
  validAmount: false,
  submittedAmount: 120,
  primusQuotedAmount: 100,
  amount: 100,
});
check("25 dollar over is accepted", widened && widened.validAmount, true);
check("entered amount kept", widened && widened.enteredAmount, 120);

const stillOut = ca.acceptCostMatch(network, {
  ok: true,
  validAmount: false,
  submittedAmount: 200,
  primusQuotedAmount: 100,
});
check("over 25 stays invalid", stillOut && stillOut.validAmount, false);

const otherCust = ca.acceptCostMatch(other, {
  ok: true,
  validAmount: false,
  submittedAmount: 120,
  primusQuotedAmount: 100,
});
check("other customer stays invalid",
    otherCust && otherCust.validAmount, false);

const podBack = ca.planPodWaitResume({
  customerName: "Children's Apparel Network",
  carrierCost: 397.16,
  expectedCost: 397.63,
  hasPod: true,
  alreadyInvoiced: false,
});
check("pod resume", podBack.resume, true);
check("pod rate uses 225 floor", podBack.customerRate, 622.16);

const podWait = ca.planPodWaitResume({
  customerName: network,
  carrierCost: 397.16,
  expectedCost: 397.63,
  hasPod: false,
});
check("still waiting", podWait.resume, false);

const podOutside = ca.planPodWaitResume({
  customerName: network,
  carrierCost: 907,
  expectedCost: 1025,
  hasPod: true,
});
check("pod outside band still resumes", podOutside.resume, true);
check("pod outside band has no auto rate", podOutside.customerRate, null);

if (failures) {
  console.error(failures + " failed");
  process.exit(1);
}
console.log("all passed");
