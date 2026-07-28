/**
 * Inbound emails asking us to send a POD (not delivering one).
 */
"use strict";

/**
 * @param {string} subject Email subject.
 * @param {string} body Email body.
 * @return {boolean}
 */
function looksLikePodRequest(subject, body) {
  const hay = `${subject || ""}\n${body || ""}`;
  const askForPod =
    /(?:send|need|request|get|provide|copy of|looking for|where is)/i
        .test(hay) &&
    /(?:pod|proof of delivery|p\.?o\.?d\.?)/i.test(hay);
  const podForLoad =
    /(?:pod|proof of delivery).{0,60}(?:for|on|regarding|re:?)\s*#?\s*/i
        .test(hay) && /(?:load|bol)/i.test(hay);
  const loadNeedsPod =
    /(?:load|bol|shipment).{0,60}(?:pod|proof of delivery)/i.test(hay);
  return askForPod || podForLoad || loadNeedsPod;
}

/**
 * @param {string} subject Email subject.
 * @param {string} body Email body.
 * @return {boolean}
 */
function looksLikeSignedPodRequest(subject, body) {
  const hay = `${subject || ""}\n${body || ""}`.toLowerCase();
  return /signed\s+(?:pod|bol|bill of lading)/.test(hay) ||
    /(?:pod|bol).{0,30}with\s+signature/.test(hay) ||
    /fully\s+signed\s+(?:pod|bol)/.test(hay) ||
    /(?:pod|bol).{0,30}signed\s+by/.test(hay);
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
 * @param {string} subject Subject.
 * @param {string} body Body.
 * @param {string} intent Classifier intent.
 * @return {boolean}
 */
function isPodRequestEmail(subject, body, intent) {
  if (intent === "pod_request") return true;
  return looksLikePodRequest(subject, body);
}

module.exports = {
  looksLikePodRequest,
  looksLikeSignedPodRequest,
  parseEmailAddressFromHeader,
  isPodRequestEmail,
};
