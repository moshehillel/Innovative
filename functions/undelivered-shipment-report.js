"use strict";

/**
 * Weekly report: shipments with pickup > N days ago and no delivery date,
 * grouped by dispatcher and emailed to each dispatcher.
 */

let deps = {};

/**
 * @param {object} bundle {writeLog, saveOutboundEmail, primusUiBridge}
 */
function init(bundle) {
  deps = bundle || {};
}
exports.init = init;

/**
 * @param {string|number|null|undefined} raw Date from Primus UI.
 * @return {Date|null}
 */
function parsePrimusDate(raw) {
  const s = String(raw || "").trim();
  if (!s || s === "0000-00-00" || s === "00/00/00") return null;
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (slash) {
    let year = Number(slash[3]);
    if (year < 100) year += 2000;
    const d = new Date(year, Number(slash[1]) - 1, Number(slash[2]));
    return isNaN(d.getTime()) ? null : d;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s.replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}
exports.parsePrimusDate = parsePrimusDate;

/**
 * @param {object} row getBookingsForTracking row.
 * @return {boolean}
 */
function hasDeliveryDate(row) {
  const trackingDel = row && row.trackingDeliveredDate;
  if (trackingDel && String(trackingDel).trim() &&
      trackingDel !== "00/00/00") {
    return true;
  }
  const delivery = row && row.deliveryDate;
  return !!(delivery && String(delivery).trim() &&
    delivery !== "0000-00-00" && delivery !== "00/00/00");
}

/**
 * @param {object} row getBookingsForTracking row.
 * @return {Date|null}
 */
function readPickupDate(row) {
  const candidates = [
    row && row.pickupDate,
    row && row.trackingPickupDate,
    row && row.estimatedPickupDate,
  ];
  for (const raw of candidates) {
    const d = parsePrimusDate(raw);
    if (d) return d;
  }
  return null;
}

/**
 * @param {object} row Tracking list row.
 * @return {object}
 */
function normalizeTrackingRow(row) {
  const pickupDate = readPickupDate(row);
  const bol = String(row.BOL || row.bol || "").trim();
  return {
    loadNumber: bol,
    bookingId: row.id || null,
    pickupDate: pickupDate ? pickupDate.toISOString().slice(0, 10) : null,
    pickupDateRaw: row.pickupDate || row.trackingPickupDate ||
      row.estimatedPickupDate || null,
    carrierName: row.carrierName || row.vendorName || row.carrierCode || "—",
    customerName: row.thirdPartyName || row.shipperName || "—",
    origin: [row.shipperCity, row.shipperState].filter(Boolean).join(", ") ||
      "—",
    destination: [row.consigneeCity, row.consigneeState].filter(Boolean)
        .join(", ") || "—",
    dispatcherUser: String(row.dispatchedByUser || row.controlledBy || "")
        .trim(),
    statusName: row.status_name || row.status_code || "",
  };
}

/**
 * @param {Array<object>} rows Raw tracking rows (deduped).
 * @param {number} minDays Minimum days since pickup (default 14).
 * @return {Array<object>}
 */
function filterStaleUndelivered(rows, minDays) {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - Number(minDays || 14));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const out = [];
  for (const row of rows || []) {
    if (hasDeliveryDate(row)) continue;
    const pickupDate = readPickupDate(row);
    if (!pickupDate) continue;
    const pickupDay = new Date(pickupDate);
    pickupDay.setHours(0, 0, 0, 0);
    if (pickupDay > cutoff) continue;

    const normalized = normalizeTrackingRow(row);
    const daysSincePickup = Math.floor(
        (today.getTime() - pickupDay.getTime()) / (24 * 60 * 60 * 1000));
    out.push({...normalized, daysSincePickup});
  }
  out.sort((a, b) => b.daysSincePickup - a.daysSincePickup);
  return out;
}
exports.filterStaleUndelivered = filterStaleUndelivered;

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
 * @param {object} row Normalized shipment row.
 * @param {Map<string, object>} [cache] Dispatcher lookup cache.
 * @return {Promise<object>}
 */
