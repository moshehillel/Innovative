"use strict";
const fs = require("fs");
const s = fs.readFileSync("fedex-main.js", "utf8");
const needles = [
  "proof", "POD", "pod", "document", "trackingdocuments",
  "fedextrack", "trknbr", "FDFR", "account", "pdf", "download",
  "/api/", "/track/", "apis.fedex",
];
for (const n of needles) {
  let idx = 0;
  let count = 0;
  while ((idx = s.indexOf(n, idx)) !== -1 && count < 5) {
    console.log("\n---", n, "at", idx, "---");
    console.log(s.slice(Math.max(0, idx - 80), idx + 120).replace(/\n/g, " "));
    idx += n.length;
    count++;
  }
}
