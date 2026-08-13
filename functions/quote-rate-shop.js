/**
 * Primus LTL rate shop — GET /rate, /rate/multiple, POST /rate/save.
 * Params aligned with Primus API v1 docs (Rates section).
 */

"use strict";

let getPrimusToken = null;

/** @type {"list"|"json"} How accessorial codes are sent on rate calls. */
const ACCESSORIAL_PARAM_STYLE =
  String(process.env.QUOTE_RATE_ACCESSORIAL_STYLE || "list").toLowerCase();

/**
 * @param {object} deps getPrimusToken async fn.
 * @return {void}
 */
function init(deps) {
  getPrimusToken = deps.getPrimusToken;
}

/**
 * @return {Promise<string>}
 */
async function token() {
  if (!getPrimusToken) throw new Error("quote-rate-shop not initialized");
  return getPrimusToken();
}

/**
 * @param {object} flat Scalar query params.
 * @param {object} [arrays] Repeated keys → string[].
 * @return {string}
 */
function buildQueryString(flat, arrays = {}) {
  const qs = new URLSearchParams();
  Object.keys(flat || {}).forEach((k) => {
    if (flat[k] != null && flat[k] !== "") {
      qs.set(k, String(flat[k]));
    }
  });
  Object.keys(arrays || {}).forEach((k) => {
    (arrays[k] || []).forEach((v) => {
      if (v != null && v !== "") qs.append(k, String(v));
    });
  });
  return qs.toString();
}

/**
 * @param {string} path Path after base URL.
 * @param {object} [opts] method, body, query, queryArrays.
 * @return {Promise<object>}
 */
async function primusFetch(path, opts = {}) {
  const base = String(process.env.PRIMUS_BASE_URL || "").replace(/\/$/, "");
  const method = opts.method || "GET";
  const headers = {
    Authorization: `Bearer ${await token()}`,
    Accept: "application/json",
  };
  let url = `${base}${path}`;
  const qs = buildQueryString(opts.query, opts.queryArrays);
  if (qs) url += `?${qs}`;
  const fetchOpts = {method, headers};
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    fetchOpts.body = JSON.stringify(opts.body);
  }
  const resp = await fetch(url, fetchOpts);
  const text = await resp.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    json = null;
  }
  if (!resp.ok) {
    const msg = (json && json.error && json.error.message) ?
      (Array.isArray(json.error.message) ?
        json.error.message.join("; ") : String(json.error.message)) :
      (text || `HTTP ${resp.status}`);
    const err = new Error(msg);
    err.status = resp.status;
    throw err;
  }
  return json;
}

/**
 * Normalizes one rate row from Primus API response.
 * @param {object} r Raw rate.
 * @return {object}
 */
function normalizeRateRow(r) {
  const remarks = Array.isArray(r.rateRemarks) ?
    r.rateRemarks.join(" ") : "";
  const warnings = r.warnings || remarks || "";
  const guaranteed =
    r.guaranteed === true ||
    String(r.rateType || "").toUpperCase() === "GUARANTEED";
  return {
    ...r,
    warnings,
    guaranteed,
    quoteNumber: r.quoteNumber || r.accountNumber || null,
  };
}

/**
 * Parses rates array from /rate or /rate/multiple response.
 * @param {object} json API JSON body.
 * @return {Array<object>}
 */
function parseRatesFromResponse(json) {
  const results = json && json.data && json.data.results;
  let rows = [];
  if (Array.isArray(results)) {
    rows = results;
  } else if (results && Array.isArray(results.rates)) {
    rows = results.rates;
  }
  return rows.map(normalizeRateRow);
}

/**
 * @param {object} params Flat + array query params for /rate/multiple.
 * @return {Promise<object>} {ok, rates, raw}
 */
async function fetchMultipleRates(params) {
  const {query, queryArrays} = splitRateQueryParams(params);
  const json = await primusFetch("/rate/multiple", {query, queryArrays});
  return {ok: true, rates: parseRatesFromResponse(json), raw: json};
}

