#!/usr/bin/env node
/**
 * Bake-off: payment-notification vs invoice/remittance classifier models.
 *
 * Usage (from functions/):
 *   node scripts/_bench-payment-notification-temp.js
 *   node scripts/_bench-payment-notification-temp.js --models=gpt-5.6-luna,gpt-5.6-sol,gpt-4.1,gpt-4o
 *
 * Writes:
 *   scripts/_bench-payment-notification-out.json
 *   scripts/_bench-payment-notification-report.md
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

const {
  classifyPaymentNotificationIntent,
  DEFAULT_PAYMENT_NOTIFICATION_MODEL,
  getPaymentClassifyOpenAiKey,
} = require("../payment-notification-classify");

const CORPUS = path.join(__dirname, "_bench-payment-notification-corpus.json");
const OUT = path.join(__dirname, "_bench-payment-notification-out.json");
const REPORT = path.join(__dirname, "_bench-payment-notification-report.md");

const DEFAULT_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-4.1",
  "gpt-4o",
];

/**
 * @param {string[]} argv
 * @return {string[]}
 */
function parseModels(argv) {
  const arg = argv.find((a) => a.startsWith("--models="));
  if (!arg) return DEFAULT_MODELS.slice();
  return arg.slice("--models=".length).split(",")
      .map((s) => s.trim()).filter(Boolean);
}

/**
 * @param {object} c
 * @param {string} model
 * @return {Promise<object>}
 */
async function runCase(c, model) {
  const t0 = Date.now();
  try {
    const result = await classifyPaymentNotificationIntent({
      subject: c.subject,
      from: c.from,
      body: c.body,
      attachments: c.attachments || [],
      model,
    });
    const ms = Date.now() - t0;
    const pass = result.intent === c.expect;
    return {
      id: c.id,
      expect: c.expect,
      got: result.intent,
      confidence: result.confidence,
      reasoning: result.reasoning,
      source: result.source,
      ms,
      pass,
      err: result.source === "error" ? result.reasoning : null,
    };
  } catch (err) {
    return {
      id: c.id,
      expect: c.expect,
      got: null,
      confidence: null,
      reasoning: null,
      source: "throw",
      ms: Date.now() - t0,
      pass: false,
      err: String(err && err.message || err).slice(0, 300),
    };
  }
}

/**
 * @return {Promise<void>}
 */
async function main() {
  const models = parseModels(process.argv.slice(2));
  const corpus = JSON.parse(fs.readFileSync(CORPUS, "utf8"));
  const cases = corpus.cases || [];
  const apiKey = getPaymentClassifyOpenAiKey();
  if (!apiKey) {
    console.error("No OpenAI API key (SUPPORT_CHAT_OPENAI_API_KEY).");
    process.exit(2);
  }

  console.log("Cases:", cases.length);
  console.log("Models:", models.join(", "));
  console.log("Default wired model:", DEFAULT_PAYMENT_NOTIFICATION_MODEL);

  const byModel = {};
  for (const model of models) {
    process.stderr.write(`\n=== ${model} ===\n`);
    const rows = [];
    for (const c of cases) {
      process.stderr.write(`  ${c.id}... `);
      const row = await runCase(c, model);
      rows.push(row);
      process.stderr.write(
          `${row.pass ? "PASS" : "FAIL"} got=${row.got}` +
          (row.err ? ` ERR=${row.err.slice(0, 80)}` : "") +
          ` (${row.ms}ms)\n`);
    }
    const pass = rows.filter((r) => r.pass).length;
    const fails = rows.filter((r) => !r.pass).map((r) => ({
      id: r.id,
      expect: r.expect,
      got: r.got,
      reasoning: r.reasoning,
      err: r.err,
    }));
    byModel[model] = {
      pass,
      total: rows.length,
      avgMs: Math.round(
          rows.reduce((s, r) => s + r.ms, 0) / Math.max(rows.length, 1)),
      fails,
      rows,
    };
  }

  const ranked = Object.entries(byModel)
      .map(([model, s]) => ({
        model,
        pass: s.pass,
        total: s.total,
        avgMs: s.avgMs,
        failCount: s.fails.length,
      }))
      .sort((a, b) =>
        (b.pass - a.pass) || (a.avgMs - b.avgMs) || a.model.localeCompare(b.model));
  const winner = ranked[0] && ranked[0].pass > 0 ? ranked[0].model : null;

  const out = {
    at: new Date().toISOString(),
    defaultWiredModel: DEFAULT_PAYMENT_NOTIFICATION_MODEL,
    winner,
    ranked,
    byModel,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  const lines = [];
  lines.push("# Payment-notification classifier bake-off");
  lines.push("");
  lines.push(`At: ${out.at}`);
  lines.push(`Winner: **${winner || "(none)"}**`);
  lines.push(`Default wired: \`${DEFAULT_PAYMENT_NOTIFICATION_MODEL}\``);
  lines.push("");
  lines.push("| Model | Score | Avg ms | Misses |");
  lines.push("| --- | --- | --- | --- |");
  for (const r of ranked) {
    const misses = (byModel[r.model].fails || [])
        .map((f) => `${f.id}(exp=${f.expect},got=${f.got})`)
        .join("; ") || "—";
    lines.push(
        `| \`${r.model}\` | ${r.pass}/${r.total} | ${r.avgMs} | ${misses} |`);
  }
  lines.push("");
  lines.push("## Per-case detail");
  for (const model of models) {
    lines.push("");
    lines.push(`### ${model}`);
    for (const row of byModel[model].rows) {
      lines.push(
          `- ${row.pass ? "✓" : "✗"} **${row.id}**: expect \`${row.expect}\` ` +
          `got \`${row.got}\` (${row.ms}ms) — ${row.reasoning || row.err || ""}`);
    }
  }
  fs.writeFileSync(REPORT, lines.join("\n") + "\n");

  console.log("\n=== RANKING ===");
  for (const r of ranked) {
    console.log(
        `${r.model}: ${r.pass}/${r.total} avg=${r.avgMs}ms ` +
        `fails=${r.failCount}`);
  }
  console.log("Winner:", winner || "(none)");
  console.log("Wrote", OUT);
  console.log("Wrote", REPORT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
