/**
 * Lightweight HTTP entry for Jerry email action links.
 *
 * Why this exists: the main functions/index.js cold-starts in ~35s because it
 * eagerly loads Primus/quote/PDF/AI modules. Clicking an email button only
 * needs token verify + a confirmation HTML shell — that belongs here.
 *
 * Pattern (unchanged for users):
 *   GET  → confirmation page (nothing happens yet)
 *   POST → claim / save, return processing/result HTML, heavy work may run
 *          asynchronously via fat workers in the default codebase.
 */
"use strict";

const {onRequest} = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");
const emailActionTokens = require("./email-action-tokens");
const pages = require("./pages");
const {
  tenantFromRequest,
  tcol,
  workflowUrlForTenant,
} = require("./tenant");

admin.initializeApp();

const ACTION_OPTS = {
  invoker: "public",
  minInstances: 1,
  memory: "256MiB",
  timeoutSeconds: 60,
  concurrency: 80,
};

const FAT_BASE =
  process.env.PUBLIC_FUNCTIONS_BASE_URL ||
  emailActionTokens.DEFAULT_PUBLIC_BASE_URL;

const OPTION_LABELS = {
  a: "A - Pay carrier + bill customer (auto-email customer)",
  b: "B - Pay carrier + bill customer (enter updated rate; " +
    "dispatcher notifies customer)",
  c: "C - Pay carrier only (customer rate unchanged)",
  d: "D - Not approved (dispute with carrier)",
  e: "E - Pay carrier + bill customer (enter amount; apply rate; " +
    "no separate customer notification)",
};

/**
 * Shared secret for slim → fat worker calls.
 * @return {string}
 */
function workerSecret() {
  return process.env.EMAIL_ACTION_SECRET ||
    process.env.PRIMUS_PASSWORD ||
    process.env.GMAIL_CLIENT_ID ||
    "";
}

/**
 * Fire-and-forget POST to a fat worker. Never throws to the caller.
 * @param {string} path Function path.
 * @param {object} body JSON body.
 * @return {void}
 */
function kickFatWorker(path, body) {
  const url = `${FAT_BASE.replace(/\/$/, "")}/${path}`;
  const secret = workerSecret();
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Email-Action-Worker-Secret": secret,
    },
    body: JSON.stringify(body),
  }).catch((err) =>
    console.error(`kickFatWorker ${path} failed:`, err.message));
}

/**
 * @param {object} req Request.
 * @return {boolean}
 */
function workerAuthOk(req) {
  const got = String(req.get("X-Email-Action-Worker-Secret") || "");
  const expected = workerSecret();
  if (!expected || !got || got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(
        Buffer.from(got), Buffer.from(expected));
  } catch (_) {
    return false;
  }
}

/**
 * Atomically claims an additional-charge decision.
 * @param {object} invoiceRef Firestore ref.
 * @param {string} decision A-E.
 * @return {Promise<object>}
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
 * @param {object} body POST body.
 * @return {object}
 */
function parseCustomerChargeAmountFromRequest(body) {
  const raw = body && (body.customerChargeAmount != null ?
    body.customerChargeAmount : body.customer_charge_amount);
  const amount = Math.round(Number(raw) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false,
      error: "Enter a customer charge amount greater than 0.",
    };
  }
  return {ok: true, amount};
}

/**
 * @param {object} body POST body.
 * @return {object}
 */
function parseCustomerBillLinesFromRequest(body) {
  const raw = body && body.customerBillLinesJson;
  if (!raw) {
    return {ok: false, error: "Missing accessorial billing lines."};
  }
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed) || !parsed.length) {
      return {ok: false, error: "Enter at least one accessorial line."};
    }
    const lines = [];
    for (const row of parsed) {
      const name = String(row && row.name || "").trim();
      const amount = Math.round(Number(row && row.amount) * 100) / 100;
      if (!name || !Number.isFinite(amount) || amount <= 0) continue;
      lines.push({name, amount});
    }
    if (!lines.length) {
      return {ok: false, error: "Enter at least one accessorial line."};
    }
    return {ok: true, lines};
  } catch (_) {
    return {ok: false, error: "Could not read accessorial billing lines."};
  }
}

/**
 * Fast confirmation GET — token first, Firestore only when form needs data.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<object>}
 */
