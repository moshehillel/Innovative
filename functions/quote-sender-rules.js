/**
 * Sender-specific quote intake rules (customer attach + pallet dim defaults).
 * Match From email / domain case-insensitively.
 *
 * Sources (merged, Firestore wins on same email):
 * 1. Built-in SENDER_RULES (always-on fallback)
 * 2. quoteRules docs with ruleKind "sender_customer" or match.fromEmails /
 *    match.senderEmails / match.senderDomains
 *
 * Global pallet default remains 40×48×60 unless a sender rule sets defaultDims.
 */

"use strict";

const {
  STANDARD_PALLET_LENGTH,
  STANDARD_PALLET_WIDTH,
  DEFAULT_PALLET_HEIGHT,
} = require("./quote-freight-dims");

/**
 * Map of normalized From email → rule.
 * defaultDims only fill missing L/W/H (and may replace AI-invented global
 * 40×48×60 when the email body has no explicit height).
 * @type {Object<string, {customerName?: string, protocolOnly?: boolean,
 *   defaultDims?: {length: number, width: number, height: number},
 *   ruleId?: string, name?: string}>}
 */
const SENDER_RULES = {
  "jared.berman@corehome.com": {
    customerName: "Brumis Imports Inc",
    defaultDims: {length: 40, width: 48, height: 62},
    ruleId: "sender_jared_berman",
    name: "Sender → Brumis Imports Inc",
    fromNames: ["jared berman"],
  },
  "mike.oseback@ediexpressinc.com": {
    customerName: "Mike Oseback",
    protocolOnly: true,
    ruleId: "sender_mike_oseback",
    name: "Sender → Mike Oseback",
    fromNames: ["mike oseback"],
  },
};

/** Internal / mailbox domains that FW RFQs through (not the real shipper). */
const INTERNAL_SENDER_DOMAINS = new Set([
  "innovativecarriers.com",
]);

/**
 * Extract a bare email from a From header / display string.
 * @param {string} from Raw From.
 * @return {string} Lowercase email or "".
 */
function extractSenderEmail(from) {
  const raw = String(from || "").trim();
  if (!raw) return "";
  const angle = raw.match(/<([^>]+@[^>]+)>/);
  if (angle) return String(angle[1]).trim().toLowerCase();
  const bare = raw.match(/[\w.+-]+@[\w.-]+/);
  return bare ? String(bare[0]).trim().toLowerCase() : "";
}

/**
 * True when From is an Innovative mailbox (FW / quotes inbox), not the RFQ
 * customer.
 * @param {string} from Raw From.
 * @return {boolean}
 */
function isInternalMailboxFrom(from) {
  const email = extractSenderEmail(from);
  if (!email) return false;
  const domain = emailDomain(email);
  return INTERNAL_SENDER_DOMAINS.has(domain);
}

/**
 * Pull the first embedded Outlook/Gmail "From: Name <email>" line from a
 * forwarded RFQ body (skips internal Innovative addresses).
 * Also recovers known sender names when the address was stripped from plain
 * text (`From: Jared Berman` without `<email>`).
 * @param {string} body Email body.
 * @return {string} Raw From display string or "".
 */
function extractEmbeddedSenderFromBody(body) {
  const text = String(body || "");
  if (!text.trim()) return "";

  // Prefer any known sender email that still appears in the body.
  const lower = text.toLowerCase();
  for (const email of Object.keys(SENDER_RULES)) {
    if (lower.includes(email)) return email;
  }

  const re = /(?:^|\n)\s*From\s*:\s*(.+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = String(m[1] || "").trim();
    if (!raw) continue;
    // Drop trailing "Sent:" / "To:" crumbs on the same line.
    const cleaned = raw
        .replace(/\s+Sent\s*:.*$/i, "")
        .replace(/\s+To\s*:.*$/i, "")
        .trim();
    const email = extractSenderEmail(cleaned);
    if (email && !isInternalMailboxFrom(cleaned)) {
      return cleaned.includes("<") ? cleaned : email;
    }
    // Name-only FW header → known sender map.
    const nameKey = cleaned
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    if (!nameKey) continue;
    for (const [ruleEmail, rule] of Object.entries(SENDER_RULES)) {
      const names = (rule && rule.fromNames) || [];
      if (names.some((n) => nameKey === String(n).toLowerCase() ||
        nameKey.startsWith(String(n).toLowerCase() + " "))) {
        return ruleEmail;
      }
    }
  }
  return "";
}

/**
 * Effective RFQ sender for sender→customer rules.
 * Prefer outer From when it is the real customer; for Innovative FW
 * mailboxes, use the embedded original From in the body.
 * @param {string} from Outer From header.
 * @param {string} [body] Email body (may include FW headers).
 * @return {string} From string to use for sender rules.
 */
