/**
 * Map RFQ email phrases to Primus accessorial codes.
 * Used at intake (AI + heuristic) and merged onto the lane before rating.
 */

"use strict";

const catalog = require("./quote-accessorial-catalog");
const declinedAcc = require("./quote-declined-accessorials");

/**
 * Extra codes not always present in static fallback tables.
 * INS = insurance; IND/INO = inside dest/origin.
 */
const EXTRA_KNOWN_CODES = ["INS", "IND", "INO", "HAZ", "PFF"];

/**
 * Origin/dest pairs: specific pickup/delivery phrasing wins over a bare
 * mention (bare "appointment" → APD, not APO+APD).
 *
 * Window (chars) around a liftgate mention used to detect side words like
 * "delivery" / "pickup" when order is "needed for delivery".
 */
const LIFTGATE_SIDE_WINDOW = 48;

/**
 * True when `sideWord` appears within LIFTGATE_SIDE_WINDOW of a liftgate /
 * no-dock mention (either side of the match).
 * @param {string} blob Email / instruction text.
 * @param {RegExp} sideWordRe Side word (delivery|pickup|…).
 * @return {boolean}
 */
function liftgateNearSideWord(blob, sideWordRe) {
  const text = String(blob || "");
  const gateRe = /\blift[\s-]*gates?\b|\bno\s+(loading\s+)?dock\b/gi;
  let m;
  while ((m = gateRe.exec(text)) !== null) {
    const start = Math.max(0, m.index - LIFTGATE_SIDE_WINDOW);
    const end = Math.min(
        text.length, m.index + m[0].length + LIFTGATE_SIDE_WINDOW);
    if (sideWordRe.test(text.slice(start, end))) return true;
  }
  return false;
}

const PAIR_PATTERNS = [
  {
    origin: "LFO",
    dest: "LFD",
    // Bare "liftgate needed" (no pickup/delivery word) → LFD only.
    // Warehouse / STG / company docks almost never need origin liftgate;
    // add LFO only when email explicitly says pickup/origin liftgate.
    // Delivery-scoped phrasing also → LFD only.
    bothIfBare: false,
    // eslint-disable-next-line max-len
    originRe: /\blift[\s-]*gates?\s+(at\s+)?(pickup|origin)\b|\blift[\s-]*gates?\s+(needed\s+)?(for|at)\s+(pickup|origin)\b|\b(pickup|origin)\s+lift[\s-]*gates?\b/i,
    // eslint-disable-next-line max-len
    destRe: /\blift[\s-]*gates?\s+(at\s+)?(delivery|dest(ination)?)\b|\blift[\s-]*gates?\s+(needed\s+)?(for|at)\s+(delivery|dest(ination)?)\b|\b(delivery|dest(ination)?)\s+lift[\s-]*gates?\b/i,
    bareRe: /\blift[\s-]*gates?\b|\bno\s+(loading\s+)?dock\b/i,
    nearOriginRe: /\b(pickup|origin)\b/i,
    nearDestRe: /\b(delivery|dest(ination)?)\b/i,
    useProximitySide: true,
  },
  {
    origin: "LAO",
    dest: "LAD",
    bothIfBare: false,
    originRe: /\b(limited|restricted)\s+access\s+(pickup|origin)\b/i,
    // eslint-disable-next-line max-len
    destRe: /\b(limited|restricted)\s+access\s+(delivery|dest(ination)?)\b/i,
    // eslint-disable-next-line max-len
    bareRe: /\b(limited|restricted)\s+access\b|\bgated\s+(community|facility|complex)\b/i,
  },
  {
    origin: "APO",
    dest: "APD",
    bothIfBare: false,
    originRe: /\bappointments?\s+(at\s+)?(pickup|origin)\b/i,
    destRe: /\bappointments?\s+(at\s+)?(delivery|dest(ination)?)\b/i,
    // eslint-disable-next-line max-len
    bareRe: /\b(appointments?|appt(\s+required)?|must\s+call|schedule\s+delivery|delivery\s+appointment)\b/i,
  },
  {
    origin: "RSO",
    dest: "RSD",
    bothIfBare: false,
    originRe: /\bresidential\s+(pickup|origin)\b/i,
    destRe: /\bresidential\s+(delivery|dest(ination)?)\b/i,
    bareRe: /\bresidential\b|\bhome\s+delivery\b/i,
  },
  {
    origin: "INO",
    dest: "IND",
    bothIfBare: false,
    originRe: /\binside\s+(pickup|origin|at\s+origin)\b/i,
    destRe: /\binside\s+(delivery|dest(ination)?|at\s+dest)/i,
    bareRe: /\binside\s*(:|\b(yes|y|required|needed|delivery)\b)/i,
  },
];

