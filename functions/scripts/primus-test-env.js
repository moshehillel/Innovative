/**
 * Sandbox defaults for local Primus API test scripts only.
 * Production .env values are overridden so probes never hit live REST.
 *
 * REST: https://sandbox-api.shipprimus.com/api/v1
 * User: INNUSER (sandbox test account)
 */
"use strict";

const fs = require("fs");
const path = require("path");

const SANDBOX_BASE_URL = "https://sandbox-api.shipprimus.com/api/v1";
const SANDBOX_USERNAME = "INNUSER";
const SANDBOX_PASSWORD = "Primus2026!";

/**
 * Loads optional .env.tai-invoice-automation, then forces sandbox REST creds.
 * @return {void}
 */
function applyPrimusSandboxTestEnv() {
  const envFile = path.join(__dirname, "..", ".env.tai-invoice-automation");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }

  process.env.PRIMUS_BASE_URL = SANDBOX_BASE_URL;
  process.env.PRIMUS_USERNAME = SANDBOX_USERNAME;
  process.env.PRIMUS_PASSWORD = SANDBOX_PASSWORD;
  process.env.PRIMUS_UI_USERNAME = SANDBOX_USERNAME;
  process.env.PRIMUS_UI_PASSWORD = SANDBOX_PASSWORD;
}

module.exports = {
  SANDBOX_BASE_URL,
  SANDBOX_USERNAME,
  applyPrimusSandboxTestEnv,
};
