/**
 * Sender-specific quote intake rules (customer attach + pallet dim defaults).
 * Match From email / domain case-insensitively; optional Cc/To participant
 * match for rules that list match.ccEmails / match.toEmails (or builtin
 * matchCcTo).
 *
 * Sources (merged, Firestore wins on same email):
 * 1. Built-in SENDER_RULES (always-on fallback)
 * 2. quoteRules docs with ruleKind "sender_customer" or match.fromEmails /
 *    match.senderEmails / match.senderDomains / match.ccEmails /
 *    match.toEmails
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
 * matchCcTo: also apply when this email appears in Cc or To (someone else
 * may be the outer From).
 * @type {Object<string, {customerName?: string, protocolOnly?: boolean,
 *   defaultDims?: {length: number, width: number, height: number},
 *   ruleId?: string, name?: string, fromNames?: Array<string>,
 *   matchCcTo?: boolean}>}
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
    matchCcTo: true,
  },
  "lfwpicking@coreforce.com": {
    customerName: "Lifeworks Technology Group",
    ruleId: "sender_lifeworks_picking",
    name: "Sender → Lifeworks Technology Group",
    fromNames: ["lifeworks picking"],
  },
  "shaya@primepackaging.com": {
    customerName: "Prime Packaging Inc",
    ruleId: "sender_shaya_jacobowitz",
    name: "Sender → Prime Packaging Inc",
    fromNames: ["shaya jacobowitz"],
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
 * Collect all emails from a To/Cc header string or array of strings.
 * @param {string|Array<string>|null|undefined} raw Header value(s).
 * @return {Array<string>} Lowercase unique emails.
 */
function extractRecipientEmails(raw) {
  const parts = Array.isArray(raw) ? raw : [raw];
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    const text = String(part || "");
    if (!text.trim()) continue;
    const re = /[\w.+-]+@[\w.-]+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const email = String(m[0]).trim().toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      out.push(email);
    }
  }
  return out;
}

/**
 * Normalize opts.cc / opts.to into email lists.
 * @param {object} [opts] {cc?, to?}.
 * @return {{cc: Array<string>, to: Array<string>}}
 */
function recipientListsFromOpts(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  return {
    cc: extractRecipientEmails(o.cc),
    to: extractRecipientEmails(o.to),
  };
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
      .concat(match.senderEmails || [])
      .concat(match.ccEmails || [])
      .concat(match.toEmails || []);
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
 * @param {object} match Match object.
 * @param {"ccEmails"|"toEmails"} key Field.
 * @return {Array<string>}
 */
function listEmailsFromMatchField(match, key) {
  const m = match && typeof match === "object" ? match : {};
  return []
      .concat(m[key] || [])
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
 * Exact From email wins over Cc/To participant and domain.
 * First active match by priority asc within each tier.
 * @param {string} from Raw From.
 * @param {Array<object>} quoteRules Active quote rules.
 * @param {object} [opts] {cc?, to?}.
 * @return {object|null}
 */
function resolveSenderRuleFromQuoteRules(from, quoteRules, opts) {
  const email = extractSenderEmail(from);
  const {cc: ccEmails, to: toEmails} = recipientListsFromOpts(opts);
  const domain = emailDomain(email);
  const list = (quoteRules || [])
      .filter((r) => r && r.active !== false && isSenderCustomerRule(r))
      .slice()
      .sort((a, b) =>
        (Number(a.priority) || 100) - (Number(b.priority) || 100));

  let domainHit = null;
  let ccHit = null;
  let toHit = null;
  for (const rule of list) {
    const emails = emailsFromMatch(rule.match);
    if (email && emails.includes(email)) {
      return senderPayloadFromQuoteRule(rule);
    }
    if (!ccHit && ccEmails.length) {
      const wantCc = listEmailsFromMatchField(rule.match, "ccEmails");
      if (wantCc.some((e) => ccEmails.includes(e))) {
        ccHit = senderPayloadFromQuoteRule(rule);
      }
    }
    if (!toHit && toEmails.length) {
      const wantTo = listEmailsFromMatchField(rule.match, "toEmails");
      if (wantTo.some((e) => toEmails.includes(e))) {
        toHit = senderPayloadFromQuoteRule(rule);
      }
    }
    if (!domainHit && domain) {
      const domains = domainsFromMatch(rule.match);
      if (domains.includes(domain)) {
        domainHit = senderPayloadFromQuoteRule(rule);
      }
    }
  }
  return ccHit || toHit || domainHit;
}

/**
 * Built-in match when From missed but email is on Cc/To and rule opts in.
 * @param {object} [opts] {cc?, to?}.
 * @return {object|null}
 */
function resolveBuiltinCcToRule(opts) {
  const {cc, to} = recipientListsFromOpts(opts);
  const recipients = [...cc, ...to];
  for (const email of recipients) {
    const builtin = SENDER_RULES[email];
    if (builtin && builtin.matchCcTo) return {...builtin};
  }
  return null;
}

/**
 * @param {string} from Raw From header.
 * @param {Array<object>} [quoteRules] Optional Firestore quoteRules.
 * @param {object} [opts] {cc?, to?} recipient headers for participant match.
 * @return {object|null} Sender rule or null.
 */
function resolveSenderRule(from, quoteRules, opts) {
  const email = extractSenderEmail(from);
  const hasRecipients = recipientListsFromOpts(opts).cc.length > 0 ||
    recipientListsFromOpts(opts).to.length > 0;

  if (email || hasRecipients) {
    const fromFs = resolveSenderRuleFromQuoteRules(
        from, quoteRules || [], opts);
    if (fromFs) return {...fromFs};
  }

  if (email) {
    const builtin = SENDER_RULES[email];
    if (builtin && typeof builtin === "object") return {...builtin};
  }

  const ccToBuiltin = resolveBuiltinCcToRule(opts);
  if (ccToBuiltin) return ccToBuiltin;

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
 * @param {object} [opts] {cc?, to?}.
 * @return {object} `{defaultDims}` or `{}`.
 */
function dimOptsForSender(from, quoteRules, opts) {
  const rule = resolveSenderRule(from, quoteRules, opts);
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
 * @param {object} [opts] {cc?, to?}.
 * @return {object}
 */
function applySenderDefaultedDimOverrides(
    extracted, from, body, quoteRules, opts) {
  const rule = resolveSenderRule(from, quoteRules, opts);
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
 * @param {object} [opts] {cc?, to?}.
 * @return {object}
 */
function applySenderCustomerOverride(extracted, from, quoteRules, opts) {
  const rule = resolveSenderRule(from, quoteRules, opts);
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
  extractRecipientEmails,
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
