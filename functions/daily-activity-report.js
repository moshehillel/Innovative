"use strict";

/**
 * End-of-day Jerry activity digest — replaces per-flow dashboard log summaries.
 */

const OpenAI = require("openai");
const {DEFAULT_OPENAI_MODEL} = require("./openai-models");
const mailIntakeQueue = require("./mail-intake-queue");

let deps = {};

/** @param {object} bundle Dependencies from index.js */
function init(bundle) {
  deps = bundle || {};
}
exports.init = init;

/**
 * @param {*} raw BigQuery details column.
 * @return {object}
 */
function parseDetails(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch (_) {
    return {};
  }
}

/**
 * @param {object} details Parsed details.
 * @param {string} key Field name.
 * @return {*}
 */
function detail(details, key) {
  if (!details || typeof details !== "object") return null;
  if (details[key] != null && details[key] !== "") return details[key];
  const nested = details.details;
  if (nested && nested[key] != null && nested[key] !== "") return nested[key];
  return null;
}

/**
 * @param {string|null|undefined} load Load number.
 * @return {string}
 */
function fmtLoad(load) {
  return load ? `load ${load}` : "load (unknown)";
}

/**
 * @param {*} amount Dollar amount.
 * @return {string}
 */
function fmtMoney(amount) {
  if (amount == null || amount === "") return "";
  const n = Number(amount);
  return Number.isFinite(n) ? ` — $${n.toFixed(2)}` : "";
}

/**
 * @param {string|null|undefined} carrier Carrier name.
 * @return {string}
 */
function fmtCarrier(carrier) {
  return carrier ? ` (${carrier})` : "";
}

/**
 * @param {string|null|undefined} inv Primus invoice number.
 * @return {string}
 */
function fmtInv(inv) {
  return inv ? `, Primus #${inv}` : "";
}

/**
 * @param {Array<object>} logs BigQuery log rows (ascending time).
 * @return {object} Structured activity buckets for the report.
 */
