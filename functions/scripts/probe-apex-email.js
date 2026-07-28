#!/usr/bin/env node
/**
 * Fetch a Gmail message, extract URLs, test Apex invoice links.
 * Usage: node scripts/probe-apex-email.js [gmailMessageId]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const {execSync} = require("child_process");
const {google} = require("googleapis");

const envFile = path.join(__dirname, "..", ".env.tai-invoice-automation");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const MESSAGE_ID = process.argv[2] || "19faa0fe2cbb1674";

/**
 * @param {object} field Firestore value field.
 * @return {*}
 */
function firestoreVal(field) {
  if (!field) return null;
  if (field.stringValue != null) return field.stringValue;
  if (field.integerValue != null) return Number(field.integerValue);
  if (field.doubleValue != null) return Number(field.doubleValue);
  if (field.booleanValue != null) return field.booleanValue;
  if (field.mapValue) {
    const out = {};
    for (const [k, v] of Object.entries(field.mapValue.fields || {})) {
      out[k] = firestoreVal(v);
    }
    return out;
  }
  return null;
}

/**
 * @return {Promise<object>}
 */
async function loadGmailTokens() {
  const gcloudToken = execSync("gcloud auth print-access-token", {
    encoding: "utf8",
  }).trim();
  const url =
    "https://firestore.googleapis.com/v1/projects/tai-invoice-automation/" +
    "databases/(default)/documents/settings/gmail";
  const resp = await fetch(url, {
    headers: {Authorization: `Bearer ${gcloudToken}`},
  });
  if (!resp.ok) {
    throw new Error(`Firestore ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const doc = await resp.json();
  const data = {};
  for (const [k, v] of Object.entries(doc.fields || {})) {
    data[k] = firestoreVal(v);
  }
  return data.tokens || data;
}

/**
 * @param {object} part Gmail MIME part.
 * @return {string}
 */
function decodePart(part) {
  if (!part.body || !part.body.data) return "";
  return Buffer.from(
      part.body.data.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
  ).toString("utf8");
}

/**
 * @param {object[]} parts MIME parts.
 * @param {object[]} out Accumulator.
 * @return {object[]}
 */
function collectBodies(parts, out = []) {
  if (!parts) return out;
  for (const p of parts) {
    if (p.mimeType === "text/html" || p.mimeType === "text/plain") {
      out.push({mime: p.mimeType, text: decodePart(p)});
    }
    if (p.parts) collectBodies(p.parts, out);
  }
  return out;
}

/**
 * @param {object[]} parts MIME parts.
 * @param {object[]} out Accumulator.
 * @return {object[]}
 */
function collectAttachments(parts, out = []) {
  if (!parts) return out;
  for (const p of parts) {
    if (p.filename && p.body && p.body.attachmentId) {
      out.push({
        filename: p.filename,
        mime: p.mimeType,
        id: p.body.attachmentId,
      });
    }
    if (p.parts) collectAttachments(p.parts, out);
  }
  return out;
}

/**
 * @param {string} html HTML body.
 * @return {string[]}
 */
function extractUrls(html) {
  const hrefs = [];
  const hrefRe = /href=["']([^"']+)["']/gi;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    hrefs.push(m[1].trim());
  }
  const plainRe = /https?:\/\/[^\s"'<>]+/gi;
  const plain = html.match(plainRe) || [];
  const all = [...hrefs, ...plain]
      .map((u) => u.replace(/&amp;/g, "&").replace(/[)>.,;]+$/g, ""))
      .filter((u) => u.startsWith("http"));
  return [...new Set(all)];
}

/**
 * @param {string} url URL to probe.
 * @return {Promise<object>}
 */
async function probeUrl(url) {
  try {
    const resp = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/pdf,*/*",
      },
    });
    const ct = resp.headers.get("content-type") || "";
    const finalUrl = resp.url;
    const buf = Buffer.from(await resp.arrayBuffer());
    const isPdf = ct.includes("pdf") ||
      buf.slice(0, 5).toString("latin1") === "%PDF-";
    const text = isPdf ? "" : buf.toString("utf8").slice(0, 4000);
    const pdfLinks = [];
    if (!isPdf) {
      const linkRe = /href=["']([^"']+\.pdf[^"']*)["']/gi;
      let lm;
      while ((lm = linkRe.exec(text)) !== null) {
        pdfLinks.push(lm[1]);
      }
      const apexLinkRe = /href=["']([^"']*(?:apex|invoice|document)[^"']*)["']/gi;
      while ((lm = apexLinkRe.exec(text)) !== null) {
        pdfLinks.push(lm[1]);
      }
    }
    return {
      url,
      finalUrl,
      status: resp.status,
      contentType: ct,
      bytes: buf.length,
      isPdf,
      pdfHeader: buf.slice(0, 8).toString("latin1"),
      title: (text.match(/<title[^>]*>([^<]+)/i) || [])[1] || null,
      snippet: isPdf ? "(PDF binary)" : text.replace(/\s+/g, " ").slice(0, 300),
      pdfLinks: [...new Set(pdfLinks)].slice(0, 10),
    };
  } catch (err) {
    return {url, error: err.message};
  }
}

async function main() {
  const tokens = await loadGmailTokens();
  const oauth2 = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI,
  );
  oauth2.setCredentials(tokens);
  const gmail = google.gmail({version: "v1", auth: oauth2});

  const msg = await gmail.users.messages.get({
    userId: "me",
    id: MESSAGE_ID,
    format: "full",
  });
  const headers = msg.data.payload.headers || [];
  const subject = (headers.find((h) => h.name === "Subject") || {}).value;
  const from = (headers.find((h) => h.name === "From") || {}).value;
  console.log("Message:", MESSAGE_ID);
  console.log("Subject:", subject);
  console.log("From:", from);

  const bodies = collectBodies(msg.data.payload.parts || [msg.data.payload]);
  const html = bodies.find((b) => b.mime === "text/html") || bodies[0];
  const text = html ? html.text : "";
  const attachments = collectAttachments(msg.data.payload.parts || []);
  console.log("\nAttachments:", attachments.length ?
    attachments.map((a) => `${a.filename} (${a.mime})`).join(", ") :
    "(none)");

  const urls = extractUrls(text);
  console.log("\nURLs in body:", urls.length);
  urls.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));

  const interesting = urls.filter((u) =>
    /apex|invoice|document|pay|factor|portal|view/i.test(u));
  const toTest = interesting.length ? interesting : urls;

  console.log("\n--- Link probe ---");
  for (const url of toTest.slice(0, 8)) {
    console.log("\nProbing:", url.slice(0, 120));
    const result = await probeUrl(url);
    console.log(JSON.stringify(result, null, 2));
    for (const pl of result.pdfLinks || []) {
      let abs = pl;
      if (pl.startsWith("/")) {
        const base = new URL(result.finalUrl || url);
        abs = `${base.origin}${pl}`;
      } else if (!pl.startsWith("http")) {
        abs = new URL(pl, result.finalUrl || url).href;
      }
      console.log("  nested link:", abs.slice(0, 120));
      const nested = await probeUrl(abs);
      console.log("  nested result:", JSON.stringify({
        status: nested.status,
        contentType: nested.contentType,
        isPdf: nested.isPdf,
        bytes: nested.bytes,
        error: nested.error,
      }));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
