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
  discrepancies: {
    found: false,
    damageNoted: false,
    missingCartons: false,
    details: "",
  },
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
    discrepancies: normalizePodDiscrepancies(pod.discrepancies),
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

const POD_DAMAGE_PATTERNS = [
  /\bdamag(?:e|ed|es)\b/i,
  /\bdent(?:ed|s)?\b/i,
  /\bbroken\b/i,
  /\bcrush(?:ed|es)?\b/i,
  /\btorn\b/i,
  /\bfreight\s+damage\b/i,
  /\bcargo\s+damage\b/i,
  /\brefused\s+due\s+to\s+damage\b/i,
];

const POD_SHORTAGE_PATTERNS = [
  /\bmissing\s+cartons?\b/i,
  /\bmissing\s+pieces?\b/i,
  /\bmissing\s+pallets?\b/i,
  /\bshortage\b/i,
  /\bshortages\b/i,
  /\bshort\s+shipped\b/i,
  /\bshort\s+ship\b/i,
  /\bpieces?\s+short\b/i,
  /\bcartons?\s+short\b/i,
  /\bpartial\s+delivery\b/i,
  /\bos\s*&\s*d\b/i,
  /\bover\s*[/.-]?\s*short\b/i,
  /\bquantity\s+short\b/i,
  /\bqty\s+short\b/i,
];

/**
 * Normalizes POD discrepancy flags from AI or text scan.
 * @param {object|null} raw Raw discrepancy object.
 * @return {object}
 */
function normalizePodDiscrepancies(raw) {
  const d = raw && typeof raw === "object" ? raw : {};
  const damageNoted = d.damageNoted === true;
  const missingCartons = d.missingCartons === true;
  const details = String(d.details || d.otherNotes || d.summary || "")
      .trim();
  const found = d.found === true || damageNoted || missingCartons ||
    Boolean(details);
  return {found, damageNoted, missingCartons, details};
}

/**
 * Scans POD text for damage / shortage language.
 * @param {string} text Combined POD page text.
 * @return {object} Normalized discrepancy object.
 */
function detectPodDiscrepanciesInText(text) {
  const blob = String(text || "").trim();
  if (!blob) return normalizePodDiscrepancies(null);
  const damageNoted = POD_DAMAGE_PATTERNS.some((p) => p.test(blob));
  const missingCartons = POD_SHORTAGE_PATTERNS.some((p) => p.test(blob));
  const found = damageNoted || missingCartons;
  let details = "";
  if (found) {
    const lines = blob.split(/\r?\n/);
    const hit = lines.find((line) => {
      const sample = String(line || "");
      return POD_DAMAGE_PATTERNS.some((p) => p.test(sample)) ||
        POD_SHORTAGE_PATTERNS.some((p) => p.test(sample));
    });
    details = (hit || blob).trim().slice(0, 300);
  }
  return {found, damageNoted, missingCartons, details};
}

/**
 * Reads a POD PDF buffer and scans for discrepancy language.
 * @param {Buffer|Uint8Array} buffer POD PDF bytes.
 * @return {Promise<object>}
 */
async function scanPodBufferForDiscrepancies(buffer) {
  if (!buffer || !buffer.length) {
    return normalizePodDiscrepancies(null);
  }
  const pageTexts = await extractPdfPageTexts(buffer);
  if (!pageTexts || !pageTexts.length) {
    return normalizePodDiscrepancies(null);
  }
  return detectPodDiscrepanciesInText(pageTexts.join("\n"));
}

/**
 * Merges two discrepancy objects (AI + text scan).
 * @param {object|null} a First discrepancies.
 * @param {object|null} b Second discrepancies.
 * @return {object}
 */
