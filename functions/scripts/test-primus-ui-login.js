#!/usr/bin/env node
/**
 * One-off: POST manage.php action=login and report PHPSESSID (masked).
 * Usage: node scripts/test-primus-ui-login.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

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

const manageUrl = process.env.PRIMUS_UI_MANAGE_URL ||
  "https://shipprimus.com/PRIMUS/trunk/manage.php";
const username = process.env.PRIMUS_UI_USERNAME ||
  process.env.PRIMUS_USERNAME || "";
const password = process.env.PRIMUS_UI_PASSWORD ||
  process.env.PRIMUS_PASSWORD || "";

function maskSession(id) {
  if (!id || id.length < 8) return "(too short)";
  return `${id.slice(0, 4)}...${id.slice(-4)} (${id.length} chars)`;
}

function parsePhpSessId(setCookieHeader) {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(/PHPSESSID=([^;,\s]+)/i);
  return match ? match[1] : null;
}

function extractSessionFromResponse(resp) {
  const raw = resp.headers.get("set-cookie");
  if (raw) {
    const id = parsePhpSessId(raw);
    if (id) return id;
  }
  const getSetCookie = resp.headers.getSetCookie &&
    resp.headers.getSetCookie();
  if (Array.isArray(getSetCookie)) {
    for (const line of getSetCookie) {
      const id = parsePhpSessId(line);
      if (id) return id;
    }
  }
  return null;
}

async function main() {
  if (!username || !password) {
    console.error("FAIL: PRIMUS_USERNAME/PASSWORD not set in env file");
    process.exit(1);
  }

  console.log("POST", manageUrl);
  console.log("action=login user=", username);

  const body = new URLSearchParams({
    action: "login",
    logout: "false",
    loginUsername: username,
    loginPassword: password,
    browser: "Chrome",
    browserVersion: "149",
    os: "Windows",
  });

  let resp;
  try {
    resp = await fetch(manageUrl, {
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
  } catch (err) {
    console.error("FAIL: network error —", err.message);
    console.error("(NetFree or firewall may block shipprimus.com from this PC)");
    process.exit(2);
  }

  const session = extractSessionFromResponse(resp);
  const text = await resp.text().catch(() => "");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = null;
  }

  console.log("HTTP status:", resp.status);
  console.log("Set-Cookie present:", !!resp.headers.get("set-cookie"));
  if (json) {
    console.log("JSON body:", JSON.stringify(json).slice(0, 300));
  } else {
    console.log("Body preview:", text.slice(0, 200).replace(/\s+/g, " "));
  }

  if (session) {
    console.log("SUCCESS: PHPSESSID =", maskSession(session));
    process.exit(0);
  }

  console.error("FAIL: no PHPSESSID in response");
  process.exit(1);
}

main();
