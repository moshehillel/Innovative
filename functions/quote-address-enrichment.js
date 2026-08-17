/**
 * Quote address enrichment — classify delivery locations for accessorials.
 *
 * Fallback chain (prefer false negatives over false RSD on institutions):
 * 1. Name/address heuristics (nursing, hospital, school, hotel, warehouse…)
 * 2. Luna (OpenAI gpt-5.6-luna) structured site-type classify
 * 3. If Luna fails (error/empty/parse/low confidence): Anthropic AI, then
 *    Google Places **strong** types only (nursing_home, lodging, hospital,
 *    explicit residential) — NEVER bare street_address/premise → residential
 *    (false RSD on sites like 40 Heyward St / Bedford nursing rehab)
 * 4. Final: siteType other / no auto RSD
 * USPS RDI (Smarty/Melissa) not in repo — recommended later for hard RSD.
 *
 * Env: SUPPORT_CHAT_OPENAI_API_KEY / QUOTE_CLASSIFY_OPENAI_API_KEY /
 * OPENAI_API_KEY for Luna; optional ANTHROPIC_API_KEY; optional
 * GOOGLE_PLACES_API_KEY for strong facility types / place name.
 */

"use strict";

const admin = require("firebase-admin");
// Anthropic fallback scaffold (wired by Luna enrichment work-in-progress).
const Anthropic = require("@anthropic-ai/sdk");
void Anthropic;
const OpenAI = require("openai");
const {DEFAULT_OPENAI_MODEL} = require("./openai-models");

const SITE_TYPES = [
  "nursing_home", "hotel", "amazon_fc", "menards_dc",
  "aafes_military", "residential", "other",
];

const SITE_TYPE_LABELS = {
  nursing_home: "nursing home",
  hotel: "hotel",
  amazon_fc: "Amazon fulfillment center",
  menards_dc: "Menards DC",
  aafes_military: "AAFES / military exchange",
  residential: "residential",
  other: "commercial / other",
};

/** Minimum confidence to accept residential / RSD from AI. */
const RESIDENTIAL_MIN_CONFIDENCE = 0.75;
/** Below this, treat AI result as failed and try the next fallback. */
const AI_ACCEPT_MIN_CONFIDENCE = 0.55;
void AI_ACCEPT_MIN_CONFIDENCE;

let tcolFn = null;

/**
 * @param {object} deps tcol(tenant, name).
 * @return {void}
 */
function init(deps) {
  tcolFn = deps.tcol;
}

/**
 * @param {object} tenant Tenant config.
 * @param {string} name Collection base name.
 * @return {FirebaseFirestore.CollectionReference}
 */
function col(tenant, name) {
  if (!tcolFn) throw new Error("quote-address-enrichment not initialized");
  return tcolFn(tenant, name);
}

/**
 * Normalizes one address fragment for cache keys.
 * @param {string} s Raw text.
 * @return {string}
 */
function normalizePart(s) {
  return String(s || "")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
}

/**
 * Stable cache key from street + city + state + zip.
 * @param {object} consignee Consignee object.
 * @return {string}
 */
function normalizeAddressKey(consignee) {
  const c = consignee || {};
  const parts = [
    normalizePart(c.address1),
    normalizePart(c.city),
    normalizePart(c.state),
    normalizePart(c.zipCode),
  ].filter(Boolean);
  return parts.join("|");
}

/**
 * @param {string} addressKey Cache key.
 * @return {string} Firestore-safe doc id.
 */
function addressKeyToDocId(addressKey) {
  const safe = String(addressKey || "unknown")
      .replace(/[^a-z0-9|]/g, "_")
      .slice(0, 500);
  return safe || "unknown";
}

/**
 * @param {object} tenant Tenant.
 * @param {string} addressKey Normalized key.
 * @return {Promise<object|null>}
 */
