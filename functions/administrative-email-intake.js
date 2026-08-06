/**
 * Administrative / non-invoice emails Jerry can ignore (NOA, broadcasts).
 */
"use strict";

/**
 * @param {string} subject Email subject.
 * @param {string} from From header.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function isEmodalBroadcast(subject, from, body) {
  const hay = `${subject || ""}\n${from || ""}\n${body || ""}`.toLowerCase();
  if (hay.includes("emodal") || hay.includes("cargosprint")) return true;
  if (hay.includes("automated email") &&
      hay.includes("broadcast") &&
      hay.includes("terminal")) {
    return true;
  }
  return /today'?s emodal broadcasts/i.test(hay);
}

/**
 * Bank / Zelle payment alerts — not carrier freight invoices.
 * @param {string} subject Email subject.
 * @param {string} from From header.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function isPaymentNotificationEmail(subject, from, body) {
  const hay = `${subject || ""}\n${from || ""}\n${body || ""}`.toLowerCase();
  if (/\bzelle\b/.test(hay)) return true;
  if (/payment (?:was )?(?:sent|received|posted|completed|processed)/i
      .test(hay)) {
    return true;
  }
  if (/ach (?:payment|transfer|credit|debit)/i.test(hay)) return true;
  if (/wire transfer (?:sent|received|completed|notification)/i.test(hay)) {
    return true;
  }
  const bankDomains = [
    "bankofamerica", "chase.com", "wellsfargo", "capitalone", "usbank",
    "pnc.com", "tdbank", "citibank", "ally.com", "paypal.com",
  ];
  const fromBank = bankDomains.some((d) =>
    String(from || "").toLowerCase().includes(d));
  if (fromBank && /(?:payment|transfer|deposit|withdrawal|alert)/i.test(hay)) {
    return true;
  }
  return false;
}

/**
 * Subject/body looks like a factor carrier-invoice notification.
 * @param {string} subject Email subject.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function looksLikeInvoiceEmailContent(subject, body) {
  const content = `${subject || ""}\n${body || ""}`.toLowerCase();
  if (/^invoice\s+#?\d+/.test(String(subject || "").trim().toLowerCase())) {
    return true;
  }
  if (/\binvoice\s+#?\d+[\s-]+load\s+\d{5,9}/i.test(content)) {
    return true;
  }
  if (/\bfreight invoice\b/.test(content) &&
      /\bload\s+#?\d{5,9}/i.test(content)) {
    return true;
  }
  return false;
}

/**
 * Subject/body mentions Notice of Assignment (not sufficient alone to ignore).
 * @param {string} subject Email subject.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function looksLikeNoaEmailContent(subject, body) {
  const content = `${subject || ""}\n${body || ""}`.toLowerCase();
  if (!content.trim()) return false;
  if (looksLikeInvoiceEmailContent(subject, body)) return false;
  if (/\bnoa\b/.test(content) || content.includes("notice of assignment")) {
    return true;
  }
  if (/notice of assignment for .+ please confirm receipt/i.test(content)) {
    return true;
  }
  if (/please confirm receipt/.test(content) &&
      /assignment|remit to|payments should be directed/i.test(content)) {
    return true;
  }
  return false;
}

/**
 * @param {string} subject Email subject.
 * @param {string} _from From header (unused).
 * @param {string} body Plain body.
 * @return {boolean}
 */
function isNoticeOfAssignmentEmail(subject, _from, body) {
  return looksLikeNoaEmailContent(subject, body);
}

/**
 * RTS alias — kept for callers/tests.
 * @param {string} subject Email subject.
 * @param {string} from From header.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function isRtsNoaEmail(subject, from, body) {
  return looksLikeNoaEmailContent(subject, body);
}

/**
 * @param {string} filename Attachment filename.
 * @return {boolean}
 */
