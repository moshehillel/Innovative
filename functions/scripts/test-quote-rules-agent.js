/* eslint-disable no-console */
"use strict";

/**
 * Unit tests for quote-rules-agent working memory + tools (no live OpenAI).
 */

const agent = require("../quote-rules-agent");

let failures = 0;
const checkTrue = (name, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const existingRules = [
  {
    id: "aafes_military",
    name: "Military bases",
    active: true,
    match: {siteType: "aafes_military"},
    addAccessorials: ["LAD", "APD"],
  },
  {
    id: "sender_brumis",
    name: "Sender → Brumis",
    ruleKind: "sender_customer",
    customerName: "Brumis Imports Inc",
    match: {fromEmails: ["jared@corehome.com"]},
    addAccessorials: [],
  },
  {
    id: "zip_fill_la_mirada",
    name: "La Mirada pickup ZIP",
    ruleKind: "zip_fill",
    fillZipCode: "90670",
    applyTo: "origin",
    match: {shipperCityContains: ["la mirada"], shipperState: "CA"},
    addAccessorials: [],
  },
];

checkTrue("agent enabled by default", agent.isRulesChatAgentEnabled());

const mem = agent.normalizeAgentState({
  goal: "create",
  intentSummary: "when APD applied never also NTD",
  awaiting: "clarify_yes_no",
  openQuestion: "Do you mean APD vs NTD?",
  facts: {accessorials: ["APD"]},
});
checkTrue("normalize keeps goal+awaiting",
    mem.goal === "create" && mem.awaiting === "clarify_yes_no" &&
    mem.intentSummary.includes("APD") &&
    Array.isArray(mem.facts.accessorials));

const wm = agent.formatWorkingMemory(mem);
checkTrue("working memory mentions clarify_yes_no",
    /awaiting: clarify_yes_no/.test(wm) &&
    /Do NOT restart or say nothing is pending/.test(wm));

checkTrue("create-vs-refine guidance in memory",
    /no focusRuleId, treat as create/.test(wm));

const tools = agent.getToolDefinitions();
checkTrue("has draft_create_rule tool",
    tools.some((t) => t.function && t.function.name === "draft_create_rule"));
checkTrue("has ask_user tool",
    tools.some((t) => t.function && t.function.name === "ask_user"));
checkTrue("has set_working_memory tool",
    tools.some((t) => t.function &&
      t.function.name === "set_working_memory"));

const found = agent.searchRules(existingRules, "la mirada zip");
checkTrue("search finds la mirada zip",
    found.length === 1 && found[0].id === "zip_fill_la_mirada");

const ctx = {
  existingRules,
  state: agent.normalizeAgentState({}),
  outcome: null,
};

const ask = agent.executeTool("ask_user", {
  question: "Do you mean: when delivery appointment (APD) is applied, " +
    "never also apply notification (NTD)?",
  awaiting: "clarify_yes_no",
  intentSummary: "APD never with NTD",
  goal: "create",
}, ctx);
checkTrue("ask_user sets clarify awaiting",
    ask.ok && ctx.state.awaiting === "clarify_yes_no" &&
    ctx.state.goal === "create" &&
    ctx.outcome && ctx.outcome.action === "none" &&
    /NTD/.test(ctx.outcome.reply));

// Simulate UI: hasAgentContext would be true — "yes" must not be swallowed.
checkTrue("clarify state is agent context",
    !!(ctx.state.goal || ctx.state.awaiting || ctx.state.intentSummary));

const catalog = agent.executeTool("get_accessorial_catalog", {}, ctx);
checkTrue("catalog includes NTD notification",
    catalog.ok &&
    catalog.catalog.some((c) => c.code === "NTD" &&
      /notification/i.test(c.label)));

const mutex = agent.collectRemoveAccessorials({
  removeAccessorials: ["NTD"],
  suppressAccessorials: ["ntd", "LAD"],
});
checkTrue("collectRemoveAccessorials merges aliases",
    mutex.includes("NTD") && mutex.includes("LAD") && mutex.length === 2);

const suppressDraft = agent.executeTool("draft_create_rule", {
  ruleId: "apd_no_ntd",
  name: "APD without notification",
  match: {
    flags: ["appointmentRequired"],
    instructionsContains: ["appointment", "delivery appointment"],
  },
  addAccessorials: ["APD"],
  removeAccessorials: ["NTD"],
  identifyVia: "both",
  reply: "When Appointment delivery applies, I'll also turn off " +
    "Notification. Confirm?",
}, ctx);
checkTrue("draft with removeAccessorials proposes create",
    suppressDraft && suppressDraft.ok &&
    ctx.outcome && ctx.outcome.action === "propose_create_rule");
checkTrue("draft patch includes removeAccessorials NTD",
    ctx.state.draft &&
    Array.isArray(ctx.state.draft.patch.removeAccessorials) &&
    ctx.state.draft.patch.removeAccessorials.includes("NTD") &&
    ctx.state.draft.patch.addAccessorials.includes("APD"));
checkTrue("draft reply stays plain English",
    /Appointment delivery/i.test(ctx.outcome.reply || "") &&
    /Notification/i.test(ctx.outcome.reply || "") &&
    !/schema|unsupported|mutual exclusion|runtime/i
        .test(ctx.outcome.reply || ""));

// Legacy suppressAccessorials alias still drafts a real remove rule.
const legacyCtx = {
  existingRules,
  state: agent.normalizeAgentState({}),
  outcome: null,
};
const legacyDraft = agent.executeTool("draft_create_rule", {
  ruleId: "legacy_suppress_ntd",
  name: "No notification with appointment",
  match: {flags: ["appointmentRequired"]},
  addAccessorials: ["APD"],
  suppressAccessorials: ["NTD"],
  identifyVia: "ai",
}, legacyCtx);
checkTrue("legacy suppressAccessorials maps to removeAccessorials",
    legacyDraft.ok &&
    legacyCtx.state.draft.patch.removeAccessorials.includes("NTD"));

const createCtx = {
  existingRules,
  state: agent.normalizeAgentState({
    goal: "create",
    awaiting: "clarify_yes_no",
    intentSummary: "map sender to customer",
  }),
  outcome: null,
};
const createOut = agent.executeTool("draft_create_rule", {
  ruleId: "sender_moses",
  name: "Sender → moses",
  ruleKind: "sender_customer",
  match: {fromEmails: ["mshglck@gmail.com"]},
  customerName: "moses",
  identifyVia: "email",
  reply: "I'll map mshglck@gmail.com to moses. Confirm?",
}, createCtx);
checkTrue("draft_create sender_customer ok",
    createOut.ok &&
    createCtx.outcome &&
    createCtx.outcome.action === "propose_create_rule" &&
    createCtx.state.awaiting === "confirm_proposal" &&
    createCtx.state.draft &&
    createCtx.state.draft.patch.ruleKind === "sender_customer" &&
    createCtx.state.draft.patch.customerName === "moses");

const zipCtx = {
  existingRules,
  state: agent.normalizeAgentState({}),
  outcome: null,
};
const zipOut = agent.executeTool("draft_create_rule", {
  ruleId: "zip_fill_uxbridge",
  name: "Uxbridge pickup → ZIP 01569",
  ruleKind: "zip_fill",
  match: {shipperCityContains: ["uxbridge"], shipperState: "MA"},
  fillZipCode: "01569",
  applyTo: "origin",
}, zipCtx);
checkTrue("draft_create zip_fill ok",
    zipOut.ok &&
    zipCtx.outcome.action === "propose_create_rule" &&
    zipCtx.state.draft.patch.fillZipCode === "01569" &&
    zipCtx.state.draft.patch.ruleKind === "zip_fill");

// No focus rule + "this rule when delivery appt" → create path via tool,
// not "which rule should I update".
const noFocus = agent.normalizeAgentState({
  goal: null,
  focusRuleId: null,
  awaiting: null,
});
checkTrue("no focusRuleId means create-friendly state",
    !noFocus.focusRuleId && !noFocus.draft);

const accCtx = {
  existingRules,
  state: agent.normalizeAgentState({
    goal: "create",
    intentSummary: "when delivery appt applied never apply notification",
    awaiting: "clarify_yes_no",
  }),
  outcome: null,
};
const accOut = agent.executeTool("draft_create_rule", {
  ruleId: "delivery_appt_apd",
  name: "Delivery appointment → APD, no NTD",
  match: {flags: ["appointmentRequired"]},
  addAccessorials: ["APD"],
  removeAccessorials: ["NTD"],
  identifyVia: "ai",
  reply: "I'll add Appointment delivery and turn off Notification " +
    "for those quotes. Confirm?",
}, accCtx);
checkTrue("delivery-appt create without focus rule",
    accOut.ok &&
    accCtx.outcome.action === "propose_create_rule" &&
    Array.isArray(accCtx.state.draft.patch.addAccessorials) &&
    accCtx.state.draft.patch.addAccessorials.includes("APD") &&
    accCtx.state.draft.patch.removeAccessorials.includes("NTD"));

const delCtx = {
  existingRules,
  state: agent.normalizeAgentState({focusRuleId: "aafes_military"}),
  outcome: null,
};
const delOut = agent.executeTool("draft_delete_rule", {
  ruleId: "aafes_military",
}, delCtx);
checkTrue("draft_delete ok",
    delOut.ok && delCtx.outcome.action === "propose_delete_rule");

const clearOut = agent.executeTool("clear_draft", {}, delCtx);
checkTrue("clear_draft dismisses",
    clearOut.ok && delCtx.outcome.action === "dismiss_pending" &&
    delCtx.state.draft === null);

const updateCtx = {
  existingRules,
  state: agent.normalizeAgentState({focusRuleId: "aafes_military"}),
  outcome: null,
};
const updOut = agent.executeTool("draft_update_rule", {
  ruleId: "aafes_military",
  patch: {addAccessorials: ["LAD", "APD"], notes: "Keep APD+LAD"},
}, updateCtx);
checkTrue("draft_update existing rule",
    updOut.ok && updateCtx.outcome.action === "propose_update_rule");

const missingUpdate = agent.executeTool("draft_update_rule", {
  ruleId: "does_not_exist_xyz",
  patch: {addAccessorials: ["APD"]},
}, {
  existingRules,
  state: agent.normalizeAgentState({}),
  outcome: null,
});
checkTrue("update unknown rule fails toward create",
    !missingUpdate.ok && /draft_create_rule/i.test(missingUpdate.error || ""));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll quote-rules-agent checks passed.");
