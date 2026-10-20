/**
 * Pier Pass (TMF) and Port Check (CTF) invoice intake.
 *
 * Each PDF is one vendor bill covering many containers. Jerry posts one
 * actual-cost line per container onto the Primus load found by that
 * container number (the load PRO). The ocean booking number on the PDF
 * is not a Primus BOL and is never used as the lookup key.
 *
 * Bill date and due date are the invoice date. Terms are Due on receipt.
 * Customer charges are left alone.
 *
 * A PDF is a bill when the text has a bill number, an invoice date, fee
 * wording (Traffic Mitigation Fee / TMF / PierPASS, or Clean Truck Fee /
 * CTF / Port Check / Port Rate), and at least one container amount. The
 * title line is a hint. Same vendor, code, bill number, and amount is
 * already on the load and is not posted again.
 */

"use strict";

const podUtils = require("./pod-utils");
const loadResolution = require("./invoice-load-resolution");

/** @type {object} Injected from index.js */
let deps = {};

/**
 * @param {object} bundle Shared helpers.
 * @return {void}
 */
function init(bundle) {
  deps = bundle || {};
}

/**
 * @enum {string}
 */
const SKIP_REASON = {
  LOAD_NOT_FOUND: "LOAD_NOT_FOUND",
  AMBIGUOUS_LOAD: "AMBIGUOUS_LOAD",
  NO_INVOICE: "NO_INVOICE",
  DUPLICATE_FEE: "DUPLICATE_FEE",
  DUPLICATE_LINE: "DUPLICATE_LINE",
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
  ZERO_AMOUNT: "ZERO_AMOUNT",
  POST_FAILED: "POST_FAILED",
  VENDOR_NOT_FOUND: "VENDOR_NOT_FOUND",
  TERMS_NOT_FOUND: "TERMS_NOT_FOUND",
};

const MISSING_LOAD_TO = "Josef@innovativecarriers.com";
const MISSING_LOAD_CC = "Leo@innovativecarriers.com";
const PORT_FEE_CC = "Abe@innovativecarriers.com";

/**
 * Abe is copied on every TMF / CTF email. Existing recipients stay.
 * @param {string|Array<string>|null|undefined} existing Current CC.
 * @return {string} Comma-separated CC list.
 */
function portFeeEmailCc(existing) {
  const parts = [];
  const raw = Array.isArray(existing) ? existing.join(",") :
    String(existing || "");
  for (const piece of raw.split(/[,;]/)) {
    const addr = piece.trim();
    if (!addr) continue;
    if (parts.some((have) => have.toLowerCase() === addr.toLowerCase())) {
      continue;
    }
    parts.push(addr);
  }
  if (!parts.some((have) => have.toLowerCase() === PORT_FEE_CC.toLowerCase())) {
    parts.push(PORT_FEE_CC);
  }
  return parts.join(", ");
}

const CHARGE_PROFILES = {
  TMF: {
    code: "TMF",
    description: "TMF",
    vendorName: "Pier Pass",
    label: "Traffic Mitigation Fee",
  },
  CTF: {
    code: "CTF",
    description: "CTF",
    vendorName: "Port Check",
    label: "Clean Truck Fee",
  },
};

/**
 * @param {number} amount Raw money value.
 * @return {number}
 */
function roundMoney(amount) {
  return Math.round(Number(amount || 0) * 100) / 100;
}

/**
 * @param {number} a First amount.
 * @param {number} b Second amount.
 * @return {boolean}
 */
function moneyEquals(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) <= 0.009;
}

/**
 * @param {*} value Raw string.
 * @return {string}
 */
function escapeHtml(value) {
  return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
}

/**
 * ISO 6346 container id: 3-letter owner + category U/J/Z + 7 digits.
 * @param {string} value Raw token.
 * @return {boolean}
 */
function isIsoContainer(value) {
  return /^[A-Z]{3}[UJZ]\d{7}$/.test(String(value || "").toUpperCase());
}

/** Pier Pass / Port Check bill numbers: account, sequence, then IN. */
const BILL_NUMBER_RE = /\b(\d{4,8}-\d{5,}-IN)\b/i;

/**
 * Fee wording that shows up in the text layer. The painted title is not
 * required. "PierPASS/INNOVATIVE CARRIERS" alone is the bill-to line, not
 * a TMF charge.
 * @param {string} text PDF text.
 * @return {object}
 */
function readFeeWording(text) {
  const raw = String(text || "");
  return {
    tmfPhrase: /Traffic Mitigation Fee/i.test(raw),
    tmfCode: /\bTMF\b/.test(raw),
    mitigation: /Mitigation\s+Fee/i.test(raw),
    pierpass: /Pier\s*-?\s*Pass/i.test(raw),
    ctfPhrase: /Clean Truck Fee/i.test(raw),
    ctfCode: /\bCTF\b/.test(raw),
    ctfTitle: /Port Rate Invoice/i.test(raw),
    portRate: /Port Rate/i.test(raw),
    portCheck: /Port\s*-?\s*Check/i.test(raw),
  };
}

/**
 * @param {object} wording readFeeWording result.
 * @return {string|null} "TMF", "CTF", or null when the two families conflict.
 */
function kindFromWording(wording) {
  const w = wording || {};
  const tmf = w.tmfPhrase || w.tmfCode || (w.pierpass && w.mitigation);
  const ctf = w.ctfPhrase || w.ctfCode || w.portCheck || w.ctfTitle ||
    (w.portRate && (w.ctfPhrase || w.portCheck || w.ctfTitle || w.ctfCode));
  if (tmf && ctf) return null;
  if (tmf) return "TMF";
  if (ctf) return "CTF";
  return null;
}

/**
 * Suspension notices, newsletters, and payment receipts are not bills,
 * even when they come from pierpass.net or mention a fee.
 * @param {string} text PDF text.
 * @return {string|null}
 */
