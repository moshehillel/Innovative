/* eslint-disable no-console */
"use strict";

const adm = require("../administrative-email-intake");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const emodalBody =
  "Today's eModal Broadcasts\nPier E: LBCT Terminal Rules\nautomated email";
check("eModal broadcast",
    adm.isEmodalBroadcast("Today's eModal Broadcasts", "emodal@x.com", emodalBody));

check("Hafstaff domain sender",
    adm.isHafstaffSender("Billing <ap@hafstaff.com>"));
check("Hafstaff display name",
    adm.isHafstaffSender("Hafstaff Logistics <ops@othercarrier.net>"));
check("Halfstaff spelling variant",
    adm.isHafstaffSender("Half Staff <billing@halfstaff.com>"));
check("non-Hafstaff sender not matched",
    !adm.isHafstaffSender("ArcBest <brooklyncustomerservice@abf.com>"));
check("empty from not Hafstaff",
    !adm.isHafstaffSender(""));

const rtsSubject = "RTS Financial NOA: JAYKHUN CARGO LLC MC# 1357866";
const rtsBody = "Notice of Assignment\nREMIT TO ADDRESS\nRTS Financial";
check("RTS NOA email",
    adm.isRtsNoaEmail(rtsSubject, "NOA@rtsinc.com", rtsBody));
check("RTS NOA attachments NOA only",
    adm.rtsNoaAttachmentsLookNoaOnly([
      {filename: "NOA-Jaykhun.pdf", mimeType: "application/pdf"},
      {filename: "Notice_of_Assignment.pdf", mimeType: "application/pdf"},
    ]));
check("RTS with invoice filename not ignored",
    !adm.rtsNoaAttachmentsLookNoaOnly([
      {filename: "carrier_invoice_123.pdf", mimeType: "application/pdf"},
      {filename: "NOA.pdf", mimeType: "application/pdf"},
    ]));
check("evaluate eModal",
    adm.evaluateAdministrativeIgnore("", "emodal@x.com", emodalBody, []).ignore);
check("evaluate RTS NOA with NOA filename",
    adm.evaluateAdministrativeIgnore(
        rtsSubject, "NOA@rtsinc.com", rtsBody,
        [{filename: "NOA.pdf", mimeType: "application/pdf"}]).status ===
    "noa_ignored");

const cardknoxSubject = "Innovative Carriers Batch 52094836";
const cardknoxFrom = "Cardknox <noreply@cardknox.com>";
check("Cardknox batch report detected",
    adm.isCardknoxBatchReport(cardknoxSubject, cardknoxFrom));
check("Cardknox batch report evaluate quiet-ignore",
    adm.evaluateAdministrativeIgnore(
        cardknoxSubject, cardknoxFrom, "", []).status ===
    "cardknox_batch_report_ignored");
check("Cardknox non-batch subject not ignored",
    !adm.isCardknoxBatchReport(
        "Cardknox payment receipt", cardknoxFrom));
check("non-Cardknox Batch subject not ignored",
    !adm.isCardknoxBatchReport(
        "Innovative Carriers Batch 52094836",
        "alerts@otherprocessor.com"));

const amexSurveySubject =
  "INNOVATIVE CARRIERS, We want to hear from you on September 9";
const amexSurveyFrom =
  "American Express Merchant Services " +
  "<AmericanExpress@email.americanexpress.com>";
const amexSurveyBody =
  "We value your feedback. Please take a moment to share your experience.";
check("AmEx merchant satisfaction survey detected",
    adm.isAmexMerchantSurveyEmail(
        amexSurveySubject, amexSurveyFrom, amexSurveyBody));
check("AmEx merchant survey evaluate quiet-ignore",
    adm.evaluateAdministrativeIgnore(
        amexSurveySubject, amexSurveyFrom, amexSurveyBody, []).status ===
    "amex_merchant_survey_ignored");
check("AmEx chargeback not ignored as survey",
    !adm.isAmexMerchantSurveyEmail(
        "Chargeback notice — case #12345",
        amexSurveyFrom,
        "A chargeback has been filed against your merchant account."));
check("non-AmEx we want to hear from you not ignored",
    !adm.isAmexMerchantSurveyEmail(
        "We want to hear from you about your shipment",
        "support@othercarrier.com",
        "Please reply with feedback on our freight service."));

