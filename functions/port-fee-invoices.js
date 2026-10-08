/**
 * Pier Pass (TMF) and Port Check (CTF) invoice intake.
 *
 * Each PDF is one vendor bill covering many containers. Jerry posts one
 * actual-cost line per container onto the Primus load found by that
 * container number (the load PRO). The ocean booking number on the PDF
 * is not a Primus BOL and is never used as the lookup key.
 *
 * Bill date and due date are the invoice date. Terms are Due on receipt.
 * Customer charges are left alone.
 */

"use strict";

const podUtils = require("./pod-utils");
const loadResolution = require("./invoice-load-resolution");

/** @type {object} Injected from index.js */
let deps = {};

/**
 * @param {object} bundle Shared helpers.
 * @return {void}
 */
function init(bundle) {
  deps = bundle || {};
}

/**
 * @enum {string}
 */
const SKIP_REASON = {
  LOAD_NOT_FOUND: "LOAD_NOT_FOUND",
  AMBIGUOUS_LOAD: "AMBIGUOUS_LOAD",
  NO_INVOICE: "NO_INVOICE",
  DUPLICATE_FEE: "DUPLICATE_FEE",
  DUPLICATE_LINE: "DUPLICATE_LINE",
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
  ZERO_AMOUNT: "ZERO_AMOUNT",
  POST_FAILED: "POST_FAILED",
  VENDOR_NOT_FOUND: "VENDOR_NOT_FOUND",
  TERMS_NOT_FOUND: "TERMS_NOT_FOUND",
};

const MISSING_LOAD_TO = "Josef@innovativecarriers.com";
const MISSING_LOAD_CC = "Leo@innovativecarriers.com";

const CHARGE_PROFILES = {
  TMF: {
    code: "TMF",
    description: "TMF",
    vendorName: "Pier Pass",
    label: "Traffic Mitigation Fee",
  },
  CTF: {
    code: "CTF",
    description: "CTF",
    vendorName: "Port Check",
    label: "Clean Truck Fee",
  },
};

/**
 * @param {number} amount Raw money value.
 * @return {number}
 */
function roundMoney(amount) {
  return Math.round(Number(amount || 0) * 100) / 100;
}

/**
 * @param {number} a First amount.
 * @param {number} b Second amount.
 * @return {boolean}
 */
function moneyEquals(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) <= 0.009;
}

/**
 * @param {*} value Raw string.
 * @return {string}
 */
function escapeHtml(value) {
  return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}

/**
 * ISO 6346 container id: 3-letter owner + category U/J/Z + 7 digits.
 * @param {string} value Raw token.
 * @return {boolean}
 */
function isIsoContainer(value) {
  return /^[A-Z]{3}[UJZ]\d{7}$/.test(String(value || "").toUpperCase());
}

/**
 * @param {string} text PDF text.
 * @return {string|null} "TMF", "CTF", or null.
 */
function detectPortFeeKind(text) {
  const raw = String(text || "");
  if (/Traffic Mitigation Fee Invoice/i.test(raw)) return "TMF";
  if (/Port Rate Invoice/i.test(raw) &&
      /Clean Truck Fee|PortCheck/i.test(raw)) {
    return "CTF";
  }
  return null;
}

/**
 * @param {string} mdy MM/DD/YYYY.
 * @return {string|null} YYYY-MM-DD.
 */
function usDateToIso(mdy) {
  const m = String(mdy || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

/**
 * Pulls container + fee pairs from the detail section.
 * The fee is the first money amount after the container and before the
 * next container or the footer Total.
 * @param {string} text Full invoice text.
 * @return {Array<{container: string, amount: number}>}
 */
function parseContainerLines(text) {
  const raw = String(text || "");
  const detailAt = raw.search(/Container Number/i);
  const detail = detailAt >= 0 ? raw.slice(detailAt) : raw;
  const re = /\b([A-Z]{4}\d{7})\b/g;
  const hits = [];
  let match;
  while ((match = re.exec(detail))) {
    const container = match[1].toUpperCase();
    if (!isIsoContainer(container)) continue;
    hits.push({container, index: match.index});
  }
  const lines = [];
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].index + hits[i].container.length;
    const end = i + 1 < hits.length ? hits[i + 1].index : detail.length;
    let span = detail.slice(start, end);
    const totalCut = span.search(/\bTotal\b/);
    if (totalCut >= 0) span = span.slice(0, totalCut);
    const money = span.match(/\b(\d{1,3}(?:,\d{3})*\.\d{2})\b/);
    const amount = money ?
      roundMoney(String(money[1]).replace(/,/g, "")) : 0;
    lines.push({container: hits[i].container, amount});
  }
  return lines;
}

