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
  ensureDensityRulesLoaded().catch(() => {});
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
  const extraNotes = [
    r.notes,
    r.notesExternal,
    r.carrierNote,
    r.carrierNotes,
  ].filter(Boolean).join(" ");
  const rawWarnings = r.warnings || remarks || extraNotes || "";
  const warnings = quoteOutput.cleanCarrierNote(rawWarnings);
  const guaranteed =
    r.guaranteed === true ||
    String(r.rateType || "").toUpperCase() === "GUARANTEED";
  const billTo = r.billTo && typeof r.billTo === "object" ? {
    total: r.billTo.total != null ? r.billTo.total : null,
  } : null;
  // Keep both id and rateId — dispatcher serialize / selections key on o.id.
  const rateId = r.rateId != null ? r.rateId :
    (r.id != null ? r.id : null);
  return {
    id: rateId,
    name: r.name || r.carrierName || null,
    SCAC: r.SCAC || r.scac || null,
    total: r.total != null ? r.total : null,
    transitDays: r.transitDays != null ? r.transitDays : null,
    rateType: r.rateType || null,
    mode: r.mode || null,
    serviceType: r.serviceType || null,
    quoteNumber: r.quoteNumber || r.accountNumber || null,
    rateId,
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
  "Primus customer matched but no customer tariffs — showing market rates. " +
  "If this account is protocol-only / FAK, confirm the Primus customer " +
  "profile has active carrier tariffs (Customer Profile not found usually " +
  "means Primus config, not Jerry).";

/**
 * Warning when market costs are re-marked with the customer's Primus FAK
 * (Pricing tab) because /rate/multiple with customerId returned nothing.
 * @param {object} [fak] Normalized FAK {rate, type, min}.
 * @return {string}
 */
function marketFallbackFakWarning(fak = {}) {
  const rate = Number(fak.rate);
  const min = Number(fak.min);
  const type = String(fak.type || "profit%");
  const rateLabel = Number.isFinite(rate) ? String(rate) : "?";
  const minLabel = Number.isFinite(min) ? String(min) : "?";
  return "No carrier contract profiles — market costs with FAK markup " +
    `(${rateLabel}% ${type}, min $${minLabel}).`;
}

/**
 * Built-in FAK overrides keyed by Primus REST shipping location id.
 * Primary source is manage.php getShippingLocationsCarrierMarkups
 * (see fetchCustomerFakPricingFromPrimus). Keep this map / env for
 * overrides when Primus UI is unreachable or a rule must be forced.
 * Mike Oseback protocol only: Rate 15 / Type Profit% / Min 80.
 * @type {Object<string, {rate: number, type: string, min: number}>}
 */
const CUSTOMER_FAK_BY_ID = {
  "779538209": {rate: 15, type: "profit%", min: 80},
};

/** In-memory FAK cache: restId → {expiresAt, value}. */
const fakPricingLiveCache = new Map();
const FAK_LIVE_CACHE_TTL_MS = 60 * 60 * 1000;

/** Optional test double for live Primus FAK fetch. */
let fetchFakPricingImplForTest = null;

/** Cached manage.php PHPSESSID for FAK lookups (process-local). */
let fakManageSession = null;
let fakManageSessionAt = 0;
const FAK_MANAGE_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * @return {Object<string, object>} Merged built-in + env FAK map.
 */
function customerFakPricingMap() {
  const out = {...CUSTOMER_FAK_BY_ID};
  const raw = String(process.env.QUOTE_CUSTOMER_FAK_JSON || "").trim();
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [id, row] of Object.entries(parsed)) {
        const norm = normalizeFakPricing(row);
        if (norm) out[String(id)] = norm;
      }
    }
  } catch (err) {
    console.warn("QUOTE_CUSTOMER_FAK_JSON parse failed",
        err && err.message);
  }
  return out;
}

/**
 * Maps Primus Pricing-tab type codes to Jerry FAK types.
 * UI: P=Profit%, F/FL=Flat, M=Money, FRT=Freight %, G=GP %.
 * @param {string} typeRaw Raw type from config or manage.php.
 * @return {string} profit% | markup% | flat
 */
function normalizeFakTypeCode(typeRaw) {
  const t = String(typeRaw || "profit%")
      .toLowerCase()
      .replace(/\s+/g, "");
  if (t === "f" || t === "fl" || t === "flat" || t === "dollar" ||
      t === "$" || t === "m" || t === "money") {
    return "flat";
  }
  if (t === "frt" || t.includes("freight") || t.includes("markup")) {
    return "markup%";
  }
  // P, profit%, g/gp%, bare % → profit floor on cost
  return "profit%";
}

