#!/usr/bin/env node
/**
 * Create a Firebase Auth user and seed quoteDispatchers doc for quote dashboards.
 *
 * Usage:
 *   node scripts/create-quote-dispatcher-user.js
 *   node scripts/create-quote-dispatcher-user.js --email user@example.com --id developer
 *   node scripts/create-quote-dispatcher-user.js --id leo --email leo@innovativecarriers.com --name Leo --reset-password
 *
 * Requires Application Default Credentials (firebase login or GOOGLE_APPLICATION_CREDENTIALS).
 */
"use strict";

const crypto = require("crypto");
const admin = require("firebase-admin");
const {GoogleAuth} = require("google-auth-library");
const quoteDispatchers = require("../quote-dispatchers");

const PROJECT = "tai-invoice-automation";
const DEFAULT_EMAIL = "moshe@advancedautomations.net";
const DEFAULT_DISPATCHER_ID = "developer";

/**
 * @return {Promise<string>}
 */
async function getAccessToken() {
  const auth = new GoogleAuth({
    projectId: PROJECT,
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/firebase",
    ],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) throw new Error("No access token — run firebase login");
  return token.token;
}

/** @return {object} */
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    email: DEFAULT_EMAIL,
    dispatcherId: DEFAULT_DISPATCHER_ID,
    tenantId: "default",
    displayName: "Developer",
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--email") opts.email = args[++i];
    else if (a === "--id") opts.dispatcherId = args[++i];
    else if (a === "--tenant-id") opts.tenantId = args[++i];
    else if (a === "--name") opts.displayName = args[++i];
    else if (a.startsWith("--")) {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

/**
 * @param {object} tenant Tenant config.
 * @param {string} name Collection name.
 * @return {FirebaseFirestore.CollectionReference}
 */
function tcol(tenant, name) {
  const prefix = tenant.tenantId && tenant.tenantId !== "default" ?
    `${tenant.tenantId}_` : "";
  return admin.firestore().collection(`${prefix}${name}`);
}

/**
 * @return {string}
 */
function randomPassword() {
  return crypto.randomBytes(18).toString("base64url");
}

/**
 * @param {string} accessToken OAuth token.
 * @return {Promise<void>}
 */
async function ensureAuthConfig(accessToken) {
  const headers = {
    Authorization: "Bearer " + accessToken,
    "Content-Type": "application/json",
    "x-goog-user-project": PROJECT,
  };
  const adminBase =
    "https://identitytoolkit.googleapis.com/admin/v2/projects/" + PROJECT;

  const cfgResp = await fetch(adminBase + "/config", {headers});
  const cfgText = await cfgResp.text();
  if (cfgResp.status === 404 || cfgText.includes("CONFIGURATION_NOT_FOUND")) {
    const initResp = await fetch(
        "https://identitytoolkit.googleapis.com/v2/projects/" + PROJECT +
        "/identityPlatform:initializeAuth",
        {method: "POST", headers, body: "{}"},
    );
    const initText = await initResp.text();
    if (!initResp.ok && !initText.includes("ALREADY_EXISTS")) {
      throw new Error(
          `initializeAuth failed (${initResp.status}): ${initText.slice(0, 300)}`,
      );
    }
  }

  const patchResp = await fetch(
      adminBase +
      "/config?updateMask=signIn.email.enabled,signIn.email.passwordRequired",
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          signIn: {
            email: {
              enabled: true,
              passwordRequired: true,
            },
          },
        }),
      },
  );
  const patchText = await patchResp.text();
  if (!patchResp.ok) {
    throw new Error(
        `Auth config patch failed (${patchResp.status}): ${patchText.slice(0, 300)}`,
    );
  }
}
/**
 * @param {string} email Email address.
 * @param {string} displayName Display name.
 * @param {string} accessToken OAuth token.
 * @return {Promise<object>}
 */
async function ensureAuthUser(email, displayName, accessToken) {
  const normalized = String(email).trim().toLowerCase();
  const headers = {
    Authorization: "Bearer " + accessToken,
    "Content-Type": "application/json",
    "x-goog-user-project": PROJECT,
  };
  const lookupUrl =
    "https://identitytoolkit.googleapis.com/v1/projects/" + PROJECT +
    "/accounts:lookup";
  const lookupResp = await fetch(lookupUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({email: [normalized]}),
  });
  const lookupText = await lookupResp.text();
  let lookupJson = {};
  try {
    lookupJson = JSON.parse(lookupText);
  } catch (_) {
    /* ignore */
  }

  if (lookupResp.ok && lookupJson.users && lookupJson.users.length) {
    const user = lookupJson.users[0];
    console.log(`Auth user already exists: uid=${user.localId}`);
    return {user: {uid: user.localId}, tempPassword: null, created: false};
  }

  const tempPassword = randomPassword();
  const createUrl =
    "https://identitytoolkit.googleapis.com/v1/projects/" + PROJECT +
    "/accounts";
  const createResp = await fetch(createUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      email: normalized,
      password: tempPassword,
      displayName,
      emailVerified: true,
    }),
  });
  const createText = await createResp.text();
  if (!createResp.ok) {
    throw new Error(
        `Auth create failed (${createResp.status}): ${createText.slice(0, 400)}`,
    );
  }
  const createJson = JSON.parse(createText);
  console.log(`Created Auth user: uid=${createJson.localId}`);
  return {
    user: {uid: createJson.localId},
    tempPassword,
    created: true,
  };
}