const cofaceBriefsSubject =
  "Coface Briefs: The Latest News from around the World";
const cofaceBriefsFrom =
  "Coface North America <northamerica.communications@coface.com>";
check("Coface Briefs newsletter detected",
    adm.isCofaceEmail(cofaceBriefsFrom, cofaceBriefsSubject, ""));
check("Coface Briefs evaluate ignored",
    adm.evaluateAdministrativeIgnore(
        cofaceBriefsSubject, cofaceBriefsFrom, "", []).status ===
    "coface_ignored");
check("Coface subdomain sender detected",
    adm.isCofaceEmail(
        "Coface US <alerts@us.coface.com>",
        "Trade credit update", ""));
check("non-Coface sender not matched",
    !adm.isCofaceEmail(
        "Coface lookalike <news@notcoface.com>",
        "Coface Briefs", ""));

const dnbPromoSubject =
  "No Hidden Fees. No Overdrafts. Smarter Business Banking Starts Here";
const dnbPromoFrom = "Dun & Bradstreet <e.email@dnb.com>";
const dnbPromoBody =
  "Discover Lili business banking with no hidden fees and smarter tools.";
check("D&B Lili banking promo detected",
    adm.isDnbPromotionalEmail(
        dnbPromoSubject, dnbPromoFrom, dnbPromoBody));
check("D&B promo via shared promotional helper",
    adm.isPromotionalMarketingEmail(
        dnbPromoSubject, dnbPromoFrom, dnbPromoBody));
check("D&B promo evaluate ignored",
    adm.evaluateAdministrativeIgnore(
        dnbPromoSubject, dnbPromoFrom, dnbPromoBody, []).status ===
    "dnb_promotional_ignored");
check("D&B credit alert not treated as promo",
    !adm.isDnbPromotionalEmail(
        "Business credit alert for Innovative Carriers",
        "alerts@dnb.com",
        "Your business credit score changed. View your credit report."));
check("D&B trade credit alert not treated as promo",
    !adm.isPromotionalMarketingEmail(
        "Trade credit monitoring update",
        "Dun & Bradstreet <notifications@dnb.com>",
        "A trade credit inquiry was reported on your DUNS number."));
check("non-D&B banking promo not ignored",
    !adm.isDnbPromotionalEmail(
        "Smarter Business Banking Starts Here",
        "marketing@chase.com",
        "Open a business checking account today."));

const ithriveSubject =
  "iThrive Funding - Notice of Assignment for First Family Trucking LLC " +
  "(MC 1115353) - Please Confirm Receipt";
const genericNoaPdf = [{filename: "1115.pdf", mimeType: "application/pdf"}];
check("FactorView iThrive NOA content detected",
    adm.isNoticeOfAssignmentEmail(
        ithriveSubject,
        "iThrive Funding <notification@factorview.com>",
        "Please confirm receipt of Notice of Assignment"));
check("generic PDF + NOA not ignored before classification",
    !adm.evaluateAdministrativeIgnore(
        ithriveSubject,
        "notification@factorview.com",
        "Notice of Assignment",
        genericNoaPdf).ignore);
check("generic PDF + NOA ignored after scan finds no invoice",
    adm.shouldIgnoreNoaOnlyPackage(
        ithriveSubject,
        "Notice of Assignment",
        genericNoaPdf,
        0));
check("FactorView invoice from same sender is NOT NOA",
    !adm.isNoticeOfAssignmentEmail(
        "Invoice 23493 - Load 265708",
        "notification@factorview.com",
        "Please see attached invoice"));
check("FactorView invoice evaluate not ignored",
    !adm.evaluateAdministrativeIgnore(
        "Invoice 23494 - Load 265798",
        "Chugh Capital, LLC <notification@factorview.com>",
        "Invoice attached",
        [{filename: "1116.pdf", mimeType: "application/pdf"}]).ignore);
check("invoice PDF count blocks NOA ignore even with NOA subject",
    !adm.shouldIgnoreNoaOnlyPackage(
        ithriveSubject,
        "Notice of Assignment",
        genericNoaPdf,
        1));
