#!/usr/bin/env node
/**
 * Debug harness for saveBooking sales rep swap.
 * Usage: node scripts/test-save-booking-swap.js [bookingId]
 */
"use strict";

const fs = require("fs");
const path = require("path");

const envFile = path.join(__dirname, "..", ".env.tai-invoice-automation");
for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 1) continue;
  if (!process.env[t.slice(0, eq).trim()]) {
    process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
}

const bridge = require("../primus-ui-bridge");
bridge.init({
  db: {doc: () => ({get: async () => ({exists: false}), set: async () => {}})},
  writeLog: async () => {},
});

let sessionCookie = null;

async function login() {
  const manageUrl = process.env.PRIMUS_UI_MANAGE_URL;
  const body = new URLSearchParams({
    action: "login", logout: "false",
    loginUsername: process.env.PRIMUS_USERNAME,
    loginPassword: process.env.PRIMUS_PASSWORD,
    browser: "Chrome", browserVersion: "149", os: "Windows",
  });
  const lr = await fetch(manageUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body, redirect: "manual",
  });
  sessionCookie = (lr.headers.get("set-cookie") || "")
      .match(/PHPSESSID=([^;]+)/i)[1];
}

function encodeExt(params, mode) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (mode === "ext") {
      if (value === false) continue;
      if (Array.isArray(value) && !value.length) continue;
      if (typeof value === "boolean") {
        form.set(key, value ? "true" : "false");
        continue;
      }
      if (typeof value === "object") {
        form.set(key, JSON.stringify(value));
        continue;
      }
      form.set(key, String(value));
      continue;
    }
    if (typeof value === "boolean") {
      form.set(key, value ? "true" : "false");
    } else if (typeof value === "object") {
      form.set(key, JSON.stringify(value));
    } else {
      form.set(key, String(value));
    }
  }
  return form;
}

async function post(params, mode = "std") {
  if (!sessionCookie) await login();
  const manageUrl = process.env.PRIMUS_UI_MANAGE_URL;
  const form = encodeExt(params, mode);
  const resp = await fetch(manageUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Cookie: `PHPSESSID=${sessionCookie}`,
      Origin: "https://shipprimus.com",
      Referer: "https://shipprimus.com/PRIMUS/trunk/",
    },
    body: form.toString(),
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    // ignore
  }
  return {text, json, formLen: form.toString().length};
}

async function uiSession(bookingId, slId) {
  await post({action: "checkCustomerBOLLocked", bookingId, SLId: slId});
  await post({action: "getBooking", id: bookingId});
  await post({action: "getBookingSalesRep", recordId: bookingId});
}

async function main() {
  const bookingId = process.argv[2] || "4169594";
  const uiFile = path.join(__dirname, "ui-save-back.json");
  if (!fs.existsSync(uiFile)) {
    console.error("Missing ui-save-back.json — paste browser capture first");
    process.exit(1);
  }
  const uiTemplate = JSON.parse(fs.readFileSync(uiFile, "utf8"));

  console.log("=== 1. UI session + replay template no-op (ext encode) ===");
  await login();
  await uiSession(bookingId, uiTemplate.customerId);
  const noop = {...uiTemplate};
  let r = await post(noop, "ext");
  console.log("noop ext:", r.json || r.text.slice(0, 150));

  console.log("\n=== 2. Built params via bridge ===");
  await uiSession(bookingId, uiTemplate.customerId);
  const fr = await bridge.fetchManageBooking(bookingId);
  const catalog = await bridge.fetchAllCorporateSalesPeople();
  const built = bridge.buildSaveBookingParams(fr.booking, catalog.find((x) =>
    String(x.id) === "1779"));
  r = await post(built, "ext");
  console.log("built ext:", r.json || r.text.slice(0, 150));
  console.log("reps:", await bridge.getBookingSalesRep(bookingId));

  console.log("\n=== 3. Hybrid: UI template + fresh getBooking (typed) ===");
  await uiSession(bookingId, uiTemplate.customerId);
  const hybrid = coerceBookingToUiSave(fr.booking, uiTemplate);
  hybrid.bookingSalesRepId = "[1779]";
  hybrid.bookingSalesRepNames = "ATK Sales .10";
  r = await post(hybrid, "ext");
  console.log("hybrid ext:", r.json || r.text.slice(0, 150));
  console.log("reps:", await bridge.getBookingSalesRep(bookingId));

  if ((await bridge.getBookingSalesRep(bookingId))
      .some((rep) => String(rep.salesPersonId) === "1779")) {
    console.log("\n=== 4. Swap back to .25 ===");
    await uiSession(bookingId, uiTemplate.customerId);
    const fr2 = await bridge.fetchManageBooking(bookingId);
    const back = coerceBookingToUiSave(fr2.booking, uiTemplate);
    back.bookingSalesRepId = "[1774]";
    back.bookingSalesRepNames = "ATK Sales .25";
    r = await post(back, "ext");
    console.log("back:", r.json || r.text.slice(0, 150));
    console.log("final:", await bridge.getBookingSalesRep(bookingId));
  }
}

/**
 * Map getBooking fields onto UI save shape using template types.
 * @param {object} booking
 * @param {object} template
 * @return {object}
 */
function coerceBookingToUiSave(booking, template) {
  const b = booking || {};
  const out = {...template};
  const skip = new Set([
    "action", "origin", "editedFrom", "actionEnvironment",
    "bookingSalesRepId", "bookingSalesRepNames",
  ]);
  for (const key of Object.keys(template)) {
    if (skip.has(key)) continue;
    if (key === "bookingId") {
      out[key] = String(b.id || template[key]);
      continue;
    }
    if (key === "bookingBOL") {
      out[key] = String(b.BOL || template[key]);
      continue;
    }
    if (key === "customerId") {
      out[key] = String(b.thirdPartyShippingLocationId || template[key]);
      continue;
    }
    if (!(key in b)) continue;
    out[key] = coerceToTemplateType(b[key], template[key]);
  }
  out.action = "saveBooking";
  out.origin = "BOLForm";
  out.actionEnvironment = "Primus";
  out.editedFrom = "Trackings Lookup Primus";
  return out;
}

/**
 * @param {*} raw
 * @param {*} sample Template value for type hint.
 * @return {*}
 */
function coerceToTemplateType(raw, sample) {
  if (sample === null) return raw ? String(raw) : null;
  if (typeof sample === "boolean") {
    if (raw === true || raw === 1 || raw === "1" || raw === "true") return true;
    if (raw === false || raw === 0 || raw === "0" || raw === "false" ||
        raw === "" || raw == null) {
      return false;
    }
    return Boolean(raw);
  }
  if (typeof sample === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  if (Array.isArray(sample)) {
    if (Array.isArray(raw)) return raw;
    if (raw === "" || raw == null) return [];
    try {
      const parsed = JSON.parse(String(raw));
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  if (sample === "null" && (raw == null || raw === "null")) return "null";
  if (typeof sample === "string") {
    if (raw == null && sample === "") return "";
    if (raw == null && sample === "null") return "null";
    return String(raw);
  }
  return raw;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
