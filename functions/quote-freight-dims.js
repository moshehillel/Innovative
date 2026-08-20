/**
 * Pallet L×W×H defaults for quote freight.
 * GMA footprint is stored as 40 × 48 (not 48 × 40). Missing pallet dims
 * default to 40 × 48 × 60. Explicit non-40/48 footprints are left alone.
 */

"use strict";

const STANDARD_PALLET_LENGTH = 40;
const STANDARD_PALLET_WIDTH = 48;
const DEFAULT_PALLET_HEIGHT = 60;

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
 * Rewrite 48×40 → 40×48; fill missing pallet L/W/H with defaults
 * (global 40×48×60, or opts.defaultDims for sender-specific rules).
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

  if (hasL && hasW) {
    if (isStandardPalletFootprint(L, W)) {
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
  normalizePalletDims,
  normalizePalletFreightRows,
  sanitizeImplausiblePalletWeight,
  palletDimsWereDefaulted,
};
