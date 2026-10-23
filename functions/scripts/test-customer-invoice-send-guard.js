/**
 * Customer invoice emails are not sent again when nothing changed.
 * Run: node scripts/test-customer-invoice-send-guard.js
 */
"use strict";

const assert = require("assert");
const guard = require("../customer-invoice-send-guard");

let passed = 0;

/**
 * @param {string} name Test name.
 * @param {Function} fn Assertion.
 */
function check(name, fn) {
  fn();
  passed++;
  console.log("ok", name);
}

const freightOnly = guard.customerInvoiceLinesKey(945, []);
const withLiftgate = guard.customerInvoiceLinesKey(945, [{
  name: "Liftgate",
  amount: 75,
}]);

check("line key ignores accessorial order", () => {
  const a = guard.customerInvoiceLinesKey(100, [
    {name: "Liftgate", amount: 40},
    {name: "Residential", amount: 20},
  ]);
  const b = guard.customerInvoiceLinesKey(100, [
    {name: "Residential", amount: 20},
    {name: "Liftgate", amount: 40},
  ]);
  assert.strictEqual(a, b);
  assert.notStrictEqual(freightOnly, withLiftgate);
});

check("first send is allowed", () => {
  const decision = guard.decideCustomerInvoiceSend({
    customerInvoiceId: "3618447",
    invoiceNumber: "30489",
    totalCents: 94500,
    linesKey: freightOnly,
    invoiceUnchanged: false,
  }, []);
  assert.strictEqual(decision.skip, false);
});

check("unchanged issued invoice already emailed is skipped", () => {
  const decision = guard.decideCustomerInvoiceSend({
    customerInvoiceId: "3618447",
    invoiceNumber: "30489",
    totalCents: 94500,
    linesKey: withLiftgate,
    invoiceUnchanged: true,
  }, [{
    customerInvoiceId: "3618447",
    invoiceNumber: "30489",
    sourceInvoiceId: "kQbNFIXTBJaZVJheHCfH",
  }]);
  assert.strictEqual(decision.skip, true);
  assert.strictEqual(decision.reason, guard.SKIP_REASON);
  assert.strictEqual(
      decision.prior.sourceInvoiceId, "kQbNFIXTBJaZVJheHCfH");
});

check("issued invoice with no prior email is sent", () => {
  const decision = guard.decideCustomerInvoiceSend({
    customerInvoiceId: "3618447",
    invoiceNumber: "30489",
    invoiceUnchanged: true,
  }, []);
  assert.strictEqual(decision.skip, false);
});

check("reissued invoice number is sent", () => {
  const decision = guard.decideCustomerInvoiceSend({
    customerInvoiceId: "3618447",
    invoiceNumber: "30900",
    invoiceUnchanged: true,
  }, [{
    customerInvoiceId: "3618447",
    invoiceNumber: "30489",
  }]);
  assert.strictEqual(decision.skip, false);
});

check("retry of the same total and lines is skipped", () => {
  const current = {
    customerInvoiceId: "3618447",
    invoiceNumber: "30489",
    totalCents: 94500,
    linesKey: freightOnly,
    invoiceUnchanged: false,
  };
  const decision = guard.decideCustomerInvoiceSend(current, [current]);
  assert.strictEqual(decision.skip, true);
  assert.strictEqual(decision.reason, guard.SKIP_REASON);
});

check("new accessorial total is sent once", () => {
  const decision = guard.decideCustomerInvoiceSend({
    customerInvoiceId: "3618447",
    invoiceNumber: "30489",
    totalCents: 102000,
    linesKey: withLiftgate,
    invoiceUnchanged: false,
  }, [{
    customerInvoiceId: "3618447",
    invoiceNumber: "30489",
    totalCents: 94500,
    linesKey: freightOnly,
  }]);
  assert.strictEqual(decision.skip, false);
});

check("placeholder invoice number does not block a match", () => {
  const decision = guard.decideCustomerInvoiceSend({
    customerInvoiceId: "99",
    invoiceNumber: "0",
    invoiceUnchanged: true,
  }, [{
    customerInvoiceId: "99",
    invoiceNumber: "",
  }]);
  assert.strictEqual(decision.skip, true);
});

check("higher total on a reused invoice is sent", () => {
  const decision = guard.decideCustomerInvoiceSend({
    customerInvoiceId: "3618447",
    invoiceNumber: "30489",
    totalCents: 102000,
    linesKey: withLiftgate,
    invoiceUnchanged: true,
  }, [{
    customerInvoiceId: "3618447",
    invoiceNumber: "30489",
    totalCents: 94500,
    linesKey: freightOnly,
  }]);
  assert.strictEqual(decision.skip, false);
});

