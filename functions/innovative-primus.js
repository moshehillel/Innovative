/**
 * Innovative Carriers — dedicated Primus TMS workflow.
 *
 * The complete, self-contained Primus invoice workflow, extracted from
 * index.js so the base file stays generic (intake + dispatcher + shared
 * helpers). Per the per-company file model, each company owns its workflow
 * file. Company-agnostic helpers and the Primus API client helpers are
 * injected from index.js via init() so behavior is identical to before.
 *
 * Export (re-exported from index.js): processPrimusWorkflow.
 */

"use strict";

const {onRequest} = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const loadResolution = require("./invoice-load-resolution");
const workflowErrors = require("./workflow-error-messages");

// Injected from index.js (see init). Declared at module scope so the moved
// workflow code below can call them by their original bare names, unchanged.
let db;
let writeLog;
let logWorkflowStep;
let setWorkflowHeartbeat;
let pauseWorkflow;
let saveOutboundEmail;
let maybeExtractPodOnlyPdf;
let maybeBuildPodFromTrailerImages;
let isAlreadyDoneResult;
let downloadStorageFileBase64;
let primusRequest;
let fetchPrimusBooking;
let readShipmentMode;
let readBillToReferenceNumber;
let isDrayageShipment;
let isPowerOnlyShipment;
let isTruckloadShipment;
let validateAmountWithPrimus;
let addProNumberToLoad;
let getCustomerRate;
let approveCarrierBill;
let generateCustomerInvoice;
let markShipmentDelivered;
let isManagePhpEnabled;
let runPrimusUiBillingFlow;
let emailBOLDocs;
let resolveCustomerAccountingEmails;
let checkBookingHasPod;
let ensurePodMarkedOnPrimus;
let ensureCarrierBillUploadedToPrimus;
let resolveRestInvoiceIdForQuickBooks;
let rePushCarrierBillToQuickBooks;
let scheduleFlowSummary;
let notifyDispatcherRateIssue;
let maybeNotifyLisaPodDiscrepancy;
let isCarrierBillAlreadyEnteredInPrimus;

/**
 * Receives the shared + Primus helper bundle from index.js.
 * @param {object} bundle Injected helpers.
 * @return {void}
 */
function init(bundle) {
  ({
    db, writeLog, logWorkflowStep, setWorkflowHeartbeat, pauseWorkflow,
    saveOutboundEmail,
    maybeExtractPodOnlyPdf,
    maybeBuildPodFromTrailerImages,
    isAlreadyDoneResult,
    downloadStorageFileBase64,
    primusRequest, fetchPrimusBooking, readShipmentMode,
    readBillToReferenceNumber,
    isDrayageShipment,
    isPowerOnlyShipment, isTruckloadShipment,
    validateAmountWithPrimus, addProNumberToLoad,
    getCustomerRate, approveCarrierBill, generateCustomerInvoice,
    markShipmentDelivered,
    isManagePhpEnabled, runPrimusUiBillingFlow, emailBOLDocs,
    resolveCustomerAccountingEmails, checkBookingHasPod,
    ensurePodMarkedOnPrimus,
    ensureCarrierBillUploadedToPrimus,
    resolveRestInvoiceIdForQuickBooks,
    rePushCarrierBillToQuickBooks,
    scheduleFlowSummary,
    notifyDispatcherRateIssue,
    maybeNotifyLisaPodDiscrepancy,
    isCarrierBillAlreadyEnteredInPrimus,
  } = bundle);
}
exports.init = init;

/**
 * Runs UI billing once; retries once on transient ShipPrimus network errors.
 * @param {object} flowArgs runPrimusUiBillingFlow arguments.
 * @param {object} logContext invoiceId, loadNumber.
 * @return {Promise<object>}
 */
async function runUiBillingFlowWithRetry(flowArgs, logContext) {
  const runOnce = async () => {
    try {
      return await runPrimusUiBillingFlow(flowArgs);
    } catch (uiErr) {
      return {ok: false, error: uiErr.message};
    }
  };
  let uiResult = await runOnce();
  if (!uiResult.ok && workflowErrors.isTransientNetworkError(uiResult.error)) {
    await writeLog("warn", "workflow",
        "UI billing network error — retrying once", {
          ...logContext,
          error: uiResult.error,
        });
    await new Promise((resolve) => setTimeout(resolve,
        workflowErrors.TRANSIENT_NETWORK_RETRY_MS));
    uiResult = await runOnce();
  }
  return uiResult;
}

/**
 * True when Firestore shows carrier bill entered and customer invoice issued.
 * @param {object} invoice Invoice document.
 * @param {object} primusSteps Completed-step flags.
 * @return {boolean}
 */
function isBillingCompleteInFirestore(invoice, primusSteps) {
  const hasCustomerInvoice = Boolean(
      invoice.customerInvoiceId ||
      primusSteps.uiInvoiceIssued ||
      primusSteps.customerInvoiceGenerated,
  );
  const carrierEntered = Boolean(
      primusSteps.carrierBillUploaded ||
      primusSteps.uiInvoiceIssued ||
      (primusSteps.amountValidated && primusSteps.billApproved),
  );
  return hasCustomerInvoice && carrierEntered;
}

/**
 * Checks Primus for an issued customer invoice on the load.
 * @param {string} loadNumber Load/BOL number.
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
 * Issued manage.php customer invoice for a load, if one already exists.
 * @param {string} loadNumber Load/BOL number.
 * @return {Promise<{id:number, invoiceNumber:string}|null>}
 */
async function lookupIssuedUiCustomerInvoice(loadNumber) {
  if (!loadNumber || !isManagePhpEnabled || !isManagePhpEnabled()) return null;
  try {
    const booking = await fetchPrimusBooking(loadNumber);
    if (!booking) return null;
    const bridge = require("./primus-ui-bridge");
    const bookingId = bridge._internal &&
      bridge._internal.resolveManageBookingId ?
      bridge._internal.resolveManageBookingId(booking) : null;
    if (!bookingId || !bridge.getBookingDocuments) return null;
    const docs = await bridge.getBookingDocuments({
      bookingId,
      bookingBOL: String(loadNumber),
    });
    if (!docs.ok || !docs.data || !Array.isArray(docs.data.invoices)) {
      return null;
    }
    const issued = docs.data.invoices.find((inv) => {
      const num = inv.invoiceNumber;
      return num != null && String(num) !== "" && String(num) !== "0";
    });
    if (!issued || issued.id == null) return null;
    return {
      id: Number(issued.id),
      invoiceNumber: String(issued.invoiceNumber),
    };
  } catch (_) {
    return null;
  }
}

/**
 * Confirms billing is already done in Primus (carrier bill + customer invoice).
 * @param {object} invoice Invoice document.
 * @param {object} primusSteps Completed-step flags.
 * @return {Promise<boolean>}
 */
async function confirmBillingCompleteInPrimus(invoice, primusSteps) {
  if (isBillingCompleteInFirestore(invoice, primusSteps)) return true;
  if (!invoice.loadNumber) return false;
  const carrierEntered = isCarrierBillAlreadyEnteredInPrimus ?
    await isCarrierBillAlreadyEnteredInPrimus(invoice) : false;
  if (!carrierEntered) return false;
  if (invoice.customerInvoiceId) return true;
  return hasIssuedCustomerInvoiceInPrimus(invoice.loadNumber);
}

/**
 * Decides whether to skip intake/billing and only run the customer-email phase,
 * or skip the workflow entirely when billing is already done.
 * @param {object} invoice Invoice document.
 * @param {object} primusSteps Completed-step flags.
 * @param {string|null} resumeFrom Resume step, if any.
 * @return {Promise<object>} Skip action and optional source.
 */
async function resolveBillingSkipAction(invoice, primusSteps, resumeFrom) {
  const inFirestore = isBillingCompleteInFirestore(invoice, primusSteps);
  const inPrimus = inFirestore ||
    await confirmBillingCompleteInPrimus(invoice, primusSteps);
  if (!inPrimus) {
    return {action: "continue"};
  }

  // Customer-email reviewer gate is gone: send unless explicitly rejected.
  if (invoice.customerEmailApproval === "rejected") {
    return {action: "skip_entirely", workflowStatus: "customer_email_rejected"};
  }
  return {
    action: "customer_email_only",
    source: inFirestore ? "firestore" : "primus",
  };
}

/**
 * Builds a reused amount-validation result from a prior successful run.
 * @param {object} invoice Invoice document.
 * @return {object}
 */
function reusedAmountValidationFromInvoice(invoice) {
  const submitted = invoice.baseAmountValidated != null ?
    Number(invoice.baseAmountValidated) :
    Number(invoice.invoiceAmount || 0);
  return {
    ok: true,
    validAmount: true,
    submittedAmount: submitted,
    primusQuotedAmount: invoice.primusAmount || null,
    enteredAmount: submitted,
    savedAmount: submitted,
    difference: 0,
    proNumber: invoice.proNumber || "",
    reason: "Reused prior amount validation",
  };
}

/**
 * Normalizes Primus QuickBooks error payloads for alerts.
 * @param {*} err Primus results.error value.
 * @return {string|null}
 */
function formatPrimusQbError(err) {
  if (err == null) return null;
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const msg = err.message || err.error;
    if (typeof msg === "string") return msg;
    if (msg && typeof msg === "object") {
      return msg.message || JSON.stringify(msg);
    }
    return JSON.stringify(err);
  }
  return String(err);
}

/**
 * Loads the carrier invoice PDF from invoice attachments in Storage.
 * @param {object} invoice Invoice document data.
 * @return {Promise<{buffer: Buffer, filename: string}|null>}
 */
async function loadCarrierBillPdfFromInvoice(invoice) {
  const attList = Array.isArray(invoice.attachments) ?
    invoice.attachments : [];
  const carrierAtt = attList.find((a) => a && a.storagePath) || null;
  if (!carrierAtt || !carrierAtt.storagePath) return null;
  const b64 = await downloadStorageFileBase64(carrierAtt.storagePath);
  if (!b64) return null;
  return {
    buffer: Buffer.from(b64, "base64"),
    filename: carrierAtt.filename ||
      `carrier-bill-${invoice.loadNumber}.pdf`,
  };
}

/**
 * Uploads carrier bill PDF to Primus immediately after amount validation.
 * Non-fatal: billing can retry upload later if this fails.
 * @param {object} args Workflow context.
 * @return {Promise<void>}
 */
