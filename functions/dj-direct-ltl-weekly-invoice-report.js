"use strict";

/**
 * Every Monday: CSV of DJ Direct LTL customer invoices Jerry issued in the
 * prior calendar week (Mon–Sun). Emails Abe + Lisa with the CSV attached.
 */

const admin = require("firebase-admin");

const DEFAULT_TO =
  "abe@innovativecarriers.com,Lisa@innovativecarriers.com";

let deps = {};

/**
 * @param {object} bundle {db, writeLog, saveOutboundEmail, tcol, runWithTenant,
 *   DEFAULT_TENANT}
 */
function init(bundle) {
  deps = bundle || {};
}
exports.init = init;

/**
 * @return {string}
 */
function resolveRecipients() {
  return String(
      process.env.DJ_DIRECT_LTL_REPORT_EMAIL || DEFAULT_TO)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .join(",");
}
exports.resolveRecipients = resolveRecipients;

/**
 * @param {string} name Customer name from Firestore.
 * @return {boolean}
 */
function isDjDirectLtlCustomer(name) {
  const n = String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  if (!n) return false;
  if (n === "dj direct ltl" || n === "dj direct") return true;
  return n.startsWith("dj direct ltl");
}
exports.isDjDirectLtlCustomer = isDjDirectLtlCustomer;

/**
 * @param {object} inv Invoice doc.
 * @return {boolean}
 */
function isIssuedCustomerInvoice(inv) {
  if (!inv) return false;
  if (inv.customerInvoiceId) return true;
  if (inv.issuedInvoiceNumber) return true;
  const steps = inv.primusSteps || {};
  return !!(steps.uiInvoiceIssued || steps.customerInvoiceGenerated);
}
exports.isIssuedCustomerInvoice = isIssuedCustomerInvoice;

/**
 * Calendar YYYY-MM-DD at 00:00 America/New_York → Date.
 * @param {number} y
 * @param {number} m 1-12
 * @param {number} d
 * @return {Date}
 */
function nyDateMidnight(y, m, d) {
  const probe = new Date(Date.UTC(y, m - 1, d, 17, 0, 0));
  const offsetParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  }).formatToParts(probe);
  const tzName = (offsetParts.find((p) => p.type === "timeZoneName") ||
    {}).value || "GMT-5";
  const match = /GMT([+-]\d+)(?::(\d+))?/.exec(tzName);
  const hours = match ? Number(match[1]) : -5;
  const mins = match && match[2] ? Number(match[2]) : 0;
  const offsetMin = hours * 60 + Math.sign(hours || 1) * mins;
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMin * 60 * 1000);
}

/**
 * Prior Mon 00:00 through this Mon 00:00 (exclusive), America/New_York.
 * @param {Date} [now]
 * @return {{start: Date, end: Date, label: string}}
 */
function priorWeekWindow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  const weekdayIndex = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  }[get("weekday")];
  const daysSinceMonday = (weekdayIndex + 6) % 7;
  const thisMondayDay = d - daysSinceMonday;
  const thisMonday = new Date(Date.UTC(y, m - 1, thisMondayDay));
  const priorMonday = new Date(thisMonday);
  priorMonday.setUTCDate(priorMonday.getUTCDate() - 7);
  const start = nyDateMidnight(
      priorMonday.getUTCFullYear(),
      priorMonday.getUTCMonth() + 1,
      priorMonday.getUTCDate());
  const end = nyDateMidnight(
      thisMonday.getUTCFullYear(),
      thisMonday.getUTCMonth() + 1,
      thisMonday.getUTCDate());
  const label =
    `${isoDayNy(start)} to ${isoDayNy(new Date(end.getTime() - 1000))}`;
  return {start, end, label};
}
exports.priorWeekWindow = priorWeekWindow;

/**
 * @param {Date} d
 * @return {string} YYYY-MM-DD in America/New_York
 */
function isoDayNy(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * @param {*} value
 * @return {string}
 */
function csvEscapeCell(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, "\"\"")}"`;
  return s;
}

