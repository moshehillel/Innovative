"use strict";

const admin = require("firebase-admin");
const {google} = require("googleapis");
const outlookMail = require("./outlook-mail");

/** @type {FirebaseFirestore.Firestore|null} */
let dbRef = null;

/**
 * @param {object} deps Dependencies.
 * @param {FirebaseFirestore.Firestore} deps.db Firestore instance.
 */
function init(deps) {
  dbRef = deps.db;
}

/**
 * @return {"outlook"|"gmail"}
 */
function getProvider() {
  const raw = String(process.env.MAIL_PROVIDER || "outlook").toLowerCase();
  return raw === "gmail" ? "gmail" : "outlook";
}

/**
 * @return {string}
 */
function providerLabel() {
  return getProvider() === "outlook" ? "Outlook" : "Gmail";
}

/**
 * @return {string}
 */
function inboxCheckCompletedMessage() {
  return "Inbox check completed";
}

/**
 * @param {object} tenant Tenant config.
 * @return {string} settings/{docId} for OAuth tokens.
 */
function tenantMailDocId(tenant) {
  if (getProvider() === "outlook") {
    if (tenant && tenant.outlookDocId) return tenant.outlookDocId;
    const id = tenant && tenant.tenantId ? tenant.tenantId : "default";
    return id === "default" ? "outlook" : `outlook_${id}`;
  }
  return (tenant && tenant.gmailDocId) || "gmail";
}

/**
 * @param {object} tenant Tenant config.
 * @return {Promise<object|null>}
 */
async function getTenantMailTokens(tenant) {
  if (!dbRef) throw new Error("mail-provider not initialized");
  const snap = await dbRef.collection("settings")
      .doc(tenantMailDocId(tenant)).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  return data.tokens || data;
}

/**
 * @param {object} tenant Tenant config.
 * @param {object} tokens OAuth tokens.
 * @return {Promise<void>}
 */
async function persistTenantMailTokens(tenant, tokens) {
  if (!dbRef) return;
  await dbRef.collection("settings").doc(tenantMailDocId(tenant)).set({
    tokens,
    provider: getProvider(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
}

/**
 * @return {google.auth.OAuth2}
 */
function getGmailOAuthClient() {
  return new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI,
  );
}

/**
 * @param {object} tenant Tenant config.
 * @return {string} OAuth connect URL.
 */
function buildOAuthConnectUrl(tenant) {
  if (getProvider() === "outlook") {
    return outlookMail.buildOutlookConnectUrl(tenant);
  }
  const oauth2Client = getGmailOAuthClient();
  const state = Buffer.from(JSON.stringify({
    tenantId: tenant.tenantId,
  })).toString("base64url");
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
    ],
    state,
  });
}

/**
 * @param {string} code OAuth authorization code.
 * @return {Promise<object>}
 */
async function exchangeOAuthCode(code) {
  if (getProvider() === "outlook") {
    return outlookMail.exchangeOutlookCode(code);
  }
  const oauth2Client = getGmailOAuthClient();
  const {tokens} = await oauth2Client.getToken(code);
  return tokens;
}

/**
 * @param {object} tenant Tenant config.
 * @return {Promise<object|null>} Gmail-compatible mail client.
 */
async function getTenantMailClient(tenant) {
  const tokens = await getTenantMailTokens(tenant);
  if (!tokens) return null;

  if (getProvider() === "outlook") {
    const onTokenUpdate = (updated) =>
      persistTenantMailTokens(tenant, updated);
    return outlookMail.createOutlookMailClient(tokens, onTokenUpdate);
  }

  const oauth2Client = getGmailOAuthClient();
  oauth2Client.setCredentials(tokens);
  return google.gmail({version: "v1", auth: oauth2Client});
}

/**
 * Resolves the connected mailbox email/display name from OAuth tokens.
 * @param {object} tokens OAuth token payload.
 * @param {object} [tenant] Tenant config for token refresh persistence.
 * @return {Promise<object>} Profile with email and displayName fields.
 */
async function resolveMailboxProfileFromTokens(tokens, tenant) {
  if (!tokens) {
    return {email: null, displayName: null};
  }

  if (getProvider() === "outlook") {
    const onTokenUpdate = tenant ?
      (updated) => persistTenantMailTokens(tenant, updated) :
      null;
    return outlookMail.fetchMailboxProfile(tokens, onTokenUpdate);
  }

  const oauth2Client = getGmailOAuthClient();
  oauth2Client.setCredentials(tokens);
  const gmail = google.gmail({version: "v1", auth: oauth2Client});
  const profile = await gmail.users.getProfile({userId: "me"});
  return {
    email: profile.data.emailAddress || null,
    displayName: null,
  };
}

module.exports = {
  init,
  getProvider,
  providerLabel,
  inboxCheckCompletedMessage,
  tenantMailDocId,
  getTenantMailTokens,
  persistTenantMailTokens,
  getGmailOAuthClient,
  buildOAuthConnectUrl,
  exchangeOAuthCode,
  getTenantMailClient,
  resolveMailboxProfileFromTokens,
};
