/* eslint-disable no-console */
"use strict";

const chat = require("../quote-rules-chat");

let failures = 0;
const check = (name, got, exp) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) {
    console.log(`  got: ${JSON.stringify(got)}`);
    console.log(`  exp: ${JSON.stringify(exp)}`);
  }
};

const checkTrue = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

check("model is gpt-5.6-luna", chat.RULES_CHAT_MODEL, "gpt-5.6-luna");

check("can you add is not email-identify",
    chat.parseIdentifyChoiceAnswer(
        "can you add for militery fecileties also delivery appointment"),
    null);
check("short can is email", chat.parseIdentifyChoiceAnswer("can"), "email");
check("cannot-be button is address",
    chat.parseIdentifyChoiceAnswer(
        "Cannot be — address / site classification only"),
    "address_only");

checkTrue("yeah that's it confirms",
    chat.parseNaturalConfirmation("yeah that's it", {pendingProposal: true}));
checkTrue("sounds good confirms",
    chat.parseNaturalConfirmation("sounds good", {pendingProposal: true}));
checkTrue("go ahead confirms",
    chat.parseNaturalConfirmation("go ahead", {pendingProposal: true}));
checkTrue("that's right confirms",
    chat.parseNaturalConfirmation("that's right", {pendingProposal: true}));
checkTrue("yep confirms",
    chat.parseNaturalConfirmation("yep", {pendingProposal: true}));
checkTrue("no wait rejects",
    chat.parseNaturalRejection("no wait"));
checkTrue("confirm without pending",
    chat.parseNaturalConfirmation("confirm"));
checkTrue("yes please is not reject",
    !chat.parseNaturalRejection("yes please"));
checkTrue("yes but only when is not confirm",
    !chat.parseNaturalConfirmation(
        "yes, but only when the customer is Brumis Imports Inc",
        {pendingProposal: true}));
checkTrue("for this rule is refinement",
    chat.looksLikeRuleRefinement(
        "for this rule, when pickup is La Mirada use zip 90670"));

const jaredLaMiradaMsg = [{
  role: "user",
  content: "When pickup is La Mirada and it comes from Jared berman, use zip 90670",
}];
const jaredZipOut = chat.buildZipFillProposal(jaredLaMiradaMsg, [
  {
    id: "sender_jared_berman",
    ruleKind: "sender_customer",
    customerName: "Brumis Imports Inc",
    fromNames: ["jared berman"],
    match: {fromEmails: ["jared.berman@corehome.com"]},
  },
]);
checkTrue("jared la mirada zip fill intent",
    chat.looksLikeZipFillIntent(jaredLaMiradaMsg));
checkTrue("jared la mirada includes sender email",
    jaredZipOut && jaredZipOut.proposal && jaredZipOut.proposal.patch &&
    jaredZipOut.proposal.patch.match &&
    Array.isArray(jaredZipOut.proposal.patch.match.fromEmails) &&
    jaredZipOut.proposal.patch.match.fromEmails
        .includes("jared.berman@corehome.com"));

const refineAfterApply = [
  {role: "user", content: "when pickup is La Mirada use zip 90670"},
  {role: "assistant", content: "Applied: saved \"zip_fill_la_mirada_origin\"."},
  {role: "assistant", content: "[APPLIED] Saved rule \"zip_fill_la_mirada_origin\" via Confirm (applyQuoteRule ok)."},
  {role: "user", content: "yes, but only when the customer is Brumis Imports Inc"},
];
const refineOut = chat.buildRuleRefinementProposal(refineAfterApply, [{
  id: "zip_fill_la_mirada_origin",
  ruleKind: "zip_fill",
  applyTo: "origin",
  fillZipCode: "90670",
  match: {shipperCityContains: ["la mirada"], shipperState: "CA"},
}]);
check("refine after apply action",
    refineOut && refineOut.action, "propose_update_rule");
check("refine after apply customer",
    refineOut && refineOut.proposal && refineOut.proposal.patch &&
    refineOut.proposal.patch.customerName, "Brumis Imports Inc");
checkTrue("refine not vague guess",
    refineOut && !/Do you mean you want a quote rule/i.test(refineOut.reply || ""));

checkTrue("resolveChatTurns accepts history alias",
    chat.resolveChatTurns({
      history: [{role: "user", content: "hello"}],
    }).length === 1);

checkTrue("delivery appointment → APD",
    chat.parseAccessorialsAnswer("also delivery appointment").includes("APD"));
checkTrue("appointment delivery → APD",
    chat.parseAccessorialsAnswer("appointment delivery").includes("APD"));