function aggregateDailyActivity(logs) {
  const agg = {
    periodHours: 24,
    inboxChecks: 0,
    emailsProcessed: 0,
    billed: [],
    awaitingEmailApproval: [],
    insuranceInvoices: [],
    forwardedForReview: [],
    pastDueIgnored: [],
    alreadyBilledSkipped: [],
    additionalChargeApprovals: [],
    rateAlerts: [],
    billingFailures: [],
    podEmails: [],
    customerEmailsSent: [],
    apexDownloadFailures: [],
    noInvoiceEmails: [],
    stuckFlows: 0,
    brokerCommissionSwaps: [],
    workflowFailures: [],
  };

  const billedKeys = new Set();

  for (const log of logs) {
    const msg = String(log.message || "");
    const d = parseDetails(log.details);
    const load = detail(d, "loadNumber");
    const carrier = detail(d, "carrierName");
    const amount = detail(d, "invoiceAmount") ??
      detail(d, "submittedAmount");
    const invNum = detail(d, "invoiceNumber") ||
      detail(d, "issuedInvoiceNumber");
    const reason = detail(d, "reason");

    if (msg === "Broker commission swapped to 10%") {
      agg.brokerCommissionSwaps.push({
        load: load || detail(d, "loadNumber"),
        profit: detail(d, "profit"),
        marginPct: detail(d, "margin"),
        fromRepId: detail(d, "fromRepId"),
        fromRepName: detail(d, "fromRepName"),
        toRepId: detail(d, "toRepId"),
        toRepName: detail(d, "toRepName"),
        trigger: detail(d, "trigger"),
        customerRate: detail(d, "customerRate"),
        carrierCost: detail(d, "carrierCost") ?? detail(d, "vendorCost"),
        vendorCost: detail(d, "vendorCost"),
        invoiceAmount: detail(d, "invoiceAmount"),
        carrierName: carrier || detail(d, "carrierName"),
        timestamp: log.timestamp || null,
      });
    }
    if (msg === "Inbox check completed" ||
        msg === "Gmail inbox check completed" ||
        msg === "Outlook inbox check completed") {
      agg.inboxChecks += 1;
    }
    if (msg === "Email processing completed") {
      agg.emailsProcessed += 1;
    }
    if (/Carrier bill entered and invoice issued via manage\.php/i.test(msg)) {
      const key = `${load || ""}|${invNum || ""}|${agg.billed.length}`;
      if (!billedKeys.has(key)) {
        billedKeys.add(key);
        agg.billed.push({load, carrier, amount, invoiceNum: invNum});
      }
    }
    // Customer-email reviewer gate is gone; do not list old hold logs
    // as "waiting on customer email approval". Extra-charge A/B/C/D
    // approvals are counted separately.
    if (msg === "Customer email held for reviewer approval") {
      continue;
    }
    if (/Workflow skipped — carrier bill and invoice already in Primus/i
        .test(msg)) {
      agg.alreadyBilledSkipped.push({
        load: load || detail(d, "loadNumber"),
        invoiceId: detail(d, "invoiceId"),
        customerInvoiceId: detail(d, "customerInvoiceId"),
      });
    }
    if (msg === "Past-due carrier invoice filter") {
      const dropped = Array.isArray(d.dropped) ? d.dropped : [];
      for (const item of dropped) {
        agg.pastDueIgnored.push({
          load: item.loadNumber || null,
          invoiceNumber: item.invoiceNumber || null,
          dueDate: item.dueDate || null,
        });
      }
    }
    if (msg === "Forwarded to human review") {
      agg.forwardedForReview.push({
        load,
        reason: reason || detail(d, "department") || null,
        subject: detail(d, "subject") || null,
        messageId: detail(d, "messageId") || null,
      });
    }
    if (msg === "Apex email had no downloadable invoice PDFs") {
      agg.apexDownloadFailures.push({
        subject: detail(d, "subject") || null,
        messageId: detail(d, "messageId") || null,
      });
    }
    if (msg === "UI billing flow failed") {
      agg.billingFailures.push({
        load,
        carrier,
        error: (d.result && d.result.error) || detail(d, "error"),
        step: (d.result && d.result.step) || detail(d, "step"),
      });
    }
    if (msg === "Primus workflow failed after retries" ||
        msg === "Primus workflow failed") {
      agg.workflowFailures.push({
        load: load || detail(d, "loadNumber"),
        invoiceId: detail(d, "invoiceId") || log.invoiceId || null,
        carrier,
        error: detail(d, "error") || null,
      });
    }
    if (msg === "Customer/rate alert sent to dispatcher") {
      agg.rateAlerts.push({
        load: load || detail(d, "loadNumber"),
        code: detail(d, "code") || null,
      });
    }
    if (msg === "Additional charge needs approval (4-option email)") {
      agg.additionalChargeApprovals.push({
        load: load || detail(d, "loadNumber"),
        carrier: carrier || detail(d, "carrierName"),
        category: detail(d, "category") || null,
        amount: amount || detail(d, "invoiceAmount"),
      });
    }
    if (msg === "Outbound email sent") {
      const type = detail(d, "type");
      const row = {
        type,
        load,
        invoiceId: detail(d, "invoiceId") || null,
      };
      if (type === "generated_bill") {
        agg.customerEmailsSent.push(row);
      }
      if (type === "pod_followup" || type === "pod_request") {
        agg.podEmails.push(row);
      }
    }
    if (msg === "No processable PDF invoices found" ||
        /Email contained .* but no invoice/i.test(msg)) {
      agg.noInvoiceEmails.push({
        subject: detail(d, "subject") || null,
        messageId: detail(d, "messageId") || null,
        reason: msg === "No processable PDF invoices found" ?
          "No processable PDF" : msg,
      });
    }
    if (/stuck/i.test(msg) && log.level === "warn") {
      agg.stuckFlows += 1;
    }
  }

  for (const log of logs) {
    const d = parseDetails(log.details);
    if (d.finalStatus === "insurance_processed" ||
        detail(d, "insuranceVendorInvoiceNumber")) {
      agg.insuranceInvoices.push({
        invoiceNumber: detail(d, "insuranceVendorInvoiceNumber") ||
          detail(d, "invoiceNumber"),
        load: detail(d, "loadNumber") || null,
      });
    }
  }

  const recoveredLoads = new Set(
      agg.billed.map((b) => b.load != null ? String(b.load) : "")
          .filter(Boolean),
  );
  const seenFail = new Set();
  agg.workflowFailures = agg.workflowFailures.filter((f) => {
    const loadKey = f.load != null ? String(f.load) : "";
    if (loadKey && recoveredLoads.has(loadKey)) return false;
    const id = f.invoiceId || loadKey || String(f.error || "");
    if (!id || seenFail.has(id)) return false;
    seenFail.add(id);
    return true;
  });

  return agg;
}

/**
 * Deterministic bullet lines — one line per real event (no grouping).
 * @param {object} agg aggregateDailyActivity output.
 * @return {string[]}
 */
