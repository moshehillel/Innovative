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

  if (failures) {
    console.error(`FAILED ${failures}`);
    process.exit(1);
  }
  console.log("OK");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