function nonInvoiceReason(text) {
  const raw = String(text || "");
  if (/\b(?:suspended|suspension)\b/i.test(raw)) {
    return "suspension notice is not an invoice";
  }
  if (/\bnewsletter\b/i.test(raw)) return "newsletter is not an invoice";
  const receipt = new RegExp(
      "\\b(payment receipt|thank you for your payment|" +
      "payment confirmation|receipt of payment)\\b",
      "i",
  );
  if (receipt.test(raw)) {
    return "payment receipt is not an invoice";
  }
  return null;
}

/**
 * @param {string} text PDF text.
 * @return {string|null} "TMF" or "CTF" only when the text is a real bill.
 */
function detectPortFeeKind(text) {
  const assessed = assessPortFeeText(text);
  return assessed.complete ? assessed.kind : null;
}

/**
 * Pier Pass and Port Check invoices must stay on the port-fee path.
 * A suspension notice from the same domain is not an invoice.
 * @param {string} from Sender.
 * @param {string} subject Subject.
 * @return {boolean}
 */
function isPortFeeMessage(from, subject) {
  const fromL = String(from || "").toLowerCase();
  const subjectL = String(subject || "").toLowerCase();
  const notInvoice = new RegExp(
      "\\b(?:suspended|suspension|newsletter|" +
      "payment receipt|payment confirmation)\\b",
  );
  if (notInvoice.test(subjectL)) {
    return false;
  }
  const portSender = /pierpass\.net|portcheck\.org/.test(fromL);
  const invoiceSubject = /\binvoice\b/.test(subjectL);
  const namedInvoice = invoiceSubject &&
    /pier\s*pass|pierpass|port\s*check|portcheck/.test(subjectL);
  return namedInvoice || (portSender && invoiceSubject);
}

/**
 * @param {string} mdy MM/DD/YYYY.
 * @return {string|null} YYYY-MM-DD.
 */
