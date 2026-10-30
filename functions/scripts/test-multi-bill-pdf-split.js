/* eslint-disable no-console */
"use strict";

const {PDFDocument} = require("pdf-lib");
const split = require("../multi-bill-pdf-split");
const queue = require("../mail-intake-queue");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

/**
 * @param {string} load Load number.
 * @param {string} pro PRO / invoice number.
 * @param {string} amount Amount with cents.
 * @return {string}
 */
function strictInvoice(load, pro, amount) {
  return [
    "JTS EXPRESS",
    "INVOICE",
    `B/L NUMBER ${load}`,
    `PRO # ${pro}`,
    "TOTAL CHARGES",
    amount,
    "PLEASE PAY THIS AMOUNT",
    amount,
  ].join("\n");
}

/**
 * Invoice page whose OCR missed the word INVOICE.
 * @param {string} load Load number.
 * @param {string} pro PRO / invoice number.
 * @param {string} amount Amount with cents.
 * @return {string}
 */
function looseInvoice(load, pro, amount) {
  return [
    "JTS EXPRESS",
    `B/L NUMBER ${load}`,
    `PRO # ${pro}`,
    "TOTAL CHARGES",
    amount,
    "PLEASE PAY THIS AMOUNT",
    amount,
  ].join("\n");
}

/**
 * @param {string} load Load number.
 * @param {string} pro PRO.
 * @return {string}
 */
function bolPage(load, pro) {
  return `BILL OF LADING\nBOL# ${load}\nPRO # ${pro}\nSHIPPER COPY`;
}

/**
 * @param {string} pro PRO.
 * @return {string}
 */
function podPage(pro) {
  return `CARRIER COPY-DELIVERY RECEIPT\nPRO # ${pro}\nReceived`;
}

/**
 * @param {Array<object>} rows pro, load, amount.
 * @return {string}
 */
function coverPage(rows) {
  const lines = rows.map((row) =>
    `08/27/2026 ${row.pro} B/L # ${row.load} .00 ${row.amount} 20`);
  return [
    "JTS EXPRESS",
    "STATEMENT",
    "SHIP DATE INVOICE # DESCRIPTION PAYMENTS BALANCE AGE",
    lines.join("\n"),
    "TOTAL BILLS",
    String(rows.length),
    "TOTAL DUE $2,169.75",
  ].join("\n");
}

const jtsBills = [
  {pro: "10480699", load: "266836", amount: "305.00"},
  {pro: "10480250", load: "267000", amount: "385.26"},
  {pro: "10480252", load: "267027", amount: "353.75"},
  {pro: "10480253", load: "267046", amount: "314.83"},
  {pro: "10480255", load: "267050", amount: "280.83"},
  {pro: "10480302", load: "267172", amount: "530.08"},
];

const buriedStatement = [
  coverPage(jtsBills),
  looseInvoice("266836", "10480699", "305.00"),
  bolPage("266836", "10480699"),
  podPage("10480699"),
  strictInvoice("267000", "10480250", "385.26"),
  bolPage("267000", "10480250"),
  strictInvoice("267027", "10480252", "353.75"),
  bolPage("267027", "10480252"),
  looseInvoice("267046", "10480253", "314.83"),
  bolPage("267046", "10480253"),
  looseInvoice("267050", "10480255", "280.83"),
  podPage("10480255"),
  looseInvoice("267172", "10480302", "530.08"),
  bolPage("267172", "10480302"),
];

const buried = split.splitMultiBillPacket(buriedStatement);
check("6-bill cover first pass only sees the two titled invoices",
    buried.firstPassCount === 2);
check("6-bill scanned statement splits into 6 invoice items",
    buried.items.length === 6);
check("6-bill split is complete",
    buried.gap.underExtracted === false);
check("6-bill split keeps every cover load",
    jtsBills.every((row) =>
      buried.items.some((item) => item.loadNumber === row.load)));
check("buried bill is not left inside the previous invoice",
    buried.items.find((item) => item.loadNumber === "267000")
        .invoicePages.indexOf(9) < 0);

