"use strict";

async function main() {
  const html = await (await fetch(
      "https://www.fedexfreight.com/fedextrack/?trknbr=7338614695" +
      "&trkqual=%7E7338614695%7EFDFR",
  )).text();
  console.log("config refs", html.match(/config[^\"']+\.json/gi) || []);
  const unauth = [...html.matchAll(/\"([^\"]*unauth[^\"]*)\"/gi)].map((x) => x[1]);
  console.log("unauth", unauth);
  const https = [...html.matchAll(/\"(https?:[^\"]+)\"/g)].map((x) => x[1]);
  console.log("https in html", https.slice(0, 30));
  const inline = [...html.matchAll(/apiGateway[^,}]{0,200}/g)].map((x) => x[0]);
  console.log("apiGateway", inline.slice(0, 10));
}

main().catch(console.error);
