/**
 * Quote rules AI chatbot — separate from dashboardSupportChat.
 * Proposes rule CRUD; writes only via applyQuoteRuleProposal.
 */

"use strict";

const OpenAI = require("openai");
const {DEFAULT_OPENAI_MODEL} = require("./openai-models");
const {
  IDENTIFY_VIA_VALUES,
  DEFAULT_IDENTIFY_VIA,
} = require("./quote-accessorial-rules");

const DEFAULT_MODEL = DEFAULT_OPENAI_MODEL;

/**
 * @param {object} opts messages[], existingRules[].
 * @return {Promise<object>} {reply, action, proposal}
 */
async function runQuoteRulesChatTurn(opts) {
  const apiKey = process.env.QUOTE_RULES_CHAT_OPENAI_API_KEY ||
    process.env.SUPPORT_CHAT_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OpenAI API key not configured for quote rules chat");
  }

  const client = new OpenAI({apiKey});
  const model = process.env.QUOTE_RULES_CHAT_MODEL || DEFAULT_MODEL;
  const rulesJson = JSON.stringify(
      (opts.existingRules || []).slice(0, 40),
      null,
      0,
  ).slice(0, 8000);

  const systemPrompt = [
    "You help freight dispatchers manage LTL quote accessorial rules.",
    "Rules map site types or instructions to Primus accessorial codes.",
    "Common codes: LFO LFD (liftgate), APD (appointment dest),",
    "LAD (limited access), NUD (nursing home), HOD (hotel),",
    "RSD (residential), SCD (school), INS (insurance).",
    "",
    "Current active rules JSON:",
    rulesJson,
    "",
    "When user asks to add, change, or remove a rule, respond JSON only:",
    "{",
    "  \"reply\": \"friendly confirmation message for the user\",",
    "  \"action\": \"none\" | \"propose_create_rule\" |",
    "    \"propose_update_rule\" | \"propose_delete_rule\",",
    "  \"proposal\": null | {",
    "    \"ruleId\": \"snake_case_id\",",
    "    \"patch\": { rule fields for create/update },",
    "    \"deleteRuleId\": \"id for delete\"",
    "  }",
    "}",
    "",
    "Rule patch fields: active, priority, name, match, addAccessorials,",
    "filterCarrierWarnings, notes, autoApply, requiresConfirm, identifyVia.",
    "match may use: consigneeNameContains, consigneeAddressContains,",
    "instructionsContains, referenceContains, flags, siteType.",
    "",
    "identifyVia controls how the destination category is detected:",
    "  address_text — match only from email text (consignee name, address,",
    "    instructions, reference numbers, email-extracted siteType/flags).",
    "  ai — match only from AI address classification (enriched siteType,",
    "    residential flag from enrichment). Label this \"AI\" to users.",
    "  both — match if either text OR AI signals hit (default).",
    "",
    "When proposing a create or update rule, ask (or infer and confirm):",
    "\"Can this destination type be identified from address text in the email",
    "(consignee name, instructions, etc.), or only via AI address",
    "classification?\" Set identifyVia accordingly:",
    "  - Text-only triggers (e.g. liftgate in instructions) → address_text",
    "  - Name in email OR AI can classify (hotels, Amazon FC) → both",
    "  - Only AI/geocoding can tell (residential with no email hint) → ai",
    "",
    "Include identifyVia in every create/update proposal patch.",
    "",
    "Never claim you saved a rule — user must click Confirm first.",
    "If unclear, ask one short clarifying question with action none.",
  ].join("\n");

  const messages = [
    {role: "system", content: systemPrompt},
    ...(opts.messages || []).slice(-20).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 4000),
    })),
  ];

  const completion = await client.chat.completions.create({
    model,
    max_completion_tokens: 900,
    response_format: {type: "json_object"},
    messages,
  });

  const raw = String(
      completion.choices &&
      completion.choices[0] &&
      completion.choices[0].message &&
      completion.choices[0].message.content || "",
  ).trim();

  try {
    return JSON.parse(raw);
  } catch (_) {
    return {
      reply: raw || "I could not process that. Try rephrasing.",
      action: "none",
      proposal: null,
    };
  }
}

/**
 * Validates and normalizes a rule proposal before Firestore write.
 * @param {object} proposal From chatbot.
 * @return {object} {ok, error?, ruleId, patch}
 */
function validateRuleProposal(proposal) {
  if (!proposal || typeof proposal !== "object") {
    return {ok: false, error: "Empty proposal"};
  }
  const action = proposal.action || proposal.type;
  if (action === "propose_delete_rule") {
    const id = proposal.deleteRuleId ||
      (proposal.proposal && proposal.proposal.ruleId);
    if (!id) return {ok: false, error: "Missing rule id to delete"};
    return {ok: true, action: "delete", ruleId: String(id)};
  }
  const patch = proposal.patch ||
    (proposal.proposal && proposal.proposal.patch) || proposal;
  const ruleId = proposal.ruleId ||
    (proposal.proposal && proposal.proposal.ruleId) ||
    patch.id;
  if (!ruleId) return {ok: false, error: "Missing ruleId"};
  if (!patch.name && !patch.match) {
    return {ok: false, error: "Proposal needs name or match criteria"};
  }
  const normalized = {
    active: patch.active !== false,
    priority: Number(patch.priority) || 100,
    name: String(patch.name || ruleId),
    match: patch.match && typeof patch.match === "object" ?
      patch.match : {},
    addAccessorials: Array.isArray(patch.addAccessorials) ?
      patch.addAccessorials.map(String) : [],
    filterCarrierWarnings: Array.isArray(patch.filterCarrierWarnings) ?
      patch.filterCarrierWarnings.map(String) : [],
    notes: patch.notes ? String(patch.notes) : "",
    autoApply: patch.autoApply !== false,
    requiresConfirm: !!patch.requiresConfirm,
    identifyVia: IDENTIFY_VIA_VALUES.includes(patch.identifyVia) ?
      patch.identifyVia : DEFAULT_IDENTIFY_VIA,
  };
  if (Array.isArray(patch.addAccessorialsWithData)) {
    normalized.addAccessorialsWithData = patch.addAccessorialsWithData;
  }
  return {
    ok: true,
    action: "upsert",
    ruleId: String(ruleId),
    patch: normalized,
  };
}

module.exports = {
  runQuoteRulesChatTurn,
  validateRuleProposal,
};
