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

const QUICK_REPLY_CAN_BE =
  "Can be identified from the email";
const QUICK_REPLY_CANNOT_BE =
  "Cannot be — address / site classification only";

const IDENTIFY_QUICK_REPLIES = [
  QUICK_REPLY_CAN_BE,
  QUICK_REPLY_CANNOT_BE,
];

/**
 * Normalize identify-choice text for robust matching.
 * @param {string} text Raw user (or button) text.
 * @return {string}
 */
function normalizeIdentifyAnswerText(text) {
  return String(text || "")
      .trim()
      // Strip markdown wrappers on short answers (**2**, *can*).
      .replace(/^\*{1,3}\s*/, "")
      .replace(/\s*\*{1,3}$/, "")
      .replace(/^`+|`+$/g, "")
      .toLowerCase()
      .replace(/[\u2010-\u2015\u2212]/g, "-") // hyphens / dashes
      .replace(/\s+/g, " ");
}

/**
 * Parse Can be / Cannot be questionnaire answers.
 * Accepts: 1/2, A/B, can/cannot, can be/cannot be, full button labels,
 * and pasted option text with trailing punctuation or em-dash clauses.
 * @param {string} text User message.
 * @return {"email"|"address_only"|null}
 */
function parseIdentifyChoiceAnswer(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const norm = normalizeIdentifyAnswerText(raw);

  // Exact quick-reply payloads (any dash variant).
  const cannotLabel = normalizeIdentifyAnswerText(QUICK_REPLY_CANNOT_BE);
  const canLabel = normalizeIdentifyAnswerText(QUICK_REPLY_CAN_BE);
  if (norm === cannotLabel || norm.startsWith(cannotLabel)) {
    return "address_only";
  }
  if (norm === canLabel || norm.startsWith(canLabel)) {
    return "email";
  }

  // Numbered / lettered options (optionally with trailing punctuation).
  if (/^(2|b)([.)]|$)/.test(norm) ||
      /^option\s*(2|b)\b/.test(norm)) {
    return "address_only";
  }
  if (/^(1|a)([.)]|$)/.test(norm) ||
      /^option\s*(1|a)\b/.test(norm)) {
    return "email";
  }

  // Short / partial answers — cannot before can.
  if (/^(cannot|can't)(\b|$)/.test(norm) ||
      /^cannot be\b/.test(norm) ||
      /\baddress\s*\/?\s*site classification\b/.test(norm) ||
      /\baddress[- ]only\b/.test(norm) ||
      /\bsite classification only\b/.test(norm) ||
      /\bonly via (ai|address)\b/.test(norm) ||
      /\bnot from (the )?email\b/.test(norm) ||
      /\bcan't be identified\b/.test(norm) ||
      /\bcannot be identified\b/.test(norm)) {
    return "address_only";
  }

  if (/^can be\b/.test(norm) ||
      /^can(\b|$)/.test(norm) ||
      /\bcan be identified from the email\b/.test(norm) ||
      /\balso from (the )?email\b/.test(norm) ||
      /\bfrom (the )?email (as well|too|instead)\b/.test(norm) ||
      /\bemail (body|subject|sender)\b/.test(norm)) {
    // Guard: "can…" that is actually cannot (already handled above).
    if (/^cannot\b/.test(norm) || /\bcannot be\b/.test(norm)) {
      return "address_only";
    }
    return "email";
  }

  return null;
}

const KNOWN_ACCESSORIAL_CODES = new Set([
  "LFO", "LFD", "APD", "APO", "LAD", "LAO", "NUD", "NUP",
  "HOD", "HOO", "RSD", "RSO", "SCD", "SCO", "INS", "LTD",
  "IND", "INO", "NTO", "AF",
]);

const ACCESSORIAL_NAME_PATTERNS = [
  {code: "LAO", re: /\blimited\s*access\s+(pickup|origin)\b/i},
  {
    code: "LAD",
    re: /\blimited\s*access(\s+(delivery|dest(ination)?))?\b/i,
  },
  {
    code: "LFO",
    re: /\blift[\s-]*gates?\s+(at\s+)?(pickup|origin)\b/i,
  },
  {
    code: "LFD",
    re: /\blift[\s-]*gates?(\s+(at\s+)?(delivery|dest))?\b/i,
  },
  {
    code: "APD",
    re: /\bappointments?(\s+(delivery|dest|required))?\b/i,
  },
  {code: "RSD", re: /\bresidential(\s+delivery)?\b/i},
  {code: "NUD", re: /\bnursing(\s+home)?(\s+delivery)?\b/i},
  {code: "HOD", re: /\bhotel(\s+delivery)?\b/i},
  {code: "SCD", re: /\bschool(\s+delivery)?\b/i},
  {code: "INS", re: /\binsurance\b/i},
];

