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

// Load 267539: page 2 is a scanned delivery receipt (almost no text) and the
// invoice was saved with attachments stripped after the packet was refused.
const intakePdf = [{
  filename: "694049676.pdf",
  storagePath: "emailAttachments/edi/694049676.pdf",
  docType: "INVOICE",
}];
const recovered = podUtils.supplementStrippedPodAttachments([], intakePdf);
check("stripped invoice recovers the email PDF",
    recovered.length === 1 &&
    recovered[0].filename === "694049676.pdf");
check("recovered file resolves the page-2 signed POD",
    podUtils.resolvePodAttachment(recovered, {
      source: "signed_pod",
      page: 2,
      attachmentFilename: "694049676.pdf",
    }, {proNumber: null}).storagePath === intakePdf[0].storagePath);
check("invoice that already has a PDF does not gain sibling files",
    podUtils.supplementStrippedPodAttachments(
        [{filename: "scoped.pdf", storagePath: "a/scoped", docType: "INVOICE"}],
        intakePdf.concat([{
          filename: "sibling.pdf",
          storagePath: "a/sib",
          docType: "INVOICE",
        }]),
    ).length === 1);
check("scanned delivery-receipt page is not treated as a cost page",
    podUtils.textLooksUnsafeForCustomer("262148", 378.37).unsafe === false);

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("All invoice+POD page-2 checks passed.");