async function getCachedClassification(tenant, addressKey) {
  if (!addressKey) return null;
  const docId = addressKeyToDocId(addressKey);
  const ref = col(tenant, "quoteAddressClassifications").doc(docId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  return {id: snap.id, ...snap.data()};
}

/**
 * @param {object} tenant Tenant.
 * @param {string} addressKey Normalized key.
 * @param {object} data Classification payload.
 * @return {Promise<void>}
 */
async function saveCachedClassification(tenant, addressKey, data) {
  if (!addressKey) return;
  const docId = addressKeyToDocId(addressKey);
  await col(tenant, "quoteAddressClassifications").doc(docId).set({
    addressKey,
    ...data,
    enrichedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
}

/**
 * Deletes a cached classification (e.g. after fixing false RSD).
 * @param {object} tenant Tenant.
 * @param {string} addressKey Normalized key.
 * @return {Promise<boolean>} True if a doc was deleted.
 */
async function deleteCachedClassification(tenant, addressKey) {
  if (!addressKey) return false;
  const docId = addressKeyToDocId(addressKey);
  const ref = col(tenant, "quoteAddressClassifications").doc(docId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.delete();
  return true;
}

/**
 * @return {string|null}
 */
function getGoogleApiKey() {
  return process.env.GOOGLE_PLACES_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
    null;
}

/**
 * Same key chain as quote-intake Luna classify.
 * @return {string|null}
 */
function getLunaOpenAiKey() {
  return process.env.QUOTE_CLASSIFY_OPENAI_API_KEY ||
    process.env.SUPPORT_CHAT_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    null;
}

/**
 * Combined searchable text from consignee fields.
 * @param {object} consignee Consignee.
 * @param {string} [extraName] Optional place name from Google.
 * @return {string}
 */
function consigneeSearchText(consignee, extraName) {
  const c = consignee || {};
  return [
    c.name, c.address1, c.address2, c.city, c.state, c.zipCode, extraName,
  ].filter(Boolean).join(" ").toLowerCase();
}

/**
 * Fast site-type from consignee / facility name (no API).
 * @param {object} consignee Consignee.
 * @param {string} [extraName] Optional Google place name.
 * @return {object|null} Classification or null if ambiguous.
 */
function classifyFromNameHeuristics(consignee, extraName) {
  const text = consigneeSearchText(consignee, extraName);
  const name = String(
      (consignee && consignee.name) || extraName || "",
  ).toLowerCase();

  if (/menards/.test(text)) {
    return heuristicResult("menards_dc", name || "Menards", 0.9);
  }
  if (/aafes|military exchange|army air force/.test(text)) {
    return heuristicResult("aafes_military", name || "AAFES", 0.9);
  }
  if (/\bamazon\b|\bfba\b|fulfillment|amzl?\b/.test(text) ||
    /\b[a-z]{3}\d\b/.test(name)) {
    return heuristicResult("amazon_fc", name || "Amazon FC", 0.85);
  }
  // Facility keywords — must win over any street geocode.
  if (/nursing|rehab|skilled nursing|care center|assisted living|convalescent/
      .test(text) ||
    /\bhospital\b|\bmedical center\b|\bclinic\b/.test(text)) {
    return heuristicResult(
        "nursing_home",
        (consignee && consignee.name) || extraName || "Nursing / care facility",
        0.92,
    );
  }
  if (/\b(school|university|college|academy|elementary|high school)\b/
      .test(text)) {
    return heuristicResult(
        "other",
        (consignee && consignee.name) || extraName || "School",
        0.88,
        {residentialDelivery: false},
    );
  }
  if (/\bhotel\b|\bmarriott\b|\bhilton\b|\bhyatt\b|\binn\b|\bsuites\b/
      .test(text) || /\blodging\b/.test(text)) {
    return heuristicResult(
        "hotel",
        (consignee && consignee.name) || extraName || "Hotel",
        0.9,
    );
  }
  if (/\b(warehouse|distribution center|\bdc\b|fulfillment center)\b/
      .test(text)) {
    return heuristicResult(
        "other",
        (consignee && consignee.name) || extraName || "Warehouse / DC",
        0.8,
        {residentialDelivery: false},
    );
  }
  // Strong residential-only signals (not bare street).
  const residentialCue =
    /\b(residential|private residence|residence)\b/.test(text) ||
    /\b(apartment|apartments|\bapt\.?\b|condo|condominium)\b/.test(text) ||
    /\b(trailer park|mobile home)\b/.test(text);
  if (residentialCue) {
    return heuristicResult(
        "residential",
        (consignee && consignee.name) || extraName || "",
        0.85,
        {residentialDelivery: true},
    );
  }

  return null;
}

/**
 * @param {string} siteType Site type.
 * @param {string} placeName Display name.
 * @param {number} confidence 0-1.
 * @param {object} [extra] Extra fields.
 * @return {object}
 */
function heuristicResult(siteType, placeName, confidence, extra = {}) {
  return {
    siteType,
    placeTypes: [],
    placeName: String(placeName || "").slice(0, 200),
    source: "name_heuristic",
    confidence,
    residentialDelivery: extra.residentialDelivery != null ?
      !!extra.residentialDelivery :
      siteType === "residential",
    reason: "Matched facility / residential keywords on name or address",
  };
}

/**
 * Maps Google place types + name to internal siteType.
 * Never treats bare street_address / premise / subpremise as residential —
 * that caused false RSD on institutional sites (e.g. 40 Heyward St).
 * @param {Array<string>} types Google types.
 * @param {string} placeName Place display name.
 * @return {string}
 */
function mapGoogleTypesToSiteType(types, placeName) {
  const t = new Set((types || []).map((x) => String(x).toLowerCase()));
  const name = String(placeName || "").toLowerCase();

  if (/menards/.test(name)) return "menards_dc";
  if (/aafes|military exchange|army air force/.test(name)) {
    return "aafes_military";
  }
  if (/amazon|fba|fulfillment|amz/.test(name) ||
    /\b[a-z]{3}\d\b/.test(name)) {
    return "amazon_fc";
  }
  if (t.has("nursing_home") || t.has("hospital") ||
    /nursing|rehab|skilled nursing|care center|assisted living/.test(name)) {
    return "nursing_home";
  }
  if (t.has("lodging") || t.has("hotel") ||
    /hotel|marriott|hilton|hyatt|inn|suites/.test(name)) {
    return "hotel";
  }
  if ((t.has("storage") || t.has("warehouse")) &&
    /amazon|fba|fulfillment/.test(name)) {
    return "amazon_fc";
  }

  // Explicit Google residential type only — not street/premise geocodes.
  if (t.has("residential")) return "residential";

  return "other";
}

/**
 * True when Google result is only a bare street/premise geocode.
 * @param {Array<string>} types Google types.
 * @return {boolean}
 */
function isBareStreetGeocode(types) {
  const t = new Set((types || []).map((x) => String(x).toLowerCase()));
  const geoOnly = ["street_address", "premise", "subpremise", "geocode",
    "route", "political", "locality", "neighborhood", "postal_code",
    "postal_code_suffix", "administrative_area_level_1",
    "administrative_area_level_2", "administrative_area_level_3",
    "country", "plus_code"];
  if (!t.size) return true;
  for (const x of t) {
    if (!geoOnly.includes(x)) return false;
  }
  return t.has("street_address") || t.has("premise") ||
    t.has("subpremise") || t.has("geocode") || t.size > 0;
}

/**
 * @param {object} consignee Consignee.
 * @return {string}
 */
function buildAddressQuery(consignee) {
  const c = consignee || {};
  return [
    c.name, c.address1, c.address2, c.city, c.state, c.zipCode,
  ].filter(Boolean).join(", ");
}

/**
 * Optional Google Places lookup for place name / facility types only.
 * Does not assign residential from bare geocode.
 * @param {object} consignee Consignee.
 * @return {Promise<object|null>}
 */
async function classifyWithGooglePlaces(consignee) {
  const apiKey = getGoogleApiKey();
  if (!apiKey) return null;

  const query = buildAddressQuery(consignee);
  if (!query.trim()) return null;

  const findUrl = new URL(
      "https://maps.googleapis.com/maps/api/place/findplacefromtext/json",
  );
  findUrl.searchParams.set("input", query);
  findUrl.searchParams.set("inputtype", "textquery");
  findUrl.searchParams.set("fields", "place_id,name,types");
  findUrl.searchParams.set("key", apiKey);

  const findResp = await fetch(findUrl.toString());
  const findData = await findResp.json();
  if (findData.status !== "OK" || !findData.candidates ||
    !findData.candidates.length) {
    return null;
  }

  const candidate = findData.candidates[0];
  let types = candidate.types || [];
  let placeName = candidate.name || "";

  if (candidate.place_id) {
    const detailsUrl = new URL(
        "https://maps.googleapis.com/maps/api/place/details/json",
    );
    detailsUrl.searchParams.set("place_id", candidate.place_id);
    detailsUrl.searchParams.set("fields", "name,types");
    detailsUrl.searchParams.set("key", apiKey);
    const detResp = await fetch(detailsUrl.toString());
    const detData = await detResp.json();
    if (detData.status === "OK" && detData.result) {
      types = detData.result.types || types;
      placeName = detData.result.name || placeName;
    }
  }

  // Bare street geocode → metadata only; caller should use Luna / heuristics.
  if (isBareStreetGeocode(types)) {
    return {
      siteType: "other",
      placeTypes: types,
      placeName,
      source: "google_places",
      confidence: 0.35,
      residentialDelivery: false,
      bareGeocode: true,
      reason: "Google returned street/premise geocode only — not used for RSD",
    };
  }

  const siteType = mapGoogleTypesToSiteType(types, placeName);
  return {
    siteType,
    placeTypes: types,
    placeName,
    source: "google_places",
    confidence: siteType === "other" ? 0.5 : 0.85,
    residentialDelivery: siteType === "residential",
    bareGeocode: false,
  };
}

/**
 * Classify site type with Luna (OpenAI gpt-5.6-luna).
 * Prefer unknown/other over false residential when confidence is low.
 * @param {object} consignee Consignee.
 * @return {Promise<object|null>}
 */
async function classifyWithLuna(consignee) {
  const apiKey = getLunaOpenAiKey();
  if (!apiKey) return null;

  const c = consignee || {};
  const payload = {
    name: c.name || "",
    address1: c.address1 || "",
    address2: c.address2 || "",
    city: c.city || "",
    state: c.state || "",
    zipCode: c.zipCode || "",
  };

  const system = [
    "You classify LTL freight delivery locations for accessorials.",
    "Return ONLY valid JSON:",
    "{ \"siteType\": string, \"residentialDelivery\": boolean,",
    "  \"confidence\": number, \"placeName\": string, \"reason\": string }",
    `siteType must be one of: ${SITE_TYPES.join(", ")}.`,
    "CRITICAL: A bare street address is NOT enough for residential.",
    "Do NOT assume apartment/residential from neighborhood",
    "(e.g. Brooklyn/Williamsburg) or street number alone.",
    "residentialDelivery=true ONLY with strong signals: unit/apt",
    "implying a dwelling, or name says residence/apartment, or",
    "shipper explicitly says residential.",
    "Nursing homes, hospitals, rehab, schools, hotels, warehouses,",
    "DCs, stores are NOT residential.",
    "If the only input is street+city with no facility name and no",
    "unit, prefer siteType other, residentialDelivery false,",
    "confidence <= 0.55.",
    "If you recognize a well-known facility at that exact address,",
    "you may name it and set the matching siteType.",
    "reason: one short sentence.",
  ].join("\n");

  const client = new OpenAI({apiKey});
  const model = process.env.QUOTE_ADDRESS_AI_MODEL ||
    process.env.QUOTE_CLASSIFY_MODEL ||
    DEFAULT_OPENAI_MODEL;
  // gpt-5.6-luna rejects temperature (only default 1). Omit it.
  const completion = await client.chat.completions.create({
    model,
    max_completion_tokens: 300,
    response_format: {type: "json_object"},
    messages: [
      {role: "system", content: system},
      {role: "user", content: JSON.stringify(payload)},
    ],
  });
  const raw = String(
      completion.choices &&
      completion.choices[0] &&
      completion.choices[0].message &&
      completion.choices[0].message.content || "",
  ).trim();
  return parseAiClassification(raw, "luna");
}

/**
 * @deprecated Use classifyWithLuna — kept as alias for callers/tests.
 * @param {object} consignee Consignee address fields.
 * @return {Promise<object|null>}
 */
async function classifyWithAi(consignee) {
  return classifyWithLuna(consignee);
}

/**
 * @param {string} raw JSON text from model.
 * @param {string} [source] Classification source label.
 * @return {object|null}
 */
function parseAiClassification(raw, source = "ai") {
  const jsonText = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  try {
    const parsed = JSON.parse(jsonText);
    let siteType = SITE_TYPES.includes(parsed.siteType) ?
      parsed.siteType : "other";
    const confidence = Math.min(
        1, Math.max(0, Number(parsed.confidence) || 0.5),
    );
    let residentialDelivery = parsed.residentialDelivery === true ||
      siteType === "residential";

    // Prefer false negatives: low-confidence residential → other / no RSD.
    if (siteType === "residential" &&
      confidence < RESIDENTIAL_MIN_CONFIDENCE) {
      siteType = "other";
      residentialDelivery = false;
    }
    if (residentialDelivery && confidence < RESIDENTIAL_MIN_CONFIDENCE) {
      residentialDelivery = false;
      if (siteType === "residential") siteType = "other";
    }

    return {
      siteType,
      placeTypes: [],
      placeName: String(parsed.placeName || "").slice(0, 200),
      source,
      confidence,
      residentialDelivery,
      reason: String(parsed.reason || "").slice(0, 300),
    };
  } catch (_) {
    return null;
  }
}

/**
 * Merges classification onto a lane without overwriting strong email hints.
 * @param {object} lane Lane object (mutated).
 * @param {object} classification Cached or fresh classification.
 * @param {object} [opts] skipSiteTypeOverwrite.
 * @return {object} lane
 */
function mergeClassificationOntoLane(lane, classification, opts = {}) {
  const emailSiteType = lane.siteType;
  const emailHadSpecific = emailSiteType &&
    emailSiteType !== "other";
  const emailFlags = {...(lane.flags || {})};

  if (!opts.skipSiteTypeOverwrite || !emailHadSpecific) {
    lane.siteType = classification.siteType;
  }

  const wantRsd = classification.residentialDelivery === true ||
    classification.siteType === "residential" ||
    lane.siteType === "residential";
  if (wantRsd) {
    lane.flags = {...(lane.flags || {}), residentialDelivery: true};
  }

  lane.enrichmentMeta = {
    source: classification.source,
    cacheHit: !!classification.cacheHit,
    placeName: classification.placeName || null,
    placeTypes: classification.placeTypes || [],
    classifiedAs: classification.siteType,
    confidence: classification.confidence,
    reason: classification.reason || null,
    addressKey: classification.addressKey,
    enrichedAt: classification.enrichedAt ||
      new Date().toISOString(),
    emailSiteType: emailHadSpecific ? emailSiteType : null,
    emailFlags,
  };

  return lane;
}

/**
 * Resolve site type: heuristics → Luna when ambiguous → Google facility types.
 * @param {object} consignee Consignee.
 * @param {Function} [log] Logger.
 * @return {Promise<object|null>}
 */
async function resolveClassification(consignee, log = () => {}) {
  const heuristic = classifyFromNameHeuristics(consignee);
  if (heuristic && heuristic.siteType !== "other") {
    return heuristic;
  }
  if (heuristic && heuristic.siteType === "residential") {
    return heuristic;
  }

  let google = null;
  try {
    google = await classifyWithGooglePlaces(consignee);
  } catch (err) {
    log("warn", "quote", "Google Places classification failed", {
      error: err.message,
    });
  }

  // Facility types from Google (nursing_home, hotel, etc.) are usable.
  if (google && !google.bareGeocode &&
    google.siteType && google.siteType !== "other") {
    // Re-check name heuristics with Google place name.
    const withName = classifyFromNameHeuristics(
        consignee, google.placeName);
    if (withName) return withName;
    return google;
  }

  // Ambiguous / bare geocode → Luna (not Google residential).
  let luna = null;
  try {
    luna = await classifyWithLuna(consignee);
  } catch (err) {
    log("warn", "quote", "Luna address classification failed", {
      error: err.message,
    });
  }
  if (luna) {
    if (google && google.placeName && !luna.placeName) {
      luna.placeName = google.placeName;
    }
    if (google && google.placeTypes) {
      luna.placeTypes = google.placeTypes;
    }
    return luna;
  }

  // Default: commercial/other — do NOT invent RSD.
  if (google) {
    return {
      ...google,
      siteType: "other",
      residentialDelivery: false,
      confidence: Math.min(google.confidence || 0.4, 0.5),
    };
  }

  return heuristic || {
    siteType: "other",
    placeTypes: [],
    placeName: "",
    source: "default",
    confidence: 0.3,
    residentialDelivery: false,
    reason: "No classifier result — default commercial/other (no RSD)",
  };
}

/**
 * Main entry — enrich lane consignee with site classification.
 * @param {object} lane Lane with consignee.
 * @param {object} tenant Tenant config.
 * @param {object} [opts] log, forceRefresh.
 * @return {Promise<object>} Enriched lane (same reference).
 */
async function enrichLaneConsignee(lane, tenant, opts = {}) {
  const consignee = lane.consignee || {};
  const addressKey = normalizeAddressKey(consignee);
  if (!addressKey) {
    return lane;
  }

  const log = opts.log || (() => {});

  if (!opts.forceRefresh) {
    const cached = await getCachedClassification(tenant, addressKey);
    if (cached && cached.siteType) {
      log("info", "quote", "Address classification cache hit", {
        addressKey, siteType: cached.siteType,
      });
      mergeClassificationOntoLane(lane, {
        ...cached,
        cacheHit: true,
        addressKey,
      });
      return lane;
    }
  }

  let classification = null;
  try {
    classification = await resolveClassification(consignee, log);
  } catch (err) {
    log("warn", "quote", "Address classification failed", {
      addressKey, error: err.message,
    });
  }

  if (!classification) {
    log("warn", "quote", "Address enrichment skipped — no classifier", {
      addressKey,
    });
    return lane;
  }

  classification.addressKey = addressKey;
  classification.consignee = {
    name: consignee.name || null,
    address1: consignee.address1 || null,
    city: consignee.city || null,
    state: consignee.state || null,
    zipCode: consignee.zipCode || null,
  };

  mergeClassificationOntoLane(lane, classification);

  try {
    await saveCachedClassification(tenant, addressKey, {
      consignee: classification.consignee,
      siteType: classification.siteType,
      placeTypes: classification.placeTypes || [],
      placeName: classification.placeName || null,
      source: classification.source,
      confidence: classification.confidence,
      residentialDelivery: !!classification.residentialDelivery,
      reason: classification.reason || null,
    });
  } catch (err) {
    log("warn", "quote", "Failed to cache address classification", {
      addressKey, error: err.message,
    });
  }

  log("info", "quote", "Address classified", {
    addressKey,
    siteType: classification.siteType,
    source: classification.source,
    residentialDelivery: !!classification.residentialDelivery,
  });

  return lane;
}

module.exports = {
  init,
  SITE_TYPES,
  SITE_TYPE_LABELS,
  RESIDENTIAL_MIN_CONFIDENCE,
  normalizeAddressKey,
  normalizePart,
  addressKeyToDocId,
  getCachedClassification,
  saveCachedClassification,
  deleteCachedClassification,
  classifyFromNameHeuristics,
  classifyWithGooglePlaces,
  classifyWithLuna,
  classifyWithAi,
  resolveClassification,
  enrichLaneConsignee,
  mergeClassificationOntoLane,
  mapGoogleTypesToSiteType,
  isBareStreetGeocode,
};
