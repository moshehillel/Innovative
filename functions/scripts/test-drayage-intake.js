/* eslint-disable no-console */
"use strict";

const dray = require("../drayage-intake");
const bridge = require("../primus-ui-bridge");

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
check("account-code lookalike CODE1236247 rejected",
    dray.sanitizeContainerNumber("CODE1236247"), null);
check("SCAC+digits without U/J/Z rejected",
    dray.sanitizeContainerNumber("SAIA1236247"), null);
check("extract labeled container",
    dray.extractContainerFromText("", "Container # ABDU1234567"),
    "ABDU1234567");
check("acct code subject not extracted as container",
    dray.extractContainerFromText(
        "Fwd: Invoices / J I Distributors Acct code 1236247",
        ""),
    null);
check("find on invoice item",
    dray.findContainerOnInvoiceItems([{containerNumber: "HLCU7654321"}]),
    "HLCU7654321");
check("fake CODE container on invoice item rejected",
    dray.findContainerOnInvoiceItems([{containerNumber: "CODE1236247"}]),
    null);
check("no container on truckload item",
    dray.findContainerOnInvoiceItems([{loadNumber: "265551"}]), null);
check("Leo is validator",
    dray.isDrayageValidatorEmail("Leo Smith <leo@innovativecarriers.com>"),
    true);
check("carrier not validator",
    dray.isDrayageValidatorEmail("Billing@EvansDelivery.com"), false);

check("drayage vendor type DRAYAGE",
    dray.isDrayageVendorType("DRAYAGE"), true);
check("drayage vendor type Drayage Broker",
    dray.isDrayageVendorType("Drayage Broker"), true);
check("LTL vendor type not drayage",
    dray.isDrayageVendorType("LTL"), false);
check("carrier name from invoice items",
    dray.carrierNameFromInvoiceItems(
        [{carrierName: "Saia Motor Freight Line, LLC"}]),
    "Saia Motor Freight Line, LLC");

// Loose substring "King" / "Transport" must NOT steal Golden King matches.
check("short King does not match Golden King Transport",
    (bridge.findMasterVendorByName(
        [{id: "1", name: "King", type: "DRAYAGE"}],
        "Golden King Transport") || {}).id || null,
    null);
check("exact Golden King wins over short King on same page",
    (bridge.findMasterVendorByName([
      {id: "1", name: "King", type: "DRAYAGE"},
      {id: "2", name: "Golden King Transport", type: "Truckload"},
    ], "Golden King Transport") || {}).id,
    "2");
check("LLC suffix still matches Golden King",
    (bridge.findMasterVendorByName(
        [{id: "2", name: "Golden King Transport LLC", type: "Truckload"}],
        "Golden King Transport") || {}).id,
    "2");

// Container alone never returns a routing container anymore.
check("Mark Evans inbound container alone does not route",
    dray.resolveInboundDrayageContainer(
        "Billing@EvansDelivery.com",
        [{containerNumber: "EGSU9876543", carrierName: "Mark Evans Delivery"}],
        null, "", ""),
    null);
