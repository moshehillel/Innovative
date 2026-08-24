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
const quoteEmailAcc = require("./quote-email-accessorials");
const freightDims = require("./quote-freight-dims");
const senderRules = require("./quote-sender-rules");

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
 * @param {object} opts from, customerRef, customerName, allowDefault?,
 *   quoteRules?.
 * @return {Promise<object>} `{id, name, code?, searchTerm?}` — id may be null.
 */
async function resolveCustomerMatch(opts) {
  const senderRule = senderRules.resolveSenderRule(
      opts.from || "", opts.quoteRules || [], {
        cc: opts.cc,
        to: opts.to,
      });
  const ref = String(opts.customerRef || "");
  const customerName = String(
      (senderRule && senderRule.customerName) ||
      opts.customerName || opts.shippingLocationName || "").trim();
  const shipperName = String(opts.shipperName || "").trim();
  const hay = `${ref} ${customerName} ${shipperName} ${opts.from || ""}`;
  const searchTerms = [];
  if (customerName) searchTerms.push(customerName);
  if (shipperName && shipperName.toLowerCase() !== customerName.toLowerCase()) {
    searchTerms.push(shipperName);
  }
  const refHead = ref.split(/[/|,]/)[0].trim();
  if (refHead.length > 2 && !/^\d+$/.test(refHead) &&
      refHead.toLowerCase() !== customerName.toLowerCase() &&
      refHead.toLowerCase() !== shipperName.toLowerCase()) {
    searchTerms.push(refHead);
  }
  if (/menards/i.test(hay)) searchTerms.push("menards");
  if (/sleeptone|sanders/i.test(hay)) {
    searchTerms.push("sanders", "sleeptone");
  }
  if (/ruelily/i.test(hay)) searchTerms.push("ruelily");
  if (/ctadigital|petra/i.test(hay)) {
    searchTerms.push("ctadigital", "petra");
  }
  if (/coreforce|isnetusa|lifeworks/i.test(hay)) {
    searchTerms.push("coreforce", "lifeworks");
  }
  // Sender rule customer name is authoritative — search it first.
  // protocolOnly: match only that customer (no shipper/ref heuristics).
  if (senderRule && senderRule.customerName) {
    const forced = String(senderRule.customerName).trim();
    if (senderRule.protocolOnly) {
      searchTerms.length = 0;
      searchTerms.push(forced);
    } else {
      const rest = searchTerms.filter((t) =>
        String(t).trim().toLowerCase() !== forced.toLowerCase());
      searchTerms.length = 0;
      searchTerms.push(forced, ...rest);
    }
  }

  const match = await rateShop.resolveCustomerForQuote({
    from: opts.from,
    customerRef: opts.customerRef,
    customerName: customerName || shipperName,
    searchTerms,
  });

  /**
   * Fill Primus location name when search returned an id only.
   * @param {object} row Match or fallback.
   * @param {string} status matched|default|no_match.
   * @return {Promise<object>}
   */
  async function withName(row, status) {
    const id = row && row.id ? String(row.id) : null;
    let name = (row && row.name) || null;
    if (id && !name) {
      try {
        const loc = await rateShop.getShippingLocationById(id);
        if (loc && loc.name) name = loc.name;
      } catch (_) {
        // keep id without name
      }
    }
    return {
      id,
      name,
      code: (row && row.code) || null,
      searchTerm: (row && row.searchTerm) || null,
      searchesTried: (row && row.searchesTried) || [],
      lookupStatus: status,
    };
  }

  if (typeof deps.writeLog === "function") {
    await deps.writeLog("info", "quote", "Primus customer lookup", {
      queries: (match && match.searchesTried) || searchTerms,
      matchId: (match && match.id) || null,
      matchName: (match && match.name) || null,
      searchTerm: (match && match.searchTerm) || null,
    });
  }

  if (match && match.id) {
    return withName(match, "matched");
  }
  if (opts.allowDefault === false) {
    return {
      id: null,
      name: null,
      lookupStatus: "no_match",
      searchesTried: (match && match.searchesTried) || [],
    };
  }
  const fallback = process.env.QUOTE_DEFAULT_SHIPPING_LOCATION_ID || null;
  if (fallback) {
    return withName({
      id: fallback,
      name: null,
      searchesTried: (match && match.searchesTried) || [],
    }, "default");
  }
  return {
    id: null,
    name: null,
    lookupStatus: "no_match",
    searchesTried: (match && match.searchesTried) || [],
  };
}

/**
 * Looks up Primus customer for dispatcher-edited quote details.
 * Keeps prior shippingLocationId when search fails.
 * @param {object} data Existing quote doc.
 * @param {object} patch Pending update patch (mutated).
 * @param {object} [opts] forceLookup?.
 * @return {Promise<object>} `{customerMatch, customerMatchMessage}`.
 */
