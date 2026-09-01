/* eslint-disable no-console */
"use strict";

const bundle = require("../statement-invoice-bundle");

let failures = 0;
const check = (name, got, exp) => {
  const pass = got === exp;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) {
    console.log(`  got: ${JSON.stringify(got)}`);
    console.log(`  exp: ${JSON.stringify(exp)}`);
  }
};

const jtsFrom = "JTS Express <invoice@jtsexpress.com>";
const jtsBody = (n) =>
  "Thank you for choosing JTS Express.\n" +
  `Attached is your invoices for statement# ${n}.\n` +
  "Any concerns please email acctg@jtsexpress.com";
const jtsPdf = (n) => [{
  filename: `${n}.pdf`,
  mimeType: "application/pdf",
}];
const jtsPacket = (n) => ({
  subject: `Statement ${n}`,
  from: jtsFrom,
  body: jtsBody(n),
  attachments: [
    ...jtsPdf(n),
    {
      filename: `Statement ${n}.eml`,
      mimeType: "message/rfc822",
    },
  ],
});

const cases = [
  {n: "22568", label: "Aug 20 Statement 22568"},
  {n: "22531", label: "Aug 13 Statement 22531"},
  {n: "22468", label: "Aug 6 5:40 PM Statement 22468"},
  {n: "22432", label: "Aug 6 9:41 PM Statement 22432"},
  {n: "22388", label: "Aug 6 10:01 PM Statement 22388"},
];

for (const c of cases) {
  const p = jtsPacket(c.n);
  check(`${c.label} numbered subject`,
      bundle.looksLikeNumberedStatementSubject(p.subject), true);
  check(`${c.label} packet email`,
      bundle.looksLikeStatementCoverInvoicePacketEmail(
          p.subject, p.from, p.body, p.attachments), true);
  check(`${c.label} looks like carrier invoice email`,
      bundle.looksLikeCarrierInvoiceEmail(p.subject, p.from, p.body),
      true);
  check(`${c.label} do not short-circuit as statement`,
      bundle.shouldShortCircuitAsStatementOnly({
        intent: "statement",
        confidence: "high",
      }, p.subject, p.from, p.body, p.attachments), false);
  const overridden = bundle.overrideStatementClassificationIfInvoicePacket(
      {intent: "statement", confidence: "high", reasoning: "subject"},
      p.subject, p.from, p.body, p.attachments);
  check(`${c.label} override to carrier_invoice`,
      overridden.intent, "carrier_invoice");
  check(`${c.label} STATEMENT cover + pages → INVOICE`,
      bundle.normalizePreCheckDocType("STATEMENT", {
        subject: p.subject,
        from: p.from,
        body: p.body,
        filename: `${c.n}.pdf`,
        pageCount: 12,
      }), "INVOICE");
  check(`${c.label} 1-page STATEMENT still INVOICE (numbered packet)`,
      bundle.normalizePreCheckDocType("STATEMENT", {
        subject: p.subject,
        from: p.from,
        body: p.body,
        filename: `${c.n}.pdf`,
        pageCount: 1,
      }), "INVOICE");
  check(`${c.label} pageCount 0 STATEMENT → INVOICE`,
      bundle.normalizePreCheckDocType("STATEMENT", {
        subject: p.subject,
        from: p.from,
        body: p.body,
        filename: `${c.n}.pdf`,
        pageCount: 0,
      }), "INVOICE");
}

check("FW from Lisa still a packet (accounting resend)",
    bundle.looksLikeStatementCoverInvoicePacketEmail(
        "FW: Statement 22568",
        "Lisa <lisa@innovativecarriers.com>",
        jtsBody("22568"),
        jtsPdf("22568")),
    true);
check("Lisa FW STATEMENT cover → INVOICE",
    bundle.normalizePreCheckDocType("STATEMENT", {
      subject: "FW: Statement 22531",
      from: "lisa@innovativecarriers.com",
      body: jtsBody("22531"),
      filename: "22531.pdf",
      pageCount: 9,
    }), "INVOICE");

