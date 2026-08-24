/**
 * Apex Capital factoring emails — invoice PDFs are linked in the HTML body,
 * not attached. Download ViewPDFDocument.do URLs and feed normal intake.
 */
"use strict";

const APEX_HOST = "apexcapitalcorp.com";
const APEX_PDF_PATH = "/m3clients/viewpdfdocument.do";

/**
 * @param {object} payload Gmail message payload.
 * @return {string}
 */
function extractEmailHtml(payload) {
  if (!payload) return "";

  if (payload.body && payload.body.data) {
    const mimeType = payload.mimeType || "";
    if (mimeType === "text/html") {
      return Buffer.from(
          payload.body.data.replace(/-/g, "+").replace(/_/g, "/"),
          "base64",
      ).toString("utf-8");
    }
  }

  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body && part.body.data) {
        return Buffer.from(
            part.body.data.replace(/-/g, "+").replace(/_/g, "/"),
            "base64",
        ).toString("utf-8");
      }
    }
    for (const part of payload.parts) {
      const nested = extractEmailHtml(part);
      if (nested) return nested;
    }
  }

  return "";
}

/**
 * @param {object} payload Gmail message payload.
 * @return {string}
 */
function extractEmailPlain(payload) {
  if (!payload) return "";

  if (payload.body && payload.body.data) {
    const mimeType = payload.mimeType || "";
    if (mimeType === "text/plain") {
      return Buffer.from(
          payload.body.data.replace(/-/g, "+").replace(/_/g, "/"),
          "base64",
      ).toString("utf-8");
    }
  }

  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body && part.body.data) {
        return Buffer.from(
            part.body.data.replace(/-/g, "+").replace(/_/g, "/"),
            "base64",
        ).toString("utf-8");
      }
    }
    for (const part of payload.parts) {
      const nested = extractEmailPlain(part);
      if (nested) return nested;
    }
  }

  return "";
}

/**
 * @param {string} subject Email subject.
 * @param {string} from Email From header.
 * @param {string} html HTML body.
 * @param {string} text Plain body.
 * @return {boolean}
 */
function isApexCapitalEmail(subject, from, html, text) {
  const hay = `${subject || ""}\n${from || ""}\n${html || ""}\n${text || ""}`
      .toLowerCase();
  return hay.includes(APEX_HOST) ||
    hay.includes("apex capital");
}

/**
 * @param {string} content HTML or plain email body.
 * @return {string[]}
 */
function extractApexInvoicePdfUrls(content) {
  if (!content) return [];

  const hrefs = [];
  const hrefRe = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = hrefRe.exec(content)) !== null) {
    hrefs.push(match[1].trim());
  }

  const plainRe = /https?:\/\/[^\s"'<>]+/gi;
  const plain = content.match(plainRe) || [];

  const seen = new Set();
  const out = [];
  for (let raw of [...hrefs, ...plain]) {
    raw = raw.replace(/&amp;/g, "&").replace(/[)>.,;]+$/g, "");
    if (!raw.startsWith("http")) continue;
    let url;
    try {
      url = new URL(raw);
    } catch (_) {
      continue;
    }
    if (!url.hostname.toLowerCase().includes(APEX_HOST)) continue;
    if (!url.pathname.toLowerCase().includes(APEX_PDF_PATH)) continue;
    const type = (url.searchParams.get("type") || "").toLowerCase();
    if (type && type !== "invoice") continue;
    const barCode = url.searchParams.get("bar_code") ||
      url.searchParams.get("barcode") || "";
    const key = `${url.origin}${url.pathname}?bar_code=${barCode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url.href);
  }
  return out;
}

/**
 * @param {string} url Apex PDF URL.
 * @return {string|null}
 */
function barCodeFromApexUrl(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get("bar_code") ||
      u.searchParams.get("barcode") || null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {Buffer} buf Downloaded bytes.
 * @return {boolean}
 */
function isPdfBuffer(buf) {
  return !!(buf && buf.length >= 4 &&
    buf[0] === 0x25 && buf[1] === 0x50 &&
    buf[2] === 0x44 && buf[3] === 0x46);
}

/**
 * @param {string} url Signed Apex invoice PDF URL.
 * @return {Promise<object>} Download result with ok/buffer/error fields.
 */
async function fetchApexInvoicePdf(url) {
  try {
    const resp = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; InnovativeInvoiceBot/1.0)",
        "Accept": "application/pdf,*/*",
      },
    });
    const contentType = resp.headers.get("content-type") || "";
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        contentType,
        error: `HTTP ${resp.status}`,
      };
    }
    if (!isPdfBuffer(buffer)) {
      return {
        ok: false,
        status: resp.status,
        contentType,
        error: "Response is not a PDF",
      };
    }
    return {ok: true, buffer, status: resp.status, contentType};
  } catch (err) {
    return {ok: false, error: err.message || String(err)};
  }
}

/**
 * @param {object} args payload, subject, from.
 * @return {Promise<object>} handled flag plus optional pdfs/urls/errors.
 */
async function fetchInvoicePdfsFromEmail(args) {
  const payload = args && args.payload;
  const subject = args && args.subject || "";
  const from = args && args.from || "";
  const html = extractEmailHtml(payload);
  const text = extractEmailPlain(payload) ||
    html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  if (!isApexCapitalEmail(subject, from, html, text)) {
    return {handled: false};
  }

  const urls = extractApexInvoicePdfUrls(html || text);
  if (!urls.length) {
    return {
      handled: true,
      ok: false,
      urls: [],
      errors: [
        "Apex email detected but no ViewPDFDocument invoice links found",
      ],
    };
  }

  const pdfs = [];
  const errors = [];
  for (const url of urls) {
    const barCode = barCodeFromApexUrl(url) || String(pdfs.length + 1);
    const result = await fetchApexInvoicePdf(url);
    if (!result.ok || !result.buffer) {
      errors.push(`${barCode}: ${result.error || "download failed"}`);
      continue;
    }
    pdfs.push({
      filename: `apex-invoice-${barCode}.pdf`,
      mimeType: "application/pdf",
      buffer: result.buffer,
      sourceUrl: url,
      barCode,
    });
  }

  return {
    handled: true,
    ok: pdfs.length > 0,
    pdfs,
    urls,
    errors: errors.length ? errors : undefined,
  };
}

module.exports = {
  extractEmailHtml,
  extractEmailPlain,
  isApexCapitalEmail,
  extractApexInvoicePdfUrls,
  fetchApexInvoicePdf,
  fetchInvoicePdfsFromEmail,
  barCodeFromApexUrl,
  isPdfBuffer,
};
