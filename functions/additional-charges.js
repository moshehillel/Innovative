/**
 * Additional-charge handling for carrier invoices that exceed the quoted
 * amount (per accounting's documented process):
 *
 *   A. Identify the reason — accessorial, weight/reweigh/inspection, or a
 *      rate increase with no reason.
 *   B. Weight/Reweigh/Inspection is identified by: a fee with W&I wording,
 *      an attached W&I certificate, or the invoice weight/class differing
 *      from what is on the Primus booking. For W&I we re-rate via Primus
 *      GET /rate with the invoice's updated weight/class and compare the
 *      returned total to the carrier invoice (default $10 tolerance).
 *   C. Approval email offers FIVE decisions:
 *        A — pay carrier + bill customer; auto-email the customer contact.
 *        B — pay carrier + bill customer; dispatcher notifies the customer
 *            (system reminds the dispatcher / adds to their task list).
 *        C — pay carrier only; customer rate stays the same (not itemized).
 *        D — not approved; generate a carrier dispute draft for manual
 *            submission (LTL portals) or email (TL).
 *        E — pay carrier + bill customer; enter amount and bump rate; no
 *            separate customer notification (invoice carries the charge).
 *   D. Every case is tracked on an Additional Charges Follow-Up list until
 *      resolved.
 *
 * Env:
 *   ADDITIONAL_CHARGE_APPROVER_EMAIL — Sarah (approval email recipient);
 *     default Sarah@innovativecarriers.com (same domain as Lisa).
 */

"use strict";

const admin = require("firebase-admin");
const {
  toOutboundEmailSafeSubject,
  toOutboundEmailSafeText,
} = require("./email-outbound-safe");

const FOLLOW_UP_COLLECTION = "additionalCharges";

const LISA_EMAIL = process.env.LOW_PROFIT_CC_EMAIL ||
  "Lisa@innovativecarriers.com";

/** Follow-up lifecycle statuses. */
const FOLLOW_UP_STATUS = Object.freeze({
  PENDING_APPROVAL: "pending_approval",
  APPROVED_BILLED: "approved_billed",
  APPROVED_BILLED_DISPATCHER_NOTIFIES: "approved_billed_dispatcher_notifies",
  APPROVED_CARRIER_ONLY: "approved_carrier_only",
  DISPUTING: "disputing",
  RESOLVED: "resolved",
});

/** Additional-charge reason categories. */
const CHARGE_CATEGORY = Object.freeze({
  ACCESSORIAL: "accessorial",
  WEIGHT_INSPECTION: "weight_inspection",
  RATE_INCREASE: "rate_increase",
});

const WNI_LABEL_PATTERN = new RegExp(
    "re-?weigh|w\\s*&\\s*i\\b|weight\\s*(?:&|and)\\s*inspect|" +
    "inspect(?:ion)?\\s*(?:cert|fee|charge)|re-?class(?:ification)?|" +
    "cubic|density|re-?dim", "i");

/** Accessorial / service fee labels (not weight/reclass). */
const ACCESSORIAL_LABEL_PATTERN = new RegExp(
    "school|notify|detention|delivery|liftgate|lumper|appointment|" +
    "residential|inside|limited\\s*access|accessorial|sort(?:ing)?|" +
    "seg(?:regat)?|re-?deliver|notification|call\\s*ahead|reschedule|" +
    "storage|redelivery|hazmat|oversize|overlength|single\\s*shipment|" +
    "construction|military|farm|church|mine|prison|utility|airport|" +
    "trade\\s*show|exhibition|pallet|handling|chassis|drop|stop\\s*off|" +
    "driver\\s*assist|tailgate|non-?commercial", "i");

/** Dollars: Primus re-rate vs carrier invoice is a match within this. */
const RATE_MATCH_TOLERANCE = 10;

/** Charges at or below this amount are ignored for approval/dispute. */
const MIN_IGNORABLE_CHARGE_AMOUNT = 5;

/** A few dollars: match the gap to an accessorial instead of calling it a reweigh. */
const SMALL_GAP_MAX = 25;

/**
 * Line haul and fuel are a breakdown of the freight total, never an extra.
 * @param {string} label Charge label.
 * @return {boolean}
 */
function isFreightBreakdownLabel(label) {
  const text = String(label || "");
  if (isAccessorialLabel(text)) return false;
  return /line[\s-]*haul|\blinehaul\b|\bfuel\b|\bfsc\b/i.test(text);
}

/**
 * Drops line-haul and fuel rows from an extra-charge list.
 * @param {Array<object>} charges Charge rows.
 * @return {{kept: Array<object>, dropped: Array<object>}}
 */
function stripFreightBreakdownCharges(charges) {
  const kept = [];
  const dropped = [];
  for (const row of (Array.isArray(charges) ? charges : [])) {
    if (isFreightBreakdownLabel(chargeLabel(row))) dropped.push(row);
    else kept.push(row);
  }
  return {kept, dropped};
}

/**
 * Carrier invoice total minus the original amount on file.
 * @param {number|string} invoiceAmount Carrier invoice total.
 * @param {number|string} primusAmount Primus carrier cost.
 * @return {number|null}
 */
function invoiceOverage(invoiceAmount, primusAmount) {
  const invoice = Number(String(invoiceAmount == null ? "" : invoiceAmount)
      .replace(/[^0-9.-]/g, ""));
  const quoted = Number(String(primusAmount == null ? "" : primusAmount)
      .replace(/[^0-9.-]/g, ""));
  if (!(invoice > 0) || !(quoted > 0)) return null;
  return Math.round((invoice - quoted) * 100) / 100;
}

/**
 * The difference is always the carrier invoice minus Primus.
 * Line amounts are listed separately and are not this number.
 * @param {number|string} invoiceAmount Carrier invoice total.
 * @param {number|string} primusAmount Primus carrier cost.
 * @return {number|null}
 */
function reportedChargeDifference(invoiceAmount, primusAmount) {
  const gap = invoiceOverage(invoiceAmount, primusAmount);
  if (gap == null || !(gap > 0)) return null;
  return gap;
}

/** Flat band for lumper base-freight pre-check vs Primus carrier cost. */
const LUMPER_BASE_TOLERANCE = 5;

/**
 * Validates invoice amount by subtracting lumper charges before comparing
 * to Primus carrier cost (booking.vendor.cost).
 * @param {object} aiResult AI classification result.
 * @param {number} primusCarrierCost Carrier cost from Primus booking.
 * @return {object} Validation result.
 */
function validateLumperAmount(aiResult, primusCarrierCost) {
  const lumperCharges = (aiResult.recognizedCharges || [])
      .filter((c) => c && c.type === "lumper");
  const totalLumper = lumperCharges.reduce(
      (sum, c) => sum + (Number(c.amount) || 0), 0);
  const invoiceAmount = Number(aiResult.invoiceAmount || 0);
  const primusCost = Number(primusCarrierCost || 0);
  const baseAmount = invoiceAmount - totalLumper;
  // When the invoice total already matches Primus, the lumper is included in
  // carrier cost — line items are a breakdown, not an overage.
  const totalMatchesPrimus = primusCost > 0 &&
      Math.abs(invoiceAmount - primusCost) <= RATE_MATCH_TOLERANCE;
  if (totalMatchesPrimus) {
    return {
      valid: true,
      baseAmount,
      totalLumper,
      difference: 0,
      totalMatchesPrimus: true,
    };
  }
  const difference = Math.abs(baseAmount - primusCost);
  // Flat band — pre-check only; full validation uses validateAmountWithPrimus.
  return {
    valid: difference <= LUMPER_BASE_TOLERANCE,
    baseAmount,
    totalLumper,
    difference,
    totalMatchesPrimus: false,
  };
}

/**
 * @param {string} text Raw text.
 * @return {string}
 */
function esc(text) {
  return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}

/**
 * @param {number|string|null} amount Money value.
 * @return {string}
 */
function money(amount) {
  const n = Number(amount);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "—";
}

/**
 * Lisa is always copied on additional-charge ops emails (even when Sarah
 * is To and a dispatcher is also CC'd).
 * @param {string|string[]|null|undefined} cc Existing CC list.
 * @return {string} Comma-separated CC including Lisa.
 */
function mergeLisaOnCc(cc) {
  const lisaLower = LISA_EMAIL.toLowerCase();
  const list = [];
  if (cc) {
    const raw = Array.isArray(cc) ? cc : String(cc).split(/[,;]/);
    for (const part of raw) {
      const email = String(part).trim();
      if (email) list.push(email);
    }
  }
  if (!list.some((e) => e.toLowerCase() === lisaLower)) {
    list.push(LISA_EMAIL);
  }
  return list.join(", ");
}

/**
 * Ensures Lisa is on CC for any additional-charge outbound email payload.
 * @param {object} payload saveOutboundEmail fields.
 * @return {object} Payload with Lisa merged into cc.
 */
function applyAdditionalChargeEmailCc(payload) {
  return Object.assign({}, payload, {
    cc: mergeLisaOnCc(payload && payload.cc),
  });
}

