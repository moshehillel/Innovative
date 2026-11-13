#!/usr/bin/env node
/**
 * Live round-trip test: swap a load's sales rep to the 10% variant, then swap back.
 * Usage: node scripts/test-broker-swap-roundtrip.js <loadNumber>
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

const bridge = require("../primus-ui-bridge");
const brokerCommission = require("../broker-commission");

const mockDoc = {
  get: async () => ({exists: false}),
  set: async () => {},
};
bridge.init({
  db: {doc: () => mockDoc},
  writeLog: async (level, cat, msg, data) => {
    console.log(`[${level}] ${cat}: ${msg}`,
        data ? JSON.stringify(data).slice(0, 500) : "");
  },
});

brokerCommission.init({
  writeLog: async (level, cat, msg, data) => {
    console.log(`[${level}] ${cat}: ${msg}`,
        data ? JSON.stringify(data).slice(0, 500) : "");
  },
  primusUiBridge: bridge,
  fetchPrimusBooking,
});

/**
 * @param {string} loadNumber
 * @return {Promise<object|null>}
 */
async function fetchPrimusBooking(loadNumber) {
  const base = (process.env.PRIMUS_BASE_URL || "").replace(/\/$/, "");
  const loginResp = await fetch(`${base}/login`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      username: process.env.PRIMUS_USERNAME,
      password: process.env.PRIMUS_PASSWORD,
    }),
  });
  if (!loginResp.ok) {
    throw new Error(`REST login failed: ${loginResp.status}`);
  }
  const loginData = await loginResp.json();
  const token = (loginData.data && loginData.data.accessToken) ||
    (loginData.data && loginData.data.token) ||
    loginData.accessToken || loginData.token;
  if (!token) throw new Error("REST login: no token");

  const resp = await fetch(
      `${base}/book/bolnumber/${encodeURIComponent(loadNumber)}`,
      {headers: {Authorization: `Bearer ${token}`, Accept: "application/json"}},
  );
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    // ignore
  }
  if (!resp.ok) {
    throw new Error(`REST book lookup ${resp.status}: ${text.slice(0, 200)}`);
  }
  const results = json && json.data && json.data.results;
  return Array.isArray(results) ? results[0] || null : results || null;
}

/**
 * @param {Array<object>} reps
 * @return {string}
 */
function formatReps(reps) {
  return (reps || []).map((r) =>
    `${r.display || r.salesPersonId} (${r.salesPersonId})`).join(", ") ||
    "(none)";
}

/**
 * @param {object} row Catalog row.
 * @return {object}
 */
function repToSaveRow(row) {
  return {
    salesPersonId: String(row.id || row.salesPersonId),
    firstName: row.firstName || "",
    lastName: row.lastName || "",
    display: row.display ||
      `${row.firstName || ""} ${row.lastName || ""}`.trim(),
  };
}

