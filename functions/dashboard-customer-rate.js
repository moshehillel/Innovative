/**
 * Save a customer rate from the Jerry dashboard and resume the
 * same Primus path the emailed setCustomerRate form uses.
 */

"use strict";

const admin = require("firebase-admin");

/**
 * @param {*} value Dollar amount from the dashboard.
 * @return {number|null}
 */
function parseCustomerRate(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100) / 100;
}

/**
 * Firestore patch. Matches functions-email-actions setCustomerRate so
 * processPrimusWorkflow honors the manual rate on resumeFrom get_rate.
 * @param {object} inv Invoice fields.
 * @param {number} customerRate Amount.
 * @param {string} customerName Optional name.
 * @return {object}
 */
function customerRatePatch(inv, customerRate, customerName) {
  const primusSteps = (inv && inv.primusSteps) || {};
  const taiSteps = (inv && inv.taiSteps) || {};
  const name = String(customerName || "").trim();
  return {
    customerRate,
    customerName: name || (inv && inv.customerName) || null,
    primusSteps: {...primusSteps, customerRateChecked: true},
    taiSteps: {...taiSteps, customerRateChecked: true},
    workflowPausedAtStep: null,
    workflowPausedAt: null,
    decisionStage: "running",
    decisionReason: null,
    finalWorkflowStatus: "running",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

/**
 * @param {object} data Task fields.
 * @return {boolean}
 */
function isMissingRateTask(data) {
  const type = String((data && data.type) || "").toLowerCase();
  const reason = [
    data && data.reason,
    data && data.title,
    data && data.decisionStage,
  ].filter(Boolean).join(" ").toLowerCase();
  return type === "missing_rate" || type === "rate_missing" ||
    /missing_rate|missing customer rate|needs_customer_rate/.test(reason);
}

/**
 * @param {object} db Firestore.
 * @param {Function} tcol Tenant collection helper.
 * @param {object} tenant Tenant.
 * @param {string} invoiceId Explicit id.
 * @param {string} loadNumber Load number.
 * @return {Promise<{ref: object, id: string, data: object}|null>}
 */
async function findInvoice(db, tcol, tenant, invoiceId, loadNumber) {
  if (typeof tcol !== "function") return null;
  const explicit = String(invoiceId || "").replace(/^invoice:/, "").trim();
  if (explicit) {
    const ref = tcol(tenant, "invoices").doc(explicit);
    const snap = await ref.get();
    if (snap.exists) {
      return {ref, id: snap.id, data: snap.data() || {}};
    }
  }
  const load = String(loadNumber || "").trim();
  if (!load) return null;
  const values = [load];
  if (/^\d+$/.test(load)) values.push(Number(load));
  let fallback = null;
  for (const value of values) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await tcol(tenant, "invoices")
        .where("loadNumber", "==", value)
        .limit(8)
        .get();
    for (const doc of snap.docs || []) {
      const data = doc.data() || {};
      const stage = String(data.decisionStage || "");
      const reason = String(data.decisionReason || "");
      const rateHold = stage === "needs_customer_rate_review" ||
        /missing customer rate|missing_rate/i.test(reason);
      const hit = {ref: doc.ref, id: doc.id, data};
      if (rateHold) return hit;
      if (!fallback) fallback = hit;
    }
  }
  return fallback;
}

/**
 * @param {object} db Firestore.
 * @param {string} tenantId Tenant.
 * @param {string} invoiceId Invoice.
 * @param {string} loadNumber Load.
 * @return {Promise<number>}
 */
async function dismissMissingRateTasks(db, tenantId, invoiceId, loadNumber) {
  const loads = [];
  const load = String(loadNumber || "").trim();
  if (load) {
    loads.push(load);
    if (/^\d+$/.test(load)) loads.push(Number(load));
  }
  const queries = [];
  if (invoiceId) {
    queries.push(db.collection("dashboardTasks")
        .where("invoiceId", "==", invoiceId)
        .limit(25)
        .get());
  }
  loads.forEach((value) => {
    queries.push(db.collection("dashboardTasks")
        .where("loadNumber", "==", value)
        .limit(25)
        .get());
  });
  if (!queries.length) return 0;
  const snaps = await Promise.all(queries);
  const seen = new Set();
  const writes = [];
  snaps.forEach((snap) => {
    (snap.docs || []).forEach((doc) => {
      if (seen.has(doc.id)) return;
      seen.add(doc.id);
      const data = doc.data() || {};
      if ((data.status || "") !== "open") return;
      if (tenantId && data.tenantId &&
          String(data.tenantId) !== String(tenantId)) {
        return;
      }
      if (!isMissingRateTask(data)) return;
      writes.push(doc.ref.update({
        status: "dismissed",
        dismissedAt: admin.firestore.FieldValue.serverTimestamp(),
      }));
    });
  });
  await Promise.all(writes);
  return writes.length;
}

/**
 * @param {object} deps db, tcol, kickWorkflow.
 * @param {object} request tenant, invoiceId, loadNumber, customerRate,
 *   customerName.
 * @return {Promise<object>}
 */
async function saveDashboardCustomerRate(deps, request) {
  const customerRate = parseCustomerRate(request && request.customerRate);
  if (customerRate == null) {
    return {
      ok: false,
      error: "Enter a customer rate greater than zero.",
    };
  }
  const tenant = request.tenant;
  const found = await findInvoice(
      deps.db,
      deps.tcol,
      tenant,
      request.invoiceId,
      request.loadNumber,
  );
  if (!found) {
    return {ok: false, error: "Invoice not found for that load."};
  }
  await found.ref.update(customerRatePatch(
      found.data, customerRate, request.customerName));
  const invoiceId = found.id;
  const loadNumber = found.data.loadNumber || request.loadNumber || null;
  await dismissMissingRateTasks(
      deps.db,
      tenant && tenant.tenantId,
      invoiceId,
      loadNumber,
  );
  let resumed = false;
  let warning = null;
  if (typeof deps.kickWorkflow === "function") {
    try {
      const kicked = await deps.kickWorkflow(invoiceId, {
        resumeFrom: "get_rate",
        tenantId: tenant && tenant.tenantId,
      });
      resumed = !!(kicked && kicked.ok);
      if (!resumed) {
        warning = (kicked && kicked.error) ||
          "Rate saved, but the workflow did not resume.";
      }
    } catch (err) {
      warning = (err && err.message) ||
        "Rate saved, but the workflow did not resume.";
    }
  }
  return {
    ok: true,
    customerRate,
    invoiceId,
    loadNumber,
    resumed,
    warning,
  };
}

module.exports = {
  parseCustomerRate,
  customerRatePatch,
  isMissingRateTask,
  saveDashboardCustomerRate,
};