function buildDeterministicBullets(agg) {
  const lines = [];
  if (agg.inboxChecks) {
    lines.push(`Checked inbox ${agg.inboxChecks} time(s).`);
  }
  if (agg.emailsProcessed) {
    lines.push(`Processed ${agg.emailsProcessed} carrier email(s).`);
  }

  for (const b of agg.billed) {
    lines.push(
        `Invoiced ${fmtLoad(b.load)}${fmtCarrier(b.carrier)}` +
        `${fmtMoney(b.amount)}${fmtInv(b.invoiceNum)}.`,
    );
  }

  for (const w of agg.awaitingEmailApproval) {
    lines.push(
        `Waiting on customer email approval — ${fmtLoad(w.load)}` +
        `${fmtCarrier(w.carrier)}${fmtMoney(w.amount)}.`,
    );
  }

  for (const ins of agg.insuranceInvoices) {
    const loadPart = ins.load ? ` for ${fmtLoad(ins.load)}` : "";
    lines.push(
        `Processed insurance invoice${ins.invoiceNumber ?
          ` #${ins.invoiceNumber}` : ""}${loadPart}.`,
    );
  }

  for (const p of agg.pastDueIgnored) {
    const inv = p.invoiceNumber ? ` invoice #${p.invoiceNumber}` : "";
    const due = p.dueDate ? ` (due ${p.dueDate})` : "";
    lines.push(
        `Ignored past-due re-send — ${fmtLoad(p.load)}${inv}${due}.`,
    );
  }

  for (const s of agg.alreadyBilledSkipped) {
    const primus = s.customerInvoiceId ?
      `, Primus #${s.customerInvoiceId}` : "";
    lines.push(
        `Skipped already billed — ${fmtLoad(s.load)}${primus}.`,
    );
  }

  for (const f of agg.forwardedForReview) {
    const why = f.reason ? `: ${f.reason}` : "";
    const sub = f.subject ? ` — "${f.subject}"` : "";
    lines.push(
        `Forwarded for human review — ${fmtLoad(f.load)}${why}${sub}.`,
    );
  }

  for (const a of agg.additionalChargeApprovals) {
    const cat = a.category ? ` (${a.category})` : "";
    lines.push(
        `Sent additional-charge approval — ${fmtLoad(a.load)}` +
        `${fmtCarrier(a.carrier)}${cat}${fmtMoney(a.amount)}.`,
    );
  }

  for (const r of agg.rateAlerts) {
    const code = r.code ? ` (${r.code})` : "";
    lines.push(`Sent missing-rate alert — ${fmtLoad(r.load)}${code}.`);
  }

  for (const c of agg.customerEmailsSent) {
    const type = c.type ? String(c.type).replace(/_/g, " ") : "customer email";
    const id = c.invoiceId && !c.load ? ` invoice ${c.invoiceId}` : "";
    lines.push(
        `Sent ${type} — ${fmtLoad(c.load)}${id}.`,
    );
  }

  for (const p of agg.podEmails) {
    const type = p.type ? String(p.type).replace(/_/g, " ") : "POD email";
    lines.push(`Sent ${type} — ${fmtLoad(p.load)}.`);
  }

  for (const fail of agg.billingFailures) {
    const err = fail.error ? `: ${fail.error}` : "";
    const step = fail.step ? ` [${fail.step}]` : "";
    lines.push(
        `Billing failed — ${fmtLoad(fail.load)}` +
        `${fmtCarrier(fail.carrier)}${step}${err}.`,
    );
  }

  for (const fail of agg.workflowFailures || []) {
    const err = fail.error ? `: ${fail.error}` : "";
    lines.push(
        `Workflow failed — ${fmtLoad(fail.load)}` +
        `${fmtCarrier(fail.carrier)}${err}.`,
    );
  }

  for (const a of agg.apexDownloadFailures) {
    const sub = a.subject ? `"${a.subject}"` : "Apex email";
    lines.push(`Apex PDF download failed — ${sub}.`);
  }

  for (const n of agg.noInvoiceEmails) {
    const sub = n.subject ? `"${n.subject}"` : "email";
    lines.push(`No processable invoice in ${sub}.`);
  }

  if (agg.stuckFlows) {
    lines.push(`${agg.stuckFlows} workflow(s) flagged as stuck.`);
  }

  if (!lines.length) {
    lines.push("No significant Jerry activity in this period.");
  }
  return lines;
}

/**
 * @param {object} agg Aggregated activity.
 * @param {string[]} fallbackBullets Deterministic lines.
 * @return {Promise<string[]>}
 */
async function polishBulletsWithAi(agg, fallbackBullets) {
  const openaiKey = process.env.SUPPORT_CHAT_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY;
  const model = process.env.DAILY_ACTIVITY_REPORT_MODEL ||
    process.env.FLOW_SUMMARY_MODEL || DEFAULT_OPENAI_MODEL;
  const prompt = [
    "Write an end-of-day operations digest for Jerry (freight billing AI). ",
    "Return ONLY JSON: {\"lines\": [\"...\", ...]}. ",
    "CRITICAL: One bullet per event — NEVER combine multiple loads into a ",
    "single line (wrong: 'Invoiced 25 loads'; right: separate line per load). ",
    "Include every item from aggregates.billed, ",
    "additionalChargeApprovals, billingFailures, workflowFailures, ",
    "forwardedForReview, ",
    "pastDueIgnored, etc. Do not say customer emails are waiting on ",
    "reviewer approval — those send automatically. ",
    "Each line: past tense, plain English, max 140 chars, no markdown. ",
    "Keep load numbers, carriers, dollar amounts, and Primus invoice numbers. ",
    "You may keep summary lines for inboxChecks/emailsProcessed only.",
  ].join("");

  const userPayload = JSON.stringify({
    aggregates: agg,
    requiredLineCount: fallbackBullets.length,
    fallback: fallbackBullets,
  });

  if (!openaiKey) {
    if (deps.writeLog) {
      await deps.writeLog("warn", "report",
          "Daily activity report: no OpenAI key — deterministic bullets", {});
    }
    return fallbackBullets;
  }

  try {
    const client = new OpenAI({apiKey: openaiKey});
    const res = await client.chat.completions.create({
      model,
      max_tokens: 8000,
      temperature: 0.1,
      response_format: {type: "json_object"},
      messages: [
        {role: "system", content: prompt},
        {role: "user", content: userPayload},
      ],
    });
    const text = String(
        res.choices[0] && res.choices[0].message &&
        res.choices[0].message.content || "",
    ).trim();
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed.lines) && parsed.lines.length) {
      const polished = parsed.lines
          .map((l) => String(l).trim())
          .filter(Boolean);
      // If OpenAI collapsed items, keep the full deterministic list.
      if (polished.length >= fallbackBullets.length * 0.85) {
        return polished;
      }
      if (deps.writeLog) {
        await deps.writeLog("warn", "report",
            "Daily activity OpenAI collapsed lines — using full list", {
              polished: polished.length,
              expected: fallbackBullets.length,
            });
      }
    }
  } catch (err) {
    if (deps.writeLog) {
      await deps.writeLog("warn", "report",
          "Daily activity OpenAI polish failed — deterministic bullets", {
            error: err.message,
          });
    }
  }
  return fallbackBullets;
}

