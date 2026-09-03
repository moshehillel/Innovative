/**
 * Safely extract invoice-like files (PDF / common images) from ZIP
 * email attachments. Used for carriers like Worldwide Express that
 * send invoice packets as .zip instead of bare PDFs.
 */
"use strict";

const zlib = require("zlib");
const path = require("path");

/** Reject oversized compressed archives. */
const MAX_ZIP_BYTES = 25 * 1024 * 1024;
/** Cap entries scanned per archive. */
const MAX_ENTRIES = 50;
/** Cap total uncompressed invoice-like bytes extracted. */
const MAX_UNCOMPRESSED_TOTAL = 50 * 1024 * 1024;
/** Cap a single extracted file. */
const MAX_SINGLE_FILE_BYTES = 20 * 1024 * 1024;
/** Reject pathological compression ratios (zip bombs). */
const MAX_COMPRESSION_RATIO = 100;

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const ALLOWED_EXT = new Set([".pdf", ".png", ".jpg", ".jpeg"]);
const BLOCKED_EXT = new Set([
  ".exe", ".dll", ".com", ".bat", ".cmd", ".scr", ".msi", ".vbs", ".js",
  ".jse", ".wsf", ".ps1", ".jar", ".apk", ".dmg", ".sh", ".bin", ".so",
  ".dylib", ".htm", ".html", ".svg", ".xml", ".json", ".zip", ".rar",
  ".7z", ".gz", ".tar",
]);

/**
 * @param {object} attachment Attachment metadata.
 * @param {Buffer=} fileBuffer Optional bytes for magic check.
 * @return {boolean}
 */
function isZipAttachment(attachment, fileBuffer) {
  const mime = String(attachment && attachment.mimeType || "").toLowerCase();
  const name = String(attachment && attachment.filename || "").toLowerCase();
  if (name.endsWith(".zip")) return true;
  if (mime.includes("application/zip") ||
      mime.includes("application/x-zip") ||
      mime.includes("multipart/x-zip")) {
    return true;
  }
  if (fileBuffer && fileBuffer.length >= 4 &&
      fileBuffer[0] === 0x50 && fileBuffer[1] === 0x4b &&
      (fileBuffer[2] === 0x03 || fileBuffer[2] === 0x05 ||
        fileBuffer[2] === 0x07) &&
      (fileBuffer[3] === 0x04 || fileBuffer[3] === 0x06 ||
        fileBuffer[3] === 0x08)) {
    return true;
  }
  return false;
}

/**
 * @param {string} entryName Raw ZIP entry path.
 * @return {string|null} Safe basename, or null if unsafe / blocked.
 */
function safeInvoiceEntryName(entryName) {
  const raw = String(entryName || "").replace(/\\/g, "/");
  if (!raw || raw.endsWith("/")) return null;
  if (raw.includes("..") || path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
    return null;
  }
  const base = path.posix.basename(raw);
  if (!base || base === "." || base === "..") return null;
  if (base.startsWith(".")) return null;
  const ext = path.extname(base).toLowerCase();
  if (BLOCKED_EXT.has(ext)) return null;
  if (!ALLOWED_EXT.has(ext)) return null;
  return base;
}

/**
 * @param {string} filename
 * @param {Buffer} buffer
 * @return {string|null}
 */
function detectAllowedMime(filename, buffer) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  if (buffer && buffer.length >= 4 &&
      buffer[0] === 0x25 && buffer[1] === 0x50 &&
      buffer[2] === 0x44 && buffer[3] === 0x46) {
    return "application/pdf";
  }
  if (buffer && buffer.length >= 3 &&
      buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer && buffer.length >= 8 &&
      buffer[0] === 0x89 && buffer[1] === 0x50 &&
      buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return null;
}

/**
 * @param {Buffer} compressed
 * @param {number} method
 * @param {number} expectedSize
 * @param {number} maxSingle
 * @return {Buffer}
 */
function inflateEntry(compressed, method, expectedSize, maxSingle) {
  if (method === METHOD_STORED) {
    return compressed;
  }
  if (method !== METHOD_DEFLATE) {
    throw new Error(`unsupported zip compression method ${method}`);
  }
  const maxOut = Math.min(
      maxSingle,
      expectedSize > 0 ? expectedSize : maxSingle,
  );
  return zlib.inflateRawSync(compressed, {maxOutputLength: maxOut});
}

/**
 * Locate End of Central Directory record.
 * @param {Buffer} buf
 * @return {number} EOCD offset, or -1.
 */
