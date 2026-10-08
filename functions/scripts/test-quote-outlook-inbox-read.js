/* eslint-disable no-console */
"use strict";

/**
 * Quote Outlook inbox: quoted mail stays unread, and a read-inclusive
 * list omits the isRead filter while still deduping by message id.
 */

const fs = require("fs");
const path = require("path");
const outlookMail = require("../outlook-mail");
const quoteMailQueue = require("../quote-mail-queue");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const outlookSrc = fs.readFileSync(
    path.join(__dirname, "../quote-outlook.js"), "utf8");
const drainStart = outlookSrc.indexOf("async function drainQuoteQueue");
const drainEnd = outlookSrc.indexOf("async function syncDispatcherInbox");
const drain = outlookSrc.slice(drainStart, drainEnd);
check("drain does not mark the Outlook message read",
    drainStart >= 0 && drainEnd > drainStart &&
    !drain.includes("removeLabelIds") &&
    !drain.includes("isRead"));

const dashSrc = fs.readFileSync(
    path.join(__dirname, "../quote-dashboard.js"), "utf8");
const schedStart = dashSrc.indexOf(
    "async function handleSyncQuoteOutlookInboxes");
const schedEnd = dashSrc.indexOf("async function handleCreateBulkRateShopJob");
const sched = dashSrc.slice(schedStart, schedEnd);
check("scheduled sync always includes already-read mail",
    schedStart >= 0 && schedEnd > schedStart &&
    sched.includes("const includeRead = true;"));

check("dedupe key is outlook_{dispatcherId}_{messageId}",
    quoteMailQueue.queueDocId("disp1", "AAMkAG") ===
      "outlook_disp1_AAMkAG");

const tokens = {
  access_token: "test-token",
  expires_at: Date.now() + 60 * 60 * 1000,
};
const calls = [];
const origFetch = global.fetch;
global.fetch = async (url, opts) => {
  calls.push({
    url: String(url),
    method: (opts && opts.method) || "GET",
    body: opts && opts.body ? String(opts.body) : "",
  });
  return {
    ok: true,
    status: 200,
    headers: {get: () => "application/json"},
    json: async () => ({value: []}),
    text: async () => "",
  };
};

/**
 * @param {string} url Request URL.
 * @return {string}
 */
function decoded(url) {
  return decodeURIComponent(url).replace(/\+/g, " ");
}

(async () => {
  try {
    const client = outlookMail.createOutlookMailClient(tokens, async () => {});
    await client.users.messages.list({
      maxResults: 40,
      includeRead: true,
      q: "after:2026/10/1",
    });
    const readInclusive = decoded(calls[0].url);
    check("includeRead list has no isRead filter",
        !readInclusive.includes("isRead"));
    check("includeRead list still windows by received time",
        readInclusive.includes("receivedDateTime ge"));
    check("includeRead list keeps newest 40",
        readInclusive.includes("$top=40"));
    check("listing mail does not PATCH isRead",
        calls[0].method === "GET" && !calls[0].body.includes("isRead"));

    calls.length = 0;
    await client.users.messages.list({
      maxResults: 40,
      includeRead: false,
      q: "after:2026/10/1",
    });
    const unreadOnly = decoded(calls[0].url);
    check("unread-only list still filters isRead eq false",
        unreadOnly.includes("isRead eq false"));
  } finally {
    global.fetch = origFetch;
  }

  if (failures) {
    console.log(`${failures} failed`);
    process.exit(1);
  }
  console.log("all passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
