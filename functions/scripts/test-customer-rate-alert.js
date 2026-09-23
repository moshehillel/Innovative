/* Children's Apparel rate-entry recipient. No Firebase.
 * Run: node scripts/test-customer-rate-alert.js */
const alert = require("../customer-rate-alert");

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${actual}` +
    (ok ? "" : ` (expected ${expected})`));
};

const dispatcher = "dispatcher@innovativecarriers.com";
const lisa = "Lisa@innovativecarriers.com";
const sarah = alert.SARAH_EMAIL;

check("sarah address", sarah, "Sarah@innovativecarriers.com");

const names = [
  "Children's Apparel",
  "children's apparel",
  "CHILDRENS APPAREL",
  "Childrens Apparel",
  "Children Apparel",
  "The Children's Apparel Co",
  "CHILDREN'S APPAREL INC.",
  "Children\u2019s Apparel",
  "childrensapparel",
];
for (const name of names) {
  const routed = alert.resolveCustomerRateAlertRecipient({
    customerName: name,
    dispatcherOk: true,
    dispatcherEmail: dispatcher,
    fallbackEmail: lisa,
  });
  check(`${name} -> sarah`, routed.to, sarah);
  check(`${name} route`, routed.routedTo, "sarah");
}

const other = alert.resolveCustomerRateAlertRecipient({
  customerName: "Acme Logistics",
  dispatcherOk: true,
  dispatcherEmail: dispatcher,
  fallbackEmail: lisa,
});
check("other customer stays dispatcher", other.to, dispatcher);
check("other customer route", other.routedTo, "dispatcher");

const childrenOnly = alert.resolveCustomerRateAlertRecipient({
  customerName: "Children's Hospital",
  dispatcherOk: true,
  dispatcherEmail: dispatcher,
  fallbackEmail: lisa,
});
check("children without apparel stays dispatcher",
    childrenOnly.to, dispatcher);

const apparelOnly = alert.resolveCustomerRateAlertRecipient({
  customerName: "Apparel Warehouse",
  dispatcherOk: true,
  dispatcherEmail: dispatcher,
  fallbackEmail: lisa,
});
check("apparel without children stays dispatcher",
    apparelOnly.to, dispatcher);

const unknown = alert.resolveCustomerRateAlertRecipient({
  customerName: "",
  dispatcherOk: false,
  dispatcherEmail: "",
  fallbackEmail: lisa,
});
check("unknown dispatcher falls back to lisa", unknown.to, lisa);
check("unknown dispatcher route", unknown.routedTo, "fallback");

const apparelNoDispatcher = alert.resolveCustomerRateAlertRecipient({
  customerName: "Children's Apparel",
  dispatcherOk: false,
  dispatcherEmail: "",
  fallbackEmail: lisa,
});
check("apparel still sarah when dispatcher missing",
    apparelNoDispatcher.to, sarah);
check("apparel missing dispatcher route",
    apparelNoDispatcher.routedTo, "sarah");

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nAll customer rate alert recipient checks passed.");