check("invoice filename blocks NOA ignore",
    !adm.shouldIgnoreNoaOnlyPackage(
        ithriveSubject,
        "Notice of Assignment",
        [{filename: "carrier_invoice.pdf", mimeType: "application/pdf"}],
        0));

const quickPaySubject =
  "Re: Quick Pay Invoice - Load #: 265620 - QUALITY & INTEGRITY TRANSPORT LLC";
const quickPayBody =
  "Please confirm that all required documents have been received and " +
  "process at the 3% same-day rate.";
check("Quick Pay follow-up detected",
    adm.isPaymentInquiryEmail(quickPaySubject, "steve@x.com", quickPayBody));
check("Quick Pay handler when no invoice PDF",
    adm.shouldHandlePaymentInquiry(
        quickPaySubject, "steve@x.com", quickPayBody, 0));
check("Quick Pay skipped when invoice PDF present",
    !adm.shouldHandlePaymentInquiry(
        quickPaySubject, "steve@x.com", quickPayBody, 1));
check("Zelle alert is not payment inquiry",
    !adm.isPaymentInquiryEmail(
        "Zelle payment received",
        "alerts@chase.com",
        "You received a Zelle payment of $500"));
check("payment inquiry subject",
    adm.isPaymentInquiryEmail(
        "Payment inquiry - load 265620", "", "When will we be paid?"));

const logisticoreSubject = "Pending Payment for Load # 265721";
const logisticoreFrom = "Paul Rogers <dispatch@logisticore.co>";
const logisticoreBody =
  "I am following up on unpaid payment for load #265721. " +
  "The trailer was picked up. Please provide payment details or an update. " +
  "I have sent several prior emails with no response.";
const logisticoreAtt = [
  {filename: "265721_BOL.pdf", mimeType: "application/pdf"},
  {filename: "265721_POD.pdf", mimeType: "application/pdf"},
];
check("LogistiCore pending payment subject only (no body)",
    adm.isPaymentInquiryEmail(logisticoreSubject, logisticoreFrom, ""));
check("LogistiCore pending payment with body",
    adm.isPaymentInquiryEmail(
        logisticoreSubject, logisticoreFrom, logisticoreBody));
check("LogistiCore pending payment handled when no invoice PDF",
    adm.shouldHandlePaymentInquiry(
        logisticoreSubject, logisticoreFrom, logisticoreBody, 0));
check("LogistiCore pending payment not vetoed by supporting docs",
    !adm.hasInvoiceVeto({
      subject: logisticoreSubject,
      body: logisticoreBody,
      from: logisticoreFrom,
      attachments: logisticoreAtt,
      invoicePdfCount: 0,
    }));
check("Invoice for Load subject is not payment inquiry",
    !adm.isPaymentInquiryEmail(
        "Invoice for Load # 265721",
        "Carrier <billing@carrier.com>",
        "Please see attached invoice for load #265721"));

check("FW invoice BOL subject recognized",
    adm.looksLikeInvoiceEmailContent(
        "FW: Invoice #28415 for BOL #264557", ""));
check("QuickBooks invoice subject recognized",
    adm.looksLikeInvoiceEmailContent(
        "Invoice 66670 from FAST AND SECURE TRANSPORT INC.", ""));
check("Zelle in forwarded body does not ignore invoice email",
    !adm.shouldIgnoreAsPaymentNotification(
        "FW: Invoice #28415 for BOL #264557",
        "malverio@gmasongroup.com",
        "Please pay via Zelle for other loads",
        [{filename: "invoice_28415.pdf", mimeType: "application/pdf"}]));
check("plain Zelle alert still ignored",
    adm.shouldIgnoreAsPaymentNotification(
        "Zelle payment received",
        "alerts@chase.com",
        "You received a Zelle payment of $500",
        []));

check("FW invoice + Zelle body + PDF triggers veto",
    adm.hasInvoiceVeto({
      subject: "FW: Invoice #28415 for BOL #264557",
      body: "Please pay via Zelle for other loads",
      attachments: [{filename: "invoice_28415.pdf"}],
    }));
check("real Zelle from chase has no veto",
    !adm.hasInvoiceVeto({
      subject: "Zelle payment received",
      body: "You received a Zelle payment of $500",
      attachments: [],
      from: "alerts@chase.com",
    }));
