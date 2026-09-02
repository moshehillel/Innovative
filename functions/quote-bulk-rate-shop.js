/**
 * Dispatcher bulk Primus rate shop — CSV/XLSX upload → async job → results.
 * Reuses Book4/Book5 Estes Standard rate-shop pattern.
 */

"use strict";

const admin = require("firebase-admin");
const XLSX = require("xlsx");
const rateShop = require("./quote-rate-shop");

const COLLECTION = "bulkRateShopJobs";
const DEFAULT_CHUNK = 3;
const MAX_CHUNK = 8;
const MAX_ROWS = 200;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

let deps = {};

/**
 * @param {object} d tcol, getPrimusToken (optional if rateShop already inited).
 * @return {void}
 */
function init(d) {
  deps = d || {};
  if (deps.getPrimusToken) {
    rateShop.init({getPrimusToken: deps.getPrimusToken});
  }
}

/**
 * @param {object} tenant Tenant.
 * @return {FirebaseFirestore.CollectionReference}
 */
function jobsCol(tenant) {
  return deps.tcol(tenant, COLLECTION);
}

/**
 * Normalize spreadsheet header for alias matching.
 * @param {*} h Raw header.
 * @return {string}
 */
function normHeader(h) {
  return String(h == null ? "" : h)
      .trim()
      .toLowerCase()
      .replace(/[_]+/g, " ")
      .replace(/\s+/g, " ");
}

/**
 * Pick first matching column value from a row.
 * @param {object} row Sheet row.
 * @param {string[]} aliases Header aliases (already normalized).
 * @return {*}
 */
function pickCol(row, aliases) {
  if (!row || typeof row !== "object") return undefined;
  const map = {};
  for (const key of Object.keys(row)) {
    map[normHeader(key)] = row[key];
  }
  for (const a of aliases) {
    if (Object.prototype.hasOwnProperty.call(map, a)) return map[a];
  }
  return undefined;
}

const CITY_ALIASES = ["cnsg city", "city", "dest city", "destination city",
  "consignee city"];
const STATE_ALIASES = ["cnsg state", "state", "st", "dest state",
  "destination state", "consignee state"];
const ZIP_ALIASES = ["cnsg zipcode", "cnsg zip", "zipcode", "zip code", "zip",
  "dest zip", "destination zip", "consignee zip"];
const WEIGHT_ALIASES = ["total weight", "weight", "wgt", "total wgt"];
const PIECES_ALIASES = ["total pieces", "pieces", "pallets", "pallet", "qty",
  "quantity", "handling units"];
const DIMS_ALIASES = ["dims", "dimensions", "dim", "lwh", "size"];

/**
 * Parse LxWxH dims string.
 * @param {*} raw Dims cell.
 * @return {{length:number,width:number,height:number}}
 */
function parseDims(raw) {
  const dims = String(raw == null || raw === "" ? "40x48x60" : raw)
      .toLowerCase()
      .split(/[x×]/)
      .map((n) => Number(String(n).trim()));
  if (dims.length === 3 && dims.every((n) => Number.isFinite(n) && n > 0)) {
    return {length: dims[0], width: dims[1], height: dims[2]};
  }
  return {length: 40, width: 48, height: 60};
}

/**
 * Build freightInfo lines from a normalized destination row.
 * Book5: Total Pieces + Total Weight as one line.
 * Book4: PALLET + WEIGHT (+ optional second weight column).
 * @param {object} row Normalized row {pieces, weight, weight2, dims}.
 * @return {Array<object>}
 */
function freightFromRow(row) {
  const pallets = Number(row.pieces) || 1;
  const w1 = Number(row.weight) || 0;
  const w2 = row.weight2 != null ? Number(row.weight2) : null;
  const {length, width, height} = parseDims(row.dims);
  const lines = [];

  if (pallets >= 2 && Number.isFinite(w2) && w2 > 0) {
    lines.push({
      qty: 1, weight: w1, weightType: "total",
      length, width, height, unitType: "PLT",
    });
    lines.push({
      qty: 1, weight: w2, weightType: "total",
      length, width, height, unitType: "PLT",
    });
    for (let i = 2; i < pallets; i++) {
      lines.push({
        qty: 1, weight: w1, weightType: "total",
        length, width, height, unitType: "PLT",
      });
    }
  } else if (Number.isFinite(w2) && w2 > 0) {
    lines.push({
      qty: pallets, weight: w1 + w2, weightType: "total",
      length, width, height, unitType: "PLT",
    });
  } else {
    lines.push({
      qty: pallets, weight: w1, weightType: "total",
      length, width, height, unitType: "PLT",
    });
  }
  return rateShop.ensureFreightClasses(lines).freightInfo;
}

