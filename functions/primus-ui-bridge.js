/**
 * Primus trunk UI bridge — interim manage.php layer until official REST
 * endpoints ship for "Generate invoice" and "Save carrier bill".
 *
 * Auth: PHPSESSID cookie from POST manage.php action=login (not Bearer token).
 * One session covers many manage.php calls until expiry.
 *
 * Env:
 *   PRIMUS_USE_MANAGE_PHP=true          — enable UI bridge in workflow
 *   PRIMUS_UI_MANAGE_URL — default shipprimus.com/PRIMUS/trunk/manage.php
 *   PRIMUS_UI_USERNAME / PRIMUS_UI_PASSWORD — UI login (falls back to PRIMUS_*)
 *   PRIMUS_UI_GENERATE_ACTION — set after DevTools capture
 *   PRIMUS_UI_SAVE_CARRIER_BILL_ACTION — optional, for actual costs step
 *   PRIMUS_UI_FILETYPE_CARRIER_BILL — override Carrier Bill type id
 *   PRIMUS_UI_FILETYPE_POD — override POD type id
 *   PRIMUS_UI_CARRIER_BILL_TYPE_NAME — match name in getFileTypes (default
 *     "carrier bill"); customer must NOT see this type in portal
 *   PRIMUS_UI_POD_TYPE_NAME — match name in getFileTypes (default "pod")
 *   PRIMUS_UI_UPLOAD_FILE_FIELD — multipart file field name (default file)
 *   PRIMUS_UI_SESSION_TTL_HOURS — PHPSESSID cache lifetime (default 24)
 *   PRIMUS_UI_SESSION_RENEW_BEFORE_HOURS — renew when this many hours remain
 *   PRIMUS_UI_EMAIL_FROM — sender for emailBOLDocs (default accounting@…)
 *   PRIMUS_UI_EMAIL_DOCS_BODY — HTML body for emailBOLDocs
 */

"use strict";

const admin = require("firebase-admin");

const SESSION_DOC = "system/primusUiSession";
const DEFAULT_SESSION_TTL_HOURS = 24;
const DEFAULT_RENEW_BEFORE_HOURS = 2;

let db;
let writeLog;

/**
 * @param {object} bundle { db, writeLog }
 * @return {void}
 */
function init(bundle) {
  ({db, writeLog} = bundle);
}
exports.init = init;

/**
 * @return {FirebaseFirestore.Firestore}
 */
function firestore() {
  return db ? db() : admin.firestore();
}

/**
 * @return {string}
 */
function manageUrl() {
  return process.env.PRIMUS_UI_MANAGE_URL ||
    "https://shipprimus.com/PRIMUS/trunk/manage.php";
}

/**
 * @return {{username: string, password: string}|null}
 */
function uiCredentials() {
  const username = process.env.PRIMUS_UI_USERNAME ||
    process.env.PRIMUS_USERNAME || "";
  const password = process.env.PRIMUS_UI_PASSWORD ||
    process.env.PRIMUS_PASSWORD || "";
  if (!username || !password) return null;
  return {username, password};
}

/**
 * @param {string} setCookieHeader Raw Set-Cookie header value(s).
 * @return {string|null} PHPSESSID value.
 */
function parsePhpSessId(setCookieHeader) {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(/PHPSESSID=([^;,\s]+)/i);
  return match ? match[1] : null;
}

/**
 * @param {Response} resp Fetch response from login.
 * @return {string|null}
 */
function extractSessionFromResponse(resp) {
  const raw = resp.headers.get("set-cookie");
  if (raw) {
    const id = parsePhpSessId(raw);
    if (id) return id;
  }
  // Some PHP stacks emit multiple Set-Cookie lines; Node fetch may join them.
  const getSetCookie = resp.headers.getSetCookie && resp.headers.getSetCookie();
  if (Array.isArray(getSetCookie)) {
    for (const line of getSetCookie) {
      const id = parsePhpSessId(line);
      if (id) return id;
    }
  }
  return null;
}

/**
 * @return {number} Session cache TTL in ms (Primus cookie ~24h).
 */
function sessionTtlMs() {
  const raw = process.env.PRIMUS_UI_SESSION_TTL_HOURS;
  const hours = raw != null && raw !== "" ?
    Number(raw) : DEFAULT_SESSION_TTL_HOURS;
  const safe = Number.isFinite(hours) && hours > 0 ?
    hours : DEFAULT_SESSION_TTL_HOURS;
  return safe * 60 * 60 * 1000;
}

/**
 * Renew cached session when remaining lifetime is at or below this threshold.
 * @return {number}
 */
function sessionRenewBeforeMs() {
  const raw = process.env.PRIMUS_UI_SESSION_RENEW_BEFORE_HOURS;
  const hours = raw != null && raw !== "" ?
    Number(raw) : DEFAULT_RENEW_BEFORE_HOURS;
  const safe = Number.isFinite(hours) && hours >= 0 ?
    hours : DEFAULT_RENEW_BEFORE_HOURS;
  return safe * 60 * 60 * 1000;
}

/**
 * @return {Promise<{cookie: string, expiresAt: number}|null>}
 */
async function loadCachedSession() {
  const snap = await firestore().doc(SESSION_DOC).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  if (!data.cookie || !data.expiresAt) return null;
  if (Date.now() >= Number(data.expiresAt)) return null;
  return {cookie: data.cookie, expiresAt: Number(data.expiresAt)};
}

/**
 * @param {string} cookie PHPSESSID value.
 * @return {Promise<void>}
 */
async function saveSession(cookie) {
  const expiresAt = Date.now() + sessionTtlMs();
  await firestore().doc(SESSION_DOC).set({
    cookie,
    expiresAt,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
}

/**
 * Logs into Primus trunk UI and returns PHPSESSID.
 * @return {Promise<string>}
 */
async function loginUi() {
  const creds = uiCredentials();
  if (!creds) {
    throw new Error("Primus UI credentials not configured");
  }

  const body = new URLSearchParams({
    action: "login",
    logout: "false",
    loginUsername: creds.username,
    loginPassword: creds.password,
    browser: "Chrome",
    browserVersion: "149",
    os: "Windows",
  });

  const resp = await fetch(manageUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "*/*",
      "Origin": "https://shipprimus.com",
      "Referer": "https://shipprimus.com/v2/",
    },
    body: body.toString(),
    redirect: "manual",
  });

  const cookie = extractSessionFromResponse(resp);
  if (!cookie) {
    const text = await resp.text().catch(() => "");
    throw new Error(
        `Primus UI login did not return PHPSESSID (HTTP ${resp.status})` +
        (text ? `: ${text.slice(0, 200)}` : ""),
    );
  }

  await saveSession(cookie);
  if (writeLog) {
    await writeLog("info", "primus", "Primus UI session established", {
      expiresInHours: sessionTtlMs() / (60 * 60 * 1000),
    });
  }
  return cookie;
}

/**
 * Forces a fresh UI login and updates Firestore session cache.
 * @return {Promise<object>}
 */
