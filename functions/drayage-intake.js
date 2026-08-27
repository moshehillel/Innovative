/**
 * Drayage invoice intake — Primus vendor type for the carrier name.
 * Container # is metadata only, not a route trigger.
 * Inbound → forward to Leo; Leo returns instructions → process per email
 * (never forward Leo returns back to Leo). Missing fields → email Lisa.
 */
"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const podFollowup = require("./pod-followup");

/** Leo validates drayage and returns Primus entry instructions. */
const DRAYAGE_FORWARD_EMAIL_DEFAULT = "leo@innovativecarriers.com";

/** Leo replies here after validating a drayage invoice. */
const DRAYAGE_RETURN_EMAIL_DEFAULT = "accounting@innovativecarriers.com";

/** Missing Leo instruction fields — ops contact. */
const DRAYAGE_OPS_EMAIL_DEFAULT = podFollowup.LISA_EMAIL;

/**
 * @param {string|null|undefined} value Raw container text.
 * @return {string}
 */
function normalizeContainerNumber(value) {
  return String(value || "")
      .replace(/[\s-]/g, "")
      .trim()
      .toUpperCase();
}

/**
 * ISO 6346 container id: 3-letter owner + category U/J/Z + 7 digits.
 * Rejects LTL PRO prefixes (e.g. Averitt AVRT1467163).
 * @param {string|null|undefined} value Raw container text.
 * @return {boolean}
 */
function isPlausibleContainerNumber(value) {
  const compact = normalizeContainerNumber(value);
  if (!compact) return false;
  return /^[A-Z]{3}[UJZ]\d{7}$/.test(compact);
}

/**
 * @param {string|null|undefined} value Raw container text.
 * @return {string|null} Normalized container or null.
 */
function sanitizeContainerNumber(value) {
  const compact = normalizeContainerNumber(value);
  return isPlausibleContainerNumber(compact) ? compact : null;
}

/**
 * @param {string} subject Email subject.
 * @param {string} body Email body.
 * @return {string|null}
 */
