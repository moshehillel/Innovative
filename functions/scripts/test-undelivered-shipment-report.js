#!/usr/bin/env node
"use strict";

const report = require("../undelivered-shipment-report");

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) {
    console.log(`  expected: ${JSON.stringify(expected)}`);
    console.log(`  actual:   ${JSON.stringify(actual)}`);
    failures += 1;
  }
}

const {
  readDispatcherUser,
  lisaFallbackDispatcher,
  resolveDispatcherForRow,
} = report._internal;

check("dispatchedByUser used when set",
    readDispatcherUser({dispatchedByUser: "jakj", CreatedBy: "rose@x.com"}),
    "jakj");
check("CreatedBy ignored when no dispatcher",
    readDispatcherUser({
      dispatchedByUser: null,
      CreatedBy: "ROSE@INNOVATIVECARRIERS.COM",
      controlledBy: "4211",
    }),
    "");
check("266122-style row has no dispatcher username",
    readDispatcherUser({
      dispatchedByUser: null,
      CreatedBy: "ROSE@INNOVATIVECARRIERS.COM",
      controlledBy: "4211",
    }),
    "");

const fallback = lisaFallbackDispatcher();
check("Lisa fallback email",
    fallback.email, "lisa@innovativecarriers.com");
check("Lisa fallback ok", fallback.ok, true);

async function runAsync() {
  const users = [
    {
      id: "1",
      userName: "jakj",
      firstName: "Jason",
      lastName: "K",
      email: "jason@innovativecarriers.com",
    },
    {
      id: "2",
      userName: "leo",
      firstName: "Leo",
      lastName: "Ops",
      email: "leo@innovativecarriers.com",
    },
  ];
  report.init({
    primusUiBridge: {
      lookupPrimusUsers: async (query) => {
        const q = String(query || "").toLowerCase();
        return {
          ok: true,
          users: users.filter((u) =>
            String(u.userName).toLowerCase() === q),
        };
      },
      // If this were used, Leo would win — report must not call it.
      resolveDispatcherEmail: async () => ({
        ok: true,
        email: "leo@innovativecarriers.com",
        userName: "leo",
        displayName: "Leo",
      }),
    },
  });

  const jason = await resolveDispatcherForRow({
    dispatcherUser: "jakj",
    dispatchedByUser: "jakj",
    controlledBy: "leo",
  });
  check("Jason dispatcher email wins over Controlled-by leo",
      jason.email, "jason@innovativecarriers.com");
  check("Jason display name", jason.displayName.includes("Jason"), true);

  const none = await resolveDispatcherForRow({
    dispatcherUser: "",
    dispatchedByUser: null,
    controlledBy: "leo",
    createdBy: "ROSE@INNOVATIVECARRIERS.COM",
  });
  check("No dispatcher falls back to Lisa not Leo",
      none.email, "lisa@innovativecarriers.com");
  check("No dispatcher is fallback flag", none.fallback, true);

  const missing = await resolveDispatcherForRow({
    dispatcherUser: "tina",
    dispatchedByUser: "tina",
    controlledBy: "leo",
  });
  check("Unknown dispatcher falls back to Lisa not Leo",
      missing.email, "lisa@innovativecarriers.com");
}

runAsync().then(() => {
  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll undelivered shipment report checks passed");
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
