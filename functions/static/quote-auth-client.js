/* eslint-env browser */
/* eslint-disable require-jsdoc, space-before-function-paren */
/**
 * Shared Firebase email/password sign-in for quote dashboards.
 */
(function (global) {
  let apiBase = "";
  let tenantId = "default";
  let allowedDomains = [];
  let ready = false;

  async function init(options) {
    apiBase = options.apiBase;
    tenantId = options.tenantId || "default";
    const res = await fetch(
        apiBase + "/getQuoteAuthConfig?tenantId=" +
        encodeURIComponent(tenantId)).then((r) => r.json());
    if (!res.ok) throw new Error(res.error || "Auth config failed");
    allowedDomains = (res.allowedDomains || []).map((d) =>
      String(d).trim().toLowerCase()).filter(Boolean);
    if (!global.firebase.apps.length) {
      global.firebase.initializeApp(res.firebase);
    }
    ready = true;
    return res;
  }

  function auth() {
    return global.firebase.auth();
  }

  function emailDomainAllowed(email) {
    if (!allowedDomains.length) return true;
    const parts = String(email || "").toLowerCase().split("@");
    if (parts.length !== 2) return false;
    const domain = parts[1];
    return allowedDomains.some((d) => domain === d || domain.endsWith("." + d));
  }

  async function signInWithEmailPassword(email, password) {
    if (!ready) throw new Error("QuoteAuth not initialized");
    const trimmed = String(email || "").trim();
    if (!emailDomainAllowed(trimmed)) {
      throw new Error("Use your company email address");
    }
    return auth().signInWithEmailAndPassword(trimmed, String(password || ""));
  }

  async function sendPasswordResetEmail(email) {
    if (!ready) throw new Error("QuoteAuth not initialized");
    const trimmed = String(email || "").trim();
    if (!trimmed) throw new Error("Enter your email");
    if (!emailDomainAllowed(trimmed)) {
      throw new Error("Use your company email address");
    }
    return auth().sendPasswordResetEmail(trimmed);
  }

  async function signOut() {
    return auth().signOut();
  }

  async function getIdToken() {
    const user = auth().currentUser;
    if (!user) return null;
    return user.getIdToken();
  }

  async function authHeaders() {
    const token = await getIdToken();
    if (!token) return {};
    return {Authorization: "Bearer " + token};
  }

  function onAuth(callback) {
    return auth().onAuthStateChanged(callback);
  }

  global.QuoteAuth = {
    init,
    signInWithEmailPassword,
    sendPasswordResetEmail,
    signOut,
    getIdToken,
    authHeaders,
    onAuth,
  };
})(window);