async function applyCustomerLookupToPatch(data, patch, opts = {}) {
  const customerName = String(
      patch.shippingLocationName != null ?
        patch.shippingLocationName :
        (data.shippingLocationName || "")).trim();
  const customerRef = String(
      patch.customerRef != null ? patch.customerRef :
        (data.customerRef || "")).trim();
  const shipperName = String(
      (patch.shipper && patch.shipper.name) ||
      (data.shipper && data.shipper.name) || "").trim();
  const hasLookupSignal = !!(customerName || customerRef || shipperName ||
    data.from || data.senderFrom || opts.from || opts.emailBody);
  if (!hasLookupSignal) {
    return {customerMatch: null, customerMatchMessage: null};
  }

  const senderFrom = senderRules.resolveQuoteSenderFrom(
      opts.from || data.senderFrom || data.from || "",
      opts.emailBody ||
        (data.extracted && data.extracted._sourceBody) || "");

  const match = await resolveCustomerMatch({
    from: senderFrom,
    customerRef,
    customerName: customerName || shipperName,
    shipperName,
    allowDefault: false,
    quoteRules: opts.quoteRules || [],
    cc: opts.cc != null ? opts.cc : data.cc,
    to: opts.to != null ? opts.to : data.to,
  });

  if (match && match.id) {
    patch.shippingLocationId = String(match.id);
    if (match.name) patch.shippingLocationName = match.name;
    patch.customerLookupStatus = "matched";
    patch.customerLookupQuery = customerName || shipperName ||
      customerRef || null;
    patch.customerLookupQueries = match.searchesTried || [];
    const customerMatch = {
      id: String(match.id),
      name: match.name || null,
      code: match.code || null,
    };
    return {customerMatch, customerMatchMessage: null};
  }

  // Keep previous shippingLocationId; surface failed name lookup.
  patch.customerLookupStatus = "no_match";
  patch.customerLookupQuery = customerName || shipperName ||
    customerRef || null;
  patch.customerLookupQueries = (match && match.searchesTried) || [];
  return {
    customerMatch: null,
    customerMatchMessage: "No Primus match for name",
  };
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
 * Normalizes an address party from dispatcher edits.
 * @param {object|null|undefined} party Raw party.
 * @return {object|null}
 */
function normalizeAddressParty(party) {
  if (!party || typeof party !== "object") return null;
  const zip = party.zipCode != null ? party.zipCode :
    (party.zip != null ? party.zip : party.zipcode);
  const out = {
    name: party.name != null ? String(party.name).trim() : "",
    address1: party.address1 != null ? String(party.address1).trim() : "",
    address2: party.address2 != null ? String(party.address2).trim() : "",
    city: party.city != null ? String(party.city).trim() : "",
    state: party.state != null ? String(party.state).trim() : "",
    zipCode: zip != null ? String(zip).trim() : "",
    country: party.country != null ? String(party.country).trim() : "",
    phone: party.phone != null ? String(party.phone).trim() : "",
  };
  const hasAny = Object.values(out).some((v) => v);
  return hasAny ? out : null;
}

/**
 * Normalizes freight rows from dispatcher edits.
 * @param {Array<object>|null|undefined} rows Freight lines.
 * @param {object} [dimOpts] Sender defaultDims.
 * @return {Array<object>}
 */
function normalizeFreightRows(rows, dimOpts = {}) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const r = row && typeof row === "object" ? row : {};
    const numOrNull = (v) => {
      if (v == null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const weightTypeRaw = String(r.weightType || "").trim().toLowerCase();
    const weightType =
      (weightTypeRaw === "each" || weightTypeRaw === "perpiece" ||
        weightTypeRaw === "per-piece") ? "each" : "total";
    return freightDims.normalizePalletDims({
      qty: numOrNull(r.qty),
      weight: numOrNull(r.weight),
      weightType,
      class: r.class != null && r.class !== "" ?
        (Number(r.class) || r.class) : null,
      classSource: r.classSource || null,
      emailClass: r.emailClass != null && r.emailClass !== "" ?
        (Number(r.emailClass) || r.emailClass) : null,
      density: numOrNull(r.density),
      length: numOrNull(r.length),
      width: numOrNull(r.width),
      height: numOrNull(r.height),
      dimType: r.dimType != null && String(r.dimType).trim() ?
        String(r.dimType).trim() : "PLT",
    }, dimOpts);
  }).filter((r) =>
    r.qty != null || r.weight != null || r.length != null ||
    r.width != null || r.height != null || r.class != null);
}

/**
 * Updates quote shipper/consignee/freight/customer fields (dispatcher edit).
 * @param {object} tenant Tenant.
 * @param {string} quoteId Quote doc id.
 * @param {object} details Patch payload.
 * @return {Promise<object>}
 */
