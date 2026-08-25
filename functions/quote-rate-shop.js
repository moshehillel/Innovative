/**
 * Primus LTL rate shop — GET /rate, /rate/multiple, POST /rate/save.
 * Params aligned with Primus API v1 docs (Rates section).
 */

"use strict";

const quoteOutput = require("./quote-output");
const freightDims = require("./quote-freight-dims");

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
 * Keeps only dispatcher-facing fields — Primus returns large nested
 * payloads that must not be written into quoteRequests docs.
 * @param {object} r Raw rate.
 * @return {object}
 */
function normalizeRateRow(r) {
  const remarks = Array.isArray(r.rateRemarks) ?
    r.rateRemarks.join(" ") :
    (r.rateRemarks || "");
  const rawWarnings = r.warnings || remarks || "";
  const warnings = quoteOutput.cleanCarrierNote(rawWarnings);
  const guaranteed =
    r.guaranteed === true ||
    String(r.rateType || "").toUpperCase() === "GUARANTEED";
  const billTo = r.billTo && typeof r.billTo === "object" ? {
    total: r.billTo.total != null ? r.billTo.total : null,
  } : null;
  return {
    name: r.name || r.carrierName || null,
    SCAC: r.SCAC || r.scac || null,
    total: r.total != null ? r.total : null,
    transitDays: r.transitDays != null ? r.transitDays : null,
    rateType: r.rateType || null,
    mode: r.mode || null,
    serviceType: r.serviceType || null,
    quoteNumber: r.quoteNumber || r.accountNumber || null,
    rateId: r.rateId || r.id || null,
    vendorId: r.vendorId || null,
    billTo,
    warnings: String(warnings || "").slice(0, 500),
    guaranteed,
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
 * Parses noRates carrier failures from /rate/multiple response.
 * @param {object} json API JSON body.
 * @return {Array<object>}
 */
function parseNoRatesFromResponse(json) {
  const results = json && json.data && json.data.results;
  if (!results || typeof results !== "object") return [];
  return Array.isArray(results.noRates) ? results.noRates : [];
}

/**
 * Summarizes Primus noRates errors for dispatcher UI.
 * @param {Array<object>} noRates Carrier failure rows.
 * @return {string|null}
 */
function summarizeNoRateErrors(noRates) {
  const rows = Array.isArray(noRates) ? noRates : [];
  if (!rows.length) return null;
  const tallies = new Map();
  for (const row of rows) {
    const err = String((row && row.error) || "Unknown carrier error").trim();
    if (!err) continue;
    tallies.set(err, (tallies.get(err) || 0) + 1);
  }
  if (!tallies.size) return "No rates returned from Primus.";
  const ranked = [...tallies.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([err, n]) => `${err} (${n})`);
  return `Primus returned no rates: ${ranked.join("; ")}`;
}

/**
 * Dispatcher-visible warning when customer tariffs are empty and we
 * show market rates instead. Never imply those are contract rates.
 */
const MARKET_FALLBACK_WARNING =
  "Primus customer matched but no customer tariffs — showing market rates.";

/**
 * Always retry /rate/multiple without customerId when the customer
 * call returned no rates — empty noRates, profile errors, class
 * errors, or any other Primus miss.
 * @param {Array<object>} [_noRates] Carrier failure rows (unused).
 * @return {boolean}
 */
function shouldRetryRatesWithoutCustomer(_noRates) {
  return true;
}

/**
 * @param {object} params Flat + array query params for /rate/multiple.
 * @return {Promise<object>} {ok, rates, noRates, raw}
 */
async function fetchMultipleRates(params) {
  const {query, queryArrays} = splitRateQueryParams(params);
  const json = await primusFetch("/rate/multiple", {query, queryArrays});
  return {
    ok: true,
    rates: parseRatesFromResponse(json),
    noRates: parseNoRatesFromResponse(json),
    raw: json,
  };
}

/**
 * GET /rate — single carrier re-rate.
 * @param {object} params Query params (same as /rate/multiple).
 * @return {Promise<object>}
 */
async function fetchSingleRate(params) {
  const {query, queryArrays} = splitRateQueryParams(params);
  const json = await primusFetch("/rate", {query, queryArrays});
  return {
    ok: true,
    rates: parseRatesFromResponse(json),
    noRates: parseNoRatesFromResponse(json),
    raw: json,
  };
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
 * Loose company-name normalize for Primus customer matching.
 * @param {string} value Raw name.
 * @return {string}
 */
function normalizeCustomerName(value) {
  return String(value || "")
      .toLowerCase()
      .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, " ")
      .replace(/\b(inc|llc|ltd|corp|corporation|co|company)\b\.?/g, "")
      .replace(/\s+/g, " ")
      .trim();
}

/** Role/legal words that should not drive Primus customer search. */
const GENERIC_CUSTOMER_NAME_TOKENS = new Set([
  "inc", "llc", "ltd", "corp", "corporation", "co", "company",
  "warehouse", "warehousing", "shipping", "logistics", "freight",
  "trucking", "distribution", "dist", "dc", "plant", "facility",
  "kitchenware", "kitchen", "the", "and", "of", "group", "services",
  "service", "international", "intl", "usa", "america", "us",
  "united", "american", "national", "global", "general", "first",
  "new", "great", "best", "city", "state", "north", "south", "east",
  "west",
]);

/**
 * Distinctive tokens from a company / shipper name.
 * @param {string} value Raw or normalized name.
 * @return {Array<string>}
 */
function distinctiveCustomerNameTokens(value) {
  return normalizeCustomerName(value)
      .split(" ")
      .filter((t) => t.length >= 4 && !GENERIC_CUSTOMER_NAME_TOKENS.has(t));
}

/**
 * Extra Primus search strings for a company name.
 * Primus `name=` is phrase-like, so "Kadra Warehouse" misses
 * "Kadra Kitchenware"; also search the distinctive first token.
 * @param {string} term Raw search term.
 * @return {Array<string>}
 */
function expandCustomerSearchTerms(term) {
  const out = [];
  const add = (raw) => {
    const t = String(raw || "").trim();
    if (t.length < 2) return;
    if (/^\d+$/.test(t)) return;
    if (!out.some((s) => s.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  add(term);
  const tokens = distinctiveCustomerNameTokens(term);
  for (const tok of tokens) {
    if (tok.length >= 4) add(tok);
  }
  return out;
}

/**
 * True when query and Primus names share a distinctive 5+ char token.
 * "Kadra Warehouse" matches "Kadra Kitchenware"; "Acme Warehouse"
 * does not match "Acme Industries".
 * @param {string} wantRaw Query name.
 * @param {string} haveRaw Primus location name.
 * @return {boolean}
 */
function customerNamesShareDistinctiveToken(wantRaw, haveRaw) {
  const wantToks = distinctiveCustomerNameTokens(wantRaw);
  const haveToks = distinctiveCustomerNameTokens(haveRaw);
  if (!wantToks.length || !haveToks.length) return false;
  const haveSet = new Set(haveToks);
  return wantToks.some((t) => t.length >= 5 && haveSet.has(t));
}

/**
 * Picks best customer match from search results.
 * @param {Array<object>} results Shipping locations.
 * @param {object} opts from email, customerRef, customerName.
 * @return {object|null}
 */
function pickBestCustomerMatch(results, opts = {}) {
  if (!Array.isArray(results) || !results.length) return null;
  const from = String(opts.from || "").toLowerCase();
  const ref = String(opts.customerRef || "").toLowerCase();
  const wantName = normalizeCustomerName(
      opts.customerName || opts.name || "");

  if (wantName) {
    for (const row of results) {
      if (normalizeCustomerName(row.name) === wantName) return row;
    }
    for (const row of results) {
      const name = normalizeCustomerName(row.name);
      if (name && (name.includes(wantName) || wantName.includes(name))) {
        return row;
      }
    }
    for (const row of results) {
      if (customerNamesShareDistinctiveToken(wantName, row.name)) {
        return row;
      }
    }
  }

  for (const row of results) {
    const email = String(row.email || "").toLowerCase();
    if (email && from.includes(email)) return row;
  }
  // Name-driven search: do not pick an unrelated customer:true hit.
  if (wantName) return null;
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
 * @param {object} opts from, customerRef, customerName, searchTerms[].
 * @return {Promise<object|null>} {id, name, code, customer}
 */
async function resolveCustomerForQuote(opts = {}) {
  const from = String(opts.from || "");
  const emailMatch = from.match(/<([^>]+@[^>]+)>|([\w.+-]+@[\w.-]+)/);
  const email = emailMatch ? (emailMatch[1] || emailMatch[2]) : "";
  const searches = [];
  const addSearch = (term) => {
    for (const t of expandCustomerSearchTerms(term)) {
      if (!searches.some((s) => s.toLowerCase() === t.toLowerCase())) {
        searches.push(t);
      }
    }
  };

  // Dispatcher-entered customer name is the strongest signal.
  addSearch(opts.customerName || opts.name || "");

  if (email.includes("@")) {
    const local = email.split("@")[0];
    const domain = email.split("@")[1];
    const domainStem = domain.split(".")[0];
    if (domainStem.length > 2) addSearch(domainStem);
    if (local.length > 2) addSearch(local);
  }

  const domainMatch = from.match(/@([\w.-]+)/);
  if (domainMatch) {
    const stem = domainMatch[1].split(".")[0];
    if (stem.length > 2) addSearch(stem);
  }

  for (const term of opts.searchTerms || []) {
    addSearch(term);
  }

  const matchOpts = {
    from: opts.from,
    customerRef: opts.customerRef,
    customerName: opts.customerName || opts.name || "",
  };

  const searchesTried = [];
  for (const term of searches) {
    searchesTried.push(term);
    try {
      const res = await searchShippingLocations({
        name: term,
        limit: 10,
        active: true,
        isCustomer: true,
      });
      const best = pickBestCustomerMatch(res.results, matchOpts);
      if (best && best.id) {
        return {
          id: String(best.id),
          name: best.name || null,
          code: best.code || null,
          customer: best.customer === true,
          email: best.email || null,
          searchTerm: term,
          searchesTried,
        };
      }
    } catch (err) {
      console.warn("resolveCustomerForQuote search failed", term,
          err && err.message);
    }
  }
  return {id: null, name: null, searchesTried};
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

/** Valid NMFC freight classes Primus accepts on LTL rate calls. */
const VALID_NMFC_CLASSES = new Set([
  50, 55, 60, 65, 70, 77.5, 85, 92.5, 100, 110, 125, 150, 175,
  200, 250, 300, 400, 500,
]);

/**
 * Primus-compatible NMFC density → class table (pcf / lbs per cu ft).
 * Matches Primus booking samples (density + class on pieces).
 * Tenant /tools/densityrules is empty, so we use this local table.
 */
const DENSITY_CLASS_TABLE = [
  {minPcf: 50, freightClass: 50},
  {minPcf: 35, freightClass: 55},
  {minPcf: 30, freightClass: 60},
  {minPcf: 22.5, freightClass: 65},
  {minPcf: 15, freightClass: 70},
  {minPcf: 13.5, freightClass: 77.5},
  {minPcf: 12, freightClass: 85},
  {minPcf: 10.5, freightClass: 92.5},
  {minPcf: 9, freightClass: 100},
  {minPcf: 8, freightClass: 110},
  {minPcf: 7, freightClass: 125},
  {minPcf: 6, freightClass: 150},
  {minPcf: 5, freightClass: 175},
  {minPcf: 4, freightClass: 200},
  {minPcf: 3, freightClass: 250},
  {minPcf: 2, freightClass: 300},
  {minPcf: 1, freightClass: 400},
  {minPcf: 0, freightClass: 500},
];

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
    // AI sometimes writes unit word as packaging type.
    CM: "PLT",
    CMS: "PLT",
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
 * True when value is a Primus-accepted NMFC freight class.
 * @param {*} value Raw class from extract / dispatcher.
 * @return {boolean}
 */
function isValidFreightClass(value) {
  if (value == null || value === "") return false;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return false;
  return VALID_NMFC_CLASSES.has(n);
}

/**
 * Map density (lbs per cubic foot) to NMFC class.
 * @param {number} densityPcf Pounds per cubic foot.
 * @return {number|null}
 */
function classFromDensity(densityPcf) {
  const d = Number(densityPcf);
  if (!Number.isFinite(d) || d < 0) return null;
  for (const row of DENSITY_CLASS_TABLE) {
    if (d >= row.minPcf) return row.freightClass;
  }
  return 500;
}

/**
 * Cubic feet for one piece from L×W×H.
 * @param {object} row Freight line.
 * @param {string} [uom] "US" (inches) or metric (cm).
 * @return {number|null}
 */
function cubicFeetPerPiece(row, uom = "US") {
  const length = Number(row && row.length);
  const width = Number(row && row.width);
  const height = Number(row && row.height);
  if (!(length > 0 && width > 0 && height > 0)) return null;
  const vol = length * width * height;
  const isUs = String(uom || "US").toUpperCase() === "US";
  // US dims are inches → /1728. Metric dims are cm → /28316.846592.
  const cft = isUs ? (vol / 1728) : (vol / 28316.846592);
  return cft > 0 ? cft : null;
}

/**
 * Density (pcf) for a freight line from weight + dims.
 * @param {object} row Freight line.
 * @param {string} [uom] UOM for dim units.
 * @return {{density: number, totalWeight: number, cubicFeet: number}|null}
 */
function densityFromFreightRow(row, uom = "US") {
  if (!row || typeof row !== "object") return null;
  const weight = Number(row.weight);
  if (!(weight > 0)) return null;
  const cftEach = cubicFeetPerPiece(row, uom);
  if (!(cftEach > 0)) return null;
  const qty = Number(row.qty);
  const pieces = qty > 0 ? qty : 1;
  const wt = String(row.weightType || "").trim().toLowerCase();
  const weightIsEach =
    wt === "each" || wt === "perpiece" || wt === "per-piece";
  const totalWeight = weightIsEach ? weight * pieces : weight;
  const totalCft = cftEach * pieces;
  if (!(totalWeight > 0 && totalCft > 0)) return null;
  return {
    density: totalWeight / totalCft,
    totalWeight,
    cubicFeet: totalCft,
  };
}

/**
 * Always prefer Primus density class (weight + L×W×H) over email class.
 * When dims/weight are insufficient, keep a valid previous class.
 * Primus /tools/densityrules is empty for this tenant; table matches
 * Primus booking density/class pairs.
 * @param {Array<object>} freightInfo Freight lines.
 * @param {object} [opts] UOM.
 * @return {{freightInfo: Array<object>, filled: number,
 *   overwritten: number, unresolved: Array<object>}}
 */
function ensureFreightClasses(freightInfo, opts = {}) {
  const uom = opts.UOM || opts.uom || "US";
  const rows = Array.isArray(freightInfo) ? freightInfo : [];
  const unresolved = [];
  let filled = 0;
  let overwritten = 0;
  const next = rows.map((row, idx) => {
    const r = row && typeof row === "object" ? {...row} : {};
    const prevClass = isValidFreightClass(r.class) ? Number(r.class) : null;
    const dens = densityFromFreightRow(r, uom);
    const cls = dens ? classFromDensity(dens.density) : null;
    if (cls != null) {
      if (prevClass != null && prevClass !== cls) {
        r.emailClass = prevClass;
        overwritten += 1;
      } else if (prevClass == null && r.class != null && r.class !== "") {
        r.emailClass = r.class;
      }
      r.class = cls;
      r.classSource = "density";
      if (dens.density > 0) {
        r.density = Math.round(dens.density * 1000) / 1000;
      }
      filled += 1;
      return r;
    }
    if (prevClass != null) {
      r.class = prevClass;
      if (!r.classSource) r.classSource = "email";
      return r;
    }
    if (r.class == null || r.class === "") delete r.class;
    else r.class = null;
    unresolved.push({
      index: idx,
      reason: !(Number(r.weight) > 0) ?
        "missing weight" :
        "missing or invalid length/width/height",
    });
    return r;
  });
  return {freightInfo: next, filled, overwritten, unresolved};
}

/**
 * Normalize freightInfo rows for Primus rate query.
 * @param {Array<object>} freightInfo Raw freight lines.
 * @param {object} [opts] UOM for density class fill.
 * @return {Array<object>}
 */
function normalizeFreightInfoForRate(freightInfo, opts = {}) {
  const dimmed = freightDims.normalizePalletFreightRows(freightInfo);
  const ensured = ensureFreightClasses(dimmed, opts);
  return ensured.freightInfo.map((row) => {
    const r = row && typeof row === "object" ? {...row} : {};
    r.dimType = normalizeDimType(r.dimType, r);
    // Primus requires weightType; AI extract often omits it.
    // Default total unless clearly per-piece (never treat omitted as each).
    const wt = String(r.weightType || "").trim().toLowerCase();
    r.weightType = (wt === "each" || wt === "perpiece" || wt === "per-piece") ?
      "each" : "total";
    // Drop density helper fields from rate payload (UI may keep on quote).
    delete r.density;
    delete r.classSource;
    delete r.emailClass;
    // Still omit blank/invalid class so market rating can density-calc.
    if (!isValidFreightClass(r.class)) delete r.class;
    else r.class = Number(r.class);
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
  const uom = String(opts.UOM || lane.UOM || "US").trim() || "US";
  const freightInfo = normalizeFreightInfoForRate(lane.freightInfo || [], {
    UOM: uom,
  });
  const params = {
    originCity: String(ship.city || "").trim(),
    originState: String(ship.state || "").trim(),
    originZipcode: String(ship.zipCode || ship.zipcode || "").trim(),
    originCountry: normalizeIsoCountry(ship.country),
    destinationCity: String(cons.city || "").trim(),
    destinationState: String(cons.state || "").trim(),
    destinationZipcode: String(cons.zipCode || cons.zipcode || "").trim(),
    destinationCountry: normalizeIsoCountry(cons.country),
    UOM: uom,
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
 * Customer contract rates (billTo.total or rateSource customer) pass through.
 * Market rates: cost + min(flat $ markup, percent of cost), default $55 / 10%.
 * All sell rates round UP to the next whole dollar (Math.ceil).
 * @param {number} cost Carrier cost.
 * @param {object} [opts] billToTotal, rateSource, marginPercent,
 *   marginMinDollars.
 * @return {number|null}
 */
function computeSellRate(cost, opts = {}) {
  const billTo = Number(opts.billToTotal);
  if (Number.isFinite(billTo) && billTo > 0) return Math.ceil(billTo);
  const c = Number(cost);
  if (!Number.isFinite(c)) return null;
  if (opts.rateSource === "customer") {
    return Math.ceil(c);
  }
  const flat = Number.isFinite(Number(opts.marginMinDollars)) ?
    Number(opts.marginMinDollars) : 55;
  const pct = Number.isFinite(Number(opts.marginPercent)) &&
    Number(opts.marginPercent) > 0 ?
    Number(opts.marginPercent) : 10;
  const markup = Math.min(flat, c * (pct / 100));
  const sell = c + markup;
  return Math.ceil(sell);
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
  const cheapestMode = opts.mode === "cheapest";

  // Cheapest mode: always rank by sellRate. Do not float guaranteed to the top
  // (that hid the lowest option — see Q#D7365).
  if (cheapestMode) {
    let out = sorted.slice(0, n);
    if (opts.ensureGuaranteed && !out.some((r) => r.guaranteed)) {
      const bestGuaranteed = sorted.find((r) => r.guaranteed);
      if (bestGuaranteed && !out.includes(bestGuaranteed)) {
        if (out.length < n) {
          out.push(bestGuaranteed);
        } else {
          out = [...sorted.slice(0, n - 1), bestGuaranteed];
        }
        out.sort((a, b) =>
          (Number(a.sellRate) || Infinity) - (Number(b.sellRate) || Infinity));
      }
    }
    return out;
  }

  const out = [];
  const seenScac = new Set();
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
    const scac = String(r.SCAC || r.name || "").slice(0, 20);
    if (seenScac.has(scac) && out.length >= 2) continue;
    seenScac.add(scac);
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
  expandCustomerSearchTerms,
  normalizeCustomerName,
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
  parseNoRatesFromResponse,
  summarizeNoRateErrors,
  shouldRetryRatesWithoutCustomer,
  MARKET_FALLBACK_WARNING,
  normalizeIsoCountry,
  normalizeDimType,
  normalizeFreightInfoForRate,
  isValidFreightClass,
  classFromDensity,
  cubicFeetPerPiece,
  densityFromFreightRow,
  ensureFreightClasses,
  VALID_NMFC_CLASSES,
  DENSITY_CLASS_TABLE,
  freightDims,
};
