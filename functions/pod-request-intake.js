/**
 * Inbound emails asking us to send a POD (not delivering one).
 *
 * Read the email the way a person would: subject, who it is from, and
 * what they are actually asking. One word ("get", "getting", "POD",
 * "proof of delivery") is never enough. Alert or auto-send only when
 * the email as a whole is asking for the POD, BOL, or delivery receipt
 * ("please send / forward / provide" it, or "please get me the POD").
 * A dispute note that cites an existing POD, plus a Salesforce footer,
 * is not a request. No-reply mail that is not asking does not alert
 * Lisa and does not get an auto-sent POD.
 */
"use strict";

const podSendDedup = require("./pod-send-dedup");

/** Classifier intents that are never auto POD-send requests. */
const NON_POD_REQUEST_INTENTS = new Set([
  "carrier_invoice",
  "insurance_premium",
  "statement",
  "quote_request",
  "pod_delivery",
]);

/**
 * POD, BOL, or delivery receipt as a whole phrase. "pod" must not match
 * inside podium/podcast, and "bol" must not match inside bold.
 */
const DOCUMENT =
  "proof of delivery|delivery receipts?|bills? of lading|" +
  "p\\.?\\s*o\\.?\\s*d\\.?|pods?|bols?";

const DOCUMENT_WORD = `(?:${DOCUMENT})`;

/** Words that may sit between an ask verb and the document name. */
const ASK_FILLER =
  "(?:\\s+(?:me|us|over|along|a|an|the|our|your|this|that|" +
  "signed|copy of|a copy of))*";

const POLITE =
  "please|kindly|can you|could you|would you|can we|could we";

const SEND_VERB = "send|forward|provide|email|resend";

const NEED_VERB =
  "need|needs|request|requesting|requested|looking for|where is|" +
  "where's|copy of";

/** "not send the POD" is a refusal, not an ask. */
const NOT_BEFORE = "(?<!\\b(?:not|never|cannot|without)\\s+)";

/**
 * The document is what the sentence is asking for. A bare "get" or
 * "getting" somewhere else in the email is not an ask. "Please get me
 * the POD" is a whole-sentence request, so it counts.
 */
const DOCUMENT_ASK = new RegExp(
    `(?:${NOT_BEFORE}(?:${POLITE})\\s+)?` +
    `${NOT_BEFORE}\\b(?:${SEND_VERB})\\b${ASK_FILLER}\\s+` +
    `\\b${DOCUMENT_WORD}\\b` +
    `|${NOT_BEFORE}(?:${POLITE})\\s+get\\b` +
    `(?:\\s+(?:me|us))?${ASK_FILLER}\\s+` +
    `\\b${DOCUMENT_WORD}\\b` +
    `|${NOT_BEFORE}\\b(?:${NEED_VERB})\\b` +
    `(?:\\s+to\\s+(?:see|get|have|receive))?` +
    `${ASK_FILLER}\\s+\\b${DOCUMENT_WORD}\\b` +
    `|\\b${DOCUMENT_WORD}\\b(?:\\s+\\S+){0,8}\\s+\\bsend\\s+` +
    `(?:me\\s+|us\\s+)?(?:a\\s+)?copy\\b` +
    `(?!\\s+of\\s+(?:the\\s+|a\\s+)?(?!${DOCUMENT_WORD}\\b))`,
    "i",
);

/** "Can you send it?" counts only when the email also names a document. */
const POLITE_SEND_PRONOUN = new RegExp(
    `\\b(?:${POLITE})\\s+(?:${SEND_VERB})\\b` +
    `(?:\\s+(?:me|us|over|along))?\\s+` +
    `(?:it|this|that|these|those|one|a copy|the copy)\\b`,
    "i",
);

const DOCUMENT_MENTION = new RegExp(`\\b${DOCUMENT_WORD}\\b`, "i");

/**
 * Naming an existing document as evidence. These mentions are not asks.
 */
