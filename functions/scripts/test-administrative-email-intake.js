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

const oooSubject = "Out of Office";
const oooFrom = "Jane Smith <jane.smith@carrier.com>";
const oooBody =
  "Thank you for your email. I am currently out of the office with " +
  "limited access to email. I will returning on September 5, 2026.";
check("OOO subject detected",
    adm.isOutOfOfficeAutoReply(oooSubject, oooFrom, oooBody));
check("Automatic reply subject detected",
    adm.isOutOfOfficeAutoReply(
        "Automatic reply: Re: Payment question",
        oooFrom,
        "I am currently out of the office until Monday."));
check("OOO body vacation message detected",
    adm.isOutOfOfficeAutoReply(
        "Re: Load status",
        oooFrom,
        "I am on vacation and will respond when I return."));
check("OOO evaluate ignored",
    adm.evaluateAdministrativeIgnore(
        oooSubject, oooFrom, oooBody, []).status ===
    "out_of_office_ignored");
check("third-party out of office mention not ignored",
    !adm.isOutOfOfficeAutoReply(
        "Invoice follow-up",
        "ops@carrier.com",
        "John is out of the office until Monday. Please contact Jane."));
check("invoice email with OOO mention not ignored",
    !adm.isOutOfOfficeAutoReply(
        "Invoice # 28415 for BOL #264557",
        oooFrom,
        "I am out of the office next week but your invoice is attached."));

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
check("D&B Credit Insights inquiry alert ignored",
    adm.isDnbPromotionalEmail(
        "ALERT: New Inquiry Reported in D&B Credit Insights",
        "Dun & Bradstreet <e.email@dnb.com>",
        "A new inquiry was reported in Credit Insights."));
check("D&B Credit Insights evaluate ignored",
    adm.evaluateAdministrativeIgnore(
        "ALERT: New Inquiry Reported in D&B Credit Insights",
        "Dun & Bradstreet <e.email@dnb.com>",
        "View the inquiry in Credit Insights.",
        []).status === "dnb_promotional_ignored");
// Exact Lisa 2026-09-03 forward case (no-attachment path).
check("Lisa D&B New Inquiry alert (exact subject) ignored",
    adm.evaluateAdministrativeIgnore(
        "ALERT: New Inquiry Reported in D&B Credit Insights",
        "Dun & Bradstreet <e.email@dnb.com>",
        "",
        []).status === "dnb_promotional_ignored");
check("D&B Credit Insights ignored with empty From",
    adm.evaluateAdministrativeIgnore(
        "ALERT: New Inquiry Reported in D&B Credit Insights",
        "",
        "A new inquiry was reported.",
        []).status === "dnb_promotional_ignored");
check("D&B Credit Insights not blocked by invoice veto",
    !adm.hasInvoiceVeto({
      subject: "ALERT: New Inquiry Reported in D&B Credit Insights",
      from: "Dun & Bradstreet <e.email@dnb.com>",
      body: "View the inquiry in Credit Insights.",
      attachments: [],
      emailClassification: {intent: "carrier_invoice", confidence: "high"},
    }));
check("D&B marketing ESP ignored even without banking subject",
    adm.isDnbPromotionalEmail(
        "Your weekly D&B update",
        "Dun & Bradstreet <e.email@dnb.com>",
        "See what's new this week."));
check("D&B email.dnb.com ESP ignored",
    adm.isDnbPromotionalEmail(
        "Your D&B account update",
        "Dun & Bradstreet <noreply@email.dnb.com>",
        "See what's new this week."));
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

const fleetexSubject = "Outstanding Payment Reminder";
const fleetexFrom =
  "Fleetex Transport Accounts <accounts@fleetextransport.com>";
const fleetexBody =
  "I am following up on nine outstanding invoices totaling $6,550. " +
  "Please provide an expected payment date at your earliest convenience.";
check("Fleetex outstanding payment reminder subject only (no body)",
    adm.isPaymentInquiryEmail(fleetexSubject, fleetexFrom, ""));
check("Fleetex outstanding payment reminder with body",
    adm.isPaymentInquiryEmail(fleetexSubject, fleetexFrom, fleetexBody));
check("Fleetex outstanding payment reminder handled when no invoice PDF",
    adm.shouldHandlePaymentInquiry(
        fleetexSubject, fleetexFrom, fleetexBody, 0));
check("Fleetex outstanding payment reminder skipped when invoice PDF present",
    !adm.shouldHandlePaymentInquiry(
        fleetexSubject, fleetexFrom, fleetexBody, 1));
check("Fleetex body-only outstanding invoices + expected payment date",
    adm.isPaymentInquiryEmail(
        "Re: Accounts receivable follow-up",
        fleetexFrom,
        fleetexBody));

const fleetexReSubject = "RE: Outstanding Payment Reminder";
const fleetexLisaBody =
  "following up on outstanding invoices totaling $7,225, " +
  "requesting scheduled payment date";
check("Fleetex RE: outstanding payment reminder subject only (no body)",
    adm.isPaymentInquiryEmail(fleetexReSubject, fleetexFrom, ""));
check("Fleetex RE: outstanding payment reminder with Lisa body",
    adm.isPaymentInquiryEmail(fleetexReSubject, fleetexFrom, fleetexLisaBody));
check("Fleetex RE: outstanding payment reminder handled when no invoice PDF",
    adm.shouldHandlePaymentInquiry(
        fleetexReSubject, fleetexFrom, fleetexLisaBody, 0));
