/**
 * Quote accessorial rules — Firestore-backed, applied before rate shop.
 *
 * Pallet trailer capacity (combine same-OD / split oversize) is a separate
 * always-on built-in in quote-freight-rules.js (MAX 26 PLT/trailer), applied
 * after extractQuoteRequest and before accessorial rules / rateLane.
 */

"use strict";

const admin = require("firebase-admin");
const declinedAcc = require("./quote-declined-accessorials");
// quote-email-accessorials is lazy-required in applyRulesToLane to avoid
// a circular dependency with quote-output (via catalog → rate-shop).

const IDENTIFY_VIA_VALUES = ["address_text", "ai", "both", "email"];
const DEFAULT_IDENTIFY_VIA = "both";
const APPLY_TO_VALUES = ["dest", "origin", "both"];
const DEFAULT_APPLY_TO = "dest";
const RULE_KIND_SENDER_CUSTOMER = "sender_customer";
const RULE_KIND_ZIP_FILL = "zip_fill";
const RULE_KIND_CARRIER_DISPLAY_CLEAN = "carrier_display_clean";

/**
 * Single source of truth: match keys the runtime actually consumes.
 * Chat/UI may still write other keys; unknown leftovers fail loud.
 */
const WIRED_MATCH_KEYS = new Set([
  "flags",
  "siteType",
  "instructionsContains",
  "referenceContains",
  "consigneeNameContains",
  "consigneeAddressContains",
  "shipperNameContains",
  "shipperAddressContains",
  "nameContains",
  "addressContains",
  "cityContains",
  "shipperCityContains",
  "consigneeCityContains",
  "shipperState",
  "consigneeState",
  "state",
  "fromEmails",
  "senderEmails",
  "senderDomains",
  "ccEmails",
  "toEmails",
  "fromNames",
  "carrierNameContains",
]);

/** Top-level action / identity fields the engine consumes. */
const WIRED_ACTION_FIELDS = new Set([
  "addAccessorials",
  "removeAccessorials",
  "filterCarrierWarnings",
  "addAccessorialsWithData",
  "customerName",
  "protocolOnly",
  "defaultDims",
  "fromNames",
  "fillZipCode",
  "zipCode",
  "applyTo",
  "notes",
  "ruleKind",
  "identifyVia",
  "active",
  "priority",
  "name",
  "autoApply",
  "requiresConfirm",
]);

/** Dest accessorial → pickup equivalent when a rule applies to origin. */
const DEST_TO_ORIGIN_ACCESSORIAL = {
  RSD: "RSO",
  LAD: "LAO",
  LFD: "LFO",
  APD: "APO",
  IND: "INO",
  NUD: "NUP",
  HOD: "HOO",
  SCD: "SCO",
};

/**
 * Chat/UI "request flags" that are never written onto lane.flags by intake.
 * Runtime treats them as true when the mapped accessorial is present, the
 * email/instructions mention the service, or lane.flags[flag] is set.
 * (insuranceRequested was stored Active but never matched — INS stayed on
 * the Primus rate and Redkik failed with "Commodity is required (53)".)
 */
const SYNTHETIC_REQUEST_FLAGS = {
  insuranceRequested: {
    codes: ["INS"],
    textRe: /\binsurance\b/i,
  },
  appointmentRequired: {
    codes: ["APD", "APO"],
    textRe: /\bappointments?\b|\bappt(\s+required)?\b/i,
  },
};

/**
 * Default rule ids whose addAccessorials / name / notes are force-synced
 * from DEFAULT_RULES on load (overrides stale Firestore seed values).
 */
const MANAGED_DEFAULT_RULE_IDS = new Set([
  "aafes_military",
  "amazon_fc",
  "chain_store_appointment",
  "hotel_limited_access",
  "sender_mike_oseback",
  "sender_jared_berman",
  "sender_lifeworks_picking",
  "sender_shaya_jacobowitz",
  "zip_fill_la_mirada_stg",
  "liftgate_no_dock",
]);

/**
 * Former product defaults that must never be re-seeded after delete,
 * even though they are no longer listed in DEFAULT_RULES.
 */
const RETIRED_DEFAULT_RULE_IDS = new Set([
  "nursing_home",
  "hotel",
]);

const DEFAULT_RULES = [
  {
    id: "sender_mike_oseback",
    active: true,
    priority: 5,
    name: "Sender → Mike Oseback",
    ruleKind: RULE_KIND_SENDER_CUSTOMER,
    identifyVia: "email",
    match: {
      fromEmails: ["mike.oseback@ediexpressinc.com"],
      ccEmails: ["mike.oseback@ediexpressinc.com"],
      toEmails: ["mike.oseback@ediexpressinc.com"],
    },
    customerName: "Mike Oseback",
    protocolOnly: true,
    addAccessorials: [],
    applyTo: "dest",
    notes: "Map EDI Express From/Cc/To to Mike Oseback (protocol only). " +
      "Applies when Mike sends or is CC'd/To'd. Does not add accessorials.",
    autoApply: true,
    requiresConfirm: false,
  },
  {
    id: "sender_jared_berman",
    active: true,
    priority: 5,
    name: "Sender → Brumis Imports Inc",
    ruleKind: RULE_KIND_SENDER_CUSTOMER,
    identifyVia: "email",
    match: {
      fromEmails: ["jared.berman@corehome.com"],
    },
    customerName: "Brumis Imports Inc",
    protocolOnly: false,
    defaultDims: {length: 40, width: 48, height: 62},
    addAccessorials: [],
    applyTo: "dest",
    fromNames: ["jared berman"],
    notes: "Map Jared Berman / Corehome to Brumis Imports Inc; " +
      "default missing pallet dims to 40×48×62.",
    autoApply: true,
    requiresConfirm: false,
  },
  {
    id: "sender_lifeworks_picking",
    active: true,
    priority: 5,
    name: "Sender → Lifeworks Technology Group",
    ruleKind: RULE_KIND_SENDER_CUSTOMER,
    identifyVia: "email",
    match: {
      fromEmails: ["lfwpicking@coreforce.com"],
    },
    customerName: "Lifeworks Technology Group",
    protocolOnly: false,
    addAccessorials: [],
    applyTo: "dest",
    fromNames: ["lifeworks picking"],
    notes: "Map Lifeworks Picking (lfwpicking@coreforce.com) to " +
      "Lifeworks Technology Group; FW body From resolved like Jared.",
    autoApply: true,
    requiresConfirm: false,
  },
  {
    id: "sender_shaya_jacobowitz",
    active: true,
    priority: 5,
    name: "Sender → Prime Packaging Inc",
    ruleKind: RULE_KIND_SENDER_CUSTOMER,
    identifyVia: "email",
    match: {
      fromEmails: ["shaya@primepackaging.com"],
    },
    customerName: "Prime Packaging Inc",
    protocolOnly: false,
    addAccessorials: [],
    applyTo: "dest",
    fromNames: ["shaya jacobowitz"],
    notes: "Map Shaya Jacobowitz / Prime Packaging to " +
      "Prime Packaging Inc; FW body From resolved like Jared.",
    autoApply: true,
    requiresConfirm: false,
  },
  {
    id: "zip_fill_la_mirada_stg",
    active: true,
    priority: 3,
    name: "La Mirada CA pickup → ZIP 90670",
    ruleKind: RULE_KIND_ZIP_FILL,
    identifyVia: "ai",
    applyTo: "origin",
    match: {
      shipperCityContains: ["la mirada"],
      shipperState: "CA",
    },
    fillZipCode: "90670",
    addAccessorials: [],
    notes: "STG La Mirada warehouse — rate pickup as Santa Fe Springs 90670.",
    autoApply: true,
    requiresConfirm: false,
  },
  {
    id: "liftgate_no_dock",
    active: true,
    priority: 10,
    name: "Liftgate — no loading dock",
    identifyVia: "address_text",
    match: {
      instructionsContains: [
        "lift gate", "liftgate", "lift-gate",
        "no loading dock", "no dock",
      ],
    },
    // Delivery/consignee is the default side. Pickup (LFO) only when
    // email/instructions explicitly say liftgate at pickup/origin —
    // see quote-email-accessorials refineLiftgateSides.
    addAccessorials: ["LFD"],
    applyTo: "dest",
    notes: "Special instructions mention liftgate or no dock " +
      "(destination liftgate; pickup only if email says so).",
    autoApply: true,
    requiresConfirm: false,
  },
  {
    id: "aafes_military",
    active: true,
    priority: 25,
    name: "Military bases — limited access, appointment delivery",
    identifyVia: "ai",
    match: {
      siteType: "aafes_military",
    },
    addAccessorials: ["LAD", "APD"],
    applyTo: "dest",
    notes: "AI-classified military base / AAFES — " +
      "limited access and appointment delivery (destination only).",
    autoApply: true,
    requiresConfirm: false,
  },
  // Retired defaults (kept out of seed; tombstoned on delete):
  // nursing_home, hotel (old rule used HOD — use hotel_limited_access + LAD)
  {
    id: "hotel_limited_access",
    active: true,
    priority: 45,
    name: "Hotels / casinos / resorts — limited access delivery",
    identifyVia: "both",
    match: {
      siteType: "hotel",
    },
    addAccessorials: ["LAD"],
    applyTo: "dest",
    notes: "Hotel, casino, or resort destination — limited access delivery " +
      "(LAD). Do not use hotel delivery fee (HOD).",
    autoApply: true,
    requiresConfirm: false,
  },
  {
    id: "menards_dc",
    active: true,
    priority: 20,
    name: "Menards DC — filter blocked carriers",
    identifyVia: "both",
    match: {
      consigneeNameContains: ["menards", "MENARDS"],
      siteType: "menards_dc",
    },
    addAccessorials: [],
    applyTo: "dest",
    filterCarrierWarnings: ["menards"],
    notes: "Exclude carriers whose warnings block Menards delivery.",
    autoApply: true,
    requiresConfirm: false,
  },
  {
    id: "amazon_fc",
    active: true,
    priority: 50,
    name: "Amazon FC — appointment delivery",
    identifyVia: "both",
    match: {
      consigneeNameContains: [
        "amazon", "fba", "amz", "hgr6", "hgr",
      ],
      siteType: "amazon_fc",
    },
    // Amazon FCs need appointment (APD) only — not Limited Access (LAD).
    addAccessorials: ["APD"],
    applyTo: "dest",
    notes: "Amazon fulfillment center — appointment delivery only (no LAD).",
    autoApply: true,
    requiresConfirm: true,
  },
  {
    id: "chain_store_appointment",
    active: true,
    priority: 55,
    name: "Chain stores — appointment delivery",
    identifyVia: "both",
    match: {
      consigneeNameContains: [
        "walmart", "wal-mart", "target", "tj maxx", "tjmaxx",
        "marshalls", "homegoods", "bj's", "bjs", "albertsons",
        "albersons", "safeway", "costco", "sam's club", "sams club",
        "home depot", "lowe's", "lowes", "kroger", "publix", "meijer",
        "shoprite", "shop rite", "food lion", "winn-dixie", "heb",
        "whole foods", "trader joe", "cvs", "walgreens",
        "dollar general", "dollar tree", "family dollar", "best buy",
        "office depot", "staples", "macy's", "macys", "kohl's",
        "kohls", "jcpenney", "sears", "giant eagle", "stop & shop",
        "wegmans", "ingles", "harris teeter",
      ],
      siteType: "chain_store",
    },
    addAccessorials: ["APD"],
    applyTo: "dest",
    notes: "Big-box / grocery chain consignee — appointment delivery (APD). " +
      "Skipped when customer declined appointment.",
    autoApply: true,
    requiresConfirm: false,
  },
  {
    id: "residential_delivery",
    active: true,
    priority: 60,
    name: "Residential delivery flag",
    identifyVia: "both",
    match: {flags: ["residentialDelivery"]},
    addAccessorials: ["RSD"],
    applyTo: "dest",
    notes: "AI or heuristic flagged residential delivery.",
    autoApply: true,
    requiresConfirm: false,
  },
  {
    id: "appointment_delivery_text",
    active: true,
    priority: 65,
    name: "Appointment delivery — email request",
    identifyVia: "address_text",
    match: {
      instructionsContains: [
        "appointment", "appt required", "must call",
        "schedule delivery", "delivery appointment",
      ],
    },
    addAccessorials: ["APD"],
    applyTo: "dest",
    notes: "Special instructions mention appointment delivery.",
    autoApply: true,
    requiresConfirm: false,
  },
  {
    id: "residential_pickup",
    active: true,
    priority: 61,
    name: "Residential pickup flag",
    identifyVia: "both",
    applyTo: "origin",
    match: {flags: ["residentialPickup"]},
    addAccessorials: ["RSO"],
    notes: "AI or heuristic flagged residential pickup (origin).",
    autoApply: true,
    requiresConfirm: false,
  },
  {
    id: "aafes_military_pickup",
    active: true,
    priority: 26,
    name: "Military bases — limited access pickup",
    identifyVia: "ai",
    applyTo: "origin",
    match: {
      siteType: "aafes_military",
    },
    addAccessorials: ["LAO"],
    notes: "AI-classified military origin — limited access pickup only " +
      "(not dest LAD/APD).",
    autoApply: true,
    requiresConfirm: false,
  },
];

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
  if (!tcolFn) throw new Error("quote-accessorial-rules not initialized");
  return tcolFn(tenant, name);
}

