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

const digestMod = require("../dashboard-notification-digest");
const recipients = digestMod.digestRecipients(
    {tenantId: "default"},
    [
      {dispatcherEmail: "pat@innovativecarriers.com"},
      {dispatcherEmail: "accounting@innovativecarriers.com"},
    ]);
assert.ok(recipients.some((e) => /lisa@innovativecarriers.com/i.test(e)));
assert.ok(recipients.some((e) => /sarah@innovativecarriers.com/i.test(e)));
assert.ok(recipients.some((e) => /pat@innovativecarriers.com/i.test(e)));
assert.ok(!recipients.some((e) => /accounting@innovativecarriers.com/i.test(e)));
assert.strictEqual(digestMod.isIntakeAddress(
    "Innovative Accounting <accounting@innovativecarriers.com>"), true);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "Jerry ignored emails — Oct 15, 2026",
}), true);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "Jerry inbox digest — Oct 15, 2026",
}), true);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "Jerry broker commission swaps — Oct 15, 2026",
}), true);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "Jerry daily activity — Oct 15, 2026",
}), true);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "Re: Jerry — 111 unfinished notification(s) — Oct 15, 2026",
}), true);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "Jerry — 3 delivered + 1 past ETA, not invoiced",
}), true);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "Report — 4 shipment(s) missing delivery date (5+ days since pickup)",
}), true);
assert.strictEqual(digestMod.isJerrySystemNotification({
  emailType: "delivered_uninvoiced_report",
  subject: "Weekly report",
}), true);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "Approval needed — additional charge",
}), false);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "No POD",
}), false);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "No customer rate",
}), false);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "Low margin",
}), false);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "Mark delivered failed",
}), false);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "Review POD",
}), false);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "Action needed — low/negative profit on Load 268833",
  emailType: "low_profit_dispatcher",
}), false);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "Drayage GTG stopped — load 206473",
  emailType: "drayage_gtg_stopped",
}), false);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "[ACTION REQUIRED] Invoice amount does not match the shipment rate",
  emailType: "human_review",
}), false);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "[ACTION REQUIRED] Email received with no attachments",
  emailType: "human_review",
}), false);

const ops = require("../dashboard-ops");
assert.strictEqual(ops.notificationMatchesLoadQuery({
  loadNumber: null,
  subject: "Action needed — low/negative profit on Load 268833",
}, "268833"), true);
assert.strictEqual(ops.notificationMatchesLoadQuery({
  loadNumber: null,
  subject: "Drayage GTG stopped — load 206473",
}, "206473"), true);
assert.strictEqual(ops.notificationMatchesLoadQuery({
  loadNumber: null,
  subject: "Re: Invoice - Load V796457 - Ref 269483",
}, "269483"), true);
assert.strictEqual(ops.notificationMatchesLoadQuery({
  loadNumber: "111111",
  subject: "Action needed — low/negative profit on Load 268833",
}, "111111"), true);
assert.strictEqual(ops.notificationMatchesLoadQuery({
  subject: "Action needed — low/negative profit on Load 268833",
}, "269999"), false);
const doubled = ops.uniqueNotificationsById([
  {id: "same", subject: "No customer rate for Load 269237"},
  {id: "same", subject: "No customer rate for Load 269237"},
  {id: "other", subject: "No customer rate for Load 269237"},
]);
assert.strictEqual(doubled.length, 2);
assert.strictEqual(doubled[0].id, "same");
assert.strictEqual(doubled[1].id, "other");
const listedHtml = digestMod.digestHtml([
  {subject: "First open", loadNumber: "1"},
  {subject: "Middle open", loadNumber: "2"},
  {subject: "Last open row", loadNumber: "3"},
], "Oct 28, 2026");
assert.ok(listedHtml.includes("Last open row"));
assert.ok(listedHtml.includes("First open"));
assert.ok(/3 unfinished notification/.test(listedHtml));
assert.ok(/jerry dashboard/i.test(listedHtml));
assert.ok(/unfinished notification/i.test(listedHtml));
assert.strictEqual(digestMod.isInboundDigestEmail({
  subject: "Re: Jerry — 111 unfinished notification(s) — Oct 15, 2026",
}), true);
assert.strictEqual(digestMod.isInboundDigestEmail({
  subject: "No POD on load 100",
  body: "Please review the POD",
}), false);
assert.strictEqual(digestMod.inScheduledSendWindow(
    new Date("2026-10-15T11:30:00Z")), true);
assert.strictEqual(digestMod.inScheduledSendWindow(
    new Date("2026-10-15T14:01:00Z")), false);
assert.strictEqual(digestMod.inScheduledSendWindow(
    new Date("2026-10-15T17:02:00Z")), false);

const other = require("../dashboard-notification-digest").digestRecipients(
    {tenantId: "aa", alertEmail: "ops@aa.example"},
    [{dispatcherEmail: "disp@aa.example"}]);
