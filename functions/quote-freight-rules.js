/**
 * Built-in quote freight rules (always on):
 * 1. Combine — same shipper+consignee OD lanes whose combined pallet qty
 *    is ≤ MAX_PALLETS_PER_TRAILER merge into one lane before rating.
 * 2. Split — a lane with more than MAX pallets becomes ceil(qty/MAX)
 *    trailer portions (rated separately under the same quote request).
 *
 * Override max via env QUOTE_MAX_PALLETS_PER_TRAILER (default 26).
 * Firestore override can be added later; behavior is hard-coded for now.
 */

"use strict";

const rateShop = require("./quote-rate-shop");

const DEFAULT_MAX_PALLETS_PER_TRAILER = 26;

/** dimTypes that count as pallets for trailer capacity. */
const PALLET_DIM_TYPES = new Set(["PLT"]);

/**
 * @return {number} Max pallets per trailer (default 26).
 */
function getMaxPalletsPerTrailer() {
  const n = Number(process.env.QUOTE_MAX_PALLETS_PER_TRAILER);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return DEFAULT_MAX_PALLETS_PER_TRAILER;
}

/**
 * @param {*} value Raw dimType.
 * @param {object} [row] Freight row.
 * @return {string} Normalized Primus dimType.
 */
function normalizedDimType(value, row) {
  return rateShop.normalizeDimType(value, row || {});
}

/**
 * @param {object} row Freight line.
 * @return {boolean}
 */
function isPalletLikeRow(row) {
  const r = row && typeof row === "object" ? row : {};
  return PALLET_DIM_TYPES.has(normalizedDimType(r.dimType, r));
}

/**
 * Count pallets from freightInfo.
 * Uses PLT / pallet-like dimTypes only. CTN/BOX are not pallets.
 * Ambiguous fallback: single freight line with qty > 0 and no clear
 * non-pallet packaging → treat qty as pallets (LTL heuristic).
 * @param {Array<object>} freightInfo Freight lines.
 * @return {number}
 */
function countPallets(freightInfo) {
  const rows = Array.isArray(freightInfo) ? freightInfo : [];
  if (!rows.length) return 0;

  let palletQty = 0;
  let anyPallet = false;
  let anyNonPalletPackaging = false;

  for (const row of rows) {
    const r = row && typeof row === "object" ? row : {};
    const dim = normalizedDimType(r.dimType, r);
    const qty = Math.max(0, Number(r.qty) || 0);
    if (PALLET_DIM_TYPES.has(dim)) {
      anyPallet = true;
      palletQty += qty;
      continue;
    }
    // Explicit non-pallet packaging (carton/box/etc.) — do not count.
    if (dim && dim !== "OTH" && dim !== "TOT" && dim !== "TRUCK LOAD") {
      anyNonPalletPackaging = true;
    }
  }

  if (anyPallet) return palletQty;

  // Ambiguous: one line, high/any qty, packaging unclear → pallets for LTL.
  if (!anyNonPalletPackaging && rows.length === 1) {
    const qty = Math.max(0, Number(rows[0].qty) || 0);
    if (qty > 0) return qty;
  }

  return 0;
}

/**
 * Total weight across freight lines.
 * @param {Array<object>} freightInfo Freight lines.
 * @return {number}
 */
function sumWeight(freightInfo) {
  const rows = Array.isArray(freightInfo) ? freightInfo : [];
  return rows.reduce((sum, row) => {
    const w = Number(row && row.weight) || 0;
    return sum + (w > 0 ? w : 0);
  }, 0);
}

/**
 * Normalize one address fragment for OD matching.
 * @param {*} s Raw.
 * @return {string}
 */
function normalizePart(s) {
  return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
}

/**
 * Stable origin/destination key from street + city + state + zip.
 * @param {object} addr Address object.
 * @return {string}
 */
function addressKey(addr) {
  const a = addr || {};
  const zip = a.zipCode || a.zipcode || "";
  const parts = [
    normalizePart(a.address1),
    normalizePart(a.city),
    normalizePart(a.state),
    normalizePart(zip),
  ].filter(Boolean);
  return parts.join("|");
}

/**
 * OD key for combine: shipper address + consignee address.
 * @param {object} shipper Shipper.
 * @param {object} consignee Consignee.
 * @return {string}
 */
function odKey(shipper, consignee) {
  const o = addressKey(shipper);
  const d = addressKey(consignee);
  if (!o && !d) return "";
  return `${o}=>${d}`;
}

/**
 * Pick a primary pallet freight row (or first row) for dims/class.
 * @param {Array<object>} freightInfo Freight lines.
 * @return {object}
 */