/**
 * Normalizes a FAK / Pricing-tab markup rule.
 * Primus: Rate + Type Profit% + Min $ → profit = max(cost×rate%, min).
 * @param {object|null|undefined} raw Raw config.
 * @return {{rate: number, type: string, min: number}|null}
 */
function normalizeFakPricing(raw) {
  if (!raw || typeof raw !== "object") return null;
  const rate = Number(raw.rate != null ? raw.rate : raw.percent);
  const min = Number(raw.min != null ? raw.min : raw.minDollars);
  if (!Number.isFinite(rate) || rate < 0) return null;
  if (!Number.isFinite(min) || min < 0) return null;
  const type = normalizeFakTypeCode(raw.type || raw.markupType || "profit%");
  return {rate, type, min};
}

/**
 * Looks up configured FAK override for a Primus REST shipping location id.
 * @param {string|number|null|undefined} customerId Shipping location id.
 * @return {{rate: number, type: string, min: number}|null}
 */
function getCustomerFakPricing(customerId) {
  const id = customerId != null ? String(customerId).trim() : "";
  if (!id) return null;
  return normalizeFakPricing(customerFakPricingMap()[id]) || null;
}

/**
 * Best-effort parse if Primus ever returns Pricing fields on a SL row.
 * REST shippinglocation has no FAK fields today — returns null.
 * @param {object|null|undefined} loc Shipping location row.
 * @return {{rate: number, type: string, min: number}|null}
 */
function parseFakPricingFromShippingLocation(loc) {
  if (!loc || typeof loc !== "object") return null;
  const candidates = [
    loc.fakPricing, loc.fak, loc.pricing, loc.pricingInfo,
    loc.markup, loc.customerPricing, loc.billingInfo && loc.billingInfo.fak,
    loc.billingInfo && loc.billingInfo.pricing,
  ];
  for (const c of candidates) {
    const norm = normalizeFakPricing(c);
    if (norm) return norm;
  }
  return null;
}

/**
 * Picks the best All-carriers FAK row from manage.php markups[].
 * Prefers active carrier=0 / "All", then first active row.
 * @param {Array<object>|null|undefined} markups Carrier markup rows.
 * @return {{rate: number, type: string, min: number}|null}
 */
function pickFakPricingFromCarrierMarkups(markups) {
  const rows = Array.isArray(markups) ? markups : [];
  const active = rows.filter((r) => {
    if (!r || typeof r !== "object") return false;
    if (String(r.erased || "0") === "1") return false;
    return String(r.active != null ? r.active : "1") !== "0";
  });
  if (!active.length) return null;
  const allCarrier = active.find((r) => {
    const carrier = String(r.carrier != null ? r.carrier : "");
    const name = String(r.carrierName || "").toLowerCase();
    return carrier === "0" || name === "all" || name === "all carriers";
  });
  const chosen = allCarrier || active[0];
  return normalizeFakPricing({
    rate: chosen.rate,
    min: chosen.min,
    type: chosen.type,
  });
}

/**
 * @return {string}
 */
function fakManageUrl() {
  return process.env.PRIMUS_UI_MANAGE_URL ||
    "https://shipprimus.com/PRIMUS/trunk/manage.php";
}

/**
 * @param {string|null|undefined} setCookie Set-Cookie header.
 * @return {string|null}
 */
function parsePhpSessId(setCookie) {
  const m = String(setCookie || "").match(/PHPSESSID=([^;,\s]+)/i);
  return m ? m[1] : null;
}

/**
 * Logs into Primus manage.php for FAK Pricing-tab reads.
 * @return {Promise<string>} PHPSESSID.
 */
async function loginFakManageSession() {
  const username = process.env.PRIMUS_UI_USERNAME ||
    process.env.PRIMUS_USERNAME || "";
  const password = process.env.PRIMUS_UI_PASSWORD ||
    process.env.PRIMUS_PASSWORD || "";
  if (!username || !password) {
    throw new Error("Primus UI credentials not configured for FAK lookup");
  }
  const body = new URLSearchParams({
    action: "login",
    logout: "false",
    loginUsername: username,
    loginPassword: password,
    browser: "Chrome",
    browserVersion: "149",
    os: "Windows",
  });
  const resp = await fetch(fakManageUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: body.toString(),
    redirect: "manual",
  });
  let session = parsePhpSessId(resp.headers.get("set-cookie"));
  if (!session && resp.headers.getSetCookie) {
    for (const c of resp.headers.getSetCookie() || []) {
      session = parsePhpSessId(c);
      if (session) break;
    }
  }
  if (!session) throw new Error("Primus UI login failed for FAK lookup");
  fakManageSession = session;
  fakManageSessionAt = Date.now();
  return session;
}