const DOCUMENT_CITATION = new RegExp(
    "\\b(?:per|as per|according to|based on|pursuant to)\\s+" +
    `(?:the\\s+|our\\s+|your\\s+|this\\s+)?${DOCUMENT_WORD}\\b` +
    `|\\battached\\s+(?:the\\s+)?${DOCUMENT_WORD}\\b` +
    `|\\b${DOCUMENT_WORD}\\b\\s+(?:shows|showed|states|confirms|` +
    "confirmed|indicates|says|reflects|is attached|attached|" +
    "is on file|on file)\\b" +
    "|\\binside\\s+deliver\\w*\\b[\\s\\S]{0,80}?" +
    `\\b${DOCUMENT_WORD}\\b`,
    "i",
);

const SIGNED_DOCUMENT = new RegExp(
    "\\bsigned\\s+(?:pods?|bols?|bill of lading)\\b|" +
    "\\b(?:pods?|bols?)\\b.{0,30}\\bwith\\s+signature\\b|" +
    "\\bfully\\s+signed\\s+(?:pods?|bols?)\\b|" +
    "\\b(?:pods?|bols?)\\b.{0,30}\\bsigned\\s+by\\b",
    "i",
);

/**
 * Drops quoted reply / signature blocks so heuristics do not match
 * boilerplate like "If POD is signed clear…" in a prior signature.
 * @param {string} text Subject or body.
 * @return {string}
 */
function stripQuotedReplyNoise(text) {
  let t = String(text || "");
  t = t.split(/\nOn .+wrote:\s*\n/i)[0];
  t = t.split(/\n-{2,}\s*\nOriginal Message\b/i)[0];
  t = t.split(/\nFrom:\s+.+\nSent:\s+/i)[0];
  t = t.split(/\n_{5,}\s*\n/)[0];
  t = t.split(/\n--\s*\n/)[0];
  t = t.split("\n")
      .filter((line) => !/^\s*>/.test(line))
      .join("\n");
  return t;
}

/**
 * Salesforce / Unishippers notification chrome is never the ask.
 * @param {string} text Subject plus body.
 * @return {string}
 */
function stripPortalNotificationBoilerplate(text) {
  let t = String(text || "");
  t = t.replace(
      /are notifications about this post getting annoying\??/ig,
      " ",
  );
  t = t.replace(
      /\bview\s*\/\s*comment(?:\s+or\s+reply to this email)?/ig,
      " ",
  );
  t = t.replace(/\bdownload\s*\(\s*png\s*\)/ig, " ");
  t = t.replace(/\bcase\s*:\s*\d+\b/ig, " ");
  return t;
}

/**
 * @param {string} subject Email subject.
 * @param {string} body Email body.
 * @return {string}
 */
function podRequestText(subject, body) {
  return stripPortalNotificationBoilerplate(
      stripQuotedReplyNoise(`${subject || ""}\n${body || ""}`),
  );
}

/**
 * @param {string} text Prepared subject plus body.
 * @return {boolean}
 */
function textAsksForDeliveryDocument(text) {
  const hay = String(text || "");
  if (DOCUMENT_ASK.test(hay)) return true;
  return DOCUMENT_MENTION.test(hay) && POLITE_SEND_PRONOUN.test(hay);
}

/**
 * True when the email only cites an existing POD/BOL/delivery receipt.
 * A real "please send the POD" in the same text is still an ask.
 * @param {string} subject Email subject.
 * @param {string} body Email body.
 * @return {boolean}
 */
function isDocumentCitationWithoutAsk(subject, body) {
  const hay = podRequestText(subject, body);
  if (textAsksForDeliveryDocument(hay)) return false;
  return DOCUMENT_CITATION.test(hay);
}

/**
 * @param {string} subject Email subject.
 * @param {string} body Email body.
 * @return {boolean}
 */
function looksLikePodRequest(subject, body) {
  return textAsksForDeliveryDocument(podRequestText(subject, body));
}

