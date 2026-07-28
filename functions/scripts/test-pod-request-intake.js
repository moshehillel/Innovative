/* eslint-disable no-console */
"use strict";

const pri = require("../pod-request-intake");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

check("detects please send POD",
    pri.looksLikePodRequest("POD for load 264091", "Can you send the POD?"));
check("detects proof of delivery request",
    pri.looksLikePodRequest("Need proof of delivery", "For BOL 265042"));
check("ignores carrier invoice subject",
    !pri.looksLikePodRequest("FW: Invoice from Saia", "Invoice attached"));
check("detects signed POD ask",
    pri.looksLikeSignedPodRequest("Signed POD", "Need signed BOL for load"));
check("regular pod ask not signed",
    !pri.looksLikeSignedPodRequest("Send POD", "Please send pod for 264091"));
check("parse angle email",
    pri.parseEmailAddressFromHeader("Jane <jane@example.com>") ===
    "jane@example.com");
check("isPodRequest via intent",
    pri.isPodRequestEmail("", "", "pod_request"));

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nAll pod request intake tests passed");
