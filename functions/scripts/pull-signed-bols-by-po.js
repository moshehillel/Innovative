#!/usr/bin/env node
/**
 * Bulk pull signed BOL/POD (fallback: original BOL) for PO/pickticket list.
 * Writes a zip + summary CSV under deliverables/.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const {URL} = require("url");
const {execFileSync} = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const OUT_DIR = path.join(ROOT, "deliverables", "signed-bols-pull");
const PDF_DIR = path.join(OUT_DIR, "pdfs");
const ZIP_PATH = path.join(
    ROOT, "deliverables", "signed-bols-by-pickticket.zip");

const ROWS = [
  ["P26-0429", "1287994"],
  ["P26-0442", "1288342"],
  ["E26-0656/P26-0523", "1297658"],
  ["7-74711/P26-0429", "1289186"],
  ["E26-0243-P26-0211", "1290249"],
  ["P26-0453", "1291634"],
  ["P26-0425", "1288340"],
  ["P26-0153", "1290218"],
  ["P26-0439", "1288388"],
  ["P26-0320", "1282929"],
  ["35211075/P26-0516", "1298264"],
  ["P26-0484", "1292526"],
  ["P26-0496", "1295459"],
  ["P26-0483", "1292201"],
  ["P26-0388", "1282753"],
  ["P26-0330", "1287817"],
  ["E066098/P26-0515", "1296483"],
  ["P26-0398", "1284748"],
  ["P26-0405", "1291142"],
  ["P26-0341", "1279492"],
  ["P26-0488", "1293528"],
  ["P26-0415", "1291937"],
  ["16288468/P26-0519", "1297663"],
  ["E043180/P26-0392", "1282913"],
  ["P26-0405", "1291141"],
  ["E043180/P26-0392", "1282912"],
  ["P26-0330", "1287818"],
  ["P26-0495", "1296087"],
  ["P26-0335", "1279923"],
  ["P26-0433", "1290878"],
  ["16285329/P26-0423", "1289201"],
  ["P26-0415", "1291935"],
  ["P26-0438", "1289254"],
  ["P26-0422", "1290562"],
  ["P26-0416", "1287250"],
  ["P26-0422", "1290563"],
  ["7-74711/P26-0429", "1289185"],
  ["P26-0464", "1295876"],
  ["P26-0415", "1291934"],
  ["35211075/P26-0516", "1298263"],
  ["P26-0483", "1292197"],
  ["P26-0422", "1290561"],
  ["P26-0451", "1294855"],
  ["P26-0422", "1290560"],
];

const FILETYPE_POD = "0";
const FILETYPE_BOL = "392";
const FILETYPE_CARRIER_BILL = "372";

const envFile = path.join(__dirname, "..", ".env.tai-invoice-automation");
for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 1) continue;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if (
    (v.startsWith("\"") && v.endsWith("\"")) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  if (!process.env[k]) process.env[k] = v;
}
process.env.PRIMUS_USE_MANAGE_PHP = "true";

const admin = require("firebase-admin");
try {
  admin.app();
} catch (_) {
  admin.initializeApp({projectId: "tai-invoice-automation"});
}

const bridge = require("../primus-ui-bridge");
let sessionCookie = null;

bridge.init({
  db: () => ({
    doc: () => ({
      get: async () => ({exists: false, data: () => ({})}),
      set: async (data) => {
        if (data && data.cookie) sessionCookie = data.cookie;
      },
    }),
  }),
  writeLog: async () => {},
});

/**
 * @return {Promise<string>}
 */