/**
 * GET /rate — single carrier re-rate.
 * @param {object} params Query params (same as /rate/multiple).
 * @return {Promise<object>}
 */
async function fetchSingleRate(params) {
  const {query, queryArrays} = splitRateQueryParams(params);
  const json = await primusFetch("/rate", {query, queryArrays});
  return {ok: true, rates: parseRatesFromResponse(json), raw: json};
}

/**
 * Splits flat params from array-style Primus params.
 * @param {object} params Combined params object.
 * @return {object} {query, queryArrays}
 */
function splitRateQueryParams(params) {
  const p = {...params};
  const queryArrays = {};
  const arrayKeys = [
    "accessorialsList[]",
    "rateTypesList[]",
    "vendorIdList[]",
  ];
  for (const key of arrayKeys) {
    const plain = key.replace("[]", "");
    if (Array.isArray(p[key])) {
      queryArrays[key] = p[key];
      delete p[key];
    } else if (Array.isArray(p[plain])) {
      queryArrays[key] = p[plain];
      delete p[plain];
    }
  }
  return {query: p, queryArrays};
}

/**
 * @param {string} rateId Rate id from rate results.
 * @param {object} [opts] laneDistance.
 * @return {Promise<object>}
 */
async function saveRate(rateId, opts = {}) {
  const body = {rateId: String(rateId)};
  if (opts.laneDistance != null) {
    body.laneDistance = Number(opts.laneDistance);
  }
  const json = await primusFetch("/rate/save", {method: "POST", body});
  const results = json && json.data && json.data.results;
  const row = Array.isArray(results) ? results[0] : results;
  return {ok: true, results: row, raw: json};
}

/**
 * @param {object} [opts] page, limit, name, code, active, isCustomer.
 * @return {Promise<object>}
 */
async function searchShippingLocations(opts = {}) {
  const query = {
    page: String(opts.page || 1),
    limit: String(opts.limit || 25),
  };
  if (opts.name) query.name = String(opts.name);
  if (opts.code) query.code = String(opts.code);
  if (opts.active != null) query.active = String(!!opts.active);
  if (opts.isCustomer != null) {
    query.isCustomer = String(!!opts.isCustomer);
  } else if (opts.customersOnly !== false) {
    query.isCustomer = "true";
  }

  const paths = [
    "/database/system/shippinglocation",
    "/database/shippinglocation",
  ];
  let lastErr = null;
  for (const path of paths) {
    try {
      const json = await primusFetch(path, {query});
      const data = json && json.data;
      return {
        ok: true,
        results: (data && data.results) || [],
        paging: data && data.pagingDetails,
        raw: json,
      };
    } catch (err) {
      lastErr = err;
      if (err.status === 404) continue;
    }
  }
  if (lastErr) throw lastErr;
  return {ok: true, results: [], paging: null, raw: null};
}

/**
 * GET /database/system/shippinglocation/{id}
 * @param {string|number} id Shipping location id.
 * @return {Promise<object|null>}
 */
async function getShippingLocationById(id) {
  const paths = [
    `/database/system/shippinglocation/${id}`,
    `/database/shippinglocation/${id}`,
  ];
  for (const path of paths) {
    try {
      const json = await primusFetch(path);
      const results = json && json.data && json.data.results;
      if (Array.isArray(results) && results[0]) return results[0];
      if (results && typeof results === "object" && !Array.isArray(results)) {
        return results;
      }
    } catch (err) {
      if (err.status === 404) continue;
      throw err;
    }
  }
  return null;
}

/**
 * Picks best customer match from search results.
 * @param {Array<object>} results Shipping locations.
 * @param {object} opts from email, customerRef.
 * @return {object|null}
 */
function pickBestCustomerMatch(results, opts = {}) {
  if (!Array.isArray(results) || !results.length) return null;
  const from = String(opts.from || "").toLowerCase();
  const ref = String(opts.customerRef || "").toLowerCase();

  for (const row of results) {
    const email = String(row.email || "").toLowerCase();
    if (email && from.includes(email)) return row;
  }
  for (const row of results) {
    if (row.customer === true) return row;
  }
  for (const row of results) {
    const name = String(row.name || "").toLowerCase();
    if (name && (from.includes(name) || ref.includes(name))) return row;
  }
  return results[0];
}

