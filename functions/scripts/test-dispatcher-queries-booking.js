#!/usr/bin/env node
"use strict";

/**
 * Regression: additional-charge / Jerry alerts must prefer dispatchedByUser
 * over booking.userName (Controlled-by), which is often Leo ops.
 */

const bridge = require("../primus-ui-bridge");
const {dispatcherQueriesFromBooking} = bridge._internal;

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) {
    console.log(`  expected: ${JSON.stringify(expected)}`);
    console.log(`  actual:   ${JSON.stringify(actual)}`);
    failures += 1;
  }
}

// Load 262849 shape: Leom Controlled-by, JasonS dispatched.
const queries262849 = dispatcherQueriesFromBooking({
  userName: "Leom",
  dispatchedByUser: "JasonS",
  CreatedBy: "JasonS",
  controlledBy: "5275",
  contactInformation: {
    controlUser: {name: "Jason Salgado"},
  },
});
check("262849 prefers JasonS before Leom",
    queries262849[0], "JasonS");
check("262849 does not lead with Leom",
    queries262849[0] !== "Leom", true);
check("262849 includes Jason display name as fallback",
    queries262849.includes("Jason Salgado"), true);

const onlyControlled = dispatcherQueriesFromBooking({
  userName: "Leom",
  dispatchedByUser: "",
  CreatedBy: "ROSE@INNOVATIVECARRIERS.COM",
});
check("no dispatchedBy still lists CreatedBy before userName",
    onlyControlled[0], "ROSE@INNOVATIVECARRIERS.COM");
check("userName last when no dispatchedBy",
    onlyControlled[onlyControlled.length - 1], "Leom");

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll dispatcherQueriesFromBooking checks passed");
