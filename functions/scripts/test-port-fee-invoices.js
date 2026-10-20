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

const feeWordOnly = portFees.detectPortFeeKind(
    "Traffic Mitigation Fee discussed in a rate confirmation",
);
check("fee wording alone is not an invoice", feeWordOnly === null);

// PierPASS now paints "Traffic Mitigation Fee Invoice" in a header image.
// The text layer keeps the column, the payment note, and the bill number.
const IMAGE_TITLE_TMF = [
  "Page 1 of 1",
  "Invoice #: Invoice Period: Invoice Date: Account #:",
  "Total Due: Due Date:",
  "84389-10000001-IN 10/10/2026 - 10/16/2026 10/20/2026 84389",
  "$81.26 10/29/2026",
  "PLEASE NOTE: INVOICES ARE PAYABLE BY ACH ONLY.",
  "PierPASS's banking information is: Bank of America.",
  "Container Number Booking #/BoL # Traffic Mitigation Fee",
  "10/10/26 23:51:00 APMT FFAU8880029 40 I BOOKING1 VESSEL 015E 81.26",
  "Total 81.26",
].join(" ");
check("image-title pdf is still TMF",
    portFees.detectPortFeeKind(IMAGE_TITLE_TMF) === "TMF");
const imageTitleParsed = portFees.parsePortFeeInvoiceText(IMAGE_TITLE_TMF);
check("image-title pdf parses", imageTitleParsed.ok === true);
check("image-title bill number",
    imageTitleParsed.invoice &&
    imageTitleParsed.invoice.invoiceNumber === "84389-10000001-IN");
check("image-title bill date",
    imageTitleParsed.invoice &&
    imageTitleParsed.invoice.invoiceDate === "2026-10-20");
check("image-title one container",
    imageTitleParsed.invoice &&
    imageTitleParsed.invoice.lines.length === 1 &&
    imageTitleParsed.invoice.lines[0].amount === 81.26);
check("image-title total",
    imageTitleParsed.invoice &&
    imageTitleParsed.invoice.invoiceTotal === 81.26);

// Title gone, column renamed to TMF, PierPASS still in the text.
const ABBREV_TMF = [
  "PierPASS",
  "Invoice #: Invoice Period: Invoice Date: Account #:",
  "84389-10231001-IN 10/10/2026 - 10/16/2026 10/20/2026 84389",
  "$81.26 10/29/2026",
  "Container Number Booking TMF",
  "10/10/26 23:51:00 APMT FFAU8880029 40 I BOOK1 81.26",
  "Total 81.26",
].join(" ");
check("abbreviated TMF column is still TMF",
    portFees.detectPortFeeKind(ABBREV_TMF) === "TMF");
const abbrevParsed = portFees.parsePortFeeInvoiceText(ABBREV_TMF);
check("abbreviated TMF parses", abbrevParsed.ok === true);
check("abbreviated TMF bill date",
    abbrevParsed.invoice && abbrevParsed.invoice.invoiceDate === "2026-10-20");
check("abbreviated TMF amount",
    abbrevParsed.invoice && abbrevParsed.invoice.lines[0].amount === 81.26);

// Labels moved off the classic header. No exact title, no "Container Number".
const MOVED_TMF = [
  "Pier Pass",
  "Invoice Date: 10/20/2026",
  "Bill 84389-10231002-IN",
  "Cntr No  Mitigation Fee",
  "FFAU8880029  81.26",
  "MSCU1234567  81.26",
  "Total Due $162.52",
].join(" ");
const movedTmf = portFees.parsePortFeeInvoiceText(MOVED_TMF);
check("moved TMF labels parse", movedTmf.ok === true);
check("moved TMF is Pier Pass",
    movedTmf.invoice && movedTmf.invoice.vendorName === "Pier Pass" &&
    movedTmf.invoice.chargeCode === "TMF");
