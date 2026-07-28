#!/usr/bin/env node
/**
 * Classify a local PDF, run Jerry's Primus UI billing flow, verify carrier
 * name on payable, and test QB Desktop push (rePushToQB).
 *
 * Usage:
 *   node scripts/run-load-billing-qb-test.js <pdf-path> [--billing-only]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

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

const bridge = require("../primus-ui-bridge");
const mockDoc = {
  get: async () => ({exists: false}),
  set: async () => {},
};
bridge.init({
  db: {doc: () => mockDoc},
  writeLog: async (level, cat, msg, data) => {
    console.log(`[${level}] ${cat}: ${msg}`,
        data ? JSON.stringify(data).slice(0, 400) : "");
  },
});

const manageUrl = process.env.PRIMUS_UI_MANAGE_URL ||
  "https://shipprimus.com/PRIMUS/trunk/manage.php";

/**
 * @param {Buffer} pdfBuffer PDF bytes.
 * @param {string} filename Original filename.
 * @return {Promise<object>}
 */
async function classifyPdf(pdfBuffer, filename) {
  const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
  const response = await client.messages.create({
    model: process.env.ANTHROPIC_CLASSIFY_MODEL || "claude-haiku-4-5",
    max_tokens: 4096,
    messages: [{
      role: "user",
      content: [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: pdfBuffer.toString("base64"),
          },
          title: filename,
        },
        {
          type: "text",
          text: "Extract the carrier freight invoice as JSON: " +
            "{ status, invoiceNumber, loadNumber, proNumber, " +
            "invoiceAmount, invoiceDate, dueDate, carrierName, " +
            "invoicePages }. loadNumber = broker Primus load (5-9 digits). " +
            "Return ONLY valid JSON for the first invoice.",
        },
      ],
    }],
  });
  const text = (response.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("AI did not return JSON: " + text.slice(0, 300));
  return JSON.parse(jsonMatch[0]);
}

/**
 * @param {string} loadNumber BOL.
 * @return {Promise<object|null>}
 */
async function fetchBooking(loadNumber) {
  const base = process.env.PRIMUS_BASE_URL.replace(/\/$/, "");
  const loginResp = await fetch(`${base}/login`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      username: process.env.PRIMUS_USERNAME,
      password: process.env.PRIMUS_PASSWORD,
    }),
  });
  const loginData = JSON.parse(await loginResp.text());
  const token = loginData.data.accessToken || loginData.data.token;
  const resp = await fetch(
      `${base}/book/bolnumber/${encodeURIComponent(loadNumber)}`,
      {headers: {Authorization: `Bearer ${token}`, Accept: "application/json"}},
  );
  const data = JSON.parse(await resp.text());
  const results = data.data && data.data.results;
  return Array.isArray(results) ? (results[0] || null) : (results || null);
}

/**
 * @param {string} cookie PHPSESSID.
 * @param {object} params Form fields.
 * @return {Promise<object>}
 */
async function uiPost(cookie, params) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    form.set(key, String(value));
  }
  const resp = await fetch(manageUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Cookie: `PHPSESSID=${cookie}`,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: form.toString(),
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    // ignore
  }
  return {status: resp.status, json, text};
}

/**
 * @return {Promise<string>}
 */
async function uiLogin() {
  const body = new URLSearchParams({
    action: "login",
    logout: "false",
    loginUsername: process.env.PRIMUS_UI_USERNAME || process.env.PRIMUS_USERNAME,
    loginPassword: process.env.PRIMUS_UI_PASSWORD || process.env.PRIMUS_PASSWORD,
    browser: "Chrome",
    browserVersion: "149",
    os: "Windows",
  });
  const resp = await fetch(manageUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: body.toString(),
    redirect: "manual",
  });
  const raw = resp.headers.get("set-cookie") || "";
  const match = raw.match(/PHPSESSID=([^;,\s]+)/i);
  if (!match) throw new Error("UI login failed — no PHPSESSID");
  return match[1];
}

/**
 * @param {object|null} storeData getInvoiceStores response.
 * @return {Array<object>}
 */
function extractActualCosts(storeData) {
  const breakdown = storeData &&
    storeData.breakdowns &&
    storeData.breakdowns.invoicesActualCostBreakdown;
  return Array.isArray(breakdown) ? breakdown : [];
}