check("Leo return not forwarded again",
    dray.resolveInboundDrayageContainer(
        "leo@innovativecarriers.com",
        [{containerNumber: "EGSU9876543", carrierName: "Mark Evans Delivery"}],
        null, "", ""),
    null);

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
    lookupVendor: async () => ({id: "1", name: "Loup", type: "Intermodal"}),
  });
  check("Loup ORIGINAL BILL not drayage", loupSignal.isDrayage, false);
  check("Loup still extracts container metadata",
      loupSignal.containerNumber, "MSCU1234567");

  // Regression: Jerry Leo template wording + container + Loup/UP From must NOT
  // force drayage when Primus vendor profile for the invoice carrier is not.
  // (User's EMHU642757 is 6 digits / non-ISO — use a valid ISO id for metadata.)
  const goldenKingSignal = await dray.resolveInboundDrayageSignal({
    from: "Loup <loupintermodalops@up.com>",
    invoiceItems: [{
      carrierName: "Golden King Transport",
      containerNumber: "EMHU6427571",
      invoiceAmount: 1200,
    }],
    probedContainer: "EMHU6427571",
    subject: "FW: Loup - ORIGINAL BILL",
    body: "See attached — drayage invoice. (Container #: EMHU6427571)\n" +
      "Carrier on invoice: Golden King Transport",
    lookupVendor: async (name) => {
      if (/golden\s*king/i.test(name || "")) {
        return {
          id: "gk1",
          name: "Golden King Transport",
          type: "Truckload",
        };
      }
      // Would be wrong if From domain / Loup matched instead of carrier name.
      return {id: "loup", name: "Loup Intermodal", type: "DRAYAGE"};
    },
  });
  check("Golden King + drayage wording + container not drayage",
      goldenKingSignal.isDrayage, false);
  check("Golden King still keeps container metadata",
      goldenKingSignal.containerNumber, "EMHU6427571");
  check("Golden King carrier name preserved",
      goldenKingSignal.carrierName, "Golden King Transport");

  const goldenKingShortCntr = await dray.resolveInboundDrayageSignal({
    from: "Loup <loupintermodalops@up.com>",
    invoiceItems: [{
      carrierName: "Golden King Transport",
      containerNumber: "EMHU642757",
    }],
    subject: "Loup - ORIGINAL BILL",
    body: "See attached — drayage invoice. (Container #: EMHU642757)",
    lookupVendor: async () =>
      ({id: "gk1", name: "Golden King Transport", type: "Truckload"}),
  });
  check("non-ISO EMHU642757 does not force drayage",
      goldenKingShortCntr.isDrayage, false);

  const goldenKingDrayage = await dray.resolveInboundDrayageSignal({
    from: "Loup <loupintermodalops@up.com>",
    invoiceItems: [{
      carrierName: "Golden King Transport",
      containerNumber: "EMHU6427571",
    }],
    subject: "Loup - ORIGINAL BILL",
    body: "See attached — drayage invoice.",
    lookupVendor: async (name) => ({
      id: "gk-dray",
      name: name,
      type: "DRAYAGE",
    }),
  });
  check("Golden King Primus DRAYAGE profile is drayage",
      goldenKingDrayage.isDrayage, true);
  check("Golden King drayage reason cites Primus vendor",
      /Primus vendor/i.test(goldenKingDrayage.reason || ""), true);

  const containerOnlySignal = await dray.resolveInboundDrayageSignal({
    from: "Billing@unknowncarrier.com",
    invoiceItems: [{containerNumber: "HLCU7654321"}],
    probedContainer: null,
    subject: "Invoice attached",
    body: "Container HLCU7654321",
    lookupVendor: async () => null,
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
    lookupVendor: async (name) => ({
      id: "99",
      name: name,
      type: "DRAYAGE",
    }),
  });
  check("Mark Evans Primus DRAYAGE vendor is drayage",
      markEvansSignal.isDrayage, true);
  check("Mark Evans drayage reason mentions Primus vendor",
      /Primus vendor/i.test(markEvansSignal.reason || ""), true);

  // Saia LTL forwarded by customer from gmail — must NOT use From domain.
  let lookupArgs = null;
  const saiaSignal = await dray.resolveInboundDrayageSignal({
    from: "J&I Distributers <jidistributors72@gmail.com>",
    invoiceItems: [{
      carrierName: "Saia Motor Freight Line, LLC",
      containerNumber: "CODE1236247",
      invoiceAmount: 412.5,
    }],
    probedContainer: null,
    subject: "Fwd: Invoices / J I Distributors Acct code 1236247",
    body: "",
    lookupVendor: async (name, from) => {
      lookupArgs = {name, from};
      return {id: "saia", name: "Saia Motor Freight Line", type: "LTL"};
    },
  });
  check("Saia LTL not drayage even with fake CODE container",
      saiaSignal.isDrayage, false);
  check("Saia fake CODE container stripped from metadata",
      saiaSignal.containerNumber, null);
  check("Saia lookup used carrier name",
      lookupArgs && lookupArgs.name, "Saia Motor Freight Line, LLC");

  // If Primus wrongly matched a gmail drayage vendor, name-only LTL wins.
  const gmailPoison = await dray.resolveInboundDrayageSignal({
    from: "J&I Distributers <jidistributors72@gmail.com>",
    invoiceItems: [{carrierName: "Saia Motor Freight Line, LLC"}],
    subject: "Fwd: Invoices",
    body: "",
    lookupVendor: async (name) => {
      if (/saia/i.test(name || "")) {
        return {id: "saia", name: "Saia", type: "LTL"};
      }
      // Would be wrong: matching a random gmail.com DRAYAGE vendor
      return {id: "bad", name: "Some Drayage Co", type: "DRAYAGE"};
    },
  });
  check("Saia name match LTL beats gmail poison vendor",
      gmailPoison.isDrayage, false);

  const missingCarrier = await dray.resolveInboundDrayageSignal({
    from: "J&I Distributers <jidistributors72@gmail.com>",
    invoiceItems: [{containerNumber: "CODE1236247"}],
    subject: "Acct code 1236247",
    body: "",
    lookupVendor: async () =>
      ({id: "bad", name: "Random Gmail Dray", type: "DRAYAGE"}),
  });
  check("no carrier name + fake container is not drayage",
      missingCarrier.isDrayage, false);
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
