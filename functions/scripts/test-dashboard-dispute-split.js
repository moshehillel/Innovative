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
      const rows = name === "dashboardTasks" ? tasks : charges;
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

  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