function usDateToIso(mdy) {
  const m = String(mdy || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${m[3]}-${mm}-${dd}`;
}

/**
 * Invoice date from a labeled date, or from the classic
 * period-start / period-end / invoice-date triple after the bill number.
 * The due date that follows the dollar total is not the bill date.
 * @param {string} raw Full text.
 * @param {string|null} invoiceNumber Bill number.
 * @return {string|null} YYYY-MM-DD.
 */
function findInvoiceDate(raw, invoiceNumber) {
  const labeledRe = new RegExp(
      "(?:Invoice\\s*Date|Bill\\s*Date|Date\\s+of\\s+Invoice)" +
      "\\s*[:#-]?\\s*(\\d{1,2}/\\d{1,2}/\\d{4})",
      "i",
  );
  const labeled = String(raw || "").match(labeledRe);
  if (labeled) {
    const iso = usDateToIso(labeled[1]);
    if (iso) return iso;
  }
  const periodRe = new RegExp(
      "(\\d{1,2}/\\d{1,2}/\\d{4})\\s*-\\s*" +
      "(\\d{1,2}/\\d{1,2}/\\d{4})\\s+" +
      "(\\d{1,2}/\\d{1,2}/\\d{4})",
  );
  let scope = String(raw || "");
  if (invoiceNumber) {
    const at = scope.toUpperCase().indexOf(String(invoiceNumber).toUpperCase());
    if (at >= 0) scope = scope.slice(at);
  }
  const period = scope.match(periodRe) || String(raw || "").match(periodRe);
  if (!period) return null;
  return usDateToIso(period[3]);
}

/**
 * @param {string} raw Full text.
 * @return {number}
 */
function resolveInvoiceTotal(raw) {
  const dollar = String(raw || "").match(/\$\s*([0-9,]+\.\d{2})/);
  if (dollar) return roundMoney(String(dollar[1]).replace(/,/g, ""));
  const totals = [
    ...String(raw || "").matchAll(
        /\bTotal(?:\s+Due)?\b[^0-9$]{0,40}\$?\s*([0-9,]+\.\d{2})/gi,
    ),
  ];
  if (!totals.length) return 0;
  return roundMoney(String(totals[totals.length - 1][1]).replace(/,/g, ""));
}

/**
 * Pulls container + fee pairs from the detail section.
 * The fee is the first money amount after the container and before the
 * next container or the footer Total.
 * @param {string} text Full invoice text.
 * @return {Array<{container: string, amount: number}>}
 */
function parseContainerLines(text) {
  const raw = String(text || "");
  const detailAt = raw.search(/\b(?:Container|Cntr)\b/i);
  const detail = detailAt >= 0 ? raw.slice(detailAt) : raw;
  const re = /\b([A-Z]{4}\d{7})\b/g;
  const hits = [];
  let match;
  while ((match = re.exec(detail))) {
    const container = match[1].toUpperCase();
    if (!isIsoContainer(container)) continue;
    hits.push({container, index: match.index});
  }
  const lines = [];
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].index + hits[i].container.length;
    const end = i + 1 < hits.length ? hits[i + 1].index : detail.length;
    let span = detail.slice(start, end);
    const totalCut = span.search(/\bTotal\b/);
    if (totalCut >= 0) span = span.slice(0, totalCut);
    const money = span.match(/\b(\d{1,3}(?:,\d{3})*\.\d{2})\b/);
    const amount = money ?
      roundMoney(String(money[1]).replace(/,/g, "")) : 0;
    lines.push({container: hits[i].container, amount});
  }
  return lines;
}

/**
 * @param {string} text PDF text.
 * @return {string|null}
 */
function billNumberFrom(text) {
  const match = String(text || "").match(BILL_NUMBER_RE);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Decides whether extracted text is a Pier Pass or Port Check bill.
 * A bill has a bill number, an invoice date, fee wording, and at least
 * one container line with an amount. The title is only a hint.
 * @param {string} text PDF text.
 * @return {object}
 */
function assessPortFeeText(text) {
  const raw = String(text || "");
  if (!raw.trim()) {
    return {
      complete: false,
      partial: false,
      notInvoice: false,
      kind: null,
      error: "no text",
    };
  }

  const wording = readFeeWording(raw);
  const kind = kindFromWording(wording);
  const invoiceNumber = billNumberFrom(raw);
  const invoiceDate = findInvoiceDate(raw, invoiceNumber);
  const parsedLines = parseContainerLines(raw);
  const hasAmount = parsedLines.some((line) => line.amount > 0);
  const invoiceTotal = resolveInvoiceTotal(raw);
  const lineSum = roundMoney(
      parsedLines.reduce((sum, line) => sum + line.amount, 0));
  const totalOk = invoiceTotal > 0 && moneyEquals(lineSum, invoiceTotal);
  const complete = !!(kind && invoiceNumber && invoiceDate &&
    parsedLines.length && hasAmount && totalOk);

  if (complete) {
    return {
      complete: true,
      partial: false,
      notInvoice: false,
      kind,
      invoiceNumber,
      invoiceDate,
      invoiceTotal,
      lines: parsedLines,
      printedDueDate: printedDueDateFrom(raw),
      error: null,
    };
  }

  const veto = nonInvoiceReason(raw);
  if (veto) {
    return {
      complete: false,
      partial: false,
      notInvoice: true,
      kind: null,
      error: veto,
    };
  }

  const missing = [];
  if (!invoiceNumber) missing.push("no invoice number");
  if (!invoiceDate) missing.push("no invoice date");
  if (!parsedLines.length) missing.push("no container lines");
  else if (!hasAmount || !(invoiceTotal > 0)) missing.push("no amount");
  if (!kind) missing.push("no TMF or CTF fee wording");
  if (kind && invoiceNumber && invoiceDate && hasAmount &&
      invoiceTotal > 0 && !totalOk) {
    return {
      complete: false,
      partial: true,
      notInvoice: false,
      kind,
      invoiceNumber,
      error: `line total ${lineSum.toFixed(2)} does not match ` +
        `invoice total ${invoiceTotal.toFixed(2)}`,
    };
  }

  const partial = !!(
    (invoiceNumber && (kind || wording.pierpass || wording.portCheck ||
      wording.tmfPhrase || wording.ctfPhrase || wording.portRate)) ||
    (parsedLines.length && kind && (invoiceNumber || invoiceDate))
  );
  return {
    complete: false,
    partial,
    notInvoice: false,
    kind,
    invoiceNumber,
    error: missing.join("; ") || "no text",
  };
}

/**
 * @param {string} raw Full text.
 * @return {string|null}
 */
function printedDueDateFrom(raw) {
  const dueMatch = String(raw || "").match(
      /\$\s*[0-9,]+\.\d{2}\s+(\d{1,2}\/\d{1,2}\/\d{4})/,
  );
  return dueMatch ? usDateToIso(dueMatch[1]) : null;
}

/**
 * @param {string} text Extracted PDF text.
 * @param {object} [meta] filename.
 * @return {object} {ok, error?, invoice?}
 */
function parsePortFeeInvoiceText(text, meta) {
  const assessed = assessPortFeeText(text);
  if (!assessed.complete) {
    return {
      ok: false,
      error: assessed.error,
      kind: assessed.kind || null,
      partial: !!assessed.partial,
      notInvoice: !!assessed.notInvoice,
      invoiceNumber: assessed.invoiceNumber || null,
    };
  }
  const profile = CHARGE_PROFILES[assessed.kind];
  const seen = new Set();
  const lines = [];
  for (const line of assessed.lines) {
    const row = {
      container: line.container,
      amount: line.amount,
      chargeCode: profile.code,
      description: profile.description,
    };
    if (seen.has(line.container)) {
      row.duplicateOnInvoice = true;
    } else {
      seen.add(line.container);
    }
    lines.push(row);
  }
  return {
    ok: true,
    invoice: {
      kind: assessed.kind,
      chargeCode: profile.code,
      description: profile.description,
      vendorName: profile.vendorName,
      label: profile.label,
      invoiceNumber: assessed.invoiceNumber,
      invoiceDate: assessed.invoiceDate,
      printedDueDate: assessed.printedDueDate,
      invoiceTotal: assessed.invoiceTotal,
      lines,
      filename: (meta && meta.filename) || null,
    },
  };
}

/**
 * @param {object} row Tracking-search row.
 * @param {string} container Container number.
 * @return {boolean}
 */
function rowHasContainer(row, container) {
  let blob = "";
  try {
    blob = JSON.stringify(row);
  } catch (_) {
    blob = "";
  }
  return new RegExp(`\\b${container}\\b`, "i").test(blob);
}

/**
 * Picks the Primus load for a container search.
 * Prefers a row that actually contains the container. A single search
 * hit is accepted when Primus returned only that load.
 * @param {Array<object>} rows getBookingsForTracking rows.
 * @param {string} container Container number.
 * @return {object}
 */
function pickContainerMatch(rows, container) {
  const valid = [];
  const seen = new Set();
  for (const row of rows || []) {
    const bol = loadResolution.normalizeLoadNumber(
        row && (row.BOL || row.bol));
    if (!loadResolution.isValidLoadNumber(bol) || seen.has(bol)) continue;
    seen.add(bol);
    valid.push({
      loadNumber: bol,
      row,
      echoed: rowHasContainer(row, container),
    });
  }
  const byCarrierRef = valid.filter((r) => {
    const ref = String(r.row && r.row.carrierRef || "").trim().toUpperCase();
    return ref && ref === String(container || "").trim().toUpperCase();
  });
  if (byCarrierRef.length === 1) {
    return {
      ok: true,
      loadNumber: byCarrierRef[0].loadNumber,
      row: byCarrierRef[0].row,
      source: "carrier_ref",
    };
  }
  const echoed = valid.filter((r) => r.echoed);
  const pool = echoed.length ? echoed : (valid.length === 1 ? valid : []);
  if (pool.length === 1) {
    return {
      ok: true,
      loadNumber: pool[0].loadNumber,
      row: pool[0].row,
      source: pool[0].echoed ? "container_on_load" : "single_search_hit",
    };
  }
  if (valid.length > 1) {
    return {ok: false, ambiguous: true, count: valid.length};
  }
  return {ok: false, notFound: true};
}

/**
 * @param {string} code Skip reason.
 * @param {object} [ctx] Extra context.
 * @return {string}
 */
function skipReasonText(code, ctx) {
  const c = ctx || {};
  switch (code) {
    case SKIP_REASON.LOAD_NOT_FOUND:
      return `Container ${c.container || ""} did not match a Primus load.`;
    case SKIP_REASON.AMBIGUOUS_LOAD:
      return `Container ${c.container || ""} matched ${c.count || "several"} ` +
        "loads. Not posted.";
    case SKIP_REASON.NO_INVOICE:
      return `Load ${c.loadNumber || ""} has no Primus invoice yet.`;
    case SKIP_REASON.DUPLICATE_FEE:
      return `Load ${c.loadNumber || ""} already has this charge` +
        (c.existingBill ? ` on bill ${c.existingBill}` : "") + ".";
    case SKIP_REASON.DUPLICATE_LINE:
      return "Container is listed twice on this invoice. Second line skipped.";
    case SKIP_REASON.AMOUNT_MISMATCH:
      return `Load ${c.loadNumber || ""} already has this bill at a ` +
        "different amount.";
    case SKIP_REASON.ZERO_AMOUNT:
      return "Charge amount is zero or unreadable.";
    case SKIP_REASON.VENDOR_NOT_FOUND:
      return `Vendor ${c.vendorName || ""} was not found in Primus.`;
    case SKIP_REASON.TERMS_NOT_FOUND:
      return "Primus has no Due on receipt term.";
    case SKIP_REASON.POST_FAILED:
      return "Could not post to Primus" + (c.error ? `: ${c.error}` : ".");
    default:
      return "Not posted.";
  }
}

/**
 * Posts every line on one parsed invoice.
 * @param {object} opts invoice, findLoad, postCharge, vendor, termsId.
 * @return {Promise<{posted: Array, already: Array, skipped: Array}>}
 */
async function applyPortFeeLines(opts) {
  const invoice = opts.invoice;
  const findLoad = opts.findLoad;
  const postCharge = opts.postCharge;
  const vendor = opts.vendor || null;
  const termsId = opts.termsId;
  const posted = [];
  const already = [];
  const skipped = [];

  if (!vendor || !vendor.id) {
    for (const line of invoice.lines) {
      skipped.push({
        ...line,
        reason: SKIP_REASON.VENDOR_NOT_FOUND,
        vendorName: invoice.vendorName,
      });
    }
    return {posted, already, skipped};
  }
  if (termsId == null || termsId === "") {
    for (const line of invoice.lines) {
      skipped.push({...line, reason: SKIP_REASON.TERMS_NOT_FOUND});
    }
    return {posted, already, skipped};
  }

  for (const line of invoice.lines) {
    if (line.duplicateOnInvoice) {
      skipped.push({...line, reason: SKIP_REASON.DUPLICATE_LINE});
      continue;
    }
    if (!(line.amount > 0)) {
      skipped.push({...line, reason: SKIP_REASON.ZERO_AMOUNT});
      continue;
    }
    let found;
    try {
      found = await findLoad(line.container);
    } catch (err) {
      skipped.push({
        ...line,
        reason: SKIP_REASON.POST_FAILED,
        error: err && err.message,
      });
      continue;
    }
    if (!found || !found.ok) {
      skipped.push({
        ...line,
        reason: found && found.ambiguous ?
          SKIP_REASON.AMBIGUOUS_LOAD : SKIP_REASON.LOAD_NOT_FOUND,
        count: found && found.count,
      });
      continue;
    }

    let result;
    try {
      result = await postCharge({
        loadNumber: found.loadNumber,
        booking: found.booking,
        amount: line.amount,
        chargeCode: invoice.chargeCode,
        description: invoice.description,
        vendor,
        vendorInvoiceNumber: invoice.invoiceNumber,
        billDate: invoice.invoiceDate,
        dueDate: invoice.invoiceDate,
        proNumber: line.container,
        termsId,
      });
    } catch (err) {
      skipped.push({
        ...line,
        loadNumber: found.loadNumber,
        reason: SKIP_REASON.POST_FAILED,
        error: err && err.message,
      });
      continue;
    }

    const base = {
      ...line,
      loadNumber: found.loadNumber,
      matchSource: found.source || null,
    };
    if (result && result.ok && result.skipped) {
      already.push(base);
      continue;
    }
    if (result && result.ok) {
      posted.push(base);
      continue;
    }
    if (result && result.duplicate) {
      skipped.push({
        ...base,
        reason: SKIP_REASON.DUPLICATE_FEE,
        existingBill: result.existingBill || null,
      });
      continue;
    }
    if (result && result.noInvoice) {
      skipped.push({...base, reason: SKIP_REASON.NO_INVOICE});
      continue;
    }
    if (result && result.amountMismatch) {
      skipped.push({...base, reason: SKIP_REASON.AMOUNT_MISMATCH});
      continue;
    }
    skipped.push({
      ...base,
      reason: SKIP_REASON.POST_FAILED,
      error: result && result.error,
    });
  }

  return {posted, already, skipped};
}

/**
 * @param {object} invoice Parsed invoice.
 * @param {object} counts posted, already, skipped.
 * @return {object}
 */
function summarizeInvoice(invoice, counts) {
  const postedSum = roundMoney(
      counts.posted.reduce((s, l) => s + l.amount, 0) +
      counts.already.reduce((s, l) => s + l.amount, 0));
  return {
    invoiceNumber: invoice.invoiceNumber,
    chargeCode: invoice.chargeCode,
    vendorName: invoice.vendorName,
    label: invoice.label,
    invoiceDate: invoice.invoiceDate,
    printedDueDate: invoice.printedDueDate,
    invoiceTotal: invoice.invoiceTotal,
    filename: invoice.filename,
    postedCount: counts.posted.length,
    alreadyCount: counts.already.length,
    skippedCount: counts.skipped.length,
    postedSum,
    matchesInvoice: moneyEquals(postedSum, invoice.invoiceTotal),
    posted: counts.posted,
    already: counts.already,
    skipped: counts.skipped,
  };
}

/**
 * @param {Array<object>} summaries Per-invoice summaries.
 * @param {Array<object>} rejected PDFs that looked like port fees but
 *   did not parse.
 * @return {{subject: string, html: string}}
 */
function buildReconciliationEmail(summaries, rejected) {
  const money = (n) => `$${Number(n || 0).toFixed(2)}`;
  const sections = [];
  let postedTotal = 0;
  let skippedTotal = 0;
  for (const rec of summaries) {
    postedTotal += rec.postedCount + rec.alreadyCount;
    skippedTotal += rec.skippedCount;
    const status = rec.matchesInvoice ?
      `<span style="color:#16a34a;font-weight:700">` +
        `Entered charges match the invoice total.</span>` :
      `<span style="color:#dc2626;font-weight:700">` +
        `Entered charges do not match the invoice total.</span>`;
    const rows = rec.skipped;
    const table = rows.length ?
      `<table style="border-collapse:collapse;font-size:13px;margin:8px 0">` +
      `<tr><th style="text-align:left;padding:4px 10px">Container</th>` +
      `<th style="text-align:left;padding:4px 10px">Load</th>` +
      `<th style="text-align:right;padding:4px 10px">Amount</th>` +
      `<th style="text-align:left;padding:4px 10px">Why</th></tr>` +
      rows.map((r) =>
        `<tr><td style="padding:4px 10px">${escapeHtml(r.container)}</td>` +
        `<td style="padding:4px 10px">` +
        `${escapeHtml(r.loadNumber || "—")}</td>` +
        `<td style="padding:4px 10px;text-align:right">` +
        `${money(r.amount)}</td>` +
        `<td style="padding:4px 10px">` +
        `${escapeHtml(skipReasonText(r.reason, r))}</td></tr>`,
      ).join("") +
      `</table>` :
      `<p style="color:#16a34a">Every charge was entered.</p>`;
    sections.push(
        `<h3>${escapeHtml(rec.vendorName)} ${escapeHtml(rec.chargeCode)} ` +
        `#${escapeHtml(rec.invoiceNumber)}</h3>` +
        `<p>${status}</p>` +
        `<p>Bill date ${escapeHtml(rec.invoiceDate)} · Due on receipt · ` +
        `PRO is the container number. Printed due date on the PDF: ` +
        `${escapeHtml(rec.printedDueDate || "—")}.</p>` +
        `<p>${rec.postedCount} entered, ${rec.alreadyCount} already on ` +
        `the load, ${rec.skippedCount} not entered. Invoice total ` +
        `${money(rec.invoiceTotal)}.</p>` +
        table,
    );
  }
  if (rejected && rejected.length) {
    sections.push(
        `<h3>Could not read</h3><ul>` +
        rejected.map((r) =>
          `<li>${escapeHtml(r.filename || "PDF")}: ` +
          `${escapeHtml(r.error || "parse failed")}</li>`).join("") +
        `</ul>`,
    );
    skippedTotal += rejected.length;
  }
  const subject = `TMF / CTF: ${postedTotal} entered, ${skippedTotal} skipped`;
  const html = `<h2>Pier Pass TMF / Port Check CTF</h2>` + sections.join("");
  return {subject, html};
}