async function ensureUiCookie() {
  if (sessionCookie) return sessionCookie;
  await bridge.searchBookingsForTrackingQuery("264442", {limit: 1});
  if (sessionCookie) return sessionCookie;
  const body = new URLSearchParams({
    action: "login",
    logout: "false",
    loginUsername: process.env.PRIMUS_UI_USERNAME || process.env.PRIMUS_USERNAME,
    loginPassword: process.env.PRIMUS_UI_PASSWORD || process.env.PRIMUS_PASSWORD,
    browser: "Chrome",
    browserVersion: "149",
    os: "Windows",
  });
  const resp = await fetch(process.env.PRIMUS_UI_MANAGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body,
  });
  const raw = resp.headers.get("set-cookie") || "";
  let m = raw.match(/PHPSESSID=([^;,\s]+)/i);
  if (m) sessionCookie = m[1];
  const arr = resp.headers.getSetCookie && resp.headers.getSetCookie();
  if (!sessionCookie && Array.isArray(arr)) {
    for (const line of arr) {
      const mm = line.match(/PHPSESSID=([^;,\s]+)/i);
      if (mm) sessionCookie = mm[1];
    }
  }
  if (!sessionCookie) throw new Error("UI login failed");
  return sessionCookie;
}

let cachedRestToken = null;
/**
 * @return {Promise<string>}
 */
async function restToken() {
  if (cachedRestToken) return cachedRestToken;
  const resp = await fetch(`${process.env.PRIMUS_BASE_URL}/login`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      username: process.env.PRIMUS_USERNAME,
      password: process.env.PRIMUS_PASSWORD,
    }),
  });
  const data = await resp.json();
  const token = data && data.data && data.data.accessToken;
  if (!token) throw new Error("REST login failed");
  cachedRestToken = token;
  return token;
}

/**
 * @param {string} url
 * @param {object} [headers]
 * @return {Promise<{status:number, buf:Buffer, ct:string}>}
 */
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "*/*",
        ...headers,
      },
    }, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => {
        resolve({
          status: resp.statusCode,
          buf: Buffer.concat(chunks),
          ct: String(resp.headers["content-type"] || ""),
        });
      });
    });
    req.on("error", reject);
  });
}

/**
 * @param {Buffer} buf
 * @return {boolean}
 */
function isPdf(buf) {
  return Buffer.isBuffer(buf) && buf.length > 20 &&
    buf.slice(0, 4).toString() === "%PDF";
}

/**
 * @param {Buffer} buf
 * @return {boolean}
 */
function looksNetFreeBlocked(buf) {
  const s = buf.slice(0, 400).toString("utf8");
  return /netfree\.link/i.test(s) || /block-favicon/i.test(s);
}

/**
 * @param {object} row
 * @param {string} pickticket
 * @param {string} po
 * @return {boolean}
 */
function rowMatchesRefs(row, pickticket, po) {
  const blob = [
    row.thirdPartyReferenceNumber,
    row.shipperReferenceNumber,
    row.consigneeReferenceNumber,
    row.ShipmentReferenceNumber1,
    row.ShipmentReferenceNumber2,
    row.carrierRef,
  ].map((x) => String(x || "")).join(" | ");
  if (blob.includes(pickticket)) return true;
  // Some rows store pickticket as "PT 1289186"
  if (new RegExp(`\\b${pickticket}\\b`).test(blob)) return true;
  if (po && blob.includes(po)) return true;
  return false;
}

/**
 * @param {string} pickticket
 * @param {string} po
 * @return {Promise<object|null>}
 */
async function findBookingRow(pickticket, po) {
  const byPt = await bridge.searchBookingsForTrackingQuery(pickticket, {
    limit: 25,
  });
  const exact = byPt.find((r) => rowMatchesRefs(r, pickticket, po));
  if (exact) return exact;
  if (byPt.length === 1 && rowMatchesRefs(byPt[0], pickticket, "")) {
    return byPt[0];
  }
  // Fallback: PO search, then require pickticket in refs
  const byPo = await bridge.searchBookingsForTrackingQuery(po, {limit: 25});
  const fromPo = byPo.find((r) => rowMatchesRefs(r, pickticket, po));
  if (fromPo) return fromPo;
  return exact || null;
}

/**
 * @param {string} loadNumber
 * @return {Promise<object|null>}
 */
