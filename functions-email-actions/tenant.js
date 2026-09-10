/**
 * Minimal tenant helpers for email-action HTTP endpoints.
 * Kept tiny so confirmation GETs cold-start in ~1s instead of ~35s.
 */
"use strict";

const admin = require("firebase-admin");

const BQ_DATASET = process.env.BQ_DATASET || "invoice_automation";

const DEFAULT_TENANT = Object.freeze({
  tenantId: "default",
  name: "Default (Primus)",
  tms: "primus",
  collectionPrefix: "",
  bqDataset: BQ_DATASET,
  gmailDocId: "gmail",
  outlookDocId: "outlook",
  alertEmail: process.env.ALERT_EMAIL || null,
  active: true,
});

/**
 * @param {string} tenantId Tenant id.
 * @return {object}
 */
function unconfiguredTenant(tenantId) {
  const id = String(tenantId);
  return {
    tenantId: id,
    name: id,
    tms: "",
    collectionPrefix: id,
    bqDataset: `${BQ_DATASET}_${id}`,
    gmailDocId: `gmail_${id}`,
    outlookDocId: `outlook_${id}`,
    alertEmail: process.env.ALERT_EMAIL || null,
    active: false,
  };
}

/**
 * @param {string} tenantId Tenant id.
 * @param {object} data Raw tenant doc.
 * @return {object}
 */
function normalizeTenant(tenantId, data) {
  const d = data || {};
  return {
    tenantId: String(tenantId),
    name: d.name || String(tenantId),
    tms: String(d.tms || "").toLowerCase(),
    collectionPrefix: String(d.collectionPrefix || tenantId).trim(),
    bqDataset: d.bqDataset || `${BQ_DATASET}_${tenantId}`,
    gmailDocId: d.gmailDocId || `gmail_${tenantId}`,
    outlookDocId: d.outlookDocId || `outlook_${tenantId}`,
    alertEmail: d.alertEmail || process.env.ALERT_EMAIL || null,
    active: d.active !== false,
  };
}

/**
 * @param {string|null} tenantId Tenant id.
 * @return {Promise<object>}
 */
async function getTenant(tenantId) {
  if (!tenantId || tenantId === "default") {
    return {...DEFAULT_TENANT};
  }
  try {
    const snap = await admin.firestore()
        .collection("tenants").doc(String(tenantId)).get();
    if (!snap.exists) return unconfiguredTenant(tenantId);
    return normalizeTenant(tenantId, snap.data());
  } catch (error) {
    console.error(`getTenant(${tenantId}) failed:`, error.message);
    return unconfiguredTenant(tenantId);
  }
}

/**
 * @param {object} req Request.
 * @return {Promise<object>}
 */
function tenantFromRequest(req) {
  const tenantId = (req.query && req.query.tenantId) ||
    (req.body && req.body.tenantId) || null;
  return getTenant(tenantId);
}

/**
 * @param {object} tenant Tenant config.
 * @param {string} name Collection base name.
 * @return {FirebaseFirestore.CollectionReference}
 */
function tcol(tenant, name) {
  const prefix = tenant && tenant.collectionPrefix;
  return admin.firestore()
      .collection(prefix ? `${prefix}_${name}` : name);
}

const TENANT_WORKFLOW_FUNCTIONS = Object.freeze({
  ctc: "processCtcTaiWorkflow",
});

/**
 * @param {string} tms TMS key.
 * @return {string|null}
 */
function workflowUrlForTms(tms) {
  const base =
    "https://us-central1-tai-invoice-automation.cloudfunctions.net";
  const key = String(tms || "").toLowerCase();
  if (key === "tai") {
    return process.env.PROCESS_TAI_WORKFLOW_URL ||
      `${base}/processTaiWorkflow`;
  }
  if (key === "primus") {
    return process.env.PROCESS_PRIMUS_WORKFLOW_URL ||
      `${base}/processPrimusWorkflow`;
  }
  return null;
}

/**
 * @param {object} tenant Tenant config.
 * @return {string|null}
 */
function workflowUrlForTenant(tenant) {
  const base =
    "https://us-central1-tai-invoice-automation.cloudfunctions.net";
  const fn = tenant && TENANT_WORKFLOW_FUNCTIONS[tenant.tenantId];
  if (fn) {
    const envOverride = process.env[
        `PROCESS_${tenant.tenantId.toUpperCase()}_WORKFLOW_URL`];
    return envOverride || `${base}/${fn}`;
  }
  return workflowUrlForTms(tenant && tenant.tms);
}

module.exports = {
  DEFAULT_TENANT,
  getTenant,
  tenantFromRequest,
  tcol,
  workflowUrlForTenant,
};
