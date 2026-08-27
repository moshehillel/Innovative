/* eslint-disable no-console */
"use strict";

const dray = require("../drayage-intake");

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

check("ISO container accepted",
    dray.isPlausibleContainerNumber("MSCU1234567"), true);
check("container normalized",
    dray.sanitizeContainerNumber("mscu 1234567"), "MSCU1234567");
check("random load rejected",
    dray.isPlausibleContainerNumber("265551"), false);
check("extract labeled container",
    dray.extractContainerFromText("", "Container # ABCD1234567"),
    "ABCD1234567");
check("find on invoice item",
    dray.findContainerOnInvoiceItems([{containerNumber: "HLCU7654321"}]),
    "HLCU7654321");
check("no container on truckload item",
    dray.findContainerOnInvoiceItems([{loadNumber: "265551"}]), null);
check("Leo is validator",
    dray.isDrayageValidatorEmail("Leo Smith <leo@innovativecarriers.com>"),
    true);
check("carrier not validator",
    dray.isDrayageValidatorEmail("Billing@EvansDelivery.com"), false);
check("Mark Evans inbound container",
    dray.resolveInboundDrayageContainer(
        "Billing@EvansDelivery.com",
        [{containerNumber: "EGSU9876543", carrierName: "Mark Evans Delivery"}],
        null, "", ""),
    "EGSU9876543");
check("Evans Delivery Company not configured drayage container",
    dray.resolveInboundDrayageContainer(
        "Billing@EvansDelivery.com",
        [{containerNumber: "EGSU9876543", carrierName: "Evans Delivery Company"}],
        null, "", ""),
    null);
check("Leo return not forwarded again",
    dray.resolveInboundDrayageContainer(
        "leo@innovativecarriers.com",
        [{containerNumber: "EGSU9876543", carrierName: "Mark Evans Delivery"}],
        null, "", ""),
    null);

check("drayage vendor type DRAYAGE",
    dray.isDrayageVendorType("DRAYAGE"), true);
check("drayage vendor type Drayage Broker",
    dray.isDrayageVendorType("Drayage Broker"), true);
check("LTL vendor type not drayage",
    dray.isDrayageVendorType("LTL"), false);
check("Mark Evans Delivery is configured drayage",
    dray.isConfiguredDrayageCarrierName("Mark Evans Delivery"), true);
check("Mark Evans variant is configured drayage",
    dray.isConfiguredDrayageCarrierName("Mark Evans"), true);
check("MARK EVANS DELIVERY uppercase",
    dray.isConfiguredDrayageCarrierName("MARK EVANS DELIVERY"), true);
check("Mark Evans Delivery LLC",
    dray.isConfiguredDrayageCarrierName("Mark Evans Delivery LLC"), true);
check("Evans Delivery Company not Mark Evans",
    dray.isConfiguredDrayageCarrierName("Evans Delivery Company"), false);
check("carrier name from invoice items",
    dray.carrierNameFromInvoiceItems(
        [{carrierName: "Evans Delivery Company"}]),
    "Evans Delivery Company");

async function runAsyncChecks() {
  const loupSignal = await dray.resolveInboundDrayageSignal({
    from: "Loup <loupintermodalops@up.com>",
    invoiceItems: [{
      carrierName: "Loup",
      containerNumber: "MSCU1234567",
      invoiceAmount: 850,
    }],
    probedContainer: "MSCU1234567",
    subject: "Loup - ORIGINAL BILL",
    body: "Please see attached original bill.",
  });
  check("Loup ORIGINAL BILL not drayage", loupSignal.isDrayage, false);
  check("Loup still extracts container metadata",
      loupSignal.containerNumber, "MSCU1234567");

  const containerOnlySignal = await dray.resolveInboundDrayageSignal({
    from: "Billing@unknowncarrier.com",
    invoiceItems: [{containerNumber: "HLCU7654321"}],
    probedContainer: null,
    subject: "Invoice attached",
    body: "Container HLCU7654321",
  });
  check("container alone does not trigger drayage",
      containerOnlySignal.isDrayage, false);

  const markEvansSignal = await dray.resolveInboundDrayageSignal({
    from: "Billing@EvansDelivery.com",
    invoiceItems: [{
      carrierName: "Mark Evans Delivery",
      containerNumber: "EGSU9876543",
    }],
    probedContainer: null,
    subject: "Invoice",
    body: "",
  });
  check("Mark Evans configured carrier is drayage",
      markEvansSignal.isDrayage, true);
  check("Mark Evans drayage reason mentions carrier",
      /configured carrier/i.test(markEvansSignal.reason || ""), true);
}

runAsyncChecks().then(() => {
  const leoBody =
  "Hi,\n\nThis invoice is for load number: 265551\n\n" +
  "Enter in Primus:\nVendor name: Evans Delivery Company\n\n" +
  "Charges:\n- Line haul: $450.00\n- Fuel surcharge: $75.00\n\n" +
  "Customer rate should be: $600.00\n";
  const leoParsed = dray.parseLeoReturnInstructions(leoBody, "");
  check("Leo load parsed", leoParsed.loadNumber, "265551");
  check("Leo vendor parsed", leoParsed.vendorName, "Evans Delivery Company");
  check("Leo customer rate parsed", leoParsed.customerRate, 600);
  check("Leo charge count", leoParsed.charges.length, 2);
  check("Leo instructions valid",
      dray.validateLeoInstructions(leoParsed).ok, true);
  const applied = dray.applyLeoInstructionsToInvoiceItem({}, leoParsed);
  check("Leo applied load", applied.loadNumber, "265551");
  check("Leo applied flag", applied.drayageLeoValidated, true);
  check("Leo forward note mentions accounting",
      dray.buildLeoForwardNotes({containerNumber: "MSCU1234567"})
          .includes("accounting@innovativecarriers.com"),
      true);

  if (failures) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll drayage intake tests passed");
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
