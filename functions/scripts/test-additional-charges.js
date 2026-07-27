/* Quick smoke test for additional-charges.js (no Firebase needed for
 * the pure functions). Run: node scripts/test-additional-charges.js */
process.env.EMAIL_ACTION_SECRET = process.env.EMAIL_ACTION_SECRET ||
  "test-secret";
const ac = require("../additional-charges");

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${actual}` +
    (ok ? "" : ` (expected ${expected})`));
};

// 1. Category classification
check("reweigh fee label",
    ac.classifyAdditionalChargeReason({
      charges: [{label: "Reweigh Fee", amount: 45}],
    }), ac.CHARGE_CATEGORY.WEIGHT_INSPECTION);

check("W&I label",
    ac.classifyAdditionalChargeReason({
      charges: [{label: "W&I Charge", amount: 30}],
    }), ac.CHARGE_CATEGORY.WEIGHT_INSPECTION);

check("certificate flag",
    ac.classifyAdditionalChargeReason({
      charges: [{label: "Adjustment", amount: 80}],
      hasCertificate: true,
    }), ac.CHARGE_CATEGORY.WEIGHT_INSPECTION);

check("liftgate accessorial",
    ac.classifyAdditionalChargeReason({
      charges: [{label: "Liftgate Service", amount: 75}],
    }), ac.CHARGE_CATEGORY.ACCESSORIAL);

check("no rows = rate increase",
    ac.classifyAdditionalChargeReason({charges: []}),
    ac.CHARGE_CATEGORY.RATE_INCREASE);

// 2. Freight mismatch drives W&I
const mismatch = ac.detectFreightMismatch(
    {totalWeightLbs: 1200, freightClass: "125"},
    {totalWeight: 800, freightInfo: [{class: "92.5", weight: 800}]},
);
check("weight mismatch detected", mismatch.weightMismatch, true);
check("class mismatch detected", mismatch.classMismatch, true);
check("mismatch => weight_inspection",
    ac.classifyAdditionalChargeReason({
      charges: [{label: "Adjustment", amount: 100}],
      freightMismatch: mismatch,
    }), ac.CHARGE_CATEGORY.WEIGHT_INSPECTION);

const noMismatch = ac.detectFreightMismatch(
    {totalWeightLbs: 810, freightClass: "92.5"},
    {totalWeight: 800, freightInfo: [{class: "92.5", weight: 800}]},
);
check("close weight = no mismatch", noMismatch.mismatch, false);

// 2b. Re-quote freight + match evaluation
const booking = {
  vendor: {id: 99, name: "Central"},
  UOM: "US",
  shipper: {city: "CHICAGO", state: "IL", zipCode: "60606", country: "USA"},
  consignee: {city: "NEW YORK", state: "NY", zipCode: "10001", country: "USA"},
  freightInfo: [{qty: 1, weight: 800, class: 70, length: 48, width: 40,
    height: 48, dimType: "PLT", commodity: "goods"}],
};
const freight = ac.buildRequoteFreightInfo(
    booking, {totalWeightLbs: 1200, freightClass: "125"});
check("requote weight override", freight[0].weight, 1200);
check("requote class override", freight[0].class, "125");
check("requote weightType", freight[0].weightType, "total");
const query = ac.buildRateQueryFromBooking(booking, freight);
check("rate query vendorId", query.vendorId, "99");
check("rate query originCity", query.originCity, "CHICAGO");
const match = ac.evaluateRequoteMatch({
  invoiceAmount: 220, rateTotal: 216.76, tolerance: 10,
});
check("rate match within $10", match.matched, true);
const noMatch = ac.evaluateRequoteMatch({
  invoiceAmount: 350, rateTotal: 216.76,
});
check("rate mismatch over $10", noMatch.matched, false);

// 3. Approval email contains all four buttons (signed confirm links)
const email = ac.buildAdditionalChargeApprovalEmail({
  baseUrl: "https://x.example.com",
  invoiceId: "inv123",
  tenantId: "innovative",
  loadNumber: "264172",
  carrierName: "Central Transport",
  customerName: "Miworld",
  invoiceAmount: 550,
  primusAmount: 430,
  charges: [{label: "Reweigh Fee", amount: 120}],
  chargesTotal: 120,
  category: ac.CHARGE_CATEGORY.WEIGHT_INSPECTION,
  customerRate: 545,
  freightMismatch: mismatch,
  hasCertificate: true,
  dispatcherName: "John D",
  rateValidation: {
    attempted: true, ok: true, matched: false, tolerance: 10,
    invoiceAmount: 550, rateTotal: 430, difference: 120,
    quoteNumber: "48025106",
  },
});
check("email shows re-rate mismatch",
    email.html.includes("does NOT match"), true);
check("email shows quote number",
    email.html.includes("48025106"), true);
check("email shows customer rate", email.html.includes("$545.00"), true);
check("email shows customer rate label",
    email.html.includes("Customer rate (Primus)"), true);
for (const opt of ["a", "b", "c", "d"]) {
  check(`button ${opt} has action`,
      email.html.includes("additionalChargeAction") &&
      email.html.includes(`invoiceId=inv123`) &&
      email.html.includes(`option=${opt}`), true);
  check(`button ${opt} signed`,
      email.html.includes("&amp;sig=") && email.html.includes("&amp;exp="),
      true);
}
check("subject has load", email.subject.includes("264172"), true);

// 4. Dispute draft
const dispute = ac.buildDisputeEmailDraft({
  loadNumber: "264172",
  carrierName: "Central Transport",
  proNumber: "111-222",
  invoiceNumber: "CT-9",
  invoiceAmount: 550,
  expectedAmount: 430,
  charges: [],
  category: ac.CHARGE_CATEGORY.RATE_INCREASE,
});
check("dispute mentions difference", dispute.html.includes("$120.00"), true);
check("dispute mentions agreed rate",
    dispute.html.includes("agreed rate"), true);

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
