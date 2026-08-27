/**
 * Pallet L×W×H defaults for quote freight.
 * GMA footprint is stored as 40 × 48 (not 48 × 40). Missing pallet dims
 * default to 40 × 48 × 60. Explicit non-40/48 footprints are left alone.
 * Customers sometimes write L×H×W (height in the middle); we reorder
 * that when 40 and 48 are the two ends, or when the first and last
 * numbers match (square base).
 */

"use strict";

const STANDARD_PALLET_LENGTH = 40;
const STANDARD_PALLET_WIDTH = 48;
const DEFAULT_PALLET_HEIGHT = 60;

/**
 * Map three dim tokens. When every token has an L/W/H suffix, use labels
 * (any order). Otherwise keep written order.
 * @param {*} a First number.
 * @param {*} aLab First suffix (l/w/h) or empty.
 * @param {*} b Second number.
 * @param {*} bLab Second suffix.
 * @param {*} c Third number.
 * @param {*} cLab Third suffix.
 * @return {{length: number, width: number, height: number}}
 */
function dimsFromOptionalLabels(a, aLab, b, bLab, c, cLab) {
  const tokens = [
    {n: Number(a), k: String(aLab || "").trim().toLowerCase()},
    {n: Number(b), k: String(bLab || "").trim().toLowerCase()},
    {n: Number(c), k: String(cLab || "").trim().toLowerCase()},
  ];
  const map = {l: null, w: null, h: null};
  let labeled = 0;
  for (const t of tokens) {
    if (t.k === "l" || t.k === "w" || t.k === "h") {
      map[t.k] = t.n;
      labeled++;
    }
  }
  if (labeled === 3 && map.l > 0 && map.w > 0 && map.h > 0) {
    return {length: map.l, width: map.w, height: map.h};
  }
  return {
    length: tokens[0].n,
    width: tokens[1].n,
    height: tokens[2].n,
  };
}

/**
 * Parse "40x57x48" or "40L x 57H x 48W" into L/W/H.
 * @param {string} text Dim triple.
 * @return {{length: number, width: number, height: number}|null}
 */
function parseDimTripleString(text) {
  const m = String(text || "").match(
      /^\s*([\d.]+)\s*([lLwWhH])?\s*[x×*]\s*([\d.]+)\s*([lLwWhH])?\s*[x×*]\s*([\d.]+)\s*([lLwWhH])?\s*$/);
  if (!m) return null;
  const dims = dimsFromOptionalLabels(m[1], m[2], m[3], m[4], m[5], m[6]);
  if (!(dims.length > 0 && dims.width > 0 && dims.height > 0)) return null;
  return dims;
}

/**
 * Customers often write L×H×W (height in the middle) instead of L×W×H.
 * GMA: 40 and 48 on the two ends → leftover (middle) is height.
 * Square: first === last, middle is not 40/48 → pair is the base.
 * Does not treat "largest = height" (keeps 96×48×48 and 96×40×48).
 * @param {*} length Raw length.
 * @param {*} width Raw width.
 * @param {*} height Raw height.
 * @return {{length: number, width: number, height: number}}
 */
function reorderMisplacedPalletDims(length, width, height) {
  const L = Number(length);
  const W = Number(width);
  const H = Number(height);
  if (!(L > 0 && W > 0 && H > 0)) {
    return {length: L, width: W, height: H};
  }
  const gma = new Set([STANDARD_PALLET_LENGTH, STANDARD_PALLET_WIDTH]);
  const endsAreGma = gma.has(L) && gma.has(H) && L !== H && !gma.has(W);
  if (endsAreGma) {
    return {
      length: STANDARD_PALLET_LENGTH,
      width: STANDARD_PALLET_WIDTH,
      height: W,
    };
  }
  if (L === H && W !== L && !gma.has(W)) {
    return {length: L, width: L, height: W};
  }
  return {length: L, width: W, height: H};
}

/**
 * True when L/W are the 40×48 pair in either order.
 * @param {*} length Raw length.
 * @param {*} width Raw width.
 * @return {boolean}
 */
function isStandardPalletFootprint(length, width) {
  const L = Number(length);
  const W = Number(width);
  if (!Number.isFinite(L) || !Number.isFinite(W)) return false;
  return (L === 48 && W === 40) || (L === 40 && W === 48);
}

/**
 * Pallet-like packaging (PLT / aliases / blank). Cartons are not pallets.
 * @param {object} row Freight row.
 * @return {boolean}
 */
function isPalletPackaging(row) {
  const r = row && typeof row === "object" ? row : {};
  const dim = String(r.dimType || r.packaging || "")
      .trim()
      .toUpperCase()
      .replace(/[_-]+/g, " ");
  const key = dim.replace(/\s+/g, "");
  if (!key) return true;
  if (key === "PLT" || key === "OTH" || key === "IN" || key === "INCH" ||
      key === "INCHES" || key === "CM" || key === "CMS" ||
      key === "PALLET" || key === "PALLETS" || key === "SKID" ||
      key === "SKIDS" || key === "PLTS") {
    return true;
  }
  return false;
}

/**
 * Resolve L/W/H defaults (global 40×48×60 unless opts.defaultDims set).
 * @param {object} [opts] Optional `defaultDims` {length, width, height}.
 * @return {{length: number, width: number, height: number}}
 */
