/**
 * Classifies carrier-invoice PDFs.
 * Two or more files are each read on their own, and a file that comes
 * back empty is retried once. One PDF that holds many invoices is
 * re-read in overlapping page chunks when the first answer is partial,
 * whether or not the email is a numbered statement.
 */
"use strict";

const {PDFDocument} = require("pdf-lib");
const podUtils = require("./pod-utils");
const statementInvoiceBundle = require("./statement-invoice-bundle");

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
 * @param {Buffer} buffer PDF bytes.
 * @return {Promise<number>}
 */
async function pdfPageCount(buffer) {
  try {
    const pdf = await PDFDocument.load(buffer, {ignoreEncryption: true});
    return pdf.getPageCount();
  } catch (_) {
    return 0;
  }
}

/**
 * True when the model text is one complete JSON value.
 * Salvage of a cut-off answer is not complete.
 * @param {string} rawText Model text.
 * @return {boolean}
 */
function jsonTextIsComplete(rawText) {
  let text = String(rawText || "").trim();
  if (!text) return false;
  text = text.replace(/^```(?:json)?\s*/i, "");
  text = text.replace(/\s*```\s*$/i, "").trim();
  const tryParse = (value) => {
    try {
      JSON.parse(value);
      return true;
    } catch (_) {
      return false;
    }
  };
  if (tryParse(text)) return true;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return tryParse(text.slice(start, end + 1));
  }
  return false;
}

/**
 * @param {object} ctx stopReason, cutOff, endedEarly, counts.
 * @return {{partial: boolean, reasons: string[], expectedCount: number}}
 */
function assessInvoiceRead(ctx) {
  const reasons = [];
  const stop = String(ctx.stopReason || "");
  const lengthLimit = stop === "max_tokens" || stop === "length";
  if (lengthLimit) reasons.push("length_limit");
  if (ctx.cutOff) reasons.push("cut_off");
  if (ctx.endedEarly) reasons.push("ended_early");
  const pageCount = Number(ctx.pageCount) || 0;
  const count = Number(ctx.invoiceCount) || 0;
  const expected = statementInvoiceBundle.estimateStatementInvoiceCount({
    pageCount,
  });
  const short = pageCount >= 6 && expected >= 2 && count < expected;
  // A finished one-invoice PDF is a normal bill, even when it is long.
  // Several bills plus a higher page count means the packet continues.
  if (short && count >= 2) {
    reasons.push("fewer_than_pages");
  }
  const truncated = reasons.some((r) => r !== "fewer_than_pages");
  let partial = false;
  if (truncated && count >= 1) partial = true;
  if (reasons.includes("fewer_than_pages") && count >= 1) partial = true;
  return {partial, reasons, expectedCount: expected};
}

/**
 * Records whether a classifier answer stopped before the whole PDF.
 * @param {object} parsed Parsed classifier JSON.
 * @param {object} response Anthropic message.
 * @return {object} Same parsed object.
 */
function annotateInvoiceRead(parsed, response) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parsed;
  }
  const blocks = response && Array.isArray(response.content) ?
    response.content : [];
  const block = blocks.find((b) => b && b.type === "text" && b.text);
  const rawText = block ? String(block.text) : "";
  const stop = response && response.stop_reason ?
    String(response.stop_reason) : "";
  const cutOff = rawText ? !jsonTextIsComplete(rawText) : false;
  const lengthLimit = stop === "max_tokens" || stop === "length";
  const endedEarly = (stop === "end_turn" && cutOff) ||
    (!!stop && stop !== "end_turn" && !lengthLimit);
  const count = itemsFromResult(parsed).length;
  const decision = assessInvoiceRead({
    stopReason: stop,
    cutOff,
    endedEarly,
    invoiceCount: count,
    pageCount: 0,
  });
  parsed.stopReason = stop;
  parsed.cutOff = cutOff;
  parsed.endedEarly = endedEarly;
  parsed.readPartial = decision.partial;
  parsed.partialReasons = decision.reasons;
  return parsed;
}

/**
 * @param {object} item Invoice item.
 * @return {{load: string, inv: string}}
 */