const sixClear = split.splitMultiBillPacket([
  coverPage(jtsBills),
  ...jtsBills.map((row) => [
    strictInvoice(row.load, row.pro, row.amount),
    bolPage(row.load, row.pro),
    podPage(row.pro),
  ]).flat(),
]);
check("six titled invoices are not capped at two",
    sixClear.firstPassCount === 6 && sixClear.items.length === 6);

const noCover = [
  strictInvoice("261001", "9001001", "100.00").replace(
      "PRO # 9001001", "Invoice # 5001\nPRO # 9001001"),
  bolPage("261001", "9001001"),
  podPage("9001001"),
  [
    "RATE CONFIRMATION",
    "Load#: 261001",
    "Total $100.00",
    "PLEASE SEND INVOICE AND POD",
  ].join("\n"),
  looseInvoice("261002", "9001002", "200.00").replace(
      "PRO # 9001002", "Invoice # 5002\nPRO # 9001002"),
  bolPage("261002", "9001002"),
  looseInvoice("261003", "9001003", "300.00").replace(
      "PRO # 9001003", "Invoice # 5003\nPRO # 9001003"),
  podPage("9001003"),
];
const noCoverSplit = split.splitMultiBillPacket(noCover);
check("naive first pass calls the no-cover packet 1",
    noCoverSplit.firstPassCount === 1);
check("no-cover PDF with 3 invoices splits into 3",
    noCoverSplit.items.length === 3);
check("no-cover split is complete",
    noCoverSplit.gap.underExtracted === false);
const firstBill = noCoverSplit.items[0];
const secondPage = noCoverSplit.items[1].invoicePages[0];
check("BOL and rate confirmation do not swallow the next invoice",
    firstBill.invoicePages.indexOf(secondPage) < 0 &&
    firstBill.invoicePages.indexOf(2) >= 0);
check("each no-cover bill keeps its own invoice number",
    noCoverSplit.items.map((item) => item.invoiceNumber).join(",") ===
    "5001,5002,5003");

const onlyTwo = split.splitMultiBillPacket([
  coverPage(jtsBills),
  strictInvoice("267000", "10480250", "385.26"),
  bolPage("267000", "10480250"),
  strictInvoice("267027", "10480252", "353.75"),
  bolPage("267027", "10480252"),
  "Notes\nINVOICE # 10480253\nsee attached",
]);
check("2 of 6 is not a complete packet",
    onlyTwo.items.length === 2 && onlyTwo.gap.underExtracted === true);
check("incomplete packet names a missing cover bill",
    /10480699/.test(JSON.stringify(onlyTwo.gap.missingBills)) &&
    /266836/.test(JSON.stringify(onlyTwo.gap.missingBills)));
check("unread invoice number on a leftover page is named",
    onlyTwo.gap.unclaimedBills.some((bill) =>
      String(bill.invoiceNumber) === "10480253"));

const partialSummary = queue.buildIntakeSummary({
  finalStatus: "statement_under_extracted",
  statementExtractionGap: onlyTwo.gap,
  itemSummaries: onlyTwo.items.map((item) => ({
    finalStatus: "processing",
    loadNumber: item.loadNumber,
    invoiceId: item.loadNumber,
  })),
  _rebuildSummary: true,
});
check("2 of 6 does not look like a finished email",
    /Partial —/.test(partialSummary) &&
    !/^Processed email —/.test(partialSummary));
check("summary says found 2 of 6 and names the missing invoice",
    /found 2 of 6 bill\(s\)/.test(partialSummary) &&
    /invoice 10480699/.test(partialSummary) &&
    /load 266836/.test(partialSummary) &&
    /\$305\.00/.test(partialSummary));

const ocrCover = [
  "STATEMENT NO. STATEMENT DATE PAGE",
  "16855 INNOVATIVE CARRIERS 22771 09/16/2026 1",
  "08/25/2026 10480699 [B/L # 266836 .00 305.00 22",
  "08/27/2026 10480250 (B/L # 267000 .00 385.26 20",
  "08/27/2026 10480252 [(B/L # 267027 .00 353.75 20",
  "08/27/2026 10480253 [B/L # 267046 .00 314.83 20",
  "08/28/2026 10480255 (B/L # 267050 .00 280.83 19",
  "09/01/2026 10480302 [(B/L # 267172 .00 530.08 15",
  "TOTAL BILLS TOTAL DUE",
  "6 $2,169.75",
  "PLEASE PAY 2,169.75",
  "THIS AMOUNT",
].join("\n");

