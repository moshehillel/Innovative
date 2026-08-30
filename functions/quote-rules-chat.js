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
  RULE_KIND_ZIP_FILL,
} = require("./quote-accessorial-rules");

// Default gpt-5.6-luna for freeform rule chat. Override via env.
const RULES_CHAT_MODEL = process.env.QUOTE_RULES_CHAT_MODEL || "gpt-5.6-luna";
/** Max turns sent to the model (full session when shorter). */
const RULES_CHAT_MAX_TURNS = 50;

const PATCH_FIELDS = [
  "active",
  "priority",
  "name",
  "match",
  "addAccessorials",
  "removeAccessorials",
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
  "fillZipCode",
  "applyTo",
];

const QUICK_REPLY_CAN_BE =
  "Can be identified from the email";
const QUICK_REPLY_CANNOT_BE =
  "Cannot be — address / site classification only";

const IDENTIFY_QUICK_REPLIES = [
  QUICK_REPLY_CAN_BE,
  QUICK_REPLY_CANNOT_BE,
];

/** Loose normalize for NL confirm/reject matching. */
function normalizeChatAnswerText(text) {
  return String(text || "")
      .trim()
      .replace(/^\*{1,3}\s*/, "")
      .replace(/\s*\*{1,3}$/, "")
      .replace(/^`+|`+$/g, "")
      .toLowerCase()
      .replace(/[\u2010-\u2015\u2212]/g, "-")
      .replace(/[^\w\s'-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
}

/**
 * User declined or wants to change a pending proposal.
 * @param {string} text User message.
 * @return {boolean}
 */
function parseNaturalRejection(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  const norm = normalizeChatAnswerText(raw);
  if (/^(no|nope|nah|cancel|stop|wait|hold on|nevermind|never mind)\.?$/i
      .test(raw)) {
    return true;
  }
  if (/^(no|nope|nah)[,.\s-]*(wait|stop|hold on)\b/i.test(raw)) {
    return true;
  }
  if (/\b(not quite|not right|that'?s wrong|wrong rule|change (it|that)|hold on|wait a sec)\b/
      .test(norm)) {
    return true;
  }
  return /\b(don'?t|do not)\s+(apply|save|confirm|do that)\b/.test(norm) ||
    (/\b(cancel|scratch that|forget it)\b/.test(norm) && norm.length <= 80);
}

/**
 * Natural-language confirmation — like ChatGPT/Cursor, not exact "yes".
 * @param {string} text User message.
 * @param {{pendingProposal?: boolean}=} opts Context hints.
 * @return {boolean}
 */
function parseNaturalConfirmation(text, opts) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (looksLikeRuleRefinement(raw)) return false;
  if (parseNaturalRejection(raw)) return false;
  const norm = normalizeChatAnswerText(raw);

  const exactAffirm = new RegExp(
      "^(" +
      "yes|yep|yeah|yea|yup|ok|okay|k|sure|correct|right|exactly|perfect|" +
      "absolutely|definitely|confirmed|confirm|apply|proceed|go ahead|do it|" +
      "save it|looks good|sounds good|that works|please do|please apply|" +
      "go for it|make it so|do that|affirmative|" +
      "that'?s it|that'?s right|that'?s correct|that'?s good|that'?s fine|" +
      "that'?s perfect" +
      ")\\.?$",
      "i",
  );
  if (exactAffirm.test(raw)) return true;

  const phraseAffirm = [
    /\bthat('s| is) (right|correct|it|good|fine|perfect|what i want)\b/,
    /\b(yes|yeah|yep|yup)[,.]?\s*(that('s| is) (right|correct|it)|go ahead|please|do it|apply|save)\b/,
    /\b(go ahead|please apply|please save|please do|please confirm)\b/,
    /\b(sounds|looks) good\b/,
    /\b(i('m| am) good|we('re| are) good)\b/,
    /\bgo for it\b/,
    /\bdo (that|this)\b/,
    /\bapply (that|this|it)\b/,
    /\bsave (that|this|it)\b/,
    /\blet'?s do (it|that)\b/,
    /\bmake it (happen|so)\b/,
    /\byou got it\b/,
    /\bperfect[,.]?\s*(thanks|thank you)?\s*$/,
  ];
  if (phraseAffirm.some((re) => re.test(norm))) return true;

  if (opts && opts.pendingProposal) {
    // Affirm + correction ("yes but only when…") is a refinement, not apply.
    if (/\bbut\b/.test(norm) &&
        /\b(only|when|except|unless|customer|sender|from)\b/.test(norm)) {
      return false;
    }
    if (/^(yes|yep|yeah|yup|ok|okay|sure|right|correct|perfect)\b/i
        .test(norm)) {
      return true;
    }
    if (/\b(yes|yeah|yep)\b/.test(norm) && norm.length <= 40) return true;
  }

  return false;
}

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
 * Normalize chat payload — accepts messages and/or history (full thread).
 * @param {object} opts Request options.
 * @return {Array<object>}
 */
function resolveChatTurns(opts) {
  const raw = (opts && (opts.messages || opts.history)) || [];
  if (!Array.isArray(raw)) return [];
  return raw
      .filter((m) => m && (m.role === "user" || m.role === "assistant"))
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content || ""),
      }));
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
 * Strip dead-end / robotic phrasing from model replies.
 * @param {string} reply Raw reply text.
 * @param {Array<object>} messages Chat turns for fallback context.
 * @return {string}
 */
function sanitizeChatReply(reply, messages) {
  let text = String(reply || "").trim();
  if (!text) return fallbackUnclearReply(messages);
  const bad = [
    /\bi don'?t understand\b/i,
    /\bi do not understand\b/i,
    /\bi couldn'?t understand\b/i,
    /\bi'?m not sure what you mean\b/i,
    /\bi could not process\b/i,
    /\btry rephrasing\b/i,
    /\bplease rephrase\b/i,
    /\bi'?m unable to (help|process)\b/i,
    /\bi can'?t help with that\b/i,
  ];
  if (bad.some((re) => re.test(text))) {
    return fallbackUnclearReply(messages);
  }
  return text;
}

/**
 * Rejection may include a correction ("no, I meant delivery not pickup").
 * @param {string} text User message.
 * @return {{rejected: boolean, correction: string|null}}
 */
function parseRejectionWithCorrection(text) {
  const raw = String(text || "").trim();
  if (!raw) return {rejected: false, correction: null};
  if (looksLikeRuleRefinement(raw)) {
    return {rejected: false, correction: null};
  }
  if (!parseNaturalRejection(raw)) {
    return {rejected: false, correction: null};
  }
  const norm = normalizeChatAnswerText(raw);
  const stripped = raw.replace(/^(no|nope|nah|wait|hold on)[,.!\s-]+/i, "")
      .trim();
  if (stripped.length >= 10 && stripped.toLowerCase() !== raw.toLowerCase()) {
    return {rejected: true, correction: stripped};
  }
  if (/\b(i meant|should be|instead|rather|not pickup|not delivery|wrong)\b/
      .test(norm) && raw.length >= 12) {
    return {rejected: true, correction: raw};
  }
  return {rejected: true, correction: null};
}

/**
 * Friendly reply when user rejects a pending proposal.
 * @param {string|null} correction Optional correction text.
 * @return {string}
 */
function rejectionReply(correction) {
  if (correction) {
    return "Oh sorry — I'll adjust. You said: \"" +
      correction.replace(/"/g, "'") +
      "\". Let me rework that proposal.";
  }
  return "Oh sorry — I'll drop that proposal. What should the rule do instead?";
}

/**
 * Fallback when JSON is empty or the model is unclear. Never "I don't
 * understand" — always ask naturally or propose a guess.
 * @param {Array<object>} messages Chat turns.
 * @return {string}
 */
function fallbackUnclearReply(messages) {
  if (looksLikeSenderCustomerIntent(messages)) {
    const topic = inferSenderCustomerTopic(messages);
    if (topic && (topic.emails.length || topic.domains.length) &&
        !topic.customerName) {
      return "Got the sender email — which Primus customer name should " +
        "we attach? You can also say protocol only or default dims " +
        "(e.g. 40×48×62).";
    }
    return "Do you mean map a sender email to a Primus customer? " +
      "Send the From address and customer name and I'll propose it.";
  }
  if (looksLikeZipFillIntent(messages)) {
    const topic = inferZipFillTopic(messages);
    if (topic && topic.city && !topic.zipCode) {
      return `You mean when pickup/delivery is ${topic.city}` +
        `${topic.state ? ", " + topic.state : ""} — which ZIP should ` +
        "we use for rating?";
    }
    return "Do you mean a city→ZIP rating rule? Tell me the city and " +
      "ZIP (e.g. La Mirada pickup → 90670) and I'll propose it.";
  }
  if (isMilitaryTopicBlob(userTopicBlob(messages))) {
    return "Do you mean add or update accessorials for military / AAFES " +
      "sites — like LAD and APD? Say which codes and I'll propose it.";
  }
  if (looksLikeDeleteRuleIntent(messages)) {
    return "Do you mean delete or turn off an existing rule? Tell me " +
      "which one (name, site type, or sender email) and I'll propose it.";
  }
  const last = lastUserTurn(messages);
  const snippet = last ?
    String(last.content || "").trim().replace(/\s+/g, " ").slice(0, 140) :
    "";
  if (snippet && snippet.length >= 8) {
    return "Do you mean you want a quote rule for: \"" + snippet + "\"? " +
      "If I'm on the right track, add any details (site, email, " +
      "accessorials, ZIP) and I'll propose something to confirm.";
  }
  return "What quote rule would you like? I handle site accessorials, " +
    "sender→customer mapping, city→ZIP fixes, rule updates, deletes — " +
    "describe it however you like and I'll propose it for you to confirm.";
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
    reply: `For **${topic.name}**, I'll add ${labels} when AI classifies ` +
      `the site as ${match.siteType || "matching flags"}. ` +
      "Does that look right? Say yes / sounds good / go ahead, or click Confirm.",
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
          !parseNaturalConfirmation(text) &&
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
      reply: `I'll update **${live.name}** to add ${labels} for military / ` +
        `AAFES sites (AI address classification). Look good? Say yes or ` +
        "click Confirm to save.",
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
        .replace(/\s+customer\s+name\s*$/ig, "")
        .replace(/\s+customer\s*$/ig, "")
        .replace(/[,;:\s]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
    n = n.replace(/\s+and\s+.*$/i, "").trim();
    return n;
  }

  const patterns = [
    // "… registered as customer name moses" / "register as customer X"
    new RegExp(
        "\\b(?:should\\s+be\\s+)?" +
        "regist(?:er|ered|ration)\\s+as\\s+(?:a\\s+)?" +
        "(?:customer\\s+)?(?:name\\s+)?(.+?)(?:\\.|$)",
        "i"),
    // "mapped to moses customer name" / "map … to customer name X"
    new RegExp(
        "\\b(?:map(?:ped)?|match(?:ed)?|link(?:ed)?|" +
        "tie(?:d)?|assign(?:ed)?)\\s+" +
        "(?:this\\s+)?(?:email|sender|from)?\\s*" +
        "(?:to|with|as)\\s+(?:customer\\s+)?" +
        "(?:name\\s+)?(.+?)(?:\\.|$)",
        "i"),
    /\b(?:use|to)\s+customer\s+(?:name\s+)?(.+?)(?:\.|$)/i,
    /\b(?:customer|account)\s*(?:name)?\s*[:=]\s*(.+?)(?:\.|$)/i,
    // "… as customer name moses" (after email / other fluff)
    /\bas\s+(?:a\s+)?customer\s+(?:name\s+)?(.+?)(?:\.|$)/i,
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
  // Also "…@… mapped to moses" / "…@… registered as …"
  const arrow = String(text || "").match(new RegExp(
      "@[\\w.-]+\\s+(?:(?:map(?:ped)?|match(?:ed)?|" +
      "regist(?:er|ered))\\s+)?(?:to|→|->|as)\\s+(.+?)(?:\\.|$)",
      "i"));
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
  // Keep email/domain hits even when the name is still missing so the
  // proposal path can ask only for the customer name (not re-ask From).
  if (!emails.length && !domains.length) return null;
  return {
    emails,
    domains,
    customerName: customerName || "",
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
    /\b(map(?:ped)?|match(?:ed)?|tie(?:d)?|link(?:ed)?|route(?:d)?)\b/
        .test(t) ||
    /\b(assign(?:ed)?|regist(?:er|ered|ration))\b/.test(t) ||
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
    reply: `Sender→customer mapping: ${bits.join("; ")}. ` +
      (matchCcTo ?
        "Matched via From/Cc/To email — no accessorials involved. " :
        "Matched via From email — no accessorials involved. ") +
      "Does that look right? Say yes / sounds good / go ahead, or click Confirm.",
    action: live ? "propose_update_rule" : "propose_create_rule",
    proposal: {ruleId, patch},
    quickReplies: [],
  };
}

/**
 * Parse a 5-digit US ZIP from freeform text.
 * @param {string} text User text.
 * @return {string}
 */
function parseZipCodeFromText(text) {
  const t = String(text || "");
  const labeled = t.match(
      /\b(?:zip|zipcode|postal)\s*(?:code)?\s*[:=]?\s*(\d{5})\b/i);
  if (labeled) return labeled[1];
  const useZip = t.match(/\buse\s+(?:zip\s+)?(\d{5})\b/i);
  if (useZip) return useZip[1];
  const toZip = t.match(/\b(?:to|as)\s+(?:zip\s+)?(\d{5})\b/i);
  if (toZip) return toZip[1];
  const all = t.match(/\b(\d{5})\b/g) || [];
  return all.length ? all[all.length - 1] : "";
}

/**
 * User is refining a just-proposed or just-applied rule ("yes, but only
 * when…", "for this rule…"), not starting a new vague request.
 * @param {string} text User message.
 * @return {boolean}
 */
function looksLikeRuleRefinement(text) {
  const raw = String(text || "").trim();
  if (!raw || /^\[applied\]/i.test(raw)) return false;
  const norm = normalizeChatAnswerText(raw);
  if (/\b(for|on|to)\s+this\s+rule\b/.test(norm)) return true;
  if (/\b(that|the)\s+rule\b/.test(norm) &&
      /\b(only|when|add|also|limit|restrict|customer|sender)\b/.test(norm)) {
    return true;
  }
  if (/\b(yes|yeah|yep|ok|okay),?\s+but\b/.test(norm)) return true;
  if (/\bbut\s+only\s+when\b/.test(norm)) return true;
  if (/\bonly\s+when\s+(the\s+)?(customer|sender|from|it\s+comes)\b/
      .test(norm)) {
    return true;
  }
  if (/\b(also\s+)?(require|limit|restrict)\s+(it\s+)?to\b/.test(norm)) {
    return true;
  }
  if (/\b(change|edit|update|modify|tweak|adjust)\s+(that|this|the)\s+rule\b/
      .test(norm)) {
    return true;
  }
  if (/\bfor\s+this\s+rule\b/i.test(raw)) return true;
  if (/\bthis\s+rule\b/i.test(norm) &&
      /\b(when|pickup|pick\s*up|delivery|zip|use)\b/.test(norm)) {
    return true;
  }
  if (extractQuotedRuleText(raw)) return true;
  return false;
}

/**
 * Quoted rule description from "for this rule, '…'" / bullet lines.
 * @param {string} text User message.
 * @return {string}
 */
function extractQuotedRuleText(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const quotePatterns = [
    /['"“”‘']([^'"“”‘'\n]{8,240})['"“”‘']/,
    /[•\-*]\s*['"“”‘']?([^'"“”‘'\n]{8,240})['"“”‘']?\s*$/,
  ];
  for (const re of quotePatterns) {
    const m = raw.match(re);
    if (m && m[1]) {
      const s = m[1].trim();
      if (s.length >= 8) return s;
    }
  }
  const forThis = raw.match(
      /\bfor\s+this\s+rule[,:\s•*-]+(.+?)$/i);
  if (forThis && forThis[1]) {
    const s = forThis[1].replace(/^['"“”‘']+|['"“”‘']+$/g, "").trim();
    if (s.length >= 8) return s;
  }
  return "";
}

/**
 * Rule id from the most recent [APPLIED] assistant turn.
 * @param {Array<object>} messages Chat turns.
 * @return {string|null}
 */
function findLastAppliedRuleId(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const c = String(m.content || "").trim();
    const applied = c
        .match(/^\[APPLIED\]\s+(?:Saved|Deleted)\s+rule\s+"([^"]+)"/i);
    if (applied) return applied[1];
    const appliedHuman = c.match(/^Applied:\s+(?:saved|removed)\s+"([^"]+)"/i);
    if (appliedHuman) return appliedHuman[1];
  }
  return null;
}

/**
 * Rule id from a recent assistant proposal turn ([PROPOSED] or reply text).
 * @param {Array<object>} messages Chat turns.
 * @return {string|null}
 */
function findRecentProposedRuleId(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const c = String(m.content || "").trim();
    const proposed = c.match(/^\[PROPOSED\]\s+ruleId="([^"]+)"/i);
    if (proposed) return proposed[1];
    const updating = c.match(/\bUpdating\s+\*\*([a-z0-9_]+)\*\*/i);
    if (updating) return updating[1];
    const applied = c.match(/^\[APPLIED\]\s+Saved rule\s+"([^"]+)"/i);
    if (applied) return applied[1];
    const appliedHuman = c.match(/^Applied:\s+saved\s+"([^"]+)"/i);
    if (appliedHuman) return appliedHuman[1];
    const zipFill = c.match(/\b(zip_fill_[a-z0-9_]+)\b/i);
    if (zipFill && /\b(rule|zip|update|set|saved|apply)\b/i.test(c)) {
      return zipFill[1];
    }
  }
  return null;
}

