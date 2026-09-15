"use strict";
/**
 * POD extraction regression: paged separate_attachment must extract that page
 * (not hold the whole multipage scanned file as missing POD).
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

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