async function renewUiSession() {
  if (!isManagePhpEnabled()) {
    return {ok: true, skipped: true, reason: "PRIMUS_USE_MANAGE_PHP off"};
  }
  try {
    await loginUi();
    return {ok: true, renewed: true, expiresInHours: sessionTtlMs() / 3600000};
  } catch (err) {
    if (writeLog) {
      await writeLog("error", "primus", "Primus UI session renewal failed", {
        error: err.message,
      });
    }
    return {ok: false, error: err.message};
  }
}
exports.renewUiSession = renewUiSession;

/**
 * @return {Promise<string>} PHPSESSID cookie value.
 */
async function getUiSessionCookie() {
  const cached = await loadCachedSession();
  const renewBefore = sessionRenewBeforeMs();
  if (cached) {
    const msLeft = cached.expiresAt - Date.now();
    if (msLeft > renewBefore) {
      return cached.cookie;
    }
    if (writeLog) {
      await writeLog("info", "primus",
          "Primus UI session renewing before expiry", {
            msLeft,
            renewBeforeHours: renewBefore / (60 * 60 * 1000),
          });
    }
  }
  return loginUi();
}

/**
 * POST manage.php with session cookie.
 * @param {object} params Form fields including action.
 * @param {boolean} [retryOnAuthFail=true] Re-login once on auth failure.
 * @return {Promise<object>} ok, status, text, json fields.
 */
async function managePhpPost(params, retryOnAuthFail = true) {
  let cookie = await getUiSessionCookie();
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    const encoded = typeof value === "object" ?
      JSON.stringify(value) : String(value);
    form.set(key, encoded);
  }

  const doPost = async (sessionCookie) => {
    const resp = await fetch(manageUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "*/*",
        "Cookie": `PHPSESSID=${sessionCookie}`,
        "Origin": "https://shipprimus.com",
        "Referer": "https://shipprimus.com/PRIMUS/trunk/",
      },
      body: form.toString(),
    });
    const text = await resp.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      // HTML or empty — caller inspects text.
    }
    return {ok: resp.ok, status: resp.status, text, json};
  };

  let result = await doPost(cookie);
  const looksLikeAuthFailure =
    result.status === 401 ||
    result.status === 403 ||
    /session expired|not logged|login/i.test(result.text || "");

  if (looksLikeAuthFailure && retryOnAuthFail) {
    cookie = await loginUi();
    result = await doPost(cookie);
  }

  return result;
}

/**
 * Multipart POST manage.php (uploadDriveFile).
 * @param {object} fields Form fields excluding the binary file.
 * @param {Buffer} fileBuffer PDF bytes.
 * @param {string} fileName Attachment filename.
 * @param {boolean} [retryOnAuthFail=true] Re-login once on auth failure.
 * @return {Promise<object>} ok, status, text, json fields.
 */
async function managePhpUpload(
    fields, fileBuffer, fileName, retryOnAuthFail = true,
) {
  let cookie = await getUiSessionCookie();
  const fileField = process.env.PRIMUS_UI_UPLOAD_FILE_FIELD || "file";

  const doUpload = async (sessionCookie) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value == null) continue;
      form.append(key, String(value));
    }
    const blob = new Blob([fileBuffer], {type: "application/pdf"});
    form.append(fileField, blob, fileName || "document.pdf");

    const resp = await fetch(manageUrl(), {
      method: "POST",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "*/*",
        "Cookie": `PHPSESSID=${sessionCookie}`,
        "Origin": "https://shipprimus.com",
        "Referer": "https://shipprimus.com/PRIMUS/trunk/",
      },
      body: form,
    });
    const text = await resp.text();
    const json = parseManagePhpJson(text);
    return {ok: resp.ok, status: resp.status, text, json};
  };

  let result = await doUpload(cookie);
  const looksLikeAuthFailure =
    result.status === 401 ||
    result.status === 403 ||
    /session expired|not logged|login/i.test(result.text || "");

  if (looksLikeAuthFailure && retryOnAuthFail) {
    cookie = await loginUi();
    result = await doUpload(cookie);
  }

  return result;
}

/**
 * Parses manage.php body — JSON or JSON embedded in HTML.
 * @param {string} text Response body.
 * @return {object|null}
 */
function parseManagePhpJson(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (_2) {
        return null;
      }
    }
  }
  return null;
}

/**
 * @param {object|null} json Parsed upload response.
 * @param {string} [text] Raw response body.
 * @return {boolean}
 */
function isUploadSuccess(json, text) {
  if (json && typeof json === "object") {
    if (json.error) return false;
    if (json.fileId) return true;
    const msg = String(json.message || "");
    if (/uploaded correctly/i.test(msg)) return true;
    const flags = [json.success, json.successUpload, json.successFile];
    if (flags.some((f) => f === true || f === "true")) return true;
  }
  const raw = String(text || "");
  return /uploaded correctly/i.test(raw) && /"fileId"\s*:/.test(raw);
}

/**
 * @param {object} json getFileTypes response.
 * @return {Array<object>}
 */