async function fetchRestDocs(loadNumber) {
  const token = await restToken();
  const resp = await fetch(
      `${process.env.PRIMUS_BASE_URL}/document/bolnumber/` +
      encodeURIComponent(loadNumber),
      {headers: {Authorization: `Bearer ${token}`, Accept: "application/json"}},
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  const results = data && data.data && data.data.results;
  return Array.isArray(results) ? results : null;
}

/**
 * @param {string} url
 * @return {Promise<Buffer|null>}
 */
async function downloadPdfUrl(url) {
  if (!url) return null;
  try {
    const resp = await httpsGet(url);
    if (isPdf(resp.buf)) return resp.buf;
    if (looksNetFreeBlocked(resp.buf)) {
      return null; // caller may try other path
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {string} fileId Google drive file id.
 * @return {Promise<Buffer|null>}
 */
async function downloadDriveFile(fileId) {
  const cookie = await ensureUiCookie();
  const url = `${process.env.PRIMUS_UI_MANAGE_URL}` +
    `?action=downloadDriveFile&fileId=${encodeURIComponent(fileId)}`;
  const resp = await httpsGet(url, {Cookie: `PHPSESSID=${cookie}`});
  if (isPdf(resp.buf)) return resp.buf;
  return null;
}

/**
 * @param {object} docData
 * @return {Array<object>}
 */
function listDriveFiles(docData) {
  const drive = docData && docData.drive;
  return Array.isArray(drive) ? drive : [];
}

/**
 * @param {string} s
 * @return {string}
 */
function safeName(s) {
  return String(s || "")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
}

/**
 * @param {object} args
 * @return {Promise<object>}
 */
async function pullOne({po, pickticket}) {
  const result = {
    po,
    pickticket,
    loadNumber: null,
    bookingId: null,
    source: null,
    status: "pending",
    filename: null,
    bytes: 0,
    error: null,
  };

  let row;
  try {
    row = await findBookingRow(pickticket, po);
  } catch (err) {
    result.status = "error";
    result.error = "search failed: " + err.message;
    return result;
  }
  if (!row || !row.BOL) {
    result.status = "not_found";
    result.error = "No Primus shipment matched pickticket/PO";
    return result;
  }

  result.loadNumber = String(row.BOL);
  result.bookingId = String(row.id || "");

  // Prefer exact ref match quality note
  if (!rowMatchesRefs(row, pickticket, po)) {
    result.error = "weak_match";
  }

  let pdf = null;
  let source = null;

  // 1) REST docs: POD then BOL
  const restDocs = await fetchRestDocs(result.loadNumber);
  if (restDocs) {
    const podDoc = restDocs.find((d) =>
      String(d.type || "").toUpperCase() === "POD");
    const bolDoc = restDocs.find((d) =>
      String(d.type || "").toUpperCase() === "BOL");
    if (podDoc && podDoc.url) {
      pdf = await downloadPdfUrl(podDoc.url);
      if (pdf) source = "signed_pod_rest";
    }
    if (!pdf && bolDoc && bolDoc.url) {
      pdf = await downloadPdfUrl(bolDoc.url);
      if (pdf) {
        source = "original_bol_rest";
      } else {
        // NetFree often blocks original BOL Documents.php — try manage drive
        result.error = (result.error ? result.error + "; " : "") +
          "original_bol_rest_blocked";
      }
    }
  }

  // 2) manage.php drive files
  if (!pdf && result.bookingId) {
    const docs = await bridge.getBookingDocuments({
      bookingId: result.bookingId,
      bookingBOL: result.loadNumber,
    });
    const files = docs.ok ? listDriveFiles(docs.data) : [];
    const podFile = files.find((f) =>
      String(f.type) === FILETYPE_POD ||
      /POD|PROOF OF DELIVERY/i.test(String(f.fileTypeName || "")));
    const bolFile = files.find((f) =>
      String(f.type) === FILETYPE_BOL ||
      /BILL OF LADING/i.test(String(f.fileTypeName || "")));
    // Never pull carrier bill
    const safePod = podFile && String(podFile.type) !== FILETYPE_CARRIER_BILL ?
      podFile : null;
    const safeBol = bolFile && String(bolFile.type) !== FILETYPE_CARRIER_BILL ?
      bolFile : null;

    if (safePod && safePod.fileId) {
      pdf = await downloadDriveFile(String(safePod.fileId));
      if (pdf) source = "signed_pod_drive";
    }
    if (!pdf && safeBol && safeBol.fileId) {
      pdf = await downloadDriveFile(String(safeBol.fileId));
      if (pdf) source = "original_bol_drive";
    }
    if (!pdf && files.length === 0 && !restDocs) {
      result.error = (result.error ? result.error + "; " : "") +
        "no_drive_docs_and_no_rest_docs";
    }
  }

  if (!pdf) {
    result.status = "missing_doc";
    result.error = result.error || "No signed POD or original BOL available";
    return result;
  }

  const kind = source && source.startsWith("signed") ?
    "signed-POD" : "original-BOL";
  const filename = safeName(
      `${pickticket}__${po.replace(/\//g, "-")}__load-${result.loadNumber}` +
      `__${kind}.pdf`,
  );
  fs.writeFileSync(path.join(PDF_DIR, filename), pdf);
  result.status = "ok";
  result.source = source;
  result.filename = filename;
  result.bytes = pdf.length;
  if (result.error === "weak_match") result.error = null;
  return result;
}

/**
 * @param {Array<object>} summary
 * @return {void}
 */
function writeSummary(summary) {
  const lines = [
    "po,pickticket,loadNumber,bookingId,status,source,filename,bytes,error",
  ];
  for (const r of summary) {
    const cols = [
      r.po, r.pickticket, r.loadNumber, r.bookingId, r.status, r.source,
      r.filename, r.bytes, r.error,
    ].map((v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
    });
    lines.push(cols.join(","));
  }
  fs.writeFileSync(path.join(OUT_DIR, "summary.csv"), lines.join("\n"));
  fs.writeFileSync(
      path.join(OUT_DIR, "summary.json"),
      JSON.stringify(summary, null, 2),
  );
}

/**
 * @return {void}
 */
function zipPdfs() {
  if (fs.existsSync(ZIP_PATH)) fs.unlinkSync(ZIP_PATH);
  // Use PowerShell Compress-Archive for Windows
  const ps = [
    "Compress-Archive",
    "-Path",
    `'${PDF_DIR}\\*'`,
    "-DestinationPath",
    `'${ZIP_PATH}'`,
    "-Force",
  ].join(" ");
  execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], {
    stdio: "inherit",
  });
}

async function main() {
  fs.mkdirSync(PDF_DIR, {recursive: true});
  for (const f of fs.readdirSync(PDF_DIR)) {
    fs.unlinkSync(path.join(PDF_DIR, f));
  }

  await ensureUiCookie();
  await restToken();

  const summary = [];
  let i = 0;
  for (const [po, pickticket] of ROWS) {
    i += 1;
    process.stdout.write(`[${i}/${ROWS.length}] ${pickticket} ${po} ... `);
    try {
      const r = await pullOne({po, pickticket});
      summary.push(r);
      console.log(r.status, r.source || "", r.error || "");
    } catch (err) {
      const r = {
        po, pickticket, loadNumber: null, bookingId: null,
        source: null, status: "error", filename: null, bytes: 0,
        error: err.message,
      };
      summary.push(r);
      console.log("error", err.message);
    }
    // gentle pacing for Primus
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  writeSummary(summary);
  const ok = summary.filter((r) => r.status === "ok");
  if (ok.length) zipPdfs();

  console.log("\nDone.");
  console.log("ok:", ok.length);
  console.log("missing:", summary.filter((r) => r.status === "missing_doc").length);
  console.log("not_found:", summary.filter((r) => r.status === "not_found").length);
  console.log("error:", summary.filter((r) => r.status === "error").length);
  console.log("zip:", ok.length ? ZIP_PATH : "(none)");
  console.log("summary:", path.join(OUT_DIR, "summary.csv"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
