#!/usr/bin/env node
/**
 * Bulk-set sales rep to Isaac Mandel 20% on Scent Theory loads in a date range.
 *
 * Usage:
 *   node scripts/bulk-update-scent-theory-rep.js
 *   node scripts/bulk-update-scent-theory-rep.js --apply
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

const bridge = require("../primus-ui-bridge");
bridge.init({
  db: {doc: () => ({get: async () => ({exists: false}), set: async () => {}})},
  writeLog: async (level, cat, msg, data) => {
    console.error(`[${level}] ${cat}: ${msg}`,
        data ? JSON.stringify(data).slice(0, 300) : "");
  },
});

const TARGET_REP_NAME = "Isaac Mandel 20%";
const TARGET_REP_ID = "2704";
const SCENT_THEORY_RE = /scent theory/i;
const APPLY = process.argv.includes("--apply");
const PAUSE_MS = 200;

/**
 * @param {Date|string} dateFrom
 * @param {Date|string} dateTo
 * @return {Promise<Array<object>>}
 */
function trackingCustomerName(row) {
  return String(
      row.thirdPartyName || row.customerName || row.shipperName || "",
  ).trim();
}

async function fetchScentTheoryRows(dateFrom, dateTo) {
  const rows = await bridge.fetchBookingsForTracking({dateFrom, dateTo});
  const seen = new Set();
  const matches = [];
  for (const row of rows) {
    const customerName = trackingCustomerName(row);
    if (!SCENT_THEORY_RE.test(customerName)) continue;
    const bookingId = String(row.id || row.bookingId || "").trim();
    if (!bookingId || seen.has(bookingId)) continue;
    seen.add(bookingId);
    matches.push({
      bookingId,
      loadNumber: String(row.BOL || row.bookingBOL || row.bolNumber || "").trim(),
      customerName,
      invoiced: String(row.Invoiced || "") === "1",
    });
  }
  return matches;
}

/**
 * @param {Array<object>} reps
 * @return {string}
 */
function formatReps(reps) {
  return (reps || []).map((r) =>
    r.display || `${r.firstName || ""} ${r.lastName || ""}`.trim() ||
    r.salesPersonId).join("; ") || "(none)";
}

/**
 * @param {Array<object>} reps
 * @param {string} targetId
 * @return {boolean}
 */
function isAlreadyTargetRep(reps, targetId) {
  return (reps || []).some((r) =>
    String(r.salesPersonId) === String(targetId));
}

/**
 * @param {object} catalogRow
 * @return {Promise<object>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} catalogRow
 * @return {object|null}
 */
function findTargetRep(catalog) {
  const byId = catalog.find((r) => String(r.id) === TARGET_REP_ID);
  if (byId) return byId;
  return catalog.find((r) =>
    String(r.display || "").trim().toLowerCase() ===
    TARGET_REP_NAME.toLowerCase()) || null;
}

function csvEscape(value) {
  const s = String(value == null ? "" : value);
  return s.includes(",") || s.includes('"') || s.includes("\n") ?
    `"${s.replace(/"/g, '""')}"` : s;
}

function logCsv(row) {
  console.log([
    csvEscape(row.loadNumber),
    csvEscape(row.bookingId),
    csvEscape(row.customerName),
    csvEscape(row.oldRep),
    csvEscape(row.newRep),
    csvEscape(row.status),
  ].join(","));
}

