"use strict";
const {execSync} = require("child_process");

const URL = "https://processgmailqueue-a4reug5iia-uc.a.run.app?tenantId=default";

async function main() {
  const tok = execSync("gcloud auth print-access-token", {encoding: "utf8"}).trim();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const resp = await fetch(URL, {
      method: "POST",
      headers: {Authorization: `Bearer ${tok}`},
      signal: ctrl.signal,
    });
    const text = await resp.text();
    console.log("status", resp.status);
    console.log(text.slice(0, 800));
  } finally {
    clearTimeout(timer);
  }
}

main().catch((e) => {
  console.error(e.name, e.message);
  process.exit(1);
});