check("moved TMF date and two containers",
    movedTmf.invoice && movedTmf.invoice.invoiceDate === "2026-10-20" &&
    movedTmf.invoice.lines.length === 2 &&
    movedTmf.invoice.invoiceTotal === 162.52);

const CLASSIC_CTF = [
  "Port Rate Invoice",
  "Invoice #: Invoice Period: Invoice Date: Account #:",
  "Total Due: Due Date:",
  "101054-10168351-IN 09/12/2026 - 09/18/2026 09/22/2026 101054",
  "$40.00 10/01/2026",
  "PortCheck's banking information is: Bank of America.",
  "Container Number Booking #/BoL # Port Rate",
  "09/12/26 14:08:00 APMT FFAU8880029 40 I 274247993 35105494 A22 20.00",
  "09/12/26 17:00:00 APMT FFAU8880060 40 I 274247993 34996766 A22 20.00",
  "Total 40.00",
  "Truck subject to the Clean Truck Fee imposed as of 2022",
].join(" ");
const classicCtf = portFees.parsePortFeeInvoiceText(CLASSIC_CTF);
check("classic CTF parses", classicCtf.ok === true);
check("classic CTF is Port Check",
    classicCtf.invoice && classicCtf.invoice.chargeCode === "CTF" &&
    classicCtf.invoice.vendorName === "Port Check");
check("classic CTF bill and date",
    classicCtf.invoice &&
    classicCtf.invoice.invoiceNumber === "101054-10168351-IN" &&
    classicCtf.invoice.invoiceDate === "2026-09-22");
check("classic CTF lines",
    classicCtf.invoice && classicCtf.invoice.lines.length === 2 &&
    classicCtf.invoice.lines[0].amount === 20 &&
    classicCtf.invoice.invoiceTotal === 40);

const IMAGE_CTF = [
  "Invoice #: Invoice Period: Invoice Date: Account #:",
  "101054-10231003-IN 10/10/2026 - 10/16/2026 10/20/2026 101054",
  "$20.00 10/29/2026",
  "PortCheck's banking information is: Bank of America.",
  "Container Number Port Rate",
  "10/10/26 23:51:00 APMT FFAU8880029 40 I BOOK1 20.00",
  "Total 20.00",
  "Clean Truck Fee",
].join(" ");
const imageCtf = portFees.parsePortFeeInvoiceText(IMAGE_CTF);
check("header-image CTF parses without the title", imageCtf.ok === true);
check("header-image CTF code",
    imageCtf.invoice && imageCtf.invoice.chargeCode === "CTF" &&
    imageCtf.invoice.invoiceDate === "2026-10-20");

const MOVED_CTF = [
  "Port Check",
  "Invoice Date: 10/13/2026",
  "Invoice No 101054-10231004-IN",
  "Container #   CTF Amount",
  "FFAU8880029  20.00",
  "Total $20.00",
].join(" ");
const movedCtf = portFees.parsePortFeeInvoiceText(MOVED_CTF);
check("moved CTF labels parse", movedCtf.ok === true);
check("moved CTF vendor and amount",
    movedCtf.invoice && movedCtf.invoice.vendorName === "Port Check" &&
    movedCtf.invoice.chargeCode === "CTF" &&
    movedCtf.invoice.lines[0].amount === 20);

const SUSPENSION_TEXT = [
  "PierPASS Account 84389 has been suspended.",
  "Traffic Mitigation Fee will not be billed until the account is restored.",
].join(" ");
const suspensionPdf = portFees.parsePortFeeInvoiceText(SUSPENSION_TEXT);
check("suspension text is not a bill",
    suspensionPdf.ok === false &&
    portFees.detectPortFeeKind(SUSPENSION_TEXT) === null);
check("suspension skip says it is not an invoice",
    suspensionPdf.error && /suspension/i.test(suspensionPdf.error));

