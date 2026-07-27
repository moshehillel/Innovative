/* eslint-disable no-console */
const ins = require("../innovative-insurance");

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${actual}` +
    (ok ? "" : ` (expected ${expected})`));
};

check("rejects can", ins.isPlausibleInsuranceInvoiceNumber("can"), false);
check("accepts 12345", ins.isPlausibleInsuranceInvoiceNumber("12345"), true);
check("rejects redkik.com", ins.isPlausibleInsuranceInvoiceNumber("redkik.com"),
    false);

check("pdf garbage can ignored",
    ins.extractInsuranceInvoiceNumber("Invoice # can pay from redkik.com"),
    null);
check("numeric invoice",
    ins.extractInsuranceInvoiceNumber("Invoice # 8844221 total $100"),
    "8844221");
check("from email subject",
    ins.extractInsuranceInvoiceNumber(
        "Invoice 991234 from Redkik - please pay"),
    "991234");

const resolved = ins.resolveInsuranceVendorInvoiceNumber(
    {invoiceNumber: "can"},
    {subject: "Invoice 556677 from Redkik", body: ""},
);
check("email wins over bad pdf", resolved.invoiceNumber, "556677");
check("source email", resolved.invoiceNumberSource, "email");

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
