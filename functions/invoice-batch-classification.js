/**
 * Classifies carrier-invoice PDFs so a multi-file email cannot stop
 * after the first bill. Central Transport sends one PDF per invoice.
 */
"use strict";

const podUtils = require("./pod-utils");

/**
 * @param {object|Array<object>} result Classifier payload.
 * @return {Array<object>}
 */
function itemsFromResult(result) {
  if (Array.isArray(result)) return result.filter(Boolean);
  return podUtils.normalizeClassificationToInvoices(result);
}

/**
 * @param {Array<object>} items Invoice items.
 * @param {string} filename PDF filename.
 * @return {Array<object>}
 */
function stampFilename(items, filename) {
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (!String(item.attachmentFilename || "").trim()) {
      item.attachmentFilename = filename;
    }
  }
  return items;
}

/**
 * Classifies invoice PDFs. Two or more files are read one at a time.
 * Any file still missing from the result is retried once.
 * @param {object} opts pdfAttachments, classifyCombined, classifyOne, log.
 * @return {Promise<{invoices: Array<object>}>}
 */
async function classifyCarrierInvoiceAttachments(opts) {
  const pdfAttachments = opts.pdfAttachments || [];
  const classifyCombined = opts.classifyCombined;
  const classifyOne = opts.classifyOne;
  const log = opts.log || (async () => {});
  const messageId = opts.messageId || null;
  const lastKnown = opts.lastKnownLoadNumber;
  const invoicePdfs = podUtils.listInvoicePdfAttachments(pdfAttachments)
      .filter((a) => a && a.buffer);
  const separate = podUtils.shouldClassifyEachInvoicePdf(invoicePdfs);
  let merged = [];

  const runOne = async (pdf) => {
    const result = await classifyOne(pdf, lastKnown);
    return stampFilename(itemsFromResult(result), pdf.filename);
  };

  if (!separate) {
    const combined = await classifyCombined(pdfAttachments, lastKnown);
    merged = itemsFromResult(combined);
  } else {
    await log("info", "Classifying each invoice PDF separately", {
      messageId,
      invoicePdfCount: invoicePdfs.length,
    });
    for (const pdf of invoicePdfs) {
      try {
        const items = await runOne(pdf);
        merged.push(...items);
      } catch (err) {
        await log("warn", "Per-invoice PDF classification failed", {
          messageId,
          filename: pdf.filename,
          error: err && err.message,
        });
      }
    }
  }

  let uncovered = podUtils.listUncoveredInvoiceAttachments(
      merged, invoicePdfs);
  if (uncovered.length > 0) {
    await log("warn",
        "Retrying invoice PDFs missing from classification", {
          messageId,
          filenames: uncovered.map((a) => a.filename),
          extractedCount: merged.length,
        });
    for (const pdf of uncovered) {
      try {
        const items = await runOne(pdf);
        merged.push(...items);
      } catch (err) {
        await log("warn", "Uncovered invoice PDF retry failed", {
          messageId,
          filename: pdf.filename,
          error: err && err.message,
        });
      }
    }
    uncovered = podUtils.listUncoveredInvoiceAttachments(
        merged, invoicePdfs);
    if (uncovered.length > 0) {
      await log("error",
          "Invoice PDFs still unclassified after retry", {
            messageId,
            filenames: uncovered.map((a) => a.filename),
          });
    }
  }

  if (merged.length === 0) {
    throw new Error(
        "No invoices classified from " +
        invoicePdfs.length + " invoice PDF(s)");
  }
  return {invoices: merged};
}

module.exports = {
  classifyCarrierInvoiceAttachments,
};
