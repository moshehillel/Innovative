/**
 * HTTP handlers for the Innovative Jerry ops dashboard console.
 */

"use strict";

const dashboardOps = require("./dashboard-ops");
const customerRate = require("./dashboard-customer-rate");

let deps = {};

/**
 * @param {object} d Shared deps from index.js.
 * @return {void}
 */
function init(d) {
  deps = d;
}

/**
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {boolean}
 */
function cors(req, res) {
  return deps.applyDashboardCors(req, res);
}

/**
 * GET Primus accessorial choices for A/E typeaheads.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<object>}
 */
async function handleListAccessorials(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") {
    return res.status(405).json({ok: false, error: "Method not allowed."});
  }
  try {
    await deps.resolveDashboardTenant(req);
    const catalog = require("./quote-accessorial-catalog");
    const accessorials = await catalog.listPrimusAccessorialChoices();
    return res.json({ok: true, accessorials});
  } catch (error) {
    console.error("getDashboardAccessorials error:", error);
    // Never leave Option A/E without a picker — fall back to the static
    // Primus catalog so confirm pages keep working when live fetch fails.
    try {
      const catalog = require("./quote-accessorial-catalog");
      const accessorials = typeof catalog.staticAccessorialChoices === "function" ?
        catalog.staticAccessorialChoices() :
        (await catalog.listPrimusAccessorialChoices());
      return res.json({
        ok: true,
        accessorials: accessorials || [],
        stale: true,
        fetchError: error.message || String(error),
      });
    } catch (fallbackErr) {
      console.error("getDashboardAccessorials fallback error:", fallbackErr);
      return res.status(500).json({
        ok: false,
        error: "Could not load the Primus accessorial list.",
      });
    }
  }
}

/**
 * GET open notifications.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<object>}
 */
async function handleListNotifications(req, res) {
  if (cors(req, res)) return;
  try {
    const tenant = await deps.resolveDashboardTenant(req);
    if (String(req.query.detail || "") === "1") {
      const detail = await dashboardOps.loadNotificationDetail(deps.db, {
        id: req.query.id,
        tenantId: tenant.tenantId,
      });
      if (!detail.ok) {
        return res.status(404).json({
          ok: false,
          error: detail.error || "Not found.",
        });
      }
      return res.json({
        ok: true,
        tenantId: tenant.tenantId,
        body: detail.body || null,
      });
    }
    const result = await dashboardOps.listNotifications(deps.db, {
      tenantId: tenant.tenantId,
      limit: req.query.limit,
      offset: req.query.offset,
      type: req.query.type || null,
      q: req.query.q || req.query.load || "",
      range: req.query.range || "",
      sort: req.query.sort || "",
    });
    return res.json({
      ok: true,
      tenantId: tenant.tenantId,
      opsPrimary: dashboardOps.isDashboardOpsPrimary(),
      ...result,
    });
  } catch (error) {
    console.error("getDashboardNotifications error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to load notifications.",
      details: error.message,
    });
  }
}

/**
 * POST dismiss.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<object>}
 */
async function handleDismissNotification(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ok: false, error: "Method not allowed."});
  }
  try {
    const tenant = await deps.resolveDashboardTenant(req);
    const body = req.body || {};
    const result = await dashboardOps.dismissNotification(deps.db, {
      id: body.id || req.query.id,
      tenantId: tenant.tenantId,
    });
    if (!result.ok) return res.status(400).json(result);
    return res.json({ok: true, tenantId: tenant.tenantId});
  } catch (error) {
    console.error("dismissDashboardNotification error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to dismiss notification.",
      details: error.message,
    });
  }
}

/**
 * POST flag with required note → email Moshe.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<object>}
 */
