"use strict";

const admin = require("firebase-admin");
const {BigQuery} = require("@google-cloud/bigquery");

const COLLECTION = "customerInvoiceEmailSends";
const SKIP_REASON = "customer_invoice_unchanged";
const ALREADY_ISSUED_REASON = "customer_invoice_already_issued";
const SENDING_WINDOW_MS = 10 * 60 * 1000;
const EMAIL_LOG_MESSAGE =
  "Customer documents emailed via Primus emailBOLDocs";

// Tests inject BigQuery rows. Production reads the log table.
let injectedEmailLogs = null;

/**
 * @param {*} value Money amount.
 * @return {number|null} Cents, or null when not a number.
 */
function moneyCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/**
 * @param {*} value Invoice number from Primus or Firestore.
 * @return {string} Blank when missing or the unissued placeholder.
 */
function normalizeInvoiceNumber(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text || text === "0") return "";
  return text;
}

/**
 * Stable key for the customer-facing freight and accessorial lines.
 * @param {*} customerRate Freight sell rate.
 * @param {Array<object>} billLines Accessorial lines.
 * @return {string}
 */
function customerInvoiceLinesKey(customerRate, billLines) {
  const freight = moneyCents(customerRate);
  const parts = ["freight:" + (freight == null ? "" : String(freight))];
  (Array.isArray(billLines) ? billLines : []).forEach((line) => {
    const amount = moneyCents(line && line.amount);
    if (amount == null || amount <= 0) return;
    const name = String((line && (line.name || line.label)) || "")
        .trim()
        .toUpperCase();
    const code = line && line.code ? String(line.code) : "";
    parts.push(name + ":" + amount + ":" + code);
  });
  parts.sort();
  return parts.join("|");
}

/**
 * Same issued customer invoice: Primus id, or the printed invoice number.
 * @param {object} prior Earlier send snapshot.
 * @param {object} current Invoice about to be emailed.
 * @return {boolean}
 */
function sameIssuedInvoice(prior, current) {
  if (!prior || !current) return false;
  const idA = String(prior.customerInvoiceId || "");
  const idB = String(current.customerInvoiceId || "");
  const numA = normalizeInvoiceNumber(prior.invoiceNumber);
  const numB = normalizeInvoiceNumber(current.invoiceNumber);
  if (idA && idB && idA === idB) {
    if (numA && numB && numA !== numB) return false;
    return true;
  }
  return !!(numA && numB && numA === numB);
}

/**
 * @param {string} linesKey Line key from customerInvoiceLinesKey.
 * @return {boolean}
 */
function hasAccessorialLines(linesKey) {
  return String(linesKey || "").split("|").some((part) =>
    part && part.indexOf("freight:") !== 0);
}

/**
 * @param {object} prior Earlier emailed snapshot.
 * @param {object} current Invoice about to be emailed.
 * @return {boolean} True when the customer total or lines changed.
 */
function totalsDiffer(prior, current) {
  if (!prior || !current) return false;
  if (prior.totalCents == null || current.totalCents == null) {
    return false;
  }
  if (Number(prior.totalCents) !== Number(current.totalCents)) {
    return true;
  }
  const a = String(prior.linesKey || "");
  const b = String(current.linesKey || "");
  return !!(a && b && a !== b);
}

/**
 * True when this pass is an invoice that was already on the load.
 * A changed customer total is the one case that may still be emailed.
 * @param {object} current Snapshot of the invoice about to send.
 * @return {boolean}
 */
function alreadyIssuedUnchanged(current) {
  if (!current || current.customerTotalChanged === true) return false;
  return current.alreadyIssued === true;
}

/**
 * @param {object} current Snapshot of the invoice about to send.
 * @param {Array<object>} priors Earlier successful sends.
 * @return {object} skip, reason, and the matching prior send.
 */
function decideCustomerInvoiceSend(current, priors) {
  const list = Array.isArray(priors) ? priors : [];
  if (!current || !current.customerInvoiceId) {
    return {skip: false, reason: null, prior: null};
  }
  const prior = list.find((row) => sameIssuedInvoice(row, current));
  if (prior) {
    if (totalsDiffer(prior, current)) {
      return {skip: false, reason: null, prior: null};
    }
    // Unknown prior total plus new accessorials can still be sent once.
    if (!current.invoiceUnchanged &&
        prior.totalCents == null &&
        hasAccessorialLines(current.linesKey)) {
      return {skip: false, reason: null, prior: null};
    }
    return {skip: true, reason: SKIP_REASON, prior};
  }
  // No Jerry send log. An invoice already on the load still must not
  // be emailed again just because a statement listed that load.
  if (alreadyIssuedUnchanged(current)) {
    return {skip: true, reason: ALREADY_ISSUED_REASON, prior: null};
  }
  return {skip: false, reason: null, prior: null};
}

