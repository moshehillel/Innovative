"use strict";

/**
 * Twice-weekly report (Mon & Thu): shipments that Primus says should already
 * be delivered, but have no customer invoice. Emailed to Lisa only.
 *
 * "Should already be delivered" uses Primus tracking fields, not a custom
 * age heuristic:
 *   - delivered status POD / DLV
 *   - trackingDeliveredDate set
 *   - scheduled deliveryDate or dueDate (ETA) strictly before today
 *
 * "Not invoiced" uses Primus Invoiced / InvoiceNumbers / INVD status.
 */

const {parsePrimusDate} = require("./undelivered-shipment-report");
const podFollowup = require("./pod-followup");

const DELIVERED_STATUS_CODES = new Set(["POD", "DLV"]);
const INVOICED_STATUS_CODES = new Set(["INVD"]);
const CANCELLED_STATUS_CODES = new Set(["CRCN"]);

let deps = {};

/**
 * @param {object} bundle {writeLog, saveOutboundEmail, primusUiBridge}
 */
function init(bundle) {
  deps = bundle || {};
}
exports.init = init;

/**
 * Lisa / ops inbox used by other Jerry reports.
 * @return {string}
 */
function resolveLisaEmail() {
  return process.env.DELIVERED_UNINVOICED_REPORT_EMAIL ||
    process.env.ALERT_EMAIL ||
    process.env.LOW_PROFIT_CC_EMAIL ||
    podFollowup.LISA_EMAIL;
}
exports.resolveLisaEmail = resolveLisaEmail;

/**
 * @param {Date} d Date at local midnight.
 * @return {string} YYYY-MM-DD
 */
