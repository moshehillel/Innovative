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

const PATCH_FIELDS = [
  "active",
  "priority",
  "name",
  "match",
  "addAccessorials",
  "filterCarrierWarnings",
  "notes",
  "autoApply",
  "requiresConfirm",
  "identifyVia",
  "addAccessorialsWithData",
];

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
    "For propose_update_rule:",
    "  - proposal.ruleId MUST be the existing rule id (e.g. amazon_fc).",
    "  - patch may be partial (only changed fields), e.g. addAccessorials.",
    "  - Always copy name and match from the current rule into patch",
    "    so the proposal is self-contained even for partial edits.",
    "For propose_create_rule: patch MUST include name and match.",
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
 * Extract the rule field patch from a chatbot / apply payload.
 * @param {object} proposal Envelope from UI or model.
 * @return {object}
 */
function extractPatch(proposal) {
  if (proposal.patch && typeof proposal.patch === "object") {
    return proposal.patch;
  }
  if (proposal.proposal && proposal.proposal.patch &&
      typeof proposal.proposal.patch === "object") {
    return proposal.proposal.patch;
  }
  // Flat proposal body: copy only known rule fields.
  const out = {};
  for (const key of PATCH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(proposal, key)) {
      out[key] = proposal[key];
    }
  }
  return out;
}

/**
 * @param {object} patch Incoming patch fields.
 * @return {boolean}
 */
function hasNameOrMatch(patch) {
  if (patch.name) return true;
  if (patch.match && typeof patch.match === "object" &&
      Object.keys(patch.match).length > 0) {
    return true;
  }
  return false;
}

/**
 * @param {object} patch Incoming patch fields.
 * @return {boolean}
 */
function hasUpdatableFields(patch) {
  return PATCH_FIELDS.some((key) =>
    Object.prototype.hasOwnProperty.call(patch, key));
}

/**
 * Normalize only fields explicitly present (partial update safe).
 * @param {object} patch Incoming.
 * @return {object}
 */
function normalizePartialPatch(patch) {
  const normalized = {};
  if (Object.prototype.hasOwnProperty.call(patch, "active")) {
    normalized.active = patch.active !== false;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "priority")) {
    normalized.priority = Number(patch.priority) || 100;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "name")) {
    normalized.name = String(patch.name || "");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "match") &&
      patch.match && typeof patch.match === "object") {
    normalized.match = patch.match;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "addAccessorials") &&
      Array.isArray(patch.addAccessorials)) {
    normalized.addAccessorials = patch.addAccessorials.map(String);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "filterCarrierWarnings") &&
      Array.isArray(patch.filterCarrierWarnings)) {
    normalized.filterCarrierWarnings =
      patch.filterCarrierWarnings.map(String);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "notes")) {
    normalized.notes = patch.notes ? String(patch.notes) : "";
  }
  if (Object.prototype.hasOwnProperty.call(patch, "autoApply")) {
    normalized.autoApply = patch.autoApply !== false;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "requiresConfirm")) {
    normalized.requiresConfirm = !!patch.requiresConfirm;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "identifyVia")) {
    normalized.identifyVia = IDENTIFY_VIA_VALUES.includes(patch.identifyVia) ?
      patch.identifyVia : DEFAULT_IDENTIFY_VIA;
  }
  if (Array.isArray(patch.addAccessorialsWithData)) {
    normalized.addAccessorialsWithData = patch.addAccessorialsWithData;
  }
  return normalized;
}

/**
 * Full create-style normalization with defaults.
 * @param {object} patch Incoming.
 * @param {string} ruleId Rule id fallback for name.
 * @return {object}
 */
function normalizeCreatePatch(patch, ruleId) {
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
  return normalized;
}

/**
 * Validates and normalizes a rule proposal before Firestore write.
 * Update proposals may be partial (e.g. only addAccessorials).
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
      (proposal.proposal && proposal.proposal.ruleId) ||
      proposal.ruleId;
    if (!id) return {ok: false, error: "Missing rule id to delete"};
    return {ok: true, action: "delete", ruleId: String(id)};
  }

  const patch = extractPatch(proposal);
  const ruleId = proposal.ruleId ||
    (proposal.proposal && proposal.proposal.ruleId) ||
    patch.id;
  if (!ruleId) return {ok: false, error: "Missing ruleId"};

  const isUpdate = action === "propose_update_rule";
  const isCreate = action === "propose_create_rule";

  if (isCreate && !hasNameOrMatch(patch)) {
    return {ok: false, error: "Proposal needs name or match criteria"};
  }
  if (isUpdate && !hasUpdatableFields(patch)) {
    return {ok: false, error: "Proposal needs fields to update"};
  }
  // Ambiguous / legacy payloads: allow partial field-only updates
  // (fixes chat updates that omit name/match).
  if (!isCreate && !isUpdate) {
    if (!hasNameOrMatch(patch) && !hasUpdatableFields(patch)) {
      return {ok: false, error: "Proposal needs name or match criteria"};
    }
  }

  const usePartial = isUpdate || (!isCreate && !hasNameOrMatch(patch));
  const normalized = usePartial ?
    normalizePartialPatch(patch) :
    normalizeCreatePatch(patch, ruleId);

  if (!Object.keys(normalized).length) {
    return {ok: false, error: "Proposal needs name or match criteria"};
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
  extractPatch,
};
