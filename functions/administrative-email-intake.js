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
 * Legitimate D&B credit / trade-credit alert content — not marketing.
 * @param {string} hay Lowercased subject + body haystack.
 * @return {boolean}
 */
function looksLikeDnbCreditAlert(hay) {
  const patterns = [
    /\bcredit (?:alert|report|score|monitoring|change|inquiry|inquiries)\b/,
    /\btrade credit\b/,
    /\bbusiness credit (?:report|alert|update|monitoring)\b/,
    /\bpayment (?:due|past due|overdue|reminder)\b/,
    /\bcollection\b/,
    /\bdelinquen/,
    /\bduns (?:number|#)\b/,
    /\brisk (?:alert|score|monitoring)\b/,
    /\bcredit (?:limit|line) (?:change|update|alert)\b/,
    /\baccount (?:past due|delinquent)\b/,
  ];
  return patterns.some((re) => re.test(hay));
}

/**
 * Dun & Bradstreet promotional/marketing (e.g. Lili business banking ads).
 * Does not ignore legitimate D&B credit or trade-credit alerts.
 * @param {string} subject Email subject.
 * @param {string} from From header.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function isDnbPromotionalEmail(subject, from, body) {
  const fromL = String(from || "").toLowerCase();
  if (!fromL.includes("dnb.com") &&
      !fromL.includes("dunandbradstreet")) {
    return false;
  }
  const hay = `${subject || ""}\n${body || ""}`.toLowerCase();
  if (looksLikeDnbCreditAlert(hay)) return false;

  const addrMatch =
    fromL.match(/<([^>]+)>/) || fromL.match(/([\w.+-]+@[\w.-]+)/);
  const addr = String(addrMatch && addrMatch[1] || fromL).toLowerCase();
  const isMarketingSender =
    addr.startsWith("e.email@dnb.com") ||
    addr.includes("marketing@") ||
    addr.includes("@e.email.dnb.com");

  const promotionalPatterns = [
    /\blili\b/,
    /\bbusiness banking\b/,
    /\bno hidden fees\b/,
    /\bno overdrafts?\b/,
    /\bsmarter business banking\b/,
    /\bopen (?:a|your) (?:business )?(?:checking|bank) account\b/,
    /\b(?:earn|get) \$\d+.*(?:bonus|cash back)\b/,
    /\blimited[- ]time offer\b/,
    /\bstart(?:ing)? (?:your|a) business (?:bank|banking)\b/,
  ];
  const looksPromotional = promotionalPatterns.some((re) => re.test(hay));
  if (looksPromotional) return true;

  // e.email@dnb.com is D&B's marketing sender — banking-ad subjects only.
  if (isMarketingSender &&
      /\b(?:banking|bank account|checking|overdraft|fees)\b/i
          .test(String(subject || ""))) {
    return true;
  }
  return false;
}

/**
 * Vendor promotional/marketing emails safe to auto-ignore.
 * @param {string} subject Email subject.
 * @param {string} from From header.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function isPromotionalMarketingEmail(subject, from, body) {
  return isDnbPromotionalEmail(subject, from, body) ||
    isAmexMerchantSurveyEmail(subject, from, body);
}

/**
 * Extract bare email address from a From header.
 * @param {string} from From header.
 * @return {string}
 */
function emailAddressFromHeader(from) {
  const raw = String(from || "").toLowerCase();
  const emailMatch = raw.match(/<([^>]+)>/) || raw.match(/([\w.+-]+@[\w.-]+)/);
  return String(emailMatch && emailMatch[1] || raw).trim();
}

/**
 * Parses email addresses from a RFC822 To/Cc header value.
 * @param {string} headerValue Raw header value.
 * @return {string[]} Lowercase email addresses.
 */
function parseEmailAddressesFromHeaderValue(headerValue) {
  const raw = String(headerValue || "");
  const matches = raw.match(
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
  return matches ? matches.map((addr) => addr.toLowerCase()) : [];
}

/**
 * Accounting contact for carrier statements / payment follow-ups.
 * @return {string}
 */
function resolveStatementAbeEmail() {
  return String(
      process.env.REVIEW_EMAIL_STATEMENT ||
      PAYMENT_INQUIRY_EMAIL_DEFAULT,
  ).trim().toLowerCase();
}

/**
 * True when Abe is already on the original email (To or Cc).
 * @param {Array<object>} headers Gmail payload headers.
 * @return {boolean}
 */
function isAbeCopiedOnEmailHeaders(headers) {
  const abeEmail = resolveStatementAbeEmail();
  const list = Array.isArray(headers) ? headers : [];
  for (const header of list) {
    const name = String(header && header.name || "").toLowerCase();
    if (name !== "to" && name !== "cc") continue;
    const addrs = parseEmailAddressesFromHeaderValue(header.value);
    if (addrs.includes(abeEmail)) return true;
  }
  return false;
}

/**
 * True when the sender domain is coface.com (Lisa: ignore all Coface mail).
 * @param {string} from From header.
 * @return {boolean}
 */
function isCofaceDomain(from) {
  const addr = emailAddressFromHeader(from);
  const at = addr.lastIndexOf("@");
  if (at < 0) return false;
  const domain = addr.slice(at + 1).replace(/[^a-z0-9.-]/g, "");
  return domain === "coface.com" || domain.endsWith(".coface.com");
}

/**
 * Coface newsletters / marketing — no action needed (Lisa: all Coface).
 * @param {string} from From header.
 * @param {string} [subject] Email subject (unused; domain match only).
 * @param {string} [body] Plain body (unused; domain match only).
 * @return {boolean}
 */
function isCofaceEmail(from, subject, body) {
  void subject;
  void body;
  return isCofaceDomain(from);
}

/**
 * Out-of-office / vacation automatic reply emails (Lisa: ignore).
 * Uses subject and first-person auto-reply body phrasing; avoids casual
 * third-party mentions of someone being away.
 * @param {string} subject Email subject.
 * @param {string} from From header (unused; kept for API symmetry).
 * @param {string} body Plain body.
 * @return {boolean}
 */
function isOutOfOfficeAutoReply(subject, from, body) {
  void from;
  const sub = String(subject || "").trim();
  const subL = sub.toLowerCase();
  const bodyL = String(body || "").toLowerCase();
  if (!subL && !bodyL.trim()) return false;
  if (looksLikeInvoiceEmailContent(subject, body)) return false;

  const subjectPatterns = [
    /^out of office\b/i,
    /^automatic reply\b/i,
    /^auto-?reply\b/i,
    /^away from (?:the )?office\b/i,
    /^ooo\s*:/i,
    /^i am out of (?:the )?office\b/i,
    /\bautomatic reply\s*:/i,
    /\bout of office auto/i,
    /\bauto reply\s*:/i,
    /\b(?:away|out)\s+message\b/i,
  ];
  if (subjectPatterns.some((re) => re.test(sub))) return true;

  const strongBodyPatterns = [
    /\bi am currently out of (?:the )?office\b/,
    /\bi will be out of (?:the )?office\b/,
    /\bi am away from (?:the )?office\b/,
    /\bi am currently away\b/,
    /\blimited access to (?:my )?email\b/,
    /\bthis is an automatic (?:reply|response)\b/,
    /\bthis is an automated (?:reply|response)\b/,
    /\bi am on (?:vacation|holiday|leave)\b/,
    /\bi will be on (?:vacation|holiday|leave)\b/,
    /\breturning on\b.*\bout of (?:the )?office\b/,
    /\bout of (?:the )?office\b.*\breturning on\b/,
    /\bthank you for (?:your )?(?:email|message)\b.*\bout of (?:the )?office\b/,
    /\bout of (?:the )?office\b.*\bthank you for (?:your )?(?:email|message)\b/,
  ];
  if (strongBodyPatterns.some((re) => re.test(bodyL))) return true;

  const hasAutoReplySubjectHint =
    /\b(?:automatic|auto)[- ]?reply\b/i.test(subL) ||
    /\booo\b/i.test(subL);
  const weakBodyPatterns = [
    /\bi am out of (?:the )?office\b/,
    /\bi will be out until\b/,
    /\bwill respond when i return\b/,
  ];
  if (hasAutoReplySubjectHint &&
      weakBodyPatterns.some((re) => re.test(bodyL))) {
    return true;
  }
  return false;
}

/**
 * AmEx Merchant Services satisfaction / feedback surveys — promotional only
 * (Lisa: ignore). Not chargebacks, disputes, or payment notices.
 * Example: From American Express Merchant Services
 * <AmericanExpress@email.americanexpress.com>,
 * Subject "INNOVATIVE CARRIERS, We want to hear from you on September 9".
 * @param {string} subject Email subject.
 * @param {string} from From header.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function isAmexMerchantSurveyEmail(subject, from, body) {
  const fromL = String(from || "").toLowerCase();
  const emailMatch =
    fromL.match(/<([^>]+)>/) || fromL.match(/([\w.+-]+@[\w.-]+)/);
  const addr = String(emailMatch && emailMatch[1] || fromL).toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at < 0) return false;
  const domain = addr.slice(at + 1);
  if (!domain.endsWith("americanexpress.com")) return false;

  const sub = String(subject || "");
  const hay = `${sub}\n${body || ""}`.toLowerCase();

  // Operational AmEx mail — do not auto-ignore.
  if (/\b(?:chargeback|dispute|case\s*(?:#|number)|authorization\s+declin)/i
      .test(hay)) {
    return false;
  }

  if (/we want to hear from you/i.test(hay)) return true;
  if (/(?:customer\s+)?satisfaction\s+survey/i.test(hay)) return true;
  if (/share your (?:feedback|experience)/i.test(hay) &&
      /merchant\s+services/i.test(fromL)) {
    return true;
  }
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

/** Default accounting contact for customer payment remittances. */
const CUSTOMER_PAYMENT_REMITTANCE_EMAIL_DEFAULT =
  "abe@innovativecarriers.com";

/**
 * Known carrier / factor sender domains — not customer payment remittance.
 * @param {string} from From header.
 * @return {boolean}
 */
function isCarrierOrFactorSender(from) {
  const addr = emailAddressFromHeader(from);
  const at = addr.lastIndexOf("@");
  if (at < 0) return false;
  const domain = addr.slice(at + 1);
  const carrierFactorDomains = [
    "factorview.com",
    "phoenixcapitalgroup.com",
    "compassfs.net",
    "thunderfunding.com",
    "singlepointgroup.com",
    "rtsinc.com",
    "rtsfinancial.com",
    "cjfinancing.com",
    "vtflog.com",
    "abf.com",
    "arcb.com",
    "notification.intuit.com",
  ];
  if (carrierFactorDomains.some((d) =>
    domain === d || domain.endsWith("." + d))) {
    return true;
  }
  const raw = String(from || "").toLowerCase();
  if (/\bmc\s*#?\s*\d{5,7}\b/.test(raw)) return true;
  return false;
}

/**
 * Subject like "Payment 08/25/26" — customer sending remittance info.
 * @param {string} subject Email subject.
 * @return {boolean}
 */
function subjectLooksLikeCustomerPaymentDate(subject) {
  const sub = String(subject || "").trim();
  const stripped = sub.replace(/^(?:(?:re|fw|fwd):\s*)+/i, "").trim();
  return /^payment\s+\d{1,2}\/\d{1,2}\/\d{2,4}\s*$/i.test(stripped);
}

/**
 * Subject like "CK 6706" or "Check #6706" — customer sending check remittance.
 * @param {string} subject Email subject.
 * @return {boolean}
 */
function subjectLooksLikeCustomerCheckNumber(subject) {
  const sub = String(subject || "").trim();
  const stripped = sub.replace(/^(?:(?:re|fw|fwd):\s*)+/i, "").trim();
  return /^(?:ck|check)(?:\s*#|\s+no\.?\s*)?\s*\d{3,8}\s*$/i.test(stripped);
}

/**
 * Subject like "Your Remittance Advice 1557" or "Remittance Advice".
 * @param {string} subject Email subject.
 * @return {boolean}
 */
function subjectLooksLikeRemittanceAdvice(subject) {
  const sub = String(subject || "").trim();
  const stripped = sub.replace(/^(?:(?:re|fw|fwd):\s*)+/i, "").trim();
  return /^(?:your\s+)?remittance\s+advice(?:\s*#?\s*\d+)?\s*$/i
      .test(stripped);
}

/**
 * Subject is a reply on our customer-invoice thread (Invoice for BOL/Load#).
 * @param {string} subject Email subject.
 * @return {boolean}
 */
function subjectLooksLikeInvoiceForBolReply(subject) {
  const sub = String(subject || "").trim().toLowerCase();
  return /^(?:(?:re|fw|fwd):\s*)+invoice\s+for\s+(?:bol|load)\s*#?\s*\d{5,9}/
      .test(sub);
}

/**
 * Strip quoted reply history so banking footers in prior messages do not
 * look like the customer announcing a payment.
 * @param {string} body Plain body.
 * @return {string}
 */
function topOfThreadBody(body) {
  let top = String(body || "");
  top = top.split(/\n\s*On .+?wrote:\s*\n/i)[0];
  top = top.split(/\n-{2,}\s*Original Message\s*-{2,}/i)[0];
  top = top.split(/\nFrom:\s+.+\nSent:\s+/i)[0];
  return top;
}

/**
 * Customer top-of-thread text saying they paid / sent remittance.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function bodyLooksLikeCustomerPaidNotice(body) {
  const top = topOfThreadBody(body).toLowerCase();
  if (!top.trim()) return false;
  const patterns = [
    /\bremittance\b/,
    /\bpayment\s+(?:was\s+)?(?:sent|made|submitted|completed|received)\b/,
    /\b(?:we|i)\s+(?:have\s+)?(?:just\s+)?paid\b/,
    /\bpaid\s+(?:in\s+full|via|by|through|already|today)\b/,
    /\bsent\s+(?:the\s+)?(?:payment|funds)\b/,
    /\bwire(?:d)?\s+(?:the\s+)?payment\b/,
    /\b(?:payment|invoice)\s+(?:has\s+been|was)\s+paid\b/,
  ];
  return patterns.some((re) => re.test(top));
}

/**
 * Bare MC# subject — factor NOA notices (e.g. "MC#856665", "MC #856665").
 * @param {string} subject Email subject.
 * @return {boolean}
 */
function subjectLooksLikeMcNumberNoa(subject) {
  const sub = String(subject || "").trim();
  const stripped = sub.replace(/^(?:(?:re|fw|fwd):\s*)+/i, "").trim();
  return /^mc\s*#\s*\d{5,7}\s*$/i.test(stripped);
}

/**
 * Customer payment remittance — sender notifying Innovative of payment sent.
 * Not a carrier freight invoice or factor remittance notice.
 * @param {string} subject Email subject.
 * @param {string} from From header.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function isCustomerPaymentRemittanceEmail(subject, from, body) {
  if (isCarrierOrFactorSender(from)) return false;
  if (isPaymentNotificationEmail(subject, from, body)) return false;
  if (looksLikeNoaEmailContent(subject, body, from)) return false;

  const addr = emailAddressFromHeader(from);
  if (addr.endsWith("@innovativecarriers.com")) return false;

  const sub = String(subject || "").trim();
  const hay = `${sub}\n${body || ""}`.toLowerCase();

  // Subject-first remittance signals — before invoice-content veto.
  // Remittance-advice bodies often list invoice# / BOL lines that would
  // otherwise look like a carrier invoice package.
  if (subjectLooksLikeCustomerPaymentDate(subject)) return true;
  if (subjectLooksLikeCustomerCheckNumber(subject)) return true;
  if (subjectLooksLikeRemittanceAdvice(subject)) return true;

  // Customer reply on "Invoice for BOL#" saying they paid → Abe (not ignore
  // as bank alert, not process as freight invoice).
  if (subjectLooksLikeInvoiceForBolReply(subject) &&
      bodyLooksLikeCustomerPaidNotice(body)) {
    return true;
  }

  if (looksLikeInvoiceEmailContent(subject, body)) return false;

  if (isPaymentInquiryEmail(subject, from, body)) return false;

  const remittancePatterns = [
    /\bremittance\s+advice\b/,
    /\bpayment\s+remittance\b/,
    /\bcheck\s+remittance\b/,
    /\bplease\s+find\s+(?:attached\s+)?(?:the\s+)?remittance\b/,
    /\benclosed\s+(?:is\s+)?(?:our\s+)?payment\b/,
    /\battached\s+(?:is\s+)?(?:our\s+)?(?:payment|check|remittance)\b/,
  ];
  if (!remittancePatterns.some((re) => re.test(hay))) return false;
  if (/\bload\s*#?\s*\d{5,9}\b/.test(hay)) return false;
  if (/\bquick\s*pay\b/.test(hay)) return false;
  return true;
}

/**
 * Customer remittance handler — intercept before carrier invoice processing.
 * @param {string} subject Email subject.
 * @param {string} from From header.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function shouldHandleCustomerPaymentRemittance(subject, from, body) {
  return isCustomerPaymentRemittanceEmail(subject, from, body);
}

/**
 * Bank of America payment-alert sender (Zelle/ACH deposit notifications).
 * @param {string} from From header.
 * @return {boolean}
 */
function isBankOfAmericaSender(from) {
  const fromL = String(from || "").toLowerCase();
  return (
    fromL.includes("bankofamerica.com") ||
    fromL.includes("@bofa.com")
  );
}

/**
 * Bank of America Zelle / ACH payment alerts — not carrier freight invoices.
 * Only BoA senders match; invoice replies quoting Zelle remittance tips do not.
 * @param {string} subject Email subject.
 * @param {string} from From header.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function isPaymentNotificationEmail(subject, from, body) {
  if (!isBankOfAmericaSender(from)) return false;
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
  if (/(?:payment|transfer|deposit|withdrawal|alert)/i.test(hay)) {
    return true;
  }
  return false;
}

/**
 * QuickBooks / vendor payment receipt confirmations — not freight invoices.
 * Example: Subject "Payment Receipt from Amfast Freight, Inc.",
 * From quickbooks@notification.intuit.com (Lisa: ignore).
 * Distinct from "payment request" / "Invoice N from …" which must still process.
 * @param {string} subject Email subject.
 * @param {string} from From header.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function isPaymentReceiptEmail(subject, from, body) {
  const sub = String(subject || "").trim();
  const subL = sub.toLowerCase();
  const hay = `${sub}\n${from || ""}\n${body || ""}`.toLowerCase();
  if (!subL && !String(body || "").trim()) return false;
  if (looksLikeInvoiceEmailContent(subject, body)) return false;

  if (/\bpayment\s+receipt\b/i.test(sub)) return true;
  if (/\bpayment\s+receipt\s+from\b/i.test(hay)) return true;
  if (/\byour\s+payment\s+receipt\b/i.test(hay)) return true;
  if (/\breceipt\s+for\s+(?:your\s+)?payment\b/i.test(hay)) return true;

  const fromL = String(from || "").toLowerCase();
  if ((fromL.includes("notification.intuit.com") ||
       fromL.includes("quickbooks@")) &&
      /\bpayment\s+receipt\b/i.test(hay)) {
    return true;
  }
  return false;
}

/**
 * Ignore payment receipts unless the package includes a freight invoice file.
 * @param {string} subject Email subject.
 * @param {string} from From header.
 * @param {string} body Plain body.
 * @param {Array<object>} [attachments] Attachment metadata.
 * @return {boolean}
 */
function shouldIgnoreAsPaymentReceipt(
    subject, from, body, attachments) {
  if (!isPaymentReceiptEmail(subject, from, body)) return false;
  if (looksLikeInvoiceEmailContent(subject, body)) return false;
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.some((a) => attachmentFilenameLooksLikeInvoice(a.filename))) {
    return false;
  }
  return true;
}

/**
 * Subject is only a load-number thread title, e.g. "Re: 264617".
 * @param {string} subject Email subject.
 * @return {boolean}
 */
function subjectLooksLikeLoadNumberReply(subject) {
  const sub = String(subject || "").trim();
  const stripped = sub.replace(/^(?:(?:re|fw|fwd):\s*)+/i, "").trim();
  return /^\d{5,6}\.?\s*$/.test(stripped);
}

/**
 * Body asks about missing or delayed payment (optionally for load numbers).
 * Used with bare load-number subjects so non-payment Re: threads do not match.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function bodyLooksLikeLoadPaymentFollowUp(body) {
  const bodyL = String(body || "").toLowerCase();
  if (!bodyL.trim()) return false;
  const paymentSignals = [
    /\bpayment\s+has\s+not\s+been\s+received\b/,
    /\bpayment\s+not\s+received\b/,
    /\b(?:have\s+not|has\s+not|haven't)\s+received\s+(?:our\s+)?payment\b/,
    /\b(?:update|status)\s+(?:on\s+)?payment\s+status\b/,
    /\bpayment\s+status\s+update\b/,
    /\bunpaid\b/,
    /\boutstanding\s+payment\b/,
    /\bpending\s+payment\b/,
    /\bwhen\s+(?:will|can)\s+(?:we|i|our)\s+(?:get\s+)?paid\b/,
    /\bstatus\s+of\s+(?:my\s+)?payment\b/,
    /\bpayment\s+status\b/,
    /\b(?:still\s+)?awaiting\s+payment\b/,
  ];
  return paymentSignals.some((re) => re.test(bodyL));
}

/**
 * Subject is a bare load-number thread title (e.g. "Re: 264617", "264618").
 * @param {string} subject Email subject.
 * @return {boolean}
 */
function subjectLooksLikeLoadNumberReply(subject) {
  const sub = String(subject || "").trim();
  if (!sub) return false;
  const stripped = sub.replace(/^(?:(?:re|fw|fwd):\s*)+/i, "").trim();
  return /^(?:load\s+#?\s*)?\d{5,9}\s*$/i.test(stripped);
}

/**
 * Body asks about payment timing/status for one or more loads.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function bodyLooksLikeLoadPaymentFollowUp(body) {
  const bodyL = String(body || "").toLowerCase();
  if (!bodyL.trim()) return false;
  const hasLoadRef =
    /\bload\s+(?:numbers?|nos?\.?|#)\b/.test(bodyL) ||
    /\b\d{5,9}\b/.test(bodyL);
  if (!hasLoadRef) return false;
  const paymentSignals = [
    /\bpayment\s+(?:has\s+not\s+been\s+received|not\s+received)\b/,
    /\bpayment\s+status(?:\s+update)?\b/,
    /\b(?:unpaid|outstanding)\s+(?:load|payment|invoice)/,
    /\bfollow(?:ing)?\s+up\s+on\s+(?:unpaid|outstanding)/,
    /\bwhen\s+will\s+payment\b/,
    /\bprovide\s+(?:an?\s+)?(?:update\s+on\s+)?payment\b/,
    /\brequesting\s+.*payment\s+status\b/,
  ];
  return paymentSignals.some((re) => re.test(bodyL));
}

/**
 * Sender domain looks like a freight factor / financing company.
 * @param {string} from From header.
 * @return {boolean}
 */
function senderDomainLooksLikeFactor(from) {
  if (isCarrierOrFactorSender(from)) return true;
  const addr = emailAddressFromHeader(from);
  const at = addr.lastIndexOf("@");
  if (at < 0) return false;
  const domain = addr.slice(at + 1).toLowerCase();
  return /(?:financ|factor)/.test(domain);
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
  const subStripped = sub.replace(/^(?:(?:re|fw|fwd):\s*)+/i, "").trim();
  const hay = `${sub}\n${from || ""}\n${body || ""}`.toLowerCase();
  if (!hay.trim()) return false;
  if (looksLikeInvoiceEmailContent(subject, body)) return false;

  const patterns = [
    /\bquick\s*pay\b/,
    /\bquickpay\b/,
    /\bpayment\s+inquir(y|ies)\b/,
    /\bpayment\s+request\b/,
    /\bpayment\s+status\b/,
    /\bstatus\s+of\s+(?:my\s+)?payment\b/,
    /\bpending\s+payment\b/,
    /\bunpaid\s+payment\b/,
    /\b(?:outstanding|overdue|awaiting)\s+payment(?:\s+(?:reminder|follow[- ]?up))?\b/,
    /\boutstanding\s+payment\s+reminder\b/,
    /\boutstanding\s+invoices?\b/,
    /\boverdue\s+invoices?\b/,
    /\bexpected\s+payment\s+date\b/,
    /\b(?:provide|send|share)\s+(?:an?\s+)?expected\s+payment\s+date\b/,
    /\bfollow(?:ing)?\s+up\s+(?:on\s+)?(?:\d+\s+)?outstanding\s+invoices?\b/,
    /\b(?:requesting|need)\s+(?:an?\s+)?expected\s+payment\s+date\b/,
    /\b(?:requesting|need|provide)\s+(?:an?\s+)?scheduled\s+payment\s+date\b/,
    /\b(?:requesting|provide|send|need)\s+(?:the\s+)?payment\s+details\b/,
    /\bpayment\s+(?:details|update)\b/,
    /\bpayment\s+for\s+load\s+#?\s*\d{5,9}\b/,
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
    /\bpayment\s+has\s+not\s+been\s+received\b/,
    /\bpayment\s+not\s+received\b/,
    /\b(?:have\s+not|has\s+not|haven't)\s+received\s+(?:our\s+)?payment\b/,
    /\b(?:update|status)\s+(?:on\s+)?payment\s+status\b/,
    /\bpayment\s+status\s+update\b/,
    /\bpayment\s+(?:has\s+not\s+been\s+received|not\s+received|status)\b.*\bload\b/,
    /\bload\s+(?:numbers?|nos?\.?|#)\b.*\bpayment\b/,
    /\bfollow(?:ing)?\s+up\b.*\b(?:unpaid|outstanding|payment)\b.*\bload\b/,
    /\b(?:unpaid|outstanding)\b.*\bload\s+(?:numbers?|#)\b/,
  ];
  if (patterns.some((re) => re.test(hay))) return true;
  if (/quick\s*pay\s+invoice/i.test(subStripped)) return true;
  if (/payment\s+inquir/i.test(subStripped)) return true;
  if (/pending\s+payment\s+for\s+load/i.test(subStripped)) return true;
  if (/payment\s+update\s+load\s+#?\s*\d{5,9}/i.test(subStripped)) return true;
  if (/payment\s+update\s+for\s+load/i.test(subStripped)) return true;
  if (/payment\s+status\s+update/i.test(subStripped)) return true;
  if (/outstanding\s+payment\s+reminder/i.test(subStripped)) return true;
  if (/outstanding\s+invoices?/i.test(subStripped)) return true;
  if (/expected\s+payment\s+date/i.test(subStripped)) return true;
  if (/payment\s+reminder/i.test(subStripped) &&
      /outstanding|overdue|past\s+due/i.test(subStripped)) return true;
  if (subjectLooksLikeLoadNumberReply(sub) &&
      bodyLooksLikeLoadPaymentFollowUp(body)) {
    return true;
  }
  if (senderDomainLooksLikeFactor(from) &&
      /\b(?:payment|paid|pay)\b/.test(hay) &&
      (/\bload\b/.test(hay) || /\bstatus\b/.test(hay) ||
       /\bupdate\b/.test(hay))) {
    return true;
  }
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
 * @param {string} filename Attachment filename.
 * @return {boolean}
 */
function attachmentLooksLikeStatementSpreadsheet(filename, mimeType) {
  const name = String(filename || "").toLowerCase();
  const mime = String(mimeType || "").toLowerCase();
  if (/premium|redkik|insurance/i.test(name)) return false;
  if (/\.(?:xlsx?|xlsm|csv)$/i.test(name)) return true;
  if (/spreadsheet|excel|ms-excel|csv/i.test(mime)) return true;
  return false;
}

/**
 * Spreadsheet filename for an overdue/statement list (not a freight bill).
 * @param {string} filename Attachment filename.
 * @return {boolean}
 */
function attachmentFilenameLooksLikeStatementList(filename) {
  const name = String(filename || "").toLowerCase();
  if (!attachmentLooksLikeStatementSpreadsheet(name, "")) return false;
  if (/statement|stmt|aging|past.?due|overdue|open.?invoice|account/i
      .test(name)) {
    return true;
  }
  // e.g. overdue_invoices.xls — list workbook, not a carrier freight bill.
  if (/invoices?\.(?:xlsx?|xlsm|csv)$/i.test(name)) return true;
  return false;
}

/**
 * Subject like "1467163 INNOVATIVE CARRIERS INC" (account # + company).
 * @param {string} subject Email subject.
 * @return {boolean}
 */
function subjectLooksLikeCarrierAccountStatement(subject) {
  const sub = String(subject || "").trim();
  const stripped = sub.replace(/^(?:(?:re|fw|fwd):\s*)+/i, "").trim();
  if (/^\d{5,10}\s+[A-Z0-9][A-Z0-9\s&.,'-]{3,}(?:INC|LLC|CORP|CO\.?|LTD|L\.?L\.?C\.?)\.?\s*$/i
      .test(stripped)) {
    return true;
  }
  if (/\bstatement\s+of\s+account\b/i.test(stripped)) return true;
  if (/\baccount\s+statement\b/i.test(stripped)) return true;
  if (/\boverdue\s+(?:invoice|account|balance)\b/i.test(stripped)) {
    return true;
  }
  return false;
}

/**
 * Body text for carrier overdue-invoice / statement follow-up.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function bodyLooksLikeOverdueInvoiceFollowUp(body) {
  const hay = String(body || "").toLowerCase();
  const patterns = [
    /\boverdue\s+invoices?\b/,
    /\boutstanding\s+invoices?\b/,
    /\bunpaid\s+invoices?\b/,
    /\bpast[\s-]due\s+invoices?\b/,
    /\bfollow(?:ing)?\s+up\s+on\s+(?:overdue|outstanding|unpaid|past[\s-]due)\b/,
    /\bstatement\s+of\s+account\b/,
    /\baccount\s+statement\b/,
    /\battached\s+(?:is\s+)?(?:your\s+)?statement\b/,
    /\bplease\s+(?:provide|send)\s+(?:payment\s+)?(?:information|details|status)\b/,
    /\bpayment\s+information\s+or\s+(?:an?\s+)?explanation\b/,
    /\btotal(?:ing)?\s+\$[\d,]+(?:\.\d{2})?\s+(?:in\s+)?overdue\b/,
    /\bamount\s+(?:due|overdue|outstanding)\b/,
  ];
  return patterns.some((re) => re.test(hay));
}

/**
 * Carrier account statement or overdue-invoice follow-up — not a freight
 * invoice to enter (Lisa: ignore when Abe is on CC, else forward to Abe).
 * @param {string} subject Email subject.
 * @param {string} from From header.
 * @param {string} body Plain body.
 * @param {Array<object>} [attachments] Attachment metadata.
 * @return {boolean}
 */
function isCarrierStatementFollowUpEmail(subject, from, body, attachments) {
  if (isCustomerPaymentRemittanceEmail(subject, from, body)) return false;
  if (looksLikeInvoiceEmailContent(subject, body)) return false;
  if (looksLikeNoaEmailContent(subject, body, from)) return false;

  const hay = `${subject || ""}\n${from || ""}\n${body || ""}`.toLowerCase();
  if (/redkik|insurance premium|premium breakdown|cargo insurance billing/i
      .test(hay)) {
    return false;
  }

  const list = Array.isArray(attachments) ? attachments : [];
  const hasSpreadsheet = list.some((a) =>
    attachmentLooksLikeStatementSpreadsheet(a.filename, a.mimeType));
  const hasStatementListFile = list.some((a) =>
    attachmentFilenameLooksLikeStatementList(a.filename));
  const subMatch = subjectLooksLikeCarrierAccountStatement(subject);
  const bodyMatch = bodyLooksLikeOverdueInvoiceFollowUp(body);

  if (hasSpreadsheet && (subMatch || bodyMatch || hasStatementListFile)) {
    return true;
  }
  if (bodyMatch && (subMatch || hasSpreadsheet || hasStatementListFile)) {
    return true;
  }
  if (subMatch && bodyMatch) return true;
  return false;
}

/**
 * Statement follow-up handler — only when no freight invoice PDF to process.
 * @param {string} subject Email subject.
 * @param {string} from From header.
 * @param {string} body Plain body.
 * @param {Array<object>} [attachments] Attachment metadata.
 * @param {number} [invoicePdfCount] Invoice PDFs after doc classification.
 * @return {boolean}
 */
function shouldHandleCarrierStatementFollowUp(
    subject, from, body, attachments, invoicePdfCount) {
  if (Number(invoicePdfCount) > 0) return false;
  return isCarrierStatementFollowUpEmail(subject, from, body, attachments);
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
  // "Re: Invoice for BOL#265028" — no invoice number in subject
  if (/^(?:(?:re|fw|fwd):\s*)+invoice\s+for\s+(?:bol|load)\s*#?\s*\d{5,9}/
      .test(sub)) {
    return true;
  }
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
      /(?:your\s+)?(?:po|purchase\s+order)\s*#?\s*\d{5,9}/i.test(sub)) {
    return true;
  }
  // Thunder Funding and similar factors: "Invoice for processing; Invoice #299 …"
  if (/invoice\s+for\s+processing/i.test(sub) &&
      /\binvoice\s+#?\s*\d+/i.test(sub)) {
    return true;
  }
  // Single Point Capital: "Single Point Capital; Invoice #265914"
  if (/singlepointgroup\.com/i.test(content) &&
      /\binvoice\s+#?\s*\d+/i.test(sub)) {
    return true;
  }
  if (/single\s+point\s+capital/i.test(content) &&
      /\binvoice\s+#?\s*\d+/i.test(sub)) {
    return true;
  }
  // Factor-name prefix subjects: "Factor Name; Invoice #123"
  if (/;\s*invoice\s+#?\s*\d+/i.test(sub)) {
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
  // Internal forwards: FW: REF# 264969 where nested body mentions invoice.
  if (/^(?:(?:fw|fwd|re):\s*)+ref#\s*\d{5,9}\b/.test(sub) &&
      /\binvoice\b/.test(content)) {
    return true;
  }
  // Factor/carrier invoice notification in body (e.g. RM Capital for ref #).
  if (/\b(?:sent|attached|forwarding)\s+(?:an?\s+)?invoice\b/.test(content) &&
      /\b(?:ref(?:erence)?|load|bol|po)\s*#?\s*\d{5,9}/.test(content)) {
    return true;
  }
  if (/\binvoice\b/.test(content) &&
      /\bfor\s+(?:ref(?:erence)?|load)\s*#?\s*\d{5,9}/.test(content)) {
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
  // Factor NOA packages often use bare MC# as the entire subject.
  if (subjectLooksLikeMcNumberNoa(subject)) return true;
  // FactorView / Surety-style remittance notices (not freight invoices).
  if (/^\s*(?:(?:fw|fwd|re):\s*)*remit\s+for\s+payment\b/i.test(sub)) {
    return true;
  }
  if (/\bnoa\b/.test(content) || content.includes("notice of assignment")) {
    return true;
  }
  // Factoring release letters (e.g. Phoenix Capital "Letter of Release").
  if (/letter\s+of\s+release\b/i.test(content)) {
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
  const factorDomains = [
    "factorview.com",
    "phoenixcapitalgroup.com",
    "vtflog.com",
  ];
  if (factorDomains.some((d) => fromL.includes(d)) &&
      /remit|assignment|factor(?:ing)?|funding|surety|letter\s+of\s+release/i
          .test(content)) {
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
  if (/noa|notice.?of.?assignment|letter.?of.?release/.test(name)) {
    return false;
  }
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
  return /noa|notice.?of.?assignment|letter.?of.?release|assignment|remit.?to/
      .test(name);
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

  // Remittances forward to Abe even when subject/body cite invoice/BOL #s.
  if (isCustomerPaymentRemittanceEmail(subject, from, body)) {
    return false;
  }

  if (looksLikeInvoiceEmailContent(subject, body)) return true;

  if (shouldIgnoreAsPaymentReceipt(subject, from, body, attachments)) {
    return false;
  }

  const list = Array.isArray(attachments) ? attachments : [];
  if (list.some((a) =>
    attachmentFilenameLooksLikeStatementList(a.filename))) {
    return true;
  }

  if (isPaymentInquiryEmail(subject, from, body)) {
    return false;
  }

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
    if (isPaymentInquiryEmail(subject, from, body)) {
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
  if (isAmexMerchantSurveyEmail(subject, from, body)) {
    return {
      ignore: true,
      reason: "AmEx merchant satisfaction survey — no action needed",
      status: "amex_merchant_survey_ignored",
    };
  }
  if (isDnbPromotionalEmail(subject, from, body)) {
    return {
      ignore: true,
      reason: "D&B promotional / marketing email — no action needed",
      status: "dnb_promotional_ignored",
    };
  }
  if (isCofaceEmail(from, subject, body)) {
    return {
      ignore: true,
      reason: "Coface newsletter/marketing — no action needed",
      status: "coface_ignored",
    };
  }
  if (isOutOfOfficeAutoReply(subject, from, body)) {
    return {
      ignore: true,
      reason: "Out of office auto-reply — no action needed",
      status: "out_of_office_ignored",
    };
  }
  if (shouldIgnoreAsPaymentReceipt(subject, from, body, attachments)) {
    return {
      ignore: true,
      reason: "Payment receipt — not a carrier freight invoice",
      status: "payment_receipt_ignored",
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
  CUSTOMER_PAYMENT_REMITTANCE_EMAIL_DEFAULT,
  parseEmailAddressesFromHeaderValue,
  resolveStatementAbeEmail,
  isAbeCopiedOnEmailHeaders,
  isEmodalBroadcast,
  isCardknoxBatchReport,
  looksLikeDnbCreditAlert,
  isDnbPromotionalEmail,
  isPromotionalMarketingEmail,
  isCofaceEmail,
  isCofaceDomain,
  isOutOfOfficeAutoReply,
  isAmexMerchantSurveyEmail,
  isHafstaffSender,
  isCarrierOrFactorSender,
  subjectLooksLikeCustomerPaymentDate,
  subjectLooksLikeCustomerCheckNumber,
  subjectLooksLikeRemittanceAdvice,
  subjectLooksLikeInvoiceForBolReply,
  bodyLooksLikeCustomerPaidNotice,
  subjectLooksLikeMcNumberNoa,
  isCustomerPaymentRemittanceEmail,
  shouldHandleCustomerPaymentRemittance,
  isBankOfAmericaSender,
  isPaymentNotificationEmail,
  isPaymentReceiptEmail,
  shouldIgnoreAsPaymentNotification,
  shouldIgnoreAsPaymentReceipt,
  isPaymentInquiryEmail,
  shouldHandlePaymentInquiry,
  attachmentLooksLikeStatementSpreadsheet,
  attachmentFilenameLooksLikeStatementList,
  subjectLooksLikeCarrierAccountStatement,
  bodyLooksLikeOverdueInvoiceFollowUp,
  isCarrierStatementFollowUpEmail,
  shouldHandleCarrierStatementFollowUp,
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