/**
 * @param {string} text Extracted PDF text.
 * @param {object} [meta] filename.
 * @return {object} {ok, error?, invoice?}
 */
function parsePortFeeInvoiceText(text, meta) {
  const raw = String(text || "");
  const kind = detectPortFeeKind(raw);
  if (!kind) return {ok: false, error: "not a port fee invoice"};
  const profile = CHARGE_PROFILES[kind];

  const invMatch = raw.match(/\b(\d{4,8}-\d{5,}-IN)\b/);
  if (!invMatch) {
    return {ok: false, error: "invoice number not found", kind};
  }
  const invoiceNumber = invMatch[1];
  const afterInv = raw.slice(invMatch.index + invoiceNumber.length);
  const periodRe = new RegExp(
      "(\\d{2}/\\d{2}/\\d{4})\\s*-\\s*" +
      "(\\d{2}/\\d{2}/\\d{4})\\s+" +
      "(\\d{2}/\\d{2}/\\d{4})",
  );
  const period = afterInv.match(periodRe);
  if (!period) {
    return {ok: false, error: "invoice date not found", kind};
  }
  const invoiceDate = usDateToIso(period[3]);
  if (!invoiceDate) {
    return {ok: false, error: "invoice date not found", kind};
  }

  const dollar = raw.match(/\$\s*([0-9,]+\.\d{2})/);
  const invoiceTotal = dollar ?
    roundMoney(String(dollar[1]).replace(/,/g, "")) : 0;
  if (!(invoiceTotal > 0)) {
    return {ok: false, error: "invoice total not found", kind};
  }
  const dueMatch = raw.match(/\$\s*[0-9,]+\.\d{2}\s+(\d{2}\/\d{2}\/\d{4})/);
  const printedDueDate = dueMatch ? usDateToIso(dueMatch[1]) : null;

  const parsedLines = parseContainerLines(raw);
  if (!parsedLines.length) {
    return {ok: false, error: "no container lines", kind};
  }

  const seen = new Set();
  const lines = [];
  for (const line of parsedLines) {
    const row = {
      container: line.container,
      amount: line.amount,
      chargeCode: profile.code,
      description: profile.description,
    };
    if (seen.has(line.container)) {
      row.duplicateOnInvoice = true;
    } else {
      seen.add(line.container);
    }
    lines.push(row);
  }

  const lineSum = roundMoney(lines.reduce((s, l) => s + l.amount, 0));
  if (!moneyEquals(lineSum, invoiceTotal)) {
    return {
      ok: false,
      error: `line total ${lineSum.toFixed(2)} does not match ` +
        `invoice total ${invoiceTotal.toFixed(2)}`,
      kind,
      invoiceNumber,
    };
  }

  return {
    ok: true,
    invoice: {
      kind,
      chargeCode: profile.code,
      description: profile.description,
      vendorName: profile.vendorName,
      label: profile.label,
      invoiceNumber,
      invoiceDate,
      printedDueDate,
      invoiceTotal,
      lines,
      filename: (meta && meta.filename) || null,
    },
  };
}

/**
 * @param {object} row Tracking-search row.
 * @param {string} container Container number.
 * @return {boolean}
 */
function rowHasContainer(row, container) {
  let blob = "";
  try {
    blob = JSON.stringify(row);
  } catch (_) {
    blob = "";
  }
  return new RegExp(`\\b${container}\\b`, "i").test(blob);
}

/**
 * Picks the Primus load for a container search.
 * Prefers a row that actually contains the container. A single search
 * hit is accepted when Primus returned only that load.
 * @param {Array<object>} rows getBookingsForTracking rows.
 * @param {string} container Container number.
 * @return {object}
 */
