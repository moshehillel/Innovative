const {onRequest} = require("firebase-functions/v2/https");

const admin = require("firebase-admin");
const {google} = require("googleapis");
const {BigQuery} = require("@google-cloud/bigquery");
const Anthropic = require("@anthropic-ai/sdk");
const {PDFDocument, StandardFonts, rgb} = require("pdf-lib");
const crypto = require("crypto");

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

    const invoiceRef = db.collection("invoices").doc(String(invoiceId));
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
    const htmlContent =
      `<p>Invoice ${invoiceId} is for a test customer ` +
      `(${invoice.customerName}).</p>` +
      `${buildContinueButtonHtml(baseUrl, invoiceId)}`;
    await saveOutboundEmail({
      type: "customer_missing",
      invoiceId,
      subject: "Customer requires confirmation",
      html: htmlContent,
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

  // No terminal status found - check if idle long enough to assume done
  if (minutesSinceLastLog < 15) {
    return {
      safe: false,
      reason: `Flow still running or too recent ` +
        `(${Math.round(minutesSinceLastLog)}m ago)`,
    };
  }

  return {safe: true, reason: `Idle for ${Math.round(minutesSinceLastLog)}m`};
}

/**
 * Normalizes a load number by stripping spaces and dashes.
 * @param {string|null|undefined} loadNumber Raw load number.
 * @return {string} Normalized load number.
 */
function normalizeLoadNumber(loadNumber) {
  return String(loadNumber || "").replace(/[\s-]/g, "").trim();
}

/**
 * Validates a load number is 5–9 digits.
 * @param {string|null|undefined} loadNumber Raw load number.
 * @return {boolean} True if valid.
 */
function isValidLoadNumber(loadNumber) {
  const normalized = normalizeLoadNumber(loadNumber);
  return /^\d{5,9}$/.test(normalized);
}

/**
 * Returns the most recently created valid load number from invoices.
 * @return {Promise<number|null>} Last known load number, or null.
 */
async function getLastKnownLoadNumber() {
  try {
    const snap = await db
        .collection("invoices")
        .orderBy("createdAt", "desc")
        .limit(50)
        .get();

    for (const doc of snap.docs) {
      const inv = doc.data();
      const normalized = normalizeLoadNumber(inv.loadNumber);
      if (/^\d{5,9}$/.test(normalized)) {
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

/**
 * Summarizes a single flow using OpenAI and writes to BigQuery.
 * @param {string} flowId Flow ID.
 * @param {Array} logs Logs for the flow, sorted by timestamp.
 * @return {Promise<object>} Summary result.
 */
async function summarizeSingleFlow(flowId, logs) {
  const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});

  const lastLog = logs.length > 0 ? logs[logs.length - 1] : {};
  const messageId = lastLog.messageId || null;
  const invoiceId = lastLog.invoiceId || null;

  const prompt = {
    flowId: String(flowId),
    messageId: messageId,
    invoiceId: invoiceId,
    logs: logs.slice(-200),
  };

  const aiRes = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 2048,
    system: "You are a production workflow debugger and " +
      "incident writer. " +
      "Return ONLY valid JSON with keys: finalStatus, lastCompletedStep, " +
      "failureReason, recommendedFix, aiSummary. " +
      "The aiSummary MUST be a clear, detailed, human narrative written " +
      "in first-person past tense (e.g. 'I opened the email...'), and it " +
      "MUST include both: (1) a short narrative paragraph and (2) a " +
      "step-by-step timeline section. " +
      "In the narrative, explicitly mention: email/message context, " +
      "attachments found (count and filenames if available), " +
      "what data was " +
      "extracted (load/pro/invoice amount), " +
      "what Primus checks were attempted " +
      "and the outcome, what decision was made " +
      "(approved / needs review / " +
      "error), and why. " +
      "If information is missing in the logs, say 'not present in logs' " +
      "instead of guessing.",
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          ...prompt,
          instructions: {
            outputFormat: {
              finalStatus: "string",
              lastCompletedStep: "string|null",
              failureReason: "string|null",
              recommendedFix: "string|null",
              aiSummary: "string",
            },
            aiSummaryTemplate: {
              narrative: "1 short paragraph",
              timeline: "Bullet list of major steps with timestamps if present",
            },
          },
        }),
      },
    ],
    temperature: 0.2,
  });

  let aiJson = null;
  try {
    aiJson = JSON.parse(aiRes.content[0].text);
  } catch (e) {
    aiJson = {
      finalStatus: "unknown",
      lastCompletedStep: null,
      failureReason: "AI_RETURNED_NON_JSON",
      recommendedFix: "Check summarizeFlowLogs parsing",
      aiSummary: aiRes.content[0].text,
    };
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
        recommendedFix: aiJson.recommendedFix || null,
        aiSummary: aiJson.aiSummary || null,
      }]);

  return {
    flowId: String(flowId),
    summary: aiJson,
  };
}

