"use strict";
const fs = require("fs");
const s = fs.readFileSync("chunk-OMTNGX7N.js", "utf8");
const anchors = [
  "fetchMainShipment",
  "track-shipments",
  "getTrackPackages",
  "trackPackagesUrl",
  "unauthUrl",
  "auth4Url",
  "api.unauthUrl",
  "viewPdf",
  "View PDF",
  "spodInfo",
  "matchedAccountList",
  "BILL_TYPE",
  "type:\"POD\"",
  "documentUrl",
  "pdfUrl",
];
for (const a of anchors) {
  let idx = 0;
  let n = 0;
  while ((idx = s.indexOf(a, idx)) !== -1 && n < 5) {
    console.log("\n====", a, "at", idx, "====");
    console.log(s.slice(Math.max(0, idx - 50), idx + 600));
    idx += a.length;
    n++;
  }
}
