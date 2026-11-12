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
 * @param {FirebaseFirestore.Timestamp|Date|string|null} value
 * @return {string}
 */
function tsIso(value) {
  if (!value) return "";
  if (typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * @param {object} inv
 * @param {string} firestoreId
 * @return {object}
 */
function rowFromInvoice(inv, firestoreId) {
  const freight = inv.freightDetails || {};
  const emailMeta = inv.customerInvoiceEmail || {};
  return {
    issuedAt: tsIso(inv.updatedAt),
    customerInvoiceNumber: inv.issuedInvoiceNumber ||
      emailMeta.invoiceNumber || "",
    customerInvoiceId: inv.customerInvoiceId ||
      emailMeta.customerInvoiceId || "",
    loadNumber: inv.loadNumber || "",
    customerName: inv.customerName || "",
    carrierName: inv.carrierName || "",
    carrierInvoiceNumber: inv.invoiceNumber || "",
    carrierInvoiceDate: inv.invoiceDate || "",
    proNumber: inv.proNumber || "",
    shipmentReference: inv.shipmentReference || "",
    poNumber: inv.poNumber || "",
    pieces: freight.pieces != null ? freight.pieces : "",
    weightLbs: freight.totalWeightLbs != null ? freight.totalWeightLbs : "",
    freightClass: freight.freightClass || "",
    customerAmount: inv.customerRate != null ? inv.customerRate : "",
    carrierAmount: inv.invoiceAmount != null ? inv.invoiceAmount : "",
    profit: inv.profit != null ? inv.profit : "",
    workflowStatus: inv.finalWorkflowStatus || "",
    firestoreInvoiceId: firestoreId || "",
  };
}

const CSV_HEADERS = [
  "Issued At (UTC)",
  "Customer Invoice #",
  "Primus Customer Invoice Id",
  "Load / BOL",
  "Customer Name",
  "Carrier Name",
  "Carrier Invoice #",
  "Carrier Invoice Date",
  "PRO #",
  "Shipment Reference",
  "PO #",
  "Pieces",
  "Weight (lbs)",
  "Freight Class",
  "Customer Amount",
  "Carrier Amount",
  "Profit",
  "Workflow Status",
  "Firestore Invoice Id",
];

/**
 * @param {Array<object>} rows
 * @return {string}
 */
function buildCsv(rows) {
  const lines = [CSV_HEADERS.map(csvEscapeCell).join(",")];
  for (const row of rows) {
    lines.push([
      row.issuedAt,
      row.customerInvoiceNumber,
      row.customerInvoiceId,
      row.loadNumber,
      row.customerName,
      row.carrierName,
      row.carrierInvoiceNumber,
      row.carrierInvoiceDate,
      row.proNumber,
      row.shipmentReference,
      row.poNumber,
      row.pieces,
      row.weightLbs,
      row.freightClass,
      row.customerAmount,
      row.carrierAmount,
      row.profit,
      row.workflowStatus,
      row.firestoreInvoiceId,
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
      rows.push(rowFromInvoice(inv, doc.id));
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
    `<p>Columns mirror the Jerry / Primus invoice fields Jerry has on file ` +
    `(load, invoice numbers, carrier, amounts, freight details).</p>` +
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