const SINGLE_PATTERNS = [
  {code: "INS", re: /\binsurance\b/i},
  {code: "HAZ", re: /\b(hazmat|hazardous\s+materials?)\b/i},
  {code: "PFF", re: /\bprotect(ed)?\s+from\s+freez/i},
  {code: "LAD", re: /\bLAD\s+please\b/i},
  {code: "NUD", re: /\bnursing(\s+home)?(\s+delivery)?\b/i},
  {code: "HOD", re: /\bhotel(\s+delivery)?\b/i},
  {code: "SCD", re: /\bschool(\s+delivery)?\b/i},
  {code: "NTD", re: /\bnotif(y|ication)(\s+(before\s+)?delivery)?\b/i},
];

/**
 * Clear request to apply limited/restricted access (LAD/LAO).
 * @param {string} text Email / instruction text.
 * @return {boolean}
 */
function isLimitedAccessClearRequest(text) {
  const t = String(text || "");
  if (!t.trim()) return false;
  // When disclose boilerplate is present, only strong verbs / LAD please
  // / gated site count — not bare "limited access delivery" substrings
  // that appear inside charge-disclose sentences.
  if (isLimitedAccessDiscloseBoilerplate(t)) {
    return (
      // eslint-disable-next-line max-len
      /\b(?:needs?|require[sd]?|must\s+have|please\s+add|add)\s+(?:limited|restricted)\s+access\b/i.test(t) ||
      // eslint-disable-next-line max-len
      /\b(?:limited|restricted)\s+access\s+(?:delivery\s+)?(?:required|needed|please)\b/i.test(t) ||
      // eslint-disable-next-line max-len
      /\b(?:site|location|destination|consignee|facility)\s+(?:is|has)\s+(?:limited|restricted)\s+access\b/i.test(t) ||
      /\bLAD\s+please\b/i.test(t) ||
      /\bgated\s+(?:community|facility|complex)\b/i.test(t)
    );
  }
  return (
    // eslint-disable-next-line max-len
    /\b(?:needs?|require[sd]?|must\s+have|please\s+add|add)\s+(?:limited|restricted)\s+access\b/i.test(t) ||
    // eslint-disable-next-line max-len
    /\b(?:limited|restricted)\s+access\s+(?:delivery\s+)?(?:required|needed|please)\b/i.test(t) ||
    /\b(?:limited|restricted)\s+access\s+delivery\b/i.test(t) ||
    // eslint-disable-next-line max-len
    /\b(?:site|location|destination|consignee|facility)\s+(?:is|has)\s+(?:limited|restricted)\s+access\b/i.test(t) ||
    // eslint-disable-next-line max-len
    /\b(?:limited|restricted)\s+access\s+(?:facility|location|site|warehouse|building)\b/i.test(t) ||
    /\bLAD\s+please\b/i.test(t) ||
    /\bgated\s+(?:community|facility|complex)\b/i.test(t) ||
    /\b(?:limited|restricted)\s+access\b/i.test(t)
  );
}

/**
 * Core Home / RFQ boilerplate: "disclose limited-access charges if
 * applicable" — NOT a request to apply LAD.
 * @param {string} text Email / instruction text.
 * @return {boolean}
 */
function isLimitedAccessDiscloseBoilerplate(text) {
  const t = String(text || "");
  if (!t.trim()) return false;
  return (
    // eslint-disable-next-line max-len
    /\binclude\s+(?:any\s+)?(?:additional\s+)?charges?\s+(?:applicable\s+)?(?:for\s+)?(?:restricted|limited)(?:\s+or\s+(?:restricted|limited))?\s+(?:access|delivery)\b/i.test(t) ||
    // eslint-disable-next-line max-len
    /\b(?:please\s+)?include\s+(?:any\s+)?(?:applicable\s+)?(?:limited|restricted)\s+access(?:\s+delivery)?\s+charges?\b/i.test(t) ||
    // eslint-disable-next-line max-len
    /\b(?:any\s+)?(?:applicable\s+)?(?:limited|restricted)\s+access(?:\s+delivery)?\s+charges?\b/i.test(t) ||
    /\bif\s+(?:limited|restricted)\s+access\s+applies\b/i.test(t) ||
    // eslint-disable-next-line max-len
    /\b(?:limited|restricted)\s+(?:access|delivery)\s+charges?\s+(?:if\s+)?(?:applicable|needed)\b/i.test(t) ||
    // eslint-disable-next-line max-len
    /\bcharges?\s+(?:applicable\s+)?for\s+(?:restricted|limited)(?:\s+or\s+(?:restricted|limited))?\s+(?:access|delivery)\b/i.test(t) ||
    // eslint-disable-next-line max-len
    /\b(?:show|disclose|list)\s+(?:any\s+)?(?:additional\s+)?(?:limited|restricted)\s+access(?:\s+delivery)?\s+charges?\b/i.test(t)
  );
}

