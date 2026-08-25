/**
 * Quote dashboard HTTP handlers — rules CRUD, chatbot, dispatcher page.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const quoteRules = require("./quote-accessorial-rules");
const quoteRulesChat = require("./quote-rules-chat");
const quoteAutomation = require("./quote-automation");
const addressEnrichment = require("./quote-address-enrichment");
const quoteOutput = require("./quote-output");
const quoteDispatchers = require("./quote-dispatchers");
const dispatcherAuth = require("./quote-dispatcher-auth");
const quoteFirebaseAuth = require("./quote-firebase-auth");
const quoteOutlook = require("./quote-outlook");
const quoteAccCatalog = require("./quote-accessorial-catalog");
const quotePasswordReset = require("./quote-password-reset");

/** Bumped when quote-auth-client.js API changes (cache-bust HTML). */
const QUOTE_AUTH_CLIENT_VERSION = "3";

let deps = {};

/**
 * @param {object} d applyDashboardCors, resolveDashboardTenant, db, tcol.
 * @return {void}
 */
function init(d) {
  deps = d;
  quoteRules.init({tcol: d.tcol});
  quoteDispatchers.init({tcol: d.tcol});
  quoteOutlook.init({tcol: d.tcol, writeLog: d.writeLog});
  addressEnrichment.init({tcol: d.tcol});
  quoteAccCatalog.init({tcol: d.tcol});
}

/**
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {boolean} True if OPTIONS handled.
 */
function cors(req, res) {
  return deps.applyDashboardCors(req, res);
}

/**
 * Legacy bookmark token access.
 * @param {object} req Request.
 * @return {object|null} {tenant, dispatcherId, token} or null if invalid.
 */
async function resolveLegacyDispatcherAccess(req) {
  const tenant = await deps.resolveDashboardTenant(req);
  const dispatcherId = (req.query && req.query.dispatcherId) ||
    (req.body && req.body.dispatcherId);
  const token = (req.query && req.query.token) ||
    (req.body && req.body.token);
  if (!dispatcherId || !token) return null;
  if (!dispatcherAuth.verifyDispatcherToken(
      String(dispatcherId), tenant.tenantId, String(token))) {
    return null;
  }
  return {tenant, dispatcherId: String(dispatcherId), token: String(token)};
}

/**
 * Resolves signed-in dispatcher (Firebase email/password or legacy token).
 * @param {object} req Request.
 * @return {Promise<object>}
 */
async function resolveDashboardUser(req) {
  const tenant = await deps.resolveDashboardTenant(req);
  const decoded = await quoteFirebaseAuth.verifyBearerToken(req);
  if (decoded && decoded.email) {
    if (!quoteFirebaseAuth.isAllowedEmail(decoded.email)) {
      return {
        ok: false,
        status: 403,
        error: "Use your company email address",
      };
    }
    const dispatcher = await quoteDispatchers.findDispatcherByEmail(
        tenant, decoded.email);
    if (!dispatcher) {
      return {
        ok: false,
        status: 403,
        error: "No dispatcher profile for this email — contact admin",
      };
    }
    return {
      ok: true,
      tenant,
      dispatcher,
      dispatcherId: dispatcher.id,
      email: decoded.email,
      auth: "firebase",
    };
  }
  const legacy = await resolveLegacyDispatcherAccess(req);
  if (legacy) {
    const dispatcher = await quoteDispatchers.getDispatcher(
        tenant, legacy.dispatcherId);
    if (!dispatcher) {
      return {ok: false, status: 403, error: "Dispatcher not found"};
    }
    return {
      ok: true,
      tenant,
      dispatcher,
      dispatcherId: legacy.dispatcherId,
      auth: "token",
    };
  }
  return {ok: false, status: 401, error: "Sign in required"};
}

/**
 * @param {object} req Request.
 * @param {string} quoteId Quote id.
 * @return {Promise<object>}
 */
async function authorizeQuoteAccess(req, quoteId) {
  const user = await resolveDashboardUser(req);
  if (!user.ok) return user;
  if (user.auth === "token") {
    const ok = dispatcherAuth.verifyQuoteAccessToken({
      quoteId: String(quoteId),
      tenantId: user.tenant.tenantId,
      dispatcherId: user.dispatcherId,
      token: (req.query && req.query.token) ||
        (req.body && req.body.token),
    });
    if (!ok) {
      return {ok: false, status: 403, error: "Invalid quote link"};
    }
  }
  const quote = await quoteAutomation.getQuoteRequest(
      user.tenant, String(quoteId));
  if (!quote) {
    return {ok: false, status: 404, error: "Quote not found"};
  }
  if (quote.assignedDispatcherId &&
    quote.assignedDispatcherId !== user.dispatcherId) {
    return {
      ok: false,
      status: 403,
      error: "This quote is assigned to someone else",
    };
  }
  const userEmail = quoteDispatchers.normalizeEmail(
      user.email || user.dispatcher.email);
  const assignedEmail = quoteDispatchers.normalizeEmail(
      quote.assignedDispatcherEmail);
  if (assignedEmail && userEmail && assignedEmail !== userEmail) {
    return {
      ok: false,
      status: 403,
      error: "This quote belongs to another dispatcher mailbox",
    };
  }
  return {...user, quote};
}