/**
 * @param {object} rule Rule document.
 * @return {"dest"|"origin"|"both"}
 */
function normalizeApplyTo(rule) {
  const v = rule && rule.applyTo;
  return APPLY_TO_VALUES.includes(v) ? v : DEFAULT_APPLY_TO;
}

/**
 * Map dest accessorials to pickup codes when applying a rule to origin.
 * Dest-only rules never call this — they stay dest-scoped via applyTo.
 * @param {Array<string>} codes Rule accessorials.
 * @param {"dest"|"origin"} side Lane side.
 * @return {Array<string>}
 */
function accessorialsForSide(codes, side) {
  const list = (codes || []).map(String);
  if (side !== "origin") return [...new Set(list)];
  const out = [];
  for (const c of list) {
    out.push(DEST_TO_ORIGIN_ACCESSORIAL[c] || c);
  }
  return [...new Set(out)];
}

/**
 * Sides a rule should evaluate against.
 * @param {object} rule Rule document.
 * @return {Array<"dest"|"origin">}
 */
function ruleSides(rule) {
  const applyTo = normalizeApplyTo(rule);
  if (applyTo === "both") return ["dest", "origin"];
  if (applyTo === "origin") return ["origin"];
  return ["dest"];
}

/**
 * @param {object} rule Rule document.
 * @return {"address_text"|"ai"|"both"|"email"}
 */
function normalizeIdentifyVia(rule) {
  const v = rule && rule.identifyVia;
  return IDENTIFY_VIA_VALUES.includes(v) ? v : DEFAULT_IDENTIFY_VIA;
}

/**
 * True when a rule has lane accessorial / filter actions (not just
 * sender→customer or carrier email note metadata).
 * @param {object} rule Rule document.
 * @return {boolean}
 */
function hasLaneAccessorialActions(rule) {
  if (!rule || typeof rule !== "object") return false;
  return (rule.addAccessorials || []).length > 0 ||
    (rule.removeAccessorials || []).length > 0 ||
    (rule.filterCarrierWarnings || []).length > 0 ||
    (Array.isArray(rule.addAccessorialsWithData) &&
      rule.addAccessorialsWithData.length > 0);
}

/**
 * Match keys that identify the RFQ sender / mailbox participants.
 * @param {object} match Rule match object.
 * @return {boolean}
 */
function matchHasSenderIdentityKeys(match) {
  const m = match && typeof match === "object" ? match : {};
  const emails = []
      .concat(m.fromEmails || [])
      .concat(m.senderEmails || [])
      .concat(m.ccEmails || [])
      .concat(m.toEmails || []);
  const domains = [].concat(m.senderDomains || []);
  const fromNames = [].concat(m.fromNames || []);
  return emails.some((e) => String(e || "").includes("@")) ||
    domains.some((d) => !!String(d || "").trim()) ||
    fromNames.some((n) => !!String(n || "").trim());
}

/**
 * Sender→customer mapping rules are applied at intake.
 * Rules that ALSO add/remove accessorials still match here for identity,
 * but applyRulesToLane must not skip them — see isPureSenderCustomerRule.
 * @param {object} rule Rule document.
 * @return {boolean}
 */
function isSenderCustomerRule(rule) {
  if (!rule || typeof rule !== "object") return false;
  if (rule.ruleKind === RULE_KIND_SENDER_CUSTOMER) return true;
  if (rule.ruleKind === RULE_KIND_ZIP_FILL) return false;
  if (normalizeIdentifyVia(rule) === "email" && rule.customerName) return true;
  const match = rule.match && typeof rule.match === "object" ? rule.match : {};
  if (matchHasSenderIdentityKeys(match)) return true;
  const topNames = [].concat(rule.fromNames || []);
  return topNames.some((n) => !!String(n || "").trim()) &&
    !!(rule.customerName || rule.defaultDims || rule.protocolOnly);
}

/**
 * Pure sender→customer (no lane accessorial actions). These are skipped
 * inside applyRulesToLane because intake already attaches customer/dims.
 * @param {object} rule Rule document.
 * @return {boolean}
 */
function isPureSenderCustomerRule(rule) {
  if (!isSenderCustomerRule(rule)) return false;
  if (hasLaneAccessorialActions(rule)) return false;
  if (isZipFillRule(rule)) return false;
  if (isCarrierNoteRule(rule) || isCarrierDisplayCleanRule(rule)) {
    return false;
  }
  return true;
}

/**
 * Whether sender identity constraints on the rule match email context.
 * Rules with no sender keys always pass. Present constraint groups are
 * AND'd (same pattern as zip-fill filters).
 * @param {object} rule Rule document.
 * @param {object} context Rate / extract context.
 * @return {boolean}
 */
function senderConstraintsMatch(rule, context) {
  const match = rule && rule.match && typeof rule.match === "object" ?
    rule.match : {};
  const ctx = context && typeof context === "object" ? context : {};
  const fromNames = []
      .concat(rule && rule.fromNames || [])
      .concat(match.fromNames || [])
      .map((n) => String(n || "").trim().toLowerCase())
      .filter(Boolean);
  const fromEmails = []
      .concat(match.fromEmails || [])
      .concat(match.senderEmails || [])
      .map((e) => String(e || "").trim().toLowerCase())
      .filter((e) => e.includes("@"));
  const domains = [].concat(match.senderDomains || [])
      .map((d) => String(d || "").trim().toLowerCase().replace(/^@+/, ""))
      .filter(Boolean);
  const ccWant = [].concat(match.ccEmails || [])
      .map((e) => String(e || "").trim().toLowerCase())
      .filter((e) => e.includes("@"));
  const toWant = [].concat(match.toEmails || [])
      .map((e) => String(e || "").trim().toLowerCase())
      .filter((e) => e.includes("@"));

  const hasConstraint = fromEmails.length || domains.length ||
    fromNames.length || ccWant.length || toWant.length;
  if (!hasConstraint) return true;

  const from = String(ctx.fromEmail || ctx.from || "").trim().toLowerCase();
  const fromName = String(ctx.fromName || "").trim().toLowerCase();
  const ccHave = []
      .concat(ctx.ccEmails || [])
      .concat(ctx.cc || [])
      .map((e) => String(e || "").trim().toLowerCase())
      .filter((e) => e.includes("@"));
  const toHave = []
      .concat(ctx.toEmails || [])
      .concat(ctx.to || [])
      .map((e) => String(e || "").trim().toLowerCase())
      .filter((e) => e.includes("@"));

  // From / Cc / To email lists: any listed mailbox role may satisfy.
  if (fromEmails.length || ccWant.length || toWant.length) {
    const fromHit = fromEmails.length && from && fromEmails.includes(from);
    const ccHit = ccWant.length && ccWant.some((e) => ccHave.includes(e));
    const toHit = toWant.length && toWant.some((e) => toHave.includes(e));
    // If only Cc/To listed (no fromEmails), those alone can match.
    if (fromEmails.length) {
      if (!fromHit && !ccHit && !toHit) return false;
    } else if (!ccHit && !toHit) {
      return false;
    }
  }
  if (domains.length) {
    const at = from.lastIndexOf("@");
    const domain = at >= 0 ? from.slice(at + 1) : "";
    if (!domain || !domains.includes(domain)) return false;
  }
  if (fromNames.length) {
    if (!fromName || !containsAny(fromName, fromNames)) return false;
  }
  return true;
}