async function main() {
  const pdfPath = process.argv[2];
  const billingOnly = process.argv.includes("--billing-only");
  if (!pdfPath) {
    console.error("Usage: node scripts/run-load-billing-qb-test.js <pdf-path>");
    process.exit(1);
  }

  const filename = path.basename(pdfPath);
  const pdfBuffer = fs.readFileSync(pdfPath);
  let ai = null;
  if (!billingOnly) {
    console.log("Classifying", filename, "...");
    ai = await classifyPdf(pdfBuffer, filename);
    console.log("AI extraction:", JSON.stringify(ai, null, 2));
  }

  const loadNumber = String(
      (ai && ai.loadNumber) || process.env.TEST_LOAD_NUMBER || "265042");
  console.log("\nFetching booking", loadNumber, "...");
  const booking = await fetchBooking(loadNumber);
  if (!booking || !booking.BOLId) {
    throw new Error("Booking not found for load " + loadNumber);
  }

  const customerRate = Number(
      (booking.accountingInformation &&
        booking.accountingInformation.invoiceAmount) ||
      ai && ai.invoiceAmount || 0);
  if (!customerRate) {
    throw new Error("Could not resolve customer rate for billing");
  }

  console.log("Customer rate:", customerRate,
      "| Vendor:", booking.vendor && booking.vendor.name);

  const uiResult = await bridge.runPrimusUiBillingFlow({
    booking,
    loadNumber,
    customerRate,
    carrierInvoiceAmount: ai ? Number(ai.invoiceAmount) : booking.vendor.cost,
    carrierName: (ai && ai.carrierName) || booking.vendor.name,
    proNumber: ai && ai.proNumber,
    vendorInvoiceNumber: ai && ai.invoiceNumber,
    billDate: ai && ai.invoiceDate,
    billDueDate: ai && ai.dueDate,
    generated: false,
    carrierBillPdf: {
      buffer: pdfBuffer,
      filename,
    },
    skipPodUpload: true,
  });

  console.log("\nBilling result:");
  console.log(JSON.stringify(uiResult, null, 2));

  if (!uiResult.ok && !(uiResult.skipped && uiResult.reason === "already issued")) {
    process.exit(2);
  }

  const uiInvoiceId = String(uiResult.customerInvoiceId);
  const invoiceNumber = String(uiResult.invoiceNumber || "");
  console.log("\nIssued invoice id:", uiInvoiceId, "number:", invoiceNumber);

  const cookie = await uiLogin();
  const stores = await uiPost(cookie, {
    action: "getInvoiceStores",
    id: uiInvoiceId,
  });
  const actual = extractActualCosts(stores.json);
  console.log("\nPayable lines (actual costs):", actual.length);
  for (const line of actual) {
    console.log(" ", JSON.stringify({
      carrierId: line.carrierId,
      carrierName: line.carrierName,
      vendorRef: line.vendorRefNumber || line.vendorRef,
      total: line.total || line.cost,
    }));
  }

  const hasCarrierName = actual.some((l) =>
    l.carrierName && String(l.carrierName).trim());
  console.log("\nCarrier name populated on payable:", hasCarrierName ? "YES" : "NO");

  console.log("\n--- REST POST /quickbooks/billing (Jerry path) ---");
  const base = process.env.PRIMUS_BASE_URL.replace(/\/$/, "");
  const loginResp = await fetch(`${base}/login`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      username: process.env.PRIMUS_USERNAME,
      password: process.env.PRIMUS_PASSWORD,
    }),
  });
  const loginData = JSON.parse(await loginResp.text());
  const token = loginData.data.accessToken || loginData.data.token;
  const qbRest = await fetch(`${base}/quickbooks/billing`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({invoiceId: uiInvoiceId}),
  });
  const qbRestBody = JSON.parse(await qbRest.text());
  const restErr = qbRestBody.data && qbRestBody.data.results &&
    qbRestBody.data.results.error;
  console.log("REST status:", qbRest.status, "error:", restErr);

  console.log("\n--- UI rePushToQB (Desktop path) ---");
  const qbUi = await uiPost(cookie, {
    action: "rePushToQB",
    invoiceId: uiInvoiceId,
    invoiceNumber,
  });
  console.log("rePushToQB:", JSON.stringify(qbUi.json || qbUi.text));

  console.log("\n=== SUMMARY ===");
  console.log("Load:", loadNumber);
  console.log("Invoice #:", invoiceNumber, "(UI id", uiInvoiceId + ")");
  console.log("Carrier name on payable:", hasCarrierName ? "yes" : "no");
  console.log("REST QB:", restErr || "no error field");
  console.log("UI QB:", (qbUi.json && qbUi.json.message) || qbUi.text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
