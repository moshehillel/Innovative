#!/usr/bin/env node
"use strict";

/**
 * Outlook startup must not load the monolithic googleapis package.
 * The Gmail branch may load it only when MAIL_PROVIDER=gmail.
 */

process.env.MAIL_PROVIDER = "outlook";

const path = require("path");
const mailProvider = require("../mail-provider");

/**
 * @param {string} label Assertion name.
 * @param {boolean} cond Result.
 */
function check(label, cond) {
  if (!cond) {
    console.error("FAIL:", label);
    process.exit(1);
  }
  console.log("ok:", label);
}

/**
 * @return {boolean}
 */
function googleapisLoaded() {
  return Object.keys(require.cache).some((key) =>
    key.includes(`${path.sep}node_modules${path.sep}googleapis${path.sep}`));
}

check("provider is outlook", mailProvider.getProvider() === "outlook");
check("label is Outlook", mailProvider.providerLabel() === "Outlook");
check("default outlook doc id",
    mailProvider.tenantMailDocId({tenantId: "default"}) === "outlook");
check("googleapis not loaded at outlook startup", !googleapisLoaded());

let refused = false;
try {
  mailProvider.getGmailOAuthClient();
} catch (err) {
  refused = /MAIL_PROVIDER is not gmail/.test(err.message);
}
check("gmail client refused while outlook", refused);
check("refusal did not load googleapis", !googleapisLoaded());

mailProvider.init({
  db: {
    collection() {
      return {
        doc() {
          return {
            async set() {
              throw new Error("should not write");
            },
          };
        },
      };
    },
  },
});

mailProvider.persistTenantMailTokens(
    {outlookDocId: "gmail"},
    {refresh_token: "not-used"},
).then(() => {
  console.error("FAIL: outlook mode persisted a gmail token doc");
  process.exit(1);
}).catch((err) => {
  check("outlook refuses gmail token doc",
      /Refusing to persist Gmail OAuth tokens/.test(err.message));
  check("token refusal did not load googleapis", !googleapisLoaded());

  process.env.MAIL_PROVIDER = "gmail";
  const client = mailProvider.getGmailOAuthClient();
  check("gmail branch returns an oauth client",
      client && typeof client.generateAuthUrl === "function");
  check("googleapis loads only for gmail", googleapisLoaded());
  console.log("\nAll mail-provider lazy googleapis tests passed");
});