/**
 * True when a quoteRules doc fills or corrects city/state → ZIP.
 * @param {object} rule Rule document.
 * @return {boolean}
 */
function isZipFillRule(rule) {
  if (!rule || typeof rule !== "object") return false;
  if (rule.ruleKind === RULE_KIND_ZIP_FILL) return true;
  const zip = String(rule.fillZipCode || rule.zipCode || "").replace(/\D/g, "")
      .slice(0, 5);
  if (!/^\d{5}$/.test(zip)) return false;
  const match = rule.match && typeof rule.match === "object" ? rule.match : {};
  return !!(match.shipperCityContains || match.consigneeCityContains ||
    match.shipperState || match.consigneeState);
}

/**
 * Normalize a 5-digit US ZIP from rule fields.
 * @param {object} rule Rule document.
 * @return {string}
 */
function zipFillCodeFromRule(rule) {
  return String(rule && (rule.fillZipCode || rule.zipCode) || "")
      .replace(/\D/g, "")
      .slice(0, 5);
}

/**
 * @param {string} haystack Text to search.
 * @param {Array<string>|string} needles Substrings (case insensitive).
 * @return {boolean}
 */
function containsAnyNeedle(haystack, needles) {
  const list = Array.isArray(needles) ? needles :
    (needles ? [needles] : []);
  return containsAny(haystack, list);
}

/**
 * Whether a zip-fill rule matches one lane side.
 * @param {object} party Shipper or consignee.
 * @param {object} match Rule match object.
 * @param {"origin"|"dest"} side Lane side.
 * @return {boolean}
 */
function zipFillRuleMatchesParty(party, match, side) {
  const m = match && typeof match === "object" ? match : {};
  const p = party && typeof party === "object" ? party : {};
  const city = String(p.city || "").trim();
  const state = String(p.state || "").trim().toUpperCase();
  const name = String(p.name || "").trim();
  if (side === "origin") {
    const cities = m.shipperCityContains || m.cityContains || [];
    if (cities.length &&
        !containsAnyNeedle(city, cities) &&
        !containsAnyNeedle(name, cities)) {
      return false;
    }
    const wantState = String(m.shipperState || m.state || "").trim()
        .toUpperCase();
    if (wantState && state && wantState !== state) return false;
    const names = m.shipperNameContains || [];
    if (names.length && !containsAnyNeedle(name, names)) return false;
    return cities.length > 0 || !!wantState || names.length > 0;
  }
  const cities = m.consigneeCityContains || m.cityContains || [];
  if (cities.length &&
      !containsAnyNeedle(city, cities) &&
      !containsAnyNeedle(name, cities)) {
    return false;
  }
  const wantState = String(m.consigneeState || m.state || "").trim()
      .toUpperCase();
  if (wantState && state && wantState !== state) return false;
  const names = m.consigneeNameContains || [];
  if (names.length && !containsAnyNeedle(name, names)) return false;
  return cities.length > 0 || !!wantState || names.length > 0;
}

/**
 * Optional customer / sender filters on zip-fill rules.
 * @param {object} rule Rule document.
 * @param {object} context {fromEmail, fromName, customerName}.
 * @return {boolean}
 */
function zipFillRuleMatchesContext(rule, context) {
  if (!rule || typeof rule !== "object") return true;
  const ctx = context && typeof context === "object" ? context : {};
  const cust = String(rule.customerName || "").trim();
  if (cust) {
    const have = String(ctx.customerName || ctx.shippingLocationName || "")
        .trim()
        .toLowerCase();
    const want = cust.toLowerCase();
    if (!have) return false;
    if (!(have.includes(want) || want.includes(have))) return false;
  }
  const match = rule.match && typeof rule.match === "object" ? rule.match : {};
  const emails = [].concat(match.fromEmails || match.senderEmails || []);
  const from = String(ctx.fromEmail || ctx.from || "").trim().toLowerCase();
  if (emails.length) {
    if (!from || !emails.some((e) => from === String(e).toLowerCase())) {
      return false;
    }
  }
  const fromNames = [].concat(rule.fromNames || match.fromNames || []);
  if (fromNames.length) {
    const fromName = String(ctx.fromName || "").trim().toLowerCase();
    if (!fromName || !containsAnyNeedle(fromName, fromNames)) return false;
  }
  return true;
}

/**
 * Apply Firestore zip-fill rules to lane shipper/consignee (overrides wrong
 * geocoded ZIPs for known warehouse cities).
 * @param {object} lane Lane (mutated).
 * @param {Array<object>} rules Active quote rules.
 * @param {object} [laneRef] Lane for extractionWarnings.
 * @param {object} [context] Optional {fromEmail, fromName, customerName}.
 * @return {Array<object>} Applied zip-fill rule summaries.
 */
function applyZipFillRules(lane, rules, laneRef, context) {
  const targetLane = laneRef || lane;
  const ctx = {
    fromEmail: (context && context.fromEmail) ||
      lane.fromEmail || lane.from || "",
    fromName: (context && context.fromName) || lane.fromName || "",
    customerName: (context && context.customerName) ||
      lane.customerName || lane.shippingLocationName || "",
  };
  const applied = [];
  const list = (rules || [])
      .filter((r) => r && r.active !== false && isZipFillRule(r))
      .slice()
      .sort((a, b) =>
        (Number(a.priority) || 100) - (Number(b.priority) || 100));
  for (const rule of list) {
    const zipCode = zipFillCodeFromRule(rule);
    if (!/^\d{5}$/.test(zipCode)) continue;
    if (!zipFillRuleMatchesContext(rule, ctx)) continue;
    const match = rule.match && typeof rule.match === "object" ?
      rule.match : {};
    for (const side of ruleSides(rule)) {
      const key = side === "origin" ? "shipper" : "consignee";
      const party = lane[key];
      if (!party || typeof party !== "object") continue;
      if (!zipFillRuleMatchesParty(party, match, side)) continue;
      const existing = String(party.zipCode || party.zipcode || party.zip || "")
          .replace(/\D/g, "")
          .slice(0, 5);
      if (existing === zipCode) continue;
      lane[key] = {
        ...party,
        zipCode,
        country: String(party.country || "US").trim() || "US",
      };
      const warnings = Array.isArray(targetLane.extractionWarnings) ?
        targetLane.extractionWarnings : [];
      if (!warnings.includes("zip filled")) warnings.push("zip filled");
      targetLane.extractionWarnings = warnings;
      applied.push({
        ruleId: rule.id,
        name: rule.name,
        applyTo: side,
        fillZipCode: zipCode,
      });
    }
  }
  return applied;
}

/**
 * Classify how the runtime wires an Active quoteRules doc.
 * @param {object} rule Rule document.
 * @return {{wired: boolean, enginePath: string|null,
 *   unknownMatchKeys: Array<string>, reason: string|null}}
 */
function analyzeRuleWiring(rule) {
  if (!rule || typeof rule !== "object") {
    return {
      wired: false,
      enginePath: null,
      unknownMatchKeys: [],
      reason: "empty_rule",
    };
  }
  const match = rule.match && typeof rule.match === "object" ? rule.match : {};
  const matchKeys = Object.keys(match).filter((k) => {
    const v = match[k];
    if (v == null || v === "") return false;
    if (Array.isArray(v) && !v.length) return false;
    return true;
  });
  const unknownMatchKeys = matchKeys.filter((k) => !WIRED_MATCH_KEYS.has(k));

  if (isCarrierDisplayCleanRule(rule) &&
      carrierNameContainsNeedles(rule).length) {
    return {
      wired: true,
      enginePath: "carrier_display_clean",
      unknownMatchKeys,
      reason: null,
    };
  }
  if (isCarrierNoteRule(rule) &&
      carrierNameContainsNeedles(rule).length &&
      String(rule.notes || "").trim()) {
    return {
      wired: true,
      enginePath: "carrier_note",
      unknownMatchKeys,
      reason: null,
    };
  }
  if (isZipFillRule(rule) && /^\d{5}$/.test(zipFillCodeFromRule(rule))) {
    return {
      wired: true,
      enginePath: "zip_fill",
      unknownMatchKeys,
      reason: null,
    };
  }
  if (isNeverAddInsuranceRule(rule)) {
    return {
      wired: true,
      enginePath: "never_insurance",
      unknownMatchKeys,
      reason: null,
    };
  }
  if (isPureSenderCustomerRule(rule) &&
      (rule.customerName || rule.defaultDims || rule.protocolOnly ||
        rule.ruleKind === RULE_KIND_SENDER_CUSTOMER)) {
    return {
      wired: true,
      enginePath: "sender_customer",
      unknownMatchKeys,
      reason: null,
    };
  }
  if (hasLaneAccessorialActions(rule)) {
    const known = matchKeys.some((k) => WIRED_MATCH_KEYS.has(k)) ||
      [].concat(rule.fromNames || []).some((n) => !!String(n || "").trim());
    if (known) {
      return {
        wired: true,
        enginePath: "accessorial",
        unknownMatchKeys,
        reason: null,
      };
    }
    return {
      wired: false,
      enginePath: null,
      unknownMatchKeys,
      reason: "accessorial_actions_without_wired_match",
    };
  }
  if (isCarrierDisplayCleanRule(rule) || isCarrierNoteRule(rule)) {
    return {
      wired: false,
      enginePath: null,
      unknownMatchKeys,
      reason: "carrier_rule_missing_needles_or_notes",
    };
  }
  if (isSenderCustomerRule(rule) && !rule.customerName && !rule.defaultDims) {
    return {
      wired: false,
      enginePath: null,
      unknownMatchKeys,
      reason: "sender_rule_missing_customer_or_dims",
    };
  }
  if (matchKeys.length && unknownMatchKeys.length === matchKeys.length) {
    return {
      wired: false,
      enginePath: null,
      unknownMatchKeys,
      reason: "unknown_match_keys_only",
    };
  }
  if (!matchKeys.length && !rule.customerName && !rule.fillZipCode &&
      !hasLaneAccessorialActions(rule)) {
    return {
      wired: false,
      enginePath: null,
      unknownMatchKeys,
      reason: "no_match_or_action",
    };
  }
  if (matchKeys.some((k) => WIRED_MATCH_KEYS.has(k))) {
    return {
      wired: true,
      enginePath: "accessorial",
      unknownMatchKeys,
      reason: null,
    };
  }
  return {
    wired: false,
    enginePath: null,
    unknownMatchKeys,
    reason: "unwired_rule_shape",
  };
}

