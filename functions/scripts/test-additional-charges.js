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

// Notify detention N days = storage (AAA Cooper / amount-gap emails)
const ndParsed = ac.parseNotifyDetentionStorage("NOTIFY DETENTION: 2 DAYS");
check("notify detention parses as storage",
    !!(ndParsed && ndParsed.isStorage), true);
check("notify detention parses 2 days",
    ndParsed && ndParsed.days, 2);
check("display notify detention as 2 days storage",
    ac.displayChargeLabel("NOTIFY DETENTION: 2 DAYS"),
    "2 days storage");
check("display notify_detention alias as Storage",
    ac.displayChargeLabel("notify_detention"), "Storage");
const ndSummary = ac.summarizeNotifyDetentionStorage([
  {label: "NOTIFY DETENTION: 2 DAYS", amount: 166.45},
]);
check("storage summary days", ndSummary && ndSummary.days, 2);
check("storage summary amount",
    ndSummary && Number(ndSummary.amount.toFixed(2)), 166.45);
check("storage explanation wording",
    ac.formatNotifyDetentionStorageExplanation(ndSummary),
    "The carrier is charging 2 days storage totaling $166.45.");
const rehomed = ac.rehomeNotifyDetentionToUnrecognized([
  {label: "NOTIFY DETENTION: 2 DAYS", amount: 171.80},
  {label: "Lumper", amount: 50},
], [{label: "Residential", amount: 75}]);
check("rehome moves notify detention out of recognized",
    rehomed.recognizedCharges.length === 1 &&
    /lumper/i.test(rehomed.recognizedCharges[0].label), true);
check("rehome puts notify detention in unrecognized",
    rehomed.unrecognizedCharges.some((c) =>
      /notify/i.test(String(c.label || ""))), true);
const emailStorage = ac.buildAdditionalChargeApprovalEmail({
  baseUrl: "https://x.example.com",
  invoiceId: "inv268391",
  tenantId: "innovative",
  loadNumber: "268391",
  carrierName: "AAA Cooper Transportation",
  invoiceAmount: 786.05,
  primusAmount: 619.60,
  charges: [{label: "NOTIFY DETENTION: 2 DAYS", amount: 166.45}],
  chargesTotal: 166.45,
  category: ac.CHARGE_CATEGORY.ACCESSORIAL,
  dispatcherName: "Sam Dispatcher",
});
check("approval email states 2 days storage totaling",
    emailStorage.html.includes(
        "The carrier is charging 2 days storage totaling $166.45."),
    true);
check("approval email charge line uses storage label",
    emailStorage.html.includes("2 days storage") &&
    emailStorage.html.includes("$166.45"), true);
check("approval email still names dispatcher",
    emailStorage.html.includes("Sam Dispatcher"), true);

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

const quotedBooking = {
  totalWeight: 3200,
  freightInfo: [{qty: 1, weight: 3200, class: "70", length: 40, width: 48,
    height: 30}],
};
const updatedFreight = {
  totalWeightLbs: 4372, freightClass: "70", pieces: 1,
  length: 40, width: 48, height: 30,
};
const rebillFreight = ac.buildRequoteFreightInfo(quotedBooking, updatedFreight);
check("requote keeps updated weight", rebillFreight[0].weight, 4372);
check("requote uses invoice dims length", rebillFreight[0].length, 40);
check("requote uses invoice dims height", rebillFreight[0].height, 30);
const dimChange = ac.detectFreightMismatch(
    {totalWeightLbs: 3200, freightClass: "70", length: 40, width: 48,
      height: 40},
    quotedBooking,
);
check("dim mismatch detected", dimChange.dimMismatch, true);
check("dim mismatch is a freight mismatch", dimChange.mismatch, true);
const sameDims = ac.detectFreightMismatch(updatedFreight, quotedBooking);
check("weight increase is a mismatch", sameDims.weightMismatch, true);
check("same dims are not a dim mismatch", sameDims.dimMismatch, false);
check("added charge is invoice minus quote",
    ac.computeAddedCharge(1500, 1100), 400);
check("replacement invoice when weight changed",
    ac.isReplacementWeightInvoice({
      invoiceAmount: 1500,
      primusAmount: 1100,
      freightMismatch: sameDims,
    }), true);
check("close invoice is not a replacement rebill",
    ac.isReplacementWeightInvoice({
      invoiceAmount: 1105,
      primusAmount: 1100,
      freightMismatch: sameDims,
    }), false);
check("certificate dollar amount is pricing",
    ac.certificateTextHasPricing("Inspection result $1,250.00").hasPricing,
    true);
check("certificate weight and dims are not pricing",
    ac.certificateTextHasPricing(
        "Weight 4372 lbs Class 70 Dims 40 x 48 x 30").hasPricing,
    false);
check("blank certificate text is not readable",
    ac.certificateTextHasPricing("  ").hasText, false);