async function handleAdditionalChargeGet(req, res) {
  const invoiceId = req.query.invoiceId;
  const option = String(req.query.option || "").toLowerCase();
  const tenantId = req.query.tenantId || null;
  const exp = req.query.exp;
  const sig = req.query.sig;

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

  const fields = {
    invoiceId: String(invoiceId),
    option,
    tenantId: tenantId || "",
    exp: String(exp),
    sig: String(sig),
  };

  // C/D need no invoice fields — return HTML immediately (no Firestore).
  if (option === "c" || option === "d") {
    return res.status(200).send(pages.buildEmailActionConfirmPage({
      title: `Confirm option ${option.toUpperCase()}`,
      description:
        `${OPTION_LABELS[option]}. Nothing is sent until you click Confirm.`,
      confirmLabel: `Confirm option ${option.toUpperCase()}`,
      confirmColor: option === "d" ? "#dc2626" : "#2563eb",
      actionPath: "additionalChargeAction",
      fields,
    }));
  }

  // A/B/E: quick Firestore read for form defaults only.
  const tenant = await tenantFromRequest(req);
  const snap = await tcol(tenant, "invoices").doc(String(invoiceId)).get();
  if (!snap.exists) {
    return res.status(404).send("Invoice not found.");
  }
  const invoice = snap.data();
  const charge = invoice.additionalCharge;
  if (!charge) {
    return res.status(400).send(
        "This invoice has no additional charge awaiting a decision.");
  }
  if (charge.decision) {
    return res.status(200).send(pages.simpleResultPage(
        "Already decided", "#6b7280",
        `This charge was already handled (option ` +
        `${pages.escapeHtml(String(charge.decision).toUpperCase())}).`,
        invoice.loadNumber || invoiceId));
  }

  const loadLabel = invoice.loadNumber || invoiceId;
  if (option === "a" || option === "e") {
    const currentRate = Number(invoice.customerRate) || 0;
    const defaultCharge = Number(charge.amount) || 0;
    const rateNote = currentRate > 0 ?
      ` Current customer rate: $${currentRate.toFixed(2)}.` : "";
    const isE = option === "e";
    return res.status(200).send(pages.buildEmailActionConfirmPage({
      title: isE ? "Confirm option E" : "Confirm option A",
      description:
        `Load ${loadLabel}: ${OPTION_LABELS[option]}. Enter how much to ` +
        `charge the customer for this additional charge. The customer rate ` +
        `will be bumped by that amount` +
        (isE ?
          `; no separate customer notification is sent - the charge is ` +
          `included when the customer invoice goes out.` :
          ` and the customer will be emailed.`) +
        rateNote +
        ` Nothing is sent until you click Confirm.`,
      confirmLabel: isE ? "Confirm option E" : "Confirm option A",
      confirmColor: isE ? "#7c3aed" : "#16a34a",
      actionPath: "additionalChargeAction",
      fields,
      inputFields: [{
        name: "customerChargeAmount",
        label: "Amount to charge the customer ($)",
        type: "number",
        required: true,
        min: "0.01",
        step: "0.01",
        placeholder: "0.00",
        value: defaultCharge > 0 ? defaultCharge.toFixed(2) : "",
      }],
    }));
  }

  // option b
  const currentRate = Number(invoice.customerRate) || 0;
  return res.status(200).send(pages.buildOptionBAccessorialConfirmPage({
    title: "Confirm option B",
    description:
      `Load ${loadLabel}: ${OPTION_LABELS[option]}. Enter each accessorial ` +
      `and the amount to bill the customer. The base customer rate stays ` +
      `the same; each accessorial is added as a separate invoice line. The ` +
      `dispatcher will get a ready customer-notification template.`,
    confirmLabel: "Confirm option B",
    confirmColor: "#0d9488",
    actionPath: "additionalChargeAction",
    baseUrl: pages.functionsBaseUrl(),
    baseCustomerRate: currentRate,
    carrierCharges: Array.isArray(charge.charges) ? charge.charges : [],
    fields,
  }));
}

/**
 * POST: claim decision, return processing page, kick fat worker for emails.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<object>}
 */