function parseFileTypesFromResponse(json) {
  if (!json || typeof json !== "object") return [];
  if (Array.isArray(json.fileTypes)) return json.fileTypes;
  const candidates = [json.data, json.results];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

/**
 * @param {Array<object>} types File type rows.
 * @param {string} code Type code (e.g. OB, POD).
 * @return {{id: string, name: string, external: string}|null}
 */
function matchFileTypeByCode(types, code) {
  const want = String(code).toUpperCase();
  for (const t of types) {
    const tCode = String(t.code || "").trim().toUpperCase();
    if (tCode !== want) continue;
    const id = t.id != null ? t.id :
      (t.fileTypeId != null ? t.fileTypeId : t.type);
    if (id == null) continue;
    return {
      id: String(id),
      name: String(t.name || tCode),
      external: String(t.external != null ? t.external : ""),
    };
  }
  return null;
}

/**
 * @param {Array<object>} types File type rows from getFileTypes.
 * @param {Array<string>} patterns Case-insensitive name substrings.
 * @return {{id: string, name: string, external: string}|null}
 */
function matchFileTypeByName(types, patterns) {
  const pats = [...patterns]
      .map((p) => p.toLowerCase())
      .sort((a, b) => b.length - a.length);
  for (const pat of pats) {
    for (const t of types) {
      const name = String(
          t.name || t.description || t.typeName || t.fileTypeName || "",
      ).trim();
      const id = t.id != null ? t.id :
        (t.fileTypeId != null ? t.fileTypeId : t.type);
      if (id == null || !name) continue;
      const lower = name.toLowerCase();
      if (lower === pat || lower.includes(pat)) {
        return {
          id: String(id),
          name,
          external: String(t.external != null ? t.external : ""),
        };
      }
    }
  }
  return null;
}

let cachedFileTypes = null;
let cachedFileTypesAt = 0;

/**
 * @return {Promise<Array<object>>}
 */
async function fetchUiFileTypes() {
  const now = Date.now();
  if (cachedFileTypes && now - cachedFileTypesAt < 60 * 60 * 1000) {
    return cachedFileTypes;
  }
  const result = await managePhpPost({
    action: "getFileTypes",
    enabled: "1",
    page: "1",
    start: "0",
    limit: "1000",
  });
  cachedFileTypes = parseFileTypesFromResponse(result.json);
  cachedFileTypesAt = now;
  return cachedFileTypes;
}

/**
 * Resolves numeric fileType ids for Carrier Bill (internal) vs POD (customer).
 * Env overrides win; otherwise matches getFileTypes by name.
 * @return {Promise<{carrierBill: object, pod: object}>}
 */
async function resolveUploadFileTypes() {
  const envCarrier = process.env.PRIMUS_UI_FILETYPE_CARRIER_BILL;
  const envPod = process.env.PRIMUS_UI_FILETYPE_POD;

  const types = await fetchUiFileTypes();

  const carrier = envCarrier ?
    {id: String(envCarrier), name: "Carrier Bill (env)", external: "0"} :
    (matchFileTypeByCode(types, "OB") ||
      matchFileTypeByName(types, ["carrier bill"]) ||
      {id: "372", name: "Carrier Bill", external: "0"});

  const pod = (envPod != null && envPod !== "") ?
    {id: String(envPod), name: "POD (env)", external: "1"} :
    (matchFileTypeByCode(types, "POD") ||
      matchFileTypeByName(types, [
        "pod - proof of delivery",
        "proof of delivery",
        "pod",
      ]) ||
      {id: "0", name: "POD - Proof of Delivery", external: "1"});

  if (carrier.id === pod.id) {
    throw new Error(
        "Carrier bill and POD resolved to the same fileType id " +
        `(${carrier.id})`);
  }
  if (carrier.external === "1" && writeLog) {
    await writeLog("warn", "primus",
        "Carrier Bill file type is customer-visible (external=1)", {
          fileTypeId: carrier.id,
          fileTypeName: carrier.name,
        });
  }
  if (pod.external !== "1" && writeLog) {
    await writeLog("warn", "primus",
        "POD file type is not customer-visible (external!=1)", {
          fileTypeId: pod.id,
          fileTypeName: pod.name,
        });
  }
  return {carrierBill: carrier, pod};
}

/**
 * @param {object} docData getBookingDocuments JSON body.
 * @param {string|number} fileType Primus fileType id.
 * @return {boolean}
 */
function bookingHasFileType(docData, fileType) {
  if (!docData || typeof docData !== "object") return false;
  const want = String(fileType);
  const lists = [
    docData.files,
    docData.documents,
    docData.driveFiles,
    docData.drive,
    docData.data && docData.data.files,
    docData.data && docData.data.documents,
  ].filter(Array.isArray);
  for (const list of lists) {
    const found = list.some((f) => {
      const ft = f.fileType != null ? f.fileType :
        (f.fileTypeId != null ? f.fileTypeId : f.type);
      return String(ft) === want;
    });
    if (found) return true;
  }
  return false;
}

/**
 * uploadDriveFile — carrier bill PDF or POD (DevTools capture #29 / #82).
 * @param {object} args bookingId, bookingBOL, fileType, fileBuffer, filename
 * @return {Promise<object>}
 */
async function uploadDriveFile(args) {
  const result = await managePhpUpload({
    action: "uploadDriveFile",
    bookingId: String(args.bookingId),
    bookingBOL: String(args.bookingBOL),
    vendorId: "0",
    shippingLocationId: "0",
    tractorId: "0",
    folderId: "undefined",
    createdFrom: "BOL",
    fromApplet: "false",
    fileType: String(args.fileType),
    fileDescription: "DriveToUpload",
  }, args.fileBuffer, args.filename || "document.pdf");

  const success = isUploadSuccess(result.json, result.text);
  const fileId = result.json && result.json.fileId ?
    String(result.json.fileId) : null;
  return {
    ok: success,
    status: result.status,
    json: result.json,
    fileId,
    text: (result.text || "").slice(0, 500),
    error: success ? null :
      ((result.json && result.json.message) ||
        (result.json && result.json.error) ||
        "uploadDriveFile failed"),
  };
}
exports.uploadDriveFile = uploadDriveFile;

/**
 * Uploads a PDF if provided and not already on the booking.
 * @param {object} args docData, bookingId, bookingBOL, fileType, file, skip
 * @return {Promise<object>}
 */
async function maybeUploadBookingPdf(args) {
  if (args.skip) {
    return {ok: true, skipped: true, reason: "skip flag"};
  }
  const file = args.file;
  if (!file || !file.buffer || !file.buffer.length) {
    return {ok: true, skipped: true, reason: "no file"};
  }
  if (args.docData && bookingHasFileType(args.docData, args.fileType)) {
    return {ok: true, skipped: true, reason: "already uploaded"};
  }
  const up = await uploadDriveFile({
    bookingId: args.bookingId,
    bookingBOL: args.bookingBOL,
    fileType: args.fileType,
    fileBuffer: file.buffer,
    filename: file.filename || "document.pdf",
  });
  if (!up.ok) {
    return {
      ok: false,
      error: up.error,
      raw: up.text,
      fileType: args.fileType,
      fileTypeName: args.fileTypeName || null,
    };
  }
  return {
    ok: true,
    uploaded: true,
    fileType: args.fileType,
    fileTypeName: args.fileTypeName || null,
    fileId: up.fileId || null,
  };
}

/**
 * Loads invoice/documents for a booking (read-only UI action).
 * @param {object} args bookingId, bookingBOL
 * @return {Promise<object>} Parsed getBookingDocuments response.
 */
async function getBookingDocuments({bookingId, bookingBOL}) {
  const result = await managePhpPost({
    action: "getBookingDocuments",
    bookingId: String(bookingId),
    bookingBOL: String(bookingBOL),
    vendorId: "0",
    insuranceId: "0",
    shippingLocationId: "0",
    fromApplet: "false",
  });
  if (!result.json) {
    return {
      ok: false,
      error: "getBookingDocuments did not return JSON",
      status: result.status,
      raw: (result.text || "").slice(0, 500),
    };
  }
  return {ok: true, data: result.json};
}
exports.getBookingDocuments = getBookingDocuments;

const DEFAULT_EMAIL_DOCS_BODY =
  "<br><br><br>Hi,<br><br>Please see your invoices attached.<br><br>" +
  "Thank you!<br>";

/**
 * @param {object} booking Primus booking from GET /book/bolnumber.
 * @return {{quoteId: (string|number), customerQuoteId: (string|number)}}
 */
function resolveBookingQuoteIds(booking) {
  const acct = booking.accountingInformation || {};
  const customerQuoteId =
    acct.customerQuoteId || booking.customerQuoteId || 0;
  const quoteId =
    booking.quoteId ||
    booking.QMSQuoteId ||
    booking.QMSQuoteID ||
    acct.quoteId ||
    booking.vendorQuoteId ||
    customerQuoteId ||
    0;
  return {quoteId, customerQuoteId};
}

/**
 * manage.php bookingId for this shipment only — differs from REST BOLId.
 * Decoded per-booking from that load's BOLDocumentURL ?id= (base64).
 * Never hardcode or reuse another load's id.
 * @param {object} booking Primus booking from GET /book/bolnumber/{load}.
 * @return {string} UI booking id for this shipment, or "" if not derivable.
 */
function resolveManageBookingId(booking) {
  if (!booking) return "";
  const url = booking.BOLDocumentURL || booking.documentURL || "";
  const m = String(url).match(/[?&]id=([^&]+)/i);
  if (!m) return "";
  try {
    const decoded = Buffer.from(
        decodeURIComponent(m[1]), "base64").toString("utf8");
    return /^\d+$/.test(decoded) ? decoded : "";
  } catch (_) {
    return "";
  }
}

/**
 * @param {object} docData getBookingDocuments JSON body.
 * @return {Array<Array<object>>}
 */
function collectDocumentListArrays(docData) {
  if (!docData || typeof docData !== "object") return [];
  return [
    docData.files,
    docData.documents,
    docData.driveFiles,
    docData.drive,
    docData.data && docData.data.files,
    docData.data && docData.data.documents,
    docData.data && docData.data.driveFiles,
  ].filter(Array.isArray);
}

/**
 * @param {object} file Single document row from getBookingDocuments.
 * @return {string|null}
 */
function readDriveFileId(file) {
  if (!file || typeof file !== "object") return null;
  const id = file.driveId || file.driveFileId || file.googleDriveId ||
    file.gDriveId || file.drive || file.fileId || file.id;
  return id != null ? String(id) : null;
}

/**
 * POD drive file ids from getBookingDocuments (by fileType or name).
 * @param {object} docData getBookingDocuments JSON body.
 * @param {string|number} [podFileTypeId] POD fileType id from getFileTypes.
 * @return {string[]}
 */
function listPodDriveFileIds(docData, podFileTypeId) {
  const ids = [];
  const podTypeId = podFileTypeId != null ? String(podFileTypeId) : null;
  for (const list of collectDocumentListArrays(docData)) {
    for (const f of list) {
      const driveId = readDriveFileId(f);
      if (!driveId) continue;
      const ft = f.fileType != null ? f.fileType :
        (f.fileTypeId != null ? f.fileTypeId : f.type);
      const name = String(
          f.name || f.fileName || f.description || f.fileDescription || "",
      ).toUpperCase();
      const isPodType = podTypeId && String(ft) === podTypeId;
      const nameLooksPod = /POD|PROOF OF DELIVERY/.test(name);
      if (isPodType || nameLooksPod) {
        ids.push(driveId);
      }
    }
  }
  return [...new Set(ids)];
}

/**
 * Customer-visible drive file ids for emailBOLDocs attachments.
 * @param {object} docData getBookingDocuments JSON body.
 * @param {object} [opts] podFileTypeId — always include this file type.
 * @return {string[]}
 */
function listCustomerDriveFileIds(docData, opts = {}) {
  const ids = [];
  const podTypeId = opts.podFileTypeId != null ?
    String(opts.podFileTypeId) : null;
  for (const list of collectDocumentListArrays(docData)) {
    for (const f of list) {
      const driveId = readDriveFileId(f);
      if (!driveId) continue;
      const ft = f.fileType != null ? f.fileType :
        (f.fileTypeId != null ? f.fileTypeId : f.type);
      const isExternal = f.external === "1" || f.external === 1 ||
        f.isExternal === true || f.isExternal === "1";
      if (podTypeId && String(ft) === podTypeId) {
        ids.push(driveId);
        continue;
      }
      if (isExternal) {
        ids.push(driveId);
      }
    }
  }
  return [...new Set(ids)];
}

/**
 * @param {object} json Parsed manage.php JSON body.
 * @return {boolean}
 */
function isEmailBOLDocsSuccess(json) {
  if (!json || typeof json !== "object") return false;
  const ok = json.success === true || json.success === "true";
  return ok && /email has been sent/i.test(String(json.message || ""));
}

/**
 * Resolves POD drive file ids for email-docs-drive-{id}=on checkboxes.
 * @param {object} args booking, loadNumber, podPdf, extraDriveFileIds
 * @return {Promise<{podDriveIds: string[]}>}
 */
async function resolvePodDriveIdsForEmail(args) {
  const booking = args.booking;
  const loadNumber = args.loadNumber;
  const uploadFileTypes = await resolveUploadFileTypes();
  const podFileTypeId = uploadFileTypes.pod.id;
  const bookingId = resolveManageBookingId(booking);
  if (!bookingId) {
    return {ok: false, error: "Could not resolve manage.php bookingId"};
  }

  const fetchDocData = async () => {
    const docs = await getBookingDocuments({
      bookingId,
      bookingBOL: loadNumber,
    });
    return docs.ok ? docs.data : null;
  };

  let docData = await fetchDocData();
  let podDriveIds = docData ?
    listPodDriveFileIds(docData, podFileTypeId) : [];

  for (const id of args.extraDriveFileIds || []) {
    if (id) podDriveIds.push(String(id));
  }
  podDriveIds = [...new Set(podDriveIds)];

  const podOnBooking = docData &&
    bookingHasFileType(docData, podFileTypeId);
  const podPdf = args.podPdf;
  const needsUpload = !podDriveIds.length &&
    podPdf && podPdf.buffer && podPdf.buffer.length && !podOnBooking;

  if (needsUpload) {
    const up = await uploadDriveFile({
      bookingId,
      bookingBOL: loadNumber,
      fileType: podFileTypeId,
      fileBuffer: podPdf.buffer,
      filename: podPdf.filename || `pod-${loadNumber}.pdf`,
    });
    if (up.ok && up.fileId) {
      podDriveIds.push(String(up.fileId));
    }
    docData = await fetchDocData();
    if (docData) {
      podDriveIds = [...new Set([
        ...podDriveIds,
        ...listPodDriveFileIds(docData, podFileTypeId),
      ])];
    }
  } else if (!podDriveIds.length && docData) {
    podDriveIds = listPodDriveFileIds(docData, podFileTypeId);
    if (!podDriveIds.length) {
      podDriveIds = listCustomerDriveFileIds(docData, {podFileTypeId});
    }
  }

  return {podDriveIds};
}

/**
 * Sends invoice + BOL + drive docs to the customer via manage.php emailBOLDocs.
 * Mirrors UI document checkboxes:
 * email-docs-invoice-{id}, email-docs-drive-{id}.
 * @param {object} args booking, loadNumber, customerEmail, customerInvoiceId,
 *   invoiceNumber, chargesTotal, podPdf, extraDriveFileIds, subject
 * @return {Promise<object>}
 */
async function emailBOLDocs(args) {
  if (!isManagePhpEnabled()) {
    return {ok: false, skipped: true, reason: "PRIMUS_USE_MANAGE_PHP off"};
  }
  const booking = args.booking;
  if (!booking || !booking.BOLId) {
    return {ok: false, error: "Booking missing BOLId"};
  }
  const customerEmail = args.customerEmail;
  if (!customerEmail) {
    return {ok: false, error: "No customer email"};
  }
  const customerInvoiceId = args.customerInvoiceId;
  if (!customerInvoiceId) {
    return {ok: false, error: "No customerInvoiceId"};
  }
  const loadNumber = args.loadNumber || booking.BOLNbr || booking.bolNumber;
  if (!loadNumber) {
    return {ok: false, error: "No load number"};
  }

  const {quoteId, customerQuoteId} = resolveBookingQuoteIds(booking);
  const chargesTotal = args.chargesTotal != null ?
    Number(args.chargesTotal).toFixed(2) : "0.00";
  const invoiceNumber = args.invoiceNumber != null ?
    String(args.invoiceNumber) : "0";

  const {podDriveIds} = await resolvePodDriveIdsForEmail({
    booking,
    loadNumber,
    podPdf: args.podPdf,
    extraDriveFileIds: [
      ...(args.extraDriveFileIds || []),
      ...(Array.isArray(args.driveFileIds) ? args.driveFileIds : []),
    ],
  });

  const driveFileIds = [...new Set(podDriveIds)];

  const subject = args.subject ||
    `Documents for BOL#${loadNumber}`;
  const body = process.env.PRIMUS_UI_EMAIL_DOCS_BODY ||
    DEFAULT_EMAIL_DOCS_BODY;
  const fromAddr = process.env.PRIMUS_UI_EMAIL_FROM ||
    "accounting@innovativecarriers.com";

  const manageBookingId = resolveManageBookingId(booking);
  if (!manageBookingId) {
    return {ok: false, error: "Could not resolve manage.php bookingId"};
  }

  const params = {
    action: "emailBOLDocs",
    bookingId: manageBookingId,
    quoteId: String(quoteId || 0),
    invoiceId: "0",
    invoiceNumber: "0",
    invoices: [{
      id: String(customerInvoiceId),
      invoiceNumber,
      chargesTotal,
    }],
    customerQuoteId: String(customerQuoteId || 0),
    fromApplet: "false",
    consolidate: "true",
    bookingCreateSingleFile: "false",
    bookingBOL: String(loadNumber),
  };
  params["email-docs-from"] = fromAddr;
  params["email-docs-to"] = customerEmail;
  params["email-docs-subject"] = subject;
  params["email-docs-body"] = body;
  params["email-docs-bol"] = "on";
  // UI checkbox: attach issued customer invoice
  params[`email-docs-invoice-${customerInvoiceId}`] = "on";
  // UI checkbox(es): attach POD / customer-visible drive file(s)
  for (const driveId of driveFileIds) {
    params[`email-docs-drive-${driveId}`] = "on";
  }

  const result = await managePhpPost(params);
  const success = isEmailBOLDocsSuccess(result.json);
  const attachments = {
    invoiceSelected: true,
    bolSelected: true,
    podDriveIdsSelected: driveFileIds,
    customerInvoiceId: String(customerInvoiceId),
    invoiceNumber,
  };
  return {
    ok: success,
    json: result.json,
    status: result.status,
    driveFileIds,
    attachments,
    to: customerEmail,
    error: success ? null :
      ((result.json && result.json.message) ||
        (result.json && result.json.error) ||
        "emailBOLDocs failed"),
    raw: !success ? (result.text || "").slice(0, 500) : undefined,
  };
}
exports.emailBOLDocs = emailBOLDocs;

/**
 * @param {object} json Parsed manage.php JSON body.
 * @return {boolean}
 */
function isManageSuccess(json) {
  if (!json || typeof json !== "object") return false;
  if (json.error) return false;
  const flags = [
    json.success,
    json.successInvoice,
    json.successQB,
  ];
  return flags.some((f) => f === true || f === "true");
}

/**
 * @param {object} booking Primus booking from GET /book/bolnumber.
 * @return {number|null}
 */
function resolveBilltoId(booking) {
  const locs = booking.shippingLocations;
  if (Array.isArray(locs) && locs[0] && locs[0].id != null) {
    return Number(locs[0].id);
  }
  if (booking.shipper && booking.shipper.id != null) {
    return Number(booking.shipper.id);
  }
  if (booking.thirdParty && booking.thirdParty.id != null) {
    return Number(booking.thirdParty.id);
  }
  const override = process.env.PRIMUS_UI_BILLTO_ID;
  if (override) return Number(override);
  return null;
}

/**
 * @return {number}
 */
function defaultTermsId() {
  const raw = process.env.PRIMUS_UI_DEFAULT_TERMS_ID || "417";
  const n = Number(raw);
  return Number.isFinite(n) ? n : 417;
}

let cachedTerms = null;
let cachedTermsAt = 0;

/**
 * @param {object} json getTerms response.
 * @return {Array<object>} terms rows with id, days, code, description
 */
function parseTermsFromResponse(json) {
  if (!json || typeof json !== "object") return [];
  const list = Array.isArray(json.terms) ? json.terms :
    (json.data && Array.isArray(json.data.terms) ? json.data.terms : []);
  return list.map((t) => ({
    id: String(t.id),
    days: Number(t.days),
    code: String(t.code || ""),
    description: String(t.description || ""),
  })).filter((t) => t.id && Number.isFinite(t.days));
}

/**
 * @return {Promise<Array<object>>}
 */
async function fetchUiTerms() {
  const now = Date.now();
  if (cachedTerms && now - cachedTermsAt < 60 * 60 * 1000) {
    return cachedTerms;
  }
  const result = await managePhpPost({
    action: "getTerms",
    active: "1",
    page: "1",
    start: "0",
    limit: "25",
    sort: JSON.stringify([{property: "description", direction: "ASC"}]),
  });
  cachedTerms = parseTermsFromResponse(result.json);
  cachedTermsAt = now;
  return cachedTerms;
}

/**
 * @param {string|Date} start Bill date.
 * @param {string|Date} end Due date.
 * @return {number}
 */
function diffCalendarDays(start, end) {
  const a = new Date(toDateOnly(start));
  const b = new Date(toDateOnly(end));
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/**
 * Match carrier invoice bill/due dates to a Primus terms id via getTerms.
 * @param {string|Date} billDate Carrier invoice date.
 * @param {string|Date|null} billDueDate Carrier due date (from email/PDF).
 * @param {Array<object>} termsList From fetchUiTerms.
 * @return {object} ok, termsId, source, days, error
 */
function resolveTermsForCarrierBill(billDate, billDueDate, termsList) {
  const fallbackId = defaultTermsId();
  const fallback = termsList.find((t) => t.id === String(fallbackId));

  if (!billDueDate) {
    return {
      ok: true,
      termsId: fallbackId,
      source: "default_net30",
      days: fallback ? fallback.days : 30,
      description: fallback ? fallback.description : "Net 30",
    };
  }

  const days = diffCalendarDays(billDate, billDueDate);
  if (!Number.isFinite(days) || days < 0) {
    return {ok: false, error: "Invalid carrier bill date or due date"};
  }

  const exact = termsList.find((t) => t.days === days);
  if (exact) {
    return {
      ok: true,
      termsId: Number(exact.id),
      source: "matched_days",
      days,
      code: exact.code,
      description: exact.description,
    };
  }

  return {
    ok: false,
    error: `Carrier invoice due date is ${days} day(s) after bill date; ` +
      `no matching Primus terms (getTerms)`,
    days,
    billDate: toDateOnly(billDate),
    dueDate: toDateOnly(billDueDate),
    availableTerms: termsList.map((t) => ({
      id: t.id,
      days: t.days,
      code: t.code,
    })),
  };
}

/**
 * @param {string|Date|null} raw Date input.
 * @return {string} YYYY-MM-DD
 */
function toDateOnly(raw) {
  const d = raw ? new Date(raw) : new Date();
  if (isNaN(d.getTime())) return new Date().toISOString().split("T")[0];
  return d.toISOString().split("T")[0];
}

/**
 * @param {string} isoDate YYYY-MM-DD
 * @return {string} ISO midnight UTC-style string Primus expects.
 */
function toPrimusDateTime(isoDate) {
  return `${isoDate}T00:00:00`;
}

/**
 * @param {number} amount
 * @return {number}
 */
function roundMoney(amount) {
  return Math.round(Number(amount) * 100) / 100;
}

/**
 * Builds vendor bill JSON for billsInfo from booking vendor + carrier invoice.
 * @param {object} vendor booking.vendor
 * @param {object} bill Carrier bill fields.
 * @param {number} [termsId] Primus terms id from resolveTermsForCarrierBill.
 * @return {object}
 */
function buildBillsInfo(vendor, bill, termsId) {
  const breakdown = Array.isArray(vendor.breakdown) && vendor.breakdown.length ?
    vendor.breakdown.map((line, idx) => ({
      code: line.code || (idx === 0 ? "FRT" : ""),
      description: line.description || "FREIGHT CHARGE",
      qty: Number(line.qty || 1),
      rate: roundMoney(line.rate),
      total: roundMoney(line.total || line.rate),
      ...(idx === 0 ? {first: true} : {}),
    })) :
    [{
      code: "FRT",
      description: "FREIGHT CHARGE",
      qty: 1,
      rate: roundMoney(bill.total),
      total: roundMoney(bill.total),
      first: true,
    }];
  const total = breakdown.reduce(
      (sum, line) => sum + Number(line.total || 0), 0);
  return {
    code: "FRT",
    vendorInvoiceNumber: String(bill.vendorInvoiceNumber),
    carrierId: String(vendor.id),
    carrierName: String(vendor.name || ""),
    total: roundMoney(total || bill.total),
    breakdown,
    terms: termsId != null ? Number(termsId) : defaultTermsId(),
    PRO: String(bill.proNumber || bill.vendorInvoiceNumber),
    billDate: toPrimusDateTime(toDateOnly(bill.billDate)),
    billDueDate: toPrimusDateTime(toDateOnly(bill.billDueDate)),
  };
}

/**
 * @param {object} vendor booking.vendor
 * @return {Array<object>}
 */
function buildEstimatedCosts(vendor) {
  const breakdown = Array.isArray(vendor.breakdown) && vendor.breakdown.length ?
    vendor.breakdown :
    [{
      description: "FREIGHT CHARGE",
      qty: 1,
      rate: Number(vendor.cost || 0),
      total: Number(vendor.cost || 0),
    }];
  return breakdown.map((line, idx) => ({
    id: idx,
    code: line.code || (idx === 0 ? "" : ""),
    description: line.description || "FREIGHT CHARGE",
    carrierId: Number(vendor.id),
    carrierName: String(vendor.name || ""),
    qty: Number(line.qty || 1),
    editable: false,
    rate: roundMoney(line.rate),
    total: roundMoney(line.total || line.rate).toFixed(2),
    isAccessorial: idx > 0,
    vendorInvoiceNumber: "",
    terms: "",
    PRO: "",
  }));
}

/**
 * @param {object} vendor booking.vendor
 * @param {object} bill Carrier bill fields.
 * @param {Array<object>|null} withIds Server line ids after first save.
 * @return {Array<object>}
 */
function buildActualCosts(vendor, bill, withIds = null) {
  const billsInfo = buildBillsInfo(vendor, bill);
  return billsInfo.breakdown.map((line, idx) => ({
    id: withIds && withIds[idx] ? withIds[idx].id : idx,
    code: line.code || (idx === 0 ? "FRT" : ""),
    description: line.description,
    carrierId: String(vendor.id),
    carrierName: String(vendor.name || ""),
    qty: line.qty,
    rate: line.rate,
    total: roundMoney(line.total).toFixed(2),
    vendorInvoiceNumber: String(bill.vendorInvoiceNumber),
    terms: "",
    PRO: "",
    isAccessorial: idx > 0,
  }));
}

/**
 * @param {number} customerRate Customer sell rate.
 * @return {Array<object>}
 */
function buildCustomerCharges(customerRate) {
  return [{
    id: 1,
    code: "",
    qty: 1,
    description: "FREIGHT CHARGE",
    rate: roundMoney(customerRate),
    total: roundMoney(customerRate).toFixed(2),
    chargeType: "",
  }];
}

/**
 * @param {object} storeData getInvoiceStores response object.
 * @return {Array<object>|null}
 */
function extractActualCostsFromStore(storeData) {
  if (!storeData || typeof storeData !== "object") return null;
  const candidates = [
    storeData.actualCosts,
    storeData.data && storeData.data.actualCosts,
    storeData.invoice && storeData.invoice.actualCosts,
    storeData.results && storeData.results.actualCosts,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
  }
  return null;
}

/**
 * @param {string|number} invoiceId Primus invoice id.
 * @return {Promise<object>}
 */
async function getInvoiceStores(invoiceId) {
  const result = await managePhpPost({
    action: "getInvoiceStores",
    id: String(invoiceId),
  });
  if (!result.json) {
    return {ok: false, error: "getInvoiceStores did not return JSON"};
  }
  return {ok: true, data: result.json};
}

/**
 * @param {object} storeData getInvoiceStores response object.
 * @return {Array<object>|null}
 */
function extractChargesFromStore(storeData) {
  if (!storeData || typeof storeData !== "object") return null;
  const candidates = [
    storeData.charges,
    storeData.data && storeData.data.charges,
    storeData.invoice && storeData.invoice.charges,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
  }
  return null;
}

/**
 * @param {object} storeData getInvoiceStores response object.
 * @return {Array<object>|null}
 */
function extractEstimatedCostsFromStore(storeData) {
  if (!storeData || typeof storeData !== "object") return null;
  const candidates = [
    storeData.estimatedCosts,
    storeData.data && storeData.data.estimatedCosts,
    storeData.invoice && storeData.invoice.estimatedCosts,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
  }
  return null;
}

/**
 * Dynamic vendor-ref fields on addVendorRefNumber (carrierId+invoice# keys).
 * @param {object} args ids and bill metadata.
 * @return {object}
 */
function buildVendorRefExtraFields(args) {
  const key = `${args.carrierId}${args.vendorInvoiceNumber}`;
  const termsId = args.termsId != null ?
    Number(args.termsId) : defaultTermsId();
  return {
    [`${key}Total`]: roundMoney(args.total),
    [`${key}Date`]: toDateOnly(args.billDate),
    [`${key}Terms`]: String(termsId),
    [`${key}DueDate`]: toDateOnly(args.billDueDate),
    [`${key}PRONumber`]: String(args.proNumber),
  };
}

/**
 * @return {boolean}
 */
function isManagePhpEnabled() {
  const flag = process.env.PRIMUS_USE_MANAGE_PHP || "";
  return String(flag).toLowerCase() === "true";
}
exports.isManagePhpEnabled = isManagePhpEnabled;

/**
 * Full Primus UI billing flow captured from production DevTools:
 * saveInvoice (costs) → addVendorRefNumber → saveInvoice (ready) →
 * consolidateInvoices (issue).
 * @param {object} args Flow inputs from workflow + GET /book.
 * @return {Promise<object>}
 */
async function runPrimusUiBillingFlow(args) {
  if (!isManagePhpEnabled()) {
    return {ok: false, skipped: true, reason: "PRIMUS_USE_MANAGE_PHP off"};
  }
  if (args.generated) {
    return {ok: false, skipped: true, reason: "already generated"};
  }

  const booking = args.booking;
  if (!booking || !booking.BOLId) {
    return {ok: false, error: "Booking missing BOLId"};
  }

  let uploadFileTypes;
  try {
    uploadFileTypes = await resolveUploadFileTypes();
  } catch (typeErr) {
    return {ok: false, step: "resolveFileTypes", error: typeErr.message};
  }
  if (writeLog) {
    await writeLog("info", "primus", "Primus upload file types resolved", {
      carrierBillTypeId: uploadFileTypes.carrierBill.id,
      carrierBillTypeName: uploadFileTypes.carrierBill.name,
      podTypeId: uploadFileTypes.pod.id,
      podTypeName: uploadFileTypes.pod.name,
    });
  }

  const loadNumber = args.loadNumber ? String(args.loadNumber) : null;
  const bookingId = resolveManageBookingId(booking);
  if (!bookingId) {
    return {ok: false, error: "Could not resolve manage.php bookingId"};
  }
  let bookingDocData = null;
  if (loadNumber) {
    const docs = await getBookingDocuments({
      bookingId,
      bookingBOL: loadNumber,
    });
    if (docs.ok) {
      bookingDocData = docs.data;
    }
    if (bookingDocData && Array.isArray(bookingDocData.invoices)) {
      const issued = bookingDocData.invoices.find((inv) => {
        const num = inv.invoiceNumber;
        return num != null && String(num) !== "" && String(num) !== "0";
      });
      if (issued) {
        const podUpload = await maybeUploadBookingPdf({
          docData: bookingDocData,
          bookingId,
          bookingBOL: loadNumber,
          fileType: uploadFileTypes.pod.id,
          fileTypeName: uploadFileTypes.pod.name,
          file: args.podPdf,
          skip: args.skipPodUpload,
        });
        return {
          ok: true,
          skipped: true,
          reason: "already issued",
          generated: true,
          customerInvoiceId: Number(issued.id),
          invoiceNumber: String(issued.invoiceNumber),
          podUpload,
          podUploaded: !!(podUpload.uploaded || podUpload.skipped),
        };
      }
    }
  }

  const carrierBillUpload = await maybeUploadBookingPdf({
    docData: bookingDocData,
    bookingId,
    bookingBOL: loadNumber || bookingId,
    fileType: uploadFileTypes.carrierBill.id,
    fileTypeName: uploadFileTypes.carrierBill.name,
    file: args.carrierBillPdf,
    skip: args.skipCarrierBillUpload,
  });
  if (!carrierBillUpload.ok) {
    return {
      ok: false,
      step: "uploadDriveFile_carrierBill",
      error: carrierBillUpload.error || "Carrier bill PDF upload failed",
      raw: carrierBillUpload.raw,
    };
  }
  if (carrierBillUpload.uploaded && writeLog) {
    await writeLog("info", "primus", "Carrier bill PDF uploaded to Primus", {
      loadNumber,
      bookingId,
      fileTypeId: uploadFileTypes.carrierBill.id,
      fileTypeName: uploadFileTypes.carrierBill.name,
    });
  }

  const vendor = booking.vendor || {};
  if (!vendor.id) {
    return {ok: false, error: "Booking missing vendor.id"};
  }
  const billtoId = resolveBilltoId(booking);
  if (!billtoId) {
    return {ok: false, error: "Could not resolve billtoId from booking"};
  }

  const billDate = args.billDate || new Date();
  const carrierDueDate = args.billDueDate || null;
  const billDueDate = carrierDueDate || (() => {
    const d = new Date(billDate);
    d.setDate(d.getDate() + 30);
    return d;
  })();
  const proNumber = String(args.proNumber || vendor.PRO || "");
  const vendorInvoiceNumber = String(
      args.vendorInvoiceNumber || proNumber || "");
  const carrierTotal = roundMoney(
      args.carrierInvoiceAmount || vendor.cost || 0);
  const customerRate = roundMoney(args.customerRate || 0);
  if (!carrierTotal || !customerRate) {
    return {ok: false, error: "Missing carrier or customer rate"};
  }

  const bill = {
    vendorInvoiceNumber,
    proNumber,
    total: carrierTotal,
    billDate,
    billDueDate,
  };

  let termsList = [];
  try {
    termsList = await fetchUiTerms();
  } catch (termsErr) {
    return {
      ok: false,
      step: "getTerms",
      error: termsErr.message || "getTerms failed",
    };
  }
  const termsResolution = resolveTermsForCarrierBill(
      billDate, carrierDueDate, termsList);
  if (!termsResolution.ok) {
    return {
      ok: false,
      step: "validateTerms",
      error: termsResolution.error,
      details: termsResolution,
    };
  }
  const termsId = termsResolution.termsId;
  if (writeLog && termsResolution.source === "matched_days") {
    await writeLog("info", "primus", "Carrier bill terms validated", {
      loadNumber,
      bookingId,
      termsId,
      days: termsResolution.days,
      description: termsResolution.description || null,
      billDate: toDateOnly(billDate),
      dueDate: toDateOnly(carrierDueDate),
    });
  }

  const billsInfo = [buildBillsInfo(vendor, bill, termsId)];
  const estimatedCosts = buildEstimatedCosts(vendor);
  const totalEstimated = roundMoney(
      estimatedCosts.reduce((s, l) => s + Number(l.total || 0), 0));
  const actualCostsFirst = buildActualCosts(vendor, bill);
  const totalActual = roundMoney(
      actualCostsFirst.reduce((s, l) => s + Number(l.total || 0), 0));
  const profit = roundMoney(customerRate - totalActual);
  const profitPer = totalActual > 0 ?
    (profit / totalActual) * 100 : 0;
  const gp = customerRate > 0 ? (profit / customerRate) * 100 : 0;

  const notes = {
    internalNotes: String(booking.internalNotes || ""),
    externalNotes: String(booking.externalNotes || ""),
  };

  const phase1 = await managePhpPost({
    action: "saveInvoice",
    billsInfo,
    charges: buildCustomerCharges(customerRate),
    actualCosts: actualCostsFirst,
    estimatedCosts,
    chargesTotal: customerRate,
    totalEstimatedCosts: totalEstimated,
    totalActualCosts: totalActual,
    billtoId: String(billtoId),
    bookingId: bookingId,
    ...notes,
    costClosed: "0",
    costActualClosed: "1",
    readyToInvoice: "0",
    estimatedProfitUSD: profit,
    estimatedProfitPer: profitPer,
    estimatedGP: gp,
    actualProfitUSD: profit,
    actualProfitPer: profitPer,
    actualGP: gp,
    vendorInvoiceNumber: "",
    vendorTerm: "",
    PRONumber: proNumber,
    invoiceNumber: "0",
  });

  if (!phase1.json || !isManageSuccess(phase1.json)) {
    return {
      ok: false,
      step: "saveInvoice_phase1",
      error: (phase1.json && phase1.json.message) ||
        "First saveInvoice failed",
      raw: phase1.text.slice(0, 500),
    };
  }

  const uiInvoiceId = phase1.json.recordId || args.customerInvoiceId;
  if (!uiInvoiceId) {
    return {ok: false, error: "saveInvoice phase1 returned no recordId"};
  }

  const stores = await getInvoiceStores(uiInvoiceId);
  const storeData = stores.ok ? stores.data : null;
  const storedCosts = extractActualCostsFromStore(storeData);
  const actualCostsWithIds = buildActualCosts(
      vendor, bill, storedCosts || actualCostsFirst);
  const storedCharges = extractChargesFromStore(storeData);
  const phase2Charges = storedCharges || [{
    code: "",
    description: "FREIGHT CHARGE",
    qty: 1,
    rate: customerRate,
    total: roundMoney(customerRate).toFixed(2),
  }];
  const storedEstimated = extractEstimatedCostsFromStore(storeData);
  const phase2Estimated = storedEstimated || estimatedCosts.map((line) => ({
    ...line,
    editable: "0",
  }));

  const refExtra = buildVendorRefExtraFields({
    carrierId: vendor.id,
    vendorInvoiceNumber,
    total: totalActual,
    billDate,
    billDueDate,
    proNumber,
    termsId,
  });

  const vendorRef = await managePhpPost({
    action: "addVendorRefNumber",
    invoiceId: String(uiInvoiceId),
    bookingId: bookingId,
    billsInfo,
    actualCosts: actualCostsWithIds,
    actualProfitUSD: profit,
    actualProfitPer: profitPer,
    actualGP: gp,
    totalActualCost: totalActual,
    ...refExtra,
  });

  if (!vendorRef.json || !isManageSuccess(vendorRef.json)) {
    return {
      ok: false,
      step: "addVendorRefNumber",
      error: (vendorRef.json && vendorRef.json.message) ||
        "addVendorRefNumber failed",
      customerInvoiceId: uiInvoiceId,
    };
  }

  const phase2 = await managePhpPost({
    action: "saveInvoice",
    billsInfo,
    charges: phase2Charges,
    actualCosts: actualCostsWithIds,
    estimatedCosts: phase2Estimated,
    chargesTotal: customerRate,
    totalEstimatedCosts: totalEstimated,
    totalActualCosts: totalActual,
    billtoId: String(billtoId),
    bookingId: bookingId,
    ...notes,
    costClosed: "0",
    costActualClosed: "1",
    readyToInvoice: "1",
    estimatedProfitUSD: profit,
    estimatedProfitPer: profitPer,
    estimatedGP: gp,
    actualProfitUSD: profit,
    actualProfitPer: profitPer,
    actualGP: gp,
    vendorInvoiceNumber: "",
    vendorTerm: "",
    PRONumber: proNumber,
    invoiceNumber: "0",
    id: String(uiInvoiceId),
  });

  if (!phase2.json || !isManageSuccess(phase2.json)) {
    return {
      ok: false,
      step: "saveInvoice_phase2",
      error: (phase2.json && phase2.json.message) ||
        "Second saveInvoice failed",
      customerInvoiceId: uiInvoiceId,
    };
  }

  const genAction = process.env.PRIMUS_UI_GENERATE_ACTION ||
    "consolidateInvoices";
  const generationDate = toDateOnly(new Date());
  const phase3 = await managePhpPost({
    action: genAction,
    billToId: String(billtoId),
    invoices: [String(uiInvoiceId)],
    generationDate,
  });

  if (!phase3.json || !isManageSuccess(phase3.json)) {
    return {
      ok: false,
      step: "consolidateInvoices",
      error: (phase3.json && phase3.json.message) ||
        "consolidateInvoices failed",
      customerInvoiceId: uiInvoiceId,
    };
  }

  const invoiceNumber = phase3.json.maxInvoiceNumber ||
    (phase3.json.message &&
      (phase3.json.message.match(/Invoice#(\d+)/) || [])[1]) ||
    null;

  const podUpload = await maybeUploadBookingPdf({
    docData: bookingDocData,
    bookingId,
    bookingBOL: loadNumber || bookingId,
    fileType: uploadFileTypes.pod.id,
    fileTypeName: uploadFileTypes.pod.name,
    file: args.podPdf,
    skip: args.skipPodUpload,
  });
  if (!podUpload.ok && writeLog) {
    await writeLog("warn", "primus",
        "POD PDF upload to Primus failed (invoice was issued)", {
          loadNumber,
          bookingId,
          fileTypeId: uploadFileTypes.pod.id,
          fileTypeName: uploadFileTypes.pod.name,
          error: podUpload.error,
          raw: podUpload.raw,
        });
  } else if (podUpload.uploaded && writeLog) {
    await writeLog("info", "primus", "POD PDF uploaded to Primus", {
      loadNumber,
      bookingId,
      fileTypeId: uploadFileTypes.pod.id,
      fileTypeName: uploadFileTypes.pod.name,
    });
  }

  return {
    ok: true,
    issued: true,
    generated: true,
    customerInvoiceId: Number(uiInvoiceId),
    invoiceNumber,
    billtoId,
    uploadFileTypes,
    carrierBillUploaded: !!(carrierBillUpload.uploaded ||
      carrierBillUpload.skipped),
    podUploaded: !!(podUpload.uploaded || podUpload.skipped),
    carrierBillUpload,
    podUpload,
    steps: {
      carrierBillUpload: carrierBillUpload.skipped ?
        (carrierBillUpload.reason || "skipped") : "uploaded",
      saveInvoice1: phase1.json.message,
      addVendorRefNumber: vendorRef.json.message,
      saveInvoice2: phase2.json.message,
      consolidateInvoices: phase3.json.message,
      podUpload: podUpload.skipped ?
        (podUpload.reason || "skipped") :
        (podUpload.uploaded ? "uploaded" : (podUpload.error || "failed")),
    },
  };
}
exports.runPrimusUiBillingFlow = runPrimusUiBillingFlow;

/**
 * @deprecated Use runPrimusUiBillingFlow
 * @param {object} args Flow inputs (booking, rates, invoice ids).
 * @return {Promise<object>}
 */
async function maybeIssueInvoiceViaUi(args) {
  return runPrimusUiBillingFlow({
    ...args,
    booking: args.booking,
    customerRate: args.customerRate,
    carrierInvoiceAmount: args.carrierInvoiceAmount,
    proNumber: args.proNumber,
    vendorInvoiceNumber: args.vendorInvoiceNumber,
    billDate: args.billDate,
    billDueDate: args.billDueDate,
    generated: args.generated,
  });
}
exports.maybeIssueInvoiceViaUi = maybeIssueInvoiceViaUi;

exports._internal = {
  parsePhpSessId,
  extractSessionFromResponse,
  isManageSuccess,
  isUploadSuccess,
  parseManagePhpJson,
  bookingHasFileType,
  parseFileTypesFromResponse,
  matchFileTypeByName,
  matchFileTypeByCode,
  resolveBilltoId,
  buildBillsInfo,
  buildActualCosts,
  resolveBookingQuoteIds,
  resolveManageBookingId,
  listCustomerDriveFileIds,
  listPodDriveFileIds,
  resolveTermsForCarrierBill,
  parseTermsFromResponse,
  diffCalendarDays,
};
