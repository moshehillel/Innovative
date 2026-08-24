#!/usr/bin/env node
/**
 * Live bake-off: same RFQ extract prompt vs Claude + OpenAI models.
 * Scores RAW model JSON (no post-processors) so leftover keyword bugs show.
 * Usage: node scripts/bench-quote-extract-models.js
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

const intake = require("../quote-intake");

const CASES = [
  {
    id: "D9338",
    subject: "pls qout to 90723 and 11216",
    from: "Alrossa Warehouse <warehouse@alrossa.com>",
    body: [
      "EvoBox",
      "5020 W 2700 N",
      "Lehi, UT 84045",
      "Dock 4",
      "Mon-Fri 8:30am - 4:30pm",
      "No Appointment necessary",
      "",
      "Pallet 1",
      "40x48x70",
      "1822 lbs",
      "",
      "Pallet 2",
      "40x48x66",
      "1702 lbs",
    ].join("\n"),
  },
  {
    id: "D8986",
    subject: "RFQ SO-1 AAFES Newport News",
    from: "quotes@customer.com",
    body: [
      "Pickup Location:",
      "Weida Freight System",
      "9050 Hermosa Ave",
      "Rancho Cucamonga, CA 91730",
      "Shipping To:",
      "AAFES DDDC Newport News",
      "123 Warehouse Rd",
      "Newport News, VA 23602",
      "Special Instructions: none",
      "Sales Order #: SO-1",
      "Total Cartons – 35",
      "Total weight – 137",
      "Number of Pallet -1",
      "Pallet dimensions – 48*40*28",
    ].join("\n"),
  },
  {
    id: "D5678",
    subject: "Quote 19 pallets",
    from: "shipper@example.com",
    body: [
      "Please quote 19 pallets",
      "Ship from Dallas, TX 75201",
      "Ship to Houston, TX 77001",
      "Total weight – 8146.05",
      "Class 70",
    ].join("\n"),
  },
  {
    id: "D4239",
    subject: "Kadra Warehouse quote",
    from: "quotes@innovativecarriers.com",
    body: [
      "Kadra Warehouse",
      "Please quote from 08701 to 22911",
      "1 pallet 800 lbs class 70",
    ].join("\n"),
  },
  {
    id: "APD_POS",
    subject: "RFQ appointment required",
    from: "ops@example.com",
    body: [
      "Please quote 1 pallet 40x48x48 500 lbs class 70",
      "Pickup: 100 Main St, Dallas, TX 75201",
      "Deliver: 200 Oak Ave, Houston, TX 77001",
      "Delivery appointment required. Must call to schedule.",
    ].join("\n"),
  },
];

const MODELS = [
  {provider: "claude", id: "claude-haiku-4-5"},
  {provider: "claude", id: "claude-sonnet-4-5"},
  {provider: "claude", id: "claude-sonnet-5"},
  {provider: "claude", id: "claude-sonnet-4"},
  {provider: "openai", id: "gpt-5.6-luna"},
  {provider: "openai", id: "gpt-5.6-sol"},
  {provider: "openai", id: "gpt-4o"},
];

/**
 * @param {object} parsed Extract JSON.
 * @return {Array<string>}
 */
function requestedCodes(parsed) {
  const cr = parsed && parsed.customerRequest || {};
  return (cr.requestedAccessorials || []).map((c) =>
    String(c || "").toUpperCase());
}

/**
 * @param {object} parsed Extract JSON.
 * @return {Array<string>}
 */
function declinedCodes(parsed) {
  return (parsed && parsed.customerDeclinedAccessorials || []).map((c) =>
    String(c || "").toUpperCase());
}

/**
 * @param {object} row Freight row.
 * @return {boolean}
 */
function isPlt(row) {
  const dim = String((row && row.dimType) || "").toUpperCase();
  return !dim || dim === "PLT" || dim === "PALLET" || dim === "SKID";
}

/**
 * @param {object} lane Lane.
 * @return {number}
 */
