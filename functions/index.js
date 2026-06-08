const {onRequest} = require("firebase-functions/v2/https");

const admin = require("firebase-admin");
const {google} = require("googleapis");
const {BigQuery} = require("@google-cloud/bigquery");
const Anthropic = require("@anthropic-ai/sdk");
const {PDFDocument, StandardFonts} = require("pdf-lib");
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
const bucket = admin.storage().bucket();

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

  const [buf] = await bucket.file(storagePath).download();
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
 * Marks a shipment as delivered in the Primus system.
 * @param {string} loadNumber - The load number.
 * @param {string} proNumber - The PRO number.
 * @return {Promise<object>} Response from Primus API.
 */
async function markShipmentDelivered(loadNumber, proNumber) {
  try {
    const response = await fetch(
        `${process.env.PRIMUS_BASE_URL}/markShipmentDelivered`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            loadNumber: loadNumber,
            proNumber: proNumber,
          }),
        },
    );

    return await response.json();
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
 * Validates a load number is exactly 9 digits.
 * @param {string|null|undefined} loadNumber Raw load number.
 * @return {boolean} True if valid.
 */
function isValidLoadNumber(loadNumber) {
  const normalized = normalizeLoadNumber(loadNumber);
  return /^\d{9}$/.test(normalized);
}

/**
 * Returns the most recently created valid 9-digit load number from invoices.
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
      if (/^\d{9}$/.test(normalized)) {
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

  const lastLog = logs[logs.length - 1];
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

      await doc.ref.update({
        processingLock: false,
        finalWorkflowStatus: "failed",
        decisionStage: "stuck",
        decisionReason: "No heartbeat for 20+ minutes while locked",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      if (inv.gmailMessageId) {
        await applyGmailOutcomeByStoredTokens(
            inv.gmailMessageId,
            "ERROR",
            false,
        );
      }

      await saveOutboundEmail({
        type: "stuck_flow",
        invoiceId: doc.id,
        subject: `Workflow stuck: ${doc.id}`,
        html: `<p>Workflow stuck for invoice ${doc.id} ` +
          `(flowId: ${flowId}).</p>`,
      });

      const [logRows] = await bigquery.query({
        query: `
          SELECT * FROM \`${BQ_DATASET}.${BQ_LOGS_TABLE}\`
          WHERE flowId = @flowId
          ORDER BY timestamp ASC
        `,
        params: {flowId: String(flowId)},
      });

      const summary = await summarizeSingleFlow(flowId, logRows);
      results.push({
        invoiceId: doc.id,
        flowId,
        summaryStatus: summary.summary.finalStatus || "unknown",
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
    const lowMargin = !missingRate && profit < 15;

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
 * Retrieves shipment data from Primus by load/PRO number.
 * @param {string} loadNumber - Load number.
 * @param {string} proNumber - PRO number.
 * @return {Promise<object>} Shipment lookup result (found, rate,
 *   customerEmail).
 */