check("carrier_invoice intent triggers veto",
    adm.hasInvoiceVeto({
      subject: "Documents attached",
      body: "See attached",
      attachments: [{filename: "scan.pdf"}],
      emailClassification: {intent: "carrier_invoice"},
    }));

const suretyRemitSubject =
  "Remit for Payment; ADF Transport Inc. Load #266277";
const suretyRemitFrom =
  "Surety Financial LLC <notification@factorview.com>";
const suretyRemitBody =
  "Please remit payment for this load and all future ADF Transport " +
  "invoices to Surety Financial.";
const suretyRemitAtt = [
  {filename: "266277.pdf", mimeType: "application/pdf"},
];
check("Surety Remit for Payment detected as NOA/factoring",
    adm.looksLikeNoaEmailContent(
        suretyRemitSubject, suretyRemitBody, suretyRemitFrom));
check("Surety Remit ignored as NOA-only (no invoice PDF)",
    adm.shouldIgnoreNoaOnlyPackage(
        suretyRemitSubject, suretyRemitBody, suretyRemitAtt, 0,
        suretyRemitFrom));
check("Surety Remit misclassified carrier_invoice does not veto",
    !adm.hasInvoiceVeto({
      subject: suretyRemitSubject,
      body: suretyRemitBody,
      from: suretyRemitFrom,
      attachments: suretyRemitAtt,
      emailClassification: {intent: "carrier_invoice"},
      invoicePdfCount: 0,
    }));
check("FactorView real invoice still vetoes",
    adm.hasInvoiceVeto({
      subject: "Invoice 23493 - Load 265708",
      body: "Please see attached invoice",
      from: suretyRemitFrom,
      attachments: [{filename: "1116.pdf"}],
      emailClassification: {intent: "carrier_invoice"},
      invoicePdfCount: 1,
    }));

const phoenixReleaseSubject =
  "Letter of Release for Mamba Mentality Truckin";
const phoenixReleaseFrom =
  "Jeff Foil <JeffFoil@phoenixcapitalgroup.com>";
const phoenixReleaseBody = "";
const phoenixReleaseAtt = [
  {filename: "Letter_of_Release.pdf", mimeType: "application/pdf"},
];
const phoenixGenericAtt = [
  {filename: "document.pdf", mimeType: "application/pdf"},
];
check("Phoenix Capital Letter of Release detected as NOA",
    adm.looksLikeNoaEmailContent(
        phoenixReleaseSubject, phoenixReleaseBody, phoenixReleaseFrom));
check("Phoenix Letter of Release filename looks like NOA",
    adm.attachmentFilenameLooksLikeNoa("Letter_of_Release.pdf"));
check("Phoenix Letter of Release ignored with generic PDF (no invoice)",
    adm.shouldIgnoreNoaOnlyPackage(
        phoenixReleaseSubject, phoenixReleaseBody, phoenixGenericAtt, 0,
        phoenixReleaseFrom));
check("Phoenix Letter of Release evaluate ignored early with NOA filename",
    adm.evaluateAdministrativeIgnore(
        phoenixReleaseSubject, phoenixReleaseFrom, phoenixReleaseBody,
        phoenixReleaseAtt).status === "noa_ignored");
check("cargo release subject not treated as NOA",
    !adm.looksLikeNoaEmailContent(
        "Container release status for PRO 12345",
        "Your container has been released at terminal.",
        "terminal@emodal.com"));

const arcBestSubject =
  "ArcBest eInvoice(s) - 760981 INNOVATIVE CARRIERS - 8/11/2026";
const arcBestBody =
  "Attached are the invoice(s) for the following pronumber(s):\n" +
  "151579720\n218932484\n\n" +
  "Please note that we offer the ability to utilize ACH payments. " +
  "ACH payments are a secure and efficient way to handle transactions.";
const arcBestAttachments = [
  {filename: "151579720.pdf", mimeType: "application/octet-stream"},
  {filename: "218932484.pdf", mimeType: "application/octet-stream"},
];
check("ArcBest eInvoice subject recognized",
    adm.looksLikeInvoiceEmailContent(arcBestSubject, arcBestBody));
