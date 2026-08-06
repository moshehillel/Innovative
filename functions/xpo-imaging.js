"use strict";

/**
 * XPO LTL Imaging API — weight & inspection certificate retrieval.
 *
 * Auth: OAuth 2.0 password grant at POST {base}/token
 *   Authorization: Basic {XPO_IMAGING_API_KEY}  (or base64(username:password))
 *   Body: grant_type=password&username=&password=
 *
 * Documents: GET {base}/imaging/1.0/shipments/{pro}/imaged-docs
 *   Query: imageFormat=PDF&multiPartResp=false&imageType={type}
 *
 * Env (functions/.env.tai-invoice-automation — never commit):
 *   XPO_IMAGING_USERNAME — ltl.xpo.com web login
 *   XPO_IMAGING_PASSWORD — web login password
 *   XPO_IMAGING_API_KEY  — OAuth client key from LTLWebAPISupport@xpo.com
 *     (Basic auth value; may include or omit the "Basic " prefix)
 *   XPO_IMAGING_API_BASE — optional, default https://api.ltl.xpo.com
 */

const DEFAULT_API_BASE = "https://api.ltl.xpo.com";

/** Document Finder / imaging types for weight & inspection proof. */
const WEIGHT_CERT_IMAGE_TYPES = Object.freeze([
  "WI", // Weight & Inspection
  "IR", // Inspection Report
  "WC", // Weights and Corrections
  "WR", // Weights and Research photos
  "WRC",
  "WGT",
]);

/** In-memory token cache keyed by username. */
const tokenCache = new Map();

/**
 * @param {string|null|undefined} carrierName Carrier name from invoice.
 * @return {boolean}
 */
function isXpoCarrier(carrierName) {
  const name = String(carrierName || "");
  return /\bxpo\b/i.test(name) || /xpo\s*logistics/i.test(name);
}

/**
 * Resolves a digits-only XPO PRO (9 digits, optional 10th check digit).
 * @param {object} args proNumber, invoiceNumber
 * @return {string|null}
 */
function resolveXpoPro(args) {
  const fields = [args && args.proNumber, args && args.invoiceNumber];
  for (const raw of fields) {
    const digits = String(raw || "").replace(/\D/g, "");
    if (digits.length === 9 || digits.length === 10) {
      return digits.slice(0, 9);
    }
  }
  return null;
}

/**
 * @return {string}
 */
function imagingApiBase() {
  return String(process.env.XPO_IMAGING_API_BASE || DEFAULT_API_BASE)
      .replace(/\/$/, "");
}

/**
 * @return {{username: string, password: string, apiKey: string}|null}
 */
function imagingCredentials() {
  const username = String(process.env.XPO_IMAGING_USERNAME || "").trim();
  const password = String(process.env.XPO_IMAGING_PASSWORD || "").trim();
  const explicitKey = String(
      process.env.XPO_IMAGING_API_KEY ||
      process.env.XPO_API_KEY ||
      "",
  ).trim();
  if (!username || !password) {
    return null;
  }
  let apiKey = explicitKey;
  if (apiKey.toLowerCase().startsWith("basic ")) {
    apiKey = apiKey.slice(6).trim();
  }
  if (!apiKey) {
    apiKey = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  }
  return {username, password, apiKey};
}

/**
 * @param {string} username Cache key.
 * @param {object} token access_token + expires_in
 * @return {void}
 */
