/**
 * Dashboard ownership routing — Accounting / Sarah / Dispatch buckets.
 */

"use strict";

const OWNER_BUCKET = Object.freeze({
  ACCOUNTING: "accounting",
  SARAH: "sarah",
  DISPATCH: "dispatch",
});

const URGENT_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * @param {string|null|undefined} value Email or name.
 * @return {string}
 */
function normEmail(value) {
  const s = String(value || "").trim().toLowerCase();
  const m = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0].toLowerCase() : s;
}

/**
 * @param {string|string[]|null|undefined} value To/CC list.
 * @return {string[]}
 */
function splitEmails(value) {
  if (Array.isArray(value)) {
    return value.map(normEmail).filter(Boolean);
  }
  return String(value || "")
      .split(/[,;]/)
      .map(normEmail)
      .filter(Boolean);
}

/**
 * @return {string}
 */
function sarahEmail() {
  return normEmail(
      process.env.ADDITIONAL_CHARGE_APPROVER_EMAIL ||
      "Sarah@innovativecarriers.com");
}

/**
 * @return {Set<string>}
 */
function accountingEmails() {
  const list = [
    process.env.LOW_PROFIT_CC_EMAIL,
    process.env.HUMAN_REVIEW_EMAIL,
    process.env.INVOICE_VETO_REVIEW_EMAIL,
    process.env.REVIEW_EMAIL_BILLING,
    process.env.REVIEW_EMAIL_OPERATIONS,
    process.env.REVIEW_EMAIL_STATEMENT,
    "Lisa@innovativecarriers.com",
    "accounting@innovativecarriers.com",
  ];
  return new Set(list.map(normEmail).filter(Boolean));
}

/**
 * Classifies who owns a dashboard item from recipients / type.
 * @param {object} opts to, cc, department, emailType, type,
 *   dispatcherEmail, dispatcherName, ownerBucket (force).
 * @return {object}
 */
function classifyDashboardOwner(opts) {
  const forced = String(opts.ownerBucket || "").toLowerCase();
  if (Object.values(OWNER_BUCKET).includes(forced)) {
    return {
      ownerBucket: forced,
      awaitingReplyFrom: forced,
      dispatcherEmail: normEmail(opts.dispatcherEmail) || null,
      dispatcherName: opts.dispatcherName || null,
      dispatcherKey: normEmail(opts.dispatcherEmail) ||
        String(opts.dispatcherName || "").trim().toLowerCase() || null,
    };
  }

  const toList = splitEmails(opts.to);
  const ccList = splitEmails(opts.cc);
  const all = new Set([...toList, ...ccList]);
  const sarah = sarahEmail();
  const accounting = accountingEmails();
  const dispatcherEmail = normEmail(opts.dispatcherEmail);
  const dispatcherName = opts.dispatcherName ?
    String(opts.dispatcherName).trim() : null;

  const hasSarah = all.has(sarah) || toList.includes(sarah);
  const hasDispatcher = Boolean(dispatcherEmail && all.has(dispatcherEmail));
  const hasAccounting = [...all].some((e) => accounting.has(e));

  const type = String(opts.type || opts.emailType || "").toLowerCase();
  const department = String(opts.department || "").toLowerCase();
  const isUnhandled = type === "unhandled_email" ||
    type === "human_review" ||
    opts.emailType === "human_review";

  let ownerBucket = OWNER_BUCKET.ACCOUNTING;
  if (hasSarah && hasDispatcher) {
    ownerBucket = OWNER_BUCKET.SARAH;
  } else if (hasSarah && !hasDispatcher) {
    ownerBucket = OWNER_BUCKET.SARAH;
  } else if (hasDispatcher && !hasSarah && !hasAccounting) {
    ownerBucket = OWNER_BUCKET.DISPATCH;
  } else if (isUnhandled || hasAccounting || department) {
    ownerBucket = OWNER_BUCKET.ACCOUNTING;
  } else if (type === "additional_charge") {
    // Default charge approvals go to Sarah.
    ownerBucket = OWNER_BUCKET.SARAH;
  } else if (type === "signed_pod" || type === "pod_discrepancy") {
    ownerBucket = OWNER_BUCKET.ACCOUNTING;
  }

  const dispatcherKey = dispatcherEmail ||
    (dispatcherName ? dispatcherName.toLowerCase() : null);

  return {
    ownerBucket,
    awaitingReplyFrom: ownerBucket,
    dispatcherEmail: dispatcherEmail || null,
    dispatcherName: dispatcherName || null,
    dispatcherKey,
  };
}

/**
 * @param {object} item Serialized task/notif.
 * @return {object} item with ownership + urgent flags filled.
 */
function applyOwnerDefaults(item) {
  const out = {...item};
  if (!out.ownerBucket) {
    const classified = classifyDashboardOwner(out);
    out.ownerBucket = classified.ownerBucket;
    out.awaitingReplyFrom = out.awaitingReplyFrom ||
      classified.awaitingReplyFrom;
    out.dispatcherEmail = out.dispatcherEmail || classified.dispatcherEmail;
    out.dispatcherName = out.dispatcherName || classified.dispatcherName;
    out.dispatcherKey = out.dispatcherKey || classified.dispatcherKey;
  } else {
    out.dispatcherKey = out.dispatcherKey ||
      normEmail(out.dispatcherEmail) ||
      (out.dispatcherName ?
        String(out.dispatcherName).trim().toLowerCase() : null);
    out.awaitingReplyFrom = out.awaitingReplyFrom || out.ownerBucket;
  }
  const createdMs = out.createdAt ? Date.parse(out.createdAt) : 0;
  out.isUrgentOld = Boolean(createdMs &&
    (Date.now() - createdMs) >= URGENT_AGE_MS);
  out.ageLabel = out.isUrgentOld ? "URGENT/OLD" : null;
  return out;
}

