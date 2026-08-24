#!/usr/bin/env node
/**
 * Permanently remove retired quote defaults (AAFES, nursing home, hotel)
 * and tombstone them so ensureDefaultRulesPresent cannot recreate them.
 *
 * Usage:
 *   node scripts/remove-retired-quote-rules.js
 *   node scripts/remove-retired-quote-rules.js --tenant-id default
 */
"use strict";

const admin = require("firebase-admin");
const quoteRules = require("../quote-accessorial-rules");

const PROJECT = "tai-invoice-automation";
const RULE_IDS = ["nursing_home", "hotel"];

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

  for (const id of RULE_IDS) {
    console.log("Deleting", id);
    await quoteRules.deleteRule(tenant, id, "remove-retired-quote-rules");
    await quoteRules.markDefaultRuleRemoved(
        tenant, id, "remove-retired-quote-rules");
  }

  await quoteRules.ensureDefaultRulesPresent(tenant);
  const rules = await quoteRules.listAllRules(tenant);
  const removed = await quoteRules.loadRemovedDefaultRuleIds(tenant);
  const still = RULE_IDS.filter((id) => rules.some((r) => r.id === id));

  console.log("tenant:", opts.tenantId);
  console.log("still present:", still.length ? still.join(",") : "(none)");
  console.log("tombstoned:", RULE_IDS.map((id) =>
    id + "=" + removed.has(id)).join(", "));
  if (still.length) {
    console.error("FAIL: rules still present after removal");
    process.exit(1);
  }
  console.log("OK: retired rules gone and will not reseed");
  console.log("active ids:", rules.filter((r) => r.active !== false)
      .map((r) => r.id).join(", "));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
