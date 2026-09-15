"use strict";
/**
 * POD detection / extraction regression tests for Lisa's misses:
 * - separate_attachment with page must extract that page (not hold whole file)
 * - last-page fallback when classifier leaves pod.found=false
 */
const assert = require("assert");
const podUtils = require("../pod-utils");

let failures = 0;
function check(name, actual, expected) {
  try {
    if (arguments.length === 2) {
      assert.ok(actual, name);
    } else {
      assert.deepStrictEqual(actual, expected, name);
    }
    console.log("PASS", name);
  } catch (err) {
    failures += 1;
    console.error("FAIL", name, err.message);
  }
}

const kirusPod = {
  found: true,
  documents: [{
    source: "separate_attachment",
    page: 3,
    attachmentFilename: "26-0909-10 Innovative Carriers (267524).pdf",
    reason: "Signed Bill of Lading showing delivery signature",
  }],
};
const resolved = podUtils.resolvePodDocuments(kirusPod, {pageCount: 3});
check("paged separate_attachment upgrades off whole-file source",
    resolved.documents.length === 1 &&
    resolved.documents[0].source !== "separate_attachment");
check("paged separate_attachment keeps page 3",
    Number(resolved.documents[0].page), 3);
check("paged separate_attachment found",
    resolved.normalized.found, true);

const noPageSeparate = podUtils.resolvePodDocuments({
  found: true,
  documents: [{
    source: "separate_attachment",
    attachmentFilename: "pod-only.pdf",
    reason: "standalone POD",
  }],
}, {pageCount: 1});
check("separate_attachment without page stays separate_attachment",
    noPageSeparate.documents[0].source, "separate_attachment");

const miss = podUtils.inferLastPagePodIfMissing(
    {found: false, documents: []},
    {
      pageCount: 4,
      attachmentFilename: "EML-267378_105455281.pdf",
      lastPageText: null,
      invoiceAmount: 1250,
    });
check("last-page fallback when classifier missed",
    !!(miss && miss.found));
check("last-page fallback uses last_page_of_invoice",
    miss.documents[0].source, "last_page_of_invoice");
check("last-page fallback page is last",
    Number(miss.documents[0].page), 4);

const unsafeLast = podUtils.inferLastPagePodIfMissing(
    {found: false},
    {
      pageCount: 3,
      attachmentFilename: "bill.pdf",
      lastPageText: "Amount Due $1250.00 Total Carrier Pay",
      invoiceAmount: 1250,
    });
check("last-page fallback skipped when last page is the bill",
    unsafeLast, null);

const alreadyFound = podUtils.inferLastPagePodIfMissing(
    {found: true, documents: [{source: "signed_bol", page: 2}]},
    {
      pageCount: 3,
      attachmentFilename: "x.pdf",
      lastPageText: null,
      invoiceAmount: 100,
    });
check("last-page fallback skipped when pod already found",
    alreadyFound, null);

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