/**
 * Match an existing Firestore rule from quoted / restated description text.
 * @param {string} text User or quoted text.
 * @param {Array<object>} existingRules Live rules.
 * @return {string|null} rule id
 */
function findRuleByDescriptionMatch(text, existingRules) {
  const quoted = extractQuotedRuleText(text);
  const probe = quoted || String(text || "").trim();
  if (!probe) return null;

  const explicitIds = probe.match(
      /\b(zip_fill_[a-z0-9_]+|sender_[a-z0-9_]+|[a-z][a-z0-9_]{4,})\b/gi) || [];
  for (const rawId of explicitIds) {
    const id = String(rawId).trim();
    const hit = (existingRules || []).find((r) =>
      r && String(r.id).toLowerCase() === id.toLowerCase());
    if (hit) return hit.id;
  }

  const topic = inferZipFillTopic([{role: "user", content: probe}]);
  if (topic && topic.city) {
    let live = findExistingZipFillRule(existingRules || [], topic);
    if (!live && topic.zipCode) {
      live = (existingRules || []).find((r) => {
        if (!r || r.active === false || !isZipFillRuleDoc(r)) return false;
        const zip = String(r.fillZipCode || "").replace(/\D/g, "").slice(0, 5);
        if (zip !== topic.zipCode) return false;
        const match = r.match && typeof r.match === "object" ? r.match : {};
        const cities = [].concat(
            match.shipperCityContains || [],
            match.consigneeCityContains || [],
            match.cityContains || []);
        const wantCity = topic.city.trim().toLowerCase();
        return cities.some((c) => {
          const cc = String(c || "").trim().toLowerCase();
          return cc && (wantCity.includes(cc) || cc.includes(wantCity));
        });
      }) || null;
    }
    if (live) return live.id;
  }

  const norm = probe.toLowerCase();
  for (const r of existingRules || []) {
    if (!r || !r.id) continue;
    const hay = [r.id, r.name, r.notes, r.fillZipCode]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    if (topic && topic.city) {
      const city = topic.city.toLowerCase();
      if (hay.includes(city)) {
        if (!topic.zipCode ||
            String(r.fillZipCode || "").includes(topic.zipCode)) {
          return r.id;
        }
      }
    }
    const name = String(r.name || "").trim().toLowerCase();
    if (name.length >= 6 && norm.includes(name.slice(0, Math.min(name.length, 24)))) {
      return r.id;
    }
  }
  return null;
}