check("Fwd: Statement 22531 still numbered",
    bundle.looksLikeNumberedStatementSubject("Fwd: Statement 22531"),
    true);
check("RE: Statement 22432 still numbered",
    bundle.looksLikeNumberedStatementSubject("RE: Statement 22432"),
    true);
check("FW: RE: Statement 22432 still numbered",
    bundle.looksLikeNumberedStatementSubject("FW: RE: Statement 22432"),
    true);

check("aging 'Statement of account' is not numbered packet",
    bundle.looksLikeNumberedStatementSubject(
        "INNOVATIVE CARRIERS INC - Statement of account"),
    false);
check("aging statement of account not a JTS packet",
    bundle.looksLikeStatementCoverInvoicePacketEmail(
        "INNOVATIVE CARRIERS INC - Statement of account",
        "Zheryl Melanie Labasan <zlabasan@shipcsa.com>",
        "Please see attached statement of account",
        [{filename: "aging.pdf", mimeType: "application/pdf"}]),
    false);
check("true statement-only still short-circuits",
    bundle.shouldShortCircuitAsStatementOnly({
      intent: "statement",
      confidence: "high",
    },
    "INNOVATIVE CARRIERS INC - Statement of account",
    "zlabasan@shipcsa.com",
    "Statement of account attached",
    [{filename: "aging.pdf", mimeType: "application/pdf"}]),
    true);
check("aging STATEMENT PDF stays STATEMENT",
    bundle.normalizePreCheckDocType("STATEMENT", {
      subject: "INNOVATIVE CARRIERS INC - Statement of account",
      from: "zlabasan@shipcsa.com",
      filename: "aging.pdf",
      pageCount: 2,
    }), "STATEMENT");

check("Saia Your Invoice From still invoice email",
    bundle.looksLikeCarrierInvoiceEmail(
        "Acct No. 1232387: Your Invoice From Saia Motor Freight Line LLC is Attached",
        "saia@example.com"),
    true);
check("Saia-style STATEMENT cover becomes INVOICE",
    bundle.normalizePreCheckDocType("STATEMENT", {
      subject: "Your Invoice From Saia Motor Freight Line LLC is Attached",
      from: "noreply@saia.com",
      filename: "saia.pdf",
      pageCount: 4,
    }), "INVOICE");

check("no PDF metadata on Statement 22568 is still a packet",
    bundle.looksLikeStatementCoverInvoicePacketEmail(
        "Statement 22568",
        jtsFrom,
        jtsBody("22568"),
        []),
    true);
check("nested eml only metadata is still a numbered packet",
    bundle.looksLikeStatementCoverInvoicePacketEmail(
        "Statement 22568",
        jtsFrom,
        jtsBody("22568"),
        [{
          filename: "Statement 22568.eml",
          mimeType: "message/rfc822",
        }]),
    true);
check("nested eml only is not a processable PDF",
    bundle.hasProcessablePdfAttachment([{
      filename: "Statement 22568.eml",
      mimeType: "message/rfc822",
    }]), false);
check("JTS invoice@ mailbox detected",
    bundle.looksLikeCarrierInvoiceMailbox(jtsFrom), true);
check("POD label unchanged",
    bundle.normalizePreCheckDocType("POD", {
      subject: "Statement 22568",
      pageCount: 8,
    }), "POD");
check("low-confidence statement does not short-circuit",
    bundle.shouldShortCircuitAsStatementOnly({
      intent: "statement",
      confidence: "low",
    }, "Statement of account", "a@b.com", "", null),
    false);
check("carrier_invoice intent does not short-circuit",
    bundle.shouldShortCircuitAsStatementOnly({
      intent: "carrier_invoice",
      confidence: "high",
    }, "Statement 22568", jtsFrom, jtsBody("22568"), jtsPdf("22568")),
    false);

const compassFrom = "notify@mg.compassfs.net <notify@mg.compassfs.net>";
const compassSubject = "Purchase order number; Purchase Order #266265";
const compassPdf = [{
  filename: "Purchase order number; Purchase Order #266265.pdf",
  mimeType: "application/pdf",
}];
check("Compass FS PO subject detected",
    bundle.looksLikeCompassFsPurchaseOrderInvoiceEmail(
        compassSubject, compassFrom), true);
