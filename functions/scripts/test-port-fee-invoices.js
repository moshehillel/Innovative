/* eslint-disable no-console */
"use strict";

const fs = require("fs");
const portFees = require("../port-fee-invoices");
const bridge = require("../primus-ui-bridge");
const podUtils = require("../pod-utils");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const SAMPLE = [
  "Traffic Mitigation Fee Invoice",
  "Invoice #: Invoice Period: Invoice Date: Account #:",
  "Total Due: Due Date:",
  "84389-10167937-IN 09/12/2026 - 09/18/2026 09/22/2026 84389",
  "$162.52 10/01/2026",
  "Container Number Booking #/BoL # Traffic Mitigation Fee",
  "09/12/26 14:08:00 APMT FFAU8880029 40 I 274247993 81.26",
  "09/12/26 17:00:00 APMT FFAU8880060 40 I 274247993 81.26",
  "Total 162.52",
].join(" ");

const parsed = portFees.parsePortFeeInvoiceText(SAMPLE);
check("sample parses", parsed.ok === true);
check("sample is TMF", parsed.invoice && parsed.invoice.chargeCode === "TMF");
check("sample vendor is Pier Pass",
    parsed.invoice && parsed.invoice.vendorName === "Pier Pass");
check("sample bill number",
    parsed.invoice && parsed.invoice.invoiceNumber === "84389-10167937-IN");
check("bill date is invoice date",
    parsed.invoice && parsed.invoice.invoiceDate === "2026-09-22");
check("printed due date kept aside",
    parsed.invoice && parsed.invoice.printedDueDate === "2026-10-01");
check("two containers",
    parsed.invoice && parsed.invoice.lines.length === 2);
check("does not treat ocean BOL as a container",
    parsed.invoice &&
    !parsed.invoice.lines.some((l) => l.container === "274247993"));

const badTotal = portFees.parsePortFeeInvoiceText(
    SAMPLE.replace("$162.52", "$999.00"),
);
check("rejects a total that does not match the lines", badTotal.ok === false);

const ctOnly = portFees.detectPortFeeKind("Clean Truck Fee on a rate con");
check("clean truck wording alone is not an invoice", ctOnly === null);

const one = portFees.pickContainerMatch([
  {BOL: "267634", carrierRef: "FFAU8880029"},
  {BOL: "267700", carrierRef: "OTHER"},
], "FFAU8880029");
check("picks the load that carries the container",
    one.ok === true && one.loadNumber === "267634");

const fuzzy = portFees.pickContainerMatch([
  {BOL: "267634", carrierName: "Somewhere"},
], "FFAU8880029");
check("single search hit is accepted",
    fuzzy.ok === true && fuzzy.source === "single_search_hit");

const many = portFees.pickContainerMatch([
  {BOL: "267634"},
  {BOL: "267635"},
], "FFAU8880029");
check("several hits without the container are not guessed",
    many.ok === false && many.ambiguous === true);

const draftFlags = bridge.portFeeSaveInvoiceFlags({id: 1, invoiceNumber: "0"});
check("draft does not close customer cost", draftFlags.costClosed === "0");
check("draft is not marked ready to invoice",
    draftFlags.readyToInvoice === "0");
const issuedFlags = bridge.portFeeSaveInvoiceFlags({
  id: 1,
  invoiceNumber: "45021",
});
check("issued invoice stays ready", issuedFlags.readyToInvoice === "1");

const due = bridge.resolveDueOnReceiptTerms([
  {id: "10", days: 30, code: "N30", description: "Net 30"},
  {id: "4", days: 0, code: "DOR", description: "Due on receipt"},
]);
check("due on receipt term is selected", due.ok === true && due.termsId === 4);
const netOnly = bridge.resolveDueOnReceiptTerms([
  {id: "10", days: 30, code: "N30", description: "Net 30"},
]);
check("net 30 is not used for these bills", netOnly.ok === false);

