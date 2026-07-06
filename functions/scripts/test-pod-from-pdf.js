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

const FULL_PAGE_POD_KEYWORDS =
  /\b(signed|signature|bol|bill of lading|delivery receipt|received|consignee|driver|signed load|load document|pod)\b/i;

function normalizePodDocEntry(doc) {
  if (!doc) return doc;
  const source = String(doc.source || "").trim();
  const reason = String(doc.reason || "").trim();
  const context = `${reason} ${doc.attachmentFilename || ""}`.toLowerCase();
  const full = new Set([
    "separate_attachment", "attachment", "signed_bol", "signed_load",
    "signed_pod", "unsigned_pod_template", "last_page_of_invoice",
  ]);
  if (full.has(source)) return doc;
  if (source === "same_page_as_invoice") {
    const crop = Number(doc.cropFromBottom || 0);
    if (FULL_PAGE_POD_KEYWORDS.test(context) || crop >= 0.45) {
      const upgraded = /\b(signed load|load document)\b/i.test(context) ?
        "signed_load" : "signed_bol";
      return {...doc, source: upgraded, cropFromBottom: 0};
    }
  }
  if (!source && doc.attachmentFilename) {
    return {...doc, source: "signed_bol"};
  }
  return doc;
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

function normalizePodData(pod, pageCount) {
  if (!pod || pod.found !== true) return pod;
  const normalized = normalizePodDocEntry(pod);
  const fallbackFilename = normalized.attachmentFilename || "";
  let documents = Array.isArray(normalized.documents) ?
    normalized.documents.filter(Boolean) : [];
  if (documents.length === 0 &&
      (normalized.source || normalized.page || fallbackFilename)) {
    documents = [{
      source: normalized.source,
      page: normalized.page,
      attachmentFilename: fallbackFilename,
      cropFromBottom: normalized.cropFromBottom,
      reason: normalized.reason,
    }];
  }
  documents = documents.map((d) => normalizePodDocEntry({
    ...d,
    attachmentFilename: d.attachmentFilename || fallbackFilename,
  }));
  documents = enrichPodDocuments(documents, pageCount, fallbackFilename);
  return {...normalized, documents};
}

async function extractPodDocumentPdfBytes(loadedDoc, doc) {
  const source = String(doc.source || "").trim();
  const pageCount = loadedDoc.getPageCount();

  if (source === "last_page_of_invoice") {
    const newDoc = await PDFDocument.create();
    const [lastPage] = await newDoc.copyPages(loadedDoc, [pageCount - 1]);
    newDoc.addPage(lastPage);
    return newDoc.save();
  }

  const fullPage = new Set([
    "attachment", "signed_bol", "signed_load", "signed_pod",
    "unsigned_pod_template",
  ]);
  if (fullPage.has(source)) {
    const podPage = Number(doc.page) || pageCount;
    const newDoc = await PDFDocument.create();
    const [page] = await newDoc.copyPages(loadedDoc, [podPage - 1]);
    newDoc.addPage(page);
    return newDoc.save();
  }
  return null;
}

async function classifyPdf(buffer, filename) {
  const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: "You classify freight carrier invoice attachments. Return ONLY valid JSON. No markdown.",
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
          task: "Extract invoice data and classify from the attached PDF.",
          rules: [
            "Detect Proof of Delivery (POD) documents.",
            "When a multi-page PDF contains BOTH an unsigned POD/delivery receipt form template AND a signed BOL or signed delivery confirmation, include BOTH in pod.documents (page order). Use source 'unsigned_pod_template' for blank unsigned forms and 'signed_bol' or 'signed_load' for signed pages.",
            "pod.documents is an array of {source, page, attachmentFilename, reason}. List every POD-related page after the invoice.",
            "Set pod.attachmentFilename to the PDF filename.",
          ],
          requiredJsonShape: {
            loadNumber: "",
            invoiceNumber: "",
            carrierName: "",
            invoiceAmount: 0,
            pod: {
              found: false,
              documents: [{source: "", page: "", attachmentFilename: "", reason: ""}],
              source: "",
              attachmentFilename: "",
              page: "",
              reason: "",
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

async function extractAll(buffer, filename, aiResult) {
  const pageCount = (await PDFDocument.load(buffer)).getPageCount();
  const pod = normalizePodData({
    ...aiResult.pod,
    attachmentFilename: aiResult.pod.attachmentFilename || filename,
  }, pageCount);
  const documents = pod.documents || [];
  const loadedDoc = await PDFDocument.load(buffer);
  const merged = await PDFDocument.create();
  const files = [];

  for (const doc of documents) {
    const pdfBytes = await extractPodDocumentPdfBytes(loadedDoc, doc);
    if (!pdfBytes) continue;
    const partDoc = await PDFDocument.load(pdfBytes);
    const copied = await merged.copyPages(partDoc, partDoc.getPageIndices());
    for (const page of copied) merged.addPage(page);
    files.push({
      source: doc.source,
      page: doc.page,
      bytes: Buffer.from(pdfBytes),
    });
  }

  return {
    pod,
    files,
    combined: files.length > 0 ?
      Buffer.from(await merged.save()) : null,
  };
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

  console.log("PDF:", absPath, `(${(buffer.length / 1024).toFixed(1)} KB, ${pageCount} pages)`);

  const aiResult = await classifyPdf(buffer, filename);
  console.log("\n--- AI POD classification ---");
  console.log(JSON.stringify(aiResult.pod, null, 2));

  const {pod, files, combined} = await extractAll(buffer, filename, aiResult);
  console.log("\n--- Normalized documents ---");
  console.log(JSON.stringify(pod.documents, null, 2));

  if (!combined) {
    console.log("\nNo POD extracted.");
    process.exit(2);
  }

  const base = path.join(path.dirname(absPath), path.basename(absPath, ".pdf"));
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const partPath = `${base}-pod-${f.source}-p${f.page}.pdf`;
    fs.writeFileSync(partPath, f.bytes);
    console.log(`Part ${i + 1}: ${f.source} page ${f.page} → ${partPath}`);
  }

  const combinedPath = `${base}-pod-combined.pdf`;
  fs.writeFileSync(combinedPath, combined);
  console.log(`\nCombined (${files.length} pages): ${combinedPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
