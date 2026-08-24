/**
 * Quote dispatcher roster — one dashboard per dispatcher.
 */

"use strict";

const admin = require("firebase-admin");

const DEFAULT_DISPATCHERS = [
  {
    id: "leo",
    name: "Leo",
    email: "leo@innovativecarriers.com",
    active: true,
    signature: "Leo\nInnovative Carriers",
  },
  {
    id: "barry",
    name: "Barry",
    email: "barry@innovativecarriers.com",
    active: true,
    signature: "Barry Schlesinger\nInnovative Carriers",
  },
  {
    id: "izzy",
    name: "Izzy",
    email: "izzy@innovativecarriers.com",
    phone: "718-218-7245 x211",
    active: true,
    signature: "Izzy\nQuotation Specialist\nT: 718-218-7245 x211",
  },
  {
    id: "leah",
    name: "Leah",
    email: "leah@innovativecarriers.com",
    active: true,
    signature: "Leah\nInnovative Carriers",
  },
  {
    id: "diego",
    name: "Diego",
    email: "diego@innovativecarriers.com",
    phone: "718-218-7245 x250",
    active: true,
    signature: "Diego Romero\nQuotation Specialist",
  },
  {
    id: "qd",
    name: "Quote Desk",
    email: "qd@innovativecarriers.com",
    active: true,
    signature: "Innovative Quotes",
  },
  {
    id: "developer",
    name: "Developer",
    email: "moshe@advancedautomations.net",
    active: true,
    signature: "Developer\nAdvanced Automations",
  },
];

let tcolFn = null;

/**
 * @param {object} deps tcol.
 * @return {void}
 */
function init(deps) {
  tcolFn = deps.tcol;
}

/**
 * @param {object} tenant Tenant.
 * @param {string} name Collection.
 * @return {FirebaseFirestore.CollectionReference}
 */
function col(tenant, name) {
  if (!tcolFn) throw new Error("quote-dispatchers not initialized");
  return tcolFn(tenant, name);
}

/**
 * @param {object} tenant Tenant.
 * @return {Promise<void>}
 */
async function seedDefaultDispatchers(tenant) {
  const batch = admin.firestore().batch();
  const ref = col(tenant, "quoteDispatchers");
  for (const row of DEFAULT_DISPATCHERS) {
    const {id, ...rest} = row;
    batch.set(ref.doc(id), {
      ...rest,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
  }
  await batch.commit();
}

/**
 * @param {object} tenant Tenant.
 * @return {Promise<Array<object>>}
 */
async function listActiveDispatchers(tenant) {
  const snap = await col(tenant, "quoteDispatchers")
      .where("active", "==", true)
      .get();
  if (snap.empty) {
    await seedDefaultDispatchers(tenant);
    return DEFAULT_DISPATCHERS.map((d) => ({...d}));
  }
  return snap.docs
      .map((d) => ({id: d.id, ...d.data()}))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * @param {object} tenant Tenant.
 * @param {string} dispatcherId Id.
 * @return {Promise<object|null>}
 */
async function getDispatcher(tenant, dispatcherId) {
  const snap = await col(tenant, "quoteDispatchers")
      .doc(String(dispatcherId)).get();
  if (!snap.exists) {
    const fallback = DEFAULT_DISPATCHERS.find((d) => d.id === dispatcherId);
    return fallback ? {...fallback} : null;
  }
  return {id: snap.id, ...snap.data()};
}

/**
 * Round-robin assign next active dispatcher.
 * @param {object} tenant Tenant.
 * @return {Promise<object|null>}
 */
async function assignNextDispatcher(tenant) {
  const active = await listActiveDispatchers(tenant);
  if (!active.length) return null;

  const stateRef = col(tenant, "quoteDispatcherState").doc("roundRobin");
  const assigned = await admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(stateRef);
    const lastIdx = snap.exists ? Number(snap.data().lastIndex) || 0 : 0;
    const nextIdx = lastIdx % active.length;
    tx.set(stateRef, {
      lastIndex: nextIdx + 1,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
    return active[nextIdx];
  });
  return assigned;
}

/**
 * @param {string} email Email address.
 * @return {string}
 */
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/**
 * Match dispatcher by email address (for manual routing).
 * @param {object} tenant Tenant.
 * @param {string} email Email.
 * @return {Promise<object|null>}
 */
async function findDispatcherByEmail(tenant, email) {
  const target = normalizeEmail(email);
  if (!target) return null;
  const all = await listActiveDispatchers(tenant);
  return all.find((d) => normalizeEmail(d.email) === target) || null;
}

/**
 * @param {object} tenant Tenant.
 * @param {object} dispatcher Dispatcher row.
 * @param {string} [quoteId] Optional quote id.
 * @return {object} URL bundle.
 */
function buildDispatcherUrls(tenant, dispatcher, quoteId) {
  const base = process.env.PUBLIC_FUNCTIONS_BASE_URL ||
    "https://us-central1-tai-invoice-automation.cloudfunctions.net";
  const tenantId = encodeURIComponent(tenant.tenantId);
  const homeUrl =
    `${base}/quoteDispatcherHomePage?tenantId=${tenantId}`;
  let quoteUrl = null;
  if (quoteId) {
    quoteUrl =
      `${base}/quoteDispatcherPage?id=${encodeURIComponent(quoteId)}` +
      `&tenantId=${tenantId}`;
  }
  return {homeUrl, quoteUrl};
}

module.exports = {
  init,
  DEFAULT_DISPATCHERS,
  seedDefaultDispatchers,
  listActiveDispatchers,
  getDispatcher,
  assignNextDispatcher,
  findDispatcherByEmail,
  buildDispatcherUrls,
  normalizeEmail,
};