function resolveQuoteSenderFrom(from, body) {
  const outer = String(from || "").trim();
  const outerEmail = extractSenderEmail(outer);
  if (outerEmail && !isInternalMailboxFrom(outer)) return outer;
  const embedded = extractEmbeddedSenderFromBody(body);
  if (embedded) return embedded;
  return outer;
}

/**
 * @param {string} email Lowercase email.
 * @return {string} Domain without leading @, or "".
 */
function emailDomain(email) {
  const e = String(email || "").toLowerCase();
  const at = e.lastIndexOf("@");
  return at >= 0 ? e.slice(at + 1) : "";
}

/**
 * Normalize domain needles (`@foo.com`, `foo.com` → `foo.com`).
 * @param {string} raw Domain.
 * @return {string}
 */
function normalizeDomainNeedle(raw) {
  return String(raw || "").trim().toLowerCase().replace(/^@+/, "");
}

/**
 * True when a quoteRules doc is a sender→customer mapping rule.
 * @param {object} rule Rule document.
 * @return {boolean}
 */
function isSenderCustomerRule(rule) {
  if (!rule || typeof rule !== "object") return false;
  if (rule.ruleKind === "sender_customer") return true;
  const match = rule.match && typeof rule.match === "object" ? rule.match : {};
  const emails = []
      .concat(match.fromEmails || [])
      .concat(match.senderEmails || []);
  const domains = [].concat(match.senderDomains || []);
  return emails.some((e) => String(e || "").includes("@")) ||
    domains.some((d) => !!normalizeDomainNeedle(d));
}

/**
 * Convert a Firestore quoteRules doc into a resolved sender rule payload.
 * @param {object} rule Quote rule doc.
 * @return {object|null}
 */
function senderPayloadFromQuoteRule(rule) {
  if (!isSenderCustomerRule(rule) || rule.active === false) return null;
  const customerName = String(rule.customerName || "").trim();
  const defaultDims = rule.defaultDims && typeof rule.defaultDims === "object" ?
    {
      length: Number(rule.defaultDims.length) || undefined,
      width: Number(rule.defaultDims.width) || undefined,
      height: Number(rule.defaultDims.height) || undefined,
    } : null;
  const dims = defaultDims &&
    (defaultDims.length || defaultDims.width || defaultDims.height) ?
    defaultDims : null;
  if (!customerName && !dims) return null;
  return {
    customerName: customerName || undefined,
    protocolOnly: !!rule.protocolOnly,
    defaultDims: dims || undefined,
    ruleId: rule.id ? String(rule.id) : undefined,
    name: rule.name ? String(rule.name) : undefined,
  };
}

/**
 * Collect fromEmails / senderEmails from a rule match.
 * @param {object} match Match object.
 * @return {Array<string>} Lowercase emails.
 */
function emailsFromMatch(match) {
  const m = match && typeof match === "object" ? match : {};
  return []
      .concat(m.fromEmails || [])
      .concat(m.senderEmails || [])
      .map((e) => String(e || "").trim().toLowerCase())
      .filter((e) => e.includes("@"));
}

/**
 * Collect senderDomains from a rule match.
 * @param {object} match Match object.
 * @return {Array<string>} Lowercase domains without @.
 */
function domainsFromMatch(match) {
  const m = match && typeof match === "object" ? match : {};
  return []
      .concat(m.senderDomains || [])
      .map(normalizeDomainNeedle)
      .filter(Boolean);
}

/**
 * Match a From address against a list of quoteRules (sender_customer).
 * Exact email wins over domain. First active match by priority asc.
 * @param {string} from Raw From.
 * @param {Array<object>} quoteRules Active quote rules.
 * @return {object|null}
 */
function resolveSenderRuleFromQuoteRules(from, quoteRules) {
  const email = extractSenderEmail(from);
  if (!email) return null;
  const domain = emailDomain(email);
  const list = (quoteRules || [])
      .filter((r) => r && r.active !== false && isSenderCustomerRule(r))
      .slice()
      .sort((a, b) =>
        (Number(a.priority) || 100) - (Number(b.priority) || 100));

  let domainHit = null;
  for (const rule of list) {
    const emails = emailsFromMatch(rule.match);
    if (emails.includes(email)) {
      return senderPayloadFromQuoteRule(rule);
    }
    if (!domainHit && domain) {
      const domains = domainsFromMatch(rule.match);
      if (domains.includes(domain)) {
        domainHit = senderPayloadFromQuoteRule(rule);
      }
    }
  }
  return domainHit;
}