const ASKED_ACCESSORIALS_RE = new RegExp(
    "which accessorials|accessorials should this rule add|" +
    "which codes to add|what accessorials",
    "i",
);

/**
 * Parse accessorial codes / names from a user answer.
 * Accepts case-insensitive codes (LAD, LFD, APD, …), names like
 * "limited access", and the LOAD typo → LAD.
 * @param {string} text User message.
 * @return {Array<string>} Unique uppercase codes.
 */
function parseAccessorialsAnswer(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const codes = [];
  const seen = new Set();
  const add = (code) => {
    let u = String(code || "").toUpperCase();
    if (u === "LOAD") u = "LAD";
    if (!/^[A-Z]{2,5}$/.test(u) || seen.has(u)) return;
    seen.add(u);
    codes.push(u);
  };

  const withLoadFix = raw.replace(/\bload\b/gi, "LAD");
  for (const {code, re} of ACCESSORIAL_NAME_PATTERNS) {
    if (re.test(withLoadFix)) add(code);
  }

  const words = withLoadFix.split(/[^a-z0-9]+/i).filter(Boolean);
  const onlyCodes = words.length > 0 && words.every((w) => {
    const u = w.toUpperCase();
    return KNOWN_ACCESSORIAL_CODES.has(u) || /^[A-Z]{3,4}$/.test(u);
  });
  for (const w of words) {
    const u = w.toUpperCase();
    if (KNOWN_ACCESSORIAL_CODES.has(u)) {
      add(u);
    } else if (onlyCodes && /^[A-Z]{3,4}$/.test(u)) {
      add(u);
    }
  }
  return codes;
}

/**
 * Infer site-type / rule id from create-flow chat history.
 * @param {Array<object>} messages Chat turns.
 * @return {object} ruleId, name, siteType?, flags?, notes
 */
function inferCreateTopic(messages) {
  const blob = (messages || [])
      .filter((m) => m && m.role !== "assistant")
      .map((m) => String(m.content || ""))
      .join("\n")
      .toLowerCase();
  if (/\baafes\b|\bmilitary(\s+(base|bases|exchange|installation)s?)?\b/
      .test(blob)) {
    return {
      ruleId: "aafes_military",
      name: "Military bases / AAFES",
      siteType: "aafes_military",
      notes: "AI-classified military / AAFES delivery location.",
    };
  }
  if (/\bnursing(\s+home)?s?\b/.test(blob)) {
    return {
      ruleId: "nursing_home",
      name: "Nursing home delivery",
      siteType: "nursing_home",
      notes: "AI-classified nursing home delivery location.",
    };
  }
  if (/\bhotels?\b/.test(blob)) {
    return {
      ruleId: "hotel",
      name: "Hotel delivery",
      siteType: "hotel",
      notes: "AI-classified hotel delivery location.",
    };
  }
  if (/\bamazon\b|\bfulfillment centers?\b/.test(blob)) {
    return {
      ruleId: "amazon_fc",
      name: "Amazon FC",
      siteType: "amazon_fc",
      notes: "Amazon fulfillment center.",
    };
  }
  if (/\bmenards?\b/.test(blob)) {
    return {
      ruleId: "menards_dc",
      name: "Menards DC",
      siteType: "menards_dc",
      notes: "Menards distribution center.",
    };
  }
  if (/\bresidential\b/.test(blob)) {
    return {
      ruleId: "residential_delivery",
      name: "Residential delivery",
      flags: ["residentialDelivery"],
      notes: "Residential delivery flag.",
    };
  }
  return {
    ruleId: "custom_site_rule",
    name: "Custom site rule",
    notes: "Created from quote rules chat.",
  };
}

/**
 * Collect accessorial answers from create-flow user turns.
 * @param {Array<object>} messages Chat turns.
 * @return {object} askedAccessorials, accessorials[]
 */