check("emailBOLDocs log matches invoice 30489", () => {
  const prior = guard.priorFromEmailLog({
    invoiceId: "kQbNFIXTBJaZVJheHCfH",
    details: JSON.stringify({
      customerInvoiceId: 3618447,
      invoiceNumber: "30489",
    }),
  });
  const decision = guard.decideCustomerInvoiceSend({
    customerInvoiceId: "3618447",
    invoiceNumber: "30489",
    totalCents: 94500,
    linesKey: freightOnly,
    invoiceUnchanged: false,
  }, [prior]);
  assert.strictEqual(decision.skip, true);
  assert.strictEqual(decision.reason, guard.SKIP_REASON);
  assert.strictEqual(
      decision.prior.sourceInvoiceId, "kQbNFIXTBJaZVJheHCfH");
});

/**
 * @param {Array<object>} invoices Invoice rows.
 * @param {object|null} sendDoc Existing send record.
 * @param {object} [extras] Workflow logs and outbound mail.
 * @return {object}
 */
function fakeDb(invoices, sendDoc, extras) {
  const logs = (extras && extras.logs) || {};
  const outbound = (extras && extras.outbound) || [];
  const store = {send: sendDoc, sets: []};
  const docRef = {
    get: async () => ({
      exists: !!store.send,
      data: () => store.send,
    }),
    set: async (data) => {
      store.sets.push(data);
      store.send = Object.assign({}, store.send || {}, data);
    },
  };
  return {
    store,
    collection(name) {
      if (name === "invoices") {
        return {
          where(field, op, value) {
            return {
              limit() {
                return {
                  get: async () => ({
                    forEach(fn) {
                      invoices.forEach((row) => {
                        if (row.data.loadNumber === value) {
                          fn({id: row.id, data: () => row.data});
                        }
                      });
                    },
                  }),
                };
              },
            };
          },
        };
      }
      if (name === "workflowLogs") {
        return {
          where(field, op, value) {
            return {
              limit() {
                return {
                  get: async () => ({
                    forEach(fn) {
                      (logs[value] || []).forEach((row) => {
                        fn({id: row.id || "log", data: () => row});
                      });
                    },
                  }),
                };
              },
            };
          },
        };
      }
      if (name === "outboundEmails") {
        return {
          where(field, op, value) {
            return {
              limit() {
                return {
                  get: async () => ({
                    forEach(fn) {
                      outbound.forEach((row) => {
                        if (row[field] === value) {
                          fn({
                            id: row.id || "mail",
                            data: () => row,
                          });
                        }
                      });
                    },
                  }),
                };
              },
            };
          },
        };
      }
      return {doc: () => docRef};
    },
    runTransaction: async (fn) => fn({
      get: async (ref) => ref.get(),
      set: (ref, data) => docRef.set(data),
    }),
  };
}

/**
 * @return {Promise<void>}
 */
async function checkReplay() {
  const db = fakeDb([{
    id: "kQbNFIXTBJaZVJheHCfH",
    data: {
      loadNumber: "267957",
      finalWorkflowStatus: "completed",
      customerInvoiceId: 3618447,
      issuedInvoiceNumber: "30489",
      customerRate: 945,
    },
  }], null);
  const decision = await guard.evaluateCustomerInvoiceResend(db, {
    loadNumber: "267957",
    customerInvoiceId: 3618447,
    invoiceNumber: "30489",
    invoiceTotal: 945,
    customerRate: 945,
    customerBillLines: [],
    invoiceUnchanged: true,
    firestoreInvoiceId: "hdunhWICAZHIBp2MH2JR",
  });
  assert.strictEqual(decision.skip, true);
  assert.strictEqual(decision.reason, "customer_invoice_unchanged");
  assert.strictEqual(
      decision.priorInvoiceId, "kQbNFIXTBJaZVJheHCfH");
  assert.strictEqual(db.store.send.status, "sent");
  passed++;
  console.log("ok", "267957 replay of invoice 30489 is skipped");
}

/**
 * @return {Promise<void>}
 */
async function checkChangedBill() {
  const db = fakeDb([{
    id: "old",
    data: {
      loadNumber: "267957",
      finalWorkflowStatus: "completed",
      customerInvoiceId: "3618447",
      issuedInvoiceNumber: "30489",
      customerRate: 945,
    },
  }], null);
  const decision = await guard.evaluateCustomerInvoiceResend(db, {
    loadNumber: "267957",
    customerInvoiceId: "3618447",
    invoiceNumber: "30489",
    invoiceTotal: 1020,
    customerRate: 945,
    customerBillLines: [{name: "Liftgate", amount: 75}],
    invoiceUnchanged: false,
    firestoreInvoiceId: "new-doc",
  });
  assert.strictEqual(decision.skip, false);
  assert.ok(decision.claim);
  passed++;
  console.log("ok", "changed customer total is allowed to send");
}

