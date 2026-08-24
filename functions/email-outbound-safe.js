/**
 * ASCII-safe outbound email text helpers.
 * Primus manage.php and some MIME paths mis-decode UTF-8 punctuation
 * (em dash, smart quotes) as Latin-1/Windows-1252 mojibake (â€", â€™, etc.).
 */
"use strict";

/**
 * Replaces common UTF-8 punctuation that often becomes â€ / â€™ in inboxes.
 * Leaves other Unicode alone (HTML bodies may still need accents).
 * @param {*} value Raw subject or body fragment.
 * @return {string}
 */
function toOutboundEmailSafeText(value) {
  return String(value == null ? "" : value)
      .replace(/\s*[\u2014\u2013\u2012\u2212]\s*/g, " - ")
      .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
      .replace(/[\u201C\u201D\u201E\u2033]/g, "\"")
      .replace(/\u2026/g, "...")
      .replace(/\u00A0/g, " ")
      .replace(/\u00AE/g, "(R)")
      .replace(/\u2122/g, "(TM)");
}

/**
 * Subject-safe: punctuation fold + strip remaining non-ASCII so Primus /
 * raw MIME Subject headers never emit â€ mojibake.
 * @param {*} value Raw subject.
 * @return {string}
 */
function toOutboundEmailSafeSubject(value) {
  return toOutboundEmailSafeText(value)
      .replace(/[^\t\x20-\x7E]/g, "")
      .replace(/ {2,}/g, " ")
      .trim();
}

module.exports = {
  toOutboundEmailSafeText,
  toOutboundEmailSafeSubject,
};
