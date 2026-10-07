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
  let invoicesInFlight = null;
  let statsInFlight = null;
  let activeTab = "tasks";
  let ownerBucket = "accounting";
  let chargePhase = null; // null | "dispute"
  let dispatcherKey = null;
  let taskOffset = 0;
  let taskHasMore = false;
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
    els.tabBtns.forEach((btn) => {
      const on = btn.dataset.tab === tab;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    const panels = {
      tasks: els.tabPanelTasks,
      invoices: els.tabPanelInvoices,
      notifications: els.tabPanelNotifications,
    };
    Object.keys(panels).forEach((key) => {
      const panel = panels[key];
      if (!panel) return;
      const on = key === tab;
      panel.hidden = !on;
      panel.classList.toggle("is-active", on);
    });
    if (els.refreshTasksBtn) els.refreshTasksBtn.hidden = tab !== "tasks";
    if (els.refreshInvoicesBtn) els.refreshInvoicesBtn.hidden = tab !== "invoices";
    if (els.refreshNotifsBtn) els.refreshNotifsBtn.hidden = tab !== "notifications";
  }

  els.tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
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
      const html = emailBodyAsHtml(item.body || item.description || "");
      if (html) frame.srcdoc = frameDoc(html);
    }
    bindDrawerActions();
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
    if (/missing/i.test(reason)) {
      return {label: "Missing Information", cls: "type-badge-review"};
    }
    return {label: "Review", cls: "type-badge-review"};
  }

  function renderChargeButtons(task) {
    if (task.type !== "additional_charge" || !task.invoiceId) return "";
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
        ["Received", bodyEsc(formatLogTime(task.createdAt))],
        ["Dispatcher", bodyEsc(task.dispatcherName || task.dispatcherEmail || "—")],
      ]) +
      `<div class="why-box"><strong>Why it needs attention:</strong> ${bodyEsc(why)}</div>` +
      (task.isUrgentOld || task.ageLabel ?
        `<p><span class="age-badge">URGENT/OLD</span></p>` : "") +
      `<div class="email-frame-wrap"><iframe class="notif-body-frame" title="Email" sandbox=""></iframe></div>`;
    const footer =
      renderChargeButtons(task) +
      `<button type="button" class="btn btn-outline btn-sm drawer-dismiss">Done / Resolve</button>`;
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
        ["Received", bodyEsc(formatLogTime(inv.createdAt))],
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
        ["Received", bodyEsc(formatLogTime(n.createdAt))],
      ]) +
      (n.reason ?
        `<div class="why-box"><strong>Why review:</strong> ${bodyEsc(n.reason)}</div>` :
        "") +
      `<div class="email-frame-wrap"><iframe class="notif-body-frame" title="Email" sandbox=""></iframe></div>` +
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

  function openChargeForm(btn) {
    const opt = btn.dataset.chargeOpt;
    const invoiceId = btn.dataset.invoice;
    const taskId = btn.dataset.taskId;
    const taskSource = btn.dataset.taskSource;
    const form = els.drawerFooter.querySelector(`[data-charge-form="${taskId}"]`) ||
      els.drawerBody.querySelector(`[data-charge-form="${taskId}"]`);
    if (!form) return;
    form.hidden = false;
    if (opt === "c" || opt === "d") {
      form.innerHTML =
        `<p><strong>${bodyEsc(CHARGE_LABELS[opt])}</strong></p>` +
        `<div class="row-actions">` +
        `<button type="button" class="btn btn-sm btn-primary charge-confirm" data-opt="${opt}">Confirm ${opt.toUpperCase()}</button>` +
        `<button type="button" class="btn btn-outline btn-sm charge-cancel">Cancel</button></div>`;
    } else if (opt === "a" || opt === "e") {
      form.innerHTML =
        `<p><strong>${bodyEsc(CHARGE_LABELS[opt])}</strong></p>` +
        `<label>Customer charge amount ($)</label>` +
        `<input type="number" min="0.01" step="0.01" class="charge-amount" />` +
        `<div class="row-actions">` +
        `<button type="button" class="btn btn-sm btn-primary charge-confirm" data-opt="${opt}">Confirm ${opt.toUpperCase()}</button>` +
        `<button type="button" class="btn btn-outline btn-sm charge-cancel">Cancel</button></div>`;
    } else {
      form.innerHTML =
        `<p><strong>${bodyEsc(CHARGE_LABELS.b)}</strong></p>` +
        `<label>Customer bill lines (description | amount)</label>` +
        `<textarea class="charge-lines" rows="3" placeholder="Liftgate|75"></textarea>` +
        `<div class="row-actions">` +
        `<button type="button" class="btn btn-sm btn-primary charge-confirm" data-opt="b">Confirm B</button>` +
        `<button type="button" class="btn btn-outline btn-sm charge-cancel">Cancel</button></div>`;
    }
    form.querySelector(".charge-cancel").addEventListener("click", () => {
      form.hidden = true;
      form.innerHTML = "";
    });
    form.querySelector(".charge-confirm").addEventListener("click", async () => {
      const confirmBtn = form.querySelector(".charge-confirm");
      setButtonBusy(confirmBtn, true, "Applying…");
      try {
        const payload = {invoiceId, option: opt, taskId, taskSource};
        if (opt === "a" || opt === "e") {
          payload.customerChargeAmount =
            form.querySelector(".charge-amount").value;
        }
        if (opt === "b") {
          const raw = form.querySelector(".charge-lines").value || "";
          payload.customerBillLines = raw.split("\n").map((line) => {
            const parts = line.split("|").map((s) => s.trim());
            return {
              description: parts[0] || "Accessorial",
              amount: Number(parts[1]) || 0,
            };
          }).filter((l) => l.amount > 0);
        }
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
      if (task.chargePhase === "dispute" || chargePhase === "dispute") {
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

    postJson("/dismissDashboardTask", {
      taskId: task.id,
      source: task.source,
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

  function clientFilterSort(items) {
    const q = String(els.workspaceSearch?.value || "").trim().toLowerCase();
    let list = items.slice();
    if (q) {
      list = list.filter((t) => {
        const hay = [
          t.loadNumber, t.carrierName, t.title, t.subject, t.reason, t.to,
        ].join(" ").toLowerCase();
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
      if (sort === "amount") {
        return (Number(b.chargesTotal) || 0) - (Number(a.chargesTotal) || 0);
      }
      const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
      const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
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
        '<p class="panel-empty">No open tasks in this folder.</p>';
      return;
    }

    const groups = new Map();
    list.forEach((t) => {
      const key = t.loadNumber || `id:${t.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    });

    let rows = "";
    for (const [loadKey, group] of groups) {
      if (group.length > 1 && !String(loadKey).startsWith("id:")) {
        rows += `<tr class="group-row"><td colspan="8">Load ${bodyEsc(loadKey)} · ${group.length} related tasks</td></tr>`;
      }
      group.forEach((task) => {
        const meta = taskTypeMeta(task);
        const high = Number(task.chargesTotal) >= HIGH_DOLLAR;
        const urgent = Boolean(task.isUrgentOld || task.ageLabel);
        const statusLabel = task.chargePhase === "dispute" ?
          "dispute" : (task.ownerBucket || "—");
        rows += `<tr class="${urgent ? "is-urgent" : ""} ${high ? "is-high-dollar" : ""}" data-task-id="${bodyEsc(task.id)}">
          <td><span class="type-badge ${meta.cls}">${bodyEsc(meta.label)}</span></td>
          <td>${task.loadNumber ?
            `<a class="load-link" href="#" data-load="${bodyEsc(task.loadNumber)}">${bodyEsc(task.loadNumber)}</a>` :
            "—"}</td>
          <td>${bodyEsc(shortText(task.carrierName, 28) || "—")}</td>
          <td>${bodyEsc(formatMoney(task.chargesTotal))}</td>
          <td>${bodyEsc(shortText(task.reason || task.description, 40) || "—")}</td>
          <td>${bodyEsc(statusLabel)}${urgent ? ' <span class="age-badge">URGENT/OLD</span>' : ""}</td>
          <td title="When Jerry logged this item (not Gmail received time)">${bodyEsc(formatLogTime(task.createdAt))}</td>
          <td class="row-actions">
            <button type="button" class="btn btn-sm btn-outline task-open">Review</button>
            <button type="button" class="btn btn-sm btn-ghost task-dismiss">Done</button>
          </td>
        </tr>`;
      });
    }

    els.tasksContainer.innerHTML =
      `<table class="data-table"><thead><tr>
        <th>Type</th><th>Load #</th><th>Carrier</th><th>Amount</th>
        <th>Reason</th><th>Status</th><th>Logged</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table>`;

    const byId = new Map(list.map((t) => [t.id, t]));
    els.tasksContainer.querySelectorAll("tbody tr[data-task-id]").forEach((tr) => {
      const task = byId.get(tr.dataset.taskId);
      if (!task) return;
      tr.addEventListener("click", (e) => {
        if (e.target.closest("a,button")) return;
        openTaskDrawer(task);
      });
      tr.querySelector(".task-open")?.addEventListener("click", (e) => {
        e.stopPropagation();
        openTaskDrawer(task);
      });
      tr.querySelector(".task-dismiss")?.addEventListener("click", (e) => {
        e.stopPropagation();
        dismissTaskOptimistic(task);
      });
      tr.querySelector(".load-link")?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openTaskDrawer(task);
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
    if (reset) {
      taskOffset = 0;
      taskHasMore = false;
      tasksCache = [];
      els.tasksContainer.innerHTML = '<p class="panel-empty">Loading…</p>';
    } else {
      updateTasksLoadMore(true);
    }
    try {
      const params = new URLSearchParams({
        limit: String(TASK_PAGE),
        offset: String(taskOffset),
      });
      if (chargePhase === "dispute") {
        params.set("chargePhase", "dispute");
      } else {
        params.set("ownerBucket", ownerBucket);
        if (dispatcherKey) params.set("dispatcherKey", dispatcherKey);
      }
      const data = await fetchJson(`/getDashboardTasks?${params}`);
      openTaskCount = data.openCount || 0;
      disputeCount = data.disputeCount != null ? data.disputeCount : disputeCount;
      bucketCounts = data.bucketCounts || bucketCounts;
      dispatchers = data.dispatchers || [];
      renderFolderCounts();
      const page = data.tasks || [];
      taskHasMore = Boolean(data.hasMore);
      taskOffset = data.nextOffset != null ? data.nextOffset : taskOffset + page.length;
      const scrollEl = getTasksScrollEl();
      const savedTop = (!reset && scrollEl) ? scrollEl.scrollTop : null;
      renderTasks(page, {append: !reset});
      if (savedTop != null && scrollEl) scrollEl.scrollTop = savedTop;
      updateTasksLoadMore(false);
    } catch (error) {
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
      <td>${bodyEsc(formatLogTime(inv.createdAt))}</td>
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

  function paintInvoices(list) {
    if (!list.length) {
      els.invoicesContainer.innerHTML =
        `<p class="panel-empty">${invoiceGroup === "completed" ?
          "No completed invoices in this page." :
          "No open invoices — nothing waiting."}</p>`;
      return;
    }
    els.invoicesContainer.innerHTML =
      `<table class="data-table"><thead><tr>
        <th>Vendor</th><th>Invoice</th><th>Load</th><th>PRO</th>
        <th>Amount</th><th>Received</th><th>Status</th>
      </tr></thead><tbody>${list.map(buildInvoiceRow).join("")}</tbody></table>`;
    const byId = new Map(list.map((i) => [i.id, i]));
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
    if (invoicesInFlight) {
      try { await invoicesInFlight; } catch (_) { /* ignore */ }
      if (!reset) return;
    }
    invoicesInFlight = (async () => {
      if (reset) {
        invoiceOffset = 0;
        invoiceHasMore = false;
        invoicesCache = [];
        setButtonBusy(els.refreshInvoicesBtn, true, "Refreshing…");
        els.invoicesContainer.innerHTML = '<p class="panel-empty">Loading…</p>';
      } else {
        updateLoadMoreButton(true);
      }
      try {
        const data = await fetchJson(
            `/getRecentInvoices?limit=${INVOICE_PAGE_SIZE}&offset=${invoiceOffset}` +
            `&statusGroup=${encodeURIComponent(invoiceGroup)}`,
        );
        const invoices = data.invoices || [];
        invoiceHasMore = typeof data.hasMore === "boolean" ?
          data.hasMore : invoices.length === INVOICE_PAGE_SIZE;
        invoiceOffset += invoices.length;
        if (reset) renderInvoices(invoices);
        else appendInvoices(invoices);
      } catch (error) {
        if (reset) {
          els.invoicesContainer.innerHTML =
            '<p class="panel-empty">Could not load invoices.</p>';
        } else {
          showError("Could not load more invoices.");
        }
        throw error;
      } finally {
        if (reset) setButtonBusy(els.refreshInvoicesBtn, false);
        updateLoadMoreButton(false);
      }
    })();
    try { await invoicesInFlight; } finally { invoicesInFlight = null; }
  }

  document.querySelectorAll("[data-invoice-group]").forEach((btn) => {
    btn.addEventListener("click", () => {
      invoiceGroup = btn.dataset.invoiceGroup;
      document.querySelectorAll("[data-invoice-group]").forEach((b) => {
        b.classList.toggle("is-active", b === btn);
      });
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
          <td>${bodyEsc(formatLogTime(n.createdAt))}</td>
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
      const data = await fetchJson(
          `/getDashboardNotifications?limit=${TASK_PAGE}&offset=${notifOffset}`);
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
  els.workspaceSearch?.addEventListener("input", () => {
    if (activeTab === "tasks") {
      withPreservedScroll(() => {
        renderTasks(tasksCache.slice(), {preserveCache: true});
      });
    } else if (activeTab === "invoices") {
      paintInvoices(clientFilterSort(invoicesCache));
    } else if (activeTab === "notifications") {
      const keep = notifsCache.slice();
      notifsCache = [];
      renderNotifications(keep);
    }
  });
  els.workspaceSort?.addEventListener("change", () => {
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
    setChatOpen(!chatOpen);
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
  loadInvoices({reset: true});
  loadTasks({reset: true});
  loadNotifications({reset: true});
})();
