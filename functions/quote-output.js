/**
 * Quote output — customer draft email + dispatcher page data.
 */

"use strict";

const quoteRules = require("./quote-accessorial-rules");
const addressEnrichment = require("./quote-address-enrichment");

/** Common accessorial toggles for dispatcher re-rate UI. */
const COMMON_ACCESSORIALS = [
  {code: "LFO", label: "Liftgate pickup"},
  {code: "LFD", label: "Liftgate delivery"},
  {code: "APD", label: "Appointment delivery"},
  {code: "LAD", label: "Limited access"},
  {code: "RSD", label: "Residential delivery"},
  {code: "NUD", label: "Nursing home delivery"},
  {code: "HOD", label: "Hotel delivery"},
];

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
 * @param {number|null} n Amount.
 * @return {string}
 */
function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  return v.toFixed(2);
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
  const meta = lane.enrichmentMeta;
  const codes = lane.accessorials || [];
  if (!meta || !codes.length) return "";

  const labels = quoteRules.formatAccessorialLabels(codes);
  const typeLabel = formatSiteTypeLabel(meta.classifiedAs || lane.siteType);
  const location = formatLocationLabel(lane.consignee, meta.placeName);
  return `Accessorials added: ${labels} — location classified as ` +
    `${typeLabel} (${location}).`;
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
    if (lane.notesForCustomer) {
      lines.push(lane.notesForCustomer);
    }
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
 * Formats one pricing line — bullet style (Coreforce / Diego pattern).
 * @param {object} opt Selected option.
 * @return {string}
 */
function formatCustomerPricingLineBullet(opt) {
  const price = money(opt.sellRate || opt.customerPrice);
  const carrier = opt.name || opt.SCAC || "Carrier";
  const q = opt.quoteNumber || opt.savedQuoteNumber || "_____";
  const days = opt.transitDays || "?";
  const svc = opt.guaranteed ? "guaranteed" : "estimated";
  let line =
    `• $${price} – ${days}-day transit (${svc}) – ${carrier} Q# ${q}`;
  if (opt.warnings) {
    line += ` (${String(opt.warnings).slice(0, 120)})`;
  }
  return line;
}

/**
 * Formats one pricing line — inline style (Ruelily / Hanna pattern).
 * @param {object} opt Selected option.
 * @return {string}
 */
function formatCustomerPricingLineSimple(opt) {
  const price = money(opt.sellRate || opt.customerPrice);
  const carrier = opt.name || opt.SCAC || "Carrier";
  const q = opt.quoteNumber || opt.savedQuoteNumber || "";
  const days = opt.transitDays || "?";
  let line =
    `$${price} ${carrier} ${days} days transit estimated.`;
  if (q) line += `  ${q}`;
  if (opt.warnings) {
    line += `, ${String(opt.warnings).slice(0, 200)}`;
  }
  return line;
}

/**
 * Formats one pricing line — standard Innovative style (CTA / Izzy).
 * @param {object} opt Selected option.
 * @return {string}
 */
function formatCustomerPricingLine(opt) {
  const price = money(opt.sellRate || opt.customerPrice);
  const carrier = opt.name || opt.SCAC || "Carrier";
  const q = opt.quoteNumber || opt.savedQuoteNumber || "_____";
  const transit = opt.transitDays ? `${opt.transitDays}` : "?";
  let line =
    `$${price} transit is estimated ${transit} standard business days ` +
    `${carrier} Q ${q}`;
  if (opt.warnings) {
    line += ` - ${String(opt.warnings).slice(0, 200)}`;
  }
  return line;
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
        lines.push(formatLine({
          ...opt,
          sellRate: opt.sellRate,
          warnings: opt.warnings || opt.rateRemarks,
        }));
      }
    }
    if (lane.notesForCustomer) lines.push(lane.notesForCustomer);
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
 * Plain text → simple HTML paragraphs for Outlook.
 * @param {string} text Plain text.
 * @return {string}
 */
function textToEmailHtml(text) {
  return String(text || "")
      .split("\n")
      .map((line) => line ? `<p>${escapeHtml(line)}</p>` : "<p><br></p>")
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
  return {
    id: quote.id,
    batchQuoteId: quote.batchQuoteId,
    subject: quote.subject,
    from: quote.from,
    customerRef: quote.customerRef,
    status: quote.status,
    customerDraftText: storedEmail || buildCustomerDraftText(quote),
    customerEmailText: storedEmail,
    accessorialsIncludedText: buildAccessorialsIncludedSection(quote.lanes),
    customerRequest: quote.extracted &&
      quote.extracted.customerRequest || null,
    customerDraftHtml: storedEmail ?
      textToEmailHtml(storedEmail) :
      buildCustomerDraftHtml(quote),
    commonAccessorials: COMMON_ACCESSORIALS,
    lanes: (quote.lanes || []).map((lane) => ({
      laneKey: lane.laneKey,
      label: lane.label,
      consignee: lane.consignee,
      siteType: lane.siteType || null,
      enrichmentMeta: lane.enrichmentMeta || null,
      accessorials: lane.accessorials || [],
      accessorialLabels: quoteRules.formatAccessorialLabels(
          lane.accessorials || []),
      accessorialWhy: buildAccessorialWhy(lane),
      appliedRules: lane.appliedRules,
      selectedRateIds: lane.selectedRateIds ||
        (lane.selectedRateId ? [lane.selectedRateId] : []),
      rateError: lane.rateError || null,
      options: (lane.options || []).map((o) => ({
        rateId: o.id,
        name: o.name,
        SCAC: o.SCAC,
        cost: o.total,
        sellRate: o.sellRate,
        transitDays: o.transitDays,
        quoteNumber: o.quoteNumber,
        tags: o.tags,
        warnings: o.warnings || o.rateRemarks,
        guaranteed: o.guaranteed,
        rateBreakdown: o.rateBreakdown,
      })),
    })),
  };
}

module.exports = {
  generateBatchQuoteId,
  buildCustomerDraftText,
  buildCustomerDraftHtml,
  buildCustomerEmailFromSelections,
  textToEmailHtml,
  serializeForDispatcherPage,
  formatCustomerPricingLine,
  formatCustomerPricingLineBullet,
  formatCustomerPricingLineSimple,
  buildAccessorialsIncludedSection,
  buildLaneEnrichmentNote,
  buildAccessorialWhy,
  collectAppliedAccessorials,
  COMMON_ACCESSORIALS,
};
