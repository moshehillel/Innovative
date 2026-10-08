/**
 * Exact-duplicate matching for dashboard tasks and notifications.
 * Same type + load + amount (within $0.01) + reason collapse together.
 * A different amount or reason stays visible. Same follow-up or message
 * id also collapses, even when the amount was not stored.
 */

"use strict";

const AMOUNT_TOLERANCE_CENTS = 1;

/**
 * @param {*} value Raw timestamp.
 * @return {number|null}
 */
function timestampMs(value) {
  if (value == null || value === "") return null;
  if (typeof value.toDate === "function") {
    const ms = value.toDate().getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n < 1e12 ? n * 1000 : n;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Newest email wins. Prefer Gmail received time when it is stored.
 * @param {object} item Task or notification.
 * @return {number}
 */
function itemRecencyMs(item) {
  const fields = [
    item && item.receivedAt,
    item && item.emailReceivedAt,
    item && item.gmailReceivedAt,
    item && item.createdAt,
  ];
  for (const field of fields) {
    const ms = timestampMs(field);
    if (ms != null) return ms;
  }
  return 0;
}

/**
 * @param {*} reason Category or reason text.
 * @return {string}
 */
function normalizeReason(reason) {
  return String(reason || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * @param {*} value Dollar amount.
 * @return {number|null} Integer cents, or null when unknown.
 */
function amountCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/**
 * @param {*} a Dollar amount.
 * @param {*} b Dollar amount.
 * @return {boolean}
 */
function amountsWithinTolerance(a, b) {
  const ca = amountCents(a);
  const cb = amountCents(b);
  if (ca == null || cb == null) return false;
  return Math.abs(ca - cb) <= AMOUNT_TOLERANCE_CENTS;
}

/**
 * @param {object} item Item with type, loadNumber, reason/category, amount.
 * @return {object|null}
 */
function chargeIdentity(item) {
  if (!item) return null;
  const type = String(item.type || "").trim();
  const loadNumber = String(item.loadNumber || "").trim();
  const reason = normalizeReason(item.reason || item.category);
  const cents = amountCents(item.chargesTotal);
  if (!type || !loadNumber || !reason || cents == null) return null;
  return {type, loadNumber, reason, cents};
}

/**
 * @param {object} a Item.
 * @param {object} b Item.
 * @return {boolean}
 */
function sameExactCharge(a, b) {
  const idA = chargeIdentity(a);
  const idB = chargeIdentity(b);
  if (!idA || !idB) return false;
  if (idA.type !== idB.type) return false;
  if (idA.loadNumber !== idB.loadNumber) return false;
  if (idA.reason !== idB.reason) return false;
  return Math.abs(idA.cents - idB.cents) <= AMOUNT_TOLERANCE_CENTS;
}

/**
 * @param {object} item Item.
 * @return {boolean}
 */
function isDisputeItem(item) {
  const phase = String(item && item.chargePhase || "").toLowerCase();
  const follow = String(item && item.followUpStatus || "").toLowerCase();
  return phase === "dispute" || follow === "disputing";
}

/**
 * Positive when `a` should be kept instead of `b`.
 * @param {object} a Item.
 * @param {object} b Item.
 * @return {number}
 */
function compareDuplicatePreference(a, b) {
  const aDispute = isDisputeItem(a) ? 1 : 0;
  const bDispute = isDisputeItem(b) ? 1 : 0;
  if (aDispute !== bDispute) return aDispute - bDispute;
  const recency = itemRecencyMs(a) - itemRecencyMs(b);
  if (recency !== 0) return recency;
  const createdA = timestampMs(a && a.createdAt) || 0;
  const createdB = timestampMs(b && b.createdAt) || 0;
  return createdA - createdB;
}

/**
 * @param {object} a Item.
 * @param {object} b Item.
 * @return {boolean}
 */
function isExactDuplicateItem(a, b) {
  if (!a || !b) return false;
  const typeA = String(a.type || "").trim();
  const typeB = String(b.type || "").trim();
  if (!typeA || typeA !== typeB) return false;
  const followA = String(a.followUpId || "").trim();
  const followB = String(b.followUpId || "").trim();
  if (followA && followB && followA === followB) return true;
  const messageA = String(a.messageId || "").trim();
  const messageB = String(b.messageId || "").trim();
  if (messageA && messageB && messageA === messageB) return true;
  return sameExactCharge(a, b);
}

/**
 * Groups items that are the same charge or the same email/follow-up.
 * Items we cannot tell apart stay in their own group.
 * @param {object[]} items Items.
 * @return {object[][]}
 */
function groupExactDuplicates(items) {
  const list = Array.isArray(items) ? items : [];
  const parent = list.map((_, i) => i);
  /**
   * @param {number} i Index.
   * @return {number}
   */
  const find = (i) => {
    let x = i;
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  /**
   * @param {number} a Index.
   * @param {number} b Index.
   */
  const union = (a, b) => {
    const pa = find(a);
    const pb = find(b);
    if (pa !== pb) parent[pb] = pa;
  };

  const byMessage = new Map();
  const byFollow = new Map();
  /** @type {Map<string, Array<{i: number, cents: number}>>} */
  const byCharge = new Map();

  list.forEach((item, i) => {
    const type = String(item && item.type || "").trim();
    const messageId = String(item && item.messageId || "").trim();
    if (type && messageId) {
      const key = `${type}|${messageId}`;
      if (byMessage.has(key)) union(i, byMessage.get(key));
      else byMessage.set(key, i);
    }
    const followUpId = String(item && item.followUpId || "").trim();
    if (type && followUpId) {
      const key = `${type}|${followUpId}`;
      if (byFollow.has(key)) union(i, byFollow.get(key));
      else byFollow.set(key, i);
    }
    const identity = chargeIdentity(item);
    if (!identity) return;
    const key = `${identity.type}|${identity.loadNumber}|${identity.reason}`;
    if (!byCharge.has(key)) byCharge.set(key, []);
    byCharge.get(key).push({i, cents: identity.cents});
  });

  for (const bucket of byCharge.values()) {
    bucket.sort((a, b) => a.cents - b.cents);
    for (let i = 1; i < bucket.length; i++) {
      if (bucket[i].cents - bucket[i - 1].cents <= AMOUNT_TOLERANCE_CENTS) {
        union(bucket[i].i, bucket[i - 1].i);
      }
    }
  }

  const groups = new Map();
  const order = [];
  list.forEach((item, i) => {
    const root = find(i);
    if (!groups.has(root)) {
      groups.set(root, []);
      order.push(root);
    }
    groups.get(root).push(item);
  });
  return order.map((root) => groups.get(root));
}

/**
 * @param {object[]} group Duplicate items.
 * @return {object}
 */
function pickPreferredDuplicate(group) {
  return group.reduce((best, item) =>
    compareDuplicatePreference(item, best) > 0 ? item : best);
}

/**
 * Collapses exact duplicate rows. Prefers an in-dispute copy, otherwise
 * the newest received email (or createdAt when received time is absent).
 * @param {object[]} items Items.
 * @return {object[]}
 */
function collapseExactDuplicateItems(items) {
  if (!Array.isArray(items)) return [];
  if (items.length < 2) return items.slice();
  return groupExactDuplicates(items).map(pickPreferredDuplicate);
}

/**
 * @param {object[]} items Open items that can be dismissed.
 * @return {{keep: object[], dismiss: object[]}}
 */
function selectDuplicateDismissals(items) {
  const keep = [];
  const dismiss = [];
  for (const group of groupExactDuplicates(items)) {
    if (!group.length) continue;
    if (group.length < 2) {
      keep.push(group[0]);
      continue;
    }
    const winner = pickPreferredDuplicate(group);
    keep.push(winner);
    for (const item of group) {
      if (item.id !== winner.id) dismiss.push(item);
    }
  }
  return {keep, dismiss};
}

module.exports = {
  AMOUNT_TOLERANCE_CENTS,
  timestampMs,
  itemRecencyMs,
  normalizeReason,
  amountCents,
  amountsWithinTolerance,
  chargeIdentity,
  sameExactCharge,
  isDisputeItem,
  compareDuplicatePreference,
  isExactDuplicateItem,
  groupExactDuplicates,
  pickPreferredDuplicate,
  collapseExactDuplicateItems,
  selectDuplicateDismissals,
};
