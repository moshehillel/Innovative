/**
 * Children's Apparel Network invoice protocol.
 *
 * Only this customer. When the carrier bill matches the expected Primus
 * cost within $25, Jerry enters
 * customer rate = carrier cost + max(carrier cost * 35%, $225)
 * and continues invoicing. A missing POD stays held; a later check that
 * finds the POD on the load uses the same rate and resumes the workflow.
 */

"use strict";

const {isChildrensApparelCustomer} = require("./customer-rate-alert");

const MARKUP_RATE = 0.35;
const MIN_PROFIT = 225;
const COST_MATCH_TOLERANCE = 25;

/**
 * @param {*} value Dollar amount.
 * @return {number}
 */
function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * Bill-to name on a Primus booking.
 * @param {object|null} booking Booking.
 * @return {string}
 */
function billToCustomerName(booking) {
  if (!booking) return "";
  if (booking.billTo === "thirdparty" && booking.thirdParty) {
    return String(booking.thirdParty.name || "");
  }
  if (booking.thirdParty && booking.thirdParty.name) {
    return String(booking.thirdParty.name);
  }
  return String((booking.shipper && booking.shipper.name) || "");
}

/**
 * @param {number|string} carrierCost Carrier bill.
 * @param {number|string} expectedCost Primus expected carrier cost.
 * @return {boolean}
 */
function costsMatchWithinTolerance(carrierCost, expectedCost) {
  const bill = money(carrierCost);
  const expected = money(expectedCost);
  if (!(bill > 0) || !(expected > 0)) return false;
  return Math.abs(bill - expected) <= COST_MATCH_TOLERANCE;
}

/**
 * Sell rate for a matched Children's Apparel carrier cost.
 * @param {number|string} carrierCost Carrier bill.
 * @return {number|null}
 */
function customerRateFromCarrierCost(carrierCost) {
  const cost = money(carrierCost);
  if (!(cost > 0)) return null;
  const markup = Math.max(cost * MARKUP_RATE, MIN_PROFIT);
  return money(cost + markup);
}

/**
 * Accept a Children's Apparel bill that is inside $25 even when the
 * shared $10 / 2% matcher rejected it. Does not widen other customers.
 * @param {string} customerName Bill-to name.
 * @param {object|null} validation validateAmountWithPrimus result.
 * @return {object|null}
 */
function acceptCostMatch(customerName, validation) {
  if (!validation || validation.validAmount) return validation;
  if (!isChildrensApparelCustomer(customerName)) return validation;
  const submitted = validation.submittedAmount;
  const expected = validation.primusQuotedAmount != null ?
    validation.primusQuotedAmount : validation.amount;
  if (!costsMatchWithinTolerance(submitted, expected)) return validation;
  const bill = money(submitted);
  return Object.assign({}, validation, {
    ok: true,
    validAmount: true,
    enteredAmount: bill,
    savedAmount: bill,
    childrensApparelCostMatch: true,
    reason: "Children's Apparel carrier cost within $25 of expected cost",
  });
}

/**
 * Rate to write when this customer, the $25 band, and a POD are all true.
 * @param {object} opts customerName, carrierCost, expectedCost, hasPod.
 * @return {object|null} customerRate and customerName, or null.
 */
function autoCustomerRate(opts) {
  const row = opts || {};
  const customerName = String(row.customerName || "");
  if (!isChildrensApparelCustomer(customerName)) return null;
  if (!row.hasPod) return null;
  if (!costsMatchWithinTolerance(row.carrierCost, row.expectedCost)) {
    return null;
  }
  const customerRate = customerRateFromCarrierCost(row.carrierCost);
  if (!(customerRate > 0)) return null;
  return {
    customerName,
    customerRate,
    rateSource: "childrens_apparel_markup",
    minProfit: MIN_PROFIT,
    markupRate: MARKUP_RATE,
    tolerance: COST_MATCH_TOLERANCE,
  };
}

/**
 * Whether a held Children's Apparel invoice should resume now that a POD
 * is on the load. Rate is set only when the $25 band matches.
 * @param {object} opts Fields customerName, carrierCost, expectedCost, hasPod.
 * @return {object} resume, customerRate, and reason.
 */
