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
check("combined LTL, DRAYAGE string is drayage",
    dray.isDrayageVendorType("LTL, DRAYAGE"), true);
check("combined LTL / DRAYAGE string is drayage",
    dray.isDrayageVendorType("LTL / DRAYAGE"), true);
check("type list LTL and DRAYAGE is drayage",
    dray.isDrayageVendorType(["LTL", "DRAYAGE"]), true);
check("type list LTL and FTL is not drayage",
    dray.isDrayageVendorType(["LTL", "FTL"]), false);
check("numeric shipment mode id is not drayage",
    dray.isDrayageVendorType({type: "LTL", shipmentMode: "590"}), false);
check("Blitz Transportation Services is a known drayage name",
    dray.isKnownDrayageCarrierName("Blitz Transportation Services"), true);
check("exact Blitz is a known drayage name",
    dray.isKnownDrayageCarrierName("Blitz"), true);
check("Saia is not a known drayage name",
    dray.isKnownDrayageCarrierName("Saia Motor Freight Line, LLC"), false);
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
check("PierPASS slash bill-to matches Pier Pass, not Innovative Carriers",
    (bridge.findMasterVendorByName([
      {id: "9", name: "Innovative Carriers", type: "DRAYAGE"},
      {id: "113303", name: "Pier Pass", type: "Vendor"},
    ], "PierPASS/INNOVATIVE CARRIERS") || {}).id,
    "113303");
