/**
 * Quote output — customer draft email + dispatcher page data.
 */

"use strict";

const quoteRules = require("./quote-accessorial-rules");
const addressEnrichment = require("./quote-address-enrichment");
const freightDims = require("./quote-freight-dims");

/** Common accessorial toggles for dispatcher re-rate UI. */
const COMMON_ACCESSORIALS = [
  {code: "LFO", label: "Liftgate pickup"},
  {code: "LFD", label: "Liftgate delivery"},
  {code: "APD", label: "Appointment delivery"},
  {code: "LAD", label: "Limited access"},
  {code: "RSD", label: "Residential delivery"},
  {code: "IND", label: "Inside delivery"},
  {code: "NUD", label: "Nursing home delivery"},
  {code: "HOD", label: "Hotel delivery"},
];

/**
 * Strips HTML / Word junk / entities from carrier notes for UI + email.
 * Never use raw carrier HTML as email styling.
 * @param {string|Array|null|undefined} input Raw note(s).
 * @return {string} Plain text, or "" if empty after clean.
 */
function cleanCarrierNote(input) {
  let text;
  if (Array.isArray(input)) {
    text = input.map((part) => String(part == null ? "" : part)).join(" ");
  } else {
    text = String(input == null ? "" : input);
  }
  if (!text.trim()) return "";

  text = text
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<\/?(?:o:p|xml|w:[^>\s]+)[^>]*>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'")
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
        const n = parseInt(h, 16);
        return Number.isFinite(n) ? String.fromCharCode(n) : " ";
      })
      .replace(/&#(\d+);/g, (_, n) => {
        const code = Number(n);
        return Number.isFinite(code) ? String.fromCharCode(code) : " ";
      })
      .replace(/\u00a0/g, " ")
      .replace(/[\u200b-\u200d\ufeff]/g, "");

  text = text
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{2,}/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n/g, " ")
      .replace(/ {2,}/g, " ")
      .trim();

  // Drop leftover Word class crumbs that sometimes survive strip.
  text = text
      .replace(/\bMsoNormal\b/gi, " ")
      .replace(/\bMso[A-Za-z0-9]+\b/gi, " ")
      .replace(/ {2,}/g, " ")
      .trim();

  if (!text || /^[\s.,;:/\-_|]+$/.test(text)) return "";
  return text;
}

/**
 * Generates next batch quote id like Q#D3478.
 * @param {string} [prefix] Single letter prefix.
 * @return {string}
 */
function generateBatchQuoteId(prefix = "D") {
  const n = Math.floor(1000 + Math.random() * 9000);
  return `Q#${prefix}${n}`;
}

/**
 * Round customer/sell amount UP to the next whole dollar.
 * @param {number|null|undefined} n Amount.
 * @return {number|null}
 */
function ceilWholeDollar(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.ceil(v);
}

/**
 * @param {number|null} n Amount (already whole dollars preferred).
 * @return {string}
 */
function money(n) {
  const v = ceilWholeDollar(n);
  if (v == null) return "";
  return String(v);
}

/**
 * Primus customer line for dispatcher cards / customer email.
 * @param {object} quote Quote doc.
 * @return {string} Empty if unknown.
 */
function formatQuoteCustomerLine(quote) {
  const q = quote || {};
  const name = String(q.shippingLocationName || q.matchedCustomerName || "")
      .trim();
  const id = q.shippingLocationId != null &&
    String(q.shippingLocationId).trim() !== "" ?
    String(q.shippingLocationId).trim() : "";
  if (!name && !id) return "";
  if (name && id) return `Customer: ${name} (Primus ID ${id})`;
  if (name) return `Customer: ${name}`;
  return `Customer: Primus ID ${id}`;
}

/**
 * Human-readable site type for customer notes.
 * @param {string} siteType Internal enum.
 * @return {string}
 */
function formatSiteTypeLabel(siteType) {
  return addressEnrichment.SITE_TYPE_LABELS[siteType] ||
    String(siteType || "unknown").replace(/_/g, " ");
}

/**
 * Formats consignee location for notes.
 * @param {object} consignee Consignee.
 * @param {string} [placeName] Enriched place name.
 * @return {string}
 */
function formatLocationLabel(consignee, placeName) {
  if (placeName) return placeName;
  const c = consignee || {};
  const cityState = [c.city, c.state].filter(Boolean).join(", ");
  if (c.name && cityState) return `${c.name}, ${cityState}`;
  return c.name || cityState || "delivery location";
}

/**
 * Builds accessorial note when enrichment drove rule application.
 * @param {object} lane Rated lane.
 * @return {string} Empty if no note needed.
 */