/**
 * Resolves Primus customer id (shipping location) for rate shop.
 * @param {object} opts from, customerRef, searchTerms[].
 * @return {Promise<object|null>} {id, name, code, customer}
 */
async function resolveCustomerForQuote(opts = {}) {
  const from = String(opts.from || "");
  const emailMatch = from.match(/<([^>]+@[^>]+)>|([\w.+-]+@[\w.-]+)/);
  const email = emailMatch ? (emailMatch[1] || emailMatch[2]) : "";
  const searches = [];

  if (email.includes("@")) {
    const local = email.split("@")[0];
    const domain = email.split("@")[1];
    const domainStem = domain.split(".")[0];
    if (domainStem.length > 2) searches.push(domainStem);
    if (local.length > 2) searches.push(local);
  }

  const domainMatch = from.match(/@([\w.-]+)/);
  if (domainMatch) {
    const stem = domainMatch[1].split(".")[0];
    if (stem.length > 2 && !searches.includes(stem)) searches.push(stem);
  }

  for (const term of opts.searchTerms || []) {
    if (term && !searches.includes(term)) searches.push(String(term));
  }

  for (const term of searches) {
    try {
      const res = await searchShippingLocations({
        name: term,
        limit: 10,
        active: true,
        isCustomer: true,
      });
      const best = pickBestCustomerMatch(res.results, opts);
      if (best && best.id) {
        return {
          id: String(best.id),
          name: best.name || null,
          code: best.code || null,
          customer: best.customer === true,
          email: best.email || null,
        };
      }
    } catch (_) {
      // try next term
    }
  }
  return null;
}

/**
 * GET /database/vendor/customer/{customerId}
 * @param {string|number} customerId Shipping location id.
 * @return {Promise<Array<object>>}
 */
async function fetchVendorsByCustomer(customerId) {
  const json = await primusFetch(
      `/database/vendor/customer/${customerId}`);
  const results = json && json.data && json.data.results;
  return Array.isArray(results) ? results : [];
}

/**
 * GET /ratetypes
 * @return {Promise<Array<object>>}
 */
async function fetchRateTypes() {
  const json = await primusFetch("/ratetypes");
  const results = json && json.data && json.data.results;
  if (Array.isArray(results)) return results;
  return [];
}

/**
 * GET /database/costquote — list saved quotes.
 * @param {object} [opts] dateFrom, dateTo, search, page, limit.
 * @return {Promise<object>}
 */
async function searchCostQuotes(opts = {}) {
  const query = {
    page: String(opts.page || 1),
    limit: String(opts.limit || 25),
  };
  if (opts.dateFrom) query.dateFrom = String(opts.dateFrom);
  if (opts.dateTo) query.dateTo = String(opts.dateTo);
  if (opts.search) query.search = String(opts.search);
  if (opts.bookedOnly != null) {
    query.bookedOnly = String(!!opts.bookedOnly);
  }
  const json = await primusFetch("/database/costquote", {query});
  const data = json && json.data;
  return {
    ok: true,
    results: (data && data.results) || [],
    paging: data && data.pagingDetails,
    raw: json,
  };
}

/**
 * GET /database/costquote/{costQuoteId}
 * @param {string|number} costQuoteId Saved quote id.
 * @return {Promise<object|null>}
 */
async function fetchCostQuote(costQuoteId) {
  const json = await primusFetch(`/database/costquote/${costQuoteId}`);
  const results = json && json.data && json.data.results;
  if (Array.isArray(results) && results[0]) return results[0];
  if (results && typeof results === "object") return results;
  return null;
}

/**
 * Parse Primus GET /accessorial JSON into flat accessorial rows.
 * Live shape: `{ data: { results: { accessorials: [...] } } }`.
 * Also supports legacy array-of-blocks results.
 * @param {object} json Primus response.
 * @return {Array<object>}
 */