/** @type {Map<string, object>} Container lookup cache for one run. */
let loadCache = new Map();

/**
 * @return {void}
 */
function clearLoadCache() {
  loadCache = new Map();
}

/**
 * @param {string} invoiceNumber Vendor bill number.
 * @param {string} chargeCode TMF or CTF.
 * @param {string} container Container number.
 * @return {string}
 */
function pendingDocId(invoiceNumber, chargeCode, container) {
  return `${invoiceNumber}__${chargeCode}__${container}`
      .replace(/[^\w.-]+/g, "_");
}

/**
 * @return {FirebaseFirestore.CollectionReference|null}
 */
function pendingCollection() {
  if (typeof deps.pendingCollection !== "function") return null;
  return deps.pendingCollection();
}

/**
 * @param {Array<object>} rows Missing-load rows.
 * @return {{subject: string, html: string}}
 */
function buildMissingLoadEmail(rows) {
  const money = (n) => `$${Number(n || 0).toFixed(2)}`;
  const table = rows.map((row) =>
    `<tr>` +
    `<td style="padding:4px 10px">${escapeHtml(row.container)}</td>` +
    `<td style="padding:4px 10px">${escapeHtml(row.chargeCode)}</td>` +
    `<td style="padding:4px 10px">${escapeHtml(row.vendorName)}</td>` +
    `<td style="padding:4px 10px;text-align:right">${money(row.amount)}</td>` +
    `<td style="padding:4px 10px">${escapeHtml(row.invoiceNumber)}</td>` +
    `</tr>`).join("");
  const html =
    `<h2>TMF / CTF loads to create</h2>` +
    `<p>These container numbers are not on a Primus load yet, so the ` +
    `TMF or CTF charge could not be entered. Please create the load. ` +
    `Jerry checks each morning and will enter the charge once the load ` +
    `exists.</p>` +
    `<table style="border-collapse:collapse;font-size:13px">` +
    `<tr><th style="text-align:left;padding:4px 10px">Container</th>` +
    `<th style="text-align:left;padding:4px 10px">Charge</th>` +
    `<th style="text-align:left;padding:4px 10px">Vendor</th>` +
    `<th style="text-align:right;padding:4px 10px">Amount</th>` +
    `<th style="text-align:left;padding:4px 10px">Bill #</th></tr>` +
    table +
    `</table>`;
  const subject = `Create Primus loads for ${rows.length} TMF / CTF charge` +
    `${rows.length === 1 ? "" : "s"}`;
  return {subject, html};
}

