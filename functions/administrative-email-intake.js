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
 * Cardknox daily batch settlement reports — informational only (Lisa: ignore).
 * Example: From noreply@cardknox.com, Subject "Innovative Carriers Batch 52094836".
 * @param {string} subject Email subject.
 * @param {string} from From header.
 * @return {boolean}
 */
function isCardknoxBatchReport(subject, from) {
  const fromL = String(from || "").toLowerCase();
  if (!fromL.includes("cardknox.com")) return false;
  const sub = String(subject || "");
  // "Innovative Carriers Batch 52094836" or any Cardknox "… Batch …" notice.
  if (/\bbatch\b/i.test(sub)) return true;
  return false;
}

/**
 * True when the From header is Hafstaff (ops: always forward to Lisa).
 * Matches display name or domain; tolerates Halfstaff / spacing variants.
 * @param {string} from From header.
 * @return {boolean}
 */
function isHafstaffSender(from) {
  const raw = String(from || "").toLowerCase();
  if (!raw.trim()) return false;
  // User spelling: Hafstaff. Also Halfstaff and spaced forms.
  if (/haf\s*-?staff|half\s*-?staff/.test(raw)) return true;
  const emailMatch = raw.match(/<([^>]+)>/) || raw.match(/([\w.+-]+@[\w.-]+)/);
  const addr = String(emailMatch && emailMatch[1] || raw).toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at < 0) return false;
  const domain = addr.slice(at + 1).replace(/[^a-z0-9]/g, "");
  return domain.includes("hafstaff") || domain.includes("halfstaff");
}

/** Default accounting contact for carrier payment questions. */
const PAYMENT_INQUIRY_EMAIL_DEFAULT = "abe@innovativecarriers.com";

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
  // Require alert verbs — carrier invoice boilerplate often offers ACH
  // remittance options ("utilize ACH payments") without being a bank alert.
  const achNoun = "(?:payment|transfer|credit|debit|deposit)";
  const achVerb =
    "(?:sent|received|posted|completed|processed|confirmed|" +
    "notification|alert)";
  const achAlert = new RegExp(
      `ach ${achNoun}.{0,40}${achVerb}`, "i");
  const achAlertReverse = new RegExp(
      `${achVerb}.{0,40}ach ${achNoun}`, "i");
  if (achAlert.test(hay) || achAlertReverse.test(hay)) {
    return true;
  }
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
 * Carrier / factor follow-ups about payment timing, Quick Pay, or remittance
 * — not a freight invoice to enter.
 * @param {string} subject Email subject.
 * @param {string} from From header.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function isPaymentInquiryEmail(subject, from, body) {
  if (isPaymentNotificationEmail(subject, from, body)) return false;
  const sub = String(subject || "").trim();
  const hay = `${sub}\n${from || ""}\n${body || ""}`.toLowerCase();
  if (!hay.trim()) return false;

  const patterns = [
    /\bquick\s*pay\b/,
    /\bquickpay\b/,
    /\bpayment\s+inquir(y|ies)\b/,
    /\bpayment\s+request\b/,
    /\bpayment\s+status\b/,
    /\bstatus\s+of\s+(?:my\s+)?payment\b/,
    /\bwhen\s+(?:will|can)\s+(?:we|i|our)\s+(?:get\s+)?paid\b/,
    /\bwhen\s+will\s+.*\s+be\s+paid\b/,
    /\bconfirm(?:ation)?\s+(?:that\s+)?(?:all\s+)?required\s+documents\b/,
    /\bdocuments\s+have\s+been\s+received\b/,
    /\bprocess(?:ing)?\s+(?:at\s+)?(?:the\s+)?\d+\s*%\b/,
    /\bsame[- ]day\s+(?:pay|payment)\b/,
    /\bfollow(?:ing)?\s+up\s+on\s+.*(?:quick\s*pay|payment)\b/,
    /\brequesting\s+(?:confirmation|processing)\s+.*\bpayment\b/,
    /\bremittance\s+(?:status|inquiry|request)\b/,
    /\bhas\s+(?:this|the)\s+invoice\s+been\s+paid\b/,
    /\bcheck\s+(?:on|regarding)\s+(?:my\s+)?payment\b/,
  ];
  if (patterns.some((re) => re.test(hay))) return true;
  if (/quick\s*pay\s+invoice/i.test(sub)) return true;
  if (/payment\s+inquir/i.test(sub)) return true;
  return false;
}

/**
 * Payment-inquiry handler applies only when there is no invoice PDF to process.
 * @param {string} subject Email subject.
 * @param {string} from From header.
 * @param {string} body Plain body.
 * @param {number} [invoicePdfCount] Invoice PDFs after doc classification.
 * @return {boolean}
 */