async function handleFlagNotification(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ok: false, error: "Method not allowed."});
  }
  try {
    const tenant = await deps.resolveDashboardTenant(req);
    const body = req.body || {};
    const result = await dashboardOps.flagNotification(deps.db, {
      id: body.id || req.query.id,
      tenantId: tenant.tenantId,
      note: body.note,
      sendFlagEmail: async ({notification, note}) => {
        const to = deps.resolveSystemErrorEmail();
        const html =
          `<p><strong>Dashboard flag</strong> from ` +
          `${deps.escapeHtml(tenant.name || tenant.tenantId)}</p>` +
          `<p><strong>Notification:</strong> ` +
          `${deps.escapeHtml(notification.title || "")}</p>` +
          `<p><strong>Type:</strong> ` +
          `${deps.escapeHtml(notification.type || "")}</p>` +
          `<p><strong>Subject:</strong> ` +
          `${deps.escapeHtml(notification.subject || "")}</p>` +
          `<p><strong>From:</strong> ` +
          `${deps.escapeHtml(notification.from || "")}</p>` +
          `<p><strong>Load:</strong> ` +
          `${deps.escapeHtml(notification.loadNumber || "—")}</p>` +
          `<p><strong>What is wrong:</strong></p>` +
          `<pre style="white-space:pre-wrap;background:#f9fafb;` +
          `padding:12px;border-radius:8px;">` +
          `${deps.escapeHtml(note)}</pre>`;
        await deps.saveOutboundEmail({
          type: "dashboard_flag",
          tenant,
          forceRecipient: true,
          to,
          subject: `[Dashboard flag] ${notification.title || "Notification"}`,
          html,
          skipAgentGreeting: true,
          invoiceId: notification.invoiceId || null,
        });
      },
    });
    if (!result.ok) return res.status(400).json(result);
    return res.json({ok: true, tenantId: tenant.tenantId});
  } catch (error) {
    console.error("flagDashboardNotification error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to flag notification.",
      details: error.message,
    });
  }
}

/**
 * POST additional-charge decision A–F from the dashboard.
 * Signs an email-action token and reuses additionalChargeAction.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<object>}
 */
async function handleAdditionalChargeDecision(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ok: false, error: "Method not allowed."});
  }
  try {
    const tenant = await deps.resolveDashboardTenant(req);
    const body = req.body || {};
    const invoiceId = String(body.invoiceId || "").trim();
    const option = String(body.option || "").toLowerCase();
    if (!invoiceId || !["a", "b", "c", "d", "e", "f"].includes(option)) {
      return res.status(400).json({
        ok: false,
        error: "invoiceId and option (a|b|c|d|e|f) are required.",
      });
    }

    if (typeof deps.applyAdditionalChargeFromDashboard !== "function") {
      return res.status(500).json({
        ok: false,
        error: "Charge decision handler not configured.",
      });
    }

    const result = await deps.applyAdditionalChargeFromDashboard({
      tenant,
      invoiceId,
      option,
      customerChargeAmount: body.customerChargeAmount,
      customerBillLines: body.customerBillLines,
      rateMode: body.rateMode || body.optionFRateMode,
      rateInput: body.rateInput != null ?
        body.rateInput : body.optionFRateInput,
    });
    if (!result.ok) {
      return res.status(result.status || 400).json(result);
    }

    if (body.notificationId) {
      await dashboardOps.markActed(deps.db, {
        id: body.notificationId,
        tenantId: tenant.tenantId,
        extra: {actedOption: option.toUpperCase()},
      });
    }
    if (body.taskId) {
      await deps.dashboardTasks.dismissDashboardTask(
          deps.db, deps.additionalCharges, {
            taskId: body.taskId,
            source: body.taskSource || "additionalCharges",
            tenantId: tenant.tenantId,
          }).catch(() => {});
    }

    return res.json({
      ok: true,
      accepted: true,
      option: option.toUpperCase(),
      message: result.message || null,
    });
  } catch (error) {
    console.error("dashboardAdditionalChargeDecision error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to apply decision.",
      details: error.message,
    });
  }
}

/**
 * POST reply to an unhandled inbound email via connected mailbox.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<object>}
 */