/**
 * Annotate rules with wiring analysis (non-persistent helper fields).
 * @param {Array<object>} rules Rules.
 * @return {Array<object>}
 */
function annotateRulesWiring(rules) {
  return (rules || []).map((rule) => {
    const wiring = analyzeRuleWiring(rule);
    return {
      ...rule,
      wiringStatus: wiring.wired ? "wired" : "unwired",
      wiringPath: wiring.enginePath,
      wiringUnknownMatchKeys: wiring.unknownMatchKeys,
      wiringReason: wiring.reason,
    };
  });
}

/**
 * Active rules the engine cannot apply (fail loud).
 * @param {Array<object>} rules Active rules.
 * @return {Array<object>} {ruleId, name, reason, unknownMatchKeys}
 */
function collectUnwiredActiveWarnings(rules) {
  const out = [];
  for (const rule of rules || []) {
    if (!rule || rule.active === false) continue;
    const wiring = analyzeRuleWiring(rule);
    if (wiring.wired) continue;
    out.push({
      ruleId: String(rule.id || ""),
      name: String(rule.name || rule.id || "unnamed"),
      reason: wiring.reason || "unwired",
      unknownMatchKeys: wiring.unknownMatchKeys || [],
    });
  }
  return out;
}

/**
 * @param {object} tenant Tenant.
 * @return {Promise<Array<object>>}
 */
async function loadActiveRules(tenant) {
  await ensureDefaultRulesPresent(tenant);
  const snap = await col(tenant, "quoteRules")
      .where("active", "==", true)
      .get();
  // Brand-new tenant: ensure may no-op if DEFAULT_RULES empty of
  // non-tombstoned ids; seed fills remaining defaults once.
  if (snap.empty) {
    const any = await col(tenant, "quoteRules").limit(1).get();
    if (any.empty) {
      await seedDefaultRules(tenant);
      const again = await col(tenant, "quoteRules")
          .where("active", "==", true)
          .get();
      const seeded = again.docs.map((d) => ({id: d.id, ...d.data()}))
          .sort((a, b) =>
            (Number(a.priority) || 999) - (Number(b.priority) || 999));
      return annotateRulesWiring(seeded);
    }
  }
  const rules = snap.docs.map((d) => ({id: d.id, ...d.data()}));
  const sorted = rules.sort((a, b) =>
    (Number(a.priority) || 999) - (Number(b.priority) || 999));
  const annotated = annotateRulesWiring(sorted);
  const unwired = collectUnwiredActiveWarnings(annotated);
  if (unwired.length) {
    console.warn(
        "[quote-rules] Active rules with no runtime wiring:",
        unwired.map((u) => `${u.ruleId}(${u.reason})`).join(", "));
  }
  return annotated;
}

/**
 * Ids the tenant intentionally deleted (do not re-seed from DEFAULT_RULES).
 * @param {object} tenant Tenant.
 * @return {Promise<Set<string>>}
 */
async function loadRemovedDefaultRuleIds(tenant) {
  const snap = await col(tenant, "quoteRulesRemoved").get();
  return new Set(snap.docs.map((d) => d.id));
}

/**
 * @param {object} tenant Tenant.
 * @param {string} ruleId Rule id.
 * @param {string} [removedBy] Actor.
 * @return {Promise<void>}
 */
async function markDefaultRuleRemoved(tenant, ruleId, removedBy) {
  await col(tenant, "quoteRulesRemoved").doc(String(ruleId)).set({
    ruleId: String(ruleId),
    removedAt: admin.firestore.FieldValue.serverTimestamp(),
    removedBy: removedBy || "dashboard",
  }, {merge: true});
}

/**
 * Drop a delete-tombstone so a previously removed default can be recreated.
 * @param {object} tenant Tenant.
 * @param {string} ruleId Rule id.
 * @return {Promise<void>}
 */
async function clearRemovedDefaultRule(tenant, ruleId) {
  await col(tenant, "quoteRulesRemoved").doc(String(ruleId)).delete();
}

/**
 * Creates missing DEFAULT_RULES docs (merge: false create-only).
 * Also force-syncs managed default fields (e.g. amazon_fc accessorials).
 * Skips ids tombstoned in quoteRulesRemoved.
 * @param {object} tenant Tenant.
 * @return {Promise<void>}
 */
async function ensureDefaultRulesPresent(tenant) {
  const ref = col(tenant, "quoteRules");
  const existing = await ref.get();
  const have = new Set(existing.docs.map((d) => d.id));
  const removed = await loadRemovedDefaultRuleIds(tenant);
  const missing = DEFAULT_RULES.filter((r) =>
    !have.has(r.id) && !removed.has(r.id));
  const batch = admin.firestore().batch();
  let writes = 0;
  for (const rule of missing) {
    const {id, ...rest} = rule;
    batch.set(ref.doc(id), {
      ...rest,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: "system-seed-missing",
    });
    writes++;
  }
  writes += queueManagedDefaultSync(batch, ref, existing);
  if (!writes) return;
  await batch.commit();
}

/**
 * Queue force-sync of managed DEFAULT_RULES fields onto existing docs.
 * @param {FirebaseFirestore.WriteBatch} batch Batch.
 * @param {FirebaseFirestore.CollectionReference} ref Rules collection.
 * @param {FirebaseFirestore.QuerySnapshot} existing Existing rules snap.
 * @return {number} Number of writes queued.
 */
function queueManagedDefaultSync(batch, ref, existing) {
  const byId = new Map(existing.docs.map((d) => [d.id, d]));
  let writes = 0;
  for (const rule of DEFAULT_RULES) {
    if (!MANAGED_DEFAULT_RULE_IDS.has(rule.id)) continue;
    const doc = byId.get(rule.id);
    if (!doc) continue;
    const data = doc.data() || {};
    const wantCodes = (rule.addAccessorials || []).map(String);
    const haveCodes = (data.addAccessorials || []).map(String);
    const codesSame = wantCodes.length === haveCodes.length &&
      wantCodes.every((c, i) => c === haveCodes[i]);
    const senderSync = isSenderCustomerRule(rule);
    const zipSync = isZipFillRule(rule);
    const wantMatch = JSON.stringify(rule.match || {});
    const haveMatch = JSON.stringify(data.match || {});
    const wantDims = JSON.stringify(rule.defaultDims || null);
    const haveDims = JSON.stringify(data.defaultDims || null);
    const wantZip = String(rule.fillZipCode || "");
    const haveZip = String(data.fillZipCode || "");
    const sameCore = codesSame &&
      data.name === rule.name &&
      data.notes === rule.notes;
    const sameSender = !senderSync || (
      data.customerName === rule.customerName &&
      !!data.protocolOnly === !!rule.protocolOnly &&
      data.ruleKind === rule.ruleKind &&
      data.identifyVia === rule.identifyVia &&
      wantMatch === haveMatch &&
      wantDims === haveDims
    );
    const sameZip = !zipSync || (
      data.ruleKind === rule.ruleKind &&
      data.applyTo === rule.applyTo &&
      wantMatch === haveMatch &&
      wantZip === haveZip
    );
    if (sameCore && sameSender && sameZip) continue;
    const patch = {
      addAccessorials: wantCodes,
      name: rule.name,
      notes: rule.notes || "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: "system-sync-managed-defaults",
    };
    if (senderSync) {
      patch.ruleKind = rule.ruleKind;
      patch.identifyVia = rule.identifyVia;
      patch.match = rule.match || {};
      patch.customerName = rule.customerName || "";
      patch.protocolOnly = !!rule.protocolOnly;
      if (rule.defaultDims) patch.defaultDims = rule.defaultDims;
    }
    if (zipSync) {
      patch.ruleKind = rule.ruleKind;
      patch.identifyVia = rule.identifyVia;
      patch.applyTo = rule.applyTo || DEFAULT_APPLY_TO;
      patch.match = rule.match || {};
      patch.fillZipCode = rule.fillZipCode || "";
    }
    batch.set(ref.doc(rule.id), patch, {merge: true});
    writes++;
  }
  return writes;
}

/**
 * @param {object} tenant Tenant.
 * @return {Promise<void>}
 */
