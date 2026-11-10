/* eslint-disable no-console */
"use strict";

const queue = require("../dashboard-queue");
const ops = require("../dashboard-ops");
const rate = require("../dashboard-customer-rate");

let failures = 0;

/**
 * @param {string} name Label.
 * @param {boolean} ok Pass.
 * @param {string} detail Failure detail.
 * @return {void}
 */
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok && detail) console.log(`  ${detail}`);
}

const now = Date.parse("2026-11-10T17:00:00Z");

const rows = [
  {
    id: "rate-269238",
    loadNumber: "269238",
    type: "missing_rate",
    issueType: "missing_rate",
    source: "dashboardTasks",
    status: "open",
    dispatcherKey: "jak",
    dispatcherEmail: "jak@innovativecarriers.com",
    createdAt: "2026-06-01T12:00:00Z",
    isUrgentOld: true,
  },
  {
    id: "charge-111",
    loadNumber: "111111",
    type: "additional_charge",
    issueType: "charge_mismatch",
    source: "additionalCharges",
    status: "open",
    dispatcherKey: "leo",
    createdAt: "2026-11-09T12:00:00Z",
    isUrgentOld: false,
  },
  {
    id: "dispute-269238",
    loadNumber: "269238",
    type: "additional_charge",
    source: "additionalCharges",
    chargePhase: "dispute",
    decision: "D",
    followUpStatus: "disputing",
    issueType: "charge_mismatch",
    status: "disputing",
    createdAt: "2026-06-02T12:00:00Z",
  },
];

function ids(result) {
  return result.page.items.map((row) => row.id).join(",");
}

const found = queue.selectOperationalRows(rows, {
  q: "269238",
  range: "year",
  now,
  chargePhase: "",
  issue: "charge_mismatch",
  dispatcher: "leo",
  sort: "newest",
  limit: 20,
});
check("search ignores issue and dispatcher filters",
    ids(found) === "rate-269238",
    ids(found));

const urgent = queue.selectOperationalRows(rows, {
  q: "269238",
  range: "year",
  now,
  chargePhase: "",
  issue: "all",
  sort: "urgent",
  limit: 20,
});
check("urgent sort still returns the non-page match",
    urgent.page.items.some((row) => row.id === "rate-269238") &&
    !urgent.page.items.some((row) => row.id === "dispute-269238"),
    ids(urgent));

const dispute = queue.selectOperationalRows(rows, {
  q: "269238",
  range: "year",
  now,
  chargePhase: "dispute",
  issue: "all",
  sort: "newest",
  limit: 20,
});
check("search stays on the dispute tab",
    ids(dispute) === "dispute-269238",
    ids(dispute));

const week = queue.selectOperationalRows(rows, {
  q: "269238",
  range: "week",
  now,
  chargePhase: "",
  issue: "all",
  sort: "newest",
  limit: 20,
});
check("search respects the selected time range",
    week.page.items.length === 0,
    ids(week));

const filtered = queue.selectOperationalRows(rows, {
  q: "",
  chargePhase: "",
  issue: "charge_mismatch",
  sort: "newest",
  limit: 20,
});
check("without search the issue filter still applies",
    ids(filtered) === "charge-111",
    ids(filtered));

const notices = [
  {
    id: "n-old",
    loadNumber: "269238",
    subject: "Missing customer rate",
    createdAt: "2026-08-01T12:00:00Z",
  },
  {
    id: "n-new",
    loadNumber: "100",
    subject: "POD needed",
    createdAt: "2026-11-09T12:00:00Z",
  },
];
const matched = notices.filter((row) =>
  ops.notificationMatchesQuery(row, "269238") &&
  ops.notificationInRange(row, "year", now));
check("notification search hits the load inside the year",
    matched.length === 1 && matched[0].id === "n-old");
const urgentOrder = ops.sortNotifications(notices, "urgent", now)
    .map((row) => row.id);
check("urgent notification sort keeps every row",
    urgentOrder.length === 2 && urgentOrder[0] === "n-old",
    urgentOrder.join(","));

check("rate parser rejects zero and blank",
    rate.parseCustomerRate(0) == null &&
    rate.parseCustomerRate("") == null &&
    rate.parseCustomerRate("2100") === 2100);
const patch = rate.customerRatePatch({
  customerName: "S3",
  primusSteps: {podUploaded: true},
  taiSteps: {},
}, 2100, "");
check("rate patch matches the emailed workflow fields",
    patch.customerRate === 2100 &&
    patch.customerName === "S3" &&
    patch.primusSteps.customerRateChecked === true &&
    patch.primusSteps.podUploaded === true &&
    patch.decisionStage === "running" &&
    patch.finalWorkflowStatus === "running" &&
    patch.workflowPausedAtStep === null);
check("missing-rate task is the one a saved rate closes",
    rate.isMissingRateTask({type: "missing_rate", status: "open"}) &&
    !rate.isMissingRateTask({type: "additional_charge"}));

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