function shouldHandlePaymentInquiry(
    subject, from, body, invoicePdfCount) {
  if (Number(invoicePdfCount) > 0) return false;
  if (!isPaymentInquiryEmail(subject, from, body)) return false;
  return true;
}

/**
 * Subject/body looks like a factor carrier-invoice notification.
 * @param {string} subject Email subject.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function looksLikeInvoiceEmailContent(subject, body) {
  const sub = String(subject || "").trim().toLowerCase();
  const content = `${subject || ""}\n${body || ""}`.toLowerCase();
  // Allow optional whitespace after "#": "Invoice # 981 …"
  if (/^(?:fw:\s*)?invoice\s+#?\s*\d+/.test(sub)) return true;
  if (/^(?:fw:\s*)?invoice\s+\d+\s+from\b/.test(sub)) return true;
  // Compass FS factored invoices: PO # in subject is the broker load.
  if (/^purchase\s+order\s+number\s*[;:]\s*purchase\s+order\s*#\s*\d{5,9}/i
      .test(sub)) {
    return true;
  }
  if (/purchase\s+order\s*#\s*\d{5,9}/i.test(sub) &&
      /compassfs/i.test(content)) {
    return true;
  }
  // FactorView / BP Financing: "Invoice # 981 Your PO # 265543"
  if (/invoice\s+#?\s*\d+/i.test(sub) &&
      /(?:your\s+)?po\s*#?\s*\d{5,9}/i.test(sub) &&
      /factorview/i.test(content)) {
    return true;
  }
  if (/invoice\s+#?\s*\d+/i.test(sub) &&
      /(?:your\s+)?po\s*#?\s*\d{5,9}/i.test(sub)) {
    return true;
  }
  // Carrier portals (ArcBest/ABF, etc.): "eInvoice(s) - 760981 ..."
  if (/\be-?invoices?\b/.test(sub)) return true;
  // QuickBooks: "New payment request from X - invoice 173867"
  // (body often has Zelle/ACH remittance tips — not a bank payment alert)
  if (/\bpayment\s+request\b/.test(sub) &&
      /\binvoice\s+#?\s*\d+\b/.test(sub)) {
    return true;
  }
  if (/your invoice is ready/i.test(content) &&
      /\binvoice\s+#?\s*\d+\b/.test(sub)) {
    return true;
  }
  if (/your invoice is attached/i.test(content) &&
      /\binvoice\s+#?\s*\d+\b/.test(sub)) {
    return true;
  }
  if (/\binvoice\s+#?\s*\d+[\s-]+(?:for\s+)?(?:bol|load)\s+#?\s*\d{5,9}/i
      .test(content)) {
    return true;
  }
  if (/\binvoice\s+#?\s*\d+[\s-]+load\s+\d{5,9}/i.test(content)) {
    return true;
  }
  if (/\bfreight invoice\b/.test(content) &&
      /\b(?:load|bol)\s+#?\d{5,9}/i.test(content)) {
    return true;
  }
  if (/attached are the invoices?/i.test(content)) return true;
  if (/\be-?invoices?\b/.test(content) &&
      /\b(?:pronumber|pro\s*#?|attached)\b/i.test(content)) {
    return true;
  }
  return false;
}

/**
 * Ignore bank/Zelle alerts only when the email is not an invoice package.
 * @param {string} subject Email subject.
 * @param {string} from From header.
 * @param {string} body Plain body.
 * @param {Array<object>} [attachments] Attachment metadata.
 * @return {boolean}
 */
function shouldIgnoreAsPaymentNotification(
    subject, from, body, attachments) {
  if (!isPaymentNotificationEmail(subject, from, body)) return false;
  if (looksLikeInvoiceEmailContent(subject, body)) return false;
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.some((a) => attachmentFilenameLooksLikeInvoice(a.filename))) {
    return false;
  }
  return true;
}

/**
 * Subject/body mentions Notice of Assignment / factoring remittance
 * (not sufficient alone to ignore — see shouldIgnoreNoaOnlyPackage).
 * @param {string} subject Email subject.
 * @param {string} body Plain body.
 * @param {string} [from] From header (optional; FactorView remits).
 * @return {boolean}
 */
