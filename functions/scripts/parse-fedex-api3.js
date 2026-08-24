"use strict";
const fs = require("fs");
const s = fs.readFileSync("chunk-OMTNGX7N.js", "utf8");
const anchors = [
  "getTrackingNumberInfo",
  "trackShipmentsUnauthUrl",
  "trackShipments(",
  "getBasicTrkcRequestData",
  "appConfig",
  "unauthUrl:",
  "auth4Url",
  "apiGateway",
];
for (const a of anchors) {
  let idx = 0;
  let n = 0;
  while ((idx = s.indexOf(a, idx)) !== -1 && n < 3) {
    console.log("\n====", a, "at", idx, "====");
    console.log(s.slice(idx, idx + 900));
    idx += a.length;
    n++;
  }
}
