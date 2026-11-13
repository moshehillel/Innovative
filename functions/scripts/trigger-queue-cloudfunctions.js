"use strict";
const {execSync} = require("child_process");

const URLS = [
  "https://us-central1-tai-invoice-automation.cloudfunctions.net/processGmailQueue?tenantId=default",
  "https://us-central1-tai-invoice-automation.cloudfunctions.net/checkMailInbox?tenantId=default",
];

async function tryUrl(url) {
  const tok = execSync("gcloud auth print-access-token", {encoding: "utf8"}).trim();
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 90000);
  const resp = await fetch(url, {
    method: "POST",
    headers: {Authorization: `Bearer ${tok}`},
    signal: ctrl.signal,
  });
  const text = await resp.text();
  console.log("\nURL:", url);
  console.log("status:", resp.status);
  console.log(text.slice(0, 500));
}

(async () => {
  for (const url of URLS) {
    try {
      await tryUrl(url);
    } catch (e) {
      console.error("fail", url, e.message);
    }
  }
})();