function palletQty(lane) {
  return (lane && lane.freightInfo || []).reduce((sum, row) => {
    if (!isPlt(row)) return sum;
    const n = Number(row.qty);
    return sum + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
}

/**
 * @param {object} lane Lane.
 * @return {number}
 */
function palletLines(lane) {
  return (lane && lane.freightInfo || []).filter(isPlt).length;
}

/**
 * @param {object} party Address.
 * @return {string}
 */
function zip5(party) {
  return String((party && (party.zipCode || party.zipcode || party.zip)) || "")
      .replace(/\D/g, "").slice(0, 5);
}

/**
 * @param {object} parsed Extract JSON.
 * @param {string} zip Dest zip.
 * @return {object|null}
 */
function laneByZip(parsed, zip) {
  const lanes = parsed && parsed.lanes || [];
  return lanes.find((lane) => zip5(lane && lane.consignee) === zip) || null;
}

/**
 * Score raw extract. Returns checks + integer points.
 * @param {string} caseId Case.
 * @param {object|null} parsed JSON.
 * @param {string|null} err Error.
 * @return {object}
 */
function scoreCase(caseId, parsed, err) {
  const checks = {};
  if (err || !parsed) {
    return {points: 0, max: 0, checks: {error: err || "no json"}, failApd: false};
  }
  let points = 0;
  let max = 0;
  let failApd = false;

  if (caseId === "D9338") {
    max = 6;
    const a = laneByZip(parsed, "90723");
    const b = laneByZip(parsed, "11216");
    checks.destZips = Boolean(a && b);
    if (checks.destZips) points += 1;
    const twoLines = a && b && palletLines(a) >= 2 && palletLines(b) >= 2;
    const qtyTwo = a && b && palletQty(a) >= 2 && palletQty(b) >= 2;
    checks.twoPltLinesEach = Boolean(twoLines);
    checks.qtyTwoEach = Boolean(qtyTwo);
    if (twoLines) points += 2;
    else if (qtyTwo) points += 1;
    const hasApd = requestedCodes(parsed).includes("APD") ||
      requestedCodes(parsed).includes("APO");
    checks.noApd = !hasApd;
    if (!hasApd) points += 2;
    else {
      failApd = true;
    }
    checks.declinedApd = declinedCodes(parsed).includes("APD");
    if (checks.declinedApd) points += 1;
  } else if (caseId === "D8986") {
    max = 4;
    const lane = (parsed.lanes || [])[0] || {};
    const row = (lane.freightInfo || [])[0] || {};
    const qty = Number(row.qty);
    checks.qty1Not35 = qty === 1;
    if (checks.qty1Not35) points += 2;
    checks.dimTypePlt = String(row.dimType || "").toUpperCase() === "PLT";
    if (checks.dimTypePlt) points += 1;
    const wt = String(row.weightType || "").toLowerCase();
    checks.weightTypeTotal = wt === "total" || wt === "";
    if (checks.weightTypeTotal) points += 1;
    checks.dims40x48 = Number(row.length) === 40 && Number(row.width) === 48;
  } else if (caseId === "D5678") {
    max = 3;
    const lane = (parsed.lanes || [])[0] || {};
    const row = (lane.freightInfo || [])[0] || {};
    const wt = String(row.weightType || "").toLowerCase();
    checks.weightTypeTotal = wt === "total" || wt === "";
    if (checks.weightTypeTotal) points += 2;
    const w = Number(row.weight);
    checks.weightAbout8146 = w >= 8000 && w <= 8300;
    if (checks.weightAbout8146) points += 1;
    checks.notEach = wt !== "each";
  } else if (caseId === "D4239") {
    max = 2;
    const origin = zip5(parsed.shipper);
    const dests = (parsed.lanes || []).map((l) => zip5(l && l.consignee));
    checks.origin08701 = origin === "08701" || dests.includes("08701");
    checks.dest22911 = dests.includes("22911") || origin === "22911";
    const ship = origin === "08701";
    const cons = dests.includes("22911");
    if (ship) points += 1;
    if (cons) points += 1;
    checks.odCorrect = ship && cons;
    if (!checks.odCorrect && checks.origin08701 && checks.dest22911) {
      points = 1;
    }
  } else if (caseId === "APD_POS") {
    max = 2;
    const hasApd = requestedCodes(parsed).includes("APD");
    checks.requestsApd = hasApd;
    if (hasApd) points += 2;
  }

  return {points, max, checks, failApd};
}

/**
 * @param {string} raw Model text.
 * @return {object|null}
 */
function parseExtract(raw) {
  const jsonText = intake.extractJsonObject(raw);
  if (!jsonText) return null;
  return JSON.parse(jsonText);
}

/**
 * @return {Promise<void>}
 */
async function main() {
  const rows = [];
  for (const model of MODELS) {
    const row = {
      model: model.id,
      provider: model.provider,
      skipped: null,
      total: 0,
      max: 0,
      failNoAppt: false,
      cases: {},
    };
    console.log("\n====", model.id, "====");
    for (const rfq of CASES) {
      const started = Date.now();
      let parsed = null;
      let err = null;
      let raw = "";
      try {
        raw = await intake.callQuoteExtractionModel({
          subject: rfq.subject,
          from: rfq.from,
          body: rfq.body,
        }, model.id);
        parsed = parseExtract(raw);
      } catch (e) {
        err = e.message || String(e);
        const lower = String(err).toLowerCase();
        if (lower.includes("not_found") ||
            lower.includes("invalid_request") ||
            lower.includes("does not exist") ||
            lower.includes("model") && lower.includes("not found") ||
            /404/.test(err)) {
          row.skipped = err.slice(0, 180);
          console.log("SKIP", model.id, err.slice(0, 180));
          break;
        }
      }
      const scored = scoreCase(rfq.id, parsed, err);
      row.total += scored.points;
      row.max += scored.max;
      if (scored.failApd) row.failNoAppt = true;
      row.cases[rfq.id] = {
        ms: Date.now() - started,
        points: scored.points,
        max: scored.max,
        checks: scored.checks,
        err: err ? err.slice(0, 180) : null,
        snapshot: parsed ? {
          codes: requestedCodes(parsed),
          declined: declinedCodes(parsed),
          lanes: (parsed.lanes || []).map((l) => ({
            zip: zip5(l && l.consignee),
            pltLines: palletLines(l),
            pltQty: palletQty(l),
            freight: (l.freightInfo || []).map((r) => ({
              qty: r.qty,
              weight: r.weight,
              weightType: r.weightType,
              dimType: r.dimType,
              l: r.length,
              w: r.width,
              h: r.height,
            })),
          })),
          shipZip: zip5(parsed.shipper),
        } : null,
      };
      const mark = scored.points === scored.max ? "PASS" : "PART";
      console.log(mark, rfq.id, scored.points + "/" + scored.max,
          JSON.stringify(scored.checks), err ? err.slice(0, 80) : "");
    }
    rows.push(row);
  }

  const usable = rows.filter((r) => !r.skipped);
  usable.sort((a, b) => b.total - a.total ||
    Number(a.failNoAppt) - Number(b.failNoAppt));
  const winner = usable[0] || null;

  console.log("\n======== COMPARISON (raw model, no post-processors) ========");
  console.log([
    "model".padEnd(22),
    "D9338 pal/APD",
    "D8986 qty",
    "D5678 wt",
    "D4239 zip",
    "APD+",
    "score",
    "failed no-appt?",
  ].join(" | "));
  for (const r of rows) {
    if (r.skipped) {
      console.log(r.model.padEnd(22), "| SKIPPED:", r.skipped);
      continue;
    }
    const d9338 = r.cases.D9338;
    const pal = d9338.checks.twoPltLinesEach ? "2lines" :
      (d9338.checks.qtyTwoEach ? "qty2" : "FAIL");
    const apd = d9338.checks.noApd ? "noAPD" : "HAS APD";
    const d8986 = r.cases.D8986.checks.qty1Not35 ? "qty1" : "FAIL";
    const d5678 = r.cases.D5678.checks.weightTypeTotal &&
      r.cases.D5678.checks.weightAbout8146 ? "total+wt" :
      (r.cases.D5678.checks.weightTypeTotal ? "total" : "FAIL");
    const d4239 = r.cases.D4239.checks.odCorrect ? "OD ok" :
      ((r.cases.D4239.checks.origin08701 || r.cases.D4239.checks.dest22911) ?
        "partial" : "FAIL");
    const apdPos = r.cases.APD_POS.checks.requestsApd ? "APD" : "MISS";
    console.log([
      r.model.padEnd(22),
      (pal + "/" + apd).padEnd(13),
      d8986.padEnd(9),
      d5678.padEnd(8),
      d4239.padEnd(9),
      apdPos.padEnd(4),
      String(r.total + "/" + r.max).padEnd(5),
      r.failNoAppt ? "YES — failed negation" : "ok",
    ].join(" | "));
  }

  const outPath = path.join(__dirname, "_bench-quote-extract-models.json");
  fs.writeFileSync(outPath, JSON.stringify({
    at: new Date().toISOString(),
    winner: winner && winner.model,
    rows,
  }, null, 2));
  console.log("\nWinner:", winner ? winner.model + " (" + winner.total + "/" +
    winner.max + ")" : "(none)");
  console.log("Wrote", outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