function cacheToken(username, token) {
  const ttlMs = Math.max(60, Number(token.expires_in) || 3600) * 500;
  tokenCache.set(username, {
    token,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * @param {string} username Cache key.
 * @return {object|null} Cached token payload.
 */
function readCachedToken(username) {
  const row = tokenCache.get(username);
  if (!row || row.expiresAt <= Date.now()) {
    tokenCache.delete(username);
    return null;
  }
  return row.token;
}

/**
 * Obtains a Bearer access token from XPO OAuth.
 * @return {Promise<object>}
 */
async function getAccessToken() {
  const creds = imagingCredentials();
  if (!creds) {
    return {ok: false, error: "Missing XPO_IMAGING_USERNAME/PASSWORD"};
  }

  const cached = readCachedToken(creds.username);
  if (cached && cached.access_token) {
    return {ok: true, accessToken: cached.access_token, cached: true};
  }

  const url = `${imagingApiBase()}/token`;
  const body = new URLSearchParams({
    grant_type: "password",
    username: creds.username,
    password: creds.password,
  }).toString();

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${creds.apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body,
    });
  } catch (err) {
    return {ok: false, error: err.message || String(err)};
  }

  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    return {
      ok: false,
      status: resp.status,
      error: `Token response not JSON (${resp.status})`,
      raw: text.slice(0, 300),
    };
  }

  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      error: json.error_description || json.error ||
        json.message || `Token HTTP ${resp.status}`,
      json,
    };
  }

  if (!json.access_token) {
    return {ok: false, error: "Token response missing access_token", json};
  }

  cacheToken(creds.username, json);
  return {ok: true, accessToken: json.access_token, cached: false};
}

/**
 * Parses imaging API JSON, tolerating multipart wrappers.
 * @param {string} text Response body.
 * @return {object|null}
 */
function parseImagingJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_) {
      return null;
    }
  }
}

/**
 * Normalizes imagedDocument rows from API payload.
 * @param {object|null} json Parsed response.
 * @return {Array<object>}
 */
function extractImagedDocuments(json) {
  if (!json || typeof json !== "object") return [];
  const data = json.data || json;
  const docs = data.imagedDocument || data.imagedDocuments ||
    data.documents || [];
  return Array.isArray(docs) ? docs.filter(Boolean) : [];
}

/**
 * True when imageType looks like weight / inspection proof.
 * @param {string} imageType XPO image type code.
 * @return {boolean}
 */
function isWeightCertImageType(imageType) {
  const code = String(imageType || "").trim().toUpperCase();
  if (!code) return false;
  if (WEIGHT_CERT_IMAGE_TYPES.includes(code)) return true;
  return /^(WI|IR|WC|WR|WGT)/.test(code);
}

/**
 * Decodes the first PDF from an imagedDocument row.
 * @param {object} doc Imaging row.
 * @return {{pdfBuffer: Buffer, fileName: string}|null}
 */
function decodeImagedDocumentPdf(doc) {
  const files = Array.isArray(doc.imageFiles) ? doc.imageFiles : [];
  for (const file of files) {
    const b64 = file && (file.base64Data || file.imageData || file.data);
    if (!b64 || typeof b64 !== "string") continue;
    const pdfBuffer = Buffer.from(b64, "base64");
    if (!pdfBuffer.length) continue;
    const header = pdfBuffer.slice(0, 4).toString();
    if (header !== "%PDF") continue;
    return {
      pdfBuffer,
      fileName: String(file.fileName || file.filename || "xpo-weight-cert.pdf"),
    };
  }
  return null;
}

/**
 * Lists/fetches imaged documents for a PRO and optional image type.
 * @param {string} proNumber 9-digit PRO.
 * @param {object} [opts] imageType, accessToken
 * @return {Promise<object>}
 */