function parseAccessorialCatalogResponse(json) {
  const results = json && json.data && json.data.results;
  if (!results) return [];
  if (Array.isArray(results.accessorials)) {
    return results.accessorials;
  }
  if (Array.isArray(results)) {
    const out = [];
    for (const block of results) {
      if (Array.isArray(block && block.accessorials)) {
        out.push(...block.accessorials);
      } else if (block && block.code) {
        out.push(block);
      }
    }
    return out;
  }
  return [];
}

/**
 * GET /accessorial — full catalog.
 * @param {boolean} [customerDefault] Pass default=true for customer list.
 * @return {Promise<Array<object>>}
 */
async function fetchAccessorialCatalog(customerDefault = false) {
  const query = customerDefault ? {default: "true"} : {};
  const json = await primusFetch("/accessorial", {query});
  return parseAccessorialCatalogResponse(json);
}

/**
 * Raw GET /accessorial JSON (for catalog builders / caching).
 * @param {boolean} [customerDefault] Pass default=true for customer list.
 * @return {Promise<object>}
 */
async function fetchAccessorialCatalogRaw(customerDefault = false) {
  const query = customerDefault ? {default: "true"} : {};
  return primusFetch("/accessorial", {query});
}

/** Primus freightInfo.dimType allowed values. */
const PRIMUS_DIM_TYPES = new Set([
  "TRUCK LOAD", "PLT", "CTN", "CRT", "DRM", "CON", "BOX",
  "BDL", "ENV", "CYL", "CAS", "OTH", "TOT",
]);

/**
 * Normalize country to ISO 3166-1 alpha-2 for Primus rate APIs.
 * Primus rejects "USA" — it wants "US".
 * @param {*} value Raw country from AI/heuristics/booking.
 * @return {string} Two-letter country code (default US).
 */
function normalizeIsoCountry(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "US";
  const compact = raw.replace(/[^A-Za-z]/g, "").toUpperCase();
  if (compact === "US" || compact === "USA" ||
      compact === "UNITEDSTATES" || compact === "UNITEDSTATESOFAMERICA") {
    return "US";
  }
  if (compact === "CA" || compact === "CAN" || compact === "CANADA") {
    return "CA";
  }
  if (compact === "MX" || compact === "MEX" || compact === "MEXICO") {
    return "MX";
  }
  if (/^[A-Z]{2}$/.test(compact)) return compact;
  return "US";
}

/**
 * Normalize freight packaging type to a Primus dimType enum.
 * @param {*} value Raw dimType (e.g. "pallet", "in", "PLT").
 * @param {object} [row] Freight row — prefer PLT for LTL-looking freight.
 * @return {string} Primus dimType.
 */
function normalizeDimType(value, row = {}) {
  const raw = String(value == null ? "" : value).trim();
  const upper = raw.toUpperCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (PRIMUS_DIM_TYPES.has(upper)) return upper;

  const key = upper.replace(/\s+/g, "");
  const aliases = {
    PALLET: "PLT",
    PALLETS: "PLT",
    SKID: "PLT",
    SKIDS: "PLT",
    PLTS: "PLT",
    // Heuristic/AI sometimes put dim UOM ("in") in dimType.
    IN: "PLT",
    INCH: "PLT",
    INCHES: "PLT",
    CARTON: "CTN",
    CARTONS: "CTN",
    CTNS: "CTN",
    CRATE: "CRT",
    CRATES: "CRT",
    DRUM: "DRM",
    DRUMS: "DRM",
    CONTAINER: "CON",
    CONTAINERS: "CON",
    BOXES: "BOX",
    BUNDLE: "BDL",
    BUNDLES: "BDL",
    ENVELOPE: "ENV",
    ENVELOPES: "ENV",
    CYLINDER: "CYL",
    CYLINDERS: "CYL",
    CASE: "CAS",
    CASES: "CAS",
    TRUCKLOAD: "TRUCK LOAD",
    TL: "TRUCK LOAD",
    FTL: "TRUCK LOAD",
    OTHER: "OTH",
    UNKNOWN: "OTH",
    TOTAL: "TOT",
  };
  if (aliases[key]) return aliases[key];
  if (aliases[upper]) return aliases[upper];

  const looksLikePallet =
    Number(row.qty) > 0 ||
    (Number(row.length) > 0 && Number(row.width) > 0) ||
    Number(row.weight) > 0;
  return looksLikePallet ? "PLT" : "OTH";
}

