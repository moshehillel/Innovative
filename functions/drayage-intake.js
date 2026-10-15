/**
 * Drayage invoice intake — Primus vendor type for the invoice carrier name
 * ONLY. Email text ("drayage invoice"), container #s, Loup/UP/intermodal
 * wording, and sender domains never route to Leo. Container # is metadata
 * only. Inbound → forward to Leo; Leo returns instructions → process per
 * email (never forward Leo returns back to Leo). Missing fields → email Lisa.
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
 * Rejects LTL PRO / account-code lookalikes (e.g. AVRT1467163, CODE1236247).
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
 * Flattens Outlook HTML so container numbers and GTG are tokens.
 * Mail clients leave literal `&nbsp;`, numeric entities, and tags in the
 * plain-text part. Those must not keep a GTG reply off the invoice path.
 * @param {string} value Raw subject or body.
 * @return {string}
 */
function decodeDrayageMarkup(value) {
  let text = String(value || "");
  text = text.replace(/<[^>]+>/g, " ");
  for (let i = 0; i < 3; i++) {
    const next = text.replace(/&amp;/gi, "&");
    if (next === text) break;
    text = next;
  }
  text = text
      .replace(/&nbsp;|&#0*160;|&#x0*a0;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;|&#0*34;/gi, "\"")
      .replace(/&#(\d+);/g, (_, digits) => {
        const code = Number(digits);
        if (code === 160 || code === 32) return " ";
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) {
          return " ";
        }
        return String.fromCodePoint(code);
      })
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
        const code = parseInt(hex, 16);
        if (code === 0xa0 || code === 0x20) return " ";
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) {
          return " ";
        }
        return String.fromCodePoint(code);
      })
      .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
      .replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
  return text.replace(/[ \t\r\n\f\v]+/g, " ").trim();
}

/**
 * @param {string} subject Email subject.
 * @param {string} body Email body.
 * @return {string}
 */
function drayageMatchText(subject, body) {
  return decodeDrayageMarkup(`${subject || ""}\n${body || ""}`);
}

/**
 * @param {string} subject Email subject.
 * @param {string} body Email body.
 * @return {string|null}
 */
