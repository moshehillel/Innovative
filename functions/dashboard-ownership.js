/**
 * Dashboard ownership routing — Accounting / Sarah / Dispatch buckets.
 */

"use strict";

const OWNER_BUCKET = Object.freeze({
  ACCOUNTING: "accounting",
  SARAH: "sarah",
  DISPATCH: "dispatch",
});

/** People the work queue is divided by. Emails follow the company pattern. */
const OPS_DISPATCHERS = Object.freeze([
  {key: "leo", name: "Leo", email: "leo@innovativecarriers.com",
    aliases: ["leo", "leom"]},
  {key: "jak", name: "Jak", email: "jak@innovativecarriers.com",
    aliases: ["jak", "jack"]},
  {key: "tina", name: "Tina", email: "tina@innovativecarriers.com",
    aliases: ["tina"]},
  {key: "jason", name: "Jason", email: "jason@innovativecarriers.com",
    aliases: ["jason", "jasons"]},
  {key: "alex", name: "Alex", email: "alex@innovativecarriers.com",
    aliases: ["alex"]},
  {key: "jay", name: "Jay", email: "jay@innovativecarriers.com",
    aliases: ["jay"]},
  {key: "karen", name: "Karen", email: "karen@innovativecarriers.com",
    aliases: ["karen"]},
  {key: "barry", name: "Barry", email: "barry@innovativecarriers.com",
    aliases: ["barry"]},
  {key: "leah", name: "Leah", email: "leah@innovativecarriers.com",
    aliases: ["leah"]},
]);

/**
 * Match a To/Cc address to a named dispatcher.
 * @param {string[]} addresses Normalized emails.
 * @return {object|null}
 */
function matchRosterFromAddresses(addresses) {
  const list = Array.isArray(addresses) ? addresses : [];
  for (const addr of list) {
    const local = String(addr || "").split("@")[0].replace(/[^a-z0-9]/g, "");
    const hit = OPS_DISPATCHERS.find((person) => {
      if (person.email === addr) return true;
      return person.aliases.some((alias) => alias === local);
    });
    if (hit) return hit;
  }
  return null;
}

/**
 * Who the email was sent To, then Cc.
 * @param {object} opts to, cc.
 * @return {object|null}
 */
function rosterOwnerFromMail(opts) {
  const toHit = matchRosterFromAddresses(splitEmails(opts && opts.to));
  if (toHit) return toHit;
  return matchRosterFromAddresses(splitEmails(opts && opts.cc));
}

/**
 * Empty tenant ids are the legacy default tenant. They are never "every tenant".
 * @param {string|null|undefined} value Stored or requested tenant id.
 * @return {string}
 */
function canonicalTenantId(value) {
  const id = String(value == null ? "" : value).trim();
  return id || "default";
}

/**
 * @param {string|null|undefined} rowTenantId Tenant stored on the row.
 * @param {string|null|undefined} callerTenantId Tenant of the caller.
 * @return {boolean}
 */
function sameTenant(rowTenantId, callerTenantId) {
  return canonicalTenantId(rowTenantId) === canonicalTenantId(callerTenantId);
}

/**
 * @param {string|null|undefined} type Task or email type.
 * @return {boolean}
 */
function isMissingRateType(type) {
  const value = String(type || "").trim().toLowerCase();
  return value === "missing_rate" || value === "rate_missing";
}

/**
 * True for an invoice hold where the carrier/customer rate is missing.
 * Low-margin pauses share the rate-review stage and stay off this path.
 * @param {object} inv Invoice fields.
 * @return {boolean}
 */
