/**
 * Mailbox received time and attachment metadata for dashboard tasks
 * and notifications. File bytes live in Cloud Storage or stay on the
 * mailbox message; Firestore only keeps metadata.
 */

"use strict";

const admin = require("firebase-admin");

const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const PEEK_HOLD_MS = 12 * 60 * 60 * 1000;

/**
 * @param {*} value Timestamp, Date, ISO string, or epoch ms.
 * @return {Date|null}
 */
function toDate(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {*} value Timestamp-like value.
 * @return {string|null} ISO time.
 */
function toIso(value) {
  const d = toDate(value);
  return d ? d.toISOString() : null;
}

/**
 * @param {*} value Timestamp-like value.
 * @return {FirebaseFirestore.Timestamp|null}
 */
function toTimestamp(value) {
  const d = toDate(value);
  return d ? admin.firestore.Timestamp.fromDate(d) : null;
}

/**
 * Inbox arrival time. Prefers receivedDateTime. Ignores Outlook metadata
 * internalDate when that field is the read/modified time.
 * @param {object|null} messageData Mail provider message.
 * @return {string|null}
 */
function mailboxReceivedIso(messageData) {
  if (!messageData || typeof messageData !== "object") return null;
  const explicit = messageData.receivedDateTime ||
    messageData.emailReceivedAt || null;
  if (explicit) return toIso(explicit);
  if (messageData.readModifiedDateTime) return null;
  const ms = Number(messageData.internalDate || 0);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return toIso(ms);
}

/**
 * @param {string} value Raw path segment.
 * @param {string} fallback Fallback when empty.
 * @return {string}
 */
function safePathPart(value, fallback) {
  const s = String(value || "")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 80);
  return s || fallback;
}

/**
 * @param {object|null} raw Attachment-like object.
 * @return {object|null}
 */
function sanitizeOne(raw) {
  if (!raw || typeof raw !== "object") return null;
  const filename = String(raw.filename || "attachment").slice(0, 180);
  const mimeType = String(
      raw.mimeType || raw.contentType || "application/octet-stream",
  ).slice(0, 120);
  const sizeNum = Number(raw.size);
  const size = Number.isFinite(sizeNum) && sizeNum > 0 ? sizeNum : null;
  const storagePath = raw.storagePath ?
    String(raw.storagePath).slice(0, 500) : null;
  const gmailMessageId = raw.gmailMessageId ?
    String(raw.gmailMessageId).slice(0, 500) : null;
  const gmailAttachmentId = raw.gmailAttachmentId || raw.attachmentId ?
    String(raw.gmailAttachmentId || raw.attachmentId).slice(0, 800) : null;
  if (!storagePath && !gmailAttachmentId) return null;
  return {
    filename,
    mimeType,
    size,
    storagePath,
    gmailMessageId,
    gmailAttachmentId,
  };
}

/**
 * @param {Array<object>|null} list Raw attachments.
 * @return {Array<object>}
 */
