/**
 * TL / Power Only POD helpers:
 *  - business-day math for carrier chase (every 3bd × 3 reminders → Lisa)
 *  - JPEG/PNG → multi-page PDF for trailer-image PODs
 *  - carrier POD-request email HTML
 *
 * Business days = Mon–Fri only (no holiday calendar).
 */

"use strict";

const {PDFDocument} = require("pdf-lib");

const LISA_EMAIL = "Lisa@innovativecarriers.com";
const SARAH_EMAIL = "Sarah@innovativecarriers.com";

const POD_FOLLOW_UP_STATUS = Object.freeze({
  AWAITING_CARRIER: "awaiting_carrier",
  REMINDED: "reminded",
  ESCALATED: "escalated",
  RESOLVED: "resolved",
});

/**
 * @param {string} text Raw text.
 * @return {string}
 */
function esc(text) {
  return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}

/**
 * True when a Date falls on Sat/Sun (UTC date parts — callers should pass
 * local-ish Date objects; we use getUTC* so Cloud Function TZ is stable).
 * @param {Date} d Date.
 * @return {boolean}
 */
function isWeekendUtc(d) {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Counts Mon–Fri business days strictly after `from` up to (and including)
 * `to` calendar day in UTC. Same-day = 0.
 * @param {Date|string|number} from Start (first email time).
 * @param {Date|string|number} [to] End (default now).
 * @return {number}
 */
function businessDaysBetween(from, to) {
  const start = new Date(from);
  const end = to != null ? new Date(to) : new Date();
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
    return 0;
  }
  // Normalize to UTC midnight of the day after start.
  const cursor = new Date(Date.UTC(
      start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1));
  const endDay = new Date(Date.UTC(
      end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  let count = 0;
  while (cursor <= endDay) {
    if (!isWeekendUtc(cursor)) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

/** Minimum bytes for a JPEG/PNG POD saved with an invoice email. */
const MIN_POD_IMAGE_BYTES = 5000;

/** Legacy floor for standalone trailer / POD-only image replies. */
const MIN_TRAILER_IMAGE_BYTES = 50000;

/**
 * @param {object} attachment Attachment meta {mimeType, filename}.
 * @param {Buffer} buffer File bytes.
 * @return {boolean} True when bytes look like JPEG/PNG/WebP image data.
 */
function looksLikePodImageBytes(attachment, buffer) {
  if (!buffer || !buffer.length) return false;
  const mime = String((attachment && attachment.mimeType) || "").toLowerCase();
  const name = String((attachment && attachment.filename) || "").toLowerCase();
  if (mime === "image/jpeg" || mime === "image/jpg" || mime === "image/png") {
    return true;
  }
  if (mime === "image/webp") return true;
  if (/\.(jpe?g|png|webp)$/i.test(name)) return true;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true;
  }
  if (buffer[0] === 0x89 && buffer[1] === 0x50 &&
      buffer[2] === 0x4e && buffer[3] === 0x47) {
    return true;
  }
  return false;
}

/**
 * @param {object} attachment Attachment meta {mimeType, filename}.
 * @param {Buffer} buffer File bytes.
 * @param {object} [opts] Options.
 * @param {number} [opts.minBytes] Minimum file size (default 5KB).
 * @return {boolean} True for JPEG/PNG POD image candidates.
 */
function isPodImageAttachment(attachment, buffer, opts) {
  const minBytes = (opts && opts.minBytes != null) ?
    Number(opts.minBytes) : MIN_POD_IMAGE_BYTES;
  if (!buffer || buffer.length < minBytes) return false;
  return looksLikePodImageBytes(attachment, buffer);
}

/**
 * @param {object} attachment Attachment meta {mimeType, filename}.
 * @param {Buffer} buffer File bytes.
 * @return {boolean} True for trailer-image candidates (size floor ~50KB).
 */
function isTrailerImageAttachment(attachment, buffer) {
  return isPodImageAttachment(attachment, buffer, {
    minBytes: MIN_TRAILER_IMAGE_BYTES,
  });
}

/**
 * @param {object} attachment Attachment meta.
 * @param {Buffer} buffer File bytes.
 * @return {string} Normalized mime for storage / pdf-lib.
 */
function detectImageMime(attachment, buffer) {
  const mime = String((attachment && attachment.mimeType) || "").toLowerCase();
  if (mime === "image/png" || mime === "image/jpeg" || mime === "image/jpg") {
    return mime === "image/jpg" ? "image/jpeg" : mime;
  }
  const name = String((attachment && attachment.filename) || "").toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  return "image/jpeg";
}

/**
 * Embeds JPEG/PNG buffers into a multi-page PDF. Skips unsupported formats
 * (e.g. webp) rather than failing the whole batch.
 * @param {Array<object>} images Items with buffer, mimeType, filename.
 * @return {Promise<object>} {ok, pdfBuffer, skipped, pageCount, error}
 */
async function imagesToPodPdf(images) {
  const skipped = [];
  const list = Array.isArray(images) ? images : [];
  if (!list.length) {
    return {ok: false, skipped, pageCount: 0, error: "no images"};
  }
  try {
    const pdf = await PDFDocument.create();
    let pages = 0;
    for (const img of list) {
      const buf = img && img.buffer;
      if (!buf || !buf.length) continue;
      const mime = String(img.mimeType || "").toLowerCase();
      let embedded = null;
      try {
        if (mime === "image/png") {
          embedded = await pdf.embedPng(buf);
        } else if (mime === "image/jpeg" || mime === "image/jpg") {
          embedded = await pdf.embedJpg(buf);
        } else {
          // Try JPEG then PNG by magic.
          if (buf[0] === 0xff && buf[1] === 0xd8) {
            embedded = await pdf.embedJpg(buf);
          } else if (buf[0] === 0x89 && buf[1] === 0x50) {
            embedded = await pdf.embedPng(buf);
          } else {
            skipped.push(img.filename || mime || "unknown");
            continue;
          }
        }
      } catch (_) {
        skipped.push(img.filename || mime || "unknown");
        continue;
      }
      const page = pdf.addPage([embedded.width, embedded.height]);
      page.drawImage(embedded, {
        x: 0, y: 0, width: embedded.width, height: embedded.height,
      });
      pages++;
    }
    if (pages === 0) {
      return {
        ok: false, skipped, pageCount: 0,
        error: "no embeddable JPEG/PNG images",
      };
    }
    const pdfBuffer = Buffer.from(await pdf.save());
    return {ok: true, pdfBuffer, skipped, pageCount: pages};
  } catch (err) {
    return {
      ok: false, skipped, pageCount: 0,
      error: err.message || String(err),
    };
  }
}

/**
 * Resolves a carrier/vendor email from a Primus booking.
 * @param {object|null} booking Primus booking.
 * @return {object} {email, source}
 */
function resolveCarrierEmail(booking) {
  if (!booking || typeof booking !== "object") {
    return {email: null, source: null};
  }
  const vendor = booking.vendor || {};
  const candidates = [
    [vendor.email, "vendor.email"],
    [vendor.mailEmail, "vendor.mailEmail"],
    [vendor.contactEmail, "vendor.contactEmail"],
    [vendor.billingEmail, "vendor.billingEmail"],
  ];
  const contact = vendor.contact || vendor.contactInformation || null;
  if (contact && typeof contact === "object") {
    candidates.push([contact.email, "vendor.contact.email"]);
  }
  for (const [raw, source] of candidates) {
    const email = String(raw || "").trim();
    if (email && email.includes("@")) {
      // May be comma-separated — take first.
      const first = email.split(/[,;]/)[0].trim();
      if (first.includes("@")) return {email: first, source};
    }
  }
  return {email: null, source: null};
}

/**
 * Builds the carrier POD-request email.
 * @param {object} opts loadNumber, carrierName, proNumber, invoiceNumber,
 *   isReminder.
 * @return {{subject: string, html: string}}
 */
function buildCarrierPodRequestEmail(opts) {
  const {
    loadNumber, carrierName, proNumber, invoiceNumber, isReminder,
  } = opts || {};
  const subject = (isReminder ? "Reminder: " : "") +
    `POD needed — Load ${loadNumber || "—"}` +
    (proNumber ? ` / PRO ${proNumber}` : "");
  const html =
    `<p>Hello${carrierName ? ` ${esc(carrierName)}` : ""},</p>` +
    `<p>${isReminder ?
      "This is a reminder that we still need" :
      "We are processing your invoice and still need"} ` +
    `a <strong>Proof of Delivery (POD)</strong> for the load below.</p>` +
    `<table style="border-collapse:collapse;font-size:14px;margin:12px 0">` +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">Load / BOL</td>` +
    `<td>${esc(String(loadNumber || "—"))}</td></tr>` +
    (proNumber ?
      `<tr><td style="padding:4px 16px 4px 0;font-weight:600">PRO</td>` +
      `<td>${esc(String(proNumber))}</td></tr>` : "") +
    (invoiceNumber ?
      `<tr><td style="padding:4px 16px 4px 0;font-weight:600">` +
      `Your invoice #</td><td>${esc(String(invoiceNumber))}</td></tr>` : "") +
    `</table>` +
    `<p>Please reply to this email with the signed POD (PDF or clear ` +
    `photos of the delivery / trailer paperwork). Do not attach a new ` +
    `invoice — only the POD.</p>` +
    `<p>Thank you,<br>Innovative Carriers — Accounting</p>`;
  return {subject, html};
}

/**
 * Lisa escalation email when carrier never sent a POD after 3 reminders.
 * @param {object} opts loadNumber, carrierName, proNumber, carrierEmail,
 *   businessDays, reminderCount, invoiceId.
 * @return {{subject: string, html: string}}
 */
function buildTlPodEscalationEmail(opts) {
  const {
    loadNumber, carrierName, proNumber, carrierEmail, businessDays,
    reminderCount,
  } = opts || {};
  const reminders = reminderCount != null ? Number(reminderCount) : 3;
  const subject =
    `Escalation — no POD after ${reminders} carrier reminders — ` +
    `Load ${loadNumber || "—"}`;
  const html =
    `<p>Hi Lisa,</p>` +
    `<p>Jerry requested a POD from the carrier on this <strong>truckload` +
    `</strong> invoice and followed up every 3 business days. After ` +
    `<strong>${esc(String(reminders))} reminders</strong> ` +
    `(~${esc(String(businessDays || "—"))} business days open) the POD ` +
    `is still not in Primus and the carrier has not replied.</p>` +
    `<table style="border-collapse:collapse;font-size:14px;margin:12px 0">` +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">Load / BOL</td>` +
    `<td>${esc(String(loadNumber || "—"))}</td></tr>` +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">Carrier</td>` +
    `<td>${esc(carrierName || "—")}</td></tr>` +
    (proNumber ?
      `<tr><td style="padding:4px 16px 4px 0;font-weight:600">PRO</td>` +
      `<td>${esc(String(proNumber))}</td></tr>` : "") +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">` +
    `Carrier email</td><td>${esc(carrierEmail || "—")}</td></tr>` +
    `</table>` +
    `<p>The customer invoice email is still held. Please follow up with ` +
    `the carrier or supply the POD so Jerry can finish.</p>`;
  return {subject, html};
}

module.exports = {
  LISA_EMAIL,
  SARAH_EMAIL,
  POD_FOLLOW_UP_STATUS,
  MIN_POD_IMAGE_BYTES,
  MIN_TRAILER_IMAGE_BYTES,
  businessDaysBetween,
  isPodImageAttachment,
  isTrailerImageAttachment,
  detectImageMime,
  imagesToPodPdf,
  resolveCarrierEmail,
  buildCarrierPodRequestEmail,
  buildTlPodEscalationEmail,
};
