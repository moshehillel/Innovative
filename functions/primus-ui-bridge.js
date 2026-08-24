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
 *   PRIMUS_UI_FILETYPE_QUOTE_APPROVAL — override Quote Approval type id
 *   PRIMUS_UI_QUOTE_APPROVAL_TYPE_NAME — match name in getFileTypes
 *   PRIMUS_UI_UPLOAD_FILE_FIELD — multipart file field name (default file)
 *   PRIMUS_UI_SESSION_TTL_HOURS — PHPSESSID cache lifetime (default 24)
 *   PRIMUS_UI_SESSION_RENEW_BEFORE_HOURS — renew when this many hours remain
 *   PRIMUS_UI_EMAIL_FROM — sender for emailBOLDocs (default accounting@…)
 *   PRIMUS_UI_EMAIL_DOCS_BODY — full HTML body override for emailBOLDocs
 *     (include payment signature yourself if you override the default)
 *   PRIMUS_INSURANCE_VENDOR_ID — Redkik vendor id (default 108637)
 *   PRIMUS_INSURANCE_VENDOR_NAME — Redkik vendor name (default Redkik USA)
 */

"use strict";

const {
  defaultPrimusEmailDocsBody,
  appendCustomerInvoiceEmailSignature,
} = require("./customer-invoice-email-body");
const {
  toOutboundEmailSafeSubject,
  toOutboundEmailSafeText,
} = require("./email-outbound-safe");
const workflowErrors = require("./workflow-error-messages");

const admin = require("firebase-admin");

const SESSION_DOC = "system/primusUiSession";
const DEFAULT_SESSION_TTL_HOURS = 24;
const DEFAULT_RENEW_BEFORE_HOURS = 2;
const MANAGE_POST_NETWORK_ATTEMPTS = 3;

let db;
let writeLog;
let getPrimusToken;

/**
 * @param {object} bundle { db, writeLog, getPrimusToken }
 * @return {void}
 */
function init(bundle) {
  ({db, writeLog, getPrimusToken} = bundle);
  if (getPrimusToken) {
    try {
      require("./quote-rate-shop").init({getPrimusToken});
    } catch (_) {
      // quote-rate-shop optional
    }
  }
}
exports.init = init;

/**
 * @return {FirebaseFirestore.Firestore}
 */