function buildLaneEnrichmentNote(lane) {
  const destMeta = lane.enrichmentMeta;
  const originMeta = lane.originEnrichmentMeta;
  const codes = lane.accessorials || [];
  if ((!destMeta && !originMeta) || !codes.length) return "";

  const labels = quoteRules.formatAccessorialLabels(codes);
  const parts = [];
  if (originMeta) {
    const typeLabel = formatSiteTypeLabel(
        originMeta.classifiedAs || lane.originSiteType);
    const location = formatLocationLabel(lane.shipper, originMeta.placeName);
    parts.push(`From classified as ${typeLabel} (${location})`);
  }
  if (destMeta) {
    const typeLabel = formatSiteTypeLabel(
        destMeta.classifiedAs || lane.siteType);
    const location = formatLocationLabel(lane.consignee, destMeta.placeName);
    parts.push(`To classified as ${typeLabel} (${location})`);
  }
  return `Accessorials added: ${labels} — ${parts.join("; ")}.`;
}

/**
 * Dispatcher-facing explanation of why accessorials were added.
 * @param {object} lane Rated lane.
 * @return {Array<object>}
 */
function buildAccessorialWhy(lane) {
  const why = [];
  for (const rule of lane.appliedRules || []) {
    why.push({
      ruleId: rule.ruleId || rule.id || null,
      name: rule.name || "Rule",
      notes: rule.notes || null,
      matchVia: rule.matchVia || null,
    });
  }
  const enrichmentNote = buildLaneEnrichmentNote(lane);
  if (enrichmentNote) {
    why.push({
      ruleId: "enrichment",
      name: "Address classification",
      notes: enrichmentNote,
      matchVia: "enrichment",
    });
  }
  return why;
}

/**
 * Universal customer draft — same template for all customers.
 * Pricing lines are placeholders for dispatcher.
 * Primus customer match stays on the dispatcher UI only (not in draft).
 * @param {object} quote Quote request doc data.
 * @return {string} Plain-text email draft.
 */
function buildCustomerDraftText(quote) {
  const batchId = quote.batchQuoteId || "Q#????";
  const lines = [
    "Hi,",
    "",
    `See your options below — ${batchId}:`,
    "",
  ];

  for (const lane of quote.lanes || []) {
    const destCity =
      lane.consignee && lane.consignee.city || "DESTINATION";
    lines.push(lane.label || `TO ${destCity}`);
    lines.push(
        "[Dispatcher fills: $___ — Carrier | Q# _____ | ___-day transit]",
    );
    // Dispatcher notes (notesForCustomer / enrichment / why) stay UI-only.
    lines.push("");
  }

  lines.push(
      "Please advise how you would like to proceed.",
      "",
      "Thank you!",
      "",
      quote.dispatcherSignature || "",
  );
  return lines.join("\n");
}

/**
 * Collects unique accessorial codes applied across lanes.
 * @param {Array<object>} lanes Rated lanes.
 * @return {Array<string>}
 */
function collectAppliedAccessorials(lanes) {
  const codes = new Set();
  for (const lane of lanes || []) {
    (lane.accessorials || []).forEach((c) => codes.add(String(c)));
  }
  return [...codes];
}

/**
 * Builds "Accessorials Included" block for customer email.
 * @param {Array<object>} lanes Rated lanes.
 * @return {string} Empty string if none.
 */
function buildAccessorialsIncludedSection(lanes) {
  const labels = quoteRules.formatAccessorialLabels(
      collectAppliedAccessorials(lanes));
  if (!labels) return "";
  return ["", "Accessorials Included:", labels + ".", ""].join("\n");
}

/**
 * Customer-facing sell amount: dispatcher override, else margin sellRate.
 * Always rounded UP to the next whole dollar.
 * @param {object} opt Rate option.
 * @return {number|null}
 */
function effectiveCustomerRate(opt) {
  if (!opt || typeof opt !== "object") return null;
  const candidates = [
    opt.customerPrice,
    opt.sellRate,
    opt.total,
    opt.cost,
    opt.customerRate,
  ];
  for (const value of candidates) {
    if (value == null || value === "") continue;
    const whole = ceilWholeDollar(value);
    if (whole != null) return whole;
  }
  return null;
}

/**
 * Carrier advisory notes for selected rates in the customer email draft.
 * Match is flexible (name contains); one note line per advisory group.
 * @type {Array<{id: string, test: Function, note: string}>}
 */
