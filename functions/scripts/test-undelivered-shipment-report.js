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

const {readDispatcherUser, lisaFallbackDispatcher} = report._internal;

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

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll undelivered shipment report checks passed");
