#!/usr/bin/env node
/**
 * Permanently remove aafes_military from Firestore and tombstone it so
 * ensureDefaultRulesPresent cannot recreate it.
 *
 * Usage:
 *   node scripts/remove-aafes-quote-rule.js
 *   node scripts/remove-aafes-quote-rule.js --tenant-id default
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

  console.log("Deleting", RULE_ID, "for tenant", opts.tenantId);
  await quoteRules.deleteRule(tenant, RULE_ID, "remove-aafes-quote-rule");
  // Extra tombstone even though aafes is no longer in DEFAULT_RULES.
  await quoteRules.markDefaultRuleRemoved(
      tenant, RULE_ID, "remove-aafes-quote-rule");

  await quoteRules.ensureDefaultRulesPresent(tenant);
  const rules = await quoteRules.listAllRules(tenant);
  const again = rules.find((r) => r.id === RULE_ID);
  const removed = await quoteRules.loadRemovedDefaultRuleIds(tenant);

  console.log("tenant:", opts.tenantId);
  console.log("aafes_military present after delete+ensure:", !!again);
  console.log("tombstoned:", removed.has(RULE_ID));
  if (again) {
    console.error("FAIL: rule still present after removal");
    process.exit(1);
  }
  console.log("OK: aafes_military gone and will not reseed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