check("Fleetex RE: body-only scheduled payment date with generic subject",
    adm.isPaymentInquiryEmail(
        "RE: Accounts receivable follow-up",
        fleetexFrom,
        fleetexLisaBody));

const eastonSubject = "Re: 264617";
const eastonFrom =
  "Easton Star Trucking LLC <eastonstartruckingllc@gmail.com>";
const eastonBody =
  "Good day,\n\nPayment has not been received for load numbers " +
  "264617, 264618, and 264732. Please provide an update on payment " +
  "status at your earliest convenience.\n\nThank you.";
check("Easton Star load-number subject with unpaid loads body",
    adm.isPaymentInquiryEmail(eastonSubject, eastonFrom, eastonBody));
check("Easton Star payment inquiry handled when no invoice PDF",
    adm.shouldHandlePaymentInquiry(
        eastonSubject, eastonFrom, eastonBody, 0));
check("Easton Star bare load subject alone is not payment inquiry",
    !adm.isPaymentInquiryEmail(eastonSubject, eastonFrom, ""));
check("Re load# delivery thread is not payment inquiry",
    !adm.isPaymentInquiryEmail(
        "Re: 264617",
        "dispatch@carrier.com",
        "Can you confirm the delivery appointment for load 264617?"));
check("Easton Star payment not received shorthand",
    adm.isPaymentInquiryEmail(
        "Re: 264732",
        eastonFrom,
        "Payment not received for load numbers 264732 and 264617. " +
        "Please send a payment status update."));
check("Easton Star multi-load follow-up body pattern",
    adm.isPaymentInquiryEmail(
        "264618",
        eastonFrom,
        "Following up on unpaid load numbers 264617, 264618, 264732. " +
        "When will payment be sent?"));

const cjSubject = "Payment Update Load 263966";
const cjSubjectHash = "Payment Update Load #263966";
const cjFrom = "Katelyn Wright <kwright@cjfinancing.com>";
const cjBody =
  "CJ Financing requesting payment status update for load 263966, " +
  "carrier KCN Logistics";
check("CJ Financing payment update load subject",
    adm.isPaymentInquiryEmail(cjSubject, cjFrom, ""));
check("CJ Financing payment update load # subject",
    adm.isPaymentInquiryEmail(cjSubjectHash, cjFrom, ""));
check("CJ Financing payment status update body",
    adm.isPaymentInquiryEmail(cjSubject, cjFrom, cjBody));
check("CJ Financing should handle when no invoice PDF",
    adm.shouldHandlePaymentInquiry(cjSubject, cjFrom, cjBody, 0));
check("CJ Financing factor domain recognized",
    adm.isCarrierOrFactorSender(cjFrom));
check("CJ Financing misclassified carrier_invoice does not veto",
    !adm.hasInvoiceVeto({
      subject: cjSubject,
      body: cjBody,
      from: cjFrom,
      attachments: [],
      emailClassification: {intent: "carrier_invoice"},
      invoicePdfCount: 0,
    }));
check("CJ Financing full path would handle with carrier_invoice class",
    adm.shouldHandlePaymentInquiry(cjSubject, cjFrom, cjBody, 0) &&
    !adm.hasInvoiceVeto({
      subject: cjSubject,
      body: cjBody,
      from: cjFrom,
      attachments: [],
      emailClassification: {intent: "carrier_invoice"},
      invoicePdfCount: 0,
    }));

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
        "Goldengate Logistics Llc sent you $36.00",
        "Bank of America <customerservice@ealerts.bankofamerica.com>",
        "You received a Zelle payment of $500",
        []));
check("Chase Zelle alert ignored (known bank-alert sender)",
    adm.shouldIgnoreAsPaymentNotification(
        "Zelle payment received",
        "alerts@chase.com",
        "You received a Zelle payment of $500",
        []));
check("Chase marketing sender is not a bank-alert ignore",
    !adm.shouldIgnoreAsPaymentNotification(
        "Zelle tips from Chase",
        "marketing@chase.com",
        "Learn about Zelle payment features",
        []));

check("FW invoice + Zelle body + PDF triggers veto",
    adm.hasInvoiceVeto({
      subject: "FW: Invoice #28415 for BOL #264557",
      body: "Please pay via Zelle for other loads",
      attachments: [{filename: "invoice_28415.pdf"}],
    }));
