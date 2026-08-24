/* eslint-disable no-console */
"use strict";

const apex = require("../apex-capital-intake");

let failures = 0;
const check = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const sampleHtml = `
<p>From Apex Capital Corp</p>
<a href="https://amp.apexcapitalcorp.com/m3clients/ViewPDFDocument.do?type=invoice&amp;bar_code=100818481258">Invoice 1</a>
<a href="https://amp.apexcapitalcorp.com/m3clients/ViewPDFDocument.do?type=invoice&bar_code=100818500102">Invoice 2</a>
<a href="https://amp.apexcapitalcorp.com/m3clients/RetrieveMessage.do?id=1&key=abc">Portal</a>
`;

check("detects Apex Capital in subject",
    apex.isApexCapitalEmail("FW: Apex Capital Corp - Invoices", "", "", ""));
check("detects apex host in body",
    apex.isApexCapitalEmail("", "", sampleHtml, ""));
check("ignores unrelated email",
    !apex.isApexCapitalEmail("Your Saia invoice", "saia@example.com", "", ""));

const urls = apex.extractApexInvoicePdfUrls(sampleHtml);
check("finds two invoice PDF links", urls.length === 2);
check("first link has bar_code 100818481258",
    urls[0].includes("bar_code=100818481258"));
check("dedupes duplicate bar_code",
    apex.extractApexInvoicePdfUrls(
        sampleHtml + sampleHtml).length === 2);
check("skips non-invoice Apex links",
    !urls.some((u) => u.includes("RetrieveMessage")));

check("barCodeFromApexUrl",
    apex.barCodeFromApexUrl(urls[0]) === "100818481258");

const pdfBuf = Buffer.from("%PDF-1.4 test");
check("isPdfBuffer true", apex.isPdfBuffer(pdfBuf));
check("isPdfBuffer false", !apex.isPdfBuffer(Buffer.from("hello")));

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nAll apex intake tests passed");
