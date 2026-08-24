#!/usr/bin/env node
/**
 * Hold-out RFQs that are NOT copied from the extract prompt examples.
 * Usage: node scripts/bench-quote-extract-holdout.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const envFile = path.join(__dirname, "..", ".env.tai-invoice-automation");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

const intake = require("../quote-intake");

const CASES = [
  {
    id: "NEG_PARAPHRASE",
    note: "negation not copied from prompt",
    subject: "need rates 90723 / 11216",
    from: "warehouse@alrossa.com",
    body: [
      "EvoBox 5020 W 2700 N Lehi UT 84045 dock 4",
      "They do not require an appointment for delivery.",
      "Skid 1: 40 x 48 x 70 — 1822 pounds",
      "Skid 2: 40 x 48 x 66 — 1702 pounds",
      "Please price both zip codes.",
    ].join("\n"),
    expect: {noApd: true, twoSkids: true, zips: ["90723", "11216"]},
  },
  {
    id: "CARTON_PARAPHRASE",
    note: "cartons vs 1 pallet, not labeled like D8986",
    subject: "quote to Newport News",
    from: "ops@weida.com",
    body: [
      "Pickup: 9050 Hermosa Ave, Rancho Cucamonga, CA 91730",
      "Deliver: AAFES DDDC, Newport News, VA 23602",
      "35 cartons loaded on a single pallet, 137 lbs total.",
      "Pallet is 48 by 40 by 28 inches.",
    ].join("\n"),
    expect: {qty: 1, not35: true, plt: true},
  },
  {
    id: "MUST_CALL",
    note: "positive appointment, different wording",
    subject: "LTL quote Dallas to Houston",
    from: "ops@example.com",
    body: [
      "1 skid 40x48x48 500 lb class 70",
      "From 100 Main St Dallas TX 75201",
      "To 200 Oak Ave Houston TX 77001",
      "Consignee requires we call ahead to set a delivery window.",
    ].join("\n"),
    expect: {apd: true},
  },
];

const MODELS = [
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-sonnet-5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
];

/**
 * @param {object} parsed JSON.
 * @return {Array<string>}
 */
function codes(parsed) {
  const cr = parsed && parsed.customerRequest || {};
  return (cr.requestedAccessorials || []).map((c) =>
    String(c || "").toUpperCase());
}

/**
 * @param {object} parsed JSON.
 * @return {string}
 */
function zipOf(party) {
  return String((party && (party.zipCode || party.zip)) || "")
      .replace(/\D/g, "").slice(0, 5);
}

/**
 * @param {string} raw Text.
 * @return {object|null}
 */
function parse(raw) {
  const t = intake.extractJsonObject(raw);
  return t ? JSON.parse(t) : null;
}

/**
 * @param {string} id Case.
 * @param {object} parsed JSON.
 * @return {object}
 */
function grade(id, parsed) {
  const out = {ok: false, detail: {}};
  if (!parsed) return out;
  if (id === "NEG_PARAPHRASE") {
    const hasApd = codes(parsed).includes("APD");
    const dests = (parsed.lanes || []).map((l) => zipOf(l.consignee));
    const qty = (parsed.lanes || []).reduce((s, l) => s +
      (l.freightInfo || []).reduce((a, r) => a + Number(r.qty || 0), 0), 0);
    const lines = (parsed.lanes || []).reduce((s, l) => s +
      (l.freightInfo || []).length, 0);
    out.detail = {hasApd, dests, qty, lines, declined:
      parsed.customerDeclinedAccessorials};
    out.ok = !hasApd && dests.includes("90723") && dests.includes("11216") &&
      (qty >= 4 || lines >= 4);
    out.failApd = hasApd;
    out.partialPallets = !out.ok && !hasApd;
  } else if (id === "CARTON_PARAPHRASE") {
    const row = (((parsed.lanes || [])[0] || {}).freightInfo || [])[0] || {};
    out.detail = {qty: row.qty, dimType: row.dimType, l: row.length,
      w: row.width};
    out.ok = Number(row.qty) === 1 &&
      String(row.dimType || "").toUpperCase() === "PLT";
  } else if (id === "MUST_CALL") {
    out.detail = {codes: codes(parsed)};
    out.ok = codes(parsed).includes("APD");
  }
  return out;
}

/**
 * @return {Promise<void>}
 */
async function main() {
  const summary = [];
  for (const model of MODELS) {
    const row = {model, failNoAppt: false, pass: 0, cases: {}};
    console.log("\n====", model, "====");
    for (const rfq of CASES) {
      let parsed = null;
      let err = null;
      try {
        const raw = await intake.callQuoteExtractionModel({
          subject: rfq.subject, from: rfq.from, body: rfq.body,
        }, model);
        parsed = parse(raw);
      } catch (e) {
        err = e.message;
      }
      const g = grade(rfq.id, parsed);
      if (g.failApd) row.failNoAppt = true;
      if (g.ok) row.pass += 1;
      row.cases[rfq.id] = {ok: g.ok, failApd: !!g.failApd, detail: g.detail,
        err};
      console.log(g.ok ? "PASS" : "FAIL", rfq.id,
          JSON.stringify(g.detail), err || "");
    }
    summary.push(row);
  }
  console.log("\n======== HOLDOUT ========");
  for (const r of summary) {
    console.log(r.model.padEnd(22), r.pass + "/3",
        r.failNoAppt ? "FAILED no-appt paraphrase" : "negation ok");
  }
  fs.writeFileSync(path.join(__dirname, "_bench-quote-extract-holdout.json"),
      JSON.stringify({at: new Date().toISOString(), summary}, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