check("real Zelle from chase has no invoice veto",
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

const sliverShadowSubject = "MC#856665";
const sliverShadowFrom =
  "SLIVER SHADOW TRANSPORTATION INC <business@vtflog.com>";
const sliverShadowBody = "";
const sliverShadowAtt = [
  {filename: "856665.pdf", mimeType: "application/pdf"},
];
check("MC#856665 bare subject detected as NOA",
    adm.subjectLooksLikeMcNumberNoa(sliverShadowSubject));
check("MC #856665 subject variant detected as NOA",
    adm.subjectLooksLikeMcNumberNoa("MC #856665"));
check("Re: MC#856665 subject variant detected as NOA",
    adm.subjectLooksLikeMcNumberNoa("Re: MC#856665"));
check("SLIVER SHADOW vtflog.com is factor sender",
    adm.isCarrierOrFactorSender(sliverShadowFrom));
check("SLIVER SHADOW MC# content detected as NOA",
    adm.looksLikeNoaEmailContent(
        sliverShadowSubject, sliverShadowBody, sliverShadowFrom));
check("SLIVER SHADOW generic PDF ignored after scan (no invoice)",
    adm.shouldIgnoreNoaOnlyPackage(
        sliverShadowSubject, sliverShadowBody, sliverShadowAtt, 0,
        sliverShadowFrom));
check("SLIVER SHADOW misclassified carrier_invoice does not veto",
    !adm.hasInvoiceVeto({
      subject: sliverShadowSubject,
      body: sliverShadowBody,
      from: sliverShadowFrom,
      attachments: sliverShadowAtt,
      emailClassification: {intent: "carrier_invoice"},
      invoicePdfCount: 0,
    }));
check("SLIVER SHADOW invoice filename blocks NOA ignore",
    !adm.shouldIgnoreNoaOnlyPackage(
        sliverShadowSubject, sliverShadowBody,
        [{filename: "carrier_invoice_856665.pdf", mimeType: "application/pdf"}],
        0, sliverShadowFrom));
check("load number subject alone is not MC# NOA",
    !adm.subjectLooksLikeMcNumberNoa("264617"));

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
        "Bank of America <customerservice@ealerts.bankofamerica.com>",
        "An ACH payment was received for $1,200.00",
        []));
check("Chase ACH deposit alert ignored (known bank-alert sender)",
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
        "Goldengate Logistics Llc sent you $36.00",
        "Bank of America <customerservice@ealerts.bankofamerica.com>",
        "You received a Zelle payment of $500",
        []));

const amfastReceiptSubject =
  "Payment Receipt from Amfast Freight, Inc.";
const amfastReceiptFrom =
  "Amfast Freight, Inc. <quickbooks@notification.intuit.com>";
const amfastReceiptBody =
  "Thank you for your payment.\nInvoice Amount $305.55\n" +
  "This email confirms your payment was received.";
check("Amfast QB payment receipt detected",
    adm.isPaymentReceiptEmail(
        amfastReceiptSubject, amfastReceiptFrom, amfastReceiptBody));
check("Amfast QB payment receipt evaluate ignored",
    adm.evaluateAdministrativeIgnore(
        amfastReceiptSubject, amfastReceiptFrom, amfastReceiptBody,
        []).status === "payment_receipt_ignored");
check("Amfast QB payment receipt shouldIgnore",
    adm.shouldIgnoreAsPaymentReceipt(
        amfastReceiptSubject, amfastReceiptFrom, amfastReceiptBody, []));
check("Amfast QB payment receipt not blocked by carrier_invoice veto",
    !adm.hasInvoiceVeto({
      subject: amfastReceiptSubject,
      body: amfastReceiptBody,
      from: amfastReceiptFrom,
      attachments: [],
      emailClassification: {intent: "carrier_invoice"},
      invoicePdfCount: 0,
    }));
check("QuickBooks invoice subject is NOT payment receipt",
    !adm.isPaymentReceiptEmail(
        "Invoice 66670 from FAST AND SECURE TRANSPORT INC.",
        "FAST AND SECURE <quickbooks@notification.intuit.com>",
        "Your invoice is ready! Balance due $500."));
check("Amfast QB payment-request is NOT payment receipt",
    !adm.isPaymentReceiptEmail(amfastSubject, amfastFrom, amfastBody));
check("payment receipt with invoice filename not ignored",
    !adm.shouldIgnoreAsPaymentReceipt(
        amfastReceiptSubject, amfastReceiptFrom, amfastReceiptBody,
        [{filename: "carrier_invoice_123.pdf", mimeType: "application/pdf"}]));

const heypharmaSubject = "Re: Invoice for BOL#265028";
const heypharmaFrom = "Moshe Myski <mmyski@heypharma.com>";
const heypharmaBody =
  "Please see attached invoice.\n\n" +
  "On Tue, Aug 26, 2026 Abe <abe@innovativecarriers.com> wrote:\n" +
  "PLEASE NOTE OUR NEW BANKING INFORMATION\n" +
  "Quickpay/Zelle\naccounting@innovativecarriers.com\n";
check("Re: Invoice for BOL subject recognized as invoice content",
    adm.looksLikeInvoiceEmailContent(heypharmaSubject, heypharmaBody));
check("Heypharma invoice reply with Zelle in quoted body not ignored",
    !adm.shouldIgnoreAsPaymentNotification(
        heypharmaSubject, heypharmaFrom, heypharmaBody, []));
check("Heypharma invoice reply has invoice veto",
    adm.hasInvoiceVeto({
      subject: heypharmaSubject,
      body: heypharmaBody,
      from: heypharmaFrom,
      attachments: [],
    }));
check("BoA sender detected",
    adm.isBankOfAmericaSender(
        "Bank of America <customerservice@ealerts.bankofamerica.com>"));
check("non-BoA sender not detected",
    !adm.isBankOfAmericaSender("Moshe Myski <mmyski@heypharma.com>"));

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

const tfSubject =
  "Invoice for processing; Invoice #299 - Purchase Order #266504";
const tfFrom = "Billing@Thunderfunding.com";
const tfBody =
  "Thunder Funding submitted invoice #299 associated with PO #266504. " +
  "Please confirm receipt. Updated payment/banking info attached.";