const CUSTOMER_EMAIL_CARRIER_NOTE_RULES = [
  {
    id: "pickup_delays",
    test: (name) => /central|aaa\s*cooper/i.test(name),
    note: "often has delays at pickup.",
  },
  {
    id: "reclass_fees",
    test: (name) => /\bxpo\b|saia/i.test(name),
    note: "has a lot of reclass fees if the pallet info are not exact.",
  },
  {
    id: "frontline_consolidated",
    test: (name) => /frontline/i.test(name),
    note: "moves consolidated — may have major delays in transit",
  },
];

/**
 * Builds Notes lines for carriers selected into the customer email.
 * @param {Array<object>} lanes Quote lanes with selections.
 * @return {Array<string>} Empty if none of the advisory carriers are selected.
 */
function buildSelectedCarrierNoteLines(lanes) {
  const byRule = new Map();
  for (const lane of lanes || []) {
    for (const opt of resolveSelectedOptions(lane)) {
      const name = String(opt.name || opt.SCAC || "").trim();
      if (!name) continue;
      for (const rule of CUSTOMER_EMAIL_CARRIER_NOTE_RULES) {
        if (!rule.test(name)) continue;
        let entry = byRule.get(rule.id);
        if (!entry) {
          entry = {note: rule.note, names: []};
          byRule.set(rule.id, entry);
        }
        if (!entry.names.includes(name)) entry.names.push(name);
      }
    }
  }
  const lines = [];
  for (const rule of CUSTOMER_EMAIL_CARRIER_NOTE_RULES) {
    const entry = byRule.get(rule.id);
    if (!entry) continue;
    lines.push(`• ${entry.names.join(" / ")}: ${entry.note}`);
  }
  if (!lines.length) return [];
  return ["Notes:", ...lines];
}

/**
 * Plain carrier note for customer email (stripped; empty if junk-only).
 * @param {object} opt Rate option.
 * @return {string}
 */
function customerNoteFromOption(opt) {
  if (!opt || typeof opt !== "object") return "";
  return cleanCarrierNote(opt.warnings || opt.rateRemarks);
}

/**
 * Formats one pricing line — bullet style (Coreforce / Diego pattern).
 * Note text is appended by the email builder on its own line.
 * @param {object} opt Selected option.
 * @return {string}
 */
function formatCustomerPricingLineBullet(opt) {
  const amount = money(effectiveCustomerRate(opt));
  const priceBit = amount ? `$${amount}` : "$TBD";
  const carrier = opt.name || opt.SCAC || "Carrier";
  const q = opt.quoteNumber || opt.savedQuoteNumber || "_____";
  const days = opt.transitDays || "?";
  const svc = opt.guaranteed ? "guaranteed" : "estimated";
  return `• ${priceBit} – ${days}-day transit (${svc}) – ${carrier} · Q# ${q}`;
}

/**
 * Formats one pricing line — inline style (Ruelily / Hanna pattern).
 * @param {object} opt Selected option.
 * @return {string}
 */
function formatCustomerPricingLineSimple(opt) {
  const amount = money(effectiveCustomerRate(opt));
  const priceBit = amount ? `$${amount}` : "$TBD";
  const carrier = opt.name || opt.SCAC || "Carrier";
  const q = opt.quoteNumber || opt.savedQuoteNumber || "";
  const days = opt.transitDays || "?";
  let line =
    `${priceBit} · ${carrier} · ${days}-day transit (estimated)`;
  if (q) line += ` · Q# ${q}`;
  return line;
}

/**
 * Formats one pricing line — standard Innovative style (CTA / Izzy).
 * @param {object} opt Selected option.
 * @return {string}
 */
function formatCustomerPricingLine(opt) {
  const amount = money(effectiveCustomerRate(opt));
  const priceBit = amount ? `$${amount}` : "$TBD";
  const carrier = opt.name || opt.SCAC || "Carrier";
  const q = opt.quoteNumber || opt.savedQuoteNumber || "_____";
  const transit = opt.transitDays ? `${opt.transitDays}` : "?";
  return (
    `${priceBit} · ${transit} standard business days (estimated) · ` +
    `${carrier} · Q# ${q}`
  );
}

/**
 * @param {string} style bullet|simple|standard.
 * @return {Function}
 */
function pricingFormatter(style) {
  if (style === "simple") return formatCustomerPricingLineSimple;
  if (style === "standard") return formatCustomerPricingLine;
  return formatCustomerPricingLineBullet;
}

/**
 * Resolves selected options for a lane (multi-select).
 * @param {object} lane Lane.
 * @return {Array<object>}
 */