/**
 * @param {string[]} lines Report bullets.
 * @param {object} meta Date range metadata.
 * @return {string}
 */
function buildReportHtml(lines, meta) {
  const esc = (s) => String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const items = lines.map((l) => `<li>${esc(l)}</li>`).join("");
  return (
    `<p>Hi Lisa,</p>` +
    `<p>Here is Jerry&apos;s activity for the ` +
    `<strong>last ${meta.hours} hours</strong> (${esc(meta.label)}).</p>` +
    `<ul style="line-height:1.55;font-size:13px">${items}</ul>` +
    `<p style="color:#6b7280;font-size:12px">` +
    `${lines.length} item(s) · automated daily digest</p>`
  );
}

/**
 * @param {*} amount Dollar amount.
 * @return {string}
 */
function fmtMoneyCell(amount) {
  if (amount == null || amount === "") return "—";
  const n = Number(amount);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "—";
}

/**
 * @param {*} pct Margin percentage.
 * @return {string}
 */
function fmtPctCell(pct) {
  if (pct == null || pct === "") return "—";
  const n = Number(pct);
  return Number.isFinite(n) ? `${n}%` : "—";
}

/**
 * @param {Array<object>} swaps Broker commission swap rows.
 * @param {object} meta Date range metadata.
 * @return {string}
 */
function buildBrokerSwapReportHtml(swaps, meta) {
  const esc = (s) => String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const fmtTrigger = (t) => {
    const s = String(t || "").trim();
    if (!s) return "—";
    return s.replace(/_/g, " ");
  };
  const fmtRepPair = (row) => {
    const from = row.fromRepName ? String(row.fromRepName) : "prior code";
    const to = row.toRepName ? String(row.toRepName) : "10% code";
    return `${esc(from)} → ${esc(to)}`;
  };

  if (!swaps.length) {
    return (
      `<p>Hi Lisa,</p>` +
      `<p>No broker commission swaps in the ` +
      `<strong>last ${meta.hours} hours</strong> (${esc(meta.label)}).</p>` +
      `<p style="color:#6b7280;font-size:12px">` +
      `automated daily broker swap report</p>`
    );
  }

  const rows = swaps.map((s) => (
    `<tr>` +
    `<td style="padding:6px 10px;border:1px solid #e5e7eb">` +
    `${esc(s.load || "—")}</td>` +
    `<td style="padding:6px 10px;border:1px solid #e5e7eb">` +
    `${esc(s.carrierName || "—")}</td>` +
    `<td style="padding:6px 10px;border:1px solid #e5e7eb;text-align:right">` +
    `${fmtMoneyCell(s.customerRate)}</td>` +
    `<td style="padding:6px 10px;border:1px solid #e5e7eb;text-align:right">` +
    `${fmtMoneyCell(s.carrierCost ?? s.vendorCost)}</td>` +
    `<td style="padding:6px 10px;border:1px solid #e5e7eb;text-align:right">` +
    `${fmtMoneyCell(s.profit)}</td>` +
    `<td style="padding:6px 10px;border:1px solid #e5e7eb;text-align:right">` +
    `${fmtPctCell(s.marginPct)}</td>` +
    `<td style="padding:6px 10px;border:1px solid #e5e7eb">` +
    `${fmtRepPair(s)}</td>` +
    `<td style="padding:6px 10px;border:1px solid #e5e7eb">` +
    `${esc(fmtTrigger(s.trigger))}</td>` +
    `</tr>`
  )).join("");

  return (
    `<p>Hi Lisa,</p>` +
    `<p>Broker commission swaps for the ` +
    `<strong>last ${meta.hours} hours</strong> (${esc(meta.label)}):</p>` +
    `<table style="border-collapse:collapse;font-size:13px;width:100%;` +
    `max-width:960px">` +
    `<thead><tr style="background:#f3f4f6">` +
    `<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">` +
    `Load</th>` +
    `<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">` +
    `Carrier</th>` +
    `<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:right">` +
    `Customer rate</th>` +
    `<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:right">` +
    `Carrier/shipment cost</th>` +
    `<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:right">` +
    `Profit</th>` +
    `<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:right">` +
    `Margin %</th>` +
    `<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">` +
    `From → To rep</th>` +
    `<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">` +
    `Trigger</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>` +
    `<p style="color:#6b7280;font-size:12px;margin-top:12px">` +
    `${swaps.length} swap(s) · automated daily broker swap report</p>`
  );
}