assert.ok(!other.some((e) => /innovativecarriers.com/i.test(e)));
assert.ok(other.includes("ops@aa.example"));
assert.ok(other.includes("disp@aa.example"));

const queue = require("../dashboard-queue");
const september = {
  id: "sep",
  receivedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
  ownerBucket: "dispatch",
  chargesTotal: 175,
};
const october = {
  id: "oct",
  receivedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
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

  const charges = {
    FOLLOW_UP_COLLECTION: "additionalCharges",
    FOLLOW_UP_STATUS: {RESOLVED: "resolved"},
  };
  const chargeDb = mockDb({
    "dashboardTasks/charge-task": {
      tenantId: "default",
      status: "open",
      type: "additional_charge",
      reason: "accessorial",
      invoiceId: "inv-charge",
      followUpId: "fu-1",
      loadNumber: "265647",
    },
    "additionalCharges/fu-1": {
      tenantId: "default",
      resolved: false,
      status: "pending_approval",
      invoiceId: "inv-charge",
    },
    "dashboardTasks/linked": {
      tenantId: "default",
      status: "open",
      type: "additional_charge",
      followUpId: "fu-1",
      invoiceId: "inv-charge",
      loadNumber: "265647",
    },
  });
  const closed = await tasks.dismissDashboardTask(chargeDb, charges, {
    taskId: "fu-1",
    source: "additionalCharges",
    tenantId: "default",
  });
  assert.strictEqual(closed.ok, true);
  assert.strictEqual(chargeDb.store["additionalCharges/fu-1"].resolved, true);
  assert.strictEqual(
      chargeDb.store["dashboardTasks/linked"].status, "dismissed");
  assert.strictEqual(
      chargeDb.store["dashboardTasks/charge-task"].status, "dismissed");
}

/**
 * Firestore stand-in with a transaction that commits the day claim.
 * @return {object}
 */
function claimDb() {
  const docs = {};
  function refFor(path) {
    return {
      path,
      async get() {
        if (!Object.prototype.hasOwnProperty.call(docs, path)) {
          return {exists: false, data() {
            return undefined;
          }};
        }
        return {exists: true, data() {
          return docs[path];
        }};
      },
      async set(data) {
        docs[path] = {...(docs[path] || {}), ...data};
      },
    };
  }
  return {
    docs,
    collection(name) {
      return {doc(id) {
        return refFor(`${name}/${id}`);
      }};
    },
    async runTransaction(fn) {
      const tx = {
        async get(ref) {
          return ref.get();
        },
        set(ref, data) {
          docs[ref.path] = {...(docs[ref.path] || {}), ...data};
        },
      };
      return fn(tx);
    },
  };
}

async function testDigestSendsOnce() {
  const sent = [];
  const db = claimDb();
  digestMod.init({
    db,
    listNotifications: async (_db, opts) => {
      assert.strictEqual(opts.all, true);
      assert.strictEqual(opts.fetchLimit, undefined);
      assert.strictEqual(opts.limit, undefined);
      assert.strictEqual(opts.sort, "newest");
      return {
      notifications: [
        {
          status: "open",
          tenantId: "default",
          subject: "Approval needed — additional charge",
          dispatcherEmail: "pat@innovativecarriers.com",
        },
        {
          status: "open",
          tenantId: "default",
          subject: "Jerry inbox digest — Oct 14, 2026",
        },
        {
          status: "open",
          tenantId: "default",
          subject: "No POD",
          dispatcherEmail: "accounting@innovativecarriers.com",
        },
      ],
      };
    },
    saveOutboundEmail: async (email) => {
      sent.push(email);
    },
  });
  const morning = new Date("2026-10-15T11:30:00.000Z");
  const tenants = [{tenantId: "default"}];
  const first = await digestMod.runDailyNotificationDigest({
    now: morning,
    tenants,
  });
  const second = await digestMod.runDailyNotificationDigest({
    now: morning,
    tenants,
  });
  const afternoon = await digestMod.runDailyNotificationDigest({
    now: new Date("2026-10-15T17:02:00.000Z"),
    tenants,
  });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(first.results[0].sent, true);
  assert.strictEqual(first.results[0].open, 2);
  assert.strictEqual(second.results[0].skipped, true);
  assert.strictEqual(afternoon.skipped, true);
  assert.ok(!/accounting@innovativecarriers.com/i.test(sent[0].to));
  assert.ok(/lisa@innovativecarriers.com/i.test(sent[0].to));
  assert.ok(/sarah@innovativecarriers.com/i.test(sent[0].to));
  assert.ok(/pat@innovativecarriers.com/i.test(sent[0].to));
  assert.strictEqual(sent[0].cc, null);
  assert.ok(/Approval needed/.test(sent[0].html));
  assert.ok(/No POD/.test(sent[0].html));
  assert.ok(!/inbox digest/i.test(sent[0].html));
  assert.ok(/unfinished notification/i.test(sent[0].html));
  assert.ok(/jerry dashboard/i.test(sent[0].html));
  const claim = db.docs["settings/dashboardNotificationDigest_default"];
  claim.status = "error";
  const retry = await digestMod.runDailyNotificationDigest({
    now: morning,
    tenants,
  });
  assert.strictEqual(retry.results[0].skipped, true);
  assert.strictEqual(sent.length, 1);
}

