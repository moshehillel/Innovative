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

check("school delivery + notify = accessorial (not reweigh)",
    ac.classifyAdditionalChargeReason({
      charges: [
        {label: "school_delivery", amount: 80},
        {label: "notify_charge", amount: 8},
      ],
      hasCertificate: true,
      freightMismatch: {mismatch: false},
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
check("subject uses ASCII hyphen (no em dash)",
    !email.subject.includes("\u2014") && email.subject.includes(" - "), true);
check("button A label mentions auto-email",
    email.html.includes("auto-email customer"), true);
check("button B label mentions updated rate / dispatcher",
    email.html.includes("enter updated rate") &&
    email.html.includes("dispatcher notifies customer"), true);

// 3b. Option A amount parsing
const badA = ac.parseCustomerChargeAmountFromRequest({});
check("option A missing amount fails", badA.ok, false);
const zeroA = ac.parseCustomerChargeAmountFromRequest({
  customerChargeAmount: "0",
});
check("option A zero amount fails", zeroA.ok, false);
const okA = ac.parseCustomerChargeAmountFromRequest({
  customerChargeAmount: "125.5",
});
check("option A amount parses", okA.ok && okA.amount === 125.5, true);

// 3c. Option B dispatcher ready template
const reminder = ac.buildDispatcherNotifyReminderEmail({
  dispatcherName: "Sam",
  loadNumber: "264172",
  carrierName: "Central Transport",
  customerName: "Miworld",
  charges: [{label: "Reweigh Fee", amount: 120}],
  chargesTotal: 120,
  customerRate: 545,
  customerBillLines: [{name: "Reweigh Fee", amount: 120}],
});
check("dispatcher reminder has ready template",
    reminder.html.includes("Ready-to-send customer email"), true);
check("dispatcher reminder has updated rate",
    reminder.html.includes("$665.00"), true);
check("dispatcher reminder subject ASCII",
    !reminder.subject.includes("\u2014") &&
    reminder.subject.includes(" - "), true);
const forward = ac.buildDispatcherCustomerNotifyTemplate({
  loadNumber: "264172",
  customerName: "Miworld",
  carrierName: "Central Transport",
  chargesTotal: 120,
  customerRate: 545,
  customerBillLines: [{name: "Reweigh Fee", amount: 120}],
  newCustomerRate: 665,
});
check("forward template mentions load",
    forward.html.includes("264172"), true);
check("forward template mentions new rate",
    forward.html.includes("$665.00"), true);
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

const accessorialDispute = ac.buildDisputeEmailDraft({
  loadNumber: "264186",
  carrierName: "AAA Cooper Transportation",
  proNumber: "73373011",
  invoiceNumber: "73373011",
  invoiceAmount: 298.26,
  expectedAmount: 210.26,
  charges: [
    {label: "school_delivery", amount: 80},
    {label: "notify_charge", amount: 8},
  ],
  category: ac.CHARGE_CATEGORY.WEIGHT_INSPECTION,
  freightMismatch: {
    mismatch: false,
    details: {
      primusWeightLbs: 456,
      primusClass: "125",
      invoiceWeightLbs: 456,
      invoiceClass: "125",
    },
  },
  hasCertificate: true,
});
check("accessorial dispute not reweigh wording",
    accessorialDispute.html.includes("reweigh/reclassification that does not"),
    false);
check("accessorial dispute names school delivery",
    accessorialDispute.html.includes("School delivery fee"), true);
check("accessorial dispute uses unauthorized wording",
    accessorialDispute.html.includes("not authorized"), true);

// 5. Small-charge filter and Primus partition
const breakdown = [
  {description: "Liftgate Service", total: 75},
  {description: "Detention", total: 50},
];
check("$5 charge ignored",
    ac.filterIgnorableSmallCharges([{label: "Notify", amount: 5}])
        .ignorable.length, 1);
check("$5.01 charge kept",
    ac.filterIgnorableSmallCharges([{label: "Notify", amount: 5.01}])
        .remaining.length, 1);
check("liftgate matched in Primus",
    ac.isChargeInPrimusBreakdown({label: "Liftgate", amount: 75}, breakdown),
    true);
check("unknown charge not in Primus",
    ac.isChargeInPrimusBreakdown({label: "School delivery", amount: 80},
        breakdown), false);
const mixed = ac.filterChargesForApproval([
  {label: "Notify", amount: 3},
  {label: "Liftgate", amount: 75},
  {label: "School delivery", amount: 80},
], breakdown);
check("mixed: one small ignored", mixed.ignorableSmall.length, 1);
check("mixed: one already in Primus", mixed.alreadyInPrimus.length, 1);
check("mixed: one net-new", mixed.notInPrimus.length, 1);
check("mixed: skipApproval false", mixed.skipApproval, false);
const allDone = ac.filterChargesForApproval([
  {label: "Notify", amount: 4},
  {label: "Liftgate", amount: 75},
], breakdown);
check("all filtered: skip approval", allDone.skipApproval, true);
check("all filtered: no net-new", allDone.chargesForAction.length, 0);

const emailExcluded = ac.buildAdditionalChargeApprovalEmail({
  baseUrl: "https://x.example.com",
  invoiceId: "inv123",
  loadNumber: "264172",
  carrierName: "Central",
  invoiceAmount: 550,
  primusAmount: 430,
  charges: [{label: "School delivery", amount: 80}],
  chargesTotal: 80,
  category: ac.CHARGE_CATEGORY.ACCESSORIAL,
  excludedInPrimusCount: 2,
});
check("email notes excluded Primus charges",
    emailExcluded.html.includes("2 charge(s) already on file"), true);

// 3d. W&I certificate label is single-escaped (not W&amp;amp;I)
const emailCert = ac.buildAdditionalChargeApprovalEmail({
  baseUrl: "https://x.example.com",
  invoiceId: "inv123",
  loadNumber: "266614",
  carrierName: "Central",
  invoiceAmount: 550,
  primusAmount: 430,
  charges: [{label: "Reweigh Fee", amount: 120}],
  chargesTotal: 120,
  category: ac.CHARGE_CATEGORY.WEIGHT_INSPECTION,
  hasCertificate: true,
});
check("W&I label single-escaped",
    emailCert.html.includes("W&amp;I certificate") &&
    !emailCert.html.includes("W&amp;amp;I"), true);
check("subject matches Lisa example shape",
    emailCert.subject.includes("Approval needed - additional charge on Load") &&
    emailCert.subject.includes("266614") &&
    emailCert.subject.includes("Weight / Reweigh / Inspection"), true);

// 3e. Carrier invoice PDF attachment picker
check("pick null when empty",
    ac.pickCarrierInvoiceAttachment([]), null);
check("pick null when no storagePath",
    ac.pickCarrierInvoiceAttachment([{filename: "a.pdf"}]), null);
const picked = ac.pickCarrierInvoiceAttachment([
  {filename: "invoice-266614.pdf", storagePath: "invoices/a.pdf",
    mimeType: "application/pdf"},
  {filename: "weight-cert.pdf", storagePath: "weightCert/b.pdf",
    mimeType: "application/pdf", docType: "WEIGHT_INSPECTION_CERT"},
]);
check("pick prefers invoice over weight cert",
    picked && picked.storagePath === "invoices/a.pdf", true);
check("pick skips cert-only list falls back",
    ac.pickCarrierInvoiceAttachment([{
      filename: "cert.pdf", storagePath: "weightCert/c.pdf",
      docType: "WEIGHT_INSPECTION_CERT",
    }]).storagePath, "weightCert/c.pdf");
const preferredFirst = ac.pickCarrierInvoiceAttachment([
  {filename: "carrier_invoice.pdf", storagePath: "invoices/inv.pdf"},
  {filename: "pod-photo.jpg", storagePath: "pods/p.jpg",
    mimeType: "image/jpeg", docType: "POD_IMAGE"},
]);
check("pick skips POD image",
    preferredFirst && preferredFirst.filename === "carrier_invoice.pdf", true);

// 6. Lumper validation — invoice total matches Primus (lumper included)
const westhill = ac.validateLumperAmount({
  invoiceAmount: 2901.20,
  recognizedCharges: [{type: "lumper", amount: 401.20}],
}, 2901.20);
check("265880: total matches Primus => valid", westhill.valid, true);
check("265880: totalMatchesPrimus flag", westhill.totalMatchesPrimus, true);
check("265880: base still computed", westhill.baseAmount, 2500);

// Base freight matches Primus when lumper is separate line item
const baseMatch = ac.validateLumperAmount({
  invoiceAmount: 2600,
  recognizedCharges: [{type: "lumper", amount: 100}],
}, 2500);
check("base matches Primus within tolerance", baseMatch.valid, true);
check("base match: totalMatchesPrimus false", baseMatch.totalMatchesPrimus, false);

// True mismatch — neither total nor base agrees with Primus
const realMismatch = ac.validateLumperAmount({
  invoiceAmount: 3000,
  recognizedCharges: [{type: "lumper", amount: 401.20}],
}, 2500);
check("real mismatch => invalid", realMismatch.valid, false);
check("real mismatch difference", Math.round(realMismatch.difference), 99);

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
