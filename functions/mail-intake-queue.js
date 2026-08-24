/**
 * Mail intake queue — discover emails, document outcomes, split multi-invoice
 * emails into per-invoice child jobs, and build human-readable summaries.
 */

"use strict";

const admin = require("firebase-admin");

const DOC_TYPE = Object.freeze({
  EMAIL: "email",
  INVOICE_ITEM: "invoice_item",
});

const QUEUE_STATUS = Object.freeze({
  QUEUED: "queued",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
  WAITING_CHILDREN: "waiting_children",
});

const OUTCOME = Object.freeze({
  PROCESSED: "processed",
  IGNORED: "ignored",
  FORWARDED: "forwarded",
  PARTIAL: "partial",
  FAILED: "failed",
  SPLIT: "split",
});

/** Firestore TTL for emailIntake / gmailQueue docs, from discovery time. */
const INTAKE_TTL_DAYS = 60;

/** Searchable outcomeReason values for system/workflow crashes. */
const OUTCOME_REASON = Object.freeze({
  WORKFLOW_FAILED: "workflow_failed",
  SYSTEM_ERROR: "system_error",
});

/**
 * @param {string} parentMessageId Parent message id.
 * @param {number} itemIndex Invoice item index.
 * @return {string} Child queue document id.
 */
function childQueueDocId(parentMessageId, itemIndex) {
  return `${String(parentMessageId)}__item_${itemIndex}`;
}

/**
 * @param {string} docId Queue document id.
 * @return {boolean} True when doc id is a split child job.
 */
function isChildQueueDocId(docId) {
  return /__item_\d+$/.test(String(docId || ""));
}

/**
 * @param {object} tenant Tenant config.
 * @param {string} collection Collection name.
 * @return {FirebaseFirestore.CollectionReference}
 */
function col(tenant, collection) {
  const db = admin.firestore();
  const prefix = tenant && tenant.tenantId && tenant.tenantId !== "default" ?
    `${tenant.tenantId}_` : "";
  return db.collection(`${prefix}${collection}`);
}

/**
 * @param {number} [days=INTAKE_TTL_DAYS] TTL days for intake docs.
 * @return {FirebaseFirestore.Timestamp}
 */
function deleteAt(days) {
  const ms = Date.now() + Number(days || INTAKE_TTL_DAYS) * 24 * 60 * 60 * 1000;
  return admin.firestore.Timestamp.fromDate(new Date(ms));
}

/**
 * Formats an email receive timestamp for ops (ET, date + time + seconds).
 * Prefers Graph receivedDateTime over discovered/process time.
 * @param {object} data Intake / queue fields.
 * @return {string|null}
 */
function formatReceivedAtEt(data) {
  const d = data || {};
  const raw = d.receivedDateTime || d.receivedAt || null;
  let date = null;
  if (raw && typeof raw.toDate === "function") {
    date = raw.toDate();
  } else if (typeof raw === "string" && raw.trim()) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  } else if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    date = raw;
  }
  if (!date) return null;
  return date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }) + " ET";
}

/**
 * Builds a one-line human summary from intake fields.
 * @param {object} data Intake / queue fields.
 * @return {string}
 */