/**
 * @param {string} from Raw From header.
 * @param {Array<object>} [quoteRules] Optional Firestore quoteRules.
 * @return {object|null} Sender rule or null.
 */
function resolveSenderRule(from, quoteRules) {
  const email = extractSenderEmail(from);
  if (!email) return null;

  const fromFs = resolveSenderRuleFromQuoteRules(from, quoteRules || []);
  if (fromFs) return {...fromFs};

  const builtin = SENDER_RULES[email];
  if (builtin && typeof builtin === "object") return {...builtin};

  // Built-in domain fallbacks are not used — only exact builtins + FS domains.
  return null;
}

/**
 * True when the RFQ body includes an explicit L×W×H or height value.
 * @param {string} body Email body.
 * @return {boolean}
 */
function bodyHasExplicitPalletHeight(body) {
  const text = String(body || "");
  if (/\b\d{2}\s*[x×*]\s*\d{2}\s*[x×*]\s*\d{2,3}\b/i.test(text)) {
    return true;
  }
  if (/\b(?:height|hgt|ht)\s*[:=]?\s*\d{2,3}\b/i.test(text)) return true;
  return false;
}

/**
 * Dim opts for normalizePalletDims / normalizePalletFreightRows.
 * @param {string} from Raw From.
 * @param {Array<object>} [quoteRules] Optional Firestore rules.
 * @return {object} `{defaultDims}` or `{}`.
 */
function dimOptsForSender(from, quoteRules) {
  const rule = resolveSenderRule(from, quoteRules);
  if (!rule || !rule.defaultDims) return {};
  return {defaultDims: {...rule.defaultDims}};
}

/**
 * Replace AI-invented global 40×48×60 with sender defaults when the body
 * never stated a height. Explicit body heights / dims are left alone.
 * @param {object} extracted Intake payload.
 * @param {string} from Raw From.
 * @param {string} body Email body.
 * @param {Array<object>} [quoteRules] Optional Firestore rules.
 * @return {object}
 */
function applySenderDefaultedDimOverrides(extracted, from, body, quoteRules) {
  const rule = resolveSenderRule(from, quoteRules);
  if (!rule || !rule.defaultDims || !extracted ||
      !Array.isArray(extracted.lanes)) {
    return extracted;
  }
  if (bodyHasExplicitPalletHeight(body)) return extracted;
  const d = rule.defaultDims;
  const wantL = Number(d.length) || STANDARD_PALLET_LENGTH;
  const wantW = Number(d.width) || STANDARD_PALLET_WIDTH;
  const wantH = Number(d.height);
  if (!(wantH > 0) || wantH === DEFAULT_PALLET_HEIGHT) return extracted;

  for (const lane of extracted.lanes) {
    if (!lane || !Array.isArray(lane.freightInfo)) continue;
    lane.freightInfo = lane.freightInfo.map((row) => {
      if (!row || typeof row !== "object") return row;
      const L = Number(row.length);
      const W = Number(row.width);
      const H = Number(row.height);
      const isGlobalDefault =
        L === STANDARD_PALLET_LENGTH &&
        W === STANDARD_PALLET_WIDTH &&
        H === DEFAULT_PALLET_HEIGHT;
      if (!isGlobalDefault) return row;
      return {...row, length: wantL, width: wantW, height: wantH};
    });
  }
  return extracted;
}

/**
 * Force customerName / shippingLocationName from sender rule when set.
 * @param {object} extracted Intake payload.
 * @param {string} from Raw From.
 * @param {Array<object>} [quoteRules] Optional Firestore rules.
 * @return {object}
 */
function applySenderCustomerOverride(extracted, from, quoteRules) {
  const rule = resolveSenderRule(from, quoteRules);
  if (!rule || !rule.customerName || !extracted ||
      typeof extracted !== "object") {
    return extracted;
  }
  const name = String(rule.customerName).trim();
  if (!name) return extracted;
  extracted.customerName = name;
  extracted.shippingLocationName = name;
  if (rule.protocolOnly) {
    extracted.senderProtocolOnly = true;
  }
  if (rule.ruleId) {
    extracted.senderRuleId = String(rule.ruleId);
  }
  return extracted;
}

module.exports = {
  SENDER_RULES,
  INTERNAL_SENDER_DOMAINS,
  extractSenderEmail,
  emailDomain,
  isInternalMailboxFrom,
  extractEmbeddedSenderFromBody,
  resolveQuoteSenderFrom,
  isSenderCustomerRule,
  senderPayloadFromQuoteRule,
  resolveSenderRuleFromQuoteRules,
  resolveSenderRule,
  bodyHasExplicitPalletHeight,
  dimOptsForSender,
  applySenderDefaultedDimOverrides,
  applySenderCustomerOverride,
};