/**
 * @param {string} file Basename under functions/static/.
 * @return {string}
 */
function readStaticHtml(file) {
  const p = path.join(__dirname, "static", file);
  return fs.readFileSync(p, "utf8");
}

/**
 * GET quote rules list.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleGetQuoteRules(req, res) {
  if (cors(req, res)) return;
  try {
    const tenant = await deps.resolveDashboardTenant(req);
    const rules = await quoteRules.listAllRules(tenant);
    return res.json({ok: true, tenantId: tenant.tenantId, rules});
  } catch (err) {
    console.error("getQuoteRules:", err);
    return res.status(500).json({ok: false, error: err.message});
  }
}

/**
 * POST apply rule proposal from chatbot confirm.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleApplyQuoteRule(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ok: false, error: "Use POST"});
  }
  try {
    const tenant = await deps.resolveDashboardTenant(req);
    const body = req.body || {};
    const validated = quoteRulesChat.validateRuleProposal(body);
    if (!validated.ok) {
      return res.status(400).json({ok: false, error: validated.error});
    }
    const updatedBy = String(body.updatedBy || "quote-admin");
    if (validated.action === "delete") {
      const ids = Array.isArray(validated.ruleIds) && validated.ruleIds.length ?
        validated.ruleIds : [validated.ruleId];
      for (const id of ids) {
        await quoteRules.deleteRule(tenant, id, updatedBy);
      }
      return res.json({
        ok: true,
        deleted: ids.length === 1 ? ids[0] : ids,
        deletedIds: ids,
      });
    }
    let patch = validated.patch;
    // Preserve existing name/match (and other fields) when chat sends a
    // partial update like { addAccessorials: ["APD"] }.
    const existingRules = await quoteRules.listAllRules(tenant);
    const existing = existingRules.find((r) => r.id === validated.ruleId);
    if (existing) {
      const {id, ...existingRest} = existing;
      patch = {...existingRest, ...patch};
    }
    const rule = await quoteRules.upsertRule(
        tenant, validated.ruleId, patch, updatedBy);
    return res.json({ok: true, rule});
  } catch (err) {
    console.error("applyQuoteRule:", err);
    return res.status(500).json({ok: false, error: err.message});
  }
}

/**
 * POST test address against rules.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleTestQuoteRules(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ok: false, error: "Use POST"});
  }
  try {
    const tenant = await deps.resolveDashboardTenant(req);
    const body = req.body || {};
    const sample = body.sample;
    const classifyAddress = !!body.classifyAddress;
    const lane = {
      consignee: (sample && sample.consignee) || {},
      shipper: (sample && sample.shipper) || {},
      specialInstructions: (sample && sample.specialInstructions) || "",
      flags: (sample && sample.flags) || {},
      siteType: (sample && sample.siteType) || null,
      originSiteType: (sample && sample.originSiteType) || null,
    };

    let enrichment = null;
    let originEnrichment = null;
    if (classifyAddress) {
      try {
        await addressEnrichment.enrichLaneAddresses(lane, tenant, {
          log: (level, cat, msg, data) =>
            console.log(level, cat, msg, data),
        });
        enrichment = lane.enrichmentMeta || null;
        originEnrichment = lane.originEnrichmentMeta || null;
      } catch (err) {
        enrichment = {error: err.message};
      }
    }

    const result = await quoteRules.testAddress(tenant, lane);
    return res.json({
      ok: true,
      result,
      enrichment,
      originEnrichment,
      addressKey: addressEnrichment.normalizeAddressKey(lane.consignee),
      originAddressKey: addressEnrichment.normalizeAddressKey(lane.shipper),
    });
  } catch (err) {
    return res.status(500).json({ok: false, error: err.message});
  }
}

/**
 * POST quote rules chatbot turn.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleQuoteRulesChat(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ok: false, error: "Use POST"});
  }
  try {
    const tenant = await deps.resolveDashboardTenant(req);
    const body = req.body || {};
    const chatTurns = quoteRulesChat.resolveChatTurns(body);
    if (!chatTurns.length) {
      return res.status(400).json({
        ok: false,
        error: "messages or history required (non-empty array)",
      });
    }
    const allRules = await quoteRules.listAllRules(tenant);
    // Chat only sees live rules — inactive / tombstoned-away defaults stay out.
    const existingRules = allRules.filter((r) => r.active !== false);
    const result = await quoteRulesChat.runQuoteRulesChatTurn({
      messages: chatTurns,
      history: chatTurns,
      existingRules,
      pendingProposal: body.pendingProposal || null,
      lastAppliedRule: body.lastAppliedRule || null,
      lastProposedRule: body.lastProposedRule || null,
      lastAppliedRuleId: body.lastAppliedRuleId ||
        (body.lastAppliedRule && body.lastAppliedRule.ruleId) || null,
      referencedRuleId: body.referencedRuleId ||
        (body.lastAppliedRule && body.lastAppliedRule.ruleId) ||
        (body.lastProposedRule && body.lastProposedRule.ruleId) || null,
    });
    // Backfill name/match on update proposals so Confirm never fails
    // with "Proposal needs name or match criteria".
    if (result && result.action === "propose_update_rule" &&
        result.proposal && result.proposal.ruleId) {
      const existing = existingRules.find(
          (r) => r.id === result.proposal.ruleId);
      if (existing) {
        const patch = result.proposal.patch &&
          typeof result.proposal.patch === "object" ?
          {...result.proposal.patch} : {};
        if (!patch.name) patch.name = existing.name;
        if (!patch.match) patch.match = existing.match || {};
        if (!patch.identifyVia) {
          patch.identifyVia = existing.identifyVia || "both";
        }
        result.proposal = {...result.proposal, patch};
      }
    }
    // Normalize delete proposals so UI Confirm always has ruleId.
    if (result && result.action === "propose_delete_rule") {
      const proposal = result.proposal && typeof result.proposal === "object" ?
        {...result.proposal} :
        {};
      const extraIds = Array.isArray(proposal.deleteRuleIds) ?
        proposal.deleteRuleIds : [];
      const id = proposal.deleteRuleId || proposal.ruleId ||
        result.deleteRuleId || result.ruleId || extraIds[0];
      if (id || extraIds.length) {
        proposal.ruleId = proposal.ruleId || id || extraIds[0];
        proposal.deleteRuleId = proposal.deleteRuleId || id || extraIds[0];
        proposal.deleteRuleIds = [...new Set(
            [proposal.deleteRuleId, ...extraIds].filter(Boolean).map(String))];
        result.proposal = proposal;
      }
    }
    // Strip invented success claims from ANY model reply. Only the Confirm
    // button path (applyQuoteRule) may announce an applied change.
    if (result && typeof result.reply === "string") {
      result.reply = scrubFalseApplyClaims(result.reply, result.action);
    }
    return res.json({
      ok: true,
      ...result,
      // Fresh ids so the UI can answer status without another round-trip.
      activeRuleIds: existingRules.map((r) => r.id),
    });
  } catch (err) {
    console.error("quoteRulesChat:", err);
    return res.status(500).json({ok: false, error: err.message});
  }
}

/**
 * Replace model replies that falsely claim a Confirm/apply already happened.
 * @param {string} reply Model reply.
 * @param {string} action Proposed action.
 * @return {string}
 */