/**
 * Saves charges whose container has no load, and emails Josef and Leo
 * once per charge.
 * @param {Array<object>} summaries Per-invoice summaries.
 * @return {Promise<{fresh: Array<object>}>}
 */
async function rememberMissingLoads(summaries) {
  const col = pendingCollection();
  const fresh = [];
  const now = new Date().toISOString();
  for (const summary of summaries || []) {
    for (const row of summary.skipped || []) {
      if (row.reason !== SKIP_REASON.LOAD_NOT_FOUND) continue;
      const id = pendingDocId(
          summary.invoiceNumber, summary.chargeCode, row.container);
      let notifiedAt = null;
      if (col) {
        const snap = await col.doc(id).get();
        if (snap.exists) notifiedAt = (snap.data() || {}).notifiedAt || null;
        await col.doc(id).set({
          container: row.container,
          amount: row.amount,
          chargeCode: summary.chargeCode,
          description: summary.chargeCode,
          vendorName: summary.vendorName,
          vendorId: summary.vendorId || null,
          invoiceNumber: summary.invoiceNumber,
          invoiceDate: summary.invoiceDate,
          status: "pending",
          updatedAt: now,
          ...(snap.exists ? {} : {createdAt: now}),
        }, {merge: true});
      }
      if (!notifiedAt) {
        fresh.push({
          id,
          container: row.container,
          amount: row.amount,
          chargeCode: summary.chargeCode,
          vendorName: summary.vendorName,
          invoiceNumber: summary.invoiceNumber,
        });
      }
    }
  }
  if (fresh.length && typeof deps.saveOutboundEmail === "function") {
    const email = buildMissingLoadEmail(fresh);
    try {
      await deps.saveOutboundEmail({
        type: "port_fee_missing_load",
        subject: email.subject,
        html: email.html,
        to: MISSING_LOAD_TO,
        cc: portFeeEmailCc(MISSING_LOAD_CC),
        forceRecipient: true,
      });
      if (col) {
        for (const row of fresh) {
          await col.doc(row.id).set({notifiedAt: now}, {merge: true});
        }
      }
    } catch (err) {
      const log = deps.writeLog || (async () => {});
      await log("warn", "port-fee", "Missing-load email failed", {
        error: err && err.message,
        count: fresh.length,
      });
    }
  }
  return {fresh};
}