const aadd = [{
  role: "user",
  content: "aadd for militery also delivery appointment",
}];
checkTrue("aadd militery is create intent",
    chat.looksLikeCreateRuleIntent(aadd));
checkTrue("aadd militery is military accessorial",
    chat.looksLikeMilitaryAccessorialIntent(aadd));

const canYou = [{
  role: "user",
  content: "can you add for militery fecileties also delivery appointment",
}];
checkTrue("can you add militery is military accessorial",
    chat.looksLikeMilitaryAccessorialIntent(canYou));
check("can you add does not set email source",
    chat.detectCreateIdentifyGate(canYou).source, "address_only");

const plain = [{
  role: "user",
  content: "add appointment delivery for military facilities",
}];
const created = chat.buildMilitaryAccessorialProposal(plain, []);
check("create action", created && created.action, "propose_create_rule");
check("create rule id", created && created.proposal &&
    created.proposal.ruleId, "aafes_military");
const createCodes = created && created.proposal &&
    created.proposal.patch && created.proposal.patch.addAccessorials;
checkTrue("create has LAD", Array.isArray(createCodes) &&
    createCodes.includes("LAD"));
checkTrue("create has APD", Array.isArray(createCodes) &&
    createCodes.includes("APD"));
check("create identifyVia ai",
    created && created.proposal.patch.identifyVia, "ai");
checkTrue("create never says could not process",
    created && !/could not process/i.test(created.reply));

const live = [{
  id: "aafes_military",
  active: true,
  name: "Military bases — limited access",
  identifyVia: "ai",
  match: {siteType: "aafes_military"},
  addAccessorials: ["LAD"],
  autoApply: true,
  requiresConfirm: false,
  priority: 25,
}];
const updated = chat.buildMilitaryAccessorialProposal(plain, live);
check("update action", updated && updated.action, "propose_update_rule");
const updCodes = updated && updated.proposal &&
    updated.proposal.patch && updated.proposal.patch.addAccessorials;
checkTrue("update keeps LAD", Array.isArray(updCodes) &&
    updCodes.includes("LAD"));
checkTrue("update adds APD", Array.isArray(updCodes) &&
    updCodes.includes("APD"));

const followUp = [
  {role: "user", content: "add appointment delivery for military facilities"},
  {role: "assistant", content: "Got it — this can be spotted in the quote email. Please list all ways you think we can get that signal."},
  {role: "user", content: "i asked you something"},
];
checkTrue("i asked you something still military intent",
    chat.looksLikeMilitaryAccessorialIntent(followUp));
const followOut = chat.buildMilitaryAccessorialProposal(followUp, live);
checkTrue("follow-up proposes update not email-signals",
    followOut && followOut.action === "propose_update_rule");
checkTrue("follow-up not could not process",
    followOut && !/could not process/i.test(followOut.reply));

const mikeMsg = [{
  role: "user",
  content: "Map mike.oseback@ediexpressinc.com to customer name Mike Oseback. " +
    "Protocol only. Match that customer name and protocol to that email address.",
}];
checkTrue("mike oseback is sender intent",
    chat.looksLikeSenderCustomerIntent(mikeMsg));
const mikeOut = chat.buildSenderCustomerProposal(mikeMsg, []);
check("mike action create", mikeOut && mikeOut.action, "propose_create_rule");
check("mike rule id", mikeOut && mikeOut.proposal && mikeOut.proposal.ruleId,
    "sender_mike_oseback");
check("mike identifyVia email",
    mikeOut && mikeOut.proposal.patch.identifyVia, "email");
check("mike customerName",
    mikeOut && mikeOut.proposal.patch.customerName, "Mike Oseback");
checkTrue("mike protocolOnly",
    mikeOut && mikeOut.proposal.patch.protocolOnly === true);
checkTrue("mike has fromEmails",
    mikeOut &&
    Array.isArray(mikeOut.proposal.patch.match.fromEmails) &&
    mikeOut.proposal.patch.match.fromEmails
        .includes("mike.oseback@ediexpressinc.com"));
checkTrue("mike never asks LAD/APD",
    mikeOut && !/\b(LAD|APD|site type|accessorial)\b/i.test(mikeOut.reply));
checkTrue("mike never could not process",
    mikeOut && !/could not process/i.test(mikeOut.reply));

const mikeCcMsg = [{
  role: "user",
  content: "Also when mike.oseback@ediexpressinc.com is CC'd or on To, " +
    "map to Mike Oseback protocol only.",
}];
checkTrue("mike cc is sender intent",
    chat.looksLikeSenderCustomerIntent(mikeCcMsg));