function looksLikeNoaEmailContent(subject, body, from) {
  const sub = String(subject || "");
  const content = `${sub}\n${body || ""}`.toLowerCase();
  if (!content.trim()) return false;
  if (looksLikeInvoiceEmailContent(subject, body)) return false;
  // FactorView / Surety-style remittance notices (not freight invoices).
  if (/^\s*(?:(?:fw|fwd|re):\s*)*remit\s+for\s+payment\b/i.test(sub)) {
    return true;
  }
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
  if (/remit(?:tance)?\s+(?:all\s+)?(?:future\s+)?(?:payments?|invoices?)/i
      .test(content)) {
    return true;
  }
  const remitDirectedRe = new RegExp(
      "payments?\\s+(?:should|must|are to)\\s+be\\s+" +
      "(?:directed|remitted|sent|made)\\s+to",
      "i");
  if (remitDirectedRe.test(content)) {
    return true;
  }
  const fromL = String(from || "").toLowerCase();
  if (fromL.includes("factorview.com") &&
      /remit|assignment|factor(?:ing)?|funding|surety/i.test(content)) {
    return true;
  }
  return false;
}

/**
 * @param {string} subject Email subject.
 * @param {string} from From header.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function isNoticeOfAssignmentEmail(subject, from, body) {
  return looksLikeNoaEmailContent(subject, body, from);
}

/**
 * RTS alias — kept for callers/tests.
 * @param {string} subject Email subject.
 * @param {string} from From header.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function isRtsNoaEmail(subject, from, body) {
  return looksLikeNoaEmailContent(subject, body, from);
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
    /carrier[\s._-]?bill|bill[\s._-]?of[\s._-]?lading/.test(name) ||
    /purchase\s+order\s*#\s*\d{5,9}/.test(name);
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
 * @param {string} [from] From header (optional).
 * @return {boolean}
 */
function shouldIgnoreNoaOnlyPackage(
    subject, body, attachments, invoicePdfCount, from) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (Number(invoicePdfCount) > 0) return false;
  if (looksLikeInvoiceEmailContent(subject, body)) return false;
  if (list.some((a) => attachmentFilenameLooksLikeInvoice(a.filename))) {
    return false;
  }
  if (rtsNoaAttachmentsLookNoaOnly(list)) return true;
  if (looksLikeNoaEmailContent(subject, body, from) && list.length === 0) {
    return true;
  }
  if (looksLikeNoaEmailContent(subject, body, from) &&
      Number(invoicePdfCount) === 0 &&
      list.length > 0) {
    return true;
  }
  return false;
}

/**
 * Central guard: true when an email must not be auto-ignored as admin noise.
 * @param {object} signals Veto inputs gathered at the call site.
 * @param {string} [signals.subject] Email subject.
 * @param {string} [signals.body] Plain email body.
 * @param {string} [signals.from] From header.
 * @param {Array<object>} [signals.attachments] Attachment metadata.
 * @param {object} [signals.emailClassification] Incoming email classifier.
 * @param {number} [signals.invoicePdfCount] Classified invoice PDF count.
 * @return {boolean}
 */
function hasInvoiceVeto(signals = {}) {
  const {
    subject = "",
    body = "",
    from = "",
    attachments = [],
    emailClassification = null,
    invoicePdfCount,
  } = signals;

  if (looksLikeInvoiceEmailContent(subject, body)) return true;

  const list = Array.isArray(attachments) ? attachments : [];
  if (list.some((a) => attachmentFilenameLooksLikeInvoice(a.filename))) {
    return true;
  }

  if (Number(invoicePdfCount) > 0) return true;

  if (emailClassification &&
      emailClassification.intent === "carrier_invoice") {
    // Classifier often mislabels FactorView "Remit for Payment" / NOA
    // packages as carrier_invoice. Do not force invoice_veto or block
    // NOA ignore when there is no invoice PDF evidence.
    if (looksLikeNoaEmailContent(subject, body, from) &&
        Number(invoicePdfCount || 0) === 0) {
      return false;
    }
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
  if (isCardknoxBatchReport(subject, from)) {
    return {
      ignore: true,
      reason: "Cardknox batch report — no action needed",
      status: "cardknox_batch_report_ignored",
    };
  }
  // Before PDF classification: only ignore when filenames clearly NOA-only.
  if (rtsNoaAttachmentsLookNoaOnly(attachments) &&
      looksLikeNoaEmailContent(subject, body, from) &&
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
  PAYMENT_INQUIRY_EMAIL_DEFAULT,
  isEmodalBroadcast,
  isCardknoxBatchReport,
  isHafstaffSender,
  isPaymentNotificationEmail,
  shouldIgnoreAsPaymentNotification,
  isPaymentInquiryEmail,
  shouldHandlePaymentInquiry,
  looksLikeInvoiceEmailContent,
  looksLikeNoaEmailContent,
  isNoticeOfAssignmentEmail,
  isRtsNoaEmail,
  attachmentFilenameLooksLikeInvoice,
  attachmentFilenameLooksLikeNoa,
  rtsNoaAttachmentsLookNoaOnly,
  shouldIgnoreNoaOnlyPackage,
  hasInvoiceVeto,
  evaluateAdministrativeIgnore,
};
