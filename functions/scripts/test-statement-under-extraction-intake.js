/* eslint-disable no-console */
"use strict";

const queue = require("../mail-intake-queue");
const bundle = require("../statement-invoice-bundle");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const jts22568Gap = bundle.analyzeStatementExtractionGap({
  indexLoadNumbers: [
    "265379", "265630", "266088", "266134", "266219",
    "266213", "266214", "265501", "265502", "265503", "265504",
  ],
  extractedLoadNumbers: [
    "266213", "266214", "265379", "265630", "266088", "266134",
  ],
  pageCount: 54,
});

const partialSummary = queue.buildIntakeSummary({
  finalStatus: "statement_under_extracted",
  statementExtractionGap: jts22568Gap,
  itemSummaries: Array.from({length: 6}, (_, i) => ({
    finalStatus: "processing",
    invoiceId: `inv${i}`,
    loadNumber: jts22568Gap.missingLoads[0],
  })),
  _rebuildSummary: true,
});
check("intake summary is Partial not quiet processed",
    /Partial —/.test(partialSummary) &&
    !/^Processed email —/.test(partialSummary));
check("intake summary names missing load count",
    /5 load\(s\) not extracted/.test(partialSummary));
check("intake summary includes processed count",
    /6 processed/.test(partialSummary));

const allSkippedPartial = queue.buildIntakeSummary({
  finalStatus: "statement_under_extracted",
  statementExtractionGap: jts22568Gap,
  itemSummaries: jts22568Gap.missingLoads.map((loadNumber) => ({
    finalStatus: "already_processed_skipped",
    loadNumber,
  })),
  _rebuildSummary: true,
});
check("all-skipped + gap still Partial summary",
    /Partial —/.test(allSkippedPartial) &&
    /5 load\(s\) not extracted/.test(allSkippedPartial));

const splitSummary = queue.buildIntakeSummary({
  outcome: queue.OUTCOME.SPLIT,
  childCount: 6,
  summary:
    "Split into 6 invoice job(s) for processing. " +
    "WARNING: 5 load(s) not extracted: 266219, 265501, 265502, 265503, 265504",
});
check("split waiting summary preserves gap warning",
    /WARNING: 5 load\(s\) not extracted/.test(splitSummary));

const childRollup = queue.buildIntakeSummary({
  finalStatus: "statement_under_extracted",
  statementExtractionGap: jts22568Gap,
  itemSummaries: [
    {finalStatus: "processing", invoiceId: "a"},
    {finalStatus: "processing", invoiceId: "b"},
    {finalStatus: "processing", invoiceId: "c"},
    {finalStatus: "processing", invoiceId: "d"},
    {finalStatus: "processing", invoiceId: "e"},
    {finalStatus: "processing", invoiceId: "f"},
  ],
  childCount: 6,
  completedChildCount: 6,
  _rebuildSummary: true,
});
check("child rollup summary stays Partial with missing loads",
    /Partial —/.test(childRollup) &&
    /5 load\(s\) not extracted/.test(childRollup) &&
    /6 processed/.test(childRollup));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll statement under-extraction intake checks passed");