/**
 * Real scan shape: the word INVOICE is a logo, and PRO sits on the next row.
 * @param {string} load Load number.
 * @param {string} pro PRO.
 * @param {string} amount Amount.
 * @param {string} dates Shipped / invoiced dates.
 * @return {string}
 */
function ocrInvoicePage(load, pro, amount, dates) {
  return [
    "JTS EXPRESS, INC.",
    "SHIPPED | INVOICED B/L NUMBER P.O. NUMBER PAGE PRO #",
    `${dates} ${load} 219727, 181124082660 1 ${pro}`,
    "FREIGHT CHARGES PREPAID - THIRD PARTY",
    "TOTAL TOTAL CHARGES",
    `PLEASE MAKE CHECKS PAYABLE TO: PLEASE PAY ${amount}`,
    "JTS EXPRESS, INC. THIS AMOUNT",
  ].join("\n");
}

const ocrPacket = [ocrCover];
[
  ["266836", "10480699", "305.00", "8/25/26 | 8/31/26"],
  ["267000", "10480250", "385.26", "8/27/26 | 8/31/26"],
  ["267027", "10480252", "353.75", "8/27/26 | 8/31/26"],
  ["267046", "10480253", "314.83", "8/27/26 | 8/31/26"],
  ["267050", "10480255", "280.83", "8/28/26 | 8/31/26"],
  ["267172", "10480302", "530.08", "9/01/26 | 9/09/26"],
].forEach((row) => {
  ocrPacket.push(ocrInvoicePage(row[0], row[1], row[2], row[3]));
  ocrPacket.push(`BILL OF LADING\nBOL# ${row[0]}\nCARRIER: JTS Express`);
  ocrPacket.push(`CARRIER COPY-DELIVERY RECEIPT\nCUSTOMER NUMBER ${row[0]}`);
});
const ocrSplit = split.splitMultiBillPacket(ocrPacket);
check("scanned JTS pages have no invoice title for the first pass",
    ocrSplit.firstPassCount === 0);
check("OCR of a 6-bill scan still opens 6 bills",
    ocrSplit.items.length === 6 && ocrSplit.gap.underExtracted === false);
check("OCR split reads load, PRO, and amount off the scan",
    ocrSplit.items.some((item) =>
      item.loadNumber === "267027" && item.proNumber === "10480252" &&
      item.invoiceAmount === 353.75));

function estesInvoice(pro, amount) {
  return [
    "ESTES EXPRESS LINES",
    "INVOICE NUMBER",
    `PRO NUMBER ${pro}`,
    `ESTES REV. ${amount}`,
  ].join("\n");
}

const estesPacket = split.splitMultiBillPacket([
  estesInvoice("295-5096609", "414.50"),
  estesInvoice("295-5096603", "347.00"),
  "ESTES EXPRESS LINES\nPRO NUMBER\nsee remittance copy",
]);
check("Estes dashed PRO and ESTES REV open a bill",
    estesPacket.items.length === 2 &&
    estesPacket.items[0].proNumber === "2955096609" &&
    estesPacket.items[0].invoiceAmount === 414.5);
check("an Estes page that still cannot be read is named, not dropped",
    estesPacket.gap.underExtracted === true &&
    estesPacket.gap.unclaimedBills.some((bill) => bill.page === 3));

const humanWording = split.splitMultiBillPacket([
  [
    "CARRIER FREIGHT BILL",
    "Waybill: 178-0980346",
    "Amount due $250.00",
  ].join("\n"),
  [
    "INVOICE",
    "Freight bill no 55443322",
    "Balance due 88.10",
  ].join("\n"),
  [
    "INVOICE",
    "PRO # 295-4881139",
    "Invoice total: 1,220.55",
  ].join("\n"),
]);
check("a waybill and amount due are read as a bill",
    humanWording.items.some((item) =>
      item.proNumber === "1780980346" && item.invoiceAmount === 250));
check("freight bill number and balance due are read as a bill",
    humanWording.items.some((item) =>
      item.proNumber === "55443322" && item.invoiceAmount === 88.1));
