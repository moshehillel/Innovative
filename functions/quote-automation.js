/**
 * Quote automation — email RFQ → rate shop → dispatcher + customer draft.
 */

"use strict";

const admin = require("firebase-admin");
const quoteIntake = require("./quote-intake");
const quoteRules = require("./quote-accessorial-rules");
const freightRules = require("./quote-freight-rules");
const addressEnrichment = require("./quote-address-enrichment");
const rateShop = require("./quote-rate-shop");
const quoteOutput = require("./quote-output");
const quoteDispatchers = require("./quote-dispatchers");
const quoteOutlook = require("./quote-outlook");
const quoteAccCatalog = require("./quote-accessorial-catalog");

let deps = {};

/**
 * @param {object} d db, tcol, writeLog, saveOutboundEmail, getPrimusToken.
 * @return {void}
 */
function init(d) {
  deps = d;
  rateShop.init({getPrimusToken: d.getPrimusToken});
  quoteRules.init({tcol: d.tcol});
  quoteDispatchers.init({tcol: d.tcol});
  addressEnrichment.init({tcol: d.tcol});
  quoteAccCatalog.init({tcol: d.tcol});
}

/**
 * @param {object} tenant Tenant.
 * @param {string} name Collection.
 * @return {FirebaseFirestore.CollectionReference}
 */
function col(tenant, name) {
  return deps.tcol(tenant, name);
}

/**
 * Resolves Primus customer match from sender email domain / customer name.
 * @param {object} opts from, customerRef.
 * @return {Promise<object>} `{id, name}` — id may be null.
 */
async function resolveCustomerMatch(opts) {
  const ref = String(opts.customerRef || "");
  const searchTerms = [];
  if (/menards/i.test(ref)) searchTerms.push("menards");
  if (/sleeptone|sanders/i.test(ref + opts.from)) {
    searchTerms.push("sanders", "sleeptone");
  }
  if (/ruelily/i.test(ref + opts.from)) searchTerms.push("ruelily");
  if (/ctadigital|petra/i.test(ref + opts.from)) {
    searchTerms.push("ctadigital", "petra");
  }
  if (/coreforce|isnetusa|lifeworks/i.test(ref + opts.from)) {
    searchTerms.push("coreforce", "lifeworks");
  }

  const match = await rateShop.resolveCustomerForQuote({
    from: opts.from,
    customerRef: opts.customerRef,
    searchTerms,
  });
  if (match && match.id) {
    return {
      id: String(match.id),
      name: match.name || null,
    };
  }
  const fallback = process.env.QUOTE_DEFAULT_SHIPPING_LOCATION_ID || null;
  return {id: fallback, name: null};
}

/**
 * Resolves shipping location id from sender email domain / customer name.
 * @param {object} opts from, customerRef.
 * @return {Promise<string|null>}
 */
async function resolveShippingLocationId(opts) {
  const match = await resolveCustomerMatch(opts);
  return match.id || null;
}

/**
 * Parses dispatcher customerPrices map from a selection payload.
 * @param {object} sel Selection row.
 * @return {Map<string, number>}
 */
function parseCustomerPrices(sel) {
  const out = new Map();
  if (!sel || typeof sel !== "object") return out;
  const raw = sel.customerPrices || sel.customerRateOverrides || null;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [rateId, value] of Object.entries(raw)) {
      const n = Number(value);
      if (rateId && Number.isFinite(n)) out.set(String(rateId), n);
    }
  }
  if (Array.isArray(sel.rates)) {
    for (const row of sel.rates) {
      if (!row || row.rateId == null) continue;
      const n = Number(row.customerPrice != null ?
        row.customerPrice : row.sellRate);
      if (Number.isFinite(n)) out.set(String(row.rateId), n);
    }
  }
  return out;
}

/**
 * Ensures every checked rate has a customer rate &gt; 0.
 * @param {Array<object>} lanes Quote lanes after selection save.
 * @return {void}
 */
