/**
 * Pallet L×W×H defaults for quote freight.
 * GMA footprint is stored as 40 × 48 (not 48 × 40). Missing pallet dims
 * default to 40 × 48 × 60. Explicit non-40/48 footprints are left alone.
 * Customers sometimes write L×H×W (height in the middle); we reorder
 * when 40 and 48 appear anywhere in the triple (leftover is height),
 * or when the first and last numbers match (square base). L/W/H and
 * length/width/height labels are equivalent.
 */

"use strict";

const STANDARD_PALLET_LENGTH = 40;
const STANDARD_PALLET_WIDTH = 48;
const DEFAULT_PALLET_HEIGHT = 60;

/** Non-capturing axis names for embedding in other regexes. */
const AXIS_TOKEN_NC = "(?:length|width|height|len|wid|ht|l|w|h)";
/** Axis names: full words first so "length" is not read as "l". */
const AXIS_TOKEN = "(length|width|height|len|wid|ht|l|w|h)";

/**
 * Capturing blob for a dim triple with optional L/W/H labels on each
 * number. Used by intake scanners; feed the capture to parseDimTripleString.
 */
const DIM_TRIPLE_CAPTURE =
    "(?:" + AXIS_TOKEN_NC + "\\s*[:=]?\\s*)?[\\d.]+(?:\\s*" + AXIS_TOKEN_NC +
    ")?\\s*[x×*]\\s*(?:" + AXIS_TOKEN_NC + "\\s*[:=]?\\s*)?[\\d.]+(?:\\s*" +
    AXIS_TOKEN_NC + ")?\\s*[x×*]\\s*(?:" + AXIS_TOKEN_NC +
    "\\s*[:=]?\\s*)?[\\d.]+(?:\\s*" + AXIS_TOKEN_NC + ")?";

/**
 * Map L / W / H / length / width / height (and short aliases) to an axis.
 * @param {*} raw Label token.
 * @return {"l"|"w"|"h"|null}
 */
function dimAxisFromToken(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "l" || s === "len" || s === "length") return "l";
  if (s === "w" || s === "wid" || s === "width") return "w";
  if (s === "h" || s === "ht" || s === "height") return "h";
  return null;
}

/**
 * Map three dim tokens. When every token has an L/W/H (or
 * length/width/height) label, use labels (any order). Otherwise keep
 * written order.
 * @param {*} a First number.
 * @param {*} aLab First label or empty.
 * @param {*} b Second number.
 * @param {*} bLab Second label.
 * @param {*} c Third number.
 * @param {*} cLab Third label.
 * @return {{length: number, width: number, height: number, labeled: boolean}}
 */
function dimsFromOptionalLabels(a, aLab, b, bLab, c, cLab) {
  const tokens = [
    {n: Number(a), k: dimAxisFromToken(aLab)},
    {n: Number(b), k: dimAxisFromToken(bLab)},
    {n: Number(c), k: dimAxisFromToken(cLab)},
  ];
  const map = {l: null, w: null, h: null};
  let labeled = 0;
  for (const t of tokens) {
    if (t.k) {
      map[t.k] = t.n;
      labeled++;
    }
  }
  if (labeled === 3 && map.l > 0 && map.w > 0 && map.h > 0) {
    return {length: map.l, width: map.w, height: map.h, labeled: true};
  }
  return {
    length: tokens[0].n,
    width: tokens[1].n,
    height: tokens[2].n,
    labeled: false,
  };
}

/**
 * One dim token: optional axis, number, optional axis.
 * "40L", "L40", "L: 40", "height 57", "48".
 * @type {string}
 */
const DIM_TOKEN_RE =
    "(?:" + AXIS_TOKEN + "\\s*[:=]?\\s*)?([\\d.]+)(?:\\s*" + AXIS_TOKEN + ")?";

/**
 * Parse "40x57x48", "40L x 57H x 48W", "L 40 x H 57 x W 48",
 * "40 x 20 x 96 in (W x H x L)" into L/W/H.
 * @param {string} text Dim triple.
 * @return {{length: number, width: number, height: number, labeled: boolean}|null}
 */