async function seedDefaultRules(tenant) {
  const removed = await loadRemovedDefaultRuleIds(tenant);
  const batch = admin.firestore().batch();
  const ref = col(tenant, "quoteRules");
  let writes = 0;
  for (const rule of DEFAULT_RULES) {
    if (removed.has(rule.id)) continue;
    const {id, ...rest} = rule;
    batch.set(ref.doc(id), {
      ...rest,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: "system-seed",
    }, {merge: true});
    writes++;
  }
  if (!writes) return;
  await batch.commit();
}

/**
 * @param {string} haystack Text to search.
 * @param {Array<string>} needles Substrings (case insensitive).
 * @return {boolean}
 */
function containsAny(haystack, needles) {
  const h = String(haystack || "").toLowerCase();
  return (needles || []).some((n) => h.includes(String(n).toLowerCase()));
}

/**
 * Email-extracted siteType (not enrichment-only).
 * @param {object} lane Lane object.
 * @param {"dest"|"origin"} [side] Address side.
 * @return {string|null}
 */
function getEmailSiteType(lane, side = "dest") {
  const meta = side === "origin" ?
    lane.originEnrichmentMeta : lane.enrichmentMeta;
  if (meta) {
    return meta.emailSiteType || null;
  }
  const siteType = side === "origin" ? lane.originSiteType : lane.siteType;
  return siteType && siteType !== "other" ? siteType : null;
}

/**
 * Whether a flag was set from email extraction (not enrichment-only).
 * @param {object} lane Lane object.
 * @param {string} flag Flag key.
 * @param {"dest"|"origin"} [side] Address side.
 * @return {boolean}
 */
function flagFromEmail(lane, flag, side = "dest") {
  const resolved = side === "origin" && flag === "residentialDelivery" ?
    "residentialPickup" : flag;
  const flags = lane.flags || {};
  if (!flags[resolved] && !flags[flag]) return false;
  const meta = side === "origin" ?
    lane.originEnrichmentMeta : lane.enrichmentMeta;
  if (!meta) return true;
  if (resolved === "residentialPickup" || flag === "residentialDelivery") {
    if (side === "origin") {
      return !!meta.emailFlags && !!meta.emailFlags.residentialPickup;
    }
    return !!meta.emailFlags && !!meta.emailFlags.residentialDelivery;
  }
  return !!(meta.emailFlags && (meta.emailFlags[resolved] ||
    meta.emailFlags[flag]));
}

/**
 * @param {string} flag Flag key.
 * @return {boolean}
 */
function isSyntheticRequestFlag(flag) {
  return Object.prototype.hasOwnProperty.call(
      SYNTHETIC_REQUEST_FLAGS, String(flag || ""));
}

/**
 * True when a chat/UI request flag should fire for this lane.
 * @param {object} lane Lane.
 * @param {object} context Email / extract context.
 * @param {string} flag Flag key (e.g. insuranceRequested).
 * @return {boolean}
 */
function requestFlagMatches(lane, context, flag) {
  const key = String(flag || "");
  if (!key) return false;
  const flags = (lane && lane.flags) || {};
  if (flags[key]) return true;
  const def = SYNTHETIC_REQUEST_FLAGS[key];
  if (!def) return false;
  const codes = new Set();
  for (const c of (lane && lane.accessorials) || []) {
    codes.add(String(c || "").toUpperCase());
  }
  const requested = lane && lane.customerRequest &&
    Array.isArray(lane.customerRequest.requestedAccessorials) ?
    lane.customerRequest.requestedAccessorials : [];
  for (const c of requested) codes.add(String(c || "").toUpperCase());
  const ctxReq = context && context.customerRequest &&
    Array.isArray(context.customerRequest.requestedAccessorials) ?
    context.customerRequest.requestedAccessorials : [];
  for (const c of ctxReq) codes.add(String(c || "").toUpperCase());
  if ((def.codes || []).some((c) => codes.has(String(c).toUpperCase()))) {
    return true;
  }
  if (!def.textRe) return false;
  const text = [
    lane && lane.specialInstructions,
    context && context.specialInstructionsGlobal,
    context && context.emailBody,
    context && context.subject,
    context && context.body,
  ].filter(Boolean).join(" ");
  return def.textRe.test(text);
}

/**
 * Flag match for rule.match.flags (residential + synthetic request flags).
 * @param {object} lane Lane.
 * @param {object} context Context.
 * @param {string} flag Flag key.
 * @param {"dest"|"origin"} [side] Side.
 * @return {boolean}
 */
function laneFlagMatches(lane, context, flag, side = "dest") {
  if (isSyntheticRequestFlag(flag)) {
    return requestFlagMatches(lane, context, flag);
  }
  return flagFromEmail(lane, flag, side);
}

/**
 * Text-only rule match (email-extracted fields).
 * @param {object} lane Lane with consignee, flags, specialInstructions.
 * @param {object} context Global context (specialInstructionsGlobal).
 * @param {object} rule Rule document.
 * @param {"dest"|"origin"} [side] Address side.
 * @return {string|null} Match dimension or null.
 */
function ruleMatchViaText(lane, context, rule, side = "dest") {
  const match = rule.match || {};
  const topFromNames = [].concat((rule && rule.fromNames) || []);
  const hasMatchKeys = Object.keys(match).length > 0 || topFromNames.length > 0;
  if (!hasMatchKeys) return null;
  if (!senderConstraintsMatch(rule, context)) return null;

  const party = side === "origin" ?
    (lane.shipper || {}) : (lane.consignee || {});
  const name = party.name || "";
  const addr = [
    party.address1, party.address2, party.city, party.state, party.zipCode,
  ].join(" ");
  const city = String(party.city || "").trim();
  const state = String(party.state || "").trim().toUpperCase();
  const instr = [
    lane.specialInstructions,
    context.specialInstructionsGlobal,
  ].join(" ");

  const nameNeedles = side === "origin" ?
    [].concat(match.shipperNameContains || [])
        .concat(match.nameContains || []) :
    [].concat(match.consigneeNameContains || [])
        .concat(match.nameContains || []);
  // Also allow cross-side name needles the chat historically wrote.
  if (side === "origin" && match.consigneeNameContains) {
    nameNeedles.push(...match.consigneeNameContains);
  }
  if (nameNeedles.length && containsAny(name, nameNeedles)) {
    return side === "origin" ? "shipperName" : "consigneeName";
  }

  const addrNeedles = side === "origin" ?
    [].concat(match.shipperAddressContains || [])
        .concat(match.addressContains || [])
        .concat(match.consigneeAddressContains || []) :
    [].concat(match.consigneeAddressContains || [])
        .concat(match.addressContains || []);
  if (addrNeedles.length && containsAny(addr, addrNeedles)) {
    return side === "origin" ? "shipperAddress" : "consigneeAddress";
  }

  const cityNeedles = side === "origin" ?
    [].concat(match.shipperCityContains || [])
        .concat(match.cityContains || []) :
    [].concat(match.consigneeCityContains || [])
        .concat(match.cityContains || []);
  if (cityNeedles.length &&
      (containsAny(city, cityNeedles) || containsAny(name, cityNeedles))) {
    const wantStateForCity = String(
        (side === "origin" ?
          (match.shipperState || match.state) :
          (match.consigneeState || match.state)) || "")
        .trim()
        .toUpperCase();
    if (wantStateForCity && state && wantStateForCity !== state) {
      // City needle hit but state filter failed.
    } else {
      return side === "origin" ? "shipperCity" : "consigneeCity";
    }
  }

  const wantState = String(
      (side === "origin" ?
        (match.shipperState || match.state) :
        (match.consigneeState || match.state)) || "")
      .trim()
      .toUpperCase();
  if (wantState && state && wantState === state &&
      !cityNeedles.length && !nameNeedles.length && !addrNeedles.length &&
      !match.siteType && !match.flags && !match.instructionsContains &&
      !match.referenceContains && !matchHasSenderIdentityKeys(match) &&
      !topFromNames.length) {
    return side === "origin" ? "shipperState" : "consigneeState";
  }

  if (match.instructionsContains &&
    containsAny(instr, match.instructionsContains)) {
    const declineText = [
      instr,
      context.emailBody,
      context.subject,
      context.body,
      context.specialInstructionsGlobal,
    ].filter(Boolean).join(" ");
    const declined = new Set(
        declinedAcc.detectDeclinedAccessorials(declineText).codes);
    const extra = Array.isArray(context.customerDeclinedAccessorials) ?
      context.customerDeclinedAccessorials : [];
    for (const c of extra) declined.add(String(c || "").toUpperCase());
    const adds = (rule.addAccessorials || [])
        .map((c) => String(c || "").toUpperCase())
        .filter(Boolean);
    const allDeclined = adds.length > 0 &&
      adds.every((c) => declined.has(c));
    if (!allDeclined) {
      return "instructions";
    }
  }
  if (match.referenceContains) {
    const refs = (lane.referenceNumbers || []).join(" ");
    if (containsAny(refs, match.referenceContains)) return "reference";
  }
  if (match.flags && Array.isArray(match.flags)) {
    if (match.flags.some((f) => laneFlagMatches(lane, context, f, side))) {
      return "flags";
    }
  }
  if (match.siteType && getEmailSiteType(lane, side) === match.siteType) {
    // chain_store / amazon APD must not win over "no appointment" / FCFS.
    if (addsOnlyDeclinedAccessorials(lane, context, rule)) return null;
    return "siteType";
  }

  // Sender-only accessorial rules (fromEmails + add/remove codes).
  if (hasLaneAccessorialActions(rule) &&
      (matchHasSenderIdentityKeys(match) || topFromNames.length) &&
      senderConstraintsMatch(rule, context)) {
    const otherKeys = Object.keys(match).filter((k) => {
      if ([
        "fromEmails", "senderEmails", "senderDomains",
        "ccEmails", "toEmails", "fromNames", "carrierNameContains",
      ].includes(k)) {
        return false;
      }
      const v = match[k];
      if (v == null || v === "") return false;
      if (Array.isArray(v) && !v.length) return false;
      return true;
    });
    if (!otherKeys.length) return "sender";
  }
  return null;
}

