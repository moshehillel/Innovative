#!/usr/bin/env node
/**
 * Classify + extract POD from a local PDF (same logic as production).
 * Usage: node scripts/test-pod-from-pdf.js "C:\path\to\invoice.pdf"
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const {PDFDocument} = require("pdf-lib");

const envFile = path.join(__dirname, "..", ".env.tai-invoice-automation");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const POD_PACKAGE_SOURCES = new Set([
  "unsigned_pod_template", "signed_bol", "signed_load", "signed_pod",
  "delivery_receipt", "separate_attachment", "same_page_as_invoice",
  "last_page_of_invoice", "attachment",
]);

function pdfBytesContainInvoiceAmount(pdfBytes, invoiceAmount) {
  const amount = Number(invoiceAmount);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const haystack = Buffer.from(pdfBytes).toString("latin1");
  const formatted = amount.toFixed(2);
  return [`${formatted}`, `$${formatted}`, `Amount Due $${formatted}`]
      .some((p) => haystack.includes(p));
}

function enrichPodDocuments(documents, pageCount, attachmentFilename) {
  if (!pageCount || pageCount <= 1) return documents;
  const listed = new Set(
      documents.map((d) => Number(d.page)).filter((p) => p > 0),
  );
  const enriched = [...documents];
  for (let page = 2; page <= pageCount; page++) {
    if (listed.has(page)) continue;
    enriched.push({
      source: "unsigned_pod_template",
      page,
      attachmentFilename,
      reason: "[auto-included] POD page after invoice",
    });
    listed.add(page);
  }
  return enriched.sort((a, b) => (Number(a.page) || 0) - (Number(b.page) || 0));
}

function normalizePodData(pod, pageCount, filename) {
  if (!pod || !pod.found) return {found: false, documents: []};
  let documents = Array.isArray(pod.documents) ?
    pod.documents.filter(Boolean) : [];
  documents = documents
      .filter((d) => POD_PACKAGE_SOURCES.has(d.source))
      .map((d) => ({...d, attachmentFilename: d.attachmentFilename || filename}));
  documents = enrichPodDocuments(documents, pageCount, filename);
  return {found: documents.length > 0, documents};
}

async function classifyPdf(buffer, filename) {
  const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    system: "Return ONLY valid JSON. No markdown.",
    messages: [{role: "user", content: [
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: buffer.toString("base64"),
        },
        title: filename,
      },
      {
        type: "text",
        text: JSON.stringify({
          task: "Find POD/shipment pages. Return invoiceAmount and pod.",
          rules: [
            "Include all post-invoice pages in pod.documents: POD forms, BOL, delivery receipts.",
            "Never include pages with Amount Due / invoice total in pod.documents.",
          ],
          requiredJsonShape: {
            invoiceAmount: 0,
            pod: {
              found: false,
              documents: [{source: "", page: "", attachmentFilename: "", reason: ""}],
            },
          },
        }),
      },
    ]}],
  });
  const rawText = response.content[0].text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  return JSON.parse(rawText);
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: node scripts/test-pod-from-pdf.js <path-to-pdf>");
    process.exit(1);
  }

  const absPath = path.resolve(inputPath);
  const buffer = fs.readFileSync(absPath);
  const filename = path.basename(absPath);
  const pageCount = (await PDFDocument.load(buffer)).getPageCount();

  console.log("PDF:", absPath, `(${pageCount} pages)`);

  const aiResult = await classifyPdf(buffer, filename);
  console.log("\n--- AI ---");
  console.log(JSON.stringify({
    invoiceAmount: aiResult.invoiceAmount,
    pod: aiResult.pod,
  }, null, 2));

  const pod = normalizePodData(
      {...aiResult.pod, attachmentFilename: filename},
      pageCount,
      filename,
  );
  console.log("\n--- POD package pages ---");
  console.log(JSON.stringify(pod.documents, null, 2));

  const loadedDoc = await PDFDocument.load(buffer);
  const merged = await PDFDocument.create();
  const files = [];

  for (const doc of pod.documents) {
    const podPage = Number(doc.page) || pageCount;
    const newDoc = await PDFDocument.create();
    const [page] = await newDoc.copyPages(loadedDoc, [podPage - 1]);
    newDoc.addPage(page);
    const bytes = Buffer.from(await newDoc.save());

    if (pdfBytesContainInvoiceAmount(bytes, aiResult.invoiceAmount)) {
      console.log(`SKIP page ${doc.page} — contains invoice amount $${aiResult.invoiceAmount}`);
      continue;
    }

    const copied = await merged.copyPages(newDoc, [0]);
    for (const p of copied) merged.addPage(p);
    files.push({source: doc.source, page: doc.page, bytes});
    console.log(`OK page ${doc.page} (${doc.source})`);
  }

  if (files.length === 0) {
    console.log("\nNo POD pages after amount filter.");
    process.exit(2);
  }

  const base = path.join(path.dirname(absPath), path.basename(absPath, ".pdf"));
  const combinedPath = `${base}-pod-combined.pdf`;
  fs.writeFileSync(combinedPath, Buffer.from(await merged.save()));
  console.log(`\nCombined POD (${files.length} pages): ${combinedPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
