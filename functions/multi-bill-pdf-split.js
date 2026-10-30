/**
 * Splits one PDF that holds several freight bills into one invoice item
 * per bill. A statement cover lists the bills. A packet with no cover is
 * split on each invoice page. BOL and POD pages stay with the bill they
 * belong to and do not hide the next invoice.
 *
 * The first pass only trusts pages that read as an invoice. A second pass
 * walks every remaining page so a scan that only labeled the first two
 * bills "INVOICE" still opens the rest.
 */
"use strict";

const {PDFDocument} = require("pdf-lib");
const podUtils = require("./pod-utils");

/**
 * @param {string|number|null|undefined} value Raw reference.
 * @return {string}
 */
function normRef(value) {
  return String(value || "").replace(/\D/g, "").replace(/^0+/, "");
}

/**
 * @param {string} text OCR or text-layer page.
 * @return {string}
 */
function normalizeOcr(text) {
  return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\bB\s*\/\s*L\b/gi, "B/L");
}

/**
 * @param {string} raw Amount text.
 * @return {number|null}
 */
function parseAmount(raw) {
  const n = Number(String(raw || "").replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} a Bill or invoice item.
 * @param {object} b Bill or invoice item.
 * @return {boolean}
 */
function sameBill(a, b) {
  const left = a || {};
  const right = b || {};
  const pairs = [
    [left.invoiceNumber, right.invoiceNumber],
    [left.proNumber, right.proNumber],
    [left.loadNumber, right.loadNumber],
    [left.proNumber, right.invoiceNumber],
    [left.invoiceNumber, right.proNumber],
  ];
  return pairs.some(([x, y]) => {
    const nx = normRef(x);
    const ny = normRef(y);
    return nx.length >= 5 && nx === ny;
  });
}

/**
 * @param {string} text Page text.
 * @return {boolean}
 */
function isStatementCoverPage(text) {
  const t = String(text || "").toUpperCase();
  const rows = t.match(/\bB\/L\s*#\s*\d{5,9}\b/g) || [];
  if (rows.length >= 2 && /\bTOTAL\s+BILLS\b/.test(t)) return true;
  if (!/\bSTATEMENT\b/.test(t)) return false;
  if (/\bTOTAL\s+BILLS\b/.test(t)) return true;
  return rows.length >= 2;
}

/**
 * @param {string} text Page text.
 * @return {string|null} bol, pod, rate_confirmation, or null.
 */
/**
 * A page that carries a shipment number and an amount due reads as a
 * freight bill, whatever header words it uses. Used so a support page
 * never swallows a real bill.
 * @param {string} text Page text.
 * @return {boolean}
 */
function pageHasBillSignal(text) {
  const src = String(text || "");
  return !!matchCarrierPro(src) && matchBillAmount(src) != null;
}

function supportKind(text) {
  const t = String(text || "").toUpperCase();
  // A rate/load/carrier confirmation is never a bill we pay — always support.
  if (/\bRATE\s+CONFIRMATION\b/.test(t) ||
      /\bLOAD\s+CONFIRMATION\b/.test(t) ||
      /\bCARRIER\s+CONFIRMATION\b/.test(t) ||
      /\bRATE\s*CON\b/.test(t)) {
    return "rate_confirmation";
  }
  // When the page also reads as a freight bill (shipment # + amount due),
  // it IS the bill — do not downgrade it to a support page and drop it.
  if (pageHasBillSignal(text)) return null;
  if (/\bDELIVERY\s+RECEIPT\b/.test(t) ||
      /\bPROOF\s+OF\s+DELIVERY\b/.test(t) ||
      /\bRECEIVED\s+(?:BY|IN\s+GOOD\s+(?:ORDER|CONDITION))\b/.test(t) ||
      /\bCONSIGNEE\s+SIGNATURE\b/.test(t)) {
    return "pod";
  }
  if (/\bBILL\s+OF\s+LADING\b/.test(t) ||
      /\bSTRAIGHT\s+BILL\b/.test(t) ||
      /\bUNIFORM\s+BILL\b/.test(t)) {
    return "bol";
  }
  return null;
}

/**
 * True when the page is a freight invoice, not a column header or a
 * "please send invoice" instruction on a rate confirmation.
 * @param {string} text Page text.
 * @return {boolean}
 */
function hasInvoiceTitle(text) {
  if (isStatementCoverPage(text) || supportKind(text)) return false;
  let t = String(text || "");
  t = t.replace(/\b(?:PLEASE\s+)?SEND\s+(?:YOUR\s+|THE\s+)?INVOICE\b/gi, "");
  t = t.replace(/\bINVOICE\s+AND\s+POD\b/gi, "");
  t = t.replace(/\bINVOICE\s*(?:NUMBER|NO\.?|#)/gi, "");
  // "INVOICE" is the common header, but carriers also title a bill
  // "FREIGHT BILL" / "ORIGINAL FREIGHT BILL" with no word "invoice".
  return /\bINVOICE\b/i.test(t) || /\bFREIGHT\s+BILL\b/i.test(t);
}

/**
 * Currency figures on the page, in reading order. A weight or a date
 * is not currency: currency has cents.
 * @param {string} src Page text.
 * @return {number[]}
 */
function moneyAmounts(src) {
  const out = [];
  const re = /\$?\d{1,3}(?:,\d{3})*\.\d{2}\b/g;
  let match = re.exec(src);
  while (match) {
    const n = parseAmount(match[0]);
    if (n != null && n > 0) out.push(n);
    match = re.exec(src);
  }
  return out;
}

/**
 * Shipment numbers on the page. A dashed carrier PRO wins. Otherwise the
 * last long number, which is where the PRO sits after a PO or account.
 * Six-digit loads, zips, and dates are not shipment numbers.
 * @param {string} src Page text.
 * @return {string[]}
 */
function shipmentNumbers(src) {
  const dashed = [];
  const dashRe = /\b(\d{3}-\d{6,8})\b/g;
  let dash = dashRe.exec(src);
  while (dash) {
    const n = normRef(dash[1]);
    if (n && dashed.indexOf(n) < 0) dashed.push(n);
    dash = dashRe.exec(src);
  }
  if (dashed.length) return dashed;
  const solids = [];
  const solidRe = /\b(\d{7,12})\b/g;
  let solid = solidRe.exec(src);
  while (solid) {
    if (solids.indexOf(solid[1]) < 0) solids.push(solid[1]);
    solid = solidRe.exec(src);
  }
  return solids;
}

/**
 * The shipment number. No label list: the shape of the number is enough.
 * @param {string} src Page text.
 * @return {string}
 */
function matchCarrierPro(src) {
  const nums = shipmentNumbers(src);
  if (!nums.length) return "";
  return nums[nums.length - 1];
}

/**
 * The amount due. No label list: on a freight bill the total is the
 * last dollar figure.
 * @param {string} src Page text.
 * @return {number|null}
 */
function matchBillAmount(src) {
  const amounts = moneyAmounts(src);
  if (!amounts.length) return null;
  return amounts[amounts.length - 1];
}

/**
 * A carrier page the splitter still could not open. These must be named
 * in the packet gap so an unread bill cannot disappear with no alert.
 * @param {string} text Page text.
 * @return {boolean}
 */
function looksLikeSkippedCarrierPage(text) {
  if (isStatementCoverPage(text) || supportKind(text)) return false;
  if (isLooseFreightInvoicePage(text)) return false;
  const src = String(text || "");
  if (moneyAmounts(src).length || shipmentNumbers(src).length) return true;
  return /\bPRO\b/i.test(src);
}

function extractBillIdentity(text) {
  const src = String(text || "");
  const proFromPage = matchCarrierPro(src);
  const loadM = src.match(
      /\bB\/L\s*(?:NUMBER|#)\s*:?\s*(\d{5,9})\b/i) ||
    src.match(/\bBOL\s*#?\s*:?\s*(\d{5,9})\b/i) ||
    src.match(/\bLOAD\s*#?\s*:?\s*(\d{5,9})\b/i);
  const invM = src.match(
      /\bINVOICE\s*(?:NUMBER|#|NO\.?)?\s*:?\s*(\d{4,12})\b/i);
  let pro = proFromPage;
  let load = loadM ? loadM[1] : "";
  const columnar = columnarBill(src);
  if (!load && columnar) load = columnar.loadNumber;
  if (!pro && columnar) pro = columnar.proNumber;
  let invoiceNumber = invM ? (normRef(invM[1]) || invM[1]) : "";
  if (!invoiceNumber && pro) invoiceNumber = pro;
  const amount = matchBillAmount(src);
  return {
    invoiceNumber,
    proNumber: pro,
    loadNumber: load,
    amount,
  };
}

/**
 * JTS scans put the load and PRO on the row under the column headers.
 * @param {string} src Page text.
 * @return {object|null}
 */
function columnarBill(src) {
  const lines = String(src || "").split(/\n/);
  for (const line of lines) {
    const loadM = line.match(/\d{1,2}\/\d{1,2}\/\d{2,4}\s+(\d{6})\b/);
    if (!loadM) continue;
    const pros = line.match(/\b(\d{8})\b/g) || [];
    if (!pros.length) continue;
    return {
      loadNumber: loadM[1],
      proNumber: normRef(pros[pros.length - 1]) || pros[pros.length - 1],
    };
  }
  return null;
}

/**
 * @param {object} group Group to fill.
 * @param {object} id Identity read from a page.
 * @return {void}
 */
function fillIdentity(group, id) {
  if (!group.invoiceNumber && id.invoiceNumber) {
    group.invoiceNumber = id.invoiceNumber;
  }
  if (!group.proNumber && id.proNumber) group.proNumber = id.proNumber;
  if (!group.loadNumber && id.loadNumber) group.loadNumber = id.loadNumber;
  if ((group.amount == null || group.amount === 0) && id.amount) {
    group.amount = id.amount;
  }
}

/**
 * @param {string} text Page text.
 * @return {boolean}
 */
function isStrictFreightInvoicePage(text) {
  if (!hasInvoiceTitle(text)) return false;
  const id = extractBillIdentity(text);
  return !!(id.proNumber || id.loadNumber || id.invoiceNumber || id.amount);
}

/**
 * Scanned JTS bill: the word INVOICE is a logo OCR misses, but the page
 * still has B/L NUMBER, PRO #, and TOTAL CHARGES.
 * @param {string} text Page text.
 * @return {boolean}
 */
function looksLikeColumnInvoicePage(text) {
  if (isStatementCoverPage(text) || supportKind(text)) return false;
  const t = String(text || "");
  const hasBl = /\bB\/L\s+NUMBER\b/i.test(t);
  const hasPro = /\bPRO\s*#/i.test(t);
  const hasPay = /\bTOTAL\s+CHARGES\b/i.test(t) || /\bPLEASE\s+PAY\b/i.test(t);
  return hasBl && hasPro && hasPay;
}

/**
 * Invoice page whose title word was lost by OCR, but which still shows
 * a PRO or load plus the amount due.
 * @param {string} text Page text.
 * @return {boolean}
 */
function isLooseFreightInvoicePage(text) {
  if (isStatementCoverPage(text) || supportKind(text)) return false;
  if (isStrictFreightInvoicePage(text)) return true;
  if (looksLikeColumnInvoicePage(text)) return true;
  const id = extractBillIdentity(text);
  const hasPay = matchBillAmount(text) != null;
  return hasPay && !!(id.proNumber || id.loadNumber);
}

/**
 * Bills listed on a statement cover. Empty when the page is not a cover.
 * @param {string} text Page text.
 * @return {Array<object>}
 */
function parseStatementCoverBills(text) {
  if (!isStatementCoverPage(text)) return [];
  const bills = [];
  const re = /\b(\d{7,12})\s*[([|]?\s*B\/L\s*#\s*(\d{5,9})\b/gi;
  let match = re.exec(text);
  while (match) {
    const invoiceNumber = normRef(match[1]) || match[1];
    const tail = text.slice(match.index + match[0].length,
        match.index + match[0].length + 48);
    const amounts = [];
    const amtRe = /(\d{1,3}(?:,\d{3})*\.\d{2})/g;
    let amt = amtRe.exec(tail);
    while (amt) {
      const n = parseAmount(amt[1]);
      if (n != null) amounts.push(n);
      amt = amtRe.exec(tail);
    }
    const positive = amounts.filter((n) => n > 0);
    bills.push({
      invoiceNumber,
      proNumber: invoiceNumber,
      loadNumber: match[2],
      amount: positive.length ? positive[0] : null,
    });
    match = re.exec(text);
  }
  return bills;
}

/**
 * @param {string} text Page text.
 * @return {string[]}
 */
function collectPageBillRefs(text) {
  const src = String(text || "");
  const refs = [];
  const re = new RegExp(
      "\\b(?:INVOICE|PRO)\\s*(?:NUMBER|#|NO\\.?)?\\s*:?\\s*" +
      "(\\d{3}-\\d{6,8}|\\d{6,12})\\b",
      "gi");
  let match = re.exec(src);
  while (match) {
    const n = normRef(match[1]);
    if (n.length >= 6 && refs.indexOf(n) < 0) refs.push(n);
    match = re.exec(src);
  }
  return refs;
}

/**
 * @param {Array<string>} pageTexts Normalized page texts.
 * @param {number[]} pages 1-based pages.
 * @param {object} seed Identity of the bill.
 * @return {object}
 */
function groupFromPages(pageTexts, pages, seed) {
  const group = {
    invoiceNumber: seed.invoiceNumber || "",
    proNumber: seed.proNumber || "",
    loadNumber: seed.loadNumber || "",
    amount: seed.amount || null,
    pages: pages.slice(),
    pageRoles: {},
  };
  pages.forEach((pageNo, idx) => {
    const text = pageTexts[pageNo - 1] || "";
    const loose = isLooseFreightInvoicePage(text) &&
      sameBill(group, extractBillIdentity(text));
    if (idx === 0 || loose) {
      group.pageRoles[pageNo] = "invoice";
      fillIdentity(group, extractBillIdentity(text));
    } else {
      group.pageRoles[pageNo] = supportKind(text) || "other";
    }
  });
  return group;
}

/**
 * First pass: one group per page that is clearly an invoice. Following
 * pages, including later bills whose title did not read as INVOICE, stay
 * in that group until the next clear invoice.
 * @param {Array<string>} pageTexts Page texts, index 0 = page 1.
 * @return {Array<object>}
 */
function firstPassInvoiceGroups(pageTexts) {
  const texts = (Array.isArray(pageTexts) ? pageTexts : []).map(normalizeOcr);
  const groups = [];
  let currentPages = [];
  let seed = null;
  const flush = () => {
    if (!seed || !currentPages.length) return;
    groups.push(groupFromPages(texts, currentPages, seed));
    currentPages = [];
    seed = null;
  };
  texts.forEach((text, i) => {
    if (isStatementCoverPage(text)) return;
    if (isStrictFreightInvoicePage(text)) {
      const id = extractBillIdentity(text);
      if (seed && sameBill(seed, id)) {
        currentPages.push(i + 1);
        return;
      }
      flush();
      seed = id;
      currentPages = [i + 1];
      return;
    }
    if (seed) currentPages.push(i + 1);
  });
  flush();
  return groups;
}

/**
 * @param {Array<string>} texts Normalized texts.
 * @param {number} startIndex 0-based start page.
 * @param {object} identity Bill identity.
 * @return {number[]}
 */
function takeBillPages(texts, startIndex, identity) {
  const pages = [];
  for (let i = startIndex; i < texts.length; i++) {
    const text = texts[i];
    if (isStatementCoverPage(text)) break;
    if (i > startIndex && isLooseFreightInvoicePage(text)) {
      const next = extractBillIdentity(text);
      if (!sameBill(identity, next)) break;
    }
    pages.push(i + 1);
  }
  return pages;
}

/**
 * @param {Array<object>} groups Existing groups.
 * @param {number[]} pageNos Pages to detach.
 * @return {Array<object>}
 */
function removePages(groups, pageNos) {
  const drop = new Set(pageNos);
  return groups.map((g) => {
    const pageRoles = Object.assign({}, g.pageRoles);
    pageNos.forEach((p) => {
      delete pageRoles[p];
    });
    return Object.assign({}, g, {
      pages: g.pages.filter((p) => !drop.has(p)),
      pageRoles,
    });
  }).filter((g) => g.pages.length > 0);
}

/**
 * Second pass over pages the first pass buried inside an earlier bill.
 * @param {Array<string>} texts Normalized page texts.
 * @param {Array<object>} groups First-pass groups.
 * @return {Array<object>}
 */
function secondPassInvoiceGroups(texts, groups) {
  let current = groups.slice();
  const starts = [];
  texts.forEach((text, i) => {
    if (!isLooseFreightInvoicePage(text)) return;
    const id = extractBillIdentity(text);
    const pageNo = i + 1;
    const already = current.some((g) =>
      g.pageRoles[pageNo] === "invoice" && sameBill(g, id));
    if (already) return;
    if (current.some((g) => sameBill(g, id))) return;
    starts.push({index: i, id});
  });
  starts.sort((a, b) => a.index - b.index);
  for (const start of starts) {
    if (current.some((g) => sameBill(g, start.id))) continue;
    const pages = takeBillPages(texts, start.index, start.id);
    current = removePages(current, pages);
    current.push(groupFromPages(texts, pages, start.id));
  }
  current.sort((a, b) => a.pages[0] - b.pages[0]);
  return current;
}

/**
 * @param {Array<object>} groups Bill groups.
 * @param {Array<object>} coverBills Cover rows.
 * @return {Array<object>}
 */
function applyCoverDetails(groups, coverBills) {
  return groups.map((g) => {
    const bill = coverBills.find((row) => sameBill(row, g));
    if (!bill) return g;
    const next = Object.assign({}, g);
    fillIdentity(next, bill);
    return next;
  });
}

/**
 * @param {Array<string>} texts Normalized texts.
 * @param {Array<object>} groups Bill groups.
 * @return {Array<object>}
 */
function findUnclaimedBills(texts, groups) {
  const owned = new Set();
  groups.forEach((g) => g.pages.forEach((p) => owned.add(p)));
  const out = [];
  const seen = new Set();
  const push = (bill) => {
    const key = normRef(bill.invoiceNumber) || normRef(bill.proNumber) ||
      normRef(bill.loadNumber) ||
      (bill.page ? `page:${bill.page}` : "");
    if (!key || seen.has(key)) return;
    if (groups.some((g) => sameBill(g, bill))) return;
    seen.add(key);
    out.push(bill);
  };
  texts.forEach((text, i) => {
    const pageNo = i + 1;
    if (isStatementCoverPage(text)) return;
    if (isLooseFreightInvoicePage(text)) {
      push(Object.assign({page: pageNo}, extractBillIdentity(text)));
      return;
    }
    if (owned.has(pageNo)) {
      const group = groups.find((g) => g.pages.indexOf(pageNo) >= 0);
      collectPageBillRefs(text).forEach((ref) => {
        const bill = {
          page: pageNo,
          invoiceNumber: ref,
          proNumber: ref,
          loadNumber: "",
          amount: null,
        };
        if (group && sameBill(group, bill)) return;
        push(bill);
      });
      if (looksLikeSkippedCarrierPage(text)) {
        push({
          page: pageNo,
          invoiceNumber: "",
          proNumber: "",
          loadNumber: "",
          amount: null,
        });
      }
      return;
    }
    collectPageBillRefs(text).forEach((ref) => {
      push({
        page: pageNo,
        invoiceNumber: ref,
        proNumber: "",
        loadNumber: "",
        amount: null,
      });
    });
    if (looksLikeSkippedCarrierPage(text)) {
      push({
        page: pageNo,
        invoiceNumber: "",
        proNumber: "",
        loadNumber: "",
        amount: null,
      });
    }
  });
  return out;
}

/**
 * @param {object} group Bill group.
 * @return {object}
 */
function groupBill(group) {
  return {
    invoiceNumber: group.invoiceNumber || "",
    proNumber: group.proNumber || "",
    loadNumber: group.loadNumber || "",
    amount: group.amount || null,
  };
}

/**
 * @param {Array<string>} texts Normalized texts.
 * @param {Array<object>} groups Bill groups.
 * @param {Array<object>} coverBills Cover rows.
 * @return {object}
 */
function buildSplitGap(texts, groups, coverBills) {
  const missingBills = coverBills.filter((bill) =>
    !groups.some((g) => sameBill(g, bill)));
  const unclaimedBills = findUnclaimedBills(texts, groups);
  const extractedCount = groups.length;
  const expectedCount = coverBills.length > 0 ?
    coverBills.length :
    extractedCount + unclaimedBills.length;
  const loadsOf = (rows) => rows
      .map((row) => String(row.loadNumber || "").trim())
      .filter(Boolean);
  return {
    underExtracted: missingBills.length > 0 || unclaimedBills.length > 0,
    expectedCount,
    extractedCount,
    coverCount: coverBills.length,
    indexLoads: loadsOf(coverBills.length ? coverBills : groups).sort(),
    missingLoads: loadsOf(missingBills).sort(),
    missingBills,
    unclaimedBills,
    foundBills: groups.map(groupBill),
    pageCount: texts.length,
  };
}

/**
 * @param {object} group Bill group.
 * @param {string} filename Source PDF name.
 * @return {object}
 */
function podForGroup(group, filename) {
  const documents = [];
  group.pages.forEach((pageNo) => {
    const role = group.pageRoles[pageNo];
    if (role !== "bol" && role !== "pod") return;
    documents.push({
      source: role === "bol" ? "signed_bol" : "delivery_receipt",
      page: pageNo,
      attachmentFilename: filename || "",
      reason: role === "bol" ?
        "BOL page with this bill" : "Delivery page with this bill",
    });
  });
  return {
    found: documents.length > 0,
    documents,
    source: documents.length ? documents[0].source : "",
    attachmentFilename: filename || "",
    page: documents.length ? documents[0].page : null,
  };
}

/**
 * @param {Array<object>} groups Bill groups.
 * @param {string} filename Source PDF name.
 * @return {Array<object>}
 */
function groupsToItems(groups, filename) {
  return groups.map((g) => ({
    status: "ready_for_primus_validation",
    invoiceNumber: g.invoiceNumber || "",
    loadNumber: g.loadNumber || "",
    proNumber: g.proNumber || "",
    invoiceAmount: g.amount || 0,
    attachmentFilename: filename || "",
    invoicePages: g.pages.slice(),
    charges: [],
    recognizedCharges: [],
    unrecognizedCharges: [],
    chargesNeedProof: [],
    chargeProofRefs: [],
    pod: podForGroup(g, filename),
    multiBillSplit: true,
  }));
}

/**
 * @param {Array<string>} pageTexts Page texts, index 0 = page 1.
 * @return {object} items, groups, coverBills, firstPassCount, gap.
 */
function splitMultiBillPacket(pageTexts) {
  const texts = (Array.isArray(pageTexts) ? pageTexts : []).map(normalizeOcr);
  const coverBills = [];
  texts.forEach((text) => {
    parseStatementCoverBills(text).forEach((bill) => {
      if (!coverBills.some((row) => sameBill(row, bill))) {
        coverBills.push(bill);
      }
    });
  });
  const firstPass = firstPassInvoiceGroups(texts);
  const groups = applyCoverDetails(
      secondPassInvoiceGroups(texts, firstPass), coverBills);
  return {
    items: groupsToItems(groups, ""),
    groups,
    coverBills,
    firstPassCount: firstPass.length,
    gap: buildSplitGap(texts, groups, coverBills),
  };
}

/**
 * @param {object} gap Split gap.
 * @param {Array<object>} items Invoice items after merging.
 * @return {object}
 */
function reconcileGap(gap, items) {
  const rows = Array.isArray(items) ? items : [];
  const missingBills = (gap.missingBills || []).filter((bill) =>
    !rows.some((item) => sameBill(item, bill)));
  const unclaimedBills = (gap.unclaimedBills || []).filter((bill) =>
    !rows.some((item) => sameBill(item, bill)));
  const extractedCount = rows.length;
  const expectedCount = gap.coverCount > 0 ?
    gap.coverCount :
    extractedCount + unclaimedBills.length;
  const loadsOf = (list) => list
      .map((row) => String(row.loadNumber || "").trim())
      .filter(Boolean);
  return Object.assign({}, gap, {
    underExtracted: missingBills.length > 0 || unclaimedBills.length > 0,
    expectedCount,
    extractedCount,
    missingBills,
    unclaimedBills,
    missingLoads: loadsOf(missingBills).sort(),
    foundBills: rows.map((item) => ({
      invoiceNumber: item.invoiceNumber || "",
      proNumber: item.proNumber || "",
      loadNumber: item.loadNumber || "",
      amount: item.invoiceAmount || null,
    })),
  });
}

/**
 * Keeps a classifier item's charges when it is the same bill, and keeps
 * any classifier bill the page split did not see.
 * @param {object} split splitMultiBillPacket result.
 * @param {Array<object>} classifierItems Items already extracted.
 * @param {string} filename Source PDF name.
 * @return {Array<object>}
 */
function unionWithClassifier(split, classifierItems, filename) {
  const prior = Array.isArray(classifierItems) ? classifierItems : [];
  const items = split.items.map((item) => {
    const match = prior.find((old) => old && sameBill(old, item));
    const named = Object.assign({}, item, {attachmentFilename: filename});
    if (!match) return named;
    return Object.assign({}, match, {
      invoiceNumber: named.invoiceNumber || match.invoiceNumber,
      loadNumber: named.loadNumber || match.loadNumber,
      proNumber: named.proNumber || match.proNumber,
      invoiceAmount: named.invoiceAmount || match.invoiceAmount,
      invoicePages: named.invoicePages,
      attachmentFilename: filename,
      pod: named.pod && named.pod.found ? named.pod : (match.pod || named.pod),
      multiBillSplit: true,
    });
  });
  prior.forEach((old) => {
    if (!old || items.some((item) => sameBill(item, old))) return;
    items.push(old);
  });
  return items;
}

/**
 * Maps a slice-relative POD back onto the original PDF's page numbers.
 * @param {object|null} pod Classifier POD.
 * @param {number[]} originalPages 1-based pages of the slice.
 * @return {object|null}
 */
function remapSlicePod(pod, originalPages) {
  if (!pod || typeof pod !== "object") return null;
  const mapPage = (p) => {
    const n = Math.trunc(Number(p));
    if (!Number.isFinite(n) || n < 1 || n > originalPages.length) return null;
    return originalPages[n - 1];
  };
  const documents = [];
  const docs = Array.isArray(pod.documents) ? pod.documents : [];
  docs.forEach((doc) => {
    if (!doc) return;
    const page = mapPage(doc.page);
    if (!page) return;
    documents.push(Object.assign({}, doc, {page}));
  });
  const page = mapPage(pod.page);
  return Object.assign({}, pod, {
    page: page || (documents[0] && documents[0].page) || null,
    documents,
  });
}

/**
 * @param {string} ocrVal Value read from the page split.
 * @param {string} classifiedVal Value from the slice classifier.
 * @return {string}
 */
function preferId(ocrVal, classifiedVal) {
  const ocr = String(ocrVal || "").trim();
  if (ocr) return ocr;
  return String(classifiedVal || "").trim();
}

/**
 * Page identity stays with the split. Charges and dates come from the
 * normal classifier so amount and extra-charge rules still run.
 * @param {object} item Split invoice item.
 * @param {object} classified One classified bill.
 * @return {object}
 */
function mergeClassifiedSlice(item, classified) {
  const pages = item.invoicePages || [];
  const pod = remapSlicePod(classified.pod, pages);
  const amount = Number(item.invoiceAmount) > 0 ?
    item.invoiceAmount : classified.invoiceAmount;
  return Object.assign({}, item, {
    invoiceNumber: preferId(item.invoiceNumber, classified.invoiceNumber),
    loadNumber: preferId(item.loadNumber, classified.loadNumber),
    proNumber: preferId(item.proNumber, classified.proNumber),
    invoiceAmount: amount || 0,
    invoiceDate: classified.invoiceDate || item.invoiceDate || "",
    dueDate: classified.dueDate || item.dueDate || "",
    carrierName: classified.carrierName || item.carrierName || "",
    charges: classified.charges || item.charges || [],
    recognizedCharges: classified.recognizedCharges ||
      item.recognizedCharges || [],
    unrecognizedCharges: classified.unrecognizedCharges ||
      item.unrecognizedCharges || [],
    chargesNeedProof: classified.chargesNeedProof ||
      item.chargesNeedProof || [],
    chargeProofRefs: classified.chargeProofRefs ||
      item.chargeProofRefs || [],
    freightDetails: classified.freightDetails || item.freightDetails,
    hasWeightInspectionCertificate:
      classified.hasWeightInspectionCertificate ||
      item.hasWeightInspectionCertificate || false,
    pod: pod && (pod.found || (pod.documents && pod.documents.length)) ?
      pod : item.pod,
    invoicePages: pages,
    multiBillSplit: true,
  });
}

/**
 * Classifies each split bill on its own pages. A failure keeps the bill.
 * @param {Array<object>} items Split items.
 * @param {Buffer} pdfBuffer Source PDF.
 * @param {function(Buffer): Promise<object|null>} classifySlice Classifier.
 * @return {Promise<{items: Array<object>, warnings: string[]}>}
 */
async function enrichSplitItems(items, pdfBuffer, classifySlice) {
  if (typeof classifySlice !== "function") {
    return {items, warnings: []};
  }
  const out = [];
  const warnings = [];
  for (const item of items) {
    if (!item || !item.multiBillSplit) {
      out.push(item);
      continue;
    }
    let sliced = null;
    try {
      sliced = await podUtils.slicePdfByPages(
          pdfBuffer, item.invoicePages || []);
    } catch (err) {
      warnings.push(err.message || String(err));
    }
    if (!sliced) {
      out.push(item);
      continue;
    }
    try {
      const classified = await classifySlice(sliced);
      if (!classified || typeof classified !== "object") {
        out.push(item);
        continue;
      }
      out.push(mergeClassifiedSlice(item, classified));
    } catch (err) {
      warnings.push(err.message || String(err));
      out.push(item);
    }
  }
  return {items: out, warnings};
}

/**
 * Splits a single multi-bill PDF. Emails that already have one invoice
 * file per bill are left alone.
 * @param {object} opts pdfAttachments, invoiceItems, readPageTexts,
 *   classifySlice.
 * @return {Promise<object>} invoiceItems, gap, applied, warnings.
 */
async function splitSinglePdfInvoiceItems(opts) {
  const input = opts || {};
  const invoiceItems = Array.isArray(input.invoiceItems) ?
    input.invoiceItems : [];
  const pdfs = podUtils.listInvoicePdfAttachments(input.pdfAttachments)
      .filter((att) => att && att.buffer);
  const untouched = {
    invoiceItems,
    gap: null,
    applied: false,
    warnings: [],
  };
  if (pdfs.length !== 1) return untouched;
  const pdf = pdfs[0];
  let pageCount = 0;
  try {
    const src = await PDFDocument.load(pdf.buffer, {ignoreEncryption: true});
    pageCount = src.getPageCount();
  } catch (_) {
    return untouched;
  }
  if (pageCount < 2) return untouched;
  const readPageTexts = input.readPageTexts ||
    require("./scanned-pdf-ocr").readPdfPageTexts;
  let pageTexts = null;
  try {
    pageTexts = await readPageTexts(pdf.buffer);
  } catch (err) {
    return {
      invoiceItems,
      gap: null,
      applied: false,
      warnings: [err.message || String(err)],
    };
  }
  if (!pageTexts || !pageTexts.some((text) => String(text || "").trim())) {
    return untouched;
  }
  const split = splitMultiBillPacket(pageTexts);
  const multi = split.groups.length >= 2 || split.gap.underExtracted;
  if (!multi) return untouched;
  let items = unionWithClassifier(split, invoiceItems, pdf.filename || "");
  const enriched = await enrichSplitItems(
      items, pdf.buffer, input.classifySlice);
  items = enriched.items;
  const gap = reconcileGap(split.gap, items);
  return {
    invoiceItems: items,
    gap: gap.underExtracted ? gap : null,
    applied: true,
    warnings: enriched.warnings,
    firstPassCount: split.firstPassCount,
  };
}

module.exports = {
  normRef,
  sameBill,
  supportKind,
  pageHasBillSignal,
  hasInvoiceTitle,
  isStatementCoverPage,
  parseStatementCoverBills,
  isStrictFreightInvoicePage,
  isLooseFreightInvoicePage,
  extractBillIdentity,
  firstPassInvoiceGroups,
  splitMultiBillPacket,
  splitSinglePdfInvoiceItems,
};