async function handleReplyUnhandledEmail(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ok: false, error: "Method not allowed."});
  }
  try {
    const tenant = await deps.resolveDashboardTenant(req);
    const body = req.body || {};
    const notificationId = String(body.id || "").trim();
    const replyText = String(body.replyText || body.body || "").trim();
    if (!notificationId) {
      return res.status(400).json({ok: false, error: "id is required."});
    }
    if (replyText.length < 1) {
      return res.status(400).json({ok: false, error: "Reply text is required."});
    }

    const ref = deps.db.collection(dashboardOps.NOTIF_COLLECTION)
        .doc(notificationId);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ok: false, error: "Notification not found."});
    }
    const n = snap.data() || {};
    if (n.tenantId && n.tenantId !== tenant.tenantId) {
      return res.status(404).json({ok: false, error: "Notification not found."});
    }
    const to = extractEmailAddress(n.from);
    if (!to) {
      return res.status(400).json({
        ok: false,
        error: "No From address to reply to.",
      });
    }
    const subject = String(n.subject || "").match(/^re:/i) ?
      String(n.subject) : `Re: ${n.subject || "(no subject)"}`;
    const html =
      `<div style="font-family:Arial,sans-serif;white-space:pre-wrap;">` +
      `${deps.escapeHtml(replyText)}</div>`;

    await deps.saveOutboundEmail({
      type: "dashboard_reply",
      tenant,
      forceRecipient: true,
      to,
      subject,
      html,
      skipAgentGreeting: true,
      invoiceId: n.invoiceId || null,
    });

    await dashboardOps.markActed(deps.db, {
      id: notificationId,
      tenantId: tenant.tenantId,
      extra: {actedAction: "reply"},
    });

    return res.json({ok: true, tenantId: tenant.tenantId});
  } catch (error) {
    console.error("replyDashboardEmail error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to send reply.",
      details: error.message,
    });
  }
}

/**
 * POST trash the original Gmail message for an unhandled email.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<object>}
 */
async function handleDeleteUnhandledEmail(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ok: false, error: "Method not allowed."});
  }
  try {
    const tenant = await deps.resolveDashboardTenant(req);
    const body = req.body || {};
    const notificationId = String(body.id || "").trim();
    if (!notificationId) {
      return res.status(400).json({ok: false, error: "id is required."});
    }
    const ref = deps.db.collection(dashboardOps.NOTIF_COLLECTION)
        .doc(notificationId);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ok: false, error: "Notification not found."});
    }
    const n = snap.data() || {};
    if (n.tenantId && n.tenantId !== tenant.tenantId) {
      return res.status(404).json({ok: false, error: "Notification not found."});
    }
    if (n.messageId && typeof deps.trashGmailMessage === "function") {
      await deps.trashGmailMessage(tenant, n.messageId);
    }
    await dashboardOps.markActed(deps.db, {
      id: notificationId,
      tenantId: tenant.tenantId,
      extra: {actedAction: "delete"},
    });
    return res.json({ok: true, tenantId: tenant.tenantId});
  } catch (error) {
    console.error("deleteDashboardEmail error:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to delete email.",
      details: error.message,
    });
  }
}

/**
 * POST a customer rate for a load that is blocked without one.
 * Writes the invoice the same way as the emailed setCustomerRate form,
 * then resumes the Primus workflow from get_rate.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<object>}
 */
async function handleSetCustomerRate(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ok: false, error: "Method not allowed."});
  }
  try {
    const tenant = await deps.resolveDashboardTenant(req);
    const body = req.body || {};
    const result = await customerRate.saveDashboardCustomerRate({
      db: deps.db,
      tcol: deps.tcol,
      kickWorkflow: deps.kickCustomerRateWorkflow,
    }, {
      tenant,
      invoiceId: body.invoiceId,
      loadNumber: body.loadNumber,
      customerRate: body.customerRate,
      customerName: body.customerName,
    });
    if (!result.ok) return res.status(400).json(result);
    const notificationId = String(body.notificationId || "").trim();
    if (notificationId) {
      await dashboardOps.markActed(deps.db, {
        id: notificationId,
        tenantId: tenant.tenantId,
      }).catch((err) => {
        console.error("setDashboardCustomerRate notice:", err.message);
      });
    }
    return res.json({ok: true, tenantId: tenant.tenantId, ...result});
  } catch (error) {
    console.error("setDashboardCustomerRate error:", error);
    return res.status(500).json({
      ok: false,
      error: "Could not save the customer rate.",
      details: error.message,
    });
  }
}

/**
 * @param {string} from Header value.
 * @return {string}
 */
function extractEmailAddress(from) {
  const s = String(from || "").trim();
  const m = s.match(/<([^>]+)>/);
  if (m) return m[1].trim();
  if (s.includes("@")) return s.replace(/^mailto:/i, "").trim();
  return "";
}

module.exports = {
  init,
  handleListAccessorials,
  handleListNotifications,
  handleDismissNotification,
  handleFlagNotification,
  handleAdditionalChargeDecision,
  handleReplyUnhandledEmail,
  handleDeleteUnhandledEmail,
  handleSetCustomerRate,
};