/**
 * @param {*} value Amount.
 * @return {number|null} Rounded to cents, or null when not a number.
 */
function cents(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/**
 * Accessorial lines Jerry billed the customer on their own invoice lines
 * (approved option A, B or E). Option F sets the customer rate itself.
 * @param {object} inv Invoice doc.
 * @return {Array<{name: string, amount: number}>}
 */
function customerAccessorialLines(inv) {
  const ac = (inv && inv.additionalCharge) || {};
  const decision = String(ac.decision || "").toUpperCase();
  if (!["A", "B", "E"].includes(decision)) return [];
  const lines = Array.isArray(ac.customerBillLines) ?
    ac.customerBillLines : [];
  return lines.map((line) => ({
    name: String((line && (line.name || line.label ||
      line.description)) || "Accessorial").trim(),
    amount: cents(line && line.amount),
  })).filter((line) => line.amount != null && line.amount > 0);
}

/**
 * One CSV row with only what is on the invoice the customer receives
 * (Lisa, Nov 12: no carrier cost or other internal fields).
 * @param {object} inv
 * @return {object}
 */
function rowFromInvoice(inv) {
  const freight = inv.freightDetails || {};
  const emailMeta = inv.customerInvoiceEmail || {};
  const freightCharge = cents(inv.customerRate);
  const accessorials = customerAccessorialLines(inv);
  const accessorialTotal = accessorials
      .reduce((sum, line) => sum + line.amount, 0);
  const total = freightCharge != null || accessorials.length ?
    cents((freightCharge || 0) + accessorialTotal) : null;
  const issued = inv.updatedAt && typeof inv.updatedAt.toDate === "function" ?
    inv.updatedAt.toDate() :
    (inv.updatedAt instanceof Date ? inv.updatedAt : null);
  return {
    invoiceDate: issued ? isoDayNy(issued) : "",
    customerInvoiceNumber: inv.issuedInvoiceNumber ||
      emailMeta.invoiceNumber || "",
    loadNumber: inv.loadNumber || "",
    customerName: inv.customerName || "",
    poNumber: inv.poNumber || "",
    shipmentReference: inv.shipmentReference || "",
    proNumber: inv.proNumber || "",
    pieces: freight.pieces != null ? freight.pieces : "",
    weightLbs: freight.totalWeightLbs != null ? freight.totalWeightLbs : "",
    freightClass: freight.freightClass || "",
    freightCharge: freightCharge != null ? freightCharge.toFixed(2) : "",
    accessorials: accessorials
        .map((line) => `${line.name} $${line.amount.toFixed(2)}`)
        .join("; "),
    accessorialTotal: accessorials.length ?
      cents(accessorialTotal).toFixed(2) : "",
    invoiceTotal: total != null ? total.toFixed(2) : "",
  };
}

exports.rowFromInvoice = rowFromInvoice;

const CSV_HEADERS = [
  "Invoice Date",
  "Invoice #",
  "Load / BOL #",
  "Customer",
  "PO #",
  "Shipment Reference",
  "PRO #",
  "Pieces",
  "Weight (lbs)",
  "Freight Class",
  "Freight Charge",
  "Accessorial Charges",
  "Accessorial Total",
  "Invoice Total",
];

/**
 * @param {Array<object>} rows
 * @return {string}
 */
function buildCsv(rows) {
  const lines = [CSV_HEADERS.map(csvEscapeCell).join(",")];
  for (const row of rows) {
    lines.push([
      row.invoiceDate,
      row.customerInvoiceNumber,
      row.loadNumber,
      row.customerName,
      row.poNumber,
      row.shipmentReference,
      row.proNumber,
      row.pieces,
      row.weightLbs,
      row.freightClass,
      row.freightCharge,
      row.accessorials,
      row.accessorialTotal,
      row.invoiceTotal,
    ].map(csvEscapeCell).join(","));
  }
  return `\uFEFF${lines.join("\n")}\n`;
}
exports.buildCsv = buildCsv;

/**
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @param {Date} [opts.now]
 * @param {boolean} [opts.sample] Treat as sample email subject.
 * @return {Promise<object>}
 */
async function runDjDirectLtlWeeklyReport(opts = {}) {
  const dryRun = !!opts.dryRun;
  const sample = !!opts.sample;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const window = priorWeekWindow(now);
  const writeLog = deps.writeLog || (async () => undefined);
  const saveOutboundEmail = deps.saveOutboundEmail;
  const db = deps.db || admin.firestore();
  const tcol = deps.tcol;
  const runWithTenant = deps.runWithTenant;
  const tenant = deps.DEFAULT_TENANT;

  const collect = async () => {
    const col = tcol ? tcol(tenant, "invoices") : db.collection("invoices");
    const snap = await col
        .where("updatedAt", ">=", window.start)
        .where("updatedAt", "<", window.end)
        .orderBy("updatedAt", "asc")
        .get();
    const rows = [];
    snap.forEach((doc) => {
      const inv = doc.data() || {};
      if (!isDjDirectLtlCustomer(inv.customerName)) return;
      if (!isIssuedCustomerInvoice(inv)) return;
      rows.push(rowFromInvoice(inv));
    });
    return rows;
  };

  let rows;
  if (typeof runWithTenant === "function" && tenant) {
    rows = await runWithTenant(tenant, collect);
  } else {
    rows = await collect();
  }

  const csv = buildCsv(rows);
  const filename =
    `dj-direct-ltl-invoices-${isoDayNy(window.start)}_to_` +
    `${isoDayNy(new Date(window.end.getTime() - 1000))}.csv`;
  const to = resolveRecipients();
  const subject = sample ?
    `Sample — DJ Direct LTL weekly invoices (${window.label})` :
    `DJ Direct LTL weekly invoices (${window.label})`;
  const html =
    `<p>Attached is the CSV of DJ Direct LTL customer invoices issued ` +
    `${window.label} (${rows.length} invoice` +
    `${rows.length === 1 ? "" : "s"}).</p>` +
    `<p>Each row has only what is on the customer invoice: invoice and ` +
    `load numbers, references, freight details, the freight charge, ` +
    `each accessorial, and the invoice total.</p>` +
    (sample ?
      `<p>This is a one-time sample. Going forward Jerry emails this every ` +
      `Monday for the prior week.</p>` : "");

  await writeLog("info", "report", "DJ Direct LTL weekly invoice report", {
    dryRun,
    sample,
    count: rows.length,
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    label: window.label,
  });

  if (dryRun || !saveOutboundEmail) {
    return {
      ok: true,
      dryRun: true,
      count: rows.length,
      window,
      filename,
      to,
      subject,
      rows,
      csv,
    };
  }

  const contentBase64 = Buffer.from(csv, "utf8").toString("base64");
  const sendResult = await saveOutboundEmail({
    type: "dj_direct_ltl_weekly_invoices",
    forceRecipient: true,
    to,
    subject,
    html,
    attachments: [{
      filename,
      contentType: "text/csv; charset=utf-8",
      contentBase64,
    }],
  });

  // saveOutboundEmail never throws on a transport failure; it records
  // {ok:false,error} on the outbound doc. Surface it so a failed send is a
  // loud failure instead of a silent "ok".
  if (!sendResult || sendResult.ok !== true || sendResult.parked) {
    const error = (sendResult && sendResult.error) ||
      (sendResult && sendResult.parked ?
        "Email was parked instead of sent" :
        "Email send did not report success");
    await writeLog("error", "report",
        "DJ Direct LTL weekly invoice email was NOT sent", {
          error,
          to,
          subject,
        });
    return {
      ok: false,
      error,
      dryRun: false,
      count: rows.length,
      window,
      filename,
      to,
      subject,
      rows,
    };
  }

  return {
    ok: true,
    dryRun: false,
    count: rows.length,
    window,
    filename,
    to,
    subject,
    rows,
  };
}
exports.runDjDirectLtlWeeklyReport = runDjDirectLtlWeeklyReport;