function attachmentFilenameLooksLikeInvoice(filename) {
  const name = String(filename || "").toLowerCase();
  if (!name) return false;
  if (/noa|notice.?of.?assignment/.test(name)) return false;
  return /invoice|inv[\s#._-]|freight[\s._-]?bill/.test(name) ||
    /carrier[\s._-]?bill|bill[\s._-]?of[\s._-]?lading/.test(name);
}

/**
 * @param {string} filename Attachment filename.
 * @return {boolean}
 */
function attachmentFilenameLooksLikeNoa(filename) {
  const name = String(filename || "").toLowerCase();
  if (!name) return false;
  return /noa|notice.?of.?assignment|assignment|remit.?to/.test(name);
}

/**
 * @param {object} attachment Gmail attachment metadata.
 * @return {boolean}
 */
function isPdfLikeAttachment(attachment) {
  const mime = String(attachment && attachment.mimeType || "").toLowerCase();
  const name = String(attachment && attachment.filename || "").toLowerCase();
  return mime.includes("pdf") || name.endsWith(".pdf");
}

/**
 * True when attachments (by filename) look like NOA only — no invoice file.
 * @param {Array<object>} attachments Attachment metadata list.
 * @return {boolean}
 */
function rtsNoaAttachmentsLookNoaOnly(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length) return true;
  if (list.some((a) => attachmentFilenameLooksLikeInvoice(a.filename))) {
    return false;
  }
  const pdfLike = list.filter(isPdfLikeAttachment);
  if (!pdfLike.length) return true;
  return pdfLike.every((a) =>
    attachmentFilenameLooksLikeNoa(a.filename));
}

/**
 * Ignore only when the package has no invoice (attachments + scan) and is
 * NOA-only. Same sender/subject can carry both NOA and invoice — an invoice
 * attachment or classified invoice PDF always wins.
 * @param {string} subject Email subject.
 * @param {string} body Plain body.
 * @param {Array<object>} attachments Attachment metadata.
 * @param {number} [invoicePdfCount] Invoice PDFs after doc classification.
 * @return {boolean}
 */
function shouldIgnoreNoaOnlyPackage(
    subject, body, attachments, invoicePdfCount) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (Number(invoicePdfCount) > 0) return false;
  if (looksLikeInvoiceEmailContent(subject, body)) return false;
  if (list.some((a) => attachmentFilenameLooksLikeInvoice(a.filename))) {
    return false;
  }
  if (rtsNoaAttachmentsLookNoaOnly(list)) return true;
  if (looksLikeNoaEmailContent(subject, body) && list.length === 0) {
    return true;
  }
  if (looksLikeNoaEmailContent(subject, body) &&
      Number(invoicePdfCount) === 0 &&
      list.length > 0) {
    return true;
  }
  return false;
}

/**
 * @param {string} subject Subject.
 * @param {string} from From.
 * @param {string} body Body.
 * @param {Array<object>} attachments Attachments.
 * @return {object} ignore flag with reason and status fields.
 */
function evaluateAdministrativeIgnore(subject, from, body, attachments) {
  if (isEmodalBroadcast(subject, from, body)) {
    return {
      ignore: true,
      reason: "eModal / terminal broadcast — no action needed",
      status: "emodal_broadcast_ignored",
    };
  }
  // Before PDF classification: only ignore when filenames clearly NOA-only.
  if (rtsNoaAttachmentsLookNoaOnly(attachments) &&
      looksLikeNoaEmailContent(subject, body) &&
      !looksLikeInvoiceEmailContent(subject, body)) {
    return {
      ignore: true,
      reason: "Notice of Assignment only — no carrier invoice",
      status: "noa_ignored",
    };
  }
  return {ignore: false, reason: null, status: null};
}

module.exports = {
  isEmodalBroadcast,
  isPaymentNotificationEmail,
  looksLikeInvoiceEmailContent,
  looksLikeNoaEmailContent,
  isNoticeOfAssignmentEmail,
  isRtsNoaEmail,
  attachmentFilenameLooksLikeInvoice,
  attachmentFilenameLooksLikeNoa,
  rtsNoaAttachmentsLookNoaOnly,
  shouldIgnoreNoaOnlyPackage,
  evaluateAdministrativeIgnore,
};
