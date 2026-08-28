"use strict";
/**
 * Requeue RM Capital Lisa FW: REF# emails after email-level classification fix.
 */
const {execSync} = require("child_process");

const PROJECT = "tai-invoice-automation";
const MESSAGE_IDS = [
  {
    id: "AAMkAGU5MDg4MmNlLTdjNGYtNGI2ZC1iYjMxLTA1YzI2ZmIwZTczMgBGAAAAAAAqntx80xUMS" +
      "q6IxxEc6_lyBwAKzphD0oUnQrPDK_2RRTFaAAAAAAEMAAAKzphD0oUnQrPDK_2RRTFaAAc-dqURAAA=",
    load: "264969",
  },
  {
    id: "AAMkAGU5MDg4MmNlLTdjNGYtNGI2ZC1iYjMxLTA1YzI2ZmIwZTczMgBGAAAAAAAqntx80xUMS" +
      "q6IxxEc6_lyBwAKzphD0oUnQrPDK_2RRTFaAAAAAAEMAAAKzphD0oUnQrPDK_2RRTFaAAc-dqUQAAA=",
    load: "264627",
  },
  {
    id: "AAMkAGU5MDg4MmNlLTdjNGYtNGI2ZC1iYjMxLTA1YzI2ZmIwZTczMgBGAAAAAAAqntx80xUMS" +
      "q6IxxEc6_lyBwAKzphD0oUnQrPDK_2RRTFaAAAAAAEMAAAKzphD0oUnQrPDK_2RRTFaAAc-dqUPAAA=",
    load: "264862",
  },
  {
    id: "AAMkAGU5MDg4MmNlLTdjNGYtNGI2ZC1iYjMxLTA1YzI2ZmIwZTczMgBGAAAAAAAqntx80xUMS" +
      "q6IxxEc6_lyBwAKzphD0oUnQrPDK_2RRTFaAAAAAAEMAAAKzphD0oUnQrPDK_2RRTFaAAc-dqUOAAA=",
    load: "264678",
  },
];
const QUEUE_URLS = [
  "https://processgmailqueue-a4reug5iia-uc.a.run.app?tenantId=default",
  "https://us-central1-tai-invoice-automation.cloudfunctions.net/" +
    "processGmailQueue?tenantId=default",
];

function token() {
  return execSync("gcloud auth print-access-token", {encoding: "utf8"}).trim();
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
      console.warn("reprocess error", base, err.message);
    }
  }
  return false;
}

async function resetQueueDoc(messageId) {
  const url =
    `https://firestore.googleapis.com/v1/projects/${PROJECT}/` +
    `databases/(default)/documents/gmailQueue/${encodeURIComponent(messageId)}`;
  const tok = token();
  const getResp = await fetch(url, {
    headers: {Authorization: `Bearer ${tok}`},
  });
  if (getResp.status === 404) {
    console.log("no queue doc", messageId.slice(-12));
    return;
  }
  const patchBody = {
    fields: {
      status: {stringValue: "queued"},
      intakeStatus: {stringValue: "queued"},
      outcome: {nullValue: null},
      finalStatus: {nullValue: null},
      forwardReason: {nullValue: null},
    },
  };
  const patchResp = await fetch(url + "?updateMask.fieldPaths=status" +
    "&updateMask.fieldPaths=intakeStatus&updateMask.fieldPaths=outcome" +
    "&updateMask.fieldPaths=finalStatus&updateMask.fieldPaths=forwardReason", {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${tok}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patchBody),
  });
  console.log("reset queue", messageId.slice(-12), patchResp.status);
}

async function main() {
  for (const row of MESSAGE_IDS) {
    console.log("\n=== requeue load #" + row.load + " ===");
    await resetQueueDoc(row.id);
    await triggerReprocess(row.id);
  }
  console.log("\nDone — watch Cloud logs for invoice extraction.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