/**
 * @param {object} opts Script options.
 * @param {string} accessToken OAuth token.
 * @return {Promise<void>}
 */
async function seedDispatcherDocRest(opts, accessToken) {
  const collection = opts.tenantId === "default" ?
    "quoteDispatchers" : `${opts.tenantId}_quoteDispatchers`;
  const fallback = quoteDispatchers.DEFAULT_DISPATCHERS
      .find((d) => d.id === opts.dispatcherId);
  const row = fallback || {
    name: opts.displayName,
    email: opts.email,
    active: true,
    signature: `${opts.displayName}\nAdvanced Automations`,
  };
  const url =
    "https://firestore.googleapis.com/v1/projects/" + PROJECT +
    "/databases/(default)/documents/" + collection + "/" +
    opts.dispatcherId +
    "?updateMask.fieldPaths=name&updateMask.fieldPaths=email" +
    "&updateMask.fieldPaths=active&updateMask.fieldPaths=signature";
  const resp = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": "application/json",
      "x-goog-user-project": PROJECT,
    },
    body: JSON.stringify({
      fields: {
        name: {stringValue: row.name},
        email: {stringValue: opts.email},
        active: {booleanValue: true},
        signature: {stringValue: row.signature || row.name},
      },
    }),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(
        `Firestore REST seed failed (${resp.status}): ${text.slice(0, 300)}`,
    );
  }
  console.log(`Firestore ${collection}/${opts.dispatcherId} upserted (REST)`);
}

/**
 * @param {object} opts Script options.
 * @param {string} accessToken OAuth token.
 * @return {Promise<void>}
 */
async function seedDispatcherDoc(opts, accessToken) {
  try {
    const tenant = {tenantId: opts.tenantId};
    quoteDispatchers.init({tcol});

    const fallback = quoteDispatchers.DEFAULT_DISPATCHERS
        .find((d) => d.id === opts.dispatcherId);
    const row = fallback || {
      id: opts.dispatcherId,
      name: opts.displayName,
      email: opts.email,
      active: true,
      signature: `${opts.displayName}\nAdvanced Automations`,
    };
    const {id, ...rest} = row;

    const ref = tcol(tenant, "quoteDispatchers").doc(id);
    const snap = await ref.get();
    await ref.set({
      ...rest,
      email: opts.email,
      name: opts.displayName,
      active: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(snap.exists ? {} : {
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }),
    }, {merge: true});

    console.log(
        `Firestore quoteDispatchers/${id} ${snap.exists ? "updated" : "created"}`,
    );
  } catch (err) {
    console.warn("Admin SDK Firestore failed, trying REST:", err.message);
    await seedDispatcherDocRest(opts, accessToken);
  }
}

async function main() {
  const opts = parseArgs();
  if (!admin.apps.length) {
    admin.initializeApp({projectId: PROJECT});
  }

  console.log(`Project: ${PROJECT}`);
  console.log(`Tenant: ${opts.tenantId}`);
  console.log(`Dispatcher id: ${opts.dispatcherId}`);
  console.log(`Email: ${opts.email}`);

  const accessToken = await getAccessToken();
  await ensureAuthConfig(accessToken);
  const authResult = await ensureAuthUser(
      opts.email, opts.displayName, accessToken);

  console.log("\n--- Auth ---");
  console.log(`Auth user uid: ${authResult.user.uid}`);
  if (authResult.created && authResult.tempPassword) {
    console.log(`Temporary password: ${authResult.tempPassword}`);
    console.log("Change this password after first sign-in.");
  } else {
    console.log("No new password generated (user already existed).");
    console.log("Reset password in Firebase Console if needed.");
  }

  await seedDispatcherDoc(opts, accessToken);

  console.log("\n--- Summary ---");
  console.log(`Email: ${opts.email}`);
  console.log(`Dispatcher id: ${opts.dispatcherId}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
