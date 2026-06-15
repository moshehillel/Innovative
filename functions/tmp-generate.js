const BASE = "https://sandbox-api.shipprimus.com";
const API = BASE + "/api/v1";

(async () => {
  const token = (await fetch(API + "/login", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({username: "INNUSER", password: "Primus2026!"}),
  }).then((r) => r.json())).data.accessToken;
  const h = {Authorization: "Bearer " + token, "Content-Type": "application/json"};

  // Find invoices that already have actualCosts:true and costActualClosed:true
  const invList = await fetch(API + "/invoice?limit=50", {headers: h}).then((r) => r.json());
  const invoices = invList.data && invList.data.results;
  if (!invoices) { console.log("No invoices:", JSON.stringify(invList)); return; }

  const readyOnes = invoices.filter((i) => i.status &&
    i.status.actualCosts && i.status.costActualClosed);
  console.log("Invoices with actualCosts+closed:", readyOnes.length, "out of", invoices.length);

  if (!readyOnes.length) { console.log("None found"); return; }

  // Get full detail of one that is ready
  const sample = readyOnes[0];
  console.log("\nSample invoice:", sample.invoiceId, "| generated:", sample.status.generated);
  console.log("BOLNumber:", sample.shipment && sample.shipment.BOLNumber);

  const full = await fetch(API + "/invoice/" + sample.invoiceId, {headers: h}).then((r) => r.json());
  const f = full.data && full.data.results;
  console.log("\nFull status:", JSON.stringify(f && f.status, null, 2));
  console.log("\ncostBreakdown:", JSON.stringify(f && f.costBreakdown, null, 2));
  console.log("\npayableBreakdown:", JSON.stringify(f && f.payableBreakdown, null, 2));

  // Check booking for this load
  const BOLNumber = sample.shipment && sample.shipment.BOLNumber;
  if (BOLNumber) {
    const bk = await fetch(API + "/book/bolnumber/" + BOLNumber, {headers: h}).then((r) => r.json());
    const booking = bk.data && bk.data.results;
    console.log("\nBooking vendor:", JSON.stringify(booking && booking.vendor, null, 2));
    console.log("Booking status:", JSON.stringify(booking && booking.status, null, 2));
  }
})().catch((e) => console.error(e.message));