exports.setupBigQuery = onRequest(async (req, res) => {
  try {
    const dataset = bigquery.dataset(BQ_DATASET);
    const [datasetExists] = await dataset.exists();
    if (!datasetExists) {
      await bigquery.createDataset(BQ_DATASET, {location: "US"});
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
      dataset: BQ_DATASET,
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

    // Find unsummarized flow IDs by left-joining logs against summaries
    let unsummarizedQuery;
    let queryOptions;
    if (flowId) {
      unsummarizedQuery = `
        SELECT DISTINCT l.flowId
        FROM \`${BQ_DATASET}.${BQ_LOGS_TABLE}\` l
        LEFT JOIN \`${BQ_DATASET}.${BQ_SUMMARIES_TABLE}\` s
          ON l.flowId = s.flowId
        WHERE l.flowId = @flowId AND s.flowId IS NULL
      `;
      queryOptions = {
        query: unsummarizedQuery,
        params: {flowId: String(flowId)},
      };
    } else {
      unsummarizedQuery = `
        SELECT DISTINCT l.flowId
        FROM \`${BQ_DATASET}.${BQ_LOGS_TABLE}\` l
        LEFT JOIN \`${BQ_DATASET}.${BQ_SUMMARIES_TABLE}\` s
          ON l.flowId = s.flowId
        WHERE s.flowId IS NULL AND l.flowId IS NOT NULL
      `;
      queryOptions = {query: unsummarizedQuery};
    }

    const [unsummarizedRows] = await bigquery.query(queryOptions);
    const unsummarizedFlowIds = unsummarizedRows.map((r) => r.flowId);

    const results = [];
    for (const fid of unsummarizedFlowIds) {
      const [logRows] = await bigquery.query({
        query: `
          SELECT * FROM \`${BQ_DATASET}.${BQ_LOGS_TABLE}\`
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

    return res.json({
      ok: true,
      totalFlows: unsummarizedFlowIds.length,
      summarized: results.filter((r) => !r.skipped).length,
      skipped: results.filter((r) => r.skipped).length,
      results,
    });
  } catch (error) {
    console.error("summarizeFlowLogs error:", error);
    return res.status(500).json({
      ok: false,
      error: "Internal server error.",
      details: error.message,
    });
  }
});

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

      await saveOutboundEmail({
        type: "stuck_flow",
        invoiceId: doc.id,
        subject: `Workflow stuck — Load ${loadNum} (${carrier})`,
        html:
          `<h2>Workflow Stuck</h2>` +
          `<table style="border-collapse:collapse;font-size:14px">` +
          `<tr><td style="padding:4px 12px 4px 0">` +
          `<strong>Carrier</strong></td>` +
          `<td>${escapeHtml(carrier)}</td></tr>` +
          `<tr><td style="padding:4px 12px 4px 0">` +
          `<strong>Load #</strong></td>` +
          `<td>${escapeHtml(loadNum)}</td></tr>` +
          `<tr><td style="padding:4px 12px 4px 0">` +
          `<strong>Invoice Amount</strong></td>` +
          `<td>${escapeHtml(amount)}</td></tr>` +
          `<tr><td style="padding:4px 12px 4px 0">` +
          `<strong>Stuck at</strong></td>` +
          `<td>${escapeHtml(lastStep)} (${stuckMins} min ago)</td></tr>` +
          `</table>` +
          summaryText + fixText +
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

    return res.json({ok: true, checked: lockedSnap.size, stuck: results});
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

    const invoiceRef = db.collection("invoices").doc(String(invoiceId));
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

    const baseUrl = `https://${req.get("host")}`;
    const rateStatus = missingRate ? "no customer rate" : "low margin";
    const htmlContent =
      `<p>Invoice ${invoiceId} has ${rateStatus}.</p>` +
      `${buildContinueButtonHtml(baseUrl, invoiceId)}`;
    await saveOutboundEmail({
      type: "rate_missing",
      invoiceId,
      subject: "Customer rate needs attention",
      html: htmlContent,
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

    const invoiceRef = db.collection("invoices").doc(String(invoiceId));
    const snap = await invoiceRef.get();

    if (!snap.exists) {
      return res.status(404).json({
        ok: false,
        error: "Invoice not found.",
      });
    }

    const invoice = snap.data();
    const paused = invoice.workflowPausedAtStep;

    await invoiceRef.update({
      workflowPausedAtStep: null,
      workflowPausedAt: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const response = await fetch(
        process.env.PROCESS_PRIMUS_WORKFLOW_URL ||
        "https://us-central1-tai-invoice-automation.cloudfunctions.net/processPrimusWorkflow",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            invoiceId: invoiceId,
            resumeFrom: paused || null,
          }),
        },
    );

    const payload = await response.json().catch(() => ({}));

    return res.json({
      ok: true,
      resumedFrom: paused || null,
      workflow: payload,
    });
  } catch (error) {
    console.error("continueWorkflow error:", error);
    return res.status(500).json({
      ok: false,
      error: "Internal server error.",
      details: error.message,
    });
  }
});

exports.sendGeneratedBillEmail = onRequest(async (req, res) => {
  try {
    const invoiceId = (req.body && req.body.invoiceId) || req.query.invoiceId;

    if (!invoiceId) {
      return res.status(400).json({
        ok: false,
        error: "invoiceId is required.",
      });
    }

    const invoiceRef = db.collection("invoices").doc(String(invoiceId));
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
 * @param {string} category Log category (gmail, primus, ai, storage, general).
 * @param {string} message Log message.
 * @param {object} details Additional details object.
 * @param {string} messageId Gmail message ID if applicable.
 * @return {Promise<void>}
 */
async function writeLog(
    level,
    category,
    message,
    details = {},
    messageId = null,
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

    bigquery
        .dataset(BQ_DATASET)
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

    const docRef = await db.collection("invoices").add({
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

    const invoiceRef = db.collection("invoices").doc(invoiceId);
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

    let decisionStage = "ready_to_approve";
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
  return new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI,
  );
}

/**
 * Returns true if an attachment should be processed (PDF, not too small).
 * @param {object} attachment - Attachment metadata.
 * @param {Buffer} fileBuffer - File bytes.
 * @return {boolean}
 */
function shouldProcessAttachment(attachment, fileBuffer) {
  const isPdf = attachment.mimeType === "application/pdf" ||
    // Some email clients send PDFs as octet-stream; detect by magic bytes %PDF
    (attachment.mimeType === "application/octet-stream" &&
      fileBuffer.length >= 4 &&
      fileBuffer[0] === 0x25 && fileBuffer[1] === 0x50 &&
      fileBuffer[2] === 0x44 && fileBuffer[3] === 0x46);
  if (!isPdf) return false;
  if (fileBuffer.length < 10000) return false;
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
 * Returns INVOICE, STATEMENT, INSURANCE, or OTHER.
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
            "INVOICE, STATEMENT, INSURANCE, or OTHER",
        },
      ],
    }],
  });

  if (!response.content || response.content.length === 0) return "OTHER";
  const block = response.content[0];
  if (!block || block.type !== "text" || !block.text) return "OTHER";
  const word = block.text.trim().toUpperCase().split(/\s+/)[0];
  return ["INVOICE", "STATEMENT", "INSURANCE"].includes(word) ? word : "OTHER";
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

  const lines = [
    `To: ${to}\r\n`,
    `Subject: ${subject}\r\n`,
    `MIME-Version: 1.0\r\n`,
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n`,
    `\r\n`,
    `--${boundary}\r\n`,
    `Content-Type: text/html; charset="UTF-8"\r\n`,
    `Content-Transfer-Encoding: 7bit\r\n`,
    `\r\n`,
    `${html}\r\n`,
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
    (department === "billing" && process.env.REVIEW_EMAIL_BILLING) ||
    (department === "operations" && process.env.REVIEW_EMAIL_OPERATIONS) ||
    process.env.HUMAN_REVIEW_EMAIL;

  if (!departmentEmail) {
    const missingVar = department === "billing" ? "REVIEW_EMAIL_BILLING" :
      department === "operations" ? "REVIEW_EMAIL_OPERATIONS" :
      "HUMAN_REVIEW_EMAIL";
    console.error(
        `[forwardToHumanReview] ${missingVar} env var not set — ` +
        `forward dropped for message ${messageId} (reason: ${reason})`,
    );
    await writeLog("error", "gmail",
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
    await writeLog("warn", "gmail",
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
    mimeBuffer = Buffer.from(
        `To: ${departmentEmail}\r\n` +
        `Subject: ${forwardSubject}\r\n` +
        `Content-Type: text/html; charset="UTF-8"\r\n\r\n${html}`,
    );
  }

  const raw = mimeBuffer.toString("base64url");

  await gmail.users.messages.send({userId: "me", requestBody: {raw}});
  await writeLog("info", "gmail", "Forwarded to human review", {
    messageId,
    reason,
    reviewEmail: departmentEmail,
    department,
    originalAttached: Boolean(originalRawBuffer),
  });
}

/**
 * Sends an email via the connected Gmail account using stored OAuth tokens.
 * @param {string} to Recipient email address.
 * @param {string} subject Email subject.
 * @param {string} html HTML body.
 * @param {Array<object>} attachments PDF attachments array.
 * @return {Promise<void>}
 */
async function sendViaGmail(to, subject, html, attachments = []) {
  const gmailDoc = await db.collection("settings").doc("gmail").get();
  if (!gmailDoc.exists) throw new Error("Gmail not connected");
  const tokens = gmailDoc.data().tokens || gmailDoc.data();
  const oauth2Client = getGmailOAuthClient();
  oauth2Client.setCredentials(tokens);
  const gmail = google.gmail({version: "v1", auth: oauth2Client});

  const boundary = `msg_${crypto.randomBytes(16).toString("hex")}`;
  const safeTo = String(to || "").replace(/[\r\n]/g, "");
  const safeSubject = String(subject || "").replace(/[\r\n]/g, " ");

  const lines = [
    `To: ${safeTo}\r\n`,
    `Subject: ${safeSubject}\r\n`,
    `MIME-Version: 1.0\r\n`,
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n`,
    `\r\n`,
    `--${boundary}\r\n`,
    `Content-Type: text/html; charset="UTF-8"\r\n`,
    `Content-Transfer-Encoding: 7bit\r\n`,
    `\r\n`,
    `${html}\r\n`,
  ];

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
  await gmail.users.messages.send({userId: "me", requestBody: {raw}});
}

/**
 * Validates invoice amount by subtracting lumper charges before
 * comparing to rate.
 * @param {object} aiResult - AI classification result.
 * @param {number} primusRate - Rate from Primus.
 * @return {object} Validation result (valid, baseAmount, totalLumper,
 *   difference).
 */
function validateLumperAmount(aiResult, primusRate) {
  const lumperCharges = (aiResult.recognizedCharges || [])
      .filter((c) => c && c.type === "lumper");
  const totalLumper = lumperCharges.reduce(
      (sum, c) => sum + (Number(c.amount) || 0), 0);
  const baseAmount = Number(aiResult.invoiceAmount || 0) - totalLumper;
  const difference = Math.abs(baseAmount - Number(primusRate || 0));
  return {valid: difference <= 5, baseAmount, totalLumper, difference};
}

/**
 * Checks profit and margin thresholds against business rules.
 * profit < $10 = no rate scenario; margin < 10% = broker commission
 * adjustment needed.
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
 * Retrieves shipment data from Primus by load/BOL or PRO number.
 * @param {string} loadNumber - Load/BOL number.
 * @param {string} proNumber - PRO number (fallback search key).
 * @return {Promise<object>} Shipment lookup result.
 */
async function getPrimusShipment(loadNumber, proNumber) {
  try {
    let booking = await fetchPrimusBooking(loadNumber);
    if (!booking && proNumber) {
      const searchData = await primusRequest(
          "GET", `/book?vendorPro=${encodeURIComponent(proNumber)}&limit=1`);
      const results = searchData && searchData.data && searchData.data.results;
      booking = Array.isArray(results) ? (results[0] || null) : null;
    }
    if (!booking) return {found: false, rate: null, customerEmail: null};
    const acct = booking.accountingInformation || {};
    const {rate} = readCustomerRateFromAcct(acct);
    let customerEmail = null;
    if (booking.thirdParty && booking.thirdParty.email) {
      customerEmail = booking.thirdParty.email;
    } else if (booking.shipper && booking.shipper.email) {
      customerEmail = booking.shipper.email;
    }
    return {found: true, rate, customerEmail, BOLId: booking.BOLId};
  } catch (error) {
    await writeLog("error", "primus", "getPrimusShipment failed", {
      loadNumber,
      proNumber,
      error: error.message,
    });
    return {found: false, rate: null, customerEmail: null};
  }
}

/**
 * Adjusts broker commission in Primus for low-margin loads.
 * @param {string} loadNumber - Load number.
 * @param {number} margin - Current margin percentage.
 * @return {Promise<void>}
 */
async function adjustBrokerCommission(loadNumber, margin) {
  // TODO: Implement Primus broker commission adjustment
  await writeLog("info", "primus",
      "TODO: adjustBrokerCommission stub called", {loadNumber, margin});
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

  contentBlocks.push({
    type: "text",
    text: JSON.stringify({
      task: "Extract invoice data and classify from the attached PDF " +
          "document(s).",
      lastKnownLoadNumber: Number.isFinite(Number(lastKnownLoadNumber)) ?
        Number(lastKnownLoadNumber) : null,
      allowedStatuses: [
        "ready_for_primus_validation",
        "unmatched_amount",
        "unrecognized_charges",
        "charges_no_proof",
        "error",
      ],
      rules: [
        "Find the actual carrier invoice.",
        "Load number may appear as Load #, Reference #, " +
        "Reference Number, Customer Ref, Broker Ref, or Bill of Lading Number.",
        "Load number may also appear as SHIPPER B/L NUMBER, " +
        "Invoice Number, B/L, Broker Ref, BOL Number.",
        "If you cannot find loadNumber using labeled fields, scan for any " +
        "5–9 digit number (ignoring spaces and dashes).",
        "If lastKnownLoadNumber is provided, prefer a 5–9 digit candidate " +
        "where abs(candidate - lastKnownLoadNumber) <= 100000.",
        "If no valid 5–9 digit candidate is found, return loadNumber as " +
        "empty string.",
        "PRO number may appear as PRO #, Carrier PRO, " +
        "Beyond PRO, Advance PRO, or freight bill number.",
        "Keep load number and PRO number separate.",
        "Do not use the PRO number as the load number.",
        "Find invoice total and due date.",
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
        "If attachment is not a freight invoice, status is error.",
        "Detect Proof of Delivery (POD) documents.",
        "POD may be a separate attachment, on the last page of the invoice, " +
        "or in the bottom section of the same page as the invoice.",
        "Look for signed Bill of Lading, delivery receipt, or POD " +
        "confirmation.",
        "POD should have signatures, delivery dates, or Received stamps.",
        "If POD content (signature, stamp, Received mark, or delivery " +
        "confirmation) appears in the bottom section of an invoice page " +
        "rather than on its own page, set pod.source to " +
        "'same_page_as_invoice', pod.attachmentFilename to that file, " +
        "pod.page to the 1-based page number, and pod.cropFromBottom to " +
        "the estimated fraction of the page height from the bottom that " +
        "contains the POD content (e.g. 0.35 means the bottom 35%). " +
        "Only use when the POD is clearly in the bottom portion of an " +
        "invoice page.",
      ],
      requiredJsonShape: {
        status: "ready_for_primus_validation",
        invoiceNumber: "",
        loadNumber: "",
        proNumber: "",
        invoiceAmount: 0,
        dueDate: "",
        carrierName: "",
        charges: [],
        recognizedCharges: [
          {type: "lumper", amount: 0},
          {type: "detention", amount: 0},
        ],
        unrecognizedCharges: [{type: "", amount: 0, label: ""}],
        chargesNeedProof: [{type: "lumper", amount: 0, reason: ""}],
        chargeProofRefs: [{type: "lumper", amount: 0, attachmentFilename: ""}],
        pod: {
          found: false,
          source: "",
          attachmentFilename: "",
          page: "",
          cropFromBottom: 0,
          reason: "",
        },
        reason: "",
      },
    }),
  });

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: "You classify freight carrier invoice attachments. " +
      "Return ONLY valid JSON. No markdown. " +
      "You must strictly match requiredJsonShape keys and types. " +
      "You can see the full PDF layout — use visual context to correctly " +
      "associate labels with their values even when they appear in columns.",
    messages: [{role: "user", content: contentBlocks}],
  });

  if (!response.content || response.content.length === 0) {
    throw new Error(
        "Claude returned an empty response for invoice classification");
  }
  const rawText = response.content[0].text;
  const jsonText = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    throw new Error(
        `Claude returned non-JSON response: ${rawText.slice(0, 200)}`,
    );
  }
}