/**
 * @param {string} subject Email subject.
 * @param {string} body Email body.
 * @return {boolean}
 */
function looksLikeSignedPodRequest(subject, body) {
  const hay = stripQuotedReplyNoise(
      `${subject || ""}\n${body || ""}`,
  );
  return SIGNED_DOCUMENT.test(hay);
}

/**
 * True when the AI classifier already decided this is not a POD request.
 * Heuristic must not override that (e.g. quoted signature mentioning POD).
 * @param {object|null|undefined} emailClassification Classifier result.
 * @return {boolean}
 */
function aiRejectsPodRequest(emailClassification) {
  if (!emailClassification || typeof emailClassification !== "object") {
    return false;
  }
  const intent = emailClassification.intent;
  if (intent === "pod_request") return false;
  if (intent && NON_POD_REQUEST_INTENTS.has(intent)) return true;

  const reasoning = String(emailClassification.reasoning || "").toLowerCase();
  if (!reasoning || reasoning.includes("classifier unavailable")) {
    return false;
  }
  // Explicit "not POD" / scheduling / appointment language in AI note.
  if (/\bnot\s+(a\s+)?pod(\s+request)?\b/.test(reasoning) ||
      /\bisn'?t\s+(a\s+)?pod\b/.test(reasoning) ||
      /\bno\s+pod\s+request\b/.test(reasoning) ||
      /\bdoes\s+not\s+(ask|request|need).{0,40}\bpod\b/.test(reasoning) ||
      /\bnot\s+asking\s+for\s+(a\s+)?pod\b/.test(reasoning) ||
      /\bschedul(e|ing|ed)\b/.test(reasoning) ||
      /\bappointment\b/.test(reasoning)) {
    return true;
  }
  return false;
}

/**
 * @param {string} fromHeader From header value.
 * @return {string|null}
 */
function parseEmailAddressFromHeader(fromHeader) {
  const raw = String(fromHeader || "").trim();
  if (!raw) return null;
  const bracket = raw.match(/<([^>]+@[^>]+)>/);
  if (bracket) return bracket[1].trim().toLowerCase();
  const plain = raw.match(/([^\s<>]+@[^\s<>]+\.[^\s<>]+)/);
  return plain ? plain[1].trim().toLowerCase() : null;
}

/**
 * No-reply and other system mailboxes are not a person asking us
 * for a document, unless the text itself asks for one.
 * @param {string} fromHeader From header value.
 * @return {boolean}
 */
function senderIsSystemMailbox(fromHeader) {
  const email = parseEmailAddressFromHeader(fromHeader);
  if (!email) return false;
  return podSendDedup.isBlockedPodRecipient(email);
}

/**
 * Whole-email decision: subject, body, and who it is from.
 * A citation, or a no-reply notice that never asks, is not a request
 * even if a classifier labeled it pod_request. A real ask still is.
 * @param {string} subject Subject.
 * @param {string} body Body.
 * @param {string} intent Classifier intent.
 * @param {object} [emailClassification] Full classifier result (preferred).
 * @param {string} [from] From header. Part of the read, not a keyword.
 * @return {boolean}
 */
function isPodRequestEmail(
    subject, body, intent, emailClassification, from) {
  const asking = looksLikePodRequest(subject, body);
  if (isDocumentCitationWithoutAsk(subject, body)) return false;
  if (senderIsSystemMailbox(from) && !asking) return false;
  if (intent === "pod_request") return true;
  const classification = emailClassification ||
    (intent ? {intent} : null);
  if (aiRejectsPodRequest(classification)) return false;
  return asking;
}

module.exports = {
  NON_POD_REQUEST_INTENTS,
  stripQuotedReplyNoise,
  stripPortalNotificationBoilerplate,
  isDocumentCitationWithoutAsk,
  looksLikePodRequest,
  looksLikeSignedPodRequest,
  aiRejectsPodRequest,
  parseEmailAddressFromHeader,
  senderIsSystemMailbox,
  isPodRequestEmail,
};
