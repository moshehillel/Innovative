#!/usr/bin/env node
/**
 * Probe POST /quickbooks/billing on Primus sandbox (INNUSER).
 * Usage:
 *   node scripts/probe-qb-billing.js [customerInvoiceId]
 *   node scripts/probe-qb-billing.js --find [loadNumber]
 *
 * Never hits production REST — uses scripts/primus-test-env.js sandbox creds.
 */
"use strict";

const {
  applyPrimusSandboxTestEnv,
  SANDBOX_BASE_URL,
  SANDBOX_USERNAME,
} = require("./primus-test-env");
applyPrimusSandboxTestEnv();

/**
 * @return {Promise<string>} Bearer token.
 */
async function login() {
  const base = process.env.PRIMUS_BASE_URL.replace(/\/$/, "");
  const loginResp = await fetch(`${base}/login`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      username: process.env.PRIMUS_USERNAME,
      password: process.env.PRIMUS_PASSWORD,
    }),
  });
  const loginText = await loginResp.text();
  if (!loginResp.ok) {
    throw new Error(`login ${loginResp.status}: ${loginText.slice(0, 400)}`);
  }
  const loginData = JSON.parse(loginText);
  const token = (loginData.data && loginData.data.accessToken) ||
    (loginData.data && loginData.data.token) ||
    loginData.accessToken || loginData.token;
  if (!token) throw new Error("login: no token");
  return token;
}

/**
 * @param {string} token Bearer.
 * @param {string} path API path.
 * @param {string} [method] HTTP method.
 * @param {object} [body] JSON body.
 * @return {Promise<{status:number, json:object|null, text:string}>}
 */
async function primus(token, path, method = "GET", body) {
  const base = process.env.PRIMUS_BASE_URL.replace(/\/$/, "");
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const resp = await fetch(`${base}${path}`, opts);
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
 * Summarize QB billing response shape.
 * @param {object|null} json Response JSON.
 * @return {void}
 */
function printQbSummary(json) {
  if (!json) {
    console.log("(no JSON body)");
    return;
  }
  const results = json.data && json.data.results;
  if (results && results.error) {
    console.log("primusError:", results.error);
  }
  const bills = results && results.bills;
  const uploaded = (bills && bills.uploadedBills) || [];
  const failed = (bills && bills.failedBills) || [];
  console.log("uploadedBills:", uploaded.length);
  console.log("failedBills:", failed.length);
  if (uploaded[0]) {
    console.log("uploaded[0]:", JSON.stringify(uploaded[0]).slice(0, 400));
  }
  if (failed[0]) {
    console.log("failed[0]:", JSON.stringify(failed[0]).slice(0, 400));
  }
  if (json.message) console.log("message:", json.message);
  if (json.error) console.log("error:", json.error);
  console.log("snippet:", JSON.stringify(json).slice(0, 1000));
}

/**
 * Try to find an invoice id on a sandbox booking.
 * @param {string} token Bearer.
 * @param {string} loadNumber BOL / load number.
 * @return {Promise<string|null>}
 */
async function findInvoiceId(token, loadNumber) {
  console.log("\n--- Looking up sandbox booking", loadNumber, "---");
  const book = await primus(
      token,
      `/book/bolnumber/${encodeURIComponent(loadNumber)}`,
  );
  console.log("GET /book status:", book.status);
  const results = book.json && book.json.data && book.json.data.results;
  const booking = Array.isArray(results) ? results[0] : results;
  if (!booking) {
    console.log("No booking found.");
    return null;
  }
  const bolId = booking.BOLId || booking.bolId || booking.id;
  console.log("BOLId:", bolId);
  console.log("vendorCost:", booking.vendorCost || booking.cost || null);

  // Common invoice list endpoints — try a few shapes.
  const candidates = [
    `/invoice/bolnumber/${encodeURIComponent(loadNumber)}`,
    bolId ? `/invoice/${bolId}` : null,
    `/invoice?bolnumber=${encodeURIComponent(loadNumber)}`,
  ].filter(Boolean);

  for (const p of candidates) {
    const r = await primus(token, p);
    console.log(`GET ${p} →`, r.status);
    if (!r.json) continue;
    const data = r.json.data && (r.json.data.results || r.json.data);
    const list = Array.isArray(data) ? data : (data ? [data] : []);
    for (const inv of list) {
      if (!inv || typeof inv !== "object") continue;
      const id = inv.invoiceId || inv.id || inv.InvoiceId;
      const num = inv.invoiceNumber || inv.number;
      if (id) {
        console.log("found invoiceId:", id, "invoiceNumber:", num || null);
        return String(id);
      }
    }
    console.log("  snippet:", JSON.stringify(r.json).slice(0, 300));
  }
  return null;
}

async function main() {
  console.log("=== Primus QB billing probe (SANDBOX) ===");
  console.log("base:", SANDBOX_BASE_URL);
  console.log("user:", SANDBOX_USERNAME);

  const token = await login();
  console.log("login: ok");

  const args = process.argv.slice(2);
  let invoiceId = null;

  if (args[0] === "--find") {
    const load = args[1];
    if (!load) {
      console.error("Usage: node scripts/probe-qb-billing.js --find <loadNumber>");
      process.exit(1);
    }
    invoiceId = await findInvoiceId(token, load);
    if (!invoiceId) {
      console.error("Could not resolve an invoiceId for load", load);
      process.exit(2);
    }
  } else {
    invoiceId = args[0] || null;
  }

  if (!invoiceId) {
    // Discover any recent invoice via a known sandbox load if argv empty:
    // try a few common probe loads, else print usage.
    console.log("\nNo invoiceId given. Trying discovery on a few sandbox loads...");
    const tryLoads = ["264091", "100000", "1"];
    for (const load of tryLoads) {
      invoiceId = await findInvoiceId(token, load);
      if (invoiceId) break;
    }
  }

  if (!invoiceId) {
    console.log("\nPass an invoice id or --find <loadNumber>:");
    console.log("  node scripts/probe-qb-billing.js <customerInvoiceId>");
    console.log("  node scripts/probe-qb-billing.js --find <loadNumber>");
    process.exit(1);
  }

  console.log("\n--- POST /quickbooks/billing ---");
  console.log("invoiceId:", invoiceId);
  const qb = await primus(token, "/quickbooks/billing", "POST", {invoiceId});
  console.log("status:", qb.status);
  if (!qb.json) {
    console.log("body:", qb.text.slice(0, 1200));
  } else {
    printQbSummary(qb.json);
  }

  // Verdict for our workflow helper contract
  const results = qb.json && qb.json.data && qb.json.data.results;
  const bills = results && results.bills;
  const uploaded = (bills && bills.uploadedBills &&
    bills.uploadedBills.length) || 0;
  if (qb.status >= 200 && qb.status < 300 && uploaded > 0) {
    console.log("\nVERDICT: endpoint OK — uploadedBills > 0 (payload shape matches)");
  } else if (qb.status >= 200 && qb.status < 300 && results && results.error) {
    console.log("\nVERDICT: endpoint OK — Primus results.error present; " +
      "helper alerts QB_BILLING_FAILED with that message");
  } else if (qb.status >= 200 && qb.status < 300) {
    console.log("\nVERDICT: endpoint reachable — 0 uploaded bills (same response " +
      "shape our helper treats as QB_BILLING_FAILED / alert). " +
      "Sandbox returns empty bills when no carrier payable exists yet.");
  } else {
    console.log("\nVERDICT: endpoint error — helper would alert QB_BILLING_FAILED");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