/**
 * @return {Promise<void>}
 */
async function checkStatementLog() {
  guard._setEmailLogRows([{
    invoiceId: "kQbNFIXTBJaZVJheHCfH",
    details: JSON.stringify({
      message: "Customer documents emailed via Primus emailBOLDocs",
      customerInvoiceId: 3618447,
      invoiceNumber: "30489",
    }),
  }]);
  const db = fakeDb([], null);
  const decision = await guard.evaluateCustomerInvoiceResend(db, {
    loadNumber: "267957",
    customerInvoiceId: 3618447,
    invoiceNumber: "30489",
    invoiceTotal: 945,
    customerRate: 945,
    customerBillLines: [],
    invoiceUnchanged: false,
    firestoreInvoiceId: "hdunhWICAZHIBp2MH2JR",
  });
  guard._setEmailLogRows(null);
  assert.strictEqual(decision.skip, true);
  assert.strictEqual(decision.reason, "customer_invoice_unchanged");
  assert.strictEqual(
      decision.priorInvoiceId, "kQbNFIXTBJaZVJheHCfH");
  passed++;
  console.log("ok", "statement reuse skips when emailBOLDocs already ran");
}

/**
 * @return {Promise<void>}
 */
async function checkSentFlagIgnored() {
  guard._setEmailLogRows([]);
  const db = fakeDb([{
    id: "old",
    data: {
      loadNumber: "267957",
      finalWorkflowStatus: "running",
      customerInvoiceId: 3618447,
      issuedInvoiceNumber: "30489",
      customerInvoiceStatus: "sent",
      status: {sent: true},
      customerRate: 945,
    },
  }], null);
  const decision = await guard.evaluateCustomerInvoiceResend(db, {
    loadNumber: "267957",
    customerInvoiceId: 3618447,
    invoiceNumber: "30489",
    invoiceTotal: 945,
    customerRate: 945,
    customerBillLines: [],
    invoiceUnchanged: true,
    firestoreInvoiceId: "new-doc",
  });
  guard._setEmailLogRows(null);
  assert.strictEqual(decision.skip, false);
  assert.ok(decision.claim);
  passed++;
  console.log("ok", "a sent status flag alone does not count as emailed");
}

/**
 * @return {Promise<void>}
 */
async function checkWorkflowEmailStep() {
  guard._setEmailLogRows([]);
  const db = fakeDb([{
    id: "kQbNFIXTBJaZVJheHCfH",
    data: {
      loadNumber: "267957",
      finalWorkflowStatus: "running",
      customerInvoiceId: "3618447",
      issuedInvoiceNumber: "30489",
      customerInvoiceStatus: "not sent",
      customerRate: 945,
    },
  }], null, {
    logs: {
      kQbNFIXTBJaZVJheHCfH: [{
        stepName: "final_email_sent",
        stepStatus: "success",
        output: {via: "primus_emailBOLDocs"},
      }],
    },
  });
  const decision = await guard.evaluateCustomerInvoiceResend(db, {
    loadNumber: "267957",
    customerInvoiceId: 3618447,
    invoiceNumber: "30489",
    invoiceTotal: 945,
    customerRate: 945,
    customerBillLines: [],
    invoiceUnchanged: false,
    firestoreInvoiceId: "hdunhWICAZHIBp2MH2JR",
  });
  guard._setEmailLogRows(null);
  assert.strictEqual(decision.skip, true);
  assert.strictEqual(
      decision.priorInvoiceId, "kQbNFIXTBJaZVJheHCfH");
  passed++;
  console.log("ok", "final_email_sent skips even when status is not sent");
}

/**
 * @return {Promise<void>}
 */
async function checkOutboundMail() {
  guard._setEmailLogRows([]);
  const db = fakeDb([], null, {
    outbound: [{
      id: "mail1",
      loadNumber: "267957",
      subject: "Invoice for BOL#267957",
      type: "generated_bill",
      customerInvoiceId: "3618447",
      invoiceNumber: "30489",
    }],
  });
  const decision = await guard.evaluateCustomerInvoiceResend(db, {
    loadNumber: "267957",
    customerInvoiceId: 3618447,
    invoiceNumber: "30489",
    invoiceTotal: 945,
    customerRate: 945,
    customerBillLines: [],
    invoiceUnchanged: false,
    firestoreInvoiceId: "new-doc",
  });
  guard._setEmailLogRows(null);
  assert.strictEqual(decision.skip, true);
  passed++;
  console.log("ok", "saved customer invoice mail skips a resend");
}

checkReplay()
    .then(checkChangedBill)
    .then(checkStatementLog)
    .then(checkSentFlagIgnored)
    .then(checkWorkflowEmailStep)
    .then(checkOutboundMail)
    .then(() => {
      console.log(passed + " passed");
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