function assertSelectedCustomerRates(lanes) {
  for (const lane of lanes || []) {
    const selected = quoteOutput.resolveSelectedOptions(lane);
    for (const opt of selected) {
      const rate = quoteOutput.effectiveCustomerRate(opt);
      if (!(Number(rate) > 0)) {
        const name = opt.name || opt.SCAC || opt.id || "rate";
        throw new Error(
            `Customer rate required for ${name} ` +
            `(lane ${lane.label || lane.laneKey}). ` +
            "Set a customer rate greater than 0 before generating.");
      }
    }
  }
}

/**
 * Rates one lane and returns top options with sell rates.
 * @param {object} lane Lane with shipper, consignee, freightInfo.
 * @param {object} ctx Context with rules, shippingLocationId, margin opts.
 * @return {Promise<object>}
 */
async function rateLane(lane, ctx) {
  let rulesOut;
  if (Array.isArray(ctx.accessorialOverride)) {
    const codes = quoteAccCatalog.normalizeRerunAccessorialCodes(
        ctx.accessorialOverride);
    const withData = Array.isArray(ctx.accessorialsWithDataOverride) ?
      ctx.accessorialsWithDataOverride :
      codes.map((code) => ({code}));
    rulesOut = {
      accessorials: codes,
      accessorialsWithData: withData,
      appliedRules: [{
        ruleId: "manual_override",
        name: "Dispatcher override",
        notes: "Manually selected accessorials for re-rate",
        matchVia: "manual",
      }],
      filterCarrierWarnings: [],
      requiresConfirm: false,
    };
  } else {
    rulesOut = quoteRules.applyRulesToLane(
        lane, ctx.rules, ctx.extracted || {});
  }
  const mergedLane = {
    ...lane,
    accessorials: rulesOut.accessorials,
    accessorialsWithData: rulesOut.accessorialsWithData,
    appliedRules: rulesOut.appliedRules,
    requiresConfirm: rulesOut.requiresConfirm,
  };

  const wantsGuaranteed = !!(
    ctx.extracted &&
    ctx.extracted.customerRequest &&
    ctx.extracted.customerRequest.wantsGuaranteedOptions
  );

  const query = rateShop.buildRateMultipleQuery(mergedLane, {
    shippingLocationId: ctx.shippingLocationId,
    customerId: ctx.shippingLocationId,
    UOM: "US",
    pickupDate: ctx.extracted && ctx.extracted.readyDate,
    includeGuaranteed: wantsGuaranteed,
    returnValidAccsOnly: process.env.QUOTE_RETURN_VALID_ACCS_ONLY === "true",
    timeout: process.env.QUOTE_RATE_TIMEOUT || undefined,
  });

  const {rates} = await rateShop.fetchMultipleRates(query);
  const filtered = rateShop.filterBlockedCarriers(
      rates, rulesOut.filterCarrierWarnings);

  const marginOpts = {
    marginPercent: Number(process.env.QUOTE_MARGIN_PERCENT) || null,
    marginMinDollars: Number(process.env.QUOTE_MARGIN_MIN_DOLLARS) || 10,
  };

  const enriched = filtered.map((r) => {
    const billToTotal = r.billTo && r.billTo.total;
    const sellRate = rateShop.computeSellRate(r.total, {
      billToTotal,
      ...marginOpts,
    });
    return {...r, sellRate};
  });

  const tagged = rateShop.tagRateOptions(enriched, ctx.customerPrefs || {});
  const topN = Number(process.env.QUOTE_TOP_RATES) || 20;
  const options = rateShop.pickTopOptions(tagged, topN, {
    ensureGuaranteed: wantsGuaranteed,
    mode: "cheapest",
  });

  const freightApplied = Array.isArray(lane.freightRulesApplied) ?
    lane.freightRulesApplied : [];

  return {
    ...mergedLane,
    appliedRules: [...freightApplied, ...(mergedLane.appliedRules || [])],
    options,
    rateError: null,
  };
}