function pickContainerMatch(rows, container) {
  const valid = [];
  const seen = new Set();
  for (const row of rows || []) {
    const bol = loadResolution.normalizeLoadNumber(
        row && (row.BOL || row.bol));
    if (!loadResolution.isValidLoadNumber(bol) || seen.has(bol)) continue;
    seen.add(bol);
    valid.push({
      loadNumber: bol,
      row,
      echoed: rowHasContainer(row, container),
    });
  }
  const echoed = valid.filter((r) => r.echoed);
  const pool = echoed.length ? echoed : (valid.length === 1 ? valid : []);
  if (pool.length === 1) {
    return {
      ok: true,
      loadNumber: pool[0].loadNumber,
      row: pool[0].row,
      source: pool[0].echoed ? "container_on_load" : "single_search_hit",
    };
  }
  if (valid.length > 1) {
    return {ok: false, ambiguous: true, count: valid.length};
  }
  return {ok: false, notFound: true};
}

/**
 * @param {string} code Skip reason.
 * @param {object} [ctx] Extra context.
 * @return {string}
 */
function skipReasonText(code, ctx) {
  const c = ctx || {};
  switch (code) {
    case SKIP_REASON.LOAD_NOT_FOUND:
      return `Container ${c.container || ""} did not match a Primus load.`;
    case SKIP_REASON.AMBIGUOUS_LOAD:
      return `Container ${c.container || ""} matched ${c.count || "several"} ` +
        "loads. Not posted.";
    case SKIP_REASON.NO_INVOICE:
      return `Load ${c.loadNumber || ""} has no Primus invoice yet.`;
    case SKIP_REASON.DUPLICATE_FEE:
      return `Load ${c.loadNumber || ""} already has this charge` +
        (c.existingBill ? ` on bill ${c.existingBill}` : "") + ".";
    case SKIP_REASON.DUPLICATE_LINE:
      return "Container is listed twice on this invoice. Second line skipped.";
    case SKIP_REASON.AMOUNT_MISMATCH:
      return `Load ${c.loadNumber || ""} already has this bill at a ` +
        "different amount.";
    case SKIP_REASON.ZERO_AMOUNT:
      return "Charge amount is zero or unreadable.";
    case SKIP_REASON.VENDOR_NOT_FOUND:
      return `Vendor ${c.vendorName || ""} was not found in Primus.`;
    case SKIP_REASON.TERMS_NOT_FOUND:
      return "Primus has no Due on receipt term.";
    case SKIP_REASON.POST_FAILED:
      return "Could not post to Primus" + (c.error ? `: ${c.error}` : ".");
    default:
      return "Not posted.";
  }
}

/**
 * Posts every line on one parsed invoice.
 * @param {object} opts invoice, findLoad, postCharge, vendor, termsId.
 * @return {Promise<{posted: Array, already: Array, skipped: Array}>}
 */
async function applyPortFeeLines(opts) {
  const invoice = opts.invoice;
  const findLoad = opts.findLoad;
  const postCharge = opts.postCharge;
  const vendor = opts.vendor || null;
  const termsId = opts.termsId;
  const posted = [];
  const already = [];
  const skipped = [];

  if (!vendor || !vendor.id) {
    for (const line of invoice.lines) {
      skipped.push({
        ...line,
        reason: SKIP_REASON.VENDOR_NOT_FOUND,
        vendorName: invoice.vendorName,
      });
    }
    return {posted, already, skipped};
  }
  if (termsId == null || termsId === "") {
    for (const line of invoice.lines) {
      skipped.push({...line, reason: SKIP_REASON.TERMS_NOT_FOUND});
    }
    return {posted, already, skipped};
  }

  for (const line of invoice.lines) {
    if (line.duplicateOnInvoice) {
      skipped.push({...line, reason: SKIP_REASON.DUPLICATE_LINE});
      continue;
    }
    if (!(line.amount > 0)) {
      skipped.push({...line, reason: SKIP_REASON.ZERO_AMOUNT});
      continue;
    }
    let found;
    try {
      found = await findLoad(line.container);
    } catch (err) {
      skipped.push({
        ...line,
        reason: SKIP_REASON.POST_FAILED,
        error: err && err.message,
      });
      continue;
    }
    if (!found || !found.ok) {
      skipped.push({
        ...line,
        reason: found && found.ambiguous ?
          SKIP_REASON.AMBIGUOUS_LOAD : SKIP_REASON.LOAD_NOT_FOUND,
        count: found && found.count,
      });
      continue;
    }

    let result;
    try {
      result = await postCharge({
        loadNumber: found.loadNumber,
        booking: found.booking,
        amount: line.amount,
        chargeCode: invoice.chargeCode,
        description: invoice.description,
        vendor,
        vendorInvoiceNumber: invoice.invoiceNumber,
        billDate: invoice.invoiceDate,
        dueDate: invoice.invoiceDate,
        proNumber: line.container,
        termsId,
      });
    } catch (err) {
      skipped.push({
        ...line,
        loadNumber: found.loadNumber,
        reason: SKIP_REASON.POST_FAILED,
        error: err && err.message,
      });
      continue;
    }

    const base = {
      ...line,
      loadNumber: found.loadNumber,
      matchSource: found.source || null,
    };
    if (result && result.ok && result.skipped) {
      already.push(base);
      continue;
    }
    if (result && result.ok) {
      posted.push(base);
      continue;
    }
    if (result && result.duplicate) {
      skipped.push({
        ...base,
        reason: SKIP_REASON.DUPLICATE_FEE,
        existingBill: result.existingBill || null,
      });
      continue;
    }
    if (result && result.noInvoice) {
      skipped.push({...base, reason: SKIP_REASON.NO_INVOICE});
      continue;
    }
    if (result && result.amountMismatch) {
      skipped.push({...base, reason: SKIP_REASON.AMOUNT_MISMATCH});
      continue;
    }
    skipped.push({
      ...base,
      reason: SKIP_REASON.POST_FAILED,
      error: result && result.error,
    });
  }

  return {posted, already, skipped};
}