/**
 * Ensures Lisa is CC'd on emails sent directly to a load dispatcher.
 * Skips duplicate CC when Lisa is already the primary recipient.
 * @param {object} payload saveOutboundEmail fields.
 * @return {object}
 */
function applyDispatcherEmailCc(payload) {
  const out = Object.assign({}, payload || {});
  const to = String(out.to || "").trim().toLowerCase();
  if (to === LISA_EMAIL.toLowerCase()) return out;
  out.cc = mergeLisaOnCc(out.cc);
  return out;
}

/**
 * Formats the customer sell rate for additional-charge emails.
 * @param {number|string|null} amount Money value.
 * @return {string}
 */
function formatCustomerRate(amount) {
  const n = Number(amount);
  return Number.isFinite(n) && n > 0 ? money(n) : "—";
}

/**
 * @param {object} charge Charge row {label|type, amount}.
 * @return {string}
 */
function chargeLabel(charge) {
  return String((charge && (charge.label || charge.type)) || "").trim();
}

/**
 * True when a charge label reads like an accessorial / service fee.
 * @param {string} label Charge label from the invoice.
 * @return {boolean}
 */
function isAccessorialLabel(label) {
  return ACCESSORIAL_LABEL_PATTERN.test(String(label || ""));
}

/**
 * @param {string} label Raw charge label/type from AI or carrier.
 * @return {string} Human-readable label for emails.
 */
