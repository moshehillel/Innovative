/**
 * Once-a-day email of dashboard notifications that are still open.
 * One digest per Innovative tenant per Eastern calendar day. A retry,
 * a second scheduler delivery, or a deploy must not send another copy.
 * The accounting intake mailbox is never a recipient: Jerry reads that
 * inbox, and a copy there comes back as a new message.
 */

"use strict";

const admin = require("firebase-admin");
const scope = require("./dashboard-scope");
const ownership = require("./dashboard-ownership");

/** Mailbox Jerry reads. A digest sent here re-enters intake. */
const INTAKE_MAILBOX = "accounting@innovativecarriers.com";
const LISA_EMAIL = "lisa@innovativecarriers.com";

/**
 * Jerry's own scheduled mail. These are not human tasks.
 * Matched on subject/title and on the outbound email type.
 */
const SYSTEM_EMAIL_TYPES = new Set([
  "dashboard_notification_digest",
  "daily_inbox_digest",
  "daily_activity_report",
  "daily_ignored_emails_report",
  "daily_broker_swap_report",
  "delivered_uninvoiced_report",
  "undelivered_shipment_report",
]);

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
  if (isIntakeAddress(key)) return;
  if (seen.has(key)) return;
  seen.add(key);
  into.add(match[0]);
}

/**
 * Addresses that must never receive this digest. The intake mailbox is
 * accounting@ plus PRIMUS_UI_EMAIL_FROM when that sender is configured.
 * @return {Set<string>}
 */
function intakeAddressSet() {
  const set = new Set([INTAKE_MAILBOX]);
  const configured = String(process.env.PRIMUS_UI_EMAIL_FROM || "")
      .trim()
      .toLowerCase();
  if (configured) set.add(configured);
  return set;
}

/**
 * @param {string} value Raw address or "Name <email>".
 * @return {boolean}
 */
function isIntakeAddress(value) {
  const text = String(value || "").trim().toLowerCase();
  const match = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  if (!match) return false;
  return intakeAddressSet().has(match[0].toLowerCase());
}

/**
 * Lisa and Sarah, plus a dispatcher only when that address is already
 * the item's dispatcher and is not the intake mailbox.
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
    addEmail(LISA_EMAIL, into, seen);
    addEmail(ownership.sarahEmail(), into, seen);
  } else {
    addEmail(tenant.alertEmail, into, seen);
  }
  (items || []).forEach((item) => {
    if (!item || !item.dispatcherEmail) return;
    if (isIntakeAddress(item.dispatcherEmail)) return;
    addEmail(item.dispatcherEmail, into, seen);
  });
  if (!tenantId || tenantId === "default") {
    ownership.OPS_DISPATCHERS.forEach((person) => {
      addEmail(person.email, into, seen);
    });
  }
  return [...into].filter((email) => !isIntakeAddress(email));
}

/**
 * @param {object} row Notification or mail fields.
 * @return {string}
 */
function rowText(row) {
  if (!row) return "";
  return [row.subject, row.title, row.reason, row.emailType, row.type]
      .filter((part) => part != null && String(part).trim())
      .join("\n");
}

/**
 * True for Jerry's own reports and for this digest. Real action items
 * (approval, POD, rate, margin, mark-delivered) stay in the list.
 * @param {object} row Notification.
 * @return {boolean}
 */
function isJerrySystemNotification(row) {
  const type = String((row && (row.emailType || row.type)) || "")
      .toLowerCase();
  if (SYSTEM_EMAIL_TYPES.has(type)) return true;
  const text = rowText(row);
  if (/jerry ignored emails/i.test(text)) return true;
  if (/jerry inbox digest/i.test(text)) return true;
  if (/jerry broker commission swaps/i.test(text)) return true;
  if (/jerry daily activity/i.test(text)) return true;
  if (/unfinished notif/i.test(text)) return true;
  if (/past eta/i.test(text)) return true;
  if (/past-due shipments waiting on invoice/i.test(text)) return true;
  if (/missing delivery date/i.test(text)) return true;
  if (/delivered \+ /i.test(text) && /not invoiced/i.test(text)) return true;
  return false;
}

/**
 * True when an inbox message is this digest (including a Re: copy).
 * Intake must drop it instead of opening a notification or replying.
 * @param {object} mail subject, title, body, html, emailType, type.
 * @return {boolean}
 */