/**
 * @param {object} invoice Parsed invoice.
 * @param {object} counts posted, already, skipped.
 * @return {object}
 */
function summarizeInvoice(invoice, counts) {
  const postedSum = roundMoney(
      counts.posted.reduce((s, l) => s + l.amount, 0) +
      counts.already.reduce((s, l) => s + l.amount, 0));
  return {
    invoiceNumber: invoice.invoiceNumber,
    chargeCode: invoice.chargeCode,
    vendorName: invoice.vendorName,
    label: invoice.label,
    invoiceDate: invoice.invoiceDate,
    printedDueDate: invoice.printedDueDate,
    invoiceTotal: invoice.invoiceTotal,
    filename: invoice.filename,
    postedCount: counts.posted.length,
    alreadyCount: counts.already.length,
    skippedCount: counts.skipped.length,
    postedSum,
    matchesInvoice: moneyEquals(postedSum, invoice.invoiceTotal),
    posted: counts.posted,
    already: counts.already,
    skipped: counts.skipped,
  };
}

/**
 * @param {Array<object>} summaries Per-invoice summaries.
 * @param {Array<object>} rejected PDFs that looked like port fees but
 *   did not parse.
 * @return {{subject: string, html: string}}
 */
function buildReconciliationEmail(summaries, rejected) {
  const money = (n) => `$${Number(n || 0).toFixed(2)}`;
  const sections = [];
  let postedTotal = 0;
  let skippedTotal = 0;
  for (const rec of summaries) {
    postedTotal += rec.postedCount + rec.alreadyCount;
    skippedTotal += rec.skippedCount;
    const status = rec.matchesInvoice ?
      `<span style="color:#16a34a;font-weight:700">` +
        `Entered charges match the invoice total.</span>` :
      `<span style="color:#dc2626;font-weight:700">` +
        `Entered charges do not match the invoice total.</span>`;
    const rows = rec.skipped;
    const table = rows.length ?
      `<table style="border-collapse:collapse;font-size:13px;margin:8px 0">` +
      `<tr><th style="text-align:left;padding:4px 10px">Container</th>` +
      `<th style="text-align:left;padding:4px 10px">Load</th>` +
      `<th style="text-align:right;padding:4px 10px">Amount</th>` +
      `<th style="text-align:left;padding:4px 10px">Why</th></tr>` +
      rows.map((r) =>
        `<tr><td style="padding:4px 10px">${escapeHtml(r.container)}</td>` +
        `<td style="padding:4px 10px">` +
        `${escapeHtml(r.loadNumber || "—")}</td>` +
        `<td style="padding:4px 10px;text-align:right">` +
        `${money(r.amount)}</td>` +
        `<td style="padding:4px 10px">` +
        `${escapeHtml(skipReasonText(r.reason, r))}</td></tr>`,
      ).join("") +
      `</table>` :
      `<p style="color:#16a34a">Every charge was entered.</p>`;
    sections.push(
        `<h3>${escapeHtml(rec.vendorName)} ${escapeHtml(rec.chargeCode)} ` +
        `#${escapeHtml(rec.invoiceNumber)}</h3>` +
        `<p>${status}</p>` +
        `<p>Bill date ${escapeHtml(rec.invoiceDate)} · Due on receipt · ` +
        `PRO is the container number. Printed due date on the PDF: ` +
        `${escapeHtml(rec.printedDueDate || "—")}.</p>` +
        `<p>${rec.postedCount} entered, ${rec.alreadyCount} already on ` +
        `the load, ${rec.skippedCount} not entered. Invoice total ` +
        `${money(rec.invoiceTotal)}.</p>` +
        table,
    );
  }
  if (rejected && rejected.length) {
    sections.push(
        `<h3>Could not read</h3><ul>` +
        rejected.map((r) =>
          `<li>${escapeHtml(r.filename || "PDF")}: ` +
          `${escapeHtml(r.error || "parse failed")}</li>`).join("") +
        `</ul>`,
    );
    skippedTotal += rejected.length;
  }
  const subject = `Port fee: ${postedTotal} entered, ${skippedTotal} skipped`;
  const html = `<h2>Pier Pass / Port Check</h2>` + sections.join("");
  return {subject, html};
}

