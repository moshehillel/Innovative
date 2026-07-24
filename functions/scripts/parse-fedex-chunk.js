"use strict";
const fs = require("fs");
const s = fs.readFileSync("chunk-OMTNGX7N.js", "utf8");
const patterns = [
  "openOverlayPod", "openInlinePod", "ppodImage", "getPod",
  "proofOfDelivery", "proof-of-delivery", "trackingdocuments",
  "documentType", "viewPdf", "View PDF", "accountNumber",
  "/track/", "/api/", "fedexfreight", "FDFR",
];
for (const p of patterns) {
  let idx = 0;
  let count = 0;
  while ((idx = s.indexOf(p, idx)) !== -1 && count < 8) {
    console.log("\n---", p, "at", idx, "---");
    console.log(s.slice(Math.max(0, idx - 100), idx + 200).replace(/\n/g, " "));
    idx += p.length;
    count++;
  }
}