check("Compass FS packet email",
    bundle.looksLikeStatementCoverInvoicePacketEmail(
        compassSubject, compassFrom, "", compassPdf), true);
check("Compass FS 1-page STATEMENT cover → INVOICE",
    bundle.normalizePreCheckDocType("STATEMENT", {
      subject: compassSubject,
      from: compassFrom,
      filename: compassPdf[0].filename,
      pageCount: 1,
    }), "INVOICE");
check("Compass FS unknown classifier overridden",
    bundle.overrideStatementClassificationIfInvoicePacket(
        {intent: "unknown", confidence: "medium",
          reasoning: "lacks clear context"},
        compassSubject, compassFrom, "", compassPdf).intent,
    "carrier_invoice");
check("Compass FS high-confidence statement not short-circuited",
    bundle.shouldShortCircuitAsStatementOnly({
      intent: "statement",
      confidence: "high",
    }, compassSubject, compassFrom, "", compassPdf), false);

const fvFrom = "BP Financing LLC <notification@factorview.com>";
const fvSubject = "Invoice # 981 Your PO # 265543";
const fvPdf = [{
  filename: "Invoice_981.pdf",
  mimeType: "application/pdf",
}];
check("FactorView Invoice# space subject detected",
    bundle.looksLikeFactorViewPurchaseOrderInvoiceEmail(
        fvSubject, fvFrom), true);
check("FactorView looks like carrier invoice email",
    bundle.looksLikeCarrierInvoiceEmail(fvSubject, fvFrom, ""), true);
check("FactorView space-after-# subject alone matches invoice regex",
    bundle.looksLikeCarrierInvoiceEmail(
        fvSubject, "carrier@truckco.com", ""), true);
check("FactorView packet email",
    bundle.looksLikeStatementCoverInvoicePacketEmail(
        fvSubject, fvFrom, "", fvPdf), true);
check("FactorView 1-page OTHER cover → INVOICE",
    bundle.normalizePreCheckDocType("OTHER", {
      subject: fvSubject,
      from: fvFrom,
      filename: fvPdf[0].filename,
      pageCount: 1,
    }), "INVOICE");
check("FactorView unknown classifier overridden",
    bundle.overrideStatementClassificationIfInvoicePacket(
        {intent: "unknown", confidence: "medium",
          reasoning: "factoring notification"},
        fvSubject, fvFrom, "", fvPdf).intent,
    "carrier_invoice");
check("FactorView Remit subject is not PO invoice",
    bundle.looksLikeFactorViewPurchaseOrderInvoiceEmail(
        "Remit for Payment - Toor Transline", fvFrom), false);

const tfSubject =
  "Invoice for processing; Invoice #299 - Purchase Order #266504";
const tfFrom = "Billing@Thunderfunding.com";
const tfPdf = [{filename: "299.pdf", mimeType: "application/pdf"}];
check("Thunder Funding PO invoice subject detected",
    bundle.looksLikeThunderFundingInvoiceEmail(tfSubject, tfFrom), true);
check("Thunder Funding looks like carrier invoice email",
    bundle.looksLikeCarrierInvoiceEmail(tfSubject, tfFrom, ""), true);
check("Thunder Funding factored PO subject (generic)",
    bundle.looksLikeFactoredPurchaseOrderInvoiceEmail(tfSubject), true);
check("Thunder Funding 1-page OTHER cover → INVOICE",
    bundle.normalizePreCheckDocType("OTHER", {
      subject: tfSubject,
      from: tfFrom,
      filename: tfPdf[0].filename,
      pageCount: 1,
    }), "INVOICE");
check("Thunder Funding packet email",
    bundle.looksLikeStatementCoverInvoicePacketEmail(
        tfSubject, tfFrom, "", tfPdf), true);