function collectCreateAccessorials(messages) {
  let askedAccessorials = false;
  const codes = [];
  const seen = new Set();
  for (const turn of messages || []) {
    const text = String(turn && turn.content || "");
    if (turn && turn.role === "assistant") {
      if (ASKED_ACCESSORIALS_RE.test(text)) askedAccessorials = true;
      continue;
    }
    if (parseIdentifyChoiceAnswer(text)) continue;
    for (const code of parseAccessorialsAnswer(text)) {
      if (!seen.has(code)) {
        seen.add(code);
        codes.push(code);
      }
    }
  }
  return {askedAccessorials, accessorials: codes};
}

/**
 * Extra create-flow fields persisted from chat history.
 * @param {Array<object>} messages Chat turns.
 * @return {object}
 */
function collectCreateFlowExtras(messages) {
  const acc = collectCreateAccessorials(messages);
  const topic = inferCreateTopic(messages);
  return {
    askedAccessorials: acc.askedAccessorials,
    accessorials: acc.accessorials,
    siteType: topic.siteType || null,
    topic,
  };
}

/**
 * @param {object} gate Identify-gate result.
 * @param {Array<object>} messages Chat turns.
 * @return {object}
 */
function withCreateFlowExtras(gate, messages) {
  return {...gate, ...collectCreateFlowExtras(messages)};
}

/**
 * Deterministic address-only create proposal once accessorials are known.
 * @param {Array<object>} messages Chat turns.
 * @param {Array<string>} accessorials Codes.
 * @return {object}
 */
function buildAddressOnlyCreateProposal(messages, accessorials) {
  const topic = inferCreateTopic(messages);
  const codes = (accessorials || []).map(String);
  const match = {};
  if (topic.siteType) match.siteType = topic.siteType;
  if (Array.isArray(topic.flags) && topic.flags.length) {
    match.flags = topic.flags.slice();
  }
  const name = codes.length ?
    `${topic.name} — ${codes.join("/")}` :
    topic.name;
  const labels = codes.join(", ");
  return {
    reply: `Here's a proposed rule for ${topic.name} that adds ` +
      `${labels} (identified via AI site classification). ` +
      `Click Confirm to apply it.`,
    action: "propose_create_rule",
    proposal: {
      ruleId: topic.ruleId,
      patch: {
        active: true,
        priority: 40,
        name,
        identifyVia: "ai",
        match,
        addAccessorials: codes,
        notes: topic.notes,
        autoApply: true,
        requiresConfirm: false,
      },
    },
    quickReplies: [],
  };
}

/**
 * Fill or replace a create proposal after Cannot-be + accessorials.
 * @param {object} out Model result (mutated copy).
 * @param {Array<object>} messages Chat turns.
 * @param {object} extras create-flow extras.
 * @return {object}
 */
function finalizeAddressOnlyCreate(out, messages, extras) {
  const built = buildAddressOnlyCreateProposal(
      messages, extras.accessorials || []);
  const reask = new RegExp(
      "could not process|try rephrasing|which accessorials|" +
      "please choose one",
      "i",
  );
  if (out.action === "propose_create_rule" && out.proposal &&
      typeof out.proposal === "object") {
    const patch = out.proposal.patch &&
      typeof out.proposal.patch === "object" ?
      {...out.proposal.patch} : {};
    patch.identifyVia = "ai";
    const match = patch.match && typeof patch.match === "object" ?
      {...patch.match} : {};
    delete match.consigneeNameContains;
    delete match.consigneeAddressContains;
    delete match.instructionsContains;
    delete match.referenceContains;
    if (!match.siteType && extras.siteType) {
      match.siteType = extras.siteType;
    }
    if (!Object.keys(match).length && built.proposal.patch.match) {
      Object.assign(match, built.proposal.patch.match);
    }
    patch.match = match;
    const existing = Array.isArray(patch.addAccessorials) ?
      patch.addAccessorials.map(String) : [];
    const have = new Set(existing.map((c) => c.toUpperCase()));
    const merged = existing.slice();
    for (const code of extras.accessorials || []) {
      if (!have.has(code)) merged.push(code);
    }
    patch.addAccessorials = merged.length ?
      merged : (extras.accessorials || []).slice();
    if (!patch.name) patch.name = built.proposal.patch.name;
    if (!patch.notes) patch.notes = built.proposal.patch.notes;
    out.proposal = {
      ...out.proposal,
      ruleId: out.proposal.ruleId || built.proposal.ruleId,
      patch,
    };
    if (!out.reply || reask.test(String(out.reply))) {
      out.reply = built.reply;
    }
    out.quickReplies = [];
    out.createIdentify = extras;
    return out;
  }
  built.createIdentify = extras;
  return built;
}

