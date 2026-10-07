"use strict";
/**
 * Regression: invoice+POD email (MAV 267514) — keep AI-named POD sidecar
 * when preferred invoice PDF is selected; recover from email intake if
 * the invoice doc dropped it.
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

const mavPod = {
  found: true,
  documents: [{
    source: "signed_bol",
    page: 1,
    attachmentFilename: "MAV-INNOV-26-POD.pdf",
    reason: "Signed BOL",
  }],
  source: "signed_bol",
  page: 1,
  attachmentFilename: "MAV-INNOV-26-POD.pdf",
};

const names = podUtils.collectPodReferencedFilenames(mavPod);
check("collects MAV POD filename", names, ["MAV-INNOV-26-POD.pdf"]);
check("looksLikePodCompanionFilename MAV",
    podUtils.looksLikePodCompanionFilename("MAV-INNOV-26-POD.pdf"), true);
check("looksLikePodCompanionFilename invoice",
    podUtils.looksLikePodCompanionFilename("INV-MAV-INNOV-26.pdf"), false);

const stored = [
  {
    filename: "INV-MAV-INNOV-26.pdf",
    storagePath: "emailAttachments/msg/inv.pdf",
    docType: "INVOICE",
  },
  {
    filename: "MAV-INNOV-26-POD.pdf",
    storagePath: "emailAttachments/msg/pod.pdf",
    // Pre-check mislabeled the standalone POD as an invoice.
    docType: "INVOICE",
  },
  {
    filename: "sibling-bill.pdf",
    storagePath: "emailAttachments/msg/sib.pdf",
    docType: "INVOICE",
  },
];

const preferredName = "INV-MAV-INNOV-26.pdf";
const podFilenames = podUtils.collectPodReferencedFilenames(mavPod);
const retagged = stored.map((att) => {
  const namedPod = podFilenames.some((n) =>
    podUtils.attachmentFilenamesMatch(att.filename, n));
  return Object.assign({}, att, {docType: namedPod ? "POD" : att.docType});
});
check("retags AI-named POD docType",
    retagged.find((a) => a.filename === "MAV-INNOV-26-POD.pdf").docType,
    "POD");

const preferred = retagged.filter((a) =>
  podUtils.attachmentFilenamesMatch(a.filename, preferredName));
const rest = retagged.filter((a) =>
  !podUtils.attachmentFilenamesMatch(a.filename, preferredName));
const kept = preferred.concat(rest.filter((a) =>
  podUtils.isLoadSidecarAttachment(a, {podFilenames})));
check("keeps invoice + POD, drops sibling",
    kept.map((a) => a.filename).sort(),
    ["INV-MAV-INNOV-26.pdf", "MAV-INNOV-26-POD.pdf"].sort());

// Old bug path: invoice only has INV; intake still has POD.
const invoiceOnly = [stored[0]];
const intake = stored.slice(0, 2);
const recovered = podUtils.supplementMissingPodReferencedAttachments(
    invoiceOnly, intake, mavPod);
check("recovers named POD from intake",
    recovered.map((a) => a.filename),
    ["INV-MAV-INNOV-26.pdf", "MAV-INNOV-26-POD.pdf"]);
check("recovered POD is tagged POD",
    recovered[1].docType, "POD");

const resolved = podUtils.resolvePodAttachment(
    recovered,
    {attachmentFilename: "MAV-INNOV-26-POD.pdf", source: "signed_bol"},
    {attachmentFilename: preferredName},
);
check("resolvePodAttachment picks POD not invoice",
    resolved && resolved.filename, "MAV-INNOV-26-POD.pdf");

// Wrong-file fallback would have scanned the invoice and hit $1,165.
const wrong = podUtils.resolvePodAttachment(
    invoiceOnly,
    {attachmentFilename: "MAV-INNOV-26-POD.pdf", source: "signed_bol"},
    {attachmentFilename: preferredName},
);
check("without recovery, falls back to sole invoice PDF",
    wrong && wrong.filename, "INV-MAV-INNOV-26.pdf");

// Ops: upload ALL BOL/POD pages — fill gaps + trailing; dedicated POD
// companions also keep leading pages the classifier skipped.
const gapFilled = podUtils.enrichPodDocumentsWithTrailingPages(
    [
      {
        source: "unsigned_pod_template",
        page: 2,
        attachmentFilename: "carrier-invoice-packet.pdf",
        reason: "form",
      },
      {
        source: "signed_bol",
        page: 4,
        attachmentFilename: "carrier-invoice-packet.pdf",
        reason: "signed",
      },
    ],
    5,
    "carrier-invoice-packet.pdf",
);
check("fills gap page between classified POD pages",
    gapFilled.map((d) => d.page),
    [2, 3, 4, 5]);

const companionFilled = podUtils.normalizePodData({
  found: true,
  documents: [{
    source: "signed_bol",
    page: 3,
    attachmentFilename: "MAV-INNOV-26-POD.pdf",
    reason: "last signed only",
  }],
}, {pageCount: 3, attachmentFilename: "MAV-INNOV-26-POD.pdf"});
check("dedicated POD companion keeps leading + listed pages",
    companionFilled.documents.map((d) => d.page),
    [1, 2, 3]);

const invoiceOnlyLast = podUtils.normalizePodData({
  found: true,
  documents: [{
    source: "delivery_receipt",
    page: 3,
    attachmentFilename: "carrier-invoice.pdf",
    reason: "signed last page only",
  }],
}, {pageCount: 3, attachmentFilename: "carrier-invoice.pdf"});
check("combined invoice PDF does not back-fill before first POD page",
    invoiceOnlyLast.documents.map((d) => d.page),
    [3]);

const dupPods = podUtils.listUnreferencedPodCompanionAttachments(
    [
      {
        filename: "INV-MAV.pdf",
        storagePath: "a/inv.pdf",
        docType: "INVOICE",
      },
      {
        filename: "MAV-INNOV-26-POD.pdf",
        storagePath: "a/pod1.pdf",
        docType: "POD",
      },
      {
        filename: "MAV-INNOV-26-POD-copy.pdf",
        storagePath: "a/pod2.pdf",
        docType: "POD",
      },
    ],
    [{
      source: "signed_bol",
      page: 1,
      attachmentFilename: "MAV-INNOV-26-POD.pdf",
    }],
);
check("lists second POD companion as unreferenced duplicate",
    dupPods.map((a) => a.filename),
    ["MAV-INNOV-26-POD-copy.pdf"]);
check("second POD companion filename still looks like POD",
    podUtils.looksLikePodCompanionFilename("MAV-INNOV-26-POD-copy.pdf"),
    true);

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