const tfPdf = [{filename: "299.pdf", mimeType: "application/pdf"}];
check("Thunder Funding Invoice for processing subject recognized",
    adm.looksLikeInvoiceEmailContent(tfSubject, tfBody));
check("Thunder Funding Purchase Order # (not PO #) recognized",
    adm.looksLikeInvoiceEmailContent(
        "Invoice #299 - Purchase Order #266504", ""));
check("Thunder Funding factor domain recognized",
    adm.isCarrierOrFactorSender(tfFrom));
check("Thunder Funding not NOA",
    !adm.isNoticeOfAssignmentEmail(tfSubject, tfFrom, tfBody));
check("Thunder Funding not payment inquiry",
    !adm.isPaymentInquiryEmail(tfSubject, tfFrom, tfBody));
check("Thunder Funding has invoice veto",
    adm.hasInvoiceVeto({
      subject: tfSubject,
      body: tfBody,
      from: tfFrom,
      attachments: tfPdf,
      invoicePdfCount: 0,
    }));
check("Thunder Funding 7826 Invoice for processing recognized",
    adm.looksLikeInvoiceEmailContent(
        "Invoice for processing; Invoice #7826 - Purchase Order #266943",
        "updated payment and banking information"));
check("Thunder Funding 7826 banking update is not a payment alert",
    !adm.shouldIgnoreAsPaymentNotification(
        "Invoice for processing; Invoice #7826 - Purchase Order #266943",
        tfFrom,
        "They also notify the recipient of updated payment and banking " +
        "information.",
        [{
          filename:
            "Invoice for processing; Invoice #7826 - Purchase Order #266943.pdf",
          mimeType: "application/octet-stream",
        }]));

const spcSubject = "Single Point Capital; Invoice #265914";
const spcFrom = "reports@singlepointgroup.com";
const spcBody =
  "Single Point Capital is forwarding an attached invoice (#265914) " +
  "for carrier processing. Please confirm receipt.";
const spcPdf = [{filename: "265914.pdf", mimeType: "application/pdf"}];
check("Single Point Capital subject recognized as invoice content",
    adm.looksLikeInvoiceEmailContent(spcSubject, spcBody));
check("Single Point Capital factor domain recognized",
    adm.isCarrierOrFactorSender(spcFrom));
check("Single Point Capital not NOA",
    !adm.isNoticeOfAssignmentEmail(spcSubject, spcFrom, spcBody));
check("Single Point Capital not payment inquiry",
    !adm.isPaymentInquiryEmail(spcSubject, spcFrom, spcBody));
check("Single Point Capital has invoice veto",
    adm.hasInvoiceVeto({
      subject: spcSubject,
      body: spcBody,
      from: spcFrom,
      attachments: spcPdf,
      invoicePdfCount: 0,
    }));
check("Single Point Capital OTHER attachment would veto (not forward)",
    adm.hasInvoiceVeto({
      subject: "Single Point Capital; Invoice #266477",
      from: spcFrom,
      attachments: [{filename: "266477.pdf", mimeType: "application/pdf"}],
      invoicePdfCount: 0,
    }));

const rmSubject = "REF# 266111";
const rmFrom = "RM Capital Inc <invoice@rmcapitalinc.com>";
const rmBody =
  "RM Capital Inc. sent an invoice for reference #266111 and requests " +
  "confirmation of receipt. Payments should be made payable to RM Capital.";
const rmPdf = [{filename: "266111.pdf", mimeType: "application/pdf"}];
check("RM Capital REF# subject recognized as invoice content",
    adm.looksLikeInvoiceEmailContent(rmSubject, rmBody));
check("RM Capital factor domain recognized",
    adm.isCarrierOrFactorSender(rmFrom));
check("RM Capital not NOA",
    !adm.isNoticeOfAssignmentEmail(rmSubject, rmFrom, rmBody));
check("RM Capital not payment inquiry",
    !adm.isPaymentInquiryEmail(rmSubject, rmFrom, rmBody));
check("RM Capital has invoice veto",
    adm.hasInvoiceVeto({
      subject: rmSubject,
      body: rmBody,
      from: rmFrom,
      attachments: rmPdf,
      invoicePdfCount: 0,
    }));
check("RM Capital carrier_invoice classification triggers veto",
    adm.hasInvoiceVeto({
      subject: rmSubject,
      body: rmBody,
      from: rmFrom,
      attachments: rmPdf,
      emailClassification: {intent: "carrier_invoice"},
      invoicePdfCount: 0,
    }));

const revSubject =
  "REV CAPITAL/CENTRAL FORCE TRANSPORT INC., Invoice # 6672 Part 1 of 1";
const revFrom = "Billing <invoices@revinc.com>";
const revBody =
  "REV Capital is sending invoice #6672 for Central Force Transport " +
  "Inc. and requesting that payment be submitted electronically using " +
  "the attached banking information.";
const revPdf = [{filename: "6672.pdf", mimeType: "application/pdf"}];
check("REV Capital subject recognized as invoice content",
    adm.looksLikeInvoiceEmailContent(revSubject, revBody));
check("REV Capital factor domain recognized",
    adm.isCarrierOrFactorSender(revFrom));
check("REV Capital not NOA",
    !adm.isNoticeOfAssignmentEmail(revSubject, revFrom, revBody));
check("REV Capital not payment inquiry",
    !adm.isPaymentInquiryEmail(revSubject, revFrom, revBody));
