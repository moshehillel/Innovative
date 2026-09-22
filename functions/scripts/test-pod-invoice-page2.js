/* eslint-disable no-console */
"use strict";

const podUtils = require("../pod-utils");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

// 2-page invoice + POD listing both pages is NOT sibling bleed.
check("2-page [1,2] does not need repair",
    podUtils.scopedPagesNeedRepair([1, 2], 2) === false);
check("2-page empty pages still needs repair",
    podUtils.scopedPagesNeedRepair([], 2) === true);
check("2-page [1] alone is fine (invoice-only scope)",
    podUtils.scopedPagesNeedRepair([1], 2) === false);

// Multi-page shared packet bleed still flagged.
check("4-page covering all pages needs repair",
    podUtils.scopedPagesNeedRepair([1, 2, 3, 4], 4) === true);
check("5-page nearly-all (≥80%) needs repair",
    podUtils.scopedPagesNeedRepair([1, 2, 3, 4], 5) === true);
check("5-page tight scope ok",
    podUtils.scopedPagesNeedRepair([1, 2], 5) === false);

const atts = [
  {filename: "687759436.pdf", storagePath: "a/1", docType: "INVOICE"},
  {filename: "694049713.pdf", storagePath: "a/3", docType: "INVOICE"},
];
const doc = {
  source: "delivery_receipt",
  page: 2,
  attachmentFilename: "694049713.pdf",
};
check("resolvePodAttachment exact filename",
    podUtils.resolvePodAttachment(atts, doc, {
      proNumber: "694049713",
    }).filename === "694049713.pdf");

check("resolvePodAttachment falls back via PRO when filename missing",
    podUtils.resolvePodAttachment(atts, {
      source: "delivery_receipt",
      page: 2,
      attachmentFilename: "missing-invented.pdf",
    }, {proNumber: "694049713"}).filename === "694049713.pdf");

check("resolvePodAttachment single leftover PDF",
    podUtils.resolvePodAttachment(
        [{filename: "only.pdf", storagePath: "x", docType: "INVOICE"}],
        {page: 2, attachmentFilename: "wrong.pdf"},
        {},
    ).filename === "only.pdf");

const rules = podUtils.buildPodClassifierRules({singlePdf: false}).join(" ");
check("classifier rules mention EDI Express 2-page invoice+POD",
    /EDI Express/i.test(rules) && /page 2/i.test(rules));

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("All invoice+POD page-2 checks passed.");
