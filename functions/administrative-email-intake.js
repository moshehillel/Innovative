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
 * @param {string} subject Email subject.
 * @param {string} from From header.
 * @param {string} body Plain body.
 * @return {boolean}
 */
function isRtsNoaEmail(subject, from, body) {
  const hay = `${subject || ""}\n${from || ""}\n${body || ""}`.toLowerCase();
  const fromRts = hay.includes("rtsinc.com") ||
    hay.includes("rts financial") ||
    hay.includes("noa@rts");
  const aboutNoa = /\bnoa\b/.test(hay) ||
    hay.includes("notice of assignment");
  return fromRts && aboutNoa;
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
 * True when RTS NOA email attachments (by filename) look like NOA only.
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
  if (isRtsNoaEmail(subject, from, body) &&
      rtsNoaAttachmentsLookNoaOnly(attachments)) {
    return {
      ignore: true,
      reason: "RTS Notice of Assignment only — no carrier invoice",
      status: "rts_noa_ignored",
    };
  }
  return {ignore: false, reason: null, status: null};
}

module.exports = {
  isEmodalBroadcast,
  isRtsNoaEmail,
  attachmentFilenameLooksLikeInvoice,
  attachmentFilenameLooksLikeNoa,
  rtsNoaAttachmentsLookNoaOnly,
  evaluateAdministrativeIgnore,
};
