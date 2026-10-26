/* eslint-disable no-console */
"use strict";

const zipMod = require("../invoice-zip-attachments");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const pdfBytes = Buffer.from(
    "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
);
const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const exeBytes = Buffer.from("MZ fake executable payload here");

check("detects .zip filename",
    zipMod.isZipAttachment({filename: "WWEX_invoices.zip"}, null));
check("detects zip mime",
    zipMod.isZipAttachment(
        {filename: "packet", mimeType: "application/zip"}, null));
check("rejects plain pdf",
    !zipMod.isZipAttachment(
        {filename: "inv.pdf", mimeType: "application/pdf"}, pdfBytes));

check("safe name allows pdf basename",
    zipMod.safeInvoiceEntryName("invoices/WWEX-09032026.pdf") ===
      "WWEX-09032026.pdf");
check("safe name blocks path traversal",
    zipMod.safeInvoiceEntryName("../evil.pdf") === null);
check("safe name blocks exe",
    zipMod.safeInvoiceEntryName("setup.exe") === null);
check("safe name blocks nested zip",
    zipMod.safeInvoiceEntryName("more.zip") === null);
check("safe name blocks directory",
    zipMod.safeInvoiceEntryName("folder/") === null);

const wwexZip = zipMod.buildTestZip([
  {name: "WorldwideExpress_Invoice_W0003079963.pdf", data: pdfBytes},
  {name: "readme.txt", data: Buffer.from("ignore me")},
  {name: "pod-scan.png", data: pngBytes},
  {name: "tools/payload.exe", data: exeBytes},
]);

check("zip magic detected",
    zipMod.isZipAttachment({filename: "x.bin"}, wwexZip));

const extracted = zipMod.extractInvoiceFilesFromZip(wwexZip, {
  zipFilename: "WWEX_Invoices_09032026.zip",
});
check("extracts PDF + PNG only", extracted.files.length === 2);
check("pdf filename preserved",
    extracted.files.some((f) =>
      f.filename === "WorldwideExpress_Invoice_W0003079963.pdf" &&
      f.mimeType === "application/pdf" &&
      f.fromZip === true));
check("png extracted",
    extracted.files.some((f) =>
      f.filename === "pod-scan.png" && f.mimeType === "image/png"));
check("skips txt and exe",
    extracted.skipped.some((s) => s.filename === "readme.txt") &&
    extracted.skipped.some((s) => /payload\.exe/.test(s.filename)));

const deflatedZip = zipMod.buildTestZip([
  {
    name: "invoice.pdf",
    data: pdfBytes,
    method: zipMod.METHOD_DEFLATE,
  },
  {
    name: "photo.jpg",
    data: jpegBytes,
    method: zipMod.METHOD_DEFLATE,
  },
]);
const deflated = zipMod.extractInvoiceFilesFromZip(deflatedZip);
check("inflates deflate-method PDF",
    deflated.files.some((f) =>
      f.filename === "invoice.pdf" &&
      f.buffer.slice(0, 4).toString() === "%PDF"));
check("inflates deflate-method JPEG",
    deflated.files.some((f) => f.filename === "photo.jpg"));

const bombZip = zipMod.buildTestZip([
  {
    name: "bomb.pdf",
    data: Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.alloc(5000, 0x41),
      Buffer.from("\n%%EOF\n"),
    ]),
    method: zipMod.METHOD_DEFLATE,
  },
]);
const bombResult = zipMod.extractInvoiceFilesFromZip(bombZip, {
  maxCompressionRatio: 2,
  maxSingleFileBytes: 100000,
});
check("rejects high compression ratio",
    bombResult.files.length === 0 &&
    bombResult.skipped.some((s) => s.reason === "compression_ratio"));

const renamedExe = zipMod.buildTestZip([
  {name: "invoice.pdf", data: exeBytes},
]);
const renamed = zipMod.extractInvoiceFilesFromZip(renamedExe);
check("rejects non-PDF magic with .pdf name",
    renamed.files.length === 0 &&
    renamed.skipped.some((s) => s.reason === "not_pdf_magic"));

(async () => {
  const input = [
    {
      filename: "WWEX_Invoices_09032026.zip",
      mimeType: "application/zip",
      buffer: wwexZip,
    },
    {
      filename: "cover-note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("see zip"),
    },
  ];
  const expanded = await zipMod.expandZipAttachments(
      null, "msg-1", input, async (_g, _id, att) => att.buffer);
  check("expand keeps original zip",
      expanded.some((a) => a.filename === "WWEX_Invoices_09032026.zip" &&
        a.zipExpanded === true));
  check("expand adds PDF from zip",
      expanded.some((a) =>
        a.filename === "WorldwideExpress_Invoice_W0003079963.pdf" &&
        a.fromZip === true));
  check("expand preserves non-zip sibling",
      expanded.some((a) => a.filename === "cover-note.txt"));

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll invoice ZIP attachment tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
