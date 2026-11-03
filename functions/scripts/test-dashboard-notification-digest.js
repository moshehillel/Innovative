/**
 * Focused tests for the daily unfinished-notification digest.
 * Run: node scripts/test-dashboard-notification-digest.js
 */

"use strict";

const assert = require("assert");
const digestMod = require("../dashboard-notification-digest");
const ownership = require("../dashboard-ownership");

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
for (const person of ownership.OPS_DISPATCHERS) {
  assert.ok(
      recipients.some((e) => e.toLowerCase() === person.email.toLowerCase()),
      `missing roster recipient ${person.email}`);
}

assert.strictEqual(digestMod.isIntakeAddress(
    "Innovative Accounting <accounting@innovativecarriers.com>"), true);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "Jerry ignored emails — Oct 15, 2026",
}), true);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "Jerry inbox digest — Oct 15, 2026",
}), true);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "Re: Jerry — 111 unfinished notification(s) — Oct 15, 2026",
}), true);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "Approval needed — additional charge",
}), false);
assert.strictEqual(digestMod.isJerrySystemNotification({
  subject: "No POD",
}), false);

const listedHtml = digestMod.digestHtml([
  {
    subject: "First open",
    loadNumber: "1",
    dispatcherName: "Leo",
  },
  {subject: "Middle open", loadNumber: "2"},
  {subject: "Last open row", loadNumber: "3"},
], "Oct 28, 2026");
assert.ok(listedHtml.includes("Last open row"));
assert.ok(listedHtml.includes("First open"));
assert.ok(listedHtml.includes("Leo"));
assert.ok(/3 unfinished notification/.test(listedHtml));
assert.ok(/jerry dashboard/i.test(listedHtml));

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
    new Date("2026-10-15T17:02:00Z")), false);

const other = digestMod.digestRecipients(
    {tenantId: "aa", alertEmail: "ops@aa.example"},
    [{dispatcherEmail: "disp@aa.example"}]);
assert.ok(!other.some((e) => /innovativecarriers.com/i.test(e)));
assert.ok(other.includes("ops@aa.example"));
assert.ok(other.includes("disp@aa.example"));

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

/**
 * @return {Promise<void>}
 */
async function testDigestSendsOnce() {
  const sent = [];
  const db = claimDb();
  digestMod.init({
    db,
    listNotifications: async (_db, opts) => {
      assert.strictEqual(opts.all, true);
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
  assert.ok(/leo@innovativecarriers.com/i.test(sent[0].to));
  assert.strictEqual(sent[0].type, "dashboard_notification_digest");
  assert.strictEqual(sent[0].forceSend, true);
  assert.strictEqual(sent[0].forceRecipient, true);
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

testDigestSendsOnce().then(() => {
  console.log("test-dashboard-notification-digest: ok");
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
