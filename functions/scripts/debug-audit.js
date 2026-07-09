"use strict";

/**
 * Static/runtime audit for known multi-tenant and workflow bugs.
 * Does not require credentials or live Firebase.
 */

const fs = require("fs");
const path = require("path");

const LOG = path.join(__dirname, "..", "..", "debug-472625.log");
const ENDPOINT =
  "http://127.0.0.1:7674/ingest/ad772417-15ae-4fbe-a1a7-3fc5263647c8";

function emit(hypothesisId, message, data) {
  const entry = {
    sessionId: "472625",
    hypothesisId,
    location: "scripts/debug-audit.js",
    message,
    data,
    timestamp: Date.now(),
    runId: "audit-1",
  };
  fs.appendFileSync(LOG, JSON.stringify(entry) + "\n");
  fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "472625",
    },
    body: JSON.stringify(entry),
  }).catch(() => {});
}

const indexSrc = fs.readFileSync(
    path.join(__dirname, "..", "index.js"), "utf8");
const taiSrc = fs.readFileSync(
    path.join(__dirname, "..", "tai.js"), "utf8");
const primusSrc = fs.readFileSync(
    path.join(__dirname, "..", "innovative-primus.js"), "utf8");

// H1: continueWorkflow hardcodes Primus URL
const h1 = /continueWorkflow[\s\S]{0,800}processPrimusWorkflow/.test(indexSrc);
emit("H1", "continueWorkflow routes to Primus only", {confirmed: h1});

// H2: continueWorkflow uses unprefixed invoices collection
const h2 = /exports\.continueWorkflow[\s\S]{0,400}db\.collection\("invoices"\)/.test(indexSrc);
emit("H2", "continueWorkflow reads unprefixed invoices", {confirmed: h2});

// H3: setCustomerRate uses unprefixed invoices collection
const h3 = /exports\.setCustomerRate[\s\S]{0,400}db\.collection\("invoices"\)/.test(indexSrc);
emit("H3", "setCustomerRate reads unprefixed invoices", {confirmed: h3});

// H4: setCustomerRate only updates primusSteps not taiSteps
const h4 = /setCustomerRate[\s\S]{0,2000}primusSteps/.test(indexSrc) &&
  !/setCustomerRate[\s\S]{0,2000}taiSteps/.test(indexSrc);
emit("H4", "setCustomerRate skips taiSteps update", {confirmed: h4});

// H5: processTaiWorkflow documents resumeFrom but never uses it
const h5Doc = /Body: \{ invoiceId, resumeFrom\?\}/.test(taiSrc);
const h5Use = /resumeFrom/.test(
    taiSrc.replace(/Body: \{ invoiceId, resumeFrom\?\}/, ""));
emit("H5", "processTaiWorkflow ignores resumeFrom", {
  documented: h5Doc,
  usesResumeFrom: h5Use,
  confirmed: h5Doc && !h5Use,
});

// H6: innovative-primus uses unprefixed invoices (breaks prefixed tenants)
const h6 = /db\.collection\("invoices"\)/.test(primusSrc);
emit("H6", "innovative-primus uses unprefixed invoices", {confirmed: h6});

// H7: tai.js still requires init() before workflow helpers
let h7 = false;
try {
  delete require.cache[require.resolve("../tai.js")];
  const tai = require("../tai.js");
  tai.validateAmountWithTai(1, 100, {totalBuy: 100}).catch(() => {});
  try {
    tai.processTaiWorkflow;
    h7 = true; // s() throws only at handler runtime
  } catch (e) {
    h7 = e.message.includes("init()");
  }
} catch (e) {
  h7 = String(e.message).includes("init()");
}
emit("H7", "tai.js depends on init() injection", {confirmed: h7});

// H8: postTaiBillVariance never called from workflow on amount mismatch
const h8 = !/postTaiBillVariance/.test(
    taiSrc.match(/processTaiWorkflow[\s\S]*/)[0]);
emit("H8", "amount mismatch does not call TAI bill variance", {confirmed: h8});

console.log("Audit complete — see debug-472625.log");