/**
 * Main handler for a classified quote_request email.
 * @param {object} opts messageId, subject, from, emailBody, tenant.
 * @return {Promise<object>}
 */
async function processQuoteEmail(opts) {
  const tenant = opts.tenant;
  const messageId = opts.messageId;
  const subject = opts.subject || "";
  const from = opts.from || "";
  const emailBody = opts.emailBody || "";

  await deps.writeLog("info", "quote", "Processing quote request email", {
    messageId, subject, from,
  });

  let extracted = await quoteIntake.extractQuoteRequest({
    subject, from, body: emailBody,
  });

  if (!extracted.lanes || !extracted.lanes.length) {
    return {
      handled: false,
      status: "not_a_quote",
      reason: extracted.error || "No lanes extracted",
    };
  }

  // Built-in freight rules: combine same-OD ≤26 PLT, then split >26 PLT.
  extracted = freightRules.applyFreightRules(extracted);

  const batchQuoteId = quoteOutput.generateBatchQuoteId(
      process.env.QUOTE_BATCH_PREFIX || "D");
  const customerMatch = await resolveCustomerMatch({
    from, customerRef: extracted.customerRef,
  });
  const shippingLocationId = customerMatch.id || null;
  const shippingLocationName = customerMatch.name || null;
  const rules = await quoteRules.loadActiveRules(tenant);

  const enrichLog = (level, category, message, data) =>
    deps.writeLog(level, category, message, data);

  for (const lane of extracted.lanes) {
    try {
      await addressEnrichment.enrichLaneConsignee(lane, tenant, {
        log: enrichLog,
      });
    } catch (err) {
      await deps.writeLog("warn", "quote", "Address enrichment failed", {
        laneKey: lane.laneKey,
        error: err.message,
      });
    }
  }

  const shipper = extracted.shipper || {};
  const ratedLanes = [];
  for (const lane of extracted.lanes) {
    try {
      const rated = await rateLane({
        ...lane,
        shipper: lane.shipper || shipper,
      }, {
        rules,
        shippingLocationId,
        extracted,
        customerPrefs: {},
      });
      ratedLanes.push(rated);
    } catch (err) {
      ratedLanes.push({
        ...lane,
        shipper: lane.shipper || shipper,
        options: [],
        rateError: err.message,
        appliedRules: Array.isArray(lane.freightRulesApplied) ?
          lane.freightRulesApplied : [],
      });
    }
  }

  const quoteDoc = {
    gmailMessageId: messageId,
    outlookMessageId: opts.outlookMessageId || null,
    tenantId: tenant.tenantId,
    subject,
    from,
    customerRef: extracted.customerRef || subject,
    batchQuoteId,
    format: extracted.format,
    readyDate: extracted.readyDate,
    shipper: extracted.shipper,
    specialInstructionsGlobal: extracted.specialInstructionsGlobal || "",
    shippingLocationId,
    shippingLocationName,
    lanes: ratedLanes,
    customerDraftText: "",
    status: "awaiting_dispatcher",
    extracted,
    receivedMailboxEmail: opts.receivedMailboxEmail || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  quoteDoc.customerDraftText = quoteOutput.buildCustomerDraftText(quoteDoc);

  const assigned = opts.assignedDispatcher ||
    await quoteDispatchers.assignNextDispatcher(tenant);
  const assignedDispatcher = assigned || {
    id: "qd",
    name: "Quote Desk",
    email: process.env.QUOTE_DISPATCHER_EMAIL || "qd@innovativecarriers.com",
  };
  quoteDoc.assignedDispatcherId = assignedDispatcher.id;
  quoteDoc.assignedDispatcherName = assignedDispatcher.name;
  quoteDoc.assignedDispatcherEmail = assignedDispatcher.email;

  const ref = await col(tenant, "quoteRequests").add(quoteDoc);
  const quoteId = ref.id;

  const quoteUrls = quoteDispatchers.buildDispatcherUrls(
      tenant, assignedDispatcher, quoteId);
  const dispatcherUrl = quoteUrls.quoteUrl;
  const homeUrl = quoteUrls.homeUrl;

  await ref.update({
    assignedDispatcherId: assignedDispatcher.id,
    assignedDispatcherName: assignedDispatcher.name,
    assignedDispatcherEmail: assignedDispatcher.email,
    dispatcherHomeUrl: homeUrl,
    dispatcherQuoteUrl: dispatcherUrl,
  });

  await col(tenant, "emailIntake").doc(messageId).set({
    gmailMessageId: messageId,
    tenantId: tenant.tenantId,
    subject,
    from,
    finalStatus: "quote_processed",
    quoteId,
    batchQuoteId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});

  await deps.writeLog("info", "quote", "Quote request processed", {
    messageId, quoteId, batchQuoteId, laneCount: ratedLanes.length,
  });

  return {
    handled: true,
    status: "quote_processed",
    quoteId,
    batchQuoteId,
    dispatcherUrl,
    homeUrl,
    assignedDispatcherId: assignedDispatcher.id,
  };
}

/**
 * @param {string|null|undefined} status Quote status.
 * @return {string}
 */
function normalizeQuoteStatus(status) {
  return String(status || "").toLowerCase().trim();
}

/**
 * Dismissed quotes must never appear as pending work.
 * @param {object} row Quote doc or inbox item.
 * @return {boolean}
 */
function isDismissedQuote(row) {
  if (!row) return false;
  if (normalizeQuoteStatus(row.status) === "dismissed") return true;
  return !!row.dismissedAt;
}

/**
 * Pending = still needs dispatcher action. Never includes dismissed.
 * @param {object} row Quote doc or inbox item.
 * @return {boolean}
 */
function isPendingQuote(row) {
  if (isDismissedQuote(row)) return false;
  const status = normalizeQuoteStatus(row && row.status);
  return status === "awaiting_dispatcher" || status === "draft_ready";
}

/**
 * @param {object} row Quote doc.
 * @param {string} [statusFilter] pending | dismissed | exact status.
 * @return {boolean}
 */
function matchesInboxStatus(row, statusFilter) {
  const want = normalizeQuoteStatus(statusFilter);
  if (!want) return !isDismissedQuote(row);
  if (want === "dismissed") return isDismissedQuote(row);
  if (want === "pending") return isPendingQuote(row);
  if (isDismissedQuote(row)) return false;
  return normalizeQuoteStatus(row.status) === want;
}

/**
 * @param {object} doc Quote firestore doc.
 * @param {object} data Quote fields.
 * @return {object}
 */
function serializeInboxQuote(doc, data) {
  return {
    id: doc.id,
    batchQuoteId: data.batchQuoteId,
    subject: data.subject,
    from: data.from,
    status: data.status,
    dismissedAt: data.dismissedAt || null,
    laneCount: (data.lanes || []).length,
    createdAt: data.createdAt,
    assignedDispatcherEmail: data.assignedDispatcherEmail,
    receivedMailboxEmail: data.receivedMailboxEmail,
    dispatcherQuoteUrl: data.dispatcherQuoteUrl,
    lanesPreview: (data.lanes || []).map((lane) => ({
      laneKey: lane.laneKey,
      label: lane.label,
      accessorials: lane.accessorials || [],
      appliedRules: (lane.appliedRules || []).map((r) => ({
        name: r.name,
        notes: r.notes || null,
      })),
      topOptions: (lane.options || []).slice(0, 5).map((o) => ({
        rateId: o.id,
        name: o.name,
        SCAC: o.SCAC,
        sellRate: o.sellRate,
        transitDays: o.transitDays,
      })),
      optionCount: (lane.options || []).length,
      rateError: lane.rateError || null,
    })),
  };
}

/**
 * Lists quotes for one dispatcher inbox (matched by id + email).
 * Dismissed quotes are excluded unless status=dismissed. Pending means
 * awaiting_dispatcher or draft_ready — never dismissed.
 * @param {object} tenant Tenant.
 * @param {object} dispatcher Dispatcher row (id + email).
 * @param {object} [opts] limit, status (pending|dismissed|exact).
 * @return {Promise<{items: Array<object>, counts: object}>}
 */
async function listQuotesForDispatcher(tenant, dispatcher, opts = {}) {
  const limit = Math.min(Number(opts.limit) || 50, 100);
  const dispatcherId = String(dispatcher.id || dispatcher);
  const dispatcherEmail = quoteDispatchers.normalizeEmail(
      dispatcher.email || "");
  const snap = await col(tenant, "quoteRequests")
      .orderBy("createdAt", "desc")
      .limit(limit * 5)
      .get();
  const items = [];
  let pendingCount = 0;
  let totalCount = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.assignedDispatcherId !== dispatcherId) continue;
    if (dispatcherEmail && data.assignedDispatcherEmail &&
      quoteDispatchers.normalizeEmail(data.assignedDispatcherEmail) !==
      dispatcherEmail) {
      continue;
    }
    if (!isDismissedQuote(data)) {
      totalCount += 1;
      if (isPendingQuote(data)) pendingCount += 1;
    }
    if (!matchesInboxStatus(data, opts.status)) continue;
    if (items.length >= limit) continue;
    items.push(serializeInboxQuote(doc, data));
  }
  return {
    items,
    counts: {pending: pendingCount, total: totalCount},
  };
}