function primaryFreightRow(freightInfo) {
  const rows = Array.isArray(freightInfo) ? freightInfo : [];
  const pallet = rows.find((r) => isPalletLikeRow(r));
  return (pallet || rows[0] || {});
}

/**
 * Build one PLT freight line for a trailer portion.
 * Weight scaled by portionQty / totalPallets when possible.
 * @param {Array<object>} freightInfo Source freight.
 * @param {number} portionQty Pallets on this trailer.
 * @param {number} totalPallets Total pallets on original lane.
 * @return {Array<object>}
 */
function freightForPortion(freightInfo, portionQty, totalPallets) {
  const base = primaryFreightRow(freightInfo);
  const totalW = sumWeight(freightInfo);
  const scale = totalPallets > 0 ? portionQty / totalPallets : 0;
  const weight = totalW > 0 ?
    Math.max(1, Math.round(totalW * scale)) :
    (Number(base.weight) > 0 ?
      Math.max(1, Math.round(Number(base.weight) * scale)) : undefined);

  const row = {
    qty: portionQty,
    dimType: "PLT",
  };
  if (weight != null) row.weight = weight;
  if (base.class != null && base.class !== "") row.class = base.class;
  if (base.length != null) row.length = base.length;
  if (base.width != null) row.width = base.width;
  if (base.height != null) row.height = base.height;
  if (base.weightType != null) row.weightType = base.weightType;
  return [row];
}

/**
 * Destination city for trailer labels.
 * @param {object} lane Lane.
 * @return {string}
 */
function destCityLabel(lane) {
  const city = lane && lane.consignee && lane.consignee.city;
  const state = lane && lane.consignee && lane.consignee.state;
  if (city && state) return `${String(city).trim()}, ${String(state).trim()}`;
  if (city) return String(city).trim();
  return (lane && lane.label) || (lane && lane.laneKey) || "DEST";
}

/**
 * Build a combined lane from group members (same OD, fits under max).
 * @param {Array<{lane: object, idx: number}>} members Group members.
 * @param {number} maxPallets Max per trailer.
 * @return {{lane: object, rule: object}}
 */
function buildCombinedLane(members, maxPallets) {
  const first = members[0].lane;
  const mergedFreight = [];
  const refs = [];
  const instr = [];
  const keys = [];
  let totalPallets = 0;
  for (const m of members) {
    const fr = Array.isArray(m.lane.freightInfo) ? m.lane.freightInfo : [];
    mergedFreight.push(...fr.map((r) => ({...r})));
    (m.lane.referenceNumbers || []).forEach((r) => refs.push(r));
    if (m.lane.specialInstructions) instr.push(m.lane.specialInstructions);
    keys.push(m.lane.laneKey || m.lane.label || `lane${m.idx}`);
    totalPallets += countPallets(m.lane.freightInfo);
  }

  const note =
    `Combined ${members.length} shipments (same OD, ≤${maxPallets} pallets)`;
  const freightRule = {
    ruleId: "combine_same_od",
    name: "Combine same OD",
    notes: note,
    matchVia: "freight_rules",
    combinedFrom: keys,
    combinedPallets: totalPallets,
  };

  return {
    rule: freightRule,
    lane: {
      ...first,
      laneKey: first.laneKey || keys[0] || "COMBINED",
      label: first.label || `TO ${destCityLabel(first)}`,
      freightInfo: mergedFreight,
      referenceNumbers: [...new Set(refs.map(String).filter(Boolean))],
      specialInstructions: [
        first.specialInstructions,
        ...instr.slice(1),
        note,
      ].filter(Boolean).join(" | "),
      freightRulesApplied: [
        ...(first.freightRulesApplied || []),
        freightRule,
      ],
      flags: {
        ...(first.flags || {}),
        combinedSameOd: true,
      },
    },
  };
}

/**
 * Merge 2+ lanes that share OD and fit under max pallets.
 * Preserves relative order by first-seen OD group.
 * @param {Array<object>} lanes Lanes (each should already have shipper).
 * @param {number} maxPallets Max per trailer.
 * @return {{lanes: Array<object>, applied: Array<object>}}
 */
