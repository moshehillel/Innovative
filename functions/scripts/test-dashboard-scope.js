"use strict";

const assert = require("assert");
const scope = require("../dashboard-scope");
const ownership = require("../dashboard-ownership");

assert.strictEqual(
    scope.tenantIdForDashboardOrigin("https://innovative-jerry.netlify.app"),
    "default");
assert.strictEqual(
    scope.tenantIdForDashboardOrigin("https://www.advancedautomations.net/"),
    "aa");
assert.strictEqual(
    scope.tenantIdForDashboardOrigin("https://evil.example"),
    false);
assert.strictEqual(scope.tenantIdForDashboardOrigin(""), null);

assert.strictEqual(scope.rowBelongsToTenant({tenantId: "aa"}, "default"), false);
assert.strictEqual(scope.rowBelongsToTenant({tenantId: "default"}, "default"), true);
assert.strictEqual(scope.rowBelongsToTenant({}, "default"), true);
assert.strictEqual(scope.rowBelongsToTenant({}, "aa"), false);

assert.strictEqual(scope.classifyIssue({type: "additional_charge"}), "charge_mismatch");
assert.strictEqual(scope.classifyIssue({
  decisionStage: "missing_pod",
}), "missing_pod");
assert.strictEqual(scope.classifyIssue({
  type: "missing_rate",
  reason: "MISSING_RATE",
}), "missing_rate");
assert.strictEqual(scope.classifyIssue({
  type: "low_margin",
  reason: "Customer rate too low",
}), "miscellaneous");

const owner = ownership.classifyDashboardOwner({
  type: "missing_rate",
  reason: "MISSING_RATE",
  to: "Lisa@innovativecarriers.com",
  dispatcherEmail: "pat@innovativecarriers.com",
  dispatcherName: "Pat",
});
assert.strictEqual(owner.ownerBucket, "dispatch");
assert.strictEqual(owner.dispatcherEmail, "pat@innovativecarriers.com");

const sarah = ownership.classifyDashboardOwner({
  type: "additional_charge",
  to: "Sarah@innovativecarriers.com",
});
assert.strictEqual(sarah.ownerBucket, "sarah");

const merged = scope.mergeQueueItems([
  {
    id: "invoice:1",
    source: "invoice",
    loadNumber: "100",
    issueType: "missing_rate",
    dispatcherEmail: null,
  },
  {
    id: "task1",
    source: "dashboardTasks",
    loadNumber: "100",
    type: "missing_rate",
    issueType: "missing_rate",
    dispatcherEmail: "pat@innovativecarriers.com",
  },
]);
assert.strictEqual(merged.length, 1);
assert.strictEqual(merged[0].id, "task1");
assert.strictEqual(merged[0].dispatcherEmail, "pat@innovativecarriers.com");

assert.strictEqual(scope.dispatcherMatches({
  dispatcherName: "Pat Dispatcher",
  dispatcherEmail: "pat@innovativecarriers.com",
}, "pat@"), true);
assert.strictEqual(scope.dispatcherMatches({
  dispatcherName: "Other",
}, "pat"), false);

assert.strictEqual(scope.isOpenNotification({
  status: "open",
  type: "unhandled_email",
}), true);
assert.strictEqual(scope.isOpenNotification({
  status: "dismissed",
  type: "unhandled_email",
}), false);
assert.strictEqual(scope.isOpenNotification({
  status: "open",
  emailType: "noa_ignored",
}), false);

const recipients = require("../dashboard-notification-digest").digestRecipients(
    {tenantId: "default"},
    [{dispatcherEmail: "pat@innovativecarriers.com"}]);
assert.ok(recipients.some((e) => /lisa@innovativecarriers.com/i.test(e)));
assert.ok(recipients.some((e) => /sarah@innovativecarriers.com/i.test(e)));
assert.ok(recipients.some((e) => /pat@innovativecarriers.com/i.test(e)));

const other = require("../dashboard-notification-digest").digestRecipients(
    {tenantId: "aa", alertEmail: "ops@aa.example"},
    [{dispatcherEmail: "disp@aa.example"}]);
assert.ok(!other.some((e) => /innovativecarriers.com/i.test(e)));
assert.ok(other.includes("ops@aa.example"));
assert.ok(other.includes("disp@aa.example"));

const queue = require("../dashboard-queue");
const september = {
  id: "sep",
  receivedAt: "2026-09-01T12:00:00.000Z",
  ownerBucket: "dispatch",
  chargesTotal: 175,
};
const october = {
  id: "oct",
  receivedAt: "2026-10-12T12:00:00.000Z",
  ownerBucket: "dispatch",
  chargesTotal: 40,
};
const newestPage = ownership.filterSortPaginate([september, october], {
  sort: "newest",
  limit: 1,
  offset: 0,
  maxLimit: 50,
});
assert.strictEqual(newestPage.items[0].id, "oct");
assert.strictEqual(newestPage.hasMore, true);
const newestNext = ownership.filterSortPaginate([september, october], {
  sort: "newest",
  limit: 1,
  offset: 1,
  maxLimit: 50,
});
assert.strictEqual(newestNext.items[0].id, "sep");
const urgentPage = ownership.filterSortPaginate([october, september], {
  sort: "urgent",
  limit: 1,
  offset: 0,
  maxLimit: 50,
});
assert.strictEqual(urgentPage.items[0].id, "sep");

