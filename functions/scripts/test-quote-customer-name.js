#!/usr/bin/env node
/**
 * Regression: never use email local-part as customerName.
 * Usage: node scripts/test-quote-customer-name.js
 */
"use strict";

const assert = require("assert");
const customerName = require("../quote-customer-name");
const intake = require("../quote-intake");

let passed = 0;
let failed = 0;

/**
 * @param {string} label Test name.
 * @param {*} got Actual.
 * @param {*} want Expected.
 * @return {void}
 */
function check(label, got, want) {
  try {
    assert.deepStrictEqual(got, want);
    passed++;
    console.log(`✓ ${label}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${label}`);
    console.error(`  got:  ${JSON.stringify(got)}`);
    console.error(`  want: ${JSON.stringify(want)}`);
    console.error(`  ${err.message}`);
  }
}

check("gershon@gmail local-part matches Gerson",
    customerName.isNameFromEmailLocalPart(
        "Gerson", "gershon@gmail.com"), true);
check("gershon@gmail local-part matches Gershon",
    customerName.isNameFromEmailLocalPart(
        "Gershon", "gershon@gmail.com"), true);
check("real company name not local-part",
    customerName.isNameFromEmailLocalPart(
        "Brumis Imports Inc", "gershon@gmail.com"), false);
check("gmail freemail domain",
    customerName.isFreemailDomain("gmail.com"), true);
check("acme.com not freemail",
    customerName.isFreemailDomain("acme.com"), false);
check("freemail domain → no company name",
    customerName.customerNameFromEmailDomain("gershon@gmail.com"), "");
check("company domain → Acme",
    customerName.customerNameFromEmailDomain("jane@acme.com"), "Acme");
check("mail.acme.com → Acme",
    customerName.customerNameFromEmailDomain(
        "ops@mail.acme.com"), "Acme");
check("never use Gmail brand",
    customerName.isFreemailBrandName("Gmail"), true);

const cleared = customerName.sanitizeExtractedCustomerName({
  customerName: "Gerson",
  shippingLocationName: "Gerson",
}, "gershon@gmail.com");
check("sanitize clears Gerson from freemail",
    cleared.customerName, null);
check("sanitize clears shippingLocationName Gerson",
    cleared.shippingLocationName, null);

const domainFill = customerName.sanitizeExtractedCustomerName({
  customerName: "Jane",
}, "jane@acme.com");
check("sanitize clears local-part Jane then fills Acme",
    domainFill.customerName, "Acme");

const keepCompany = customerName.sanitizeExtractedCustomerName({
  customerName: "Brumis Imports Inc",
}, "jared@gmail.com");
check("sanitize keeps explicit company on freemail",
    keepCompany.customerName, "Brumis Imports Inc");

check("pick skips Gerson then empty on gmail",
    customerName.pickUsableCustomerName(
        "gershon@gmail.com", "Gerson", "Gershon"), "");
check("pick prefers body company over domain",
    customerName.pickUsableCustomerName(
        "ops@acme.com", "Acme Logistics LLC"), "Acme Logistics LLC");
check("pick clears local-part then uses domain",
    customerName.pickUsableCustomerName(
        "jane@acme.com", "Jane"), "Acme");
check("pick empty freemail stays empty",
    customerName.pickUsableCustomerName(
        "someone@yahoo.com"), "");

const finished = intake.normalizeExtractedQuote({
  customerName: "Gerson",
  lanes: [],
}, {from: "gershon@gmail.com", body: "please quote 1 pallet"});
check("normalizeExtractedQuote clears Gerson",
    finished.customerName, null);

const prompt = intake.quoteExtractSystemPrompt();
check("prompt forbids local-part customerName",
    /NEVER invent customerName from the email local-part/i.test(prompt),
    true);
check("prompt freemail guidance",
    /Freemail hosts/i.test(prompt), true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
