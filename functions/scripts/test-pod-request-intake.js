/* eslint-disable no-console */
"use strict";

const pri = require("../pod-request-intake");
const {
  toOutboundEmailSafeSubject,
  toOutboundEmailSafeText,
} = require("../email-outbound-safe");

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

// AI must win over heuristic (Albert / load 265902 style)
const schedulingCls = {
  intent: "unknown",
  confidence: "high",
  reasoning: "Scheduling reply about delivery appointment, not a POD request",
};
const quotedSigBody =
  "Can we move the appointment to Thursday?\n\n" +
  "On Mon, someone wrote:\n" +
  "> If POD is signed clear and send copy for load 265902\n";
check("unquoted POD ask still detected",
    pri.looksLikePodRequest(
        "Re: Load 265902",
        "If POD is signed clear and send copy",
    ));
check("quoted reply POD boilerplate ignored by heuristic",
    !pri.looksLikePodRequest("Re: Load 265902", quotedSigBody));
check("AI rejects scheduling unknown",
    pri.aiRejectsPodRequest(schedulingCls));
check("isPodRequest blocked when AI says not POD",
    !pri.isPodRequestEmail(
        "Re: Load 265902",
        "Please send the POD for load 265902",
        "unknown",
        schedulingCls,
    ));
check("heuristic still works when AI did not run",
    pri.isPodRequestEmail(
        "POD for load 264091",
        "Can you send the POD?",
        "unknown",
        {intent: "unknown", reasoning: "Classifier unavailable."},
    ));
check("carrier_invoice intent blocks heuristic POD",
    !pri.isPodRequestEmail(
        "POD for load 264091",
        "Can you send the POD?",
        "carrier_invoice",
        {intent: "carrier_invoice", reasoning: "Carrier bill PDF"},
    ));
check("pod_request intent still wins",
    pri.isPodRequestEmail(
        "",
        "",
        "pod_request",
        {intent: "pod_request", reasoning: "Asks for POD"},
    ));
check("quote_request intent blocks heuristic",
    pri.aiRejectsPodRequest({intent: "quote_request", reasoning: "RFQ"}));

// Encoding: em dash / smart quotes must never become â€
const mojibakeSubject = toOutboundEmailSafeSubject(
    "Proof of Delivery — Load #265902");
check("POD subject uses ASCII dash",
    mojibakeSubject === "Proof of Delivery - Load #265902");
check("subject has no mojibake bytes",
    !mojibakeSubject.includes("â") && !/[\u0080-\uFFFF]/.test(mojibakeSubject));
check("smart quotes folded",
    toOutboundEmailSafeText("He said \u201Chello\u201D") ===
    "He said \"hello\"");
check("em dash in body folded",
    toOutboundEmailSafeText("A — B") === "A - B");

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nAll pod request intake tests passed");
