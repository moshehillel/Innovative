/* eslint-disable no-console */
"use strict";

const quoteOutput = require("../quote-output");

let failures = 0;
const check = (name, got, exp) => {
  const pass = got === exp;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) {
    console.log(`  got: ${JSON.stringify(got)}`);
    console.log(`  exp: ${JSON.stringify(exp)}`);
  }
};

const checkIncludes = (name, hay, needle) => {
  const pass = String(hay).includes(needle);
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) {
    console.log(`  missing: ${JSON.stringify(needle)}`);
    console.log(`  in: ${JSON.stringify(hay)}`);
  }
};

const checkNotIncludes = (name, hay, needle) => {
  const pass = !String(hay).includes(needle);
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) {
    console.log(`  unexpectedly found: ${JSON.stringify(needle)}`);
  }
};

const msoJunk =
  `<p class=MsoNormal><font face="Calibri">Non-direct point.&nbsp;` +
  `Please double check charges.</font></p>`;

check(
    "strips MsoNormal / font / nbsp",
    quoteOutput.cleanCarrierNote(msoJunk),
    "Non-direct point. Please double check charges.",
);
check("empty after strip-only tags", quoteOutput.cleanCarrierNote(
    "<p class=MsoNormal>&nbsp;</p>"), "");
check("plain note unchanged", quoteOutput.cleanCarrierNote(
    "Liftgate required"), "Liftgate required");
check("array remarks joined+cleaned", quoteOutput.cleanCarrierNote([
  "<b>Fee</b>", "applies",
]), "Fee applies");

const email = quoteOutput.buildCustomerEmailFromSelections({
  batchQuoteId: "Q#D1234",
  lanes: [{
    laneKey: "1",
    selectedOptions: [{
      id: "r1",
      name: "Central Transport",
      sellRate: 245,
      customerPrice: 245,
      transitDays: 2,
      quoteNumber: "98765",
      warnings: msoJunk,
    }],
  }],
}, {style: "bullet"});

checkIncludes(
    "email has clean pricing bullet",
    email,
    "• $245 – 2-day transit (estimated) – Central Transport · Q# 98765",
);
checkIncludes(
    "email notes Central pickup delays",
    email,
    "• Central Transport: often has delays at pickup.",
);

const costOnlyEmail = quoteOutput.buildCustomerEmailFromSelections({
  batchQuoteId: "Q#D5555",
  shippingLocationName: "Acme Logistics",
  shippingLocationId: "4170250",
  lanes: [{
    selectedOptions: [{
      id: "r2",
      name: "Estes",
      total: 180.15,
      transitDays: 3,
      quoteNumber: "E9",
    }],
  }],
}, {style: "bullet"});
checkIncludes(
    "email ceils fractional cost to whole dollar",
    costOnlyEmail,
    "$181",
);
checkNotIncludes(
    "email omits Primus customer line",
    costOnlyEmail,
    "Customer:",
);
checkNotIncludes(
    "email omits Primus ID",
    costOnlyEmail,
    "Primus ID",
);
checkNotIncludes(
    "email excludes carrier note lines for non-advisory carriers",
    costOnlyEmail,
    "Notes:",
);
checkNotIncludes(
    "email excludes raw note content",
    email,
    "Non-direct point",
);
checkNotIncludes("email has no MsoNormal", email, "MsoNormal");
checkNotIncludes("email has no font tag", email, "<font");
checkNotIncludes("email has no &nbsp;", email, "&nbsp;");

const html = quoteOutput.textToEmailHtml(email);
checkNotIncludes("html body escapes angle brackets only from our text",
    html, "MsoNormal");
checkIncludes("html escapes bullet line", html, "Central Transport");

const emptyNoteEmail = quoteOutput.buildCustomerEmailFromSelections({
  batchQuoteId: "Q#D9999",
  lanes: [{
    selectedOptions: [{
      name: "Estes",
      sellRate: 100,
      transitDays: 3,
      quoteNumber: "E1",
      warnings: "<p class=MsoNormal>&nbsp;</p>",
    }],
    notesForCustomer: "Dispatcher-only enrichment note",
  }],
}, {style: "bullet"});
checkNotIncludes("skips Note: after strip for Estes", emptyNoteEmail, "Note:");
checkNotIncludes(
    "excludes notesForCustomer from email",
    emptyNoteEmail,
    "Dispatcher-only enrichment note",
);

const advisoryEmail = quoteOutput.buildCustomerEmailFromSelections({
  batchQuoteId: "Q#D7777",
  lanes: [{
    selectedOptions: [
      {name: "XPO Logistics", sellRate: 753.15, transitDays: 2, quoteNumber: "X1"},
      {name: "Saia LTL", sellRate: 754, transitDays: 3, quoteNumber: "S1"},
      {name: "Frontline Freight", sellRate: 800.01, transitDays: 4, quoteNumber: "F1"},
      {name: "AAA Cooper Transportation", sellRate: 900, transitDays: 2, quoteNumber: "A1"},
    ],
  }],
}, {style: "bullet"});
checkIncludes("ceils 753.15 to $754", advisoryEmail, "$754");
checkIncludes("keeps whole $754", advisoryEmail, "• $754 – 3-day");
checkIncludes("ceils 800.01 to $801", advisoryEmail, "$801");
checkIncludes(
    "groups XPO / Saia reclass note",
    advisoryEmail,
    "• XPO Logistics / Saia LTL: has a lot of reclass fees if the pallet info are not exact.",
);
checkIncludes(
    "Frontline consolidated note",
    advisoryEmail,
    "• Frontline Freight: moves consolidated — may have major delays in transit",
);
checkIncludes(
    "AAA Cooper pickup delay note",
    advisoryEmail,
    "• AAA Cooper Transportation: often has delays at pickup.",
);

const page = quoteOutput.serializeForDispatcherPage({
  id: "q1",
  lanes: [{
    laneKey: "1",
    options: [{
      id: "r1",
      name: "Estes",
      total: 90,
      sellRate: 100,
      warnings: msoJunk,
    }],
  }],
});
check(
    "UI serialize strips warnings",
    page.lanes[0].options[0].warnings,
    "Non-direct point. Please double check charges.",
);

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll assertions passed");
