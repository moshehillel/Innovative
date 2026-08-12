/**
 * Quote address enrichment — classify delivery locations via Google Places
 * or AI. Results are cached in Firestore to skip repeat lookups.
 *
 * Env (optional): GOOGLE_PLACES_API_KEY or GOOGLE_MAPS_API_KEY
 * AI fallback: ANTHROPIC_API_KEY, else OPENAI_API_KEY
 */

"use strict";

const admin = require("firebase-admin");
const Anthropic = require("@anthropic-ai/sdk");
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
 * @return {string|null}
 */
function getGoogleApiKey() {
  return process.env.GOOGLE_PLACES_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
    null;
}

/**
 * Maps Google place types + name to internal siteType.
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
  if (t.has("nursing_home") ||
    /nursing|rehab|skilled nursing|care center/.test(name)) {
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

  const commercial = [
    "store", "shopping_mall", "supermarket", "department_store",
    "hardware_store", "home_goods_store", "establishment",
    "point_of_interest", "lodging", "hospital", "doctor",
  ];
  const isCommercial = commercial.some((c) => t.has(c));
  if ((t.has("street_address") || t.has("premise") || t.has("subpremise")) &&
    !isCommercial) {
    return "residential";
  }

  return "other";
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
 * Classify via Google Places Find Place + Place Details.
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

  const siteType = mapGoogleTypesToSiteType(types, placeName);
  return {
    siteType,
    placeTypes: types,
    placeName,
    source: "google_places",
    confidence: siteType === "other" ? 0.5 : 0.85,
  };
}

/**
 * @param {object} consignee Consignee.
 * @return {Promise<object|null>}
 */
async function classifyWithAi(consignee) {
  const c = consignee || {};
  const payload = {
    name: c.name || "",
    address1: c.address1 || "",
    city: c.city || "",
    state: c.state || "",
    zipCode: c.zipCode || "",
  };

  const system = [
    "You classify LTL freight delivery locations.",
    "Return ONLY valid JSON:",
    "{ siteType, placeName, confidence }",
    `siteType must be one of: ${SITE_TYPES.join(", ")}.`,
    "Use placeName for the best public name of the location.",
    "confidence is 0-1.",
  ].join("\n");

  if (process.env.ANTHROPIC_API_KEY) {
    const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
    const res = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 300,
      system,
      messages: [{
        role: "user",
        content: JSON.stringify(payload),
      }],
    });
    const raw = String(
        res.content && res.content[0] && res.content[0].text || "",
    ).trim();
    return parseAiClassification(raw);
  }

  const openAiKey = process.env.OPENAI_API_KEY;
  if (openAiKey) {
    const client = new OpenAI({apiKey: openAiKey});
    const completion = await client.chat.completions.create({
      model: process.env.QUOTE_ADDRESS_AI_MODEL || DEFAULT_OPENAI_MODEL,
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
    return parseAiClassification(raw);
  }

  return null;
}

/**
 * @param {string} raw JSON text from model.
 * @return {object|null}
 */
function parseAiClassification(raw) {
  const jsonText = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  try {
    const parsed = JSON.parse(jsonText);
    const siteType = SITE_TYPES.includes(parsed.siteType) ?
      parsed.siteType : "other";
    return {
      siteType,
      placeTypes: [],
      placeName: String(parsed.placeName || "").slice(0, 200),
      source: "ai",
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.6)),
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

  if (classification.siteType === "residential" ||
    (lane.siteType === "residential")) {
    lane.flags = {...(lane.flags || {}), residentialDelivery: true};
  }

  lane.enrichmentMeta = {
    source: classification.source,
    cacheHit: !!classification.cacheHit,
    placeName: classification.placeName || null,
    placeTypes: classification.placeTypes || [],
    classifiedAs: classification.siteType,
    confidence: classification.confidence,
    addressKey: classification.addressKey,
    enrichedAt: classification.enrichedAt ||
      new Date().toISOString(),
    emailSiteType: emailHadSpecific ? emailSiteType : null,
    emailFlags,
  };

  return lane;
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
    classification = await classifyWithGooglePlaces(consignee);
  } catch (err) {
    log("warn", "quote", "Google Places classification failed", {
      addressKey, error: err.message,
    });
  }

  if (!classification) {
    try {
      classification = await classifyWithAi(consignee);
    } catch (err) {
      log("warn", "quote", "AI address classification failed", {
        addressKey, error: err.message,
      });
    }
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
  });

  return lane;
}

module.exports = {
  init,
  SITE_TYPES,
  SITE_TYPE_LABELS,
  normalizeAddressKey,
  normalizePart,
  getCachedClassification,
  saveCachedClassification,
  classifyWithGooglePlaces,
  classifyWithAi,
  enrichLaneConsignee,
  mergeClassificationOntoLane,
  mapGoogleTypesToSiteType,
};