function mergePodDiscrepancies(a, b) {
  const left = normalizePodDiscrepancies(a);
  const right = normalizePodDiscrepancies(b);
  if (!left.found && !right.found) return normalizePodDiscrepancies(null);
  const details = [left.details, right.details]
      .filter(Boolean)
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .join(" | ");
  return {
    found: true,
    damageNoted: left.damageNoted || right.damageNoted,
    missingCartons: left.missingCartons || right.missingCartons,
    details: details.slice(0, 500),
  };
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
 * Extracts balanced {...} objects from text that look like invoice items.
 * Used when Claude truncates mid-JSON so we can still recover complete loads.
 * @param {string} text Raw model text.
 * @return {Array<object>}
 */
function salvageInvoiceObjects(text) {
  const out = [];
  const src = String(text || "");
  let i = 0;
  while (i < src.length) {
    if (src[i] !== "{") {
      i += 1;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      if (inStr) {
        if (esc) {
          esc = false;
        } else if (c === "\\") {
          esc = true;
        } else if (c === "\"") {
          inStr = false;
        }
        continue;
      }
      if (c === "\"") {
        inStr = true;
        continue;
      }
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) {
      // Outer/truncated object never closed — skip this "{" and keep
      // searching for complete nested invoice objects.
      i += 1;
      continue;
    }
    const chunk = src.slice(i, end + 1);
    try {
      const obj = JSON.parse(chunk);
      if (obj && typeof obj === "object" && !Array.isArray(obj) &&
          (obj.loadNumber != null || obj.invoiceAmount != null ||
            obj.status != null || obj.invoiceNumber != null)) {
        out.push(obj);
      }
    } catch (_) {
      // ignore non-invoice objects (e.g. nested pods) that parse fail
    }
    i = end + 1;
  }
  return out;
}

/**
 * @param {string} rawText Claude text response.
 * @return {object} Parsed JSON.
 */
function parseClassificationJson(rawText) {
  let text = String(rawText || "").trim();
  // Strip markdown fences even when the closing fence was truncated.
  text = text.replace(/^```(?:json)?\s*/i, "");
  text = text.replace(/\s*```\s*$/i, "").trim();

  try {
    return JSON.parse(text);
  } catch (firstErr) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (_) {
        // fall through to salvage
      }
    }
    const salvaged = salvageInvoiceObjects(text);
    if (salvaged.length > 0) {
      return {invoices: salvaged};
    }
    throw firstErr;
  }
}

/**
 * Normalizes classifier output to an invoices[] array.
 * Legacy single-invoice objects become a one-element array.
 * @param {object} parsed Raw classifier JSON.
 * @return {Array<object>}
 */
function normalizeClassificationToInvoices(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  if (Array.isArray(parsed.invoices) && parsed.invoices.length > 0) {
    return parsed.invoices.filter((item) => item && typeof item === "object");
  }
  if (parsed.loadNumber != null || parsed.invoiceAmount != null ||
      parsed.status != null) {
    return [parsed];
  }
  return [];
}

/**
 * Digits-only load / PRO key for grouping related invoices.
 * @param {string|number|null|undefined} value Raw value.
 * @return {string}
 */
function normalizeInvoiceGroupKey(value) {
  return String(value || "").replace(/[\s-]/g, "").trim();
}

/**
 * Scores how "revised/corrected" an invoice item looks from PDF text.
 * Central Transport (and similar) stamp ORIGINAL vs CORRECTED/REVISED.
 * @param {object} item Classifier invoice item.
 * @param {Array<object>} pdfAttachments PDFs with filename/buffer.
 * @return {Promise<{score: number, markers: string[]}>}
 */
