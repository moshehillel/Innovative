/**
 * Detects carrier "statement" PDFs that are actually invoice packets:
 * first page is an account summary; later pages are freight bills to pay.
 * JTS Express emails this as "Statement <number>" from invoice@jtsexpress.com.
 */
"use strict";

/**
 * Normalizes a first-page pre-check label (strip punctuation / whitespace).
 * @param {string} docType Raw label.
 * @return {string}
 */
function sanitizePreCheckLabel(docType) {
  return String(docType || "").trim().toUpperCase().replace(/[^A-Z]/g, "");
}

/**
 * True for subjects like "Statement 22568" or "FW: Stmt #22432".
 * @param {string} subject Email subject.
 * @return {boolean}
 */
function looksLikeNumberedStatementSubject(subject) {
  const sub = String(subject || "").trim();
  return /^(?:(?:fw|fwd|re):\s*)*(?:stmt|stmd|statement)\s*#?\s*\d+\b/i
      .test(sub);
}

/**
 * Body text that a numbered statement PDF contains freight invoices.
 * @param {string} body Email plain-text body.
 * @return {boolean}
 */
function looksLikeStatementInvoicePacketBody(body) {
  const text = String(body || "");
  return /attached is your invoices|your invoices for statement/i
      .test(text);
}

/**
 * Carrier AP mailbox that commonly sends invoice packets.
 * @param {string} from Email sender.
 * @return {boolean}
 */
function looksLikeCarrierInvoiceMailbox(from) {
  return /(?:^|[<\s])(?:invoice|invoices|invoicing|billing|acctg)@/i
      .test(String(from || ""));
}

/**
 * Compass FS factored freight invoices: subject like
 * "Purchase order number; Purchase Order #266265" from notify@mg.compassfs.net.
 * The PO number is the broker load; the PDF is a carrier freight bill to pay.
 * @param {string} subject Email subject.
 * @param {string} from Email sender.
 * @return {boolean}
 */
function looksLikeCompassFsPurchaseOrderInvoiceEmail(subject, from) {
  const fromL = String(from || "").toLowerCase();
  if (!/compassfs\.(?:net|info)/i.test(fromL)) return false;
  return /purchase\s+order\s*#\s*\d{5,9}/i.test(String(subject || ""));
}

/**
 * Factored freight invoice subject: Invoice # plus PO / Purchase Order #.
 * @param {string} subject Email subject.
 * @return {boolean}
 */