function buildIntakeSummary(data) {
  const d = data || {};
  if (d.summary && !d._rebuildSummary) return String(d.summary);

  const finalStatus = d.finalStatus || d.outcomeReason || null;
  const itemSummaries = Array.isArray(d.itemSummaries) ? d.itemSummaries : [];
  const ignoreReason = d.ignoreReason || null;
  const childCount = Number(d.childCount || 0);
  const completedChildCount = Number(d.completedChildCount || 0);
  const receivedLabel = formatReceivedAtEt(d);

  let core = null;

  if (d.outcome === OUTCOME.SPLIT ||
      d.status === QUEUE_STATUS.WAITING_CHILDREN) {
    core = `Split into ${childCount} invoice job(s) for processing.`;
  } else if (ignoreReason) {
    core = `Ignored — ${ignoreReason}`;
  } else {
    const statusSummary = {
      payment_notification_ignored:
        "Ignored — payment notification (Zelle/bank)",
      emodal_broadcast_ignored: "Ignored — eModal/terminal broadcast",
      noa_ignored: "Ignored — notice of assignment, no invoice",
      carrier_portal_notification_ignored:
        "Ignored — carrier open-invoice portal (link only)",
      credit_agency_notification_ignored:
        "Ignored — credit-agency / trade-credit alert",
      past_due_only: "Ignored — past-due statement already in Primus",
      statement_ignored_abe_cc: "Ignored — carrier statement (Abe on CC)",
      statement_forwarded: "Forwarded — carrier statement, no freight invoice",
      hafstaff_forwarded_to_lisa: "Forwarded — Hafstaff to Lisa (ops rule)",
      no_attachment: "Forwarded — no attachments",
      no_invoice_pdf: "Forwarded — no processable invoice PDF",
      workflow_failed: "Failed — invoice workflow system error",
      system_error: "Failed — invoice workflow system error",
    };
    if (finalStatus && statusSummary[finalStatus]) {
      core = statusSummary[finalStatus];
    } else if (itemSummaries.length > 0) {
      const processed = itemSummaries.filter((s) =>
        s && s.finalStatus === "processing" && s.invoiceId).length;
      const skipped = itemSummaries.filter((s) =>
        s && s.finalStatus === "already_billed_skipped").length;
      const other = itemSummaries.length - processed - skipped;
      const parts = [];
      if (processed) parts.push(`processed ${processed} invoice(s)`);
      if (skipped) parts.push(`${skipped} skipped (already in Primus)`);
      if (other) parts.push(`${other} other outcome(s)`);
      if (parts.length) core = `Processed email — ${parts.join("; ")}`;
    }
  }

  if (!core) {
    if (childCount > 0 && completedChildCount >= childCount) {
      core = `Completed ${completedChildCount} invoice job(s) from this email.`;
    } else if (finalStatus === "processing") {
      core = "Processed — invoice workflow started.";
    } else if (finalStatus === "additional_charge_pending_approval") {
      core = "Additional charge — awaiting A/B/C/D approval.";
    } else if (finalStatus === "already_billed_skipped") {
      core = "Skipped — load(s) already billed in Primus.";
    } else if (d.outcome === OUTCOME.FORWARDED) {
      core = d.forwardReason ?
        `Forwarded — ${d.forwardReason}` : "Forwarded for human review.";
    } else if (d.outcome === OUTCOME.FAILED) {
      core = d.error ? `Failed — ${String(d.error).slice(0, 120)}` :
        "Failed during processing.";
    } else {
      core = finalStatus ?
        `Completed — ${String(finalStatus).replace(/_/g, " ")}` :
        "Completed.";
    }
  }

  if (receivedLabel && core && !/received /i.test(core)) {
    return `${core} · received ${receivedLabel}`;
  }
  return core;
}

/**
 * @param {object} tenant Tenant config.
 * @param {string} messageId Message ID.
 * @return {Promise<boolean>}
 */
async function isAlreadyDiscovered(tenant, messageId) {
  const intakeRef = col(tenant, "emailIntake").doc(String(messageId));
  const queueRef = col(tenant, "gmailQueue").doc(String(messageId));
  const [intakeSnap, queueSnap] = await Promise.all([
    intakeRef.get(),
    queueRef.get(),
  ]);
  if (intakeSnap.exists) {
    const status = (intakeSnap.data() || {}).intakeStatus ||
      (intakeSnap.data() || {}).status;
    if (status && status !== "failed") return true;
  }
  if (queueSnap.exists) {
    const qStatus = (queueSnap.data() || {}).status;
    if (qStatus && qStatus !== "failed") return true;
  }
  return false;
}

