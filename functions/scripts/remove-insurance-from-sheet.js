#!/usr/bin/env node
/**
 * One-time: remove Redkik insurance actual-cost lines from every load in an
 * insurance premium Excel workbook (same layout as Redkik billing sheets).
 *
 * Usage:
 *   node scripts/remove-insurance-from-sheet.js <excel.xlsx> [--dry-run]
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

const insurance = require("../innovative-insurance");
const bridge = require("../primus-ui-bridge");

let sessionCache = null;
const mockDb = {
  doc: () => ({
    get: async () => ({
      exists: !!sessionCache,
      data: () => sessionCache,
    }),
    set: async (data, opts) => {
      sessionCache = Object.assign({}, sessionCache || {}, data);
      if (opts && opts.merge && sessionCache) {
        sessionCache = Object.assign({}, sessionCache, data);
      } else {
        sessionCache = data;
      }
    },
  }),
};

bridge.init({
  db: mockDb,
  writeLog: async (level, cat, msg, data) => {
    if (level === "error") {
      console.error(`[${cat}] ${msg}`, data || "");
    }
  },
});

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

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
  const dryRun = process.argv.includes("--dry-run");
  const excelPath = args[0];
  if (!excelPath) {
    console.error("Usage: node scripts/remove-insurance-from-sheet.js " +
      "<excel.xlsx> [--dry-run]");
    process.exit(1);
  }

  const {rows} = insurance.parseInsuranceExcel(excelPath);
  const {addable} = insurance.classifyRows(rows);
  const loads = [...new Set(addable.map((r) => String(r.bol).trim()))]
      .filter(Boolean);

  console.log(`Workbook: ${path.basename(excelPath)}`);
  console.log(`Loads to process: ${loads.length}${dryRun ? " (dry-run)" : ""}`);

  const insuranceVendor = await bridge.resolveInsuranceVendor("Redkik");
  console.log(`Insurance vendor: ${insuranceVendor.name} (${insuranceVendor.id})`);

  const summary = {
    removed: 0,
    skippedNoInsurance: 0,
    notFound: 0,
    failed: 0,
    totalRemovedAmount: 0,
    errors: [],
  };

  for (let i = 0; i < loads.length; i++) {
    const loadNumber = loads[i];
    process.stdout.write(`[${i + 1}/${loads.length}] Load ${loadNumber} … `);

    if (dryRun) {
      console.log("skipped (dry-run)");
      continue;
    }

    let booking;
    try {
      booking = await fetchBooking(loadNumber);
    } catch (err) {
      summary.failed++;
      summary.errors.push({loadNumber, error: err.message});
      console.log("FAIL fetch", err.message);
      continue;
    }
    if (!booking) {
      summary.notFound++;
      console.log("NOT FOUND");
      continue;
    }

    let result;
    try {
      result = await bridge.removeInsurancePremiumFromLoad({
        booking,
        loadNumber,
        insuranceVendor,
      });
    } catch (err) {
      summary.failed++;
      summary.errors.push({loadNumber, error: err.message});
      console.log("FAIL", err.message);
      continue;
    }

    if (result.skipped) {
      summary.skippedNoInsurance++;
      console.log("no insurance");
    } else if (!result.ok) {
      summary.failed++;
      summary.errors.push({
        loadNumber,
        error: result.error || result.step || "unknown",
      });
      console.log("FAIL", result.error || result.step);
    } else {
      summary.removed++;
      summary.totalRemovedAmount += Number(result.removedTotal || 0);
      console.log(
          `removed $${Number(result.removedTotal || 0).toFixed(2)} ` +
          `(${result.removedLineCount} line(s)` +
          `${result.removedBills && result.removedBills.length ?
            ", bills " + result.removedBills.join(", ") : ""})`,
      );
    }

    await new Promise((r) => setTimeout(r, 250));
  }

  console.log("\n=== Done ===");
  console.log(JSON.stringify(summary, null, 2));
  if (summary.errors.length) {
    console.log("\nFirst errors:");
    summary.errors.slice(0, 10).forEach((e) => {
      console.log(`  ${e.loadNumber}: ${e.error}`);
    });
  }
  process.exit(summary.failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