check("PierPASS header is a port fee carrier",
    dray.isPortFeeCarrierName("PierPASS/INNOVATIVE CARRIERS"), true);

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

  const pierPassSignal = await dray.resolveInboundDrayageSignal({
    from: "Pierpass.OffPeak-Invoice@pierpass.net",
    invoiceItems: [{
      carrierName: "PierPASS/INNOVATIVE CARRIERS",
      invoiceAmount: 893.86,
    }],
    subject: "Account 84389: Your PierPass Invoice 84389-10213171-IN",
    body: "",
    lookupVendor: async () => ({
      id: "9",
      name: "Innovative Carriers",
      type: "DRAYAGE",
      types: ["LTL", "FTL", "DRAYAGE", "Vendor"],
    }),
  });
  check("Pier Pass invoice is not forwarded as drayage",
      pierPassSignal.isDrayage, false);

  const ownCompany = await dray.resolveInboundDrayageSignal({
    from: "ap@hivoltselectrical.com",
    invoiceItems: [{
      carrierName: "Innovative Carriers",
      invoiceAmount: 500,
    }],
    subject: "RE: Invoice #29882 for BOL #267608",
    body: "",
    lookupVendor: async () => ({
      id: "9",
      name: "Innovative Carriers",
      type: "DRAYAGE",
      types: ["LTL", "FTL", "DRAYAGE", "Vendor"],
    }),
  });
  check("Innovative Carriers own vendor is not inbound drayage",
      ownCompany.isDrayage, false);
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

  // Primus stores Blitz Transportation Services as LTL. Invoices still
  // route to Leo because the carrier name is drayage.
  const blitzLtl = await dray.resolveInboundDrayageSignal({
    from: "Orders <orders@blitztransportation.com>",
    invoiceItems: [{
      carrierName: "Blitz Transportation Services",
      carrierBolNumber: "YMJAE209084570",
      invoiceAmount: 1030,
    }],
    subject: "Invoice Number BL314661",
    body: "",
    lookupVendor: async () => ({
      id: "113646",
      name: "Blitz Transportation Services",
      type: "LTL",
    }),
  });
  check("Blitz LTL Primus type is still drayage by carrier name",
      blitzLtl.isDrayage, true);
  check("Blitz reason cites carrier name",
      /Blitz Transportation Services/i.test(blitzLtl.reason || ""), true);
  check("Blitz LTL is not flagged as Primus vendor type",
      blitzLtl.drayageByVendorType, false);

  // Profile shows LTL and DRAYAGE together. List type alone is LTL.
  const multiType = await dray.resolveInboundDrayageSignal({
    from: "Billing <billing@examplehaul.com>",
    invoiceItems: [{
      carrierName: "Example Haul LLC",
      invoiceAmount: 900,
    }],
    subject: "Invoice",
    body: "",
    lookupVendor: async () => ({
      id: "42",
      name: "Example Haul LLC",
      type: "LTL",
      types: ["LTL", "DRAYAGE"],
    }),
  });
  check("LTL plus DRAYAGE type list is drayage",
      multiType.isDrayage, true);
  check("multi-type match is from Primus vendor type",
      multiType.drayageByVendorType, true);
  check("multi-type reason cites Primus vendor",
      /Primus vendor/i.test(multiType.reason || ""), true);

  const combinedString = await dray.resolveInboundDrayageSignal({
    from: "Billing <billing@examplehaul.com>",
    invoiceItems: [{carrierName: "Example Haul LLC"}],
    subject: "Invoice",
    body: "",
    lookupVendor: async () => ({
      id: "43",
      name: "Example Haul LLC",
      type: "LTL, DRAYAGE",
    }),
  });
  check("LTL, DRAYAGE type string is drayage",
      combinedString.isDrayage, true);
  check("combined string is Primus vendor type",
      combinedString.drayageByVendorType, true);

  const shipmentMode = await dray.resolveInboundDrayageSignal({
    from: "Billing <billing@examplehaul.com>",
    invoiceItems: [{carrierName: "Example Haul LLC"}],
    subject: "Invoice",
    body: "",
    lookupVendor: async () => ({
      id: "44",
      name: "Example Haul LLC",
      type: "LTL",
      shipmentMode: "Drayage",
    }),
  });
  check("shipment mode Drayage with LTL type is drayage",
      shipmentMode.isDrayage, true);

  const blitzProfile = bridge.applyVendorProfileTypes(
      {id: "113646", name: "Blitz Transportation Services", type: "LTL"},
      {carrierTypes: "[\"457\",\"0\"]", shipmentMode: "590"},
      [
        {id: 0, code: "LTL", name: "LTL"},
        {id: "457", code: "DRAY", name: "DRAYAGE"},
      ],
      [{id: "590", code: "Drayage", name: "Drayage"}],
  );
  check("Blitz profile types include DRAYAGE",
      blitzProfile.types.includes("DRAYAGE"), true);
  check("Blitz profile types include LTL",
      blitzProfile.types.includes("LTL"), true);
  check("Blitz profile shipment mode is Drayage",
      blitzProfile.shipmentMode, "Drayage");
  check("Blitz resolved profile is drayage",
      dray.isDrayageVendorType(blitzProfile), true);
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
  check("Leo forward note asks for GTG",
      dray.buildLeoForwardNotes({}).includes("GTG"),
      true);
  check("GTG is recognized",
      dray.isGtgConfirmation("Load 265551", "GTG"), true);
check("container plus Gtg is recognized",
      dray.isGtgConfirmation(
          "FW: Invoice 10628", "HAMU46559475 Gtg"), true);
check("container is read from a Gtg reply",
      dray.extractContainerFromText("", "HAMU46559475 Gtg"),
      "HAMU4655947");
const arrowGtg =
  "MSMU7346080 &nbsp; Gtg &nbsp; Leo Operations Excellence Manager";
check("nbsp between container and Gtg is recognized",
    dray.isGtgConfirmation(
        "FW: Invoice 10627 from GLOBAL ARROW LLC", arrowGtg),
    true);
check("nbsp Gtg reply keeps container MSMU7346080",
    dray.extractContainerFromText("", arrowGtg),
    "MSMU7346080");
check("HTML nbsp between container and Gtg is recognized",
    dray.isGtgConfirmation(
        "",
        "MSMU7346080<span>&nbsp;</span>Gtg"),
    true);
check("HTML nbsp reply keeps container MSMU7346080",
    dray.extractContainerFromText(
        "",
        "MSMU7346080<span style=\"mso-spacerun:yes\">&nbsp;</span>Gtg"),
    "MSMU7346080");
check("extra digit still drops the last digit",
    dray.extractContainerFromText(
        "",
        "HAMU46559475&nbsp;Gtg"),
    "HAMU4655947");
