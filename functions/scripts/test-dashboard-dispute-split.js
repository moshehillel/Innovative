/* eslint-disable no-console */
"use strict";

const dashboardTasks = require("../dashboard-tasks");

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

/**
 * @param {object[]} tasks Task docs.
 * @param {object[]} charges Follow-up docs.
 * @return {object}
 */
function mockDb(tasks, charges) {
  /**
   * @param {object[]} rows Docs.
   * @return {object}
   */
  function snap(rows) {
    return {
      empty: rows.length === 0,
      docs: rows.map((row) => ({
        id: row.id,
        data: () => row.data,
        ref: {id: row.id},
      })),
      forEach(fn) {
        this.docs.forEach((doc) => fn(doc));
      },
    };
  }

  return {
    collection(name) {
      const rows = name === "dashboardTasks" ? tasks :
        (name === "dashboardNotifications" ? [] : charges);
      const filters = [];
      const query = {
        where(field, _op, value) {
          filters.push([field, value]);
          return query;
        },
        orderBy() {
          return query;
        },
        limit() {
          return query;
        },
        async get() {
          const matched = rows.filter((row) => filters.every(([field, value]) => {
            if (field === "tenantId") {
              return !row.data.tenantId || row.data.tenantId === value;
            }
            if (field === "status") return row.data.status === value;
            if (field === "resolved") return row.data.resolved === value;
            return row.data[field] === value;
          }));
          return snap(matched);
        },
        doc(id) {
          return {id};
        },
      };
      return query;
    },
    async getAll(...refs) {
      return refs.map((ref) => {
        const row = charges.find((charge) => charge.id === ref.id);
        return {
          id: ref.id,
          exists: Boolean(row),
          data: () => (row ? row.data : {}),
        };
      });
    },
  };
}

const chargesMod = {FOLLOW_UP_COLLECTION: "additionalCharges"};

const review = {
  id: "review-1",
  data: {
    tenantId: "default",
    type: "human_review",
    title: "Review remittance",
    status: "open",
    createdAt: {toDate: () => new Date("2026-11-02T12:00:00Z")},
  },
};
const pendingTask = {
  id: "task-pending",
  data: {
    tenantId: "default",
    type: "additional_charge",
    title: "Additional charge",
    status: "open",
    followUpId: "fu-pending",
    loadNumber: "100",
    createdAt: {toDate: () => new Date("2026-11-01T12:00:00Z")},
  },
};
const disputeTask = {
  id: "task-dispute",
  data: {
    tenantId: "default",
    type: "additional_charge",
    title: "Additional charge",
    status: "open",
    followUpId: "fu-dispute",
    loadNumber: "200",
    createdAt: {toDate: () => new Date("2026-10-01T12:00:00Z")},
  },
};
const pendingCharge = {
  id: "fu-pending",
  data: {
    tenantId: "default",
    status: "pending_approval",
    resolved: false,
    loadNumber: "100",
    createdAt: {toDate: () => new Date("2026-11-01T12:00:00Z")},
  },
};
const disputeCharge = {
  id: "fu-dispute",
  data: {
    tenantId: "default",
    status: "disputing",
    decision: "D",
    resolved: false,
    loadNumber: "200",
    notes: "Rate is wrong",
    createdAt: {toDate: () => new Date("2026-10-01T12:00:00Z")},
  },
};
const orphanDispute = {
  id: "fu-orphan",
  data: {
    tenantId: "default",
    status: "disputing",
    decision: "D",
    resolved: false,
    loadNumber: "300",
    createdAt: {toDate: () => new Date("2026-09-01T12:00:00Z")},
  },
};

