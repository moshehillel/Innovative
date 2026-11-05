/* eslint-disable no-console */
"use strict";

const daily = require("../missing-pod-daily");

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}` +
    (ok ? "" : ` (got ${JSON.stringify(actual)}, ` +
      `expected ${JSON.stringify(expected)})`));
};

check("completed invoice is not rechecked",
    daily.classifyMissingPodHold({
      decisionStage: "missing_pod",
      finalWorkflowStatus: "completed",
      loadNumber: "1",
    }),
    {action: "skip", reason: "already_completed"});

check("non-hold is ignored",
    daily.classifyMissingPodHold({
      decisionStage: "awaiting_tl_pod",
      loadNumber: "1",
    }),
    {action: "skip", reason: "not_missing_pod_hold"});

check("locked hold is skipped",
    daily.classifyMissingPodHold({
      decisionStage: "missing_pod",
      processingLock: true,
      loadNumber: "1",
    }),
    {action: "skip", reason: "already_processing"});

check("open missing_pod hold is checked",
    daily.classifyMissingPodHold({
      decisionStage: "missing_pod",
      finalWorkflowStatus: "waiting_manual",
      loadNumber: "266100",
    }),
    {action: "check", reason: "missing_pod"});

check("resume step defaults to pod_extraction",
    daily.resumeStepFor({decisionStage: "missing_pod"}),
    "pod_extraction");
check("resume step keeps the stored pause",
    daily.resumeStepFor({workflowPausedAtStep: "pod_extraction"}),
    "pod_extraction");

check("workflow gate after resume still counts as resumed",
    daily.classifyResumeResult({
      ok: false,
      status: 200,
      payload: {ok: false, error: "UNMATCHED_AMOUNT"},
    }),
    {bucket: "resumed", reason: "UNMATCHED_AMOUNT"});
check("already completed workflow is not a new resume",
    daily.classifyResumeResult({
      ok: false,
      status: 409,
      payload: {error: "ALREADY_COMPLETED"},
    }),
    {bucket: "skipped", reason: "already_completed"});

function doc(id, data) {
  return {
    id,
    data: () => data,
    ref: {
      update: async (patch) => {
        data.updates = data.updates || [];
        data.updates.push(patch);
      },
    },
  };
}

function collection(allDocs) {
  return {
    where(field, op, value) {
      const filtered = allDocs.filter((row) => row.data()[field] === value);
      const state = {start: null, limit: filtered.length};
      const api = {
        orderBy() {
          return api;
        },
        limit(n) {
          state.limit = n;
          return api;
        },
        startAfter(id) {
          state.start = id;
          return api;
        },
        async get() {
          const sorted = filtered.slice().sort((a, b) => {
            if (a.id < b.id) return -1;
            if (a.id > b.id) return 1;
            return 0;
          });
          const sliced = state.start ?
            sorted.filter((row) => row.id > state.start) : sorted;
          const page = sliced.slice(0, state.limit);
          return {empty: page.length === 0, docs: page, size: page.length};
        },
      };
      return api;
    },
  };
}

async function runScenario() {
  const still = doc("b", {
    decisionStage: "missing_pod",
    finalWorkflowStatus: "waiting_manual",
    loadNumber: "100",
    workflowPausedAtStep: "pod_extraction",
  });
  const found = doc("c", {
    decisionStage: "missing_pod",
    finalWorkflowStatus: "waiting_manual",
    loadNumber: "200",
    workflowPausedAtStep: "pod_extraction",
  });
  const done = doc("a", {
    decisionStage: "missing_pod",
    finalWorkflowStatus: "completed",
    loadNumber: "300",
  });
  const locked = doc("d", {
    decisionStage: "missing_pod",
    processingLock: true,
    loadNumber: "400",
  });
  const localPod = doc("e", {
    decisionStage: "missing_pod",
    finalWorkflowStatus: "waiting_manual",
    loadNumber: "500",
    podOnPrimusAlready: true,
    workflowPausedAtStep: "pod_extraction",
  });
  const lookups = [];
  const resumes = [];
  const logs = [];
  const cleared = [];
  const settings = {cursorId: null};
  daily.init({
    FieldPath: {documentId: () => "__name__"},
    FieldValue: {serverTimestamp: () => "ts"},
    invoicesCollection: () => collection([still, found, done, locked, localPod]),
    settingsDoc: () => ({
      get: async () => ({
        exists: settings.cursorId != null,
        data: () => ({cursorId: settings.cursorId}),
      }),
      set: async (patch) => Object.assign(settings, patch),
    }),
    fetchPrimusBooking: async (loadNumber) => {
      lookups.push(loadNumber);
      if (loadNumber === "100") return {bol: "100"};
      if (loadNumber === "200") return {bol: "200"};
      return null;
    },
    checkBookingHasPod: async ({loadNumber}) => {
      if (loadNumber === "200") {
        return {found: true, driveIds: ["drive-1"]};
      }
      return {found: false, reason: "no POD on booking", driveIds: []};
    },
    resumeWorkflow: async (invoiceId, resumeFrom) => {
      resumes.push({invoiceId, resumeFrom});
      return {ok: true, status: 200, payload: {ok: true}};
    },
    writeLog: async (level, category, message, details) => {
      logs.push({level, category, message, details});
    },
    dismissOpenPodNotifications: async (opts) => {
      cleared.push(opts);
      return {ok: true, dismissed: 1, ids: ["n"]};
    },
  });

  const result = await daily.runMissingPodDailyCheck({
    pageSize: 2,
    maxInvoices: 20,
    timeBudgetMs: 60000,
    concurrency: 2,
  });
  check("checked every missing_pod doc once", result.checked, 5);
  check("one still missing", result.stillMissing, 1);
  check("two resumes (primus + already marked)", result.resumed, 2);
  check("completed and locked skipped", result.skipped, 2);
  check("no failures", result.failed, 0);
  check("resumed the POD loads only",
      resumes.map((row) => row.invoiceId).sort(),
      ["c", "e"]);
  check("resume uses pod_extraction",
      resumes.every((row) => row.resumeFrom === "pod_extraction"),
      true);
  check("primus lookup skipped completed, locked, and marked POD",
      lookups.sort(),
      ["100", "200"]);
  check("still-missing stamp does not clear the hold",
      still.data().decisionStage,
      "missing_pod");
  check("still-missing stamp records the check",
      still.data().updates[0].missingPodLastCheckResult,
      "still_missing");
  check("cursor resets after a full pass", settings.cursorId, null);
  check("summary was logged",
      logs.some((row) => row.message === "Daily missing-POD check finished"),
      true);
  check("POD found clears notices for those loads",
      cleared.map((row) => String(row.loadNumber)).sort(),
      ["200", "500"]);
  check("still-missing load does not clear notices",
      cleared.some((row) => String(row.loadNumber) === "100"),
      false);
  check("daily check reports the cleared count",
      result.notificationsDismissed, 2);

  resumes.length = 0;
  const clearedBeforeDry = cleared.length;
  const dry = await daily.runMissingPodDailyCheck({
    dryRun: true,
    pageSize: 10,
    maxInvoices: 20,
    timeBudgetMs: 60000,
  });
  check("dry run does not resume", resumes.length, 0);
  check("dry run still counts pod-found as resumed", dry.resumed, 2);
  check("dry run does not clear notices",
      cleared.length, clearedBeforeDry);
  check("dry run reports no cleared notices",
      dry.notificationsDismissed, 0);

  const lookupFailed = await daily.evaluateHold({
    decisionStage: "missing_pod",
    finalWorkflowStatus: "waiting_manual",
    loadNumber: "999",
  });
  check("booking miss leaves the hold", lookupFailed.resume, false);
  check("booking miss is a failed check", lookupFailed.bucket, "failed");
}

function noticeDb(rows) {
  const store = {};
  rows.forEach((row) => {
    store[row.id] = {...row};
  });
  return {
    store,
    collection() {
      return {
        where(field, _op, value) {
          const api = {
            limit() {
              return api;
            },
            async get() {
              const docs = Object.keys(store)
                  .filter((id) => store[id][field] === value)
                  .map((id) => ({
                    id,
                    data() {
                      return store[id];
                    },
                  }));
              return {docs};
            },
          };
          return api;
        },
        doc(id) {
          return {
            async get() {
              if (!store[id]) return {exists: false, data: () => ({})};
              return {exists: true, data: () => store[id]};
            },
            async update(patch) {
              Object.assign(store[id], patch);
            },
          };
        },
      };
    },
  };
}

async function testNoticeClear() {
  const ops = require("../dashboard-ops");
  const fs = require("fs");
  const path = require("path");
  check("action needed no POD is clearable",
      ops.isClearablePodNotification({
        status: "open",
        subject: "Action needed \u2014 No POD for Load 200",
      }), true);
  check("reminder POD needed is clearable",
      ops.isClearablePodNotification({
        status: "open",
        subject: "Reminder: POD needed \u2014 Load 200",
      }), true);
  check("plain POD needed is clearable",
      ops.isClearablePodNotification({
        status: "open",
        reason: "POD needed \u2014 Load 200",
      }), true);
  check("customer rate is not a POD notice",
      ops.isClearablePodNotification({
        status: "open",
        subject: "Action needed \u2014 No customer rate for Load 200",
      }), false);
  check("low margin is not a POD notice",
      ops.isClearablePodNotification({
        status: "open",
        subject: "Action needed \u2014 Low margin for Load 200",
      }), false);
  check("GTG stop is not a POD notice",
      ops.isClearablePodNotification({
        status: "open",
        subject: "Drayage GTG stopped \u2014 load 200",
      }), false);
  check("enter load number is not a POD notice",
      ops.isClearablePodNotification({
        status: "open",
        subject: "Enter load number",
      }), false);
  check("done notice is not cleared again",
      ops.isClearablePodNotification({
        status: "dismissed",
        subject: "Action needed - No POD for Load 200",
      }), false);

  const db = noticeDb([
    {id: "pod", invoiceId: "inv-1", loadNumber: null, status: "open",
      tenantId: "default",
      subject: "Action needed \u2014 No POD for Load 200"},
    {id: "rem", invoiceId: "inv-1", loadNumber: "200", status: "open",
      tenantId: "default",
      subject: "Reminder: POD needed - Load 200 / PRO 9"},
    {id: "ask", invoiceId: "inv-1", loadNumber: 200, status: "open",
      tenantId: "default",
      subject: "POD needed - Load 200"},
    {id: "rate", invoiceId: "inv-1", loadNumber: "200", status: "open",
      tenantId: "default",
      subject: "Action needed \u2014 No customer rate for Load 200"},
    {id: "low", invoiceId: "inv-1", loadNumber: "200", status: "open",
      tenantId: "default",
      subject: "Action needed \u2014 Low margin for Load 200"},
    {id: "gtg", invoiceId: "inv-1", loadNumber: "200", status: "open",
      tenantId: "default",
      subject: "Drayage GTG stopped \u2014 load 200"},
    {id: "load", invoiceId: "inv-1", loadNumber: "200", status: "open",
      tenantId: "default", subject: "Enter load number"},
    {id: "chg", invoiceId: "inv-1", loadNumber: "200", status: "open",
      tenantId: "default",
      subject: "Additional charge \u2014 Load 200"},
    {id: "esc", invoiceId: "inv-1", loadNumber: "200", status: "open",
      tenantId: "default",
      subject: "Escalation \u2014 no POD after 3 carrier reminders"},
    {id: "done", invoiceId: "inv-1", loadNumber: "200",
      status: "dismissed", tenantId: "default",
      subject: "Action needed - No POD for Load 200"},
    {id: "flag", invoiceId: "inv-1", loadNumber: "200",
      status: "flagged", tenantId: "default",
      subject: "POD needed - Load 200"},
    {id: "other", invoiceId: "inv-9", loadNumber: "999", status: "open",
      tenantId: "default", subject: "POD needed - Load 999"},
  ]);
  const result = await ops.dismissOpenPodNotifications(db, {
    loadNumber: "200",
    invoiceId: "inv-1",
    tenantId: "default",
  });
  check("clears the three POD notices",
      result.ids.slice().sort(), ["ask", "pod", "rem"]);
  check("rate notice stays open", db.store.rate.status, "open");
  check("low margin notice stays open", db.store.low.status, "open");
  check("GTG notice stays open", db.store.gtg.status, "open");
  check("load-number notice stays open", db.store.load.status, "open");
  check("charge notice stays open", db.store.chg.status, "open");
  check("escalation notice stays open", db.store.esc.status, "open");
  check("already done notice stays dismissed",
      db.store.done.status, "dismissed");
  check("flagged notice stays flagged", db.store.flag.status, "flagged");
  check("another load stays open", db.store.other.status, "open");
  check("cleared notices use the Done status",
      db.store.pod.status, "dismissed");

  const src = fs.readFileSync(
      path.join(__dirname, "../index.js"), "utf8");
  const start = src.indexOf("async function runPodFollowUpChecks");
  const end = src.indexOf("let retryPendingTransientWorkflowsImpl");
  const fn = src.slice(start, end);
  const podAt = fn.indexOf("if (hasPod)");
  const dismissAt = fn.indexOf("dismissOpenPodNotifications");
  const remindAt = fn.indexOf("Send next carrier reminder");
  check("chase clears notices after the POD is found",
      dismissAt > podAt && dismissAt < remindAt, true);
}

runScenario().then(() => testNoticeClear()).then(() => {
  if (failures) {
    console.error(`${failures} failed`);
    process.exit(1);
  }
  console.log("all passed");
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