const rateInvoice = {
  tenantId: "default",
  decisionStage: "needs_customer_rate_review",
  decisionReason: "MISSING_RATE",
  loadNumber: "268900",
};
assert.strictEqual(queue.holdIssueForInvoice(rateInvoice), "missing_rate");
assert.strictEqual(queue.invoiceHoldRow({
  id: "inv-rate",
  data: () => rateInvoice,
}, "default").id, "invoice:inv-rate");
assert.strictEqual(queue.invoiceHoldRow({
  id: "inv-rate",
  data: () => ({
    ...rateInvoice,
    dashboardDismissedIssues: ["missing_rate"],
  }),
}, "default"), null);
assert.strictEqual(queue.invoiceHoldRow({
  id: "inv-legacy",
  data: () => ({
    decisionStage: "needs_customer_rate_review",
    loadNumber: "1",
  }),
}, "aa"), null);
assert.ok(queue.invoiceHoldRow({
  id: "inv-legacy",
  data: () => ({
    decisionStage: "needs_customer_rate_review",
    loadNumber: "1",
  }),
}, "default"));

/**
 * @param {object} initial Documents keyed by collection/id.
 * @return {object}
 */
function mockDb(initial) {
  const store = {};
  Object.keys(initial).forEach((path) => {
    store[path] = {...initial[path]};
  });
  function refFor(path) {
    return {
      async get() {
        if (!Object.prototype.hasOwnProperty.call(store, path)) {
          return {exists: false, data() { return undefined; }};
        }
        return {
          exists: true,
          id: path.split("/").pop(),
          data() { return store[path]; },
        };
      },
      async update(patch) {
        store[path] = {...store[path], ...patch};
      },
    };
  }
  return {
    store,
    collection(name) {
      return {
        doc(id) {
          return refFor(`${name}/${id}`);
        },
        where(field, _op, value) {
          return {
            limit() {
              return this;
            },
            async get() {
              const docs = Object.keys(store)
                  .filter((path) => path.startsWith(`${name}/`) &&
                    store[path][field] === value)
                  .map((path) => ({
                    id: path.split("/").pop(),
                    data() {
                      return store[path];
                    },
                    ref: refFor(path),
                  }));
              return {docs};
            },
          };
        },
      };
    },
  };
}

async function testDismiss() {
  const tasks = require("../dashboard-tasks");
  const db = mockDb({
    "invoices/inv-rate": {...rateInvoice},
    "dashboardTasks/rate-task": {
      tenantId: "default",
      status: "open",
      type: "missing_rate",
      reason: "MISSING_RATE",
      invoiceId: "inv-rate",
      loadNumber: "268900",
    },
    "dashboardTasks/charge-task": {
      tenantId: "default",
      status: "open",
      type: "additional_charge",
      reason: "accessorial",
      invoiceId: "inv-rate",
      loadNumber: "268900",
    },
    "dashboardTasks/other-load": {
      tenantId: "default",
      status: "open",
      type: "missing_rate",
      reason: "MISSING_RATE",
      invoiceId: "inv-other",
      loadNumber: "999",
    },
  });
  const synthetic = await tasks.dismissDashboardTask(db, {}, {
    taskId: "invoice:inv-rate",
    source: "invoice",
    tenantId: "default",
    invoiceId: "inv-rate",
  });
  assert.strictEqual(synthetic.ok, true);
  assert.deepStrictEqual(
      db.store["invoices/inv-rate"].dashboardDismissedIssues,
      ["missing_rate"]);
  assert.strictEqual(
      db.store["invoices/inv-rate"].decisionStage,
      "needs_customer_rate_review");
  assert.strictEqual(db.store["dashboardTasks/rate-task"].status, "dismissed");
  assert.strictEqual(db.store["dashboardTasks/charge-task"].status, "open");
  assert.strictEqual(db.store["dashboardTasks/other-load"].status, "open");

  const missing = await tasks.dismissDashboardTask(mockDb({}), {}, {
    taskId: "does-not-exist",
    source: "dashboardTasks",
    tenantId: "default",
  });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.error, "Task not found.");

  const foreign = mockDb({"invoices/inv-rate": {...rateInvoice}});
  const denied = await tasks.dismissDashboardTask(foreign, {}, {
    taskId: "invoice:inv-rate",
    source: "invoice",
    tenantId: "aa",
  });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.error, "Task not found.");
  assert.strictEqual(
      foreign.store["invoices/inv-rate"].dashboardDismissedIssues,
      undefined);

  const real = mockDb({
    "invoices/inv-rate": {...rateInvoice},
    "dashboardTasks/rate-task": {
      tenantId: "default",
      status: "open",
      type: "missing_rate",
      reason: "MISSING_RATE",
      invoiceId: "inv-rate",
      loadNumber: "268900",
    },
  });
  const dismissedTask = await tasks.dismissDashboardTask(real, {}, {
    taskId: "rate-task",
    source: "dashboardTasks",
    tenantId: "default",
  });
  assert.strictEqual(dismissedTask.ok, true);
  assert.ok(real.store["invoices/inv-rate"].dashboardDismissedIssues
      .includes("missing_rate"));
  assert.strictEqual(
      real.store["invoices/inv-rate"].decisionStage,
      "needs_customer_rate_review");
  assert.strictEqual(real.store["dashboardTasks/rate-task"].status, "dismissed");
}

testDismiss().then(() => {
  console.log("ok");
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