/**
 * True when every code the rule would add is customer-declined.
 * @param {object} lane Lane.
 * @param {object} context Global context.
 * @param {object} rule Rule document.
 * @return {boolean}
 */
function addsOnlyDeclinedAccessorials(lane, context, rule) {
  const adds = (rule.addAccessorials || [])
      .map((c) => String(c || "").toUpperCase())
      .filter(Boolean);
  if (!adds.length) return false;
  const declineText = [
    lane && lane.specialInstructions,
    context.specialInstructionsGlobal,
    context.emailBody,
    context.subject,
    context.body,
  ].filter(Boolean).join(" ");
  const declined = new Set(
      declinedAcc.detectDeclinedAccessorials(declineText).codes);
  const extra = Array.isArray(context.customerDeclinedAccessorials) ?
    context.customerDeclinedAccessorials : [];
  for (const c of extra) declined.add(String(c || "").toUpperCase());
  return adds.every((c) => declined.has(c));
}

/**
 * AI-only rule match (address classification / enrichment).
 * Synthetic request flags (insuranceRequested) do not need enrichment —
 * they are derived from lane accessorials / email text.
 * @param {object} lane Lane with enrichmentMeta.
 * @param {object} context Global context (unused).
 * @param {object} rule Rule document.
 * @param {"dest"|"origin"} [side] Address side.
 * @return {string|null} Match dimension or null.
 */
function ruleMatchViaAi(lane, context, rule, side = "dest") {
  const match = rule.match || {};
  if (!Object.keys(match).length) return null;

  // Request flags invented by chat/UI (never written by enrichment).
  if (match.flags && Array.isArray(match.flags) && match.flags.length) {
    const onlySynthetic = match.flags.every((f) => isSyntheticRequestFlag(f));
    if (onlySynthetic &&
        match.flags.some((f) => requestFlagMatches(lane, context, f))) {
      return "flags";
    }
  }

  const meta = side === "origin" ?
    lane.originEnrichmentMeta : lane.enrichmentMeta;
  if (!meta) return null;

  if (match.siteType && meta.classifiedAs === match.siteType) {
    if (addsOnlyDeclinedAccessorials(lane, context, rule)) return null;
    return "siteType";
  }
  if (match.flags && Array.isArray(match.flags)) {
    const flags = lane.flags || {};
    const wantsResidential = match.flags.includes("residentialDelivery") ||
      match.flags.includes("residentialPickup");
    const hasResidential = side === "origin" ?
      !!flags.residentialPickup : !!flags.residentialDelivery;
    if (wantsResidential && hasResidential &&
      meta.classifiedAs === "residential") {
      return "flags";
    }
  }
  return null;
}

/**
 * True when email siteType disagrees with enrichment classification.
 * Used to avoid false chain_store (etc.) matches from email when Google /
 * heuristics classified the address as a different specific type
 * (e.g. NEX DC mislabeled chain_store → aafes_military).
 * @param {object} lane Lane.
 * @param {"dest"|"origin"} [side] Address side.
 * @return {boolean}
 */
function enrichmentConflictsEmailSiteType(lane, side = "dest") {
  const meta = side === "origin" ?
    lane.originEnrichmentMeta : lane.enrichmentMeta;
  if (!meta) return false;
  const emailType = meta.emailSiteType || null;
  const classified = meta.classifiedAs || null;
  if (!emailType || emailType === "other") return false;
  if (!classified || classified === "other") return false;
  return emailType !== classified;
}

/**
 * Rules that permanently suppress Insurance (INS) on quotes.
 * Match even when identifyVia/flags wiring is incomplete so Active
 * "never add insurance" rules always strip INS before Primus.
 * @param {object} rule Rule document.
 * @return {boolean}
 */
function isNeverAddInsuranceRule(rule) {
  if (!rule || rule.active === false) return false;
  const removes = (rule.removeAccessorials || [])
      .map((c) => String(c || "").toUpperCase());
  if (!removes.includes("INS")) return false;
  const flags = ((rule.match && rule.match.flags) || []).map(String);
  if (flags.includes("insuranceRequested")) return true;
  const blob = `${rule.name || ""} ${rule.notes || ""}`.toLowerCase();
  return /never\s+add\s+insurance|do\s+not\s+(?:add\s+)?insurance|no\s+insurance|strip\s+insurance|omit\s+insurance|without\s+insurance/i
      .test(blob);
}

/**
 * @param {object} lane Lane with consignee, flags, specialInstructions.
 * @param {object} context Global context (specialInstructionsGlobal).
 * @param {object} rule Rule document.
 * @param {"dest"|"origin"} [side] Address side.
 * @return {string|null} Match dimension or null.
 */
function ruleMatchVia(lane, context, rule, side = "dest") {
  if (isNeverAddInsuranceRule(rule)) return "never_insurance";
  // Sender identity filters apply to both text and AI paths.
  if (!senderConstraintsMatch(rule, context)) return null;
  const identifyVia = normalizeIdentifyVia(rule);
  let textVia = ruleMatchViaText(lane, context, rule, side);
  const aiVia = ruleMatchViaAi(lane, context, rule, side);

  // Prefer enrichment site identity over a conflicting email siteType
  // for text matches (keeps identifyVia "both" from applying the wrong
  // chain/Amazon rule when enrichment already reclassified the site).
  if (textVia === "siteType" &&
    enrichmentConflictsEmailSiteType(lane, side)) {
    textVia = null;
  }

  if (identifyVia === "address_text") return textVia;
  if (identifyVia === "ai") return aiVia;
  return textVia || aiVia;
}

/**
 * @param {object} lane Lane with consignee, flags, specialInstructions.
 * @param {object} context Global context (specialInstructionsGlobal).
 * @param {object} rule Rule document.
 * @return {boolean}
 */
function ruleMatches(lane, context, rule) {
  return ruleSides(rule).some((side) =>
    !!ruleMatchVia(lane, context, rule, side));
}

/**
 * @param {object} lane Lane.
 * @param {string} via Match dimension from ruleMatchVia.
 * @param {object} rule Rule document.
 * @param {"dest"|"origin"} [side] Address side.
 * @return {boolean}
 */
function matchViaEnrichment(lane, via, rule, side = "dest") {
  const meta = side === "origin" ?
    lane.originEnrichmentMeta : lane.enrichmentMeta;
  if (!meta) return false;
  const match = rule.match || {};
  if (via === "siteType") {
    return meta.classifiedAs === match.siteType;
  }
  if (via === "flags") {
    const wantsResidential = !!(match.flags &&
      (match.flags.includes("residentialDelivery") ||
        match.flags.includes("residentialPickup")));
    return wantsResidential && meta.classifiedAs === "residential";
  }
  return false;
}

/** Human-readable labels for Primus accessorial codes. */
const ACCESSORIAL_LABELS = {
  LFO: "Liftgate pickup",
  LFD: "Liftgate delivery",
  APO: "Appointment pickup",
  APD: "Appointment delivery",
  LAO: "Limited access pickup",
  LAD: "Limited access",
  RSO: "Residential pickup",
  RSD: "Residential delivery",
  INO: "Inside pickup",
  IND: "Inside delivery",
  NUD: "Nursing home delivery",
  HOD: "Hotel delivery",
  SCD: "School delivery",
  INS: "Insurance",
  HAZ: "Hazardous material",
  PFF: "Protect from freezing",
  NTD: "Notification delivery",
};

/**
 * @param {Array<string>} codes Primus accessorial codes.
 * @return {string} Comma-separated labels.
 */
function formatAccessorialLabels(codes) {
  const uniq = [...new Set((codes || []).map(String))];
  return uniq.map((c) => ACCESSORIAL_LABELS[c] || c).join(", ");
}

/**
 * Carrier-name needles for customer-email advisory notes.
 * @param {object} rule Rule document.
 * @return {Array<string>}
 */
function carrierNameContainsNeedles(rule) {
  const match = (rule && rule.match) || {};
  const needles = match.carrierNameContains;
  if (!Array.isArray(needles)) return [];
  return needles.map((n) => String(n || "").trim()).filter(Boolean);
}

/**
 * True when rule.match is only carrierNameContains (no address/site keys).
 * @param {object} rule Rule document.
 * @return {boolean}
 */
function isCarrierNameOnlyMatch(rule) {
  const needles = carrierNameContainsNeedles(rule);
  if (!needles.length) return false;
  const match = rule.match || {};
  const otherKeys = Object.keys(match).filter((k) => {
    if (k === "carrierNameContains") return false;
    const v = match[k];
    if (v == null || v === "") return false;
    if (Array.isArray(v) && !v.length) return false;
    return true;
  });
  return otherKeys.length === 0;
}

/**
 * Carrier display rename for customer email / rate UI (strip broker
 * suffixes like "J&I" / "J&I Distributors") — not a Notes: advisory.
 * @param {object} rule Rule document.
 * @return {boolean}
 */