const NEWSLETTER_TEXT = "PierPASS newsletter — terminal hours for October.";
const newsletterPdf = portFees.parsePortFeeInvoiceText(NEWSLETTER_TEXT);
check("newsletter is not a bill",
    newsletterPdf.ok === false && /newsletter/i.test(newsletterPdf.error));

const RECEIPT_TEXT = [
  "PierPASS payment receipt",
  "Thank you for your payment",
  "Invoice 84389-10167937-IN",
  "Amount $1,543.94",
].join(" ");
const receiptPdf = portFees.parsePortFeeInvoiceText(RECEIPT_TEXT);
check("payment receipt is not a bill",
    receiptPdf.ok === false && /payment receipt/i.test(receiptPdf.error));

const DRAYAGE_HEADER = [
  "PierPASS/INNOVATIVE CARRIERS",
  "Invoice 12345",
  "Container FFAU8880029",
  "Drayage 450.00",
  "Total $450.00",
].join(" ");
check("PierPASS bill-to line without a TMF charge is not a bill",
    portFees.detectPortFeeKind(DRAYAGE_HEADER) === null &&
    portFees.parsePortFeeInvoiceText(DRAYAGE_HEADER).ok === false);

check("empty extract says no text",
    portFees.parsePortFeeInvoiceText("").error === "no text");
const noContainers = portFees.parsePortFeeInvoiceText([
  "PierPASS Traffic Mitigation Fee",
  "84389-10231005-IN 10/10/2026 - 10/16/2026 10/20/2026",
  "$81.26",
].join(" "));
check("missing containers says no container lines",
    noContainers.ok === false &&
    String(noContainers.error).includes("no container lines"));
const noAmount = portFees.parsePortFeeInvoiceText([
  "PierPASS Traffic Mitigation Fee",
  "84389-10231006-IN",
  "Invoice Date: 10/20/2026",
  "Container Number FFAU8880029",
].join(" "));
check("missing charge says no amount",
    noAmount.ok === false && String(noAmount.error).includes("no amount"));

const unreadMail = portFees.buildReconciliationEmail([], [{
  filename: "scan.pdf",
  error: "no text",
}]);
check("Lisa email names the missing piece",
    unreadMail.html.includes("no text") &&
    !unreadMail.html.includes("not read from the PDF"));

check("Pier Pass invoice subject stays on the port-fee path",
    portFees.isPortFeeMessage(
        "Pierpass.OffPeak-Invoice@pierpass.net",
        "Account 84389: Your PierPass Invoice 84389-10213171-IN",
    ) === true);
check("Port Check invoice subject stays on the port-fee path",
    portFees.isPortFeeMessage(
        "invoices@portcheck.org",
        "Your Portcheck Invoice 101054-10213586-IN",
    ) === true);
check("Pier Pass suspension is not an invoice",
    portFees.isPortFeeMessage(
        "Pierpass.OffPeak-TMF@pierpass.net",
        "PierPASS Account 84389 has been suspended",
    ) === false);
check("forwarded PierPass invoice subject stays on the port-fee path",
    portFees.isPortFeeMessage(
        "dispatcher@innovativecarriers.com",
        "Fw: Account 84389: Your PierPass Invoice 84389-10213171-IN",
    ) === true);
check("PierPASS newsletter subject is not an invoice",
    portFees.isPortFeeMessage(
        "news@pierpass.net",
        "PierPASS newsletter for October",
    ) === false);
check("payment receipt subject is not an invoice",
    portFees.isPortFeeMessage(
        "Pierpass.OffPeak-Invoice@pierpass.net",
        "PierPASS payment receipt for your invoice",
    ) === false);

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

const byRef = portFees.pickContainerMatch([
  {
    BOL: "268737",
    carrierRef: "CSGU8040546",
    thirdPartyReferenceNumber: "UETU9056194",
  },
  {
    BOL: "268529",
    carrierRef: "UETU9056194",
    thirdPartyReferenceNumber: "UETU9056194",
  },
], "UETU9056194");
check("carrier ref wins when another load only mentions the container",
    byRef.ok === true && byRef.loadNumber === "268529" &&
    byRef.source === "carrier_ref");

