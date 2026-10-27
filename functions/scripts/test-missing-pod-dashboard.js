/* eslint-disable no-console */
"use strict";

const assert = require("assert");
const pod = require("../missing-pod-dashboard");
const queue = require("../dashboard-queue");

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}` +
    (ok ? "" : ` (got ${JSON.stringify(actual)}, ` +
      `expected ${JSON.stringify(expected)})`));
};

check("invoice hold is a missing POD row",
    pod.isMissingPodDashboardItem({
      type: "missing_pod",
      issueType: "missing_pod",
      decisionStage: "missing_pod",
      status: "open",
      source: "invoice",
    }), true);
check("signed POD is not the missing POD tab",
    pod.isMissingPodDashboardItem({
      type: "signed_pod",
      issueType: "missing_pod",
      status: "open",
    }), false);
check("POD discrepancy is not the missing POD tab",
    pod.isMissingPodDashboardItem({
      type: "pod_discrepancy",
      issueType: "missing_pod",
      status: "open",
    }), false);
check("option D is not the missing POD tab",
    pod.isMissingPodDashboardItem({
      type: "additional_charge",
      source: "additionalCharges",
      decision: "d",
      chargePhase: "dispute",
      status: "open",
    }), false);
check("missing rate is not the missing POD tab",
    pod.isMissingPodDashboardItem({
      type: "missing_rate",
      issueType: "missing_rate",
      status: "open",
    }), false);
check("completed workflow has left the hold",
    pod.workflowLeftMissingPod({
      decisionStage: "completed",
      finalWorkflowStatus: "completed",
      loadNumber: "100",
    }), true);
check("open hold has not left",
    pod.workflowLeftMissingPod({
      decisionStage: "missing_pod",
      finalWorkflowStatus: "waiting_manual",
      loadNumber: "100",
    }), false);

function emptyCol() {
  const q = {
    where() {
      return q;
    },
    select() {
      return q;
    },
    limit() {
      return q;
    },
    orderBy() {
      return q;
    },
    async get() {
      return {docs: [], forEach() {}};
    },
  };
  return q;
}

async function testQueuePhase() {
  const db = {collection() {
    throw new Error("dismiss lookup down");
  }};
  const deps = {
    tenant: {tenantId: "default"},
    tcol: () => emptyCol(),
    additionalCharges: {},
    dashboardTasks: {
      listDashboardTasks: async () => ({
        tasks: [
          {
            id: "pod-1",
            type: "missing_pod",
            issueType: "missing_pod",
            decisionStage: "missing_pod",
            status: "open",
            tenantId: "default",
            loadNumber: "100",
            source: "dashboardTasks",
          },
          {
            id: "rate-1",
            type: "missing_rate",
            issueType: "missing_rate",
            status: "open",
            tenantId: "default",
            loadNumber: "200",
          },
          {
            id: "signed-1",
            type: "signed_pod",
            issueType: "missing_pod",
            status: "open",
            tenantId: "default",
            loadNumber: "300",
          },
          {
            id: "disp-1",
            type: "additional_charge",
            source: "additionalCharges",
            decision: "d",
            chargePhase: "dispute",
            status: "open",
            tenantId: "default",
            loadNumber: "400",
          },
        ],
        disputeCount: 1,
      }),
    },
  };
  const listed = await queue.listOperationalQueue(db, deps, {
    chargePhase: "missing_pod",
    limit: 50,
  });
  check("missing POD tab lists only that hold",
      listed.tasks.map((row) => row.id), ["pod-1"]);
  check("missing POD count ignores other rows", listed.missingPodCount, 1);
  const dispute = await queue.listOperationalQueue(db, deps, {
    chargePhase: "dispute",
    limit: 50,
  });
  check("in dispute stays option D only",
      dispute.tasks.map((row) => row.id), ["disp-1"]);
  check("in dispute does not count missing POD as dispute",
      dispute.tasks.some((row) => row.id === "pod-1"), false);
}

function taskDb(initial) {
  const store = {};
  Object.keys(initial).forEach((path) => {
    store[path] = {...initial[path]};
  });
  return {
    store,
    collection(name) {
      return {
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
                    ref: {
                      async update(patch) {
                        store[path] = {...store[path], ...patch};
                      },
                    },
                  }));
              return {docs};
            },
          };
        },
      };
    },
  };
}

async function testFinishAndSchedule() {
  const invoices = {
    "inv-pod": {
      id: "inv-pod",
      decisionStage: "missing_pod",
      finalWorkflowStatus: "waiting_manual",
      loadNumber: "100",
      workflowPausedAtStep: "pod_extraction",
    },
    "inv-rate": {
      id: "inv-rate",
      decisionStage: "needs_customer_rate_review",
      finalWorkflowStatus: "waiting_manual",
      loadNumber: "200",
    },
    "inv-still": {
      id: "inv-still",
      decisionStage: "missing_pod",
      finalWorkflowStatus: "waiting_manual",
      loadNumber: "300",
    },
  };
  const db = taskDb({
    "dashboardTasks/pod-1": {
      tenantId: "default",
      status: "open",
      type: "missing_pod",
      reason: "missing_pod",
      decisionStage: "missing_pod",
      invoiceId: "inv-pod",
      loadNumber: "100",
    },
    "dashboardTasks/rate-task": {
      tenantId: "default",
      status: "open",
      type: "missing_rate",
      reason: "MISSING_RATE",
      invoiceId: "inv-rate",
      loadNumber: "200",
    },
    "dashboardTasks/still-1": {
      tenantId: "default",
      status: "open",
      type: "missing_pod",
      reason: "missing_pod",
      decisionStage: "missing_pod",
      invoiceId: "inv-still",
      loadNumber: "300",
    },
  });
  const logs = [];
  const lookups = [];
  const resumes = [];
  const emails = [];
  pod.init({
    db,
    FieldValue: {serverTimestamp: () => "ts"},
    tenant: {tenantId: "default"},
    loadInvoice: async (_tenant, id) =>
      (invoices[id] ? {...invoices[id]} : null),
    resumeWorkflow: async (_tenant, id) => {
      resumes.push(id);
      if (id === "inv-pod") {
        invoices[id].decisionStage = "completed";
        invoices[id].finalWorkflowStatus = "completed";
        return {
          ok: true,
          status: 200,
          payload: {ok: true, workflowStatus: "completed"},
        };
      }
      return {
        ok: false,
        status: 200,
        payload: {ok: false, error: "MISSING_POD",
          workflowStatus: "missing_pod"},
      };
    },
    lookupPrimusPod: async (loadNumber) => {
      lookups.push(String(loadNumber));
      if (String(loadNumber) === "100") {
        return {found: true, reason: "pod_on_booking", driveIds: ["d1"]};
      }
      return {found: false, reason: "no_pod", driveIds: []};
    },
    listOpenMissingPodItems: async () => ([
      {
        id: "pod-1",
        type: "missing_pod",
        issueType: "missing_pod",
        decisionStage: "missing_pod",
        status: "open",
        source: "dashboardTasks",
        invoiceId: "inv-pod",
        loadNumber: "100",
      },
      {
        id: "still-1",
        type: "missing_pod",
        issueType: "missing_pod",
        decisionStage: "missing_pod",
        status: "open",
        source: "dashboardTasks",
        invoiceId: "inv-still",
        loadNumber: "300",
      },
      {
        id: "rate-task",
        type: "missing_rate",
        issueType: "missing_rate",
        status: "open",
        source: "dashboardTasks",
        invoiceId: "inv-rate",
        loadNumber: "200",
      },
    ]),
    writeLog: async (level, category, message, details) => {
      logs.push({level, category, message, details});
    },
    saveOutboundEmail: async () => {
      emails.push("customer");
    },
  });

  const blocked = await pod.finishFromDashboard({
    tenant: {tenantId: "default"},
    tenantId: "default",
    taskId: "rate-task",
    source: "dashboardTasks",
    invoiceId: "inv-rate",
    loadNumber: "200",
    type: "missing_rate",
    issueType: "missing_rate",
  });
  check("finish refuses a row that is not missing POD", blocked.ok, false);
  check("refused row is not resumed", resumes.length, 0);

  const summary = await pod.runTwiceWeeklyCheck({
    tenant: {tenantId: "default"},
    tenantId: "default",
  });
  check("job completed the load whose Primus POD was found",
      summary.completed, 1);
  check("job resumed only that invoice", resumes, ["inv-pod"]);
  check("job did not look up the non-missing-POD row",
      lookups.includes("200"), false);
  check("job looked up the open missing POD loads",
      lookups.slice().sort(), ["100", "300"]);
  check("no-POD load was skipped",
      logs.some((row) => row.details &&
        row.details.invoiceId === "inv-still" &&
        row.details.result === "skipped" &&
        row.details.reason === "no_pod"), true);
  check("found POD was logged as finished",
      logs.some((row) => row.details &&
        row.details.invoiceId === "inv-pod" &&
        row.details.result === "completed"), true);
  check("non-missing-POD row was logged as a skip",
      logs.some((row) => row.details &&
        row.details.reason === "not_missing_pod"), true);
  check("finished task is removed from the dashboard",
      db.store["dashboardTasks/pod-1"].status, "dismissed");
  check("no-POD task stays on the dashboard",
      db.store["dashboardTasks/still-1"].status, "open");
  check("missing rate task was not closed",
      db.store["dashboardTasks/rate-task"].status, "open");
  check("job does not email the customer", emails.length, 0);

  resumes.length = 0;
  const failed = await pod.finishFromDashboard({
    tenant: {tenantId: "default"},
    tenantId: "default",
    taskId: "still-1",
    source: "dashboardTasks",
    invoiceId: "inv-still",
    loadNumber: "300",
    type: "missing_pod",
    issueType: "missing_pod",
    decisionStage: "missing_pod",
  });
  check("button reports a clear failure", failed.ok, false);
  check("failure mentions the POD",
      /pod/i.test(failed.error || ""), true);
  check("failed button leaves the row",
      db.store["dashboardTasks/still-1"].status, "open");
  check("failed button does not email the customer", emails.length, 0);
}

async function main() {
  await testQueuePhase();
  await testFinishAndSchedule();
  if (failures) {
    console.error(`${failures} failed`);
    process.exit(1);
  }
  console.log("missing POD dashboard tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
