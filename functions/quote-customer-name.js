/**
 * Customer / bill-to name helpers for quote intake + Primus lookup.
 * Never treat an email local-part (before @) as a company name.
 */

"use strict";

/** Consumer / freemail hosts — never use as company names. */
const FREEMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "hotmail.com",
  "hotmail.co.uk",
  "outlook.com",
  "outlook.co.uk",
  "live.com",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "mail.com",
  "email.com",
  "gmx.com",
  "gmx.net",
  "yandex.com",
  "yandex.ru",
  "zoho.com",
  "hey.com",
  "fastmail.com",
  "tutanota.com",
  "comcast.net",
  "verizon.net",
  "att.net",
  "sbcglobal.net",
]);

/**
 * Broker / mailbox domains — never invent customerName from these.
 * FW RFQs through quotes@innovativecarriers.com must not become
 * "Innovativecarriers" in Primus lookup.
 */
const INTERNAL_COMPANY_DOMAINS = new Set([
  "innovativecarriers.com",
]);

/** Brand stems that must never become customerName. */
const FREEMAIL_BRANDS = new Set([
  "gmail",
  "googlemail",
  "yahoo",
  "ymail",
  "hotmail",
  "outlook",
  "live",
  "msn",
  "aol",
  "icloud",
  "me",
  "mac",
  "protonmail",
  "proton",
  "pm",
  "mail",
  "email",
  "gmx",
  "yandex",
  "zoho",
  "hey",
  "fastmail",
  "tutanota",
  "comcast",
  "verizon",
  "att",
  "sbcglobal",
]);

const SKIP_DOMAIN_LABELS = new Set([
  "www", "mail", "email", "smtp", "mx", "webmail", "inbox",
]);

const MULTI_PART_TLDS = new Set([
  "co.uk", "com.au", "co.nz", "com.br", "co.jp", "com.mx",
  "co.in", "com.sg", "co.za", "com.hk", "org.uk", "net.au",
]);

/**
 * @param {string} value Raw text.
 * @return {string}
 */
function nameKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Bounded Levenshtein distance (returns maxDist+1 when exceeded).
 * @param {string} a Left.
 * @param {string} b Right.
 * @param {number} [maxDist] Cap.
 * @return {number}
 */
function editDistance(a, b, maxDist = 2) {
  const s = String(a || "");
  const t = String(b || "");
  if (Math.abs(s.length - t.length) > maxDist) return maxDist + 1;
  const rows = s.length + 1;
  const cols = t.length + 1;
  const prev = new Array(cols);
  const cur = new Array(cols);
  for (let j = 0; j < cols; j++) prev[j] = j;
  for (let i = 1; i < rows; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j < cols; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
    for (let j = 0; j < cols; j++) prev[j] = cur[j];
  }
  return prev[t.length];
}

/**
 * Parse address + domain from a From header or bare email.
 * @param {string} from From header or email.
 * @return {{email: string, local: string, domain: string, displayName: string}}
 */
function parseSenderEmail(from) {
  const raw = String(from || "").trim();
  const angle = raw.match(/<([^>]+@[^>]+)>/);
  const bare = raw.match(/([\w.+-]+@[\w.-]+\.[a-z]{2,})/i);
  const email = String(
      (angle && angle[1]) || (bare && bare[1]) || "").trim().toLowerCase();
  const at = email.indexOf("@");
  const local = at > 0 ? email.slice(0, at) : "";
  const domain = at > 0 ? email.slice(at + 1) : "";
  let displayName = "";
  if (angle) {
    displayName = raw.slice(0, raw.indexOf("<"))
        .replace(/^["'\s]+|["'\s]+$/g, "");
  }
  return {email, local, domain, displayName};
}

/**
 * @param {string} domain Host after @.
 * @return {boolean}
 */
function isFreemailDomain(domain) {
  const d = String(domain || "").toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!d) return false;
  if (FREEMAIL_DOMAINS.has(d)) return true;
  const parts = d.split(".").filter(Boolean);
  if (parts.length >= 2) {
    const last2 = parts.slice(-2).join(".");
    if (FREEMAIL_DOMAINS.has(last2)) return true;
  }
  if (parts.length >= 3) {
    const last3 = parts.slice(-3).join(".");
    if (FREEMAIL_DOMAINS.has(last3)) return true;
  }
  return false;
}

/**
 * True for Innovative mailbox / broker domains (not the RFQ customer).
 * @param {string} domain Host after @.
 * @return {boolean}
 */
function isInternalCompanyDomain(domain) {
  const d = String(domain || "").toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!d) return false;
  if (INTERNAL_COMPANY_DOMAINS.has(d)) return true;
  const parts = d.split(".").filter(Boolean);
  if (parts.length >= 2) {
    const last2 = parts.slice(-2).join(".");
    if (INTERNAL_COMPANY_DOMAINS.has(last2)) return true;
  }
  return false;
}

/**
 * Domains that must never supply a Primus customer-name guess.
 * @param {string} domain Host after @.
 * @return {boolean}
 */
function isNonCustomerEmailDomain(domain) {
  return isFreemailDomain(domain) || isInternalCompanyDomain(domain);
}

/**
 * @param {string} name Candidate company name.
 * @return {boolean}
 */
function isFreemailBrandName(name) {
  const key = nameKey(name);
  return !!(key && FREEMAIL_BRANDS.has(key));
}

/**
 * True when name is only the Innovative broker brand (not a real RFQ
 * customer guessed from quotes@ / aron@innovativecarriers.com).
 * @param {string} name Candidate.
 * @return {boolean}
 */
