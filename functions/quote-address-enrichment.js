/**
 * Quote address enrichment — classify Ship From (origin) and Ship To
 * (destination) locations for accessorials.
 *
 * Fallback chain (prefer false negatives over false RSD/RSO on institutions):
 * 1. Name/address heuristics (nursing, hospital, school, hotel, warehouse…)
 *    — primary for facility keywords; AI is NOT called when these match.
 * 2. Google Places **strong** types only (nursing_home, lodging, hospital,
 *    explicit residential) — NEVER bare street_address/premise → residential
 *    (false RSD on sites like 40 Heyward St / Bedford nursing rehab)
 * 3. Ambiguous / address-only: OpenAI Responses API + web_search tool
 *    (ChatGPT-like lookup). Plain chat.completions without tools cannot
 *    identify facilities from street+city alone; with web_search, Luna/sol/
 *    gpt-4o correctly find Bedford at 40 Heyward → nursing_home.
 * 4. No-tools OpenAI JSON classify for leftover residential-vs-commercial
 *    judgment when web search is unavailable or returns nothing useful.
 * 5. Final: siteType other / no auto RSD or RSO
 * USPS RDI (Smarty/Melissa) not in repo — recommended later for hard RSD.
 *
 * Env: SUPPORT_CHAT_OPENAI_API_KEY / QUOTE_CLASSIFY_OPENAI_API_KEY /
 * OPENAI_API_KEY for OpenAI; optional GOOGLE_PLACES_API_KEY for strong
 * facility types / place name. QUOTE_ADDRESS_AI_MODEL / QUOTE_ADDRESS_WEB_MODEL
 * override models.
 */

"use strict";

const admin = require("firebase-admin");
const OpenAI = require("openai");
const {DEFAULT_OPENAI_MODEL} = require("./openai-models");

const SITE_TYPES = [
  "nursing_home", "hotel", "amazon_fc", "menards_dc",
  "aafes_military", "chain_store", "residential", "other",
];

const SITE_TYPE_LABELS = {
  nursing_home: "nursing home",
  hotel: "hotel",
  amazon_fc: "Amazon fulfillment center",
  menards_dc: "Menards DC",
  aafes_military: "AAFES / military exchange",
  chain_store: "chain store",
  residential: "residential",
  other: "commercial / other",
};

/**
 * Big-box / grocery chain names commonly needing delivery appointment (APD).
 * Matched case-insensitively against consignee / place name.
 */
const CHAIN_STORE_NAME_RE = new RegExp([
  "\\bwal[- ]?marts?\\b",
  "\\btargets?\\b",
  "\\btj\\s*maxx\\b",
  "\\bt\\.\\s*j\\.\\s*maxx\\b",
  "\\bmarshalls?\\b",
  "\\bhomegoods\\b",
  "\\bbj'?s(\\s+wholesale)?\\b",
  "\\balbertsons?\\b",
  "\\balbersons\\b", // common misspelling
  "\\bsafeways?\\b",
  "\\bcostcos?\\b",
  "\\bsam'?s(\\s+club)?\\b",
  "\\bhome\\s*depots?\\b",
  "\\blowe'?s\\b",
  "\\bkrogers?\\b",
  "\\bpublix\\b",
  "\\bmeijers?\\b",
  "\\bshoprite\\b",
  "\\bshop\\s*rite\\b",
  "\\bfood\\s*lions?\\b",
  "\\bwinn[- ]?dixie\\b",
  "\\bheb\\b",
  "\\bh-?e-?b\\b",
  "\\bwhole\\s*foods\\b",
  "\\btrader\\s*joe'?s\\b",
  "\\bcvs\\b",
  "\\bwalgreens\\b",
  "\\bdollar\\s*generals?\\b",
  "\\bdollar\\s*trees?\\b",
  "\\bfamily\\s*dollars?\\b",
  "\\bbest\\s*buys?\\b",
  "\\boffice\\s*depots?\\b",
  "\\bstaples\\b",
  "\\bbed\\s*bath\\s*(&|and)\\s*beyond\\b",
  "\\bmacy'?s\\b",
  "\\bkohl'?s\\b",
  "\\bj\\.?c\\.?\\s*penney'?s?\\b",
  "\\bsears\\b",
  "\\bgiant(\\s+eagle|\\s+food)?\\b",
  "\\bstop\\s*&\\s*shop\\b",
  "\\bwegmans\\b",
  "\\bingles\\b",
  "\\bharris\\s*teeter\\b",
].join("|"), "i");

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
 * True when a party has a ZIP but is missing city and/or state.
 * @param {object|null|undefined} party Address.
 * @return {boolean}
 */
