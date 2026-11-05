/* eslint-disable no-console */
"use strict";

const pod = require("../pod-utils");
const batch = require("../invoice-batch-classification");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

function ctPdf(name) {
  return {
    filename: name,
    mimeType: "application/pdf",
    docType: "INVOICE",
    buffer: Buffer.from("%PDF-1.4"),
  };
}

const ctNames = [
  "446939068.073126W.pdf",
  "316652619.080126W.pdf",
  "446767055.081526W.pdf",
  "446767824.081826W.pdf",
  "244042743.082226W.pdf",
  "204147706.091626W.pdf",
  "447392176.092126W.pdf",
  "317061836.082426W.pdf",
  "446755860.082226W.pdf",
  "347121600.091926W.pdf",
];

check("two or more invoice PDFs classify one at a time",
    pod.shouldClassifyEachInvoicePdf(ctNames.map(ctPdf)) === true);
check("one invoice PDF stays a single call",
    pod.shouldClassifyEachInvoicePdf([ctPdf("bill.pdf")]) === false);
check("POD companions do not force a split",
    pod.shouldClassifyEachInvoicePdf([
      ctPdf("bill.pdf"),
      {filename: "pod-a.pdf", docType: "POD", mimeType: "application/pdf"},
      {filename: "pod-b.pdf", docType: "POD", mimeType: "application/pdf"},
    ]) === false);

/**
 * Combined call reproduces the live bug: only the first PDF is returned,
 * or the whole call dies with a thinking-only response.
 * @param {Array<object>} pdfs Invoice PDFs.
 * @return {Promise<object>}
 */
async function readAll(pdfs) {
  const seen = [];
  const result = await batch.classifyCarrierInvoiceAttachments({
    pdfAttachments: pdfs,
    messageId: "ct-batch",
    classifyCombined: async () => {
      seen.push("combined");
      const err = new Error("Claude returned no text block");
      throw err;
    },
    classifyOne: async (pdf) => {
      seen.push(pdf.filename);
      return {
        invoices: [{
          attachmentFilename: pdf.filename,
          proNumber: String(pdf.filename).split(".")[0],
          carrierName: "Central Transport",
        }],
      };
    },
  });
  return {result, seen};
}

(async () => {
  const two = [ctPdf(ctNames[0]), ctPdf(ctNames[1])];
  const twoRead = await readAll(two);
  const twoFiles = twoRead.result.invoices.map((i) => i.attachmentFilename);
  check("two-PDF email does not stop after the first",
      twoFiles.length === 2 &&
      twoFiles.includes(ctNames[0]) &&
      twoFiles.includes(ctNames[1]));
  check("two-PDF email does not use the combined call",
      !twoRead.seen.includes("combined"));

  const ten = ctNames.map(ctPdf);
  ten.push({
    filename: "logo.png",
    mimeType: "image/png",
    docType: "OTHER",
    buffer: Buffer.from("png"),
  });
  const tenRead = await readAll(ten);
  const got = new Set(
      tenRead.result.invoices.map((i) => i.attachmentFilename));
  check("ten-PDF Central Transport batch reads every invoice",
      ctNames.every((name) => got.has(name)));
  check("ten-PDF batch does not return only the first",
      tenRead.result.invoices.length === ctNames.length);
  check("logo is not treated as an invoice PDF",
      !got.has("logo.png"));

  const attempts = {};
  const partial = await batch.classifyCarrierInvoiceAttachments({
    pdfAttachments: ctNames.slice(0, 3).map(ctPdf),
    classifyCombined: async () => {
      throw new Error("combined should not run");
    },
    classifyOne: async (pdf) => {
      const n = (attempts[pdf.filename] || 0) + 1;
      attempts[pdf.filename] = n;
      if (pdf.filename === ctNames[1] && n === 1) {
        return {invoices: []};
      }
      return {
        invoices: [{attachmentFilename: pdf.filename}],
      };
    },
  });
  const partialNames = partial.invoices.map((i) => i.attachmentFilename);
  check("missing PDF is retried and still read",
      partialNames.filter((n) => n === ctNames[1]).length >= 1 &&
      partialNames.includes(ctNames[0]) &&
      partialNames.includes(ctNames[2]));

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll checks passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