/**
 * Normalize freightInfo rows for Primus rate query.
 * @param {Array<object>} freightInfo Raw freight lines.
 * @return {Array<object>}
 */
function normalizeFreightInfoForRate(freightInfo) {
  const rows = Array.isArray(freightInfo) ? freightInfo : [];
  return rows.map((row) => {
    const r = row && typeof row === "object" ? {...row} : {};
    r.dimType = normalizeDimType(r.dimType, r);
    return r;
  });
}

/**
 * Builds query params for GET /rate/multiple per Primus API docs.
 * @param {object} lane shipper, consignee, freightInfo, accessorials.
 * @param {object} [opts] customerId, UOM, pickupDate, rateTypes, etc.
 * @return {object}
 */
function buildRateMultipleQuery(lane, opts = {}) {
  const ship = lane.shipper || {};
  const cons = lane.consignee || {};
  const freightInfo = normalizeFreightInfoForRate(lane.freightInfo || []);
  const params = {
    originCity: String(ship.city || "").trim(),
    originState: String(ship.state || "").trim(),
    originZipcode: String(ship.zipCode || ship.zipcode || "").trim(),
    originCountry: normalizeIsoCountry(ship.country),
    destinationCity: String(cons.city || "").trim(),
    destinationState: String(cons.state || "").trim(),
    destinationZipcode: String(cons.zipCode || cons.zipcode || "").trim(),
    destinationCountry: normalizeIsoCountry(cons.country),
    UOM: String(opts.UOM || lane.UOM || "US").trim() || "US",
    freightInfo: JSON.stringify(freightInfo),
  };

  const custId = opts.customerId || opts.shippingLocationId;
  if (custId) params.customerId = String(custId);

  if (opts.pickupDate || lane.readyDate) {
    params.pickupDate = String(opts.pickupDate || lane.readyDate);
  }
  if (opts.timeout != null) params.timeout = String(opts.timeout);
  if (opts.returnValidAccsOnly != null) {
    params.returnValidAccsOnly = String(!!opts.returnValidAccsOnly);
  }
  if (opts.insuranceAmount != null) {
    params.insuranceAmount = String(opts.insuranceAmount);
  }

  const acc = lane.accessorials;
  if (Array.isArray(acc) && acc.length) {
    if (ACCESSORIAL_PARAM_STYLE === "json") {
      params.accessorials = JSON.stringify(acc);
    } else {
      params["accessorialsList[]"] = acc.map(String);
    }
  }

  const accData = lane.accessorialsWithData;
  if (Array.isArray(accData) && accData.length) {
    params.accessorialsWithData = JSON.stringify(accData);
  }

  const rateTypes = opts.rateTypes ||
    (opts.includeGuaranteed ? ["LTL", "GUARANTEED"] : ["LTL"]);
  params["rateTypesList[]"] = rateTypes.map(String);

  return params;
}

/**
 * Applies margin to carrier cost.
 * @param {number} cost Carrier cost.
 * @param {object} [opts] billToTotal, marginPercent, marginMinDollars.
 * @return {number|null}
 */
function computeSellRate(cost, opts = {}) {
  const billTo = Number(opts.billToTotal);
  if (Number.isFinite(billTo) && billTo > 0) return billTo;
  const c = Number(cost);
  if (!Number.isFinite(c)) return null;
  const pct = Number(opts.marginPercent);
  const min = Number(opts.marginMinDollars);
  let sell = c;
  if (Number.isFinite(pct) && pct > 0) {
    sell = c * (1 + pct / 100);
  } else {
    sell = c + (Number.isFinite(min) ? min : 10);
  }
  return Math.round(sell * 100) / 100;
}