check("Thunder Funding unknown classification overridden to carrier_invoice",
    bundle.overrideStatementClassificationIfInvoicePacket(
        {intent: "unknown", confidence: "high",
          reasoning: "funding company not a carrier"},
        tfSubject, tfFrom, "", tfPdf).intent, "carrier_invoice");
check("Thunder Funding NOA-cover OTHER + subject filename → INVOICE",
    bundle.normalizePreCheckDocType("OTHER", {
      subject: tfSubject,
      from: tfFrom,
      filename:
        "Invoice for processing; Invoice #7826 - Purchase Order #266943.pdf",
      pageCount: 3,
    }), "INVOICE");
check("Thunder Funding octet-stream PDF still a packet",
    bundle.looksLikeStatementCoverInvoicePacketEmail(
        tfSubject, tfFrom, "", [{
          filename:
            "Invoice for processing; Invoice #7826 - Purchase Order #266943.pdf",
          mimeType: "application/octet-stream",
        }]), true);
check("Invoice for processing subject without factor domain",
    bundle.looksLikeInvoiceForProcessingSubject(
        "Invoice for processing; Invoice #7826 - Purchase Order #266943"),
    true);
check("Purchase Order # (not PO #) matches factored PO subject",
    bundle.looksLikeFactoredPurchaseOrderInvoiceEmail(
        "Invoice #299 - Purchase Order #266504"), true);

const spcSubject = "Single Point Capital; Invoice #265914";
const spcFrom = "reports@singlepointgroup.com";
const spcPdf = [{
  filename: "265914.pdf",
  mimeType: "application/pdf",
}];
check("Single Point Capital subject detected",
    bundle.looksLikeSinglePointCapitalInvoiceEmail(spcSubject, spcFrom), true);
check("Single Point Capital looks like carrier invoice email",
    bundle.looksLikeCarrierInvoiceEmail(spcSubject, spcFrom, ""), true);
check("Single Point Capital semicolon-invoice subject (generic)",
    bundle.looksLikeCarrierInvoiceEmail(
        "Single Point Capital; Invoice #266477",
        "reports@singlepointgroup.com", ""), true);
check("Single Point Capital 1-page OTHER cover → INVOICE",
    bundle.normalizePreCheckDocType("OTHER", {
      subject: spcSubject,
      from: spcFrom,
      filename: spcPdf[0].filename,
      pageCount: 1,
    }), "INVOICE");
check("Single Point Capital packet email",
    bundle.looksLikeStatementCoverInvoicePacketEmail(
        spcSubject, spcFrom, "", spcPdf), true);

const rmSubject = "REF# 266111";
const rmFrom = "invoice@rmcapitalinc.com";
const rmPdf = [{
  filename: "266111.pdf",
  mimeType: "application/pdf",
}];
check("RM Capital REF# subject detected",
    bundle.looksLikeRmCapitalInvoiceEmail(rmSubject, rmFrom), true);
check("RM Capital looks like carrier invoice email",
    bundle.looksLikeCarrierInvoiceEmail(rmSubject, rmFrom, ""), true);
check("RM Capital 1-page OTHER cover → INVOICE",
    bundle.normalizePreCheckDocType("OTHER", {
      subject: rmSubject,
      from: rmFrom,
      filename: rmPdf[0].filename,
      pageCount: 1,
    }), "INVOICE");
check("RM Capital packet email",
    bundle.looksLikeStatementCoverInvoicePacketEmail(
        rmSubject, rmFrom, "", rmPdf), true);
check("RM Capital unknown classification overridden to carrier_invoice",
    bundle.overrideStatementClassificationIfInvoicePacket(
        {intent: "unknown", confidence: "low", reasoning: "unclear"},
        rmSubject, rmFrom, "", rmPdf).intent, "carrier_invoice");

const revSubject =
  "REV CAPITAL/CENTRAL FORCE TRANSPORT INC., Invoice # 6672 Part 1 of 1";
const revFrom = "Billing <invoices@revinc.com>";
const revPdf = [{
  filename: "6672.pdf",
  mimeType: "application/pdf",
}];
check("REV Capital subject detected",
    bundle.looksLikeRevCapitalInvoiceEmail(revSubject, revFrom), true);
