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
check("Averitt PRO is not a container",
    dray.isPlausibleContainerNumber("AVRT1467163"), false);
check("SCAC+digits without U/J/Z rejected",
    dray.sanitizeContainerNumber("AVRT1467163"), null);
check("extract labeled container",
    dray.extractContainerFromText("", "Container # ABDU1234567"),
    "ABDU1234567");
check("Averitt PRO not extracted as container",
    dray.extractContainerFromText(
        "Averitt Invoice - Summary45673 (1 of 1)",
        "PRO AVRT1467163"),
    null);
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
check("carrier name from invoice items",
    dray.carrierNameFromInvoiceItems(
        [{carrierName: "Evans Delivery Company"}]),
    "Evans Delivery Company");

async function runAsyncChecks() {
  const primusByName = async (carrierName) => {
    const name = String(carrierName || "").toLowerCase();
    if (name.includes("mark evans")) {
      return {id: "1", name: "Mark Evans Delivery", type: "DRAYAGE"};
    }
    if (name.includes("averitt")) {
      return {id: "2", name: "Averitt Express", type: "LTL"};
    }
    if (name.includes("loup")) {
      return {id: "3", name: "Loup", type: "RAIL"};
    }
    return null;
  };

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
    lookupVendor: primusByName,
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
    lookupVendor: primusByName,
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
    lookupVendor: primusByName,
  });
  check("Mark Evans Primus DRAYAGE vendor is drayage",
      markEvansSignal.isDrayage, true);
  check("Mark Evans reason cites Primus vendor",
      /Primus vendor/i.test(markEvansSignal.reason || ""), true);

  const averittSignal = await dray.resolveInboundDrayageSignal({
    from: "invoicing@averittexpress.com",
    invoiceItems: [{
      carrierName: "Averitt Express",
      containerNumber: "AVRT1467163",
    }],
    probedContainer: "AVRT1467163",
    subject: "Averitt Invoice - Summary45673 (1 of 1)",
    body: "Container #: AVRT1467163",
    lookupVendor: primusByName,
  });
  check("Averitt Primus LTL vendor is not drayage",
      averittSignal.isDrayage, false);
  check("Averitt Primus type is LTL", averittSignal.vendorType, "LTL");
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