check("own company name is not an inbound drayage carrier",
      dray.isOwnCompanyCarrierName("Innovative Carriers"), true);
  check("Good to go is recognized",
      dray.isGtgConfirmation("", "This load is good to go"), true);
  check("A reply without GTG is not ready",
      dray.isGtgConfirmation("Invoice", "Please enter these charges"), false);
  const closeMatch = dray.drayageAmountsAcceptable(1001, 1005);
  check("Difference under $5 can proceed", closeMatch.ok, true);
  const over = dray.drayageAmountsAcceptable(1000, 1005);
  check("Difference of $5 stops", over.ok, false);
  check("Missing Total Cost stops",
      dray.drayageAmountsAcceptable(1005, null).ok, false);
  check("Total Cost is the vendor cost",
      dray.readDrayageTotalCost({vendor: {cost: "1005.00"}}), 1005);
  const portFee = {
    code: "TMF",
    carrierId: "99",
    carrierName: "Pier Pass",
    vendorInvoiceNumber: "84389-1-IN",
    total: 81.26,
  };
  const billedCtf = {
    code: "CTF",
    carrierId: "98",
    carrierName: "Port Check",
    vendorInvoiceNumber: "CTF-220",
    total: 40,
  };
  const unbilled = {
    code: "FRT",
    carrierId: "10",
    carrierName: "Draft Carrier",
    vendorInvoiceNumber: "",
    total: 500,
  };
  const blankBill = {
    code: "LUM",
    carrierId: "11",
    carrierName: "Lumper",
    vendorInvoiceNumber: "   ",
    total: 75,
  };
  const missingBill = {
    code: "ACC",
    carrierId: "12",
    carrierName: "Accessorial",
    total: 20,
  };
  const feeLine = {
    code: "FRT",
    carrierId: "55",
    carrierName: "Dray Carrier",
    vendorInvoiceNumber: "INV-9",
    total: 1005,
  };
  const merged = dray.mergeDrayageActualCost([
    unbilled, portFee, blankBill, billedCtf, missingBill,
  ], feeLine);
  check("Unbilled actual cost lines are removed", merged.removed, 3);
  check("Billed lines plus the new FRT remain", merged.lines.length, 3);
  check("Drayage bill is added", merged.added, true);
  check("Port fee line is unchanged", merged.lines[0], portFee);
  check("Port fee vendor is unchanged", merged.lines[0].carrierName,
      "Pier Pass");
  check("Port fee code is unchanged", merged.lines[0].code, "TMF");
  check("Port fee amount is unchanged", merged.lines[0].total, 81.26);
  check("Port fee bill number is unchanged",
      merged.lines[0].vendorInvoiceNumber, "84389-1-IN");
  check("Other billed line is unchanged", merged.lines[1], billedCtf);
  check("Drayage FRT line is appended", merged.lines[2], feeLine);
  check("Drayage FRT uses the carrier invoice number",
      merged.lines[2].vendorInvoiceNumber, "INV-9");
  check("Empty bill number is not a bill",
      dray.actualCostHasVendorBillNumber({vendorInvoiceNumber: ""}), false);
  check("Null bill number is not a bill",
      dray.actualCostHasVendorBillNumber({vendorInvoiceNumber: null}), false);
  check("Whitespace bill number is not a bill",
      dray.actualCostHasVendorBillNumber({vendorInvoiceNumber: "  "}), false);
  check("Numeric zero bill number is not a bill",
      dray.actualCostHasVendorBillNumber({vendorInvoiceNumber: 0}), false);
  const again = dray.mergeDrayageActualCost(merged.lines, {
    code: "FRT", vendorInvoiceNumber: "INV-9", total: 1005,
  });
  check("Same invoice number is not added twice", again.added, false);
  check("Second merge does not remove billed lines", again.removed, 0);
  check("Second merge keeps the port fee", again.lines[0], portFee);
  check("POD is not uploaded",
      dray.isDrayagePodAttachment({filename: "signed-POD.pdf"}), true);
  check("Invoice pdf is uploaded",
      dray.isDrayagePodAttachment({filename: "carrier-invoice.pdf"}), false);

  if (failures) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll drayage intake tests passed");
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
