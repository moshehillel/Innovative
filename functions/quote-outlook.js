/**
 * Per-dispatcher Outlook OAuth + quote inbox sync.
 */

"use strict";

const admin = require("firebase-admin");
const outlookMail = require("./outlook-mail");
const quoteIntake = require("./quote-intake");

let tcolFn = null;
let writeLogFn = null;

/**
 * @param {object} deps tcol, writeLog.
 * @return {void}
 */
function init(deps) {
  tcolFn = deps.tcol;
  writeLogFn = deps.writeLog || (() => {});
}

/**
 * @param {object} tenant Tenant.
 * @param {string} name Collection.
 * @return {FirebaseFirestore.CollectionReference}
 */
function col(tenant, name) {
  if (!tcolFn) throw new Error("quote-outlook not initialized");
  return tcolFn(tenant, name);
}

/**
 * @param {string} email Email address.
 * @return {string}
 */
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/**
 * Same Azure-registered redirect as Jerry mail (OUTLOOK_REDIRECT_URI /
 * outlookOAuthCallback). Quote flow is distinguished via OAuth state.flow.
 * @return {string}
 */
function getRedirectUri() {
  if (process.env.OUTLOOK_REDIRECT_URI) {
    return process.env.OUTLOOK_REDIRECT_URI;
  }
  const base = process.env.PUBLIC_FUNCTIONS_BASE_URL ||
    "https://us-central1-tai-invoice-automation.cloudfunctions.net";
  return `${base}/outlookOAuthCallback`;
}

/**
 * @param {object} tenant Tenant.
 * @param {string} dispatcherId Dispatcher id.
 * @return {string} Microsoft OAuth URL.
 */
function buildConnectUrl(tenant, dispatcherId) {
  const cfg = outlookMail.getOutlookOAuthConfig();
  const state = Buffer.from(JSON.stringify({
    tenantId: tenant.tenantId,
    dispatcherId: String(dispatcherId),
    flow: "quote_dispatcher",
  })).toString("base64url");
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: getRedirectUri(),
    response_mode: "query",
    scope: [
      "openid",
      "profile",
      "offline_access",
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
    ].join(" "),
    state,
    prompt: "select_account",
  });
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
    params.toString();
}

/**
 * @param {string} code OAuth code.
 * @return {Promise<object>}
 */
async function exchangeCode(code) {
  return outlookMail.exchangeOutlookCode(code, getRedirectUri());
}

/**
 * @param {object} tenant Tenant.
 * @param {string} dispatcherId Id.
 * @return {Promise<object|null>}
 */
async function getDispatcherDoc(tenant, dispatcherId) {
  const snap = await col(tenant, "quoteDispatchers")
      .doc(String(dispatcherId)).get();
  if (!snap.exists) return null;
  return {id: snap.id, ...snap.data()};
}

/**
 * @param {object} tenant Tenant.
 * @param {string} dispatcherId Id.
 * @return {Promise<object|null>} Stored outlook tokens.
 */
async function getDispatcherTokens(tenant, dispatcherId) {
  const doc = await getDispatcherDoc(tenant, dispatcherId);
  return doc && doc.outlookTokens ? doc.outlookTokens : null;
}

/**
 * @param {object} tenant Tenant.
 * @param {string} dispatcherId Id.
 * @param {object} tokens OAuth tokens.
 * @param {object} profile Connected mailbox profile.
 * @return {Promise<void>}
 */