function extractContainerFromText(subject, body) {
  const text = drayageMatchText(subject, body);
  const labeled = text.match(
      /(?:container|cntr|unit)\s*(?:#|no\.?|number)?\s*:?\s*/i +
      /([A-Z]{3,4}[\s-]?\d{6,7})/i);
  if (labeled && labeled[1]) {
    const clean = sanitizeContainerNumber(labeled[1]);
    if (clean) return clean;
  }
  const isoInline = text.match(/\b([A-Z]{4}\s*\d{7})\d?\b/i);
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
 * Walks Primus vendor type values. getVendors stores one `type` string
 * (this account's list is always "LTL"). The vendor profile can also
 * show several provider types and a shipment mode. Combined strings
 * such as "LTL, DRAYAGE" or "LTL / DRAYAGE" are split. Numeric ids are
 * skipped — those are resolved to names before classification.
 * @param {*} value Type string, list, or vendor lookup row.
 * @param {function(string): void} visit Token callback.
 */
function eachVendorTypeToken(value, visit) {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) eachVendorTypeToken(item, visit);
    return;
  }
  if (typeof value === "object") {
    eachVendorTypeToken(value.type, visit);
    eachVendorTypeToken(value.types, visit);
    eachVendorTypeToken(value.vendorType, visit);
    eachVendorTypeToken(value.carrierType, visit);
    eachVendorTypeToken(value.carrierTypes, visit);
    eachVendorTypeToken(value.shipmentMode, visit);
    eachVendorTypeToken(value.modes, visit);
    return;
  }
  const text = String(value).trim();
  if (!text || text === "null" || text === "undefined") return;
  const parts = text.split(/[,/|;]+/);
  for (const part of parts) {
    const token = part.trim().replace(/^["'[\]]+|["'[\]]+$/g, "");
    if (!token || /^\d+$/.test(token)) continue;
    visit(token);
  }
}

/**
 * Unique type labels from a Primus vendor row, in first-seen order.
 * @param {*} value Type string, list, or vendor lookup row.
 * @return {Array<string>}
 */
function vendorTypeLabels(value) {
  const labels = [];
  const seen = new Set();
  eachVendorTypeToken(value, (token) => {
    const key = token.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    labels.push(token);
  });
  return labels;
}

/**
 * True when any Primus type or shipment mode is or contains drayage.
 * Other types on the same vendor do not cancel that.
 * @param {*} type Type string, list, or vendor lookup row.
 * @return {boolean}
 */
function isDrayageVendorType(type) {
  let hit = false;
  eachVendorTypeToken(type, (token) => {
    const normalized = token.toLowerCase();
    if (normalized === "drayage" || normalized.includes("dray")) hit = true;
  });
  return hit;
}

/**
 * First-token keys for carriers that are drayage even when the Primus
 * profile type list does not include DRAYAGE. getVendors.type is LTL
 * for every vendor; Blitz's profile does include DRAYAGE, and this
 * name rule still covers that carrier if the profile lookup fails.
 */
const KNOWN_DRAYAGE_CARRIER_NAME_KEYS = [
  "blitz",
];

/**
 * @param {string|null|undefined} name Invoice or Primus vendor name.
 * @return {string}
 */
function normalizeCarrierNameKey(name) {
  return String(name || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
}

/**
 * @param {string|null|undefined} name Invoice or Primus vendor name.
 * @return {boolean}
 */
function isKnownDrayageCarrierName(name) {
  const key = normalizeCarrierNameKey(name);
  if (!key) return false;
  return KNOWN_DRAYAGE_CARRIER_NAME_KEYS.some((known) =>
    key === known || key.startsWith(`${known} `));
}

/**
 * Pier Pass and Port Check are port fees. The invoice header is often
 * "PierPASS/INNOVATIVE CARRIERS" — the bill-to half must not make this
 * a drayage bill.
 * @param {string|null|undefined} name Invoice carrier name.
 * @return {boolean}
 */
function isPortFeeCarrierName(name) {
  const key = normalizeCarrierNameKey(name);
  if (!key) return false;
  return /^(pierpass|pier pass|portcheck|port check)\b/.test(key);
}

/**
 * Innovative Carriers' own Primus vendor includes DRAYAGE along with LTL
 * and FTL. An invoice whose carrier was read as that name is not an
 * inbound drayage bill.
 * @param {string|null|undefined} name Invoice or Primus vendor name.
 * @return {boolean}
 */
function isOwnCompanyCarrierName(name) {
  const key = normalizeCarrierNameKey(name);
  if (!key) return false;
  return key === "innovative carriers" ||
    key.startsWith("innovative carriers ");
}

/**
 * Looks up the Primus master vendor by invoice carrier name only.
 * Never uses the email From header — forwards often come from customers
 * (e.g. *@gmail.com) and would match the wrong vendor.
 * @param {string|null|undefined} carrierName Invoice carrier name.
 * @return {Promise<object|null>}
 */
async function lookupPrimusVendorByCarrierName(carrierName) {
  const name = String(carrierName || "").trim();
  if (!name) return null;
  try {
    const bridge = require("./primus-ui-bridge");
    if (!bridge.isManagePhpEnabled || !bridge.isManagePhpEnabled()) {
      return null;
    }
    return await bridge.lookupVendorByCarrierHint({
      carrierName: name,
      // Name only — never From domain (Loup/up.com, gmail forwards, etc.).
      nameOnly: true,
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

/** Invoice vs load Total Cost. Under $5 can proceed. $5 and over stops. */
const DRAYAGE_AMOUNT_TOLERANCE = 5;

/**
 * Leo's reply means the load charges are entered and Jerry may invoice.
 * @param {string} subject Email subject.
 * @param {string} body Email body.
 * @return {boolean}
 */
function isGtgConfirmation(subject, body) {
  const text = drayageMatchText(subject, body);
  return /\bGTG\b/i.test(text) || /\bgood to go\b/i.test(text);
}

/**
 * Total Cost on the load rate quote. This is the figure in the
 * booking's Total Cost box, stored as the vendor cost once the rate is saved.
 * @param {object|null|undefined} booking Primus booking.
 * @return {number|null}
 */
function readDrayageTotalCost(booking) {
  if (!booking) return null;
  const vendor = booking.vendor || {};
  const raw = vendor.cost != null && String(vendor.cost).trim() !== "" ?
    vendor.cost :
    (booking.totalCost != null ? booking.totalCost : booking.total);
  const amount = parseMoney(raw);
  return amount != null && amount > 0 ? amount : null;
}

/**
 * @param {number} invoiceAmount Carrier invoice total.
 * @param {number|null} totalCost Load Total Cost.
 * @return {{ok: boolean, difference: number|null, invoiceAmount: number,
 *   totalCost: number|null}}
 */
function drayageAmountsAcceptable(invoiceAmount, totalCost) {
  const invoice = Number(invoiceAmount);
  const total = totalCost == null ? null : Number(totalCost);
  if (!(invoice > 0) || total == null || !(total > 0)) {
    return {
      ok: false,
      difference: null,
      invoiceAmount: invoice,
      totalCost: total,
    };
  }
  const difference = Math.round(Math.abs(invoice - total) * 100) / 100;
  return {
    ok: difference < DRAYAGE_AMOUNT_TOLERANCE,
    difference,
    invoiceAmount: invoice,
    totalCost: total,
  };
}

/**
 * True when an actual-cost line already has a vendor bill number.
 * vendorInvoiceNumber is the Primus Actual Cost Bill# column.
 * Empty, null, and whitespace are unbilled. Numeric 0 is unbilled because
 * the existing posting code reads it with `value || ""`. The string "0"
 * is a bill number.
 * @param {object|null|undefined} line Actual-cost or billsInfo row.
 * @return {boolean}
 */
function actualCostHasVendorBillNumber(line) {
  return !!String(line && line.vendorInvoiceNumber || "").trim();
}

/**
 * Removes actual-cost lines that do not yet have a vendor bill number,
 * then adds the drayage carrier bill. Lines that already have a bill
 * number are left unchanged. The carrier bill is not added again when
 * that invoice number is already on a line.
 * @param {Array<object>} existingLines Actual cost lines.
 * @param {object} feeLine New carrier-bill line.
 * @return {{lines: Array<object>, added: boolean, removed: number}}
 */
function mergeDrayageActualCost(existingLines, feeLine) {
  const source = Array.isArray(existingLines) ? existingLines : [];
  const lines = [];
  let removed = 0;
  for (const line of source) {
    if (!actualCostHasVendorBillNumber(line)) {
      removed += 1;
      continue;
    }
    lines.push(line);
  }
  const billNo = String(feeLine && feeLine.vendorInvoiceNumber || "").trim();
  const already = billNo && lines.some((line) =>
    String(line.vendorInvoiceNumber || "").trim() === billNo);
  if (already) return {lines, added: false, removed};
  lines.push(feeLine);
  return {lines, added: true, removed};
}

/**
 * Backup paperwork is uploaded as Carrier Bill. A POD is not.
 * @param {object} file Attachment.
 * @return {boolean}
 */
function isDrayagePodAttachment(file) {
  if (!file) return false;
  if (String(file.docType || "").toUpperCase() === "POD") return true;
  const name = String(file.filename || file.name || "");
  return /\bPOD\b|proof of delivery/i.test(name);
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
    `Please enter the charges on the load. When it is ready to invoice, ` +
    `reply to ${returnTo} and include GTG (Good to Go) plus the ` +
    `container number or the Primus load number.\n\n` +
    `Example:\n` +
    `GTG\n` +
    `${opts.containerNumber || "[container number]"}\n\n` +
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
        "Do not treat LTL PRO numbers or account codes as containers.",
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
 * @return {string|null} Container number when inbound drayage should go to Leo.
 */
function resolveInboundDrayageContainer(
    from, invoiceItems, probedContainer, subject, body) {
  if (isDrayageValidatorEmail(from)) return null;
  // Container alone never routes to Leo — Primus vendor type decides.
  return null;
}

/**
 * Classifies inbound freight as drayage when any Primus vendor type or
 * shipment mode shows drayage, even if the vendor also has LTL or other
 * types. A known drayage carrier name still matches when the profile
 * does not. Container numbers and sender email never trigger routing.
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

  if (!carrierName || isPortFeeCarrierName(carrierName)) {
    return {
      isDrayage: false,
      carrierName: carrierName || null,
      vendorType: null,
      containerNumber,
    };
  }

  const lookup = typeof lookupVendor === "function" ?
    lookupVendor : lookupPrimusVendorByCarrierName;
  let vendor = null;
  try {
    vendor = await lookup(carrierName, from);
  } catch (_) {
    vendor = null;
  }

  const typeLabels = vendor ? vendorTypeLabels(vendor) : [];
  const vendorType = typeLabels.length ?
    typeLabels.join(", ") :
    (vendor && vendor.type || null);
  const vendorName = vendor && vendor.name || null;
  const knownByName = isKnownDrayageCarrierName(carrierName) ||
    isKnownDrayageCarrierName(vendorName);
  const drayageByVendorType = !!(vendor && isDrayageVendorType(vendor));
  if (isOwnCompanyCarrierName(carrierName) ||
      isOwnCompanyCarrierName(vendorName)) {
    return {
      isDrayage: false,
      carrierName,
      vendorType,
      containerNumber,
      primusVendorId: vendor && vendor.id || null,
    };
  }
  if (knownByName || drayageByVendorType) {
    const displayName = carrierName || vendorName;
    const reason = drayageByVendorType ?
      `Drayage invoice — Primus vendor ` +
        `${vendorName || carrierName} (${vendorType})` :
      `Drayage invoice — carrier ${displayName} recognized as drayage`;
    return {
      isDrayage: true,
      reason,
      containerNumber,
      carrierName: displayName,
      vendorType,
      primusVendorId: vendor && vendor.id || null,
      drayageByVendorType,
      drayageByCarrierName: knownByName,
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
  DRAYAGE_AMOUNT_TOLERANCE,
  LEO_REQUIRED_FIELDS,
  isGtgConfirmation,
  readDrayageTotalCost,
  drayageAmountsAcceptable,
  actualCostHasVendorBillNumber,
  mergeDrayageActualCost,
  isDrayagePodAttachment,
  normalizeContainerNumber,
  isPlausibleContainerNumber,
  sanitizeContainerNumber,
  extractContainerFromText,
  isDrayageValidatorEmail,
  containerFromInvoiceItem,
  findContainerOnInvoiceItems,
  isDrayageVendorType,
  vendorTypeLabels,
  isKnownDrayageCarrierName,
  isPortFeeCarrierName,
  isOwnCompanyCarrierName,
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
  lookupPrimusVendorByCarrierName,
};