/**
 * @return {Promise<string>}
 */
async function getFakManageSession() {
  if (fakManageSession &&
      (Date.now() - fakManageSessionAt) < FAK_MANAGE_SESSION_TTL_MS) {
    return fakManageSession;
  }
  return loginFakManageSession();
}

/**
 * POST manage.php (FAK / shipping-location Pricing tab).
 * @param {object} params Form fields including action.
 * @param {boolean} [retryOnAuthFail=true] Re-login once.
 * @return {Promise<object|null>} Parsed JSON or null.
 */
async function fakManagePost(params, retryOnAuthFail = true) {
  // Prefer shared bridge session when available (same Cloud Function process).
  try {
    const bridge = require("./primus-ui-bridge");
    if (typeof bridge.managePhpPost === "function") {
      const res = await bridge.managePhpPost(params);
      if (res && res.json && typeof res.json === "object") return res.json;
      if (res && res.ok === false && retryOnAuthFail) {
        // fall through to direct login
      } else if (res && res.json == null && res.text) {
        try {
          return JSON.parse(res.text);
        } catch (_) {
          // continue
        }
      }
    }
  } catch (_) {
    // bridge optional / uninitialized
  }

  let cookie = await getFakManageSession();
  const doPost = async (sessionCookie) => {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (value == null) continue;
      form.set(key, typeof value === "object" ?
        JSON.stringify(value) : String(value));
    }
    const resp = await fetch(fakManageUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Cookie: `PHPSESSID=${sessionCookie}`,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: form.toString(),
    });
    const text = await resp.text();
    if (/no session started|session expired/i.test(text)) {
      const err = new Error("FAK manage session expired");
      err.authFailed = true;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  };

  try {
    return await doPost(cookie);
  } catch (err) {
    if (retryOnAuthFail && err && err.authFailed) {
      cookie = await loginFakManageSession();
      return doPost(cookie);
    }
    throw err;
  }
}

/**
 * Resolves manage.php shipping-location id (recordId) for a REST idHashed.
 * @param {string} restId REST shipping location id.
 * @param {object} [opts] customerName / shippingLocationName.
 * @return {Promise<string|null>} manage.php id.
 */
async function resolveManageShippingLocationId(restId, opts = {}) {
  const rest = String(restId || "").trim();
  if (!rest) return null;
  if (opts.manageShippingLocationId) {
    return String(opts.manageShippingLocationId).trim() || null;
  }

  const name = String(
      opts.customerName ||
      opts.shippingLocationName ||
      (opts.shippingLocation && (
        opts.shippingLocation.name ||
        opts.shippingLocation.companyName ||
        opts.shippingLocation.company)) ||
      "").trim();
  if (!name) return null;

  const listJson = await fakManagePost({
    action: "getShippingLocations",
    query: name.slice(0, 80),
    start: "0",
    limit: "25",
  });
  const rows = (listJson && listJson.shipping_locations) || [];
  const candidates = rows
      .filter((r) => r && r.id != null)
      .sort((a, b) => {
        // Prefer customer locations over ship-to-only rows.
        const ac = String(a.customer || "") === "1" ? 0 : 1;
        const bc = String(b.customer || "") === "1" ? 0 : 1;
        return ac - bc;
      })
      .slice(0, 8);

  for (const row of candidates) {
    const manageId = String(row.id);
    try {
      const detail = await fakManagePost({
        action: "getShippingLocation",
        recordId: manageId,
      });
      const data = detail && detail.data;
      if (!data) continue;
      if (String(data.idHashed) === rest || String(data.showLogId) === rest) {
        return manageId;
      }
    } catch (_) {
      // try next candidate
    }
  }

  // Single exact-name customer hit: accept without hash when unique.
  const exact = candidates.filter((r) =>
    String(r.name || "").trim().toLowerCase() === name.toLowerCase() &&
    String(r.customer || "") === "1");
  if (exact.length === 1) return String(exact[0].id);
  return null;
}