async function uploadCarrierBillEarly(args) {
  const {invoice, invoiceDoc, invoiceId, primusSteps} = args;
  if (!isManagePhpEnabled || !isManagePhpEnabled() ||
      !ensureCarrierBillUploadedToPrimus ||
      primusSteps.carrierBillUploaded) {
    return;
  }
  try {
    const carrierBillPdf = await loadCarrierBillPdfFromInvoice(invoice);
    if (!carrierBillPdf) return;
    const booking = await fetchPrimusBooking(invoice.loadNumber);
    if (!booking) return;
    const result = await ensureCarrierBillUploadedToPrimus({
      booking,
      loadNumber: invoice.loadNumber,
      carrierBillPdf,
    });
    const alreadyOnPrimus = result.skipped &&
      result.reason === "already uploaded";
    if (result.uploaded || alreadyOnPrimus) {
      primusSteps.carrierBillUploaded = true;
      await invoiceDoc.ref.update({
        primusSteps,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await logWorkflowStep({
        invoiceId,
        stepName: "carrier_bill_upload_completed",
        stepStatus: "success",
        output: {
          uploaded: !!result.uploaded,
          skipped: !!result.skipped,
          reason: result.reason || null,
        },
      });
      await writeLog("info", "workflow",
          result.uploaded ?
            "Carrier bill PDF uploaded to Primus (early)" :
            "Carrier bill PDF already on Primus — skipped", {
            invoiceId,
            loadNumber: invoice.loadNumber,
            uploaded: !!result.uploaded,
            skipped: !!result.skipped,
          });
    } else if (!result.ok && result.error) {
      await writeLog("warn", "workflow",
          "Early carrier bill upload failed — will retry at invoice step", {
            invoiceId,
            loadNumber: invoice.loadNumber,
            error: result.error,
          });
    }
  } catch (err) {
    await writeLog("warn", "workflow",
        "Early carrier bill upload error — will retry at invoice step", {
          invoiceId,
          loadNumber: invoice.loadNumber,
          error: err.message || String(err),
        });
  }
}

/**
 * Loads prior cannot-email / missing-POD outbound rows for one invoice.
 * @param {string} invoiceId Firestore invoice id.
 * @param {string} code Alert catalog code.
 * @param {string} [type] outboundEmails type override.
 * @return {Promise<Array<object>>}
 */
async function loadExistingHoldAlerts(invoiceId, code, type) {
  if (!db || !invoiceId) return [];
  const wantCode = String(code || "").toUpperCase();
  const wantType = String(type || code || "").toLowerCase();
  const snap = await db.collection("outboundEmails")
      .where("invoiceId", "==", invoiceId)
      .limit(40)
      .get();
  return snap.docs.map((doc) => {
    const data = doc.data() || {};
    return {
      id: doc.id,
      type: data.type,
      alertCode: data.alertCode,
      alertContext: data.alertContext,
      errorMessage: data.alertContext && data.alertContext.errorMessage,
    };
  }).filter((row) => {
    const aCode = String(row.alertCode || "").toUpperCase();
    const aType = String(row.type || "").toLowerCase();
    return aCode === wantCode || aType === wantType;
  });
}

/**
 * Sends a standardized workflow alert email (action button only when helpful).
 * Dedupes Lisa "cannot email" / missing-POD holds when the invoice is already
 * paused on that reason or a bulk/ops resume re-hits a known send hold.
 * Extra-charge A/B/C/D and workflow-crash emails are unchanged.
 * @param {object} opts
 * @param {object} opts.req HTTP request (for base URL).
 * @param {string} opts.code workflow-error-messages catalog code.
 * @param {string} opts.invoiceId Firestore invoice id.
 * @param {string} [opts.type] outboundEmails type override.
 * @param {object} [opts.context] Template variables.
 * @param {object} [opts.priorInvoice] Invoice fields before this fail update.
 * @return {Promise<void>}
 */
async function sendWorkflowAlert(opts) {
  const {req, code, invoiceId, type, context, priorInvoice} = opts;
  const baseUrl = `https://${req.get("host")}`;
  const tenantId = (req.body && req.body.tenantId) || null;
  const alertContext = context || {};
  const prior = priorInvoice || {};

  if (workflowErrors.isCannotEmailHoldAlert(code)) {
    let existingAlerts = [];
    try {
      existingAlerts = await loadExistingHoldAlerts(invoiceId, code, type);
    } catch (lookupErr) {
      console.warn("hold alert lookup failed:",
          lookupErr && lookupErr.message);
    }
    if (workflowErrors.shouldSuppressRepeatHoldAlert({
      code,
      errorMessage: alertContext.errorMessage || prior.decisionReason,
      priorInvoice: prior,
      existingAlerts,
    })) {
      await writeLog("info", "workflow",
          "Skipped duplicate cannot-email alert", {
            invoiceId,
            code,
            loadNumber: alertContext.loadNumber || prior.loadNumber || null,
            reason: alertContext.errorMessage || prior.decisionReason || null,
          });
      return;
    }
  }

  const alert = workflowErrors.buildWorkflowAlertEmail({
    code,
    context: alertContext,
    baseUrl,
    invoiceId,
    tenantId,
  });
  await saveOutboundEmail({
    type: type || String(code).toLowerCase(),
    invoiceId,
    subject: alert.subject,
    html: alert.html,
    alertCode: code,
    alertContext,
    systemError: workflowErrors.isSystemAlertCode(code, alertContext),
  });

  if (workflowErrors.isCannotEmailHoldAlert(code) && invoiceId && db) {
    try {
      await db.collection("invoices").doc(invoiceId).update({
        lastHoldAlertCode: code,
        lastHoldAlertReason: String(
            alertContext.errorMessage || prior.decisionReason || "")
            .slice(0, 300),
        lastHoldAlertAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (stampErr) {
      console.warn("lastHoldAlert stamp failed:",
          stampErr && stampErr.message);
    }
  }
}

/**
 * Pushes the carrier payable to QuickBooks via Primus REST.
 * Idempotent via primusSteps.qbBillingSynced. Alerts ops on failure.
 * @param {object} args Args.
 * @param {object} args.req Express request (for alert links).
 * @param {object} args.invoiceDoc Firestore invoice snapshot.
 * @param {string} args.invoiceId Firestore invoice id.
 * @param {object} args.invoice Invoice data.
 * @param {object} args.primusSteps Mutable primusSteps map (updated in place).
 * @param {string|number} args.customerInvoiceId Primus UI customer invoice id.
 * @param {string|number} [args.invoiceNumber] Issued customer invoice number.
 * @return {Promise<object>} {synced, skipped, uploaded, failed, error}.
 */
async function pushCarrierBillToQuickBooks(args) {
  const {
    req,
    invoiceDoc,
    invoiceId,
    invoice,
    primusSteps,
    customerInvoiceId,
    invoiceNumber: invoiceNumberArg,
  } = args;
  if (!customerInvoiceId) {
    return {synced: false, skipped: true, reason: "no customerInvoiceId"};
  }
  if (primusSteps && primusSteps.qbBillingSynced) {
    return {synced: true, skipped: true, reason: "already synced"};
  }

  const uiInvoiceId = String(customerInvoiceId);
  const invoiceNumber = String(
      invoiceNumberArg ||
      invoice.issuedInvoiceNumber ||
      invoice.customerInvoiceNumber ||
      "0",
  );
  const loadNumber = invoice.loadNumber ? String(invoice.loadNumber) : "";

  /**
   * @param {object} syncInfo Success metadata for logs.
   * @return {Promise<object>}
   */
  async function markSynced(syncInfo) {
    if (primusSteps) {
      primusSteps.qbBillingSynced = true;
      primusSteps.qbBillingSyncedAt = new Date().toISOString();
      primusSteps.qbBillingMethod = syncInfo.method || "ui_rePushToQB";
    }
    const updatePayload = {
      "primusSteps.qbBillingSynced": true,
      "primusSteps.qbBillingSyncedAt":
        admin.firestore.FieldValue.serverTimestamp(),
      "primusSteps.qbBillingMethod": syncInfo.method || "ui_rePushToQB",
      "updatedAt": admin.firestore.FieldValue.serverTimestamp(),
    };
    const invDateRaw = invoice.dueDate ? null :
      (invoice.invoiceDate || invoice.receivedAt || null);
    if (!invoice.dueDate && invDateRaw) {
      const invDate = new Date(invDateRaw);
      if (!isNaN(invDate.getTime())) {
        invDate.setDate(invDate.getDate() + 30);
        updatePayload.carrierBillDueDate =
          invDate.toISOString().split("T")[0];
      }
    }
    await invoiceDoc.ref.update(updatePayload);
    await writeLog("info", "workflow",
        "Carrier bill pushed to QuickBooks", {
          invoiceId,
          loadNumber,
          customerInvoiceId: uiInvoiceId,
          invoiceNumber,
          method: syncInfo.method,
          ...syncInfo.extra,
        });
    await logWorkflowStep({
      invoiceId,
      stepName: "qb_billing_sync",
      stepStatus: "success",
      output: {
        customerInvoiceId: uiInvoiceId,
        invoiceNumber,
        method: syncInfo.method,
        ...syncInfo.extra,
      },
    });
    return {synced: true, method: syncInfo.method, ...syncInfo.extra};
  }

  /**
   * @param {string} failMsg Human-readable failure.
   * @param {object} detail Log/alert detail.
   * @return {Promise<object>}
   */
  async function reportFailure(failMsg, detail) {
    const rawSnippet = detail.raw ?
      String(detail.raw).slice(0, 400) : "";
    await writeLog("error", "workflow",
        "QB billing sync failed — bill still in Primus", {
          invoiceId,
          loadNumber,
          customerInvoiceId: uiInvoiceId,
          invoiceNumber,
          method: detail.method,
          error: failMsg,
          raw: rawSnippet,
        });
    await logWorkflowStep({
      invoiceId,
      stepName: "qb_billing_sync",
      stepStatus: "failed",
      reason: failMsg,
      error: "QB_BILLING_FAILED",
      output: {
        customerInvoiceId: uiInvoiceId,
        invoiceNumber,
        method: detail.method,
        raw: rawSnippet,
      },
    });
    if (req) {
      await sendWorkflowAlert({
        req,
        code: "QB_BILLING_FAILED",
        invoiceId,
        type: "qb_billing_failed",
        context: {
          loadNumber,
          carrierName: invoice.carrierName,
          customerInvoiceId: uiInvoiceId,
          errorMessage: failMsg,
          raw: rawSnippet,
        },
      });
    }
    return {synced: false, error: failMsg, method: detail.method};
  }

  // Primary path: QuickBooks Desktop via manage.php rePushToQB (UI invoice id).
  if (isManagePhpEnabled && isManagePhpEnabled() &&
      typeof rePushCarrierBillToQuickBooks === "function") {
    try {
      const uiResult = await rePushCarrierBillToQuickBooks({
        customerInvoiceId: uiInvoiceId,
        invoiceNumber,
      });
      if (uiResult.synced) {
        return markSynced({
          method: "ui_rePushToQB",
          extra: {message: uiResult.message},
        });
      }
      if (!uiResult.skipped) {
        return reportFailure(
            uiResult.error || "rePushToQB failed",
            {method: "ui_rePushToQB", raw: uiResult.raw});
      }
    } catch (uiErr) {
      return reportFailure(uiErr.message, {method: "ui_rePushToQB"});
    }
  }

  // Optional REST fallback (QuickBooks Online API — usually off for IC).
  if (process.env.PRIMUS_QB_USE_REST_API !== "true") {
    return reportFailure(
        "QuickBooks UI push is not available (manage.php off)",
        {method: "none"});
  }

  let qbInvoiceId = uiInvoiceId;
  if (loadNumber && typeof resolveRestInvoiceIdForQuickBooks === "function") {
    try {
      const resolved = await resolveRestInvoiceIdForQuickBooks(
          loadNumber, customerInvoiceId);
      if (resolved) qbInvoiceId = resolved;
    } catch (_) {
      // use UI id
    }
  }

  try {
    const qbResult = await primusRequest(
        "POST", "/quickbooks/billing",
        {invoiceId: qbInvoiceId},
    );
    const qbResults = qbResult && qbResult.data && qbResult.data.results;
    const qbBills = qbResults && qbResults.bills;
    const primusQbError = formatPrimusQbError(
        qbResults && qbResults.error);
    const uploaded = (qbBills && qbBills.uploadedBills &&
        qbBills.uploadedBills.length) || 0;
    const failed = (qbBills && qbBills.failedBills &&
        qbBills.failedBills.length) || 0;
    const rawSnippet = JSON.stringify(qbResult || {}).slice(0, 400);

    if (uploaded > 0) {
      return markSynced({
        method: "rest_quickbooks_billing",
        extra: {qbInvoiceId, uploadedBills: uploaded, failedBills: failed},
      });
    }

    const failMsg = primusQbError ||
        (failed > 0 ?
          `${failed} bill(s) failed to upload to QuickBooks` :
          "Primus returned no uploaded bills");
    return reportFailure(failMsg, {
      method: "rest_quickbooks_billing",
      raw: rawSnippet,
    });
  } catch (qbErr) {
    return reportFailure(qbErr.message, {method: "rest_quickbooks_billing"});
  }
}

exports.processPrimusWorkflow = onRequest(
    {timeoutSeconds: 300, memory: "512MiB"},
    async (req, res) => {
      try {
        if (req.method !== "POST") {
          return res.status(405).json({
            ok: false,
            error: "Method not allowed. Use POST.",
          });
        }


        const {invoiceId, resumeFrom} = req.body || {};

        if (!invoiceId) {
          return res.status(400).json({
            ok: false,
            error: "invoiceId is required.",
          });
        }

        // Get invoice document
        const invoiceDoc = await db.collection("invoices").doc(invoiceId).get();

        if (!invoiceDoc.exists) {
          return res.status(404).json({
            ok: false,
            error: "Invoice not found.",
          });
        }

        const invoice = invoiceDoc.data();

        if (invoice.finalWorkflowStatus === "completed") {
          await writeLog("info", "workflow",
              "Workflow skipped — already completed", {
                invoiceId,
                loadNumber: invoice.loadNumber,
                customerInvoiceId: invoice.customerInvoiceId || null,
              });
          return res.status(409).json({
            ok: false,
            error: "ALREADY_COMPLETED",
            customerInvoiceId: invoice.customerInvoiceId || null,
          });
        }

        const flowId = invoice.flowId || invoice.gmailMessageId || invoiceId;

        const lockAcquired = await db.runTransaction(async (tx) => {
          const snap = await tx.get(invoiceDoc.ref);
          if (!snap.exists) return false;
          const data = snap.data() || {};
          if (data.processingLock === true) return false;
          tx.update(invoiceDoc.ref, {
            processingLock: true,
            lastHeartbeatAt: admin.firestore.FieldValue.serverTimestamp(),
            currentStep: resumeFrom || "start",
            processingStartedAt: data.processingStartedAt ||
          admin.firestore.FieldValue.serverTimestamp(),
            flowId: flowId,
            finalWorkflowStatus: "running",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          return true;
        });

        if (!lockAcquired) {
          await writeLog("warn", "workflow",
              "Workflow skipped — another instance is already running", {
                invoiceId,
                loadNumber: invoice.loadNumber,
              });
          return res.status(409).json({ok: false, error: "ALREADY_PROCESSING"});
        }

        await writeLog("info", "workflow",
            resumeFrom ?
              `Resuming Primus workflow from step: ${resumeFrom}` :
              "Starting Primus workflow", {
              invoiceId,
              flowId,
              resumeFrom: resumeFrom || null,
              loadNumber: invoice.loadNumber,
              carrierName: invoice.carrierName || null,
              invoiceAmount: invoice.invoiceAmount || null,
              proNumber: invoice.proNumber || null,
              primusStepsCompleted: Object.entries(
                  invoice.primusSteps || {},
              ).filter(([, v]) => v).map(([k]) => k),
            });

        // Note: workflowPausedAt is tracked,
        // but we do not block resume based on age.

        let workingProNumber = invoice.proNumber;
        // Load primusSteps from invoice document to track completed steps
        const primusSteps = invoice.primusSteps || {
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
        };

        const currentStep = resumeFrom || null;

        // An invoice awaiting the A/B/C/D additional-charge decision must
        // not be failed — the decision buttons clear the charge arrays and
        // restart the workflow.
        if (invoice.additionalCharge &&
            !invoice.additionalCharge.decision) {
          await logWorkflowStep({
            invoiceId,
            stepName: "additional_charge_gate",
            stepStatus: "skipped",
            reason: "Awaiting A/B/C/D additional-charge decision",
          });
          await invoiceDoc.ref.update({
            processingLock: false,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          return res.json({
            ok: false,
            error: "ADDITIONAL_CHARGE_PENDING_APPROVAL",
          });
        }

        if (
          Array.isArray(invoice.unrecognizedCharges) &&
      invoice.unrecognizedCharges.length > 0
        ) {
          await logWorkflowStep({
            invoiceId,
            stepName: "unrecognized_charges_check",
            stepStatus: "failed",
            reason: "Unrecognized charges detected",
            input: {unrecognizedCharges: invoice.unrecognizedCharges},
            error: "UNRECOGNIZED_CHARGES",
          });

          await invoiceDoc.ref.update({
            decisionStage: "unrecognized_charges",
            decisionReason: "Unrecognized charges detected",
            processingLock: false,
            finalWorkflowStatus: "failed",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          return res.json({
            ok: false,
            error: "UNRECOGNIZED_CHARGES",
          });
        }

        if (Array.isArray(invoice.chargesNeedProof) &&
        invoice.chargesNeedProof.length > 0) {
          await logWorkflowStep({
            invoiceId,
            stepName: "charges_proof_check",
            stepStatus: "failed",
            reason: "Extra charges present with no proof",
            input: {chargesNeedProof: invoice.chargesNeedProof},
            error: "CHARGES_NO_PROOF",
          });

          await invoiceDoc.ref.update({
            decisionStage: "charges_no_proof",
            decisionReason: "Extra charges present with no proof",
            processingLock: false,
            finalWorkflowStatus: "failed",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          return res.json({
            ok: false,
            error: "CHARGES_NO_PROOF",
          });
        }

        const proofRefs = Array.isArray(invoice.chargeProofRefs) ?
      invoice.chargeProofRefs : [];
        const attachments = Array.isArray(invoice.attachments) ?
      invoice.attachments : [];
        const approvedChargeProofFiles = proofRefs
            .map((ref) => {
              const att = attachments.find(
                  (a) => a && a.filename === ref.attachmentFilename,
              );
              return {
                type: ref.type,
                amount: Number(ref.amount || 0),
                storagePath: (att && att.storagePath) || null,
              };
            })
            .filter((x) => x.storagePath);

        // Human-approved additional charge (A/B/C buttons). Charges that
        // originated as unrecognized line items are excluded from the base
        // amount so validation against the Primus cost still passes.
        const additionalCharge = invoice.additionalCharge || null;
        const additionalChargeApproved =
          !!(additionalCharge && additionalCharge.approved);
        const additionalApprovedExtra = (additionalChargeApproved &&
          additionalCharge.source === "unrecognized_charges") ?
          (Number(additionalCharge.amount) || 0) : 0;
        const additionalChargesMod = require("./additional-charges");
        const optionBCustomerBillLines = (additionalChargeApproved &&
          additionalCharge &&
          String(additionalCharge.decision || "").toUpperCase() === "B" &&
          Array.isArray(additionalCharge.customerBillLines)) ?
          additionalCharge.customerBillLines : [];
        const customerBillAccessorialTotal = optionBCustomerBillLines.length ?
          additionalChargesMod.sumCustomerBillLines(optionBCustomerBillLines) :
          0;

        const approvedChargesTotal = approvedChargeProofFiles
            .reduce((sum, c) => sum + (Number(c.amount) || 0), 0) +
            additionalApprovedExtra;

        await invoiceDoc.ref.update({
          approvedChargeProofFiles: approvedChargeProofFiles,
          approvedChargesTotal: approvedChargesTotal,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        const billingSkip = await resolveBillingSkipAction(
            invoice, primusSteps, currentStep);
        let skipToCustomerEmail = false;
        if (billingSkip.action === "skip_entirely") {
          await writeLog("info", "workflow",
              "Workflow skipped — carrier bill and invoice already in Primus",
              {
                invoiceId,
                loadNumber: invoice.loadNumber,
                customerInvoiceId: invoice.customerInvoiceId || null,
                workflowStatus: billingSkip.workflowStatus,
              });
          await invoiceDoc.ref.update({
            processingLock: false,
            finalWorkflowStatus: billingSkip.workflowStatus ===
              "awaiting_customer_email_approval" ?
              "waiting_manual" :
              (invoice.finalWorkflowStatus || "waiting_manual"),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          return res.json({
            ok: true,
            skipped: true,
            reason: "ALREADY_BILLED_IN_PRIMUS",
            workflowStatus: billingSkip.workflowStatus,
            customerInvoiceId: invoice.customerInvoiceId || null,
          });
        }
        if (billingSkip.action === "customer_email_only") {
          skipToCustomerEmail = true;
          await writeLog("info", "workflow",
              "Billing already complete — skipping to customer email step", {
                invoiceId,
                loadNumber: invoice.loadNumber,
                customerInvoiceId: invoice.customerInvoiceId || null,
                source: billingSkip.source,
                resumeFrom: currentStep,
              });
        }

        let amountValidation =
          skipToCustomerEmail || primusSteps.amountValidated ?
          reusedAmountValidationFromInvoice(invoice) : null;
        let baseAmount = invoice.baseAmountValidated != null ?
          Number(invoice.baseAmountValidated) :
          Number(invoice.invoiceAmount) - approvedChargesTotal;
        let extractedPodOnlyFile = null;
        let bookingForMode = null;

        // Drayage loads are not auto-processed — stop before POD/AI work.
        // Leo-validated drayage returns include Primus entry instructions.
        if (invoice.loadNumber && isDrayageShipment && readShipmentMode &&
            !invoice.drayageLeoValidated) {
          bookingForMode = await fetchPrimusBooking(invoice.loadNumber);
          const shipmentMode = readShipmentMode(bookingForMode);
          if (isDrayageShipment(bookingForMode)) {
            await logWorkflowStep({
              invoiceId,
              stepName: "drayage_check",
              stepStatus: "stopped",
              reason: "Drayage shipment — workflow not supported",
              output: {loadNumber: invoice.loadNumber, shipmentMode},
            });

            await sendWorkflowAlert({
              req,
              code: "DRAYAGE_STOPPED",
              invoiceId,
              type: "drayage_stopped",
              context: {
                loadNumber: invoice.loadNumber,
                carrierName: invoice.carrierName,
                shipmentMode: shipmentMode || "Drayage",
                invoiceAmount: invoice.invoiceAmount,
              },
            });

            await invoiceDoc.ref.update({
              decisionStage: "drayage_not_supported",
              decisionReason: "Drayage shipment — not processed automatically",
              shipmentMode: shipmentMode || "Drayage",
              processingLock: false,
              finalWorkflowStatus: "stopped_drayage",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            await writeLog("info", "workflow",
                "Workflow stopped — drayage shipment", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  shipmentMode,
                  carrierName: invoice.carrierName || null,
                });

            return res.json({
              ok: false,
              error: "DRAYAGE_NOT_SUPPORTED",
              shipmentMode,
            });
          }
        }

        if (!skipToCustomerEmail && invoice.loadNumber && !bookingForMode) {
          try {
            bookingForMode = await fetchPrimusBooking(invoice.loadNumber);
          } catch (_) {
            bookingForMode = null;
          }
        }

        if (!skipToCustomerEmail) {
          const extractedPodOnlyFileLocal =
      await maybeExtractPodOnlyPdf(invoiceId, invoice);
          extractedPodOnlyFile = extractedPodOnlyFileLocal;

          await logWorkflowStep({
            invoiceId,
            stepName: "pod_extraction_started",
            stepStatus: "started",
            input: {podSource: (invoice.pod && invoice.pod.source) || null},
          });

          await logWorkflowStep({
            invoiceId,
            stepName: "pod_extraction_completed",
            stepStatus: extractedPodOnlyFile ? "success" : "failed",
            output: extractedPodOnlyFile ?
        {
          storagePath: extractedPodOnlyFile.storagePath,
          fileCount: (extractedPodOnlyFile.files || []).length,
          files: extractedPodOnlyFile.files || [],
        } : null,
            error: extractedPodOnlyFile ? null : "POD extraction returned null",
          });

          if (extractedPodOnlyFile) {
            await invoiceDoc.ref.update({
              podOnlyFile: {
                storagePath: extractedPodOnlyFile.storagePath,
                source: extractedPodOnlyFile.source,
              },
              podOnlyFiles: extractedPodOnlyFile.files || [{
                storagePath: extractedPodOnlyFile.storagePath,
                source: extractedPodOnlyFile.source,
              }],
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          } else if (invoice.loadNumber && isManagePhpEnabled &&
            isManagePhpEnabled() && checkBookingHasPod) {
            try {
              const bookingForPod =
                await fetchPrimusBooking(invoice.loadNumber);
              const podCheck = await checkBookingHasPod({
                booking: bookingForPod,
                loadNumber: invoice.loadNumber,
              });
              if (podCheck && podCheck.found) {
                const steps = Object.assign({}, invoice.primusSteps || {}, {
                  podUploaded: true,
                });
                await invoiceDoc.ref.update({
                  podOnPrimusAlready: true,
                  podPrimusDriveIds: podCheck.driveIds || [],
                  primusSteps: steps,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                invoice.podOnPrimusAlready = true;
                invoice.podPrimusDriveIds = podCheck.driveIds || [];
                invoice.primusSteps = steps;
                await logWorkflowStep({
                  invoiceId,
                  stepName: "pod_on_primus_check",
                  stepStatus: "success",
                  reason: "already on booking",
                  output: {
                    driveIds: podCheck.driveIds || [],
                    loadNumber: invoice.loadNumber,
                  },
                });
                await writeLog("info", "workflow",
                    "POD already on Primus — local extraction not required", {
                      invoiceId,
                      loadNumber: invoice.loadNumber,
                      driveIds: podCheck.driveIds || [],
                    });
              } else {
                await logWorkflowStep({
                  invoiceId,
                  stepName: "pod_on_primus_check",
                  stepStatus: "failed",
                  reason: (podCheck && podCheck.reason) || "no POD on booking",
                  output: {loadNumber: invoice.loadNumber},
                });
              }
            } catch (podCheckErr) {
              await logWorkflowStep({
                invoiceId,
                stepName: "pod_on_primus_check",
                stepStatus: "failed",
                reason: podCheckErr.message || "check failed",
                error: podCheckErr.message,
              });
              await writeLog("warn", "workflow",
                  "Primus POD presence check failed", {
                    invoiceId,
                    loadNumber: invoice.loadNumber,
                    error: podCheckErr.message,
                  });
            }
          }

          // POD is required before billing / customer email — with exceptions:
          // Power Only: POD must be marked on the Primus booking
          // (upload trailer images / extracted POD first when possible).
          // Truckload: continue billing, chase carrier for POD, hold customer
          // email until it arrives.
          let hasLocalPod = Boolean(
              (extractedPodOnlyFile && extractedPodOnlyFile.storagePath) ||
            (invoice.podOnlyFile && invoice.podOnlyFile.storagePath),
          );
          let hasPrimusPod = Boolean(invoice.podOnPrimusAlready ||
            (invoice.primusSteps && invoice.primusSteps.podUploaded));

          const isPowerOnly = bookingForMode && isPowerOnlyShipment &&
          isPowerOnlyShipment(bookingForMode);

          // Power Only — upload POD to Primus when missing so the load is
          // marked POD before any billing steps run.
          if (isPowerOnly && !hasPrimusPod && ensurePodMarkedOnPrimus) {
            let podStoragePath =
            (extractedPodOnlyFile && extractedPodOnlyFile.storagePath) ||
            (invoice.podOnlyFile && invoice.podOnlyFile.storagePath) ||
            null;
            if (!podStoragePath && maybeBuildPodFromTrailerImages) {
              const imgPod = await maybeBuildPodFromTrailerImages(
                  invoiceId, invoice);
              if (imgPod && imgPod.storagePath) {
                podStoragePath = imgPod.storagePath;
                extractedPodOnlyFile = imgPod;
                hasLocalPod = true;
                await invoiceDoc.ref.update({
                  podOnlyFile: {
                    storagePath: imgPod.storagePath,
                    source: imgPod.source || "trailer_images",
                  },
                  podOnlyFiles: [{
                    storagePath: imgPod.storagePath,
                    source: imgPod.source || "trailer_images",
                  }],
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                await logWorkflowStep({
                  invoiceId,
                  stepName: "power_only_trailer_pod",
                  stepStatus: "success",
                  output: {
                    storagePath: imgPod.storagePath,
                    pageCount: imgPod.pageCount || null,
                  },
                });
              }
            }
            if (podStoragePath) {
              const podB64 = await downloadStorageFileBase64(podStoragePath);
              if (podB64) {
                const marked = await ensurePodMarkedOnPrimus({
                  booking: bookingForMode,
                  loadNumber: invoice.loadNumber,
                  podPdf: {
                    buffer: Buffer.from(podB64, "base64"),
                    filename: `pod-${invoice.loadNumber}.pdf`,
                  },
                });
                if (marked.hasPod) {
                  hasPrimusPod = true;
                  const steps = Object.assign({}, invoice.primusSteps || {}, {
                    podUploaded: true,
                  });
                  await invoiceDoc.ref.update({
                    podOnPrimusAlready: true,
                    podPrimusDriveIds: marked.driveIds || [],
                    primusSteps: steps,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                  });
                  invoice.podOnPrimusAlready = true;
                  invoice.primusSteps = steps;
                }
                await logWorkflowStep({
                  invoiceId,
                  stepName: "power_only_pod_marked",
                  stepStatus: marked.hasPod ? "success" : "failed",
                  output: {
                    uploaded: marked.uploaded || false,
                    hasPod: marked.hasPod || false,
                    reason: marked.reason || marked.error || null,
                  },
                });
              }
            }
          }

          // Power Only without POD marked on Primus — do not process invoice.
          if (isPowerOnly && !hasPrimusPod) {
            if (isManagePhpEnabled && isManagePhpEnabled() &&
              checkBookingHasPod) {
              try {
                const podCheck = await checkBookingHasPod({
                  booking: bookingForMode,
                  loadNumber: invoice.loadNumber,
                });
                hasPrimusPod = !!(podCheck && podCheck.found);
              } catch (_) {
                hasPrimusPod = false;
              }
            }
          }
          if (isPowerOnly && !hasPrimusPod) {
            const shipmentMode =
              readShipmentMode(bookingForMode) || "Power Only";
            await logWorkflowStep({
              invoiceId,
              stepName: "power_only_pod_required",
              stepStatus: "stopped",
              reason: "Power Only load has no POD marked on Primus",
              error: "MISSING_POD",
              output: {loadNumber: invoice.loadNumber, shipmentMode},
            });
            await pauseWorkflow(
                invoiceDoc.ref,
                "pod_extraction",
                "missing_pod",
                "Power Only — POD must be marked on the shipment",
            );
            await sendWorkflowAlert({
              req,
              code: "MISSING_POD",
              invoiceId,
              type: "missing_pod",
              priorInvoice: invoice,
              context: {
                loadNumber: invoice.loadNumber,
                carrierName: invoice.carrierName,
                proNumber: invoice.proNumber || null,
                shipmentMode,
                errorMessage:
                  "Power Only — POD must be marked on the shipment",
              },
            });
            await writeLog("error", "workflow",
                "Power Only — stopped; POD not marked on Primus", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  carrierName: invoice.carrierName || null,
                });
            return res.json({
              ok: false,
              error: "MISSING_POD",
              workflowStatus: "missing_pod",
              shipmentMode,
            });
          }

          if (!hasLocalPod && !hasPrimusPod) {
            const isTl = bookingForMode && isTruckloadShipment &&
            isTruckloadShipment(bookingForMode);
            // Power Only without usable images falls through to MISSING_POD
            // unless it also qualifies as TL chase (it doesn't — Power Only
            // is excluded from isTruckloadShipment).
            if (isTl) {
              const podFollowup = require("./pod-followup");
              const carrier = podFollowup.resolveCarrierEmail(bookingForMode);
              const lisa = process.env.LOW_PROFIT_CC_EMAIL ||
              podFollowup.LISA_EMAIL;
              const request = podFollowup.buildCarrierPodRequestEmail({
                loadNumber: invoice.loadNumber,
                carrierName: invoice.carrierName,
                proNumber: invoice.proNumber,
                invoiceNumber: invoice.invoiceNumber,
                isReminder: false,
              });
              const emailPayload = {
                type: "tl_pod_request",
                invoiceId,
                subject: request.subject,
                html: request.html,
              };
              if (carrier.email) {
                emailPayload.forceRecipient = true;
                emailPayload.to = carrier.email;
                emailPayload.cc = lisa;
              } else {
                emailPayload.forceRecipient = true;
                emailPayload.to = lisa;
                emailPayload.html = request.html +
                `<p style="color:#b45309"><em>Note: no carrier email on ` +
                `the Primus booking — sent to Lisa only.</em></p>`;
              }
              await saveOutboundEmail(emailPayload);

              await invoiceDoc.ref.update({
                podFollowUp: {
                  status: podFollowup.POD_FOLLOW_UP_STATUS.AWAITING_CARRIER,
                  holdCustomerEmail: true,
                  carrierEmail: carrier.email || null,
                  carrierEmailSource: carrier.source || null,
                  firstEmailedAt:
                  admin.firestore.FieldValue.serverTimestamp(),
                  lastEmailedAt:
                  admin.firestore.FieldValue.serverTimestamp(),
                  reminderCount: 0,
                  reminderSentAt: null,
                  escalatedAt: null,
                },
                shipmentMode: readShipmentMode(bookingForMode) || "TL",
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
              invoice.podFollowUp = {
                status: podFollowup.POD_FOLLOW_UP_STATUS.AWAITING_CARRIER,
                holdCustomerEmail: true,
                carrierEmail: carrier.email || null,
                reminderCount: 0,
              };

              await logWorkflowStep({
                invoiceId,
                stepName: "tl_pod_chase_started",
                stepStatus: "success",
                reason: "TL missing POD — billing continues; customer held",
                output: {
                  carrierEmail: carrier.email || null,
                  toLisaOnly: !carrier.email,
                },
              });
              await writeLog("warn", "workflow",
                  "TL missing POD — carrier chased; customer email held", {
                    invoiceId,
                    loadNumber: invoice.loadNumber,
                    carrierEmail: carrier.email || null,
                  });
            // Fall through — do NOT return; continue amount validation.
            } else {
              await logWorkflowStep({
                invoiceId,
                stepName: "pod_required_check",
                stepStatus: "stopped",
                reason: "No local POD and no POD on Primus booking",
                error: "MISSING_POD",
                output: {
                  loadNumber: invoice.loadNumber,
                  podFound: invoice.pod && invoice.pod.found,
                  podSource: invoice.pod && invoice.pod.source,
                },
              });

              await pauseWorkflow(
                  invoiceDoc.ref,
                  "pod_extraction",
                  "missing_pod",
                  "Carrier invoice has no POD — cannot continue without one",
              );

              await sendWorkflowAlert({
                req,
                code: "MISSING_POD",
                invoiceId,
                type: "missing_pod",
                priorInvoice: invoice,
                context: {
                  loadNumber: invoice.loadNumber,
                  carrierName: invoice.carrierName,
                  proNumber: invoice.proNumber || null,
                  gmailSubject: invoice.gmailSubject || null,
                  errorMessage:
                    "Carrier invoice has no POD — cannot continue without one",
                },
              });

              await writeLog("error", "workflow",
                  "Workflow stopped — POD missing " +
                "(not extracted, not on Primus)", {
                    invoiceId,
                    loadNumber: invoice.loadNumber,
                    carrierName: invoice.carrierName || null,
                    pod: invoice.pod || null,
                  });

              return res.json({
                ok: false,
                error: "MISSING_POD",
                workflowStatus: "missing_pod",
              });
            }
          }
        } // end !skipToCustomerEmail (POD intake)

        if (!skipToCustomerEmail) {
          if (maybeNotifyLisaPodDiscrepancy) {
            const podPathForReview =
            (extractedPodOnlyFile && extractedPodOnlyFile.storagePath) ||
            (invoice.podOnlyFile && invoice.podOnlyFile.storagePath) ||
            null;
            await maybeNotifyLisaPodDiscrepancy({
              invoiceId,
              invoice,
              invoiceRef: invoiceDoc.ref,
              podStoragePath: podPathForReview,
            });
          }

          await logWorkflowStep({
            invoiceId,
            stepName: "amount_validation_started",
            stepStatus: "started",
            input: {
              loadNumber: invoice.loadNumber,
              invoiceAmount: invoice.invoiceAmount,
            },
          });

          await setWorkflowHeartbeat(invoiceDoc.ref, "amount_validation");

          baseAmount = Number(invoice.invoiceAmount) - approvedChargesTotal;

          if (primusSteps.amountValidated) {
            amountValidation = reusedAmountValidationFromInvoice(invoice);
            await logWorkflowStep({
              invoiceId,
              stepName: "amount_validation_completed",
              stepStatus: "skipped",
              reason: "Amount already validated on a prior run",
              output: {
                validAmount: true,
                submittedAmount: amountValidation.submittedAmount,
                primusAmount: amountValidation.primusQuotedAmount,
              },
            });
            await writeLog("info", "workflow",
                "Amount validation skipped — already validated", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  submittedAmount: amountValidation.submittedAmount,
                });
          } else {
            await writeLog("info", "workflow", "Validating invoice amount", {
              invoiceId,
              flowId,
              loadNumber: invoice.loadNumber,
              invoiceAmount: invoice.invoiceAmount,
              approvedChargesTotal,
              baseAmountToValidate: baseAmount,
            });

            const amountValidationResult = await validateAmountWithPrimus(
                invoice.loadNumber,
                baseAmount,
            );
            amountValidation = amountValidationResult;

            await logWorkflowStep({
              invoiceId,
              stepName: "amount_validation_completed",
              stepStatus: amountValidation.ok && amountValidation.validAmount ?
            "success" : "failed",
              output: {
                validAmount: amountValidation.validAmount,
                submittedAmount: amountValidation.submittedAmount,
                primusAmount: amountValidation.primusQuotedAmount ||
              amountValidation.amount,
                difference: amountValidation.difference,
              },
              error: (amountValidation.ok && amountValidation.validAmount) ?
            null : (amountValidation.reason || amountValidation.error ||
              "Amount validation failed"),
            });
          }

          if (amountValidation.ok && amountValidation.validAmount) {
            await writeLog("info", "workflow", "Amount validation passed", {
              invoiceId,
              loadNumber: invoice.loadNumber,
              submittedAmount: amountValidation.submittedAmount,
              primusAmount: amountValidation.primusQuotedAmount ||
              amountValidation.amount,
              difference: amountValidation.difference,
              proNumber: amountValidation.proNumber || null,
            });
          }

          if (!amountValidation.ok || !amountValidation.validAmount) {
            const primusAmountFromValidation = amountValidation.amount || null;
            const submitted = amountValidation.submittedAmount ||
          invoice.invoiceAmount;
            const saved = amountValidation.savedAmount ||
            primusAmountFromValidation;
            const diff = amountValidation.difference ||
          (saved ? Math.abs(submitted - saved) : null);

            await writeLog("error", "workflow", "Amount validation failed", {
              event: "Amount validation failed",
              invoiceId: invoiceId,
              details: {
                submittedAmount: submitted,
                savedAmount: saved,
                difference: diff,
                reason: amountValidation.reason || amountValidation.error ||
                "Amount does not match Primus record",
                decision: "UNMATCHED_AMOUNT",
                invoiceAmount: invoice.invoiceAmount,
                primusAmount: primusAmountFromValidation,
                baseAmount: baseAmount,
              },
            });

            const billingAlreadyDone = Boolean(
                primusSteps.uiInvoiceIssued ||
              primusSteps.customerInvoiceGenerated ||
              invoice.customerInvoiceId,
            );
            if (billingAlreadyDone) {
              await writeLog("warn", "workflow",
                  "Amount validation failed after billing — " +
                "preserving prior state",
                  {
                    invoiceId,
                    loadNumber: invoice.loadNumber,
                    customerInvoiceId: invoice.customerInvoiceId || null,
                    priorDecisionStage: invoice.decisionStage || null,
                    error: amountValidation.error || amountValidation.reason,
                  });
              await invoiceDoc.ref.update({
                processingLock: false,
                finalWorkflowStatus: invoice.decisionStage ===
                "awaiting_customer_email_approval" ?
                "waiting_manual" :
                (invoice.finalWorkflowStatus === "running" ?
                  "waiting_manual" : invoice.finalWorkflowStatus),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
              return res.json({
                ok: false,
                error: "UNMATCHED_AMOUNT",
                preserved: true,
                details: amountValidation,
              });
            }

            await invoiceDoc.ref.update({
              decisionStage: "unmatched_amount",
              decisionReason: "Amount validation failed",
              baseAmountValidated: baseAmount,
              processingLock: false,
              finalWorkflowStatus: "failed",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            return res.json({
              ok: false,
              error: "UNMATCHED_AMOUNT",
              details: amountValidation,
            });
          }

          primusSteps.amountValidated = true;
          await invoiceDoc.ref.update({
            primusSteps: primusSteps,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          await setWorkflowHeartbeat(invoiceDoc.ref, "amount_validated");

          await uploadCarrierBillEarly({
            invoice,
            invoiceDoc,
            invoiceId,
            primusSteps,
          });

          // Extra charges (e.g. lumper) are never auto-added to the customer
          // invoice, even when their proof checks out — a human must decide
          // via the A/B/C/D approval email. Once decided, the workflow
          // proceeds (additionalCharge.approved is set by the buttons).
          if (approvedChargeProofFiles.length > 0 &&
              !additionalChargeApproved) {
            if (additionalCharge && additionalCharge.decision) {
            // Already decided "not approved" (D) — dispute in progress.
              await logWorkflowStep({
                invoiceId,
                stepName: "extra_charges_held_for_review",
                stepStatus: "failed",
                reason: "Charge was not approved (dispute in progress)",
                error: "ADDITIONAL_CHARGE_DISPUTED",
              });
              await invoiceDoc.ref.update({
                processingLock: false,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
              return res.json({
                ok: false,
                error: "ADDITIONAL_CHARGE_DISPUTED",
              });
            }
            const additionalChargesMod = require("./additional-charges");
            const proofChargeRows = approvedChargeProofFiles.map((c) => ({
              label: c.type,
              amount: c.amount,
            }));

            let bookingBreakdown = [];
            try {
              const bookingForProof =
                await fetchPrimusBooking(invoice.loadNumber);
              bookingBreakdown = bookingForProof &&
                bookingForProof.vendor &&
                Array.isArray(bookingForProof.vendor.breakdown) ?
                bookingForProof.vendor.breakdown : [];
            } catch (_) {
              // Booking optional — treat all as net-new if unavailable.
            }
            const filteredProof =
              additionalChargesMod.filterChargesForApproval(
                  proofChargeRows, bookingBreakdown);

            if (filteredProof.skipApproval) {
              await logWorkflowStep({
                invoiceId,
                stepName: "extra_charges_filtered",
                stepStatus: "completed",
                reason:
                  "Proofed charges already in Primus or below $5 threshold",
                input: {
                  ignoredSmall: filteredProof.ignorableSmall,
                  alreadyInPrimus: filteredProof.alreadyInPrimus,
                },
              });
            } else {
              const actionCharges = filteredProof.chargesForAction;
              const proofTotal = additionalChargesMod.sumCharges(actionCharges);

              await logWorkflowStep({
                invoiceId,
                stepName: "extra_charges_held_for_review",
                stepStatus: "failed",
                reason: "Extra charges require A/B/C/D approval " +
                  "before invoicing",
                input: {approvedChargeProofFiles, approvedChargesTotal},
                error: "EXTRA_CHARGES_PENDING_REVIEW",
              });

              await invoiceDoc.ref.update({
                additionalCharge: {
                  status: "pending_approval",
                  source: "proofed_charges",
                  category: additionalChargesMod.CHARGE_CATEGORY.ACCESSORIAL,
                  charges: actionCharges,
                  amount: proofTotal,
                  approved: false,
                  decision: null,
                },
                decisionStage: "additional_charge_pending_approval",
                decisionReason:
                "Extra charges verified — awaiting A/B/C/D decision",
                processingLock: false,
                finalWorkflowStatus: "additional_charge_pending_approval",
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });

              const dispatcherForEmail = await (async () => {
                try {
                  const bridge = require("./primus-ui-bridge");
                  return await bridge.resolveDispatcherEmail({
                    loadNumber: invoice.loadNumber,
                    fetchBooking: fetchPrimusBooking,
                  });
                } catch (_) {
                  return {ok: false};
                }
              })();

              const approvalEmail =
            additionalChargesMod.buildAdditionalChargeApprovalEmail({
              baseUrl: `https://${req.get("host")}`,
              invoiceId,
              tenantId: (req.body && req.body.tenantId) || null,
              loadNumber: invoice.loadNumber,
              carrierName: invoice.carrierName,
              customerName: invoice.customerName || null,
              invoiceAmount: invoice.invoiceAmount,
              primusAmount: invoice.primusAmount || null,
              charges: actionCharges,
              chargesTotal: proofTotal,
              category: additionalChargesMod.CHARGE_CATEGORY.ACCESSORIAL,
              dispatcherName: dispatcherForEmail.displayName ||
                dispatcherForEmail.userName || null,
              customerRate: invoice.customerRate || null,
              excludedInPrimusCount: filteredProof.alreadyInPrimus.length,
            });

              const podFollowupMod = require("./pod-followup");
              const approver =
            process.env.ADDITIONAL_CHARGE_APPROVER_EMAIL ||
            podFollowupMod.SARAH_EMAIL;
              const approvalPayload =
            additionalChargesMod.applyAdditionalChargeEmailCc({
              type: "additional_charge_approval",
              invoiceId,
              subject: approvalEmail.subject,
              html: approvalEmail.html,
              forceRecipient: true,
              to: approver,
              cc: (dispatcherForEmail.ok && dispatcherForEmail.email &&
                dispatcherForEmail.email.toLowerCase() !==
                approver.toLowerCase()) ?
                dispatcherForEmail.email : undefined,
            });
              await saveOutboundEmail(approvalPayload);

              await additionalChargesMod.createFollowUp(db, {
                loadNumber: invoice.loadNumber,
                carrierName: invoice.carrierName,
                customerName: invoice.customerName || null,
                invoiceId,
                tenantId: (req.body && req.body.tenantId) || null,
                category: additionalChargesMod.CHARGE_CATEGORY.ACCESSORIAL,
                charges: actionCharges,
                chargesTotal: proofTotal,
                invoiceAmount: invoice.invoiceAmount,
                status: additionalChargesMod.FOLLOW_UP_STATUS.PENDING_APPROVAL,
              });

              return res.json({
                ok: false,
                error: "EXTRA_CHARGES_PENDING_REVIEW",
              });
            }
          }

          // PRO Number Handling - use Primus response proNumber
          const primusProNumber = amountValidation.proNumber || "";
          const invoiceProPlausible =
            loadResolution.isPlausibleCarrierPro(invoice.proNumber);
          if (invoice.proNumber && !invoiceProPlausible) {
            await writeLog("warn", "workflow",
                "Ignoring implausible PRO from invoice intake", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  proNumberRaw: invoice.proNumber,
                });
          }
          if (invoiceProPlausible &&
            invoice.proNumber.trim() !== "" && !primusProNumber) {
            await logWorkflowStep({
              invoiceId,
              stepName: "pro_check_started",
              stepStatus: "started",
              input: {
                invoicePro: invoice.proNumber,
                taiPro: primusProNumber,
              },
            });

            const proResult = await addProNumberToLoad(
                invoice.loadNumber,
                invoice.proNumber,
                {
                  invoiceNumber: invoice.invoiceNumber,
                  dueDate: invoice.dueDate,
                  carrierName: invoice.carrierName,
                },
            );

            await logWorkflowStep({
              invoiceId,
              stepName: "pro_added",
              stepStatus: proResult.ok ? "success" :
              (proResult.skipped ? "skipped" : "failed"),
              output: proResult.ok ? {
                newPro: invoice.proNumber,
                skipped: proResult.skipped || false,
                reason: proResult.reason || null,
              } : null,
              error: proResult.ok ? null : "Failed to add PRO to load",
            });
            if (proResult.ok) {
              await writeLog("info", "workflow",
                proResult.skipped ?
                  `PRO number step skipped — ${proResult.reason}` :
                  "PRO number written to Primus booking", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  proNumber: invoice.proNumber,
                });
            } else {
              await writeLog("warn", "workflow",
                  "Failed to write PRO number to Primus — workflow continues", {
                    invoiceId,
                    loadNumber: invoice.loadNumber,
                    proNumber: invoice.proNumber,
                    error: proResult.error,
                  });
            }

            if (proResult.ok) {
              primusSteps.proAdded = true;
              workingProNumber = invoice.proNumber;
              await invoiceDoc.ref.update({
                proNumber: workingProNumber,
                primusSteps: primusSteps,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });

              await setWorkflowHeartbeat(invoiceDoc.ref, "pro_added");
            }
          } else {
          // Use Primus proNumber if available, otherwise plausible invoice PRO
            workingProNumber = primusProNumber ||
              (invoiceProPlausible ? invoice.proNumber : "") ||
              workingProNumber;
            if (primusProNumber &&
              workingProNumber !== invoice.proNumber &&
              invoice.proNumber && !invoiceProPlausible) {
              await invoiceDoc.ref.update({
                proNumber: workingProNumber,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            }
          }
        } // end !skipToCustomerEmail (validation + PRO)

        // PRO is optional for FTL; workflow proceeds on load number alone.

        const runBillingPipeline = !skipToCustomerEmail &&
            (!currentStep || currentStep === "mark_delivered" ||
        currentStep === "check_customer" ||
        currentStep === "approve_bill" ||
        currentStep === "get_rate" ||
        currentStep === "generate_invoice");
        const runCustomerEmailStep =
            skipToCustomerEmail || runBillingPipeline ||
            currentStep === "send_customer_email";

        if (runCustomerEmailStep) {
          let customerName = invoice.customerName || "";
          let customerRate = Number(invoice.customerRate || 0);
          let profit = Number.isFinite(Number(invoice.profit)) ?
          Number(invoice.profit) : 0;
          let marginPctCalc = customerRate > 0 ?
          Math.round((profit / customerRate) * 100) : 0;
          if (skipToCustomerEmail && !invoice.customerInvoiceId &&
              invoice.loadNumber) {
            const issuedUi =
              await lookupIssuedUiCustomerInvoice(invoice.loadNumber);
            if (issuedUi && issuedUi.id) {
              invoice.customerInvoiceId = issuedUi.id;
              invoice.issuedInvoiceNumber = issuedUi.invoiceNumber ||
                invoice.issuedInvoiceNumber || null;
              primusSteps.uiInvoiceIssued = true;
              primusSteps.customerInvoiceGenerated = true;
              await invoiceDoc.ref.update({
                customerInvoiceId: issuedUi.id,
                issuedInvoiceNumber: invoice.issuedInvoiceNumber || null,
                primusSteps,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            }
          }

          let invoiceGenerationResult = invoice.customerInvoiceId ? {
            ok: true,
            customerInvoiceId: invoice.customerInvoiceId,
            invoiceNumber: invoice.issuedInvoiceNumber || null,
            reused: true,
          } : null;

          if (skipToCustomerEmail) {
            await logWorkflowStep({
              invoiceId,
              stepName: "billing_pipeline",
              stepStatus: "skipped",
              reason:
                "Carrier bill entered and customer invoice already issued",
              output: {
                customerInvoiceId: invoice.customerInvoiceId || null,
                issuedInvoiceNumber: invoice.issuedInvoiceNumber || null,
              },
            });
            if (invoice.customerInvoiceId) {
              primusSteps.customerInvoiceGenerated = true;
              primusSteps.uiInvoiceIssued = primusSteps.uiInvoiceIssued ||
              Boolean(invoice.customerInvoiceId);
              primusSteps.amountValidated = primusSteps.amountValidated || true;
            }
          } else if (runBillingPipeline) {
            if (!currentStep || currentStep === "mark_delivered" ||
        currentStep === "check_customer" ||
        currentStep === "approve_bill" ||
        currentStep === "get_rate" ||
        currentStep === "generate_invoice") {
              // Skip if already marked delivered (from primusSteps or
              // Primus duplicate)
              if (primusSteps.shipmentDelivered) {
                await logWorkflowStep({
                  invoiceId,
                  stepName: "shipment_mark_delivered_started",
                  stepStatus: "skipped",
                  output: {reason: "Already marked delivered"},
                });
              } else {
                await logWorkflowStep({
                  invoiceId,
                  stepName: "shipment_mark_delivered_started",
                  stepStatus: "started",
                  input: {
                    loadNumber: invoice.loadNumber,
                    proNumber: workingProNumber,
                  },
                });

                const deliveredRes = await markShipmentDelivered(
                    invoice.loadNumber,
                    workingProNumber,
                );

                // Treat "already delivered" as success, not error
                const alreadyDelivered = isAlreadyDoneResult(deliveredRes);
                if (!deliveredRes.ok && !alreadyDelivered) {
                  const deliveredErr = (deliveredRes && deliveredRes.error) ||
                    "Failed to mark shipment delivered";

                  await logWorkflowStep({
                    invoiceId,
                    stepName: "shipment_mark_delivered_completed",
                    stepStatus: "failed",
                    reason: deliveredErr,
                    error: "MARK_DELIVERED_FAILED",
                    output: deliveredRes || null,
                  });

                  await writeLog(
                      "error",
                      "workflow",
                      "Mark shipment delivered failed",
                      {
                        invoiceId,
                        loadNumber: invoice.loadNumber,
                        proNumber: workingProNumber || null,
                        error: deliveredErr,
                        details: deliveredRes || null,
                      },
                  );

                  await pauseWorkflow(
                      invoiceDoc.ref,
                      "mark_delivered",
                      "mark_delivered_failed",
                      deliveredErr,
                  );

                  await sendWorkflowAlert({
                    req,
                    code: "MARK_DELIVERED_FAILED",
                    invoiceId,
                    type: "mark_delivered_failed",
                    context: {
                      loadNumber: invoice.loadNumber,
                      carrierName: invoice.carrierName,
                      proNumber: workingProNumber || invoice.proNumber || null,
                      errorMessage: deliveredErr,
                    },
                  });

                  return res.json({
                    ok: false,
                    error: "MARK_DELIVERED_FAILED",
                    workflowStatus: "mark_delivered_failed",
                    details: deliveredRes,
                  });
                }

                await writeLog("info", "workflow",
                alreadyDelivered ?
                  "Shipment already marked delivered in Primus — skipped" :
                  "Shipment marked delivered in Primus", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  proNumber: workingProNumber || null,
                  alreadyDelivered,
                });
              }
              primusSteps.shipmentDelivered = true;
              await invoiceDoc.ref.update({
                primusSteps: primusSteps,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });

              await setWorkflowHeartbeat(invoiceDoc.ref, "shipment_delivered");

              await logWorkflowStep({
                invoiceId,
                stepName: "shipment_mark_delivered_completed",
                stepStatus: "success",
                output: {status: "delivered"},
              });
            }

            await logWorkflowStep({
              invoiceId,
              stepName: "customer_check_started",
              stepStatus: "started",
              input: {
                loadNumber: invoice.loadNumber,
                proNumber: workingProNumber,
              },
            });

            let customerNameForCheck = invoice.customerName;
            const customerForCheckResult = await getCustomerRate(
                invoice.loadNumber,
                workingProNumber,
            );

            if (customerForCheckResult && customerForCheckResult.ok) {
              customerNameForCheck = customerForCheckResult.customerName;
              await invoiceDoc.ref.update({
                customerName: customerNameForCheck,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
              await writeLog("info", "workflow",
                  "Customer rate fetched from Primus", {
                    invoiceId,
                    loadNumber: invoice.loadNumber,
                    customerName: customerForCheckResult.customerName,
                    customerRate: customerForCheckResult.customerRate,
                    rateSource: customerForCheckResult.rateSource,
                  });
            } else {
              if (customerForCheckResult &&
                  customerForCheckResult.customerName) {
                customerNameForCheck = customerForCheckResult.customerName;
                await invoiceDoc.ref.update({
                  customerName: customerNameForCheck,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
              }
              await writeLog("warn", "workflow",
                  "Could not fetch customer rate from Primus", {
                    invoiceId,
                    loadNumber: invoice.loadNumber,
                    error: customerForCheckResult &&
                      customerForCheckResult.error,
                  });
            }

            const hasCustomerName = Boolean(
                customerNameForCheck &&
            String(customerNameForCheck).trim(),
            );
            if (!hasCustomerName) {
              await logWorkflowStep({
                invoiceId,
                stepName: "customer_check_paused",
                stepStatus: "stopped",
                reason: "No customer on load",
                error: "MISSING_CUSTOMER",
              });

              await pauseWorkflow(
                  invoiceDoc.ref,
                  "check_customer",
                  "needs_customer_review",
                  "No customer on load",
              );

              if (notifyDispatcherRateIssue) {
                await notifyDispatcherRateIssue({
                  req,
                  code: "MISSING_CUSTOMER",
                  invoiceId,
                  tenantId: (req.body && req.body.tenantId) || null,
                  loadNumber: invoice.loadNumber,
                  context: {
                    loadNumber: invoice.loadNumber,
                    carrierName: invoice.carrierName,
                    invoiceAmount: invoice.invoiceAmount,
                  },
                });
              } else {
                await sendWorkflowAlert({
                  req,
                  code: "MISSING_CUSTOMER",
                  invoiceId,
                  type: "customer_missing",
                  context: {
                    loadNumber: invoice.loadNumber,
                    carrierName: invoice.carrierName,
                    invoiceAmount: invoice.invoiceAmount,
                  },
                });
              }

              return res.json({
                ok: true,
                workflowStatus: "needs_customer_review",
              });
            }

            await logWorkflowStep({
              invoiceId,
              stepName: "bill_approval_started",
              stepStatus: "started",
              input: {
                loadNumber: invoice.loadNumber,
                carrierName: invoice.carrierName,
                invoiceAmount: invoice.invoiceAmount,
              },
            });

            const billApprovalData = {
              loadNumber: invoice.loadNumber,
              proNumber: workingProNumber,
              carrierName: invoice.carrierName,
              invoiceNumber: invoice.invoiceNumber,
              invoiceAmount: invoice.invoiceAmount,
              podStoragePath:
          (extractedPodOnlyFile && extractedPodOnlyFile.storagePath) ||
          (invoice.podOnlyFile && invoice.podOnlyFile.storagePath) ||
          null,
            };

            const approvalResult = await approveCarrierBill(billApprovalData);

            // Treat "already approved" as success, not error
            const alreadyApproved = isAlreadyDoneResult(approvalResult);
            const isSuccess = approvalResult.ok || alreadyApproved;

            await logWorkflowStep({
              invoiceId,
              stepName: "bill_approval_completed",
              stepStatus: isSuccess ? "success" : "failed",
              output: isSuccess ?
        {billId: approvalResult.billId, alreadyApproved} : null,
              error: isSuccess ? null : "Carrier bill approval failed",
            });

            if (!isSuccess) {
              await writeLog(
                  "error", "workflow", "Carrier bill approval failed", {
                    invoiceId: invoiceId,
                    approvalResult: approvalResult,
                  });

              await invoiceDoc.ref.update({
                decisionStage: "approval_failed",
                decisionReason: "Carrier bill approval failed",
                finalWorkflowStatus: "failed",
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });

              return res.json({
                ok: false,
                error: "Carrier bill approval failed",
                details: approvalResult,
              });
            }

            await writeLog("info", "workflow",
            alreadyApproved ?
              "Carrier bill already approved — skipped" :
              "Carrier bill approved", {
              invoiceId,
              loadNumber: invoice.loadNumber,
              carrierName: invoice.carrierName,
              invoiceAmount: invoice.invoiceAmount,
              alreadyApproved,
            });

            primusSteps.billApproved = true;
            await invoiceDoc.ref.update({
              primusSteps: primusSteps,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            await setWorkflowHeartbeat(invoiceDoc.ref, "bill_approved");

            await logWorkflowStep({
              invoiceId,
              stepName: "customer_rate_check_started",
              stepStatus: "started",
              input: {
                loadNumber: invoice.loadNumber,
                proNumber: workingProNumber,
              },
            });

            const manualRate = Number(invoice.customerRate || 0);
            const manualCustomerName = String(
                invoice.customerName || "",
            ).trim();
            let customerRateResult = customerForCheckResult;

            // setCustomerRate saves to Firestore before resume; Primus may
            // still report no rate — honor the manual entry instead of pausing.
            if (!customerRateResult.ok && manualRate > 0) {
              customerRateResult = {
                ok: true,
                customerName: manualCustomerName ||
                  customerNameForCheck ||
                  (customerForCheckResult &&
                    customerForCheckResult.customerName) ||
                  null,
                customerRate: manualRate,
                rateSource: "manual",
              };
              await writeLog("info", "workflow",
                  "Using manually set customer rate", {
                    invoiceId,
                    loadNumber: invoice.loadNumber,
                    customerRate: manualRate,
                    customerName: customerRateResult.customerName,
                  });
            }

            if (!customerRateResult.ok) {
              await logWorkflowStep({
                invoiceId,
                stepName: "customer_rate_check_paused",
                stepStatus: "stopped",
                reason: "Missing customer rate",
                error: "MISSING_RATE",
              });

              await pauseWorkflow(
                  invoiceDoc.ref,
                  "get_rate",
                  "needs_customer_rate_review",
                  "Missing customer rate",
              );

              if (notifyDispatcherRateIssue) {
                await notifyDispatcherRateIssue({
                  req,
                  code: "MISSING_RATE",
                  invoiceId,
                  tenantId: (req.body && req.body.tenantId) || null,
                  loadNumber: invoice.loadNumber,
                  context: {
                    loadNumber: invoice.loadNumber,
                    carrierName: invoice.carrierName,
                    invoiceAmount: invoice.invoiceAmount,
                  },
                });
              } else {
                await sendWorkflowAlert({
                  req,
                  code: "MISSING_RATE",
                  invoiceId,
                  type: "rate_missing",
                  context: {
                    loadNumber: invoice.loadNumber,
                    carrierName: invoice.carrierName,
                    invoiceAmount: invoice.invoiceAmount,
                  },
                });
              }

              return res.json({
                ok: true,
                workflowStatus: "needs_customer_rate_review",
              });
            }

            customerName = customerRateResult.customerName ||
              manualCustomerName || customerNameForCheck || "";
            // Manual rate from setCustomerRate wins over Primus.
            const primusRate = customerRateResult.rateSource === "manual" ?
              0 : Number(customerRateResult.customerRate || 0);
            customerRate = manualRate || primusRate;
            // Carrier cost for profit: use the amount Jerry enters (carrier
            // invoice), not the Primus quoted cost on the booking.
            const bookingCarrierCost = Number(
                amountValidation.enteredAmount ||
            amountValidation.submittedAmount ||
            invoice.invoiceAmount || 0,
            );
            const customerRevenue = Number(customerRate || 0) +
              customerBillAccessorialTotal;
            profit = customerRevenue -
          (bookingCarrierCost - approvedChargesTotal);
            marginPctCalc = customerRevenue > 0 ?
          Math.round((profit / customerRevenue) * 100) : 0;

            await writeLog(
                "info", "workflow", "Customer rate and profit check", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  customerName,
                  customerRate,
                  customerBillAccessorialTotal,
                  customerRevenue,
                  carrierInvoiceAmount: invoice.invoiceAmount,
                  approvedChargesTotal,
                  profit,
                  marginPct: marginPctCalc,
                  willPause: !customerRate || Number(customerRate) <= 0 ||
                profit < 10,
                });

            primusSteps.customerRateChecked = true;

            await invoiceDoc.ref.update({
              customerName: customerName,
              customerRate: customerRate,
              profit: profit,
              primusSteps: {
                ...primusSteps,
                customerRateChecked: true,
              },
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            await setWorkflowHeartbeat(invoiceDoc.ref, "customer_rate_checked");

            if (!customerRate || Number(customerRate) <= 0 || profit < 10) {
              const pauseReason = !customerRate || Number(customerRate) <= 0 ?
        "Missing customer rate" : "Customer rate too low";
              await logWorkflowStep({
                invoiceId,
                stepName: "customer_rate_check_paused",
                stepStatus: "stopped",
                reason: pauseReason,
                output: {customerRate, profit},
                error: "LOW_MARGIN",
              });

              await pauseWorkflow(
                  invoiceDoc.ref,
                  "get_rate",
                  "needs_customer_rate_review",
                  pauseReason,
              );

              const isLowMargin = customerRate > 0;
              const marginPct = marginPctCalc;
              const carrierCost = bookingCarrierCost - approvedChargesTotal;
              if (notifyDispatcherRateIssue) {
                await notifyDispatcherRateIssue({
                  req,
                  code: isLowMargin ? "LOW_MARGIN" : "MISSING_RATE",
                  invoiceId,
                  tenantId: (req.body && req.body.tenantId) || null,
                  loadNumber: invoice.loadNumber,
                  context: {
                    loadNumber: invoice.loadNumber,
                    carrierName: invoice.carrierName,
                    customerName,
                    customerRate,
                    carrierCost,
                    profit,
                    marginPct,
                    invoiceAmount: invoice.invoiceAmount,
                  },
                });
              } else {
                await sendWorkflowAlert({
                  req,
                  code: isLowMargin ? "LOW_MARGIN" : "MISSING_RATE",
                  invoiceId,
                  type: "rate_missing",
                  context: {
                    loadNumber: invoice.loadNumber,
                    carrierName: invoice.carrierName,
                    customerName,
                    customerRate,
                    carrierCost,
                    profit,
                    marginPct,
                    invoiceAmount: invoice.invoiceAmount,
                  },
                });
              }

              return res.json({
                ok: true,
                workflowStatus: "needs_customer_rate_review",
              });
            }

            let billToReferenceNumber = invoice.billToReferenceNumber || null;
            let bookingForInvoice = bookingForMode;
            if (!bookingForInvoice && invoice.loadNumber) {
              try {
                bookingForInvoice =
                  await fetchPrimusBooking(invoice.loadNumber);
              } catch (_) {
                bookingForInvoice = null;
              }
            }

            // Broker 10% swap before billing — load must still be editable.
            const vendorCostForBroker = bookingCarrierCost -
              approvedChargesTotal;
            const brokerProfitPct = vendorCostForBroker > 0 ?
              Math.round((profit / vendorCostForBroker) * 10000) / 100 : 0;
            if (brokerProfitPct < 10 && invoice.loadNumber) {
              let brokerNameForSwap = "";
              const contact = bookingForInvoice &&
                bookingForInvoice.contactInformation;
              if (contact) {
                brokerNameForSwap = contact.salesRepName ||
                  (contact.salesRep && contact.salesRep.name) || "";
              }
              try {
                const brokerCommission = require("./broker-commission");
                await brokerCommission.adjustBrokerCommissionForLowMargin({
                  loadNumber: invoice.loadNumber,
                  margin: brokerProfitPct,
                  profit,
                  brokerName: brokerNameForSwap,
                  carrierName: invoice.carrierName,
                  customerRate,
                  carrierCost: vendorCostForBroker,
                  vendorCost: vendorCostForBroker,
                  invoiceAmount: invoice.invoiceAmount,
                  booking: bookingForInvoice,
                  trigger: "pre_billing",
                });
              } catch (brokerErr) {
                await writeLog("warn", "workflow",
                    "Pre-billing broker commission check failed", {
                      invoiceId,
                      loadNumber: invoice.loadNumber,
                      error: brokerErr.message,
                    });
              }
            }

            const isPowerOnlyForInvoice = bookingForInvoice &&
          isPowerOnlyShipment && isPowerOnlyShipment(bookingForInvoice);
            if (isPowerOnlyForInvoice && readBillToReferenceNumber) {
              billToReferenceNumber =
            readBillToReferenceNumber(bookingForInvoice) ||
            billToReferenceNumber;
              if (!billToReferenceNumber) {
                await logWorkflowStep({
                  invoiceId,
                  stepName: "power_only_unit_check",
                  stepStatus: "stopped",
                  reason: "Bill To Reference# missing (unit number)",
                  error: "MISSING_UNIT_NUMBER",
                  output: {loadNumber: invoice.loadNumber},
                });
                await pauseWorkflow(
                    invoiceDoc.ref,
                    "customer_invoice",
                    "missing_unit_number",
                    "Power Only — Bill To Reference# (unit #) required",
                );
                await sendWorkflowAlert({
                  req,
                  code: "MISSING_UNIT_NUMBER",
                  invoiceId,
                  type: "missing_unit_number",
                  context: {
                    loadNumber: invoice.loadNumber,
                    carrierName: invoice.carrierName,
                    customerName,
                    shipmentMode: readShipmentMode(bookingForInvoice) ||
                  "Power Only",
                  },
                });
                await writeLog("warn", "workflow",
                    "Power Only — Bill To Reference# missing before invoice", {
                      invoiceId,
                      loadNumber: invoice.loadNumber,
                    });
                return res.json({
                  ok: true,
                  workflowStatus: "missing_unit_number",
                });
              }
              await invoiceDoc.ref.update({
                billToReferenceNumber,
                shipmentMode:
                  readShipmentMode(bookingForInvoice) || "Power Only",
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
              invoice.billToReferenceNumber = billToReferenceNumber;
            }

            await writeLog("info", "workflow", "Generating customer invoice", {
              invoiceId: invoiceId,
              customerName: customerName,
              customerRate: customerRate,
              billToReferenceNumber: billToReferenceNumber || null,
            });

            await logWorkflowStep({
              invoiceId,
              stepName: "customer_invoice_generation_started",
              stepStatus: "started",
              input: {
                customerName,
                customerRate,
                billToReferenceNumber: billToReferenceNumber || null,
              },
            });

            const customerInvoiceData = {
              loadNumber: invoice.loadNumber,
              proNumber: workingProNumber,
              customerName: customerName,
              customerRate: customerRate,
              carrierInvoiceAmount: invoice.invoiceAmount,
              billToReferenceNumber: billToReferenceNumber || null,
              podPdfStoragePath:
          (extractedPodOnlyFile && extractedPodOnlyFile.storagePath) ||
          (invoice.podOnlyFile && invoice.podOnlyFile.storagePath) ||
          null,
            };

            // Customer invoice: REST draft-only, or UI bridge when enabled.
            const useUiBridge = isManagePhpEnabled && isManagePhpEnabled();

            if (useUiBridge) {
              if (primusSteps.uiInvoiceIssued) {
                await writeLog(
                    "info", "workflow", "UI invoice already issued — skipped", {
                      invoiceId,
                      customerInvoiceId: invoice.customerInvoiceId,
                    });
                await logWorkflowStep({
                  invoiceId,
                  stepName: "customer_invoice_generation_completed",
                  stepStatus: "skipped",
                  reason: "UI invoice already issued",
                  output: {customerInvoiceId: invoice.customerInvoiceId},
                });
                invoiceGenerationResult = {
                  ok: true,
                  customerInvoiceId: invoice.customerInvoiceId,
                  generated: true,
                  reused: true,
                  invoiceTotal: customerRate + customerBillAccessorialTotal,
                };
                primusSteps.customerInvoiceGenerated = true;
                await invoiceDoc.ref.update({
                  primusSteps,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                await setWorkflowHeartbeat(
                    invoiceDoc.ref, "customer_invoice_exists");
                // Backfill QB if issued before sync moved earlier.
                await pushCarrierBillToQuickBooks({
                  req,
                  invoiceDoc,
                  invoiceId,
                  invoice,
                  primusSteps,
                  customerInvoiceId: invoice.customerInvoiceId,
                  invoiceNumber: invoice.issuedInvoiceNumber,
                });
              } else {
                const bk = await fetchPrimusBooking(invoice.loadNumber);
                const podPath =
                (extractedPodOnlyFile && extractedPodOnlyFile.storagePath) ||
                (invoice.podOnlyFile && invoice.podOnlyFile.storagePath) ||
                null;
                let carrierBillPdf = null;
                let podPdf = null;
                carrierBillPdf = await loadCarrierBillPdfFromInvoice(invoice);
                if (podPath) {
                  const podB64 = await downloadStorageFileBase64(podPath);
                  if (podB64) {
                    podPdf = {
                      buffer: Buffer.from(podB64, "base64"),
                      filename: `pod-${invoice.loadNumber}.pdf`,
                    };
                  }
                }
                const uiResult = await runUiBillingFlowWithRetry({
                  booking: bk,
                  loadNumber: invoice.loadNumber,
                  customerRate,
                  customerBillLines: optionBCustomerBillLines,
                  carrierInvoiceAmount: invoice.invoiceAmount,
                  carrierName: invoice.carrierName || null,
                  proNumber: workingProNumber || invoice.proNumber,
                  vendorInvoiceNumber: invoice.invoiceNumber ||
                  invoice.carrierInvoiceNumber ||
                  workingProNumber || invoice.proNumber,
                  billDate: invoice.invoiceDate || invoice.receivedAt,
                  billDueDate: invoice.dueDate,
                  customerInvoiceId: invoice.customerInvoiceId || null,
                  generated: false,
                  carrierBillPdf,
                  podPdf,
                  billToReferenceNumber: billToReferenceNumber || null,
                  skipCarrierBillUpload: primusSteps.carrierBillUploaded,
                  skipPodUpload: primusSteps.podUploaded,
                }, {invoiceId, loadNumber: invoice.loadNumber});

                const uiOk = uiResult.ok ||
              (uiResult.skipped && uiResult.reason === "already issued");
                await logWorkflowStep({
                  invoiceId,
                  stepName: "customer_invoice_generation_completed",
                  stepStatus: uiOk ? "success" :
                (uiResult.skipped ? "skipped" : "failed"),
                  output: uiOk ? {
                    customerInvoiceId: uiResult.customerInvoiceId ||
                  invoice.customerInvoiceId,
                    invoiceNumber: uiResult.invoiceNumber || null,
                    via: "manage.php",
                  } : null,
                  error: uiOk ? null :
                (uiResult.error || "UI billing flow failed"),
                });

                invoiceGenerationResult = {
                  ok: uiOk,
                  customerInvoiceId: uiResult.customerInvoiceId ||
                invoice.customerInvoiceId,
                  invoiceNumber: uiResult.invoiceNumber || null,
                  invoiceTotal: customerRate + customerBillAccessorialTotal,
                  generated: !!(uiResult.issued || uiResult.generated),
                  reused: !!(uiResult.skipped &&
                uiResult.reason === "already issued"),
                  error: uiResult.error || null,
                  step: uiResult.step || null,
                  billtoSource: uiResult.billtoSource || null,
                  billtoPartyName: uiResult.billtoPartyName || null,
                };

                if (!uiOk) {
                  await writeLog(
                      "error",
                      "workflow",
                      "UI billing flow failed",
                      {
                        invoiceId,
                        loadNumber: invoice.loadNumber,
                        result: uiResult,
                      },
                  );

                  await invoiceDoc.ref.update({
                    processingLock: false,
                    finalWorkflowStatus: "needs_invoice_review",
                    decisionStage: "invoice_generation_failed",
                    decisionReason: uiResult.error || "UI billing flow failed",
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                  });

                  await sendWorkflowAlert({
                    req,
                    code: "UI_BILLING_FAILED",
                    invoiceId,
                    type: "invoice_generation_failed",
                    context: {
                      loadNumber: invoice.loadNumber,
                      carrierName: invoice.carrierName,
                      customerName,
                      errorMessage: uiResult.error || "Unknown error",
                      step: uiResult.step || null,
                    },
                  });

                  return res.json({
                    ok: false,
                    error: "UI billing flow failed",
                    details: uiResult,
                  });
                }

                primusSteps.customerInvoiceGenerated = true;
                primusSteps.uiInvoiceIssued = !!(uiResult.issued ||
              (uiResult.skipped && uiResult.reason === "already issued"));
                primusSteps.carrierBillUploaded = !!(
                  primusSteps.carrierBillUploaded ||
              uiResult.carrierBillUploaded ||
              (uiResult.carrierBillUpload &&
                (uiResult.carrierBillUpload.uploaded ||
                  uiResult.carrierBillUpload.skipped)));
                primusSteps.podUploaded = !!(
                  primusSteps.podUploaded ||
              uiResult.podUploaded ||
              (uiResult.podUpload &&
                (uiResult.podUpload.uploaded || uiResult.podUpload.skipped)));
                if (uiResult.podUpload && uiResult.podUpload.fileId) {
                  primusSteps.podUploadFileId =
                    String(uiResult.podUpload.fileId);
                }
                await invoiceDoc.ref.update({
                  primusSteps,
                  customerInvoiceId: invoiceGenerationResult.customerInvoiceId,
                  issuedInvoiceNumber:
                invoiceGenerationResult.invoiceNumber || null,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });

                await writeLog("info", "workflow",
                invoiceGenerationResult.reused ?
                  "Customer invoice already issued in Primus — reused" :
                  "Carrier bill entered and invoice issued via manage.php", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  customerInvoiceId: invoiceGenerationResult.customerInvoiceId,
                  invoiceNumber: invoiceGenerationResult.invoiceNumber || null,
                  invoiceTotal: invoiceGenerationResult.invoiceTotal,
                  generated: invoiceGenerationResult.generated,
                  reused: invoiceGenerationResult.reused || false,
                  carrierBillUploaded: primusSteps.carrierBillUploaded,
                  podUploaded: primusSteps.podUploaded,
                  uploadSteps: uiResult.steps || null,
                });

                await setWorkflowHeartbeat(
                    invoiceDoc.ref, "customer_invoice_generated");

                // Push carrier bill to QB immediately — do not wait for
                // customer-email approval (loads parked at that gate never
                // reached the old end-of-workflow QB call).
                await pushCarrierBillToQuickBooks({
                  req,
                  invoiceDoc,
                  invoiceId,
                  invoice,
                  primusSteps,
                  customerInvoiceId: invoiceGenerationResult.customerInvoiceId,
                  invoiceNumber: invoiceGenerationResult.invoiceNumber,
                });
              }
            } else if (invoice.customerInvoiceId) {
              await writeLog(
                  "info", "workflow", "Customer invoice already exists", {
                    invoiceId: invoiceId,
                    customerInvoiceId: invoice.customerInvoiceId,
                  });

              await logWorkflowStep({
                invoiceId,
                stepName: "customer_invoice_generation_completed",
                stepStatus: "skipped",
                reason: "Customer invoice already exists",
                output: {customerInvoiceId: invoice.customerInvoiceId},
              });

              primusSteps.customerInvoiceGenerated = true;
              await invoiceDoc.ref.update({
                primusSteps: primusSteps,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });

              await setWorkflowHeartbeat(
                  invoiceDoc.ref, "customer_invoice_exists");
              await pushCarrierBillToQuickBooks({
                req,
                invoiceDoc,
                invoiceId,
                invoice,
                primusSteps,
                customerInvoiceId: invoice.customerInvoiceId,
                invoiceNumber: invoice.issuedInvoiceNumber,
              });
            } else {
              invoiceGenerationResult =
          await generateCustomerInvoice(customerInvoiceData);

              await logWorkflowStep({
                invoiceId,
                stepName: "customer_invoice_generation_completed",
                stepStatus: invoiceGenerationResult.ok ? "success" : "failed",
                output: invoiceGenerationResult.ok ?
          {customerInvoiceId: invoiceGenerationResult.customerInvoiceId} : null,
                error: invoiceGenerationResult.ok ? null :
          "Customer invoice generation failed",
              });

              if (!invoiceGenerationResult.ok) {
                await writeLog(
                    "error",
                    "workflow",
                    "Customer invoice generation failed",
                    {
                      invoiceId: invoiceId,
                      result: invoiceGenerationResult,
                    },
                );

                await invoiceDoc.ref.update({
                  processingLock: false,
                  finalWorkflowStatus: "needs_invoice_review",
                  decisionStage: "invoice_generation_failed",
                  decisionReason: invoiceGenerationResult.error ||
                "Customer invoice generation failed",
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });

                const primusTotal = invoiceGenerationResult.invoiceTotal || 0;
                const expectedRateVal =
              invoiceGenerationResult.expectedRate || customerRate;
                const diffVal = invoiceGenerationResult.difference ||
              Math.abs(primusTotal - expectedRateVal);
                const isMismatch = primusTotal > 0 && expectedRateVal > 0;
                await sendWorkflowAlert({
                  req,
                  code: isMismatch ?
                "INVOICE_RATE_MISMATCH" : "INVOICE_GENERATION_FAILED",
                  invoiceId,
                  type: "invoice_generation_failed",
                  context: {
                    loadNumber: invoice.loadNumber,
                    carrierName: invoice.carrierName,
                    customerName,
                    errorMessage: invoiceGenerationResult.error || "",
                    primusTotal,
                    expectedRate: expectedRateVal,
                    difference: diffVal,
                  },
                });

                return res.json({
                  ok: false,
                  error: "Customer invoice generation failed",
                  details: invoiceGenerationResult,
                });
              }

              primusSteps.customerInvoiceGenerated = true;
              await invoiceDoc.ref.update({
                primusSteps: primusSteps,
                customerInvoiceId: invoiceGenerationResult.customerInvoiceId,
                issuedInvoiceNumber:
                  invoiceGenerationResult.invoiceNumber || null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });

              await writeLog("info", "workflow",
              invoiceGenerationResult.reused ?
                "Customer invoice already existed in Primus — reused" :
                "Customer invoice created in Primus", {
                invoiceId,
                loadNumber: invoice.loadNumber,
                customerInvoiceId: invoiceGenerationResult.customerInvoiceId,
                invoiceNumber: invoiceGenerationResult.invoiceNumber || null,
                invoiceTotal: invoiceGenerationResult.invoiceTotal,
                generated: invoiceGenerationResult.generated,
                reused: invoiceGenerationResult.reused || false,
                pdfUrlAvailable: !!invoiceGenerationResult.invoicePdfUrl,
              });

              await setWorkflowHeartbeat(
                  invoiceDoc.ref, "customer_invoice_generated");

              await pushCarrierBillToQuickBooks({
                req,
                invoiceDoc,
                invoiceId,
                invoice,
                primusSteps,
                customerInvoiceId: invoiceGenerationResult.customerInvoiceId,
                invoiceNumber: invoiceGenerationResult.invoiceNumber,
              });
            }
          } // end runBillingPipeline

          const finalCustomerInvoiceId =
      (invoiceGenerationResult && invoiceGenerationResult.customerInvoiceId) ||
      invoice.customerInvoiceId || null;

          // Note: extra charges (lumper, etc.) are never auto-added here —
          // they're held for human review earlier in the workflow (see
          // "extra_charges_pending_review"), so finalCustomerInvoiceId only
          // ever reflects the base freight amount.

          // Customer email: Primus manage.php emailBOLDocs only (no Gmail).
          const uiIssued = !!primusSteps.uiInvoiceIssued;
          const managePhpActive = isManagePhpEnabled && isManagePhpEnabled();
          const issuedInvoiceNumber =
            (invoiceGenerationResult &&
              invoiceGenerationResult.invoiceNumber) ||
            invoice.issuedInvoiceNumber || null;

          let customerEmail = null;
          let customerEmailSource = null;
          let bookingForEmail = null;
          try {
            bookingForEmail = await fetchPrimusBooking(invoice.loadNumber);
            if (bookingForEmail) {
              if (resolveCustomerAccountingEmails && managePhpActive) {
                const resolved =
                  await resolveCustomerAccountingEmails(bookingForEmail);
                if (resolved.emails && resolved.emails.length) {
                  customerEmail = resolved.emails.join(",");
                  customerEmailSource = resolved.source || null;
                } else if (resolved.source === "no_accounting_contacts") {
                  customerEmailSource = "no_accounting_contacts";
                }
              }
            }
          } catch (emailLookupErr) {
            await writeLog("warn", "workflow",
                "Customer email lookup failed", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  error: emailLookupErr.message,
                });
          }

          const podStoragePath =
      (extractedPodOnlyFile && extractedPodOnlyFile.storagePath) ||
      (invoice.podOnlyFile && invoice.podOnlyFile.storagePath) ||
      null;

          // TL missing-POD chase: hold customer email until a POD arrives.
          const followUp = invoice.podFollowUp || null;
          const hasPodForCustomer = Boolean(podStoragePath ||
          invoice.podOnPrimusAlready ||
          (invoice.primusSteps && invoice.primusSteps.podUploaded));
          const stillHoldingPod = followUp && followUp.holdCustomerEmail &&
          followUp.status !== "resolved" && !hasPodForCustomer;
          if (stillHoldingPod) {
            await pauseWorkflow(
                invoiceDoc.ref,
                "send_customer_email",
                "awaiting_tl_pod",
                "TL invoice held — waiting for carrier POD " +
                "before customer email",
            );
            await writeLog("info", "workflow",
                "Customer email held — awaiting TL carrier POD", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  podFollowUpStatus: followUp.status,
                });
            return res.json({
              ok: true,
              workflowStatus: "awaiting_tl_pod",
            });
          }

          // Customer invoice emails send directly. The reviewer Approve/Reject
          // gate (and its approval emails) is removed. Still skip when a
          // reviewer previously rejected, and pause when no recipient exists.
          const emailApproval = invoice.customerEmailApproval || null;
          if (emailApproval === "rejected") {
            await logWorkflowStep({
              invoiceId,
              stepName: "final_email_sent",
              stepStatus: "skipped",
              reason: "Customer email rejected — not sent",
              output: {to: customerEmail},
            });
            await invoiceDoc.ref.update({
              decisionStage: "customer_email_rejected",
              decisionReason: "Customer email rejected — not sent",
              customerInvoiceId: finalCustomerInvoiceId,
              issuedInvoiceNumber: issuedInvoiceNumber || null,
              finalWorkflowStatus: "completed_no_customer_email",
              processingLock: false,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            await writeLog("warn", "workflow",
                "Customer email rejected — nothing sent", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  customerEmail,
                });
            return res.json({
              ok: true,
              workflowStatus: "customer_email_rejected",
            });
          }

          if (!customerEmail) {
            await pauseWorkflow(
                invoiceDoc.ref,
                "send_customer_email",
                "missing_accounting_email",
                "No accounting email found — fix recipient before sending",
            );
            await logWorkflowStep({
              invoiceId,
              stepName: "customer_email_missing_recipient",
              stepStatus: "stopped",
              reason: "Missing customer accounting email",
              output: {to: null},
            });
            await writeLog("warn", "workflow",
                "Customer email held — missing accounting email", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                });
            return res.json({
              ok: true,
              workflowStatus: "missing_accounting_email",
            });
          }

          await logWorkflowStep({
            invoiceId,
            stepName: "final_email_started",
            stepStatus: "started",
            input: {
              via: "primus_emailBOLDocs",
              customerEmail: customerEmail || null,
              customerEmailSource: customerEmailSource || null,
            },
          });

          await setWorkflowHeartbeat(invoiceDoc.ref, "final_email_sending");

          const primusEmailBlockers = [];
          if (!managePhpActive || !emailBOLDocs) {
            primusEmailBlockers.push("Primus manage.php email is not enabled");
          }
          if (!uiIssued) {
            primusEmailBlockers.push("Customer invoice was not issued via UI");
          }
          if (!finalCustomerInvoiceId) {
            primusEmailBlockers.push("Missing Primus customer invoice ID");
          }
          if (!customerEmail) {
            primusEmailBlockers.push("No customer accounting email found");
          }
          if (!bookingForEmail) {
            primusEmailBlockers.push("Could not load Primus booking");
          }

          let primusEmailFailed = false;
          let primusEmailFailureReason = "";

          if (primusEmailBlockers.length) {
            primusEmailFailed = true;
            primusEmailFailureReason = primusEmailBlockers.join("; ");
          } else {
            const extraDriveIds = [];
            if (primusSteps.podUploadFileId) {
              extraDriveIds.push(primusSteps.podUploadFileId);
            }
            let podPdfForEmail = null;
            if (podStoragePath) {
              const podB64 = await downloadStorageFileBase64(podStoragePath);
              if (podB64) {
                podPdfForEmail = {
                  buffer: Buffer.from(podB64, "base64"),
                  filename: `pod-${invoice.loadNumber}.pdf`,
                };
              }
            }
            const primusEmailResult = await emailBOLDocs({
              booking: bookingForEmail,
              loadNumber: invoice.loadNumber,
              customerEmail,
              customerName,
              customerInvoiceId: finalCustomerInvoiceId,
              invoiceNumber: issuedInvoiceNumber || "0",
              chargesTotal: customerRate,
              podPdf: podPdfForEmail,
              extraDriveFileIds: extraDriveIds,
            });
            if (primusEmailResult.ok) {
              await logWorkflowStep({
                invoiceId,
                stepName: "final_email_sent",
                stepStatus: "success",
                output: {
                  via: "primus_emailBOLDocs",
                  to: customerEmail,
                  customerEmailSource: customerEmailSource || null,
                  attachments: primusEmailResult.attachments || null,
                  driveFileIds: primusEmailResult.driveFileIds || [],
                  message: primusEmailResult.json &&
                  primusEmailResult.json.message,
                },
              });
              await writeLog("info", "workflow",
                  "Customer documents emailed via Primus emailBOLDocs", {
                    invoiceId,
                    flowId,
                    to: customerEmail,
                    customerInvoiceId: finalCustomerInvoiceId,
                    invoiceNumber: issuedInvoiceNumber,
                    attachments: primusEmailResult.attachments,
                    driveFileIds: primusEmailResult.driveFileIds,
                  });
            } else {
              primusEmailFailed = true;
              primusEmailFailureReason =
              primusEmailResult.error || "emailBOLDocs failed";
              await logWorkflowStep({
                invoiceId,
                stepName: "final_email_sent",
                stepStatus: "failed",
                error: primusEmailFailureReason,
              });
              await writeLog("error", "workflow",
                  "Primus emailBOLDocs failed", {
                    invoiceId,
                    loadNumber: invoice.loadNumber,
                    to: customerEmail,
                    attachments: primusEmailResult.attachments || null,
                    error: primusEmailResult.error,
                    raw: primusEmailResult.raw,
                  });
            }
          }

          if (primusEmailFailed) {
            await invoiceDoc.ref.update({
              decisionStage: "customer_email_failed",
              decisionReason: primusEmailFailureReason,
              customerName: customerName,
              customerRate: customerRate,
              profit: profit,
              primusSteps: primusSteps,
              finalWorkflowStatus: "customer_email_failed",
              customerInvoiceId: finalCustomerInvoiceId,
              issuedInvoiceNumber: issuedInvoiceNumber || null,
              processingLock: false,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            await sendWorkflowAlert({
              req,
              code: "CUSTOMER_EMAIL_FAILED",
              invoiceId,
              type: "customer_email_failed",
              priorInvoice: invoice,
              context: {
                loadNumber: invoice.loadNumber,
                customerName,
                recipient: customerEmail,
                invoiceDocId: finalCustomerInvoiceId,
                errorMessage: primusEmailFailureReason,
              },
            });

            return res.json({
              ok: false,
              error: primusEmailFailureReason,
              workflowStatus: "customer_email_failed",
            });
          }

          await invoiceDoc.ref.update({
            decisionStage: "completed",
            decisionReason: "Primus workflow completed successfully",
            customerName: customerName,
            customerRate: customerRate,
            profit: profit,
            primusSteps: primusSteps,
            finalWorkflowStatus: "completed",
            customerInvoiceId: finalCustomerInvoiceId,
            issuedInvoiceNumber: issuedInvoiceNumber || null,
            processingLock: false,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          await writeLog("info", "workflow", "Primus workflow completed", {
            invoiceId,
            flowId,
            loadNumber: invoice.loadNumber,
            carrierName: invoice.carrierName,
            carrierInvoiceAmount: invoice.invoiceAmount,
            customerName,
            customerRate,
            profit,
            marginPct: marginPctCalc,
            customerInvoiceId: finalCustomerInvoiceId,
            primusSteps,
            pdfSource: "primus_email",
            podSource: "primus_email",
          });


          if (invoice.gmailMessageId) {
            await writeLog(
                "info", "workflow", "Invoice approved and completed", {
                  event: "Workflow completed - APPROVED",
                  invoiceId: invoiceId,
                  details: {
                    finalStatus: "APPROVED",
                    invoiceAmount: invoice.invoiceAmount,
                    primusAmount: invoice.primusAmount,
                    carrierName: invoice.carrierName,
                    loadNumber: invoice.loadNumber,
                    proNumber: invoice.proNumber,
                    customerInvoiceId: finalCustomerInvoiceId,
                    decision: "APPROVED",
                    reason:
                      "All validations passed and customer invoice generated",
                    approvedChargesTotal: invoice.approvedChargesTotal || 0,
                    baseAmountValidated: invoice.baseAmountValidated,
                    approvedChargeProofFiles: invoice.approvedChargeProofFiles ?
            invoice.approvedChargeProofFiles.length : 0,
                  },
                });
          }

          // Backstop: push to QB if early sync was skipped (older invoices)
          // or failed transiently. Idempotent via primusSteps.qbBillingSynced.
          if (finalCustomerInvoiceId && !primusSteps.qbBillingSynced) {
            await pushCarrierBillToQuickBooks({
              req,
              invoiceDoc,
              invoiceId,
              invoice,
              primusSteps,
              customerInvoiceId: finalCustomerInvoiceId,
              invoiceNumber: issuedInvoiceNumber,
            });
          }

          await logWorkflowStep({
            invoiceId,
            stepName: "workflow_completed",
            stepStatus: "success",
            output: {
              customerName,
              profit,
              customerInvoiceId: finalCustomerInvoiceId,
            },
          });

          if (typeof scheduleFlowSummary === "function") {
            scheduleFlowSummary(
                invoice.flowId || invoice.gmailMessageId || invoiceId);
          }

          return res.json({
            ok: true,
            message: "Primus workflow completed successfully",
            customerName: customerName,
            customerRate: customerRate,
            profit: profit,
            customerInvoiceId: finalCustomerInvoiceId,
            workflowStatus: "completed",
            qbBillingSynced: !!primusSteps.qbBillingSynced,
          });
        } // end runCustomerEmailStep
      } catch (error) {
        const invoiceId = (req.body && req.body.invoiceId) || null;

        await logWorkflowStep({
          invoiceId,
          stepName: "workflow_failed",
          stepStatus: "failed",
          reason: error.message,
          error: error.message,
        });

        await writeLog("error", "workflow", "Primus workflow failed", {
          invoiceId,
          error: error.message,
          stack: error.stack,
        });
        console.error("processPrimusWorkflow error:", error);

        let loadNumber = null;
        let carrierName = null;
        if (invoiceId) {
          const invoiceDoc =
            await db.collection("invoices").doc(invoiceId).get();
          if (invoiceDoc.exists) {
            const inv = invoiceDoc.data();
            loadNumber = inv.loadNumber || null;
            carrierName = inv.carrierName || null;
            await invoiceDoc.ref.update({
              processingLock: false,
              finalWorkflowStatus: "failed",
              lastHeartbeatAt: admin.firestore.FieldValue.serverTimestamp(),
              currentStep: inv.currentStep || "failed",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        }

        if (invoiceId) {
          try {
            await sendWorkflowAlert({
              req,
              code: "WORKFLOW_FAILED",
              invoiceId,
              type: "workflow_failed",
              context: {
                loadNumber,
                carrierName,
                errorMessage: error.message,
              },
            });
          } catch (emailErr) {
            console.error("workflow_failed alert email error:", emailErr);
          }
        }

        return res.status(500).json({
          ok: false,
          error: "Internal server error.",
          details: error.message,
        });
      }
    },
);
