/**
 * Shared POD classification, normalization, and PDF extraction helpers.
 * Used by production intake (index.js) and test-pod-from-pdf.js.
 */
"use strict";

const {PDFDocument} = require("pdf-lib");

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

/** Example POD document entry for classifier requiredJsonShape. */
const POD_DOCUMENT_SHAPE = {
  source: "",
  page: 1,
  attachmentFilename: "",
  reason: "",
  cropFromBottom: 0,
};

/** Example POD block for classifier requiredJsonShape. */
const POD_BLOCK_SHAPE = {
  found: false,
  documents: [POD_DOCUMENT_SHAPE],
  source: "",
  attachmentFilename: "",
  page: 1,
  cropFromBottom: 0,
  reason: "",
};

let pdfjsModulePromise = null;

/**
 * @param {string} source Document source label.
 * @return {boolean}
 */
function isPodPackageSource(source) {
  return POD_PACKAGE_SOURCES.has(String(source || "").trim());
}

/**
 * @return {Promise<object>} pdfjs module.
 */
function getPdfjs() {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsModulePromise;
}

/**
 * @param {Buffer|Uint8Array} buffer Original PDF bytes.
 * @return {Promise<string[]|null>} Page texts (index 0 = page 1) or null.
 */
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

/**
 * @param {string|null} text Extracted page text.
 * @param {number} invoiceAmount Carrier invoice amount.
 * @return {object} {unsafe, reason, hasText}
 */
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

/**
 * @param {object} doc POD document entry.
 * @param {number} pageCount Total pages in the PDF.
 * @return {number|null} 1-based page number or null when invalid.
 */
function resolvePodPage(doc, pageCount) {
  const source = String(doc.source || "").trim();
  const total = Number(pageCount);
  if (!Number.isFinite(total) || total < 1) return null;

  if (source === "last_page_of_invoice") {
    return total;
  }

  const raw = doc.page;
  if (raw === "" || raw === null || raw === undefined) {
    return null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > total) {
    return null;
  }
  return Math.floor(n);
}

/**
 * @param {object} doc POD document entry.
 * @param {number} pageCount Total pages in the PDF.
 * @return {number|null} 0-based page index or null when invalid.
 */
function resolvePodPageIndex(doc, pageCount) {
  const page = resolvePodPage(doc, pageCount);
  return page !== null ? page - 1 : null;
}

/**
 * @param {object} doc POD document entry.
 * @return {object}
 */
function normalizePodDocEntry(doc) {
  if (!doc) return doc;

  const source = String(doc.source || "").trim();
  const reason = String(doc.reason || "").trim();
  const filename = String(doc.attachmentFilename || "").trim();
  const context = `${reason} ${filename}`.toLowerCase();

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
    return doc;
  }

  if (POD_PACKAGE_SOURCES.has(source) ||
      source === "last_page_of_invoice") {
    return doc;
  }

  if (!source && doc.attachmentFilename) {
    return {...doc, source: "signed_bol"};
  }

  return doc;
}

/**
 * @param {Array<object>} documents Document entries.
 * @param {string} fallbackFilename Attachment filename.
 * @return {Array<object>}
 */
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

/**
 * @param {Array<object>} documents POD document entries.
 * @param {number|null} pageCount Total PDF page count when known.
 * @param {string} attachmentFilename Attachment filename.
 * @return {Array<object>}
 */
