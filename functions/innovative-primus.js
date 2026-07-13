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
const {google} = require("googleapis");
const workflowErrors = require("./workflow-error-messages");

// Injected from index.js (see init). Declared at module scope so the moved
// workflow code below can call them by their original bare names, unchanged.
let db;
let writeLog;
let logWorkflowStep;
let setWorkflowHeartbeat;
let pauseWorkflow;
let saveOutboundEmail;
let escapeHtml;
let maybeExtractPodOnlyPdf;
let isAlreadyDoneResult;
let downloadStorageFileBase64;
let primusRequest;
let fetchPrimusBooking;
let readShipmentMode;
let isDrayageShipment;
let validateAmountWithPrimus;
let addProNumberToLoad;
let getCustomerRate;
let approveCarrierBill;
let generateCustomerInvoice;
let markShipmentDelivered;
let forwardToHumanReview;
let getGmailOAuthClient;
let isManagePhpEnabled;
let runPrimusUiBillingFlow;
let emailBOLDocs;
let resolveCustomerAccountingEmails;

/**
 * Receives the shared + Primus helper bundle from index.js.
 * @param {object} bundle Injected helpers.
 * @return {void}
 */
function init(bundle) {
  ({
    db, writeLog, logWorkflowStep, setWorkflowHeartbeat, pauseWorkflow,
    saveOutboundEmail, escapeHtml,
    maybeExtractPodOnlyPdf,
    isAlreadyDoneResult,
    downloadStorageFileBase64,
    primusRequest, fetchPrimusBooking, readShipmentMode, isDrayageShipment,
    validateAmountWithPrimus, addProNumberToLoad,
    getCustomerRate, approveCarrierBill, generateCustomerInvoice,
    markShipmentDelivered, forwardToHumanReview, getGmailOAuthClient,
    isManagePhpEnabled, runPrimusUiBillingFlow, emailBOLDocs,
    resolveCustomerAccountingEmails,
  } = bundle);
}
exports.init = init;

/**
 * @param {number|null|undefined} amount Money value.
 * @return {string}
 */
function moneyFmt(amount) {
  if (amount == null || amount === "" || !Number.isFinite(Number(amount))) {
    return "—";
  }
  return `$${Number(amount).toFixed(2)}`;
}

/**
 * Sends a standardized workflow alert email (action button only when helpful).
 * @param {object} opts
 * @param {object} opts.req HTTP request (for base URL).
 * @param {string} opts.code workflow-error-messages catalog code.
 * @param {string} opts.invoiceId Firestore invoice id.
 * @param {string} [opts.type] outboundEmails type override.
 * @param {object} [opts.context] Template variables.
 * @return {Promise<void>}
 */
async function sendWorkflowAlert(opts) {
  const {req, code, invoiceId, type, context} = opts;
  const baseUrl = `https://${req.get("host")}`;
  const tenantId = (req.body && req.body.tenantId) || null;
  const alert = workflowErrors.buildWorkflowAlertEmail({
    code,
    context: context || {},
    baseUrl,
    invoiceId,
    tenantId,
  });
  await saveOutboundEmail({
    type: type || String(code).toLowerCase(),
    invoiceId,
    subject: alert.subject,
    html: alert.html,
  });
}

/**
 * Builds the reviewer approval email with a full summary of what the agent
 * did on this load before the customer-facing email is sent.
 * @param {object} opts Approval context from the workflow.
 * @return {string} HTML body (Jerry greeting added by saveOutboundEmail).
 */
