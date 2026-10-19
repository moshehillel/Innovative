#!/usr/bin/env node
/**
 * Forwarded From: Name <email> must survive plain-text cleanup and
 * match a sender→customer rule when the outer From is the quotes mailbox.
 * Usage: node scripts/test-quote-forwarded-from.js
 */
"use strict";

const assert = require("assert");
const intake = require("../quote-intake");
const quoteMailQueue = require("../quote-mail-queue");
const senderRules = require("../quote-sender-rules");

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
  }
}

const plainForward = [
  "From: Innovative Quotes <quotes@innovativecarriers.com>",
  "Sent: Tuesday, October 13, 2026 1:51 PM",
  "To: Leo <leo@innovativecarriers.com>",
  "Subject: FW: PLEASE QUOTE",
  "",
  "From: HERSHY R <hershy408@gmail.com>",
  "Sent: Tuesday, October 13, 2026 1:01 PM",
  "To: Innovative Quotes <quotes@innovativecarriers.com>; " +
    "HERSHEL BRACH <hershelbrach@gmail.com>; " +
    "Moses Scher <moses@innovativecarriers.com>",
  "Subject: PLEASE QUOTE",
  "",
  "From Eminah Properties, 408 Park Ave, Brooklyn, NY 11205",
].join("\n");

const cleaned = intake.toPlainText(plainForward);
check("angle-bracket From address kept",
    cleaned.includes("HERSHY R <hershy408@gmail.com>"), true);
check("other forwarded addresses kept",
    cleaned.includes("<hershelbrach@gmail.com>") &&
    cleaned.includes("<moses@innovativecarriers.com>"), true);

const htmlNameOnly = [
  "<div>",
  "From: <a href=\"mailto:hershy408@gmail.com\">HERSHY R</a><br>",
  "Sent: Tuesday, October 13, 2026 1:01 PM<br>",
  "Subject: PLEASE QUOTE",
  "</div>",
].join("");
const fromHtml = intake.toPlainText(htmlNameOnly);
check("mailto display-name keeps the address",
    fromHtml.includes("HERSHY R <hershy408@gmail.com>"), true);

const htmlWrapped = [
  "<p>From: HERSHY R &lt;<a href=\"mailto:hershy408@gmail.com\">",
  "hershy408@gmail.com</a>&gt;<br>Sent: Tuesday</p>",
].join("");
check("mailto already visible is not doubled",
    (intake.toPlainText(htmlWrapped).match(/hershy408@gmail.com/g) || [])
        .length, 1);

check("real html tags still flatten",
    intake.toPlainText("<div>Hello<br>there</div>"), "Hello\nthere");

const hershyRule = {
  id: "sender_hershy408_battery_supplier",
  active: true,
  ruleKind: "sender_customer",
  customerName: "My Battery Supplier LLC",
  match: {fromEmails: ["hershy408@gmail.com"]},
};
const senderFrom = senderRules.resolveQuoteSenderFrom(
    "Innovative Quotes <quotes@innovativecarriers.com>", cleaned);
const rule = senderRules.resolveSenderRule(senderFrom, [hershyRule]);
check("embedded From is hershy408",
    senderRules.extractSenderEmail(senderFrom), "hershy408@gmail.com");
check("sender rule assigns My Battery Supplier LLC",
    rule && rule.customerName, "My Battery Supplier LLC");

// Q#D2090: Outlook escaped the inner From, the first plain-text pass
// decoded it to <judy@corehome.com>, and the queue sanitizer used to
// treat that as an HTML tag and delete the address.
const d2090Escaped = [
  "<div>",
  "From: Innovative Quotes &lt;quotes@innovativecarriers.com&gt;<br>",
  "From: Judy Pena &lt;judy@corehome.com&gt;<br>",
  "Ship from STG",
  "</div>",
].join("");
const d2090Once = quoteMailQueue.sanitizeQueueEmailBody(d2090Escaped);
const d2090Twice = quoteMailQueue.sanitizeQueueEmailBody(d2090Once);
check("D2090 address survives queue sanitizer twice",
    d2090Twice.includes("Judy Pena <judy@corehome.com>"), true);
check("D2090 queue sanitizer still flattens real tags",
    !d2090Twice.includes("<div") && !d2090Twice.includes("<br"), true);

const d2090IntakeThenQueue = quoteMailQueue.sanitizeQueueEmailBody(
    intake.toPlainText(d2090Escaped));
const d2090IntakeThenQueueAgain = quoteMailQueue.sanitizeQueueEmailBody(
    d2090IntakeThenQueue);
check("D2090 address survives intake then queue twice",
    d2090IntakeThenQueueAgain.includes("Judy Pena <judy@corehome.com>"),
    true);

const quotesFrom = "Innovative Quotes <quotes@innovativecarriers.com>";
const d2090Sender = senderRules.resolveQuoteSenderFrom(
    quotesFrom, d2090Twice);
check("D2090 forwarded sender is Judy Pena",
    d2090Sender, "Judy Pena <judy@corehome.com>");
check("D2090 sender email is judy@corehome.com",
    senderRules.extractSenderEmail(d2090Sender), "judy@corehome.com");
check("D2090 sender is not the quotes mailbox",
    senderRules.extractSenderEmail(d2090Sender) ===
      "quotes@innovativecarriers.com", false);

check("mailto tag is still removed",
    quoteMailQueue.sanitizeQueueEmailBody(
        "Ping <mailto:judy@corehome.com> now"),
    "Ping now");
check("plain angle email is kept beside a real tag",
    quoteMailQueue.sanitizeQueueEmailBody(
        "<p>From: Judy Pena <judy@corehome.com></p>"),
    "From: Judy Pena <judy@corehome.com>");

if (failed) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
