(function () {
  "use strict";

  const client = window.DASHBOARD_CONFIG;
  if (!client || !client.functionsBaseUrl) {
    document.getElementById("dashboardTitle").textContent =
      "Dashboard not configured";
    document.getElementById("dashboardMain").innerHTML =
      '<p class="banner banner-danger">Missing window.DASHBOARD_CONFIG in config.js.</p>';
    return;
  }

  document.title = `${client.name} — Jerry`;

  const BASE_URL = client.functionsBaseUrl;
  const TENANT_ID = client.tenantId || "default";
  const TMS = (client.tms || "primus").toLowerCase();
  const tenantQuery = `tenantId=${encodeURIComponent(TENANT_ID)}`;
  const TASK_PAGE = 50;
  const INVOICE_PAGE_SIZE = 20;
  const HIGH_DOLLAR = 250;

  const CHARGE_LABELS = {
    a: "A — Pay + bill customer (auto-email)",
    b: "B — Pay + bill; dispatcher notifies",
    c: "C — Pay carrier only",
    d: "D — Dispute / not approved",
    e: "E — Pay + bill (no customer email)",
  };

  const OPS_PEOPLE = [
    {key: "leo", name: "Leo", email: "leo@innovativecarriers.com"},
    {key: "jak", name: "Jak", email: "jak@innovativecarriers.com"},
    {key: "tina", name: "Tina", email: "tina@innovativecarriers.com"},
    {key: "jason", name: "Jason", email: "jason@innovativecarriers.com"},
    {key: "alex", name: "Alex", email: "alex@innovativecarriers.com"},
    {key: "jay", name: "Jay", email: "jay@innovativecarriers.com"},
    {key: "karen", name: "Karen", email: "karen@innovativecarriers.com"},
    {key: "barry", name: "Barry", email: "barry@innovativecarriers.com"},
    {key: "leah", name: "Leah", email: "leah@innovativecarriers.com"},
  ];

  const els = {
    tmsBadge: document.getElementById("tmsBadge"),
    tenantLabel: document.getElementById("tenantLabel"),
    taiHintBanner: document.getElementById("taiHintBanner"),
    badge: document.getElementById("gmailStatusBadge"),
    connectedMailbox: document.getElementById("connectedMailboxLabel"),
    connectBtn: document.getElementById("connectGmailBtn"),
    disconnectBtn: document.getElementById("disconnectGmailBtn"),
    runResultBanner: document.getElementById("runResultBanner"),
    rangeBtns: Array.from(document.querySelectorAll(".segmented-btn, .range-btn")),
    statInvoices: document.getElementById("statInvoices"),
    statWorkflows: document.getElementById("statWorkflows"),
    statAddedCharges: document.getElementById("statAddedCharges"),
    statReplied: document.getElementById("statReplied"),
    statForwarded: document.getElementById("statForwarded"),
    errorBanner: document.getElementById("errorBanner"),
    logExportDate: document.getElementById("logExportDate"),
    exportLogsCsvBtn: document.getElementById("exportLogsCsvBtn"),
    chartCanvas: document.getElementById("statsChart"),
    refreshInvoicesBtn: document.getElementById("refreshInvoicesBtn"),
    refreshTasksBtn: document.getElementById("refreshTasksBtn"),
    refreshNotifsBtn: document.getElementById("refreshNotifsBtn"),
    invoicesContainer: document.getElementById("invoicesContainer"),
    invoicesLoadMoreWrap: document.getElementById("invoicesLoadMoreWrap"),
    loadMoreInvoicesBtn: document.getElementById("loadMoreInvoicesBtn"),
    tasksContainer: document.getElementById("tasksContainer"),
    tasksLoadMoreWrap: document.getElementById("tasksLoadMoreWrap"),
    loadMoreTasksBtn: document.getElementById("loadMoreTasksBtn"),
    taskCountBadge: document.getElementById("taskCountBadge"),
    notifCountBadge: document.getElementById("notifCountBadge"),
    notificationsContainer: document.getElementById("notificationsContainer"),
    notifsLoadMoreWrap: document.getElementById("notifsLoadMoreWrap"),
    loadMoreNotifsBtn: document.getElementById("loadMoreNotifsBtn"),
    opsPrimaryHint: document.getElementById("opsPrimaryHint"),
    tabBtns: Array.from(document.querySelectorAll(".workspace-tab, .ops-tab")),
    tabPanelTasks: document.getElementById("tabPanelTasks"),
    tabPanelInvoices: document.getElementById("tabPanelInvoices"),
    tabPanelNotifications: document.getElementById("tabPanelNotifications"),
    dispatcherFolders: document.getElementById("dispatcherFolders"),
    dispatcherFilter: document.getElementById("dispatcherFilter"),
    workspaceSearch: document.getElementById("workspaceSearch"),
    workspaceSort: document.getElementById("workspaceSort"),
    drawer: document.getElementById("detailDrawer"),
    drawerTitle: document.getElementById("drawerTitle"),
    drawerKicker: document.getElementById("drawerKicker"),
    drawerBody: document.getElementById("drawerBody"),
    drawerFooter: document.getElementById("drawerFooter"),
  };

  let chart = null;
  let activeRange = "week";
  let openTaskCount = 0;
  let openNotifCount = 0;
  let connectedMailboxEmail = null;
  let statsTotals = null;
  let invoiceOffset = 0;
  let invoiceHasMore = false;
  let invoiceGroup = "open";
  let statsInFlight = null;
  let activeTab = "tasks";
  let ownerBucket = "accounting";
  let issueFilter = "all";
  let dispatcherQuery = "";
  let chargePhase = null; // null | "dispute"
  let dispatcherKey = null;
  let personKey = "";
  let taskOffset = 0;
  let taskHasMore = false;
  let taskLoadSeq = 0;
  let tasksCache = [];
  let disputeCount = 0;
  let bucketCounts = {accounting: {}, sarah: {}, dispatch: {}};
  let dispatchers = [];
  let notifOffset = 0;
  let notifHasMore = false;
  let notifsCache = [];
  let readNotifIds = new Set(
      JSON.parse(localStorage.getItem("jerryReadNotifs") || "[]"));
  let drawerItem = null;
  let drawerKind = null;

  if (els.tmsBadge) {
    els.tmsBadge.hidden = false;
    els.tmsBadge.textContent = TMS === "tai" ? "TAI TMS" : "Primus TMS";
  }
  if (els.tenantLabel) {
    els.tenantLabel.hidden = false;
    els.tenantLabel.textContent = `Tenant ${TENANT_ID}`;
  }
  if (els.taiHintBanner && TMS === "tai") els.taiHintBanner.hidden = false;

  function setButtonBusy(btn, busy, busyText, idleText) {
    if (!btn) return;
    if (busy) {
      if (!btn.dataset.idleText) {
        btn.dataset.idleText = idleText || btn.textContent;
      }
      btn.disabled = true;
      if (busyText) btn.textContent = busyText;
    } else {
      btn.disabled = false;
      btn.textContent = btn.dataset.idleText || idleText || btn.textContent;
    }
  }

  function setRangeButtonsDisabled(disabled) {
    els.rangeBtns.forEach((btn) => { btn.disabled = disabled; });
  }

  function showRunResult(message, isError) {
    const banner = els.runResultBanner;
    if (!banner) return;
    if (!message) {
      banner.hidden = true;
      banner.textContent = "";
      return;
    }
    banner.hidden = false;
    banner.textContent = message;
    banner.className = isError ? "banner banner-danger" : "banner banner-success";
  }

  function showError(message) {
    if (!els.errorBanner) return;
    if (!message) {
      els.errorBanner.hidden = true;
      els.errorBanner.textContent = "";
      return;
    }
    els.errorBanner.hidden = false;
    els.errorBanner.textContent = message;
  }

  function bodyEsc(text) {
    return String(text == null ? "" : text)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function formatMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return `$${n.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  function receivedInfo(item) {
    if (item && item.receivedAt) {
      const mailbox = item.receivedAtSource !== "logged";
      return {
        text: formatLogTime(item.receivedAt),
        title: mailbox ?
          "Received in the mailbox" :
          "Logged time",
      };
    }
    return {
      text: formatLogTime(item && item.createdAt),
      title: "Logged when Jerry parked this item — mailbox received time unavailable",
    };
  }

  function formatBytes(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "";
    if (n < 1024) return `${Math.round(n)} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function attachmentListHtml(item, source) {
    const list = Array.isArray(item && item.attachments) ? item.attachments : [];
    if (!list.length || !item || !item.id) return "";
    const rows = list.map((att) => {
      const name = att.filename || "Attachment";
      const size = formatBytes(att.size);
      const href = `${BASE_URL}/getDashboardEmailAttachment?${tenantQuery}` +
        `&source=${encodeURIComponent(source)}` +
        `&id=${encodeURIComponent(item.id)}` +
        `&index=${encodeURIComponent(att.index)}`;
      return `<li><a href="${href}" target="_blank" rel="noopener">${bodyEsc(name)}</a>` +
        (size ? `<span class="att-size">${bodyEsc(size)}</span>` : "") +
        `</li>`;
    }).join("");
    return `<div class="email-attachments">` +
      `<p class="email-attachments-label">Attachments</p><ul>${rows}</ul></div>`;
  }

  function formatLogTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  }

  function shortText(value, max) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    if (text.length <= max) return text;
    return text.slice(0, max - 1).trimEnd() + "…";
  }

  function todayEasternIsoDate() {
    return new Date().toLocaleDateString("en-CA", {timeZone: "America/New_York"});
  }

  async function fetchJson(path) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${BASE_URL}${path}${sep}${tenantQuery}`);
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return res.json();
  }

  async function postJson(path, body) {
    const res = await fetch(`${BASE_URL}${path}?${tenantQuery}`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || data.details || `Request failed (${res.status})`);
    }
    return data;
  }

  function switchTab(tab) {
    activeTab = tab;
    if (tab === "dispute") chargePhase = "dispute";
    else if (tab === "tasks") chargePhase = null;
    els.tabBtns.forEach((btn) => {
      const on = btn.dataset.tab === tab;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    const showTasks = tab === "tasks" || tab === "dispute";
    const panels = {
      tasks: els.tabPanelTasks,
      invoices: els.tabPanelInvoices,
      notifications: els.tabPanelNotifications,
    };
    Object.keys(panels).forEach((key) => {
      const panel = panels[key];
      if (!panel) return;
      const on = key === "tasks" ? showTasks : key === tab;
      panel.hidden = !on;
      panel.classList.toggle("is-active", on);
    });
    const issueNav = document.getElementById("issueFilters");
    const peopleNav = document.getElementById("peopleFilters");
    if (issueNav) issueNav.hidden = tab === "dispute";
    if (peopleNav) peopleNav.hidden = tab === "dispute";
    if (els.refreshTasksBtn) {
      els.refreshTasksBtn.hidden = tab !== "tasks" && tab !== "dispute";
    }
    if (els.refreshInvoicesBtn) els.refreshInvoicesBtn.hidden = tab !== "invoices";
    if (els.refreshNotifsBtn) els.refreshNotifsBtn.hidden = tab !== "notifications";
  }

  els.tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      const prev = activeTab;
      switchTab(tab);
      if ((tab === "tasks" || tab === "dispute") && tab !== prev) {
        loadTasks({reset: true});
      } else if (tab === "notifications" && tab !== prev) {
        loadNotifications({reset: true});
      }
    });
  });

  /* —— Mail status —— */
  async function loadMailStatus() {
    try {
      const data = await fetchJson("/getMailStatus");
      const connected = Boolean(data.connected);
      connectedMailboxEmail = data.email || null;
      els.badge.textContent = connected ? "Outlook connected" : "Outlook disconnected";
      els.badge.className = connected ?
        "status-pill status-pill-success badge-connected" :
        "status-pill status-pill-danger badge-disconnected";
      if (els.connectedMailbox) {
        els.connectedMailbox.hidden = !connectedMailboxEmail;
        els.connectedMailbox.textContent = connectedMailboxEmail || "";
      }
      if (els.connectBtn) els.connectBtn.hidden = connected;
      if (els.disconnectBtn) els.disconnectBtn.hidden = !connected;
    } catch (_) {
      els.badge.textContent = "Outlook unknown";
      els.badge.className = "status-pill status-pill-muted badge-unknown";
    }
  }

  /* —— Email HTML helpers —— */
  function looksLikeHtml(value) {
    return /<\/?[a-z][\s\S]*>/i.test(String(value || ""));
  }

  function decodeHtmlEntities(value) {
    const ta = document.createElement("textarea");
    let s = String(value || "");
    for (let i = 0; i < 3; i++) {
      if (!/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i.test(s)) break;
      ta.innerHTML = s;
      const next = ta.value;
      if (next === s) break;
      s = next;
    }
    return s;
  }

  function emailBodyAsHtml(rawBody) {
    let s = String(rawBody || "").trim();
    if (!s) return "";
    if (!looksLikeHtml(s) && /&(?:nbsp|lt|gt|amp|#\d+);/i.test(s)) {
      s = decodeHtmlEntities(s);
    }
    if (looksLikeHtml(s)) {
      return s.replace(/<script[\s\S]*?<\/script>/gi, "");
    }
    return `<pre style="white-space:pre-wrap;font:inherit;margin:0;">` +
      `${bodyEsc(s)}</pre>`;
  }

  function frameDoc(html) {
    return "<!doctype html><html><head><meta charset=\"utf-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
      "<base target=\"_blank\" rel=\"noopener\">" +
      "<style>html,body{margin:0;padding:0;background:#fff}" +
      "body{margin:0 auto;padding:22px 24px 28px;max-width:720px;" +
      "font-family:'DM Sans',Segoe UI,sans-serif;font-size:15px;line-height:1.65;" +
      "color:#1a2430;word-wrap:break-word;overflow-wrap:anywhere}" +
      "p{margin:0 0 1em} table{border-collapse:collapse;max-width:100%}" +
      "td,th{padding:.35em .65em;vertical-align:top}" +
      "img{max-width:100%;height:auto}</style></head><body>" +
      html + "</body></html>";
  }

  /* —— Drawer —— */
  function closeDrawer() {
    if (!els.drawer) return;
    els.drawer.hidden = true;
    els.drawer.setAttribute("aria-hidden", "true");
    drawerItem = null;
    drawerKind = null;
  }

  function openDrawer(kind, item, title, kicker, bodyHtml, footerHtml) {
    drawerKind = kind;
    drawerItem = item;
    els.drawerTitle.textContent = title || "Details";
    els.drawerKicker.textContent = kicker || "";
    els.drawerBody.innerHTML = bodyHtml || "";
    els.drawerFooter.innerHTML = footerHtml || "";
    els.drawer.hidden = false;
    els.drawer.setAttribute("aria-hidden", "false");
    const frame = els.drawerBody.querySelector(".notif-body-frame");
    if (frame && item) {
      const html = emailBodyAsHtml(item.body || "");
      if (html) {
        frame.srcdoc = frameDoc(html);
      } else if (kind === "task" || kind === "notif") {
        frame.srcdoc = frameDoc(
            "<p style=\"color:#5c6b76\">Loading email…</p>");
        loadRowDetail(item, kind).then(() => {
          if (drawerItem !== item) return;
          const loaded = emailBodyAsHtml(item.body || item.description || "");
          frame.srcdoc = loaded ? frameDoc(loaded) : "";
        });
      } else {
        const fallback = emailBodyAsHtml(item.description || "");
        if (fallback) frame.srcdoc = frameDoc(fallback);
      }
    }
    bindDrawerActions();
  }

  function loadRowDetail(item, kind) {
    if (!item || item._detailLoaded) return Promise.resolve();
    if (item._detailLoading) return item._detailLoading;
    if (kind === "task" && (item.source === "invoice" ||
        String(item.id || "").startsWith("invoice:"))) {
      item._detailLoaded = true;
      return Promise.resolve();
    }
    item._detailLoading = (async () => {
      try {
        if (kind === "notif") {
          const data = await fetchJson(
              `/getDashboardNotifications?detail=1&id=${encodeURIComponent(item.id)}`);
          if (data && data.body) item.body = data.body;
        } else {
          const params = new URLSearchParams({
            detail: "1",
            id: item.id,
            source: item.source || "dashboardTasks",
          });
          const data = await fetchJson(`/getDashboardTasks?${params}`);
          if (data && data.body) item.body = data.body;
          if (data && Array.isArray(data.charges) && data.charges.length) {
            item.charges = data.charges;
          }
        }
      } catch (error) {
        console.error("row detail failed:", error);
      } finally {
        item._detailLoaded = true;
        item._detailLoading = null;
      }
    })();
    return item._detailLoading;
  }

  document.querySelectorAll("[data-drawer-close]").forEach((el) => {
    el.addEventListener("click", closeDrawer);
  });

  function detailCells(pairs) {
    return `<dl class="detail-grid">${pairs.filter((p) => p[1] != null && p[1] !== "")
        .map(([k, v]) =>
          `<div class="detail-cell"><dt>${bodyEsc(k)}</dt><dd>${v}</dd></div>`)
        .join("")}</dl>`;
  }

  function isOptionDDispute(task) {
    const type = String((task && task.type) || "").toLowerCase();
    const source = String((task && task.source) || "");
    if (type !== "additional_charge" && source !== "additionalCharges") {
      return false;
    }
    const phase = String(task.chargePhase || "").toLowerCase();
    const follow = String(task.followUpStatus || "").toLowerCase();
    const decision = String(task.decision || "").toLowerCase();
    const status = String(task.status || "").toLowerCase();
    return decision === "d" || phase === "dispute" ||
      follow === "disputing" || follow === "disputed" ||
      status === "disputed" || status === "disputing";
  }

  function taskTypeMeta(task) {
    const t = String(task.type || "");
    const reason = String(task.reason || "").toLowerCase();
    if (t === "additional_charge") {
      return {label: "Additional Charge", cls: "type-badge-charge"};
    }
    if (t === "pod_discrepancy") {
      if (/damage/i.test(reason)) {
        return {label: "Damaged POD", cls: "type-badge-pod"};
      }
      if (/shortage|missing carton/i.test(reason)) {
        return {label: "Shortage", cls: "type-badge-pod"};
      }
      return {label: "POD Discrepancy", cls: "type-badge-pod"};
    }
    if (t === "signed_pod") {
      return {label: "Signed POD", cls: "type-badge-signed"};
    }
    if (t === "missing_rate" || t === "rate_missing" ||
        reason === "missing_rate") {
      return {label: "Missing rate", cls: "type-badge-review"};
    }
    if (/missing/i.test(reason)) {
      return {label: "Missing Information", cls: "type-badge-review"};
    }
    return {label: "Review", cls: "type-badge-review"};
  }

  function taskCanResolve(task) {
    if (!task || !task.invoiceId) return false;
    if (task.source === "invoice") return false;
    if (task.type === "additional_charge" || task.source === "additionalCharges") {
      return true;
    }
    return /charge|reweigh|accessorial|redeliver/i.test(
        `${task.reason || ""} ${task.description || ""} ${task.title || ""}`);
  }

  function renderChargeButtons(task) {
    if (!taskCanResolve(task)) return "";
    return `<div class="charge-opt-grid">` +
      ["a", "b", "c", "d", "e"].map((opt) =>
        `<button type="button" class="btn btn-sm charge-opt" data-charge-opt="${opt}" ` +
        `data-invoice="${bodyEsc(task.invoiceId)}" data-task-id="${bodyEsc(task.id)}" ` +
        `data-task-source="${bodyEsc(task.source || "dashboardTasks")}">` +
        `${bodyEsc(CHARGE_LABELS[opt])}</button>`).join("") +
      `</div><div class="charge-form" data-charge-form="${bodyEsc(task.id)}" hidden></div>`;
  }

  function openTaskDrawer(task) {
    const meta = taskTypeMeta(task);
    const why = task.reason || task.description || task.subject ||
      "Needs a human decision before billing can continue.";
    const body =
      detailCells([
        ["Load", task.loadNumber ? bodyEsc(task.loadNumber) : "—"],
        ["Carrier", bodyEsc(task.carrierName || "—")],
        ["Amount", bodyEsc(formatMoney(task.chargesTotal))],
        ["Owner", bodyEsc(task.ownerBucket || "—")],
        ["To", bodyEsc(task.to || "—")],
        ["Cc", bodyEsc(task.cc || "—")],
        ["Received", (() => {
          const info = receivedInfo(task);
          return `<span title="${bodyEsc(info.title)}">${bodyEsc(info.text)}</span>`;
        })()],
        ["Dispatcher", bodyEsc(task.dispatcherName || task.dispatcherEmail || "—")],
      ]) +
      `<div class="why-box"><strong>Why it needs attention:</strong> ${bodyEsc(why)}</div>` +
      (task.isUrgentOld || task.ageLabel ?
        `<p><span class="age-badge">URGENT/OLD</span></p>` : "") +
      `<div class="email-frame-wrap"><iframe class="notif-body-frame" title="Email" sandbox=""></iframe></div>` +
      attachmentListHtml(task, task.source === "additionalCharges" ?
        "additionalCharges" : "task");
    const footer =
      renderChargeButtons(task) +
      `<div class="assign-row">` +
      `<select class="input input-select assign-person" aria-label="Assign to">` +
      OPS_PEOPLE.map((p) =>
        `<option value="${bodyEsc(p.key)}">${bodyEsc(p.name)}</option>`).join("") +
      `</select>` +
      `<button type="button" class="btn btn-sm btn-primary assign-send">Assign</button>` +
      `</div>` +
      (task.source === "invoice" ? "" :
        `<button type="button" class="btn btn-outline btn-sm drawer-dismiss">Done / Resolve</button>`);
    openDrawer("task", task, task.title || meta.label, meta.label, body, footer);
  }

  function openInvoiceDrawer(inv) {
    const invoiceAmt = Number(inv.invoiceAmount);
    const tmsAmt = Number(inv.primusAmount != null ? inv.primusAmount : inv.customerRate);
    const diff = Number.isFinite(invoiceAmt) && Number.isFinite(tmsAmt) ?
      invoiceAmt - tmsAmt : null;
    const why = inv.decisionReason || inv.currentStep ||
      (inv.isCompleted ? "Workflow completed." : "Still in automation.");
    const body =
      detailCells([
        ["Vendor / Carrier", bodyEsc(inv.carrierName || "—")],
        ["Customer", bodyEsc(inv.customerName || "—")],
        ["Load", bodyEsc(inv.loadNumber || "—")],
        ["PRO", bodyEsc(inv.proNumber || "—")],
        ["Invoice amount", bodyEsc(formatMoney(inv.invoiceAmount))],
        ["TMS amount", bodyEsc(formatMoney(
            inv.primusAmount != null ? inv.primusAmount : inv.customerRate))],
        ["Difference", diff == null ? "—" : bodyEsc(formatMoney(diff))],
        ["Status", bodyEsc(inv.displayLabel || inv.displayStatus || "—")],
        ["Received", (() => {
          const info = receivedInfo(inv);
          return `<span title="${bodyEsc(info.title)}">${bodyEsc(info.text)}</span>`;
        })()],
        ["Invoice ID", bodyEsc(inv.id)],
      ]) +
      `<div class="why-box"><strong>Automation note:</strong> ${bodyEsc(why)}</div>`;
    openDrawer("invoice", inv,
        `Invoice ${inv.loadNumber || inv.id}`,
        inv.displayLabel || "Invoice",
        body, "");
  }

  function notifSeverity(n) {
    const t = `${n.type || ""} ${n.reason || ""} ${n.emailType || ""}`.toLowerCase();
    if (/fail|error|dispute|damage|shortage/.test(t)) return "error";
    if (/charge|pending|review|action required|missing/.test(t)) return "warn";
    if (/complete|success|replied/.test(t)) return "success";
    return "info";
  }

  function openNotifDrawer(n) {
    const sev = notifSeverity(n);
    markNotifRead(n.id);
    const body =
      detailCells([
        ["From", bodyEsc(n.from || "—")],
        ["To", bodyEsc(n.to || "—")],
        ["Cc", bodyEsc(n.cc || "—")],
        ["Subject", bodyEsc(n.subject || n.title || "—")],
        ["Reason", bodyEsc(n.reason || "—")],
        ["Load", bodyEsc(n.loadNumber || "—")],
        ["Carrier", bodyEsc(n.carrierName || "—")],
        ["Received", (() => {
          const info = receivedInfo(n);
          return `<span title="${bodyEsc(info.title)}">${bodyEsc(info.text)}</span>`;
        })()],
      ]) +
      (n.reason ?
        `<div class="why-box"><strong>Why review:</strong> ${bodyEsc(n.reason)}</div>` :
        "") +
      `<div class="email-frame-wrap"><iframe class="notif-body-frame" title="Email" sandbox=""></iframe></div>` +
      attachmentListHtml(n, "notification") +
      `<div class="flag-form" hidden></div><div class="reply-form" hidden></div>`;
    const unhandled = n.type === "unhandled_email";
    const footer =
      `<button type="button" class="btn btn-outline btn-sm notif-dismiss">Done</button>` +
      `<button type="button" class="btn btn-ghost btn-sm notif-flag">Flag</button>` +
      (unhandled ?
        `<button type="button" class="btn btn-outline btn-sm notif-reply">Reply</button>` +
        `<button type="button" class="btn btn-danger btn-sm notif-delete">Delete</button>` :
        "") +
      (n.type === "additional_charge" ?
        `<button type="button" class="btn btn-primary btn-sm notif-goto-tasks">Open Tasks</button>` :
        "");
    openDrawer("notif", n, n.subject || n.title || "Notification",
        sev.toUpperCase(), body, footer);
  }

  function bindDrawerActions() {
    const foot = els.drawerFooter;
    const body = els.drawerBody;
    if (!foot || !drawerItem) return;

    foot.querySelector(".assign-send")?.addEventListener("click", async () => {
      const key = foot.querySelector(".assign-person")?.value || "";
      const person = OPS_PEOPLE.find((p) => p.key === key);
      if (!person) {
        showError("Pick a person.");
        return;
      }
      try {
        await postJson("/reassignDashboardWork", {
          taskId: drawerItem.id,
          source: drawerItem.source || "dashboardTasks",
          bucket: "dispatch",
          dispatcherEmail: person.email,
          dispatcherName: person.name,
          loadNumber: drawerItem.loadNumber,
          invoiceId: drawerItem.invoiceId,
          carrierName: drawerItem.carrierName,
          subject: drawerItem.subject || drawerItem.title,
          issue: drawerItem.issueType || drawerItem.type,
        });
        showRunResult(`Assigned to ${person.name}.`, false);
        closeDrawer();
        await loadTasks({reset: true});
      } catch (error) {
        showError(error.message);
      }
    });

    foot.querySelectorAll(".drawer-dismiss").forEach((btn) => {
      btn.addEventListener("click", () => {
        dismissTaskOptimistic(drawerItem, {closeDrawerFirst: true});
      });
    });

    foot.querySelectorAll(".charge-opt").forEach((btn) => {
      btn.addEventListener("click", () => openChargeForm(btn));
    });

    foot.querySelector(".notif-dismiss")?.addEventListener("click", () => {
      const id = drawerItem.id;
      closeDrawer();
      notifsCache = notifsCache.filter((n) => n.id !== id);
      openNotifCount = Math.max(0, openNotifCount - 1);
      if (els.notifCountBadge) {
        els.notifCountBadge.textContent = String(openNotifCount);
      }
      const keep = notifsCache.slice();
      notifsCache = [];
      renderNotifications(keep);
      postJson("/dismissDashboardNotification", {id}).catch((error) => {
        showError(error.message);
        loadNotifications({reset: true});
      });
    });

    foot.querySelector(".notif-flag")?.addEventListener("click", () => {
      const form = body.querySelector(".flag-form");
      if (!form) return;
      form.hidden = false;
      form.innerHTML =
        `<label>What went wrong?</label>` +
        `<textarea class="flag-note" rows="3"></textarea>` +
        `<button type="button" class="btn btn-sm btn-primary flag-send">Send flag</button>`;
      form.querySelector(".flag-send").addEventListener("click", async () => {
        const note = form.querySelector(".flag-note").value.trim();
        try {
          await postJson("/flagDashboardNotification", {id: drawerItem.id, note});
          showRunResult("Flagged for review.", false);
          closeDrawer();
          await loadNotifications({reset: true});
        } catch (error) {
          showError(error.message);
        }
      });
    });

    foot.querySelector(".notif-reply")?.addEventListener("click", () => {
      const form = body.querySelector(".reply-form");
      if (!form) return;
      form.hidden = false;
      form.innerHTML =
        `<label>Reply</label>` +
        `<textarea class="reply-text" rows="4"></textarea>` +
        `<button type="button" class="btn btn-sm btn-primary reply-send">Send reply</button>`;
      form.querySelector(".reply-send").addEventListener("click", async () => {
        const text = form.querySelector(".reply-text").value.trim();
        try {
          await postJson("/replyDashboardEmail", {
            notificationId: drawerItem.id,
            messageId: drawerItem.messageId,
            body: text,
          });
          showRunResult("Reply sent.", false);
          closeDrawer();
          await loadNotifications({reset: true});
        } catch (error) {
          showError(error.message);
        }
      });
    });

    foot.querySelector(".notif-delete")?.addEventListener("click", async () => {
      if (!confirm("Delete this email from the mailbox?")) return;
      try {
        await postJson("/deleteDashboardEmail", {
          notificationId: drawerItem.id,
          messageId: drawerItem.messageId,
        });
        closeDrawer();
        await loadNotifications({reset: true});
      } catch (error) {
        showError(error.message);
      }
    });

    foot.querySelector(".notif-goto-tasks")?.addEventListener("click", () => {
      closeDrawer();
      ownerBucket = "sarah";
      dispatcherKey = null;
      updateFolderActive();
      switchTab("tasks");
      loadTasks({reset: true});
    });
  }

  let accessorialChoices = null;

  function normAccessorial(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  async function loadAccessorialChoices() {
    if (accessorialChoices) return accessorialChoices;
    const data = await fetchJson("/getDashboardAccessorials");
    accessorialChoices = Array.isArray(data.accessorials) ? data.accessorials : [];
    return accessorialChoices;
  }

  function matchAccessorialChoice(name, choices) {
    const want = normAccessorial(name);
    if (!want) return null;
    const exact = choices.find((item) =>
      normAccessorial(item.name) === want || normAccessorial(item.code) === want);
    if (exact) return exact;
    if (want.length < 4) return null;
    const loose = choices.filter((item) => {
      const label = normAccessorial(item.name);
      return label.includes(want) || want.includes(label);
    });
    return loose.length === 1 ? loose[0] : null;
  }

  function addChargeLine(list, seed, choices) {
    const row = document.createElement("div");
    row.className = "charge-line";
    row.style.display = "grid";
    row.style.gridTemplateColumns = "1fr 90px 110px 90px";
    row.style.gap = "6px";
    row.style.marginBottom = "8px";
    const carrier = seed && seed.carrierAmount ? Number(seed.carrierAmount) : "";
    const select = document.createElement("select");
    select.className = "input charge-line-name";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "Select accessorial";
    select.appendChild(blank);
    const matched = matchAccessorialChoice(seed && seed.name, choices || []);
    let selected = false;
    (choices || []).forEach((item) => {
      const opt = document.createElement("option");
      opt.value = item.code || "";
      opt.dataset.name = item.name || "";
      opt.textContent = `${item.category ? item.category + " — " : ""}${item.name}`;
      if (matched && item.code === matched.code && item.name === matched.name) {
        opt.selected = true;
        selected = true;
      }
      select.appendChild(opt);
    });
    if (seed && seed.name && !selected) {
      const extra = document.createElement("option");
      extra.value = "";
      extra.dataset.name = seed.name;
      extra.selected = true;
      extra.textContent = `${seed.name} (from the invoice)`;
      select.appendChild(extra);
    }
    const carrierInput = document.createElement("input");
    carrierInput.className = "input charge-line-carrier";
    carrierInput.type = "number";
    carrierInput.min = "0";
    carrierInput.step = "0.01";
    carrierInput.placeholder = "Carrier $";
    if (carrier !== "") carrierInput.value = String(carrier);
    const mode = document.createElement("select");
    mode.className = "input charge-line-mode";
    mode.innerHTML = `<option value="markup">% markup</option><option value="flat">Flat $</option>`;
    const value = document.createElement("input");
    value.className = "input charge-line-value";
    value.type = "number";
    value.min = "0";
    value.step = "0.01";
    value.placeholder = "20 or 75.00";
    row.appendChild(select);
    row.appendChild(carrierInput);
    row.appendChild(mode);
    row.appendChild(value);
    list.appendChild(row);
  }

  function readChargeLines(form) {
    const lines = [];
    form.querySelectorAll(".charge-line").forEach((row) => {
      const select = row.querySelector(".charge-line-name");
      const opt = select && select.options[select.selectedIndex];
      const name = opt && opt.dataset.name ? opt.dataset.name.trim() : "";
      if (!name) return;
      const code = select.value || null;
      const carrierAmount = Number(row.querySelector(".charge-line-carrier").value);
      const mode = row.querySelector(".charge-line-mode").value;
      const val = Number(row.querySelector(".charge-line-value").value);
      if (mode === "flat") {
        if (!(val > 0)) return;
        lines.push({
          name, code, carrierAmount: carrierAmount || 0, pricingMode: "flat",
          flatAmount: val, amount: val,
        });
        return;
      }
      if (!(carrierAmount > 0) || !(val >= 0)) return;
      const amount = Math.round(carrierAmount * (1 + val / 100) * 100) / 100;
      lines.push({
        name, code, carrierAmount, pricingMode: "markup",
        markupPct: val, amount,
      });
    });
    return lines;
  }

  function chargeLinesForm(opt, allowEmpty) {
    return `<p><strong>${bodyEsc(CHARGE_LABELS[opt])}</strong></p>` +
      `<p>Pick each accessorial from the Primus list. Add accessorial for a charge Jerry did not list. Then enter a percent markup or a flat customer amount.</p>` +
      `<div class="charge-line-list"></div>` +
      `<button type="button" class="btn btn-sm btn-outline charge-add-line">+ Add accessorial</button>` +
      `<div class="row-actions">` +
      `<button type="button" class="btn btn-sm btn-primary charge-confirm" data-opt="${opt}" data-allow-empty="${allowEmpty ? "1" : "0"}">Confirm ${opt.toUpperCase()}</button>` +
      `<button type="button" class="btn btn-outline btn-sm charge-cancel">Cancel</button></div>`;
  }

  async function openChargeForm(btn) {
    const opt = btn.dataset.chargeOpt;
    const invoiceId = btn.dataset.invoice;
    const taskId = btn.dataset.taskId;
    const taskSource = btn.dataset.taskSource;
    const form = els.drawerFooter.querySelector(`[data-charge-form="${taskId}"]`) ||
      els.drawerBody.querySelector(`[data-charge-form="${taskId}"]`);
    if (!form) return;
    form.hidden = false;
    if (opt === "c" || opt === "d") {
      form.innerHTML = chargeLinesForm(opt, true);
    } else {
      form.innerHTML = chargeLinesForm(opt, false);
    }
    const list = form.querySelector(".charge-line-list");
    list.textContent = "Loading the Primus list…";
    if (drawerItem && !drawerItem._detailLoaded) {
      await loadRowDetail(drawerItem, "task");
    }
    let choices = [];
    try {
      choices = await loadAccessorialChoices();
    } catch (error) {
      showError(error.message || "Could not load the Primus accessorial list.");
    }
    const listed = Array.isArray(drawerItem && drawerItem.charges) ?
      drawerItem.charges : [];
    list.textContent = "";
    const seeds = listed.length ? listed.map((charge) => ({
      name: charge.label || charge.name || charge.description || "",
      carrierAmount: Number(charge.amount) || 0,
    })) : [{}];
    seeds.forEach((seed) => addChargeLine(list, seed, choices));
    form.querySelector(".charge-add-line").addEventListener("click", () => {
      addChargeLine(list, {}, choices);
    });
    form.querySelector(".charge-cancel").addEventListener("click", () => {
      form.hidden = true;
      form.innerHTML = "";
    });
    form.querySelector(".charge-confirm").addEventListener("click", async () => {
      const confirmBtn = form.querySelector(".charge-confirm");
      setButtonBusy(confirmBtn, true, "Applying…");
      try {
        const payload = {invoiceId, option: opt, taskId, taskSource};
        const allowEmpty = confirmBtn.dataset.allowEmpty === "1";
        const lines = readChargeLines(form);
        if (!lines.length && !allowEmpty) {
          showError("Enter a percent markup or a flat amount, or add an accessorial.");
          setButtonBusy(confirmBtn, false);
          return;
        }
        payload.customerBillLines = lines;
        const result = await postJson("/dashboardAdditionalChargeDecision", payload);
        showRunResult(
            result.handedOffToDispatch ?
              `Option B applied — moved to Dispatch Tasks.` :
              result.markedInDispute ?
                `Option D applied — moved to In dispute.` :
                `Option ${opt.toUpperCase()} applied for ${invoiceId}.`,
            false);
        if (opt === "d" || opt === "b") {
          closeDrawer();
          const el = getTasksScrollEl();
          const top = el ? el.scrollTop : 0;
          await loadTasks({reset: true});
          if (el) el.scrollTop = top;
        } else if (drawerItem) {
          dismissTaskOptimistic(drawerItem, {closeDrawerFirst: true});
        } else {
          closeDrawer();
        }
        loadNotifications({reset: true});
      } catch (error) {
        showError(error.message || "Could not apply decision.");
        setButtonBusy(confirmBtn, false);
      }
    });
  }

  /* —— Tasks —— */
  function updateFolderActive() {
    document.querySelectorAll(".folder-item").forEach((el) => {
      const isDispute = el.dataset.owner === "dispute";
      const on = isDispute ?
        chargePhase === "dispute" :
        chargePhase !== "dispute" &&
          el.dataset.owner === ownerBucket && !dispatcherKey;
      el.classList.toggle("is-active", on);
    });
    document.querySelectorAll(".folder-child").forEach((el) => {
      el.classList.toggle("is-active",
          chargePhase !== "dispute" && el.dataset.key === dispatcherKey);
    });
  }

  function renderFolderCounts() {
    const map = {
      accounting: document.getElementById("folderAccounting"),
      sarah: document.getElementById("folderSarah"),
      dispatch: document.getElementById("folderDispatch"),
    };
    Object.keys(map).forEach((key) => {
      const el = map[key];
      if (!el) return;
      const c = bucketCounts[key] || {};
      const countEl = el.querySelector("[data-count]");
      const urgentEl = el.querySelector("[data-urgent]");
      if (countEl) countEl.textContent = String(c.openCount || 0);
      if (urgentEl) urgentEl.hidden = !(c.urgentCount > 0);
    });
    const disputeBadge = document.getElementById("disputeCountBadge");
    if (disputeBadge) disputeBadge.textContent = String(disputeCount || 0);
    if (!els.dispatcherFolders) return;
    els.dispatcherFolders.innerHTML = (dispatchers || []).map((d) =>
      `<button type="button" class="folder-child" data-key="${bodyEsc(d.key)}">` +
      `<span>${bodyEsc(d.name)}</span>` +
      `<span>${d.openCount || 0}${d.urgentCount ? " ·!" : ""}</span></button>`,
    ).join("");
    els.dispatcherFolders.querySelectorAll(".folder-child").forEach((btn) => {
      btn.addEventListener("click", () => {
        chargePhase = null;
        ownerBucket = "dispatch";
        dispatcherKey = btn.dataset.key;
        updateFolderActive();
        loadTasks({reset: true});
      });
    });
    updateFolderActive();
  }

  document.querySelectorAll(".folder-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.owner === "dispute") {
        chargePhase = "dispute";
        dispatcherKey = null;
      } else {
        chargePhase = null;
        ownerBucket = btn.dataset.owner;
        dispatcherKey = null;
      }
      updateFolderActive();
      loadTasks({reset: true});
    });
  });

  function getTasksScrollEl() {
    return els.tasksContainer;
  }

  function withPreservedScroll(fn) {
    const el = getTasksScrollEl();
    const top = el ? el.scrollTop : 0;
    const winTop = window.scrollY || 0;
    fn();
    if (el) el.scrollTop = top;
    window.scrollTo(0, winTop);
  }

  function dismissTaskOptimistic(task, opts) {
    if (!task || !task.id) return;
    const closeDrawerFirst = opts && opts.closeDrawerFirst;
    if (closeDrawerFirst) closeDrawer();

    withPreservedScroll(() => {
      tasksCache = tasksCache.filter((t) => t.id !== task.id);
      openTaskCount = Math.max(0, openTaskCount - 1);
      if (isOptionDDispute(task)) {
        disputeCount = Math.max(0, disputeCount - 1);
      } else if (task.ownerBucket && bucketCounts[task.ownerBucket]) {
        const b = bucketCounts[task.ownerBucket];
        b.openCount = Math.max(0, (b.openCount || 0) - 1);
        if (task.isUrgentOld) {
          b.urgentCount = Math.max(0, (b.urgentCount || 0) - 1);
        }
      }
      renderFolderCounts();
      renderTasks(tasksCache.slice(), {append: false, preserveCache: true});
    });

    showError(null);
    postJson("/dismissDashboardTask", {
      taskId: task.id,
      source: task.source,
      invoiceId: task.invoiceId || null,
    }).catch((error) => {
      showError(error.message || "Could not dismiss task.");
      // Soft recovery — pull fresh list without forcing scroll to top.
      const el = getTasksScrollEl();
      const top = el ? el.scrollTop : 0;
      loadTasks({reset: true}).then(() => {
        if (el) el.scrollTop = top;
      });
    });
  }

  function itemAmount(item) {
    const raw = item && (item.chargesTotal != null ?
      item.chargesTotal : item.invoiceAmount);
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  function clientFilterSort(items) {
    const q = String(els.workspaceSearch?.value || "").trim().toLowerCase();
    let list = items.slice();
    if (q) {
      list = list.filter((t) => {
        const hay = [
          t.loadNumber, t.carrierName, t.customerName, t.title, t.subject,
          t.reason, t.description, t.to, t.proNumber, t.id,
          t.displayLabel, t.displayStatus, t.invoiceNumber,
        ].filter((v) => v != null && String(v).trim() !== "")
            .join(" ").toLowerCase();
        return hay.includes(q);
      });
    }
    const sort = els.workspaceSort?.value || "urgent";
    list.sort((a, b) => {
      if (sort === "urgent") {
        if (Boolean(a.isUrgentOld) !== Boolean(b.isUrgentOld)) {
          return a.isUrgentOld ? -1 : 1;
        }
      }
      if (sort === "amount") return itemAmount(b) - itemAmount(a);
      const ta = Date.parse(a.receivedAt || a.createdAt || "") || 0;
      const tb = Date.parse(b.receivedAt || b.createdAt || "") || 0;
      return sort === "oldest" ? ta - tb : tb - ta;
    });
    return list;
  }

  function renderTasks(tasks, {append = false, preserveCache = false} = {}) {
    if (!preserveCache) {
      if (!append) tasksCache = tasks.slice();
      else tasksCache = tasksCache.concat(tasks);
    } else if (Array.isArray(tasks) && tasks.length && !append) {
      // Caller already mutated tasksCache; keep it.
      void tasks;
    }

    const list = clientFilterSort(tasksCache);
    if (els.taskCountBadge) {
      els.taskCountBadge.textContent = String(openTaskCount);
    }
    if (!list.length) {
      els.tasksContainer.innerHTML =
        '<p class="panel-empty">No open work for this filter.</p>';
      return;
    }

    const groups = new Map();
    list.forEach((t) => {
      const key = t.loadNumber || `id:${t.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    });

    const assignOptions = OPS_PEOPLE.map((p) =>
      `<option value="${bodyEsc(p.key)}">${bodyEsc(p.name)}</option>`).join("");
    let rows = "";
    for (const [loadKey, group] of groups) {
      if (group.length > 1 && !String(loadKey).startsWith("id:")) {
        rows += `<div class="group-row">Load ${bodyEsc(loadKey)} · ${group.length} related</div>`;
      }
      group.forEach((task) => {
        const meta = taskTypeMeta(task);
        const high = Number(task.chargesTotal) >= HIGH_DOLLAR;
        const urgent = Boolean(task.isUrgentOld || task.ageLabel);
        const person = task.dispatcherName || task.dispatcherEmail || "—";
        const statusLabel = isOptionDDispute(task) ?
          "In dispute" : (task.issueLabel || task.ownerBucket || "Open");
        const issue = meta.label || task.issueLabel || "—";
        const logged = receivedInfo(task);
        const chargeBtns = taskCanResolve(task) ?
          `<span class="charge-opt-row">` +
          ["a", "b", "c", "d", "e"].map((opt) =>
            `<button type="button" class="btn btn-sm charge-opt" data-charge-opt="${opt}">${opt.toUpperCase()}</button>`,
          ).join("") + `</span>` : `<span class="charge-opt-row"></span>`;
        rows += `<article class="work-row ${urgent ? "is-urgent" : ""} ${high ? "is-high-dollar" : ""}" data-task-id="${bodyEsc(task.id)}">
          <div class="work-line">
            ${chargeBtns}
            <button type="button" class="work-summary" aria-expanded="false">
              <span class="work-load">${task.loadNumber ? bodyEsc(task.loadNumber) : "—"}</span>
              <span class="work-issue">${bodyEsc(issue)}</span>
              <span class="work-person">${bodyEsc(shortText(person, 22))}</span>
              <span class="work-status">${bodyEsc(statusLabel)}${urgent ? ' <span class="age-badge">OLD</span>' : ""}</span>
            </button>
            <span class="row-side-actions">
              <button type="button" class="btn btn-sm btn-outline task-open">Review</button>
              <button type="button" class="btn btn-sm btn-ghost task-dismiss">Done</button>
              <select class="input input-select row-assign" aria-label="Assign">
                <option value="">Assign</option>
                ${assignOptions}
              </select>
            </span>
          </div>
          <div class="work-detail" hidden>
            <div><span>Carrier</span>${bodyEsc(task.carrierName || "—")}</div>
            <div><span>Amount</span>${bodyEsc(formatMoney(task.chargesTotal || task.invoiceAmount))}</div>
            <div><span>Reason</span>${bodyEsc(task.reason || task.description || "—")}</div>
            <div><span>Logged</span>${bodyEsc(logged.text)}</div>
          </div>
        </article>`;
      });
    }

    els.tasksContainer.innerHTML =
      `<div class="work-head"><span>Load</span><span>Issue</span><span>Person</span><span>Status</span></div>` +
      `<div class="work-list">${rows}</div>`;

    const byId = new Map(list.map((t) => [t.id, t]));
    els.tasksContainer.querySelectorAll(".work-row[data-task-id]").forEach((row) => {
      const task = byId.get(row.dataset.taskId);
      if (!task) return;
      row.querySelector(".work-summary")?.addEventListener("click", () => {
        const detail = row.querySelector(".work-detail");
        const open = detail && detail.hidden;
        if (detail) detail.hidden = !open;
        row.classList.toggle("is-open", Boolean(open));
        row.querySelector(".work-summary")?.setAttribute(
            "aria-expanded", open ? "true" : "false");
      });
      row.querySelector(".task-open")?.addEventListener("click", (e) => {
        e.stopPropagation();
        openTaskDrawer(task);
      });
      row.querySelectorAll(".charge-opt").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          btn.dataset.invoice = task.invoiceId || "";
          btn.dataset.taskId = task.id;
          btn.dataset.taskSource = task.source || "dashboardTasks";
          openTaskDrawer(task);
          openChargeForm(btn);
        });
      });
      row.querySelector(".task-dismiss")?.addEventListener("click", (e) => {
        e.stopPropagation();
        dismissTaskOptimistic(task);
      });
      row.querySelector(".row-assign")?.addEventListener("change", async (e) => {
        e.stopPropagation();
        const person = OPS_PEOPLE.find((p) => p.key === e.target.value);
        if (!person) return;
        try {
          await postJson("/reassignDashboardWork", {
            taskId: task.id,
            source: task.source || "dashboardTasks",
            bucket: "dispatch",
            dispatcherEmail: person.email,
            dispatcherName: person.name,
            loadNumber: task.loadNumber,
            invoiceId: task.invoiceId,
            carrierName: task.carrierName,
            subject: task.subject || task.title,
            issue: task.issueType || task.type,
          });
          const who = row.querySelector(".work-person");
          if (who) who.textContent = person.name;
          showRunResult(`Assigned to ${person.name}.`, false);
        } catch (error) {
          showError(error.message || "Could not assign.");
        }
      });
    });
  }

  function updateTasksLoadMore(loading) {
    if (!els.tasksLoadMoreWrap || !els.loadMoreTasksBtn) return;
    els.tasksLoadMoreWrap.hidden = !taskHasMore;
    els.loadMoreTasksBtn.disabled = Boolean(loading);
    els.loadMoreTasksBtn.textContent = loading ? "Loading…" : "Load more tasks";
  }

  async function loadTasks({reset = true} = {}) {
    const seq = ++taskLoadSeq;
    if (reset) {
      taskOffset = 0;
      taskHasMore = false;
      tasksCache = [];
      els.tasksContainer.innerHTML = '<p class="panel-empty">Loading…</p>';
    } else {
      updateTasksLoadMore(true);
    }
    try {
      const sort = els.workspaceSort?.value || "urgent";
      const params = new URLSearchParams({
        limit: String(TASK_PAGE),
        offset: String(taskOffset),
        view: "queue",
        issue: chargePhase === "dispute" ? "all" : (issueFilter || "all"),
        sort,
      });
      if (chargePhase === "dispute") params.set("chargePhase", "dispute");
      const q = String(els.workspaceSearch?.value || "").trim();
      const loadSearch = /^\d{5,}$/.test(q);
      if (!loadSearch) {
        const key = personKey || dispatcherKey || "";
        const person = OPS_PEOPLE.find((p) => p.key === key);
        if (person) params.set("dispatcher", person.email);
        else if (dispatcherQuery) params.set("dispatcher", dispatcherQuery);
      }
      if (q) params.set("q", q);
      const data = await fetchJson(`/getDashboardTasks?${params}`);
      if (seq !== taskLoadSeq) return;
      if (chargePhase === "dispute") {
        disputeCount = data.disputeCount != null ?
          data.disputeCount : (data.openCount || 0);
      } else {
        openTaskCount = data.openCount || 0;
        disputeCount = data.disputeCount != null ?
          data.disputeCount : disputeCount;
      }
      bucketCounts = data.bucketCounts || bucketCounts;
      dispatchers = data.dispatchers || [];
      renderFolderCounts();
      let page = data.tasks || [];
      if (chargePhase === "dispute") {
        page = page.filter(isOptionDDispute);
      } else {
        page = page.filter((task) => !isOptionDDispute(task));
      }
      taskHasMore = Boolean(data.hasMore);
      taskOffset = data.nextOffset != null ? data.nextOffset : taskOffset + page.length;
      const scrollEl = getTasksScrollEl();
      const savedTop = (!reset && scrollEl) ? scrollEl.scrollTop : null;
      renderTasks(page, {append: !reset});
      if (savedTop != null && scrollEl) scrollEl.scrollTop = savedTop;
      updateTasksLoadMore(false);
    } catch (error) {
      if (seq !== taskLoadSeq) return;
      if (reset) {
        els.tasksContainer.innerHTML =
          '<p class="panel-empty">Could not load tasks.</p>';
      }
      console.error("loadTasks failed:", error);
      updateTasksLoadMore(false);
    }
  }

  /* —— Invoices —— */
  function statusClass(status) {
    const s = String(status || "").toLowerCase();
    if (/complete/.test(s)) return "status-pill-success";
    if (/fail|error/.test(s)) return "status-pill-danger";
    if (/review|await|pending|charge/.test(s)) return "status-pill-warn";
    if (/process|running|send/.test(s)) return "status-pill-info";
    return "status-pill-neutral";
  }

  function buildInvoiceRow(inv) {
    const status = inv.displayLabel || inv.displayStatus || "—";
    return `<tr data-invoice-id="${bodyEsc(inv.id)}">
      <td>${bodyEsc(inv.carrierName || "—")}</td>
      <td>${bodyEsc(inv.id)}</td>
      <td>${inv.loadNumber ?
        `<a class="load-link" href="#">${bodyEsc(inv.loadNumber)}</a>` : "—"}</td>
      <td>${bodyEsc(inv.proNumber || "—")}</td>
      <td>${bodyEsc(formatMoney(inv.invoiceAmount))}</td>
      <td>${bodyEsc(receivedInfo(inv).text)}</td>
      <td><span class="status-pill ${statusClass(status)}">${bodyEsc(status)}</span></td>
    </tr>`;
  }

  function updateLoadMoreButton(loading) {
    if (!els.invoicesLoadMoreWrap || !els.loadMoreInvoicesBtn) return;
    els.invoicesLoadMoreWrap.hidden = !invoiceHasMore;
    els.loadMoreInvoicesBtn.disabled = Boolean(loading);
    els.loadMoreInvoicesBtn.textContent = loading ? "Loading…" : "Load more";
  }

  let invoicesCache = [];
  let invoiceLoadSeq = 0;

  function invoiceStatusText(inv) {
    return [
      inv && inv.displayStatus,
      inv && inv.displayLabel,
      inv && inv.decisionStage,
      inv && inv.finalWorkflowStatus,
    ].filter((v) => v != null && String(v).trim() !== "")
        .join(" ")
        .toLowerCase()
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
  }

  function invoiceIsCompleted(inv) {
    return [
      inv && inv.displayStatus,
      inv && inv.displayLabel,
      inv && inv.decisionStage,
      inv && inv.finalWorkflowStatus,
    ].some((v) =>
      String(v || "").trim().toLowerCase().replace(/[_-]+/g, " ") === "completed");
  }

  function invoiceMatchesGroup(inv, group) {
    const text = invoiceStatusText(inv);
    const completed = invoiceIsCompleted(inv);
    if (group === "completed") return completed;
    if (group === "needs_rate") {
      return !completed &&
        /needs customer rate|missing rate|low margin/.test(text);
    }
    if (group === "missing_pod") {
      // POD holds only. Signed-POD request tasks stay out of this filter.
      if (/\bsigned pod\b|\bpod request\b/.test(text)) return false;
      return !completed &&
        /\bmissing pod\b|\bneeds pod\b|\bawaiting pod\b/.test(text);
    }
    return !completed;
  }

  function invoiceEmptyMessage() {
    if (invoiceGroup === "completed") {
      return "No completed invoices in this page.";
    }
    if (invoiceGroup === "needs_rate") {
      return "No invoices awaiting a customer rate in this page.";
    }
    if (invoiceGroup === "missing_pod") {
      return "No invoices missing a POD in this page.";
    }
    return "No open invoices — nothing waiting.";
  }

  function paintInvoices(list) {
    const visible = (Array.isArray(list) ? list : []).filter((inv) =>
      invoiceMatchesGroup(inv, invoiceGroup));
    if (!visible.length) {
      els.invoicesContainer.innerHTML =
        `<p class="panel-empty">${invoiceEmptyMessage()}</p>`;
      return;
    }
    els.invoicesContainer.innerHTML =
      `<table class="data-table"><thead><tr>
        <th>Vendor</th><th>Invoice</th><th>Load</th><th>PRO</th>
        <th>Amount</th><th>Received</th><th>Status</th>
      </tr></thead><tbody>${visible.map(buildInvoiceRow).join("")}</tbody></table>`;
    const byId = new Map(visible.map((i) => [i.id, i]));
    els.invoicesContainer.querySelectorAll("tbody tr").forEach((tr) => {
      const inv = byId.get(tr.dataset.invoiceId);
      if (!inv) return;
      tr.addEventListener("click", () => openInvoiceDrawer(inv));
    });
  }

  function renderInvoices(invoices) {
    invoicesCache = invoices.slice();
    paintInvoices(clientFilterSort(invoicesCache));
    updateLoadMoreButton(false);
  }

  function appendInvoices(invoices) {
    invoicesCache = invoicesCache.concat(invoices);
    paintInvoices(clientFilterSort(invoicesCache));
    updateLoadMoreButton(false);
  }

  async function loadInvoices({reset = true} = {}) {
    const seq = ++invoiceLoadSeq;
    const group = invoiceGroup;
    if (reset) {
      invoiceOffset = 0;
      invoiceHasMore = false;
      setButtonBusy(els.refreshInvoicesBtn, true, "Refreshing…");
      if (!invoicesCache.length) {
        els.invoicesContainer.innerHTML = '<p class="panel-empty">Loading…</p>';
      }
    } else {
      updateLoadMoreButton(true);
    }
    try {
      const data = await fetchJson(
          `/getRecentInvoices?limit=${INVOICE_PAGE_SIZE}&offset=${invoiceOffset}` +
          `&statusGroup=${encodeURIComponent(group)}`,
      );
      if (seq !== invoiceLoadSeq || group !== invoiceGroup) return;
      const invoices = data.invoices || [];
      invoiceHasMore = typeof data.hasMore === "boolean" ?
        data.hasMore : invoices.length === INVOICE_PAGE_SIZE;
      invoiceOffset += invoices.length;
      if (reset) renderInvoices(invoices);
      else appendInvoices(invoices);
    } catch (error) {
      if (seq !== invoiceLoadSeq) return;
      if (reset && !invoicesCache.length) {
        els.invoicesContainer.innerHTML =
          '<p class="panel-empty">Could not load invoices.</p>';
      } else if (!reset) {
        showError("Could not load more invoices.");
      }
      console.error("loadInvoices failed:", error);
    } finally {
      if (seq === invoiceLoadSeq) {
        if (reset) setButtonBusy(els.refreshInvoicesBtn, false);
        updateLoadMoreButton(false);
      }
    }
  }

  document.querySelectorAll("[data-issue]").forEach((btn) => {
    btn.addEventListener("click", () => {
      issueFilter = btn.getAttribute("data-issue") || "all";
      document.querySelectorAll("[data-issue]").forEach((el) => {
        el.classList.toggle("is-active", el === btn);
      });
      loadTasks({reset: true});
    });
  });
  let dispatcherTimer = null;
  els.dispatcherFilter?.addEventListener("input", () => {
    clearTimeout(dispatcherTimer);
    dispatcherTimer = setTimeout(() => {
      dispatcherQuery = els.dispatcherFilter.value.trim();
      loadTasks({reset: true});
    }, 300);
  });

  document.querySelectorAll("[data-invoice-group]").forEach((btn) => {
    btn.addEventListener("click", () => {
      invoiceGroup = btn.getAttribute("data-invoice-group") || "open";
      document.querySelectorAll("[data-invoice-group]").forEach((b) => {
        b.classList.toggle("is-active", b === btn);
      });
      paintInvoices(clientFilterSort(invoicesCache));
      loadInvoices({reset: true});
    });
  });

  /* —— Notifications —— */
  function markNotifRead(id) {
    readNotifIds.add(id);
    localStorage.setItem("jerryReadNotifs",
        JSON.stringify([...readNotifIds].slice(-500)));
  }

  function renderNotifications(items, {append = false} = {}) {
    if (!append) notifsCache = items.slice();
    else notifsCache = notifsCache.concat(items);
    const list = clientFilterSort(notifsCache);
    if (els.notifCountBadge) {
      els.notifCountBadge.textContent = String(openNotifCount);
    }
    if (els.opsPrimaryHint) els.opsPrimaryHint.hidden = true;
    if (!list.length) {
      els.notificationsContainer.innerHTML =
        '<p class="panel-empty">No open notifications.</p>';
      return;
    }
    els.notificationsContainer.innerHTML =
      `<table class="data-table"><thead><tr>
        <th></th><th>Subject</th><th>From / To</th><th>Type</th><th>Received</th><th></th>
      </tr></thead><tbody>${list.map((n) => {
        const sev = notifSeverity(n);
        const read = readNotifIds.has(n.id);
        return `<tr class="${read ? "notif-read" : "notif-unread"}" data-notif-id="${bodyEsc(n.id)}">
          <td><span class="severity-dot sev-${sev}"></span></td>
          <td>${bodyEsc(shortText(n.subject || n.title, 70) || "(no subject)")}</td>
          <td>${bodyEsc(shortText(n.from || n.to, 36) || "—")}</td>
          <td>${bodyEsc(n.type || "ops")}</td>
          <td title="${bodyEsc(receivedInfo(n).title)}">${bodyEsc(receivedInfo(n).text)}</td>
          <td><button type="button" class="btn btn-sm btn-outline notif-open">Open</button></td>
        </tr>`;
      }).join("")}</tbody></table>`;

    const byId = new Map(list.map((n) => [n.id, n]));
    els.notificationsContainer.querySelectorAll("tbody tr").forEach((tr) => {
      const n = byId.get(tr.dataset.notifId);
      if (!n) return;
      const open = () => openNotifDrawer(n);
      tr.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        open();
      });
      tr.querySelector(".notif-open")?.addEventListener("click", (e) => {
        e.stopPropagation();
        open();
      });
    });
  }

  function updateNotifsLoadMore(loading) {
    if (!els.notifsLoadMoreWrap || !els.loadMoreNotifsBtn) return;
    els.notifsLoadMoreWrap.hidden = !notifHasMore;
    els.loadMoreNotifsBtn.disabled = Boolean(loading);
    els.loadMoreNotifsBtn.textContent = loading ? "Loading…" : "Load more";
  }

  async function loadNotifications({reset = true} = {}) {
    if (reset) {
      notifOffset = 0;
      notifHasMore = false;
      notifsCache = [];
      els.notificationsContainer.innerHTML = '<p class="panel-empty">Loading…</p>';
    } else {
      updateNotifsLoadMore(true);
    }
    try {
      const q = String(els.workspaceSearch?.value || "").trim();
      const data = await fetchJson(
          `/getDashboardNotifications?limit=${TASK_PAGE}&offset=${notifOffset}` +
          (q ? `&q=${encodeURIComponent(q)}` : ""));
      const page = data.notifications || [];
      if (data.bucketCounts) bucketCounts = data.bucketCounts;
      notifHasMore = Boolean(data.hasMore);
      notifOffset = data.nextOffset != null ?
        data.nextOffset : notifOffset + page.length;
      openNotifCount = data.openCount != null ? data.openCount : page.length;
      if (els.notifCountBadge) {
        els.notifCountBadge.textContent = String(openNotifCount);
      }
      renderNotifications(page, {append: !reset});
      updateNotifsLoadMore(false);
    } catch (error) {
      if (reset) {
        els.notificationsContainer.innerHTML =
          '<p class="panel-empty">Could not load notifications.</p>';
      }
      updateNotifsLoadMore(false);
    }
  }

  /* —— Stats / chart —— */
  function formatPeriodLabel(value, range) {
    if (!value) return "";
    if (range === "day") return String(value).slice(11, 16);
    return String(value);
  }

  function renderChart(series, range) {
    if (!els.chartCanvas || !window.Chart) return;
    const labels = (series || []).map((p) => formatPeriodLabel(p.period, range));
    const datasets = [
      {
        label: "Invoices",
        data: (series || []).map((p) => p.invoicesProcessed || 0),
        borderColor: "#0d6e6e",
        backgroundColor: "#0d6e6e",
        tension: 0.35,
      },
      {
        label: "Review",
        data: (series || []).map((p) => p.emailsForwarded || 0),
        borderColor: "#b42318",
        backgroundColor: "#b42318",
        tension: 0.35,
      },
    ];
    if (chart) {
      chart.data.labels = labels;
      chart.data.datasets = datasets;
      chart.update();
      return;
    }
    chart = new Chart(els.chartCanvas, {
      type: "line",
      data: {labels, datasets},
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: {
            labels: {
              boxWidth: 10, usePointStyle: true, pointStyle: "circle",
              font: {family: "DM Sans, system-ui, sans-serif", size: 11},
              color: "#5c6b76",
            },
          },
        },
        scales: {
          x: {grid: {display: false}, ticks: {color: "#5c6b76", font: {size: 10}}},
          y: {
            beginAtZero: true,
            ticks: {precision: 0, color: "#5c6b76", font: {size: 10}},
            grid: {color: "rgba(20, 33, 43, 0.06)"},
          },
        },
      },
    });
  }

  function setStatsThinking(active) {
    [els.statInvoices, els.statWorkflows, els.statAddedCharges,
      els.statReplied, els.statForwarded].forEach((el) => {
      if (!el) return;
      if (active) {
        el.textContent = "…";
        el.classList.add("is-thinking");
      } else {
        el.classList.remove("is-thinking");
      }
    });
  }

  async function loadStats(range) {
    if (statsInFlight) return statsInFlight;
    statsInFlight = (async () => {
      showError(null);
      setStatsThinking(true);
      setRangeButtonsDisabled(true);
      try {
        const data = await fetchJson(`/getDashboardStats?range=${range}`);
        statsTotals = data.totals || null;
        setStatsThinking(false);
        els.statInvoices.textContent = data.totals.invoicesProcessed ?? "–";
        if (els.statWorkflows) {
          els.statWorkflows.textContent = data.totals.workflowsCompleted ?? "–";
        }
        if (els.statAddedCharges) {
          els.statAddedCharges.textContent =
            data.totals.invoicesWithAddedCharges ?? "–";
        }
        els.statReplied.textContent = data.totals.emailsReplied ?? "–";
        els.statForwarded.textContent = data.totals.emailsForwarded ?? "–";
        renderChart(data.series, range);
      } catch (error) {
        setStatsThinking(false);
        showError("Couldn't load dashboard stats.");
        throw error;
      } finally {
        setRangeButtonsDisabled(false);
      }
    })();
    try { return await statsInFlight; } finally { statsInFlight = null; }
  }

  function setActiveRange(range) {
    if (range === activeRange && statsInFlight) return;
    activeRange = range;
    els.rangeBtns.forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.range === range);
    });
    loadStats(range);
  }

  els.rangeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      setActiveRange(btn.dataset.range);
    });
  });

  els.connectBtn?.addEventListener("click", () => {
    setButtonBusy(els.connectBtn, true, "Connecting…");
    window.location.href = `${BASE_URL}/mailConnect?${tenantQuery}`;
  });

  els.disconnectBtn?.addEventListener("click", async () => {
    if (!confirm("Disconnect Outlook?")) return;
    setButtonBusy(els.disconnectBtn, true, "Disconnecting…");
    try {
      const data = await postJson("/mailDisconnect");
      if (data.ok) {
        await loadMailStatus();
        showRunResult("Outlook disconnected.", false);
      } else {
        showRunResult("Disconnect failed.", true);
      }
    } catch (_) {
      showRunResult("Could not reach the server.", true);
    } finally {
      setButtonBusy(els.disconnectBtn, false);
    }
  });

  async function exportLogsCsvForSelectedDay() {
    const day = els.logExportDate?.value || todayEasternIsoDate();
    try {
      const res = await fetch(
          `${BASE_URL}/exportLogsCsv?${tenantQuery}&date=${encodeURIComponent(day)}`);
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `jerry-logs-${day}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (_) {
      showError("Could not export logs.");
    }
  }

  els.refreshInvoicesBtn?.addEventListener("click", () => loadInvoices({reset: true}));
  els.refreshTasksBtn?.addEventListener("click", () => loadTasks({reset: true}));
  els.refreshNotifsBtn?.addEventListener("click", () => loadNotifications({reset: true}));
  els.loadMoreInvoicesBtn?.addEventListener("click", () => {
    if (invoiceHasMore) loadInvoices({reset: false});
  });
  els.loadMoreTasksBtn?.addEventListener("click", () => {
    if (taskHasMore) loadTasks({reset: false});
  });
  els.loadMoreNotifsBtn?.addEventListener("click", () => {
    if (notifHasMore) loadNotifications({reset: false});
  });
  document.querySelectorAll("[data-person]").forEach((btn) => {
    btn.addEventListener("click", () => {
      personKey = btn.getAttribute("data-person") || "";
      document.querySelectorAll("[data-person]").forEach((el) => {
        el.classList.toggle("is-active", el === btn);
      });
      loadTasks({reset: true});
    });
  });
  let searchTimer = null;
  els.workspaceSearch?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (activeTab === "tasks" || activeTab === "dispute") {
        loadTasks({reset: true});
      } else if (activeTab === "notifications") loadNotifications({reset: true});
      else paintInvoices(clientFilterSort(invoicesCache));
    }, 300);
  });
  els.workspaceSort?.addEventListener("change", () => {
    if (activeTab === "tasks" || activeTab === "dispute") {
      loadTasks({reset: true});
      return;
    }
    els.workspaceSearch?.dispatchEvent(new Event("input"));
  });
  if (els.logExportDate) els.logExportDate.value = todayEasternIsoDate();
  els.exportLogsCsvBtn?.addEventListener("click", exportLogsCsvForSelectedDay);

  /* —— Support chat —— */
  const chatEls = {
    toggle: document.getElementById("supportChatToggle"),
    headerToggle: document.getElementById("supportChatHeaderToggle"),
    panel: document.getElementById("supportChatPanel"),
    log: document.getElementById("supportChatLog"),
    form: document.getElementById("supportChatForm"),
    input: document.getElementById("supportChatInput"),
  };
  const chatHistory = [];
  let chatBusy = false;
  let chatStarted = false;
  let chatOpen = false;

  function appendChatMessage(role, text) {
    const bubble = document.createElement("p");
    bubble.className = `support-chat-msg from-${role}`;
    bubble.textContent = text;
    chatEls.log.appendChild(bubble);
    chatEls.log.scrollTop = chatEls.log.scrollHeight;
    return bubble;
  }

  function isChatPanelVisible() {
    return !!(chatEls.panel && !chatEls.panel.hidden);
  }

  function setChatOpen(open) {
    chatOpen = !!open;
    chatEls.panel.hidden = !chatOpen;
    if (chatEls.toggle) {
      chatEls.toggle.classList.toggle("is-open", chatOpen);
      chatEls.toggle.setAttribute("aria-expanded", chatOpen ? "true" : "false");
      chatEls.toggle.setAttribute(
          "aria-label",
          chatOpen ? "Close Jerry chat" : "Chat with Jerry",
      );
    }
    if (chatEls.headerToggle) {
      chatEls.headerToggle.setAttribute(
          "aria-label",
          chatOpen ? "Close Jerry chat" : "Open Jerry chat",
      );
    }
    if (chatOpen) {
      chatEls.input.focus();
      if (!chatStarted) {
        chatStarted = true;
        appendChatMessage(
            "bot",
            `Hi! I am Jerry, the support assistant for ${client.name}. ` +
            "Ask about a load number, invoice status, or anything on the dashboard.",
        );
      }
    }
  }

  async function sendChatMessage(text) {
    chatHistory.push({role: "user", content: text});
    appendChatMessage("user", text);
    const pending = appendChatMessage("bot", "Loading...");
    pending.classList.add("is-pending");
    chatBusy = true;
    chatEls.input.disabled = true;
    try {
      const response = await fetch(`${BASE_URL}/dashboardSupportChat`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          clientName: client.name,
          tenantId: TENANT_ID,
          tms: TMS,
          messages: chatHistory,
          dashboardContext: {
            gmailConnected: els.badge.classList.contains("badge-connected"),
            connectedMailboxEmail,
            timeRange: activeRange,
            statsTotals,
            openTaskCount,
            openNotifCount,
            tms: TMS,
          },
        }),
      });
      if (!response.ok) throw new Error(`Chat failed (${response.status})`);
      const data = await response.json();
      pending.remove();
      const reply = (data && data.reply) || "Sorry, something went wrong.";
      appendChatMessage("bot", reply);
      chatHistory.push({role: "assistant", content: reply});
    } catch (_) {
      pending.remove();
      appendChatMessage("bot", "Sorry, I couldn't reach the support assistant.");
    } finally {
      chatBusy = false;
      chatEls.input.disabled = false;
      chatEls.input.focus();
    }
  }

  function toggleChatOpen() {
    setChatOpen(!isChatPanelVisible());
  }

  if (chatEls.toggle && chatEls.panel) {
    chatEls.toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleChatOpen();
    });
    chatEls.headerToggle?.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleChatOpen();
    });
    chatEls.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (chatBusy) return;
      const text = chatEls.input.value.trim();
      if (!text) return;
      chatEls.input.value = "";
      sendChatMessage(text);
    });
  }

  switchTab("tasks");
  loadMailStatus();
  setActiveRange(activeRange);
  loadTasks({reset: true});
  loadNotifications({reset: true});
})();
