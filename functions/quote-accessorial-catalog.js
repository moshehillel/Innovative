"use strict";

/**
 * Quote dispatcher accessorial catalog — Primus Origin / Destination / Other.
 * Static labels are the UI source of truth; codes come from known mappings
 * and/or live GET /accessorial (matched by name).
 */

const admin = require("firebase-admin");
const rateShop = require("./quote-rate-shop");

/** @type {null|{tcol: Function}} */
let deps = null;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Known label → Primus code (including naming aliases vs Primus names).
 * Prefer these when the live catalog name differs slightly.
 */
const KNOWN_LABEL_CODES = {
  "Liftgate at Origin": "LFO",
  "Liftgate at Destination": "LFD",
  "Appointment at Origin": "APO",
  "Appointment at Destination": "APD",
  "Limited Access Pickup": "LAO",
  "Limited Access Delivery": "LAD",
  "Residential Pickup": "RSO",
  "Residential Delivery": "RSD",
  "Nursing Home Pickup": "NUP",
  "Nursing Home Delivery": "NUD",
  "Hotel Pickup": "HOO",
  "Hotel Delivery": "HOD",
  "School Pickup": "SCO",
  "School Delivery": "SCD",
  "Inside Origin": "INO",
  "Inside Destination": "IND",
  "Adminstrative Fee": "AF",
  "Administrative Fee": "AF",
  "Airport Transfer Delivery": "TRD",
  "Airport Transfer Pickup": "TRRP",
  "Power Plant / Nuclear|origin": "PWO",
  "Power Plant / Nuclear|destination": "PWD",
  "Oversize > 7ft.": null,
  "Direct Signature Required": null,
};

/**
 * Static fallback codes when Primus is unreachable.
 * Keys may be `label` or `label|origin` / `label|destination`.
 */