check("ArcBest ACH remittance boilerplate is not a payment alert",
    !adm.isPaymentNotificationEmail(
        arcBestSubject, "brooklyncustomerservice@abf.com", arcBestBody));
check("ArcBest eInvoice not ignored as payment notification",
    !adm.shouldIgnoreAsPaymentNotification(
        arcBestSubject,
        "brooklyncustomerservice@abf.com",
        arcBestBody,
        arcBestAttachments));
check("ArcBest eInvoice has invoice veto",
    adm.hasInvoiceVeto({
      subject: arcBestSubject,
      body: arcBestBody,
      attachments: arcBestAttachments,
    }));
check("real ACH deposit alert still ignored",
    adm.shouldIgnoreAsPaymentNotification(
        "ACH payment received",
        "alerts@chase.com",
        "An ACH payment was received for $1,200.00",
        []));

const amfastSubject =
  "New payment request from Amfast Freight, Inc. - invoice 173867";
const amfastFrom =
  "Amfast Freight, Inc. <quickbooks@notification.intuit.com>";
const amfastBody =
  "Your invoice is ready! BALANCE DUE $472.50 View and pay " +
  "Your invoice is attached, along with any associated PODs. " +
  "We appreciate your prompt payment. For Zelle or Chase Quickpay " +
  "send to: ar@amfastlogistics.com";
check("Amfast QB payment-request subject recognized as invoice",
    adm.looksLikeInvoiceEmailContent(amfastSubject, amfastBody));
check("Amfast QB Zelle remittance tip is not a bank payment alert ignore",
    !adm.shouldIgnoreAsPaymentNotification(
        amfastSubject, amfastFrom, amfastBody, []));
check("Amfast QB payment-request has invoice veto",
    adm.hasInvoiceVeto({
      subject: amfastSubject,
      body: amfastBody,
      attachments: [],
    }));
check("Amfast QB payment-request is not payment inquiry when invoice# present",
    !adm.isPaymentInquiryEmail(amfastSubject, amfastFrom, amfastBody));
check("second Amfast invoice subject also recognized",
    adm.looksLikeInvoiceEmailContent(
        "New payment request from Amfast Freight, Inc. - invoice 173861",
        amfastBody));
check("plain Zelle alert still ignored after Amfast fix",
    adm.shouldIgnoreAsPaymentNotification(
        "Zelle payment received",
        "alerts@chase.com",
        "You received a Zelle payment of $500",
        []));

const compassSubject = "Purchase order number; Purchase Order #266265";
const compassFrom = "notify@mg.compassfs.net <notify@mg.compassfs.net>";
const compassPdf = [{
  filename: "Purchase order number; Purchase Order #266265.pdf",
  mimeType: "application/pdf",
}];
check("Compass FS PO subject recognized as invoice content",
    adm.looksLikeInvoiceEmailContent(compassSubject, ""));
check("Compass FS PO filename looks like invoice",
    adm.attachmentFilenameLooksLikeInvoice(compassPdf[0].filename));
check("Compass FS PO email has invoice veto",
    adm.hasInvoiceVeto({
      subject: compassSubject,
      from: compassFrom,
      attachments: compassPdf,
    }));

const fvSubject = "Invoice # 981 Your PO # 265543";
const fvFrom = "BP Financing LLC <notification@factorview.com>";
const fvPdf = [{filename: "Invoice_981.pdf", mimeType: "application/pdf"}];
check("FactorView Invoice# space subject recognized as invoice content",
    adm.looksLikeInvoiceEmailContent(fvSubject, ""));
check("FactorView Invoice# space is NOT NOA",
    !adm.isNoticeOfAssignmentEmail(
        fvSubject, fvFrom,
        "BP Financing LLC is forwarding an attached invoice (#981) " +
        "for Toor Transline Inc., associated with PO #265543"));
check("FactorView Invoice# space evaluate not ignored",
    !adm.evaluateAdministrativeIgnore(
        fvSubject, fvFrom,
        "Please see attached invoice for PO 265543",
        fvPdf).ignore);
check("FactorView Invoice# space has invoice veto",
    adm.hasInvoiceVeto({
      subject: fvSubject,
      from: fvFrom,
      body: "Attached invoice for Toor Transline",
      attachments: fvPdf,
    }));

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nAll administrative email tests passed");
