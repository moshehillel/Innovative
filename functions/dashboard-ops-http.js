/**
 * HTTP handlers for the Innovative Jerry ops dashboard console.
 */

"use strict";

const dashboardOps = require("./dashboard-ops");
const dashboardEmailFiles = require("./dashboard-email-files");

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
 * GET open notifications.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<object>}
 */
async function handleListNotifications(req, res) {
  if (cors(req, res)) return;
  try {
    const tenant = await deps.resolveDashboardTenant(req);
    const result = await dashboardOps.listNotifications(deps.db, {
      tenantId: tenant.tenantId,
      limit: req.query.limit,
      offset: req.query.offset,
      type: req.query.type || null,
      ownerBucket: req.query.ownerBucket || null,
      dispatcherKey: req.query.dispatcherKey || null,
      urgentFirst: req.query.urgentFirst !== "0",
      additionalChargesMod: deps.additionalCharges || null,
      backfillMail: typeof deps.backfillDashboardMail === "function" ?
        (items) => deps.backfillDashboardMail(
            items, tenant, "notification") : null,
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
 * POST additional-charge decision A–E from the dashboard.
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
    if (!invoiceId || !["a", "b", "c", "d", "e"].includes(option)) {
      return res.status(400).json({
        ok: false,
        error: "invoiceId and option (a|b|c|d|e) are required.",
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
    // Option B → Dispatch folder. Option D → keep as open dispute task.
    // Other options close the charge task.
    if (option === "b") {
      await deps.dashboardTasks.handoffTaskToDispatch(
          deps.db, deps.additionalCharges, {
            taskId: body.taskId || null,
            source: body.taskSource || null,
            followUpId: body.followUpId || null,
            invoiceId,
            tenantId: tenant.tenantId,
            option,
          }).catch((err) => {
        console.error("handoffTaskToDispatch:", err.message);
      });
    } else if (option === "d") {
      await deps.dashboardTasks.markTaskInDispute(
          deps.db, deps.additionalCharges, {
            taskId: body.taskId || null,
            source: body.taskSource || null,
            followUpId: body.followUpId || null,
            invoiceId,
            tenantId: tenant.tenantId,
          }).catch((err) => {
        console.error("markTaskInDispute:", err.message);
      });
    } else if (body.taskId) {
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
      handedOffToDispatch: option === "b",
      markedInDispute: option === "d",
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
 * @param {string} source task|notification|additionalCharges.
 * @param {string} id Document id.
 * @return {Promise<object|null>}
 */
async function loadMailDoc(source, id) {
  let collection = null;
  if (source === "notification") {
    collection = dashboardOps.NOTIF_COLLECTION;
  } else if (source === "additionalCharges" && deps.additionalCharges) {
    collection = deps.additionalCharges.FOLLOW_UP_COLLECTION;
  } else if (deps.dashboardTasks) {
    collection = deps.dashboardTasks.TASK_COLLECTION;
  }
  if (!collection) return null;
  const snap = await deps.db.collection(collection).doc(id).get();
  if (!snap.exists) return null;
  return snap.data() || {};
}

/**
 * Streams one stored or mailbox attachment.
 * @param {object} res Response.
 * @param {object} att Attachment metadata.
 * @param {object} tenant Tenant.
 * @return {Promise<object>}
 */
async function streamDashboardAttachment(res, att, tenant) {
  const sendBytes = (buf) => {
    res.set("Content-Type", att.mimeType || "application/octet-stream");
    res.set("Content-Disposition",
        dashboardEmailFiles.contentDisposition(att));
    res.set("Cache-Control", "private, max-age=120");
    res.set("X-Content-Type-Options", "nosniff");
    res.send(buf);
  };

  if (att.storagePath && typeof deps.getBucket === "function") {
    const file = deps.getBucket().file(att.storagePath);
    const [exists] = await file.exists();
    if (exists) {
      res.set("Content-Type", att.mimeType || "application/octet-stream");
      res.set("Content-Disposition",
          dashboardEmailFiles.contentDisposition(att));
      res.set("Cache-Control", "private, max-age=120");
      res.set("X-Content-Type-Options", "nosniff");
      await new Promise((resolve, reject) => {
        file.createReadStream()
            .on("error", reject)
            .on("end", resolve)
            .pipe(res);
      });
      return;
    }
  }

  if (att.gmailMessageId && att.gmailAttachmentId &&
      typeof deps.getMailClient === "function" &&
      typeof deps.downloadGmailAttachmentBuffer === "function") {
    const mail = await deps.getMailClient(tenant);
    if (!mail) {
      res.status(404).json({
        ok: false,
        error: "Mailbox is not connected.",
      });
      return;
    }
    const buf = await deps.downloadGmailAttachmentBuffer(
        mail, att.gmailMessageId, att.gmailAttachmentId);
    sendBytes(buf);
    return;
  }

  res.status(404).json({
    ok: false,
    error: "Attachment file is no longer available.",
  });
}

/**
 * GET one email attachment for a task or notification drawer.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<object>}
 */
async function handleDownloadEmailAttachment(req, res) {
  if (cors(req, res)) return;
  try {
    const tenant = await deps.resolveDashboardTenant(req);
    const source = String(req.query.source || "task");
    const id = String(req.query.id || "").trim();
    const index = Number(req.query.index);
    if (!id || !Number.isInteger(index) || index < 0 || index > 40) {
      return res.status(400).json({
        ok: false,
        error: "id and index are required.",
      });
    }
    const data = await loadMailDoc(source, id);
    if (!data) {
      return res.status(404).json({ok: false, error: "Not found."});
    }
    if (data.tenantId && tenant && data.tenantId !== tenant.tenantId) {
      return res.status(404).json({ok: false, error: "Not found."});
    }
    let att = Array.isArray(data.attachments) ?
      data.attachments[index] : null;
    if (!att && data.invoiceId && typeof deps.tcol === "function") {
      const invSnap = await deps.tcol(tenant, "invoices")
          .doc(String(data.invoiceId)).get();
      if (invSnap.exists) {
        const fromInv = dashboardEmailFiles.attachmentsFromInvoice(
            invSnap.data() || {}, {
              includePod: data.type === "pod_discrepancy" ||
                data.type === "signed_pod",
            });
        att = fromInv[index] || null;
      }
    }
    if (!att) {
      return res.status(404).json({
        ok: false,
        error: "Attachment not found.",
      });
    }
    await streamDashboardAttachment(res, att, tenant);
    return undefined;
  } catch (error) {
    console.error("getDashboardEmailAttachment error:", error);
    if (res.headersSent) return undefined;
    return res.status(500).json({
      ok: false,
      error: "Failed to open attachment.",
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
  handleListNotifications,
  handleDismissNotification,
  handleFlagNotification,
  handleAdditionalChargeDecision,
  handleReplyUnhandledEmail,
  handleDeleteUnhandledEmail,
  handleDownloadEmailAttachment,
};
