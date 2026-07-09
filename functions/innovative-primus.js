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

// Injected from index.js (see init). Declared at module scope so the moved
// workflow code below can call them by their original bare names, unchanged.
let db;
let writeLog;
let logWorkflowStep;
let setWorkflowHeartbeat;
let pauseWorkflow;
let saveOutboundEmail;
let buildContinueButtonHtml;
let escapeHtml;
let maybeExtractPodOnlyPdf;
let isAlreadyDoneResult;
let downloadStorageFileBase64;
let buildCustomerInvoicePdfBase64;
let primusRequest;
let getPrimusToken;
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
    saveOutboundEmail, buildContinueButtonHtml, escapeHtml,
    maybeExtractPodOnlyPdf,
    isAlreadyDoneResult,
    downloadStorageFileBase64,
    buildCustomerInvoicePdfBase64, primusRequest, getPrimusToken,
    fetchPrimusBooking, readShipmentMode, isDrayageShipment,
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
    customerEmailSource, usePrimusEmail, podStoragePath,
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

  const attachments = usePrimusEmail ?
    "Customer invoice + BOL + POD (via Primus emailBOLDocs)" :
    `Customer invoice PDF${podStoragePath ? " + POD" : " (no POD on file)"}`;

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
    row("Send method", usePrimusEmail ?
      "Primus emailBOLDocs" : "Gmail (legacy path)") +
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

/**
 * Downloads a Primus document URL (self-authenticating); returns base64 PDF.
 * @param {string} url Document URL from GET /document/bolnumber.
 * @return {Promise<string|null>}
 */