async function main() {
  const loadNumber = (process.argv[2] || "").trim();
  if (!loadNumber) {
    console.error("Usage: node scripts/test-broker-swap-roundtrip.js <loadNumber>");
    process.exit(1);
  }

  console.log("=== Broker swap round-trip test ===");
  console.log("load:", loadNumber);
  console.log("manage:", process.env.PRIMUS_UI_MANAGE_URL ||
    "https://shipprimus.com/PRIMUS/trunk/manage.php");
  console.log("REST:", process.env.PRIMUS_BASE_URL);

  const booking = await fetchPrimusBooking(loadNumber);
  if (!booking) {
    console.error("FAIL: load not found via REST");
    process.exit(1);
  }

  const bookingId = bridge.resolveManageBookingId(booking);
  if (!bookingId) {
    console.error("FAIL: could not resolve manage.php booking id");
    process.exit(1);
  }
  console.log("bookingId:", bookingId);

  const before = await bridge.getBookingSalesRep(bookingId);
  console.log("BEFORE reps:", formatReps(before));
  if (!before.length) {
    console.error("FAIL: no sales rep on load");
    process.exit(1);
  }

  const catalog = await bridge.fetchAllCorporateSalesPeople();
  const byId = new Map(catalog.map((r) => [String(r.id), r]));
  const currentId = String(before[0].salesPersonId);
  const currentRow = byId.get(currentId);
  console.log("current catalog row:",
      currentRow ? `${currentRow.display} @ ${currentRow.percentage}%` :
      `(id ${currentId} not in catalog)`);

  const stripSuffix = (name) => String(name || "")
      .replace(/\s*\.\d+\s*$/i, "")
      .replace(/\s*\d+(\.\d+)?%\s*$/i, "")
      .trim()
      .toLowerCase();
  const key = currentRow ?
    (currentRow.email ? `email:${currentRow.email.toLowerCase()}` :
      `name:${(currentRow.firstName || "").toLowerCase()}|` +
      `${(currentRow.lastName || "").toLowerCase()}`) :
    `display:${stripSuffix(before[0].display)}`;

  let tenPctRow = null;
  for (const row of catalog) {
    const rowKey = row.email ? `email:${row.email.toLowerCase()}` :
      `name:${(row.firstName || "").toLowerCase()}|` +
      `${(row.lastName || "").toLowerCase()}`;
    if (rowKey === key && Number(row.percentage) === 10) {
      tenPctRow = row;
      break;
    }
  }

  if (!tenPctRow) {
    console.error("FAIL: no 10% variant found for current rep family");
    process.exit(1);
  }
  if (String(tenPctRow.id) === currentId) {
    console.log("Already on 10% rep — will swap to a sibling non-10% then back.");
    const siblings = catalog.filter((row) => {
      const rowKey = row.email ? `email:${row.email.toLowerCase()}` :
        `name:${(row.firstName || "").toLowerCase()}|` +
        `${(row.lastName || "").toLowerCase()}`;
      return rowKey === key && String(row.id) !== currentId;
    });
    if (!siblings.length) {
      console.error("FAIL: only one rep in family");
      process.exit(1);
    }
    const tempRow = siblings[0];
    console.log("\n--- Step 1: swap to non-10% temp ---");
    console.log("target:", `${tempRow.display} (${tempRow.id})`);
    const step1 = await bridge.swapBookingSalesRep({
      bookingId,
      tenPctRow: tempRow,
      removedReps: before,
    });
    console.log("step1 ok:", step1.ok, step1.error || "");
    if (!step1.ok) {
      console.error("FAIL step1:", JSON.stringify(step1, null, 2));
      process.exit(1);
    }
    const mid = await bridge.getBookingSalesRep(bookingId);
    console.log("AFTER step1:", formatReps(mid));

    console.log("\n--- Step 2: swap back to original 10% ---");
    const step2 = await bridge.swapBookingSalesRep({
      bookingId,
      tenPctRow: currentRow || before[0],
      removedReps: mid,
    });
    console.log("step2 ok:", step2.ok, step2.error || "");
    if (!step2.ok) {
      console.error("FAIL step2 — manual fix may be needed:",
          JSON.stringify(step2, null, 2));
      process.exit(1);
    }
  } else {
    console.log("\n--- Step 1: swap to 10% ---");
    console.log("target:", `${tenPctRow.display} (${tenPctRow.id})`);
    const step1 = await bridge.swapBookingSalesRep({
      bookingId,
      tenPctRow,
      removedReps: before,
    });
    console.log("step1 ok:", step1.ok, step1.error || "");
    if (!step1.ok) {
      console.error("FAIL step1:", JSON.stringify(step1, null, 2));
      process.exit(1);
    }
    const mid = await bridge.getBookingSalesRep(bookingId);
    console.log("AFTER step1:", formatReps(mid));

    console.log("\n--- Step 2: swap back to original ---");
    const restoreRow = currentRow || before[0];
    const step2 = await bridge.swapBookingSalesRep({
      bookingId,
      tenPctRow: restoreRow,
      removedReps: mid,
    });
    console.log("step2 ok:", step2.ok, step2.error || "");
    if (!step2.ok) {
      console.error("FAIL step2 — manual fix may be needed:",
          JSON.stringify(step2, null, 2));
      process.exit(1);
    }
  }

  const after = await bridge.getBookingSalesRep(bookingId);
  console.log("\nAFTER restore:", formatReps(after));
  const restored = String(after[0] && after[0].salesPersonId) === currentId;
  if (restored) {
    console.log("\nSUCCESS: round-trip complete, rep restored.");
    process.exit(0);
  }
  console.error("\nFAIL: rep after restore does not match original");
  process.exit(1);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
