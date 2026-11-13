#!/usr/bin/env node
/**
 * Delete all emailIntake and gmailQueue documents (fresh start for intake tracking).
 *
 * Usage:
 *   node scripts/cleanup-email-intake.js --dry-run
 *   node scripts/cleanup-email-intake.js --execute
 *   node scripts/cleanup-email-intake.js --execute --collections emailIntake
 *
 * Does NOT delete invoices, emailErrors, or Storage attachments.
 */
"use strict";

const admin = require("firebase-admin");

/** @return {object} */
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    execute: false,
    dryRun: true,
    tenantId: "default",
    collections: ["emailIntake", "gmailQueue"],
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--execute") {
      opts.execute = true;
      opts.dryRun = false;
    } else if (a === "--dry-run") {
      opts.dryRun = true;
      opts.execute = false;
    } else if (a === "--tenant-id") {
      opts.tenantId = args[++i];
    } else if (a === "--collections") {
      opts.collections = String(args[++i] || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    } else if (a.startsWith("--")) {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

/**
 * @param {object} tenant Tenant config.
 * @param {string} name Collection name.
 * @return {FirebaseFirestore.CollectionReference}
 */
function tcol(tenant, name) {
  const prefix = tenant.tenantId && tenant.tenantId !== "default" ?
    `${tenant.tenantId}_` : "";
  return admin.firestore().collection(`${prefix}${name}`);
}

/**
 * @param {FirebaseFirestore.CollectionReference} colRef Collection ref.
 * @param {boolean} dryRun Dry run only.
 * @return {Promise<number>} Deleted (or would-delete) count.
 */
async function deleteCollection(colRef, dryRun) {
  let total = 0;
  let lastDoc = null;

  for (;;) {
    let q = colRef.orderBy(admin.firestore.FieldPath.documentId()).limit(500);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    if (dryRun) {
      total += snap.size;
      if (total <= 5) {
        snap.docs.forEach((d) => {
          const data = d.data() || {};
          console.log(`  sample ${colRef.id}/${d.id.slice(0, 40)}… ` +
            `subject=${JSON.stringify(data.subject || "").slice(0, 50)} ` +
            `discoveredAt=${data.discoveredAt ? "yes" : "no"}`);
        });
      }
    } else {
      const batch = admin.firestore().batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      total += snap.size;
      process.stdout.write(`  deleted ${total} from ${colRef.id}…\r`);
    }

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < 500) break;
  }

  return total;
}

async function main() {
  const opts = parseArgs();
  if (!admin.apps.length) {
    admin.initializeApp({projectId: "tai-invoice-automation"});
  }

  const tenant = {tenantId: opts.tenantId};
  const mode = opts.dryRun ? "DRY RUN" : "EXECUTE";
  console.log(`${mode}: tenant=${opts.tenantId} collections=${opts.collections.join(",")}`);

  const summary = {};
  for (const name of opts.collections) {
    const colRef = tcol(tenant, name);
    console.log(`\nScanning ${name}…`);
    summary[name] = await deleteCollection(colRef, opts.dryRun);
    console.log(`${opts.dryRun ? "Would delete" : "Deleted"} ${summary[name]} doc(s) from ${name}`);
  }

  console.log("\nDone.", JSON.stringify(summary));
  if (opts.dryRun) {
    console.log("Re-run with --execute to delete.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
