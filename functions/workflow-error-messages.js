"use strict";

/**
 * User-facing workflow error copy and action buttons.
 * System / configuration / broker-code issues are explain-only (no Continue).
 */

const ACTION = {
  NONE: "none",
  CONTINUE: "continue",
  SET_RATE: "set_rate",
  RESUME: "resume",
};

/**
 * @param {string} text Raw text.
 * @return {string}
 */
function esc(text) {
  return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}

/**
 * @param {Array<[string, string]>} rows Label/value pairs.
 * @return {string}
 */
function detailsTable(rows) {
  const body = rows
      .filter(([, v]) => v != null && v !== "")
      .map(([label, value]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;` +
        `white-space:nowrap">${esc(label)}</td>` +
        `<td style="padding:4px 0">${esc(value)}</td></tr>`,
      ).join("");
  if (!body) return "";
  return `<table style="border-collapse:collapse;font-size:13px;` +
    `margin:12px 0;color:#374151">${body}</table>`;
}

/**
 * @param {string} step UI billing step name.
 * @return {boolean}
 */
function isSystemUiBillingStep(step) {
  const s = String(step || "").toLowerCase();
  if (!s) return false;
  return /session|cookie|getterms|manage\.php|bookingid|upload|internal|/ +
    /timeout|network|fetch failed|not configured|off$/.test(s);
}

/**
 * @param {string} message Raw error message.
 * @param {string} [step] Optional workflow step.
 * @return {boolean}
 */
function looksLikeSystemError(message, step) {
  if (isSystemUiBillingStep(step)) return true;
  const m = String(message || "").toLowerCase();
  if (!m) return false;
  return /internal server|unexpected|cannot read|undefined is not|/ +
    /typeerror|referenceerror|manage\.php|session|not configured|env |/ +
    /timeout|econnreset|fetch failed|status 5\d\d/.test(m);
}

/**
 * @param {object} opts Button context.
 * @param {string} opts.action One of ACTION.*.
 * @param {string} opts.baseUrl Host base URL.
 * @param {string} opts.invoiceId Invoice document id.
 * @param {string} [opts.tenantId] Tenant id query param.
 * @param {string} [opts.label] Link label.
 * @return {string}
 */
function buildWorkflowActionButton(opts) {
  const {
    action,
    baseUrl,
    invoiceId,
    tenantId,
    label,
  } = opts;
  if (!action || action === ACTION.NONE || !baseUrl || !invoiceId) {
    return "";
  }
  const tq = tenantId ? `&tenantId=${encodeURIComponent(tenantId)}` : "";
  let href = "";
  let text = label || "Continue";
  if (action === ACTION.CONTINUE || action === ACTION.RESUME) {
    href = `${baseUrl}/continueWorkflow?invoiceId=` +
      `${encodeURIComponent(invoiceId)}${tq}`;
    text = label || (action === ACTION.RESUME ?
      "Resume Workflow" : "Continue");
  } else if (action === ACTION.SET_RATE) {
    href = `${baseUrl}/setCustomerRate?invoiceId=` +
      `${encodeURIComponent(invoiceId)}${tq}`;
    text = label || "Set Customer Rate";
  } else {
    return "";
  }
  return `<p style="margin-top:16px"><a href="${href}" ` +
    `style="display:inline-block;padding:.6rem 1.25rem;background:#4f46e5;` +
    `color:#fff;border-radius:8px;font-weight:600;text-decoration:none">` +
    `${esc(text)}</a></p>`;
}

/**
 * @param {object} opts Alert builder inputs.
 * @param {string} opts.code Catalog code (see buildWorkflowAlertEmail).
 * @param {object} [opts.context] Template variables.
 * @param {string} [opts.baseUrl]
 * @param {string} [opts.invoiceId]
 * @param {string} [opts.tenantId]
 * @return {{subject: string, html: string, action: string}}
 */
function buildWorkflowAlertEmail(opts) {
  const code = String(opts.code || "UNKNOWN");
  const ctx = opts.context || {};
  const loadNumber = ctx.loadNumber || "—";
  const carrier = ctx.carrierName || "—";
  const customer = ctx.customerName || "—";
  const invoiceId = opts.invoiceId || ctx.invoiceId || "";
  const baseUrl = opts.baseUrl || "";
  const tenantId = opts.tenantId || ctx.tenantId || "";

  let subject = `Action needed — Load ${loadNumber}`;
  let title = "Workflow needs attention";
  let summary = "";
  let explanation = "";
  let action = ACTION.NONE;
  let actionLabel = "";

  switch (code) {
    case "BROKER_NO_10PCT_CODE":
      subject = `Notice — broker has no 10% commission code — ` +
        `Load ${loadNumber}`;
      title = "Broker commission could not be adjusted";
      summary = "This shipment's profit margin is below 10%, but Jerry could " +
      "not switch the broker to a 10% commission rate in ShipPrimus.";
      explanation =
      "Each broker may appear in ShipPrimus multiple times at different " +
      "commission rates. For low-margin loads Jerry tries to move the load " +
      "to that broker's 10% sales-rep code. " +
      `${esc(ctx.brokerName || "This broker")} does not have a 10% option ` +
      "configured, so the commission was left unchanged. " +
      "Customer invoicing was allowed to continue — this is informational " +
      "only and does not block billing.";
      action = ACTION.NONE;
      break;

    case "TEST_CUSTOMER":
      subject = "Customer requires confirmation";
      title = "Test customer detected";
      summary = `Load ${loadNumber} is billed to a test customer ` +
      `(${customer}).`;
      explanation = "Please confirm this customer is correct before Jerry " +
      "continues invoicing.";
      action = ACTION.CONTINUE;
      break;

    case "MISSING_RATE":
      subject = `Action needed — No customer rate for Load ${loadNumber}`;
      title = "Customer rate missing";
      summary = "No customer rate was found for this load in ShipPrimus.";
      explanation = "Enter the correct customer rate, then resume the " +
        "workflow.";
      action = ACTION.SET_RATE;
      actionLabel = "Set Customer Rate";
      break;

    case "LOW_MARGIN":
      subject = `Action needed — Low margin for Load ${loadNumber}`;
      title = "Low margin warning";
      summary = "Profit on this load is below the $10 minimum required to " +
      "invoice automatically.";
      explanation = "Review the carrier cost and customer rate below. Update " +
      "the customer rate in ShipPrimus if the numbers are wrong, or " +
      "authorize an exception.";
      action = ACTION.SET_RATE;
      actionLabel = "Update Customer Rate";
      break;

    case "TAI_SHIPMENT_NOT_FOUND":
      subject = `Action needed — No TAI shipment match for Load ${loadNumber}`;
      title = "TAI shipment not found";
      summary = `No TAI shipment is indexed for load ${loadNumber}` +
      (ctx.proNumber ? ` / PRO ${ctx.proNumber}` : "") + ".";
      explanation = "This usually means the shipment webhook has not arrived " +
      "yet, or the reference on the carrier invoice does not match TAI. " +
      "You can retry after the shipment appears in TAI.";
      action = ACTION.CONTINUE;
      break;

    case "INVOICE_RATE_MISMATCH":
      subject = `Action needed — Rate mismatch on Load ${loadNumber}`;
      title = "Invoice amount mismatch";
      summary = "The customer invoice amount in ShipPrimus does not match " +
      "the expected customer rate.";
      explanation = `Fix the invoice amount in ShipPrimus to ` +
      `${esc(ctx.expectedRate || "the expected rate")}, then resume.`;
      action = ACTION.RESUME;
      break;

    case "INVOICE_GENERATION_FAILED":
      subject = `System issue — Invoice generation failed — Load ${loadNumber}`;
      title = "Invoice generation failed";
      summary = "Jerry hit an automation error while creating the customer " +
      "invoice in ShipPrimus.";
      explanation = ctx.errorMessage ?
      `${esc(ctx.errorMessage)} ` : "";
      explanation += "This is not something you can fix from the Continue " +
      "button — Advanced Automations has been notified via this email. " +
      "Please process this load manually in ShipPrimus if it is urgent.";
      action = ACTION.NONE;
      break;

    case "UI_BILLING_FAILED":
      if (looksLikeSystemError(ctx.errorMessage, ctx.step)) {
        subject = `System issue — ShipPrimus billing automation — Load ` +
        `${loadNumber}`;
        title = "ShipPrimus billing automation failed";
        summary = "Jerry could not complete the automated billing steps in " +
        "ShipPrimus.";
        explanation = (ctx.errorMessage ?
        `${esc(ctx.errorMessage)} ` : "") +
        (ctx.step ? `(Failed at step: ${esc(ctx.step)}.) ` : "") +
        "This is an automation/configuration issue, not a rate you can " +
        "correct in the UI. Please handle this load manually or contact " +
        "Advanced Automations.";
        action = ACTION.NONE;
      } else {
        subject = `Action needed — Invoice issue on Load ${loadNumber}`;
        title = "ShipPrimus billing needs attention";
        summary = "Jerry could not finish billing this load in ShipPrimus.";
        explanation = (ctx.errorMessage ?
        `${esc(ctx.errorMessage)} ` : "") +
        (ctx.step ? `Failed at step: ${esc(ctx.step)}. ` : "") +
        "Correct the issue in ShipPrimus, then resume.";
        action = ACTION.RESUME;
      }
      break;

    case "CUSTOMER_EMAIL_FAILED":
      subject = `Action needed — Customer email failed — Load ${loadNumber}`;
      title = "Customer email could not be sent";
      summary = "The load was invoiced in ShipPrimus, but Jerry could not " +
        "email the customer through ShipPrimus.";
      explanation = ctx.errorMessage ?
      `${esc(ctx.errorMessage)} ` :
      "Send the invoice manually from ShipPrimus, then resume if needed.";
      action = ACTION.RESUME;
      break;

    case "DRAYAGE_STOPPED":
      subject = `Stopped — drayage load ${loadNumber}`;
      title = "Drayage load — not processed";
      summary = "This shipment is marked as drayage in ShipPrimus.";
      explanation = "Drayage loads are not handled automatically. Please " +
      "process this load manually.";
      action = ACTION.NONE;
      break;

    case "WORKFLOW_FAILED":
      subject = `System issue — Workflow error — Load ${loadNumber}`;
      title = "Workflow stopped due to an error";
      summary = "Jerry encountered an unexpected error and could not finish " +
      "processing this invoice.";
      explanation = ctx.errorMessage ?
      `Technical detail: ${esc(ctx.errorMessage)}. ` :
      "";
      explanation += "This is an automation issue — there is nothing useful " +
      "to click here. Please handle the load manually or contact Advanced " +
      "Automations.";
      action = ACTION.NONE;
      break;

    case "STUCK_FLOW":
      subject = `Workflow stuck — Load ${loadNumber} (${carrier})`;
      title = "Workflow stuck";
      summary = "Processing stopped responding before the workflow finished.";
      explanation = ctx.stuckStep ?
      `Last known step: ${esc(ctx.stuckStep)} ` +
      (ctx.stuckMinutes ? `(${ctx.stuckMinutes} minutes ago). ` : "") :
      "";
      explanation += "The lock was released so you can retry manually in " +
      "ShipPrimus or re-trigger after checking the load.";
      action = ACTION.NONE;
      break;

    default:
      subject = `Attention needed — Load ${loadNumber}`;
      title = "Workflow notice";
      summary = ctx.errorMessage ?
      esc(ctx.errorMessage) :
      "An unexpected condition stopped automatic processing.";
      explanation = looksLikeSystemError(ctx.errorMessage, ctx.step) ?
      "This appears to be an automation issue. No action button is shown " +
      "because it would not help — please handle manually or contact " +
      "Advanced Automations." :
      "Review the load in ShipPrimus and take appropriate action.";
      action = looksLikeSystemError(ctx.errorMessage, ctx.step) ?
      ACTION.NONE : ACTION.CONTINUE;
      break;
  }

  const extraRows = [];
  if (loadNumber && loadNumber !== "—") extraRows.push(["Load #", loadNumber]);
  if (carrier && carrier !== "—") extraRows.push(["Carrier", carrier]);
  if (customer && customer !== "—") extraRows.push(["Customer", customer]);
  if (ctx.proNumber) extraRows.push(["PRO", ctx.proNumber]);
  if (ctx.invoiceAmount != null) {
    extraRows.push(
        ["Carrier bill", `$${Number(ctx.invoiceAmount).toFixed(2)}`]);
  }
  if (ctx.customerRate != null) {
    extraRows.push(
        ["Customer rate", `$${Number(ctx.customerRate).toFixed(2)}`]);
  }
  if (ctx.profit != null) {
    extraRows.push(["Profit", `$${Number(ctx.profit).toFixed(2)}`]);
  }
  if (ctx.marginPct != null) {
    extraRows.push(["Margin", `${Number(ctx.marginPct).toFixed(1)}%`]);
  }
  if (ctx.brokerName) extraRows.push(["Broker / sales rep", ctx.brokerName]);
  if (ctx.recipient) extraRows.push(["Email recipient", ctx.recipient]);
  if (ctx.invoiceDocId) {
    extraRows.push(["Primus invoice ID", String(ctx.invoiceDocId)]);
  }

  const marginBlock = code === "LOW_MARGIN" && ctx.carrierCost != null ?
    `<table style="border-collapse:collapse;font-size:15px;margin:12px 0">` +
    `<tr><td style="padding:6px 16px 6px 0"><strong>Carrier cost</strong>` +
    `</td><td>$${Number(ctx.carrierCost).toFixed(2)}</td></tr>` +
    `<tr><td style="padding:6px 16px 6px 0"><strong>Customer rate</strong>` +
    `</td><td>$${Number(ctx.customerRate || 0).toFixed(2)}</td></tr>` +
    `<tr><td style="padding:6px 16px 6px 0"><strong>Profit</strong></td>` +
    `<td style="color:${Number(ctx.profit) < 0 ? "#dc2626" : "#d97706"};` +
    `font-weight:700">$${Number(ctx.profit || 0).toFixed(2)} ` +
    `(${Number(ctx.marginPct || 0)}%)</td></tr>` +
    `<tr><td style="padding:6px 16px 6px 0"><strong>Minimum profit</strong>` +
    `</td><td>$10.00</td></tr></table>` :
    "";

  const rateMismatchBlock = code === "INVOICE_RATE_MISMATCH" ?
    `<table style="border-collapse:collapse;font-size:15px;margin:12px 0">` +
    `<tr><td style="padding:6px 16px 6px 0"><strong>Rate on bill (Primus)` +
    `</strong></td><td style="color:#dc2626;font-weight:700">` +
    `$${Number(ctx.primusTotal || 0).toFixed(2)}</td></tr>` +
    `<tr><td style="padding:6px 16px 6px 0"><strong>Expected rate</strong>` +
    `</td><td style="color:#16a34a;font-weight:700">` +
    `$${Number(ctx.expectedRate || 0).toFixed(2)}</td></tr>` +
    `<tr><td style="padding:6px 16px 6px 0"><strong>Difference</strong>` +
    `</td><td style="color:#dc2626;font-weight:700">` +
    `$${Number(ctx.difference || 0).toFixed(2)}</td></tr></table>` :
    "";

  const html =
    `<h2>${esc(title)}</h2>` +
    `<p>${summary}</p>` +
    (explanation ? `<p style="color:#4b5563;line-height:1.6">` +
      `${explanation}</p>` : "") +
    marginBlock +
    rateMismatchBlock +
    detailsTable(extraRows) +
    buildWorkflowActionButton({
      action,
      baseUrl,
      invoiceId,
      tenantId,
      label: actionLabel,
    });

  return {subject, html, action};
}

module.exports = {
  ACTION,
  buildWorkflowAlertEmail,
  buildWorkflowActionButton,
  looksLikeSystemError,
  isSystemUiBillingStep,
};
