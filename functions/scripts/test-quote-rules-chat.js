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

check("model is gpt-5.6-sol", chat.RULES_CHAT_MODEL, "gpt-5.6-sol");

check("can you add is not email-identify",
    chat.parseIdentifyChoiceAnswer(
        "can you add for militery fecileties also delivery appointment"),
    null);
check("short can is email", chat.parseIdentifyChoiceAnswer("can"), "email");
check("cannot-be button is address",
    chat.parseIdentifyChoiceAnswer(
        "Cannot be — address / site classification only"),
    "address_only");

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

  if (failures) {
    console.error(`FAILED ${failures}`);
    process.exit(1);
  }
  console.log("OK");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
