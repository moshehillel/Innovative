/* eslint-disable no-console */
"use strict";

const report = require("../daily-activity-report");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const ts = (iso) => ({
  toDate: () => new Date(iso),
});

const sampleRows = [
  {
    id: "msg-aaa111111111",
    from: "billing@carrier.com",
    subject: "Invoice 12345",
    finalStatus: "already_processed",
    ignoreReason: "Message already processed, skipping",
    finishedAt: ts("2026-08-11T14:00:00Z"),
    outcome: "ignored",
  },
  {
    id: "msg-bbb222222222",
    from: "emodal@terminal.com",
    subject: "Today's eModal Broadcasts",
    finalStatus: "emodal_broadcast_ignored",
    summary: "Ignored — eModal/terminal broadcast",
    finishedAt: ts("2026-08-11T15:30:00Z"),
    outcome: "ignored",
  },
  {
    id: "msg-ccc333333333",
    from: "NOA@rtsinc.com",
    subject: "RTS Financial NOA",
    finalStatus: "noa_ignored",
    ignoreReason: "Notice of assignment only",
    finishedAt: ts("2026-08-11T16:00:00Z"),
    outcome: "ignored",
  },
  {
    id: "msg-ddd444444444",
    from: "bank@zelle.com",
    subject: "Payment received",
    finalStatus: "payment_notification_ignored",
    finishedAt: ts("2026-08-11T10:00:00Z"),
    outcome: "ignored",
  },
];

check("categorize already_processed",
    report.categorizeIgnoredEmail(sampleRows[0]) === "already_processed");
check("label payment notification",
    report.labelIgnoredCategory("payment_notification_ignored") ===
    "Payment notification");
check("describe uses ignoreReason",
    report.describeIgnoredReason(sampleRows[0]).includes("already processed"));
check("describe falls back to summary",
    report.describeIgnoredReason(sampleRows[1]).includes("eModal"));

const groups = report.groupIgnoredEmails(sampleRows);
check("groups by category", groups.length === 4);
check("sorted labels ascending",
    groups[0].label.localeCompare(groups[groups.length - 1].label) <= 0);

const html = report.buildIgnoredEmailsReportHtml(groups, {
  hours: 24,
  label: "Aug 11, 2026, 6:00 PM",
});
check("html includes subject lines", html.includes("Invoice 12345"));
check("html includes category headers", html.includes("Already processed"));
check("html includes message id tail", html.includes("a111111111"));
check("html mentions mis-ignored review", html.includes("mis-ignored"));

const emptyHtml = report.buildIgnoredEmailsReportHtml([], {
  hours: 24,
  label: "Aug 11, 2026, 6:00 PM",
});
check("empty report", emptyHtml.includes("No ignored emails"));

console.log(failures ? `\n${failures} test(s) failed` : "\nAll tests passed");
process.exit(failures ? 1 : 0);