/**
 * @return {Promise<Array<object>>}
 */
async function listPendingRecords() {
  const col = pendingCollection();
  if (!col) return [];
  const snap = await col.where("status", "==", "pending").get();
  return snap.docs.map((doc) => ({id: doc.id, ...doc.data()}));
}

/**
 * Charges already entered on a waited load, before the vendor cost was closed.
 * @return {Promise<Array<object>>}
 */
async function listPostedNeedingVendorClose() {
  const col = pendingCollection();
  if (!col) return [];
  const snap = await col.where("status", "==", "posted").get();
  return snap.docs
      .map((doc) => ({id: doc.id, ...doc.data()}))
      .filter((row) => !row.vendorCostClosed);
}

/**
 * Each morning: post any waiting port fee whose load now exists.
 * Charges already entered on a waited load are saved again once so the
 * vendor cost is closed and can transfer to QuickBooks.
 * Does not email Josef and Leo again.
 * @return {Promise<object>}
 */
async function retryPendingPortFees() {
  const log = deps.writeLog || (async () => {});
  clearLoadCache();
  if (!deps.isManagePhpEnabled || !deps.isManagePhpEnabled()) {
    return {ok: false, error: "manage.php off"};
  }
  const pending = await listPendingRecords();
  const needsClose = await listPostedNeedingVendorClose();
  let termsId = null;
  if ((pending.length || needsClose.length) &&
      typeof deps.resolveDueOnReceiptTermId === "function") {
    const terms = await deps.resolveDueOnReceiptTermId();
    if (!terms || !terms.ok) {
      return {ok: false, error: (terms && terms.error) || "no terms"};
    }
    termsId = terms.termsId;
  }
  const posted = [];
  const stillMissing = [];
  const waiting = [];
  const col = pendingCollection();
  const now = new Date().toISOString();
  for (const row of pending) {
    const found = await findLoadByContainer(row.container);
    if (!found.ok) {
      stillMissing.push(row.container);
      if (col) {
        await col.doc(row.id).set({lastCheckedAt: now}, {merge: true});
      }
      continue;
    }
    let vendor = row.vendorId ?
      {id: row.vendorId, name: row.vendorName} : null;
    if (!vendor && typeof deps.resolveNamedVendor === "function") {
      vendor = await deps.resolveNamedVendor(row.vendorName);
    }
    const result = await deps.addPortFeeToLoad({
      loadNumber: found.loadNumber,
      booking: found.booking,
      amount: row.amount,
      chargeCode: row.chargeCode,
      description: row.description || row.chargeCode,
      vendor,
      vendorInvoiceNumber: row.invoiceNumber,
      billDate: row.invoiceDate,
      dueDate: row.invoiceDate,
      proNumber: row.container,
      termsId,
      ensureVendorCostClosed: true,
    });
    if (result && result.ok) {
      posted.push({
        container: row.container,
        loadNumber: found.loadNumber,
        chargeCode: row.chargeCode,
        invoiceNumber: row.invoiceNumber,
        already: !!result.skipped,
      });
      if (col) {
        await col.doc(row.id).set({
          status: "posted",
          vendorCostClosed: true,
          loadNumber: found.loadNumber,
          postedAt: now,
          lastCheckedAt: now,
        }, {merge: true});
      }
      continue;
    }
    waiting.push({
      container: row.container,
      loadNumber: found.loadNumber,
      error: result && result.error,
    });
    if (col) {
      await col.doc(row.id).set({
        loadNumber: found.loadNumber,
        lastError: (result && result.error) || "not posted",
        lastCheckedAt: now,
      }, {merge: true});
    }
  }
  const closed = [];
  for (const row of needsClose) {
    const found = await findLoadByContainer(row.container);
    if (!found.ok) {
      if (col) {
        await col.doc(row.id).set({
          lastError: "load not found while closing vendor cost",
          lastCheckedAt: now,
        }, {merge: true});
      }
      continue;
    }
    let vendor = row.vendorId ?
      {id: row.vendorId, name: row.vendorName} : null;
    if (!vendor && typeof deps.resolveNamedVendor === "function") {
      vendor = await deps.resolveNamedVendor(row.vendorName);
    }
    const result = await deps.addPortFeeToLoad({
      loadNumber: found.loadNumber,
      booking: found.booking,
      amount: row.amount,
      chargeCode: row.chargeCode,
      description: row.description || row.chargeCode,
      vendor,
      vendorInvoiceNumber: row.invoiceNumber,
      billDate: row.invoiceDate,
      dueDate: row.invoiceDate,
      proNumber: row.container,
      termsId,
      ensureVendorCostClosed: true,
    });
    if (result && result.ok) {
      closed.push({
        container: row.container,
        loadNumber: found.loadNumber,
        chargeCode: row.chargeCode,
        invoiceNumber: row.invoiceNumber,
      });
      if (col) {
        await col.doc(row.id).set({
          vendorCostClosed: true,
          loadNumber: found.loadNumber,
          lastCheckedAt: now,
        }, {merge: true});
      }
      continue;
    }
    if (col) {
      await col.doc(row.id).set({
        lastError: (result && result.error) || "vendor cost not closed",
        lastCheckedAt: now,
      }, {merge: true});
    }
  }
  await log("info", "port-fee", "Pending port fees checked", {
    pending: pending.length,
    posted: posted.length,
    stillMissing: stillMissing.length,
    waiting: waiting.length,
    closed: closed.length,
  });
  if (posted.length && typeof deps.saveOutboundEmail === "function") {
    const lines = posted.map((row) =>
      `<li>${escapeHtml(row.chargeCode)} ${escapeHtml(row.container)} ` +
      `on load ${escapeHtml(row.loadNumber)} ` +
      `(bill ${escapeHtml(row.invoiceNumber)})</li>`).join("");
    await deps.saveOutboundEmail({
      type: "port_fee_pending_posted",
      subject: `Entered ${posted.length} TMF / CTF charge` +
        `${posted.length === 1 ? "" : "s"} after the load was created`,
      html: `<p>These TMF / CTF charges were waiting for a Primus load. ` +
        `The load is there now, and the charge is entered.</p><ul>` +
        `${lines}</ul>`,
      cc: portFeeEmailCc(),
    });
  }
  return {ok: true, posted, stillMissing, waiting, closed};
}