check("REV Capital ACH remittance body is not a payment alert",
    !adm.shouldIgnoreAsPaymentNotification(
        revSubject, revFrom, revBody, revPdf));
check("REV Capital has invoice veto",
    adm.hasInvoiceVeto({
      subject: revSubject,
      body: revBody,
      from: revFrom,
      attachments: revPdf,
      invoicePdfCount: 0,
    }));
check("REV Capital OTHER attachment would veto (not forward)",
    adm.hasInvoiceVeto({
      subject: revSubject,
      from: revFrom,
      attachments: [{filename: "6672.pdf", mimeType: "application/pdf"}],
      invoicePdfCount: 0,
    }));

const hstileSubject = "Payment 08/25/26";
const hstileFrom = "Michel Schwartz <michel@hstile.com>";
const hstileBody =
  "Please find attached our payment remittance for outstanding invoices.";
const hstileAtt = [
  {filename: "remittance.pdf", mimeType: "application/pdf"},
];
check("Lisa hstile Payment date subject detected",
    adm.subjectLooksLikeCustomerPaymentDate(hstileSubject));
check("Lisa hstile customer payment remittance detected",
    adm.isCustomerPaymentRemittanceEmail(
        hstileSubject, hstileFrom, hstileBody));
check("Lisa hstile should handle customer remittance",
    adm.shouldHandleCustomerPaymentRemittance(
        hstileSubject, hstileFrom, hstileBody));
check("Lisa hstile misclassified carrier_invoice does not veto",
    !adm.hasInvoiceVeto({
      subject: hstileSubject,
      body: hstileBody,
      from: hstileFrom,
      attachments: hstileAtt,
      emailClassification: {intent: "carrier_invoice"},
      invoicePdfCount: 1,
    }));
check("Re: Payment date subject still detected",
    adm.subjectLooksLikeCustomerPaymentDate("Re: Payment 08/25/26"));
check("Fw: Payment date subject still detected",
    adm.subjectLooksLikeCustomerPaymentDate("Fw: Payment 3/15/2026"));
check("Payment date subject not matched for load inquiry",
    !adm.subjectLooksLikeCustomerPaymentDate(
        "Pending Payment for Load # 265721"));
check("Factor remit for payment is not customer remittance",
    !adm.isCustomerPaymentRemittanceEmail(
        suretyRemitSubject, suretyRemitFrom, suretyRemitBody));
check("Carrier Quick Pay is not customer remittance",
    !adm.isCustomerPaymentRemittanceEmail(
        quickPaySubject, "steve@x.com", quickPayBody));
check("FactorView invoice is not customer remittance",
    !adm.isCustomerPaymentRemittanceEmail(fvSubject, fvFrom, ""));
check("factorview sender excluded from customer remittance",
    adm.isCarrierOrFactorSender(
        "Surety Financial LLC <notification@factorview.com>"));
check("remittance advice from customer detected",
    adm.isCustomerPaymentRemittanceEmail(
        "Remittance advice",
        "accounts@customer.com",
        "Please find attached remittance advice for payment."));
check("remittance with load number is not customer remittance",
    !adm.isCustomerPaymentRemittanceEmail(
        "Payment update",
        "dispatch@carrier.com",
        "Please find remittance for load #265721"));

const ruelilySubject = "Your Remittance Advice 1557";
const ruelilyFrom = "Leonore Dalmacio <leonored@ruelily.com>";
const ruelilyBody =
  "Please see attached Remittance Advice.\n\n" +
  "Invoice #981 for BOL #265400 — Amount paid $1,250.00\n" +
  "Invoice #982 for BOL #265401 — Amount paid $980.00\n";
const ruelilyAtt = [
  {filename: "Remittance_Advice_1557.pdf", mimeType: "application/pdf"},
  {filename: "1557_detail.pdf", mimeType: "application/pdf"},
];
check("Ruelily Remittance Advice subject detected",
    adm.subjectLooksLikeRemittanceAdvice(ruelilySubject));
check("Ruelily Remittance Advice with invoice/BOL lines still remittance",
    adm.isCustomerPaymentRemittanceEmail(
        ruelilySubject, ruelilyFrom, ruelilyBody));
check("Ruelily Remittance Advice should handle → Abe",
    adm.shouldHandleCustomerPaymentRemittance(
        ruelilySubject, ruelilyFrom, ruelilyBody));
check("Ruelily Remittance Advice not ignored as bank payment alert",
    !adm.shouldIgnoreAsPaymentNotification(
        ruelilySubject, ruelilyFrom, ruelilyBody, ruelilyAtt));
check("Ruelily Remittance Advice does not invoice-veto",
    !adm.hasInvoiceVeto({
      subject: ruelilySubject,
      body: ruelilyBody,
      from: ruelilyFrom,
      attachments: ruelilyAtt,
      emailClassification: {intent: "carrier_invoice"},
      invoicePdfCount: 0,
    }));
check("Remittance Advice #1557 subject detected",
    adm.subjectLooksLikeRemittanceAdvice("Remittance Advice #1557"));
check("Re: Your Remittance Advice subject detected",
    adm.subjectLooksLikeRemittanceAdvice("Re: Your Remittance Advice 1557"));