function resolveSelectedOptions(lane) {
  if (Array.isArray(lane.selectedOptions) && lane.selectedOptions.length) {
    return lane.selectedOptions;
  }
  const ids = Array.isArray(lane.selectedRateIds) ?
    lane.selectedRateIds.map(String) :
    (lane.selectedRateId ? [String(lane.selectedRateId)] : []);
  if (!ids.length) return [];
  return (lane.options || []).filter((o) => ids.includes(String(o.id)));
}

/**
 * Builds customer email body from checked rate options.
 * Primus customer line is UI-only — never included in the customer draft.
 * @param {object} quote Quote doc.
 * @param {object} [opts] style.
 * @return {string}
 */
function buildCustomerEmailFromSelections(quote, opts = {}) {
  const batchId = quote.batchQuoteId || "Q#????";
  const formatLine = pricingFormatter(opts.style || "bullet");
  const lines = [
    "Hi,",
    "",
    `See your options below — ${batchId}:`,
    "",
  ];

  const multiLane = (quote.lanes || []).length > 1;
  for (const lane of quote.lanes || []) {
    if (multiLane) {
      const destCity =
        lane.consignee && lane.consignee.city || "DESTINATION";
      lines.push(lane.label || `TO ${destCity}`);
    }
    const selected = resolveSelectedOptions(lane);
    if (!selected.length) {
      lines.push("[No rates selected for this lane]");
    } else {
      for (const opt of selected) {
        const customerRate = effectiveCustomerRate(opt);
        const priced = {
          ...opt,
          customerPrice: customerRate,
          sellRate: customerRate,
        };
        lines.push(formatLine(priced));
      }
    }
    lines.push("");
  }

  const carrierNotes = buildSelectedCarrierNoteLines(quote.lanes);
  if (carrierNotes.length) {
    lines.push(...carrierNotes);
    lines.push("");
  }

  const accBlock = buildAccessorialsIncludedSection(quote.lanes);
  if (accBlock) {
    const parts = accBlock.split("\n").filter((l) => l !== "");
    lines.push(...parts);
    lines.push("");
  }

  lines.push(
      "Please advise how you would like to proceed.",
      "",
      "Thank you!",
  );
  if (quote.dispatcherSignature) {
    lines.push("", quote.dispatcherSignature);
  }
  return lines.join("\n");
}

/**
 * @param {string} s Raw string.
 * @return {string}
 */
function escapeHtml(s) {
  return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}

/**
 * Plain text → light HTML paragraphs for Outlook (never carrier HTML).
 * @param {string} text Plain text.
 * @return {string}
 */
function textToEmailHtml(text) {
  const base =
    "margin:0 0 8px;font-family:Calibri,Arial,sans-serif;font-size:14px;" +
    "line-height:1.4;color:#222;";
  return String(text || "")
      .split("\n")
      .map((line) => {
        if (!line) return `<p style="${base}"><br></p>`;
        const trimmed = line.trimStart();
        let style = base;
        if (trimmed.startsWith("• ")) {
          style =
            "margin:0 0 4px;font-family:Calibri,Arial,sans-serif;" +
            "font-size:14px;line-height:1.45;color:#222;";
        } else if (/^Note:/i.test(trimmed)) {
          style =
            "margin:0 0 12px 12px;font-family:Calibri,Arial,sans-serif;" +
            "font-size:13px;line-height:1.4;color:#444;";
        }
        return `<p style="${style}">${escapeHtml(line)}</p>`;
      })
      .join("\n");
}

/**
 * HTML customer draft (for copy/paste in Outlook).
 * @param {object} quote Quote doc.
 * @return {string}
 */
function buildCustomerDraftHtml(quote) {
  return textToEmailHtml(buildCustomerDraftText(quote));
}

/**
 * Serializes quote for dispatcher JSON API / page.
 * @param {object} quote Firestore quote doc.
 * @return {object}
 */
