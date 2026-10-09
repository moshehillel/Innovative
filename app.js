/* eslint-env browser */
/* global QD, QuoteAuth */
/**
 * Quote dashboard home (inbox) — Netlify SPA.
 * Same functionality as the legacy quoteDispatcherHomePage, plus:
 *  - stale-while-revalidate inbox/profile cache (instant paint on revisit)
 *  - hover prefetch of quote detail data
 *  - endpoint warm-up pings so buttons respond fast
 */
(function () {
  "use strict";

  const API = QD.API;
  const TENANT_ID = QD.TENANT_ID;
  const esc = QD.esc;
  const num = QD.num;

  // Warm the hot endpoints immediately — even while the user types a password.
  QD.warmUp();

  const SYNC_THROTTLE_MS = 5 * 60 * 1000;
  const SYNC_KEY = "quoteOutlookLastSync:" + TENANT_ID;
  const PROFILE_KEY = "qd:profile:" + TENANT_ID;
  const INBOX_CACHE_TTL = 10 * 60 * 1000;
  const CATALOG_KEY = "qd:accCatalog:" + TENANT_ID;
  const CATALOG_TTL = 12 * 60 * 60 * 1000;
  let filterStatus = "pending";
  let periodFilter = "all";
  let serverCounts = null;
  let periodCatalog = null;
  let outlookConnected = false;
  let syncInFlight = null;
  let inboxLoadInFlight = null;
  const INBOX_PAGE_SIZE = 20;
  const RATE_PAGE_SIZE = 20;
  let inboxItems = [];
  let inboxOffset = 0;
  let inboxHasMore = false;
  let loadMoreInFlight = false;
  const inboxTabs = {};
  const prefetchedQuotes = {};

  const thinking = QD.createThinking("thinking-status");

  function inboxCacheKey(tabKey) {
    return "qd:inbox:" + TENANT_ID + ":" + (tabKey || "all");
  }

  function quoteOpenUrl(item) {
    return QD.pageUrl("quote.html", {id: String(item.id)});
  }

  function prefetchQuote(id) {
    const key = String(id || "");
    if (!key || prefetchedQuotes[key]) return;
    prefetchedQuotes[key] = true;
    QD.api("/getQuoteDispatcherData?id=" + encodeURIComponent(key) +
      "&" + QD.tenantQS)
        .then((res) => {
          if (res && res.ok && res.quote) {
            QD.ssSet("qd:quote:" + key, res.quote);
          }
        })
        .catch(() => {
          delete prefetchedQuotes[key];
        });
  }

  function showInboxThinking(active) {
    const panel = document.getElementById("page-thinking");
    const rows = document.getElementById("rows");
    if (!panel || !rows) return;
    if (active) {
      rows.classList.add("hidden");
      panel.classList.remove("hidden");
      panel.setAttribute("aria-busy", "true");
      thinking.start();
    } else {
      thinking.stop();
      panel.classList.add("hidden");
      panel.setAttribute("aria-busy", "false");
      rows.classList.remove("hidden");
    }
  }

  const apiFetch = QD.api;

  function quoteStatusOf(item) {
    return String((item && item.status) || "").toLowerCase().trim();
  }

  function isDismissedItem(item) {
    if (!item) return false;
    if (quoteStatusOf(item) === "dismissed") return true;
    return !!item.dismissedAt;
  }

  function isCompletedItem(item) {
    if (!item) return false;
    if (quoteStatusOf(item) === "completed") return true;
    return !!item.completedAt;
  }

  function isInactiveItem(item) {
    return isDismissedItem(item) || isCompletedItem(item);
  }

  function isPendingItem(item) {
    if (isInactiveItem(item)) return false;
    const status = quoteStatusOf(item);
    return status === "awaiting_dispatcher" || status === "draft_ready";
  }

  function isForReviewItem(item) {
    if (isInactiveItem(item)) return false;
    return !!(item && item.forReview);
  }

  function isSentItem(item) {
    if (isInactiveItem(item)) return false;
    return quoteStatusOf(item) === "sent";
  }

  function writeStat(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(Math.max(0, value));
  }

  function readStat(id) {
    const n = Number(document.getElementById(id).textContent);
    return isFinite(n) ? n : 0;
  }

  let lastCounts = null;

  function applyCounts(counts) {
    const c = counts || {};
    lastCounts = c;
    writeStat("stat-total", Number(c.total) || 0);
    writeStat("stat-awaiting", Number(c.awaiting) || 0);
    writeStat("stat-draft", Number(c.draftReady) || 0);
    writeStat("stat-sent", Number(c.sent) || 0);
    writeStat("stat-review", Number(c.forReview) || 0);
    writeStat("stat-completed", Number(c.completed) || 0);
    writeStat("stat-dismissed", Number(c.dismissed) || 0);
  }

  function syncFilterButtons() {
    const map = {
      pending: "filter-pending",
      sent: "filter-sent",
      for_review: "filter-review",
      completed: "filter-completed",
      "": "filter-all",
    };
    Object.keys(map).forEach((key) => {
      const el = document.getElementById(map[key]);
      if (!el) return;
      el.classList.toggle("active", filterStatus === key);
    });
  }

  function defaultReportDates() {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 30);
    const iso = (d) => d.toISOString().slice(0, 10);
    const fromEl = document.getElementById("report-from");
    const toEl = document.getElementById("report-to");
    if (fromEl && !fromEl.value) fromEl.value = iso(from);
    if (toEl && !toEl.value) toEl.value = iso(to);
  }

  function bumpStat(id, delta) {
    writeStat(id, readStat(id) + delta);
    if (!serverCounts) return;
    const key = {
      "stat-total": "total",
      "stat-awaiting": "awaiting",
      "stat-draft": "draftReady",
      "stat-sent": "sent",
      "stat-review": "forReview",
      "stat-completed": "completed",
      "stat-dismissed": "dismissed",
    }[id];
    if (!key) return;
    serverCounts[key] = Math.max(0, (Number(serverCounts[key]) || 0) + delta);
    if (key === "awaiting" || key === "draftReady") {
      serverCounts.pending = Math.max(0,
          (Number(serverCounts.pending) || 0) + delta);
    }
  }

  function statusStatId(status) {
    const s = quoteStatusOf({status: status});
    if (s === "awaiting_dispatcher") return "stat-awaiting";
    if (s === "draft_ready") return "stat-draft";
    if (s === "sent") return "stat-sent";
    return "";
  }

  function applyLocalDismissStats(status) {
    bumpStat("stat-dismissed", 1);
    const sid = statusStatId(status);
    if (sid) bumpStat(sid, -1);
  }

  function applyLocalCompleteStats(status, nowCompleted, wasReview) {
    bumpStat("stat-completed", nowCompleted ? 1 : -1);
    const sid = statusStatId(status);
    if (sid) bumpStat(sid, nowCompleted ? -1 : 1);
    if (nowCompleted && wasReview) bumpStat("stat-review", -1);
  }

  async function dismissQuoteById(quoteId) {
    const id = String(quoteId || "").trim();
    if (!id) throw new Error("Missing quote id");
    const res2 = await apiFetch(
        "/dismissQuote?" + QD.tenantQS +
        "&quoteId=" + encodeURIComponent(id), {
          method: "POST",
          body: JSON.stringify({
            tenantId: TENANT_ID,
            quoteId: id,
            id: id,
          }),
        });
    if (!res2.ok) throw new Error(res2.error || "Dismiss failed");
    return res2;
  }

  async function markQuoteForReview(quoteId, forReview) {
    const id = String(quoteId || "").trim();
    if (!id) throw new Error("Missing quote id");
    const res2 = await apiFetch(
        "/markQuoteForReview?" + QD.tenantQS +
        "&quoteId=" + encodeURIComponent(id), {
          method: "POST",
          body: JSON.stringify({
            tenantId: TENANT_ID,
            quoteId: id,
            id: id,
            forReview: !!forReview,
          }),
        });
    if (!res2.ok) throw new Error(res2.error || "Update failed");
    return res2;
  }

  async function completeQuoteById(quoteId, completed) {
    const id = String(quoteId || "").trim();
    if (!id) throw new Error("Missing quote id");
    const res2 = await apiFetch(
        "/completeQuote?" + QD.tenantQS +
        "&quoteId=" + encodeURIComponent(id), {
          method: "POST",
          body: JSON.stringify({
            tenantId: TENANT_ID,
            quoteId: id,
            id: id,
            completed: completed !== false,
          }),
        });
    if (!res2.ok) throw new Error(res2.error || "Update failed");
    return res2;
  }

  async function downloadReportCsv() {
    defaultReportDates();
    const from = document.getElementById("report-from").value || "";
    const to = document.getElementById("report-to").value || "";
    let path = "/exportQuoteDispatcherReport?" + QD.tenantQS +
      "&status=" + encodeURIComponent("draft_ready,sent,completed");
    if (from) path += "&fromDate=" + encodeURIComponent(from);
    if (to) path += "&toDate=" + encodeURIComponent(to);
    const blob = await QD.apiBlob(path);
    QD.downloadBlob(blob, "quote-report-" + (to || from || "export") + ".csv");
  }

  function applyProfile(res) {
    document.getElementById("title").textContent =
      res.dispatcher.name + " — Quotes";
    document.getElementById("subtitle").textContent =
      res.dispatcher.email || "";
    const outlook = res.outlook || {};
    outlookConnected = !!outlook.connected;
    const statusEl = document.getElementById("outlook-status");
    const connectBtn = document.getElementById("btn-outlook-connect");
    const disconnectBtn = document.getElementById("btn-outlook-disconnect");
    if (outlook.connected) {
      statusEl.className = "status ok";
      statusEl.textContent = "Outlook connected: " + (outlook.email || "");
      connectBtn.classList.add("hidden");
      disconnectBtn.classList.remove("hidden");
    } else {
      statusEl.className = "status warn";
      statusEl.textContent =
        "Connect your Outlook mailbox (" + (res.dispatcher.email || "") +
        ") to pull in quote requests sent to you.";
      connectBtn.classList.remove("hidden");
      disconnectBtn.classList.add("hidden");
    }
  }

  async function loadProfile() {
    const res = await apiFetch("/getQuoteDispatcherProfile?" + QD.tenantQS);
    if (!res.ok) throw new Error(res.error || "Profile failed");
    applyProfile(res);
    QD.ssSet(PROFILE_KEY, res);
    return res;
  }

  function setFilterBarBusy(busy) {
    ["filter-pending", "filter-sent", "filter-review", "filter-completed",
      "filter-all", "period-day", "period-week", "period-month",
      "period-year", "period-all"]
        .forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.disabled = !!busy;
        });
    const loadMoreBtn = document.getElementById("btn-load-more");
    if (loadMoreBtn && !loadMoreInFlight) {
      loadMoreBtn.disabled = !!busy;
    }
  }

  function filterInboxPage(raw, status) {
    const st = status == null ? filterStatus : status;
    if (st === "completed") {
      return (raw || []).filter(isCompletedItem);
    }
    const visible = (raw || []).filter((i) => !isInactiveItem(i));
    if (st === "pending") return visible.filter(isPendingItem);
    if (st === "sent") return visible.filter(isSentItem);
    if (st === "for_review") return visible.filter(isForReviewItem);
    return visible;
  }

  function itemMatchesTab(item, status) {
    return filterInboxPage([item], status).length > 0;
  }

  function inboxTabTotal(counts, status) {
    const st = status == null ? filterStatus : status;
    const c = counts || {};
    if (st === "pending") return Number(c.pending) || 0;
    if (st === "sent") return Number(c.sent) || 0;
    if (st === "for_review") return Number(c.forReview) || 0;
    if (st === "completed") return Number(c.completed) || 0;
    return Math.max(0,
        (Number(c.total) || 0) -
        (Number(c.dismissed) || 0) -
        (Number(c.completed) || 0));
  }

  function syncLoadMoreButton() {
    const wrap = document.getElementById("load-more-wrap");
    const btn = document.getElementById("btn-load-more");
    if (!wrap || !btn) return;
    if (inboxHasMore) {
      wrap.classList.remove("hidden");
      btn.disabled = !!(inboxLoadInFlight || loadMoreInFlight);
      btn.textContent = loadMoreInFlight ? "Loading…" : "Load more";
    } else {
      wrap.classList.add("hidden");
      btn.disabled = false;
      btn.textContent = "Load more";
    }
  }

  function ensureTabRecord(status) {
    const key = status == null ? filterStatus : status;
    if (!inboxTabs[key]) {
      inboxTabs[key] = {
        items: [], offset: 0, hasMore: false, loaded: false,
      };
    }
    return inboxTabs[key];
  }

  function saveTabCache(tabKey) {
    const tab = inboxTabs[tabKey];
    if (!tab || !tab.loaded) return;
    QD.ssSet(inboxCacheKey(tabKey), {
      items: tab.items,
      counts: lastCounts,
      offset: tab.offset,
      hasMore: tab.hasMore,
    });
  }

  function tabPanelEl(status) {
    const key = status == null ? filterStatus : status;
    const rows = document.getElementById("rows");
    const panels = rows.querySelectorAll(".inbox-tab");
    for (let i = 0; i < panels.length; i++) {
      if (panels[i].getAttribute("data-tab") === key) return panels[i];
    }
    const panel = document.createElement("div");
    panel.className = "inbox-tab";
    panel.setAttribute("data-tab", key);
    rows.appendChild(panel);
    return panel;
  }

  function showActiveTabPanel() {
    const rows = document.getElementById("rows");
    const panels = rows.querySelectorAll(".inbox-tab");
    for (let i = 0; i < panels.length; i++) {
      panels[i].classList.toggle(
          "hidden", panels[i].getAttribute("data-tab") !== filterStatus);
    }
  }

  function syncActiveTabGlobals() {
    const tab = ensureTabRecord(filterStatus);
    inboxItems = tab.items;
    inboxOffset = tab.offset;
    inboxHasMore = tab.hasMore;
  }

  function findCardEl(panel, id) {
    const want = String(id);
    const cards = panel.querySelectorAll(".quote-card");
    for (let i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute("data-id") === want) return cards[i];
    }
    return null;
  }

  function findInboxItem(quoteId) {
    const id = String(quoteId || "");
    const lists = [inboxItems];
    Object.keys(inboxTabs).forEach((key) => {
      lists.push(inboxTabs[key].items);
    });
    if (periodCatalog) lists.push(periodCatalog);
    for (let i = 0; i < lists.length; i++) {
      const found = (lists[i] || []).find((item) => String(item.id) === id);
      if (found) return found;
    }
    return null;
  }

  function patchQuoteCard(card, item) {
    const pending = isPendingItem(item);
    const forReview = isForReviewItem(item);
    const completed = isCompletedItem(item);
    const status = quoteStatusOf(item);
    card.setAttribute("data-status", item.status || "");
    card.setAttribute("data-for-review", forReview ? "1" : "0");
    const badges = card.querySelector(".quote-card-badges");
    const badge = badges &&
      badges.querySelector(".badge:not(.for-review)");
    if (badge) {
      const badgeClass = completed ? "completed" :
        (pending ? "pending" :
          (status === "sent" ? "sent" :
            (status === "draft_ready" ? "draft_ready" : "")));
      badge.className = "badge" + (badgeClass ? " " + badgeClass : "");
      badge.textContent = item.status || "";
    }
    let reviewBadge = badges && badges.querySelector(".badge.for-review");
    if (forReview && !reviewBadge && badges) {
      reviewBadge = document.createElement("span");
      reviewBadge.className = "badge for-review";
      reviewBadge.textContent = "For review";
      badges.appendChild(reviewBadge);
    } else if (!forReview && reviewBadge) {
      reviewBadge.remove();
    }
    const completeBtn = card.querySelector(".btn-complete-card");
    if (completeBtn) {
      completeBtn.disabled = false;
      completeBtn.setAttribute("data-completed", completed ? "1" : "0");
      completeBtn.textContent = completed ? "Undo complete" : "Complete";
    }
    const reviewBtn = card.querySelector(".btn-review-card");
    if (reviewBtn) {
      reviewBtn.setAttribute("data-on", forReview ? "1" : "0");
      reviewBtn.textContent = forReview ? "Unmark review" : "For review";
      reviewBtn.classList.toggle("is-on", forReview);
      reviewBtn.disabled = !!completed;
    }
    const dismissBtn = card.querySelector(".btn-dismiss-card");
    if (dismissBtn) {
      dismissBtn.disabled = !!completed;
      if (!completed) {
        dismissBtn.removeAttribute("data-confirm");
        dismissBtn.textContent = "Dismiss";
      }
    }
  }

  function quoteSnap(item) {
    return {
      status: item.status,
      forReview: !!item.forReview,
      completedAt: item.completedAt,
      dismissedAt: item.dismissedAt,
      statusBeforeCompleted: item.statusBeforeCompleted,
    };
  }

  function applyQuoteSnap(item, snap) {
    item.status = snap.status;
    item.forReview = snap.forReview;
    item.completedAt = snap.completedAt;
    item.dismissedAt = snap.dismissedAt;
    item.statusBeforeCompleted = snap.statusBeforeCompleted;
  }

  function countSnap() {
    return {
      server: serverCounts ? Object.assign({}, serverCounts) : null,
      display: {
        total: readStat("stat-total"),
        awaiting: readStat("stat-awaiting"),
        draft: readStat("stat-draft"),
        sent: readStat("stat-sent"),
        review: readStat("stat-review"),
        completed: readStat("stat-completed"),
        dismissed: readStat("stat-dismissed"),
      },
    };
  }

  function restoreCountSnap(snap) {
    if (!snap) return;
    if (snap.server) serverCounts = snap.server;
    const d = snap.display || {};
    writeStat("stat-total", d.total || 0);
    writeStat("stat-awaiting", d.awaiting || 0);
    writeStat("stat-draft", d.draft || 0);
    writeStat("stat-sent", d.sent || 0);
    writeStat("stat-review", d.review || 0);
    writeStat("stat-completed", d.completed || 0);
    writeStat("stat-dismissed", d.dismissed || 0);
  }

  function paintQuoteChange(item) {
    if (periodFilter !== "all" && periodCatalog) {
      const inWindow = periodCatalog.filter((row) =>
        inPeriod(row, periodBounds(periodFilter)));
      applyCounts(countsFromItems(inWindow));
      const visible = filterInboxPage(inWindow, filterStatus);
      inboxItems = visible;
      inboxHasMore = false;
      const panel = tabPanelEl(filterStatus);
      if (!visible.length) {
        panel.innerHTML = '<div class="empty">No quotes in this period.</div>';
      } else {
        panel.innerHTML = visible.map(quoteCardHtml).join("");
        bindInboxCardEvents(panel);
      }
      showActiveTabPanel();
      syncLoadMoreButton();
      return;
    }
    applyItemAcrossTabs(item);
  }

  function revertQuoteChange(item, snap, counts) {
    if (item && snap) applyQuoteSnap(item, snap);
    if (periodFilter === "all") restoreCountSnap(counts);
    if (item) paintQuoteChange(item);
  }

  function applyItemAcrossTabs(item) {
    const id = String(item.id);
    Object.keys(inboxTabs).forEach((key) => {
      const tab = inboxTabs[key];
      if (!tab.loaded) return;
      const idx = tab.items.findIndex((i) => String(i.id) === id);
      const matches = itemMatchesTab(item, key);
      const panel = tabPanelEl(key);
      if (idx >= 0) tab.items[idx] = item;
      if (matches && idx < 0) {
        tab.items.unshift(item);
        if (!panel.querySelector(".quote-card")) {
          panel.innerHTML = "";
        }
        const holder = document.createElement("div");
        holder.innerHTML = quoteCardHtml(item);
        bindInboxCardEvents(holder);
        if (holder.firstChild) {
          panel.insertBefore(holder.firstChild, panel.firstChild);
        }
      } else if (matches) {
        const card = findCardEl(panel, id);
        if (card) patchQuoteCard(card, item);
      } else if (idx >= 0) {
        tab.items.splice(idx, 1);
        const card = findCardEl(panel, id);
        if (card) card.remove();
        if (!panel.querySelector(".quote-card")) {
          panel.innerHTML =
            '<div class="empty">No quotes assigned to you.</div>';
        }
      }
      saveTabCache(key);
    });
    syncActiveTabGlobals();
    syncLoadMoreButton();
  }

  function invalidateInactiveTabs(keepKeys) {
    const keep = {};
    (Array.isArray(keepKeys) ? keepKeys : [keepKeys]).forEach((key) => {
      if (key != null) keep[key] = true;
    });
    Object.keys(inboxTabs).forEach((key) => {
      if (keep[key]) return;
      delete inboxTabs[key];
      const rows = document.getElementById("rows");
      const panels = rows.querySelectorAll(".inbox-tab");
      for (let i = 0; i < panels.length; i++) {
        if (panels[i].getAttribute("data-tab") === key) panels[i].remove();
      }
    });
  }

  function createdAtMs(item) {
    const v = item && item.createdAt;
    if (v == null || v === "") return 0;
    if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
    if (typeof v === "string") {
      const t = Date.parse(v);
      return isFinite(t) ? t : 0;
    }
    if (typeof v === "object") {
      const sec = v.seconds != null ? v.seconds : v._seconds;
      if (sec != null && sec !== "") {
        const nano = Number(v.nanoseconds != null ? v.nanoseconds : v._nanoseconds) || 0;
        return Number(sec) * 1000 + Math.floor(nano / 1e6);
      }
    }
    return 0;
  }

  function nyWallParts(date) {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    const out = {};
    fmt.formatToParts(date).forEach((p) => {
      if (p.type !== "literal") out[p.type] = p.value;
    });
    let hour = Number(out.hour);
    if (hour === 24) hour = 0;
    return {
      y: Number(out.year),
      m: Number(out.month),
      d: Number(out.day),
      hour: hour,
      weekday: out.weekday,
    };
  }

  function addCalDays(y, m, d, n) {
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return {y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate()};
  }

  function nyMidnightMs(y, m, d) {
    const hours = [4, 5];
    for (let i = 0; i < hours.length; i++) {
      const ms = Date.UTC(y, m - 1, d, hours[i], 0, 0);
      const wall = nyWallParts(new Date(ms));
      if (wall.y === y && wall.m === m && wall.d === d && wall.hour === 0) {
        return ms;
      }
    }
    return Date.UTC(y, m - 1, d, 5, 0, 0);
  }

  function periodBounds(period, now) {
    if (!period || period === "all") return null;
    const wall = nyWallParts(now || new Date());
    let start = {y: wall.y, m: wall.m, d: wall.d};
    let end;
    if (period === "day") {
      end = addCalDays(start.y, start.m, start.d, 1);
    } else if (period === "week") {
      const dow = {Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6};
      const back = ((dow[wall.weekday] || 0) + 6) % 7;
      start = addCalDays(wall.y, wall.m, wall.d, -back);
      end = addCalDays(start.y, start.m, start.d, 7);
    } else if (period === "month") {
      start = {y: wall.y, m: wall.m, d: 1};
      end = wall.m === 12 ?
        {y: wall.y + 1, m: 1, d: 1} :
        {y: wall.y, m: wall.m + 1, d: 1};
    } else if (period === "year") {
      start = {y: wall.y, m: 1, d: 1};
      end = {y: wall.y + 1, m: 1, d: 1};
    } else {
      return null;
    }
    return {
      startMs: nyMidnightMs(start.y, start.m, start.d),
      endMs: nyMidnightMs(end.y, end.m, end.d),
    };
  }

  function inPeriod(item, bounds) {
    if (!bounds) return true;
    const ms = createdAtMs(item);
    if (!ms) return false;
    return ms >= bounds.startMs && ms < bounds.endMs;
  }

  function countsFromItems(items) {
    const c = {
      total: 0, pending: 0, awaiting: 0, draftReady: 0,
      sent: 0, forReview: 0, dismissed: 0, completed: 0,
    };
    (items || []).forEach((item) => {
      c.total += 1;
      if (isDismissedItem(item)) {
        c.dismissed += 1;
        return;
      }
      if (isCompletedItem(item)) {
        c.completed += 1;
        return;
      }
      if (isForReviewItem(item)) c.forReview += 1;
      const status = quoteStatusOf(item);
      if (status === "awaiting_dispatcher") {
        c.awaiting += 1;
        c.pending += 1;
      } else if (status === "draft_ready") {
        c.draftReady += 1;
        c.pending += 1;
      } else if (status === "sent") {
        c.sent += 1;
      }
    });
    return c;
  }

  function syncPeriodButtons() {
    const map = {
      day: "period-day",
      week: "period-week",
      month: "period-month",
      year: "period-year",
      all: "period-all",
    };
    Object.keys(map).forEach((key) => {
      const el = document.getElementById(map[key]);
      if (!el) return;
      el.classList.toggle("active", periodFilter === key);
    });
  }

  async function fetchInboxStatus(status) {
    const items = [];
    let offset = 0;
    for (let guard = 0; guard < 40; guard++) {
      let path = "/getQuoteDispatcherInbox?" + QD.tenantQS +
        "&limit=100&offset=" + offset + "&syncOutlook=0";
      if (status) path += "&status=" + encodeURIComponent(status);
      const res = await apiFetch(path);
      if (!res.ok) throw new Error(res.error || "Inbox failed");
      const raw = res.items || [];
      raw.forEach((item) => items.push(item));
      if (!res.hasMore || !raw.length) break;
      offset += raw.length;
    }
    return items;
  }

  async function ensurePeriodCatalog() {
    if (periodCatalog) return periodCatalog;
    const groups = await Promise.all([
      fetchInboxStatus(""),
      fetchInboxStatus("completed"),
      fetchInboxStatus("dismissed"),
    ]);
    const seen = new Set();
    const items = [];
    groups.forEach((list) => {
      list.forEach((item) => {
        const id = String(item && item.id || "");
        if (!id || seen.has(id)) return;
        seen.add(id);
        items.push(item);
      });
    });
    periodCatalog = items;
    return items;
  }

  async function renderPeriodInbox() {
    const requestPeriod = periodFilter;
    const requestStatus = filterStatus;
    syncPeriodButtons();
    syncFilterButtons();
    if (requestPeriod === "all") return;
    showInboxThinking(true);
    setFilterBarBusy(true);
    try {
      const catalog = await ensurePeriodCatalog();
      if (periodFilter !== requestPeriod || filterStatus !== requestStatus) return;
      const inWindow = catalog.filter((item) =>
        inPeriod(item, periodBounds(requestPeriod)));
      applyCounts(countsFromItems(inWindow));
      const visible = filterInboxPage(inWindow, requestStatus);
      inboxItems = visible;
      inboxHasMore = false;
      const panel = tabPanelEl(requestStatus);
      if (!visible.length) {
        panel.innerHTML = '<div class="empty">No quotes in this period.</div>';
      } else {
        panel.innerHTML = visible.map(quoteCardHtml).join("");
        bindInboxCardEvents(panel);
      }
      const rows = document.getElementById("rows");
      if (rows) rows.classList.remove("hidden");
      showActiveTabPanel();
    } catch (err) {
      const panel = tabPanelEl(requestStatus);
      panel.innerHTML = '<div class="empty">' +
        esc(err.message || "Could not filter quotes") + "</div>";
    } finally {
      if (periodFilter === requestPeriod) {
        showInboxThinking(false);
        setFilterBarBusy(false);
        syncLoadMoreButton();
      }
    }
  }

  function showAllPeriod() {
    syncPeriodButtons();
    if (serverCounts) applyCounts(serverCounts);
    const tab = ensureTabRecord(filterStatus);
    inboxItems = tab.items || [];
    inboxHasMore = !!tab.hasMore;
    if (tab.loaded) {
      renderInboxCards(tab.items, {tab: filterStatus});
      showActiveTabPanel();
      const rows = document.getElementById("rows");
      if (rows) rows.classList.remove("hidden");
      syncLoadMoreButton();
      return;
    }
    loadInbox({sync: false, keepChrome: true});
  }

  function setPeriod(period) {
    if (period === periodFilter) return;
    periodFilter = period;
    syncPeriodButtons();
    if (period === "all") {
      showAllPeriod();
      return;
    }
    renderPeriodInbox();
  }

  function switchInboxTab(status) {
    if (periodFilter !== "all") {
      filterStatus = status;
      syncFilterButtons();
      renderPeriodInbox();
      return;
    }
    const tab = ensureTabRecord(status);
    if (status === filterStatus && (tab.loaded || inboxLoadInFlight)) return;
    filterStatus = status;
    syncFilterButtons();
    if (tab.loaded) {
      syncActiveTabGlobals();
      showActiveTabPanel();
      const rows = document.getElementById("rows");
      if (rows) rows.classList.remove("hidden");
      showInboxThinking(false);
      syncLoadMoreButton();
      return;
    }
    // Instant paint from session cache, then refresh silently.
    const cached = QD.ssGet(inboxCacheKey(status), INBOX_CACHE_TTL);
    if (cached && Array.isArray(cached.items)) {
      hydrateTabFromCache(status, cached);
      loadInbox({sync: false, silent: true});
      return;
    }
    showInboxThinking(false);
    showActiveTabPanel();
    const panel = tabPanelEl(status);
    panel.innerHTML = '<div class="empty">Loading…</div>';
    loadInbox({sync: false, keepChrome: true});
  }

  function hydrateTabFromCache(tabKey, cached) {
    const tab = ensureTabRecord(tabKey);
    tab.items = cached.items || [];
    tab.offset = Number(cached.offset) || tab.items.length;
    tab.hasMore = !!cached.hasMore;
    tab.loaded = true;
    if (cached.counts) {
      serverCounts = cached.counts;
      applyCounts(cached.counts);
    }
    if (filterStatus === tabKey) {
      syncActiveTabGlobals();
      renderInboxCards(tab.items, {tab: tabKey});
      showActiveTabPanel();
      showInboxThinking(false);
      syncLoadMoreButton();
    }
  }

  function bindInboxCardEvents(root) {
    root.querySelectorAll(".quote-card-head").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest(".btn-dismiss-card")) return;
        if (e.target.closest(".btn-review-card")) return;
        if (e.target.closest(".btn-complete-card")) return;
        if (e.target.closest(".btn-open-quote")) return;
        el.parentElement.classList.toggle("open");
      });
      // Prefetch detail data the moment the user shows interest.
      el.addEventListener("pointerenter", () => {
        const card = el.closest(".quote-card");
        if (card) prefetchQuote(card.getAttribute("data-id"));
      }, {once: true});
    });
    root.querySelectorAll(".btn-open-quote").forEach((a) => {
      a.addEventListener("pointerenter", () => {
        prefetchQuote(a.getAttribute("data-id"));
      }, {once: true});
    });
    root.querySelectorAll(".btn-complete-card").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const quoteId = btn.getAttribute("data-id") || btn.dataset.id;
        const item = findInboxItem(quoteId);
        if (item && item._quoteAction) return;
        const currentlyDone = btn.getAttribute("data-completed") === "1";
        const snap = item ? quoteSnap(item) : null;
        const counts = countSnap();
        if (item) {
          item._quoteAction = true;
          const prevStatus = quoteStatusOf(item);
          const wasReview = isForReviewItem(item);
          if (!currentlyDone) {
            item.statusBeforeCompleted = prevStatus;
            item.status = "completed";
            item.completedAt = true;
            item.forReview = false;
            if (periodFilter === "all") {
              applyLocalCompleteStats(prevStatus, true, wasReview);
            }
          } else {
            const restored = item.statusBeforeCompleted || "draft_ready";
            item.status = restored;
            item.completedAt = null;
            item.statusBeforeCompleted = null;
            if (periodFilter === "all") {
              applyLocalCompleteStats(restored, false, false);
            }
          }
          paintQuoteChange(item);
        }
        completeQuoteById(quoteId, !currentlyDone).catch((err) => {
          revertQuoteChange(item, snap, counts);
          alert(err.message || "Could not update completed state");
        }).finally(() => {
          if (item) item._quoteAction = false;
        });
      });
    });
    root.querySelectorAll(".btn-review-card").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const quoteId = btn.getAttribute("data-id") || btn.dataset.id;
        const item = findInboxItem(quoteId);
        if (item && item._quoteAction) return;
        const currentlyOn = btn.getAttribute("data-on") === "1";
        const snap = item ? quoteSnap(item) : null;
        const counts = countSnap();
        if (item) {
          item._quoteAction = true;
          item.forReview = !currentlyOn;
          if (periodFilter === "all") {
            bumpStat("stat-review", currentlyOn ? -1 : 1);
          }
          paintQuoteChange(item);
        }
        markQuoteForReview(quoteId, !currentlyOn).catch((err) => {
          revertQuoteChange(item, snap, counts);
          alert(err.message || "Could not update review flag");
        }).finally(() => {
          if (item) item._quoteAction = false;
        });
      });
    });
    root.querySelectorAll(".btn-load-more-rates").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const quoteId = btn.getAttribute("data-quote-id") || "";
        const laneKey = btn.getAttribute("data-lane-key") || "";
        const item = inboxItems.find((i) => String(i.id) === quoteId);
        const lane = ((item && item.lanesPreview) || []).find((l) =>
          String(l.laneKey || "") === laneKey);
        const all = laneRateOptions(lane || {});
        let shown = Number(btn.getAttribute("data-shown")) || 0;
        const next = all.slice(shown, shown + RATE_PAGE_SIZE);
        if (!next.length) {
          btn.remove();
          return;
        }
        btn.insertAdjacentHTML("beforebegin", next.map(rateLineHtml).join(""));
        shown += next.length;
        btn.setAttribute("data-shown", String(shown));
        if (shown >= all.length) btn.remove();
      });
    });
    root.querySelectorAll(".btn-dismiss-card").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (btn.getAttribute("data-confirm") !== "1") {
          btn.setAttribute("data-confirm", "1");
          btn.textContent = "Confirm?";
          setTimeout(() => {
            if (btn.getAttribute("data-confirm") === "1") {
              btn.removeAttribute("data-confirm");
              btn.textContent = "Dismiss";
            }
          }, 4000);
          return;
        }
        const quoteId = btn.getAttribute("data-id") || btn.dataset.id;
        const card = btn.closest(".quote-card");
        const item = findInboxItem(quoteId);
        if (item && item._quoteAction) return;
        const status = item ? quoteStatusOf(item) :
          ((card && card.getAttribute("data-status")) || "");
        const wasReview = item ? isForReviewItem(item) :
          (card && card.getAttribute("data-for-review") === "1");
        const snap = item ? quoteSnap(item) : null;
        const counts = countSnap();
        if (item) {
          item._quoteAction = true;
          item.status = "dismissed";
          item.dismissedAt = true;
          item.forReview = false;
          item.completedAt = null;
          if (periodFilter === "all") {
            applyLocalDismissStats(status);
            if (wasReview) bumpStat("stat-review", -1);
          }
          paintQuoteChange(item);
        } else if (card) {
          card.remove();
        }
        dismissQuoteById(quoteId).catch((err) => {
          revertQuoteChange(item, snap, counts);
          alert(err.message || "Dismiss failed");
        }).finally(() => {
          if (item) item._quoteAction = false;
        });
      });
    });
  }

  function laneRateOptions(lane) {
    if (lane && Array.isArray(lane.options) && lane.options.length) {
      return lane.options;
    }
    return (lane && lane.topOptions) || [];
  }

  function rateLineHtml(o) {
    return '<div class="rate-line"><span class="sell">$' +
      num(o.sellRate != null ? o.sellRate : o.cost) + "</span> · " +
      esc(o.name || o.SCAC || "Carrier") +
      (o.transitDays ? " · " + o.transitDays + " days" : "") +
      "</div>";
  }

  function quoteCardHtml(item) {
    const pending = isPendingItem(item);
    const forReview = isForReviewItem(item);
    const completed = isCompletedItem(item);
    const status = quoteStatusOf(item);
    const lanes = item.lanesPreview || [];
    const lanesHtml = lanes.map((lane) => {
      const allRates = laneRateOptions(lane);
      const shownRates = allRates.slice(0, RATE_PAGE_SIZE);
      const opts = shownRates.map(rateLineHtml).join("");
      const more = allRates.length > shownRates.length ?
        '<button type="button" class="ghost btn-load-more-rates" data-quote-id="' +
          esc(item.id) + '" data-lane-key="' + esc(lane.laneKey || "") +
          '" data-shown="' + shownRates.length +
          '">Load more rates</button>' : "";
      const acc = (lane.accessorials || []).length ?
        '<div class="more-rates">Accessorials: ' +
          esc((lane.appliedRules || []).map((r) => r.name).join(", ") ||
            lane.accessorials.join(", ")) + "</div>" : "";
      return '<div class="lane-preview"><h4>' +
        esc(lane.label || lane.laneKey) + "</h4>" +
        (opts || '<div class="rate-line">No rates</div>') +
        more + acc + "</div>";
    }).join("");

    const matched = !!item.customerMatched;
    const custName = item.shippingLocationName || "";
    const custId = item.shippingLocationId || "";
    const custHtml = matched && (custName || custId) ?
      '<div class="quote-card-customer">' +
        esc(custName || "Primus customer") +
        (custId ? " · ID " + esc(String(custId)) : "") +
      "</div>" :
      '<div class="quote-card-customer nomatch">No Primus match</div>';
    const warnBits = [];
    function pushWarn(raw) {
      const t = String(raw || "").trim();
      if (!t) return;
      let label = t;
      if (/FAK markup/i.test(t) || t === "market fallback + FAK") {
        label = "market fallback + FAK";
      } else if (/showing market rates/i.test(t) ||
          t === "market fallback") {
        label = "market fallback";
      } else if (t.length > 90) {
        label = t.slice(0, 87) + "…";
      }
      if (warnBits.indexOf(label) < 0) warnBits.push(label);
    }
    if (item.rateSource === "market_fallback" ||
        item.rateSource === "market_fallback_fak") {
      pushWarn(item.rateSource === "market_fallback_fak" ?
        "market fallback + FAK" : "market fallback");
    } else if (item.rateSource === "customer") {
      pushWarn("customer rates");
    }
    (item.extractionWarnings || []).forEach(pushWarn);
    (lanes || []).forEach((lane) => {
      if (lane.rateWarning) pushWarn(lane.rateWarning);
      if (lane.rateSource === "market_fallback" ||
            lane.rateSource === "market_fallback_fak") {
        pushWarn(lane.rateSource === "market_fallback_fak" ?
          "market fallback + FAK" : "market fallback");
      }
    });
    const warnHtml = warnBits.length ?
      '<div class="quote-card-warn">' +
        esc(warnBits.join(" · ")) + "</div>" : "";

    const badgeClass = completed ? "completed" :
      (pending ? "pending" :
        (status === "sent" ? "sent" :
          (status === "draft_ready" ? "draft_ready" : "")));
    const reviewBadge = forReview ?
      '<span class="badge for-review">For review</span>' : "";

    return `<div class="quote-card" data-id="${esc(item.id)}" data-status="${esc(item.status || "")}" data-for-review="${forReview ? "1" : "0"}">
      <div class="quote-card-head">
        <span class="chevron">▶</span>
        <div class="quote-card-main">
          <div class="quote-card-title">${esc(item.batchQuoteId || "—")}</div>
          ${custHtml}
          ${warnHtml}
          <div class="quote-card-sub">${esc(item.from || "")}<br>${esc(item.subject || "")}<br>${item.laneCount || 0} lane(s)</div>
        </div>
        <div class="quote-card-badges">
          <span class="badge ${badgeClass}">${esc(item.status || "")}</span>
          ${reviewBadge}
        </div>
        <div class="quote-card-actions">
          <a class="btn btn-open-quote" data-id="${esc(item.id)}" href="${esc(quoteOpenUrl(item))}">Open full review</a>
          <button type="button" class="ghost btn-complete-card" data-id="${esc(item.id)}" data-completed="${completed ? "1" : "0"}">${completed ? "Undo complete" : "Complete"}</button>
          <button type="button" class="ghost btn-review-card${forReview ? " is-on" : ""}" data-id="${esc(item.id)}" data-on="${forReview ? "1" : "0"}"${completed ? " disabled" : ""}>${forReview ? "Unmark review" : "For review"}</button>
          <button type="button" class="ghost btn-dismiss-card" data-id="${esc(item.id)}"${completed ? " disabled" : ""}>Dismiss</button>
        </div>
      </div>
      <div class="quote-card-body">
        ${lanesHtml || '<div class="empty" style="padding:12px">No lane preview</div>'}
      </div>
    </div>`;
  }

  function renderInboxCards(items, opts) {
    const append = !!(opts && opts.append);
    const fresh = (opts && opts.fresh) || [];
    const tabKey = opts && opts.tab != null ? opts.tab : filterStatus;
    const panel = tabPanelEl(tabKey);
    if (!append) {
      if (!items.length) {
        panel.innerHTML = '<div class="empty">No quotes assigned to you.</div>';
      } else {
        panel.innerHTML = items.map(quoteCardHtml).join("");
        bindInboxCardEvents(panel);
      }
    } else if (fresh.length) {
      const empty = panel.querySelector(".empty");
      if (empty && !panel.querySelector(".quote-card")) empty.remove();
      const holder = document.createElement("div");
      holder.innerHTML = fresh.map(quoteCardHtml).join("");
      bindInboxCardEvents(holder);
      while (holder.firstChild) panel.appendChild(holder.firstChild);
    }
    if (tabKey === filterStatus) showActiveTabPanel();
    syncLoadMoreButton();
  }

  async function loadInbox(opts) {
    const sync = !!(opts && opts.sync);
    const silent = !!(opts && opts.silent);
    const append = !!(opts && opts.append);
    const keepChrome = !!(opts && opts.keepChrome);
    const requestFilter = filterStatus;
    if (inboxLoadInFlight) {
      try {
        await inboxLoadInFlight;
      } catch (_) { /* prior load failed */ }
      // Quiet background refresh can skip; Load more must still run.
      if (silent && !append) return;
    }
    const tab = ensureTabRecord(requestFilter);
    const requestOffset = append ? tab.offset : 0;
    let path = "/getQuoteDispatcherInbox?" + QD.tenantQS +
      "&limit=" + INBOX_PAGE_SIZE +
      "&offset=" + requestOffset +
      "&syncOutlook=" + (sync ? "1" : "0");
    if (requestFilter === "pending") path += "&status=pending";
    else if (requestFilter === "sent") path += "&status=sent";
    else if (requestFilter === "for_review") path += "&status=for_review";
    else if (requestFilter === "completed") path += "&status=completed";
    const stillActive = () => filterStatus === requestFilter;
    if (stillActive()) syncFilterButtons();
    if (!silent && !append && !keepChrome && stillActive()) {
      showInboxThinking(true);
      setFilterBarBusy(true);
    }
    if (append && stillActive()) {
      loadMoreInFlight = true;
      syncLoadMoreButton();
    }
    inboxLoadInFlight = (async () => {
      let fresh = [];
      try {
        const res = await apiFetch(path);
        const panel = tabPanelEl(requestFilter);
        if (!res.ok) {
          if (!append) {
            tab.items = [];
            tab.offset = 0;
            tab.hasMore = false;
            tab.loaded = true;
            panel.innerHTML = '<div class="empty">' + esc(res.error) + "</div>";
            if (stillActive()) {
              syncActiveTabGlobals();
              showActiveTabPanel();
              syncLoadMoreButton();
            }
          }
          return;
        }
        const raw = res.items || [];
        const counts = res.counts || {};
        serverCounts = counts;
        if (periodFilter === "all" && stillActive()) applyCounts(counts);
        else lastCounts = counts;
        const pageItems = filterInboxPage(raw, requestFilter);
        let added = pageItems.length;
        if (append) {
          const seen = new Set(tab.items.map((i) => String(i.id)));
          fresh = pageItems.filter((i) => !seen.has(String(i.id)));
          added = fresh.length;
          tab.items = tab.items.concat(fresh);
        } else {
          tab.items = pageItems;
          fresh = pageItems;
        }
        tab.offset = Number(res.offset) >= 0 ?
          Number(res.offset) + raw.length :
          tab.items.length;
        const tabTotal = inboxTabTotal(counts, requestFilter);
        if (append && !added) {
          tab.hasMore = false;
        } else {
          tab.hasMore = !!res.hasMore || tabTotal > tab.items.length;
        }
        tab.loaded = true;
        if (stillActive()) syncActiveTabGlobals();
        if (periodFilter === "all") {
          renderInboxCards(tab.items, {
            append: append,
            fresh: fresh,
            tab: requestFilter,
          });
        }
        saveTabCache(requestFilter);
        if (sync) {
          periodCatalog = null;
          invalidateInactiveTabs([requestFilter, filterStatus]);
          if (periodFilter !== "all" && stillActive()) renderPeriodInbox();
        }
      } finally {
        if (append && stillActive()) loadMoreInFlight = false;
        if (!silent && !append && !keepChrome && stillActive()) {
          showInboxThinking(false);
          setFilterBarBusy(false);
        }
        if (stillActive()) syncLoadMoreButton();
      }
    })();
    try {
      await inboxLoadInFlight;
    } finally {
      inboxLoadInFlight = null;
      if (filterStatus === requestFilter) syncLoadMoreButton();
    }
  }

  function lastSyncAt() {
    const n = Number(sessionStorage.getItem(SYNC_KEY) || 0);
    return isFinite(n) ? n : 0;
  }

  function markSynced() {
    try {
      sessionStorage.setItem(SYNC_KEY, String(Date.now()));
    } catch (_) { /* ignore */ }
  }

  /**
   * Opt-in Outlook sync. Does not block initial paint.
   * When done, quietly reloads the Firestore inbox list.
   * @param {object} [opts] force=true bypasses throttle.
   * @return {Promise<void>}
   */
  function syncOutlookInBackground(opts) {
    const force = !!(opts && opts.force);
    if (!outlookConnected) return Promise.resolve();
    if (syncInFlight) return syncInFlight;
    if (!force && (Date.now() - lastSyncAt()) < SYNC_THROTTLE_MS) {
      return Promise.resolve();
    }
    syncInFlight = (async () => {
      try {
        await loadInbox({sync: true, silent: true});
        markSynced();
      } catch (_) {
        // Non-fatal: scheduler still syncs every 20 min.
      } finally {
        syncInFlight = null;
      }
    })();
    return syncInFlight;
  }

  function maybeDeferredSync() {
    if (!outlookConnected) return;
    // Let the Firestore list paint first, then soft-sync if stale.
    setTimeout(() => {
      syncOutlookInBackground({force: false});
    }, 0);
  }

  function showApp(show) {
    document.getElementById("login-screen").classList.toggle("hidden", show);
    document.getElementById("app").classList.toggle("hidden", !show);
    if (!show) showInboxThinking(false);
  }

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    document.getElementById("login-error").textContent = "";
    document.getElementById("login-success").classList.add("hidden");
    const submitBtn = e.target.querySelector(".btn-login") ||
      document.querySelector("#login-form .btn-login");
    const prevLabel = submitBtn ? submitBtn.textContent : "Sign in";
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Signing in…";
    }
    try {
      await QuoteAuth.signInWithEmailPassword(
          document.getElementById("login-email").value,
          document.getElementById("login-password").value);
    } catch (err) {
      document.getElementById("login-error").textContent =
        err.message || "Sign-in failed";
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = prevLabel;
      }
    }
  });

  document.getElementById("btn-forgot").addEventListener("click", async () => {
    document.getElementById("login-error").textContent = "";
    document.getElementById("login-success").classList.add("hidden");
    const email = document.getElementById("login-email").value;
    if (!email) {
      document.getElementById("login-error").textContent =
        "Enter your email above, then click Forgot password.";
      document.getElementById("login-email").focus();
      return;
    }
    try {
      const res = await apiFetch("/sendQuotePasswordReset?" + QD.tenantQS, {
        method: "POST",
        body: JSON.stringify({email: email}),
      });
      if (!res.ok) throw new Error(res.error || "Could not send reset email");
      document.getElementById("login-success").textContent =
        res.message ||
        "If that email is on the quote roster, a reset link was sent.";
      document.getElementById("login-success").classList.remove("hidden");
    } catch (err) {
      document.getElementById("login-error").textContent =
        err.message || "Could not send reset email";
    }
  });

  document.getElementById("btn-signout").addEventListener("click", () => {
    try {
      sessionStorage.clear();
    } catch (_) { /* ignore */ }
    QuoteAuth.signOut();
  });
  document.getElementById("btn-outlook-connect").addEventListener("click", async () => {
    const btn = document.getElementById("btn-outlook-connect");
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Opening…";
    try {
      const res = await apiFetch("/getQuoteOutlookConnectUrl?" + QD.tenantQS);
      if (!res.ok) throw new Error(res.error || "Connect failed");
      window.open(res.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      alert(err.message || "Could not start Outlook connect");
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  });
  document.getElementById("btn-outlook-disconnect").addEventListener("click", async () => {
    if (!confirm("Disconnect Outlook from this dashboard?")) return;
    const btn = document.getElementById("btn-outlook-disconnect");
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Disconnecting…";
    try {
      const res = await apiFetch("/quoteOutlookDisconnect?" + QD.tenantQS,
          {method: "POST"});
      if (!res.ok) throw new Error(res.error || "Disconnect failed");
      await loadProfile();
    } catch (err) {
      alert(err.message || "Could not disconnect Outlook");
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  });
  document.getElementById("filter-pending").addEventListener("click", () => {
    switchInboxTab("pending");
  });
  document.getElementById("filter-sent").addEventListener("click", () => {
    switchInboxTab("sent");
  });
  document.getElementById("filter-review").addEventListener("click", () => {
    switchInboxTab("for_review");
  });
  document.getElementById("filter-completed").addEventListener("click", () => {
    switchInboxTab("completed");
  });
  document.getElementById("filter-all").addEventListener("click", () => {
    switchInboxTab("");
  });
  document.getElementById("period-day").addEventListener("click", () => {
    setPeriod("day");
  });
  document.getElementById("period-week").addEventListener("click", () => {
    setPeriod("week");
  });
  document.getElementById("period-month").addEventListener("click", () => {
    setPeriod("month");
  });
  document.getElementById("period-year").addEventListener("click", () => {
    setPeriod("year");
  });
  document.getElementById("period-all").addEventListener("click", () => {
    setPeriod("all");
  });
  document.getElementById("btn-load-more").addEventListener("click", () => {
    if (!inboxHasMore || loadMoreInFlight || inboxLoadInFlight) return;
    loadInbox({sync: false, append: true, silent: true});
  });
  document.getElementById("btn-report-pull").addEventListener("click", async () => {
    const btn = document.getElementById("btn-report-pull");
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = "Preparing…";
    try {
      await downloadReportCsv();
    } catch (err) {
      alert(err.message || "Report failed");
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  });
  document.getElementById("btn-rules").addEventListener("click", () => {
    window.location.href = QD.pageUrl("admin.html");
  });

  // ——— Bulk rate shop ———
  let bulkJobId = null;
  let bulkRunning = false;

  function setBulkModalOpen(open) {
    const modal = document.getElementById("bulk-modal");
    if (!modal) return;
    modal.classList.toggle("hidden", !open);
  }

  function setBulkMsg(text, kind) {
    const el = document.getElementById("bulk-msg");
    if (!el) return;
    if (!text) {
      el.className = "bulk-msg hidden";
      el.textContent = "";
      return;
    }
    el.className = "bulk-msg " + (kind || "");
    el.textContent = text;
  }

  function setBulkProgress(processed, total, status) {
    const wrap = document.getElementById("bulk-progress");
    const text = document.getElementById("bulk-progress-text");
    const bar = document.getElementById("bulk-progress-bar");
    if (!wrap || !text || !bar) return;
    wrap.classList.remove("hidden");
    const t = Math.max(0, Number(total) || 0);
    const p = Math.max(0, Number(processed) || 0);
    const pct = t ? Math.min(100, Math.round((p / t) * 100)) : 0;
    text.textContent = (status || "Processing") + ": " + p + " / " + t +
      " lanes (" + pct + "%)";
    bar.style.width = pct + "%";
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(new Error("Could not read file"));
      reader.readAsDataURL(file);
    });
  }

  function selectedAccessorials() {
    const root = document.getElementById("bulk-accessorials");
    if (!root) return [];
    return Array.from(root.querySelectorAll("input[type='checkbox']:checked"))
        .map((el) => String(el.value || "").trim())
        .filter(Boolean);
  }

  function updateAccessorialCount() {
    const el = document.getElementById("bulk-acc-count");
    if (!el) return;
    const n = selectedAccessorials().length;
    el.textContent = n ? (n + " selected") : "none selected";
    el.classList.toggle("is-on", n > 0);
  }

  function fillAccessorialSelect(catalog) {
    const root = document.getElementById("bulk-accessorials");
    if (!root) return;
    const kept = new Set(selectedAccessorials());
    const sections = [
      {key: "destination", label: "Destination"},
      {key: "origin", label: "Origin"},
      {key: "other", label: "Other"},
    ];
    root.innerHTML = "";
    let any = false;
    for (const sec of sections) {
      const items = (catalog && catalog[sec.key]) || [];
      if (!items.length) continue;
      const sorted = items.slice().sort((a, b) => {
        const ac = String(a.code || "");
        const bc = String(b.code || "");
        if (ac === "APD") return -1;
        if (bc === "APD") return 1;
        return String(a.label || ac).localeCompare(String(b.label || bc));
      });
      const usable = sorted.filter((item) => {
        if (item.selectable === false) return false;
        return !!String(item.code || "").trim();
      });
      if (!usable.length) continue;
      any = true;
      const group = document.createElement("div");
      group.className = "bulk-acc-group";
      const title = document.createElement("h4");
      title.textContent = sec.label;
      group.appendChild(title);
      const grid = document.createElement("div");
      grid.className = "bulk-acc-grid";
      for (const item of usable) {
        const code = String(item.code || "").trim();
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = code;
        if (kept.has(code)) input.checked = true;
        const text = document.createElement("span");
        text.textContent = (item.label || code) + " (" + code + ")";
        label.appendChild(input);
        label.appendChild(text);
        grid.appendChild(label);
      }
      group.appendChild(grid);
      root.appendChild(group);
    }
    if (!any) {
      const empty = document.createElement("p");
      empty.className = "bulk-acc-empty";
      empty.textContent = "No accessorials available";
      root.appendChild(empty);
    }
    updateAccessorialCount();
  }

  async function loadBulkAccessorialCatalog() {
    // Cached catalog paints instantly; a fresh copy is fetched quietly.
    const cached = QD.lsGet(CATALOG_KEY, CATALOG_TTL);
    if (cached) fillAccessorialSelect(cached);
    try {
      const res = await apiFetch("/getQuoteAccessorialCatalog?" + QD.tenantQS);
      if (res && (res.origin || res.destination || res.other)) {
        QD.lsSet(CATALOG_KEY, res);
        fillAccessorialSelect(res);
        return;
      }
    } catch (_) { /* fallback below */ }
    if (cached) return;
    fillAccessorialSelect({
      origin: [
        {label: "Liftgate at Origin", code: "LFO", selectable: true},
        {label: "Residential Pickup", code: "RSO", selectable: true},
      ],
      destination: [
        {label: "Appointment at Destination", code: "APD", selectable: true},
        {label: "Liftgate at Destination", code: "LFD", selectable: true},
        {label: "Limited Access Delivery", code: "LAD", selectable: true},
        {label: "Residential Delivery", code: "RSD", selectable: true},
      ],
      other: [],
    });
  }

  async function downloadBulkResults(format) {
    if (!bulkJobId) return;
    const path = "/downloadBulkRateShopResults?" + QD.tenantQS +
      "&jobId=" + encodeURIComponent(bulkJobId) +
      "&format=" + encodeURIComponent(format || "xlsx");
    const blob = await QD.apiBlob(path);
    QD.downloadBlob(blob,
        "bulk-rates-results." + (format === "csv" ? "csv" : "xlsx"));
  }

  function showBulkDownload(show) {
    document.getElementById("btn-bulk-download")
        .classList.toggle("hidden", !show);
    document.getElementById("btn-bulk-download-csv")
        .classList.toggle("hidden", !show);
  }

  async function runBulkJob(jobId) {
    bulkJobId = jobId;
    bulkRunning = true;
    const startBtn = document.getElementById("btn-bulk-start");
    startBtn.disabled = true;
    showBulkDownload(false);
    setBulkMsg("");
    try {
      let status = await apiFetch(
          "/getBulkRateShopJob?" + QD.tenantQS +
          "&jobId=" + encodeURIComponent(jobId));
      if (!status.ok) throw new Error(status.error || "Job status failed");
      setBulkProgress(status.processedRows, status.totalRows, status.status);

      while (status.status !== "completed" && status.status !== "failed") {
        const chunk = await apiFetch("/processBulkRateShopJob?" + QD.tenantQS, {
          method: "POST",
          body: JSON.stringify({
            tenantId: TENANT_ID,
            jobId: jobId,
            maxRows: 3,
          }),
        });
        if (!chunk.ok) throw new Error(chunk.error || "Processing failed");
        status = chunk;
        setBulkProgress(status.processedRows, status.totalRows, status.status);
        if (status.status === "completed" || status.remaining === 0) break;
      }

      setBulkProgress(status.processedRows, status.totalRows, "completed");
      setBulkMsg(
          "Done — " + (status.successRows || 0) + " rates, " +
          (status.errorRows || 0) + " errors. Download results below.",
          "ok");
      showBulkDownload(true);
    } catch (err) {
      setBulkMsg(err.message || "Bulk rate shop failed", "err");
    } finally {
      bulkRunning = false;
      startBtn.disabled = false;
    }
  }

  document.getElementById("btn-bulk-open").addEventListener("click", () => {
    setBulkModalOpen(true);
  });
  document.getElementById("btn-bulk-close").addEventListener("click", () => {
    setBulkModalOpen(false);
  });
  document.getElementById("btn-bulk-done").addEventListener("click", () => {
    setBulkModalOpen(false);
  });
  document.getElementById("bulk-modal").addEventListener("click", (ev) => {
    if (ev.target && ev.target.id === "bulk-modal") setBulkModalOpen(false);
  });
  document.getElementById("bulk-accessorials").addEventListener("change", () => {
    updateAccessorialCount();
  });

  document.getElementById("btn-bulk-start").addEventListener("click", async () => {
    if (bulkRunning) return;
    setBulkMsg("");
    const fileEl = document.getElementById("bulk-file");
    const file = fileEl && fileEl.files && fileEl.files[0];
    if (!file) {
      setBulkMsg("Choose a CSV or XLSX file first.", "err");
      return;
    }
    const city = document.getElementById("bulk-from-city").value.trim();
    const state = document.getElementById("bulk-from-state").value.trim();
    const zip = document.getElementById("bulk-from-zip").value.trim();
    if (!city || !state || !zip) {
      setBulkMsg("From city, state, and zip are required.", "err");
      setBulkModalOpen(true);
      return;
    }
    const startBtn = document.getElementById("btn-bulk-start");
    startBtn.disabled = true;
    startBtn.textContent = "Uploading…";
    showBulkDownload(false);
    try {
      const fileBase64 = await fileToBase64(file);
      const created = await apiFetch("/createBulkRateShopJob?" + QD.tenantQS, {
        method: "POST",
        body: JSON.stringify({
          tenantId: TENANT_ID,
          fileName: file.name,
          fileBase64,
          origin: {
            street: document.getElementById("bulk-from-street").value.trim(),
            city,
            state,
            zip,
          },
          accessorials: selectedAccessorials(),
          customerId: document.getElementById("bulk-customer-id").value.trim() ||
            null,
          estesStandardOnly:
            document.getElementById("bulk-estes-only").checked,
          includeGuaranteed:
            document.getElementById("bulk-guaranteed").checked,
        }),
      });
      if (!created.ok) throw new Error(created.error || "Upload failed");
      setBulkProgress(0, created.totalRows, "queued");
      startBtn.textContent = "Start bulk rate shop";
      await runBulkJob(created.jobId);
    } catch (err) {
      setBulkMsg(err.message || "Upload failed", "err");
      startBtn.disabled = false;
      startBtn.textContent = "Start bulk rate shop";
    }
  });

  document.getElementById("btn-bulk-download").addEventListener("click", async () => {
    try {
      await downloadBulkResults("xlsx");
    } catch (err) {
      setBulkMsg(err.message || "Download failed", "err");
    }
  });
  document.getElementById("btn-bulk-download-csv").addEventListener("click", async () => {
    try {
      await downloadBulkResults("csv");
    } catch (err) {
      setBulkMsg(err.message || "Download failed", "err");
    }
  });

  // ——— Boot ———
  (async () => {
    try {
      defaultReportDates();
      await QuoteAuth.init();
      QuoteAuth.onAuth(async (user) => {
        if (!user) {
          showApp(false);
          return;
        }
        showApp(true);
        // Instant paint from session cache while fresh data loads.
        const cachedProfile = QD.ssGet(PROFILE_KEY, INBOX_CACHE_TTL);
        const cachedTab = QD.ssGet(inboxCacheKey(filterStatus),
            INBOX_CACHE_TTL);
        const hasCache = !!(cachedTab && Array.isArray(cachedTab.items));
        if (cachedProfile && cachedProfile.dispatcher) {
          applyProfile(cachedProfile);
        }
        if (hasCache) {
          hydrateTabFromCache(filterStatus, cachedTab);
        } else {
          showInboxThinking(true);
        }
        try {
          // Fast path: profile + Firestore inbox in parallel.
          await Promise.all([
            loadProfile(),
            loadInbox({sync: false, silent: hasCache}),
            loadBulkAccessorialCatalog(),
          ]);
          maybeDeferredSync();
        } catch (e) {
          document.getElementById("login-error").textContent = e.message;
          showApp(false);
          await QuoteAuth.signOut();
        }
      });
    } catch (e) {
      document.getElementById("login-error").textContent = e.message;
    }
  })();
})();