const altarebSubject = "Re: Invoice for BOL#265388";
const altarebFrom = "Taha AltaReb <taha@altarebglobal.com>";
const altarebBody =
  "Hi Abe,\n\nPayment was sent via Zelle for this invoice. " +
  "Paid in full today.\n\nThanks,\nTaha\n\n" +
  "On Mon, Aug 25, 2026 Abe <abe@innovativecarriers.com> wrote:\n" +
  "PLEASE NOTE OUR NEW BANKING INFORMATION\n" +
  "Quickpay/Zelle\naccounting@innovativecarriers.com\n";
check("AltaReb Invoice for BOL reply subject recognized",
    adm.subjectLooksLikeInvoiceForBolReply(altarebSubject));
check("Invoice # in BOL subject still recognized as reply",
    adm.subjectLooksLikeInvoiceForBolReply(
        "Re: Invoice #28415 for BOL #267130"));
check("Invoice # in BOL# subject still recognized as reply",
    adm.subjectLooksLikeInvoiceForBolReply(
        "Re: Invoice #28415 for BOL#267130"));
check("EXTERNAL customer invoice reply subject recognized",
    adm.subjectLooksLikeInvoiceForBolReply(
        "RE: [EXTERNAL]Invoice #28301 for BOL #265467"));
check("looksLikeInvoiceEmailContent accepts EXTERNAL BOL reply",
    adm.looksLikeInvoiceEmailContent(
        "RE: [EXTERNAL]Invoice #28301 for BOL #265467", ""));
check("AltaReb paid notice in top-of-thread detected",
    adm.bodyLooksLikeCustomerPaidNotice(altarebBody));
check("AltaReb remittance reply detected → Abe",
    adm.isCustomerPaymentRemittanceEmail(
        altarebSubject, altarebFrom, altarebBody));
check("AltaReb should handle customer remittance",
    adm.shouldHandleCustomerPaymentRemittance(
        altarebSubject, altarebFrom, altarebBody));
check("AltaReb not ignored as payment_notification (BoA-only)",
    !adm.shouldIgnoreAsPaymentNotification(
        altarebSubject, altarebFrom, altarebBody, []));
check("AltaReb remittance does not invoice-veto",
    !adm.hasInvoiceVeto({
      subject: altarebSubject,
      body: altarebBody,
      from: altarebFrom,
      attachments: [],
      emailClassification: {intent: "carrier_invoice"},
      invoicePdfCount: 0,
    }));

// Innovative CHB customs-broker invoice/BOL thread (Sep 3 2026 ops miss).
// Was misclassified as payment_notification_ignored when quoted body had
// Quickpay/Zelle tips and subject used Invoice-##### + CR#/BOL# (not
// "Invoice for BOL#").
const chbSubject =
  "RE: Invoice-0003138, CR#: 266272 RE: BOL# 266272";
const chbFrom = "Isreal Rosenfeld <ir@innovativechb.com>";
const chbBody =
  "Please see attached customs docs.\n\n" +
  "On Tue, Sep 2, 2026 Abe <abe@innovativecarriers.com> wrote:\n" +
  "PLEASE NOTE OUR NEW BANKING INFORMATION\n" +
  "Quickpay/Zelle\naccounting@innovativecarriers.com\n";
check("CHB Invoice-##### + CR#/BOL# subject recognized as invoice thread",
    adm.looksLikeInvoiceEmailContent(chbSubject, chbBody));
check("CHB Invoice-##### + CR#/BOL# subjectLooksLikeInvoiceForBolReply",
    adm.subjectLooksLikeInvoiceForBolReply(chbSubject));
check("CHB invoice/BOL reply not ignored as Zelle/bank payment notification",
    !adm.shouldIgnoreAsPaymentNotification(
        chbSubject, chbFrom, chbBody, []));
check("CHB invoice/BOL reply has invoice veto",
    adm.hasInvoiceVeto({
      subject: chbSubject,
      body: chbBody,
      from: chbFrom,
      attachments: [],
    }));
check("CHB invoice/BOL reply is not customer remittance (no paid notice)",
    !adm.isCustomerPaymentRemittanceEmail(chbSubject, chbFrom, chbBody));
check("Lisa reply on CHB invoice thread also not Zelle-ignored",
    !adm.shouldIgnoreAsPaymentNotification(
        chbSubject,
        "Lisa <lisa@innovativecarriers.com>",
        chbBody,
        []));
check("hyphenated Invoice-0003138 subject alone recognized",
    adm.looksLikeInvoiceEmailContent(
        "RE: Invoice-0003138", "customs invoice attached"));
check("BoA Zelle alert still ignored after CHB subject fix",
    adm.shouldIgnoreAsPaymentNotification(
        "Goldengate Logistics Llc sent you $36.00",
        "Bank of America <customerservice@ealerts.bankofamerica.com>",
        "You received a Zelle payment of $500",
        []));
check("Heypharma invoice attach reply is NOT customer remittance",
    !adm.isCustomerPaymentRemittanceEmail(
        heypharmaSubject, heypharmaFrom, heypharmaBody));
check("quoted Zelle banking tip alone is NOT customer paid notice",
    !adm.bodyLooksLikeCustomerPaidNotice(
        "Please see attached invoice.\n\n" +
        "On Tue, Aug 26, 2026 Abe <abe@innovativecarriers.com> wrote:\n" +
        "Quickpay/Zelle\naccounting@innovativecarriers.com\n"));