async function getPrimusShipment(loadNumber, proNumber) {
  // TODO: Implement Primus API integration once documentation is shared
  await writeLog("info", "primus",
      "TODO: getPrimusShipment stub called", {loadNumber, proNumber});
  return {found: false, rate: null, customerEmail: null};
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
        "9-digit number (ignoring spaces and dashes).",
        "If lastKnownLoadNumber is provided, prefer a 9-digit candidate " +
        "where abs(candidate - lastKnownLoadNumber) <= 100000.",
        "If no valid 9-digit candidate is found, return loadNumber as " +
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
  const sendUrl = process.env.WORKFLOW_EMAIL_URL;

  // Log email sending attempt
  console.log("saveOutboundEmail called:", {
    type: email.type,
    invoiceId: email.invoiceId,
    to: email.to || process.env.WORKFLOW_EMAIL_TO,
    sendUrl: sendUrl || "NOT SET",
    hasAttachments: Array.isArray(email.attachments) ?
      email.attachments.length : 0,
  });

  if (sendUrl) {
    try {
      const response = await fetch(sendUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: email.to || process.env.WORKFLOW_EMAIL_TO || "",
          subject: email.subject || "",
          html: email.html || "",
          text: email.text || "",
          attachments: Array.isArray(email.attachments) ?
            email.attachments : [],
        }),
      });

      if (response.ok) {
        const responseData = await response.json();
        sendResult = {ok: true, ...responseData};
        console.log("saveOutboundEmail send successful:", responseData);
      } else {
        const text = await response.text();
        sendResult = {ok: false, status: response.status, response: text};
        console.error("saveOutboundEmail send failed:", {
          status: response.status,
          response: text,
        });
      }
    } catch (error) {
      sendResult = {ok: false, error: error.message};
      console.error("saveOutboundEmail send error:", error.message);
    }
  } else {
    console.warn(
        "saveOutboundEmail: WORKFLOW_EMAIL_URL not set, email not sent",
    );
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
    to: email.to || process.env.WORKFLOW_EMAIL_TO,
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
  const {height} = page.getSize();

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const drawText = (text, x, y, size = 12) => {
    page.drawText(String(text), {x, y, size, font});
  };

  drawText("Customer Invoice", 50, height - 60, 18);
  drawText(`Invoice ID: ${data.invoiceId}`, 50, height - 90, 12);
  drawText(`Load: ${data.loadNumber || ""}`, 50, height - 110, 12);
  drawText(`PRO: ${data.proNumber || ""}`, 50, height - 130, 12);
  drawText(`Customer: ${data.customerName || ""}`, 50, height - 150, 12);
  const customerRateText =
    `Customer Rate: $${Number(data.customerRate || 0).toFixed(2)}`;
  drawText(customerRateText, 50, height - 170, 12);
  const carrierAmountText =
    `Carrier Invoice Amount: $` +
    `${Number(data.carrierInvoiceAmount || 0).toFixed(2)}`;
  drawText(carrierAmountText, 50, height - 190, 12);

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
      return null;
    }

    const attachments = Array.isArray(invoice.attachments) ?
      invoice.attachments : [];
    const podAtt = attachments.find(
        (a) => a && a.filename === invoice.pod.attachmentFilename,
    );

    if (!podAtt || !podAtt.storagePath) {
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
      const [fileBuffer] = await bucket.file(podAtt.storagePath).download();
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

      await bucket.file(storagePath).save(Buffer.from(pdfBytes), {
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

      const [fileBuffer] = await bucket.file(podAtt.storagePath).download();
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

      await bucket.file(storagePath).save(Buffer.from(pdfBytes), {
        metadata: {contentType: "application/pdf"},
      });

      return {storagePath, source: "same_page_as_invoice"};
    }

    if (invoice.pod.source !== "last_page_of_invoice") {
      return null;
    }

    const [fileBuffer] = await bucket.file(podAtt.storagePath).download();
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

    await bucket.file(storagePath).save(Buffer.from(pdfBytes), {
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
 * Gets or creates a Gmail label.
 * @param {object} gmail Gmail client.
 * @param {string} labelName Label name.
 * @return {Promise<string>} Gmail label id.
 */
async function getOrCreateGmailLabel(gmail, labelName) {
  const labelList = await gmail.users.labels.list({
    userId: "me",
  });

  const existing = (labelList.data.labels || []).find((label) => {
    return label.name === labelName;
  });

  if (existing) {
    return existing.id;
  }

  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name: labelName,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
  });

  return created.data.id;
}

/**
 * Applies Gmail label and read/unread status.
 * @param {object} gmail Gmail client.
 * @param {string} messageId Gmail message id.
 * @param {string} labelName Label name.
 * @param {boolean} markRead Whether to mark read.
 * @return {Promise<void>}
 */
async function applyGmailOutcome(gmail, messageId, labelName, markRead) {
  const labelId = await getOrCreateGmailLabel(gmail, labelName);

  const removeLabelIds = [];
  if (markRead) {
    removeLabelIds.push("UNREAD");
  }

  if (labelName !== "PROCESSING") {
    try {
      const processingLabelId = await getOrCreateGmailLabel(
          gmail,
          "PROCESSING",
      );
      if (processingLabelId) {
        removeLabelIds.push(processingLabelId);
      }
    } catch (e) {
      const warnMessage =
          `Unable to resolve PROCESSING label id for message ${messageId}: ` +
          `${e.message}`;
      console.warn(warnMessage);
    }
  }

  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      addLabelIds: [labelId],
      removeLabelIds: removeLabelIds,
    },
  });
}

/**
 * Applies Gmail label and read/unread status using stored tokens.
 * @param {string} messageId - The Gmail message ID.
 * @param {string} labelName - The label name.
 * @param {boolean} markRead - Whether to mark read.
 * @return {Promise<void>}
 */