function parseDimTripleString(text) {
  const raw = String(text || "");
  const order = parseAxisOrderLegend(raw);
  const stripped = raw
      .replace(AXIS_ORDER_RE, " ")
      .replace(/\b(?:in(?:ches)?|cm|cms)\b/gi, " ")
      .replace(/[()]/g, " ");
  const re = new RegExp(
      DIM_TOKEN_RE + "\\s*[x×*]\\s*" + DIM_TOKEN_RE +
      "\\s*[x×*]\\s*" + DIM_TOKEN_RE,
      "i");
  const m = stripped.match(re);
  if (!m) return null;
  const dims = dimsFromOptionalLabels(
      m[2], m[1] || m[3], m[5], m[4] || m[6], m[8], m[7] || m[9]);
  if (!(dims.length > 0 && dims.width > 0 && dims.height > 0)) return null;
  if (dims.labeled) return dims;
  if (order) {
    const mapped = dimsFromAxisOrder(
        dims.length, dims.width, dims.height, order);
    if (mapped) return mapped;
  }
  return dims;
}

/** W x H x L / length x width x height, optional parentheses. */
const AXIS_ORDER_RE = new RegExp(
    "\\(?\\s*" + AXIS_TOKEN + "\\s*[x×*]\\s*" + AXIS_TOKEN +
    "\\s*[x×*]\\s*" + AXIS_TOKEN + "\\s*\\)?",
    "i");

/**
 * Parse an axis-order legend like (W x H x L) or LxWxH.
 * @param {string} text Nearby text.
 * @return {Array<"l"|"w"|"h">|null}
 */
function parseAxisOrderLegend(text) {
  const m = String(text || "").match(AXIS_ORDER_RE);
  if (!m) return null;
  const axes = [
    dimAxisFromToken(m[1]),
    dimAxisFromToken(m[2]),
    dimAxisFromToken(m[3]),
  ];
  if (!axes[0] || !axes[1] || !axes[2]) return null;
  if (new Set(axes).size !== 3) return null;
  return axes;
}

/**
 * @param {*} n1 First number (in legend order).
 * @param {*} n2 Second number.
 * @param {*} n3 Third number.
 * @param {Array<"l"|"w"|"h">} axes Legend axes.
 * @return {{length: number, width: number, height: number, labeled: boolean}|null}
 */
function dimsFromAxisOrder(n1, n2, n3, axes) {
  if (!axes || axes.length !== 3) return null;
  const nums = [Number(n1), Number(n2), Number(n3)];
  const map = {l: null, w: null, h: null};
  for (let i = 0; i < 3; i++) {
    if (!(nums[i] > 0) || !axes[i]) return null;
    map[axes[i]] = nums[i];
  }
  if (map.l > 0 && map.w > 0 && map.h > 0) {
    return {length: map.l, width: map.w, height: map.h, labeled: true};
  }
  return null;
}

/**
 * If the email has "40 x 20 x 96 in (W x H x L)" and the row holds those
 * three numbers in any slots, remap to L×W×H from the legend.
 * @param {object} row Freight row.
 * @param {string} body Email body.
 * @return {object}
 */
function applyEmailDimOrderLegend(row, body) {
  if (!row || typeof row !== "object") return row;
  if (!isPalletPackaging(row)) return row;
  const L = Number(row.length);
  const W = Number(row.width);
  const H = Number(row.height);
  if (!(L > 0 && W > 0 && H > 0)) return row;
  const parsed = findLegendDimInText(body);
  if (!parsed) return row;
  const a = [L, W, H].slice().sort((x, y) => x - y);
  const b = [parsed.length, parsed.width, parsed.height].slice()
      .sort((x, y) => x - y);
  if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) return row;
  return {
    ...row,
    length: parsed.length,
    width: parsed.width,
    height: parsed.height,
    dimAxesLabeled: true,
  };
}

/**
 * First "N x N x N in (W x H x L)" (parens optional) in the email.
 * @param {string} text Body.
 * @return {{length: number, width: number, height: number, labeled: boolean}|null}
 */