function enrichPodDocumentsWithTrailingPages(
    documents,
    pageCount,
    attachmentFilename,
) {
  const totalPages = Number(pageCount);
  if (!Number.isFinite(totalPages) || totalPages <= 1) {
    return documents;
  }

  const listedPages = documents
      .map((d) => Number(d.page))
      .filter((p) => p > 0);
  if (listedPages.length === 0) {
    return documents;
  }

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

/**
 * @param {object|null} pod POD block from AI classification.
 * @param {object} [options] Options.
 * @param {number} [options.pageCount] PDF page count when known.
 * @param {string} [options.attachmentFilename] Default attachment filename.
 * @return {object}
 */
function normalizePodData(pod, options = {}) {
  if (!pod || pod.found !== true) {
    return {found: false, documents: []};
  }

  const fallbackFilename = options.attachmentFilename ||
    pod.attachmentFilename || "";
  const pageCount = Number(options.pageCount || pod.pageCount || 0);

  let documents = Array.isArray(pod.documents) ?
    pod.documents.filter(Boolean) : [];
  if (documents.length === 0 &&
      (pod.source || pod.page || pod.attachmentFilename)) {
    documents = [{
      source: pod.source,
      page: pod.page,
      attachmentFilename: fallbackFilename,
      cropFromBottom: pod.cropFromBottom,
      reason: pod.reason,
    }];
  }

  documents = normalizeDocumentEntries(documents, fallbackFilename);
  documents = documents.filter((doc) => isPodPackageSource(doc.source));
  documents = enrichPodDocumentsWithTrailingPages(
      documents, pageCount, fallbackFilename,
  );

  const primary = documents.find((d) =>
    d.source === "signed_load" || d.source === "delivery_receipt" ||
    d.source === "signed_pod" || d.source === "signed_bol") ||
    documents[0];

  return {
    found: documents.length > 0,
    documents,
    source: (primary && primary.source) || pod.source || "",
    page: (primary && primary.page) || pod.page || "",
    attachmentFilename: fallbackFilename ||
      (primary && primary.attachmentFilename) || "",
    cropFromBottom: pod.cropFromBottom || 0,
    reason: pod.reason || "",
  };
}

/**
 * @param {object} aiResult AI classification result.
 * @param {object} [options] Passed to normalizePodData.
 * @return {object}
 */
function normalizePodFromClassification(aiResult, options = {}) {
  const pod = (aiResult && aiResult.pod) || {};
  const filename = options.attachmentFilename || pod.attachmentFilename || "";
  return normalizePodData({
    ...pod,
    attachmentFilename: filename,
  }, options);
}

/**
 * @param {object|null} pod POD block.
 * @param {object} [options] Options.
 * @return {Array<object>}
 */
function coercePodDocuments(pod, options = {}) {
  return resolvePodDocuments(pod, options).documents;
}

/**
 * @param {object|null} pod POD block.
 * @param {object} [options] Options.
 * @return {{normalized: object, documents: Array<object>}}
 */
function resolvePodDocuments(pod, options = {}) {
  const normalized = normalizePodData(pod, options);
  if (!normalized.found) {
    return {normalized, documents: []};
  }
  const documents = (normalized.documents || [])
      .filter((doc) => isPodPackageSource(doc.source));
  return {normalized, documents};
}

/**
 * @param {object} loadedDoc Loaded PDF document.
 * @param {object} doc POD document entry.
 * @return {Promise<Uint8Array|null>} PDF bytes or null.
 */
async function extractPodDocumentPdfBytes(loadedDoc, doc) {
  const source = String(doc.source || "").trim();
  const pageCount = loadedDoc.getPageCount();

  if (source === "same_page_as_invoice") {
    const cropFromBottom = Math.min(
        Math.max(Number(doc.cropFromBottom || 0.5), 0.1), 0.9);
    const pageNum = resolvePodPage(doc, pageCount);
    if (pageNum === null) return null;
    const pageIndex = pageNum - 1;
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
    "attachment",
    "signed_bol",
    "signed_load",
    "signed_pod",
    "delivery_receipt",
    "unsigned_pod_template",
    "separate_attachment",
  ]);
  if (fullPageSources.has(source)) {
    const podPage = resolvePodPage(doc, pageCount);
    if (podPage === null) return null;
    const newDoc = await PDFDocument.create();
    const [page] = await newDoc.copyPages(loadedDoc, [podPage - 1]);
    newDoc.addPage(page);
    return newDoc.save();
  }

  return null;
}

/**
 * @param {string} rawText Claude text response.
 * @return {object} Parsed JSON.
 */
function parseClassificationJson(rawText) {
  const trimmed = String(rawText || "").trim();
  const jsonText = trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
  return JSON.parse(jsonText);
}

/**
 * @param {Array<object>} content Claude message content blocks.
 * @return {object} Parsed JSON.
 */
