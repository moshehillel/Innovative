"use strict";
/**
 * Requeue RM Capital REF# 266111 after REF# invoice classification fix.
 */
const {execSync} = require("child_process");

const PROJECT = "tai-invoice-automation";
const MESSAGE_ID =
  "AAMkAGU5MDg4MmNlLTdjNGYtNGI2ZC1iYjMxLTA1YzI2ZmIwZTczMgBGAAAAAAAqntx80xUMS" +
  "q6IxxEc6_lyBwAKzphD0oUnQrPDK_2RRTFaAAAAAAEMAAAKzphD0oUnQrPDK_2RRTFaAAdBrc28AAA=";
const QUEUE_URLS = [
  "https://processgmailqueue-a4reug5iia-uc.a.run.app?tenantId=default",
  "https://us-central1-tai-invoice-automation.cloudfunctions.net/" +
    "processGmailQueue?tenantId=default",
];

function token() {
  return execSync("gcloud auth print-access-token", {encoding: "utf8"}).trim();
}

function val(f) {
  if (!f) return null;
  if (f.stringValue != null) return f.stringValue;
  if (f.integerValue != null) return Number(f.integerValue);
  if (f.doubleValue != null) return Number(f.doubleValue);
  if (f.booleanValue != null) return f.booleanValue;
  if (f.timestampValue != null) return f.timestampValue;
  if (f.nullValue != null) return null;
  if (f.mapValue) {
    const o = {};
    for (const [k, v] of Object.entries(f.mapValue.fields || {})) {
      o[k] = val(v);
    }
    return o;
  }
  if (f.arrayValue) return (f.arrayValue.values || []).map(val);
  return null;
}

async function getDoc(col, id) {
  const url =
    `https://firestore.googleapis.com/v1/projects/${PROJECT}/` +
    `databases/(default)/documents/${col}/${encodeURIComponent(id)}`;
  const resp = await fetch(url, {
    headers: {Authorization: `Bearer ${token()}`},
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(await resp.text());
  const doc = await resp.json();
  const data = {};
  for (const [k, v] of Object.entries(doc.fields || {})) data[k] = val(v);
  return {id, ...data};
}

async function triggerReprocess(messageId) {
  const tok = token();
  for (const base of QUEUE_URLS) {
    const url = base + "&reprocessMessageId=" + encodeURIComponent(messageId);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      const text = await resp.text();
      console.log("reprocess", resp.status, messageId.slice(-12),
          text.slice(0, 400));
      if (resp.ok) return true;
    } catch (err) {
      console.log("reprocess error", err.message);
    }
  }
  return false;
}

async function waitForCompletion(messageId) {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    const q = await getDoc("gmailQueue", messageId);
    console.log(`poll ${messageId.slice(-8)} ${i + 1}: ` +
      `status=${q && q.status} intake=${q && q.intakeStatus} ` +
      `final=${q && q.finalStatus} outcome=${q && q.outcome} ` +
      `summary=${String(q && q.summary || "").slice(0, 120)}`);
    if (q && ["processed", "completed", "done", "failed", "forwarded",
      "noa_ignored", "human_review"].includes(String(q.status || "")) &&
        q.status !== "queued" && q.status !== "processing") {
      if (q.intakeStatus === "completed" || q.intakeStatus === "failed") break;
    }
    if (q && q.intakeStatus &&
        !["queued", "processing", "running"].includes(q.intakeStatus)) {
      break;
    }
  }
  const finalQ = await getDoc("gmailQueue", messageId);
  console.log("final gmailQueue", messageId.slice(-8),
      JSON.stringify({
        status: finalQ && finalQ.status,
        intakeStatus: finalQ && finalQ.intakeStatus,
        finalStatus: finalQ && finalQ.finalStatus,
        outcome: finalQ && finalQ.outcome,
        summary: finalQ && finalQ.summary,
        invoiceId: finalQ && finalQ.invoiceId,
      }));
}

(async () => {
  console.log("=== requeue RM Capital REF# 266111 ===");
  const ok = await triggerReprocess(MESSAGE_ID);
  if (!ok) {
    console.error("Reprocess trigger failed");
    process.exit(1);
  }
  await waitForCompletion(MESSAGE_ID);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
