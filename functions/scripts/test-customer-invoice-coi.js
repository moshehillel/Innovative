/* eslint-disable no-console */
const bridge = require("../primus-ui-bridge");
const {
  listCertificateOfInsuranceTypeIds,
  listCoiDriveFiles,
  loadHasPostedInsurance,
  selectCustomerInvoiceCoi,
  emailBodyWithCoiNote,
} = bridge._internal;

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(actual)}` +
    (ok ? "" : ` (expected ${JSON.stringify(expected)})`));
};

const types = [
  {id: "0", code: "POD", name: "POD - Proof of Delivery"},
  {id: "1", code: "COI", name: "Certificate of Insurance"},
  {id: "367", code: "COI", name: "Certificate of Insurance"},
  {id: "372", code: "OB", name: "Carrier Bill"},
  {id: "407", code: "CCI", name: "Carrier Cargo Insurance "},
  {id: "465", code: "DC", name: "Detention Certificate"},
];
check("coi type ids", listCertificateOfInsuranceTypeIds(types), ["1", "367"]);

const docData = {
  drive: [
    {
      id: "pod-row",
      fileId: "drive-pod",
      type: "0",
      fileName: "pod-269392.pdf",
      fileTypeName: "POD",
    },
    {
      id: "coi-row",
      fileId: "drive-coi",
      type: "1",
      fileName: "COI_BOL%23269392.pdf",
      fileDescription: "Redkik COI File",
      fileTypeName: "Certificate of Insurance",
    },
    {
      id: "detention-row",
      fileId: "drive-detention",
      type: "465",
      fileName: "detention.pdf",
      fileTypeName: "Detention Certificate",
    },
    {
      id: "carrier-ins-row",
      fileId: "drive-cci",
      type: "407",
      fileName: "carrier-cargo.pdf",
      fileTypeName: "Carrier Cargo Insurance",
    },
  ],
};

const coiFiles = listCoiDriveFiles(docData, ["1", "367"]);
check("selects per-load Redkik COI", coiFiles, [{
  driveId: "drive-coi",
  fileName: "COI_BOL#269392.pdf",
}]);

const insured = selectCustomerInvoiceCoi({
  docData,
  coiTypeIds: ["1", "367"],
  carrierBillDriveIds: [],
  actualCosts: null,
  insuranceVendorId: null,
});
check("attaches COI when the certificate is on the load", {
  hasInsurance: insured.hasInsurance,
  coiDriveIds: insured.coiDriveIds,
  missing: insured.missing,
  name: insured.coiAttachmentName,
}, {
  hasInsurance: true,
  coiDriveIds: ["drive-coi"],
  missing: false,
  name: "Certificate of Insurance",
});

const costsOnly = selectCustomerInvoiceCoi({
  docData: {drive: [docData.drive[0]]},
  coiTypeIds: ["1", "367"],
  carrierBillDriveIds: [],
  actualCosts: [
    {carrierId: "143644", description: "FREIGHT CHARGE", total: 750},
    {carrierId: "108637", description: "insurance", total: 35},
  ],
  insuranceVendorId: "108637",
});
check("posted Redkik premium with no file is a miss", {
  hasInsurance: costsOnly.hasInsurance,
  coiDriveIds: costsOnly.coiDriveIds,
  missing: costsOnly.missing,
}, {
  hasInsurance: true,
  coiDriveIds: [],
  missing: true,
});

check("other carrier is not insurance",
    loadHasPostedInsurance(
        [{carrierId: "143644", description: "insurance"}], "108637"),
    false);
check("matching vendor is insurance",
    loadHasPostedInsurance(
        [{carrierId: "108637", description: "insurance"}], "108637"),
    true);

const uninsured = selectCustomerInvoiceCoi({
  docData: {drive: [docData.drive[0]]},
  coiTypeIds: ["1", "367"],
  actualCosts: [{carrierId: "143644", description: "FREIGHT CHARGE"}],
  insuranceVendorId: "108637",
});
check("no insurance means no COI and no miss", {
  hasInsurance: uninsured.hasInsurance,
  missing: uninsured.missing,
  coiDriveIds: uninsured.coiDriveIds,
}, {hasInsurance: false, missing: false, coiDriveIds: []});

const blocked = selectCustomerInvoiceCoi({
  docData,
  coiTypeIds: ["1", "367"],
  carrierBillDriveIds: ["drive-coi"],
  actualCosts: [{carrierId: "108637", description: "insurance"}],
  insuranceVendorId: "108637",
});
check("carrier-bill id is not attached", blocked.coiDriveIds, []);
check("blocked cert on an insured load is still a miss", blocked.missing, true);

const plain = "<p>Please see your invoices attached.</p><p>Thank you!</p>";
check("body unchanged without a certificate",
    emailBodyWithCoiNote(plain, {coiDriveIds: []}), plain);
const noted = emailBodyWithCoiNote(plain, {coiDriveIds: ["drive-coi"]});
check("body names the certificate",
    noted.includes("Certificate of Insurance") &&
    noted.includes("Please see your invoices attached."),
    true);
check("body note is not duplicated",
    emailBodyWithCoiNote(noted, {coiDriveIds: ["drive-coi"]}) === noted,
    true);

console.log(failures ? `\n${failures} FAILURES` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
