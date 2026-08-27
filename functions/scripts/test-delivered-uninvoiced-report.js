/* eslint-disable no-console */
"use strict";

const report = require("../delivered-uninvoiced-report");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const today = new Date(2026, 7, 24); // Aug 24, 2026

const podUninvoiced = {
  BOL: "266781",
  Invoiced: "0",
  InvoiceNumbers: null,
  status_code: "POD",
  status_name: "POD",
  deliveryDate: "2026-08-23",
  dueDate: "08/23/26",
  trackingDeliveredDate: "08/24/26",
  pickupDate: "2026-08-20",
  carrierName: "Example Carrier",
  thirdPartyName: "Example Customer",
  shipperCity: "Kearny",
  shipperState: "NJ",
  consigneeCity: "Dallas",
  consigneeState: "TX",
};

const dlvUninvoiced = {
  ...podUninvoiced,
  BOL: "266500",
  status_code: "DLV",
  status_name: "DELIVERED TO CONSIGNEE",
  trackingDeliveredDate: "",
};

const pastEtaInTransit = {
  ...podUninvoiced,
  BOL: "266788",
  status_code: "DIS",
  status_name: "PICKUP DISPATCHED",
  deliveryDate: "2026-08-12",
  dueDate: "08/12/26",
  trackingDeliveredDate: "",
};

const futureDelivery = {
  ...podUninvoiced,
  BOL: "266859",
  status_code: "DIS",
  status_name: "PICKUP DISPATCHED",
  deliveryDate: "2026-08-28",
  dueDate: "08/28/26",
  trackingDeliveredDate: "",
};

const invoicedPod = {
  ...podUninvoiced,
  BOL: "266100",
  Invoiced: "1",
  InvoiceNumbers: "28111",
};

const cancelled = {
  ...pastEtaInTransit,
  BOL: "266000",
  status_code: "CRCN",
  status_name: "CANCELED BY CARRIER",
};

const invdStatus = {
  ...podUninvoiced,
  BOL: "266050",
  Invoiced: "0",
  status_code: "INVD",
  status_name: "INVOICED",
};

const trackingDateOnly = {
  ...podUninvoiced,
  BOL: "266040",
  status_code: "TRAN",
  status_name: "SHIPMENT IS IN TRANSIT",
  deliveryDate: "2026-08-30",
  dueDate: "08/30/26",
  trackingDeliveredDate: "08/20/26",
};

check("POD is delivered flag", report.hasDeliveredFlag(podUninvoiced));
check("DLV is delivered flag", report.hasDeliveredFlag(dlvUninvoiced));
check("in-transit is not delivered flag",
    !report.hasDeliveredFlag(pastEtaInTransit));
check("Invoiced=1 is invoiced", report.hasCustomerInvoice(invoicedPod));
check("Invoiced=0 is not invoiced",
    !report.hasCustomerInvoice(podUninvoiced));
check("INVD status counts as invoiced", report.hasCustomerInvoice(invdStatus));
check("CRCN is cancelled", report.isCancelled(cancelled));

const hits = report.filterDeliveredUninvoiced([
  podUninvoiced,
  dlvUninvoiced,
  pastEtaInTransit,
  futureDelivery,
  invoicedPod,
  cancelled,
  invdStatus,
  trackingDateOnly,
], today);
const loads = hits.map((h) => h.loadNumber);

check("includes POD uninvoiced", loads.includes("266781"));
check("includes DLV uninvoiced", loads.includes("266500"));
check("includes past ETA in transit", loads.includes("266788"));
check("includes tracking delivered date", loads.includes("266040"));
check("excludes future delivery", !loads.includes("266859"));
check("excludes invoiced POD", !loads.includes("266100"));
check("excludes cancelled", !loads.includes("266000"));
check("excludes INVD", !loads.includes("266050"));
check("hit count", hits.length === 4);

const mail = report.buildLisaReportEmail({shipments: hits});
check("subject names Lisa report",
    mail.subject.includes("not invoiced"));
check("subject splits delivered vs past ETA",
    mail.subject.includes("3 delivered + 1 past ETA"));
check("html greets Lisa", mail.html.includes("Hi Lisa"));
check("html lists POD load", mail.html.includes("266781"));
check("html has delivered section",
    mail.html.includes("Actually delivered, not invoiced"));
check("html has past ETA section",
    mail.html.includes("Past delivery date / ETA, not yet"));
check("html does not mention extra-charge letters as actions",
    !/approve option [ABCD]/i.test(mail.html));

const empty = report.buildLisaReportEmail({shipments: []});
check("empty still emails Lisa", empty.html.includes("Hi Lisa"));
check("empty subject", empty.subject.includes("no delivered"));

if (failures) {
  process.exit(1);
}
console.log("OK");