async function main() {
  console.log("=== Bulk Scent Theory sales rep update ===");
  console.log("mode:", APPLY ? "APPLY" : "DRY-RUN");
  console.log("target:", TARGET_REP_NAME, `(id ${TARGET_REP_ID})`);
  console.log("manage:", process.env.PRIMUS_UI_MANAGE_URL ||
    "https://shipprimus.com/PRIMUS/trunk/manage.php");

  if (!bridge.isManagePhpEnabled || !bridge.isManagePhpEnabled()) {
    console.error("FAIL: PRIMUS_USE_MANAGE_PHP is not enabled");
    process.exit(1);
  }

  const catalog = await bridge.fetchAllCorporateSalesPeople();
  const targetRow = findTargetRep(catalog);
  if (!targetRow) {
    console.error(`FAIL: "${TARGET_REP_NAME}" (id ${TARGET_REP_ID}) not in catalog`);
    process.exit(1);
  }
  console.log("catalog match:",
      `${targetRow.display} @ ${targetRow.percentage}% (id ${targetRow.id})`);
  if (String(targetRow.id) !== TARGET_REP_ID) {
    console.warn(`WARN: expected id ${TARGET_REP_ID}, live id is ${targetRow.id}`);
  }

  const dateRanges = [
    {label: "2026-07-01..2026-08-06", from: "2026-07-01", to: "2026-08-06"},
    {label: "2025-07-01..2026-08-06", from: "2025-07-01", to: "2026-08-06"},
  ];

  let loads = [];
  let usedRange = null;
  for (const range of dateRanges) {
    console.log(`\nFetching tracking rows ${range.label}...`);
    loads = await fetchScentTheoryRows(range.from, range.to);
    console.log(`Scent Theory matches: ${loads.length}`);
    if (loads.length) {
      usedRange = range.label;
      break;
    }
  }

  if (!loads.length) {
    console.log("\nNo Scent Theory loads found in either date range.");
    console.log("loadNumber,bookingId,customerName,oldRep,newRep,status");
    process.exit(0);
  }

  console.log("date range used:", usedRange);
  console.log("loadNumber,bookingId,customerName,oldRep,newRep,status");

  const stats = {
    found: loads.length,
    invoiced: loads.filter((l) => l.invoiced).length,
    updated: 0,
    skipped: 0,
    failed: 0,
    dryRunWouldUpdate: 0,
  };
  const failures = [];

  for (let i = 0; i < loads.length; i++) {
    const load = loads[i];
    let currentReps = [];
    try {
      currentReps = await bridge.getBookingSalesRep(load.bookingId);
    } catch (err) {
      stats.failed++;
      const row = {
        ...load,
        oldRep: "(lookup failed)",
        newRep: TARGET_REP_NAME,
        status: `failed:getBookingSalesRep:${err.message}`,
      };
      logCsv(row);
      failures.push(row);
      continue;
    }

    const oldRep = formatReps(currentReps);
    if (isAlreadyTargetRep(currentReps, targetRow.id)) {
      stats.skipped++;
      logCsv({
        ...load,
        oldRep,
        newRep: TARGET_REP_NAME,
        status: "skipped:already_correct",
      });
      continue;
    }

    if (!APPLY) {
      stats.dryRunWouldUpdate++;
      logCsv({
        ...load,
        oldRep,
        newRep: TARGET_REP_NAME,
        status: "dry-run:would_update",
      });
      continue;
    }

    const swap = await bridge.swapBookingSalesRep({
      bookingId: load.bookingId,
      tenPctRow: targetRow,
      removedReps: currentReps,
    });

    if (swap.ok) {
      stats.updated++;
      logCsv({
        ...load,
        oldRep,
        newRep: TARGET_REP_NAME,
        status: "updated",
      });
    } else {
      stats.failed++;
      const errMsg = swap.error ||
        (swap.response && swap.response.message) ||
        "swap failed";
      const invoicedNote = load.invoiced ? "invoiced" : "not_invoiced";
      const row = {
        ...load,
        oldRep,
        newRep: TARGET_REP_NAME,
        status: `failed:${errMsg} (${invoicedNote})`,
      };
      logCsv(row);
      failures.push({...row, response: swap.response || null});
    }

    if (i < loads.length - 1) await sleep(PAUSE_MS);
  }

  console.error("\n=== Summary ===");
  console.error("date range:", usedRange);
  console.error("mode:", APPLY ? "APPLY" : "DRY-RUN");
  console.error("found:", stats.found);
  console.error("invoiced:", stats.invoiced);
  console.error("updated:", stats.updated);
  console.error("skipped (already correct):", stats.skipped);
  console.error("failed:", stats.failed);
  if (!APPLY) {
    console.error("would update (dry-run):", stats.dryRunWouldUpdate);
  }
  if (failures.length) {
    console.error("\nFailures:");
    for (const f of failures.slice(0, 20)) {
      console.error(`  ${f.loadNumber || f.bookingId}: ${f.status}`);
    }
    if (failures.length > 20) {
      console.error(`  ... and ${failures.length - 20} more`);
    }
  }
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
