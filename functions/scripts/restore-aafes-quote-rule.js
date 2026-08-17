#!/usr/bin/env node
/**
 * Recreate aafes_military (LAD + APD, identifyVia ai) and drop its
 * quoteRulesRemoved tombstone.
 *
 * Usage:
 *   node scripts/restore-aafes-quote-rule.js
 *   node scripts/restore-aafes-quote-rule.js --tenant-id default
 */
"use strict";

const admin = require("firebase-admin");
const quoteRules = require("../quote-accessorial-rules");

const PROJECT = "tai-invoice-automation";
const RULE_ID = "aafes_military";

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
  try {
    admin.firestore().settings({preferRest: true});
  } catch (_) {
    // already set
  }
  quoteRules.init({tcol});
  const tenant = {tenantId: opts.tenantId};
  const seed = quoteRules.DEFAULT_RULES.find((r) => r.id === RULE_ID);
  if (!seed) {
    throw new Error("DEFAULT_RULES missing " + RULE_ID);
  }
  const {id, ...patch} = seed;

  console.log("Clearing tombstone and upserting", id);
  await quoteRules.clearRemovedDefaultRule(tenant, id);
  const rule = await quoteRules.upsertRule(
      tenant, id, patch, "restore-aafes-quote-rule");
  const removed = await quoteRules.loadRemovedDefaultRuleIds(tenant);

  console.log("tenant:", opts.tenantId);
  console.log("rule:", JSON.stringify({
    id: rule.id,
    name: rule.name,
    identifyVia: rule.identifyVia,
    match: rule.match,
    addAccessorials: rule.addAccessorials,
    notes: rule.notes,
  }, null, 2));
  console.log("tombstoned:", removed.has(id));
  const codes = (rule.addAccessorials || []).map(String);
  if (!codes.includes("LAD") || !codes.includes("APD")) {
    console.error("FAIL: expected LAD+APD");
    process.exit(1);
  }
  if (removed.has(id)) {
    console.error("FAIL: tombstone still present");
    process.exit(1);
  }
  console.log("OK: military rule live with LAD+APD");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