/**
 * Saves selected rate for a lane (dispatcher action — single rate, legacy).
 * @param {object} tenant Tenant.
 * @param {string} quoteId Quote doc id.
 * @param {string} laneKey Lane key.
 * @param {string} rateId Primus rate id.
 * @return {Promise<object>}
 */
async function saveLaneSelection(tenant, quoteId, laneKey, rateId) {
  return saveLaneSelections(tenant, quoteId, [{
    laneKey,
    rateIds: rateId ? [rateId] : [],
  }]);
}

/**
 * Saves multi-select rate ids per lane (and optional customer price overrides).
 * @param {object} tenant Tenant.
 * @param {string} quoteId Quote doc id.
 * @param {Array<object>} selections [{laneKey, rateIds, customerPrices?}].
 * @return {Promise<object>}
 */
async function saveLaneSelections(tenant, quoteId, selections) {
  const ref = col(tenant, "quoteRequests").doc(quoteId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Quote not found");
  const data = snap.data();
  const byLane = new Map();
  for (const sel of selections || []) {
    if (!sel || !sel.laneKey) continue;
    const ids = Array.isArray(sel.rateIds) ?
      sel.rateIds.map(String).filter(Boolean) :
      (sel.rateId ? [String(sel.rateId)] : []);
    byLane.set(String(sel.laneKey), {
      rateIds: [...new Set(ids)],
      customerPrices: parseCustomerPrices(sel),
    });
  }

  const lanes = (data.lanes || []).map((lane) => {
    if (!byLane.has(lane.laneKey)) return lane;
    const {rateIds, customerPrices} = byLane.get(lane.laneKey);
    const options = (lane.options || []).map((o) => {
      const key = String(o.id);
      if (!customerPrices.has(key)) return o;
      return {...o, customerPrice: customerPrices.get(key)};
    });
    const selectedOptions = options.filter((o) =>
      rateIds.includes(String(o.id)));
    return {
      ...lane,
      options,
      selectedRateIds: rateIds,
      selectedRateId: rateIds[0] || null,
      selectedOptions,
      selectedOption: selectedOptions[0] || null,
    };
  });

  await ref.update({
    lanes,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return {ok: true, lanes: lanes.map((l) => ({
    laneKey: l.laneKey,
    selectedRateIds: l.selectedRateIds || [],
  }))};
}

/**
 * Builds and stores customer email draft from checked rates.
 * @param {object} tenant Tenant.
 * @param {string} quoteId Quote id.
 * @param {object} [opts] style, bodyText override.
 * @return {Promise<object>}
 */
async function generateQuoteEmail(tenant, quoteId, opts = {}) {
  const ref = col(tenant, "quoteRequests").doc(quoteId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Quote not found");
  const quote = {id: snap.id, ...snap.data()};
  if (isDismissedQuote(quote)) {
    throw new Error("Quote was dismissed");
  }

  if (Array.isArray(opts.selections) && opts.selections.length) {
    await saveLaneSelections(tenant, quoteId, opts.selections);
    const fresh = await ref.get();
    Object.assign(quote, fresh.data());
  }

  assertSelectedCustomerRates(quote.lanes);

  const style = opts.style || "bullet";
  const text = opts.bodyText != null ?
    String(opts.bodyText) :
    quoteOutput.buildCustomerEmailFromSelections(quote, {style});
  const html = quoteOutput.textToEmailHtml(text);

  await ref.update({
    customerEmailText: text,
    customerEmailHtml: html,
    customerDraftText: text,
    emailStyle: style,
    status: "draft_ready",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {ok: true, text, html, status: "draft_ready"};
}

/**
 * Marks quote dismissed.
 * @param {object} tenant Tenant.
 * @param {string} quoteId Quote id.
 * @param {object} [opts] reason, dismissedBy.
 * @return {Promise<object>}
 */
async function dismissQuote(tenant, quoteId, opts = {}) {
  const ref = col(tenant, "quoteRequests").doc(quoteId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Quote not found");
  await ref.update({
    status: "dismissed",
    dismissedAt: admin.firestore.FieldValue.serverTimestamp(),
    dismissedBy: opts.dismissedBy || null,
    dismissReason: opts.reason || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return {ok: true, status: "dismissed"};
}

/**
 * Re-rates one or all lanes with optional accessorial override.
 * @param {object} tenant Tenant.
 * @param {string} quoteId Quote id.
 * @param {object} opts laneKey?, accessorials[].
 * @return {Promise<object>}
 */
async function rerunQuoteRates(tenant, quoteId, opts = {}) {
  const ref = col(tenant, "quoteRequests").doc(quoteId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Quote not found");
  const data = snap.data();
  if (isDismissedQuote(data)) {
    throw new Error("Quote was dismissed");
  }
  const rules = await quoteRules.loadActiveRules(tenant);
  const accessorialOverride = opts.accessorials != null ?
    quoteAccCatalog.normalizeRerunAccessorialCodes(opts.accessorials) :
    null;
  const accessorialsWithDataOverride =
    Array.isArray(opts.accessorialsWithData) ?
      opts.accessorialsWithData : null;
  const targetKey = opts.laneKey ? String(opts.laneKey) : null;

  const ratedLanes = [];
  for (const lane of data.lanes || []) {
    if (targetKey && lane.laneKey !== targetKey) {
      ratedLanes.push(lane);
      continue;
    }
    try {
      const rated = await rateLane({
        ...lane,
        shipper: lane.shipper || data.shipper,
      }, {
        rules,
        shippingLocationId: data.shippingLocationId,
        extracted: data.extracted || {},
        customerPrefs: {},
        accessorialOverride: accessorialOverride != null ?
          accessorialOverride : undefined,
        accessorialsWithDataOverride:
          accessorialsWithDataOverride != null ?
            accessorialsWithDataOverride : undefined,
      });
      ratedLanes.push({
        ...rated,
        options: rated.options || [],
        rateError: rated.rateError || null,
        // Clear prior dispatcher picks after a fresh rate pull.
        selectedRateIds: [],
        selectedOptions: [],
        selectedRateId: null,
        selectedOption: null,
      });
    } catch (err) {
      ratedLanes.push({
        ...lane,
        options: [],
        rateError: err.message,
        selectedRateIds: [],
        selectedOptions: [],
        selectedRateId: null,
        selectedOption: null,
      });
    }
  }

  const patch = {
    lanes: ratedLanes,
    status: "awaiting_dispatcher",
    customerEmailText: admin.firestore.FieldValue.delete(),
    customerEmailHtml: admin.firestore.FieldValue.delete(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (accessorialOverride != null) {
    patch.lastAccessorialOverride = accessorialOverride;
  }
  await ref.update(patch);

  const quote = {id: quoteId, ...data, lanes: ratedLanes};
  return {
    ok: true,
    quote: quoteOutput.serializeForDispatcherPage(quote),
  };
}

/**
 * Approves and sends customer email via dispatcher Outlook.
 * @param {object} tenant Tenant.
 * @param {string} quoteId Quote id.
 * @param {object} opts dispatcher, bodyText?, bodyHtml?.
 * @return {Promise<object>}
 */
async function approveQuoteEmail(tenant, quoteId, opts = {}) {
  const ref = col(tenant, "quoteRequests").doc(quoteId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Quote not found");
  const quote = {id: snap.id, ...snap.data()};
  if (isDismissedQuote(quote)) {
    throw new Error("Quote was dismissed");
  }
  const dispatcher = opts.dispatcher;
  if (!dispatcher || !dispatcher.id) {
    throw new Error("Dispatcher required to send email");
  }

  let text = opts.bodyText != null ?
    String(opts.bodyText) :
    (quote.customerEmailText || quote.customerDraftText || "");
  if (!text.trim()) {
    text = quoteOutput.buildCustomerEmailFromSelections(quote, {
      style: quote.emailStyle || "bullet",
    });
  }
  const html = opts.bodyHtml != null ?
    String(opts.bodyHtml) :
    quoteOutput.textToEmailHtml(text);

  const selectedOptions = (quote.lanes || []).map((lane) => ({
    laneKey: lane.laneKey,
    label: lane.label,
    selectedRateIds: lane.selectedRateIds ||
      (lane.selectedRateId ? [lane.selectedRateId] : []),
    options: (lane.selectedOptions || []).map((o) => ({
      rateId: o.id,
      name: o.name,
      sellRate: o.sellRate,
      customerPrice: quoteOutput.effectiveCustomerRate(o),
      quoteNumber: o.quoteNumber,
      transitDays: o.transitDays,
    })),
  }));

  const sendResult = await quoteOutlook.sendQuoteReply(tenant, dispatcher, {
    to: quote.from,
    subject: quote.subject,
    bodyText: text,
    bodyHtml: html,
    outlookMessageId: quote.outlookMessageId || null,
  });

  await ref.update({
    customerEmailText: text,
    customerEmailHtml: html,
    customerDraftText: text,
    status: "sent",
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
    sentBy: {
      id: dispatcher.id,
      name: dispatcher.name || null,
      email: dispatcher.email || null,
    },
    selectedOptionsSnapshot: selectedOptions,
    sendResult: {
      to: sendResult.to,
      subject: sendResult.subject,
      fromMailbox: sendResult.fromMailbox || null,
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    ok: true,
    status: "sent",
    to: sendResult.to,
    subject: sendResult.subject,
  };
}

/**
 * @param {object} tenant Tenant.
 * @param {string} quoteId Doc id.
 * @return {Promise<object|null>}
 */
async function getQuoteRequest(tenant, quoteId) {
  const snap = await col(tenant, "quoteRequests").doc(quoteId).get();
  if (!snap.exists) return null;
  return {id: snap.id, ...snap.data()};
}

module.exports = {
  init,
  processQuoteEmail,
  saveLaneSelection,
  saveLaneSelections,
  generateQuoteEmail,
  approveQuoteEmail,
  dismissQuote,
  rerunQuoteRates,
  getQuoteRequest,
  listQuotesForDispatcher,
  isDismissedQuote,
  isPendingQuote,
  resolveShippingLocationId,
  resolveCustomerMatch,
  rateLane,
  freightRules,
};