const FALLBACK_LABEL_CODES = {
  "After Hours Pickup": "AHP",
  "Airport Pickup": "ARO",
  "Airport Transfer Pickup": "TRRP",
  "Appointment at Origin": "APO",
  "Camp/Park/Resort Pickup": "CPP",
  "Church Pickup": "CHO",
  "Construction Site Pickup": "CSO",
  "Container Station in Origin": "CTO",
  "Detention Pickup": "DTT",
  "Dock Pickup": "DKO",
  "Exhibition Pickup": "EXO",
  "Extra Man Pickup": "XMP",
  "Fair Pickup": "FIO",
  "Farm/Ranch Pickup": "FAP",
  "Government Origin": "GVO",
  "Hold for Pickup": "HFP",
  "Holiday Pickup": "HLO",
  "Hospital Pickup": "HPC",
  "Hotel Pickup": "HOO",
  "Inside Origin": "INO",
  "Liftgate at Origin": "LFO",
  "Limited Access Pickup": "LAO",
  "Mall Pickup": "MPC",
  "Military Pickup": "MIO",
  "Mine Pickup": "MNP",
  "Notification Pickup": "NTO",
  "Nursing Home Pickup": "NUP",
  "Pallet Exchange Pickup": "CPX",
  "Pallet Jack Pickup": "PJO",
  "Pier or Port Pickup": "PPO",
  "Power Plant / Nuclear|origin": "PWO",
  "Prison Pickup": "PSO",
  "Residential Pickup": "RSO",
  "Saturday Pickup": "SAP",
  "School Pickup": "SCO",
  "Self Storage Pickup": "SWO",
  "Sorting/Segregating Origin": "SSO",
  "Special Pickup": "BSP",
  "Steel Mill Pickup": "SMO",
  "Sunday Pickup": "SUP",
  "TSA Qualified Driver Pickup": "TSP",
  "Weekend Pickup": "WKP",
  "Adult Signature Required": "ASIG",
  "After Hours Delivery": "AHD",
  "Airport Delivery": "ARD",
  "Airport Transfer Delivery": "TRD",
  "Appointment at Destination": "APD",
  "Camp/Park/Resort Delivery": "CPD",
  "Church Delivery": "CHD",
  "Construction Site Delivery": "CSD",
  "Container Station in Destination": "CTD",
  "Detention Delivery": "DED",
  "Distribution Center Delivery": "DCD",
  "Dock Delivery": "DKD",
  "Exhibition Delivery": "EXD",
  "Extra Man Delivery": "EMD",
  "Fair Delivery": "FID",
  "Farm/Ranch Delivery": "FAD",
  "Government Destination": "GVD",
  "Grocery Warehouse Delivery": "GCDC",
  "Hold for Delivery": "HFD",
  "Holiday Delivery": "HLD",
  "Hospital Delivery": "HDC",
  "Hotel Delivery": "HOD",
  "Inside Destination": "IND",
  "Liftgate at Destination": "LFD",
  "Limited Access Delivery": "LAD",
  "Mall Delivery": "MBD",
  "Military Delivery": "MID",
  "Mine Delivery": "MND",
  "Notification Delivery": "NTD",
  "Nursing Home Delivery": "NUD",
  "Pallet Exchange Delivery": "PED",
  "Pallet Jack Delivery": "PJD",
  "Pier or Port Delivery": "PPD",
  "Power Plant / Nuclear|destination": "PWD",
  "Prison Delivery": "PSD",
  "Redelivery Fee": "RDV",
  "Residential Delivery": "RSD",
  "Residential Delivery Signature Required": "HDSIG",
  "Saturday Delivery": "SAD",
  "School Delivery": "SCD",
  "Self Storage Delivery": "SWD",
  "Sorting/Segregating Destination": "SSD",
  "Special Delivery": "BSD",
  "Steel Mill Delivery": "SMD",
  "Sunday Delivery": "SUD",
  "TSA Qualified Driver Delivery": "TSD",
  "Unpack": "UNP",
  "Weekend Delivery": "WKD",
  "Adminstrative Fee": "AF",
  "Airport Drop/Recovery": "APR",
  "Alcoholic Beverage Reporting Charge": "ALC",
  "Blind Shipment": "BSC",
  "COD": "COD",
  "FCCOD": "FCCOD",
  "Fuel Surcharge": "FSC",
  "Furniture Fee": "FUR",
  "Hazardous Material": "HAZ",
  "Inbond Charge": "INB",
  "Labeling Fee": "LAB",
  "New Jersey Alcoholic Bev Rpt Charge": "NJA",
  "New York Garment Area": "GDM",
  "Packaging Fee": "PAK",
  "Protect from Freezing": "PFF",
  "Protect from heat": "PFH",
  "Re Weigh/Weight Verification": "WTV",
  "Reefer": "REEF",
  "Security Inspection": "SIN",
  "Single Shipment": "SSH",
  "Tolls": "TOLL",
  "Vendor Declared Value": "VINS",
  "Xtreme Assurance": "XTRASR",
  "test": "TEST",
};

