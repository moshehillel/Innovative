const {onRequest} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");

const admin = require("firebase-admin");
const {BigQuery} = require("@google-cloud/bigquery");
const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai");
const {DEFAULT_OPENAI_MODEL} = require("./openai-models");
const {PDFDocument, StandardFonts, rgb} = require("pdf-lib");
const podUtils = require("./pod-utils");
const {
  extractPdfPageTexts,
  textLooksUnsafeForCustomer,
  normalizePodFromClassification,
  resolvePodDocuments,
  extractPodDocumentPdfBytes,
  parseClassificationResponse,
  normalizeClassificationToInvoices,
  preferRevisedInvoicesForSameLoad,
  repairSharedPdfInvoicePages,
  findInvoicePagesByProInPdf,
  scopedPagesNeedRepair,
  slicePdfByPages,
  collectInvoiceScopedPages,
  remapPodPagesAfterSlice,
  resolvePodPageIndex,
  mergePodDiscrepancies,
  scanPodBufferForDiscrepancies,
  normalizePodDiscrepancies,
} = podUtils;
const workflowErrors = require("./workflow-error-messages");
const brokerCommission = require("./broker-commission");
const undeliveredReport = require("./undelivered-shipment-report");
const deliveredUninvoicedReport = require("./delivered-uninvoiced-report");
const additionalCharges = require("./additional-charges");
const emailActionTokens = require("./email-action-tokens");
const fedexFreightPod = require("./fedex-freight-pod");
const xpoImaging = require("./xpo-imaging");
const loadResolution = require("./invoice-load-resolution");
const apexCapitalIntake = require("./apex-capital-intake");
const invoiceZipAttachments = require("./invoice-zip-attachments");
const dailyActivityReport = require("./daily-activity-report");
const podRequestIntake = require("./pod-request-intake");
const podSendDedup = require("./pod-send-dedup");
const {
  toOutboundEmailSafeSubject,
  toOutboundEmailSafeText,
} = require("./email-outbound-safe");
const administrativeEmailIntake = require("./administrative-email-intake");
const paymentNotificationClassify = require("./payment-notification-classify");
const statementInvoiceBundle = require("./statement-invoice-bundle");
const {
  sanitizePreCheckLabel,
  shouldTreatStatementCoverAsInvoiceBundle,
  normalizePreCheckDocType,
} = statementInvoiceBundle;
const drayageIntake = require("./drayage-intake");
const invoiceLoadEntry = require("./invoice-load-entry");
const dashboardTasks = require("./dashboard-tasks");
const mailProvider = require("./mail-provider");
const emailBranding = require("./email-branding");
const mailIntakeQueue = require("./mail-intake-queue");
const {runBulkRequeue} = require("./bulk-requeue-inbox");
const crypto = require("crypto");
const {AsyncLocalStorage} = require("async_hooks");

admin.initializeApp();

const bigquery = new BigQuery();
const BQ_DATASET = process.env.BQ_DATASET || "invoice_automation";
const BQ_LOGS_TABLE = "logs";
const BQ_SUMMARIES_TABLE = "summaries";

const BQ_LOGS_SCHEMA = [
  {name: "timestamp", type: "TIMESTAMP", mode: "REQUIRED"},
  {name: "flowId", type: "STRING", mode: "NULLABLE"},
  {name: "messageId", type: "STRING", mode: "NULLABLE"},
  {name: "invoiceId", type: "STRING", mode: "NULLABLE"},
  {name: "category", type: "STRING", mode: "NULLABLE"},
  {name: "level", type: "STRING", mode: "NULLABLE"},
  {name: "message", type: "STRING", mode: "NULLABLE"},
  {name: "currentStep", type: "STRING", mode: "NULLABLE"},
  {name: "details", type: "STRING", mode: "NULLABLE"},
];

const BQ_SUMMARIES_SCHEMA = [
  {name: "createdAt", type: "TIMESTAMP", mode: "REQUIRED"},
  {name: "flowId", type: "STRING", mode: "NULLABLE"},
  {name: "messageId", type: "STRING", mode: "NULLABLE"},
  {name: "invoiceId", type: "STRING", mode: "NULLABLE"},
  {name: "finalStatus", type: "STRING", mode: "NULLABLE"},
  {name: "lastStep", type: "STRING", mode: "NULLABLE"},
  {name: "failureReason", type: "STRING", mode: "NULLABLE"},
  {name: "recommendedFix", type: "STRING", mode: "NULLABLE"},
  {name: "aiSummary", type: "STRING", mode: "NULLABLE"},
];

const db = admin.firestore();
mailProvider.init({db});
let _bucket = null;
/**
 * Returns the default Storage bucket, lazily initialized.
 * @return {object} Firebase Storage bucket.
 */
function getBucket() {
  if (!_bucket) _bucket = admin.storage().bucket();
  return _bucket;
}

/**
 * Gets timestamp for deletion after specified days.
 * @param {number} days Number of days to add.
 * @return {admin.firestore.Timestamp} Timestamp for deletion.
 */
function getDeleteAt(days) {
  const now = new Date();
  return admin.firestore.Timestamp.fromDate(
      new Date(now.getTime() + days * 24 * 60 * 60 * 1000),
  );
}

// ── Multi-tenant support ─────────────────────────────────────────────────────
// Each client (e.g. the Primus client, the TAI client) is a "tenant". A tenant
// decides which TMS workflow runs for its invoices, which Firestore collections
// and BigQuery dataset its data lives in, and which mail inbox its invoices
// arrive on. There is one shared deployment; tenants are namespaced by a
// collection prefix rather than by separate Firebase projects.
//
// DEFAULT_TENANT reproduces the ORIGINAL single-tenant Primus behavior exactly:
// empty collection prefix (so collection names are unchanged), the original
// BigQuery dataset, and the legacy `settings/outlook` token doc when
// MAIL_PROVIDER=outlook (or `settings/gmail` for Gmail). This guarantees
// that existing data and the live Primus pipeline keep working with zero config
// — only newly-added tenants get namespaced collections/datasets/inboxes.
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
 * Normalizes a raw `tenants/{id}` Firestore document into a tenant config.
 * @param {string} tenantId Tenant identifier (the Firestore doc id).
 * @param {object} data Raw document data.
 * @return {object} Normalized tenant config.
 */
function normalizeTenant(tenantId, data) {
  const d = data || {};
  // Every default is the tenant's OWN namespace — never root or the default
  // tenant's dataset. A tenant doc that omits collectionPrefix/bqDataset still
  // reads/writes only its own (empty-until-used) data, so one client can never
  // fall back onto another client's collections, logs, or stats.
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
 * Resolves the tenant for an invoice "action" endpoint (continue/resume/email
 * links) from the request's tenantId (query or body). The links we generate
 * carry tenantId so a prefixed tenant's invoice is found in its own collection;
 * with no tenantId it defaults to the default tenant (correct for legacy
 * single-tenant links).
 * @param {object} req Express-style request.
 * @return {Promise<object>} Tenant config.
 */
function tenantFromRequest(req) {
  const tenantId = (req.query && req.query.tenantId) ||
    (req.body && req.body.tenantId) || null;
  return getTenant(tenantId);
}

/**
 * Builds a fail-closed config for a tenant whose `tenants/{id}` doc does not
 * exist (or could not be read). Crucially it does NOT inherit the default
 * tenant's data location: it points at the tenant's OWN namespace (prefix =
 * id, its own dataset + inbox), which is empty until the tenant is configured.
 * This guarantees an unconfigured/typo'd tenant shows nothing rather than
 * leaking the default (Innovative) tenant's invoices, logs, and stats.
 * @param {string} tenantId Tenant identifier.
 * @return {object} Namespaced, inactive tenant config.
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
 * Resolves a tenant by id. Returns the default (Innovative) tenant only for a
 * missing id or the explicit "default" id. Any other id whose doc does not
 * exist resolves to a fail-closed, tenant-namespaced config (see
 * unconfiguredTenant) so it can never read another tenant's data.
 * @param {string|null} tenantId Tenant identifier.
 * @return {Promise<object>} Tenant config.
 */
async function getTenant(tenantId) {
  if (!tenantId || tenantId === "default") {
    return {...DEFAULT_TENANT};
  }
  try {
    const snap = await db.collection("tenants").doc(String(tenantId)).get();
    if (!snap.exists) {
      return unconfiguredTenant(tenantId);
    }
    return normalizeTenant(tenantId, snap.data());
  } catch (error) {
    console.error(`getTenant(${tenantId}) failed:`, error.message);
    return unconfiguredTenant(tenantId);
  }
}

/**
 * Lists every tenant whose Gmail inbox should be polled. Always includes the
 * default tenant (legacy `settings/gmail`) so the original Primus inbox keeps
 * being processed, then appends every active doc in the `tenants` collection.
 * @return {Promise<Array<object>>} Active tenant configs.
 */
async function getActiveTenants() {
  const tenants = [{...DEFAULT_TENANT}];
  try {
    const snap = await db.collection("tenants")
        .where("active", "==", true).get();
    for (const doc of snap.docs) {
      if (doc.id === "default") continue;
      tenants.push(normalizeTenant(doc.id, doc.data()));
    }
  } catch (error) {
    console.error("getActiveTenants failed:", error.message);
  }
  return tenants;
}

/**
 * Returns a Firestore collection reference namespaced to a tenant. The default
 * tenant uses an empty prefix, so its collection names are unchanged.
 * @param {object} tenant Tenant config.
 * @param {string} name Base collection name (e.g. "invoices").
 * @return {FirebaseFirestore.CollectionReference} Namespaced collection ref.
 */
function tcol(tenant, name) {
  const prefix = tenant && tenant.collectionPrefix;
  return db.collection(prefix ? `${prefix}_${name}` : name);
}

/**
 * Returns the `settings/{docId}` document id that stores a tenant's Gmail OAuth
 * tokens. Defaults to the legacy "gmail" doc for the default tenant.
 * @param {object} tenant Tenant config.
 * @return {string} Settings doc id.
 */
function tenantGmailDocId(tenant) {
  return mailProvider.tenantMailDocId(tenant);
}

/**
 * Builds an authenticated mail API client for a tenant, or null if the
 * tenant's inbox is not connected.
 * @param {object} tenant Tenant config.
 * @return {Promise<object|null>} Mail client or null.
 */
async function getTenantGmailClient(tenant) {
  return mailProvider.getTenantMailClient(tenant);
}

/**
 * Normalizes carrier PRO / invoice # for comparison (strip dashes/spaces).
 * @param {string|null|undefined} value Raw reference.
 * @return {string}
 */
function normalizeCarrierReference(value) {
  return String(value || "").replace(/[\s-]/g, "").trim().toLowerCase();
}

/**
 * True when the carrier bill for this load appears already entered in
 * Primus (vendor ref match, carrier-bill document, or REST invoice row).
 * Booking PRO alone does not count as carrier bill entered.
 * @param {object} item AI invoice item.
 * @return {Promise<boolean>}
 */
async function isCarrierBillAlreadyEnteredInPrimus(item) {
  const loadNumber = item && item.loadNumber;
  if (!loadNumber) return false;
  const carrierInvNum = String(item.invoiceNumber || "").trim();
  const proNumber = String(item.proNumber || "").trim();
  const carrierBol = String(item.carrierBolNumber || "").trim();

  try {
    let booking = await fetchPrimusBooking(loadNumber);
    if (!booking && proNumber) {
      booking = await fetchPrimusBookingByPro(proNumber);
    }
    if (!booking && carrierBol) {
      booking = await fetchPrimusBookingByPro(carrierBol);
    }
    if (!booking) return false;

    const carrierRef = String(
        (booking.vendor && booking.vendor.carrierRef) ||
        booking.carrierRef || "").trim();

    const invData = await primusRequest(
        "GET",
        `/invoice/bolnumber/${encodeURIComponent(loadNumber)}`);
    const results = invData && invData.data && invData.data.results;
    const list = Array.isArray(results) ?
      results : (results ? [results] : []);

    let actualCosts = [];
    let hasCarrierBillFileType = false;
    if (process.env.PRIMUS_USE_MANAGE_PHP === "true") {
      try {
        const bridge = require("./primus-ui-bridge");
        const bookingId = bridge.resolveManageBookingId(booking);
        if (bookingId) {
          const docs = await bridge.getBookingDocuments({
            bookingId,
            bookingBOL: String(loadNumber),
          });
          if (docs.ok && docs.data) {
            try {
              const uploadFileTypes = await bridge.resolveUploadFileTypes();
              hasCarrierBillFileType = bridge._internal.bookingHasFileType(
                  docs.data, uploadFileTypes.carrierBill.id);
            } catch (_) {
              // File-type lookup is best-effort.
            }
            const uiInvoice = bridge._internal.findUiInvoice(docs.data);
            if (uiInvoice && uiInvoice.id != null) {
              const stores = await bridge.getInvoiceStores(String(uiInvoice.id));
              if (stores.ok && stores.data) {
                actualCosts = bridge._internal.extractActualCostsFromStore(
                    stores.data) || [];
              }
            }
          }
        }
      } catch (_) {
        // UI lookup is best-effort.
      }
    }

    const verify = require("./carrier-invoice-primus-verify");
    return verify.carrierBillEnteredInPrimusEvidence({
      carrierInvoiceNumber: carrierInvNum,
      carrierRef,
      invoices: list,
      actualCosts,
      hasCarrierBillFileType,
    });
  } catch (_) {
    return false;
  }
}

/**
 * True when Primus shows an issued (generated) customer invoice for the load.
 * @param {string} loadNumber Broker load / BOL.
 * @return {Promise<boolean>}
 */
async function hasIssuedCustomerInvoiceInPrimus(loadNumber) {
  if (!loadNumber) return false;
  try {
    const invData = await primusRequest(
        "GET",
        `/invoice/bolnumber/${encodeURIComponent(loadNumber)}`,
    );
    const results = invData && invData.data && invData.data.results;
    const list = Array.isArray(results) ?
      results : (results ? [results] : []);
    return list.some((inv) =>
      inv && inv.status && inv.status.generated,
    );
  } catch (_) {
    return false;
  }
}

/**
 * True when a prior Jerry run completed billing for this load + carrier inv #.
 * @param {object} tenant Tenant config.
 * @param {string} loadNumber Broker load number.
 * @param {string} [carrierInvoiceNumber] Carrier freight bill number.
 * @return {Promise<boolean>}
 */
async function hasPriorCompletedBillingForLoad(
    tenant, loadNumber, carrierInvoiceNumber) {
  const normalized = normalizeLoadNumber(loadNumber);
  if (!normalized) return false;
  const snap = await tcol(tenant, "invoices")
      .where("loadNumber", "==", normalized)
      .limit(12)
      .get();
  const carrierNorm = String(carrierInvoiceNumber || "").trim() ?
    normalizeCarrierReference(carrierInvoiceNumber) : "";
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    if (data.finalWorkflowStatus !== "completed") continue;
    if (!carrierNorm) return true;
    const prev = normalizeCarrierReference(
        data.invoiceNumber || data.proNumber || "");
    if (prev && prev === carrierNorm) return true;
  }
  return false;
}

/**
 * True when carrier bill and customer invoice are already complete in Primus.
 * @param {object} item AI invoice item with loadNumber.
 * @param {object} [tenant] Tenant config.
 * @return {Promise<boolean>}
 */
async function isInvoiceFullyBilledAndInvoicedInPrimus(
    item, tenant = DEFAULT_TENANT) {
  if (!item || !item.loadNumber) return false;
  if (!(await hasIssuedCustomerInvoiceInPrimus(item.loadNumber))) {
    return false;
  }
  if (await isCarrierBillAlreadyEnteredInPrimus(item)) return true;
  return hasPriorCompletedBillingForLoad(
      tenant, item.loadNumber, item.invoiceNumber);
}

/**
 * True when this email already created a Firestore invoice for the load.
 * Used on reprocess to skip loads handled in a prior run of the same message.
 * @param {object} tenant Tenant config.
 * @param {string} loadNumber Broker load number.
 * @param {string} messageId Parent Gmail message id.
 * @return {Promise<object|null>} Existing invoice summary or null.
 */
async function findInvoiceForLoadFromEmail(tenant, loadNumber, messageId) {
  const normalized = normalizeLoadNumber(loadNumber);
  if (!normalized || !messageId) return null;
  const snap = await tcol(tenant, "invoices")
      .where("loadNumber", "==", normalized)
      .where("gmailMessageId", "==", messageId)
      .limit(1)
      .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  const data = doc.data() || {};
  return {
    invoiceId: doc.id,
    finalWorkflowStatus: data.finalWorkflowStatus || null,
    status: data.status || null,
  };
}

/**
 * Drops invoice items whose load was already processed from this email.
 * @param {object} tenant Tenant config.
 * @param {string} messageId Parent Gmail message id.
 * @param {Array<object>} invoiceItems Classifier items.
 * @return {Promise<object>} {items, skippedSummaries}
 */
async function filterAlreadyProcessedInvoiceItems(
    tenant, messageId, invoiceItems) {
  const items = [];
  const skippedSummaries = [];
  for (const item of invoiceItems) {
    const loadNumber = String(item && item.loadNumber || "").trim();
    if (!loadNumber) {
      items.push(item);
      continue;
    }
    const existing = await findInvoiceForLoadFromEmail(
        tenant, loadNumber, messageId);
    if (existing) {
      await writeLog("info", "mail", "Already processed — skipped", {
        messageId,
        loadNumber,
        invoiceId: existing.invoiceId,
      });
      skippedSummaries.push({
        loadNumber,
        status: item.status || null,
        finalStatus: "already_processed_skipped",
        invoiceId: existing.invoiceId,
      });
    } else {
      items.push(item);
    }
  }
  return {items, skippedSummaries};
}

/**
 * Reads customer sell rate from a Primus booking when available.
 * @param {object|null} booking Primus booking.
 * @return {number|null}
 */
function customerRateFromBooking(booking) {
  if (!booking) return null;
  const {rate} = readCustomerRateFromAcct(
      booking.accountingInformation || {});
  const n = Number(rate);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Public base URL for HTTPS function links embedded in emails.
 * @return {string}
 */
function functionsBaseUrl() {
  return emailActionTokens.publicFunctionsBaseUrl();
}

/**
 * Resolves the workflow kickoff URL for a TMS. There is NO implicit default:
 * an unrecognized or empty TMS returns null so the caller treats it as a
 * configuration error instead of silently routing to Primus.
 * @param {string} tms TMS key ("tai" or "primus").
 * @return {string|null} Absolute workflow endpoint URL, or null if unknown.
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

// Per-company workflow endpoints. Each company file owns its own workflow
// function, so routing is keyed by tenantId first (a company can have a
// dedicated endpoint), then falls back to the generic per-TMS workflow. Add a
// row here when onboarding a company with its own file.
const TENANT_WORKFLOW_FUNCTIONS = Object.freeze({
  ctc: "processCtcTaiWorkflow",
});

/**
 * Resolves the workflow kickoff URL for a specific tenant. Prefers a dedicated
 * per-company endpoint (TENANT_WORKFLOW_FUNCTIONS) and otherwise falls back to
 * the generic per-TMS workflow URL. Returns null when the tenant's TMS is
 * unknown (no implicit Primus default).
 * @param {object} tenant Tenant config.
 * @return {string|null} Absolute workflow endpoint URL, or null if unknown.
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

/**
 * Re-invokes the Innovative Primus workflow for a Firestore invoice id.
 * Used by delayed retry after a transient Primus/network crash.
 * @param {string} invoiceId Invoice document id.
 * @param {object} [extraBody] Extra POST fields (resumeFrom, tenantId).
 * @return {Promise<object>} HTTP result.
 */
async function kickPrimusWorkflow(invoiceId, extraBody) {
  const url = workflowUrlForTms("primus");
  if (!url) {
    throw new Error("No Primus workflow URL configured");
  }
  const resp = await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      invoiceId,
      tenantId: "default",
      ...(extraBody || {}),
    }),
  });
  const payload = await resp.json().catch(() => ({}));
  return {
    ok: resp.ok && payload.ok !== false,
    status: resp.status,
    payload,
  };
}

// Tenant context for logging. Routing a tenant through every one of the dozens
// of writeLog/logWorkflowStep calls in the ingestion + workflow paths would be
// error-prone, so we stash the active tenant in async-local storage for the
// duration of a request/message and let the loggers read it. An explicit
// `tenant` argument always wins over the ambient context.
const tenantContext = new AsyncLocalStorage();

/**
 * Returns the tenant bound to the current async context, or null.
 * @return {object|null} Active tenant config.
 */
function currentTenant() {
  return tenantContext.getStore() || null;
}

/**
 * Binds `tenant` as the ambient logging context for the remainder of the
 * current async execution, without a callback wrapper. Per-company workflow
 * handlers call this once after resolving their tenant so every downstream
 * writeLog/logWorkflowStep routes to that tenant's BigQuery dataset and
 * Firestore collections — never another company's. Each HTTP invocation runs
 * in its own async context, so this never leaks across requests.
 * @param {object} tenant Tenant config.
 * @return {void}
 */
function enterTenantContext(tenant) {
  tenantContext.enterWith(tenant || DEFAULT_TENANT);
}

/**
 * Runs `fn` with `tenant` bound as the ambient logging context.
 * @param {object} tenant Tenant config.
 * @param {Function} fn Async function to run.
 * @return {*} Result of fn.
 */
function runWithTenant(tenant, fn) {
  return tenantContext.run(tenant || DEFAULT_TENANT, fn);
}

/**
 * Downloads a file from Firebase Storage and returns it as base64.
 * @param {string} storagePath - The storage path of the file.
 * @return {Promise<string|null>} Base64 encoded file or null.
 */
async function downloadStorageFileBase64(storagePath) {
  if (!storagePath) {
    return null;
  }

  const [buf] = await getBucket().file(storagePath).download();
  return Buffer.from(buf).toString("base64");
}

/**
 * Checks if a Primus API response indicates the operation already completed.
 * Treats "already delivered/approved/exists" as success.
 * @param {object} result API response object.
 * @return {boolean} True if already done.
 */
function isAlreadyDoneResult(result) {
  if (!result || typeof result !== "object") {
    return false;
  }
  // Check explicit already flags
  if (result.alreadyDelivered === true ||
      result.alreadyApproved === true ||
      result.alreadyExists === true) {
    return true;
  }
  // Check ok/approved flags combined with already-like messages
  const msg = String(result.message || result.error || "").toLowerCase();
  const alreadyPatterns = [
    "already delivered",
    "already approved",
    "already exists",
    "duplicate",
    "previously approved",
    "previously delivered",
  ];
  if (alreadyPatterns.some((p) => msg.includes(p))) {
    return true;
  }
  return false;
}

/**
 * Marks a shipment as delivered. Checks the booking's tracking status and
 * dispatches if not already dispatched. Actual delivery status is set by
 * carrier EDI or manual update in Primus — the API has no direct endpoint.
 * @param {string} loadNumber - The load/BOL number.
 * @param {string} proNumber - The PRO number.
 * @return {Promise<object>} Response from Primus API.
 */
async function markShipmentDelivered(loadNumber, proNumber) {
  try {
    const booking = await fetchPrimusBooking(loadNumber);
    if (!booking || !booking.BOLId) {
      return {ok: false, error: "Load not found in Primus"};
    }
    const tracking = booking.trackingInformation || {};
    if (tracking.deliveryDateActual && tracking.deliveryDateActual !== "") {
      return {ok: true, alreadyDelivered: true};
    }
    if (!tracking.dispatchDate || tracking.dispatchDate === "") {
      // primusRequest throws on non-2xx; response is {offerEDI, reason} on ok
      await primusRequest("POST", `/dispatch/${booking.BOLId}`, {
        makeEDI: false,
        forceDispatch: true,
      });
    }
    // Actual deliveryDateActual is set via carrier EDI or Primus portal;
    // no API endpoint exists to set it directly.
    return {ok: true, dispatched: true};
  } catch (error) {
    await writeLog("error", "primus", "Failed to mark shipment delivered", {
      loadNumber,
      proNumber,
      error: error.message,
    });
    return {ok: false, error: error.message};
  }
}

exports.sendCustomerMissingEmail = onRequest(async (req, res) => {
  try {
    const invoiceId = (req.body && req.body.invoiceId) || req.query.invoiceId;

    if (!invoiceId) {
      return res.status(400).json({
        ok: false,
        error: "invoiceId is required.",
      });
    }

    const tenant = await tenantFromRequest(req);
    const invoiceRef = tcol(tenant, "invoices").doc(String(invoiceId));
    const snap = await invoiceRef.get();

    if (!snap.exists) {
      return res.status(404).json({
        ok: false,
        error: "Invoice not found.",
      });
    }

    const invoice = snap.data();
    const customerName = String(invoice.customerName || "").toLowerCase();

    if (!customerName.includes("test")) {
      return res.json({
        ok: true,
        sent: false,
        reason: "Not a test customer.",
      });
    }

    await pauseWorkflow(
        invoiceRef,
        "check_customer",
        "test_customer_review",
        "Test customer detected - paused for manual confirmation",
    );

    const baseUrl = `https://${req.get("host")}`;
    const alert = workflowErrors.buildWorkflowAlertEmail({
      code: "TEST_CUSTOMER",
      context: {
        loadNumber: invoiceId,
        customerName: invoice.customerName,
      },
      baseUrl,
      invoiceId,
      tenantId: tenant.tenantId,
    });
    await saveOutboundEmail({
      type: "customer_missing",
      invoiceId,
      subject: alert.subject,
      html: alert.html,
    });

    return res.json({ok: true, sent: true});
  } catch (error) {
    console.error("sendCustomerMissingEmail error:", error);
    return res.status(500).json({
      ok: false,
      error: "Internal server error.",
      details: error.message,
    });
  }
});

/**
 * Checks if a flow is safe to summarize based on logs.
 * @param {Array} logs Logs for a single flow, sorted by timestamp.
 * @return {object} Result with safe boolean and reason string.
 */
function checkSafeToSummarize(logs) {
  if (!logs || logs.length === 0) {
    return {safe: false, reason: "No logs"};
  }

  const lastLog = logs[logs.length - 1];
  const lastTimestampValue = lastLog.timestamp || lastLog.createdAt || null;
  let lastTimestamp = new Date(lastTimestampValue || 0).getTime();
  if (!Number.isFinite(lastTimestamp) || lastTimestamp <= 0) {
    lastTimestamp = Date.now();
  }
  const minutesSinceLastLog = (Date.now() - lastTimestamp) / (1000 * 60);

  // Check for terminal statuses - these mean the flow is DONE
  const terminalIndicators = [
    {pattern: /workflow_completed/i, reason: "Workflow completed"},
    {pattern: /workflow_failed/i, reason: "Workflow failed"},
    {pattern: /APPROVED/i, reason: "Invoice approved"},
    {pattern: /ERROR/i, reason: "Error occurred"},
    {pattern: /UNMATCHED_AMOUNT/i, reason: "Amount unmatched"},
    {pattern: /CHARGES_NO_PROOF/i, reason: "Charges need proof"},
    {pattern: /UNRECOGNIZED_CHARGES/i, reason: "Unrecognized charges"},
    {pattern: /waiting_manual/i, reason: "Waiting for manual review"},
    {pattern: /completed/i, reason: "Processing completed"},
    {pattern: /insurance_processed/i, reason: "Insurance processed"},
    {pattern: /insurance_failed/i, reason: "Insurance failed"},
    {pattern: /queued for workflow/i, reason: "Queued for workflow"},
    {pattern: /Invoice queued/i, reason: "Invoice queued"},
    {pattern: /forwarded for review/i, reason: "Forwarded for review"},
    {pattern: /human review/i, reason: "Human review"},
    {pattern: /Email processing completed/i,
      reason: "Email processing completed"},
    {pattern: /inbox check completed/i, reason: "Inbox check completed"},
    {pattern: /skipped/i, reason: "Skipped"},
    {pattern: /no action/i, reason: "No action needed"},
    {pattern: /pod_request|pod_delivery/i, reason: "POD handled"},
  ];

  // Check if any log indicates a terminal state
  for (const log of logs) {
    const message = String(log.message || "");
    const level = String(log.level || "").toLowerCase();

    // Error level always means terminal
    if (level === "error") {
      return {safe: true, reason: "Error detected"};
    }

    // Check for terminal patterns in message
    for (const indicator of terminalIndicators) {
      if (indicator.pattern.test(message)) {
        return {safe: true, reason: indicator.reason};
      }
    }
  }

  // No terminal status found — summarize soon after activity stops.
  if (minutesSinceLastLog < 1) {
    return {
      safe: false,
      reason: `Flow still running or too recent ` +
        `(${Math.round(minutesSinceLastLog)}m ago)`,
    };
  }

  return {safe: true, reason: `Idle for ${Math.round(minutesSinceLastLog)}m`};
}

/** Per-flow dashboard activity feed disabled — use daily email digest. */
const DASHBOARD_ACTIVITY_FEED_ENABLED = false;

/** Max characters stored/displayed for dashboard activity blurbs. */
const AI_SUMMARY_MAX_CHARS = 200;

/**
 * @param {string|null|undefined} text Raw summary.
 * @param {number} [maxLen] Character cap.
 * @return {string|null}
 */
function truncateAiSummary(text, maxLen = AI_SUMMARY_MAX_CHARS) {
  const s = String(text || "").trim();
  if (!s) return null;
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1).trimEnd() + "…";
}

const normalizeLoadNumber = loadResolution.normalizeLoadNumber;
const isValidLoadNumber = loadResolution.isValidLoadNumber;

/**
 * Builds PRO search string variants (with/without dashes).
 * @param {string|null|undefined} proNumber Raw PRO from invoice.
 * @return {Array<string>} Unique non-empty PRO variants to try.
 */
function proNumberSearchVariants(proNumber) {
  const raw = String(proNumber || "").trim();
  if (!raw) return [];
  const digits = raw.replace(/[\s-]/g, "");
  const variants = [raw];
  if (digits && digits !== raw) variants.push(digits);
  // Common LTL shape: XXX-XXXXXXX (e.g. Estes 178-0980346).
  if (/^\d{10}$/.test(digits)) {
    variants.push(digits.slice(0, 3) + "-" + digits.slice(3));
  }
  return [...new Set(variants.filter(Boolean))];
}

/**
 * Reads a usable BOL / load number from a Primus booking object.
 * @param {object|null} booking Primus booking.
 * @return {string|null} Normalized BOL digits, or null.
 */
function readBolFromBooking(booking) {
  if (!booking || typeof booking !== "object") return null;
  const candidates = [
    booking.BOLNbr,
    booking.bolNumber,
    booking.BOLNumber,
    booking.BOL,
    booking.bol,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeLoadNumber(candidate);
    if (isValidLoadNumber(normalized)) return normalized;
  }
  return null;
}

/**
 * Finds a Primus booking by carrier PRO number.
 * @param {string} proNumber Carrier PRO (any dashed/undashed form).
 * @return {Promise<object|null>} First matching booking, or null.
 */
async function fetchPrimusBookingByPro(proNumber) {
  const variants = proNumberSearchVariants(proNumber);
  for (const variant of variants) {
    try {
      const searchData = await primusRequest(
          "GET",
          `/book?vendorPro=${encodeURIComponent(variant)}&limit=5`,
      );
      const results = searchData && searchData.data && searchData.data.results;
      if (!Array.isArray(results) || results.length === 0) continue;

      const wantDigits = normalizeLoadNumber(variant);
      const matched = results.find((row) => {
        const rowPro = normalizeLoadNumber(
            (row && row.vendor && row.vendor.PRO) ||
            (row && row.PRO) ||
            (row && row.vendorPro) ||
            "",
        );
        return wantDigits && rowPro && rowPro === wantDigits;
      }) || results[0];

      if (matched) return matched;
    } catch (err) {
      await writeLog("warn", "primus",
          "PRO search variant failed", {
            proNumber: variant,
            error: err.message,
          });
    }
  }
  return null;
}

/**
 * Resolves a Primus BOL / load number from a carrier PRO number.
 * @param {string} proNumber Carrier PRO from the invoice.
 * @return {Promise<object>} {loadNumber, booking, matchedPro}.
 */
async function resolveLoadNumberFromPrimusPro(proNumber) {
  const booking = await fetchPrimusBookingByPro(proNumber);
  if (!booking) {
    return {loadNumber: null, booking: null, matchedPro: null};
  }
  const loadNumber = readBolFromBooking(booking);
  const matchedPro = (booking.vendor && booking.vendor.PRO) ||
    String(proNumber || "").trim() || null;
  return {loadNumber, booking, matchedPro};
}

/**
 * Tries Primus BOL, vendor PRO, and tracking search for a carrier reference.
 * @param {string} ref Reference from the invoice.
 * @param {object} [hints] invoiceAmount, carrierName for disambiguation.
 * @return {Promise<object|null>} {loadNumber, booking, source, matchedPro?}
 */
async function resolveLoadNumberFromCarrierReference(ref, hints = {}) {
  const raw = String(ref || "").trim();
  if (!raw) return null;

  try {
    const booking = await fetchPrimusBooking(raw);
    if (booking) {
      const loadNumber = readBolFromBooking(booking);
      if (loadNumber) {
        return {loadNumber, booking, source: "bolnumber", matchedPro: null};
      }
    }
  } catch (_) {
    // BOL lookup is best-effort.
  }

  try {
    const resolved = await resolveLoadNumberFromPrimusPro(raw);
    if (resolved.loadNumber) {
      return {
        loadNumber: resolved.loadNumber,
        booking: resolved.booking,
        source: "vendor_pro",
        matchedPro: resolved.matchedPro,
      };
    }
  } catch (_) {
    // PRO lookup is best-effort.
  }

  try {
    if (primusUiBridge.searchBookingsForTrackingQuery) {
      const rows = await primusUiBridge.searchBookingsForTrackingQuery(raw, {
        limit: 25,
      });
      const match = loadResolution.pickTrackingSearchMatch(rows, hints);
      if (match && match.loadNumber) {
        let booking = null;
        try {
          booking = await fetchPrimusBooking(match.loadNumber);
        } catch (_) {
          booking = null;
        }
        return {
          loadNumber: match.loadNumber,
          booking,
          source: "tracking_search",
          matchedPro: null,
        };
      }
    }
  } catch (err) {
    await writeLog("warn", "primus", "Tracking search lookup failed", {
      ref: raw,
      error: err.message,
    });
  }

  return null;
}

/**
 * Clears garbage PRO OCR and backfills from Primus when the load is known.
 * @param {object} aiResult AI classification row.
 * @return {Promise<object>} Copy with sanitized/backfilled proNumber.
 */
async function sanitizeAndBackfillProNumber(aiResult) {
  const out = {...(aiResult || {})};
  if (out.proNumber && !loadResolution.isPlausibleCarrierPro(out.proNumber)) {
    await writeLog("warn", "ai",
        "Discarding implausible PRO extracted from invoice", {
          proNumberRaw: out.proNumber,
          loadNumber: out.loadNumber || null,
          carrierName: out.carrierName || null,
          invoiceNumber: out.invoiceNumber || null,
        });
    out.proNumber = "";
  }
  if (out.proNumber || !out.loadNumber) return out;
  try {
    const booking = await fetchPrimusBooking(out.loadNumber);
    const primusPro = booking && booking.vendor && booking.vendor.PRO;
    if (loadResolution.isPlausibleCarrierPro(primusPro)) {
      out.proNumber = String(primusPro).trim();
      out.proNumberSource = out.proNumberSource || "primus_booking";
      await writeLog("info", "primus",
          "Backfilled PRO from Primus booking", {
            loadNumber: out.loadNumber,
            proNumber: out.proNumber,
          });
    }
  } catch (_) {
    // Best-effort backfill only.
  }
  return out;
}

/**
 * Sanitizes carrier reference fields and resolves a Primus load when possible.
 * @param {object} aiResult AI classification row.
 * @param {number|null} lastKnownLoadNumber Recent Primus load, if known.
 * @return {Promise<object>} {aiResult, gateFailed, loadResolvedFrom}
 */
async function resolveInvoiceLoadNumber(aiResult, lastKnownLoadNumber) {
  const refs = loadResolution.normalizeCarrierReferenceFields(aiResult);
  const normalizedProNumber = refs.proNumber || "";

  const direct = loadResolution.evaluateLoadCandidate(
      refs.loadNumber, normalizedProNumber, lastKnownLoadNumber);
  if (direct.ok) {
    let directBooking = null;
    try {
      directBooking = await fetchPrimusBooking(direct.loadNumber);
    } catch (_) {
      directBooking = null;
    }
    if (directBooking) {
      return {
        aiResult: {...refs, loadNumber: direct.loadNumber},
        gateFailed: false,
        loadResolvedFrom: null,
      };
    }
    // Valid 6-digit BOL/load wins over PRO remap even when Primus fetch failed.
    return {
      aiResult: {...refs, loadNumber: direct.loadNumber},
      gateFailed: false,
      loadResolvedFrom: null,
    };
  }
  if (normalizedProNumber) {
    const proResolved = await resolveLoadNumberFromPrimusPro(
        normalizedProNumber);
    if (proResolved.loadNumber) {
      const proAccepted = loadResolution.evaluateLoadCandidate(
          proResolved.loadNumber, normalizedProNumber, lastKnownLoadNumber,
          {skipRange: true});
      if (proAccepted.ok) {
        return {
          aiResult: {
            ...refs,
            loadNumber: proAccepted.loadNumber,
            loadNumberSource: "primus_pro_vendor_pro",
          },
          gateFailed: false,
          loadResolvedFrom: {
            via: "pro",
            ref: normalizedProNumber,
            matchedPro: proResolved.matchedPro || null,
            primusSource: "vendor_pro",
          },
        };
      }
    }
  }

  const lookupKeys = loadResolution.buildPrimusLookupKeys(refs);
  const lookupHints = {
    invoiceAmount: aiResult.invoiceAmount,
    carrierName: aiResult.carrierName,
  };
  for (const {ref, label} of lookupKeys) {
    const found = await resolveLoadNumberFromCarrierReference(ref, lookupHints);
    if (!found || !found.loadNumber) continue;

    const accepted = loadResolution.evaluateLoadCandidate(
        found.loadNumber, normalizedProNumber, lastKnownLoadNumber,
        {skipRange: true});
    if (!accepted.ok) continue;

    return {
      aiResult: {
        ...refs,
        loadNumber: accepted.loadNumber,
        loadNumberSource: `primus_${label}_${found.source}`,
      },
      gateFailed: false,
      loadResolvedFrom: {
        via: label,
        ref,
        matchedPro: found.matchedPro || null,
        primusSource: found.source,
      },
    };
  }

  return {
    aiResult: refs,
    gateFailed: true,
    loadResolvedFrom: null,
    gateReason: direct.reason || "lookup_failed",
  };
}

/**
 * Returns the most recently created valid load number from invoices.
 * @param {object} [tenant] Tenant config (defaults to DEFAULT_TENANT).
 * @return {Promise<number|null>} Last known load number, or null.
 */
async function getLastKnownLoadNumber(tenant = DEFAULT_TENANT) {
  try {
    const snap = await tcol(tenant, "invoices")
        .orderBy("createdAt", "desc")
        .limit(50)
        .get();

    for (const doc of snap.docs) {
      const inv = doc.data();
      const normalized = normalizeLoadNumber(inv.loadNumber);
      if (isValidLoadNumber(normalized)) {
        const n = Number(normalized);
        if (Number.isFinite(n)) {
          return n;
        }
      }
    }

    return null;
  } catch (e) {
    console.error("getLastKnownLoadNumber failed:", e);
    return null;
  }
}

/** Default OpenAI model for dashboard flow-log summaries. */
const FLOW_SUMMARY_DEFAULT_MODEL = DEFAULT_OPENAI_MODEL;
const FLOW_SUMMARY_CLAUDE_MODEL = "claude-haiku-4-5";

/**
 * @param {*} raw details column from BigQuery.
 * @return {object}
 */
function parseLogDetailsField(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch (_) {
    return {};
  }
}

/**
 * Pulls a field from log details (supports nested details.*).
 * @param {object} details Parsed details object.
 * @param {string} key Field name.
 * @return {*}
 */
function detailField(details, key) {
  if (!details || typeof details !== "object") return null;
  if (details[key] != null && details[key] !== "") return details[key];
  const nested = details.details;
  if (nested && nested[key] != null && nested[key] !== "") return nested[key];
  return null;
}

/**
 * Builds compact log rows for summarization with load/carrier context.
 * @param {Array<object>} logs Flow logs sorted ascending.
 * @return {Array<object>}
 */
function compactLogsForSummary(logs) {
  return logs.slice(-60).map((log) => {
    const d = parseLogDetailsField(log.details);
    const entry = {
      t: log.timestamp || log.createdAt || null,
      l: log.level || null,
      m: String(log.message || "").slice(0, 220),
    };
    const load = detailField(d, "loadNumber");
    const carrier = detailField(d, "carrierName");
    const amount = detailField(d, "invoiceAmount") ??
      detailField(d, "submittedAmount");
    const err = detailField(d, "error") ||
      (d.result && d.result.error) ||
      detailField(d, "failureReason");
    const invNum = detailField(d, "invoiceNumber") ||
      detailField(d, "issuedInvoiceNumber");
    const wf = detailField(d, "workflowStatus") ||
      detailField(d, "finalWorkflowStatus");
    if (load) entry.load = load;
    if (carrier) entry.carrier = carrier;
    if (amount != null) entry.amount = amount;
    if (err) entry.error = String(err).slice(0, 140);
    if (invNum) entry.invoiceNum = invNum;
    if (wf) entry.status = wf;
    return entry;
  });
}

/**
 * Deterministic facts extracted from raw logs (ground truth for the model).
 * @param {Array<object>} logs Flow logs sorted ascending.
 * @return {object}
 */
function extractFlowFacts(logs) {
  const facts = {
    loadNumber: null,
    carrierName: null,
    customerName: null,
    invoiceAmount: null,
    issuedInvoiceNumber: null,
    lastError: null,
    lastMessage: null,
    outcomeHint: null,
  };
  for (const log of logs) {
    const d = parseLogDetailsField(log.details);
    facts.loadNumber = detailField(d, "loadNumber") || facts.loadNumber;
    facts.carrierName = detailField(d, "carrierName") || facts.carrierName;
    facts.customerName = detailField(d, "customerName") || facts.customerName;
    facts.invoiceAmount = detailField(d, "invoiceAmount") ??
      detailField(d, "submittedAmount") ?? facts.invoiceAmount;
    facts.issuedInvoiceNumber = detailField(d, "invoiceNumber") ||
      detailField(d, "issuedInvoiceNumber") || facts.issuedInvoiceNumber;
    const err = detailField(d, "error") ||
      (d.result && d.result.error);
    if (err && (log.level === "error" || log.level === "warn")) {
      facts.lastError = String(err).slice(0, 180);
    }
    facts.lastMessage = String(log.message || facts.lastMessage || "");
    const msg = String(log.message || "").toLowerCase();
    const message = log.message || "";
    if (/workflow completed|invoice approved|emailed to customer/i
        .test(message) ||
        /issued via manage/i.test(message) ||
        /documents emailed via primus/i.test(message)) {
      facts.outcomeHint = "completed";
    } else if (/additional charge.*awaiting|awaiting a\/b\/c\/d/i
        .test(message)) {
      facts.outcomeHint = "awaiting_extra_charge_approval";
    } else if (/ui billing flow failed|workflow failed|/i.test(message) ||
        /invoice_generation_failed/i.test(message)) {
      facts.outcomeHint = "billing_failed";
    } else if (/forwarded for review|no invoice|human review/i.test(message)) {
      facts.outcomeHint = "needs_review";
    } else if (/paused|missing customer rate|needs_customer/i.test(msg)) {
      facts.outcomeHint = "paused";
    }
  }
  return facts;
}

/**
 * @param {string} raw Raw model output.
 * @return {object}
 */
function parseFlowSummaryJson(raw) {
  let text = String(raw || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  return JSON.parse(text);
}

/**
 * Rule-based summary when the model output is weak or unparsable.
 * @param {object} facts extractFlowFacts output.
 * @param {string|null} failureReason Optional failure text.
 * @return {string}
 */
function buildFallbackFlowSummary(facts, failureReason) {
  const load = facts.loadNumber ? `Load ${facts.loadNumber}` : "Email intake";
  const carrier = facts.carrierName ? ` (${facts.carrierName})` : "";
  const amt = facts.invoiceAmount != null ?
    ` $${Number(facts.invoiceAmount).toFixed(2)}` : "";
  if (facts.outcomeHint === "completed") {
    const inv = facts.issuedInvoiceNumber ?
      ` — Primus #${facts.issuedInvoiceNumber}` : "";
    return `${load}${carrier}${amt} billed and completed${inv}.`;
  }
  if (facts.outcomeHint === "awaiting_extra_charge_approval") {
    return `${load}${carrier}${amt} matched — awaiting extra-charge approval.`;
  }
  if (facts.outcomeHint === "paused") {
    return `${load}${carrier}${amt} paused — needs dispatcher action.`;
  }
  if (facts.outcomeHint === "billing_failed" || failureReason) {
    const why = failureReason || facts.lastError || "billing failed";
    return `${load}${carrier}${amt} failed: ${why}.`;
  }
  if (facts.outcomeHint === "needs_review") {
    return `${load}${carrier} forwarded — no invoice auto-processed.`;
  }
  return `${load}${carrier}${amt} — ` +
    `${facts.lastMessage || "processing finished"}.`;
}

/**
 * OpenAI key for flow summaries (same env as support chat).
 * @return {string|undefined}
 */
function getFlowSummaryOpenAiKey() {
  return process.env.SUPPORT_CHAT_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY;
}

/**
 * Calls Claude or OpenAI for flow summary JSON.
 * @param {object} prompt User prompt object.
 * @return {Promise<string>} Raw JSON text from the model.
 */
async function callFlowSummaryModel(prompt) {
  const systemPrompt =
    "You summarize freight billing automation runs for a dashboard. " +
    "Return ONLY a JSON object with keys: finalStatus, lastCompletedStep, " +
    "failureReason, recommendedFix, aiSummary. " +
    "aiSummary rules: ONE sentence, max 180 characters, past tense, plain " +
    "English. ALWAYS lead with 'Load ####' when loadNumber is in facts/logs " +
    "(never use internal invoiceId strings). Include carrier name and dollar " +
    "amount when known. State outcome: billed, paused, failed (brief why), " +
    "forwarded for review, or awaiting extra-charge approval. " +
    "Do not contradict the facts block. No markdown, bullets, or timelines.";

  const userContent = JSON.stringify(prompt);

  if (process.env.ANTHROPIC_API_KEY) {
    const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
    const aiRes = await client.messages.create({
      model: FLOW_SUMMARY_CLAUDE_MODEL,
      max_tokens: 280,
      system: systemPrompt,
      messages: [{role: "user", content: userContent}],
      temperature: 0.1,
    });
    return String(aiRes.content[0] && aiRes.content[0].text || "").trim();
  }

  const apiKey = getFlowSummaryOpenAiKey();
  if (!apiKey) {
    throw new Error(
        "ANTHROPIC_API_KEY or SUPPORT_CHAT_OPENAI_API_KEY required",
    );
  }
  const client = new OpenAI({apiKey});
  const model = process.env.FLOW_SUMMARY_MODEL || FLOW_SUMMARY_DEFAULT_MODEL;
  const completion = await client.chat.completions.create({
    model,
    max_tokens: 280,
    temperature: 0.1,
    response_format: {type: "json_object"},
    messages: [
      {role: "system", content: systemPrompt},
      {role: "user", content: userContent},
    ],
  });
  return String(
      completion.choices &&
      completion.choices[0] &&
      completion.choices[0].message &&
      completion.choices[0].message.content || "",
  ).trim();
}

/**
 * Summarizes a single flow using OpenAI and writes to BigQuery.
 * @param {string} flowId Flow ID.
 * @param {Array} logs Logs for the flow, sorted by timestamp.
 * @return {Promise<object>} Summary result.
 */
async function summarizeSingleFlow(flowId, logs) {
  const lastLog = logs.length > 0 ? logs[logs.length - 1] : {};
  const messageId = lastLog.messageId || null;
  const invoiceId = lastLog.invoiceId || null;
  const facts = extractFlowFacts(logs);
  const compactLogs = compactLogsForSummary(logs);

  const prompt = {
    flowId: String(flowId),
    messageId,
    invoiceId,
    facts,
    logs: compactLogs,
    instructions: {
      outputFormat: {
        finalStatus: "string",
        lastCompletedStep: "string|null",
        failureReason: "string|null",
        recommendedFix: "string|null",
        aiSummary: "string (max 180 chars, one sentence, start with Load #)",
      },
    },
  };

  let aiJson = null;
  try {
    const rawText = await callFlowSummaryModel(prompt);
    aiJson = parseFlowSummaryJson(rawText);
  } catch (e) {
    aiJson = {
      finalStatus: "unknown",
      lastCompletedStep: null,
      failureReason: "AI_SUMMARY_FAILED",
      recommendedFix: "Check summarizeFlowLogs",
      aiSummary: buildFallbackFlowSummary(facts, null),
    };
  }

  const summaryText = String(aiJson.aiSummary || "").trim();
  const looksBad = !summaryText ||
    summaryText.startsWith("```") ||
    /invoiceId|invoice [a-zA-Z0-9]{16,}/i.test(summaryText) ||
    summaryText.length > 260;
  if (looksBad) {
    aiJson.aiSummary = buildFallbackFlowSummary(
        facts, aiJson.failureReason || facts.lastError);
  } else if (facts.loadNumber) {
    const loadStr = String(facts.loadNumber).toLowerCase();
    if (!summaryText.toLowerCase().includes(loadStr)) {
      aiJson.aiSummary = buildFallbackFlowSummary(
          facts, aiJson.failureReason || facts.lastError);
    }
  }

  await bigquery
      .dataset(BQ_DATASET)
      .table(BQ_SUMMARIES_TABLE)
      .insert([{
        createdAt: new Date().toISOString(),
        flowId: String(flowId),
        messageId: messageId,
        invoiceId: invoiceId,
        finalStatus: aiJson.finalStatus || "unknown",
        lastStep: aiJson.lastCompletedStep || null,
        failureReason: aiJson.failureReason || null,
        recommendedFix: truncateAiSummary(aiJson.recommendedFix, 200),
        aiSummary: truncateAiSummary(aiJson.aiSummary),
      }]);

  return {
    flowId: String(flowId),
    summary: aiJson,
  };
}

exports.setupBigQuery = onRequest(async (req, res) => {
  try {
    // Provision the default dataset, or a specific tenant's dataset when a
    // ?tenantId= (or ?dataset=) query param is supplied. Run this once per
    // tenant so its logs land in its own dataset.
    let datasetName = BQ_DATASET;
    const tenantId = req.query.tenantId || (req.body && req.body.tenantId);
    if (tenantId) {
      const tenant = await getTenant(String(tenantId));
      datasetName = tenant.bqDataset;
    } else if (req.query.dataset) {
      datasetName = String(req.query.dataset);
    }

    const dataset = bigquery.dataset(datasetName);
    const [datasetExists] = await dataset.exists();
    if (!datasetExists) {
      await bigquery.createDataset(datasetName, {location: "US"});
    }

    const [logsExists] = await dataset.table(BQ_LOGS_TABLE).exists();
    if (!logsExists) {
      await dataset.createTable(BQ_LOGS_TABLE, {schema: BQ_LOGS_SCHEMA});
    }

    const [summariesExists] = await dataset.table(BQ_SUMMARIES_TABLE).exists();
    if (!summariesExists) {
      await dataset.createTable(BQ_SUMMARIES_TABLE, {
        schema: BQ_SUMMARIES_SCHEMA,
      });
    }

    return res.json({
      ok: true,
      message: "BigQuery dataset and tables are ready.",
      dataset: datasetName,
      tables: [BQ_LOGS_TABLE, BQ_SUMMARIES_TABLE],
    });
  } catch (error) {
    console.error("setupBigQuery error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to set up BigQuery.",
      details: error.message,
    });
  }
});

exports.summarizeFlowLogs = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed. Use POST.",
      });
    }

    const {flowId} = req.body || {};
    const result = await runFlowLogSummarization({
      flowId: flowId ? String(flowId) : null,
      maxFlows: Number(req.body && req.body.maxFlows) || 80,
    });
    return res.json({ok: true, ...result});
  } catch (error) {
    console.error("summarizeFlowLogs error:", error);
    return res.status(500).json({
      ok: false,
      error: "Internal server error.",
      details: error.message,
    });
  }
});

/** Daily 6 PM ET — Jerry activity email (replaces per-flow summaries). */
exports.summarizeFlowLogsScheduled = onSchedule({
  schedule: "0 18 * * *",
  timeZone: "America/New_York",
  timeoutSeconds: 540,
  memory: "1GiB",
}, async () => {
  try {
    const tenants = await getActiveTenants();
    for (const tenant of tenants) {
      await runWithTenant(tenant, async () => {
        const result = await dailyActivityReport.runDailyActivityReport({
          tenant,
          hours: 24,
        });
        console.log("dailyActivityReport:", JSON.stringify({
          tenantId: tenant.tenantId,
          bulletCount: result.bulletCount,
          logCount: result.logCount,
        }));
        const swapResult = await dailyActivityReport.runDailyBrokerSwapReport({
          tenant,
          hours: 24,
        });
        console.log("dailyBrokerSwapReport:", JSON.stringify({
          tenantId: tenant.tenantId,
          swapCount: swapResult.swapCount,
          logCount: swapResult.logCount,
        }));
        const inboxResult =
            await dailyActivityReport.runDailyInboxDigestReport({
              tenant,
              hours: 24,
            });
        console.log("dailyInboxDigestReport:", JSON.stringify({
          tenantId: tenant.tenantId,
          emailCount: inboxResult.emailCount,
          needsAttentionCount: inboxResult.needsAttentionCount,
        }));
        const ignoredResult =
            await dailyActivityReport.runDailyIgnoredEmailsReport({
              tenant,
              hours: 24,
            });
        console.log("dailyIgnoredEmailsReport:", JSON.stringify({
          tenantId: tenant.tenantId,
          ignoredCount: ignoredResult.ignoredCount,
          categoryCount: ignoredResult.categoryCount,
        }));
      });
    }
  } catch (error) {
    console.error("summarizeFlowLogsScheduled (daily digest) error:",
        error.message);
  }
});

exports.sendDailyActivityReport = onRequest(
    {timeoutSeconds: 540, memory: "1GiB"},
    async (req, res) => {
      try {
        const tenant = req.query.tenantId ?
      await getTenant(String(req.query.tenantId)) :
      DEFAULT_TENANT;
        const hours = Number(req.query.hours || 24);
        const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
        const reportOnly = String(req.query.report || "").trim();
        const runActivity = !reportOnly || reportOnly === "activity";
        const runSwaps = !reportOnly || reportOnly === "swaps";
        const runInbox = !reportOnly || reportOnly === "inbox";
        const runIgnored = !reportOnly || reportOnly === "ignored";

        const activityResult = runActivity ?
          await runWithTenant(tenant, () =>
            dailyActivityReport.runDailyActivityReport({tenant, hours, dryRun}),
          ) : null;
        const swapResult = runSwaps ?
          await runWithTenant(tenant, () =>
            dailyActivityReport.runDailyBrokerSwapReport(
                {tenant, hours, dryRun}),
          ) : null;
        const inboxResult = runInbox ?
          await runWithTenant(tenant, () =>
            dailyActivityReport.runDailyInboxDigestReport(
                {tenant, hours, dryRun}),
          ) : null;
        const ignoredResult = runIgnored ?
          await runWithTenant(tenant, () =>
            dailyActivityReport.runDailyIgnoredEmailsReport(
                {tenant, hours, dryRun}),
          ) : null;

        return res.json({
          ok: true,
          tenantId: tenant.tenantId,
          activity: activityResult,
          brokerSwaps: swapResult,
          inboxDigest: inboxResult,
          ignoredEmails: ignoredResult,
        });
      } catch (error) {
        console.error("sendDailyActivityReport error:", error);
        return res.status(500).json({
          ok: false,
          error: error.message,
        });
      }
    });

/**
 * Per-flow summaries disabled — daily email digest replaces dashboard feed.
 * @param {string} flowId Flow id.
 * @param {string} [dataset] BigQuery dataset.
 * @return {Promise<null>}
 */
async function scheduleFlowSummary(flowId, dataset = BQ_DATASET) {
  void flowId;
  void dataset;
  return null;
}

/**
 * Batch-summarizes flows that have logs but no summary row yet.
 * @param {object} [opts]
 * @param {string|null} [opts.flowId] Single flow only.
 * @param {number} [opts.maxFlows] Cap per invocation.
 * @param {string} [opts.dataset] BigQuery dataset.
 * @return {Promise<object>}
 */
async function runFlowLogSummarization(opts = {}) {
  const dataset = opts.dataset || BQ_DATASET;
  const maxFlows = Math.min(Number(opts.maxFlows || 80), 150);
  let unsummarizedQuery;
  let queryOptions;
  if (opts.flowId) {
    unsummarizedQuery = `
      SELECT DISTINCT l.flowId
      FROM \`${dataset}.${BQ_LOGS_TABLE}\` l
      LEFT JOIN \`${dataset}.${BQ_SUMMARIES_TABLE}\` s
        ON l.flowId = s.flowId
      WHERE l.flowId = @flowId AND s.flowId IS NULL
    `;
    queryOptions = {
      query: unsummarizedQuery,
      params: {flowId: String(opts.flowId)},
    };
  } else {
    unsummarizedQuery = `
      SELECT flowId FROM (
        SELECT l.flowId, MAX(l.timestamp) AS lastTs
        FROM \`${dataset}.${BQ_LOGS_TABLE}\` l
        LEFT JOIN \`${dataset}.${BQ_SUMMARIES_TABLE}\` s
          ON l.flowId = s.flowId
        WHERE s.flowId IS NULL AND l.flowId IS NOT NULL
        GROUP BY l.flowId
        ORDER BY lastTs DESC
        LIMIT @maxFlows
      )
    `;
    queryOptions = {
      query: unsummarizedQuery,
      params: {maxFlows},
    };
  }

  const [unsummarizedRows] = await bigquery.query(queryOptions);
  const unsummarizedFlowIds = unsummarizedRows.map((r) => r.flowId);

  const results = [];
  for (const fid of unsummarizedFlowIds) {
    const [logRows] = await bigquery.query({
      query: `
        SELECT * FROM \`${dataset}.${BQ_LOGS_TABLE}\`
        WHERE flowId = @flowId
        ORDER BY timestamp ASC
      `,
      params: {flowId: fid},
    });

    const safeCheck = checkSafeToSummarize(logRows);
    if (!safeCheck.safe) {
      results.push({flowId: fid, skipped: true, reason: safeCheck.reason});
      continue;
    }

    try {
      const summary = await summarizeSingleFlow(fid, logRows);
      results.push({...summary, skipped: false});
    } catch (error) {
      console.error(`Failed to summarize flow ${fid}:`, error);
      results.push({
        flowId: fid,
        skipped: true,
        reason: "Summarization failed",
        error: error.message,
      });
    }
  }

  return {
    totalFlows: unsummarizedFlowIds.length,
    summarized: results.filter((r) => !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    results,
  };
}

/**
 * Reminds / escalates TL invoices waiting on a carrier POD (3bd / 10bd).
 * Also invoked at the end of checkStuckFlows so one cron covers both.
 */
exports.checkPodFollowUps = onRequest(
    {invoker: "public"}, handleCheckPodFollowUps);

/**
 * Undelivered shipment report — pickup > N days, no delivery date.
 * Dispatcher To; Leo CC'd. Query: ?dryRun=1 to preview without sending.
 */
exports.reportUndeliveredShipments = onRequest(
    {invoker: "public", timeoutSeconds: 540, memory: "512MiB"},
    handleReportUndeliveredShipments);

/** Mon & Thu 8:00 AM — stale pickup, no delivery date (America/Cayman). */
exports.reportUndeliveredShipmentsWeekly = onSchedule({
  schedule: "0 8 * * 1,4",
  timeZone: "America/Cayman",
  timeoutSeconds: 540,
  memory: "512MiB",
}, async () => {
  try {
    const result = await undeliveredReport.runUndeliveredShipmentReport({});
    if (!result.ok) {
      await writeLog("error", "report", "Undelivered shipment report failed", {
        error: result.error || "unknown",
      });
      await saveOutboundEmail({
        type: "undelivered_shipment_report_failed",
        subject: "System issue — undelivered shipment report failed",
        html: `<p>The undelivered shipment lookup failed.</p>` +
          `<p>${escapeHtml(result.error || "Unknown error")}</p>`,
        systemError: true,
      });
    }
  } catch (error) {
    await writeLog("error", "report", "Undelivered shipment report threw", {
      error: error.message,
    });
    await saveOutboundEmail({
      type: "undelivered_shipment_report_failed",
      subject: "System issue — undelivered shipment report failed",
      html: `<p>The undelivered shipment lookup failed.</p>` +
        `<p>${escapeHtml(error.message)}</p>`,
      systemError: true,
    });
    throw error;
  }
});

/**
 * @param {object} req HTTPS request.
 * @param {object} res HTTPS response.
 * @return {Promise<object>}
 */
async function handleReportUndeliveredShipments(req, res) {
  try {
    if (req.method !== "POST" && req.method !== "GET") {
      return res.status(405).json({ok: false, error: "Use GET or POST"});
    }
    const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
    const result = await undeliveredReport.runUndeliveredShipmentReport({
      dryRun,
    });
    return res.json(result);
  } catch (error) {
    console.error("reportUndeliveredShipments error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}

/**
 * Delivered / past-due shipments with no customer invoice.
 * Lisa To. Query: ?dryRun=1 to preview without sending.
 */
exports.reportDeliveredUninvoicedShipments = onRequest(
    {invoker: "public", timeoutSeconds: 540, memory: "512MiB"},
    handleReportDeliveredUninvoicedShipments);

/** Mon & Thu 8:00 AM — delivered/past-due, not invoiced (America/Cayman). */
exports.reportDeliveredUninvoicedShipmentsWeekly = onSchedule({
  schedule: "0 8 * * 1,4",
  timeZone: "America/Cayman",
  timeoutSeconds: 540,
  memory: "512MiB",
}, async () => {
  try {
    const result =
      await deliveredUninvoicedReport.runDeliveredUninvoicedReport({});
    if (!result.ok) {
      await writeLog("error", "report",
          "Delivered-uninvoiced shipment report failed", {
            error: result.error || "unknown",
          });
      await saveOutboundEmail({
        type: "delivered_uninvoiced_report_failed",
        subject: "System issue — delivered-uninvoiced report failed",
        html: `<p>The delivered-uninvoiced shipment lookup failed.</p>` +
          `<p>${escapeHtml(result.error || "Unknown error")}</p>`,
        systemError: true,
      });
    }
  } catch (error) {
    await writeLog("error", "report",
        "Delivered-uninvoiced shipment report threw", {
          error: error.message,
        });
    await saveOutboundEmail({
      type: "delivered_uninvoiced_report_failed",
      subject: "System issue — delivered-uninvoiced report failed",
      html: `<p>The delivered-uninvoiced shipment lookup failed.</p>` +
        `<p>${escapeHtml(error.message)}</p>`,
      systemError: true,
    });
    throw error;
  }
});

/**
 * @param {object} req HTTPS request.
 * @param {object} res HTTPS response.
 * @return {Promise<object>}
 */
async function handleReportDeliveredUninvoicedShipments(req, res) {
  try {
    if (req.method !== "POST" && req.method !== "GET") {
      return res.status(405).json({ok: false, error: "Use GET or POST"});
    }
    const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
    const result =
      await deliveredUninvoicedReport.runDeliveredUninvoicedReport({
        dryRun,
      });
    return res.json(result);
  } catch (error) {
    console.error("reportDeliveredUninvoicedShipments error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}

/**
 * Smoke-test XPO weight cert pull from Cloud Functions.
 * GET ?pro=123456789&format=json — returns PDF or JSON error.
 */
exports.testXpoWeightCert = onRequest(
    {invoker: "public", timeoutSeconds: 60},
    async (req, res) => {
      try {
        const bodyPro = req.body && (req.body.pro || req.body.proNumber);
        const pro = String(
            req.query.pro || bodyPro || req.get("X-Pro-Number") || "",
        ).replace(/\D/g, "").slice(0, 9);
        if (!pro) {
          return res.status(400).json({
            ok: false,
            error: "Missing pro query parameter",
          });
        }
        const asJson = req.query.format === "json" ||
          (req.body && req.body.format === "json");
        const result = await xpoImaging.fetchXpoWeightCertPdf(pro);
        if (!result.ok || !result.pdfBuffer) {
          return res.status(502).json({
            ok: false,
            proNumber: pro,
            error: result.error || "Weight cert fetch failed",
            attempts: result.attempts || null,
          });
        }
        if (asJson) {
          return res.json({
            ok: true,
            proNumber: pro,
            imageType: result.imageType || null,
            bytes: result.pdfBuffer.length,
            pdfBase64: result.pdfBuffer.toString("base64"),
          });
        }
        res.set("Content-Type", "application/pdf");
        res.set("Content-Disposition",
            `inline; filename="xpo-wi-${pro}.pdf"`);
        return res.send(result.pdfBuffer);
      } catch (error) {
        console.error("testXpoWeightCert error:", error);
        return res.status(500).json({ok: false, error: error.message});
      }
    });

/**
 * Smoke-test FedEx Freight POD pull from Cloud Functions (bypasses NetFree).
 * GET ?pro=7338614695 — returns PDF or JSON error.
 */
exports.testFedExFreightPod = onRequest(
    {invoker: "public", timeoutSeconds: 60},
    async (req, res) => {
      try {
        const bodyPro = req.body && (req.body.pro || req.body.proNumber);
        const pro = String(
            req.query.pro || bodyPro || req.get("X-Pro-Number") ||
            "7338614695",
        ).replace(/\D/g, "");
        const asJson = req.query.format === "json" ||
          (req.body && req.body.format === "json");
        const result = await fedexFreightPod.fetchFedExFreightPodPdf(pro);
        if (!result.ok || !result.pdfBuffer) {
          return res.status(502).json({
            ok: false,
            proNumber: pro,
            error: result.error || "POD fetch failed",
          });
        }
        if (asJson) {
          return res.json({
            ok: true,
            proNumber: pro,
            bytes: result.pdfBuffer.length,
            pdfBase64: result.pdfBuffer.toString("base64"),
          });
        }
        res.set("Content-Type", "application/pdf");
        res.set("Content-Disposition",
            `inline; filename="fedex-pod-${pro}.pdf"`);
        return res.send(result.pdfBuffer);
      } catch (error) {
        console.error("testFedExFreightPod error:", error);
        return res.status(500).json({ok: false, error: error.message});
      }
    });

/**
 * Implementation for checkPodFollowUps.
 * @param {object} req HTTPS request.
 * @param {object} res HTTPS response.
 * @return {Promise<object>} Express response.
 */
async function handleCheckPodFollowUps(req, res) {
  try {
    if (req.method !== "POST" && req.method !== "GET") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed. Use GET or POST.",
      });
    }
    const result = await runPodFollowUpChecks();
    return res.json({ok: true, ...result});
  } catch (error) {
    console.error("checkPodFollowUps error:", error);
    return res.status(500).json({
      ok: false,
      error: "Internal server error.",
      details: error.message,
    });
  }
}
/**
 * Scans invoices with an open podFollowUp.
 *
 * Schedule (business days Mon–Fri):
 *   - Initial carrier POD request is sent when the chase starts
 *   - Every 3bd with no POD / no reply → carrier reminder
 *   - After 3 reminders still missing → escalate to Lisa
 *
 * Also resolves chases when POD has since been uploaded.
 * @return {Promise<object>} {reminded, escalated, resolved, checked}
 */
async function runPodFollowUpChecks() {
  const podFollowup = require("./pod-followup");
  const statuses = [
    podFollowup.POD_FOLLOW_UP_STATUS.AWAITING_CARRIER,
    podFollowup.POD_FOLLOW_UP_STATUS.REMINDED,
    podFollowup.POD_FOLLOW_UP_STATUS.ESCALATED,
  ];
  const snap = await db.collection("invoices")
      .where("podFollowUp.status", "in", statuses)
      .limit(100)
      .get();

  const lisa = process.env.LOW_PROFIT_CC_EMAIL || podFollowup.LISA_EMAIL;
  const reminded = [];
  const escalated = [];
  const resolved = [];
  const now = new Date();
  const MAX_REMINDERS = 3;
  const REMIND_INTERVAL_BD = 3;

  for (const doc of snap.docs) {
    const inv = doc.data();
    const fu = inv.podFollowUp || {};
    const firstAt = fu.firstEmailedAt && fu.firstEmailedAt.toDate ?
      fu.firstEmailedAt.toDate() : (fu.firstEmailedAt ?
        new Date(fu.firstEmailedAt) : null);
    if (!firstAt || isNaN(firstAt.getTime())) continue;

    // POD arrived locally or already marked on Primus — resolve.
    let hasPod = Boolean(
        (inv.podOnlyFile && inv.podOnlyFile.storagePath) ||
        inv.podOnPrimusAlready ||
        (inv.primusSteps && inv.primusSteps.podUploaded));
    if (!hasPod && primusUiBridge && primusUiBridge.checkBookingHasPod &&
        inv.loadNumber) {
      try {
        const booking = await fetchPrimusBooking(inv.loadNumber);
        if (booking) {
          const podCheck = await primusUiBridge.checkBookingHasPod({
            booking,
            loadNumber: inv.loadNumber,
          });
          hasPod = Boolean(podCheck && podCheck.found);
        }
      } catch (_) {
        // Best-effort Primus check — fall through on failure.
      }
    }
    if (hasPod) {
      await doc.ref.update({
        "podFollowUp.status": podFollowup.POD_FOLLOW_UP_STATUS.RESOLVED,
        "podFollowUp.holdCustomerEmail": false,
        "podFollowUp.resolvedAt":
          admin.firestore.FieldValue.serverTimestamp(),
        "updatedAt": admin.firestore.FieldValue.serverTimestamp(),
      });
      resolved.push(doc.id);
      continue;
    }

    // Already escalated — only watch for POD arrival above.
    if (fu.status === podFollowup.POD_FOLLOW_UP_STATUS.ESCALATED) {
      continue;
    }

    const lastEmailedRaw = fu.lastEmailedAt || fu.reminderSentAt ||
      fu.firstEmailedAt;
    const lastEmailed = lastEmailedRaw && lastEmailedRaw.toDate ?
      lastEmailedRaw.toDate() :
      (lastEmailedRaw ? new Date(lastEmailedRaw) : firstAt);
    const daysSinceEmail =
      podFollowup.businessDaysBetween(lastEmailed, now);
    if (daysSinceEmail < REMIND_INTERVAL_BD) continue;

    const reminderCountRaw = Number(fu.reminderCount || 0);
    // Legacy rows marked REMINDED before reminderCount existed count as 1.
    const reminderCount =
      (fu.status === podFollowup.POD_FOLLOW_UP_STATUS.REMINDED &&
        reminderCountRaw === 0) ? 1 : reminderCountRaw;
    const bd = podFollowup.businessDaysBetween(firstAt, now);

    // 3 reminders already sent → escalate Lisa, stop chasing carrier.
    if (reminderCount >= MAX_REMINDERS) {
      const escEmail = podFollowup.buildTlPodEscalationEmail({
        loadNumber: inv.loadNumber,
        carrierName: inv.carrierName,
        proNumber: inv.proNumber,
        carrierEmail: fu.carrierEmail,
        businessDays: bd,
        reminderCount,
      });
      await saveOutboundEmail({
        type: "tl_pod_escalation",
        invoiceId: doc.id,
        forceRecipient: true,
        to: lisa,
        subject: escEmail.subject,
        html: escEmail.html,
      });
      const alert = workflowErrors.buildWorkflowAlertEmail({
        code: "TL_POD_ESCALATED",
        context: {
          loadNumber: inv.loadNumber,
          carrierName: inv.carrierName,
          proNumber: inv.proNumber,
        },
      });
      await saveOutboundEmail({
        type: "tl_pod_escalated",
        invoiceId: doc.id,
        forceRecipient: true,
        to: lisa,
        subject: alert.subject,
        html: alert.html,
      });
      await doc.ref.update({
        "podFollowUp.status":
          podFollowup.POD_FOLLOW_UP_STATUS.ESCALATED,
        "podFollowUp.escalatedAt":
          admin.firestore.FieldValue.serverTimestamp(),
        "podFollowUp.lastEmailedAt":
          admin.firestore.FieldValue.serverTimestamp(),
        "podFollowUp.businessDaysElapsed": bd,
        "decisionStage": "tl_pod_escalated",
        "decisionReason":
          "No POD from carrier after 3 reminders (every 3 business days)",
        "finalWorkflowStatus": "tl_pod_escalated",
        "updatedAt": admin.firestore.FieldValue.serverTimestamp(),
      });
      escalated.push(doc.id);
      continue;
    }

    // Send next carrier reminder (1st / 2nd / 3rd).
    const nextReminder = reminderCount + 1;
    const request = podFollowup.buildCarrierPodRequestEmail({
      loadNumber: inv.loadNumber,
      carrierName: inv.carrierName,
      proNumber: inv.proNumber,
      invoiceNumber: inv.invoiceNumber,
      isReminder: true,
    });
    const payload = {
      type: "tl_pod_request_reminder",
      invoiceId: doc.id,
      subject: request.subject,
      html: request.html,
      forceRecipient: true,
    };
    if (fu.carrierEmail) {
      payload.to = fu.carrierEmail;
      payload.cc = lisa;
    } else {
      payload.to = lisa;
    }
    await saveOutboundEmail(payload);
    await doc.ref.update({
      "podFollowUp.status":
        podFollowup.POD_FOLLOW_UP_STATUS.REMINDED,
      "podFollowUp.reminderCount": nextReminder,
      "podFollowUp.reminderSentAt":
        admin.firestore.FieldValue.serverTimestamp(),
      "podFollowUp.lastEmailedAt":
        admin.firestore.FieldValue.serverTimestamp(),
      "podFollowUp.businessDaysElapsed": bd,
      "updatedAt": admin.firestore.FieldValue.serverTimestamp(),
    });
    reminded.push(doc.id);
  }

  return {checked: snap.size, reminded, escalated, resolved};
}

/**
 * Bound after innovative-primus init so checkStuckFlows can retry
 * transient Primus crashes without a circular require.
 * @type {function(): Promise<object>}
 */
let retryPendingTransientWorkflowsImpl = async () => ({
  checked: 0, kicked: [],
});

/**
 * Continues the stuck-flow checker (re-open so we can call follow-ups).
 */
exports.checkStuckFlows = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed. Use POST.",
      });
    }

    const cutoffMs = 20 * 60 * 1000;
    const now = Date.now();

    const lockedSnap = await db
        .collection("invoices")
        .where("processingLock", "==", true)
        .get();

    const results = [];
    for (const doc of lockedSnap.docs) {
      const inv = doc.data();
      const lastHb = inv.lastHeartbeatAt ? inv.lastHeartbeatAt.toDate() : null;
      if (!lastHb) {
        continue;
      }

      const ageMs = now - lastHb.getTime();
      if (ageMs < cutoffMs) {
        continue;
      }

      const flowId = inv.flowId || inv.gmailMessageId || doc.id;
      const carrier = inv.carrierName || "Unknown carrier";
      const loadNum = inv.loadNumber || "—";
      const amount = inv.invoiceAmount ? `$${inv.invoiceAmount}` : "—";
      const lastStep = inv.currentStep || inv.decisionStage || "unknown step";
      const stuckMins = Math.round(ageMs / 60000);

      await doc.ref.update({
        processingLock: false,
        finalWorkflowStatus: "failed",
        decisionStage: "stuck",
        decisionReason: "No heartbeat for 20+ minutes while locked",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const [logRows] = await bigquery.query({
        query: `
          SELECT * FROM \`${BQ_DATASET}.${BQ_LOGS_TABLE}\`
          WHERE flowId = @flowId
          ORDER BY timestamp ASC
        `,
        params: {flowId: String(flowId)},
      });

      const summary = logRows.length > 0 ?
        await summarizeSingleFlow(flowId, logRows) : null;
      const aiSum = summary && summary.summary;
      const summaryText = aiSum && aiSum.aiSummary ?
        `<p><strong>Summary:</strong> ` +
        `${escapeHtml(aiSum.aiSummary)}</p>` : "";
      const fixText = aiSum && aiSum.recommendedFix ?
        `<p><strong>Recommended fix:</strong> ` +
        `${escapeHtml(aiSum.recommendedFix)}</p>` : "";

      const stuckAlert = workflowErrors.buildWorkflowAlertEmail({
        code: "STUCK_FLOW",
        context: {
          loadNumber: loadNum,
          carrierName: carrier,
          stuckStep: lastStep,
          stuckMinutes: stuckMins,
          invoiceAmount: amount,
        },
      });
      await saveOutboundEmail({
        type: "stuck_flow",
        invoiceId: doc.id,
        subject: stuckAlert.subject,
        html: stuckAlert.html + summaryText + fixText +
          `<p style="color:#6b7280;font-size:12px">` +
          `Invoice ID: ${doc.id}</p>`,
      });

      results.push({
        invoiceId: doc.id,
        flowId,
        summaryStatus: summary && summary.summary ?
          summary.summary.finalStatus || "unknown" : "no_logs",
      });
    }

    let podFollowUps = {checked: 0, reminded: [], escalated: []};
    try {
      podFollowUps = await runPodFollowUpChecks();
    } catch (fuErr) {
      console.error("runPodFollowUpChecks from stuck:", fuErr.message);
    }

    let delayedRetries = {checked: 0, kicked: []};
    try {
      delayedRetries = await retryPendingTransientWorkflowsImpl();
    } catch (retryErr) {
      console.error("retryPendingTransientWorkflows from stuck:",
          retryErr.message);
    }

    return res.json({
      ok: true,
      checked: lockedSnap.size,
      stuck: results,
      podFollowUps,
      delayedRetries,
    });
  } catch (error) {
    console.error("checkStuckFlows error:", error);
    return res.status(500).json({
      ok: false,
      error: "Internal server error.",
      details: error.message,
    });
  }
});


exports.sendRateMissingEmail = onRequest(async (req, res) => {
  try {
    const invoiceId = (req.body && req.body.invoiceId) || req.query.invoiceId;

    if (!invoiceId) {
      return res.status(400).json({
        ok: false,
        error: "invoiceId is required.",
      });
    }

    const tenant = await tenantFromRequest(req);
    const invoiceRef = tcol(tenant, "invoices").doc(String(invoiceId));
    const snap = await invoiceRef.get();

    if (!snap.exists) {
      return res.status(404).json({
        ok: false,
        error: "Invoice not found.",
      });
    }

    const invoice = snap.data();
    const customerRate = invoice.customerRate;
    const invoiceAmount = Number(invoice.invoiceAmount || 0);
    const approvedChargesTotal =
      Number(invoice.approvedChargesTotal || 0);
    const profit = Number(customerRate || 0) -
      (invoiceAmount - approvedChargesTotal);

    const missingRate = !customerRate || Number(customerRate) <= 0;
    const lowMargin = !missingRate && profit < 10;

    if (!missingRate && !lowMargin) {
      return res.json({
        ok: true,
        sent: false,
        reason: "Rate present and margin OK.",
      });
    }

    await pauseWorkflow(
        invoiceRef,
        "get_rate",
        "needs_customer_rate_review",
        missingRate ? "Missing customer rate" : "Customer rate too low",
    );

    await notifyDispatcherRateIssue({
      req,
      code: missingRate ? "MISSING_RATE" : "LOW_MARGIN",
      invoiceId,
      tenantId: tenant.tenantId,
      loadNumber: invoice.loadNumber || invoiceId,
      context: {
        loadNumber: invoice.loadNumber || invoiceId,
        carrierName: invoice.carrierName,
        customerRate,
        profit,
        marginPct: customerRate > 0 ?
          Math.round((profit / customerRate) * 100) : 0,
        invoiceAmount,
      },
    });

    return res.json({ok: true, sent: true});
  } catch (error) {
    console.error("sendRateMissingEmail error:", error);
    return res.status(500).json({
      ok: false,
      error: "Internal server error.",
      details: error.message,
    });
  }
});

exports.continueWorkflow = onRequest(async (req, res) => {
  try {
    const invoiceId = (req.body && req.body.invoiceId) || req.query.invoiceId;

    if (!invoiceId) {
      return res.status(400).json({
        ok: false,
        error: "invoiceId is required.",
      });
    }

    const tenant = await tenantFromRequest(req);
    const invoiceRef = tcol(tenant, "invoices").doc(String(invoiceId));
    const snap = await invoiceRef.get();

    if (!snap.exists) {
      return res.status(404).json({
        ok: false,
        error: "Invoice not found.",
      });
    }

    const invoice = snap.data();
    const paused = invoice.workflowPausedAtStep;
    const loadNumber = invoice.loadNumber || "—";
    const wantsJson = req.query.format === "json" ||
      String(req.get("accept") || "").includes("application/json");

    await invoiceRef.update({
      workflowPausedAtStep: null,
      workflowPausedAt: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Resume the invoice's OWN tenant workflow (TAI or Primus), never a
    // hardcoded Primus default.
    const workflowUrl = workflowUrlForTenant(tenant);
    if (!workflowUrl) {
      return res.status(400).json({
        ok: false,
        error: `No workflow configured for tenant ${tenant.tenantId}.`,
      });
    }

    await writeLog("info", "workflow", "Resume Workflow clicked", {
      invoiceId,
      tenantId: tenant.tenantId,
      loadNumber: invoice.loadNumber || null,
      resumedFrom: paused || null,
    });

    const response = await fetch(
        workflowUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            invoiceId: invoiceId,
            tenantId: tenant.tenantId,
            resumeFrom: paused || null,
          }),
        },
    );

    const payload = await response.json().catch(() => ({}));
    const result = workflowErrors.interpretWorkflowResumeResult(
        response.ok, payload);
    const body = {
      ok: result.ok,
      resumedFrom: paused || null,
      workflow: payload,
      message: result.userMessage,
      code: result.code || null,
    };

    if (!wantsJson && req.method === "GET") {
      const color = result.ok ? "#16a34a" : "#dc2626";
      const title = result.ok ? "Workflow resumed" : "Could not resume";
      return res.status(result.ok ? 200 : 422).send(
          `<!doctype html><html><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width,` +
          `initial-scale=1"><title>${escapeHtml(title)}</title></head>` +
          `<body style="font-family:Arial,sans-serif;text-align:center;` +
          `padding:48px;color:#111827">` +
          `<h1 style="color:${color};margin-bottom:12px">` +
          `${escapeHtml(title)}</h1>` +
          `<p style="font-size:16px;color:#374151;max-width:520px;` +
          `margin:0 auto 16px;line-height:1.5">` +
          `${escapeHtml(result.userMessage)}</p>` +
          `<p style="font-size:13px;color:#9ca3af">Load ` +
          `${escapeHtml(String(loadNumber))}</p>` +
          `</body></html>`);
    }

    return res.status(result.ok ? 200 : 422).json(body);
  } catch (error) {
    console.error("continueWorkflow error:", error);
    return res.status(500).json({
      ok: false,
      error: "Internal server error.",
      details: error.message,
    });
  }
});

/**
 * Lisa enters a Primus load # for a regular invoice that had no load/PRO match.
 * GET shows form; POST saves load and reprocesses the Gmail message.
 */
exports.enterInvoiceLoadNumber = onRequest(async (req, res) => {
  try {
    const messageId = (req.body && req.body.messageId) ||
      (req.body && req.body.invoiceId) ||
      req.query.messageId || req.query.invoiceId;
    const itemIndex = String(
        (req.body && req.body.itemIndex) ||
        (req.body && req.body.option) ||
        req.query.itemIndex || req.query.option || "0",
    );
    const tenantId = (req.body && req.body.tenantId) || req.query.tenantId ||
      null;
    const exp = (req.body && req.body.exp) || req.query.exp;
    const sig = (req.body && req.body.sig) || req.query.sig;

    if (!messageId) {
      return res.status(400).send("Missing messageId.");
    }

    const tokenOk = emailActionTokens.verify({
      action: "invoiceLoadEntry",
      invoiceId: String(messageId),
      option: itemIndex,
      tenantId,
      exp,
      sig,
    });
    if (!tokenOk) {
      return res.status(403).send(
          "This link is invalid or expired. Ask Jerry to resend the request.");
    }

    const tenant = await tenantFromRequest(req);
    const intakeRef = tcol(tenant, "emailIntake").doc(String(messageId));
    const intakeSnap = await intakeRef.get();
    const intake = intakeSnap.exists ? intakeSnap.data() : null;

    if (req.method !== "POST") {
      const carrier = intake && intake.pendingLoadEntry ?
        intake.pendingLoadEntry.carrierName : null;
      const amount = intake && intake.pendingLoadEntry ?
        intake.pendingLoadEntry.invoiceAmount : null;
      const desc =
        `Carrier invoice${carrier ? ` from ${carrier}` : ""}` +
        `${amount != null ? ` ($${amount})` : ""} — enter the Primus ` +
        `load number so Jerry can process it.`;
      return res.status(200).send(buildEmailActionConfirmPage({
        title: "Enter load number",
        description: desc,
        confirmLabel: "Process invoice",
        confirmColor: "#2563eb",
        actionPath: "enterInvoiceLoadNumber",
        inputFields: [{
          name: "loadNumber",
          label: "Primus load number (6 digits)",
          type: "text",
          required: true,
          placeholder: "265551",
        }],
        fields: {
          messageId: String(messageId),
          invoiceId: String(messageId),
          itemIndex,
          option: itemIndex,
          tenantId: tenantId || "",
          exp: String(exp),
          sig: String(sig),
        },
      }));
    }

    const rawLoad = (req.body && req.body.loadNumber) || "";
    const normalizedLoad =
      invoiceLoadEntry.normalizeManualLoadNumber(rawLoad);
    if (!invoiceLoadEntry.isValidManualLoadNumber(normalizedLoad)) {
      return res.status(400).send(
          "Enter a valid 6-digit Primus load number (5-digit ok if missing " +
          "leading 2).");
    }

    let booking = null;
    try {
      booking = await fetchPrimusBooking(normalizedLoad);
    } catch (_) {
      booking = null;
    }
    if (!booking) {
      return res.status(400).send(
          `Load ${normalizedLoad} was not found in Primus. Check the number ` +
          `and try again.`);
    }

    const prior = intake && intake.manualLoadNumber ?
      String(intake.manualLoadNumber) : null;
    if (prior === normalizedLoad && intake.status === "processed") {
      return res.status(200).send(
          `<!doctype html><html><body style="font-family:Arial,sans-serif;` +
          `text-align:center;padding:48px"><h1 style="color:#16a34a">` +
          `Already submitted</h1><p>Load ${normalizedLoad} was already ` +
          `entered for this invoice.</p></body></html>`);
    }

    await intakeRef.set({
      manualLoadNumber: normalizedLoad,
      manualLoadItemIndex: Number(itemIndex) || 0,
      manualLoadEnteredBy: invoiceLoadEntry.LISA_EMAIL_DEFAULT,
      manualLoadEnteredAt: admin.firestore.FieldValue.serverTimestamp(),
      pendingLoadEntry: {
        status: "submitted",
        loadNumber: normalizedLoad,
        itemIndex: Number(itemIndex) || 0,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});

    const inboxFlowId = (intake && intake.inboxFlowId) ||
      (crypto.randomUUID && crypto.randomUUID()) ||
      String(Date.now());
    await reprocessGmailMessageForTenant(
        tenant, String(messageId), inboxFlowId);

    return res.status(200).send(
        `<!doctype html><html><body style="font-family:Arial,sans-serif;` +
        `text-align:center;padding:48px"><h1 style="color:#16a34a">` +
        `Load saved</h1><p>Jerry is reprocessing this invoice with load ` +
        `<strong>${escapeHtml(normalizedLoad)}</strong>.</p></body></html>`);
  } catch (error) {
    console.error("enterInvoiceLoadNumber error:", error);
    return res.status(500).send("Something went wrong. Please try again.");
  }
});

// Kept as a stub so Cloud Functions overwrites the old Approve/Reject handler
// instead of leaving it live. Customer invoice emails send automatically.
exports.approveCustomerEmail = onRequest(async (req, res) => {
  res.status(410).send(
      "Customer-email approval is no longer used. Invoice emails send " +
      "automatically.");
});

/**
 * HTML confirmation page for email action links. Scanners that prefetch GET
 * URLs stop here; only an explicit POST Confirm executes the action.
 * @param {object} opts Page options.
 * @return {string} HTML.
 */
function buildEmailActionConfirmPage(opts) {
  const fields = opts.fields || {};
  const btnColor = opts.confirmColor || "#2563eb";
  const formAction = `${functionsBaseUrl()}/${opts.actionPath}`;
  const hidden = Object.entries(fields)
      .map(([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" ` +
        `value="${escapeHtml(String(value ?? ""))}">`)
      .join("");
  const inputFields = Array.isArray(opts.inputFields) ? opts.inputFields : [];
  const inputs = inputFields.map((field) => {
    const attrs = [
      `type="${escapeHtml(field.type || "text")}"`,
      `name="${escapeHtml(field.name)}"`,
      `id="${escapeHtml(field.name)}"`,
      field.value != null && field.value !== "" ?
        `value="${escapeHtml(String(field.value))}"` : "",
      field.required ? "required" : "",
      field.min != null ? `min="${escapeHtml(String(field.min))}"` : "",
      field.step != null ? `step="${escapeHtml(String(field.step))}"` : "",
      field.placeholder ?
        `placeholder="${escapeHtml(field.placeholder)}"` : "",
    ].filter(Boolean).join(" ");
    return `<label for="${escapeHtml(field.name)}" ` +
      `style="display:block;font-size:14px;font-weight:600;` +
      `color:#374151;margin-bottom:6px">` +
      `${escapeHtml(field.label || field.name)}</label>` +
      `<input ${attrs} style="width:100%;max-width:240px;padding:10px 12px;` +
      `border:1px solid #d1d5db;border-radius:8px;font-size:16px;` +
      `margin-bottom:16px">`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(opts.title || "Confirm")}</title>` +
    `<style>@keyframes spin{to{transform:rotate(360deg)}}</style></head>` +
    `<body style="font-family:Arial,sans-serif;max-width:520px;` +
    `margin:48px auto;padding:0 16px;color:#111827">` +
    `<h1 style="font-size:22px;margin-bottom:12px">` +
    `${escapeHtml(opts.title || "Confirm action")}</h1>` +
    `<p style="font-size:16px;color:#374151;line-height:1.5">` +
    `${opts.description || ""}</p>` +
    `<form method="POST" action="${escapeHtml(formAction)}" ` +
    `style="margin-top:24px">` +
    hidden +
    inputs +
    `<button type="submit" style="background:${btnColor};` +
    `color:#fff;border:none;padding:12px 20px;border-radius:8px;` +
    `font-size:16px;font-weight:600;cursor:pointer">` +
    `${escapeHtml(opts.confirmLabel || "Confirm")}</button>` +
    `</form>` +
    `<p style="font-size:13px;color:#9ca3af;margin-top:20px">` +
    `If you did not request this, close this page - nothing has been ` +
    `changed yet.</p>` +
    `<script>` +
    `document.querySelector("form")?.addEventListener("submit",(e)=>{` +
    `const btn=e.target.querySelector('button[type="submit"]');` +
    `if(!btn||btn.disabled)return;btn.disabled=true;` +
    `btn.innerHTML='<span style="display:inline-block;width:16px;height:16px;` +
    `border:2px solid rgba(255,255,255,.35);border-top-color:#fff;` +
    `border-radius:50%;animation:spin .7s linear infinite;` +
    `vertical-align:-3px;margin-right:8px"></span>Processing…';` +
    `});` +
    `</script></body></html>`;
}

/**
 * Immediate acknowledgment page after POST — heavy work continues in background.
 * @param {object} opts Page options.
 * @return {string} HTML.
 */
function buildEmailActionProcessingPage(opts) {
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(opts.title || "Processing")}</title>` +
    `<style>@keyframes spin{to{transform:rotate(360deg)}}</style>` +
    `</head><body style="font-family:Arial,sans-serif;text-align:center;` +
    `padding:48px;color:#111827">` +
    `<div style="width:40px;height:40px;border:3px solid #e5e7eb;` +
    `border-top-color:#2563eb;border-radius:50%;animation:spin .8s linear ` +
    `infinite;margin:0 auto 20px"></div>` +
    `<h1 style="font-size:22px;margin-bottom:12px;color:#111827">` +
    `${escapeHtml(opts.title || "Processing your decision")}</h1>` +
    `<p style="font-size:16px;color:#374151;line-height:1.5;max-width:420px;` +
    `margin:0 auto">` +
    `${opts.message || "Jerry is updating billing now. You can close this " +
    "page — we will email if anything needs follow-up."}</p>` +
    (opts.loadNumber ?
      `<p style="font-size:13px;color:#9ca3af;margin-top:20px">Load ` +
      `${escapeHtml(String(opts.loadNumber))}</p>` : "") +
    `</body></html>`;
}

/**
 * Resolves the current customer sell rate for an invoice (Primus / doc).
 * @param {object} invoice Invoice document data.
 * @param {object|null} booking Primus booking, if already loaded.
 * @return {Promise<number>} Customer rate, or 0 if unknown.
 */
async function resolveCurrentCustomerRate(invoice, booking) {
  let baseRate = Number(invoice.customerRate || 0);
  if (!baseRate) {
    try {
      const rateResult = await getCustomerRate(
          invoice.loadNumber, invoice.proNumber);
      if (rateResult && rateResult.ok) {
        baseRate = Number(rateResult.customerRate || 0);
      }
    } catch (_) {
      baseRate = 0;
    }
  }
  if (!baseRate && booking) {
    const {rate} = readCustomerRateFromAcct(
        booking.accountingInformation || {});
    baseRate = Number(rate || 0);
  }
  if (!baseRate && booking) {
    baseRate = Number(customerRateFromBooking(booking) || 0);
  }
  return baseRate > 0 ? baseRate : 0;
}

/**
 * Atomically claims an additional-charge decision (blocks double-execute).
 * @param {object} invoiceRef Firestore invoice document reference.
 * @param {string} decision Decision letter A, B, C, D, or E.
 * @return {Promise<object>} Claim result with ok flag.
 */
async function claimAdditionalChargeDecision(invoiceRef, decision) {
  return admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(invoiceRef);
    if (!snap.exists) return {ok: false, reason: "not_found"};
    const invoice = snap.data();
    const charge = invoice.additionalCharge;
    if (!charge) return {ok: false, reason: "no_charge"};
    if (charge.decision) {
      return {ok: false, reason: "already", decision: charge.decision};
    }
    tx.update(invoiceRef, {
      "additionalCharge.decision": decision,
      "additionalCharge.decidedAt":
        admin.firestore.FieldValue.serverTimestamp(),
      "updatedAt": admin.firestore.FieldValue.serverTimestamp(),
    });
    return {ok: true, invoice};
  });
}

/**
 * Handles the A/B/C/D/E decision buttons from the additional-charge approval
 * email:
 *   a — pay carrier + bill customer (enter customer charge amount;
 *       auto-email the customer contact).
 *   b — pay carrier + bill customer (enter accessorial amounts / updated
 *       rate; dispatcher gets a ready customer-notification template).
 *   c — pay carrier only; customer rate unchanged.
 *   d — not approved; dispute draft generated for manual submission.
 *   e - pay carrier + bill customer (enter amount; bump rate; no separate
 *       customer notification - charge rides on the customer invoice).
 */
exports.additionalChargeAction = onRequest(
    {invoker: "public"}, handleAdditionalChargeAction);

/**
 * Implementation for the additionalChargeAction endpoint.
 * @param {object} req HTTPS request.
 * @param {object} res HTTPS response.
 * @return {Promise<object>} Express response.
 */
async function handleAdditionalChargeAction(req, res) {
  try {
    const invoiceId = (req.body && req.body.invoiceId) || req.query.invoiceId;
    const option = String(
        (req.body && req.body.option) || req.query.option || "",
    ).toLowerCase();
    const tenantId = (req.body && req.body.tenantId) || req.query.tenantId ||
      null;
    const exp = (req.body && req.body.exp) || req.query.exp;
    const sig = (req.body && req.body.sig) || req.query.sig;

    if (!invoiceId || !["a", "b", "c", "d", "e"].includes(option)) {
      return res.status(400).send(
          "Missing invoiceId or a valid option (a|b|c|d|e).");
    }

    const tokenOk = emailActionTokens.verify({
      action: "additionalCharge",
      invoiceId: String(invoiceId),
      option,
      tenantId,
      exp,
      sig,
    });
    if (!tokenOk) {
      return res.status(403).send(
          "This decision link is invalid or expired. Ask Jerry to resend " +
          "the approval email.");
    }

    const tenant = await tenantFromRequest(req);
    const invoiceRef = tcol(tenant, "invoices").doc(String(invoiceId));
    const snap = await invoiceRef.get();
    if (!snap.exists) {
      return res.status(404).send("Invoice not found.");
    }
    const invoice = snap.data();
    const charge = invoice.additionalCharge;
    if (!charge) {
      return res.status(400).send(
          "This invoice has no additional charge awaiting a decision.");
    }

    const htmlPage = (title, color, message) => res.status(200).send(
        `<!doctype html><html><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,` +
        `initial-scale=1"><title>${title}</title></head>` +
        `<body style="font-family:Arial,sans-serif;text-align:center;` +
        `padding:48px;color:#111827">` +
        `<h1 style="color:${color};margin-bottom:12px">${title}</h1>` +
        `<p style="font-size:16px;color:#374151">${message}</p>` +
        `<p style="font-size:13px;color:#9ca3af">Load ` +
        `${escapeHtml(String(invoice.loadNumber || invoiceId))}</p>` +
        `</body></html>`);

    if (charge.decision) {
      return htmlPage("Already decided", "#6b7280",
          `This charge was already handled (option ` +
          `${escapeHtml(String(charge.decision).toUpperCase())}).`);
    }

    const optionLabels = {
      a: "A - Pay carrier + bill customer (auto-email customer)",
      b: "B - Pay carrier + bill customer (enter updated rate; " +
        "dispatcher notifies customer)",
      c: "C - Pay carrier only (customer rate unchanged)",
      d: "D - Not approved (dispute with carrier)",
      e: "E - Pay carrier + bill customer (enter amount; apply rate; " +
        "no separate customer notification)",
    };

    if (req.method !== "POST") {
      const confirmOpts = {
        title: `Confirm option ${option.toUpperCase()}`,
        description:
          `Load ${invoice.loadNumber || invoiceId}: ` +
          `${optionLabels[option]}. Nothing is sent until you click Confirm.`,
        confirmLabel: `Confirm option ${option.toUpperCase()}`,
        confirmColor: option === "d" ? "#dc2626" :
          (option === "c" ? "#2563eb" :
            (option === "e" ? "#7c3aed" : "#16a34a")),
        actionPath: "additionalChargeAction",
        fields: {
          invoiceId: String(invoiceId),
          option,
          tenantId: tenantId || "",
          exp: String(exp),
          sig: String(sig),
        },
      };
      if (option === "a" || option === "e") {
        const currentRate = Number(invoice.customerRate) || 0;
        const defaultCharge = Number(charge.amount) || 0;
        const rateNote = currentRate > 0 ?
          ` Current customer rate: $${currentRate.toFixed(2)}.` : "";
        const isE = option === "e";
        confirmOpts.title = isE ? "Confirm option E" : "Confirm option A";
        confirmOpts.description =
          `Load ${invoice.loadNumber || invoiceId}: ` +
          `${optionLabels[option]}. Enter how much to charge the customer ` +
          `for this additional charge. The customer rate will be bumped by ` +
          `that amount` +
          (isE ?
            `; no separate customer notification is sent - the charge is ` +
            `included when the customer invoice goes out.` :
            ` and the customer will be emailed.`) +
          rateNote +
          ` Nothing is sent until you click Confirm.`;
        confirmOpts.confirmLabel = isE ?
          "Confirm option E" : "Confirm option A";
        confirmOpts.confirmColor = isE ? "#7c3aed" : "#16a34a";
        confirmOpts.inputFields = [{
          name: "customerChargeAmount",
          label: "Amount to charge the customer ($)",
          type: "number",
          required: true,
          min: "0.01",
          step: "0.01",
          placeholder: "0.00",
          value: defaultCharge > 0 ? defaultCharge.toFixed(2) : "",
        }];
        return res.status(200).send(buildEmailActionConfirmPage(confirmOpts));
      }
      if (option === "b") {
        const currentRate = Number(invoice.customerRate) || 0;
        return res.status(200).send(
            additionalCharges.buildOptionBAccessorialConfirmPage({
              title: "Confirm option B",
              description:
                `Load ${invoice.loadNumber || invoiceId}: ` +
                `${optionLabels[option]}. Enter each accessorial and the ` +
                `amount to bill the customer. The base customer rate stays ` +
                `the same; each accessorial is added as a separate invoice ` +
                `line. The dispatcher will get a ready customer-notification ` +
                `template.`,
              confirmLabel: "Confirm option B",
              confirmColor: "#0d9488",
              actionPath: "additionalChargeAction",
              baseUrl: functionsBaseUrl(),
              baseCustomerRate: currentRate,
              carrierCharges: Array.isArray(charge.charges) ?
                charge.charges : [],
              fields: {
                invoiceId: String(invoiceId),
                option,
                tenantId: tenantId || "",
                exp: String(exp),
                sig: String(sig),
              },
            }));
      }
      return res.status(200).send(buildEmailActionConfirmPage(confirmOpts));
    }

    const decision = option.toUpperCase();
    let optionBCustomerBillLines = null;
    let optionACustomerChargeAmount = null;
    if (option === "a" || option === "e") {
      const parsedAmount =
        additionalCharges.parseCustomerChargeAmountFromRequest(req.body || {});
      if (!parsedAmount.ok) {
        return res.status(400).send(parsedAmount.error ||
            `Option ${decision} requires a customer charge amount ` +
            `greater than 0.`);
      }
      optionACustomerChargeAmount = parsedAmount.amount;
    }
    if (option === "b") {
      const parsedLines = additionalCharges.parseCustomerBillLinesFromRequest(
          req.body || {});
      if (!parsedLines.ok) {
        return res.status(400).send(parsedLines.error ||
            "Option B requires valid accessorial billing lines.");
      }
      optionBCustomerBillLines = parsedLines.lines;
    }

    const claim = await claimAdditionalChargeDecision(invoiceRef, decision);
    if (!claim.ok) {
      if (claim.reason === "already") {
        return htmlPage("Already decided", "#6b7280",
            `This charge was already handled (option ` +
            `${escapeHtml(String(claim.decision).toUpperCase())}).`);
      }
      return res.status(400).send("Could not process this decision.");
    }

    const processingMessages = {
      a: "Option A recorded. Jerry is billing the customer and resuming " +
        "the workflow — you can close this page.",
      b: "Option B recorded. Jerry is updating accessorial billing and " +
        "resuming the workflow — you can close this page.",
      c: "Option C recorded. Jerry is paying the carrier and resuming the " +
        "workflow — you can close this page.",
      d: "Option D recorded. Jerry is generating the dispute draft — you " +
        "can close this page.",
      e: "Option E recorded. Jerry is updating the customer rate and " +
        "resuming the workflow — you can close this page.",
    };
    res.status(200).send(buildEmailActionProcessingPage({
      title: `Option ${decision} submitted`,
      message: processingMessages[option],
      loadNumber: invoice.loadNumber || invoiceId,
    }));

    try {
      const chargesTotal = Number(charge.amount) || 0;
      const chargeRows = Array.isArray(charge.charges) ? charge.charges : [];

      let booking = null;
      try {
        booking = await fetchPrimusBooking(invoice.loadNumber);
      } catch (_) {
        // Booking lookup is best-effort for emails below.
      }
      const customerName = invoice.customerName ||
        customerNameFromPrimusBooking(booking);
      const primusUiBridge = require("./primus-ui-bridge");

      if (option === "d") {
        // Not approved — generate the dispute draft for manual submission.
        const dispute = additionalCharges.buildDisputeEmailDraft({
          loadNumber: invoice.loadNumber,
          carrierName: invoice.carrierName,
          proNumber: invoice.proNumber,
          invoiceNumber: invoice.invoiceNumber,
          invoiceAmount: invoice.invoiceAmount,
          expectedAmount: invoice.primusAmount ||
            (Number(invoice.invoiceAmount) || 0) - chargesTotal,
          charges: chargeRows,
          category: charge.category,
          freightMismatch: charge.freightMismatch,
          hasCertificate: charge.hasCertificate,
          customerRate: invoice.customerRate ||
            customerRateFromBooking(booking),
        });
        await saveOutboundEmail(additionalCharges.applyAdditionalChargeEmailCc({
          type: "carrier_dispute_draft",
          invoiceId: String(invoiceId),
          subject: dispute.subject,
          html: dispute.html,
        }));
        await invoiceRef.update({
          "additionalCharge.decision": decision,
          "additionalCharge.approved": false,
          "additionalCharge.status": "disputed",
          "additionalCharge.decidedAt":
            admin.firestore.FieldValue.serverTimestamp(),
          "decisionStage": "additional_charge_disputed",
          "decisionReason": "Charge not approved — dispute draft generated",
          "finalWorkflowStatus": "failed",
          "updatedAt": admin.firestore.FieldValue.serverTimestamp(),
        });
        await additionalCharges.updateFollowUp(db, {
          invoiceId: String(invoiceId),
          status: additionalCharges.FOLLOW_UP_STATUS.DISPUTING,
          decision,
          notes: "Dispute draft emailed for manual submission",
        });
        await writeLog("info", "workflow",
            "Additional charge NOT approved — dispute draft generated", {
              invoiceId, loadNumber: invoice.loadNumber, decision,
            });
        return;
      }

      // Options a/b/c/e — the charge is approved for the carrier side.
      const billCustomer = option === "a" || option === "b" || option === "e";

      // A/E: approver enters customer charge amount; bump sell rate by that amount.
      // B: approver itemizes accessorials on the confirm page.
      let rateBumpNote = "";
      const approvalUpdate = {
        "additionalCharge.decision": decision,
        "additionalCharge.approved": true,
        "additionalCharge.billCustomer": billCustomer,
        "additionalCharge.notifyCustomer": option === "a" ? "auto" :
          (option === "b" ? "dispatcher" :
            (option === "e" ? "none" : null)),
        "additionalCharge.status": "approved",
        "additionalCharge.decidedAt":
          admin.firestore.FieldValue.serverTimestamp(),
        // Clear the gates so the workflow can proceed with the full carrier
        // amount (baseAmount excludes the approved charge).
        "unrecognizedCharges": [],
        "chargesNeedProof": [],
        "decisionStage": "additional_charge_approved",
        "decisionReason": `Additional charge approved (option ${decision})`,
        "finalWorkflowStatus": "created",
        "workflowPausedAtStep": null,
        "workflowPausedAt": null,
        "updatedAt": admin.firestore.FieldValue.serverTimestamp(),
      };

      if ((option === "a" || option === "e") &&
          optionACustomerChargeAmount > 0) {
        const baseRate = await resolveCurrentCustomerRate(invoice, booking);
        const billAmount = optionACustomerChargeAmount;
        approvalUpdate["additionalCharge.customerChargeAmount"] = billAmount;
        approvalUpdate["additionalCharge.rateBumpAmount"] = billAmount;
        if (baseRate > 0) {
          const bumpedRate =
            Math.round((baseRate + billAmount) * 100) / 100;
          approvalUpdate.customerRate = bumpedRate;
          approvalUpdate["additionalCharge.originalCustomerRate"] = baseRate;
          approvalUpdate["additionalCharge.bumpedCustomerRate"] = bumpedRate;
          rateBumpNote = ` Customer charged $${billAmount.toFixed(2)}; ` +
            `rate bumped from $${baseRate.toFixed(2)} to ` +
            `$${bumpedRate.toFixed(2)}.`;
          invoice.customerRate = bumpedRate;
        } else {
          rateBumpNote = ` Customer charge amount $${billAmount.toFixed(2)} ` +
            `recorded, but the current customer rate could not be resolved - ` +
            `please bump it manually before invoicing.`;
        }
      } else if (billCustomer && chargesTotal > 0 && option === "b") {
        const baseRate = await resolveCurrentCustomerRate(invoice, booking);
        const billLines = optionBCustomerBillLines || [];
        const billExtra = additionalCharges.sumCustomerBillLines(billLines);
        approvalUpdate["additionalCharge.customerBillLines"] = billLines;
        approvalUpdate["additionalCharge.customerBillAccessorialTotal"] =
          billExtra;
        approvalUpdate["additionalCharge.originalCustomerRate"] =
          baseRate > 0 ? baseRate : null;
        rateBumpNote = baseRate > 0 ?
          ` Base customer rate stays $${baseRate.toFixed(2)}.` :
          " Base customer rate unchanged.";
        rateBumpNote += ` Billing ${billLines.length} accessorial line(s)` +
          ` ($${billExtra.toFixed(2)}).`;
      }

      await invoiceRef.update(approvalUpdate);

      let extraNote = rateBumpNote;
      let skipDispatcherNotify = false;
      if (option === "a") {
        // Auto-notify the customer contact on file.
        let customerEmail = null;
        try {
          const emails = await primusUiBridge
              .resolveCustomerAccountingEmails(booking);
          customerEmail = emails.emails && emails.emails[0] || null;
        } catch (_) {
          customerEmail = null;
        }
        if (customerEmail) {
          const note = additionalCharges.buildCustomerChargeNotificationEmail({
            customerName,
            loadNumber: invoice.loadNumber,
            charges: chargeRows,
            chargesTotal: optionACustomerChargeAmount != null ?
              optionACustomerChargeAmount : chargesTotal,
            category: charge.category,
            customerRate: invoice.customerRate ||
              customerRateFromBooking(booking),
          });
          await saveOutboundEmail(
              additionalCharges.applyAdditionalChargeEmailCc({
                type: "additional_charge_customer_notice",
                invoiceId: String(invoiceId),
                forceRecipient: true,
                to: customerEmail,
                subject: note.subject,
                html: note.html,
                skipAgentGreeting: true,
              }));
          extraNote += ` The customer was notified at ${customerEmail}.`;
        } else {
          extraNote += " Could not resolve the customer email from Primus — " +
            "please notify the customer manually.";
        }
        await additionalCharges.updateFollowUp(db, {
          invoiceId: String(invoiceId),
          status: additionalCharges.FOLLOW_UP_STATUS.APPROVED_BILLED,
          decision,
          notes: extraNote.trim(),
        });
      } else if (option === "e") {
        // Same billing as A, but skip the separate customer notification —
        // the additional charge is included on the customer invoice.
        extraNote += " No separate customer notification sent; charge will " +
          "be included on the customer invoice.";
        await additionalCharges.updateFollowUp(db, {
          invoiceId: String(invoiceId),
          status: additionalCharges.FOLLOW_UP_STATUS.APPROVED_BILLED,
          decision,
          notes: extraNote.trim(),
        });
      } else if (option === "b") {
        // Dispatcher notifies the customer — unless Primus already reconciles
        // the carrier total (line item is breakdown only, not a real overage).
        try {
          const reCheck = await reconcileUnrecognizedChargesWithPrimus(
              invoice.loadNumber,
              invoice.invoiceAmount,
              chargeRows);
          if (reCheck.override) {
            skipDispatcherNotify = true;
            extraNote += " Carrier invoice total already matches Primus" +
              (reCheck.totalMatches ? " (within $10)" :
                reCheck.chargesInPrimus ?
                  " (charge already in vendor breakdown)" :
                  " (invoice at/under Primus cost)") +
              " — dispatcher customer notification skipped.";
            await writeLog("info", "workflow",
                "Option B: skipped dispatcher notify — Primus reconciled", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  invoiceAmount: invoice.invoiceAmount,
                  vendorCost: reCheck.vendorCost,
                  totalMatches: reCheck.totalMatches,
                  chargesInPrimus: reCheck.chargesInPrimus,
                });
          }
        } catch (_) {
          // Best-effort; still notify dispatcher if re-check fails.
        }

        if (!skipDispatcherNotify) {
          // Dispatcher must notify the customer — remind them / task it.
          let dispatcher = {ok: false};
          try {
            dispatcher = await primusUiBridge.resolveDispatcherEmail({
              booking,
              loadNumber: invoice.loadNumber,
              fetchBooking: fetchPrimusBooking,
            });
          } catch (err) {
            dispatcher = {ok: false, error: err.message};
          }
          const reminder = additionalCharges.buildDispatcherNotifyReminderEmail({
            dispatcherName: dispatcher.displayName || dispatcher.userName || null,
            loadNumber: invoice.loadNumber,
            carrierName: invoice.carrierName,
            customerName,
            charges: chargeRows,
            chargesTotal,
            customerRate: await resolveCurrentCustomerRate(invoice, booking),
            customerBillLines:
              approvalUpdate["additionalCharge.customerBillLines"] || [],
          });
          const podFollowup = require("./pod-followup");
          const approver = process.env.ADDITIONAL_CHARGE_APPROVER_EMAIL ||
            podFollowup.SARAH_EMAIL;
          const reminderPayload = {
            type: "additional_charge_dispatcher_task",
            invoiceId: String(invoiceId),
            subject: reminder.subject,
            html: reminder.html,
          };
          if (dispatcher.ok && dispatcher.email) {
            reminderPayload.forceRecipient = true;
            reminderPayload.to = dispatcher.email;
            if (approver) reminderPayload.cc = approver;
            extraNote += ` The dispatcher (${dispatcher.email}) was reminded ` +
              `to notify the customer.`;
          } else {
            extraNote += " Could not resolve the dispatcher email — the " +
              "reminder went to the ops mailbox instead.";
          }
          await saveOutboundEmail(additionalCharges.applyDispatcherEmailCc(
              additionalCharges.applyAdditionalChargeEmailCc(reminderPayload)));
        }

        await additionalCharges.updateFollowUp(db, {
          invoiceId: String(invoiceId),
          status: skipDispatcherNotify ?
            additionalCharges.FOLLOW_UP_STATUS.APPROVED_BILLED :
            additionalCharges.FOLLOW_UP_STATUS
                .APPROVED_BILLED_DISPATCHER_NOTIFIES,
          decision,
          notes: extraNote.trim(),
        });
      } else {
        // Option c — carrier only, customer rate unchanged.
        await additionalCharges.updateFollowUp(db, {
          invoiceId: String(invoiceId),
          status: additionalCharges.FOLLOW_UP_STATUS.APPROVED_CARRIER_ONLY,
          decision,
          notes: "Carrier paid in full; customer not billed",
        });
      }

      // Resume the billing workflow with the charge approved.
      const workflowUrl = workflowUrlForTenant(tenant);
      if (workflowUrl) {
        fetch(workflowUrl, {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({
            invoiceId: String(invoiceId),
            tenantId: tenant.tenantId,
          }),
        }).catch((e) =>
          console.error("additionalChargeAction: resume failed", e.message));
      }

      await writeLog("info", "workflow",
          "Additional charge approved — workflow resumed", {
            invoiceId,
            loadNumber: invoice.loadNumber,
            decision,
            billCustomer,
          });
    } catch (bgError) {
      console.error("additionalChargeAction background error:", bgError);
      await writeLog("error", "workflow",
          "Additional charge decision background processing failed", {
            invoiceId: String(invoiceId),
            loadNumber: invoice.loadNumber,
            decision,
            error: bgError.message,
          }).catch(() => {});
    }
    return;
  } catch (error) {
    console.error("additionalChargeAction error:", error);
    return res.status(500).send("Internal server error.");
  }
}

/**
 * Additional Charges Follow-Up list — open items first, newest first.
 */
exports.getAdditionalCharges = onRequest(
    {invoker: "public"}, handleGetAdditionalCharges);

/**
 * Implementation for the getAdditionalCharges endpoint.
 * @param {object} req HTTPS request.
 * @param {object} res HTTPS response.
 * @return {Promise<object>} Express response.
 */
async function handleGetAdditionalCharges(req, res) {
  if (applyDashboardCors(req, res)) return;
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const snap = await db.collection(additionalCharges.FOLLOW_UP_COLLECTION)
        .orderBy("createdAt", "desc")
        .limit(limit)
        .get();
    const items = [];
    snap.forEach((doc) => {
      const d = doc.data();
      items.push({
        id: doc.id,
        loadNumber: d.loadNumber,
        carrierName: d.carrierName,
        customerName: d.customerName,
        invoiceId: d.invoiceId,
        category: d.category,
        chargesTotal: d.chargesTotal,
        invoiceAmount: d.invoiceAmount,
        status: d.status,
        decision: d.decision,
        resolved: !!d.resolved,
        notes: d.notes || null,
        createdAt: d.createdAt && d.createdAt.toDate ?
          d.createdAt.toDate().toISOString() : null,
        updatedAt: d.updatedAt && d.updatedAt.toDate ?
          d.updatedAt.toDate().toISOString() : null,
      });
    });
    const open = items.filter((i) => !i.resolved);
    const closed = items.filter((i) => i.resolved);
    return res.json({ok: true, open, closed, total: items.length});
  } catch (error) {
    console.error("getAdditionalCharges error:", error);
    return res.status(500).json({ok: false, error: error.message});
  }
}

exports.sendGeneratedBillEmail = onRequest(async (req, res) => {
  try {
    const invoiceId = (req.body && req.body.invoiceId) || req.query.invoiceId;

    if (!invoiceId) {
      return res.status(400).json({
        ok: false,
        error: "invoiceId is required.",
      });
    }

    const tenant = await tenantFromRequest(req);
    const invoiceRef = tcol(tenant, "invoices").doc(String(invoiceId));
    const snap = await invoiceRef.get();

    if (!snap.exists) {
      return res.status(404).json({
        ok: false,
        error: "Invoice not found.",
      });
    }

    const invoice = snap.data();

    const attachmentsToSend = [];
    const workingProNumber = invoice.proNumber || "";

    const customerInvoicePdfBase64 = await buildCustomerInvoicePdfBase64({
      invoiceId,
      loadNumber: invoice.loadNumber,
      proNumber: workingProNumber,
      customerName: invoice.customerName,
      customerRate: invoice.customerRate,
      carrierInvoiceAmount: invoice.invoiceAmount,
    });

    attachmentsToSend.push({
      filename: `customer-invoice-${invoiceId}.pdf`,
      contentType: "application/pdf",
      contentBase64: customerInvoicePdfBase64,
    });

    const podStoragePath =
      (invoice.podOnlyFile && invoice.podOnlyFile.storagePath) ||
      null;

    if (podStoragePath) {
      const podBase64 = await downloadStorageFileBase64(podStoragePath);
      if (podBase64) {
        attachmentsToSend.push({
          filename: `pod-${invoiceId}.pdf`,
          contentType: "application/pdf",
          contentBase64: podBase64,
        });
      }
    }

    const proofFiles = Array.isArray(invoice.approvedChargeProofFiles) ?
      invoice.approvedChargeProofFiles : [];
    for (const proof of proofFiles) {
      if (!proof || !proof.storagePath) {
        continue;
      }
      const proofBase64 = await downloadStorageFileBase64(proof.storagePath);
      if (!proofBase64) {
        continue;
      }
      attachmentsToSend.push({
        filename: `${String(proof.type || "charge")}-${invoiceId}.pdf`,
        contentType: "application/pdf",
        contentBase64: proofBase64,
      });
    }

    await saveOutboundEmail({
      type: "generated_bill",
      invoiceId,
      subject: "Generated bill ready",
      html: `<p>Generated bill for invoice ${invoiceId}.</p>`,
      attachments: attachmentsToSend,
    });

    return res.json({ok: true});
  } catch (error) {
    console.error("sendGeneratedBillEmail error:", error);
    return res.status(500).json({
      ok: false,
      error: "Internal server error.",
      details: error.message,
    });
  }
});

/**
 * Writes detailed log to Firestore for debugging and monitoring.
 * @param {string} level Log level (info, warn, error).
 * @param {string} category Log category (mail, primus, ai, storage, general).
 * @param {string} message Log message.
 * @param {object} details Additional details object.
 * @param {string} messageId Gmail message ID if applicable.
 * @param {object} [tenant] Tenant config for namespaced logs.
 * @return {Promise<void>}
 */
async function writeLog(
    level,
    category,
    message,
    details = {},
    messageId = null,
    tenant = null,
) {
  try {
    const cleanDetails = JSON.parse(JSON.stringify(details, (key, value) => {
      return value === undefined ? null : value;
    }));

    const resolvedMessageId = cleanDetails.gmailMessageId ||
      cleanDetails.messageId ||
      messageId ||
      null;
    const resolvedInvoiceId = cleanDetails.invoiceId || null;
    const resolvedFlowId = cleanDetails.flowId ||
      cleanDetails.gmailMessageId ||
      resolvedMessageId ||
      resolvedInvoiceId ||
      (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    const resolvedCurrentStep = cleanDetails.currentStep || null;

    // Dataset resolution order: explicit tenant arg → ambient tenant context
    // (set per message/request) → dataset carried in details → default. This
    // keeps single-tenant behavior unchanged while routing tenant logs to
    // their own dataset.
    const ambient = currentTenant();
    const dataset = (tenant && tenant.bqDataset) ||
      (ambient && ambient.bqDataset) ||
      (cleanDetails && cleanDetails.bqDataset) ||
      BQ_DATASET;

    bigquery
        .dataset(dataset)
        .table(BQ_LOGS_TABLE)
        .insert([{
          timestamp: new Date().toISOString(),
          flowId: resolvedFlowId,
          messageId: resolvedMessageId,
          invoiceId: resolvedInvoiceId,
          category: category,
          level: level,
          message: message,
          currentStep: resolvedCurrentStep,
          details: JSON.stringify(cleanDetails),
        }])
        .catch((error) => {
          console.error(`Failed to write log to BigQuery: ${error.message}`);
          console.log(
              `[${level.toUpperCase()}] ${category}: ${message}`,
              details,
          );
        });
  } catch (error) {
    console.error(`Failed to write log to BigQuery: ${error.message}`);
    console.log(
        `[${level.toUpperCase()}] ${category}: ${message}`,
        details,
    );
  }
}

/**
 * Updates workflow heartbeat fields on an invoice document.
 * @param {FirebaseFirestore.DocumentReference} invoiceRef Invoice reference.
 * @param {string|null} currentStep Current step name.
 * @param {object} extraUpdates Additional fields to update.
 * @return {Promise<void>}
 */
async function setWorkflowHeartbeat(
    invoiceRef,
    currentStep,
    extraUpdates = {},
) {
  await invoiceRef.update({
    lastHeartbeatAt: admin.firestore.FieldValue.serverTimestamp(),
    currentStep: currentStep || null,
    ...extraUpdates,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

exports.processInvoice = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed. Use POST.",
      });
    }

    const body = req.body || {};

    const proNumber = body.proNumber || null;
    const loadNumber = body.loadNumber || null;
    const invoiceAmount = body.invoiceAmount;
    const carrierName = body.carrierName || null;
    const invoiceNumber = body.invoiceNumber || null;
    const charges = Array.isArray(body.charges) ? body.charges : [];
    const attachments = Array.isArray(body.attachments) ?
      body.attachments :
      [];

    if (!proNumber && !loadNumber) {
      return res.status(400).json({
        ok: false,
        error: "proNumber or loadNumber is required.",
      });
    }

    if (
      invoiceAmount === undefined ||
      invoiceAmount === null ||
      invoiceAmount === ""
    ) {
      return res.status(400).json({
        ok: false,
        error: "invoiceAmount is required.",
      });
    }

    const amount = Number(invoiceAmount);

    if (Number.isNaN(amount)) {
      return res.status(400).json({
        ok: false,
        error: "invoiceAmount must be a valid number.",
      });
    }

    const decisionStage = "pending_primus_check";

    const tenant = await tenantFromRequest(req);
    const docRef = await tcol(tenant, "invoices").add({
      tenantId: tenant.tenantId,
      tms: tenant.tms,
      carrierName: carrierName,
      invoiceNumber: invoiceNumber,
      proNumber: proNumber,
      loadNumber: loadNumber,
      invoiceAmount: amount,
      charges: charges,
      attachments: attachments,
      status: "received",
      matchStatus: "not_checked",
      reviewStatus: "not_needed",
      decisionStage: decisionStage,
      primusLoadId: null,
      primusAmount: null,
      amountDifference: null,
      decisionReason: "Waiting for Primus lookup.",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      deleteAt: getDeleteAt(7),
    });

    return res.json({
      ok: true,
      message: "Invoice saved successfully.",
      invoiceId: docRef.id,
      decisionStage: decisionStage,
    });
  } catch (error) {
    console.error("processInvoice error:", error);

    return res.status(500).json({
      ok: false,
      error: "Internal server error.",
      details: error.message,
    });
  }
});

exports.checkInvoiceAgainstPrimus = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed. Use POST.",
      });
    }

    const body = req.body || {};
    const invoiceId = body.invoiceId;

    if (!invoiceId) {
      return res.status(400).json({
        ok: false,
        error: "invoiceId is required.",
      });
    }

    const tenant = await tenantFromRequest(req);
    const invoiceRef = tcol(tenant, "invoices").doc(invoiceId);
    const invoiceSnap = await invoiceRef.get();

    if (!invoiceSnap.exists) {
      return res.status(404).json({
        ok: false,
        error: "Invoice not found.",
      });
    }

    const invoice = invoiceSnap.data();
    const invoiceAmount = Number(invoice.invoiceAmount);

    const fakePrimusAmount = invoiceAmount;
    const amountDifference = Math.abs(invoiceAmount - fakePrimusAmount);

    let decisionStage = "amount_matched";
    let reviewStatus = "not_needed";
    let decisionReason = "Invoice matches Primus amount.";

    if (amountDifference > 5) {
      decisionStage = "needs_charge_review";
      reviewStatus = "needed";
      decisionReason = "Difference is more than $5.";
    }

    const primusLoadId = invoice.loadNumber || null;

    await invoiceRef.update({
      matchStatus: "matched",
      primusLoadId: primusLoadId,
      primusAmount: fakePrimusAmount,
      amountDifference: amountDifference,
      decisionStage: decisionStage,
      reviewStatus: reviewStatus,
      decisionReason: decisionReason,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      ok: true,
      invoiceId: invoiceId,
      primusAmount: fakePrimusAmount,
      amountDifference: amountDifference,
      decisionStage: decisionStage,
      reviewStatus: reviewStatus,
      decisionReason: decisionReason,
    });
  } catch (error) {
    console.error("checkInvoiceAgainstPrimus error:", error);

    return res.status(500).json({
      ok: false,
      error: "Internal server error.",
      details: error.message,
    });
  }
});

/**
 * Creates Gmail OAuth client.
 * @return {google.auth.OAuth2} Gmail OAuth client.
 */
function getGmailOAuthClient() {
  return mailProvider.getGmailOAuthClient();
}

/**
 * Returns true when a buffer starts with the PDF magic bytes (%PDF).
 * @param {Buffer} fileBuffer File bytes.
 * @return {boolean} Whether the buffer looks like a PDF.
 */
function isPdfMagicBytes(fileBuffer) {
  return Boolean(fileBuffer) &&
    fileBuffer.length >= 4 &&
    fileBuffer[0] === 0x25 &&
    fileBuffer[1] === 0x50 &&
    fileBuffer[2] === 0x44 &&
    fileBuffer[3] === 0x46;
}

/** Filters logos/tiny stubs; compact carrier invoices can be ~5–8 KB. */
const MIN_PDF_ATTACHMENT_BYTES = 5000;
/** INV*.pdf-style names (e.g. Forward Air) may be smaller but valid. */
const MIN_INVOICE_LIKE_PDF_BYTES = 3000;

/**
 * True when the filename suggests a carrier invoice PDF.
 * @param {string} filename Attachment filename.
 * @return {boolean}
 */
function looksLikeInvoicePdfFilename(filename) {
  const base = String(filename || "").replace(/\.[^.]+$/, "");
  const name = base.toLowerCase();
  return /^(inv|invoice)[\d_.-]/i.test(base) ||
    /invoice|inv[\d_-]|carrier.?bill|freight.?inv/i.test(name);
}

/**
 * Minimum PDF byte size for intake, keyed off filename heuristics.
 * @param {object} attachment Attachment metadata.
 * @return {number}
 */
function minPdfBytesForAttachment(attachment) {
  if (looksLikeInvoicePdfFilename(attachment && attachment.filename)) {
    return MIN_INVOICE_LIKE_PDF_BYTES;
  }
  return MIN_PDF_ATTACHMENT_BYTES;
}

/**
 * @param {object} attachment Attachment metadata.
 * @param {Buffer} fileBuffer File bytes.
 * @return {boolean}
 */
function isPdfAttachment(attachment, fileBuffer) {
  const mime = String(attachment && attachment.mimeType || "").toLowerCase();
  return mime === "application/pdf" || isPdfMagicBytes(fileBuffer);
}

/**
 * @param {object} attachment Attachment metadata.
 * @param {Buffer} fileBuffer File bytes.
 * @return {boolean}
 */
function isPdfTooSmallForIntake(attachment, fileBuffer) {
  if (!isPdfAttachment(attachment, fileBuffer)) return false;
  return fileBuffer.length < minPdfBytesForAttachment(attachment);
}

/**
 * Returns true if an attachment should be processed (PDF, not too small).
 * @param {object} attachment - Attachment metadata.
 * @param {Buffer} fileBuffer - File bytes.
 * @return {boolean}
 */
function shouldProcessAttachment(attachment, fileBuffer) {
  const mime = String(attachment && attachment.mimeType || "").toLowerCase();
  const name = String(attachment && attachment.filename || "").toLowerCase();
  // Nested .eml / RFC822 wrappers are expanded separately.
  if (mime.includes("message/rfc822") || name.endsWith(".eml")) {
    return false;
  }
  // ZIP packets are expanded into PDF/image attachments separately.
  if (invoiceZipAttachments.isZipAttachment(attachment, fileBuffer)) {
    return false;
  }
  if (!isPdfAttachment(attachment, fileBuffer)) return false;
  if (isPdfTooSmallForIntake(attachment, fileBuffer)) return false;
  return true;
}

/**
 * Extracts the first page of a PDF as a new single-page PDF buffer.
 * @param {Buffer} pdfBuffer - Full PDF buffer.
 * @return {Promise<Buffer>} Single-page PDF buffer.
 */
async function extractFirstPage(pdfBuffer) {
  const fullPdf = await PDFDocument.load(pdfBuffer);
  const singlePage = await PDFDocument.create();
  const [firstPage] = await singlePage.copyPages(fullPdf, [0]);
  singlePage.addPage(firstPage);
  return Buffer.from(await singlePage.save());
}

/**
 * Checks the document type using Claude Vision on the first page only.
 * Returns INVOICE, STATEMENT, INSURANCE, POD, or OTHER.
 * @param {Buffer} pdfBuffer - Full PDF buffer.
 * @return {Promise<string>} Document type.
 */
async function preCheckDocumentType(pdfBuffer) {
  const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
  const firstPageBuffer = await extractFirstPage(pdfBuffer);
  const base64 = firstPageBuffer.toString("base64");

  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 20,
    messages: [{
      role: "user",
      content: [
        {
          type: "document",
          source: {type: "base64", media_type: "application/pdf", data: base64},
        },
        {
          type: "text",
          text: "What type of document is this? Reply with exactly one word: " +
            "INVOICE, STATEMENT, INSURANCE, POD, or OTHER. " +
            "Use INVOICE when the PDF contains carrier freight bill(s) " +
            "to pay, even if the first page is only a statement summary " +
            "(common for Saia, AAA Cooper, JTS Express numbered " +
            "Statement packets, and other LTL carriers — later pages " +
            "are the actual invoices). Also use INVOICE when the first " +
            "page is a Notice of Assignment, factor cover letter, or " +
            "ACH/banking remittance page and later pages are the " +
            "freight bill (Thunder Funding, REV Capital, and similar " +
            "factoring companies). Also use INVOICE when the PDF is a " +
            "Weight & Inspection (W&I / WNI) class-correction or reweigh " +
            "certificate that shows a revised class, weight, or rate.",
        },
      ],
    }],
  });

  if (!response.content || response.content.length === 0) return "OTHER";
  const block = response.content[0];
  if (!block || block.type !== "text" || !block.text) return "OTHER";
  const word = block.text.trim().toUpperCase().split(/\s+/)[0]
      .replace(/[^A-Z]/g, "");
  return ["INVOICE", "STATEMENT", "INSURANCE", "POD"].includes(word) ?
    word : "OTHER";
}

/**
 * @param {Buffer} pdfBuffer Full PDF buffer.
 * @return {Promise<number>} Page count, or 0 on failure.
 */
async function getPdfPageCount(pdfBuffer) {
  try {
    const pdf = await PDFDocument.load(pdfBuffer);
    return pdf.getPageCount();
  } catch (_) {
    return 0;
  }
}

const STATEMENT_FORWARD_EMAIL_DEFAULT = "abe@innovativecarriers.com";

/**
 * Parses email addresses from a RFC822 To/Cc header value.
 * @param {string} headerValue Raw header value.
 * @return {string[]} Lowercase email addresses.
 */
function parseEmailAddressesFromHeaderValue(headerValue) {
  const raw = String(headerValue || "");
  const matches = raw.match(
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
  return matches ? matches.map((addr) => addr.toLowerCase()) : [];
}

/**
 * Pulls the bare address from a From header value.
 * @param {string} from Raw From header.
 * @return {string|null}
 */
function extractSenderEmailFromHeader(from) {
  const addrs = parseEmailAddressesFromHeaderValue(from);
  return addrs.length ? addrs[0] : null;
}

/**
 * True when Abe is already on the original email (To or Cc).
 * @param {Array<object>} headers Gmail payload headers.
 * @return {boolean}
 */
function isAbeCopiedOnEmail(headers) {
  return administrativeEmailIntake.isAbeCopiedOnEmailHeaders(headers);
}

/**
 * Completes or forwards a statement-only email (no freight invoice to enter).
 * @param {object} args Handler arguments.
 * @return {Promise<void>}
 */
async function handleStatementOnlyEmail(args) {
  const {
    gmail, messageId, subject, from, emailBody, tenant, headers,
    emailClassification, reason, queueDocId,
  } = args;
  const docId = queueDocId || messageId;
  const intakeExtra = {
    gmailMessageId: messageId,
    subject,
    from,
    emailClassification: emailClassification || null,
    deleteAt: getDeleteAt(mailIntakeQueue.INTAKE_TTL_DAYS),
  };

  if (isAbeCopiedOnEmail(headers)) {
    await writeLog("info", "mail",
        "Statement-only email — Abe already copied, ignoring", {
          messageId,
          subject,
          classification: emailClassification || null,
        });
    await mailIntakeQueue.completeIntakeRecord({
      tenant,
      docId,
      parentMessageId: messageId,
      outcome: mailIntakeQueue.OUTCOME.IGNORED,
      finalStatus: "statement_ignored_abe_cc",
      extra: intakeExtra,
    });
    return;
  }

  const classifierNote = emailClassification &&
    emailClassification.reasoning ?
    `\nClassifier note: ${emailClassification.reasoning}` : "";
  const forwardReason =
    reason || "Carrier account statement — no freight invoice to process";
  await forwardToHumanReview(
      gmail, messageId, subject, from,
      forwardReason,
      `Hi, I'm ${AI_AGENT_NAME}, your AI assistant.\n\n` +
      `This email appears to be a carrier account statement only — ` +
      `there is no freight invoice for me to enter. Please verify in ` +
      `Primus whether these charges are already entered.${classifierNote}\n\n` +
      `Thank you,\n${AI_AGENT_NAME}`,
      {department: "statement", emailBody},
  );
  await mailIntakeQueue.completeIntakeRecord({
    tenant,
    docId,
    parentMessageId: messageId,
    outcome: mailIntakeQueue.OUTCOME.FORWARDED,
    finalStatus: "statement_forwarded",
    forwardReason,
    extra: intakeExtra,
  });
}

/**
 * Forwards a drayage invoice to Leo for validation.
 * @param {object} args Handler arguments.
 * @return {Promise<void>}
 */
async function handleDrayageInvoiceEmail(args) {
  const {
    gmail, messageId, subject, from, emailBody, tenant,
    queueDocId, containerNumber, carrierName, reason,
  } = args;
  const docId = queueDocId || messageId;
  const forwardReason =
    reason || "Drayage invoice — carrier identified as drayage";
  const intakeExtra = {
    gmailMessageId: messageId,
    subject,
    from,
    containerNumber: containerNumber || null,
    deleteAt: getDeleteAt(mailIntakeQueue.INTAKE_TTL_DAYS),
  };
  await forwardToHumanReview(
      gmail, messageId, subject, from,
      forwardReason,
      drayageIntake.buildLeoForwardNotes({
        containerNumber,
        carrierName,
      }),
      {
        department: "drayage",
        emailBody,
        extractedData: {
          "Container #": containerNumber || "—",
          "Carrier": carrierName || "—",
        },
      },
  );
  await mailIntakeQueue.completeIntakeRecord({
    tenant,
    docId,
    parentMessageId: messageId,
    outcome: mailIntakeQueue.OUTCOME.FORWARDED,
    finalStatus: "drayage_forwarded",
    forwardReason,
    extra: intakeExtra,
  });
}

/**
 * Emails Lisa when Leo's drayage reply is missing required Primus fields.
 * @param {object} args Handler arguments.
 * @return {Promise<void>}
 */
async function handleDrayageMissingDetailsFromLeo(args) {
  const {
    messageId, subject, from, emailBody, tenant, queueDocId,
    missingFields, leoParsed, invoicePdfCount,
  } = args;
  const docId = queueDocId || messageId;
  const lisaEmail = String(
      process.env.DRAYAGE_OPS_EMAIL ||
      process.env.LOW_PROFIT_CC_EMAIL ||
      drayageIntake.DRAYAGE_OPS_EMAIL_DEFAULT,
  ).trim();
  const missingText = drayageIntake.formatMissingLeoFields(missingFields);
  const parsedSummary = leoParsed ? [
    leoParsed.loadNumber ? `Load: ${leoParsed.loadNumber}` : null,
    leoParsed.vendorName ? `Vendor: ${leoParsed.vendorName}` : null,
    leoParsed.customerRate != null ?
      `Customer rate: $${leoParsed.customerRate}` : null,
    leoParsed.charges && leoParsed.charges.length ?
      `Charges: ${leoParsed.charges.length} line(s)` : null,
  ].filter(Boolean).join("\n") : "None parsed";

  await saveOutboundEmail({
    type: "drayage_missing_details",
    forceRecipient: true,
    to: lisaEmail,
    subject: `Drayage from Leo — missing details — ${subject || messageId}`,
    html:
      `<p>Leo sent back a drayage invoice but Jerry could not process it ` +
      `because required details are missing.</p>` +
      `<p><strong>Missing:</strong> ${escapeHtml(missingText)}</p>` +
      (invoicePdfCount === 0 ?
        `<p><strong>Note:</strong> No carrier invoice PDF was attached.</p>` :
        "") +
      `<p><strong>Parsed from Leo's email:</strong></p>` +
      `<pre style="white-space:pre-wrap;font-size:13px;">` +
      `${escapeHtml(parsedSummary)}</pre>` +
      `<p><strong>Original subject:</strong> ${escapeHtml(subject || "")}</p>` +
      `<p><strong>Leo message excerpt:</strong></p>` +
      `<pre style="white-space:pre-wrap;font-size:13px;">` +
      `${escapeHtml(String(emailBody || "").slice(0, 2000))}</pre>`,
    tenant,
  });

  await writeLog("warn", "mail",
      "Drayage return from Leo — missing details, emailed Lisa", {
        messageId,
        subject,
        from,
        missingFields,
        invoicePdfCount,
      });

  await mailIntakeQueue.completeIntakeRecord({
    tenant,
    docId,
    parentMessageId: messageId,
    outcome: mailIntakeQueue.OUTCOME.FORWARDED,
    finalStatus: "drayage_leo_missing_details",
    forwardReason: `Leo drayage reply missing: ${missingText}`,
    extra: {
      gmailMessageId: messageId,
      subject,
      from,
      missingFields,
      deleteAt: getDeleteAt(mailIntakeQueue.INTAKE_TTL_DAYS),
    },
  });
}

/**
 * Parses Leo's return email and merges Primus entry instructions into items.
 * @param {object} args Handler arguments.
 * @return {Promise<object>} {handled, ok}
 */
async function applyLeoDrayageReturnIfPresent(args) {
  const {
    from, emailBody, subject, invoiceItems, pdfAttachments,
    messageId, tenant, queueDocId,
  } = args;
  if (!drayageIntake.isDrayageValidatorEmail(from)) {
    return {handled: false, ok: false};
  }

  const leoParsed = await drayageIntake.resolveLeoReturnInstructions(
      emailBody, subject);
  const validation = drayageIntake.validateLeoInstructions(leoParsed);
  const invoicePdfCount = (pdfAttachments || []).filter(
      (a) => a.docType !== "POD").length;

  const missing = [...validation.missingFields];
  if (invoicePdfCount === 0) missing.push("invoicePdf");

  if (missing.length) {
    await handleDrayageMissingDetailsFromLeo({
      messageId, subject, from, emailBody, tenant, queueDocId,
      missingFields: missing,
      leoParsed,
      invoicePdfCount,
    });
    return {handled: true, ok: false};
  }

  for (let i = 0; i < invoiceItems.length; i++) {
    invoiceItems[i] = drayageIntake.applyLeoInstructionsToInvoiceItem(
        invoiceItems[i], leoParsed);
  }

  await writeLog("info", "mail",
      "Drayage return from Leo — applying Primus entry instructions", {
        messageId,
        subject,
        loadNumber: leoParsed.loadNumber,
        vendorName: leoParsed.vendorName,
        customerRate: leoParsed.customerRate,
        chargeCount: leoParsed.charges.length,
      });

  return {handled: true, ok: true};
}

/**
 * Emails Lisa a link to enter the Primus load # for a regular invoice.
 * @param {object} args Handler arguments.
 * @return {Promise<void>}
 */
async function handleMissingLoadNumberForLisa(args) {
  const {
    messageId, subject, from, tenant, itemIndex,
    aiResult, loadGateReason, emailIntakeRef, inboxFlowId,
  } = args;
  const lisaEmail = String(
      process.env.LOW_PROFIT_CC_EMAIL ||
      invoiceLoadEntry.LISA_EMAIL_DEFAULT,
  ).trim();
  const baseUrl = emailActionTokens.publicFunctionsBaseUrl();
  const entryUrl = emailActionTokens.buildConfirmUrl({
    baseUrl,
    path: "enterInvoiceLoadNumber",
    action: "invoiceLoadEntry",
    invoiceId: messageId,
    option: String(itemIndex || 0),
    tenantId: tenant.tenantId,
  });
  const refs = loadResolution.carrierReferenceReviewFields(aiResult);
  const refLines = Object.entries(refs)
      .map(([k, v]) => `<li><strong>${escapeHtml(k)}:</strong> ` +
        `${escapeHtml(v)}</li>`)
      .join("");

  await saveOutboundEmail({
    type: "missing_load_number",
    forceRecipient: true,
    to: lisaEmail,
    subject: `Enter load # — ${aiResult.carrierName || "carrier invoice"}`,
    html:
      `<p>Jerry received a carrier invoice but could not match it to a ` +
      `Primus load (no valid load or PRO).</p>` +
      `<ul style="font-size:14px;line-height:1.6">` +
      `<li><strong>Carrier:</strong> ` +
      `${escapeHtml(aiResult.carrierName || "—")}</li>` +
      `<li><strong>Invoice amount:</strong> ` +
      `${aiResult.invoiceAmount != null ?
        `$${escapeHtml(String(aiResult.invoiceAmount))}` : "—"}</li>` +
      `<li><strong>Subject:</strong> ${escapeHtml(subject || "")}</li>` +
      `</ul>` +
      `<p style="font-size:13px;color:#374151">` +
      `References found on invoice:</p>` +
      `<ul style="font-size:13px">${refLines}</ul>` +
      (loadGateReason ?
        `<p style="font-size:13px;color:#6b7280">Reason: ` +
        `${escapeHtml(loadGateReason)}</p>` : "") +
      `<p style="margin:24px 0">` +
      `<a href="${emailActionTokens.escapeHtmlAttr(entryUrl)}" ` +
      `style="display:inline-block;background:#2563eb;color:#fff;` +
      `padding:12px 20px;border-radius:8px;text-decoration:none;` +
      `font-weight:600">Enter load number</a></p>` +
      `<p style="font-size:13px;color:#9ca3af">Opens a secure form. ` +
      `After you submit, Jerry reprocesses the invoice with that load.</p>`,
    tenant,
  });

  if (emailIntakeRef) {
    await emailIntakeRef.set({
      pendingLoadEntry: {
        status: "awaiting_lisa",
        itemIndex: Number(itemIndex) || 0,
        carrierName: aiResult.carrierName || null,
        invoiceAmount: aiResult.invoiceAmount || null,
        loadGateReason: loadGateReason || null,
        requestedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      inboxFlowId: inboxFlowId || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
  }

  await writeLog("info", "mail",
      "Missing load number — emailed Lisa load entry link", {
        messageId,
        subject,
        from,
        itemIndex: itemIndex || 0,
        carrierName: aiResult.carrierName || null,
      });
}

/**
 * Ignores or auto-replies to carrier payment / Quick Pay inquiry emails.
 * @param {object} args Handler arguments.
 * @return {Promise<void>}
 */
async function handlePaymentInquiryEmail(args) {
  const {
    messageId, subject, from, tenant, headers,
    emailClassification, queueDocId, reason,
  } = args;
  const docId = queueDocId || messageId;
  const abeEmail = String(
      process.env.REVIEW_EMAIL_STATEMENT ||
      administrativeEmailIntake.PAYMENT_INQUIRY_EMAIL_DEFAULT ||
      STATEMENT_FORWARD_EMAIL_DEFAULT,
  ).trim().toLowerCase();
  const intakeExtra = {
    gmailMessageId: messageId,
    subject,
    from,
    emailClassification: emailClassification || null,
    deleteAt: getDeleteAt(mailIntakeQueue.INTAKE_TTL_DAYS),
  };

  if (isAbeCopiedOnEmail(headers)) {
    await writeLog("info", "mail",
        "Payment inquiry — Abe already copied, ignoring", {
          messageId,
          subject,
          from,
        });
    await mailIntakeQueue.completeIntakeRecord({
      tenant,
      docId,
      parentMessageId: messageId,
      outcome: mailIntakeQueue.OUTCOME.IGNORED,
      finalStatus: "payment_inquiry_ignored_abe_cc",
      ignoreReason: "Payment inquiry — Abe already on thread",
      extra: intakeExtra,
    });
    return;
  }

  const senderEmail = extractSenderEmailFromHeader(from);
  const replySubject = /^re:/i.test(String(subject || "").trim()) ?
    String(subject || "").trim() :
    `Re: ${String(subject || "Payment inquiry").trim()}`;
  const replyHtml =
    `<p>Thank you for your email.</p>` +
    `<p>For all payment inquiries, please reach out to ` +
    `<a href="mailto:${escapeHtml(abeEmail)}">` +
    `${escapeHtml(abeEmail)}</a>.</p>` +
    `<p>Thank you,<br>${escapeHtml(AI_AGENT_NAME)}<br>` +
    `Innovative Carriers</p>`;

  if (senderEmail) {
    await saveOutboundEmail({
      type: "payment_inquiry_reply",
      forceRecipient: true,
      to: senderEmail,
      subject: replySubject,
      html: replyHtml,
      tenant,
      skipAgentGreeting: true,
    });
  } else {
    await writeLog("warn", "mail",
        "Payment inquiry — could not parse sender email for reply", {
          messageId,
          subject,
          from,
        });
  }

  await mailIntakeQueue.completeIntakeRecord({
    tenant,
    docId,
    parentMessageId: messageId,
    outcome: mailIntakeQueue.OUTCOME.PROCESSED,
    finalStatus: senderEmail ?
      "payment_inquiry_replied" : "payment_inquiry_no_reply_address",
    summary: senderEmail ?
      `Replied — directed sender to ${abeEmail} for payment inquiries` :
      "Payment inquiry — could not reply (no sender address)",
    extra: {
      ...intakeExtra,
      replyTo: senderEmail,
      directedTo: abeEmail,
      reason: reason || "Carrier payment inquiry",
    },
  });
}

/**
 * Forwards customer payment remittance emails to Abe (Lisa's rule).
 * If Abe is already on the thread, quietly ignore.
 * @param {object} args Handler arguments.
 * @return {Promise<void>}
 */
async function handleCustomerPaymentRemittanceEmail(args) {
  const {
    gmail, messageId, subject, from, emailBody, tenant, headers,
    emailClassification, reason, queueDocId,
  } = args;
  const docId = queueDocId || messageId;
  const intakeExtra = {
    gmailMessageId: messageId,
    subject,
    from,
    emailClassification: emailClassification || null,
    deleteAt: getDeleteAt(mailIntakeQueue.INTAKE_TTL_DAYS),
  };

  if (isAbeCopiedOnEmail(headers)) {
    await writeLog("info", "mail",
        "Customer payment remittance — Abe already copied, ignoring", {
          messageId,
          subject,
          from,
        });
    await mailIntakeQueue.completeIntakeRecord({
      tenant,
      docId,
      parentMessageId: messageId,
      outcome: mailIntakeQueue.OUTCOME.IGNORED,
      finalStatus: "customer_payment_remittance_ignored_abe_cc",
      ignoreReason: "Customer payment remittance — Abe already on thread",
      extra: intakeExtra,
    });
    return;
  }

  const forwardReason =
    reason || "Customer payment remittance — forward to accounting";
  await forwardToHumanReview(
      gmail, messageId, subject, from,
      forwardReason,
      `Hi, I'm ${AI_AGENT_NAME}, your AI assistant.\n\n` +
      `This email appears to be a customer payment remittance (not a ` +
      `carrier freight invoice). I'm forwarding it to accounting for ` +
      `payment posting.\n\nThank you,\n${AI_AGENT_NAME}`,
      {department: "statement", emailBody},
  );
  await mailIntakeQueue.completeIntakeRecord({
    tenant,
    docId,
    parentMessageId: messageId,
    outcome: mailIntakeQueue.OUTCOME.FORWARDED,
    finalStatus: "customer_payment_remittance_forwarded",
    forwardReason,
    extra: intakeExtra,
  });
}

/**
 * Marks an administrative email as intentionally ignored (no forward).
 * @param {object} args Handler arguments.
 * @return {Promise<void>}
 */
async function completeAdministrativeIgnore(args) {
  const {
    messageId, subject, from, tenant, finalStatus, reason, extra,
    queueDocId,
  } = args;
  await writeLog("info", "mail", reason || "Administrative email ignored", {
    messageId,
    subject,
    from,
    finalStatus,
    ...(extra || {}),
  });
  const docId = queueDocId || messageId;
  await mailIntakeQueue.completeIntakeRecord({
    tenant,
    docId,
    parentMessageId: messageId,
    outcome: mailIntakeQueue.OUTCOME.IGNORED,
    finalStatus: finalStatus || "administrative_ignored",
    ignoreReason: reason || null,
    extra: Object.assign({
      gmailMessageId: messageId,
      subject,
      from,
      deleteAt: getDeleteAt(mailIntakeQueue.INTAKE_TTL_DAYS),
    }, extra || {}),
  });
}

/**
 * Forwards an email to the human review address with context notes.
 * @param {object} gmail - Authenticated Gmail client.
 * @param {string} messageId - Original Gmail message ID.
 * @param {string} subject - Original email subject.
 * @param {string} from - Original sender.
 * @param {string} reason - Short reason for review.
 * @param {string} notes - Detailed notes for the reviewer.
 * @return {Promise<void>}
 */

/**
 * Escapes a string for safe insertion into HTML.
 * @param {*} str - Value to escape.
 * @return {string} HTML-safe string.
 */
function escapeHtml(str) {
  return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}

/**
 * Encodes a buffer as base64 with RFC 2045 line wrapping.
 * @param {Buffer} buf - Raw bytes to encode.
 * @return {string} Base64 string with CRLF every 76 characters.
 */
function encodeMimeBase64(buf) {
  const b64 = buf.toString("base64");
  return b64.replace(/.{1,76}/g, "$&\r\n").trim();
}

/**
 * Builds a multipart review email: HTML summary + original message attachment.
 * @param {object} params - MIME build parameters.
 * @param {string} params.to - Recipient address.
 * @param {string} params.subject - Email subject.
 * @param {string} params.html - HTML body for the AI summary.
 * @param {Buffer} params.originalRawBuffer - Full original RFC822 message.
 * @param {string} params.originalFilename - Attachment filename.
 * @return {Buffer} Complete MIME message ready for Gmail send.
 */
function buildReviewForwardMime({
  to,
  subject,
  html,
  originalRawBuffer,
  originalFilename,
}) {
  const boundary = `review_${crypto.randomBytes(16).toString("hex")}`;
  const safeFilename = String(originalFilename || "original.eml")
      .replace(/[\r\n"]/g, "_");

  const htmlB64 = encodeMimeBase64(Buffer.from(String(html || ""), "utf8"));

  const lines = [
    `To: ${to}\r\n`,
    `Subject: ${subject}\r\n`,
    `MIME-Version: 1.0\r\n`,
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n`,
    `\r\n`,
    `--${boundary}\r\n`,
    `Content-Type: text/html; charset="UTF-8"\r\n`,
    `Content-Transfer-Encoding: base64\r\n`,
    `\r\n`,
    `${htmlB64}\r\n`,
    `--${boundary}\r\n`,
    `Content-Type: message/rfc822\r\n`,
    `Content-Disposition: attachment; filename="${safeFilename}"\r\n`,
    `Content-Transfer-Encoding: base64\r\n`,
    `\r\n`,
    `${encodeMimeBase64(originalRawBuffer)}\r\n`,
    `--${boundary}--`,
  ];
  return Buffer.from(lines.join(""));
}

/**
 * Forwards an email to the appropriate human-review inbox.
 * @param {object} gmail - Authenticated Gmail API client.
 * @param {string} messageId - The Gmail message ID being forwarded.
 * @param {string} subject - The original email subject.
 * @param {string} from - The original sender address.
 * @param {string} reason - Short reason shown to the reviewer.
 * @param {string} notes - Detailed notes for the reviewer.
 * @param {object} options - Optional extras.
 * @param {string} options.department - Routes to a department inbox.
 * @param {object} options.extractedData - Extracted invoice data to render.
 * @param {string} options.emailBody - Original email body to include.
 * @return {Promise<void>}
 */
async function forwardToHumanReview(
    gmail, messageId, subject, from, reason, notes, options = {}) {
  const {
    department = "general",
    extractedData = null,
    emailBody = null,
  } = options;

  const departmentEmail =
    (department === "invoice_veto" &&
      (process.env.INVOICE_VETO_REVIEW_EMAIL ||
        process.env.HUMAN_REVIEW_EMAIL)) ||
    (department === "billing" && process.env.REVIEW_EMAIL_BILLING) ||
    (department === "operations" && process.env.REVIEW_EMAIL_OPERATIONS) ||
    (department === "statement" &&
      (process.env.REVIEW_EMAIL_STATEMENT ||
        STATEMENT_FORWARD_EMAIL_DEFAULT)) ||
    (department === "drayage" &&
      (process.env.DRAYAGE_FORWARD_EMAIL ||
        drayageIntake.DRAYAGE_FORWARD_EMAIL_DEFAULT)) ||
    process.env.HUMAN_REVIEW_EMAIL;

  if (!departmentEmail) {
    const missingVar = department === "invoice_veto" ?
      "INVOICE_VETO_REVIEW_EMAIL" :
      department === "billing" ? "REVIEW_EMAIL_BILLING" :
      department === "operations" ? "REVIEW_EMAIL_OPERATIONS" :
      department === "statement" ? "REVIEW_EMAIL_STATEMENT" :
      department === "drayage" ? "DRAYAGE_FORWARD_EMAIL" :
      "HUMAN_REVIEW_EMAIL";
    console.error(
        `[forwardToHumanReview] ${missingVar} env var not set — ` +
        `forward dropped for message ${messageId} (reason: ${reason})`,
    );
    await writeLog("error", "mail",
        `Review forward dropped — ${missingVar} is not configured`,
        {messageId, department, reason});
    try {
      await db.collection("emailErrors").add({
        gmailMessageId: messageId,
        error: `${missingVar} not configured — forward dropped`,
        reason,
        department,
        status: "config_error",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        deleteAt: getDeleteAt(30),
      });
    } catch (logErr) {
      console.error(
          `[forwardToHumanReview] Failed to record emailErrors entry ` +
          `for message ${messageId}:`, logErr,
      );
    }
    return;
  }

  let dataRows = "";
  if (extractedData) {
    dataRows = Object.entries(extractedData)
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) =>
          `<tr><td style="padding:4px 14px 4px 0;color:#6b7280;` +
          `white-space:nowrap;font-weight:600;">${escapeHtml(k)}</td>` +
          `<td style="padding:4px 0;">${escapeHtml(v)}</td></tr>`,
        ).join("");
  }

  const dataSection = dataRows ?
    `<h3 style="margin:20px 0 8px;font-size:13px;text-transform:uppercase;` +
    `letter-spacing:.05em;color:#374151;">Invoice Details</h3>` +
    `<table style="border-collapse:collapse;font-size:13px;">` +
    `${dataRows}</table>` : "";

  let originalRawBuffer = null;
  try {
    const origMsg = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "raw",
    });
    const rawB64url = origMsg.data.raw;
    if (rawB64url) {
      originalRawBuffer = Buffer.from(
          rawB64url.replace(/-/g, "+").replace(/_/g, "/"),
          "base64",
      );
    }
  } catch (attachErr) {
    await writeLog("warn", "mail",
        "Could not fetch original message for review attachment",
        {messageId, error: attachErr.message});
  }

  const attachmentNotice = originalRawBuffer ?
    `<p style="margin:16px 0 0;padding:12px;background:#f0fdf4;` +
    `border:1px solid #bbf7d0;border-radius:6px;font-size:13px;` +
    `color:#166534;">` +
    `The complete original email, including all attachments, is attached ` +
    `as <strong>original.eml</strong>. Open it in your mail client to view ` +
    `everything.</p>` : "";

  const emailBodySection = !originalRawBuffer && emailBody ?
    `<h3 style="margin:20px 0 8px;font-size:13px;text-transform:uppercase;` +
    `letter-spacing:.05em;color:#374151;">Original Message</h3>` +
    `<div style="background:#f9fafb;border:1px solid #e5e7eb;` +
    `border-radius:6px;` +
    `padding:14px;font-size:13px;line-height:1.6;white-space:pre-wrap;` +
    `color:#374151;">` +
    `${escapeHtml(String(emailBody).slice(0, 2000))}` +
    `</div>` : "";

  const html =
    `<div style="font-family:Arial,sans-serif;max-width:620px;` +
    `color:#111827;font-size:14px;">` +
    `<div style="background:#dc2626;color:#fff;padding:14px 18px;` +
    `border-radius:6px 6px 0 0;font-size:15px;font-weight:700;">` +
    `&#9888; Action Required — ${escapeHtml(reason)}</div>` +
    `<div style="border:1px solid #e5e7eb;border-top:none;padding:18px;` +
    `border-radius:0 0 6px 6px;">` +
    `<p style="margin:0 0 16px;color:#374151;line-height:1.6;` +
    `white-space:pre-wrap;">${escapeHtml(notes)}</p>` +
    `${dataSection}` +
    `<h3 style="margin:20px 0 8px;font-size:13px;text-transform:uppercase;` +
    `letter-spacing:.05em;color:#374151;">Original Email</h3>` +
    `<table style="border-collapse:collapse;font-size:13px;">` +
    `<tr><td style="padding:4px 14px 4px 0;color:#6b7280;font-weight:600;">` +
    `From</td><td>${escapeHtml(from)}</td></tr>` +
    `<tr><td style="padding:4px 14px 4px 0;color:#6b7280;font-weight:600;">` +
    `Subject</td><td>${escapeHtml(subject)}</td></tr>` +
    `<tr><td style="padding:4px 14px 4px 0;color:#6b7280;font-weight:600;">` +
    `Message&nbsp;ID</td>` +
    `<td style="font-family:monospace;font-size:11px;">` +
    `${escapeHtml(messageId)}</td>` +
    `</tr></table>` +
    `${attachmentNotice}` +
    `${emailBodySection}` +
    `</div></div>`;

  const safeReason = String(reason || "").replace(/[\r\n]/g, " ");
  const safeSubject = String(subject || "").replace(/[\r\n]/g, " ");
  const forwardSubject = `[ACTION REQUIRED] ${safeReason} — ${safeSubject}`;

  let mimeBuffer;
  if (originalRawBuffer) {
    mimeBuffer = buildReviewForwardMime({
      to: departmentEmail,
      subject: forwardSubject,
      html,
      originalRawBuffer,
      originalFilename: "original.eml",
    });
  } else {
    const htmlB64 = encodeMimeBase64(Buffer.from(String(html || ""), "utf8"));
    mimeBuffer = Buffer.from(
        `To: ${departmentEmail}\r\n` +
        `Subject: ${forwardSubject}\r\n` +
        `MIME-Version: 1.0\r\n` +
        `Content-Type: text/html; charset="UTF-8"\r\n` +
        `Content-Transfer-Encoding: base64\r\n` +
        `\r\n${htmlB64}`,
    );
  }

  const raw = mimeBuffer.toString("base64url");

  await gmail.users.messages.send({userId: "me", requestBody: {raw}});
  await writeLog("info", "mail", "Forwarded to human review", {
    messageId,
    reason,
    reviewEmail: departmentEmail,
    department,
    originalAttached: Boolean(originalRawBuffer),
  });

  const loadHint = extractedData && (
    extractedData.loadNumber || extractedData["Load #"] ||
    extractedData.load);
  await dashboardTasks.createDashboardTask(db, {
    tenantId: (currentTenant() && currentTenant().tenantId) || "default",
    type: dashboardTasks.TASK_TYPE.HUMAN_REVIEW,
    title: `[Review] ${safeReason}`,
    description: notes || null,
    loadNumber: loadHint ? String(loadHint) : null,
    messageId,
    department,
    reason: safeReason,
  });
}

/**
 * Sends an email via the connected Gmail account using stored OAuth tokens.
 * @param {string} to Recipient email address.
 * @param {string} subject Email subject.
 * @param {string} html HTML body.
 * @param {Array<object>} attachments PDF attachments array.
 * @param {object} [tenant] Tenant config for Gmail doc lookup.
 * @param {object} [opts] Optional send options.
 * @param {string} [opts.cc] CC recipient(s), comma-separated.
 * @param {Array<object>} [opts.inlineAttachments] CID inline images.
 * @return {Promise<void>}
 */
async function sendViaGmail(
    to, subject, html, attachments = [], tenant = null, opts = {},
) {
  const tenantCfg = tenant || DEFAULT_TENANT;
  const mail = await mailProvider.getTenantMailClient(tenantCfg);
  if (!mail) {
    throw new Error(`${mailProvider.providerLabel()} not connected`);
  }

  const boundary = `msg_${crypto.randomBytes(16).toString("hex")}`;
  const safeTo = String(to || "").replace(/[\r\n]/g, "");
  const safeCc = String(opts && opts.cc || "").replace(/[\r\n]/g, "");
  const safeSubject = toOutboundEmailSafeSubject(
      String(subject || "").replace(/[\r\n]/g, " "));
  const htmlB64 = encodeMimeBase64(Buffer.from(
      toOutboundEmailSafeText(String(html || "")), "utf8"));
  const inlineAttachments = Array.isArray(opts.inlineAttachments) ?
    opts.inlineAttachments : [];

  const lines = [
    `To: ${safeTo}\r\n`,
  ];
  if (safeCc) {
    lines.push(`Cc: ${safeCc}\r\n`);
  }
  lines.push(
      `Subject: ${safeSubject}\r\n`,
      `MIME-Version: 1.0\r\n`,
      `Content-Type: multipart/mixed; boundary="${boundary}"\r\n`,
      `\r\n`,
      `--${boundary}\r\n`,
      `Content-Type: text/html; charset="UTF-8"\r\n`,
      `Content-Transfer-Encoding: base64\r\n`,
      `\r\n`,
      `${htmlB64}\r\n`,
  );

  for (const att of inlineAttachments) {
    const wrapped = String(att.contentBase64 || "")
        .replace(/.{1,76}/g, "$&\r\n").trim();
    const cid = String(att.contentId || "").replace(/^<|>$/g, "");
    lines.push(
        `--${boundary}\r\n`,
        `Content-Type: ${att.contentType}; name="${att.filename}"\r\n`,
        `Content-Transfer-Encoding: base64\r\n`,
        `Content-ID: <${cid}>\r\n`,
        `Content-Disposition: inline; filename="${att.filename}"\r\n`,
        `\r\n`,
        `${wrapped}\r\n`,
    );
  }

  for (const att of attachments) {
    const wrapped = att.contentBase64
        .replace(/.{1,76}/g, "$&\r\n").trim();
    lines.push(
        `--${boundary}\r\n`,
        `Content-Type: ${att.contentType}; name="${att.filename}"\r\n`,
        `Content-Disposition: attachment; filename="${att.filename}"\r\n`,
        `Content-Transfer-Encoding: base64\r\n`,
        `\r\n`,
        `${wrapped}\r\n`,
    );
  }
  lines.push(`--${boundary}--`);

  const raw = Buffer.from(lines.join("")).toString("base64url");
  await mail.users.messages.send({userId: "me", requestBody: {raw}});
}

/**
 * Checks profit and margin thresholds against business rules.
 * profit < $10 = no rate scenario; margin < 10% = broker commission
 * GP% check for dispatcher low-profit alerts (profit / revenue).
 * Broker commission uses Primus Profit % (profit / cost) instead.
 * @param {number} primusRate - Customer rate from Primus.
 * @param {number} invoiceAmount - Carrier invoice amount.
 * @return {object} Margin check result (noRate, profit, margin,
 *   lowProfit, lowMargin).
 */
function checkProfitMargin(primusRate, invoiceAmount) {
  if (!primusRate || Number(primusRate) <= 0) {
    return {
      noRate: true,
      profit: 0,
      margin: 0,
      lowProfit: true,
      lowMargin: true,
    };
  }
  const profit = Number(primusRate) - Number(invoiceAmount || 0);
  const margin = (profit / Number(primusRate)) * 100;
  return {
    noRate: false,
    profit,
    margin,
    lowProfit: profit < 10,
    lowMargin: margin < 10,
  };
}

/**
 * Emails the load dispatcher (CC Lisa) when carrier bill profit is below $10.
 * Falls back to Lisa as To if dispatcher email cannot be resolved.
 * @param {object} opts Notification context.
 * @return {Promise<object>} Delivery result.
 */
async function notifyDispatcherLowProfit(opts) {
  const {
    loadNumber,
    carrierName,
    invoiceAmount,
    customerRate,
    profit,
    messageId,
  } = opts || {};
  const ccLisa = process.env.LOW_PROFIT_CC_EMAIL ||
    "Lisa@innovativecarriers.com";
  const primusUiBridgeLocal = require("./primus-ui-bridge");

  let dispatcher = {ok: false};
  try {
    dispatcher = await primusUiBridgeLocal.resolveDispatcherEmail({
      loadNumber,
      fetchBooking: fetchPrimusBooking,
    });
  } catch (err) {
    dispatcher = {ok: false, error: err.message};
  }

  const to = (dispatcher.ok && dispatcher.email) ?
    dispatcher.email : ccLisa;

  const profitNum = Number(profit);
  const profitLabel = Number.isFinite(profitNum) ?
    `$${profitNum.toFixed(2)}` : "—";
  const html =
    `<p>Hi${dispatcher.displayName ?
      ` ${escapeHtml(dispatcher.displayName.trim())}` : ""},</p>` +
    `<p>Jerry flagged load <strong>${escapeHtml(String(loadNumber || ""))}` +
    `</strong> because the calculated profit is ` +
    `<strong>${escapeHtml(profitLabel)}</strong>, which is below the ` +
    `$10 minimum.</p>` +
    `<p>Please check why profit is negative / too low on this load ` +
    `(customer rate vs carrier bill) and follow up as needed.</p>` +
    `<table style="border-collapse:collapse;font-size:14px;margin:12px 0">` +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">Carrier</td>` +
    `<td>${escapeHtml(carrierName || "—")}</td></tr>` +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">Load #</td>` +
    `<td>${escapeHtml(String(loadNumber || "—"))}</td></tr>` +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">` +
    `Carrier invoice</td><td>$${Number(invoiceAmount || 0).toFixed(2)}` +
    `</td></tr>` +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">` +
    `Customer rate</td><td>$${Number(customerRate || 0).toFixed(2)}` +
    `</td></tr>` +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">Profit</td>` +
    `<td>${escapeHtml(profitLabel)}</td></tr>` +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">Dispatcher` +
    `</td><td>${escapeHtml(
        dispatcher.displayName || dispatcher.userName || "—")}</td></tr>` +
    `</table>` +
    (!dispatcher.ok ?
      `<p style="color:#b45309"><em>Note: could not resolve dispatcher ` +
      `email from Primus` +
      (dispatcher.error ? ` (${escapeHtml(dispatcher.error)})` : "") +
      `; sent to Lisa only.</em></p>` : "");

  const emailPayload = additionalCharges.applyDispatcherEmailCc({
    type: "low_profit_dispatcher",
    forceRecipient: true,
    to,
    subject: `Action needed — low/negative profit on Load ${loadNumber}`,
    html,
  });
  await saveOutboundEmail(emailPayload);

  await writeLog("info", "email",
      "Low-profit alert sent to dispatcher", {
        messageId: messageId || null,
        loadNumber,
        to: emailPayload.to,
        cc: emailPayload.cc || null,
        dispatcherOk: Boolean(dispatcher.ok),
        dispatcherUserName: dispatcher.userName || null,
        profit: profitNum,
      });

  return {
    ok: true,
    to: emailPayload.to,
    cc: emailPayload.cc || null,
    dispatcher,
  };
}

/**
 * Emails the load dispatcher (CC Lisa) when customer rate is missing or
 * margin is too low to auto-invoice. Includes the set-rate / resume links
 * from the standard workflow alert. Falls back to Lisa as To.
 * @param {object} opts Notification context.
 * @return {Promise<object>} Delivery result.
 */
async function notifyDispatcherRateIssue(opts) {
  const {
    req,
    code,
    invoiceId,
    tenantId,
    loadNumber,
    context,
  } = opts || {};
  const ccLisa = process.env.LOW_PROFIT_CC_EMAIL ||
    "Lisa@innovativecarriers.com";
  const primusUiBridgeLocal = require("./primus-ui-bridge");

  let dispatcher = {ok: false};
  try {
    dispatcher = await primusUiBridgeLocal.resolveDispatcherEmail({
      loadNumber,
      fetchBooking: fetchPrimusBooking,
    });
  } catch (err) {
    dispatcher = {ok: false, error: err.message};
  }

  const to = (dispatcher.ok && dispatcher.email) ?
    dispatcher.email : ccLisa;

  const baseUrl = req && req.get ? `https://${req.get("host")}` : "";
  const alert = workflowErrors.buildWorkflowAlertEmail({
    code: code || "MISSING_RATE",
    context: context || {loadNumber},
    baseUrl,
    invoiceId,
    tenantId: tenantId || null,
  });

  let html = alert.html;
  if (dispatcher.displayName) {
    html = `<p>Hi ${escapeHtml(dispatcher.displayName.trim())},</p>` + html;
  } else if (dispatcher.ok && dispatcher.email) {
    html = `<p>Hi,</p>` + html;
  }
  if (!dispatcher.ok) {
    html += `<p style="color:#b45309"><em>Note: could not resolve ` +
      `dispatcher email from Primus` +
      (dispatcher.error ? ` (${escapeHtml(dispatcher.error)})` : "") +
      `; sent to Lisa only.</em></p>`;
  }

  const emailType = code === "LOW_MARGIN" ? "low_margin" :
    code === "MISSING_CUSTOMER" ? "customer_missing" : "rate_missing";
  const emailPayload = additionalCharges.applyDispatcherEmailCc({
    type: emailType,
    invoiceId,
    forceRecipient: true,
    to,
    subject: alert.subject,
    html,
  });
  await saveOutboundEmail(emailPayload);

  await writeLog("info", "email",
      "Customer/rate alert sent to dispatcher", {
        invoiceId: invoiceId || null,
        loadNumber: loadNumber || null,
        code,
        to: emailPayload.to,
        cc: emailPayload.cc || null,
        dispatcherOk: Boolean(dispatcher.ok),
        dispatcherUserName: dispatcher.userName || null,
      });

  return {
    ok: true,
    to: emailPayload.to,
    cc: emailPayload.cc || null,
    dispatcher,
  };
}

/**
 * Emails Lisa when a POD shows damage, shortage, or missing cartons.
 * Idempotent via podDiscrepancyNotifiedAt on the invoice.
 * @param {object} opts Notification context.
 * @return {Promise<object>}
 */
async function notifyLisaPodDiscrepancy(opts) {
  const {
    invoiceId,
    loadNumber,
    carrierName,
    proNumber,
    discrepancies,
  } = opts || {};
  const podFollowup = require("./pod-followup");
  const lisa = process.env.LOW_PROFIT_CC_EMAIL || podFollowup.LISA_EMAIL;
  const disc = normalizePodDiscrepancies(discrepancies);
  if (!disc.found) {
    return {ok: true, sent: false, reason: "no discrepancies"};
  }

  const flags = [];
  if (disc.damageNoted) flags.push("Damage noted");
  if (disc.missingCartons) flags.push("Missing cartons / shortage");
  const flagLabel = flags.length ? flags.join("; ") : "Discrepancy noted";

  const html =
    `<p>Hi Lisa,</p>` +
    `<p>Jerry flagged load <strong>${escapeHtml(String(loadNumber || ""))}` +
    `</strong> because the POD shows <strong>${escapeHtml(flagLabel)}` +
    `</strong> and needs your review before we treat delivery as clean.</p>` +
    (disc.details ?
      `<p style="margin:12px 0"><em>${escapeHtml(disc.details)}</em></p>` :
      "") +
    `<table style="border-collapse:collapse;font-size:14px;margin:12px 0">` +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">Carrier</td>` +
    `<td>${escapeHtml(carrierName || "—")}</td></tr>` +
    (proNumber ?
      `<tr><td style="padding:4px 16px 4px 0;font-weight:600">PRO</td>` +
      `<td>${escapeHtml(String(proNumber))}</td></tr>` : "") +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">` +
    `Damage</td><td>${disc.damageNoted ? "Yes" : "No"}</td></tr>` +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">` +
    `Missing cartons</td><td>${disc.missingCartons ? "Yes" : "No"}` +
    `</td></tr>` +
    `</table>` +
    `<p>Please review the POD on the load and follow up with the customer ` +
    `or carrier as needed.</p>`;

  await saveOutboundEmail({
    type: "pod_discrepancy_review",
    invoiceId: invoiceId || null,
    forceRecipient: true,
    to: lisa,
    subject: `Review POD — ${flagLabel} — Load ${loadNumber || "—"}`,
    html,
  });

  await writeLog("info", "email", "POD discrepancy review sent to Lisa", {
    invoiceId: invoiceId || null,
    loadNumber,
    to: lisa,
    damageNoted: disc.damageNoted,
    missingCartons: disc.missingCartons,
  });

  await dashboardTasks.createDashboardTask(db, {
    tenantId: (opts && opts.tenant && opts.tenant.tenantId) || "default",
    type: dashboardTasks.TASK_TYPE.POD_DISCREPANCY,
    title: `Review POD — ${flagLabel}`,
    description: disc.details || null,
    loadNumber: loadNumber || null,
    proNumber: proNumber || null,
    carrierName: carrierName || null,
    invoiceId: invoiceId || null,
    reason: flagLabel,
  });

  return {ok: true, sent: true, to: lisa, discrepancies: disc};
}

/**
 * Scans POD bytes / stored classification and notifies Lisa once per invoice.
 * @param {object} opts invoiceId, invoice, invoiceRef, podStoragePath.
 * @return {Promise<object>}
 */
async function maybeNotifyLisaPodDiscrepancy(opts) {
  const {invoiceId, invoice, invoiceRef, podStoragePath} = opts || {};
  if (!invoice || invoice.podDiscrepancyNotifiedAt) {
    return {ok: true, sent: false, reason: "already notified"};
  }

  let discrepancies = normalizePodDiscrepancies(
      invoice.pod && invoice.pod.discrepancies);

  const path = podStoragePath ||
    (invoice.podOnlyFile && invoice.podOnlyFile.storagePath) ||
    null;
  if (path) {
    try {
      const [buf] = await getBucket().file(path).download();
      const scanned = await scanPodBufferForDiscrepancies(buf);
      discrepancies = mergePodDiscrepancies(discrepancies, scanned);
    } catch (err) {
      await writeLog("warn", "workflow",
          "POD discrepancy scan failed — using AI flags only", {
            invoiceId,
            loadNumber: invoice.loadNumber,
            path,
            error: err.message,
          });
    }
  }

  if (!discrepancies.found) {
    return {ok: true, sent: false, reason: "no discrepancies"};
  }

  const notify = await notifyLisaPodDiscrepancy({
    invoiceId,
    loadNumber: invoice.loadNumber,
    carrierName: invoice.carrierName,
    proNumber: invoice.proNumber,
    discrepancies,
  });

  if (notify.sent && invoiceRef) {
    await invoiceRef.update({
      "podDiscrepancyNotifiedAt":
        admin.firestore.FieldValue.serverTimestamp(),
      "pod.discrepancies": discrepancies,
      "updatedAt": admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  return notify;
}

/**
 * Reads the bill-to / customer display name from a Primus booking.
 * @param {object|null} booking Primus booking.
 * @return {string}
 */
function customerNameFromPrimusBooking(booking) {
  if (!booking || typeof booking !== "object") return "";
  const party = (booking.billTo === "thirdparty" && booking.thirdParty) ?
    booking.thirdParty : (booking.shipper || booking.thirdParty || null);
  if (!party) return "";
  return String(party.name || party.companyName || "").trim();
}

/**
 * Sends the 5-option (A/B/C/D/E) additional-charge approval email to the
 * approver (Sarah) with the dispatcher CC'd, and creates the follow-up
 * entry so the charge is tracked until resolved.
 * @param {object} opts invoiceId, tenant, aiResult, pending (category,
 *   charges, chargesTotal, freightMismatch, hasCertificate,
 *   primusVendorCost, booking).
 * @return {Promise<void>}
 */
async function sendAdditionalChargeApprovalEmail(opts) {
  const {invoiceId, tenant, aiResult, pending} = opts;
  const primusUiBridge = require("./primus-ui-bridge");

  let dispatcher = {ok: false};
  try {
    dispatcher = await primusUiBridge.resolveDispatcherEmail({
      booking: pending.booking || null,
      loadNumber: aiResult.loadNumber,
      fetchBooking: fetchPrimusBooking,
    });
  } catch (err) {
    dispatcher = {ok: false, error: err.message};
  }

  const customerName = customerNameFromPrimusBooking(pending.booking);
  let customerRate = customerRateFromBooking(pending.booking);
  if (!customerRate && aiResult.loadNumber) {
    try {
      const rateResult = await getCustomerRate(
          aiResult.loadNumber, aiResult.proNumber);
      if (rateResult.ok && rateResult.customerRate) {
        customerRate = Number(rateResult.customerRate);
      }
    } catch (_) {
      // optional
    }
  }

  const followUpId = await additionalCharges.createFollowUp(db, {
    loadNumber: aiResult.loadNumber,
    carrierName: aiResult.carrierName,
    customerName: customerName || null,
    invoiceId,
    tenantId: tenant.tenantId,
    category: pending.category,
    charges: pending.charges,
    chargesTotal: pending.chargesTotal,
    invoiceAmount: aiResult.invoiceAmount,
    status: additionalCharges.FOLLOW_UP_STATUS.PENDING_APPROVAL,
  });

  const email = additionalCharges.buildAdditionalChargeApprovalEmail({
    baseUrl: functionsBaseUrl(),
    invoiceId,
    tenantId: tenant.tenantId,
    loadNumber: aiResult.loadNumber,
    carrierName: aiResult.carrierName,
    customerName,
    invoiceAmount: aiResult.invoiceAmount,
    primusAmount: pending.primusVendorCost,
    charges: pending.charges,
    chargesTotal: pending.chargesTotal,
    category: pending.category,
    freightMismatch: pending.freightMismatch,
    hasCertificate: pending.hasCertificate,
    dispatcherName: dispatcher.displayName || dispatcher.userName || null,
    rateValidation: pending.rateValidation || null,
    customerRate,
    excludedInPrimusCount: pending.excludedInPrimusCount || 0,
  });

  const podFollowup = require("./pod-followup");
  const approver = process.env.ADDITIONAL_CHARGE_APPROVER_EMAIL ||
    podFollowup.SARAH_EMAIL;
  const dispatcherEmail = (dispatcher.ok && dispatcher.email) ?
    dispatcher.email : null;
  const emailPayload = additionalCharges.applyAdditionalChargeEmailCc({
    type: "additional_charge_approval",
    invoiceId,
    subject: email.subject,
    html: email.html,
    forceRecipient: true,
    to: approver,
    cc: dispatcherEmail || undefined,
  });

  // Attach the full original carrier packet (invoice + W&I backups), not
  // an invoice-only page extract, so Sarah/Lisa can review supporting docs.
  let attachedInvoicePdf = false;
  let attachedApprovalPdfCount = 0;
  const attachmentHints = {
    proNumber: aiResult.proNumber,
    attachmentFilename: aiResult.attachmentFilename,
  };
  try {
    let attachmentMetas =
      additionalCharges.listAdditionalChargeApprovalAttachments(
          opts.invoiceAttachments, attachmentHints);
    if ((!attachmentMetas || !attachmentMetas.length) &&
        invoiceId && tenant) {
      const invSnap = await tcol(tenant, "invoices")
          .doc(String(invoiceId)).get();
      if (invSnap.exists) {
        attachmentMetas =
          additionalCharges.listAdditionalChargeApprovalAttachments(
              (invSnap.data() || {}).attachments, attachmentHints);
      }
    }
    const emailAttachments = [];
    for (const attachmentMeta of (attachmentMetas || [])) {
      if (!attachmentMeta || !attachmentMeta.storagePath) continue;
      const isWeightCert =
        /WEIGHT_INSPECTION_CERT/i.test(String(attachmentMeta.docType || ""));
      // Only enforce PRO-filename match on the primary carrier bill — W&I
      // sidecars (and XPO cert pulls) may not include the PRO in the name.
      if (!isWeightCert) {
        const validation =
          additionalCharges.validateCarrierInvoiceAttachment(
              attachmentMeta, attachmentHints);
        if (!validation.ok) {
          await writeLog("warn", "email",
              "Blocked wrong carrier invoice PDF on approval email", {
                invoiceId,
                loadNumber: aiResult.loadNumber,
                proNumber: aiResult.proNumber,
                pickedFilename: attachmentMeta.filename,
                reason: validation.reason,
              });
          continue;
        }
      }
      const contentBase64 = await downloadStorageFileBase64(
          attachmentMeta.storagePath);
      if (!contentBase64) continue;
      emailAttachments.push({
        filename: attachmentMeta.filename ||
          `carrier-invoice-${invoiceId}.pdf`,
        contentType: attachmentMeta.mimeType || "application/pdf",
        contentBase64,
      });
    }
    if (emailAttachments.length) {
      emailPayload.attachments = emailAttachments;
      attachedInvoicePdf = true;
      attachedApprovalPdfCount = emailAttachments.length;
    } else if (Array.isArray(opts.invoiceAttachments) &&
        opts.invoiceAttachments.length > 1 &&
        aiResult.proNumber) {
      await writeLog("warn", "email",
          "Additional-charge approval sent without carrier PDF " +
          "(batch PRO match failed)", {
            invoiceId,
            loadNumber: aiResult.loadNumber,
            proNumber: aiResult.proNumber,
            attachmentCount: opts.invoiceAttachments.length,
          });
    }
  } catch (attachErr) {
    await writeLog("warn", "email",
        "Could not attach carrier invoice to approval email", {
          invoiceId,
          error: attachErr.message,
        });
  }

  await saveOutboundEmail(emailPayload);

  await writeLog("info", "email",
      "Additional-charge approval email sent (A/B/C/D/E)", {
        invoiceId,
        followUpId,
        loadNumber: aiResult.loadNumber,
        category: pending.category,
        to: approver,
        ccDispatcher: dispatcherEmail || null,
        ccLisa: additionalCharges.LISA_EMAIL,
        customerRate,
        attachedInvoicePdf,
        attachedApprovalPdfCount,
      });
}

/**
 * Retrieves shipment data from Primus by load/BOL or PRO number.
 * @param {string} loadNumber - Load/BOL number.
 * @param {string} proNumber - PRO number (fallback search key).
 * @return {Promise<object>} Shipment lookup result.
 */
async function getPrimusShipment(loadNumber, proNumber) {
  try {
    let booking = await fetchPrimusBooking(loadNumber);
    if (!booking && proNumber) {
      booking = await fetchPrimusBookingByPro(proNumber);
    }
    if (!booking) {
      return {found: false, rate: null, vendorCost: null, customerEmail: null};
    }
    const acct = booking.accountingInformation || {};
    const {rate} = readCustomerRateFromAcct(acct);
    const vendorCost = Number(
        (booking.vendor && booking.vendor.cost) || 0) || null;
    let customerEmail = null;
    if (booking.thirdParty && booking.thirdParty.email) {
      customerEmail = booking.thirdParty.email;
    } else if (booking.shipper && booking.shipper.email) {
      customerEmail = booking.shipper.email;
    }
    return {found: true, rate, vendorCost, customerEmail, BOLId: booking.BOLId};
  } catch (error) {
    await writeLog("error", "primus", "getPrimusShipment failed", {
      loadNumber,
      proNumber,
      error: error.message,
    });
    return {found: false, rate: null, vendorCost: null, customerEmail: null};
  }
}

/**
 * Classifies parsed invoice attachment data with Anthropic.
 * @param {Array<object>} pdfAttachments PDF attachment data with buffers.
 * @param {number|null} lastKnownLoadNumber Last known valid load number.
 * @return {Promise<object>} AI classification result.
 */
async function classifyInvoiceData(pdfAttachments, lastKnownLoadNumber) {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  // Build content: one document block per PDF, then the instruction text
  const contentBlocks = pdfAttachments.map((att) => ({
    type: "document",
    source: {
      type: "base64",
      media_type: "application/pdf",
      data: att.buffer.toString("base64"),
    },
    title: att.filename,
  }));

  const invoiceItemShape = {
    status: "ready_for_primus_validation",
    invoiceNumber: "",
    loadNumber: "",
    proNumber: "",
    carrierBolNumber: "",
    carrierOrderNumber: "",
    poNumber: "",
    shipmentReference: "",
    containerNumber: "",
    invoiceAmount: 0,
    invoiceDate: "",
    dueDate: "",
    carrierName: "",
    attachmentFilename: "",
    invoicePages: [1],
    charges: [],
    recognizedCharges: [],
    unrecognizedCharges: [],
    chargesNeedProof: [],
    chargeProofRefs: [],
    freightDetails: {totalWeightLbs: 0, freightClass: "", pieces: 0},
    hasWeightInspectionCertificate: false,
    pod: {
      found: false,
      documents: [],
      source: "",
      attachmentFilename: "",
      page: 1,
      cropFromBottom: 0,
      reason: "",
      discrepancies: {
        found: false,
        damageNoted: false,
        missingCartons: false,
        details: "",
      },
    },
    reason: "",
  };

  contentBlocks.push({
    type: "text",
    text: JSON.stringify({
      task: "Extract EVERY distinct carrier freight invoice from the " +
          "attached PDF document(s). One email or one PDF may contain " +
          "multiple invoices and PODs — return one entry per load.",
      lastKnownLoadNumber: Number.isFinite(Number(lastKnownLoadNumber)) ?
        Number(lastKnownLoadNumber) : null,
      allowedStatuses: [
        "ready_for_primus_validation",
        "unrecognized_charges",
        "charges_no_proof",
        "error",
      ],
      rules: [
        "Return invoices as an array. Even if there is only one invoice, " +
        "return invoices: [ { ... } ].",
        "Detect every distinct carrier freight invoice across all " +
        "attachments and inside a single multi-load PDF.",
        "Do not merge two loads into one record.",
        "When the same load (or same PRO) appears more than once — e.g. an " +
        "ORIGINAL INVOICE plus a CORRECTED/REVISED/AMENDED invoice after a " +
        "dispute settlement — return ONLY the corrected/revised invoice. " +
        "Do not also return the superseded original.",
        "Central Transport and similar carriers stamp 'CORRECTED INVOICE' " +
        "or 'REVISED INVOICE' on the bill to pay; ignore 'ORIGINAL INVOICE' " +
        "copies for that same load/PRO when a corrected copy is present.",
        "Set attachmentFilename to the primary PDF filename for that " +
        "invoice (the document title).",
        "Set invoicePages to the 1-based page numbers in that PDF that " +
        "belong to THIS carrier bill (not sibling invoices). If the whole " +
        "file is one invoice, list every invoice page. When a Weight & " +
        "Inspection (W&I) / reweigh / inspection certificate is in the " +
        "SAME PDF as this bill, include those certificate page numbers in " +
        "invoicePages too — do not leave W&I backup pages out.",
        "Each invoice gets its OWN pod.documents limited to that load's " +
        "delivery pages only.",
        "Find the actual carrier invoice.",
        "If the first page is a Notice of Assignment, factor cover " +
        "letter, or ACH/banking remittance instructions, skip that " +
        "cover and extract the carrier freight invoice from later pages.",
        "loadNumber is ONLY the broker/customer shipment ID that matches " +
        "Primus (often labeled Load #, Customer Ref, Broker Ref, Reference " +
        "#, Reference Number). It must be EXACTLY 6 digits for Innovative " +
        "Primus loads (typically 265xxx).",
        "On Central Transport invoices: the broker load is usually labeled " +
        "'Reference Number', 'Customer Reference', 'Shipper Reference', or " +
        "similar — NOT the 5-digit account number (often top-right), " +
        "NOT the PRO, NOT batch numbers. Put that 5-digit account number in " +
        "carrierOrderNumber, never in loadNumber.",
        "Do not scan random digit strings on the invoice — only use clearly " +
        "labeled broker reference fields for loadNumber.",
        "carrierBolNumber is the carrier's Bill of Lading / BOL # when " +
        "labeled Bill of Lading #, BOL#, Master Bill of Lading, B/L #, " +
        "Billing Reference Number, Billing Ref #, or Billing Reference. " +
        "On factored invoices (FactorView, Chugh Capital, Apex, RTS, etc.) " +
        "the billing reference is often the broker Primus load — if it is " +
        "exactly 6 digits and no separate broker load field is shown, also " +
        "set loadNumber to that value. " +
        "On regular carrier invoices (Amfast, truckload, LTL, etc.): when " +
        "BOL # / Bill of Lading is exactly 6 digits in the Innovative " +
        "Primus range (typically 26xxxx) and no separate broker Load # / " +
        "Customer Ref is shown, ALSO set loadNumber to that BOL value. " +
        "Always still populate carrierBolNumber. " +
        "Do NOT put carrier BOL in proNumber unless it is a true PRO / " +
        "freight bill number.",
        "carrierOrderNumber is the carrier's order / shipment ID when " +
        "labeled Order Number, Order #, Shipment ID, or similar (any " +
        "length).",
        "poNumber is the purchase order when labeled PO # or P.O.",
        "shipmentReference is the shipper, consignee, or customer shipment " +
        "reference when labeled Reference #, Ref, Shipment ID, FBA ID, " +
        "Amazon FBA (e.g. FBA19FXCCFZT), PT# shipper ref, or similar " +
        "alphanumeric key — NOT the broker Primus load number.",
        "containerNumber is the intermodal/ocean container ID when labeled " +
        "Container #, Container No, CNTR, Unit #, or similar. ISO format is " +
        "4 letters + 7 digits (e.g. MSCU1234567). ONLY drayage invoices " +
        "have a container number — leave empty for truckload/LTL freight.",
        "proNumber is ONLY when the invoice labels PRO #, Carrier PRO, " +
        "Beyond PRO, Advance PRO, or (LTL only) freight bill number. " +
        "Leave proNumber empty when no PRO / freight bill field is shown " +
        "(common on FTL / truckload invoices). Never put Bill of Lading # " +
        "in proNumber.",
        "QuickBooks notification PDFs often label PRO as 'Provided' or " +
        "'Not Provided' — leave proNumber empty; never extract status words " +
        "like 'Provided', 'vided', or 'N/A' as the PRO.",
        "proNumber must be a numeric freight bill / tracking / PRO value " +
        "(typically 4+ digits), not descriptive label text.",
        "If you cannot find a broker loadNumber using labeled broker fields " +
        "(and no 6-digit Primus-range BOL as above), leave loadNumber empty " +
        "— do not guess from unlabeled numbers. Still use status " +
        "ready_for_primus_validation for a normal freight invoice.",
        "Never use status unmatched_amount. Amount matching is done by " +
        "Primus after extraction — always use ready_for_primus_validation " +
        "for a regular carrier freight invoice (even when loadNumber is " +
        "empty or you are unsure the amount will match).",
        "If lastKnownLoadNumber is provided, prefer a 6-digit broker " +
        "candidate where abs(candidate - lastKnownLoadNumber) <= 100000.",
        "If no valid 6-digit broker loadNumber candidate is found, return " +
        "loadNumber as empty string.",
        "Do not put carrier order numbers or 10+ digit carrier IDs in " +
        "loadNumber — use carrierOrderNumber instead.",
        "Keep broker loadNumber, carrier BOL, carrier order, PO, shipment " +
        "reference, and PRO in separate fields.",
        "Do not use proNumber as loadNumber.",
        "For FedEx Freight invoices, the PRO number is the same as the " +
        "carrier invoice number / tracking number (often 9–12 digits). " +
        "Set proNumber to that tracking number even when a separate broker " +
        "load number is also shown.",
        "FedEx Freight often emails ONE PDF containing many separate " +
        "freight invoices (one bill per page, or invoice+POD pages per " +
        "PRO). Return a SEPARATE invoices[] entry for EACH PRO/load. " +
        "Set invoicePages to ONLY the page(s) for THAT PRO — never list " +
        "sibling invoices' pages on the same item. Do not merge the " +
        "packet into one invoice.",
        "Find invoice total, invoice date, and due date.",
        "invoiceDate is the date the carrier issued the invoice " +
        "(YYYY-MM-DD).",
        "dueDate is the payment due date printed on the invoice " +
        "(YYYY-MM-DD). If the invoice shows terms like Net 30 but no " +
        "explicit due date, leave dueDate empty.",
        "Fuel surcharge is not an extra charge.",
        "Recognized extra charges are lumper and detention only.",
        "Detention = driver waiting time charge.",
        "If lumper exists, proof/receipt must be attached.",
        "Only classify lumper if clearly shown on the invoice.",
        "Populate recognizedCharges with recognized extra charges only.",
        "Populate unrecognizedCharges with any extra charge not recognized.",
        "Populate chargesNeedProof with recognized charges that need " +
        "proof but it is missing.",
        "Populate chargeProofRefs with {type, amount, attachmentFilename} " +
        "for each recognized charge that has proof.",
        "If no extra charges exist, charges must be an empty array.",
        "Do not invent charges.",
        "Any other added charge is unrecognized_charges.",
        "Extract freightDetails as billed on THIS invoice: totalWeightLbs " +
        "(billed/rated weight in lbs), freightClass (billed/rated NMFC " +
        "class like '92.5'), pieces. Use 0 / empty string when not shown.",
        "Set hasWeightInspectionCertificate=true when a Weight & " +
        "Inspection (W&I) / reweigh / inspection certificate page is " +
        "attached or referenced, or when the invoice shows a corrected, " +
        "reweighed, or reclassified weight/class versus an original.",
        "A W&I / WNI class-correction or reweigh certificate that shows " +
        "a revised class, weight, or rate IS the freight bill to extract " +
        "(corrected invoice / additional charge). Do not set status error.",
        "If attachment is not a freight invoice, status is error.",
        "Detect Proof of Delivery (POD) and shipment document pages.",
        "Include in pod.documents every post-invoice page that supports " +
        "delivery: unsigned POD forms, signed BOL, signed delivery receipt.",
        "Sources: 'unsigned_pod_template', 'signed_bol', 'signed_load', " +
        "'delivery_receipt', 'signed_pod', 'separate_attachment', " +
        "'last_page_of_invoice', 'same_page_as_invoice'.",
        "When a PDF has invoice + POD form + signed BOL + delivery receipt, " +
        "list ALL of those pages in pod.documents (page order).",
        "pod.documents is an array of {source, page, attachmentFilename, " +
        "reason} with 1-based page numbers.",
        "NEVER include a page in pod.documents if it shows the carrier " +
        "invoice Amount Due, bill total, or line-item charges matching " +
        "invoiceAmount — that is the invoice page, not POD/BOL.",
        "A POD proves the GOODS were DELIVERED: delivery signature, " +
        "received/delivered date, consignee sign-off, piece/pallet counts. " +
        "A Rate Confirmation, Rate Agreement, Load Confirmation, Carrier " +
        "Confirmation or Load Tender proves the agreed CARRIER PAY/RATE and " +
        "is NOT a POD. NEVER include a rate/load confirmation page in " +
        "pod.documents, even if it is signed — it exposes carrier cost.",
        "NEVER include any page that shows a freight rate, line haul, fuel " +
        "surcharge, carrier pay, agreed rate, or any dollar rate/charge " +
        "amount. Only include pages proving delivery, with no pricing.",
        "Use source 'separate_attachment' ONLY when the POD is a DIFFERENT " +
        "file than the carrier invoice PDF. If the invoice and POD are in " +
        "the SAME PDF, list the POD pages individually by page number with " +
        "'signed_bol', 'signed_load', 'delivery_receipt', 'signed_pod', or " +
        "'unsigned_pod_template' — never 'separate_attachment'.",
        "When a separate JPEG or PNG attachment is a signed delivery photo " +
        "or POD scan (common on truckload invoices), set pod.found=true, " +
        "source='separate_attachment', and pod.attachmentFilename to that " +
        "image filename even though it is not a PDF.",
        "Use source 'same_page_as_invoice' ONLY when invoice line items " +
        "are on top and a small signature/stamp block is at the bottom. " +
        "Set pod.cropFromBottom to the bottom fraction (e.g. 0.35).",
        "Keep JSON compact: use empty arrays when a list has no items. " +
        "Do not invent placeholder charge objects. Cap pod.documents " +
        "at the pages that prove delivery (usually 1–4).",
        "On POD / delivery pages, populate pod.discrepancies when the " +
        "signed delivery paperwork notes damage, shortage, missing " +
        "cartons/pieces, partial delivery, or OS&D. Set " +
        "pod.discrepancies.found=true, damageNoted and/or " +
        "missingCartons as appropriate, and a brief details summary " +
        "(e.g. '2 cartons short', 'damage noted on skid').",
      ],
      requiredJsonShape: {
        invoices: [invoiceItemShape],
      },
    }),
  });

  const callClassifier = async (maxTokens) => client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: maxTokens,
    system: "You classify freight carrier invoice attachments. " +
      "Return ONLY a single valid JSON object. Never wrap in markdown " +
      "fences or add commentary. " +
      "Strictly match requiredJsonShape keys and types. " +
      "Return one invoices[] entry per distinct carrier load. " +
      "Keep output compact. " +
      "You can see the full PDF layout — use visual context to correctly " +
      "associate labels with their values even when they appear in columns.",
    messages: [{role: "user", content: contentBlocks}],
  });

  let response = await callClassifier(12288);
  try {
    return parseClassificationResponse(response.content);
  } catch (parseErr) {
    const truncated = response.stop_reason === "max_tokens";
    if (!truncated) throw parseErr;
    // One retry with a higher ceiling when the first answer was cut off.
    response = await callClassifier(16384);
    return parseClassificationResponse(response.content);
  }
}

/**
 * Re-classifies page chunks of a multi-load statement PDF to recover
 * loads the first full-PDF pass missed.
 * @param {Array<object>} pdfAttachments Saved PDF attachments.
 * @param {Array<object>} invoiceItems Items from the first classification.
 * @param {object} gap analyzeStatementExtractionGap result.
 * @param {number|null} lastKnownLoadNumber Last known valid load number.
 * @return {Promise<Array<object>>} Merged invoice items.
 */
async function supplementStatementInvoiceExtraction(
    pdfAttachments, invoiceItems, gap, lastKnownLoadNumber) {
  if (!gap || !gap.underExtracted) return invoiceItems;
  const primaryAtt = pdfAttachments.find((a) => a.docType !== "POD") ||
    pdfAttachments[0];
  if (!primaryAtt || !primaryAtt.buffer) return invoiceItems;

  const pageCount = gap.pageCount ||
    await getPdfPageCount(primaryAtt.buffer);
  if (pageCount < 3) return invoiceItems;

  const existingLoads = new Set(
      invoiceItems.map((i) => String(i.loadNumber || "").trim())
          .filter(Boolean));
  const merged = invoiceItems.slice();
  const chunkSize = 12;

  for (let start = 2; start <= pageCount; start += chunkSize - 1) {
    const end = Math.min(start + chunkSize - 1, pageCount);
    const pages = [];
    for (let p = start; p <= end; p++) pages.push(p);
    const chunkBuf = await slicePdfByPages(primaryAtt.buffer, pages);
    if (!chunkBuf) continue;

    const chunkAtt = {
      filename: `${primaryAtt.filename || "statement.pdf"}-p${start}-${end}.pdf`,
      mimeType: "application/pdf",
      buffer: chunkBuf,
      docType: "INVOICE",
    };
    try {
      const chunkResult = await classifyInvoiceData(
          [chunkAtt], lastKnownLoadNumber);
      const chunkItems = normalizeClassificationToInvoices(chunkResult);
      for (const item of chunkItems) {
        const ln = String(item.loadNumber || "").trim();
        if (!ln || existingLoads.has(ln)) continue;
        existingLoads.add(ln);
        item.attachmentFilename = primaryAtt.filename;
        merged.push(item);
      }
    } catch (chunkErr) {
      await writeLog("warn", "ai",
          "Statement chunk classification failed", {
            pages: `${start}-${end}`,
            error: chunkErr.message,
          });
    }
  }

  return merged;
}

/**
 * Reads statement index loads and runs under-extraction recovery when needed.
 * @param {object} opts messageId, subject, pdfAttachments, invoiceItems, etc.
 * @return {Promise<object>} {invoiceItems, gap}
 */
async function recoverStatementInvoiceItems(opts) {
  const {
    messageId,
    subject,
    pdfAttachments,
    invoiceItems,
    lastKnownLoadNumber,
  } = opts;
  if (!statementInvoiceBundle.looksLikeNumberedStatementSubject(subject)) {
    return {invoiceItems, gap: null};
  }

  const primaryPdf = pdfAttachments.find((a) => a.docType !== "POD") ||
    pdfAttachments[0];
  let indexLoadNumbers = [];
  let pageCount = 0;
  if (primaryPdf && primaryPdf.buffer) {
    pageCount = await getPdfPageCount(primaryPdf.buffer);
    const pageTexts = await extractPdfPageTexts(primaryPdf.buffer);
    if (pageTexts && pageTexts[0]) {
      indexLoadNumbers = statementInvoiceBundle.parseStatementIndexLoadNumbers(
          pageTexts[0]);
    }
  }

  let gap = statementInvoiceBundle.analyzeStatementExtractionGap({
    indexLoadNumbers,
    extractedLoadNumbers: invoiceItems.map((i) => i && i.loadNumber),
    pageCount,
  });
  if (!gap.underExtracted) {
    return {invoiceItems, gap};
  }

  await writeLog("warn", "ai", "Statement PDF under-extraction detected", {
    messageId,
    subject,
    expectedCount: gap.expectedCount,
    extractedCount: gap.extractedCount,
    missingLoads: gap.missingLoads,
    indexLoadCount: gap.indexLoads.length,
    pageCount: gap.pageCount,
  });

  let recovered = await supplementStatementInvoiceExtraction(
      pdfAttachments, invoiceItems, gap, lastKnownLoadNumber);
  gap = statementInvoiceBundle.analyzeStatementExtractionGap({
    indexLoadNumbers,
    extractedLoadNumbers: recovered.map((i) => i && i.loadNumber),
    pageCount,
  });
  if (gap.underExtracted && gap.missingLoads.length > 0) {
    await writeLog("warn", "ai",
        "Statement still missing loads after chunk supplement", {
          messageId,
          missingLoads: gap.missingLoads,
          extractedCount: gap.extractedCount,
          expectedCount: gap.expectedCount,
        });
  }
  return {invoiceItems: recovered, gap};
}

/**
 * Forwards a numbered statement/JTS packet to ops when invoice extraction
 * missed loads from the index or page-count expectation.
 * @param {object} args gmail, messageId, subject, from, gap, emailBody.
 * @return {Promise<void>}
 */
async function handleStatementUnderExtractionAlert(args) {
  const {
    gmail, messageId, subject, from, gap, emailBody,
  } = args;
  if (!statementInvoiceBundle.shouldAlertStatementUnderExtraction(gap)) {
    return;
  }

  const missingList = Array.isArray(gap.missingLoads) ?
    gap.missingLoads : [];
  const missingLabel = missingList.length > 0 ?
    missingList.join(", ") :
    `expected ~${gap.expectedCount}, extracted ${gap.extractedCount}`;

  const reason =
    "Statement PDF missing freight invoices — manual review required";
  const notes =
    `Hi, I'm ${AI_AGENT_NAME}, your AI assistant.\n\n` +
    `I received a numbered carrier statement packet ` +
    `(subject: ${subject || "—"}) that contains multiple freight ` +
    `invoices in one PDF.\n\n` +
    `I extracted ${gap.extractedCount} invoice(s) but ` +
    (missingList.length > 0 ?
      `${missingList.length} load(s) from the statement index were NOT ` +
      `extracted and were not queued for processing:\n` +
      `${missingList.join("\n")}\n\n` :
      `the PDF appears to contain more invoices than I extracted ` +
      `(expected ~${gap.expectedCount}, got ${gap.extractedCount}).\n\n`) +
    `I processed the invoice(s) I could identify. Please review the ` +
    `attached PDF and enter any missing loads manually, or reprocess ` +
    `after correcting.\n\nThank you,\n${AI_AGENT_NAME}`;

  await forwardToHumanReview(
      gmail, messageId, subject, from, reason, notes,
      {
        department: "operations",
        emailBody,
        extractedData: {
          "Subject": subject || "—",
          "Expected invoices": String(gap.expectedCount || "—"),
          "Extracted invoices": String(gap.extractedCount || "—"),
          "Missing load numbers": missingLabel,
          "PDF pages": gap.pageCount ? String(gap.pageCount) : "—",
        },
      },
  );

  await writeLog("warn", "mail",
      "Statement PDF under-extraction — forwarded to ops", {
        messageId,
        subject,
        expectedCount: gap.expectedCount,
        extractedCount: gap.extractedCount,
        missingLoads: missingList,
        pageCount: gap.pageCount,
      });
}

// Identity the AI agent uses to sign the emails it composes. Override with
// AI_AGENT_NAME. Applied to internal/ops/error notifications, not customer
// invoice emails (type "generated_bill").
const AI_AGENT_NAME = process.env.AI_AGENT_NAME || "Jerry";
const AGENT_GREETING_MARKER = "<!--agent-greeting-->";

/**
 * @return {string} HTML greeting that introduces the AI agent by name.
 */
function agentGreetingHtml() {
  return `${AGENT_GREETING_MARKER}` +
    `<div style="margin:0 0 16px">` +
    emailBranding.innovativeCarriersLogoHtml({mode: "cid", maxWidth: 280}) +
    `</div>` +
    `<p>Hi, I'm ${escapeHtml(AI_AGENT_NAME)}, your AI assistant.</p>`;
}

/**
 * Prepends the agent greeting to an HTML body unless it's already branded.
 * @param {string} html Email HTML body.
 * @return {string}
 */
function withAgentGreeting(html) {
  const body = String(html || "");
  if (body.includes(AGENT_GREETING_MARKER)) return body;
  return `${agentGreetingHtml()}${body}`;
}

/** Default ops alert recipient when env vars are unset. */
const LISA_EMAIL_DEFAULT = "Lisa@innovativecarriers.com";
/** Default system-error inbox when SYSTEM_ERROR_EMAIL is unset. */
const SYSTEM_ERROR_EMAIL_DEFAULT = "mshglck@gmail.com";
/** Outbound types that always route to the system-error inbox. */
const SYSTEM_ERROR_EMAIL_TYPES = new Set([
  "workflow_failed",
  "invoice_generation_failed",
  "stuck_flow",
]);

/**
 * Resolves the default ops alert inbox (Lisa / ALERT_EMAIL).
 * @param {object} tenant Tenant config.
 * @return {string}
 */
function resolveOpsAlertEmail(tenant) {
  return (tenant && tenant.alertEmail) ||
    process.env.ALERT_EMAIL ||
    LISA_EMAIL_DEFAULT;
}

/**
 * Resolves the system-error inbox (Advanced Automations).
 * @return {string}
 */
function resolveSystemErrorEmail() {
  return process.env.SYSTEM_ERROR_EMAIL || SYSTEM_ERROR_EMAIL_DEFAULT;
}

/**
 * True when an outbound email should go to the system-error inbox only.
 * @param {object} email Outbound email payload.
 * @return {boolean}
 */
function isSystemErrorOutboundEmail(email) {
  if (!email) return false;
  if (email.systemError === true) return true;
  if (email.alertCode &&
    workflowErrors.isSystemAlertCode(email.alertCode, email.alertContext)) {
    return true;
  }
  return SYSTEM_ERROR_EMAIL_TYPES.has(email.type);
}

/**
 * Persists and sends an outbound email.
 * @param {object} email - Email fields (type, subject, html, to, attachments).
 * @return {Promise<void>}
 */
async function saveOutboundEmail(email) {
  // Use the email's tenant, then the ambient tenant bound for this request
  // (set by runWithTenant/enterTenantContext). Only a genuinely tenant-less
  // context lands on DEFAULT_TENANT — a client's email is never sent from
  // another client's mailbox.
  const tenant = (email && email.tenant) || currentTenant() || DEFAULT_TENANT;
  let sendResult = null;
  // Customer invoice emails go to the bill-to party; ops alerts use alertEmail.
  // System errors (automation failures) go to SYSTEM_ERROR_EMAIL only.
  // `forceRecipient` pins delivery to an explicit address (e.g. additional
  // charge A/B/C/D reviewers) regardless of type.
  const defaultRecipient = isSystemErrorOutboundEmail(email) ?
    resolveSystemErrorEmail() :
    resolveOpsAlertEmail(tenant);
  const to = ((email.type === "generated_bill" || email.forceRecipient) &&
    email.to) ?
    email.to :
    (defaultRecipient || email.to || "");
  const cc = email.cc || null;

  // Brand agent-authored notifications (errors, action-needed, forwards, etc.)
  // as the AI agent. Customer invoice emails and any opt-out are left as-is.
  const shouldBrand = email.type !== "generated_bill" &&
    email.skipAgentGreeting !== true;
  const htmlToSend = shouldBrand ?
    withAgentGreeting(email.html) : (email.html || "");
  const sendOpts = {cc};
  if (shouldBrand) {
    sendOpts.inlineAttachments = [
      emailBranding.innovativeCarriersLogoInlineAttachment(),
    ];
  }

  // Persist first so a Gmail/network outage cannot swallow the record
  // (workflow_failed for 266499 never appeared in outboundEmails because
  // send ran before the Firestore write and hung/failed the request).
  const emailToStore = {...email, html: htmlToSend};
  delete emailToStore.tenant;
  delete emailToStore.skipAgentGreeting;
  delete emailToStore.forceRecipient;
  const emailRef = await tcol(tenant, "outboundEmails").add({
    ...emailToStore,
    to,
    cc,
    sendResult: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    deleteAt: getDeleteAt(7),
  });

  if (to) {
    try {
      await sendViaGmail(
          to,
          toOutboundEmailSafeSubject(email.subject || ""),
          htmlToSend,
          Array.isArray(email.attachments) ? email.attachments : [],
          tenant,
          sendOpts,
      );
      sendResult = {ok: true};
    } catch (sendErr) {
      sendResult = {ok: false, error: sendErr.message};
      console.error("saveOutboundEmail send error:", sendErr.message);
    }
    try {
      await emailRef.update({sendResult});
    } catch (updErr) {
      console.error("saveOutboundEmail sendResult update:", updErr.message);
    }
  } else {
    console.warn("saveOutboundEmail: no recipient, email not sent", {
      type: email.type,
      invoiceId: email.invoiceId,
    });
  }

  await writeLog("info", "email", "Outbound email sent", {
    type: email.type,
    invoiceId: email.invoiceId,
    to: to,
    cc: cc || null,
    intendedTo: email.to || null,
    sent: Boolean(sendResult && sendResult.ok),
  }, null, tenant);
}

/**
 * Builds a customer invoice PDF and returns it as base64.
 * @param {object} data - The invoice data.
 * @return {Promise<string>} Base64 encoded PDF.
 */
async function buildCustomerInvoicePdfBase64(data) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const W = 612;
  const H = 792;
  const MARGIN = 50;

  const fontReg = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const txt = (text, x, y, size, bold = false, color = null) => {
    const opts = {x, y, size, font: bold ? fontBold : fontReg};
    if (color) opts.color = color;
    page.drawText(String(text ?? ""), opts);
  };

  const BLUE = rgb(0.09, 0.28, 0.65);
  const GRAY = rgb(0.45, 0.45, 0.45);
  const BLACK = rgb(0, 0, 0);
  const WHITE = rgb(1, 1, 1);
  const LIGHT = rgb(0.95, 0.97, 1.0);

  // Header bar
  page.drawRectangle({x: 0, y: H - 80, width: W, height: 80, color: BLUE});
  txt("INNOVATIVE CARRIERS", MARGIN, H - 38, 20, true, WHITE);
  txt("FREIGHT INVOICE", W - 180, H - 38, 14, false, WHITE);

  // Invoice meta block (right side)
  const today = new Date();
  const fmt = (d) => d.toLocaleDateString("en-US",
      {month: "short", day: "numeric", year: "numeric"});
  const dueDate = new Date(today);
  dueDate.setDate(dueDate.getDate() + 30);

  const invoiceNum = data.invoiceNumber ||
      data.loadNumber || data.invoiceId || "";

  // Light info box
  page.drawRectangle(
      {x: W - 210, y: H - 175, width: 160, height: 85, color: LIGHT});
  txt("Invoice #:", W - 200, H - 105, 9, false, GRAY);
  txt(String(invoiceNum), W - 200, H - 118, 11, true, BLACK);
  txt("Date:", W - 200, H - 135, 9, false, GRAY);
  txt(fmt(today), W - 200, H - 148, 10, false, BLACK);
  txt("Due:", W - 200, H - 165, 9, false, GRAY);
  txt(fmt(dueDate), W - 200, H - 178, 10, false, BLACK);

  // Bill To
  txt("BILL TO:", MARGIN, H - 110, 9, false, GRAY);
  txt(data.customerName || "", MARGIN, H - 125, 12, true, BLACK);

  // Divider
  page.drawLine({
    start: {x: MARGIN, y: H - 195},
    end: {x: W - MARGIN, y: H - 195},
    thickness: 1,
    color: BLUE,
  });

  // Shipment details section
  txt("SHIPMENT DETAILS", MARGIN, H - 220, 10, true, BLUE);

  const col1 = MARGIN;
  const col2 = 220;
  const col3 = 390;

  const detail = (label, value, x, y) => {
    txt(label, x, y, 8, false, GRAY);
    txt(value || "—", x, y - 13, 10, false, BLACK);
  };

  detail("Load / BOL #", String(data.loadNumber || ""), col1, H - 238);
  detail("PRO #", String(data.proNumber || ""), col2, H - 238);
  detail("Shipper", String(data.shipperName || ""), col3, H - 238);
  detail("Consignee", String(data.consigneeName || ""), col1, H - 275);
  detail("Origin", String(data.originCity || ""), col2, H - 275);
  detail("Destination", String(data.destinationCity || ""), col3, H - 275);

  // Divider
  page.drawLine({
    start: {x: MARGIN, y: H - 305},
    end: {x: W - MARGIN, y: H - 305},
    thickness: 0.5,
    color: GRAY,
  });

  // Charges table header
  page.drawRectangle(
      {x: MARGIN, y: H - 335, width: W - MARGIN * 2, height: 22, color: BLUE},
  );
  txt("DESCRIPTION", MARGIN + 8, H - 328, 9, true, WHITE);
  txt("QTY", W - 190, H - 328, 9, true, WHITE);
  txt("RATE", W - 140, H - 328, 9, true, WHITE);
  txt("AMOUNT", W - 80, H - 328, 9, true, WHITE);

  // Charge row
  const amt = Number(data.customerRate || 0);
  page.drawRectangle(
      {x: MARGIN, y: H - 360, width: W - MARGIN * 2, height: 22, color: LIGHT},
  );
  txt("Freight Charges", MARGIN + 8, H - 353, 10, false, BLACK);
  txt("1", W - 186, H - 353, 10, false, BLACK);
  txt(`$${amt.toFixed(2)}`, W - 145, H - 353, 10, false, BLACK);
  txt(`$${amt.toFixed(2)}`, W - 85, H - 353, 10, true, BLACK);

  // Total box
  page.drawRectangle(
      {x: W - 210, y: H - 405, width: 160, height: 36, color: BLUE});
  txt("TOTAL DUE:", W - 200, H - 385, 10, false, WHITE);
  txt(`$${amt.toFixed(2)}`, W - 200, H - 400, 14, true, WHITE);

  // Divider
  page.drawLine({
    start: {x: MARGIN, y: H - 420},
    end: {x: W - MARGIN, y: H - 420},
    thickness: 1,
    color: BLUE,
  });

  // Payment instructions
  txt("PAYMENT INSTRUCTIONS", MARGIN, H - 440, 10, true, BLUE);

  const payLines = [
    ["ACH / Wire Transfer", true],
    ["Bank: Customers Bank", false],
    ["99 Bridge St, Phoenixville, PA 19460", false],
    ["Account: 4255247", false],
    ["Routing (ACH & Domestic Wire): 031302971", false],
    ["", false],
    ["Quickpay / Zelle", true],
    ["accounting@innovativecarriers.com", false],
    ["", false],
    ["Check (email image)", true],
    ["Abe@innovativecarriers.com", false],
    ["", false],
    ["Credit Card (3% fee)", true],
    ["https://secure.cardknox.com/innovativecarriers", false],
  ];

  let py = H - 458;
  for (const [line, bold] of payLines) {
    if (line) txt(line, MARGIN, py, 9, bold, bold ? BLACK : GRAY);
    py -= 13;
  }

  // Footer
  page.drawRectangle({x: 0, y: 0, width: W, height: 28, color: BLUE});
  txt("$50.00 maximum liability per shipment  |  " +
      "Innovative Carriers  |  accounting@innovativecarriers.com",
  MARGIN, 9, 8, false, WHITE);

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes).toString("base64");
}

/**
 * Builds a continue button HTML for workflow emails.
 * @param {string} baseUrl - The base URL.
 * @param {string} invoiceId - The invoice ID.
 * @param {string} [tenantId] - Owning tenant, added to the link so the
 *   prefixed-tenant invoice is found on resume.
 * @return {string} HTML string.
 */
function buildContinueButtonHtml(baseUrl, invoiceId, tenantId) {
  const tq = tenantId ?
    `&tenantId=${encodeURIComponent(tenantId)}` : "";
  const continueUrl =
    `${baseUrl}/continueWorkflow?invoiceId=${encodeURIComponent(invoiceId)}` +
    tq;
  return `<p><a href="${continueUrl}" ` +
    `style="display:inline-block;padding:10px 16px;` +
    `background:#2563eb;color:#fff;text-decoration:none;` +
    `border-radius:8px">Continue</a></p>`;
}

/**
 * Pauses the workflow for an invoice.
 * @param {object} invoiceRef - The invoice document reference.
 * @param {string} pausedAtStep - The step where workflow was paused.
 * @param {string} decisionStage - The decision stage.
 * @param {string} decisionReason - The reason for the decision.
 * @return {Promise<void>}
 */
async function pauseWorkflow(
    invoiceRef,
    pausedAtStep,
    decisionStage,
    decisionReason,
) {
  await invoiceRef.update({
    workflowPausedAtStep: pausedAtStep,
    workflowPausedAt: admin.firestore.FieldValue.serverTimestamp(),
    decisionStage: decisionStage,
    decisionReason: decisionReason,
    processingLock: false,
    finalWorkflowStatus: "waiting_manual",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Saves weight & inspection certificate PDF bytes to Storage.
 * @param {string} invoiceId Invoice id.
 * @param {string} filename File name under weightCert/{invoiceId}/.
 * @param {Uint8Array} pdfBytes PDF bytes.
 * @return {Promise<string>} Storage path.
 */
async function saveWeightCertPdfBytes(invoiceId, filename, pdfBytes) {
  const storagePath = `weightCert/${invoiceId}/${filename}`;
  await getBucket().file(storagePath).save(Buffer.from(pdfBytes), {
    metadata: {contentType: "application/pdf"},
  });
  return storagePath;
}

/**
 * Pulls XPO weight & inspection certificate from the Imaging API when the
 * invoice email did not include one.
 * @param {string} messageId Gmail message id (logging).
 * @param {object} aiResult Classified invoice fields (mutated on success).
 * @return {Promise<object|null>} Saved cert info or null.
 */
async function maybeFetchXpoWeightCert(messageId, aiResult) {
  if (!aiResult || aiResult.hasWeightInspectionCertificate) {
    return null;
  }
  if (!xpoImaging.isXpoCarrier(aiResult.carrierName)) {
    return null;
  }
  const proNumber = xpoImaging.resolveXpoPro({
    proNumber: aiResult.proNumber,
    invoiceNumber: aiResult.invoiceNumber,
  });
  if (!proNumber) {
    await writeLog("info", "workflow",
        "XPO invoice — no PRO for weight cert fetch", {
          messageId,
          loadNumber: aiResult.loadNumber,
          carrierName: aiResult.carrierName,
        });
    return null;
  }

  let result;
  try {
    result = await xpoImaging.fetchXpoWeightCertPdf(proNumber);
  } catch (err) {
    await writeLog("warn", "workflow", "XPO weight cert fetch failed", {
      messageId,
      loadNumber: aiResult.loadNumber,
      proNumber,
      error: err.message,
    });
    return null;
  }

  if (!result.ok || !result.pdfBuffer) {
    await writeLog("info", "workflow", "XPO weight cert not available", {
      messageId,
      loadNumber: aiResult.loadNumber,
      proNumber,
      error: result.error || "unknown",
      attempts: result.attempts || null,
    });
    return null;
  }

  const filename = `xpo-wi-${proNumber}.pdf`;
  const storagePath = await saveWeightCertPdfBytes(
      messageId, filename, result.pdfBuffer);
  aiResult.hasWeightInspectionCertificate = true;
  await writeLog("info", "workflow",
      "XPO weight & inspection certificate downloaded", {
        messageId,
        loadNumber: aiResult.loadNumber,
        proNumber,
        imageType: result.imageType || null,
        storagePath,
      });
  return {
    storagePath,
    filename,
    source: "xpo_imaging_api",
    proNumber,
    imageType: result.imageType || null,
    mimeType: "application/pdf",
    docType: "WEIGHT_INSPECTION_CERT",
  };
}

/**
 * Pulls FedEx Freight POD from the public tracking API when missing locally.
 * @param {string} invoiceId Invoice id.
 * @param {object} invoice Invoice document.
 * @return {Promise<object|null>} POD file info or null.
 */
async function maybeFetchFedExFreightPod(invoiceId, invoice) {
  if (!invoice || !fedexFreightPod.isFedExFreightCarrier(invoice.carrierName)) {
    if (invoice && /fed\s*ex/i.test(String(invoice.carrierName || ""))) {
      await writeLog("info", "workflow",
          "FedEx Freight POD fetch skipped — carrier name did not match", {
            invoiceId,
            loadNumber: invoice.loadNumber,
            carrierName: invoice.carrierName || null,
          });
    }
    return null;
  }
  const proNumber = fedexFreightPod.resolveFedExFreightPro({
    proNumber: invoice.proNumber,
    invoiceNumber: invoice.invoiceNumber,
  });
  if (!proNumber) {
    await writeLog("info", "workflow",
        "FedEx Freight invoice — no PRO/invoice number for POD fetch", {
          invoiceId,
          loadNumber: invoice.loadNumber,
          carrierName: invoice.carrierName,
        });
    return null;
  }

  let result;
  try {
    result = await fedexFreightPod.fetchFedExFreightPodPdf(proNumber);
  } catch (err) {
    await writeLog("warn", "workflow", "FedEx Freight POD fetch failed", {
      invoiceId,
      loadNumber: invoice.loadNumber,
      proNumber,
      error: err.message,
    });
    return null;
  }

  if (!result.ok || !result.pdfBuffer) {
    await writeLog("warn", "workflow", "FedEx Freight POD not available", {
      invoiceId,
      loadNumber: invoice.loadNumber,
      proNumber,
      accountNumber: result.accountNumber || null,
      error: result.error || "unknown",
    });
    return null;
  }

  const filename = `fedex-pod-${proNumber}.pdf`;
  const storagePath = await savePodPdfBytes(
      invoiceId, filename, result.pdfBuffer);
  await writeLog("info", "workflow",
      "FedEx Freight POD downloaded from tracking site", {
        invoiceId,
        loadNumber: invoice.loadNumber,
        proNumber,
        accountNumber: result.accountNumber,
        storagePath,
        keyStatus: result.keyStatus || null,
      });
  return {
    storagePath,
    source: "fedex_freight_tracking",
    files: [{
      storagePath,
      source: "fedex_freight_tracking",
    }],
  };
}

/**
 * Extracts POD-only PDF(s) from invoice attachments.
 * Multiple POD pages are saved individually and merged into pod.pdf.
 * @param {string} invoiceId - The invoice ID.
 * @param {object} invoice - The invoice document.
 * @return {Promise<object|null>} POD file info or null.
 */
async function maybeExtractPodOnlyPdf(invoiceId, invoice) {
  try {
    const rawPod = invoice && invoice.pod;
    const attachments = Array.isArray(invoice.attachments) ?
      invoice.attachments : [];
    let pageCountHint = 0;
    const hintFilename = rawPod && rawPod.attachmentFilename;
    const firstAtt = attachments.find(
        (a) => a && a.filename === hintFilename,
    ) || attachments.find((a) => a && a.storagePath);
    if (firstAtt && firstAtt.storagePath) {
      try {
        const [fileBuffer] = await getBucket()
            .file(firstAtt.storagePath).download();
        const loaded = await PDFDocument.load(fileBuffer);
        pageCountHint = loaded.getPageCount();
      } catch (_) {
        // page count enrichment is best-effort
      }
    }
    const {normalized: podNormalized, documents} = resolvePodDocuments(
        rawPod, {pageCount: pageCountHint},
    );
    if (!invoice || !podNormalized || podNormalized.found !== true ||
        documents.length === 0) {
      const fedexPod = await maybeFetchFedExFreightPod(invoiceId, invoice);
      if (fedexPod) {
        return fedexPod;
      }
      await writeLog("info", "workflow",
          "POD not detected in this invoice — no extraction attempted", {
            invoiceId,
            loadNumber: invoice && invoice.loadNumber,
            carrierName: invoice && invoice.carrierName,
            podFound: podNormalized && podNormalized.found,
            podSource: podNormalized && podNormalized.source,
            podDocumentCount: documents.length,
            podReason: podNormalized && podNormalized.reason,
          });
      return null;
    }

    if (documents.length === 1 &&
        documents[0].source === "separate_attachment") {
      const podAtt = attachments.find(
          (a) => a && a.filename === documents[0].attachmentFilename,
      );
      if (!podAtt || !podAtt.storagePath) {
        return null;
      }
      const [attBuffer] = await getBucket()
          .file(podAtt.storagePath).download();

      // SAFETY: never send the carrier bill OR the carrier rate/load
      // confirmation to the customer as POD. When the "separate attachment" is
      // really the combined invoice+POD PDF (single email attachment),
      // returning it wholesale leaks carrier cost. Keep only pages whose REAL
      // text neither shows the invoice amount nor carries rate-confirmation
      // pricing markers. Text is read from the ORIGINAL buffer (decompressed);
      // pdf-lib-saved bytes are compressed and cannot be scanned.
      const srcDoc = await PDFDocument.load(attBuffer);
      const srcPageCount = srcDoc.getPageCount();
      const pageTexts = await extractPdfPageTexts(attBuffer);
      const cleanDoc = await PDFDocument.create();
      let keptPages = 0;
      let droppedInvoicePages = 0;
      let unverifiedPages = 0;
      const droppedReasons = [];
      for (let p = 0; p < srcPageCount; p++) {
        const verdict = textLooksUnsafeForCustomer(
            pageTexts ? pageTexts[p] : null, invoice.invoiceAmount);
        if (verdict.unsafe) {
          droppedInvoicePages++;
          droppedReasons.push(`p${p + 1}:${verdict.reason}`);
          continue;
        }
        if (!verdict.hasText) unverifiedPages++;
        const [keep] = await cleanDoc.copyPages(srcDoc, [p]);
        cleanDoc.addPage(keep);
        keptPages++;
      }

      // No readable text anywhere (scanned image) AND more than one page in a
      // file the AI thought bundled the invoice: we cannot prove the bill/rate
      // pages are gone. Fail safe — do not auto-send; hold for human review.
      if (!pageTexts && srcPageCount > 1) {
        await writeLog("error", "workflow",
            "POD separate_attachment held — multi-page scanned file with no " +
            "readable text; cannot verify it is free of carrier cost", {
              invoiceId,
              loadNumber: invoice.loadNumber,
              attachment: podAtt.filename,
              srcPageCount,
            });
        return null;
      }

      if (keptPages === 0) {
        await writeLog("warn", "workflow",
            "POD separate_attachment dropped — every page exposes carrier " +
            "cost (invoice amount or rate confirmation)", {
              invoiceId,
              loadNumber: invoice.loadNumber,
              attachment: podAtt.filename,
              srcPageCount,
              droppedInvoicePages,
              droppedReasons,
            });
        return null;
      }
      if (unverifiedPages > 0) {
        await writeLog("warn", "workflow",
            "POD separate_attachment kept page(s) with no readable text — " +
            "verified by AI classification only, not by text scan", {
              invoiceId,
              loadNumber: invoice.loadNumber,
              attachment: podAtt.filename,
              unverifiedPages,
            });
      }

      // No unsafe pages present — genuine standalone POD; keep original file.
      if (droppedInvoicePages === 0) {
        return {
          storagePath: podAtt.storagePath,
          source: "separate_attachment",
          files: [{
            storagePath: podAtt.storagePath,
            source: "separate_attachment",
            page: null,
          }],
        };
      }

      // Combined invoice+POD: save the cost-free subset only.
      const cleanBytes = await cleanDoc.save();
      const cleanPath = await savePodPdfBytes(
          invoiceId, "pod.pdf", cleanBytes);
      await writeLog("info", "workflow",
          "POD separate_attachment sanitized — removed carrier-cost page(s)", {
            invoiceId,
            loadNumber: invoice.loadNumber,
            attachment: podAtt.filename,
            keptPages,
            droppedInvoicePages,
            droppedReasons,
          });
      return {
        storagePath: cleanPath,
        source: "separate_attachment",
        files: [{
          storagePath: cleanPath,
          source: "separate_attachment",
          page: null,
        }],
      };
    }

    const files = [];
    const mergedDoc = await PDFDocument.create();
    const bufferCache = new Map();
    const textCache = new Map();

    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      const podAtt = attachments.find(
          (a) => a && a.filename === doc.attachmentFilename,
      );
      if (!podAtt || !podAtt.storagePath) {
        await writeLog("warn", "workflow",
            "POD document entry missing attachment in storage", {
              invoiceId,
              loadNumber: invoice.loadNumber,
              expectedFilename: doc.attachmentFilename,
              podSource: doc.source,
              podPage: doc.page,
            });
        continue;
      }

      if (!bufferCache.has(podAtt.storagePath)) {
        const [fileBuffer] = await getBucket()
            .file(podAtt.storagePath).download();
        bufferCache.set(podAtt.storagePath, fileBuffer);
      }
      const fileBuffer = bufferCache.get(podAtt.storagePath);
      const loadedDoc = await PDFDocument.load(fileBuffer);
      if (!textCache.has(podAtt.storagePath)) {
        textCache.set(podAtt.storagePath,
            await extractPdfPageTexts(fileBuffer));
      }
      const pageTexts = textCache.get(podAtt.storagePath);
      const pdfBytes = await extractPodDocumentPdfBytes(loadedDoc, doc);
      if (!pdfBytes) {
        continue;
      }

      // Check the REAL text of the source page(s) this doc covers.
      const pageCount = loadedDoc.getPageCount();
      const pageIndex = resolvePodPageIndex(doc, pageCount);
      if (pageIndex === null) {
        await writeLog("warn", "workflow",
            "Skipped POD page — invalid or missing page number", {
              invoiceId,
              loadNumber: invoice.loadNumber,
              podPage: doc.page,
              podSource: doc.source,
            });
        continue;
      }
      const pageText = pageTexts &&
        pageIndex >= 0 && pageIndex < pageTexts.length ?
        pageTexts[pageIndex] : null;
      const verdict =
          textLooksUnsafeForCustomer(pageText, invoice.invoiceAmount);
      if (verdict.unsafe) {
        await writeLog("warn", "workflow",
            "Skipped POD page — exposes carrier cost", {
              invoiceId,
              loadNumber: invoice.loadNumber,
              podPage: doc.page,
              podSource: doc.source,
              invoiceAmount: invoice.invoiceAmount,
              reason: verdict.reason,
            });
        continue;
      }

      const pageLabel = doc.page ? `p${doc.page}` : `part${i + 1}`;
      const partName = `pod-${pageLabel}-${doc.source || "page"}.pdf`
          .replace(/[^a-zA-Z0-9._-]/g, "-");
      const storagePath = await savePodPdfBytes(
          invoiceId, partName, pdfBytes);

      files.push({
        storagePath,
        source: doc.source,
        page: doc.page != null && doc.page !== "" ?
          Number(doc.page) : null,
      });

      const partDoc = await PDFDocument.load(pdfBytes);
      const partPages = partDoc.getPageIndices();
      const copied = await mergedDoc.copyPages(partDoc, partPages);
      for (const page of copied) {
        mergedDoc.addPage(page);
      }
    }

    if (files.length === 0) {
      await writeLog("warn", "workflow",
          "POD was detected but no pages could be extracted", {
            invoiceId,
            loadNumber: invoice.loadNumber,
            podDocumentCount: documents.length,
          });
      return null;
    }

    let combinedPath = files[0].storagePath;
    if (files.length > 1) {
      const combinedBytes = await mergedDoc.save();
      combinedPath = await savePodPdfBytes(invoiceId, "pod.pdf", combinedBytes);
    }

    await writeLog("info", "workflow", "POD extraction completed", {
      invoiceId,
      loadNumber: invoice.loadNumber,
      podPageCount: files.length,
      podSources: files.map((f) => f.source),
      combinedStoragePath: combinedPath,
    });

    return {
      storagePath: combinedPath,
      source: files.length > 1 ? "multi" : files[0].source,
      files,
    };
  } catch (error) {
    await writeLog("error", "storage", "POD extraction failed", {
      invoiceId,
      error: error.message,
    });
    return null;
  }
}

/**
 * Sanitizes an object by replacing undefined values with null.
 * @param {any} obj - The object to sanitize.
 * @return {any} The sanitized object.
 */
function sanitizeObject(obj) {
  if (obj === undefined) {
    return null;
  }
  if (obj === null) {
    return null;
  }
  if (typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item));
  }
  const result = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      result[key] = sanitizeObject(obj[key]);
    }
  }
  return result;
}

/**
 * Logs a workflow step to Firestore.
 * @param {object} data - The log data.
 * @param {string} data.invoiceId - The invoice ID.
 * @param {string} data.gmailMessageId - The Gmail message ID.
 * @param {string} data.stepName - The step name.
 * @param {string} data.stepStatus - The step status.
 * @param {string} data.reason - The reason.
 * @param {object} data.input - The input data.
 * @param {object} data.output - The output data.
 * @param {string} data.error - The error message.
 * @return {Promise<void>}
 */
async function logWorkflowStep(data) {
  const {
    invoiceId,
    gmailMessageId,
    stepName,
    stepStatus,
    reason,
    input,
    output,
    error,
    tenant,
  } = data || {};

  await tcol(tenant || currentTenant() || DEFAULT_TENANT, "workflowLogs").add({
    invoiceId: invoiceId || null,
    gmailMessageId: gmailMessageId || null,
    stepName: stepName || "unknown",
    stepStatus: stepStatus || "unknown",
    reason: reason || null,
    input: sanitizeObject(input) || null,
    output: sanitizeObject(output) || null,
    error: error || null,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Normalizes AI charge arrays from the classification result.
 * @param {object} aiResult - The AI classification result.
 * @return {object} Normalized charge arrays.
 */
function normalizeAiChargeArrays(aiResult) {
  const keepCharge = (c) => {
    if (!c || typeof c !== "object") return false;
    const label = String(c.label || c.type || "").trim();
    const amt = Number(c.amount);
    return label.length > 0 || (Number.isFinite(amt) && Math.abs(amt) > 0);
  };
  const recognizedCharges = (Array.isArray(aiResult.recognizedCharges) ?
    aiResult.recognizedCharges : []).filter(keepCharge);
  const unrecognizedCharges =
    (Array.isArray(aiResult.unrecognizedCharges) ?
      aiResult.unrecognizedCharges : []).filter(keepCharge);
  const chargesNeedProof = (Array.isArray(aiResult.chargesNeedProof) ?
    aiResult.chargesNeedProof : []).filter(keepCharge);
  const chargeProofRefs = Array.isArray(aiResult.chargeProofRefs) ?
    aiResult.chargeProofRefs : [];

  return {
    recognizedCharges,
    unrecognizedCharges,
    chargesNeedProof,
    chargeProofRefs,
  };
}

/**
 * Saves POD PDF bytes to Storage.
 * @param {string} invoiceId Invoice id.
 * @param {string} filename File name under podOnly/{invoiceId}/.
 * @param {Uint8Array} pdfBytes PDF bytes.
 * @return {Promise<string>} Storage path.
 */
async function savePodPdfBytes(invoiceId, filename, pdfBytes) {
  const storagePath = `podOnly/${invoiceId}/${filename}`;
  await getBucket().file(storagePath).save(Buffer.from(pdfBytes), {
    metadata: {contentType: "application/pdf"},
  });
  return storagePath;
}

/**
 * @param {Array<object>} storedAttachments Saved attachment metadata.
 * @return {Array<object>} Image attachments usable as POD.
 */
function listPodImageAttachments(storedAttachments) {
  return (Array.isArray(storedAttachments) ? storedAttachments : [])
      .filter((a) =>
        a && a.storagePath &&
        (a.docType === "POD_IMAGE" || a.docType === "TRAILER_IMAGE" ||
          /^image\//i.test(String(a.mimeType || ""))));
}

/**
 * Builds a POD PDF from JPEG/PNG attachments on the same email as an invoice.
 * @param {Array<object>} storedAttachments Saved attachment metadata.
 * @param {string} messageId Mail message id.
 * @param {string} [loadHint] Load number or item index for filenames.
 * @return {Promise<object|null>} {podMeta, podOnlyFile} or null.
 */
async function maybeBuildPodFromEmailImages(
    storedAttachments, messageId, loadHint) {
  const podFollowup = require("./pod-followup");
  const imageAtts = listPodImageAttachments(storedAttachments);
  if (!imageAtts.length) return null;

  const images = [];
  for (const att of imageAtts) {
    try {
      const [buf] = await getBucket().file(att.storagePath).download();
      if (buf && buf.length) {
        images.push({
          buffer: buf,
          mimeType: att.mimeType ||
            podFollowup.detectImageMime(att, buf),
          filename: att.filename,
        });
      }
    } catch (err) {
      await writeLog("warn", "workflow",
          "Failed to download POD image attachment", {
            messageId,
            storagePath: att.storagePath,
            error: err.message,
          });
    }
  }
  if (!images.length) return null;

  const built = await podFollowup.imagesToPodPdf(images);
  if (!built.ok || !built.pdfBuffer) {
    await writeLog("warn", "workflow",
        "POD image attachments could not be embedded into PDF", {
          messageId,
          error: built.error,
          skipped: built.skipped,
        });
    return null;
  }

  const safeHint = String(loadHint || "load")
      .replace(/[^a-zA-Z0-9._-]/g, "_");
  const filename = `pod-image-${safeHint}.pdf`;
  const storagePath =
    `emailAttachments/${messageId}/${Date.now()}-${filename}`;
  await getBucket().file(storagePath).save(built.pdfBuffer, {
    metadata: {contentType: "application/pdf"},
  });

  const firstFilename = imageAtts[0].filename || "pod.jpg";
  await writeLog("info", "storage",
      "Built POD PDF from JPEG/PNG email attachments", {
        messageId,
        storagePath,
        imageCount: images.length,
        pageCount: built.pageCount,
      });

  return {
    podOnlyFile: {
      storagePath,
      source: "pod_image_attachment",
    },
    podMeta: {
      found: true,
      source: "separate_attachment",
      attachmentFilename: firstFilename,
      page: 1,
      reason: "POD provided as JPEG/PNG attachment",
      documents: [{
        source: "separate_attachment",
        page: 1,
        attachmentFilename: firstFilename,
      }],
    },
  };
}

/**
 * Builds a POD PDF from TRAILER_IMAGE attachments on an invoice (Power Only).
 * @param {string} invoiceId Firestore invoice id.
 * @param {object} invoice Invoice data with attachments[].
 * @return {Promise<object|null>} {storagePath, source, pageCount} or null.
 */
async function maybeBuildPodFromTrailerImages(invoiceId, invoice) {
  const podFollowup = require("./pod-followup");
  const atts = Array.isArray(invoice && invoice.attachments) ?
    invoice.attachments : [];
  const imageAtts = atts.filter((a) =>
    a && a.storagePath &&
    (a.docType === "POD_IMAGE" || a.docType === "TRAILER_IMAGE" ||
      /^image\//i.test(String(a.mimeType || ""))));
  if (!imageAtts.length) return null;

  const images = [];
  for (const att of imageAtts) {
    try {
      const [buf] = await getBucket().file(att.storagePath).download();
      if (!buf || !buf.length) continue;
      images.push({
        buffer: buf,
        mimeType: att.mimeType ||
          podFollowup.detectImageMime(att, buf),
        filename: att.filename,
      });
    } catch (err) {
      await writeLog("warn", "workflow",
          "Failed to download trailer image for POD", {
            invoiceId,
            storagePath: att.storagePath,
            error: err.message,
          });
    }
  }
  if (!images.length) return null;

  const built = await podFollowup.imagesToPodPdf(images);
  if (!built.ok || !built.pdfBuffer) {
    await writeLog("warn", "workflow",
        "Trailer images could not be embedded into POD PDF", {
          invoiceId,
          error: built.error,
          skipped: built.skipped,
        });
    return null;
  }
  const storagePath = await savePodPdfBytes(
      invoiceId, "trailer-pod.pdf", built.pdfBuffer);
  return {
    storagePath,
    source: "pod_image_attachment",
    pageCount: built.pageCount,
    files: [{storagePath, source: "pod_image_attachment"}],
  };
}

/**
 * Extracts a likely load/BOL or PRO from email subject/body text.
 * @param {string} subject Subject.
 * @param {string} body Body.
 * @param {object} [hints] Optional AI hints (loadNumberHint, proNumberHint).
 * @return {object} {loadNumber, proNumber}
 */
function extractLoadHintsFromEmail(subject, body, hints) {
  return loadResolution.extractLoadHintsFromEmailText(subject, body, hints);
}

/**
 * Emails Lisa when someone requests a signed POD we may not have on file.
 * @param {object} opts Request context.
 * @return {Promise<object>}
 */
async function notifyLisaSignedPodRequest(opts) {
  const podFollowup = require("./pod-followup");
  const {
    messageId,
    subject,
    from,
    loadNumber,
    proNumber,
    requesterEmail,
    emailBody,
  } = opts || {};
  const lisa = process.env.LOW_PROFIT_CC_EMAIL || podFollowup.LISA_EMAIL;
  const html =
    `<p>Hi Lisa,</p>` +
    `<p>Someone asked for a <strong>signed POD</strong> on load ` +
    `<strong>${escapeHtml(String(loadNumber || "—"))}</strong>. ` +
    `Jerry did not auto-send a document — please obtain the signed POD ` +
    `and send it to the requester.</p>` +
    `<table style="border-collapse:collapse;font-size:14px;margin:12px 0">` +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">From</td>` +
    `<td>${escapeHtml(from || "—")}</td></tr>` +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">Reply to</td>` +
    `<td>${escapeHtml(requesterEmail || "—")}</td></tr>` +
    (proNumber ?
      `<tr><td style="padding:4px 16px 4px 0;font-weight:600">PRO</td>` +
      `<td>${escapeHtml(String(proNumber))}</td></tr>` : "") +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">Subject</td>` +
    `<td>${escapeHtml(subject || "—")}</td></tr>` +
    `</table>` +
    (emailBody ?
      `<p style="margin:12px 0"><em>${escapeHtml(
          String(emailBody).slice(0, 800))}</em></p>` : "");

  await saveOutboundEmail({
    type: "signed_pod_request",
    forceRecipient: true,
    to: lisa,
    subject: `Signed POD requested — Load ${loadNumber || "—"}`,
    html,
    tenant: opts && opts.tenant,
  });

  await writeLog("info", "email", "Signed POD request escalated to Lisa", {
    messageId,
    loadNumber,
    proNumber: proNumber || null,
    requesterEmail,
    to: lisa,
  });

  await dashboardTasks.createDashboardTask(db, {
    tenantId: (opts && opts.tenant && opts.tenant.tenantId) || "default",
    type: dashboardTasks.TASK_TYPE.SIGNED_POD,
    title: `Signed POD requested — Load ${loadNumber || "—"}`,
    description: requesterEmail ?
      `Reply to ${requesterEmail}` : null,
    loadNumber: loadNumber || null,
    proNumber: proNumber || null,
    messageId: messageId || null,
    reason: "signed_pod_request",
  });

  return {ok: true, sent: true, to: lisa};
}

/**
 * Emails Lisa when a POD request cannot be auto-sent to a system/noreply
 * recipient.
 * @param {object} opts Request context.
 * @return {Promise<object>}
 */
async function notifyLisaPodRequestBlockedRecipient(opts) {
  const podFollowup = require("./pod-followup");
  const {
    messageId,
    subject,
    from,
    loadNumber,
    proNumber,
    requesterEmail,
    emailBody,
  } = opts || {};
  const reviewTo =
    process.env.INVOICE_VETO_REVIEW_EMAIL ||
    process.env.HUMAN_REVIEW_EMAIL ||
    podFollowup.LISA_EMAIL;
  const html =
    `<p>Hi,</p>` +
    `<p>Someone asked for a POD on load ` +
    `<strong>${escapeHtml(String(loadNumber || "—"))}</strong>, but Jerry ` +
    `did not auto-send because the reply-to address looks like a system or ` +
    `no-reply mailbox (<strong>${escapeHtml(
        requesterEmail || "—")}</strong>). Please review and send the POD ` +
    `manually if appropriate.</p>` +
    `<table style="border-collapse:collapse;font-size:14px;margin:12px 0">` +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">From</td>` +
    `<td>${escapeHtml(from || "—")}</td></tr>` +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">Reply to</td>` +
    `<td>${escapeHtml(requesterEmail || "—")}</td></tr>` +
    (proNumber ?
      `<tr><td style="padding:4px 16px 4px 0;font-weight:600">PRO</td>` +
      `<td>${escapeHtml(String(proNumber))}</td></tr>` : "") +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">Subject</td>` +
    `<td>${escapeHtml(subject || "—")}</td></tr>` +
    `</table>` +
    (emailBody ?
      `<p style="margin:12px 0"><em>${escapeHtml(
          String(emailBody).slice(0, 800))}</em></p>` : "");

  await saveOutboundEmail({
    type: "pod_request_blocked_recipient",
    forceRecipient: true,
    to: reviewTo,
    subject: `POD request needs review — Load ${loadNumber || "—"}`,
    html,
    tenant: opts && opts.tenant,
  });

  await writeLog("info", "email",
      "POD request escalated — blocked system recipient", {
        messageId,
        loadNumber,
        proNumber: proNumber || null,
        requesterEmail,
        to: reviewTo,
      });

  await dashboardTasks.createDashboardTask(db, {
    tenantId: (opts && opts.tenant && opts.tenant.tenantId) || "default",
    type: dashboardTasks.TASK_TYPE.SIGNED_POD,
    title: `POD request needs review — Load ${loadNumber || "—"}`,
    description: requesterEmail ?
      `Blocked auto-send to ${requesterEmail}` : null,
    loadNumber: loadNumber || null,
    proNumber: proNumber || null,
    messageId: messageId || null,
    reason: "pod_request_blocked_recipient",
  });

  return {ok: true, sent: true, to: reviewTo};
}

/**
 * Handles inbound emails asking us to send a POD from Primus.
 * Signed-POD requests escalate to Lisa instead of auto-sending.
 * @param {object} opts gmail, messageId, subject, from, emailBody, tenant,
 *   emailClassification.
 * @return {Promise<object>} {handled, status, loadNumber, error?}
 */
async function handlePodRequestEmail(opts) {
  const {
    messageId, subject, from, emailBody, tenant, emailClassification,
  } = opts;

  const intent = emailClassification && emailClassification.intent;
  if (!podRequestIntake.isPodRequestEmail(
      subject, emailBody, intent, emailClassification)) {
    return {handled: false};
  }

  const hints = {
    loadNumberHint: emailClassification && emailClassification.loadNumberHint,
    proNumberHint: emailClassification && emailClassification.proNumberHint,
  };
  const extracted = extractLoadHintsFromEmail(subject, emailBody, hints);
  let loadNumber = extracted.loadNumber;
  const proNumber = extracted.proNumber;

  if (!loadNumber && proNumber) {
    try {
      const booking = await fetchPrimusBookingByPro(proNumber);
      if (booking) {
        loadNumber = String(
            booking.BOLNumber || booking.bolNumber || "").trim() || null;
      }
    } catch (_) {
      // ignore
    }
  }

  if (!loadNumber) {
    await writeLog("warn", "mail",
        "POD request email — could not resolve load/BOL", {
          messageId, subject, hints,
        });
    return {handled: false};
  }

  const requesterEmail = podRequestIntake.parseEmailAddressFromHeader(from);
  const wantsSignedPod = podRequestIntake.looksLikeSignedPodRequest(
      subject, emailBody);

  if (requesterEmail && podSendDedup.isBlockedPodRecipient(requesterEmail)) {
    await notifyLisaPodRequestBlockedRecipient({
      messageId,
      subject,
      from,
      loadNumber,
      proNumber,
      requesterEmail,
      emailBody,
      tenant,
    });
    return {
      handled: true,
      status: "pod_request_escalated_system_recipient",
      loadNumber,
      requesterEmail,
      escalatedToLisa: true,
    };
  }

  if (wantsSignedPod) {
    await notifyLisaSignedPodRequest({
      messageId,
      subject,
      from,
      loadNumber,
      proNumber,
      requesterEmail,
      emailBody,
      tenant,
    });
    return {
      handled: true,
      status: "signed_pod_escalated",
      loadNumber,
      escalatedToLisa: true,
    };
  }

  const bridge = require("./primus-ui-bridge");
  if (!bridge.isManagePhpEnabled || !bridge.isManagePhpEnabled()) {
    await writeLog("warn", "mail",
        "POD request — Primus UI bridge disabled", {messageId, loadNumber});
    return {handled: false};
  }

  let booking;
  try {
    booking = await fetchPrimusBooking(loadNumber);
  } catch (bookErr) {
    await writeLog("warn", "mail", "POD request — booking lookup failed", {
      messageId, loadNumber, error: bookErr.message,
    });
    return {handled: false};
  }
  if (!booking || !booking.BOLId) {
    await writeLog("warn", "mail", "POD request — booking not found", {
      messageId, loadNumber,
    });
    return {handled: false};
  }

  if (!requesterEmail) {
    await writeLog("warn", "mail",
        "POD request — no requester email address", {
          messageId, loadNumber, from,
        });
    return {handled: false};
  }

  const recentPodSend = await podSendDedup.findRecentPodSend(
      db, tenant, loadNumber, requesterEmail);
  if (recentPodSend) {
    await writeLog("info", "mail",
        "POD deduplicated — already sent recently", {
          messageId,
          loadNumber,
          requesterEmail,
          priorMessageId: recentPodSend.messageId || null,
          priorSentAt: recentPodSend.sentAt || null,
        });
    return {
      handled: true,
      status: "pod_request_deduplicated",
      loadNumber,
      requesterEmail,
      deduplicated: true,
      priorMessageId: recentPodSend.messageId || null,
    };
  }

  const sendResult = await bridge.emailPodDocs({
    booking,
    loadNumber,
    recipientEmail: requesterEmail,
    subject: `Proof of Delivery - Load #${loadNumber}`,
  });

  if (!sendResult.ok) {
    await writeLog("warn", "mail", "POD request — Primus send failed", {
      messageId,
      loadNumber,
      requesterEmail,
      error: sendResult.error,
      raw: sendResult.raw,
    });
    return {handled: false, loadNumber, error: sendResult.error};
  }

  await podSendDedup.recordPodSend(db, tenant, {
    loadNumber,
    recipientEmail: requesterEmail,
    messageId,
  });

  await writeLog("info", "mail",
      "POD request fulfilled — sent from Primus", {
        messageId,
        loadNumber,
        requesterEmail,
        driveFileIds: sendResult.driveFileIds || [],
      });

  return {
    handled: true,
    status: "pod_request_sent",
    loadNumber,
    requesterEmail,
    driveFileIds: sendResult.driveFileIds || [],
  };
}

/**
 * Handles a POD-only inbound email: never creates an invoice. Looks up the
 * waiting TL invoice (or any recent invoice by BOL), uploads the POD to
 * Primus, and resumes the held customer-email workflow when applicable.
 * @param {object} opts gmail, messageId, subject, from, emailBody, tenant,
 *   pdfAttachments, storedAttachments.
 * @return {Promise<object>} {handled, status, invoiceId, loadNumber}
 */
async function handlePodOnlyDeliveryEmail(opts) {
  const {
    messageId, subject, from, emailBody, tenant,
    pdfAttachments, storedAttachments,
  } = opts;
  const podFollowup = require("./pod-followup");

  let hints = {};
  try {
    const cls = await classifyIncomingEmail(
        subject, from, emailBody,
        [...(pdfAttachments || []), ...(storedAttachments || [])]);
    hints = {
      loadNumberHint: cls.loadNumberHint || null,
      proNumberHint: cls.proNumberHint || null,
      intent: cls.intent,
    };
  } catch (_) {
    hints = {};
  }

  const extracted = extractLoadHintsFromEmail(subject, emailBody, hints);
  let loadNumber = extracted.loadNumber;
  const proNumber = extracted.proNumber;

  if (!loadNumber && proNumber) {
    try {
      const booking = await fetchPrimusBookingByPro(proNumber);
      if (booking) {
        loadNumber = String(
            booking.BOLNumber || booking.bolNumber || "").trim() || null;
      }
    } catch (_) {
      // ignore
    }
  }

  if (!loadNumber) {
    await writeLog("warn", "mail",
        "POD-only email — could not resolve load/BOL", {
          messageId, subject, hints,
        });
    return {handled: false};
  }

  // Prefer invoices waiting on a carrier POD for this load.
  let invoiceDoc = null;
  let invoice = null;
  const waitingSnap = await tcol(tenant, "invoices")
      .where("loadNumber", "==", String(loadNumber))
      .where("podFollowUp.holdCustomerEmail", "==", true)
      .limit(5)
      .get();
  if (!waitingSnap.empty) {
    invoiceDoc = waitingSnap.docs[0];
    invoice = invoiceDoc.data();
  } else {
    const recentSnap = await tcol(tenant, "invoices")
        .where("loadNumber", "==", String(loadNumber))
        .limit(10)
        .get();
    if (!recentSnap.empty) {
      const sorted = recentSnap.docs.slice().sort((a, b) => {
        const ta = a.data().createdAt && a.data().createdAt.toMillis ?
          a.data().createdAt.toMillis() : 0;
        const tb = b.data().createdAt && b.data().createdAt.toMillis ?
          b.data().createdAt.toMillis() : 0;
        return tb - ta;
      });
      invoiceDoc = sorted[0];
      invoice = invoiceDoc.data();
    }
  }

  if (!invoiceDoc) {
    await writeLog("warn", "mail",
        "POD-only email — no matching invoice for load", {
          messageId, loadNumber, proNumber,
        });
    return {handled: false};
  }

  const invoiceId = invoiceDoc.id;

  // Build POD PDF from POD attachments and/or trailer images.
  let podBuffer = null;
  let podFilename = `pod-${loadNumber}.pdf`;
  const podPdfs = (pdfAttachments || []).filter((a) => a.docType === "POD");
  if (podPdfs.length === 1 && podPdfs[0].buffer) {
    podBuffer = podPdfs[0].buffer;
    podFilename = podPdfs[0].filename || podFilename;
  } else if (podPdfs.length > 1) {
    // Merge first pages — use first PDF for simplicity.
    podBuffer = podPdfs[0].buffer;
    podFilename = podPdfs[0].filename || podFilename;
  }

  const imageAtts = (storedAttachments || [])
      .filter((a) => a.docType === "POD_IMAGE" ||
        a.docType === "TRAILER_IMAGE");
  if ((!podBuffer || !podBuffer.length) && imageAtts.length) {
    const images = [];
    for (const att of imageAtts) {
      try {
        let buf = att.buffer;
        if (!buf && att.storagePath) {
          [buf] = await getBucket().file(att.storagePath).download();
        }
        if (buf && buf.length) {
          images.push({
            buffer: buf,
            mimeType: att.mimeType,
            filename: att.filename,
          });
        }
      } catch (_) {
        // skip
      }
    }
    const built = await podFollowup.imagesToPodPdf(images);
    if (built.ok && built.pdfBuffer) {
      podBuffer = built.pdfBuffer;
      podFilename = `trailer-pod-${loadNumber}.pdf`;
    }
  }

  if (!podBuffer || !podBuffer.length) {
    await writeLog("warn", "mail",
        "POD-only email — no usable POD bytes", {messageId, invoiceId});
    return {handled: false};
  }

  const storagePath = await savePodPdfBytes(
      invoiceId, podFilename.replace(/[^a-zA-Z0-9._-]/g, "_"), podBuffer);

  // Upload to Primus when manage.php is enabled.
  let uploaded = false;
  let driveFileId = null;
  try {
    const bridge = require("./primus-ui-bridge");
    if (bridge.isManagePhpEnabled && bridge.isManagePhpEnabled()) {
      const booking = await fetchPrimusBooking(loadNumber);
      if (booking && booking.BOLId) {
        const podTypeId = process.env.PRIMUS_UI_FILETYPE_POD || "0";
        const up = await bridge.uploadDriveFile({
          bookingId: booking.BOLId,
          bookingBOL: loadNumber,
          fileType: podTypeId,
          fileBuffer: podBuffer,
          filename: podFilename,
        });
        uploaded = !!(up && up.ok);
        driveFileId = up && up.fileId || null;
      }
    }
  } catch (upErr) {
    await writeLog("warn", "mail",
        "POD-only upload to Primus failed", {
          messageId, invoiceId, loadNumber, error: upErr.message,
        });
  }

  const steps = Object.assign({}, invoice.primusSteps || {}, {
    podUploaded: uploaded || Boolean(invoice.primusSteps &&
      invoice.primusSteps.podUploaded),
  });
  await invoiceDoc.ref.update({
    "podOnlyFile": {storagePath, source: "pod_delivery_email"},
    "podOnlyFiles": [{storagePath, source: "pod_delivery_email"}],
    "podFollowUp.status": podFollowup.POD_FOLLOW_UP_STATUS.RESOLVED,
    "podFollowUp.holdCustomerEmail": false,
    "podFollowUp.resolvedAt": admin.firestore.FieldValue.serverTimestamp(),
    "podFollowUp.resolvedFromMessageId": messageId,
    "primusSteps": steps,
    "podOnPrimusAlready": uploaded ?
      true : (invoice.podOnPrimusAlready || false),
    "workflowPausedAtStep": null,
    "workflowPausedAt": null,
    "updatedAt": admin.firestore.FieldValue.serverTimestamp(),
  });

  await writeLog("info", "mail",
      "POD-only email applied to invoice — never invoiced as bill", {
        messageId,
        invoiceId,
        loadNumber,
        uploaded,
        driveFileId,
      });

  await maybeNotifyLisaPodDiscrepancy({
    invoiceId,
    invoice: Object.assign({}, invoice, {
      podOnlyFile: {storagePath, source: "pod_delivery_email"},
    }),
    invoiceRef: invoiceDoc.ref,
    podStoragePath: storagePath,
  });

  const workflowUrl = workflowUrlForTenant(tenant);
  if (workflowUrl && invoice.customerEmailApproval !== "rejected") {
    fetch(workflowUrl, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        invoiceId,
        tenantId: tenant.tenantId,
        resumeFrom: "send_customer_email",
      }),
    }).catch((e) =>
      console.error("pod-only resume failed", e.message));
  }

  return {
    handled: true,
    status: "pod_delivery",
    invoiceId,
    loadNumber,
  };
}

/** Queue items stuck in "processing" longer than this are retried. */
const STALE_GMAIL_QUEUE_MS = 31 * 60 * 1000;

/** Min wait before auto-requeue of a failed mail item. */
const FAILED_REQUEUE_MIN_MS = 3 * 60 * 1000;

/** Max auto-requeue attempts per message before staying failed. */
const FAILED_REQUEUE_MAX_ATTEMPTS = 15;

/** Max failed gmailQueue docs scanned per recoverFailedGmailQueueItems pass. */
const FAILED_REQUEUE_BATCH_SIZE = 100;

/** Max queued emails per batch (fits 1800s timeout on heavy invoices). */
const MAIL_QUEUE_PROCESS_BATCH_SIZE = 10;

/** Stop new queue work before the Cloud Function hard timeout (1800s). */
const MAIL_QUEUE_RUN_BUDGET_MS = 28.5 * 60 * 1000;

/** Stale queue-processor lock expires so a crashed run cannot block forever. */
const QUEUE_PROCESS_LOCK_MS = 32 * 60 * 1000;

/**
 * @param {object|null|undefined} queueData gmailQueue document fields.
 * @return {number} Claim timestamp in ms, or 0.
 */
function gmailQueueClaimTimestamp(queueData) {
  const data = queueData || {};
  const field = data.processingClaimedAt || data.updatedAt ||
    data.claimedAt || null;
  return field && field.toDate ? field.toDate().getTime() : 0;
}

/**
 * @param {object|null|undefined} queueData gmailQueue document fields.
 * @return {boolean}
 */
function isStaleGmailQueueProcessing(queueData) {
  if (!queueData || queueData.status !== "processing") return false;
  const claimedMs = gmailQueueClaimTimestamp(queueData);
  return !claimedMs || Date.now() - claimedMs > STALE_GMAIL_QUEUE_MS;
}

/**
 * Resets a queue item left in "processing" after a crash or timeout.
 * @param {string} messageId Gmail message ID.
 * @param {object} tenant Tenant config.
 * @return {Promise<boolean>} True when the item was recovered.
 */
async function recoverStaleGmailQueueItem(messageId, tenant = DEFAULT_TENANT) {
  const queueRef = tcol(tenant, "gmailQueue").doc(messageId);
  const snap = await queueRef.get();
  if (!snap.exists) return false;
  const data = snap.data() || {};
  if (!isStaleGmailQueueProcessing(data)) return false;
  await queueRef.set({
    status: "queued",
    staleRecoveredAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
  await writeLog("warn", "mail",
      "Recovered stale mail queue item — will retry processing", {
        messageId,
        tenantId: tenant.tenantId,
        previousClaimMs: gmailQueueClaimTimestamp(data) || null,
      });
  return true;
}

/**
 * Checks whether a Gmail message has already been ingested.
 * @param {string} messageId - Gmail message ID.
 * @param {object} [tenant] Tenant config (defaults to DEFAULT_TENANT).
 * @return {Promise<boolean>} True if the message was previously processed.
 */
async function hasEmailBeenProcessed(messageId, tenant = DEFAULT_TENANT) {
  const intakeSnap = await tcol(tenant, "emailIntake")
      .where("gmailMessageId", "==", messageId)
      .limit(1)
      .get();
  if (intakeSnap.size > 0) return true;

  const invoiceSnap = await tcol(tenant, "invoices")
      .where("gmailMessageId", "==", messageId)
      .limit(1)
      .get();
  if (invoiceSnap.size > 0) return true;

  // Also check the queue — covers NO_INVOICE_PDF and other early-exit paths
  // that never create an emailIntake record but did reserve a queue slot.
  const queueSnap = await tcol(tenant, "gmailQueue").doc(messageId).get();
  if (queueSnap.exists) {
    const queueData = queueSnap.data() || {};
    const queueStatus = queueData.status;
    if (queueStatus === "processing") {
      if (isStaleGmailQueueProcessing(queueData)) {
        await recoverStaleGmailQueueItem(messageId, tenant);
        return false;
      }
      return true;
    }
    if (queueStatus && queueStatus !== "queued" && queueStatus !== "failed") {
      return true;
    }
  }

  return false;
}

/**
 * Reloads parent split context for a per-invoice child queue job.
 * @param {object} tenant Tenant config.
 * @param {string} parentMessageId Parent Gmail message id.
 * @param {number} itemIndex Invoice item index.
 * @return {Promise<object|null>}
 */
async function loadSplitChildContext(tenant, parentMessageId, itemIndex) {
  const parentSnap = await tcol(tenant, "emailIntake")
      .doc(String(parentMessageId)).get();
  const parentData = parentSnap.data() || {};
  const items = parentData.invoiceItemsPending;
  if (!Array.isArray(items) || !items[itemIndex]) return null;

  const parsed = parentData.parsedAttachments || [];
  const pdfAttachments = [];
  for (const att of parsed) {
    if (!att || !att.storagePath) continue;
    try {
      const [buf] = await getBucket().file(att.storagePath).download();
      pdfAttachments.push(Object.assign({}, att, {buffer: buf}));
    } catch (dlErr) {
      await writeLog("warn", "mail",
          "Failed to reload attachment for split child job", {
            parentMessageId,
            itemIndex,
            storagePath: att.storagePath,
            error: dlErr.message,
          });
    }
  }

  return {
    invoiceItems: [items[itemIndex]],
    rawClassification: parentData.rawClassification || items[itemIndex],
    pdfAttachments,
    storedAttachments: parsed,
  };
}

/**
 * Fetches Subject/From for inbox discovery without downloading bodies.
 * @param {object} gmail Mail client.
 * @param {string} messageId Gmail message id.
 * @return {Promise<{subject: string, from: string}>}
 */
async function fetchGmailMessageHeaders(gmail, messageId) {
  const full = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "metadata",
    metadataHeaders: ["Subject", "From"],
  });
  const headers = (full.data.payload && full.data.payload.headers) || [];
  const subject = (headers.find((h) => h.name === "Subject") || {}).value || "";
  const from = (headers.find((h) => h.name === "From") || {}).value || "";
  return {subject, from};
}

/**
 * Atomically claims an insurance intake so the same Gmail message is not
 * posted or emailed twice when inbox polling overlaps.
 * @param {string} messageId Gmail message ID.
 * @param {object} tenant Tenant config.
 * @param {object} meta Optional subject/from metadata.
 * @return {Promise<object>} {ok, reason?, status?}
 */
async function claimInsuranceIntake(messageId, tenant, meta = {}) {
  const ref = tcol(tenant, "emailIntake").doc(String(messageId));
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const status = (snap.data() || {}).finalStatus;
        if (status === "insurance_processed" ||
            status === "insurance_processing") {
          return {ok: false, reason: "already", status};
        }
      }
      tx.set(ref, {
        gmailMessageId: String(messageId),
        tenantId: tenant.tenantId,
        subject: String(meta.subject || "").slice(0, 500),
        from: String(meta.from || "").slice(0, 500),
        finalStatus: "insurance_processing",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
      return {ok: true};
    });
  } catch (err) {
    await writeLog("warn", "insurance", "Insurance intake claim failed", {
      messageId,
      error: err.message,
    });
    return {ok: false, reason: "claim_error", error: err.message};
  }
}

/**
 * Removes UNREAD so overlapping inbox polls cannot pick up the same message.
 * @param {object} gmail Gmail client.
 * @param {string} messageId Gmail message ID.
 * @return {Promise<void>}
 */
async function markGmailMessageRead(gmail, messageId) {
  if (!gmail || !messageId) return;
  try {
    await gmail.users.messages.modify({
      userId: "me",
      id: String(messageId),
      requestBody: {removeLabelIds: ["UNREAD"]},
    });
  } catch (err) {
    await writeLog("warn", "mail", "Failed to mark message read", {
      messageId,
      error: err.message,
    });
  }
}

/**
 * Updates the status of a Gmail queue item.
 * @param {string} messageId - Gmail message ID.
 * @param {string} status - Queue item status.
 * @param {string} [errorMessage] - Optional error message.
 * @param {object} [options] - Additional options.
 * @return {Promise<void>}
 */
async function updateGmailQueueStatus(
    messageId,
    status,
    errorMessage,
    options = {},
) {
  try {
    const tenant = options.tenant || DEFAULT_TENANT;
    const queueRef = tcol(tenant, "gmailQueue").doc(messageId);
    const updateData = {
      status: status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (status === "processing" && !options.skipAttemptIncrement) {
      updateData.attemptCount = admin.firestore.FieldValue.increment(1);
    }
    if (status === "completed") {
      updateData.completedAt = admin.firestore.FieldValue.serverTimestamp();
    }
    if (status === "failed") {
      updateData.failedAt = admin.firestore.FieldValue.serverTimestamp();
    }
    if (errorMessage) {
      updateData.error = String(errorMessage).slice(0, 1000);
    }

    await queueRef.set(updateData, {merge: true});
  } catch (error) {
    await writeLog("warn", "mail", "Failed to update mail queue status", {
      messageId,
      status,
      error: error.message,
    });
  }
}

/**
 * Claims a Gmail queue item using a Firestore transaction.
 * @param {string} messageId - Gmail message ID.
 * @param {object} [tenant] Tenant config (defaults to DEFAULT_TENANT).
 * @return {Promise<boolean>} True when the queue item was claimed.
 */
async function claimGmailQueueItem(messageId, tenant = DEFAULT_TENANT) {
  const queueRef = tcol(tenant, "gmailQueue").doc(messageId);

  try {
    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(queueRef);
      if (!snap.exists) {
        return false;
      }

      const data = snap.data() || {};
      if (data.status !== "queued") {
        return false;
      }

      tx.update(queueRef, {
        status: "processing",
        attemptCount: admin.firestore.FieldValue.increment(1),
        processingClaimedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return true;
    });

    return claimed;
  } catch (error) {
    await writeLog("warn", "mail", "Failed to claim mail queue item", {
      messageId,
      error: error.message,
    });
    return false;
  }
}

/**
 * Reserves or updates a Gmail queue item before processing begins.
 * @param {string} messageId - Gmail message ID.
 * @param {string} subject - Email subject.
 * @param {string} from - Email sender.
 * @param {string} inboxFlowId - Inbox flow identifier.
 * @param {object} [tenant] Tenant config (defaults to DEFAULT_TENANT).
 * @return {Promise<boolean>} True when the queue item was reserved.
 */
async function reserveGmailQueueItemForProcessing(
    messageId,
    subject,
    from,
    inboxFlowId,
    tenant = DEFAULT_TENANT,
) {
  const queueRef = tcol(tenant, "gmailQueue").doc(messageId);
  const now = admin.firestore.FieldValue.serverTimestamp();

  try {
    const reserved = await db.runTransaction(async (tx) => {
      const snap = await tx.get(queueRef);
      const existing = snap.exists ? snap.data() || {} : null;
      if (existing && existing.status && existing.status !== "queued" &&
          existing.status !== "failed") {
        return false;
      }

      tx.set(queueRef, {
        gmailMessageId: messageId,
        tenantId: tenant.tenantId,
        subject: String(subject || "").slice(0, 500),
        from: String(from || "").slice(0, 500),
        status: "processing",
        attemptCount: existing ?
          admin.firestore.FieldValue.increment(1) : 1,
        queueFlowId: inboxFlowId || null,
        claimedAt: existing ? existing.claimedAt || now : now,
        processingClaimedAt: now,
        createdAt: existing ? existing.createdAt || now : now,
        updatedAt: now,
      }, {merge: true});
      return true;
    });

    return reserved;
  } catch (error) {
    await writeLog("warn", "mail", "Failed to reserve mail queue item", {
      messageId,
      error: error.message,
    });
    return false;
  }
}

/**
 * Extracts plain-text body from a Gmail message payload.
 * @param {object} payload Gmail message payload.
 * @return {string} Plain text body.
 */
function extractEmailBody(payload) {
  if (!payload) return "";

  if (payload.body && payload.body.data) {
    const mimeType = payload.mimeType || "";
    if (mimeType === "text/plain") {
      return Buffer.from(
          payload.body.data.replace(/-/g, "+").replace(/_/g, "/"),
          "base64",
      ).toString("utf-8");
    }
    if (mimeType === "text/html") {
      const html = Buffer.from(
          payload.body.data.replace(/-/g, "+").replace(/_/g, "/"),
          "base64",
      ).toString("utf-8");
      return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
    // multipart/* and unknown types: body.data is typically empty, fall through
  }

  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body && part.body.data) {
        return Buffer.from(
            part.body.data.replace(/-/g, "+").replace(/_/g, "/"),
            "base64",
        ).toString("utf-8");
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body && part.body.data) {
        const html = Buffer.from(
            part.body.data.replace(/-/g, "+").replace(/_/g, "/"),
            "base64",
        ).toString("utf-8");
        return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
    }
    for (const part of payload.parts) {
      const nested = extractEmailBody(part);
      if (nested) return nested;
    }
  }

  return "";
}

/**
 * Parses model JSON for forward-analysis summaries.
 * @param {string} rawText Raw model response.
 * @return {{summary: string}}
 */
function parseForwardAnalysisJson(rawText) {
  const jsonText = String(rawText || "")
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  try {
    const parsed = JSON.parse(jsonText);
    if (parsed && parsed.summary) {
      return {summary: String(parsed.summary).trim()};
    }
  } catch (_) {
    // fall through
  }
  return {summary: jsonText || "Could not analyze email."};
}

/**
 * Uses OpenAI Luna (text-only) for plain-email forward summaries; falls back
 * to Haiku when no OpenAI key is configured.
 * @param {string} subject Email subject.
 * @param {string} from Email sender.
 * @param {string} body Email plain-text body.
 * @return {Promise<{summary: string}>}
 */
async function analyzeEmailForForwarding(subject, from, body) {
  const systemPrompt =
      "You are an assistant for a freight brokerage handling incoming " +
      "emails. " +
      "Analyze the email and return ONLY valid JSON with one key: " +
      "\"summary\" (one or two sentences describing what the sender wants or " +
      "what this email appears to be about).";
  const userPayload = JSON.stringify({
    subject,
    from,
    body: String(body || "").slice(0, 3000),
  });

  const openaiKey = getFlowSummaryOpenAiKey();
  if (openaiKey) {
    try {
      const client = new OpenAI({apiKey: openaiKey});
      const model = process.env.FORWARD_ANALYSIS_MODEL ||
        process.env.SUPPORT_CHAT_MODEL || DEFAULT_OPENAI_MODEL;
      const completion = await client.chat.completions.create({
        model,
        max_completion_tokens: 200,
        response_format: {type: "json_object"},
        messages: [
          {role: "system", content: systemPrompt},
          {role: "user", content: userPayload},
        ],
      });
      const rawText = String(
          completion.choices &&
          completion.choices[0] &&
          completion.choices[0].message &&
          completion.choices[0].message.content || "",
      ).trim();
      if (rawText) {
        return parseForwardAnalysisJson(rawText);
      }
    } catch (openaiErr) {
      await writeLog("warn", "ai",
          "OpenAI forward analysis failed — trying Haiku", {
            error: openaiErr.message,
          });
    }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return {summary: "Could not analyze email."};
  }

  const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
  const res = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 200,
    system: systemPrompt,
    messages: [{role: "user", content: userPayload}],
  });

  if (!res.content || res.content.length === 0) {
    return {summary: "Could not analyze email."};
  }
  const rawText = res.content[0].text || "";
  return parseForwardAnalysisJson(rawText);
}

const INCOMING_EMAIL_INTENTS = new Set([
  "carrier_invoice",
  "insurance_premium",
  "statement",
  "pod_delivery",
  "pod_request",
  "quote_request",
  "unknown",
]);

/**
 * Classifies an inbound email before routing to carrier, insurance, or review.
 * Uses subject, sender, body, and attachment filenames only (no attachment
 * bytes) so it is cheap to run on every message.
 * @param {string} subject Email subject.
 * @param {string} from Email sender.
 * @param {string} body Email plain-text body.
 * @param {Array<object>} attachments Attachment metadata from Gmail.
 * @return {Promise<object>} Classification with intent, confidence, and hints.
 */
async function classifyIncomingEmail(subject, from, body, attachments) {
  const fallback = {
    intent: "unknown",
    confidence: "low",
    reasoning: "Classifier unavailable.",
    spreadsheetFilename: null,
    invoicePdfFilename: null,
  };
  const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
  const attachmentMeta = (Array.isArray(attachments) ? attachments : [])
      .map((a) => ({
        filename: String(a && a.filename || ""),
        mimeType: String(a && a.mimeType || ""),
      }));

  const res = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 300,
    system: [
      "You classify inbound emails for a freight brokerage automation system.",
      "Return ONLY valid JSON with these keys:",
      "- intent: exactly one of carrier_invoice, insurance_premium,",
      "  statement, pod_delivery, pod_request, quote_request, unknown",
      "- confidence: high, medium, or low",
      "- reasoning: one short sentence",
      "- spreadsheetFilename: if insurance_premium, the filename of the",
      "  per-shipment premium breakdown spreadsheet when identifiable,",
      "  else null",
      "- invoicePdfFilename: if insurance_premium, the filename of the vendor",
      "  insurance invoice PDF when identifiable, else null",
      "- loadNumberHint: if pod_delivery or pod_request, any load/BOL number",
      "  visible in the subject or body, else null",
      "- proNumberHint: if pod_delivery or pod_request, any PRO number",
      "  visible, else null",
      "",
      "Rules:",
      "- insurance_premium: cargo insurance vendor billing (e.g. Redkik) that",
      "  includes a per-shipment premium spreadsheet (Excel/CSV) — often with",
      "  an invoice PDF. MUST have a .xlsx/.xlsm/.xls/.csv attachment to",
      "  choose this intent. A QuickBooks \"Pay invoice\" / payment-link",
      "  email from Redkik with only a PDF (no spreadsheet) is NOT",
      "  insurance_premium; classify that as statement or unknown instead.",
      "- carrier_invoice: trucking company freight invoice, usually PDF.",
      "  Also use when an LTL carrier sends a Stmt/statement PDF that",
      "  includes freight bills to pay (may contain multiple invoices).",
      "  Saia and similar carriers often email 'Your Invoice From …' with",
      "  a PDF whose first page is a statement summary and later pages are",
      "  the freight bills — that is carrier_invoice, not statement.",
      "  JTS Express and similar carriers email 'Statement 12345' (any",
      "  statement number) from invoice@ with a PDF: page 1 is a statement",
      "  of all invoices, later pages are the freight bills to pay. Body",
      "  text like 'Attached is your invoices for statement#' is",
      "  carrier_invoice, not statement.",
      "- Compass FS (compassfs.net / notify@mg.compassfs.net): subject",
      "  'Purchase order number; Purchase Order #12345' with a PDF is a",
      "  factored carrier freight invoice — PO # is the broker load number.",
      "  Classify as carrier_invoice, not statement or unknown.",
      "- FactorView (notification@factorview.com / BP Financing and similar",
      "  factoring companies): subject 'Invoice # 981 Your PO # 265543'",
      "  (space after # is common) with a PDF is a factored carrier freight",
      "  invoice — Your PO # is the broker load. Classify as",
      "  carrier_invoice, not statement or unknown. Do not confuse with",
      "  FactorView Notice of Assignment / Remit notices.",
      "- Thunder Funding (billing@thunderfunding.com): subject",
      "  'Invoice for processing; Invoice #299 - Purchase Order #266504'",
      "  with a PDF is a factored carrier freight invoice — Purchase Order",
      "  # is the broker load. Classify as carrier_invoice, not statement",
      "  or unknown. Do not classify as unknown just because Thunder",
      "  Funding is a factoring company rather than the trucking carrier.",
      "  First page is often a Notice of Assignment; later pages are the",
      "  bill. ACH/banking updates attached with the invoice are still",
      "  carrier_invoice.",
      "- Factoring companies (Thunder Funding, REV Capital, RM Capital,",
      "  Single Point, FactorView, Compass FS, Apex, and similar) that",
      "  email Invoice # / PO # / REF # with a PDF are carrier_invoice,",
      "  even when page 1 is a Notice of Assignment or banking letter.",
      "- Single Point Capital (reports@singlepointgroup.com): subject",
      "  'Single Point Capital; Invoice #265914' with a PDF is a factored",
      "  carrier freight invoice. Classify as carrier_invoice, not statement",
      "  or unknown.",
      "- RM Capital (invoice@rmcapitalinc.com): subject 'REF# 266111'",
      "  with a PDF is a factored carrier freight invoice — REF # is the",
      "  broker load. Classify as carrier_invoice, not statement or unknown.",
      "- Factoring companies that email 'REF# 26xxxx' (broker load in",
      "  subject) with a PDF freight bill are carrier_invoice, not unknown.",
      "- REV Capital (invoices@revinc.com): subject",
      "  'REV CAPITAL/CARRIER NAME, Invoice # 6672 Part 1 of 1' with a",
      "  PDF is a factored carrier freight invoice. ACH/wire/banking",
      "  remittance instructions attached with the bill are still",
      "  carrier_invoice, not a bank payment alert or unknown.",
      "- Daylight Transport and similar LTL carriers: subject",
      "  'WNI Class Correction on Pro …' with a WI_Certificate / Weight",
      "  & Inspection PDF is a revised-rate freight bill (class/reweigh",
      "  additional charge). Classify as carrier_invoice, not unknown.",
      "- Factor invoices that include ACH/wire/banking remittance",
      "  instructions (how to pay the factor) are still carrier_invoice.",
      "- pod_delivery: reply attaching Proof of Delivery / signed BOL /",
      "  delivery photos — not asking us to send one.",
      "- pod_request: sender asks Innovative to SEND or provide a POD /",
      "  proof of delivery for a load (usually no invoice PDF attached).",
      "  Examples: \"please send POD for load 264091\", \"need proof of",
      "  delivery for BOL 12345\".",
      "- quote_request: customer or vendor asks for an LTL freight QUOTE /",
      "  rate — usually NO carrier invoice PDF. Includes \"please quote\",",
      "  \"provide quotation\", shipping from/to with weight/class/pallets,",
      "  Menards PO tables, sales order shipment details, ready date.",
      "  NOT carrier_invoice even if PDF attached unless it is clearly a",
      "  freight bill to pay.",
      "- statement: account summary or pay-online notice only — no freight",
      "  invoice PDF to extract (not a carrier Stmt packet of bills)",
      "- unknown: marketing, unrelated, or unclear",
      "",
      "NOT carrier_invoice (treat as unknown; inbox rules may ignore):",
      "bank/Zelle/Venmo/PayPal payment alerts, wire/ACH deposit notices,",
      "\"X sent you $Y\" / payment-received emails with no freight bill PDF.",
      "Carrier Quick Pay / payment-status follow-ups with no invoice PDF",
      "(handled separately — classify as unknown, not carrier_invoice).",
    ].join("\n"),
    messages: [{
      role: "user",
      content: JSON.stringify({
        subject,
        from,
        body: String(body || "").slice(0, 3000),
        attachments: attachmentMeta,
      }),
    }],
  });

  if (!res.content || res.content.length === 0) {
    return fallback;
  }
  const rawText = res.content[0].text || "";
  const jsonText = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  try {
    const parsed = JSON.parse(jsonText);
    const intent = INCOMING_EMAIL_INTENTS.has(parsed.intent) ?
      parsed.intent : "unknown";
    const confidence = ["high", "medium", "low"].includes(parsed.confidence) ?
      parsed.confidence : "low";
    return {
      intent,
      confidence,
      reasoning: String(parsed.reasoning || "").trim() ||
        "No reasoning provided.",
      spreadsheetFilename: parsed.spreadsheetFilename ?
        String(parsed.spreadsheetFilename) : null,
      invoicePdfFilename: parsed.invoicePdfFilename ?
        String(parsed.invoicePdfFilename) : null,
      loadNumberHint: parsed.loadNumberHint ?
        String(parsed.loadNumberHint) : null,
      proNumberHint: parsed.proNumberHint ?
        String(parsed.proNumberHint) : null,
    };
  } catch (e) {
    return {
      ...fallback,
      reasoning: rawText.slice(0, 200) || fallback.reasoning,
    };
  }
}

/**
 * Jerry (accounting) inbox never processes quotes — dispatcher Outlook only.
 * Kept as a hard off-switch so processGmailMessage cannot route quote_request.
 * @return {boolean}
 */
function isQuoteInboxProcessingEnabled() {
  return false;
}

/**
 * Quiet-ignore payment alerts: clear bank-sender regex stays cheap; ambiguous
 * Zelle/QuickPay language uses AI (never silent-drop without classifier).
 * @param {object} opts Inputs gathered at the call site.
 * @return {Promise<object>} {ignore, source, ai, reason}
 */
async function resolveQuietPaymentIgnore(opts = {}) {
  const subject = opts.subject || "";
  const from = opts.from || "";
  const body = opts.body || "";
  const attachments = Array.isArray(opts.attachments) ? opts.attachments : [];
  const emailClassification = opts.emailClassification || null;
  const invoicePdfCount = opts.invoicePdfCount;

  if (administrativeEmailIntake.hasInvoiceVeto({
    subject,
    body,
    from,
    attachments,
    emailClassification,
    invoicePdfCount,
  })) {
    return {
      ignore: false,
      source: "invoice_veto",
      ai: null,
      reason: "invoice_veto",
    };
  }

  if (administrativeEmailIntake.shouldIgnoreAsPaymentNotification(
      subject, from, body, attachments)) {
    return {
      ignore: true,
      source: "regex_bank",
      ai: null,
      reason: "Known bank payment alert sender",
    };
  }

  if (!administrativeEmailIntake.isAmbiguousPaymentNotificationCandidate(
      subject, from, body, attachments)) {
    return {
      ignore: false,
      source: "none",
      ai: null,
      reason: null,
    };
  }

  const ai = await paymentNotificationClassify
      .classifyPaymentNotificationIntent({
        subject,
        from,
        body,
        attachments,
      });
  if (paymentNotificationClassify.aiSaysQuietIgnoreBankAlert(ai)) {
    return {
      ignore: true,
      source: "ai",
      ai,
      reason: ai.reasoning || "AI classified as bank payment alert",
    };
  }
  return {
    ignore: false,
    source: "ai",
    ai,
    reason: ai.intent || null,
  };
}

/**
 * Processes a Gmail message and ingests it into the invoice workflow.
 * @param {object} gmail - Gmail client instance.
 * @param {object} message - Message metadata.
 * @param {string} inboxFlowId - Inbox workflow identifier.
 * @param {number} lastKnownLoadNumber - Last known load number.
 * @param {object} [options] - Processing options.
 * @return {Promise<void>}
 */
async function processGmailMessage(
    gmail,
    message,
    inboxFlowId,
    lastKnownLoadNumber,
    options = {},
) {
  const messageId = String(message.id || message.gmailMessageId || "");
  const queueDocId = options.queueDocId || messageId;
  const parentMessageId = options.parentMessageId || messageId;
  const childItemIndex = options.processSingleItemIndex != null ?
    Number(options.processSingleItemIndex) : null;
  const isChildSplitJob = childItemIndex != null;

  let subject = String(options.subject || "");
  let from = String(options.from || "");
  let to = String(options.to || "");
  let cc = String(options.cc || "");
  const tenant = options.tenant || currentTenant() || DEFAULT_TENANT;
  const isTai = tenant.tms === "tai";

  let pdfAttachments = [];
  let storedAttachments = [];
  let rawClassification = null;
  let invoiceItems = [];
  let preSkippedItemSummaries = [];
  let statementExtractionGap = null;
  let aiResult = null;

  try {
    const fullMessage = await withTimeout(
        gmail.users.messages.get({
          userId: "me",
          id: messageId,
        }),
        120000,
        "Outlook message fetch",
    );

    const payload = fullMessage.data.payload || {};
    const headers = payload.headers || [];
    const subjectHeader = headers.find((h) => h.name === "Subject");
    const fromHeader = headers.find((h) => h.name === "From");
    const toHeader = headers.find((h) => h.name === "To");
    const ccHeader = headers.find((h) => h.name === "Cc");

    if (!subject) {
      subject = subjectHeader ? subjectHeader.value : "";
    }
    if (!from) {
      from = fromHeader ? fromHeader.value : "";
    }
    if (!to) {
      to = toHeader ? toHeader.value : "";
    }
    if (!cc) {
      cc = ccHeader ? ccHeader.value : "";
    }

    const emailBody = extractEmailBody(payload);

    // Used when the system doesn't know how to handle an email.
    // Asks Claude what the email is about, then forwards it to the reviewer
    // written as a first-person note from the AI — no suggested reply.
    const forwardWithAnalysis = async (reason, fwdOpts = {}) => {
      let summary = "";
      try {
        const analysis =
            await analyzeEmailForForwarding(subject, from, emailBody);
        summary = analysis.summary || "";
      } catch (e) {
        await writeLog("warn", "mail",
            "Email analysis failed before forward", {
              messageId, error: e.message,
            });
      }

      const aiNote =
        `Hi, I'm ${AI_AGENT_NAME}, your AI assistant.\n\n` +
        `I just received the following email and I am ` +
        `not sure how to handle it.\n\n` +
        (summary ?
          `Here is what I think this email is about: ${summary}\n\n` : "") +
        `I do not have a rule for this type of email yet. ` +
        `Please take care of it.\n\nThank you,\n${AI_AGENT_NAME}`;

      return forwardToHumanReview(
          gmail, messageId, subject, from, reason, aiNote,
          {...fwdOpts, emailBody},
      );
    };

    await writeLog("info", "mail", `Message details retrieved`, {
      messageId: messageId,
      subject: subject,
      from: from,
      to: to,
    });

    const alreadyProcessed = options.fromQueue ?
      false :
      await hasEmailBeenProcessed(messageId, tenant);
    if (options.fromQueue) {
      const queueSnap = await tcol(tenant, "gmailQueue").doc(queueDocId).get();
      const queueData = queueSnap.data() || {};
      if (queueData.status === mailIntakeQueue.QUEUE_STATUS.COMPLETED) {
        return;
      }
      if (queueData.status === mailIntakeQueue.QUEUE_STATUS.WAITING_CHILDREN &&
          !isChildSplitJob) {
        return;
      }
    } else if (alreadyProcessed) {
      await writeLog("warn", "mail", "Message already processed, skipping", {
        messageId: messageId,
        subject: subject,
        from: from,
      });
      await mailIntakeQueue.completeIntakeRecord({
        tenant,
        docId: queueDocId,
        parentMessageId: messageId,
        outcome: mailIntakeQueue.OUTCOME.IGNORED,
        finalStatus: "already_processed",
        ignoreReason: "Message already processed, skipping",
        extra: {
          gmailMessageId: messageId,
          subject,
          from,
        },
      });
      return;
    }

    if (isChildSplitJob) {
      const splitCtx = await loadSplitChildContext(
          tenant, parentMessageId, childItemIndex);
      if (!splitCtx) {
        await mailIntakeQueue.failIntakeRecord(
            tenant, queueDocId, "split_context_missing");
        return;
      }
      pdfAttachments = splitCtx.pdfAttachments;
      storedAttachments = splitCtx.storedAttachments;
      rawClassification = splitCtx.rawClassification;
      invoiceItems = splitCtx.invoiceItems;
    }

    if (!isChildSplitJob) {
      let attachments = collectMessageAttachments(payload);
      try {
        attachments = await expandNestedEmailAttachments(
            gmail, messageId, attachments);
      } catch (expandErr) {
        await writeLog("warn", "mail",
            "Nested attachment expand failed; continuing", {
              messageId,
              error: expandErr.message,
            });
      }
      try {
        const beforeZipCount = attachments.length;
        attachments = await invoiceZipAttachments.expandZipAttachments(
            gmail, messageId, attachments, resolveAttachmentBuffer);
        const fromZip = attachments.filter((a) => a && a.fromZip);
        if (fromZip.length > 0) {
          await writeLog("info", "mail",
              "Extracted invoice file(s) from ZIP attachment(s)", {
                messageId,
                beforeCount: beforeZipCount,
                afterCount: attachments.length,
                extracted: fromZip.map((a) => ({
                  filename: a.filename,
                  mimeType: a.mimeType,
                  zipFilename: a.zipFilename || null,
                  bytes: a.buffer && a.buffer.length || 0,
                })),
              });
        }
      } catch (zipErr) {
        await writeLog("warn", "mail",
            "ZIP attachment expand failed; continuing", {
              messageId,
              error: zipErr.message,
            });
      }

      if (attachments.length === 0) {
        try {
          const rawPdfs = await extractPdfsFromRawMessage(gmail, messageId);
          if (rawPdfs.length > 0) {
            await writeLog("info", "mail",
                "No MIME parts listed; recovered PDF(s) from raw MIME", {
                  messageId,
                  count: rawPdfs.length,
                  filenames: rawPdfs.map((a) => a.filename),
                });
            attachments = rawPdfs;
          }
        } catch (rawErr) {
          await writeLog("warn", "mail",
              "Raw MIME recovery failed while looking for attachments", {
                messageId,
                error: rawErr.message,
              });
        }
      }

      if (!options.fromQueue) {
        const reserved = await reserveGmailQueueItemForProcessing(
            messageId,
            subject,
            from,
            inboxFlowId,
            tenant,
        );
        if (!reserved) {
          await writeLog("warn", "mail", "Skipped duplicate inbox processing", {
            messageId: messageId,
            subject: subject,
            from: from,
          });
          return;
        }
      }

      if (!isTai && administrativeEmailIntake.isEmodalBroadcast(
          subject, from, emailBody)) {
        await completeAdministrativeIgnore({
          messageId,
          subject,
          from,
          tenant,
          queueDocId,
          finalStatus: "emodal_broadcast_ignored",
          reason: "eModal / terminal broadcast — ignored",
        });
        return;
      }

      let emailClassification = {
        intent: "unknown",
        confidence: "low",
        reasoning: "not classified",
        spreadsheetFilename: null,
        invoicePdfFilename: null,
      };

      // Insurance intake: AI classifies the whole email, then a valid premium
      // spreadsheet must parse before anything is posted to Primus.
      if (!isTai && attachments.length > 0) {
        try {
          emailClassification = await classifyIncomingEmail(
              subject, from, emailBody, attachments,
          );
          emailClassification = statementInvoiceBundle
              .overrideStatementClassificationIfInvoicePacket(
                  emailClassification, subject, from, emailBody,
                  attachments);
          await writeLog("info", "ai", "Incoming email classified", {
            messageId,
            subject,
            from,
            ...emailClassification,
          });
        } catch (classifyErr) {
          await writeLog("warn", "ai", "Email classification failed", {
            messageId, subject, error: classifyErr.message,
          });
        }

        if (statementInvoiceBundle.shouldShortCircuitAsStatementOnly(
            emailClassification, subject, from, emailBody, attachments)) {
          await handleStatementOnlyEmail({
            gmail, messageId, subject, from, emailBody, tenant, headers,
            emailClassification,
            queueDocId,
          });
          return;
        }

        if (administrativeEmailIntake.shouldHandleCustomerPaymentRemittance(
            subject, from, emailBody)) {
          await handleCustomerPaymentRemittanceEmail({
            gmail, messageId, subject, from, emailBody, tenant, headers,
            emailClassification,
            queueDocId,
            reason: "Customer payment remittance — not a carrier invoice",
          });
          return;
        }

        if (emailClassification.intent === "insurance_premium") {
          try {
            const resolved =
              await innovativeInsurance.resolveInsuranceAttachments({
                attachments,
                spreadsheetFilename:
                    emailClassification.spreadsheetFilename,
                invoicePdfFilename:
                    emailClassification.invoicePdfFilename,
                downloadAttachment: (att) => downloadGmailAttachmentBuffer(
                    gmail, messageId, att.attachmentId,
                ),
              });

            if (!resolved.excelBuffer) {
              const sheetCount = innovativeInsurance
                  .listSpreadsheetAttachments(attachments).length;
              const validation = resolved.validation || {};
              const missingSheet = sheetCount === 0;
              await writeLog("warn", "insurance",
                  "Insurance classified but workbook invalid — forwarding", {
                    messageId,
                    subject,
                    classification: emailClassification,
                    spreadsheetAttachmentCount: sheetCount,
                    validation,
                  });
              const why = missingSheet ?
              "This looks like Redkik / insurance billing, but there is " +
              "no Excel/CSV premium breakdown attached — only what " +
              "appears to be a pay-invoice notice or PDF. I need the " +
              "per-shipment premium spreadsheet (with BOL + amounts) " +
              "before I can post premiums to Primus." :
              ("I found a spreadsheet but could not parse postable " +
                "premium rows for Primus" +
                (validation.reason ? ` (${validation.reason})` : "") +
                ". Please check the workbook or post manually.");
              await forwardToHumanReview(
                  gmail, messageId, subject, from,
                missingSheet ?
                  "Insurance email is missing the premium spreadsheet" :
                  "Insurance premium spreadsheet could not be parsed",
                `Hi, I'm ${AI_AGENT_NAME}, your AI assistant.\n\n` +
                `${why}\n\n` +
                `Classifier note: ${
                  emailClassification.reasoning || "n/a"}.\n\n` +
                `Please attach the Redkik allocation Excel (or handle ` +
                `payment/posting manually) and re-send if needed.\n\n` +
                `Thank you,\n${AI_AGENT_NAME}`,
                {department: "billing", emailBody},
              );
              await mailIntakeQueue.completeIntakeRecord({
                tenant,
                docId: queueDocId,
                parentMessageId: messageId,
                outcome: mailIntakeQueue.OUTCOME.FORWARDED,
                finalStatus: "insurance_spreadsheet_invalid",
                forwardReason: missingSheet ?
                  "Insurance email missing premium spreadsheet" :
                  "Insurance premium spreadsheet could not be parsed",
                extra: {
                  gmailMessageId: messageId,
                  subject,
                  from,
                  emailClassification,
                  deleteAt: getDeleteAt(mailIntakeQueue.INTAKE_TTL_DAYS),
                },
              });
              return;
            }

            const insClaim = await claimInsuranceIntake(messageId, tenant, {
              subject, from,
            });
            if (!insClaim.ok) {
              await writeLog("warn", "insurance",
                  "Skipped duplicate insurance intake", {
                    messageId,
                    subject,
                    reason: insClaim.reason,
                    priorStatus: insClaim.status || null,
                  });
              await mailIntakeQueue.completeIntakeRecord({
                tenant,
                docId: queueDocId,
                parentMessageId: messageId,
                outcome: mailIntakeQueue.OUTCOME.IGNORED,
                finalStatus: "insurance_duplicate",
                ignoreReason: insClaim.reason || "Duplicate insurance intake",
                extra: {
                  gmailMessageId: messageId,
                  subject,
                  from,
                  priorStatus: insClaim.status || null,
                },
              });
              return;
            }

            const insResult = await innovativeInsurance.processInsuranceEmail({
              excelBuffer: resolved.excelBuffer,
              pdfBuffer: resolved.pdfBuffer,
              from,
              subject,
              emailBody,
              gmailMessageId: messageId,
            });

            if (insResult.handled) {
              await mailIntakeQueue.completeIntakeRecord({
                tenant,
                docId: queueDocId,
                parentMessageId: messageId,
                outcome: mailIntakeQueue.OUTCOME.PROCESSED,
                finalStatus: "insurance_processed",
                extra: {
                  gmailMessageId: messageId,
                  subject,
                  from,
                  emailClassification,
                  insuranceAttachments: {
                    excelFilename: resolved.excelFilename,
                    pdfFilename: resolved.pdfFilename,
                  },
                  insuranceReconciliation: insResult.reconciliation || null,
                  insuranceVendorInvoiceNumber:
                  (insResult.invoice && insResult.invoice.invoiceNumber) ||
                  null,
                  deleteAt: getDeleteAt(mailIntakeQueue.INTAKE_TTL_DAYS),
                },
              });
              return;
            }

            await writeLog("warn", "insurance",
                "Insurance email not handled — forwarding", {
                  messageId,
                  subject,
                  reason: insResult.reason,
                  classification: emailClassification,
                });
            await forwardWithAnalysis(
                `Insurance email could not be processed automatically ` +
              `(${insResult.reason || "unknown"})`,
                {department: "billing"},
            );
            await mailIntakeQueue.completeIntakeRecord({
              tenant,
              docId: queueDocId,
              parentMessageId: messageId,
              outcome: mailIntakeQueue.OUTCOME.FORWARDED,
              finalStatus: "insurance_failed",
              forwardReason: insResult.reason || "Insurance processing failed",
              extra: {
                gmailMessageId: messageId,
                subject,
                from,
                insuranceFailureReason: insResult.reason || "unknown",
                emailClassification,
                deleteAt: getDeleteAt(mailIntakeQueue.INTAKE_TTL_DAYS),
              },
            });
            return;
          } catch (insErr) {
            await writeLog("error", "insurance",
                "Insurance intake failed — forwarding for review", {
                  messageId,
                  subject,
                  error: insErr.message,
                  stack: insErr.stack,
                  classification: emailClassification,
                });
            await forwardWithAnalysis(
                "Insurance email processing failed", {department: "billing"});
            await mailIntakeQueue.completeIntakeRecord({
              tenant,
              docId: queueDocId,
              parentMessageId: messageId,
              outcome: mailIntakeQueue.OUTCOME.FORWARDED,
              finalStatus: "insurance_error",
              forwardReason: insErr.message || "Insurance processing error",
              extra: {
                gmailMessageId: messageId,
                subject,
                from,
                emailClassification,
                error: String(insErr.message || "").slice(0, 1000),
                deleteAt: getDeleteAt(mailIntakeQueue.INTAKE_TTL_DAYS),
              },
            });
            return;
          }
        }
      }

      // Clear bank-sender alerts: cheap regex quiet-ignore.
      // Ambiguous Zelle/QuickPay language: defer to post-scan / no-attachment
      // AI path — never silent-drop invoice/BOL threads early.
      if (!isTai &&
          administrativeEmailIntake.shouldIgnoreAsPaymentNotification(
              subject, from, emailBody, attachments) &&
          !administrativeEmailIntake.hasInvoiceVeto({
            subject,
            body: emailBody,
            attachments,
            emailClassification,
          })) {
        await completeAdministrativeIgnore({
          messageId,
          subject,
          from,
          tenant,
          queueDocId,
          finalStatus: "payment_notification_ignored",
          reason: "Payment notification (Zelle/bank) — ignored",
        });
        return;
      }

      if (!isTai && isQuoteInboxProcessingEnabled()) {
        const quoteIntakeMod = require("./quote-intake");
        if (quoteIntakeMod.looksLikeQuoteRequest(subject, emailBody) &&
          emailClassification.intent === "unknown") {
          try {
            emailClassification = await classifyIncomingEmail(
                subject, from, emailBody, attachments);
          } catch (_) {
          // heuristic fallback below
          }
        }
      }

      if (!isTai && isQuoteInboxProcessingEnabled()) {
        const quoteAutomation = require("./quote-automation");
        const quoteIntakeMod = require("./quote-intake");
        const quoteLooks =
        emailClassification.intent === "quote_request" ||
        (emailClassification.intent === "unknown" &&
          quoteIntakeMod.looksLikeQuoteRequest(subject, emailBody));
        if (quoteLooks) {
          try {
            const quoteResult = await quoteAutomation.processQuoteEmail({
              messageId,
              subject,
              from,
              to,
              cc,
              emailBody,
              tenant,
            });
            if (quoteResult.handled) {
              await mailIntakeQueue.completeIntakeRecord({
                tenant,
                docId: queueDocId,
                parentMessageId: messageId,
                outcome: mailIntakeQueue.OUTCOME.PROCESSED,
                finalStatus: "quote_processed",
                extra: {
                  gmailMessageId: messageId,
                  subject,
                  from,
                  deleteAt: getDeleteAt(mailIntakeQueue.INTAKE_TTL_DAYS),
                },
              });
              return;
            }
          } catch (quoteErr) {
            await writeLog("error", "quote", "Quote request handler failed", {
              messageId,
              subject,
              error: quoteErr.message,
            });
          }
        }
      }

      if (!isTai) {
        const skipPodForCarrierInvoice =
          administrativeEmailIntake.hasInvoiceVeto({
            subject,
            body: emailBody,
            attachments,
            emailClassification,
          });
        // Do not let heuristic override an explicit AI "not POD" / non-pod
        // intent (e.g. scheduling reply with POD boilerplate in a signature).
        const aiRejectsPod =
          podRequestIntake.aiRejectsPodRequest(emailClassification);
        const podRequestCandidate = !aiRejectsPod &&
          podRequestIntake.looksLikePodRequest(subject, emailBody);
        if (!skipPodForCarrierInvoice && !aiRejectsPod &&
          (podRequestCandidate ||
          (emailClassification.intent === "pod_request"))) {
          try {
            if (podRequestCandidate &&
                emailClassification.intent === "unknown") {
              emailClassification = await classifyIncomingEmail(
                  subject, from, emailBody, attachments);
            }
            if (podRequestIntake.aiRejectsPodRequest(emailClassification) &&
                emailClassification.intent !== "pod_request") {
              await writeLog("info", "mail",
                  "POD heuristic skipped — AI says not POD request", {
                    messageId,
                    subject,
                    intent: emailClassification.intent || null,
                    reasoning: emailClassification.reasoning || null,
                  });
            } else {
              const podReqResult = await handlePodRequestEmail({
                messageId,
                subject,
                from,
                emailBody,
                tenant,
                emailClassification,
              });
              if (podReqResult.handled) {
                await mailIntakeQueue.completeIntakeRecord({
                  tenant,
                  docId: queueDocId,
                  parentMessageId: messageId,
                  outcome: mailIntakeQueue.OUTCOME.PROCESSED,
                  finalStatus: podReqResult.status || "pod_request",
                  extra: {
                    gmailMessageId: messageId,
                    subject,
                    from,
                    loadNumber: podReqResult.loadNumber || null,
                    requesterEmail: podReqResult.requesterEmail || null,
                    escalatedToLisa: !!podReqResult.escalatedToLisa,
                    emailClassification,
                    deleteAt: getDeleteAt(mailIntakeQueue.INTAKE_TTL_DAYS),
                  },
                });
                return;
              }
            }
          } catch (podReqErr) {
            await writeLog("warn", "mail", "POD request handler failed", {
              messageId,
              subject,
              error: podReqErr.message,
            });
          }
        }
      }

      if (!isTai) {
        const adminIgnore =
          administrativeEmailIntake.evaluateAdministrativeIgnore(
              subject, from, emailBody, attachments);
        if (adminIgnore.ignore &&
          !administrativeEmailIntake.hasInvoiceVeto({
            subject,
            body: emailBody,
            attachments,
            emailClassification,
          })) {
          await completeAdministrativeIgnore({
            messageId,
            subject,
            from,
            tenant,
            queueDocId,
            finalStatus: adminIgnore.status,
            reason: adminIgnore.reason,
          });
          return;
        }
      }

      if (attachments.length === 0) {
        const quoteIntakeMod = require("./quote-intake");
        if (!isTai && isQuoteInboxProcessingEnabled() &&
          quoteIntakeMod.looksLikeQuoteRequest(subject, emailBody)) {
          try {
            const quoteAutomation = require("./quote-automation");
            const quoteResult = await quoteAutomation.processQuoteEmail({
              messageId,
              subject,
              from,
              to,
              cc,
              emailBody,
              tenant,
            });
            if (quoteResult.handled) {
              await mailIntakeQueue.completeIntakeRecord({
                tenant,
                docId: queueDocId,
                parentMessageId: messageId,
                outcome: mailIntakeQueue.OUTCOME.PROCESSED,
                finalStatus: "quote_processed",
                extra: {
                  gmailMessageId: messageId,
                  subject,
                  from,
                  deleteAt: getDeleteAt(mailIntakeQueue.INTAKE_TTL_DAYS),
                },
              });
              return;
            }
          } catch (quoteErr) {
            await writeLog("error", "quote",
                "Quote handler failed (no attachment path)", {
                  messageId, error: quoteErr.message,
                });
          }
        }
        if (administrativeEmailIntake.shouldHandlePaymentInquiry(
            subject, from, emailBody, 0) &&
          !administrativeEmailIntake.hasInvoiceVeto({
            subject,
            body: emailBody,
            attachments,
            emailClassification,
          })) {
          await handlePaymentInquiryEmail({
            gmail, messageId, subject, from, emailBody, tenant, headers,
            emailClassification,
            queueDocId,
            reason: "Payment inquiry email with no attachments",
          });
          return;
        }
        if (administrativeEmailIntake.shouldHandleCustomerPaymentRemittance(
            subject, from, emailBody)) {
          await handleCustomerPaymentRemittanceEmail({
            gmail, messageId, subject, from, emailBody, tenant, headers,
            emailClassification,
            queueDocId,
            reason: "Customer payment remittance with no attachments",
          });
          return;
        }
        {
          const payIgnore = await resolveQuietPaymentIgnore({
            subject,
            from,
            body: emailBody,
            attachments,
            emailClassification,
            invoicePdfCount: 0,
          });
          if (payIgnore.ignore) {
            await completeAdministrativeIgnore({
              messageId,
              subject,
              from,
              tenant,
              queueDocId,
              finalStatus: "payment_notification_ignored",
              reason: payIgnore.source === "ai" ?
                `Payment notification (AI) — ${payIgnore.reason}` :
                "Payment notification (Zelle/bank) — ignored",
              extra: payIgnore.ai ? {
                paymentNotificationAi: {
                  intent: payIgnore.ai.intent,
                  confidence: payIgnore.ai.confidence,
                  model: payIgnore.ai.model,
                  source: payIgnore.ai.source,
                },
              } : undefined,
            });
            return;
          }
          if (payIgnore.ai &&
              payIgnore.ai.intent === "customer_remittance") {
            await handleCustomerPaymentRemittanceEmail({
              gmail, messageId, subject, from, emailBody, tenant, headers,
              emailClassification,
              queueDocId,
              reason: "Customer remittance (AI) with no attachments",
            });
            return;
          }
        }
        await writeLog("warn", "mail",
            "No attachments found, forwarding for review", {
              messageId, subject,
            });
        const noAttachVeto = administrativeEmailIntake.hasInvoiceVeto({
          subject,
          body: emailBody,
          attachments,
          emailClassification,
        });
        await forwardWithAnalysis(
            "Email received with no attachments",
            noAttachVeto ?
              {department: "invoice_veto"} :
              {department: "general"},
        );
        await mailIntakeQueue.completeIntakeRecord({
          tenant,
          docId: queueDocId,
          parentMessageId: messageId,
          outcome: mailIntakeQueue.OUTCOME.FORWARDED,
          finalStatus: "no_attachment",
          forwardReason: "Email received with no attachments",
          extra: {
            gmailMessageId: messageId,
            subject,
            from,
            deleteAt: getDeleteAt(mailIntakeQueue.INTAKE_TTL_DAYS),
          },
        });
        return;
      }

      if (!options.fromQueue) {
        await updateGmailQueueStatus(messageId, "processing", null, {
          skipAttemptIncrement: true,
          tenant,
        });
      }

      await writeLog(
          "info",
          "mail",
          `Found ${attachments.length} attachments`,
          {
            messageId: messageId,
            attachmentCount: attachments.length,
            attachments: attachments.map((a) => ({
              filename: a.filename,
              mimeType: a.mimeType,
            })),
          },
      );

      // pdfAttachments: passed to Claude Vision (includes buffer)
      // storedAttachments: saved to Firestore (no buffer)
      pdfAttachments = [];
      storedAttachments = [];
      const skippedDocTypes = [];

      await logWorkflowStep({
        stepName: "attachments_saved_to_storage",
        stepStatus: "started",
        input: {attachmentCount: attachments.length},
      });

      for (const attachment of attachments) {
        await writeLog("info", "storage",
            `Processing attachment ${attachment.filename}`, {
              messageId,
              filename: attachment.filename,
              mimeType: attachment.mimeType,
              fromNestedMime: Boolean(attachment.fromNestedMime),
            });

        let fileBuffer;
        try {
          fileBuffer = await resolveAttachmentBuffer(
              gmail, messageId, attachment);
        } catch (dlErr) {
          await writeLog("warn", "mail", "Attachment download failed", {
            messageId,
            filename: attachment.filename,
            error: dlErr.message,
          });
          continue;
        }
        if (!fileBuffer || !fileBuffer.length) {
          continue;
        }

        // Skip non-PDFs — except JPEG/PNG POD images (invoice companion or
        // POD-only / trailer replies).
        const podFollowup = require("./pod-followup");
        if (!shouldProcessAttachment(attachment, fileBuffer)) {
          if (podFollowup.isPodImageAttachment(attachment, fileBuffer)) {
            const imageMime = podFollowup.detectImageMime(
                attachment, fileBuffer);
            const hasInvoicePdfYet = pdfAttachments.some(
                (a) => a.docType !== "POD");
            const docType = hasInvoicePdfYet ? "POD_IMAGE" : "TRAILER_IMAGE";
            const safeImgName =
              String(attachment.filename || "pod.jpg")
                  .replace(/[^a-zA-Z0-9._-]/g, "_");
            const imgPath =
              `emailAttachments/${messageId}/${Date.now()}-${safeImgName}`;
            await getBucket().file(imgPath).save(fileBuffer, {
              metadata: {contentType: imageMime},
            });
            await writeLog("info", "storage",
                docType === "POD_IMAGE" ?
                "Saved POD image attachment" :
                "Saved trailer image attachment", {
                  messageId,
                  filename: attachment.filename,
                  storagePath: imgPath,
                  fileSize: fileBuffer.length,
                  mimeType: imageMime,
                  docType,
                });
            storedAttachments.push({
              filename: attachment.filename,
              mimeType: imageMime,
              storagePath: imgPath,
              docType,
            });
            continue;
          }
          await writeLog("info", "mail", `Skipping non-invoice attachment`, {
            messageId,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            fileSize: fileBuffer.length,
            zipExpanded: Boolean(attachment.zipExpanded),
            fromZip: Boolean(attachment.fromZip),
          });
          const isPdfMime = isPdfAttachment(attachment, fileBuffer);
          const isExpandedZip =
            Boolean(attachment.zipExpanded) ||
            invoiceZipAttachments.isZipAttachment(attachment, fileBuffer);
          if (isPdfMime && isPdfTooSmallForIntake(attachment, fileBuffer)) {
          // Small PDF — likely a real document but too short to be an invoice
            skippedDocTypes.push("small PDF");
          } else if (!isPdfMime && !isExpandedZip &&
              fileBuffer.length >= 10000) {
          // Substantive non-PDF (Excel, Word, image, etc.)
          // Expanded ZIP shells are omitted — their inner PDFs are processed.
            const ext = String(attachment.filename || "")
                .split(".").pop().toUpperCase();
            skippedDocTypes.push(ext || attachment.mimeType || "non-PDF file");
          } else if (isExpandedZip && !attachment.zipExpanded) {
            // ZIP present but nothing invoice-like extracted.
            skippedDocTypes.push("ZIP");
          }
          continue;
        }

        // Cheap first-page pre-check: keep invoices and standalone POD PDFs.
        let docType = "INVOICE";
        try {
          docType = await preCheckDocumentType(fileBuffer);
        } catch (preCheckErr) {
          await writeLog("warn", "ai", "Pre-check failed, assuming INVOICE", {
            messageId,
            filename: attachment.filename,
            error: preCheckErr.message,
          });
        }

        const preCheckLabel = docType;
        const pageCount = await getPdfPageCount(fileBuffer);
        docType = normalizePreCheckDocType(docType, {
          subject, from, filename: attachment.filename,
          pageCount,
          body: emailBody,
        });
        if (preCheckLabel !== docType && docType === "INVOICE") {
          await writeLog("info", "mail",
              "Carrier statement PDF — attempting multi-invoice extraction", {
                messageId, filename: attachment.filename,
                preCheckLabel,
                pageCount,
              });
        }
        if (docType !== "INVOICE" && docType !== "POD") {
          const keepAsInvoice =
            shouldTreatStatementCoverAsInvoiceBundle({
              preCheckLabel,
              subject, from, filename: attachment.filename,
              pageCount,
              body: emailBody,
            }) ||
            statementInvoiceBundle.looksLikeCarrierInvoiceEmail(
                subject, from, emailBody) ||
            statementInvoiceBundle.looksLikeCarrierInvoiceEmail(
                attachment.filename, from, "") ||
            administrativeEmailIntake.looksLikeInvoiceEmailContent(
                subject, emailBody);
          if (keepAsInvoice) {
            docType = "INVOICE";
            await writeLog("info", "mail",
                "Statement-cover PDF treated as invoice bundle", {
                  messageId,
                  filename: attachment.filename,
                  preCheckLabel,
                  pageCount,
                });
          } else if (sanitizePreCheckLabel(preCheckLabel) === "STATEMENT") {
            await writeLog("info", "mail",
                "Carrier statement ignored — not an invoice bundle", {
                  messageId,
                  filename: attachment.filename,
                  pageCount,
                });
            skippedDocTypes.push("STATEMENT");
            continue;
          } else {
            await writeLog("info", "mail",
                `Attachment is ${preCheckLabel}, skipping`, {
                  messageId, filename: attachment.filename,
                  docType: preCheckLabel,
                });
            skippedDocTypes.push(preCheckLabel);
            continue;
          }
        }

        const safeFilename =
          attachment.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
        const storagePath =
          `emailAttachments/${messageId}/${Date.now()}-${safeFilename}`;

        await getBucket().file(storagePath).save(fileBuffer, {
          metadata: {contentType: "application/pdf"},
        });

        await writeLog("info", "storage", `Saved PDF to storage`, {
          messageId,
          filename: attachment.filename,
          storagePath,
          fileSize: fileBuffer.length,
          docType,
        });

        pdfAttachments.push({
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          buffer: fileBuffer,
          storagePath,
          docType,
        });

        storedAttachments.push({
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          storagePath,
          docType,
        });
      }

      // Last resort for Outlook/FW emails: scan the full raw MIME for PDFs
      // that Gmail did not expose as top-level parts.
      if (pdfAttachments.filter((a) => a.docType !== "POD").length === 0) {
        try {
          const rawPdfs = await extractPdfsFromRawMessage(gmail, messageId);
          if (rawPdfs.length > 0) {
            await writeLog("info", "mail",
                "Recovered PDF(s) from raw MIME message", {
                  messageId,
                  count: rawPdfs.length,
                  filenames: rawPdfs.map((a) => a.filename),
                });
          }
          for (const attachment of rawPdfs) {
            if (!shouldProcessAttachment(attachment, attachment.buffer)) {
              continue;
            }
            let docType = "INVOICE";
            try {
              docType = await preCheckDocumentType(attachment.buffer);
            } catch (preCheckErr) {
              await writeLog("warn", "ai",
                  "Pre-check failed on raw MIME PDF, assuming INVOICE", {
                    messageId,
                    filename: attachment.filename,
                    error: preCheckErr.message,
                  });
            }
            const preCheckLabel = docType;
            const pageCount = await getPdfPageCount(attachment.buffer);
            docType = normalizePreCheckDocType(docType, {
              subject, from, filename: attachment.filename,
              pageCount,
              body: emailBody,
            });
            if (preCheckLabel !== docType && docType === "INVOICE") {
              await writeLog("info", "mail",
                  "Carrier statement PDF from raw MIME — multi-invoice", {
                    messageId, filename: attachment.filename,
                    preCheckLabel,
                    pageCount,
                  });
            }
            if (docType !== "INVOICE" && docType !== "POD") {
              const keepAsInvoice =
                shouldTreatStatementCoverAsInvoiceBundle({
                  preCheckLabel,
                  subject, from, filename: attachment.filename,
                  pageCount,
                  body: emailBody,
                }) ||
                statementInvoiceBundle.looksLikeCarrierInvoiceEmail(
                    subject, from, emailBody) ||
                statementInvoiceBundle.looksLikeCarrierInvoiceEmail(
                    attachment.filename, from, "") ||
                administrativeEmailIntake.looksLikeInvoiceEmailContent(
                    subject, emailBody);
              if (keepAsInvoice) {
                docType = "INVOICE";
              } else if (sanitizePreCheckLabel(preCheckLabel) === "STATEMENT") {
                skippedDocTypes.push("STATEMENT");
                continue;
              } else {
                skippedDocTypes.push(preCheckLabel);
                continue;
              }
            }
            const safeFilename =
              String(attachment.filename || "invoice.pdf")
                  .replace(/[^a-zA-Z0-9._-]/g, "_");
            const storagePath =
              `emailAttachments/${messageId}/${Date.now()}-${safeFilename}`;
            await getBucket().file(storagePath).save(attachment.buffer, {
              metadata: {contentType: "application/pdf"},
            });
            pdfAttachments.push({
              filename: attachment.filename,
              mimeType: "application/pdf",
              buffer: attachment.buffer,
              storagePath,
              docType,
            });
            storedAttachments.push({
              filename: attachment.filename,
              mimeType: "application/pdf",
              storagePath,
              docType,
            });
          }
        } catch (rawErr) {
          await writeLog("warn", "mail",
              "Raw MIME PDF recovery failed", {
                messageId,
                error: rawErr.message,
              });
        }

        // Apex Capital factoring: PDFs are linked in the body, not attached.
        if (pdfAttachments.filter((a) => a.docType !== "POD").length === 0) {
          try {
            const apexResult =
                await apexCapitalIntake.fetchInvoicePdfsFromEmail({
                  payload,
                  subject,
                  from,
                });
            if (apexResult.handled) {
              await writeLog("info", "mail", "Apex Capital email detected", {
                messageId,
                subject,
                urlCount: (apexResult.urls || []).length,
                downloaded: (apexResult.pdfs || []).length,
                errors: apexResult.errors || null,
              });
            }
            if (apexResult.handled && apexResult.pdfs &&
              apexResult.pdfs.length > 0) {
              for (const downloaded of apexResult.pdfs) {
                if (!downloaded.buffer || !downloaded.buffer.length) {
                  continue;
                }
                if (!apexCapitalIntake.isPdfBuffer(downloaded.buffer)) {
                  continue;
                }
                const safeFilename =
                  String(downloaded.filename || "apex-invoice.pdf")
                      .replace(/[^a-zA-Z0-9._-]/g, "_");
                const storagePath =
                  `emailAttachments/${messageId}/${Date.now()}-${safeFilename}`;
                await getBucket().file(storagePath).save(downloaded.buffer, {
                  metadata: {contentType: "application/pdf"},
                });
                await writeLog("info", "storage",
                    "Saved Apex invoice PDF from portal link", {
                      messageId,
                      filename: downloaded.filename,
                      storagePath,
                      fileSize: downloaded.buffer.length,
                      barCode: downloaded.barCode || null,
                    });
                pdfAttachments.push({
                  filename: downloaded.filename,
                  mimeType: "application/pdf",
                  buffer: downloaded.buffer,
                  storagePath,
                  docType: "INVOICE",
                  source: "apex_capital_link",
                });
                storedAttachments.push({
                  filename: downloaded.filename,
                  mimeType: "application/pdf",
                  storagePath,
                  docType: "INVOICE",
                  source: "apex_capital_link",
                });
              }
            } else if (apexResult.handled && !apexResult.ok) {
              await writeLog("warn", "mail",
                  "Apex email had no downloadable invoice PDFs", {
                    messageId,
                    subject,
                    urls: apexResult.urls || [],
                    errors: apexResult.errors || null,
                  });
            }
          } catch (apexErr) {
            await writeLog("warn", "mail", "Apex Capital intake failed", {
              messageId,
              error: apexErr.message,
            });
          }
        }
      }

      // JPEG/PNG may arrive before the invoice PDF in attachment order.
      const hasInvoicePdf = pdfAttachments.some((a) => a.docType !== "POD");
      if (hasInvoicePdf) {
        for (const att of storedAttachments) {
          if (att.docType === "TRAILER_IMAGE") {
            att.docType = "POD_IMAGE";
          }
        }
      }

      // If no processable invoice PDFs found — try POD-only delivery path
      // (never creates an invoice). Otherwise forward for review.
      const invoicePdfCount = pdfAttachments.filter(
          (a) => a.docType !== "POD",
      ).length;
      const trailerImageCount = storedAttachments.filter(
          (a) => a.docType === "TRAILER_IMAGE" || a.docType === "POD_IMAGE",
      ).length;
      if (pdfAttachments.length === 0 || invoicePdfCount === 0) {
        const hasPodMaterial =
        pdfAttachments.some((a) => a.docType === "POD") ||
        trailerImageCount > 0;
        if (hasPodMaterial) {
          const podResult = await handlePodOnlyDeliveryEmail({
            gmail, messageId, subject, from, emailBody, tenant,
            pdfAttachments, storedAttachments,
          });
          if (podResult && podResult.handled) {
            await mailIntakeQueue.completeIntakeRecord({
              tenant,
              docId: queueDocId,
              parentMessageId: messageId,
              outcome: mailIntakeQueue.OUTCOME.PROCESSED,
              finalStatus: podResult.status || "pod_delivery",
              extra: {
                gmailMessageId: messageId,
                subject,
                from,
                matchedInvoiceId: podResult.invoiceId || null,
                loadNumber: podResult.loadNumber || null,
                deleteAt: getDeleteAt(mailIntakeQueue.INTAKE_TTL_DAYS),
              },
            });
            return;
          }
        }
        await writeLog("warn", "mail", "No processable PDF invoices found",
            {messageId, subject});
        const hasStatementOnly =
        skippedDocTypes.some((t) => String(t).toUpperCase() === "STATEMENT") &&
        invoicePdfCount === 0;
        if (hasStatementOnly &&
            !statementInvoiceBundle.looksLikeStatementCoverInvoicePacketEmail(
                subject, from, emailBody, attachments)) {
          await handleStatementOnlyEmail({
            gmail, messageId, subject, from, emailBody, tenant, headers,
            emailClassification,
            queueDocId,
            reason:
              "Email contained a carrier statement but no freight invoice",
          });
          return;
        }
        if (administrativeEmailIntake.shouldHandleCarrierStatementFollowUp(
            subject, from, emailBody, attachments, invoicePdfCount)) {
          await handleStatementOnlyEmail({
            gmail, messageId, subject, from, emailBody, tenant, headers,
            emailClassification,
            queueDocId,
            reason:
              "Carrier statement / overdue invoice follow-up — " +
              "no freight invoice to enter",
          });
          return;
        }
        if (administrativeEmailIntake.shouldIgnoreNoaOnlyPackage(
            subject, emailBody, attachments, invoicePdfCount, from) &&
          !administrativeEmailIntake.hasInvoiceVeto({
            subject,
            body: emailBody,
            from,
            attachments,
            emailClassification,
            invoicePdfCount,
          })) {
          await completeAdministrativeIgnore({
            messageId,
            subject,
            from,
            tenant,
            queueDocId,
            finalStatus: "noa_ignored",
            reason: "Notice of Assignment — no carrier invoice attached",
            extra: {skippedAttachmentTypes: skippedDocTypes},
          });
          return;
        }
        {
          const payIgnore = await resolveQuietPaymentIgnore({
            subject,
            from,
            body: emailBody,
            attachments,
            emailClassification,
            invoicePdfCount,
          });
          if (payIgnore.ignore && invoicePdfCount === 0) {
            await completeAdministrativeIgnore({
              messageId,
              subject,
              from,
              tenant,
              queueDocId,
              finalStatus: "payment_notification_ignored",
              reason: payIgnore.source === "ai" ?
                `Payment notification (AI) — ${payIgnore.reason}` :
                "Payment notification (Zelle/bank) — no freight invoice",
              extra: {
                skippedAttachmentTypes: skippedDocTypes,
                ...(payIgnore.ai ? {
                  paymentNotificationAi: {
                    intent: payIgnore.ai.intent,
                    confidence: payIgnore.ai.confidence,
                    model: payIgnore.ai.model,
                    source: payIgnore.ai.source,
                  },
                } : {}),
              },
            });
            return;
          }
        }
        let noInvoiceReason =
          "Could not find a freight invoice in this email";
        if (skippedDocTypes.length > 0) {
          const typeList = [...new Set(skippedDocTypes)].join(", ");
          noInvoiceReason =
            `Email contained ${typeList} attachment(s) but no invoice`;
        } else if (pdfAttachments.length > 0 && invoicePdfCount === 0) {
          noInvoiceReason =
            "Email contained POD attachment(s) but no carrier invoice";
        }
        if (administrativeEmailIntake.shouldHandlePaymentInquiry(
            subject, from, emailBody, invoicePdfCount) &&
          !administrativeEmailIntake.hasInvoiceVeto({
            subject,
            body: emailBody,
            attachments,
            emailClassification,
            invoicePdfCount,
          })) {
          await handlePaymentInquiryEmail({
            gmail, messageId, subject, from, emailBody, tenant, headers,
            emailClassification,
            queueDocId,
            reason: noInvoiceReason,
          });
          return;
        }
        if (administrativeEmailIntake.shouldHandleCustomerPaymentRemittance(
            subject, from, emailBody)) {
          await handleCustomerPaymentRemittanceEmail({
            gmail, messageId, subject, from, emailBody, tenant, headers,
            emailClassification,
            queueDocId,
            reason: noInvoiceReason,
          });
          return;
        }
        if (drayageIntake.isDrayageValidatorEmail(from)) {
          const leoApply = await applyLeoDrayageReturnIfPresent({
            from, emailBody, subject, invoiceItems: [],
            pdfAttachments, messageId, tenant, queueDocId,
          });
          if (leoApply.handled) return;
        }
        if (!isTai && !drayageIntake.isDrayageValidatorEmail(from)) {
          let probedContainer =
            drayageIntake.extractContainerFromText(subject, emailBody);
          if (!probedContainer && pdfAttachments.length > 0) {
            probedContainer =
              await drayageIntake.probeContainerOnPdfs(pdfAttachments);
          }
          const drayageSignal =
            await drayageIntake.resolveInboundDrayageSignal({
              from,
              invoiceItems: [],
              probedContainer,
              subject,
              body: emailBody,
            });
          if (drayageSignal.isDrayage) {
            await handleDrayageInvoiceEmail({
              gmail, messageId, subject, from, emailBody, tenant,
              queueDocId,
              containerNumber: drayageSignal.containerNumber,
              carrierName: drayageSignal.carrierName,
              reason: drayageSignal.reason ||
                "Drayage paperwork — carrier identified as drayage",
            });
            return;
          }
        }
        const vetoBlockedAmbiguous = administrativeEmailIntake.hasInvoiceVeto({
          subject,
          body: emailBody,
          attachments,
          emailClassification,
          invoicePdfCount,
        });
        await forwardWithAnalysis(
            noInvoiceReason,
            vetoBlockedAmbiguous ?
              {department: "invoice_veto"} :
              {department: "general"},
        );
        await mailIntakeQueue.completeIntakeRecord({
          tenant,
          docId: queueDocId,
          parentMessageId: messageId,
          outcome: mailIntakeQueue.OUTCOME.FORWARDED,
          finalStatus: "no_invoice_pdf",
          forwardReason: noInvoiceReason,
          extra: {
            gmailMessageId: messageId,
            subject,
            from,
            skippedAttachmentTypes: skippedDocTypes,
            deleteAt: getDeleteAt(mailIntakeQueue.INTAKE_TTL_DAYS),
          },
        });
        return;
      }

      await logWorkflowStep({
        gmailMessageId: messageId,
        stepName: "attachments_saved_to_storage",
        stepStatus: "success",
        output: {savedAttachments: pdfAttachments.length},
      });

      await writeLog("info", "ai", `Starting AI classification`, {
        messageId: messageId,
        attachmentCount: pdfAttachments.length,
      });

      if (administrativeEmailIntake.shouldHandleCustomerPaymentRemittance(
          subject, from, emailBody)) {
        await handleCustomerPaymentRemittanceEmail({
          gmail, messageId, subject, from, emailBody, tenant, headers,
          emailClassification,
          queueDocId,
          reason:
            "Customer payment remittance — attachments are not carrier invoices",
        });
        return;
      }

      try {
        await logWorkflowStep({
          gmailMessageId: messageId,
          stepName: "claude_classification_started",
          stepStatus: "started",
          input: {attachmentCount: pdfAttachments.length},
        });

        aiResult = await classifyInvoiceData(
            pdfAttachments,
            lastKnownLoadNumber,
        );

        await logWorkflowStep({
          gmailMessageId: messageId,
          stepName: "claude_classification_completed",
          stepStatus: "success",
          output: {
            invoiceCount:
            normalizeClassificationToInvoices(aiResult).length || 1,
            loadNumbers: normalizeClassificationToInvoices(aiResult)
                .map((i) => i.loadNumber),
            status: aiResult.status,
          },
        });
      } catch (aiError) {
        await writeLog("error", "ai", `AI classification failed`, {
          messageId: messageId,
          error: aiError.message,
          stack: aiError.stack,
        });

        await logWorkflowStep({
          gmailMessageId: messageId,
          stepName: "claude_classification_completed",
          stepStatus: "failed",
          error: aiError.message,
        });

        throw aiError;
      }

      rawClassification = aiResult;
      invoiceItems = normalizeClassificationToInvoices(rawClassification);
      if (invoiceItems.length === 0) {
        invoiceItems = [rawClassification];
      }

      try {
        const preferred = await preferRevisedInvoicesForSameLoad(
            invoiceItems, pdfAttachments);
        if (preferred.dropped.length > 0) {
          await writeLog("info", "ai",
              "Dropped original invoice(s); prefer corrected/revised", {
                messageId,
                dropped: preferred.dropped,
                keptLoadNumbers: preferred.items.map((i) => i && i.loadNumber),
              });
          invoiceItems = preferred.items;
        }
      } catch (preferErr) {
        await writeLog("warn", "ai",
            "Revised-invoice preference failed; keeping all items", {
              messageId,
              error: preferErr.message,
            });
      }

      try {
        const recovered = await recoverStatementInvoiceItems({
          messageId,
          subject,
          pdfAttachments,
          invoiceItems,
          lastKnownLoadNumber,
        });
        invoiceItems = recovered.invoiceItems;
        statementExtractionGap = recovered.gap;
      } catch (stmtErr) {
        await writeLog("warn", "ai",
            "Statement under-extraction recovery failed", {
              messageId,
              error: stmtErr.message,
            });
      }

      try {
        const scoped = await repairSharedPdfInvoicePages(
            invoiceItems, pdfAttachments);
        if (scoped.repaired.length > 0) {
          await writeLog("info", "ai",
              "Re-scoped shared multi-invoice PDF pages per PRO", {
                messageId,
                repaired: scoped.repaired,
              });
          invoiceItems = scoped.items;
        }
      } catch (scopeErr) {
        await writeLog("warn", "ai",
            "Shared-PDF page scoping failed; keeping classifier pages", {
              messageId,
              error: scopeErr.message,
            });
      }

      try {
        const filtered = await filterAlreadyProcessedInvoiceItems(
            tenant, messageId, invoiceItems);
        preSkippedItemSummaries = filtered.skippedSummaries;
        invoiceItems = filtered.items;
      } catch (skipErr) {
        await writeLog("warn", "mail",
            "Already-processed load filter failed; continuing", {
              messageId,
              error: skipErr.message,
            });
      }

      if (!isChildSplitJob &&
          statementInvoiceBundle.shouldAlertStatementUnderExtraction(
              statementExtractionGap)) {
        try {
          await handleStatementUnderExtractionAlert({
            gmail,
            messageId,
            subject,
            from,
            gap: statementExtractionGap,
            emailBody,
          });
        } catch (alertErr) {
          await writeLog("warn", "mail",
              "Statement under-extraction alert failed", {
                messageId,
                error: alertErr.message,
              });
        }
      }

      if (!isTai) {
        if (drayageIntake.isDrayageValidatorEmail(from)) {
          const leoApply = await applyLeoDrayageReturnIfPresent({
            from, emailBody, subject, invoiceItems,
            pdfAttachments, messageId, tenant, queueDocId,
          });
          if (leoApply.handled && !leoApply.ok) return;
        } else {
          const drayageSignal =
            await drayageIntake.resolveInboundDrayageSignal({
              from,
              invoiceItems,
              probedContainer: null,
              subject,
              body: emailBody,
            });
          if (drayageSignal.isDrayage) {
            await handleDrayageInvoiceEmail({
              gmail, messageId, subject, from, emailBody, tenant,
              queueDocId,
              containerNumber: drayageSignal.containerNumber,
              carrierName: drayageSignal.carrierName,
              reason: drayageSignal.reason ||
                "Drayage invoice — carrier identified as drayage",
            });
            return;
          }
        }
      }
    } // end !isChildSplitJob — classification / attachment pipeline

    if (!isChildSplitJob && invoiceItems.length === 0 &&
        preSkippedItemSummaries.length > 0) {
      const stmtUnderExtracted =
          statementInvoiceBundle.shouldAlertStatementUnderExtraction(
              statementExtractionGap);
      await mailIntakeQueue.completeIntakeRecord({
        tenant,
        docId: queueDocId,
        parentMessageId: messageId,
        outcome: stmtUnderExtracted ?
          mailIntakeQueue.OUTCOME.PARTIAL :
          mailIntakeQueue.OUTCOME.PROCESSED,
        finalStatus: stmtUnderExtracted ?
          "statement_under_extracted" :
          "already_processed_skipped",
        itemSummaries: preSkippedItemSummaries,
        extra: {
          gmailMessageId: messageId,
          subject,
          from,
          statementExtractionGap: stmtUnderExtracted ?
            statementExtractionGap : null,
          deleteAt: getDeleteAt(mailIntakeQueue.INTAKE_TTL_DAYS),
        },
      });
      return;
    }

    if (!isChildSplitJob && invoiceItems.length > 1) {
      await tcol(tenant, "emailIntake").doc(messageId).set({
        parsedAttachments: storedAttachments,
        rawClassification,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
      const childCount = await mailIntakeQueue.createInvoiceChildJobs({
        tenant,
        parentMessageId: messageId,
        subject,
        from,
        invoiceItems,
        preSkippedSummaries: preSkippedItemSummaries,
        statementExtractionGap:
          statementInvoiceBundle.shouldAlertStatementUnderExtraction(
              statementExtractionGap) ?
            statementExtractionGap : null,
      });
      await writeLog("info", "mail",
          "Split multi-invoice email into child jobs", {
            messageId,
            childCount,
            invoiceCount: invoiceItems.length,
          });
      return;
    }

    await writeLog("info", "ai", "AI classification invoice items", {
      messageId,
      invoiceCount: invoiceItems.length,
      loadNumbers: invoiceItems.map((i) => i && i.loadNumber),
    });

    const emailIntakeRef = tcol(tenant, "emailIntake").doc(messageId);
    await emailIntakeRef.set({
      tenantId: tenant.tenantId,
      gmailMessageId: messageId,
      from: from,
      subject: subject,
      parsedAttachments: storedAttachments,
      aiResult: rawClassification,
      rawClassification,
      status: "processing",
      inboxFlowId: inboxFlowId || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      deleteAt: getDeleteAt(mailIntakeQueue.INTAKE_TTL_DAYS),
    }, {merge: true});

    const intakeSnapForLoad = await emailIntakeRef.get();
    const intakeDataForLoad = intakeSnapForLoad.exists ?
      intakeSnapForLoad.data() : {};
    const manualLoadOverride = intakeDataForLoad.manualLoadNumber ?
      invoiceLoadEntry.normalizeManualLoadNumber(
          intakeDataForLoad.manualLoadNumber) : null;
    const manualLoadItemIndex = Number(intakeDataForLoad.manualLoadItemIndex);

    const createdInvoiceIds = [];
    const itemSummaries = preSkippedItemSummaries.slice();
    let overallFinalStatus = "error";
    let lastPrimusResult = null;

    for (let itemIndex = 0; itemIndex < invoiceItems.length; itemIndex++) {
      aiResult = Object.assign({}, invoiceItems[itemIndex]);
      let finalStatus = "error";
      let primusResult = null;
      const invoiceIdsBefore = createdInvoiceIds.length;

      try {
        let scopedPages = collectInvoiceScopedPages(aiResult);
        const primaryName = String(aiResult.attachmentFilename || "").trim();
        let primaryAtt = primaryName ?
          pdfAttachments.find((a) =>
            podUtils.attachmentFilenamesMatch(a.filename, primaryName)) :
          null;
        if (!primaryAtt) {
          primaryAtt = pdfAttachments.find((a) => a.docType !== "POD") ||
            pdfAttachments[0];
        }
        let pageCount = 0;
        if (primaryAtt && primaryAtt.buffer) {
          try {
            pageCount = await getPdfPageCount(primaryAtt.buffer);
          } catch (_) {
            pageCount = 0;
          }
          // Classifier sometimes lists every page of a FedEx multi-invoice
          // PDF on each item — re-scope by PRO before upload.
          if (pageCount >= 2 &&
              scopedPagesNeedRepair(scopedPages, pageCount)) {
            const byPro = await findInvoicePagesByProInPdf(
                aiResult, primaryAtt.buffer);
            if (byPro.length > 0 && byPro.length < pageCount) {
              aiResult.invoicePages = byPro.slice();
              scopedPages = collectInvoiceScopedPages(aiResult);
              await writeLog("info", "mail",
                  "Scoped multi-invoice PDF pages by PRO before upload", {
                    messageId,
                    loadNumber: aiResult.loadNumber,
                    proNumber: aiResult.proNumber,
                    pages: scopedPages,
                    pageCount,
                  });
            }
          }
        }
        if (primaryAtt && scopedPages.length > 0) {
          // Keep the full original packet when this PDF belongs to a single
          // load and includes a W&I certificate — slicing to invoicePages
          // alone drops inspection / backup pages needed on additional-
          // charge approval emails (Lisa / Load 265447).
          const claimantCount = invoiceItems.filter((item) => {
            const n = String((item && item.attachmentFilename) || "").trim();
            return n && podUtils.attachmentFilenamesMatch(
                n, primaryAtt.filename);
          }).length;
          const keepFullWiPacket =
            !!aiResult.hasWeightInspectionCertificate &&
            claimantCount <= 1;
          const sliced = keepFullWiPacket ? null :
            await slicePdfByPages(primaryAtt.buffer, scopedPages);
          if (sliced) {
            remapPodPagesAfterSlice(aiResult, scopedPages);
            const safeBase = String(primaryAtt.filename || "invoice.pdf")
                .replace(/[^a-zA-Z0-9._-]/g, "_");
            const proDigits = String(aiResult.proNumber || "")
                .replace(/\D/g, "");
            const slicedName =
                "load-" + (aiResult.loadNumber || itemIndex) +
                (proDigits ? "-pro-" + proDigits : "") +
                "-" + safeBase;
            const slicedPath =
                "emailAttachments/" + messageId + "/scoped-" +
                Date.now() + "-" + slicedName;
            await getBucket().file(slicedPath).save(sliced, {
              metadata: {contentType: "application/pdf"},
            });
            pdfAttachments.push({
              filename: slicedName,
              mimeType: "application/pdf",
              buffer: sliced,
              storagePath: slicedPath,
              docType: "INVOICE",
              scopedFrom: primaryAtt.filename,
              scopedFromStoragePath: primaryAtt.storagePath || null,
            });
            storedAttachments.push({
              filename: slicedName,
              mimeType: "application/pdf",
              storagePath: slicedPath,
              docType: "INVOICE",
              scopedFrom: primaryAtt.filename,
              scopedFromStoragePath: primaryAtt.storagePath || null,
            });
            aiResult.attachmentFilename = slicedName;
            if (aiResult.pod && typeof aiResult.pod === "object") {
              if (!aiResult.pod.attachmentFilename ||
                  aiResult.pod.attachmentFilename === primaryName) {
                aiResult.pod.attachmentFilename = slicedName;
              }
              if (Array.isArray(aiResult.pod.documents)) {
                for (const doc of aiResult.pod.documents) {
                  if (doc && (!doc.attachmentFilename ||
                      doc.attachmentFilename === primaryName)) {
                    doc.attachmentFilename = slicedName;
                  }
                }
              }
            }
          } else if (pageCount >= 2 &&
              scopedPagesNeedRepair(scopedPages, pageCount)) {
            // Never upload the unsliced multi-invoice packet to Primus —
            // it would attach every sibling FedEx bill to this load.
            aiResult.blockUnscopedMultiInvoicePacket = true;
            aiResult.unscopedPacketFilename = primaryAtt.filename;
            await writeLog("warn", "mail",
                "Could not slice multi-invoice PDF — refusing full packet", {
                  messageId,
                  loadNumber: aiResult.loadNumber,
                  proNumber: aiResult.proNumber,
                  scopedPages,
                  pageCount,
                  packetFilename: primaryAtt.filename,
                });
          }
        }
      } catch (sliceErr) {
        await writeLog("warn", "mail",
            "Failed to slice multi-invoice PDF pages", {
              messageId,
              loadNumber: aiResult.loadNumber,
              error: sliceErr.message,
            });
      }

      const normalizedChargeData = normalizeAiChargeArrays(aiResult);
      let pendingImagePodFile = null;
      let normalizedPod = normalizePodFromClassification(aiResult);
      if (!normalizedPod || normalizedPod.found !== true) {
        const imagePod = await maybeBuildPodFromEmailImages(
            storedAttachments,
            messageId,
            aiResult.loadNumber || String(itemIndex));
        if (imagePod) {
          normalizedPod = imagePod.podMeta;
          pendingImagePodFile = imagePod.podOnlyFile;
        }
      }

      if (fedexFreightPod.isFedExFreightCarrier(aiResult.carrierName)) {
        const fedexPro = fedexFreightPod.resolveFedExFreightPro({
          proNumber: aiResult.proNumber,
          invoiceNumber: aiResult.invoiceNumber,
        });
        if (fedexPro) {
          aiResult.proNumber = fedexPro;
        }
      }

      await writeLog("info", "ai", "AI classification completed", {
        event: "AI classification completed",
        messageId: messageId,
        details: {
          status: aiResult.status,
          invoiceAmount: aiResult.invoiceAmount,
          carrierName: aiResult.carrierName,
          proNumber: aiResult.proNumber,
          loadNumber: aiResult.loadNumber,
          charges: aiResult.charges,
          chargesCount: aiResult.charges ? aiResult.charges.length : 0,
          pod: normalizedPod,
          unrecognizedCharges: normalizedChargeData.unrecognizedCharges,
          chargesNeedProof: normalizedChargeData.chargesNeedProof,
          attachments: storedAttachments.map((a) => ({
            filename: a.filename,
            mimeType: a.mimeType,
          })),
          decision: aiResult.status === "ready_for_primus_validation" ?
            "proceed_to_primus" : aiResult.status,
          reason: aiResult.reason,
        },
      });


      let loadResolvedFrom = null;
      let loadGateFailed = false;
      let loadGateReason = null;

      aiResult = loadResolution.applyEmailLoadHintsToInvoice(
          aiResult, subject, emailBody);

      if (!isTai) {
        const useManualLoad = manualLoadOverride &&
          invoiceLoadEntry.isValidManualLoadNumber(manualLoadOverride) &&
          (Number.isNaN(manualLoadItemIndex) ||
            manualLoadItemIndex === itemIndex);
        if (useManualLoad) {
          aiResult.loadNumber = manualLoadOverride;
          aiResult.loadNumberSource = "lisa_manual_entry";
          loadGateFailed = false;
          loadGateReason = null;
          await writeLog("info", "mail",
              "Using Lisa-entered load number for reprocess", {
                messageId,
                loadNumber: manualLoadOverride,
                itemIndex,
              });
        } else if (aiResult.drayageLeoValidated && aiResult.loadNumber) {
          loadGateFailed = false;
          loadGateReason = null;
        } else {
          const loadResolve = await resolveInvoiceLoadNumber(
              aiResult, lastKnownLoadNumber);
          aiResult = loadResolve.aiResult;
          loadGateFailed = loadResolve.gateFailed;
          loadGateReason = loadResolve.gateReason || null;
          loadResolvedFrom = loadResolve.loadResolvedFrom;
          if (loadResolvedFrom) {
            await writeLog("info", "primus",
                "Resolved load number from carrier reference", {
                  messageId,
                  via: loadResolvedFrom.via,
                  ref: loadResolvedFrom.ref,
                  matchedPro: loadResolvedFrom.matchedPro,
                  primusSource: loadResolvedFrom.primusSource,
                  resolvedLoadNumber: aiResult.loadNumber,
                });
          }
        }
        if (!loadGateFailed) {
          aiResult = await sanitizeAndBackfillProNumber(aiResult);
        }
      } else {
        const normalizedLoadNumber =
          normalizeLoadNumber(aiResult.loadNumber);
        const normalizedProNumber = normalizeLoadNumber(aiResult.proNumber);
        const direct = loadResolution.evaluateLoadCandidate(
            normalizedLoadNumber, normalizedProNumber, lastKnownLoadNumber);
        loadGateFailed = !direct.ok;
        loadGateReason = direct.reason || null;
        if (direct.ok) aiResult.loadNumber = direct.loadNumber;
      }

      const normalizedLoadNumber =
        normalizeLoadNumber(aiResult.loadNumber);
      const normalizedProNumber = normalizeLoadNumber(aiResult.proNumber);

      if (loadGateFailed) {
        finalStatus = "no_load_number";

        const offerLisa = invoiceLoadEntry.shouldOfferLisaLoadEntry(
            aiResult, loadGateFailed);
        if (offerLisa) {
          await handleMissingLoadNumberForLisa({
            messageId,
            subject,
            from,
            tenant,
            queueDocId,
            itemIndex,
            aiResult,
            loadGateReason,
            emailIntakeRef,
            inboxFlowId,
          });
        } else {
          await forwardToHumanReview(
              gmail, messageId, subject, from,
              "Could not find a valid load number on this invoice",
              `I processed the invoice from ` +
              `${aiResult.carrierName || "this carrier"} but could not find ` +
              `a valid load number` +
              (loadResolvedFrom || aiResult.proNumber ||
                aiResult.carrierBolNumber || aiResult.carrierOrderNumber ?
                ` (Primus lookup tried carrier PRO, BOL, shipment ref, ` +
                `order #, PO, and tracking search — no matching shipment)` :
                "") +
              `. Without a load number I cannot ` +
              `match this invoice to a shipment in Primus. Please verify the ` +
              `load number with the carrier and reprocess, or handle this ` +
              `invoice manually.`,
              {
                department: "operations",
                extractedData: {
                  "Carrier": aiResult.carrierName || "—",
                  "Invoice Amount": aiResult.invoiceAmount ?
                    `$${aiResult.invoiceAmount}` : "—",
                  ...loadResolution.carrierReferenceReviewFields(aiResult),
                },
              },
          );
        }

        await writeLog("error", "mail", "Load number missing/invalid", {
          event: "Load number validation failed",
          messageId: message.id,
          details: {
            loadNumberRaw: aiResult.loadNumber || null,
            loadNumberNormalized: normalizedLoadNumber || null,
            proNumber: aiResult.proNumber || null,
            carrierBolNumber: aiResult.carrierBolNumber || null,
            carrierOrderNumber: aiResult.carrierOrderNumber || null,
            poNumber: aiResult.poNumber || null,
            shipmentReference: aiResult.shipmentReference || null,
            proNumberNormalized: normalizedProNumber || null,
            expectedFormat: "^\\d{6}$",
            lastKnownLoadNumber: lastKnownLoadNumber,
            decision: "NO_LOAD_NUMBER",
            reason: loadGateReason ||
              "Could not resolve a Primus load from broker or carrier refs",
          },
        });
      } else {
        aiResult.loadNumber = normalizedLoadNumber;
        if (loadResolvedFrom) {
          aiResult.loadNumberSource = aiResult.loadNumberSource ||
            `primus_${loadResolvedFrom.via}`;
        }

        if (!isTai) {
          const fullyBilled =
            await isInvoiceFullyBilledAndInvoicedInPrimus(aiResult);
          if (fullyBilled) {
            await writeLog("info", "primus",
                "Skipping already-billed and invoiced load", {
                  messageId,
                  loadNumber: aiResult.loadNumber,
                  invoiceNumber: aiResult.invoiceNumber || null,
                  carrierName: aiResult.carrierName || null,
                  invoiceAmount: aiResult.invoiceAmount || null,
                });
            itemSummaries.push({
              loadNumber: aiResult.loadNumber,
              status: aiResult.status || null,
              finalStatus: "already_billed_skipped",
              invoiceId: null,
            });
            continue;
          }
        }
      }

      let hasUnrecognizedCharges =
        normalizedChargeData.unrecognizedCharges.length > 0;
      let hasChargesNeedProof =
        normalizedChargeData.chargesNeedProof.length > 0;
      // Set when unrecognized charges need the 4-option approval email
      // (sent after the invoice doc is created so buttons have an id).
      let pendingAdditionalCharge = null;
      let pendingXpoWeightCert = null;
      let chargeReconciliation = null;

      // XPO Imaging API — pull W&I certificate when not attached to email.
      if (!loadGateFailed && !aiResult.hasWeightInspectionCertificate) {
        pendingXpoWeightCert = await maybeFetchXpoWeightCert(
            messageId, aiResult);
      }

      // Claude sometimes sets status=charges_no_proof / unrecognized_charges
      // without listing any real charge rows (FedEx 264172 → "includes
      //  charges"). Treat hollow status as ready so we do not block.
      if (aiResult.status === "charges_no_proof" && !hasChargesNeedProof) {
        await writeLog("warn", "ai",
            "Ignoring hollow charges_no_proof status (no charge rows)", {
              messageId,
              loadNumber: aiResult.loadNumber,
              invoiceAmount: aiResult.invoiceAmount,
            });
        aiResult.status = "ready_for_primus_validation";
      }
      if (aiResult.status === "unrecognized_charges" &&
          !hasUnrecognizedCharges) {
        await writeLog("warn", "ai",
            "Ignoring hollow unrecognized_charges status (no charge rows)", {
              messageId,
              loadNumber: aiResult.loadNumber,
              invoiceAmount: aiResult.invoiceAmount,
            });
        aiResult.status = "ready_for_primus_validation";
      }
      // Amfast 174738: Claude returned unmatched_amount because BOL #266922
      // was not labeled as broker Load #. Load resolution already promoted
      // the BOL; amount matching belongs to Primus — never Lisa-dump as
      // "unexpected invoice status".
      if (aiResult.status === "unmatched_amount") {
        const coerced = loadResolution.coerceClassifierInvoiceStatus(
            aiResult.status);
        await writeLog("warn", "ai",
            "Coercing AI unmatched_amount to ready_for_primus_validation", {
              messageId,
              loadNumber: aiResult.loadNumber || null,
              invoiceAmount: aiResult.invoiceAmount,
              reason: aiResult.reason || null,
              coercedStatus: coerced,
            });
        aiResult.status = coerced;
      }

      // Extra charges must not stop processing when the invoice total is
      // within $10 of Primus OR at/under Primus's recorded carrier cost
      // (line items like appointment/corrected-bill are then just breakdown).
      if (!loadGateFailed && !isTai &&
          (hasUnrecognizedCharges || hasChargesNeedProof)) {
        chargeReconciliation = await reconcileUnrecognizedChargesWithPrimus(
            aiResult.loadNumber,
            aiResult.invoiceAmount,
            normalizedChargeData.unrecognizedCharges,
        );
        if (chargeReconciliation.override) {
          await writeLog("info", "primus",
              "Extra charges within Primus total — auto-approving", {
                messageId,
                loadNumber: aiResult.loadNumber,
                invoiceAmount: aiResult.invoiceAmount,
                vendorCost: chargeReconciliation.vendorCost,
                totalMatches: chargeReconciliation.totalMatches,
                invoiceAtOrUnderPrimus:
                  chargeReconciliation.invoiceAtOrUnderPrimus,
                chargesInPrimus: chargeReconciliation.chargesInPrimus,
                tolerance: chargeReconciliation.tolerance,
                ignoredSmall: chargeReconciliation.filtered ?
                  chargeReconciliation.filtered.ignorableSmall : [],
                alreadyInPrimus: chargeReconciliation.filtered ?
                  chargeReconciliation.filtered.alreadyInPrimus : [],
                clearedUnrecognized:
                  normalizedChargeData.unrecognizedCharges,
                clearedNeedProof: normalizedChargeData.chargesNeedProof,
              });
          normalizedChargeData.unrecognizedCharges = [];
          normalizedChargeData.chargesNeedProof = [];
          hasUnrecognizedCharges = false;
          hasChargesNeedProof = false;
          if (aiResult.status === "unrecognized_charges" ||
              aiResult.status === "charges_no_proof") {
            aiResult.status = "ready_for_primus_validation";
          }
        } else if (chargeReconciliation.filtered) {
          normalizedChargeData.unrecognizedCharges =
            chargeReconciliation.filtered.chargesForAction;
          hasUnrecognizedCharges =
            chargeReconciliation.filtered.chargesForAction.length > 0;
          if (chargeReconciliation.filtered.ignorableSmall.length > 0 ||
              chargeReconciliation.filtered.alreadyInPrimus.length > 0) {
            await writeLog("info", "primus",
                "Filtered extra charges before approval", {
                  messageId,
                  loadNumber: aiResult.loadNumber,
                  ignoredSmall: chargeReconciliation.filtered.ignorableSmall,
                  alreadyInPrimus:
                    chargeReconciliation.filtered.alreadyInPrimus,
                  chargesForApproval:
                    chargeReconciliation.filtered.chargesForAction,
                });
          }
        }
      }

      if (loadGateFailed) {
        // Stop execution: do not attempt Primus lookup or workflow.
      } else if (aiResult.status === "unrecognized_charges" ||
      hasUnrecognizedCharges) {
        // Accounting SOP: classify WHY the invoice exceeds the quote —
        // accessorial, weight/reweigh/inspection (fee wording, W&I
        // certificate, or freight mismatch vs Primus), or an unexplained
        // rate increase.
        let bookingForCharges = null;
        try {
          bookingForCharges = await fetchPrimusBooking(aiResult.loadNumber);
        } catch (_) {
          // Booking is optional here — classification degrades gracefully.
        }
        const freightMismatch = additionalCharges.detectFreightMismatch(
            aiResult.freightDetails, bookingForCharges);
        const chargeCategory =
          additionalCharges.classifyAdditionalChargeReason({
            charges: normalizedChargeData.unrecognizedCharges,
            hasCertificate: !!aiResult.hasWeightInspectionCertificate,
            freightMismatch,
          });
        const chargesTotal = additionalCharges.sumCharges(
            normalizedChargeData.unrecognizedCharges);
        const primusVendorCost = bookingForCharges &&
          bookingForCharges.vendor &&
          Number(bookingForCharges.vendor.cost) || null;

        if (chargeCategory ===
            additionalCharges.CHARGE_CATEGORY.RATE_INCREASE) {
          // Rate increase with no reason → draft a dispute for manual
          // submission (LTL portal / TL email) and track until resolved.
          finalStatus = "unrecognized_charges";
          const dispute = additionalCharges.buildDisputeEmailDraft({
            loadNumber: aiResult.loadNumber,
            carrierName: aiResult.carrierName,
            proNumber: aiResult.proNumber,
            invoiceNumber: aiResult.invoiceNumber,
            invoiceAmount: aiResult.invoiceAmount,
            expectedAmount: primusVendorCost,
            charges: normalizedChargeData.unrecognizedCharges,
            category: chargeCategory,
            freightMismatch,
            hasCertificate: !!aiResult.hasWeightInspectionCertificate,
            customerRate: customerRateFromBooking(bookingForCharges),
          });
          await saveOutboundEmail(
              additionalCharges.applyAdditionalChargeEmailCc({
                type: "carrier_dispute_draft",
                subject: dispute.subject,
                html: dispute.html,
              }));
          await additionalCharges.createFollowUp(db, {
            loadNumber: aiResult.loadNumber,
            carrierName: aiResult.carrierName,
            tenantId: tenant.tenantId,
            category: chargeCategory,
            charges: normalizedChargeData.unrecognizedCharges,
            chargesTotal,
            invoiceAmount: aiResult.invoiceAmount,
            status: additionalCharges.FOLLOW_UP_STATUS.DISPUTING,
            notes: "Dispute draft emailed for manual submission",
          });
          await writeLog("warn", "ai",
              "Unexplained rate increase — dispute draft generated", {
                messageId,
                loadNumber: aiResult.loadNumber,
                carrierName: aiResult.carrierName,
                invoiceAmount: aiResult.invoiceAmount,
                primusVendorCost,
                decision: "RATE_INCREASE_DISPUTE",
              });
        } else {
          // Accessorial or W&I → 4-option approval email to Sarah +
          // dispatcher after the invoice doc is created below.
          // For W&I, re-rate via Primus GET /rate with the invoice's
          // updated weight/class and compare to the carrier total ($10).
          let rateValidation = null;
          if (chargeCategory ===
              additionalCharges.CHARGE_CATEGORY.WEIGHT_INSPECTION) {
            try {
              rateValidation = await validateReweighRateWithPrimus({
                booking: bookingForCharges,
                invoiceFreight: aiResult.freightDetails,
                invoiceAmount: aiResult.invoiceAmount,
              });
              await writeLog("info", "primus",
                  "W&I Primus re-rate validation", {
                    messageId,
                    loadNumber: aiResult.loadNumber,
                    matched: rateValidation.matched,
                    ok: rateValidation.ok,
                    rateTotal: rateValidation.rateTotal,
                    invoiceAmount: rateValidation.invoiceAmount,
                    difference: rateValidation.difference,
                    quoteNumber: rateValidation.quoteNumber,
                    error: rateValidation.error,
                  });
            } catch (rateErr) {
              rateValidation = {
                attempted: true,
                ok: false,
                matched: false,
                tolerance: additionalCharges.RATE_MATCH_TOLERANCE,
                invoiceAmount: Number(aiResult.invoiceAmount) || null,
                rateTotal: null,
                difference: null,
                quoteNumber: null,
                error: rateErr.message || String(rateErr),
                freightInfo: null,
              };
            }
          }
          finalStatus = "additional_charge_pending_approval";
          pendingAdditionalCharge = {
            category: chargeCategory,
            charges: normalizedChargeData.unrecognizedCharges,
            chargesTotal,
            freightMismatch,
            hasCertificate: !!aiResult.hasWeightInspectionCertificate,
            primusVendorCost,
            booking: bookingForCharges,
            rateValidation,
            customerRate: customerRateFromBooking(bookingForCharges),
            excludedInPrimusCount: chargeReconciliation &&
              chargeReconciliation.filtered ?
              chargeReconciliation.filtered.alreadyInPrimus.length : 0,
          };
          await writeLog("warn", "ai",
              "Additional charge needs approval (4-option email)", {
                event: "AI decision - needs review",
                messageId: messageId,
                details: {
                  invoiceAmount: aiResult.invoiceAmount,
                  carrierName: aiResult.carrierName,
                  loadNumber: aiResult.loadNumber,
                  proNumber: aiResult.proNumber,
                  category: chargeCategory,
                  unrecognizedCharges:
                    normalizedChargeData.unrecognizedCharges,
                  freightMismatch: freightMismatch.mismatch ?
                    freightMismatch.details : null,
                  rateValidation: rateValidation ? {
                    matched: rateValidation.matched,
                    ok: rateValidation.ok,
                    rateTotal: rateValidation.rateTotal,
                    difference: rateValidation.difference,
                    quoteNumber: rateValidation.quoteNumber,
                    error: rateValidation.error,
                  } : null,
                  decision: "ADDITIONAL_CHARGE_PENDING_APPROVAL",
                },
              });
        }
      } else if (aiResult.status === "charges_no_proof" ||
      hasChargesNeedProof) {
        finalStatus = "charges_no_proof";
        const needProofLabel = normalizedChargeData.chargesNeedProof.length ?
          normalizedChargeData.chargesNeedProof
              .map((c) => c.type || c.label).filter(Boolean).join(" and ") :
          "extra";
        await forwardToHumanReview(
            gmail, messageId, subject, from,
            "Invoice has extra charges but supporting receipts are missing",
            `I received an invoice from ` +
            `${aiResult.carrierName || "this carrier"} for load ` +
            `${aiResult.loadNumber}. The invoice amount is ` +
            `$${aiResult.invoiceAmount}. The invoice includes ` +
            needProofLabel +
            ` charges but no supporting receipt or proof document was ` +
            `attached. Please request the missing proof from the carrier ` +
            `before approving this invoice.`,
            {
              department: "billing",
              extractedData: {
                "Carrier": aiResult.carrierName || "—",
                "Load Number": aiResult.loadNumber || "—",
                "Invoice Total": `$${aiResult.invoiceAmount}`,
                "Charges Missing Proof":
                  normalizedChargeData.chargesNeedProof.length ?
                    normalizedChargeData.chargesNeedProof
                        .map((c) => `${c.type || c.label}: $${c.amount}`)
                        .join(", ") :
                    "unspecified (AI flagged missing proof with no details)",
              },
            },
        );
        await writeLog("warn", "ai", "Charges need proof documentation", {
          event: "AI decision - needs review",
          messageId: messageId,
          details: {
            invoiceAmount: aiResult.invoiceAmount,
            carrierName: aiResult.carrierName,
            loadNumber: aiResult.loadNumber,
            proNumber: aiResult.proNumber,
            chargesNeedProof: normalizedChargeData.chargesNeedProof,
            reason: "Extra charges present with no proof of delivery",
            decision: "CHARGES_NO_PROOF",
            reviewRequired: true,
          },
        });
      } else if (aiResult.status === "ready_for_primus_validation" && isTai) {
        // ── TAI tenant ───────────────────────────────────────────────────
        // All shipment/amount validation for TAI happens inside
        // processTaiWorkflow (it resolves the shipmentId from the webhook
        // index, validates the amount, adds the PRO, etc.). We skip the
        // Primus-specific pre-checks here and simply mark the invoice ready
        // so it is created and routed to the TAI workflow below.
        finalStatus = "processing";
        await writeLog("info", "tai",
            "TAI tenant — deferring validation to TAI workflow", {
              messageId,
              loadNumber: aiResult.loadNumber,
              proNumber: aiResult.proNumber,
            });
      } else if (aiResult.status === "ready_for_primus_validation") {
        // ── Primus shipment lookup (stub) ──────────────────────────────────
        const primusData = await getPrimusShipment(
            aiResult.loadNumber, aiResult.proNumber,
        );

        // Lumper: subtract lumper from invoice before Primus compare.
        let primusValidationAmount = aiResult.invoiceAmount;
        if (normalizedChargeData.recognizedCharges &&
            normalizedChargeData.recognizedCharges.length > 0) {
          const lumperValidation = additionalCharges.validateLumperAmount(
              aiResult, primusData.vendorCost,
          );
          if (lumperValidation.totalLumper > 0 &&
              !lumperValidation.totalMatchesPrimus) {
            primusValidationAmount = lumperValidation.baseAmount;
          }
          await writeLog("info", "ai", "Lumper validation result", {
            messageId,
            baseAmount: lumperValidation.baseAmount,
            totalLumper: lumperValidation.totalLumper,
            primusValidationAmount,
            difference: lumperValidation.difference,
            valid: lumperValidation.valid,
          });

          // If lumpers are present but the base amount still doesn't match
          // the Primus carrier cost, flag for billing — better than a
          // generic mismatch message.
          if (primusData.vendorCost && lumperValidation.totalLumper > 0 &&
              !lumperValidation.valid) {
            await forwardToHumanReview(
                gmail, messageId, subject, from,
                "Lumper charges do not reconcile with Primus carrier cost",
                `The carrier invoice includes ` +
                `$${lumperValidation.totalLumper.toFixed(2)} in lumper ` +
                `charges. After removing them the base freight charge is ` +
                `$${lumperValidation.baseAmount.toFixed(2)}, but the Primus ` +
                `carrier cost on file is $${primusData.vendorCost}. ` +
                `Please verify the lumper receipts and correct the amounts.`,
                {
                  department: "billing",
                  extractedData: {
                    "Carrier": aiResult.carrierName || "—",
                    "Load Number": aiResult.loadNumber || "—",
                    "Invoice Total": `$${aiResult.invoiceAmount}`,
                    "Lumper Charges":
                        `$${lumperValidation.totalLumper.toFixed(2)}`,
                    "Base Freight":
                        `$${lumperValidation.baseAmount.toFixed(2)}`,
                    "Primus Carrier Cost": `$${primusData.vendorCost}`,
                    "Discrepancy": `$${lumperValidation.difference.toFixed(2)}`,
                  },
                  emailBody,
                },
            );
            finalStatus = "unmatched_amount";
          }
        }

        // ── Profit / margin check (use lumper-adjusted amount) ───────────────
        if (primusData.rate) {
          const profitCheck = checkProfitMargin(
              primusData.rate, primusValidationAmount);
          if (profitCheck.noRate || profitCheck.lowProfit) {
            const hasLumpers =
                primusValidationAmount !== aiResult.invoiceAmount;
            try {
              await notifyDispatcherLowProfit({
                loadNumber: aiResult.loadNumber,
                carrierName: aiResult.carrierName,
                invoiceAmount: aiResult.invoiceAmount,
                customerRate: primusData.rate,
                profit: profitCheck.profit,
                messageId,
              });
            } catch (notifyErr) {
              await writeLog("error", "email",
                  "Failed to notify dispatcher of low profit", {
                    messageId,
                    loadNumber: aiResult.loadNumber,
                    error: notifyErr.message,
                  });
              // Fallback: keep ops informed if dispatcher notify fails.
              await forwardToHumanReview(
                  gmail, messageId, subject, from,
                  "Invoice profit is below the minimum threshold",
                  `I processed the invoice from ` +
                  `${aiResult.carrierName || "this carrier"} for load ` +
                  `${aiResult.loadNumber}. The calculated profit is ` +
                  `$${profitCheck.profit.toFixed(2)}, which is below the ` +
                  `$10 minimum. ` +
                  `Please review the customer rate or authorize an ` +
                  `exception. (Dispatcher notify failed: ` +
                  `${notifyErr.message})`,
                  {
                    department: "billing",
                    extractedData: {
                      "Carrier": aiResult.carrierName || "—",
                      "Load Number": aiResult.loadNumber || "—",
                      "Invoice Amount": `$${aiResult.invoiceAmount}`,
                      ...(hasLumpers ? {
                        "Lumper-Adjusted Amount":
                          `$${primusValidationAmount}`,
                      } : {}),
                      "Customer Rate": `$${primusData.rate}`,
                      "Profit": `$${profitCheck.profit.toFixed(2)}`,
                    },
                  },
              );
            }
            finalStatus = "no_rate";
          }
        }

        // Only run Primus validation if earlier checks didn't already
        // reject this invoice
        if (finalStatus !== "no_rate" && finalStatus !== "unmatched_amount") {
          await writeLog("info", "primus", `Starting Primus validation`, {
            messageId: messageId,
            proNumber: aiResult.proNumber,
            loadNumber: aiResult.loadNumber,
            invoiceAmount: aiResult.invoiceAmount,
          });

          primusResult = await validateAmountWithPrimus(
              aiResult.loadNumber,
              primusValidationAmount,
          );

          await writeLog("info", "primus", "Primus validation completed", {
            event: "Primus validation completed",
            messageId: messageId,
            details: {
              submittedAmount: primusValidationAmount,
              savedAmount: primusResult.amount,
              difference: primusResult.amount ?
                Math.abs(aiResult.invoiceAmount - primusResult.amount) :
                null,
              result: primusResult.validAmount ? "MATCH" : "MISMATCH",
              ok: primusResult.ok,
              validAmount: primusResult.validAmount,
              reason: primusResult.reason,
            },
          });

          if (primusResult.ok === true && primusResult.validAmount === true) {
            finalStatus = "processing";
            await writeLog("info", "mail", `Invoice queued for workflow`, {
              messageId: messageId,
              primusAmount: primusResult.amount,
            });
          } else if (primusResult.ok === false &&
                 primusResult.reason &&
                 primusResult.reason.toLowerCase().includes("not found")) {
            finalStatus = "not_found";
            await writeLog("warn", "primus", "Shipment not found in Primus", {
              event: "Primus validation failed",
              messageId: messageId,
              details: {
                submittedAmount: aiResult.invoiceAmount,
                loadNumber: aiResult.loadNumber,
                proNumber: aiResult.proNumber,
                result: "NOT_FOUND",
                reason: primusResult.reason,
                decision: "NOT_FOUND",
              },
            });
            await forwardToHumanReview(
                gmail, messageId, subject, from,
                "Shipment not found — cannot validate invoice",
                `I looked up load ${aiResult.loadNumber} but could not ` +
                `find a matching shipment. The invoice cannot be processed ` +
                `until the load number is confirmed or corrected.`,
                {
                  department: "operations",
                  extractedData: {
                    "Carrier": aiResult.carrierName || "—",
                    "Load Number": aiResult.loadNumber || "—",
                    "PRO Number": aiResult.proNumber || "—",
                    "Invoice Amount": `$${aiResult.invoiceAmount}`,
                  },
                  emailBody,
                },
            );
          } else {
            finalStatus = "unmatched_amount";
            await writeLog("warn", "primus", "Primus validation failed", {
              event: "Primus validation failed",
              messageId: messageId,
              details: {
                submittedAmount: aiResult.invoiceAmount,
                savedAmount: primusResult.amount,
                difference: primusResult.amount ?
                  Math.abs(aiResult.invoiceAmount - primusResult.amount) :
                  null,
                result: "MISMATCH",
                reason: primusResult.reason || "Amount does not match Primus",
                decision: "UNMATCHED_AMOUNT",
              },
            });
            await forwardToHumanReview(
                gmail, messageId, subject, from,
                "Invoice amount does not match the shipment rate",
                `The carrier invoiced $${aiResult.invoiceAmount} but the ` +
                `amount on file does not match. ` +
                (primusResult.amount ?
                  `Expected: $${primusResult.amount}. ` : "") +
                `Please verify the correct amount and update the shipment.`,
                {
                  department: "billing",
                  extractedData: {
                    "Carrier": aiResult.carrierName || "—",
                    "Load Number": aiResult.loadNumber || "—",
                    "Invoice Amount": `$${aiResult.invoiceAmount}`,
                    "Expected Amount": primusResult.amount ?
                      `$${primusResult.amount}` : "—",
                    "Difference": primusResult.amount ?
                      `$${Math.abs(aiResult.invoiceAmount -
                        primusResult.amount).toFixed(2)}` : "—",
                  },
                  emailBody,
                },
            );
          }
        }
      } else {
        // Claude returned a status we don't have a rule for (e.g. "error").
        // unmatched_amount is coerced to ready_for_primus_validation above.
        // Forward with AI note so a human can handle it, and label ERROR.
        finalStatus = "error";
        await writeLog("warn", "ai", "Unexpected AI classification status", {
          messageId, status: aiResult.status,
        });
        await forwardWithAnalysis(
            `AI returned an unexpected invoice status: ${aiResult.status}`,
            {department: "general", emailBody},
        );
      }

      const isPendingChargeApproval =
          finalStatus === "additional_charge_pending_approval" &&
          !!pendingAdditionalCharge;
      const shouldCreateInvoice = aiResult.status !== "error" &&
          aiResult.invoiceAmount > 0 &&
          (finalStatus === "processing" || isPendingChargeApproval);
      if (shouldCreateInvoice) {
        await writeLog("info", "mail", `Creating invoice document`, {
          messageId: messageId,
          invoiceAmount: aiResult.invoiceAmount,
          carrierName: aiResult.carrierName,
          proNumber: aiResult.proNumber,
          loadNumber: aiResult.loadNumber,
        });

        const preferredName =
            String(aiResult.attachmentFilename || "").trim();
        let invoiceAttachments = storedAttachments.map((att) => ({
          filename: att.filename,
          storagePath: att.storagePath,
          mimeType: att.mimeType,
          docType: att.docType,
          scopedFrom: att.scopedFrom || null,
          scopedFromStoragePath: att.scopedFromStoragePath || null,
        }));
        // Drop the unsliced multi-invoice packet when we could not isolate
        // this load's pages — never upload sibling FedEx bills to Primus.
        if (aiResult.blockUnscopedMultiInvoicePacket) {
          const packetName = String(
              aiResult.unscopedPacketFilename || "").trim();
          invoiceAttachments = invoiceAttachments.filter((a) => {
            if (/WEIGHT_INSPECTION_CERT/i.test(String(a.docType || ""))) {
              return true;
            }
            if (a.scopedFrom) return true;
            if (packetName &&
                podUtils.attachmentFilenamesMatch(a.filename, packetName)) {
              return false;
            }
            return true;
          });
        }
        const loadAtt = podUtils.findInvoiceAttachment(invoiceAttachments, {
          proNumber: aiResult.proNumber,
          attachmentFilename: preferredName,
        });
        if (loadAtt && aiResult.proNumber) {
          invoiceAttachments = invoiceAttachments.filter((a) => {
            if (/WEIGHT_INSPECTION_CERT/i.test(String(a.docType || ""))) {
              return true;
            }
            return podUtils.attachmentFilenamesMatch(
                a.filename, loadAtt.filename);
          });
        } else if (preferredName) {
          const preferred = invoiceAttachments.filter((a) =>
            podUtils.attachmentFilenamesMatch(a.filename, preferredName));
          const rest = invoiceAttachments.filter((a) =>
            !podUtils.attachmentFilenamesMatch(a.filename, preferredName));
          if (preferred.length) {
            // Prefer the scoped per-load PDF; keep sidecars after it.
            invoiceAttachments = preferred.concat(rest.filter((a) =>
              a.scopedFrom ||
              /WEIGHT_INSPECTION_CERT|POD/i.test(String(a.docType || ""))));
          }
        }
        if (pendingXpoWeightCert && pendingXpoWeightCert.storagePath) {
          invoiceAttachments.push({
            filename: pendingXpoWeightCert.filename,
            storagePath: pendingXpoWeightCert.storagePath,
            mimeType: pendingXpoWeightCert.mimeType || "application/pdf",
            docType: pendingXpoWeightCert.docType || "WEIGHT_INSPECTION_CERT",
          });
        }

        let decisionStage = isTai ?
          "pending_tai_check" : "pending_primus_check";
        let matchStatus = "not_checked";
        let reviewStatus = "not_needed";
        let decisionReason = isTai ?
          "Waiting for TAI lookup." : "Waiting for Primus lookup.";
        let primusAmount = null;
        let amountDifference = null;

        if (isPendingChargeApproval) {
          decisionStage = "additional_charge_pending_approval";
          reviewStatus = "needed";
          decisionReason = "Additional charge awaiting A/B/C/D decision.";
        }

        if (primusResult && primusResult.ok && primusResult.validAmount) {
          primusAmount = Number(primusResult.amount || 0);
          amountDifference = Math.abs(aiResult.invoiceAmount - primusAmount);

          if (amountDifference <= 5) {
            decisionStage = "amount_matched";
            matchStatus = "matched";
            decisionReason = "Invoice matches Primus amount.";
          } else {
            decisionStage = "needs_charge_review";
            reviewStatus = "needed";
            decisionReason = "Difference is more than $5.";
          }
        } else if (primusResult && primusResult.ok === false &&
               primusResult.reason &&
               primusResult.reason.toLowerCase().includes("not found")) {
          decisionStage = "shipment_not_found";
          matchStatus = "not_found";
          reviewStatus = "needed";
          decisionReason = "Shipment not found in Primus system.";
        }

        const flowId = messageId;
        const invoiceDoc = await tcol(tenant, "invoices").add({
          tenantId: tenant.tenantId,
          tms: tenant.tms,
          carrierName: aiResult.carrierName || null,
          invoiceNumber: aiResult.invoiceNumber || null,
          proNumber: aiResult.proNumber || null,
          carrierBolNumber: aiResult.carrierBolNumber || null,
          carrierOrderNumber: aiResult.carrierOrderNumber || null,
          poNumber: aiResult.poNumber || null,
          shipmentReference: aiResult.shipmentReference || null,
          loadNumber: aiResult.loadNumber || null,
          invoiceAmount: aiResult.invoiceAmount,
          invoiceDate: aiResult.invoiceDate || null,
          dueDate: aiResult.dueDate || null,
          charges: aiResult.charges || [],
          recognizedCharges: normalizedChargeData.recognizedCharges,
          unrecognizedCharges: normalizedChargeData.unrecognizedCharges,
          chargesNeedProof: normalizedChargeData.chargesNeedProof,
          chargeProofRefs: normalizedChargeData.chargeProofRefs,
          approvedChargeProofFiles: [],
          freightDetails: aiResult.freightDetails || null,
          hasWeightInspectionCertificate:
            !!aiResult.hasWeightInspectionCertificate,
          weightInspectionCertificate: pendingXpoWeightCert ? {
            source: pendingXpoWeightCert.source,
            storagePath: pendingXpoWeightCert.storagePath,
            filename: pendingXpoWeightCert.filename,
            proNumber: pendingXpoWeightCert.proNumber || null,
            imageType: pendingXpoWeightCert.imageType || null,
          } : null,
          customerRate: isPendingChargeApproval && pendingAdditionalCharge ?
            (pendingAdditionalCharge.customerRate || null) :
            (aiResult.customerRate != null ? aiResult.customerRate : null),
          drayageLeoValidated: !!aiResult.drayageLeoValidated,
          leoDrayageInstructions: aiResult.leoDrayageInstructions || null,
          containerNumber: aiResult.containerNumber || null,
          additionalCharge: isPendingChargeApproval ? {
            status: "pending_approval",
            source: "unrecognized_charges",
            category: pendingAdditionalCharge.category,
            charges: pendingAdditionalCharge.charges,
            amount: pendingAdditionalCharge.chargesTotal,
            freightMismatch: pendingAdditionalCharge.freightMismatch,
            hasCertificate: pendingAdditionalCharge.hasCertificate,
            rateValidation: pendingAdditionalCharge.rateValidation || null,
            approved: false,
            decision: null,
          } : null,
          attachments: invoiceAttachments,
          pod: normalizedPod || {
            found: false,
            source: "",
            attachmentFilename: "",
            page: "",
            reason: "",
          },
          podOnlyFile: pendingImagePodFile || null,
          podOnlyFiles: pendingImagePodFile ? [pendingImagePodFile] : [],
          brokerCommissionFlag: false,
          lumperValidation: null,
          status: "received",
          matchStatus: matchStatus,
          reviewStatus: reviewStatus,
          decisionStage: decisionStage,
          primusLoadId: aiResult.loadNumber || null,
          primusAmount: primusAmount,
          amountDifference: amountDifference,
          decisionReason: decisionReason,
          gmailMessageId: messageId,
          gmailSubject: subject,
          gmailFrom: from,
          flowId: flowId,
          workflowPausedAtStep: null,
          processingLock: false,
          processingStartedAt: null,
          lastHeartbeatAt: null,
          currentStep: null,
          finalWorkflowStatus: isPendingChargeApproval ?
            "additional_charge_pending_approval" : "created",
          primusSteps: {
            amountValidated: false,
            proAdded: false,
            shipmentDelivered: false,
            customerRateChecked: false,
            billApproved: false,
            customerInvoiceGenerated: false,
            uiInvoiceIssued: false,
            carrierBillUploaded: false,
            podUploaded: false,
            qbBillingSynced: false,
          },
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          deleteAt: getDeleteAt(7),
        });

        await logWorkflowStep({
          invoiceId: invoiceDoc.id,
          gmailMessageId: messageId,
          stepName: "inbox_poll_started",
          stepStatus: "success",
          input: {messageId: messageId, subject: subject},
          output: {invoiceId: invoiceDoc.id},
          tenant,
        });

        await logWorkflowStep({
          invoiceId: invoiceDoc.id,
          stepName: "invoice_created",
          stepStatus: "success",
          output: {invoiceId: invoiceDoc.id},
          tenant,
        });

        await writeLog("info", "mail", `Invoice document created`, {
          messageId: messageId,
          invoiceId: invoiceDoc.id,
          decisionStage: decisionStage,
          matchStatus: matchStatus,
        });

        if (isPendingChargeApproval) {
          // Send A/B/C/D approval email, then still start Primus so carrier
          // bill + POD upload before the workflow pauses at the charge gate.
          await sendAdditionalChargeApprovalEmail({
            invoiceId: invoiceDoc.id,
            tenant,
            aiResult,
            pending: pendingAdditionalCharge,
            invoiceAttachments,
          });
          await writeLog(
              "info",
              "workflow",
              `Starting ${tenant.tms} workflow for paperwork upload ` +
              `(additional charge pending approval)`,
              {
                messageId: messageId,
                invoiceId: invoiceDoc.id,
                tms: tenant.tms,
                tenantId: tenant.tenantId,
              },
          );
          try {
            const workflowUrl = workflowUrlForTenant(tenant);
            if (!workflowUrl) {
              throw new Error(
                  `No workflow endpoint for tenant ${tenant.tenantId} ` +
                  `(tms=${tenant.tms || "none"}); refusing to default to ` +
                  `Primus`);
            }
            const workflowRes = await fetch(
                workflowUrl,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    invoiceId: invoiceDoc.id,
                    tenantId: tenant.tenantId,
                  }),
                },
            );
            if (!workflowRes.ok) {
              const text = await workflowRes.text();
              await writeLog(
                  "error",
                  "workflow",
                  `Failed to start ${tenant.tms} workflow ` +
                  `(pending additional charge)`,
                  {
                    messageId: messageId,
                    invoiceId: invoiceDoc.id,
                    status: workflowRes.status,
                    response: text,
                  },
              );
            }
          } catch (wfErr) {
            await writeLog(
                "error",
                "workflow",
                `Error starting ${tenant.tms} workflow ` +
                `(pending additional charge)`,
                {
                  messageId: messageId,
                  invoiceId: invoiceDoc.id,
                  error: wfErr.message || String(wfErr),
                },
            );
          }
        } else {
          await writeLog(
              "info",
              "workflow",
              `Starting ${tenant.tms} workflow for new invoice`,
              {
                messageId: messageId,
                invoiceId: invoiceDoc.id,
                tms: tenant.tms,
                tenantId: tenant.tenantId,
              },
          );

          try {
            const workflowUrl = workflowUrlForTenant(tenant);
            if (!workflowUrl) {
              throw new Error(
                  `No workflow endpoint for tenant ${tenant.tenantId} ` +
                  `(tms=${tenant.tms || "none"}); refusing to default to ` +
                  `Primus`);
            }
            const workflowRes = await fetch(
                workflowUrl,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    invoiceId: invoiceDoc.id,
                    tenantId: tenant.tenantId,
                  }),
                },
            );

            if (!workflowRes.ok) {
              const text = await workflowRes.text();
              await writeLog(
                  "error",
                  "workflow",
                  `Failed to start ${tenant.tms} workflow`,
                  {
                    messageId: messageId,
                    invoiceId: invoiceDoc.id,
                    status: workflowRes.status,
                    response: text,
                  },
              );
            }
          } catch (workflowError) {
            await writeLog(
                "error",
                "workflow",
                `Failed to start ${tenant.tms} workflow`,
                {
                  messageId: messageId,
                  invoiceId: invoiceDoc.id,
                  error: workflowError.message,
                },
            );
          }
        }

        createdInvoiceIds.push(invoiceDoc.id);
        console.log(`Created invoice document from email ${messageId}`);
      } else {
        await writeLog(
            "warn",
            "mail",
            `Skipping invoice creation due to AI error or zero amount`,
            {
              messageId: messageId,
              aiStatus: aiResult.status,
              invoiceAmount: aiResult.invoiceAmount,
            },
        );
      }


      itemSummaries.push({
        loadNumber: aiResult.loadNumber || null,
        status: aiResult.status || null,
        finalStatus: finalStatus,
        invoiceId: createdInvoiceIds.length > invoiceIdsBefore ?
          createdInvoiceIds[createdInvoiceIds.length - 1] : null,
      });
      lastPrimusResult = primusResult;
      if (finalStatus === "processing") {
        overallFinalStatus = "processing";
      } else if (overallFinalStatus === "error" && finalStatus) {
        overallFinalStatus = finalStatus;
      }
    }

    if (invoiceItems.length > 0 && createdInvoiceIds.length === 0 &&
        itemSummaries.length > 0 &&
        itemSummaries.every(
            (s) => s.finalStatus === "already_billed_skipped")) {
      overallFinalStatus = "already_billed_skipped";
    }

    const stmtUnderExtracted =
        !isChildSplitJob &&
        statementInvoiceBundle.shouldAlertStatementUnderExtraction(
            statementExtractionGap);

    await emailIntakeRef.set({
      primusResult: lastPrimusResult,
      finalStatus: stmtUnderExtracted ?
        "statement_under_extracted" : overallFinalStatus,
      invoiceIds: createdInvoiceIds,
      itemSummaries: itemSummaries,
      statementExtractionGap: stmtUnderExtracted ?
        statementExtractionGap : null,
      status: "processed",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});

    const finalStatus = stmtUnderExtracted ?
      "statement_under_extracted" : overallFinalStatus;

    await writeLog("info", "mail", `Email processing completed`, {
      messageId: messageId,
      finalStatus: finalStatus,
    });

    scheduleFlowSummary(messageId).catch((err) => {
      console.warn("scheduleFlowSummary after gmail:", err.message);
    });

    const completionExtra = {
      primusResult: lastPrimusResult,
      finalStatus: stmtUnderExtracted ?
        "statement_under_extracted" : overallFinalStatus,
      invoiceIds: createdInvoiceIds,
      itemSummaries,
      statementExtractionGap: stmtUnderExtracted ?
        statementExtractionGap : null,
    };
    if (isChildSplitJob && itemSummaries.length > 0) {
      await mailIntakeQueue.completeIntakeRecord({
        tenant,
        docId: queueDocId,
        parentMessageId,
        outcome: mailIntakeQueue.OUTCOME.PROCESSED,
        finalStatus: overallFinalStatus,
        itemSummary: Object.assign(
            {itemIndex: childItemIndex},
            itemSummaries[0] || {},
        ),
        extra: completionExtra,
      });
    } else {
      await mailIntakeQueue.completeIntakeRecord({
        tenant,
        docId: queueDocId,
        parentMessageId,
        outcome: stmtUnderExtracted ?
          mailIntakeQueue.OUTCOME.PARTIAL :
          mailIntakeQueue.OUTCOME.PROCESSED,
        finalStatus: stmtUnderExtracted ?
          "statement_under_extracted" :
          overallFinalStatus,
        itemSummaries,
        extra: completionExtra,
      });
    }
  } catch (error) {
    await mailIntakeQueue.failIntakeRecord(tenant, queueDocId, error.message);
    throw error;
  }
}

/**
 * Downloads a single Gmail attachment and returns its decoded bytes.
 * @param {object} gmail Gmail client instance.
 * @param {string} messageId Gmail message id.
 * @param {string} attachmentId Gmail attachment id.
 * @return {Promise<Buffer>} Decoded attachment bytes.
 */
async function downloadGmailAttachmentBuffer(gmail, messageId, attachmentId) {
  const resp = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });
  const rawData = (resp.data && resp.data.data) || "";
  return Buffer.from(
      rawData.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Decodes Gmail-style base64url (or standard base64) into a Buffer.
 * @param {string} data Encoded payload.
 * @return {Buffer} Decoded bytes.
 */
function decodeGmailBase64(data) {
  return Buffer.from(
      String(data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Matches Content-Disposition / Content-Type filename headers in MIME. */
const MIME_FILENAME_RE = new RegExp(
    "filename\\*\\s*=\\s*UTF-8''([^;\\r\\n]+)|" +
    "filename\\s*=\\s*\"?([^\";\\r\\n]+)\"?",
    "i",
);

/**
 * Extracts PDF files buried inside a raw MIME / .eml buffer.
 * Needed for Outlook "FW:" emails where Gmail leaves the original message
 * as an unexpanded message/rfc822 blob instead of listing nested parts.
 * @param {Buffer} mimeBuffer Raw RFC822 / multipart bytes.
 * @return {Array<object>} Nested PDF attachments with filename/mimeType/buffer.
 */
function extractPdfAttachmentsFromMime(mimeBuffer) {
  const found = [];
  if (!mimeBuffer || !mimeBuffer.length) return found;

  const walk = (content, boundary) => {
    if (!content) return;
    const delimiter = `--${boundary}`;
    const chunks = content.split(delimiter);
    for (const chunk of chunks) {
      const trimmed = chunk.replace(/^\r?\n/, "").replace(/--\s*$/, "");
      if (!trimmed || trimmed === "--") continue;
      const headerBreak = trimmed.search(/\r?\n\r?\n/);
      if (headerBreak < 0) continue;
      const headers = trimmed.slice(0, headerBreak);
      let body = trimmed.slice(headerBreak +
        (trimmed[headerBreak] === "\r" ? 4 : 2));
      body = body.replace(/\r?\n$/, "");

      const nestedBoundaryMatch =
        headers.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i);
      if (nestedBoundaryMatch) {
        walk(body, nestedBoundaryMatch[1].trim());
        continue;
      }

      const typeMatch = headers.match(/Content-Type:\s*([^\s;]+)/i);
      const mimeType = typeMatch ? typeMatch[1].toLowerCase() : "";
      const nameMatch = headers.match(MIME_FILENAME_RE);
      const filename = decodeURIComponent(
          String((nameMatch && (nameMatch[1] || nameMatch[2])) || "").trim(),
      );
      const isBase64 = /Content-Transfer-Encoding:\s*base64/i.test(headers);

      if (mimeType.includes("message/rfc822") ||
          filename.toLowerCase().endsWith(".eml")) {
        const nestedBuf = isBase64 ?
          Buffer.from(body.replace(/\s+/g, ""), "base64") :
          Buffer.from(body, "binary");
        found.push(...extractPdfAttachmentsFromMime(nestedBuf));
        continue;
      }

      const looksPdf = mimeType.includes("application/pdf") ||
        filename.toLowerCase().endsWith(".pdf");
      if (!looksPdf) continue;

      let pdfBuf = isBase64 ?
        Buffer.from(body.replace(/\s+/g, ""), "base64") :
        Buffer.from(body, "binary");
      // Trim trailing MIME epilogue noise after %%EOF when present.
      const eofIdx = pdfBuf.lastIndexOf(Buffer.from("%%EOF"));
      if (eofIdx > 0 && eofIdx + 5 < pdfBuf.length) {
        pdfBuf = pdfBuf.subarray(0, eofIdx + 5);
      }
      if (!isPdfMagicBytes(pdfBuf)) continue;
      found.push({
        filename: filename || `nested-invoice-${found.length + 1}.pdf`,
        mimeType: "application/pdf",
        buffer: pdfBuf,
        fromNestedMime: true,
      });
    }
  };

  const raw = mimeBuffer.toString("binary");
  const topBoundary = raw.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i);
  if (topBoundary) {
    walk(raw, topBoundary[1].trim());
  } else if (isPdfMagicBytes(mimeBuffer)) {
    found.push({
      filename: "attachment.pdf",
      mimeType: "application/pdf",
      buffer: mimeBuffer,
      fromNestedMime: true,
    });
  } else {
    // Single-part RFC822 with a PDF payload and no multipart boundary.
    const typeMatch = raw.slice(0, 4000).match(/Content-Type:\s*([^\s;]+)/i);
    const mimeType = typeMatch ? typeMatch[1].toLowerCase() : "";
    if (mimeType.includes("application/pdf") ||
        /\.pdf["'\s]/i.test(raw.slice(0, 4000))) {
      const headerBreak = raw.search(/\r?\n\r?\n/);
      if (headerBreak >= 0) {
        const headers = raw.slice(0, headerBreak);
        const body = raw.slice(headerBreak).replace(/^\r?\n\r?\n/, "");
        const isBase64 = /Content-Transfer-Encoding:\s*base64/i.test(headers);
        const pdfBuf = isBase64 ?
          Buffer.from(body.replace(/\s+/g, ""), "base64") :
          Buffer.from(body, "binary");
        if (isPdfMagicBytes(pdfBuf)) {
          const nameMatch = headers.match(MIME_FILENAME_RE);
          found.push({
            filename: decodeURIComponent(
                String((nameMatch && (nameMatch[1] || nameMatch[2])) ||
                  "attachment.pdf").trim()) || "attachment.pdf",
            mimeType: "application/pdf",
            buffer: pdfBuf,
            fromNestedMime: true,
          });
        }
      }
    }
  }

  return found;
}

/**
 * Recursively extracts attachments from Gmail message parts.
 * Also captures root-level attachments, inline body.data payloads, and
 * unexpanded message/rfc822 wrappers (common on Outlook forwards).
 * @param {Array<object>} parts Gmail message parts.
 * @return {Array<object>} Array of attachment objects.
 */
function extractAttachmentsRecursive(parts) {
  const attachments = [];

  if (!parts || !Array.isArray(parts)) {
    return attachments;
  }

  for (const part of parts) {
    const filename = String(part.filename || "").trim();
    const mimeType = String(part.mimeType || "");
    const hasBytes = Boolean(part.body &&
      (part.body.attachmentId || part.body.data));
    const isRfc822 = /message\/rfc822/i.test(mimeType);
    const isEml = /\.eml$/i.test(filename);

    if (hasBytes && (filename || isRfc822)) {
      attachments.push({
        filename: filename ||
          (isRfc822 ? "forwarded-message.eml" : "attachment"),
        mimeType: mimeType || "application/octet-stream",
        attachmentId: part.body.attachmentId || null,
        inlineData: part.body.data || null,
        unwrap: isRfc822 || isEml,
      });
    }

    if (part.parts && Array.isArray(part.parts)) {
      attachments.push(...extractAttachmentsRecursive(part.parts));
    }
  }

  return attachments;
}

/**
 * Collects every attachment from a Gmail payload, including the root part.
 * @param {object} payload Gmail message payload.
 * @return {Array<object>} Attachment metadata list.
 */
function collectMessageAttachments(payload) {
  if (!payload || typeof payload !== "object") return [];
  const rootParts = [];
  if (payload.filename ||
      (payload.body && (payload.body.attachmentId || payload.body.data) &&
        /message\/rfc822/i.test(String(payload.mimeType || "")))) {
    rootParts.push(payload);
  }
  if (Array.isArray(payload.parts)) {
    rootParts.push(...payload.parts);
  }
  return extractAttachmentsRecursive(rootParts);
}

/**
 * Resolves attachment bytes from Gmail (attachmentId, inline data, or buffer).
 * @param {object} gmail Gmail client.
 * @param {string} messageId Message id.
 * @param {object} attachment Attachment metadata.
 * @return {Promise<Buffer|null>} Decoded bytes.
 */
async function resolveAttachmentBuffer(gmail, messageId, attachment) {
  if (attachment && Buffer.isBuffer(attachment.buffer)) {
    return attachment.buffer;
  }
  if (attachment && attachment.inlineData) {
    return decodeGmailBase64(attachment.inlineData);
  }
  if (attachment && attachment.attachmentId) {
    return downloadGmailAttachmentBuffer(
        gmail, messageId, attachment.attachmentId);
  }
  return null;
}

/**
 * Expands .eml / message/rfc822 wrappers into nested PDF attachments.
 * @param {object} gmail Gmail client.
 * @param {string} messageId Message id.
 * @param {Array<object>} attachments Collected attachment metadata.
 * @return {Promise<Array<object>>} Attachments plus any nested PDFs.
 */
async function expandNestedEmailAttachments(gmail, messageId, attachments) {
  const expanded = [];
  const seen = new Set();

  const pushUnique = (att) => {
    const key = `${att.filename}|${
      att.attachmentId || (att.buffer && att.buffer.length) ||
      (att.inlineData && att.inlineData.length) || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    expanded.push(att);
  };

  for (const att of (attachments || [])) {
    pushUnique(att);
    if (!(att && att.unwrap)) continue;
    try {
      const buf = await resolveAttachmentBuffer(gmail, messageId, att);
      if (!buf || !buf.length) continue;
      const nestedPdfs = extractPdfAttachmentsFromMime(buf);
      for (const nested of nestedPdfs) {
        pushUnique(nested);
      }
    } catch (err) {
      // Keep going — missing unwrap must not abort the rest of the email.
      console.warn(
          `[expandNestedEmailAttachments] Failed to unwrap ` +
          `${att.filename}: ${err.message}`);
    }
  }

  return expanded;
}

/**
 * Last-resort: download the full raw MIME and pull any PDF parts from it.
 * @param {object} gmail Gmail client.
 * @param {string} messageId Message id.
 * @return {Promise<Array<object>>} Nested PDF attachments.
 */
async function extractPdfsFromRawMessage(gmail, messageId) {
  const rawMsg = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "raw",
  });
  const raw = (rawMsg.data && rawMsg.data.raw) || "";
  if (!raw) return [];
  return extractPdfAttachmentsFromMime(decodeGmailBase64(raw));
}
exports.gmailConnect = onRequest({invoker: "public"}, async (req, res) => {
  try {
    const tenant = await resolveDashboardTenant(req);
    const url = mailProvider.buildOAuthConnectUrl(tenant);
    return res.redirect(url);
  } catch (error) {
    console.error("gmailConnect error:", error);
    return res.status(500).send(error.message);
  }
});

exports.mailConnect = exports.gmailConnect;

exports.gmailOAuthCallback = onRequest(
    {invoker: "public"},
    async (req, res) => {
      try {
        const code = req.query.code;
        const providerLabel = mailProvider.providerLabel();

        if (req.query.admin_consent === "True") {
          return res.send(
              "<h2>Admin approval complete</h2>" +
              "<p>Microsoft 365 admin consent was granted for Jerry " +
              "mail access (read/send on the connected Outlook mailbox).</p>" +
              "<p>You can close this page. On the Jerry dashboard, click " +
              "<strong>Connect Outlook</strong> again using the accounting " +
              "mailbox account — it should work without the admin approval " +
              "prompt.</p>");
        }

        // Quote dispatcher Outlook connect reuses this Azure redirect URI;
        // route by OAuth state.flow instead of a separate callback function.
        if (req.query.state) {
          try {
            const parsedState = JSON.parse(
                Buffer.from(String(req.query.state), "base64url")
                    .toString("utf8"));
            if (parsedState && parsedState.flow === "quote_dispatcher") {
              const quoteDashboardMod = require("./quote-dashboard");
              return quoteDashboardMod.handleQuoteOutlookOAuthCallback(
                  req, res);
            }
          } catch (_) {
            // Fall through to Jerry mail token handling.
          }
        }

        if (!code) {
          return res.status(400).send(`Missing code from ${providerLabel}.`);
        }

        let tenantId = "default";
        if (req.query.state) {
          try {
            const parsed = JSON.parse(
                Buffer.from(String(req.query.state), "base64url")
                    .toString("utf8"));
            if (parsed && parsed.tenantId) {
              tenantId = String(parsed.tenantId);
            }
          } catch (_) {
            // Legacy connect without state — fall back to default tenant.
          }
        }
        const tenant = await getTenant(tenantId);

        const tokens = await mailProvider.exchangeOAuthCode(code);

        let connectedEmail = null;
        let connectedDisplayName = null;
        try {
          const profile = await mailProvider.resolveMailboxProfileFromTokens(
              tokens, tenant);
          connectedEmail = profile.email;
          connectedDisplayName = profile.displayName;
        } catch (profileErr) {
          console.warn(
              "Could not resolve connected mailbox profile:",
              profileErr.message);
        }

        const mailDocId = mailProvider.tenantMailDocId(tenant);
        if (mailProvider.getProvider() === "outlook" &&
            /^gmail(_|$)/i.test(String(mailDocId))) {
          throw new Error(
              "Refusing to save Gmail OAuth tokens while " +
              "MAIL_PROVIDER=outlook");
        }

        await db.collection("settings").doc(mailDocId).set({
          tokens: tokens,
          provider: mailProvider.getProvider(),
          tenantId: tenant.tenantId,
          connectedEmail,
          connectedDisplayName,
          connectedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        const mailboxLabel = connectedEmail || tenant.name || tenant.tenantId;
        return res.send(
            `${providerLabel} connected successfully for ` +
            `${mailboxLabel}. You can close this page.`);
      } catch (error) {
        console.error("gmailOAuthCallback error:", error);
        return res.status(500).send(error.message);
      }
    });

exports.mailOAuthCallback = exports.gmailOAuthCallback;
exports.outlookOAuthCallback = exports.gmailOAuthCallback;

/**
 * Applies CORS headers so the static dashboard can call these endpoints
 * directly from the browser. Set the DASHBOARD_ORIGIN env var to the
 * dashboard's URL (e.g. https://your-site.netlify.app) to restrict access;
 * it falls back to "*" so the dashboard works before that's configured.
 * @param {object} req Express request.
 * @param {object} res Express response.
 * @return {boolean} True if this was an OPTIONS preflight that was already
 *   responded to, meaning the caller should stop handling the request.
 */
function applyDashboardCors(req, res) {
  res.set("Access-Control-Allow-Origin", process.env.DASHBOARD_ORIGIN || "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  return false;
}

/** Max rows returned by dashboard log CSV export (one calendar day). */
const LOG_EXPORT_MAX_ROWS = 50000;
const LOG_EXPORT_TZ = "America/New_York";

/**
 * Validates YYYY-MM-DD for log export.
 * @param {string} raw Date string from query param.
 * @return {string|null} Normalized date or null.
 */
function parseLogExportDate(raw) {
  const s = String(raw || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const parts = s.split("-").map(Number);
  const y = parts[0];
  const m = parts[1];
  const day = parts[2];
  const check = new Date(Date.UTC(y, m - 1, day));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() + 1 !== m ||
      check.getUTCDate() !== day) {
    return null;
  }
  return s;
}

/**
 * Escapes one CSV field.
 * @param {*} value Cell value.
 * @return {string}
 */
function csvEscapeCell(value) {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, "\"\"")}"`;
  }
  return s;
}

/**
 * @param {Array<object>} rows BigQuery log rows.
 * @return {string} CSV text.
 */
function buildLogsCsv(rows) {
  const header = [
    "timestamp", "level", "category", "message", "flowId",
    "messageId", "invoiceId", "currentStep", "details",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    const ts = row.timestamp && row.timestamp.value ?
      row.timestamp.value : String(row.timestamp || "");
    lines.push([
      csvEscapeCell(ts),
      csvEscapeCell(row.level),
      csvEscapeCell(row.category),
      csvEscapeCell(row.message),
      csvEscapeCell(row.flowId),
      csvEscapeCell(row.messageId),
      csvEscapeCell(row.invoiceId),
      csvEscapeCell(row.currentStep),
      csvEscapeCell(row.details),
    ].join(","));
  }
  return lines.join("\r\n");
}

/**
 * Resolves the tenant for a dashboard API call from ?tenantId= or POST body.
 * Defaults to the legacy Primus tenant when omitted.
 * @param {object} req Express request.
 * @return {Promise<object>} Tenant config.
 */
async function resolveDashboardTenant(req) {
  const tenantId = (req.query && req.query.tenantId) ||
    (req.body && req.body.tenantId) || "default";
  return getTenant(String(tenantId));
}

// Supported dashboard time ranges, mapped to how far back to look and the
// granularity to bucket results into. Kept as a whitelist so the range
// query param can never reach the SQL string directly.
const DASHBOARD_RANGES = {
  day: {days: 1, truncUnit: "HOUR"},
  week: {days: 7, truncUnit: "DAY"},
  month: {days: 30, truncUnit: "DAY"},
  year: {days: 365, truncUnit: "MONTH"},
};

exports.getGmailStatus = onRequest({invoker: "public"}, async (req, res) => {
  if (applyDashboardCors(req, res)) {
    return;
  }

  try {
    const tenant = await resolveDashboardTenant(req);
    const gmailDoc = await db.collection("settings")
        .doc(tenantGmailDocId(tenant)).get();
    if (!gmailDoc.exists) {
      return res.json({
        ok: true,
        connected: false,
        provider: mailProvider.getProvider(),
        tenantId: tenant.tenantId,
        tms: tenant.tms,
      });
    }

    const data = gmailDoc.data();
    let connectedEmail = data.connectedEmail || null;
    let connectedDisplayName = data.connectedDisplayName || null;
    if (!connectedEmail && (data.tokens || data.access_token)) {
      try {
        const profile = await mailProvider.resolveMailboxProfileFromTokens(
            data.tokens || data, tenant);
        connectedEmail = profile.email;
        connectedDisplayName = profile.displayName;
        if (connectedEmail) {
          await db.collection("settings").doc(tenantGmailDocId(tenant)).set({
            connectedEmail,
            connectedDisplayName,
          }, {merge: true});
        }
      } catch (profileErr) {
        console.warn(
            "getMailStatus profile lookup failed:", profileErr.message);
      }
    }
    return res.json({
      ok: true,
      connected: true,
      provider: data.provider || mailProvider.getProvider(),
      tenantId: tenant.tenantId,
      tms: tenant.tms,
      tenantName: tenant.name,
      connectedEmail,
      connectedDisplayName,
      connectedAt: data.connectedAt ? data.connectedAt.toDate() : null,
    });
  } catch (error) {
    console.error("getGmailStatus error:", error);
    return res.status(500).json({ok: false, error: error.message});
  }
});

exports.getMailStatus = exports.getGmailStatus;

exports.gmailDisconnect = onRequest({invoker: "public"}, async (req, res) => {
  if (applyDashboardCors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ok: false, error: "Method not allowed."});
  }
  try {
    const tenant = await resolveDashboardTenant(req);
    await db.collection("settings").doc(tenantGmailDocId(tenant)).delete();
    return res.json({ok: true, tenantId: tenant.tenantId});
  } catch (error) {
    console.error("gmailDisconnect error:", error);
    return res.status(500).json({ok: false, error: error.message});
  }
});

exports.mailDisconnect = exports.gmailDisconnect;

exports.setCustomerRate = onRequest(async (req, res) => {
  const invoiceId = req.query.invoiceId || (req.body && req.body.invoiceId);
  if (!invoiceId) {
    return res.status(400).send("Missing invoiceId.");
  }

  const tenant = await tenantFromRequest(req);
  const invoiceRef = tcol(tenant, "invoices").doc(String(invoiceId));
  const snap = await invoiceRef.get();
  if (!snap.exists) {
    return res.status(404).send("Invoice not found.");
  }
  const inv = snap.data();

  // ── GET — show form ──────────────────────────────────────────────────────
  if (req.method === "GET") {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Set Customer Rate — Load ${escapeHtml(inv.loadNumber || "")}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      background:#f5f6fa;margin:0;padding:2rem;color:#1f2430}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;
      padding:2rem;max-width:480px;margin:0 auto}
    h2{margin:0 0 1.25rem;font-size:1.15rem}
    .field{margin-bottom:1rem}
    label{display:block;font-size:.85rem;font-weight:600;
      color:#6b7280;margin-bottom:.35rem}
    .readonly{padding:.5rem .75rem;background:#f5f6fa;border:1px solid #e5e7eb;
      border-radius:8px;font-size:.95rem}
    input[type=number],input[type=text]{width:100%;padding:.5rem .75rem;
      border:1px solid #d1d5db;border-radius:8px;font-size:.95rem;
      box-sizing:border-box}
    input:focus{outline:none;border-color:#4f46e5}
    .btn{width:100%;padding:.65rem;background:#4f46e5;color:#fff;
      border:none;border-radius:8px;font-size:1rem;font-weight:600;
      cursor:pointer;margin-top:.5rem}
    .btn:hover{opacity:.9}
    .note{font-size:.8rem;color:#6b7280;margin-top:1rem}
  </style>
</head>
<body>
<div class="card">
  <h2>Set Customer Rate — Load ${escapeHtml(inv.loadNumber || "—")}</h2>
  <form method="POST">
    <input type="hidden" name="invoiceId" value="${escapeHtml(invoiceId)}"/>
    <input type="hidden" name="tenantId" value="${escapeHtml(
      tenant.tenantId)}"/>
    <div class="field">
      <label>Carrier</label>
      <div class="readonly">${escapeHtml(inv.carrierName || "—")}</div>
    </div>
    <div class="field">
      <label>Carrier Invoice Amount</label>
      <div class="readonly">$${escapeHtml(String(
      inv.invoiceAmount || "—"))}</div>
    </div>
    <div class="field">
      <label>Customer Name</label>
      <input type="text" name="customerName"
        value="${escapeHtml(inv.customerName || "")}"
        placeholder="e.g. S3 Holdings LLC" required/>
    </div>
    <div class="field">
      <label>Customer Rate ($)</label>
      <input type="number" name="customerRate" min="1" step="0.01"
        placeholder="e.g. 2100" required/>
    </div>
    <button type="submit" class="btn">Save &amp; Continue Workflow</button>
  </form>
  <p class="note">This will save the rate and automatically resume
    the invoice workflow.</p>
</div>
</body></html>`;
    return res.send(html);
  }

  // ── POST — save rate and resume ──────────────────────────────────────────
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed.");
  }

  const customerRate = Number(req.body.customerRate);
  const customerName = String(req.body.customerName || "").trim();

  if (!customerRate || customerRate <= 0) {
    return res.status(400).send("Invalid customer rate.");
  }

  const primusSteps = inv.primusSteps || {};
  const taiSteps = inv.taiSteps || {};

  // The rate reaches the customer invoice when generateCustomerInvoice runs
  // later in the workflow. We mark customerRateChecked on whichever TMS step
  // map the invoice carries so the flag is TMS-agnostic.
  await invoiceRef.update({
    customerRate,
    customerName: customerName || inv.customerName || null,
    primusSteps: {...primusSteps, customerRateChecked: true},
    taiSteps: {...taiSteps, customerRateChecked: true},
    workflowPausedAtStep: null,
    workflowPausedAt: null,
    decisionStage: "running",
    decisionReason: null,
    finalWorkflowStatus: "running",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await writeLog("info", "workflow", "Customer rate set manually", {
    invoiceId,
    tenantId: tenant.tenantId,
    loadNumber: inv.loadNumber,
    customerRate,
    customerName,
  });

  // Resume the invoice's OWN tenant workflow (TAI or Primus), never a
  // hardcoded Primus default.
  const workflowUrl = workflowUrlForTenant(tenant);

  if (workflowUrl) {
    try {
      const response = await fetch(workflowUrl, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          invoiceId,
          tenantId: tenant.tenantId,
          resumeFrom: "get_rate",
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        await writeLog("error", "workflow",
            "setCustomerRate: workflow resume failed", {
              invoiceId,
              tenantId: tenant.tenantId,
              loadNumber: inv.loadNumber,
              status: response.status,
              error: payload.error || null,
            });
      } else {
        await writeLog("info", "workflow",
            "setCustomerRate: workflow resumed", {
              invoiceId,
              tenantId: tenant.tenantId,
              loadNumber: inv.loadNumber,
              workflowStatus: payload.workflowStatus || payload.ok || null,
            });
      }
    } catch (e) {
      await writeLog("error", "workflow", "setCustomerRate: resume failed", {
        invoiceId,
        tenantId: tenant.tenantId,
        loadNumber: inv.loadNumber,
        error: e.message,
      });
    }
  } else {
    await writeLog("error", "workflow",
        "setCustomerRate: no workflow URL for tenant", {
          invoiceId,
          tenantId: tenant.tenantId,
          loadNumber: inv.loadNumber,
        });
  }

  return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Rate saved</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      background:#f5f6fa;margin:0;padding:2rem;color:#1f2430}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;
      padding:2rem;max-width:480px;margin:0 auto;text-align:center}
    h2{color:#16a34a}
  </style>
</head>
<body>
<div class="card">
  <h2>✓ Rate saved</h2>
  <p>Customer rate of <strong>$${customerRate}</strong> saved for
    Load ${escapeHtml(inv.loadNumber || invoiceId)}.</p>
  <p>The workflow is resuming — you will receive the customer invoice
    shortly.</p>
</div>
</body></html>`);
});

exports.getRecentLogs = onRequest(async (req, res) => {
  if (applyDashboardCors(req, res)) return;
  try {
    const tenant = await resolveDashboardTenant(req);
    const loadNumber = req.query.loadNumber ?
      String(req.query.loadNumber).trim() : null;
    const invoiceId = req.query.invoiceId ?
      String(req.query.invoiceId).trim() : null;
    const messageLike = req.query.messageLike ?
      String(req.query.messageLike).trim() : null;
    const isFiltered = Boolean(loadNumber || invoiceId || messageLike);
    if (!DASHBOARD_ACTIVITY_FEED_ENABLED && !isFiltered) {
      return res.json({
        ok: true,
        tenantId: tenant.tenantId,
        logs: [],
        activityFeedEnabled: false,
        message: "Live log feed disabled. See daily Jerry activity email.",
      });
    }
    const limit = Math.min(Number(req.query.limit || 40), 100);
    const dataset = tenant.bqDataset;
    const includeDetails = req.query.includeDetails === "1" ||
      req.query.includeDetails === "true";
    let rows;
    if (loadNumber || invoiceId || messageLike) {
      const hours = Math.min(Number(req.query.hours || 48), 168);
      const filters = [
        "timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @hours HOUR)",
      ];
      const params = {hours, limit};
      if (loadNumber) {
        filters.push(`(
          JSON_VALUE(details, '$.loadNumber') = @loadNumber OR
          JSON_VALUE(details, '$.details.loadNumber') = @loadNumber
        )`);
        params.loadNumber = loadNumber;
      }
      if (invoiceId) {
        filters.push(`(
          JSON_VALUE(details, '$.invoiceId') = @invoiceId OR
          JSON_VALUE(details, '$.details.invoiceId') = @invoiceId
        )`);
        params.invoiceId = invoiceId;
      }
      if (messageLike) {
        filters.push("LOWER(message) LIKE LOWER(@messageLike)");
        params.messageLike = `%${messageLike}%`;
      }
      [rows] = await bigquery.query({
        query: `
          SELECT timestamp, level, category, message, details
          FROM \`${dataset}.${BQ_LOGS_TABLE}\`
          WHERE ${filters.join(" AND ")}
          ORDER BY timestamp ASC
          LIMIT @limit
        `,
        params,
      });
    } else {
      [rows] = await bigquery.query({
        query: `
          SELECT timestamp, level, category, message
          FROM \`${dataset}.${BQ_LOGS_TABLE}\`
          ORDER BY timestamp DESC
          LIMIT @limit
        `,
        params: {limit},
      });
    }
    const logs = rows.map((row) => {
      const entry = {
        timestamp: row.timestamp && row.timestamp.value ?
          row.timestamp.value : String(row.timestamp),
        level: row.level,
        category: row.category,
        message: row.message,
      };
      if (includeDetails && row.details != null) {
        let details = row.details;
        if (typeof details === "string") {
          try {
            details = JSON.parse(details);
          } catch (_) {
            /* keep string */
          }
        }
        entry.details = details;
      }
      return entry;
    });
    return res.json({ok: true, tenantId: tenant.tenantId, logs});
  } catch (error) {
    console.error("getRecentLogs error:", error);
    return res.status(500).json({
      ok: false, error: "Failed to load logs.", details: error.message,
    });
  }
});

exports.exportLogsCsv = onRequest(
    {invoker: "public", timeoutSeconds: 120, memory: "512MiB"},
    async (req, res) => {
      if (applyDashboardCors(req, res)) return;
      try {
        const tenant = await resolveDashboardTenant(req);
        const exportDate = parseLogExportDate(req.query.date);
        if (!exportDate) {
          return res.status(400).json({
            ok: false,
            error: "Missing or invalid date. Use ?date=YYYY-MM-DD",
          });
        }
        const dataset = tenant.bqDataset;
        const [rows] = await bigquery.query({
          query: `
            SELECT
              timestamp, level, category, message, flowId, messageId,
              invoiceId, currentStep, details
            FROM \`${dataset}.${BQ_LOGS_TABLE}\`
            WHERE DATE(timestamp, @tz) = @exportDate
            ORDER BY timestamp ASC
            LIMIT @maxRows
          `,
          params: {
            tz: LOG_EXPORT_TZ,
            exportDate,
            maxRows: LOG_EXPORT_MAX_ROWS,
          },
        });
        const csv = buildLogsCsv(rows);
        const filename = `jerry-logs-${exportDate}.csv`;
        res.set("Content-Type", "text/csv; charset=utf-8");
        res.set("Content-Disposition", `attachment; filename="${filename}"`);
        res.set("Access-Control-Expose-Headers", "Content-Disposition");
        return res.status(200).send(`\uFEFF${csv}`);
      } catch (error) {
        console.error("exportLogsCsv error:", error);
        return res.status(500).json({
          ok: false,
          error: "Failed to export logs.",
          details: error.message,
        });
      }
    },
);

/**
 * Dashboard activity feed disabled — use daily email digest instead.
 */
exports.getRecentSummaries = onRequest(async (req, res) => {
  if (applyDashboardCors(req, res)) return;
  try {
    const tenant = await resolveDashboardTenant(req);
    if (!DASHBOARD_ACTIVITY_FEED_ENABLED) {
      return res.json({
        ok: true,
        tenantId: tenant.tenantId,
        summaries: [],
        activityFeedEnabled: false,
        message: "Per-flow summaries disabled. Daily digest at 6 PM ET.",
        limit: 0,
        offset: 0,
        hasMore: false,
      });
    }
    const limit = Math.min(Number(req.query.limit || 30), 100);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const dataset = tenant.bqDataset;
    const [rows] = await bigquery.query({
      query: `
        SELECT
          createdAt,
          flowId,
          messageId,
          invoiceId,
          finalStatus,
          lastStep,
          failureReason,
          recommendedFix,
          aiSummary
        FROM \`${dataset}.${BQ_SUMMARIES_TABLE}\`
        ORDER BY createdAt DESC
        LIMIT @limit
        OFFSET @offset
      `,
      params: {limit, offset},
    });
    const summaries = rows.map((row) => ({
      createdAt: row.createdAt && row.createdAt.value ?
        row.createdAt.value : String(row.createdAt),
      flowId: row.flowId || null,
      messageId: row.messageId || null,
      invoiceId: row.invoiceId || null,
      finalStatus: row.finalStatus || null,
      lastStep: row.lastStep || null,
      failureReason: row.failureReason || null,
      recommendedFix: row.recommendedFix || null,
      aiSummary: row.aiSummary || null,
    }));
    return res.json({
      ok: true,
      tenantId: tenant.tenantId,
      summaries,
      limit,
      offset,
      hasMore: summaries.length === limit,
    });
  } catch (error) {
    console.error("getRecentSummaries error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to load summaries.",
      details: error.message,
    });
  }
});

/**
 * Maps leftover customer-email-gate statuses to dashboard-facing labels.
 * Extra-charge A/B/C/D approval is unchanged.
 * @param {object} data Invoice document fields.
 * @return {object}
 */
function invoiceDashboardStatus(data) {
  const stage = String(data.decisionStage || "");
  const wf = String(data.finalWorkflowStatus || "");
  const reason = String(data.decisionReason || "");
  const match = data.matchStatus || null;
  const extraChargePending =
    stage === "additional_charge_pending_approval" ||
    wf === "additional_charge_pending_approval";
  if (wf === "completed" || stage === "completed") {
    return {matchStatus: match, displayStatus: "completed",
      displayLabel: "Completed",
      displayReason: data.decisionReason || null,
      remapWorkflow: false};
  }
  if (extraChargePending) {
    return {matchStatus: match,
      displayStatus: "additional_charge_pending_approval",
      displayLabel: "Awaiting extra-charge approval",
      displayReason: data.decisionReason ||
        "Additional charge awaiting A/B/C/D decision.",
      remapWorkflow: false};
  }
  const staleEmailGate =
    stage === "awaiting_customer_email_approval" ||
    /awaiting reviewer approval before emailing/i.test(reason);
  if (staleEmailGate) {
    return {matchStatus: match, displayStatus: "running",
      displayLabel: "Sending customer email",
      displayReason: "Customer invoice email sends automatically.",
      remapWorkflow: true};
  }
  if (stage === "ready_to_approve" || stage === "amount_matched") {
    if (wf === "failed") {
      return {matchStatus: match, displayStatus: "failed",
        displayLabel: "Failed",
        displayReason: data.decisionReason || null,
        remapWorkflow: false};
    }
    if (wf === "created" || wf === "running" || !wf) {
      return {matchStatus: match, displayStatus: "running",
        displayLabel: "Processing",
        displayReason: "Amount matched — processing automatically.",
        remapWorkflow: true};
    }
    return {matchStatus: match, displayStatus: "amount_matched",
      displayLabel: "Amount matched",
      displayReason: data.decisionReason || null,
      remapWorkflow: false};
  }
  const raw = stage || wf || null;
  return {matchStatus: match, displayStatus: raw,
    displayLabel: raw ? String(raw).replace(/_/g, " ") : null,
    displayReason: data.decisionReason || null,
    remapWorkflow: false};
}

exports.getRecentInvoices = onRequest(async (req, res) => {
  if (applyDashboardCors(req, res)) return;
  try {
    const tenant = await resolveDashboardTenant(req);
    const parsedLimit = Number(req.query.limit);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ?
      Math.min(Math.floor(parsedLimit), 50) : 20;
    const parsedOffset = Number(req.query.offset);
    const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ?
      Math.floor(parsedOffset) : 0;
    // Fetch the window with limit+offset, then slice. Avoid Query.offset()
    // so pagination cannot 400/500 on admin SDK versions that lack it.
    const fetchCount = Math.min(offset + limit, 500);
    const snap = await tcol(tenant, "invoices")
        .orderBy("createdAt", "desc")
        .limit(fetchCount)
        .get();
    const pageDocs = snap.docs.slice(offset);
    const invoices = pageDocs.map((doc) => {
      const data = doc.data() || {};
      const createdAt = data.createdAt && data.createdAt.toDate ?
        data.createdAt.toDate().toISOString() : null;
      const shown = invoiceDashboardStatus(data);
      return {
        id: doc.id,
        loadNumber: data.loadNumber || null,
        proNumber: data.proNumber || null,
        carrierName: data.carrierName || null,
        customerName: data.customerName || null,
        invoiceAmount: data.invoiceAmount || null,
        customerRate: data.customerRate || null,
        profit: data.profit || null,
        tms: data.tms || tenant.tms,
        taiShipmentId: data.taiShipmentId || null,
        // Dashboard row uses finalWorkflowStatus, then decisionReason.
        // Remap leftover customer-email-gate / ready_to_approve so those
        // rows do not look like they are waiting for reviewer approval.
        finalWorkflowStatus: shown.remapWorkflow ?
          (shown.displayStatus || data.finalWorkflowStatus || null) :
          (data.finalWorkflowStatus || null),
        decisionStage: shown.displayStatus || data.decisionStage || null,
        decisionReason: shown.displayReason,
        matchStatus: shown.matchStatus,
        displayStatus: shown.displayStatus,
        displayLabel: shown.displayLabel,
        currentStep: data.currentStep || null,
        createdAt,
      };
    });
    return res.json({
      ok: true,
      tenantId: tenant.tenantId,
      tms: tenant.tms,
      invoices,
      limit,
      offset,
      hasMore: snap.docs.length === offset + limit,
    });
  } catch (error) {
    console.error("getRecentInvoices error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to load invoices.",
      details: error.message,
    });
  }
});

exports.getDashboardStats = onRequest(async (req, res) => {
  if (applyDashboardCors(req, res)) {
    return;
  }

  try {
    const tenant = await resolveDashboardTenant(req);
    const dataset = tenant.bqDataset;
    const range = String(req.query.range || "day").toLowerCase();
    const rangeConfig = DASHBOARD_RANGES[range];
    if (!rangeConfig) {
      return res.status(400).json({
        ok: false,
        error: "Invalid range. Use day, week, month, or year.",
      });
    }

    const query = `
      SELECT
        TIMESTAMP_TRUNC(timestamp, ${rangeConfig.truncUnit}) AS period,
        COUNTIF(
          category IN ("mail", "gmail")
          AND message = "Email processing completed"
        ) AS invoicesProcessed,
        COUNTIF(
          category = "workflow" AND (
            message = "Primus workflow completed" OR
            message = "TAI workflow completed"
          )
        ) AS workflowsCompleted,
        COUNTIF(
          category IN ("mail", "gmail") AND (
            message LIKE "Additional charge%" OR
            message = "Additional charge needs approval (4-option email)"
          )
        ) AS invoicesWithAddedCharges,
        COUNTIF(
          category = "email" AND message = "Outbound email sent"
        ) AS emailsReplied,
        COUNTIF(
          category IN ("mail", "gmail") AND (
            message = "Forwarded to human review" OR
            message = "No attachments found, forwarding for review"
          )
        ) AS emailsForwarded
      FROM \`${dataset}.${BQ_LOGS_TABLE}\`
      WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
      GROUP BY period
      ORDER BY period ASC
    `;

    const [rows] = await bigquery.query({
      query,
      params: {days: rangeConfig.days},
    });

    const series = rows.map((row) => ({
      period: row.period && row.period.value ?
        row.period.value : row.period,
      invoicesProcessed: Number(row.invoicesProcessed || 0),
      workflowsCompleted: Number(row.workflowsCompleted || 0),
      invoicesWithAddedCharges: Number(row.invoicesWithAddedCharges || 0),
      emailsReplied: Number(row.emailsReplied || 0),
      emailsForwarded: Number(row.emailsForwarded || 0),
    }));

    const totals = series.reduce((acc, row) => ({
      invoicesProcessed: acc.invoicesProcessed + row.invoicesProcessed,
      workflowsCompleted: acc.workflowsCompleted + row.workflowsCompleted,
      invoicesWithAddedCharges:
        acc.invoicesWithAddedCharges + row.invoicesWithAddedCharges,
      emailsReplied: acc.emailsReplied + row.emailsReplied,
      emailsForwarded: acc.emailsForwarded + row.emailsForwarded,
    }), {
      invoicesProcessed: 0,
      workflowsCompleted: 0,
      invoicesWithAddedCharges: 0,
      emailsReplied: 0,
      emailsForwarded: 0,
    });

    return res.json({
      ok: true,
      tenantId: tenant.tenantId,
      tms: tenant.tms,
      range,
      totals,
      series,
    });
  } catch (error) {
    console.error("getDashboardStats error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to load dashboard stats.",
      details: error.message,
    });
  }
});

exports.getDashboardTasks = onRequest(async (req, res) => {
  if (applyDashboardCors(req, res)) return;
  try {
    const tenant = await resolveDashboardTenant(req);
    const limit = Math.min(Number(req.query.limit || 50), 100);
    const result = await dashboardTasks.listDashboardTasks(
        db, additionalCharges, {
          tenantId: tenant.tenantId,
          limit,
        });
    return res.json({
      ok: true,
      tenantId: tenant.tenantId,
      tasks: result.tasks,
      openCount: result.openCount,
    });
  } catch (error) {
    console.error("getDashboardTasks error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to load tasks.",
      details: error.message,
    });
  }
});

exports.dismissDashboardTask = onRequest(async (req, res) => {
  if (applyDashboardCors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ok: false, error: "Method not allowed."});
  }
  try {
    const tenant = await resolveDashboardTenant(req);
    const body = req.body || {};
    const taskId = body.taskId || req.query.taskId;
    const source = body.source || req.query.source || "dashboardTasks";
    const result = await dashboardTasks.dismissDashboardTask(
        db, additionalCharges, {
          taskId,
          source,
          tenantId: tenant.tenantId,
        });
    if (!result.ok) {
      return res.status(400).json(result);
    }
    return res.json({ok: true, tenantId: tenant.tenantId});
  } catch (error) {
    console.error("dismissDashboardTask error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to dismiss task.",
      details: error.message,
    });
  }
});

/**
 * Recipients for support-chat issue reports
 * (SUPPORT_ISSUE_EMAIL, comma-separated — Advanced Automations only).
 * @return {string} Comma-separated To addresses for MIME.
 */
function resolveSupportIssueRecipients() {
  const raw = process.env.SUPPORT_ISSUE_EMAIL || SYSTEM_ERROR_EMAIL_DEFAULT;
  const recipients = [];
  const seen = new Set();
  const add = (addr) => {
    const a = String(addr || "").trim();
    if (!a) return;
    const key = a.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    recipients.push(a);
  };
  raw.split(/[,;]/).forEach(add);
  if (!recipients.length) add(SYSTEM_ERROR_EMAIL_DEFAULT);
  return recipients.join(", ");
}

/**
 * Emails a captured support-chat issue summary to the support inbox.
 * @param {object} data Issue data.
 * @param {string} data.clientName Display name of the client whose
 *   dashboard the chat ran on.
 * @param {string} data.summary AI-written report of the customer's issue.
 * @param {Array<{role: string, content: string}>} data.transcript Full
 *   chat transcript to include for context.
 * @return {Promise<void>}
 */
async function sendSupportIssueEmail({clientName, summary, transcript}) {
  const to = resolveSupportIssueRecipients();

  const transcriptHtml = transcript.map((turn) =>
    `<p style="margin:0 0 8px;line-height:1.5;">` +
    `<strong>${turn.role === "user" ? "Customer" : "Assistant"}:</strong> ` +
    `${escapeHtml(turn.content)}</p>`,
  ).join("");

  const html =
    `<div style="font-family:Arial,sans-serif;max-width:620px;` +
    `color:#111827;font-size:14px;">` +
    `<div style="background:#4f46e5;color:#fff;padding:14px 18px;` +
    `border-radius:6px 6px 0 0;font-size:15px;font-weight:700;">` +
    `Support chat — ${escapeHtml(clientName)}</div>` +
    `<div style="border:1px solid #e5e7eb;border-top:none;padding:18px;` +
    `border-radius:0 0 6px 6px;">` +
    `<p style="margin:0 0 16px;color:#374151;line-height:1.6;">` +
    `Hi, I'm ${escapeHtml(AI_AGENT_NAME)}, your AI assistant. ` +
    `A support chat was flagged for your attention.</p>` +
    `<h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;` +
    `letter-spacing:.05em;color:#374151;">Issue Summary</h3>` +
    `<p style="margin:0 0 16px;color:#374151;line-height:1.6;` +
    `white-space:pre-wrap;">${escapeHtml(summary)}</p>` +
    `<h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;` +
    `letter-spacing:.05em;color:#374151;">Conversation</h3>` +
    `${transcriptHtml}` +
    `</div></div>`;

  const safeClientName = String(clientName || "").replace(/[\r\n]/g, " ");
  const subject = `[Support Chat] ${safeClientName} — issue reported`;

  const mailDoc = await db.collection("settings")
      .doc(tenantGmailDocId(DEFAULT_TENANT)).get();
  if (!mailDoc.exists) {
    console.error(
        "[sendSupportIssueEmail] Mail inbox not connected — issue report " +
        `dropped for ${safeClientName}`,
    );
    return;
  }

  const mail = await mailProvider.getTenantMailClient(DEFAULT_TENANT);
  if (!mail) {
    console.error(
        "[sendSupportIssueEmail] Mail client unavailable — issue report " +
        `dropped for ${safeClientName}`,
    );
    return;
  }

  const mimeBuffer = Buffer.from(
      `To: ${to}\r\n` +
      `Subject: ${subject}\r\n` +
      `Content-Type: text/html; charset="UTF-8"\r\n\r\n${html}`,
  );

  await mail.users.messages.send({
    userId: "me",
    requestBody: {raw: mimeBuffer.toString("base64url")},
  });
}

// Support-chat conversations are capped to keep prompt size and per-request
// cost predictable — long enough for a real back-and-forth, short enough
// that a confused user can't run up an unbounded bill.
const SUPPORT_CHAT_MAX_TURNS = 24;
const SUPPORT_CHAT_MAX_MESSAGE_LENGTH = 4000;
const SUPPORT_CHAT_DEFAULT_MODEL = DEFAULT_OPENAI_MODEL;

/** Product knowledge injected into the support-chat system prompt. */
const SUPPORT_CHAT_PRODUCT_KNOWLEDGE =
  "PRODUCT KNOWLEDGE (answer how-it-works questions from this — " +
  "never mention source code, repos, or internal engineering): " +
  "This dashboard monitors automated carrier-invoice processing for " +
  "the customer's TMS workflow. Outlook must stay connected so inbound " +
  "invoice emails can be read; Jerry checks the inbox automatically every " +
  "20 minutes. The stats chart (Day / Week / Month / Year) " +
  "shows invoices processed, workflows completed, invoices with additional " +
  "charges, outbound reply emails sent, and emails forwarded for human " +
  "review. The task manager lists open items " +
  "for Lisa and ops (additional charges, human-review forwards, signed POD " +
  "requests) and each task can be dismissed when handled. " +
  "A daily email digest (6 PM ET) is sent to Lisa only — it is not shown " +
  "on the dashboard. " +
  "The recent-invoices table lists loads " +
  "with load #, pro #, carrier, customer, amount, and workflow status. " +
  "Typical flow: a carrier invoice email " +
  "arrives in the inbox → PDF is read → load/amount/POD pages are " +
  "extracted → the load is matched in the TMS → billing steps run. " +
  "If something is missing on the dashboard it may still be in the " +
  "mail queue, still processing, filtered by the selected time " +
  "range, sent to human review, or the source email never arrived. " +
  "Mail disconnected = no new processing until reconnected. " +
  "A bare 6-digit number in chat is a Primus load number — treat it as " +
  "the load under discussion. Do NOT ask whether it is a load vs an " +
  "invoice id. Follow-ups like \"that load\", \"that load number\", " +
  "\"was it processed\", or \"did it fail\" refer to the most recent " +
  "load number already mentioned. " +
  "When a 6-digit load number appears in the conversation, processing " +
  "records are looked up automatically and attached below when found — " +
  "use them to explain what happened right away in 2–4 short sentences. " +
  "Never say you cannot see processing details, logs, or BigQuery when " +
  "LOAD LOOKUP data is attached. Never mention BigQuery, databases, or " +
  "internal systems by name — describe outcomes in plain language " +
  "(e.g. \"matched in Primus\", \"waiting on POD\", " +
  "\"forwarded for review\", \"workflow completed\", \"workflow failed\"). " +
  "If no records are attached for a load, say you could not find " +
  "processing activity for that load yet. For general issues without a " +
  "specific load, escalate with status \"ready\" when an engineer should " +
  "investigate. Never mention source code, codebase, repositories, or " +
  "GitHub.";

/** Max log rows pulled into support-chat context per load lookup. */
const SUPPORT_CHAT_LOG_LIMIT = 80;
/** How far back (hours) support chat searches BigQuery for a load. */
const SUPPORT_CHAT_LOG_HOURS = 168;

/**
 * Pulls load # and invoice id hints from user chat text.
 * @param {Array<string>} userTexts User message bodies.
 * @return {{loadNumbers: Set<string>, invoiceIds: Set<string>}}
 */
function extractSupportChatIdentifiers(userTexts) {
  const loadNumbers = new Set();
  const invoiceIds = new Set();
  for (const text of userTexts) {
    const line = String(text || "");
    // Any standalone 6-digit Primus load # in user text (e.g. "finished
    // with 265653", "load #265653", bare "265653").
    for (const m of line.matchAll(/\b(\d{6})\b/g)) {
      if (isValidLoadNumber(m[1])) loadNumbers.add(m[1]);
    }
    for (const m of line.matchAll(
        /\b(?:invoice\s*(?:id|#)?\s*)([a-zA-Z0-9]{18,28})\b/gi,
    )) {
      invoiceIds.add(m[1]);
    }
  }
  return {loadNumbers, invoiceIds};
}

/**
 * @param {*} ts BigQuery timestamp cell.
 * @return {string}
 */
function bqRowTimestamp(ts) {
  return ts && ts.value ? ts.value : String(ts || "");
}

/**
 * Loads the most recent invoice doc for a Primus load number.
 * @param {object} tenant Tenant config.
 * @param {string} loadNumber Six-digit load number.
 * @return {Promise<object|null>}
 */
async function fetchInvoiceByLoadNumber(tenant, loadNumber) {
  const normalized = normalizeLoadNumber(loadNumber);
  if (!isValidLoadNumber(normalized)) return null;
  const snap = await tcol(tenant, "invoices")
      .where("loadNumber", "==", normalized)
      .limit(10)
      .get();
  if (snap.empty) return null;
  const sorted = snap.docs.slice().sort((a, b) => {
    const ta = a.data().createdAt && a.data().createdAt.toMillis ?
      a.data().createdAt.toMillis() : 0;
    const tb = b.data().createdAt && b.data().createdAt.toMillis ?
      b.data().createdAt.toMillis() : 0;
    return tb - ta;
  });
  const doc = sorted[0];
  const data = doc.data() || {};
  return {
    id: doc.id,
    loadNumber: data.loadNumber || normalized,
    proNumber: data.proNumber || null,
    carrierName: data.carrierName || null,
    customerName: data.customerName || null,
    invoiceAmount: data.invoiceAmount ?? null,
    finalWorkflowStatus: data.finalWorkflowStatus || null,
    decisionStage: data.decisionStage || null,
    decisionReason: data.decisionReason || null,
    currentStep: data.currentStep || null,
    createdAt: data.createdAt && data.createdAt.toDate ?
      data.createdAt.toDate().toISOString() : null,
  };
}

/**
 * Queries BigQuery logs for a load or invoice id (support chat).
 * @param {object} tenant Tenant config.
 * @param {object} opts loadNumber and/or invoiceId.
 * @return {Promise<Array<object>>}
 */
async function querySupportChatLogs(tenant, opts) {
  const loadNumber = opts.loadNumber ?
    normalizeLoadNumber(opts.loadNumber) : null;
  const invoiceId = opts.invoiceId ?
    String(opts.invoiceId).trim() : null;
  if (!loadNumber && !invoiceId) return [];

  const dataset = tenant.bqDataset;
  const filters = [
    "timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), " +
    "INTERVAL @hours HOUR)",
  ];
  const params = {
    hours: SUPPORT_CHAT_LOG_HOURS,
    limit: SUPPORT_CHAT_LOG_LIMIT,
  };
  if (loadNumber) {
    filters.push(`(
      JSON_VALUE(details, '$.loadNumber') = @loadNumber OR
      JSON_VALUE(details, '$.details.loadNumber') = @loadNumber OR
      message LIKE CONCAT('%', @loadNumber, '%')
    )`);
    params.loadNumber = loadNumber;
  }
  if (invoiceId) {
    filters.push(`(
      JSON_VALUE(details, '$.invoiceId') = @invoiceId OR
      invoiceId = @invoiceId OR
      JSON_VALUE(details, '$.details.invoiceId') = @invoiceId
    )`);
    params.invoiceId = invoiceId;
  }

  const [rows] = await bigquery.query({
    query: `
      SELECT timestamp, level, category, message, details,
        flowId, invoiceId, currentStep
      FROM \`${dataset}.${BQ_LOGS_TABLE}\`
      WHERE ${filters.join(" AND ")}
      ORDER BY timestamp ASC
      LIMIT @limit
    `,
    params,
  });

  return rows.map((row) => ({
    timestamp: bqRowTimestamp(row.timestamp),
    level: row.level,
    category: row.category,
    message: row.message,
    details: row.details,
    flowId: row.flowId || null,
    invoiceId: row.invoiceId || null,
    currentStep: row.currentStep || null,
  }));
}

/**
 * Latest AI flow summary row for an invoice or flow id.
 * @param {object} tenant Tenant config.
 * @param {object} opts invoiceId and/or flowId.
 * @return {Promise<object|null>}
 */
async function fetchFlowSummaryForSupportChat(tenant, opts) {
  const invoiceId = opts.invoiceId ?
    String(opts.invoiceId).trim() : null;
  const flowId = opts.flowId ? String(opts.flowId).trim() : null;
  if (!invoiceId && !flowId) return null;

  const dataset = tenant.bqDataset;
  const parts = [];
  const params = {};
  if (invoiceId) {
    parts.push("invoiceId = @invoiceId");
    params.invoiceId = invoiceId;
  }
  if (flowId) {
    parts.push("flowId = @flowId");
    params.flowId = flowId;
  }

  const [rows] = await bigquery.query({
    query: `
      SELECT finalStatus, lastStep, failureReason, recommendedFix,
        aiSummary, createdAt
      FROM \`${dataset}.${BQ_SUMMARIES_TABLE}\`
      WHERE ${parts.join(" OR ")}
      ORDER BY createdAt DESC
      LIMIT 1
    `,
    params,
  });
  if (!rows.length) return null;
  const row = rows[0];
  return {
    finalStatus: row.finalStatus || null,
    lastStep: row.lastStep || null,
    failureReason: row.failureReason || null,
    recommendedFix: row.recommendedFix || null,
    aiSummary: row.aiSummary || null,
    createdAt: bqRowTimestamp(row.createdAt),
  };
}

/**
 * Builds support-chat context for a specific load (BQ + Firestore).
 * @param {object} tenant Tenant config.
 * @param {object} opts loadNumber and/or invoiceId.
 * @return {Promise<object|null>}
 */
async function fetchSupportChatLoadContext(tenant, opts) {
  let loadNumber = opts.loadNumber ?
    normalizeLoadNumber(opts.loadNumber) : null;
  let invoiceId = opts.invoiceId ?
    String(opts.invoiceId).trim() : null;
  if (!loadNumber && !invoiceId) return null;

  let invoice = null;
  if (loadNumber && isValidLoadNumber(loadNumber)) {
    invoice = await fetchInvoiceByLoadNumber(tenant, loadNumber);
    if (invoice && invoice.id && !invoiceId) invoiceId = invoice.id;
  } else if (invoiceId) {
    const doc = await tcol(tenant, "invoices").doc(invoiceId).get();
    if (doc.exists) {
      const data = doc.data() || {};
      invoice = {
        id: doc.id,
        loadNumber: data.loadNumber || null,
        proNumber: data.proNumber || null,
        carrierName: data.carrierName || null,
        customerName: data.customerName || null,
        invoiceAmount: data.invoiceAmount ?? null,
        finalWorkflowStatus: data.finalWorkflowStatus || null,
        decisionStage: data.decisionStage || null,
        decisionReason: data.decisionReason || null,
        currentStep: data.currentStep || null,
        createdAt: data.createdAt && data.createdAt.toDate ?
          data.createdAt.toDate().toISOString() : null,
      };
      if (!loadNumber && invoice.loadNumber) {
        loadNumber = normalizeLoadNumber(invoice.loadNumber);
      }
    }
  }

  // BQ is helpful but optional — never drop a Firestore invoice hit just
  // because logs/summaries are missing or the query fails.
  let logs = [];
  try {
    logs = await querySupportChatLogs(tenant, {loadNumber, invoiceId});
    if (!logs.length && invoice && invoice.id) {
      logs = await querySupportChatLogs(tenant, {invoiceId: invoice.id});
    }
  } catch (bqErr) {
    console.error(
        "[dashboardSupportChat] BQ log lookup failed:",
        bqErr && bqErr.message ? bqErr.message : bqErr,
    );
  }

  const lastLog = logs.length ? logs[logs.length - 1] : null;
  let summary = null;
  try {
    summary = await fetchFlowSummaryForSupportChat(tenant, {
      invoiceId: invoiceId || (lastLog && lastLog.invoiceId) || null,
      flowId: lastLog && lastLog.flowId || null,
    });
  } catch (sumErr) {
    console.error(
        "[dashboardSupportChat] BQ summary lookup failed:",
        sumErr && sumErr.message ? sumErr.message : sumErr,
    );
  }

  const facts = logs.length ? extractFlowFacts(logs) : null;
  // Keep the prompt small so the model reliably returns JSON.
  const compactLogs = logs.length ?
    compactLogsForSummary(logs).slice(-20) : [];

  return {
    loadNumber: loadNumber || (invoice && invoice.loadNumber) || null,
    invoiceId: invoiceId || (invoice && invoice.id) || null,
    invoice,
    summary,
    facts,
    compactLogs,
    logCount: logs.length,
  };
}

/**
 * Parses the support-chat model output into {reply, status, summary}.
 * gpt-5.6-luna sometimes ignores json_object mode and returns plain prose;
 * treat that as a normal reply instead of failing the turn.
 * @param {string} rawText Model content.
 * @return {{reply: string, status: string, summary: string}}
 */
function parseSupportChatAiResponse(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    return {
      reply: "Could you tell me a bit more about what you're seeing?",
      status: "asking",
      summary: "",
    };
  }

  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) candidates.push(fenced[1].trim());
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        return {
          reply: String(parsed.reply || "").trim(),
          status: parsed.status === "ready" ? "ready" : "asking",
          summary: String(parsed.summary || "").trim(),
        };
      }
    } catch (_err) {
      // try next candidate
    }
  }

  console.warn(
      "[dashboardSupportChat] AI returned non-JSON; using plain text reply",
  );
  return {
    reply: text.replace(/\*\*/g, "").slice(0, SUPPORT_CHAT_MAX_MESSAGE_LENGTH),
    status: "asking",
    summary: "",
  };
}

/**
 * Formats load lookup results for the support-chat system prompt.
 * @param {object|null} ctx fetchSupportChatLoadContext output.
 * @return {string}
 */
function formatSupportChatLoadContext(ctx) {
  if (!ctx) return "";
  const parts = [
    "LOAD LOOKUP (internal processing records — answer from this; " +
    "never mention databases or logs):",
  ];

  if (ctx.invoice) {
    const inv = ctx.invoice;
    const status = inv.finalWorkflowStatus || inv.currentStep ||
      inv.decisionStage || "unknown";
    parts.push(
        `Dashboard invoice: load ${inv.loadNumber || "?"}, ` +
        `carrier ${inv.carrierName || "unknown"}, ` +
        `customer ${inv.customerName || "unknown"}, ` +
        `amount ${inv.invoiceAmount != null ?
          "$" + Number(inv.invoiceAmount).toFixed(2) : "unknown"}, ` +
        `status ${status}` +
        (inv.decisionReason ? ` (${inv.decisionReason})` : "") + ".",
    );
  }

  if (ctx.summary && ctx.summary.aiSummary) {
    parts.push(
        `Flow summary: ${ctx.summary.aiSummary}` +
        (ctx.summary.finalStatus ?
          ` [${ctx.summary.finalStatus}]` : "") +
        (ctx.summary.failureReason ?
          ` Failure: ${ctx.summary.failureReason}.` : "") +
        (ctx.summary.recommendedFix ?
          ` Suggested fix: ${ctx.summary.recommendedFix}.` : ""),
    );
  } else if (ctx.facts && ctx.facts.outcomeHint) {
    parts.push(
        `Outcome hint: ${ctx.facts.outcomeHint}` +
        (ctx.facts.lastError ? ` — ${ctx.facts.lastError}` : "") + ".",
    );
  }

  if (ctx.compactLogs && ctx.compactLogs.length) {
    parts.push(
        "Timeline: " +
        JSON.stringify(ctx.compactLogs.slice(-30)),
    );
  } else if (!ctx.invoice && !ctx.summary) {
    parts.push(
        `No processing records found for load ` +
        `${ctx.loadNumber || ctx.invoiceId || "?"} in the last ` +
        `${SUPPORT_CHAT_LOG_HOURS} hours.`,
    );
  }

  if (ctx.priorLoadContext) {
    const priorText = formatSupportChatLoadContext({
      ...ctx.priorLoadContext,
      priorLoadContext: null,
    });
    if (priorText) {
      parts.push(
          "ALSO previously discussed load (use if the user refers back " +
          "to it): " + priorText,
      );
    }
  }

  return parts.join(" ") + " ";
}

/**
 * Formats optional dashboard snapshot text for the support-chat prompt.
 * @param {object|undefined} ctx Snapshot from the dashboard UI.
 * @return {string}
 */
function formatSupportChatDashboardContext(ctx) {
  if (!ctx || typeof ctx !== "object") {
    return "";
  }
  const parts = [];
  if (ctx.gmailConnected === true) {
    parts.push("Mail inbox: connected");
  } else if (ctx.gmailConnected === false) {
    parts.push("Mail inbox: disconnected");
  }
  if (ctx.timeRange) {
    parts.push(`Stats time range: ${String(ctx.timeRange)}`);
  }
  if (ctx.statsTotals && typeof ctx.statsTotals === "object") {
    const t = ctx.statsTotals;
    parts.push(
        "Stats totals: " +
        `${Number(t.invoicesProcessed || 0)} invoices processed, ` +
        `${Number(t.workflowsCompleted || 0)} workflows completed, ` +
        `${Number(t.invoicesWithAddedCharges || 0)} with added charges, ` +
        `${Number(t.emailsReplied || 0)} emails replied, ` +
        `${Number(t.emailsForwarded || 0)} forwarded for review`,
    );
  }
  if (typeof ctx.openTaskCount === "number") {
    parts.push(`Open dashboard tasks: ${ctx.openTaskCount}`);
  }
  if (ctx.tms) {
    parts.push(`TMS: ${String(ctx.tms)}`);
  }
  if (!parts.length) {
    return "";
  }
  return "CURRENT DASHBOARD SNAPSHOT: " + parts.join("; ") + ". ";
}

/**
 * OpenAI key for support chat. Firebase deploy strips OPENAI_API_KEY from
 * .env, so production uses SUPPORT_CHAT_OPENAI_API_KEY.
 * @return {string|undefined}
 */
function getSupportChatOpenAiKey() {
  return getFlowSummaryOpenAiKey();
}

/**
 * Runs one dashboard support-chat turn via OpenAI (gpt-5.6-luna by default).
 * Set SUPPORT_CHAT_OPENAI_API_KEY in the functions environment. Optional
 * SUPPORT_CHAT_MODEL overrides the default gpt-5.6-luna.
 *
 * @param {object} opts
 * @param {string} opts.clientName Dashboard client display name.
 * @param {Array<{role: string, content: string}>} opts.history Chat turns.
 * @param {object} [opts.dashboardContext] Optional live dashboard snapshot.
 * @param {object|null} [opts.loadContext] BQ/Firestore load lookup context.
 * @return {Promise<string>} Raw JSON text from the model.
 */
async function runSupportChatTurn({
  clientName,
  history,
  dashboardContext,
  loadContext,
}) {
  const apiKey = getSupportChatOpenAiKey();
  if (!apiKey) {
    throw new Error("SUPPORT_CHAT_OPENAI_API_KEY is not configured");
  }
  const client = new OpenAI({apiKey});
  const model = process.env.SUPPORT_CHAT_MODEL || SUPPORT_CHAT_DEFAULT_MODEL;
  const snapshot = formatSupportChatDashboardContext(dashboardContext);
  const loadSnapshot = formatSupportChatLoadContext(loadContext);
  const hasLoadData = !!(loadContext && (
    loadContext.invoice ||
    loadContext.summary ||
    (loadContext.compactLogs && loadContext.compactLogs.length)
  ));
  const loadInstructions = loadSnapshot ?
    (hasLoadData ?
      "LOAD LOOKUP data is attached below. When the user asks what " +
      "happened to a load, answer from that data immediately in 2–4 " +
      "short sentences: outcome/status, carrier/amount if known, and " +
      "why it stopped if it failed. Do NOT ask whether the number is a " +
      "load or invoice. Do NOT ask what they expected if the records " +
      "already show the outcome. Do NOT claim you lack processing " +
      "details. Stay in status \"asking\" unless they want human " +
      "follow-up. " :
      "The customer asked about a load but no processing records were " +
      "found — say so plainly, suggest it may still be in the mail " +
      "queue or outside the search window, and ask if they have another " +
      "load number or approximate date. Do NOT ask load vs invoice. ") :
    "";
  const systemPrompt =
    `You are the support assistant on ${clientName}'s invoice-` +
    "automation dashboard. Customers come to you when something looks " +
    "wrong — e.g. an invoice they expected to see is missing, the " +
    "stats or chart look off, a reply or forward never went out, or " +
    "Mail inbox shows as disconnected. " +
    SUPPORT_CHAT_PRODUCT_KNOWLEDGE + " " +
    snapshot +
    loadInstructions +
    loadSnapshot +
    (hasLoadData ?
      "LOAD LOOKUP is available — prioritize answering from it. " :
      "Have a natural, brief conversation: ask short, focused " +
      "follow-up questions — one or two at a time — until you have a " +
      "load number or enough to escalate. ") +
    "Answer product and how-it-works questions confidently from the " +
    "product knowledge above. Don't interrogate. " +
    "CRITICAL: Reply with ONLY valid JSON (no markdown, no prose " +
    "outside JSON, no code fences) in this exact shape: " +
    "{\"reply\": string, \"status\": \"asking\" | \"ready\", " +
    "\"summary\": string}. " +
    "\"reply\" is what you say to the customer next — for \"ready\" " +
    "turns, a short, friendly note that you've passed this along. " +
    "\"status\" is \"ready\" only once you can write a complete " +
    "report; otherwise \"asking\". " +
    "\"summary\" stays empty while \"status\" is \"asking\", and — " +
    "only on the turn you switch to \"ready\" — becomes a clear, " +
    "complete written report of the issue for an internal engineer " +
    "(what's wrong, what was expected, key identifying details, and " +
    "any relevant context from the conversation).";

  const completion = await client.chat.completions.create({
    model,
    max_completion_tokens: loadSnapshot ? 1000 : 800,
    response_format: {type: "json_object"},
    messages: [
      {role: "system", content: systemPrompt},
      ...history.map((turn) => ({
        role: turn.role === "assistant" ? "assistant" : "user",
        content: turn.content,
      })),
    ],
  });

  return String(
      completion.choices &&
      completion.choices[0] &&
      completion.choices[0].message &&
      completion.choices[0].message.content || "",
  ).trim();
}

exports.dashboardSupportChat = onRequest(async (req, res) => {
  if (applyDashboardCors(req, res)) {
    return;
  }

  if (req.method !== "POST") {
    return res.status(405).json({ok: false, error: "Use POST."});
  }

  try {
    const body = req.body || {};
    const clientName = String(body.clientName || "Client").slice(0, 120);
    const incoming = Array.isArray(body.messages) ? body.messages : null;

    if (!incoming || incoming.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Request must include a non-empty messages array.",
      });
    }

    const history = incoming
        .slice(-SUPPORT_CHAT_MAX_TURNS)
        .map((turn) => ({
          role: turn && turn.role === "assistant" ? "assistant" : "user",
          content: String((turn && turn.content) || "")
              .slice(0, SUPPORT_CHAT_MAX_MESSAGE_LENGTH),
        }))
        .filter((turn) => turn.content.trim().length > 0);

    if (history.length === 0) {
      return res.status(400).json({ok: false, error: "Empty message."});
    }

    if (!getSupportChatOpenAiKey()) {
      return res.status(503).json({
        ok: false,
        error: "Support chat is not configured " +
          "(SUPPORT_CHAT_OPENAI_API_KEY missing).",
      });
    }

    const tenant = await resolveDashboardTenant(req);
    const extracted = extractSupportChatIdentifiers(
        history
            .filter((turn) => turn.role === "user")
            .map((turn) => turn.content),
    );
    if (body.loadNumber &&
        isValidLoadNumber(normalizeLoadNumber(body.loadNumber))) {
      extracted.loadNumbers.add(normalizeLoadNumber(body.loadNumber));
    }
    if (body.invoiceId) {
      extracted.invoiceIds.add(String(body.invoiceId).trim());
    }
    const dashCtx = body.dashboardContext;
    if (dashCtx && dashCtx.selectedLoadNumber &&
        isValidLoadNumber(normalizeLoadNumber(dashCtx.selectedLoadNumber))) {
      extracted.loadNumbers.add(
          normalizeLoadNumber(dashCtx.selectedLoadNumber),
      );
    }
    if (dashCtx && dashCtx.selectedInvoiceId) {
      extracted.invoiceIds.add(String(dashCtx.selectedInvoiceId).trim());
    }

    const loadNumbers = [...extracted.loadNumbers];
    const invoiceIds = [...extracted.invoiceIds];
    // Prefer the most recently mentioned load; also keep the prior one when
    // the user switches mid-chat (e.g. 266372 then a dashboard row 266499).
    const primaryLoad = loadNumbers.length ?
      loadNumbers[loadNumbers.length - 1] : null;
    const secondaryLoad = loadNumbers.length > 1 ?
      loadNumbers[loadNumbers.length - 2] : null;
    const invoiceId = invoiceIds.length ?
      invoiceIds[invoiceIds.length - 1] : null;

    let loadContext = null;
    if (primaryLoad || invoiceId) {
      try {
        loadContext = await fetchSupportChatLoadContext(tenant, {
          loadNumber: primaryLoad,
          invoiceId,
        });
      } catch (lookupErr) {
        console.error(
            "[dashboardSupportChat] Load lookup failed:",
            lookupErr,
        );
      }
    }
    if (secondaryLoad && secondaryLoad !== primaryLoad) {
      try {
        const prior = await fetchSupportChatLoadContext(tenant, {
          loadNumber: secondaryLoad,
        });
        if (prior && (prior.invoice || prior.summary ||
            (prior.compactLogs && prior.compactLogs.length))) {
          if (loadContext) {
            loadContext.priorLoadContext = prior;
          } else {
            loadContext = prior;
          }
        }
      } catch (priorErr) {
        console.error(
            "[dashboardSupportChat] Prior load lookup failed:",
            priorErr && priorErr.message ? priorErr.message : priorErr,
        );
      }
    }

    const rawText = await runSupportChatTurn({
      clientName,
      history,
      dashboardContext: body.dashboardContext,
      loadContext,
    });

    const parsed = parseSupportChatAiResponse(rawText);

    const reply = String(parsed.reply || "").trim() ||
      "Could you tell me a bit more about what you're seeing?";
    const isReady = parsed.status === "ready" &&
      String(parsed.summary || "").trim().length > 0;

    if (isReady) {
      try {
        await sendSupportIssueEmail({
          clientName,
          summary: String(parsed.summary).trim(),
          transcript: history.concat(
              [{role: "assistant", content: reply}],
          ),
        });
      } catch (emailErr) {
        console.error(
            "[dashboardSupportChat] Failed to email issue summary:",
            emailErr,
        );
      }
    }

    return res.json({ok: true, reply, done: isReady});
  } catch (error) {
    console.error("dashboardSupportChat error:", error);
    const msg = error && error.message ?
      String(error.message) : "Unknown error";
    if (/SUPPORT_CHAT_OPENAI_API_KEY is not configured/i.test(msg)) {
      return res.status(503).json({
        ok: false,
        error: "Support chat is not configured " +
          "(SUPPORT_CHAT_OPENAI_API_KEY missing).",
      });
    }
    return res.status(500).json({
      ok: false,
      error: "The support chat is temporarily unavailable. Please try " +
        "again shortly.",
      details: msg.slice(0, 300),
    });
  }
});

/**
 * Polls a single tenant's Gmail inbox and processes new invoice emails. The
 * tenant determines which Gmail account is read, which collections data is
 * written to, and which TMS workflow runs. All logging is bound to the tenant
 * via async-local context.
 * @param {object} tenant Tenant config.
 * @param {string} inboxFlowId Flow id for this inbox-check run.
 * @param {object} [options] Per-run options.
 * @param {boolean} [options.quietIfDisconnected] Skip warn log when OAuth
 *   tokens are missing (scheduled runs).
 * @return {Promise<object>} {connected, processed}.
 */
async function checkGmailInboxForTenant(tenant, inboxFlowId, options = {}) {
  return runWithTenant(tenant, async () => {
    const mailLabel = mailProvider.providerLabel();
    const gmail = await getTenantGmailClient(tenant);
    if (!gmail) {
      if (options.quietIfDisconnected) {
        console.log(
            `[${tenant.tenantId}] ${mailLabel} not connected — skipping`);
      } else {
        await writeLog("warn", "mail",
            `${mailLabel} is not connected for tenant ${tenant.tenantId}`);
      }
      return {connected: false, processed: 0};
    }

    await writeLog(
        "info",
        "mail",
        `Fetching messages from ${mailLabel}`,
        {
          flowId: inboxFlowId,
          currentStep: "mail_inbox_check",
          tenantId: tenant.tenantId,
        },
    );

    const qAfter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const gmailQuery = [
      "in:inbox",
      "is:unread",
      `after:${qAfter.getFullYear()}/${
        qAfter.getMonth() + 1}/${qAfter.getDate()}`,
    ].join(" ");

    const messages = [];
    let pageToken = null;

    // Safety cap to avoid hitting function timeouts if inbox is flooded.
    const maxMessagesPerRun = 50;

    do {
      const listResponse = await gmail.users.messages.list({
        userId: "me",
        q: gmailQuery,
        maxResults: 50,
        includeSpamTrash: false,
        pageToken: pageToken || undefined,
      });

      const batch = listResponse.data.messages || [];
      messages.push(...batch);
      pageToken = listResponse.data.nextPageToken || null;

      if (messages.length >= maxMessagesPerRun) {
        messages.splice(maxMessagesPerRun);
        pageToken = null;
      }
    } while (pageToken);

    await writeLog(
        "info",
        "mail",
        `Found ${messages.length} new invoice email(s)`,
        {
          flowId: inboxFlowId,
          currentStep: "mail_inbox_check",
          messageCount: messages.length,
          tenantId: tenant.tenantId,
        },
    );

    console.log(
        `[${tenant.tenantId}] Found ${messages.length} new invoice email(s).`);

    let discovered = 0;

    for (const message of messages) {
      try {
        if (await mailIntakeQueue.isAlreadyDiscovered(tenant, message.id)) {
          await writeLog("info", "mail",
              `Skipping already-discovered message ${message.id}`);
          await markGmailMessageRead(gmail, message.id);
          continue;
        }

        const headers = await fetchGmailMessageHeaders(gmail, message.id);
        const enq = await mailIntakeQueue.enqueueDiscoveredEmail({
          tenant,
          messageId: message.id,
          subject: headers.subject,
          from: headers.from,
          inboxFlowId,
        });

        if (enq.ok) {
          discovered += 1;
          await writeLog("info", "mail", "Discovered and queued email", {
            messageId: message.id,
            subject: headers.subject,
            from: headers.from,
          });
          await markGmailMessageRead(gmail, message.id);
        } else if (enq.reason === "already_discovered") {
          await markGmailMessageRead(gmail, message.id);
        } else {
          await writeLog("warn", "mail",
              "Failed to enqueue discovered email", {
                messageId: message.id,
                reason: enq.reason,
              });
        }
      } catch (error) {
        await writeLog("error", "mail", "Error discovering message", {
          messageId: message.id,
          error: error.message,
          stack: error.stack,
        });
        console.error(`Error discovering message ${message.id}:`, error);
      }
    }

    await writeLog("info", "mail", mailProvider.inboxCheckCompletedMessage(), {
      discoveredMessages: discovered,
      listedMessages: messages.length,
      tenantId: tenant.tenantId,
    });
    return {connected: true, discovered, processed: discovered};
  });
}

const PRIMUS_SESSION_RENEWAL_MS = 12 * 60 * 60 * 1000;

/**
 * Renews the Primus manage.php session at most once every 12 hours.
 * Runs from checkGmailInbox so we avoid a separate scheduled function.
 */
async function renewPrimusUiSessionIfDue() {
  const bridge = require("./primus-ui-bridge");
  if (!bridge.isManagePhpEnabled()) return;
  const ref = db.collection("settings").doc("primusUiSessionRenewal");
  const snap = await ref.get();
  const lastRunMs = snap.exists && snap.data().lastRunAt &&
    snap.data().lastRunAt.toDate ?
    snap.data().lastRunAt.toDate().getTime() : 0;
  if (Date.now() - lastRunMs < PRIMUS_SESSION_RENEWAL_MS) return;
  const result = await bridge.renewUiSession();
  if (result.skipped) return;
  if (result.ok) {
    await ref.set(
        {lastRunAt: admin.firestore.FieldValue.serverTimestamp()},
        {merge: true},
    );
    return;
  }
  console.error("renewPrimusUiSessionIfDue failed:", result.error);
}

/** Stale inbox lock expires so a crashed run cannot block forever. */
const INBOX_CHECK_LOCK_MS = 15 * 60 * 1000;
/** Queue drain skip timezone (matches ops: no Friday/Saturday processing). */
const MAIL_QUEUE_DRAIN_TZ = "America/Jamaica";

/**
 * True on Friday or Saturday in America/Jamaica. Inbox polling can still
 * run; queue drain (process + send) is skipped those days.
 * @param {Date} [now] Clock to evaluate.
 * @return {boolean}
 */
function isMailQueueDrainSkipDay(now = new Date()) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: MAIL_QUEUE_DRAIN_TZ,
    weekday: "short",
  }).format(now);
  return weekday === "Fri" || weekday === "Sat";
}

/**
 * @param {object} tenant Tenant config.
 * @param {string} flowId Inbox run id.
 * @return {Promise<object>} {ok, reason?}
 */
async function claimInboxCheckLock(tenant, flowId) {
  const ref = db.collection("settings")
      .doc(`inboxCheckLock_${tenant.tenantId}`);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Date.now();
      if (snap.exists) {
        const data = snap.data() || {};
        const lockedAt = data.lockedAt && data.lockedAt.toDate ?
          data.lockedAt.toDate().getTime() : 0;
        if (lockedAt && now - lockedAt < INBOX_CHECK_LOCK_MS) {
          return {ok: false, reason: "already_running"};
        }
      }
      tx.set(ref, {
        lockedAt: admin.firestore.FieldValue.serverTimestamp(),
        lockedBy: flowId,
        tenantId: tenant.tenantId,
      });
      return {ok: true};
    });
  } catch (err) {
    return {ok: false, reason: "lock_error", error: err.message};
  }
}

/**
 * @param {object} tenant Tenant config.
 * @param {string} flowId Inbox run id.
 * @return {Promise<void>}
 */
async function releaseInboxCheckLock(tenant, flowId) {
  const ref = db.collection("settings")
      .doc(`inboxCheckLock_${tenant.tenantId}`);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      if ((snap.data() || {}).lockedBy === flowId) {
        tx.delete(ref);
      }
    });
  } catch (err) {
    console.error("releaseInboxCheckLock failed:", err.message);
  }
}

/**
 * @param {object} tenant Tenant config.
 * @param {string} flowId Queue run id.
 * @return {Promise<object>} {ok, reason?}
 */
async function claimQueueProcessLock(tenant, flowId) {
  const ref = db.collection("settings")
      .doc(`queueProcessLock_${tenant.tenantId}`);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Date.now();
      if (snap.exists) {
        const data = snap.data() || {};
        const lockedAt = data.lockedAt && data.lockedAt.toDate ?
          data.lockedAt.toDate().getTime() : 0;
        if (lockedAt && now - lockedAt < QUEUE_PROCESS_LOCK_MS) {
          return {ok: false, reason: "already_running"};
        }
      }
      tx.set(ref, {
        lockedAt: admin.firestore.FieldValue.serverTimestamp(),
        lockedBy: flowId,
        tenantId: tenant.tenantId,
      });
      return {ok: true};
    });
  } catch (err) {
    return {ok: false, reason: "lock_error", error: err.message};
  }
}

/**
 * @param {object} tenant Tenant config.
 * @param {string} flowId Queue run id.
 * @return {Promise<void>}
 */
async function releaseQueueProcessLock(tenant, flowId) {
  const ref = db.collection("settings")
      .doc(`queueProcessLock_${tenant.tenantId}`);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      if ((snap.data() || {}).lockedBy === flowId) {
        tx.delete(ref);
      }
    });
  } catch (err) {
    console.error("releaseQueueProcessLock failed:", err.message);
  }
}

/**
 * @param {Promise<*>} promise Operation to bound.
 * @param {number} ms Timeout in milliseconds.
 * @param {string} label Error label.
 * @return {Promise<*>}
 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
    }),
  ]);
}

/**
 * Polls every active tenant inbox (or one tenant when tenantId is set).
 * @param {object} [options] Run options.
 * @param {string} [options.tenantId] Single-tenant poll.
 * @param {boolean} [options.quietIfDisconnected] Skip warn logs when inbox
 *   OAuth is not connected (for scheduled runs).
 * @return {Promise<Array<object>>} Per-tenant {tenantId, connected, processed}.
 */
async function runMailInboxCheck(options = {}) {
  await renewPrimusUiSessionIfDue();

  await logWorkflowStep({
    stepName: "inbox_poll_started",
    stepStatus: "started",
  });

  await writeLog("info", "mail", "Starting inbox check");

  const inboxFlowId = crypto.randomUUID ?
    crypto.randomUUID() :
    `inbox-${Date.now()}`;

  let tenants;
  if (options.tenantId) {
    tenants = [await getTenant(String(options.tenantId))];
  } else {
    tenants = await getActiveTenants();
  }

  const results = [];
  for (const tenant of tenants) {
    const lock = await claimInboxCheckLock(tenant, inboxFlowId);
    if (!lock.ok) {
      await writeLog("info", "mail",
          "Inbox check skipped — another run is in progress", {
            tenantId: tenant.tenantId,
            reason: lock.reason,
          });
      results.push({
        tenantId: tenant.tenantId,
        skipped: true,
        reason: lock.reason,
      });
      continue;
    }
    try {
      const r = await checkGmailInboxForTenant(tenant, inboxFlowId, {
        quietIfDisconnected: Boolean(options.quietIfDisconnected),
      });
      let queueResult = {processed: 0, connected: false};
      if (r.connected) {
        if (isMailQueueDrainSkipDay()) {
          await writeLog("info", "mail",
              "Queue drain skipped — Friday/Saturday (America/Jamaica)", {
                tenantId: tenant.tenantId,
              });
          queueResult = {
            processed: 0,
            connected: true,
            skipped: true,
            reason: "weekend_drain_skip",
          };
        } else {
          queueResult = await runMailQueueProcessForTenant(
              tenant, inboxFlowId);
        }
      }
      results.push({
        tenantId: tenant.tenantId,
        ...r,
        queueProcessed: queueResult.processed,
      });
    } catch (tenantErr) {
      console.error(
          `runMailInboxCheck tenant ${tenant.tenantId} failed:`,
          tenantErr);
      results.push({
        tenantId: tenant.tenantId,
        error: tenantErr.message,
      });
    } finally {
      await releaseInboxCheckLock(tenant, inboxFlowId);
    }
  }
  return results;
}

exports.checkGmailInbox = onRequest(
    {invoker: "public", timeoutSeconds: 540, memory: "1GiB"},
    async (req, res) => {
      try {
        const opts = {
          tenantId: req.query.tenantId || null,
          quietIfDisconnected: req.query.quietIfDisconnected === "true",
        };
        const asyncMode = req.query.async === "1" || req.query.async === "true";
        if (asyncMode) {
          // Fire-and-forget only when explicitly requested — otherwise Cloud
          // Run may terminate the instance after the HTTP response is sent,
          // leaving emails marked read but never fully processed.
          res.status(202).json({ok: true, started: true, async: true});
          runMailInboxCheck(opts).catch((error) => {
            console.error("checkGmailInbox background error:", error);
          });
          return undefined;
        }
        const results = await runMailInboxCheck(opts);
        return res.json({ok: true, tenants: results});
      } catch (error) {
        console.error("checkGmailInbox error:", error);
        return res.status(500).json({
          ok: false,
          error: "Internal server error",
          details: error.message,
        });
      }
    },
);

exports.checkMailInbox = exports.checkGmailInbox;

/**
 * Clears prior intake state so a Gmail message can be processed again.
 * @param {string} messageId Gmail message ID.
 * @param {object} [tenant] Tenant config.
 * @return {Promise<void>}
 */
async function resetGmailMessageForReprocessing(
    messageId,
    tenant = DEFAULT_TENANT,
) {
  const intakeRef = tcol(tenant, "emailIntake").doc(messageId);
  const intakeSnap = await intakeRef.get();
  const preserved = intakeSnap.exists ? {
    manualLoadNumber: intakeSnap.data().manualLoadNumber || null,
    manualLoadItemIndex: intakeSnap.data().manualLoadItemIndex,
    manualLoadEnteredBy: intakeSnap.data().manualLoadEnteredBy || null,
    manualLoadEnteredAt: intakeSnap.data().manualLoadEnteredAt || null,
    pendingLoadEntry: intakeSnap.data().pendingLoadEntry || null,
    inboxFlowId: intakeSnap.data().inboxFlowId || null,
  } : null;

  await intakeRef.delete();

  if (preserved && preserved.manualLoadNumber) {
    await intakeRef.set({
      gmailMessageId: messageId,
      tenantId: tenant.tenantId,
      ...preserved,
      status: "reprocessing",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
  }

  const queueRef = tcol(tenant, "gmailQueue").doc(messageId);
  const queueSnap = await queueRef.get();
  if (queueSnap.exists) {
    await queueRef.set({
      status: "queued",
      intakeStatus: "queued",
      summary: null,
      finalStatus: null,
      outcome: null,
      itemSummaries: [],
      reprocessRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
  }
}

/**
 * Re-runs intake for one Gmail message (e.g. after a classifier fix).
 * @param {object} tenant Tenant config.
 * @param {string} messageId Gmail message ID.
 * @param {string} inboxFlowId Flow id for this run.
 * @return {Promise<object>}
 */
async function reprocessGmailMessageForTenant(tenant, messageId, inboxFlowId) {
  return runWithTenant(tenant, async () => {
    const gmail = await getTenantGmailClient(tenant);
    if (!gmail) {
      return {connected: false, processed: 0, error: "Mail not connected"};
    }
    await resetGmailMessageForReprocessing(messageId, tenant);
    const lastKnownLoadNumber = await getLastKnownLoadNumber(tenant);
    await writeLog("info", "mail", "Reprocessing mail message", {
      messageId,
      tenantId: tenant.tenantId,
    });
    await processGmailMessage(
        gmail,
        {id: messageId},
        inboxFlowId,
        lastKnownLoadNumber,
        {fromQueue: true, queueDocId: messageId, tenant},
    );
    return {connected: true, processed: 1, messageId};
  });
}

/**
 * Resets queue items left in "processing" after a crash or timeout.
 * @param {object} tenant Tenant config.
 * @return {Promise<number>} Count of stale items reset to queued.
 */
async function recoverStaleGmailQueueItems(tenant) {
  const staleSnap = await tcol(tenant, "gmailQueue")
      .where("status", "==", "processing")
      .limit(20)
      .get();
  let recovered = 0;
  for (const staleDoc of staleSnap.docs) {
    if (isStaleGmailQueueProcessing(staleDoc.data() || {})) {
      const didRecover = await recoverStaleGmailQueueItem(staleDoc.id, tenant);
      if (didRecover) recovered += 1;
    }
  }
  return recovered;
}

/**
 * Emails Lisa when a mail intake item exhausted all retry attempts.
 * @param {object} tenant Tenant config.
 * @param {object} opts messageId, subject, from, error, failedRetryCount.
 * @return {Promise<object>}
 */
async function notifyLisaPermanentMailIntakeFailure(tenant, opts = {}) {
  const podFollowup = require("./pod-followup");
  const lisa = String(
      process.env.LOW_PROFIT_CC_EMAIL || podFollowup.LISA_EMAIL,
  ).trim();
  const subject = String(opts.subject || "").trim() || "(no subject)";
  const from = String(opts.from || "").trim() || "(unknown sender)";
  const messageId = String(opts.messageId || "").trim();
  const errorText = String(opts.error || "Unknown error").slice(0, 500);
  const retries = Number(opts.failedRetryCount || FAILED_REQUEUE_MAX_ATTEMPTS);

  const html =
    `<p>Hi Lisa,</p>` +
    `<p>Jerry could not read an inbox email after ` +
    `<strong>${retries}</strong> automatic retries. The message may have ` +
    `been deleted from Outlook or has an invalid message id.</p>` +
    `<table style="border-collapse:collapse;font-size:14px;margin:12px 0">` +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">From</td>` +
    `<td>${escapeHtml(from)}</td></tr>` +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">Subject</td>` +
    `<td>${escapeHtml(subject)}</td></tr>` +
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600">Retries</td>` +
    `<td>${escapeHtml(String(retries))}</td></tr>` +
    `</table>` +
    `<p style="font-size:13px;color:#374151"><strong>Error:</strong> ` +
    `${escapeHtml(errorText)}</p>` +
    `<p style="font-size:13px;color:#6b7280">Search the accounting inbox ` +
    `for this sender/subject. If the email is gone, re-forward the invoice ` +
    `or ignore if it was Teams noise / a test message.</p>`;

  await saveOutboundEmail({
    type: "mail_intake_permanent_failure",
    forceRecipient: true,
    to: lisa,
    subject: `Inbox email failed — ${subject.slice(0, 72)}`,
    html,
    tenant,
  });

  await writeLog("info", "email",
      "Permanent mail intake failure alert sent to Lisa", {
        messageId: messageId || null,
        to: lisa,
        subject,
        from,
        failedRetryCount: retries,
      });

  return {ok: true, to: lisa, subject, from};
}

/**
 * One-time Lisa alert when a parent intake item hits the retry cap.
 * @param {object} tenant Tenant config.
 * @param {FirebaseFirestore.DocumentSnapshot} doc gmailQueue doc.
 * @param {object} data gmailQueue fields.
 * @return {Promise<void>}
 */
async function maybeNotifyPermanentMailIntakeFailure(tenant, doc, data) {
  if (mailIntakeQueue.isChildQueueDocId(doc.id)) return;
  if (data.permanentFailureNotifiedAt) return;

  const messageId = String(data.gmailMessageId || doc.id);
  let subject = String(data.subject || "").trim();
  let from = String(data.from || "").trim();
  if (!subject || !from) {
    try {
      const intakeSnap = await tcol(tenant, "emailIntake").doc(messageId).get();
      const intake = intakeSnap.data() || {};
      if (!subject) subject = String(intake.subject || "").trim();
      if (!from) from = String(intake.from || "").trim();
    } catch (_) {
      // Best-effort enrichment only.
    }
  }

  await notifyLisaPermanentMailIntakeFailure(tenant, {
    messageId,
    subject,
    from,
    error: data.error || data.summary || "",
    failedRetryCount: Number(
        data.failedRetryCount || FAILED_REQUEUE_MAX_ATTEMPTS),
  });

  const notifiedAt = admin.firestore.FieldValue.serverTimestamp();
  await doc.ref.set({permanentFailureNotifiedAt: notifiedAt}, {merge: true});
  await tcol(tenant, "emailIntake").doc(messageId).set(
      {permanentFailureNotifiedAt: notifiedAt}, {merge: true});
}

/**
 * Requeues failed mail items for retry (Graph 429, transient errors, etc.).
 * After {@link FAILED_REQUEUE_MAX_ATTEMPTS} failures, Lisa is notified once.
 * @param {object} tenant Tenant config.
 * @param {object} [opts] force: skip cooldown (manual recovery).
 * @return {Promise<number>} Count reset to queued.
 */
async function recoverFailedGmailQueueItems(tenant, opts = {}) {
  const force = Boolean(opts.force);
  let recovered = 0;
  const now = Date.now();
  let lastDoc = null;

  for (;;) {
    let query = tcol(tenant, "gmailQueue")
        .where("status", "==", "failed")
        .limit(FAILED_REQUEUE_BATCH_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);
    const failedSnap = await query.get();
    if (failedSnap.empty) break;

    for (const doc of failedSnap.docs) {
      const data = doc.data() || {};
      const attempts = Number(data.failedRetryCount || 0);
      if (!force && attempts >= FAILED_REQUEUE_MAX_ATTEMPTS) {
        try {
          await maybeNotifyPermanentMailIntakeFailure(tenant, doc, data);
        } catch (notifyErr) {
          await writeLog("warn", "email",
              "Permanent mail intake failure alert failed", {
                messageId: doc.id,
                error: notifyErr.message,
              });
        }
        continue;
      }
      const finishedMs = data.failedAt && data.failedAt.toDate ?
        data.failedAt.toDate().getTime() :
        (data.finishedAt && data.finishedAt.toDate ?
          data.finishedAt.toDate().getTime() : 0);
      const updatedMs = data.updatedAt && data.updatedAt.toDate ?
        data.updatedAt.toDate().getTime() : 0;
      const lastFailMs = finishedMs || updatedMs || 0;
      if (!force && lastFailMs && now - lastFailMs < FAILED_REQUEUE_MIN_MS) {
        continue;
      }
      const messageId = String(data.gmailMessageId || doc.id);
      const retryCount = Number(data.failedRetryCount || 0) + 1;
      const patch = {
        status: "queued",
        intakeStatus: "queued",
        failedRetryCount: retryCount,
        failedRequeuedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        error: admin.firestore.FieldValue.delete(),
      };
      await doc.ref.set(patch, {merge: true});
      if (mailIntakeQueue.isChildQueueDocId(doc.id)) {
        await writeLog("info", "mail",
            "Requeued failed split-invoice child for retry", {
              queueDocId: doc.id,
              parentMessageId: data.parentMessageId || messageId,
              itemIndex: data.itemIndex,
              tenantId: tenant.tenantId,
              failedRetryCount: retryCount,
              force,
            });
      } else {
        await tcol(tenant, "emailIntake").doc(messageId)
            .set(patch, {merge: true});
        await writeLog("info", "mail",
            "Requeued failed mail item for retry", {
              messageId,
              tenantId: tenant.tenantId,
              failedRetryCount: retryCount,
              force,
            });
      }
      recovered += 1;
    }

    lastDoc = failedSnap.docs[failedSnap.docs.length - 1];
    if (failedSnap.size < FAILED_REQUEUE_BATCH_SIZE) break;
  }

  return recovered;
}

/**
 * @param {object} tenant Tenant config.
 * @param {string} inboxFlowId Flow id for this queue run.
 * @return {Promise<object>} {connected, processed}.
 */
async function processGmailQueueForTenant(tenant, inboxFlowId) {
  return runWithTenant(tenant, async () => {
    const gmail = await getTenantGmailClient(tenant);
    if (!gmail) {
      await writeLog("warn", "mail",
          `Mail is not connected for tenant ${tenant.tenantId}`);
      return {connected: false, processed: 0};
    }

    const runStarted = Date.now();
    const lastKnownLoadNumber = await getLastKnownLoadNumber(tenant);
    let processed = 0;

    while (Date.now() - runStarted < MAIL_QUEUE_RUN_BUDGET_MS) {
      await recoverFailedGmailQueueItems(tenant);
      await recoverStaleGmailQueueItems(tenant);

      const queueSnap = await tcol(tenant, "gmailQueue")
          .where("status", "==", "queued")
          .orderBy("claimedAt")
          .limit(MAIL_QUEUE_PROCESS_BATCH_SIZE)
          .get();

      if (queueSnap.empty) break;

      await writeLog("info", "mail", "Fetched queued mail messages", {
        queueCount: queueSnap.size,
        tenantId: tenant.tenantId,
      });

      let budgetReached = false;
      for (const doc of queueSnap.docs) {
        if (Date.now() - runStarted >= MAIL_QUEUE_RUN_BUDGET_MS) {
          budgetReached = true;
          await writeLog("info", "mail",
              "Stopping queue batch — run time budget reached", {
                tenantId: tenant.tenantId,
                processedThisRun: processed,
              });
          break;
        }

        const queueItem = doc.data() || {};
        const queueDocId = doc.id;
        const gmailMessageId = queueItem.gmailMessageId ||
          (mailIntakeQueue.isChildQueueDocId(queueDocId) ?
            queueDocId.replace(/__item_\d+$/, "") : queueDocId);
        try {
          const claimed = await claimGmailQueueItem(queueDocId, tenant);
          if (!claimed) {
            const skippedClaimedMessage =
                "Skipped queue item already claimed or no longer queued";
            await writeLog("warn", "mail", skippedClaimedMessage, {
              messageId: queueDocId,
            });
            continue;
          }

          await mailIntakeQueue.markIntakeProcessing(tenant, queueDocId);

          await processGmailMessage(
              gmail,
              {
                id: gmailMessageId,
                subject: queueItem.subject,
                from: queueItem.from,
              },
              inboxFlowId,
              lastKnownLoadNumber,
              {
                fromQueue: true,
                queueDocId,
                parentMessageId: gmailMessageId,
                processSingleItemIndex: queueItem.itemIndex,
                queueDocRef: doc.ref,
                tenant,
              },
          );
          processed += 1;
        } catch (error) {
          await writeLog("error", "mail", "Queued message failed", {
            messageId: queueDocId,
            gmailMessageId,
            error: error.message,
            stack: error.stack,
          });
        }
      }

      if (budgetReached || queueSnap.size < MAIL_QUEUE_PROCESS_BATCH_SIZE) {
        break;
      }
    }

    return {connected: true, processed};
  });
}

/**
 * Processes the mail queue under a per-tenant lock (one worker at a time).
 * @param {object} tenant Tenant config.
 * @param {string} flowId Queue run id.
 * @return {Promise<object>} {connected, processed, skipped?, reason?}
 */
async function runMailQueueProcessForTenant(tenant, flowId) {
  const lock = await claimQueueProcessLock(tenant, flowId);
  if (!lock.ok) {
    await writeLog("info", "mail",
        "Mail queue processing skipped — another run is in progress", {
          tenantId: tenant.tenantId,
          reason: lock.reason,
        });
    return {
      connected: true,
      processed: 0,
      skipped: true,
      reason: lock.reason,
    };
  }
  try {
    return await processGmailQueueForTenant(tenant, flowId);
  } finally {
    await releaseQueueProcessLock(tenant, flowId);
  }
}

exports.processGmailQueue = onRequest(
    {timeoutSeconds: 1800, memory: "1GiB"},
    async (req, res) => {
      try {
        await writeLog("info", "mail", "Starting mail queue processing");

        const inboxFlowId = crypto.randomUUID ?
          crypto.randomUUID() :
          `queue-${Date.now()}`;

        let tenants;
        if (req.query.tenantId) {
          tenants = [await getTenant(String(req.query.tenantId))];
        } else {
          tenants = await getActiveTenants();
        }

        const reprocessMessageId = req.query.reprocessMessageId ?
          String(req.query.reprocessMessageId).trim() : "";
        const forceDrain = req.query.force === "1" ||
          req.query.force === "true";
        if (!reprocessMessageId && !forceDrain && isMailQueueDrainSkipDay()) {
          await writeLog("info", "mail",
              "Mail queue drain skipped — Friday/Saturday (America/Jamaica)");
          return res.json({
            ok: true,
            skipped: true,
            reason: "weekend_drain_skip",
          });
        }

        const results = [];
        for (const tenant of tenants) {
          try {
            if (reprocessMessageId) {
              const r = await reprocessGmailMessageForTenant(
                  tenant, reprocessMessageId, inboxFlowId);
              results.push({tenantId: tenant.tenantId, ...r});
              continue;
            }
            const r = await runMailQueueProcessForTenant(
                tenant, inboxFlowId);
            results.push({tenantId: tenant.tenantId, ...r});
          } catch (tenantErr) {
            console.error(
                `processGmailQueue tenant ${tenant.tenantId} failed:`,
                tenantErr);
            results.push({
              tenantId: tenant.tenantId,
              error: tenantErr.message,
            });
          }
        }

        return res.json({ok: true, tenants: results});
      } catch (error) {
        console.error("processGmailQueue error:", error);
        return res.status(500).json({
          ok: false,
          error: "Internal server error",
          details: error.message,
        });
      }
    },
);

exports.bulkRequeueInbox = onRequest(
    {invoker: "public", timeoutSeconds: 540, memory: "1GiB"},
    async (req, res) => {
      try {
        const sinceRaw = String(req.query.since || "").trim();
        if (!sinceRaw) {
          return res.status(400).json({
            ok: false,
            error: "Missing since query param (ISO datetime)",
          });
        }
        const since = new Date(sinceRaw);
        if (isNaN(since.getTime())) {
          return res.status(400).json({
            ok: false,
            error: `Invalid since: ${sinceRaw}`,
          });
        }

        const untilRaw = String(req.query.until || "").trim();
        let until = null;
        if (untilRaw) {
          until = new Date(untilRaw);
          if (isNaN(until.getTime())) {
            return res.status(400).json({
              ok: false,
              error: `Invalid until: ${untilRaw}`,
            });
          }
        }

        const tenantId = String(req.query.tenantId || "default");
        const tenant = await getTenant(tenantId);
        const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
        const readAfter =
          req.query.readAfter === "1" || req.query.readAfter === "true";
        const readMode = String(
            req.query.readMode || "openedSince").toLowerCase();
        if (readAfter && !until &&
            readMode !== "openedsince") {
          return res.status(400).json({
            ok: false,
            error:
              "readAfter with readMode=modified|received requires until",
          });
        }
        const scanInbox =
          req.query.scanInbox === "1" || req.query.scanInbox === "true" ||
          readAfter;
        const includeRead =
          req.query.includeRead === "1" ||
          req.query.includeRead === "true" || readAfter;
        const skipQueued =
          req.query.skipQueued === "1" || req.query.skipQueued === "true";

        await writeLog("info", "mail", "Bulk requeue inbox started", {
          tenantId,
          since: since.toISOString(),
          until: until ? until.toISOString() : null,
          dryRun,
          readAfter,
          scanInbox,
          readMode,
          skipQueued,
        });

        const summary = await runWithTenant(tenant, () =>
          runBulkRequeue({
            tenant,
            since,
            until,
            dryRun,
            scanInbox,
            includeRead,
            readAfter,
            readMode,
            skipQueued,
            db,
          }),
        );

        if (summary.error) {
          return res.status(400).json({ok: false, summary});
        }

        if (summary.mailError === "mail_not_connected") {
          return res.status(503).json({
            ok: false,
            error: "Mail inbox is not connected for this tenant",
            summary,
          });
        }

        return res.json({ok: true, summary});
      } catch (error) {
        console.error("bulkRequeueInbox error:", error);
        return res.status(500).json({
          ok: false,
          error: "Internal server error",
          details: error.message,
        });
      }
    },
);

// Primus API — auth token cache (shared within this Cloud Run instance)
let primusTokenCache = null;
let primusTokenExpiry = 0;

/**
 * Returns a valid Primus Bearer token, logging in if needed.
 * @return {Promise<string>} Bearer token.
 */
async function getPrimusToken() {
  const now = Date.now();
  if (primusTokenCache && now < primusTokenExpiry) return primusTokenCache;
  const resp = await fetch(`${process.env.PRIMUS_BASE_URL}/login`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      username: process.env.PRIMUS_USERNAME,
      password: process.env.PRIMUS_PASSWORD,
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Primus login failed ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  const token = (data.data && data.data.accessToken) ||
      (data.data && data.data.token) ||
      data.accessToken || data.token || data.access_token;
  if (!token) throw new Error("Primus login: no token in response");
  primusTokenCache = token;
  primusTokenExpiry = now + 23 * 60 * 60 * 1000;
  return token;
}

/**
 * Makes an authenticated request to the Primus API.
 * Retries transient 5xx responses and network faults (same pattern as
 * manage.php posts) so a momentary Primus outage does not stop billing.
 * @param {string} method HTTP method.
 * @param {string} path API path (appended to PRIMUS_BASE_URL).
 * @param {object} [body] Optional request body.
 * @return {Promise<object|null>} Parsed response or null on 404.
 */
async function primusRequest(method, path, body) {
  const maxAttempts = workflowErrors.PRIMUS_API_RETRY_ATTEMPTS || 3;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const token = await getPrimusToken();
      const opts = {
        method,
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      };
      if (body !== undefined) opts.body = JSON.stringify(body);
      const resp = await fetch(`${process.env.PRIMUS_BASE_URL}${path}`, opts);
      if (resp.status === 204) return {ok: true};
      if (resp.status === 404) return null;
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        const err = new Error(
            `Primus ${method} ${path} → ${resp.status}: ${txt}`);
        if (attempt < maxAttempts &&
            workflowErrors.isTransientPrimusApiError(resp.status, txt)) {
          await writeLog("warn", "primus", "Primus API error — retrying", {
            method,
            path,
            status: resp.status,
            attempt,
            error: txt.slice(0, 300),
          });
          await new Promise((resolve) => setTimeout(resolve,
              workflowErrors.transientRetryDelayMs(attempt)));
          lastErr = err;
          continue;
        }
        throw err;
      }
      return resp.json();
    } catch (err) {
      lastErr = err;
      const msg = err && err.message ? err.message : String(err);
      if (attempt < maxAttempts &&
          workflowErrors.isTransientNetworkError(msg)) {
        await writeLog(
            "warn", "primus", "Primus API network error — retrying", {
              method,
              path,
              attempt,
              error: msg,
            });
        await new Promise((resolve) => setTimeout(resolve,
            workflowErrors.transientRetryDelayMs(attempt)));
        continue;
      }
      throw err;
    }
  }

  throw lastErr || new Error(`Primus ${method} ${path} failed after retries`);
}

/**
 * Reads shipment mode from a Primus booking (GET /book/bolnumber).
 * @param {object|null} booking Primus booking object.
 * @return {string} Mode code/name, or empty string.
 */
function readShipmentMode(booking) {
  if (!booking || typeof booking !== "object") return "";
  const sm = booking.shipmentMode;
  if (typeof sm === "string") return sm.trim();
  if (sm && typeof sm === "object") {
    return String(sm.code || sm.name || sm.description || "").trim();
  }
  if (booking.mode != null) return String(booking.mode).trim();
  return "";
}

/**
 * @param {object|null} booking Primus booking object.
 * @return {boolean} True when Primus marks the load as drayage.
 */
function isDrayageShipment(booking) {
  const mode = readShipmentMode(booking).toLowerCase();
  if (!mode) return false;
  return mode === "drayage" || mode.includes("dray");
}

/**
 * Power Only (tractor-only) loads — trailer photos on the carrier email
 * count as POD.
 * @param {object|null} booking Primus booking object.
 * @return {boolean}
 */
function isPowerOnlyShipment(booking) {
  const mode = readShipmentMode(booking).toLowerCase().replace(/\s+/g, " ");
  if (!mode) return false;
  return mode.includes("power only") || mode.includes("poweronly") ||
    mode === "po";
}

/**
 * Truckload / FTL (not Power Only — that uses trailer-image POD). Used for
 * the missing-POD carrier-chase flow.
 * @param {object|null} booking Primus booking object.
 * @return {boolean}
 */
function isTruckloadShipment(booking) {
  if (isPowerOnlyShipment(booking)) return false;
  const mode = readShipmentMode(booking).toLowerCase().replace(/\s+/g, " ");
  if (!mode) return false;
  return mode === "tl" || mode === "ftl" ||
    mode.includes("truckload") || mode.includes("full truck") ||
    mode.includes("truck load");
}

/**
 * Fetches a Primus booking by BOL/load number.
 * @param {string} loadNumber BOL or load number.
 * @return {Promise<object|null>} Booking object or null.
 */
async function fetchPrimusBooking(loadNumber) {
  const data = await primusRequest(
      "GET", `/book/bolnumber/${encodeURIComponent(loadNumber)}`);
  if (!data) return null;
  const results = data.data && data.data.results;
  return Array.isArray(results) ? (results[0] || null) : (results || null);
}

/**
 * Calls Primus GET /rate (rate shop) with query params. Does not throw on
 * 4xx — returns {ok:false, error} so W&I validation can degrade gracefully.
 * @param {object} params Flat query params (freightInfo already stringified).
 * @return {Promise<object>} {ok, total, quoteNumber, rate, raw, error?}
 */
async function fetchPrimusRate(params) {
  const qs = new URLSearchParams();
  Object.keys(params || {}).forEach((key) => {
    if (params[key] != null && params[key] !== "") {
      qs.set(key, String(params[key]));
    }
  });
  const path = `/rate?${qs.toString()}`;
  try {
    const token = await getPrimusToken();
    const resp = await fetch(`${process.env.PRIMUS_BASE_URL}${path}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
      },
    });
    const text = await resp.text().catch(() => "");
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = null;
    }
    if (!resp.ok) {
      const msg = (json && json.error && json.error.message) ?
        (Array.isArray(json.error.message) ?
          json.error.message.join("; ") : String(json.error.message)) :
        (text || `HTTP ${resp.status}`);
      return {ok: false, error: msg, status: resp.status};
    }
    const results = json && json.data && json.data.results;
    const rate = Array.isArray(results) ? (results[0] || null) : results;
    if (!rate) {
      return {ok: false, error: "Primus /rate returned no results"};
    }
    return {
      ok: true,
      total: Number(rate.total),
      quoteNumber: rate.quoteNumber || null,
      rate,
      raw: json,
    };
  } catch (err) {
    return {ok: false, error: err.message || String(err)};
  }
}

/**
 * Re-rates a W&I invoice against Primus GET /rate using the invoice's
 * updated weight/class on the original booking lane/vendor. Match = within
 * $10 (RATE_MATCH_TOLERANCE) of the carrier invoice total.
 * @param {object} opts booking, invoiceFreight, invoiceAmount.
 * @return {Promise<object>} rateValidation summary for email / Firestore.
 */
async function validateReweighRateWithPrimus(opts) {
  const {booking, invoiceFreight, invoiceAmount} = opts || {};
  const attempted = {
    attempted: true,
    ok: false,
    matched: false,
    tolerance: additionalCharges.RATE_MATCH_TOLERANCE,
    invoiceAmount: Number(invoiceAmount) || null,
    rateTotal: null,
    difference: null,
    quoteNumber: null,
    error: null,
    freightInfo: null,
  };
  if (!booking) {
    attempted.error = "No Primus booking available for re-rate";
    return attempted;
  }
  const freightInfo = additionalCharges.buildRequoteFreightInfo(
      booking, invoiceFreight);
  if (!freightInfo || !freightInfo.length) {
    attempted.error =
      "Missing freight weight for re-rate (invoice and booking empty)";
    return attempted;
  }
  attempted.freightInfo = freightInfo;
  const query = additionalCharges.buildRateQueryFromBooking(
      booking, freightInfo);
  if (!query) {
    attempted.error =
      "Booking missing vendor or origin/destination for re-rate";
    return attempted;
  }
  const rateRes = await fetchPrimusRate(query);
  if (!rateRes.ok) {
    attempted.error = rateRes.error || "Primus /rate failed";
    return attempted;
  }
  const evalResult = additionalCharges.evaluateRequoteMatch({
    invoiceAmount,
    rateTotal: rateRes.total,
    tolerance: additionalCharges.RATE_MATCH_TOLERANCE,
  });
  return {
    attempted: true,
    ok: true,
    matched: evalResult.matched,
    tolerance: evalResult.tolerance,
    invoiceAmount: evalResult.invoiceAmount,
    rateTotal: evalResult.rateTotal,
    difference: evalResult.difference,
    quoteNumber: rateRes.quoteNumber,
    error: null,
    freightInfo,
  };
}

/**
 * Parses a Primus amount string like "* 500.25" to a number.
 * @param {string|number|null} raw Raw value from Primus.
 * @return {number|null} Parsed amount or null.
 */
function parsePrimusAmount(raw) {
  if (raw == null) return null;
  // Primus returns amounts like "* 500.25" — strip non-numeric prefix
  const n = Number(String(raw).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Validates carrier invoice amount against Primus booking's recorded cost.
 * @param {string} loadNumber Load/BOL number.
 * @param {number} amount Invoice amount to validate.
 * @return {Promise<object>} Validation result.
 */
async function validateAmountWithPrimus(loadNumber, amount) {
  const runOnce = async () => {
    const booking = await fetchPrimusBooking(loadNumber);
    if (!booking) {
      return {
        ok: false,
        validAmount: false,
        error: "Load not found in Primus",
      };
    }
    const primusAmount = Number(
        (booking.vendor && booking.vendor.cost) || 0,
    );
    const proNumber = (booking.vendor && booking.vendor.PRO) || "";
    if (!primusAmount) {
      return {
        ok: false,
        validAmount: false,
        error: "No carrier cost on Primus record",
      };
    }
    const submitted = Number(amount);
    const diff = Math.abs(submitted - primusAmount);
    const tolerance = Math.max(0.50, primusAmount * 0.02);
    // Accept when within tolerance, or when the carrier billed at/under the
    // quoted cost — Jerry enters the carrier invoice amount, not the quote.
    const valid = diff <= tolerance || submitted <= primusAmount + 0.01;
    return {
      ok: true,
      validAmount: valid,
      amount: primusAmount,
      primusQuotedAmount: primusAmount,
      submittedAmount: submitted,
      savedAmount: valid ? submitted : primusAmount,
      enteredAmount: valid ? submitted : null,
      difference: diff,
      proNumber,
      reason: valid ?
        (submitted <= primusAmount + 0.01 && submitted < primusAmount - 0.01 ?
          `Carrier billed $${submitted.toFixed(2)} — under Primus quote ` +
          `$${primusAmount.toFixed(2)}; entering carrier amount` :
          "Amount matches") :
        `Submitted $${submitted} vs Primus $${primusAmount}` +
          ` (diff $${diff.toFixed(2)})`,
    };
  };

  try {
    let result = await runOnce();
    const transient = !result.ok && result.error &&
      workflowErrors.isTransientNetworkError(result.error);
    if (transient) {
      await writeLog("warn", "primus",
          "Amount validation fetch failed — retrying once", {
            loadNumber,
            amount,
            error: result.error,
          });
      await new Promise((resolve) => setTimeout(resolve,
          workflowErrors.TRANSIENT_NETWORK_RETRY_MS));
      result = await runOnce();
    }
    return result;
  } catch (error) {
    await writeLog("error", "primus", "Failed to validate amount with Primus", {
      loadNumber,
      amount,
      error: error.message,
    });
    return {ok: false, error: error.message};
  }
}

/**
 * Decides whether AI-flagged extra charges (unrecognized or missing proof)
 * can be auto-approved because the invoice total already matches Primus.
 *
 * Override applies when ANY of:
 *   1. The invoice total is within $10 of Primus's recorded carrier cost
 *      (treat small line-item additives as already covered), OR
 *   2. The invoice total is less than or equal to Primus carrier cost
 *      (line-item "extras" are just breakdown — the bill is not higher), OR
 *   3. Every flagged charge above $5 is already in the Primus vendor
 *      breakdown, or all charges are at/below $5 (nothing net-new to approve).
 *
 * Returns `filtered` with ignorableSmall, alreadyInPrimus, notInPrimus, and
 * chargesForAction when a booking/vendor breakdown is available.
 *
 * @param {string} loadNumber Load/BOL number.
 * @param {number} invoiceAmount Carrier invoice total.
 * @param {Array<object>} unrecognizedCharges AI-flagged extra charges.
 * @return {Promise<object>} Reconciliation result with override flag.
 */
async function reconcileUnrecognizedChargesWithPrimus(
    loadNumber, invoiceAmount, unrecognizedCharges) {
  try {
    const booking = await fetchPrimusBooking(loadNumber);
    if (!booking || !booking.vendor) {
      return {override: false, reason: "no booking/vendor"};
    }
    const vendorCost = Number(booking.vendor.cost || 0);
    const breakdown = Array.isArray(booking.vendor.breakdown) ?
      booking.vendor.breakdown : [];
    const amount = Number(invoiceAmount || 0);
    // Flat $10 band: tiny accessorials (e.g. $0.25 lumper) must not stop
    // billing when the invoice total already matches Primus.
    const TOTAL_TOLERANCE = 10;
    const totalMatches = vendorCost > 0 &&
      Math.abs(amount - vendorCost) <= TOTAL_TOLERANCE;
    // Invoice at/under Primus: AI-flagged line items are not overages.
    const invoiceAtOrUnderPrimus = vendorCost > 0 &&
      amount <= vendorCost + 0.01;

    const charges = Array.isArray(unrecognizedCharges) ?
      unrecognizedCharges : [];
    const filtered = additionalCharges.filterChargesForApproval(
        charges, breakdown);
    const hadCharges = charges.length > 0;
    const allChargesReconciled = hadCharges && filtered.skipApproval;

    return {
      override: totalMatches || invoiceAtOrUnderPrimus || allChargesReconciled,
      vendorCost,
      breakdown,
      booking,
      totalMatches,
      invoiceAtOrUnderPrimus,
      chargesInPrimus: hadCharges &&
        filtered.alreadyInPrimus.length > 0 && filtered.skipApproval,
      filtered,
      tolerance: TOTAL_TOLERANCE,
    };
  } catch (err) {
    return {override: false, error: err.message};
  }
}

/**
 * Updates the PRO number on a Primus booking, and optionally writes carrier
 * invoice metadata (invoice number, due date) to shipmentReference fields.
 * @param {string} loadNumber Load/BOL number.
 * @param {string} proNumber PRO number to set.
 * @param {object} [invoiceData] Optional carrier invoice metadata.
 * @param {string} [invoiceData.invoiceNumber] Carrier invoice number.
 * @param {string} [invoiceData.dueDate] Invoice due date (YYYY-MM-DD).
 * @param {string} [invoiceData.carrierName] Carrier name for notes.
 * @return {Promise<object>} Update result.
 */
async function addProNumberToLoad(loadNumber, proNumber, invoiceData = {}) {
  try {
    const booking = await fetchPrimusBooking(loadNumber);
    if (!booking || !booking.BOLId) {
      return {ok: false, error: "Load not found in Primus"};
    }
    const putBody = {PRONmbr: proNumber};
    if (invoiceData.invoiceNumber || invoiceData.dueDate) {
      const dueDate = invoiceData.dueDate ||
          (() => {
            const d = new Date();
            d.setDate(d.getDate() + 30);
            return d.toISOString().slice(0, 10);
          })();
      putBody.additionalInformation = {
        shipmentReference1: String(invoiceData.invoiceNumber || ""),
        shipmentReference2: dueDate,
      };
    }
    try {
      await primusRequest("PUT", `/book/${booking.BOLId}`, putBody);
    } catch (putErr) {
      // 409 means booking is locked/dispatched — PRO already set, treat as ok
      if (putErr.message && putErr.message.includes("409")) {
        return {ok: true, skipped: true, reason: "Booking locked (409)"};
      }
      throw putErr;
    }
    return {ok: true};
  } catch (error) {
    await writeLog("error", "primus", "Failed to add PRO number to load", {
      loadNumber,
      proNumber,
      error: error.message,
    });
    return {ok: false, error: error.message};
  }
}

/**
 * Reads the customer sell rate from a booking's accountingInformation.
 *
 * Two mutually-exclusive patterns in live data:
 *   1. Quoted loads   — customerQuoteId set → rate in customerQuoteAmount.
 *   2. Manual loads   — customerQuoteId null → rate in invoiceAmount.
 *
 * @param {object} acct accountingInformation from a Primus booking.
 * @return {object} Object with rate (number|null) and source (string).
 */
function readCustomerRateFromAcct(acct) {
  if (!acct) return {rate: null, source: "none"};
  if (acct.customerQuoteId) {
    const rate = parsePrimusAmount(acct.customerQuoteAmount);
    return {rate, source: rate ? "customerQuoteAmount" : "none"};
  }
  const rate = parsePrimusAmount(acct.invoiceAmount);
  return {rate, source: rate ? "invoiceAmount" : "none"};
}

/**
 * Reads the Bill-to Reference# from a Primus booking (Power Only unit number
 * lives here when billTo is third party — see shipment Bill To panel).
 * @param {object|null} booking Primus booking from GET /book.
 * @return {string|null} Trimmed reference text or null.
 */
function readBillToReferenceNumber(booking) {
  if (!booking || typeof booking !== "object") return null;
  const billTo = booking.billTo || "";
  let party = null;
  if (billTo === "thirdparty" && booking.thirdParty) {
    party = booking.thirdParty;
  } else if (booking.shipper) {
    party = booking.shipper;
  } else if (booking.thirdParty) {
    party = booking.thirdParty;
  }
  if (!party) return null;
  const ref = party.referenceNumber;
  const text = ref != null ? String(ref).trim() : "";
  const bridge = require("./primus-ui-bridge");
  const clean = bridge._internal.sanitizeBillToReferenceText(text);
  return clean || null;
}

/**
 * Retrieves customer name and rate from a Primus booking.
 * @param {string} loadNumber Load/BOL number.
 * @param {string} proNumber PRO number (used as fallback search key).
 * @return {Promise<object>} Customer rate result.
 */
async function getCustomerRate(loadNumber, proNumber) {
  try {
    let booking = await fetchPrimusBooking(loadNumber);
    if (!booking && proNumber) {
      booking = await fetchPrimusBookingByPro(proNumber);
    }
    if (!booking) {
      return {ok: false, error: "Load not found in Primus"};
    }
    const acct = booking.accountingInformation || {};
    const {rate: customerRate, source: rateSource} =
        readCustomerRateFromAcct(acct);
    const billTo = booking.billTo || "";
    let customerName = null;
    if (billTo === "thirdparty" && booking.thirdParty) {
      customerName = booking.thirdParty.name || null;
    } else if (booking.shipper) {
      customerName = booking.shipper.name || null;
    }
    if (!customerRate) {
      return {ok: false, customerName, error: "No customer rate in Primus"};
    }
    return {ok: true, customerName, customerRate, rateSource};
  } catch (error) {
    await writeLog("error", "primus", "Failed to get customer rate", {
      loadNumber,
      proNumber,
      error: error.message,
    });
    return {ok: false, error: error.message};
  }
}

/**
 * Logs carrier bill approval intent; Primus payables are created automatically
 * when the booking is dispatched. No dedicated Payables API endpoint is
 * available in the current API version.
 * @param {object} billData Bill approval data.
 * @return {Promise<object>} Approval result.
 */
async function approveCarrierBill(billData) {
  await writeLog(
      "info", "primus",
      "approveCarrierBill: logged for audit trail",
      {
        loadNumber: billData.loadNumber,
        proNumber: billData.proNumber,
        carrierName: billData.carrierName,
        invoiceAmount: billData.invoiceAmount,
        invoiceNumber: billData.invoiceNumber,
      });
  return {ok: true, billId: null, skipped: true};
}

/**
 * Creates a customer invoice in Primus via POST /api/v1/invoice/{BOLId}.
 * @param {object} invoiceData Customer invoice data.
 * @return {Promise<object>} Invoice generation result.
 */
async function generateCustomerInvoice(invoiceData) {
  try {
    const booking = await fetchPrimusBooking(invoiceData.loadNumber);
    if (!booking || !booking.BOLId) {
      return {ok: false, error: "Load not found in Primus"};
    }
    const BOLId = booking.BOLId;
    const expectedRate = Number(invoiceData.customerRate || 0);

    // IDEMPOTENCY GUARD — the #1 safety check.
    // Primus auto-creates a draft customer invoice (already populated with the
    // freight charge and customer) when a load is booked. POSTing again creates
    // a SECOND draft and adds another freight line, doubling
    // accountingInformation.invoiceAmount. So we always look for an existing
    // invoice first and reuse it — we only ever POST when none exists.
    let existing = [];
    try {
      const existingData = await primusRequest(
          "GET",
          `/invoice/bolnumber/${encodeURIComponent(invoiceData.loadNumber)}`);
      const list = existingData && existingData.data &&
          existingData.data.results;
      if (Array.isArray(list)) existing = list;
    } catch (_) {
      // 404 / no invoice yet — fall through to create one.
    }

    if (existing.length > 0) {
      // Prefer a generated (issued) invoice over drafts. Primus auto-creates a
      // draft and we may also create a draft via API — if staff manually issues
      // one in the Primus UI, that issued invoice is the authoritative one.
      const issuedInv = existing.find((e) => e.status && e.status.generated);
      const inv = issuedInv || existing[0];
      if (existing.length > 1) {
        await writeLog(issuedInv ? "info" : "warn", "primus",
            issuedInv ?
              "Multiple invoices found — using the issued one" :
              "Multiple invoice drafts found — using first; " +
              "duplicates need manual cleanup in ShipPrimus", {
              loadNumber: invoiceData.loadNumber,
              BOLId,
              selectedInvoiceId: inv.invoiceId,
              allInvoiceIds: existing.map((e) => e.invoiceId),
            });
      }
      const total = Number(inv.total || 0);
      // AMOUNT SANITY CHECK — compare the draft total against the agreed
      // sell rate. Human-entered rate wins; fall back to whichever Primus
      // field is correct for this booking type (see readCustomerRateFromAcct).
      const {rate: primusRateForCheck} =
          readCustomerRateFromAcct(booking.accountingInformation || {});
      const rateForCheck = expectedRate || primusRateForCheck || 0;
      if (rateForCheck > 0 && Math.abs(total - rateForCheck) > 0.5) {
        const mismatchMsg =
            `Invoice total ($${total}) does not match expected ` +
            `customer rate ($${rateForCheck}). Refusing to proceed.`;
        await writeLog("error", "primus", mismatchMsg, {
          loadNumber: invoiceData.loadNumber,
          invoiceId: inv.invoiceId,
          invoiceTotal: total,
          expectedRate: rateForCheck,
          difference: Math.abs(total - rateForCheck),
          hint: "Check for duplicate invoice drafts in ShipPrimus",
        });
        return {
          ok: false,
          error: mismatchMsg,
          customerInvoiceId: inv.invoiceId,
          invoiceTotal: total,
          expectedRate: rateForCheck,
          difference: Math.abs(total - rateForCheck),
        };
      }
      return {
        ok: true,
        reused: true,
        customerInvoiceId: inv.invoiceId,
        invoiceNumber: inv.invoiceNumber || null,
        generated: !!(inv.status && inv.status.generated),
        invoiceTotal: total,
        invoicePdfUrl: (inv.shipment && inv.shipment.url) || null,
      };
    }

    // No invoice exists yet — create the draft.
    const billTo = booking.billTo || "";
    let customerId = null;
    if (billTo === "thirdparty" && booking.thirdParty) {
      customerId = booking.thirdParty.id || null;
    } else if (booking.shipper) {
      customerId = booking.shipper.id || null;
    }
    const acct = booking.accountingInformation || {};
    const {rate: primusRate} = readCustomerRateFromAcct(acct);
    // Human-entered rate wins; fall back to Primus field appropriate for
    // this booking type (customerQuoteAmount for quoted loads, invoiceAmount
    // for manually-rated loads — see readCustomerRateFromAcct).
    const customerRate = expectedRate || primusRate;
    const billToReference = invoiceData.billToReferenceNumber || null;
    const freightDescription = billToReference ?
      `Freight Charges - ${billToReference}` : "Freight Charges";
    // When a customerQuoteId exists Primus uses the stored quote automatically;
    // sending a breakdown would be rejected for "Collect" shipments.
    const body = {customerId};
    if (!acct.customerQuoteId) {
      body.invoiceBreakdown = [{
        code: "FREIGHT",
        description: freightDescription,
        qty: 1,
        rate: customerRate,
      }];
    }
    const result = await primusRequest("POST", `/invoice/${BOLId}`, body);
    const invoiceResult = result &&
        result.data &&
        result.data.results &&
        (Array.isArray(result.data.results) ?
          result.data.results[0] : result.data.results);
    if (!invoiceResult || !invoiceResult.invoiceId) {
      return {ok: false, error: "Invoice creation returned no ID", raw: result};
    }
    return {
      ok: true,
      reused: false,
      customerInvoiceId: invoiceResult.invoiceId,
      invoiceNumber: invoiceResult.invoiceNumber,
      generated: !!(invoiceResult.status && invoiceResult.status.generated),
      invoiceTotal: Number(invoiceResult.total || 0),
      invoicePdfUrl: (invoiceResult.shipment &&
          invoiceResult.shipment.url) || null,
    };
  } catch (error) {
    await writeLog("error", "primus", "Failed to generate customer invoice", {
      invoiceData,
      error: error.message,
    });
    return {ok: false, error: error.message};
  }
}

// The Primus invoice workflow (processPrimusWorkflow) now lives in its own
// company file, ./innovative-primus.js, and is wired up below. The Primus API
// client helpers above remain here because the base intake also uses them.

// ── TAI TMS integration ────────────────────────────────────────────────────
// Firebase only deploys exports found in the main entry file, so we re-export
// the TAI webhook receiver, resolver, and workflow defined in ./tai.js.
//
// The TAI workflow reuses the TMS-agnostic helpers below (pause/email/logging
// /POD extraction/PDF building) so its behavior stays identical to the Primus
// workflow — only the TMS API calls differ. We inject them rather than
// duplicating them. These are passed by reference and remain closures over
// this module's scope (db, getBucket, sendViaGmail, etc.).
// Shared, company-agnostic helper bundle injected into every per-company TMS
// module. index.js is the base: it owns intake + these helpers; each company
// file owns its own workflow and is fed the same bundle.
const sharedTmsBundle = {
  db,
  tcol,
  getTenant,
  enterTenantContext,
  writeLog,
  logWorkflowStep,
  setWorkflowHeartbeat,
  pauseWorkflow,
  saveOutboundEmail,
  buildContinueButtonHtml,
  buildWorkflowAlertEmail: workflowErrors.buildWorkflowAlertEmail,
  escapeHtml,
  maybeExtractPodOnlyPdf,
  maybeBuildPodFromTrailerImages,
  isAlreadyDoneResult,
  downloadStorageFileBase64,
  buildCustomerInvoicePdfBase64,
  FieldValue: admin.firestore.FieldValue,
};

// Innovative Carriers — dedicated Primus workflow file. It needs the shared
// helpers plus the Primus API client helpers (which stay here because the base
// intake also calls them).
const primusBundle = {
  ...sharedTmsBundle,
  primusRequest,
  getPrimusToken,
  fetchPrimusBooking,
  readShipmentMode,
  readBillToReferenceNumber,
  isDrayageShipment,
  isPowerOnlyShipment,
  isTruckloadShipment,
  validateAmountWithPrimus,
  addProNumberToLoad,
  getCustomerRate,
  approveCarrierBill,
  generateCustomerInvoice,
  markShipmentDelivered,
  forwardToHumanReview,
  getGmailOAuthClient,
  notifyDispatcherRateIssue,
  maybeNotifyLisaPodDiscrepancy,
  isCarrierBillAlreadyEnteredInPrimus,
};
const primusUiBridge = require("./primus-ui-bridge");
primusUiBridge.init({db, writeLog, getPrimusToken});

brokerCommission.init({
  writeLog,
  saveOutboundEmail,
  workflowErrors,
  primusUiBridge,
  fetchPrimusBooking,
  checkProfitMargin,
  readCustomerRateFromAcct,
  isCarrierBillAlreadyEnteredInPrimus,
});

undeliveredReport.init({
  writeLog,
  saveOutboundEmail,
  primusUiBridge,
});

deliveredUninvoicedReport.init({
  writeLog,
  saveOutboundEmail,
  primusUiBridge,
});

dailyActivityReport.init({
  bigquery,
  writeLog,
  saveOutboundEmail,
});

const innovativePrimus = require("./innovative-primus");
innovativePrimus.init({
  ...primusBundle,
  kickPrimusWorkflow,
  isManagePhpEnabled: primusUiBridge.isManagePhpEnabled,
  runPrimusUiBillingFlow: primusUiBridge.runPrimusUiBillingFlow,
  emailBOLDocs: primusUiBridge.emailBOLDocs,
  resolveCustomerAccountingEmails:
      primusUiBridge.resolveCustomerAccountingEmails,
  checkBookingHasPod: primusUiBridge.checkBookingHasPod,
  ensurePodMarkedOnPrimus: primusUiBridge.ensurePodMarkedOnPrimus,
  ensureCarrierBillUploadedToPrimus:
      primusUiBridge.ensureCarrierBillUploadedToPrimus,
  resolveRestInvoiceIdForQuickBooks:
      primusUiBridge.resolveRestInvoiceIdForQuickBooks,
  rePushCarrierBillToQuickBooks:
      primusUiBridge.rePushCarrierBillToQuickBooks,
  scheduleFlowSummary: (flowId) => {
    scheduleFlowSummary(flowId).catch((err) => {
      console.warn("scheduleFlowSummary failed:", err.message);
    });
  },
});
exports.processPrimusWorkflow = innovativePrimus.processPrimusWorkflow;
if (typeof innovativePrimus.retryPendingTransientWorkflows ===
    "function") {
  retryPendingTransientWorkflowsImpl =
    innovativePrimus.retryPendingTransientWorkflows;
}

/** Retry invoices that crashed on transient Primus/network errors. */
exports.retryTransientWorkflowFailures = onSchedule({
  schedule: "every 5 minutes",
  timeoutSeconds: 540,
  memory: "512MiB",
}, async () => {
  try {
    const result = await retryPendingTransientWorkflowsImpl();
    console.log("retryTransientWorkflowFailures:", JSON.stringify(result));
  } catch (error) {
    console.error("retryTransientWorkflowFailures error:", error.message);
  }
});

const innovativeInsurance = require("./innovative-insurance");
innovativeInsurance.init({
  writeLog,
  saveOutboundEmail,
  fetchPrimusBooking,
  addInsurancePremiumToLoad: primusUiBridge.addInsurancePremiumToLoad,
  resolveInsuranceVendor: primusUiBridge.resolveInsuranceVendor,
  isManagePhpEnabled: primusUiBridge.isManagePhpEnabled,
  maybeAdjustBrokerAfterInsurance:
      brokerCommission.maybeAdjustAfterInsurancePremium,
});

const tai = require("./tai");
tai.init(sharedTmsBundle);
exports.taiWebhook = tai.taiWebhook;
exports.taiResolveShipment = tai.taiResolveShipment;
exports.processTaiWorkflow = tai.processTaiWorkflow;

// Coast to Coast Carriers — dedicated, self-contained TAI workflow file.
const ctcTai = require("./ctc-tai");
ctcTai.init(sharedTmsBundle);
exports.ctcTaiWebhook = ctcTai.ctcTaiWebhook;
exports.ctcTaiResolveShipment = ctcTai.ctcTaiResolveShipment;
exports.processCtcTaiWorkflow = ctcTai.processCtcTaiWorkflow;

// Renew Primus manage.php PHPSESSID on a schedule (every 12 hours).
exports.refreshPrimusUiSession = onSchedule("every 12 hours", async () => {
  if (!primusUiBridge.isManagePhpEnabled()) return;
  await primusUiBridge.renewUiSession();
});

// --- Quote automation (LTL RFQ → rate shop → dispatcher review) ---
const quoteAutomation = require("./quote-automation");
const quoteDashboard = require("./quote-dashboard");

quoteAutomation.init({
  db,
  tcol,
  writeLog,
  saveOutboundEmail,
  getPrimusToken,
});

quoteDashboard.init({
  applyDashboardCors,
  resolveDashboardTenant,
  getTenant,
  writeLog,
  db,
  tcol,
  getPrimusToken,
});

const jerrySupportChatWidget = require("./jerry-support-chat-widget");
jerrySupportChatWidget.init({applyDashboardCors});

exports.jerrySupportChatWidget = onRequest({invoker: "public"},
    jerrySupportChatWidget.handleJerrySupportChatWidget);
exports.jerrySupportChatLogo = onRequest({invoker: "public"},
    jerrySupportChatWidget.handleJerrySupportChatLogo);

exports.getQuoteRules = onRequest({invoker: "public"},
    quoteDashboard.handleGetQuoteRules);
exports.applyQuoteRule = onRequest({invoker: "public"},
    quoteDashboard.handleApplyQuoteRule);
exports.testQuoteRules = onRequest({invoker: "public"},
    quoteDashboard.handleTestQuoteRules);
exports.quoteRulesChat = onRequest({
  invoker: "public",
  timeoutSeconds: 120,
  memory: "512MiB",
}, quoteDashboard.handleQuoteRulesChat);
exports.getQuoteAdminConfig = onRequest({invoker: "public"},
    quoteDashboard.handleGetQuoteAdminConfig);
exports.getQuoteRequests = onRequest({invoker: "public"},
    quoteDashboard.handleGetQuoteRequests);
exports.getQuoteDispatcherData = onRequest({invoker: "public"},
    quoteDashboard.handleGetQuoteDispatcherData);
exports.saveQuoteSelection = onRequest({invoker: "public"},
    quoteDashboard.handleSaveQuoteSelection);
exports.saveQuoteSelections = onRequest({invoker: "public"},
    quoteDashboard.handleSaveQuoteSelections);
exports.updateQuoteDetails = onRequest({invoker: "public"},
    quoteDashboard.handleUpdateQuoteDetails);
exports.generateQuoteEmail = onRequest({
  invoker: "public",
  timeoutSeconds: 300,
  memory: "512MiB",
}, quoteDashboard.handleGenerateQuoteEmail);
exports.approveQuoteEmail = onRequest({invoker: "public"},
    quoteDashboard.handleApproveQuoteEmail);
exports.dismissQuote = onRequest({invoker: "public"},
    quoteDashboard.handleDismissQuote);
exports.markQuoteForReview = onRequest({invoker: "public"},
    quoteDashboard.handleMarkQuoteForReview);
exports.exportQuoteDispatcherReport = onRequest({
  invoker: "public",
  timeoutSeconds: 120,
  memory: "512MiB",
}, quoteDashboard.handleExportQuoteDispatcherReport);
exports.rerunQuoteRates = onRequest({
  invoker: "public",
  timeoutSeconds: 540,
  memory: "1GiB",
}, quoteDashboard.handleRerunQuoteRates);
exports.getQuoteAccessorialCatalog = onRequest({
  invoker: "public",
  timeoutSeconds: 120,
  memory: "512MiB",
}, quoteDashboard.handleGetQuoteAccessorialCatalog);
exports.createBulkRateShopJob = onRequest({
  invoker: "public",
  timeoutSeconds: 120,
  memory: "512MiB",
}, quoteDashboard.handleCreateBulkRateShopJob);
exports.processBulkRateShopJob = onRequest({
  invoker: "public",
  timeoutSeconds: 540,
  memory: "1GiB",
}, quoteDashboard.handleProcessBulkRateShopJob);
exports.getBulkRateShopJob = onRequest({invoker: "public"},
    quoteDashboard.handleGetBulkRateShopJob);
exports.downloadBulkRateShopResults = onRequest({
  invoker: "public",
  timeoutSeconds: 120,
  memory: "512MiB",
}, quoteDashboard.handleDownloadBulkRateShopResults);
exports.getQuoteDispatcherProfile = onRequest({invoker: "public"},
    quoteDashboard.handleGetQuoteDispatcherProfile);
exports.getQuoteDispatcherInbox = onRequest({
  invoker: "public",
  // Sync Outlook path can scan/process mail; fast path returns Firestore only.
  timeoutSeconds: 300,
  memory: "512MiB",
}, quoteDashboard.handleGetQuoteDispatcherInbox);
exports.getQuoteDispatchers = onRequest({invoker: "public"},
    quoteDashboard.handleGetQuoteDispatchers);
exports.quoteAdminPage = onRequest({invoker: "public"},
    quoteDashboard.handleQuoteAdminPage);
exports.quoteDispatcherPage = onRequest({invoker: "public"},
    quoteDashboard.handleQuoteDispatcherPage);
exports.quoteDispatcherHomePage = onRequest({invoker: "public"},
    quoteDashboard.handleQuoteDispatcherHomePage);
exports.getQuoteAuthConfig = onRequest({invoker: "public"},
    quoteDashboard.handleGetQuoteAuthConfig);
exports.getQuoteOutlookConnectUrl = onRequest({invoker: "public"},
    quoteDashboard.handleGetQuoteOutlookConnectUrl);
exports.quoteOutlookDisconnect = onRequest({invoker: "public"},
    quoteDashboard.handleQuoteOutlookDisconnect);
exports.quoteOutlookOAuthCallback = onRequest({invoker: "public"},
    quoteDashboard.handleQuoteOutlookOAuthCallback);
exports.quoteAuthClient = onRequest({invoker: "public"},
    quoteDashboard.handleQuoteAuthClient);
// Cloud Scheduler every 20 min (see setup-quote-outlook-http-scheduler.ps1).
// Public like checkMailInbox — no shared-secret pattern on that job either.
exports.syncQuoteOutlookInboxes = onRequest({
  invoker: "public",
  timeoutSeconds: 540,
  memory: "1GiB",
}, quoteDashboard.handleSyncQuoteOutlookInboxes);
exports.checkQuoteMailInbox = exports.syncQuoteOutlookInboxes;
exports.processQuoteWorkflow = onRequest({
  invoker: "public",
  timeoutSeconds: 540,
  memory: "1GiB",
}, async (req, res) => {
  if (applyDashboardCors(req, res)) return;
  try {
    const tenant = await resolveDashboardTenant(req);
    const body = req.body || {};
    const result = await quoteAutomation.processQuoteEmail({
      messageId: body.messageId || `manual-${Date.now()}`,
      subject: body.subject || "Manual quote",
      from: body.from || "",
      to: body.to || "",
      cc: body.cc || "",
      emailBody: body.emailBody || body.body || "",
      tenant,
    });
    return res.json({ok: true, ...result});
  } catch (err) {
    console.error("processQuoteWorkflow:", err);
    return res.status(500).json({ok: false, error: err.message});
  }
});

