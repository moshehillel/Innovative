/* eslint-disable no-console */
"use strict";

const batch = require("../invoice-batch-classification");
const bundle = require("../statement-invoice-bundle");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const subject = "Central Transport invoices";

/**
 * @param {string} load Load number.
 * @param {object} [extra] Field overrides.
 * @return {object}
 */
function bill(load, extra) {
  return Object.assign({
    loadNumber: load,
    invoiceNumber: "INV-" + load,
    carrierName: "Central Transport",
    attachmentFilename: "ct-packet.pdf",
  }, extra || {});
}

/**
 * @return {object}
 */
function packet() {
  return {
    filename: "ct-packet.pdf",
    mimeType: "application/pdf",
    docType: "INVOICE",
    buffer: Buffer.from("%PDF-1.4"),
  };
}

(async () => {
  check("packet subject is not a numbered statement",
      bundle.looksLikeNumberedStatementSubject(subject) === false);

  const noted = batch.annotateInvoiceRead(
      {invoices: [bill("265001")]},
      {
        stop_reason: "max_tokens",
        content: [{
          type: "text",
          text: "{\"invoices\":[{\"loadNumber\":\"265001\"}",
        }],
      });
  check("a cut-off length-limited answer is partial",
      noted.readPartial === true && noted.cutOff === true);

  const seen = [];
  const result = await batch.classifyCarrierInvoiceAttachments({
    subject,
    pdfAttachments: [packet()],
    messageId: "ct-one-pdf",
    getPageCount: async () => 30,
    slicePdf: async () => Buffer.from("chunk"),
    classifyCombined: async () => {
      seen.push("combined");
      return {
        invoices: [
          bill("265001"),
          bill("265002"),
          bill("265003"),
        ],
        stopReason: "max_tokens",
        cutOff: true,
      };
    },
    classifyOne: async (pdf) => {
      seen.push(pdf.filename);
      if (pdf.filename.indexOf("-p13-24") !== -1) {
        throw new Error("chunk failed");
      }
      if (pdf.filename.indexOf("-p2-13") !== -1) {
        return {
          invoices: [
            bill("265001"),
            bill("265099", {invoiceNumber: "INV-265001"}),
            bill("265004", {invoicePages: [1]}),
            {
              invoiceNumber: "CT-900",
              invoiceAmount: 88,
              carrierName: "Central Transport",
              invoicePages: [2],
            },
            {status: "error"},
          ],
        };
      }
      if (pdf.filename.indexOf("-p24-30") !== -1) {
        return {invoices: [bill("265005", {invoicePages: [1]})]};
      }
      throw new Error("unexpected chunk " + pdf.filename);
    },
  });

  const loads = result.invoices.map((i) => String(i.loadNumber || ""));
  const count = (load) => loads.filter((n) => n === load).length;
  check("first pass is not the only read",
      seen[0] === "combined" &&
      seen.includes("ct-packet.pdf-p2-13.pdf") &&
      seen.includes("ct-packet.pdf-p13-24.pdf") &&
      seen.includes("ct-packet.pdf-p24-30.pdf"));
  check("later chunks add invoices the first pass missed",
      count("265004") === 1 && count("265005") === 1);
  check("first-pass invoices are not saved twice",
      count("265001") === 1 &&
      count("265002") === 1 &&
      count("265003") === 1);
  check("same invoice number is not saved again",
      count("265099") === 0);
  check("bill with no load number is kept for review",
      result.invoices.some((i) =>
        i.invoiceNumber === "CT-900" && !i.loadNumber));
  check("bill with no identity is still skipped",
      !result.invoices.some((i) =>
        i.status === "error" && !i.loadNumber && !i.invoiceNumber));
  check("failed chunk did not drop invoices already read",
      count("265004") === 1 && count("265001") === 1);
  check("failed chunk did not drop a later chunk",
      count("265005") === 1 && result.chunkSupplementDone === true);
  const early = result.invoices.find((i) => i.loadNumber === "265004");
  const late = result.invoices.find((i) => i.loadNumber === "265005");
  check("chunk pages map back onto the original PDF",
      early && early.invoicePages && early.invoicePages[0] === 2 &&
      late && late.invoicePages && late.invoicePages[0] === 24);

  const quiet = [];
  const one = await batch.classifyCarrierInvoiceAttachments({
    subject,
    pdfAttachments: [packet()],
    getPageCount: async () => 4,
    slicePdf: async () => Buffer.from("nope"),
    classifyCombined: async () => ({
      invoices: [bill("265111")],
      stopReason: "end_turn",
      cutOff: false,
    }),
    classifyOne: async (pdf) => {
      quiet.push(pdf.filename);
      return {invoices: [bill("265111")]};
    },
  });
  check("a finished single invoice does not request chunks",
      quiet.length === 0 &&
      one.invoices.length === 1 &&
      one.chunkSupplementDone === false);

  const longQuiet = [];
  await batch.classifyCarrierInvoiceAttachments({
    subject,
    pdfAttachments: [packet()],
    getPageCount: async () => 12,
    slicePdf: async () => Buffer.from("nope"),
    classifyCombined: async () => ({
      invoices: [bill("265222")],
      stopReason: "end_turn",
      cutOff: false,
    }),
    classifyOne: async () => {
      longQuiet.push("chunk");
      return {invoices: []};
    },
  });
  check("one finished invoice on a long PDF is not chunked",
      longQuiet.length === 0);

  const shortList = [];
  const shortRead = await batch.classifyCarrierInvoiceAttachments({
    subject,
    pdfAttachments: [packet()],
    getPageCount: async () => 30,
    slicePdf: async () => Buffer.from("chunk"),
    classifyCombined: async () => ({
      invoices: [bill("265301"), bill("265302"), bill("265303")],
      stopReason: "end_turn",
      cutOff: false,
    }),
    classifyOne: async (pdf) => {
      shortList.push(pdf.filename);
      return {invoices: [bill("265310")]};
    },
  });
  check("fewer invoices than pages still requests the rest",
      shortList.length > 0 &&
      shortRead.invoices.some((i) => i.loadNumber === "265310"));

  if (failures) {
    console.error("\n" + failures + " failure(s)");
    process.exit(1);
  }
  console.log("\nAll checks passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