/**
 * @param {object} opts Options.
 * @param {object} opts.tenant Tenant config.
 * @param {number} [opts.hours=24] Lookback window.
 * @param {boolean} [opts.dryRun=false] Skip email send.
 * @return {Promise<object>}
 */
async function runDailyActivityReport(opts = {}) {
  const tenant = opts.tenant;
  const hours = Math.min(Math.max(Number(opts.hours || 24), 1), 168);
  const dryRun = Boolean(opts.dryRun);
  const dataset = (tenant && tenant.bqDataset) ||
    process.env.BQ_DATASET || "invoice_automation";
  const bq = deps.bigquery;
  if (!bq) throw new Error("daily-activity-report: bigquery not initialized");

  const [rows] = await bq.query({
    query: `
      SELECT timestamp, level, category, message, details
      FROM \`${dataset}.logs\`
      WHERE timestamp >= TIMESTAMP_SUB(
        CURRENT_TIMESTAMP(), INTERVAL @hours HOUR)
      ORDER BY timestamp ASC
    `,
    params: {hours},
  });

  const agg = aggregateDailyActivity(rows);
  const fallback = buildDeterministicBullets(agg);
  const lines = await polishBulletsWithAi(agg, fallback);

  const now = new Date();
  const label = now.toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  });
  const subjectDate = now.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const html = buildReportHtml(lines, {hours, label});
  const subject = `Jerry daily activity — ${subjectDate}`;

  const to = process.env.DAILY_ACTIVITY_REPORT_EMAIL ||
    process.env.LOW_PROFIT_CC_EMAIL || "Lisa@innovativecarriers.com";
  const cc = process.env.DAILY_ACTIVITY_REPORT_CC || null;

  if (!dryRun && deps.saveOutboundEmail) {
    await deps.saveOutboundEmail({
      type: "daily_activity_report",
      subject,
      html,
      to,
      cc,
      tenant,
    });
  }

  if (deps.writeLog) {
    await deps.writeLog("info", "report", "Daily activity report generated", {
      hours,
      logCount: rows.length,
      bulletCount: lines.length,
      dryRun,
      to,
      cc,
      tenantId: tenant && tenant.tenantId,
    }, null, tenant);
  }

  return {
    ok: true,
    hours,
    logCount: rows.length,
    bulletCount: lines.length,
    lines,
    dryRun,
    emailedTo: dryRun ? null : to,
  };
}

/**
 * @param {object} opts Options.
 * @param {object} opts.tenant Tenant config.
 * @param {number} [opts.hours=24] Lookback window.
 * @param {boolean} [opts.dryRun=false] Skip email send.
 * @return {Promise<object>}
 */
async function runDailyBrokerSwapReport(opts = {}) {
  const tenant = opts.tenant;
  const hours = Math.min(Math.max(Number(opts.hours || 24), 1), 168);
  const dryRun = Boolean(opts.dryRun);
  const dataset = (tenant && tenant.bqDataset) ||
    process.env.BQ_DATASET || "invoice_automation";
  const bq = deps.bigquery;
  if (!bq) throw new Error("daily-activity-report: bigquery not initialized");

  const [rows] = await bq.query({
    query: `
      SELECT timestamp, level, category, message, details
      FROM \`${dataset}.logs\`
      WHERE timestamp >= TIMESTAMP_SUB(
        CURRENT_TIMESTAMP(), INTERVAL @hours HOUR)
        AND message = "Broker commission swapped to 10%"
      ORDER BY timestamp ASC
    `,
    params: {hours},
  });

  const agg = aggregateDailyActivity(rows);
  const swaps = agg.brokerCommissionSwaps;

  const now = new Date();
  const label = now.toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  });
  const subjectDate = now.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const html = buildBrokerSwapReportHtml(swaps, {hours, label});
  const subject = `Jerry broker commission swaps — ${subjectDate}`;

  const to = process.env.DAILY_ACTIVITY_REPORT_EMAIL ||
    process.env.LOW_PROFIT_CC_EMAIL || "Lisa@innovativecarriers.com";
  const cc = process.env.DAILY_ACTIVITY_REPORT_CC || null;

  if (!dryRun && deps.saveOutboundEmail) {
    await deps.saveOutboundEmail({
      type: "daily_broker_swap_report",
      subject,
      html,
      to,
      cc,
      tenant,
    });
  }

  if (deps.writeLog) {
    await deps.writeLog("info", "report",
        "Daily broker swap report generated", {
          hours,
          logCount: rows.length,
          swapCount: swaps.length,
          dryRun,
          to,
          cc,
          tenantId: tenant && tenant.tenantId,
        }, null, tenant);
  }

  return {
    ok: true,
    hours,
    logCount: rows.length,
    swapCount: swaps.length,
    swaps,
    dryRun,
    emailedTo: dryRun ? null : to,
  };
}

