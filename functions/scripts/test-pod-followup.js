/* Smoke tests for pod-followup.js */
const pf = require("../pod-followup");

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(actual)}` +
    (ok ? "" : ` (expected ${JSON.stringify(expected)})`));
};

// Business days: Mon Jan 5 2026 → Fri Jan 9 = 4bd if end is Jan 9
// From Mon Jan 5 12:00 UTC to Fri Jan 9 12:00 UTC:
// Tue,Wed,Thu,Fri = 4
const mon = new Date(Date.UTC(2026, 0, 5, 12));
const fri = new Date(Date.UTC(2026, 0, 9, 12));
check("Mon→Fri business days", pf.businessDaysBetween(mon, fri), 4);

const wed = new Date(Date.UTC(2026, 0, 7, 12));
check("Mon→Wed business days", pf.businessDaysBetween(mon, wed), 2);

// Weekend skip: Fri → Mon next week
const friEve = new Date(Date.UTC(2026, 0, 9, 18));
const nextMon = new Date(Date.UTC(2026, 0, 12, 12));
check("Fri→Mon business days", pf.businessDaysBetween(friEve, nextMon), 1);

check("same day = 0", pf.businessDaysBetween(mon, mon), 0);

const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const bigJpeg = Buffer.concat([jpegMagic, Buffer.alloc(60000)]);
check("trailer image size+magic",
    pf.isTrailerImageAttachment(
        {mimeType: "image/jpeg", filename: "t.jpg"}, bigJpeg), true);
check("tiny image skipped",
    pf.isTrailerImageAttachment(
        {mimeType: "image/jpeg", filename: "t.jpg"}, jpegMagic), false);

check("carrier email from vendor",
    pf.resolveCarrierEmail({vendor: {email: "c@x.com"}}).email,
    "c@x.com");

const req = pf.buildCarrierPodRequestEmail({
  loadNumber: "264172", carrierName: "ABC", isReminder: false,
});
check("request subject has load", req.subject.includes("264172"), true);
const rem = pf.buildCarrierPodRequestEmail({
  loadNumber: "264172", isReminder: true,
});
check("reminder prefix", rem.subject.startsWith("Reminder:"), true);

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
