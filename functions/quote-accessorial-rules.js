/**
 * Quote accessorial rules — Firestore-backed, applied before rate shop.
 *
 * Pallet trailer capacity (combine same-OD / split oversize) is a separate
 * always-on built-in in quote-freight-rules.js (MAX 26 PLT/trailer), applied
 * after extractQuoteRequest and before accessorial rules / rateLane.
 */

"use strict";

const admin = require("firebase-admin");

const IDENTIFY_VIA_VALUES = ["address_text", "ai", "both"];
const DEFAULT_IDENTIFY_VIA = "both";
const APPLY_TO_VALUES = ["dest", "origin", "both"];
const DEFAULT_APPLY_TO = "dest";

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
 * Default rule ids whose addAccessorials / name / notes are force-synced
 * from DEFAULT_RULES on load (overrides stale Firestore seed values).
 */
const MANAGED_DEFAULT_RULE_IDS = new Set(["amazon_fc"]);

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
    addAccessorials: ["LFO", "LFD"],
    applyTo: "dest",
    notes: "Special instructions mention liftgate or no dock.",
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
  // nursing_home, hotel
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
 * @return {"address_text"|"ai"|"both"}
 */
function normalizeIdentifyVia(rule) {
  const v = rule && rule.identifyVia;
  return IDENTIFY_VIA_VALUES.includes(v) ? v : DEFAULT_IDENTIFY_VIA;
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
      return again.docs.map((d) => ({id: d.id, ...d.data()})).sort((a, b) =>
        (Number(a.priority) || 999) - (Number(b.priority) || 999));
    }
  }
  const rules = snap.docs.map((d) => ({id: d.id, ...d.data()}));
  return rules.sort((a, b) =>
    (Number(a.priority) || 999) - (Number(b.priority) || 999));
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
    if (codesSame &&
        data.name === rule.name &&
        data.notes === rule.notes) {
      continue;
    }
    batch.set(ref.doc(rule.id), {
      addAccessorials: wantCodes,
      name: rule.name,
      notes: rule.notes || "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: "system-sync-managed-defaults",
    }, {merge: true});
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
 * Text-only rule match (email-extracted fields).
 * @param {object} lane Lane with consignee, flags, specialInstructions.
 * @param {object} context Global context (specialInstructionsGlobal).
 * @param {object} rule Rule document.
 * @param {"dest"|"origin"} [side] Address side.
 * @return {string|null} Match dimension or null.
 */
function ruleMatchViaText(lane, context, rule, side = "dest") {
  const match = rule.match || {};
  if (!Object.keys(match).length) return null;
  const party = side === "origin" ?
    (lane.shipper || {}) : (lane.consignee || {});
  const name = party.name || "";
  const addr = [party.address1, party.address2, party.city].join(" ");
  const instr = [
    lane.specialInstructions,
    context.specialInstructionsGlobal,
  ].join(" ");

  if (side === "origin") {
    if (match.shipperNameContains &&
      containsAny(name, match.shipperNameContains)) {
      return "shipperName";
    }
    if (match.consigneeNameContains &&
      containsAny(name, match.consigneeNameContains)) {
      return "shipperName";
    }
    if (match.consigneeAddressContains &&
      containsAny(addr, match.consigneeAddressContains)) {
      return "shipperAddress";
    }
  } else {
    if (match.consigneeNameContains &&
      containsAny(name, match.consigneeNameContains)) {
      return "consigneeName";
    }
    if (match.consigneeAddressContains &&
      containsAny(addr, match.consigneeAddressContains)) {
      return "consigneeAddress";
    }
  }
  if (match.instructionsContains &&
    containsAny(instr, match.instructionsContains)) {
    return "instructions";
  }
  if (match.referenceContains) {
    const refs = (lane.referenceNumbers || []).join(" ");
    if (containsAny(refs, match.referenceContains)) return "reference";
  }
  if (match.flags && Array.isArray(match.flags)) {
    if (match.flags.some((f) => flagFromEmail(lane, f, side))) return "flags";
  }
  if (match.siteType && getEmailSiteType(lane, side) === match.siteType) {
    return "siteType";
  }
  return null;
}

/**
 * AI-only rule match (address classification / enrichment).
 * @param {object} lane Lane with enrichmentMeta.
 * @param {object} context Global context (unused).
 * @param {object} rule Rule document.
 * @param {"dest"|"origin"} [side] Address side.
 * @return {string|null} Match dimension or null.
 */
function ruleMatchViaAi(lane, context, rule, side = "dest") {
  const match = rule.match || {};
  if (!Object.keys(match).length) return null;
  const meta = side === "origin" ?
    lane.originEnrichmentMeta : lane.enrichmentMeta;
  if (!meta) return null;

  if (match.siteType && meta.classifiedAs === match.siteType) {
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
 * @param {object} lane Lane with consignee, flags, specialInstructions.
 * @param {object} context Global context (specialInstructionsGlobal).
 * @param {object} rule Rule document.
 * @param {"dest"|"origin"} [side] Address side.
 * @return {string|null} Match dimension or null.
 */
function ruleMatchVia(lane, context, rule, side = "dest") {
  const identifyVia = normalizeIdentifyVia(rule);
  const textVia = ruleMatchViaText(lane, context, rule, side);
  const aiVia = ruleMatchViaAi(lane, context, rule, side);

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
 * Applies rules to a lane; returns accessorial codes and filter hints.
 * @param {object} lane Lane object.
 * @param {Array<object>} rules Active rules.
 * @param {object} [context] Global email context.
 * @return {object} accessorials, filter hints, appliedRules
 */
function applyRulesToLane(lane, rules, context = {}) {
  const codes = new Set(Array.isArray(lane.accessorials) ?
    lane.accessorials : []);
  const withData = Array.isArray(lane.accessorialsWithData) ?
    [...lane.accessorialsWithData] : [];
  const filterWarnings = [];
  const applied = [];
  let requiresConfirm = false;

  for (const rule of rules) {
    if (!rule.active) continue;
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
    }
  }

  return {
    accessorials: [...codes],
    accessorialsWithData: withData,
    filterCarrierWarnings: filterWarnings,
    appliedRules: applied,
    requiresConfirm,
  };
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
  return snap.docs.map((d) => ({id: d.id, ...d.data()}));
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
  MANAGED_DEFAULT_RULE_IDS,
  RETIRED_DEFAULT_RULE_IDS,
  loadActiveRules,
  seedDefaultRules,
  ensureDefaultRulesPresent,
  applyRulesToLane,
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
};