async function saveDispatcherTokens(tenant, dispatcherId, tokens, profile) {
  const patch = {
    outlookTokens: tokens,
    outlookConnectedEmail: profile.email || null,
    outlookConnectedDisplayName: profile.displayName || null,
    outlookConnectedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (profile.userPrincipalName !== undefined) {
    patch.outlookConnectedUpn = profile.userPrincipalName || null;
  }
  if (profile.mail !== undefined) {
    patch.outlookConnectedMail = profile.mail || null;
  }
  await col(tenant, "quoteDispatchers").doc(String(dispatcherId)).set(
      patch, {merge: true});
}

/**
 * @param {object} tenant Tenant.
 * @param {string} dispatcherId Id.
 * @return {Promise<object>}
 */
async function getOutlookStatus(tenant, dispatcherId) {
  const doc = await getDispatcherDoc(tenant, dispatcherId);
  if (!doc || !doc.outlookTokens) {
    return {connected: false, email: null};
  }
  return {
    connected: true,
    email: doc.outlookConnectedEmail || null,
    upn: doc.outlookConnectedUpn || null,
    mail: doc.outlookConnectedMail || null,
    displayName: doc.outlookConnectedDisplayName || null,
    connectedAt: doc.outlookConnectedAt || null,
  };
}

/**
 * @param {object} tenant Tenant.
 * @param {string} dispatcherId Id.
 * @return {Promise<void>}
 */
async function disconnectOutlook(tenant, dispatcherId) {
  await col(tenant, "quoteDispatchers").doc(String(dispatcherId)).set({
    outlookTokens: admin.firestore.FieldValue.delete(),
    outlookConnectedEmail: admin.firestore.FieldValue.delete(),
    outlookConnectedUpn: admin.firestore.FieldValue.delete(),
    outlookConnectedMail: admin.firestore.FieldValue.delete(),
    outlookConnectedDisplayName: admin.firestore.FieldValue.delete(),
    outlookConnectedAt: admin.firestore.FieldValue.delete(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
}

/**
 * @param {object} parsed OAuth state.
 * @param {string} code Authorization code.
 * @param {Function} getTenant Load tenant by id.
 * @param {Function} getDispatcher Load dispatcher row.
 * @return {Promise<object>}
 */
async function handleOAuthCallback(parsed, code, getTenant, getDispatcher) {
  if (!parsed || parsed.flow !== "quote_dispatcher" || !parsed.dispatcherId) {
    return {ok: false, error: "Invalid OAuth state"};
  }
  const tenant = await getTenant(parsed.tenantId || "default");
  const dispatcher = await getDispatcher(tenant, parsed.dispatcherId);
  if (!dispatcher) {
    return {ok: false, error: "Dispatcher not found"};
  }

  const tokens = await exchangeCode(code);
  const onUpdate = async (updated) => {
    await saveDispatcherTokens(
        tenant, dispatcher.id, updated, {
          email: dispatcher.outlookConnectedEmail,
          userPrincipalName: dispatcher.outlookConnectedUpn,
          mail: dispatcher.outlookConnectedMail,
          displayName: dispatcher.outlookConnectedDisplayName,
        });
  };
  const profile = await outlookMail.fetchMailboxProfile(tokens, onUpdate, {
    rosterEmail: dispatcher.email,
  });

  const rosterEmail = normalizeEmail(dispatcher.email);
  const connectedEmail = normalizeEmail(profile.email);
  // Any Microsoft mailbox is allowed; sync uses outlookConnectedEmail.
  if (rosterEmail && connectedEmail && rosterEmail !== connectedEmail) {
    console.warn(
        "[quote-outlook] Mailbox differs from roster for " +
        String(dispatcher.id) + ": roster=" + rosterEmail +
        " connected=" + connectedEmail +
        " mail=" + normalizeEmail(profile.mail) +
        " upn=" + normalizeEmail(profile.userPrincipalName) +
        " preferredUsername=" +
        normalizeEmail(profile.preferredUsername));
  } else {
    console.log(
        "[quote-outlook] Outlook connected for " +
        String(dispatcher.id) + ": email=" + connectedEmail +
        " mail=" + normalizeEmail(profile.mail) +
        " upn=" + normalizeEmail(profile.userPrincipalName));
  }

  await saveDispatcherTokens(tenant, dispatcher.id, tokens, {
    email: profile.email,
    mail: profile.mail,
    userPrincipalName: profile.userPrincipalName,
    displayName: profile.displayName,
  });

  return {
    ok: true,
    email: profile.email,
    mail: profile.mail,
    upn: profile.userPrincipalName,
    dispatcherName: dispatcher.name,
  };
}

/**
 * Whether a prior emailIntake row should be retried.
 * Parse failures used to permanently block reprocessing.
 * @param {object|null} prev Prior intake data.
 * @param {object} opts Sync options.
 * @return {boolean}
 */
function shouldRetryIntake(prev, opts) {
  if (!prev) return true;
  if (prev.quoteId) return false;
  if (opts.forceReprocess) return true;
  const status = String(prev.finalStatus || "");
  if (status === "quote_processed") return false;
  // quote_queued without quoteId is owned by drainQuoteQueue. Re-intake only
  // when forced — otherwise drain would be starved of work while Luna
  // reclassifies the same messages every sync.
  if (status === "quote_queued") return Boolean(opts.forceReprocess);
  const reason = String(prev.skipReason || "");
  if (reason.startsWith("Parse failed") || reason === "empty model response") {
    return true;
  }
  // Permanent classifier / not-a-quote skips stay skipped unless forced.
  // Heuristic fallback after Luna/API failure is unreliable — retry.
  if (status === "skipped_not_quote") {
    const src = String(prev.classifySource || "");
    if (src === "heuristic_fallback" || /Luna failed/i.test(reason)) {
      return true;
    }
    return false;
  }
  // Failed / errored intakes: allow forceReprocess recovery (enqueue
  // already supports forceReprocess for FAILED queue docs).
  if (status === "failed" || status === "quote_failed" ||
      status === "error" || status === "workflow_failed") {
    return Boolean(opts.forceReprocess);
  }
  return false;
}

/**
 * Drain quoteMailQueue for one dispatcher.
 * @param {object} tenant Tenant.
 * @param {object} dispatcher Dispatcher row.
 * @param {Function} processQuoteEmail Handler.
 * @param {object} [outlookClient] Optional Graph client; when set, mark
 *   Outlook messages read only after a quoteRequest is created.
 * @return {Promise<object>} {processed, errors}
 */
async function drainQuoteQueue(
    tenant, dispatcher, processQuoteEmail, outlookClient) {
  const quoteMailQueue = require("./quote-mail-queue");
  const queued = await quoteMailQueue.listQueuedForDispatcher(
      tcolFn, tenant, dispatcher.id, 15);
  let processed = 0;
  let errors = 0;

  for (const job of queued) {
    const claimed = await quoteMailQueue.claimQueuedJob(
        tcolFn, tenant, job.id);
    if (!claimed) continue;

    try {
      const result = await processQuoteEmail({
        messageId: claimed.id || job.id,
        subject: claimed.subject || "",
        from: claimed.from || "",
        to: claimed.to || "",
        cc: claimed.cc || "",
        emailBody: claimed.emailBody || "",
        tenant,
        assignedDispatcher: dispatcher,
        outlookMessageId: claimed.outlookMessageId,
        receivedMailboxEmail: claimed.receivedMailboxEmail ||
          dispatcher.outlookConnectedEmail || dispatcher.email,
      });

      if (result.quoteId) {
        processed += 1;
        await quoteMailQueue.completeQueuedJob(tcolFn, tenant, job.id, {
          quoteId: result.quoteId,
          finalStatus: result.status || "quote_processed",
        });
        await col(tenant, "emailIntake").doc(job.id).set({
          source: "dispatcher_outlook",
          dispatcherId: dispatcher.id,
          dispatcherEmail: dispatcher.email,
          gmailMessageId: job.id,
          outlookMessageId: claimed.outlookMessageId || null,
          subject: claimed.subject || "",
          from: claimed.from || "",
          quoteId: result.quoteId,
          finalStatus: result.status || "quote_processed",
          skipReason: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
        try {
          await col(tenant, "quoteRequests").doc(result.quoteId).set({
            outlookMessageId: claimed.outlookMessageId || null,
          }, {merge: true});
        } catch (_) {
          // non-fatal
        }
        if (outlookClient && claimed.outlookMessageId) {
          try {
            await outlookClient.users.messages.modify({
              id: claimed.outlookMessageId,
              requestBody: {removeLabelIds: ["UNREAD"]},
            });
          } catch (markReadErr) {
            writeLogFn("warn", "quote", "Outlook mark read failed", {
              dispatcherId: dispatcher.id,
              messageId: claimed.outlookMessageId,
              quoteId: result.quoteId,
              error: markReadErr.message,
            });
          }
        }
      } else {
        errors += 1;
        const reason = result.reason || result.status || "not_a_quote";
        await quoteMailQueue.failQueuedJob(tcolFn, tenant, job.id, reason);
        await col(tenant, "emailIntake").doc(job.id).set({
          source: "dispatcher_outlook",
          dispatcherId: dispatcher.id,
          quoteId: null,
          finalStatus: "skipped_not_quote",
          skipReason: reason,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
      }
    } catch (err) {
      errors += 1;
      writeLogFn("error", "quote", "Quote queue process failed", {
        dispatcherId: dispatcher.id,
        docId: job.id,
        error: err.message,
      });
      await quoteMailQueue.failQueuedJob(
          tcolFn, tenant, job.id, err.message);
    }
  }

  return {processed, errors};
}

/**
 * Sync recent quote RFQs from a dispatcher's connected Outlook inbox.
 * Luna classifies from email body; quotes are enqueued then drained.
 * Outlook mark-read happens only after quoteRequest creation (in drain).
 * @param {object} tenant Tenant.
 * @param {object} dispatcher Dispatcher row.
 * @param {Function} processQuoteEmail quote-automation.processQuoteEmail.
 * @param {object} [opts] includeRead, forceReprocess.
 * @return {Promise<object>}
 */
async function syncDispatcherInbox(
    tenant, dispatcher, processQuoteEmail, opts = {}) {
  const quoteMailQueue = require("./quote-mail-queue");
  const tokens = await getDispatcherTokens(tenant, dispatcher.id);
  if (!tokens) {
    return {ok: true, synced: 0, skipped: "not_connected"};
  }

  const includeRead = Boolean(opts.includeRead);
  const onUpdate = async (updated) => {
    await saveDispatcherTokens(tenant, dispatcher.id, updated, {
      email: dispatcher.outlookConnectedEmail,
      displayName: dispatcher.outlookConnectedDisplayName,
    });
  };
  const client = outlookMail.createOutlookMailClient(tokens, onUpdate);

  const drainedFirst = await drainQuoteQueue(
      tenant, dispatcher, processQuoteEmail, client);

  const after = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const q = `after:${after.getUTCFullYear()}/` +
    `${after.getUTCMonth() + 1}/${after.getUTCDate()}`;
  const listResp = await client.users.messages.list({
    maxResults: 40,
    includeRead,
    q,
  });
  const messages = (listResp.data && listResp.data.messages) || [];
  let enqueued = 0;
  let skippedExisting = 0;
  let skippedNotQuote = 0;
  let processErrors = 0;

  for (const row of messages) {
    const messageId = row.id;
    if (!messageId) continue;
    const intakeId = quoteMailQueue.queueDocId(dispatcher.id, messageId);
    const intakeSnap = await col(tenant, "emailIntake").doc(intakeId).get();
    const prev = intakeSnap.exists ? (intakeSnap.data() || {}) : null;
    if (intakeSnap.exists && !shouldRetryIntake(prev, opts)) {
      skippedExisting += 1;
      continue;
    }

    let subject = "";
    let from = "";
    let to = "";
    let cc = "";
    let emailBody = "";
    try {
      const full = await client.users.messages.get({id: messageId});
      const payload = full.data && full.data.payload;
      const headers = (payload && payload.headers) || [];
      const h = (name) => {
        const hit = headers.find((x) =>
          String(x.name).toLowerCase() === name.toLowerCase());
        return hit ? hit.value : "";
      };
      subject = h("Subject");
      from = h("From");
      to = h("To");
      cc = h("Cc");
      emailBody = quoteIntake.toPlainText(extractPlainBody(payload));
    } catch (err) {
      processErrors += 1;
      writeLogFn("warn", "quote", "Outlook sync message read failed", {
        dispatcherId: dispatcher.id,
        messageId,
        error: err.message,
      });
      continue;
    }

    let classify;
    try {
      classify = await quoteIntake.classifyIsQuoteRequest({
        subject,
        from,
        body: emailBody,
      });
    } catch (err) {
      processErrors += 1;
      writeLogFn("warn", "quote", "Luna quote classify failed", {
        dispatcherId: dispatcher.id,
        messageId,
        error: err.message,
      });
      continue;
    }

    if (!classify.isQuote) {
      skippedNotQuote += 1;
      // Heuristic-only "no" after API failure is unreliable (e.g. PO-only
      // subjects). Leave unread and do not permanently skip.
      if (classify.source === "heuristic_fallback") {
        writeLogFn("warn", "quote",
            "Quote classify fallback said not_a_quote; will retry", {
              dispatcherId: dispatcher.id,
              messageId,
              subject,
              reason: classify.reasoning || null,
            });
        continue;
      }
      await col(tenant, "emailIntake").doc(intakeId).set({
        source: "dispatcher_outlook",
        dispatcherId: dispatcher.id,
        dispatcherEmail: dispatcher.email,
        gmailMessageId: intakeId,
        outlookMessageId: messageId,
        subject,
        from,
        quoteId: null,
        finalStatus: "skipped_not_quote",
        skipReason: classify.reasoning || "luna_not_quote",
        classifySource: classify.source || null,
        classifyConfidence: classify.confidence || null,
        createdAt: prev && prev.createdAt ?
          prev.createdAt : admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
      // Leave unread — dispatcher can still see/handle non-quote mail.
      continue;
    }

    try {
      const enq = await quoteMailQueue.enqueueQuoteEmail({
        tcol: tcolFn,
        tenant,
        dispatcher,
        outlookMessageId: messageId,
        subject,
        from,
        to,
        cc,
        emailBody,
        receivedMailboxEmail: dispatcher.outlookConnectedEmail ||
          dispatcher.email,
        classify: {
          isQuote: true,
          confidence: classify.confidence,
          reasoning: classify.reasoning,
          source: classify.source,
        },
        forceReprocess: Boolean(opts.forceReprocess),
      });

      if (!enq.ok && enq.reason !== "already_queued") {
        processErrors += 1;
        writeLogFn("warn", "quote", "Quote enqueue failed", {
          dispatcherId: dispatcher.id,
          messageId,
          reason: enq.reason,
        });
        continue;
      }

      enqueued += 1;
      await col(tenant, "emailIntake").doc(intakeId).set({
        source: "dispatcher_outlook",
        dispatcherId: dispatcher.id,
        dispatcherEmail: dispatcher.email,
        gmailMessageId: intakeId,
        outlookMessageId: messageId,
        subject,
        from,
        quoteId: null,
        finalStatus: "quote_queued",
        skipReason: admin.firestore.FieldValue.delete(),
        classifySource: classify.source || null,
        classifyConfidence: classify.confidence || null,
        createdAt: prev && prev.createdAt ?
          prev.createdAt : admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
      // Leave unread until drain creates quoteRequest (mark-read there).
    } catch (err) {
      processErrors += 1;
      writeLogFn("error", "quote", "Outlook sync quote enqueue failed", {
        dispatcherId: dispatcher.id,
        messageId,
        error: err.message,
      });
    }
  }

  const drainedAfter = await drainQuoteQueue(
      tenant, dispatcher, processQuoteEmail, client);
  const synced = drainedFirst.processed + drainedAfter.processed;
  processErrors += drainedFirst.errors + drainedAfter.errors;

  return {
    ok: true,
    synced,
    enqueued,
    scanned: messages.length,
    includeRead,
    skippedExisting,
    skippedNotQuote,
    processErrors,
  };
}

/**
 * @param {object} payload Gmail-style payload.
 * @return {string}
 */
function extractPlainBody(payload) {
  if (!payload) return "";
  if (payload.body && payload.body.data) {
    return decodeBase64Url(payload.body.data);
  }
  const parts = payload.parts || [];
  for (const part of parts) {
    const mime = String(part.mimeType || "").toLowerCase();
    if (mime === "text/plain" && part.body && part.body.data) {
      return decodeBase64Url(part.body.data);
    }
  }
  for (const part of parts) {
    if (part.body && part.body.data) {
      return decodeBase64Url(part.body.data);
    }
  }
  return "";
}

/**
 * @param {string} data Base64url.
 * @return {string}
 */
function decodeBase64Url(data) {
  return Buffer.from(
      String(data || "").replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
  ).toString("utf8");
}

/**
 * Sends a customer quote reply from the dispatcher's Outlook mailbox.
 * @param {object} tenant Tenant.
 * @param {object} dispatcher Dispatcher row.
 * @param {object} opts to, subject, bodyText, bodyHtml, outlookMessageId.
 * @return {Promise<object>}
 */
async function sendQuoteReply(tenant, dispatcher, opts = {}) {
  const tokens = await getDispatcherTokens(tenant, dispatcher.id);
  if (!tokens) {
    throw new Error(
        "Connect Outlook on the quote dashboard before approving email");
  }
  const onUpdate = async (updated) => {
    await saveDispatcherTokens(tenant, dispatcher.id, updated, {
      email: dispatcher.outlookConnectedEmail,
      displayName: dispatcher.outlookConnectedDisplayName,
    });
  };

  const to = outlookMail.extractEmailAddress(opts.to);
  if (!to) {
    throw new Error("Cannot determine customer email from quote sender");
  }

  let subject = String(opts.subject || "").trim() || "Quote options";
  if (!/^re:\s*/i.test(subject)) {
    subject = `RE: ${subject}`;
  }

  const result = await outlookMail.sendSimpleMail({
    to,
    subject,
    bodyText: opts.bodyText || "",
    bodyHtml: opts.bodyHtml || "",
    cc: opts.cc || [],
  }, tokens, onUpdate);

  return {
    ...result,
    fromMailbox: dispatcher.outlookConnectedEmail || dispatcher.email || null,
  };
}

module.exports = {
  init,
  normalizeEmail,
  buildConnectUrl,
  getRedirectUri,
  getOutlookStatus,
  disconnectOutlook,
  handleOAuthCallback,
  syncDispatcherInbox,
  sendQuoteReply,
};