/**
 * Loads FAK Pricing-tab markup from Primus manage.php for a REST customer id.
 * Path: name → manage recordId → getShippingLocationsCarrierMarkups
 * (masterBillingType=FAK). REST /database/shippinglocation has no Pricing.
 * @param {string|number} customerId REST shipping location id.
 * @param {object} [opts] customerName, shippingLocation, manageShippingLocationId.
 * @return {Promise<{rate: number, type: string, min: number}|null>}
 */
async function fetchCustomerFakPricingFromPrimus(customerId, opts = {}) {
  if (typeof fetchFakPricingImplForTest === "function") {
    return fetchFakPricingImplForTest(customerId, opts);
  }
  const restId = customerId != null ? String(customerId).trim() : "";
  if (!restId) return null;

  const cached = fakPricingLiveCache.get(restId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let value = null;
  try {
    const fetchOpts = {...opts};
    if (!fetchOpts.customerName && !fetchOpts.shippingLocationName &&
        !(fetchOpts.shippingLocation && fetchOpts.shippingLocation.name)) {
      try {
        const loc = await getShippingLocationById(restId);
        if (loc && loc.name) {
          fetchOpts.shippingLocation = loc;
          fetchOpts.customerName = String(loc.name).trim();
        }
      } catch (_) {
        // name lookup optional
      }
    }
    const manageId = await resolveManageShippingLocationId(restId, fetchOpts);
    if (manageId) {
      const detail = await fakManagePost({
        action: "getShippingLocation",
        recordId: manageId,
      });
      const ratingType = String(
          (detail && detail.data && detail.data.ratingType) || "FAK");
      const profileId = String(
          (detail && detail.data && detail.data.profileId) || "0");
      const markupsJson = await fakManagePost({
        action: "getShippingLocationsCarrierMarkups",
        shippingLocationId: manageId,
        masterBillingType: ratingType || "FAK",
        profileId: profileId || "0",
      });
      value = pickFakPricingFromCarrierMarkups(
          markupsJson && markupsJson.markups);
    }
  } catch (err) {
    console.warn("fetchCustomerFakPricingFromPrimus failed",
        restId, err && err.message);
    value = null;
  }

  fakPricingLiveCache.set(restId, {
    expiresAt: Date.now() + FAK_LIVE_CACHE_TTL_MS,
    value,
  });
  return value;
}

/**
 * Sync FAK resolve (opts → SL parse → map override). No live Primus call.
 * @param {string|number|null|undefined} customerId Shipping location id.
 * @param {object} [opts] fakPricing override, shippingLocation row.
 * @return {{rate: number, type: string, min: number}|null}
 */
function resolveFakPricingForCustomer(customerId, opts = {}) {
  const fromOpts = normalizeFakPricing(opts.fakPricing);
  if (fromOpts) return fromOpts;
  const fromLoc = parseFakPricingFromShippingLocation(opts.shippingLocation);
  if (fromLoc) return fromLoc;
  return getCustomerFakPricing(customerId);
}

/**
 * Async FAK resolve for market-fallback: opts → map override → live manage
 * Pricing tab → SL parse.
 * @param {string|number|null|undefined} customerId REST shipping location id.
 * @param {object} [opts] fakPricing, shippingLocation, customerName.
 * @return {Promise<{rate: number, type: string, min: number}|null>}
 */
async function resolveFakPricingForCustomerAsync(customerId, opts = {}) {
  const fromOpts = normalizeFakPricing(opts.fakPricing);
  if (fromOpts) return fromOpts;
  // Explicit map/env override wins over live Primus (ops force / cache).
  const fromMap = getCustomerFakPricing(customerId);
  if (fromMap) return fromMap;
  const fromLoc = parseFakPricingFromShippingLocation(opts.shippingLocation);
  if (fromLoc) return fromLoc;
  return fetchCustomerFakPricingFromPrimus(customerId, opts);
}

/**
 * @param {Function|null} fn Test double (customerId, opts) => fak|null|Promise.
 * @return {void}
 */
function setFetchFakPricingImplForTest(fn) {
  fetchFakPricingImplForTest = fn;
  fakPricingLiveCache.clear();
}

/**
 * @return {void}
 */
function clearFakPricingLiveCacheForTest() {
  fakPricingLiveCache.clear();
  fakManageSession = null;
  fakManageSessionAt = 0;
}

/**
 * True for market / FAK market-fallback rateSource values.
 * @param {string|null|undefined} rateSource Rate source tag.
 * @return {boolean}
 */
function isMarketFallbackRateSource(rateSource) {
  const s = String(rateSource || "");
  return s === "market_fallback" || s === "market_fallback_fak";
}

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
  await ensureDensityRulesLoaded();
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

/** TTL for cached GET /tools/companydensityrules (ms). */
const COMPANY_DENSITY_RULES_TTL_MS = 60 * 60 * 1000;

/**
 * Primus company density rules fallback when GET /tools/companydensityrules
 * fails (production REST currently 404). Matches sandbox company defaults.
 */
const FALLBACK_DENSITY_RULES = [
  {densityFrom: 50, densityTo: -1, class: 50},
  {densityFrom: 35, densityTo: 50, class: 55},
  {densityFrom: 30, densityTo: 35, class: 60},
  {densityFrom: 22.5, densityTo: 30, class: 65},
  {densityFrom: 15, densityTo: 22.5, class: 70},
  {densityFrom: 12, densityTo: 15, class: 85},
  {densityFrom: 10, densityTo: 12, class: 92.5},
  {densityFrom: 8, densityTo: 10, class: 100},
  {densityFrom: 6, densityTo: 8, class: 125},
  {densityFrom: 4, densityTo: 6, class: 175},
  {densityFrom: 2, densityTo: 4, class: 250},
  {densityFrom: 1, densityTo: 2, class: 300},
  {densityFrom: 0, densityTo: 1, class: 400},
];

/** @type {{rules: Array<object>, fetchedAt: number, source: string}|null} */
let densityRulesCache = null;
/** @type {Promise<void>|null} */
let densityRulesLoadPromise = null;

/**
 * Legacy minPcf table derived from {@link FALLBACK_DENSITY_RULES} for tests.
 * @type {Array<{minPcf: number, freightClass: number}>}
 */
const DENSITY_CLASS_TABLE = FALLBACK_DENSITY_RULES.map((row) => ({
  minPcf: row.densityFrom,
  freightClass: Number(row.class),
}));

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
 * Drop zero-width / placeholder rows from Primus companydensityrules payload.
 * @param {Array<object>} raw Raw API results.
 * @return {Array<{densityFrom: number, densityTo: number, class: number}>}
 */
function normalizeCompanyDensityRules(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const row of rows) {
    const from = Number(row && row.densityFrom);
    const to = Number(row && row.densityTo);
    const cls = Number(row && row.class);
    if (!Number.isFinite(from) || !Number.isFinite(cls)) continue;
    if (from === to && to === 0) continue;
    out.push({densityFrom: from, densityTo: to, class: cls});
  }
  out.sort((a, b) => b.densityFrom - a.densityFrom);
  return out.length ? out : FALLBACK_DENSITY_RULES.slice();
}