const draftFlags = bridge.portFeeSaveInvoiceFlags({id: 1, invoiceNumber: "0"});
check("draft does not close customer cost", draftFlags.costClosed === "0");
check("draft closes the vendor charge for QuickBooks",
    draftFlags.costActualClosed === "1");
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

async function runDuplicate() {
  const result = await portFees.applyPortFeeLines({
    invoice: {
      ...parsed.invoice,
      lines: [parsed.invoice.lines[0]],
    },
    vendor: {id: "113303", name: "Pier Pass"},
    termsId: 4,
    findLoad: async () => ({ok: true, loadNumber: "267634", booking: {id: 9}}),
    postCharge: async () => ({
      duplicate: true,
      existingBill: parsed.invoice.invoiceNumber,
    }),
  });
  check("same bill is not posted twice",
      result.posted.length === 0 &&
      result.skipped.some((row) =>
        row.reason === portFees.SKIP_REASON.DUPLICATE_FEE));
}

async function runSniff() {
  let extracted = 0;
  const both = await portFees.sniffPdfAttachments({
    expectInvoice: true,
    attachments: [
      {filename: "84389_fees.csv", mimeType: "text/csv"},
      {filename: "84389_invoice.pdf", mimeType: "application/pdf"},
    ],
    downloadAttachment: async () => Buffer.from("pdf"),
    extractText: async () => {
      extracted++;
      return CLASSIC_CTF;
    },
  });
  check("CSV is ignored and the PDF is the bill",
      extracted === 1 && both.matches.length === 1 &&
      both.matches[0].chargeCode === "CTF");

  const empty = await portFees.sniffPdfAttachments({
    expectInvoice: true,
    attachments: [{filename: "scan.pdf", mimeType: "application/pdf"}],
    downloadAttachment: async () => Buffer.from("pdf"),
    extractText: async () => "",
  });
  check("empty PDF says no text",
      empty.matches.length === 0 &&
      empty.rejected.some((row) => row.error === "no text"));

  const csvOnly = await portFees.sniffPdfAttachments({
    expectInvoice: true,
    attachments: [{filename: "84389_fees.csv", mimeType: "text/csv"}],
    downloadAttachment: async () => Buffer.from("csv"),
    extractText: async () => {
      throw new Error("csv should not be read");
    },
  });
  check("CSV alone is not read as the bill",
      csvOnly.matches.length === 0 &&
      csvOnly.rejected.some((row) => /no PDF/i.test(row.error)));

  const notice = await portFees.sniffPdfAttachments({
    expectInvoice: true,
    attachments: [{filename: "notice.pdf", mimeType: "application/pdf"}],
    downloadAttachment: async () => Buffer.from("pdf"),
    extractText: async () => SUSPENSION_TEXT,
  });
  check("expected invoice that is a suspension is refused",
      notice.matches.length === 0 &&
      notice.rejected.some((row) => /suspension/i.test(row.error)));
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
  check("missing-load email copies Leo and Abe",
      sent[0] && sent[0].cc ===
      "Leo@innovativecarriers.com, Abe@innovativecarriers.com");
check("Abe is copied once",
      portFees.portFeeEmailCc("Abe@innovativecarriers.com") ===
      "Abe@innovativecarriers.com");
check("Abe is added when nobody is copied",
      portFees.portFeeEmailCc() === "Abe@innovativecarriers.com");
  check("missing load is emailed once",
      first.fresh.length === 1 && second.fresh.length === 0 &&
      sent.length === 1);
}

Promise.all([runBatch(), runDuplicate(), runSniff(), runRealPdfs()])
    .then(() => runMissingLoadEmail())
    .then(() => {
      if (failures) process.exit(1);
      console.log("OK");
    }).catch((err) => {
      console.error(err);
      process.exit(1);
    });