/** UI section labels (user-provided Primus catalog structure). */
const STATIC_SECTIONS = {
  origin: [
    "After Hours Pickup",
    "Airport Pickup",
    "Airport Transfer Pickup",
    "Appointment at Origin",
    "Camp/Park/Resort Pickup",
    "Church Pickup",
    "Construction Site Pickup",
    "Container Station in Origin",
    "Detention Pickup",
    "Dock Pickup",
    "Exhibition Pickup",
    "Extra Man Pickup",
    "Fair Pickup",
    "Farm/Ranch Pickup",
    "Government Origin",
    "Hold for Pickup",
    "Holiday Pickup",
    "Hospital Pickup",
    "Hotel Pickup",
    "Inside Origin",
    "Liftgate at Origin",
    "Limited Access Pickup",
    "Mall Pickup",
    "Military Pickup",
    "Mine Pickup",
    "Notification Pickup",
    "Nursing Home Pickup",
    "Oversize > 7ft.",
    "Pallet Exchange Pickup",
    "Pallet Jack Pickup",
    "Pier or Port Pickup",
    "Power Plant / Nuclear",
    "Prison Pickup",
    "Residential Pickup",
    "Saturday Pickup",
    "School Pickup",
    "Self Storage Pickup",
    "Sorting/Segregating Origin",
    "Special Pickup",
    "Steel Mill Pickup",
    "Sunday Pickup",
    "TSA Qualified Driver Pickup",
    "Weekend Pickup",
  ],
  destination: [
    "Adult Signature Required",
    "After Hours Delivery",
    "Airport Delivery",
    "Airport Transfer Delivery",
    "Appointment at Destination",
    "Camp/Park/Resort Delivery",
    "Church Delivery",
    "Construction Site Delivery",
    "Container Station in Destination",
    "Detention Delivery",
    "Direct Signature Required",
    "Distribution Center Delivery",
    "Dock Delivery",
    "Exhibition Delivery",
    "Extra Man Delivery",
    "Fair Delivery",
    "Farm/Ranch Delivery",
    "Government Destination",
    "Grocery Warehouse Delivery",
    "Hold for Delivery",
    "Holiday Delivery",
    "Hospital Delivery",
    "Hotel Delivery",
    "Inside Destination",
    "Liftgate at Destination",
    "Limited Access Delivery",
    "Mall Delivery",
    "Military Delivery",
    "Mine Delivery",
    "Notification Delivery",
    "Nursing Home Delivery",
    "Pallet Exchange Delivery",
    "Pallet Jack Delivery",
    "Pier or Port Delivery",
    "Power Plant / Nuclear",
    "Prison Delivery",
    "Redelivery Fee",
    "Residential Delivery",
    "Residential Delivery Signature Required",
    "Saturday Delivery",
    "School Delivery",
    "Self Storage Delivery",
    "Sorting/Segregating Destination",
    "Special Delivery",
    "Steel Mill Delivery",
    "Sunday Delivery",
    "TSA Qualified Driver Delivery",
    "Unpack",
    "Weekend Delivery",
  ],
  other: [
    "AN Fees",
    "Additional Accessorials",
    "Additional Invoice",
    "Additional Skids",
    "Adminstrative Fee",
    "After Hours Service",
    "Airport Drop/Recovery",
    "Alcoholic Beverage Reporting Charge",
    "Attempt Pickup",
    "Attempted Delivery",
    "Blind Shipment",
    "Bobtail",
    "Bond and Service Charges",
    "CFS Fees",
    "CIT Disbursement Fee",
    "COD",
    "CTF",
    "Carm Fee",
    "Change in dims",
    "Chargeback",
    "Chassis Rental",
    "Chassis Split",
    "Commission - Carrier",
    "Container Lift",
    "Continuous Bond",
    "Credit Card Fee",
    "Customs Broker Fee",
    "Customs Entry Fee",
    "Delivery Appointment",
    "Delivery During Non Business Hours",
    "Detention",
    "Discount",
    "Driver Labor",
    "Drop Container",
    "Dump Truck",
    "Duties",
    "Empty Pallets",
    "Exam Fee",
    "FCCOD",
    "FDA Filling Fee",
    "Final Delivery",
    "Freight",
    "Fuel Surcharge",
    "Furniture Fee",
    "GST",
    "Gate Fee",
    "Guaranteed Delivery",
    "Hazardous Material",
    "ISC",
    "ISF Filing Fee",
    "Inbond Charge",
    "Inbound Loading",
    "Inbound per Pallet",
    "Inside Delivery",
    "Inspection Fee",
    "Insurance",
    "Labeling",
    "Labeling Fee",
    "Labor",
    "Late Fee",
    "Layover",
    "Lumper",
    "Military Site",
    "New Jersey Alcoholic Bev Rpt Charge",
    "New Pickup",
    "New York Garment Area",
    "Notify",
    "OGD",
    "Off Hire Charge",
    "Order Processing",
    "Outbound Loading",
    "Outbound Per Pallet",
    "Outbound per Carton",
    "Overweight Fee",
    "Packaging Fee",
    "Pallet Exchange",
    "Pallet Jack",
    "Palletize",
    "Per Diem",
    "Pickup Appointment",
    "Port Check",
    "Prepull",
    "Protect from Freezing",
    "Protect from heat",
    "RM Usage Fee",
    "Re Weigh/Weight Verification",
    "Reclass",
    "Reefer",
    "Reweigh",
    "Rush Fee",
    "Security Inspection",
    "Settlement",
    "Shrink Wrap",
    "Sima",
    "Single Shipment",
    "Single Shipment Fee",
    "Sort and Seg",
    "Storage",
    "TMF",
    "Time Specific",
    "Tolls",
    "Transload",
    "Truck Ordered Not Used",
    "Vendor Declared Value",
    "Warehousing",
    "Wash House Delivery",
    "Weekend Service",
    "Xtreme Assurance",
    "Trailer Delivery",
    "Stop off",
    "Redelivery",
    "Reconsignment",
    "Pre Pull",
    "Pier Pass",
    "Demurrage",
    "CARM Setup Fee",
    "Custom Accessorials",
    "Additional Pallets",
    "test",
  ],
};

