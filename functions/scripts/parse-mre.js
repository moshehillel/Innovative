"use strict";
const fs = require("fs");
const s = fs.readFileSync("chunk-OMTNGX7N.js", "utf8");
const idx = s.indexOf("var mre={apiPath");
console.log(s.slice(idx, idx + 5000));
