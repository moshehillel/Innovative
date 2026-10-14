/**
 * Once-a-day email of dashboard notifications that are still open.
 * One digest per tenant. Innovative recipients are never used for another
 * tenant, and another tenant's notifications are never included.
 */

"use strict";

const admin = require("firebase-admin");
const scope = require("./dashboard-scope");
const ownership = require("./dashboard-ownership");

let deps = {};

/**
 * @param {object} bundle db, listNotifications, saveOutboundEmail, getActiveTenants.
 * @return {void}
 */
function init(bundle) {
  deps = bundle || {};
}

/**
 * @param {string} value Address.
 * @param {Set<string>} into Set of original-case addresses.
 * @param {Set<string>} seen Lowercase keys.
 * @return {void}
 */
function addEmail(value, into, seen) {
  const text = String(value || "").trim();
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (!match) return;
  const key = match[0].toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  into.add(match[0]);
}

/**
 * Innovative ops people plus dispatcher emails on this tenant's open items.
 * Other tenants only get their own alert address and their own dispatchers.
 * @param {object} tenant Tenant.
 * @param {object[]} items Open notifications.
 * @return {string[]}
 */
function digestRecipients(tenant, items) {
  const into = new Set();
  const seen = new Set();
  const tenantId = tenant && tenant.tenantId;
  if (!tenantId || tenantId === "default") {
    ownership.accountingEmails().forEach((email) => addEmail(email, into, seen));
    addEmail(ownership.sarahEmail(), into, seen);
  } else {
    addEmail(tenant.alertEmail, into, seen);
  }
  (items || []).forEach((item) => addEmail(item.dispatcherEmail, into, seen));
  return [...into];
}

/**
 * @param {object[]} items Open notifications.
 * @param {string} dateLabel Calendar label.
 * @return {string}
 */
function digestHtml(items, dateLabel) {
  const rows = items.map((item) => {
    const when = item.receivedAt || item.createdAt;
    const days = scope.ageDays(when);
    const age = days == null ? "—" : (days === 0 ? "today" : `${days}d`);
    const waiting = item.dispatcherName || item.dispatcherEmail ||
      item.awaitingReplyFrom || item.ownerBucket || "—";
    const what = item.subject || item.title || item.reason || "(no subject)";
    return `<tr>` +
      `<td style="padding:6px 8px;border:1px solid #e5e7eb">` +
      `${escapeHtml(item.loadNumber || "—")}</td>` +
      `<td style="padding:6px 8px;border:1px solid #e5e7eb">` +
      `${escapeHtml(what)}</td>` +
      `<td style="padding:6px 8px;border:1px solid #e5e7eb">` +
      `${escapeHtml(waiting)}</td>` +
      `<td style="padding:6px 8px;border:1px solid #e5e7eb">${age}</td>` +
      `</tr>`;
  }).join("");
  return `<p>These dashboard notifications are still open as of ` +
    `${escapeHtml(dateLabel)} (Eastern). They are on the Jerry dashboard.</p>` +
    `<table style="border-collapse:collapse;font-size:13px">` +
    `<thead><tr>` +
    `<th style="text-align:left;padding:6px 8px;border:1px solid #e5e7eb">Load</th>` +
    `<th style="text-align:left;padding:6px 8px;border:1px solid #e5e7eb">Subject / reason</th>` +
    `<th style="text-align:left;padding:6px 8px;border:1px solid #e5e7eb">Waiting on</th>` +
    `<th style="text-align:left;padding:6px 8px;border:1px solid #e5e7eb">Age</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>` +
    `<p style="color:#6b7280;font-size:12px">${items.length} unfinished notification(s).</p>`;
}

/**
 * @param {*} value Text.
 * @return {string}
 */
function escapeHtml(value) {
  return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
}

/**
 * Claims the calendar day so a retry does not send a second copy.
 * @param {object} tenant Tenant.
 * @param {string} dateKey YYYY-MM-DD Eastern.
 * @return {Promise<boolean>} True when this run should send.
 */
async function claimDay(tenant, dateKey) {
  const ref = deps.db.collection("settings")
      .doc(`dashboardNotificationDigest_${tenant.tenantId}`);
  return deps.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? (snap.data() || {}) : {};
    if (prev.sentDate === dateKey && prev.status === "sent") return false;
    if (prev.sentDate === dateKey && prev.status === "sending") {
      const started = prev.startedAt && prev.startedAt.toMillis ?
        prev.startedAt.toMillis() : 0;
      if (started && Date.now() - started < 20 * 60 * 1000) return false;
    }
    tx.set(ref, {
      tenantId: tenant.tenantId,
      sentDate: dateKey,
      status: "sending",
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
    return true;
  });
}

/**
 * @param {object} tenant Tenant.
 * @param {string} dateKey Day.
 * @param {string} status sent or error.
 * @return {Promise<void>}
 */
async function finishDay(tenant, dateKey, status) {
  await deps.db.collection("settings")
      .doc(`dashboardNotificationDigest_${tenant.tenantId}`)
      .set({
        tenantId: tenant.tenantId,
        sentDate: dateKey,
        status,
        finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
}

/**
 * @param {object} [opts] now, tenants.
 * @return {Promise<object>}
 */
async function runDailyNotificationDigest(opts) {
  const now = (opts && opts.now) || new Date();
  const dateKey = scope.nyDateKey(now);
  const tenants = (opts && opts.tenants) ||
    await deps.getActiveTenants();
  const results = [];
  for (const tenant of tenants) {
    const claimed = await claimDay(tenant, dateKey);
    if (!claimed) {
      results.push({tenantId: tenant.tenantId, skipped: true});
      continue;
    }
    try {
      const listed = await deps.listNotifications(deps.db, {
        tenantId: tenant.tenantId,
        collectionPrefix: tenant.collectionPrefix,
        limit: 2000,
        maxLimit: 2000,
        offset: 0,
        urgentFirst: false,
      });
      const open = (listed.notifications || [])
          .filter((row) => scope.isOpenNotification(row))
          .filter((row) => scope.rowBelongsToTenant(row, tenant.tenantId) ||
            ownership.sameTenant(row.tenantId, tenant.tenantId));
      const recipients = digestRecipients(tenant, open);
      if (!open.length || !recipients.length) {
        await finishDay(tenant, dateKey, "sent");
        results.push({
          tenantId: tenant.tenantId,
          sent: false,
          open: open.length,
          recipients: recipients.length,
        });
        continue;
      }
      const label = now.toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      await deps.saveOutboundEmail({
        type: "dashboard_notification_digest",
        forceSend: true,
        forceRecipient: true,
        tenant,
        to: recipients.join(", "),
        subject: `Jerry — ${open.length} unfinished notification(s) — ${label}`,
        html: digestHtml(open, label),
      });
      await finishDay(tenant, dateKey, "sent");
      results.push({
        tenantId: tenant.tenantId,
        sent: true,
        open: open.length,
        recipients: recipients.length,
      });
    } catch (err) {
      await finishDay(tenant, dateKey, "error").catch(() => {});
      results.push({
        tenantId: tenant.tenantId,
        error: err.message,
      });
    }
  }
  return {dateKey, results};
}

module.exports = {
  init,
  digestRecipients,
  digestHtml,
  runDailyNotificationDigest,
};
