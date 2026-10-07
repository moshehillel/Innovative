/**
 * Additional-charge handling for carrier invoices that exceed the quoted
 * amount (per accounting's documented process):
 *
 *   A. Identify the reason — accessorial, weight/reweigh/inspection, or a
 *      rate increase with no reason.
 *   B. Weight/Reweigh/Inspection is identified by: a fee with W&I wording,
 *      an attached W&I certificate, or the invoice weight/class/dims
 *      differing from the Primus booking. A whole new invoice that
 *      replaces the quote (weight or dims changed) is the same case.
 *      Jerry re-quotes Primus with the updated weight and dims. The
 *      additional charge on the email is invoice total minus the Primus
 *      quoted total, and the email says whether that new quote matches
 *      the carrier invoice. The inspection certificate is uploaded to
 *      Primus only when it has no prices, so it can be sent to the
 *      customer.
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
const {
  findInvoiceAttachment,
  attachmentFilenameContainsPro,
  listInvoicePdfAttachments,
} = require("./pod-utils");

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

/** Flat band for lumper base-freight pre-check vs Primus carrier cost. */
const LUMPER_BASE_TOLERANCE = 5;

/**
 * Coerce money-like values ("$503.11", "1,250.00") to a finite number.
 * @param {*} value Raw amount.
 * @return {number}
 */
function coerceMoneyNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const cleaned = String(value == null ? "" : value)
      .replace(/[^0-9.-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Tolerance band for carrier invoice vs Primus vendor.cost.
 * Flat $10 floor (ops auto-approve under $10) plus 2% for larger loads.
 * @param {number|string} primusAmount Primus vendor.cost.
 * @return {number}
 */
function primusAmountMatchTolerance(primusAmount) {
  const cost = coerceMoneyNumber(primusAmount);
  if (!(cost > 0)) return RATE_MATCH_TOLERANCE;
  return Math.max(RATE_MATCH_TOLERANCE, cost * 0.02);
}

/**
 * Whether carrier invoice amount may proceed without a billing hold.
 * Accepts within tolerance, or when the carrier billed at/under Primus.
 * @param {number|string} submittedAmount Carrier invoice amount.
 * @param {number|string} primusAmount Primus vendor.cost.
 * @return {{valid:boolean,difference:number,tolerance:number,
 *   submitted:number,primus:number}}
 */
function evaluatePrimusAmountMatch(submittedAmount, primusAmount) {
  const submitted = coerceMoneyNumber(submittedAmount);
  const primus = coerceMoneyNumber(primusAmount);
  const difference = Math.abs(submitted - primus);
  const tolerance = primusAmountMatchTolerance(primus);
  const valid = (primus > 0 && submitted > 0 && difference <= tolerance) ||
      (primus > 0 && submitted <= primus + 0.01);
  return {valid, difference, tolerance, submitted, primus};
}

/**
 * True when invoice total already agrees with Primus carrier cost.
 * Lumper (and other) line items are then a breakdown, not an overage.
 * @param {number|string} invoiceAmount Carrier invoice total.
 * @param {number|string} primusCarrierCost Primus vendor.cost.
 * @param {number} [tolerance=RATE_MATCH_TOLERANCE] Match band in dollars.
 * @return {boolean}
 */
function invoiceTotalMatchesPrimusCost(
    invoiceAmount, primusCarrierCost, tolerance = RATE_MATCH_TOLERANCE) {
  const invoice = coerceMoneyNumber(invoiceAmount);
  const primusCost = coerceMoneyNumber(primusCarrierCost);
  const band = Number(tolerance);
  const tol = Number.isFinite(band) ? band : RATE_MATCH_TOLERANCE;
  return primusCost > 0 && invoice > 0 &&
      Math.abs(invoice - primusCost) <= tol;
}

/**
 * Validates invoice amount by subtracting lumper charges before comparing
 * to Primus carrier cost (booking.vendor.cost).
 * @param {object} aiResult AI classification result (or charge snapshot).
 * @param {number} primusCarrierCost Carrier cost from Primus booking.
 * @return {object} Validation result.
 */
function validateLumperAmount(aiResult, primusCarrierCost) {
  const recognized = Array.isArray(aiResult && aiResult.recognizedCharges) ?
    aiResult.recognizedCharges : [];
  const unrecognized =
    Array.isArray(aiResult && aiResult.unrecognizedCharges) ?
      aiResult.unrecognizedCharges : [];
  // Claude sometimes puts lumper/detention only in legacy `charges[]`.
  const legacyCharges = Array.isArray(aiResult && aiResult.charges) ?
    aiResult.charges : [];
  const lumperCharges = recognized.concat(unrecognized, legacyCharges)
      .filter((c) => c && /lumper/i.test(String(c.type || c.label || "")));
  const totalLumper = lumperCharges.reduce(
      (sum, c) => sum + coerceMoneyNumber(c.amount), 0);
  const invoiceAmount = coerceMoneyNumber(
      aiResult && aiResult.invoiceAmount);
  const primusCost = coerceMoneyNumber(primusCarrierCost);
  const baseAmount = invoiceAmount - totalLumper;
  // When the invoice total already matches Primus, the lumper is included in
  // carrier cost — line items are a breakdown, not an overage.
  // Lucky Way 266823: $503.11 invoice = $300 freight + $203.11 lumper, and
  // Primus vendor.cost was already $503.11 — must approve, not flag.
  const totalMatchesPrimus = invoiceTotalMatchesPrimusCost(
      invoiceAmount, primusCost);
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
 * Full text used to detect notify-detention / storage wording on a charge.
 * @param {object|string|null} charge Charge row or raw label.
 * @return {string}
 */
function chargeStorageText(charge) {
  if (typeof charge === "string") return String(charge || "").trim();
  if (!charge || typeof charge !== "object") return "";
  return [
    charge.label,
    charge.type,
    charge.description,
    charge.detail,
    charge.days != null ? `${charge.days} days` : "",
    charge.quantity != null && /day/i.test(String(charge.unit || "day")) ?
      `${charge.quantity} days` : "",
  ].filter(Boolean).join(" ").trim();
}

/**
 * Ops rule: AAA Cooper (and similar) "NOTIFY DETENTION: N DAYS" means
 * N days of storage - not unexplained detention jargon in emails.
 * @param {string|object|null} labelOrCharge Raw label or charge row.
 * @return {object|null} {isStorage, days} or null when not notify detention.
 */
function parseNotifyDetentionStorage(labelOrCharge) {
  const raw = chargeStorageText(labelOrCharge);
  if (!raw) return null;
  if (!/notify[\s_-]*detention/i.test(raw)) return null;
  const daysMatch = raw.match(/(\d+)\s*days?/i);
  let days = daysMatch ? Number(daysMatch[1]) : null;
  if (!(Number.isFinite(days) && days > 0) &&
      labelOrCharge && typeof labelOrCharge === "object") {
    const fromField = Number(labelOrCharge.days != null ?
      labelOrCharge.days : labelOrCharge.quantity);
    if (Number.isFinite(fromField) && fromField > 0) days = fromField;
  }
  return {
    isStorage: true,
    days: Number.isFinite(days) && days > 0 ? days : null,
  };
}

/**
 * @param {object|string|null} charge Charge row or label.
 * @return {boolean}
 */
function isNotifyDetentionStorageCharge(charge) {
  return !!parseNotifyDetentionStorage(charge);
}

/**
 * Collects notify-detention (storage) rows from one or more charge lists.
 * @param {...Array<object>} lists Charge arrays.
 * @return {Array<object>} Deduped charge rows.
 */
function collectNotifyDetentionStorageCharges(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const c of (Array.isArray(list) ? list : [])) {
      if (!isNotifyDetentionStorageCharge(c)) continue;
      const key = `${chargeLabel(c).toLowerCase()}|` +
        `${Number(c && c.amount) || 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

/**
 * @param {Array<object>} charges Charge rows (preferably notify-detention).
 * @return {object|null} {days, amount, charges} or null when none found.
 */
function summarizeNotifyDetentionStorage(charges) {
  const hits = collectNotifyDetentionStorageCharges(charges);
  if (!hits.length) return null;
  let days = null;
  let amount = 0;
  for (const c of hits) {
    const parsed = parseNotifyDetentionStorage(c);
    if (parsed && parsed.days != null && days == null) days = parsed.days;
    amount += Number(c && c.amount) || 0;
  }
  return {days, amount, charges: hits};
}

/**
 * Plain-language sentence for Lisa/Sarah/dispatcher emails.
 * @param {object|null} summary From summarizeNotifyDetentionStorage.
 * @return {string|null} Explanation sentence, or null.
 */
function formatNotifyDetentionStorageExplanation(summary) {
  if (!summary) return null;
  const amt = money(summary.amount);
  if (summary.days != null) {
    const dayWord = summary.days === 1 ? "day" : "days";
    return `The carrier is charging ${summary.days} ${dayWord} ` +
      `storage totaling ${amt}.`;
  }
  return `The carrier is charging storage totaling ${amt}.`;
}

/**
 * Moves notify-detention (storage) rows out of recognized into
 * unrecognized so they take the additional-charge approval path
 * instead of a bare Primus amount-mismatch dump.
 * @param {Array<object>} recognized Recognized charge rows.
 * @param {Array<object>} unrecognized Unrecognized charge rows.
 * @return {object} recognizedCharges, unrecognizedCharges, moved.
 */
function rehomeNotifyDetentionToUnrecognized(recognized, unrecognized) {
  const stay = [];
  const moved = [];
  for (const c of (Array.isArray(recognized) ? recognized : [])) {
    if (isNotifyDetentionStorageCharge(c)) moved.push(c);
    else stay.push(c);
  }
  const unrecognizedOut = Array.isArray(unrecognized) ?
    unrecognized.slice() : [];
  for (const c of moved) {
    const amt = Number(c && c.amount) || 0;
    const key = `${chargeLabel(c).toLowerCase()}|${amt}`;
    const already = unrecognizedOut.some((u) => {
      const uAmt = Number(u && u.amount) || 0;
      return `${chargeLabel(u).toLowerCase()}|${uAmt}` === key;
    });
    if (!already) unrecognizedOut.push(c);
  }
  return {
    recognizedCharges: stay,
    unrecognizedCharges: unrecognizedOut,
    moved,
  };
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
  const storage = parseNotifyDetentionStorage(raw);
  if (storage) {
    if (storage.days != null) {
      const dayWord = storage.days === 1 ? "day" : "days";
      return `${storage.days} ${dayWord} storage`;
    }
    return "Storage";
  }
  const key = raw.toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
  const aliases = {
    school_delivery: "School delivery fee",
    notify_charge: "Notify charge",
    notify_detention: "Storage",
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
 * @param {*} value Raw dimension.
 * @return {number} Positive inches, or 0.
 */
function readPositiveDim(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * @param {object|null} row Freight row.
 * @param {Array<string>} keys Candidate property names.
 * @return {number}
 */
function readDimFromRow(row, keys) {
  if (!row || typeof row !== "object") return 0;
  for (const key of keys) {
    const n = readPositiveDim(row[key]);
    if (n > 0) return n;
  }
  return 0;
}

/**
 * @param {number} length Inches.
 * @param {number} width Inches.
 * @param {number} height Inches.
 * @return {string} "40 x 48 x 30 in", or "" when a side is missing.
 */
function formatDims(length, width, height) {
  const l = readPositiveDim(length);
  const w = readPositiveDim(width);
  const h = readPositiveDim(height);
  if (!(l > 0) || !(w > 0) || !(h > 0)) return "";
  const n = (v) => {
    const rounded = Math.round(v * 10) / 10;
    return String(rounded).replace(/\.0$/, "");
  };
  return `${n(l)} x ${n(w)} x ${n(h)} in`;
}

/**
 * @param {number} lbs Weight.
 * @return {string}
 */
function formatWeightLbs(lbs) {
  const n = Number(lbs);
  if (!(n > 0)) return "not shown";
  const rounded = Math.round(n);
  const withCommas = String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${withCommas} lbs`;
}

/**
 * Billed freight on the carrier invoice.
 * @param {object|null} invoiceFreight Classifier freightDetails.
 * @return {object}
 */
function readInvoiceFreight(invoiceFreight) {
  const inv = invoiceFreight || {};
  return {
    totalWeightLbs: Number(inv.totalWeightLbs) || 0,
    freightClass: String(inv.freightClass || "").trim(),
    pieces: Number(inv.pieces) || 0,
    length: readPositiveDim(inv.length),
    width: readPositiveDim(inv.width),
    height: readPositiveDim(inv.height),
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
 * Original quoted freight on the Primus booking (weight, class, dims).
 * @param {object|null} booking Primus booking.
 * @return {object}
 */
function readBookingFreightSnapshot(booking) {
  const base = readBookingFreight(booking);
  const info = Array.isArray(booking && booking.freightInfo) ?
    booking.freightInfo : [];
  const row = info[0] || {};
  return {
    totalWeightLbs: base.totalWeightLbs,
    freightClass: base.freightClass,
    pieces: info.reduce((sum, r) => sum + (Number(r && r.qty) || 0), 0),
    length: readDimFromRow(row, ["length", "Length"]),
    width: readDimFromRow(row, ["width", "Width"]),
    height: readDimFromRow(row, ["height", "Height"]),
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
  const inv = readInvoiceFreight(invoiceFreight);
  const primus = readBookingFreightSnapshot(booking);
  const invWeight = inv.totalWeightLbs;
  const invClass = inv.freightClass;

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

  const invoiceDims = formatDims(inv.length, inv.width, inv.height);
  const primusDims = formatDims(primus.length, primus.width, primus.height);
  let dimMismatch = false;
  if (invoiceDims && primusDims) {
    dimMismatch =
      Math.abs(inv.length - primus.length) >= 1 ||
      Math.abs(inv.width - primus.width) >= 1 ||
      Math.abs(inv.height - primus.height) >= 1;
  }

  return {
    mismatch: weightMismatch || classMismatch || dimMismatch,
    weightMismatch,
    classMismatch,
    dimMismatch,
    details: {
      invoiceWeightLbs: invWeight || null,
      primusWeightLbs: primus.totalWeightLbs || null,
      invoiceClass: invClass || null,
      primusClass: primus.freightClass || null,
      invoiceDims: invoiceDims || null,
      primusDims: primusDims || null,
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
  const billed = readInvoiceFreight(invoiceFreight);
  const invWeight = billed.totalWeightLbs;
  const invClass = billed.freightClass;
  const rows = Array.isArray(booking && booking.freightInfo) ?
    booking.freightInfo : [];

  const applyInvoiceDims = (out, idx) => {
    if (idx !== 0) return out;
    if (billed.length) out.length = billed.length;
    if (billed.width) out.width = billed.width;
    if (billed.height) out.height = billed.height;
    return out;
  };

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
      return applyInvoiceDims(out, idx);
    }).filter((r) => Number(r.weight) > 0);
  }

  if (invWeight <= 0) return null;
  return [applyInvoiceDims({
    qty: 1,
    weight: invWeight,
    weightType: "total",
    class: invClass || 50,
  }, 0)];
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
  const charges = Array.isArray(opts.charges) ? opts.charges : [];
  const wniByLabel = charges.some(
      (c) => isWeightInspectionLabel(chargeLabel(c)));
  const accessorialByLabel = charges.some(
      (c) => isAccessorialLabel(chargeLabel(c)));
  const mismatch = opts.freightMismatch && opts.freightMismatch.mismatch;

  // Itemized accessorials (school delivery, notify/detention, etc.) win
  // over a stray W&I certificate flag or matching weight/class on the invoice.
  if (accessorialByLabel && !wniByLabel && !mismatch) {
    return CHARGE_CATEGORY.ACCESSORIAL;
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
 * @param {object} charge Charge row.
 * @return {string} Human-readable label (storage wording when applicable).
 */
function displayChargeLabelForRow(charge) {
  const storage = parseNotifyDetentionStorage(charge);
  if (storage) {
    if (storage.days != null) {
      const dayWord = storage.days === 1 ? "day" : "days";
      return `${storage.days} ${dayWord} storage`;
    }
    return "Storage";
  }
  return displayChargeLabel(chargeLabel(charge));
}

/**
 * @param {Array<object>} charges Charge rows.
 * @return {string} HTML list of charges.
 */
function chargesHtml(charges) {
  const rows = (Array.isArray(charges) ? charges : [])
      .map((c) =>
        `<li>${esc(displayChargeLabelForRow(c))}: ` +
        `<strong>${money(c && c.amount)}</strong></li>`)
      .join("");
  return rows ? `<ul style="margin:6px 0 6px 18px;padding:0">${rows}</ul>` :
    "<p><em>No itemized charge rows — total difference only.</em></p>";
}

/**
 * Validates that a picked carrier-invoice PDF matches PRO/filename hints.
 * @param {object|null} attachmentMeta Picked attachment metadata.
 * @param {object} [hints] proNumber, attachmentFilename.
 * @return {{ok: boolean, reason: string|null}}
 */
function validateCarrierInvoiceAttachment(attachmentMeta, hints) {
  if (!attachmentMeta || !attachmentMeta.storagePath) {
    return {ok: false, reason: "missing_attachment"};
  }
  const opts = hints && typeof hints === "object" ? hints : {};
  const proNumber = String(opts.proNumber || "").trim();
  const filename = String(attachmentMeta.filename || "");
  if (proNumber && !attachmentFilenameContainsPro(filename, proNumber)) {
    return {ok: false, reason: "pro_mismatch"};
  }
  return {ok: true, reason: null};
}

/**
 * Picks the carrier invoice PDF from an invoice doc's attachments list
 * (GCS storagePath). Skips weight-cert / POD image docs — callers that need
 * the full original packet (invoice + W&I backups) should use
 * listAdditionalChargeApprovalAttachments instead.
 * @param {Array<object>|null|undefined} attachments Invoice attachments.
 * @param {object} [hints] Optional proNumber / attachmentFilename match.
 * @return {{filename: string, storagePath: string, mimeType: string}|null}
 */
function pickCarrierInvoiceAttachment(attachments, hints) {
  const list = Array.isArray(attachments) ? attachments : [];
  const withPath = list.filter((a) => a && a.storagePath);
  if (!withPath.length) return null;

  const opts = hints && typeof hints === "object" ? hints : {};
  const hinted = findInvoiceAttachment(withPath, opts);
  if (hinted && hinted.storagePath) {
    const meta = {
      filename: String(hinted.filename || "carrier-invoice.pdf"),
      storagePath: String(hinted.storagePath),
      mimeType: String(hinted.mimeType || "application/pdf"),
      scopedFrom: hinted.scopedFrom || null,
      scopedFromStoragePath: hinted.scopedFromStoragePath || null,
    };
    const validation = validateCarrierInvoiceAttachment(meta, opts);
    return validation.ok ? meta : null;
  }

  const skipDocType =
      /WEIGHT_INSPECTION_CERT|POD_IMAGE|TRAILER_IMAGE|^POD$/i;
  const notSidecar = withPath.filter((a) => {
    const dt = String(a.docType || "");
    return !dt || !skipDocType.test(dt);
  });
  const pool = notSidecar.length ? notSidecar : withPath;
  const pdfPool = listInvoicePdfAttachments(pool);
  const proNumber = String(opts.proNumber || "").trim();

  // Batch emails: never attach a sibling PRO's PDF when hint matching failed.
  if (proNumber && pdfPool.length > 1) {
    return null;
  }

  const pdfLike = pool.find((a) =>
    /\.pdf$/i.test(String(a.filename || "")) ||
    /pdf/i.test(String(a.mimeType || "")));
  const chosen = pdfLike || pool[0];
  if (!chosen || !chosen.storagePath) return null;
  const meta = {
    filename: String(chosen.filename || "carrier-invoice.pdf"),
    storagePath: String(chosen.storagePath),
    mimeType: String(chosen.mimeType || "application/pdf"),
    scopedFrom: chosen.scopedFrom || null,
    scopedFromStoragePath: chosen.scopedFromStoragePath || null,
  };
  const validation = validateCarrierInvoiceAttachment(meta, opts);
  return validation.ok ? meta : null;
}

/**
 * Attachments for additional-charge approval emails: the carrier invoice
 * PDF plus any W&I certificate backups stored on the invoice. Skips POD /
 * trailer images and does not fall back to sibling-PRO batch PDFs.
 * Prefer the invoice attachment already on the load (for single-load W&I
 * packets intake keeps the full original PDF instead of an invoice-only
 * page extract).
 * @param {Array<object>|null|undefined} attachments Invoice attachments.
 * @param {object} [hints] Optional proNumber / attachmentFilename match.
 * @return {Array<{filename: string, storagePath: string, mimeType: string,
 *   docType: string|null}>}
 */
function listAdditionalChargeApprovalAttachments(attachments, hints) {
  const list = Array.isArray(attachments) ? attachments : [];
  const withPath = list.filter((a) => a && a.storagePath);
  if (!withPath.length) return [];

  const opts = hints && typeof hints === "object" ? hints : {};
  const picked = pickCarrierInvoiceAttachment(withPath, opts);
  const out = [];
  const seen = new Set();
  const push = (meta, docType) => {
    if (!meta || !meta.storagePath || seen.has(meta.storagePath)) return;
    seen.add(meta.storagePath);
    out.push({
      filename: String(meta.filename || "carrier-invoice.pdf"),
      storagePath: String(meta.storagePath),
      mimeType: String(meta.mimeType || "application/pdf"),
      docType: docType || meta.docType || null,
    });
  };

  if (picked) {
    push(picked, "INVOICE");
  }

  for (const att of withPath) {
    const dt = String(att.docType || "");
    if (/WEIGHT_INSPECTION_CERT/i.test(dt)) {
      push({
        filename: String(att.filename || "weight-inspection-cert.pdf"),
        storagePath: String(att.storagePath),
        mimeType: String(att.mimeType || "application/pdf"),
        docType: "WEIGHT_INSPECTION_CERT",
      }, "WEIGHT_INSPECTION_CERT");
    }
  }
  return out;
}

/**
 * Additional charge when the carrier voids the quote and sends a new
 * invoice: invoice total minus the Primus quoted carrier total.
 * @param {number|string} invoiceAmount Carrier invoice total.
 * @param {number|string} primusQuotedTotal Primus vendor.cost.
 * @return {number|null} Dollars, or null when either side is missing.
 */
function computeAddedCharge(invoiceAmount, primusQuotedTotal) {
  const invoice = coerceMoneyNumber(invoiceAmount);
  const quoted = coerceMoneyNumber(primusQuotedTotal);
  if (!(invoice > 0) || !(quoted > 0)) return null;
  return Math.round((invoice - quoted) * 100) / 100;
}

/**
 * True when a higher carrier invoice replaces the booked rate because
 * weight, class, or dims changed, or a W&I certificate / reweigh fee
 * is present.
 * @param {object} opts invoiceAmount, primusAmount, freightMismatch,
 *   hasCertificate, charges.
 * @return {boolean}
 */
function isReplacementWeightInvoice(opts) {
  const invoice = coerceMoneyNumber(opts && opts.invoiceAmount);
  const quoted = coerceMoneyNumber(opts && opts.primusAmount);
  if (!(invoice > 0) || !(quoted > 0)) return false;
  if (invoice <= quoted + RATE_MATCH_TOLERANCE) return false;
  const mm = opts.freightMismatch;
  if (mm && mm.mismatch) return true;
  if (opts.hasCertificate) return true;
  const charges = Array.isArray(opts.charges) ? opts.charges : [];
  return charges.some((c) => isWeightInspectionLabel(chargeLabel(c)));
}

/**
 * Original quote vs the freight billed on the replacement invoice.
 * @param {object} opts booking, invoiceFreight, invoiceAmount, primusAmount.
 * @return {object}
 */
function buildWeightRebillSummary(opts) {
  const original = readBookingFreightSnapshot(opts && opts.booking);
  const updated = readInvoiceFreight(opts && opts.invoiceFreight);
  const invoiceAmount = coerceMoneyNumber(opts && opts.invoiceAmount);
  const primusAmount = coerceMoneyNumber(opts && opts.primusAmount);
  return {
    original,
    updated,
    invoiceAmount: invoiceAmount > 0 ? invoiceAmount : null,
    primusQuotedTotal: primusAmount > 0 ? primusAmount : null,
    addedCharge: computeAddedCharge(invoiceAmount, primusAmount),
  };
}

/**
 * 1-based certificate page numbers from the classifier.
 * @param {Array<*>} pages Raw pages.
 * @return {number[]}
 */
function normalizeCertificatePages(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const out = [];
  for (const page of list) {
    const n = Math.trunc(Number(page));
    if (Number.isFinite(n) && n >= 1 && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Whether certificate text shows a price. Weights and dims alone do not.
 * @param {string|null} text Extracted certificate text.
 * @return {{hasPricing: boolean, hasText: boolean, reason: string|null}}
 */
function certificateTextHasPricing(text) {
  const raw = String(text || "");
  if (!raw.trim()) {
    return {hasPricing: false, hasText: false, reason: null};
  }
  if (/\$\s*\d/.test(raw)) {
    return {hasPricing: true, hasText: true, reason: "dollar_amount"};
  }
  const pricingWord =
    /\b(?:amount\s+due|balance\s+due|total\s+charges|total\s+due|freight\s+charges?|line\s*-?\s*haul|fuel\s+surcharge|invoice\s+total|additional\s+charge)\b/i;
  if (pricingWord.test(raw) && /\d+\.\d{2}/.test(raw)) {
    return {
      hasPricing: true,
      hasText: true,
      reason: "charge_word_with_amount",
    };
  }
  if (/\brate\b.{0,24}\d+\.\d{2}|\d+\.\d{2}.{0,24}\brate\b/i.test(raw)) {
    return {hasPricing: true, hasText: true, reason: "rate_amount"};
  }
  return {hasPricing: false, hasText: true, reason: null};
}

/**
 * Dispatcher-facing block for a weight/dims replacement invoice.
 * @param {object} opts Email opts plus optional weightRebill and
 *   certificateStatus.
 * @return {string} HTML, or "" when this is not a weight inspection.
 */
function weightRebillSectionHtml(opts) {
  if (!opts || opts.category !== CHARGE_CATEGORY.WEIGHT_INSPECTION) {
    return "";
  }
  const summary = opts.weightRebill || buildWeightRebillSummary({
    booking: null,
    invoiceFreight: null,
    invoiceAmount: opts.invoiceAmount,
    primusAmount: opts.primusAmount,
  });
  const mm = (opts.freightMismatch && opts.freightMismatch.details) || {};
  const original = summary.original || {};
  const updated = summary.updated || {};
  const originalWeight = original.totalWeightLbs || mm.primusWeightLbs || 0;
  const updatedWeight = updated.totalWeightLbs || mm.invoiceWeightLbs || 0;
  const originalDims = formatDims(
      original.length, original.width, original.height) ||
    mm.primusDims || "";
  const updatedDims = formatDims(
      updated.length, updated.width, updated.height) ||
    mm.invoiceDims || "";
  const originalClass = original.freightClass || mm.primusClass || "";
  const updatedClass = updated.freightClass || mm.invoiceClass || "";
  const quoted = summary.primusQuotedTotal != null ?
    summary.primusQuotedTotal :
    coerceMoneyNumber(opts.primusAmount);
  const invoiceTotal = summary.invoiceAmount != null ?
    summary.invoiceAmount :
    coerceMoneyNumber(opts.invoiceAmount);
  const added = summary.addedCharge != null ?
    summary.addedCharge :
    computeAddedCharge(invoiceTotal, quoted);

  const dimsNote = (originalDims && updatedDims) ?
    (originalDims === updatedDims ?
      `Dims are the same as the original quote (${esc(originalDims)}).` :
      `Dims changed from ${esc(originalDims)} on the quote to ` +
      `${esc(updatedDims)} on the invoice.`) :
    "";

  const rate = opts.rateValidation;
  let verdict;
  if (rate && rate.attempted && rate.ok && rate.matched) {
    verdict =
      `<p style="color:#166534;background:#dcfce7;padding:10px 12px;` +
      `border-radius:6px"><strong>Correct.</strong> Jerry re-quoted ` +
      `Primus with the updated weight and dims` +
      (rate.quoteNumber ?
        ` (quote #${esc(String(rate.quoteNumber))})` : "") +
      `. The updated Primus quote is ${money(rate.rateTotal)}. ` +
      `Primus re-rate matches the carrier invoice ` +
      `${money(rate.invoiceAmount)} within ` +
      `$${esc(String(rate.tolerance))}, so the carrier is not ` +
      `overcharging.</p>`;
  } else if (rate && rate.attempted && rate.ok && !rate.matched) {
    const rateTotal = Number(rate.rateTotal);
    const inv = Number(rate.invoiceAmount);
    const carrierHigher = Number.isFinite(rateTotal) &&
      Number.isFinite(inv) && inv > rateTotal;
    verdict =
      `<p style="color:#991b1b;background:#fee2e2;padding:10px 12px;` +
      `border-radius:6px"><strong>` +
      (carrierHigher ? "Not correct." : "Review.") +
      `</strong> Jerry re-quoted Primus with the updated weight and ` +
      `dims` +
      (rate.quoteNumber ?
        ` (quote #${esc(String(rate.quoteNumber))})` : "") +
      `. The updated Primus quote is ${money(rate.rateTotal)}. ` +
      `Primus re-rate does NOT match the carrier invoice ` +
      `${money(rate.invoiceAmount)} (difference ` +
      `${money(rate.difference)}, tolerance ` +
      `$${esc(String(rate.tolerance))}). ` +
      (carrierHigher ?
        `The carrier invoice is higher than the updated quote.` :
        `The carrier invoice is below the updated quote.`) +
      `</p>`;
  } else if (rate && rate.attempted) {
    verdict =
      `<p style="color:#92400e;background:#fef3c7;padding:10px 12px;` +
      `border-radius:6px"><strong>Updated quote could not be run.</strong> ` +
      `${esc(rate.error || "Primus re-rate failed")}. The additional ` +
      `charge above is still the invoice total minus the original Primus ` +
      `quoted total. Review the carrier invoice manually.</p>`;
  } else {
    verdict =
      `<p style="color:#92400e;background:#fef3c7;padding:10px 12px;` +
      `border-radius:6px">An updated Primus quote for the new weight and ` +
      `dims was not attached to this email. Review the carrier invoice ` +
      `manually.</p>`;
  }

  const cert = opts.certificateStatus || null;
  const present = cert ? !!cert.present : !!opts.hasCertificate;
  let certHtml;
  if (!present) {
    certHtml =
      `<p><strong>Inspection certificate:</strong> not included with ` +
      `this invoice.</p>`;
  } else if (cert && cert.uploaded) {
    certHtml =
      `<p><strong>Inspection certificate:</strong> it was uploaded to ` +
      `Primus. The certificate does not have prices on it, so it can be ` +
      `sent to the customer` +
      (cert.customerVisible === false ?
        `. The Primus file type is not marked customer-visible — ` +
        `confirm it will go out with the customer documents` : "") +
      `.</p>`;
  } else if (cert && cert.withheldReason === "pricing") {
    certHtml =
      `<p><strong>Inspection certificate:</strong> it was not uploaded ` +
      `due to pricing on it. Do not send that certificate to the ` +
      `customer.</p>`;
  } else if (cert && cert.withheldReason === "unverified_pricing") {
    certHtml =
      `<p><strong>Inspection certificate:</strong> it was not uploaded. ` +
      `Prices could not be ruled out on the certificate, so it must not ` +
      `be sent to the customer until someone confirms it has no ` +
      `prices.</p>`;
  } else if (cert && cert.withheldReason === "could_not_separate") {
    certHtml =
      `<p><strong>Inspection certificate:</strong> the carrier included ` +
      `one, but it was not uploaded because it could not be separated ` +
      `from the priced invoice. Do not send the invoice to the ` +
      `customer as the certificate.</p>`;
  } else if (cert && cert.withheldReason === "no_file_type") {
    certHtml =
      `<p><strong>Inspection certificate:</strong> it has no prices, ` +
      `but it was not uploaded because Primus has no inspection-` +
      `certificate file type.</p>`;
  } else if (cert && cert.uploaded === false) {
    certHtml =
      `<p><strong>Inspection certificate:</strong> it was not uploaded` +
      (cert.detail ? ` (${esc(cert.detail)})` : "") +
      `.</p>`;
  } else {
    certHtml =
      `<p><strong>Inspection certificate:</strong> included with the ` +
      `invoice.</p>`;
  }

  const line = (label, value) =>
    `<tr><td style="padding:3px 12px 3px 0;font-weight:600">` +
    `${esc(label)}</td><td>${value}</td></tr>`;

  return `<div style="border:1px solid #e5e7eb;border-radius:8px;` +
    `padding:12px 14px;margin:14px 0">` +
    `<p style="margin:0 0 8px"><strong>Weight / inspection — new ` +
    `carrier invoice</strong></p>` +
    `<p style="margin:0 0 8px">The original rate is void. The carrier ` +
    `sent a new invoice for the updated weight and dims. ` +
    `<strong>Additional charge</strong> is the invoice total minus the ` +
    `Primus quoted total: <strong>` +
    (added == null ? "—" : money(added)) +
    `</strong>` +
    (quoted > 0 ?
      ` (${money(invoiceTotal)} − ${money(quoted)})` : "") +
    `.</p>` +
    `<table style="border-collapse:collapse;font-size:14px;margin:8px 0">` +
    line("Original quote weight", esc(formatWeightLbs(originalWeight))) +
    (originalClass ?
      line("Original class", esc(String(originalClass))) : "") +
    line("Original dims", esc(originalDims || "not shown")) +
    line("Original quoted price", quoted > 0 ? money(quoted) : "—") +
    line("Updated weight", esc(formatWeightLbs(updatedWeight))) +
    (updatedClass ? line("Updated class", esc(String(updatedClass))) : "") +
    line("Updated dims", esc(updatedDims || "not shown")) +
    line("Carrier invoice total", invoiceTotal > 0 ?
      money(invoiceTotal) : "—") +
    line("Additional charge", added == null ? "—" : money(added)) +
    `</table>` +
    (dimsNote ? `<p style="margin:8px 0">${dimsNote}</p>` : "") +
    verdict +
    certHtml +
    `<p style="margin:8px 0 0">Dispatcher: advise the customer of the ` +
    `original quote, the updated weight and dims, and this additional ` +
    `charge, then enter the updated rate (option B).</p>` +
    `</div>`;
}

/**
 * Builds the 5-option approval email for Sarah + the dispatcher.
 * @param {object} opts baseUrl, invoiceId, tenantId, loadNumber, carrierName,
 *   customerName, invoiceAmount, primusAmount, charges, chargesTotal,
 *   category, freightMismatch, hasCertificate, dispatcherName,
 *   rateValidation (optional W&I re-rate result), customerRate,
 *   excludedInPrimusCount (optional — charges already on file),
 *   ignoredSmall (optional — auto-ignored ≤$5 rows),
 *   chargesNeedProof (optional — recognized but awaiting receipts),
 *   weightRebill (original vs updated freight), certificateStatus
 *   (uploaded, or withheld because the certificate has prices).
 * @return {{subject: string, html: string}}
 */
function buildAdditionalChargeApprovalEmail(opts) {
  const {
    baseUrl, invoiceId, tenantId, loadNumber, carrierName, customerName,
    invoiceAmount, primusAmount, charges, chargesTotal, category,
    freightMismatch, hasCertificate, dispatcherName, rateValidation,
    customerRate,
    excludedInPrimusCount,
    ignoredSmall,
    chargesNeedProof,
    actionUrl: actionUrlFn,
  } = opts;
  const weightInspection =
    category === CHARGE_CATEGORY.WEIGHT_INSPECTION;
  const addedCharge = weightInspection ?
    ((opts.weightRebill && opts.weightRebill.addedCharge != null) ?
      opts.weightRebill.addedCharge :
      computeAddedCharge(invoiceAmount, primusAmount)) :
    null;
  // Accessorial emails historically showed only the sum of line items
  // pending A/B/C/D/E. Ops read that next to invoice + amount on file and
  // expected invoice − Primus. Show both so the math reconciles.
  const invoiceOverage = !weightInspection ?
    computeAddedCharge(invoiceAmount, primusAmount) : null;
  const pendingTotal = Number(chargesTotal) || 0;
  const overageDiffersFromPending = invoiceOverage != null &&
    Math.abs(invoiceOverage - pendingTotal) > 0.05;

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
  const mismatchHtml = mm.mismatch && !weightInspection ?
    `<p style="color:#b45309"><strong>Freight mismatch vs Primus:</strong> ` +
    (mm.weightMismatch ?
      `invoice weight ${esc(String(mmDetails.invoiceWeightLbs))} lbs vs ` +
      `Primus ${esc(String(mmDetails.primusWeightLbs))} lbs. ` : "") +
    (mm.classMismatch ?
      `invoice class ${esc(String(mmDetails.invoiceClass))} vs Primus ` +
      `class ${esc(String(mmDetails.primusClass))}.` : "") +
    `</p>` : "";

  let rateHtml = "";
  if (!weightInspection && rateValidation && rateValidation.attempted) {
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

  const formatChargeBrief = (list) => (Array.isArray(list) ? list : [])
      .map((c) => {
        const label = displayChargeLabelForRow(c) ||
          String((c && (c.label || c.type)) || "charge");
        const amt = Number(c && c.amount);
        return Number.isFinite(amt) ?
          `${label} ${money(amt)}` : label;
      })
      .filter(Boolean)
      .join("; ");

  const storageSummary = summarizeNotifyDetentionStorage(charges);
  const storageExplain = formatNotifyDetentionStorageExplanation(
      storageSummary);
  const storageExplainHtml = storageExplain ?
    `<p style="background:#fef3c7;border:1px solid #fcd34d;` +
    `padding:12px 14px;border-radius:6px;margin:14px 0">` +
    `<strong>${esc(storageExplain)}</strong></p>` : "";

  const accessorialConfirmHtml =
    category === CHARGE_CATEGORY.ACCESSORIAL ?
      `<p style="background:#eff6ff;border:1px solid #bfdbfe;` +
      `padding:12px 14px;border-radius:6px;margin:14px 0">` +
      `<strong>Dispatcher${dispatcherName ?
        ` (${esc(dispatcherName)})` : ""} — please confirm:</strong> ` +
      `Were the accessorial charge(s) below authorized on this load ` +
      `(e.g. storage / notify detention, school delivery, ` +
      `notify delivery)? ` +
      `Reply to this thread or tell accounting before we bill the ` +
      `customer or dispute the carrier.</p>` : "";

  const overageNoteParts = [];
  if (overageDiffersFromPending) {
    overageNoteParts.push(
        `Invoice is ${money(invoiceOverage)} over amount on file, but ` +
        `only ${money(pendingTotal)} are the accessorial line(s) needing ` +
        `your decision below.`);
    const ignoredBrief = formatChargeBrief(ignoredSmall);
    if (ignoredBrief) {
      overageNoteParts.push(
          `Auto-ignored small charge(s): ${ignoredBrief}.`);
    }
    const needProofBrief = formatChargeBrief(chargesNeedProof);
    if (needProofBrief) {
      overageNoteParts.push(
          `Awaiting proof (handled separately): ${needProofBrief}.`);
    }
    if (Number(excludedInPrimusCount) > 0) {
      overageNoteParts.push(
          `${excludedInPrimusCount} charge(s) already on file in Primus ` +
          `were excluded.`);
    }
    overageNoteParts.push(
        `Any leftover is usually freight variance vs the Primus quote.`);
  }
  const overageNoteHtml = overageNoteParts.length ?
    `<p style="background:#fef3c7;border:1px solid #fcd34d;` +
    `padding:12px 14px;border-radius:6px;margin:14px 0;font-size:13px">` +
    `<strong>Why the totals differ:</strong> ` +
    `${esc(overageNoteParts.join(" "))}</p>` : "";

  const additionalChargeRowLabel = weightInspection ?
    "Additional charge" :
    (overageDiffersFromPending ?
      "Charges needing decision" : "Additional charges");
  const additionalChargeRowValue = weightInspection && addedCharge != null ?
    money(addedCharge) : money(chargesTotal);

  const html =
    `<p>A carrier invoice came in <strong>higher than the quoted ` +
    `amount</strong> and needs your decision.</p>` +
    storageExplainHtml +
    `<table style="border-collapse:collapse;font-size:14px;margin:12px 0">` +
    row("Load #", esc(String(loadNumber || "—"))) +
    row("Carrier", esc(carrierName || "—")) +
    row("Customer", esc(customerName || "—")) +
    row("Customer rate (Primus)", formatCustomerRate(customerRate)) +
    row("Carrier invoice", money(invoiceAmount)) +
    row("Amount on file (Primus)", money(primusAmount)) +
    (invoiceOverage != null ?
      row("Invoice over amount on file", money(invoiceOverage)) : "") +
    row(additionalChargeRowLabel, additionalChargeRowValue) +
    row("Reason (detected)", esc(categoryLabel(category))) +
    (hasCertificate ?
      row("W&I certificate", "Attached / referenced on invoice") : "") +
    (dispatcherName ? row("Dispatcher", esc(dispatcherName)) : "") +
    `</table>` +
    overageNoteHtml +
    accessorialConfirmHtml +
    weightRebillSectionHtml(opts) +
    mismatchHtml +
    rateHtml +
    `<p><strong>Charges:</strong></p>` +
    chargesHtml(charges) +
    (Number(excludedInPrimusCount) > 0 && !overageDiffersFromPending ?
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
        .map((c) => displayChargeLabelForRow(c))
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
      .map((c) => `- ${displayChargeLabelForRow(c)}: ` +
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
function buildCustomerChargeNotificationEmail(opts) {
  const {customerName, loadNumber, charges, chargesTotal, category,
    customerRate} = opts;
  const html =
    `<p>Hello${customerName ? ` ${esc(customerName)}` : ""},</p>` +
    `<p>We were billed an additional charge by the carrier on your ` +
    `shipment (our reference <strong>${esc(String(loadNumber || ""))}` +
    `</strong>).</p>` +
    (customerRate != null && Number(customerRate) > 0 ?
      `<p><strong>Your rate for this shipment:</strong> ` +
      `${formatCustomerRate(customerRate)}</p>` : "") +
    `<p><strong>Reason:</strong> ${esc(categoryLabel(category))}</p>` +
    chargesHtml(charges) +
    `<p>The additional amount of <strong>${money(chargesTotal)}</strong> ` +
    `will be reflected on your invoice for this shipment.</p>` +
    `<p>Please reach out if you have any questions.</p>`;
  return {
    subject: toOutboundEmailSafeSubject(
        `Additional charge on shipment ${loadNumber}`),
    html: toOutboundEmailSafeText(html),
  };
}

/**
 * Ready-to-forward customer email body for option B (dispatcher sends it).
 * @param {object} opts loadNumber, customerName, carrierName, chargesTotal,
 *   customerRate, customerBillLines, newCustomerRate.
 * @return {{subject: string, html: string}}
 */
function buildDispatcherCustomerNotifyTemplate(opts) {
  const {
    loadNumber, customerName, carrierName, chargesTotal,
    customerRate, customerBillLines, newCustomerRate,
  } = opts;
  const billLines = Array.isArray(customerBillLines) ? customerBillLines : [];
  const baseRate = Number(customerRate) || 0;
  const accessorialTotal = sumCustomerBillLines(billLines);
  const updatedRate = Number(newCustomerRate) > 0 ?
    Number(newCustomerRate) :
    (baseRate > 0 ? baseRate + accessorialTotal : accessorialTotal);
  const chargeDetail = billLines.length ?
    customerBillLinesHtml(billLines) :
    `<p>Additional charge total: <strong>${money(chargesTotal)}</strong></p>`;
  const html =
    `<p>Hello${customerName ? ` ${esc(customerName)}` : ""},</p>` +
    `<p>This note is about your shipment ` +
    `<strong>${esc(String(loadNumber || ""))}</strong>` +
    (carrierName ? ` with ${esc(carrierName)}` : "") + `.</p>` +
    `<p>The carrier billed an additional charge on this load` +
    (Number(chargesTotal) > 0 ?
      ` of <strong>${money(chargesTotal)}</strong>` : "") +
    `. Your updated customer rate for this shipment is ` +
    `<strong>${money(updatedRate)}</strong>` +
    (baseRate > 0 && billLines.length ?
      ` (base freight ${formatCustomerRate(baseRate)} plus the ` +
      `accessorial(s) below)` : "") +
    `.</p>` +
    chargeDetail +
    `<p>Please let us know if you have any questions.</p>` +
    `<p>Thank you,<br>Innovative Carriers</p>`;
  return {
    subject: toOutboundEmailSafeSubject(
        `Updated rate on shipment ${loadNumber}`),
    html: toOutboundEmailSafeText(html),
  };
}

/**
 * Dispatcher reminder for decision B (dispatcher must notify the customer).
 * Includes a ready-to-send customer notification template and a secure
 * button to finalize the invoice after the customer was notified.
 * @param {object} opts dispatcherName, loadNumber, carrierName, customerName,
 *   charges, chargesTotal, baseUrl, invoiceId, tenantId.
 * @return {{subject: string, html: string}}
 */
function buildDispatcherNotifyReminderEmail(opts) {
  const {
    dispatcherName, loadNumber, carrierName, customerName,
    charges, chargesTotal, customerRate, customerBillLines,
    baseUrl, invoiceId, tenantId,
  } = opts;
  const billLines = Array.isArray(customerBillLines) ? customerBillLines : [];
  const baseRate = Number(customerRate) || 0;
  const accessorialTotal = sumCustomerBillLines(billLines);
  const newCustomerRate = baseRate > 0 ?
    baseRate + accessorialTotal : accessorialTotal;
  const billingBlock = billLines.length ?
    ((baseRate > 0 ?
      `<p><strong>Base customer rate (unchanged): ` +
      `${formatCustomerRate(baseRate)}</strong></p>` : "") +
      `<p><strong>Accessorials to bill the customer:</strong></p>` +
      customerBillLinesHtml(billLines) +
      `<p><strong>New customer total (base + accessorials): ` +
      `${money(newCustomerRate)}</strong></p>` +
      `<p><strong>Carrier additional charge:</strong> ` +
      `${money(chargesTotal)}</p>`) :
    (chargesHtml(charges) +
      `<p>Total additional: <strong>${money(chargesTotal)}</strong></p>` +
      (baseRate > 0 ?
        `<p><strong>Current customer rate:</strong> ` +
        `${formatCustomerRate(baseRate)}</p>` : ""));
  const forward = buildDispatcherCustomerNotifyTemplate({
    loadNumber,
    customerName,
    carrierName,
    chargesTotal,
    customerRate: baseRate,
    customerBillLines: billLines,
    newCustomerRate,
  });
  const emailTokens = require("./email-action-tokens");
  const finalizeBase = baseUrl || emailTokens.publicFunctionsBaseUrl();
  let finalizeBtn = "";
  if (invoiceId) {
    const finalizeUrl = emailTokens.buildConfirmUrl({
      baseUrl: finalizeBase,
      path: "finalizeAdditionalChargeInvoice",
      action: "additionalChargeFinalize",
      invoiceId,
      option: "complete",
      tenantId: tenantId || null,
    });
    finalizeBtn =
      `<hr style="border:none;border-top:1px solid #e5e7eb;margin:18px 0">` +
      `<p><strong>After you notify the customer</strong>, click below to ` +
      `complete the invoice workflow (generate and send the customer ` +
      `invoice). Billing stays paused until you do.</p>` +
      `<p style="margin:14px 0"><a href="` +
      `${emailTokens.escapeHtmlAttr(finalizeUrl)}" ` +
      `style="background:#0d9488;color:#ffffff;padding:12px 18px;` +
      `border-radius:6px;text-decoration:none;font-weight:600;` +
      `display:inline-block">Customer notified — complete invoice</a></p>` +
      `<p style="font-size:11px;color:#9ca3af;margin:0 0 8px">` +
      `Opens a confirmation page - nothing happens until you click ` +
      `Confirm.</p>`;
  }
  const html =
    `<p>Hi${dispatcherName ? ` ${esc(dispatcherName)}` : ""},</p>` +
    `<p>An additional carrier charge on load ` +
    `<strong>${esc(String(loadNumber || ""))}</strong> ` +
    `(${esc(carrierName || "carrier")}) was approved to be billed to the ` +
    `customer. <strong>Please notify the customer</strong>` +
    `${customerName ? ` (${esc(customerName)})` : ""} ` +
    `about the additional charge <strong>before</strong> the customer ` +
    `invoice is sent.</p>` +
    billingBlock +
    `<hr style="border:none;border-top:1px solid #e5e7eb;margin:18px 0">` +
    `<p><strong>Ready-to-send customer email</strong> - copy or forward ` +
    `this to the customer:</p>` +
    `<p style="font-size:13px;color:#6b7280"><strong>Subject:</strong> ` +
    `${esc(forward.subject)}</p>` +
    `<div style="border:1px solid #bfdbfe;border-radius:8px;padding:16px;` +
    `background:#eff6ff;font-size:14px">${forward.html}</div>` +
    finalizeBtn +
    `<p style="font-size:12px;color:#6b7280;margin-top:14px">This item ` +
    `stays on your task list (Additional Charges Follow-Up) until the ` +
    `customer is notified and you complete the invoice.</p>`;
  return {
    subject: toOutboundEmailSafeSubject(
        `Task - notify customer of additional charge on Load ${loadNumber}`),
    html: toOutboundEmailSafeText(html),
  };
}

/**
 * Creates a follow-up entry so the charge is tracked until resolved.
 * @param {object} db Firestore instance.
 * @param {object} data loadNumber, carrierName, customerName, invoiceId,
 *   category, charges, chargesTotal, invoiceAmount, status, notes.
 * @return {Promise<string>} Follow-up doc id.
 */
async function createFollowUp(db, data) {
  const doc = await db.collection(FOLLOW_UP_COLLECTION).add({
    loadNumber: data.loadNumber || null,
    carrierName: data.carrierName || null,
    customerName: data.customerName || null,
    invoiceId: data.invoiceId || null,
    tenantId: data.tenantId || null,
    category: data.category || null,
    charges: Array.isArray(data.charges) ? data.charges : [],
    chargesTotal: Number(data.chargesTotal) || 0,
    invoiceAmount: Number(data.invoiceAmount) || 0,
    status: data.status || FOLLOW_UP_STATUS.PENDING_APPROVAL,
    decision: null,
    decisionAt: null,
    notes: data.notes || null,
    resolved: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  try {
    const dashboardTasks = require("./dashboard-tasks");
    await dashboardTasks.createDashboardTask(db, {
      tenantId: data.tenantId || "default",
      type: dashboardTasks.TASK_TYPE.ADDITIONAL_CHARGE,
      title: `Additional charge - Load ${data.loadNumber || "-"}`,
      description: data.notes || null,
      loadNumber: data.loadNumber || null,
      carrierName: data.carrierName || null,
      invoiceId: data.invoiceId || null,
      followUpId: doc.id,
      reason: data.category || data.status || null,
    });
  } catch (taskErr) {
    console.error("[createFollowUp] dashboard task failed:", taskErr.message);
  }

  return doc.id;
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
 * Customer charge for one Option B accessorial line.
 * Flat amount wins when entered; otherwise carrierCost * (1 + pct/100).
 * @param {object} opts carrierAmount, markupPct, flatAmount, amount.
 * @return {object} {ok, amount?, error?, pricingMode?, markupPct?, flatAmount?}
 */
function computeCustomerChargeAmount(opts) {
  const row = opts || {};
  const flatRaw = row.flatAmount;
  const hasFlat = flatRaw != null && String(flatRaw).trim() !== "";
  if (hasFlat) {
    const flat = Math.round(Number(flatRaw) * 100) / 100;
    if (!Number.isFinite(flat) || flat <= 0) {
      return {
        ok: false,
        error: "Flat customer charge must be greater than 0.",
      };
    }
    return {
      ok: true,
      amount: flat,
      pricingMode: "flat",
      flatAmount: flat,
      markupPct: null,
    };
  }
  const pctRaw = row.markupPct;
  const hasPct = pctRaw != null && String(pctRaw).trim() !== "";
  if (hasPct) {
    const pct = Number(pctRaw);
    const carrier = Math.round(Number(row.carrierAmount) * 100) / 100;
    if (!Number.isFinite(pct) || pct < 0) {
      return {
        ok: false,
        error: "Markup percent must be 0 or greater.",
      };
    }
    if (!Number.isFinite(carrier) || carrier <= 0) {
      return {
        ok: false,
        error: "Carrier cost is required when using a percent markup.",
      };
    }
    const amount = Math.round(carrier * (1 + pct / 100) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      return {ok: false, error: "Could not compute customer charge."};
    }
    return {
      ok: true,
      amount,
      pricingMode: "markup",
      markupPct: pct,
      flatAmount: null,
    };
  }
  // Legacy / already-computed amount on the line.
  const amount = Math.round(Number(row.amount) * 100) / 100;
  if (Number.isFinite(amount) && amount > 0) {
    return {
      ok: true,
      amount,
      pricingMode: row.pricingMode || "amount",
      markupPct: row.markupPct != null ? Number(row.markupPct) : null,
      flatAmount: row.flatAmount != null ? Number(row.flatAmount) : null,
    };
  }
  return {
    ok: false,
    error: "Enter a percent markup or a flat customer charge.",
  };
}

/**
 * @param {Array<object>} lines Customer bill lines.
 * @return {string}
 */
function customerBillLinesHtml(lines) {
  const rows = (Array.isArray(lines) ? lines : [])
      .map((line) => {
        const carrier = Number(line && line.carrierAmount) || 0;
        const carrierNote = carrier > 0 ?
          ` <span style="color:#6b7280">(carrier ${money(carrier)}` +
          (line.pricingMode === "markup" && line.markupPct != null ?
            `; +${esc(String(line.markupPct))}%` :
            (line.pricingMode === "flat" ? "; flat" : "")) +
          `)</span>` : "";
        return `<li>${esc(String(line.name || "Accessorial"))}: ` +
          `<strong>${money(line.amount)}</strong>${carrierNote}</li>`;
      })
      .join("");
  return rows ?
    `<ul style="margin:6px 0 6px 18px;padding:0">${rows}</ul>` :
    "";
}

/**
 * @param {Array<object>} lines Raw line objects.
 * @return {object} Normalized lines payload.
 */
function normalizeCustomerBillLines(lines) {
  const out = [];
  for (const line of (Array.isArray(lines) ? lines : [])) {
    const name = String(line && (line.name || line.label) || "").trim();
    if (!name) continue;
    const carrierAmount = Math.round(
        Number(line && line.carrierAmount) * 100) / 100;
    const priced = computeCustomerChargeAmount({
      carrierAmount: Number.isFinite(carrierAmount) ? carrierAmount : 0,
      markupPct: line && line.markupPct,
      flatAmount: line && line.flatAmount,
      amount: line && line.amount,
      pricingMode: line && line.pricingMode,
    });
    if (!priced.ok) {
      return {
        ok: false,
        error: `${priced.error} (${name})`,
      };
    }
    out.push({
      name,
      amount: priced.amount,
      carrierAmount: Number.isFinite(carrierAmount) && carrierAmount > 0 ?
        carrierAmount : 0,
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
 * Option B confirm page — itemized accessorials with % markup or flat charge.
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
  const baseRateHtml = baseRate > 0 ?
    `<p style="font-size:14px;color:#374151;margin:12px 0">` +
    `<strong>Base customer rate (unchanged):</strong> ` +
    `${formatCustomerRate(baseRate)}</p>` :
    `<p style="font-size:14px;color:#374151;margin:12px 0">` +
    `The base customer freight rate will stay as-is in Primus. For each ` +
    `accessorial, enter a percent markup or a flat customer charge.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(opts.title || "Confirm option B")}</title>` +
    `<style>` +
    `.bill-row{border:1px solid #e5e7eb;border-radius:10px;padding:12px;` +
    `margin-bottom:12px;background:#fafafa}` +
    `.bill-row-top{display:grid;grid-template-columns:1fr 32px;gap:8px;` +
    `align-items:start;margin-bottom:8px}` +
    `.bill-row input,.bill-row select{width:100%;padding:10px 12px;` +
    `border:1px solid #d1d5db;border-radius:8px;font-size:16px;` +
    `box-sizing:border-box;background:#fff}` +
    `.bill-meta{font-size:13px;color:#374151;margin:0 0 8px}` +
    `.bill-meta strong{color:#111827}` +
    `.bill-price{display:grid;grid-template-columns:140px 1fr;gap:8px;` +
    `align-items:end}` +
    `.bill-preview{font-size:13px;color:#0f766e;margin-top:8px;` +
    `font-weight:600}` +
    `.field-label{font-size:12px;color:#6b7280;margin:0 0 4px;` +
    `display:block}` +
    `.add-btn{background:#fff;color:#0d9488;border:1px solid #0d9488;` +
    `padding:8px 12px;border-radius:8px;font-size:14px;cursor:pointer}` +
    `.remove-btn{background:#fff;color:#dc2626;border:1px solid #fecaca;` +
    `border-radius:8px;width:32px;height:42px;cursor:pointer}` +
    `@keyframes spin{to{transform:rotate(360deg)}}` +
    `</style></head>` +
    `<body style="font-family:Arial,sans-serif;max-width:640px;` +
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
    `<p style="font-size:14px;font-weight:600;color:#374151;` +
    `margin-bottom:8px">` +
    `Additional accessorials</p>` +
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
    `const container = document.getElementById("bill-lines");` +
    `function escAttr(v){return String(v ?? "").replace(/&/g,"&amp;")` +
    `.replace(/"/g,"&quot;").replace(/</g,"&lt;");}` +
    `function money(n){return "$"+(Number(n)||0).toFixed(2);}` +
    `function refreshPreview(wrap){` +
    `const carrier=Number(wrap.dataset.carrierAmount)||0;` +
    `const mode=wrap.querySelector(".bill-mode").value;` +
    `const val=Number(wrap.querySelector(".bill-value").value);` +
    `const el=wrap.querySelector(".bill-preview");` +
    `if(mode==="flat"){el.textContent=Number.isFinite(val)&&val>0?` +
    `"Customer charged: "+money(val):"Enter a flat customer charge";` +
    `return;}` +
    `if(!(carrier>0)){el.textContent=` +
    `"Carrier cost required for percent markup";return;}` +
    `if(!Number.isFinite(val)||val<0){el.textContent=` +
    `"Enter a markup percent";return;}` +
    `const amt=Math.round(carrier*(1+val/100)*100)/100;` +
    `el.textContent="Customer charged: "+money(amt)+` +
    `" ("+money(carrier)+" + "+val+"%)";}` +
    `function addRow(row={}){` +
    `const wrap=document.createElement("div");wrap.className="bill-row";` +
    `const carrier=Number(row.carrierAmount)||0;` +
    `wrap.dataset.carrierAmount=String(carrier);` +
    `const mode=row.pricingMode==="flat"?"flat":"markup";` +
    `const seedVal=mode==="flat"?` +
    `(row.flatAmount!=null?row.flatAmount:row.amount||""):` +
    `(row.markupPct!=null?row.markupPct:"");` +
    `wrap.innerHTML="<div class=\\"bill-row-top\\"><div>"+` +
    `"<label class=\\"field-label\\">Accessorial name</label>"+` +
    `"<input type=\\"text\\" class=\\"bill-name\\" ` +
    `placeholder=\\"e.g. Liftgate\\" value=\\""+escAttr(row.name||"")+` +
    `"\\" required></div>"+` +
    `"<button type=\\"button\\" class=\\"remove-btn\\" ` +
    `title=\\"Remove\\">×</button></div>"+` +
    `"<p class=\\"bill-meta\\"><strong>Carrier cost:</strong> "+` +
    `(carrier>0?money(carrier):"Not set — use flat charge or edit")+` +
    `"</p>"+` +
    `"<div class=\\"bill-price\\"><div>"+` +
    `"<label class=\\"field-label\\">Charge type</label>"+` +
    `"<select class=\\"bill-mode\\"><option value=\\"markup\\""+` +
    `(mode==="markup"?" selected":"")+` +
    `">Percent markup</option><option value=\\"flat\\""+` +
    `(mode==="flat"?" selected":"")+` +
    `">Flat customer amount</option></select></div><div>"+` +
    `"<label class=\\"field-label bill-value-label\\">"+` +
    `(mode==="flat"?"Flat amount ($)":"Markup (%)")+"</label>"+` +
    `"<input type=\\"number\\" class=\\"bill-value\\" min=\\"0\\" ` +
    `step=\\"0.01\\" placeholder=\\""+(mode==="flat"?"250.00":"20")+` +
    `"\\" value=\\""+escAttr(seedVal===0||seedVal?String(seedVal):"")+` +
    `"\\" required></div></div>"+` +
    `"<div class=\\"bill-preview\\"></div>";` +
    `const syncLabel=()=>{` +
    `const m=wrap.querySelector(".bill-mode").value;` +
    `wrap.querySelector(".bill-value-label").textContent=` +
    `m==="flat"?"Flat amount ($)":"Markup (%)";` +
    `wrap.querySelector(".bill-value").placeholder=` +
    `m==="flat"?"250.00":"20";refreshPreview(wrap);};` +
    `wrap.querySelector(".bill-mode").onchange=syncLabel;` +
    `wrap.querySelector(".bill-value").oninput=()=>refreshPreview(wrap);` +
    `wrap.querySelector(".remove-btn").onclick=()=>{wrap.remove();};` +
    `container.appendChild(wrap);refreshPreview(wrap);}` +
    `(seedRows.length?seedRows:[{name:"",carrierAmount:0}]).forEach(addRow);` +
    `document.getElementById("add-bill-line").onclick=` +
    `()=>addRow({name:"",carrierAmount:0});` +
    `document.getElementById("option-b-form").onsubmit=(e)=>{` +
    `const lines=[];` +
    `for(const row of container.querySelectorAll(".bill-row")){` +
    `const name=row.querySelector(".bill-name").value.trim();` +
    `if(!name)continue;` +
    `const carrierAmount=Number(row.dataset.carrierAmount)||0;` +
    `const mode=row.querySelector(".bill-mode").value;` +
    `const val=Number(row.querySelector(".bill-value").value);` +
    `if(mode==="flat"){` +
    `if(!(val>0)){alert("Enter a flat customer charge for "+name);` +
    `e.preventDefault();return false;}` +
    `lines.push({name,carrierAmount,pricingMode:"flat",flatAmount:val,` +
    `markupPct:null,amount:val});` +
    `}else{` +
    `if(!(carrierAmount>0)){alert(name+": carrier cost required for ` +
    `% markup, or switch to flat amount.");e.preventDefault();return false;}` +
    `if(!Number.isFinite(val)||val<0){alert("Enter a markup % for "+name);` +
    `e.preventDefault();return false;}` +
    `const amount=Math.round(carrierAmount*(1+val/100)*100)/100;` +
    `lines.push({name,carrierAmount,pricingMode:"markup",markupPct:val,` +
    `flatAmount:null,amount});}}` +
    `if(!lines.length){alert("Enter at least one accessorial with a ` +
    `percent markup or flat charge.");e.preventDefault();return false;}` +
    `document.getElementById("customerBillLinesJson").value=` +
    `JSON.stringify(lines);` +
    `const btn=e.target.querySelector('button[type="submit"]');` +
    `if(btn&&!btn.disabled){btn.disabled=true;` +
    `btn.innerHTML='<span style="display:inline-block;width:16px;` +
    `height:16px;border:2px solid rgba(255,255,255,.35);` +
    `border-top-color:#fff;border-radius:50%;` +
    `animation:spin .7s linear infinite;` +
    `vertical-align:-3px;margin-right:8px"></span>Processing…';}` +
    `return true;};` +
    `</script></body></html>`;
}

module.exports = {
  FOLLOW_UP_COLLECTION,
  FOLLOW_UP_STATUS,
  CHARGE_CATEGORY,
  RATE_MATCH_TOLERANCE,
  MIN_IGNORABLE_CHARGE_AMOUNT,
  LISA_EMAIL,
  coerceMoneyNumber,
  primusAmountMatchTolerance,
  evaluatePrimusAmountMatch,
  invoiceTotalMatchesPrimusCost,
  mergeLisaOnCc,
  applyAdditionalChargeEmailCc,
  applyDispatcherEmailCc,
  formatCustomerRate,
  isWeightInspectionLabel,
  isAccessorialLabel,
  displayChargeLabel,
  displayChargeLabelForRow,
  parseNotifyDetentionStorage,
  isNotifyDetentionStorageCharge,
  collectNotifyDetentionStorageCharges,
  summarizeNotifyDetentionStorage,
  formatNotifyDetentionStorageExplanation,
  rehomeNotifyDetentionToUnrecognized,
  sumCharges,
  normalizeBreakdownText,
  chargeBreakdownKeywords,
  isChargeInPrimusBreakdown,
  filterIgnorableSmallCharges,
  partitionChargesByPrimus,
  filterChargesForApproval,
  detectFreightMismatch,
  readInvoiceFreight,
  readBookingFreightSnapshot,
  formatDims,
  formatWeightLbs,
  buildRequoteFreightInfo,
  buildRateQueryFromBooking,
  evaluateRequoteMatch,
  computeAddedCharge,
  isReplacementWeightInvoice,
  buildWeightRebillSummary,
  normalizeCertificatePages,
  certificateTextHasPricing,
  weightRebillSectionHtml,
  classifyAdditionalChargeReason,
  validateLumperAmount,
  LUMPER_BASE_TOLERANCE,
  resolveEffectiveChargeCategory,
  categoryLabel,
  pickCarrierInvoiceAttachment,
  listAdditionalChargeApprovalAttachments,
  validateCarrierInvoiceAttachment,
  buildAdditionalChargeApprovalEmail,
  buildDisputeEmailDraft,
  buildCustomerChargeNotificationEmail,
  buildDispatcherCustomerNotifyTemplate,
  buildDispatcherNotifyReminderEmail,
  buildOptionBAccessorialConfirmPage,
  customerBillLinesHtml,
  sumCustomerBillLines,
  computeCustomerChargeAmount,
  normalizeCustomerBillLines,
  parseCustomerChargeAmountFromRequest,
  parseCustomerBillLinesFromRequest,
  seedCustomerBillLinesFromCharges,
  createFollowUp,
  updateFollowUp,
};