const venetoSubject = "Re: Invoice #29395 for BOL #265373";
const venetoFrom = "Veneto Luce Office <veneto.luce@gmail.com>";
const venetoBody =
  "Hi, Thanks for the invoice. B ut every time we pay you directly " +
  "when we confirm the pick up so can you&nbsp; check your email and " +
  "find the pictures i sent you for the fron and back images of the " +
  "check Thank you and have a nice day. Veneto Luce Inc. " +
  "On Wed, Sep 2, 2026 at 1:54 PM Innovative Accounting " +
  "<accounting@innovativecarriers.com> wrote: Hi, Please see your " +
  "invoices attached.";
check("Veneto Invoice # for BOL reply subject recognized",
    adm.subjectLooksLikeInvoiceForBolReply(venetoSubject));
check("Veneto check-photo proof of payment detected",
    adm.bodyLooksLikeCustomerPaidNotice(venetoBody));
check("Veneto remittance reply detected → Abe",
    adm.isCustomerPaymentRemittanceEmail(
        venetoSubject, venetoFrom, venetoBody));
check("Veneto should handle customer remittance",
    adm.shouldHandleCustomerPaymentRemittance(
        venetoSubject, venetoFrom, venetoBody));
check("Veneto remittance does not invoice-veto",
    !adm.hasInvoiceVeto({
      subject: venetoSubject,
      body: venetoBody,
      from: venetoFrom,
      attachments: [],
      emailClassification: {intent: "unknown"},
      invoicePdfCount: 0,
    }));

const sandersSubject = "CK 6706";
const sandersFrom = "Accounts Payable <ap@sanderscollection.com>";
const sandersBody =
  "Please find attached remittance advice. Payment enclosed for $1,405.00.";
const sandersAtt = [
  {filename: "6706_remittance.pdf", mimeType: "application/pdf"},
];
check("Lisa Sanders CK subject detected",
    adm.subjectLooksLikeCustomerCheckNumber(sandersSubject));
check("Lisa Sanders customer payment remittance detected",
    adm.isCustomerPaymentRemittanceEmail(
        sandersSubject, sandersFrom, sandersBody));
check("Lisa Sanders should handle customer remittance",
    adm.shouldHandleCustomerPaymentRemittance(
        sandersSubject, sandersFrom, sandersBody));
check("Lisa Sanders misclassified carrier_invoice does not veto",
    !adm.hasInvoiceVeto({
      subject: sandersSubject,
      body: sandersBody,
      from: sandersFrom,
      attachments: sandersAtt,
      emailClassification: {intent: "carrier_invoice"},
      invoicePdfCount: 1,
    }));
check("Check #6706 subject detected",
    adm.subjectLooksLikeCustomerCheckNumber("Check #6706"));
check("Check 6706 subject detected",
    adm.subjectLooksLikeCustomerCheckNumber("Check 6706"));
check("Check No. 6706 subject detected",
    adm.subjectLooksLikeCustomerCheckNumber("Check No. 6706"));
check("Re: CK 6706 subject still detected",
    adm.subjectLooksLikeCustomerCheckNumber("Re: CK 6706"));
check("CK subject from AP with minimal body detected",
    adm.isCustomerPaymentRemittanceEmail(
        sandersSubject, sandersFrom, ""));
check("CK subject not matched for Quick Pay load inquiry",
    !adm.subjectLooksLikeCustomerCheckNumber(
        "Re: Quick Pay Invoice - Load #: 265620"));
check("factor sender excluded even with Check subject",
    !adm.isCustomerPaymentRemittanceEmail(
        "Check 1234",
        "Surety Financial LLC <notification@factorview.com>",
        "Remit for payment"));

const berkshireSubject = "Berkshire Fashions Inc Payment";
const berkshireFrom = "Francia Marcelo <FranciaM@berkshireinc.com>";
const berkshireBody =
  "The sender reports that Berkshire Fashions Inc. wired a payment of " +
  "$12,155.00 and references an attached payment confirmation.";
const berkshireBodyAlt =
  "Hi, We wired a payment of $12,155.00. Attached is the payment confirmation.";
const berkshireAtt = [
  {filename: "wire_confirmation.pdf", mimeType: "application/pdf"},
  {filename: "payment_screenshot.png", mimeType: "image/png"},
];
check("Berkshire company Payment subject detected",
    adm.subjectLooksLikeCustomerPaymentNotice(berkshireSubject));
check("Payment Confirmation subject detected",
    adm.subjectLooksLikeCustomerPaymentNotice("Payment Confirmation"));
check("Pending Payment for Load is not customer payment notice",
    !adm.subjectLooksLikeCustomerPaymentNotice(
        "Pending Payment for Load # 265721"));
check("Berkshire wired-a-payment body is paid notice",
    adm.bodyLooksLikeCustomerPaidNotice(berkshireBody));
check("Berkshire Attached is the payment confirmation is paid notice",
    adm.bodyLooksLikeCustomerPaidNotice(berkshireBodyAlt));
check("Berkshire customer remittance detected → Abe",
    adm.isCustomerPaymentRemittanceEmail(
        berkshireSubject, berkshireFrom, berkshireBody));
check("Berkshire alt wording still remittance → Abe",
    adm.isCustomerPaymentRemittanceEmail(
        berkshireSubject, berkshireFrom, berkshireBodyAlt));
check("Berkshire should handle customer remittance",
    adm.shouldHandleCustomerPaymentRemittance(
        berkshireSubject, berkshireFrom, berkshireBody));