function parseClassificationResponse(content) {
  if (!content || content.length === 0) {
    throw new Error("Claude returned an empty response");
  }
  const block = content.find((b) => b.type === "text");
  if (!block || !block.text) {
    throw new Error(
        "Claude returned no text block: " +
        JSON.stringify(content).slice(0, 500),
    );
  }
  try {
    return parseClassificationJson(block.text);
  } catch (e) {
    throw new Error(
        `Claude returned non-JSON response: ${block.text.slice(0, 200)}`,
    );
  }
}

/**
 * POD classifier rules shared by production and the local test script.
 * @param {object} [options] Options.
 * @param {boolean} [options.singlePdf] Omit separate_attachment for one file.
 * @return {Array<string>}
 */
function buildPodClassifierRules(options = {}) {
  const singlePdf = Boolean(options.singlePdf);
  const sources = [
    "'unsigned_pod_template'", "'signed_bol'", "'signed_load'",
    "'delivery_receipt'", "'signed_pod'",
  ];
  if (!singlePdf) {
    sources.push("'separate_attachment'");
  }
  sources.push("'last_page_of_invoice'", "'same_page_as_invoice'");

  const rules = [
    "Detect Proof of Delivery (POD) and shipment document pages.",
    "Include in pod.documents every post-invoice page that supports " +
    "delivery: unsigned POD forms, signed BOL, signed delivery receipt.",
    `Sources: ${sources.join(", ")}.`,
    "When a PDF has invoice + POD form + signed BOL + delivery receipt, " +
    "list ALL of those pages in pod.documents (page order).",
    "pod.documents is an array of {source, page, attachmentFilename, " +
    "reason, cropFromBottom} with 1-based page numbers.",
    "NEVER include a page in pod.documents if it shows the carrier " +
    "invoice Amount Due, bill total, or line-item charges matching " +
    "invoiceAmount — that is the invoice page, not POD/BOL.",
    "A POD proves the GOODS were DELIVERED: delivery signature, " +
    "received/delivered date, consignee sign-off, piece/pallet counts. " +
    "A Rate Confirmation, Rate Agreement, Load Confirmation, Carrier " +
    "Confirmation or Load Tender proves the agreed CARRIER PAY/RATE and " +
    "is NOT a POD. NEVER include a rate/load confirmation page in " +
    "pod.documents, even if it is signed — it exposes carrier cost.",
    "NEVER include any page that shows a freight rate, line haul, fuel " +
    "surcharge, carrier pay, agreed rate, or any dollar rate/charge " +
    "amount. Only include pages proving delivery, with no pricing.",
  ];

  if (singlePdf) {
    rules.push(
        "The invoice and POD are in the SAME PDF — list POD pages " +
        "individually by page number with 'signed_bol', 'signed_load', " +
        "'delivery_receipt', 'signed_pod', or 'unsigned_pod_template'.",
    );
  } else {
    rules.push(
        "Use source 'separate_attachment' ONLY when the POD is a DIFFERENT " +
        "file than the carrier invoice PDF. If the invoice and POD are in " +
        "the SAME PDF, list the POD pages individually by page number with " +
        "'signed_bol', 'signed_load', 'delivery_receipt', 'signed_pod', or " +
        "'unsigned_pod_template' — never 'separate_attachment'.",
    );
  }

  rules.push(
      "Use source 'same_page_as_invoice' ONLY when invoice line items " +
      "are on top and a small signature/stamp block is at the bottom. " +
      "Set cropFromBottom on that document entry to the bottom fraction " +
      "(e.g. 0.35).",
  );

  return rules;
}

module.exports = {
  POD_PACKAGE_SOURCES,
  POD_DOCUMENT_SHAPE,
  POD_BLOCK_SHAPE,
  isPodPackageSource,
  extractPdfPageTexts,
  textLooksUnsafeForCustomer,
  resolvePodPage,
  resolvePodPageIndex,
  normalizePodDocEntry,
  normalizeDocumentEntries,
  enrichPodDocumentsWithTrailingPages,
  normalizePodData,
  normalizePodFromClassification,
  coercePodDocuments,
  resolvePodDocuments,
  extractPodDocumentPdfBytes,
  parseClassificationJson,
  parseClassificationResponse,
  buildPodClassifierRules,
};