const mikeCcOut = chat.buildSenderCustomerProposal(mikeCcMsg, [{
  id: "sender_mike_oseback",
  active: true,
  ruleKind: "sender_customer",
  identifyVia: "email",
  customerName: "Mike Oseback",
  protocolOnly: true,
  match: {fromEmails: ["mike.oseback@ediexpressinc.com"]},
}]);
check("mike cc action update",
    mikeCcOut && mikeCcOut.action, "propose_update_rule");
checkTrue("mike cc has ccEmails",
    mikeCcOut &&
    Array.isArray(mikeCcOut.proposal.patch.match.ccEmails) &&
    mikeCcOut.proposal.patch.match.ccEmails
        .includes("mike.oseback@ediexpressinc.com"));
checkTrue("mike cc has toEmails",
    mikeCcOut &&
    Array.isArray(mikeCcOut.proposal.patch.match.toEmails) &&
    mikeCcOut.proposal.patch.match.toEmails
        .includes("mike.oseback@ediexpressinc.com"));

const jaredMsg = [{
  role: "user",
  content: "Jared Berman Jared.Berman@corehome.com → Brumis Imports Inc, " +
    "default dims 40x48x62 when missing",
}];
checkTrue("jared is sender intent",
    chat.looksLikeSenderCustomerIntent(jaredMsg));
const jaredOut = chat.buildSenderCustomerProposal(jaredMsg, []);
check("jared customer",
    jaredOut && jaredOut.proposal.patch.customerName, "Brumis Imports Inc");
checkTrue("jared defaultDims 62",
    jaredOut && jaredOut.proposal.patch.defaultDims &&
    jaredOut.proposal.patch.defaultDims.height === 62);
checkTrue("jared from email",
    jaredOut &&
    jaredOut.proposal.patch.match.fromEmails
        .includes("jared.berman@corehome.com"));

const lifeworksMsg = [{
  role: "user",
  content: "Map lfwpicking@coreforce.com to Lifeworks Technology Group",
}];
const lifeworksOut = chat.buildSenderCustomerProposal(lifeworksMsg, []);
check("lifeworks customer",
    lifeworksOut && lifeworksOut.proposal.patch.customerName,
    "Lifeworks Technology Group");
checkTrue("lifeworks not protocolOnly",
    lifeworksOut && lifeworksOut.proposal.patch.protocolOnly === false);

const shayaMsg = [{
  role: "user",
  content: "Shaya Jacobowitz shaya@primepackaging.com → Prime Packaging Inc",
}];
const shayaOut = chat.buildSenderCustomerProposal(shayaMsg, []);
check("shaya customer",
    shayaOut && shayaOut.proposal.patch.customerName, "Prime Packaging Inc");
checkTrue("shaya from email",
    shayaOut &&
    shayaOut.proposal.patch.match.fromEmails
        .includes("shaya@primepackaging.com"));
checkTrue("shaya not protocolOnly",
    shayaOut && shayaOut.proposal.patch.protocolOnly === false);

const laMiradaMsg = [{
  role: "user",
  content: "when pickup is La Mirada use zip 90670",
}];
checkTrue("la mirada is zip fill intent",
    chat.looksLikeZipFillIntent(laMiradaMsg));
const laMiradaOut = chat.buildZipFillProposal(laMiradaMsg, []);
check("la mirada action create",
    laMiradaOut && laMiradaOut.action, "propose_create_rule");
check("la mirada fill zip",
    laMiradaOut && laMiradaOut.proposal.patch.fillZipCode, "90670");
check("la mirada apply origin",
    laMiradaOut && laMiradaOut.proposal.patch.applyTo, "origin");
checkTrue("la mirada shipper city",
    laMiradaOut &&
    laMiradaOut.proposal.patch.match.shipperCityContains
        .includes("la mirada"));
checkTrue("la mirada never asks identify",
    laMiradaOut && !/choose one|which accessorial|\bLAD\b|\bAPD\b/i
        .test(laMiradaOut.reply));

const mosesPhrases = [
  "mshglck@gmail.com should be registered as customer name moses",
  "mshglck@gmail.com mapped to moses customer name",
  "mshglck@gmail.com → moses",
  "map mshglck@gmail.com to moses",
];
for (const phrase of mosesPhrases) {
  const mosesMsg = [{role: "user", content: phrase}];
  checkTrue(`moses intent: ${phrase.slice(0, 40)}`,
      chat.looksLikeSenderCustomerIntent(mosesMsg));
  const mosesOut = chat.buildSenderCustomerProposal(mosesMsg, []);
  checkTrue(`moses propose: ${phrase.slice(0, 40)}`,
      mosesOut && mosesOut.action === "propose_create_rule" &&
      mosesOut.proposal && mosesOut.proposal.patch &&
      mosesOut.proposal.patch.customerName === "moses" &&
      mosesOut.proposal.patch.ruleKind === "sender_customer" &&
      mosesOut.proposal.patch.identifyVia === "email" &&
      Array.isArray(mosesOut.proposal.patch.match.fromEmails) &&
      mosesOut.proposal.patch.match.fromEmails
          .includes("mshglck@gmail.com") &&
      !/please include the From|could not process/i
          .test(mosesOut.reply || ""));
  if (!(mosesOut && mosesOut.action === "propose_create_rule")) {
    console.log("  phrase:", phrase);
    console.log("  out:", mosesOut);
  }
}