/**
 * @param {number} customerRate Freight rate.
 * @param {Array<object>} billLines Accessorial lines.
 * @return {number}
 */
function accessorialCents(customerRate, billLines) {
  const freight = moneyCents(customerRate) || 0;
  let extra = 0;
  (Array.isArray(billLines) ? billLines : []).forEach((line) => {
    const amount = moneyCents(line && line.amount);
    if (amount != null && amount > 0) extra += amount;
  });
  return freight + extra;
}

/**
 * Snapshot of an issued invoice. Does not read a sent flag.
 * @param {string} id Firestore invoice id.
 * @param {object} data Invoice document.
 * @return {object|null}
 */
function snapshotFromInvoice(id, data) {
  if (!data) return null;
  const customerInvoiceId = String(data.customerInvoiceId || "");
  const invoiceNumber = normalizeInvoiceNumber(data.issuedInvoiceNumber);
  if (!customerInvoiceId && !invoiceNumber) return null;
  const stored = data.customerInvoiceEmail || null;
  if (stored && stored.totalCents != null) {
    return {
      customerInvoiceId: String(stored.customerInvoiceId ||
        customerInvoiceId),
      invoiceNumber: normalizeInvoiceNumber(stored.invoiceNumber ||
        invoiceNumber),
      totalCents: Number(stored.totalCents),
      linesKey: stored.linesKey || "",
      sourceInvoiceId: id,
      evidence: "workflow",
    };
  }
  const lines = data.additionalCharge &&
    Array.isArray(data.additionalCharge.customerBillLines) ?
    data.additionalCharge.customerBillLines : [];
  const rate = Number(data.customerRate || 0);
  const knownRate = Number.isFinite(rate) && rate > 0;
  return {
    customerInvoiceId,
    invoiceNumber,
    totalCents: knownRate ? accessorialCents(rate, lines) : null,
    linesKey: knownRate ? customerInvoiceLinesKey(rate, lines) : "",
    sourceInvoiceId: id,
    evidence: "workflow",
  };
}

/**
 * @param {string} id Firestore invoice id.
 * @param {object} data Invoice document.
 * @return {object|null}
 */
function snapshotFromCompletedInvoice(id, data) {
  if (!data || data.finalWorkflowStatus !== "completed") return null;
  return snapshotFromInvoice(id, data);
}

/**
 * True when this workflow already emailed the customer documents.
 * customerInvoiceStatus and Primus status.sent are ignored.
 * @param {object} data Invoice document.
 * @param {boolean} emailStep final_email_sent success exists.
 * @return {boolean}
 */
function workflowEmailedCustomerInvoice(data, emailStep) {
  if (emailStep) return true;
  if (!data || data.finalWorkflowStatus !== "completed") return false;
  return !!(data.customerInvoiceId || data.issuedInvoiceNumber);
}

/**
 * @param {*} claimedAt Firestore timestamp or Date.
 * @param {number} nowMs Clock.
 * @return {boolean}
 */
function isFreshSending(claimedAt, nowMs) {
  let ms = 0;
  if (claimedAt && typeof claimedAt.toDate === "function") {
    ms = claimedAt.toDate().getTime();
  } else if (claimedAt instanceof Date) {
    ms = claimedAt.getTime();
  }
  if (!ms) return false;
  return (nowMs - ms) < SENDING_WINDOW_MS;
}

/**
 * @param {object} data customerInvoiceEmailSends document.
 * @return {object}
 */
function snapshotFromSendDoc(data) {
  return {
    customerInvoiceId: String(data.customerInvoiceId || ""),
    invoiceNumber: normalizeInvoiceNumber(data.invoiceNumber),
    totalCents: data.totalCents == null ? null : Number(data.totalCents),
    linesKey: data.linesKey || "",
    sourceInvoiceId: data.sourceInvoiceId || null,
  };
}

/**
 * @param {FirebaseFirestore.Firestore} db Firestore.
 * @param {string} invoiceId Firestore invoice id.
 * @return {Promise<boolean>}
 */