async function listImagedDocuments(proNumber, opts) {
  const pro = String(proNumber || "").replace(/\D/g, "").slice(0, 9);
  if (!pro) {
    return {ok: false, error: "Missing PRO number"};
  }

  let accessToken = opts && opts.accessToken;
  if (!accessToken) {
    const tokenResult = await getAccessToken();
    if (!tokenResult.ok) return tokenResult;
    accessToken = tokenResult.accessToken;
  }

  const params = new URLSearchParams({
    imageFormat: "PDF",
    multiPartResp: "false",
  });
  const imageType = opts && opts.imageType;
  if (imageType) {
    params.set("imageType", String(imageType).toUpperCase());
  }

  const url =
    `${imagingApiBase()}/imaging/1.0/shipments/${encodeURIComponent(pro)}` +
    `/imaged-docs?${params.toString()}`;

  let resp;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
      },
    });
  } catch (err) {
    return {ok: false, proNumber: pro, error: err.message || String(err)};
  }

  const text = await resp.text();
  const json = parseImagingJson(text);
  if (!resp.ok) {
    return {
      ok: false,
      proNumber: pro,
      status: resp.status,
      imageType: imageType || null,
      error: (json && (json.error || json.message)) ||
        `Imaging HTTP ${resp.status}`,
      json: json || text.slice(0, 300),
    };
  }

  if (!json) {
    return {
      ok: false,
      proNumber: pro,
      imageType: imageType || null,
      error: "Imaging response not JSON",
      raw: text.slice(0, 300),
    };
  }

  const documents = extractImagedDocuments(json);
  return {
    ok: true,
    proNumber: pro,
    imageType: imageType || null,
    documents,
    json,
  };
}

/**
 * Fetches a weight & inspection certificate PDF for an XPO PRO.
 * Tries known weight image types, then scans any returned documents.
 * @param {string} pro PRO / invoice tracking number.
 * @param {object} [opts] imageTypes
 * @return {Promise<object>}
 */
async function fetchXpoWeightCertPdf(pro, opts) {
  const proNumber = resolveXpoPro({proNumber: pro, invoiceNumber: pro});
  if (!proNumber) {
    return {ok: false, error: "Missing or invalid XPO PRO number"};
  }

  const tokenResult = await getAccessToken();
  if (!tokenResult.ok) {
    return Object.assign({proNumber}, tokenResult);
  }
  const accessToken = tokenResult.accessToken;

  const types = (opts && opts.imageTypes) ||
    WEIGHT_CERT_IMAGE_TYPES.slice();
  const attempts = [];

  for (const imageType of types) {
    const listed = await listImagedDocuments(proNumber, {
      accessToken,
      imageType,
    });
    attempts.push({
      imageType,
      ok: listed.ok,
      count: listed.documents ? listed.documents.length : 0,
      error: listed.error || null,
    });
    if (!listed.ok || !listed.documents || !listed.documents.length) {
      continue;
    }
    for (const doc of listed.documents) {
      if (imageType && !isWeightCertImageType(doc.imageType || imageType)) {
        continue;
      }
      const decoded = decodeImagedDocumentPdf(doc);
      if (!decoded) continue;
      return {
        ok: true,
        proNumber,
        imageType: doc.imageType || imageType,
        fileName: decoded.fileName,
        pdfBuffer: decoded.pdfBuffer,
        attempts,
      };
    }
  }

  // Last resort: list without imageType filter and pick weight-like docs.
  const allDocs = await listImagedDocuments(proNumber, {accessToken});
  attempts.push({
    imageType: null,
    ok: allDocs.ok,
    count: allDocs.documents ? allDocs.documents.length : 0,
    error: allDocs.error || null,
  });
  if (allDocs.ok && allDocs.documents) {
    for (const doc of allDocs.documents) {
      if (!isWeightCertImageType(doc.imageType)) continue;
      const decoded = decodeImagedDocumentPdf(doc);
      if (!decoded) continue;
      return {
        ok: true,
        proNumber,
        imageType: doc.imageType,
        fileName: decoded.fileName,
        pdfBuffer: decoded.pdfBuffer,
        attempts,
      };
    }
  }

  return {
    ok: false,
    proNumber,
    error: "No weight & inspection certificate found for PRO",
    attempts,
  };
}

module.exports = {
  isXpoCarrier,
  resolveXpoPro,
  getAccessToken,
  listImagedDocuments,
  fetchXpoWeightCertPdf,
  WEIGHT_CERT_IMAGE_TYPES,
  _internal: {
    imagingCredentials,
    parseImagingJson,
    extractImagedDocuments,
    isWeightCertImageType,
    decodeImagedDocumentPdf,
  },
};
