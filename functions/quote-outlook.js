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
  await col(tenant, "quoteDispatchers").doc(String(dispatcherId)).set({
    outlookTokens: tokens,
    outlookConnectedEmail: profile.email || null,
    outlookConnectedDisplayName: profile.displayName || null,
    outlookConnectedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
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
          displayName: dispatcher.outlookConnectedDisplayName,
        });
  };
  const profile = await outlookMail.fetchMailboxProfile(tokens, onUpdate);

  const rosterEmail = normalizeEmail(dispatcher.email);
  const connectedEmail = normalizeEmail(profile.email);
  // Any Microsoft mailbox is allowed; sync uses outlookConnectedEmail.
  if (rosterEmail && connectedEmail && rosterEmail !== connectedEmail) {
    console.warn(
        "[quote-outlook] Mailbox differs from roster for " +
        String(dispatcher.id) + ": roster=" + rosterEmail +
        " connected=" + connectedEmail);
  }

  await saveDispatcherTokens(tenant, dispatcher.id, tokens, {
    email: profile.email,
    displayName: profile.displayName,
  });

  return {
    ok: true,
    email: profile.email,
    dispatcherName: dispatcher.name,
  };
}

/**
 * Sync recent quote RFQs from a dispatcher's connected Outlook inbox.
 * @param {object} tenant Tenant.
 * @param {object} dispatcher Dispatcher row.
 * @param {Function} processQuoteEmail quote-automation.processQuoteEmail.
 * @return {Promise<object>}
 */
async function syncDispatcherInbox(tenant, dispatcher, processQuoteEmail) {
  const tokens = await getDispatcherTokens(tenant, dispatcher.id);
  if (!tokens) {
    return {ok: true, synced: 0, skipped: "not_connected"};
  }

  const onUpdate = async (updated) => {
    await saveDispatcherTokens(tenant, dispatcher.id, updated, {
      email: dispatcher.outlookConnectedEmail,
      displayName: dispatcher.outlookConnectedDisplayName,
    });
  };
  const client = outlookMail.createOutlookMailClient(tokens, onUpdate);
  const after = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const q = `after:${after.getUTCFullYear()}/` +
    `${after.getUTCMonth() + 1}/${after.getUTCDate()}`;
  const listResp = await client.users.messages.list({
    maxResults: 40,
    includeRead: false,
    q,
  });
  const messages = (listResp.data && listResp.data.messages) || [];
  let synced = 0;

  for (const row of messages) {
    const messageId = row.id;
    if (!messageId) continue;
    const intakeId = `outlook_${dispatcher.id}_${messageId}`;
    const intakeSnap = await col(tenant, "emailIntake").doc(intakeId).get();
    if (intakeSnap.exists) continue;

    let subject = "";
    let from = "";
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
      emailBody = extractPlainBody(payload);
    } catch (err) {
      writeLogFn("warn", "quote", "Outlook sync message read failed", {
        dispatcherId: dispatcher.id,
        messageId,
        error: err.message,
      });
      continue;
    }

    const looksQuote = quoteIntake.looksLikeQuoteRequest(subject, emailBody);
    if (!looksQuote) continue;

    try {
      const result = await processQuoteEmail({
        messageId: intakeId,
        subject,
        from,
        emailBody,
        tenant,
        assignedDispatcher: dispatcher,
        outlookMessageId: messageId,
        receivedMailboxEmail: dispatcher.outlookConnectedEmail ||
          dispatcher.email,
      });
      if (result.quoteId) {
        synced += 1;
        await col(tenant, "emailIntake").doc(intakeId).set({
          source: "dispatcher_outlook",
          dispatcherId: dispatcher.id,
          dispatcherEmail: dispatcher.email,
          gmailMessageId: intakeId,
          outlookMessageId: messageId,
          subject,
          from,
          quoteId: result.quoteId,
          finalStatus: result.status || "quote_processed",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
        if (result.quoteId) {
          try {
            await col(tenant, "quoteRequests").doc(result.quoteId).set({
              outlookMessageId: messageId,
            }, {merge: true});
          } catch (_) {
            // non-fatal
          }
        }
        try {
          await client.users.messages.modify({
            id: messageId,
            requestBody: {removeLabelIds: ["UNREAD"]},
          });
        } catch (markReadErr) {
          writeLogFn("warn", "quote", "Outlook mark read failed", {
            dispatcherId: dispatcher.id,
            messageId,
            error: markReadErr.message,
          });
        }
      } else {
        await col(tenant, "emailIntake").doc(intakeId).set({
          source: "dispatcher_outlook",
          dispatcherId: dispatcher.id,
          dispatcherEmail: dispatcher.email,
          gmailMessageId: intakeId,
          subject,
          from,
          quoteId: null,
          finalStatus: "skipped_not_quote",
          skipReason: result.reason || result.status || "not_a_quote",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
      }
    } catch (err) {
      writeLogFn("error", "quote", "Outlook sync quote process failed", {
        dispatcherId: dispatcher.id,
        messageId,
        error: err.message,
      });
    }
  }

  return {ok: true, synced, scanned: messages.length};
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