async function updateQuoteDetails(tenant, quoteId, details = {}) {
  const ref = col(tenant, "quoteRequests").doc(quoteId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Quote not found");
  const data = snap.data();
  if (isDismissedQuote(data)) {
    throw new Error("Quote was dismissed");
  }

  const quoteRulesList = await quoteRules.loadActiveRules(tenant);
  const senderFrom = senderRules.resolveQuoteSenderFrom(
      data.senderFrom || data.from || "",
      (data.extracted && data.extracted._sourceBody) || "");
  const senderDimOpts = senderRules.dimOptsForSender(
      senderFrom, quoteRulesList, {cc: data.cc, to: data.to});

  const patch = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (details.customerRef != null) {
    patch.customerRef = String(details.customerRef).trim();
  }
  if (details.readyDate !== undefined) {
    patch.readyDate = details.readyDate ?
      String(details.readyDate).trim() : null;
  }
  if (details.specialInstructionsGlobal !== undefined) {
    patch.specialInstructionsGlobal =
      String(details.specialInstructionsGlobal || "");
  }
  if (details.shippingLocationName != null ||
      details.matchedCustomerName != null) {
    patch.shippingLocationName = String(
        details.shippingLocationName != null ?
          details.shippingLocationName :
          details.matchedCustomerName || "").trim() || null;
  }
  if (details.shipper !== undefined) {
    patch.shipper = normalizeAddressParty(details.shipper);
  }

  const lanePatches = Array.isArray(details.lanes) ? details.lanes : [];
  const byLane = new Map();
  for (const row of lanePatches) {
    if (!row || !row.laneKey) continue;
    byLane.set(String(row.laneKey), row);
  }

  let lanes = data.lanes || [];
  if (byLane.size || details.shipper !== undefined) {
    lanes = lanes.map((lane) => {
      const row = byLane.get(String(lane.laneKey));
      let next = {...lane};
      if (details.shipper !== undefined && !row) {
        // Quote-level shipper applies to lanes without an explicit override.
        next.shipper = patch.shipper || lane.shipper;
      }
      if (!row) return next;
      if (row.shipper !== undefined) {
        next = {...next, shipper: normalizeAddressParty(row.shipper)};
      } else if (details.shipper !== undefined) {
        next = {...next, shipper: patch.shipper || next.shipper};
      }
      if (row.consignee !== undefined) {
        next = {...next, consignee: normalizeAddressParty(row.consignee)};
      }
      if (row.freightInfo !== undefined) {
        next = {
          ...next,
          freightInfo: normalizeFreightRows(
              row.freightInfo, senderDimOpts),
        };
      }
      if (row.specialInstructions !== undefined) {
        next = {
          ...next,
          specialInstructions: String(row.specialInstructions || ""),
        };
      }
      if (row.label != null && String(row.label).trim()) {
        next = {...next, label: String(row.label).trim()};
      }
      return next;
    });
    patch.lanes = lanes;
  }

  // Clear stale draft so dispatcher re-generates after detail edits.
  patch.customerEmailText = admin.firestore.FieldValue.delete();
  patch.customerEmailHtml = admin.firestore.FieldValue.delete();
  if (data.status === "draft_ready") {
    patch.status = "awaiting_dispatcher";
  }

  const nameOrRefTouched = details.customerRef != null ||
    details.shippingLocationName != null ||
    details.matchedCustomerName != null ||
    details.customerName != null;
  let customerMatch = null;
  let customerMatchMessage = null;
  if (nameOrRefTouched) {
    // Prefer explicit customerName from UI if present.
    if (details.customerName != null &&
        details.shippingLocationName == null &&
        details.matchedCustomerName == null) {
      patch.shippingLocationName =
        String(details.customerName).trim() || null;
    }
    const lookup = await applyCustomerLookupToPatch(data, patch, {
      quoteRules: quoteRulesList,
    });
    customerMatch = lookup.customerMatch;
    customerMatchMessage = lookup.customerMatchMessage;
  }

  await ref.update(patch);

  const fresh = await ref.get();
  const quote = {id: fresh.id, ...fresh.data()};
  return {
    ok: true,
    quote: quoteOutput.serializeForDispatcherPage(quote),
    customerMatch,
    customerMatchMessage,
  };
}

/**
 * Parses Primus /rate/save result row into persisted fields.
 * @param {object|null} row Save result.
 * @return {object}
 */
function parsePrimusSaveResult(row) {
  if (!row || typeof row !== "object") {
    return {quoteNumber: null, costQuoteId: null, url: null};
  }
  const quoteNumber = row.quoteNumber || row.quote_number ||
    row.number || null;
  const costQuoteId = row.costQuoteId || row.cost_quote_id ||
    row.costQuoteID || row.id || row.quoteId || null;
  const url = row.url || row.link || row.quoteUrl || row.QuoteUrl || null;
  return {
    quoteNumber: quoteNumber != null ? String(quoteNumber) : null,
    costQuoteId: costQuoteId != null ? String(costQuoteId) : null,
    url: url != null ? String(url) : null,
  };
}

/**
 * Saves checked rates to Primus and persists quote numbers on options.
 * @param {object} tenant Tenant.
 * @param {string} quoteId Quote id.
 * @param {object} quote Quote data (mutated lanes in place).
 * @return {Promise<object>} {ok, saveResults, lanes, failedCount, savedCount}
 */
async function saveSelectedRatesToPrimus(tenant, quoteId, quote) {
  const saveResults = [];
  let savedCount = 0;
  let failedCount = 0;
  const lanes = (quote.lanes || []).map((lane) => {
    const selectedIds = new Set(
        (lane.selectedRateIds || []).map(String));
    if (!selectedIds.size && lane.selectedRateId) {
      selectedIds.add(String(lane.selectedRateId));
    }
    const options = (lane.options || []).map((opt) => ({...opt}));
    return {...lane, options, selectedRateIds: [...selectedIds]};
  });

  for (const lane of lanes) {
    for (const opt of lane.options) {
      const rateId = String(opt.id);
      if (!(lane.selectedRateIds || []).includes(rateId)) continue;

      // Reuse prior successful Primus save when present.
      if (opt.costQuoteId && (opt.quoteNumber || opt.savedQuoteNumber)) {
        saveResults.push({
          laneKey: lane.laneKey,
          rateId,
          name: opt.name || opt.SCAC || rateId,
          ok: true,
          reused: true,
          quoteNumber: opt.quoteNumber || opt.savedQuoteNumber,
          costQuoteId: opt.costQuoteId,
          url: opt.quoteUrl || opt.url || null,
        });
        savedCount += 1;
        continue;
      }

      try {
        const saved = await rateShop.saveRate(rateId, {
          laneDistance: lane.laneDistance != null ?
            lane.laneDistance : undefined,
        });
        const parsed = parsePrimusSaveResult(saved && saved.results);
        if (!parsed.quoteNumber && !parsed.costQuoteId) {
          throw new Error("Primus save returned no quote number");
        }
        opt.quoteNumber = parsed.quoteNumber || opt.quoteNumber || null;
        opt.savedQuoteNumber = opt.quoteNumber;
        opt.costQuoteId = parsed.costQuoteId;
        opt.quoteUrl = parsed.url;
        opt.url = parsed.url;
        opt.savedAt = new Date().toISOString();
        saveResults.push({
          laneKey: lane.laneKey,
          rateId,
          name: opt.name || opt.SCAC || rateId,
          ok: true,
          reused: false,
          quoteNumber: opt.quoteNumber,
          costQuoteId: opt.costQuoteId,
          url: opt.quoteUrl,
        });
        savedCount += 1;
      } catch (err) {
        failedCount += 1;
        saveResults.push({
          laneKey: lane.laneKey,
          rateId,
          name: opt.name || opt.SCAC || rateId,
          ok: false,
          error: err && err.message ? err.message : String(err),
        });
      }
    }
    const okIds = new Set(
        saveResults
            .filter((r) => r.laneKey === lane.laneKey && r.ok)
            .map((r) => String(r.rateId)));
    // Only successfully saved rates stay selected for the customer email.
    lane.selectedRateIds = (lane.selectedRateIds || [])
        .filter((id) => okIds.has(String(id)));
    lane.selectedRateId = lane.selectedRateIds[0] || null;
    lane.selectedOptions = lane.options.filter((o) =>
      lane.selectedRateIds.includes(String(o.id)));
    lane.selectedOption = lane.selectedOptions[0] || null;
  }

  await col(tenant, "quoteRequests").doc(quoteId).update({
    lanes,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  quote.lanes = lanes;

  return {
    ok: failedCount === 0,
    partial: failedCount > 0 && savedCount > 0,
    savedCount,
    failedCount,
    saveResults,
    lanes,
  };
}

/**
 * Checks lane has enough origin/destination/freight for Primus rating.
 * @param {object} lane Lane.
 * @return {object} `{ok, reason}` — reason set when not rateable.
 */
function validateLaneForRating(lane) {
  const ship = lane.shipper || {};
  const cons = lane.consignee || {};
  const originZip = ship.zipCode || ship.zipcode || ship.zip;
  const destZip = cons.zipCode || cons.zipcode || cons.zip;
  const missing = [];
  if (!String(ship.city || "").trim() || !String(ship.state || "").trim() ||
      !String(originZip || "").trim()) {
    missing.push("origin city/state/zip");
  }
  if (!String(cons.city || "").trim() || !String(cons.state || "").trim() ||
      !String(destZip || "").trim()) {
    missing.push("destination city/state/zip");
  }
  const freight = Array.isArray(lane.freightInfo) ? lane.freightInfo : [];
  const hasFreight = freight.some((r) =>
    r && (r.weight != null || r.qty != null));
  if (!hasFreight) missing.push("freight weight/qty");
  if (!missing.length) return {ok: true, reason: null};
  return {
    ok: false,
    reason: "Cannot rate — missing " + missing.join(" and ") +
      ". Fill quote details and rerun.",
  };
}

/**
 * Unique dispatcher-facing extraction / rating warnings for a quote.
 * @param {object} extracted Intake payload.
 * @param {Array<object>} lanes Rated lanes.
 * @return {Array<string>}
 */
function collectQuoteWarnings(extracted, lanes) {
  const out = [];
  const add = (msg) => {
    if (msg && !out.includes(msg)) out.push(msg);
  };
  (extracted && extracted.extractionWarnings || []).forEach(add);
  for (const lane of lanes || []) {
    (lane.extractionWarnings || []).forEach(add);
    if (lane.rateSource === "market_fallback") add("market fallback");
    if (lane.rateWarning === rateShop.MARKET_FALLBACK_WARNING) {
      add("market fallback");
    }
  }
  return out;
}

/**
 * Quote-level rateSource from rated lanes.
 * @param {Array<object>} lanes Rated lanes.
 * @param {string|null} shippingLocationId Matched customer id.
 * @return {string|null}
 */
function quoteRateSource(lanes, shippingLocationId) {
  const rows = Array.isArray(lanes) ? lanes : [];
  if (rows.some((l) => l && l.rateSource === "market_fallback")) {
    return "market_fallback";
  }
  if (rows.some((l) => l && l.rateSource === "customer")) return "customer";
  return shippingLocationId ? "customer" : null;
}

/**
 * Rates one lane and returns top options with sell rates.
 * @param {object} lane Lane with shipper, consignee, freightInfo.
 * @param {object} ctx Context with rules, shippingLocationId, margin opts.
 * @return {Promise<object>}
 */
async function rateLane(lane, ctx) {
  if (lane && typeof lane === "object") {
    if (lane.shipper) {
      lane.shipper = await addressEnrichment.fillPartyOdFromZipOrCityState(
          lane.shipper, lane);
    }
    if (lane.consignee) {
      lane.consignee = await addressEnrichment.fillPartyOdFromZipOrCityState(
          lane.consignee, lane);
    }
  }
  const odCheck = validateLaneForRating(lane);
  if (!odCheck.ok) {
    return {
      ...lane,
      options: [],
      rateError: odCheck.reason,
      appliedRules: Array.isArray(lane.freightRulesApplied) ?
        lane.freightRulesApplied : [],
    };
  }

  // Always overwrite email class with Primus density class when
  // weight + L×W×H are present. Pallet missing dims → sender or
  // global 40×48×60 first. Also replace invented 40×48×60 with sender
  // defaults (e.g. Brumis 40×48×62) when the RFQ never stated a height.
  const dimOpts = senderRules.dimOptsForSender(
      ctx.from || "", ctx.rules || []);
  senderRules.applySenderDefaultedDimOverrides(
      {lanes: [lane]},
      ctx.from || "",
      ctx.emailBody || "",
      ctx.rules || []);
  const freightNormalized = freightDims.normalizePalletFreightRows(
      lane.freightInfo || [], dimOpts);
  const classFix = rateShop.ensureFreightClasses(freightNormalized, {
    UOM: "US",
  });
  const freightWithClass = classFix.freightInfo;
  const hasRateableClass = freightWithClass.some((r) =>
    rateShop.isValidFreightClass(r && r.class));
  if (!hasRateableClass && classFix.unresolved.length) {
    const why = classFix.unresolved
        .map((u) => `line ${u.index + 1}: ${u.reason}`)
        .join("; ");
    return {
      ...lane,
      freightInfo: freightWithClass,
      options: [],
      rateError: "Cannot rate — freight class missing and weight/dims are " +
        "insufficient to derive NMFC class from density (" + why + ").",
      appliedRules: Array.isArray(lane.freightRulesApplied) ?
        lane.freightRulesApplied : [],
    };
  }

  const laneForRate = {...lane, freightInfo: freightWithClass};

  let rulesOut;
  const extracted = ctx.extracted && typeof ctx.extracted === "object" ?
    ctx.extracted : {};
  const declinedCodes = ctx.customerDeclinedAccessorials ||
    extracted.customerDeclinedAccessorials || [];
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
    const extractCtx = {
      ...extracted,
      emailBody: ctx.emailBody || extracted._sourceBody || "",
      subject: ctx.subject || extracted._sourceSubject || "",
      customerDeclinedAccessorials: declinedCodes,
    };
    rulesOut = quoteRules.applyRulesToLane(
        laneForRate, ctx.rules, extractCtx);
    const emailText = [
      lane.specialInstructions,
      extracted.specialInstructionsGlobal,
      extractCtx.emailBody,
    ].filter(Boolean).join("\n");
    const requested = quoteEmailAcc.resolveRequestedAccessorials(
        extracted, {body: emailText, subject: extractCtx.subject});
    rulesOut = quoteEmailAcc.applyEmailRequestedAccessorials(
        rulesOut, requested, quoteRules.formatAccessorialLabels);
    rulesOut = quoteEmailAcc.applyDeclinedAccessorials(
        rulesOut, emailText, declinedCodes);
  }
  const mergedLane = {
    ...laneForRate,
    accessorials: rulesOut.accessorials,
    accessorialsWithData: rulesOut.accessorialsWithData,
    appliedRules: rulesOut.appliedRules,
    requiresConfirm: rulesOut.requiresConfirm,
    customerDeclinedAccessorials: declinedCodes,
  };

  const wantsGuaranteed = !!(
    extracted.customerRequest &&
    extracted.customerRequest.wantsGuaranteedOptions
  );

  const query = rateShop.buildRateMultipleQuery(mergedLane, {
    shippingLocationId: ctx.shippingLocationId,
    customerId: ctx.shippingLocationId,
    UOM: "US",
    pickupDate: extracted.readyDate,
    includeGuaranteed: wantsGuaranteed,
    returnValidAccsOnly: process.env.QUOTE_RETURN_VALID_ACCS_ONLY === "true",
    timeout: process.env.QUOTE_RATE_TIMEOUT || undefined,
  });

  let fetched = await rateShop.fetchMultipleRates(query);
  let rates = fetched.rates || [];
  let noRates = fetched.noRates || [];
  let rateNote = null;
  let rateSource = ctx.shippingLocationId ? "customer" : null;

  // Customer tariffs empty for any reason → retry market rates.
  // Keep the Primus customer match; never present market as contract.
  if (!rates.length && ctx.shippingLocationId) {
    const fallbackQuery = {...query};
    delete fallbackQuery.customerId;
    fetched = await rateShop.fetchMultipleRates(fallbackQuery);
    rates = fetched.rates || [];
    noRates = fetched.noRates || [];
    if (rates.length) {
      rateSource = "market_fallback";
      rateNote = rateShop.MARKET_FALLBACK_WARNING;
    }
  }

  const filtered = rateShop.filterBlockedCarriers(
      rates, rulesOut.filterCarrierWarnings);

  const marginOpts = {
    marginPercent: Number(process.env.QUOTE_MARGIN_PERCENT) || 10,
    marginMinDollars: Number(process.env.QUOTE_MARGIN_MIN_DOLLARS) || 55,
  };

  const enriched = filtered.map((r) => {
    const billToTotal = r.billTo && r.billTo.total;
    const sellRate = rateShop.computeSellRate(r.total, {
      billToTotal,
      rateSource,
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

  let rateError = null;
  let rateWarning = null;
  const extractionWarnings = [];
  const addWarn = (msg) => {
    if (msg && !extractionWarnings.includes(msg)) {
      extractionWarnings.push(msg);
    }
  };
  (lane.extractionWarnings || []).forEach(addWarn);
  if (rateSource === "market_fallback") addWarn("market fallback");
  for (const w of rulesOut.extractionWarnings || []) addWarn(w);
  if (!options.length) {
    rateError = rateShop.summarizeNoRateErrors(noRates) ||
      "No rates returned from Primus.";
  } else if (rateNote) {
    rateWarning = rateNote;
  }

  return {
    ...mergedLane,
    appliedRules: [...freightApplied, ...(mergedLane.appliedRules || [])],
    options,
    rateError,
    rateWarning,
    rateSource,
    extractionWarnings,
  };
}

/**
 * Prefer the Outlook queue body when the caller passed a stripped RFQ
 * (common on Innovative FW mailboxes missing embedded From: lines).
 * @param {object} opts processQuoteEmail options.
 * @param {object} tenant Tenant.
 * @param {string} from Outer From header.
 * @param {string} emailBody Body from caller.
 * @return {Promise<string>}
 */
async function resolveQuoteEmailBody(opts, tenant, from, emailBody) {
  let body = String(emailBody || "");
  const senderFromBody = senderRules.resolveQuoteSenderFrom(from, body);
  const needsQueueBody = opts.outlookMessageId && (
    !body.trim() ||
    !/@/.test(body) ||
    (senderRules.isInternalMailboxFrom(from) &&
      senderRules.isInternalMailboxFrom(senderFromBody)));
  if (!needsQueueBody) return body;
  try {
    const qsnap = await col(tenant, "quoteMailQueue")
        .where("outlookMessageId", "==", opts.outlookMessageId)
        .limit(1)
        .get();
    if (!qsnap.empty) {
      const queuedBody = String(qsnap.docs[0].data().emailBody || "");
      if (queuedBody.trim()) body = queuedBody;
    }
  } catch (_) {
    // keep caller body
  }
  return body;
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
  const to = opts.to || "";
  const cc = opts.cc || "";
  const emailBody = await resolveQuoteEmailBody(opts, tenant, from,
      opts.emailBody || "");
  const senderFrom = senderRules.resolveQuoteSenderFrom(from, emailBody);
  const recipientOpts = {cc, to};

  await deps.writeLog("info", "quote", "Processing quote request email", {
    messageId, subject, from, senderFrom, to: to || null, cc: cc || null,
  });

  let extracted = await quoteIntake.extractQuoteRequest({
    subject, from: senderFrom || from, body: emailBody,
    cc, to,
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

  const rules = await quoteRules.loadActiveRules(tenant);
  // Re-apply sender→customer / defaultDims using Firestore rules (chat-created
  // mappings) in addition to built-in SENDER_RULES.
  senderRules.applySenderCustomerOverride(
      extracted, senderFrom, rules, recipientOpts);
  senderRules.applySenderDefaultedDimOverrides(
      extracted, senderFrom, emailBody, rules, recipientOpts);

  const batchQuoteId = quoteOutput.generateBatchQuoteId(
      process.env.QUOTE_BATCH_PREFIX || "D");
  const senderRuleForBillTo = senderRules.resolveSenderRule(
      senderFrom, rules, recipientOpts);
  const billToFromSender = senderRuleForBillTo &&
    senderRuleForBillTo.customerName ?
    String(senderRuleForBillTo.customerName).trim() : "";
  const extractedCustomerName = String(
      billToFromSender ||
      extracted.customerName ||
      extracted.shippingLocationName ||
      (extracted.shipper && extracted.shipper.name) ||
      "").trim();
  const customerMatch = await resolveCustomerMatch({
    from: senderFrom,
    customerRef: extracted.customerRef,
    customerName: extractedCustomerName,
    shipperName: extracted.shipper && extracted.shipper.name,
    quoteRules: rules,
    cc,
    to,
  });
  const shippingLocationId = customerMatch.id || null;
  const shippingLocationName = customerMatch.name ||
    billToFromSender ||
    extractedCustomerName || null;
  const customerLookupStatus = customerMatch.lookupStatus ||
    (shippingLocationId ? "matched" : "no_match");

  const enrichLog = (level, category, message, data) =>
    deps.writeLog(level, category, message, data);

  const shipper = extracted.shipper || {};
  for (const lane of extracted.lanes) {
    if (!lane.shipper ||
        !addressEnrichment.normalizeAddressKey(lane.shipper)) {
      lane.shipper = lane.shipper && typeof lane.shipper === "object" ?
        {...shipper, ...lane.shipper} : {...shipper};
    }
    try {
      await addressEnrichment.enrichLaneAddresses(lane, tenant, {
        log: enrichLog,
      });
    } catch (err) {
      await deps.writeLog("warn", "quote", "Address enrichment failed", {
        laneKey: lane.laneKey,
        error: err.message,
      });
    }
  }
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
        emailBody,
        subject,
        from: senderFrom,
        customerDeclinedAccessorials:
          extracted.customerDeclinedAccessorials || [],
      });
      ratedLanes.push(rated);
    } catch (err) {
      ratedLanes.push({
        ...lane,
        shipper: lane.shipper || shipper,
        options: [],
        rateError: err.message,
        rateWarning: null,
        rateSource: shippingLocationId ? "customer" : null,
        extractionWarnings: lane.extractionWarnings || [],
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
    to: to || null,
    cc: cc || null,
    senderFrom: senderFrom || null,
    customerRef: extracted.customerRef || subject,
    batchQuoteId,
    format: extracted.format,
    readyDate: extracted.readyDate,
    shipper: extracted.shipper,
    originSiteType: (ratedLanes[0] && ratedLanes[0].originSiteType) || null,
    originEnrichmentMeta:
      (ratedLanes[0] && ratedLanes[0].originEnrichmentMeta) || null,
    specialInstructionsGlobal: extracted.specialInstructionsGlobal || "",
    shippingLocationId,
    shippingLocationName,
    customerLookupStatus,
    customerLookupQuery: extractedCustomerName ||
      customerMatch.searchTerm || null,
    customerLookupQueries: customerMatch.searchesTried || [],
    customerDeclinedAccessorials: extracted.customerDeclinedAccessorials ||
      [],
    extractModel: extracted.extractModel || null,
    extractionWarnings: collectQuoteWarnings(extracted, ratedLanes),
    rateSource: quoteRateSource(ratedLanes, shippingLocationId),
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
    shippingLocationId: data.shippingLocationId || null,
    shippingLocationName: data.shippingLocationName || null,
    customerLookupStatus: data.customerLookupStatus || null,
    customerMatched: !!(data.shippingLocationId &&
      data.customerLookupStatus !== "no_match"),
    customerLookupQuery: data.customerLookupQuery || null,
    rateSource: data.rateSource || null,
    extractionWarnings: data.extractionWarnings || [],
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
        sellRate: o.sellRate != null ? o.sellRate : o.total,
        cost: o.total != null ? o.total : o.cost,
        transitDays: o.transitDays,
      })),
      optionCount: (lane.options || []).length,
      rateError: lane.rateError || null,
      rateWarning: lane.rateWarning || null,
      rateSource: lane.rateSource || null,
    })),
  };
}

/**
 * True when quote belongs to this dispatcher (id + optional email match).
 * @param {object} data Quote fields.
 * @param {string} dispatcherId Dispatcher id.
 * @param {string} dispatcherEmail Normalized email or "".
 * @return {boolean}
 */
function quoteBelongsToDispatcher(data, dispatcherId, dispatcherEmail) {
  if (data.assignedDispatcherId !== dispatcherId) return false;
  if (dispatcherEmail && data.assignedDispatcherEmail &&
    quoteDispatchers.normalizeEmail(data.assignedDispatcherEmail) !==
    dispatcherEmail) {
    return false;
  }
  return true;
}

/**
 * Counts all quotes assigned to one dispatcher by status.
 * @param {object} tenant Tenant.
 * @param {object} dispatcher Dispatcher row (id + email).
 * @return {Promise<object>}
 */
async function countQuotesForDispatcher(tenant, dispatcher) {
  const dispatcherId = String(dispatcher.id || dispatcher);
  const dispatcherEmail = quoteDispatchers.normalizeEmail(
      dispatcher.email || "");
  const snap = await col(tenant, "quoteRequests")
      .where("assignedDispatcherId", "==", dispatcherId)
      .select("status", "dismissedAt", "assignedDispatcherEmail")
      .get();
  const counts = {
    total: 0,
    pending: 0,
    awaiting: 0,
    draftReady: 0,
    dismissed: 0,
  };
  for (const doc of snap.docs) {
    const data = doc.data();
    if (!quoteBelongsToDispatcher(data, dispatcherId, dispatcherEmail)) {
      continue;
    }
    counts.total += 1;
    if (isDismissedQuote(data)) {
      counts.dismissed += 1;
      continue;
    }
    const status = normalizeQuoteStatus(data.status);
    if (status === "awaiting_dispatcher") {
      counts.awaiting += 1;
      counts.pending += 1;
    } else if (status === "draft_ready") {
      counts.draftReady += 1;
      counts.pending += 1;
    }
  }
  return counts;
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
  const [snap, counts] = await Promise.all([
    col(tenant, "quoteRequests")
        .orderBy("createdAt", "desc")
        .limit(limit * 5)
        .get(),
    countQuotesForDispatcher(tenant, dispatcher),
  ]);
  const items = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    if (!quoteBelongsToDispatcher(data, dispatcherId, dispatcherEmail)) {
      continue;
    }
    if (!matchesInboxStatus(data, opts.status)) continue;
    if (items.length >= limit) continue;
    items.push(serializeInboxQuote(doc, data));
  }
  return {items, counts};
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
 * Saves each checked rate to Primus (/rate/save) first so the draft
 * includes real quote numbers.
 * @param {object} tenant Tenant.
 * @param {string} quoteId Quote id.
 * @param {object} [opts] style, bodyText override, selections.
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

  const saveOutcome = await saveSelectedRatesToPrimus(
      tenant, quoteId, quote);

  if (!saveOutcome.savedCount) {
    const firstErr = (saveOutcome.saveResults || [])
        .find((r) => !r.ok);
    throw new Error(
        (firstErr && firstErr.error) ||
        "Failed to save rates to Primus — no draft generated.");
  }

  // Reload after save so selectedOptions / quote numbers are current.
  const afterSave = await ref.get();
  Object.assign(quote, afterSave.data());

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
    lastRateSaveResults: saveOutcome.saveResults,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    ok: true,
    partial: !!saveOutcome.partial,
    text,
    html,
    status: "draft_ready",
    savedCount: saveOutcome.savedCount,
    failedCount: saveOutcome.failedCount,
    saveResults: saveOutcome.saveResults,
    quote: quoteOutput.serializeForDispatcherPage({
      id: quoteId,
      ...quote,
      customerEmailText: text,
      customerDraftText: text,
      status: "draft_ready",
    }),
  };
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

  let emailBody = opts.emailBody ||
    (data.extracted && data.extracted._sourceBody) || "";
  // Prefer Outlook queue body when stored extract stripped emails from From:.
  if ((!emailBody || !/@/.test(emailBody)) && data.outlookMessageId) {
    try {
      const qsnap = await col(tenant, "quoteMailQueue")
          .where("outlookMessageId", "==", data.outlookMessageId)
          .limit(1)
          .get();
      if (!qsnap.empty) {
        const queuedBody = String(qsnap.docs[0].data().emailBody || "");
        if (queuedBody.trim()) emailBody = queuedBody;
      }
    } catch (_) {
      // keep extract body
    }
  }
  const senderFrom = senderRules.resolveQuoteSenderFrom(
      data.senderFrom || data.from || "", emailBody);

  // Re-resolve Primus customer from name/ref before rate shop.
  const customerPatch = {};
  if (senderFrom) customerPatch.senderFrom = senderFrom;
  const recipientOpts = {cc: data.cc, to: data.to};
  const senderRule = senderRules.resolveSenderRule(
      senderFrom, rules, recipientOpts);
  if (senderRule && senderRule.customerName) {
    // Authoritative sender→customer mapping (e.g. Jared → Brumis).
    customerPatch.shippingLocationName = String(senderRule.customerName)
        .trim();
  }
  const lookup = await applyCustomerLookupToPatch(data, customerPatch, {
    forceLookup: true,
    quoteRules: rules,
    from: senderFrom,
    emailBody,
    cc: data.cc,
    to: data.to,
  });
  const shippingLocationId = customerPatch.shippingLocationId != null ?
    customerPatch.shippingLocationId : data.shippingLocationId;
  const shippingLocationName = customerPatch.shippingLocationName != null ?
    customerPatch.shippingLocationName : data.shippingLocationName;

  const ratedLanes = [];
  for (const lane of data.lanes || []) {
    if (targetKey && lane.laneKey !== targetKey) {
      ratedLanes.push(lane);
      continue;
    }
    try {
      const laneForRate = {
        ...lane,
        shipper: lane.shipper || data.shipper,
      };
      try {
        await addressEnrichment.enrichLaneAddresses(laneForRate, tenant, {
          log: (level, category, message, logData) =>
            deps.writeLog(level, category, message, logData),
        });
      } catch (enrichErr) {
        await deps.writeLog("warn", "quote",
            "Rerun address enrichment failed", {
              laneKey: lane.laneKey,
              error: enrichErr.message,
            });
      }
      const rated = await rateLane(laneForRate, {
        rules,
        shippingLocationId,
        extracted: data.extracted || {},
        customerPrefs: {},
        emailBody,
        subject: data.subject || "",
        from: senderFrom || data.from || "",
        customerDeclinedAccessorials: data.customerDeclinedAccessorials ||
          (data.extracted && data.extracted.customerDeclinedAccessorials) ||
          [],
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
        rateWarning: rated.rateWarning || null,
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
        rateWarning: null,
        selectedRateIds: [],
        selectedOptions: [],
        selectedRateId: null,
        selectedOption: null,
      });
    }
  }

  const patch = {
    ...customerPatch,
    lanes: ratedLanes,
    status: "awaiting_dispatcher",
    extractionWarnings: collectQuoteWarnings(
        data.extracted || {}, ratedLanes),
    rateSource: quoteRateSource(ratedLanes, shippingLocationId),
    customerEmailText: admin.firestore.FieldValue.delete(),
    customerEmailHtml: admin.firestore.FieldValue.delete(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  // Keep quote-level shipper in sync with enriched lane OD (ZIP fill).
  if (ratedLanes[0] && ratedLanes[0].shipper) {
    patch.shipper = ratedLanes[0].shipper;
  }
  if (accessorialOverride != null) {
    patch.lastAccessorialOverride = accessorialOverride;
  }
  await ref.update(patch);

  const quote = {
    id: quoteId,
    ...data,
    ...customerPatch,
    shippingLocationId,
    shippingLocationName,
    shipper: patch.shipper || data.shipper,
    lanes: ratedLanes,
    extractionWarnings: patch.extractionWarnings,
    rateSource: patch.rateSource,
  };
  return {
    ok: true,
    quote: quoteOutput.serializeForDispatcherPage(quote),
    customerMatch: lookup.customerMatch,
    customerMatchMessage: lookup.customerMatchMessage,
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
  updateQuoteDetails,
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