function invoiceIdentity(item) {
  return {
    load: String(item && item.loadNumber || "").trim(),
    inv: String(item && item.invoiceNumber || "").trim().toLowerCase(),
  };
}

/**
 * @param {object} item Invoice item.
 * @return {boolean}
 */
function hasReviewIdentity(item) {
  const id = invoiceIdentity(item);
  if (id.load || id.inv) return true;
  if (String(item && item.proNumber || "").trim()) return true;
  const amt = Number(item && item.invoiceAmount);
  return Number.isFinite(amt) && amt > 0;
}

/**
 * Adds invoices the first pass did not already save.
 * Same load number or invoice number is not added again.
 * A bill with no load number is kept when it still has an invoice
 * number, PRO, or amount so the existing review path can see it.
 * @param {Array<object>} existing Items already saved.
 * @param {Array<object>} incoming Items from a later read.
 * @return {{items: Array<object>, skipped: Array<object>}}
 */
function mergeUnseenInvoiceItems(existing, incoming) {
  const loads = new Set();
  const invs = new Set();
  const extras = new Set();
  const items = [];
  const skipped = [];
  const remember = (item) => {
    const id = invoiceIdentity(item);
    if (id.load) loads.add(id.load);
    if (id.inv) invs.add(id.inv);
    if (!id.load && !id.inv) {
      extras.add(reviewFingerprint(item));
    }
  };
  for (const item of existing || []) {
    if (!item || typeof item !== "object") continue;
    items.push(item);
    remember(item);
  }
  for (const item of incoming || []) {
    if (!item || typeof item !== "object") continue;
    const id = invoiceIdentity(item);
    if (id.load && loads.has(id.load)) continue;
    if (id.inv && invs.has(id.inv)) continue;
    if (!id.load && !id.inv && !hasReviewIdentity(item)) {
      skipped.push({
        reason: "no_load_or_invoice_number",
        proNumber: item.proNumber || "",
        invoiceAmount: item.invoiceAmount || 0,
      });
      continue;
    }
    if (!id.load && !id.inv) {
      const fp = reviewFingerprint(item);
      if (extras.has(fp)) continue;
      extras.add(fp);
      items.push(item);
      continue;
    }
    items.push(item);
    remember(item);
  }
  return {items, skipped};
}

/**
 * @param {object} item Invoice item.
 * @return {string}
 */
function reviewFingerprint(item) {
  const pro = String(item && item.proNumber || "").trim().toLowerCase();
  const amt = Number(item && item.invoiceAmount);
  const amtKey = Number.isFinite(amt) && amt > 0 ? String(amt) : "";
  const carrier = String(item && item.carrierName || "")
      .trim()
      .toLowerCase();
  return [pro, amtKey, carrier].join("|");
}

/**
 * Maps chunk-local pages back onto the original PDF.
 * @param {object} item Chunk invoice item.
 * @param {string} filename Original PDF name.
 * @param {number} startPage First original page in the chunk.
 * @return {object}
 */
function retargetChunkItem(item, filename, startPage) {
  if (!item || typeof item !== "object") return item;
  const copy = Object.assign({}, item);
  if (filename) copy.attachmentFilename = filename;
  const offset = Number(startPage) - 1;
  if (!(offset > 0)) return copy;
  const shift = (p) => {
    const n = Math.trunc(Number(p));
    if (!Number.isFinite(n) || n < 1) return p;
    return n + offset;
  };
  if (Array.isArray(copy.invoicePages)) {
    copy.invoicePages = copy.invoicePages.map(shift);
  }
  if (copy.pod && typeof copy.pod === "object") {
    const pod = Object.assign({}, copy.pod);
    if (pod.page) pod.page = shift(pod.page);
    if (Array.isArray(pod.documents)) {
      pod.documents = pod.documents.map((doc) => {
        if (!doc || !doc.page) return doc;
        return Object.assign({}, doc, {page: shift(doc.page)});
      });
    }
    copy.pod = pod;
  }
  return copy;
}

