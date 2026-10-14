/**
 * Dashboard tenant lock, issue types, and queue merge.
 *
 * Origin map matches the CORS comment in index.js: the Innovative Netlify
 * site is the default (Primus) tenant; advancedautomations.net is the other
 * client (AA) and must not read Innovative collections.
 */

"use strict";

const ORIGIN_TENANTS = Object.freeze({
  "https://innovative-jerry.netlify.app": "default",
  "https://www.advancedautomations.net": "aa",
});

const ISSUE = Object.freeze({
  ALL: "all",
  CHARGE_MISMATCH: "charge_mismatch",
  MISSING_POD: "missing_pod",
  MISSING_RATE: "missing_rate",
  MISCELLANEOUS: "miscellaneous",
});

const ISSUE_LABELS = Object.freeze({
  charge_mismatch: "Carrier charges don't match",
  missing_pod: "Missing POD",
  missing_rate: "Missing customer rate",
  miscellaneous: "Miscellaneous",
});

/**
 * @param {string} origin Origin header.
 * @return {string}
 */
function normalizeOrigin(origin) {
  const raw = String(origin || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch (err) {
    return raw.replace(/\/$/, "").toLowerCase();
  }
}

/**
 * @param {string} origin Browser Origin.
 * @return {string|null|false} Tenant id, null when no origin, false when
 *   the origin is not a known dashboard.
 */
function tenantIdForDashboardOrigin(origin) {
  const key = normalizeOrigin(origin);
  if (!key) return null;
  const found = Object.keys(ORIGIN_TENANTS).find(
      (item) => item.toLowerCase() === key);
  if (!found) return false;
  return ORIGIN_TENANTS[found];
}

/**
 * Legacy rows with no tenantId belong only to the Innovative default tenant.
 * @param {object} row Document data.
 * @param {string} tenantId Tenant id.
 * @return {boolean}
 */
function rowBelongsToTenant(row, tenantId) {
  const want = String(tenantId || "default");
  const stamped = row && row.tenantId != null ?
    String(row.tenantId).trim() : "";
  if (!stamped) return want === "default";
  return stamped === want;
}

/**
 * @param {object} tenant Tenant config.
 * @param {string} base Collection base name.
 * @return {string}
 */
function collectionName(tenant, base) {
  const prefix = tenant && tenant.collectionPrefix ?
    String(tenant.collectionPrefix).trim() : "";
  return prefix ? `${prefix}_${base}` : String(base);
}

/**
 * @param {object} item Task, notification, or invoice row.
 * @return {boolean} True when a dispatcher must enter or answer a rate.
 */
function isRateHold(item) {
  const type = String(
      (item && (item.type || item.emailType || item.code)) || "",
  ).toLowerCase();
  const reason = String((item && item.reason) || "").toLowerCase();
  const stage = String(
      (item && (item.workflowStatus || item.decisionStage)) || "",
  ).toLowerCase();
  if (type === "additional_charge" || type === "signed_pod" ||
      type === "pod_discrepancy" || type === "unhandled_email" ||
      type === "human_review") {
    return false;
  }
  if (type === "missing_rate" || type === "rate_missing" ||
      type === "low_margin") {
    return true;
  }
  if (item && (item.code === "MISSING_RATE" || item.code === "LOW_MARGIN")) {
    return true;
  }
  if (/missing customer rate|customer rate too low/.test(reason)) return true;
  if (reason === "missing_rate" || reason === "low_margin" ||
      reason === "rate_missing") {
    return true;
  }
  return stage === "needs_customer_rate_review";
}

/**
 * @param {object} item Row.
 * @return {string} Issue id.
 */
function classifyIssue(item) {
  const type = String((item && (item.type || item.emailType)) || "")
      .toLowerCase();
  const blob = [
    item && item.reason,
    item && item.decisionReason,
    item && item.decisionStage,
    item && item.displayStatus,
    item && item.finalWorkflowStatus,
    item && item.title,
    type,
  ].join(" ").toLowerCase();

  if (type === "additional_charge" ||
      /additional charge|charge mismatch/.test(blob)) {
    return ISSUE.CHARGE_MISMATCH;
  }
  if (type === "signed_pod" || type === "pod_discrepancy" ||
      type === "missing_pod" ||
      /missing_pod|needs_pod|awaiting_pod|pod discrep|signed pod/.test(blob)) {
    return ISSUE.MISSING_POD;
  }
  const lowMargin = type === "low_margin" ||
    /low_margin|customer rate too low|rate too low/.test(blob);
  const missingRate = type === "missing_rate" || type === "rate_missing" ||
    /needs_customer_rate|missing_rate|missing customer rate/.test(blob);
  if (missingRate && !lowMargin) return ISSUE.MISSING_RATE;
  if (lowMargin) return ISSUE.MISCELLANEOUS;
  if (missingRate) return ISSUE.MISSING_RATE;
  return ISSUE.MISCELLANEOUS;
}

/**
 * @param {string} issue Issue id.
 * @return {string}
 */
function issueLabel(issue) {
  return ISSUE_LABELS[issue] || "Miscellaneous";
}

/**
 * @param {object} item Row.
 * @param {string} query Name, email, or dispatcher key. Blank matches all.
 * @return {boolean}
 */
function dispatcherMatches(item, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const fields = [
    item && item.dispatcherKey,
    item && item.dispatcherEmail,
    item && item.dispatcherName,
  ];
  return fields.some((value) => {
    const text = String(value || "").trim().toLowerCase();
    return text && (text === q || text.includes(q));
  });
}

/**
 * @param {object} item Row with issueType.
 * @return {string}
 */
function queueDedupeKey(item) {
  const load = String((item && item.loadNumber) || "").trim().toLowerCase();
  const issue = (item && item.issueType) || classifyIssue(item);
  if (load) return `${load}|${issue}`;
  return `id:${(item && item.source) || "row"}:${item && item.id}`;
}

/**
 * One row per load + issue. A dashboard task wins over an invoice hold.
 * @param {object[]} items Rows.
 * @return {object[]}
 */
function mergeQueueItems(items) {
  const map = new Map();
  for (const raw of items || []) {
    const issueType = raw.issueType || classifyIssue(raw);
    const item = {...raw, issueType, issueLabel: issueLabel(issueType)};
    const key = queueDedupeKey(item);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, item);
      continue;
    }
    const prevScore = prev.source === "invoice" ? 0 : 1;
    const nextScore = item.source === "invoice" ? 0 : 1;
    const preferNext = nextScore > prevScore;
    const keep = preferNext ? {...item} : {...prev};
    const other = preferNext ? prev : item;
    keep.dispatcherEmail = keep.dispatcherEmail || other.dispatcherEmail || null;
    keep.dispatcherName = keep.dispatcherName || other.dispatcherName || null;
    keep.dispatcherKey = keep.dispatcherKey || other.dispatcherKey || null;
    keep.ownerBucket = keep.ownerBucket || other.ownerBucket || null;
    keep.invoiceId = keep.invoiceId || other.invoiceId || null;
    keep.taskId = keep.taskId || other.taskId ||
      (other.source && other.source !== "invoice" ? other.id : null);
    if (!keep.receivedAt) keep.receivedAt = other.receivedAt || null;
    if (!keep.reason) keep.reason = other.reason || null;
    map.set(key, keep);
  }
  return [...map.values()];
}

