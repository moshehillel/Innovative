"use strict";
const fs = require("fs");
const s = fs.readFileSync("chunk-OMTNGX7N.js", "utf8");
const needles = ["unauthUrl", "auth4", "gateway", "fxf", "FDXFWEB", "wtrk"];
for (const n of needles) {
  let idx = 0;
  let c = 0;
  while ((idx = s.indexOf(n, idx)) !== -1 && c < 8) {
    const snippet = s.slice(Math.max(0, idx - 30), idx + 100);
    if (/url|Url|gateway|http|api/i.test(snippet)) {
      console.log(n, ":", snippet.replace(/\n/g, " "));
    }
    idx += n.length;
    c++;
  }
}