/** @type {Map<string, object>} Container lookup cache for one run. */
let loadCache = new Map();

/**
 * @return {void}
 */
function clearLoadCache() {
  loadCache = new Map();
}

/**
 * @param {string} invoiceNumber Vendor bill number.
 * @param {string} chargeCode TMF or CTF.
 * @param {string} container Container number.
 * @return {string}
 */
function pendingDocId(invoiceNumber, chargeCode, container) {
  return `${invoiceNumber}__${chargeCode}__${container}`
      .replace(/[^\w.-]+/g, "_");
}

/**
 * @return {FirebaseFirestore.CollectionReference|null}
 */
function pendingCollection() {
  if (typeof deps.pendingCollection !== "function") return null;
  return deps.pendingCollection();
}

/**
 * @param {Array<object>} rows Missing-load rows.
 * @return {{subject: string, html: string}}
 */
function buildMissingLoadEmail(rows) {
  const money = (n) => `$${Number(n || 0).toFixed(2)}`;
  const table = rows.map((row) =>
    `<tr>` +
    `<td style="padding:4px 10px">${escapeHtml(row.container)}</td>` +
    `<td style="padding:4px 10px">${escapeHtml(row.chargeCode)}</td>` +
    `<td style="padding:4px 10px">${escapeHtml(row.vendorName)}</td>` +
    `<td style="padding:4px 10px;text-align:right">${money(row.amount)}</td>` +
    `<td style="padding:4px 10px">${escapeHtml(row.invoiceNumber)}</td>` +
    `</tr>`).join("");
  const html =
    `<h2>Port fee loads to create</h2>` +
    `<p>These container numbers are not on a Primus load yet, so the ` +
    `port fee could not be entered. Please create the load. Jerry checks ` +
    `each morning and will enter the charge once the load exists.</p>` +
    `<table style="border-collapse:collapse;font-size:13px">` +
    `<tr><th style="text-align:left;padding:4px 10px">Container</th>` +
    `<th style="text-align:left;padding:4px 10px">Charge</th>` +
    `<th style="text-align:left;padding:4px 10px">Vendor</th>` +
    `<th style="text-align:right;padding:4px 10px">Amount</th>` +
    `<th style="text-align:left;padding:4px 10px">Bill #</th></tr>` +
    table +
    `</table>`;
  const subject = `Create Primus loads for ${rows.length} port fee` +
    `${rows.length === 1 ? "" : "s"}`;
  return {subject, html};
}

/**
 * Saves charges whose container has no load, and emails Josef and Leo
 * once per charge.
 * @param {Array<object>} summaries Per-invoice summaries.
 * @return {Promise<{fresh: Array<object>}>}
 */