/**
 * Stage 1: document a newly seen email and queue it for the worker.
 * @param {object} opts Options.
 * @param {object} opts.tenant Tenant config.
 * @param {string} opts.messageId Message id.
 * @param {string} [opts.subject] Subject line.
 * @param {string} [opts.from] Sender.
 * @param {string} [opts.receivedDateTime] Graph receivedDateTime ISO string.
 * @param {string} [opts.inboxFlowId] Flow id.
 * @return {Promise<object>} Enqueue result with ok flag.
 */
async function enqueueDiscoveredEmail(opts) {
  const tenant = opts.tenant;
  const messageId = String(opts.messageId || "");
  if (!messageId) return {ok: false, reason: "missing_message_id"};

  if (await isAlreadyDiscovered(tenant, messageId)) {
    return {ok: false, reason: "already_discovered"};
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const receivedRaw = opts.receivedDateTime || opts.receivedAt || null;
  let receivedDateTime = null;
  if (receivedRaw) {
    const parsed = receivedRaw instanceof Date ?
      receivedRaw : new Date(String(receivedRaw));
    if (!Number.isNaN(parsed.getTime())) {
      receivedDateTime = admin.firestore.Timestamp.fromDate(parsed);
    }
  }
  const payload = {
    gmailMessageId: messageId,
    tenantId: tenant.tenantId,
    docType: DOC_TYPE.EMAIL,
    subject: String(opts.subject || "").slice(0, 500),
    from: String(opts.from || "").slice(0, 500),
    intakeStatus: QUEUE_STATUS.QUEUED,
    status: QUEUE_STATUS.QUEUED,
    outcome: null,
    summary: null,
    discoveredAt: now,
    claimedAt: now,
    createdAt: now,
    updatedAt: now,
    inboxFlowId: opts.inboxFlowId || null,
    deleteAt: deleteAt(INTAKE_TTL_DAYS),
  };
  if (receivedDateTime) {
    payload.receivedDateTime = receivedDateTime;
  }

  const intakeRef = col(tenant, "emailIntake").doc(messageId);
  const queueRef = col(tenant, "gmailQueue").doc(messageId);

  await admin.firestore().runTransaction(async (tx) => {
    const intakeSnap = await tx.get(intakeRef);
    if (intakeSnap.exists) {
      const existing = intakeSnap.data() || {};
      if (existing.intakeStatus && existing.intakeStatus !== "failed") {
        throw new Error("already_discovered");
      }
    }
    tx.set(intakeRef, payload, {merge: true});
    tx.set(queueRef, payload, {merge: true});
  });

  return {ok: true};
}

/**
 * Parses Graph/ISO received timestamps into a Firestore Timestamp.
 * @param {*} receivedRaw ISO string, Date, or Timestamp-like.
 * @return {FirebaseFirestore.Timestamp|null}
 */
function toReceivedTimestamp(receivedRaw) {
  if (!receivedRaw) return null;
  if (typeof receivedRaw.toDate === "function") {
    try {
      const d = receivedRaw.toDate();
      if (d && !Number.isNaN(d.getTime())) {
        return admin.firestore.Timestamp.fromDate(d);
      }
    } catch (_e) {
      return null;
    }
  }
  const parsed = receivedRaw instanceof Date ?
    receivedRaw : new Date(String(receivedRaw));
  if (Number.isNaN(parsed.getTime())) return null;
  return admin.firestore.Timestamp.fromDate(parsed);
}

/**
 * Backfills receivedDateTime on parent intake + queue when missing.
 * Does not overwrite an existing value. Safe to call for child queue docs
 * (patches parent by messageId and optionally the child queue doc).
 * @param {object} tenant Tenant config.
 * @param {string} messageId Parent Graph/Gmail message id.
 * @param {*} receivedRaw Graph receivedDateTime ISO string / Date.
 * @param {object} [opts]
 * @param {string} [opts.queueDocId] Queue doc id (parent or child).
 * @return {Promise<FirebaseFirestore.Timestamp|null>} Persisted or existing ts.
 */
async function persistReceivedDateTimeIfMissing(
    tenant, messageId, receivedRaw, opts = {}) {
  const parentId = String(messageId || "");
  if (!parentId) return null;
  const ts = toReceivedTimestamp(receivedRaw);
  if (!ts) return null;

  const intakeRef = col(tenant, "emailIntake").doc(parentId);
  const parentQueueRef = col(tenant, "gmailQueue").doc(parentId);
  const intakeSnap = await intakeRef.get();
  const existing = intakeSnap.exists ? (intakeSnap.data() || {}) : {};
  if (existing.receivedDateTime || existing.receivedAt) {
    return existing.receivedDateTime || existing.receivedAt;
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const patch = {receivedDateTime: ts, updatedAt: now};
  const writes = [
    intakeRef.set(patch, {merge: true}),
    parentQueueRef.set(patch, {merge: true}),
  ];
  const queueDocId = opts.queueDocId ? String(opts.queueDocId) : "";
  if (queueDocId && queueDocId !== parentId) {
    writes.push(
        col(tenant, "gmailQueue").doc(queueDocId).set(patch, {merge: true}));
  }
  await Promise.all(writes);
  return ts;
}

/**
 * Marks intake + queue as processing.
 * @param {object} tenant Tenant config.
 * @param {string} docId Queue doc id (parent or child).
 * @return {Promise<void>}
 */
async function markIntakeProcessing(tenant, docId) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  const patch = {
    intakeStatus: QUEUE_STATUS.PROCESSING,
    status: QUEUE_STATUS.PROCESSING,
    processingStartedAt: now,
    updatedAt: now,
  };
  await col(tenant, "gmailQueue").doc(docId).set(patch, {merge: true});
  const data = (await col(tenant, "gmailQueue").doc(docId).get()).data() || {};
  const parentId = data.parentMessageId || docId;
  if (isChildQueueDocId(docId)) {
    await col(tenant, "gmailQueue").doc(docId).set(patch, {merge: true});
  } else {
    await col(tenant, "emailIntake").doc(parentId).set(patch, {merge: true});
    await col(tenant, "gmailQueue").doc(docId).set(patch, {merge: true});
  }
}

/**
 * Writes terminal outcome + summary on queue doc and parent intake.
 * @param {object} opts Options.
 * @return {Promise<void>}
 */
async function completeIntakeRecord(opts) {
  const tenant = opts.tenant;
  const docId = String(opts.docId || "");
  const parentMessageId = opts.parentMessageId ||
    (isChildQueueDocId(docId) ?
      docId.replace(/__item_\d+$/, "") : docId);
  const existingSnap = await col(tenant, "emailIntake")
      .doc(parentMessageId).get();
  const existing = existingSnap.exists ? (existingSnap.data() || {}) : {};
  const summary = opts.summary ||
    buildIntakeSummary(Object.assign({}, existing, opts, opts.extra));
  const now = admin.firestore.FieldValue.serverTimestamp();
  const patch = Object.assign({
    intakeStatus: QUEUE_STATUS.COMPLETED,
    status: QUEUE_STATUS.COMPLETED,
    outcome: opts.outcome || OUTCOME.PROCESSED,
    outcomeReason: opts.outcomeReason || opts.finalStatus || null,
    summary,
    finishedAt: now,
    updatedAt: now,
  }, opts.extra || {});

  await col(tenant, "gmailQueue").doc(docId).set(patch, {merge: true});

  if (isChildQueueDocId(docId)) {
    await incrementParentChildCompletion(tenant, parentMessageId, opts);
    return;
  }

  await col(tenant, "emailIntake").doc(parentMessageId).set(
      Object.assign({}, patch, {
        gmailMessageId: parentMessageId,
        tenantId: tenant.tenantId,
      }), {merge: true});
}

/**
 * Resolves parent emailIntake id and gmailQueue id from an invoice.
 * @param {object} invoice Invoice document data.
 * @return {{parentMessageId: string, queueDocId: string}}
 */
function resolveIntakeIdsFromInvoice(invoice) {
  const data = invoice || {};
  const parentMessageId = String(
      data.gmailMessageId ||
      data.sourceMessageId ||
      data.messageId ||
      "",
  ).trim();
  let queueDocId = String(data.queueDocId || "").trim();
  if (!queueDocId && parentMessageId &&
      data.itemIndex != null && data.itemIndex !== "") {
    queueDocId = childQueueDocId(parentMessageId, data.itemIndex);
  }
  if (!queueDocId) queueDocId = parentMessageId;
  return {parentMessageId, queueDocId};
}

/**
 * @param {object} tenant Tenant config.
 * @param {string} docId Queue doc id (parent or child).
 * @param {string} error Error message.
 * @param {object} [opts]
 * @param {string} [opts.outcomeReason] Searchable reason, e.g. workflow_failed.
 * @param {string} [opts.finalStatus] Alias for outcomeReason.
 * @param {object} [opts.extra] Extra Firestore fields.
 * @return {Promise<void>}
 */
async function failIntakeRecord(tenant, docId, error, opts) {
  opts = opts || {};
  const parentMessageId = isChildQueueDocId(docId) ?
    docId.replace(/__item_\d+$/, "") : String(docId || "");
  let existing = {};
  try {
    const existingSnap = await col(tenant, "emailIntake")
        .doc(parentMessageId).get();
    existing = existingSnap.exists ? (existingSnap.data() || {}) : {};
  } catch (_e) {
    existing = {};
  }
  const outcomeReason = opts.outcomeReason || opts.finalStatus || null;
  const summary = opts.summary || buildIntakeSummary(Object.assign(
      {}, existing, {
        outcome: OUTCOME.FAILED,
        outcomeReason,
        finalStatus: outcomeReason,
        error: error || "Unknown error",
        summary: null,
        ignoreReason: null,
        _rebuildSummary: true,
      }));
  const now = admin.firestore.FieldValue.serverTimestamp();
  const patch = Object.assign({
    intakeStatus: QUEUE_STATUS.FAILED,
    status: QUEUE_STATUS.FAILED,
    outcome: OUTCOME.FAILED,
    outcomeReason,
    summary,
    error: String(error || "").slice(0, 1000),
    finishedAt: now,
    updatedAt: now,
  }, opts.extra || {});
  await col(tenant, "gmailQueue").doc(docId).set(patch, {merge: true});
  if (isChildQueueDocId(docId)) {
    return;
  }
  await col(tenant, "emailIntake").doc(parentMessageId).set(
      Object.assign({}, patch, {
        gmailMessageId: parentMessageId,
        tenantId: tenant.tenantId,
      }), {merge: true});
}

/**
 * Marks parent emailIntake (and mirrored gmailQueue / split child) failed
 * after a Primus workflow system crash. Ops holds should not call this.
 * @param {object} opts Options.
 * @param {object} [opts.tenant] Tenant config.
 * @param {object} [opts.invoice] Invoice document data.
 * @param {string} [opts.invoiceId] Invoice id stored on the intake row.
 * @param {string} [opts.error] Error message for summary.
 * @param {string} [opts.outcomeReason] Defaults to workflow_failed.
 * @return {Promise<object>} Result with ok / ids.
 */
async function failIntakeForWorkflowCrash(opts) {
  const o = opts || {};
  const tenant = o.tenant || {tenantId: "default"};
  const ids = resolveIntakeIdsFromInvoice(o.invoice);
  if (!ids.parentMessageId) {
    return {ok: false, reason: "missing_message_id"};
  }
  const failOpts = {
    outcomeReason: o.outcomeReason || OUTCOME_REASON.WORKFLOW_FAILED,
    extra: o.invoiceId ? {failedInvoiceId: String(o.invoiceId)} : {},
  };
  const error = o.error || failOpts.outcomeReason;
  const seen = new Set();
  for (const id of [ids.queueDocId, ids.parentMessageId]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    await failIntakeRecord(tenant, id, error, failOpts);
  }
  return {
    ok: true,
    parentMessageId: ids.parentMessageId,
    queueDocId: ids.queueDocId,
  };
}

/**
 * @param {object} tenant Tenant config.
 * @param {string} parentMessageId Parent message id.
 * @param {object} childOpts Child completion fields.
 * @return {Promise<void>}
 */
async function incrementParentChildCompletion(
    tenant, parentMessageId, childOpts) {
  const parentQueueRef = col(tenant, "gmailQueue").doc(parentMessageId);
  const parentIntakeRef = col(tenant, "emailIntake").doc(parentMessageId);

  await admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(parentQueueRef);
    if (!snap.exists) return;
    const data = snap.data() || {};
    const childCount = Number(data.childCount || 0);
    const completedChildCount = Number(data.completedChildCount || 0) + 1;
    const itemSummaries = Array.isArray(data.itemSummaries) ?
      data.itemSummaries.slice() : [];
    if (childOpts.itemSummary) {
      const idx = Number(childOpts.itemSummary.itemIndex);
      itemSummaries[idx] = childOpts.itemSummary;
    }

    const patch = {
      completedChildCount,
      itemSummaries,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (completedChildCount >= childCount && childCount > 0) {
      const rollup = buildIntakeSummary({
        itemSummaries,
        childCount,
        completedChildCount,
        receivedDateTime: data.receivedDateTime || data.receivedAt || null,
      });
      Object.assign(patch, {
        intakeStatus: QUEUE_STATUS.COMPLETED,
        status: QUEUE_STATUS.COMPLETED,
        outcome: OUTCOME.PROCESSED,
        summary: rollup,
        finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    tx.set(parentQueueRef, patch, {merge: true});
    tx.set(parentIntakeRef, Object.assign({}, patch, {
      gmailMessageId: parentMessageId,
      tenantId: tenant.tenantId,
    }), {merge: true});
  });
}

/**
 * Creates per-invoice child queue jobs after classification.
 * @param {object} opts tenant, parentMessageId, subject, from, invoiceItems.
 * @return {Promise<number>} Number of children created.
 */
async function createInvoiceChildJobs(opts) {
  const tenant = opts.tenant;
  const parentMessageId = String(opts.parentMessageId || "");
  const invoiceItems = Array.isArray(opts.invoiceItems) ?
    opts.invoiceItems : [];
  if (!parentMessageId || invoiceItems.length <= 1) return 0;

  const now = admin.firestore.FieldValue.serverTimestamp();
  const batch = admin.firestore().batch();
  const parentQueueRef = col(tenant, "gmailQueue").doc(parentMessageId);
  const parentIntakeRef = col(tenant, "emailIntake").doc(parentMessageId);

  for (let i = 0; i < invoiceItems.length; i++) {
    const childId = childQueueDocId(parentMessageId, i);
    const item = invoiceItems[i] || {};
    const childPayload = {
      gmailMessageId: parentMessageId,
      parentMessageId,
      tenantId: tenant.tenantId,
      docType: DOC_TYPE.INVOICE_ITEM,
      itemIndex: i,
      loadNumber: item.loadNumber || null,
      subject: String(opts.subject || "").slice(0, 500),
      from: String(opts.from || "").slice(0, 500),
      intakeStatus: QUEUE_STATUS.QUEUED,
      status: QUEUE_STATUS.QUEUED,
      claimedAt: now,
      createdAt: now,
      updatedAt: now,
      deleteAt: deleteAt(INTAKE_TTL_DAYS),
    };
    batch.set(
        col(tenant, "gmailQueue").doc(childId), childPayload, {merge: true});
  }

  const parentPatch = {
    docType: DOC_TYPE.EMAIL,
    intakeStatus: QUEUE_STATUS.WAITING_CHILDREN,
    status: QUEUE_STATUS.WAITING_CHILDREN,
    outcome: OUTCOME.SPLIT,
    childCount: invoiceItems.length,
    completedChildCount: 0,
    invoiceItemsPending: invoiceItems.map((item, itemIndex) =>
      Object.assign({itemIndex}, item)),
    summary: `Split into ${invoiceItems.length} invoice job(s) for processing.`,
    updatedAt: now,
  };
  batch.set(parentQueueRef, parentPatch, {merge: true});
  batch.set(parentIntakeRef, parentPatch, {merge: true});
  await batch.commit();
  return invoiceItems.length;
}

/**
 * @param {object} tenant Tenant config.
 * @param {Date} since Start of window.
 * @param {Date} [until] End of window.
 * @return {Promise<Array<object>>}
 */
async function listIntakeForDigest(tenant, since, until) {
  const sinceTs = admin.firestore.Timestamp.fromDate(since);
  const snap = await col(tenant, "emailIntake")
      .where("discoveredAt", ">=", sinceTs)
      .orderBy("discoveredAt", "asc")
      .limit(500)
      .get();
  const untilMs = until ? until.getTime() : null;
  return snap.docs
      .map((doc) => Object.assign({id: doc.id}, doc.data() || {}))
      .filter((row) => {
        if (row.docType === DOC_TYPE.INVOICE_ITEM) return false;
        if (!untilMs || !row.discoveredAt || !row.discoveredAt.toDate) {
          return true;
        }
        return row.discoveredAt.toDate().getTime() <= untilMs;
      });
}

/**
 * @param {object} row emailIntake row.
 * @return {number|null} Milliseconds for sorting/report window.
 */
function intakeFinishedMs(row) {
  const ts = row && (row.finishedAt || row.discoveredAt);
  if (!ts || !ts.toDate) return null;
  return ts.toDate().getTime();
}

/**
 * Ignored parent emails finished (or discovered) within the lookback window.
 * @param {object} tenant Tenant config.
 * @param {Date} since Start of window.
 * @param {Date} [until] End of window.
 * @return {Promise<Array<object>>}
 */
async function listIgnoredIntakeForReport(tenant, since, until) {
  const sinceTs = admin.firestore.Timestamp.fromDate(since);
  const snap = await col(tenant, "emailIntake")
      .where("finishedAt", ">=", sinceTs)
      .orderBy("finishedAt", "asc")
      .limit(500)
      .get();
  const untilMs = until ? until.getTime() : null;
  const sinceMs = since.getTime();
  return snap.docs
      .map((doc) => Object.assign({id: doc.id}, doc.data() || {}))
      .filter((row) => {
        if (row.docType === DOC_TYPE.INVOICE_ITEM) return false;
        if (row.outcome !== OUTCOME.IGNORED) return false;
        const finishedMs = intakeFinishedMs(row);
        if (finishedMs == null || finishedMs < sinceMs) return false;
        if (untilMs != null && finishedMs > untilMs) return false;
        return true;
      });
}

module.exports = {
  DOC_TYPE,
  QUEUE_STATUS,
  OUTCOME,
  OUTCOME,
  OUTCOME_REASON,
  INTAKE_TTL_DAYS,
  childQueueDocId,
  isChildQueueDocId,
  buildIntakeSummary,
  formatReceivedAtEt,
  toReceivedTimestamp,
  isAlreadyDiscovered,
  enqueueDiscoveredEmail,
  persistReceivedDateTimeIfMissing,
  markIntakeProcessing,
  completeIntakeRecord,
  failIntakeRecord,
  failIntakeForWorkflowCrash,
  resolveIntakeIdsFromInvoice,
  createInvoiceChildJobs,
  listIntakeForDigest,
  listIgnoredIntakeForReport,
  intakeFinishedMs,
  incrementParentChildCompletion,
};