async function scoreInvoiceRevisionPreference(item, pdfAttachments) {
  const markers = [];
  let score = 0;
  const filename = String(item && item.attachmentFilename || "").toLowerCase();
  if (/correct|revis|amend|adjusted|dispute/i.test(filename)) {
    score += 40;
    markers.push("filename");
  }

  const attList = Array.isArray(pdfAttachments) ? pdfAttachments : [];
  let att = attList.find((a) => a && a.filename === item.attachmentFilename);
  if (!att) {
    att = attList.find((a) => a && a.docType !== "POD") || attList[0];
  }
  if (!att || !att.buffer) {
    return {score, markers};
  }

  let pageTexts = null;
  try {
    pageTexts = await extractPdfPageTexts(att.buffer);
  } catch (_) {
    return {score, markers};
  }
  if (!pageTexts || !pageTexts.length) {
    return {score, markers};
  }

  const scoped = collectInvoiceScopedPages(item);
  const pagesToScan = scoped.length > 0 ?
    scoped.map((p) => p - 1).filter((i) => i >= 0 && i < pageTexts.length) :
    pageTexts.map((_, i) => i);
  const blob = pagesToScan.map((i) => pageTexts[i] || "").join("\n");

  const correctedRe =
    /\b(CORRECTED|REVISED|AMENDED)\s+INVOICE\b|\bCORRECTED\s+BILL\b/i;
  const originalRe = /\bORIGINAL\s+INVOICE\b/i;
  if (correctedRe.test(blob)) {
    score += 100;
    markers.push("corrected_label");
  }
  if (originalRe.test(blob)) {
    // ORIGINAL alone means prefer the sibling; ORIGINAL+CORRECTED on same
    // scoped pages still keeps the corrected boost above.
    score -= 60;
    markers.push("original_label");
  }
  return {score, markers};
}

/**
 * When the same load (or PRO) has multiple invoices in one email/PDF —
 * typically ORIGINAL plus CORRECTED/REVISED after a dispute — keep the
 * corrected/revised copy and drop the originals.
 * @param {Array<object>} invoiceItems Classifier invoice items.
 * @param {Array<object>} pdfAttachments PDFs with buffers.
 * @return {Promise<{items: Array<object>, dropped: Array<object>}>}
 */
async function preferRevisedInvoicesForSameLoad(invoiceItems, pdfAttachments) {
  const items = Array.isArray(invoiceItems) ?
    invoiceItems.filter((i) => i && typeof i === "object") : [];
  if (items.length <= 1) {
    return {items, dropped: []};
  }

  const scored = [];
  for (const item of items) {
    const revision = await scoreInvoiceRevisionPreference(
        item, pdfAttachments);
    scored.push({item, revision});
  }

  const groups = new Map();
  scored.forEach((entry, index) => {
    const loadKey = normalizeInvoiceGroupKey(entry.item.loadNumber);
    const proKey = normalizeInvoiceGroupKey(entry.item.proNumber);
    const key = loadKey ?
      `load:${loadKey}` :
      (proKey ? `pro:${proKey}` : `unique:${index}`);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  });

  const kept = [];
  const dropped = [];
  for (const [, group] of groups) {
    if (group.length === 1) {
      kept.push(group[0].item);
      continue;
    }
    const hasCorrected = group.some((g) =>
      g.revision.markers.includes("corrected_label") ||
      g.revision.score >= 40);
    if (!hasCorrected) {
      // No clear revised copy — keep all (safer than guessing).
      group.forEach((g) => kept.push(g.item));
      continue;
    }
    group.sort((a, b) => {
      if (b.revision.score !== a.revision.score) {
        return b.revision.score - a.revision.score;
      }
      // Prefer the lower total when scores tie (dispute settlement cuts).
      return Number(a.item.invoiceAmount || 0) -
        Number(b.item.invoiceAmount || 0);
    });
    kept.push(group[0].item);
    for (let i = 1; i < group.length; i++) {
      dropped.push({
        loadNumber: group[i].item.loadNumber || null,
        proNumber: group[i].item.proNumber || null,
        invoiceAmount: group[i].item.invoiceAmount || null,
        attachmentFilename: group[i].item.attachmentFilename || null,
        revisionScore: group[i].revision.score,
        keptAmount: group[0].item.invoiceAmount || null,
        keptAttachment: group[0].item.attachmentFilename || null,
        keptScore: group[0].revision.score,
        reason: "prefer_corrected_or_revised_invoice",
      });
    }
  }

  return {items: kept, dropped};
}