/**
 * @param {string} container Container number.
 * @return {Promise<object>}
 */
async function findLoadByContainer(container) {
  const key = String(container || "").toUpperCase();
  if (loadCache.has(key)) return loadCache.get(key);
  const found = await lookupLoadByContainer(key);
  loadCache.set(key, found);
  return found;
}

/**
 * @param {string} container Container number.
 * @return {Promise<object>}
 */
async function lookupLoadByContainer(container) {
  const search = deps.searchBookingsForTrackingQuery;
  const fetchBooking = deps.fetchPrimusBooking;
  if (typeof search !== "function") {
    throw new Error("container search is not configured");
  }
  const dateFrom = new Date(Date.now() - 540 * 24 * 60 * 60 * 1000);
  const rows = await search(container, {limit: 25, dateFrom});
  const picked = pickContainerMatch(rows, container);
  if (!picked.ok) return picked;
  let booking = null;
  if (typeof fetchBooking === "function") {
    booking = await fetchBooking(picked.loadNumber);
  }
  if (!booking) {
    return {ok: false, notFound: true};
  }
  return {
    ok: true,
    loadNumber: picked.loadNumber,
    booking,
    source: picked.source,
  };
}

/**
 * @param {Buffer|Uint8Array} buffer PDF bytes.
 * @return {Promise<string>}
 */
async function extractAttachmentText(buffer) {
  if (!buffer) return "";
  const pages = await podUtils.extractPdfPageTexts(buffer);
  if (!pages || !pages.length) return "";
  return pages.map((page) => String(page || "")).join("\n").trim();
}

/**
 * @param {object} att Attachment.
 * @return {boolean}
 */
function isPdfAttachment(att) {
  const name = String(att && att.filename || "");
  const mime = String(att && att.mimeType || "");
  return /\.pdf$/i.test(name) || mime === "application/pdf";
}

/**
 * Reads PDFs and keeps Pier Pass / Port Check bills.
 * A CSV with the same name is ignored. When the message is already known
 * to be one of these invoices, a PDF that does not parse is returned with
 * the piece that was missing.
 * @param {object} opts attachments, downloadAttachment, expectInvoice.
 * @return {Promise<{matches: Array, rejected: Array}>}
 */