function sanitizeStoredAttachments(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const item = sanitizeOne(raw);
    if (!item) continue;
    const key = `${item.storagePath || ""}|${item.gmailAttachmentId || ""}|` +
      `${item.filename.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= MAX_ATTACHMENTS) break;
  }
  return out;
}

/**
 * @param {Array<object>} primary First list.
 * @param {Array<object>} extra Second list.
 * @return {Array<object>}
 */
function mergeAttachments(primary, extra) {
  const out = sanitizeStoredAttachments(primary);
  const names = new Set(out.map((a) => a.filename.toLowerCase()));
  const paths = new Set(out.map((a) => a.storagePath).filter(Boolean));
  for (const item of sanitizeStoredAttachments(extra)) {
    if (item.storagePath && paths.has(item.storagePath)) continue;
    if (names.has(item.filename.toLowerCase())) continue;
    out.push(item);
    names.add(item.filename.toLowerCase());
    if (item.storagePath) paths.add(item.storagePath);
    if (out.length >= MAX_ATTACHMENTS) break;
  }
  return out;
}

/**
 * Client-safe attachment list. Index matches the stored array.
 * @param {Array<object>|null} list Stored attachments.
 * @return {Array<object>}
 */
function publicAttachments(list) {
  return sanitizeStoredAttachments(list).map((a, index) => ({
    index,
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
  }));
}

/**
 * @param {object} data Create payload.
 * @return {object} Fields to persist. Omits unknown attachment lists.
 */
function fieldsForCreate(data) {
  const src = data || {};
  const fields = {};
  const ts = toTimestamp(src.receivedAt);
  if (ts) {
    fields.receivedAt = ts;
    fields.receivedAtSource = src.receivedAtSource === "logged" ?
      "logged" : "mailbox";
  }
  if (Array.isArray(src.attachments)) {
    fields.attachments = sanitizeStoredAttachments(src.attachments);
  }
  return fields;
}

/**
 * @param {object} d Firestore data.
 * @return {object}
 */
function serializeMailFields(d) {
  const data = d || {};
  const receivedAt = toIso(data.receivedAt);
  return {
    receivedAt,
    receivedAtSource: receivedAt ?
      (data.receivedAtSource || "mailbox") : null,
    attachments: Array.isArray(data.attachments) ?
      publicAttachments(data.attachments) : null,
    mailboxLookupAt: toIso(data.mailboxLookupAt),
  };
}

/**
 * @param {object} bucket Cloud Storage bucket.
 * @param {string} messageId Mailbox message id.
 * @param {number} index File index.
 * @param {string} filename Original filename.
 * @param {string} mimeType MIME type.
 * @param {Buffer} buffer File bytes.
 * @return {Promise<string>} Storage path.
 */
async function saveAttachmentBuffer(
    bucket, messageId, index, filename, mimeType, buffer,
) {
  const path = `dashboardMail/${safePathPart(messageId, "msg")}/` +
    `${index}-${safePathPart(filename, "file")}`;
  await bucket.file(path).save(buffer, {
    metadata: {contentType: mimeType || "application/octet-stream"},
    resumable: false,
  });
  return path;
}

/**
 * Downloads and stores mailbox attachments. Oversized files keep a
 * mailbox attachment id so the download endpoint can fetch them later.
 * @param {object} opts messageId, collected, bucket, download, onError.
 * @return {Promise<Array<object>>}
 */
async function captureMailboxAttachments(opts) {
  const messageId = String(opts.messageId || "");
  const collected = Array.isArray(opts.collected) ? opts.collected : [];
  const bucket = opts.bucket;
  const download = opts.download;
  const out = [];
  let index = 0;
  for (const att of collected) {
    if (out.length >= MAX_ATTACHMENTS) break;
    if (!att || (!att.filename && !att.attachmentId &&
      !att.inlineData && !att.buffer)) {
      continue;
    }
    const filename = String(att.filename || "attachment").slice(0, 180);
    const mimeType = String(att.mimeType || "application/octet-stream")
        .slice(0, 120);
    let size = Number(att.size) || null;
    let storagePath = att.storagePath ? String(att.storagePath) : null;
    const gmailAttachmentId = att.attachmentId ?
      String(att.attachmentId) : null;
    const tooBig = size && size > MAX_ATTACHMENT_BYTES;
    if (!storagePath && !tooBig && typeof download === "function") {
      try {
        const buf = await download(att);
        if (buf && buf.length) {
          size = buf.length;
          if (buf.length <= MAX_ATTACHMENT_BYTES && bucket) {
            storagePath = await saveAttachmentBuffer(
                bucket, messageId, index, filename, mimeType, buf);
          }
        }
      } catch (err) {
        if (typeof opts.onError === "function") opts.onError(err, att);
      }
    }
    if (!storagePath && !gmailAttachmentId) continue;
    out.push({
      filename,
      mimeType,
      size,
      storagePath,
      gmailMessageId: messageId || null,
      gmailAttachmentId,
    });
    index += 1;
  }
  return sanitizeStoredAttachments(out);
}

/**
 * Attachment metadata already stored on an invoice.
 * @param {object|null} inv Invoice data.
 * @param {object} [opts] includePod.
 * @return {Array<object>}
 */
function attachmentsFromInvoice(inv, opts) {
  if (!inv || typeof inv !== "object") return [];
  const includePod = Boolean(opts && opts.includePod);
  const primary = Array.isArray(inv.mailboxAttachments) ?
    inv.mailboxAttachments : (inv.attachments || []);
  const list = sanitizeStoredAttachments(primary);
  if (includePod && inv.podOnlyFile && inv.podOnlyFile.storagePath) {
    const podPath = String(inv.podOnlyFile.storagePath);
    if (!list.some((a) => a.storagePath === podPath)) {
      list.push({
        filename: inv.podOnlyFile.filename || "pod.pdf",
        mimeType: inv.podOnlyFile.mimeType || "application/pdf",
        size: Number(inv.podOnlyFile.size) || null,
        storagePath: podPath,
        gmailMessageId: null,
        gmailAttachmentId: null,
      });
    }
  }
  return list.slice(0, MAX_ATTACHMENTS);
}

/**
 * @param {string} kind task|notification.
 * @param {object} item Listed row.
 * @param {object} collections Collection names.
 * @return {string|null}
 */
function targetCollection(kind, item, collections) {
  const names = collections || {};
  if (kind === "notification") return names.notifications || null;
  if (item && item.source === "additionalCharges") {
    return names.followUps || null;
  }
  return names.tasks || null;
}

/**
 * Fills missing received time and attachments from invoice docs and a
 * bounded mailbox peek. Mutates items. Returns Firestore merges to persist.
 * @param {Array<object>} items Serialized rows.
 * @param {object} opts kind, collections, loadInvoices, peekMailbox,
 *   serverTimestamp, onPeekError, maxPeek.
 * @return {Promise<Array<object>>}
 */
async function backfillListedItems(items, opts) {
  const list = Array.isArray(items) ? items : [];
  const loadInvoices = opts.loadInvoices;
  const peekMailbox = opts.peekMailbox;
  const now = Date.now();
  const maxPeek = Number(opts.maxPeek) || 4;
  const writes = [];
  let peeks = 0;

  const invoiceIds = [];
  for (const item of list) {
    if (!item || !item.invoiceId) continue;
    if (item.receivedAt && Array.isArray(item.attachments)) continue;
    invoiceIds.push(String(item.invoiceId));
  }
  const uniqueIds = [...new Set(invoiceIds)].slice(0, 80);
  const invoices = uniqueIds.length && typeof loadInvoices === "function" ?
    await loadInvoices(uniqueIds) : new Map();

  for (const item of list) {
    if (!item) continue;
    const needsTime = !item.receivedAt;
    let filesComplete = Array.isArray(item.attachments);
    if (!needsTime && filesComplete) continue;

    let receivedAt = null;
    let rawFiles = null;
    let messageId = item.messageId || null;
    const inv = item.invoiceId && invoices && invoices.get ?
      invoices.get(String(item.invoiceId)) : null;
    if (inv) {
      if (needsTime && inv.emailReceivedAt) {
        receivedAt = toIso(inv.emailReceivedAt);
      }
      if (!messageId && inv.gmailMessageId) {
        messageId = String(inv.gmailMessageId);
      }
      if (!filesComplete && Array.isArray(inv.mailboxAttachments)) {
        rawFiles = attachmentsFromInvoice(inv, {
          includePod: item.type === "pod_discrepancy" ||
            item.type === "signed_pod",
        });
        filesComplete = true;
      } else if (!filesComplete) {
        const includePod = item.type === "pod_discrepancy" ||
          item.type === "signed_pod";
        const partial = attachmentsFromInvoice(inv, {includePod});
        if (partial.length) rawFiles = partial;
      }
    }

    const looked = item.mailboxLookupAt ? Date.parse(item.mailboxLookupAt) : 0;
    const onHold = looked && (now - looked) < PEEK_HOLD_MS;
    const stillTime = needsTime && !receivedAt;
    const stillFiles = !filesComplete;
    if ((stillTime || stillFiles) && messageId && !onHold &&
        peeks < maxPeek && typeof peekMailbox === "function") {
      peeks += 1;
      try {
        const peek = await peekMailbox(messageId);
        if (peek && peek.receivedAt && !receivedAt) {
          receivedAt = peek.receivedAt;
        }
        if (peek && peek.missing && !filesComplete && !rawFiles) {
          rawFiles = [];
          filesComplete = true;
        } else if (peek && Array.isArray(peek.attachments)) {
          rawFiles = mergeAttachments(rawFiles || [], peek.attachments);
          filesComplete = true;
        }
      } catch (err) {
        item.mailboxLookupAt = new Date(now).toISOString();
        if (typeof opts.onPeekError === "function") {
          opts.onPeekError(err, item);
        }
      }
    }

    const patch = {};
    if (needsTime && receivedAt) {
      item.receivedAt = receivedAt;
      item.receivedAtSource = "mailbox";
      const ts = toTimestamp(receivedAt);
      if (ts) {
        patch.receivedAt = ts;
        patch.receivedAtSource = "mailbox";
      }
    }
    if (!Array.isArray(item.attachments) && Array.isArray(rawFiles)) {
      const stored = sanitizeStoredAttachments(rawFiles);
      item.attachments = publicAttachments(stored);
      patch.attachments = stored;
    }
    if (item.mailboxLookupAt && !patch.receivedAt && !patch.attachments &&
        opts.serverTimestamp) {
      patch.mailboxLookupAt = opts.serverTimestamp;
    }
    if (messageId && !item.messageId) {
      item.messageId = messageId;
      patch.messageId = messageId;
    }
    if (!item.id || !Object.keys(patch).length) continue;
    const collection = targetCollection(opts.kind, item, opts.collections);
    if (!collection) continue;
    if (writes.length >= 25) continue;
    writes.push({collection, id: String(item.id), data: patch});
  }
  return writes;
}

/**
 * @param {string} mimeType MIME type.
 * @return {boolean}
 */
function opensInline(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  return mime.startsWith("image/") || mime === "application/pdf" ||
    mime === "text/plain";
}

/**
 * @param {object} att Attachment metadata.
 * @return {string} Content-Disposition header value.
 */
function contentDisposition(att) {
  const filename = String((att && att.filename) || "attachment")
      .replace(/[\r\n"]/g, "_");
  const kind = opensInline(att && att.mimeType) ? "inline" : "attachment";
  return `${kind}; filename="${filename}"`;
}

module.exports = {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  toDate,
  toIso,
  toTimestamp,
  mailboxReceivedIso,
  sanitizeStoredAttachments,
  mergeAttachments,
  publicAttachments,
  fieldsForCreate,
  serializeMailFields,
  saveAttachmentBuffer,
  captureMailboxAttachments,
  attachmentsFromInvoice,
  backfillListedItems,
  contentDisposition,
  opensInline,
};
