"use strict";
const fs = require("fs");
const s = fs.readFileSync("chunk-OMTNGX7N.js", "utf8");
const anchors = [
  "retrieveTrackingDocuments",
  "track-shipments",
  "/track/v2/documents",
  "getDetailPageData",
  "detailPageService",
  "TRKC_RETRIEVE_PDF",
  "WTRK_B",
  "unauthUrl",
  "apiGatewayUrl",
  "viewPdf",
  "ViewPdf",
  "documentType",
  "POD",
];
for (const a of anchors) {
  let idx = s.indexOf(a);
  while (idx !== -1) {
    console.log("\n====", a, "at", idx, "====");
    console.log(s.slice(idx, idx + 800));
    idx = s.indexOf(a, idx + a.length);
    if (idx > 0 && idx - s.indexOf(a) > 5000) break;
  }
}