function partyNeedsCityStateFromZip(party) {
  if (!party || typeof party !== "object") return false;
  const zip = String(party.zipCode || party.zipcode || party.zip || "").trim();
  if (!zip) return false;
  const city = String(party.city || "").trim();
  const state = String(party.state || "").trim();
  return !city || !state;
}

/**
 * True when a party has city+state but is missing ZIP (Primus needs ZIP).
 * @param {object|null|undefined} party Address.
 * @return {boolean}
 */
function partyNeedsZipFromCityState(party) {
  if (!party || typeof party !== "object") return false;
  const zip = String(party.zipCode || party.zipcode || party.zip || "").trim();
  if (zip) return false;
  const city = String(party.city || "").trim();
  const state = String(party.state || "").trim();
  return !!(city && state);
}

/**
 * Stamp a lane extraction warning once.
 * @param {object} [lane] Lane.
 * @param {string} warning Warning label.
 */
function pushLaneZipWarning(lane, warning) {
  if (!lane || typeof lane !== "object") return;
  const list = Array.isArray(lane.extractionWarnings) ?
    lane.extractionWarnings : [];
  if (!list.includes(warning)) list.push(warning);
  lane.extractionWarnings = list;
}

/**
 * US ZIP → city/state via Zippopotam (no API key).
 * @param {string} zip Raw ZIP.
 * @return {Promise<{city: string, state: string, zipCode: string}|null>}
 */
