"use strict";

const administrativeEmailIntake = require("./administrative-email-intake");
const statementInvoiceBundle = require("./statement-invoice-bundle");

/**
 * True when email-level classifier indicates a carrier invoice package
 * worth processing (used to override cheap PDF pre-check mislabels).
 * @param {object|null|undefined} classification Incoming email classifier.
 * @param {object} [context] subject, body, from.
 * @return {boolean}
 */
function emailClassificationSupportsInvoicePdf(classification, context = {}) {
  if (!classification || classification.intent !== "carrier_invoice") {
    return false;
  }
  if (classification.confidence === "high" ||
      classification.confidence === "medium") {
    return true;
  }
  const {subject = "", body = ""} = context;
  if (administrativeEmailIntake.looksLikeInvoiceEmailContent(subject, body)) {
    return true;
  }
  if (statementInvoiceBundle.looksLikeCarrierInvoiceEmail(
      subject, context.from || "", body)) {
    return true;
  }
  return false;
}

/**
 * Rewrites classifier output when metadata/body clearly describe an invoice
 * package the cheap classifier missed (internal forwards, factor notices).
 * @param {object} classification Classifier result.
 * @param {string} subject Email subject.
 * @param {string} from Email sender.
 * @param {string} [body] Email body.
 * @param {Array<object>} [attachments] Attachment metadata.
 * @return {object} Possibly rewritten classification.
 */
function overrideClassificationIfInvoicePackage(
    classification, subject, from, body, attachments) {
  let current = classification && typeof classification === "object" ?
    classification : {intent: "unknown", confidence: "low"};
  current = statementInvoiceBundle
      .overrideStatementClassificationIfInvoicePacket(
          current, subject, from, body, attachments);
  if (current.intent === "carrier_invoice") return current;
  if (current.intent === "insurance_premium" ||
      current.intent === "quote_request" ||
      current.intent === "pod_request" ||
      current.intent === "pod_delivery") {
    return current;
  }
  if (!statementInvoiceBundle.hasProcessablePdfAttachment(attachments)) {
    return current;
  }
  if (administrativeEmailIntake.looksLikeInvoiceEmailContent(subject, body) ||
      statementInvoiceBundle.looksLikeCarrierInvoiceEmail(subject, from, body)) {
    return {
      ...current,
      intent: "carrier_invoice",
      confidence: current.confidence === "low" ? "medium" : current.confidence,
      reasoning:
        "Email text indicates a carrier/factor freight invoice to process.",
    };
  }
  return current;
}

/**
 * Resolves the attachment docType for intake by merging the cheap PDF
 * first-page pre-check with email-level classification — the same signal
 * that later powers Jerry forward summaries.
 * @param {string} preCheckLabel INVOICE, STATEMENT, POD, OTHER, etc.
 * @param {object} [context] subject, from, body, filename, pageCount,
 *   emailClassification.
 * @return {{docType: string, promoted: boolean, reason: string|null}}
 */
function resolveAttachmentDocType(preCheckLabel, context = {}) {
  const label = statementInvoiceBundle.sanitizePreCheckLabel(preCheckLabel);
  const normalized = statementInvoiceBundle.normalizePreCheckDocType(
      preCheckLabel, context);
  if (normalized === "INVOICE" || normalized === "POD") {
    return {docType: normalized, promoted: false, reason: null};
  }
  if (label !== "OTHER") {
    return {docType: normalized, promoted: false, reason: null};
  }
  if (emailClassificationSupportsInvoicePdf(
      context.emailClassification, context)) {
    return {
      docType: "INVOICE",
      promoted: true,
      reason: "email_classifier_carrier_invoice",
    };
  }
  const {subject = "", body = "", from = ""} = context;
  if (administrativeEmailIntake.looksLikeInvoiceEmailContent(subject, body) ||
      statementInvoiceBundle.looksLikeCarrierInvoiceEmail(subject, from, body)) {
    return {
      docType: "INVOICE",
      promoted: true,
      reason: "invoice_email_content",
    };
  }
  return {docType: normalized, promoted: false, reason: null};
}

module.exports = {
  emailClassificationSupportsInvoicePdf,
  overrideClassificationIfInvoicePackage,
  resolveAttachmentDocType,
};
