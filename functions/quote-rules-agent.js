/**
 * Quote rules chat agent — OpenAI tool loop with structured working memory.
 * Writes still go through Confirm → applyQuoteRule (never from tools).
 */

"use strict";

const OpenAI = require("openai");
const {
  ACCESSORIAL_LABELS,
  RULE_KIND_SENDER_CUSTOMER,
  RULE_KIND_ZIP_FILL,
} = require("./quote-accessorial-rules");
const chat = require("./quote-rules-chat");

const RULES_AGENT_MODEL = process.env.QUOTE_RULES_CHAT_MODEL || "gpt-5.6-luna";
const RULES_AGENT_MAX_TURNS = 50;
const RULES_AGENT_MAX_TOOL_ROUNDS = 6;

const GOALS = new Set(["create", "update", "delete", "clarify", null]);
const AWAITING = new Set([
  "clarify_yes_no",
  "missing_field",
  "confirm_proposal",
  null,
]);

/**
 * @return {boolean} Whether the tool-agent path is enabled.
 */
function isRulesChatAgentEnabled() {
  const v = String(process.env.QUOTE_RULES_CHAT_AGENT || "1").trim()
      .toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

/**
 * Normalize agent working memory from the client / previous turn.
 * @param {object|null|undefined} raw Incoming state.
 * @return {object}
 */
function normalizeAgentState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const goal = GOALS.has(src.goal) ? src.goal :
    (src.goal == null || src.goal === "" ? null : null);
  const awaiting = AWAITING.has(src.awaiting) ? src.awaiting :
    (src.awaiting == null || src.awaiting === "" ? null : null);
  const facts = src.facts && typeof src.facts === "object" ?
    {...src.facts} : {};
  if (!Array.isArray(facts.accessorials)) facts.accessorials = [];
  if (!Array.isArray(facts.matchHints)) facts.matchHints = [];
  if (!Object.prototype.hasOwnProperty.call(facts, "ruleKind")) {
    facts.ruleKind = null;
  }
  let draft = null;
  if (src.draft && typeof src.draft === "object") {
    draft = {
      action: src.draft.action || null,
      ruleId: src.draft.ruleId || src.draft.deleteRuleId || null,
      deleteRuleId: src.draft.deleteRuleId || src.draft.ruleId || null,
      deleteRuleIds: Array.isArray(src.draft.deleteRuleIds) ?
        src.draft.deleteRuleIds.map(String) : undefined,
      patch: src.draft.patch && typeof src.draft.patch === "object" ?
        src.draft.patch : {},
    };
  }
  return {
    goal: goal || null,
    intentSummary: src.intentSummary ? String(src.intentSummary).slice(0, 500) :
      null,
    openQuestion: src.openQuestion ? String(src.openQuestion).slice(0, 500) :
      null,
    awaiting: awaiting || null,
    draft,
    focusRuleId: src.focusRuleId ? String(src.focusRuleId) : null,
    facts,
  };
}

/**
 * Compact WORKING MEMORY block for the system prompt.
 * @param {object} state Agent state.
 * @return {string}
 */
function formatWorkingMemory(state) {
  const s = normalizeAgentState(state);
  const draftLine = s.draft ?
    JSON.stringify({
      action: s.draft.action,
      ruleId: s.draft.ruleId,
      patchKeys: Object.keys(s.draft.patch || {}),
    }) :
    "null";
  return [
    "=== WORKING MEMORY (authoritative across turns) ===",
    `goal: ${s.goal || "null"}`,
    `intentSummary: ${s.intentSummary || "null"}`,
    `openQuestion: ${s.openQuestion || "null"}`,
    `awaiting: ${s.awaiting || "null"}`,
    `focusRuleId: ${s.focusRuleId || "null"}`,
    `facts: ${JSON.stringify(s.facts)}`,
    `draft: ${draftLine}`,
    "If awaiting=clarify_yes_no and user says yes/yep/ok → continue the",
    "intent (draft a proposal). Do NOT restart or say nothing is pending.",
    "If awaiting=confirm_proposal and user affirms → keep the draft;",
    "the UI applies Confirm. Never claim you saved a rule.",
    "If user starts a new rule with no focusRuleId, treat as create —",
    "not an update of an unknown rule.",
  ].join("\n");
}