function findLegendDimInText(text) {
  const re = new RegExp(
      "([\\d.]+)\\s*[x×*]\\s*([\\d.]+)\\s*[x×*]\\s*([\\d.]+)" +
      "\\s*(?:in(?:ches)?|cm|cms)?\\s*" +
      "\\(?\\s*" + AXIS_TOKEN + "\\s*[x×*]\\s*" + AXIS_TOKEN +
      "\\s*[x×*]\\s*" + AXIS_TOKEN + "\\s*\\)?",
      "gi");
  const m = re.exec(String(text || ""));
  if (!m) return null;
  return dimsFromAxisOrder(m[1], m[2], m[3], [
    dimAxisFromToken(m[4]),
    dimAxisFromToken(m[5]),
    dimAxisFromToken(m[6]),
  ]);
}

/**
 * Parse scattered L/W/H or length/width/height fields in any order.
 * "H: 57 L: 40 W: 48", "Length 40 Width 57 Height 48".
 * @param {string} text Body or pallet block.
 * @return {{length: number, width: number, height: number}|null}
 */
function parseAxisLabeledDims(text) {
  const src = String(text || "");
  const map = {l: null, w: null, h: null};
  const re = new RegExp(
      "(?:^|[^a-z])" + AXIS_TOKEN + "\\s*[:=]?\\s*([\\d.]+)",
      "gi");
  let m;
  while ((m = re.exec(src)) !== null) {
    const k = dimAxisFromToken(m[1]);
    const n = Number(m[2]);
    if (k && n > 0 && map[k] == null) map[k] = n;
  }
  if (map.l > 0 && map.w > 0 && map.h > 0) {
    return {length: map.l, width: map.w, height: map.h};
  }
  return null;
}

/**
 * Customers often write L×H×W (height in the middle) instead of L×W×H.
 * GMA: 40 and 48 anywhere in the three numbers → leftover is height.
 * Square: first === last, middle is not 40/48 → pair is the base.
 * Does not treat "largest = height" (keeps 96×48×48).
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
  const vals = [L, W, H];
  const has40 = vals.filter((v) => v === STANDARD_PALLET_LENGTH).length === 1;
  const has48 = vals.filter((v) => v === STANDARD_PALLET_WIDTH).length === 1;
  if (has40 && has48) {
    const leftover = vals.find((v) => !gma.has(v));
    if (leftover > 0) {
      return {
        length: STANDARD_PALLET_LENGTH,
        width: STANDARD_PALLET_WIDTH,
        height: leftover,
      };
    }
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
 * Reorder unlabeled L×H×W (40/48 anywhere → leftover is height, or
 * matching first/last); rewrite 48×40 → 40×48; fill missing pallet
 * L/W/H with defaults (global 40×48×60, or opts.defaultDims).
 * Labeled L/W/H (or length/width/height) keep the mapped axes; 48×40
 * L/W is still stored 40×48.
 * @param {object} row Freight row.
 * @param {object} [opts] Optional `defaultDims` {length, width, height}.
 * @return {object}
 */
function normalizePalletDims(row, opts = {}) {
  if (!row || typeof row !== "object") return row;
  const next = {...row};
  const labeled = !!next.dimAxesLabeled;
  delete next.dimAxesLabeled;
  if (!isPalletPackaging(next)) return next;

  const defaults = resolvePalletDimDefaults(opts);
  const L = Number(next.length);
  const W = Number(next.width);
  const H = Number(next.height);
  const hasL = Number.isFinite(L) && L > 0;
  const hasW = Number.isFinite(W) && W > 0;
  const hasH = Number.isFinite(H) && H > 0;

  if (hasL && hasW && hasH && !labeled) {
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
  DIM_TRIPLE_CAPTURE,
  isStandardPalletFootprint,
  isPalletPackaging,
  resolvePalletDimDefaults,
  dimsFromOptionalLabels,
  parseDimTripleString,
  parseAxisLabeledDims,
  parseAxisOrderLegend,
  applyEmailDimOrderLegend,
  findLegendDimInText,
  dimAxisFromToken,
  reorderMisplacedPalletDims,
  normalizePalletDims,
  normalizePalletFreightRows,
  sanitizeImplausiblePalletWeight,
  palletDimsWereDefaulted,
};
