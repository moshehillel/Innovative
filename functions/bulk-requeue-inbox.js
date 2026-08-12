"use strict";

const mailIntakeQueue = require("./mail-intake-queue");
const mailProvider = require("./mail-provider");

/**
 * @param {object} tenant Tenant config.
 * @param {FirebaseFirestore.Firestore} db Firestore instance.
 * @param {string} name Collection name.
 * @return {FirebaseFirestore.CollectionReference}
 */
function tcol(tenant, db, name) {
  const prefix = tenant.collectionPrefix ?
    `${tenant.collectionPrefix}_` : "";
  return db.collection(`${prefix}${name}`);
}

/**
 * @param {object} tenant Tenant config.
 * @param {FirebaseFirestore.Firestore} db Firestore instance.
 * @param {Date} since Cutoff.
 * @return {Promise<Array<object>>}
 */
async function listIntakeSince(tenant, db, since) {
  const admin = require("firebase-admin");
  const sinceTs = admin.firestore.Timestamp.fromDate(since);
  const snap = await tcol(tenant, db, "emailIntake")
      .where("discoveredAt", ">=", sinceTs)
      .orderBy("discoveredAt", "asc")
      .limit(500)
      .get();
  const rows = snap.docs.map((doc) =>
    Object.assign({id: doc.id}, doc.data() || {}));

  if (rows.length > 0) return rows;

  const legacySnap = await tcol(tenant, db, "emailIntake")
      .where("createdAt", ">=", sinceTs)
      .orderBy("createdAt", "asc")
      .limit(500)
      .get();
  return legacySnap.docs.map((doc) =>
    Object.assign({id: doc.id}, doc.data() || {}));
}

const MAILBOX_SCAN_MAX = 1000;

/**
 * @param {object} tenant Tenant config.
 * @param {Date} since Read-time lower bound (inclusive).
 * @param {Date|null} [until] Read-time upper bound (inclusive).
 * @param {boolean} [includeRead] Include read Outlook mail.
 * @param {boolean} [readAfter] Filter by read/last-modified time.
 * @param {string} [readMode] openedSince | modified | received
 * @return {Promise<object>}
 */
async function listMailboxSince(
    tenant, since, until, includeRead, readAfter, readMode) {
  const mail = await mailProvider.getTenantMailClient(tenant);
  if (!mail) {
    return {error: "mail_not_connected", rows: []};
  }

  const mode = String(readMode || "openedSince").toLowerCase();
  const sinceMs = since.getTime();
  const untilMs = until && !isNaN(until.getTime()) ? until.getTime() : null;
  const qAfter = new Date(sinceMs);
  const afterClause = `after:${qAfter.getFullYear()}/` +
    `${qAfter.getMonth() + 1}/${qAfter.getDate()}`;
  const query = readAfter ? "in:inbox" : ["in:inbox", afterClause].join(" ");

  const found = [];
  const seenIds = new Set();
  let pageToken = null;
  let truncated = false;
  do {
    const listResponse = await mail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 100,
      pageToken: pageToken || undefined,
      includeRead: Boolean(includeRead || readAfter),
      readAfter: readAfter ? since : undefined,
      readBefore: readAfter && mode === "received" && until ? until : undefined,
      readMode: mode,
    });
    const batch = listResponse.data.messages || [];
    for (const item of batch) {
      if (seenIds.has(item.id)) continue;
      const full = await mail.users.messages.get({
        userId: "me",
        id: item.id,
        format: "metadata",
        metadataHeaders: ["Subject", "From"],
      });
      const readMs = Number(full.data.internalDate || 0);
      const receivedMs = full.data.receivedDateTime ?
        new Date(full.data.receivedDateTime).getTime() : 0;

      if (mode === "received") {
        if (receivedMs && receivedMs < sinceMs) continue;
        if (untilMs && receivedMs && receivedMs > untilMs) continue;
      } else if (mode === "modified") {
        if (readMs && readMs < sinceMs) continue;
        if (untilMs && readMs && readMs > untilMs) continue;
      } else {
        // openedSince: read/marked since cutoff; no until cap (mail touched
        // after until still counts if first opened in the session).
        if (readMs && readMs < sinceMs) continue;
      }
      if (readAfter && full.data.isRead === false) continue;

      seenIds.add(item.id);
      const headers = (full.data.payload && full.data.payload.headers) || [];
      const subject = (headers.find((h) => h.name === "Subject") || {}).value ||
        "";
      const from = (headers.find((h) => h.name === "From") || {}).value || "";
      found.push({
        id: item.id,
        subject,
        from,
        readAtMs: readMs || null,
        receivedAtMs: receivedMs || null,
      });
      if (found.length >= MAILBOX_SCAN_MAX) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
    pageToken = listResponse.data.nextPageToken || null;
  } while (pageToken);

  return {rows: found, truncated, readMode: mode};
}

/**
 * @param {object} tenant Tenant config.
 * @param {FirebaseFirestore.Firestore} db Firestore instance.
 * @param {string} messageId Parent message id.
 * @param {object} meta Optional subject/from.
 * @param {boolean} dryRun Dry run.
 * @param {boolean} [skipQueued] Skip if already queued/processing/completed.
 * @return {Promise<object>}
 */