async function handleAdditionalChargePost(req, res) {
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

  let optionACustomerChargeAmount = null;
  let optionBCustomerBillLines = null;
  if (option === "a" || option === "e") {
    const parsed = parseCustomerChargeAmountFromRequest(req.body || {});
    if (!parsed.ok) {
      return res.status(400).send(parsed.error);
    }
    optionACustomerChargeAmount = parsed.amount;
  }
  if (option === "b") {
    const parsed = parseCustomerBillLinesFromRequest(req.body || {});
    if (!parsed.ok) {
      return res.status(400).send(parsed.error);
    }
    optionBCustomerBillLines = parsed.lines;
  }

  const tenant = await tenantFromRequest(req);
  const invoiceRef = tcol(tenant, "invoices").doc(String(invoiceId));
  const claim = await claimAdditionalChargeDecision(
      invoiceRef, option.toUpperCase());
  if (!claim.ok) {
    if (claim.reason === "already") {
      return res.status(200).send(pages.simpleResultPage(
          "Already decided", "#6b7280",
          `This charge was already handled (option ` +
          `${pages.escapeHtml(String(claim.decision).toUpperCase())}).`));
    }
    return res.status(400).send("Could not process this decision.");
  }

  const invoice = claim.invoice || {};
  const decision = option.toUpperCase();
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
  res.status(200).send(pages.buildEmailActionProcessingPage({
    title: `Option ${decision} submitted`,
    message: processingMessages[option],
    loadNumber: invoice.loadNumber || invoiceId,
  }));

  kickFatWorker("executeAdditionalChargeDecision", {
    invoiceId: String(invoiceId),
    option,
    tenantId: tenant.tenantId,
    optionACustomerChargeAmount,
    optionBCustomerBillLines,
  });
  return;
}

exports.additionalChargeAction = onRequest(ACTION_OPTS, async (req, res) => {
  try {
    if (req.method !== "POST") {
      return handleAdditionalChargeGet(req, res);
    }
    return handleAdditionalChargePost(req, res);
  } catch (error) {
    console.error("additionalChargeAction error:", error);
    return res.status(500).send("Internal server error.");
  }
});

/**
 * Resume / Continue workflow — confirm on GET, execute on POST.
 */