async function applyGmailOutcomeByStoredTokens(messageId, labelName, markRead) {
  const gmailDoc = await db.collection("settings").doc("gmail").get();

  if (!gmailDoc.exists) {
    return;
  }

  const gmailSettings = gmailDoc.data();
  const tokens = gmailSettings.tokens || gmailSettings;

  const oauth2Client = getGmailOAuthClient();
  oauth2Client.setCredentials(tokens);

  const gmail = google.gmail({
    version: "v1",
    auth: oauth2Client,
  });

  await applyGmailOutcome(gmail, messageId, labelName, markRead);
}

/**
 * Creates or updates a Gmail queue document for a claimed message.
 * @param {string} messageId - The Gmail message ID.
 * @param {string} subject - The email subject.
 * @param {string} from - The email sender.
 * @param {string} inboxFlowId - The inbox check flow ID.
 * @return {Promise<void>}
 */
/**
 * Claims a Gmail message for processing by applying the PROCESSING label.
 * @param {object} gmail - Gmail client.
 * @param {string} messageId - The Gmail message ID.
 * @return {Promise<void>}
 */
async function claimGmailMessage(gmail, messageId) {
  await writeLog("info", "gmail", "Claiming message for processing", {
    messageId,
  });
  await applyGmailOutcome(gmail, messageId, "PROCESSING", false);
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
      await claimGmailMessage(gmail, messageId);
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
      await applyGmailOutcome(gmail, messageId, "NO_INVOICE_PDF", false);
      await updateGmailQueueStatus(messageId, "completed");
      await db.collection("emailIntake").doc(messageId).set({
        gmailMessageId: messageId,
        subject, from,
        finalStatus: "no_attachment",
        finalLabel: "NO_INVOICE_PDF",
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

      await bucket.file(storagePath).save(fileBuffer, {
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
      await applyGmailOutcome(gmail, messageId, "NO_INVOICE_PDF", false);
      await updateGmailQueueStatus(messageId, "completed");
      await db.collection("emailIntake").doc(messageId).set({
        gmailMessageId: messageId,
        subject, from,
        finalStatus: "no_invoice_pdf",
        finalLabel: "NO_INVOICE_PDF",
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

    let finalLabel = "ERROR";
    let finalStatus = "error";
    let markRead = false;
    let primusResult = null;

    const normalizedLoadNumber =
      normalizeLoadNumber(aiResult.loadNumber);
    const normalizedProNumber = normalizeLoadNumber(aiResult.proNumber);
    const isLoadNumberValid = isValidLoadNumber(normalizedLoadNumber) &&
      (!normalizedProNumber ||
      normalizedLoadNumber !== normalizedProNumber);
    const loadNumberInt = Number(normalizedLoadNumber);

    const withinRange = lastKnownLoadNumber === null ? true :
      (Number.isFinite(loadNumberInt) &&
      Math.abs(loadNumberInt - lastKnownLoadNumber) <= 100000);

    const loadGateFailed = !isLoadNumberValid || !withinRange;
    if (loadGateFailed) {
      finalLabel = "NO_LOAD_NUMBER";
      finalStatus = "no_load_number";
      markRead = false;

      await forwardToHumanReview(
          gmail, messageId, subject, from,
          "Could not find a valid load number on this invoice",
          `I processed the invoice from ` +
          `${aiResult.carrierName || "this carrier"} but could not find ` +
          `a valid 9-digit load number. Without a load number I cannot ` +
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
      finalLabel = "UNRECOGNIZED_CHARGES";
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
      finalLabel = "CHARGES_NO_PROOF";
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
          finalLabel = "UNMATCHED_AMOUNT";
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
          finalLabel = "NO_RATE";
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
      if (finalLabel !== "NO_RATE" && finalLabel !== "UNMATCHED_AMOUNT") {
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
          finalLabel = "PROCESSING";
          finalStatus = "processing";
          markRead = false;
          await writeLog("info", "gmail", `Invoice queued for workflow`, {
            messageId: messageId,
            primusAmount: primusResult.amount,
          });
        } else if (primusResult.ok === false &&
               primusResult.reason &&
               primusResult.reason.toLowerCase().includes("not found")) {
          finalLabel = "NOT_FOUND";
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
          finalLabel = "UNMATCHED_AMOUNT";
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
      finalLabel = "ERROR";
      finalStatus = "error";
      await writeLog("warn", "ai", "Unexpected AI classification status", {
        messageId, status: aiResult.status,
      });
      await forwardWithAnalysis(
          `AI returned an unexpected invoice status: ${aiResult.status}`,
          {department: "general", emailBody},
      );
    }

    await writeLog("info", "gmail", `Applying Gmail label`, {
      messageId: messageId,
      label: finalLabel,
      markRead: markRead,
    });

    await applyGmailOutcome(
        gmail,
        messageId,
        finalLabel,
        markRead,
    );

    await writeLog(
        "info",
        "gmail",
        `Saving to emailIntake collection`,
        {
          messageId: messageId,
          finalStatus: finalStatus,
          finalLabel: finalLabel,
        },
    );

    const emailIntakeRef = db.collection("emailIntake").doc(messageId);
    const intakeCreated = await db.runTransaction(async (tx) => {
      const intakeSnap = await tx.get(emailIntakeRef);
      if (intakeSnap.exists) {
        return false;
      }

      tx.set(emailIntakeRef, {
        primusResult: primusResult,
        finalLabel: finalLabel,
        finalStatus: finalStatus,
        markRead: markRead,
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
      finalLabel: finalLabel,
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
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
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

        const gmailQuery = [
          "in:inbox",
          "is:unread",
          "-label:PROCESSING",
          "-label:APPROVED",
          "-label:UNMATCHED_AMOUNT",
          "-label:UNRECOGNIZED_CHARGES",
          "-label:CHARGES_NO_PROOF",
          "-label:NOT_FOUND",
          "-label:NO_LOAD_NUMBER",
          "-label:NO_INVOICE_PDF",
          "-label:NO_RATE",
          "-label:ERROR",
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
          } catch (error) {
            await writeLog("error", "gmail", `Error processing message`, {
              messageId: message.id,
              error: error.message,
              stack: error.stack,
            });

            console.error(`Error processing message ${message.id}:`, error);

            await applyGmailOutcomeByStoredTokens(message.id, "ERROR", false);

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

/**
 * Calls mock Primus validateAmount endpoint.
 * @param {string} loadNumber Load number.
 * @param {number} amount Invoice amount.
 * @return {Promise<object>} Validation result.
 */
async function validateAmountWithPrimus(loadNumber, amount) {
  try {
    const response = await fetch(process.env.PRIMUS_VALIDATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        loadNumber: loadNumber,
        amount: amount,
      }),
    });

    return await response.json();
  } catch (error) {
    await writeLog("error", "primus", "Failed to validate amount with Primus", {
      loadNumber: loadNumber,
      amount: amount,
      error: error.message,
    });
    return {ok: false, error: error.message};
  }
}

/**
 * Calls mock Primus addProNumberToLoad endpoint.
 * @param {string} loadNumber Load number.
 * @param {string} proNumber PRO number.
 * @return {Promise<object>} Add PRO result.
 */
async function addProNumberToLoad(loadNumber, proNumber) {
  try {
    const response = await fetch(
        `${process.env.PRIMUS_BASE_URL}/addProNumberToLoad`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            loadNumber: loadNumber,
            proNumber: proNumber,
          }),
        },
    );

    return await response.json();
  } catch (error) {
    await writeLog("error", "primus", "Failed to add PRO number to load", {
      loadNumber: loadNumber,
      proNumber: proNumber,
      error: error.message,
    });
    return {ok: false, error: error.message};
  }
}

/**
 * Calls mock Primus getCustomerRate endpoint.
 * @param {string} loadNumber Load number.
 * @param {string} proNumber PRO number.
 * @return {Promise<object>} Customer rate result.
 */
async function getCustomerRate(loadNumber, proNumber) {
  try {
    const response = await fetch(
        `${process.env.PRIMUS_BASE_URL}/getCustomerRate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            loadNumber: loadNumber,
            proNumber: proNumber,
          }),
        },
    );

    return await response.json();
  } catch (error) {
    await writeLog("error", "primus", "Failed to get customer rate", {
      loadNumber: loadNumber,
      proNumber: proNumber,
      error: error.message,
    });
    return {ok: false, error: error.message};
  }
}

/**
 * Calls mock Primus approveCarrierBill endpoint.
 * @param {object} billData Bill approval data.
 * @return {Promise<object>} Approval result.
 */
async function approveCarrierBill(billData) {
  try {
    const response = await fetch(
        `${process.env.PRIMUS_BASE_URL}/approveCarrierBill`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(billData),
        },
    );

    return await response.json();
  } catch (error) {
    await writeLog("error", "primus", "Failed to approve carrier bill", {
      billData: billData,
      error: error.message,
    });
    return {ok: false, error: error.message};
  }
}

/**
 * Calls mock Primus generateCustomerInvoice endpoint.
 * @param {object} invoiceData Customer invoice data.
 * @return {Promise<object>} Invoice generation result.
 */
async function generateCustomerInvoice(invoiceData) {
  try {
    const response = await fetch(
        `${process.env.PRIMUS_BASE_URL}/generateCustomerInvoice`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(invoiceData),
        },
    );

    return await response.json();
  } catch (error) {
    await writeLog("error", "primus", "Failed to generate customer invoice", {
      invoiceData: invoiceData,
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

        await writeLog("info", "workflow", "Starting Primus workflow", {
          invoiceId: invoiceId,
        });

        // Get invoice document
        const invoiceDoc = await db.collection("invoices").doc(invoiceId).get();

        if (!invoiceDoc.exists) {
          return res.status(404).json({
            ok: false,
            error: "Invoice not found.",
          });
        }

        const invoice = invoiceDoc.data();

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
          await writeLog(
              "warn", "workflow", "Invoice already being processed", {
                invoiceId,
              });
          return res.status(409).json({ok: false, error: "ALREADY_PROCESSING"});
        }

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

          if (invoice.gmailMessageId) {
            await applyGmailOutcomeByStoredTokens(
                invoice.gmailMessageId,
                "UNRECOGNIZED_CHARGES",
                false,
            );
          }

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

          if (invoice.gmailMessageId) {
            await applyGmailOutcomeByStoredTokens(
                invoice.gmailMessageId,
                "CHARGES_NO_PROOF",
                false,
            );
          }

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

        await writeLog("info", "workflow", "Validating invoice amount", {
          invoiceId: invoiceId,
          flowId: flowId,
          currentStep: "amount_validation",
          loadNumber: invoice.loadNumber,
          invoiceAmount: invoice.invoiceAmount,
        });

        await setWorkflowHeartbeat(invoiceDoc.ref, "amount_validation");

        const baseAmount = Number(invoice.invoiceAmount) - approvedChargesTotal;

        const amountValidation = await validateAmountWithPrimus(
            invoice.loadNumber,
            baseAmount,
        );

        await logWorkflowStep({
          invoiceId,
          stepName: "amount_validation_completed",
          stepStatus: amountValidation.ok ? "success" : "failed",
          output: {validAmount: amountValidation.validAmount},
          error: amountValidation.ok ? null : "Amount validation failed",
        });

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

          if (invoice.gmailMessageId) {
            await applyGmailOutcomeByStoredTokens(
                invoice.gmailMessageId,
                "UNMATCHED_AMOUNT",
                false,
            );
          }

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

            await applyGmailOutcomeByStoredTokens(
                invoice.gmailMessageId,
                "EXTRA_CHARGES_REVIEW",
                false,
            );
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

          await writeLog("info", "workflow", "Adding PRO number to load", {
            invoiceId: invoiceId,
            loadNumber: invoice.loadNumber,
            invoicePro: invoice.proNumber,
          });

          const proResult = await addProNumberToLoad(
              invoice.loadNumber,
              invoice.proNumber,
          );

          await logWorkflowStep({
            invoiceId,
            stepName: "pro_added",
            stepStatus: proResult.ok ? "success" : "failed",
            output: proResult.ok ? {newPro: invoice.proNumber} : null,
            error: proResult.ok ? null : "Failed to add PRO to load",
          });

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

        // Ensure approval only runs if shipment has valid PRO
        if (!workingProNumber || workingProNumber.trim() === "") {
          await logWorkflowStep({
            invoiceId,
            stepName: "pro_check_started",
            stepStatus: "failed",
            reason: "No valid PRO number available for approval",
            error: "MISSING_PRO",
          });

          await writeLog("error", "workflow", "Cannot approve without PRO", {
            invoiceId: invoiceId,
            loadNumber: invoice.loadNumber,
          });

          await invoiceDoc.ref.update({
            decisionStage: "missing_pro",
            decisionReason: "No valid PRO number available for approval",
            finalWorkflowStatus: "failed",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          if (invoice.gmailMessageId) {
            await applyGmailOutcomeByStoredTokens(
                invoice.gmailMessageId,
                "ERROR",
                false,
            );
          }

          return res.json({
            ok: false,
            error: "MISSING_PRO",
          });
        }

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

            await writeLog("info", "workflow", "Marking shipment delivered", {
              invoiceId,
              loadNumber: invoice.loadNumber,
              proNumber: invoice.proNumber,
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

            if (alreadyDelivered) {
              await writeLog("info", "workflow", "Shipment already delivered", {
                invoiceId,
                loadNumber: invoice.loadNumber,
                details: deliveredRes,
              });
            }
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

        await writeLog("info", "workflow", "Checking customer", {
          invoiceId: invoiceId,
          loadNumber: invoice.loadNumber,
          proNumber: invoice.proNumber,
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

        await writeLog("info", "workflow", "Approving carrier bill", {
          invoiceId: invoiceId,
          carrierName: invoice.carrierName,
          invoiceAmount: invoice.invoiceAmount,
        });

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

          if (invoice.gmailMessageId) {
            await applyGmailOutcomeByStoredTokens(
                invoice.gmailMessageId,
                "ERROR",
                false,
            );
          }

          return res.json({
            ok: false,
            error: "Carrier bill approval failed",
            details: approvalResult,
          });
        }

        if (alreadyApproved) {
          await writeLog("info", "workflow", "Carrier bill already approved", {
            invoiceId,
            loadNumber: invoice.loadNumber,
            details: approvalResult,
          });
        }

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
          const htmlContent =
        `<p>Invoice ${invoiceId} has no customer rate.</p>` +
        `${buildContinueButtonHtml(baseUrl, invoiceId)}`;
          await saveOutboundEmail({
            type: "rate_missing",
            invoiceId,
            subject: "Customer rate needs attention",
            html: htmlContent,
          });

          return res.json({
            ok: true,
            workflowStatus: "needs_customer_rate_review",
          });
        }

        const customerName = customerRateResult.customerName;
        const customerRate = Number(customerRateResult.customerRate || 0);
        const profit = Number(customerRate || 0) -
      (Number(invoice.invoiceAmount || 0) - approvedChargesTotal);

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

        if (!customerRate || Number(customerRate) <= 0 || profit < 15) {
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
          const rateStatus = !customerRate || Number(customerRate) <= 0 ?
        "no customer rate" : "low margin";
          const htmlContent =
        `<p>Invoice ${invoiceId} has ${rateStatus}.</p>` +
        `${buildContinueButtonHtml(baseUrl, invoiceId)}`;
          await saveOutboundEmail({
            type: "rate_missing",
            invoiceId,
            subject: "Customer rate needs attention",
            html: htmlContent,
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
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        await writeLog(
            "info",
            "workflow",
            "Primus workflow completed",
            {
              invoiceId: invoiceId,
              customerName: customerName,
              profit: profit,
              customerInvoiceId: finalCustomerInvoiceId,
            },
        );

        const podStoragePath =
      (extractedPodOnlyFile && extractedPodOnlyFile.storagePath) ||
      (invoice.podOnlyFile && invoice.podOnlyFile.storagePath) ||
      null;

        const attachmentsToSend = [];

        const customerInvoicePdfBase64 = await buildCustomerInvoicePdfBase64({
          invoiceId,
          loadNumber: invoice.loadNumber,
          proNumber: workingProNumber,
          customerName,
          customerRate,
          carrierInvoiceAmount: invoice.invoiceAmount,
        });

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
          }
        }

        await logWorkflowStep({
          invoiceId,
          stepName: "final_email_started",
          stepStatus: "started",
          input: {attachmentCount: attachmentsToSend.length},
        });

        await setWorkflowHeartbeat(invoiceDoc.ref, "final_email_sending");

        await saveOutboundEmail({
          type: "generated_bill",
          invoiceId,
          subject: "Generated bill ready",
          html: `<p>Generated bill for invoice ${invoiceId}.</p>`,
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
          await applyGmailOutcomeByStoredTokens(
              invoice.gmailMessageId,
              "APPROVED",
              true,
          );

          await logWorkflowStep({
            invoiceId,
            stepName: "gmail_label_updated",
            stepStatus: "success",
            output: {label: "APPROVED"},
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

            if (inv.gmailMessageId) {
              await applyGmailOutcomeByStoredTokens(
                  inv.gmailMessageId,
                  "ERROR",
                  false,
              );
            }
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
