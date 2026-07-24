"use strict";
const fs = require("fs");
const s = fs.readFileSync("chunk-OMTNGX7N.js", "utf8");
const needles = ["SPOD", "buildBillLink", "retrievePDF", "BILL_TYPE", "type:\"POD\"", "documentImage"];
for (const n of needles) {
  let idx = 0;
  let c = 0;
  while ((idx = s.indexOf(n, idx)) !== -1 && c < 4) {
    console.log("\n---", n, "---");
    console.log(s.slice(Math.max(0, idx - 60), idx + 180).replace(/\n/g, " "));
    idx += n.length;
    c++;
  }
}