/**
 * Escapes HTML for email bodies.
 * @param {*} str Value to escape.
 * @return {string}
 */
function escapeHtml(str) {
  return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}

/**
 * Formats a Firestore/Graph timestamp for display (ET, with seconds).
 * Prefers email receivedDateTime when present.
 * @param {*} ts Firestore timestamp, Date, or ISO string.
 * @return {string}
 */
function fmtDiscoveredAt(ts) {
  let date = null;
  if (ts && typeof ts.toDate === "function") {
    date = ts.toDate();
  } else if (ts instanceof Date) {
    date = ts;
  } else if (typeof ts === "string" && ts.trim()) {
    const parsed = new Date(ts);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  }
  if (!date) return "—";
  return date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }) + " ET";
}

/**
 * Prefer Graph received time, then discovered/finished.
 * @param {object} row emailIntake row.
 * @return {*}
 */
function intakeDisplayTime(row) {
  return (row && (row.receivedDateTime || row.receivedAt ||
    row.discoveredAt || row.finishedAt)) || null;
}

/**
 * Builds HTML for the daily inbox intake digest.
 * @param {Array<object>} rows emailIntake rows.
 * @param {object} meta Report metadata.
 * @return {string}
 */
function buildInboxDigestHtml(rows, meta) {
  const needsAttention = rows.filter((row) => {
    const status = row.intakeStatus || row.status;
    return status === "queued" || status === "processing" ||
      status === "failed" || status === "waiting_children";
  });
  const completed = rows.filter((row) => {
    const status = row.intakeStatus || row.status;
    return status === "completed";
  });

  const rowHtml = (list) => list.map((row) => {
    const status = row.intakeStatus || row.status || "unknown";
    const summary = row.summary ||
      mailIntakeQueue.buildIntakeSummary(row);
    return `<tr>` +
      `<td style="padding:6px 10px;border:1px solid #e5e7eb">` +
      `${escapeHtml(fmtDiscoveredAt(intakeDisplayTime(row)))}</td>` +
      `<td style="padding:6px 10px;border:1px solid #e5e7eb">` +
      `${escapeHtml(row.from || "—")}</td>` +
      `<td style="padding:6px 10px;border:1px solid #e5e7eb">` +
      `${escapeHtml(row.subject || "—")}</td>` +
      `<td style="padding:6px 10px;border:1px solid #e5e7eb">` +
      `${escapeHtml(status)}</td>` +
      `<td style="padding:6px 10px;border:1px solid #e5e7eb">` +
      `${escapeHtml(summary)}</td>` +
      `</tr>`;
  }).join("");

  const table = (title, list) => {
    if (!list.length) {
      return `<h3 style="margin:18px 0 8px">${escapeHtml(title)}</h3>` +
        `<p style="color:#6b7280">None.</p>`;
    }
    return `<h3 style="margin:18px 0 8px">${escapeHtml(title)} ` +
      `(${list.length})</h3>` +
      `<table style="border-collapse:collapse;width:100%;font-size:13px">` +
      `<thead><tr style="background:#f9fafb">` +
      `<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">` +
      `Received (ET)</th>` +
      `<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">` +
      `From</th>` +
      `<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">` +
      `Subject</th>` +
      `<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">` +
      `Status</th>` +
      `<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">` +
      `Summary</th>` +
      `</tr></thead><tbody>${rowHtml(list)}</tbody></table>`;
  };

  return (
    `<p style="color:#374151">Inbox intake for the last ${meta.hours} hours ` +
    `(as of ${escapeHtml(meta.label)} ET).</p>` +
    table("Needs attention", needsAttention) +
    table("Completed", completed) +
    `<p style="color:#6b7280;font-size:12px;margin-top:12px">` +
    `${rows.length} email(s) discovered · automated inbox digest</p>`
  );
}

/**
 * @param {object} opts Options.
 * @param {object} opts.tenant Tenant config.
 * @param {number} [opts.hours=24] Lookback window.
 * @param {boolean} [opts.dryRun=false] Skip email send.
 * @return {Promise<object>}
 */
