/**
 * Firebase Auth verification for quote dispatcher dashboards.
 * Sign-in: email/password on the client.
 */

"use strict";

const admin = require("firebase-admin");

/**
 * @param {object} req HTTP request.
 * @return {Promise<object|null>} Decoded token or null.
 */
async function verifyBearerToken(req) {
  const hdr = req.headers.authorization || req.headers.Authorization || "";
  const match = String(hdr).match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  try {
    return await admin.auth().verifyIdToken(match[1].trim());
  } catch (_) {
    return null;
  }
}

/**
 * @param {string} email User email.
 * @return {boolean}
 */
function isAllowedEmail(email) {
  const raw = process.env.QUOTE_AUTH_ALLOWED_DOMAINS ||
    "innovativecarriers.com,advancedautomations.net";
  const domains = raw.split(",").map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  const parts = String(email || "").toLowerCase().split("@");
  if (parts.length !== 2) return false;
  const domain = parts[1];
  return domains.some((d) => domain === d || domain.endsWith("." + d));
}

/**
 * Public Firebase web config for client SDK.
 * @return {object|null}
 */
function getWebConfig() {
  const apiKey = process.env.QUOTE_FIREBASE_WEB_API_KEY ||
    process.env.FIREBASE_WEB_API_KEY;
  if (!apiKey) return null;
  const projectId = process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    "tai-invoice-automation";
  return {
    apiKey,
    authDomain: process.env.QUOTE_FIREBASE_AUTH_DOMAIN ||
      `${projectId}.firebaseapp.com`,
    projectId,
  };
}

module.exports = {
  verifyBearerToken,
  isAllowedEmail,
  getWebConfig,
};