/**
 * Detect create-rule identify questionnaire progress from chat history.
 * @param {Array<object>} messages Chat turns with role/content.
 * @return {object} Gate status, source, and emailSignalsListed.
 */
function detectCreateIdentifyGate(messages) {
  const turns = (messages || []).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || ""),
  }));

  let askedChoice = false;
  let source = null;
  let askedEmailSignals = false;
  let emailSignalsListed = false;

  const askedChoiceRe = new RegExp(
      "how can (this|it) be identified|" +
      "before i propose that rule|" +
      "please choose one|" +
      "identified from the (quote )?email|" +
      "can be identified from the email|" +
      "address\\/?\\s*site classification|address only|cannot be",
      "i",
  );
  const askedSignalsRe = new RegExp(
      "list all ways|keywords|sender domains|subject patterns|" +
      "attachment text|consignee name phrases|signal from the email|" +
      "ways .+ from the email",
      "i",
  );

  for (const turn of turns) {
    const text = turn.content;

    if (turn.role === "assistant") {
      if (askedChoiceRe.test(text)) {
        askedChoice = true;
      }
      if (askedSignalsRe.test(text)) {
        askedEmailSignals = true;
      }
      continue;
    }

    // User turns — prefer explicit identify answers when choice was offered
    // or the message itself is clearly a Can be / Cannot be reply.
    const choice = parseIdentifyChoiceAnswer(text);
    if (choice === "address_only") {
      source = "address_only";
      continue;
    }
    if (choice === "email") {
      source = "email";
      continue;
    }

    if (source === "email" && askedEmailSignals) {
      // Any substantive follow-up after we asked for signals counts.
      if (text.trim().length >= 8 &&
          !/^(confirm(ed)?|yes|y|ok|okay|do it|apply|proceed)\.?$/i
              .test(text.trim())) {
        emailSignalsListed = true;
      }
    }
  }

  if (source === "address_only") {
    return withCreateFlowExtras(
        {status: "ready", source, emailSignalsListed: false}, messages);
  }
  if (source === "email" && emailSignalsListed) {
    return withCreateFlowExtras(
        {status: "ready", source, emailSignalsListed: true}, messages);
  }
  if (source === "email") {
    return withCreateFlowExtras({
      status: "awaiting_email_signals",
      source,
      emailSignalsListed: false,
    }, messages);
  }
  if (askedChoice) {
    return withCreateFlowExtras({
      status: "awaiting_choice",
      source: null,
      emailSignalsListed: false,
    }, messages);
  }
  return withCreateFlowExtras({
    status: "needed",
    source: null,
    emailSignalsListed: false,
  }, messages);
}

/**
 * True when the latest user message looks like a create/add rule request.
 * @param {Array<object>} messages Chat turns.
 * @return {boolean}
 */
function looksLikeCreateRuleIntent(messages) {
  const lastUser = [...(messages || [])].reverse()
      .find((m) => m.role !== "assistant");
  if (!lastUser) return false;
  const t = String(lastUser.content || "").toLowerCase();
  const createAccessorialRe = new RegExp(
      "\\b(whenever|when|for)\\b.{0,80}\\b(add|include|require)\\b" +
      ".{0,40}\\b(accessorial|liftgate|appointment|nursing|hotel|" +
      "residential|school)",
      "i",
  );
  return /\b(add|create|new|make|set up|setup)\b.{0,40}\brule\b/.test(t) ||
    /\brule\b.{0,40}\b(add|create|new)\b/.test(t) ||
    createAccessorialRe.test(t);
}

/**
 * Enforce identify questionnaire before create proposals.
 * @param {object} result Model JSON result.
 * @param {Array} messages Chat history including latest user turn.
 * @return {object}
 */
