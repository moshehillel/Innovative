#!/usr/bin/env node
/**
 * One-off: test uploadDriveFile (carrier bill ONLY) against manage.php.
 * Does NOT upload POD — use a real extracted podOnly PDF for that separately.
 *
 * Usage:
 *   node scripts/test-upload-drivefile.js <loadNumber> <carrierBillPdfPath>
 *
 * Requires PRIMUS_USE_MANAGE_PHP=true and credentials in .env.tai-invoice-automation.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const envFile = path.join(__dirname, "..", ".env.tai-invoice-automation");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}
process.env.PRIMUS_USE_MANAGE_PHP = "true";

const LOAD = process.argv[2];
const PDF = process.argv[3];

const bridge = require("../primus-ui-bridge");
bridge.init({
  db: () => ({doc: () => ({get: async () => ({exists: false}),
    set: async () => {}})}),
  writeLog: async (l, c, m, d) => console.log(`[${l}] ${c}: ${m}`,
      d ? JSON.stringify(d).slice(0, 200) : ""),
});

async function fetchBooking(loadNumber) {
  const base = process.env.PRIMUS_BASE_URL;
  const login = await fetch(`${base}/login`, {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({username: process.env.PRIMUS_USERNAME,
      password: process.env.PRIMUS_PASSWORD})});
  const tok = (await login.json()).data.accessToken;
  const resp = await fetch(
      `${base}/book/bolnumber/${encodeURIComponent(loadNumber)}`,
      {headers: {Authorization: `Bearer ${tok}`}});
  const data = await resp.json();
  const r = data && data.data && data.data.results;
  return Array.isArray(r) ? r[0] : r;
}

async function main() {
  if (!LOAD || !PDF) {
    console.error("Usage: node scripts/test-upload-drivefile.js " +
        "<loadNumber> <carrierBillPdfPath>");
    console.error("This script uploads CARRIER BILL only (fileType 372). " +
        "Never pass the carrier invoice PDF for POD upload.");
    process.exit(1);
  }
  if (!fs.existsSync(PDF)) {
    console.error("PDF not found:", PDF);
    process.exit(1);
  }

  const buf = fs.readFileSync(PDF);
  console.log("PDF bytes:", buf.length,
      "header:", buf.slice(0, 5).toString("latin1"));

  const booking = await fetchBooking(LOAD);
  const manageId = bridge._internal.resolveManageBookingId(booking);
  console.log("load:", LOAD, "manageBookingId:", manageId);

  const carrierType =
    process.env.PRIMUS_UI_FILETYPE_CARRIER_BILL || "372";
  const res = await bridge.uploadDriveFile({
    bookingId: manageId,
    bookingBOL: LOAD,
    fileType: carrierType,
    fileBuffer: buf,
    filename: `carrier-bill-${LOAD}.pdf`,
  });
  console.log(`\n[bridge] fileType=${carrierType} ok=${res.ok}` +
    ` status=${res.status} fileId=${res.fileId} err=${res.error}`);
  console.log("  body:", (res.text || "").slice(0, 200));
  if (!res.ok) process.exit(1);
  console.log("\nSUCCESS (carrier bill upload only)");
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
