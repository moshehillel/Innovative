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
 *   C. Approval email offers FOUR decisions:
 *        A — pay carrier + bill customer; auto-email the customer contact.
 *        B — pay carrier + bill customer; dispatcher notifies the customer
 *            (system reminds the dispatcher / adds to their task list).
 *        C — pay carrier only; customer rate stays the same (not itemized).
 *        D — not approved; generate a carrier dispute draft for manual
 *            submission (LTL portals) or email (TL).
 *   D. Every case is tracked on an Additional Charges Follow-Up list until
 *      resolved.
 *
 * Env:
 *   ADDITIONAL_CHARGE_APPROVER_EMAIL — Sarah (approval email recipient);
 *     default Sarah@innovativecarriers.com (same domain as Lisa).
 */

"use strict";

const admin = require("firebase-admin");

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

const WNI_LABEL_PATTERN =
  /re-?weigh|w\s*&\s*i\b|weight\s*(?:&|and)\s*inspect|inspect(?:ion)?\s*(?:cert|fee|charge)|re-?class(?:ification)?|cubic|density|re-?dim/i;

/** Accessorial / service fee labels (not weight/reclass). */
const ACCESSORIAL_LABEL_PATTERN =
  /school|notify|detention|delivery|liftgate|lumper|appointment|residential|inside|limited\s*access|accessorial|sort(?:ing)?|seg(?:regat)?|re-?deliver|notification|call\s*ahead|reschedule|storage|redelivery|hazmat|oversize|overlength|single\s*shipment|construction|military|farm|church|mine|prison|utility|airport|trade\s*show|exhibition|pallet|handling|chassis|drop|stop\s*off|driver\s*assist|tailgate|residential|non-?commercial/i;

/** Dollars: Primus re-rate vs carrier invoice is a match within this. */
const RATE_MATCH_TOLERANCE = 10;

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
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
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
    "<p><em>No itemized charge rows — total difference only.</em></p>";
}

/**
 * Builds the 4-option approval email for Sarah + the dispatcher.
 * @param {object} opts baseUrl, invoiceId, tenantId, loadNumber, carrierName,
 *   customerName, invoiceAmount, primusAmount, charges, chargesTotal,
 *   category, freightMismatch, hasCertificate, dispatcherName,
 *   rateValidation (optional W&I re-rate result), customerRate.
 * @return {{subject: string, html: string}}
 */
function buildAdditionalChargeApprovalEmail(opts) {
  const {
    baseUrl, invoiceId, tenantId, loadNumber, carrierName, customerName,
    invoiceAmount, primusAmount, charges, chargesTotal, category,
    freightMismatch, hasCertificate, dispatcherName, rateValidation,
    customerRate,
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
    `Opens a confirmation page — nothing happens until you click ` +
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
    row("Additional charges", money(chargesTotal)) +
    row("Reason (detected)", esc(categoryLabel(category))) +
    (hasCertificate ?
      row("W&amp;I certificate", "Attached / referenced on invoice") : "") +
    (dispatcherName ? row("Dispatcher", esc(dispatcherName)) : "") +
    `</table>` +
    accessorialConfirmHtml +
    mismatchHtml +
    rateHtml +
    `<p><strong>Charges:</strong></p>` +
    chargesHtml(charges) +
    `<hr style="border:none;border-top:1px solid #e5e7eb;margin:18px 0">` +
    `<p><strong>Choose one:</strong></p>` +
    btn("a", "#16a34a",
        "A — Approve: pay carrier + bill customer (auto-email customer)") +
    btn("b", "#0d9488",
        "B — Approve: pay carrier + bill customer " +
        "(enter updated rate; dispatcher notifies customer)") +
    btn("c", "#2563eb",
        "C — Approve: pay carrier only (customer rate unchanged)") +
    btn("d", "#dc2626",
        "D — Not approved: dispute with carrier") +
    `<p style="font-size:12px;color:#6b7280">A: customer rate is auto-bumped ` +
    `by the charge amount and the customer is emailed. B: you enter the ` +
    `updated customer rate on the confirm page and the dispatcher notifies ` +
    `the customer of that amount. C: the carrier bill is entered at the full ` +
    `carrier amount and the customer rate stays the same (no itemization ` +
    `needed). D: Jerry will draft the dispute wording for manual submission.` +
    `</p>`;

  return {
    subject: `Approval needed — additional charge on Load ${loadNumber} ` +
      `(${categoryLabel(category)})`,
    html,
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
    subject: `Dispute draft — ${carrierName || "carrier"} invoice on ` +
      `Load ${loadNumber}`,
    html,
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
    subject: `Additional charge on shipment ${loadNumber}`,
    html,
  };
}

/**
 * Dispatcher reminder for decision B (dispatcher must notify the customer).
 * @param {object} opts dispatcherName, loadNumber, carrierName, customerName,
 *   charges, chargesTotal.
 * @return {{subject: string, html: string}}
 */
function buildDispatcherNotifyReminderEmail(opts) {
  const {
    dispatcherName, loadNumber, carrierName, customerName,
    charges, chargesTotal, customerRate, originalCustomerRate,
  } = opts;
  const html =
    `<p>Hi${dispatcherName ? ` ${esc(dispatcherName)}` : ""},</p>` +
    `<p>An additional carrier charge on load ` +
    `<strong>${esc(String(loadNumber || ""))}</strong> ` +
    `(${esc(carrierName || "carrier")}) was approved to be billed to the ` +
    `customer, and it was decided that <strong>you will notify the ` +
    `customer</strong>${customerName ? ` (${esc(customerName)})` : ""} ` +
    `about it yourself.</p>` +
    (customerRate != null && Number(customerRate) > 0 ?
      `<p><strong>Updated customer rate to bill: ` +
      `${formatCustomerRate(customerRate)}</strong>` +
      (originalCustomerRate != null && Number(originalCustomerRate) > 0 &&
        Number(originalCustomerRate) !== Number(customerRate) ?
        ` (was ${formatCustomerRate(originalCustomerRate)})` : "") +
      `</p>` +
      `<p>Please notify the customer of this updated amount.</p>` : "") +
    chargesHtml(charges) +
    `<p>Total additional: <strong>${money(chargesTotal)}</strong></p>` +
    `<p><strong>Action needed:</strong> please email the customer about ` +
    `this charge and the updated rate above. This item stays on your task ` +
    `list (Additional Charges Follow-Up) until done.</p>`;
  return {
    subject: `Task — notify customer of additional charge on ` +
      `Load ${loadNumber}`,
    html,
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

module.exports = {
  FOLLOW_UP_COLLECTION,
  FOLLOW_UP_STATUS,
  CHARGE_CATEGORY,
  RATE_MATCH_TOLERANCE,
  LISA_EMAIL,
  mergeLisaOnCc,
  applyAdditionalChargeEmailCc,
  formatCustomerRate,
  isWeightInspectionLabel,
  isAccessorialLabel,
  displayChargeLabel,
  sumCharges,
  detectFreightMismatch,
  buildRequoteFreightInfo,
  buildRateQueryFromBooking,
  evaluateRequoteMatch,
  classifyAdditionalChargeReason,
  resolveEffectiveChargeCategory,
  categoryLabel,
  buildAdditionalChargeApprovalEmail,
  buildDisputeEmailDraft,
  buildCustomerChargeNotificationEmail,
  buildDispatcherNotifyReminderEmail,
  createFollowUp,
  updateFollowUp,
};