/**
 * OpenAI tool schemas for the rules agent.
 * @return {Array<object>}
 */
function getToolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "list_rules",
        description: "List active quote rules (id, name, kind, accessorials).",
        parameters: {
          type: "object",
          properties: {
            limit: {type: "integer", description: "Max rules (default 40)"},
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_rules",
        description:
          "Search live rules by name, site, email, ZIP, accessorial.",
        parameters: {
          type: "object",
          properties: {
            query: {type: "string"},
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_rule",
        description: "Get one live rule by id.",
        parameters: {
          type: "object",
          properties: {
            ruleId: {type: "string"},
          },
          required: ["ruleId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_accessorial_catalog",
        description: "Primus accessorial codes and labels (APD, NTD, LAD…).",
        parameters: {type: "object", properties: {}},
      },
    },
    {
      type: "function",
      function: {
        name: "set_working_memory",
        description:
          "Update goal, intent, open question, awaiting, facts, focus.",
        parameters: {
          type: "object",
          properties: {
            goal: {
              type: "string",
              enum: ["create", "update", "delete", "clarify"],
            },
            intentSummary: {type: "string"},
            openQuestion: {type: "string"},
            awaiting: {
              type: "string",
              enum: [
                "clarify_yes_no",
                "missing_field",
                "confirm_proposal",
                "none",
              ],
            },
            focusRuleId: {type: "string"},
            facts: {type: "object"},
            clearOpenQuestion: {type: "boolean"},
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "draft_create_rule",
        description:
          "Build a create proposal for Confirm. ruleKind: accessorial " +
          "(omit), sender_customer, or zip_fill.",
        parameters: {
          type: "object",
          properties: {
            ruleId: {type: "string"},
            name: {type: "string"},
            ruleKind: {
              type: "string",
              enum: ["accessorial", "sender_customer", "zip_fill"],
            },
            match: {type: "object"},
            addAccessorials: {
              type: "array",
              items: {type: "string"},
            },
            identifyVia: {
              type: "string",
              enum: ["email", "address_text", "ai", "both"],
            },
            customerName: {type: "string"},
            protocolOnly: {type: "boolean"},
            defaultDims: {type: "object"},
            fillZipCode: {type: "string"},
            applyTo: {type: "string", enum: ["origin", "dest", "both"]},
            notes: {type: "string"},
            priority: {type: "integer"},
            suppressAccessorials: {
              type: "array",
              items: {type: "string"},
              description:
                "Codes that must never be applied with this rule " +
                "(e.g. NTD when APD). Schema has no mutual-exclusion " +
                "field — tool may return unsupported.",
            },
            reply: {type: "string"},
          },
          required: ["ruleId", "name", "match"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "draft_update_rule",
        description: "Build an update proposal for an existing rule id.",
        parameters: {
          type: "object",
          properties: {
            ruleId: {type: "string"},
            patch: {type: "object"},
            reply: {type: "string"},
          },
          required: ["ruleId", "patch"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "draft_delete_rule",
        description: "Build a delete proposal for Confirm.",
        parameters: {
          type: "object",
          properties: {
            ruleId: {type: "string"},
            ruleIds: {type: "array", items: {type: "string"}},
            reply: {type: "string"},
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "clear_draft",
        description: "Drop the pending draft after user rejects it.",
        parameters: {
          type: "object",
          properties: {
            reason: {type: "string"},
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ask_user",
        description:
          "Ask ONE clarifying question. Sets awaiting=clarify_yes_no or " +
          "missing_field.",
        parameters: {
          type: "object",
          properties: {
            question: {type: "string"},
            awaiting: {
              type: "string",
              enum: ["clarify_yes_no", "missing_field"],
            },
            intentSummary: {type: "string"},
            goal: {
              type: "string",
              enum: ["create", "update", "delete", "clarify"],
            },
          },
          required: ["question"],
        },
      },
    },
  ];
}

/**
 * Summarize a rule for list/search results.
 * @param {object} rule Live rule.
 * @return {object}
 */
function summarizeRule(rule) {
  return {
    id: rule.id,
    name: rule.name || rule.id,
    ruleKind: rule.ruleKind || "accessorial",
    active: rule.active !== false,
    addAccessorials: rule.addAccessorials || [],
    customerName: rule.customerName || null,
    fillZipCode: rule.fillZipCode || null,
    applyTo: rule.applyTo || null,
    match: rule.match || {},
    notes: rule.notes ? String(rule.notes).slice(0, 160) : "",
  };
}

/**
 * @param {Array<object>} existingRules Live rules.
 * @param {string} query Search text.
 * @return {Array<object>}
 */
function searchRules(existingRules, query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return (existingRules || []).slice(0, 20).map(summarizeRule);
  const tokens = q.split(/\s+/).filter(Boolean);
  return (existingRules || []).filter((r) => {
    const blob = [
      r.id, r.name, r.ruleKind, r.customerName, r.fillZipCode, r.notes,
      JSON.stringify(r.match || {}),
      (r.addAccessorials || []).join(" "),
    ].join(" ").toLowerCase();
    return tokens.every((t) => blob.includes(t));
  }).slice(0, 25).map(summarizeRule);
}

/**
 * Detect unsupported mutual-exclusion requests.
 * @param {Array<string>} add Codes to add.
 * @param {Array<string>} suppress Codes to never apply together.
 * @return {object|null} unsupported payload or null.
 */
function checkMutualExclusion(add, suppress) {
  const suppressList = (suppress || [])
      .map((c) => String(c || "").toUpperCase())
      .filter(Boolean);
  if (!suppressList.length) return null;
  const addSet = new Set((add || []).map((c) => String(c || "").toUpperCase()));
  // Runtime engine only ADDS accessorials — cannot suppress siblings.
  return {
    ok: false,
    unsupported: true,
    error:
      "Quote rules cannot enforce mutual exclusion at rating time " +
      "(no suppressAccessorials field). Known code NTD = Notification " +
      "delivery. Options: (1) remove NTD from any rule that also adds APD, " +
      "(2) put the policy in notes + requiresConfirm, (3) ask ops for a " +
      "schema change. Do not invent a fake suppress field.",
    suppressAccessorials: suppressList,
    addAccessorials: [...addSet],
  };
}

/**
 * Execute one tool call; mutates ctx.state / ctx.outcome.
 * @param {string} name Tool name.
 * @param {object} args Parsed args.
 * @param {object} ctx {existingRules, state, outcome}.
 * @return {object} JSON-serializable tool result.
 */
function executeTool(name, args, ctx) {
  const existingRules = ctx.existingRules || [];
  const state = ctx.state;

  switch (name) {
    case "list_rules": {
      const limit = Math.min(Number(args.limit) || 40, 60);
      return {
        ok: true,
        rules: existingRules.slice(0, limit).map(summarizeRule),
        total: existingRules.length,
      };
    }
    case "search_rules":
      return {ok: true, rules: searchRules(existingRules, args.query)};
    case "get_rule": {
      const id = String(args.ruleId || "").trim();
      const rule = existingRules.find((r) => String(r.id) === id);
      if (!rule) return {ok: false, error: `No live rule "${id}"`};
      return {ok: true, rule: summarizeRule(rule)};
    }
    case "get_accessorial_catalog":
      return {
        ok: true,
        catalog: Object.keys(ACCESSORIAL_LABELS).map((code) => ({
          code,
          label: ACCESSORIAL_LABELS[code],
        })),
        hint:
          "NTD = Notification delivery; APD = Appointment delivery. " +
          "User 'notification' usually means NTD.",
      };
    case "set_working_memory": {
      if (args.goal) state.goal = args.goal;
      if (args.intentSummary) {
        state.intentSummary = String(args.intentSummary).slice(0, 500);
      }
      if (args.clearOpenQuestion) state.openQuestion = null;
      else if (Object.prototype.hasOwnProperty.call(args, "openQuestion")) {
        state.openQuestion = args.openQuestion ?
          String(args.openQuestion).slice(0, 500) : null;
      }
      if (args.awaiting === "none") state.awaiting = null;
      else if (args.awaiting) state.awaiting = args.awaiting;
      if (Object.prototype.hasOwnProperty.call(args, "focusRuleId")) {
        state.focusRuleId = args.focusRuleId ?
          String(args.focusRuleId) : null;
      }
      if (args.facts && typeof args.facts === "object") {
        state.facts = {...state.facts, ...args.facts};
        if (!Array.isArray(state.facts.accessorials)) {
          state.facts.accessorials = [];
        }
        if (!Array.isArray(state.facts.matchHints)) {
          state.facts.matchHints = [];
        }
      }
      return {ok: true, state: normalizeAgentState(state)};
    }
    case "ask_user": {
      const question = String(args.question || "").trim();
      if (!question) return {ok: false, error: "question required"};
      state.openQuestion = question.slice(0, 500);
      state.awaiting = args.awaiting === "missing_field" ?
        "missing_field" : "clarify_yes_no";
      if (args.intentSummary) {
        state.intentSummary = String(args.intentSummary).slice(0, 500);
      }
      if (args.goal) state.goal = args.goal;
      ctx.outcome = {
        reply: question,
        action: "none",
        proposal: null,
        quickReplies: [],
      };
      return {ok: true, asked: true, awaiting: state.awaiting};
    }
    case "clear_draft": {
      state.draft = null;
      state.awaiting = null;
      state.openQuestion = null;
      ctx.outcome = {
        reply: args.reason ?
          `Oh sorry — ${String(args.reason).slice(0, 200)}` :
          "Oh sorry — I'll drop that proposal. " +
          "What should the rule do instead?",
        action: "dismiss_pending",
        proposal: null,
        quickReplies: [],
      };
      return {ok: true, cleared: true};
    }
    case "draft_create_rule":
      return draftCreate(args, ctx);
    case "draft_update_rule":
      return draftUpdate(args, ctx);
    case "draft_delete_rule":
      return draftDelete(args, ctx);
    default:
      return {ok: false, error: `Unknown tool ${name}`};
  }
}

/**
 * @param {object} args Tool args.
 * @param {object} ctx Agent context.
 * @return {object}
 */
function draftCreate(args, ctx) {
  const state = ctx.state;
  const suppress = args.suppressAccessorials || [];
  const add = Array.isArray(args.addAccessorials) ?
    args.addAccessorials.map((c) => String(c || "").toUpperCase())
        .filter(Boolean) :
    [];
  const mutex = checkMutualExclusion(add, suppress);
  if (mutex) return mutex;

  let ruleKind = args.ruleKind || "accessorial";
  if (ruleKind === "accessorial") ruleKind = null;

  const patch = {
    active: true,
    priority: Number(args.priority) || 40,
    name: String(args.name || args.ruleId),
    match: args.match && typeof args.match === "object" ? args.match : {},
    addAccessorials: add,
    notes: args.notes ? String(args.notes) : "",
    autoApply: true,
    requiresConfirm: false,
    identifyVia: args.identifyVia || "ai",
  };
  if (ruleKind === RULE_KIND_SENDER_CUSTOMER ||
      args.customerName || ruleKind === "sender_customer") {
    patch.ruleKind = RULE_KIND_SENDER_CUSTOMER;
    patch.identifyVia = "email";
    patch.addAccessorials = [];
    if (args.customerName) patch.customerName = String(args.customerName);
    if (Object.prototype.hasOwnProperty.call(args, "protocolOnly")) {
      patch.protocolOnly = !!args.protocolOnly;
    }
    if (args.defaultDims && typeof args.defaultDims === "object") {
      patch.defaultDims = args.defaultDims;
    }
  }
  if (ruleKind === RULE_KIND_ZIP_FILL || args.fillZipCode) {
    patch.ruleKind = RULE_KIND_ZIP_FILL;
    patch.fillZipCode = String(args.fillZipCode || "")
        .replace(/\D/g, "").slice(0, 5);
    patch.applyTo = ["dest", "origin", "both"].includes(args.applyTo) ?
      args.applyTo : "origin";
    patch.addAccessorials = [];
    patch.identifyVia = "ai";
  }

  const ruleId = String(args.ruleId || "").trim();
  const validated = chat.validateRuleProposal({
    action: "propose_create_rule",
    ruleId,
    patch,
  });
  if (!validated.ok) {
    return {ok: false, error: validated.error || "Invalid create proposal"};
  }

  const reply = args.reply ||
    `I'll create **${patch.name}**. Does that look right? Say yes / ` +
    "sounds good / go ahead, or click Confirm.";
  const draft = {
    action: "propose_create_rule",
    ruleId: validated.ruleId,
    patch: validated.patch,
  };
  state.draft = draft;
  state.goal = "create";
  state.awaiting = "confirm_proposal";
  state.openQuestion = null;
  state.focusRuleId = validated.ruleId;
  if (add.length) state.facts.accessorials = add.slice();
  if (patch.ruleKind) state.facts.ruleKind = patch.ruleKind;

  ctx.outcome = {
    reply,
    action: "propose_create_rule",
    proposal: {
      ruleId: validated.ruleId,
      patch: validated.patch,
    },
    quickReplies: [],
  };
  return {ok: true, draft, reply};
}

/**
 * @param {object} args Tool args.
 * @param {object} ctx Agent context.
 * @return {object}
 */
function draftUpdate(args, ctx) {
  const state = ctx.state;
  const existingRules = ctx.existingRules || [];
  const ruleId = String(args.ruleId || "").trim();
  if (!ruleId) return {ok: false, error: "ruleId required"};
  const live = existingRules.find((r) => String(r.id) === ruleId);
  if (!live && !(state.draft && state.draft.ruleId === ruleId)) {
    return {
      ok: false,
      error: `No live rule "${ruleId}". Use draft_create_rule for new rules.`,
    };
  }

  const incoming = args.patch && typeof args.patch === "object" ?
    {...args.patch} : {};
  if (live) {
    if (!incoming.name) incoming.name = live.name;
    if (!incoming.match) incoming.match = live.match || {};
    if (!incoming.identifyVia) {
      incoming.identifyVia = live.identifyVia || "both";
    }
  }
  if (Array.isArray(incoming.suppressAccessorials) &&
      incoming.suppressAccessorials.length) {
    return checkMutualExclusion(
        incoming.addAccessorials || (live && live.addAccessorials) || [],
        incoming.suppressAccessorials);
  }

  const validated = chat.validateRuleProposal({
    action: "propose_update_rule",
    ruleId,
    patch: incoming,
  });
  if (!validated.ok) {
    return {ok: false, error: validated.error || "Invalid update proposal"};
  }

  const reply = args.reply ||
    `I'll update **${ruleId}**. Does that look right? Say yes / sounds ` +
    "good / go ahead, or click Confirm.";
  const draft = {
    action: "propose_update_rule",
    ruleId: validated.ruleId,
    patch: validated.patch,
  };
  state.draft = draft;
  state.goal = "update";
  state.awaiting = "confirm_proposal";
  state.openQuestion = null;
  state.focusRuleId = validated.ruleId;

  ctx.outcome = {
    reply,
    action: "propose_update_rule",
    proposal: {ruleId: validated.ruleId, patch: validated.patch},
    quickReplies: [],
  };
  return {ok: true, draft, reply};
}

/**
 * @param {object} args Tool args.
 * @param {object} ctx Agent context.
 * @return {object}
 */
function draftDelete(args, ctx) {
  const state = ctx.state;
  const ids = []
      .concat(args.ruleIds || [])
      .concat(args.ruleId || [])
      .map((x) => String(x || "").trim())
      .filter(Boolean);
  const unique = [...new Set(ids)];
  if (!unique.length) return {ok: false, error: "ruleId required"};

  const validated = chat.validateRuleProposal({
    action: "propose_delete_rule",
    deleteRuleIds: unique,
    ruleId: unique[0],
  });
  if (!validated.ok) {
    return {ok: false, error: validated.error || "Invalid delete proposal"};
  }

  const reply = args.reply ||
    `I'll delete **${unique.join(", ")}**. ` +
    "Say yes / go ahead, or click Confirm.";
  const draft = {
    action: "propose_delete_rule",
    ruleId: unique[0],
    deleteRuleId: unique[0],
    deleteRuleIds: unique,
    patch: {},
  };
  state.draft = draft;
  state.goal = "delete";
  state.awaiting = "confirm_proposal";
  state.openQuestion = null;
  state.focusRuleId = unique[0];

  ctx.outcome = {
    reply,
    action: "propose_delete_rule",
    proposal: {
      ruleId: unique[0],
      deleteRuleId: unique[0],
      deleteRuleIds: unique,
      patch: {},
    },
    quickReplies: [],
  };
  return {ok: true, draft, reply};
}

/**
 * Parse tool arguments JSON safely.
 * @param {string} raw Raw arguments.
 * @return {object}
 */
function parseToolArgs(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * Build final result from agent outcome + state.
 * @param {object} outcome Turn outcome.
 * @param {object} state Agent state.
 * @param {Array<object>} messages Chat turns.
 * @return {object}
 */
function finalizeResult(outcome, state, messages) {
  const base = outcome && typeof outcome === "object" ? {...outcome} : {
    reply: "What quote rule would you like to add or change?",
    action: "none",
    proposal: null,
    quickReplies: [],
  };
  if (!base.reply && state.openQuestion) base.reply = state.openQuestion;
  if (!base.action) base.action = "none";
  if (state.draft &&
      (base.action === "propose_create_rule" ||
       base.action === "propose_update_rule" ||
       base.action === "propose_delete_rule") &&
      !base.proposal) {
    base.proposal = {
      ruleId: state.draft.ruleId,
      deleteRuleId: state.draft.deleteRuleId,
      deleteRuleIds: state.draft.deleteRuleIds,
      patch: state.draft.patch || {},
    };
  }
  const polished = chat.polishChatResult(base, messages) || base;
  polished.agentState = normalizeAgentState(state);
  return polished;
}

/**
 * Sync pending UI proposal into working memory draft.
 * @param {object} state Agent state.
 * @param {object|null} pending Pending proposal from UI.
 */
function hydrateDraftFromPending(state, pending) {
  if (!pending || typeof pending !== "object") return;
  if (state.draft) return;
  state.draft = {
    action: pending.action || "propose_create_rule",
    ruleId: pending.ruleId || pending.deleteRuleId || null,
    deleteRuleId: pending.deleteRuleId || pending.ruleId || null,
    deleteRuleIds: Array.isArray(pending.deleteRuleIds) ?
      pending.deleteRuleIds.map(String) : undefined,
    patch: pending.patch && typeof pending.patch === "object" ?
      pending.patch : {},
  };
  if (!state.awaiting) state.awaiting = "confirm_proposal";
  if (!state.focusRuleId && state.draft.ruleId) {
    state.focusRuleId = String(state.draft.ruleId);
  }
}

/**
 * Run one rules-chat agent turn (tool loop).
 * @param {object} opts messages, existingRules, agentState, pendingProposal…
 * @return {Promise<object>}
 */
async function runQuoteRulesAgentTurn(opts) {
  const chatTurns = chat.resolveChatTurns(opts || {});
  const existingRules = opts.existingRules || [];
  const state = normalizeAgentState(opts.agentState);
  const pending = opts.pendingProposal &&
    typeof opts.pendingProposal === "object" ?
    opts.pendingProposal : null;
  hydrateDraftFromPending(state, pending);

  if (opts.lastAppliedRule && opts.lastAppliedRule.ruleId &&
      !state.focusRuleId) {
    state.focusRuleId = String(opts.lastAppliedRule.ruleId);
  } else if (opts.referencedRuleId && !state.focusRuleId) {
    state.focusRuleId = String(opts.referencedRuleId);
  }

  const last = chatTurns.length ? chatTurns[chatTurns.length - 1] : null;
  const lastText = last && last.role === "user" ?
    String(last.content || "") : "";

  // Pending / drafted proposal + natural confirm → apply via UI.
  const confirmTarget = pending ||
    (state.awaiting === "confirm_proposal" && state.draft ? state.draft : null);
  if (confirmTarget && lastText &&
      chat.parseNaturalConfirmation(lastText, {pendingProposal: true})) {
    const action = confirmTarget.action || "propose_create_rule";
    return finalizeResult({
      reply: "Perfect — applying that rule now.",
      action,
      proposal: {
        ruleId: confirmTarget.ruleId || confirmTarget.deleteRuleId,
        patch: confirmTarget.patch || {},
        deleteRuleId: confirmTarget.deleteRuleId || confirmTarget.ruleId,
        deleteRuleIds: confirmTarget.deleteRuleIds,
      },
      confirmApply: true,
      quickReplies: [],
    }, state, chatTurns);
  }

  if ((pending || state.draft) && lastText &&
      chat.parseNaturalRejection(lastText)) {
    const rej = chat.parseRejectionWithCorrection(lastText);
    if (rej.rejected && !rej.correction) {
      state.draft = null;
      state.awaiting = null;
      state.openQuestion = null;
      return finalizeResult({
        reply: chat.rejectionReply(null),
        action: "dismiss_pending",
        proposal: null,
        quickReplies: [],
      }, state, chatTurns);
    }
    // Correction: clear draft and let the model rework with full context.
    state.draft = null;
    state.awaiting = null;
  }

  const apiKey = process.env.QUOTE_RULES_CHAT_OPENAI_API_KEY ||
    process.env.SUPPORT_CHAT_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OpenAI API key not configured for quote rules chat");
  }

  const rulesJson = JSON.stringify(
      (existingRules || []).slice(0, 40).map(summarizeRule),
      null,
      0,
  ).slice(0, 8000);

  const systemPrompt = [
    "You are a quote-rules agent for Innovative Carriers dispatchers.",
    "Use tools to inspect rules and draft proposals. Never invent apply",
    "success — only Confirm saves. Talk like a helpful chat assistant.",
    "",
    "Rule kinds:",
    "1) Accessorial / site — match siteType/flags/text → addAccessorials",
    "   (APD appointment, LAD limited access, LFD liftgate, NTD notification,",
    "   NUD nursing, HOD hotel, RSD residential, SCD school).",
    "2) sender_customer — From email/@domain → customerName, optional",
    "   protocolOnly / defaultDims. No accessorials.",
    "3) zip_fill — city/state → fillZipCode + applyTo origin|dest.",
    "",
    "When user says 'notification' they usually mean NTD.",
    "When delivery appointment / APD should not also apply notification,",
    "call get_accessorial_catalog then explain mutual exclusion is not a",
    "runtime field — offer notes/requiresConfirm or removing NTD from",
    "rules that also add APD. Never silently fake suppressAccessorials.",
    "",
    "On ambiguous requests: ask_user with awaiting=clarify_yes_no and set",
    "intentSummary. After user says yes, draft immediately — do not reset.",
    "Bare 'this rule, when…' with no focusRuleId is CREATE, not update.",
    "",
    "Live rules (summary):",
    rulesJson,
    "",
    formatWorkingMemory(state),
  ].join("\n");

  const client = new OpenAI({apiKey});
  const model = RULES_AGENT_MODEL;
  const messages = [
    {role: "system", content: systemPrompt},
    ...chatTurns.slice(-RULES_AGENT_MAX_TURNS).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 4000),
    })),
  ];

  const ctx = {
    existingRules,
    state,
    outcome: null,
  };

  for (let round = 0; round < RULES_AGENT_MAX_TOOL_ROUNDS; round++) {
    const completion = await client.chat.completions.create({
      model,
      max_completion_tokens: 1600,
      messages,
      tools: getToolDefinitions(),
      tool_choice: "auto",
    });
    const choice = completion.choices && completion.choices[0];
    const msg = choice && choice.message ? choice.message : null;
    if (!msg) break;

    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!toolCalls.length) {
      const text = String(msg.content || "").trim();
      if (text) {
        // Prefer tool-built outcome; otherwise use model prose.
        if (!ctx.outcome) {
          ctx.outcome = {
            reply: text,
            action: state.draft ? (state.draft.action || "none") : "none",
            proposal: state.draft ? {
              ruleId: state.draft.ruleId,
              deleteRuleId: state.draft.deleteRuleId,
              deleteRuleIds: state.draft.deleteRuleIds,
              patch: state.draft.patch || {},
            } : null,
            quickReplies: [],
          };
          if (state.draft && state.awaiting === "confirm_proposal") {
            ctx.outcome.action = state.draft.action;
          }
        } else if (!ctx.outcome.reply) {
          ctx.outcome.reply = text;
        }
      }
      break;
    }

    messages.push({
      role: "assistant",
      content: msg.content || null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const fn = call.function || {};
      const toolName = String(fn.name || "");
      const toolArgs = parseToolArgs(fn.arguments);
      const result = executeTool(toolName, toolArgs, ctx);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 8000),
      });
    }

    // ask_user / clear_draft / successful draft can end early.
    if (ctx.outcome &&
        (ctx.outcome.action === "dismiss_pending" ||
         ctx.outcome.action === "propose_create_rule" ||
         ctx.outcome.action === "propose_update_rule" ||
         ctx.outcome.action === "propose_delete_rule" ||
         (ctx.outcome.action === "none" &&
          state.awaiting === "clarify_yes_no") ||
         (ctx.outcome.action === "none" &&
          state.awaiting === "missing_field"))) {
      // One more model turn not required when ask_user set the reply.
      if (state.awaiting === "clarify_yes_no" ||
          state.awaiting === "missing_field" ||
          ctx.outcome.action !== "none") {
        break;
      }
    }
  }

  if (!ctx.outcome) {
    ctx.outcome = {
      reply: state.openQuestion ||
        "What quote rule would you like to add or change?",
      action: "none",
      proposal: null,
      quickReplies: [],
    };
  }

  return finalizeResult(ctx.outcome, state, chatTurns);
}

module.exports = {
  isRulesChatAgentEnabled,
  normalizeAgentState,
  formatWorkingMemory,
  getToolDefinitions,
  executeTool,
  searchRules,
  checkMutualExclusion,
  runQuoteRulesAgentTurn,
  RULES_AGENT_MODEL,
  RULES_AGENT_MAX_TOOL_ROUNDS,
};