function scrubFalseApplyClaims(reply, action) {
  const text = String(reply || "");
  const claimed =
    /confirmed\b|rule removed|successfully (deleted|removed|saved)/i
        .test(text) ||
    /already (deleted|removed)|it's gone|it is gone/i.test(text) ||
    /deletion (was|has been) (processed|confirmed)/i.test(text);
  if (!claimed) return text;
  if (action === "propose_delete_rule") {
    return "Please click the Confirm button to apply this deletion. " +
      "I cannot remove a rule from chat text alone.";
  }
  if (action === "propose_create_rule" || action === "propose_update_rule") {
    return "Please click the Confirm button to apply this change. " +
      "I cannot save a rule from chat text alone.";
  }
  return "No change was applied yet. Click the Confirm button on the " +
    "proposed change, or ask me to propose one. Chat text like " +
    "\"Confirmed\" does not delete or save rules.";
}

/**
 * GET quote admin panel config (for main dashboard button).
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleGetQuoteAdminConfig(req, res) {
  if (cors(req, res)) return;
  try {
    const tenant = await deps.resolveDashboardTenant(req);
    const base = process.env.PUBLIC_FUNCTIONS_BASE_URL ||
      "https://us-central1-tai-invoice-automation.cloudfunctions.net";
    const tenantId = encodeURIComponent(tenant.tenantId);
    return res.json({
      ok: true,
      tenantId: tenant.tenantId,
      quoteAdminUrl: `${base}/quoteAdminPage?tenantId=${tenantId}`,
      quoteRulesChatUrl: `${base}/quoteRulesChat`,
      getQuoteRulesUrl: `${base}/getQuoteRules?tenantId=${tenantId}`,
    });
  } catch (err) {
    return res.status(500).json({ok: false, error: err.message});
  }
}

/**
 * GET list recent quote requests.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleGetQuoteRequests(req, res) {
  if (cors(req, res)) return;
  try {
    const tenant = await deps.resolveDashboardTenant(req);
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const snap = await deps.tcol(tenant, "quoteRequests")
        .orderBy("createdAt", "desc")
        .limit(limit)
        .get();
    const items = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        batchQuoteId: data.batchQuoteId,
        subject: data.subject,
        from: data.from,
        status: data.status,
        laneCount: (data.lanes || []).length,
        createdAt: data.createdAt,
        shippingLocationId: data.shippingLocationId || null,
        shippingLocationName: data.shippingLocationName || null,
      };
    });
    return res.json({ok: true, items});
  } catch (err) {
    return res.status(500).json({ok: false, error: err.message});
  }
}

/**
 * GET quote JSON for dispatcher page.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleGetQuoteDispatcherData(req, res) {
  if (cors(req, res)) return;
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ok: false, error: "id required"});
    const auth = await authorizeQuoteAccess(req, String(id));
    if (!auth.ok) {
      return res.status(auth.status || 401).json({
        ok: false,
        error: auth.error,
      });
    }
    return res.json({
      ok: true,
      quote: quoteOutput.serializeForDispatcherPage(auth.quote),
    });
  } catch (err) {
    return res.status(500).json({ok: false, error: err.message});
  }
}

/**
 * POST save lane rate selection.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleSaveQuoteSelection(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ok: false, error: "Use POST"});
  }
  try {
    const {quoteId, laneKey, rateId, rateIds, selections} = req.body || {};
    if (Array.isArray(selections) && selections.length && quoteId) {
      const auth = await authorizeQuoteAccess(req, String(quoteId));
      if (!auth.ok) {
        return res.status(auth.status || 401).json({
          ok: false,
          error: auth.error,
        });
      }
      const result = await quoteAutomation.saveLaneSelections(
          auth.tenant, String(quoteId), selections);
      return res.json(result);
    }
    if (!quoteId || !laneKey || (!rateId && !rateIds)) {
      return res.status(400).json({
        ok: false,
        error: "quoteId, laneKey, rateId (or rateIds/selections) required",
      });
    }
    const auth = await authorizeQuoteAccess(req, String(quoteId));
    if (!auth.ok) {
      return res.status(auth.status || 401).json({
        ok: false,
        error: auth.error,
      });
    }
    const ids = Array.isArray(rateIds) ? rateIds :
      (rateId ? [rateId] : []);
    const result = await quoteAutomation.saveLaneSelections(
        auth.tenant, String(quoteId), [{laneKey, rateIds: ids}]);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ok: false, error: err.message});
  }
}

/**
 * POST save multi-select rate checkboxes.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleSaveQuoteSelections(req, res) {
  return handleSaveQuoteSelection(req, res);
}

/**
 * POST update quote shipper/consignee/freight/customer details.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleUpdateQuoteDetails(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ok: false, error: "Use POST"});
  }
  try {
    const body = req.body || {};
    const quoteId = body.quoteId;
    if (!quoteId) {
      return res.status(400).json({ok: false, error: "quoteId required"});
    }
    const auth = await authorizeQuoteAccess(req, String(quoteId));
    if (!auth.ok) {
      return res.status(auth.status || 401).json({
        ok: false,
        error: auth.error,
      });
    }
    const result = await quoteAutomation.updateQuoteDetails(
        auth.tenant, String(quoteId), body.details || body);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ok: false, error: err.message});
  }
}

/**
 * POST generate customer email draft from checked rates.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleGenerateQuoteEmail(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ok: false, error: "Use POST"});
  }
  try {
    const body = req.body || {};
    const quoteId = body.quoteId;
    if (!quoteId) {
      return res.status(400).json({ok: false, error: "quoteId required"});
    }
    const auth = await authorizeQuoteAccess(req, String(quoteId));
    if (!auth.ok) {
      return res.status(auth.status || 401).json({
        ok: false,
        error: auth.error,
      });
    }
    const result = await quoteAutomation.generateQuoteEmail(
        auth.tenant, String(quoteId), {
          selections: body.selections,
          style: body.style || "bullet",
          bodyText: body.bodyText,
        });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ok: false, error: err.message});
  }
}

/**
 * POST approve and send customer email via Outlook.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleApproveQuoteEmail(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ok: false, error: "Use POST"});
  }
  try {
    const body = req.body || {};
    const quoteId = body.quoteId;
    if (!quoteId) {
      return res.status(400).json({ok: false, error: "quoteId required"});
    }
    const auth = await authorizeQuoteAccess(req, String(quoteId));
    if (!auth.ok) {
      return res.status(auth.status || 401).json({
        ok: false,
        error: auth.error,
      });
    }
    const result = await quoteAutomation.approveQuoteEmail(
        auth.tenant, String(quoteId), {
          dispatcher: auth.dispatcher,
          bodyText: body.bodyText,
          bodyHtml: body.bodyHtml,
        });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ok: false, error: err.message});
  }
}

/**
 * POST dismiss a quote.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleDismissQuote(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ok: false, error: "Use POST"});
  }
  try {
    let body = req.body || {};
    if (typeof body === "string") {
      try {
        body = JSON.parse(body || "{}");
      } catch (_) {
        body = {};
      }
    }
    const quoteId = body.quoteId || body.id ||
      (req.query && (req.query.quoteId || req.query.id));
    if (!quoteId) {
      return res.status(400).json({ok: false, error: "quoteId required"});
    }
    const auth = await authorizeQuoteAccess(req, String(quoteId));
    if (!auth.ok) {
      return res.status(auth.status || 401).json({
        ok: false,
        error: auth.error,
      });
    }
    const result = await quoteAutomation.dismissQuote(
        auth.tenant, String(quoteId), {
          reason: body.reason,
          dismissedBy: (auth.dispatcher && auth.dispatcher.email) ||
            auth.email || auth.dispatcherId,
        });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ok: false, error: err.message});
  }
}

/**
 * POST re-rate quote with optional accessorial overrides.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleRerunQuoteRates(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ok: false, error: "Use POST"});
  }
  try {
    const body = req.body || {};
    const quoteId = body.quoteId;
    if (!quoteId) {
      return res.status(400).json({ok: false, error: "quoteId required"});
    }
    const auth = await authorizeQuoteAccess(req, String(quoteId));
    if (!auth.ok) {
      return res.status(auth.status || 401).json({
        ok: false,
        error: auth.error,
      });
    }
    const result = await quoteAutomation.rerunQuoteRates(
        auth.tenant, String(quoteId), {
          laneKey: body.laneKey || null,
          accessorials: body.accessorials,
          accessorialsWithData: body.accessorialsWithData,
        });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ok: false, error: err.message});
  }
}

/**
 * GET Primus accessorial catalog for dispatcher re-rate UI
 * (Origin / Destination / Other), with Firestore cache.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleGetQuoteAccessorialCatalog(req, res) {
  if (cors(req, res)) return;
  try {
    const user = await resolveDashboardUser(req);
    if (!user.ok) {
      return res.status(user.status || 401).json({
        ok: false,
        error: user.error,
      });
    }
    const forceRefresh =
      req.query.refresh === "1" || req.query.refresh === "true";
    const catalog = await quoteAccCatalog.getQuoteAccessorialCatalog(
        user.tenant, {forceRefresh});
    return res.json(catalog);
  } catch (err) {
    console.error("getQuoteAccessorialCatalog:", err);
    const fallback = quoteAccCatalog.buildStaticFallbackCatalog();
    return res.json({
      ok: true,
      cached: false,
      fetchError: err.message,
      ...fallback,
    });
  }
}

/**
 * GET dispatcher profile (auth required).
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleGetQuoteDispatcherProfile(req, res) {
  if (cors(req, res)) return;
  try {
    const user = await resolveDashboardUser(req);
    if (!user.ok) {
      return res.status(user.status || 401).json({
        ok: false,
        error: user.error,
      });
    }
    const outlook = await quoteOutlook.getOutlookStatus(
        user.tenant, user.dispatcherId);
    return res.json({
      ok: true,
      dispatcher: {
        id: user.dispatcher.id,
        name: user.dispatcher.name,
        email: user.dispatcher.email,
      },
      outlook,
      auth: user.auth,
    });
  } catch (err) {
    return res.status(500).json({ok: false, error: err.message});
  }
}

/**
 * GET quotes assigned to one dispatcher.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleGetQuoteDispatcherInbox(req, res) {
  if (cors(req, res)) return;
  try {
    const user = await resolveDashboardUser(req);
    if (!user.ok) {
      return res.status(user.status || 401).json({
        ok: false,
        error: user.error,
      });
    }
    const status = req.query.status ? String(req.query.status) : "";
    // Opt-in only: page loads must stay fast (Firestore list). Outlook sync
    // runs on the 20-min scheduler + optional quiet background syncOutlook=1.
    const wantSync =
      req.query.syncOutlook === "1" ||
      req.query.syncOutlook === "true";
    if (wantSync) {
      try {
        const includeRead =
          req.query.includeRead === "1" ||
          req.query.includeRead === "true";
        const forceReprocess =
          req.query.forceReprocess === "1" ||
          req.query.forceReprocess === "true";
        await quoteOutlook.syncDispatcherInbox(
            user.tenant,
            user.dispatcher,
            quoteAutomation.processQuoteEmail,
            {includeRead, forceReprocess});
      } catch (syncErr) {
        console.warn("quote outlook sync:", syncErr.message);
      }
    }
    const listed = await quoteAutomation.listQuotesForDispatcher(
        user.tenant, user.dispatcher, {
          limit: Number(req.query.limit) || 50,
          status: status || undefined,
        });
    const items = Array.isArray(listed) ? listed : (listed.items || []);
    const counts = listed.counts || {
      total: 0,
      pending: 0,
      awaiting: 0,
      draftReady: 0,
      dismissed: 0,
    };
    const base = process.env.PUBLIC_FUNCTIONS_BASE_URL ||
      "https://us-central1-tai-invoice-automation.cloudfunctions.net";
    const enriched = items.map((item) => {
      const openUrl =
        `${base}/quoteDispatcherPage?id=${encodeURIComponent(item.id)}` +
        `&tenantId=${encodeURIComponent(user.tenant.tenantId)}`;
      return {...item, openUrl};
    });
    return res.json({ok: true, items: enriched, counts});
  } catch (err) {
    return res.status(500).json({ok: false, error: err.message});
  }
}

/**
 * GET Firebase sign-in config for quote dashboards.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleGetQuoteAuthConfig(req, res) {
  if (cors(req, res)) return;
  try {
    const tenant = await deps.resolveDashboardTenant(req);
    const firebase = quoteFirebaseAuth.getWebConfig();
    if (!firebase) {
      return res.status(503).json({
        ok: false,
        error: "QUOTE_FIREBASE_WEB_API_KEY not configured",
      });
    }
    return res.json({
      ok: true,
      tenantId: tenant.tenantId,
      firebase,
      allowedDomains: (process.env.QUOTE_AUTH_ALLOWED_DOMAINS ||
        "innovativecarriers.com,advancedautomations.net")
          .split(",").map((s) => s.trim()),
    });
  } catch (err) {
    return res.status(500).json({ok: false, error: err.message});
  }
}

/**
 * POST send password-reset email via Gmail SMTP (no Firebase noreply).
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleSendQuotePasswordReset(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ok: false, error: "Use POST"});
  }
  try {
    const tenant = await deps.resolveDashboardTenant(req);
    const email = (req.body && req.body.email) ||
      (req.query && req.query.email) || "";
    const base = process.env.PUBLIC_FUNCTIONS_BASE_URL ||
      "https://us-central1-tai-invoice-automation.cloudfunctions.net";
    const continueUrl =
      `${base}/quoteDispatcherHomePage?tenantId=` +
      encodeURIComponent(tenant.tenantId);
    await quotePasswordReset.sendQuotePasswordReset(
        tenant, email, continueUrl);
    return res.json({
      ok: true,
      message: "If that email is on the quote roster, a reset link was sent.",
    });
  } catch (err) {
    const status = Number(err && err.status) || 500;
    if (status >= 500) {
      console.error("sendQuotePasswordReset:", err.message || err);
    }
    return res.status(status).json({
      ok: false,
      error: err.message || "Could not send reset email",
    });
  }
}

/**
 * GET Outlook OAuth connect URL (auth required).
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleGetQuoteOutlookConnectUrl(req, res) {
  if (cors(req, res)) return;
  try {
    const user = await resolveDashboardUser(req);
    if (!user.ok) {
      return res.status(user.status || 401).json({
        ok: false,
        error: user.error,
      });
    }
    const url = quoteOutlook.buildConnectUrl(user.tenant, user.dispatcherId);
    return res.json({ok: true, url});
  } catch (err) {
    return res.status(500).json({ok: false, error: err.message});
  }
}

/**
 * POST disconnect dispatcher Outlook (auth required).
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleQuoteOutlookDisconnect(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ok: false, error: "Use POST"});
  }
  try {
    const user = await resolveDashboardUser(req);
    if (!user.ok) {
      return res.status(user.status || 401).json({
        ok: false,
        error: user.error,
      });
    }
    await quoteOutlook.disconnectOutlook(user.tenant, user.dispatcherId);
    return res.json({ok: true});
  } catch (err) {
    return res.status(500).json({ok: false, error: err.message});
  }
}

/**
 * GET OAuth callback for dispatcher Outlook connect.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleQuoteOutlookOAuthCallback(req, res) {
  try {
    const code = req.query.code;
    if (!code) {
      return res.status(400).send("Missing authorization code from Outlook.");
    }
    let parsed = {};
    if (req.query.state) {
      parsed = JSON.parse(
          Buffer.from(String(req.query.state), "base64url").toString("utf8"));
    }
    const getTenant = deps.getTenant;
    if (!getTenant) {
      return res.status(500).send("Server misconfigured: getTenant missing");
    }
    const result = await quoteOutlook.handleOAuthCallback(
        parsed,
        String(code),
        getTenant,
        quoteDispatchers.getDispatcher);
    if (!result.ok) {
      return res.status(400).send(result.error || "Outlook connect failed");
    }
    return res.send(
        "<h2>Outlook connected</h2>" +
        "<p>Mailbox <strong>" + (result.email || "") + "</strong> is linked " +
        "for " + (result.dispatcherName || "dispatcher") + ".</p>" +
        (result.upn && result.upn !== result.email ?
          "<p>Sign-in UPN: <code>" + result.upn + "</code></p>" : "") +
        "<p>You can close this window and return to the quote dashboard.</p>");
  } catch (err) {
    console.error("quoteOutlookOAuthCallback:", err);
    return res.status(500).send(err.message);
  }
}

/**
 * GET list dispatchers + bookmark URLs (ops/admin).
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleGetQuoteDispatchers(req, res) {
  if (cors(req, res)) return;
  try {
    const tenant = await deps.resolveDashboardTenant(req);
    const dispatchers = await quoteDispatchers.listActiveDispatchers(tenant);
    const rows = dispatchers.map((d) => {
      const urls = quoteDispatchers.buildDispatcherUrls(tenant, d, null);
      return {
        id: d.id,
        name: d.name,
        email: d.email,
        active: d.active !== false,
        homeUrl: urls.homeUrl,
      };
    });
    return res.json({ok: true, dispatchers: rows});
  } catch (err) {
    return res.status(500).json({ok: false, error: err.message});
  }
}

/**
 * Serves quote rules admin HTML (opens from dashboard button).
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {void}
 */