async function main() {
  const db = mockDb(
      [review, pendingTask, disputeTask],
      [pendingCharge, disputeCharge, orphanDispute],
  );
  const work = await dashboardTasks.listDashboardTasks(db, chargesMod, {
    tenantId: "default",
    limit: 20,
  });
  const dispute = await dashboardTasks.listDashboardTasks(db, chargesMod, {
    tenantId: "default",
    limit: 20,
    chargePhase: "dispute",
  });
  const workIds = work.tasks.map((task) => task.id).sort();
  const disputeIds = dispute.tasks.map((task) => task.id).sort();
  check("work and dispute ids differ",
      workIds.join() !== disputeIds.join(),
      `work=${workIds} dispute=${disputeIds}`);
  check("work keeps review and pending charge",
      workIds.includes("review-1") && workIds.includes("task-pending") &&
      !workIds.includes("task-dispute") && !workIds.includes("fu-orphan"),
      workIds.join());
  check("dispute is only option D rows",
      disputeIds.includes("task-dispute") && disputeIds.includes("fu-orphan") &&
      !disputeIds.includes("review-1") && !disputeIds.includes("task-pending"),
      disputeIds.join());
  check("dispute count is shared and not the work count",
      work.disputeCount === 2 && dispute.disputeCount === 2 &&
      work.openCount === 2 && dispute.openCount === 2,
      JSON.stringify({
        workOpen: work.openCount,
        disputeOpen: dispute.openCount,
        workDispute: work.disputeCount,
        disputeDispute: dispute.disputeCount,
      }));
  const stamped = dispute.tasks.find((task) => task.id === "task-dispute");
  check("linked dispute carries phase and decision",
      stamped && stamped.chargePhase === "dispute" &&
      String(stamped.decision).toLowerCase() === "d" &&
      stamped.followUpStatus === "disputing",
      JSON.stringify(stamped));
  check("client filter would keep dispute rows and drop them from work",
      dispute.tasks.every(dashboardTasks.isOptionDDispute) &&
      work.tasks.every((task) => !dashboardTasks.isOptionDDispute(task)));

  const stamp = (iso) => ({toDate: () => new Date(iso)});
  const dupTask = (id, followUpId, total, iso) => ({
    id,
    data: {
      tenantId: "default",
      type: "additional_charge",
      status: "open",
      loadNumber: "265879",
      reason: "weight_inspection",
      chargesTotal: total,
      followUpId,
      createdAt: stamp(iso),
    },
  });
  const dupFollow = (id, total, iso) => ({
    id,
    data: {
      tenantId: "default",
      status: "pending_approval",
      resolved: false,
      loadNumber: "265879",
      category: "weight_inspection",
      chargesTotal: total,
      createdAt: stamp(iso),
    },
  });
  const dupDb = mockDb(
      [
        dupTask("new-824", "fu-new", 824.71, "2026-11-02T17:20:12.406Z"),
        dupTask("old-824", "fu-old", 824.71, "2026-11-02T17:10:08.285Z"),
        dupTask("amt-440", "fu-440", 440, "2026-11-01T18:20:15.775Z"),
        {
          id: "lumper",
          data: {
            tenantId: "default",
            type: "additional_charge",
            status: "open",
            loadNumber: "265879",
            reason: "accessorial",
            chargesTotal: 824.71,
            followUpId: "fu-lumper",
            createdAt: stamp("2026-11-02T12:00:00.000Z"),
          },
        },
      ],
      [
        dupFollow("fu-new", 824.71, "2026-11-02T17:20:12.273Z"),
        dupFollow("fu-old", 824.71, "2026-11-02T17:10:08.218Z"),
        dupFollow("fu-440", 440, "2026-11-01T18:20:15.775Z"),
        dupFollow("fu-lumper", 824.71, "2026-11-02T12:00:00.000Z"),
      ],
  );
  const collapsed = await dashboardTasks.listDashboardTasks(dupDb, chargesMod, {
    tenantId: "default",
    limit: 20,
    chargePhase: "all",
  });
  const collapsedIds = collapsed.tasks.map((task) => task.id).sort();
  check("same load and amount collapses to the newest row",
      collapsedIds.includes("new-824") && !collapsedIds.includes("old-824"),
      collapsedIds.join());
  check("different amount and different charge kind stay",
      collapsedIds.includes("amt-440") && collapsedIds.includes("lumper") &&
      collapsed.tasks.length === 3,
      collapsedIds.join());
  check("same message id is one human-review task",
      dashboardTasks.collapseDuplicateTasks([
        {
          id: "mail-a",
          type: "human_review",
          messageId: "m1",
          loadNumber: "1",
          reason: "review",
          createdAt: "2026-11-02T10:00:00.000Z",
        },
        {
          id: "mail-b",
          type: "human_review",
          messageId: "m1",
          loadNumber: "1",
          reason: "review",
          createdAt: "2026-11-02T11:00:00.000Z",
        },
        {
          id: "mail-c",
          type: "human_review",
          messageId: "m2",
          loadNumber: "1",
          reason: "review",
          createdAt: "2026-11-02T12:00:00.000Z",
        },
      ]).map((task) => task.id).sort().join() === "mail-b,mail-c");

  check("dispatcherMatches finds Leo by email",
      dashboardTasks.dispatcherMatches({
        dispatcherEmail: "leo@innovativecarriers.com",
        dispatcherKey: "leo",
        dispatcherName: "Leo",
      }, "leo@innovativecarriers.com") === true);
  check("dispatcherMatches finds Leo by key",
      dashboardTasks.dispatcherMatches({
        dispatcherEmail: "leo@innovativecarriers.com",
        dispatcherKey: "leo",
      }, "leo") === true);
  check("dispatcherMatches rejects other dispatcher",
      dashboardTasks.dispatcherMatches({
        dispatcherEmail: "jak@innovativecarriers.com",
        dispatcherKey: "jak",
      }, "leo") === false);
  check("dispatcherMatches blank query keeps all",
      dashboardTasks.dispatcherMatches({dispatcherKey: "leo"}, "") === true);

  const leoOnly = dashboardTasks.partitionByChargePhase([
    {
      id: "leo-1",
      type: "additional_charge",
      dispatcherKey: "leo",
      dispatcherEmail: "leo@innovativecarriers.com",
    },
    {
      id: "jak-1",
      type: "additional_charge",
      dispatcherKey: "jak",
      dispatcherEmail: "jak@innovativecarriers.com",
    },
    {
      id: "none-1",
      type: "human_review",
    },
  ], {chargePhase: "", dispatcher: "leo", limit: 20, offset: 0});
  check("partition filters to selected dispatcher only",
      leoOnly.tasks.length === 1 && leoOnly.tasks[0].id === "leo-1" &&
      leoOnly.filteredCount === 1,
      leoOnly.tasks.map((t) => t.id).join());

  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
