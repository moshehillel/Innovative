"use strict";

const trk = process.argv[2] || "7338614695";
const account = process.argv[3] || "301105168";

async function main() {
  const trkqual = `~${trk}~FDFR`;
  const trackUrl =
    `https://www.fedexfreight.com/fedextrack/?trknbr=${trk}` +
    `&trkqual=${encodeURIComponent(trkqual)}`;
  console.log("GET", trackUrl);
  const r = await fetch(trackUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "Accept": "text/html,application/xhtml+xml",
    },
  });
  const html = await r.text();
  console.log("status", r.status, "len", html.length);
  const scripts = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
  console.log("scripts", scripts.filter((s) => /\.js/.test(s)).slice(0, 25));
  const inline = [...html.matchAll(/\/api\/[^\"'\s]+/g)].map((m) => m[0]);
  console.log("inline api paths", [...new Set(inline)].slice(0, 30));
  const podText = html.toLowerCase().includes("proof of delivery");
  console.log("has POD text", podText);
  const hits = [];
  const re = /https?:[^\"'\s<>]+/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const u = m[0];
    if (/api|track|pod|document|pdf|signature|delivery/i.test(u)) {
      hits.push(u);
    }
  }
  console.log("interesting urls", [...new Set(hits)].slice(0, 40));

  const apis = [
    "https://api.fedex.com/track/v1/trackingnumbers",
    "https://www.fedex.com/trackingCal/track",
  ];
  for (const api of apis) {
    try {
      const resp = await fetch(api, {method: "GET"});
      console.log("api probe", api, resp.status);
    } catch (e) {
      console.log("api probe fail", api, e.message);
    }
  }

  // Common FedEx document API patterns from public docs
  const docCandidates = [
    `https://www.fedex.com/document/v1/documents/retrieve?documentType=POD` +
    `&trackingNumber=${trk}`,
    `https://apis.fedex.com/track/v1/trackingdocuments`,
  ];
  for (const u of docCandidates) {
    try {
      const resp = await fetch(u, {method: "GET"});
      console.log("doc", u.slice(0, 80), resp.status,
          (await resp.text()).slice(0, 120));
    } catch (e) {
      console.log("doc fail", e.message);
    }
  }
  console.log("account", account);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