/**
 * Real Primus quote number (not W000 account ids).
 * Prefers raw Primus rate fields; falls back to normalized row.
 * @param {object} r Rate (raw or normalized).
 * @param {object|null} [rawById] Raw rates by id (optional).
 * @return {string|null}
 */
function realQuoteNumber(r, rawById) {
  const raw = rawById && r && (rawById[r.id] || rawById[r.rateId]);
  const src = raw || r || {};
  const s = String(src.quoteNumber || "").trim();
  if (!s) return null;
  const acct = String(src.accountNumber || "").trim();
  if (acct && s === acct) return null;
  if (/^W000\d+$/i.test(s)) return null;
  return s;
}

/**
 * @param {object} r Rate.
 * @return {boolean}
 */
function isEstesNonVolume(r) {
  const blob = `${r.name || ""} ${r.SCAC || ""} ${r.scac || ""}`;
  if (!/estes|EXLA/i.test(blob)) return false;
  if (/volume/i.test(String(r.name || ""))) return false;
  return true;
}

/**
 * @param {object} r Rate.
 * @return {boolean}
 */
function isGuaranteedRate(r) {
  return r.guaranteed === true ||
    String(r.rateType || "").toUpperCase() === "GUARANTEED";
}

/**
 * Estes Retail Guarantee (ERG) — Book8 pattern.
 * @param {object} r Rate (prefer raw for serviceLevel / quote prefix).
 * @return {boolean}
 */
function isErgRate(r) {
  const lvl = String(r.serviceLevel || "").toLowerCase();
  if (/retail\s*guarantee|\berg\b/.test(lvl)) return true;
  const code = String(r.serviceLevelCode || "").toUpperCase();
  if (code === "ERG" || /RETAIL/.test(code)) return true;
  const q = String(r.quoteNumber || "");
  if (/^R[A-Z0-9]+$/i.test(q) && isGuaranteedRate(r)) return true;
  return false;
}

/**
 * Prefer Estes Express non-volume LTL: standard / guaranteed / ERG.
 * Picks from raw Primus rates when available (quote # + ERG fields).
 * @param {Array<object>} rates Normalized rates.
 * @param {object} rawById Raw by id.
 * @param {object} opts includeGuaranteed.
 * @return {{standard:object|null,guaranteed:object|null,erg:object|null}}
 */
function pickEstesStandard(rates, rawById, opts = {}) {
  const rawList = rawById && typeof rawById === "object" ?
    Object.values(rawById).filter(Boolean) : [];
  const pool = rawList.length ? rawList : (rates || []);
  const estes = pool.filter(isEstesNonVolume);
  const isExpress = (r) => /express/i.test(String(r.name || ""));
  const byTotal = (a, b) => Number(a.total) - Number(b.total);
  const annotate = (r) => {
    if (!r) return null;
    r._quote = realQuoteNumber(r, rawById);
    return r;
  };

  const stdPool = estes.filter((r) => !isGuaranteedRate(r));
  const stdExpress = stdPool.filter(isExpress);
  const std = annotate(
      (stdExpress.length ? stdExpress : stdPool).sort(byTotal)[0] || null,
  );

  let gtd = null;
  let erg = null;
  if (opts.includeGuaranteed) {
    const gtdPool = estes.filter((r) => isGuaranteedRate(r) && !isErgRate(r));
    const gtdExpress = gtdPool.filter(isExpress);
    gtd = (gtdExpress.length ? gtdExpress : gtdPool).sort(byTotal)[0] || null;
    // Prefer a guaranteed row that has a real quote # when possible
    if (gtd && !realQuoteNumber(gtd, rawById) && gtdExpress.length) {
      gtd = gtdExpress.map((r) => {
        r._quote = realQuoteNumber(r, rawById);
        return r;
      }).filter((r) => r._quote).sort(byTotal)[0] || gtd;
    }
    gtd = annotate(gtd);

    const ergPool = estes.filter(isErgRate);
    const ergExpress = ergPool.filter(isExpress);
    erg = annotate(
        (ergExpress.length ? ergExpress : ergPool).sort(byTotal)[0] || null,
    );
  }

  return {standard: std, guaranteed: gtd, erg};
}