/**
 * Saves an outbound email to Firestore and optionally sends it.
 * @param {object} email - The email object.
 * @return {Promise<object>} Result of the operation.
 */
async function saveOutboundEmail(email) {
  let sendResult = null;
  const to = process.env.ALERT_EMAIL || email.to || "";

  if (to) {
    try {
      await sendViaGmail(
          to,
          email.subject || "",
          email.html || "",
          Array.isArray(email.attachments) ? email.attachments : [],
      );
      sendResult = {ok: true};
    } catch (sendErr) {
      sendResult = {ok: false, error: sendErr.message};
      console.error("saveOutboundEmail send error:", sendErr.message);
    }
  } else {
    console.warn("saveOutboundEmail: no recipient, email not sent", {
      type: email.type,
      invoiceId: email.invoiceId,
    });
  }

  await db.collection("outboundEmails").add({
    ...email,
    sendResult: sendResult,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    deleteAt: getDeleteAt(7),
  });

  await writeLog("info", "email", "Outbound email sent", {
    type: email.type,
    invoiceId: email.invoiceId,
    to: to,
    intendedTo: email.to || null,
    sent: Boolean(sendResult && sendResult.ok),
  });
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
 * @return {string} HTML string.
 */
function buildContinueButtonHtml(baseUrl, invoiceId) {
  const continueUrl =
    `${baseUrl}/continueWorkflow?invoiceId=${encodeURIComponent(invoiceId)}`;
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
 * Extracts POD-only PDF from invoice attachments.
 * @param {string} invoiceId - The invoice ID.
 * @param {object} invoice - The invoice document.
 * @return {Promise<object|null>} POD file info or null.
 */
async function maybeExtractPodOnlyPdf(invoiceId, invoice) {
  try {
    if (!invoice || !invoice.pod || invoice.pod.found !== true) {
      await writeLog("info", "workflow",
          "POD not detected in this invoice — no extraction attempted", {
            invoiceId,
            loadNumber: invoice && invoice.loadNumber,
            podFound: invoice && invoice.pod && invoice.pod.found,
            podSource: invoice && invoice.pod && invoice.pod.source,
            podReason: invoice && invoice.pod && invoice.pod.reason,
          });
      return null;
    }

    const attachments = Array.isArray(invoice.attachments) ?
      invoice.attachments : [];
    const podAtt = attachments.find(
        (a) => a && a.filename === invoice.pod.attachmentFilename,
    );

    if (!podAtt || !podAtt.storagePath) {
      await writeLog("warn", "workflow",
          "POD was detected by AI but attachment file not found in storage", {
            invoiceId,
            loadNumber: invoice.loadNumber,
            expectedFilename: invoice.pod.attachmentFilename,
            availableFilenames: attachments.map((a) => a && a.filename),
          });
      return null;
    }

    if (invoice.pod.source === "separate_attachment") {
      return {
        storagePath: podAtt.storagePath,
        source: "separate_attachment",
      };
    }

    if (invoice.pod.source === "attachment") {
      // POD is embedded in invoice PDF at specific page
      const [fileBuffer] = await getBucket()
          .file(podAtt.storagePath).download();
      const doc = await PDFDocument.load(fileBuffer);
      const pageCount = doc.getPageCount();

      const podPage = Number(invoice.pod.page) || pageCount;
      if (podPage < 1 || podPage > pageCount) {
        return null;
      }

      const newDoc = await PDFDocument.create();
      const [page] = await newDoc.copyPages(doc, [podPage - 1]);
      newDoc.addPage(page);

      const pdfBytes = await newDoc.save();
      const storagePath = `podOnly/${invoiceId}/pod.pdf`;

      await getBucket().file(storagePath).save(Buffer.from(pdfBytes), {
        metadata: {
          contentType: "application/pdf",
        },
      });

      return {
        storagePath,
        source: "attachment",
      };
    }

    if (invoice.pod.source === "same_page_as_invoice") {
      const cropFromBottom = Math.min(
          Math.max(Number(invoice.pod.cropFromBottom || 0.5), 0.1),
          0.9,
      );
      const pageNum = Number(invoice.pod.page) || 1;

      const [fileBuffer] = await getBucket()
          .file(podAtt.storagePath).download();
      const doc = await PDFDocument.load(fileBuffer);
      const pageCount = doc.getPageCount();

      const pageIndex = Math.max(0, Math.min(pageNum - 1, pageCount - 1));

      const newDoc = await PDFDocument.create();
      const [copiedPage] = await newDoc.copyPages(doc, [pageIndex]);
      newDoc.addPage(copiedPage);

      const {width, height} = copiedPage.getSize();
      copiedPage.setCropBox(0, 0, width, height * cropFromBottom);

      const pdfBytes = await newDoc.save();
      const storagePath = `podOnly/${invoiceId}/pod.pdf`;

      await getBucket().file(storagePath).save(Buffer.from(pdfBytes), {
        metadata: {contentType: "application/pdf"},
      });

      return {storagePath, source: "same_page_as_invoice"};
    }

    if (invoice.pod.source !== "last_page_of_invoice") {
      return null;
    }

    const [fileBuffer] = await getBucket().file(podAtt.storagePath).download();
    const doc = await PDFDocument.load(fileBuffer);
    const pageCount = doc.getPageCount();

    if (pageCount < 1) {
      return null;
    }

    const newDoc = await PDFDocument.create();
    const [lastPage] = await newDoc.copyPages(doc, [pageCount - 1]);
    newDoc.addPage(lastPage);

    const pdfBytes = await newDoc.save();
    const storagePath = `podOnly/${invoiceId}/pod.pdf`;

    await getBucket().file(storagePath).save(Buffer.from(pdfBytes), {
      metadata: {
        contentType: "application/pdf",
      },
    });

    return {
      storagePath,
      source: "last_page_of_invoice",
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
  } = data || {};

  await db.collection("workflowLogs").add({
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
  const recognizedCharges = Array.isArray(aiResult.recognizedCharges) ?
    aiResult.recognizedCharges : [];
  const unrecognizedCharges =
    Array.isArray(aiResult.unrecognizedCharges) ?
      aiResult.unrecognizedCharges : [];
  const chargesNeedProof = Array.isArray(aiResult.chargesNeedProof) ?
    aiResult.chargesNeedProof : [];
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
 * Checks whether a Gmail message has already been processed.
 * @param {string} messageId - The Gmail message ID.
 * @return {Promise<boolean>} True if already processed.
 */
/**
 * Checks whether a Gmail message has already been ingested.
 * @param {string} messageId - Gmail message ID.
 * @return {Promise<boolean>} True if the message was previously processed.
 */
async function hasEmailBeenProcessed(messageId) {
  const intakeSnap = await db.collection("emailIntake")
      .where("gmailMessageId", "==", messageId)
      .limit(1)
      .get();
  if (intakeSnap.size > 0) return true;

  const invoiceSnap = await db.collection("invoices")
      .where("gmailMessageId", "==", messageId)
      .limit(1)
      .get();
  if (invoiceSnap.size > 0) return true;

  // Also check the queue — covers NO_INVOICE_PDF and other early-exit paths
  // that never create an emailIntake record but did reserve a queue slot.
  const queueSnap = await db.collection("gmailQueue").doc(messageId).get();
  if (queueSnap.exists) {
    const queueStatus = (queueSnap.data() || {}).status;
    if (queueStatus && queueStatus !== "queued" && queueStatus !== "failed") {
      return true;
    }
  }

  return false;
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
    const queueRef = db.collection("gmailQueue").doc(messageId);
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
    await writeLog("warn", "gmail", "Failed to update Gmail queue status", {
      messageId,
      status,
      error: error.message,
    });
  }
}

/**
 * Claims a Gmail queue item using a Firestore transaction.
 * @param {string} messageId - Gmail message ID.
 * @return {Promise<boolean>} True when the queue item was claimed.
 */
async function claimGmailQueueItem(messageId) {
  const queueRef = db.collection("gmailQueue").doc(messageId);

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
    await writeLog("warn", "gmail", "Failed to claim Gmail queue item", {
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
 * @return {Promise<boolean>} True when the queue item was reserved.
 */
async function reserveGmailQueueItemForProcessing(
    messageId,
    subject,
    from,
    inboxFlowId,
) {
  const queueRef = db.collection("gmailQueue").doc(messageId);
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
    await writeLog("warn", "gmail", "Failed to reserve Gmail queue item", {
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
 * Uses Claude Haiku to produce a one-line summary of an incoming email.
 * @param {string} subject Email subject.
 * @param {string} from Email sender.
 * @param {string} body Email plain-text body.
 * @return {Promise<{summary: string}>}
 */
async function analyzeEmailForForwarding(subject, from, body) {
  const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});

  const res = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 200,
    system:
      "You are an assistant for a freight brokerage handling incoming " +
      "emails. " +
      "Analyze the email and return ONLY valid JSON with one key: " +
      "\"summary\" (one or two sentences describing what the sender wants or " +
      "what this email appears to be about).",
    messages: [{
      role: "user",
      content: JSON.stringify({
        subject,
        from,
        body: String(body || "").slice(0, 3000),
      }),
    }],
  });

  if (!res.content || res.content.length === 0) {
    return {summary: "Could not analyze email."};
  }
  const rawText = res.content[0].text || "";
  const jsonText = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    return {summary: rawText || "Could not analyze email."};
  }
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
  let subject = String(options.subject || "");
  let from = String(options.from || "");

  try {
    const fullMessage = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
    });

    const payload = fullMessage.data.payload || {};
    const headers = payload.headers || [];
    const subjectHeader = headers.find((h) => h.name === "Subject");
    const fromHeader = headers.find((h) => h.name === "From");

    if (!subject) {
      subject = subjectHeader ? subjectHeader.value : "";
    }
    if (!from) {
      from = fromHeader ? fromHeader.value : "";
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
        await writeLog("warn", "gmail",
            "Email analysis failed before forward", {
              messageId, error: e.message,
            });
      }

      const aiNote =
        `Hi,\n\n` +
        `I am your AI helper. I just received the following email and I am ` +
        `not sure how to handle it.\n\n` +
        (summary ?
          `Here is what I think this email is about: ${summary}\n\n` : "") +
        `I do not have a rule for this type of email yet. ` +
        `Please take care of it.\n\nThank you,\nAI Helper`;

      return forwardToHumanReview(
          gmail, messageId, subject, from, reason, aiNote,
          {...fwdOpts, emailBody},
      );
    };

    await writeLog("info", "gmail", `Message details retrieved`, {
      messageId: messageId,
      subject: subject,
      from: from,
    });

    const alreadyProcessed = await hasEmailBeenProcessed(messageId);
    if (alreadyProcessed) {
      await writeLog("warn", "gmail", "Message already processed, skipping", {
        messageId: messageId,
        subject: subject,
        from: from,
      });
      await updateGmailQueueStatus(messageId, "completed");
      return;
    }

    const attachments = extractAttachmentsRecursive(payload.parts || []);

    if (!options.fromQueue) {
      const reserved = await reserveGmailQueueItemForProcessing(
          messageId,
          subject,
          from,
          inboxFlowId,
      );
      if (!reserved) {
        await writeLog("warn", "gmail", "Skipped duplicate inbox processing", {
          messageId: messageId,
          subject: subject,
          from: from,
        });
        return;
      }
    }

    if (attachments.length === 0) {
      await writeLog("warn", "gmail",
          "No attachments found, forwarding for review", {
            messageId, subject,
          });
      await forwardWithAnalysis(
          "Email received with no attachments",
          {department: "general"},
      );
      await updateGmailQueueStatus(messageId, "completed");
      await db.collection("emailIntake").doc(messageId).set({
        gmailMessageId: messageId,
        subject, from,
        finalStatus: "no_attachment",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        deleteAt: getDeleteAt(30),
      }, {merge: true});
      return;
    }

    if (!options.fromQueue) {
      await updateGmailQueueStatus(messageId, "processing", null, {
        skipAttemptIncrement: true,
      });
    }

    await writeLog(
        "info",
        "gmail",
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
    const pdfAttachments = [];
    const storedAttachments = [];
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
          });

      const attachmentResponse = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: messageId,
        id: attachment.attachmentId,
      });

      const rawData = attachmentResponse.data.data || "";
      const fileBuffer = Buffer.from(
          rawData.replace(/-/g, "+").replace(/_/g, "/"),
          "base64",
      );

      // Skip non-PDFs and tiny files (signatures, logos, etc.)
      if (!shouldProcessAttachment(attachment, fileBuffer)) {
        await writeLog("info", "gmail", `Skipping non-invoice attachment`, {
          messageId,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          fileSize: fileBuffer.length,
        });
        const isPdfMime = attachment.mimeType === "application/pdf" ||
          (attachment.mimeType === "application/octet-stream" &&
            fileBuffer.length >= 4 &&
            fileBuffer[0] === 0x25 && fileBuffer[1] === 0x50 &&
            fileBuffer[2] === 0x44 && fileBuffer[3] === 0x46);
        if (isPdfMime && fileBuffer.length < 10000) {
          // Small PDF — likely a real document but too short to be an invoice
          skippedDocTypes.push("small PDF");
        } else if (!isPdfMime && fileBuffer.length >= 10000) {
          // Substantive non-PDF (Excel, Word, image, etc.)
          const ext = String(attachment.filename || "")
              .split(".").pop().toUpperCase();
          skippedDocTypes.push(ext || attachment.mimeType || "non-PDF file");
        }
        continue;
      }

      // Cheap first-page pre-check: is this an invoice or something else?
      let docType = "INVOICE";
      try {
        docType = await preCheckDocumentType(fileBuffer);
      } catch (preCheckErr) {
        await writeLog("warn", "ai", "Pre-check failed, assuming INVOICE", {
          messageId, filename: attachment.filename, error: preCheckErr.message,
        });
      }

      if (docType !== "INVOICE") {
        await writeLog("info", "gmail", `Attachment is ${docType}, skipping`, {
          messageId, filename: attachment.filename, docType,
        });
        skippedDocTypes.push(docType);
        continue;
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
      });

      pdfAttachments.push({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        buffer: fileBuffer,
        storagePath,
      });

      storedAttachments.push({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        storagePath,
      });
    }

    // If no processable PDFs found, forward entire email for human review
    if (pdfAttachments.length === 0) {
      await writeLog("warn", "gmail", "No processable PDF invoices found",
          {messageId, subject});
      let noInvoiceReason =
          "Could not find a freight invoice in this email";
      if (skippedDocTypes.length > 0) {
        const typeList = [...new Set(skippedDocTypes)].join(", ");
        noInvoiceReason =
            `Email contained ${typeList} attachment(s) but no invoice`;
      }
      await forwardWithAnalysis(noInvoiceReason, {department: "general"});
      await updateGmailQueueStatus(messageId, "completed");
      await db.collection("emailIntake").doc(messageId).set({
        gmailMessageId: messageId,
        subject, from,
        finalStatus: "no_invoice_pdf",
        skippedAttachmentTypes: skippedDocTypes,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        deleteAt: getDeleteAt(30),
      }, {merge: true});
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

    let aiResult;
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
          loadNumber: aiResult.loadNumber,
          proNumber: aiResult.proNumber,
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

    const normalizedChargeData = normalizeAiChargeArrays(aiResult);

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
        pod: aiResult.pod,
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

    let finalStatus = "error";
    let primusResult = null;

    const normalizedLoadNumber =
      normalizeLoadNumber(aiResult.loadNumber);
    const normalizedProNumber = normalizeLoadNumber(aiResult.proNumber);
    const isLoadNumberValid = isValidLoadNumber(normalizedLoadNumber) &&
      (!normalizedProNumber ||
      normalizedLoadNumber !== normalizedProNumber);
    const loadNumberInt = Number(normalizedLoadNumber);

    const sameDigitLength = lastKnownLoadNumber === null ? true :
      String(loadNumberInt).length === String(lastKnownLoadNumber).length;
    const withinRange = lastKnownLoadNumber === null ? true :
      (!sameDigitLength || (Number.isFinite(loadNumberInt) &&
      Math.abs(loadNumberInt - lastKnownLoadNumber) <= 100000));

    const loadGateFailed = !isLoadNumberValid || !withinRange;
    if (loadGateFailed) {
      finalStatus = "no_load_number";

      await forwardToHumanReview(
          gmail, messageId, subject, from,
          "Could not find a valid load number on this invoice",
          `I processed the invoice from ` +
          `${aiResult.carrierName || "this carrier"} but could not find ` +
          `a valid load number. Without a load number I cannot ` +
          `match this invoice to a shipment in Primus. Please verify the ` +
          `load number with the carrier and reprocess, or handle this ` +
          `invoice manually.`,
          {
            department: "operations",
            extractedData: {
              "Carrier": aiResult.carrierName || "—",
              "Invoice Amount": aiResult.invoiceAmount ?
                `$${aiResult.invoiceAmount}` : "—",
              "PRO Number Found": aiResult.proNumber || "none",
              "Raw Load # Found": aiResult.loadNumber || "none",
            },
          },
      );

      await writeLog("error", "gmail", "Load number missing/invalid", {
        event: "Load number validation failed",
        messageId: message.id,
        details: {
          loadNumberRaw: aiResult.loadNumber || null,
          loadNumberNormalized: normalizedLoadNumber || null,
          proNumber: aiResult.proNumber || null,
          proNumberNormalized: normalizedProNumber || null,
          expectedFormat: "^\\d{9}$",
          lastKnownLoadNumber: lastKnownLoadNumber,
          within100k: withinRange,
          decision: "NO_LOAD_NUMBER",
          reason: !isLoadNumberValid ?
            "Load number must be exactly 9 digits " +
            "(spaces/dashes ignored) " +
            "and not equal to PRO" :
            "Load number is not within 100,000 of last known " +
            "load number",
        },
      });
    } else {
      aiResult.loadNumber = normalizedLoadNumber;
    }

    const hasUnrecognizedCharges =
      normalizedChargeData.unrecognizedCharges.length > 0;
    const hasChargesNeedProof =
      normalizedChargeData.chargesNeedProof.length > 0;

    if (loadGateFailed) {
      // Stop execution: do not attempt Primus lookup or workflow.
    } else if (aiResult.status === "unrecognized_charges" ||
    hasUnrecognizedCharges) {
      finalStatus = "unrecognized_charges";
      await forwardToHumanReview(
          gmail, messageId, subject, from,
          "Invoice has charges I am not authorized to approve",
          `I received an invoice from ` +
          `${aiResult.carrierName || "this carrier"} for load ` +
          `${aiResult.loadNumber}. The invoice total is ` +
          `$${aiResult.invoiceAmount}, however it contains charges I do ` +
          `not recognize and cannot approve automatically: ` +
          normalizedChargeData.unrecognizedCharges
              .map((c) => `${c.label || c.type} ($${c.amount})`).join(", ") +
          `. Please review these charges and decide whether to approve ` +
          `or reject them.`,
          {
            department: "billing",
            extractedData: {
              "Carrier": aiResult.carrierName || "—",
              "Load Number": aiResult.loadNumber || "—",
              "Invoice Total": `$${aiResult.invoiceAmount}`,
              "Unrecognized Charges": normalizedChargeData.unrecognizedCharges
                  .map((c) => `${c.label || c.type}: $${c.amount}`).join(", "),
            },
          },
      );
      await writeLog("warn", "ai", "Unrecognized charges detected", {
        event: "AI decision - needs review",
        messageId: messageId,
        details: {
          invoiceAmount: aiResult.invoiceAmount,
          carrierName: aiResult.carrierName,
          loadNumber: aiResult.loadNumber,
          proNumber: aiResult.proNumber,
          unrecognizedCharges: normalizedChargeData.unrecognizedCharges,
          reason: "AI detected charges it could not recognize",
          decision: "UNRECOGNIZED_CHARGES",
          reviewRequired: true,
        },
      });
    } else if (aiResult.status === "charges_no_proof" ||
    hasChargesNeedProof) {
      finalStatus = "charges_no_proof";
      await forwardToHumanReview(
          gmail, messageId, subject, from,
          "Invoice has extra charges but supporting receipts are missing",
          `I received an invoice from ` +
          `${aiResult.carrierName || "this carrier"} for load ` +
          `${aiResult.loadNumber}. The invoice amount is ` +
          `$${aiResult.invoiceAmount}. The invoice includes ` +
          normalizedChargeData.chargesNeedProof
              .map((c) => c.type).join(" and ") +
          ` charges but no supporting receipt or proof document was ` +
          `attached. Please request the missing proof from the carrier ` +
          `before approving this invoice.`,
          {
            department: "billing",
            extractedData: {
              "Carrier": aiResult.carrierName || "—",
              "Load Number": aiResult.loadNumber || "—",
              "Invoice Total": `$${aiResult.invoiceAmount}`,
              "Charges Missing Proof": normalizedChargeData.chargesNeedProof
                  .map((c) => `${c.type}: $${c.amount}`).join(", "),
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
    } else if (aiResult.status === "ready_for_primus_validation") {
      // ── Primus shipment lookup (stub) ──────────────────────────────────
      const primusData = await getPrimusShipment(
          aiResult.loadNumber, aiResult.proNumber,
      );

      // ── Lumper validation: subtract lumper from invoice before comparing ──
      let primusValidationAmount = aiResult.invoiceAmount;
      if (normalizedChargeData.recognizedCharges &&
          normalizedChargeData.recognizedCharges.length > 0) {
        const lumperValidation = validateLumperAmount(
            aiResult, primusData.rate,
        );
        if (lumperValidation.totalLumper > 0) {
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
        // the Primus rate, flag for billing — better than a generic
        // mismatch message.
        if (primusData.rate && lumperValidation.totalLumper > 0 &&
            !lumperValidation.valid) {
          await forwardToHumanReview(
              gmail, messageId, subject, from,
              "Lumper charges do not reconcile with the shipment rate",
              `The carrier invoice includes ` +
              `$${lumperValidation.totalLumper.toFixed(2)} in lumper ` +
              `charges. After removing them the base freight charge is ` +
              `$${lumperValidation.baseAmount.toFixed(2)}, but the Primus ` +
              `rate on file is $${primusData.rate}. ` +
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
                  "Primus Rate": `$${primusData.rate}`,
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
          const hasLumpers = primusValidationAmount !== aiResult.invoiceAmount;
          await forwardToHumanReview(
              gmail, messageId, subject, from,
              "Invoice profit is below the minimum threshold",
              `I processed the invoice from ` +
              `${aiResult.carrierName || "this carrier"} for load ` +
              `${aiResult.loadNumber}. The calculated profit is ` +
              `$${profitCheck.profit.toFixed(2)}, which is below the $10 ` +
              `minimum. ` +
              `Please review the customer rate or authorize an exception.`,
              {
                department: "billing",
                extractedData: {
                  "Carrier": aiResult.carrierName || "—",
                  "Load Number": aiResult.loadNumber || "—",
                  "Invoice Amount": `$${aiResult.invoiceAmount}`,
                  ...(hasLumpers ? {
                    "Lumper-Adjusted Amount": `$${primusValidationAmount}`,
                  } : {}),
                  "Customer Rate": `$${primusData.rate}`,
                  "Profit": `$${profitCheck.profit.toFixed(2)}`,
                },
              },
          );
          finalStatus = "no_rate";
        } else if (profitCheck.lowMargin) {
          // Margin < 10%: flag for broker commission adjustment
          await adjustBrokerCommission(
              aiResult.loadNumber, profitCheck.margin);
          await writeLog("info", "primus",
              "Low margin flagged for broker commission", {
                messageId, loadNumber: aiResult.loadNumber,
                margin: profitCheck.margin, profit: profitCheck.profit,
              });
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
          await writeLog("info", "gmail", `Invoice queued for workflow`, {
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
      // Claude returned a status we don't have a rule for (e.g. "error",
      // "unmatched_amount" returned directly). Forward with AI note so a
      // human can handle it, and label ERROR.
      finalStatus = "error";
      await writeLog("warn", "ai", "Unexpected AI classification status", {
        messageId, status: aiResult.status,
      });
      await forwardWithAnalysis(
          `AI returned an unexpected invoice status: ${aiResult.status}`,
          {department: "general", emailBody},
      );
    }

    await writeLog(
        "info",
        "gmail",
        `Saving to emailIntake collection`,
        {messageId: messageId, finalStatus: finalStatus},
    );

    const emailIntakeRef = db.collection("emailIntake").doc(messageId);
    const intakeCreated = await db.runTransaction(async (tx) => {
      const intakeSnap = await tx.get(emailIntakeRef);
      if (intakeSnap.exists) {
        return false;
      }

      tx.set(emailIntakeRef, {
        primusResult: primusResult,
        finalStatus: finalStatus,
        gmailMessageId: messageId,
        from: from,
        subject: subject,
        attachmentCount: attachments.length,
        attachments: attachments,
        parsedAttachments: storedAttachments,
        aiResult: aiResult,
        status: "processed",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        deleteAt: getDeleteAt(7),
      });
      return true;
    });

    if (!intakeCreated) {
      const duplicateIntakeMessage =
          "Duplicate emailIntake already exists, skipping duplicate write";
      await writeLog("warn", "gmail", duplicateIntakeMessage, {
        messageId,
      });
      await updateGmailQueueStatus(messageId, "completed");
      return;
    }

    const shouldCreateInvoice = aiResult.status !== "error" &&
        aiResult.invoiceAmount > 0 &&
        finalStatus === "processing";
    if (shouldCreateInvoice) {
      await writeLog("info", "gmail", `Creating invoice document`, {
        messageId: messageId,
        invoiceAmount: aiResult.invoiceAmount,
        carrierName: aiResult.carrierName,
        proNumber: aiResult.proNumber,
        loadNumber: aiResult.loadNumber,
      });

      const invoiceAttachments = storedAttachments.map((att) => ({
        filename: att.filename,
        storagePath: att.storagePath,
        mimeType: att.mimeType,
      }));

      let decisionStage = "pending_primus_check";
      let matchStatus = "not_checked";
      let reviewStatus = "not_needed";
      let decisionReason = "Waiting for Primus lookup.";
      let primusAmount = null;
      let amountDifference = null;

      if (primusResult && primusResult.ok && primusResult.validAmount) {
        primusAmount = Number(primusResult.amount || 0);
        amountDifference = Math.abs(aiResult.invoiceAmount - primusAmount);

        if (amountDifference <= 5) {
          decisionStage = "ready_to_approve";
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
      const invoiceDoc = await db.collection("invoices").add({
        carrierName: aiResult.carrierName || null,
        invoiceNumber: aiResult.invoiceNumber || null,
        proNumber: aiResult.proNumber || null,
        loadNumber: aiResult.loadNumber || null,
        invoiceAmount: aiResult.invoiceAmount,
        dueDate: aiResult.dueDate || null,
        charges: aiResult.charges || [],
        recognizedCharges: normalizedChargeData.recognizedCharges,
        unrecognizedCharges: normalizedChargeData.unrecognizedCharges,
        chargesNeedProof: normalizedChargeData.chargesNeedProof,
        chargeProofRefs: normalizedChargeData.chargeProofRefs,
        approvedChargeProofFiles: [],
        attachments: invoiceAttachments,
        pod: aiResult.pod || {
          found: false,
          source: "",
          attachmentFilename: "",
          page: "",
          reason: "",
        },
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
        finalWorkflowStatus: "created",
        primusSteps: {
          amountValidated: false,
          proAdded: false,
          shipmentDelivered: false,
          customerRateChecked: false,
          billApproved: false,
          customerInvoiceGenerated: false,
        },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        deleteAt: getDeleteAt(7),
      });

      await logWorkflowStep({
        invoiceId: invoiceDoc.id,
        gmailMessageId: messageId,
        stepName: "gmail_email_found",
        stepStatus: "success",
        input: {messageId: messageId, subject: subject},
        output: {invoiceId: invoiceDoc.id},
      });

      await logWorkflowStep({
        invoiceId: invoiceDoc.id,
        stepName: "invoice_created",
        stepStatus: "success",
        output: {invoiceId: invoiceDoc.id},
      });

      await writeLog("info", "gmail", `Invoice document created`, {
        messageId: messageId,
        invoiceId: invoiceDoc.id,
        decisionStage: decisionStage,
        matchStatus: matchStatus,
      });

      await writeLog(
          "info",
          "workflow",
          `Starting Primus workflow for new invoice`,
          {
            messageId: messageId,
            invoiceId: invoiceDoc.id,
          },
      );

      try {
        const workflowUrl =
          process.env.PROCESS_PRIMUS_WORKFLOW_URL ||
          "https://us-central1-tai-invoice-automation.cloudfunctions.net/processPrimusWorkflow";
        const workflowRes = await fetch(
            workflowUrl,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({invoiceId: invoiceDoc.id}),
            },
        );

        if (!workflowRes.ok) {
          const text = await workflowRes.text();
          await writeLog(
              "error",
              "workflow",
              "Failed to start Primus workflow",
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
            "Failed to start Primus workflow",
            {
              messageId: messageId,
              invoiceId: invoiceDoc.id,
              error: workflowError.message,
            },
        );
      }

      console.log(`Created invoice document from email ${messageId}`);
    } else {
      await writeLog(
          "warn",
          "gmail",
          `Skipping invoice creation due to AI error or zero amount`,
          {
            messageId: messageId,
            aiStatus: aiResult.status,
            invoiceAmount: aiResult.invoiceAmount,
          },
      );
    }

    await writeLog("info", "gmail", `Email processing completed`, {
      messageId: messageId,
      finalStatus: finalStatus,
    });

    await updateGmailQueueStatus(messageId, "completed");
  } catch (error) {
    await updateGmailQueueStatus(messageId, "failed", error.message);
    throw error;
  }
}

/**
 * Recursively extracts attachments from Gmail message parts.
 * @param {Array<object>} parts Gmail message parts.
 * @return {Array<object>} Array of attachment objects.
 */
function extractAttachmentsRecursive(parts) {
  const attachments = [];

  if (!parts || !Array.isArray(parts)) {
    return attachments;
  }

  for (const part of parts) {
    // Check if this part is an attachment
    if (part.filename && part.body && part.body.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType,
        attachmentId: part.body.attachmentId,
      });
    }

    // Recursively check nested parts
    if (part.parts && Array.isArray(part.parts)) {
      const nestedAttachments = extractAttachmentsRecursive(part.parts);
      attachments.push(...nestedAttachments);
    }
  }

  return attachments;
}
exports.gmailConnect = onRequest(async (req, res) => {
  try {
    const oauth2Client = getGmailOAuthClient();

    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.send",
      ],
    });

    return res.redirect(url);
  } catch (error) {
    console.error("gmailConnect error:", error);
    return res.status(500).send(error.message);
  }
});

exports.gmailOAuthCallback = onRequest(async (req, res) => {
  try {
    const code = req.query.code;

    if (!code) {
      return res.status(400).send("Missing code from Google.");
    }

    const oauth2Client = getGmailOAuthClient();

    const {tokens} = await oauth2Client.getToken(code);

    await db.collection("settings").doc("gmail").set({
      tokens: tokens,
      connectedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.send("Gmail connected successfully. You can close this page.");
  } catch (error) {
    console.error("gmailOAuthCallback error:", error);
    return res.status(500).send(error.message);
  }
});

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
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  return false;
}

// Supported dashboard time ranges, mapped to how far back to look and the
// granularity to bucket results into. Kept as a whitelist so the range
// query param can never reach the SQL string directly.
const DASHBOARD_RANGES = {
  week: {days: 7, truncUnit: "DAY"},
  month: {days: 30, truncUnit: "DAY"},
  year: {days: 365, truncUnit: "MONTH"},
};

exports.getGmailStatus = onRequest(async (req, res) => {
  if (applyDashboardCors(req, res)) {
    return;
  }

  try {
    const gmailDoc = await db.collection("settings").doc("gmail").get();
    if (!gmailDoc.exists) {
      return res.json({ok: true, connected: false});
    }

    const data = gmailDoc.data();
    return res.json({
      ok: true,
      connected: true,
      connectedAt: data.connectedAt ? data.connectedAt.toDate() : null,
    });
  } catch (error) {
    console.error("getGmailStatus error:", error);
    return res.status(500).json({ok: false, error: error.message});
  }
});

exports.gmailDisconnect = onRequest(
    {invoker: "public"},
    async (req, res) => {
      if (applyDashboardCors(req, res)) return;
      if (req.method !== "POST") {
        return res.status(405).json({ok: false, error: "Method not allowed."});
      }
      try {
        await db.collection("settings").doc("gmail").delete();
        return res.json({ok: true});
      } catch (error) {
        console.error("gmailDisconnect error:", error);
        return res.status(500).json({ok: false, error: error.message});
      }
    },
);

exports.setCustomerRate = onRequest(async (req, res) => {
  const invoiceId = req.query.invoiceId || (req.body && req.body.invoiceId);
  if (!invoiceId) {
    return res.status(400).send("Missing invoiceId.");
  }

  const invoiceRef = db.collection("invoices").doc(String(invoiceId));
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

  // The Primus PUT /book/{BOLId} schema does not expose accountingInformation
  // as a writable field, so there is no API way to store the rate on the
  // booking record. The rate reaches the invoice via invoiceBreakdown when
  // generateCustomerInvoice runs later in the workflow.

  await invoiceRef.update({
    customerRate,
    customerName: customerName || inv.customerName || null,
    primusSteps: {...primusSteps, customerRateChecked: true},
    workflowPausedAtStep: null,
    workflowPausedAt: null,
    finalWorkflowStatus: "running",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await writeLog("info", "workflow", "Customer rate set manually", {
    invoiceId,
    loadNumber: inv.loadNumber,
    customerRate,
    customerName,
  });

  const workflowUrl =
    process.env.PROCESS_PRIMUS_WORKFLOW_URL ||
    "https://us-central1-tai-invoice-automation.cloudfunctions.net" +
    "/processPrimusWorkflow";

  fetch(workflowUrl, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({invoiceId, resumeFrom: "generate_invoice"}),
  }).catch((e) => console.error("setCustomerRate: resume failed", e.message));

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

exports.getRecentLogs = onRequest(
    {invoker: "public"},
    async (req, res) => {
      if (applyDashboardCors(req, res)) return;
      try {
        const limit = Math.min(Number(req.query.limit || 40), 100);
        const [rows] = await bigquery.query({
          query: `
            SELECT timestamp, level, category, message
            FROM \`${BQ_DATASET}.${BQ_LOGS_TABLE}\`
            ORDER BY timestamp DESC
            LIMIT @limit
          `,
          params: {limit},
        });
        const logs = rows.map((row) => ({
          timestamp: row.timestamp && row.timestamp.value ?
            row.timestamp.value : String(row.timestamp),
          level: row.level,
          category: row.category,
          message: row.message,
        }));
        return res.json({ok: true, logs});
      } catch (error) {
        console.error("getRecentLogs error:", error);
        return res.status(500).json({
          ok: false, error: "Failed to load logs.", details: error.message,
        });
      }
    },
);

exports.getDashboardStats = onRequest(async (req, res) => {
  if (applyDashboardCors(req, res)) {
    return;
  }

  try {
    const range = String(req.query.range || "week").toLowerCase();
    const rangeConfig = DASHBOARD_RANGES[range];
    if (!rangeConfig) {
      return res.status(400).json({
        ok: false,
        error: "Invalid range. Use week, month, or year.",
      });
    }

    const query = `
      SELECT
        TIMESTAMP_TRUNC(timestamp, ${rangeConfig.truncUnit}) AS period,
        COUNTIF(
          category = "gmail" AND message = "Email processing completed"
        ) AS invoicesProcessed,
        COUNTIF(
          category = "email" AND message = "Outbound email sent"
        ) AS emailsReplied,
        COUNTIF(
          category = "gmail" AND (
            message = "Forwarded to human review" OR
            message = "No attachments found, forwarding for review"
          )
        ) AS emailsForwarded
      FROM \`${BQ_DATASET}.${BQ_LOGS_TABLE}\`
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
      emailsReplied: Number(row.emailsReplied || 0),
      emailsForwarded: Number(row.emailsForwarded || 0),
    }));

    const totals = series.reduce((acc, row) => ({
      invoicesProcessed: acc.invoicesProcessed + row.invoicesProcessed,
      emailsReplied: acc.emailsReplied + row.emailsReplied,
      emailsForwarded: acc.emailsForwarded + row.emailsForwarded,
    }), {invoicesProcessed: 0, emailsReplied: 0, emailsForwarded: 0});

    return res.json({ok: true, range, totals, series});
  } catch (error) {
    console.error("getDashboardStats error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to load dashboard stats.",
      details: error.message,
    });
  }
});

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
  const to = process.env.SUPPORT_ISSUE_EMAIL || "mshglck@gmail.com";

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

  const gmailDoc = await db.collection("settings").doc("gmail").get();
  if (!gmailDoc.exists) {
    console.error(
        "[sendSupportIssueEmail] Gmail not connected — issue report " +
        `dropped for ${safeClientName}`,
    );
    return;
  }

  const gmailSettings = gmailDoc.data();
  const tokens = gmailSettings.tokens || gmailSettings;

  const oauth2Client = getGmailOAuthClient();
  oauth2Client.setCredentials(tokens);

  const gmail = google.gmail({version: "v1", auth: oauth2Client});

  const mimeBuffer = Buffer.from(
      `To: ${to}\r\n` +
      `Subject: ${subject}\r\n` +
      `Content-Type: text/html; charset="UTF-8"\r\n\r\n${html}`,
  );

  await gmail.users.messages.send({
    userId: "me",
    requestBody: {raw: mimeBuffer.toString("base64url")},
  });
}

// Support-chat conversations are capped to keep prompt size and per-request
// cost predictable — long enough for a real back-and-forth, short enough
// that a confused user can't run up an unbounded bill.
const SUPPORT_CHAT_MAX_TURNS = 24;
const SUPPORT_CHAT_MAX_MESSAGE_LENGTH = 4000;

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

    const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});

    const systemPrompt =
      `You are the support assistant on ${clientName}'s invoice-` +
      "automation dashboard. Customers come to you when something looks " +
      "wrong — e.g. an invoice they expected to see is missing, the " +
      "stats or chart look off, a reply or forward never went out, or " +
      "Gmail shows as disconnected. " +
      "Have a natural, brief conversation: ask short, focused follow-up " +
      "questions — one or two at a time, in plain language — until you " +
      "understand what the customer expected, what actually happened, " +
      "roughly when, and any identifying details (load number, invoice " +
      "number, carrier name, email subject, date/time, the time-range " +
      "tab they were viewing). Don't interrogate — once you have enough " +
      "to write a useful report for an engineer, stop and wrap up. " +
      "Reply with ONLY valid JSON (no markdown fences) in this exact " +
      "shape: {\"reply\": string, \"status\": \"asking\" | \"ready\", " +
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

    const aiRes = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 800,
      system: systemPrompt,
      messages: history,
    });

    const block = aiRes.content && aiRes.content.find(
        (c) => c.type === "text",
    );
    const rawText = block && block.text ? block.text.trim() : "";

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      console.error(
          "[dashboardSupportChat] Could not parse AI response as JSON:",
          parseErr, rawText,
      );
      parsed = {
        reply: "Sorry, I had trouble processing that — could you try " +
          "rephrasing?",
        status: "asking",
        summary: "",
      };
    }

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
    return res.status(500).json({
      ok: false,
      error: "The support chat is temporarily unavailable. Please try " +
        "again shortly.",
    });
  }
});

exports.checkGmailInbox = onRequest(
    {timeoutSeconds: 540, memory: "1GiB"},
    async (req, res) => {
      try {
        await logWorkflowStep({
          stepName: "gmail_email_found",
          stepStatus: "started",
        });

        await writeLog("info", "gmail", "Starting Gmail inbox check");

        const inboxFlowId = crypto.randomUUID ?
          crypto.randomUUID() :
          `inbox-${Date.now()}`;

        const gmailDoc = await db.collection("settings").doc("gmail").get();

        if (!gmailDoc.exists) {
          await writeLog("warn", "gmail", "Gmail is not connected");
          console.log("Gmail is not connected.");
          return res.status(400).json({
            ok: false,
            error: "Gmail is not connected.",
          });
        }

        const gmailSettings = gmailDoc.data();
        const tokens = gmailSettings.tokens || gmailSettings;

        const oauth2Client = getGmailOAuthClient();
        oauth2Client.setCredentials(tokens);

        const gmail = google.gmail({
          version: "v1",
          auth: oauth2Client,
        });

        await writeLog(
            "info",
            "gmail",
            "Fetching messages from Gmail",
            {flowId: inboxFlowId, currentStep: "gmail_inbox_check"},
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

        // Cache last known load number for the run.
        const lastKnownLoadNumber = await getLastKnownLoadNumber();

        // Safety cap to avoid hitting function timeouts if inbox is flooded.
        const maxMessagesPerRun = 10;

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
            "gmail",
            `Found ${messages.length} new invoice email(s)`,
            {
              flowId: inboxFlowId,
              currentStep: "gmail_inbox_check",
              messageCount: messages.length,
            },
        );

        console.log(`Found ${messages.length} new invoice email(s).`);

        for (const message of messages) {
          try {
            // Skip if already processed (deduplication guard).
            const alreadyProcessed = await db.collection("emailIntake")
                .where("gmailMessageId", "==", message.id).limit(1).get();
            if (!alreadyProcessed.empty) {
              await writeLog("info", "gmail",
                  `Skipping already-processed message ${message.id}`);
              continue;
            }

            await writeLog(
                "info",
                "gmail",
                `Processing message ${message.id}`,
                {
                  messageId: message.id,
                },
            );

            await processGmailMessage(
                gmail,
                message,
                inboxFlowId,
                lastKnownLoadNumber,
            );

            // Mark as read so it won't appear in future unread queries.
            await gmail.users.messages.modify({
              userId: "me",
              id: message.id,
              requestBody: {removeLabelIds: ["UNREAD"]},
            });
          } catch (error) {
            await writeLog("error", "gmail", `Error processing message`, {
              messageId: message.id,
              error: error.message,
              stack: error.stack,
            });

            console.error(`Error processing message ${message.id}:`, error);

            try {
              let errSubject = "(unknown subject)";
              let errFrom = "(unknown sender)";
              let errBody = null;
              try {
                const fullErrMsg = await gmail.users.messages.get({
                  userId: "me",
                  id: message.id,
                  format: "full",
                });
                const hdrs = fullErrMsg.data.payload?.headers || [];
                errSubject = hdrs.find((h) => h.name === "Subject")
                    ?.value || errSubject;
                errFrom = hdrs.find((h) => h.name === "From")?.value || errFrom;
                errBody = extractEmailBody(fullErrMsg.data.payload) || null;
              } catch (fetchErr) {
                console.error(
                    `[processInbox] Could not fetch details for message ` +
                    `${message.id} while building error-review forward:`,
                    fetchErr,
                );
              }
              await forwardToHumanReview(
                  gmail,
                  message.id,
                  errSubject,
                  errFrom,
                  "An unexpected error occurred processing this email",
                  `I attempted to process this email but encountered an ` +
                  `unexpected error and was unable to complete the workflow. ` +
                  `Error: ${error.message}. ` +
                  `Please review this email and handle it manually.`,
                  {department: "general", emailBody: errBody},
              );
            } catch (fwdErr) {
              console.error("Failed to forward error email:", fwdErr.message);
            }

            await db.collection("emailErrors").add({
              gmailMessageId: message.id,
              error: error.message,
              status: "error",
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              deleteAt: getDeleteAt(30),
            });

            try {
              await gmail.users.messages.modify({
                userId: "me",
                id: message.id,
                requestBody: {removeLabelIds: ["UNREAD"]},
              });
            } catch (markErr) {
              console.error(
                  `Failed to mark message ${message.id} as read:`,
                  markErr.message,
              );
            }
          }
        }

        await writeLog("info", "gmail", "Gmail inbox check completed", {
          processedMessages: messages.length,
        });
        return res.json({ok: true, processedMessages: messages.length});
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

exports.processGmailQueue = onRequest(
    {timeoutSeconds: 540, memory: "1GiB"},
    async (req, res) => {
      try {
        await writeLog("info", "gmail", "Starting Gmail queue processing");

        const inboxFlowId = crypto.randomUUID ?
          crypto.randomUUID() :
          `queue-${Date.now()}`;

        const gmailDoc = await db.collection("settings").doc("gmail").get();
        if (!gmailDoc.exists) {
          await writeLog("warn", "gmail", "Gmail is not connected");
          return res.status(400).json({
            ok: false,
            error: "Gmail is not connected.",
          });
        }

        const gmailSettings = gmailDoc.data();
        const tokens = gmailSettings.tokens || gmailSettings;

        const oauth2Client = getGmailOAuthClient();
        oauth2Client.setCredentials(tokens);

        const gmail = google.gmail({
          version: "v1",
          auth: oauth2Client,
        });

        const queueSnap = await db.collection("gmailQueue")
            .where("status", "==", "queued")
            .orderBy("claimedAt")
            .limit(10)
            .get();

        const lastKnownLoadNumber = await getLastKnownLoadNumber();

        await writeLog("info", "gmail", "Fetched queued Gmail messages", {
          queueCount: queueSnap.size,
        });

        let processed = 0;
        for (const doc of queueSnap.docs) {
          const queueItem = doc.data() || {};
          try {
            const claimed = await claimGmailQueueItem(doc.id);
            if (!claimed) {
              const skippedClaimedMessage =
                  "Skipped queue item already claimed or no longer queued";
              await writeLog("warn", "gmail", skippedClaimedMessage, {
                messageId: doc.id,
              });
              continue;
            }

            await processGmailMessage(
                gmail,
                {id: doc.id, subject: queueItem.subject, from: queueItem.from},
                inboxFlowId,
                lastKnownLoadNumber,
                {fromQueue: true, queueDocRef: doc.ref},
            );
            processed += 1;
          } catch (error) {
            await writeLog("error", "gmail", "Queued message failed", {
              messageId: doc.id,
              error: error.message,
              stack: error.stack,
            });
          }
        }

        return res.json({ok: true, processedQueue: processed});
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
 * @param {string} method HTTP method.
 * @param {string} path API path (appended to PRIMUS_BASE_URL).
 * @param {object} [body] Optional request body.
 * @return {Promise<object|null>} Parsed response or null on 404.
 */
async function primusRequest(method, path, body) {
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
    throw new Error(`Primus ${method} ${path} → ${resp.status}: ${txt}`);
  }
  return resp.json();
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
  try {
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
    const diff = Math.abs(Number(amount) - primusAmount);
    const tolerance = Math.max(0.50, primusAmount * 0.02);
    const valid = diff <= tolerance;
    return {
      ok: true,
      validAmount: valid,
      amount: primusAmount,
      submittedAmount: Number(amount),
      savedAmount: primusAmount,
      difference: diff,
      proNumber,
      reason: valid ?
        "Amount matches" :
        `Submitted $${amount} vs Primus $${primusAmount}` +
          ` (diff $${diff.toFixed(2)})`,
    };
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
 * Retrieves customer name and rate from a Primus booking.
 * @param {string} loadNumber Load/BOL number.
 * @param {string} proNumber PRO number (used as fallback search key).
 * @return {Promise<object>} Customer rate result.
 */
async function getCustomerRate(loadNumber, proNumber) {
  try {
    let booking = await fetchPrimusBooking(loadNumber);
    if (!booking && proNumber) {
      const searchData = await primusRequest(
          "GET", `/book?vendorPro=${encodeURIComponent(proNumber)}&limit=1`);
      const results = searchData && searchData.data && searchData.data.results;
      booking = Array.isArray(results) ? (results[0] || null) : null;
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
    // When a customerQuoteId exists Primus uses the stored quote automatically;
    // sending a breakdown would be rejected for "Collect" shipments.
    const body = {customerId};
    if (!acct.customerQuoteId) {
      body.invoiceBreakdown = [{
        code: "FREIGHT",
        description: "Freight Charges",
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

/**
 * Processes invoice through complete Primus workflow.
 * @param {string} invoiceId Invoice document ID.
 * @return {Promise<object>} Workflow result.
 */
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
        {storagePath: extractedPodOnlyFile.storagePath} : null,
          error: extractedPodOnlyFile ? null : "POD extraction returned null",
        });

        if (extractedPodOnlyFile) {
          await invoiceDoc.ref.update({
            podOnlyFile: {
              storagePath: extractedPodOnlyFile.storagePath,
              source: extractedPodOnlyFile.source,
            },
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
        const profit = Number(customerRate || 0) -
      (Number(invoice.invoiceAmount || 0) - approvedChargesTotal);
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
          const carrierCost = Number(invoice.invoiceAmount || 0) -
            approvedChargesTotal;
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

        // Check if customer invoice already exists
        let invoiceGenerationResult = null;
        if (invoice.customerInvoiceId) {
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

        // Determine PDF source. Query the Primus document endpoint to get the
        // real issued invoice URL — only present when the invoice has been
        // issued/generated. This is more reliable than invoiceGenerationResult
        // .invoicePdfUrl (which uses a hash that only works in the browser).
        const primusGenerated =
            invoiceGenerationResult && invoiceGenerationResult.generated;
        let primusInvoiceUrl = null;
        let customerInvoicePdfBase64 = null;
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
        } catch (docErr) {
          await writeLog("warn", "primus",
              "Could not fetch Primus document list; will use local PDF", {
                invoiceId,
                loadNumber: invoice.loadNumber,
                error: docErr.message,
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
          pdfSource: primusInvoiceUrl ? "primus" : "local",
        });

        const podStoragePath =
      (extractedPodOnlyFile && extractedPodOnlyFile.storagePath) ||
      (invoice.podOnlyFile && invoice.podOnlyFile.storagePath) ||
      null;

        const attachmentsToSend = [];
        if (primusInvoiceUrl) {
          try {
            // The document URL returned by /document/bolnumber/{n}?type=INV
            // is self-authenticating (no auth header required).
            const pdfResp = await fetch(primusInvoiceUrl);
            if (pdfResp.ok) {
              const buf = Buffer.from(await pdfResp.arrayBuffer());
              // Only accept real PDFs (%PDF- magic bytes). The server can
              // return HTTP 200 HTML for draft/not-found invoices.
              if (buf.slice(0, 5).toString("latin1") === "%PDF-") {
                customerInvoicePdfBase64 = buf.toString("base64");
              } else {
                await writeLog("warn", "primus",
                    "Primus document URL did not return a valid PDF; " +
                    "falling back to locally-built invoice", {
                      invoiceId,
                      loadNumber: invoice.loadNumber,
                      primusInvoiceUrl,
                      preview: buf.slice(0, 100).toString("latin1"),
                    });
              }
            }
          } catch (pdfErr) {
            await writeLog("warn", "primus",
                "Error downloading Primus invoice PDF; " +
                "falling back to locally-built invoice", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  error: pdfErr.message,
                });
          }
        } else if (!primusGenerated) {
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
        if (!customerInvoicePdfBase64) {
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
        } else {
          await writeLog("info", "workflow",
              "Using Primus-generated customer invoice PDF", {
                invoiceId,
                loadNumber: invoice.loadNumber,
                primusInvoiceUrl,
              });
        }

        attachmentsToSend.push({
          filename: `customer-invoice-${invoiceId}.pdf`,
          contentType: "application/pdf",
          contentBase64: customerInvoicePdfBase64,
        });

        if (podStoragePath) {
          const podBase64 = await downloadStorageFileBase64(podStoragePath);
          if (podBase64) {
            attachmentsToSend.push({
              filename: `pod-${invoiceId}.pdf`,
              contentType: "application/pdf",
              contentBase64: podBase64,
            });
          } else {
            await writeLog("warn", "workflow",
                "POD file stored but could not be downloaded for email", {
                  invoiceId,
                  loadNumber: invoice.loadNumber,
                  podStoragePath,
                });
          }
        } else {
          await writeLog("warn", "workflow",
              "No POD attached to customer invoice email — " +
              "POD was not found or not extracted", {
                invoiceId,
                loadNumber: invoice.loadNumber,
                podFound: invoice.pod && invoice.pod.found,
                podSource: invoice.pod && invoice.pod.source,
              });
        }

        await logWorkflowStep({
          invoiceId,
          stepName: "final_email_started",
          stepStatus: "started",
          input: {attachmentCount: attachmentsToSend.length},
        });

        await setWorkflowHeartbeat(invoiceDoc.ref, "final_email_sending");

        // Resolve customer email from Primus booking (billTo party).
        let customerEmail = null;
        try {
          const bkData = await fetchPrimusBooking(invoice.loadNumber);
          if (bkData) {
            const billTo = bkData.billTo || "";
            if (billTo === "thirdparty" && bkData.thirdParty) {
              customerEmail = bkData.thirdParty.email || null;
            }
            if (!customerEmail && bkData.shipper) {
              customerEmail = bkData.shipper.email || null;
            }
            if (!customerEmail && bkData.consignee) {
              customerEmail = bkData.consignee.email || null;
            }
          }
        } catch (_) {
          // Non-fatal — email will go to ALERT_EMAIL fallback
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
          output: {attachmentsSent: attachmentsToSend.length},
        });

        await writeLog("info", "workflow", "Final email sent", {
          invoiceId: invoiceId,
          flowId: flowId,
          currentStep: "final_email_sent",
          attachmentsSent: attachmentsToSend.length,
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