async function resolveDispatcherForRow(row, cache) {
  const bridge = deps.primusUiBridge;
  if (!bridge || typeof bridge.resolveDispatcherEmail !== "function") {
    return {ok: false, error: "dispatcher lookup not configured"};
  }
  const userName = row.dispatcherUser;
  if (!userName) {
    return {ok: false, error: "no dispatcher on shipment"};
  }
  const cacheKey = userName.toLowerCase();
  if (cache && cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }
  const result = await bridge.resolveDispatcherEmail({
    booking: {
      dispatchedByUser: userName,
      userName,
      contactInformation: {
        controlUser: {name: userName},
      },
    },
  });
  if (cache) cache.set(cacheKey, result);
  return result;
}

/**
 * @param {Array<object>} shipments Normalized stale shipments.
 * @return {Promise<Map<string, {email: string, displayName: string,
 *   shipments: Array<object>}>>}
 */
async function groupByDispatcherEmail(shipments) {
  const groups = new Map();
  const unknown = [];
  const dispatcherCache = new Map();

  for (const ship of shipments) {
    let dispatcher;
    try {
      dispatcher = await resolveDispatcherForRow(ship, dispatcherCache);
    } catch (err) {
      dispatcher = {ok: false, error: err.message};
    }

    if (!dispatcher.ok || !dispatcher.email) {
      unknown.push({
        ...ship,
        dispatcherLookupError: dispatcher.error || "no email",
        dispatcherUser: ship.dispatcherUser || dispatcher.userName || "—",
      });
      continue;
    }

    const key = dispatcher.email.toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, {
        email: dispatcher.email,
        displayName: dispatcher.displayName || dispatcher.userName || "",
        shipments: [],
      });
    }
    groups.get(key).shipments.push({
      ...ship,
      dispatcherName: dispatcher.displayName || dispatcher.userName,
    });
  }

  if (unknown.length) {
    groups.set("__unknown__", {
      email: null,
      displayName: "Unknown dispatcher",
      shipments: unknown,
    });
  }
  return groups;
}

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
 * @param {object} opts Report options.
 * @param {string} opts.displayName Dispatcher name.
 * @param {Array<object>} opts.shipments Shipment rows.
 * @param {number} opts.minDays Threshold days.
 * @return {object} {subject, html}
 */
function buildDispatcherReportEmail(opts) {
  const shipments = opts.shipments || [];
  const minDays = Number(opts.minDays || 14);
  const name = opts.displayName || "there";
  const rows = shipments.map((s) =>
    `<tr>` +
    `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">` +
    `${esc(s.loadNumber)}</td>` +
    `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">` +
    `${esc(s.pickupDate || s.pickupDateRaw || "—")}</td>` +
    `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">` +
    `${esc(s.daysSincePickup)} days</td>` +
    `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">` +
    `${esc(s.carrierName)}</td>` +
    `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">` +
    `${esc(s.customerName)}</td>` +
    `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">` +
    `${esc(s.origin)} → ${esc(s.destination)}</td>` +
    `</tr>`,
  ).join("");

  const html =
    `<p>Hi ${esc(name)},</p>` +
    `<p>The following <strong>${shipments.length}</strong> shipment(s) have ` +
    `a pickup date more than <strong>${minDays} days</strong> ago but no ` +
    `delivery date recorded in ShipPrimus. Please review and update status ` +
    `or follow up with the carrier.</p>` +
    `<table style="border-collapse:collapse;font-size:13px;width:100%;` +
    `max-width:960px;margin:12px 0">` +
    `<thead><tr style="background:#f3f4f6">` +
    `<th style="padding:6px 10px;text-align:left">Load #</th>` +
    `<th style="padding:6px 10px;text-align:left">Pickup</th>` +
    `<th style="padding:6px 10px;text-align:left">Age</th>` +
    `<th style="padding:6px 10px;text-align:left">Carrier</th>` +
    `<th style="padding:6px 10px;text-align:left">Customer</th>` +
    `<th style="padding:6px 10px;text-align:left">Lane</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>` +
    `<p style="color:#6b7280;font-size:12px">This is an automated weekly ` +
    `report from Jerry.</p>`;

  return {
    subject: `Weekly report — ${shipments.length} shipment(s) missing ` +
      `delivery date (${minDays}+ days since pickup)`,
    html,
  };
}