/**
 * Re-reads a PDF in overlapping page chunks and adds new invoices.
 * One failed chunk does not drop invoices already read or later chunks.
 * @param {object} opts pdf, invoiceItems, pageCount, classifyChunk.
 * @return {Promise<object>}
 */
async function supplementInvoicePdfByPageChunks(opts) {
  const pdf = opts.pdf;
  const pageCount = Number(opts.pageCount) || 0;
  const classifyChunk = opts.classifyChunk;
  const slicePdf = opts.slicePdf || podUtils.slicePdfByPages;
  const log = opts.log || (async () => {});
  let merged = (opts.invoiceItems || []).slice();
  const skipped = [];
  let chunkErrors = 0;
  if (!pdf || !pdf.buffer || pageCount < 2 || !classifyChunk) {
    return {items: merged, skipped, chunkErrors};
  }
  const chunkSize = 12;
  const step = chunkSize - 1;
  const base = pdf.filename || "invoice.pdf";
  for (let start = 2; start <= pageCount; start += step) {
    const end = Math.min(start + chunkSize - 1, pageCount);
    const pages = [];
    for (let p = start; p <= end; p++) pages.push(p);
    let chunkBuf = null;
    try {
      chunkBuf = await slicePdf(pdf.buffer, pages);
    } catch (err) {
      chunkErrors += 1;
      await log("warn", "Invoice page-chunk slice failed", {
        messageId: opts.messageId || null,
        pages: `${start}-${end}`,
        error: err && err.message,
      });
      continue;
    }
    if (!chunkBuf) continue;
    const chunkAtt = {
      filename: `${base}-p${start}-${end}.pdf`,
      mimeType: "application/pdf",
      buffer: chunkBuf,
      docType: "INVOICE",
    };
    try {
      const raw = await classifyChunk(chunkAtt);
      const chunkItems = itemsFromResult(raw).map((item) =>
        retargetChunkItem(item, pdf.filename, start));
      const merge = mergeUnseenInvoiceItems(merged, chunkItems);
      merged = merge.items;
      skipped.push(...merge.skipped);
    } catch (err) {
      chunkErrors += 1;
      await log("warn", "Invoice page-chunk classification failed", {
        messageId: opts.messageId || null,
        pages: `${start}-${end}`,
        error: err && err.message,
      });
    }
  }
  return {items: merged, skipped, chunkErrors};
}

/**
 * Continues a single PDF when the first read looks partial.
 * @param {object} opts pdf, items, rawResult, classifyChunk.
 * @return {Promise<object>}
 */
async function continuePartialInvoicePdf(opts) {
  const pdf = opts.pdf;
  const raw = opts.rawResult && typeof opts.rawResult === "object" ?
    opts.rawResult : {};
  const items = opts.items || [];
  const log = opts.log || (async () => {});
  const getPageCount = opts.getPageCount || pdfPageCount;
  let pageCount = Number(opts.pageCount);
  if (!Number.isFinite(pageCount)) {
    pageCount = pdf && pdf.buffer ? await getPageCount(pdf.buffer) : 0;
  }
  const decision = assessInvoiceRead({
    stopReason: raw.stopReason,
    cutOff: !!raw.cutOff,
    endedEarly: !!raw.endedEarly,
    invoiceCount: items.length,
    pageCount,
  });
  if (!decision.partial || items.length === 0 || pageCount < 2) {
    return {items, didChunk: false, decision, skipped: [], chunkErrors: 0};
  }
  await log("warn",
      "Partial multi-invoice PDF — reading remaining page chunks", {
        messageId: opts.messageId || null,
        filename: pdf && pdf.filename,
        reasons: decision.reasons,
        extractedCount: items.length,
        expectedCount: decision.expectedCount,
        pageCount,
      });
  const supplemented = await supplementInvoicePdfByPageChunks({
    pdf,
    invoiceItems: items,
    pageCount,
    classifyChunk: opts.classifyChunk,
    slicePdf: opts.slicePdf,
    log,
    messageId: opts.messageId,
  });
  if (supplemented.skipped.length > 0) {
    await log("warn",
        "Skipped chunk bills with no load or invoice number", {
          messageId: opts.messageId || null,
          filename: pdf && pdf.filename,
          count: supplemented.skipped.length,
        });
  }
  return {
    items: supplemented.items,
    didChunk: true,
    decision,
    skipped: supplemented.skipped,
    chunkErrors: supplemented.chunkErrors,
  };
}