/**
 * Extra label aliases → Primus catalog name (for fuzzy match).
 */
const LABEL_NAME_ALIASES = {
  "Liftgate at Origin": ["Liftgate in Origin"],
  "Liftgate at Destination": ["Liftgate in Destination"],
  "Limited Access Pickup": ["Secured / Limited Access Pickup"],
  "Limited Access Delivery": ["Secured / Limited Access Delivery"],
  "Adminstrative Fee": ["Administrative Fee"],
  "Airport Transfer Delivery": [
    "Airport Transfer Delivery",
    "Aiport Transfer Delivery",
  ],
  "Airport Transfer Pickup": [
    "Airport Transfer Pickup",
    "Aiport Transfer Pickup",
  ],
  "Tolls": ["Toll Charge"],
  "Fuel Surcharge": ["Fuel Surcharge"],
  "test": ["TEST ACCESSORIAL", "Testing Fee"],
};

/**
 * @param {object} d tcol.
 * @return {void}
 */
function init(d) {
  deps = d;
}

/**
 * @param {string} s Raw.
 * @return {string}
 */
function normName(s) {
  return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
}

/**
 * Parse Primus /accessorial response into flat rows.
 * Supports both `{results:{accessorials:[…]}}` and array-of-blocks shapes.
 * @param {object} json Primus JSON.
 * @return {Array<object>}
 */
function parseAccessorialCatalogResponse(json) {
  const results = json && json.data && json.data.results;
  if (!results) return [];
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
  if (Array.isArray(results.accessorials)) {
    return results.accessorials;
  }
  return [];
}

/**
 * Normalize / dedupe Primus rows.
 * @param {Array<object>} raw Rows from Primus.
 * @return {Array<{id:*,code:string,name:string,category:string}>}
 */
function normalizePrimusRows(raw) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(raw) ? raw : []) {
    const code = String(row && row.code || "").trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    let category = String(row.category || "").trim();
    if (/^origin$/i.test(category)) category = "Origin";
    else if (/^destination$/i.test(category)) category = "Destination";
    else if (!category) category = "Other";
    else if (!/^other$/i.test(category)) {
      // Keep unknown categories under Other for UI grouping.
      category = "Other";
    } else {
      category = "Other";
    }
    out.push({
      id: row.id != null ? row.id : null,
      code,
      name: String(row.name || code).trim(),
      category,
    });
  }
  return out;
}

/**
 * Build name → code index from Primus rows (plus alias keys).
 * @param {Array<object>} primusRows Normalized rows.
 * @return {Map<string, string>}
 */
