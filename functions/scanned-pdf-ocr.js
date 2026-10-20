/**
 * Reads a PDF page by page. Digital files use the text layer. Scanned
 * packets (no text layer) are OCR'd from the embedded page image so a
 * later split can see every invoice, not only the first pages.
 */
"use strict";

const os = require("os");
const zlib = require("zlib");
const podUtils = require("./pod-utils");

let workerPromise = null;

/**
 * @param {Buffer} buf Bytes to checksum.
 * @return {number}
 */
function pngCrc(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type PNG chunk type.
 * @param {Buffer} data Chunk payload.
 * @return {Buffer}
 */
function pngChunk(type, data) {
  const name = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([name, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * 8-bit grayscale PNG. Tesseract accepts this; 1-bit scans are expanded.
 * @param {number} width Image width.
 * @param {number} height Image height.
 * @param {Uint8Array|Buffer} samples One byte per pixel, 0 = black.
 * @return {Buffer}
 */
function pngGray8(width, height, samples) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x] = samples[(y * width) + x];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Expands a pdf.js 1-bit bitmap to 8-bit samples (0 black, 255 white).
 * @param {Uint8Array} data Packed bits, high bit is the left pixel.
 * @param {number} width Pixel width.
 * @param {number} height Pixel height.
 * @param {boolean} oneIsWhite When false, the set bit is black.
 * @return {Uint8Array}
 */
function expand1bpp(data, width, height, oneIsWhite) {
  const samples = new Uint8Array(width * height);
  const rowBytes = Math.ceil(width / 8);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byte = data[(y * rowBytes) + (x >> 3)] || 0;
      const bit = (byte >> (7 - (x & 7))) & 1;
      const white = oneIsWhite ? bit === 1 : bit === 0;
      samples[(y * width) + x] = white ? 255 : 0;
    }
  }
  return samples;
}

/**
 * @param {object} img pdf.js image object.
 * @return {Buffer|null}
 */
function imageToPng(img) {
  if (!img || !img.width || !img.height || !img.data) return null;
  const width = img.width;
  const height = img.height;
  const kind = img.kind;
  // pdf.js ImageKind: 1 = 1bpp gray, 2 = RGB, 3 = RGBA.
  if (kind === 1) {
    const rowBytes = Math.ceil(width / 8);
    let whiteBits = 0;
    const sampleRows = Math.min(8, height);
    for (let y = 0; y < sampleRows; y++) {
      for (let i = 0; i < Math.min(rowBytes, 4); i++) {
        const byte = img.data[(y * rowBytes) + i] || 0;
        whiteBits += byte.toString(2).split("1").length - 1;
      }
    }
    // Scan margins are white. If the corner bits are mostly 1, 1 means white.
    const oneIsWhite = whiteBits >= 8;
    return pngGray8(
        width, height, expand1bpp(img.data, width, height, oneIsWhite));
  }
  const pixels = width * height;
  if (kind === 2 && img.data.length >= pixels * 3) {
    const samples = new Uint8Array(pixels);
    for (let i = 0; i < pixels; i++) {
      const o = i * 3;
      samples[i] = Math.round(
          (img.data[o] + img.data[o + 1] + img.data[o + 2]) / 3);
    }
    return pngGray8(width, height, samples);
  }
  if (kind === 3 && img.data.length >= pixels * 4) {
    const samples = new Uint8Array(pixels);
    for (let i = 0; i < pixels; i++) {
      const o = i * 4;
      samples[i] = Math.round(
          (img.data[o] + img.data[o + 1] + img.data[o + 2]) / 3);
    }
    return pngGray8(width, height, samples);
  }
  return null;
}

/**
 * @param {object} page pdf.js page.
 * @param {object} pdfjs pdf.js module.
 * @return {Promise<Buffer|null>}
 */
async function pageImagePng(page, pdfjs) {
  const op = await page.getOperatorList();
  let best = null;
  let bestArea = 0;
  for (let i = 0; i < op.fnArray.length; i++) {
    const fn = op.fnArray[i];
    if (fn !== pdfjs.OPS.paintImageXObject &&
        fn !== pdfjs.OPS.paintInlineImageXObject) {
      continue;
    }
    const arg = op.argsArray[i] && op.argsArray[i][0];
    let img = null;
    try {
      img = fn === pdfjs.OPS.paintInlineImageXObject ?
        arg : await page.objs.get(arg);
    } catch (_) {
      img = null;
    }
    if (!img || !img.width || !img.height) continue;
    const area = img.width * img.height;
    if (area > bestArea) {
      best = img;
      bestArea = area;
    }
  }
  return best ? imageToPng(best) : null;
}

/**
 * @return {Promise<object>}
 */
function tessWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const {createWorker} = require("tesseract.js");
      return createWorker("eng", 1, {cachePath: os.tmpdir()});
    })();
  }
  return workerPromise;
}

/**
 * OCR every page. Empty string when a page has no image.
 * @param {Buffer|Uint8Array} buffer PDF bytes.
 * @return {Promise<string[]|null>}
 */
async function ocrPdfPageTexts(buffer) {
  if (!buffer) return null;
  let pdf = null;
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = Uint8Array.from(buffer);
    const task = pdfjs.getDocument({
      data,
      isEvalSupported: false,
      useSystemFonts: true,
    });
    pdf = await task.promise;
    const worker = await tessWorker();
    const texts = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const png = await pageImagePng(page, pdfjs);
      if (!png) {
        texts.push("");
        continue;
      }
      const result = await worker.recognize(png);
      texts.push(String(
          result && result.data && result.data.text || ""));
    }
    return texts;
  } catch (err) {
    workerPromise = null;
    const wrapped = new Error(
        `Scanned PDF OCR failed: ${err && err.message || err}`);
    wrapped.cause = err;
    throw wrapped;
  } finally {
    if (pdf) {
      try {
        await pdf.destroy();
      } catch (_) {
        // ignore
      }
    }
  }
}

/**
 * Text layer when the PDF has real text. Otherwise OCR the scan.
 * @param {Buffer|Uint8Array} buffer PDF bytes.
 * @return {Promise<string[]|null>}
 */
async function readPdfPageTexts(buffer) {
  const existing = await podUtils.extractPdfPageTexts(buffer);
  if (existing && existing.length) {
    const substantial = existing.filter((text) =>
      String(text || "").trim().length > 40).length;
    if (substantial >= Math.ceil(existing.length / 2)) return existing;
  }
  return ocrPdfPageTexts(buffer);
}

module.exports = {
  pngGray8,
  expand1bpp,
  imageToPng,
  ocrPdfPageTexts,
  readPdfPageTexts,
};