/**
 * Parse uploaded workbook/CSV buffer into normalized destination rows.
 * @param {Buffer} buffer File bytes.
 * @param {string} [fileName] Original name (hint).
 * @return {{rows: Array<object>, headers: string[], sheetName: string}}
 */
function parseSpreadsheet(buffer, fileName) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error("Empty file");
  }
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error("File too large (max 4 MB)");
  }
  const wb = XLSX.read(buffer, {type: "buffer", cellDates: false});
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("Workbook has no sheets");
  const sheet = wb.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, {defval: null});
  if (!rawRows.length) throw new Error("No data rows found");
  if (rawRows.length > MAX_ROWS) {
    throw new Error(`Too many rows (max ${MAX_ROWS})`);
  }

  const headers = Object.keys(rawRows[0] || {});
  const headerNorm = headers.map((h) => ({raw: h, norm: normHeader(h)}));
  // Book4 duplicate WEIGHT → WEIGHT_1 / __EMPTY from sheet_to_json
  const weight2Header = headerNorm.find((h) => {
    if (h.norm === "weight 1" || h.norm === "weight 2" ||
        h.norm === "weight_1" || h.norm === "weight_2") {
      return true;
    }
    return /^__empty/.test(h.norm);
  });

  const rows = [];
  for (let i = 0; i < rawRows.length; i++) {
    const raw = rawRows[i];
    const city = String(pickCol(raw, CITY_ALIASES) || "").trim();
    const state = String(pickCol(raw, STATE_ALIASES) || "").trim().toUpperCase();
    let zip = String(pickCol(raw, ZIP_ALIASES) || "").trim();
    zip = zip.replace(/\.0$/, "");
    if (/^\d+$/.test(zip) && zip.length < 5) zip = zip.padStart(5, "0");
    const weight = pickCol(raw, WEIGHT_ALIASES);
    const pieces = pickCol(raw, PIECES_ALIASES);
    const dims = pickCol(raw, DIMS_ALIASES);
    let weight2 = null;
    if (weight2Header) {
      const w2raw = raw[weight2Header.raw];
      if (w2raw != null && w2raw !== "") {
        const n = Number(w2raw);
        if (Number.isFinite(n) && n > 0) weight2 = n;
      }
    }
    if (!city && !state && !zip && (weight == null || weight === "")) {
      continue; // skip blank trailing rows
    }
    rows.push({
      i: rows.length + 1,
      city,
      state,
      zip,
      weight: weight != null && weight !== "" ? Number(weight) : null,
      weight2,
      pieces: pieces != null && pieces !== "" ? Number(pieces) : 1,
      dims: dims != null && dims !== "" ? String(dims) : "40x48x60",
      status: "pending",
      estesStandard: null,
      standardQuote: null,
      standardName: null,
      estesGuaranteed: null,
      guaranteedQuote: null,
      estesErg: null,
      ergQuote: null,
      error: null,
    });
  }
  if (!rows.length) {
    throw new Error(
        "No usable destination rows. Need city, state, zip, weight columns.");
  }
  const missing = rows.filter((r) => !r.city || !r.state || !r.zip ||
    !Number.isFinite(r.weight) || r.weight <= 0);
  if (missing.length === rows.length) {
    throw new Error(
        "Could not map columns. Expected CNSG City / State / Zipcode, " +
        "Total Weight, Total Pieces, dims (or city/state/zip/weight aliases).");
  }
  return {rows, headers, sheetName, fileName: fileName || null};
}

/**
 * @param {object} origin Origin address from UI.
 * @return {object}
 */
function normalizeOrigin(origin) {
  const o = origin || {};
  const city = String(o.city || "").trim();
  const state = String(o.state || "").trim().toUpperCase();
  let zip = String(o.zip || o.zipCode || o.zipcode || "").trim();
  zip = zip.replace(/\.0$/, "");
  if (/^\d+$/.test(zip) && zip.length < 5) zip = zip.padStart(5, "0");
  const street = String(o.street || o.address || "").trim();
  if (!city || !state || !zip) {
    throw new Error("From address requires city, state, and zip");
  }
  const out = {city, state, zipCode: zip, country: "US"};
  if (street) out.street = street;
  return out;
}

/**
 * @param {Array<*>} list Accessorial codes.
 * @return {string[]}
 */