/**
 * Active density rules (API cache or fallback).
 * @return {Array<{densityFrom: number, densityTo: number, class: number}>}
 */
function activeDensityRules() {
  if (densityRulesCache && densityRulesCache.rules.length) {
    return densityRulesCache.rules;
  }
  return FALLBACK_DENSITY_RULES;
}

/**
 * Map density (pcf) to NMFC class using Primus densityFrom/densityTo bands.
 * @param {number} densityPcf Pounds per cubic foot.
 * @param {Array<object>} [rules] Optional rule set; defaults to active cache.
 * @return {number|null}
 */
function classFromDensityWithRules(densityPcf, rules) {
  const d = Number(densityPcf);
  if (!Number.isFinite(d) || d < 0) return null;
  const bands = Array.isArray(rules) && rules.length ?
    rules : activeDensityRules();
  for (const row of bands) {
    const from = Number(row.densityFrom);
    const to = Number(row.densityTo);
    const cls = Number(row.class);
    if (!Number.isFinite(from) || !Number.isFinite(cls)) continue;
    if (d < from) continue;
    if (to === -1) return cls;
    if (Number.isFinite(to) && d < to) return cls;
  }
  return 500;
}

/**
 * Map density (lbs per cubic foot) to NMFC class.
 * @param {number} densityPcf Pounds per cubic foot.
 * @return {number|null}
 */
function classFromDensity(densityPcf) {
  return classFromDensityWithRules(densityPcf);
}

/**
 * GET /tools/companydensityrules — company default density → class bands.
 * @return {Promise<Array<object>>}
 */
async function fetchCompanyDensityRulesFromApi() {
  const json = await primusFetch("/tools/companydensityrules");
  const results = json && json.data && Array.isArray(json.data.results) ?
    json.data.results : [];
  return normalizeCompanyDensityRules(results);
}

/**
 * Load and cache Primus company density rules (1h TTL). Read-only GET.
 * Falls back to {@link FALLBACK_DENSITY_RULES} when the API is unavailable.
 * @param {object} [opts] force refresh.
 * @return {Promise<Array<object>>}
 */