function handleQuoteAdminPage(req, res) {
  if (cors(req, res)) return;
  try {
    let html = readStaticHtml("quote-admin.html");
    const tenantId = (req.query && req.query.tenantId) || "default";
    html = html.replace(/__TENANT_ID__/g, String(tenantId));
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Cache-Control", "no-cache");
    return res.status(200).send(html);
  } catch (err) {
    return res.status(500).send(`Admin page error: ${err.message}`);
  }
}

/**
 * Serves dispatcher selection HTML.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {void}
 */
function handleQuoteDispatcherPage(req, res) {
  if (cors(req, res)) return;
  try {
    let html = readStaticHtml("quote-dispatcher.html");
    const tenantId = (req.query && req.query.tenantId) || "default";
    const quoteId = (req.query && req.query.id) || "";
    const dispatcherId = (req.query && req.query.dispatcherId) || "";
    const token = (req.query && req.query.token) || "";
    html = html.replace(/__TENANT_ID__/g, String(tenantId));
    html = html.replace(/__QUOTE_ID__/g, String(quoteId));
    html = html.replace(/__DISPATCHER_ID__/g, String(dispatcherId));
    html = html.replace(/__TOKEN__/g, String(token));
    const apiBase = process.env.PUBLIC_FUNCTIONS_BASE_URL ||
      "https://us-central1-tai-invoice-automation.cloudfunctions.net";
    html = html.replace(/__API_BASE__/g, apiBase);
    html = html.replace(/__AUTH_CLIENT_VERSION__/g, QUOTE_AUTH_CLIENT_VERSION);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Cache-Control", "no-cache");
    return res.status(200).send(html);
  } catch (err) {
    return res.status(500).send(`Dispatcher page error: ${err.message}`);
  }
}