function isMissingCarrierRateHold(inv) {
  if (!inv || typeof inv !== "object") return false;
  const stage = String(inv.decisionStage || "").toLowerCase();
  const wf = String(inv.finalWorkflowStatus || "").toLowerCase();
  if (wf === "completed" || stage === "completed") return false;
  const onRateHold = stage === "needs_customer_rate_review" ||
    wf === "needs_customer_rate_review";
  if (!onRateHold) return false;
  const rate = Number(inv.customerRate || 0);
  if (Number.isFinite(rate) && rate > 0) return false;
  const reason = String(inv.decisionReason || "").toLowerCase();
  if (/too low|low margin|low_margin/.test(reason)) return false;
  return true;
}

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
  const typeEarly = String(opts.type || opts.emailType || "").toLowerCase();
  // Missing carrier rate is dispatcher work even when Lisa is CC'd.
  if (isMissingRateType(typeEarly)) {
    const rateDispatcherEmail = normEmail(opts.dispatcherEmail);
    const rateDispatcherName = opts.dispatcherName ?
      String(opts.dispatcherName).trim() : null;
    return {
      ownerBucket: OWNER_BUCKET.DISPATCH,
      awaitingReplyFrom: OWNER_BUCKET.DISPATCH,
      dispatcherEmail: rateDispatcherEmail || null,
      dispatcherName: rateDispatcherName || null,
      dispatcherKey: rateDispatcherEmail ||
        (rateDispatcherName ? rateDispatcherName.toLowerCase() : null),
    };
  }

  const rosterHit = rosterOwnerFromMail(opts);
  if (rosterHit) {
    return {
      ownerBucket: OWNER_BUCKET.DISPATCH,
      awaitingReplyFrom: OWNER_BUCKET.DISPATCH,
      dispatcherEmail: rosterHit.email,
      dispatcherName: rosterHit.name,
      dispatcherKey: rosterHit.key,
    };
  }

  const dispatcherEmail = normEmail(opts.dispatcherEmail);
  const dispatcherName = opts.dispatcherName ?
    String(opts.dispatcherName).trim() : null;
  const dispatcherKey = dispatcherEmail ||
    (dispatcherName ? dispatcherName.toLowerCase() : null);
  const forced = String(opts.ownerBucket || "").toLowerCase();
  if (Object.values(OWNER_BUCKET).includes(forced)) {
    return {
      ownerBucket: forced,
      awaitingReplyFrom: forced,
      dispatcherEmail: dispatcherEmail || null,
      dispatcherName,
      dispatcherKey,
    };
  }

  const toList = splitEmails(opts.to);
  const ccList = splitEmails(opts.cc);
  const all = new Set([...toList, ...ccList]);
  const sarah = sarahEmail();
  const accounting = accountingEmails();

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
  const named = OPS_DISPATCHERS.find((p) => p.key === out.dispatcherKey);
  const rosterHit = named || rosterOwnerFromMail(out);
  if (rosterHit) {
    out.ownerBucket = OWNER_BUCKET.DISPATCH;
    out.awaitingReplyFrom = out.awaitingReplyFrom || OWNER_BUCKET.DISPATCH;
    out.dispatcherEmail = rosterHit.email;
    out.dispatcherName = rosterHit.name;
    out.dispatcherKey = rosterHit.key;
  } else if (!out.ownerBucket) {
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
  const ageStamp = out.receivedAt || out.createdAt;
  const createdMs = ageStamp ? Date.parse(ageStamp) : 0;
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
  for (const person of OPS_DISPATCHERS) {
    dispatchers.set(person.key, {
      key: person.key,
      name: person.name,
      email: person.email,
      openCount: 0,
      urgentCount: 0,
    });
  }
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
function queueSortTime(item) {
  return Date.parse((item && (item.receivedAt || item.createdAt)) || "") || 0;
}

function queueSortAmount(item) {
  const raw = item && (item.chargesTotal != null ?
    item.chargesTotal : item.invoiceAmount);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function filterSortPaginate(items, opts) {
  const ownerBucket = opts.ownerBucket ?
    String(opts.ownerBucket).toLowerCase() : null;
  const dispatcherKey = opts.dispatcherKey ?
    String(opts.dispatcherKey).toLowerCase() : null;
  const offset = Math.max(0, Number(opts.offset) || 0);
  const cap = Math.min(Math.max(Number(opts.maxLimit) || 100, 1), 5000);
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), cap);
  const sort = String(opts.sort || "").toLowerCase();
  // Newest / oldest / amount must page in that order. Urgent-first would
  // fill the first page with old rows and hide newer work.
  const urgentFirst = sort === "newest" || sort === "oldest" ||
      sort === "amount" ? false :
    (sort === "urgent" || opts.urgentFirst !== false);

  let list = items.map(applyOwnerDefaults);
  const summaries = buildOwnerSummaries(list);

  if (ownerBucket) {
    list = list.filter((t) => t.ownerBucket === ownerBucket);
  }
  if (dispatcherKey) {
    list = list.filter((t) => t.dispatcherKey === dispatcherKey);
  }

  list.sort((a, b) => {
    if (sort === "amount") return queueSortAmount(b) - queueSortAmount(a);
    if (urgentFirst) {
      if (Boolean(a.isUrgentOld) !== Boolean(b.isUrgentOld)) {
        return a.isUrgentOld ? -1 : 1;
      }
    }
    const ta = queueSortTime(a);
    const tb = queueSortTime(b);
    return sort === "oldest" ? ta - tb : tb - ta;
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
  OPS_DISPATCHERS,
  URGENT_AGE_MS,
  canonicalTenantId,
  sameTenant,
  isMissingRateType,
  isMissingCarrierRateHold,
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
