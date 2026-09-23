/* eslint-disable no-console */
"use strict";

const dedup = require("../pod-send-dedup");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

check("normalize lowercase",
    dedup.normalizeRecipientEmail("Jane@Example.COM") === "jane@example.com");
check("doc id uses normalized email",
    dedup.podSendLogDocId("265677", "QuickBooks@notification.intuit.com") ===
    "265677__quickbooks@notification.intuit.com");
check("blocks quickbooks notification",
    dedup.isBlockedPodRecipient("quickbooks@notification.intuit.com"));
check("blocks noreply",
    dedup.isBlockedPodRecipient("noreply@saia.com"));
check("blocks unishippers noreply mailbox",
    dedup.isBlockedPodRecipient(
        "noreply.myunishippers@unishippers.com"));
check("blocks donotreply",
    dedup.isBlockedPodRecipient("donotreply@carrier.com"));
check("allows normal requester",
    !dedup.isBlockedPodRecipient("jane@customer.com"));

const now = Date.UTC(2026, 7, 11, 12, 0, 0);
const recentTs = {toMillis: () => now - 60 * 60 * 1000};
const staleTs = {toMillis: () => now - 72 * 60 * 60 * 1000};
check("recent within 48h",
    dedup.isRecentPodSend({sentAt: recentTs}, now));
check("stale outside 48h",
    !dedup.isRecentPodSend({sentAt: staleTs}, now));

const origHours = process.env.POD_SEND_DEDUP_WINDOW_HOURS;
process.env.POD_SEND_DEDUP_WINDOW_HOURS = "24";
check("configurable window 24h",
    dedup.getDedupWindowMs() === 24 * 60 * 60 * 1000);
check("24h boundary recent",
    dedup.isRecentPodSend(
        {sentAt: {toMillis: () => now - 23 * 60 * 60 * 1000}}, now));
check("24h boundary stale",
    !dedup.isRecentPodSend(
        {sentAt: {toMillis: () => now - 25 * 60 * 60 * 1000}}, now));
if (origHours == null) delete process.env.POD_SEND_DEDUP_WINDOW_HOURS;
else process.env.POD_SEND_DEDUP_WINDOW_HOURS = origHours;

async function runAsyncTests() {
  const store = new Map();
  const mockDb = {
    collection: (name) => ({
      doc: (id) => ({
        get: async () => {
          const data = store.get(`${name}/${id}`);
          return {
            exists: !!data,
            id,
            data: () => data,
          };
        },
        set: async (payload) => {
          store.set(`${name}/${id}`, {...payload});
        },
      }),
    }),
  };
  const tenant = {collectionPrefix: ""};
  const load = "265677";
  const email = "jane@example.com";

  await dedup.recordPodSend(mockDb, tenant, {
    loadNumber: load,
    recipientEmail: email,
    messageId: "msg-1",
    sentAt: {toMillis: () => now - 1000},
  });

  const hit = await dedup.findRecentPodSend(
      mockDb, tenant, load, email, now);
  check("findRecentPodSend finds stored send", !!hit && hit.messageId === "msg-1");

  const miss = await dedup.findRecentPodSend(
      mockDb, tenant, load, "other@example.com", now);
  check("findRecentPodSend misses other recipient", !miss);

  store.set(`podSendLog/${dedup.podSendLogDocId(load, email)}`, {
    loadNumber: load,
    recipientEmail: email,
    messageId: "old",
    sentAt: {toMillis: () => now - 72 * 60 * 60 * 1000},
  });
  const expired = await dedup.findRecentPodSend(
      mockDb, tenant, load, email, now);
  check("findRecentPodSend ignores expired send", !expired);
}

runAsyncTests().then(() => {
  if (failures) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll pod send dedup tests passed");
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
