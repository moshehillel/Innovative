/* eslint-disable no-console */
"use strict";

const bridge = require("../primus-ui-bridge");
const {
  normalizeCompanyName,
  pickAccountingEmails,
  isAccountingContactType,
  sanitizeBillToReferenceText,
  pickManageLocationFromList,
  namesAreCloseForBillto,
  enrichBillToPartyFromConsignee,
  preferredBilltoSuffixFromBooking,
  initialsFromPersonName,
} = bridge._internal;

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}` +
    (ok ? "" : `\n  got: ${JSON.stringify(actual)}` +
      `\n  exp: ${JSON.stringify(expected)}`));
};

check("normalizeCompanyName strips INC",
    normalizeCompanyName("CUSTOM TRAILER MOVES INC"),
    "custom trailer moves");
check("normalizeCompanyName strips LLC punctuation",
    normalizeCompanyName("Acme Logistics, LLC."),
    "acme logistics");
check("normalizeCompanyName matches variants",
    normalizeCompanyName("Foo Corp") === normalizeCompanyName("FOO CORPORATION"),
    true);

check("pickAccountingEmails accepts accounting",
    pickAccountingEmails([{type: "Accounting", email: "ap@test.com"}]),
    ["ap@test.com"]);
check("pickAccountingEmails accepts accounts receivable",
    pickAccountingEmails([{type: "Accounts Receivable", email: "ar@test.com"}]),
    ["ar@test.com"]);
check("pickAccountingEmails accepts a/r",
    pickAccountingEmails([{type: "A/R", email: "billing@test.com"}]),
    ["billing@test.com"]);
check("pickAccountingEmails accepts billing",
    pickAccountingEmails([{type: "Billing", email: "bill@test.com"}]),
    ["bill@test.com"]);
check("pickAccountingEmails ignores operations",
    pickAccountingEmails([{type: "Operations", email: "ops@test.com"}]),
    []);

check("isAccountingContactType billing",
    isAccountingContactType("Billing Contact"), true);
check("isAccountingContactType dispatch false",
    isAccountingContactType("Dispatch"), false);

check("sanitizeBillToReference rejects undefined string",
    sanitizeBillToReferenceText("undefined"), "");
check("sanitizeBillToReference rejects null string",
    sanitizeBillToReferenceText("null"), "");
check("sanitizeBillToReference keeps valid ref",
    sanitizeBillToReferenceText("UNIT-12345"), "UNIT-12345");
check("sanitizeBillToReference normalizes nbsp",
    sanitizeBillToReferenceText("ABC\u00a0123"), "ABC 123");

check("pickManageLocationFromList TEC Portland zip (non-customer)",
    pickManageLocationFromList([
      {id: 1953500588, name: "TEC EQUIPMENT INC", zipcode: "97211",
        customer: false},
      {id: 9999999, name: "TEC EQUIPMENT INC", zipcode: "90210",
        customer: false},
    ], {name: "TEC EQUIPMENT INC", zipCode: "97211"}),
    1953500588);

check("pickManageLocationFromList booking INC matches DB without INC",
    pickManageLocationFromList([
      {id: 123, name: "TEC EQUIPMENT", zipcode: "97211"},
    ], {name: "TEC EQUIPMENT INC", zipCode: "97211"}),
    123);

check("namesAreCloseForBillto typo EQUPMENT",
    namesAreCloseForBillto("FLEET EQUPMENT", "FLEET EQUIPMENT LLC"),
    true);
check("namesAreCloseForBillto different companies",
    namesAreCloseForBillto("FLEET EQUPMENT", "Werner Fleet Sales"),
    false);
check("initialsFromPersonName Karen Adams",
    initialsFromPersonName("Karen Adams"), "ka");
check("preferredBilltoSuffixFromBooking control user",
    preferredBilltoSuffixFromBooking({
      contactInformation: {controlUser: {name: "Karen Adams"}},
    }), "ka");
check("pickManageLocationFromList prefers KA suffix",
    pickManageLocationFromList([
      {id: 1528921854, name: "Fleet Equipment LLC (JB)", zipcode: "38118"},
      {id: 1324252881, name: "Fleet Equipment LLC (KA)", zipcode: "38118"},
    ], {name: "FLEET EQUIPMENT LLC", zipCode: "38118"},
    {preferredSuffix: "ka"}),
    1324252881);
check("enrichBillToPartyFromConsignee uses spelled consignee",
    enrichBillToPartyFromConsignee(
        {id: null, name: "FLEET EQUPMENT", zipCode: ""},
        {consignee: {id: 447360316, name: "FLEET EQUIPMENT LLC",
          zipCode: "38118"}}).name,
    "FLEET EQUIPMENT LLC");

(async () => {
  const party = {
    name: "CUSTOM TRAILER MOVES INC",
    email: "hunter@customtrailermoves.com",
  };
  const booking = {billTo: "thirdparty", thirdParty: party};

  const origEnabled = process.env.PRIMUS_USE_MANAGE_PHP;
  process.env.PRIMUS_USE_MANAGE_PHP = "false";

  const result = await bridge.resolveCustomerAccountingEmails(booking);
  check("resolveCustomerAccountingEmails no booking_party_email primary",
      result.emails, []);
  check("resolveCustomerAccountingEmails source",
      result.source, "no_accounting_contacts");
  check("resolveCustomerAccountingEmails fallbackEmail preserved",
      result.fallbackEmail, "hunter@customtrailermoves.com");

  process.env.PRIMUS_USE_MANAGE_PHP = origEnabled;

  console.log(failures ? `\n${failures} test(s) failed` : "\nAll tests passed");
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
