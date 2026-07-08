#!/usr/bin/env node
/**
 * Classify + extract POD from a local PDF (production-equivalent logic).
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
  /\b(signed|signature|bol|bill of lading|delivery receipt|received|consignee|driver|signed load|load document|pod)\b/i; // eslint-disable-line max-len

const POD_PACKAGE_SOURCES = new Set([
  "unsigned_pod_template",
  "signed_bol",
  "signed_load",
  "signed_pod",
  "delivery_receipt",
  "separate_attachment",
  "same_page_as_invoice",
  "last_page_of_invoice",
  "attachment",
]);

const RATE_CONFIRMATION_MARKERS = [
  "rate confirmation",
  "rate con",
  "rateconfirmation",
  "rate and load confirmation",
  "load and rate confirmation",
  "load confirmation",
  "carrier confirmation",
  "carrier rate confirmation",
  "rate agreement",
  "load tender",
  "line haul",
  "line-haul",
  "linehaul",
  "fuel surcharge",
  "carrier pay",
  "total carrier pay",
  "agreed rate",
  "carrier freight charges",
];

let pdfjsModulePromise = null;

function getPdfjs() {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsModulePromise;
}

async function extractPdfPageTexts(buffer) {
  try {
    const pdfjs = await getPdfjs();
    const data = Uint8Array.from(buffer);
    const task = pdfjs.getDocument({
      data,
      isEvalSupported: false,
      useSystemFonts: true,
    });
    const pdf = await task.promise;
    const texts = [];
    let anyText = false;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const txt = tc.items.map((it) => it.str).join(" ").trim();
      if (txt) anyText = true;
      texts.push(txt);
    }
    await pdf.destroy();
    return anyText ? texts : null;
  } catch (_) {
    return null;
  }
}

function textLooksUnsafeForCustomer(text, invoiceAmount) {
  if (!text) return {unsafe: false, reason: null, hasText: false};
  const lower = text.toLowerCase();
  const amount = Number(invoiceAmount);
  if (Number.isFinite(amount) && amount > 0) {
    const formatted = amount.toFixed(2);
    const [intPart, decPart] = formatted.split(".");
    const withCommas =
      `${intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${decPart}`;
    const collapsed = lower.replace(/\s+/g, "");
    if (collapsed.includes(formatted) || collapsed.includes(withCommas)) {
      return {unsafe: true, reason: "carrier_invoice_amount", hasText: true};
    }
  }
  const marker = RATE_CONFIRMATION_MARKERS.find((m) => lower.includes(m));
  if (marker) {
    return {
      unsafe: true,
      reason: `rate_confirmation_marker:${marker}`,
      hasText: true,
    };
  }
  return {unsafe: false, reason: null, hasText: true};
}

function normalizePodDocEntry(doc) {
  if (!doc) return doc;
  const source = String(doc.source || "").trim();
  const reason = String(doc.reason || "").trim();
  const filename = String(doc.attachmentFilename || "").trim();
  const context = `${reason} ${filename}`.toLowerCase();

  if (POD_PACKAGE_SOURCES.has(source) || source === "last_page_of_invoice") {
    return doc;
  }

  if (source === "same_page_as_invoice") {
    const crop = Number(doc.cropFromBottom || 0);
    const looksSigned = FULL_PAGE_POD_KEYWORDS.test(context);
    const largeCrop = crop >= 0.45;
    if (looksSigned || largeCrop) {
      const upgraded = /\b(signed load|load document|load confirmation)\b/i
          .test(context) ? "signed_load" : "signed_bol";
      const upgradeNote =
        `[upgraded ${source} → ${upgraded}: full signed page preferred]`;
      return {
        ...doc,
        source: upgraded,
        cropFromBottom: 0,
        reason: reason ? `${reason} ${upgradeNote}` : upgradeNote.trim(),
      };
    }
  }

  if (!source && doc.attachmentFilename) {
    return {...doc, source: "signed_bol"};
  }

  // AI sometimes puts filename in source — infer from reason text.
  if (!POD_PACKAGE_SOURCES.has(source) && reason) {
    const r = reason.toLowerCase();
    if (/rate confirmation|rate agreement|load confirmation|load tender/.test(r)) {
      return null;
    }
    if (/bill of lading|\bbol\b/.test(r)) {
      return {...doc, source: "signed_bol"};
    }
    if (/delivery receipt|\bpod\b|proof of delivery/.test(r)) {
      return {...doc, source: "delivery_receipt"};
    }
    if (/signed load/.test(r)) {
      return {...doc, source: "signed_load"};
    }
    return {...doc, source: "unsigned_pod_template"};
  }

  return doc;
}

function normalizeDocumentEntries(documents, fallbackFilename) {
  const seen = new Set();
  return documents
      .map((doc) => normalizePodDocEntry({
        ...doc,
        attachmentFilename: doc.attachmentFilename || fallbackFilename,
      }))
      .filter(Boolean)
      .filter((doc) => {
        const key = [
          doc.attachmentFilename,
          String(doc.page || ""),
          doc.source,
        ].join("|");
        if (seen.has(key) || !doc.source) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => (Number(a.page) || 0) - (Number(b.page) || 0));
}

function enrichPodDocumentsWithTrailingPages(
    documents, pageCount, attachmentFilename,
) {
  const totalPages = Number(pageCount);
  if (!Number.isFinite(totalPages) || totalPages <= 1) return documents;

  // When the classifier listed specific pages, trust its omissions (e.g. rate
  // confirmations between invoice and BOL). Only auto-add truly trailing pages
  // after the last listed page.
  const listedPages = documents
      .map((d) => Number(d.page))
      .filter((p) => p > 0);
  if (listedPages.length === 0) return documents;

  const lastListed = Math.max(...listedPages);
  const listed = new Set(listedPages);
  const enriched = [...documents];
  for (let page = lastListed + 1; page <= totalPages; page++) {
    if (listed.has(page)) continue;
    enriched.push({
      source: "unsigned_pod_template",
      page,
      attachmentFilename,
      reason: "[auto-included] POD page after last classified page",
    });
    listed.add(page);
  }
  return enriched.sort(
      (a, b) => (Number(a.page) || 0) - (Number(b.page) || 0),
  );
}

function normalizePodData(pod, pageCount, filename) {
  if (!pod || pod.found !== true) {
    return {found: false, documents: []};
  }

  let documents = Array.isArray(pod.documents) ?
    pod.documents.filter(Boolean) : [];
  if (documents.length === 0 &&
      (pod.source || pod.page || pod.attachmentFilename)) {
    documents = [{
      source: pod.source,
      page: pod.page,
      attachmentFilename: filename,
      cropFromBottom: pod.cropFromBottom,
      reason: pod.reason,
    }];
  }

  documents = normalizeDocumentEntries(documents, filename);
  documents = documents.filter((d) => POD_PACKAGE_SOURCES.has(d.source));
  documents = enrichPodDocumentsWithTrailingPages(
      documents, pageCount, filename,
  );

  return {found: documents.length > 0, documents};
}

async function extractPodDocumentPdfBytes(loadedDoc, doc) {
  const source = String(doc.source || "").trim();
  const pageCount = loadedDoc.getPageCount();

  if (source === "same_page_as_invoice") {
    const cropFromBottom = Math.min(
        Math.max(Number(doc.cropFromBottom || 0.5), 0.1), 0.9);
    const pageNum = Number(doc.page) || 1;
    const pageIndex = Math.max(0, Math.min(pageNum - 1, pageCount - 1));
    const newDoc = await PDFDocument.create();
    const [copiedPage] = await newDoc.copyPages(loadedDoc, [pageIndex]);
    newDoc.addPage(copiedPage);
    const {width, height} = copiedPage.getSize();
    copiedPage.setCropBox(0, 0, width, height * cropFromBottom);
    return newDoc.save();
  }

  if (source === "last_page_of_invoice") {
    if (pageCount < 1) return null;
    const newDoc = await PDFDocument.create();
    const [lastPage] = await newDoc.copyPages(loadedDoc, [pageCount - 1]);
    newDoc.addPage(lastPage);
    return newDoc.save();
  }

  const fullPageSources = new Set([
    "attachment", "signed_bol", "signed_load", "signed_pod",
    "delivery_receipt", "unsigned_pod_template",
  ]);
  if (fullPageSources.has(source)) {
    const podPage = Number(doc.page) || pageCount;
    if (podPage < 1 || podPage > pageCount) return null;
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
    model: "claude-sonnet-5",
    max_tokens: 4096,
    system: "You classify freight carrier invoice attachments. " +
      "Return ONLY valid JSON. No markdown.",
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
            "Include in pod.documents every post-invoice page that supports " +
            "delivery: unsigned POD forms, signed BOL, signed delivery receipt.",
            "Sources: unsigned_pod_template, signed_bol, signed_load, " +
            "delivery_receipt, signed_pod, same_page_as_invoice, " +
            "last_page_of_invoice.",
            "NEVER include invoice pages showing Amount Due or invoice total.",
            "A Rate Confirmation, Rate Agreement, Load Confirmation, or " +
            "Load Tender is NOT a POD — never include rate/load confirmation " +
            "pages in pod.documents, even if signed.",
            "NEVER include pages showing freight rate, line haul, fuel " +
            "surcharge, carrier pay, or any dollar rate/charge amount.",
          ],
          requiredJsonShape: {
            invoiceAmount: 0,
            pod: {
              found: false,
              documents: [{
                source: "",
                page: "",
                attachmentFilename: "",
                reason: "",
              }],
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
  const loadedDoc = await PDFDocument.load(buffer);
  const pageCount = loadedDoc.getPageCount();
  const pageTexts = await extractPdfPageTexts(buffer);

  console.log("PDF:", absPath, `(${pageCount} pages)`);

  const aiResult = await classifyPdf(buffer, filename);
  console.log("\n--- AI classification ---");
  console.log(JSON.stringify({
    invoiceAmount: aiResult.invoiceAmount,
    pod: aiResult.pod,
  }, null, 2));

  const pod = normalizePodData(
      {...aiResult.pod, attachmentFilename: filename},
      pageCount,
      filename,
  );
  console.log("\n--- Normalized POD package pages ---");
  console.log(JSON.stringify(pod.documents, null, 2));

  const merged = await PDFDocument.create();
  const kept = [];
  const skipped = [];

  for (const doc of pod.documents) {
    const pageIndex = (Number(doc.page) || pageCount) - 1;
    const pageText = pageTexts && pageIndex >= 0 && pageIndex < pageTexts.length ?
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
      skipped.push({page: doc.page, source: doc.source, reason: "extract_failed"});
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