/**
 * @param {Date} [now] Clock.
 * @return {string} YYYY-MM-DD in America/New_York.
 */
function nyDateKey(now) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now || new Date());
}

/**
 * @param {string|null} iso Timestamp.
 * @param {number} [nowMs] Clock ms.
 * @return {number|null}
 */
function ageDays(iso, nowMs) {
  const ms = Date.parse(iso || "");
  if (!Number.isFinite(ms)) return null;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return Math.max(0, Math.floor((now - ms) / 86400000));
}

/**
 * Open notifications only. Ignored-mail statuses never belong in the digest.
 * @param {object} row Notification.
 * @return {boolean}
 */
function isOpenNotification(row) {
  const status = String((row && row.status) || "open").toLowerCase();
  if (status !== "open") return false;
  const marker = String(
      (row && (row.emailType || row.reason || row.type)) || "",
  ).toLowerCase();
  if (/_ignored\b/.test(marker) || marker.endsWith("_ignored")) return false;
  return true;
}

/**
 * Digest recipients for one tenant. Innovative ops addresses are not added
 * for any other tenant. Customer To/CC addresses are not recipients.
 * @param {object} opts tenantId, opsEmails, tenantAlertEmails, items.
 * @return {string[]}
 */
function digestRecipientEmails(opts) {
  const tenantId = String((opts && opts.tenantId) || "default");
  const seen = new Set();
  const out = [];
  const add = (value) => {
    const matches = String(value || "")
        .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    for (const email of matches) {
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(email);
    }
  };
  if (tenantId === "default") {
    (opts.opsEmails || []).forEach(add);
  } else {
    (opts.tenantAlertEmails || []).forEach(add);
  }
  (opts.items || []).forEach((item) => add(item && item.dispatcherEmail));
  return out;
}

/**
 * @param {object} inv Mapped or raw invoice.
 * @return {boolean} True when the invoice is an open human hold.
 */
function invoiceHoldIssue(inv) {
  if (!inv) return null;
  const stage = `${inv.displayStatus || ""} ${inv.decisionStage || ""} ` +
    `${inv.finalWorkflowStatus || ""} ${inv.decisionReason || ""}`
        .toLowerCase();
  if (/completed/.test(stage) && !/not completed/.test(stage)) {
    if (inv.isCompleted) return null;
  }
  if (inv.isCompleted) return null;
  if (/missing_pod|needs_pod|awaiting_pod/.test(stage) &&
      !/signed_pod|pod_request/.test(stage)) {
    return ISSUE.MISSING_POD;
  }
  const lowMargin = /low_margin|too low|rate too low/.test(stage);
  const missingRate = /needs_customer_rate|missing_rate|missing customer rate/
      .test(stage);
  if (missingRate && !lowMargin) return ISSUE.MISSING_RATE;
  if (lowMargin || missingRate) return ISSUE.MISCELLANEOUS;
  return null;
}

module.exports = {
  ORIGIN_TENANTS,
  ISSUE,
  ISSUE_LABELS,
  normalizeOrigin,
  tenantIdForDashboardOrigin,
  rowBelongsToTenant,
  collectionName,
  isRateHold,
  classifyIssue,
  issueLabel,
  dispatcherMatches,
  queueDedupeKey,
  mergeQueueItems,
  nyDateKey,
  ageDays,
  isOpenNotification,
  digestRecipientEmails,
  invoiceHoldIssue,
};