function combineSameOdLanes(lanes, maxPallets) {
  const list = Array.isArray(lanes) ? lanes : [];
  if (list.length < 2) {
    return {lanes: list.map((l) => ({...l})), applied: []};
  }

  const groups = new Map();
  const groupOrder = [];
  list.forEach((lane, idx) => {
    const key = odKey(lane.shipper, lane.consignee) || `__solo_${idx}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      groupOrder.push(key);
    }
    groups.get(key).push({lane, idx});
  });

  const applied = [];
  const out = [];

  for (const key of groupOrder) {
    const members = groups.get(key);
    const totalPallets = members.reduce(
        (sum, m) => sum + countPallets(m.lane.freightInfo), 0);
    const canCombine = !key.startsWith("__solo_") &&
      members.length >= 2 &&
      totalPallets > 0 &&
      totalPallets <= maxPallets;

    if (!canCombine) {
      for (const m of members) out.push({...m.lane});
      continue;
    }

    const merged = buildCombinedLane(members, maxPallets);
    applied.push(merged.rule);
    out.push(merged.lane);
  }

  return {lanes: out, applied};
}

/**
 * Split one lane into trailer portions when pallets exceed max.
 * @param {object} lane Lane.
 * @param {number} maxPallets Max per trailer.
 * @return {{lanes: Array<object>, applied: Array<object>}}
 */
function splitLaneByPallets(lane, maxPallets) {
  const total = countPallets(lane.freightInfo);
  if (!(total > maxPallets)) {
    return {lanes: [{...lane}], applied: []};
  }

  const trailerCount = Math.ceil(total / maxPallets);
  const applied = [];
  const lanes = [];
  let remaining = total;

  for (let i = 0; i < trailerCount; i++) {
    const portion = Math.min(maxPallets, remaining);
    remaining -= portion;
    const n = i + 1;
    const baseLabel = lane.label || `TO ${destCityLabel(lane)}`;
    const trailerTag = `Trailer ${n} of ${trailerCount} (${portion} PLT)`;
    const label = n === 1 ?
      `${baseLabel} — ${trailerTag}` :
      `${trailerTag}`;
    const note =
      `Split oversize lane: ${total} PLT → ${trailerCount} trailers ` +
      `(max ${maxPallets}/trailer); this is ${trailerTag}`;
    const freightRule = {
      ruleId: "split_max_pallets",
      name: "Split over max pallets",
      notes: note,
      matchVia: "freight_rules",
      trailerIndex: n,
      trailerCount,
      portionPallets: portion,
      totalPallets: total,
    };
    applied.push(freightRule);

    const baseKey = String(lane.laneKey || "LANE").replace(/_T\d+$/, "");
    lanes.push({
      ...lane,
      laneKey: `${baseKey}_T${n}`,
      label,
      freightInfo: freightForPortion(lane.freightInfo, portion, total),
      specialInstructions: [
        lane.specialInstructions,
        note,
      ].filter(Boolean).join(" | "),
      freightRulesApplied: [
        ...(lane.freightRulesApplied || []),
        freightRule,
      ],
      flags: {
        ...(lane.flags || {}),
        splitTrailer: true,
        trailerIndex: n,
        trailerCount,
      },
      parentLaneKey: lane.laneKey || baseKey,
    });
  }

  return {lanes, applied};
}

/**
 * Apply combine then split to extracted quote lanes.
 * Mutates a shallow copy of extracted; does not mutate input lanes in place.
 * @param {object} extracted extractQuoteRequest result.
 * @param {object} [opts] maxPallets override.
 * @return {object} Extracted with normalized lanes + freightRulesMeta.
 */
function applyFreightRules(extracted, opts = {}) {
  const maxPallets = Number(opts.maxPallets) > 0 ?
    Math.floor(Number(opts.maxPallets)) :
    getMaxPalletsPerTrailer();

  const src = extracted && typeof extracted === "object" ? extracted : {};
  const globalShipper = src.shipper || null;
  const inputLanes = Array.isArray(src.lanes) ? src.lanes : [];

  const withShipper = inputLanes.map((lane, i) => ({
    ...lane,
    shipper: lane.shipper || globalShipper || {},
    laneKey: lane.laneKey || `LANE_${i + 1}`,
  }));

  const combined = combineSameOdLanes(withShipper, maxPallets);
  const applied = [...combined.applied];
  const splitLanes = [];
  for (const lane of combined.lanes) {
    const split = splitLaneByPallets(lane, maxPallets);
    applied.push(...split.applied);
    splitLanes.push(...split.lanes);
  }

  return {
    ...src,
    lanes: splitLanes,
    freightRulesMeta: {
      maxPalletsPerTrailer: maxPallets,
      appliedRules: applied,
      inputLaneCount: inputLanes.length,
      outputLaneCount: splitLanes.length,
    },
  };
}

module.exports = {
  DEFAULT_MAX_PALLETS_PER_TRAILER,
  getMaxPalletsPerTrailer,
  countPallets,
  sumWeight,
  addressKey,
  odKey,
  combineSameOdLanes,
  splitLaneByPallets,
  freightForPortion,
  applyFreightRules,
  isPalletLikeRow,
};
