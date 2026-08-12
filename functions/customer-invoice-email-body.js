"use strict";

const {innovativeCarriersLogoHtml} = require("./email-branding");

const BRAND_BLUE = "#174a94";
const BORDER = "#d1d5db";
const ROW_ALT = "#f8fafc";

/**
 * @param {string} method Payment method label.
 * @param {string} detailsHtml Details cell HTML (may include <br>).
 * @param {boolean} [altRow] Alternate row background.
 * @return {string}
 */
function paymentRow(method, detailsHtml, altRow = false) {
  const bg = altRow ? `background:${ROW_ALT};` : "";
  return (
    "<tr>" +
    `<td style="padding:10px 12px;border:1px solid ${BORDER};` +
    `vertical-align:top;font-weight:600;width:34%;${bg}">` +
    `${method}</td>` +
    `<td style="padding:10px 12px;border:1px solid ${BORDER};` +
    `vertical-align:top;line-height:1.5;${bg}">${detailsHtml}</td>` +
    "</tr>"
  );
}

/**
 * Innovative Carriers payment signature block (styled HTML table).
 * @return {string} HTML fragment (no outer html/body tags).
 */
function customerInvoiceEmailSignatureHtml() {
  return (
    "<div style=\"margin-top:24px;font-family:Arial,Helvetica,sans-serif\">" +
    "<table cellpadding=\"0\" cellspacing=\"0\" role=\"presentation\" " +
    "style=\"border-collapse:collapse;max-width:560px;width:100%;" +
    "font-size:13px;color:#111827\">" +
    "<tr>" +
    `<td colspan="2" style="background:${BRAND_BLUE};color:#ffffff;` +
    "padding:10px 14px;font-size:14px;font-weight:700;" +
    "letter-spacing:.02em\">Payment Method</td>" +
    "</tr>" +
    "<tr>" +
    `<td style="padding:8px 12px;border:1px solid ${BORDER};` +
    "background:#eef2f7;font-weight:700;width:34%\">Payment Method</td>" +
    `<td style="padding:8px 12px;border:1px solid ${BORDER};` +
    "background:#eef2f7;font-weight:700\">Details</td>" +
    "</tr>" +
    paymentRow(
        "ACH/Wire",
        "Customers Bank<br>" +
        "99 Bridge St. Phoenixville, PA 19460<br>" +
        "Account Number: 4255247<br>" +
        "Routing for ACH &amp; Domestic Wire: 031302971",
        true,
    ) +
    paymentRow(
        "Quickpay/Zelle",
        "<a href=\"mailto:accounting@innovativecarriers.com\">" +
        "accounting@innovativecarriers.com</a>",
    ) +
    paymentRow(
        "Email Check Image",
        "<a href=\"mailto:abe@innovativecarriers.com\">" +
        "abe@innovativecarriers.com</a>",
        true,
    ) +
    paymentRow(
        "Credit Card<br><span style=\"font-weight:400;font-size:12px\">" +
        "(3% fee)</span>",
        "<a href=\"https://secure.cardknox.com/innovativecarriers\" " +
        "style=\"color:#174a94\">" +
        "https://secure.cardknox.com/innovativecarriers</a>",
    ) +
    "</table>" +
    `<div style="margin:18px 0 0">` +
    innovativeCarriersLogoHtml({mode: "data", maxWidth: 280}) +
    "</div>" +
    "</div>"
  );
}

/**
 * Default body for Primus manage.php emailBOLDocs (customer invoice send).
 * @return {string} HTML email body.
 */
function defaultPrimusEmailDocsBody() {
  return (
    "<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:14px;" +
    "color:#111827;line-height:1.6\">" +
    "<p>Hi,</p>" +
    "<p>Please see your invoices attached.</p>" +
    "<p>Thank you!</p>" +
    customerInvoiceEmailSignatureHtml() +
    "</div>"
  );
}

/**
 * @param {string} messageHtml Main message HTML (greeting + invoice details).
 * @return {string} Message with standard payment signature appended.
 */
function appendCustomerInvoiceEmailSignature(messageHtml) {
  return String(messageHtml || "") + customerInvoiceEmailSignatureHtml();
}

module.exports = {
  customerInvoiceEmailSignatureHtml,
  defaultPrimusEmailDocsBody,
  appendCustomerInvoiceEmailSignature,
};