function isCarrierDisplayCleanRule(rule) {
  if (!rule || rule.active === false) return false;
  if (rule.ruleKind === RULE_KIND_CARRIER_DISPLAY_CLEAN) return true;
  if (!isCarrierNameOnlyMatch(rule)) return false;
  const hasAcc = (rule.addAccessorials || []).length > 0 ||
    (rule.removeAccessorials || []).length > 0 ||
    (rule.filterCarrierWarnings || []).length > 0 ||
    !!rule.customerName ||
    !!rule.fillZipCode;
  if (hasAcc) return false;
  const blob = `${rule.name || ""} ${rule.notes || ""}`.toLowerCase();
  if (/clean\s+carrier|omit\s+the|remove\s+.+\s+wording|only\s+the\s+actual\s+carrier|provide\s+only\s+the\s+actual|omit\s+the\s+added|strip\s+.+\s+from\s+carrier|j\s*[&\-–—]\s*i|j\s*&\s*i/i
      .test(blob)) {
    return true;
  }
  // carrierNameContains-only with J&I-like needles and no notes body that
  // looks like an advisory sentence → treat as display clean.
  const needles = carrierNameContainsNeedles(rule).map((n) =>
    String(n || "").toLowerCase());
  const jiNeedle = needles.some((n) =>
    /j\s*[&and\-–—]*\s*i|ji\s*distribut/.test(n.replace(/\s+/g, " ")));
  if (jiNeedle && !String(rule.notes || "").trim()) return true;
  return jiNeedle &&
    !/\bhas\s+|delays|do\s+not\s+use|avoid|prefer\b/i.test(blob);
}

/**
 * Rules that only match selected rate carrier names (not lane addresses).
 * These never fire in applyRulesToLane — they attach Notes: lines when a
 * matching carrier is selected into the customer email draft.
 * @param {object} rule Rule document.
 * @return {boolean}
 */
function isCarrierNoteRule(rule) {
  if (isCarrierDisplayCleanRule(rule)) return false;
  if (!isCarrierNameOnlyMatch(rule)) return false;
  const hasAcc = (rule.addAccessorials || []).length > 0 ||
    (rule.removeAccessorials || []).length > 0 ||
    (rule.filterCarrierWarnings || []).length > 0 ||
    !!rule.customerName ||
    !!rule.fillZipCode;
  return !hasAcc;
}

/**
 * Normalize broker-tag tokens so J&I / J-I / J – I / J and I match.
 * @param {string} value Raw text.
 * @return {string}
 */
function normalizeCarrierNameMatchText(value) {
  return String(value || "").toLowerCase()
      .replace(/&/g, " and ")
      // Single-letter broker tags: "j – i", "j-i", "j and i" → "j i"
      .replace(/\bj\s*(?:and|[-–—/])\s*i\b/g, "j i")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
}

/**
 * Flexible carrier-name haystack match for clean / note needles.
 * Treats &, "and", and hyphen / en-dash variants between tokens as
 * equivalent (J&I ↔ J-I ↔ J – I ↔ J and I).
 * @param {string} hay Carrier name.
 * @param {string} needle Match phrase.
 * @return {boolean}
 */
function carrierNameMatchesNeedle(hay, needle) {
  const h = String(hay || "").toLowerCase();
  const n = String(needle || "").toLowerCase().trim();
  if (!h || !n) return false;
  if (h.includes(n)) return true;
  const hn = normalizeCarrierNameMatchText(h);
  const nn = normalizeCarrierNameMatchText(n);
  if (hn && nn && hn.includes(nn)) return true;
  // Compact form: "ji" / "jidistributors" vs spaced "j i".
  const hc = hn.replace(/\s+/g, "");
  const nc = nn.replace(/\s+/g, "");
  return !!(hc && nc && hc.includes(nc));
}

/**
 * Strip common Primus J&I / J-I DISTRIBUTORS broker suffixes.
 * @param {string} name Carrier display name.
 * @return {string}
 */
function stripJiBrokerSuffix(name) {
  return String(name || "")
      .replace(
          /\s*[-–—/%]*\s*j\s*(?:&|and|[-–—/])\s*i(?:\s*distribut[eo]rs?)?\b/ig,
          "")
      .replace(/\s*[-–—/%]*\s*ji\s*distribut[eo]rs?\b/ig, "")
      .replace(/\s+/g, " ")
      .replace(/\s*[-–—/,]+$/g, "")
      .trim();
}

/**
 * Strip matched broker / distributor wording from a carrier display name.
 * Always strips common J&I / J-I variants even when no Firestore rule matched.
 * @param {string} rawName Primus / rate carrier name.
 * @param {Array<{id: string, test: Function, needles: Array<string>}>} [rules]
 * @return {string}
 */
function cleanCustomerEmailCarrierName(rawName, rules) {
  let name = String(rawName || "").trim();
  if (!name) return name;
  let matched = false;
  if (Array.isArray(rules) && rules.length) {
    for (const rule of rules) {
      if (!rule || typeof rule.test !== "function") continue;
      if (!rule.test(name)) continue;
      matched = true;
      for (const needle of rule.needles || []) {
        const n = String(needle || "").trim();
        if (!n) continue;
        const flex = n
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\\?\s+/g, "[\\s\\-–—/]*")
            .replace(/\\?&/g, "(?:&|and|\\-)");
        name = name.replace(
            new RegExp(`[\\s\\-–—/]*${flex}`, "ig"), " ");
      }
    }
  }
  // Always strip common J&I / J-I DISTRIBUTORS tags — Primus appends these
  // even when the Active clean rule needles miss a dash/en-dash variant.
  if (matched || /\bj\s*(?:&|and|[-–—/])\s*i\b|\bji\s*distribut/i.test(name)) {
    name = stripJiBrokerSuffix(name);
  }
  return name
      .replace(/\s+/g, " ")
      .replace(/\s*[-–—/,]+$/g, "")
      .trim() || String(rawName || "").trim();
}

/**
 * Builds carrier display-name cleaners from quoteRules.
 * @param {Array<object>} rules Active quote rules.
 * @return {Array<{id: string, test: Function, needles: Array<string>}>}
 */
function toCustomerEmailCarrierCleanRules(rules) {
  const out = [];
  for (const rule of rules || []) {
    if (!isCarrierDisplayCleanRule(rule)) continue;
    const needles = carrierNameContainsNeedles(rule);
    if (!needles.length) continue;
    out.push({
      id: String(rule.id || `carrier_clean_${out.length}`),
      needles,
      test: (name) => needles.some(
          (n) => carrierNameMatchesNeedle(name, n)),
    });
  }
  return out;
}

/**
 * Plain customer-email note body from a rule.notes field.
 * Strips "Add note:" prefixes and a leading carrier name so the email
 * line reads like hardcoded advisories ("has lots of delays…").
 * @param {string} raw Notes field.
 * @param {Array<string>} [carrierNeedles] match.carrierNameContains.
 * @return {string}
 */
