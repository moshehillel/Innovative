/* eslint-disable no-console */
"use strict";

const pod = require("../pod-utils");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const pdfs = [
  {filename: "204068936.060326W.pdf", docType: "INVOICE"},
  {filename: "327106175.081126W.pdf", docType: "INVOICE"},
  {filename: "204135123.081126W.pdf", docType: "INVOICE"},
  {filename: "450538517.081126W.pdf", docType: "INVOICE"},
  {filename: "415815836.081126W.pdf", docType: "INVOICE"},
  {filename: "204170500.081126W.pdf", docType: "INVOICE"},
  {filename: "446774952.081126W.pdf", docType: "INVOICE"},
  {filename: "228182564.081126W.pdf", docType: "INVOICE"},
  {filename: "448260810.081126W.pdf", docType: "INVOICE"},
  {filename: "346726581.081126W.pdf", docType: "INVOICE"},
  {filename: "pod-only.pdf", docType: "POD"},
];

const sevenItems = [
  {attachmentFilename: "204068936.060326W.pdf", proNumber: "204068936"},
  {attachmentFilename: "327106175.081126W.pdf", proNumber: "327106175"},
  {attachmentFilename: "204135123.081126W.pdf", proNumber: "204135123"},
  {attachmentFilename: "450538517.081126W.pdf", proNumber: "450538517"},
  {attachmentFilename: "415815836.081126W.pdf", proNumber: "415815836"},
  {attachmentFilename: "204170500.081126W.pdf", proNumber: "204170500"},
  {attachmentFilename: "446774952.081126W.pdf", proNumber: "446774952"},
];

check("lists only INVOICE pdfs",
    pod.listInvoicePdfAttachments(pdfs).length === 10);

const uncovered = pod.listUncoveredInvoiceAttachments(sevenItems, pdfs);
check("detects CTC batch 24689 trailing 3", uncovered.length === 3);
check("first omitted is 228182564",
    uncovered[0].filename === "228182564.081126W.pdf");
check("second omitted is 448260810",
    uncovered[1].filename === "448260810.081126W.pdf");
check("third omitted is 346726581",
    uncovered[2].filename === "346726581.081126W.pdf");
check("POD companion not treated as uncovered",
    !uncovered.some((a) => a.filename === "pod-only.pdf"));

check("case-insensitive filename claim",
    pod.listUncoveredInvoiceAttachments(
        [{attachmentFilename: "228182564.081126W.PDF"}],
        [{filename: "228182564.081126W.pdf", docType: "INVOICE"}],
    ).length === 0);

check("full coverage => empty uncovered",
    pod.listUncoveredInvoiceAttachments(
        pdfs.filter((p) => p.docType === "INVOICE").map((p) => ({
          attachmentFilename: p.filename,
        })),
        pdfs,
    ).length === 0);

check("shared attachmentFilename covers multi-invoice PDF",
    pod.listUncoveredInvoiceAttachments(
        [
          {attachmentFilename: "bundle.pdf", loadNumber: "265001"},
          {attachmentFilename: "bundle.pdf", loadNumber: "265002"},
        ],
        [{filename: "bundle.pdf", docType: "INVOICE"}],
    ).length === 0);

check("normalizeAttachmentFilenameKey trims",
    pod.normalizeAttachmentFilenameKey("  Foo.PDF ") === "foo.pdf");

const ctBatch = pdfs.filter((p) => p.docType === "INVOICE");
check("10 separate invoice PDFs classify one at a time",
    pod.shouldClassifyEachInvoicePdf(ctBatch) === true);
check("one multi-invoice PDF stays a single call",
    pod.shouldClassifyEachInvoicePdf(
        [{filename: "fedex-bundle.pdf", docType: "INVOICE"}]) === false);
check("two invoice PDFs stay a single call",
    pod.shouldClassifyEachInvoicePdf(ctBatch.slice(0, 2)) === false);
check("POD companions do not force per-file classification",
    pod.shouldClassifyEachInvoicePdf([
      {filename: "bill.pdf", docType: "INVOICE"},
      {filename: "pod-a.pdf", docType: "POD"},
      {filename: "pod-b.pdf", docType: "POD"},
    ]) === false);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll checks passed");
