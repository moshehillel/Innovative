/**
 * Quote rules AI chatbot — separate from dashboardSupportChat.
 * Proposes rule CRUD; writes only via applyQuoteRuleProposal.
 */

"use strict";

const OpenAI = require("openai");
const {
  IDENTIFY_VIA_VALUES,
  DEFAULT_IDENTIFY_VIA,
  ACCESSORIAL_LABELS,
  RULE_KIND_SENDER_CUSTOMER,
} = require("./quote-accessorial-rules");

// Stronger than gpt-5.6-luna for freeform rule chat. Override via env.
const RULES_CHAT_MODEL = process.env.QUOTE_RULES_CHAT_MODEL || "gpt-5.6-sol";

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
  "ruleKind",
  "customerName",
  "protocolOnly",
  "defaultDims",
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

  // Explicit email-identify phrases (not "can you add …").
  if (/\bcan be identified from the email\b/.test(norm) ||
      /\balso from (the )?email\b/.test(norm) ||
      /\bfrom (the )?email (as well|too|instead)\b/.test(norm) ||
      /\bemail (body|subject|sender)\b/.test(norm)) {
    if (/^cannot\b/.test(norm) || /\bcannot be\b/.test(norm)) {
      return "address_only";
    }
    return "email";
  }

  // Bare "can" / "can be" answers only — never "can you add for military".
  if (/^can you\b/.test(norm)) return null;
  const isShortIdentify = norm.length <= 48;
  if (isShortIdentify &&
      (/^can be\b/.test(norm) || /^can$/.test(norm) ||
       /^can[.!]$/.test(norm))) {
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
    re: new RegExp(
        "\\b(apd|appointments?(\\s+(delivery|dest|required)?)?)\\b|" +
        "\\b(delivery|dest(ination)?)\\s+appointments?\\b",
        "i"),
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
 * User-only blob for topic inference. Assistant turns are ignored because
 * the identify questionnaire always mentions aafes_military as an example.
 * @param {Array<object>} messages Chat turns.
 * @return {string}
 */
function userTopicBlob(messages) {
  return (messages || [])
      .filter((m) => m && m.role !== "assistant")
      .map((m) => String(m.content || ""))
      .join("\n")
      .toLowerCase();
}

/**
 * Military / AAFES phrasing, including common typos (militery, millitary).
 * @param {string} blob Lowercased user text.
 * @return {boolean}
 */
function isMilitaryTopicBlob(blob) {
  const t = String(blob || "");
  return /\baafes\b/.test(t) ||
    /\bmil+i?t+[ae]r+y\b/.test(t) ||
    /\b(army|navy|air\s*force|marine)\s+(base|bases|post|installation)s?\b/
        .test(t) ||
    /\bjoint\s+bases?\b/.test(t);
}

/**
 * Site types identified from the delivery address / AI, not email
 * keywords (military, nursing home, hotel).
 * @param {Array<object>} messages Chat turns.
 * @return {boolean}
 */
function isClearlySiteTypeTopic(messages) {
  const blob = userTopicBlob(messages);
  return isMilitaryTopicBlob(blob) ||
    /\bnursing(\s+home)?s?\b/.test(blob) ||
    /\bhotels?\b/.test(blob);
}

/**
 * User explicitly asked to identify from the quote email.
 * @param {Array<object>} messages Chat turns.
 * @return {boolean}
 */
function userAskedForEmailIdentify(messages) {
  const blob = userTopicBlob(messages);
  return /\bidentified from the (quote )?email\b/.test(blob) ||
    /\bfrom (the )?quote email\b/.test(blob) ||
    /\bemail (keywords|signals|sender domains)\b/.test(blob);
}

/**
 * Follow-up that is a complaint, not a new rule request.
 * @param {string} text User text.
 * @return {boolean}
 */
function isMetaFollowUpText(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;
  return /\bi asked you\b/.test(t) ||
    /\bthat'?s not what i (asked|meant|said)\b/.test(t) ||
    /\byou (didn'?t|did not) (understand|answer)\b/.test(t);
}

/**
 * Appointment / APD / LAD phrasing, including "delivery appointment".
 * @param {string} blob Lowercased text.
 * @return {boolean}
 */
function hasMilitaryAccessorialPhrasing(blob) {
  const t = String(blob || "");
  return /\b(apd|lad)\b/.test(t) ||
    /\bappointments?\b/.test(t) ||
    /\blimited\s*ac+ess\b/.test(t) ||
    /\b(delivery|dest(ination)?)\s+appointments?\b/.test(t);
}

/**
 * Military + appointment/LAD add or update. Typos: militery, aadd,
 * fecileties.
 * @param {Array<object>} messages Chat turns.
 * @return {boolean}
 */
function looksLikeMilitaryAccessorialIntent(messages) {
  if (looksLikeDeleteRuleIntent(messages)) return false;
  const last = lastUserTurn(messages);
  const lastText = last ? String(last.content || "").toLowerCase() : "";
  if (/^\[applied\]/.test(String(last && last.content || "").trim())) {
    return false;
  }
  const blob = isMetaFollowUpText(lastText) ?
    userTopicBlob(messages) : lastText;
  if (!isMilitaryTopicBlob(blob)) return false;
  return hasMilitaryAccessorialPhrasing(blob);
}

/**
 * Fallback when JSON is empty or the model is unclear. Never the old
 * "I could not process that" dead-end.
 * @param {Array<object>} messages Chat turns.
 * @return {string}
 */
function fallbackUnclearReply(messages) {
  if (looksLikeSenderCustomerIntent(messages)) {
    return "I can map a sender email to a Primus customer. " +
      "Tell me the From address and customer name " +
      "(and protocol only / default dims if needed).";
  }
  if (isMilitaryTopicBlob(userTopicBlob(messages))) {
    return "I can add or update the military / AAFES site rule " +
      "(limited access and appointment delivery). Tell me LAD, APD, " +
      "or both and I'll propose it.";
  }
  return "Tell me the site (for example military bases) and which " +
    "accessorials to add (LAD, APD, …), or map a sender email to a " +
    "customer. I'll propose a rule to Confirm.";
}

/**
 * Human rule name: "Military bases — limited access".
 * @param {object} topic Topic from inferCreateTopic.
 * @param {Array<string>} codes Accessorial codes.
 * @return {string}
 */
function formatCreateRuleName(topic, codes) {
  const labels = (codes || []).map((c) => {
    const label = ACCESSORIAL_LABELS[String(c)];
    return label ? String(label).toLowerCase() : String(c);
  });
  const base = (topic && topic.name) || "Site rule";
  return labels.length ? `${base} — ${labels.join(", ")}` : base;
}

/**
 * Infer site-type / rule id from create-flow chat history.
 * @param {Array<object>} messages Chat turns.
 * @return {object} ruleId, name, siteType?, flags?, notes
 */
function inferCreateTopic(messages) {
  const blob = userTopicBlob(messages);
  if (isMilitaryTopicBlob(blob)) {
    return {
      ruleId: "aafes_military",
      name: "Military bases",
      siteType: "aafes_military",
      notes: "AI-classified military base / AAFES delivery location.",
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
  if (/\b(walmart|target|costco|safeway|albertsons?|albersons)\b/
      .test(blob) ||
    /\b(tj\s*maxx|chain\s*stores?)\b/.test(blob)) {
    return {
      ruleId: "chain_store_appointment",
      name: "Chain stores",
      siteType: "chain_store",
      notes: "Big-box / grocery chain store.",
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
  if (!Object.keys(match).length) {
    return {
      reply: "I need a site type to match before I can propose that rule. " +
        "Known types: aafes_military (military bases / AAFES), " +
        "nursing_home, hotel, amazon_fc, menards_dc, chain_store, " +
        "residential. " +
        "Which site should this apply to?",
      action: "none",
      proposal: null,
      quickReplies: [],
    };
  }
  const name = formatCreateRuleName(topic, codes);
  const labels = codes.map((c) => ACCESSORIAL_LABELS[c] || c).join(", ");
  return {
    reply: `Here's a proposed rule for ${topic.name} that adds ` +
      `${labels} (identified via AI site classification, ` +
      `match.siteType ${match.siteType || "flags"}). ` +
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
  void out;
  // Always use the deterministic proposal. Merging the model patch allowed
  // empty match {} / custom_site_rule when the LLM missed siteType.
  const built = buildAddressOnlyCreateProposal(
      messages, extras.accessorials || []);
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
              .test(text.trim()) &&
          !looksLikeMilitaryAccessorialIntent(messages) &&
          !isMetaFollowUpText(text)) {
        emailSignalsListed = true;
      }
    }
  }

  // Military / nursing / hotel are address+AI site types. Do not treat
  // "can you add appointment for military" as an email-identify choice.
  if (!source && isClearlySiteTypeTopic(messages) &&
      !userAskedForEmailIdentify(messages)) {
    source = "address_only";
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
 * Latest non-assistant turn.
 * @param {Array<object>} messages Chat turns.
 * @return {object|null}
 */
function lastUserTurn(messages) {
  return [...(messages || [])].reverse()
      .find((m) => m && m.role !== "assistant") || null;
}

/**
 * True when the latest user message looks like a create/add rule request.
 * Delete/remove phrasing is never treated as create (including "delete all
 * rules for militery bases").
 * @param {Array<object>} messages Chat turns.
 * @return {boolean}
 */
function looksLikeCreateRuleIntent(messages) {
  if (looksLikeDeleteRuleIntent(messages)) return false;
  const lastUser = lastUserTurn(messages);
  if (!lastUser) return false;
  const t = String(lastUser.content || "").toLowerCase();
  const addVerb = "\\b(a+dd|addd?|create|new|make|set\\s*up|setup|include)\\b";
  const createAccessorialRe = new RegExp(
      "\\b(whenever|when|for)\\b.{0,80}" +
      "\\b(a+dd|addd?|include|require|also)\\b" +
      ".{0,40}\\b(accessorial|liftgate|appointment|nursing|hotel|" +
      "residential|school)",
      "i",
  );
  return new RegExp(addVerb + ".{0,40}\\brule\\b", "i").test(t) ||
    /\brule\b.{0,40}\b(add|create|new)\b/.test(t) ||
    new RegExp(
        addVerb + ".{0,80}\\b(mil+i?t+[ae]r+y|limited\\s*ac+ess)\\b",
        "i").test(t) ||
    createAccessorialRe.test(t) ||
    looksLikeMilitaryAccessorialIntent(messages);
}

/**
 * True when the latest user message is a delete/remove request.
 * Accepts typos (militery, millitary) and short forms ("remove military",
 * "delete aafes").
 * @param {Array<object>} messages Chat turns.
 * @return {boolean}
 */
function looksLikeDeleteRuleIntent(messages) {
  const lastUser = lastUserTurn(messages);
  if (!lastUser) return false;
  const t = String(lastUser.content || "").toLowerCase().trim();
  if (!t || /^\[applied\]/.test(t)) return false;
  const hasVerb = /\b(delete|remove|drop|clear|erase|uninstall)\b/.test(t) ||
    /\bget rid of\b/.test(t);
  if (!hasVerb) return false;
  return /\brules?\b/.test(t) ||
    /\baafes\b/.test(t) ||
    isMilitaryTopicBlob(t) ||
    /\b(nursing(\s+home)?s?|hotels?|amazon|menards?|residential)\b/.test(t);
}

/**
 * Whether a live rule is a military / AAFES rule.
 * @param {object} rule Rule doc.
 * @return {boolean}
 */
function ruleLooksMilitary(rule) {
  if (!rule) return false;
  const id = String(rule.id || "").toLowerCase();
  const name = String(rule.name || "").toLowerCase();
  const notes = String(rule.notes || "").toLowerCase();
  const siteType = String((rule.match && rule.match.siteType) || "")
      .toLowerCase();
  if (id === "aafes_military" || siteType === "aafes_military") return true;
  return isMilitaryTopicBlob(`${id} ${name} ${notes} ${siteType}`) ||
    /\baafes\b/.test(`${id} ${name} ${notes}`);
}

/**
 * Live rules that match the user's delete topic.
 * @param {Array<object>} existingRules Live rules.
 * @param {string} text Latest user text.
 * @return {Array<object>}
 */
function findRulesForDeleteTopic(existingRules, text) {
  const t = String(text || "").toLowerCase();
  const live = (existingRules || []).filter((r) => r && r.active !== false);
  if (isMilitaryTopicBlob(t) || /\baafes\b/.test(t)) {
    return live.filter(ruleLooksMilitary);
  }
  if (/\bnursing(\s+home)?s?\b/.test(t)) {
    return live.filter((r) => {
      const id = String(r.id || "");
      const site = String((r.match && r.match.siteType) || "");
      return id === "nursing_home" || site === "nursing_home" ||
        /\bnursing/.test(String(r.name || "").toLowerCase());
    });
  }
  if (/\bhotels?\b/.test(t)) {
    return live.filter((r) => {
      const id = String(r.id || "");
      const site = String((r.match && r.match.siteType) || "");
      return id === "hotel" || site === "hotel" ||
        /\bhotel/.test(String(r.name || "").toLowerCase());
    });
  }
  if (/\bamazon\b/.test(t)) {
    return live.filter((r) => String(r.id || "") === "amazon_fc" ||
      String((r.match && r.match.siteType) || "") === "amazon_fc");
  }
  if (/\bmenards?\b/.test(t)) {
    return live.filter((r) => String(r.id || "") === "menards_dc" ||
      String((r.match && r.match.siteType) || "") === "menards_dc");
  }
  if (/\bresidential\b/.test(t)) {
    return live.filter((r) => String(r.id || "") === "residential_delivery");
  }
  const idHit = live.filter((r) => {
    const id = String(r.id || "").toLowerCase();
    return id && (t.includes(id) || t.includes(id.replace(/_/g, " ")));
  });
  return idHit;
}

/**
 * Deterministic delete proposal so we never fall through to the create
 * identify gate or the generic "could not process" LLM fallback.
 * @param {Array<object>} messages Chat turns.
 * @param {Array<object>} existingRules Live rules.
 * @return {object|null}
 */
function buildDeleteRuleProposal(messages, existingRules) {
  if (!looksLikeDeleteRuleIntent(messages)) return null;
  const lastUser = lastUserTurn(messages);
  const text = lastUser ? String(lastUser.content || "") : "";
  const matches = findRulesForDeleteTopic(existingRules, text);
  if (!matches.length) {
    const t = text.toLowerCase();
    if (isMilitaryTopicBlob(t) || /\baafes\b/.test(t)) {
      return {
        reply: "There are no live military / AAFES rules to delete.",
        action: "none",
        proposal: null,
        quickReplies: [],
      };
    }
    return {
      reply: "I couldn't find a matching live rule to delete. " +
        "Name the rule id or site (for example aafes_military, " +
        "military bases, Amazon).",
      action: "none",
      proposal: null,
      quickReplies: [],
    };
  }
  const ids = [...new Set(matches.map((r) => String(r.id)))];
  const primary = matches.find((r) => r.id === "aafes_military") || matches[0];
  const labels = matches.map((r) =>
    `"${r.name || r.id}" (${r.id})`).join(", ");
  const reply = ids.length === 1 ?
    `I'll delete the rule ${labels}. Click Confirm to apply the deletion.` :
    `I'll delete all ${ids.length} matching rules: ${labels}. ` +
      "Click Confirm to apply the deletion.";
  return {
    reply,
    action: "propose_delete_rule",
    proposal: {
      ruleId: String(primary.id),
      deleteRuleId: String(primary.id),
      deleteRuleIds: ids,
    },
    quickReplies: [],
  };
}

/**
 * Merge accessorial code lists, preserving order.
 * @param {Array<string>} existing Existing codes.
 * @param {Array<string>} extra Codes to add.
 * @return {Array<string>}
 */
function mergeAccessorialCodes(existing, extra) {
  const out = [];
  const seen = new Set();
  for (const c of [...(existing || []), ...(extra || [])]) {
    const u = String(c || "").toUpperCase();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/**
 * Codes implied by a military add/update request.
 * @param {Array<object>} messages Chat turns.
 * @return {Array<string>}
 */
function codesFromMilitaryIntent(messages) {
  const extras = collectCreateAccessorials(messages);
  const codes = extras.accessorials.slice();
  const blob = userTopicBlob(messages);
  const wantsApd = /\b(apd|appointments?)\b/.test(blob) ||
    /\b(delivery|dest(ination)?)\s+appointments?\b/.test(blob);
  const wantsLad = /\b(lad|limited\s*ac+ess)\b/.test(blob);
  if (wantsApd && !codes.includes("APD")) codes.push("APD");
  if (wantsLad && !codes.includes("LAD")) codes.push("LAD");
  return codes;
}

/**
 * Create or update the military site rule with APD/LAD. Skips the
 * email-identify questionnaire — military is address/AI siteType.
 * @param {Array<object>} messages Chat turns.
 * @param {Array<object>} existingRules Live rules.
 * @return {object|null}
 */
function buildMilitaryAccessorialProposal(messages, existingRules) {
  if (!looksLikeMilitaryAccessorialIntent(messages)) return null;
  let codes = codesFromMilitaryIntent(messages);
  const live = (existingRules || []).find((r) =>
    r && r.active !== false && ruleLooksMilitary(r));
  if (live) {
    if (!codes.length) codes = ["APD"];
    const merged = mergeAccessorialCodes(live.addAccessorials, codes);
    const topic = {name: "Military bases"};
    const name = formatCreateRuleName(topic, merged);
    const labels = merged.map((c) => ACCESSORIAL_LABELS[c] || c).join(", ");
    const match = live.match && typeof live.match === "object" &&
      Object.keys(live.match).length ?
      live.match : {siteType: "aafes_military"};
    return {
      reply: `I'll update "${live.name}" (${live.id}) so it adds ` +
        `${labels} (match.siteType aafes_military, identified via ` +
        `AI / address). Click Confirm to apply it.`,
      action: "propose_update_rule",
      proposal: {
        ruleId: String(live.id),
        patch: {
          active: true,
          priority: live.priority || 25,
          name,
          identifyVia: live.identifyVia || "ai",
          match,
          addAccessorials: merged,
          notes: "AI-classified military base / AAFES — " +
            "limited access and appointment delivery.",
          autoApply: live.autoApply !== false,
          requiresConfirm: !!live.requiresConfirm,
        },
      },
      quickReplies: [],
    };
  }
  if (!codes.includes("LAD")) codes.unshift("LAD");
  if (!codes.includes("APD")) codes.push("APD");
  return buildAddressOnlyCreateProposal(messages, codes);
}

/**
 * Extract email addresses from freeform text.
 * @param {string} text User text.
 * @return {Array<string>} Lowercase unique emails.
 */
function extractEmailsFromText(text) {
  const raw = String(text || "");
  const found = raw.match(/[\w.+-]+@[\w.-]+\.\w+/g) || [];
  const out = [];
  const seen = new Set();
  for (const e of found) {
    const lower = String(e).trim().toLowerCase();
    if (!lower || seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

/**
 * Extract @domain needles from text.
 * @param {string} text User text.
 * @return {Array<string>} Domains without @.
 */
function extractSenderDomainsFromText(text) {
  const raw = String(text || "");
  const out = [];
  const seen = new Set();
  const re = /@([a-z0-9.-]+\.[a-z]{2,})\b/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const d = String(m[1] || "").toLowerCase();
    if (!d || seen.has(d)) continue;
    // Skip if this is part of a full email we already treat as fromEmails.
    seen.add(d);
    out.push(d);
  }
  // Only keep domains that were mentioned as domain-only (not email).
  // If the only @ hits are full emails, still return their domains when
  // the user said "domain" / "@company.com" without a local-part intent.
  if (/\b(domain|sender domain|anyone@|any\s*@)\b/i.test(raw)) {
    return out;
  }
  // Domain-only tokens like "@ediexpressinc.com" without a local part.
  const bare = [];
  const bareRe = /(?:^|[\s(,])@([a-z0-9.-]+\.[a-z]{2,})\b/gi;
  let bm;
  while ((bm = bareRe.exec(raw)) !== null) {
    const d = String(bm[1] || "").toLowerCase();
    if (d && !bare.includes(d)) bare.push(d);
  }
  return bare;
}

/**
 * Parse optional default dims (e.g. 40x48x62).
 * @param {string} text User text.
 * @return {object|null} `{length,width,height}` or null.
 */
function parseDefaultDimsFromText(text) {
  const t = String(text || "");
  const m = t.match(
      /\b(\d{2})\s*[x×*]\s*(\d{2})\s*[x×*]\s*(\d{2,3})\b/i);
  if (!m) return null;
  return {
    length: Number(m[1]),
    width: Number(m[2]),
    height: Number(m[3]),
  };
}

/**
 * True when user wants protocol-only customer attach.
 * @param {string} text User text.
 * @return {boolean}
 */
function parseProtocolOnlyFromText(text) {
  const t = String(text || "").toLowerCase();
  return /\bprotocol[\s-]*only\b/.test(t) ||
    /\bonly\s+protocol\b/.test(t) ||
    /\bprotocol\s+pricing\b/.test(t);
}

/**
 * True when user wants the mapping to also fire on Cc/To (not only From).
 * @param {string} text User text.
 * @return {boolean}
 */
function parseMatchCcToFromText(text) {
  const t = String(text || "").toLowerCase();
  return /\bcc'?d\b/.test(t) ||
    /\bon\s+cc\b/.test(t) ||
    /\bin\s+cc\b/.test(t) ||
    /\balso\s+(?:when\s+)?(?:on\s+)?cc\b/.test(t) ||
    /\bwhen\s+(?:cc|to)\b/.test(t) ||
    /\bcc\s*(?:\/|or)\s*to\b/.test(t) ||
    /\bto\s*(?:\/|or)\s*cc\b/.test(t) ||
    /\b(cc|to)\s+and\s+(cc|to)\b/.test(t) ||
    /\bparticipant\b/.test(t) ||
    /\balso\s+match\s+(?:cc|to)\b/.test(t);
}

/**
 * Guess customer name from mapping phrasing.
 * @param {string} text User text.
 * @param {Array<string>} emails Emails already found (strip from name).
 * @return {string}
 */
function parseCustomerNameFromSenderText(text, emails) {
  let t = String(text || "").replace(/\s+/g, " ").trim();
  for (const e of emails || []) {
    t = t.replace(new RegExp(e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"),
        " ");
  }
  t = t.replace(/\bprotocol[\s-]*only\b/ig, " ");
  t = t.replace(/\bdefault\s+dims?\b[^.]*$/ig, " ");
  t = t.replace(/\b\d{2}\s*[x×*]\s*\d{2}\s*[x×*]\s*\d{2,3}\b/ig, " ");
  t = t.replace(/\bwhen\s+missing\b/ig, " ");

  /**
   * @param {string} name Raw capture.
   * @return {string}
   */
  function cleanName(name) {
    let n = String(name || "").trim()
        .replace(/^["'`]+|["'`]+$/g, "")
        .replace(/\b(protocol[\s-]*only|please|thanks)\b/ig, "")
        .replace(/\bdefault\s+dims?\b.*$/ig, "")
        .replace(/\b\d{2}\s*[x×*]\s*\d{2}\s*[x×*]\s*\d{2,3}\b.*$/ig, "")
        .replace(/\bwhen\s+missing\b.*$/ig, "")
        .replace(/[,;:\s]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
    n = n.replace(/\s+and\s+.*$/i, "").trim();
    return n;
  }

  const patterns = [
    new RegExp(
        "\\b(?:map|match)\\s+(?:this\\s+)?(?:email|sender|from)?\\s*" +
        "(?:to|with)\\s+(?:customer\\s+)?(?:name\\s+)?(.+?)(?:\\.|$)",
        "i"),
    /\b(?:use|to)\s+customer\s+(?:name\s+)?(.+?)(?:\.|$)/i,
    /\b(?:customer|account)\s*(?:name)?\s*[:=]\s*(.+?)(?:\.|$)/i,
    /(?:^|[\s:])(?:to|→|->|=>)\s+([A-Z][\w .&'-]{2,80})(?:[,.]|$)/,
    /\bfor\s+customer\s+(.+?)(?:\.|$)/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m && m[1]) {
      const name = cleanName(m[1]);
      if (name.length >= 2 && !/@/.test(name)) return name;
    }
  }

  // "mike.oseback@… to Mike Oseback" / "Jared … → Brumis Imports Inc"
  const arrow = String(text || "").match(
      /@[\w.-]+\s+(?:to|→|->|as)\s+(.+?)(?:\.|$)/i);
  if (arrow && arrow[1]) {
    const name = cleanName(arrow[1]);
    if (name.length >= 2 && !/@/.test(name)) return name;
  }
  return "";
}

/**
 * Build a stable snake_case rule id from customer / email.
 * @param {string} customerName Customer.
 * @param {Array<string>} emails Emails.
 * @return {string}
 */
function senderRuleIdFromParts(customerName, emails) {
  const fromName = String(customerName || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 40);
  if (fromName) return `sender_${fromName}`;
  const local = String((emails && emails[0]) || "custom")
      .split("@")[0]
      .replace(/[^a-z0-9]+/g, "_")
      .slice(0, 30);
  return `sender_${local || "custom"}`;
}

/**
 * Infer sender→customer mapping fields from chat history.
 * @param {Array<object>} messages Chat turns.
 * @return {object|null}
 */
function inferSenderCustomerTopic(messages) {
  const blob = (messages || [])
      .filter((m) => m && m.role !== "assistant")
      .map((m) => String(m.content || ""))
      .join("\n");
  if (!blob.trim()) return null;
  const emails = extractEmailsFromText(blob);
  const domains = extractSenderDomainsFromText(blob);
  // Prefer domain-only when user said domain and we have no useful email
  // local-part intent — still allow emails when present.
  const customerName = parseCustomerNameFromSenderText(blob, emails);
  const protocolOnly = parseProtocolOnlyFromText(blob);
  const matchCcTo = parseMatchCcToFromText(blob);
  const defaultDims = parseDefaultDimsFromText(blob);
  if (!emails.length && !domains.length) return null;
  if (!customerName && !defaultDims) return null;
  return {
    emails,
    domains,
    customerName,
    protocolOnly,
    matchCcTo,
    defaultDims,
  };
}

/**
 * User wants a sender email → Primus customer rule (not accessorials).
 * @param {Array<object>} messages Chat turns.
 * @return {boolean}
 */
function looksLikeSenderCustomerIntent(messages) {
  if (looksLikeDeleteRuleIntent(messages)) return false;
  if (looksLikeMilitaryAccessorialIntent(messages)) return false;
  const last = lastUserTurn(messages);
  const lastText = last ? String(last.content || "") : "";
  if (!lastText || /^\[applied\]/i.test(lastText.trim())) return false;
  if (isMetaFollowUpText(lastText)) {
    // Fall back to full user blob for "i asked you…" after a sender request.
    const blob = userTopicBlob(messages);
    return /\b(map|match).{0,40}\b(email|sender)\b/.test(blob) ||
      /\b(when|from).{0,40}@/.test(blob) ||
      /\bsender\b.{0,40}\bcustomer\b/.test(blob) ||
      /\bprotocol[\s-]*only\b/.test(blob);
  }
  const t = lastText.toLowerCase();
  const hasEmail = extractEmailsFromText(lastText).length > 0 ||
    extractSenderDomainsFromText(lastText).length > 0;
  const mappingVerb =
    /\b(map|match|tie|link|route|assign)\b/.test(t) ||
    /\buse\s+customer\b/.test(t) ||
    /\bwhen\s+(email\s+)?from\b/.test(t) ||
    /\bfrom\s+emails?\b/.test(t) ||
    /\bsender\b/.test(t) ||
    /\bprotocol[\s-]*only\b/.test(t) ||
    parseMatchCcToFromText(lastText) ||
    (/\bcustomer\b/.test(t) && /@/.test(lastText));
  if (hasEmail && mappingVerb) return true;
  if (hasEmail && /(?:\bto\b|→|->|=>)/.test(lastText) &&
      /\b(customer|imports|inc|llc|protocol|brumis)\b/i.test(lastText)) {
    return true;
  }
  // Full conversation already established a sender mapping mid-flow.
  const topic = inferSenderCustomerTopic(messages);
  if (topic && (topic.emails.length || topic.domains.length) &&
      (topic.customerName || topic.defaultDims)) {
    if (mappingVerb || /(?:\bto\b|→|->|=>)/.test(lastText) ||
        /\bprotocol[\s-]*only\b/.test(t) ||
        /\bdefault\s+dims?\b/.test(t)) {
      return true;
    }
  }
  return false;
}

/**
 * Find an existing sender rule that overlaps emails/domains/customer.
 * @param {Array<object>} existingRules Live rules.
 * @param {object} topic Inferred topic.
 * @return {object|null}
 */
function findExistingSenderRule(existingRules, topic) {
  const emails = new Set((topic.emails || []).map((e) => e.toLowerCase()));
  const domains = new Set((topic.domains || []).map((d) => d.toLowerCase()));
  const wantName = String(topic.customerName || "").trim().toLowerCase();
  for (const r of existingRules || []) {
    if (!r || r.active === false) continue;
    const match = r.match && typeof r.match === "object" ? r.match : {};
    const ruleEmails = []
        .concat(match.fromEmails || [])
        .concat(match.senderEmails || [])
        .concat(match.ccEmails || [])
        .concat(match.toEmails || [])
        .map((e) => String(e || "").toLowerCase());
    const ruleDomains = []
        .concat(match.senderDomains || [])
        .map((d) => String(d || "").toLowerCase().replace(/^@/, ""));
    const emailHit = ruleEmails.some((e) => emails.has(e));
    const domainHit = ruleDomains.some((d) => domains.has(d));
    const nameHit = wantName &&
      String(r.customerName || "").trim().toLowerCase() === wantName;
    const kindHit = r.ruleKind === RULE_KIND_SENDER_CUSTOMER ||
      r.identifyVia === "email";
    if ((emailHit || domainHit || (nameHit && kindHit)) &&
        (kindHit || emailHit || domainHit)) {
      return r;
    }
  }
  return null;
}

/**
 * Deterministic create/update proposal for sender→customer mapping.
 * Skips site-type / accessorial questionnaire.
 * @param {Array<object>} messages Chat turns.
 * @param {Array<object>} existingRules Live rules.
 * @return {object|null}
 */
function buildSenderCustomerProposal(messages, existingRules) {
  if (!looksLikeSenderCustomerIntent(messages)) return null;
  const topic = inferSenderCustomerTopic(messages);
  if (!topic || (!topic.emails.length && !topic.domains.length)) {
    return {
      reply: "I can map a sender email (or @domain) to a Primus customer. " +
        "Please include the From address and the customer name " +
        "(optional: protocol only, default dims like 40×48×62).",
      action: "none",
      proposal: null,
      quickReplies: [],
    };
  }
  if (!topic.customerName && !topic.defaultDims) {
    return {
      reply: "Got the sender email — which Primus customer name should " +
        "we attach? You can also say protocol only or default dims " +
        "(e.g. 40×48×62).",
      action: "none",
      proposal: null,
      quickReplies: [],
    };
  }

  const live = findExistingSenderRule(existingRules || [], topic);
  const emails = topic.emails.slice();
  const domains = topic.domains.filter((d) =>
    !emails.some((e) => e.endsWith("@" + d)));
  const match = {};
  if (emails.length) match.fromEmails = emails;
  if (domains.length) match.senderDomains = domains;
  const liveMatch = live && live.match && typeof live.match === "object" ?
    live.match : {};
  const liveHasCcTo =
    (Array.isArray(liveMatch.ccEmails) && liveMatch.ccEmails.length > 0) ||
    (Array.isArray(liveMatch.toEmails) && liveMatch.toEmails.length > 0);
  const matchCcTo = !!(topic.matchCcTo || liveHasCcTo);
  if (matchCcTo && emails.length) {
    match.ccEmails = emails.slice();
    match.toEmails = emails.slice();
  }

  const customerName = topic.customerName ||
    (live && live.customerName) || "";
  const protocolOnly = topic.protocolOnly ||
    !!(live && live.protocolOnly);
  const defaultDims = topic.defaultDims ||
    (live && live.defaultDims) || null;

  const ruleId = live ? String(live.id) :
    senderRuleIdFromParts(customerName, emails);
  const name = customerName ?
    `Sender → ${customerName}` :
    (live && live.name) || "Sender customer rule";

  const bits = [];
  if (emails.length) bits.push(`From ${emails.join(", ")}`);
  if (matchCcTo && emails.length) {
    bits.push(`also Cc/To ${emails.join(", ")}`);
  }
  if (domains.length) {
    bits.push(`domain ${domains.map((d) => "@" + d).join(", ")}`);
  }
  if (customerName) bits.push(`customer "${customerName}"`);
  if (protocolOnly) bits.push("protocol only");
  if (defaultDims) {
    bits.push(
        `default dims ${defaultDims.length}×${defaultDims.width}×` +
        `${defaultDims.height} when missing`);
  }

  const patch = {
    active: true,
    priority: (live && live.priority) || 5,
    name,
    ruleKind: RULE_KIND_SENDER_CUSTOMER,
    identifyVia: "email",
    match,
    customerName: customerName || undefined,
    protocolOnly: !!protocolOnly,
    addAccessorials: [],
    notes: protocolOnly ?
      (matchCcTo ?
        "Sender From/Cc/To maps to Primus customer (protocol only)." :
        "Sender email maps to Primus customer (protocol only).") :
      (matchCcTo ?
        "Sender From/Cc/To maps to Primus customer." :
        "Sender email maps to Primus customer."),
    autoApply: true,
    requiresConfirm: false,
  };
  if (defaultDims) patch.defaultDims = defaultDims;

  return {
    reply: `Here's a sender→customer rule: ${bits.join("; ")}. ` +
      (matchCcTo ?
        "Identified via From/Cc/To email (no site-type / accessorials). " :
        "Identified via From email (no site-type / accessorials). ") +
      "Click Confirm to apply it.",
    action: live ? "propose_update_rule" : "propose_create_rule",
    proposal: {ruleId, patch},
    quickReplies: [],
  };
}

/**
 * Enforce identify questionnaire before create proposals.
 * @param {object} result Model JSON result.
 * @param {Array} messages Chat history including latest user turn.
 * @param {Array<object>=} existingRules Live rules.
 * @return {object}
 */
function enforceCreateIdentifyGate(result, messages, existingRules) {
  const out = result && typeof result === "object" ? {...result} : {
    reply: fallbackUnclearReply(messages),
    action: "none",
    proposal: null,
  };
  const action = out.action || "none";
  // Delete/remove never belongs in the create identify questionnaire.
  // A leftover ready/address_only gate from an earlier add must not
  // swallow "delete all rules for militery bases".
  if (looksLikeDeleteRuleIntent(messages)) {
    if (action === "propose_delete_rule") return out;
    if (/could not process|try rephrasing/i.test(String(out.reply || ""))) {
      out.reply = "Tell me which rule to delete (id or site, " +
        "e.g. military bases / AAFES). I will propose a deletion " +
        "for you to Confirm.";
      out.action = "none";
      out.proposal = null;
      out.quickReplies = [];
    }
    return out;
  }
  const militaryOut = buildMilitaryAccessorialProposal(
      messages, existingRules || []);
  if (militaryOut) return militaryOut;
  const senderOut = buildSenderCustomerProposal(
      messages, existingRules || []);
  if (senderOut) return senderOut;

  const gate = detectCreateIdentifyGate(messages);
  const extras = collectCreateFlowExtras(messages);
  const lastUser = lastUserTurn(messages);
  const lastText = lastUser ? String(lastUser.content || "") : "";
  const lastIsAccessorials = !!(lastUser &&
      parseAccessorialsAnswer(lastUser.content).length);
  const lastIsIdentifyAnswer = !!parseIdentifyChoiceAnswer(lastText);
  const lastIsMeta = isMetaFollowUpText(lastText);
  // Only stay in the questionnaire for a real identify/accessorial
  // answer — leftover "ready" must not steal "i asked you something".
  const inIdentifyFlow =
    (gate.status === "awaiting_choice" && lastIsIdentifyAnswer) ||
    (gate.status === "awaiting_email_signals" &&
      !looksLikeMilitaryAccessorialIntent(messages) && !lastIsMeta) ||
    (gate.status === "ready" && gate.source === "address_only" &&
      (lastIsAccessorials || lastIsIdentifyAnswer)) ||
    (extras.askedAccessorials && lastIsAccessorials) ||
    (gate.status === "needed" && looksLikeCreateRuleIntent(messages) &&
      !isClearlySiteTypeTopic(messages));
  const creating = action === "propose_create_rule" ||
    looksLikeCreateRuleIntent(messages) ||
    inIdentifyFlow;

  // Mid create-flow (Cannot-be + accessorials): don't let a mis-tagged
  // update/delete skip the deterministic create proposal.
  // Sender→customer mappings never enter the site/accessorial questionnaire.
  if (looksLikeSenderCustomerIntent(messages)) {
    const forced = buildSenderCustomerProposal(
        messages, existingRules || []);
    if (forced) return forced;
  }

  const addressOnlyReady = gate.status === "ready" &&
    gate.source === "address_only";
  if (action === "propose_update_rule" ||
      action === "propose_delete_rule") {
    if (!(addressOnlyReady && extras.accessorials.length &&
        lastIsAccessorials)) {
      return out;
    }
  }

  if (!creating && action !== "ask_identify_source" &&
      action !== "ask_email_signals") {
    return out;
  }

  // Never ask LAD/APD / site-type for sender email mapping.
  if (looksLikeSenderCustomerIntent(messages)) {
    return buildSenderCustomerProposal(messages, existingRules || []) || out;
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
      if (action === "propose_create_rule" ||
          action === "propose_update_rule") {
        return out;
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
      out.reply = fallbackUnclearReply(messages);
      out.action = "none";
      out.proposal = null;
      out.quickReplies = [];
    }
    return out;
  }

  if (gate.status === "awaiting_email_signals" &&
      !looksLikeMilitaryAccessorialIntent(messages) && !lastIsMeta) {
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
  const existingRules = opts.existingRules || [];
  // Obvious delete / military APD+LAD updates skip the model so a leftover
  // identify gate cannot steal the turn.
  const deleteOut = buildDeleteRuleProposal(chatTurns, existingRules);
  if (deleteOut) return deleteOut;
  const militaryOut = buildMilitaryAccessorialProposal(
      chatTurns, existingRules);
  if (militaryOut) return militaryOut;
  const senderOut = buildSenderCustomerProposal(chatTurns, existingRules);
  if (senderOut) return senderOut;

  const gateHint = detectCreateIdentifyGate(chatTurns);
  const last = lastUserTurn(chatTurns);
  const lastText = last ? String(last.content || "") : "";
  const lastIsAcc = parseAccessorialsAnswer(lastText).length > 0;
  const lastIsChoice = !!parseIdentifyChoiceAnswer(lastText);
  // After Cannot-be, only skip the model for a structured accessorial
  // or identify answer. Follow-ups go to gpt-5.6-sol.
  if (gateHint.status === "ready" && gateHint.source === "address_only" &&
      (lastIsAcc || lastIsChoice)) {
    return enforceCreateIdentifyGate({
      reply: "",
      action: "none",
      proposal: null,
    }, chatTurns, existingRules);
  }

  const apiKey = process.env.QUOTE_RULES_CHAT_OPENAI_API_KEY ||
    process.env.SUPPORT_CHAT_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OpenAI API key not configured for quote rules chat");
  }

  const client = new OpenAI({apiKey});
  const model = RULES_CHAT_MODEL;
  const rulesJson = JSON.stringify(
      (opts.existingRules || []).slice(0, 40),
      null,
      0,
  ).slice(0, 8000);

  const systemPrompt = [
    "You help freight dispatchers manage LTL quote accessorial rules",
    "AND sender→customer mapping rules.",
    "Accessorial rules map site types or instructions to Primus codes.",
    "Sender rules map From emails (or @domains) to a Primus customerName,",
    "optional protocolOnly, and optional defaultDims.",
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
    "filterCarrierWarnings, notes, autoApply, requiresConfirm, identifyVia,",
    "ruleKind, customerName, protocolOnly, defaultDims.",
    "match may use: consigneeNameContains, consigneeAddressContains,",
    "instructionsContains, referenceContains, flags, siteType,",
    "fromEmails, senderEmails, senderDomains, ccEmails, toEmails.",
    "",
    "=== Sender email → customer (IMPORTANT) ===",
    "Phrases: map this email to customer X, when email from Y use",
    "customer Z, protocol only, match customer name to that email,",
    "default dims 40x48x62 when missing, also when CC'd / on Cc or To.",
    "→ propose_create_rule (or update) immediately.",
    "identifyVia MUST be \"email\"; ruleKind \"sender_customer\".",
    "match.fromEmails: array of emails (one rule can list many).",
    "Optional match.senderDomains: [\"ediexpressinc.com\"].",
    "When they say CC'd / Cc / To / participant: also set",
    "match.ccEmails and match.toEmails to the same addresses.",
    "Set customerName; protocolOnly true when they say protocol only;",
    "defaultDims {length,width,height} when they give missing dims.",
    "addAccessorials: []. Do NOT ask site type, LAD, APD, or the",
    "Can-be / Cannot-be questionnaire for these.",
    "Example ids: sender_mike_oseback, sender_jared_berman,",
    "sender_lifeworks_picking, sender_shaya_jacobowitz /",
    "\"Sender → Mike Oseback\".",
    "NEVER reply \"I could not process that\" for sender mapping.",
    "",
    "=== Follow the user's LAST intent ===",
    "Read the full conversation. Do not restart the identify",
    "questionnaire if they already chose Cannot be, already named",
    "accessorials, or asked to add APD/LAD for a known site type.",
    "\"can you add …\" is a request, NOT the Can-be identify answer.",
    "Typos: militery, millitary, fecileties, facilites, aadd, apointment.",
    "NEVER reply \"I could not process that\" or \"Try rephrasing\".",
    "If unsure, ask one short question (action none) that advances",
    "their last request — do not change the subject.",
    "",
    "=== Military / AAFES / nursing home / hotel are site types ===",
    "These are identified via AI address classification, not email.",
    "Default identifyVia \"ai\" and match.siteType (aafes_military,",
    "nursing_home, hotel). Do NOT ask email-signals for them.",
    "\"add appointment delivery for military facilities\" (and typos)",
    "→ update existing aafes_military or create it with LAD + APD.",
    "Keep LAD if the prior military rule / intent already had it.",
    "If aafes_military is missing from Current active rules JSON,",
    "propose_create_rule to recreate it (tombstones must not block).",
    "",
    "=== Deletes ===",
    "delete/remove/drop (typos militery / millitary, \"remove military\",",
    "\"delete aafes\"): action MUST be propose_delete_rule. Do NOT ask",
    "identify. Ask them to click Confirm; do not claim the rule is gone.",
    "",
    "=== Identify questionnaire (new accessorial rules only) ===",
    "Ask identify ONLY when creating a NEW accessorial/site rule and",
    "it is NOT a known site type and NOT a sender→customer mapping",
    "and they have not already chosen Cannot be. Updates skip this.",
    "Step 1 action ask_identify_source with exactly two quickReplies:",
    "  \"" + QUICK_REPLY_CAN_BE + "\"",
    "  \"" + QUICK_REPLY_CANNOT_BE + "\"",
    "User may answer 1, 2, A, B, can, cannot, can be, cannot be, or the",
    "button text. Those are definitive — do not re-ask.",
    "CAN BE (email): ask_email_signals; only use signals they list;",
    "identifyVia address_text or both.",
    "CANNOT BE: identifyVia ai; match.siteType and/or flags; never",
    "invent email keywords; never match: {}.",
    "Known siteType: nursing_home, hotel, amazon_fc, menards_dc,",
    "aafes_military, chain_store, residential, other.",
    "Codes: LAD LFD APD RSD NUD LTD LFO HOD SCD INS; \"limited access\";",
    "LOAD = LAD; \"delivery appointment\" = APD.",
    "",
    "Current questionnaire state from chat history:",
    `  status=${gateHint.status}; source=${gateHint.source || "null"};`,
    `  emailSignalsListed=${gateHint.emailSignalsListed};`,
    `  askedAccessorials=${!!gateHint.askedAccessorials};`,
    `  accessorials=${(gateHint.accessorials || []).join(",") || "none"};`,
    `  siteType=${gateHint.siteType || "null"}`,
    "If they already chose cannot-be (source=address_only) or the",
    "topic is a site type, do NOT ask identify or email-signals.",
    "If accessorials are listed, propose now.",
    "",
    "identifyVia values:",
    "  email — sender From address / domain → customer mapping.",
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
    "For propose_create_rule: patch MUST include name and a NON-EMPTY",
    "match (siteType and/or flags for address-only; text needles for email;",
    "fromEmails/senderDomains for sender→customer).",
    "Never use match: {}.",
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
    "If unclear, ask one short clarifying question with action none.",
  ].join("\n");

  const messages = [
    {role: "system", content: systemPrompt},
    ...(opts.messages || []).slice(-30).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 4000),
    })),
  ];

  const completion = await client.chat.completions.create({
    model,
    max_completion_tokens: 1600,
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
      reply: raw || fallbackUnclearReply(opts.messages || []),
      action: "none",
      proposal: null,
    };
  }

  return enforceCreateIdentifyGate(
      parsed, opts.messages || [], existingRules);
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
  if (Object.prototype.hasOwnProperty.call(patch, "ruleKind")) {
    normalized.ruleKind = String(patch.ruleKind || "");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "customerName")) {
    normalized.customerName = String(patch.customerName || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, "protocolOnly")) {
    normalized.protocolOnly = !!patch.protocolOnly;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "defaultDims") &&
      patch.defaultDims && typeof patch.defaultDims === "object") {
    normalized.defaultDims = {
      length: Number(patch.defaultDims.length) || undefined,
      width: Number(patch.defaultDims.width) || undefined,
      height: Number(patch.defaultDims.height) || undefined,
    };
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
  if (patch.ruleKind) {
    normalized.ruleKind = String(patch.ruleKind);
  }
  if (patch.customerName != null && String(patch.customerName).trim()) {
    normalized.customerName = String(patch.customerName).trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, "protocolOnly")) {
    normalized.protocolOnly = !!patch.protocolOnly;
  }
  if (patch.defaultDims && typeof patch.defaultDims === "object") {
    normalized.defaultDims = {
      length: Number(patch.defaultDims.length) || undefined,
      width: Number(patch.defaultDims.width) || undefined,
      height: Number(patch.defaultDims.height) || undefined,
    };
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
    const nested = proposal.proposal && typeof proposal.proposal === "object" ?
      proposal.proposal : {};
    const listed = []
        .concat(proposal.deleteRuleIds || [])
        .concat(nested.deleteRuleIds || [])
        .concat(proposal.deleteRuleId || [])
        .concat(proposal.ruleId || [])
        .concat(nested.deleteRuleId || [])
        .concat(nested.ruleId || [])
        .concat(proposal.patch && proposal.patch.deleteRuleId || [])
        .concat(proposal.patch && proposal.patch.ruleId || []);
    const ids = [...new Set(listed.map((x) => String(x || "").trim())
        .filter(Boolean))];
    if (!ids.length) return {ok: false, error: "Missing rule id to delete"};
    return {ok: true, action: "delete", ruleId: ids[0], ruleIds: ids};
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

  if (Object.prototype.hasOwnProperty.call(normalized, "match")) {
    const match = normalized.match;
    if (!match || typeof match !== "object" || !Object.keys(match).length) {
      return {ok: false, error: "Rule match cannot be empty"};
    }
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
  inferCreateTopic,
  looksLikeDeleteRuleIntent,
  looksLikeCreateRuleIntent,
  looksLikeMilitaryAccessorialIntent,
  looksLikeSenderCustomerIntent,
  buildDeleteRuleProposal,
  buildMilitaryAccessorialProposal,
  buildSenderCustomerProposal,
  inferSenderCustomerTopic,
  isMilitaryTopicBlob,
  RULES_CHAT_MODEL,
  IDENTIFY_QUICK_REPLIES,
  QUICK_REPLY_CAN_BE,
  QUICK_REPLY_CANNOT_BE,
};
