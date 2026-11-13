#!/usr/bin/env node
/**
 * Re-queue inbox messages from a cutoff time for reprocessing.
 *
 * Finds message IDs from Firestore intake records (and optionally the live
 * mailbox), clears prior intake state, and sets queue status to queued.
 *
 * Usage:
 *   node scripts/bulk-requeue-inbox-since.js --since "2026-08-05T15:40:00-04:00"
 *   node scripts/bulk-requeue-inbox-since.js --since "2026-08-05T15:40:00-04:00" --dry-run
 *   node scripts/bulk-requeue-inbox-since.js --scan-inbox --since "2026-08-05T15:40:00-04:00"
 *   node scripts/bulk-requeue-inbox-since.js --scan-inbox --include-read --since "2026-08-05T15:40:00-04:00"
 *   node scripts/bulk-requeue-inbox-since.js --read-after --since "2026-08-05T15:40:00-04:00" --until "2026-08-06T14:00:00-04:00"
 *   node scripts/bulk-requeue-inbox-since.js --skip-queued --scan-inbox --read-after --since "2026-08-05T15:40:00-04:00"
 *
 * --read-after: mail marked read between --since and --until (both required).
 *   Outlook uses lastModifiedDateTime as read-time proxy. Implies --scan-inbox.
 *
 * Cloud (when local Firestore fails behind NetFree):
 *   bulkRequeueInbox?tenantId=default&readAfter=1&since=2026-08-05T15:40:00-04:00&until=2026-08-06T14:00:00-04:00&dryRun=1
 */
"use strict";

const admin = require("firebase-admin");
const {runBulkRequeue} = require("../bulk-requeue-inbox");
const mailProvider = require("../mail-provider");

const DEFAULT_TENANT = Object.freeze({
  tenantId: "default",
  collectionPrefix: "",
});

/** @return {object} */
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    since: null,
    dryRun: false,
    scanInbox: false,
    includeRead: false,
    readAfter: false,
    until: null,
    skipQueued: false,
    tenantId: "default",
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--scan-inbox") opts.scanInbox = true;
    else if (a === "--include-read") opts.includeRead = true;
    else if (a === "--read-after") opts.readAfter = true;
    else if (a === "--skip-queued") opts.skipQueued = true;
    else if (a === "--since") opts.since = args[++i];
    else if (a === "--until") opts.until = args[++i];
    else if (a === "--tenant-id") opts.tenantId = args[++i];
    else if (a.startsWith("--")) {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    } else if (!opts.since) {
      opts.since = a;
    }
  }
  if (!opts.since) {
    const et = new Date();
    et.setDate(et.getDate() - 1);
    et.setHours(15, 40, 0, 0);
    opts.since = et.toLocaleString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).replace(/(\d+)\/(\d+)\/(\d+),\s(\d+):(\d+):(\d+)/,
        (_, mo, da, yr, hr, mi, se) =>
          `${yr}-${mo}-${da}T${hr}:${mi}:${se}-04:00`);
  }
  return opts;
}

(async () => {
  const opts = parseArgs();
  const since = new Date(opts.since);
  if (isNaN(since.getTime())) {
    console.error(`Invalid --since: ${opts.since}`);
    process.exit(1);
  }

  if (!admin.apps.length) {
    admin.initializeApp();
  }
  mailProvider.init({db: admin.firestore()});

  const tenant = opts.tenantId === "default" ?
    DEFAULT_TENANT :
    Object.assign({}, DEFAULT_TENANT, {
      tenantId: opts.tenantId,
      collectionPrefix: opts.tenantId,
    });

  if (opts.readAfter) {
    opts.scanInbox = true;
    opts.includeRead = true;
  }

  const until = opts.until ? new Date(opts.until) : null;
  if (opts.readAfter && (!until || isNaN(until.getTime()))) {
    console.error("--read-after requires --until (read-time upper bound)");
    process.exit(1);
  }

  console.log("Bulk re-queue inbox messages");
  console.log("  tenant:", tenant.tenantId);
  console.log("  since:", since.toISOString(), `(${opts.since})`);
  if (until) {
    console.log("  until:", until.toISOString(), `(${opts.until})`);
  }
  console.log("  dryRun:", opts.dryRun);
  console.log("  scanInbox:", opts.scanInbox);
  console.log("  includeRead:", opts.includeRead);
  console.log("  readAfter:", opts.readAfter,
      opts.readAfter ? "(Outlook lastModifiedDateTime when marked read)" : "");
  console.log("  skipQueued:", opts.skipQueued);

  const summary = await runBulkRequeue({
    tenant,
    since,
    until,
    dryRun: opts.dryRun,
    scanInbox: opts.scanInbox,
    includeRead: opts.includeRead,
    readAfter: opts.readAfter,
    skipQueued: opts.skipQueued,
    db: admin.firestore(),
  });

  if (summary.error) {
    console.error(summary.message || summary.error);
    process.exit(1);
  }

  if (summary.mailError === "mail_not_connected") {
    console.warn("Mail not connected — reconnect inbox in dashboard first");
  }
  if (!opts.readAfter) {
    console.log(`Firestore intake records since cutoff: ${summary.intakeCount}`);
  } else {
    console.log("Skipping Firestore intake — --read-after uses mailbox read time only");
  }
  if (opts.scanInbox) {
    console.log(`Mailbox scan matches since cutoff: ${summary.mailboxCount}`);
    if (opts.readAfter) {
      console.log("  (matched by read/last-modified time, not received time)");
    }
  }

  console.log(`Unique parent messages to re-queue: ${summary.uniqueCount}`);
  if (summary.uniqueCount === 0) {
    console.log("Nothing to do.");
    process.exit(0);
  }

  for (const r of summary.results) {
    console.log(JSON.stringify(r));
  }

  console.log(`Done. Re-queued ${summary.requeued} message(s).`);
  if (summary.skipped) {
    console.log(`Skipped ${summary.skipped} already in queue.`);
  }
  if (!opts.dryRun) {
    console.log("Next: queue drains via process-gmail-queue-http (every 5m).");
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