function resolvePalletDimDefaults(opts = {}) {
  const d = opts && opts.defaultDims && typeof opts.defaultDims === "object" ?
    opts.defaultDims : {};
  const length = Number(d.length);
  const width = Number(d.width);
  const height = Number(d.height);
  return {
    length: length > 0 ? length : STANDARD_PALLET_LENGTH,
    width: width > 0 ? width : STANDARD_PALLET_WIDTH,
    height: height > 0 ? height : DEFAULT_PALLET_HEIGHT,
  };
}

/**
 * Reorder L×H×W when height is in the middle (GMA 40/48 on the ends,
 * or matching first/last); rewrite 48×40 → 40×48; fill missing pallet
 * L/W/H with defaults (global 40×48×60, or opts.defaultDims).
 * Does not overwrite explicit non-standard footprints or present dims.
 * @param {object} row Freight row.
 * @param {object} [opts] Optional `defaultDims` {length, width, height}.
 * @return {object}
 */
function normalizePalletDims(row, opts = {}) {
  if (!row || typeof row !== "object") return row;
  const next = {...row};
  if (!isPalletPackaging(next)) return next;

  const defaults = resolvePalletDimDefaults(opts);
  const L = Number(next.length);
  const W = Number(next.width);
  const H = Number(next.height);
  const hasL = Number.isFinite(L) && L > 0;
  const hasW = Number.isFinite(W) && W > 0;
  const hasH = Number.isFinite(H) && H > 0;

  if (hasL && hasW && hasH) {
    const reordered = reorderMisplacedPalletDims(L, W, H);
    next.length = reordered.length;
    next.width = reordered.width;
    next.height = reordered.height;
  }

  const L2 = Number(next.length);
  const W2 = Number(next.width);
  const hasL2 = Number.isFinite(L2) && L2 > 0;
  const hasW2 = Number.isFinite(W2) && W2 > 0;

  if (hasL2 && hasW2) {
    if (isStandardPalletFootprint(L2, W2)) {
      next.length = STANDARD_PALLET_LENGTH;
      next.width = STANDARD_PALLET_WIDTH;
    }
  } else {
    if (!hasL) next.length = defaults.length;
    if (!hasW) next.width = defaults.width;
  }
  if (!hasH) next.height = defaults.height;
  if (!String(next.dimType || "").trim()) next.dimType = "PLT";
  return next;
}

/**
 * True when missing pallet L/W/H were filled with 40×48×60.
 * Orientation rewrite (48×40 → 40×48) is not a default.
 * @param {object} before Row before normalizePalletDims.
 * @param {object} after Row after normalizePalletDims.
 * @return {boolean}
 */
function palletDimsWereDefaulted(before, after) {
  if (!after || !isPalletPackaging(after)) return false;
  const b = before && typeof before === "object" ? before : {};
  const missingL = !(Number(b.length) > 0);
  const missingW = !(Number(b.width) > 0);
  const missingH = !(Number(b.height) > 0);
  if (!missingL && !missingW && !missingH) return false;
  return Number(after.length) > 0 && Number(after.width) > 0 &&
    Number(after.height) > 0;
}

/**
 * @param {Array<object>|null|undefined} rows Freight lines.
 * @param {object} [opts] Optional `defaultDims` {length, width, height}.
 * @return {Array<object>}
 */
function normalizePalletFreightRows(rows, opts = {}) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => sanitizeImplausiblePalletWeight(
      normalizePalletDims(row, opts)));
}

/**
 * AI sometimes strips decimals (7,469.49 → 746949). If implied lbs/pallet
 * is physically impossible for LTL, restore hundredths.
 * @param {object} row Freight row.
 * @return {object}
 */
function sanitizeImplausiblePalletWeight(row) {
  if (!row || typeof row !== "object") return row;
  if (!isPalletPackaging(row)) return row;
  const qty = Math.max(1, Number(row.qty) || 1);
  const w = Number(row.weight);
  if (!(w > 0) || !Number.isFinite(w)) return row;
  const wt = String(row.weightType || "total").trim().toLowerCase();
  const isEach = wt === "each" || wt === "perpiece" || wt === "per-piece";
  const total = isEach ? w * qty : w;
  const per = total / qty;
  if (!(per > 20000)) return row;
  const fixed = w / 100;
  const fixedTotal = isEach ? fixed * qty : fixed;
  const fixedPer = fixedTotal / qty;
  if (fixedPer >= 50 && fixedPer <= 20000) {
    return {
      ...row,
      weight: Math.round(fixed * 100) / 100,
    };
  }
  return row;
}

module.exports = {
  STANDARD_PALLET_LENGTH,
  STANDARD_PALLET_WIDTH,
  DEFAULT_PALLET_HEIGHT,
  isStandardPalletFootprint,
  isPalletPackaging,
  resolvePalletDimDefaults,
  dimsFromOptionalLabels,
  parseDimTripleString,
  reorderMisplacedPalletDims,
  normalizePalletDims,
  normalizePalletFreightRows,
  sanitizeImplausiblePalletWeight,
  palletDimsWereDefaulted,
};