/**
 * Classifies invoice PDFs. Two or more files are read one at a time.
 * Any file still missing from the result is retried once.
 * A single multi-invoice PDF that comes back partial is continued
 * in page chunks. Numbered statement packets stay on the statement
 * recovery path so that index is still applied.
 * @param {object} opts pdfAttachments, classifyCombined, classifyOne, log.
 * @return {Promise<object>}
 */
async function classifyCarrierInvoiceAttachments(opts) {
  const pdfAttachments = opts.pdfAttachments || [];
  const classifyCombined = opts.classifyCombined;
  const classifyOne = opts.classifyOne;
  const log = opts.log || (async () => {});
  const messageId = opts.messageId || null;
  const lastKnown = opts.lastKnownLoadNumber;
  const numbered =
    statementInvoiceBundle.looksLikeNumberedStatementSubject(opts.subject);
  const invoicePdfs = podUtils.listInvoicePdfAttachments(pdfAttachments)
      .filter((a) => a && a.buffer);
  const separate = podUtils.shouldClassifyEachInvoicePdf(invoicePdfs);
  let merged = [];
  let chunkSupplementDone = false;
  let readPartial = false;
  let stopReason = "";
  let cutOff = false;
  let endedEarly = false;
  let partialReasons = [];

  const noteDecision = (raw, decision, didChunk) => {
    if (decision && decision.partial) {
      readPartial = true;
      partialReasons = decision.reasons || partialReasons;
    }
    if (raw && raw.stopReason) stopReason = raw.stopReason;
    if (raw && raw.cutOff) cutOff = true;
    if (raw && raw.endedEarly) endedEarly = true;
    if (didChunk) chunkSupplementDone = true;
  };

  const continueOne = async (pdf, raw, items) => {
    if (numbered) return items;
    const continued = await continuePartialInvoicePdf({
      pdf,
      items,
      rawResult: raw,
      messageId,
      log,
      getPageCount: opts.getPageCount,
      slicePdf: opts.slicePdf,
      pageCount: opts.pageCount,
      classifyChunk: (chunkAtt) => classifyOne(chunkAtt, lastKnown),
    });
    noteDecision(raw, continued.decision, continued.didChunk);
    return continued.items;
  };

  const readOne = async (pdf) => {
    const raw = await classifyOne(pdf, lastKnown);
    const items = stampFilename(itemsFromResult(raw), pdf.filename);
    return continueOne(pdf, raw, items);
  };

  if (!separate) {
    const combined = await classifyCombined(pdfAttachments, lastKnown);
    merged = itemsFromResult(combined);
    if (invoicePdfs.length === 1) {
      merged = stampFilename(merged, invoicePdfs[0].filename);
      merged = await continueOne(invoicePdfs[0], combined, merged);
    } else if (combined && combined.readPartial) {
      readPartial = true;
      stopReason = combined.stopReason || "";
      cutOff = !!combined.cutOff;
      endedEarly = !!combined.endedEarly;
      partialReasons = combined.partialReasons || [];
    }
  } else {
    await log("info", "Classifying each invoice PDF separately", {
      messageId,
      invoicePdfCount: invoicePdfs.length,
    });
    for (const pdf of invoicePdfs) {
      try {
        const items = await readOne(pdf);
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
        const items = await readOne(pdf);
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
  return {
    invoices: merged,
    readPartial,
    stopReason,
    cutOff,
    endedEarly,
    partialReasons,
    chunkSupplementDone,
  };
}

module.exports = {
  classifyCarrierInvoiceAttachments,
  assessInvoiceRead,
  annotateInvoiceRead,
  jsonTextIsComplete,
  mergeUnseenInvoiceItems,
  supplementInvoicePdfByPageChunks,
  continuePartialInvoicePdf,
};
