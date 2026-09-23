/* Power Only picture pages count as POD without a signed document. */
const podUtils = require("../pod-utils");

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(actual)}` +
    (ok ? "" : ` (expected ${JSON.stringify(expected)})`));
};

const select = podUtils.selectPowerOnlyPicturePages;

check("invoice page plus photo page",
    select([
      "HENDRY TRUCKING invoice total 300.00 freight bill",
      "",
    ], 300, 2),
    [2]);

check("photo page with a short caption",
    select([
      "Invoice 267650 amount due 300.00",
      "Trailer 4521",
    ], 300, 2),
    [2]);

check("signed text page is not a picture",
    select([
      "Invoice amount 300.00",
      "Received in good condition. Signed by the consignee at the dock " +
        "door after the trailer was unloaded and counted.",
    ], 300, 2),
    []);

check("amount page is never the picture POD",
    select(["Total 300.00", "photo"], 300, 2),
    [2]);

check("all-photo pdf with short captions",
    select(["Trailer rear", "Trailer side"], 1144, 2),
    [1, 2]);

check("no text keeps page 1 as the bill",
    select(null, 300, 3),
    [2, 3]);

check("single scanned page is not assumed to be photos",
    select(null, 300, 1),
    []);

check("single photo file with a caption",
    select(["Unit 256255"], 300, 1),
    [1]);

const rules = podUtils.buildPodClassifierRules().join("\n");
check("classifier accepts unsigned trailer photos",
    /no signature, stamp, or signed bill of lading/.test(rules),
    true);

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