function serializeForDispatcherPage(quote) {
  const storedEmail = quote.customerEmailText || null;
  const shippingLocationId = quote.shippingLocationId != null &&
    String(quote.shippingLocationId).trim() !== "" ?
    String(quote.shippingLocationId) : null;
  const shippingLocationName = quote.shippingLocationName ||
    quote.matchedCustomerName || null;
  const customerLookupStatus = quote.customerLookupStatus || null;
  const customerMatch = shippingLocationId &&
    customerLookupStatus !== "no_match" ? {
      id: shippingLocationId,
      name: shippingLocationName,
    } : null;
  const customerMatchMessage = customerLookupStatus === "no_match" ?
    "No Primus match for name" : null;
  const quoteShipper = quote.shipper ||
    (quote.extracted && quote.extracted.shipper) || null;
  return {
    id: quote.id,
    batchQuoteId: quote.batchQuoteId,
    subject: quote.subject,
    from: quote.from,
    customerRef: quote.customerRef,
    readyDate: quote.readyDate || null,
    specialInstructionsGlobal: quote.specialInstructionsGlobal || "",
    status: quote.status,
    shipper: quoteShipper,
    originSiteType: quote.originSiteType ||
      (quote.lanes && quote.lanes[0] && quote.lanes[0].originSiteType) ||
      null,
    originEnrichmentMeta: quote.originEnrichmentMeta ||
      (quote.lanes && quote.lanes[0] &&
        quote.lanes[0].originEnrichmentMeta) || null,
    shippingLocationId,
    shippingLocationName,
    customerMatched: !!(customerMatch && shippingLocationId),
    customerMatch,
    customerMatchMessage,
    customerLookupStatus,
    customerLookupQuery: quote.customerLookupQuery || null,
    customerLookupQueries: quote.customerLookupQueries || [],
    customerDeclinedAccessorials: quote.customerDeclinedAccessorials ||
      (quote.extracted && quote.extracted.customerDeclinedAccessorials) ||
      [],
    rateSource: quote.rateSource || null,
    extractionWarnings: quote.extractionWarnings || [],
    // Text draft only — omit unused HTML/catalog fields for leaner payload.
    customerDraftText: storedEmail || buildCustomerDraftText(quote),
    customerEmailText: storedEmail,
    customerRequest: quote.extracted &&
      quote.extracted.customerRequest || null,
    lanes: (quote.lanes || []).map((lane) => ({
      laneKey: lane.laneKey,
      label: lane.label,
      shipper: lane.shipper || quoteShipper || null,
      consignee: lane.consignee,
      freightInfo: Array.isArray(lane.freightInfo) ?
        freightDims.normalizePalletFreightRows(lane.freightInfo) : [],
      specialInstructions: lane.specialInstructions || "",
      notesForCustomer: lane.notesForCustomer || null,
      siteType: lane.siteType || null,
      enrichmentMeta: lane.enrichmentMeta || null,
      originSiteType: lane.originSiteType || null,
      originEnrichmentMeta: lane.originEnrichmentMeta || null,
      accessorials: lane.accessorials || [],
      accessorialLabels: quoteRules.formatAccessorialLabels(
          lane.accessorials || []),
      accessorialWhy: buildAccessorialWhy(lane),
      appliedRules: lane.appliedRules,
      selectedRateIds: lane.selectedRateIds ||
        (lane.selectedRateId ? [lane.selectedRateId] : []),
      rateError: lane.rateError || null,
      rateWarning: lane.rateWarning || null,
      rateSource: lane.rateSource || quote.rateSource || null,
      extractionWarnings: lane.extractionWarnings || [],
      options: (lane.options || []).map((o) => {
        const warningText = cleanCarrierNote(o.warnings || o.rateRemarks);
        // UI truncates notes to ~200 chars; trim payload for multi-rate lanes.
        const warnings = warningText ?
          warningText.slice(0, 240) : null;
        const quoteNumber = o.quoteNumber || o.savedQuoteNumber || null;
        return {
          rateId: o.id,
          name: o.name,
          SCAC: o.SCAC,
          cost: o.total != null ? o.total : o.cost,
          sellRate: ceilWholeDollar(
              o.sellRate != null ? o.sellRate :
                (o.total != null ? o.total : o.cost)),
          customerPrice: o.customerPrice != null ?
            ceilWholeDollar(o.customerPrice) : null,
          transitDays: o.transitDays,
          quoteNumber,
          costQuoteId: o.costQuoteId || null,
          quoteUrl: o.quoteUrl || o.url || null,
          tags: o.tags,
          warnings,
          guaranteed: o.guaranteed,
        };
      }),
    })),
  };
}

module.exports = {
  generateBatchQuoteId,
  cleanCarrierNote,
  ceilWholeDollar,
  buildCustomerDraftText,
  buildCustomerDraftHtml,
  buildCustomerEmailFromSelections,
  buildSelectedCarrierNoteLines,
  textToEmailHtml,
  serializeForDispatcherPage,
  effectiveCustomerRate,
  customerNoteFromOption,
  formatCustomerPricingLine,
  formatCustomerPricingLineBullet,
  formatCustomerPricingLineSimple,
  buildAccessorialsIncludedSection,
  buildLaneEnrichmentNote,
  buildAccessorialWhy,
  collectAppliedAccessorials,
  resolveSelectedOptions,
  COMMON_ACCESSORIALS,
  formatQuoteCustomerLine,
};
