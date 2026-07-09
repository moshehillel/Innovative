#!/usr/bin/env node
/**
 * One-off: send emailBOLDocs for a load via manage.php (test address).
 * Usage: node scripts/test-email-boldocs.js <loadNumber> [toEmail]
 * (loadNumber is required per shipment — default 264091 is test-only)
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

const LOAD = process.argv[2] || "264091";
const TO_EMAIL = process.argv[3] || "moshe@advancedautomations.net";

const bridge = require("../primus-ui-bridge");

const stubDb = () => ({
  doc: () => ({
    get: async () => ({exists: false}),
    set: async () => {},
  }),
});

bridge.init({
  db: stubDb,
  writeLog: async (level, cat, msg, data) => {
    console.log(`[${level}] ${cat}: ${msg}`,
        data ? JSON.stringify(data).slice(0, 400) : "");
  },
});

async function getPrimusToken() {
  const base = process.env.PRIMUS_BASE_URL ||
    "https://restapi.shipprimus.com/api/v1";
  const resp = await fetch(`${base}/login`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      username: process.env.PRIMUS_USERNAME,
      password: process.env.PRIMUS_PASSWORD,
    }),
  });
  const data = await resp.json();
  const token = data && data.data && data.data.accessToken;
  if (!token) throw new Error("REST login failed");
  return token;
}

async function fetchBooking(loadNumber) {
  const base = process.env.PRIMUS_BASE_URL ||
    "https://restapi.shipprimus.com/api/v1";
  const token = await getPrimusToken();
  const resp = await fetch(
      `${base}/book/bolnumber/${encodeURIComponent(loadNumber)}`,
      {headers: {Authorization: `Bearer ${token}`}},
  );
  const data = await resp.json();
  const results = data && data.data && data.data.results;
  if (Array.isArray(results)) return results[0] || null;
  if (results && typeof results === "object") return results;
  return null;
}

/**
 * @param {object} docData getBookingDocuments body.
 * @return {object|null}
 */
function findIssuedUiInvoice(docData) {
  if (!docData || !Array.isArray(docData.invoices)) return null;
  return docData.invoices.find((inv) => {
    const num = inv.invoiceNumber;
    return num != null && String(num) !== "" && String(num) !== "0";
  }) || null;
}

async function main() {
  console.log("Load:", LOAD);
  console.log("To:", TO_EMAIL);
  console.log("manage.php:", process.env.PRIMUS_UI_MANAGE_URL);

  const booking = await fetchBooking(LOAD);
  if (!booking || !booking.BOLId) {
    console.error("FAIL: booking not found for load", LOAD);
    process.exit(1);
  }
  console.log("BOLId (REST):", booking.BOLId);
  const manageBookingId = bridge._internal.resolveManageBookingId(booking);
  console.log("bookingId (manage.php):", manageBookingId);

  const docs = await bridge.getBookingDocuments({
    bookingId: manageBookingId,
    bookingBOL: LOAD,
  });
  if (!docs.ok) {
    console.error("FAIL: getBookingDocuments —", docs.error || docs.raw);
    process.exit(1);
  }

  const uiInv = findIssuedUiInvoice(docs.data);
  if (!uiInv || !uiInv.id) {
    console.error("FAIL: no issued UI invoice in getBookingDocuments");
    console.log(JSON.stringify(docs.data.invoices || [], null, 2));
    process.exit(1);
  }
  console.log("UI customerInvoiceId:", uiInv.id,
      "invoiceNumber:", uiInv.invoiceNumber,
      "chargesTotal:", uiInv.chargesTotal || uiInv.total);

  const internal = bridge._internal;
  const podIds = internal.listPodDriveFileIds(
      docs.data, process.env.PRIMUS_UI_FILETYPE_POD || "0");
  console.log("POD drive ids:", podIds);

  const chargesTotal = uiInv.chargesTotal != null ?
    Number(uiInv.chargesTotal).toFixed(2) :
    (uiInv.total != null ? Number(uiInv.total).toFixed(2) : "0.00");

  const result = await bridge.emailBOLDocs({
    booking,
    loadNumber: LOAD,
    customerEmail: TO_EMAIL,
    customerInvoiceId: uiInv.id,
    invoiceNumber: String(uiInv.invoiceNumber || "0"),
    chargesTotal,
  });

  console.log("\n--- emailBOLDocs result ---");
  console.log(JSON.stringify({
    ok: result.ok,
    status: result.status,
    to: result.to,
    attachments: result.attachments,
    driveFileIds: result.driveFileIds,
    json: result.json,
    error: result.error,
    raw: result.raw,
  }, null, 2));

  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(2);
});