async function rememberMissingLoads(summaries) {
  const col = pendingCollection();
  const fresh = [];
  const now = new Date().toISOString();
  for (const summary of summaries || []) {
    for (const row of summary.skipped || []) {
      if (row.reason !== SKIP_REASON.LOAD_NOT_FOUND) continue;
      const id = pendingDocId(
          summary.invoiceNumber, summary.chargeCode, row.container);
      let notifiedAt = null;
      if (col) {
        const snap = await col.doc(id).get();
        if (snap.exists) notifiedAt = (snap.data() || {}).notifiedAt || null;
        await col.doc(id).set({
          container: row.container,
          amount: row.amount,
          chargeCode: summary.chargeCode,
          description: summary.chargeCode,
          vendorName: summary.vendorName,
          vendorId: summary.vendorId || null,
          invoiceNumber: summary.invoiceNumber,
          invoiceDate: summary.invoiceDate,
          status: "pending",
          updatedAt: now,
          ...(snap.exists ? {} : {createdAt: now}),
        }, {merge: true});
      }
      if (!notifiedAt) {
        fresh.push({
          id,
          container: row.container,
          amount: row.amount,
          chargeCode: summary.chargeCode,
          vendorName: summary.vendorName,
          invoiceNumber: summary.invoiceNumber,
        });
      }
    }
  }
  if (fresh.length && typeof deps.saveOutboundEmail === "function") {
    const email = buildMissingLoadEmail(fresh);
    try {
      await deps.saveOutboundEmail({
        type: "port_fee_missing_load",
        subject: email.subject,
        html: email.html,
        to: MISSING_LOAD_TO,
        cc: MISSING_LOAD_CC,
        forceRecipient: true,
      });
      if (col) {
        for (const row of fresh) {
          await col.doc(row.id).set({notifiedAt: now}, {merge: true});
        }
      }
    } catch (err) {
      const log = deps.writeLog || (async () => {});
      await log("warn", "port-fee", "Missing-load email failed", {
        error: err && err.message,
        count: fresh.length,
      });
    }
  }
  return {fresh};
}

/**
 * @return {Promise<Array<object>>}
 */
async function listPendingRecords() {
  const col = pendingCollection();
  if (!col) return [];
  const snap = await col.where("status", "==", "pending").get();
  return snap.docs.map((doc) => ({id: doc.id, ...doc.data()}));
}

/**
 * Each morning: post any waiting port fee whose load now exists.
 * Does not email Josef and Leo again.
 * @return {Promise<object>}
 */
async function retryPendingPortFees() {
  const log = deps.writeLog || (async () => {});
  clearLoadCache();
  if (!deps.isManagePhpEnabled || !deps.isManagePhpEnabled()) {
    return {ok: false, error: "manage.php off"};
  }
  const pending = await listPendingRecords();
  let termsId = null;
  if (pending.length &&
      typeof deps.resolveDueOnReceiptTermId === "function") {
    const terms = await deps.resolveDueOnReceiptTermId();
    if (!terms || !terms.ok) {
      return {ok: false, error: (terms && terms.error) || "no terms"};
    }
    termsId = terms.termsId;
  }
  const posted = [];
  const stillMissing = [];
  const waiting = [];
  const col = pendingCollection();
  const now = new Date().toISOString();
  for (const row of pending) {
    const found = await findLoadByContainer(row.container);
    if (!found.ok) {
      stillMissing.push(row.container);
      if (col) {
        await col.doc(row.id).set({lastCheckedAt: now}, {merge: true});
      }
      continue;
    }
    let vendor = row.vendorId ?
      {id: row.vendorId, name: row.vendorName} : null;
    if (!vendor && typeof deps.resolveNamedVendor === "function") {
      vendor = await deps.resolveNamedVendor(row.vendorName);
    }
    const result = await deps.addPortFeeToLoad({
      loadNumber: found.loadNumber,
      booking: found.booking,
      amount: row.amount,
      chargeCode: row.chargeCode,
      description: row.description || row.chargeCode,
      vendor,
      vendorInvoiceNumber: row.invoiceNumber,
      billDate: row.invoiceDate,
      dueDate: row.invoiceDate,
      proNumber: row.container,
      termsId,
    });
    if (result && result.ok) {
      posted.push({
        container: row.container,
        loadNumber: found.loadNumber,
        chargeCode: row.chargeCode,
        invoiceNumber: row.invoiceNumber,
        already: !!result.skipped,
      });
      if (col) {
        await col.doc(row.id).set({
          status: "posted",
          loadNumber: found.loadNumber,
          postedAt: now,
          lastCheckedAt: now,
        }, {merge: true});
      }
      continue;
    }
    waiting.push({
      container: row.container,
      loadNumber: found.loadNumber,
      error: result && result.error,
    });
    if (col) {
      await col.doc(row.id).set({
        loadNumber: found.loadNumber,
        lastError: (result && result.error) || "not posted",
        lastCheckedAt: now,
      }, {merge: true});
    }
  }
  await log("info", "port-fee", "Pending port fees checked", {
    pending: pending.length,
    posted: posted.length,
    stillMissing: stillMissing.length,
    waiting: waiting.length,
  });
  if (posted.length && typeof deps.saveOutboundEmail === "function") {
    const lines = posted.map((row) =>
      `<li>${escapeHtml(row.chargeCode)} ${escapeHtml(row.container)} ` +
      `on load ${escapeHtml(row.loadNumber)} ` +
      `(bill ${escapeHtml(row.invoiceNumber)})</li>`).join("");
    await deps.saveOutboundEmail({
      type: "port_fee_pending_posted",
      subject: `Entered ${posted.length} port fee` +
        `${posted.length === 1 ? "" : "s"} after the load was created`,
      html: `<p>These charges were waiting for a Primus load. ` +
        `The load is there now, and the charge is entered.</p><ul>` +
        `${lines}</ul>`,
    });
  }
  return {ok: true, posted, stillMissing, waiting};
}