/**
 * Firestore stand-in that pages an in-memory notification list.
 * @param {object[]} rows id + data.
 * @return {object}
 */
function fakeNotifDb(rows) {
  function make(list, start, lim) {
    return {
      where(field, op, value) {
        if (op !== "==") throw new Error(op);
        return make(list.filter((row) => row.data[field] === value), 0, null);
      },
      orderBy(field, dir) {
        const sorted = list.slice().sort((a, b) => {
          const av = a.data[field];
          const bv = b.data[field];
          const an = av instanceof Date ? av.getTime() : 0;
          const bn = bv instanceof Date ? bv.getTime() : 0;
          if (an === bn) return 0;
          return dir === "desc" ? bn - an : an - bn;
        });
        return make(sorted, 0, null);
      },
      select() {
        return this;
      },
      limit(n) {
        return make(list, 0, n);
      },
      startAfter(doc) {
        const idx = list.findIndex((row) => row.id === doc.id);
        return make(list, idx + 1, lim);
      },
      async get() {
        const from = start || 0;
        const end = lim == null ? list.length : from + lim;
        const slice = list.slice(from, end);
        const docs = slice.map((row) => ({
          id: row.id,
          data() {
            return row.data;
          },
        }));
        return {
          empty: docs.length === 0,
          size: docs.length,
          docs,
          forEach(fn) {
            docs.forEach(fn);
          },
        };
      },
    };
  }
  return {
    collection() {
      return make(rows, 0, null);
    },
  };
}

async function testListReadsEveryOpenNotification() {
  const rows = [];
  const base = Date.UTC(2024, 0, 1);
  for (let i = 0; i < 2500; i++) {
    rows.push({
      id: `n${i}`,
      data: {
        tenantId: "default",
        status: "open",
        type: "ops_email",
        subject: i === 0 ? "Rate note for Load 555555" : `Notice ${i}`,
        ownerBucket: "accounting",
        createdAt: new Date(base + i * 1000),
      },
    });
  }
  rows.push({
    id: "copy",
    data: {
      tenantId: "default",
      status: "open",
      type: "ops_email",
      subject: "Separate copy",
      loadNumber: "555555",
      ownerBucket: "accounting",
      createdAt: new Date(base + 100 * 1000),
    },
  });
  rows.push({
    id: "copy",
    data: {
      tenantId: "default",
      status: "open",
      type: "ops_email",
      subject: "Separate copy",
      loadNumber: "555555",
      ownerBucket: "accounting",
      createdAt: new Date(base + 100 * 1000),
    },
  });
  rows.push({
    id: "closed",
    data: {
      tenantId: "default",
      status: "dismissed",
      type: "ops_email",
      subject: "Closed 555555",
      loadNumber: "555555",
      ownerBucket: "accounting",
      createdAt: new Date(base + 50 * 1000),
    },
  });
  rows.push({
    id: "other-tenant",
    data: {
      tenantId: "aa",
      status: "open",
      type: "ops_email",
      subject: "Other tenant 555555",
      loadNumber: "555555",
      ownerBucket: "accounting",
      createdAt: new Date(base + 60 * 1000),
    },
  });
  const db = fakeNotifDb(rows);
  const all = await ops.listNotifications(db, {
    tenantId: "default",
    all: true,
    fetchLimit: 2000,
    sort: "newest",
    urgentFirst: false,
  });
  assert.strictEqual(all.notifications.length, 2501);
  assert.strictEqual(all.hasMore, false);
  assert.strictEqual(all.notifications[0].id, "n2499");
  const ids = all.notifications.map((row) => row.id);
  assert.ok(ids.includes("n0"));
  assert.strictEqual(ids.filter((id) => id === "copy").length, 1);
  assert.ok(!ids.includes("closed"));
  assert.ok(!ids.includes("other-tenant"));
  const found = await ops.listNotifications(db, {
    tenantId: "default",
    q: "555555",
    limit: 50,
    sort: "newest",
    urgentFirst: false,
  });
  const foundIds = found.notifications.map((row) => row.id).sort();
  assert.deepStrictEqual(foundIds, ["copy", "n0"]);
  const late = await ops.listNotifications(db, {
    tenantId: "default",
    limit: 50,
    maxLimit: 50,
    offset: 2500,
    sort: "newest",
    urgentFirst: false,
  });
  assert.ok(late.notifications.some((row) => row.id === "n0"));
  assert.ok(late.notifications.length > 0);
}

testDismiss()
    .then(() => testListReadsEveryOpenNotification())
    .then(() => testDigestSendsOnce())
    .then(() => {
      console.log("ok");
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
