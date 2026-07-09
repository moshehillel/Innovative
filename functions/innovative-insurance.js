/**
 * Innovative Carriers — insurance premium allocation.
 *
 * A Redkik-style insurance invoice arrives as two parts:
 *   1. A PDF that states the single amount the broker actually owes (the
 *      invoice total).
 *   2. An Excel workbook with one row per insured shipment, each carrying the
 *      per-shipment premium and (usually) a tracking / BOL number.
 *
 * This module reconciles the two and decides what to post to Primus:
 *   - Every Excel row that HAS a resolvable BOL gets its premium posted to that
 *     load (via an injected `postPremiumToLoad` adapter so this file stays
 *     decoupled from the manage.php bridge).
 *   - Rows we cannot post (no BOL, load not found in Primus, or the post
 *     itself failed) are NOT allowed to block the rest of the batch. They are
 *     collected and reported in a reconciliation email that spells out exactly
 *     how many premiums were added, how many were not, the dollar sums on each
 *     side, and the precise reason each skipped row was left out.
 *
 * Business rule (ops): post what we can, email the rest with exact detail.
 *
 * The functions here are pure/injectable so they can be unit-tested and run as
 * a dry run (see scripts/insurance-allocate.js) without touching Primus.
 */

"use strict";

/**
 * Header keyword matchers used to locate columns without hard-coding order.
 * The first column whose header matches any regex for a field wins.
 * @type {Object<string, RegExp[]>}
 */
const COLUMN_MATCHERS = {
  carrier: [/carrier/i, /vendor/i, /scac/i],
  tracking: [/tracking/i, /\bpro\b/i, /\bbol\b/i, /reference/i, /\bload\b/i],
  description: [/description/i, /notes?/i, /detail/i, /memo/i, /commodity/i],
  amount: [/premium/i, /\bamount\b/i, /\btotal\b/i, /\bcost\b/i, /charge/i,
    /price/i],
};

/**
 * Positional fallback used when header names cannot be matched. These indices
 * come from the observed Redkik "Innovative Carriers" workbook layout.
 * @type {Object<string, number>}
 */
const FALLBACK_COLUMNS = {carrier: 5, tracking: 7, description: 15, amount: 25};

/** Money tolerance (cents) when comparing sums. @type {number} */
const MONEY_EPSILON = 0.005;

/**
 * Machine reason codes for rows that could not be posted.
 * @enum {string}
 */
const SKIP_REASON = {
  NO_BOL: "NO_BOL",
  LOAD_NOT_FOUND: "LOAD_NOT_FOUND",
  ZERO_AMOUNT: "ZERO_AMOUNT",
  POST_FAILED: "POST_FAILED",
};

/**
 * Human-readable explanation for each skip reason.
 * @param {string} code One of SKIP_REASON.
 * @param {object} [ctx] Extra context (bol, error).
 * @return {string}
 */
function skipReasonText(code, ctx = {}) {
  switch (code) {
    case SKIP_REASON.NO_BOL:
      return "No BOL / tracking number on the Excel row — nothing to match " +
        "to a Primus load.";
    case SKIP_REASON.LOAD_NOT_FOUND:
      return `BOL ${ctx.bol || "(unknown)"} did not match any load in ` +
        "Primus.";
    case SKIP_REASON.ZERO_AMOUNT:
      return "Premium amount is zero or unreadable on the Excel row.";
    case SKIP_REASON.POST_FAILED:
      return "Premium could not be posted to Primus" +
        (ctx.error ? `: ${ctx.error}` : ".");
    default:
      return "Unknown reason.";
  }
}

/**
 * @param {number} amount Raw money value.
 * @return {number} Rounded to cents.
 */
function roundMoney(amount) {
  return Math.round(Number(amount || 0) * 100) / 100;
}

/**
 * @param {number} a First amount.
 * @param {number} b Second amount.
 * @return {boolean} True when a and b are equal within one cent.
 */
function moneyEquals(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) <= MONEY_EPSILON;
}

/**
 * Parses a currency-ish cell into a number.
 * @param {*} value Raw cell value.
 * @return {number}
 */