function enforceCreateIdentifyGate(result, messages) {
  const out = result && typeof result === "object" ? {...result} : {
    reply: "I could not process that. Try rephrasing.",
    action: "none",
    proposal: null,
  };
  const action = out.action || "none";
  const gate = detectCreateIdentifyGate(messages);
  const extras = collectCreateFlowExtras(messages);
  const lastUser = [...(messages || [])].reverse()
      .find((m) => m && m.role !== "assistant");
  const lastIsAccessorials = !!(lastUser &&
      parseAccessorialsAnswer(lastUser.content).length);
  // Keep create-flow active through ready: the latest user turn is often
  // just "2" / "Cannot be…" / "LAD", which is NOT create-intent by itself.
  const inIdentifyFlow = gate.status === "awaiting_choice" ||
    gate.status === "awaiting_email_signals" ||
    gate.status === "ready" ||
    (extras.askedAccessorials && lastIsAccessorials) ||
    (gate.status === "needed" && looksLikeCreateRuleIntent(messages));
  const creating = action === "propose_create_rule" ||
    looksLikeCreateRuleIntent(messages) ||
    inIdentifyFlow;

  // Mid create-flow (Cannot-be + accessorials): don't let a mis-tagged
  // update/delete skip the deterministic create proposal.
  const addressOnlyReady = gate.status === "ready" &&
    gate.source === "address_only";
  if ((action === "propose_update_rule" ||
      action === "propose_delete_rule") &&
      !(addressOnlyReady && extras.accessorials.length)) {
    return out;
  }

  if (!creating && action !== "ask_identify_source" &&
      action !== "ask_email_signals") {
    return out;
  }

  if (gate.status === "ready") {
    // Strip premature create if model invented email match without signals.
    if (action === "propose_create_rule" && gate.source === "email") {
      const patch = out.proposal && out.proposal.patch;
      if (!patch || !patch.match || typeof patch.match !== "object" ||
          !Object.keys(patch.match).length) {
        return {
          reply: "Thanks — please list every way we can spot this in the " +
            "quote email (keywords, sender domains, subject patterns, " +
            "attachment text, consignee name phrases, etc.). I will use " +
            "only what you list.",
          action: "ask_email_signals",
          proposal: null,
          quickReplies: [],
          createIdentify: gate,
        };
      }
    }
    if (action === "propose_create_rule" && gate.source === "address_only") {
      // Force AI / site-classification path; drop invented email text matches.
      if (out.proposal && out.proposal.patch) {
        const patch = {...out.proposal.patch};
        patch.identifyVia = "ai";
        const match = patch.match && typeof patch.match === "object" ?
          {...patch.match} : {};
        delete match.consigneeNameContains;
        delete match.consigneeAddressContains;
        delete match.instructionsContains;
        delete match.referenceContains;
        // Keep siteType / flags for classification matching.
        patch.match = match;
        out.proposal = {...out.proposal, patch};
      }
    }
    out.createIdentify = gate;

    // Address-only: persist accessorials and propose once they are known.
    // Never re-ask identify, and never loop "Which accessorials…".
    if (gate.source === "address_only") {
      if (extras.accessorials.length) {
        return finalizeAddressOnlyCreate(
            {...out, createIdentify: gate}, messages, extras);
      }
      out.action = "none";
      out.proposal = null;
      out.quickReplies = [];
      if (extras.askedAccessorials && lastIsAccessorials === false &&
          lastUser && !parseIdentifyChoiceAnswer(lastUser.content)) {
        out.reply = "I didn't catch an accessorial code. Send codes like " +
          "LAD, LFD, APD (any case), or a name like \"limited access\". " +
          "LOAD is treated as LAD.";
      } else {
        out.reply = "Got it — address / site classification only " +
          "(AI enrichment). I'll match via siteType / flags " +
          "(e.g. aafes_military for military bases / AAFES). " +
          "Which accessorials should this rule add " +
          "(e.g. LAD, LFD, APD — or names like limited access)?";
      }
      return out;
    }

    // Choice is done — never re-ask identify, and never surface the generic
    // parse-failure reply for a valid Can/Cannot answer.
    if (out.action === "ask_identify_source") {
      out.action = "ask_email_signals";
      out.proposal = null;
      out.quickReplies = [];
      if (!out.reply ||
          /could not process|try rephrasing|please choose one/i
              .test(String(out.reply))) {
        out.reply = "Got it — this can be spotted in the quote email. " +
          "Please list all ways you think we can get that signal " +
          "(keywords in the body, sender domains, subject patterns, " +
          "attachment text, consignee name phrases, etc.). " +
          "I will only use what you list.";
      }
      return out;
    }
    const badReply = !out.reply ||
      /could not process|try rephrasing/i.test(String(out.reply));
    if (badReply && out.action !== "propose_create_rule") {
      out.reply = "Got it. Tell me any missing details " +
        "(accessorials, site type, name) and I'll propose the rule.";
      out.action = "none";
      out.proposal = null;
      out.quickReplies = [];
    }
    return out;
  }

  if (gate.status === "awaiting_email_signals") {
    return {
      reply: out.action === "ask_email_signals" && out.reply ?
        out.reply :
        "Got it — this can be spotted in the quote email. Please list " +
        "all ways you think we can get that signal (keywords in the " +
        "body, sender domains, subject patterns, attachment text, " +
        "consignee name phrases, etc.). I will only use what you list.",
      action: "ask_email_signals",
      proposal: null,
      quickReplies: [],
      createIdentify: gate,
    };
  }

  // needed or awaiting_choice — stop and ask with two clear options.
  const reply = (out.action === "ask_identify_source" && out.reply) ?
    out.reply :
    "Before I propose that rule: how can this condition be identified?\n\n" +
    "1. **Can be** identified from the quote email " +
    "(body / subject / sender / attachments / consignee name text) — " +
    "as well as or instead of the address.\n" +
    "2. **Cannot be** — address-only / site classification only " +
    "(AI enrichment of the delivery address).\n\n" +
    "Please choose one.";

  return {
    reply,
    action: "ask_identify_source",
    proposal: null,
    quickReplies: IDENTIFY_QUICK_REPLIES.slice(),
    createIdentify: gate,
  };
}

