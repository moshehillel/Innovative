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
const quoteOutlook = require("../quote-outlook");

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

const nowMs = Date.parse("2026-10-08T20:00:00.000Z");
check("missing watermark looks back 10 minutes, not a multi-day backlog",
    quoteOutlook.quoteSyncReceivedAfter(null, nowMs).toISOString() ===
      "2026-10-08T19:50:00.000Z");
check("stored watermark overlaps the last check by 2 minutes",
    quoteOutlook.quoteSyncReceivedAfter(
        "2026-10-08T20:00:00.000Z", nowMs).toISOString() ===
      "2026-10-08T19:58:00.000Z");
check("overnight gap keeps yesterday 7pm minus 2 minutes",
    quoteOutlook.quoteSyncReceivedAfter(
        "2026-10-07T23:00:00.000Z",
        Date.parse("2026-10-08T13:00:00.000Z")).toISOString() ===
      "2026-10-07T22:58:00.000Z");
check("finished list stores the check time",
    quoteOutlook.quoteSyncWatermarkToStore(
        new Date("2026-10-08T13:00:00.000Z"),
        [{receivedDateTime: "2026-10-07T23:05:00.000Z"}],
        false) === "2026-10-08T13:00:00.000Z");
check("cut-off list stores only the newest listed received time",
    quoteOutlook.quoteSyncWatermarkToStore(
        new Date("2026-10-08T13:00:00.000Z"),
        [
          {receivedDateTime: "2026-10-07T23:05:00.000Z"},
          {receivedDateTime: "2026-10-08T02:00:00.000Z"},
        ],
        true) === "2026-10-08T02:00:00.000Z");
check("cut-off list with no received times leaves the watermark",
    quoteOutlook.quoteSyncWatermarkToStore(
        new Date("2026-10-08T13:00:00.000Z"),
        [{id: "x"}],
        true) === null);
check("retry hold stays 1 second before the unstored message",
    quoteOutlook.quoteSyncWatermarkToStore(
        new Date("2026-10-09T14:04:00.000Z"),
        [{receivedDateTime: "2026-10-09T13:40:00.000Z"}],
        false,
        Date.parse("2026-10-09T13:40:00.000Z")) ===
      "2026-10-09T13:39:59.000Z");
check("retry without a received time leaves the watermark",
    quoteOutlook.quoteSyncWatermarkToStore(
        new Date("2026-10-09T14:04:00.000Z"),
        [],
        false,
        0) === null);
const syncStart = outlookSrc.indexOf("async function syncDispatcherInbox");
const syncEnd = outlookSrc.indexOf("function extractPlainBody");
const syncBody = outlookSrc.slice(syncStart, syncEnd);
check("sync pages with nextPageToken inside the since-last-check window",
    syncStart >= 0 && syncEnd > syncStart &&
    syncBody.includes("nextPageToken") &&
    syncBody.includes("ascending: true") &&
    syncBody.includes("QUOTE_SYNC_MAX_PAGES"));
check("sync does not use a 7-day received window",
    !outlookSrc.includes("7 * 24 * 60 * 60 * 1000") &&
    outlookSrc.includes("quoteSyncReceivedAfter") &&
    outlookSrc.includes("saveQuoteSyncWatermark"));
check("sync holds the watermark for messages left to retry",
    syncBody.includes("noteRetry") &&
    syncBody.includes("holdBeforeMs"));
const intakeSrc = fs.readFileSync(
    path.join(__dirname, "../quote-intake.js"), "utf8");
const classifyStart = intakeSrc.indexOf("async function classifyIsQuoteRequest");
const classifyEnd = intakeSrc.indexOf("module.exports", classifyStart);
const classify = intakeSrc.slice(classifyStart, classifyEnd);
check("quote classify disables luna reasoning so JSON is returned",
    classify.includes("reasoning_effort: \"none\""));

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
      includeRead: true,
      receivedAfter: new Date("2026-10-08T19:58:00.000Z"),
    });
    const watermarked = decoded(calls[0].url);
    check("watermark list uses receivedDateTime gt and no isRead filter",
        watermarked.includes("receivedDateTime gt 2026-10-08T19:58:00Z") &&
        !watermarked.includes("isRead"));
    check("watermark list keeps the 40-message cap",
        watermarked.includes("$top=40"));
    check("default watermark order stays newest first",
        watermarked.includes("$orderby=receivedDateTime desc"));

    calls.length = 0;
    await client.users.messages.list({
      maxResults: 40,
      includeRead: true,
      receivedAfter: new Date("2026-10-07T23:00:00.000Z"),
      ascending: true,
    });
    const overnight = decoded(calls[0].url);
    check("oldest-first list still starts at the stored check",
        overnight.includes("receivedDateTime gt 2026-10-07T23:00:00Z") &&
        overnight.includes("$orderby=receivedDateTime asc") &&
        overnight.includes("$top=40") &&
        !overnight.includes("isRead"));

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