exports.continueWorkflow = onRequest(ACTION_OPTS, async (req, res) => {
  try {
    const invoiceId = (req.body && req.body.invoiceId) || req.query.invoiceId;
    if (!invoiceId) {
      return res.status(400).send("invoiceId is required.");
    }

    const tenant = await tenantFromRequest(req);
    const invoiceRef = tcol(tenant, "invoices").doc(String(invoiceId));
    const snap = await invoiceRef.get();
    if (!snap.exists) {
      return res.status(404).send("Invoice not found.");
    }
    const invoice = snap.data();
    const loadNumber = invoice.loadNumber || "—";
    const paused = invoice.workflowPausedAtStep;

    if (req.method !== "POST") {
      return res.status(200).send(pages.buildEmailActionConfirmPage({
        title: "Resume workflow",
        description:
          `Load ${loadNumber}: resume the paused billing workflow` +
          (paused ? ` (paused at ${paused})` : "") +
          `. Nothing happens until you click Confirm.`,
        confirmLabel: "Resume workflow",
        confirmColor: "#2563eb",
        actionPath: "continueWorkflow",
        fields: {
          invoiceId: String(invoiceId),
          tenantId: tenant.tenantId || "",
        },
      }));
    }

    const wantsJson = req.query.format === "json" ||
      String(req.get("accept") || "").includes("application/json");

    await invoiceRef.update({
      workflowPausedAtStep: null,
      workflowPausedAt: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const workflowUrl = workflowUrlForTenant(tenant);
    if (!workflowUrl) {
      return res.status(400).send(
          `No workflow configured for tenant ${tenant.tenantId}.`);
    }

    const response = await fetch(workflowUrl, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        invoiceId,
        tenantId: tenant.tenantId,
        resumeFrom: paused || null,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    const ok = !!response.ok && payload && payload.ok !== false;
    const userMessage = ok ?
      "Workflow resumed successfully." :
      (payload.error || payload.message ||
        "Workflow resume returned an error.");

    if (!wantsJson) {
      return res.status(ok ? 200 : 422).send(pages.simpleResultPage(
          ok ? "Workflow resumed" : "Could not resume",
          ok ? "#16a34a" : "#dc2626",
          pages.escapeHtml(userMessage),
          loadNumber));
    }
    return res.status(ok ? 200 : 422).json({
      ok,
      resumedFrom: paused || null,
      workflow: payload,
      message: userMessage,
    });
  } catch (error) {
    console.error("continueWorkflow error:", error);
    return res.status(500).send("Internal server error.");
  }
});

/**
 * Set customer rate form — light Firestore only.
 */
exports.setCustomerRate = onRequest(ACTION_OPTS, async (req, res) => {
  try {
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

    if (req.method === "GET") {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Set Customer Rate — Load ${pages.escapeHtml(inv.loadNumber || "")}</title>
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
    .note{font-size:.8rem;color:#6b7280;margin-top:1rem}
  </style>
</head>
<body>
<div class="card">
  <h2>Set Customer Rate — Load ${pages.escapeHtml(inv.loadNumber || "—")}</h2>
  <form method="POST">
    <input type="hidden" name="invoiceId" value="${pages.escapeHtml(invoiceId)}"/>
    <input type="hidden" name="tenantId" value="${pages.escapeHtml(
      tenant.tenantId)}"/>
    <div class="field">
      <label>Carrier</label>
      <div class="readonly">${pages.escapeHtml(inv.carrierName || "—")}</div>
    </div>
    <div class="field">
      <label>Carrier Invoice Amount</label>
      <div class="readonly">$${pages.escapeHtml(String(
      inv.invoiceAmount || "—"))}</div>
    </div>
    <div class="field">
      <label>Customer Name</label>
      <input type="text" name="customerName"
        value="${pages.escapeHtml(inv.customerName || "")}"
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

    const workflowUrl = workflowUrlForTenant(tenant);
    if (workflowUrl) {
      try {
        await fetch(workflowUrl, {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({
            invoiceId,
            tenantId: tenant.tenantId,
            resumeFrom: "get_rate",
          }),
        });
      } catch (e) {
        console.error("setCustomerRate resume failed:", e.message);
      }
    }

    return res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><title>Rate saved</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
background:#f5f6fa;margin:0;padding:2rem;color:#1f2430}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;
padding:2rem;max-width:480px;margin:0 auto;text-align:center}
h2{color:#16a34a}
</style></head><body><div class="card">
<h2>✓ Rate saved</h2>
<p>Customer rate of <strong>$${customerRate}</strong> saved for
Load ${pages.escapeHtml(inv.loadNumber || invoiceId)}.</p>
<p>The workflow is resuming — you will receive the customer invoice
shortly.</p>
</div></body></html>`);
  } catch (error) {
    console.error("setCustomerRate error:", error);
    return res.status(500).send("Internal server error.");
  }
});

/**
 * Lisa load-number entry — GET confirm is light; POST kicks fat worker
 * (Primus lookup + Gmail reprocess live in the default codebase).
 */
exports.enterInvoiceLoadNumber = onRequest(ACTION_OPTS, async (req, res) => {
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

    if (req.method !== "POST") {
      // Best-effort intake lookup for nicer copy; skip if slow/missing.
      let carrier = null;
      let amount = null;
      try {
        const tenant = await tenantFromRequest(req);
        const intakeSnap = await tcol(tenant, "emailIntake")
            .doc(String(messageId)).get();
        const intake = intakeSnap.exists ? intakeSnap.data() : null;
        if (intake && intake.pendingLoadEntry) {
          carrier = intake.pendingLoadEntry.carrierName || null;
          amount = intake.pendingLoadEntry.invoiceAmount;
        }
      } catch (_) {
        // Form still works without intake details.
      }
      const desc =
        `Carrier invoice${carrier ? ` from ${carrier}` : ""}` +
        `${amount != null ? ` ($${amount})` : ""} — enter the Primus ` +
        `load number so Jerry can process it.`;
      return res.status(200).send(pages.buildEmailActionConfirmPage({
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
    const digits = String(rawLoad).replace(/\D/g, "");
    let normalizedLoad = digits;
    if (digits.length === 5) normalizedLoad = `2${digits}`;
    if (!/^\d{6}$/.test(normalizedLoad)) {
      return res.status(400).send(
          "Enter a valid 6-digit Primus load number (5-digit ok if missing " +
          "leading 2).");
    }

    // Return processing page immediately; fat worker validates Primus +
    // reprocesses the Gmail message.
    res.status(200).send(pages.buildEmailActionProcessingPage({
      title: "Load submitted",
      message:
        `Jerry is looking up load ${normalizedLoad} in Primus and ` +
        `reprocessing this invoice — you can close this page.`,
      loadNumber: normalizedLoad,
    }));

    kickFatWorker("executeEnterInvoiceLoadNumber", {
      messageId: String(messageId),
      itemIndex,
      tenantId,
      exp,
      sig,
      loadNumber: normalizedLoad,
    });
    return;
  } catch (error) {
    console.error("enterInvoiceLoadNumber error:", error);
    return res.status(500).send("Something went wrong. Please try again.");
  }
});

// Exported for unit tests / local checks only.
exports._test = {workerAuthOk, workerSecret, parseCustomerChargeAmountFromRequest};