function customerEmailNoteText(raw, carrierNeedles) {
  let note = String(raw || "").trim();
  note = note.replace(/^add\s+notes?:\s*/i, "").trim();
  note = note.replace(/^["']|["']$/g, "").trim();
  for (const needle of carrierNeedles || []) {
    const n = String(needle || "").trim();
    if (!n) continue;
    const re = new RegExp(
        `^${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[:\\s-]*`,
        "i");
    note = note.replace(re, "").trim();
  }
  return note;
}

/**
 * Builds email advisory rules from quoteRules with carrierNameContains.
 * @param {Array<object>} rules Active quote rules.
 * @return {Array<{id: string, test: Function, note: string}>}
 */
function toCustomerEmailCarrierNoteRules(rules) {
  const out = [];
  for (const rule of rules || []) {
    if (!rule || rule.active === false) continue;
    // Display-name cleaners are not customer-facing Notes: lines.
    if (isCarrierDisplayCleanRule(rule)) continue;
    const needles = carrierNameContainsNeedles(rule);
    if (!needles.length) continue;
    const note = customerEmailNoteText(rule.notes, needles);
    if (!note) continue;
    out.push({
      id: String(rule.id || `carrier_note_${out.length}`),
      test: (name) => needles.some(
          (n) => carrierNameMatchesNeedle(name, n)),
      note,
    });
  }
  return out;
}

/**
 * Applies rules to a lane; returns accessorial codes and filter hints.
 *
 * Order (all matching accessorial rules, in priority order):
 * 1) Apply every matching rule's addAccessorials / addAccessorialsWithData /
 *    filterCarrierWarnings.
 * 2) Then apply every matching rule's removeAccessorials (suppress). Removes
 *    win over adds from any rule, including earlier ones — so a rule that
 *    only removes NTD when appointment context matches will strip NTD even
 *    if another rule (or the lane) added it.
 * removeAccessorials codes are side-mapped via accessorialsForSide (same as
 * adds). Matching accessorialsWithData rows are dropped when their code is
 * removed.
 *
 * @param {object} lane Lane object.
 * @param {Array<object>} rules Active rules.
 * @param {object} [context] Global email context.
 * @return {object} accessorials, filter hints, appliedRules
 */
function applyRulesToLane(lane, rules, context = {}) {
  const codes = new Set(Array.isArray(lane.accessorials) ?
    lane.accessorials.map(String) : []);
  let withData = Array.isArray(lane.accessorialsWithData) ?
    [...lane.accessorialsWithData] : [];
  const filterWarnings = [];
  const applied = [];
  const removeCodes = new Set();
  let requiresConfirm = false;

  for (const rule of rules) {
    if (!rule.active) continue;
    // Pure sender→customer rules attach Primus customer / dims at intake —
    // they must not invent site accessorials here. Rules that ALSO
    // add/remove accessorials still run (sender filters in ruleMatchVia).
    if (isPureSenderCustomerRule(rule)) continue;
    if (isZipFillRule(rule)) continue;
    // Carrier-name notes / display cleaners attach at email / UI time.
    if (isCarrierNoteRule(rule)) continue;
    if (isCarrierDisplayCleanRule(rule)) continue;
    for (const side of ruleSides(rule)) {
      const via = ruleMatchVia(lane, context, rule, side);
      if (!via) continue;
      applied.push({
        ruleId: rule.id,
        name: rule.name,
        notes: rule.notes || null,
        matchVia: via,
        identifyVia: normalizeIdentifyVia(rule),
        applyTo: side,
        fromEnrichment: matchViaEnrichment(lane, via, rule, side),
      });
      if (rule.requiresConfirm) requiresConfirm = true;
      accessorialsForSide(rule.addAccessorials || [], side)
          .forEach((c) => codes.add(String(c)));
      (rule.filterCarrierWarnings || []).forEach((w) =>
        filterWarnings.push(String(w)));
      if (Array.isArray(rule.addAccessorialsWithData)) {
        withData.push(...rule.addAccessorialsWithData);
      }
      accessorialsForSide(rule.removeAccessorials || [], side)
          .forEach((c) => removeCodes.add(String(c)));
    }
  }

  if (removeCodes.size) {
    for (const c of removeCodes) codes.delete(c);
    withData = withData.filter((row) => {
      const c = String(row && row.code || "");
      return c && !removeCodes.has(c);
    });
  }

  const declineText = [
    lane.specialInstructions,
    context.specialInstructionsGlobal,
    context.emailBody,
    context.subject,
    context.body,
  ].filter(Boolean).join(" ");
  const stripped = declinedAcc.applyDeclinedAccessorials({
    accessorials: [...codes],
    accessorialsWithData: withData,
    appliedRules: applied,
  }, declineText, context.customerDeclinedAccessorials);

  // Delivery-only / pickup-only liftgate phrasing wins over a stale
  // liftgate_no_dock that still seeds both LFO and LFD.
  // Lazy require: quote-email-accessorials ↔ catalog ↔ rate-shop ↔
  // quote-output ↔ this module forms a cycle; top-level require can
  // leave refineLiftgateSides undefined on the partial exports object.
  const emailAccLazy = require("./quote-email-accessorials");
  const refined = emailAccLazy.refineLiftgateSides(
      stripped.accessorials, declineText);

  return {
    accessorials: emailAccLazy.normalizeHotelCasinoAccessorials(refined),
    accessorialsWithData: stripped.accessorialsWithData,
    filterCarrierWarnings: filterWarnings,
    appliedRules: stripped.appliedRules,
    requiresConfirm,
    customerDeclinedAccessorials: stripped.customerDeclinedAccessorials ||
      [],
  };
}

/**
 * Re-evaluate matching removeAccessorials after email-requested codes are
 * merged. Email merge runs after applyRulesToLane and would otherwise
 * re-add suppressed codes (e.g. INS) that a remove rule already stripped.
 *
 * @param {object} lane Lane (pre-merge freight / parties).
 * @param {object} rulesOut Current accessorials result.
 * @param {Array<object>} rules Active quote rules.
 * @param {object} [context] Email / extract context.
 * @return {object} rulesOut with suppressed codes removed.
 */
function applyRemoveAccessorialRules(lane, rulesOut, rules, context = {}) {
  const out = rulesOut && typeof rulesOut === "object" ? {...rulesOut} : {
    accessorials: [],
    accessorialsWithData: [],
    appliedRules: [],
    filterCarrierWarnings: [],
    requiresConfirm: false,
  };
  const laneView = {
    ...(lane && typeof lane === "object" ? lane : {}),
    accessorials: out.accessorials || [],
    accessorialsWithData: out.accessorialsWithData || [],
  };
  const removeCodes = new Set();
  const applied = Array.isArray(out.appliedRules) ? [...out.appliedRules] : [];
  const already = new Set(applied.map((r) => String(r && r.ruleId || "")));

  for (const rule of rules || []) {
    if (!rule || rule.active === false) continue;
    if (isPureSenderCustomerRule(rule)) continue;
    if (isZipFillRule(rule)) continue;
    if (isCarrierNoteRule(rule)) continue;
    if (isCarrierDisplayCleanRule(rule)) continue;
    const removes = rule.removeAccessorials || [];
    if (!removes.length) continue;
    for (const side of ruleSides(rule)) {
      const via = ruleMatchVia(laneView, context, rule, side);
      if (!via) continue;
      accessorialsForSide(removes, side)
          .forEach((c) => removeCodes.add(String(c)));
      const rid = String(rule.id || "");
      if (rid && !already.has(rid)) {
        already.add(rid);
        applied.push({
          ruleId: rid,
          name: rule.name,
          notes: rule.notes || null,
          matchVia: via,
          identifyVia: normalizeIdentifyVia(rule),
          applyTo: side,
          fromEnrichment: false,
        });
      }
    }
  }

  if (!removeCodes.size) {
    out.appliedRules = applied;
    return out;
  }
  out.accessorials = (out.accessorials || [])
      .map(String)
      .filter((c) => !removeCodes.has(c));
  out.accessorialsWithData = (out.accessorialsWithData || []).filter((row) => {
    const c = String(row && row.code || "");
    return c && !removeCodes.has(c);
  });
  out.appliedRules = applied;
  return out;
}

/**
 * @param {object} tenant Tenant.
 * @return {Promise<Array<object>>}
 */
async function listAllRules(tenant) {
  await ensureDefaultRulesPresent(tenant);
  let snap = await col(tenant, "quoteRules").orderBy("priority").get();
  if (snap.empty) {
    await seedDefaultRules(tenant);
    snap = await col(tenant, "quoteRules").orderBy("priority").get();
  }
  return annotateRulesWiring(
      snap.docs.map((d) => ({id: d.id, ...d.data()})));
}

/**
 * @param {object} tenant Tenant.
 * @param {string} ruleId Rule doc id.
 * @param {object} patch Fields to merge.
 * @param {string} updatedBy User email or id.
 * @return {Promise<object>}
 */
async function upsertRule(tenant, ruleId, patch, updatedBy) {
  const id = String(ruleId);
  await clearRemovedDefaultRule(tenant, id);
  const ref = col(tenant, "quoteRules").doc(id);
  const before = await ref.get();
  const data = {
    ...patch,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: updatedBy || "dashboard",
  };
  await ref.set(data, {merge: true});
  await col(tenant, "quoteRulesHistory").add({
    ruleId: String(ruleId),
    before: before.exists ? before.data() : null,
    after: {...(before.exists ? before.data() : {}), ...patch},
    updatedBy: updatedBy || "dashboard",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const after = await ref.get();
  return {id: after.id, ...after.data()};
}

/**
 * Permanently remove a rule. Tombstones DEFAULT_RULES ids so getQuoteRules
 * / loadActiveRules do not recreate them on the next ensureDefaultRulesPresent.
 * @param {object} tenant Tenant.
 * @param {string} ruleId Rule id.
 * @param {string} [removedBy] Actor.
 * @return {Promise<void>}
 */
async function deleteRule(tenant, ruleId, removedBy) {
  const id = String(ruleId);
  const isDefault = DEFAULT_RULES.some((r) => r.id === id);
  await col(tenant, "quoteRules").doc(id).delete();
  // Tombstone current defaults and retired product defaults so reseeds
  // cannot resurrect intentional deletes.
  if (isDefault || RETIRED_DEFAULT_RULE_IDS.has(id)) {
    await markDefaultRuleRemoved(tenant, id, removedBy);
  }
}

/**
 * Test which rules match a sample shipper / consignee.
 * @param {object} tenant Tenant.
 * @param {object} sample {consignee, shipper, specialInstructions, flags}.
 * @return {Promise<object>}
 */
async function testAddress(tenant, sample) {
  const rules = await loadActiveRules(tenant);
  const lane = {
    consignee: sample.consignee || {},
    shipper: sample.shipper || {},
    specialInstructions: sample.specialInstructions || "",
    flags: sample.flags || {},
    siteType: sample.siteType || null,
    originSiteType: sample.originSiteType || null,
    enrichmentMeta: sample.enrichmentMeta || null,
    originEnrichmentMeta: sample.originEnrichmentMeta || null,
    referenceNumbers: sample.referenceNumbers || [],
  };
  return applyRulesToLane(lane, rules, {
    specialInstructionsGlobal: sample.specialInstructions || "",
  });
}

module.exports = {
  init,
  DEFAULT_RULES,
  IDENTIFY_VIA_VALUES,
  DEFAULT_IDENTIFY_VIA,
  APPLY_TO_VALUES,
  DEFAULT_APPLY_TO,
  DEST_TO_ORIGIN_ACCESSORIAL,
  RULE_KIND_SENDER_CUSTOMER,
  RULE_KIND_ZIP_FILL,
  RULE_KIND_CARRIER_DISPLAY_CLEAN,
  WIRED_MATCH_KEYS,
  WIRED_ACTION_FIELDS,
  SYNTHETIC_REQUEST_FLAGS,
  MANAGED_DEFAULT_RULE_IDS,
  RETIRED_DEFAULT_RULE_IDS,
  loadActiveRules,
  seedDefaultRules,
  ensureDefaultRulesPresent,
  applyRulesToLane,
  applyRemoveAccessorialRules,
  listAllRules,
  upsertRule,
  deleteRule,
  markDefaultRuleRemoved,
  clearRemovedDefaultRule,
  loadRemovedDefaultRuleIds,
  testAddress,
  ruleMatches,
  ruleMatchVia,
  ruleMatchViaText,
  ruleMatchViaAi,
  normalizeIdentifyVia,
  normalizeApplyTo,
  accessorialsForSide,
  formatAccessorialLabels,
  ACCESSORIAL_LABELS,
  isSenderCustomerRule,
  isPureSenderCustomerRule,
  hasLaneAccessorialActions,
  senderConstraintsMatch,
  isZipFillRule,
  isCarrierNoteRule,
  isCarrierDisplayCleanRule,
  isNeverAddInsuranceRule,
  isCarrierNameOnlyMatch,
  carrierNameContainsNeedles,
  carrierNameMatchesNeedle,
  customerEmailNoteText,
  cleanCustomerEmailCarrierName,
  stripJiBrokerSuffix,
  toCustomerEmailCarrierNoteRules,
  toCustomerEmailCarrierCleanRules,
  applyZipFillRules,
  zipFillRuleMatchesParty,
  zipFillRuleMatchesContext,
  analyzeRuleWiring,
  annotateRulesWiring,
  collectUnwiredActiveWarnings,
};