function normalizeAccessorials(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const code = typeof item === "string" ? item :
      (item && (item.code || item.id));
    const c = String(code || "").trim().toUpperCase();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

/**
 * Create a Firestore bulk rate job from an uploaded file.
 * @param {object} tenant Tenant.
 * @param {object} opts User + file + origin options.
 * @return {Promise<object>}
 */
async function createJob(tenant, opts) {
  const origin = normalizeOrigin(opts.origin);
  const accessorials = normalizeAccessorials(opts.accessorials);
  const customerId = String(opts.customerId || opts.shippingLocationId || "")
      .trim() || null;
  const estesStandardOnly = opts.estesStandardOnly !== false;
  const includeGuaranteed = !!opts.includeGuaranteed;
  const fileName = String(opts.fileName || "upload.xlsx");
  let buffer = opts.buffer;
  if (!buffer && opts.fileBase64) {
    const b64 = String(opts.fileBase64).replace(/^data:[^;]+;base64,/, "");
    buffer = Buffer.from(b64, "base64");
  }
  const parsed = parseSpreadsheet(buffer, fileName);

  const ref = jobsCol(tenant).doc();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const doc = {
    status: "queued",
    createdAt: now,
    updatedAt: now,
    createdByDispatcherId: opts.dispatcherId || null,
    createdByEmail: opts.email || null,
    fileName,
    sheetName: parsed.sheetName,
    headers: parsed.headers,
    origin,
    accessorials,
    customerId,
    options: {
      estesStandardOnly,
      includeGuaranteed,
      carrierCostOnly: true,
    },
    totalRows: parsed.rows.length,
    processedRows: 0,
    successRows: 0,
    errorRows: 0,
    nextIndex: 0,
    rows: parsed.rows,
  };
  await ref.set(doc);
  return {
    ok: true,
    jobId: ref.id,
    totalRows: parsed.rows.length,
    status: "queued",
    origin,
    accessorials,
    customerId,
  };
}

/**
 * Rate one destination row against Primus.
 * @param {object} job Job doc.
 * @param {object} row Row.
 * @return {Promise<object>} Updated row fields.
 */
async function rateOneRow(job, row) {
  const origin = job.origin || {};
  const freightInfo = freightFromRow(row);
  const query = rateShop.buildRateMultipleQuery({
    shipper: {
      city: origin.city,
      state: origin.state,
      zipCode: origin.zipCode || origin.zip,
      country: origin.country || "US",
    },
    consignee: {
      city: row.city,
      state: row.state,
      zipCode: row.zip,
      country: "US",
    },
    freightInfo,
    accessorials: job.accessorials || [],
  }, {
    customerId: job.customerId || undefined,
    UOM: "US",
    includeGuaranteed: !!(job.options && job.options.includeGuaranteed),
    timeout: 90,
  });

  const result = await rateShop.fetchMultipleRates(query);
  const rawRates = (result.raw && result.raw.data && result.raw.data.results &&
    result.raw.data.results.rates) || [];
  const rawById = {};
  for (const rr of rawRates) {
    if (rr && rr.id) rawById[rr.id] = rr;
  }
  const picked = pickEstesStandard(result.rates || [], rawById, {
    includeGuaranteed: !!(job.options && job.options.includeGuaranteed),
  });
  const std = picked.standard;
  const gtd = picked.guaranteed;
  const erg = picked.erg;
  const stdCost = std && Number.isFinite(Number(std.total)) ?
    Number(std.total) : null;
  const gtdCost = gtd && Number.isFinite(Number(gtd.total)) ?
    Number(gtd.total) : null;
  const ergCost = erg && Number.isFinite(Number(erg.total)) ?
    Number(erg.total) : null;

  return {
    status: stdCost != null ? "done" : "no_rate",
    estesStandard: stdCost,
    // Always persist quote # beside cost (Book4/Book5/Book8 pattern)
    standardQuote: (std && std._quote) || realQuoteNumber(std, rawById) || null,
    standardName: (std && std.name) || null,
    estesGuaranteed: gtdCost,
    guaranteedQuote: (gtd && gtd._quote) || realQuoteNumber(gtd, rawById) ||
      null,
    estesErg: ergCost,
    ergQuote: (erg && erg._quote) || realQuoteNumber(erg, rawById) || null,
    rateCount: (result.rates || []).length,
    error: stdCost == null ? "No Estes Standard rate" : null,
  };
}

/**
 * Process the next chunk of pending rows for a job.
 * @param {object} tenant Tenant.
 * @param {string} jobId Job id.
 * @param {object} [opts] maxRows, dispatcherId (owner check).
 * @return {Promise<object>}
 */
async function processJobChunk(tenant, jobId, opts = {}) {
  const id = String(jobId || "").trim();
  if (!id) throw new Error("jobId required");
  const ref = jobsCol(tenant).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Job not found");
  const job = snap.data() || {};
  if (opts.dispatcherId && job.createdByDispatcherId &&
      job.createdByDispatcherId !== opts.dispatcherId) {
    const err = new Error("Not your job");
    err.status = 403;
    throw err;
  }
  if (job.status === "completed" || job.status === "failed") {
    return summarizeJob(id, job);
  }

  let maxRows = Number(opts.maxRows);
  if (!Number.isFinite(maxRows) || maxRows < 1) maxRows = DEFAULT_CHUNK;
  maxRows = Math.min(MAX_CHUNK, Math.floor(maxRows));

  const rows = Array.isArray(job.rows) ? job.rows.slice() : [];
  let nextIndex = Number(job.nextIndex) || 0;
  if (nextIndex < 0) nextIndex = 0;

  await ref.update({
    status: "processing",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  let processed = 0;
  const deadline = Date.now() + (opts.timeBudgetMs || 480000);

  while (processed < maxRows && nextIndex < rows.length) {
    if (Date.now() > deadline) break;
    const row = rows[nextIndex];
    if (!row) {
      nextIndex += 1;
      continue;
    }
    if (row.status === "done" || row.status === "no_rate" ||
        row.status === "error" ||
        (row.estesStandard != null && row.status !== "pending")) {
      // Already completed (resume) — advance cursor
      nextIndex += 1;
      continue;
    }
    if (!row.city || !row.state || !row.zip ||
        !Number.isFinite(Number(row.weight)) || Number(row.weight) <= 0) {
      row.status = "error";
      row.error = "Missing city/state/zip/weight";
      nextIndex += 1;
      processed += 1;
    } else {
      try {
        const rated = await rateOneRow(job, row);
        Object.assign(row, rated);
      } catch (err) {
        row.status = "error";
        row.error = String(err && err.message || err);
      }
      nextIndex += 1;
      processed += 1;
    }

    // Checkpoint after each rated/errored row (Book5 script pattern)
    const successRows = rows.filter((r) =>
      r && r.estesStandard != null && Number.isFinite(Number(r.estesStandard)),
    ).length;
    const errorRows = rows.filter((r) =>
      r && (r.status === "error" || r.status === "no_rate"),
    ).length;
    await ref.update({
      rows,
      nextIndex,
      processedRows: nextIndex,
      successRows,
      errorRows,
      status: nextIndex >= rows.length ? "completed" : "processing",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(nextIndex >= rows.length ?
        {completedAt: admin.firestore.FieldValue.serverTimestamp()} : {}),
    });
  }

  // If we only skipped already-done rows, still advance checkpoint
  if (processed === 0 && nextIndex > (Number(job.nextIndex) || 0)) {
    const successRows = rows.filter((r) =>
      r && r.estesStandard != null && Number.isFinite(Number(r.estesStandard)),
    ).length;
    const errorRows = rows.filter((r) =>
      r && (r.status === "error" || r.status === "no_rate"),
    ).length;
    await ref.update({
      nextIndex,
      processedRows: nextIndex,
      successRows,
      errorRows,
      status: nextIndex >= rows.length ? "completed" : "processing",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(nextIndex >= rows.length ?
        {completedAt: admin.firestore.FieldValue.serverTimestamp()} : {}),
    });
  }

  const fresh = (await ref.get()).data() || {};
  return summarizeJob(id, fresh);
}

/**
 * @param {string} jobId Id.
 * @param {object} job Doc.
 * @return {object}
 */
function summarizeJob(jobId, job) {
  const rows = Array.isArray(job.rows) ? job.rows : [];
  const total = Number(job.totalRows) || rows.length;
  const processed = Number(job.processedRows) || 0;
  const done = job.status === "completed" || processed >= total;
  return {
    ok: true,
    jobId,
    status: done && job.status !== "failed" ? "completed" : (job.status || ""),
    totalRows: total,
    processedRows: processed,
    successRows: Number(job.successRows) || 0,
    errorRows: Number(job.errorRows) || 0,
    nextIndex: Number(job.nextIndex) || 0,
    remaining: Math.max(0, total - processed),
    origin: job.origin || null,
    accessorials: job.accessorials || [],
    customerId: job.customerId || null,
    options: job.options || {},
    fileName: job.fileName || null,
    sample: rows.slice(0, 5).map(publicRow),
    results: done ? rows.map(publicRow) : undefined,
  };
}

/**
 * @param {object} row Row.
 * @return {object}
 */
function publicRow(row) {
  const r = row || {};
  return {
    i: r.i,
    city: r.city,
    state: r.state,
    zip: r.zip,
    weight: r.weight,
    weight2: r.weight2 != null ? r.weight2 : null,
    pieces: r.pieces,
    dims: r.dims,
    status: r.status,
    estesStandard: r.estesStandard,
    standardQuote: r.standardQuote || null,
    standardName: r.standardName,
    estesGuaranteed: r.estesGuaranteed,
    guaranteedQuote: r.guaranteedQuote || null,
    estesErg: r.estesErg != null ? r.estesErg : null,
    ergQuote: r.ergQuote || null,
    error: r.error || null,
  };
}

/**
 * Load job summary (owner-scoped).
 * @param {object} tenant Tenant.
 * @param {string} jobId Job id.
 * @param {object} [opts] dispatcherId.
 * @return {Promise<object>}
 */
async function getJob(tenant, jobId, opts = {}) {
  const id = String(jobId || "").trim();
  if (!id) throw new Error("jobId required");
  const snap = await jobsCol(tenant).doc(id).get();
  if (!snap.exists) {
    const err = new Error("Job not found");
    err.status = 404;
    throw err;
  }
  const job = snap.data() || {};
  if (opts.dispatcherId && job.createdByDispatcherId &&
      job.createdByDispatcherId !== opts.dispatcherId) {
    const err = new Error("Not your job");
    err.status = 403;
    throw err;
  }
  return summarizeJob(id, job);
}

/**
 * Build results workbook or CSV buffer.
 * @param {object} tenant Tenant.
 * @param {string} jobId Job id.
 * @param {object} [opts] format csv|xlsx, dispatcherId.
 * @return {Promise<{buffer: Buffer, contentType: string, fileName: string}>}
 */
async function buildResultsDownload(tenant, jobId, opts = {}) {
  const id = String(jobId || "").trim();
  const snap = await jobsCol(tenant).doc(id).get();
  if (!snap.exists) {
    const err = new Error("Job not found");
    err.status = 404;
    throw err;
  }
  const job = snap.data() || {};
  if (opts.dispatcherId && job.createdByDispatcherId &&
      job.createdByDispatcherId !== opts.dispatcherId) {
    const err = new Error("Not your job");
    err.status = 403;
    throw err;
  }
  const includeGtd = !!(job.options && job.options.includeGuaranteed);
  // Always pair every cost column with its quote # (Book8 sheet pattern)
  const header = [
    "CNSG City", "CNSG State", "CNSG Zipcode",
    "Total Weight", "Total Pieces", "dims",
    "estes standard", "estes standard quote",
  ];
  if (includeGtd) {
    header.push(
        "estes guaranteed", "estes guaranteed quote",
        "estes erg", "estes erg quote",
    );
  }
  header.push("status", "error");

  const aoa = [header];
  for (const row of job.rows || []) {
    const line = [
      row.city,
      row.state,
      row.zip,
      row.weight,
      row.pieces,
      row.dims,
      row.estesStandard != null ? row.estesStandard : "",
      row.standardQuote != null ? row.standardQuote : "",
    ];
    if (includeGtd) {
      line.push(
          row.estesGuaranteed != null ? row.estesGuaranteed : "",
          row.guaranteedQuote != null ? row.guaranteedQuote : "",
          row.estesErg != null ? row.estesErg : "",
          row.ergQuote != null ? row.ergQuote : "",
      );
    }
    line.push(row.status || "", row.error || "");
    aoa.push(line);
  }

  const format = String(opts.format || "xlsx").toLowerCase();
  const base = String(job.fileName || "bulk-rates")
      .replace(/\.(xlsx|xls|csv)$/i, "");
  if (format === "csv") {
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    const csv = XLSX.utils.sheet_to_csv(sheet);
    return {
      buffer: Buffer.from(csv, "utf8"),
      contentType: "text/csv; charset=utf-8",
      fileName: `${base}-results.csv`,
    };
  }
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, sheet, "Results");
  const buffer = XLSX.write(wb, {type: "buffer", bookType: "xlsx"});
  return {
    buffer,
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    fileName: `${base}-results.xlsx`,
  };
}

module.exports = {
  init,
  parseSpreadsheet,
  normalizeOrigin,
  normalizeAccessorials,
  createJob,
  processJobChunk,
  getJob,
  buildResultsDownload,
  pickEstesStandard,
  realQuoteNumber,
  isErgRate,
  freightFromRow,
  COLLECTION,
  MAX_ROWS,
};
