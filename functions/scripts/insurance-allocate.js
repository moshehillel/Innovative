/**
 * Dry-run harness for the insurance premium allocation engine.
 *
 * Parses a real insurance workbook (and optional invoice PDF), runs the
 * allocation WITHOUT posting anything to Primus, prints the reconciliation
 * summary, and writes the reconciliation email HTML to a file for inspection.
 *
 * Usage:
 *   node scripts/insurance-allocate.js <excel.xlsx> [invoice.pdf]
 *
 * If no invoice PDF is given, pass the expected total instead:
 *   node scripts/insurance-allocate.js <excel.xlsx> --total 2643.88
 */

"use strict";

const fs = require("fs");
const path = require("path");
const insurance = require("../innovative-insurance");

/**
 * @return {Promise<void>}
 */
async function main() {
  const args = process.argv.slice(2);
  const excelPath = args[0];
  if (!excelPath) {
    console.error("Usage: node scripts/insurance-allocate.js " +
      "<excel.xlsx> [invoice.pdf | --total <amount>]");
    process.exit(1);
  }

  const {columns, rows} = insurance.parseInsuranceExcel(excelPath);
  console.log("Detected columns:", columns);
  console.log(`Parsed ${rows.length} shipment rows.`);

  let invoice = {};
  let invoiceTotal = 0;
  const totalFlag = args.indexOf("--total");
  if (totalFlag >= 0 && args[totalFlag + 1]) {
    invoiceTotal = Number(args[totalFlag + 1]);
  } else if (args[1] && !args[1].startsWith("--")) {
    invoice = await insurance.parseInsuranceInvoicePdf(args[1]);
    invoiceTotal = invoice.invoiceTotal;
    console.log("Invoice PDF:", {
      vendorName: invoice.vendorName,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      invoiceTotal: invoice.invoiceTotal,
    });
  }

  const result = await insurance.allocateInsurancePremiums({
    rows,
    invoiceTotal,
    invoice,
    // No postPremiumToLoad -> dry run (nothing written to Primus).
  });

  console.log("\n=== Reconciliation ===");
  console.log(JSON.stringify(result.reconciliation, null, 2));

  console.log("\n=== Skipped rows ===");
  for (const r of result.skipped) {
    console.log(
        `  Row ${r.rowIndex} | ${r.carrier || "—"} | ` +
        `BOL ${r.bol || "(none)"} | $${r.amount.toFixed(2)} | ${r.reason}`);
  }

  const outPath = path.join(__dirname, "insurance-reconciliation.html");
  fs.writeFileSync(outPath, result.email.html, "utf8");
  console.log("\nSubject:", result.email.subject);
  console.log("Email HTML written to:", outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