/**
 * @param {string} container Container number.
 * @return {Promise<object>}
 */
async function findLoadByContainer(container) {
  const key = String(container || "").toUpperCase();
  if (loadCache.has(key)) return loadCache.get(key);
  const found = await lookupLoadByContainer(key);
  loadCache.set(key, found);
  return found;
}

/**
 * @param {string} container Container number.
 * @return {Promise<object>}
 */
async function lookupLoadByContainer(container) {
  const search = deps.searchBookingsForTrackingQuery;
  const fetchBooking = deps.fetchPrimusBooking;
  if (typeof search !== "function") {
    throw new Error("container search is not configured");
  }
  const dateFrom = new Date(Date.now() - 540 * 24 * 60 * 60 * 1000);
  const rows = await search(container, {limit: 25, dateFrom});
  const picked = pickContainerMatch(rows, container);
  if (!picked.ok) return picked;
  let booking = null;
  if (typeof fetchBooking === "function") {
    booking = await fetchBooking(picked.loadNumber);
  }
  if (!booking) {
    return {ok: false, notFound: true};
  }
  return {
    ok: true,
    loadNumber: picked.loadNumber,
    booking,
    source: picked.source,
  };
}

/**
 * Reads PDFs and keeps only Pier Pass / Port Check invoices.
 * Caches bytes on the attachment so later intake can reuse them.
 * @param {object} opts attachments, downloadAttachment.
 * @return {Promise<{matches: Array, rejected: Array}>}
 */
async function sniffPdfAttachments(opts) {
  const attachments = (opts && opts.attachments) || [];
  const download = opts && opts.downloadAttachment;
  const matches = [];
  const rejected = [];
  if (typeof download !== "function") {
    return {matches, rejected};
  }
  for (const att of attachments) {
    if (!att) continue;
    const name = String(att.filename || "");
    const mime = String(att.mimeType || "");
    const isPdf = /\.pdf$/i.test(name) || mime === "application/pdf";
    if (!isPdf) continue;
    let buffer;
    try {
      buffer = await download(att);
    } catch (_) {
      continue;
    }
    if (!buffer) continue;
    const pages = await podUtils.extractPdfPageTexts(buffer);
    if (!pages || !pages.length) continue;
    const text = pages.join("\n");
    if (!detectPortFeeKind(text)) continue;
    const parsed = parsePortFeeInvoiceText(text, {filename: name});
    if (!parsed.ok) {
      rejected.push({
        filename: name,
        kind: parsed.kind || null,
        error: parsed.error || "parse failed",
      });
      continue;
    }
    matches.push(parsed.invoice);
  }
  return {matches, rejected};
}

/**
 * Posts parsed invoices and emails a reconciliation.
 * @param {object} opts invoices, rejected, from, subject, gmailMessageId.
 * @return {Promise<object>}
 */
