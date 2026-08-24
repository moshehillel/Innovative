#!/usr/bin/env node
/**
 * Probe Primus sales-rep fields via sandbox REST API (read-only).
 * Usage: node scripts/test-sales-rep-probe.js [loadNumber]
 *
 * Uses https://sandbox-api.shipprimus.com/api/v1 (INNUSER) — never production REST.
 * manage.php UI actions are not available on the sandbox REST host.
 */
"use strict";

const {applyPrimusSandboxTestEnv, SANDBOX_BASE_URL} =
  require("./primus-test-env");
applyPrimusSandboxTestEnv();

function pickSalesFields(obj, prefix = "", depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return [];
  const hits = [];
  for (const [key, value] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (/sales|rep|commission/i.test(key)) hits.push({path: p, value});
    if (value && typeof value === "object" && !Array.isArray(value)) {
      hits.push(...pickSalesFields(value, p, depth + 1));
    }
  }
  return hits;
}

async function primusRestGet(urlPath) {
  const base = process.env.PRIMUS_BASE_URL.replace(/\/$/, "");
  const loginResp = await fetch(`${base}/login`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      username: process.env.PRIMUS_USERNAME,
      password: process.env.PRIMUS_PASSWORD,
    }),
  });
  if (!loginResp.ok) {
    return {ok: false, error: `REST login ${loginResp.status}`};
  }
  const loginData = await loginResp.json();
  const token = (loginData.data && loginData.data.accessToken) ||
    (loginData.data && loginData.data.token) ||
    loginData.accessToken || loginData.token;
  if (!token) return {ok: false, error: "REST login: no token"};
  const resp = await fetch(`${base}${urlPath}`, {
    headers: {Authorization: `Bearer ${token}`, Accept: "application/json"},
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    // ignore
  }
  return {ok: resp.ok, status: resp.status, json, text: text.slice(0, 2000)};
}

async function main() {
  const loadNumber = process.argv[2] || "";
  console.log("=== Primus sales rep probe (sandbox REST, read-only) ===");
  console.log("base:", SANDBOX_BASE_URL);
  console.log("user:", process.env.PRIMUS_USERNAME);
  if (!loadNumber) {
    console.log("\nPass a sandbox load/BOL number:");
    console.log("  node scripts/test-sales-rep-probe.js <loadNumber>");
    return;
  }
  console.log("loadNumber:", loadNumber);

  const restBook = await primusRestGet(
      `/book/bolnumber/${encodeURIComponent(loadNumber)}`,
  );
  console.log("\n--- REST GET /book/bolnumber ---");
  console.log("status:", restBook.status);
  if (restBook.json) {
    const results = restBook.json.data && restBook.json.data.results;
    const booking = Array.isArray(results) ? results[0] : results;
    if (!booking) {
      console.log("No booking found on sandbox for this load.");
      return;
    }
    const hits = pickSalesFields(booking);
    console.log("sales-related booking fields:",
        hits.length ? JSON.stringify(hits, null, 2) : "(none)");
    if (booking.BOLId) console.log("BOLId:", booking.BOLId);
    console.log("\ncontactInformation:",
        JSON.stringify(booking.contactInformation || {}, null, 2));
  } else {
    console.log(restBook.error || restBook.text);
  }

  console.log(
      "\nNote: getCorporateSalesPeople / saveBookingSalesRep are manage.php " +
      "UI calls (not on sandbox REST). Capture those from DevTools on prod UI.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
