#!/usr/bin/env node
/**
 * Enters Pier Pass / Port Check PDFs through processPortFeeEmail —
 * the same path the mailbox uses.
 *
 * Usage:
 *   node scripts/enter-port-fee-invoices.js <invoice.pdf> [invoice.pdf...]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const envFile = path.join(__dirname, "..", ".env.tai-invoice-automation");
if (!fs.existsSync(envFile)) {
  console.error("Missing functions/.env.tai-invoice-automation");
  process.exit(1);
}
for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq < 1) continue;
  const key = trimmed.slice(0, eq).trim();
  let val = trimmed.slice(eq + 1).trim();
  if ((val.startsWith("\"") && val.endsWith("\"")) ||
      (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (!process.env[key]) process.env[key] = val;
}

process.env.PRIMUS_USE_MANAGE_PHP = "true";

const base = String(process.env.PRIMUS_BASE_URL || "");
if (!base || /sandbox/i.test(base)) {
  console.error("Refusing to post. Primus URL is missing or sandbox.");
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({projectId: "tai-invoice-automation"});
}
const db = admin.firestore();

const bridge = require("../primus-ui-bridge");
const portFees = require("../port-fee-invoices");
const mailProvider = require("../mail-provider");
const outlook = require("../outlook-mail");

bridge.init({
  db,
  writeLog: async (level, cat, msg, data) => {
    const extra = data ? ` ${JSON.stringify(data).slice(0, 300)}` : "";
    console.log(`[${level}] ${cat}: ${msg}${extra}`);
  },
});
mailProvider.init({db});

const TENANT = {
  tenantId: "default",
  outlookDocId: "outlook",
  gmailDocId: "gmail",
};

/**
 * Sends the same outbound messages the cloud function sends.
 * @param {object} email Outbound email.
 * @return {Promise<void>}
 */
async function saveOutboundEmail(email) {
  const to = email.forceRecipient ? email.to :
    (process.env.ALERT_EMAIL || email.to || "");
  const cc = email.cc || null;
  console.log(`EMAIL ${email.type}: ${email.subject}`);
  console.log(`  to ${to} cc ${cc || ""}`);
  const tokens = await mailProvider.getTenantMailTokens(TENANT);
  if (!tokens) {
    console.log("  mailbox tokens missing — email not sent");
    return;
  }
  await outlook.sendSimpleMail({
    to,
    cc,
    subject: email.subject,
    bodyHtml: email.html,
  }, tokens, async (next) => {
    await mailProvider.persistTenantMailTokens(TENANT, next);
  });
  console.log("  sent");
}

portFees.init({
  writeLog: async (level, cat, msg, data) => {
    const extra = data ? ` ${JSON.stringify(data).slice(0, 400)}` : "";
    console.log(`[${level}] ${cat}: ${msg}${extra}`);
  },
  saveOutboundEmail,
  fetchPrimusBooking: fetchBooking,
  searchBookingsForTrackingQuery: bridge.searchBookingsForTrackingQuery,
  addPortFeeToLoad: bridge.addPortFeeToLoad,
  resolveNamedVendor: bridge.resolveNamedVendor,
  resolveDueOnReceiptTermId: bridge.resolveDueOnReceiptTermId,
  isManagePhpEnabled: bridge.isManagePhpEnabled,
  pendingCollection: () => db.collection("portFeePending"),
});

let restToken = null;

/**
 * @param {string} loadNumber Primus BOL.
 * @return {Promise<object|null>}
 */
async function fetchBooking(loadNumber) {
  const root = base.replace(/\/$/, "");
  if (!restToken) {
    const login = await fetch(`${root}/login`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        username: process.env.PRIMUS_USERNAME,
        password: process.env.PRIMUS_PASSWORD,
      }),
    });
    const loginData = await login.json();
    restToken = loginData && loginData.data &&
      (loginData.data.accessToken || loginData.data.token);
  }
  const resp = await fetch(
      `${root}/book/bolnumber/${encodeURIComponent(loadNumber)}`,
      {headers: {Authorization: `Bearer ${restToken}`}},
  );
  const data = await resp.json();
  const results = data && data.data && data.data.results;
  return Array.isArray(results) ? (results[0] || null) : (results || null);
}

/**
 * @return {Promise<void>}
 */
async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("Usage: node scripts/enter-port-fee-invoices.js <pdf> [...]");
    process.exit(1);
  }
  const attachments = files.map((file) => {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) {
      throw new Error(`PDF not found: ${abs}`);
    }
    return {
      filename: path.basename(abs),
      mimeType: "application/pdf",
      buffer: fs.readFileSync(abs),
    };
  });
  const sniff = await portFees.sniffPdfAttachments({
    attachments,
    downloadAttachment: async (att) => att.buffer,
  });
  console.log(`Parsed ${sniff.matches.length} invoice(s), ` +
    `${sniff.rejected.length} unreadable.`);
  for (const inv of sniff.matches) {
    console.log(`  ${inv.chargeCode} ${inv.vendorName} ${inv.invoiceNumber} ` +
      `${inv.lines.length} lines $${inv.invoiceTotal}`);
  }
  for (const bad of sniff.rejected) {
    console.log(`  REJECT ${bad.filename}: ${bad.error}`);
  }
  if (!sniff.matches.length) {
    console.error("Nothing to post.");
    process.exit(1);
  }
  const result = await portFees.processPortFeeEmail({
    invoices: sniff.matches,
    rejected: sniff.rejected,
    from: "manual-entry",
    subject: "Pier Pass and Port Check invoices",
  });
  console.log(JSON.stringify({
    handled: result.handled,
    finalStatus: result.finalStatus,
    postedCount: result.postedCount,
    alreadyCount: result.alreadyCount,
    skippedCount: result.skippedCount,
    reason: result.reason || null,
    termsError: result.termsError || null,
    missingLoads: (result.missingLoads || []).map((row) => row.container),
  }, null, 2));
  for (const summary of result.summaries || []) {
    console.log(`\n${summary.chargeCode} ${summary.invoiceNumber}`);
    console.log(`  entered ${summary.postedCount}, ` +
      `already ${summary.alreadyCount}, skipped ${summary.skippedCount}`);
    for (const row of summary.skipped) {
      console.log(`  skip ${row.container} ${row.reason} ` +
        `${row.loadNumber || ""} ${row.error || ""}`);
    }
  }
  if (!result.handled) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
