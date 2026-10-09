/* eslint-env browser */
/**
 * Shared runtime for the Innovative quote dashboard (Netlify).
 * - QD: config, API fetch with Firebase auth headers, caches, warm-up pings.
 * - QuoteAuth: Firebase email/password sign-in (same API surface as the
 *   legacy quoteAuthClient served by Cloud Functions, plus cached config
 *   so the login screen never waits on a cold function).
 */
(function (global) {
  "use strict";

  const cfg = global.QUOTE_DASHBOARD_CONFIG || {};
  const params = new URLSearchParams(global.location.search);
  const API = String(cfg.functionsBaseUrl || "").replace(/\/$/, "");
  const TENANT_ID = params.get("tenantId") || cfg.tenantId || "default";
  const tenantQS = "tenantId=" + encodeURIComponent(TENANT_ID);

  // ---------- storage helpers (versioned, TTL-aware) ----------
  function storeGet(store, key, maxAgeMs) {
    try {
      const raw = store.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return null;
      if (maxAgeMs && (Date.now() - (obj.t || 0)) > maxAgeMs) return null;
      return obj.v;
    } catch (_) {
      return null;
    }
  }
  function storeSet(store, key, value) {
    try {
      store.setItem(key, JSON.stringify({t: Date.now(), v: value}));
    } catch (_) { /* quota / private mode */ }
  }
  const lsGet = (k, age) => storeGet(global.localStorage, k, age);
  const lsSet = (k, v) => storeSet(global.localStorage, k, v);
  const ssGet = (k, age) => storeGet(global.sessionStorage, k, age);
  const ssSet = (k, v) => storeSet(global.sessionStorage, k, v);

  // ---------- QuoteAuth (ported client + cached config) ----------
  const AUTH_CFG_KEY = "qd:authConfig:" + TENANT_ID;
  const AUTH_CFG_TTL = 7 * 24 * 60 * 60 * 1000; // refreshed in background
  let allowedDomains = [];
  let ready = false;

  async function fetchAuthConfig() {
    const res = await fetch(
        API + "/getQuoteAuthConfig?" + tenantQS).then((r) => r.json());
    if (!res.ok) throw new Error(res.error || "Auth config failed");
    lsSet(AUTH_CFG_KEY, res);
    return res;
  }

  function applyAuthConfig(res) {
    allowedDomains = (res.allowedDomains || []).map((d) =>
      String(d).trim().toLowerCase()).filter(Boolean);
    if (!global.firebase.apps.length) {
      global.firebase.initializeApp(res.firebase);
    }
    ready = true;
  }

  async function authInit() {
    const cached = lsGet(AUTH_CFG_KEY, AUTH_CFG_TTL);
    if (cached && cached.firebase && cached.firebase.apiKey) {
      applyAuthConfig(cached);
      // Refresh quietly for next time; never blocks the login screen.
      fetchAuthConfig().catch(() => {});
      return cached;
    }
    const res = await fetchAuthConfig();
    applyAuthConfig(res);
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

  global.QuoteAuth = {
    init: authInit,
    async signInWithEmailPassword(email, password) {
      if (!ready) throw new Error("QuoteAuth not initialized");
      const trimmed = String(email || "").trim();
      if (!emailDomainAllowed(trimmed)) {
        throw new Error("Use your company email address");
      }
      return auth().signInWithEmailAndPassword(trimmed, String(password || ""));
    },
    async sendPasswordResetEmail(email) {
      if (!ready) throw new Error("QuoteAuth not initialized");
      const trimmed = String(email || "").trim();
      if (!trimmed) throw new Error("Enter your email");
      if (!emailDomainAllowed(trimmed)) {
        throw new Error("Use your company email address");
      }
      return auth().sendPasswordResetEmail(trimmed);
    },
    async signOut() {
      return auth().signOut();
    },
    async getIdToken() {
      const user = auth().currentUser;
      if (!user) return null;
      return user.getIdToken();
    },
    async authHeaders() {
      const token = await global.QuoteAuth.getIdToken();
      if (!token) return {};
      return {Authorization: "Bearer " + token};
    },
    onAuth(callback) {
      return auth().onAuthStateChanged(callback);
    },
  };

  // ---------- Legacy bookmark-token support (quote page links) ----------
  let legacy = null; // {dispatcherId, token}
  function setLegacyAuth(dispatcherId, token) {
    legacy = dispatcherId && token ?
      {dispatcherId: String(dispatcherId), token: String(token)} : null;
  }

  // ---------- API fetch ----------
  async function api(path, opts) {
    let headers = {};
    try {
      headers = await global.QuoteAuth.authHeaders();
    } catch (_) { /* legacy / unsigned */ }
    headers = Object.assign(
        {"Content-Type": "application/json"},
        headers,
        (opts && opts.headers) || {});
    let url = API + path;
    if (legacy) {
      url += (path.indexOf("?") >= 0 ? "&" : "?") +
        "dispatcherId=" + encodeURIComponent(legacy.dispatcherId) +
        "&token=" + encodeURIComponent(legacy.token);
    }
    const res = await fetch(url, Object.assign({}, opts || {}, {headers}));
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      throw new Error(res.status === 200 ?
        "Invalid response" : ("Request failed (" + res.status + ")"));
    }
    return data;
  }

  /** Raw fetch with auth headers — for blob downloads (CSV / XLSX). */
  async function apiBlob(path) {
    let headers = {};
    try {
      headers = await global.QuoteAuth.authHeaders();
    } catch (_) { /* unsigned */ }
    let url = API + path;
    if (legacy) {
      url += (path.indexOf("?") >= 0 ? "&" : "?") +
        "dispatcherId=" + encodeURIComponent(legacy.dispatcherId) +
        "&token=" + encodeURIComponent(legacy.token);
    }
    const res = await fetch(url, {headers});
    if (!res.ok) {
      let msg = "Request failed (" + res.status + ")";
      try {
        const data = await res.json();
        if (data && data.error) msg = data.error;
      } catch (_) { /* ignore */ }
      throw new Error(msg);
    }
    return res.blob();
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------- Keep hot endpoints warm ----------
  // Fire-and-forget pings so Cloud Run containers are already booted by the
  // time the user clicks a button. Unauthenticated requests return 401/400
  // instantly but still spin the instance (loading index.js is the slow part).
  const WARM_KEY = "qd:lastWarm";
  const WARM_THROTTLE_MS = 4 * 60 * 1000;
  const WARM_ENDPOINTS = [
    "getQuoteDispatcherInbox",
    "getQuoteDispatcherProfile",
    "getQuoteDispatcherData",
    "getQuoteAccessorialCatalog",
    "saveQuoteSelections",
    "generateQuoteEmail",
    "rerunQuoteRates",
    "approveQuoteEmail",
  ];

  function warmUp(names, opts) {
    const force = !!(opts && opts.force);
    const last = Number(ssGet(WARM_KEY) || 0);
    if (!force && Date.now() - last < WARM_THROTTLE_MS) return;
    ssSet(WARM_KEY, Date.now());
    (names || WARM_ENDPOINTS).forEach((name) => {
      try {
        fetch(API + "/" + name + "?warm=1&" + tenantQS, {
          method: "GET",
          keepalive: true,
        }).catch(() => {});
      } catch (_) { /* ignore */ }
    });
  }

  // ---------- Thinking rotation (shared across pages) ----------
  const THINKING_PHRASES = [
    "Searching out all carriers for you",
    "Looking over data",
    "Processing",
    "Thinking",
    "Reviewing quote details",
    "Checking rates and transit",
    "Matching the best options",
    "Preparing your results",
  ];

  function createThinking(statusElId, phrases) {
    const list = (phrases && phrases.length) ? phrases : THINKING_PHRASES;
    const ROTATE_MS = 1500;
    const FADE_MS = 220;
    let timer = null;
    let fadeTimer = null;
    let step = 0;

    function dotsEl() {
      const dots = document.createElement("span");
      dots.className = "thinking-dots";
      dots.setAttribute("aria-hidden", "true");
      dots.innerHTML = "<span>.</span><span>.</span><span>.</span>";
      return dots;
    }
    function applyPhrase(phrase) {
      const el = document.getElementById(statusElId);
      if (!el) return;
      el.textContent = "";
      el.appendChild(document.createTextNode(phrase));
      el.appendChild(dotsEl());
    }
    function setCopy(n, withFade) {
      const phrase = list[n % list.length];
      const el = document.getElementById(statusElId);
      if (!el) return;
      if (fadeTimer) {
        clearTimeout(fadeTimer);
        fadeTimer = null;
      }
      if (!withFade) {
        el.classList.remove("is-fading");
        applyPhrase(phrase);
        return;
      }
      el.classList.add("is-fading");
      fadeTimer = setTimeout(() => {
        applyPhrase(phrase);
        el.classList.remove("is-fading");
        fadeTimer = null;
      }, FADE_MS);
    }
    return {
      start() {
        step = 0;
        setCopy(0, false);
        if (timer) clearInterval(timer);
        timer = setInterval(() => {
          step += 1;
          setCopy(step, true);
        }, ROTATE_MS);
      },
      stop() {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        if (fadeTimer) {
          clearTimeout(fadeTimer);
          fadeTimer = null;
        }
      },
    };
  }

  // ---------- misc utils ----------
  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/"/g, "&quot;");
  }
  function num(n) {
    const v = Number(n);
    return isFinite(v) ? v.toFixed(2) : "—";
  }
  function pageUrl(page, extra) {
    const qs = new URLSearchParams(extra || {});
    if (TENANT_ID && TENANT_ID !== "default") qs.set("tenantId", TENANT_ID);
    const s = qs.toString();
    return page + (s ? "?" + s : "");
  }

  global.QD = {
    API,
    TENANT_ID,
    tenantQS,
    params,
    config: cfg,
    api,
    apiBlob,
    downloadBlob,
    setLegacyAuth,
    lsGet, lsSet, ssGet, ssSet,
    warmUp,
    createThinking,
    esc,
    num,
    pageUrl,
  };
})(window);
