/**
 * Map RFQ email phrases to Primus accessorial codes.
 * Used at intake (AI + heuristic) and merged onto the lane before rating.
 */

"use strict";

const catalog = require("./quote-accessorial-catalog");
const appointmentText = require("./quote-appointment-text");

/**
 * Extra codes not always present in static fallback tables.
 * INS = insurance; IND/INO = inside dest/origin.
 */
const EXTRA_KNOWN_CODES = ["INS", "IND", "INO", "HAZ", "PFF"];

/**
 * Origin/dest pairs: specific pickup/delivery phrasing wins over a bare
 * mention (bare "appointment" → APD, not APO+APD).
 */
const PAIR_PATTERNS = [
  {
    origin: "LFO",
    dest: "LFD",
    bothIfBare: true,
    originRe: /\blift[\s-]*gates?\s+(at\s+)?(pickup|origin)\b/i,
    // eslint-disable-next-line max-len
    destRe: /\blift[\s-]*gates?\s+(at\s+)?(delivery|dest(ination)?)\b/i,
    bareRe: /\blift[\s-]*gates?\b|\bno\s+(loading\s+)?dock\b/i,
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
  {code: "NUD", re: /\bnursing(\s+home)?(\s+delivery)?\b/i},
  {code: "HOD", re: /\bhotel(\s+delivery)?\b/i},
  {code: "SCD", re: /\bschool(\s+delivery)?\b/i},
  {code: "NTD", re: /\bnotif(y|ication)(\s+(before\s+)?delivery)?\b/i},
];

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
  const skipAppt = appointmentText.declinesAppointmentDelivery(blob);
  for (const pair of PAIR_PATTERNS) {
    if (skipAppt && (pair.dest === "APD" || pair.origin === "APO")) {
      continue;
    }
    const originHit = pair.originRe && pair.originRe.test(blob);
    const destHit = pair.destRe && pair.destRe.test(blob);
    const bareHit = pair.bareRe && pair.bareRe.test(blob);
    if (originHit) codes.push(pair.origin);
    if (destHit) codes.push(pair.dest);
    if (!originHit && !destHit && bareHit) {
      if (pair.bothIfBare) {
        codes.push(pair.origin, pair.dest);
      } else {
        codes.push(pair.dest);
      }
    }
  }
  for (const row of SINGLE_PATTERNS) {
    if (row.re.test(blob)) codes.push(row.code);
  }
  return uniqueCodes(codes).filter((c) => isKnownCode(c, known));
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
 * Resolve requested Primus codes from AI extract + email text.
 * `wantsLimitedAccessInQuote` always maps to LAD.
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
  const codes = uniqueCodes([...fromAi, ...fromText]);
  if (cr.wantsLimitedAccessInQuote && !codes.includes("LAD")) {
    codes.push("LAD");
  }
  if (appointmentText.declinesAppointmentDelivery(
      extractedAccessorialText(ex, opts))) {
    return codes.filter((c) => c !== "APD" && c !== "APO");
  }
  return codes;
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
  cr.requestedAccessorials = codes;
  if (codes.includes("LAD")) cr.wantsLimitedAccessInQuote = true;
  ex.customerRequest = cr;
  return ex;
}

/**
 * Merge email-requested codes onto a rules result without duplicating
 * codes already added by quote rules. Adds an appliedRules row for
 * newly added codes so the dispatcher UI can show "requested in email".
 * @param {object} rulesOut applyRulesToLane result.
 * @param {Array<string>} requestedCodes From resolveRequestedAccessorials.
 * @param {function(Array<string>): string} formatLabels Label helper.
 * @return {object}
 */
function applyEmailRequestedAccessorials(
    rulesOut, requestedCodes, formatLabels) {
  const out = rulesOut && typeof rulesOut === "object" ? {...rulesOut} : {
    accessorials: [],
    accessorialsWithData: [],
    appliedRules: [],
    filterCarrierWarnings: [],
    requiresConfirm: false,
  };
  const requested = uniqueCodes(requestedCodes);
  if (!requested.length) return out;
  const existing = new Set(
      (out.accessorials || []).map((c) => String(c).toUpperCase()));
  const added = [];
  for (const code of requested) {
    if (existing.has(code)) continue;
    existing.add(code);
    added.push(code);
  }
  out.accessorials = [...existing];
  if (!added.length) return out;
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
  return out;
}

module.exports = {
  knownAccessorialCodes,
  declinesAppointmentDelivery: appointmentText.declinesAppointmentDelivery,
  extractRequestedAccessorialsFromText,
  normalizeRequestedCodeList,
  resolveRequestedAccessorials,
  attachRequestedAccessorials,
  applyEmailRequestedAccessorials,
  extractedAccessorialText,
};