/**
 * Normalize lastAppliedRule / lastProposedRule payload from the UI.
 * @param {object|null} obj Rule context from client.
 * @return {object|null}
 */
function normalizeLastAppliedRule(obj) {
  if (!obj || typeof obj !== "object") return null;
  const ruleId = obj.ruleId || obj.id;
  if (!ruleId) return null;
  return {
    ruleId: String(ruleId),
    ruleKind: obj.ruleKind ? String(obj.ruleKind) : null,
    summary: obj.summary ? String(obj.summary) : "",
    action: obj.action ? String(obj.action) : null,
    proposal: obj.proposal && typeof obj.proposal === "object" ?
      obj.proposal : null,
  };
}

/**
 * Resolve which rule the user is referring to when refining.
 * @param {object} ctx lastAppliedRule, lastProposedRule, referencedRuleId.
 * @param {Array<object>} messages Full chat thread.
 * @param {object|null} pending Pending proposal from UI.
 * @param {Array<object>} existingRules Live rules.
 * @return {string|null}
 */
function resolveReferencedRuleId(ctx, messages, pending, existingRules) {
  if (pending && pending.ruleId) return String(pending.ruleId);
  const applied = normalizeLastAppliedRule(ctx && ctx.lastAppliedRule);
  if (applied && applied.ruleId) return applied.ruleId;
  const proposed = normalizeLastAppliedRule(ctx && ctx.lastProposedRule);
  if (proposed && proposed.ruleId) return proposed.ruleId;
  if (ctx && ctx.referencedRuleId) return String(ctx.referencedRuleId);
  if (ctx && ctx.lastAppliedRuleId) return String(ctx.lastAppliedRuleId);
  const fromChat = findLastAppliedRuleId(messages);
  if (fromChat) return fromChat;
  const recentProp = findRecentProposedRuleId(messages);
  if (recentProp) return recentProp;
  const last = lastUserTurn(messages);
  const lastText = last ? String(last.content || "") : "";
  if (lastText) {
    const fromQuote = findRuleByDescriptionMatch(lastText, existingRules);
    if (fromQuote) return fromQuote;
  }
  const userBlob = (messages || [])
      .filter((m) => m && m.role === "user")
      .map((m) => String(m.content || ""))
      .join("\n");
  if (userBlob) {
    const fromHistory = findRuleByDescriptionMatch(userBlob, existingRules);
    if (fromHistory) return fromHistory;
  }
  const topic = inferZipFillTopic(messages);
  if (topic && topic.city) {
    const live = findExistingZipFillRule(existingRules || [], topic);
    if (live) return live.id;
  }
  return null;
}

/**
 * Customer name from refinement phrasing.
 * @param {string} text User text.
 * @return {string}
 */
function parseRefinementCustomerName(text) {
  const emails = extractEmailsFromText(text);
  let name = parseCustomerNameFromSenderText(text, emails);
  if (name) return name;
  const onlyWhen = text.match(
      /\bonly\s+when\s+(?:the\s+)?customer\s+(?:is\s+)?(.+?)(?:\.|$)/i);
  if (onlyWhen && onlyWhen[1]) {
    name = onlyWhen[1].replace(/\s+customer\s*$/i, "").trim();
    if (name.length >= 2) return name;
  }
  const customerIs = text.match(
      /\bcustomer\s+(?:is\s+|name\s+is\s+)(.+?)(?:\.|$)/i);
  if (customerIs && customerIs[1]) {
    name = customerIs[1].trim();
    if (name.length >= 2 && !/@/.test(name)) return name;
  }
  return "";
}

/**
 * Sender display name from zip-fill / refinement phrasing.
 * @param {string} text User text.
 * @return {string}
 */