/**
 * Tags rate options for dispatcher (reliable / fast / economy).
 * @param {Array<object>} rates Rated rows with total, transitDays, warnings.
 * @param {object} [prefs] Customer preferences.
 * @return {Array<object>}
 */
function tagRateOptions(rates, prefs = {}) {
  const rows = (Array.isArray(rates) ? rates : []).map((r) => ({...r}));
  if (!rows.length) return rows;
  let ecoIdx = 0;
  let fastIdx = 0;
  let minSell = Infinity;
  let minTransit = Infinity;
  rows.forEach((r, i) => {
    const t = Number(r.total);
    const td = Number(r.transitDays);
    if (Number.isFinite(t) && t < minSell) {
      minSell = t;
      ecoIdx = i;
    }
    if (Number.isFinite(td) && td < minTransit) {
      minTransit = td;
      fastIdx = i;
    }
  });
  return rows.map((r, i) => {
    const tags = [];
    if (i === ecoIdx) tags.push("economy");
    if (i === fastIdx) tags.push("fast");
    const scac = String(r.SCAC || r.scac || "").toUpperCase();
    const reliableList = prefs.reliableScacs || [];
    if (reliableList.some((x) => scac === String(x).toUpperCase())) {
      tags.push("reliable");
    } else if (!r.warnings && tags.length === 0 && i === 0) {
      tags.push("reliable");
    }
    if (r.guaranteed) tags.push("guaranteed");
    return {...r, tags: [...new Set(tags)]};
  });
}

/**
 * Filters carriers blocked for lane (warnings contain block phrase).
 * @param {Array<object>} rates Rate rows.
 * @param {Array<string>} blockContains Substrings in warnings to exclude.
 * @return {Array<object>}
 */
function filterBlockedCarriers(rates, blockContains = []) {
  if (!blockContains.length) return rates;
  return rates.filter((r) => {
    const w = String(r.warnings || r.rateRemarks || "").toLowerCase();
    if (!w) return true;
    return !blockContains.some((phrase) =>
      w.includes(String(phrase).toLowerCase()));
  });
}

/**
 * Picks top N options per lane.
 * @param {Array<object>} rates Tagged rates with sellRate.
 * @param {number} [n] Max options.
 * @param {object} [opts] ensureGuaranteed, mode ("cheapest"|"diverse").
 * @return {Array<object>}
 */
function pickTopOptions(rates, n = 4, opts = {}) {
  const sorted = [...rates].sort((a, b) =>
    (Number(a.sellRate) || Infinity) - (Number(b.sellRate) || Infinity));
  const out = [];
  const seenScac = new Set();
  const cheapestMode = opts.mode === "cheapest";

  if (opts.ensureGuaranteed) {
    const bestGuaranteed = sorted.find((r) => r.guaranteed);
    if (bestGuaranteed) {
      out.push(bestGuaranteed);
      seenScac.add(String(bestGuaranteed.SCAC || bestGuaranteed.name || "")
          .slice(0, 20));
    }
  }

  for (const r of sorted) {
    if (out.length >= n) break;
    if (out.includes(r)) continue;
    if (!cheapestMode) {
      const scac = String(r.SCAC || r.name || "").slice(0, 20);
      if (seenScac.has(scac) && out.length >= 2) continue;
      seenScac.add(scac);
    }
    out.push(r);
  }
  return out;
}

module.exports = {
  init,
  fetchMultipleRates,
  fetchSingleRate,
  saveRate,
  searchShippingLocations,
  getShippingLocationById,
  resolveCustomerForQuote,
  pickBestCustomerMatch,
  fetchVendorsByCustomer,
  fetchRateTypes,
  searchCostQuotes,
  fetchCostQuote,
  fetchAccessorialCatalog,
  fetchAccessorialCatalogRaw,
  parseAccessorialCatalogResponse,
  buildRateMultipleQuery,
  computeSellRate,
  tagRateOptions,
  filterBlockedCarriers,
  pickTopOptions,
  normalizeRateRow,
  parseRatesFromResponse,
  normalizeIsoCountry,
  normalizeDimType,
  normalizeFreightInfoForRate,
};