function planPodWaitResume(opts) {
  const row = opts || {};
  if (row.alreadyInvoiced) {
    return {resume: false, customerRate: null, reason: "already invoiced"};
  }
  if (!isChildrensApparelCustomer(row.customerName)) {
    return {resume: false, customerRate: null, reason: "not this customer"};
  }
  if (!row.hasPod) {
    return {resume: false, customerRate: null, reason: "pod still missing"};
  }
  const priced = autoCustomerRate({
    customerName: row.customerName,
    carrierCost: row.carrierCost,
    expectedCost: row.expectedCost,
    hasPod: true,
  });
  if (!priced) {
    return {
      resume: true,
      customerRate: null,
      reason: "pod found; cost outside $25 — resume without auto rate",
    };
  }
  return {
    resume: true,
    customerRate: priced.customerRate,
    reason: "pod found; entering Children's Apparel rate",
  };
}

/**
 * Later POD check for loads held on childrensApparelPodWait.
 * Finds a POD on Primus, writes the rate when the cost matches, and
 * kicks the Primus workflow.
 * @param {object} deps db, fetchBooking, checkPod, kickWorkflow.
 * @return {Promise<object>}
 */
async function resumePodWaits(deps) {
  const db = deps && deps.db;
  const fetchBooking = deps && deps.fetchBooking;
  const checkPod = deps && deps.checkPod;
  const kickWorkflow = deps && deps.kickWorkflow;
  const resumed = [];
  const waiting = [];
  const skipped = [];
  if (!db || typeof fetchBooking !== "function" ||
      typeof checkPod !== "function" ||
      typeof kickWorkflow !== "function") {
    return {checked: 0, resumed, waiting, skipped,
      error: "pod wait resume is not configured"};
  }
  const snap = await db.collection("invoices")
      .where("childrensApparelPodWait", "==", true)
      .limit(40)
      .get();
  for (const doc of snap.docs) {
    const inv = doc.data() || {};
    const loadNumber = String(inv.loadNumber || "").trim();
    if (!loadNumber) {
      skipped.push({id: doc.id, reason: "no load number"});
      continue;
    }
    if (inv.processingLock === true) {
      waiting.push({id: doc.id, loadNumber, reason: "already running"});
      continue;
    }
    const steps = inv.primusSteps || {};
    if (inv.customerInvoiceId || steps.uiInvoiceIssued ||
        steps.customerInvoiceGenerated) {
      await doc.ref.update({
        childrensApparelPodWait: false,
        updatedAt: new Date(),
      });
      skipped.push({id: doc.id, loadNumber, reason: "already invoiced"});
      continue;
    }
    let booking = null;
    let podFound = Boolean(inv.podOnPrimusAlready || steps.podUploaded ||
      (inv.podOnlyFile && inv.podOnlyFile.storagePath));
    try {
      booking = await fetchBooking(loadNumber);
      if (booking) {
        const pod = await checkPod({booking, loadNumber});
        podFound = Boolean(pod && pod.found) || podFound;
      }
    } catch (err) {
      waiting.push({
        id: doc.id,
        loadNumber,
        reason: err.message || "pod check failed",
      });
      continue;
    }
    const customerName = billToCustomerName(booking) ||
      inv.customerName || "";
    const expected = booking && booking.vendor ?
      booking.vendor.cost : null;
    const plan = planPodWaitResume({
      customerName,
      carrierCost: inv.invoiceAmount,
      expectedCost: expected,
      hasPod: podFound,
      alreadyInvoiced: false,
    });
    if (!plan.resume) {
      waiting.push({id: doc.id, loadNumber, reason: plan.reason});
      continue;
    }
    const patch = {
      childrensApparelPodWait: false,
      podOnPrimusAlready: true,
      customerName: customerName || inv.customerName || null,
      updatedAt: new Date(),
    };
    if (plan.customerRate) {
      patch.customerRate = plan.customerRate;
      patch.customerRateSource = "childrens_apparel_markup";
    }
    await doc.ref.update(patch);
    const kicked = await kickWorkflow(doc.id);
    resumed.push({
      id: doc.id,
      loadNumber,
      customerRate: plan.customerRate,
      reason: plan.reason,
      kickOk: !!(kicked && kicked.ok),
    });
  }
  return {checked: snap.size, resumed, waiting, skipped};
}

module.exports = {
  MARKUP_RATE,
  MIN_PROFIT,
  COST_MATCH_TOLERANCE,
  isChildrensApparelCustomer,
  billToCustomerName,
  costsMatchWithinTolerance,
  customerRateFromCarrierCost,
  acceptCostMatch,
  autoCustomerRate,
  planPodWaitResume,
  resumePodWaits,
};