/**
 * @param {object} opts messages[], existingRules[].
 * @return {Promise<object>} {reply, action, proposal}
 */
async function runQuoteRulesChatTurn(opts) {
  const chatTurns = opts.messages || [];
  const gateHint = detectCreateIdentifyGate(chatTurns);
  // After Cannot-be, accessorials are a structured answer — don't send
  // "LAD" / "limited access" through the model (that caused the re-ask loop).
  if (gateHint.status === "ready" && gateHint.source === "address_only") {
    return enforceCreateIdentifyGate({
      reply: "",
      action: "none",
      proposal: null,
    }, chatTurns);
  }

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
    "  \"action\": \"none\" | \"ask_identify_source\" |",
    "    \"ask_email_signals\" | \"propose_create_rule\" |",
    "    \"propose_update_rule\" | \"propose_delete_rule\",",
    "  \"proposal\": null | {",
    "    \"ruleId\": \"snake_case_id\",",
    "    \"patch\": { rule fields for create/update },",
    "    \"deleteRuleId\": \"id for delete\"",
    "  },",
    "  \"quickReplies\": [] | [\"Can be identified from the email\",",
    "    \"Cannot be — address / site classification only\"]",
    "}",
    "",
    "Rule patch fields: active, priority, name, match, addAccessorials,",
    "filterCarrierWarnings, notes, autoApply, requiresConfirm, identifyVia.",
    "match may use: consigneeNameContains, consigneeAddressContains,",
    "instructionsContains, referenceContains, flags, siteType.",
    "",
    "=== MANDATORY create-rule identify questionnaire ===",
    "When the user wants to ADD or CREATE a new rule, you MUST NOT propose",
    "the rule (action must NOT be propose_create_rule) until this finishes.",
    "Updates and deletes skip this questionnaire unless it comes up naturally.",
    "",
    "Step 1 — Always stop and ask (action: ask_identify_source):",
    "\"How can this condition be identified?\" Present exactly two options:",
    "  A) Can be identified from the quote email (body/subject/sender/",
    "     attachments/consignee name text) — as well as or instead of address.",
    "  B) Cannot be — address-only / site classification only (AI enrichment).",
    "Set quickReplies to those two option strings exactly:",
    "  \"" + QUICK_REPLY_CAN_BE + "\"",
    "  \"" + QUICK_REPLY_CANNOT_BE + "\"",
    "Wait for the user's choice. Do not invent a proposal yet.",
    "User may answer with: 1, 2, A, B, can, cannot, can be, cannot be,",
    "or the full quickReply button text (ignore em-dash / trailing clauses).",
    "Those short answers are definitive — do not re-ask Step 1.",
    "",
    "Step 2a — If they choose CAN BE (email):",
    "  action: ask_email_signals. Ask them to list ALL ways they think we",
    "  can get the signal from the email (keywords, sender domains, subject",
    "  patterns, attachment text, consignee name phrases, etc.).",
    "  Wait for their list. Do NOT invent email match criteria yourself.",
    "  Only after they list signals may you propose_create_rule, putting",
    "  those signals into match (instructionsContains / consigneeNameContains",
    "  / referenceContains / etc. as appropriate).",
    "  Set identifyVia to \"address_text\" when matching email/text only,",
    "  or \"both\" if address AI classification should also count.",
    "",
    "Step 2b — If they choose CANNOT BE (address-only):",
    "  Proceed with address / siteType / flags classification matching only.",
    "  Set identifyVia to \"ai\". Do NOT invent email-text match keywords.",
    "  Use match.siteType and/or match.flags as appropriate.",
    "  Known siteType values: nursing_home, hotel, amazon_fc, menards_dc,",
    "  aafes_military (military bases / AAFES / military exchange),",
    "  residential, other.",
    "  For military bases / AAFES use match.siteType \"aafes_military\".",
    "  If accessorials were already stated, propose_create_rule immediately.",
    "  If not, ask which codes to add — never say you could not process.",
    "  After they answer, propose_create_rule. Do NOT re-ask identify or",
    "  accessorials. Accept codes case-insensitively: LAD LFD APD RSD NUD",
    "  LTD LFO HOD SCD INS, names like \"limited access\" /",
    "  \"limited access delivery\", and LOAD as a typo for LAD.",
    "",
    "Current questionnaire state from chat history (authoritative):",
    `  status=${gateHint.status}; source=${gateHint.source || "null"};`,
    `  emailSignalsListed=${gateHint.emailSignalsListed};`,
    `  askedAccessorials=${!!gateHint.askedAccessorials};`,
    `  accessorials=${(gateHint.accessorials || []).join(",") || "none"};`,
    `  siteType=${gateHint.siteType || "null"}`,
    "If status is needed or awaiting_choice: action MUST be",
    "ask_identify_source (not propose_create_rule).",
    "If status is awaiting_email_signals: action MUST be ask_email_signals.",
    "Only when status is ready may you use propose_create_rule.",
    "When status is ready after cannot-be (source=address_only), do NOT",
    "re-ask identify and do NOT reply that you could not process the answer.",
    "If accessorials are already listed in state, propose_create_rule now.",
    "A short accessorial answer (LAD / lad / limited access / LOAD) is the",
    "missing detail — propose the rule; never repeat the accessorials ask.",
    "",
    "identifyVia values:",
    "  address_text — match from email/text fields only.",
    "  ai — match only from AI address classification.",
    "  both — either text OR AI signals (default when both apply).",
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
    "Never claim you saved, updated, or deleted a rule.",
    "Never say \"Confirmed\", \"rule removed\", \"deleted\", or \"it's gone\".",
    "Only the Confirm button applies changes — chat text cannot apply them.",
    "If the user types Confirm / Yes / Done without clicking the button,",
    "reply that they must click the Confirm button (action none).",
    "For propose_delete_rule: ask them to click Confirm; do not claim removal.",
    "When asked if a rule is gone: answer ONLY from Current active rules JSON",
    "above (fresh from Firestore this turn). Ignore prior chat claims.",
    "Messages starting with [APPLIED] are ground-truth UI Confirm results.",
    "If unclear (and not mid identify questionnaire), ask one short",
    "clarifying question with action none.",
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
      completion.choices[0].content || "",
  ).trim();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    parsed = {
      reply: raw || "I could not process that. Try rephrasing.",
      action: "none",
      proposal: null,
    };
  }

  return enforceCreateIdentifyGate(parsed, opts.messages || []);
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
  if (action === "propose_delete_rule" || action === "delete") {
    const id = proposal.deleteRuleId ||
      proposal.ruleId ||
      (proposal.proposal && (
        proposal.proposal.deleteRuleId || proposal.proposal.ruleId
      )) ||
      (proposal.patch && (
        proposal.patch.deleteRuleId || proposal.patch.ruleId
      ));
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
  detectCreateIdentifyGate,
  enforceCreateIdentifyGate,
  parseIdentifyChoiceAnswer,
  parseAccessorialsAnswer,
  IDENTIFY_QUICK_REPLIES,
  QUICK_REPLY_CAN_BE,
  QUICK_REPLY_CANNOT_BE,
};
