/* eslint-disable no-console */
"use strict";

const queue = require("../mail-intake-queue");
const report = require("../daily-activity-report");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const received = "2026-08-11T12:40:12.000Z";
const summary = queue.buildIntakeSummary({
  itemSummaries: [{
    finalStatus: "already_billed_skipped",
    loadNumber: "265637",
    invoiceId: null,
  }],
  receivedDateTime: received,
});
check("summary includes skipped already billed in Primus",
    /carrier bill and customer invoice already in Primus/i.test(summary));
check("summary includes received timestamp",
    /received /i.test(summary) && /ET/i.test(summary));
check("summary includes Aug 11 date",
    /Aug 11/i.test(summary));

const multi = queue.buildIntakeSummary({
  attachmentCount: 10,
  itemSummaries: [
    {finalStatus: "processing", invoiceId: "inv1"},
    {finalStatus: "processing", invoiceId: "inv2"},
    {finalStatus: "processing", invoiceId: "inv3"},
    {finalStatus: "processing", invoiceId: "inv4"},
    {finalStatus: "processing", invoiceId: "inv5"},
    {finalStatus: "processing", invoiceId: "inv6"},
    {finalStatus: "processing", invoiceId: "inv7"},
    {finalStatus: "processing", invoiceId: "inv8"},
    {finalStatus: "processing", invoiceId: "inv9"},
    {finalStatus: "already_billed_skipped", invoiceId: null},
  ],
  _rebuildSummary: true,
});
check("summary shows 9 processed 1 billed skip",
    /9 processed/.test(multi) &&
    /1 skipped \(carrier bill and customer invoice already in Primus\)/
        .test(multi));

const underExtract = queue.computeIntakeOutcomeCounts({
  attachmentCount: 10,
  itemSummaries: [
    {finalStatus: "processing", invoiceId: "a"},
    {finalStatus: "processing", invoiceId: "b"},
    {finalStatus: "processing", invoiceId: "c"},
    {finalStatus: "processing", invoiceId: "d"},
    {finalStatus: "processing", invoiceId: "e"},
    {finalStatus: "processing", invoiceId: "f"},
    {finalStatus: "processing", invoiceId: "g"},
  ],
});
check("under-extract flags 3 unaccounted of 10",
    underExtract.processedCount === 7 &&
    underExtract.attachmentCount === 10 &&
    underExtract.unaccountedCount === 3);

const underSummary = queue.buildIntakeSummary(Object.assign({
  summary: null,
  _rebuildSummary: true,
}, underExtract, {
  itemSummaries: [
    {finalStatus: "processing", invoiceId: "a"},
    {finalStatus: "processing", invoiceId: "b"},
    {finalStatus: "processing", invoiceId: "c"},
    {finalStatus: "processing", invoiceId: "d"},
    {finalStatus: "processing", invoiceId: "e"},
    {finalStatus: "processing", invoiceId: "f"},
    {finalStatus: "processing", invoiceId: "g"},
  ],
}));
check("summary includes unaccounted attachment gap",
    /7 processed/.test(underSummary) &&
    /3 unaccounted \(of 10 attachments\)/.test(underSummary));

const multiInvoiceOnePdf = queue.computeIntakeOutcomeCounts({
  attachmentCount: 1,
  itemSummaries: Array.from({length: 9}, () => ({
    finalStatus: "processing", invoiceId: "x",
  })).concat([{finalStatus: "already_billed_skipped"}]),
});
check("multi-invoice single PDF does not invent unaccounted",
    multiInvoiceOnePdf.processedCount === 9 &&
    multiInvoiceOnePdf.skippedCount === 1 &&
    multiInvoiceOnePdf.unaccountedCount === 0);

const parsedTs = queue.toReceivedTimestamp(received);
check("toReceivedTimestamp parses ISO string",
    parsedTs && typeof parsedTs.toDate === "function" &&
    parsedTs.toDate().toISOString() === received);
check("toReceivedTimestamp rejects empty",
    queue.toReceivedTimestamp(null) === null &&
    queue.toReceivedTimestamp("") === null);

const fmt = report.fmtDiscoveredAt(received);
check("fmtDiscoveredAt includes seconds and ET",
    /\d{1,2}:\d{2}:\d{2}/.test(fmt) && /ET/.test(fmt));

const display = report.intakeDisplayTime({
  receivedDateTime: received,
  discoveredAt: {toDate: () => new Date("2026-08-11T13:00:00Z")},
});
check("intakeDisplayTime prefers receivedDateTime",
    display === received);

const processedOnly = queue.buildIntakeSummary({
  itemSummaries: [{
    finalStatus: "processing",
    invoiceId: "B19BQkqEr2wOuKlUCgxc",
    loadNumber: "266943",
  }],
  _rebuildSummary: true,
});
check("processing invoice is not labeled already in Primus",
    /processed 1 invoice/.test(processedOnly) &&
    !/already in Primus/i.test(processedOnly));

const alreadyHandled = queue.buildIntakeSummary({
  itemSummaries: [{
    finalStatus: "already_processed_skipped",
    loadNumber: "266943",
    invoiceId: "B19BQkqEr2wOuKlUCgxc",
  }],
  _rebuildSummary: true,
});
check("already_processed_skipped does not say already in Primus",
    /already processed this email/i.test(alreadyHandled) &&
    !/already in Primus/i.test(alreadyHandled));

const staleSummary = queue.buildIntakeSummary({
  summary: "Processed email — 1 skipped (already in Primus)",
  itemSummaries: [{
    finalStatus: "processing",
    invoiceId: "B19BQkqEr2wOuKlUCgxc",
  }],
  _rebuildSummary: true,
});
check("rebuild ignores stale already-in-Primus summary",
    /processed 1 invoice/.test(staleSummary) &&
    !/already in Primus/i.test(staleSummary));

const html = report.buildInboxDigestHtml([{
  from: "OpenInvoiceAlert@ediexpressinc.com",
  subject: "New Open Invoices ",
  intakeStatus: "completed",
  summary: multi,
  receivedDateTime: received,
}], {hours: 24, label: "Aug 12, 2026, 3:00 PM"});
check("digest column says Received (ET)",
    html.includes("Received (ET)"));
check("digest includes processed/skipped counts",
    html.includes("9 processed") && html.includes("1 skipped"));

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("All intake summary received-time checks passed.");