check("Berkshire OTHER attachments do not invoice-veto remittance",
    !adm.hasInvoiceVeto({
      subject: berkshireSubject,
      body: berkshireBody,
      from: berkshireFrom,
      attachments: berkshireAtt,
      emailClassification: {intent: "unknown"},
      invoicePdfCount: 0,
    }));
check("Berkshire not a freight invoice subject",
    !adm.looksLikeInvoiceEmailContent(berkshireSubject, berkshireBody));
check("Berkshire not ignored as bank payment alert",
    !adm.shouldIgnoreAsPaymentNotification(
        berkshireSubject, berkshireFrom, berkshireBody, berkshireAtt));
check("Berkshire factor-style load remittance still excluded",
    !adm.isCustomerPaymentRemittanceEmail(
        "Payment update",
        berkshireFrom,
        "Please find remittance for load #265721"));

const averittSubject = "1467163 INNOVATIVE CARRIERS INC";
const averittFrom = "Amanda Tate <atate@averitt.com>";
const averittBody =
  "Good morning,\n\nWe are following up on overdue invoices totaling " +
  "$1,388.72. Please provide payment information or an explanation.\n\n" +
  "Thank you,\nAmanda Tate";
const averittAtt = [
  {
    filename: "overdue_invoices.xls",
    mimeType: "application/vnd.ms-excel",
  },
];
check("Lisa Averitt account-number subject recognized",
    adm.subjectLooksLikeCarrierAccountStatement(averittSubject));
check("Lisa Averitt overdue body recognized",
    adm.bodyLooksLikeOverdueInvoiceFollowUp(averittBody));
check("Lisa Averitt XLS list filename recognized",
    adm.attachmentFilenameLooksLikeStatementList("overdue_invoices.xls"));
check("Lisa Averitt carrier statement follow-up detected",
    adm.isCarrierStatementFollowUpEmail(
        averittSubject, averittFrom, averittBody, averittAtt));
check("Lisa Averitt should handle when no invoice PDF",
    adm.shouldHandleCarrierStatementFollowUp(
        averittSubject, averittFrom, averittBody, averittAtt, 0));
check("Lisa Averitt skipped when invoice PDF present",
    !adm.shouldHandleCarrierStatementFollowUp(
        averittSubject, averittFrom, averittBody, averittAtt, 1));
check("Lisa Averitt XLS invoice-list filename triggers invoice veto",
    adm.hasInvoiceVeto({
      subject: averittSubject,
      body: averittBody,
      attachments: averittAtt,
      invoicePdfCount: 0,
    }));
check("Lisa Averitt not customer remittance",
    !adm.isCustomerPaymentRemittanceEmail(
        averittSubject, averittFrom, averittBody));
check("Lisa Averitt not a freight invoice subject",
    !adm.looksLikeInvoiceEmailContent(averittSubject, averittBody));
check("Lisa Averitt Abe on CC detected",
    adm.isAbeCopiedOnEmailHeaders([
      {name: "From", value: averittFrom},
      {name: "To", value: "billing@innovativecarriers.com"},
      {name: "Cc", value: "Abe Goldberger <abe@innovativecarriers.com>"},
    ]));
check("Lisa Averitt Abe not on CC",
    !adm.isAbeCopiedOnEmailHeaders([
      {name: "From", value: averittFrom},
      {name: "To", value: "billing@innovativecarriers.com"},
    ]));
check("ArcBest eInvoice is not carrier statement follow-up",
    !adm.isCarrierStatementFollowUpEmail(
        arcBestSubject,
        "brooklyncustomerservice@abf.com",
        arcBestBody,
        arcBestAttachments));

// Ambiguous Zelle language (non-bank from) must NOT regex quiet-ignore —
// AI owns that path. Clear bank alerts still ignore.
check("CHB 266272-style subject+quoted Zelle is NOT ambiguous candidate",
    !adm.isAmbiguousPaymentNotificationCandidate(
        chbSubject, chbFrom, chbBody, []));
check("CHB 266272-style never regex quiet-ignores",
    !adm.shouldIgnoreAsPaymentNotification(
        chbSubject, chbFrom, chbBody, []));
check("quoted Zelle from random Gmail is ambiguous (AI path), not regex ignore",
    adm.isAmbiguousPaymentNotificationCandidate(
        "Payment update",
        "random.person@gmail.com",
        "Just FYI about Zelle — not sure if this is the right inbox.",
        []) &&
    !adm.shouldIgnoreAsPaymentNotification(
        "Payment update",
        "random.person@gmail.com",
        "Just FYI about Zelle — not sure if this is the right inbox.",
        []));
check("BoA Zelle is known bank sender, not ambiguous",
    adm.isKnownBankPaymentAlertSender(
        "Bank of America <customerservice@ealerts.bankofamerica.com>") &&
    !adm.isAmbiguousPaymentNotificationCandidate(
        "Goldengate Logistics Llc sent you $36.00",
        "Bank of America <customerservice@ealerts.bankofamerica.com>",
        "You received a Zelle payment of $500",
        []));
check("Chase alerts@ is known bank-alert sender",
    adm.isKnownBankPaymentAlertSender("Chase <alerts@chase.com>"));
check("payment alert language detects Zelle",
    adm.hasPaymentAlertLanguage(
        "hi", "Quickpay/Zelle accounting@innovativecarriers.com"));

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nAll administrative email tests passed");