/**
 * Ownership fields to persist on create.
 * @param {object} data Create payload.
 * @return {object}
 */
function ownershipFieldsForCreate(data) {
  const classified = classifyDashboardOwner(data);
  const history = Array.isArray(data.ownershipHistory) ?
    data.ownershipHistory.slice() : [];
  history.push({
    bucket: classified.ownerBucket,
    at: new Date().toISOString(),
    reason: data.ownershipReason || "created",
  });
  return {
    ownerBucket: classified.ownerBucket,
    awaitingReplyFrom: classified.awaitingReplyFrom,
    dispatcherEmail: classified.dispatcherEmail,
    dispatcherName: classified.dispatcherName,
    dispatcherKey: classified.dispatcherKey,
    ownershipHistory: history,
  };
}

/**
 * Builds Firestore update for Sarah → Dispatch handoff.
 * @param {object} current Current doc data.
 * @param {object} [extra] option, actor.
 * @return {object}
 */
function handoffToDispatchUpdate(current, extra) {
  const history = Array.isArray(current.ownershipHistory) ?
    current.ownershipHistory.slice() : [];
  history.push({
    bucket: OWNER_BUCKET.DISPATCH,
    at: new Date().toISOString(),
    reason: (extra && extra.reason) || "sarah_dashboard_action",
    option: (extra && extra.option) || null,
  });
  return {
    ownerBucket: OWNER_BUCKET.DISPATCH,
    awaitingReplyFrom: OWNER_BUCKET.DISPATCH,
    ownershipHistory: history,
    updatedAt: require("firebase-admin").firestore.FieldValue
        .serverTimestamp(),
  };
}

/**
 * Summarize bucket / dispatcher folder counts.
 * @param {object[]} items Tasks or notifications.
 * @return {object}
 */
function buildOwnerSummaries(items) {
  const buckets = {
    accounting: {openCount: 0, urgentCount: 0},
    sarah: {openCount: 0, urgentCount: 0},
    dispatch: {openCount: 0, urgentCount: 0},
  };
  const dispatchers = new Map();
  for (const raw of items) {
    const item = applyOwnerDefaults(raw);
    const bucket = item.ownerBucket || OWNER_BUCKET.ACCOUNTING;
    if (!buckets[bucket]) {
      buckets[bucket] = {openCount: 0, urgentCount: 0};
    }
    buckets[bucket].openCount += 1;
    if (item.isUrgentOld) buckets[bucket].urgentCount += 1;
    if (bucket === OWNER_BUCKET.DISPATCH && item.dispatcherKey) {
      const key = item.dispatcherKey;
      if (!dispatchers.has(key)) {
        dispatchers.set(key, {
          key,
          name: item.dispatcherName || item.dispatcherEmail || key,
          email: item.dispatcherEmail || null,
          openCount: 0,
          urgentCount: 0,
        });
      }
      const folder = dispatchers.get(key);
      folder.openCount += 1;
      if (item.isUrgentOld) folder.urgentCount += 1;
    }
  }
  return {
    bucketCounts: buckets,
    dispatchers: [...dispatchers.values()]
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
  };
}

/**
 * Filter + sort + paginate owned items.
 * @param {object[]} items Items.
 * @param {object} opts ownerBucket, dispatcherKey, offset, limit, urgentFirst.
 * @return {object}
 */
function filterSortPaginate(items, opts) {
  const ownerBucket = opts.ownerBucket ?
    String(opts.ownerBucket).toLowerCase() : null;
  const dispatcherKey = opts.dispatcherKey ?
    String(opts.dispatcherKey).toLowerCase() : null;
  const offset = Math.max(0, Number(opts.offset) || 0);
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
  const urgentFirst = opts.urgentFirst !== false;

  let list = items.map(applyOwnerDefaults);
  const summaries = buildOwnerSummaries(list);

  if (ownerBucket) {
    list = list.filter((t) => t.ownerBucket === ownerBucket);
  }
  if (dispatcherKey) {
    list = list.filter((t) => t.dispatcherKey === dispatcherKey);
  }

  list.sort((a, b) => {
    if (urgentFirst) {
      if (a.isUrgentOld !== b.isUrgentOld) {
        return a.isUrgentOld ? -1 : 1;
      }
    }
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  });

  const totalFiltered = list.length;
  const page = list.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    items: page,
    openCount: summaries.bucketCounts.accounting.openCount +
      summaries.bucketCounts.sarah.openCount +
      summaries.bucketCounts.dispatch.openCount,
    filteredCount: totalFiltered,
    hasMore: nextOffset < totalFiltered,
    nextOffset,
    offset,
    limit,
    bucketCounts: summaries.bucketCounts,
    dispatchers: summaries.dispatchers,
  };
}

module.exports = {
  OWNER_BUCKET,
  URGENT_AGE_MS,
  normEmail,
  splitEmails,
  sarahEmail,
  accountingEmails,
  classifyDashboardOwner,
  applyOwnerDefaults,
  ownershipFieldsForCreate,
  handoffToDispatchUpdate,
  buildOwnerSummaries,
  filterSortPaginate,
};