function isoDay(d) {
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * @param {Date} day Date at midnight.
 * @param {Date} today Today at midnight.
 * @return {number}
 */
function daysBetween(day, today) {
  return Math.floor(
      (today.getTime() - day.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * @param {object} row getBookingsForTracking row.
 * @return {boolean}
 */
function isCancelled(row) {
  const code = String(row && row.status_code || "").trim().toUpperCase();
  if (CANCELLED_STATUS_CODES.has(code)) return true;
  const name = String(row && row.status_name || "").trim().toUpperCase();
  return name.includes("CANCEL");
}
exports.isCancelled = isCancelled;

/**
 * Primus customer-invoice flag on the tracking list.
 * @param {object} row getBookingsForTracking row.
 * @return {boolean}
 */
function hasCustomerInvoice(row) {
  if (!row) return false;
  if (String(row.Invoiced || "") === "1") return true;
  const code = String(row.status_code || "").trim().toUpperCase();
  if (INVOICED_STATUS_CODES.has(code)) return true;
  const nums = String(row.InvoiceNumbers || "").trim();
  return !!(nums && nums !== "0" && nums.toLowerCase() !== "null");
}
exports.hasCustomerInvoice = hasCustomerInvoice;

/**
 * Primus delivered flag: POD, delivered-to-consignee, or tracking date.
 * @param {object} row getBookingsForTracking row.
 * @return {boolean}
 */
function hasDeliveredFlag(row) {
  if (!row) return false;
  const code = String(row.status_code || "").trim().toUpperCase();
  if (DELIVERED_STATUS_CODES.has(code)) return true;
  const trackingDel = String(row.trackingDeliveredDate || "").trim();
  return !!(trackingDel && trackingDel !== "00/00/00");
}
exports.hasDeliveredFlag = hasDeliveredFlag;

/**
 * Scheduled delivery / ETA date from Primus tracking.
 * @param {object} row getBookingsForTracking row.
 * @return {Date|null}
 */
function readScheduledDeliveryDate(row) {
  if (!row) return null;
  return parsePrimusDate(row.deliveryDate) || parsePrimusDate(row.dueDate);
}
exports.readScheduledDeliveryDate = readScheduledDeliveryDate;

/**
 * Actual delivered date when Primus recorded one.
 * @param {object} row getBookingsForTracking row.
 * @return {Date|null}
 */
function readActualDeliveredDate(row) {
  if (!row) return null;
  return parsePrimusDate(row.trackingDeliveredDate);
}

/**
 * True when Primus says this load should already be delivered.
 * @param {object} row getBookingsForTracking row.
 * @param {Date} today Midnight today.
 * @return {boolean}
 */
function shouldAlreadyBeDelivered(row, today) {
  if (hasDeliveredFlag(row)) return true;
  const scheduled = readScheduledDeliveryDate(row);
  if (!scheduled) return false;
  scheduled.setHours(0, 0, 0, 0);
  return scheduled < today;
}
exports.shouldAlreadyBeDelivered = shouldAlreadyBeDelivered;

/**
 * @param {object} row Tracking list row.
 * @return {string}
 */
function readDispatcherUser(row) {
  const dispatched = String(row.dispatchedByUser || "").trim();
  const createdBy = String(row.CreatedBy || "").trim();
  const controlledBy = String(row.controlledBy || "").trim();
  if (dispatched && !/^\d+$/.test(dispatched)) return dispatched;
  if (createdBy && !/^\d+$/.test(createdBy)) return createdBy;
  if (controlledBy && !/^\d+$/.test(controlledBy)) return controlledBy;
  return dispatched || createdBy || controlledBy;
}

/**
 * @param {object} row Tracking row.
 * @param {Date} today Midnight today.
 * @return {object}
 */
function normalizeRow(row, today) {
  const scheduled = readScheduledDeliveryDate(row);
  const actual = readActualDeliveredDate(row);
  const ageFrom = actual || scheduled;
  const daysPastDue = ageFrom ?
    daysBetween(new Date(ageFrom.getFullYear(), ageFrom.getMonth(),
        ageFrom.getDate()), today) :
    0;
  let reason = "past_delivery_date";
  const code = String(row.status_code || "").trim().toUpperCase();
  if (code === "POD") reason = "pod";
  else if (code === "DLV") reason = "delivered_to_consignee";
  else if (actual) reason = "tracking_delivered_date";

  return {
    loadNumber: String(row.BOL || row.bol || "").trim(),
    bookingId: row.id || null,
    pickupDate: isoDay(parsePrimusDate(row.pickupDate ||
      row.trackingPickupDate || row.estimatedPickupDate)) ||
      (row.pickupDate || row.trackingPickupDate || "—"),
    deliveryDate: isoDay(scheduled) || row.deliveryDate || row.dueDate || "—",
    trackingDeliveredDate: isoDay(actual) ||
      (row.trackingDeliveredDate || "—"),
    daysPastDue,
    reason,
    carrierName: row.carrierName || row.vendorName || row.carrierCode || "—",
    customerName: row.thirdPartyName || row.shipperName || "—",
    origin: [row.shipperCity, row.shipperState].filter(Boolean).join(", ") ||
      "—",
    destination: [row.consigneeCity, row.consigneeState].filter(Boolean)
        .join(", ") || "—",
    dispatcherUser: readDispatcherUser(row),
    statusName: row.status_name || row.status_code || "",
    statusCode: row.status_code || "",
  };
}

/**
 * @param {Array<object>} rows Tracking rows.
 * @return {Array<object>} Deduped by load number.
 */
function dedupeTrackingRows(rows) {
  const byBol = new Map();
  for (const row of rows || []) {
    const bol = String(row.BOL || "").trim();
    if (!bol) continue;
    if (!byBol.has(bol)) byBol.set(bol, row);
  }
  return [...byBol.values()];
}

/**
 * @param {Array<object>} rows Deduped tracking rows.
 * @param {Date} [now] Clock override for tests.
 * @return {Array<object>}
 */
function filterDeliveredUninvoiced(rows, now) {
  const today = now ? new Date(now) : new Date();
  today.setHours(0, 0, 0, 0);
  const out = [];
  for (const row of rows || []) {
    if (isCancelled(row)) continue;
    if (hasCustomerInvoice(row)) continue;
    if (!shouldAlreadyBeDelivered(row, today)) continue;
    const bol = String(row.BOL || row.bol || "").trim();
    if (!bol) continue;
    out.push(normalizeRow(row, today));
  }
  out.sort((a, b) => b.daysPastDue - a.daysPastDue ||
    String(a.loadNumber).localeCompare(String(b.loadNumber)));
  return out;
}
exports.filterDeliveredUninvoiced = filterDeliveredUninvoiced;

/**
 * @param {string} text Raw text.
 * @return {string}
 */
function esc(text) {
  return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
}

/**
 * @param {string} reason Internal reason key.
 * @return {string}
 */
function reasonLabel(reason) {
  if (reason === "pod") return "Delivered (POD)";
  if (reason === "delivered_to_consignee") return "Delivered to consignee";
  if (reason === "tracking_delivered_date") return "Tracking delivered date";
  return "Past delivery date / ETA";
}

/**
 * @param {object} opts Report options.
 * @param {Array<object>} opts.shipments Shipment rows.
 * @return {object} {subject, html}
 */
function buildLisaReportEmail(opts) {
  const shipments = opts.shipments || [];
  const rows = shipments.map((s) =>
    `<tr>` +
    `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">` +
    `${esc(s.loadNumber)}</td>` +
    `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">` +
    `${esc(s.pickupDate)}</td>` +
    `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">` +
    `${esc(s.deliveryDate)}</td>` +
    `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">` +
    `${esc(s.trackingDeliveredDate)}</td>` +
    `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">` +
    `${esc(s.statusName)}</td>` +
    `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">` +
    `${esc(s.daysPastDue)} days</td>` +
    `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">` +
    `${esc(reasonLabel(s.reason))}</td>` +
    `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">` +
    `${esc(s.carrierName)}</td>` +
    `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">` +
    `${esc(s.customerName)}</td>` +
    `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">` +
    `${esc(s.origin)} → ${esc(s.destination)}</td>` +
    `</tr>`,
  ).join("");

  const table = shipments.length ?
    `<table style="border-collapse:collapse;font-size:13px;width:100%;` +
    `max-width:1100px;margin:12px 0">` +
    `<thead><tr style="background:#f3f4f6">` +
    `<th style="padding:6px 10px;text-align:left">Load #</th>` +
    `<th style="padding:6px 10px;text-align:left">Pickup</th>` +
    `<th style="padding:6px 10px;text-align:left">Delivery / ETA</th>` +
    `<th style="padding:6px 10px;text-align:left">Delivered</th>` +
    `<th style="padding:6px 10px;text-align:left">Status</th>` +
    `<th style="padding:6px 10px;text-align:left">Age</th>` +
    `<th style="padding:6px 10px;text-align:left">Why included</th>` +
    `<th style="padding:6px 10px;text-align:left">Carrier</th>` +
    `<th style="padding:6px 10px;text-align:left">Customer</th>` +
    `<th style="padding:6px 10px;text-align:left">Lane</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>` :
    `<p>No matching shipments in this window.</p>`;

  const html =
    `<p>Hi Lisa,</p>` +
    `<p>The following <strong>${shipments.length}</strong> shipment(s) are ` +
    `supposed to be delivered in ShipPrimus (delivered status, tracking ` +
    `delivered date, or a delivery date / ETA already in the past) but ` +
    `<strong>have no customer invoice</strong>.</p>` +
    table +
    `<p style="color:#6b7280;font-size:12px">This is an automated report ` +
    `from Jerry (sent Monday and Thursday). It does not email customers ` +
    `or change extra-charge handling.</p>`;

  return {
    subject: shipments.length ?
      `Jerry — ${shipments.length} shipment(s) delivered / past due, ` +
        `not invoiced` :
      "Jerry — no delivered/past-due shipments waiting on invoice",
    html,
  };
}
exports.buildLisaReportEmail = buildLisaReportEmail;

/**
 * Runs the delivered-but-not-invoiced report.
 * @param {object} [opts] dryRun, lookbackDays, now
 * @return {Promise<object>}
 */
async function runDeliveredUninvoicedReport(opts) {
  const log = deps.writeLog || (async () => {});
  const saveOutboundEmail = deps.saveOutboundEmail;
  const bridge = deps.primusUiBridge;
  const dryRun = !!(opts && opts.dryRun);
  const lookbackDays = Number(
      (opts && opts.lookbackDays) ||
      process.env.DELIVERED_UNINVOICED_REPORT_LOOKBACK_DAYS ||
      process.env.UNDELIVERED_REPORT_LOOKBACK_DAYS ||
      180,
  );
  const now = opts && opts.now ? new Date(opts.now) : new Date();
  const to = resolveLisaEmail();

  if (!bridge || typeof bridge.fetchBookingsForTracking !== "function") {
    return {ok: false, error: "fetchBookingsForTracking not configured"};
  }
  if (!bridge.isManagePhpEnabled || !bridge.isManagePhpEnabled()) {
    return {ok: false, error: "manage.php off"};
  }

  const dateTo = new Date(now);
  const dateFrom = new Date(now);
  dateFrom.setDate(dateFrom.getDate() - lookbackDays);

  const rawRows = await bridge.fetchBookingsForTracking({dateFrom, dateTo});
  if (!Array.isArray(rawRows)) {
    return {ok: false, error: "getBookingsForTracking returned invalid data"};
  }
  if (!rawRows.length) {
    return {
      ok: false,
      error: "getBookingsForTracking returned no rows (Primus session or API)",
    };
  }
  const deduped = dedupeTrackingRows(rawRows);
  const matches = filterDeliveredUninvoiced(deduped, now);
  const mail = buildLisaReportEmail({shipments: matches});

  if (!dryRun && typeof saveOutboundEmail === "function") {
    await saveOutboundEmail({
      type: "delivered_uninvoiced_report",
      subject: mail.subject,
      html: mail.html,
      forceRecipient: true,
      to,
    });
  }

  await log("info", "report",
      "Delivered-uninvoiced shipment report completed", {
        scanned: deduped.length,
        matches: matches.length,
        lookbackDays,
        dryRun,
        to,
      });

  return {
    ok: true,
    dryRun,
    scanned: deduped.length,
    rawRows: rawRows.length,
    matches: matches.length,
    loads: matches.map((s) => s.loadNumber),
    emailedTo: dryRun ? null : to,
  };
}
exports.runDeliveredUninvoicedReport = runDeliveredUninvoicedReport;