async function runDailyInboxDigestReport(opts = {}) {
  const tenant = opts.tenant;
  const hours = Math.min(Math.max(Number(opts.hours || 24), 1), 168);
  const dryRun = Boolean(opts.dryRun);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const rows = await mailIntakeQueue.listIntakeForDigest(tenant, since);

  const now = new Date();
  const label = now.toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  });
  const subjectDate = now.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const html = buildInboxDigestHtml(rows, {hours, label});
  const subject = `Jerry inbox digest — ${subjectDate}`;

  const to = process.env.DAILY_ACTIVITY_REPORT_EMAIL ||
    process.env.LOW_PROFIT_CC_EMAIL || "Lisa@innovativecarriers.com";
  const cc = process.env.DAILY_ACTIVITY_REPORT_CC || null;

  if (!dryRun && deps.saveOutboundEmail) {
    await deps.saveOutboundEmail({
      type: "daily_inbox_digest",
      subject,
      html,
      to,
      cc,
      tenant,
    });
  }

  const needsAttentionCount = rows.filter((row) => {
    const status = row.intakeStatus || row.status;
    return status === "queued" || status === "processing" ||
      status === "failed" || status === "waiting_children";
  }).length;

  if (deps.writeLog) {
    await deps.writeLog("info", "report", "Daily inbox digest generated", {
      hours,
      emailCount: rows.length,
      needsAttentionCount,
      dryRun,
      to,
      cc,
      tenantId: tenant && tenant.tenantId,
    }, null, tenant);
  }

  return {
    ok: true,
    hours,
    emailCount: rows.length,
    needsAttentionCount,
    dryRun,
    emailedTo: dryRun ? null : to,
  };
}

/** Human-readable labels for ignore categories (by finalStatus). */
const IGNORE_CATEGORY_LABELS = {
  payment_notification_ignored: "Payment notification",
  emodal_broadcast_ignored: "eModal / terminal broadcast",
  cardknox_batch_report_ignored: "Cardknox batch report",
  amex_merchant_survey_ignored: "AmEx merchant satisfaction survey",
  dnb_promotional_ignored: "D&B promotional / marketing",
  coface_ignored: "Coface newsletter/marketing",
  noa_ignored: "Notice of assignment (NOA)",
  carrier_portal_notification_ignored: "Carrier open-invoice portal",
  credit_agency_notification_ignored: "Credit-agency / trade-credit alert",
  already_processed: "Already processed",
  statement_ignored_abe_cc: "Carrier statement (Abe on CC)",
  past_due_only: "Past-due / already in Primus",
  administrative_ignored: "Administrative",
  payment_inquiry_ignored_abe_cc: "Payment inquiry (Abe on thread)",
  insurance_duplicate: "Duplicate insurance intake",
};

/**
 * @param {object} row emailIntake row.
 * @return {string} Category key for grouping.
 */
function categorizeIgnoredEmail(row) {
  const finalStatus = row.finalStatus || row.outcomeReason || "other";
  return String(finalStatus);
}

/**
 * @param {string} categoryKey finalStatus / outcomeReason key.
 * @return {string} Display label for ignore category.
 */
function labelIgnoredCategory(categoryKey) {
  if (IGNORE_CATEGORY_LABELS[categoryKey]) {
    return IGNORE_CATEGORY_LABELS[categoryKey];
  }
  return String(categoryKey).replace(/_/g, " ");
}

/**
 * @param {object} row emailIntake row.
 * @return {string} Reason text for display.
 */
function describeIgnoredReason(row) {
  if (row.ignoreReason) return String(row.ignoreReason);
  if (row.summary) return String(row.summary);
  const key = categorizeIgnoredEmail(row);
  const labeled = labelIgnoredCategory(key);
  return labeled !== "other" ? labeled : "Ignored";
}

/**
 * @param {string|null|undefined} messageId Message id.
 * @return {string}
 */
function fmtMessageIdTail(messageId) {
  const id = String(messageId || "");
  if (!id) return "—";
  return id.length > 10 ? `…${id.slice(-10)}` : id;
}

/**
 * @param {Array<object>} rows Ignored emailIntake rows.
 * @return {Array<{categoryKey: string, label: string, rows: Array<object>}>}
 */
