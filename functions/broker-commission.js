"use strict";

/**
 * Low-margin broker commission rules:
 * - Karen Adams: never change her rate.
 * - Other brokers with a 10% Primus variant: swap when margin < 10%.
 * - No 10% variant: email Lisa and continue invoicing.
 */

const KAREN_ADAMS_UI_IDS = new Set(["2140"]);
const KAREN_NAME_PATTERN = /^karen\s+adams/i;
const CATALOG_TTL_MS = 60 * 60 * 1000;

let deps = {};
let catalogCache = null;
let catalogCacheAt = 0;

/**
 * @param {object} bundle Dependencies:
 *   writeLog, saveOutboundEmail, workflowErrors, primusUiBridge,
 *   fetchPrimusBooking, checkProfitMargin, readCustomerRateFromAcct
 */
function init(bundle) {
  deps = bundle || {};
}
exports.init = init;

/**
 * @param {string} name Display or person name.
 * @return {string}
 */
function stripRateSuffix(name) {
  return String(name || "")
      .replace(/\s*\.\d+\s*$/i, "")
      .replace(/\s*\d+(\.\d+)?%\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
}

/**
 * @param {object} row Corporate sales person row.
 * @return {string}
 */
function normalizeRepKey(row) {
  const email = String(row.email || "").trim().toLowerCase();
  if (email) return `email:${email}`;
  const fn = String(row.firstName || "").trim().toLowerCase();
  const ln = String(row.lastName || "").trim().toLowerCase();
  if (fn || ln) return `name:${fn}|${ln}`;
  return `display:${stripRateSuffix(row.display || row.name || "")}`;
}

/**
 * @param {object} row Sales rep row from catalog or booking.
 * @return {boolean}
 */
function isKarenAdams(row) {
  if (!row) return false;
  const id = String(row.id || row.salesPersonId || "");
  if (KAREN_ADAMS_UI_IDS.has(id)) return true;
  const display = String(row.display || "").trim() ||
    `${row.firstName || ""} ${row.lastName || ""}`.trim();
  return KAREN_NAME_PATTERN.test(display);
}

/**
 * @param {Array<object>} rows Corporate sales people from manage.php.
 * @return {object}
 */
function buildCatalogIndex(rows) {
  const byId = new Map();
  const byKey = new Map();
  for (const row of rows || []) {
    const id = String(row.id || row.salesPersonId || "");
    if (!id) continue;
    byId.set(id, row);
    const key = normalizeRepKey(row);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  return {byId, byKey, rows: rows || []};
}

/**
 * @return {Promise<object>}
 */
async function loadCatalog() {
  const bridge = deps.primusUiBridge;
  if (!bridge || typeof bridge.fetchAllCorporateSalesPeople !== "function") {
    throw new Error("Primus sales catalog not configured");
  }
  const now = Date.now();
  if (catalogCache && (now - catalogCacheAt) < CATALOG_TTL_MS) {
    return catalogCache;
  }
  const rows = await bridge.fetchAllCorporateSalesPeople();
  catalogCache = buildCatalogIndex(rows);
  catalogCacheAt = now;
  return catalogCache;
}

/**
 * @param {string|number} currentRepId UI salesPersonId on the load.
 * @param {object} catalog Indexed catalog.
 * @return {object|null}
 */
function findTenPctVariant(currentRepId, catalog) {
  const current = catalog.byId.get(String(currentRepId));
  if (!current) return null;
  const family = catalog.byKey.get(normalizeRepKey(current)) || [current];
  return family.find((row) => Number(row.percentage) === 10) || null;
}

/**
 * @param {object} row Catalog row for the current rep.
 * @return {boolean}
 */
function isAlreadyTenPctRow(row) {
  return !!row && Number(row.percentage) === 10;
}

/**
 * @param {string} loadNumber Load/BOL number.
 * @param {object} booking Primus REST booking (optional).
 * @return {Promise<{bookingId: string, salesReps: Array<object>}>}
 */
async function resolveBookingSalesReps(loadNumber, booking) {
  const bridge = deps.primusUiBridge;
  let resolvedBooking = booking;
  if (!resolvedBooking && deps.fetchPrimusBooking) {
    resolvedBooking = await deps.fetchPrimusBooking(loadNumber);
  }
  const bookingId = bridge && bridge.resolveManageBookingId ?
    bridge.resolveManageBookingId(resolvedBooking) : "";
  if (!bookingId || !bridge ||
      typeof bridge.getBookingSalesRep !== "function") {
    return {bookingId: bookingId || "", salesReps: []};
  }
  const salesReps = await bridge.getBookingSalesRep(bookingId);
  return {bookingId, salesReps: Array.isArray(salesReps) ? salesReps : []};
}

/**
 * @param {object} opts
 * @param {string} opts.loadNumber
 * @param {number} opts.margin
 * @param {number} [opts.profit]
 * @param {string} [opts.brokerName]
 * @param {string} [opts.carrierName]
 * @param {object} [opts.booking] Primus REST booking when already loaded.
 * @param {string} [opts.trigger] Context label for logs (e.g. insurance).
 * @return {Promise<object>}
 */
async function adjustBrokerCommissionForLowMargin(opts) {
  const loadNumber = opts && opts.loadNumber ?
    String(opts.loadNumber) : "";
  const margin = Number(opts && opts.margin || 0);
  const profit = Number(opts && opts.profit || 0);
  const brokerName = opts && opts.brokerName ?
    String(opts.brokerName).trim() : "";
  const carrierName = opts && opts.carrierName || "";
  const trigger = opts && opts.trigger || "invoice_intake";

  const log = deps.writeLog || (async () => {});

  if (!loadNumber || margin >= 10) {
    return {adjusted: false, notified: false, reason: "margin_ok"};
  }

  if (!deps.primusUiBridge ||
      typeof deps.primusUiBridge.isManagePhpEnabled !== "function" ||
      !deps.primusUiBridge.isManagePhpEnabled()) {
    await log("info", "primus",
        "Low margin — broker commission adjust skipped (manage.php off)", {
          loadNumber, margin, profit, trigger,
        });
    return {adjusted: false, notified: false, reason: "manage_php_off"};
  }

  let catalog;
  try {
    catalog = await loadCatalog();
  } catch (err) {
    await log("warn", "primus", "Broker catalog load failed", {
      loadNumber, error: err.message, trigger,
    });
    return {adjusted: false, notified: false, reason: "catalog_failed"};
  }

  const {bookingId, salesReps} = await resolveBookingSalesReps(
      loadNumber, opts && opts.booking);
  if (!salesReps.length) {
    await log("info", "primus", "Low margin — no sales rep on load", {
      loadNumber, margin, profit, bookingId: bookingId || null, trigger,
    });
    return {adjusted: false, notified: false, reason: "no_sales_rep"};
  }

  const primaryRep = salesReps[0];
  const currentRepId = String(primaryRep.salesPersonId || "");
  const currentCatalogRow = catalog.byId.get(currentRepId);
  const resolvedBrokerName = brokerName ||
    (primaryRep.display || "") ||
    (currentCatalogRow && currentCatalogRow.display) ||
    "Unknown broker";

  if (isKarenAdams(currentCatalogRow || primaryRep)) {
    await log("info", "primus",
        "Low margin — Karen Adams exempt from commission swap", {
          loadNumber, margin, profit, brokerName: resolvedBrokerName, trigger,
        });
    return {adjusted: false, notified: false, reason: "karen_exempt"};
  }

  if (isAlreadyTenPctRow(currentCatalogRow)) {
    return {adjusted: false, notified: false, reason: "already_ten_pct"};
  }

  const tenPctRow = findTenPctVariant(currentRepId, catalog);
  if (!tenPctRow) {
    await notifyLisaNoTenPct({
      loadNumber,
      margin,
      profit,
      brokerName: resolvedBrokerName,
      carrierName,
      trigger,
    });
    return {adjusted: false, notified: true, reason: "no_10pct_code"};
  }

  if (!bookingId) {
    await log("warn", "primus",
        "Low margin — cannot swap rep without manage booking id", {
          loadNumber, margin, tenPctId: tenPctRow.id, trigger,
        });
    await notifyLisaNoTenPct({
      loadNumber,
      margin,
      profit,
      brokerName: resolvedBrokerName,
      carrierName,
      trigger,
      note: "Could not resolve Primus booking id for sales-rep swap.",
    });
    return {adjusted: false, notified: true, reason: "no_booking_id"};
  }

  const swapResult = await deps.primusUiBridge.swapBookingSalesRep({
    bookingId,
    tenPctRow,
    removedReps: salesReps,
  });

  if (swapResult.ok) {
    await log("info", "primus", "Broker commission swapped to 10%", {
      loadNumber,
      margin,
      profit,
      fromRepId: currentRepId,
      fromRepName: resolvedBrokerName,
      toRepId: tenPctRow.id,
      toRepName: tenPctRow.display,
      trigger,
    });
    return {
      adjusted: true,
      notified: false,
      reason: "swapped",
      fromRepId: currentRepId,
      toRepId: String(tenPctRow.id),
    };
  }

  await log("warn", "primus", "Broker 10% swap failed", {
    loadNumber,
    margin,
    profit,
    brokerName: resolvedBrokerName,
    tenPctId: tenPctRow.id,
    error: swapResult.error || null,
    trigger,
  });
  await notifyLisaSwapFailed({
    loadNumber,
    margin,
    profit,
    brokerName: resolvedBrokerName,
    carrierName,
    tenPctName: tenPctRow.display || tenPctRow.id,
    error: swapResult.error,
    trigger,
  });
  return {adjusted: false, notified: true, reason: "swap_failed"};
}
exports.adjustBrokerCommissionForLowMargin = adjustBrokerCommissionForLowMargin;

/**
 * @param {object} opts Notification context.
 * @return {Promise<void>}
 */
async function notifyLisaNoTenPct(opts) {
  const workflowErrors = deps.workflowErrors;
  const saveOutboundEmail = deps.saveOutboundEmail;
  if (!workflowErrors || !saveOutboundEmail) return;

  const alert = workflowErrors.buildWorkflowAlertEmail({
    code: "BROKER_NO_10PCT_CODE",
    context: {
      loadNumber: opts.loadNumber,
      marginPct: opts.margin,
      profit: opts.profit,
      brokerName: opts.brokerName || "Unknown broker",
      carrierName: opts.carrierName,
      note: opts.note || null,
    },
  });
  await saveOutboundEmail({
    type: "broker_no_10pct_code",
    subject: alert.subject,
    html: alert.html,
    forceRecipient: true,
    to: lisaEmail(),
  });
}

/**
 * @param {object} opts Notification context.
 * @return {Promise<void>}
 */
async function notifyLisaSwapFailed(opts) {
  const workflowErrors = deps.workflowErrors;
  const saveOutboundEmail = deps.saveOutboundEmail;
  if (!workflowErrors || !saveOutboundEmail) return;

  const alert = workflowErrors.buildWorkflowAlertEmail({
    code: "BROKER_SWAP_FAILED",
    context: {
      loadNumber: opts.loadNumber,
      marginPct: opts.margin,
      profit: opts.profit,
      brokerName: opts.brokerName || "Unknown broker",
      carrierName: opts.carrierName,
      tenPctName: opts.tenPctName,
      error: opts.error,
    },
  });
  await saveOutboundEmail({
    type: "broker_swap_failed",
    subject: alert.subject,
    html: alert.html,
    forceRecipient: true,
    to: lisaEmail(),
  });
}

/**
 * @return {string}
 */
function lisaEmail() {
  return process.env.LOW_PROFIT_CC_EMAIL || "Lisa@innovativecarriers.com";
}

/**
 * Recomputes margin after insurance premium posted; applies swap rules.
 * @param {object} opts
 * @param {string} opts.loadNumber
 * @param {object} opts.booking Primus REST booking.
 * @param {number} opts.premium Insurance premium posted to the load.
 * @return {Promise<object|null>}
 */
async function maybeAdjustAfterInsurancePremium(opts) {
  const checkProfitMargin = deps.checkProfitMargin;
  if (!checkProfitMargin || !opts || !opts.booking) return null;

  const loadNumber = String(opts.loadNumber || "").trim();
  const premium = Number(opts.premium || 0);
  if (!loadNumber || premium <= 0) return null;

  const acct = opts.booking.accountingInformation || {};
  const rateInfo = deps.readCustomerRateFromAcct ?
    deps.readCustomerRateFromAcct(acct) : {rate: null};
  const customerRate = Number(rateInfo.rate || 0);
  if (!customerRate) return null;

  const vendorCost = Number(
      (opts.booking.vendor && opts.booking.vendor.cost) || 0) + premium;
  const profitCheck = checkProfitMargin(customerRate, vendorCost);
  if (!profitCheck.lowMargin || profitCheck.lowProfit) return null;

  return adjustBrokerCommissionForLowMargin({
    loadNumber,
    margin: profitCheck.margin,
    profit: profitCheck.profit,
    booking: opts.booking,
    trigger: "insurance_post",
  });
}
exports.maybeAdjustAfterInsurancePremium = maybeAdjustAfterInsurancePremium;

exports._internal = {
  stripRateSuffix,
  normalizeRepKey,
  isKarenAdams,
  buildCatalogIndex,
  findTenPctVariant,
};