function buildNameToCodeIndex(primusRows) {
  const map = new Map();
  for (const row of primusRows) {
    const n = normName(row.name);
    if (n && !map.has(n)) map.set(n, row.code);
    if (row.code && !map.has(normName(row.code))) {
      map.set(normName(row.code), row.code);
    }
  }
  return map;
}

/**
 * Resolve a UI label to a Primus code.
 * @param {string} label UI label.
 * @param {Map<string, string>} nameIndex From Primus.
 * @param {Map<string, object>} codeIndex code → row.
 * @param {"origin"|"destination"|"other"} [section] UI section.
 * @return {string|null}
 */
function resolveLabelCode(label, nameIndex, codeIndex, section) {
  const scopedKey = section ? `${label}|${section}` : null;
  const knownTables = [KNOWN_LABEL_CODES, FALLBACK_LABEL_CODES];
  for (const table of knownTables) {
    if (scopedKey &&
        Object.prototype.hasOwnProperty.call(table, scopedKey)) {
      return table[scopedKey];
    }
    if (Object.prototype.hasOwnProperty.call(table, label)) {
      return table[label];
    }
  }

  const wantCat = section === "origin" ? "Origin" :
    section === "destination" ? "Destination" : null;
  const aliases = LABEL_NAME_ALIASES[label] || [];
  const candidates = [label, ...aliases];
  for (const c of candidates) {
    const n = normName(c);
    // Prefer category-matched Primus row when names collide.
    if (wantCat && codeIndex.size) {
      for (const row of codeIndex.values()) {
        if (normName(row.name) === n && row.category === wantCat) {
          return row.code;
        }
      }
    }
    const hit = nameIndex.get(n);
    if (hit) return hit;
  }
  // Typo-tolerant: aiport ↔ airport
  const n = normName(label).replace(/\baiport\b/g, "airport");
  if (wantCat && codeIndex.size) {
    for (const row of codeIndex.values()) {
      const rn = normName(row.name).replace(/\baiport\b/g, "airport");
      if (rn === n && row.category === wantCat) return row.code;
    }
  }
  if (nameIndex.has(n)) return nameIndex.get(n);
  for (const [key, code] of nameIndex) {
    if (key.replace(/\baiport\b/g, "airport") === n) return code;
  }
  return null;
}

/**
 * Map Primus category → section key.
 * @param {string} category Primus category.
 * @return {"origin"|"destination"|"other"}
 */
function sectionForCategory(category) {
  if (category === "Origin") return "origin";
  if (category === "Destination") return "destination";
  return "other";
}

/**
 * Build UI catalog: static sections enriched with codes from Primus.
 * Extra Primus-only codes are appended under their category.
 * @param {Array<object>} [primusRows] Normalized Primus rows.
 * @return {object}
 */
function buildDispatcherCatalog(primusRows = []) {
  const rows = normalizePrimusRows(primusRows);
  const nameIndex = buildNameToCodeIndex(rows);
  const codeIndex = new Map(rows.map((r) => [r.code, r]));
  const usedCodes = new Set();

  const sections = {origin: [], destination: [], other: []};
  for (const [section, labels] of Object.entries(STATIC_SECTIONS)) {
    for (const label of labels) {
      const code = resolveLabelCode(label, nameIndex, codeIndex, section);
      if (code) usedCodes.add(code);
      const primus = code ? codeIndex.get(code) : null;
      sections[section].push({
        label,
        code: code || null,
        name: (primus && primus.name) || label,
        category: section === "origin" ? "Origin" :
          section === "destination" ? "Destination" : "Other",
        selectable: !!code,
      });
    }
  }

  // Append Primus codes not covered by static labels.
  for (const row of rows) {
    if (usedCodes.has(row.code)) continue;
    const section = sectionForCategory(row.category);
    sections[section].push({
      label: row.name,
      code: row.code,
      name: row.name,
      category: row.category,
      selectable: true,
      fromPrimusOnly: true,
    });
  }

  return {
    origin: sections.origin,
    destination: sections.destination,
    other: sections.other,
    source: rows.length ? "primus+static" : "static",
    primusCount: rows.length,
  };
}