// 3. Approval email contains all five buttons (signed confirm links)
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
check("email shows additional charge formula",
    email.html.includes("invoice total minus the Primus quoted total"),
    true);
check("email shows original quote weight",
    email.html.includes("Original quote weight"), true);
check("email says not correct when re-quote is lower",
    email.html.includes("Not correct."), true);
check("email shows quote number",
    email.html.includes("48025106"), true);
check("email shows customer rate", email.html.includes("$545.00"), true);
check("email shows customer rate label",
    email.html.includes("Customer rate (Primus)"), true);
for (const opt of ["a", "b", "c", "d", "e"]) {
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
check("button E label mentions no separate notification",
    email.html.includes("no separate customer notification"), true);
check("footer explains E vs A",
    email.html.includes("like A") &&
    email.html.includes("no separate customer notification") &&
    email.html.includes("included when the customer invoice is sent"), true);
check("email HTML has no raw em dash",
    !email.html.includes("\u2014") && !email.html.includes("â€"), true);

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
const emailRebill = ac.buildAdditionalChargeApprovalEmail({
  baseUrl: "https://x.example.com",
  invoiceId: "inv265500",
  tenantId: "innovative",
  loadNumber: "265500",
  carrierName: "Central Transport",
  invoiceAmount: 1500,
  primusAmount: 1100,
  charges: [],
  chargesTotal: 400,
  category: ac.CHARGE_CATEGORY.WEIGHT_INSPECTION,
  freightMismatch: sameDims,
  hasCertificate: true,
  weightRebill: ac.buildWeightRebillSummary({
    booking: quotedBooking,
    invoiceFreight: updatedFreight,
    invoiceAmount: 1500,
    primusAmount: 1100,
  }),
  rateValidation: {
    attempted: true, ok: true, matched: true, tolerance: 10,
    invoiceAmount: 1500, rateTotal: 1495, difference: 5,
    quoteNumber: "9001",
  },
  certificateStatus: {
    present: true,
    hasPricing: true,
    uploaded: false,
    withheldReason: "pricing",
  },
});
check("rebill email states added charge dollars",
    emailRebill.html.includes("$400.00"), true);
check("rebill email states original weight",
    emailRebill.html.includes("3,200 lbs"), true);
check("rebill email states updated weight",
    emailRebill.html.includes("4,372 lbs"), true);
check("rebill email says the new quote is correct",
    emailRebill.html.includes("Correct."), true);
check("rebill email says certificate was not uploaded for pricing",
    emailRebill.html.includes("not uploaded") &&
    emailRebill.html.includes("pricing on it"), true);
const emailUploaded = ac.buildAdditionalChargeApprovalEmail({
  baseUrl: "https://x.example.com",
  invoiceId: "inv265500",
  loadNumber: "265500",
  carrierName: "Central Transport",
  invoiceAmount: 1500,
  primusAmount: 1100,
  charges: [],
  chargesTotal: 400,
  category: ac.CHARGE_CATEGORY.WEIGHT_INSPECTION,
  hasCertificate: false,
  certificateStatus: {present: false, uploaded: false},
});
check("missing certificate is stated",
    emailUploaded.html.includes("not included"), true);

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

const ctBatch = ac.pickCarrierInvoiceAttachment([
  {filename: "497042887.1         .pdf",
    storagePath: "batch/497042887.pdf", mimeType: "application/pdf"},
  {filename: "446757676.1         .pdf",
    storagePath: "batch/446757676.pdf", mimeType: "application/pdf"},
], {proNumber: "446757676", attachmentFilename: "446757676.1.pdf"});
check("CT batch picks PRO-matching PDF not first sibling",
    ctBatch && ctBatch.storagePath === "batch/446757676.pdf", true);
check("CT batch fuzzy attachmentFilename with padded spaces",
    ctBatch && ctBatch.filename.includes("446757676"), true);

const ctWrong = ac.pickCarrierInvoiceAttachment([
  {filename: "497042887.1         .pdf",
    storagePath: "batch/497042887.pdf", mimeType: "application/pdf"},
  {filename: "446757676.1         .pdf",
    storagePath: "batch/446757676.pdf", mimeType: "application/pdf"},
], {proNumber: "497042887"});
check("CT batch first sibling when PRO matches first file",
    ctWrong && ctWrong.storagePath === "batch/497042887.pdf", true);

const ctNoFallback = ac.pickCarrierInvoiceAttachment([
  {filename: "497042887.1.pdf",
    storagePath: "batch/497042887.pdf", mimeType: "application/pdf"},
  {filename: "446757676.1.pdf",
    storagePath: "batch/446757676.pdf", mimeType: "application/pdf"},
], {proNumber: "999999999"});
check("CT batch no fallback to sibling when PRO unmatched", ctNoFallback, null);

const proMismatch = ac.validateCarrierInvoiceAttachment({
  filename: "497042887.1.pdf",
  storagePath: "batch/497042887.pdf",
}, {proNumber: "446757676"});
check("validate rejects sibling PRO filename", proMismatch.ok, false);
check("validate pro_mismatch reason", proMismatch.reason, "pro_mismatch");

// 3f. Approval emails attach full carrier packet + W&I cert (not invoice-only)
const approvalAtts = ac.listAdditionalChargeApprovalAttachments([
  {filename: "446757676.1.pdf", storagePath: "inv/full.pdf",
    mimeType: "application/pdf", docType: "INVOICE"},
  {filename: "weight-cert.pdf", storagePath: "weightCert/b.pdf",
    mimeType: "application/pdf", docType: "WEIGHT_INSPECTION_CERT"},
  {filename: "pod-photo.jpg", storagePath: "pods/p.jpg",
    mimeType: "image/jpeg", docType: "POD_IMAGE"},
], {proNumber: "446757676", attachmentFilename: "446757676.1.pdf"});
check("approval list includes invoice PDF",
    approvalAtts.some((a) => a.storagePath === "inv/full.pdf"), true);
check("approval list includes W&I cert backup",
    approvalAtts.some((a) => a.storagePath === "weightCert/b.pdf"), true);
check("approval list skips POD image",
    approvalAtts.every((a) => a.storagePath !== "pods/p.jpg"), true);
check("approval list has invoice then cert (2 files)",
    approvalAtts.length, 2);

const approvalBatchSafe = ac.listAdditionalChargeApprovalAttachments([
  {filename: "497042887.1.pdf", storagePath: "batch/497.pdf"},
  {filename: "446757676.1.pdf", storagePath: "batch/446.pdf"},
], {proNumber: "999999999"});
check("approval list empty when PRO unmatched in batch",
    approvalBatchSafe.length, 0);

const approvalInvoiceOnly = ac.listAdditionalChargeApprovalAttachments([
  {filename: "446757676.1.pdf", storagePath: "inv/full.pdf",
    mimeType: "application/pdf"},
], {proNumber: "446757676"});
check("approval list works with invoice alone",
    approvalInvoiceOnly.length === 1 &&
    approvalInvoiceOnly[0].storagePath === "inv/full.pdf", true);

// 6. Lumper validation — invoice total matches Primus (lumper included)
const westhill = ac.validateLumperAmount({
  invoiceAmount: 2901.20,
  recognizedCharges: [{type: "lumper", amount: 401.20}],
}, 2901.20);
check("265880: total matches Primus => valid", westhill.valid, true);
check("265880: totalMatchesPrimus flag", westhill.totalMatchesPrimus, true);
check("265880: base still computed", westhill.baseAmount, 2500);

// Lucky Way 266823 — freight $300 + lumper $203.11 = invoice $503.11 = Primus
const luckyWay = ac.validateLumperAmount({
  invoiceAmount: 503.11,
  charges: [{type: "lumper", amount: 203.11}],
}, 503.11);
check("266823 Lucky Way: total matches Primus => valid", luckyWay.valid, true);
check("266823 Lucky Way: totalMatchesPrimus", luckyWay.totalMatchesPrimus, true);
check("266823 Lucky Way: reads lumper from legacy charges[]",
    luckyWay.totalLumper, 203.11);
check("266823 invoiceTotalMatchesPrimusCost helper",
    ac.invoiceTotalMatchesPrimusCost(503.11, 503.11), true);
check("266823 money-string Primus cost still matches",
    ac.invoiceTotalMatchesPrimusCost("$503.11", "503.11"), true);

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

// 7. Primus amount match — $10 floor (Roadtex 268077 / statement 555194)
// Diff $8.70 is under $10 but over old 2%-only band (~$7.95) — must match.
const roadtex = ac.evaluatePrimusAmountMatch(406.02, 397.32);
check("268077 Roadtex: under-$10 overage is valid", roadtex.valid, true);
check("268077 Roadtex: difference ~8.70",
    Math.round(roadtex.difference * 100) / 100, 8.70);
check("268077 Roadtex: tolerance at least $10",
    roadtex.tolerance >= 10, true);
check("exact match still valid",
    ac.evaluatePrimusAmountMatch(397.32, 397.32).valid, true);
check("carrier under Primus always valid",
    ac.evaluatePrimusAmountMatch(350, 397.32).valid, true);
check("over $10 without 2% room is invalid",
    ac.evaluatePrimusAmountMatch(410, 397.32).valid, false);
// Large invoice: 2% ($20 on $1000) still allows more than the $10 floor
check("large invoice uses 2% when bigger than $10",
    ac.evaluatePrimusAmountMatch(1015, 1000).valid, true);
check("large invoice still rejects beyond 2%",
    ac.evaluatePrimusAmountMatch(1025, 1000).valid, false);

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