function groupIgnoredEmails(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const categoryKey = categorizeIgnoredEmail(row);
    if (!buckets.has(categoryKey)) {
      buckets.set(categoryKey, []);
    }
    buckets.get(categoryKey).push(row);
  }
  return Array.from(buckets.entries())
      .map(([categoryKey, bucketRows]) => ({
        categoryKey,
        label: labelIgnoredCategory(categoryKey),
        rows: bucketRows.sort((a, b) => {
          const aMs = mailIntakeQueue.intakeFinishedMs(a) || 0;
          const bMs = mailIntakeQueue.intakeFinishedMs(b) || 0;
          return aMs - bMs;
        }),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Builds HTML for the daily ignored-emails digest.
 * @param {Array<object>} groups groupIgnoredEmails output.
 * @param {object} meta Report metadata.
 * @return {string}
 */
function buildIgnoredEmailsReportHtml(groups, meta) {
  const rowHtml = (list) => list.map((row) => {
    const finished = row.receivedDateTime || row.receivedAt ||
      row.finishedAt || row.discoveredAt;
    const messageId = row.id || row.gmailMessageId || null;
    return `<tr>` +
      `<td style="padding:6px 10px;border:1px solid #e5e7eb">` +
      `${escapeHtml(fmtDiscoveredAt(finished))}</td>` +
      `<td style="padding:6px 10px;border:1px solid #e5e7eb">` +
      `${escapeHtml(row.from || "—")}</td>` +
      `<td style="padding:6px 10px;border:1px solid #e5e7eb">` +
      `${escapeHtml(row.subject || "—")}</td>` +
      `<td style="padding:6px 10px;border:1px solid #e5e7eb">` +
      `${escapeHtml(row.finalStatus || row.outcomeReason || "—")}</td>` +
      `<td style="padding:6px 10px;border:1px solid #e5e7eb">` +
      `${escapeHtml(describeIgnoredReason(row))}</td>` +
      `<td style="padding:6px 10px;border:1px solid #e5e7eb;` +
      `font-family:monospace">` +
      `${escapeHtml(fmtMessageIdTail(messageId))}</td>` +
      `</tr>`;
  }).join("");

  const tableHead = (
    `<thead><tr style="background:#f9fafb">` +
    `<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">` +
    `Received (ET)</th>` +
    `<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">` +
    `From</th>` +
    `<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">` +
    `Subject</th>` +
    `<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">` +
    `Status</th>` +
    `<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">` +
    `Reason</th>` +
    `<th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left">` +
    `Msg ID</th>` +
    `</tr></thead>`
  );

  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  if (!total) {
    return (
      `<p style="color:#374151">No ignored emails in the last ${meta.hours} ` +
      `hours (as of ${escapeHtml(meta.label)} ET).</p>` +
      `<p style="color:#6b7280;font-size:12px">` +
      `automated daily ignored-email report</p>`
    );
  }

  const sections = groups.map((group) => (
    `<h3 style="margin:18px 0 8px">${escapeHtml(group.label)} ` +
    `(${group.rows.length})</h3>` +
    `<table style="border-collapse:collapse;width:100%;font-size:13px">` +
    `${tableHead}<tbody>${rowHtml(group.rows)}</tbody></table>`
  )).join("");

  return (
    `<p style="color:#374151">Ignored emails for the last ${meta.hours} ` +
    `hours (as of ${escapeHtml(meta.label)} ET). Review for possible ` +
    `mis-ignored invoices.</p>` +
    sections +
    `<p style="color:#6b7280;font-size:12px;margin-top:12px">` +
    `${total} ignored email(s) · automated daily ignored-email report</p>`
  );
}

/**
 * @param {object} opts Options.
 * @param {object} opts.tenant Tenant config.
 * @param {number} [opts.hours=24] Lookback window.
 * @param {boolean} [opts.dryRun=false] Skip email send.
 * @return {Promise<object>}
 */
async function runDailyIgnoredEmailsReport(opts = {}) {
  const tenant = opts.tenant;
  const hours = Math.min(Math.max(Number(opts.hours || 24), 1), 168);
  const dryRun = Boolean(opts.dryRun);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const rows = await mailIntakeQueue.listIgnoredIntakeForReport(tenant, since);
  const groups = groupIgnoredEmails(rows);

  const now = new Date();
  const label = now.toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  });
  const subjectDate = now.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const html = buildIgnoredEmailsReportHtml(groups, {hours, label});
  const subject = `Jerry ignored emails — ${subjectDate}`;

  const to = process.env.DAILY_ACTIVITY_REPORT_EMAIL ||
    process.env.LOW_PROFIT_CC_EMAIL || "Lisa@innovativecarriers.com";
  const cc = process.env.DAILY_ACTIVITY_REPORT_CC || null;

  if (!dryRun && deps.saveOutboundEmail) {
    await deps.saveOutboundEmail({
      type: "daily_ignored_emails_report",
      subject,
      html,
      to,
      cc,
      tenant,
    });
  }

  if (deps.writeLog) {
    await deps.writeLog("info", "report",
        "Daily ignored emails report generated", {
          hours,
          ignoredCount: rows.length,
          categoryCount: groups.length,
          dryRun,
          to,
          cc,
          tenantId: tenant && tenant.tenantId,
        }, null, tenant);
  }

  return {
    ok: true,
    hours,
    ignoredCount: rows.length,
    categoryCount: groups.length,
    groups: groups.map((g) => ({
      categoryKey: g.categoryKey,
      label: g.label,
      count: g.rows.length,
    })),
    dryRun,
    emailedTo: dryRun ? null : to,
  };
}

exports.aggregateDailyActivity = aggregateDailyActivity;
exports.buildDeterministicBullets = buildDeterministicBullets;
exports.runDailyActivityReport = runDailyActivityReport;
exports.runDailyBrokerSwapReport = runDailyBrokerSwapReport;
exports.runDailyInboxDigestReport = runDailyInboxDigestReport;
exports.runDailyIgnoredEmailsReport = runDailyIgnoredEmailsReport;
exports.categorizeIgnoredEmail = categorizeIgnoredEmail;
exports.labelIgnoredCategory = labelIgnoredCategory;
exports.describeIgnoredReason = describeIgnoredReason;
exports.groupIgnoredEmails = groupIgnoredEmails;
exports.buildIgnoredEmailsReportHtml = buildIgnoredEmailsReportHtml;
exports.buildInboxDigestHtml = buildInboxDigestHtml;
exports.fmtDiscoveredAt = fmtDiscoveredAt;
exports.intakeDisplayTime = intakeDisplayTime;