check("REV Capital factor-name comma Invoice # subject",
    bundle.looksLikeFactorNameInvoiceSubject(revSubject), true);
check("REV Capital looks like carrier invoice email",
    bundle.looksLikeCarrierInvoiceEmail(revSubject, revFrom, ""), true);
check("REV Capital 1-page OTHER cover → INVOICE",
    bundle.normalizePreCheckDocType("OTHER", {
      subject: revSubject,
      from: revFrom,
      filename: revPdf[0].filename,
      pageCount: 1,
    }), "INVOICE");
check("REV Capital packet email",
    bundle.looksLikeStatementCoverInvoicePacketEmail(
        revSubject, revFrom, "", revPdf), true);
check("REV Capital unknown classification overridden to carrier_invoice",
    bundle.overrideStatementClassificationIfInvoicePacket(
        {intent: "unknown", confidence: "low",
          reasoning: "banking information"},
        revSubject, revFrom, "", revPdf).intent, "carrier_invoice");

check("parseStatementIndexLoadNumbers dedupes and sorts",
    JSON.stringify(bundle.parseStatementIndexLoadNumbers(
        "Load 265379 266088 265379 266219 265630")),
    JSON.stringify(["265379", "265630", "266088", "266219"]));
check("analyzeStatementExtractionGap finds missing loads",
    bundle.analyzeStatementExtractionGap({
      indexLoadNumbers: ["265379", "265630", "266088", "266134", "266219"],
      extractedLoadNumbers: ["266213", "266214"],
      pageCount: 54,
    }).missingLoads.join(","),
    "265379,265630,266088,266134,266219");
check("estimateStatementInvoiceCount prefers index list",
    bundle.estimateStatementInvoiceCount({
      indexLoadNumbers: ["265379", "265630"],
      pageCount: 54,
    }), 2);
check("estimateStatementInvoiceCount uses page heuristic",
    bundle.estimateStatementInvoiceCount({pageCount: 11}), 5);

const jts22568IndexLoads = [
  "265379", "265630", "266088", "266134", "266219",
  "266213", "266214", "265501", "265502", "265503", "265504",
];
const jts22568Extracted = [
  "266213", "266214", "265379", "265630", "266088", "266134",
];
const jts22568Gap = bundle.analyzeStatementExtractionGap({
  indexLoadNumbers: jts22568IndexLoads,
  extractedLoadNumbers: jts22568Extracted,
  pageCount: 54,
});
check("JTS 22568 54-page packet under-extracted",
    jts22568Gap.underExtracted, true);
check("JTS 22568 expects 11 invoices from index",
    jts22568Gap.expectedCount, 11);
check("JTS 22568 extracted only 6",
    jts22568Gap.extractedCount, 6);
check("JTS 22568 missing 5 loads",
    jts22568Gap.missingLoads.join(","),
    "266219,265501,265502,265503,265504");
check("JTS 22568 should alert ops",
    bundle.shouldAlertStatementUnderExtraction(jts22568Gap), true);
check("JTS 22568 alert summary lists missing loads",
    bundle.buildStatementGapSummarySuffix(jts22568Gap),
    "5 load(s) not extracted: 266219, 265501, 265502, 265503, 265504");

const pageOnlyGap = bundle.analyzeStatementExtractionGap({
  indexLoadNumbers: [],
  extractedLoadNumbers: jts22568Extracted,
  pageCount: 54,
});
check("54-page no-index heuristic still under-extracted at 6",
    pageOnlyGap.underExtracted, true);
check("page-only gap should alert",
    bundle.shouldAlertStatementUnderExtraction(pageOnlyGap), true);

check("fully extracted index does not alert",
    bundle.shouldAlertStatementUnderExtraction(
        bundle.analyzeStatementExtractionGap({
          indexLoadNumbers: jts22568IndexLoads,
          extractedLoadNumbers: jts22568IndexLoads,
          pageCount: 54,
        })), false);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll checks passed");