/**
 * Static-only fallback (no Primus call).
 * @return {object}
 */
function buildStaticFallbackCatalog() {
  return buildDispatcherCatalog([]);
}

/**
 * Fetch Primus catalog (uncached).
 * @return {Promise<Array<object>>}
 */
async function fetchPrimusAccessorialRows() {
  const rows = await rateShop.fetchAccessorialCatalog(false);
  return normalizePrimusRows(rows);
}

/**
 * Load catalog with Firestore cache (tenant quoteConfig/accessorialCatalog).
 * @param {object} tenant Tenant.
 * @param {object} [opts] forceRefresh.
 * @return {Promise<object>}
 */
async function getQuoteAccessorialCatalog(tenant, opts = {}) {
  const force = !!opts.forceRefresh;
  let cached = null;
  if (deps && deps.tcol && tenant) {
    try {
      const ref = deps.tcol(tenant, "quoteConfig").doc("accessorialCatalog");
      const snap = await ref.get();
      if (snap.exists) {
        const data = snap.data() || {};
        const fetchedAt = data.fetchedAt && data.fetchedAt.toMillis ?
          data.fetchedAt.toMillis() : Number(data.fetchedAtMs) || 0;
        if (!force && fetchedAt &&
            (Date.now() - fetchedAt) < CACHE_TTL_MS &&
            data.catalog) {
          return {
            ok: true,
            cached: true,
            fetchedAt,
            ...data.catalog,
          };
        }
        cached = data;
      }
    } catch (_) {
      // ignore cache read errors
    }
  }

  let primusRows = [];
  let fetchError = null;
  try {
    primusRows = await fetchPrimusAccessorialRows();
  } catch (err) {
    fetchError = err.message || String(err);
    if (cached && cached.catalog) {
      return {
        ok: true,
        cached: true,
        stale: true,
        fetchError,
        ...cached.catalog,
      };
    }
  }

  const catalog = primusRows.length ?
    buildDispatcherCatalog(primusRows) :
    buildStaticFallbackCatalog();

  if (deps && deps.tcol && tenant && primusRows.length) {
    try {
      const ref = deps.tcol(tenant, "quoteConfig").doc("accessorialCatalog");
      await ref.set({
        catalog,
        primusRows,
        fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
        fetchedAtMs: Date.now(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
    } catch (_) {
      // non-fatal
    }
  }

  return {
    ok: true,
    cached: false,
    fetchError,
    ...catalog,
  };
}

/**
 * Normalize rerun payload into Primus codes[].
 * Accepts string[] or {code,at|section}[].
 * @param {*} raw Body accessorials.
 * @return {string[]}
 */
function normalizeRerunAccessorialCodes(raw) {
  if (!Array.isArray(raw)) return [];
  const codes = [];
  for (const item of raw) {
    if (typeof item === "string" || typeof item === "number") {
      const c = String(item).trim().toUpperCase();
      if (c) codes.push(c);
      continue;
    }
    if (item && typeof item === "object" && item.code) {
      const c = String(item.code).trim().toUpperCase();
      if (c) codes.push(c);
    }
  }
  return [...new Set(codes)];
}

module.exports = {
  init,
  STATIC_SECTIONS,
  KNOWN_LABEL_CODES,
  FALLBACK_LABEL_CODES,
  parseAccessorialCatalogResponse,
  normalizePrimusRows,
  buildDispatcherCatalog,
  buildStaticFallbackCatalog,
  getQuoteAccessorialCatalog,
  normalizeRerunAccessorialCodes,
  fetchPrimusAccessorialRows,
};
