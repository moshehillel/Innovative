/**
 * Customer-declined accessorials — negative phrasing is first-class.
 * "No appointment / no liftgate / no limited access" wins over keyword
 * and site-type rules. Leaf module (no catalog / rules imports).
 */

"use strict";

/**
 * Customer said appointment is not needed — APD/APO must not apply.
 */
const NO_APPOINTMENT_RE = new RegExp(
    "\\b(?:" +
    "no\\s+(?:delivery\\s+)?(?:appointments?|appts?)" +
    "(?:\\s*(?:necessary|needed|required))?" +
    "|(?:appointment|appt)s?\\s+not\\s+(?:necessary|needed|required)" +
    "|(?:appointment|appt)s?\\s+unnecessary" +
    ")\\b",
    "i");

/**
 * Customer said liftgate is not needed — LFD/LFO must not apply.
 * Does not match "no loading dock" (that requests a liftgate).
 */
const NO_LIFTGATE_RE = new RegExp(
    "\\b(?:" +
    "no\\s+lift[\\s-]*gates?" +
    "(?:\\s*(?:necessary|needed|required))?" +
    "|lift[\\s-]*gates?\\s+not\\s+(?:necessary|needed|required)" +
    "|lift[\\s-]*gates?\\s+unnecessary" +
    ")\\b",
    "i");

/**
 * Customer said limited/restricted access is not needed — LAD/LAO.
 */
const NO_LIMITED_ACCESS_RE = new RegExp(
    "\\b(?:" +
    "no\\s+(?:limited|restricted)\\s+access" +
    "(?:\\s*(?:necessary|needed|required))?" +
    "|(?:limited|restricted)\\s+access\\s+not\\s+" +
    "(?:necessary|needed|required)" +
    ")\\b",
    "i");

/** Primus codes stripped for each decline class. */
const DECLINE_CLASSES = [
  {
    re: NO_APPOINTMENT_RE,
    codes: ["APD", "APO"],
    warning: "stripped APD: customer said no appt",
    ruleId: "email_no_appointment",
    name: "No appointment needed",
    notes: "Customer said no appointment is needed — APD not applied.",
  },
  {
    re: NO_LIFTGATE_RE,
    codes: ["LFD", "LFO"],
    warning: "stripped LFD: customer said no liftgate",
    ruleId: "email_no_liftgate",
    name: "No liftgate needed",
    notes: "Customer said no liftgate is needed — LFD/LFO not applied.",
  },
  {
    re: NO_LIMITED_ACCESS_RE,
    codes: ["LAD", "LAO"],
    warning: "stripped LAD: customer said no limited access",
    ruleId: "email_no_limited_access",
    name: "No limited access",
    notes: "Customer said no limited access — LAD/LAO not applied.",
  },
];

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
 * @param {string} text Subject + body + instructions.
 * @return {boolean}
 */
function declinesAppointmentDelivery(text) {
  return NO_APPOINTMENT_RE.test(String(text || ""));
}

/**
 * @param {string} text Subject + body + instructions.
 * @return {boolean}
 */
function declinesLiftgate(text) {
  return NO_LIFTGATE_RE.test(String(text || ""));
}

/**
 * @param {string} text Subject + body + instructions.
 * @return {boolean}
 */
function declinesLimitedAccess(text) {
  return NO_LIMITED_ACCESS_RE.test(String(text || ""));
}

/**
 * Detect declined Primus codes from negative RFQ phrasing.
 * @param {string} text Subject + body + instructions.
 * @return {object} {codes, warnings, classes}
 */
function detectDeclinedAccessorials(text) {
  const blob = String(text || "");
  const codes = [];
  const warnings = [];
  const classes = [];
  for (const row of DECLINE_CLASSES) {
    if (!row.re.test(blob)) continue;
    classes.push(row);
    for (const c of row.codes) codes.push(c);
    if (!warnings.includes(row.warning)) warnings.push(row.warning);
  }
  return {codes: uniqueCodes(codes), warnings, classes};
}

/**
 * @param {Array<string>} codes Current codes.
 * @param {Array<string>} declined Declined codes.
 * @return {Array<string>}
 */
function stripDeclinedCodes(codes, declined) {
  const ban = new Set(uniqueCodes(declined));
  if (!ban.size) return uniqueCodes(codes);
  return uniqueCodes(codes).filter((c) => !ban.has(c));
}

/**
 * Strip declined codes from an applyRulesToLane-style result.
 * Records dispatcher-visible appliedRules rows for each class stripped.
 * @param {object} rulesOut accessorials, accessorialsWithData, appliedRules.
 * @param {string} text Decline-scan text.
 * @param {Array<string>} [extraDeclined] Persisted declined codes.
 * @return {object}
 */
function applyDeclinedAccessorials(rulesOut, text, extraDeclined) {
  const out = rulesOut && typeof rulesOut === "object" ? {...rulesOut} : {
    accessorials: [],
    accessorialsWithData: [],
    appliedRules: [],
  };
  const detected = detectDeclinedAccessorials(text);
  const declined = uniqueCodes([
    ...detected.codes,
    ...(Array.isArray(extraDeclined) ? extraDeclined : []),
  ]);
  if (!declined.length) return out;

  const before = new Set(uniqueCodes(out.accessorials));
  const remaining = stripDeclinedCodes(out.accessorials, declined);
  const remainingSet = new Set(remaining);
  const stripped = [...before].filter((c) => !remainingSet.has(c));
  out.accessorials = remaining;

  const withData = Array.isArray(out.accessorialsWithData) ?
    out.accessorialsWithData : [];
  out.accessorialsWithData = withData.filter((row) => {
    const c = String(row && row.code || "").toUpperCase();
    return !declined.includes(c);
  });

  const applied = Array.isArray(out.appliedRules) ?
    [...out.appliedRules] : [];
  const skipIds = new Set(detected.classes.map((row) => row.ruleId));
  const kept = applied.filter((row) => {
    if (row && skipIds.has(row.ruleId)) return false;
    return true;
  });
  for (const row of detected.classes) {
    const hit = row.codes.some((c) => stripped.includes(c) || before.has(c));
    if (!hit) continue;
    kept.push({
      ruleId: row.ruleId,
      name: row.name,
      notes: row.notes,
      matchVia: "email",
    });
  }
  // Persisted declined codes with no matching email class still strip.
  if (stripped.length && !detected.classes.length) {
    kept.push({
      ruleId: "email_declined_accessorials",
      name: "Customer declined accessorials",
      notes: "Stripped " + stripped.join(", ") +
        " — customer declined these accessorials.",
      matchVia: "email",
    });
  }
  out.appliedRules = kept;
  out.customerDeclinedAccessorials = declined;
  out.extractionWarnings = detected.warnings;
  return out;
}

module.exports = {
  NO_APPOINTMENT_RE,
  NO_LIFTGATE_RE,
  NO_LIMITED_ACCESS_RE,
  DECLINE_CLASSES,
  declinesAppointmentDelivery,
  declinesLiftgate,
  declinesLimitedAccess,
  detectDeclinedAccessorials,
  stripDeclinedCodes,
  applyDeclinedAccessorials,
  uniqueCodes,
};