/**
 * Slices a PDF to the given 1-based page numbers (order preserved, unique).
 * Returns null when pages are empty/invalid or would keep the entire PDF.
 * @param {Buffer|Uint8Array} pdfBuffer Source PDF.
 * @param {Array<number|string>} pages 1-based page numbers.
 * @return {Promise<Buffer|null>}
 */
async function slicePdfByPages(pdfBuffer, pages) {
  if (!pdfBuffer || !Array.isArray(pages) || pages.length === 0) {
    return null;
  }
  const src = await PDFDocument.load(pdfBuffer, {ignoreEncryption: true});
  const pageCount = src.getPageCount();
  const indices = [...new Set(pages
      .map((p) => Math.trunc(Number(p)))
      .filter((p) => Number.isFinite(p) && p >= 1 && p <= pageCount)
      .map((p) => p - 1))];
  if (indices.length === 0) {
    return null;
  }
  if (indices.length === pageCount) {
    return null;
  }
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, indices);
  for (const page of copied) {
    out.addPage(page);
  }
  const bytes = await out.save();
  return Buffer.from(bytes);
}

/**
 * Collects unique 1-based pages for an invoice item (invoice + POD pages).
 * @param {object} item Classifier invoice item.
 * @return {number[]}
 */
function collectInvoiceScopedPages(item) {
  const pages = [];
  const push = (p) => {
    const n = Math.trunc(Number(p));
    if (Number.isFinite(n) && n >= 1) pages.push(n);
  };
  if (Array.isArray(item.invoicePages)) {
    item.invoicePages.forEach(push);
  }
  const pod = item.pod || {};
  if (pod.page) push(pod.page);
  if (Array.isArray(pod.documents)) {
    for (const doc of pod.documents) {
      if (doc && doc.page) push(doc.page);
    }
  }
  return [...new Set(pages)].sort((a, b) => a - b);
}

/**
 * Remaps pod document page numbers after slicing so page 1 is the first
 * page of the sliced PDF.
 * @param {object} item Invoice item (mutated).
 * @param {number[]} originalPages Scoped pages used for the slice.
 * @return {void}
 */