/**
 * True when limited-access wording is only "disclose if applicable"
 * boilerplate (no clear request to apply LAD).
 * @param {string} text Email / instruction text.
 * @return {boolean}
 */
function isLimitedAccessDiscloseOnly(text) {
  const t = String(text || "");
  if (!t.trim()) return false;
  if (!isLimitedAccessDiscloseBoilerplate(t)) return false;
  return !isLimitedAccessClearRequest(t);
}

/**
 * @return {Set<string>} Primus codes we will apply from email text.
 */
function knownAccessorialCodes() {
  const codes = new Set(EXTRA_KNOWN_CODES);
  for (const table of [
    catalog.KNOWN_LABEL_CODES,
    catalog.FALLBACK_LABEL_CODES,
  ]) {
    for (const c of Object.values(table)) {
      if (c) codes.add(String(c).trim().toUpperCase());
    }
  }
  return codes;
}

/**
 * @param {string} code Candidate.
 * @param {Set<string>} known Allowlist.
 * @return {boolean}
 */
function isKnownCode(code, known) {
  return known.has(String(code || "").trim().toUpperCase());
}

/**
 * @param {Array<string>} codes Codes.
 * @return {Array<string>} Unique uppercase.
 */
function uniqueCodes(codes) {
  const seen = new Set();
  const out = [];
  for (const raw of codes || []) {
    const c = String(raw || "").trim().toUpperCase();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

/**
 * Scan email / instruction text for requested accessorial phrases.
 * @param {string} text Subject + body + instructions.
 * @return {Array<string>} Primus codes.
 */
function extractRequestedAccessorialsFromText(text) {
  const blob = String(text || "");
  if (!blob.trim()) return [];
  const known = knownAccessorialCodes();
  const codes = [];
  const declined = new Set(declinedAcc.detectDeclinedAccessorials(blob).codes);
  const skipLimitedAccess =
    isLimitedAccessDiscloseOnly(blob);
  for (const pair of PAIR_PATTERNS) {
    let originHit = pair.originRe && pair.originRe.test(blob);
    let destHit = pair.destRe && pair.destRe.test(blob);
    const bareHit = pair.bareRe && pair.bareRe.test(blob);
    // "Lift gate needed for delivery" / "these need liftgates" near
    // "delivery" → dest only (do not invent pickup liftgate).
    if (pair.useProximitySide && bareHit && !originHit && !destHit) {
      const nearDest = pair.nearDestRe &&
        liftgateNearSideWord(blob, pair.nearDestRe);
      const nearOrigin = pair.nearOriginRe &&
        liftgateNearSideWord(blob, pair.nearOriginRe);
      if (nearDest && !nearOrigin) destHit = true;
      else if (nearOrigin && !nearDest) originHit = true;
      else if (nearDest && nearOrigin) {
        destHit = true;
        originHit = true;
      }
    }
    // Disclose-only limited-access boilerplate must not add LAD/LAO.
    const skipLadPair = skipLimitedAccess &&
      (pair.origin === "LAO" || pair.dest === "LAD");
    if (originHit && !declined.has(pair.origin) && !skipLadPair) {
      codes.push(pair.origin);
    }
    if (destHit && !declined.has(pair.dest) && !skipLadPair) {
      codes.push(pair.dest);
    }
    if (!originHit && !destHit && bareHit && !skipLadPair) {
      if (pair.bothIfBare) {
        if (!declined.has(pair.origin)) codes.push(pair.origin);
        if (!declined.has(pair.dest)) codes.push(pair.dest);
      } else if (!declined.has(pair.dest)) {
        codes.push(pair.dest);
      }
    }
  }
  for (const row of SINGLE_PATTERNS) {
    if (row.re.test(blob) && !declined.has(row.code)) codes.push(row.code);
  }
  // "LAD please" and other clear requests that may not hit bareRe.
  if (isLimitedAccessClearRequest(blob) && !skipLimitedAccess &&
      !declined.has("LAD") && !codes.includes("LAD")) {
    codes.push("LAD");
  }
  return uniqueCodes(codes).filter((c) => isKnownCode(c, known) &&
    !declined.has(c));
}

/**
 * Normalize AI / heuristic requestedAccessorials (codes or phrases).
 * @param {*} raw Array of codes or names.
 * @return {Array<string>}
 */
function normalizeRequestedCodeList(raw) {
  if (!Array.isArray(raw)) return [];
  const known = knownAccessorialCodes();
  const codes = [];
  const phrases = [];
  for (const item of raw) {
    const s = String(item == null ? "" : item).trim();
    if (!s) continue;
    if (/^[A-Za-z]{2,6}$/.test(s)) {
      const u = s.toUpperCase();
      if (u === "LOAD") {
        codes.push("LAD");
      } else {
        codes.push(u);
      }
      continue;
    }
    phrases.push(s);
  }
  const fromPhrases = extractRequestedAccessorialsFromText(
      phrases.join("\n"));
  return uniqueCodes([...codes, ...fromPhrases])
      .filter((c) => isKnownCode(c, known));
}

/**
 * Concatenate extract fields that may name accessorials.
 * @param {object} extracted Intake result.
 * @param {object} [opts] subject, body.
 * @return {string}
 */
function extractedAccessorialText(extracted, opts = {}) {
  const ex = extracted && typeof extracted === "object" ? extracted : {};
  const parts = [
    opts.subject,
    opts.body,
    ex.specialInstructionsGlobal,
    ...(Array.isArray(ex.lanes) ? ex.lanes.map((l) =>
      l && l.specialInstructions) : []),
  ];
  return parts.filter(Boolean).join("\n");
}

/**
 * Strip wrong-side liftgate codes when email/instructions scope the
 * request to delivery-only or pickup-only.
 * @param {Array<string>} codes Accessorial codes.
 * @param {string} text Email / instructions blob.
 * @return {Array<string>}
 */
function refineLiftgateSides(codes, text) {
  const list = uniqueCodes(codes);
  const blob = String(text || "");
  if (!blob.trim()) return list;
  const hasLfo = list.includes("LFO");
  const hasLfd = list.includes("LFD");
  if (!hasLfo && !hasLfd) return list;

  const pair = PAIR_PATTERNS.find((p) => p.origin === "LFO");
  let originHit = pair.originRe && pair.originRe.test(blob);
  let destHit = pair.destRe && pair.destRe.test(blob);
  if (!originHit && !destHit && pair.bareRe && pair.bareRe.test(blob)) {
    const nearDest = liftgateNearSideWord(blob, pair.nearDestRe);
    const nearOrigin = liftgateNearSideWord(blob, pair.nearOriginRe);
    if (nearDest && !nearOrigin) destHit = true;
    else if (nearOrigin && !nearDest) originHit = true;
    else if (nearDest && nearOrigin) {
      destHit = true;
      originHit = true;
    } else {
      // Ambiguous "LIFTGATE NEEDED" → delivery only (strip invented LFO).
      destHit = true;
    }
  }
  if (destHit && !originHit) {
    return list.filter((c) => c !== "LFO");
  }
  if (originHit && !destHit) {
    return list.filter((c) => c !== "LFD");
  }
  return list;
}

/**
 * Resolve requested Primus codes from AI extract + email text.
 * `wantsLimitedAccessInQuote` maps to LAD only when the email is not
 * disclose-only limited-access boilerplate.
 * @param {object} extracted Intake result.
 * @param {object} [opts] subject, body.
 * @return {Array<string>}
 */
function resolveRequestedAccessorials(extracted, opts = {}) {
  const ex = extracted && typeof extracted === "object" ? extracted : {};
  const cr = ex.customerRequest && typeof ex.customerRequest === "object" ?
    ex.customerRequest : {};
  const fromAi = normalizeRequestedCodeList(cr.requestedAccessorials);
  const fromText = extractRequestedAccessorialsFromText(
      extractedAccessorialText(ex, opts));
  const scanText = extractedAccessorialText(ex, opts);
  const declined = declinedAcc.detectDeclinedAccessorials(scanText);
  const persisted = Array.isArray(ex.customerDeclinedAccessorials) ?
    ex.customerDeclinedAccessorials : [];
  const ban = new Set(declinedAcc.uniqueCodes([
    ...declined.codes,
    ...persisted,
  ]));
  let codes = refineLiftgateSides(
      uniqueCodes([...fromAi, ...fromText]), scanText);
  const discloseOnly = isLimitedAccessDiscloseOnly(scanText);
  // Soften flag: disclose-only RFQ boilerplate must not force LAD.
  if (cr.wantsLimitedAccessInQuote && !codes.includes("LAD") &&
      !ban.has("LAD") && !discloseOnly) {
    codes.push("LAD");
  }
  // Strip AI/heuristic LAD false positives from disclose-only emails.
  if (discloseOnly) {
    codes = codes.filter((c) => c !== "LAD" && c !== "LAO");
  }
  return codes.filter((c) => !ban.has(c));
}

/**
 * Stamp customerRequest.requestedAccessorials on an extract payload.
 * @param {object} extracted Intake result (mutated).
 * @param {object} [opts] subject, body.
 * @return {object}
 */
function attachRequestedAccessorials(extracted, opts = {}) {
  const ex = extracted && typeof extracted === "object" ? extracted : {};
  const cr = ex.customerRequest && typeof ex.customerRequest === "object" ?
    {...ex.customerRequest} : {};
  const codes = resolveRequestedAccessorials(ex, opts);
  const declined = declinedAcc.detectDeclinedAccessorials(
      extractedAccessorialText(ex, opts));
  cr.requestedAccessorials = codes;
  if (codes.includes("LAD")) {
    cr.wantsLimitedAccessInQuote = true;
  } else if (isLimitedAccessDiscloseOnly(
      extractedAccessorialText(ex, opts))) {
    // Disclose-only boilerplate is not a limited-access request.
    cr.wantsLimitedAccessInQuote = false;
  }
  ex.customerRequest = cr;
  ex.customerDeclinedAccessorials = declinedAcc.uniqueCodes([
    ...(Array.isArray(ex.customerDeclinedAccessorials) ?
      ex.customerDeclinedAccessorials : []),
    ...declined.codes,
  ]);
  return ex;
}

/**
 * Merge email-requested codes onto a rules result without duplicating
 * codes already added by quote rules. Adds an appliedRules row for
 * newly added codes so the dispatcher UI can show "requested in email".
 * When `scanText` is provided, strips LFO/LFD that conflict with
 * delivery-only or pickup-only liftgate phrasing (including stale
 * liftgate_no_dock LFO+LFD).
 * @param {object} rulesOut applyRulesToLane result.
 * @param {Array<string>} requestedCodes From resolveRequestedAccessorials.
 * @param {function(Array<string>): string} formatLabels Label helper.
 * @param {string} [scanText] Email / instructions for side refine.
 * @return {object}
 */
function applyEmailRequestedAccessorials(
    rulesOut, requestedCodes, formatLabels, scanText) {
  const out = rulesOut && typeof rulesOut === "object" ? {...rulesOut} : {
    accessorials: [],
    accessorialsWithData: [],
    appliedRules: [],
    filterCarrierWarnings: [],
    requiresConfirm: false,
  };
  const requested = uniqueCodes(requestedCodes);
  const existing = new Set(
      (out.accessorials || []).map((c) => String(c).toUpperCase()));
  const added = [];
  for (const code of requested) {
    if (existing.has(code)) continue;
    existing.add(code);
    added.push(code);
  }
  let accessorials = [...existing];
  if (scanText) {
    accessorials = refineLiftgateSides(accessorials, scanText);
  }
  out.accessorials = accessorials;
  if (added.length) {
    const labels = typeof formatLabels === "function" ?
      formatLabels(added) : added.join(", ");
    const applied = Array.isArray(out.appliedRules) ?
      [...out.appliedRules] : [];
    applied.push({
      ruleId: "email_requested",
      name: "Requested in email",
      notes: labels ?
        labels + " requested in the RFQ email." :
        "Accessorials requested in the RFQ email.",
      matchVia: "email",
    });
    out.appliedRules = applied;
  }
  return out;
}

module.exports = {
  knownAccessorialCodes,
  declinesAppointmentDelivery: declinedAcc.declinesAppointmentDelivery,
  declinesLiftgate: declinedAcc.declinesLiftgate,
  declinesLimitedAccess: declinedAcc.declinesLimitedAccess,
  detectDeclinedAccessorials: declinedAcc.detectDeclinedAccessorials,
  stripDeclinedCodes: declinedAcc.stripDeclinedCodes,
  applyDeclinedAccessorials: declinedAcc.applyDeclinedAccessorials,
  isLimitedAccessClearRequest,
  isLimitedAccessDiscloseBoilerplate,
  isLimitedAccessDiscloseOnly,
  extractRequestedAccessorialsFromText,
  normalizeRequestedCodeList,
  resolveRequestedAccessorials,
  attachRequestedAccessorials,
  applyEmailRequestedAccessorials,
  refineLiftgateSides,
  extractedAccessorialText,
};
