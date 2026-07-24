"use strict";

const {
  fetchFedExFreightPodPdf,
  trackFedExFreightShipment,
} = require("../fedex-freight-pod");

const PRO = process.argv[2] || "7338614695";
const ACCOUNT = process.argv[3] || "301105168";

async function main() {
  console.log("track", PRO);
  const track = await trackFedExFreightShipment(PRO);
  console.log("track result", track);

  console.log("fetch POD", PRO, "account", ACCOUNT);
  const pod = await fetchFedExFreightPodPdf(PRO, {accountNumber: ACCOUNT});
  console.log("pod", {
    ok: pod.ok,
    error: pod.error,
    proNumber: pod.proNumber,
    accountNumber: pod.accountNumber,
    bytes: pod.pdfBuffer && pod.pdfBuffer.length,
  });
  if (pod.ok && pod.pdfBuffer) {
    require("fs").writeFileSync(`fedex-pod-${PRO}.pdf`, pod.pdfBuffer);
    console.log("saved", `fedex-pod-${PRO}.pdf`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