function extractContainerFromText(subject, body) {
  const text = `${subject || ""}\n${body || ""}`;
  const labeled = text.match(
      /(?:container|cntr|unit)\s*(?:#|no\.?|number)?\s*:?\s*/i +
      /([A-Z]{3,4}[\s-]?\d{6,7})/i);
  if (labeled && labeled[1]) {
    const clean = sanitizeContainerNumber(labeled[1]);
    if (clean) return clean;
  }
  const isoInline = text.match(/\b([A-Z]{4}\s?\d{7})\b/i);
  if (isoInline && isoInline[1]) {
    const clean = sanitizeContainerNumber(isoInline[1]);
    if (clean) return clean;
  }
  return null;
}

/**
 * @param {string} from From header.
 * @return {boolean}
 */
function isDrayageValidatorEmail(from) {
  const validator = String(
      process.env.DRAYAGE_VALIDATOR_EMAIL ||
      DRAYAGE_FORWARD_EMAIL_DEFAULT,
  ).trim().toLowerCase();
  const hay = String(from || "").toLowerCase();
  return hay.includes(validator);
}

/**
 * @param {object|null|undefined} item AI invoice row.
 * @return {string|null}
 */
function containerFromInvoiceItem(item) {
  if (!item || typeof item !== "object") return null;
  return sanitizeContainerNumber(item.containerNumber);
}

/**
 * @param {Array<object>} items Invoice rows from classification.
 * @return {string|null}
 */
function findContainerOnInvoiceItems(items) {
  for (const item of items || []) {
    const c = containerFromInvoiceItem(item);
    if (c) return c;
  }
  return null;
}

/**
 * @param {string|null|undefined} type Primus getVendors vendor.type value.
 * @return {boolean}
 */
function isDrayageVendorType(type) {
  const normalized = String(type || "").trim().toLowerCase();
  if (!normalized) return false;
  return normalized === "drayage" ||
    normalized.includes("dray");
}

/**
 * Looks up the Primus master vendor for an invoice carrier name.
 * @param {string|null|undefined} carrierName Invoice carrier name.
 * @param {string|null|undefined} from From header.
 * @return {Promise<object|null>}
 */
async function lookupPrimusVendor(carrierName, from) {
  try {
    const bridge = require("./primus-ui-bridge");
    if (!bridge.isManagePhpEnabled || !bridge.isManagePhpEnabled()) {
      return null;
    }
    return await bridge.lookupVendorByCarrierHint({
      carrierName,
      fromEmail: from,
    });
  } catch (_) {
    return null;
  }
}

/**
 * @param {Array<object>} items Invoice rows from classification.
 * @return {string|null}
 */
function carrierNameFromInvoiceItems(items) {
  for (const item of items || []) {
    const name = String(item && item.carrierName || "").trim();
    if (name) return name;
  }
  return null;
}

/**
 * Resolves container number from invoice rows, PDF probe, or email text.
 * @param {Array<object>} invoiceItems Classified invoice rows.
 * @param {string|null} probedContainer Container from PDF probe.
 * @param {string} subject Email subject.
 * @param {string} body Email body.
 * @return {string|null}
 */
function resolveContainerNumber(
    invoiceItems, probedContainer, subject, body) {
  return findContainerOnInvoiceItems(invoiceItems) ||
    sanitizeContainerNumber(probedContainer) ||
    extractContainerFromText(subject, body);
}

/**
 * @param {string|number|null|undefined} value Raw money text.
 * @return {number|null}
 */
function parseMoney(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {string} body Email body.
 * @param {string} subject Email subject.
 * @return {object} Parsed Leo instructions.
 */
function parseLeoReturnInstructions(body, subject) {
  const text = `${subject || ""}\n${body || ""}`;
  const loadMatch = text.match(
      /load\s*(?:#|number)?\s*:?\s*(\d{5,6})/i);
  const vendorMatch = text.match(
      /vendor\s*name\s*:?\s*([^\n]+)/i);
  const customerRateMatch = text.match(
      /customer'?s?\s*rate\s*(?:should be)?\s*:?\s*\$?\s*([\d,]+\.?\d*)/i);

  const charges = [];
  const chargeBlock = text.match(
      /charges[\s\S]*?(?=customer'?s?\s*rate|$)/i);
  const chargeText = chargeBlock ? chargeBlock[0] : text;
  const chargeLines = chargeText.split(/\n/);
  for (const line of chargeLines) {
    const m = line.match(
        /^[\s\-•*]*(.+?)\s*:?\s*\$?\s*([\d,]+\.\d{2})\s*$/);
    if (!m) continue;
    const description = String(m[1]).trim()
        .replace(/^[-•*]+\s*/, "");
    if (!description || /^(charges|enter in primus)/i.test(description)) {
      continue;
    }
    const amount = parseMoney(m[2]);
    if (amount == null) continue;
    charges.push({description, amount});
  }

  let carrierTotal = null;
  const totalMatch = text.match(
      /(?:carrier|invoice|total)\s*(?:amount|total)?\s*:?\s*\$?\s*/i +
      /([\d,]+\.?\d*)/i);
  if (totalMatch) carrierTotal = parseMoney(totalMatch[1]);
  if (carrierTotal == null && charges.length) {
    carrierTotal = charges.reduce((s, c) => s + Number(c.amount || 0), 0);
  }

  return {
    loadNumber: loadMatch ? String(loadMatch[1]).trim() : null,
    vendorName: vendorMatch ? String(vendorMatch[1]).trim() : null,
    customerRate: customerRateMatch ? parseMoney(customerRateMatch[1]) : null,
    charges,
    carrierTotal,
    containerNumber: extractContainerFromText(subject, body),
    rawText: text.slice(0, 4000),
  };
}

/**
 * @param {string} body Email body.
 * @param {string} subject Email subject.
 * @return {Promise<object|null>}
 */
async function parseLeoReturnInstructionsWithAi(body, subject) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const text = `${subject || ""}\n${body || ""}`.trim();
  if (!text) return null;

  const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      system: "Extract drayage Primus entry instructions from Leo's email. " +
        "Return ONLY valid JSON matching requiredJsonShape.",
      messages: [{
        role: "user",
        content: JSON.stringify({
          task: "Parse Leo's validated drayage invoice reply for Primus entry.",
          emailText: text.slice(0, 8000),
          rules: [
            "loadNumber is the 5-6 digit Primus broker load #.",
            "vendorName is the carrier/vendor to enter in Primus.",
            "customerRate is the customer sell rate in dollars.",
            "charges is an array of {description, amount} for each line " +
            "to enter in Primus (use Leo's exact charge names).",
            "carrierTotal is sum of carrier charges if stated.",
            "containerNumber when present.",
            "Use null for missing fields — do not guess.",
          ],
          requiredJsonShape: {
            loadNumber: "",
            vendorName: "",
            customerRate: 0,
            carrierTotal: 0,
            containerNumber: "",
            charges: [{description: "", amount: 0}],
          },
        }),
      }],
    });
    const out = (response.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    const jsonMatch = out.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      loadNumber: parsed.loadNumber ?
        String(parsed.loadNumber).trim() : null,
      vendorName: parsed.vendorName ?
        String(parsed.vendorName).trim() : null,
      customerRate: parseMoney(parsed.customerRate),
      carrierTotal: parseMoney(parsed.carrierTotal),
      containerNumber: sanitizeContainerNumber(parsed.containerNumber),
      charges: (Array.isArray(parsed.charges) ? parsed.charges : [])
          .map((c) => ({
            description: String(c.description || "").trim(),
            amount: parseMoney(c.amount),
          }))
          .filter((c) => c.description && c.amount != null),
      rawText: text.slice(0, 4000),
    };
  } catch (_) {
    return null;
  }
}

/**
 * @param {string} body Email body.
 * @param {string} subject Email subject.
 * @return {Promise<object>} Same shape, enriched via AI when regex is thin.
 */
async function resolveLeoReturnInstructions(body, subject) {
  let parsed = parseLeoReturnInstructions(body, subject);
  const thin = !parsed.loadNumber || !parsed.vendorName ||
    !parsed.customerRate || !parsed.charges.length;
  if (thin) {
    const ai = await parseLeoReturnInstructionsWithAi(body, subject);
    if (ai) {
      parsed = {
        loadNumber: parsed.loadNumber || ai.loadNumber,
        vendorName: parsed.vendorName || ai.vendorName,
        customerRate: parsed.customerRate ?? ai.customerRate,
        carrierTotal: parsed.carrierTotal ?? ai.carrierTotal,
        containerNumber: parsed.containerNumber || ai.containerNumber,
        charges: parsed.charges.length ? parsed.charges : ai.charges,
        rawText: parsed.rawText || ai.rawText,
      };
    }
  }
  if (parsed.carrierTotal == null && parsed.charges.length) {
    parsed.carrierTotal = parsed.charges.reduce(
        (s, c) => s + Number(c.amount || 0), 0);
  }
  return parsed;
}

/** Required fields Leo must include for Jerry to process. */
const LEO_REQUIRED_FIELDS = [
  "loadNumber",
  "vendorName",
  "customerRate",
  "charges",
];

/**
 * @param {object} parsed Parsed Leo instructions.
 * @return {object} {ok, missingFields}
 */
function validateLeoInstructions(parsed) {
  const missing = [];
  if (!parsed || !parsed.loadNumber) missing.push("loadNumber");
  if (!parsed || !parsed.vendorName) missing.push("vendorName");
  if (!parsed || parsed.customerRate == null || parsed.customerRate <= 0) {
    missing.push("customerRate");
  }
  if (!parsed || !Array.isArray(parsed.charges) ||
      !parsed.charges.length) {
    missing.push("charges");
  }
  return {ok: missing.length === 0, missingFields: missing};
}

/**
 * @param {Array<string>} missingFields Field keys.
 * @return {string} Human-readable list for Lisa.
 */
function formatMissingLeoFields(missingFields) {
  const labels = {
    loadNumber: "Load number",
    vendorName: "Vendor name",
    customerRate: "Customer rate",
    charges: "Charge line items (description + amount)",
    invoicePdf: "Carrier invoice PDF attachment",
  };
  return (missingFields || [])
      .map((f) => labels[f] || f)
      .join(", ");
}

/**
 * @param {object|null|undefined} item AI invoice row.
 * @param {object} leo Parsed Leo instructions.
 * @return {object}
 */
function applyLeoInstructionsToInvoiceItem(item, leo) {
  const out = {...(item || {})};
  if (leo.loadNumber) out.loadNumber = leo.loadNumber;
  if (leo.vendorName) out.carrierName = leo.vendorName;
  if (leo.customerRate != null) out.customerRate = leo.customerRate;
  if (leo.carrierTotal != null) out.invoiceAmount = leo.carrierTotal;
  if (leo.containerNumber) out.containerNumber = leo.containerNumber;
  if (Array.isArray(leo.charges) && leo.charges.length) {
    out.charges = leo.charges.map((c) => ({
      description: c.description,
      amount: c.amount,
    }));
    out.recognizedCharges = [];
    out.unrecognizedCharges = leo.charges.map((c) => ({
      description: c.description,
      amount: c.amount,
    }));
  }
  out.drayageLeoValidated = true;
  out.leoDrayageInstructions = leo;
  out.loadNumberSource = "leo_drayage_instructions";
  out.status = out.status || "ready_for_primus_validation";
  return out;
}

/**
 * Note Jerry sends to Leo with the reply template.
 * @param {object} [opts] containerNumber, carrierName.
 * @return {string}
 */
function buildLeoForwardNotes(opts = {}) {
  const returnTo = String(
      process.env.DRAYAGE_RETURN_EMAIL ||
      DRAYAGE_RETURN_EMAIL_DEFAULT,
  ).trim();
  const containerLine = opts.containerNumber ?
    `\n(Container #: ${opts.containerNumber})` : "";
  const carrierLine = opts.carrierName ?
    `\nCarrier on invoice: ${opts.carrierName}` : "";
  return (
    `Hi Leo,\n\n` +
    `See attached — drayage invoice.${containerLine}${carrierLine}\n\n` +
    `When you're done validating, please reply to ${returnTo} ` +
    `using this format:\n\n` +
    `---\n` +
    `Hi,\n\n` +
    `This invoice is for load number: [6-digit Primus load #]\n\n` +
    `Enter in Primus:\n` +
    `Vendor name: [carrier / vendor name]\n\n` +
    `Charges (use these descriptions in Primus):\n` +
    `- [Charge description]: $[amount]\n` +
    `- [Charge description]: $[amount]\n\n` +
    `Customer rate should be: $[amount]\n` +
    `---\n\n` +
    `Thank you,\n` +
    `Jerry`
  );
}

/**
 * Scans statement / paperwork PDFs when no freight invoice was classified.
 * @param {Array<object>} pdfAttachments Attachments with buffer + filename.
 * @return {Promise<string|null>}
 */
async function probeContainerOnPdfs(pdfAttachments) {
  const pdfs = (pdfAttachments || []).filter(
      (a) => a && a.buffer && a.buffer.length);
  if (!pdfs.length || !process.env.ANTHROPIC_API_KEY) return null;

  const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
  const contentBlocks = pdfs.slice(0, 3).map((att) => ({
    type: "document",
    source: {
      type: "base64",
      media_type: "application/pdf",
      data: att.buffer.toString("base64"),
    },
    title: att.filename || "document.pdf",
  }));
  contentBlocks.push({
    type: "text",
    text: JSON.stringify({
      task: "Find the intermodal/ocean container number on these documents.",
      rules: [
        "Look for ISO 6346 intermodal/ocean container numbers only.",
        "Look for Container #, Container No, CNTR, Unit #, or similar labels.",
        "ISO 6346 is 3 letters + U/J/Z + 7 digits (e.g. MSCU1234567).",
        "Do not treat LTL PRO numbers (e.g. Averitt AVRT########) as containers.",
        "A container number does not mean the shipment is drayage.",
        "Return containerNumber as empty string when none is present.",
      ],
      requiredJsonShape: {containerNumber: ""},
    }),
  });

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 256,
      system: "Return ONLY valid JSON matching requiredJsonShape. No markdown.",
      messages: [{role: "user", content: contentBlocks}],
    });
    const text = (response.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    return sanitizeContainerNumber(parsed.containerNumber);
  } catch (_) {
    return null;
  }
}

/**
 * @param {string} from From header.
 * @param {Array<object>} invoiceItems Classified invoice rows.
 * @param {string|null} probedContainer Container from PDF probe.
 * @param {string} subject Email subject.
 * @param {string} body Email body.
 * @return {string|null} Container number metadata (not a routing signal).
 */
function resolveInboundDrayageContainer(
    from, invoiceItems, probedContainer, subject, body) {
  if (isDrayageValidatorEmail(from)) return null;
  return resolveContainerNumber(
      invoiceItems, probedContainer, subject, body);
}

/**
 * Classifies inbound freight as drayage from the Primus vendor for that
 * carrier name. Container numbers never trigger routing.
 *
 * @param {object} args from, invoiceItems, probedContainer, subject, body,
 *   lookupVendor (optional test inject).
 * @return {Promise<object>} {isDrayage, reason, containerNumber, carrierName,
 *   vendorType, primusVendorId}
 */
async function resolveInboundDrayageSignal(args) {
  const {
    from, invoiceItems, probedContainer, subject, body, lookupVendor,
  } = args || {};
  if (isDrayageValidatorEmail(from)) {
    return {isDrayage: false};
  }

  const carrierName = carrierNameFromInvoiceItems(invoiceItems);
  const containerNumber = resolveContainerNumber(
      invoiceItems, probedContainer, subject, body);

  const lookup = typeof lookupVendor === "function" ?
    lookupVendor : lookupPrimusVendor;
  let vendor = null;
  try {
    vendor = await lookup(carrierName, from);
  } catch (_) {
    vendor = null;
  }

  const vendorType = vendor && vendor.type || null;
  if (vendor && isDrayageVendorType(vendorType)) {
    return {
      isDrayage: true,
      reason: `Drayage invoice — Primus vendor ` +
        `${vendor.name || carrierName} (${vendorType})`,
      containerNumber,
      carrierName: carrierName || vendor.name || null,
      vendorType,
      primusVendorId: vendor.id || null,
      drayageByVendorType: true,
    };
  }

  return {
    isDrayage: false,
    carrierName,
    vendorType,
    containerNumber,
    primusVendorId: vendor && vendor.id || null,
  };
}

module.exports = {
  DRAYAGE_FORWARD_EMAIL_DEFAULT,
  DRAYAGE_RETURN_EMAIL_DEFAULT,
  DRAYAGE_OPS_EMAIL_DEFAULT,
  LEO_REQUIRED_FIELDS,
  normalizeContainerNumber,
  isPlausibleContainerNumber,
  sanitizeContainerNumber,
  extractContainerFromText,
  isDrayageValidatorEmail,
  containerFromInvoiceItem,
  findContainerOnInvoiceItems,
  isDrayageVendorType,
  carrierNameFromInvoiceItems,
  resolveContainerNumber,
  parseLeoReturnInstructions,
  parseLeoReturnInstructionsWithAi,
  resolveLeoReturnInstructions,
  validateLeoInstructions,
  formatMissingLeoFields,
  applyLeoInstructionsToInvoiceItem,
  buildLeoForwardNotes,
  probeContainerOnPdfs,
  resolveInboundDrayageContainer,
  resolveInboundDrayageSignal,
};