function parseAmount(value) {
  if (typeof value === "number") return roundMoney(value);
  const cleaned = String(value == null ? "" : value)
      .replace(/[^0-9.-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? roundMoney(n) : 0;
}

/**
 * Minimal HTML escaper for email content.
 * @param {*} value Raw string.
 * @return {string}
 */
function escapeHtml(value) {
  return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
}

/**
 * Locates the field columns from the header row, falling back to known
 * positional indices when a header cannot be matched by name.
 * @param {Array<*>} headerRow First row of the sheet.
 * @return {Object<string, number>} Map of field -> column index.
 */
function detectColumns(headerRow) {
  const header = Array.isArray(headerRow) ? headerRow : [];
  const cols = {};
  for (const field of Object.keys(COLUMN_MATCHERS)) {
    const matchers = COLUMN_MATCHERS[field];
    let found = -1;
    for (let i = 0; i < header.length; i++) {
      const cell = String(header[i] == null ? "" : header[i]);
      if (matchers.some((re) => re.test(cell))) {
        found = i;
        break;
      }
    }
    cols[field] = found >= 0 ? found : FALLBACK_COLUMNS[field];
  }
  return cols;
}

/**
 * Extracts a BOL / load number from a row's tracking or description cells.
 * @param {Array<*>} row Sheet row.
 * @param {Object<string, number>} cols Column map from detectColumns.
 * @return {string} BOL digits, or "" when none is present.
 */
function extractBol(row, cols) {
  const track = String(row[cols.tracking] == null ? "" : row[cols.tracking]);
  const desc = String(
      row[cols.description] == null ? "" : row[cols.description]);
  const match = track.match(/(\d{5,})/) ||
    desc.match(/BOL#?\s*:?\s*(\d{5,})/i) ||
    desc.match(/\b(\d{6,})\b/);
  return match ? match[1] : "";
}

/**
 * Parses the per-shipment insurance Excel into normalized rows.
 * @param {Buffer|string} input Workbook buffer or a file path.
 * @return {{columns: Object<string, number>, rows: Array<object>}}
 */
function parseInsuranceExcel(input) {
  // Required lazily so the module can load without xlsx present (e.g. tests
  // that only exercise the allocation logic).
  const XLSX = require("xlsx");
  const wb = Buffer.isBuffer(input) ?
    XLSX.read(input, {type: "buffer"}) :
    XLSX.readFile(input);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(ws, {header: 1, defval: ""});
  if (!grid.length) return {columns: {}, rows: []};

  const columns = detectColumns(grid[0]);
  const rows = [];
  for (let i = 1; i < grid.length; i++) {
    const raw = grid[i];
    if (!raw || raw.every((c) => String(c == null ? "" : c).trim() === "")) {
      continue;
    }
    const amount = parseAmount(raw[columns.amount]);
    const carrier = String(raw[columns.carrier] == null ?
      "" : raw[columns.carrier]).trim();
    // Skip fully blank trailing rows that carry neither carrier nor amount.
    if (!carrier && amount === 0) continue;
    rows.push({
      rowIndex: i + 1,
      bol: extractBol(raw, columns),
      carrier,
      amount,
      description: String(raw[columns.description] == null ?
        "" : raw[columns.description]).trim(),
    });
  }
  return {columns, rows};
}

/**
 * Best-effort extraction of the invoice header fields from the PDF text.
 * @param {Buffer|string} input PDF buffer or a file path.
 * @return {Promise<{vendorName: string, invoiceNumber: string,
 *   invoiceTotal: number, invoiceDate: string, rawText: string}>}
 */
async function parseInsuranceInvoicePdf(input) {
  const fs = require("fs");
  const bytes = Buffer.isBuffer(input) ?
    new Uint8Array(input) :
    new Uint8Array(fs.readFileSync(input));
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({data: bytes}).promise;
  let text = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(" ") + "\n";
  }

  const totals = [...text.matchAll(/\$?\s*([\d,]+\.\d{2})/g)]
      .map((m) => parseAmount(m[1]))
      .filter((n) => n > 0);
  // The invoice total is the largest money figure on a Redkik statement.
  const invoiceTotal = totals.length ? Math.max(...totals) : 0;
  const invNumMatch = text.match(/invoice\s*#?\s*:?\s*(\w[\w-]*)/i);
  const dateMatch = text.match(
      /(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/);
  const vendorMatch = text.match(/\b(Redkik[\w,.\s]*?)(?:\n|Invoice|$)/i);

  return {
    vendorName: vendorMatch ? vendorMatch[1].trim() : "",
    invoiceNumber: invNumMatch ? invNumMatch[1] : "",
    invoiceTotal,
    invoiceDate: dateMatch ? dateMatch[1] : "",
    rawText: text,
  };
}

/**
 * Splits parsed rows into those that can be posted (have a BOL and a non-zero
 * amount) and those that cannot, without performing any I/O.
 * @param {Array<object>} rows Rows from parseInsuranceExcel.
 * @return {{addable: Array<object>, skipped: Array<object>}}
 */
function classifyRows(rows) {
  const addable = [];
  const skipped = [];
  for (const row of rows) {
    if (row.amount <= 0) {
      skipped.push({...row, reason: SKIP_REASON.ZERO_AMOUNT});
    } else if (!row.bol) {
      skipped.push({...row, reason: SKIP_REASON.NO_BOL});
    } else {
      addable.push(row);
    }
  }
  return {addable, skipped};
}

/**
 * Sums the `amount` field of a list of rows.
 * @param {Array<object>} rows Rows with numeric `amount`.
 * @return {number}
 */
function sumAmounts(rows) {
  return roundMoney(rows.reduce((s, r) => s + Number(r.amount || 0), 0));
}

/**
 * Posts each addable premium via the injected adapter, moving any failures
 * into the skipped bucket with a precise reason.
 * @param {object} opts Options.
 * @param {Array<object>} opts.addable Rows eligible to post.
 * @param {function(object): Promise<object>} [opts.postPremiumToLoad] Adapter
 *   returning `{ok, loadNumber?, error?, notFound?}`. When omitted, this is a
 *   dry run and every addable row is treated as posted.
 * @return {Promise<{posted: Array<object>, failed: Array<object>}>}
 */
async function applyPremiums(opts) {
  const {addable, postPremiumToLoad} = opts;
  const posted = [];
  const failed = [];
  for (const row of addable) {
    if (typeof postPremiumToLoad !== "function") {
      posted.push({...row, dryRun: true});
      continue;
    }
    let result;
    try {
      result = await postPremiumToLoad(row);
    } catch (err) {
      result = {ok: false, error: err && err.message};
    }
    if (result && result.ok) {
      posted.push({...row, loadNumber: result.loadNumber || null});
    } else if (result && result.notFound) {
      failed.push({...row, reason: SKIP_REASON.LOAD_NOT_FOUND});
    } else {
      failed.push({
        ...row,
        reason: SKIP_REASON.POST_FAILED,
        error: (result && result.error) || "unknown error",
      });
    }
  }
  return {posted, failed};
}

/**
 * Builds the reconciliation summary from the posted/skipped buckets.
 * @param {object} opts Options.
 * @param {number} opts.invoiceTotal Total the PDF says is owed.
 * @param {Array<object>} opts.allRows All parsed Excel rows.
 * @param {Array<object>} opts.posted Rows successfully posted.
 * @param {Array<object>} opts.skipped Rows not posted (any reason).
 * @return {object}
 */
function buildReconciliation(opts) {
  const {invoiceTotal, allRows, posted, skipped} = opts;
  const postedSum = sumAmounts(posted);
  const skippedSum = sumAmounts(skipped);
  const excelSum = sumAmounts(allRows);
  return {
    invoiceTotal: roundMoney(invoiceTotal),
    excelSum,
    excelRowCount: allRows.length,
    postedCount: posted.length,
    postedSum,
    skippedCount: skipped.length,
    skippedSum,
    postedPlusSkipped: roundMoney(postedSum + skippedSum),
    // Posted premiums should reconcile to the invoice total the broker billed.
    matchesInvoice: moneyEquals(postedSum, invoiceTotal),
    invoiceVsPosted: roundMoney(invoiceTotal - postedSum),
    // Posted + skipped should reconcile to the full Excel sum (nothing lost).
    accountsForAllRows: moneyEquals(postedSum + skippedSum, excelSum),
  };
}

/**
 * Renders the internal reconciliation email (ops-facing; may contain carrier
 * detail since it never goes to a customer).
 * @param {object} opts Options.
 * @param {object} opts.reconciliation Output of buildReconciliation.
 * @param {Array<object>} opts.skipped Skipped rows (with `reason`).
 * @param {object} [opts.invoice] {vendorName, invoiceNumber, invoiceDate}.
 * @return {{subject: string, html: string}}
 */
function buildReconciliationEmail(opts) {
  const {reconciliation: rec, skipped, invoice = {}} = opts;
  const vendor = invoice.vendorName || "Insurance vendor";
  const invNo = invoice.invoiceNumber ? ` #${invoice.invoiceNumber}` : "";

  const money = (n) => `$${Number(n || 0).toFixed(2)}`;
  const skippedRowsHtml = skipped.length ?
    skipped.map((r) =>
      `<tr>` +
      `<td style="padding:4px 12px;border-bottom:1px solid #eee">` +
      `${escapeHtml(r.carrier || "—")}</td>` +
      `<td style="padding:4px 12px;border-bottom:1px solid #eee">` +
      `${escapeHtml(r.bol || "(none)")}</td>` +
      `<td style="padding:4px 12px;border-bottom:1px solid #eee;` +
      `text-align:right">${money(r.amount)}</td>` +
      `<td style="padding:4px 12px;border-bottom:1px solid #eee">` +
      `Row ${r.rowIndex}</td>` +
      `<td style="padding:4px 12px;border-bottom:1px solid #eee">` +
      `${escapeHtml(skipReasonText(r.reason, r))}</td>` +
      `</tr>`).join("") :
    `<tr><td colspan="5" style="padding:8px 12px;color:#16a34a">` +
      `Every premium was posted — nothing skipped.</td></tr>`;

  const reconLine = rec.matchesInvoice ?
    `<span style="color:#16a34a;font-weight:700">` +
      `Posted premiums match the invoice total exactly.</span>` :
    `<span style="color:#dc2626;font-weight:700">` +
      `Posted premiums are ${money(Math.abs(rec.invoiceVsPosted))} ` +
      `${rec.invoiceVsPosted > 0 ? "under" : "over"} the invoice total — ` +
      `review before paying.</span>`;

  const html =
    `<h2>Insurance premium reconciliation — ${escapeHtml(vendor)}` +
    `${escapeHtml(invNo)}</h2>` +
    `<p>${reconLine}</p>` +
    `<table style="border-collapse:collapse;font-size:14px;margin:12px 0">` +
    `<tr><td style="padding:4px 16px 4px 0">Invoice total (PDF)</td>` +
    `<td style="font-weight:700">${money(rec.invoiceTotal)}</td></tr>` +
    `<tr><td style="padding:4px 16px 4px 0">Premiums posted</td>` +
    `<td style="font-weight:700">${rec.postedCount} ` +
    `(${money(rec.postedSum)})</td></tr>` +
    `<tr><td style="padding:4px 16px 4px 0">Premiums NOT posted</td>` +
    `<td style="font-weight:700">${rec.skippedCount} ` +
    `(${money(rec.skippedSum)})</td></tr>` +
    `<tr><td style="padding:4px 16px 4px 0">Excel total (all rows)</td>` +
    `<td>${money(rec.excelSum)} across ${rec.excelRowCount} rows</td></tr>` +
    `</table>` +
    `<h3>Rows not posted (${rec.skippedCount})</h3>` +
    `<table style="border-collapse:collapse;font-size:13px;min-width:640px">` +
    `<thead><tr>` +
    `<th style="padding:4px 12px;text-align:left;border-bottom:2px solid ` +
    `#ccc">Carrier</th>` +
    `<th style="padding:4px 12px;text-align:left;border-bottom:2px solid ` +
    `#ccc">BOL</th>` +
    `<th style="padding:4px 12px;text-align:right;border-bottom:2px solid ` +
    `#ccc">Premium</th>` +
    `<th style="padding:4px 12px;text-align:left;border-bottom:2px solid ` +
    `#ccc">Excel</th>` +
    `<th style="padding:4px 12px;text-align:left;border-bottom:2px solid ` +
    `#ccc">Why not posted</th>` +
    `</tr></thead><tbody>${skippedRowsHtml}</tbody></table>`;

  const subject = `Insurance reconciliation — ${vendor}${invNo}: ` +
    `${rec.postedCount} posted, ${rec.skippedCount} skipped`;
  return {subject, html};
}

/**
 * End-to-end allocation: classify → post what we can → reconcile → email.
 * @param {object} opts Options.
 * @param {Array<object>} opts.rows Parsed Excel rows.
 * @param {number} opts.invoiceTotal Invoice total from the PDF.
 * @param {object} [opts.invoice] Invoice header fields for the email.
 * @param {function(object): Promise<object>} [opts.postPremiumToLoad] Adapter;
 *   omit for a dry run.
 * @return {Promise<{posted: Array, skipped: Array, reconciliation: object,
 *   email: {subject: string, html: string}}>}
 */
async function allocateInsurancePremiums(opts) {
  const {rows, invoiceTotal, invoice, postPremiumToLoad} = opts;
  const {addable, skipped: preSkipped} = classifyRows(rows);
  const {posted, failed} = await applyPremiums({addable, postPremiumToLoad});
  const skipped = preSkipped.concat(failed);
  const reconciliation = buildReconciliation({
    invoiceTotal, allRows: rows, posted, skipped,
  });
  const email = buildReconciliationEmail({reconciliation, skipped, invoice});
  return {posted, skipped, reconciliation, email};
}

// Injected from index.js via init() so this file stays decoupled.
let deps = {};

/**
 * Receives shared helpers from index.js.
 * @param {object} bundle {writeLog, saveOutboundEmail, fetchPrimusBooking,
 *   addInsurancePremiumToLoad, isManagePhpEnabled}.
 * @return {void}
 */
function init(bundle) {
  deps = bundle || {};
}

/** File extensions treated as the per-shipment premium spreadsheet. */
const SPREADSHEET_EXT = /\.(xlsx|xlsm|xls|csv)$/i;

/**
 * @param {Array<object>} attachments Attachment metadata (filename, mimeType).
 * @return {object|null} The first spreadsheet attachment, or null.
 */
function findSpreadsheetAttachment(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  return list.find((a) => a && (
    SPREADSHEET_EXT.test(String(a.filename || "")) ||
    /spreadsheet|excel|csv/i.test(String(a.mimeType || "")))) || null;
}

/**
 * @param {Array<object>} attachments Attachment metadata.
 * @return {object|null} The first PDF attachment, or null.
 */
function findPdfAttachment(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  return list.find((a) => a && (
    /\.pdf$/i.test(String(a.filename || "")) ||
    String(a.mimeType || "") === "application/pdf")) || null;
}

/**
 * Redkik insurance invoices arrive via QuickBooks notification email.
 * @type {string}
 */
const INSURANCE_FROM_EMAIL =
  process.env.INSURANCE_EMAIL_FROM ||
  "quickbooks@notification.intuit.com";

/**
 * Pulls the bare address from a From header value.
 * @param {string} from Raw From header.
 * @return {string}
 */
function extractFromEmail(from) {
  const raw = String(from || "").trim();
  const bracketed = raw.match(/<([^>]+)>/);
  if (bracketed) return bracketed[1].trim().toLowerCase();
  const bare = raw.match(/[\w.+-]+@[\w.-]+\.\w+/);
  return bare ? bare[0].toLowerCase() : raw.toLowerCase();
}

/**
 * Insurance intake is keyed off the QuickBooks sender only. All other
 * senders follow the regular carrier / forward-to-human flow.
 * @param {object} opts {from}.
 * @return {boolean}
 */
function isInsuranceEmail(opts) {
  const fromEmail = extractFromEmail(opts && opts.from);
  return fromEmail === INSURANCE_FROM_EMAIL.toLowerCase();
}

/**
 * Full insurance intake: parse the spreadsheet + invoice PDF, post every
 * premium that has a BOL, and email the reconciliation (posted vs skipped).
 *
 * @param {object} opts Options.
 * @param {Buffer} opts.excelBuffer The premium spreadsheet bytes.
 * @param {Buffer} [opts.pdfBuffer] The invoice PDF bytes.
 * @param {string} [opts.from] Sender (for logging).
 * @param {string} [opts.subject] Subject (for logging).
 * @param {boolean} [opts.dryRun] Skip posting to Primus when true.
 * @return {Promise<object>} {handled, reconciliation?, reason?}
 */
async function processInsuranceEmail(opts) {
  const {
    writeLog, saveOutboundEmail, fetchPrimusBooking,
    addInsurancePremiumToLoad, isManagePhpEnabled,
  } = deps;
  const log = writeLog || (async () => {});

  if (!opts || !opts.excelBuffer) {
    return {handled: false, reason: "no spreadsheet buffer"};
  }
  if (!opts.dryRun && (!isManagePhpEnabled || !isManagePhpEnabled())) {
    return {handled: false, reason: "manage.php off"};
  }

  const {rows} = parseInsuranceExcel(opts.excelBuffer);
  if (!rows.length) {
    return {handled: false, reason: "no rows parsed from spreadsheet"};
  }

  let invoice = {};
  let invoiceTotal = 0;
  if (opts.pdfBuffer) {
    try {
      invoice = await parseInsuranceInvoicePdf(opts.pdfBuffer);
      invoiceTotal = invoice.invoiceTotal || 0;
    } catch (err) {
      await log("warn", "insurance", "Invoice PDF parse failed", {
        error: err && err.message,
      });
    }
  }

  const billDate = invoice.invoiceDate || new Date();
  const vendorInvoiceNumber = invoice.invoiceNumber ||
    `REDKIK-${roundMoney(new Date(billDate).getTime())}`;

  const postPremiumToLoad = opts.dryRun ? undefined :
    createInsurancePostAdapter({
      fetchPrimusBooking,
      addInsurancePremiumToLoad,
      vendorInvoiceNumber,
      billDate,
    });

  const result = await allocateInsurancePremiums({
    rows, invoiceTotal, invoice, postPremiumToLoad,
  });

  if (typeof saveOutboundEmail === "function") {
    await saveOutboundEmail({
      type: "insurance_reconciliation",
      subject: result.email.subject,
      html: result.email.html,
    });
  }

  await log("info", "insurance", "Insurance premiums allocated", {
    from: opts.from || null,
    subject: opts.subject || null,
    vendorInvoiceNumber,
    ...result.reconciliation,
  });

  return {handled: true, reconciliation: result.reconciliation, invoice};
}

module.exports = {
  COLUMN_MATCHERS,
  FALLBACK_COLUMNS,
  SKIP_REASON,
  skipReasonText,
  roundMoney,
  moneyEquals,
  parseAmount,
  detectColumns,
  extractBol,
  parseInsuranceExcel,
  parseInsuranceInvoicePdf,
  classifyRows,
  sumAmounts,
  applyPremiums,
  buildReconciliation,
  buildReconciliationEmail,
  allocateInsurancePremiums,
  init,
  findSpreadsheetAttachment,
  findPdfAttachment,
  extractFromEmail,
  isInsuranceEmail,
  processInsuranceEmail,
};

/**
 * Builds a postPremiumToLoad adapter for allocateInsurancePremiums that
 * resolves the load in Primus REST and posts via manage.php close-cost flow.
 *
 * @param {object} deps
 * @param {function(string): Promise<object|null>} deps.fetchPrimusBooking
 * @param {function(object): Promise<object>} deps.addInsurancePremiumToLoad
 * @param {string} deps.vendorInvoiceNumber Redkik invoice number for all rows.
 * @param {string|Date} deps.billDate Insurance invoice date.
 * @param {string|Date} [deps.billDueDate] Insurance due date.
 * @return {function(object): Promise<object>}
 */
function createInsurancePostAdapter(deps) {
  const {
    fetchPrimusBooking,
    addInsurancePremiumToLoad,
    vendorInvoiceNumber,
    billDate,
    billDueDate,
  } = deps;

  return async function postPremiumToLoad(row) {
    const loadNumber = String(row.bol || "").trim();
    if (!loadNumber) {
      return {ok: false, error: "missing bol"};
    }
    let booking;
    try {
      booking = await fetchPrimusBooking(loadNumber);
    } catch (err) {
      return {ok: false, error: err && err.message};
    }
    if (!booking) {
      return {ok: false, notFound: true};
    }
    const result = await addInsurancePremiumToLoad({
      booking,
      loadNumber,
      premium: row.amount,
      vendorInvoiceNumber,
      billDate,
      billDueDate,
    });
    if (result.notFound) {
      return {ok: false, notFound: true, error: result.error};
    }
    if (!result.ok) {
      return {
        ok: false,
        error: result.error || result.step || "post failed",
      };
    }
    return {
      ok: true,
      loadNumber: result.loadNumber,
      skipped: !!result.skipped,
    };
  };
}

module.exports.createInsurancePostAdapter = createInsurancePostAdapter;