function remapPodPagesAfterSlice(item, originalPages) {
  if (!item || !Array.isArray(originalPages) || originalPages.length === 0) {
    return;
  }
  const map = new Map();
  originalPages.forEach((p, idx) => map.set(p, idx + 1));
  if (item.pod && item.pod.page != null && map.has(Number(item.pod.page))) {
    item.pod.page = map.get(Number(item.pod.page));
  }
  if (item.pod && Array.isArray(item.pod.documents)) {
    for (const doc of item.pod.documents) {
      if (doc && doc.page != null && map.has(Number(doc.page))) {
        doc.page = map.get(Number(doc.page));
      }
    }
  }
  if (Array.isArray(item.invoicePages)) {
    item.invoicePages = item.invoicePages
        .map((p) => map.get(Number(p)))
        .filter((p) => p != null);
  }
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

/**
 * Normalizes attachment filenames for fuzzy comparison (trim, lowercase,
 * collapse whitespace — Central Transport pads filenames with spaces).
 * @param {string} filename Raw filename.
 * @return {string}
 */
function normalizeAttachmentFilenameKey(filename) {
  return String(filename || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");
}

/**
 * @param {string} a First filename.
 * @param {string} b Second filename.
 * @return {boolean}
 */
function attachmentFilenamesMatch(a, b) {
  if (!a || !b) return false;
  return normalizeAttachmentFilenameKey(a) ===
    normalizeAttachmentFilenameKey(b);
}

/**
 * True when a carrier-invoice filename embeds the expected PRO (Central
 * Transport batch PDFs are named like "446757676.1.pdf").
 * @param {string} filename Attachment filename.
 * @param {string} proNumber Expected carrier PRO.
 * @return {boolean}
 */
function attachmentFilenameContainsPro(filename, proNumber) {
  const pro = String(proNumber || "").trim().toLowerCase();
  if (!pro) return true;
  const key = normalizeAttachmentFilenameKey(filename);
  if (!key) return false;
  return key.startsWith(pro + ".") || key.includes(pro);
}

/**
 * @param {Array<object>|null|undefined} attachments Attachment list.
 * @return {Array<object>}
 */
function listInvoicePdfAttachments(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  return list.filter((a) => {
    if (!a || !a.filename) return false;
    if (String(a.docType || "").toUpperCase() === "POD") return false;
    return /\.pdf$/i.test(String(a.filename)) ||
      /pdf/i.test(String(a.mimeType || ""));
  });
}

/**
 * Invoice PDF attachments not claimed by any classifier item.
 * @param {Array<object>} invoiceItems Classifier invoice items.
 * @param {Array<object>} attachments Stored attachment metadata.
 * @return {Array<object>}
 */
function listUncoveredInvoiceAttachments(invoiceItems, attachments) {
  const pdfs = listInvoicePdfAttachments(attachments);
  const claimed = new Set();
  for (const item of (Array.isArray(invoiceItems) ? invoiceItems : [])) {
    const name = item && item.attachmentFilename;
    if (!name) continue;
    claimed.add(normalizeAttachmentFilenameKey(name));
    for (const pdf of pdfs) {
      if (attachmentFilenamesMatch(pdf.filename, name)) {
        claimed.add(normalizeAttachmentFilenameKey(pdf.filename));
      }
    }
  }
  return pdfs.filter((pdf) =>
    !claimed.has(normalizeAttachmentFilenameKey(pdf.filename)));
}

/**
 * Finds the carrier-invoice PDF for a load within a batch email's
 * attachment list (match by attachmentFilename hint and/or PRO number).
 * @param {Array<object>|null|undefined} attachments Attachment list.
 * @param {object} [hints] proNumber, attachmentFilename.
 * @return {object|null}
 */
function findInvoiceAttachment(attachments, hints) {
  const skipDocType =
      /WEIGHT_INSPECTION_CERT|POD_IMAGE|TRAILER_IMAGE|^POD$/i;
  const list = (Array.isArray(attachments) ? attachments : [])
      .filter((a) => a && a.storagePath)
      .filter((a) => {
        const dt = String(a.docType || "");
        return !dt || !skipDocType.test(dt);
      });
  if (!list.length) return null;

  const opts = hints && typeof hints === "object" ? hints : {};
  const {proNumber, attachmentFilename} = opts;

  if (attachmentFilename) {
    const hit = list.find((a) =>
      attachmentFilenamesMatch(a.filename, attachmentFilename));
    if (hit) return hit;
  }

  if (proNumber) {
    const pro = String(proNumber).trim().toLowerCase();
    if (pro) {
      const hits = list.filter((a) => {
        const key = normalizeAttachmentFilenameKey(a.filename);
        return key.startsWith(pro + ".") || key.includes(pro);
      });
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        const exact = hits.find((a) => {
          const key = normalizeAttachmentFilenameKey(a.filename);
          return key.startsWith(pro + ".1") || key.startsWith(pro + ".");
        });
        return exact || hits[0];
      }
    }
  }
  return null;
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
  salvageInvoiceObjects,
  normalizeClassificationToInvoices,
  preferRevisedInvoicesForSameLoad,
  scoreInvoiceRevisionPreference,
  slicePdfByPages,
  collectInvoiceScopedPages,
  remapPodPagesAfterSlice,
  buildPodClassifierRules,
  normalizePodDiscrepancies,
  detectPodDiscrepanciesInText,
  scanPodBufferForDiscrepancies,
  mergePodDiscrepancies,
  normalizeAttachmentFilenameKey,
  attachmentFilenamesMatch,
  attachmentFilenameContainsPro,
  listInvoicePdfAttachments,
  listUncoveredInvoiceAttachments,
  findInvoiceAttachment,
};