(async () => {
  const smokePhrases = [
    "add appointment delivery for military facilities",
    "aadd for militery also delivery appointment",
    "can you add for militery fecileties also delivery appointment",
  ];
  for (const phrase of smokePhrases) {
    const out = await chat.runQuoteRulesChatTurn({
      messages: [{role: "user", content: phrase}],
      existingRules: [],
    });
    const codes = out && out.proposal && out.proposal.patch &&
      out.proposal.patch.addAccessorials;
    const ok = out &&
      (out.action === "propose_create_rule" ||
        out.action === "propose_update_rule") &&
      Array.isArray(codes) && codes.includes("APD") &&
      codes.includes("LAD") &&
      !/could not process|list all ways/i.test(out.reply || "");
    checkTrue(`smoke: ${phrase}`, ok);
    if (!ok) {
      console.log("  action:", out && out.action);
      console.log("  reply:", out && out.reply);
      console.log("  codes:", codes);
    }
  }

  const senderSmoke = await chat.runQuoteRulesChatTurn({
    messages: mikeMsg,
    existingRules: [],
  });
  const senderOk = senderSmoke &&
    senderSmoke.action === "propose_create_rule" &&
    senderSmoke.proposal &&
    senderSmoke.proposal.patch &&
    senderSmoke.proposal.patch.customerName === "Mike Oseback" &&
    senderSmoke.proposal.patch.protocolOnly === true &&
    !/could not process|which accessorials|LAD|APD|site type/i
        .test(senderSmoke.reply || "");
  checkTrue("smoke: mike oseback sender mapping", senderOk);
  if (!senderOk) {
    console.log("  action:", senderSmoke && senderSmoke.action);
    console.log("  reply:", senderSmoke && senderSmoke.reply);
    console.log("  patch:", senderSmoke && senderSmoke.proposal &&
      senderSmoke.proposal.patch);
  }

  for (const phrase of mosesPhrases) {
    const mosesSmoke = await chat.runQuoteRulesChatTurn({
      messages: [{role: "user", content: phrase}],
      existingRules: [],
    });
    const mosesOk = mosesSmoke &&
      mosesSmoke.action === "propose_create_rule" &&
      mosesSmoke.proposal &&
      mosesSmoke.proposal.patch &&
      mosesSmoke.proposal.patch.customerName === "moses" &&
      mosesSmoke.proposal.patch.match &&
      Array.isArray(mosesSmoke.proposal.patch.match.fromEmails) &&
      mosesSmoke.proposal.patch.match.fromEmails
          .includes("mshglck@gmail.com") &&
      !/please include the From|could not process/i
          .test(mosesSmoke.reply || "");
    checkTrue(`smoke moses: ${phrase.slice(0, 48)}`, mosesOk);
    if (!mosesOk) {
      console.log("  phrase:", phrase);
      console.log("  action:", mosesSmoke && mosesSmoke.action);
      console.log("  reply:", mosesSmoke && mosesSmoke.reply);
    }
  }

  const laMiradaSmoke = await chat.runQuoteRulesChatTurn({
    messages: laMiradaMsg,
    existingRules: [],
  });
  const laMiradaOk = laMiradaSmoke &&
    laMiradaSmoke.action === "propose_create_rule" &&
    laMiradaSmoke.proposal &&
    laMiradaSmoke.proposal.patch &&
    laMiradaSmoke.proposal.patch.fillZipCode === "90670" &&
    laMiradaSmoke.proposal.patch.ruleKind === "zip_fill" &&
    !/choose one|could not process/i.test(laMiradaSmoke.reply || "");
  checkTrue("smoke: la mirada zip fill", laMiradaOk);
  if (!laMiradaOk) {
    console.log("  action:", laMiradaSmoke && laMiradaSmoke.action);
    console.log("  reply:", laMiradaSmoke && laMiradaSmoke.reply);
    console.log("  patch:", laMiradaSmoke && laMiradaSmoke.proposal &&
      laMiradaSmoke.proposal.patch);
  }

  if (failures) {
    console.error(`FAILED ${failures}`);
    process.exit(1);
  }
  console.log("OK");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