function buildCustomerEmailApprovalHtml(opts) {
  const {
    invoice, customerName, customerRate, profit, marginPct,
    workingProNumber, amountValidation, baseAmount, approvedChargesTotal,
    finalCustomerInvoiceId, issuedInvoiceNumber, customerEmail,
    customerEmailSource, podStoragePath,
    primusSteps, approveUrl, rejectUrl, invoiceGenerationResult,
  } = opts;

  const row = (label, value) =>
    `<tr><td style="padding:6px 16px 6px 0;font-weight:600;` +
    `vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td>` +
    `<td style="padding:6px 0">${value}</td></tr>`;

  const submitted = amountValidation && amountValidation.submittedAmount;
  const primusAmt = amountValidation && amountValidation.savedAmount;
  const amtDiff = amountValidation && amountValidation.difference;
  const steps = primusSteps || {};
  const completedSteps = Object.entries(steps)
      .filter(([, v]) => v === true)
      .map(([k]) => k
          .replace(/([A-Z])/g, " $1")
          .replace(/^./, (c) => c.toUpperCase()))
      .join(", ") || "—";

  const genVia = invoiceGenerationResult && invoiceGenerationResult.reused ?
    "Reused existing Primus invoice" :
    (steps.uiInvoiceIssued ? "manage.php UI bridge" :
      (invoiceGenerationResult && invoiceGenerationResult.generated ?
        "Primus REST" : "—"));

  const attachments =
    "Customer invoice + BOL + POD (via Primus emailBOLDocs)";

  const amtMatch = amtDiff != null && Number(amtDiff) <= 0.5 ?
    `<span style="color:#16a34a">Matched</span>` :
    (amtDiff != null ?
      `<span style="color:#dc2626">${moneyFmt(amtDiff)} off</span>` : "—");

  return (
    `<h2>Approval needed before emailing the customer</h2>` +
    `<p>I finished processing this load. Please review everything below ` +
    `and confirm the outgoing package includes <strong>only the customer ` +
    `invoice and POD</strong> — never a carrier bill — before approving.</p>` +

    `<h3 style="margin:18px 0 8px;font-size:15px">Load &amp; carrier</h3>` +
    `<table style="border-collapse:collapse;font-size:14px;margin:0 0 16px">` +
    row("Load #", escapeHtml(invoice.loadNumber || "—")) +
    row("PRO #", escapeHtml(
        workingProNumber || invoice.proNumber || "—")) +
    row("Carrier", escapeHtml(invoice.carrierName || "—")) +
    row("Carrier invoice #", escapeHtml(invoice.invoiceNumber || "—")) +
    row("Carrier bill date", escapeHtml(invoice.invoiceDate || "—")) +
    row("Carrier due date", escapeHtml(invoice.dueDate || "—")) +
    row("Gmail subject", escapeHtml(invoice.gmailSubject || "—")) +
    `</table>` +

    `<h3 style="margin:18px 0 8px;font-size:15px">Amount validation</h3>` +
    `<table style="border-collapse:collapse;font-size:14px;margin:0 0 16px">` +
    row("Carrier bill amount (from email)", moneyFmt(invoice.invoiceAmount)) +
    row("Validated base amount", moneyFmt(baseAmount)) +
    row("Submitted to Primus", moneyFmt(submitted)) +
    row("Primus carrier cost", moneyFmt(primusAmt)) +
    row("Amount check", amtMatch) +
    row("Extra charges (held, not invoiced)", approvedChargesTotal > 0 ?
      moneyFmt(approvedChargesTotal) : "None") +
    `</table>` +

    `<h3 style="margin:18px 0 8px;font-size:15px">Customer invoice</h3>` +
    `<table style="border-collapse:collapse;font-size:14px;margin:0 0 16px">` +
    row("Customer", escapeHtml(customerName || "—")) +
    row("Customer rate", moneyFmt(customerRate)) +
    row("Profit", `${moneyFmt(profit)} (${Number(marginPct || 0)}% margin)`) +
    row("Issued invoice #", escapeHtml(issuedInvoiceNumber || "—")) +
    row("Primus invoice ID", escapeHtml(
        String(finalCustomerInvoiceId || "—"))) +
    row("Invoice generated via", escapeHtml(genVia)) +
    `</table>` +

    `<h3 style="margin:18px 0 8px;font-size:15px">` +
    `Outgoing customer email</h3>` +
    `<table style="border-collapse:collapse;font-size:14px;margin:0 0 16px">` +
    row("Recipient", escapeHtml(customerEmail || "—")) +
    row("Email resolved from", escapeHtml(customerEmailSource || "—")) +
    row("Send method", "Primus emailBOLDocs") +
    row("Attachments to send", escapeHtml(attachments)) +
    row("POD status", podStoragePath ?
      "Sanitized POD ready" : "No POD file on record") +
    `</table>` +

    `<h3 style="margin:18px 0 8px;font-size:15px">` +
    `Workflow steps completed</h3>` +
    `<p style="font-size:13px;color:#374151;margin:0 0 16px;line-height:1.5">` +
    escapeHtml(completedSteps) + `</p>` +

    `<p style="margin-top:20px">` +
    `<a href="${approveUrl}" style="display:inline-block;` +
    `padding:10px 20px;background:#16a34a;color:#fff;` +
    `text-decoration:none;border-radius:8px;font-weight:700;` +
    `margin-right:10px">Approve &amp; Send</a>` +
    `<a href="${rejectUrl}" style="display:inline-block;` +
    `padding:10px 20px;background:#dc2626;color:#fff;` +
    `text-decoration:none;border-radius:8px;font-weight:700">` +
    `Reject</a></p>`
  );
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
        };

        const currentStep = resumeFrom || null;

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

        const approvedChargesTotal = approvedChargeProofFiles
            .reduce((sum, c) => sum + (Number(c.amount) || 0), 0);

        await invoiceDoc.ref.update({
          approvedChargeProofFiles: approvedChargeProofFiles,
          approvedChargesTotal: approvedChargesTotal,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Drayage loads are not auto-processed — stop early before POD/AI work.
        if (invoice.loadNumber && isDrayageShipment && readShipmentMode) {
          const bookingForMode = await fetchPrimusBooking(invoice.loadNumber);
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

        const extractedPodOnlyFile =
      await maybeExtractPodOnlyPdf(invoiceId, invoice);

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

        const baseAmount = Number(invoice.invoiceAmount) - approvedChargesTotal;

        await writeLog("info", "workflow", "Validating invoice amount", {
          invoiceId,
          flowId,
          loadNumber: invoice.loadNumber,
          invoiceAmount: invoice.invoiceAmount,
          approvedChargesTotal,
          baseAmountToValidate: baseAmount,
        });

        const amountValidation = await validateAmountWithPrimus(
            invoice.loadNumber,
            baseAmount,
        );

        await logWorkflowStep({
          invoiceId,
          stepName: "amount_validation_completed",
          stepStatus: amountValidation.ok && amountValidation.validAmount ?
            "success" : "failed",
          output: {
            validAmount: amountValidation.validAmount,
            submittedAmount: amountValidation.submittedAmount,
            primusAmount: amountValidation.savedAmount,
            difference: amountValidation.difference,
          },
          error: (amountValidation.ok && amountValidation.validAmount) ?
            null : (amountValidation.reason || "Amount validation failed"),
        });

        if (amountValidation.ok && amountValidation.validAmount) {
          await writeLog("info", "workflow", "Amount validation passed", {
            invoiceId,
            loadNumber: invoice.loadNumber,
            submittedAmount: amountValidation.submittedAmount,
            primusAmount: amountValidation.savedAmount,
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
              reason: amountValidation.reason ||
                "Amount does not match Primus record",
              decision: "UNMATCHED_AMOUNT",
              invoiceAmount: invoice.invoiceAmount,
              primusAmount: primusAmountFromValidation,
              baseAmount: baseAmount,
            },
          });

          await invoiceDoc.ref.update({
            decisionStage: "unmatched_amount",
            decisionReason: "Amount validation failed",
            baseAmountValidated: baseAmount,
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

        // Extra charges (e.g. lumper) are never auto-added to the customer
        // invoice, even when their proof checks out — a human must decide
        // whether to invoice them or dispute them with the carrier.
        if (approvedChargeProofFiles.length > 0) {
          await logWorkflowStep({
            invoiceId,
            stepName: "extra_charges_held_for_review",
            stepStatus: "failed",
            reason: "Extra charges require human approval before invoicing",
            input: {approvedChargeProofFiles, approvedChargesTotal},
            error: "EXTRA_CHARGES_PENDING_REVIEW",
          });

          await invoiceDoc.ref.update({
            decisionStage: "extra_charges_pending_review",
            decisionReason:
                "Extra charges verified but held for human approval",
            processingLock: false,
            finalWorkflowStatus: "failed",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          if (invoice.gmailMessageId) {
            const gmailDoc =
              await db.collection("settings").doc("gmail").get();
            if (gmailDoc.exists) {
              const gmailSettings = gmailDoc.data();
              const tokens = gmailSettings.tokens || gmailSettings;
              const oauth2Client = getGmailOAuthClient();
              oauth2Client.setCredentials(tokens);
              const gmail =
                google.gmail({version: "v1", auth: oauth2Client});

              await forwardToHumanReview(
                  gmail,
                  invoice.gmailMessageId,
                  invoice.gmailSubject,
                  invoice.gmailFrom,
                  "Extra charges verified — approval needed before " +
                  "invoicing",
                  `The amount and proof both check out, but the extra ` +
                  `charges on this invoice are being held for manual ` +
                  `review before adding them to the customer's invoice. ` +
                  `Please confirm whether to invoice them or dispute ` +
                  `them with the carrier.`,
                  {
                    department: "billing",
                    extractedData: {
                      "Carrier": invoice.carrierName || "—",
                      "Load Number": invoice.loadNumber || "—",
                      "Extra Charges": approvedChargeProofFiles
                          .map((c) => `${c.type}: $${c.amount.toFixed(2)}`)
                          .join(", "),
                      "Total Extra Charges":
                          `$${approvedChargesTotal.toFixed(2)}`,
                    },
                  },
              );
            }
          }

          return res.json({
            ok: false,
            error: "EXTRA_CHARGES_PENDING_REVIEW",
          });
        }

        // PRO Number Handling - use Primus response proNumber
        const primusProNumber = amountValidation.proNumber || "";
        if (invoice.proNumber &&
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
          // Use Primus proNumber if available, otherwise use workingProNumber
          workingProNumber = primusProNumber || workingProNumber;
        }

        // PRO is optional for FTL; workflow proceeds on load number alone.

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
              await invoiceDoc.ref.update({
                decisionStage: "mark_delivered_failed",
                decisionReason: "Failed to mark shipment delivered",
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });

              return res.json({
                ok: false,
                error: "MARK_DELIVERED_FAILED",
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
          input: {loadNumber: invoice.loadNumber, proNumber: workingProNumber},
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
          await writeLog("warn", "workflow",
              "Could not fetch customer rate from Primus", {
                invoiceId,
                loadNumber: invoice.loadNumber,
                error: customerForCheckResult && customerForCheckResult.error,
              });
        }

        if (
          customerNameForCheck &&
      String(customerNameForCheck).toLowerCase().includes("test")
        ) {
          await logWorkflowStep({
            invoiceId,
            stepName: "customer_check_paused",
            stepStatus: "stopped",
            reason: "Test customer detected - manual review required",
            output: {customerName: customerNameForCheck},
            error: "TEST_CUSTOMER",
          });

          await pauseWorkflow(
              invoiceDoc.ref,
              "check_customer",
              "test_customer_review",
              "Test customer detected - paused",
          );

          await sendWorkflowAlert({
            req,
            code: "TEST_CUSTOMER",
            invoiceId,
            type: "customer_missing",
            context: {
              loadNumber: invoice.loadNumber,
              customerName: customerNameForCheck,
            },
          });

          return res.json({
            ok: true,
            workflowStatus: "test_customer_review",
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
          await writeLog("error", "workflow", "Carrier bill approval failed", {
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
          input: {loadNumber: invoice.loadNumber, proNumber: workingProNumber},
        });

        const customerRateResult = customerForCheckResult;

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

          return res.json({
            ok: true,
            workflowStatus: "needs_customer_rate_review",
          });
        }

        const customerName = customerRateResult.customerName;
        // A rate manually entered via setCustomerRate takes priority over
        // whatever Primus currently reports (which can be stale/doubled).
        const manualRate = Number(invoice.customerRate || 0);
        const primusRate = Number(customerRateResult.customerRate || 0);
        const customerRate = manualRate || primusRate;
        // Carrier cost: use booking.vendor.cost (the load rate) — this is the
        // source of truth. invoice.invoiceAmount can be doubled/stale.
        const bookingCarrierCost = Number(
            amountValidation.savedAmount || invoice.invoiceAmount || 0,
        );
        const profit = Number(customerRate || 0) -
          (bookingCarrierCost - approvedChargesTotal);
        const marginPctCalc = customerRate > 0 ?
          Math.round((profit / customerRate) * 100) : 0;

        await writeLog("info", "workflow", "Customer rate and profit check", {
          invoiceId,
          loadNumber: invoice.loadNumber,
          customerName,
          customerRate,
          carrierInvoiceAmount: invoice.invoiceAmount,
          approvedChargesTotal,
          profit,
          marginPct: marginPctCalc,
          willPause: !customerRate || Number(customerRate) <= 0 || profit < 10,
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

          return res.json({
            ok: true,
            workflowStatus: "needs_customer_rate_review",
          });
        }

        await writeLog("info", "workflow", "Generating customer invoice", {
          invoiceId: invoiceId,
          customerName: customerName,
          customerRate: customerRate,
        });

        await logWorkflowStep({
          invoiceId,
          stepName: "customer_invoice_generation_started",
          stepStatus: "started",
          input: {customerName, customerRate},
        });

        const customerInvoiceData = {
          loadNumber: invoice.loadNumber,
          proNumber: workingProNumber,
          customerName: customerName,
          customerRate: customerRate,
          carrierInvoiceAmount: invoice.invoiceAmount,
          podPdfStoragePath:
          (extractedPodOnlyFile && extractedPodOnlyFile.storagePath) ||
          (invoice.podOnlyFile && invoice.podOnlyFile.storagePath) ||
          null,
        };

        // Customer invoice: REST draft-only, or full UI bridge when enabled.
        let invoiceGenerationResult = null;
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
              invoiceTotal: customerRate,
            };
            primusSteps.customerInvoiceGenerated = true;
            await invoiceDoc.ref.update({
              primusSteps,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            await setWorkflowHeartbeat(
                invoiceDoc.ref, "customer_invoice_exists");
          } else {
            let uiResult;
            try {
              const bk = await fetchPrimusBooking(invoice.loadNumber);
              const attList = Array.isArray(invoice.attachments) ?
                invoice.attachments : [];
              const carrierAtt = attList.find((a) => a && a.storagePath) ||
                null;
              const podPath =
                (extractedPodOnlyFile && extractedPodOnlyFile.storagePath) ||
                (invoice.podOnlyFile && invoice.podOnlyFile.storagePath) ||
                null;
              let carrierBillPdf = null;
              let podPdf = null;
              if (carrierAtt && carrierAtt.storagePath) {
                const b64 = await downloadStorageFileBase64(
                    carrierAtt.storagePath);
                if (b64) {
                  carrierBillPdf = {
                    buffer: Buffer.from(b64, "base64"),
                    filename: carrierAtt.filename ||
                      `carrier-bill-${invoice.loadNumber}.pdf`,
                  };
                }
              }
              if (podPath) {
                const podB64 = await downloadStorageFileBase64(podPath);
                if (podB64) {
                  podPdf = {
                    buffer: Buffer.from(podB64, "base64"),
                    filename: `pod-${invoice.loadNumber}.pdf`,
                  };
                }
              }
              uiResult = await runPrimusUiBillingFlow({
                booking: bk,
                loadNumber: invoice.loadNumber,
                customerRate,
                carrierInvoiceAmount: invoice.invoiceAmount,
                proNumber: workingProNumber || invoice.proNumber,
                vendorInvoiceNumber: invoice.carrierInvoiceNumber ||
                  workingProNumber || invoice.proNumber,
                billDate: invoice.invoiceDate || invoice.receivedAt,
                billDueDate: invoice.dueDate,
                customerInvoiceId: invoice.customerInvoiceId || null,
                generated: false,
                carrierBillPdf,
                podPdf,
                skipCarrierBillUpload: primusSteps.carrierBillUploaded,
                skipPodUpload: primusSteps.podUploaded,
              });
            } catch (uiErr) {
              uiResult = {ok: false, error: uiErr.message};
            }

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
              invoiceTotal: customerRate,
              generated: !!(uiResult.issued || uiResult.generated),
              reused: !!(uiResult.skipped &&
                uiResult.reason === "already issued"),
              error: uiResult.error || null,
              step: uiResult.step || null,
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
              primusSteps.podUploadFileId = String(uiResult.podUpload.fileId);
            }
            await invoiceDoc.ref.update({
              primusSteps,
              customerInvoiceId: invoiceGenerationResult.customerInvoiceId,
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

          await setWorkflowHeartbeat(invoiceDoc.ref, "customer_invoice_exists");
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
        }

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
              }
            }
            if (!customerEmail) {
              const billTo = bookingForEmail.billTo || "";
              if (billTo === "thirdparty" && bookingForEmail.thirdParty) {
                customerEmail = bookingForEmail.thirdParty.email || null;
                customerEmailSource = "booking_third_party_email";
              }
              if (!customerEmail && bookingForEmail.shipper) {
                customerEmail = bookingForEmail.shipper.email || null;
                customerEmailSource = "booking_shipper_email";
              }
              if (!customerEmail && bookingForEmail.consignee) {
                customerEmail = bookingForEmail.consignee.email || null;
                customerEmailSource = "booking_consignee_email";
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

        // --- Reviewer approval gate before any customer-facing send ---
        // Final safeguard against a carrier bill / POD reaching the customer:
        // a designated reviewer must approve the outgoing email. Only an
        // explicit "approved" lets the send proceed. "rejected" completes the
        // workflow without emailing; anything else pauses and requests review.
        const emailApproval = invoice.customerEmailApproval || null;
        if (customerEmail && emailApproval !== "approved") {
          if (emailApproval === "rejected") {
            await logWorkflowStep({
              invoiceId,
              stepName: "final_email_sent",
              stepStatus: "skipped",
              reason: "Customer email rejected by reviewer",
              output: {to: customerEmail},
            });
            await invoiceDoc.ref.update({
              decisionStage: "customer_email_rejected",
              decisionReason:
                  "Reviewer rejected the customer email — not sent",
              customerInvoiceId: finalCustomerInvoiceId,
              issuedInvoiceNumber: issuedInvoiceNumber || null,
              finalWorkflowStatus: "completed_no_customer_email",
              processingLock: false,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            await writeLog("warn", "workflow",
                "Customer email rejected by reviewer — nothing sent", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  customerEmail,
                });
            return res.json({
              ok: true,
              workflowStatus: "customer_email_rejected",
            });
          }

          await pauseWorkflow(
              invoiceDoc.ref,
              "send_customer_email",
              "awaiting_customer_email_approval",
              "Awaiting reviewer approval before emailing the customer",
          );

          const baseUrl = `https://${req.get("host")}`;
          const tenantId = (req.body && req.body.tenantId) || null;
          const tq = tenantId ?
            `&tenantId=${encodeURIComponent(tenantId)}` : "";
          const approveUrl =
            `${baseUrl}/approveCustomerEmail?invoiceId=` +
            `${encodeURIComponent(invoiceId)}&decision=approve${tq}`;
          const rejectUrl =
            `${baseUrl}/approveCustomerEmail?invoiceId=` +
            `${encodeURIComponent(invoiceId)}&decision=reject${tq}`;
          const approverEmail =
            process.env.CUSTOMER_EMAIL_APPROVER_EMAIL ||
            process.env.ALERT_EMAIL || null;

          await saveOutboundEmail({
            type: "customer_email_approval",
            forceRecipient: true,
            to: approverEmail,
            invoiceId,
            subject: `Approve customer email — Load ${invoice.loadNumber}`,
            html: buildCustomerEmailApprovalHtml({
              invoice,
              customerName,
              customerRate,
              profit,
              marginPct: marginPctCalc,
              workingProNumber,
              amountValidation,
              baseAmount,
              approvedChargesTotal,
              finalCustomerInvoiceId,
              issuedInvoiceNumber,
              customerEmail,
              customerEmailSource,
              podStoragePath,
              primusSteps,
              approveUrl,
              rejectUrl,
              invoiceGenerationResult,
            }),
          });

          await logWorkflowStep({
            invoiceId,
            stepName: "customer_email_approval_requested",
            stepStatus: "stopped",
            reason: "Awaiting reviewer approval",
            output: {to: customerEmail, approver: approverEmail},
          });

          await writeLog("info", "workflow",
              "Customer email held for reviewer approval", {
                invoiceId,
                loadNumber: invoice.loadNumber,
                customerEmail,
                approver: approverEmail,
              });

          return res.json({
            ok: true,
            workflowStatus: "awaiting_customer_email_approval",
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
          await writeLog("info", "workflow", "Invoice approved and completed", {
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
              reason: "All validations passed and customer invoice generated",
              approvedChargesTotal: invoice.approvedChargesTotal || 0,
              baseAmountValidated: invoice.baseAmountValidated,
              approvedChargeProofFiles: invoice.approvedChargeProofFiles ?
            invoice.approvedChargeProofFiles.length : 0,
            },
          });
        }

        // Push carrier bill to QuickBooks once the invoice is confirmed.
        // The payable already exists in Primus (created when the invoice was
        // issued). We call /quickbooks/billing to sync it to QB. If the
        // dueDate is missing, we calculate Net 30 from the carrier invoice
        // date and store it for reference.
        if (finalCustomerInvoiceId) {
          try {
            const qbResult = await primusRequest(
                "POST", "/quickbooks/billing",
                {invoiceId: finalCustomerInvoiceId},
            );
            const qbBills = qbResult && qbResult.data &&
                qbResult.data.results && qbResult.data.results.bills;
            const uploaded = qbBills && qbBills.uploadedBills &&
                qbBills.uploadedBills.length || 0;
            const failed = qbBills && qbBills.failedBills &&
                qbBills.failedBills.length || 0;
            if (uploaded > 0) {
              await writeLog("info", "workflow",
                  "Carrier bill pushed to QuickBooks", {
                    invoiceId,
                    loadNumber: invoice.loadNumber,
                    customerInvoiceId: finalCustomerInvoiceId,
                    uploadedBills: uploaded,
                  });
            } else {
              await writeLog("warn", "workflow",
                  "QB billing call returned no uploaded bills " +
                  "(QB may not be connected or bill not ready)", {
                    invoiceId,
                    loadNumber: invoice.loadNumber,
                    customerInvoiceId: finalCustomerInvoiceId,
                    failedBills: failed,
                    raw: JSON.stringify(qbResult).slice(0, 300),
                  });
            }

            // Calculate and store Net 30 due date for reference
            const invDateRaw = invoice.dueDate ? null :
                (invoice.invoiceDate || invoice.receivedAt || null);
            if (!invoice.dueDate && invDateRaw) {
              const invDate = new Date(invDateRaw);
              if (!isNaN(invDate.getTime())) {
                invDate.setDate(invDate.getDate() + 30);
                const net30 = invDate.toISOString().split("T")[0];
                await invoiceDoc.ref.update({
                  carrierBillDueDate: net30,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
              }
            }
          } catch (qbErr) {
            await writeLog("warn", "workflow",
                "QB billing sync failed — bill still in Primus", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  error: qbErr.message,
                });
          }
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

        return res.json({
          ok: true,
          message: "Primus workflow completed successfully",
          customerName: customerName,
          customerRate: customerRate,
          profit: profit,
          customerInvoiceId: finalCustomerInvoiceId,
          workflowStatus: "completed",
        });
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
