/**
 * Inbound emails asking us to send a POD (not delivering one).
 */
"use strict";

/** Classifier intents that are never auto POD-send requests. */
const NON_POD_REQUEST_INTENTS = new Set([
  "carrier_invoice",
  "insurance_premium",
  "statement",
  "quote_request",
  "pod_delivery",
]);

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
 * @param {string} subject Email subject.
 * @param {string} body Email body.
 * @return {boolean}
 */
function looksLikePodRequest(subject, body) {
  const hay = stripQuotedReplyNoise(
      `${subject || ""}\n${body || ""}`,
  );
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
  const hay = stripQuotedReplyNoise(
      `${subject || ""}\n${body || ""}`,
  ).toLowerCase();
  return /signed\s+(?:pod|bol|bill of lading)/.test(hay) ||
    /(?:pod|bol).{0,30}with\s+signature/.test(hay) ||
    /fully\s+signed\s+(?:pod|bol)/.test(hay) ||
    /(?:pod|bol).{0,30}signed\s+by/.test(hay);
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
 * @param {string} subject Subject.
 * @param {string} body Body.
 * @param {string} intent Classifier intent.
 * @param {object} [emailClassification] Full classifier result (preferred).
 * @return {boolean}
 */
function isPodRequestEmail(subject, body, intent, emailClassification) {
  if (intent === "pod_request") return true;
  const classification = emailClassification ||
    (intent ? {intent} : null);
  if (aiRejectsPodRequest(classification)) return false;
  return looksLikePodRequest(subject, body);
}

module.exports = {
  NON_POD_REQUEST_INTENTS,
  stripQuotedReplyNoise,
  looksLikePodRequest,
  looksLikeSignedPodRequest,
  aiRejectsPodRequest,
  parseEmailAddressFromHeader,
  isPodRequestEmail,
};