function parseRefinementSenderName(text) {
  const patterns = [
    /\b(?:comes\s+from|when\s+it\s+comes\s+from)\s+([A-Za-z][A-Za-z .'-]{1,60}?)(?:\s+(?:and|use|with|zip|when|only)|[,.]|$)/i,
    /\b(?:from|sender)\s+([A-Za-z][A-Za-z .'-]{1,60}?)(?:\s+(?:and|use|with|when|only)|[,.]|$)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const name = m[1].replace(/[,.\s]+$/g, "").trim();
      if (name.length >= 2 &&
          !/^(pickup|delivery|la|the|a|when|only)$/i.test(name)) {
        return name;
      }
    }
  }
  return "";
}

/**
 * Resolve sender name to known sender→customer rules (email / customer).
 * @param {string} name Sender display name.
 * @param {Array<object>} existingRules Live rules.
 * @return {{fromEmails: Array<string>, fromNames: Array<string>, customerName: string}}
 */
function resolveSenderHintsFromRules(name, existingRules) {
  const want = String(name || "").trim().toLowerCase();
  const out = {fromEmails: [], fromNames: [], customerName: ""};
  if (!want) return out;
  for (const r of existingRules || []) {
    if (!r || r.ruleKind !== RULE_KIND_SENDER_CUSTOMER) continue;
    const fromNames = [].concat(r.fromNames || []);
    const match = r.match && typeof r.match === "object" ? r.match : {};
    const emails = [].concat(match.fromEmails || []);
    const nameHit = fromNames.some((n) => {
      const nn = String(n || "").trim().toLowerCase();
      return nn && (want.includes(nn) || nn.includes(want));
    });
    const cust = String(r.customerName || "").trim();
    const custHit = cust &&
      (cust.toLowerCase().includes(want) || want.includes(cust.toLowerCase()));
    if (nameHit || custHit) {
      out.fromEmails.push(...emails);
      out.fromNames.push(...(fromNames.length ? fromNames : [name]));
      if (cust) out.customerName = cust;
      break;
    }
  }
  if (!out.fromNames.length && name) out.fromNames.push(name);
  out.fromEmails = [...new Set(out.fromEmails.map((e) => e.toLowerCase()))];
  return out;
}

/**
 * Optional customer / sender filters for zip-fill rules.
 * @param {string} text User text (may span several turns).
 * @param {Array<object>} existingRules Live rules.
 * @return {{customerName: string, fromEmails: Array<string>, fromNames: Array<string>}}
 */
function parseZipFillExtraConditions(text, existingRules) {
  const emails = extractEmailsFromText(text);
  let customerName = parseRefinementCustomerName(text);
  const senderName = parseRefinementSenderName(text);
  const senderHints = senderName ?
    resolveSenderHintsFromRules(senderName, existingRules) :
    {fromEmails: [], fromNames: [], customerName: ""};
  if (!customerName && senderHints.customerName) {
    customerName = senderHints.customerName;
  }
  customerName = resolveCustomerNameFromRules(customerName, existingRules);
  return {
    customerName: customerName || "",
    fromEmails: emails.length ? emails : senderHints.fromEmails,
    fromNames: senderHints.fromNames,
  };
}

/**
 * Canonical Primus customer name from live rules when possible.
 * @param {string} name Parsed customer name.
 * @param {Array<object>} existingRules Live rules.
 * @return {string}
 */
function resolveCustomerNameFromRules(name, existingRules) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  const want = raw.toLowerCase();
  for (const r of existingRules || []) {
    const cust = String(r.customerName || "").trim();
    if (!cust) continue;
    const lower = cust.toLowerCase();
    if (lower === want || lower.includes(want) || want.includes(lower)) {
      return cust;
    }
  }
  return raw;
}

/**
 * Merge array-valued match fields without dropping prior needles.
 * @param {object} base Existing match.
 * @param {object} extra New match fields.
 * @return {object}
 */
function mergeMatchFields(base, extra) {
  const out = {...(base && typeof base === "object" ? base : {})};
  for (const [k, v] of Object.entries(extra || {})) {
    if (Array.isArray(v)) {
      const prev = Array.isArray(out[k]) ? out[k] : [];
      out[k] = [...new Set([...prev, ...v].map(String))];
    } else if (v != null && String(v).trim()) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Rule id for a refinement turn (pending, lastAppliedRule, or chat context).
 * @param {Array<object>} messages Chat turns.
 * @param {Array<object>} existingRules Live rules.
 * @param {object|null} pending Pending proposal.
 * @param {object} ruleContext Client rule pointers.
 * @return {string|null}
 */
function findRuleIdForRefinement(messages, existingRules, pending, ruleContext) {
  return resolveReferencedRuleId(
      ruleContext || {}, messages, pending, existingRules);
}

/**
 * Patch object from a pending / lastProposed / lastApplied envelope.
 * @param {object|null} envelope Pending proposal or nested proposal.
 * @return {object|null}
 */
function extractRefinementBasePatch(envelope) {
  if (!envelope || typeof envelope !== "object") return null;
  if (envelope.patch && typeof envelope.patch === "object") {
    return envelope.patch;
  }
  if (envelope.proposal && typeof envelope.proposal === "object" &&
      envelope.proposal.patch && typeof envelope.proposal.patch === "object") {
    return envelope.proposal.patch;
  }
  return null;
}

/**
 * Live rule doc for refinement — prefers pending patch, then applied /
 * proposed snapshots (so mid-confirm "yes, but only when…" can refine
 * without saving the incomplete rule first).
 * @param {string} ruleId Rule id.
 * @param {Array<object>} existingRules Live rules.
 * @param {object} ruleContext Client rule pointers.
 * @param {object|null} [pending] Pending proposal from UI.
 * @return {object|null}
 */
function findRuleDocForRefinement(ruleId, existingRules, ruleContext, pending) {
  const live = (existingRules || []).find((r) => r.id === ruleId);
  if (live) return live;

  if (pending && String(pending.ruleId || pending.deleteRuleId || "") ===
      String(ruleId)) {
    const pendingPatch = extractRefinementBasePatch(pending);
    if (pendingPatch) return {id: ruleId, ...pendingPatch};
  }

  const applied = normalizeLastAppliedRule(
      ruleContext && ruleContext.lastAppliedRule);
  const proposed = normalizeLastAppliedRule(
      ruleContext && ruleContext.lastProposedRule);
  const snap = (applied && applied.ruleId === ruleId && applied) ||
    (proposed && proposed.ruleId === ruleId && proposed) || null;
  if (!snap) return null;
  const snapPatch = extractRefinementBasePatch(snap) ||
    extractRefinementBasePatch(snap.proposal);
  if (!snapPatch) return null;
  return {id: ruleId, ...snapPatch};
}

/**
 * Human summary of zip-fill extra conditions.
 * @param {object} conditions Parsed conditions.
 * @param {object} match Rule match object.
 * @param {Array<string>} fromNames Rule fromNames.
 * @return {Array<string>}
 */
function zipFillConditionBits(conditions, match, fromNames) {
  const bits = [];
  if (conditions.customerName) bits.push(`customer **${conditions.customerName}**`);
  const emails = [].concat(match.fromEmails || match.senderEmails || []);
  if (emails.length) bits.push(`sender ${emails.join(", ")}`);
  else if ((fromNames || []).length) bits.push(`sender ${fromNames.join(", ")}`);
  return bits;
}

/**
 * Apply optional customer/sender filters onto a zip-fill patch.
 * @param {object} patch Outgoing patch (mutated).
 * @param {object} match Outgoing match (mutated).
 * @param {object} conditions Parsed conditions.
 */
function applyZipFillExtraConditionsToPatch(patch, match, conditions) {
  if (!conditions) return;
  if (conditions.customerName) {
    patch.customerName = conditions.customerName;
  }
  if (conditions.fromEmails && conditions.fromEmails.length) {
    match.fromEmails = conditions.fromEmails;
  }
  if (conditions.fromNames && conditions.fromNames.length) {
    patch.fromNames = conditions.fromNames
        .map((n) => String(n).trim().toLowerCase())
        .filter(Boolean);
  }
  const hasEmailCond = (match.fromEmails || []).length > 0 ||
    (patch.fromNames || []).length > 0;
  if (hasEmailCond || conditions.customerName) {
    patch.identifyVia = "both";
  }
}

/**
 * Update proposal for a zip-fill rule after apply or mid-confirm refine.
 * @param {object} live Existing rule doc (or pending patch as doc).
 * @param {object} conditions New filters.
 * @param {{pendingAction?: string, ruleExists?: boolean}=} opts
 *   pendingAction: keep create when refining an unsaved proposal.
 * @return {object}
 */
function buildZipFillRefinementProposal(live, conditions, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const ruleExists = options.ruleExists === true;
  const pendingAction = options.pendingAction ?
    String(options.pendingAction) : "";
  // Mid-confirm refine of an unsaved create → still one create Confirm.
  const keepCreate = !ruleExists &&
    (pendingAction === "propose_create_rule" || !pendingAction);
  const action = keepCreate ? "propose_create_rule" : "propose_update_rule";
  const confirmHint = keepCreate ?
    "Confirm to save this rule" :
    "Confirm to save this update";

  const match = mergeMatchFields(live.match || {}, {
    fromEmails: conditions.fromEmails || [],
    senderEmails: conditions.fromEmails || [],
  });
  const fromNames = [...new Set([]
      .concat(live.fromNames || [])
      .concat(conditions.fromNames || [])
      .map((n) => String(n).trim().toLowerCase())
      .filter(Boolean))];
  const customerName = conditions.customerName ||
    live.customerName || "";
  const sideLabel = live.applyTo === "dest" ? "delivery" : "pickup";
  const zip = String(live.fillZipCode || "").replace(/\D/g, "").slice(0, 5);
  const bits = zipFillConditionBits(
      {customerName}, match, fromNames);
  const patch = {
    active: live.active !== false,
    priority: live.priority || 3,
    name: live.name || `${sideLabel} ZIP fill`,
    ruleKind: RULE_KIND_ZIP_FILL,
    identifyVia: (match.fromEmails || []).length || fromNames.length ||
      customerName ? "both" : (live.identifyVia || "ai"),
    applyTo: live.applyTo || "origin",
    match,
    fillZipCode: zip,
    addAccessorials: live.addAccessorials || [],
    autoApply: live.autoApply !== false,
    requiresConfirm: !!live.requiresConfirm,
  };
  if (customerName) patch.customerName = customerName;
  if (fromNames.length) patch.fromNames = fromNames;
  if (bits.length) {
    const baseName = String(live.name || `${sideLabel} ZIP fill`)
        .replace(/\s*—\s*customer\b.*$/i, "")
        .trim();
    patch.name = `${baseName} — ${bits.join(", ").replace(/\*\*/g, "")}`;
    patch.notes = `When ${sideLabel} city matches and ` +
      bits.map((b) => b.replace(/\*\*/g, "")).join(" + ") +
      `, use ZIP ${zip}.`;
  } else {
    patch.notes = live.notes || "";
  }
  const condText = bits.length ?
    `but only when ${bits.join(" and ")}` :
    "with your added condition";
  const lead = keepCreate ?
    `Got it — same ${sideLabel} ZIP **${zip}**, ${condText}` :
    `Got it — updating **${live.id}**: same ${sideLabel} ZIP **${zip}**, ` +
      `${condText}`;
  return {
    reply: `${lead}. Does that look right? Say yes / sounds good / go ahead, ` +
      `or click ${confirmHint}.`,
    action,
    proposal: {ruleId: live.id, patch},
    quickReplies: [],
    replacedPending: keepCreate,
  };
}

/**
 * Refine a recently applied / pending rule with additive conditions.
 * @param {Array<object>} messages Chat turns.
 * @param {Array<object>} existingRules Live rules.
 * @param {object|null} [pending] Pending proposal from UI.
 * @return {object|null}
 */
function buildRuleRefinementProposal(messages, existingRules, pending, ruleContext) {
  const last = lastUserTurn(messages);
  const lastText = last ? String(last.content || "") : "";
  if (!looksLikeRuleRefinement(lastText)) return null;

  const ruleId = findRuleIdForRefinement(
      messages, existingRules || [], pending, ruleContext);
  if (!ruleId) {
    return {
      reply: "Got it — which rule should I update? Repeat the rule " +
        "(e.g. La Mirada pickup → ZIP 90670) and the extra condition " +
        "(customer or sender).",
      action: "none",
      proposal: null,
      quickReplies: [],
    };
  }

  const live = findRuleDocForRefinement(
      ruleId, existingRules || [], ruleContext || {}, pending || null);
  if (!live) return null;

  let conditions = parseZipFillExtraConditions(lastText, existingRules || []);
  const priorUserText = (messages || [])
      .filter((m) => m && m.role === "user" && m !== last)
      .map((m) => String(m.content || ""))
      .join("\n");
  if (priorUserText) {
    const prior = parseZipFillExtraConditions(
        priorUserText, existingRules || []);
    if (!conditions.fromEmails.length) {
      conditions.fromEmails = prior.fromEmails;
    }
    if (!conditions.fromNames.length) conditions.fromNames = prior.fromNames;
    if (!conditions.customerName) conditions.customerName = prior.customerName;
  }

  if (!conditions.customerName && !conditions.fromEmails.length &&
      !conditions.fromNames.length) {
    return {
      reply: `Got it — you mean rule **${live.id}**` +
        (live.name ? ` (${live.name})` : "") +
        ". What should I add — customer name, sender email, " +
        "or sender name (e.g. only when customer is Brumis Imports Inc)?",
      action: "none",
      proposal: null,
      quickReplies: [],
      referencedRuleId: live.id,
    };
  }

  if (isZipFillRuleDoc(live)) {
    const ruleExists = !!(existingRules || []).find((r) => r && r.id === ruleId);
    return buildZipFillRefinementProposal(live, conditions, {
      pendingAction: pending && pending.action ? pending.action : "",
      ruleExists,
    });
  }
  return null;
}

/**
 * Parse city + optional state from zip-fill phrasing.
 * @param {string} text User text.
 * @return {{city: string, state: string, side: "origin"|"dest"}}
 */
function parseCityStateFromZipFillText(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  let side = "origin";
  if (/\b(delivery|deliver|consignee|ship\s*to|destination)\b/i.test(t)) {
    side = "dest";
  }
  if (/\b(pickup|pick\s*up|ship\s*from|origin)\b/i.test(t)) {
    side = "origin";
  }

  const known = [
    {re: /\bla\s*mirada\b/i, city: "La Mirada", state: "CA"},
    {re: /\bsanta\s*fe\s*springs\b/i, city: "Santa Fe Springs", state: "CA"},
    {re: /\brialto\b/i, city: "Rialto", state: "CA"},
    {re: /\blakewood\b/i, city: "Lakewood", state: "NJ"},
  ];
  for (const row of known) {
    if (row.re.test(t)) {
      return {city: row.city, state: row.state, side};
    }
  }

  const pickupFrom = t.match(
      /\b(?:pickup|pick\s*up|ship\s*from|ship\s*from)\s+(?:from|at|in|is)\s+(.+?)(?:\s+(?:use|with|zip|zipcode)\b|$)/i);
  if (pickupFrom && pickupFrom[1]) {
    const chunk = pickupFrom[1].replace(/,\s*$/, "").trim();
    for (const row of known) {
      if (row.re.test(chunk)) {
        return {city: row.city, state: row.state, side: "origin"};
      }
    }
    const cs = chunk.match(/^([A-Za-z .'-]+?)(?:\s*,?\s*([A-Z]{2}))?$/);
    if (cs && cs[1] && cs[1].trim().length >= 2) {
      return {
        city: cs[1].replace(/,/g, "").trim(),
        state: cs[2] ? cs[2].toUpperCase() : "",
        side: "origin",
      };
    }
  }

  const whenCity = t.match(
      /\b(?:when|if|for)\s+(?:pickup\s+(?:is|from|at)\s+)?(?:delivery\s+(?:is|to)\s+)?(.+?)\s+(?:use\s+)?(?:zip|zipcode)\b/i);
  if (whenCity && whenCity[1]) {
    const chunk = whenCity[1].replace(/,\s*$/, "").trim();
    const cs = chunk.match(/^([A-Za-z .'-]+?)(?:\s*,?\s*([A-Z]{2}))?$/);
    if (cs && cs[1]) {
      return {
        city: cs[1].replace(/,/g, "").trim(),
        state: cs[2] ? cs[2].toUpperCase() : "",
        side,
      };
    }
  }

  const cityStateZip = t.match(
      /\b([A-Za-z .'-]{2,40}?)\s*,?\s*([A-Z]{2})\b(?:\s+\d{5})?/);
  if (cityStateZip) {
    return {
      city: cityStateZip[1].replace(/,/g, "").trim(),
      state: cityStateZip[2].toUpperCase(),
      side,
    };
  }

  return {city: "", state: "", side};
}

/**
 * Infer zip-fill rule fields from chat history.
 * @param {Array<object>} messages Chat turns.
 * @return {object|null}
 */
function inferZipFillTopic(messages) {
  const blob = (messages || [])
      .filter((m) => m && m.role !== "assistant")
      .map((m) => String(m.content || ""))
      .join("\n");
  if (!blob.trim()) return null;
  const zipCode = parseZipCodeFromText(blob);
  const place = parseCityStateFromZipFillText(blob);
  if (!zipCode || !place.city) return null;
  return {
    city: place.city,
    state: place.state,
    side: place.side,
    zipCode,
  };
}

/**
 * Stable rule id from city/state/side.
 * @param {object} topic Inferred topic.
 * @return {string}
 */
function zipFillRuleIdFromTopic(topic) {
  const slug = String(topic.city || "custom")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 40);
  const side = topic.side === "dest" ? "dest" : "origin";
  return `zip_fill_${slug}_${side}`;
}

/**
 * User wants a city/state → ZIP correction rule.
 * @param {Array<object>} messages Chat turns.
 * @return {boolean}
 */
function looksLikeZipFillIntent(messages) {
  if (looksLikeDeleteRuleIntent(messages)) return false;
  const last = lastUserTurn(messages);
  const lastText = last ? String(last.content || "") : "";
  if (!lastText || /^\[applied\]/i.test(lastText.trim())) return false;
  if (looksLikeRuleRefinement(lastText)) return false;
  if (/\bfor\s+this\s+rule\b/i.test(lastText)) return false;
  if (extractQuotedRuleText(lastText)) return false;
  const blob = isMetaFollowUpText(lastText) ?
    userTopicBlob(messages) : lastText.toLowerCase();
  const hasZip = !!parseZipCodeFromText(blob);
  const place = parseCityStateFromZipFillText(blob);
  const zipCue = /\b(zip|zipcode|postal)\b/.test(blob) ||
    /\buse\s+(?:zip\s+)?\d{5}\b/.test(blob) ||
    hasZip;
  const cityCue = !!place.city ||
    /\b(pickup|pick\s*up|ship\s*from|origin|delivery|city)\b/.test(blob);
  if (zipCue && (place.city || /\bla\s*mirada\b|\bsanta\s*fe\b/.test(blob))) {
    return true;
  }
  if (/\bwhen\b.{0,40}\b(pickup|pick\s*up|ship\s*from)\b/.test(blob) &&
      hasZip) {
    return true;
  }
  if (/\b(fill|correct|fix|override)\b.{0,40}\bzip\b/.test(blob) &&
      (place.city || hasZip)) {
    return true;
  }
  if (place.city &&
      /\b(pickup|pick\s*up|ship\s*from|origin|delivery|consignee)\b/.test(blob)) {
    return true;
  }
  const topic = inferZipFillTopic(messages);
  return !!(topic && topic.city && topic.zipCode && cityCue);
}

/**
 * Find an existing zip-fill rule for the same city/side.
 * @param {Array<object>} existingRules Live rules.
 * @param {object} topic Inferred topic.
 * @return {object|null}
 */
function findExistingZipFillRule(existingRules, topic) {
  const wantCity = String(topic.city || "").trim().toLowerCase();
  const wantState = String(topic.state || "").trim().toUpperCase();
  const wantSide = topic.side === "dest" ? "dest" : "origin";
  for (const r of existingRules || []) {
    if (!r || r.active === false || !isZipFillRuleDoc(r)) continue;
    const side = r.applyTo === "dest" || r.applyTo === "origin" ?
      r.applyTo : "origin";
    if (side !== wantSide) continue;
    const match = r.match && typeof r.match === "object" ? r.match : {};
    const cities = side === "origin" ?
      [].concat(match.shipperCityContains || match.cityContains || []) :
      [].concat(match.consigneeCityContains || match.cityContains || []);
    const cityHit = cities.some((c) =>
      wantCity.includes(String(c || "").trim().toLowerCase()) ||
      String(c || "").trim().toLowerCase().includes(wantCity));
    const stateRaw = side === "origin" ?
      match.shipperState || match.state : match.consigneeState || match.state;
    const stateHit = !wantState || !stateRaw ||
      String(stateRaw).trim().toUpperCase() === wantState;
    if (cityHit && stateHit) return r;
  }
  return null;
}

/**
 * @param {object} rule Rule doc.
 * @return {boolean}
 */
function isZipFillRuleDoc(rule) {
  if (!rule || typeof rule !== "object") return false;
  if (rule.ruleKind === RULE_KIND_ZIP_FILL) return true;
  const zip = String(rule.fillZipCode || "").replace(/\D/g, "").slice(0, 5);
  if (!/^\d{5}$/.test(zip)) return false;
  const match = rule.match && typeof rule.match === "object" ? rule.match : {};
  return !!(match.shipperCityContains || match.consigneeCityContains);
}

/**
 * Deterministic create/update proposal for city/state → ZIP fill.
 * @param {Array<object>} messages Chat turns.
 * @param {Array<object>} existingRules Live rules.
 * @return {object|null}
 */
function buildZipFillProposal(messages, existingRules) {
  if (!looksLikeZipFillIntent(messages)) return null;
  const last = lastUserTurn(messages);
  const lastText = last ? String(last.content || "") : "";
  if (looksLikeRuleRefinement(lastText) ||
      /\bfor\s+this\s+rule\b/i.test(lastText)) {
    return null;
  }
  const topic = inferZipFillTopic(messages);
  if (!topic || !topic.city) {
    return {
      reply: "I can add a ZIP fill rule for pickup or delivery cities. " +
        "Tell me the city, state, and ZIP (e.g. La Mirada CA → 90670).",
      action: "none",
      proposal: null,
      quickReplies: [],
    };
  }
  if (!topic.zipCode) {
    return {
      reply: `Got ${topic.city}${topic.state ? ", " + topic.state : ""} — ` +
        "which 5-digit ZIP should we use for rating?",
      action: "none",
      proposal: null,
      quickReplies: [],
    };
  }

  const live = findExistingZipFillRule(existingRules || [], topic);
  const side = topic.side === "dest" ? "dest" : "origin";
  const cityNeedle = topic.city.trim().toLowerCase();
  const match = {};
  if (side === "origin") {
    match.shipperCityContains = [cityNeedle];
    if (topic.state) match.shipperState = topic.state.toUpperCase();
  } else {
    match.consigneeCityContains = [cityNeedle];
    if (topic.state) match.consigneeState = topic.state.toUpperCase();
  }

  const ruleId = live ? String(live.id) : zipFillRuleIdFromTopic(topic);
  const sideLabel = side === "origin" ? "pickup" : "delivery";
  const name = `${topic.city}${topic.state ? ", " + topic.state : ""} ` +
    `${sideLabel} → ZIP ${topic.zipCode}`;

  const patch = {
    active: true,
    priority: (live && live.priority) || 3,
    name,
    ruleKind: RULE_KIND_ZIP_FILL,
    identifyVia: "ai",
    applyTo: side,
    match,
    fillZipCode: topic.zipCode,
    addAccessorials: [],
    notes: `When ${sideLabel} city matches ${topic.city}` +
      `${topic.state ? " " + topic.state : ""}, use ZIP ${topic.zipCode}.`,
    autoApply: true,
    requiresConfirm: false,
  };

  const userBlob = (messages || [])
      .filter((m) => m && m.role !== "assistant")
      .map((m) => String(m.content || ""))
      .join("\n");
  const extra = parseZipFillExtraConditions(userBlob, existingRules || []);
  applyZipFillExtraConditionsToPatch(patch, match, extra);
  const condBits = zipFillConditionBits(extra, match, patch.fromNames || []);
  if (condBits.length) {
    patch.name = `${name} — ${condBits.join(", ").replace(/\*\*/g, "")}`;
    patch.notes = `When ${sideLabel} city matches ${topic.city}` +
      `${topic.state ? " " + topic.state : ""} and ` +
      condBits.map((b) => b.replace(/\*\*/g, "")).join(" + ") +
      `, use ZIP ${topic.zipCode}.`;
  }

  const condReply = condBits.length ?
    ` (only when ${condBits.join(" and ")})` : "";

  return {
    reply: `I'll set pickup/delivery ZIP for ${topic.city}` +
      `${topic.state ? ", " + topic.state : ""} to **${topic.zipCode}** ` +
      `when the ${sideLabel} city matches${condReply}. Does that look right? ` +
      "Say yes / sounds good / go ahead, or click Confirm to save this rule.",
    action: live ? "propose_update_rule" : "propose_create_rule",
    proposal: {ruleId, patch},
    quickReplies: [],
  };
}

/**
 * True when a model/create proposal already has enough match info to
 * skip the identify questionnaire.
 * @param {object} result Chat result with action/proposal.
 * @return {boolean}
 */
function proposalHasEnoughIdentifyInfo(result) {
  if (!result || typeof result !== "object") return false;
  const action = result.action || "none";
  if (action !== "propose_create_rule" && action !== "propose_update_rule") {
    return false;
  }
  const patch = result.proposal && result.proposal.patch &&
    typeof result.proposal.patch === "object" ?
    result.proposal.patch : null;
  if (!patch || !String(patch.name || "").trim()) return false;
  const match = patch.match && typeof patch.match === "object" ?
    patch.match : null;
  if (!match || !Object.keys(match).length) return false;
  if (patch.identifyVia === "email" ||
      patch.ruleKind === RULE_KIND_SENDER_CUSTOMER ||
      String(patch.customerName || "").trim()) {
    const emails = [].concat(match.fromEmails || [])
        .concat(match.senderEmails || []);
    const domains = [].concat(match.senderDomains || []);
    return emails.length > 0 || domains.length > 0;
  }
  if (patch.ruleKind === RULE_KIND_ZIP_FILL ||
      String(patch.fillZipCode || "").replace(/\D/g, "").length === 5) {
    const cities = [].concat(match.shipperCityContains || [])
        .concat(match.consigneeCityContains || [])
        .concat(match.cityContains || []);
    return cities.length > 0;
  }
  if (match.siteType || (Array.isArray(match.flags) && match.flags.length)) {
    return true;
  }
  const textKeys = [
    "consigneeNameContains", "consigneeAddressContains",
    "instructionsContains", "referenceContains",
  ];
  return textKeys.some((k) => {
    const v = match[k];
    return Array.isArray(v) ? v.length > 0 : !!String(v || "").trim();
  });
}

/**
 * Enforce identify questionnaire before create proposals.
 * Soft gate: only ask when info is truly missing; never steal a complete
 * sender/site/accessorial proposal or a clear delete/update.
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
  const zipOut = buildZipFillProposal(messages, existingRules || []);
  if (zipOut) return zipOut;

  // Model already produced a complete Confirmable proposal — keep it.
  if (proposalHasEnoughIdentifyInfo(out)) {
    if (/could not process|try rephrasing/i.test(String(out.reply || ""))) {
      out.reply = "Here's what I'd change — review the summary below. " +
        "Say yes / sounds good / go ahead, or click Confirm to save it.";
    }
    return out;
  }

  const gate = detectCreateIdentifyGate(messages);
  const extras = collectCreateFlowExtras(messages);
  const lastUser = lastUserTurn(messages);
  const lastText = lastUser ? String(lastUser.content || "") : "";
  const lastIsAccessorials = !!(lastUser &&
      parseAccessorialsAnswer(lastUser.content).length);
  const lastIsIdentifyAnswer = !!parseIdentifyChoiceAnswer(lastText);
  const lastIsMeta = isMetaFollowUpText(lastText);
  // Site + accessorials already in chat → propose without identify.
  if ((isClearlySiteTypeTopic(messages) || extras.siteType) &&
      (extras.accessorials || []).length) {
    return finalizeAddressOnlyCreate(out, messages, extras) || out;
  }
  // Only stay in the questionnaire for a real identify/accessorial
  // answer — leftover "ready" must not steal "i asked you something".
  // Soft: "needed" alone does NOT force identify when the model said
  // none / asked a clarifying question.
  const inIdentifyFlow =
    (gate.status === "awaiting_choice" && lastIsIdentifyAnswer) ||
    (gate.status === "awaiting_email_signals" &&
      !looksLikeMilitaryAccessorialIntent(messages) && !lastIsMeta) ||
    (gate.status === "ready" && gate.source === "address_only" &&
      (lastIsAccessorials || lastIsIdentifyAnswer)) ||
    (extras.askedAccessorials && lastIsAccessorials) ||
    (gate.status === "needed" && looksLikeCreateRuleIntent(messages) &&
      !isClearlySiteTypeTopic(messages) &&
      !looksLikeSenderCustomerIntent(messages) &&
      !looksLikeZipFillIntent(messages) &&
      action !== "none");
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
  if (looksLikeZipFillIntent(messages)) {
    const forcedZip = buildZipFillProposal(
        messages, existingRules || []);
    if (forcedZip) return forcedZip;
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
  if (looksLikeZipFillIntent(messages)) {
    return buildZipFillProposal(messages, existingRules || []) || out;
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
        out.reply = "Do you mean accessorial codes like LAD, LFD, or APD? " +
          "You can use the code or a name like \"limited access\" " +
          "(LOAD counts as LAD).";
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

  // Soft: if model asked a clarifying question, keep it.
  if (action === "none" && String(out.reply || "").trim()) {
    if (/could not process|try rephrasing/i.test(String(out.reply))) {
      out.reply = fallbackUnclearReply(messages);
    }
    return out;
  }

  // needed or awaiting_choice — stop and ask with two clear options.
  // Only when we truly need identify (create intent, not sender/site).
  if (!looksLikeCreateRuleIntent(messages) &&
      action !== "ask_identify_source") {
    out.reply = out.reply || fallbackUnclearReply(messages);
    if (/could not process|try rephrasing/i.test(String(out.reply))) {
      out.reply = fallbackUnclearReply(messages);
    }
    out.action = "none";
    out.proposal = null;
    out.quickReplies = [];
    return out;
  }

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
  const chatTurns = resolveChatTurns(opts || {});
  const existingRules = opts.existingRules || [];
  const finish = (r) => polishChatResult(r, chatTurns);
  const pending = opts.pendingProposal && typeof opts.pendingProposal === "object" ?
    opts.pendingProposal : null;
  const ruleContext = {
    lastAppliedRule: normalizeLastAppliedRule(opts.lastAppliedRule),
    lastProposedRule: normalizeLastAppliedRule(opts.lastProposedRule),
    lastAppliedRuleId: opts.lastAppliedRuleId ?
      String(opts.lastAppliedRuleId) : null,
    referencedRuleId: opts.referencedRuleId ?
      String(opts.referencedRuleId) :
      (normalizeLastAppliedRule(opts.lastAppliedRule) || {}).ruleId ||
      (normalizeLastAppliedRule(opts.lastProposedRule) || {}).ruleId ||
      findLastAppliedRuleId(chatTurns),
  };
  const last = lastUserTurn(chatTurns);
  const lastText = last ? String(last.content || "") : "";

  if (pending && lastText) {
    const refinePending = buildRuleRefinementProposal(
        chatTurns, existingRules, pending, ruleContext);
    if (refinePending) return finish(refinePending);
    if (parseNaturalConfirmation(lastText, {pendingProposal: true})) {
      return finish({
        reply: "Perfect — applying that rule now.",
        action: pending.action || "propose_create_rule",
        proposal: {
          ruleId: pending.ruleId || pending.deleteRuleId,
          patch: pending.patch || {},
          deleteRuleId: pending.deleteRuleId || pending.ruleId,
          deleteRuleIds: pending.deleteRuleIds,
        },
        confirmApply: true,
        quickReplies: [],
      });
    }
    const rej = parseRejectionWithCorrection(lastText);
    if (rej.rejected) {
      return finish({
        reply: rejectionReply(rej.correction),
        action: rej.correction ? "none" : "dismiss_pending",
        proposal: null,
        quickReplies: [],
        dismissedCorrection: rej.correction || null,
      });
    }
  }

  if (isMetaFollowUpText(lastText)) {
    return finish({
      reply: "Sorry about that — tell me again what rule you want and " +
        "I'll propose it clearly for you to confirm.",
      action: "none",
      proposal: null,
      quickReplies: [],
    });
  }

  const refineOut = buildRuleRefinementProposal(
      chatTurns, existingRules, null, ruleContext);
  if (refineOut) return finish(refineOut);

  // Obvious delete / military APD+LAD updates skip the model so a leftover
  // identify gate cannot steal the turn.
  const deleteOut = buildDeleteRuleProposal(chatTurns, existingRules);
  if (deleteOut) return finish(deleteOut);
  const militaryOut = buildMilitaryAccessorialProposal(
      chatTurns, existingRules);
  if (militaryOut) return finish(militaryOut);
  const senderOut = buildSenderCustomerProposal(chatTurns, existingRules);
  if (senderOut) return finish(senderOut);
  const zipOut = buildZipFillProposal(chatTurns, existingRules);
  if (zipOut) return finish(zipOut);

  const gateHint = detectCreateIdentifyGate(chatTurns);
  const lastTurn = lastUserTurn(chatTurns);
  const lastTurnText = lastTurn ? String(lastTurn.content || "") : "";
  const lastIsAcc = parseAccessorialsAnswer(lastTurnText).length > 0;
  const lastIsChoice = !!parseIdentifyChoiceAnswer(lastTurnText);
  // After Cannot-be, only skip the model for a structured accessorial
  // or identify answer. Follow-ups go to gpt-5.6-luna.
  if (gateHint.status === "ready" && gateHint.source === "address_only" &&
      (lastIsAcc || lastIsChoice)) {
    return finish(enforceCreateIdentifyGate({
      reply: "",
      action: "none",
      proposal: null,
    }, chatTurns, existingRules));
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
    "You are a sharp, conversational quote-rules assistant for Innovative",
    "Carriers dispatchers. Talk like ChatGPT or Cursor — a general helpful",
    "AI for ANY quote-automation rule request, not just a fixed menu.",
    "Infer messy natural-language intent, ask ONE smart clarifying question",
    "when something is ambiguous (\"Do you mean …?\" / \"You mean that …?\"),",
    "and propose a confirmable rule as soon as you have enough facts.",
    "Never act like a rigid form or bot. NEVER say \"I don't understand\",",
    "\"I could not process that\", or \"Try rephrasing\".",
    "If the user says no / wrong: \"Oh sorry — …\" and refine or ask again.",
    "Accept any reply format — no required keywords or button-only confirm.",
    "",
    "You manage THREE rule kinds:",
    "1) Accessorial / site rules — site types or text → Primus codes",
    "   (LAD limited access, APD appointment dest, LFD/LFO liftgate,",
    "   NUD nursing, HOD hotel, RSD residential, SCD school, INS).",
    "2) Sender→customer rules — From email/@domain → Primus customerName,",
    "   optional protocolOnly, optional defaultDims. No accessorials.",
    "3) ZIP fill rules — city/state pickup or delivery → rating ZIP.",
    "   ruleKind zip_fill; fillZipCode 5 digits; applyTo origin|dest;",
    "   match shipperCityContains+shipperState (pickup) or",
    "   consigneeCityContains+consigneeState (delivery). No accessorials.",
    "",
    "Current active rules JSON:",
    rulesJson,
    "",
    "Respond with JSON only:",
    "{",
    "  \"reply\": \"friendly message\",",
    "  \"action\": \"none\" | \"ask_identify_source\" |",
    "    \"ask_email_signals\" | \"propose_create_rule\" |",
    "    \"propose_update_rule\" | \"propose_delete_rule\",",
    "  \"proposal\": null | {",
    "    \"ruleId\": \"snake_case_id\",",
    "    \"patch\": { rule fields },",
    "    \"deleteRuleId\": \"id for delete\"",
    "  },",
    "  \"quickReplies\": [] | [\"" + QUICK_REPLY_CAN_BE + "\",",
    "    \"" + QUICK_REPLY_CANNOT_BE + "\"]",
    "}",
    "",
    "Patch fields: active, priority, name, match, addAccessorials,",
    "removeAccessorials, filterCarrierWarnings, notes, autoApply,",
    "requiresConfirm, identifyVia, ruleKind, customerName, protocolOnly,",
    "defaultDims, fillZipCode, applyTo.",
    "removeAccessorials: Primus codes to strip after all matching adds",
    "(e.g. remove NTD when appointment/APD context matches).",
    "match: consigneeNameContains, consigneeAddressContains,",
    "instructionsContains, referenceContains, flags, siteType,",
    "fromEmails, senderEmails, senderDomains, ccEmails, toEmails,",
    "shipperCityContains, shipperState, consigneeCityContains, consigneeState.",
    "",
    "=== CORE BEHAVIOR ===",
    "- Infer intent from typos and casual English.",
    "- If email + customer name are both present → propose_create_rule",
    "  (or update) IMMEDIATELY. Never re-ask for From/customer.",
    "- If site type + accessorials are both present → propose immediately",
    "  (identifyVia ai for known sites). Do not restart questionnaires.",
    "- Ask identify ONLY when creating a NEW ambiguous accessorial rule",
    "  and you truly lack how to match it (not military/nursing/hotel,",
    "  not sender→customer, and they have not already chosen).",
    "- Updates and deletes never use the identify questionnaire.",
    "- \"can you add …\" is a REQUEST, not a Can-be identify answer.",
    "- Typos: militery, millitary, fecileties, facilites, aadd, apointment.",
    "- If one fact is missing, ask ONE short question (action none).",
    "- If unsure, guess and ask \"Do you mean …?\" — never dead-end.",
    "- Never claim you saved/updated/deleted — only Confirm applies.",
    "- When proposing a rule, summarize it plainly and invite natural",
    "  confirmation (yes, sounds good, go ahead, that's right).",
    "- If user confirms naturally but action is still propose_*, keep the",
    "  proposal — the UI applies on confirm.",
    "- Full conversation thread is in messages — use ALL prior turns.",
    "- [APPLIED] messages are ground-truth Confirm results.",
    "- \"yes, but only when…\" / \"for this rule…\" = refine the last",
    "  applied or pending rule — propose_update_rule, not a new guess.",
    "- Live rule truth = Current active rules JSON only.",
    "",
    "=== FEW-SHOT EXAMPLES (follow these patterns) ===",
    "User: mshglck@gmail.com should be registered as customer name moses",
    "→ propose_create_rule ruleId sender_moses, ruleKind sender_customer,",
    "  identifyVia email, match.fromEmails [mshglck@gmail.com],",
    "  customerName moses, addAccessorials [].",
    "",
    "User: mshglck@gmail.com mapped to moses customer name",
    "→ same as above (propose immediately).",
    "",
    "User: map jared@corehome.com to Brumis, dims 40x48x62",
    "→ propose_create_rule Sender → Brumis, fromEmails [jared@corehome.com],",
    "  customerName Brumis, defaultDims {40,48,62}.",
    "",
    "User: mike oseback cc → Mike Oseback protocol only",
    "  (with email mike.oseback@ediexpressinc.com in context)",
    "→ propose_update/create with fromEmails+ccEmails+toEmails,",
    "  customerName Mike Oseback, protocolOnly true.",
    "",
    "User: Map lfwpicking@coreforce.com to Lifeworks Technology Group",
    "→ propose_create_rule sender_lifeworks_picking.",
    "",
    "User: Shaya Jacobowitz shaya@primepackaging.com → Prime Packaging Inc",
    "→ propose_create_rule with fromEmails + customerName.",
    "",
    "User: add appointment delivery for military facilities",
    "→ propose create/update aafes_military identifyVia ai,",
    "  match.siteType aafes_military, addAccessorials [LAD, APD].",
    "",
    "User: aadd for militery also delivery appointment",
    "→ same military LAD+APD proposal (typos OK).",
    "",
    "User: delete nursing home rule / remove NUD nursing",
    "→ propose_delete_rule for nursing_home (or matching id).",
    "",
    "User: delete all rules for militery bases",
    "→ propose_delete_rule aafes_military. Do not ask identify.",
    "",
    "User: when jared quotes pickup from la mirada use zip 90670",
    "→ propose_create_rule zip_fill_la_mirada_origin (same as La Mirada).",
    "",
    "User: when pickup is La Mirada use zip 90670",
    "→ propose_create_rule zip_fill, applyTo origin, fillZipCode 90670.",
    "",
    "User: yes, but only when the customer is Brumis Imports Inc",
    "  (while that create proposal is STILL PENDING — not saved yet)",
    "→ REPLACE the pending create with the refined create (same rule id,",
    "  add customerName Brumis Imports Inc, identifyVia both).",
    "  Do NOT apply/save the bare city-only rule first. One Confirm saves",
    "  the complete rule.",
    "",
    "User: yes, but only when the customer is Brumis Imports Inc",
    "  (after applying La Mirada zip fill)",
    "→ propose_update_rule same rule id; add customerName Brumis Imports Inc;",
    "  identifyVia both. Do NOT create a new bare city-only rule.",
    "",
    "User: for this rule, when pickup is La Mirada use zip 90670 — only Jared",
    "→ propose_update_rule zip_fill_la_mirada_* with fromNames/emails for Jared.",
    "",
    "User: military bases need LAD and APD",
    "→ propose create/update aafes_military, addAccessorials [LAD, APD].",
    "",
    "User: add liftgate whenever consignee says no dock",
    "→ ask_identify_source (truly missing how to identify) OR if they",
    "  already said Cannot-be / site type, propose with LFD/LFO.",
    "",
    "User: Cannot be — address / site classification only  then  LAD, APD",
    "→ propose_create_rule identifyVia ai with those codes.",
    "",
    "=== Sender→customer details ===",
    "ruleKind sender_customer; identifyVia email; addAccessorials [].",
    "Set match.fromEmails (and ccEmails/toEmails when CC'd/To).",
    "Optional match.senderDomains. protocolOnly / defaultDims when said.",
    "Do NOT ask site type, LAD, APD, or Can-be/Cannot-be for these.",
    "Ids like sender_mike_oseback / name \"Sender → Mike Oseback\".",
    "",
    "=== ZIP fill details ===",
    "ruleKind zip_fill; identifyVia ai|both when sender/customer filters;",
    "addAccessorials []. Optional customerName, fromNames, match.fromEmails.",
    "applyTo origin for pickup/Ship From; dest for delivery/Ship To.",
    "fillZipCode must be 5 digits. Overrides wrong geocoded ZIPs.",
    "Do NOT ask identify questionnaire for zip-fill rules.",
    "",
    "=== Site types (AI address classify) ===",
    "military/AAFES/nursing/hotel → identifyVia ai + match.siteType",
    "(aafes_military, nursing_home, hotel). No email-signals.",
    "Known siteType: nursing_home, hotel, amazon_fc, menards_dc,",
    "aafes_military, chain_store, residential, other.",
    "LOAD=LAD; delivery appointment=APD.",
    "",
    "=== Identify questionnaire (rare) ===",
    "Only for NEW ambiguous accessorial rules lacking match method.",
    "ask_identify_source with exactly those two quickReplies.",
    "Answers 1/2/A/B/can/cannot/button text are definitive.",
    "CAN BE → ask_email_signals; only use signals they list.",
    "CANNOT BE → identifyVia ai; siteType/flags; never invent keywords;",
    "never match: {}.",
    "",
    "Current questionnaire state:",
    `  status=${gateHint.status}; source=${gateHint.source || "null"};`,
    `  emailSignalsListed=${gateHint.emailSignalsListed};`,
    `  askedAccessorials=${!!gateHint.askedAccessorials};`,
    `  accessorials=${(gateHint.accessorials || []).join(",") || "none"};`,
    `  siteType=${gateHint.siteType || "null"}`,
    "If cannot-be / known site / accessorials listed → propose now.",
    "",
    "identifyVia: email | address_text | ai | both — include on every",
    "create/update patch.",
    "propose_update_rule: copy name+match from live rule; ruleId must",
    "match an existing id. propose_create_rule: NON-EMPTY match.",
  ].join("\n");

  const messages = [
    {role: "system", content: systemPrompt},
    ...chatTurns.slice(-RULES_CHAT_MAX_TURNS).map((m) => ({
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
      reply: raw || fallbackUnclearReply(chatTurns),
      action: "none",
      proposal: null,
    };
  }

  const gated = enforceCreateIdentifyGate(
      parsed, chatTurns, existingRules);
  return finish(gated);
}

/**
 * Sanitize any deterministic chat result before returning to UI.
 * @param {object|null} result Chat turn result.
 * @param {Array<object>} messages Chat history.
 * @return {object|null}
 */
function polishChatResult(result, messages) {
  if (!result || typeof result !== "object") return result;
  const out = {...result};
  if (typeof out.reply === "string") {
    out.reply = sanitizeChatReply(out.reply, messages);
  }
  return out;
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
  if (Object.prototype.hasOwnProperty.call(patch, "removeAccessorials") &&
      Array.isArray(patch.removeAccessorials)) {
    normalized.removeAccessorials = patch.removeAccessorials.map(String);
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
  if (Object.prototype.hasOwnProperty.call(patch, "fromNames") &&
      Array.isArray(patch.fromNames)) {
    normalized.fromNames = patch.fromNames.map(String);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "protocolOnly")) {
    normalized.protocolOnly = !!patch.protocolOnly;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "fillZipCode")) {
    normalized.fillZipCode = String(patch.fillZipCode || "")
        .replace(/\D/g, "")
        .slice(0, 5);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "applyTo")) {
    const v = String(patch.applyTo || "");
    normalized.applyTo = ["dest", "origin", "both"].includes(v) ?
      v : "origin";
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
    removeAccessorials: Array.isArray(patch.removeAccessorials) ?
      patch.removeAccessorials.map(String) : [],
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
  if (Object.prototype.hasOwnProperty.call(patch, "fillZipCode")) {
    normalized.fillZipCode = String(patch.fillZipCode || "")
        .replace(/\D/g, "")
        .slice(0, 5);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "applyTo")) {
    const v = String(patch.applyTo || "");
    normalized.applyTo = ["dest", "origin", "both"].includes(v) ?
      v : "origin";
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
  if (normalized.ruleKind === RULE_KIND_ZIP_FILL ||
      Object.prototype.hasOwnProperty.call(normalized, "fillZipCode")) {
    const zip = String(normalized.fillZipCode || "")
        .replace(/\D/g, "")
        .slice(0, 5);
    if (!/^\d{5}$/.test(zip)) {
      return {ok: false, error: "ZIP fill rule needs fillZipCode (5 digits)"};
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
  resolveChatTurns,
  resolveReferencedRuleId,
  findRecentProposedRuleId,
  findRuleByDescriptionMatch,
  extractQuotedRuleText,
  normalizeLastAppliedRule,
  validateRuleProposal,
  extractPatch,
  detectCreateIdentifyGate,
  enforceCreateIdentifyGate,
  parseIdentifyChoiceAnswer,
  parseAccessorialsAnswer,
  parseNaturalConfirmation,
  parseNaturalRejection,
  parseRejectionWithCorrection,
  sanitizeChatReply,
  polishChatResult,
  rejectionReply,
  inferCreateTopic,
  looksLikeDeleteRuleIntent,
  looksLikeCreateRuleIntent,
  looksLikeMilitaryAccessorialIntent,
  looksLikeSenderCustomerIntent,
  buildDeleteRuleProposal,
  buildMilitaryAccessorialProposal,
  buildSenderCustomerProposal,
  buildZipFillProposal,
  buildRuleRefinementProposal,
  looksLikeRuleRefinement,
  findLastAppliedRuleId,
  parseZipFillExtraConditions,
  inferSenderCustomerTopic,
  inferZipFillTopic,
  looksLikeZipFillIntent,
  isMilitaryTopicBlob,
  RULES_CHAT_MODEL,
  IDENTIFY_QUICK_REPLIES,
  QUICK_REPLY_CAN_BE,
  QUICK_REPLY_CANNOT_BE,
};