function findEocdOffset(buf) {
  // EOCD is at least 22 bytes; comment can be up to 64KiB.
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Read central-directory entries (reliable sizes + local offsets).
 * @param {Buffer} zipBuffer
 * @param {number} maxEntries
 * @return {Array<object>}
 */
function readCentralDirectory(zipBuffer, maxEntries) {
  const eocd = findEocdOffset(zipBuffer);
  if (eocd < 0) return [];
  const totalEntries = zipBuffer.readUInt16LE(eocd + 10);
  const centralSize = zipBuffer.readUInt32LE(eocd + 12);
  const centralOffset = zipBuffer.readUInt32LE(eocd + 16);
  if (centralOffset + 46 > zipBuffer.length) return [];
  const entries = [];
  let offset = centralOffset;
  const end = Math.min(zipBuffer.length, centralOffset + centralSize);
  const limit = Math.min(totalEntries || maxEntries, maxEntries);
  while (offset + 46 <= end && entries.length < limit) {
    if (zipBuffer.readUInt32LE(offset) !== ZIP_CENTRAL_SIG) break;
    const method = zipBuffer.readUInt16LE(offset + 10);
    const compressedSize = zipBuffer.readUInt32LE(offset + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(offset + 24);
    const nameLen = zipBuffer.readUInt16LE(offset + 28);
    const extraLen = zipBuffer.readUInt16LE(offset + 30);
    const commentLen = zipBuffer.readUInt16LE(offset + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > zipBuffer.length) break;
    const entryName = zipBuffer.slice(nameStart, nameEnd).toString("utf8");
    entries.push({
      entryName,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset = nameEnd + extraLen + commentLen;
  }
  return entries;
}

/**
 * Read compressed payload for one central-directory entry.
 * @param {Buffer} zipBuffer
 * @param {object} entry
 * @return {Buffer|null}
 */
function readLocalCompressedData(zipBuffer, entry) {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > zipBuffer.length) return null;
  if (zipBuffer.readUInt32LE(offset) !== ZIP_LOCAL_SIG) return null;
  const nameLen = zipBuffer.readUInt16LE(offset + 26);
  const extraLen = zipBuffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > zipBuffer.length) return null;
  return zipBuffer.slice(dataStart, dataEnd);
}

/**
 * Parse ZIP central directory and extract allowed invoice-like entries.
 * @param {Buffer} zipBuffer
 * @param {object=} opts
 * @return {{files: Array<object>, skipped: Array<object>, warnings: string[]}}
 */
function extractInvoiceFilesFromZip(zipBuffer, opts) {
  const files = [];
  const skipped = [];
  const warnings = [];
  const options = opts || {};
  const maxZip = options.maxZipBytes || MAX_ZIP_BYTES;
  const maxEntries = options.maxEntries || MAX_ENTRIES;
  const maxTotal = options.maxUncompressedTotal || MAX_UNCOMPRESSED_TOTAL;
  const maxSingle = options.maxSingleFileBytes || MAX_SINGLE_FILE_BYTES;
  const maxRatio = options.maxCompressionRatio || MAX_COMPRESSION_RATIO;
  const zipName = String(options.zipFilename || "archive.zip");

  if (!zipBuffer || !Buffer.isBuffer(zipBuffer) || zipBuffer.length < 30) {
    warnings.push("zip_too_small");
    return {files, skipped, warnings};
  }
  if (zipBuffer.length > maxZip) {
    warnings.push("zip_too_large");
    return {files, skipped, warnings};
  }
  if (!(zipBuffer[0] === 0x50 && zipBuffer[1] === 0x4b)) {
    warnings.push("not_a_zip");
    return {files, skipped, warnings};
  }

  const central = readCentralDirectory(zipBuffer, maxEntries);
  if (!central.length) {
    warnings.push("no_central_directory");
    return {files, skipped, warnings};
  }

  let uncompressedTotal = 0;
  for (const entry of central) {
    const safeName = safeInvoiceEntryName(entry.entryName);
    if (!safeName) {
      skipped.push({
        filename: entry.entryName,
        reason: String(entry.entryName || "").endsWith("/") ?
          "directory" : "blocked_or_unwanted",
      });
      continue;
    }

    if (entry.uncompressedSize > maxSingle) {
      skipped.push({filename: entry.entryName, reason: "entry_too_large"});
      continue;
    }
    if (entry.compressedSize > 0 && entry.uncompressedSize > 0 &&
        entry.uncompressedSize / entry.compressedSize > maxRatio) {
      skipped.push({filename: entry.entryName, reason: "compression_ratio"});
      warnings.push("zip_bomb_ratio");
      continue;
    }
    if (uncompressedTotal +
        (entry.uncompressedSize || entry.compressedSize) > maxTotal) {
      skipped.push({filename: entry.entryName, reason: "total_budget"});
      warnings.push("uncompressed_budget");
      break;
    }

    const compressed = readLocalCompressedData(zipBuffer, entry);
    if (!compressed) {
      skipped.push({filename: entry.entryName, reason: "local_header"});
      continue;
    }

    let inflated;
    try {
      inflated = inflateEntry(
          compressed, entry.method, entry.uncompressedSize || 0, maxSingle);
    } catch (err) {
      skipped.push({
        filename: entry.entryName,
        reason: `inflate_failed:${err.message}`,
      });
      continue;
    }

    if (!inflated || !inflated.length) {
      skipped.push({filename: entry.entryName, reason: "empty"});
      continue;
    }
    if (inflated.length > maxSingle) {
      skipped.push({filename: entry.entryName, reason: "inflated_too_large"});
      continue;
    }
    if (entry.compressedSize > 0 &&
        inflated.length / entry.compressedSize > maxRatio) {
      skipped.push({filename: entry.entryName, reason: "compression_ratio"});
      warnings.push("zip_bomb_ratio");
      continue;
    }
    if (uncompressedTotal + inflated.length > maxTotal) {
      skipped.push({filename: entry.entryName, reason: "total_budget"});
      warnings.push("uncompressed_budget");
      break;
    }

    const mimeType = detectAllowedMime(safeName, inflated);
    if (!mimeType) {
      skipped.push({filename: entry.entryName, reason: "mime_mismatch"});
      continue;
    }
    if (mimeType === "application/pdf" &&
        !(inflated[0] === 0x25 && inflated[1] === 0x50 &&
          inflated[2] === 0x44 && inflated[3] === 0x46)) {
      skipped.push({filename: entry.entryName, reason: "not_pdf_magic"});
      continue;
    }

    uncompressedTotal += inflated.length;
    files.push({
      filename: safeName,
      mimeType,
      buffer: inflated,
      fromZip: true,
      zipFilename: zipName,
    });
  }

  if (central.length >= maxEntries) {
    warnings.push("max_entries");
  }

  return {files, skipped, warnings};
}

/**
 * Expand ZIP attachments into invoice-like attachment objects.
 * Marks original ZIP entries with zipExpanded when files were found.
 * @param {object} gmail Gmail/Graph client (unused if buffers present).
 * @param {string} messageId Message id.
 * @param {Array<object>} attachments Attachment list.
 * @param {Function} resolveBuffer async (gmail, messageId, att) => Buffer
 * @return {Promise<Array<object>>}
 */
async function expandZipAttachments(
    gmail, messageId, attachments, resolveBuffer) {
  const expanded = [];
  const seen = new Set();

  const pushUnique = (att) => {
    const key = `${att.filename}|${
      att.attachmentId || (att.buffer && att.buffer.length) ||
      (att.inlineData && att.inlineData.length) || ""}|${
      att.fromZip ? "zip" : ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    expanded.push(att);
  };

  for (const att of (attachments || [])) {
    pushUnique(att);
    let buf = null;
    try {
      buf = await resolveBuffer(gmail, messageId, att);
    } catch (_err) {
      continue;
    }
    if (!buf || !buf.length) continue;
    if (!isZipAttachment(att, buf)) continue;

    const result = extractInvoiceFilesFromZip(buf, {
      zipFilename: att.filename || "attachment.zip",
    });
    if (result.files.length > 0) {
      att.zipExpanded = true;
      att.zipExtractedCount = result.files.length;
      for (const file of result.files) {
        pushUnique(file);
      }
    } else {
      att.zipExpanded = false;
      att.zipWarnings = result.warnings;
    }
  }

  return expanded;
}

/**
 * Build a minimal ZIP (store or deflate) for tests.
 * @param {Array<{name: string, data: Buffer, method?: number}>} entries
 * @return {Buffer}
 */
function buildTestZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const method = entry.method == null ? METHOD_STORED : entry.method;
    let compressed = data;
    if (method === METHOD_DEFLATE) {
      compressed = zlib.deflateRawSync(data);
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(ZIP_LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14); // crc optional for tests
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localFull = Buffer.concat([local, nameBuf, compressed]);
    locals.push(localFull);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(ZIP_CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += localFull.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(ZIP_EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDir, eocd]);
}

module.exports = {
  MAX_ZIP_BYTES,
  MAX_ENTRIES,
  MAX_UNCOMPRESSED_TOTAL,
  MAX_SINGLE_FILE_BYTES,
  MAX_COMPRESSION_RATIO,
  METHOD_STORED,
  METHOD_DEFLATE,
  isZipAttachment,
  safeInvoiceEntryName,
  detectAllowedMime,
  extractInvoiceFilesFromZip,
  expandZipAttachments,
  buildTestZip,
};
