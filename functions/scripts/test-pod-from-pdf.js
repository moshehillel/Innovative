#!/usr/bin/env node
/**
 * Classify + extract POD from a local PDF (shared pod-utils pipeline).
 * Usage: node scripts/test-pod-from-pdf.js "C:\path\to\invoice.pdf"
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const {PDFDocument} = require("pdf-lib");
const podUtils = require("../pod-utils");

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

const {
  extractPdfPageTexts,
  textLooksUnsafeForCustomer,
  normalizePodFromClassification,
  extractPodDocumentPdfBytes,
  parseClassificationResponse,
  resolvePodPageIndex,
  POD_BLOCK_SHAPE,
  buildPodClassifierRules,
} = podUtils;

async function classifyInvoicePdf(buffer, filename) {
  const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    system: "You classify freight carrier invoice attachments. " +
      "Return ONLY valid JSON. No markdown. " +
      "You must strictly match requiredJsonShape keys and types. " +
      "You can see the full PDF layout — use visual context to correctly " +
      "associate labels with their values even when they appear in columns.",
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
          task: "Extract invoiceAmount and POD/shipment document pages.",
          rules: [
            "Find the carrier invoice total as invoiceAmount.",
            ...buildPodClassifierRules({singlePdf: true}),
          ],
          requiredJsonShape: {
            invoiceAmount: 0,
            pod: POD_BLOCK_SHAPE,
          },
        }),
      },
    ]}],
  });
  return parseClassificationResponse(response.content);
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
  const loadedDoc = await PDFDocument.load(buffer);
  const pageCount = loadedDoc.getPageCount();
  const pageTexts = await extractPdfPageTexts(buffer);

  console.log("PDF:", absPath, `(${pageCount} pages)`);

  const aiResult = await classifyInvoicePdf(buffer, filename);
  console.log("\n--- AI classification ---");
  console.log(JSON.stringify({
    invoiceAmount: aiResult.invoiceAmount,
    pod: aiResult.pod,
  }, null, 2));

  const normalizedPod = normalizePodFromClassification(aiResult, {
    pageCount,
    attachmentFilename: filename,
  });
  const documents = normalizedPod.found ? normalizedPod.documents : [];
  console.log("\n--- Normalized POD package pages ---");
  console.log(JSON.stringify({
    found: normalizedPod.found,
    attachmentFilename: normalizedPod.attachmentFilename,
    documents,
  }, null, 2));

  const merged = await PDFDocument.create();
  const kept = [];
  const skipped = [];

  for (const doc of documents) {
    const pageIndex = resolvePodPageIndex(doc, pageCount);
    if (pageIndex === null) {
      skipped.push({
        page: doc.page,
        source: doc.source,
        reason: "invalid_or_missing_page",
        aiReason: doc.reason,
      });
      console.log(
          `SKIP page ${doc.page} (${doc.source}) — invalid or missing page`,
      );
      continue;
    }

    const pageText = pageTexts && pageIndex < pageTexts.length ?
      pageTexts[pageIndex] : null;
    const verdict = textLooksUnsafeForCustomer(
        pageText, aiResult.invoiceAmount,
    );

    if (verdict.unsafe) {
      skipped.push({
        page: doc.page,
        source: doc.source,
        reason: verdict.reason,
        aiReason: doc.reason,
      });
      console.log(
          `SKIP page ${doc.page} (${doc.source}) — ${verdict.reason}`,
      );
      continue;
    }

    const pdfBytes = await extractPodDocumentPdfBytes(loadedDoc, doc);
    if (!pdfBytes) {
      skipped.push({
        page: doc.page, source: doc.source, reason: "extract_failed",
      });
      console.log(`SKIP page ${doc.page} — could not extract`);
      continue;
    }

    const partDoc = await PDFDocument.load(pdfBytes);
    const copied = await merged.copyPages(partDoc, partDoc.getPageIndices());
    for (const p of copied) merged.addPage(p);
    kept.push({
      page: doc.page,
      source: doc.source,
      reason: doc.reason,
      hasText: verdict.hasText,
    });
    console.log(`KEEP page ${doc.page} (${doc.source})`);
  }

  console.log("\n--- Summary ---");
  console.log(JSON.stringify({kept, skipped}, null, 2));

  if (kept.length === 0) {
    console.log("\nNo POD pages after safety filter.");
    process.exit(2);
  }

  const base = path.join(path.dirname(absPath), path.basename(absPath, ".pdf"));
  const combinedPath = `${base}-pod-combined.pdf`;
  fs.writeFileSync(combinedPath, Buffer.from(await merged.save()));
  console.log(`\nCombined POD (${kept.length} pages): ${combinedPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