/**
 * Runs the undelivered shipment report for all stale loads.
 * @param {object} [opts] dryRun, minDays, lookbackDays
 * @return {Promise<object>}
 */
async function runUndeliveredShipmentReport(opts) {
  const log = deps.writeLog || (async () => {});
  const saveOutboundEmail = deps.saveOutboundEmail;
  const bridge = deps.primusUiBridge;
  const dryRun = !!(opts && opts.dryRun);
  const minDays = Number(
      (opts && opts.minDays) ||
      process.env.UNDELIVERED_REPORT_MIN_DAYS ||
      14,
  );
  const lookbackDays = Number(
      (opts && opts.lookbackDays) ||
      process.env.UNDELIVERED_REPORT_LOOKBACK_DAYS ||
      180,
  );

  if (!bridge || typeof bridge.fetchBookingsForTracking !== "function") {
    return {ok: false, error: "fetchBookingsForTracking not configured"};
  }
  if (!bridge.isManagePhpEnabled || !bridge.isManagePhpEnabled()) {
    return {ok: false, error: "manage.php off"};
  }

  const dateTo = new Date();
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - lookbackDays);

  const rawRows = await bridge.fetchBookingsForTracking({dateFrom, dateTo});
  const deduped = dedupeTrackingRows(rawRows);
  const stale = filterStaleUndelivered(deduped, minDays);
  const groups = await groupByDispatcherEmail(stale);

  const sent = [];
  const skipped = [];
  const fallbackEmail = process.env.UNDELIVERED_REPORT_FALLBACK_EMAIL ||
    process.env.ALERT_EMAIL ||
    process.env.LOW_PROFIT_CC_EMAIL ||
    null;

  for (const [key, group] of groups.entries()) {
    const email = group.email ||
      (key === "__unknown__" ? fallbackEmail : null);
    if (!email) {
      skipped.push({
        key,
        count: group.shipments.length,
        reason: "no dispatcher email and no fallback",
      });
      continue;
    }

    const mail = buildDispatcherReportEmail({
      displayName: group.displayName,
      shipments: group.shipments,
      minDays,
    });

    if (!dryRun && typeof saveOutboundEmail === "function") {
      await saveOutboundEmail({
        type: "undelivered_shipment_report",
        subject: mail.subject,
        html: mail.html,
        forceRecipient: true,
        to: email,
      });
    }

    sent.push({
      to: email,
      displayName: group.displayName,
      count: group.shipments.length,
      dryRun,
      loads: group.shipments.map((s) => s.loadNumber),
    });
  }

  await log("info", "report", "Undelivered shipment report completed", {
    scanned: deduped.length,
    stale: stale.length,
    dispatchers: sent.length,
    minDays,
    lookbackDays,
    dryRun,
    sent,
    skipped,
  });

  return {
    ok: true,
    dryRun,
    scanned: deduped.length,
    rawRows: rawRows.length,
    stale: stale.length,
    staleLoads: stale.map((s) => s.loadNumber),
    sent,
    skipped,
  };
}
exports.runUndeliveredShipmentReport = runUndeliveredShipmentReport;

exports._internal = {
  hasDeliveryDate,
  readPickupDate,
  dedupeTrackingRows,
  buildDispatcherReportEmail,
};