function isInternalBrokerBrandName(name) {
  const key = nameKey(name);
  return key === "innovativecarriers" || key === "innovativecarrier";
}

/**
 * Org label for Primus / display (acme.com → acme, mail.acme.com → acme).
 * @param {string} domain Host after @.
 * @return {string}
 */
function registrableOrgStem(domain) {
  let parts = String(domain || "").toLowerCase().split(".")
      .filter(Boolean);
  while (parts.length > 2 && SKIP_DOMAIN_LABELS.has(parts[0])) {
    parts = parts.slice(1);
  }
  if (parts.length < 2) return "";
  const last2 = parts.slice(-2).join(".");
  if (MULTI_PART_TLDS.has(last2) && parts.length >= 3) {
    return parts[parts.length - 3] || "";
  }
  return parts[parts.length - 2] || "";
}

/**
 * Title-case a domain stem for display (acme → Acme).
 * @param {string} stem Domain label.
 * @return {string}
 */
function titleCaseStem(stem) {
  return String(stem || "")
      .replace(/[-_]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
}

/**
 * True when name looks derived from the mailbox local-part.
 * Catches gershon@… → "Gerson" / "Gershon".
 * @param {string} name Candidate.
 * @param {string} fromOrEmail From header or email.
 * @return {boolean}
 */
function isNameFromEmailLocalPart(name, fromOrEmail) {
  const rawName = String(name || "").trim();
  if (!rawName || /@/.test(rawName)) return false;
  const {local} = parseSenderEmail(fromOrEmail);
  if (!local) return false;
  const n = nameKey(rawName);
  const l = nameKey(local);
  if (!n || n.length < 3 || !l || l.length < 3) return false;
  if (n === l) return true;
  if (Math.abs(n.length - l.length) <= 2 && editDistance(n, l, 1) <= 1) {
    return true;
  }
  const bits = String(local).toLowerCase().split(/[._+-]+/)
      .map(nameKey).filter((b) => b.length >= 3);
  if (bits.length >= 2 && n === bits.join("")) return true;
  if (bits.length >= 1 && bits[0].length >= 4 && n === bits[0]) return true;
  return false;
}

/**
 * Company guess from email domain only (never freemail / internal / local-part).
 * @param {string} fromOrEmail From header or email.
 * @return {string}
 */
function customerNameFromEmailDomain(fromOrEmail) {
  const {domain} = parseSenderEmail(fromOrEmail);
  if (!domain || isNonCustomerEmailDomain(domain)) return "";
  const stem = registrableOrgStem(domain);
  if (!stem || stem.length < 3) return "";
  if (FREEMAIL_BRANDS.has(nameKey(stem))) return "";
  return titleCaseStem(stem);
}

/**
 * True when this string must not be used as customerName.
 * @param {string} name Candidate.
 * @param {string} fromOrEmail From header or email.
 * @return {boolean}
 */
function isUnusableCustomerName(name, fromOrEmail) {
  const s = String(name || "").trim();
  if (!s) return true;
  if (isFreemailBrandName(s)) return true;
  if (isNameFromEmailLocalPart(s, fromOrEmail)) return true;
  // "Innovativecarriers" from our own mailbox domain is never the bill-to.
  if (isInternalBrokerBrandName(s)) {
    const {domain} = parseSenderEmail(fromOrEmail);
    if (!domain || isInternalCompanyDomain(domain)) return true;
  }
  return false;
}

/**
 * First usable customer name, else domain org label, else "".
 * @param {string} fromOrEmail From header or email.
 * @param {...string} candidates Preferred names.
 * @return {string}
 */
function pickUsableCustomerName(fromOrEmail, ...candidates) {
  for (const c of candidates) {
    const s = String(c || "").trim();
    if (!s) continue;
    if (isUnusableCustomerName(s, fromOrEmail)) continue;
    return s;
  }
  return customerNameFromEmailDomain(fromOrEmail) || "";
}

/**
 * Clear local-part / freemail customerName; optionally fill from domain.
 * Does not touch sender-rule overrides (call before those).
 * @param {object} extracted Intake payload (mutated).
 * @param {string} from From header or email.
 * @return {object}
 */
function sanitizeExtractedCustomerName(extracted, from) {
  if (!extracted || typeof extracted !== "object") return extracted;
  const fromStr = String(from || "");
  let name = String(extracted.customerName || "").trim();
  let loc = String(extracted.shippingLocationName || "").trim();

  if (name && isUnusableCustomerName(name, fromStr)) {
    extracted.customerName = null;
    name = "";
  }
  if (loc && isUnusableCustomerName(loc, fromStr)) {
    extracted.shippingLocationName = null;
    loc = "";
  }

  if (!name && !loc) {
    const fromDomain = customerNameFromEmailDomain(fromStr);
    if (fromDomain) {
      extracted.customerName = fromDomain;
    }
  }
  return extracted;
}

module.exports = {
  FREEMAIL_DOMAINS,
  INTERNAL_COMPANY_DOMAINS,
  parseSenderEmail,
  isFreemailDomain,
  isInternalCompanyDomain,
  isNonCustomerEmailDomain,
  isFreemailBrandName,
  isInternalBrokerBrandName,
  registrableOrgStem,
  titleCaseStem,
  isNameFromEmailLocalPart,
  customerNameFromEmailDomain,
  isUnusableCustomerName,
  pickUsableCustomerName,
  sanitizeExtractedCustomerName,
};
