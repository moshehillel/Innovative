/* eslint-disable no-console */
"use strict";

const freightDims = require("../quote-freight-dims");

let failures = 0;
const check = (name, got, exp) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) {
    console.log(`  got: ${JSON.stringify(got)}`);
    console.log(`  exp: ${JSON.stringify(exp)}`);
  }
};

const lwh = (row) => [row.length, row.width, row.height];
const plt = (length, width, height, extra) => freightDims.normalizePalletDims({
  qty: 1, weight: 1000, dimType: "PLT", length, width, height, ...extra,
});

check("48x40x28 → 40x48x28", lwh(plt(48, 40, 28)), [40, 48, 28]);
check("40x48x57 stays", lwh(plt(40, 48, 57)), [40, 48, 57]);
check("40x57x48 → 40x48x57", lwh(plt(40, 57, 48)), [40, 48, 57]);
check("48x57x40 → 40x48x57", lwh(plt(48, 57, 40)), [40, 48, 57]);
check("57x40x48 → 40x48x57", lwh(plt(57, 40, 48)), [40, 48, 57]);
check("45x79x45 → 45x45x79", lwh(plt(45, 79, 45)), [45, 45, 79]);
check("45x72x45 → 45x45x72", lwh(plt(45, 72, 45)), [45, 45, 72]);
check("45x45x79 stays", lwh(plt(45, 45, 79)), [45, 45, 79]);
check("48x45x39 stays non-GMA", lwh(plt(48, 45, 39)), [48, 45, 39]);
check("96x48x48 stays long", lwh(plt(96, 48, 48)), [96, 48, 48]);
check("96x40x48 unlabeled → 40x48x96", lwh(plt(96, 40, 48)), [40, 48, 96]);
check("labeled 96L x 40W x 48H kept", lwh(plt(96, 40, 48, {
  dimAxesLabeled: true,
})), [96, 40, 48]);
check("40x48x40 stays short GMA", lwh(plt(40, 48, 40)), [40, 48, 40]);
check("48x40x48 → 40x48x48", lwh(plt(48, 40, 48)), [40, 48, 48]);

check("carton not reordered", lwh(freightDims.normalizePalletDims({
  qty: 1, length: 40, width: 57, height: 48, dimType: "CTN",
})), [40, 57, 48]);

const lwhOnly = (d) => d && ({length: d.length, width: d.width, height: d.height});
check("labels 40L x 57H x 48W",
    lwhOnly(freightDims.parseDimTripleString("40L x 57H x 48W")),
    {length: 40, width: 48, height: 57});
check("labels 57H x 40W x 48L",
    lwhOnly(freightDims.parseDimTripleString("57H x 40W x 48L")),
    {length: 48, width: 40, height: 57});
check("labels L 40 x H 57 x W 48",
    lwhOnly(freightDims.parseDimTripleString("L 40 x H 57 x W 48")),
    {length: 40, width: 48, height: 57});
check("labels L:40 x H:57 x W:48",
    lwhOnly(freightDims.parseDimTripleString("L:40 x H:57 x W:48")),
    {length: 40, width: 48, height: 57});
check("unlabeled 48*40*28 written order",
    lwhOnly(freightDims.parseDimTripleString("48*40*28")),
    {length: 48, width: 40, height: 28});
check("scattered H: 57 L: 40 W: 48",
    freightDims.parseAxisLabeledDims("H: 57 in\nL: 40 in\nW: 48 in"),
    {length: 40, width: 48, height: 57});
check("scattered Length Width Height",
    freightDims.parseAxisLabeledDims(
        "Weight: 100 lbs Length: 40 in Width: 57 in Height: 48 in"),
    {length: 40, width: 57, height: 48});

if (failures) {
  console.log(`FAILED ${failures}`);
  process.exit(1);
}
console.log("OK");
