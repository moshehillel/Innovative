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
    readPageTexts: async () => [""],
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
    getPageCount: async () => 2,
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
  check("a one- or two-page invoice can finish without chunks",
      quiet.length === 0 &&
      one.invoices.length === 1 &&
      one.chunkSupplementDone === false &&
      !one.invoiceShortfall);

  const longQuiet = [];
  const longRead = await batch.classifyCarrierInvoiceAttachments({
    subject,
    pdfAttachments: [packet()],
    getPageCount: async () => 12,
    readPageTexts: async () => [""],
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
  check("one finished invoice on a long PDF is still chunked",
      longQuiet.length > 0 &&
      longRead.invoices.length === 1 &&
      longRead.invoices[0].loadNumber === "265222");
  check("page count that still implies more bills is held",
      longRead.invoiceShortfall &&
      longRead.invoiceShortfall.needsReview === true &&
      longRead.invoiceShortfall.source === "page_count");

  const shortList = [];
  const shortRead = await batch.classifyCarrierInvoiceAttachments({
    subject,
    pdfAttachments: [packet()],
    getPageCount: async () => 30,
    readPageTexts: async () => [""],
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

  const notPartial = batch.assessInvoiceRead({
    stopReason: "end_turn",
    cutOff: false,
    endedEarly: false,
    invoiceCount: 2,
    pageCount: 5,
  });
  check("two finished invoices on 5 pages are not judged partial",
      notPartial.partial === false && notPartial.reasons.length === 0);

  const twoOfTenSeen = [];
  const twoOfTen = await batch.classifyCarrierInvoiceAttachments({
    subject,
    pdfAttachments: [packet()],
    getPageCount: async () => 5,
    readPageTexts: async () => ["Carrier packet 10 invoices"],
    slicePdf: async () => Buffer.from("chunk"),
    classifyCombined: async () => ({
      invoices: [bill("270001"), bill("270002")],
      stopReason: "end_turn",
      cutOff: false,
      endedEarly: false,
    }),
    classifyOne: async (pdf) => {
      twoOfTenSeen.push(pdf.filename);
      if (pdf.filename.indexOf("-p2-5") === -1) {
        throw new Error("unexpected chunk " + pdf.filename);
      }
      return {
        invoices: [
          bill("270001"),
          bill("270009", {invoiceNumber: "INV-270002"}),
          bill("270003"),
        ],
      };
    },
  });
  const twoLoads = twoOfTen.invoices.map(
      (item) => String(item.loadNumber || ""));
  const twoCount = (load) =>
    twoLoads.filter((loadNo) => loadNo === load).length;
  check("2 of 10 still runs the chunk pass when not cut off",
      twoOfTenSeen.indexOf("ct-packet.pdf-p2-5.pdf") !== -1 &&
      twoOfTen.chunkSupplementDone === true);
  check("chunk pass does not save a bill that was already read",
      twoCount("270001") === 1 && twoCount("270009") === 0);
  check("chunk pass keeps a new invoice and the first two",
      twoCount("270002") === 1 && twoCount("270003") === 1 &&
      twoOfTen.invoices.length === 3);
  check("short of the stated 10 is held for review",
      twoOfTen.invoiceShortfall &&
      twoOfTen.invoiceShortfall.needsReview === true &&
      twoOfTen.invoiceShortfall.expectedCount === 10 &&
      twoOfTen.invoiceShortfall.extractedCount === 3 &&
      twoOfTen.invoiceShortfall.source === "stated_count" &&
      /10/.test(twoOfTen.invoiceShortfall.reason) &&
      /3/.test(twoOfTen.invoiceShortfall.reason));
  check("review note records why the count is short",
      bundle.buildStatementGapSummarySuffix(twoOfTen.invoiceShortfall) ===
      twoOfTen.invoiceShortfall.reason);

  const failedKeep = await batch.classifyCarrierInvoiceAttachments({
    subject,
    pdfAttachments: [packet()],
    getPageCount: async () => 20,
    readPageTexts: async () => ["Statement cover 10 invoices"],
    slicePdf: async () => Buffer.from("chunk"),
    classifyCombined: async () => ({
      invoices: [bill("271001"), bill("271002")],
      stopReason: "end_turn",
      cutOff: false,
    }),
    classifyOne: async (pdf) => {
      if (pdf.filename.indexOf("-p2-13") !== -1) {
        throw new Error("chunk failed");
      }
      if (pdf.filename.indexOf("-p13-20") !== -1) {
        return {invoices: [bill("271003")]};
      }
      throw new Error("unexpected chunk " + pdf.filename);
    },
  });
  const failedLoads = failedKeep.invoices.map(
      (item) => String(item.loadNumber || ""));
  check("a failed chunk keeps invoices and later chunks",
      failedLoads.indexOf("271001") !== -1 &&
      failedLoads.indexOf("271002") !== -1 &&
      failedLoads.indexOf("271003") !== -1);
  check("still short of 10 after a failed chunk is held",
      failedKeep.invoiceShortfall &&
      failedKeep.invoiceShortfall.needsReview === true &&
      failedKeep.invoices.length === 3);

  if (failures) {
    console.error("\n" + failures + " failure(s)");
    process.exit(1);
  }
  console.log("\nAll checks passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
