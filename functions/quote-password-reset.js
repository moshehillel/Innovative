/**
 * Quote dispatcher password reset — Firebase link emailed via Gmail SMTP.
 */

"use strict";

const {GoogleAuth} = require("google-auth-library");
const nodemailer = require("nodemailer");
const quoteFirebaseAuth = require("./quote-firebase-auth");
const quoteDispatchers = require("./quote-dispatchers");

const DEFAULT_SMTP_HOST = "smtp.gmail.com";
// App password auth must use the primary Gmail mailbox; From stays no-reply@.
const DEFAULT_SMTP_USER = "mshglck@gmail.com";
const DEFAULT_FROM =
  "Advanced Automations <no-reply@advancedautomations.net>";

/**
 * @return {string}
 */
function getProjectId() {
  return process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT ||
    "tai-invoice-automation";
}

/**
 * @return {Promise<{token: string, projectId: string}>}
 */
async function getAccessToken() {
  const projectId = getProjectId();
  const auth = new GoogleAuth({
    projectId,
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/firebase",
    ],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) {
    throw new Error("No access token for password reset");
  }
  return {token: token.token, projectId};
}

/**
 * @param {string} s Raw string.
 * @return {string}
 */
function escapeHtml(s) {
  return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}

/**
 * @return {object} Nodemailer transport options.
 */
function getSmtpConfig() {
  const user = process.env.QUOTE_RESET_SMTP_USER || DEFAULT_SMTP_USER;
  const pass = process.env.QUOTE_RESET_SMTP_PASS || "";
  if (!pass) {
    throw new Error("QUOTE_RESET_SMTP_PASS is not configured");
  }
  return {
    host: process.env.QUOTE_RESET_SMTP_HOST || DEFAULT_SMTP_HOST,
    port: Number(process.env.QUOTE_RESET_SMTP_PORT || 587),
    secure: false,
    requireTLS: true,
    auth: {user, pass},
  };
}

/**
 * @param {string} email Recipient.
 * @param {string} resetLink Firebase action URL.
 * @return {{subject: string, text: string, html: string}}
 */
function buildResetEmail(email, resetLink) {
  const safeEmail = escapeHtml(email);
  const safeLink = escapeHtml(resetLink);
  const subject = "Reset your quote dashboard password";
  const text =
    `Hello,\n\n` +
    `Reset the quote dashboard password for ${email} using this link:\n` +
    `${resetLink}\n\n` +
    `If you did not request this, you can ignore this email.\n`;
  const html =
    `<p>Hello,</p>` +
    `<p>Reset the quote dashboard password for ` +
    `<strong>${safeEmail}</strong> using this link:</p>` +
    `<p><a href="${safeLink}">${safeLink}</a></p>` +
    `<p>If you did not request this, you can ignore this email.</p>`;
  return {subject, text, html};
}

/**
 * @param {string} to Recipient email.
 * @param {string} resetLink Firebase action URL.
 * @return {Promise<void>}
 */
async function sendResetViaSmtp(to, resetLink) {
  const cfg = getSmtpConfig();
  const from = process.env.QUOTE_RESET_SMTP_FROM || DEFAULT_FROM;
  const mail = buildResetEmail(to, resetLink);
  const transporter = nodemailer.createTransport(cfg);
  await transporter.sendMail({
    from,
    to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
}

/**
 * @param {string} email Recipient email.
 * @param {string} continueUrl Dashboard URL after reset.
 * @return {Promise<string|null>} Firebase reset link or null if no user.
 */
async function generatePasswordResetLink(email, continueUrl) {
  const {token, projectId} = await getAccessToken();
  const headers = {
    "Authorization": "Bearer " + token,
    "Content-Type": "application/json",
    "x-goog-user-project": projectId,
  };
  const body = {
    requestType: "PASSWORD_RESET",
    email,
    returnOobLink: true,
  };
  if (continueUrl) body.continueUrl = continueUrl;

  const url =
    "https://identitytoolkit.googleapis.com/v1/projects/" + projectId +
    "/accounts:sendOobCode";
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    if (text.includes("EMAIL_NOT_FOUND")) return null;
    if (text.includes("RESET_PASSWORD_EXCEED_LIMIT")) {
      const err = new Error("RESET_PASSWORD_EXCEED_LIMIT");
      err.code = "RESET_PASSWORD_EXCEED_LIMIT";
      throw err;
    }
    throw new Error(
        `Reset link failed (${resp.status}): ${text.slice(0, 200)}`,
    );
  }
  const json = JSON.parse(text);
  return json.oobLink || null;
}

/**
 * Generate a Firebase reset link and email it from no-reply SMTP.
 * Unknown / disallowed emails return ok without sending (no enumeration).
 * @param {object} tenant Tenant.
 * @param {string} email Requested email.
 * @param {string} continueUrl Dashboard URL after reset.
 * @return {Promise<{ok: boolean, sent: boolean}>}
 */
async function sendQuotePasswordReset(tenant, email, continueUrl) {
  const trimmed = String(email || "").trim().toLowerCase();
  if (!trimmed || !quoteFirebaseAuth.isAllowedEmail(trimmed)) {
    const err = new Error("Use your company email address");
    err.status = 400;
    throw err;
  }

  const dispatcher = await quoteDispatchers.findDispatcherByEmail(
      tenant, trimmed);
  if (!dispatcher) {
    return {ok: true, sent: false};
  }

  let resetLink;
  try {
    resetLink = await generatePasswordResetLink(trimmed, continueUrl);
  } catch (err) {
    if (err && err.code === "RESET_PASSWORD_EXCEED_LIMIT") {
      console.warn("sendQuotePasswordReset: rate limited for", trimmed);
      return {ok: true, sent: false, rateLimited: true};
    }
    throw err;
  }
  if (!resetLink) {
    return {ok: true, sent: false};
  }

  await sendResetViaSmtp(trimmed, resetLink);
  return {ok: true, sent: true};
}

module.exports = {
  getSmtpConfig,
  buildResetEmail,
  sendResetViaSmtp,
  generatePasswordResetLink,
  sendQuotePasswordReset,
};