async function ensureDensityRulesLoaded(opts = {}) {
  const force = !!opts.force;
  const now = Date.now();
  if (!force && densityRulesCache &&
      (now - densityRulesCache.fetchedAt) < COMPANY_DENSITY_RULES_TTL_MS) {
    return densityRulesCache.rules;
  }
  if (!force && densityRulesLoadPromise) {
    await densityRulesLoadPromise;
    return activeDensityRules();
  }
  densityRulesLoadPromise = (async () => {
    try {
      const rules = await fetchCompanyDensityRulesFromApi();
      densityRulesCache = {rules, fetchedAt: Date.now(), source: "api"};
    } catch (_) {
      densityRulesCache = {
        rules: FALLBACK_DENSITY_RULES.slice(),
        fetchedAt: Date.now(),
        source: "fallback",
      };
    } finally {
      densityRulesLoadPromise = null;
    }
  })();
  await densityRulesLoadPromise;
  return activeDensityRules();
}

/**
 * Test helper — seed density rule cache without calling Primus.
 * @param {Array<object>|null} rules Rule bands or null to reset.
 * @return {void}
 */
function setDensityRulesCacheForTest(rules) {
  densityRulesLoadPromise = null;
  if (!rules) {
    densityRulesCache = null;
    return;
  }
  densityRulesCache = {
    rules: normalizeCompanyDensityRules(rules),
    fetchedAt: Date.now(),
    source: "test",
  };
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
 * Primus FAK Pricing-tab sell: profit floor, not Jerry market cap.
 * Profit%/markup%: sell = cost + max(cost×rate%, min$).
 * Flat: sell = cost + max(rate, min$).
 * @param {number} cost Carrier cost.
 * @param {object} fak Normalized FAK {rate, type, min}.
 * @return {number|null}
 */
function computeFakSellRate(cost, fak) {
  const c = Number(cost);
  const rule = normalizeFakPricing(fak);
  if (!Number.isFinite(c) || !rule) return null;
  let profit;
  if (rule.type === "flat") {
    profit = Math.max(rule.rate, rule.min);
  } else {
    // profit% and markup% on cost (Primus Profit% = profit / cost).
    profit = Math.max(c * (rule.rate / 100), rule.min);
  }
  return Math.ceil(c + profit);
}

/**
 * Applies margin to carrier cost.
 * Customer contract rates (billTo.total or rateSource customer) pass through.
 * FAK (opts.fak): Primus Pricing-tab profit% with min $ floor.
 * Market rates: cost + min(flat $ markup, percent of cost), default $55 / 10%.
 * All sell rates round UP to the next whole dollar (Math.ceil).
 * @param {number} cost Carrier cost.
 * @param {object} [opts] billToTotal, rateSource, marginPercent,
 *   marginMinDollars, fak.
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
  const fak = normalizeFakPricing(opts.fak);
  if (fak) return computeFakSellRate(c, fak);
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
  computeFakSellRate,
  normalizeFakPricing,
  getCustomerFakPricing,
  parseFakPricingFromShippingLocation,
  pickFakPricingFromCarrierMarkups,
  resolveFakPricingForCustomer,
  resolveFakPricingForCustomerAsync,
  fetchCustomerFakPricingFromPrimus,
  resolveManageShippingLocationId,
  setFetchFakPricingImplForTest,
  clearFakPricingLiveCacheForTest,
  isMarketFallbackRateSource,
  marketFallbackFakWarning,
  tagRateOptions,
  filterBlockedCarriers,
  pickTopOptions,
  normalizeRateRow,
  parseRatesFromResponse,
  parseNoRatesFromResponse,
  summarizeNoRateErrors,
  shouldRetryRatesWithoutCustomer,
  MARKET_FALLBACK_WARNING,
  CUSTOMER_FAK_BY_ID,
  normalizeIsoCountry,
  normalizeDimType,
  normalizeFreightInfoForRate,
  isValidFreightClass,
  classFromDensity,
  classFromDensityWithRules,
  cubicFeetPerPiece,
  densityFromFreightRow,
  ensureFreightClasses,
  ensureDensityRulesLoaded,
  fetchCompanyDensityRulesFromApi,
  normalizeCompanyDensityRules,
  activeDensityRules,
  setDensityRulesCacheForTest,
  VALID_NMFC_CLASSES,
  DENSITY_CLASS_TABLE,
  FALLBACK_DENSITY_RULES,
  freightDims,
};