async function processPortFeeEmail(opts) {
  const log = deps.writeLog || (async () => {});
  const invoices = (opts && opts.invoices) || [];
  const rejected = (opts && opts.rejected) || [];
  clearLoadCache();

  if (!opts || opts.dryRun) {
    return {handled: false, reason: "dry run"};
  }
  if (!deps.isManagePhpEnabled || !deps.isManagePhpEnabled()) {
    return {handled: false, reason: "manage.php off"};
  }
  if (typeof deps.addPortFeeToLoad !== "function") {
    return {handled: false, reason: "addPortFeeToLoad not configured"};
  }

  let termsId = null;
  let termsError = null;
  if (typeof deps.resolveDueOnReceiptTermId === "function") {
    try {
      const terms = await deps.resolveDueOnReceiptTermId();
      if (terms && terms.ok) termsId = terms.termsId;
      else termsError = (terms && terms.error) || "Due on receipt not found";
    } catch (err) {
      termsError = err && err.message;
    }
  } else {
    termsError = "terms lookup not configured";
  }

  const summaries = [];
  for (const invoice of invoices) {
    let vendor = null;
    let vendorError = null;
    if (termsId != null && typeof deps.resolveNamedVendor === "function") {
      try {
        vendor = await deps.resolveNamedVendor(invoice.vendorName);
      } catch (err) {
        vendorError = err && err.message;
      }
    }
    const counts = await applyPortFeeLines({
      invoice,
      vendor,
      termsId,
      findLoad: findLoadByContainer,
      postCharge: (charge) => deps.addPortFeeToLoad(charge),
    });
    if (vendorError) {
      for (const row of counts.skipped) {
        if (!row.error) row.error = vendorError;
      }
    }
    const summary = summarizeInvoice(invoice, counts);
    summary.vendorId = vendor && vendor.id || null;
    summaries.push(summary);
    await log("info", "port-fee", "Port fee invoice processed", {
      finalStatus: summary.skippedCount ? "port_fee_partial" :
        "port_fee_processed",
      invoiceNumber: invoice.invoiceNumber,
      chargeCode: invoice.chargeCode,
      vendorName: invoice.vendorName,
      postedCount: summary.postedCount,
      alreadyCount: summary.alreadyCount,
      skippedCount: summary.skippedCount,
      invoiceTotal: invoice.invoiceTotal,
      from: opts.from || null,
      subject: opts.subject || null,
      termsError,
    });
  }

  const missing = await rememberMissingLoads(summaries);
  const email = buildReconciliationEmail(summaries, rejected);
  if (missing.fresh.length) {
    email.html += `<p>Emailed Josef and Leo to create ` +
      `${missing.fresh.length} load(s). Jerry will enter those charges ` +
      `after the loads exist.</p>`;
  }
  if (typeof deps.saveOutboundEmail === "function") {
    await deps.saveOutboundEmail({
      type: "port_fee_reconciliation",
      subject: email.subject,
      html: email.html,
      gmailMessageId: opts.gmailMessageId || null,
    });
  }

  const postedCount = summaries.reduce((s, r) => s + r.postedCount, 0);
  const alreadyCount = summaries.reduce((s, r) => s + r.alreadyCount, 0);
  const skippedCount = summaries.reduce((s, r) => s + r.skippedCount, 0) +
    rejected.length;
  let finalStatus = "port_fee_processed";
  if (!invoices.length && rejected.length) finalStatus = "port_fee_failed";
  else if (postedCount + alreadyCount === 0) finalStatus = "port_fee_failed";
  else if (skippedCount > 0) finalStatus = "port_fee_partial";

  return {
    handled: true,
    finalStatus,
    postedCount,
    alreadyCount,
    skippedCount,
    summaries,
    termsError,
    missingLoads: missing.fresh,
  };
}

module.exports = {
  init,
  SKIP_REASON,
  CHARGE_PROFILES,
  detectPortFeeKind,
  parsePortFeeInvoiceText,
  parseContainerLines,
  pickContainerMatch,
  skipReasonText,
  applyPortFeeLines,
  summarizeInvoice,
  buildReconciliationEmail,
  sniffPdfAttachments,
  processPortFeeEmail,
  buildMissingLoadEmail,
  pendingDocId,
  rememberMissingLoads,
  retryPendingPortFees,
  MISSING_LOAD_TO,
  MISSING_LOAD_CC,
};