function looksLikeFactoredPurchaseOrderInvoiceEmail(subject) {
  const sub = String(subject || "");
  if (!/invoice\s+#?\s*\d+/i.test(sub)) return false;
  return /(?:your\s+)?(?:po|purchase\s+order)\s*#?\s*\d{5,9}/i.test(sub);
}

/**
 * FactorView / BP Financing (and similar) factored freight invoices:
 * subject like "Invoice # 981 Your PO # 265543" from notification@factorview.com.
 * The PO number is the broker load; the PDF is a carrier freight bill to pay.
 * @param {string} subject Email subject.
 * @param {string} from Email sender.
 * @return {boolean}
 */
function looksLikeFactorViewPurchaseOrderInvoiceEmail(subject, from) {
  const fromL = String(from || "").toLowerCase();
  if (!fromL.includes("factorview.com")) return false;
  return looksLikeFactoredPurchaseOrderInvoiceEmail(subject);
}

/**
 * Thunder Funding factored freight invoices:
 * "Invoice for processing; Invoice #299 - Purchase Order #266504".
 * @param {string} subject Email subject.
 * @param {string} from Email sender.
 * @return {boolean}
 */
function looksLikeThunderFundingInvoiceEmail(subject, from) {
  const fromL = String(from || "").toLowerCase();
  if (!fromL.includes("thunderfunding.com")) return false;
  const sub = String(subject || "");
  if (/invoice\s+for\s+processing/i.test(sub) &&
      /\binvoice\s+#?\s*\d+/i.test(sub)) {
    return true;
  }
  return looksLikeFactoredPurchaseOrderInvoiceEmail(sub);
}

/**
 * Single Point Capital factored freight invoices:
 * "Single Point Capital; Invoice #265914" from reports@singlepointgroup.com.
 * @param {string} subject Email subject.
 * @param {string} from Email sender.
 * @return {boolean}
 */
function looksLikeSinglePointCapitalInvoiceEmail(subject, from) {
  const fromL = String(from || "").toLowerCase();
  if (!fromL.includes("singlepointgroup.com")) return false;
  return /\binvoice\s+#?\s*\d+/i.test(String(subject || ""));
}

/**
 * RM Capital factored freight invoices:
 * subject "REF# 266111" from invoice@rmcapitalinc.com.
 * The REF # is the broker load; the PDF is a carrier freight bill to pay.
 * @param {string} subject Email subject.
 * @param {string} from Email sender.
 * @return {boolean}
 */
function looksLikeRmCapitalInvoiceEmail(subject, from) {
  const fromL = String(from || "").toLowerCase();
  if (!fromL.includes("rmcapitalinc.com")) return false;
  return looksLikeRefNumberInvoiceSubject(subject);
}

/**
 * Factored carrier invoice subjects that cite the broker load as REF#.
 * @param {string} subject Email subject.
 * @return {boolean}
 */
function looksLikeRefNumberInvoiceSubject(subject) {
  const sub = String(subject || "").trim();
  return /^ref\s*#\s*\d{5,9}\b/i.test(sub);
}

/**
 * True when attachment metadata includes a PDF (not a nested .eml).
 * @param {Array<object>|null|undefined} attachments Gmail attachment meta.
 * @return {boolean}
 */
function hasProcessablePdfAttachment(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  return list.some((att) => {
    const name = String(att && att.filename || "").toLowerCase();
    const mime = String(att && att.mimeType || "").toLowerCase();
    if (name.endsWith(".eml") || mime.includes("message/rfc822")) {
      return false;
    }
    return mime.includes("pdf") || name.endsWith(".pdf");
  });
}

/**
 * True when the email subject/sender/body looks like a carrier invoice
 * packet (possibly with a statement summary cover page before the bills).
 * @param {string} subject Email subject.
 * @param {string} from Email sender.
 * @param {string} [body] Email plain-text body.
 * @return {boolean}
 */
function looksLikeCarrierInvoiceEmail(subject, from, body) {
  const sub = String(subject || "").trim();
  const hints = `${subject || ""} ${from || ""}`.toLowerCase();
  if (looksLikeCompassFsPurchaseOrderInvoiceEmail(sub, from)) return true;
  if (looksLikeFactorViewPurchaseOrderInvoiceEmail(sub, from)) return true;
  if (looksLikeThunderFundingInvoiceEmail(sub, from)) return true;
  if (looksLikeSinglePointCapitalInvoiceEmail(sub, from)) return true;
  if (looksLikeRmCapitalInvoiceEmail(sub, from)) return true;
  if (looksLikeRefNumberInvoiceSubject(sub)) return true;
  if (looksLikeFactoredPurchaseOrderInvoiceEmail(sub)) return true;
  // Factor-name prefix: "Single Point Capital; Invoice #265914"
  if (/;\s*invoice\s+#?\s*\d+/i.test(sub)) return true;
  if (looksLikeNumberedStatementSubject(sub)) return true;
  if (/^invoice\s+\d+\s+from\b/i.test(sub)) return true;
  // Allow optional whitespace after "#": "Invoice # 981 …"
  if (/^(?:(?:fw|fwd|re):\s*)?invoice\s+#?\s*\d+/i.test(sub)) return true;
  if (looksLikeStatementInvoicePacketBody(body)) return true;
  const invoicePacket = new RegExp(
      "invoice from|your invoice|is attached|acct no|account no|" +
      "carrier invoice|ltl invoice", "i");
  const carrierName = new RegExp(
      "freight line|motor freight|freight system|freightways", "i");
  return invoicePacket.test(hints) || carrierName.test(hints);
}

/**
 * JTS-style (and similar) cover-page statement + freight bills packet.
 * Does not match a specific statement number — any "Statement <n>".
 * @param {string} subject Email subject.
 * @param {string} from Email sender.
 * @param {string} [body] Email plain-text body.
 * @param {Array<object>} [attachments] Attachment metadata when known.
 * @return {boolean}
 */
function looksLikeStatementCoverInvoicePacketEmail(
    subject, from, body, attachments) {
  // Strong subject/body signals first — JTS "Statement 22568" must not
  // depend on Gmail exposing a top-level PDF (often only a nested .eml).
  if (looksLikeCompassFsPurchaseOrderInvoiceEmail(subject, from)) {
    return true;
  }
  if (looksLikeFactorViewPurchaseOrderInvoiceEmail(subject, from)) {
    return true;
  }
  if (looksLikeThunderFundingInvoiceEmail(subject, from)) {
    return true;
  }
  if (looksLikeSinglePointCapitalInvoiceEmail(subject, from)) {
    return true;
  }
  if (looksLikeRmCapitalInvoiceEmail(subject, from)) {
    return true;
  }
  if (looksLikeRefNumberInvoiceSubject(subject)) {
    return true;
  }
  if (looksLikeFactoredPurchaseOrderInvoiceEmail(subject)) {
    return true;
  }
  if (/;\s*invoice\s+#?\s*\d+/i.test(String(subject || ""))) {
    return true;
  }
  if (looksLikeNumberedStatementSubject(subject)) return true;
  if (looksLikeStatementInvoicePacketBody(body) &&
      /\b(?:stmt|stmd|statement)\b/i.test(
          `${subject || ""} ${body || ""}`)) {
    return true;
  }
  if (attachments != null &&
      !hasProcessablePdfAttachment(attachments)) {
    return false;
  }
  if (looksLikeCarrierInvoiceMailbox(from) &&
      /\b(?:stmt|stmd|statement)\b/i.test(String(subject || ""))) {
    return true;
  }
  return false;
}

/**
 * True when a first-page STATEMENT label should still run invoice extraction
 * (Saia / JTS multi-page packet with freight bills after the summary page).
 * @param {object} context Subject/filename hints and optional preCheckLabel.
 * @return {boolean}
 */
function shouldTreatStatementCoverAsInvoiceBundle(context = {}) {
  const label = sanitizePreCheckLabel(
      context.preCheckLabel || context.docType);
  if (label !== "STATEMENT" && label !== "OTHER") return false;

  if (looksLikeCompassFsPurchaseOrderInvoiceEmail(
      context.subject, context.from)) {
    return true;
  }
  if (looksLikeFactorViewPurchaseOrderInvoiceEmail(
      context.subject, context.from)) {
    return true;
  }
  if (looksLikeThunderFundingInvoiceEmail(
      context.subject, context.from)) {
    return true;
  }
  if (looksLikeSinglePointCapitalInvoiceEmail(
      context.subject, context.from)) {
    return true;
  }
  if (looksLikeRmCapitalInvoiceEmail(
      context.subject, context.from)) {
    return true;
  }
  if (looksLikeRefNumberInvoiceSubject(context.subject)) {
    return true;
  }
  if (looksLikeFactoredPurchaseOrderInvoiceEmail(context.subject)) {
    return true;
  }
  if (/;\s*invoice\s+#?\s*\d+/i.test(String(context.subject || ""))) {
    return true;
  }

  // JTS Express numbered statements: page 1 is a cover; later pages are bills.
  // Do not require pageCount — it may be 0 when PDF metadata fails to load.
  if (looksLikeNumberedStatementSubject(context.subject)) {
    return true;
  }

  const pageCount = Number(context.pageCount) || 0;
  const hints = [
    context.subject,
    context.filename,
    context.from,
    context.body,
  ].map((s) => String(s || "")).join(" ");

  if (pageCount > 1 && looksLikeStatementCoverInvoicePacketEmail(
      context.subject, context.from, context.body)) {
    return true;
  }

  if (pageCount > 1 &&
      looksLikeCarrierInvoiceEmail(
          context.subject, context.from, context.body)) {
    return true;
  }

  if (/freight\s*inv|carrier\s*inv|transportation\s*inv/i.test(hints) &&
      /stmt|stmd|statement/i.test(hints)) {
    return true;
  }

  return false;
}

/**
 * Maps cheap first-page pre-check labels to attachment processing types.
 * Standalone carrier statements are ignored; multi-page packets that
 * bundle freight bills still run full invoice extraction.
 * @param {string} docType Pre-check label.
 * @param {object} [context] Optional subject/filename/body hints.
 * @param {number} [context.pageCount] PDF page count when known.
 * @return {string} Attachment docType for intake.
 */
function normalizePreCheckDocType(docType, context = {}) {
  const label = sanitizePreCheckLabel(docType);
  if (label === "INVOICE" || label === "POD") return label;

  if (shouldTreatStatementCoverAsInvoiceBundle({
    preCheckLabel: label,
    ...context,
  })) {
    return "INVOICE";
  }

  const hints = [
    context.subject,
    context.filename,
    context.from,
    context.body,
  ].map((s) => String(s || "")).join(" ");
  if (label === "OTHER") {
    if (/freight\s*inv|carrier\s*inv|transportation/i.test(hints)) {
      return "INVOICE";
    }
    if (looksLikeCarrierInvoiceEmail(
        context.subject, context.from, context.body)) {
      return "INVOICE";
    }
  }
  return label || "OTHER";
}

/**
 * Do not short-circuit intake as statement-only when the email is a
 * numbered statement packet that still has freight bills to extract.
 * @param {object} classification Incoming email classifier result.
 * @param {string} subject Email subject.
 * @param {string} from Email sender.
 * @param {string} [body] Email body.
 * @param {Array<object>} [attachments] Attachment metadata.
 * @return {boolean}
 */
function shouldShortCircuitAsStatementOnly(
    classification, subject, from, body, attachments) {
  if (!classification || classification.intent !== "statement") {
    return false;
  }
  if (classification.confidence === "low") return false;
  if (looksLikeStatementCoverInvoicePacketEmail(
      subject, from, body, attachments)) {
    return false;
  }
  return true;
}

/**
 * Forces carrier_invoice when the classifier labels a JTS-style packet
 * as statement. Does not pin to one statement number.
 * @param {object} classification Classifier result.
 * @param {string} subject Email subject.
 * @param {string} from Email sender.
 * @param {string} [body] Email body.
 * @param {Array<object>} [attachments] Attachment metadata.
 * @return {object} Possibly rewritten classification.
 */
function overrideStatementClassificationIfInvoicePacket(
    classification, subject, from, body, attachments) {
  const current = classification && typeof classification === "object" ?
    classification : {intent: "unknown"};
  const isInvoicePacket = looksLikeStatementCoverInvoicePacketEmail(
      subject, from, body, attachments);
  if (!isInvoicePacket) return current;
  if (current.intent === "carrier_invoice") return current;
  if (current.intent !== "statement" && current.intent !== "unknown") {
    return current;
  }
  const compass = looksLikeCompassFsPurchaseOrderInvoiceEmail(subject, from);
  const factorView =
    looksLikeFactorViewPurchaseOrderInvoiceEmail(subject, from);
  const rmCapital = looksLikeRmCapitalInvoiceEmail(subject, from);
  let reasoning =
    "Numbered carrier statement packet — first page is a " +
    "statement cover; later pages are freight invoices to process.";
  if (compass) {
    reasoning =
      "Compass FS factored freight invoice — Purchase Order # is the load.";
  } else if (factorView) {
    reasoning =
      "FactorView factored freight invoice — Your PO # is the load.";
  } else if (rmCapital) {
    reasoning =
      "RM Capital factored freight invoice — REF # is the broker load.";
  } else if (looksLikeRefNumberInvoiceSubject(subject)) {
    reasoning =
      "Factored carrier freight invoice — REF # in subject is the load.";
  }
  return {
    ...current,
    intent: "carrier_invoice",
    confidence: current.confidence === "low" ? "medium" : current.confidence,
    reasoning,
  };
}

/**
 * Broker load numbers listed on a numbered statement index/cover page.
 * JTS Express page 1 lists 6-digit Primus loads (265xxx–266xxx).
 * @param {string} text Extracted text from page 1.
 * @return {string[]} Sorted unique load numbers.
 */
function parseStatementIndexLoadNumbers(text) {
  const matches = String(text || "").match(/\b(26[0-9]{4})\b/g) || [];
  const seen = new Set();
  const loads = [];
  for (const m of matches) {
    if (!seen.has(m)) {
      seen.add(m);
      loads.push(m);
    }
  }
  return loads.sort();
}

/**
 * Expected invoice count for a numbered statement packet.
 * Prefers index-page load list; falls back to page-count heuristic.
 * @param {object} context indexLoadNumbers, pageCount.
 * @return {number}
 */
function estimateStatementInvoiceCount(context = {}) {
  const indexLoads = Array.isArray(context.indexLoadNumbers) ?
    context.indexLoadNumbers : [];
  if (indexLoads.length > 0) return indexLoads.length;

  const pageCount = Number(context.pageCount) || 0;
  if (pageCount > 1) {
    // Page 1 is the statement index; remaining pages are ~2 per load.
    return Math.max(1, Math.floor((pageCount - 1) / 2));
  }
  return 0;
}

/**
 * Compares statement index expectations vs AI-extracted load numbers.
 * @param {object} context indexLoadNumbers, extractedLoadNumbers, pageCount.
 * @return {object} Gap analysis with missingLoads when under-extracted.
 */
function analyzeStatementExtractionGap(context = {}) {
  const indexLoads = Array.isArray(context.indexLoadNumbers) ?
    context.indexLoadNumbers.slice() : [];
  const extractedLoads = (Array.isArray(context.extractedLoadNumbers) ?
    context.extractedLoadNumbers : [])
      .map((l) => String(l || "").trim())
      .filter(Boolean);
  const extractedSet = new Set(extractedLoads);
  const missingLoads = indexLoads.filter((l) => !extractedSet.has(l));
  const expectedCount = estimateStatementInvoiceCount(context);
  const extractedCount = extractedLoads.length;
  const underExtracted = indexLoads.length > 0 ?
    missingLoads.length > 0 :
    (expectedCount > 0 && extractedCount < expectedCount);
  return {
    underExtracted,
    expectedCount,
    extractedCount,
    indexLoads,
    missingLoads,
    pageCount: Number(context.pageCount) || 0,
  };
}

/**
 * True when ops should be alerted about missing statement invoices.
 * @param {object|null|undefined} gap analyzeStatementExtractionGap result.
 * @return {boolean}
 */
function shouldAlertStatementUnderExtraction(gap) {
  return !!(gap && gap.underExtracted);
}

/**
 * One-line suffix for intake summaries when a statement PDF is under-extracted.
 * @param {object|null|undefined} gap analyzeStatementExtractionGap result.
 * @return {string}
 */
function buildStatementGapSummarySuffix(gap) {
  if (!gap || !gap.underExtracted) return "";
  const missing = Array.isArray(gap.missingLoads) ? gap.missingLoads : [];
  if (missing.length > 0) {
    const list = missing.slice(0, 8).join(", ");
    const extra = missing.length > 8 ?
      ` (+${missing.length - 8} more)` : "";
    return `${missing.length} load(s) not extracted: ${list}${extra}`;
  }
  if (Number(gap.expectedCount) > Number(gap.extractedCount)) {
    return `expected ~${gap.expectedCount} invoice(s), ` +
      `extracted ${gap.extractedCount}`;
  }
  return "statement PDF may be under-extracted";
}

module.exports = {
  sanitizePreCheckLabel,
  looksLikeNumberedStatementSubject,
  looksLikeStatementInvoicePacketBody,
  looksLikeCarrierInvoiceMailbox,
  looksLikeCompassFsPurchaseOrderInvoiceEmail,
  looksLikeFactoredPurchaseOrderInvoiceEmail,
  looksLikeFactorViewPurchaseOrderInvoiceEmail,
  looksLikeThunderFundingInvoiceEmail,
  looksLikeSinglePointCapitalInvoiceEmail,
  looksLikeRmCapitalInvoiceEmail,
  looksLikeRefNumberInvoiceSubject,
  hasProcessablePdfAttachment,
  looksLikeCarrierInvoiceEmail,
  looksLikeStatementCoverInvoicePacketEmail,
  shouldTreatStatementCoverAsInvoiceBundle,
  normalizePreCheckDocType,
  shouldShortCircuitAsStatementOnly,
  overrideStatementClassificationIfInvoicePacket,
  parseStatementIndexLoadNumbers,
  estimateStatementInvoiceCount,
  analyzeStatementExtractionGap,
  shouldAlertStatementUnderExtraction,
  buildStatementGapSummarySuffix,
};
