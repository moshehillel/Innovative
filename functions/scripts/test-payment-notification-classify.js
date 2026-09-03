#!/usr/bin/env node
/**
 * Unit smoke for payment-notification-classify wiring (no live API).
 */
"use strict";

const path = require("path");
const assert = require("assert");

const mod = require("../payment-notification-classify");
const adm = require("../administrative-email-intake");

assert.strictEqual(mod.DEFAULT_PAYMENT_NOTIFICATION_MODEL, "gpt-4o");
assert.ok(mod.PAYMENT_NOTIFICATION_INTENTS.has("bank_payment_alert"));
assert.ok(mod.PAYMENT_NOTIFICATION_INTENTS.has("freight_invoice"));
assert.ok(mod.aiSaysQuietIgnoreBankAlert({intent: "bank_payment_alert"}));
assert.ok(!mod.aiSaysQuietIgnoreBankAlert({intent: "freight_invoice"}));
assert.ok(!mod.aiSaysQuietIgnoreBankAlert({intent: "other"}));

const chbSubject =
  "RE: Invoice-0003138, CR#: 266272 RE: BOL# 266272";
const chbFrom = "Isreal Rosenfeld <ir@innovativechb.com>";
const chbBody =
  "Please see attached customs docs.\n\n" +
  "On Tue, Sep 2, 2026 Abe <abe@innovativecarriers.com> wrote:\n" +
  "PLEASE NOTE OUR NEW BANKING INFORMATION\n" +
  "Quickpay/Zelle\naccounting@innovativecarriers.com\n";

assert.ok(!adm.shouldIgnoreAsPaymentNotification(
    chbSubject, chbFrom, chbBody, []));
assert.ok(!adm.isAmbiguousPaymentNotificationCandidate(
    chbSubject, chbFrom, chbBody, []));
assert.ok(adm.shouldIgnoreAsPaymentNotification(
    "Goldengate Logistics Llc sent you $36.00",
    "Bank of America <customerservice@ealerts.bankofamerica.com>",
    "You received a Zelle payment of $500",
    []));

console.log("payment-notification-classify smoke OK");
console.log("default model:", mod.DEFAULT_PAYMENT_NOTIFICATION_MODEL);
console.log("corpus:", path.basename(
    path.join(__dirname, "_bench-payment-notification-corpus.json")));