async function runBatch() {
  const calls = [];
  const invoice = parsed.invoice;
  const result = await portFees.applyPortFeeLines({
    invoice,
    vendor: {id: "55", name: "Pier Pass"},
    termsId: 4,
    findLoad: async (container) => {
      calls.push(container);
      if (container === "FFAU8880029") {
        return {ok: true, loadNumber: "267634", booking: {id: 9}};
      }
      return {ok: false, notFound: true};
    },
    postCharge: async (charge) => {
      calls.push(charge);
      return {ok: true};
    },
  });
  check("lookup uses the container", calls[0] === "FFAU8880029");
  check("ocean BOL is not the lookup key",
      !calls.some((c) => c === "274247993"));
  const posted = calls.find((c) => c && c.chargeCode === "TMF");
  check("posts TMF to Pier Pass",
      posted && posted.vendor.name === "Pier Pass");
  check("PRO is the container", posted && posted.proNumber === "FFAU8880029");
  check("bill date is the invoice date",
      posted && posted.billDate === "2026-09-22");
  check("due date matches the bill date",
      posted && posted.dueDate === "2026-09-22");
  check("bill number is the invoice number",
      posted && posted.vendorInvoiceNumber === "84389-10167937-IN");
  check("missing container is skipped",
      result.skipped.some((r) => r.container === "FFAU8880060"));
  check("found container is posted",
      result.posted.some((r) => r.loadNumber === "267634"));
}

async function runRealPdfs() {
  const files = [
    {
      path: "C:/Users/Moshe/Downloads/84389_20260919_01.pdf",
      code: "TMF",
      vendor: "Pier Pass",
      number: "84389-10167937-IN",
      total: 1543.94,
      first: 81.26,
    },
    {
      path: "C:/Users/Moshe/Downloads/101054_20260919_01.pdf",
      code: "CTF",
      vendor: "Port Check",
      number: "101054-10168351-IN",
      total: 380,
      first: 20,
    },
  ];
  for (const file of files) {
    if (!fs.existsSync(file.path)) {
      console.log(`SKIP missing ${file.path}`);
      continue;
    }
    const pages = await podUtils.extractPdfPageTexts(fs.readFileSync(file.path));
    const text = (pages || []).join("\n");
    const result = portFees.parsePortFeeInvoiceText(text, {filename: file.path});
    check(`${file.code} pdf parses`, result.ok === true);
    if (!result.ok) {
      console.log("  ", result.error);
      continue;
    }
    const inv = result.invoice;
    check(`${file.code} code`, inv.chargeCode === file.code);
    check(`${file.code} vendor`, inv.vendorName === file.vendor);
    check(`${file.code} bill`, inv.invoiceNumber === file.number);
    check(`${file.code} date`, inv.invoiceDate === "2026-09-22");
    check(`${file.code} total`, inv.invoiceTotal === file.total);
    check(`${file.code} line count`, inv.lines.length === 19);
    check(`${file.code} first container`,
        inv.lines[0].container === "FFAU8880029" &&
        inv.lines[0].amount === file.first);
  }
}

async function runMissingLoadEmail() {
  const store = new Map();
  const sent = [];
  portFees.init({
    pendingCollection: () => ({
      doc(id) {
        return {
          async get() {
            return {
              exists: store.has(id),
              data: () => store.get(id),
            };
          },
          async set(data, opts) {
            const prev = store.get(id) || {};
            store.set(id, opts && opts.merge ? {...prev, ...data} : data);
          },
        };
      },
    }),
    saveOutboundEmail: async (email) => {
      sent.push(email);
    },
  });
  const summaries = [{
    invoiceNumber: "84389-10167937-IN",
    chargeCode: "TMF",
    vendorName: "Pier Pass",
    vendorId: "1",
    invoiceDate: "2026-09-22",
    skipped: [{
      container: "FFAU8880029",
      amount: 81.26,
      reason: portFees.SKIP_REASON.LOAD_NOT_FOUND,
    }],
  }];
  const first = await portFees.rememberMissingLoads(summaries);
  const second = await portFees.rememberMissingLoads(summaries);
  check("missing-load email goes to Josef",
      sent[0] && sent[0].to === "Josef@innovativecarriers.com");
  check("missing-load email copies Leo",
      sent[0] && sent[0].cc === "Leo@innovativecarriers.com");
  check("missing load is emailed once",
      first.fresh.length === 1 && second.fresh.length === 0 &&
      sent.length === 1);
}

Promise.all([runBatch(), runRealPdfs()]).then(() => runMissingLoadEmail())
    .then(() => {
      if (failures) process.exit(1);
      console.log("OK");
    }).catch((err) => {
      console.error(err);
      process.exit(1);
    });
