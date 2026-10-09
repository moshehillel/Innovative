/* eslint-disable no-console */
"use strict";

/**
 * markQuoteForReview must not stay on the 256MiB default. That limit
 * OOM-kills the functions bundle mid-request and Cloud Run returns 500.
 */

const fs = require("fs");
const path = require("path");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const src = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
const start = src.indexOf("exports.markQuoteForReview = onRequest(");
const end = src.indexOf("exports.exportQuoteDispatcherReport");
const block = start >= 0 && end > start ? src.slice(start, end) : "";

check("markQuoteForReview export exists", start >= 0 && end > start);
check("markQuoteForReview memory is at least 512MiB",
    /memory:\s*"(?:512MiB|1GiB)"/.test(block));
check("markQuoteForReview does not use the 256MiB default",
    !/memory:\s*"256MiB"/.test(block));

const quoteStart = src.indexOf("exports.getQuoteRules = onRequest(");
const quoteEnd = src.indexOf("exports.processQuoteWorkflow");
const quoteSection = quoteStart >= 0 && quoteEnd > quoteStart ?
  src.slice(quoteStart, quoteEnd) : "";
check("quote dashboard HTTP exports section exists", quoteSection.length > 0);

const exportRe = /exports\.(\w+) = onRequest\(\{([^}]*)\}/g;
let match;
let quoteExports = 0;
while ((match = exportRe.exec(quoteSection))) {
  quoteExports++;
  const name = match[1];
  const opts = match[2];
  check(`${name} memory is at least 512MiB`,
      /memory:\s*"(?:512MiB|1GiB)"/.test(opts));
  check(`${name} does not use the 256MiB default`,
      !/memory:\s*"256MiB"/.test(opts));
}
check("quote dashboard HTTP exports were scanned", quoteExports > 0);

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