check("invoice total with a dashed PRO is read as a bill",
    humanWording.items.some((item) =>
      item.proNumber === "2954881139" && item.invoiceAmount === 1220.55));

const oddWords = split.splitMultiBillPacket([
  [
    "SHIPMENT PAPER",
    "Tracking ref 441-2299001",
    "Carrier wants 612.40",
  ].join("\n"),
  [
    "INVOICE",
    "Ref 10480001",
    "Line haul 100.00",
    "Fuel 25.50",
    "Final figure 125.50",
  ].join("\n"),
]);
check("unfamiliar wording still opens the bill",
    oddWords.items.some((item) =>
      item.proNumber === "4412299001" && item.invoiceAmount === 612.4));
check("the last dollar figure is the total, not a line item",
    oddWords.items.some((item) =>
      item.proNumber === "10480001" && item.invoiceAmount === 125.5));

// Page type by shape and meaning, not a fixed header vocabulary.
check("proof of delivery with a signature block reads as a POD",
    split.supportKind(
        "PROOF OF DELIVERY\nReceived in good order\nConsignee signature",
    ) === "pod");
check("delivery receipt reads as a POD",
    split.supportKind("DELIVERY RECEIPT\nReceived by: J. Doe") === "pod");
check("straight bill of lading reads as a BOL",
    split.supportKind("STRAIGHT BILL OF LADING\nShipper / Consignee") ===
    "bol");
check("load confirmation reads as a rate confirmation",
    split.supportKind("LOAD CONFIRMATION\nAgreed rate 500.00") ===
    "rate_confirmation");
check("carrier confirmation reads as a rate confirmation",
    split.supportKind("CARRIER CONFIRMATION\nRate 500.00") ===
    "rate_confirmation");
check("a bill that also prints 'bill of lading number' is NOT a support page",
    split.pageHasBillSignal(
        "INVOICE\nBill of Lading Number 12345\nPRO 295-5096609\n" +
        "Please pay 414.50") === true &&
    split.supportKind(
        "INVOICE\nBill of Lading Number 12345\nPRO 295-5096609\n" +
        "Please pay 414.50") == null);
check("Estes 'ORIGINAL FREIGHT BILL' is an invoice title without the word " +
    "invoice",
    split.hasInvoiceTitle(
        "ESTES EXPRESS\nORIGINAL FREIGHT BILL\nPRO 295-5096609\n" +
        "ESTES REV. 414.50") === true);
check("a pure POD page is not treated as an invoice title",
    split.hasInvoiceTitle(
        "PROOF OF DELIVERY\nReceived by J. Doe\nConsignee signature",
    ) === false);

/**
 * @param {number} pages Page count.
 * @return {Promise<Buffer>}
 */
async function blankPdf(pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage();
  return Buffer.from(await doc.save());
}

/**
 * @return {Promise<void>}
 */
async function runAsyncChecks() {
  const separate = await split.splitSinglePdfInvoiceItems({
    pdfAttachments: [
      {filename: "a.pdf", buffer: Buffer.from("a"), docType: "INVOICE"},
      {filename: "b.pdf", buffer: Buffer.from("b"), docType: "INVOICE"},
    ],
    invoiceItems: [{loadNumber: "261001"}, {loadNumber: "261002"}],
    readPageTexts: async () => {
      throw new Error("one file per bill must not be re-split");
    },
  });
  check("one invoice per attachment is not re-split",
      separate.applied === false && separate.invoiceItems.length === 2);

  const pdf = await blankPdf(2);
  const opened = await split.splitSinglePdfInvoiceItems({
    pdfAttachments: [{
      filename: "22771.pdf",
      buffer: pdf,
      docType: "INVOICE",
    }],
    invoiceItems: [{
      loadNumber: "267000",
      proNumber: "10480250",
      invoiceAmount: 1,
    }],
    readPageTexts: async () => buriedStatement,
  });
  check("single statement PDF is opened into 6 jobs",
      opened.applied === true && opened.invoiceItems.length === 6 &&
      opened.gap == null);
  check("split keeps the classifier amount when the page has one",
      opened.invoiceItems.find((item) => item.loadNumber === "267000")
          .invoiceAmount === 385.26);
}

runAsyncChecks().then(() => {
  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll multi-bill PDF split checks passed");
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