/**
 * Serves per-dispatcher home dashboard.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {void}
 */
function handleQuoteDispatcherHomePage(req, res) {
  if (cors(req, res)) return;
  try {
    let html = readStaticHtml("quote-dispatcher-home.html");
    const tenantId = (req.query && req.query.tenantId) || "default";
    html = html.replace(/__TENANT_ID__/g, String(tenantId));
    const apiBase = process.env.PUBLIC_FUNCTIONS_BASE_URL ||
      "https://us-central1-tai-invoice-automation.cloudfunctions.net";
    html = html.replace(/__API_BASE__/g, apiBase);
    html = html.replace(/__AUTH_CLIENT_VERSION__/g, QUOTE_AUTH_CLIENT_VERSION);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Cache-Control", "no-cache");
    return res.status(200).send(html);
  } catch (err) {
    return res.status(500).send(`Home page error: ${err.message}`);
  }
}

/**
 * Serves shared Firebase auth client JS.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {void}
 */
function handleQuoteAuthClient(req, res) {
  if (cors(req, res)) return;
  try {
    const js = fs.readFileSync(
        path.join(__dirname, "static", "quote-auth-client.js"), "utf8");
    res.set("Content-Type", "application/javascript; charset=utf-8");
    res.set("Cache-Control", "public, max-age=300, must-revalidate");
    return res.status(200).send(js);
  } catch (err) {
    return res.status(500).send(`// ${err.message}`);
  }
}