function displayChargeLabel(label) {
  const raw = String(label || "").trim();
  if (!raw) return "Additional charge";
  const key = raw.toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
  const aliases = {
    school_delivery: "School delivery fee",
    notify_charge: "Notify charge",
    notify_detention: "Notify detention",
    notify_delivery: "Notify delivery",
    notification_fee: "Notification fee",
    detention: "Detention",
    liftgate: "Liftgate",
    lumper: "Lumper",
  };
  if (aliases[key]) return aliases[key];
  if (/^[a-z0-9_]+$/i.test(raw)) {
    return raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return raw;
}

/**
 * True when a charge label reads like a weight / inspection / reclass fee.
 * @param {string} label Charge label from the invoice.
 * @return {boolean}
 */
function isWeightInspectionLabel(label) {
  const text = String(label || "");
  if (isAccessorialLabel(text)) return false;
  return WNI_LABEL_PATTERN.test(text);
}

/**
 * Sums charge amounts.
 * @param {Array<object>} charges Charge rows.
 * @return {number}
 */
function sumCharges(charges) {
  return (Array.isArray(charges) ? charges : [])
      .reduce((sum, c) => sum + (Number(c && c.amount) || 0), 0);
}

/**
 * @param {string} text Raw label/description text.
 * @return {string}
 */
function normalizeBreakdownText(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Keyword hints for matching invoice charge labels to Primus breakdown rows.
 * @param {string} label Charge label from the invoice.
 * @return {string[]}
 */
function chargeBreakdownKeywords(label) {
  const n = normalizeBreakdownText(label);
  const keys = [];
  if (/compliance|csf/.test(n)) keys.push("compliance", "csf");
  if (/reweigh|reclass|weight/.test(n)) {
    keys.push("reweigh", "weight", "inspection");
  }
  if (/liftgate|lumper|detention|appointment/.test(n)) {
    keys.push("liftgate", "lumper", "detention", "appointment");
  }
  return keys;
}

/**
 * True when a charge row matches a Primus vendor cost breakdown entry
 * (amount within 2%, description overlap, or keyword match).
 * @param {object} charge Charge row {label|type, amount}.
 * @param {Array<object>} breakdown booking.vendor.breakdown.
 * @return {boolean}
 */
function isChargeInPrimusBreakdown(charge, breakdown) {
  const rows = Array.isArray(breakdown) ? breakdown : [];
  const cAmt = Math.abs(Number(charge && charge.amount || 0));
  const cLabel = normalizeBreakdownText(
      charge && (charge.label || charge.type));
  const keywords = chargeBreakdownKeywords(
      charge && (charge.label || charge.type));
  return rows.some((b) => {
    const bAmt = Math.abs(Number(b.total != null ? b.total : b.rate || 0));
    const bDesc = normalizeBreakdownText(b.description || b.code);
    const amtClose = cAmt > 0 &&
      Math.abs(bAmt - cAmt) <= Math.max(0.50, cAmt * 0.02);
    const descClose = cLabel && bDesc &&
      (bDesc.includes(cLabel) || cLabel.includes(bDesc));
    const keywordClose = keywords.length > 0 && keywords.some((kw) =>
      bDesc.includes(kw));
    return amtClose || descClose || keywordClose;
  });
}

/**
 * Drops charges at or below minAmount (default $5).
 * @param {Array<object>} charges Charge rows.
 * @param {number} [minAmount=5] Ignore charges at or below this amount.
 * @return {{ignorable: Array<object>, remaining: Array<object>}}
 */
function filterIgnorableSmallCharges(charges, minAmount) {
  const threshold = Number.isFinite(Number(minAmount)) ?
    Number(minAmount) : MIN_IGNORABLE_CHARGE_AMOUNT;
  const list = Array.isArray(charges) ? charges : [];
  const ignorable = [];
  const remaining = [];
  for (const c of list) {
    const amt = Math.abs(Number(c && c.amount || 0));
    if (amt <= threshold) {
      ignorable.push(c);
    } else {
      remaining.push(c);
    }
  }
  return {ignorable, remaining};
}

/**
 * Splits charges into those already on the Primus vendor breakdown vs net-new.
 * @param {Array<object>} charges Charge rows (should already exclude small).
 * @param {Array<object>} breakdown booking.vendor.breakdown.
 * @return {{alreadyInPrimus: Array<object>, notInPrimus: Array<object>}}
 */
function partitionChargesByPrimus(charges, breakdown) {
  const list = Array.isArray(charges) ? charges : [];
  const alreadyInPrimus = [];
  const notInPrimus = [];
  for (const c of list) {
    if (isChargeInPrimusBreakdown(c, breakdown)) {
      alreadyInPrimus.push(c);
    } else {
      notInPrimus.push(c);
    }
  }
  return {alreadyInPrimus, notInPrimus};
}

/**
 * Filters charges for approval/dispute: drops small amounts, then partitions
 * the remainder against the Primus vendor breakdown.
 * @param {Array<object>} charges Raw charge rows.
 * @param {Array<object>|null|undefined} breakdown booking.vendor.breakdown.
 * @param {number} [minAmount=5] Ignore charges at or below this amount.
 * @return {object} ignorableSmall, alreadyInPrimus, notInPrimus,
 *   chargesForAction, skipApproval.
 */
function filterChargesForApproval(charges, breakdown, minAmount) {
  const {ignorable, remaining} = filterIgnorableSmallCharges(
      charges, minAmount);
  const {alreadyInPrimus, notInPrimus} = partitionChargesByPrimus(
      remaining, breakdown);
  return {
    ignorableSmall: ignorable,
    alreadyInPrimus,
    notInPrimus,
    chargesForAction: notInPrimus,
    skipApproval: notInPrimus.length === 0,
  };
}

/**
 * Reads billed weight/class from a Primus booking for mismatch comparison.
 * @param {object|null} booking Primus booking (GET /book/bolnumber).
 * @return {{totalWeightLbs: number, freightClass: string}}
 */
function readBookingFreight(booking) {
  if (!booking || typeof booking !== "object") {
    return {totalWeightLbs: 0, freightClass: ""};
  }
  const totalWeightLbs = Number(booking.totalWeight) || 0;
  const info = Array.isArray(booking.freightInfo) ? booking.freightInfo : [];
  const classes = info
      .map((f) => String((f && f.class) || "").trim())
      .filter(Boolean);
  return {
    totalWeightLbs,
    freightClass: classes.length === 1 ? classes[0] : classes.join(","),
  };
}

/**
 * Compares the freight details billed on the invoice with the Primus booking.
 * A mismatch (weight or class) indicates an unlabeled reweigh/redim charge.
 * @param {object|null} invoiceFreight {totalWeightLbs, freightClass} from AI.
 * @param {object|null} booking Primus booking.
 * @return {object} {mismatch, weightMismatch, classMismatch, details}
 */
function detectFreightMismatch(invoiceFreight, booking) {
  const inv = invoiceFreight || {};
  const invWeight = Number(inv.totalWeightLbs) || 0;
  const invClass = String(inv.freightClass || "").trim();
  const primus = readBookingFreight(booking);

  let weightMismatch = false;
  if (invWeight > 0 && primus.totalWeightLbs > 0) {
    const diff = Math.abs(invWeight - primus.totalWeightLbs);
    weightMismatch = diff > 50 && diff / primus.totalWeightLbs > 0.05;
  }

  let classMismatch = false;
  if (invClass && primus.freightClass &&
      !primus.freightClass.split(",").includes(invClass)) {
    classMismatch = true;
  }

  return {
    mismatch: weightMismatch || classMismatch,
    weightMismatch,
    classMismatch,
    details: {
      invoiceWeightLbs: invWeight || null,
      primusWeightLbs: primus.totalWeightLbs || null,
      invoiceClass: invClass || null,
      primusClass: primus.freightClass || null,
    },
  };
}

/**
 * Builds freightInfo[] for Primus GET /rate, preferring the invoice's
 * billed weight/class and falling back to the booking's freight rows for
 * dims / qty / commodity.
 * @param {object|null} booking Primus booking.
 * @param {object|null} invoiceFreight {totalWeightLbs, freightClass}.
 * @return {Array<object>|null} freightInfo payload, or null if unusable.
 */
function buildRequoteFreightInfo(booking, invoiceFreight) {
  const inv = invoiceFreight || {};
  const invWeight = Number(inv.totalWeightLbs) || 0;
  const invClass = String(inv.freightClass || "").trim();
  const rows = Array.isArray(booking && booking.freightInfo) ?
    booking.freightInfo : [];

  if (rows.length > 0) {
    return rows.map((row, idx) => {
      const qty = Number(row.qty) || 1;
      const weight = (idx === 0 && invWeight > 0) ?
        invWeight :
        (Number(row.weight) || invWeight || 0);
      const freightClass = (idx === 0 && invClass) ?
        invClass :
        (row.class != null ? String(row.class) : invClass);
      const out = {
        qty,
        weight,
        weightType: "total",
        class: freightClass || 50,
      };
      if (row.length != null) out.length = Number(row.length) || 0;
      if (row.width != null) out.width = Number(row.width) || 0;
      if (row.height != null) out.height = Number(row.height) || 0;
      if (row.dimType) out.dimType = String(row.dimType);
      if (row.commodity) out.commodity = String(row.commodity);
      if (row.nmfc) out.nmfc = String(row.nmfc);
      if (row.hazmat != null) out.hazmat = !!row.hazmat;
      return out;
    }).filter((r) => Number(r.weight) > 0);
  }

  if (invWeight <= 0) return null;
  return [{
    qty: 1,
    weight: invWeight,
    weightType: "total",
    class: invClass || 50,
  }];
}

/**
 * Builds the query-string params for Primus GET /rate from a booking and
 * the freight rows to rate.
 * @param {object} booking Primus booking.
 * @param {Array<object>} freightInfo From buildRequoteFreightInfo.
 * @return {object|null} Flat params object, or null if booking incomplete.
 */
function buildRateQueryFromBooking(booking, freightInfo) {
  if (!booking || !Array.isArray(freightInfo) || !freightInfo.length) {
    return null;
  }
  const vendorId = booking.vendor && booking.vendor.id;
  if (!vendorId) return null;
  const ship = booking.shipper || {};
  const cons = booking.consignee || {};
  const originCity = String(ship.city || "").trim();
  const destCity = String(cons.city || "").trim();
  if (!originCity || !destCity) return null;

  const params = {
    vendorId: String(vendorId),
    originCity,
    originCountry: String(ship.country || "USA").trim() || "USA",
    destinationCity: destCity,
    destinationCountry: String(cons.country || "USA").trim() || "USA",
    UOM: String(booking.UOM || "US").trim() || "US",
    freightInfo: JSON.stringify(freightInfo),
  };
  if (ship.zipCode || ship.zip) {
    params.originZipcode = String(ship.zipCode || ship.zip);
  }
  if (ship.state) params.originState = String(ship.state);
  if (cons.zipCode || cons.zip) {
    params.destinationZipcode = String(cons.zipCode || cons.zip);
  }
  if (cons.state) params.destinationState = String(cons.state);
  return params;
}

/**
 * Compares a Primus re-rate total to the carrier invoice amount.
 * @param {object} opts invoiceAmount, rateTotal, tolerance (default $10).
 * @return {object} {matched, difference, tolerance, invoiceAmount, rateTotal}
 */
function evaluateRequoteMatch(opts) {
  const invoiceAmount = Number(opts.invoiceAmount);
  const rateTotal = Number(opts.rateTotal);
  const tolerance = Number.isFinite(Number(opts.tolerance)) ?
    Number(opts.tolerance) : RATE_MATCH_TOLERANCE;
  const okInvoice = Number.isFinite(invoiceAmount);
  const okRate = Number.isFinite(rateTotal);
  if (!okInvoice || !okRate) {
    return {
      matched: false,
      difference: null,
      tolerance,
      invoiceAmount: okInvoice ? invoiceAmount : null,
      rateTotal: okRate ? rateTotal : null,
    };
  }
  const difference = Math.abs(invoiceAmount - rateTotal);
  return {
    matched: difference <= tolerance,
    difference,
    tolerance,
    invoiceAmount,
    rateTotal,
  };
}

/**
 * Classifies why the carrier invoice is higher than the quoted amount.
 * @param {object} opts charges (unrecognized rows), hasCertificate (W&I
 *   certificate attached), freightMismatch (from detectFreightMismatch).
 * @return {string} One of CHARGE_CATEGORY values.
 */
function classifyAdditionalChargeReason(opts) {
  const raw = Array.isArray(opts.charges) ? opts.charges : [];
  const charges = raw.filter(
      (c) => !isFreightBreakdownLabel(chargeLabel(c)));
  const wniByLabel = charges.some(
      (c) => isWeightInspectionLabel(chargeLabel(c)));
  const accessorialByLabel = charges.some(
      (c) => isAccessorialLabel(chargeLabel(c)));
  const mismatch = opts.freightMismatch && opts.freightMismatch.mismatch;
  const gap = opts.invoiceGap != null ? Number(opts.invoiceGap) :
    invoiceOverage(opts.invoiceAmount, opts.primusAmount);

  // A named accessorial (redelivery, liftgate, …) is the reason even when
  // weight or dims also differ. Reweigh only when the invoice says so.
  if (accessorialByLabel && !wniByLabel) {
    return CHARGE_CATEGORY.ACCESSORIAL;
  }

  // A few dollars off: use the accessorial line that matches the gap.
  if (Number.isFinite(gap) && gap > 0.5 && gap <= SMALL_GAP_MAX) {
    const near = charges.find((c) => {
      const amt = Math.abs(Number(c && c.amount) || 0);
      return amt > 0 && Math.abs(amt - gap) <= 1 &&
        !isWeightInspectionLabel(chargeLabel(c));
    });
    if (near) return CHARGE_CATEGORY.ACCESSORIAL;
  }

  if (wniByLabel || opts.hasCertificate || mismatch) {
    return CHARGE_CATEGORY.WEIGHT_INSPECTION;
  }
  const hasLabeledCharge = charges.some((c) => chargeLabel(c).length > 0);
  if (hasLabeledCharge) return CHARGE_CATEGORY.ACCESSORIAL;
  return CHARGE_CATEGORY.RATE_INCREASE;
}

/**
 * Picks the dispute/approval category from charge labels when the stored
 * category would contradict the line items (e.g. accessorials labeled W&I).
 * @param {object} opts charges, category, freightMismatch, hasCertificate.
 * @return {string} CHARGE_CATEGORY value.
 */
function resolveEffectiveChargeCategory(opts) {
  const charges = Array.isArray(opts.charges) ? opts.charges : [];
  const stored = opts.category;
  const fresh = classifyAdditionalChargeReason({
    charges,
    hasCertificate: opts.hasCertificate,
    freightMismatch: opts.freightMismatch,
  });
  if (stored && stored !== fresh &&
      fresh === CHARGE_CATEGORY.ACCESSORIAL) {
    return fresh;
  }
  return stored || fresh;
}

/**
 * @param {string} category CHARGE_CATEGORY value.
 * @return {string} Human label.
 */
function categoryLabel(category) {
  switch (category) {
    case CHARGE_CATEGORY.WEIGHT_INSPECTION:
      return "Weight / Reweigh / Inspection";
    case CHARGE_CATEGORY.ACCESSORIAL:
      return "Accessorial charge";
    default:
      return "Rate increase with no stated reason";
  }
}

/**
 * @param {Array<object>} charges Charge rows.
 * @return {string} HTML list of charges.
 */
function chargesHtml(charges) {
  const rows = (Array.isArray(charges) ? charges : [])
      .map((c) =>
        `<li>${esc(displayChargeLabel(chargeLabel(c)))}: ` +
        `<strong>${money(c && c.amount)}</strong></li>`)
      .join("");
  return rows ? `<ul style="margin:6px 0 6px 18px;padding:0">${rows}</ul>` :
    "<p><em>No added lines listed.</em></p>";
}

/**
 * Picks the carrier invoice PDF from an invoice doc's attachments list
 * (GCS storagePath). Skips weight-cert / POD image docs so approval emails
 * get the bill PDF, not a certificate sidecar.
 * @param {Array<object>|null|undefined} attachments Invoice attachments.
 * @return {{filename: string, storagePath: string, mimeType: string}|null}
 */
function pickCarrierInvoiceAttachment(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  const withPath = list.filter((a) => a && a.storagePath);
  if (!withPath.length) return null;

  const skipDocType =
      /WEIGHT_INSPECTION_CERT|POD_IMAGE|TRAILER_IMAGE|^POD$/i;
  const notSidecar = withPath.filter((a) => {
    const dt = String(a.docType || "");
    return !dt || !skipDocType.test(dt);
  });
  const pool = notSidecar.length ? notSidecar : withPath;

  const pdfLike = pool.find((a) =>
    /\.pdf$/i.test(String(a.filename || "")) ||
    /pdf/i.test(String(a.mimeType || "")));
  const chosen = pdfLike || pool[0];
  if (!chosen || !chosen.storagePath) return null;
  return {
    filename: String(chosen.filename || "carrier-invoice.pdf"),
    storagePath: String(chosen.storagePath),
    mimeType: String(chosen.mimeType || "application/pdf"),
  };
}

/**
 * Builds the 5-option approval email for Sarah + the dispatcher.
 * @param {object} opts baseUrl, invoiceId, tenantId, loadNumber, carrierName,
 *   customerName, invoiceAmount, primusAmount, charges, chargesTotal,
 *   category, freightMismatch, hasCertificate, dispatcherName,
 *   rateValidation (optional W&I re-rate result), customerRate,
 *   excludedInPrimusCount (optional — charges already on file).
 * @return {{subject: string, html: string}}
 */
function buildAdditionalChargeApprovalEmail(opts) {
  const {
    baseUrl, invoiceId, tenantId, loadNumber, carrierName, customerName,
    invoiceAmount, primusAmount, charges, chargesTotal, category,
    freightMismatch, hasCertificate, dispatcherName, rateValidation,
    customerRate,
    excludedInPrimusCount,
    actionUrl: actionUrlFn,
  } = opts;

  const emailTokens = require("./email-action-tokens");
  const actionUrl = typeof actionUrlFn === "function" ?
    actionUrlFn :
    (option) => emailTokens.buildConfirmUrl({
      baseUrl,
      path: "additionalChargeAction",
      action: "additionalCharge",
      invoiceId,
      option,
      tenantId,
    });

  const btn = (option, color, label) =>
    `<p style="margin:10px 0"><a href="` +
    `${emailTokens.escapeHtmlAttr(actionUrl(option))}" ` +
    `style="background:${color};color:#ffffff;padding:10px 16px;` +
    `border-radius:6px;text-decoration:none;font-weight:600;` +
    `display:inline-block">${label}</a></p>` +
    `<p style="font-size:11px;color:#9ca3af;margin:0 0 8px">` +
    `Opens a confirmation page - nothing happens until you click ` +
    `Confirm.</p>`;

  const mm = freightMismatch || {};
  const mmDetails = mm.details || {};
  const mismatchHtml = mm.mismatch ?
    `<p style="color:#b45309"><strong>Freight mismatch vs Primus:</strong> ` +
    (mm.weightMismatch ?
      `invoice weight ${esc(String(mmDetails.invoiceWeightLbs))} lbs vs ` +
      `Primus ${esc(String(mmDetails.primusWeightLbs))} lbs. ` : "") +
    (mm.classMismatch ?
      `invoice class ${esc(String(mmDetails.invoiceClass))} vs Primus ` +
      `class ${esc(String(mmDetails.primusClass))}.` : "") +
    `</p>` : "";

  let rateHtml = "";
  if (rateValidation && rateValidation.attempted) {
    if (rateValidation.ok && rateValidation.matched) {
      rateHtml =
        `<p style="color:#166534;background:#dcfce7;padding:10px 12px;` +
        `border-radius:6px"><strong>Primus re-rate matches</strong> the ` +
        `carrier invoice within $${esc(String(rateValidation.tolerance))} ` +
        `(re-rate ${money(rateValidation.rateTotal)} vs invoice ` +
        `${money(rateValidation.invoiceAmount)}` +
        (rateValidation.quoteNumber ?
          `; quote #${esc(String(rateValidation.quoteNumber))}` : "") +
        `). The carrier's updated weight/class rate looks correct — ` +
        `decide whether to bill the customer (A/B) or absorb it (C).` +
        `</p>`;
    } else if (rateValidation.ok && !rateValidation.matched) {
      rateHtml =
        `<p style="color:#991b1b;background:#fee2e2;padding:10px 12px;` +
        `border-radius:6px"><strong>Primus re-rate does NOT match</strong> ` +
        `the carrier invoice (re-rate ${money(rateValidation.rateTotal)} ` +
        `vs invoice ${money(rateValidation.invoiceAmount)}; difference ` +
        `${money(rateValidation.difference)}, tolerance ` +
        `$${esc(String(rateValidation.tolerance))}` +
        (rateValidation.quoteNumber ?
          `; quote #${esc(String(rateValidation.quoteNumber))}` : "") +
        `). Prefer <strong>D — dispute</strong> unless you know the ` +
        `carrier rate is still valid.</p>`;
    } else {
      rateHtml =
        `<p style="color:#92400e;background:#fef3c7;padding:10px 12px;` +
        `border-radius:6px"><strong>Primus re-rate could not be ` +
        `run:</strong> ` +
        `${esc(rateValidation.error || "unknown error")}. Review manually.` +
        `</p>`;
    }
  }

  const row = (label, value) =>
    `<tr><td style="padding:4px 16px 4px 0;font-weight:600;` +
    `white-space:nowrap">${esc(label)}</td><td>${value}</td></tr>`;

  const accessorialConfirmHtml =
    category === CHARGE_CATEGORY.ACCESSORIAL ?
      `<p style="background:#eff6ff;border:1px solid #bfdbfe;` +
      `padding:12px 14px;border-radius:6px;margin:14px 0">` +
      `<strong>Dispatcher${dispatcherName ?
        ` (${esc(dispatcherName)})` : ""} — please confirm:</strong> ` +
      `Were the accessorial charge(s) below authorized on this load ` +
      `(e.g. notify detention, school delivery, notify delivery)? ` +
      `Reply to this thread or tell accounting before we bill the ` +
      `customer or dispute the carrier.</p>` : "";

  const html =
    `<p>A carrier invoice came in <strong>higher than the quoted ` +
    `amount</strong> and needs your decision.</p>` +
    `<table style="border-collapse:collapse;font-size:14px;margin:12px 0">` +
    row("Load #", esc(String(loadNumber || "—"))) +
    row("Carrier", esc(carrierName || "—")) +
    row("Customer", esc(customerName || "—")) +
    row("Customer rate (Primus)", formatCustomerRate(customerRate)) +
    row("Carrier invoice", money(invoiceAmount)) +
    row("Amount on file (Primus)", money(primusAmount)) +
    row("Difference (invoice minus Primus)", money(chargesTotal)) +
    row("Reason (detected)", esc(categoryLabel(category))) +
    (hasCertificate ?
      row("W&I certificate", "Attached / referenced on invoice") : "") +
    (dispatcherName ? row("Dispatcher", esc(dispatcherName)) : "") +
    `</table>` +
    accessorialConfirmHtml +
    mismatchHtml +
    rateHtml +
    `<p><strong>Lines on the invoice (not the difference):</strong></p>` +
    chargesHtml(charges) +
    (Number(excludedInPrimusCount) > 0 ?
      `<p style="font-size:12px;color:#6b7280"><em>` +
      `${esc(String(excludedInPrimusCount))} charge(s) already on file ` +
      `in Primus were excluded from this list.</em></p>` : "") +
    `<hr style="border:none;border-top:1px solid #e5e7eb;margin:18px 0">` +
    `<p><strong>Choose one:</strong></p>` +
    btn("a", "#16a34a",
        "A - Approve: pay carrier + bill customer (auto-email customer)") +
    btn("b", "#0d9488",
        "B - Approve: pay carrier + bill customer " +
        "(enter updated rate; dispatcher notifies customer)") +
    btn("c", "#2563eb",
        "C - Approve: pay carrier only (customer rate unchanged)") +
    btn("d", "#dc2626",
        "D - Not approved: dispute with carrier") +
    btn("e", "#7c3aed",
        "E - Approve: pay carrier + bill customer " +
        "(enter amount; apply rate; no separate customer notification)") +
    `<p style="font-size:12px;color:#6b7280">A: enter how much to charge the ` +
    `customer on the confirm page; the customer rate is bumped by that ` +
    `amount and the customer is emailed. B: the base customer rate stays ` +
    `the same - enter each accessorial and the amount to bill the customer ` +
    `on separate lines; the dispatcher gets a ready customer-notification ` +
    `template. C: the carrier bill is entered at the full carrier amount ` +
    `and the customer rate stays the same (no itemization needed). D: Jerry ` +
    `will draft the wording for manual submission. E: like A (enter amount ` +
    `and bump the customer rate) but no separate customer notification - ` +
    `the charge is included when the customer invoice is sent.` +
    `</p>`;

  return {
    subject: toOutboundEmailSafeSubject(
        `Approval needed - additional charge on Load ${loadNumber} ` +
        `(${categoryLabel(category)})`),
    html: toOutboundEmailSafeText(html),
  };
}

/**
 * Builds a carrier dispute draft for manual submission. Most LTL carriers
 * take disputes on their website portal, so this is copy/paste wording; TL
 * disputes go to the carrier email on file.
 * @param {object} opts loadNumber, carrierName, proNumber, invoiceNumber,
 *   invoiceAmount, expectedAmount, charges, category, freightMismatch.
 * @return {{subject: string, html: string}}
 */
function buildDisputeEmailDraft(opts) {
  const {
    loadNumber, carrierName, proNumber, invoiceNumber,
    invoiceAmount, expectedAmount, charges, category, freightMismatch,
    customerRate, hasCertificate,
  } = opts;

  const effectiveCategory = resolveEffectiveChargeCategory({
    charges,
    category,
    freightMismatch,
    hasCertificate,
  });

  const mm = freightMismatch || {};
  const mmDetails = mm.details || {};
  const diff = (Number(invoiceAmount) || 0) - (Number(expectedAmount) || 0);

  let basis;
  if (effectiveCategory === CHARGE_CATEGORY.WEIGHT_INSPECTION) {
    if (mm.mismatch) {
      basis =
        `The invoice reflects a reweigh/reclassification that does not ` +
        `match our shipment records` +
        (mmDetails.primusWeightLbs ?
          ` (our records: ${mmDetails.primusWeightLbs} lbs` +
          (mmDetails.primusClass ? `, class ${mmDetails.primusClass}` : "") +
          `; invoice: ` +
          (mmDetails.invoiceWeightLbs ?
            `${mmDetails.invoiceWeightLbs} lbs` : "n/a") +
          (mmDetails.invoiceClass ?
            `, class ${mmDetails.invoiceClass}` : "") + `)` : "") +
        `. Please provide the weight & inspection certificate supporting ` +
        `this change or correct the invoice to the quoted rate.`;
    } else {
      basis =
        `The invoice includes a reweigh/reclassification or inspection ` +
        `charge without documentation we can match to this shipment. ` +
        `Please provide the weight & inspection certificate supporting ` +
        `this change or correct the invoice to the quoted rate.`;
    }
  } else if (effectiveCategory === CHARGE_CATEGORY.ACCESSORIAL) {
    const names = (Array.isArray(charges) ? charges : [])
        .map((c) => displayChargeLabel(chargeLabel(c)))
        .filter(Boolean);
    const chargeList = names.length ?
      names.join(", ") :
      "the listed accessorial charge(s)";
    basis =
      `The invoice includes accessorial charge(s) that were not ` +
      `authorized on this shipment (${chargeList}). Please remove the ` +
      `unauthorized charge(s) or provide documentation showing prior approval.`;
  } else {
    basis =
      `The invoiced amount exceeds the rate quoted/agreed for this ` +
      `shipment with no supporting reason on the invoice. Please correct ` +
      `the invoice to the agreed rate or provide documentation for the ` +
      `increase.`;
  }

  const chargeLines = (Array.isArray(charges) ? charges : [])
      .map((c) => `- ${displayChargeLabel(chargeLabel(c))}: ` +
        `${money(c && c.amount)}`)
      .join("<br>");

  const disputeText =
    `To: ${carrierName || "Carrier"} — Billing / Disputes<br><br>` +
    `RE: Invoice ${invoiceNumber || "—"}` +
    (proNumber ? ` / PRO ${proNumber}` : "") +
    ` — our reference/BOL ${loadNumber || "—"}<br><br>` +
    `We are disputing the above invoice in the amount of ` +
    `${money(invoiceAmount)}. Our records show an expected amount of ` +
    `${money(expectedAmount)} (difference ${money(Math.abs(diff))}).<br><br>` +
    `${basis}<br><br>` +
    (chargeLines ? `Disputed charge(s):<br>${chargeLines}<br><br>` : "") +
    `Please review and issue a corrected invoice. Payment for the ` +
    `undisputed portion is being processed per our standard terms.<br><br>` +
    `Thank you,<br>Innovative Carriers — Accounting`;

  const html =
    `<p>Dispute draft for <strong>${esc(carrierName || "carrier")}</strong> ` +
    `— Load ${esc(String(loadNumber || "—"))}` +
    (customerRate != null && Number(customerRate) > 0 ?
      ` (customer rate in Primus: ${formatCustomerRate(customerRate)})` : "") +
    `. For LTL carriers, paste ` +
    `this into the carrier's dispute portal; for TL, email it to the ` +
    `carrier contact on file.</p>` +
    `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;` +
    `background:#f9fafb;font-size:14px">${disputeText}</div>` +
    `<p style="font-size:12px;color:#6b7280">Adjust the wording as needed ` +
    `— each dispute basis is different. This load is on the Additional ` +
    `Charges Follow-Up list until resolved.</p>`;

  return {
    subject: toOutboundEmailSafeSubject(
        `Dispute draft - ${carrierName || "carrier"} invoice on ` +
        `Load ${loadNumber}`),
    html: toOutboundEmailSafeText(html),
  };
}

/**
 * Customer notification for decision A (bill the customer, auto email).
 * @param {object} opts customerName, loadNumber, charges, chargesTotal,
 *   category.
 * @return {{subject: string, html: string}}
 */
function noticeChargeLines(charges) {
  const split = stripFreightBreakdownCharges(charges);
  return split.kept.filter((row) => chargeLabel(row));
}

function measurementLinesHtml(opts, lines) {
  const blob = lines.map((row) => chargeLabel(row)).join(" ");
  const measure = /reweigh|re-weigh|reclass|re-class|redim|re-dim|dimension/i
      .test(blob);
  if (!measure) return "";
  const details = (opts.freightMismatch && opts.freightMismatch.details) ||
    {};
  const bits = [];
  if (details.primusWeightLbs) {
    bits.push(`Original weight: ${esc(String(details.primusWeightLbs))} lbs`);
  }
  if (details.invoiceWeightLbs) {
    bits.push(`Updated weight: ${esc(String(details.invoiceWeightLbs))} lbs`);
  }
  if (opts.originalDims) {
    bits.push(`Original dimensions: ${esc(String(opts.originalDims))}`);
  }
  if (opts.updatedDims) {
    bits.push(`Updated dimensions: ${esc(String(opts.updatedDims))}`);
  }
  if (!bits.length) return "";
  return bits.map((line) => `<div>${line}</div>`).join("");
}

/**
 * Shared customer and dispatcher notice. Total is the invoice difference.
 * @param {object} opts customerName, loadNumber, charges, chargesTotal.
 * @return {{subject: string, html: string}}
 */
function buildAdditionalChargeNoticeEmail(opts) {
  const customerName = opts.customerName;
  const loadNumber = opts.loadNumber;
  const lines = noticeChargeLines(opts.charges);
  const listed = lines.length ? lines : [];
  const lineHtml = listed.map((row) => {
    const amt = Number(row && row.amount);
    const amount = Number.isFinite(amt) ? `: ${money(amt)}` : "";
    const label = esc(displayChargeLabel(chargeLabel(row)));
    return `<div>${label}${amount}</div>`;
  }).join("");
  const total = opts.chargesTotal != null ? opts.chargesTotal :
    sumCustomerBillLines(listed);
  const html =
    `<p>Hello${customerName ? ` ${esc(customerName)}` : ""},</p>` +
    `<p>We wanted to make you aware that the carrier has applied an ` +
    `additional charge to this shipment for the following:</p>` +
    (lineHtml || `<div>Additional charge</div>`) +
    measurementLinesHtml(opts, listed) +
    `<p>Total Additional Charges: <strong>${money(total)}</strong></p>` +
    `<p>If you have any questions, please feel free to reach out.</p>`;
  return {
    subject: toOutboundEmailSafeSubject(
        `Additional charge on shipment ${loadNumber}`),
    html: toOutboundEmailSafeText(html),
  };
}

function buildCustomerChargeNotificationEmail(opts) {
  return buildAdditionalChargeNoticeEmail(opts);
}

/**
 * Option A bills each accessorial on its own customer-invoice line.
 * The freight rate is left unchanged.
 * @param {object} opts baseRate, billLines.
 * @return {object}
 */
function planOptionACustomerBilling(opts) {
  const rawBase = Number(opts && opts.baseRate);
  const baseRate = Math.round(rawBase * 100) / 100;
  const hasBase = Number.isFinite(baseRate) && baseRate > 0;
  const billLines = Array.isArray(opts && opts.billLines) ? opts.billLines : [];
  const total = Math.round(sumCustomerBillLines(billLines) * 100) / 100;
  const invoiceLines = customerInvoiceChargeLines(
      hasBase ? baseRate : 0, billLines);
  let note = hasBase ?
    `Base customer rate stays $${baseRate.toFixed(2)}.` :
    "Base customer rate unchanged.";
  if (billLines.length) {
    note += ` Billing ${billLines.length} accessorial line(s)` +
      ` ($${total.toFixed(2)}) as separate invoice lines.`;
  }
  return {
    bumpFreight: false,
    customerRate: hasBase ? baseRate : null,
    customerBillLines: billLines,
    customerBillAccessorialTotal: total,
    customerChargeAmount: total,
    invoiceLines,
    note,
  };
}

/**
 * Freight stays the sell rate. Each accessorial is its own charge line.
 * @param {number} customerRate Freight rate.
 * @param {Array<object>} customerBillLines Accessorial lines.
 * @return {Array<object>}
 */
function customerInvoiceChargeLines(customerRate, customerBillLines) {
  const freight = Math.round(Number(customerRate || 0) * 100) / 100;
  const lines = [{
    kind: "freight",
    description: "FREIGHT CHARGE",
    rate: Number.isFinite(freight) ? freight : 0,
  }];
  (Array.isArray(customerBillLines) ? customerBillLines : []).forEach(
      (line) => {
        const amount = Math.round(Number(line && line.amount) * 100) / 100;
        if (!Number.isFinite(amount) || amount <= 0) return;
        const name = String(
            (line && (line.name || line.label)) || "ACCESSORIAL")
            .trim().toUpperCase();
        lines.push({
          kind: "accessorial",
          description: name,
          code: line && line.code ? String(line.code) : "",
          rate: amount,
        });
      });
  return lines;
}

/**
 * Dashboard-ops mode parks internal mail. The customer additional-charge
 * notice, the dispatcher copy of that notice, customer bills, and a few
 * ops digests still go out.
 * @param {object} email Outbound email payload.
 * @return {boolean}
 */
function mustDeliverDespiteDashboardPark(email) {
  if (!email || typeof email !== "object") return false;
  if (email.forceSend === true) return true;
  const type = String(email.type || "");
  return type === "dashboard_notification_digest" ||
    type === "dashboard_assignment" ||
    type === "additional_charge_customer_notice" ||
    type === "additional_charge_dispatcher_task";
}

/**
 * @param {object} opts decision, finalWorkflowStatus.
 * @return {boolean}
 */
function shouldCloseAdditionalChargeTask(opts) {
  const decision = String((opts && opts.decision) || "").toUpperCase();
  const wf = String((opts && opts.finalWorkflowStatus) || "");
  if (decision !== "A" && decision !== "B" &&
      decision !== "C" && decision !== "E") {
    return false;
  }
  return wf === "completed" ||
    wf === "completed_no_customer_email" ||
    wf === "completed_carrier_bill_only";
}

/**
 * Ready-to-forward customer email body for option B (dispatcher sends it).
 * @param {object} opts loadNumber, customerName, carrierName, chargesTotal,
 *   customerRate, customerBillLines, newCustomerRate.
 * @return {{subject: string, html: string}}
 */
function buildDispatcherCustomerNotifyTemplate(opts) {
  const carrier = Array.isArray(opts.charges) ? opts.charges : [];
  const billed = Array.isArray(opts.customerBillLines) ?
    opts.customerBillLines.map((line) => ({
      label: line.name || line.label,
      amount: line.amount,
    })) : [];
  return buildAdditionalChargeNoticeEmail({
    customerName: opts.customerName,
    loadNumber: opts.loadNumber,
    charges: carrier.length ? carrier : billed,
    chargesTotal: opts.chargesTotal,
    freightMismatch: opts.freightMismatch,
    originalDims: opts.originalDims,
    updatedDims: opts.updatedDims,
  });
}

/**
 * Dispatcher reminder for decision B (dispatcher must notify the customer).
 * Includes a ready-to-send customer notification template.
 * @param {object} opts dispatcherName, loadNumber, carrierName, customerName,
 *   charges, chargesTotal.
 * @return {{subject: string, html: string}}
 */
function buildDispatcherNotifyReminderEmail(opts) {
  return buildDispatcherCustomerNotifyTemplate(opts);
}

/**
 * Finds an unresolved follow-up for the same load, amount, and reason.
 * @param {object} db Firestore.
 * @param {object} data Incoming follow-up fields.
 * @return {Promise<string|null>}
 */
async function findUnresolvedDuplicateFollowUp(db, data) {
  const dedupe = require("./dashboard-dedupe");
  const loadNumber = String(data.loadNumber || "").trim();
  if (!loadNumber) return null;
  const snap = await db.collection(FOLLOW_UP_COLLECTION)
      .where("loadNumber", "==", loadNumber)
      .limit(200)
      .get();
  const incoming = {
    type: "additional_charge",
    loadNumber,
    reason: data.category || null,
    chargesTotal: data.chargesTotal,
  };
  let best = null;
  const ownership = require("./dashboard-ownership");
  for (const doc of snap.docs) {
    const row = doc.data() || {};
    if (row.resolved === true) continue;
    if (!ownership.sameTenant(row.tenantId, data.tenantId || "default")) {
      continue;
    }
    const candidate = {
      type: "additional_charge",
      loadNumber: row.loadNumber,
      reason: row.category || null,
      chargesTotal: row.chargesTotal,
      chargePhase: row.chargePhase || null,
      followUpStatus: row.status || null,
      createdAt: row.createdAt && row.createdAt.toDate ?
        row.createdAt.toDate().toISOString() : null,
      receivedAt: row.receivedAt && row.receivedAt.toDate ?
        row.receivedAt.toDate().toISOString() : null,
    };
    if (!dedupe.sameExactCharge(incoming, candidate)) continue;
    if (!best ||
        dedupe.compareDuplicatePreference(candidate, best.item) > 0) {
      best = {id: doc.id, item: candidate};
    }
  }
  return best ? best.id : null;
}

/**
 * Creates a follow-up entry so the charge is tracked until resolved.
 * Reuses an unresolved follow-up for the same charge.
 * @param {object} db Firestore instance.
 * @param {object} data loadNumber, carrierName, customerName, invoiceId,
 *   category, charges, chargesTotal, invoiceAmount, status, notes.
 * @return {Promise<string>} Follow-up doc id.
 */
async function createFollowUp(db, data) {
  const MAX_BODY = 120000;
  let emailHtml = data.emailHtml != null ? String(data.emailHtml) : null;
  if (emailHtml && emailHtml.length > MAX_BODY) {
    emailHtml = emailHtml.slice(0, MAX_BODY);
  }
  const ownership = require("./dashboard-ownership");
  const owner = ownership.ownershipFieldsForCreate({
    to: data.emailTo,
    cc: data.emailCc,
    type: "additional_charge",
    dispatcherEmail: data.dispatcherEmail,
    dispatcherName: data.dispatcherName,
    ownerBucket: data.ownerBucket,
  });
  let docId = null;
  try {
    docId = await findUnresolvedDuplicateFollowUp(db, data);
  } catch (dedupeErr) {
    console.error("[createFollowUp] dedupe lookup failed:", dedupeErr.message);
  }
  if (docId) {
    console.log("[createFollowUp] exact duplicate open charge — reused",
        docId, data.loadNumber || "", data.chargesTotal, data.category || "");
    if (data.status === FOLLOW_UP_STATUS.DISPUTING) {
      await db.collection(FOLLOW_UP_COLLECTION).doc(docId).update({
        status: FOLLOW_UP_STATUS.DISPUTING,
        chargePhase: "dispute",
        resolved: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  } else {
    const doc = await db.collection(FOLLOW_UP_COLLECTION).add({
      loadNumber: data.loadNumber || null,
      carrierName: data.carrierName || null,
      customerName: data.customerName || null,
      invoiceId: data.invoiceId || null,
      tenantId: data.tenantId || "default",
      category: data.category || null,
      charges: Array.isArray(data.charges) ? data.charges : [],
      chargesTotal: Number(data.chargesTotal) || 0,
      invoiceAmount: Number(data.invoiceAmount) || 0,
      status: data.status || FOLLOW_UP_STATUS.PENDING_APPROVAL,
      decision: null,
      decisionAt: null,
      notes: data.notes || null,
      emailHtml,
      emailSubject: data.emailSubject || null,
      emailTo: data.emailTo || null,
      emailCc: data.emailCc || null,
      ...owner,
      ...require("./dashboard-email-files").fieldsForCreate({
        receivedAt: data.receivedAt || data.emailReceivedAt || null,
        receivedAtSource: data.receivedAtSource || "mailbox",
        attachments: data.attachments,
      }),
      resolved: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    docId = doc.id;
  }

  if (data.skipDashboardTask !== true) {
    try {
      const dashboardTasks = require("./dashboard-tasks");
      await dashboardTasks.createDashboardTask(db, {
        tenantId: data.tenantId || "default",
        type: dashboardTasks.TASK_TYPE.ADDITIONAL_CHARGE,
        title: `Additional charge - Load ${data.loadNumber || "-"}`,
        description: data.notes || null,
        body: emailHtml,
        subject: data.emailSubject || null,
        to: data.emailTo || null,
        cc: data.emailCc || null,
        loadNumber: data.loadNumber || null,
        carrierName: data.carrierName || null,
        invoiceId: data.invoiceId || null,
        followUpId: docId,
        messageId: data.messageId || null,
        reason: data.category || data.status || null,
        chargesTotal: data.chargesTotal || null,
        dispatcherEmail: owner.dispatcherEmail,
        dispatcherName: owner.dispatcherName,
        ownerBucket: owner.ownerBucket,
        receivedAt: data.receivedAt || data.emailReceivedAt || null,
        receivedAtSource: data.receivedAtSource || "mailbox",
        attachments: data.attachments,
      });
    } catch (taskErr) {
      console.error("[createFollowUp] dashboard task failed:", taskErr.message);
    }
  }

  return docId;
}

/**
 * Updates a follow-up entry (by id, or by invoiceId lookup when id unknown).
 * @param {object} db Firestore instance.
 * @param {object} opts followUpId or invoiceId; status, decision, notes.
 * @return {Promise<void>}
 */
async function updateFollowUp(db, opts) {
  let ref = null;
  if (opts.followUpId) {
    ref = db.collection(FOLLOW_UP_COLLECTION).doc(opts.followUpId);
  } else if (opts.invoiceId) {
    const snap = await db.collection(FOLLOW_UP_COLLECTION)
        .where("invoiceId", "==", opts.invoiceId)
        .limit(1).get();
    if (!snap.empty) ref = snap.docs[0].ref;
  }
  if (!ref) return;
  const update = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (opts.status) {
    update.status = opts.status;
    update.resolved = opts.status === FOLLOW_UP_STATUS.RESOLVED;
  }
  if (opts.decision) {
    update.decision = opts.decision;
    update.decisionAt = admin.firestore.FieldValue.serverTimestamp();
  }
  if (opts.notes) update.notes = opts.notes;
  await ref.update(update);
}

/**
 * @param {Array<object>} lines Customer bill lines {name, amount}.
 * @return {number}
 */
function sumCustomerBillLines(lines) {
  return (Array.isArray(lines) ? lines : [])
      .reduce((sum, line) => sum + (Number(line && line.amount) || 0), 0);
}

/**
 * @param {Array<object>} lines Customer bill lines.
 * @return {string}
 */
function customerBillLinesHtml(lines) {
  const rows = (Array.isArray(lines) ? lines : [])
      .map((line) =>
        `<li>${esc(String(line.name || "Accessorial"))}: ` +
        `<strong>${money(line.amount)}</strong></li>`)
      .join("");
  return rows ?
    `<ul style="margin:6px 0 6px 18px;padding:0">${rows}</ul>` :
    "";
}

/**
 * @param {Array<object>} lines Raw line objects.
 * @return {object} Normalized lines payload.
 */
function computeCustomerChargeAmount(row) {
  const line = row || {};
  const flatRaw = line.flatAmount;
  const hasFlat = flatRaw != null && String(flatRaw).trim() !== "";
  if (hasFlat || line.pricingMode === "flat") {
    const flat = Math.round(Number(hasFlat ? flatRaw : line.amount) * 100) /
      100;
    if (!Number.isFinite(flat) || flat <= 0) {
      return {ok: false, error: "Flat customer charge must be greater than 0."};
    }
    return {
      ok: true, amount: flat, pricingMode: "flat",
      flatAmount: flat, markupPct: null,
    };
  }
  const pctRaw = line.markupPct;
  const hasPct = pctRaw != null && String(pctRaw).trim() !== "";
  if (hasPct || line.pricingMode === "markup") {
    const pct = Number(hasPct ? pctRaw : line.markupPct);
    const carrier = Math.round(Number(line.carrierAmount) * 100) / 100;
    if (!Number.isFinite(pct) || pct < 0) {
      return {ok: false, error: "Markup percent must be 0 or greater."};
    }
    if (!Number.isFinite(carrier) || carrier <= 0) {
      return {
        ok: false,
        error: "Carrier cost is required when using a percent markup.",
      };
    }
    const amount = Math.round(carrier * (1 + pct / 100) * 100) / 100;
    return {
      ok: true, amount, pricingMode: "markup",
      markupPct: pct, flatAmount: null,
    };
  }
  const amount = Math.round(Number(line.amount) * 100) / 100;
  if (Number.isFinite(amount) && amount > 0) {
    return {
      ok: true, amount, pricingMode: "amount",
      markupPct: null, flatAmount: amount,
    };
  }
  return {
    ok: false,
    error: "Enter a percent markup or a flat customer charge.",
  };
}

function normalizeCustomerBillLines(lines) {
  const out = [];
  for (const line of (Array.isArray(lines) ? lines : [])) {
    const name = String(
        line && (line.name || line.label || line.description) || "").trim();
    if (!name) continue;
    const priced = computeCustomerChargeAmount(line);
    if (!priced.ok) {
      return {ok: false, error: `${priced.error} (${name})`};
    }
    const carrier = Math.round(Number(line && line.carrierAmount) * 100) / 100;
    const code = String((line && line.code) || "").trim().toUpperCase();
    out.push({
      name,
      code: code || null,
      amount: priced.amount,
      carrierAmount: Number.isFinite(carrier) && carrier > 0 ? carrier : 0,
      pricingMode: priced.pricingMode,
      markupPct: priced.markupPct,
      flatAmount: priced.flatAmount,
    });
  }
  if (!out.length) {
    return {
      ok: false,
      error: "Enter at least one accessorial with a percent markup or " +
        "flat customer charge.",
    };
  }
  return {ok: true, lines: out, total: sumCustomerBillLines(out)};
}

/**
 * @param {object} body POST body from the confirm form.
 * @return {object} Parsed customer charge amount payload.
 */
function parseCustomerChargeAmountFromRequest(body) {
  const raw = body && (body.customerChargeAmount != null ?
    body.customerChargeAmount : body.customer_charge_amount);
  const amount = Math.round(Number(raw) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false,
      error: "Enter a customer charge amount greater than 0.",
    };
  }
  return {ok: true, amount};
}

/**
 * @param {object} body POST body from the confirm form.
 * @return {object} Parsed customer bill lines payload.
 */
function parseCustomerBillLinesFromRequest(body) {
  const raw = body && body.customerBillLinesJson;
  if (!raw) {
    return {ok: false, error: "Missing accessorial billing lines."};
  }
  try {
    const parsed = JSON.parse(String(raw));
    return normalizeCustomerBillLines(parsed);
  } catch (_) {
    return {ok: false, error: "Could not read accessorial billing lines."};
  }
}

/**
 * Seeds Option B rows from carrier-detected charge lines.
 * @param {Array<object>} charges Carrier charge rows.
 * @return {Array<object>}
 */
function seedCustomerBillLinesFromCharges(charges) {
  const rows = (Array.isArray(charges) ? charges : []).map((charge) => ({
    name: displayChargeLabel(chargeLabel(charge)),
    amount: "",
    carrierAmount: Number(charge && charge.amount) || 0,
  }));
  if (rows.length) return rows;
  return [{name: "", amount: "", carrierAmount: 0}];
}

/**
 * Option B confirm page — itemized customer accessorial billing.
 * @param {object} opts form options.
 * @return {string} HTML page.
 */
function buildOptionBAccessorialConfirmPage(opts) {
  const fields = opts.fields || {};
  const btnColor = opts.confirmColor || "#0d9488";
  const formAction = `${opts.baseUrl}/${opts.actionPath}`;
  const hidden = Object.entries(fields)
      .map(([name, value]) =>
        `<input type="hidden" name="${esc(name)}" ` +
        `value="${esc(String(value ?? ""))}">`)
      .join("");
  const baseRate = Number(opts.baseCustomerRate) || 0;
  const seedRows = seedCustomerBillLinesFromCharges(opts.carrierCharges);
  const seedJson = JSON.stringify(seedRows)
      .replace(/</g, "\\u003c")
      .replace(/-->/g, "--\\u003e");
  const catalogJson = JSON.stringify(
      Array.isArray(opts.accessorialOptions) ? opts.accessorialOptions : [])
      .replace(/</g, "\\u003c")
      .replace(/-->/g, "--\\u003e");
  const baseRateHtml = baseRate > 0 ?
    `<p style="font-size:14px;color:#374151;margin:12px 0">` +
    `<strong>Base customer rate (unchanged):</strong> ` +
    `${formatCustomerRate(baseRate)}</p>` :
    `<p style="font-size:14px;color:#374151;margin:12px 0">` +
    `The base customer freight rate will stay as-is in Primus. For each ` +
    `accessorial, pick it from the Primus list, then enter a percent ` +
    `markup or a flat customer charge. Use Add accessorial for a charge ` +
    `Jerry did not list.` +
    `</p>`;
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(opts.title || "Confirm option B")}</title>` +
    `<style>` +
    `.bill-row{display:grid;grid-template-columns:1fr 160px 32px;gap:8px;` +
    `align-items:start;margin-bottom:10px}` +
    `.bill-row input{width:100%;padding:10px 12px;border:1px solid #d1d5db;` +
    `border-radius:8px;font-size:16px;box-sizing:border-box}` +
    `.bill-hint{font-size:12px;color:#6b7280;margin-top:4px}` +
    `.add-btn{background:#fff;color:#0d9488;border:1px solid #0d9488;` +
    `padding:8px 12px;border-radius:8px;font-size:14px;cursor:pointer}` +
    `.remove-btn{background:#fff;color:#dc2626;border:1px solid #fecaca;` +
    `border-radius:8px;width:32px;height:42px;cursor:pointer}` +
    `</style></head>` +
    `<body style="font-family:Arial,sans-serif;max-width:560px;` +
    `margin:48px auto;padding:0 16px;color:#111827">` +
    `<h1 style="font-size:22px;margin-bottom:12px">` +
    `${esc(opts.title || "Confirm option B")}</h1>` +
    `<p style="font-size:16px;color:#374151;line-height:1.5">` +
    `${opts.description || ""}</p>` +
    baseRateHtml +
    `<form method="POST" action="${esc(formAction)}" id="option-b-form" ` +
    `style="margin-top:16px">` +
    hidden +
    `<input type="hidden" name="customerBillLinesJson" ` +
    `id="customerBillLinesJson">` +
    `<input type="hidden" id="allowEmptyLines" value="` +
    `${opts.allowEmpty ? "1" : "0"}">` +
    `<p style="font-size:14px;font-weight:600;color:#374151;` +
    `margin-bottom:8px">` +
    `Accessorials to bill the customer</p>` +
    `<div id="bill-lines"></div>` +
    `<button type="button" class="add-btn" id="add-bill-line">` +
    `+ Add accessorial</button>` +
    `<div style="margin-top:20px">` +
    `<button type="submit" style="background:${btnColor};color:#fff;` +
    `border:none;padding:12px 20px;border-radius:8px;font-size:16px;` +
    `font-weight:600;cursor:pointer">` +
    `${esc(opts.confirmLabel || "Confirm option B")}</button>` +
    `</div></form>` +
    `<p style="font-size:13px;color:#9ca3af;margin-top:20px">` +
    `If you did not request this, close this page - nothing has been ` +
    `changed yet.</p>` +
    `<script>` +
    `const seedRows = ${seedJson};` +
    `const catalog = ${catalogJson};` +
    `const container = document.getElementById("bill-lines");` +
    `function escAttr(v){return String(v ?? "").replace(/&/g,"&amp;")` +
    `.replace(/"/g,"&quot;").replace(/</g,"&lt;");}` +
    `function normName(v){return String(v||"").toLowerCase()` +
    `.replace(/[^a-z0-9]/g,"");}` +
    `function addRow(row={}){` +
    `const wrap=document.createElement("div");wrap.className="bill-row";` +
    `const carrier=Number(row.carrierAmount)||0;` +
    `const sel=document.createElement("select");sel.className="bill-name";` +
    `const blank=document.createElement("option");blank.value="";` +
    `blank.textContent="Select accessorial";sel.appendChild(blank);` +
    `const want=normName(row.name);const wantCode=String(row.code||"");` +
    `let matched=false;` +
    `for(const item of catalog){` +
    `const opt=document.createElement("option");` +
    `opt.value=item.code||"";opt.dataset.name=item.name||"";` +
    `opt.textContent=(item.category?item.category+" — ":"")+item.name;` +
    `if((wantCode&&item.code===wantCode)||` +
    `(!wantCode&&want&&normName(item.name)===want)){` +
    `opt.selected=true;matched=true;}` +
    `sel.appendChild(opt);}` +
    `if(want&&!matched){` +
    `const opt=document.createElement("option");opt.value="";` +
    `opt.dataset.name=row.name;opt.selected=true;` +
    `opt.textContent=row.name+" (from the invoice)";` +
    `sel.appendChild(opt);}` +
    `const nameCell=document.createElement("div");nameCell.appendChild(sel);` +
    `const carrierInput=document.createElement("input");` +
    `carrierInput.className="bill-carrier";carrierInput.type="number";` +
    `carrierInput.min="0";carrierInput.step="0.01";` +
    `carrierInput.placeholder="Carrier $";` +
    `if(carrier>0)carrierInput.value=carrier.toFixed(2);` +
    `const hint=document.createElement("div");hint.className="bill-hint";` +
    `hint.textContent="Carrier cost, then percent or flat customer charge";` +
    `nameCell.appendChild(carrierInput);nameCell.appendChild(hint);` +
    `const price=document.createElement("div");` +
    `price.innerHTML="<select class=\\"bill-mode\\">` +
    `<option value=\\"markup\\">Percent markup</option>` +
    `<option value=\\"flat\\">Flat amount</option></select>"+` +
    `"<input type=\\"number\\" class=\\"bill-value\\" min=\\"0\\" ` +
    `step=\\"0.01\\" placeholder=\\"20\\">";` +
    `const remove=document.createElement("button");` +
    `remove.type="button";remove.className="remove-btn";` +
    `remove.title="Remove";remove.textContent="×";` +
    `remove.onclick=()=>{wrap.remove();};` +
    `wrap.appendChild(nameCell);wrap.appendChild(price);` +
    `wrap.appendChild(remove);container.appendChild(wrap);}` +
    `(seedRows.length?seedRows:[{name:"",carrierAmount:0}]).forEach(addRow);` +
    `document.getElementById("add-bill-line").onclick=` +
    `()=>addRow({name:"",carrierAmount:0});` +
    `document.getElementById("option-b-form").onsubmit=(e)=>{` +
    `const lines=[];` +
    `for(const row of container.querySelectorAll(".bill-row")){` +
    `const sel=row.querySelector(".bill-name");` +
    `const opt=sel.options[sel.selectedIndex];` +
    `const name=(opt&&opt.dataset.name||"").trim();` +
    `const code=sel.value||"";` +
    `if(!name)continue;` +
    `const carrierAmount=Number(row.querySelector(".bill-carrier").value)||0;` +
    `const mode=row.querySelector(".bill-mode").value;` +
    `const val=Number(row.querySelector(".bill-value").value);` +
    `if(mode==="flat"){` +
    `if(!(val>0)){alert("Enter a flat customer charge for "+name);` +
    `e.preventDefault();return false;}` +
    `lines.push({name,code,carrierAmount,pricingMode:"flat",flatAmount:val,` +
    `markupPct:null,amount:val});` +
    `}else{` +
    `if(!(carrierAmount>0)||!(val>=0)){` +
    `alert("Enter a markup percent for "+name);` +
    `e.preventDefault();return false;}` +
    `const amount=Math.round(carrierAmount*(1+val/100)*100)/100;` +
    `lines.push({name,code,carrierAmount,pricingMode:"markup",markupPct:val,` +
    `flatAmount:null,amount});}}` +
    `const allowEmpty=document.getElementById("allowEmptyLines");` +
    `if(!lines.length&&!(allowEmpty&&allowEmpty.value==="1")){` +
    `alert("Enter a percent markup or a flat charge, or add an accessorial.");` +
    `e.preventDefault();return false;}` +
    `document.getElementById("customerBillLinesJson").value=` +
    `JSON.stringify(lines);return true;};` +
    `</script></body></html>`;
}

module.exports = {
  FOLLOW_UP_COLLECTION,
  FOLLOW_UP_STATUS,
  CHARGE_CATEGORY,
  RATE_MATCH_TOLERANCE,
  MIN_IGNORABLE_CHARGE_AMOUNT,
  LISA_EMAIL,
  mergeLisaOnCc,
  applyAdditionalChargeEmailCc,
  applyDispatcherEmailCc,
  formatCustomerRate,
  isWeightInspectionLabel,
  isAccessorialLabel,
  isFreightBreakdownLabel,
  stripFreightBreakdownCharges,
  invoiceOverage,
  reportedChargeDifference,
  displayChargeLabel,
  sumCharges,
  normalizeBreakdownText,
  chargeBreakdownKeywords,
  isChargeInPrimusBreakdown,
  filterIgnorableSmallCharges,
  partitionChargesByPrimus,
  filterChargesForApproval,
  detectFreightMismatch,
  buildRequoteFreightInfo,
  buildRateQueryFromBooking,
  evaluateRequoteMatch,
  classifyAdditionalChargeReason,
  validateLumperAmount,
  LUMPER_BASE_TOLERANCE,
  resolveEffectiveChargeCategory,
  categoryLabel,
  pickCarrierInvoiceAttachment,
  buildAdditionalChargeApprovalEmail,
  buildDisputeEmailDraft,
  buildCustomerChargeNotificationEmail,
  planOptionACustomerBilling,
  customerInvoiceChargeLines,
  mustDeliverDespiteDashboardPark,
  shouldCloseAdditionalChargeTask,
  buildDispatcherCustomerNotifyTemplate,
  buildDispatcherNotifyReminderEmail,
  buildOptionBAccessorialConfirmPage,
  customerBillLinesHtml,
  sumCustomerBillLines,
  normalizeCustomerBillLines,
  computeCustomerChargeAmount,
  parseCustomerChargeAmountFromRequest,
  parseCustomerBillLinesFromRequest,
  seedCustomerBillLinesFromCharges,
  createFollowUp,
  updateFollowUp,
};