function isInboundDigestEmail(mail) {
  const type = String((mail && (mail.emailType || mail.type)) || "")
      .toLowerCase();
  if (type === "dashboard_notification_digest") return true;
  const subject = String((mail && (mail.subject || mail.title)) || "");
  if (/unfinished notif/i.test(subject)) return true;
  const body = String((mail && (mail.body || mail.html || "")) || "");
  if (/unfinished notification/i.test(body) && /jerry dashboard/i.test(body)) {
    return true;
  }
  return false;
}

/**
 * Cron is 30 7 * * * America/New_York. Only that hour may send.
 * A retry later in the day, or a deploy, is outside this window.
 * @param {Date} now Clock.
 * @return {boolean}
 */
function inScheduledSendWindow(now) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now || new Date());
  const hourPart = parts.find((part) => part.type === "hour");
  const hour = Number(hourPart && hourPart.value);
  return hour === 7;
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
  const count = items.length;
  const countLabel = `${count} unfinished notification(s)`;
  return `<p>${countLabel} are still open as of ` +
    `${escapeHtml(dateLabel)} (Eastern). ` +
    `All ${count} are listed below, and each one is on the ` +
    `Jerry dashboard.</p>` +
    `<table style="border-collapse:collapse;font-size:13px">` +
    `<thead><tr>` +
    `<th style="text-align:left;padding:6px 8px;border:1px solid #e5e7eb">Load</th>` +
    `<th style="text-align:left;padding:6px 8px;border:1px solid #e5e7eb">Subject / reason</th>` +
    `<th style="text-align:left;padding:6px 8px;border:1px solid #e5e7eb">Waiting on</th>` +
    `<th style="text-align:left;padding:6px 8px;border:1px solid #e5e7eb">Age</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>` +
    `<p style="color:#6b7280;font-size:12px">${countLabel}. ` +
    `This email lists every one of them.</p>`;
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
 * Claims the calendar day. Any existing claim for that day blocks another
 * send, including status "error" and a stale "sending" lock.
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
    if (prev.sentDate === dateKey) return false;
    tx.set(ref, {
      tenantId: tenant.tenantId,
      sentDate: dateKey,
      status: "sent",
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
    return true;
  });
}

/**
 * Records how the claimed day finished. Does not clear sentDate, so a
 * later retry still will not send.
 * @param {object} tenant Tenant.
 * @param {string} dateKey Day.
 * @param {string} outcome sent or error.
 * @param {object} [extra] Optional fields.
 * @return {Promise<void>}
 */
async function finishDay(tenant, dateKey, outcome, extra) {
  await deps.db.collection("settings")
      .doc(`dashboardNotificationDigest_${tenant.tenantId}`)
      .set({
        tenantId: tenant.tenantId,
        sentDate: dateKey,
        status: "sent",
        outcome: outcome || "sent",
        ...(extra || {}),
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
  if (!inScheduledSendWindow(now)) {
    return {
      dateKey,
      skipped: true,
      reason: "outside_send_window",
      results: [],
    };
  }
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
        all: true,
        sort: "newest",
        urgentFirst: false,
      });
      const open = (listed.notifications || [])
          .filter((row) => scope.isOpenNotification(row))
          .filter((row) => scope.rowBelongsToTenant(row, tenant.tenantId) ||
            ownership.sameTenant(row.tenantId, tenant.tenantId))
          .filter((row) => !isJerrySystemNotification(row));
      const recipients = digestRecipients(tenant, open);
      if (!open.length || !recipients.length) {
        await finishDay(tenant, dateKey, "sent", {
          open: open.length,
          recipients: recipients.length,
        });
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
        cc: null,
        subject: `Jerry — ${open.length} unfinished notification(s) — ${label}`,
        html: digestHtml(open, label),
      });
      await finishDay(tenant, dateKey, "sent", {
        open: open.length,
        recipients: recipients.length,
      });
      results.push({
        tenantId: tenant.tenantId,
        sent: true,
        open: open.length,
        recipients: recipients.length,
      });
    } catch (err) {
      await finishDay(tenant, dateKey, "error", {
        error: err.message,
      }).catch(() => {});
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
  isIntakeAddress,
  isJerrySystemNotification,
  isInboundDigestEmail,
  inScheduledSendWindow,
  runDailyNotificationDigest,
};
