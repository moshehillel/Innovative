/**
 * Signed tokens for one-click email action links. GET shows a confirm page;
 * only POST with a valid token executes the action (blocks link scanners).
 */
"use strict";

const crypto = require("crypto");

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_PUBLIC_BASE_URL =
  "https://us-central1-tai-invoice-automation.cloudfunctions.net";

/**
 * HTTPS base URL for signed action links embedded in outbound emails.
 * Always use this (not req.get("host")) so links target cloudfunctions.net
 * function paths, not a workflow function's run.app host.
 * @return {string}
 */
function publicFunctionsBaseUrl() {
  return process.env.PUBLIC_FUNCTIONS_BASE_URL || DEFAULT_PUBLIC_BASE_URL;
}

/**
 * Escapes a URL for use in an HTML href attribute (email-safe ampersands).
 * @param {string} value Raw URL.
 * @return {string}
 */
function escapeHtmlAttr(value) {
  return String(value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
}

/**
 * @return {string} HMAC secret.
 */
function secret() {
  const s = process.env.EMAIL_ACTION_SECRET ||
    process.env.PRIMUS_PASSWORD ||
    process.env.GMAIL_CLIENT_ID;
  if (!s) {
    throw new Error("EMAIL_ACTION_SECRET (or fallback secret) not configured");
  }
  return String(s);
}

/**
 * @param {string} action Action namespace (e.g. additionalCharge).
 * @param {string} invoiceId Firestore invoice id.
 * @param {string} option Decision option (a|b|c|d|e, approve|reject, …).
 * @param {string|null} tenantId Tenant id.
 * @param {number} [expMs] Expiry epoch ms.
 * @return {string} Hex HMAC signature.
 */
function sign(action, invoiceId, option, tenantId, expMs) {
  const payload = [
    action,
    String(invoiceId),
    String(option).toLowerCase(),
    String(tenantId || ""),
    String(expMs),
  ].join("|");
  return crypto.createHmac("sha256", secret())
      .update(payload)
      .digest("hex");
}

/**
 * @param {object} opts action, invoiceId, option, tenantId, exp.
 * @return {boolean}
 */
function verify(opts) {
  const exp = Number(opts.exp);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expected = sign(
      opts.action,
      opts.invoiceId,
      opts.option,
      opts.tenantId,
      exp,
  );
  const got = String(opts.sig || "");
  if (!got || got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(
        Buffer.from(got, "hex"),
        Buffer.from(expected, "hex"),
    );
  } catch (_) {
    return false;
  }
}

/**
 * Builds a signed GET URL that opens the confirmation page.
 * @param {object} opts baseUrl, path, action, invoiceId, option, tenantId.
 * @return {string}
 */
function buildConfirmUrl(opts) {
  const exp = Date.now() + DEFAULT_TTL_MS;
  const sig = sign(
      opts.action,
      opts.invoiceId,
      opts.option,
      opts.tenantId,
      exp,
  );
  const params = new URLSearchParams({
    invoiceId: String(opts.invoiceId),
    option: String(opts.option).toLowerCase(),
    exp: String(exp),
    sig,
  });
  if (opts.tenantId) params.set("tenantId", String(opts.tenantId));
  if (opts.decision) params.set("decision", String(opts.decision));
  const path = opts.path || "additionalChargeAction";
  return `${opts.baseUrl.replace(/\/$/, "")}/${path}?${params.toString()}`;
}

module.exports = {
  DEFAULT_TTL_MS,
  DEFAULT_PUBLIC_BASE_URL,
  publicFunctionsBaseUrl,
  escapeHtmlAttr,
  sign,
  verify,
  buildConfirmUrl,
};