async function sniffPdfAttachments(opts) {
  const attachments = (opts && opts.attachments) || [];
  const download = opts && opts.downloadAttachment;
  const expectInvoice = !!(opts && opts.expectInvoice);
  const extractText = (opts && opts.extractText) || extractAttachmentText;
  const matches = [];
  const rejected = [];
  const failures = [];
  if (typeof download !== "function") {
    return {matches, rejected};
  }
  let sawPdf = false;
  for (const att of attachments) {
    if (!att || !isPdfAttachment(att)) continue;
    sawPdf = true;
    const name = String(att.filename || "");
    let text = "";
    try {
      const buffer = await download(att);
      text = buffer ? await extractText(buffer) : "";
    } catch (_) {
      text = "";
    }
    if (!String(text || "").trim()) {
      failures.push({
        filename: name,
        kind: null,
        error: "no text",
        partial: false,
        notInvoice: false,
      });
      continue;
    }
    const parsed = parsePortFeeInvoiceText(text, {filename: name});
    if (parsed.ok) {
      matches.push(parsed.invoice);
      continue;
    }
    failures.push({
      filename: name,
      kind: parsed.kind || null,
      error: parsed.error || "no text",
      partial: !!parsed.partial,
      notInvoice: !!parsed.notInvoice,
    });
  }
  const keep = (row) => {
    if (row.partial) return true;
    if (!expectInvoice) return false;
    if (matches.length && !row.notInvoice && !row.partial) {
      return false;
    }
    return true;
  };
  if (!matches.length && expectInvoice && !sawPdf) {
    rejected.push({
      filename: "port-fee",
      kind: null,
      error: "no PDF invoice was attached",
    });
  }
  for (const row of failures) {
    if (!keep(row)) continue;
    if (matches.length && !row.partial && !row.notInvoice) continue;
    rejected.push({
      filename: row.filename,
      kind: row.kind,
      error: row.error,
    });
  }
  return {matches, rejected};
}

/**
 * Posts parsed invoices and emails a reconciliation.
 * @param {object} opts invoices, rejected, from, subject, gmailMessageId.
 * @return {Promise<object>}
 */
async function processPortFeeEmail(opts) {
  const log = deps.writeLog || (async () => {});
  const invoices = (opts && opts.invoices) || [];
  const rejected = (opts && opts.rejected) || [];
  clearLoadCache();

  if (!opts || opts.dryRun) {
    return {handled: false, reason: "dry run"};
  }
  if (!deps.isManagePhpEnabled || !deps.isManagePhpEnabled()) {
    return {handled: false, reason: "manage.php off"};
  }
  if (typeof deps.addPortFeeToLoad !== "function") {
    return {handled: false, reason: "addPortFeeToLoad not configured"};
  }

  let termsId = null;
  let termsError = null;
  if (typeof deps.resolveDueOnReceiptTermId === "function") {
    try {
      const terms = await deps.resolveDueOnReceiptTermId();
      if (terms && terms.ok) termsId = terms.termsId;
      else termsError = (terms && terms.error) || "Due on receipt not found";
    } catch (err) {
      termsError = err && err.message;
    }
  } else {
    termsError = "terms lookup not configured";
  }

  const summaries = [];
  for (const invoice of invoices) {
    let vendor = null;
    let vendorError = null;
    if (termsId != null && typeof deps.resolveNamedVendor === "function") {
      try {
        vendor = await deps.resolveNamedVendor(invoice.vendorName);
      } catch (err) {
        vendorError = err && err.message;
      }
    }
    const counts = await applyPortFeeLines({
      invoice,
      vendor,
      termsId,
      findLoad: findLoadByContainer,
      postCharge: (charge) => deps.addPortFeeToLoad(charge),
    });
    if (vendorError) {
      for (const row of counts.skipped) {
        if (!row.error) row.error = vendorError;
      }
    }
    const summary = summarizeInvoice(invoice, counts);
    summary.vendorId = vendor && vendor.id || null;
    summaries.push(summary);
    await log("info", "port-fee", "Port fee invoice processed", {
      finalStatus: summary.skippedCount ? "port_fee_partial" :
        "port_fee_processed",
      invoiceNumber: invoice.invoiceNumber,
      chargeCode: invoice.chargeCode,
      vendorName: invoice.vendorName,
      postedCount: summary.postedCount,
      alreadyCount: summary.alreadyCount,
      skippedCount: summary.skippedCount,
      invoiceTotal: invoice.invoiceTotal,
      from: opts.from || null,
      subject: opts.subject || null,
      termsError,
    });
  }

  const missing = await rememberMissingLoads(summaries);
  const email = buildReconciliationEmail(summaries, rejected);
  if (missing.fresh.length) {
    email.html += `<p>Emailed Josef and Leo to create ` +
      `${missing.fresh.length} load(s). Jerry will enter those charges ` +
      `after the loads exist.</p>`;
  }
  if (typeof deps.saveOutboundEmail === "function") {
    await deps.saveOutboundEmail({
      type: "port_fee_reconciliation",
      subject: email.subject,
      html: email.html,
      cc: portFeeEmailCc(),
      gmailMessageId: opts.gmailMessageId || null,
    });
  }

  const postedCount = summaries.reduce((s, r) => s + r.postedCount, 0);
  const alreadyCount = summaries.reduce((s, r) => s + r.alreadyCount, 0);
  const skippedCount = summaries.reduce((s, r) => s + r.skippedCount, 0) +
    rejected.length;
  let finalStatus = "port_fee_processed";
  if (!invoices.length && rejected.length) finalStatus = "port_fee_failed";
  else if (postedCount + alreadyCount === 0) finalStatus = "port_fee_failed";
  else if (skippedCount > 0) finalStatus = "port_fee_partial";

  return {
    handled: true,
    finalStatus,
    postedCount,
    alreadyCount,
    skippedCount,
    summaries,
    termsError,
    missingLoads: missing.fresh,
  };
}

module.exports = {
  init,
  SKIP_REASON,
  CHARGE_PROFILES,
  detectPortFeeKind,
  isPortFeeMessage,
  parsePortFeeInvoiceText,
  parseContainerLines,
  pickContainerMatch,
  skipReasonText,
  applyPortFeeLines,
  summarizeInvoice,
  buildReconciliationEmail,
  sniffPdfAttachments,
  processPortFeeEmail,
  buildMissingLoadEmail,
  pendingDocId,
  rememberMissingLoads,
  retryPendingPortFees,
  MISSING_LOAD_TO,
  MISSING_LOAD_CC,
  PORT_FEE_CC,
  portFeeEmailCc,
};