async function downloadPrimusDocumentPdf(url) {
  if (!url) return null;
  try {
    const pdfResp = await fetch(url);
    if (!pdfResp.ok) return null;
    const buf = Buffer.from(await pdfResp.arrayBuffer());
    if (buf.slice(0, 5).toString("latin1") !== "%PDF-") return null;
    return buf.toString("base64");
  } catch (_) {
    return null;
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

            await saveOutboundEmail({
              type: "drayage_stopped",
              invoiceId,
              subject: `Stopped — drayage load ${invoice.loadNumber}`,
              html:
                `<h2>Drayage load — not processed</h2>` +
                `<p>I stopped this invoice workflow because Primus shows ` +
                `this shipment is <strong>drayage</strong>. Drayage loads ` +
                `are not handled automatically.</p>` +
                `<table style="border-collapse:collapse;font-size:14px;` +
                `margin:12px 0">` +
                `<tr><td style="padding:4px 16px 4px 0">Load #</td>` +
                `<td>${escapeHtml(invoice.loadNumber || "—")}</td></tr>` +
                `<tr><td style="padding:4px 16px 4px 0">Carrier</td>` +
                `<td>${escapeHtml(invoice.carrierName || "—")}</td></tr>` +
                `<tr><td style="padding:4px 16px 4px 0">Shipment mode</td>` +
                `<td>${escapeHtml(shipmentMode || "Drayage")}</td></tr>` +
                `<tr><td style="padding:4px 16px 4px 0">Carrier bill</td>` +
                `<td>$${Number(invoice.invoiceAmount || 0).toFixed(2)}` +
                `</td></tr>` +
                `<tr><td style="padding:4px 16px 4px 0">Gmail subject</td>` +
                `<td>${escapeHtml(invoice.gmailSubject || "—")}</td></tr>` +
                `</table>` +
                `<p>Please process this load manually in ShipPrimus.</p>`,
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

          const baseUrl = `https://${req.get("host")}`;
          const htmlContent =
        `<p>Invoice ${invoiceId} is for a test customer ` +
        `(${customerNameForCheck}).</p>` +
        `${buildContinueButtonHtml(baseUrl, invoiceId)}`;
          await saveOutboundEmail({
            type: "customer_missing",
            invoiceId,
            subject: "Customer requires confirmation",
            html: htmlContent,
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

          const baseUrl = `https://${req.get("host")}`;
          await saveOutboundEmail({
            type: "rate_missing",
            invoiceId,
            subject: `Action needed — No customer rate` +
              ` for Load ${invoice.loadNumber}`,
            html:
              `<h2>Customer Rate Missing</h2>` +
              `<p>No customer rate was found for this load. ` +
              `Click the button below to enter the rate and ` +
              `resume the workflow automatically.</p>` +
              `<table style="border-collapse:collapse;` +
              `font-size:14px;margin:12px 0">` +
              `<tr><td style="padding:4px 12px 4px 0">` +
              `<strong>Carrier</strong></td>` +
              `<td>${escapeHtml(invoice.carrierName || "—")}</td></tr>` +
              `<tr><td style="padding:4px 12px 4px 0">` +
              `<strong>Load #</strong></td>` +
              `<td>${escapeHtml(invoice.loadNumber || "—")}</td></tr>` +
              `<tr><td style="padding:4px 12px 4px 0">` +
              `<strong>Carrier Invoice</strong></td>` +
              `<td>$${invoice.invoiceAmount || "—"}</td></tr>` +
              `</table>` +
              `<a href="${baseUrl}/setCustomerRate?invoiceId=` +
              `${encodeURIComponent(invoiceId)}" ` +
              `style="display:inline-block;padding:.6rem 1.25rem;` +
              `background:#4f46e5;color:#fff;border-radius:8px;` +
              `font-weight:600;text-decoration:none;margin-top:.5rem">` +
              `Set Customer Rate</a>`,
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

          const baseUrl = `https://${req.get("host")}`;
          const isLowMargin = customerRate > 0;
          const marginPct = marginPctCalc;
          const carrierCost = bookingCarrierCost - approvedChargesTotal;
          await saveOutboundEmail({
            type: "rate_missing",
            invoiceId,
            subject: `Action needed — ` +
              `${isLowMargin ? "Low margin" : "No customer rate"}` +
              ` for Load ${invoice.loadNumber}`,
            html:
              `<h2>${isLowMargin ?
                "Low Margin Warning" :
                "Customer Rate Missing"} — Load ` +
              `${escapeHtml(invoice.loadNumber || "")}</h2>` +
              (isLowMargin ?
                `<p>Margin is too low to proceed. Here is the breakdown:</p>` +
                `<table style="border-collapse:collapse;` +
                `font-size:15px;margin:12px 0">` +
                `<tr><td style="padding:6px 16px 6px 0">` +
                `<strong>Carrier cost</strong></td>` +
                `<td style="font-weight:700">` +
                `$${Number(carrierCost).toFixed(2)}</td></tr>` +
                `<tr><td style="padding:6px 16px 6px 0">` +
                `<strong>Customer rate</strong></td>` +
                `<td style="font-weight:700">` +
                `$${Number(customerRate).toFixed(2)}</td></tr>` +
                `<tr><td style="padding:6px 16px 6px 0">` +
                `<strong>Profit</strong></td>` +
                `<td style="color:${profit < 0 ?
                  "#dc2626" : "#d97706"};font-weight:700">` +
                `$${Number(profit).toFixed(2)} (${marginPct}%)</td></tr>` +
                `<tr><td style="padding:6px 16px 6px 0">` +
                `<strong>Minimum required profit</strong></td>` +
                `<td>$10.00</td></tr>` +
                `</table>` :
                `<p>No customer rate was found for this load in Primus. ` +
                `Enter the correct rate below to resume.</p>` +
                `<table style="border-collapse:collapse;` +
                `font-size:15px;margin:12px 0">` +
                `<tr><td style="padding:6px 16px 6px 0">` +
                `<strong>Carrier cost</strong></td>` +
                `<td style="font-weight:700">` +
                `$${Number(carrierCost).toFixed(2)}</td></tr>` +
                `<tr><td style="padding:6px 16px 6px 0">` +
                `<strong>Customer rate</strong></td>` +
                `<td style="color:#dc2626;font-weight:700">Not set</td></tr>` +
                `</table>`) +
              `<table style="border-collapse:collapse;` +
              `font-size:13px;margin:8px 0;color:#555">` +
              `<tr><td style="padding:3px 12px 3px 0">Load #</td>` +
              `<td>${escapeHtml(invoice.loadNumber || "—")}</td></tr>` +
              `<tr><td style="padding:3px 12px 3px 0">Carrier</td>` +
              `<td>${escapeHtml(invoice.carrierName || "—")}</td></tr>` +
              `<tr><td style="padding:3px 12px 3px 0">Customer</td>` +
              `<td>${escapeHtml(customerName || "—")}</td></tr>` +
              `</table>` +
              `<a href="${baseUrl}/setCustomerRate?invoiceId=` +
              `${encodeURIComponent(invoiceId)}" ` +
              `style="display:inline-block;padding:.6rem 1.25rem;` +
              `background:#4f46e5;color:#fff;border-radius:8px;` +
              `font-weight:600;text-decoration:none;margin-top:.5rem">` +
              `${isLowMargin ?
                "Update Customer Rate" : "Set Customer Rate"}` +
              `</a>`,
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

              const baseUrl = `https://${req.get("host")}`;
              await saveOutboundEmail({
                type: "invoice_generation_failed",
                invoiceId,
                subject: `Action needed — Invoice issue failed on Load` +
                  ` ${invoice.loadNumber}`,
                html:
                  `<h2>ShipPrimus UI Billing Failed — Load ` +
                  `${escapeHtml(invoice.loadNumber || "")}</h2>` +
                  `<p>${escapeHtml(uiResult.error || "Unknown error")}</p>` +
                  (uiResult.step ?
                    `<p>Failed at step: <strong>` +
                    `${escapeHtml(uiResult.step)}</strong></p>` : "") +
                  `<table style="border-collapse:collapse;` +
                  `font-size:13px;margin:12px 0;color:#555">` +
                  `<tr><td style="padding:3px 12px 3px 0">Load #</td>` +
                  `<td>${escapeHtml(invoice.loadNumber || "—")}</td></tr>` +
                  `<tr><td style="padding:3px 12px 3px 0">Carrier</td>` +
                  `<td>${escapeHtml(invoice.carrierName || "—")}</td></tr>` +
                  `<tr><td style="padding:3px 12px 3px 0">Customer</td>` +
                  `<td>${escapeHtml(customerName || "—")}</td></tr>` +
                  `</table>` +
                  `<p>Fix the issue in ShipPrimus, then click Resume.</p>` +
                  `<a href="${baseUrl}/setCustomerRate?invoiceId=` +
                  `${encodeURIComponent(invoiceId)}" ` +
                  `style="display:inline-block;padding:.6rem 1.25rem;` +
                  `background:#4f46e5;color:#fff;border-radius:8px;` +
                  `font-weight:600;text-decoration:none;margin-top:.5rem">` +
                  `Resume Workflow</a>`,
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

            const baseUrl = `https://${req.get("host")}`;
            const primusTotal = invoiceGenerationResult.invoiceTotal || 0;
            const expectedRateVal =
              invoiceGenerationResult.expectedRate || customerRate;
            const diffVal = invoiceGenerationResult.difference ||
              Math.abs(primusTotal - expectedRateVal);
            const isMismatch = primusTotal > 0 && expectedRateVal > 0;
            await saveOutboundEmail({
              type: "invoice_generation_failed",
              invoiceId,
              subject: `Action needed — Rate mismatch on Load` +
                ` ${invoice.loadNumber}`,
              html:
                `<h2>Invoice Amount Mismatch — Load ` +
                `${escapeHtml(invoice.loadNumber || "")}</h2>` +
                (isMismatch ?
                  `<p>The invoice in ShipPrimus does not match the ` +
                  `expected customer rate:</p>` +
                  `<table style="border-collapse:collapse;` +
                  `font-size:15px;margin:12px 0">` +
                  `<tr><td style="padding:6px 16px 6px 0">` +
                  `<strong>Rate on the bill (Primus)</strong></td>` +
                  `<td style="color:#dc2626;font-weight:700">` +
                  `$${Number(primusTotal).toFixed(2)}</td></tr>` +
                  `<tr><td style="padding:6px 16px 6px 0">` +
                  `<strong>Expected customer rate</strong></td>` +
                  `<td style="color:#16a34a;font-weight:700">` +
                  `$${Number(expectedRateVal).toFixed(2)}</td></tr>` +
                  `<tr><td style="padding:6px 16px 6px 0">` +
                  `<strong>Difference</strong></td>` +
                  `<td style="color:#dc2626;font-weight:700">` +
                  `$${Number(diffVal).toFixed(2)}</td></tr>` +
                  `</table>` :
                  `<p>${escapeHtml(invoiceGenerationResult.error || "")}</p>`
                ) +
                `<table style="border-collapse:collapse;` +
                `font-size:13px;margin:12px 0;color:#555">` +
                `<tr><td style="padding:3px 12px 3px 0">Load #</td>` +
                `<td>${escapeHtml(invoice.loadNumber || "—")}</td></tr>` +
                `<tr><td style="padding:3px 12px 3px 0">Carrier</td>` +
                `<td>${escapeHtml(invoice.carrierName || "—")}</td></tr>` +
                `<tr><td style="padding:3px 12px 3px 0">Customer</td>` +
                `<td>${escapeHtml(customerName || "—")}</td></tr>` +
                `</table>` +
                `<p>Fix the invoice amount in ShipPrimus to ` +
                `<strong>$${Number(expectedRateVal).toFixed(2)}</strong>` +
                `, then click Resume.</p>` +
                `<a href="${baseUrl}/setCustomerRate?invoiceId=` +
                `${encodeURIComponent(invoiceId)}" ` +
                `style="display:inline-block;padding:.6rem 1.25rem;` +
                `background:#4f46e5;color:#fff;border-radius:8px;` +
                `font-weight:600;text-decoration:none;margin-top:.5rem">` +
                `Resume Workflow</a>`,
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

        // Customer email: Primus manage.php emailBOLDocs when UI bridge issued
        // the invoice (invoice + BOL + POD included). Gmail only for legacy
        // REST-only path when PRIMUS_USE_MANAGE_PHP is off.
        const primusGenerated =
            invoiceGenerationResult && invoiceGenerationResult.generated;
        const uiIssued = !!primusSteps.uiInvoiceIssued;
        const managePhpActive = isManagePhpEnabled && isManagePhpEnabled();
        const usePrimusEmail = !!(managePhpActive && uiIssued && emailBOLDocs);
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
            if (resolveCustomerAccountingEmails && isManagePhpEnabled &&
                isManagePhpEnabled()) {
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
        } catch (_) {
          // Non-fatal for legacy Gmail path
        }

        let primusInvoiceUrl = null;
        let primusPodUrl = null;
        if (!usePrimusEmail) {
          try {
            const docToken = await getPrimusToken();
            const docResp = await fetch(
                `${process.env.PRIMUS_BASE_URL}/document/bolnumber/` +
                `${invoice.loadNumber}`,
                {headers: {Authorization: `Bearer ${docToken}`}},
            );
            const docData = await docResp.json();
            const allDocs = (docData.data && docData.data.results) || [];
            const invDoc = allDocs.find((d) => d.type === "INV");
            if (invDoc && invDoc.url) {
              primusInvoiceUrl = invDoc.url;
            }
            const podDoc = allDocs.find((d) => {
              const t = String(d.type || "").toUpperCase();
              return t === "POD" || t.includes("POD");
            });
            if (podDoc && podDoc.url) {
              primusPodUrl = podDoc.url;
            }
          } catch (docErr) {
            await writeLog("warn", "primus",
                "Could not fetch Primus document list", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  error: docErr.message,
                });
          }
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
              usePrimusEmail,
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

        // Update invoice with completed workflow
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
          pdfSource: usePrimusEmail ? "primus_email" :
            (primusInvoiceUrl ? "primus" : "local"),
          podSource: usePrimusEmail ? "primus_email" :
            (primusPodUrl ? "primus" :
              (podStoragePath ? "storage" : "none")),
        });

        await logWorkflowStep({
          invoiceId,
          stepName: "final_email_started",
          stepStatus: "started",
          input: {
            via: usePrimusEmail ? "primus_emailBOLDocs" : "gmail",
            customerEmail: customerEmail || null,
            customerEmailSource: customerEmailSource || null,
          },
        });

        await setWorkflowHeartbeat(invoiceDoc.ref, "final_email_sending");

        if (usePrimusEmail) {
          if (!finalCustomerInvoiceId || !customerEmail || !bookingForEmail) {
            await logWorkflowStep({
              invoiceId,
              stepName: "final_email_sent",
              stepStatus: "failed",
              error: !customerEmail ?
                "No customer email on Primus booking" :
                "Missing invoice or booking for Primus email",
            });
            await writeLog("warn", "workflow",
                "Primus emailBOLDocs skipped — missing data", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  customerInvoiceId: finalCustomerInvoiceId,
                  customerEmail: customerEmail || null,
                });
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
              await logWorkflowStep({
                invoiceId,
                stepName: "final_email_sent",
                stepStatus: "failed",
                error: primusEmailResult.error || "emailBOLDocs failed",
              });
              await writeLog("error", "workflow",
                  "Primus emailBOLDocs failed (no Gmail fallback)", {
                    invoiceId,
                    loadNumber: invoice.loadNumber,
                    to: customerEmail,
                    attachments: primusEmailResult.attachments || null,
                    error: primusEmailResult.error,
                    raw: primusEmailResult.raw,
                  });
            }
          }
        } else {
          let customerInvoicePdfBase64 = null;
          let podPdfBase64 = null;
          const attachmentsToSend = [];
          if (primusInvoiceUrl) {
            customerInvoicePdfBase64 =
              await downloadPrimusDocumentPdf(primusInvoiceUrl);
            if (!customerInvoicePdfBase64) {
              await writeLog("warn", "primus",
                  "Primus invoice URL did not return a valid PDF", {
                    invoiceId,
                    loadNumber: invoice.loadNumber,
                    primusInvoiceUrl,
                  });
            }
          } else if (!primusGenerated && !uiIssued) {
            await writeLog("info", "primus",
                "Primus invoice not yet issued (draft); " +
                "no INV document found via document API", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  customerInvoiceId:
                      invoiceGenerationResult ?
                      (invoiceGenerationResult.customerInvoiceId || null) :
                      (invoice.customerInvoiceId || null),
                });
          }
          if (!customerInvoicePdfBase64 && !uiIssued && !primusGenerated) {
            customerInvoicePdfBase64 = await buildCustomerInvoicePdfBase64({
              invoiceId,
              loadNumber: invoice.loadNumber,
              proNumber: workingProNumber,
              customerName,
              customerRate,
              carrierInvoiceAmount: invoice.invoiceAmount,
            });
            await writeLog("info", "workflow",
                "Using locally-built customer invoice PDF", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  reason: primusInvoiceUrl ?
                    "Primus document URL did not return valid PDF" :
                    "No issued invoice document found in Primus",
                });
          } else if (customerInvoicePdfBase64) {
            await writeLog("info", "workflow",
                "Using Primus-generated customer invoice PDF", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  primusInvoiceUrl,
                });
          } else if (uiIssued || primusGenerated) {
            await writeLog("warn", "workflow",
                "Issued invoice but Primus PDF not available yet", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                });
          }

          if (customerInvoicePdfBase64) {
            attachmentsToSend.push({
              filename: `customer-invoice-${invoiceId}.pdf`,
              contentType: "application/pdf",
              contentBase64: customerInvoicePdfBase64,
            });
          }

          if (primusPodUrl) {
            podPdfBase64 = await downloadPrimusDocumentPdf(primusPodUrl);
            if (podPdfBase64) {
              attachmentsToSend.push({
                filename: `pod-${invoice.loadNumber}.pdf`,
                contentType: "application/pdf",
                contentBase64: podPdfBase64,
              });
              await writeLog("info", "workflow",
                  "Using Primus POD document for email", {
                    invoiceId,
                    loadNumber: invoice.loadNumber,
                    primusPodUrl,
                  });
            }
          }
          if (!podPdfBase64 && podStoragePath) {
            const podBase64 = await downloadStorageFileBase64(podStoragePath);
            if (podBase64) {
              podPdfBase64 = podBase64;
              attachmentsToSend.push({
                filename: `pod-${invoiceId}.pdf`,
                contentType: "application/pdf",
                contentBase64: podBase64,
              });
              await writeLog("info", "workflow",
                  "Using extracted carrier-email POD for email", {
                    invoiceId,
                    loadNumber: invoice.loadNumber,
                    podStoragePath,
                  });
            } else {
              await writeLog("warn", "workflow",
                  "POD file stored but could not be downloaded for email", {
                    invoiceId,
                    loadNumber: invoice.loadNumber,
                    podStoragePath,
                  });
            }
          }
          if (!podPdfBase64) {
            await writeLog("warn", "workflow",
                "No POD attached to customer invoice email", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  podFound: invoice.pod && invoice.pod.found,
                  podSource: invoice.pod && invoice.pod.source,
                  primusPodUrl: primusPodUrl || null,
                });
          }

          const invoiceEmailSubject =
              `Invoice — Load ${invoice.loadNumber}` +
              (workingProNumber ? ` / PRO ${workingProNumber}` : "");
          const invoiceEmailHtml =
              `<p>Dear ${escapeHtml(customerName)},</p>` +
              `<p>Please find attached your invoice for load ` +
              `<strong>${escapeHtml(invoice.loadNumber)}</strong>` +
              (workingProNumber ?
                ` (PRO: ${escapeHtml(workingProNumber)})` : "") +
              `.</p>` +
              `<p>Amount: <strong>$${Number(customerRate).toFixed(2)
              }</strong></p>` +
              `<p>Thank you for your business.</p>`;

          await saveOutboundEmail({
            type: "generated_bill",
            invoiceId,
            to: customerEmail,
            subject: invoiceEmailSubject,
            html: invoiceEmailHtml,
            attachments: attachmentsToSend,
          });

          await logWorkflowStep({
            invoiceId,
            stepName: "final_email_sent",
            stepStatus: "success",
            output: {
              via: "gmail",
              attachmentsSent: attachmentsToSend.length,
            },
          });

          await writeLog("info", "workflow", "Final email sent via Gmail", {
            invoiceId: invoiceId,
            flowId: flowId,
            currentStep: "final_email_sent",
            attachmentsSent: attachmentsToSend.length,
          });
        }


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

        // Apply ERROR label and keep email unread + release processing lock
        if (invoiceId) {
          const invoiceDoc =
            await db.collection("invoices").doc(invoiceId).get();
          if (invoiceDoc.exists) {
            const inv = invoiceDoc.data();
            await invoiceDoc.ref.update({
              processingLock: false,
              finalWorkflowStatus: "failed",
              lastHeartbeatAt: admin.firestore.FieldValue.serverTimestamp(),
              currentStep: inv.currentStep || "failed",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
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
