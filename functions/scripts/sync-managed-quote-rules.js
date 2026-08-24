#!/usr/bin/env node
/**
 * Force-sync managed quote rule defaults (amazon_fc APD-only) into Firestore.
 *
 * Usage:
 *   node scripts/sync-managed-quote-rules.js
 *   node scripts/sync-managed-quote-rules.js --tenant-id default
 */
"use strict";

const admin = require("firebase-admin");
const quoteRules = require("../quote-accessorial-rules");

const PROJECT = "tai-invoice-automation";

/**
 * @return {object}
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {tenantId: "default"};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tenant-id") opts.tenantId = args[++i];
  }
  return opts;
}

/**
 * @param {object} tenant Tenant.
 * @param {string} name Collection.
 * @return {FirebaseFirestore.CollectionReference}
 */
function tcol(tenant, name) {
  const prefix = tenant.tenantId && tenant.tenantId !== "default" ?
    `${tenant.tenantId}_` : "";
  return admin.firestore().collection(`${prefix}${name}`);
}

/**
 * @return {Promise<void>}
 */
async function main() {
  const opts = parseArgs();
  if (!admin.apps.length) {
    admin.initializeApp({projectId: PROJECT});
  }
  quoteRules.init({tcol});
  const tenant = {tenantId: opts.tenantId};
  await quoteRules.ensureDefaultRulesPresent(tenant);
  const rules = await quoteRules.listAllRules(tenant);
  const amz = rules.find((r) => r.id === "amazon_fc");
  console.log("tenant:", opts.tenantId);
  console.log("amazon_fc:", JSON.stringify({
    id: amz && amz.id,
    name: amz && amz.name,
    addAccessorials: amz && amz.addAccessorials,
    notes: amz && amz.notes,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