/**
 * Scheduled sync: every connected dispatcher Outlook inbox.
 * Mirror of Jerry checkMailInbox — Cloud Scheduler hits this every 20 min.
 * Dashboard inbox loads use syncOutlook=0 by default; syncOutlook=1 is opt-in.
 * @param {object} req Request.
 * @param {object} res Response.
 * @return {Promise<void>}
 */
async function handleSyncQuoteOutlookInboxes(req, res) {
  if (cors(req, res)) return;
  try {
    const tenant = await deps.resolveDashboardTenant(req);
    const includeRead =
      req.query.includeRead === "1" ||
      req.query.includeRead === "true";
    const forceReprocess =
      req.query.forceReprocess === "1" ||
      req.query.forceReprocess === "true";
    const syncOpts = {includeRead, forceReprocess};
    const dispatchers = await quoteDispatchers.listActiveDispatchers(tenant);
    const perDispatcher = [];
    let synced = 0;
    let connected = 0;
    let skipped = 0;
    let errors = 0;
    let scanned = 0;

    for (const dispatcher of dispatchers) {
      const status = await quoteOutlook.getOutlookStatus(
          tenant, dispatcher.id);
      if (!status.connected) {
        skipped += 1;
        perDispatcher.push({
          dispatcherId: dispatcher.id,
          name: dispatcher.name || null,
          skipped: "not_connected",
        });
        continue;
      }
      connected += 1;
      try {
        const result = await quoteOutlook.syncDispatcherInbox(
            tenant,
            dispatcher,
            quoteAutomation.processQuoteEmail,
            syncOpts);
        const count = Number(result && result.synced) || 0;
        synced += count;
        scanned += Number(result && result.scanned) || 0;
        perDispatcher.push({
          dispatcherId: dispatcher.id,
          name: dispatcher.name || null,
          email: status.email || null,
          ok: true,
          synced: count,
          scanned: result && result.scanned,
          skippedExisting: result && result.skippedExisting,
          skippedNotQuote: result && result.skippedNotQuote,
          processErrors: result && result.processErrors,
          includeRead: result && result.includeRead,
          skipped: result && result.skipped ? result.skipped : undefined,
        });
      } catch (syncErr) {
        errors += 1;
        console.error(
            `syncQuoteOutlookInboxes ${dispatcher.id}:`,
            syncErr);
        if (deps.writeLog) {
          deps.writeLog("error", "quote",
              "Scheduled Outlook sync failed for dispatcher", {
                tenantId: tenant.tenantId,
                dispatcherId: dispatcher.id,
                error: syncErr.message,
              });
        }
        perDispatcher.push({
          dispatcherId: dispatcher.id,
          name: dispatcher.name || null,
          ok: false,
          error: syncErr.message,
        });
      }
    }

    if (deps.writeLog) {
      deps.writeLog("info", "quote",
          "Scheduled quote Outlook inbox sync complete", {
            tenantId: tenant.tenantId,
            synced,
            connected,
            skipped,
            errors,
            scanned,
            includeRead,
            forceReprocess,
            dispatcherCount: dispatchers.length,
          });
    }

    return res.json({
      ok: true,
      tenantId: tenant.tenantId,
      synced,
      connected,
      skipped,
      errors,
      scanned,
      includeRead,
      forceReprocess,
      perDispatcher,
    });
  } catch (err) {
    console.error("syncQuoteOutlookInboxes:", err);
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
      details: err.message,
    });
  }
}

module.exports = {
  init,
  handleGetQuoteRules,
  handleApplyQuoteRule,
  handleTestQuoteRules,
  handleQuoteRulesChat,
  handleGetQuoteAdminConfig,
  handleGetQuoteRequests,
  handleGetQuoteDispatcherData,
  handleSaveQuoteSelection,
  handleSaveQuoteSelections,
  handleUpdateQuoteDetails,
  handleGenerateQuoteEmail,
  handleApproveQuoteEmail,
  handleDismissQuote,
  handleRerunQuoteRates,
  handleGetQuoteAccessorialCatalog,
  handleGetQuoteDispatcherProfile,
  handleGetQuoteDispatcherInbox,
  handleGetQuoteDispatchers,
  handleGetQuoteAuthConfig,
  handleSendQuotePasswordReset,
  handleGetQuoteOutlookConnectUrl,
  handleQuoteOutlookDisconnect,
  handleQuoteOutlookOAuthCallback,
  handleQuoteAdminPage,
  handleQuoteDispatcherPage,
  handleQuoteDispatcherHomePage,
  handleQuoteAuthClient,
  handleSyncQuoteOutlookInboxes,
};