function firestore() {
  if (typeof db === "function") return db();
  return db || admin.firestore();
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
 * Drop the cached PHPSESSID so the next getUiSessionCookie() re-logins.
 * @return {Promise<void>}
 */
async function clearCachedSession() {
  await firestore().doc(SESSION_DOC).delete().catch(() => {});
}

/**
 * True when manage.php rejected the request because the UI session is dead.
 * Primus often returns plain text "No session started." (HTTP 200) instead of
 * 401 — that must trigger a re-login + retry, not a billing failure alert.
 * @param {number} status HTTP status.
 * @param {string} [text] Response body.
 * @return {boolean}
 */
function isUiSessionAuthFailure(status, text) {
  if (status === 401 || status === 403) return true;
  return /no session started|session expired|not logged|login/i
      .test(String(text || ""));
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

  const postWithNetworkRetry = async (sessionCookie) => {
    let lastErr;
    for (let attempt = 1; attempt <= MANAGE_POST_NETWORK_ATTEMPTS; attempt++) {
      try {
        return await doPost(sessionCookie);
      } catch (err) {
        lastErr = err;
        const msg = err && err.message ? err.message : String(err);
        if (attempt >= MANAGE_POST_NETWORK_ATTEMPTS ||
            !workflowErrors.isTransientNetworkError(msg)) {
          throw err;
        }
        if (writeLog) {
          await writeLog("warn", "primus",
              "manage.php network error — retrying", {
                action: params && params.action,
                attempt,
                error: msg,
              });
        }
        await new Promise((resolve) => setTimeout(resolve,
            workflowErrors.TRANSIENT_NETWORK_RETRY_MS));
      }
    }
    throw lastErr;
  };

  let result = await postWithNetworkRetry(cookie);
  if (retryOnAuthFail &&
      isUiSessionAuthFailure(result.status, result.text)) {
    if (writeLog) {
      await writeLog("warn", "primus",
          "Primus UI session dead — re-login and retry", {
            action: params && params.action,
            status: result.status,
            bodyPreview: String(result.text || "").slice(0, 120),
          });
    }
    await clearCachedSession();
    cookie = await loginUi();
    result = await postWithNetworkRetry(cookie);
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
  // Primus expects the binary under field name "DriveToUpload" (confirmed via
  // DevTools "Copy as cURL"). Anything else → "The uploaded file is empty".
  const fileField = process.env.PRIMUS_UI_UPLOAD_FILE_FIELD || "DriveToUpload";

  const doUpload = async (sessionCookie) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value == null) continue;
      form.append(key, String(value));
    }
    // Copy into a standalone ArrayBuffer. Passing a Node Buffer straight to
    // Blob can serialize as an empty multipart part under undici (manage.php
    // then reports "The uploaded file is empty. Error# 1025.").
    const buf = Buffer.isBuffer(fileBuffer) ?
      fileBuffer : Buffer.from(fileBuffer || []);
    const ab = buf.buffer.slice(
        buf.byteOffset, buf.byteOffset + buf.byteLength);
    const blob = new Blob([ab], {type: "application/pdf"});
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
  if (retryOnAuthFail &&
      isUiSessionAuthFailure(result.status, result.text)) {
    if (writeLog) {
      await writeLog("warn", "primus",
          "Primus UI session dead — re-login and retry upload", {
            action: fields && fields.action,
            status: result.status,
            bodyPreview: String(result.text || "").slice(0, 120),
          });
    }
    await clearCachedSession();
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
 * Resolves numeric fileType ids for Carrier Bill (internal) vs POD (customer)
 * and optional Quote Approval (Miworld customer emails).
 * Env overrides win; otherwise matches getFileTypes by name.
 * @return {Promise<object>} carrierBill, pod, quoteApproval (or null).
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

  const envQuote = process.env.PRIMUS_UI_FILETYPE_QUOTE_APPROVAL;
  const quoteNameHint = process.env.PRIMUS_UI_QUOTE_APPROVAL_TYPE_NAME ||
    "quote approval";
  const quoteApproval = envQuote ?
    {id: String(envQuote), name: "Quote Approval (env)", external: "1"} :
    (matchFileTypeByName(types, [
      quoteNameHint,
      "quote approval",
      "approved quote",
      "customer quote approval",
    ]) || null);

  return {carrierBill: carrier, pod, quoteApproval};
}

/**
 * True when bill-to / customer name is Miworld (spacing/case variants).
 * @param {string|null|undefined} name Customer display name.
 * @return {boolean}
 */
function isMiworldCustomer(name) {
  const compact = String(name || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return compact.includes("miworld");
}

/**
 * Best-effort customer display name from a Primus booking.
 * @param {object|null} booking Primus booking.
 * @return {string}
 */
function customerNameFromBooking(booking) {
  const party = resolveBillToParty(booking);
  if (!party) return "";
  return String(
      party.name || party.companyName || party.company ||
      party.customerName || "",
  ).trim();
}

/**
 * Quote-approval drive file ids (by fileType and/or filename).
 * @param {object} docData getBookingDocuments JSON body.
 * @param {string|number|null} [quoteApprovalFileTypeId] Optional type id.
 * @return {string[]}
 */
function listQuoteApprovalDriveFileIds(docData, quoteApprovalFileTypeId) {
  const ids = [];
  const wantType = quoteApprovalFileTypeId != null ?
    String(quoteApprovalFileTypeId) : null;
  for (const list of collectDocumentListArrays(docData)) {
    for (const f of list) {
      const driveId = readDriveFileId(f);
      if (!driveId) continue;
      const ft = readFileTypeId(f);
      const name = String(
          f.name || f.fileName || f.description || f.fileDescription || "",
      ).toUpperCase();
      const isType = wantType && ft === wantType;
      const nameLooks = /QUOTE\s*APPROVAL|APPROVED\s*QUOTE|QUOTE\s*APPROV/
          .test(name);
      if (isType || nameLooks) ids.push(driveId);
    }
  }
  return [...new Set(ids)];
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
    fileDescription: "",
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
 * @param {Buffer|Uint8Array|null} a
 * @param {Buffer|Uint8Array|null} b
 * @return {boolean}
 */
function buffersEqual(a, b) {
  if (!a || !b || !a.length || !b.length) return false;
  if (a.length !== b.length) return false;
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

/**
 * Uploads a PDF if provided and not already on the booking.
 * @param {object} args docData, bookingId, bookingBOL, fileType, file, skip,
 *   forbiddenBuffer — reject upload when file bytes match (e.g. POD=invoice)
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
  if (args.forbiddenBuffer &&
      buffersEqual(file.buffer, args.forbiddenBuffer)) {
    const msg = "Refusing upload: file bytes match carrier invoice PDF";
    if (writeLog) {
      await writeLog("error", "primus", msg, {
        fileType: args.fileType,
        fileTypeName: args.fileTypeName || null,
        filename: file.filename || null,
      });
    }
    return {ok: false, error: msg, fileType: args.fileType};
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

const DEFAULT_EMAIL_DOCS_BODY = defaultPrimusEmailDocsBody();

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
exports.resolveManageBookingId = resolveManageBookingId;

/**
 * Fetches all corporate sales people from manage.php (includes commission %).
 * @return {Promise<Array<object>>}
 */
async function fetchAllCorporateSalesPeople() {
  const all = [];
  let start = 0;
  const limit = 100;
  for (let page = 1; page <= 20; page++) {
    const result = await managePhpPost({
      action: "getCorporateSalesPeople",
      page: String(page),
      start: String(start),
      limit: String(limit),
    });
    const rows = result.json && result.json.salespeople;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) break;
    all.push(...list);
    if (list.length < limit) break;
    start += limit;
  }
  return all;
}
exports.fetchAllCorporateSalesPeople = fetchAllCorporateSalesPeople;

/**
 * Reads sales reps assigned to a booking (manage.php booking id).
 * @param {string|number} recordId manage.php booking id.
 * @return {Promise<Array<object>>}
 */
async function getBookingSalesRep(recordId) {
  if (!recordId) return [];
  const result = await managePhpPost({
    action: "getBookingSalesRep",
    recordId: String(recordId),
  });
  const reps = result.json && result.json.salesReps;
  return Array.isArray(reps) ? reps : [];
}
exports.getBookingSalesRep = getBookingSalesRep;

/**
 * @param {*} v Raw value.
 * @return {string}
 */
function manageStr(v) {
  if (v == null) return "";
  return String(v);
}

/**
 * @param {*} v Raw value.
 * @param {number} [fallback=0]
 * @return {number}
 */
function manageNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {*} v Raw value.
 * @return {boolean}
 */
function manageBool(v) {
  return v === true || v === 1 || v === "1" || v === "true";
}

/**
 * @param {*} v Raw value.
 * @return {string}
 */
function manageNullableTime(v) {
  return manageStr(v);
}

/**
 * @param {*} v Raw value.
 * @return {string}
 */
function manageUiBool(v) {
  return manageBool(v) ? "true" : "false";
}

/**
 * Formats a booking date for saveBooking (UI sends YYYY-MM-DD).
 * @param {*} v Primary date from getBooking.
 * @param {*} [fallback] Alternate source (e.g. dateSaved, dateDelivered).
 * @return {string}
 */
function manageSaveDate(v, fallback) {
  const candidates = [v, fallback];
  for (const raw of candidates) {
    const s = manageStr(raw).trim();
    if (!s || s.startsWith("0000-00-00")) continue;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const us = s.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
    if (us) return `20${us[3]}-${us[1]}-${us[2]}`;
    return s;
  }
  return "";
}

/**
 * Rated/invoiced bookings carry quoteIdActual or totalActual on getBooking.
 * @param {object} b bookingData from getBooking.
 * @return {boolean}
 */
function bookingHasRatedActual(b) {
  if (!b) return false;
  const qid = b.quoteIdActual;
  if (qid != null && String(qid).trim() !== "" && String(qid) !== "0") {
    return true;
  }
  const total = b.totalActual;
  return total != null && String(total).trim() !== "" && String(total) !== "0";
}

/**
 * @param {object} b bookingData from getBooking.
 * @return {object}
 */
function buildRatedActualFields(b) {
  const src = b || {};
  return {
    linearFeet: manageStr(src.linearFeet),
    totalDensityEstimated: manageStr(src.totalDensityEstimated),
    UOMActual: manageStr(src.UOMActual || src.UOM || "US"),
    piecesActual: manageStr(src.piecesActual),
    totalWeightActual: manageStr(src.totalWeightActual),
    totalDensityActual: manageStr(src.totalDensityActual),
    accessorialsActual: manageStr(src.accessorialsActual || "[]"),
    accessorialsLTLActual: manageStr(src.accessorialsLTLActual || "[]"),
    carrierIdActual: manageStr(src.carrierIdActual),
    carrierTypeIdActual: manageStr(src.carrierTypeIdActual),
    quoteIdActual: manageStr(src.quoteIdActual),
    carrierNameActual: manageStr(src.carrierNameActual),
    providerCarrierActual: manageStr(src.providerCarrierActual),
    carrierSCACActual: manageStr(src.carrierSCACActual),
    quoteNumberActual: manageStr(src.quoteNumberActual),
    extraInfoActual: manageStr(src.extraInfoActual),
    serviceLevelActual: manageStr(src.serviceLevelActual),
    serviceLevelCodeActual: manageStr(src.serviceLevelCodeActual),
    transitDaysActual: manageStr(src.transitDaysActual),
    totalActual: manageStr(src.totalActual),
    carrierBOLNotesActual: manageStr(
        src.carrierBOLNotesActual || src.BOLNotes || src.carrierBOLNotes),
    warningsActual: manageStr(src.warningsActual ?? src.warnings),
    quoteBillToActual: manageStr(src.quoteBillToActual || "[]"),
    breakdownActual: manageStr(src.breakdownActual),
    customAccessorialsBreakdownActual:
      manageStr(src.customAccessorialsBreakdownActual || "[]"),
    saveActualQuote: manageUiBool(src.saveActualQuote),
  };
}

/**
 * Fetches full booking form data from manage.php getBooking.
 * @param {string|number} bookingId manage.php booking id.
 * @return {Promise<object>}
 */
async function fetchManageBooking(bookingId) {
  if (!bookingId) return {ok: false, error: "missing bookingId"};
  const result = await managePhpPost({
    action: "getBooking",
    id: String(bookingId),
  });
  const booking = result.json && result.json.bookingData;
  if (!isManageSuccess(result.json) || !booking) {
    return {
      ok: false,
      error: (result.json && result.json.message) ||
        result.text ||
        "getBooking failed",
      response: result.json || null,
    };
  }
  return {ok: true, booking};
}
exports.fetchManageBooking = fetchManageBooking;

/**
 * Builds manage.php saveBooking params from getBooking data + sales rep.
 * @param {object} booking bookingData from getBooking.
 * @param {object} repRow Target corporate sales person row.
 * @return {object}
 */
function buildSaveBookingParams(booking, repRow) {
  const b = booking || {};
  const repId = String(repRow.id || repRow.salesPersonId || "");
  const repName = repRow.display ||
    `${repRow.firstName || ""} ${repRow.lastName || ""}`.trim();
  const rated = bookingHasRatedActual(b);
  const customerSlId = b.billTo === "T" ?
    manageStr(b.thirdPartyShippingLocationId) :
    manageStr(b.thirdPartyShippingLocationId || b.customerId);

  const params = {
    origin: "BOLForm",
    action: "saveBooking",
    actionEnvironment: "Primus",
    editedFrom: "Trackings Lookup Primus",
    bookingId: manageStr(b.id),
    vendorQuoteId: manageStr(b.vendorQuoteId || "0"),
    shipperName: manageStr(b.shipperName),
    shipperReferenceNumber: manageStr(b.shipperReferenceNumber),
    shipperAddress1: manageStr(b.shipperAddress1),
    shipperAddress2: manageStr(b.shipperAddress2),
    shipperCountry: manageStr(b.shipperCountry),
    shipperUNLOCode: manageStr(b.shipperUNLOCode),
    shipperUNLOCodeCity: manageStr(b.shipperUNLOCodeCity),
    shipperZipcode: manageStr(b.shipperZipcode),
    shipperCity: manageStr(b.shipperCity),
    shipperState: manageStr(b.shipperState),
    shipperCityAlias: manageStr(b.shipperCityAlias),
    shipperIATA: manageStr(b.shipperIATA),
    shipperShippingLocationId: manageStr(b.shipperShippingLocationId),
    shipperPhone: manageStr(b.shipperPhone),
    shipperFax: manageStr(b.shipperFax),
    shipperEmail: manageStr(b.shipperEmail),
    shipperContact: manageStr(b.shipperContact),
    shipperContactPhone: manageStr(b.shipperContactPhone),
    consigneeName: manageStr(b.consigneeName),
    consigneeReferenceNumber: manageStr(b.consigneeReferenceNumber),
    consigneeAddress1: manageStr(b.consigneeAddress1),
    consigneeAddress2: manageStr(b.consigneeAddress2),
    consigneeCountry: manageStr(b.consigneeCountry),
    consigneeUNLOCode: manageStr(b.consigneeUNLOCode),
    consigneeUNLOCodeCity: manageStr(b.consigneeUNLOCodeCity),
    consigneeZipcode: manageStr(b.consigneeZipcode),
    consigneeCity: manageStr(b.consigneeCity),
    consigneeState: manageStr(b.consigneeState),
    consigneeCityAlias: manageStr(b.consigneeCityAlias),
    consigneeIATA: manageStr(b.consigneeIATA),
    consigneeShippingLocationId: manageStr(b.consigneeShippingLocationId),
    consigneePhone: manageStr(b.consigneePhone),
    consigneeFax: manageStr(b.consigneeFax),
    consigneeEmail: manageStr(b.consigneeEmail),
    consigneeContact: manageStr(b.consigneeContact),
    consigneeContactPhone: manageStr(b.consigneeContactPhone),
    thirdPartyName: manageStr(b.thirdPartyName),
    thirdPartyReferenceNumber: manageStr(b.thirdPartyReferenceNumber),
    thirdPartyAddress1: manageStr(b.thirdPartyAddress1),
    thirdPartyAddress2: manageStr(b.thirdPartyAddress2),
    thirdPartyCountry: manageStr(b.thirdPartyCountry),
    thirdPartyZipcode: manageStr(b.thirdPartyZipcode),
    thirdPartyCity: manageStr(b.thirdPartyCity),
    thirdPartyState: manageStr(b.thirdPartyState),
    thirdPartyCityAlias: manageStr(b.thirdPartyCityAlias),
    thirdPartyShippingLocationId: manageStr(b.thirdPartyShippingLocationId),
    thirdPartyPhone: manageStr(b.thirdPartyPhone),
    thirdPartyFax: manageStr(b.thirdPartyFax),
    thirdPartyEmail: manageStr(b.thirdPartyEmail),
    thirdPartyContact: manageStr(b.thirdPartyContact),
    thirdPartyContactPhone: manageStr(b.thirdPartyContactPhone),
    billTo: manageStr(b.billTo || "T"),
    pickupType: manageStr(b.pickupType),
    pickupDate: rated ?
      manageSaveDate(b.pickupDate, b.pickupDateRaw || b.dateSaved) :
      manageStr(b.pickupDate),
    pickupTimeFrom: manageNullableTime(b.pickupTimeFrom),
    pickupTimeTo: manageNullableTime(b.pickupTimeTo),
    pickupAptChecked: manageNum(b.pickupAptChecked),
    pickupAptDate: manageStr(b.pickupAptDate),
    pickupAptTime: manageStr(b.pickupAptTime),
    pickupAptNumber: manageStr(b.pickupAptNumber),
    pickupAptContact: manageStr(b.pickupAptContact),
    pickupAptNotes: manageStr(b.pickupAptNotes),
    deliveryType: manageStr(b.deliveryType),
    deliveryDate: rated ?
      manageSaveDate(b.deliveryDate, b.deliveryDateRaw || b.dateDelivered) :
      manageStr(b.deliveryDate),
    deliveryTimeFrom: manageNullableTime(b.deliveryTimeFrom),
    deliveryTimeTo: manageNullableTime(b.deliveryTimeTo),
    deliveryAptChecked: manageNum(b.deliveryAptChecked),
    deliveryAptDate: manageStr(b.deliveryAptDate),
    deliveryAptTime: manageStr(b.deliveryAptTime),
    deliveryAptNumber: manageStr(b.deliveryAptNumber),
    deliveryAptContact: manageStr(b.deliveryAptContact),
    deliveryAptNotes: manageStr(b.deliveryAptNotes),
    printOnBOL: rated ?
      manageUiBool(b.printOnBOL) :
      (manageBool(b.printOnBOL) ? 1 : 0),
    brokerCompany: manageStr(b.brokerCompany),
    brokerContact: manageStr(b.brokerContact),
    brokerPhone: manageStr(b.brokerPhone),
    brokerNotes: manageStr(b.brokerNotes),
    BOLPredefined: manageStr(b.BOLPredefined),
    BOLNotes: manageStr(b.BOLNotes),
    notesInternal: manageStr(b.notesInternal),
    notesExternal: manageStr(b.notesExternal),
    UOM: manageStr(b.UOM || "US"),
    pieces: manageStr(b.pieces),
    totalWeight: manageNum(b.totalWeight),
    totalPieces: manageNum(b.totalPieces),
    customerQuoteId: manageStr(b.customerQuoteId || "0"),
    accessorials: manageStr(b.accessorials || "[]"),
    accessorialsLTL: manageStr(b.accessorialsLTL || "[]"),
    carrierId: manageNum(b.carrierId),
    carrierTypeId: manageNum(b.carrierTypeId),
    carrierSCAC: manageStr(b.carrierSCAC),
    quoteNumber: manageStr(b.quoteNumber),
    extraInfo: manageStr(b.extraInfo),
    quoteId: manageNum(b.quoteId),
    transitDays: manageStr(b.transitDays) === "0" ?
      "" : manageStr(b.transitDays),
    total: manageNum(b.total),
    customAccessorialsTotal: manageNum(b.customAccessorialsTotal),
    breakdown: manageStr(b.breakdown || "{}"),
    customAccessorialsBreakdown:
      manageStr(b.customAccessorialsBreakdown || "[]"),
    warnings: rated ? manageStr(b.warnings) : [],
    quoteBillTo: rated ? manageStr(b.quoteBillTo || "[]") : "[]",
    carrierBOLNotes: manageStr(b.carrierBOLNotes),
    providerCarrier: manageStr(b.providerCarrier),
    carrierName: manageStr(b.carrierName),
    serviceLevel: manageStr(b.serviceLevel),
    serviceLevelCode: manageStr(b.serviceLevelCode),
    saveQuote: rated ? manageUiBool(b.saveQuote) : 0,
    fromApplet: rated ?
      manageUiBool(b.fromApplet) :
      (manageBool(b.fromApplet) ? 1 : 0),
    shipmentClassification: manageStr(b.shipmentClassification || "0"),
    serviceType: rated ?
      (manageStr(b.serviceType) === "0" ? "" : manageStr(b.serviceType)) :
      manageNum(b.serviceType, 1),
    stopsCount: manageNum(b.stopsCount),
    equipmentIds: manageStr(b.equipmentIds || "[]"),
    equipmentLength: manageNum(b.equipmentLength),
    autoCalculatedLNFT: rated ?
      manageUiBool(b.autoCalculatedLNFT !== false) :
      1,
    stopsInfo: "[]",
    shipperShowName: manageStr(b.shipperShowName),
    shipperVenueName: manageStr(b.shipperVenueName),
    shipperBooth: manageStr(b.shipperBooth),
    consigneeShowName: manageStr(b.consigneeShowName),
    consigneeVenueName: manageStr(b.consigneeVenueName),
    consigneeBooth: manageStr(b.consigneeBooth),
    bookingSalesRepId: `[${repId}]`,
    bookingSalesRepNames: repName,
    officeId: manageNum(b.officeId),
    bookingOfficeName: manageStr(b.bookingOfficeName || "ALL - Systemwide"),
    billToData: b.billToData == null ? "null" : manageStr(b.billToData),
    additionalInfo: manageStr(b.additionalInfo || "{}"),
    laneDistance: manageStr(b.laneDistance),
    controlledBy: manageNum(b.controlledBy),
    addInsurance: rated ?
      manageUiBool(b.addInsurance) :
      (manageBool(b.addInsurance) ? 1 : 0),
    insuranceAmount: manageStr(b.insuranceAmount || "0"),
    controlledByName: manageStr(b.controlledByName),
    modeName: manageStr(b.modeName || "LTL"),
    copyBOLInvoicesCosts: rated ? manageUiBool(b.copyBOLInvoicesCosts) : 0,
  };

  if (rated) {
    Object.assign(params, buildRatedActualFields(b));
  } else {
    params.bookingBOL = manageStr(b.BOL);
    params.customerId = customerSlId;
    params.dispatched = manageNum(b.dispatched);
  }

  return params;
}
exports.buildSaveBookingParams = buildSaveBookingParams;

/**
 * Swaps a load's sales rep via manage.php saveBooking (full booking save).
 * @param {object} args
 * @param {string|number} args.bookingId manage.php booking id.
 * @param {object} args.tenPctRow Row from getCorporateSalesPeople.
 * @param {Array<object>} [args.removedReps] Ignored; call-site compat.
 * @return {Promise<object>}
 */
async function swapBookingSalesRep(args) {
  const bookingId = args && args.bookingId ?
    String(args.bookingId) : "";
  const tenPctRow = args && args.tenPctRow;
  if (!bookingId || !tenPctRow || !tenPctRow.id) {
    return {ok: false, error: "missing bookingId or tenPctRow"};
  }

  const fetchResult = await fetchManageBooking(bookingId);
  if (!fetchResult.ok) {
    return {
      ok: false,
      error: fetchResult.error,
      response: fetchResult.response || null,
    };
  }

  const booking = fetchResult.booking;
  const slId = booking.thirdPartyShippingLocationId || booking.customerId;
  await managePhpPost({
    action: "checkCustomerBOLLocked",
    bookingId,
    SLId: String(slId || ""),
  });
  await managePhpPost({action: "getBooking", id: bookingId});
  await managePhpPost({action: "getBookingSalesRep", recordId: bookingId});

  const params = buildSaveBookingParams(booking, tenPctRow);
  const result = await managePhpPost(params);
  if (!isManageSuccess(result.json)) {
    return {
      ok: false,
      error: (result.json && result.json.message) ||
        result.text ||
        "saveBooking failed",
      response: result.json || null,
      rawText: result.text || null,
    };
  }

  const after = await getBookingSalesRep(bookingId);
  const changed = after.some((rep) =>
    String(rep.salesPersonId) === String(tenPctRow.id));
  return {
    ok: changed,
    after,
    response: result.json || null,
    error: changed ? null : "sales rep unchanged after save",
  };
}
exports.swapBookingSalesRep = swapBookingSalesRep;

/**
 * Fetches shipment rows from manage.php getBookingsForTracking (paginated).
 * @param {object} [opts]
 * @param {Date|string} [opts.dateFrom] Start of dateSaved window.
 * @param {Date|string} [opts.dateTo] End of dateSaved window.
 * @param {number} [opts.pageSize] Page size (default 100).
 * @param {number} [opts.maxPages] Safety cap (default 50).
 * @return {Promise<Array<object>>}
 */
async function fetchBookingsForTracking(opts) {
  const pageSize = Number(opts && opts.pageSize || 100);
  const maxPages = Number(opts && opts.maxPages || 120);
  const dateTo = opts && opts.dateTo ? new Date(opts.dateTo) : new Date();
  const dateFrom = opts && opts.dateFrom ?
    new Date(opts.dateFrom) :
    new Date(dateTo.getTime() - 180 * 24 * 60 * 60 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);

  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const start = page * pageSize;
    const params = {
      action: "getBookingsForTracking",
      page: String(page + 1),
      query: "",
      forcelimit: "",
      dateFrom: iso(dateFrom),
      dateTo: iso(dateTo),
      criteria: "[]",
      user: "null",
      shipmentMode: "null",
      searchFields: "[]",
      customer: "[]",
      office: "[]",
      start: String(start),
      limit: String(pageSize),
      sort: JSON.stringify([{property: "dateSaved", direction: "DESC"}]),
    };
    let result = await managePhpPost(params);
    let rows = result.json && result.json.bookingsfortracking;
    let list = Array.isArray(rows) ? rows : [];
    if (!list.length && page === 0) {
      await loginUi();
      result = await managePhpPost(params, false);
      rows = result.json && result.json.bookingsfortracking;
      list = Array.isArray(rows) ? rows : [];
    }
    if (page > 0 && !list.length) {
      await loginUi();
      result = await managePhpPost(params, false);
      rows = result.json && result.json.bookingsfortracking;
      list = Array.isArray(rows) ? rows : [];
    }
    if (!list.length) break;
    all.push(...list);
    if (list.length < pageSize) break;
  }
  return all;
}
exports.fetchBookingsForTracking = fetchBookingsForTracking;

/**
 * Searches manage.php getBookingsForTracking by free-text query (FBA ref,
 * shipper ref, BOL fragment, etc.).
 * @param {string} query Search text.
 * @param {object} [opts] dateFrom, dateTo, limit.
 * @return {Promise<Array<object>>}
 */
async function searchBookingsForTrackingQuery(query, opts = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const dateTo = opts.dateTo ? new Date(opts.dateTo) : new Date();
  const dateFrom = opts.dateFrom ?
    new Date(opts.dateFrom) :
    new Date(dateTo.getTime() - 365 * 24 * 60 * 60 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const limit = Number(opts.limit || 25);
  const result = await managePhpPost({
    action: "getBookingsForTracking",
    page: "1",
    query: q,
    forcelimit: "",
    dateFrom: iso(dateFrom),
    dateTo: iso(dateTo),
    criteria: "[]",
    user: "null",
    shipmentMode: "[]",
    searchFields: "[]",
    customer: "[]",
    office: "[]",
    start: "0",
    limit: String(limit),
    sort: JSON.stringify([{property: "dateSaved", direction: "DESC"}]),
  });
  const rows = result.json && result.json.bookingsfortracking;
  return Array.isArray(rows) ? rows : [];
}
exports.searchBookingsForTrackingQuery = searchBookingsForTrackingQuery;

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
 * @param {object} file Single document row from getBookingDocuments.
 * @return {string|null} fileType id as string, or null.
 */
function readFileTypeId(file) {
  if (!file || typeof file !== "object") return null;
  const ft = file.fileType != null ? file.fileType :
    (file.fileTypeId != null ? file.fileTypeId : file.type);
  return ft != null ? String(ft) : null;
}

/**
 * Drive file ids on a booking that belong to a specific fileType.
 * Used to identify carrier-bill documents so they are NEVER emailed to a
 * customer (carrier cost must never reach the customer). This is the
 * deterministic firewall — it does not depend on filename or text scanning.
 * @param {object} docData getBookingDocuments JSON body.
 * @param {string|number} fileTypeId fileType id to match.
 * @return {string[]}
 */
function listFileTypeDriveIds(docData, fileTypeId) {
  if (fileTypeId == null) return [];
  const want = String(fileTypeId);
  const ids = [];
  for (const list of collectDocumentListArrays(docData)) {
    for (const f of list) {
      const driveId = readDriveFileId(f);
      if (!driveId) continue;
      if (readFileTypeId(f) === want) ids.push(driveId);
    }
  }
  return [...new Set(ids)];
}

/**
 * POD drive file ids from getBookingDocuments (by fileType or name).
 * @param {object} docData getBookingDocuments JSON body.
 * @param {string|number} [podFileTypeId] POD fileType id from getFileTypes.
 * @param {string|number} [excludeFileTypeId] Carrier-bill type to hard-exclude.
 * @return {string[]}
 */
function listPodDriveFileIds(docData, podFileTypeId, excludeFileTypeId) {
  const ids = [];
  const podTypeId = podFileTypeId != null ? String(podFileTypeId) : null;
  const excludeTypeId = excludeFileTypeId != null ?
    String(excludeFileTypeId) : null;
  for (const list of collectDocumentListArrays(docData)) {
    for (const f of list) {
      const driveId = readDriveFileId(f);
      if (!driveId) continue;
      const ft = readFileTypeId(f);
      // Firewall: never treat the carrier bill as a POD, no matter its name.
      if (excludeTypeId && ft === excludeTypeId) continue;
      const name = String(
          f.name || f.fileName || f.description || f.fileDescription || "",
      ).toUpperCase();
      const isPodType = podTypeId && ft === podTypeId;
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
 * @param {object} [opts] podFileTypeId — always include this file type;
 *   excludeFileTypeId — carrier-bill type to hard-exclude even if external.
 * @return {string[]}
 */
function listCustomerDriveFileIds(docData, opts = {}) {
  const ids = [];
  const podTypeId = opts.podFileTypeId != null ?
    String(opts.podFileTypeId) : null;
  const excludeTypeId = opts.excludeFileTypeId != null ?
    String(opts.excludeFileTypeId) : null;
  for (const list of collectDocumentListArrays(docData)) {
    for (const f of list) {
      const driveId = readDriveFileId(f);
      if (!driveId) continue;
      const ft = readFileTypeId(f);
      // Firewall: the carrier bill is never customer-visible, even if some
      // Primus flag marks it external. Skip before any inclusion rule.
      if (excludeTypeId && ft === excludeTypeId) continue;
      const isExternal = f.external === "1" || f.external === 1 ||
        f.isExternal === true || f.isExternal === "1";
      if (podTypeId && ft === podTypeId) {
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
 * Resolves POD (+ Miworld quote-approval) drive file ids for email-docs-drive.
 * @param {object} args booking, loadNumber, podPdf, extraDriveFileIds,
 *   customerName
 * @return {Promise<object>}
 */
async function resolvePodDriveIdsForEmail(args) {
  const booking = args.booking;
  const loadNumber = args.loadNumber;
  const customerName = args.customerName || customerNameFromBooking(booking);
  const miworld = isMiworldCustomer(customerName);
  const uploadFileTypes = await resolveUploadFileTypes();
  const podFileTypeId = uploadFileTypes.pod.id;
  const carrierBillTypeId = uploadFileTypes.carrierBill.id;
  const quoteApprovalTypeId = uploadFileTypes.quoteApproval &&
      uploadFileTypes.quoteApproval.id ?
    uploadFileTypes.quoteApproval.id : null;
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
    listPodDriveFileIds(docData, podFileTypeId, carrierBillTypeId) : [];

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
        ...listPodDriveFileIds(docData, podFileTypeId, carrierBillTypeId),
      ])];
    }
  } else if (!podDriveIds.length && docData) {
    // Do not fall back to arbitrary customer-visible drive files —
    // that can email the wrong document or proceed with no real POD.
    podDriveIds = listPodDriveFileIds(
        docData, podFileTypeId, carrierBillTypeId);
  }

  let quoteApprovalDriveIds = [];
  if (miworld && docData) {
    quoteApprovalDriveIds = listQuoteApprovalDriveFileIds(
        docData, quoteApprovalTypeId);
    if (!quoteApprovalDriveIds.length && writeLog) {
      await writeLog("warn", "primus",
          "Miworld invoice email — quote approval doc not found on load", {
            loadNumber,
            bookingId,
            customerName,
            quoteApprovalTypeId,
          });
    } else if (quoteApprovalDriveIds.length && writeLog) {
      await writeLog("info", "primus",
          "Miworld invoice email — including quote approval attachment(s)", {
            loadNumber,
            bookingId,
            customerName,
            quoteApprovalDriveIds,
            quoteApprovalTypeId,
          });
    }
  }

  // FINAL FIREWALL: whatever ended up in the list (including caller-supplied
  // extraDriveFileIds and freshly uploaded ids), drop anything that Primus
  // reports as the carrier-bill file type. The carrier cost must NEVER be
  // emailed to a customer. If we drop something here it is a real incident —
  // log it at error level so it surfaces immediately.
  const carrierBillDriveIds = new Set(
      listFileTypeDriveIds(docData, carrierBillTypeId));
  const blocked = [];
  const safePodIds = [];
  for (const id of podDriveIds) {
    if (carrierBillDriveIds.has(String(id))) {
      blocked.push(String(id));
    } else {
      safePodIds.push(id);
    }
  }
  const safeQuoteIds = [];
  for (const id of quoteApprovalDriveIds) {
    if (carrierBillDriveIds.has(String(id))) {
      blocked.push(String(id));
    } else {
      safeQuoteIds.push(id);
    }
  }
  if (blocked.length && writeLog) {
    await writeLog("error", "primus",
        "BLOCKED carrier-bill document from customer email attachments", {
          loadNumber,
          bookingId,
          carrierBillTypeId,
          blockedDriveFileIds: blocked,
        });
  }

  return {
    podDriveIds: safePodIds,
    quoteApprovalDriveIds: safeQuoteIds,
    driveFileIds: [...new Set([...safePodIds, ...safeQuoteIds])],
    blockedDriveFileIds: blocked,
    miworld,
    customerName,
  };
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

  const {
    podDriveIds,
    quoteApprovalDriveIds,
    driveFileIds: resolvedDriveIds,
    blockedDriveFileIds,
    miworld,
    customerName: resolvedCustomerName,
  } = await resolvePodDriveIdsForEmail({
    booking,
    loadNumber,
    podPdf: args.podPdf,
    customerName: args.customerName || null,
    extraDriveFileIds: [
      ...(args.extraDriveFileIds || []),
      ...(Array.isArray(args.driveFileIds) ? args.driveFileIds : []),
    ],
  });

  const driveFileIds = [...new Set(resolvedDriveIds || podDriveIds || [])];
  if (!podDriveIds || !podDriveIds.length) {
    return {
      ok: false,
      error: "No POD document on Primus — customer email blocked",
      driveFileIds: [],
      blockedDriveFileIds: blockedDriveFileIds || [],
      attachments: {
        invoiceSelected: true,
        bolSelected: true,
        podDriveIdsSelected: [],
        quoteApprovalDriveIdsSelected: quoteApprovalDriveIds || [],
        miworld: !!miworld,
        customerName: resolvedCustomerName || null,
        blockedCarrierBillDriveIds: blockedDriveFileIds || [],
        customerInvoiceId: String(customerInvoiceId),
        invoiceNumber,
      },
    };
  }

  const subject = toOutboundEmailSafeSubject(
      args.subject || `Invoice for BOL#${loadNumber}`);
  const customBody = process.env.PRIMUS_UI_EMAIL_DOCS_BODY;
  const bodyRaw = customBody ?
    (customBody.includes("cardknox.com/innovativecarriers") ?
      customBody :
      appendCustomerInvoiceEmailSignature(customBody)) :
    DEFAULT_EMAIL_DOCS_BODY;
  const body = toOutboundEmailSafeText(bodyRaw);
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
  // UI checkbox(es): attach POD / quote approval / customer drive file(s)
  for (const driveId of driveFileIds) {
    params[`email-docs-drive-${driveId}`] = "on";
  }

  const result = await managePhpPost(params);
  const success = isEmailBOLDocsSuccess(result.json);
  const attachments = {
    invoiceSelected: true,
    bolSelected: true,
    podDriveIdsSelected: podDriveIds || [],
    quoteApprovalDriveIdsSelected: quoteApprovalDriveIds || [],
    miworld: !!miworld,
    customerName: resolvedCustomerName || null,
    blockedCarrierBillDriveIds: blockedDriveFileIds || [],
    customerInvoiceId: String(customerInvoiceId),
    invoiceNumber,
  };
  return {
    ok: success,
    json: result.json,
    status: result.status,
    driveFileIds,
    blockedDriveFileIds: blockedDriveFileIds || [],
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
 * Sends POD document(s) from Primus to a recipient (no customer invoice).
 * Uses manage.php emailBOLDocs with only POD drive file checkboxes.
 * @param {object} args booking, loadNumber, recipientEmail, subject, body
 * @return {Promise<object>}
 */
async function emailPodDocs(args) {
  if (!isManagePhpEnabled()) {
    return {ok: false, skipped: true, reason: "PRIMUS_USE_MANAGE_PHP off"};
  }
  const booking = args.booking;
  if (!booking || !booking.BOLId) {
    return {ok: false, error: "Booking missing BOLId"};
  }
  const recipientEmail = args.recipientEmail;
  if (!recipientEmail) {
    return {ok: false, error: "No recipient email"};
  }
  const loadNumber = args.loadNumber || booking.BOLNbr || booking.bolNumber;
  if (!loadNumber) {
    return {ok: false, error: "No load number"};
  }

  const {quoteId, customerQuoteId} = resolveBookingQuoteIds(booking);
  const {
    podDriveIds,
    blockedDriveFileIds,
    customerName: resolvedCustomerName,
  } = await resolvePodDriveIdsForEmail({
    booking,
    loadNumber,
    podPdf: args.podPdf || null,
    customerName: args.customerName || null,
    extraDriveFileIds: args.extraDriveFileIds || [],
  });

  if (!podDriveIds || !podDriveIds.length) {
    return {
      ok: false,
      error: "No POD document on Primus",
      blockedDriveFileIds: blockedDriveFileIds || [],
    };
  }

  const manageBookingId = resolveManageBookingId(booking);
  if (!manageBookingId) {
    return {ok: false, error: "Could not resolve manage.php bookingId"};
  }

  const fromAddr = process.env.PRIMUS_UI_EMAIL_FROM ||
    "accounting@innovativecarriers.com";
  const subject = toOutboundEmailSafeSubject(
      args.subject || `Proof of Delivery - Load #${loadNumber}`);
  const body = toOutboundEmailSafeText(args.body ||
    (`<p>Please find the Proof of Delivery for load ` +
    `<strong>#${loadNumber}</strong> attached.</p>` +
    `<p>Thank you,<br>Innovative Carriers Accounting</p>`));

  const params = {
    action: "emailBOLDocs",
    bookingId: manageBookingId,
    quoteId: String(quoteId || 0),
    invoiceId: "0",
    invoiceNumber: "0",
    invoices: [],
    customerQuoteId: String(customerQuoteId || 0),
    fromApplet: "false",
    consolidate: "true",
    bookingCreateSingleFile: "false",
    bookingBOL: String(loadNumber),
  };
  params["email-docs-from"] = fromAddr;
  params["email-docs-to"] = recipientEmail;
  params["email-docs-subject"] = subject;
  params["email-docs-body"] = body;
  for (const driveId of podDriveIds) {
    params[`email-docs-drive-${driveId}`] = "on";
  }

  const result = await managePhpPost(params);
  const success = isEmailBOLDocsSuccess(result.json);
  return {
    ok: success,
    json: result.json,
    status: result.status,
    driveFileIds: podDriveIds,
    blockedDriveFileIds: blockedDriveFileIds || [],
    to: recipientEmail,
    customerName: resolvedCustomerName || null,
    error: success ? null :
      ((result.json && result.json.message) ||
        (result.json && result.json.error) ||
        "emailPodDocs failed"),
    raw: !success ? (result.text || "").slice(0, 500) : undefined,
  };
}
exports.emailPodDocs = emailPodDocs;

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
 * @param {object} inv Invoice row from getBookingDocuments.
 * @return {boolean}
 */
function isIssuedUiInvoice(inv) {
  if (!inv) return false;
  const num = inv.invoiceNumber;
  return num != null && String(num) !== "" && String(num) !== "0";
}

/**
 * @param {object} inv Invoice row from getBookingDocuments.
 * @return {boolean}
 */
function isDraftUiInvoice(inv) {
  if (!inv || inv.id == null) return false;
  return !isIssuedUiInvoice(inv);
}

/**
 * @param {object} docData getBookingDocuments body.
 * @return {object|null}
 */
function findDraftUiInvoice(docData) {
  if (!docData || !Array.isArray(docData.invoices)) return null;
  const drafts = docData.invoices.filter(isDraftUiInvoice);
  if (drafts.length > 1 && writeLog) {
    writeLog("warn", "primus",
        "Multiple draft invoices on booking — reusing first", {
          draftIds: drafts.map((d) => d.id),
        }).catch(() => {});
  }
  return drafts.length ? drafts[0] : null;
}

/**
 * Issued invoice preferred; falls back to draft when adding costs.
 * @param {object} docData getBookingDocuments body.
 * @return {object|null}
 */
function findUiInvoice(docData) {
  if (!docData || !Array.isArray(docData.invoices) ||
      !docData.invoices.length) {
    return null;
  }
  const issued = docData.invoices.filter(isIssuedUiInvoice);
  if (issued.length) {
    return issued.sort(
        (a, b) => Number(b.invoiceNumber || 0) - Number(a.invoiceNumber || 0),
    )[0];
  }
  return findDraftUiInvoice(docData);
}

/**
 * @param {object} storeData getInvoiceStores response object.
 * @return {number|null}
 */
function extractBilltoIdFromStore(storeData) {
  if (!storeData || typeof storeData !== "object") return null;
  const candidates = [
    storeData.billtoId,
    storeData.billToId,
    storeData.data && storeData.data.billtoId,
    storeData.data && storeData.data.billToId,
    storeData.invoice && storeData.invoice.billtoId,
    storeData.invoice && storeData.invoice.billToId,
  ];
  for (const c of candidates) {
    if (c == null || String(c) === "" || String(c) === "0") continue;
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * REST invoice list for a load (drafts and issued).
 * @param {string|number} loadNumber BOL number.
 * @return {Promise<Array<object>>}
 */
async function fetchRestInvoicesByLoad(loadNumber) {
  const base = process.env.PRIMUS_BASE_URL;
  if (!base || loadNumber == null) return [];
  try {
    const login = await fetch(`${base}/login`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        username: process.env.PRIMUS_USERNAME,
        password: process.env.PRIMUS_PASSWORD,
      }),
    });
    const loginJson = await login.json();
    const token = loginJson && loginJson.data && loginJson.data.accessToken;
    if (!token) return [];
    const resp = await fetch(
        `${base}/invoice/bolnumber/${encodeURIComponent(loadNumber)}`,
        {headers: {Authorization: `Bearer ${token}`}},
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    const list = data && data.data && data.data.results;
    if (!Array.isArray(list)) return [];
    return list.filter((inv) => inv && inv.invoiceId);
  } catch (_) {
    return [];
  }
}

/**
 * REST drafts for idempotency when Primus UI is still syncing.
 * @param {string|number} loadNumber BOL number.
 * @return {Promise<Array<object>>}
 */
async function fetchRestDraftInvoices(loadNumber) {
  const list = await fetchRestInvoicesByLoad(loadNumber);
  return list.filter((inv) => !(inv.status && inv.status.generated));
}

/**
 * Issued customer invoice id for broker Profit % lookup (REST).
 * @param {string|number} loadNumber BOL number.
 * @return {Promise<string|null>}
 */
async function resolveIssuedInvoiceIdForLoad(loadNumber) {
  const list = await fetchRestInvoicesByLoad(loadNumber);
  if (!list.length) return null;
  const issued = list.find((inv) => inv.status && inv.status.generated);
  const pick = issued || list[0];
  return pick && pick.invoiceId ? String(pick.invoiceId) : null;
}

/**
 * REST invoice id for POST /quickbooks/billing — differs from manage.php id.
 * @param {string|number} loadNumber BOL number.
 * @param {string|number|null} uiInvoiceId manage.php customerInvoiceId.
 * @return {Promise<string|null>}
 */
async function resolveRestInvoiceIdForQuickBooks(loadNumber, uiInvoiceId) {
  const list = await fetchRestInvoicesByLoad(loadNumber);
  if (!list.length) {
    return uiInvoiceId != null ? String(uiInvoiceId) : null;
  }
  const issued = list.filter((inv) => inv.status && inv.status.generated);
  const pool = issued.length ? issued : list;
  if (uiInvoiceId != null) {
    const uiStr = String(uiInvoiceId);
    const direct = pool.find((inv) => String(inv.invoiceId) === uiStr);
    if (direct) return uiStr;
  }
  const sorted = [...pool].sort(
      (a, b) => Number(b.invoiceNumber || 0) - Number(a.invoiceNumber || 0));
  return sorted[0] && sorted[0].invoiceId ?
    String(sorted[0].invoiceId) : null;
}

/**
 * Picks an existing draft invoice id (UI docs, REST, or workflow state).
 * @param {object} args loadNumber, customerInvoiceId, bookingDocData
 * @return {Promise<object>} id and source
 */
async function resolveExistingDraftInvoiceId(args) {
  const seen = new Set();
  const add = (id, source) => {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0 || seen.has(n)) return null;
    seen.add(n);
    return {id: n, source};
  };

  if (args.customerInvoiceId) {
    const hit = add(args.customerInvoiceId, "workflow");
    if (hit) return hit;
  }

  const uiDraft = findDraftUiInvoice(args.bookingDocData);
  if (uiDraft) {
    const hit = add(uiDraft.id, "ui_documents");
    if (hit) return hit;
  }

  const restDrafts = await fetchRestDraftInvoices(args.loadNumber);
  for (const inv of restDrafts) {
    const hit = add(inv.invoiceId, "rest_api");
    if (hit) return hit;
  }

  return {id: null, source: null};
}

/**
 * @param {object} booking Primus booking from GET /book/bolnumber.
 * @return {number|null}
 */
function resolveBilltoId(booking) {
  const billTo = booking.billTo || "";
  if (billTo === "thirdparty" && booking.thirdParty &&
      booking.thirdParty.id != null) {
    return Number(booking.thirdParty.id);
  }
  if (booking.shipper && booking.shipper.id != null) {
    return Number(booking.shipper.id);
  }
  const locs = booking.shippingLocations;
  if (Array.isArray(locs) && locs[0] && locs[0].id != null) {
    return Number(locs[0].id);
  }
  if (booking.thirdParty && booking.thirdParty.id != null) {
    return Number(booking.thirdParty.id);
  }
  const override = process.env.PRIMUS_UI_BILLTO_ID;
  if (override) return Number(override);
  return null;
}

/**
 * Bill-to party on the booking (name/address used for customer lookup).
 * @param {object} booking Primus booking from GET /book/bolnumber.
 * @return {object|null}
 */
function resolveBillToParty(booking) {
  if (!booking || typeof booking !== "object") return null;
  const billTo = booking.billTo || "";
  if (billTo === "thirdparty" && booking.thirdParty) {
    return booking.thirdParty;
  }
  if (booking.shipper) return booking.shipper;
  if (booking.thirdParty) return booking.thirdParty;
  const locs = booking.shippingLocations;
  if (Array.isArray(locs) && locs[0]) return locs[0];
  return null;
}

/**
 * @param {string|undefined} value
 * @return {string}
 */
function normalizeLookupText(value) {
  return String(value || "").trim().toLowerCase();
}


/**
 * @param {string|undefined} value
 * @return {string}
 */
function normalizeCompanyName(value) {
  return normalizeLookupText(value)
      .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, " ")
      .replace(/\b(inc|llc|ltd|corp|corporation|co|company)\b\.?/g, "")
      .replace(/\s+/g, " ")
      .trim();
}

/**
 * Strips Primus location suffixes (e.g. JB/KA) for bill-to match.
 * @param {string} nameNorm Output of normalizeCompanyName.
 * @return {string}
 */
function baseCompanyNameForMatch(nameNorm) {
  return String(nameNorm || "")
      .replace(/\s+[a-z]{1,4}$/, "")
      .trim();
}

/**
 * Parenthetical suffix on a Primus location name, e.g. KA from
 * "Fleet Equipment LLC (KA)".
 * @param {string|undefined} name
 * @return {string}
 */
function locationNameSuffix(name) {
  const match = String(name || "").match(/\(([a-z0-9]{1,4})\)\s*$/i);
  return match ? match[1].toLowerCase() : "";
}

/**
 * @param {string} a
 * @param {string} b
 * @return {number}
 */
function editDistance(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  const n = s.length;
  const m = t.length;
  if (!n) return m;
  if (!m) return n;
  const prev = new Array(m + 1);
  const cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= m; j++) prev[j] = cur[j];
  }
  return prev[m];
}

/**
 * True when two company names are the same or one typo apart.
 * @param {string|undefined} a
 * @param {string|undefined} b
 * @return {boolean}
 */
function namesAreCloseForBillto(a, b) {
  const na = baseCompanyNameForMatch(normalizeCompanyName(a));
  const nb = baseCompanyNameForMatch(normalizeCompanyName(b));
  if (!na || !nb) return false;
  if (na === nb) return true;
  const max = Math.max(na.length, nb.length);
  if (max < 8) return false;
  return editDistance(na, nb) <= 1;
}

/**
 * Initials from a person name ("Karen Adams" → "ka").
 * @param {string|undefined} name
 * @return {string}
 */
function initialsFromPersonName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return "";
  const first = parts[0][0];
  const last = parts[parts.length - 1][0];
  if (!first || !last) return "";
  return (first + last).toLowerCase();
}

/**
 * Preferred (JB)/(KA) suffix from the booking's control user / sales rep.
 * @param {object} booking
 * @return {string}
 */
function preferredBilltoSuffixFromBooking(booking) {
  const info = booking && booking.contactInformation;
  const control = info && info.controlUser;
  const fromControl = initialsFromPersonName(control && control.name);
  if (fromControl) return fromControl;
  const sales = info && info.salesRep;
  const firstRep = Array.isArray(sales) ? sales[0] : sales;
  if (firstRep) {
    const fromRep = initialsFromPersonName(firstRep.name ||
      `${firstRep.firstName || ""} ${firstRep.lastName || ""}`);
    if (fromRep) return fromRep;
  }
  return "";
}

/**
 * When bill-to is a stub/typo (no id, no zip), copy name/zip from consignee
 * if the names are clearly the same customer.
 * @param {object} party
 * @param {object} booking
 * @return {object}
 */
function enrichBillToPartyFromConsignee(party, booking) {
  const consignee = booking && booking.consignee;
  if (!party || !consignee || !consignee.name) return party;
  const partyZip = String(party.zipCode || party.zipcode || "").trim();
  const partyIdMissing = party.id == null || party.id === "";
  if (!partyIdMissing && partyZip) return party;
  if (!namesAreCloseForBillto(party.name, consignee.name)) return party;
  return {
    ...party,
    name: String(consignee.name).trim(),
    zipCode: partyZip || consignee.zipCode || consignee.zipcode || "",
    zipcode: partyZip || consignee.zipcode || consignee.zipCode || "",
    city: party.city || consignee.city || "",
    state: party.state || consignee.state || "",
    email: party.email || consignee.email || "",
  };
}

/**
 * Search terms for manage.php / REST location lookup (strip Inc/LLC etc.).
 * @param {string} partyName Raw bill-to party name from booking.
 * @return {Array<string>}
 */
function buildShippingLocationSearchTerms(partyName) {
  const raw = String(partyName || "").trim();
  const terms = [];
  const add = (t) => {
    const q = String(t || "").trim();
    if (!q) return;
    if (!terms.some((x) => x.toLowerCase() === q.toLowerCase())) {
      terms.push(q);
    }
  };
  add(raw);
  const normalized = normalizeCompanyName(raw);
  if (normalized) add(normalized);
  const base = baseCompanyNameForMatch(normalized);
  if (base) add(base);
  return terms;
}

/**
 * @param {Array<object>} candidates
 * @param {string} preferredSuffix
 * @param {string} normZip
 * @return {number|null}
 */
function pickFromLocationCandidates(candidates, preferredSuffix, normZip) {
  if (!candidates.length) return null;
  let pool = candidates;
  if (preferredSuffix) {
    const suffixed = candidates.filter((row) =>
      locationNameSuffix(row.name) === preferredSuffix);
    if (suffixed.length) pool = suffixed;
  }
  if (pool.length > 1 && normZip) {
    const zipMatch = pool.find((row) =>
      normalizeLookupText(row.zipcode || row.zipCode) === normZip);
    if (zipMatch) return Number(zipMatch.id);
  }
  return Number(pool[0].id);
}

/**
 * @param {Array<object>} list manage.php shipping_locations rows.
 * @param {object} party Bill-to party from booking.
 * @param {object} [opts] preferredSuffix.
 * @return {number|null}
 */
function pickManageLocationFromList(list, party, opts) {
  if (!Array.isArray(list) || !list.length || !party) return null;
  const partyZip = String(party.zipCode || party.zipcode || "").trim();
  const partyName = normalizeLookupText(party.name);
  const partyBase = baseCompanyNameForMatch(normalizeCompanyName(party.name));
  const normZip = normalizeLookupText(partyZip);
  const preferredSuffix = opts && opts.preferredSuffix ?
    String(opts.preferredSuffix).toLowerCase() : "";

  const exactName = list.filter((row) =>
    normalizeLookupText(row.name) === partyName);
  if (exactName.length) {
    return pickFromLocationCandidates(exactName, preferredSuffix, normZip);
  }

  const baseMatches = list.filter((row) => {
    const rowNorm = normalizeCompanyName(row.name);
    const rowBase = baseCompanyNameForMatch(rowNorm);
    const partyNameNorm = normalizeCompanyName(party.name);
    if (rowNorm === partyNameNorm) return true;
    if (partyNameNorm && rowNorm.startsWith(partyNameNorm + " ")) return true;
    if (rowBase === partyBase) return true;
    return namesAreCloseForBillto(rowBase, partyBase);
  });
  if (baseMatches.length) {
    return pickFromLocationCandidates(baseMatches, preferredSuffix, normZip);
  }

  if (list.length === 1) return Number(list[0].id);
  if (normZip) {
    const zipOnly = list.filter((row) =>
      normalizeLookupText(row.zipcode || row.zipCode) === normZip);
    if (zipOnly.length === 1) return Number(zipOnly[0].id);
  }
  return null;
}

/**
 * Matches bill-to party against booking.shippingLocations.
 * @param {object} party Bill-to party.
 * @param {object} booking Primus booking.
 * @return {number|null}
 */
function resolveFromBookingShippingLocations(party, booking) {
  const locs = booking && booking.shippingLocations;
  if (!Array.isArray(locs) || !locs.length || !party) return null;
  const partyId = party.id != null ? String(party.id) : null;
  const partyNameNorm = normalizeCompanyName(party.name);
  for (const loc of locs) {
    if (partyId && loc.id != null && String(loc.id) === partyId) {
      return Number(loc.id);
    }
    if (partyNameNorm && normalizeCompanyName(loc.name) === partyNameNorm) {
      return Number(loc.id);
    }
  }
  return null;
}

/**
 * REST shipping-location search for one term and customer filter.
 * @param {object} quoteRateShop quote-rate-shop module.
 * @param {string} term Search query.
 * @param {object} party Bill-to party.
 * @param {boolean} customersOnly Restrict to customer locations.
 * @param {object} [opts] preferredSuffix for (JB)/(KA) pick.
 * @return {Promise<number|null>}
 */
async function restShippingLocationSearchTerm(
    quoteRateShop, term, party, customersOnly, opts) {
  const partyName = String(party.name || "").trim();
  const partyEmail = String(party.email || "").trim();
  const res = await quoteRateShop.searchShippingLocations({
    name: term,
    limit: 25,
    active: true,
    isCustomer: customersOnly,
  });
  const list = res.results || [];
  const fromList = pickManageLocationFromList(list, party, opts);
  if (fromList) return fromList;
  if (customersOnly) {
    const best = quoteRateShop.pickBestCustomerMatch(list, {
      from: partyEmail,
      customerRef: partyName,
    });
    if (best && best.id &&
        normalizeCompanyName(best.name) === normalizeCompanyName(partyName)) {
      return Number(best.id);
    }
  }
  return null;
}

/**
 * REST shipping-location search fallback (quote-rate-shop helpers).
 * @param {object} party Bill-to party.
 * @param {object} [opts] preferredSuffix for (JB)/(KA) pick.
 * @return {Promise<number|null>}
 */
async function resolveManageShippingLocationIdViaRest(party, opts) {
  let quoteRateShop;
  try {
    quoteRateShop = require("./quote-rate-shop");
  } catch (_) {
    return null;
  }
  const partyName = String(party.name || "").trim();
  const partyEmail = String(party.email || "").trim();
  const searches = buildShippingLocationSearchTerms(partyName);
  if (partyEmail.includes("@")) {
    const domainStem = partyEmail.split("@")[1].split(".")[0];
    if (domainStem.length > 2) searches.push(domainStem);
  }
  for (const q of searches) {
    if (!q) continue;
    try {
      const fromCustomers = await restShippingLocationSearchTerm(
          quoteRateShop, q, party, true, opts);
      if (fromCustomers) return fromCustomers;
      const fromAll = await restShippingLocationSearchTerm(
          quoteRateShop, q, party, false, opts);
      if (fromAll) return fromAll;
    } catch (err) {
      if (writeLog) {
        await writeLog("warn", "primus",
            "REST shipping location search failed", {
              partyName,
              term: q,
              error: err.message,
            }).catch(() => {});
      }
    }
  }
  return null;
}

/**
 * manage.php getShippingLocations search with optional customer filter.
 * @param {object} party Bill-to party.
 * @param {boolean} customersOnly When true, onlyCustomers=true.
 * @param {object} [opts] preferredSuffix for (JB)/(KA) pick.
 * @return {Promise<number|null>}
 */
async function searchManagePhpShippingLocation(party, customersOnly, opts) {
  const partyZip = String(party.zipCode || party.zipcode || "").trim();
  for (const query of buildShippingLocationSearchTerms(party.name)) {
    const result = await managePhpPost({
      action: "getShippingLocations",
      item_id: "0",
      excludeSLId: "0",
      zipcode: partyZip,
      fromStop: "false",
      fromDrayage: "false",
      fromBooking: "false",
      fromInvoice: "false",
      fromLTLQuote: "false",
      fromFTLQuote: "false",
      fromCustomerQuote: "false",
      fromCopyCarriers: "false",
      filterCountries: "false",
      filterCountry: "",
      page: "1",
      query,
      forcelimit: "",
      fromApplet: "false",
      onlyCustomers: customersOnly ? "true" : "false",
      start: "0",
      limit: "25",
      sort: JSON.stringify([{property: "name", direction: "ASC"}]),
    });
    const list = result.json &&
      Array.isArray(result.json.shipping_locations) ?
      result.json.shipping_locations : [];
    const picked = pickManageLocationFromList(list, party, opts);
    if (picked) return picked;
  }
  return null;
}

/**
 * Maps REST bill-to party to manage.php shippingLocationId via name search.
 * @param {object} party thirdParty or shipper from booking.
 * @param {object} [booking] Primus booking (shippingLocations fallback).
 * @return {Promise<number|null>}
 */
async function resolveManageShippingLocationId(party, booking) {
  if (!party || !party.name) return null;
  const lookupParty = enrichBillToPartyFromConsignee(party, booking);
  const opts = {
    preferredSuffix: preferredBilltoSuffixFromBooking(booking),
  };
  const stubBillTo = party.id == null || party.id === "";

  if (!stubBillTo) {
    const fromBookingLocs =
        resolveFromBookingShippingLocations(lookupParty, booking);
    if (fromBookingLocs) return fromBookingLocs;
  }

  const fromCustomers =
      await searchManagePhpShippingLocation(lookupParty, true, opts);
  if (fromCustomers) return fromCustomers;

  const fromAll =
      await searchManagePhpShippingLocation(lookupParty, false, opts);
  if (fromAll) return fromAll;

  return resolveManageShippingLocationIdViaRest(lookupParty, opts);
}

/**
 * Bill-to id for manage.php saveInvoice / consolidateInvoices.
 * REST party ids are not valid; map bill-to party to manage.php location.
 * @param {object} booking Primus booking from GET /book/bolnumber.
 * @return {Promise<object>} id, source, partyName
 */
async function resolveManageBilltoId(booking) {
  const party = resolveBillToParty(booking);
  const partyName = party && party.name ? String(party.name).trim() : null;
  if (party && party.name) {
    const manageLocationId =
        await resolveManageShippingLocationId(party, booking);
    if (manageLocationId) {
      return {
        id: manageLocationId,
        source: "manage_shipping_location",
        partyName,
      };
    }
  }
  if (writeLog) {
    await writeLog("warn", "primus",
        "Bill-to manage.php location lookup failed — " +
                "cannot use REST party id", {
          partyName,
          restPartyId: resolveBilltoId(booking),
          billTo: booking && booking.billTo,
        }).catch(() => {});
  }
  return {
    id: null,
    source: "manage_location_not_found",
    partyName,
    error: partyName ?
      "Could not map bill-to party \"" + partyName +
            "\" to manage.php shipping location" :
      "Could not resolve bill-to party on booking",
  };
}

/**
 * Contacts tab rows for a shipping location (manage.php internal id).
 * @param {number|string} shippingLocationId
 * @return {Promise<object>}
 */
async function getShippingLocationsContacts(shippingLocationId) {
  if (!isManagePhpEnabled()) {
    return {ok: false, skipped: true, reason: "PRIMUS_USE_MANAGE_PHP off"};
  }
  if (shippingLocationId == null) {
    return {ok: false, error: "No shippingLocationId"};
  }
  const result = await managePhpPost({
    action: "getShippingLocationsContacts",
    shippingLocationId: String(shippingLocationId),
    page: "1",
    start: "0",
    limit: "25",
  });
  const contacts = result.json && Array.isArray(result.json.contacts) ?
    result.json.contacts : [];
  return {
    ok: true,
    contacts,
    json: result.json,
    status: result.status,
  };
}
exports.getShippingLocationsContacts = getShippingLocationsContacts;

/**
 * @param {string|undefined} type Contact type label.
 * @return {boolean}
 */
function isAccountingContactType(type) {
  const t = normalizeLookupText(type);
  if (!t) return false;
  if (t === "accounting") return true;
  if (t.includes("account") && t.includes("receivable")) return true;
  if (t === "a/r" || t === "a r" || t === "ar") return true;
  if (t === "billing" || t.includes("billing")) return true;
  return false;
}

/**
 * @param {string|undefined} email Email address.
 * @return {boolean}
 */
function isAccountingStyleEmail(email) {
  const e = normalizeLookupText(email);
  if (!e || !e.includes("@")) return false;
  const local = e.split("@")[0];
  const acctLocal =
      /^(ap|ar|accounting|accounts|billing|invoices?|receivable)/;
  return acctLocal.test(local);
}

/**
 * @param {Array<object>} contacts
 * @return {string[]}
 */
function pickAccountingEmails(contacts) {
  const seen = new Set();
  const emails = [];
  for (const row of contacts || []) {
    if (!isAccountingContactType(row.type)) continue;
    const email = String(row.email || "").trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    emails.push(email);
  }
  return emails;
}

/**
 * Accounting contact email(s) for the bill-to customer on a booking.
 * @param {object} booking Primus booking from GET /book/bolnumber.
 * @return {Promise<object>} emails, source, manageLocationId
 */
async function resolveCustomerAccountingEmails(booking) {
  const party = resolveBillToParty(booking);
  if (!party) {
    return {
      emails: [],
      source: "no_accounting_contacts",
      manageLocationId: null,
      fallbackEmail: null,
    };
  }
  const fallbackEmail = String(party.email || "").trim() || null;
  if (!isManagePhpEnabled()) {
    return {
      emails: [],
      source: "no_accounting_contacts",
      manageLocationId: null,
      fallbackEmail,
    };
  }

  const manageLocationId =
      await resolveManageShippingLocationId(party, booking);
  if (!manageLocationId) {
    if (writeLog) {
      await writeLog("warn", "primus",
          "No manage.php shipping location for bill-to — " +
                    "accounting email lookup skipped", {
            partyName: party.name,
            fallbackEmail,
          }).catch(() => {});
    }
    return {
      emails: [],
      source: "no_accounting_contacts",
      manageLocationId: null,
      fallbackEmail,
    };
  }

  const contactsResult = await getShippingLocationsContacts(manageLocationId);
  const emails = pickAccountingEmails(contactsResult.contacts);
  if (emails.length) {
    return {
      emails,
      source: "accounting_contacts",
      manageLocationId,
      fallbackEmail,
    };
  }

  let quoteRateShop;
  try {
    quoteRateShop = require("./quote-rate-shop");
  } catch (_) {
    quoteRateShop = null;
  }
  if (quoteRateShop) {
    try {
      const restLoc = await quoteRateShop.getShippingLocationById(
          manageLocationId);
      const locEmail = restLoc && String(restLoc.email || "").trim();
      if (locEmail && isAccountingStyleEmail(locEmail)) {
        return {
          emails: [locEmail],
          source: "rest_location_email",
          manageLocationId,
          fallbackEmail,
        };
      }
    } catch (err) {
      if (writeLog) {
        await writeLog("warn", "primus",
            "REST location email lookup failed", {
              manageLocationId,
              error: err.message,
            }).catch(() => {});
      }
    }
  }

  if (writeLog) {
    await writeLog("warn", "primus",
        "No accounting contacts on bill-to customer location", {
          partyName: party.name,
          manageLocationId,
          fallbackEmail,
          contactCount: (contactsResult.contacts || []).length,
        }).catch(() => {});
  }
  return {
    emails: [],
    source: "no_accounting_contacts",
    manageLocationId,
    fallbackEmail,
  };
}
exports.resolveCustomerAccountingEmails = resolveCustomerAccountingEmails;

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

const GET_TERMS_ATTEMPTS = 3;

/**
 * @return {Promise<Array<object>>}
 */
async function fetchUiTerms() {
  const now = Date.now();
  if (cachedTerms && cachedTerms.length > 0 &&
      now - cachedTermsAt < 60 * 60 * 1000) {
    return cachedTerms;
  }
  for (let attempt = 1; attempt <= GET_TERMS_ATTEMPTS; attempt++) {
    const result = await managePhpPost({
      action: "getTerms",
      active: "1",
      page: "1",
      start: "0",
      limit: "25",
      sort: JSON.stringify([{property: "description", direction: "ASC"}]),
    });
    const parsed = parseTermsFromResponse(result.json);
    if (parsed.length > 0) {
      cachedTerms = parsed;
      cachedTermsAt = now;
      return cachedTerms;
    }
    if (writeLog) {
      await writeLog("warn", "primus",
          "getTerms returned no terms — retrying", {
            attempt,
            responseKeys: result.json && typeof result.json === "object" ?
              Object.keys(result.json) : null,
          });
    }
    if (attempt < GET_TERMS_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  return [];
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
  if (!termsList || termsList.length === 0) {
    const days = billDueDate ?
      diffCalendarDays(billDate, billDueDate) : null;
    return {
      ok: true,
      termsId: fallbackId,
      source: "default_empty_terms_list",
      requestedDays: Number.isFinite(days) ? days : null,
      days: 30,
      description: "Net 30",
      billDate: billDate ? toDateOnly(billDate) : null,
      dueDate: billDueDate ? toDateOnly(billDueDate) : null,
    };
  }
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
  const billDateOnly = toDateOnly(billDate);
  const dueDateOnly = toDateOnly(billDueDate);
  if (!Number.isFinite(days) || days < 0) {
    // AI often mis-reads dates on multi-invoice carrier PDFs (due before bill).
    // Fall back to configured Net 30 rather than blocking billing.
    if (fallback) {
      return {
        ok: true,
        termsId: fallbackId,
        source: "default_invalid_dates",
        requestedDays: Number.isFinite(days) ? days : null,
        days: fallback.days,
        code: fallback.code,
        description: fallback.description,
        billDate: billDateOnly,
        dueDate: dueDateOnly,
      };
    }
    return {
      ok: false,
      error: "Invalid carrier bill date or due date",
      billDate: billDateOnly,
      dueDate: dueDateOnly,
    };
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

  // No exact match. Rather than block billing, fall back to the configured
  // default term (Net 30). A common cause of a near-miss is the bill date
  // defaulting to the received date instead of the carrier invoice date, which
  // shifts the day count by a few days (e.g. a Net-30 invoice counted as 25).
  if (fallback) {
    return {
      ok: true,
      termsId: fallbackId,
      source: "default_no_exact_match",
      requestedDays: days,
      days: fallback.days,
      code: fallback.code,
      description: fallback.description,
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
 * PRO and carrier bill number for manage.php vendor ref fields.
 * Falls back to load number when both are missing.
 * @param {object} args proNumber, vendorInvoiceNumber, loadNumber
 * @param {object} vendor booking.vendor
 * @return {{proNumber: string, vendorInvoiceNumber: string,
 *   usedLoadFallback: boolean}}
 */
function resolveVendorBillRefs(args, vendor) {
  const loadNumber = args.loadNumber ? String(args.loadNumber) : "";
  let proNumber = String(args.proNumber || vendor.PRO || "").trim();
  let vendorInvoiceNumber = String(
      args.vendorInvoiceNumber || args.carrierInvoiceNumber ||
      args.invoiceNumber || "").trim();
  if (!vendorInvoiceNumber) {
    vendorInvoiceNumber = proNumber;
  }
  let usedLoadFallback = false;
  if (!vendorInvoiceNumber && loadNumber) {
    vendorInvoiceNumber = loadNumber;
    usedLoadFallback = true;
  }
  if (!proNumber) {
    proNumber = vendorInvoiceNumber;
  }
  return {proNumber, vendorInvoiceNumber, usedLoadFallback};
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
 * Scales vendor breakdown lines so their sum equals the carrier invoice total.
 * @param {Array<object>} lines Breakdown rows with rate/total.
 * @param {number} targetTotal Carrier invoice amount to enter.
 * @return {Array<object>}
 */
function scaleBreakdownToTotal(lines, targetTotal) {
  const target = roundMoney(targetTotal);
  if (!Array.isArray(lines) || !lines.length || !(target > 0)) {
    return lines;
  }
  const sum = roundMoney(
      lines.reduce((s, line) => s + Number(line.total || line.rate || 0), 0));
  if (!(sum > 0) || Math.abs(sum - target) <= 0.01) {
    return lines.map((line) => ({
      ...line,
      rate: roundMoney(line.rate),
      total: roundMoney(line.total || line.rate),
    }));
  }
  const ratio = target / sum;
  const scaled = lines.map((line, idx) => ({
    ...line,
    rate: roundMoney(Number(line.rate || 0) * ratio),
    total: roundMoney(Number(line.total || line.rate || 0) * ratio),
    ...(idx === 0 ? {first: true} : {}),
  }));
  const scaledSum = roundMoney(
      scaled.reduce((s, line) => s + Number(line.total || 0), 0));
  if (scaled.length && Math.abs(scaledSum - target) > 0.01) {
    const last = scaled[scaled.length - 1];
    last.total = roundMoney(last.total + (target - scaledSum));
  }
  return scaled;
}

/**
 * Builds vendor bill JSON for billsInfo from booking vendor + carrier invoice.
 * @param {object} vendor booking.vendor
 * @param {object} bill Carrier bill fields.
 * @param {number} [termsId] Primus terms id from resolveTermsForCarrierBill.
 * @return {object}
 */
function buildBillsInfo(vendor, bill, termsId) {
  const carrierTotal = roundMoney(bill.total);
  let breakdown;
  if (Array.isArray(vendor.breakdown) && vendor.breakdown.length) {
    breakdown = vendor.breakdown.map((line, idx) => ({
      code: line.code || (idx === 0 ? "FRT" : ""),
      description: line.description || "FREIGHT CHARGE",
      qty: Number(line.qty || 1),
      rate: roundMoney(line.rate),
      total: roundMoney(line.total || line.rate),
      ...(idx === 0 ? {first: true} : {}),
    }));
    if (carrierTotal > 0) {
      breakdown = scaleBreakdownToTotal(breakdown, carrierTotal);
    }
  } else {
    breakdown = [{
      code: "FRT",
      description: "FREIGHT CHARGE",
      qty: 1,
      rate: carrierTotal,
      total: carrierTotal,
      first: true,
    }];
  }
  return {
    code: "FRT",
    vendorInvoiceNumber: String(bill.vendorInvoiceNumber),
    carrierId: String(vendor.id),
    carrierName: String(vendor.name || ""),
    total: carrierTotal,
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
 * @param {number} customerRate Base freight customer rate.
 * @param {string} [billToReference] Bill-to Reference# (e.g. Unit #256255).
 * @param {Array<object>} [customerBillLines] Option B accessorial lines.
 * @return {Array<object>}
 */
function buildCustomerCharges(
    customerRate, billToReference, customerBillLines) {
  let description = "FREIGHT CHARGE";
  const ref = sanitizeBillToReferenceText(billToReference);
  if (ref) {
    description += ` - ${ref}`;
  }
  const lines = [{
    id: 1,
    code: "",
    qty: 1,
    description,
    rate: roundMoney(customerRate),
    total: roundMoney(customerRate).toFixed(2),
    chargeType: "",
  }];
  (Array.isArray(customerBillLines) ? customerBillLines : []).forEach(
      (line, idx) => {
        const amount = roundMoney(line && line.amount);
        if (!amount || amount <= 0) return;
        const name = String(line && (line.name || line.label) || "ACCESSORIAL")
            .trim().toUpperCase();
        lines.push({
          id: idx + 2,
          code: "",
          qty: 1,
          description: name,
          rate: amount,
          total: amount.toFixed(2),
          chargeType: "",
        });
      });
  return lines;
}

/**
 * @param {number} customerRate Base freight rate.
 * @param {Array<object>} [customerBillLines] Option B accessorial lines.
 * @return {number}
 */
function customerChargesTotal(customerRate, customerBillLines) {
  const base = roundMoney(customerRate || 0);
  const extra = (Array.isArray(customerBillLines) ? customerBillLines : [])
      .reduce((sum, line) => sum + roundMoney(line && line.amount), 0);
  return roundMoney(base + extra);
}

/**
 * @param {object} storeData getInvoiceStores response object.
 * @return {Array<object>|null}
 */
function extractActualCostsFromStore(storeData) {
  if (!storeData || typeof storeData !== "object") return null;
  const breakdown = storeData.breakdowns &&
    storeData.breakdowns.invoicesActualCostBreakdown;
  if (Array.isArray(breakdown) && breakdown.length) return breakdown;
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
 * Reads Primus Summary "Profit %" (actualProfitPer) from getInvoiceStores.
 * @param {object} storeData getInvoiceStores response object.
 * @return {number|null}
 */
function extractActualProfitPerFromStore(storeData) {
  if (!storeData || typeof storeData !== "object") return null;
  const candidates = [
    storeData.actualProfitPer,
    storeData.data && storeData.data.actualProfitPer,
    storeData.invoice && storeData.invoice.actualProfitPer,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Reads Primus Summary actual profit USD from getInvoiceStores.
 * @param {object} storeData getInvoiceStores response object.
 * @return {number|null}
 */
function extractActualProfitUsdFromStore(storeData) {
  if (!storeData || typeof storeData !== "object") return null;
  const candidates = [
    storeData.actualProfitUSD,
    storeData.actualProfitUsd,
    storeData.data && storeData.data.actualProfitUSD,
    storeData.invoice && storeData.invoice.actualProfitUSD,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Profit metrics from issued invoice — uses Primus Summary Profit %
 * (profit / actual cost), not GP% (profit / revenue).
 * @param {string|number} invoiceId Primus invoice id.
 * @return {Promise<object|null>}
 */
async function computeInvoiceMarginFromStore(invoiceId) {
  if (invoiceId == null || invoiceId === "") return null;
  const stores = await getInvoiceStores(String(invoiceId));
  if (!stores.ok || !stores.data) return null;

  const charges = extractChargesFromStore(stores.data) || [];
  const actualCosts = extractActualCostsFromStore(stores.data) || [];
  const chargesTotal = roundMoney(
      charges.reduce((s, c) => s + Number(c.total || 0), 0));
  const actualTotal = roundMoney(
      actualCosts.reduce((s, c) => s + Number(c.total || 0), 0));
  if (actualTotal <= 0 && chargesTotal <= 0) return null;

  const computedProfit = roundMoney(chargesTotal - actualTotal);
  const storedProfit = extractActualProfitUsdFromStore(stores.data);
  const profit = storedProfit != null ?
    roundMoney(storedProfit) : computedProfit;

  const storedProfitPct = extractActualProfitPerFromStore(stores.data);
  const profitPct = storedProfitPct != null ?
    roundMoney(storedProfitPct) :
    (actualTotal > 0 ? roundMoney((profit / actualTotal) * 100) : 0);
  const gpPct = chargesTotal > 0 ?
    roundMoney((profit / chargesTotal) * 100) : 0;

  return {
    profit,
    margin: profitPct,
    profitPct,
    gpPct,
    chargesTotal,
    actualTotal,
  };
}
exports.computeInvoiceMarginFromStore = computeInvoiceMarginFromStore;
exports.resolveIssuedInvoiceIdForLoad = resolveIssuedInvoiceIdForLoad;
exports.resolveRestInvoiceIdForQuickBooks = resolveRestInvoiceIdForQuickBooks;

/**
 * @param {object} storeData getInvoiceStores response object.
 * @return {Array<object>|null}
 */
function extractChargesFromStore(storeData) {
  if (!storeData || typeof storeData !== "object") return null;
  const breakdown = storeData.breakdowns &&
    storeData.breakdowns.invoicesChargesBreakdown;
  if (Array.isArray(breakdown) && breakdown.length) return breakdown;
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
  const breakdown = storeData.breakdowns &&
    storeData.breakdowns.invoicesEstimatedCostBreakdown;
  if (Array.isArray(breakdown) && breakdown.length) return breakdown;
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
 * Vendor-ref dynamic fields for every billsInfo row (close-cost flow).
 * @param {Array<object>} billsInfo billsInfo array for manage.php.
 * @return {object}
 */
function buildVendorRefExtraFieldsForBills(billsInfo) {
  const out = {};
  for (const bill of billsInfo) {
    const key = `${bill.carrierId}${bill.vendorInvoiceNumber}`;
    const termsId = bill.terms != null ?
      Number(bill.terms) : defaultTermsId();
    out[`${key}Total`] = roundMoney(bill.total).toFixed(2);
    out[`${key}Date`] = toDateOnly(bill.billDate);
    out[`${key}Terms`] = String(termsId);
    out[`${key}DueDate`] = toDateOnly(bill.billDueDate);
    out[`${key}PRONumber`] = String(bill.PRO || "");
  }
  return out;
}

/**
 * @param {object} storeData getInvoiceStores response object.
 * @return {Array<object>|null}
 */
function extractBillsInfoFromStore(storeData) {
  if (!storeData || typeof storeData !== "object") return null;
  const candidates = [
    storeData.billsInfo,
    storeData.data && storeData.data.billsInfo,
    storeData.invoice && storeData.invoice.billsInfo,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
  }
  return null;
}

/**
 * Rebuild billsInfo from actual cost lines when the store omits it.
 * @param {Array<object>} actualCosts From getInvoiceStores breakdown.
 * @param {Object<string, object>} [billMetaByKey] Optional per-bill metadata.
 * @return {Array<object>}
 */
function reconstructBillsInfoFromActualCosts(actualCosts, billMetaByKey) {
  const bills = new Map();
  for (const line of actualCosts) {
    const carrierId = String(line.carrierId || "");
    const invNo = String(line.vendorInvoiceNumber || "");
    const key = `${carrierId}|${invNo}`;
    if (!bills.has(key)) {
      const meta = (billMetaByKey && billMetaByKey[key]) || {};
      bills.set(key, {
        code: line.code || "",
        vendorInvoiceNumber: invNo,
        carrierId,
        carrierName: String(line.carrierName || ""),
        total: 0,
        breakdown: [],
        terms: meta.terms != null ? Number(meta.terms) : defaultTermsId(),
        PRO: String(line.PRO || meta.pro || ""),
        billDate: toPrimusDateTime(toDateOnly(meta.billDate || new Date())),
        billDueDate: toPrimusDateTime(toDateOnly(
            meta.billDueDate || meta.billDate || new Date())),
      });
    }
    const bill = bills.get(key);
    const lineTotal = roundMoney(line.total);
    bill.total = roundMoney(bill.total + lineTotal);
    bill.breakdown.push({
      code: line.code || "",
      description: line.description || "",
      qty: Number(line.qty || 1),
      rate: roundMoney(line.rate),
      total: lineTotal,
      first: bill.breakdown.length === 0,
    });
  }
  return Array.from(bills.values());
}

/**
 * @param {object} vendor Insurance vendor {id, name}.
 * @param {object} bill {vendorInvoiceNumber, total, billDate, billDueDate}.
 * @param {number} termsId Primus terms id from getTerms.
 * @return {object}
 */
function buildInsuranceBillsInfo(vendor, bill, termsId) {
  const amount = roundMoney(bill.total);
  return {
    code: "",
    vendorInvoiceNumber: String(bill.vendorInvoiceNumber),
    carrierId: String(vendor.id),
    carrierName: String(vendor.name || ""),
    total: amount,
    breakdown: [{
      code: "",
      description: "insurance",
      qty: 1,
      rate: amount,
      total: amount,
      first: true,
    }],
    terms: termsId != null ? Number(termsId) : defaultTermsId(),
    PRO: "",
    billDate: toPrimusDateTime(toDateOnly(bill.billDate)),
    billDueDate: toPrimusDateTime(toDateOnly(bill.billDueDate)),
  };
}

/**
 * @param {object} vendor Insurance vendor {id, name}.
 * @param {object} bill {vendorInvoiceNumber, total}.
 * @param {string|number|null} lineId Existing server line id, if any.
 * @return {object}
 */
function buildInsuranceActualCostLine(vendor, bill, lineId) {
  const amount = roundMoney(bill.total);
  return {
    id: lineId != null ? String(lineId) : "",
    code: "",
    description: "insurance",
    carrierId: String(vendor.id),
    carrierName: String(vendor.name || ""),
    qty: 1,
    rate: amount,
    total: amount.toFixed(2),
    vendorInvoiceNumber: String(bill.vendorInvoiceNumber),
    terms: "",
    PRO: "",
    isAccessorial: false,
  };
}

/**
 * @param {object} json getVendors response.
 * @return {Array<object>}
 */
function parseVendorsFromResponse(json) {
  if (!json || typeof json !== "object") return [];
  const list = Array.isArray(json.vendors) ? json.vendors :
    (Array.isArray(json.data) ? json.data :
      (json.data && Array.isArray(json.data.vendors) ?
        json.data.vendors : []));
  return list.map((v) => ({
    id: String(v.id || v.carrierId || ""),
    name: String(v.name || v.carrierName || ""),
    type: String(v.type || v.vendorType || v.carrierType || "").trim(),
    vendorEmail: String(v.vendorEmail || v.email || "").trim(),
  })).filter((v) => v.id);
}

/**
 * @param {string} value Email address or From header.
 * @return {string} Lowercase domain or empty.
 */
function normalizeEmailDomain(value) {
  const email = String(value || "").trim();
  const addr = email.includes("@") ?
    email.match(/[\w.+-]+@([\w.-]+\.\w+)/i) :
    null;
  const domain = addr ? addr[1] : "";
  return domain.trim().toLowerCase();
}

/**
 * @param {string} from From header.
 * @return {string} Lowercase email address or empty.
 */
function extractEmailFromFromHeader(from) {
  const hay = String(from || "").trim();
  const bracket = hay.match(/<([^>]+@[^>]+)>/);
  if (bracket && bracket[1]) return bracket[1].trim().toLowerCase();
  const plain = hay.match(/([\w.+-]+@[\w.-]+\.\w+)/);
  return plain ? plain[1].trim().toLowerCase() : "";
}

/**
 * Picks a vendor row by invoice carrier name and/or sender email domain.
 * @param {Array<object>} vendors Parsed getVendors list.
 * @param {object} hints carrierName, emailDomain.
 * @return {object|null}
 */
function findVendorByCarrierHint(vendors, hints = {}) {
  const carrierName = String(hints.carrierName || "").trim();
  const emailDomain = String(hints.emailDomain || "").trim().toLowerCase();
  if (carrierName) {
    const byName = findMasterVendorByName(vendors, carrierName);
    if (byName) return byName;
  }
  if (emailDomain) {
    const byEmail = vendors.find((v) => {
      const domain = normalizeEmailDomain(v.vendorEmail || "");
      return domain && domain === emailDomain;
    });
    if (byEmail) return byEmail;
  }
  return null;
}

/**
 * Looks up a Primus master vendor by invoice carrier name and/or sender email.
 * Used for drayage classification via vendor.type (e.g. DRAYAGE).
 *
 * @param {object} hints carrierName, fromEmail/from.
 * @return {Promise<object|null>} {id, name, type, vendorEmail} or null.
 */
async function lookupVendorByCarrierHint(hints = {}) {
  if (!isManagePhpEnabled()) return null;

  const carrierName = String(hints.carrierName || "").trim();
  const fromEmail = extractEmailFromFromHeader(
      hints.fromEmail || hints.from || "",
  );
  const emailDomain = normalizeEmailDomain(fromEmail);
  const nameQuery = carrierName.split(/[,\n/]/)[0].trim();
  if (!nameQuery && !emailDomain) return null;

  const seenIds = new Set();
  const maxPages = 120;

  const tryPage = async (start, query) => {
    const params = {
      action: "getVendors",
      page: "1",
      start: String(start),
      limit: "25",
    };
    if (query) params.query = query;
    const result = await managePhpPost(params);
    const vendors = parseVendorsFromResponse(result.json);
    if (!vendors.length) return null;
    let anyNew = false;
    for (const v of vendors) {
      if (!seenIds.has(v.id)) {
        seenIds.add(v.id);
        anyNew = true;
      }
    }
    if (!anyNew) return {done: true, match: null};
    const match = findVendorByCarrierHint(vendors, {carrierName, emailDomain});
    return {done: false, match: match || null};
  };

  if (nameQuery.length >= 3) {
    for (let page = 0; page < 8; page++) {
      const out = await tryPage(page * 25, nameQuery);
      if (!out) break;
      if (out.done) break;
      if (out.match) return out.match;
    }
  }

  for (let page = 0; page < maxPages; page++) {
    const out = await tryPage(page * 25, null);
    if (!out) break;
    if (out.done) break;
    if (out.match) return out.match;
  }

  return null;
}

let cachedRedkikVendor = null;

/**
 * Picks the best vendor match for a name hint from a getVendors result.
 * @param {Array<object>} vendors Parsed vendor list.
 * @param {string} hint Vendor name from invoice PDF.
 * @return {object|null}
 */
function pickVendorByNameHint(vendors, hint) {
  const query = String(hint || "").trim();
  if (!query || !vendors.length) return vendors[0] || null;
  const queryLower = query.toLowerCase();
  const firstToken = query.split(/[,\n]/)[0].trim().toLowerCase();
  return vendors.find((v) => v.name.toLowerCase() === queryLower) ||
    vendors.find((v) => v.name.toLowerCase() === firstToken) ||
    vendors.find((v) => v.name.toLowerCase().includes(firstToken) ||
      firstToken.includes(v.name.toLowerCase())) ||
    vendors[0] || null;
}

/**
 * Strict name match for master vendor lookup (no fallback to vendors[0]).
 * @param {Array<object>} vendors Parsed getVendors list.
 * @param {string} hint Carrier name.
 * @return {object|null}
 */
function findMasterVendorByName(vendors, hint) {
  const query = String(hint || "").trim();
  if (!query || !vendors.length) return null;
  const queryLower = query.toLowerCase();
  const firstToken = query.split(/[,\n/]/)[0].trim().toLowerCase();
  return vendors.find((v) => (v.name || "").toLowerCase() === queryLower) ||
    vendors.find((v) => (v.name || "").toLowerCase() === firstToken) ||
    vendors.find((v) => {
      const n = (v.name || "").toLowerCase();
      return firstToken.length >= 6 &&
        (n.includes(firstToken) || firstToken.includes(n));
    }) ||
    null;
}

/**
 * Resolves the Primus master vendor id (getVendors) for billing/QB sync.
 * Manual UI uses master ids (~82651 Estes); REST booking.vendor.id is a
 * different large assignment id Jerry must not send in billsInfo.carrierId.
 *
 * @param {object} bookingVendor booking.vendor from GET /book.
 * @param {string} [nameHint] Primus load vendor name (booking.vendor.name).
 *   Do not pass the carrier name from the invoice PDF — it may differ from
 *   the vendor assigned on the load and will break QuickBooks sync.
 * @return {Promise<object>} vendor-shaped object with master id + name.
 */
async function resolveMasterVendorForBilling(bookingVendor, nameHint) {
  const hint = String(nameHint || bookingVendor.name || "").trim();
  if (!hint) return bookingVendor;

  const maxPages = 160;
  for (let page = 0; page < maxPages; page++) {
    const start = page * 25;
    const result = await managePhpPost({
      action: "getVendors",
      page: "1",
      start: String(start),
      limit: "25",
    });
    const vendors = parseVendorsFromResponse(result.json);
    if (!vendors.length) break;
    const match = findMasterVendorByName(vendors, hint);
    if (match && match.id) {
      if (writeLog) {
        await writeLog("info", "primus", "Resolved master vendor for billing", {
          bookingVendorId: bookingVendor.id,
          masterVendorId: match.id,
          carrierName: match.name || hint,
        });
      }
      return {
        ...bookingVendor,
        id: match.id,
        name: match.name || hint,
        bookingVendorId: bookingVendor.id,
      };
    }
  }

  if (writeLog) {
    await writeLog("warn", "primus",
        "Master vendor not found — using booking vendor id", {
          bookingVendorId: bookingVendor.id,
          hint,
        });
  }
  return bookingVendor;
}

/**
 * Pushes carrier payable to QuickBooks Desktop via manage.php rePushToQB.
 * Uses the UI invoice id (customerInvoiceId from billing), not the REST id.
 * Payable must use master vendor id (resolveMasterVendorForBilling).
 *
 * @param {object} args
 * @param {string|number} args.customerInvoiceId UI invoice id.
 * @param {string|number} [args.invoiceNumber] Issued customer invoice #.
 * @return {Promise<object>}
 */
async function rePushCarrierBillToQuickBooks(args) {
  if (!isManagePhpEnabled()) {
    return {ok: false, skipped: true, error: "PRIMUS_USE_MANAGE_PHP off"};
  }
  const uiInvoiceId = String(args.customerInvoiceId || args.invoiceId || "");
  if (!uiInvoiceId) {
    return {ok: false, error: "customerInvoiceId required"};
  }
  const invoiceNumber = String(args.invoiceNumber || "0");
  const result = await managePhpPost({
    action: "rePushToQB",
    invoiceId: uiInvoiceId,
    invoiceNumber,
  });
  const json = result.json;
  if (isManageSuccess(json)) {
    return {
      ok: true,
      synced: true,
      message: (json && json.message) || "QuickBooks push succeeded",
      raw: json,
    };
  }
  const errMsg = (json && (json.message || json.error)) ||
    (result.text || "").slice(0, 300) ||
    "rePushToQB failed";
  return {
    ok: false,
    synced: false,
    error: errMsg,
    raw: json || result.text,
  };
}

/**
 * Resolves the insurance vendor via getVendors (env fallback for Redkik).
 * Redkik is cached process-wide; other vendors are looked up per call
 * (caller should resolve once per invoice sheet and reuse).
 *
 * @param {string} [vendorNameHint] Vendor name from invoice PDF.
 * @return {Promise<object>} {id, name}
 */
async function resolveInsuranceVendor(vendorNameHint) {
  const hint = String(vendorNameHint || "").trim();
  const isRedkik = !hint || /redkik/i.test(hint);

  if (isRedkik) {
    if (cachedRedkikVendor) return cachedRedkikVendor;
    const envId = process.env.PRIMUS_INSURANCE_VENDOR_ID || "108637";
    const envName = process.env.PRIMUS_INSURANCE_VENDOR_NAME || "Redkik USA";
    try {
      const result = await managePhpPost({
        action: "getVendors",
        page: "1",
        start: "0",
        limit: "50",
        query: "Redkik",
      });
      const vendors = parseVendorsFromResponse(result.json);
      const match = vendors.find((v) => /redkik/i.test(v.name)) || vendors[0];
      if (match) {
        cachedRedkikVendor = match;
        return match;
      }
    } catch (_) {
      // fall through to env default
    }
    cachedRedkikVendor = {id: envId, name: envName};
    return cachedRedkikVendor;
  }

  const query = hint.split(/[,\n]/)[0].trim();
  const result = await managePhpPost({
    action: "getVendors",
    page: "1",
    start: "0",
    limit: "50",
    query,
  });
  const vendors = parseVendorsFromResponse(result.json);
  const match = pickVendorByNameHint(vendors, hint);
  if (!match || !match.id) {
    throw new Error(`Insurance vendor not found in Primus: ${query}`);
  }
  return match;
}

/**
 * @param {number} a First amount.
 * @param {number} b Second amount.
 * @return {boolean}
 */
function moneyEquals(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) <= 0.005;
}

/**
 * Close-cost insurance entry — mirrors the manual Primus UI sequence:
 * getTerms → addVendorRefNumber → saveInvoice (cost closed) → getInvoiceStores.
 *
 * Adds a Redkik premium line to an existing load invoice without blocking on
 * rows that lack a BOL (caller handles batching via innovative-insurance).
 *
 * @param {object} args Flow inputs.
 * @param {object} args.booking Primus booking from GET /book/bolnumber.
 * @param {string} args.loadNumber BOL / load number.
 * @param {number} args.premium Per-shipment insurance premium.
 * @param {string} args.vendorInvoiceNumber Redkik invoice number.
 * @param {string|Date} args.billDate Insurance invoice date.
 * @param {string|Date} [args.billDueDate] Insurance due date.
 * @param {object} [args.insuranceVendor] Optional {id, name} override.
 * @return {Promise<object>}
 */
async function addInsurancePremiumToLoad(args) {
  if (!isManagePhpEnabled()) {
    return {ok: false, error: "PRIMUS_USE_MANAGE_PHP off"};
  }

  const loadNumber = args.loadNumber ? String(args.loadNumber) : "";
  const premium = roundMoney(args.premium || args.amount || 0);
  const vendorInvoiceNumber = String(args.vendorInvoiceNumber || "");
  const billDate = args.billDate || new Date();

  if (!loadNumber) return {ok: false, error: "loadNumber required"};
  if (premium <= 0) return {ok: false, error: "premium must be > 0"};
  if (!vendorInvoiceNumber) {
    return {ok: false, error: "vendorInvoiceNumber required"};
  }

  const booking = args.booking;
  if (!booking) {
    return {ok: false, notFound: true, error: "booking required"};
  }

  const bookingId = resolveManageBookingId(booking);
  if (!bookingId) {
    return {ok: false, error: "Could not resolve manage.php bookingId"};
  }

  const docs = await getBookingDocuments({bookingId, bookingBOL: loadNumber});
  if (!docs.ok || !docs.data) {
    return {
      ok: false,
      error: docs.error || "getBookingDocuments failed",
    };
  }

  const uiInvoice = findUiInvoice(docs.data);
  if (!uiInvoice || uiInvoice.id == null) {
    return {ok: false, notFound: true, error: "No Primus invoice on booking"};
  }

  const invoiceId = String(uiInvoice.id);
  const stores = await getInvoiceStores(invoiceId);
  if (!stores.ok) {
    return {ok: false, error: stores.error || "getInvoiceStores failed"};
  }
  const storeData = stores.data;

  let actualCosts = extractActualCostsFromStore(storeData) || [];
  const charges = extractChargesFromStore(storeData) || [];
  const estimatedCosts = extractEstimatedCostsFromStore(storeData) || [];

  const insuranceVendor = args.insuranceVendor ||
    await resolveInsuranceVendor();

  const insuranceLines = actualCosts.filter((c) =>
    String(c.carrierId) === String(insuranceVendor.id));
  const existing = insuranceLines.find((c) =>
    String(c.vendorInvoiceNumber) === vendorInvoiceNumber);
  if (existing && moneyEquals(existing.total, premium)) {
    return {
      ok: true,
      skipped: true,
      reason: "already posted",
      loadNumber,
      invoiceId,
      premium,
    };
  }
  if (insuranceLines.length > 0) {
    const prior = insuranceLines[0];
    return {
      ok: false,
      duplicate: true,
      error: `Load ${loadNumber} already has insurance in Primus`,
      existingBill: prior.vendorInvoiceNumber || null,
      existingAmount: prior.total,
      loadNumber,
      invoiceId,
    };
  }

  actualCosts = actualCosts.filter((c) =>
    !(String(c.carrierId) === String(insuranceVendor.id) &&
      String(c.vendorInvoiceNumber) === vendorInvoiceNumber));

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

  const insDueDate = args.billDueDate || (() => {
    const d = new Date(toDateOnly(billDate));
    d.setDate(d.getDate() + 30);
    return d;
  })();

  const insTerms = resolveTermsForCarrierBill(billDate, insDueDate, termsList);
  if (!insTerms.ok) {
    return {
      ok: false,
      step: "validateTerms",
      error: insTerms.error,
      details: insTerms,
    };
  }

  const insBill = {
    vendorInvoiceNumber,
    total: premium,
    billDate,
    billDueDate: insDueDate,
  };

  const insuranceBillsInfo = buildInsuranceBillsInfo(
      insuranceVendor, insBill, insTerms.termsId);

  let billsInfo = extractBillsInfoFromStore(storeData);
  if (!billsInfo || !billsInfo.length) {
    billsInfo = reconstructBillsInfoFromActualCosts(actualCosts);
  } else {
    billsInfo = billsInfo.filter((b) =>
      !(String(b.carrierId) === String(insuranceVendor.id) &&
        String(b.vendorInvoiceNumber) === vendorInvoiceNumber));
  }
  billsInfo.push(insuranceBillsInfo);

  const insuranceCostLine = buildInsuranceActualCostLine(
      insuranceVendor, insBill, existing && existing.id);
  const carrierActualCosts = actualCosts.map((line) => ({
    id: String(line.id),
    code: line.code || "",
    description: line.description || "",
    carrierId: String(line.carrierId),
    carrierName: String(line.carrierName || ""),
    qty: Number(line.qty || 1),
    rate: roundMoney(line.rate),
    total: roundMoney(line.total).toFixed(2),
    vendorInvoiceNumber: String(line.vendorInvoiceNumber || ""),
    terms: "",
    PRO: String(line.PRO || ""),
    isAccessorial: !!line.isAccessorial,
  }));
  const mergedActualCosts = [...carrierActualCosts, insuranceCostLine];

  const totalActual = roundMoney(
      mergedActualCosts.reduce((s, l) => s + Number(l.total || 0), 0));
  const chargesTotal = roundMoney(
      charges.reduce((s, c) => s + Number(c.total || 0), 0));
  const totalEstimated = roundMoney(
      estimatedCosts.reduce((s, e) => s + Number(e.total || 0), 0));
  const profit = roundMoney(chargesTotal - totalActual);
  const profitPer = totalActual > 0 ? (profit / totalActual) * 100 : 0;
  const gp = chargesTotal > 0 ? (profit / chargesTotal) * 100 : 0;

  const billtoResolution = await resolveManageBilltoId(booking);
  const storedBillto = extractBilltoIdFromStore(storeData);
  const billtoId = billtoResolution.id || storedBillto;
  if (!billtoId) {
    return {ok: false, error: "Could not resolve billtoId"};
  }
  if (writeLog && billtoResolution.id && storedBillto &&
      Number(storedBillto) !== Number(billtoResolution.id)) {
    await writeLog("info", "primus",
        "Overriding draft bill-to with manage.php shipping location", {
          loadNumber,
          invoiceId,
          storedBillto,
          billtoId: billtoResolution.id,
          source: billtoResolution.source,
          partyName: billtoResolution.partyName,
        });
  }

  const notes = {
    internalNotes: String(booking.internalNotes || ""),
    externalNotes: String(booking.externalNotes || ""),
  };

  const refExtra = buildVendorRefExtraFieldsForBills(billsInfo);

  const vendorRef = await managePhpPost({
    action: "addVendorRefNumber",
    invoiceId,
    bookingId,
    billsInfo,
    actualCosts: mergedActualCosts,
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
      loadNumber,
      invoiceId,
    };
  }

  const phase2Estimated = estimatedCosts.map((line) => ({
    id: String(line.id),
    code: line.code || "",
    description: line.description || "",
    carrierId: String(line.carrierId || ""),
    carrierName: String(line.carrierName || ""),
    editable: line.editable != null ? String(line.editable) : "0",
    qty: Number(line.qty || 1),
    rate: roundMoney(line.rate),
    total: roundMoney(line.total).toFixed(2),
    isAccessorial: !!line.isAccessorial,
    vendorInvoiceNumber: String(line.vendorInvoiceNumber || ""),
    terms: "",
    PRO: "",
  }));

  const phase2Charges = charges.map((c) => ({
    id: String(c.id),
    code: c.code || "",
    description: c.description || "",
    qty: Number(c.qty || 1),
    rate: roundMoney(c.rate),
    total: roundMoney(c.total).toFixed(2),
  }));

  const saveResult = await managePhpPost({
    action: "saveInvoice",
    billsInfo,
    charges: phase2Charges,
    actualCosts: mergedActualCosts,
    estimatedCosts: phase2Estimated,
    chargesTotal,
    totalEstimatedCosts: totalEstimated,
    totalActualCosts: totalActual,
    billtoId: String(billtoId),
    bookingId,
    ...notes,
    costClosed: "1",
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
    PRONumber: "",
    invoiceNumber: uiInvoice.invoiceNumber ?
      String(uiInvoice.invoiceNumber) : "0",
    id: invoiceId,
  });

  if (!saveResult.json || !isManageSuccess(saveResult.json)) {
    return {
      ok: false,
      step: "saveInvoice",
      error: (saveResult.json && saveResult.json.message) ||
        "saveInvoice failed",
      loadNumber,
      invoiceId,
    };
  }

  const verify = await getInvoiceStores(invoiceId);
  const verifiedCosts = verify.ok ?
    extractActualCostsFromStore(verify.data) : null;
  const verifiedLine = verifiedCosts && verifiedCosts.find((c) =>
    String(c.carrierId) === String(insuranceVendor.id) &&
    String(c.vendorInvoiceNumber) === vendorInvoiceNumber);

  if (writeLog) {
    await writeLog("info", "primus", "Insurance premium posted to load", {
      loadNumber,
      invoiceId,
      premium,
      vendorInvoiceNumber,
      insuranceVendorId: insuranceVendor.id,
      termsId: insTerms.termsId,
      billDate: toDateOnly(billDate),
      dueDate: toDateOnly(insDueDate),
      verified: !!verifiedLine,
    });
  }

  return {
    ok: true,
    loadNumber,
    invoiceId,
    premium,
    vendorInvoiceNumber,
    insuranceVendorId: insuranceVendor.id,
    verifiedLine: verifiedLine || null,
    steps: {
      addVendorRefNumber: vendorRef.json.message,
      saveInvoice: saveResult.json.message,
    },
  };
}

/**
 * Removes Redkik (insurance vendor) actual-cost lines from a load invoice.
 * Mirrors addInsurancePremiumToLoad save sequence without adding a new line.
 *
 * @param {object} args Flow inputs.
 * @param {object} args.booking Primus booking from GET /book/bolnumber.
 * @param {string} args.loadNumber BOL / load number.
 * @param {object} [args.insuranceVendor] Optional {id, name} override.
 * @return {Promise<object>}
 */
async function removeInsurancePremiumFromLoad(args) {
  if (!isManagePhpEnabled()) {
    return {ok: false, error: "PRIMUS_USE_MANAGE_PHP off"};
  }

  const loadNumber = args.loadNumber ? String(args.loadNumber) : "";
  if (!loadNumber) return {ok: false, error: "loadNumber required"};

  const booking = args.booking;
  if (!booking) {
    return {ok: false, notFound: true, error: "booking required"};
  }

  const bookingId = resolveManageBookingId(booking);
  if (!bookingId) {
    return {ok: false, error: "Could not resolve manage.php bookingId"};
  }

  const docs = await getBookingDocuments({bookingId, bookingBOL: loadNumber});
  if (!docs.ok || !docs.data) {
    return {
      ok: false,
      error: docs.error || "getBookingDocuments failed",
    };
  }

  const uiInvoice = findUiInvoice(docs.data);
  if (!uiInvoice || uiInvoice.id == null) {
    return {ok: false, notFound: true, error: "No Primus invoice on booking"};
  }

  const invoiceId = String(uiInvoice.id);
  const stores = await getInvoiceStores(invoiceId);
  if (!stores.ok) {
    return {ok: false, error: stores.error || "getInvoiceStores failed"};
  }
  const storeData = stores.data;

  const actualCostsRaw = extractActualCostsFromStore(storeData) || [];
  const charges = extractChargesFromStore(storeData) || [];
  const estimatedCosts = extractEstimatedCostsFromStore(storeData) || [];

  const insuranceVendor = args.insuranceVendor ||
    await resolveInsuranceVendor();

  const insuranceLines = actualCostsRaw.filter((c) =>
    String(c.carrierId) === String(insuranceVendor.id));
  if (!insuranceLines.length) {
    return {
      ok: true,
      skipped: true,
      reason: "no insurance",
      loadNumber,
      invoiceId,
    };
  }

  const removedTotal = roundMoney(
      insuranceLines.reduce((s, l) => s + Number(l.total || 0), 0));
  const removedBills = insuranceLines.map((l) =>
    l.vendorInvoiceNumber || "").filter(Boolean);

  const actualCosts = actualCostsRaw.filter((c) =>
    String(c.carrierId) !== String(insuranceVendor.id));

  let billsInfo = extractBillsInfoFromStore(storeData);
  if (!billsInfo || !billsInfo.length) {
    billsInfo = reconstructBillsInfoFromActualCosts(actualCosts);
  } else {
    billsInfo = billsInfo.filter((b) =>
      String(b.carrierId) !== String(insuranceVendor.id));
  }

  const carrierActualCosts = actualCosts.map((line) => ({
    id: String(line.id),
    code: line.code || "",
    description: line.description || "",
    carrierId: String(line.carrierId),
    carrierName: String(line.carrierName || ""),
    qty: Number(line.qty || 1),
    rate: roundMoney(line.rate),
    total: roundMoney(line.total).toFixed(2),
    vendorInvoiceNumber: String(line.vendorInvoiceNumber || ""),
    terms: "",
    PRO: String(line.PRO || ""),
    isAccessorial: !!line.isAccessorial,
  }));

  const totalActual = roundMoney(
      carrierActualCosts.reduce((s, l) => s + Number(l.total || 0), 0));
  const chargesTotal = roundMoney(
      charges.reduce((s, c) => s + Number(c.total || 0), 0));
  const totalEstimated = roundMoney(
      estimatedCosts.reduce((s, e) => s + Number(e.total || 0), 0));
  const profit = roundMoney(chargesTotal - totalActual);
  const profitPer = totalActual > 0 ? (profit / totalActual) * 100 : 0;
  const gp = chargesTotal > 0 ? (profit / chargesTotal) * 100 : 0;

  const billtoResolution = await resolveManageBilltoId(booking);
  const storedBillto = extractBilltoIdFromStore(storeData);
  const billtoId = billtoResolution.id || storedBillto;
  if (!billtoId) {
    return {ok: false, error: "Could not resolve billtoId"};
  }

  const notes = {
    internalNotes: String(booking.internalNotes || ""),
    externalNotes: String(booking.externalNotes || ""),
  };

  const refExtra = buildVendorRefExtraFieldsForBills(billsInfo);

  const vendorRef = await managePhpPost({
    action: "addVendorRefNumber",
    invoiceId,
    bookingId,
    billsInfo,
    actualCosts: carrierActualCosts,
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
      loadNumber,
      invoiceId,
    };
  }

  const phase2Estimated = estimatedCosts.map((line) => ({
    id: String(line.id),
    code: line.code || "",
    description: line.description || "",
    carrierId: String(line.carrierId || ""),
    carrierName: String(line.carrierName || ""),
    editable: line.editable != null ? String(line.editable) : "0",
    qty: Number(line.qty || 1),
    rate: roundMoney(line.rate),
    total: roundMoney(line.total).toFixed(2),
    isAccessorial: !!line.isAccessorial,
    vendorInvoiceNumber: String(line.vendorInvoiceNumber || ""),
    terms: "",
    PRO: "",
  }));

  const phase2Charges = charges.map((c) => ({
    id: String(c.id),
    code: c.code || "",
    description: c.description || "",
    qty: Number(c.qty || 1),
    rate: roundMoney(c.rate),
    total: roundMoney(c.total).toFixed(2),
  }));

  const saveResult = await managePhpPost({
    action: "saveInvoice",
    billsInfo,
    charges: phase2Charges,
    actualCosts: carrierActualCosts,
    estimatedCosts: phase2Estimated,
    chargesTotal,
    totalEstimatedCosts: totalEstimated,
    totalActualCosts: totalActual,
    billtoId: String(billtoId),
    bookingId,
    ...notes,
    costClosed: "1",
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
    PRONumber: "",
    invoiceNumber: uiInvoice.invoiceNumber ?
      String(uiInvoice.invoiceNumber) : "0",
    id: invoiceId,
  });

  if (!saveResult.json || !isManageSuccess(saveResult.json)) {
    return {
      ok: false,
      step: "saveInvoice",
      error: (saveResult.json && saveResult.json.message) ||
        "saveInvoice failed",
      loadNumber,
      invoiceId,
    };
  }

  const verify = await getInvoiceStores(invoiceId);
  const verifiedCosts = verify.ok ?
    extractActualCostsFromStore(verify.data) : null;
  const stillHasInsurance = verifiedCosts && verifiedCosts.some((c) =>
    String(c.carrierId) === String(insuranceVendor.id));

  if (writeLog) {
    await writeLog("info", "primus", "Insurance premium removed from load", {
      loadNumber,
      invoiceId,
      removedTotal,
      removedBills,
      insuranceVendorId: insuranceVendor.id,
      verifiedRemoved: !stillHasInsurance,
    });
  }

  return {
    ok: true,
    loadNumber,
    invoiceId,
    removedTotal,
    removedBills,
    removedLineCount: insuranceLines.length,
    insuranceVendorId: insuranceVendor.id,
    verifiedRemoved: !stillHasInsurance,
    steps: {
      addVendorRefNumber: vendorRef.json.message,
      saveInvoice: saveResult.json.message,
    },
  };
}
exports.addInsurancePremiumToLoad = addInsurancePremiumToLoad;
exports.removeInsurancePremiumFromLoad = removeInsurancePremiumFromLoad;
exports.resolveInsuranceVendor = resolveInsuranceVendor;
exports.lookupVendorByCarrierHint = lookupVendorByCarrierHint;

/**
 * @return {boolean}
 */
function isManagePhpEnabled() {
  const flag = process.env.PRIMUS_USE_MANAGE_PHP || "";
  return String(flag).toLowerCase() === "true";
}
exports.isManagePhpEnabled = isManagePhpEnabled;
exports.rePushCarrierBillToQuickBooks = rePushCarrierBillToQuickBooks;

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
  if (args.billToReferenceNumber != null) {
    args.billToReferenceNumber =
        sanitizeBillToReferenceText(args.billToReferenceNumber) || null;
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
      const issued = bookingDocData.invoices.find(isIssuedUiInvoice);
      if (issued) {
        const podUpload = await maybeUploadBookingPdf({
          docData: bookingDocData,
          bookingId,
          bookingBOL: loadNumber,
          fileType: uploadFileTypes.pod.id,
          fileTypeName: uploadFileTypes.pod.name,
          file: args.podPdf,
          skip: args.skipPodUpload,
          forbiddenBuffer: args.carrierBillPdf &&
            args.carrierBillPdf.buffer,
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
    // Non-fatal: the carrier bill PDF is an INTERNAL audit attachment
    // (file type external=0, never sent to the customer). The actual billing
    // (saveInvoice / consolidateInvoices) does not depend on it, so a document
    // upload hiccup must not block issuing/emailing the customer invoice.
    if (writeLog) {
      await writeLog("warn", "primus",
          "Carrier bill PDF upload failed — continuing with billing", {
            loadNumber,
            bookingId,
            error: carrierBillUpload.error,
            raw: carrierBillUpload.raw,
          });
    }
  } else if (carrierBillUpload.uploaded && writeLog) {
    await writeLog("info", "primus", "Carrier bill PDF uploaded to Primus", {
      loadNumber,
      bookingId,
      fileTypeId: uploadFileTypes.carrierBill.id,
      fileTypeName: uploadFileTypes.carrierBill.name,
    });
  }

  let vendor = booking.vendor || {};
  if (!vendor.id) {
    return {ok: false, error: "Booking missing vendor.id"};
  }
  const primusVendorName = String(vendor.name || "").trim();
  const extractedCarrierName = String(args.carrierName || "").trim();
  if (extractedCarrierName && primusVendorName &&
      extractedCarrierName.toLowerCase() !== primusVendorName.toLowerCase() &&
      writeLog) {
    await writeLog("warn", "primus",
        "Invoice carrier name differs from Primus load vendor — " +
        "using load vendor for billing/QB",
        {
          loadNumber,
          extractedCarrierName,
          primusVendorName,
          bookingVendorId: vendor.id,
        });
  }
  try {
    // Bill against the load vendor — not the PDF/email carrier name.
    vendor = await resolveMasterVendorForBilling(
        vendor,
        primusVendorName || extractedCarrierName || "",
    );
  } catch (vendorErr) {
    return {
      ok: false,
      step: "resolveMasterVendor",
      error: vendorErr.message || "resolveMasterVendorForBilling failed",
    };
  }

  const draftResolution = await resolveExistingDraftInvoiceId({
    loadNumber,
    customerInvoiceId: args.customerInvoiceId || null,
    bookingDocData,
  });
  const existingDraftId = draftResolution.id;

  const billtoResolution = await resolveManageBilltoId(booking);
  let billtoId = billtoResolution.id;
  let billtoSource = billtoResolution.source;

  if (billtoSource === "manage_location_not_found" && !existingDraftId) {
    return {
      ok: false,
      step: "resolveBillto",
      error: billtoResolution.error ||
        "Could not resolve manage.php bill-to shipping location",
      billtoSource,
      billtoPartyName: billtoResolution.partyName,
    };
  }

  if (existingDraftId) {
    const draftStores = await getInvoiceStores(existingDraftId);
    const storedBillto = draftStores.ok ?
      extractBilltoIdFromStore(draftStores.data) : null;
    if (!billtoId && storedBillto) {
      billtoId = storedBillto;
      billtoSource = "draft_store";
    } else if (billtoId && storedBillto &&
        Number(storedBillto) !== Number(billtoId) && writeLog) {
      await writeLog("info", "primus",
          "Overriding draft bill-to with manage.php shipping location", {
            loadNumber,
            bookingId,
            draftInvoiceId: existingDraftId,
            draftSource: draftResolution.source,
            storedBillto,
            billtoId,
            source: billtoSource,
            partyName: billtoResolution.partyName,
          });
    } else if (writeLog) {
      await writeLog("info", "primus",
          existingDraftId ?
            "Reusing draft invoice — setting bill-to on saveInvoice" :
            "No draft invoice found — saveInvoice will create one", {
            loadNumber,
            bookingId,
            draftInvoiceId: existingDraftId || null,
            draftSource: draftResolution.source,
            billtoId,
            billtoSource,
            partyName: billtoResolution.partyName,
          });
    }
  } else if (!billtoId) {
    return {ok: false, error: "Could not resolve billtoId from booking"};
  } else if (writeLog) {
    await writeLog("info", "primus",
        "No draft invoice found — saveInvoice will create one", {
          loadNumber,
          bookingId,
          billtoId,
          billtoSource,
          partyName: billtoResolution.partyName,
        });
  }

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
  const {proNumber, vendorInvoiceNumber, usedLoadFallback} =
      resolveVendorBillRefs(args, vendor);
  if (usedLoadFallback && writeLog) {
    await writeLog("info", "primus",
        "No PRO or carrier bill number — using load number as vendor ref", {
          loadNumber,
          bookingId,
        });
  }
  const carrierTotal = roundMoney(
      args.carrierInvoiceAmount || vendor.cost || 0);
  const customerRate = roundMoney(args.customerRate || 0);
  const customerBillLines = Array.isArray(args.customerBillLines) ?
    args.customerBillLines : [];
  const customerTotal = customerChargesTotal(customerRate, customerBillLines);
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
  } else if (writeLog && termsResolution.source === "default_no_exact_match") {
    await writeLog("warn", "primus",
        "No exact Primus term for carrier due date — using default term", {
          loadNumber,
          bookingId,
          termsId,
          requestedDays: termsResolution.requestedDays,
          defaultDays: termsResolution.days,
          billDate: toDateOnly(billDate),
          dueDate: toDateOnly(carrierDueDate),
        });
  } else if (writeLog && termsResolution.source === "default_invalid_dates") {
    await writeLog("warn", "primus",
        "Invalid carrier bill dates — using default Net 30 term", {
          loadNumber,
          bookingId,
          termsId,
          billDate: termsResolution.billDate,
          dueDate: termsResolution.dueDate,
          requestedDays: termsResolution.requestedDays,
          defaultDays: termsResolution.days,
        });
  }

  const billsInfo = [buildBillsInfo(vendor, bill, termsId)];
  const estimatedCosts = buildEstimatedCosts(vendor);
  const totalEstimated = roundMoney(
      estimatedCosts.reduce((s, l) => s + Number(l.total || 0), 0));
  const actualCostsFirst = buildActualCosts(vendor, bill);
  const totalActual = roundMoney(
      actualCostsFirst.reduce((s, l) => s + Number(l.total || 0), 0));
  const profit = roundMoney(customerTotal - totalActual);
  const profitPer = totalActual > 0 ?
    (profit / totalActual) * 100 : 0;
  const gp = customerTotal > 0 ? (profit / customerTotal) * 100 : 0;

  const notes = {
    internalNotes: String(booking.internalNotes || ""),
    externalNotes: String(booking.externalNotes || ""),
  };

  const phase1 = await managePhpPost({
    action: "saveInvoice",
    billsInfo,
    charges: buildCustomerCharges(
        customerRate, args.billToReferenceNumber, customerBillLines),
    actualCosts: actualCostsFirst,
    estimatedCosts,
    chargesTotal: customerTotal,
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
    ...(existingDraftId ? {id: String(existingDraftId)} : {}),
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

  const uiInvoiceId = phase1.json.recordId || existingDraftId ||
    args.customerInvoiceId;
  if (!uiInvoiceId) {
    return {ok: false, error: "saveInvoice phase1 returned no recordId"};
  }

  const stores = await getInvoiceStores(uiInvoiceId);
  const storeData = stores.ok ? stores.data : null;
  const storedCosts = extractActualCostsFromStore(storeData);
  const actualCostsWithIds = buildActualCosts(
      vendor, bill, storedCosts || actualCostsFirst);
  const storedCharges = extractChargesFromStore(storeData);
  const phase2Charges = (storedCharges ||
    buildCustomerCharges(
        customerRate, args.billToReferenceNumber, customerBillLines))
      .map((c) => ({
        id: String(c.id != null ? c.id : 1),
        code: c.code || "",
        description: c.description || "FREIGHT CHARGE",
        qty: Number(c.qty || 1),
        rate: roundMoney(c.rate),
        total: roundMoney(c.total).toFixed(2),
      }));
  if (args.billToReferenceNumber &&
      !invoiceChargesIncludeReference(
          phase2Charges, args.billToReferenceNumber)) {
    const withRef = buildCustomerCharges(
        customerRate, args.billToReferenceNumber, customerBillLines);
    phase2Charges.splice(0, phase2Charges.length, ...withRef.map((c) => ({
      id: String(c.id),
      code: c.code || "",
      description: c.description,
      qty: Number(c.qty || 1),
      rate: roundMoney(c.rate),
      total: roundMoney(c.total).toFixed(2),
    })));
  }
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
    chargesTotal: customerTotal,
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

  if (args.billToReferenceNumber) {
    const verifyStores = await getInvoiceStores(uiInvoiceId);
    const verifyCharges = verifyStores.ok ?
      extractChargesFromStore(verifyStores.data) : null;
    if (!invoiceChargesIncludeReference(
        verifyCharges, args.billToReferenceNumber)) {
      return {
        ok: false,
        step: "unit_reference_on_invoice",
        error: "Customer invoice is missing the Bill To Reference# " +
          "(unit number) on the charge lines",
        customerInvoiceId: uiInvoiceId,
        billToReferenceNumber: args.billToReferenceNumber,
      };
    }
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
    forbiddenBuffer: args.carrierBillPdf && args.carrierBillPdf.buffer,
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
    billtoSource,
    billtoPartyName: billtoResolution.partyName || null,
    reusedDraft: !!existingDraftId,
    draftSource: draftResolution.source,
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

/**
 * Looks up Primus UI users via manage.php getUsers.
 * @param {string} query Username, last name, or free-text search.
 * @return {Promise<object>} {ok, users, error}.
 */
async function lookupPrimusUsers(query) {
  if (!isManagePhpEnabled()) {
    return {ok: false, users: [], error: "manage.php off"};
  }
  const q = String(query || "").trim();
  if (!q) {
    return {ok: false, users: [], error: "empty query"};
  }
  try {
    const result = await managePhpPost({
      action: "getUsers",
      page: "1",
      start: "0",
      limit: "25",
      query: q,
      forcelimit: "",
      item_id: "",
      locationType: "",
      sort: JSON.stringify([
        {property: "lastName", direction: "ASC"},
      ]),
    });
    if (!result.json || !Array.isArray(result.json.users)) {
      return {
        ok: false,
        users: [],
        error: (result.json && result.json.message) ||
          "getUsers returned no users list",
      };
    }
    return {ok: true, users: result.json.users};
  } catch (err) {
    return {ok: false, users: [], error: err.message};
  }
}
exports.lookupPrimusUsers = lookupPrimusUsers;

/**
 * Ordered Primus user hints for the load dispatcher (UI "Controlled by").
 * Falls back to dispatchedByUser only when control fields are absent.
 * @param {object} booking Primus booking.
 * @return {string[]}
 */
function dispatcherQueriesFromBooking(booking) {
  const queries = [];
  const seen = new Set();
  const add = (value) => {
    const text = String(value || "").trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    queries.push(text);
  };

  add(booking.userName);
  const control = booking.contactInformation &&
    booking.contactInformation.controlUser;
  if (control && control.name) add(control.name);
  add(booking.controlledByName);
  const controlledBy = String(booking.controlledBy || "").trim();
  if (controlledBy && !/^\d+$/.test(controlledBy)) add(controlledBy);
  add(booking.dispatchedByUser);
  add(booking.CreatedBy);

  return queries;
}

/**
 * Resolves the load dispatcher contact (username + email) from a booking.
 * Uses Primus "Controlled by" (userName / controlUser) before dispatchedByUser.
 * @param {object} args Args.
 * @param {object} [args.booking] Primus booking (optional if loadNumber set).
 * @param {string|number} [args.loadNumber] BOL / load number.
 * @param {Function} [args.fetchBooking] Optional booking loader.
 * @return {Promise<object>} {ok, email, userName, displayName, ...}
 */
async function resolveDispatcherEmail(args = {}) {
  let booking = args.booking || null;
  const loadNumber = args.loadNumber != null ? String(args.loadNumber) : "";
  if (!booking && loadNumber && typeof args.fetchBooking === "function") {
    booking = await args.fetchBooking(loadNumber);
  }
  if (!booking) {
    return {ok: false, error: "missing booking"};
  }

  const queries = dispatcherQueriesFromBooking(booking);
  if (!queries.length) {
    return {ok: false, error: "no dispatcher username on booking"};
  }

  for (const query of queries) {
    const looked = await lookupPrimusUsers(query);
    if (!looked.ok || !looked.users.length) continue;
    const want = query.toLowerCase();
    const matched = looked.users.find((u) =>
      String(u.userName || "").toLowerCase() === want,
    ) || looked.users.find((u) => {
      const full = `${u.firstName || ""} ${u.lastName || ""}`.trim()
          .toLowerCase().replace(/\s+/g, " ");
      return full === want.replace(/\s+/g, " ") ||
        full.includes(want.replace(/\s+/g, " "));
    }) || (looked.users.length === 1 ? looked.users[0] : null);

    if (!matched) continue;
    const email = String(matched.email || matched.mailEmail || "").trim();
    if (!email || !email.includes("@")) {
      return {
        ok: false,
        userName: matched.userName || query,
        displayName: matched.displayName ||
          `${matched.firstName || ""} ${matched.lastName || ""}`.trim(),
        error: "dispatcher user found but has no email",
      };
    }
    return {
      ok: true,
      email,
      userName: matched.userName || query,
      displayName: matched.displayName ||
        `${matched.firstName || ""} ${matched.lastName || ""}`.trim() ||
        query,
      userId: matched.id || null,
      query,
    };
  }

  return {
    ok: false,
    userName: queries[0] || null,
    displayName: queries.find((q) => q.includes(" ")) || null,
    error: "getUsers did not return a matching dispatcher",
  };
}
exports.resolveDispatcherEmail = resolveDispatcherEmail;

/**
 * Checks whether a Primus booking already has a POD document on file.
 * Used when local POD extraction failed so the workflow can continue
 * without treating POD as missing.
 * @param {object} args Args.
 * @param {object} args.booking Primus booking from GET /book/bolnumber.
 * @param {string|number} args.loadNumber Load / BOL number.
 * @return {Promise<object>} {found, driveIds, reason}.
 */
async function checkBookingHasPod({booking, loadNumber}) {
  if (!isManagePhpEnabled()) {
    return {found: false, driveIds: [], reason: "manage.php off"};
  }
  if (!booking || !loadNumber) {
    return {found: false, driveIds: [], reason: "missing booking or load"};
  }
  const bookingId = resolveManageBookingId(booking);
  if (!bookingId) {
    return {
      found: false,
      driveIds: [],
      reason: "Could not resolve manage.php bookingId",
    };
  }

  let uploadFileTypes;
  try {
    uploadFileTypes = await resolveUploadFileTypes();
  } catch (err) {
    return {
      found: false,
      driveIds: [],
      reason: err && err.message || "resolveUploadFileTypes failed",
    };
  }

  const docs = await getBookingDocuments({
    bookingId,
    bookingBOL: String(loadNumber),
  });
  if (!docs.ok || !docs.data) {
    return {
      found: false,
      driveIds: [],
      reason: docs.error || "getBookingDocuments failed",
    };
  }

  const podFileTypeId = uploadFileTypes.pod.id;
  const carrierBillTypeId = uploadFileTypes.carrierBill.id;
  const driveIds = listPodDriveFileIds(
      docs.data, podFileTypeId, carrierBillTypeId,
  );
  const hasType = bookingHasFileType(docs.data, podFileTypeId);
  if (hasType || driveIds.length > 0) {
    return {found: true, driveIds};
  }
  return {found: false, driveIds: [], reason: "no POD on booking"};
}
exports.checkBookingHasPod = checkBookingHasPod;

/**
 * Uploads a POD PDF to Primus (POD file type) when missing, so the load is
 * "marked POD" before Power Only billing continues.
 * @param {object} args booking, loadNumber, podPdf {buffer, filename}.
 * @return {Promise<object>}
 */
async function ensurePodMarkedOnPrimus(args) {
  const {booking, loadNumber, podPdf} = args || {};
  if (!isManagePhpEnabled()) {
    return {ok: true, hasPod: false, skipped: true, reason: "manage.php off"};
  }
  if (!booking || !loadNumber) {
    return {ok: false, error: "Missing booking or loadNumber"};
  }
  let check = await checkBookingHasPod({booking, loadNumber});
  if (check.found) {
    return {ok: true, hasPod: true, uploaded: false, driveIds: check.driveIds};
  }
  const buf = podPdf && podPdf.buffer;
  if (!buf || !buf.length) {
    return {ok: true, hasPod: false, uploaded: false, reason: "no pod pdf"};
  }
  const bookingId = resolveManageBookingId(booking);
  if (!bookingId) {
    return {ok: false, error: "Could not resolve manage.php bookingId"};
  }
  let uploadFileTypes;
  try {
    uploadFileTypes = await resolveUploadFileTypes();
  } catch (err) {
    return {ok: false, error: err.message || String(err)};
  }
  const docs = await getBookingDocuments({
    bookingId,
    bookingBOL: String(loadNumber),
  });
  const upload = await maybeUploadBookingPdf({
    docData: docs.ok ? docs.data : null,
    bookingId,
    bookingBOL: String(loadNumber),
    fileType: uploadFileTypes.pod.id,
    fileTypeName: uploadFileTypes.pod.name,
    file: {
      buffer: buf,
      filename: podPdf.filename || `pod-${loadNumber}.pdf`,
    },
  });
  if (!upload.ok) {
    return {ok: false, hasPod: false, uploaded: false, error: upload.error};
  }
  check = await checkBookingHasPod({booking, loadNumber});
  return {
    ok: true,
    hasPod: !!check.found,
    uploaded: !!upload.uploaded,
    upload,
    driveIds: check.driveIds || [],
  };
}
exports.ensurePodMarkedOnPrimus = ensurePodMarkedOnPrimus;

/**
 * Uploads the carrier bill PDF to Primus (internal Carrier Bill file type)
 * as soon as the invoice PDF is available — does not wait for customer
 * invoice generation or rate check.
 * @param {object} args booking, loadNumber, carrierBillPdf {buffer, filename}.
 * @return {Promise<object>}
 */
async function ensureCarrierBillUploadedToPrimus(args) {
  const {booking, loadNumber, carrierBillPdf} = args || {};
  if (!isManagePhpEnabled()) {
    return {ok: true, skipped: true, reason: "manage.php off"};
  }
  if (!booking || !loadNumber) {
    return {ok: false, error: "Missing booking or loadNumber"};
  }
  const bookingId = resolveManageBookingId(booking);
  if (!bookingId) {
    return {ok: false, error: "Could not resolve manage.php bookingId"};
  }
  let uploadFileTypes;
  try {
    uploadFileTypes = await resolveUploadFileTypes();
  } catch (err) {
    return {ok: false, error: err.message || String(err)};
  }
  const carrierBillTypeId = uploadFileTypes.carrierBill.id;
  const docs = await getBookingDocuments({
    bookingId,
    bookingBOL: String(loadNumber),
  });
  if (docs.ok && bookingHasFileType(docs.data, carrierBillTypeId)) {
    return {
      ok: true,
      uploaded: false,
      skipped: true,
      reason: "already uploaded",
    };
  }
  const buf = carrierBillPdf && carrierBillPdf.buffer;
  if (!buf || !buf.length) {
    return {ok: true, skipped: true, reason: "no carrier bill pdf"};
  }
  const upload = await maybeUploadBookingPdf({
    docData: docs.ok ? docs.data : null,
    bookingId,
    bookingBOL: String(loadNumber),
    fileType: carrierBillTypeId,
    fileTypeName: uploadFileTypes.carrierBill.name,
    file: {
      buffer: buf,
      filename: carrierBillPdf.filename ||
        `carrier-bill-${loadNumber}.pdf`,
    },
  });
  if (!upload.ok) {
    return {ok: false, uploaded: false, error: upload.error, upload};
  }
  return {
    ok: true,
    uploaded: !!upload.uploaded,
    skipped: !!upload.skipped,
    upload,
  };
}
exports.ensureCarrierBillUploadedToPrimus = ensureCarrierBillUploadedToPrimus;

/**
 * Normalizes Bill To Reference# text (nbsp / mojibake / whitespace).
 * @param {string|null|undefined} text Raw reference text.
 * @return {string}
 */
function sanitizeBillToReferenceText(text) {
  const cleaned = String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\u00c5/g, " ")
      .replace(/\u00c2/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const lower = cleaned.toLowerCase();
  if (lower === "undefined" || lower === "null") return "";
  return cleaned;
}

/**
 * True when issued invoice charge lines include the bill-to reference text.
 * @param {Array<object>} charges Invoice charge rows.
 * @param {string} billToReference Bill-to Reference# text.
 * @return {boolean}
 */
function invoiceChargesIncludeReference(charges, billToReference) {
  const ref = sanitizeBillToReferenceText(billToReference);
  if (!ref) return true;
  const refNorm = ref.toLowerCase();
  const tokens = ref.match(/[A-Z0-9]{6,}/gi) || [];
  const serial = tokens.sort((a, b) => b.length - a.length)[0] || "";
  return (Array.isArray(charges) ? charges : []).some((c) => {
    const desc = sanitizeBillToReferenceText(c.description || "").toLowerCase();
    if (desc.includes(refNorm)) return true;
    if (serial && desc.includes(serial.toLowerCase())) return true;
    return false;
  });
}

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
  resolveBillToParty,
  resolveManageBilltoId,
  resolveManageShippingLocationId,
  normalizeCompanyName,
  pickManageLocationFromList,
  namesAreCloseForBillto,
  enrichBillToPartyFromConsignee,
  preferredBilltoSuffixFromBooking,
  initialsFromPersonName,
  pickAccountingEmails,
  isAccountingContactType,
  isAccountingStyleEmail,
  listFileTypeDriveIds,
  listPodDriveFileIds,
  listCustomerDriveFileIds,
  listQuoteApprovalDriveFileIds,
  isMiworldCustomer,
  customerNameFromBooking,
  fetchUiFileTypes,
  isIssuedUiInvoice,
  isDraftUiInvoice,
  findDraftUiInvoice,
  extractBilltoIdFromStore,
  resolveExistingDraftInvoiceId,
  buildBillsInfo,
  buildActualCosts,
  resolveBookingQuoteIds,
  resolveManageBookingId,
  resolveVendorBillRefs,
  resolveTermsForCarrierBill,
  parseTermsFromResponse,
  diffCalendarDays,
  findUiInvoice,
  extractBillsInfoFromStore,
  buildInsuranceBillsInfo,
  buildInsuranceActualCostLine,
  buildVendorRefExtraFieldsForBills,
  sanitizeBillToReferenceText,
  invoiceChargesIncludeReference,
};
