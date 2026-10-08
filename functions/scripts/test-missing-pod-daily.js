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

  resumes.length = 0;
  const dry = await daily.runMissingPodDailyCheck({
    dryRun: true,
    pageSize: 10,
    maxInvoices: 20,
    timeBudgetMs: 60000,
  });
  check("dry run does not resume", resumes.length, 0);
  check("dry run still counts pod-found as resumed", dry.resumed, 2);

  const lookupFailed = await daily.evaluateHold({
    decisionStage: "missing_pod",
    finalWorkflowStatus: "waiting_manual",
    loadNumber: "999",
  });
  check("booking miss leaves the hold", lookupFailed.resume, false);
  check("booking miss is a failed check", lookupFailed.bucket, "failed");
}

runScenario().then(() => {
  if (failures) {
    console.error(`${failures} failed`);
    process.exit(1);
  }
  console.log("all passed");
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
