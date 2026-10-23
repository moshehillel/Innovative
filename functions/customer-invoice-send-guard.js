"use strict";

const admin = require("firebase-admin");

const COLLECTION = "customerInvoiceEmailSends";
const SKIP_REASON = "customer_invoice_unchanged";
const SENDING_WINDOW_MS = 10 * 60 * 1000;

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
 * @param {object} prior Earlier send snapshot.
 * @param {object} current Invoice about to be emailed.
 * @return {boolean}
 */
function sameIssuedInvoice(prior, current) {
  if (!prior || !current) return false;
  if (String(prior.customerInvoiceId || "") !==
      String(current.customerInvoiceId || "")) {
    return false;
  }
  const a = normalizeInvoiceNumber(prior.invoiceNumber);
  const b = normalizeInvoiceNumber(current.invoiceNumber);
  if (a && b && a !== b) return false;
  return !!current.customerInvoiceId;
}

/**
 * @param {object} prior Earlier send snapshot.
 * @param {object} current Invoice about to be emailed.
 * @return {boolean}
 */
function sameCustomerFacingInvoice(prior, current) {
  if (!sameIssuedInvoice(prior, current)) return false;
  if (prior.totalCents == null || current.totalCents == null) return false;
  if (Number(prior.totalCents) !== Number(current.totalCents)) return false;
  return String(prior.linesKey || "") === String(current.linesKey || "");
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
  if (current.invoiceUnchanged) {
    const prior = list.find((row) => sameIssuedInvoice(row, current));
    if (prior) {
      return {skip: true, reason: SKIP_REASON, prior};
    }
    return {skip: false, reason: null, prior: null};
  }
  const prior = list.find((row) =>
    sameCustomerFacingInvoice(row, current));
  if (prior) {
    return {skip: true, reason: SKIP_REASON, prior};
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
 * @param {string} id Firestore invoice id.
 * @param {object} data Invoice document.
 * @return {object|null}
 */
function snapshotFromCompletedInvoice(id, data) {
  if (!data || data.finalWorkflowStatus !== "completed") return null;
  if (!data.customerInvoiceId) return null;
  const stored = data.customerInvoiceEmail || null;
  if (stored && stored.totalCents != null && stored.sent === true) {
    return {
      customerInvoiceId: String(stored.customerInvoiceId ||
        data.customerInvoiceId),
      invoiceNumber: normalizeInvoiceNumber(stored.invoiceNumber ||
        data.issuedInvoiceNumber),
      totalCents: Number(stored.totalCents),
      linesKey: stored.linesKey || "",
      sourceInvoiceId: id,
    };
  }
  const lines = data.additionalCharge &&
    Array.isArray(data.additionalCharge.customerBillLines) ?
    data.additionalCharge.customerBillLines : [];
  const rate = Number(data.customerRate || 0);
  return {
    customerInvoiceId: String(data.customerInvoiceId),
    invoiceNumber: normalizeInvoiceNumber(data.issuedInvoiceNumber),
    totalCents: accessorialCents(rate, lines),
    linesKey: customerInvoiceLinesKey(rate, lines),
    sourceInvoiceId: id,
  };
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
 * Decides whether emailBOLDocs may send this customer invoice.
 * A reused issued invoice that was already emailed is skipped.
 * A new or changed customer total/lines may send once.
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
    loadNumber: args.loadNumber || null,
    sourceInvoiceId: args.firestoreInvoiceId || null,
    to: args.to || null,
  };
  if (!current.customerInvoiceId) {
    return {skip: false, reason: null, claim: null};
  }

  const unchangedPriors = [];
  const contentPriors = [];
  const invoices = await loadInvoicesForLoad(db, args.loadNumber);
  for (const row of invoices) {
    const data = row.data || {};
    if (String(data.customerInvoiceId || "") !==
        current.customerInvoiceId) {
      continue;
    }
    const completed = data.finalWorkflowStatus === "completed";
    const emailed = completed ||
      await invoiceEmailSucceeded(db, row.id);
    if (!emailed) continue;
    unchangedPriors.push({
      customerInvoiceId: String(data.customerInvoiceId),
      invoiceNumber: normalizeInvoiceNumber(data.issuedInvoiceNumber),
      totalCents: null,
      linesKey: "",
      sourceInvoiceId: row.id,
    });
    if (row.id === current.sourceInvoiceId) continue;
    const snap = snapshotFromCompletedInvoice(row.id, data);
    if (snap) contentPriors.push(snap);
  }

  const ref = db.collection(COLLECTION).doc(current.customerInvoiceId);
  const existing = await ref.get();
  const sendData = existing.exists ? (existing.data() || {}) : null;
  if (sendData && sendData.status === "sent") {
    const sentSnap = snapshotFromSendDoc(sendData);
    unchangedPriors.push(sentSnap);
    contentPriors.push(sentSnap);
  } else if (sendData && current.invoiceUnchanged &&
      isFreshSending(sendData.claimedAt, Date.now())) {
    unchangedPriors.push(snapshotFromSendDoc(sendData));
  }

  const decision = decideCustomerInvoiceSend(
      current,
      current.invoiceUnchanged ? unchangedPriors : contentPriors);
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
        (current.invoiceUnchanged &&
          isFreshSending(data.claimedAt, Date.now())))) {
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
  moneyCents,
  normalizeInvoiceNumber,
  customerInvoiceLinesKey,
  decideCustomerInvoiceSend,
  snapshotFromCompletedInvoice,
  evaluateCustomerInvoiceResend,
  finishCustomerInvoiceSend,
};
