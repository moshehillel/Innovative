"use strict";

/**
 * Default OpenAI model for lightweight tasks (support chat, daily report
 * polish, flow summaries, quote rules chat). Override per feature via env:
 * SUPPORT_CHAT_MODEL, FLOW_SUMMARY_MODEL, DAILY_ACTIVITY_REPORT_MODEL, etc.
 */
const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";

module.exports = {DEFAULT_OPENAI_MODEL};