async function invoiceEmailSucceeded(db, invoiceId) {
  if (!invoiceId) return false;
  const snap = await db.collection("workflowLogs")
      .where("invoiceId", "==", invoiceId)
      .limit(80)
      .get();
  let found = false;
  snap.forEach((doc) => {
    const row = doc.data() || {};
    if (row.stepName === "final_email_sent" &&
        row.stepStatus === "success") {
      found = true;
    }
  });
  return found;
}

/**
 * @param {FirebaseFirestore.Firestore} db Firestore.
 * @param {string} loadNumber Load or BOL number.
 * @return {Promise<Array<object>>}
 */
async function loadInvoicesForLoad(db, loadNumber) {
  const text = String(loadNumber || "").trim();
  if (!text) return [];
  const values = [text];
  if (/^\d+$/.test(text)) values.push(Number(text));
  const seen = new Set();
  const docs = [];
  for (const value of values) {
    const snap = await db.collection("invoices")
        .where("loadNumber", "==", value)
        .limit(25)
        .get();
    snap.forEach((doc) => {
      if (seen.has(doc.id)) return;
      seen.add(doc.id);
      docs.push({id: doc.id, data: doc.data() || {}});
    });
  }
  return docs;
}

/**
 * @param {FirebaseFirestore.Firestore} db Firestore.
 * @param {object} current Snapshot to store.
 * @param {string} status sent, sending, or failed.
 * @return {Promise<void>}
 */
