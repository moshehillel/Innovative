/**
 * Signed access tokens for per-dispatcher quote dashboards.
 */

"use strict";

const crypto = require("crypto");

/**
 * @return {string}
 */
function dashboardSecret() {
  return process.env.QUOTE_DASHBOARD_SECRET ||
    process.env.GMAIL_WEBHOOK_SECRET ||
    "quote-dashboard-dev-secret";
}

/**
 * @param {string} dispatcherId Dispatcher id.
 * @param {string} tenantId Tenant id.
 * @return {string} Hex token (stable bookmark per dispatcher).
 */
function signDispatcherToken(dispatcherId, tenantId) {
  return crypto.createHmac("sha256", dashboardSecret())
      .update(`${String(tenantId)}:${String(dispatcherId)}`)
      .digest("hex")
      .slice(0, 40);
}

/**
 * @param {string} dispatcherId Dispatcher id.
 * @param {string} tenantId Tenant id.
 * @param {string} token Token from query string.
 * @return {boolean}
 */
function verifyDispatcherToken(dispatcherId, tenantId, token) {
  if (!dispatcherId || !tenantId || !token) return false;
  const expected = signDispatcherToken(dispatcherId, tenantId);
  try {
    return crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(String(token)),
    );
  } catch (_) {
    return false;
  }
}

/**
 * @param {string} quoteId Quote doc id.
 * @param {string} tenantId Tenant id.
 * @param {string} dispatcherId Dispatcher id.
 * @return {string}
 */
function signQuoteAccessToken(quoteId, tenantId, dispatcherId) {
  return crypto.createHmac("sha256", dashboardSecret())
      .update(`q:${tenantId}:${quoteId}:${dispatcherId}`)
      .digest("hex")
      .slice(0, 40);
}

/**
 * @param {object} opts quoteId, tenantId, dispatcherId, token.
 * @return {boolean}
 */
function verifyQuoteAccessToken(opts) {
  const expected = signQuoteAccessToken(
      opts.quoteId, opts.tenantId, opts.dispatcherId);
  try {
    return crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(String(opts.token || "")),
    );
  } catch (_) {
    return false;
  }
}

module.exports = {
  signDispatcherToken,
  verifyDispatcherToken,
  signQuoteAccessToken,
  verifyQuoteAccessToken,
};