async function lookupUsZip(zip) {
  const z = String(zip || "").replace(/\D/g, "").slice(0, 5);
  if (!/^\d{5}$/.test(z)) return null;
  try {
    const resp = await fetch(`https://api.zippopotam.us/us/${z}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const place = json && json.places && json.places[0];
    if (!place) return null;
    const city = String(place["place name"] || "").trim();
    const state = String(place["state abbreviation"] || "").trim();
    if (!city || !state) return null;
    return {city, state, zipCode: z};
  } catch (_) {
    return null;
  }
}

/**
 * Known warehouse / facility ZIPs (city|ST → zip). Used before external
 * geocode so recurring RFQ origins (e.g. STG Santa Fe Springs) still rate
 * when Google/Zippopotam are slow or the serving revision is stale.
 */
const KNOWN_CITY_STATE_ZIPS = Object.freeze({
  "santa fe springs|ca": "90670",
  // STG La Mirada warehouse — same rating ZIP as Santa Fe Springs.
  "la mirada|ca": "90670",
  "lakewood|nj": "08701",
});

/**
 * Fast ZIP from known city/state map.
 * @param {string} city City.
 * @param {string} state State abbrev.
 * @return {object|null}
 */
function lookupKnownCityStateZip(city, state) {
  const c = String(city || "").trim().toLowerCase();
  const st = String(state || "").trim().toLowerCase();
  if (!c || !st) return null;
  const zipCode = KNOWN_CITY_STATE_ZIPS[`${c}|${st}`];
  if (!zipCode) return null;
  return {city: String(city).trim(), state: String(state).trim(), zipCode};
}

/**
 * City/state (+ optional name/street) → ZIP via Google Geocoding / Places.
 * Locality-only queries often omit postal_code; include name when present.
 * Prefer space-joined queries (comma-joined "Name, City, ST" often geocodes
 * as a bare locality without ZIP).
 * @param {object} party Address party.
 * @return {Promise<object|null>} `{city, state, zipCode, address1?}`.
 */
async function lookupZipFromCityState(party) {
  if (!party || typeof party !== "object") return null;
  const name = String(party.name || "").trim();
  const address1 = String(party.address1 || "").trim();
  const city = String(party.city || "").trim();
  const state = String(party.state || "").trim();
  if (!city || !state) return null;

  const known = lookupKnownCityStateZip(city, state);
  if (known) return known;

  const apiKey = getGoogleApiKey();
  if (apiKey) {
    const partsNamed = [name, address1, city, state, "USA"].filter(Boolean);
    const partsCity = [city, state, "USA"].filter(Boolean);
    const queries = [];
    if (name || address1) {
      queries.push(partsNamed.join(" "));
      queries.push(partsNamed.join(", "));
    }
    queries.push(partsCity.join(" "));
    queries.push(partsCity.join(", "));

    for (const query of queries) {
      const loc = await geocodeAddressToZip(query, apiKey, city, state);
      if (loc) return loc;
    }

    // Places findplace often resolves facility names (e.g. STG) to a postal ZIP
    // when Geocode returns a bare locality.
    if (name) {
      const placeLoc = await placesFindZip(
          [name, city, state].filter(Boolean).join(" "), apiKey, city, state);
      if (placeLoc) return placeLoc;
    }
  }

  // Zippopotam city/state fallback (no key) when Google misses postal_code.
  return lookupUsZipFromCityState(city, state);
}

/**
 * City/state → ZIP via Zippopotam (no API key). First place when multiple.
 * @param {string} city City.
 * @param {string} state State abbrev or name.
 * @return {Promise<{city: string, state: string, zipCode: string}|null>}
 */
async function lookupUsZipFromCityState(city, state) {
  const c = String(city || "").trim();
  const st = String(state || "").trim();
  if (!c || !st) return null;
  const stateSlug = st.length === 2 ? st.toLowerCase() : st.toLowerCase();
  const citySlug = encodeURIComponent(c.toLowerCase());
  try {
    const resp = await fetch(
        `https://api.zippopotam.us/us/${stateSlug}/${citySlug}`, {
          signal: AbortSignal.timeout(8000),
        });
    if (!resp.ok) return null;
    const json = await resp.json();
    const place = json && json.places && json.places[0];
    if (!place) return null;
    const zipCode = String(place["post code"] || "").replace(/\D/g, "")
        .slice(0, 5);
    if (!/^\d{5}$/.test(zipCode)) return null;
    return {
      city: String(place["place name"] || c).trim() || c,
      state: String(json["state abbreviation"] || st).trim() || st,
      zipCode,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Parse Google address_components into city/state/zip/street.
 * @param {Array<object>} comps Address components.
 * @param {string} fallbackCity City fallback.
 * @param {string} fallbackState State fallback.
 * @return {object|null} `{city, state, zipCode, address1?}`.
 */
function parseGoogleAddressComponents(comps, fallbackCity, fallbackState) {
  const list = Array.isArray(comps) ? comps : [];
  const get = (type, short = true) => {
    const row = list.find((c) =>
      Array.isArray(c.types) && c.types.includes(type));
    if (!row) return "";
    return String((short ? row.short_name : row.long_name) ||
      row.long_name || row.short_name || "").trim();
  };
  const zipCode = get("postal_code");
  if (!/^\d{5}$/.test(zipCode)) return null;
  const streetNum = get("street_number");
  const route = get("route");
  const street = [streetNum, route].filter(Boolean).join(" ").trim();
  return {
    city: get("locality", false) || fallbackCity,
    state: get("administrative_area_level_1") || fallbackState,
    zipCode,
    address1: street || undefined,
  };
}

/**
 * Geocode one address string → ZIP.
 * @param {string} query Address query.
 * @param {string} apiKey Google key.
 * @param {string} fallbackCity City.
 * @param {string} fallbackState State.
 * @return {Promise<object|null>}
 */
async function geocodeAddressToZip(query, apiKey, fallbackCity, fallbackState) {
  if (!query || !apiKey) return null;
  try {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", query);
    url.searchParams.set("key", apiKey);
    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    if (json.status !== "OK" || !json.results || !json.results.length) {
      return null;
    }
    return parseGoogleAddressComponents(
        json.results[0].address_components,
        fallbackCity,
        fallbackState);
  } catch (_) {
    return null;
  }
}

/**
 * Places Find Place → Details for postal_code.
 * @param {string} query Text query.
 * @param {string} apiKey Google key.
 * @param {string} fallbackCity City.
 * @param {string} fallbackState State.
 * @return {Promise<object|null>}
 */
async function placesFindZip(query, apiKey, fallbackCity, fallbackState) {
  if (!query || !apiKey) return null;
  try {
    const findUrl = new URL(
        "https://maps.googleapis.com/maps/api/place/findplacefromtext/json");
    findUrl.searchParams.set("input", query);
    findUrl.searchParams.set("inputtype", "textquery");
    findUrl.searchParams.set("fields", "place_id");
    findUrl.searchParams.set("key", apiKey);
    const findResp = await fetch(findUrl.toString(), {
      signal: AbortSignal.timeout(8000),
    });
    if (!findResp.ok) return null;
    const findData = await findResp.json();
    const placeId = findData && findData.candidates &&
      findData.candidates[0] && findData.candidates[0].place_id;
    if (!placeId) return null;

    const detailsUrl = new URL(
        "https://maps.googleapis.com/maps/api/place/details/json");
    detailsUrl.searchParams.set("place_id", placeId);
    detailsUrl.searchParams.set("fields", "address_component");
    detailsUrl.searchParams.set("key", apiKey);
    const detResp = await fetch(detailsUrl.toString(), {
      signal: AbortSignal.timeout(8000),
    });
    if (!detResp.ok) return null;
    const detData = await detResp.json();
    if (detData.status !== "OK" || !detData.result) return null;
    return parseGoogleAddressComponents(
        detData.result.address_components,
        fallbackCity,
        fallbackState);
  } catch (_) {
    return null;
  }
}

/**
 * Force known warehouse city|state → ZIP even when geocode returned a
 * different local ZIP (e.g. La Mirada 90638 → STG 90670).
 * @param {object|null|undefined} party Address.
 * @param {object} [lane] Optional lane to stamp "zip filled" warning.
 * @return {object|null|undefined}
 */
function applyKnownWarehouseZipOverride(party, lane) {
  if (!party || typeof party !== "object") return party;
  const city = String(party.city || "").trim();
  const state = String(party.state || "").trim();
  const known = lookupKnownCityStateZip(city, state);
  if (!known) return party;
  const existing = String(party.zipCode || party.zipcode || party.zip || "")
      .replace(/\D/g, "")
      .slice(0, 5);
  if (existing === known.zipCode) return party;
  pushLaneZipWarning(lane, "zip filled");
  return {
    ...party,
    city: city || known.city,
    state: state || known.state,
    zipCode: known.zipCode,
    country: String(party.country || "US").trim() || "US",
  };
}

/**
 * Fill missing city/state from ZIP so Primus can rate zip-only RFQs.
 * @param {object|null|undefined} party Address.
 * @param {object} [lane] Optional lane to stamp "zip filled" warning.
 * @return {Promise<object|null|undefined>}
 */
async function fillPartyCityStateFromZip(party, lane) {
  if (!partyNeedsCityStateFromZip(party)) return party;
  const zip = party.zipCode || party.zipcode || party.zip;
  const loc = await lookupUsZip(zip);
  if (!loc) return party;
  pushLaneZipWarning(lane, "zip filled");
  return {
    ...party,
    city: String(party.city || "").trim() || loc.city,
    state: String(party.state || "").trim() || loc.state,
    zipCode: String(party.zipCode || party.zipcode || party.zip || loc.zipCode)
        .trim(),
    country: String(party.country || "US").trim() || "US",
  };
}

/**
 * Fill missing ZIP from city/state (and name/street when available).
 * @param {object|null|undefined} party Address.
 * @param {object} [lane] Optional lane to stamp "zip filled" warning.
 * @return {Promise<object|null|undefined>}
 */
async function fillPartyZipFromCityState(party, lane) {
  if (!partyNeedsZipFromCityState(party)) return party;
  const loc = await lookupZipFromCityState(party);
  if (!loc) {
    pushLaneZipWarning(lane, "zip fill failed");
    return party;
  }
  pushLaneZipWarning(lane, "zip filled");
  const existingStreet = String(party.address1 || "").trim();
  return {
    ...party,
    city: String(party.city || "").trim() || loc.city,
    state: String(party.state || "").trim() || loc.state,
    zipCode: loc.zipCode,
    address1: existingStreet || loc.address1 || party.address1 || null,
    country: String(party.country || "US").trim() || "US",
  };
}

/**
 * Fill whichever OD side is incomplete: zip→city/state or city/state→zip.
 * @param {object|null|undefined} party Address.
 * @param {object} [lane] Optional lane.
 * @return {Promise<object|null|undefined>}
 */
async function fillPartyOdFromZipOrCityState(party, lane) {
  let next = applyKnownWarehouseZipOverride(party, lane);
  next = await fillPartyCityStateFromZip(next, lane);
  next = await fillPartyZipFromCityState(next, lane);
  next = applyKnownWarehouseZipOverride(next, lane);
  return next;
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
 * True when name/address looks like a US military installation.
 * Avoids city names such as Fort Lauderdale / Fort Worth.
 * @param {string} text Searchable text.
 * @return {boolean}
 */
function isMilitarySiteText(text) {
  const t = String(text || "").toLowerCase();
  if (/aafes|military exchange|army (and )?air force/.test(t)) return true;
  // Navy / Marine exchange DCs (NEXCOM RFQs often omit "navy exchange").
  if (/\b(nex|nexcom|navy exchange|mcx|base exchange|bx|commissary)\b/
      .test(t)) {
    return true;
  }
  // NEXCOM West Coast retail DC is often labeled "WC Retail Dist Ctr".
  if (/\bwc\s+retail\s+dist(\.|ribution)?\s*(ctr|center)?\b/.test(t)) {
    return true;
  }
  if (/\bmilitary(\s+(base|bases|post|installation|facility)s?)?\b/.test(t)) {
    return true;
  }
  if (/\bair force base\b|\bafb\b|\bair force station\b/.test(t)) return true;
  if (/\b(naval (air )?station|naval base|navy (base|yard)|navy exchange)\b/
      .test(t)) {
    return true;
  }
  if (/\b(marine corps (base|air station|recruit|depot)|\bmcas\b|\bmcb\b)/
      .test(t)) {
    return true;
  }
  if (/\bjoint base\b/.test(t)) return true;
  if (/\b(army (base|post|depot|airfield|installation)|us army)\b/.test(t)) {
    return true;
  }
  if (/\b(the )?pentagon\b/.test(t)) return true;
  if (/\bcamp (lejeune|pendleton|hansen|schwab|foster|zama|humphreys|casey)\b/
      .test(t)) {
    return true;
  }
  if (/\bfort\s+(bragg|liberty|hood|cavazos|campbell|benning|moore)\b/
      .test(t) ||
    /\bfort\s+(stewart|drum|riley|sill|bliss|knox|irwin|meade)\b/.test(t) ||
    /\bfort\s+(belvoir|wainwright|huachuca|eustis|jackson|novosel)\b/
        .test(t) ||
    /\bfort\s+(gregg|johnson|leonard wood|carson)\b/.test(t)) {
    return true;
  }
  return false;
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
  if (isMilitarySiteText(text) || isMilitarySiteText(name)) {
    return heuristicResult(
        "aafes_military",
        (consignee && consignee.name) || extraName || "Military base",
        0.9,
    );
  }
  if (/\bamazon\b|\bfba\b|fulfillment|amzl?\b/.test(text) ||
    /\b[a-z]{3}\d\b/.test(name)) {
    return heuristicResult("amazon_fc", name || "Amazon FC", 0.85);
  }
  if (CHAIN_STORE_NAME_RE.test(text) || CHAIN_STORE_NAME_RE.test(name)) {
    return heuristicResult(
        "chain_store",
        (consignee && consignee.name) || extraName || "Chain store",
        0.9,
    );
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
  if (t.has("military_base") || isMilitarySiteText(name)) {
    return "aafes_military";
  }
  if (/amazon|fba|fulfillment|amz/.test(name) ||
    /\b[a-z]{3}\d\b/.test(name)) {
    return "amazon_fc";
  }
  if (CHAIN_STORE_NAME_RE.test(name)) return "chain_store";
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
 * Pickup vs delivery wording for AI classifiers.
 * @param {string} [side] origin | dest.
 * @return {string}
 */
function locationKindLabel(side) {
  return side === "origin" ?
    "pickup (Ship From / origin)" :
    "delivery (Ship To / destination)";
}

/**
 * Classify site type with OpenAI (default gpt-5.6-luna).
 * Prefer unknown/other over false residential when confidence is low.
 * Not marketed as address-only facility detection — LLMs return other
 * without a facility name; keep for ambiguous res/commercial cues.
 * @param {object} consignee Consignee or shipper address fields.
 * @param {object} [opts] side origin|dest.
 * @return {Promise<object|null>}
 */
async function classifyWithLuna(consignee, opts = {}) {
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
    `You classify LTL freight ${locationKindLabel(opts.side)} ` +
      "locations for accessorials.",
    "Return ONLY valid JSON:",
    "{ \"siteType\": string, \"residentialDelivery\": boolean,",
    "  \"confidence\": number, \"placeName\": string, \"reason\": string }",
    `siteType must be one of: ${SITE_TYPES.join(", ")}.`,
    "CRITICAL: A bare street address is NOT enough for residential.",
    "Do NOT assume apartment/residential from neighborhood",
    "(e.g. Brooklyn/Williamsburg) or street number alone.",
    "residentialDelivery=true ONLY with strong signals: unit/apt",
    "implying a dwelling, or name says residence/apartment, or",
    "the RFQ explicitly says residential pickup or delivery.",
    "Nursing homes, hospitals, rehab, schools, hotels, warehouses,",
    "DCs, stores are NOT residential.",
    "Military bases, forts, AFB, naval/Marine stations, AAFES/exchanges",
    "→ siteType aafes_military.",
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
 * Address-only / ambiguous facility lookup via OpenAI Responses + web_search.
 * Mirrors ChatGPT browsing: model can look up what sits at a street address.
 * Plain chat.completions (no tools) cannot do this — that was the Luna gap.
 * @param {object} consignee Consignee or shipper address fields.
 * @param {object} [opts] side origin|dest.
 * @return {Promise<object|null>}
 */
async function classifyWithWebSearch(consignee, opts = {}) {
  const apiKey = getLunaOpenAiKey();
  if (!apiKey) return null;

  const c = consignee || {};
  const addressLine = [
    c.address1, c.address2, c.city, c.state, c.zipCode,
  ].filter(Boolean).join(", ");
  if (!addressLine.trim()) return null;

  const payload = {
    name: c.name || "",
    address1: c.address1 || "",
    address2: c.address2 || "",
    city: c.city || "",
    state: c.state || "",
    zipCode: c.zipCode || "",
  };

  const system = [
    `You classify LTL freight ${locationKindLabel(opts.side)} ` +
      "locations for accessorials.",
    "Use web search to identify the business/facility at the address",
    "when no clear facility name is provided.",
    "Return ONLY valid JSON (no markdown fences):",
    "{ \"siteType\": string, \"residentialDelivery\": boolean,",
    "  \"confidence\": number, \"placeName\": string, \"reason\": string }",
    `siteType must be one of: ${SITE_TYPES.join(", ")}.`,
    "CRITICAL: A bare street address is NOT enough for residential.",
    "Do NOT assume apartment/residential from neighborhood alone.",
    "residentialDelivery=true ONLY with strong dwelling signals.",
    "Nursing homes, hospitals, rehab, assisted living → nursing_home.",
    "Hotels/inns/suites → hotel. Warehouses/DCs/stores → other.",
    "Military bases, forts, AFB, naval/Marine stations, AAFES/exchanges",
    "→ siteType aafes_military.",
    "If web search finds a named facility, set placeName and siteType.",
    "If search finds nothing useful, siteType other, confidence <= 0.55,",
    "residentialDelivery false.",
    "reason: one short sentence.",
  ].join("\n");

  const client = new OpenAI({apiKey});
  const model = process.env.QUOTE_ADDRESS_WEB_MODEL ||
    process.env.QUOTE_ADDRESS_AI_MODEL ||
    process.env.QUOTE_CLASSIFY_MODEL ||
    DEFAULT_OPENAI_MODEL;

  const resp = await client.responses.create({
    model,
    tools: [{type: "web_search"}],
    input: [
      {role: "system", content: system},
      {
        role: "user",
        content: [
          `Classify this ${locationKindLabel(opts.side)} address. ` +
            "Search the web if needed.",
          "JSON only.",
          JSON.stringify(payload),
        ].join("\n"),
      },
    ],
  });

  const raw = extractJsonText(String(resp.output_text || "").trim());
  const parsed = parseAiClassification(raw, "openai_web_search");
  if (!parsed) return null;

  // Prefer facility keywords from discovered place name over weak "other".
  if (parsed.placeName) {
    const fromName = classifyFromNameHeuristics(
        consignee, parsed.placeName);
    if (fromName && fromName.siteType !== "other") {
      return {
        ...fromName,
        placeName: parsed.placeName || fromName.placeName,
        source: "openai_web_search",
        confidence: Math.max(fromName.confidence, parsed.confidence || 0),
        reason: parsed.reason || fromName.reason,
        residentialDelivery: false,
      };
    }
  }
  return parsed;
}

/**
 * Pull a JSON object string out of model output that may include prose.
 * @param {string} text Raw model text.
 * @return {string}
 */
function extractJsonText(text) {
  const s = String(text || "").trim();
  if (!s) return "";
  if (s.startsWith("{")) return s;
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) return s.slice(start, end + 1);
  return s;
}

/**
 * True when consignee name is missing or too generic to classify facilities.
 * @param {object} consignee Consignee.
 * @return {boolean}
 */
function isAddressOnlyOrWeakName(consignee) {
  const name = String((consignee && consignee.name) || "").trim();
  if (!name) return true;
  if (/^(consignee|customer|receiver|ship\s*to|deliver(y)?\s*to)$/i
      .test(name)) {
    return true;
  }
  if (/^(shipper|origin|pickup|ship\s*from)$/i.test(name)) {
    return true;
  }
  // Has facility keywords → heuristics already handled; treat as named.
  if (/nursing|rehab|hospital|hotel|amazon|warehouse|school/i.test(name)) {
    return false;
  }
  // Short generic tokens only.
  if (name.length <= 3) return true;
  return !/[a-z]/i.test(name);
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
 * Dest writes siteType / enrichmentMeta / flags.residentialDelivery.
 * Origin writes originSiteType / originEnrichmentMeta /
 * flags.residentialPickup.
 * @param {object} lane Lane object (mutated).
 * @param {object} classification Cached or fresh classification.
 * @param {object} [opts] skipSiteTypeOverwrite, side origin|dest.
 * @return {object} lane
 */
function mergeClassificationOntoLane(lane, classification, opts = {}) {
  const side = opts.side === "origin" ? "origin" : "dest";
  const isOrigin = side === "origin";
  const emailSiteType = isOrigin ? lane.originSiteType : lane.siteType;
  const emailHadSpecific = emailSiteType &&
    emailSiteType !== "other";
  const emailFlags = {...(lane.flags || {})};

  if (!opts.skipSiteTypeOverwrite || !emailHadSpecific) {
    if (isOrigin) {
      lane.originSiteType = classification.siteType;
    } else {
      lane.siteType = classification.siteType;
    }
  }

  const classifiedType = isOrigin ?
    lane.originSiteType : lane.siteType;
  const wantResidential = classification.residentialDelivery === true ||
    classification.siteType === "residential" ||
    classifiedType === "residential";
  if (wantResidential) {
    lane.flags = isOrigin ?
      {...(lane.flags || {}), residentialPickup: true} :
      {...(lane.flags || {}), residentialDelivery: true};
  }

  const meta = {
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
    side,
  };
  if (isOrigin) {
    lane.originEnrichmentMeta = meta;
  } else {
    lane.enrichmentMeta = meta;
  }

  return lane;
}

/**
 * Resolve site type: heuristics → Google strong types → web_search →
 * no-tools AI → other (never bare premise → residential).
 * @param {object} consignee Consignee or shipper.
 * @param {Function} [log] Logger.
 * @param {object} [opts] side origin|dest.
 * @return {Promise<object|null>}
 */
async function resolveClassification(consignee, log = () => {}, opts = {}) {
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

  // Ambiguous / bare geocode → web search (ChatGPT-like facility lookup).
  let web = null;
  try {
    web = await classifyWithWebSearch(consignee, opts);
  } catch (err) {
    log("warn", "quote", "Web-search address classification failed", {
      error: err.message,
    });
  }
  if (web && google && google.placeTypes) {
    web.placeTypes = google.placeTypes;
  }
  // Accept facility / residential hits from web search.
  if (web && (web.siteType !== "other" || web.residentialDelivery === true)) {
    return web;
  }

  // No-tools OpenAI for leftover residential-vs-commercial cues.
  let luna = null;
  try {
    luna = await classifyWithLuna(consignee, opts);
  } catch (err) {
    log("warn", "quote", "Luna address classification failed", {
      error: err.message,
    });
  }
  if (luna && (luna.siteType !== "other" || luna.residentialDelivery === true ||
    (luna.confidence || 0) >= AI_ACCEPT_MIN_CONFIDENCE)) {
    if (web && web.placeName && !luna.placeName) {
      luna.placeName = web.placeName;
    }
    if (google && google.placeName && !luna.placeName) {
      luna.placeName = google.placeName;
    }
    if (google && google.placeTypes) {
      luna.placeTypes = google.placeTypes;
    }
    return luna;
  }

  // Prefer web "other" (no RSD) over inventing residential.
  if (web) {
    return {
      ...web,
      siteType: "other",
      residentialDelivery: false,
      confidence: Math.min(web.confidence || 0.4, 0.55),
    };
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
 * Classify one address party (origin shipper or dest consignee) and
 * merge onto the lane. Cache is address-keyed and shared across sides.
 * @param {object} lane Lane (mutated).
 * @param {object} tenant Tenant config.
 * @param {object} [opts] log, forceRefresh, side origin|dest.
 * @return {Promise<object>} Enriched lane (same reference).
 */
async function enrichLaneParty(lane, tenant, opts = {}) {
  const side = opts.side === "origin" ? "origin" : "dest";
  const party = side === "origin" ?
    (lane.shipper || {}) : (lane.consignee || {});
  const addressKey = normalizeAddressKey(party);
  if (!addressKey) {
    return lane;
  }

  const log = opts.log || (() => {});
  const sideLabel = side === "origin" ? "origin" : "dest";

  if (!opts.forceRefresh) {
    const cached = await getCachedClassification(tenant, addressKey);
    if (cached && cached.siteType) {
      log("info", "quote", "Address classification cache hit", {
        addressKey, siteType: cached.siteType, side: sideLabel,
      });
      mergeClassificationOntoLane(lane, {
        ...cached,
        cacheHit: true,
        addressKey,
      }, {side, skipSiteTypeOverwrite: opts.skipSiteTypeOverwrite});
      return lane;
    }
  }

  let classification = null;
  try {
    classification = await resolveClassification(party, log, {side});
  } catch (err) {
    log("warn", "quote", "Address classification failed", {
      addressKey, side: sideLabel, error: err.message,
    });
  }

  if (!classification) {
    log("warn", "quote", "Address enrichment skipped — no classifier", {
      addressKey, side: sideLabel,
    });
    return lane;
  }

  classification.addressKey = addressKey;
  classification.consignee = {
    name: party.name || null,
    address1: party.address1 || null,
    city: party.city || null,
    state: party.state || null,
    zipCode: party.zipCode || null,
  };

  mergeClassificationOntoLane(lane, classification, {
    side,
    skipSiteTypeOverwrite: opts.skipSiteTypeOverwrite,
  });

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
      addressKey, side: sideLabel, error: err.message,
    });
  }

  log("info", "quote", "Address classified", {
    addressKey,
    side: sideLabel,
    siteType: classification.siteType,
    source: classification.source,
    residentialDelivery: !!classification.residentialDelivery,
  });

  return lane;
}

/**
 * Main dest entry — enrich lane consignee with site classification.
 * @param {object} lane Lane with consignee.
 * @param {object} tenant Tenant config.
 * @param {object} [opts] log, forceRefresh.
 * @return {Promise<object>} Enriched lane (same reference).
 */
async function enrichLaneConsignee(lane, tenant, opts = {}) {
  return enrichLaneParty(lane, tenant, {...opts, side: "dest"});
}

/**
 * Enrich lane shipper / origin with the same classification pipeline.
 * @param {object} lane Lane with shipper.
 * @param {object} tenant Tenant config.
 * @param {object} [opts] log, forceRefresh.
 * @return {Promise<object>} Enriched lane (same reference).
 */
async function enrichLaneShipper(lane, tenant, opts = {}) {
  return enrichLaneParty(lane, tenant, {...opts, side: "origin"});
}

/**
 * Classify Ship From and Ship To on a lane.
 * @param {object} lane Lane with shipper and consignee.
 * @param {object} tenant Tenant config.
 * @param {object} [opts] log, forceRefresh.
 * @return {Promise<object>} Enriched lane (same reference).
 */
async function enrichLaneAddresses(lane, tenant, opts = {}) {
  if (lane && typeof lane === "object") {
    if (lane.shipper) {
      lane.shipper = await fillPartyOdFromZipOrCityState(lane.shipper, lane);
    }
    if (lane.consignee) {
      lane.consignee = await fillPartyOdFromZipOrCityState(
          lane.consignee, lane);
    }
    const quoteRules = opts.quoteRules;
    if (Array.isArray(quoteRules) && quoteRules.length) {
      const quoteAccessorialRules = require("./quote-accessorial-rules");
      quoteAccessorialRules.applyZipFillRules(lane, quoteRules, lane, {
        fromEmail: opts.fromEmail || lane.fromEmail || lane.from || "",
        fromName: opts.fromName || lane.fromName || "",
        customerName: opts.customerName ||
          lane.customerName || lane.shippingLocationName || "",
      });
    }
  }
  await enrichLaneShipper(lane, tenant, opts);
  await enrichLaneConsignee(lane, tenant, opts);
  return lane;
}

module.exports = {
  init,
  SITE_TYPES,
  SITE_TYPE_LABELS,
  CHAIN_STORE_NAME_RE,
  RESIDENTIAL_MIN_CONFIDENCE,
  normalizeAddressKey,
  normalizePart,
  addressKeyToDocId,
  getCachedClassification,
  saveCachedClassification,
  deleteCachedClassification,
  classifyFromNameHeuristics,
  isMilitarySiteText,
  classifyWithGooglePlaces,
  classifyWithLuna,
  classifyWithWebSearch,
  classifyWithAi,
  resolveClassification,
  enrichLaneParty,
  enrichLaneConsignee,
  enrichLaneShipper,
  enrichLaneAddresses,
  mergeClassificationOntoLane,
  mapGoogleTypesToSiteType,
  isBareStreetGeocode,
  isAddressOnlyOrWeakName,
  lookupUsZip,
  lookupUsZipFromCityState,
  lookupZipFromCityState,
  lookupKnownCityStateZip,
  KNOWN_CITY_STATE_ZIPS,
  fillPartyCityStateFromZip,
  fillPartyZipFromCityState,
  fillPartyOdFromZipOrCityState,
  applyKnownWarehouseZipOverride,
  partyNeedsCityStateFromZip,
  partyNeedsZipFromCityState,
};
