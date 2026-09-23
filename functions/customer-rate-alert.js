/**
 * Who receives Jerry's "enter the customer rate" alert.
 * Children's Apparel goes to Sarah; every other customer stays on the
 * load dispatcher (Lisa when that email cannot be resolved).
 */

"use strict";

const {SARAH_EMAIL} = require("./pod-followup");

/**
 * Case-insensitive match for Children's Apparel and close spellings
 * (Childrens Apparel, Children Apparel, with or without an apostrophe).
 * @param {string} name Customer display name.
 * @return {boolean}
 */
function isChildrensApparelCustomer(name) {
  const normalized = String(name || "")
      .toLowerCase()
      .replace(/[\u2018\u2019\u02bc`´']/g, "");
  return /childrens?\s*apparel/.test(normalized);
}

/**
 * @param {object} opts Routing inputs.
 * @param {string} [opts.customerName] Bill-to / customer name.
 * @param {boolean} [opts.dispatcherOk] Dispatcher email was resolved.
 * @param {string} [opts.dispatcherEmail] Dispatcher address.
 * @param {string} [opts.fallbackEmail] Used when the dispatcher is unknown.
 * @return {{to: string, routedTo: string}}
 */
function resolveCustomerRateAlertRecipient(opts) {
  const customerName = opts && opts.customerName;
  const dispatcherOk = Boolean(opts && opts.dispatcherOk);
  const dispatcherEmail = opts && opts.dispatcherEmail ?
    String(opts.dispatcherEmail).trim() : "";
  const fallbackEmail = String((opts && opts.fallbackEmail) || "").trim();
  if (isChildrensApparelCustomer(customerName)) {
    return {to: SARAH_EMAIL, routedTo: "sarah"};
  }
  if (dispatcherOk && dispatcherEmail) {
    return {to: dispatcherEmail, routedTo: "dispatcher"};
  }
  return {to: fallbackEmail, routedTo: "fallback"};
}

module.exports = {
  SARAH_EMAIL,
  isChildrensApparelCustomer,
  resolveCustomerRateAlertRecipient,
};
