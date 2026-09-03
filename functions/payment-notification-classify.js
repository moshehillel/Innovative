"use strict";

/**
 * AI classifier for ambiguous payment-notification vs invoice/remittance
 * routing. Clear Bank-of-America (etc.) alerts stay on cheap regex; this
 * module is for Zelle/QuickPay language that is NOT from a bank alert sender.
 */

const OpenAI = require("openai");

const PAYMENT_NOTIFICATION_INTENTS = new Set([
  "bank_payment_alert",
  "customer_remittance",
  "freight_invoice",
  "other",
]);

/**
 * Default model for ambiguous payment-notification decisions.
 * Bake-off (10/10 all models): gpt-4o won on latency; override with
 * PAYMENT_NOTIFICATION_CLASSIFY_MODEL.
 */
const DEFAULT_PAYMENT_NOTIFICATION_MODEL =
  process.env.PAYMENT_NOTIFICATION_CLASSIFY_MODEL ||
  "gpt-4o";

const BODY_MAX = 3500;

const SYSTEM_PROMPT = [
  "You classify inbound emails for a freight brokerage accounting inbox.",
  "Return ONLY valid JSON:",
  "{\"intent\":\"bank_payment_alert|customer_remittance|freight_invoice|other\",",
  "\"confidence\":\"high|medium|low\",",
  "\"reasoning\":\"one short sentence\"}",
  "",
  "intent meanings:",
  "- bank_payment_alert: automated bank / Zelle / Chase QuickPay / Venmo /",
  "  PayPal / ACH deposit ALERT from a payment system telling Innovative",
  "  money was received. Quiet-ignore these. Typical from:",
  "  ealerts.bankofamerica.com, alerts@chase.com, similar bank alert domains.",
  "  Subjects like \"X sent you $Y\" with bank alert body.",
  "- customer_remittance: a CUSTOMER or AP clerk saying they paid / wired /",
  "  remitted / attached check photo or remittance advice for our invoice.",
  "  Forward to Abe (accounts receivable) — NOT a silent bank ignore.",
  "- freight_invoice: carrier / factor / broker / customs (CHB) invoice,",
  "  BOL/CR thread, or docs to process — even if quoted body contains",
  "  \"Quickpay/Zelle\" banking tips from prior Innovative replies.",
  "  Example subjects: \"RE: Invoice-0003138, CR#: 266272 RE: BOL# 266272\".",
  "  Quoted Zelle tips are NOT bank alerts.",
  "- other: unclear, payment inquiry, marketing, or needs human hold —",
  "  do NOT quiet-ignore as a bank alert.",
  "",
  "Critical rules:",
  "- Quoted / forwarded banking tips (\"PLEASE NOTE OUR NEW BANKING",
  "  INFORMATION\", \"Quickpay/Zelle\", accounting@…) do NOT make an email",
  "  a bank_payment_alert.",
  "- Invoice / BOL / CR / load numbers in subject or body → prefer",
  "  freight_invoice (or customer_remittance if they clearly say paid).",
  "- Only bank_payment_alert when the message itself IS the bank alert.",
].join("\n");

/**
 * @return {string|null}
 */
function getPaymentClassifyOpenAiKey() {
  return process.env.PAYMENT_NOTIFICATION_OPENAI_API_KEY ||
    process.env.SUPPORT_CHAT_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    null;
}

/**
 * @param {string} raw
 * @return {string}
 */
function extractJsonObject(raw) {
  const text = String(raw || "").trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  if (text.startsWith("{") && text.endsWith("}")) return text;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}

/**
 * Classify payment-notification vs invoice/remittance intent.
 * @param {object} opts
 * @param {string} [opts.subject]
 * @param {string} [opts.from]
 * @param {string} [opts.body]
 * @param {Array<object>} [opts.attachments]
 * @param {string} [opts.model]
 * @return {Promise<object>}
 */
async function classifyPaymentNotificationIntent(opts = {}) {
  const subject = String(opts.subject || "");
  const from = String(opts.from || "");
  const body = String(opts.body || "").slice(0, BODY_MAX);
  const attachments = Array.isArray(opts.attachments) ? opts.attachments : [];
  const attachmentMeta = attachments.map((a) => ({
    filename: String(a && a.filename || ""),
    mimeType: String(a && a.mimeType || ""),
  }));
  const model = String(opts.model || DEFAULT_PAYMENT_NOTIFICATION_MODEL);
  const apiKey = getPaymentClassifyOpenAiKey();
  if (!apiKey) {
    return {
      intent: "other",
      confidence: "low",
      reasoning: "OpenAI key missing; refusing silent bank ignore",
      source: "no_api_key",
      model: null,
    };
  }

  try {
    const client = new OpenAI({apiKey});
    const completion = await client.chat.completions.create({
      model,
      max_completion_tokens: 180,
      response_format: {type: "json_object"},
      messages: [
        {role: "system", content: SYSTEM_PROMPT},
        {
          role: "user",
          content: JSON.stringify({
            subject,
            from,
            body,
            attachments: attachmentMeta,
          }),
        },
      ],
    });
    const raw = String(
        completion.choices &&
        completion.choices[0] &&
        completion.choices[0].message &&
        completion.choices[0].message.content || "",
    ).trim();
    const parsed = JSON.parse(extractJsonObject(raw));
    const intent = PAYMENT_NOTIFICATION_INTENTS.has(parsed.intent) ?
      parsed.intent : "other";
    const confidence = ["high", "medium", "low"].includes(parsed.confidence) ?
      parsed.confidence : "low";
    return {
      intent,
      confidence,
      reasoning: String(parsed.reasoning || "").trim() || "No reasoning.",
      source: "openai",
      model,
    };
  } catch (err) {
    return {
      intent: "other",
      confidence: "low",
      reasoning: `Classifier error: ${String(err && err.message || err)}`
          .slice(0, 200),
      source: "error",
      model,
    };
  }
}

/**
 * True when AI says quiet-ignore as bank payment alert.
 * @param {object} classification
 * @return {boolean}
 */
function aiSaysQuietIgnoreBankAlert(classification) {
  return Boolean(
      classification &&
      classification.intent === "bank_payment_alert");
}

module.exports = {
  PAYMENT_NOTIFICATION_INTENTS,
  DEFAULT_PAYMENT_NOTIFICATION_MODEL,
  SYSTEM_PROMPT,
  getPaymentClassifyOpenAiKey,
  classifyPaymentNotificationIntent,
  aiSaysQuietIgnoreBankAlert,
};