async function writeSendDoc(db, current, status) {
  await db.collection(COLLECTION)
      .doc(String(current.customerInvoiceId))
      .set({
        status,
        customerInvoiceId: String(current.customerInvoiceId),
        invoiceNumber: normalizeInvoiceNumber(current.invoiceNumber),
        totalCents: current.totalCents,
        linesKey: current.linesKey || "",
        loadNumber: current.loadNumber || null,
        sourceInvoiceId: current.sourceInvoiceId || null,
        to: current.to || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
}

/**
 * @param {object|null} rows Injected emailBOLDocs log rows for tests.
 * @return {void}
 */
function _setEmailLogRows(rows) {
  injectedEmailLogs = rows;
}

/**
 * @param {object} row BigQuery or injected log row.
 * @return {object|null}
 */
function priorFromEmailLog(row) {
  if (!row) return null;
  let details = row.details;
  if (typeof details === "string") {
    try {
      details = JSON.parse(details);
    } catch (err) {
      details = {};
    }
  }
  details = details || {};
  const customerInvoiceId = String(details.customerInvoiceId || "");
  const invoiceNumber = normalizeInvoiceNumber(details.invoiceNumber);
  if (!customerInvoiceId && !invoiceNumber) return null;
  return {
    customerInvoiceId,
    invoiceNumber,
    totalCents: null,
    linesKey: "",
    sourceInvoiceId: row.invoiceId || details.invoiceId || null,
    evidence: "emailBOLDocs",
  };
}

/**
 * @return {boolean}
 */
function cloudLogsAvailable() {
  return !!(process.env.K_SERVICE || process.env.FUNCTION_TARGET ||
    process.env.FUNCTION_NAME);
}

/**
 * emailBOLDocs success from the workflow log table.
 * @param {object} args Send context.
 * @return {Promise<Array<object>>}
 */
async function queryEmailBolDocsSends(args) {
  const dataset = process.env.BQ_DATASET || "invoice_automation";
  const load = String(args.loadNumber || "");
  const invId = String(args.customerInvoiceId || "");
  const invNum = normalizeInvoiceNumber(args.invoiceNumber);
  if (!invId && !invNum && !load) return [];
  const bq = new BigQuery();
  const sql = [
    "SELECT invoiceId, details",
    "FROM `" + dataset + ".logs`",
    "WHERE message = @message",
    "AND timestamp >= TIMESTAMP_SUB(",
    "  CURRENT_TIMESTAMP(), INTERVAL 400 DAY)",
    "AND (",
    "  (@invId != '' AND STRPOS(IFNULL(details, ''), @invId) > 0)",
    "  OR (@invNum != '' AND",
    "    STRPOS(IFNULL(details, ''), @invNum) > 0)",
    "  OR (@load != '' AND STRPOS(IFNULL(details, ''), @load) > 0)",
    ")",
    "LIMIT 20",
  ].join("\n");
  const [rows] = await bq.query({
    query: sql,
    params: {
      message: EMAIL_LOG_MESSAGE,
      invId,
      invNum,
      load,
    },
  });
  const current = {
    customerInvoiceId: invId,
    invoiceNumber: invNum,
  };
  const priors = [];
  (rows || []).forEach((row) => {
    const prior = priorFromEmailLog(row);
    if (prior && sameIssuedInvoice(prior, current)) priors.push(prior);
  });
  return priors;
}

/**
 * @param {object} args Send context.
 * @return {Promise<Array<object>>}
 */
async function findEmailBolDocsSends(args) {
  if (Array.isArray(injectedEmailLogs)) {
    const current = {
      customerInvoiceId: String(args.customerInvoiceId || ""),
      invoiceNumber: normalizeInvoiceNumber(args.invoiceNumber),
    };
    return injectedEmailLogs.map(priorFromEmailLog).filter((prior) =>
      prior && sameIssuedInvoice(prior, current));
  }
  if (!cloudLogsAvailable()) return [];
  try {
    return await queryEmailBolDocsSends(args);
  } catch (err) {
    return [];
  }
}

/**
 * @param {object} mail outboundEmails document.
 * @return {boolean}
 */
function isCustomerInvoiceOutbound(mail) {
  if (!mail) return false;
  const type = String(mail.type || "");
  if (type === "generated_bill") return true;
  return /invoice for bol#/i.test(String(mail.subject || ""));
}

/**
 * @param {FirebaseFirestore.Firestore} db Firestore.
 * @param {object} args Send context.
 * @param {Array<object>} invoices Load invoices.
 * @return {Promise<Array<object>>}
 */
async function outboundCustomerInvoicePriors(db, args, invoices) {
  const found = [];
  const seen = new Set();
  const loads = [];
  const load = String(args.loadNumber || "").trim();
  if (load) {
    loads.push(load);
    if (/^\d+$/.test(load)) loads.push(Number(load));
  }
  const queries = loads.map((value) => ({
    field: "loadNumber",
    value,
  }));
  invoices.forEach((row) => {
    queries.push({field: "invoiceId", value: row.id});
  });
  for (const query of queries) {
    let snap;
    try {
      snap = await db.collection("outboundEmails")
          .where(query.field, "==", query.value)
          .limit(20)
          .get();
    } catch (err) {
      continue;
    }
    snap.forEach((doc) => {
      if (seen.has(doc.id)) return;
      seen.add(doc.id);
      const mail = doc.data() || {};
      if (!isCustomerInvoiceOutbound(mail)) return;
      const linked = invoices.find((row) => row.id === mail.invoiceId);
      const data = linked ? (linked.data || {}) : {};
      const customerInvoiceId = String(
          mail.customerInvoiceId || data.customerInvoiceId ||
          args.customerInvoiceId || "");
      const invoiceNumber = normalizeInvoiceNumber(
          mail.invoiceNumber || data.issuedInvoiceNumber ||
          args.invoiceNumber);
      if (!customerInvoiceId && !invoiceNumber) return;
      found.push({
        customerInvoiceId,
        invoiceNumber,
        totalCents: mail.totalCents == null ? null : Number(mail.totalCents),
        linesKey: mail.linesKey || "",
        sourceInvoiceId: mail.invoiceId || (linked && linked.id) || null,
        evidence: "outbound",
      });
    });
  }
  return found;
}

/**
 * Decides whether emailBOLDocs may send this customer invoice.
 * Already emailed means the emailBOLDocs success log, a saved customer
 * invoice email, or a workflow that already finished that email.
 * An invoice already issued on the load is not emailed again even when
 * none of those records exist. customerInvoiceStatus and Primus
 * status.sent are not read. A new invoice may send once. A changed
 * customer total may send once.
 * @param {FirebaseFirestore.Firestore} db Firestore.
 * @param {object} args Send context.
 * @return {Promise<object>}
 */
async function evaluateCustomerInvoiceResend(db, args) {
  const lines = Array.isArray(args.customerBillLines) ?
    args.customerBillLines : [];
  const rate = Number(args.customerRate != null ?
    args.customerRate : args.invoiceTotal);
  const current = {
    customerInvoiceId: String(args.customerInvoiceId || ""),
    invoiceNumber: normalizeInvoiceNumber(args.invoiceNumber),
    totalCents: args.invoiceTotal != null ?
      moneyCents(args.invoiceTotal) : accessorialCents(rate, lines),
    linesKey: customerInvoiceLinesKey(rate, lines),
    invoiceUnchanged: args.invoiceUnchanged === true,
    alreadyIssued: args.alreadyIssued === true ||
      (args.invoiceUnchanged === true && args.issuedNow !== true),
    customerTotalChanged: args.customerTotalChanged === true,
    loadNumber: args.loadNumber || null,
    sourceInvoiceId: args.firestoreInvoiceId || null,
    to: args.to || null,
  };
  if (!current.customerInvoiceId) {
    return {skip: false, reason: null, claim: null};
  }

  const priors = [];
  const invoices = await loadInvoicesForLoad(db, args.loadNumber);
  for (const row of invoices) {
    const data = row.data || {};
    let emailStep = false;
    try {
      emailStep = await invoiceEmailSucceeded(db, row.id);
    } catch (err) {
      emailStep = false;
    }
    if (!workflowEmailedCustomerInvoice(data, emailStep)) continue;
    const snap = snapshotFromInvoice(row.id, data);
    if (snap) priors.push(snap);
  }
  try {
    const mailed = await outboundCustomerInvoicePriors(
        db, args, invoices);
    mailed.forEach((row) => priors.push(row));
  } catch (err) {
    // Missing outbound mail is not proof the invoice was never emailed.
  }
  const logged = await findEmailBolDocsSends(args);
  logged.forEach((row) => priors.push(row));

  const ref = db.collection(COLLECTION).doc(current.customerInvoiceId);
  const existing = await ref.get();
  const sendData = existing.exists ? (existing.data() || {}) : null;
  if (sendData && (sendData.status === "sent" ||
      isFreshSending(sendData.claimedAt, Date.now()))) {
    priors.push(snapshotFromSendDoc(sendData));
  }

  const decision = decideCustomerInvoiceSend(current, priors);
  if (decision.skip) {
    if (!sendData || sendData.status !== "sent") {
      await writeSendDoc(db, {
        ...current,
        sourceInvoiceId: decision.prior &&
          decision.prior.sourceInvoiceId || current.sourceInvoiceId,
      }, "sent");
    }
    return {
      skip: true,
      reason: decision.reason,
      priorInvoiceId: decision.prior &&
        decision.prior.sourceInvoiceId || null,
      claim: null,
    };
  }

  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? (snap.data() || {}) : null;
    if (data && (data.status === "sent" ||
        isFreshSending(data.claimedAt, Date.now()))) {
      const prior = snapshotFromSendDoc(data);
      const again = decideCustomerInvoiceSend(current, [prior]);
      if (again.skip) return {skip: true, prior};
    }
    tx.set(ref, {
      status: "sending",
      customerInvoiceId: current.customerInvoiceId,
      invoiceNumber: current.invoiceNumber,
      totalCents: current.totalCents,
      linesKey: current.linesKey,
      loadNumber: current.loadNumber,
      sourceInvoiceId: current.sourceInvoiceId,
      to: current.to,
      claimedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
    return {skip: false};
  });
  if (claim.skip) {
    return {
      skip: true,
      reason: SKIP_REASON,
      priorInvoiceId: claim.prior && claim.prior.sourceInvoiceId || null,
      claim: null,
    };
  }
  return {skip: false, reason: null, claim: {ref, current}};
}

/**
 * @param {object} claim Claim returned by evaluateCustomerInvoiceResend.
 * @param {string} status sent or failed.
 * @return {Promise<void>}
 */
async function finishCustomerInvoiceSend(claim, status) {
  if (!claim || !claim.ref || !claim.current) return;
  await claim.ref.set({
    status,
    customerInvoiceId: claim.current.customerInvoiceId,
    invoiceNumber: claim.current.invoiceNumber,
    totalCents: claim.current.totalCents,
    linesKey: claim.current.linesKey || "",
    loadNumber: claim.current.loadNumber || null,
    sourceInvoiceId: claim.current.sourceInvoiceId || null,
    to: claim.current.to || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
}

module.exports = {
  SKIP_REASON,
  ALREADY_ISSUED_REASON,
  moneyCents,
  normalizeInvoiceNumber,
  customerInvoiceLinesKey,
  decideCustomerInvoiceSend,
  snapshotFromCompletedInvoice,
  priorFromEmailLog,
  evaluateCustomerInvoiceResend,
  finishCustomerInvoiceSend,
  _setEmailLogRows,
};