async function requeueMessage(tenant, db, messageId, meta, dryRun, skipQueued) {
  const admin = require("firebase-admin");
  const parentId = String(messageId);
  if (mailIntakeQueue.isChildQueueDocId(parentId)) {
    return {messageId: parentId, skipped: true, reason: "child_doc_id"};
  }

  const queueCol = tcol(tenant, db, "gmailQueue");
  const parentQueueRef = queueCol.doc(parentId);
  const parentSnap = await parentQueueRef.get();
  const existingStatus = parentSnap.exists ?
    String((parentSnap.data() || {}).status || "") : "";

  if (skipQueued && existingStatus &&
      existingStatus !== "failed") {
    return {
      messageId: parentId,
      skipped: true,
      reason: "already_in_queue",
      status: existingStatus,
      subject: meta && meta.subject,
    };
  }

  const intakeRef = tcol(tenant, db, "emailIntake").doc(parentId);
  const relatedSnap = await queueCol
      .where("gmailMessageId", "==", parentId)
      .get();

  const childIds = relatedSnap.docs
      .map((d) => d.id)
      .filter((id) => id !== parentId);

  if (dryRun) {
    return {
      messageId: parentId,
      dryRun: true,
      childDocs: childIds.length,
      subject: meta && meta.subject,
    };
  }

  await intakeRef.delete().catch(() => undefined);

  for (const childId of childIds) {
    await queueCol.doc(childId).delete().catch(() => undefined);
  }

  const now = admin.firestore.FieldValue.serverTimestamp();

  if (parentSnap.exists) {
    await parentQueueRef.set({
      status: "queued",
      intakeStatus: "queued",
      reprocessRequestedAt: now,
      updatedAt: now,
      completedChildCount: admin.firestore.FieldValue.delete(),
      childCount: admin.firestore.FieldValue.delete(),
      outcome: admin.firestore.FieldValue.delete(),
      summary: admin.firestore.FieldValue.delete(),
      error: admin.firestore.FieldValue.delete(),
    }, {merge: true});
    return {messageId: parentId, action: "reset_existing_queue"};
  }

  const enq = await mailIntakeQueue.enqueueDiscoveredEmail({
    tenant,
    messageId: parentId,
    subject: (meta && meta.subject) || "",
    from: (meta && meta.from) || "",
    inboxFlowId: `bulk-requeue-${Date.now()}`,
  });
  return {messageId: parentId, action: "enqueued", enq};
}

/**
 * @param {object} opts Run options.
 * @return {Promise<object>}
 */
async function runBulkRequeue(opts) {
  const {
    tenant,
    since,
    until = null,
    dryRun = false,
    scanInbox = false,
    includeRead = false,
    readAfter = false,
    readMode = "openedSince",
    skipQueued = false,
    db,
  } = opts;

  if (readAfter && (!until || isNaN(until.getTime())) &&
      String(readMode).toLowerCase() !== "openedsince") {
    return {
      ok: false,
      error: "read_after_requires_until",
      message: "readAfter with readMode=modified|received requires until",
    };
  }
  if (until && since && until.getTime() < since.getTime()) {
    return {
      ok: false,
      error: "invalid_window",
      message: "until must be after since",
    };
  }

  const effective = {
    scanInbox: scanInbox || readAfter,
    includeRead: includeRead || readAfter,
    readAfter,
  };

  /** @type {Map<string, {subject: string, from: string}>} */
  const ids = new Map();
  let intakeCount = 0;
  let mailboxCount = 0;
  let mailError = null;

  if (!readAfter) {
    const intakeRows = await listIntakeSince(tenant, db, since);
    intakeCount = intakeRows.length;
    for (const row of intakeRows) {
      if (mailIntakeQueue.isChildQueueDocId(row.id)) continue;
      ids.set(row.id, {
        subject: row.subject || "",
        from: row.from || "",
      });
    }
  }

  let mailboxTruncated = false;
  let mailboxReadMode = readMode;

  if (effective.scanInbox) {
    const mailbox = await listMailboxSince(
        tenant, since, until, effective.includeRead, effective.readAfter,
        readMode);
    if (mailbox.error) {
      mailError = mailbox.error;
    } else {
      mailboxCount = mailbox.rows.length;
      mailboxTruncated = Boolean(mailbox.truncated);
      mailboxReadMode = mailbox.readMode || readMode;
      for (const row of mailbox.rows) {
        if (!ids.has(row.id)) {
          ids.set(row.id, {subject: row.subject, from: row.from});
        }
      }
    }
  }

  const results = [];
  for (const [messageId, meta] of ids) {
    try {
      const r = await requeueMessage(
          tenant, db, messageId, meta, dryRun, skipQueued);
      results.push(r);
    } catch (err) {
      results.push({messageId, error: err.message});
    }
  }

  const requeued = results.filter((r) => !r.error && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;

  return {
    ok: !mailError,
    tenantId: tenant.tenantId,
    since: since.toISOString(),
    until: until ? until.toISOString() : null,
    dryRun,
    skipQueued,
    readAfter: effective.readAfter,
    readMode: mailboxReadMode,
    scanInbox: effective.scanInbox,
    intakeCount,
    mailboxCount,
    mailboxTruncated,
    uniqueCount: ids.size,
    requeued,
    skipped,
    mailError,
    results,
  };
}

module.exports = {
  runBulkRequeue,
  requeueMessage,
};
