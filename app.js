(function () {
  "use strict";

  const client = window.DASHBOARD_CONFIG;
  if (!client || !client.functionsBaseUrl) {
    document.getElementById("dashboardTitle").textContent =
      "Dashboard not configured";
    document.getElementById("dashboardMain").innerHTML =
      '<p class="error-banner">Missing window.DASHBOARD_CONFIG in config.js.</p>';
    return;
  }

  document.title = `${client.name} — Jerry`;
  // Keep the hero brand as "Jerry"; client name lives in the brand mark.

  const BASE_URL = client.functionsBaseUrl;
  const TENANT_ID = client.tenantId || "default";
  const TMS = (client.tms || "primus").toLowerCase();
  const tenantQuery = `tenantId=${encodeURIComponent(TENANT_ID)}`;

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
    rangeBtns: Array.from(document.querySelectorAll(".range-btn")),
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
    taskCountBadge: document.getElementById("taskCountBadge"),
    notifCountBadge: document.getElementById("notifCountBadge"),
    notificationsContainer: document.getElementById("notificationsContainer"),
    opsPrimaryHint: document.getElementById("opsPrimaryHint"),
    tabBtns: Array.from(document.querySelectorAll(".ops-tab")),
    tabPanelTasks: document.getElementById("tabPanelTasks"),
    tabPanelInvoices: document.getElementById("tabPanelInvoices"),
    tabPanelNotifications: document.getElementById("tabPanelNotifications"),
  };

  let chart = null;
  let activeRange = "week";
  let openTaskCount = 0;
  let openNotifCount = 0;
  let connectedMailboxEmail = null;
  let statsTotals = null;
  const INVOICE_PAGE_SIZE = 20;
  let invoiceOffset = 0;
  let invoiceHasMore = false;
  let statsInFlight = null;
  let invoicesInFlight = null;
  let activeTab = "tasks";
  let chargeFormTaskId = null;

  if (els.tmsBadge) {
    els.tmsBadge.hidden = false;
    els.tmsBadge.textContent = TMS === "tai" ? "TAI TMS" : "Primus TMS";
    els.tmsBadge.className = `tms-badge tms-${TMS}`;
  }
  if (els.tenantLabel) {
    els.tenantLabel.hidden = false;
    els.tenantLabel.textContent = `Tenant: ${TENANT_ID}`;
  }
  if (els.taiHintBanner && TMS === "tai") {
    els.taiHintBanner.hidden = false;
  }

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
    els.rangeBtns.forEach((btn) => {
      btn.disabled = disabled;
    });
  }

  function showRunResult(message, isError) {
    const banner = els.runResultBanner;
    if (!banner) return;
    if (!message) {
      banner.hidden = true;
      banner.textContent = "";
      banner.classList.remove("is-error", "is-success");
      return;
    }
    banner.hidden = false;
    banner.textContent = message;
    banner.classList.toggle("is-error", !!isError);
    banner.classList.toggle("is-success", !isError);
  }

  function showError(message) {
    if (!message) {
      els.errorBanner.hidden = true;
      els.errorBanner.textContent = "";
      return;
    }
    els.errorBanner.hidden = false;
    els.errorBanner.textContent = message;
  }

  function bodyEsc(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatLogTime(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    return isNaN(d) ? ts : d.toLocaleString(undefined, {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  function formatMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return `$${n.toFixed(2)}`;
  }

  function statusClass(status) {
    const s = String(status || "").toLowerCase();
    if (s === "completed") return "status-completed";
    if (s === "running") return "status-running";
    if (s === "waiting_manual" || s === "failed") return "status-attention";
    return "status-neutral";
  }

  function todayEasternIsoDate() {
    return new Date().toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });
  }

  async function fetchJson(path) {
    const sep = path.includes("?") ? "&" : "?";
    const response = await fetch(`${BASE_URL}${path}${sep}${tenantQuery}`);
    if (!response.ok) {
      throw new Error(`Request to ${path} failed (${response.status})`);
    }
    return response.json();
  }

  async function postJson(path, body) {
    const response = await fetch(`${BASE_URL}${path}?${tenantQuery}`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({...(body || {}), tenantId: TENANT_ID}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Request to ${path} failed (${response.status})`);
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
    Object.entries(panels).forEach(([key, panel]) => {
      if (!panel) return;
      const on = key === tab;
      panel.classList.toggle("is-active", on);
      panel.hidden = !on;
    });
    if (els.refreshTasksBtn) els.refreshTasksBtn.hidden = tab !== "tasks";
    if (els.refreshInvoicesBtn) els.refreshInvoicesBtn.hidden = tab !== "invoices";
    if (els.refreshNotifsBtn) els.refreshNotifsBtn.hidden = tab !== "notifications";
  }

  els.tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  async function exportLogsCsvForSelectedDay() {
    const day = els.logExportDate && els.logExportDate.value;
    if (!day) {
      showError("Pick a date to export.");
      return;
    }
    setButtonBusy(els.exportLogsCsvBtn, true, "Exporting…");
    showError("");
    try {
      const url =
        `${BASE_URL}/exportLogsCsv?${tenantQuery}&date=${encodeURIComponent(day)}`;
      const response = await fetch(url);
      if (!response.ok) {
        let errMsg = `Export failed (${response.status})`;
        try {
          const errJson = await response.json();
          if (errJson.error) errMsg = errJson.error;
        } catch (_) { /* ignore */ }
        throw new Error(errMsg);
      }
      const blob = await response.blob();
      let filename = `jerry-logs-${day}.csv`;
      const disposition = response.headers.get("Content-Disposition");
      const match = disposition && disposition.match(/filename="([^"]+)"/);
      if (match) filename = match[1];
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      showError(error.message || "Could not export logs.");
    } finally {
      setButtonBusy(els.exportLogsCsvBtn, false);
    }
  }

  async function loadMailStatus() {
    try {
      const data = await fetchJson("/getMailStatus");
      const provider = data.provider === "gmail" ? "Gmail" : "Outlook";
      connectedMailboxEmail = data.connectedEmail || null;
      if (data.connected) {
        els.badge.textContent = `${provider} connected`;
        els.badge.className = "badge badge-connected";
        els.connectBtn.textContent = `Reconnect ${provider}`;
        els.disconnectBtn.hidden = false;
        if (els.connectedMailbox && connectedMailboxEmail) {
          const name = data.connectedDisplayName ?
            `${data.connectedDisplayName} · ` : "";
          els.connectedMailbox.textContent =
            `${name}${connectedMailboxEmail}`;
          els.connectedMailbox.hidden = false;
        }
      } else {
        els.badge.textContent = `${provider} not connected`;
        els.badge.className = "badge badge-disconnected";
        els.connectBtn.textContent = `Connect ${provider}`;
        els.disconnectBtn.hidden = true;
        connectedMailboxEmail = null;
        if (els.connectedMailbox) els.connectedMailbox.hidden = true;
      }
    } catch (error) {
      els.badge.textContent = "Status unavailable";
      els.badge.className = "badge badge-unknown";
      console.error("loadMailStatus failed:", error);
    }
  }

  function taskTypeLabel(type) {
    return String(type || "task").replace(/_/g, " ");
  }

  function isAdditionalChargeTask(task) {
    return task.type === "additional_charge" ||
      task.source === "additionalCharges";
  }

  function renderChargeButtons(task) {
    if (!isAdditionalChargeTask(task) || !task.invoiceId) return "";
    const opts = ["a", "b", "c", "d", "e"].map((opt) =>
      `<button type="button" class="btn btn-outline btn-sm charge-opt" ` +
      `data-charge-opt="${opt}" data-invoice="${bodyEsc(task.invoiceId)}" ` +
      `data-task-id="${bodyEsc(task.id)}" data-task-source="${bodyEsc(task.source || "dashboardTasks")}" ` +
      `title="${bodyEsc(CHARGE_LABELS[opt])}">${opt.toUpperCase()}</button>`
    ).join("");
    return `<div class="charge-options" data-charge-row="${bodyEsc(task.id)}">${opts}</div>` +
      `<div class="charge-opt-form" data-charge-form="${bodyEsc(task.id)}" hidden></div>`;
  }

  function renderTasks(tasks) {
    openTaskCount = tasks ? tasks.length : 0;
    if (els.taskCountBadge) {
      els.taskCountBadge.textContent = String(openTaskCount);
    }

    if (!tasks || tasks.length === 0) {
      els.tasksContainer.innerHTML =
        '<p class="panel-empty">No open tasks — you\'re all caught up.</p>';
      return;
    }

    els.tasksContainer.innerHTML = tasks.map((task) => {
      const meta = [
        task.loadNumber ? `Load ${bodyEsc(task.loadNumber)}` : "",
        task.carrierName ? bodyEsc(shortText(task.carrierName, 28)) : "",
        task.chargesTotal ? formatMoney(task.chargesTotal) : "",
        formatLogTime(task.createdAt),
      ].filter(Boolean).join(" · ");
      const title = shortText(task.title || "Task", 80);
      return `<article class="task-card" data-id="${bodyEsc(task.id)}" data-source="${bodyEsc(task.source || "dashboardTasks")}">
        <div class="task-main">
          <div class="task-title-row">
            <h3 class="task-title">${bodyEsc(title)}</h3>
            <span class="task-type-pill">${bodyEsc(taskTypeLabel(task.type))}</span>
          </div>
          ${meta ? `<p class="task-meta">${meta}</p>` : ""}
          ${renderChargeButtons(task)}
          <div class="task-actions">
            <button type="button" class="btn btn-outline btn-sm task-dismiss-btn">Done</button>
          </div>
        </div>
      </article>`;
    }).join("");

    bindTaskActions();
  }

  function bindTaskActions() {
    els.tasksContainer.querySelectorAll(".task-dismiss-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const card = btn.closest(".task-card");
        setButtonBusy(btn, true, "Dismissing…");
        try {
          await postJson("/dismissDashboardTask", {
            taskId: card.dataset.id,
            source: card.dataset.source,
          });
          card.remove();
          openTaskCount = els.tasksContainer.querySelectorAll(".task-card").length;
          if (els.taskCountBadge) {
            els.taskCountBadge.textContent = String(openTaskCount);
          }
          if (!openTaskCount) {
            els.tasksContainer.innerHTML =
              '<p class="panel-empty">No open tasks — you\'re all caught up.</p>';
          }
        } catch (error) {
          showError(error.message || "Could not dismiss task.");
          setButtonBusy(btn, false);
        }
      });
    });

    els.tasksContainer.querySelectorAll(".charge-opt").forEach((btn) => {
      btn.addEventListener("click", () => openChargeForm(btn));
    });
  }

  function openChargeForm(btn) {
    const opt = btn.dataset.chargeOpt;
    const invoiceId = btn.dataset.invoice;
    const taskId = btn.dataset.taskId;
    const taskSource = btn.dataset.taskSource;
    const form = els.tasksContainer.querySelector(
        `[data-charge-form="${taskId}"]`);
    if (!form) return;
    chargeFormTaskId = taskId;

    if (opt === "c" || opt === "d") {
      form.hidden = false;
      form.innerHTML =
        `<p><strong>${bodyEsc(CHARGE_LABELS[opt])}</strong></p>` +
        `<div class="task-actions">` +
        `<button type="button" class="btn btn-sm charge-confirm" data-opt="${opt}">Confirm ${opt.toUpperCase()}</button>` +
        `<button type="button" class="btn btn-outline btn-sm charge-cancel">Cancel</button>` +
        `</div>`;
    } else if (opt === "a" || opt === "e") {
      form.hidden = false;
      form.innerHTML =
        `<p><strong>${bodyEsc(CHARGE_LABELS[opt])}</strong></p>` +
        `<label>Customer charge amount ($)</label>` +
        `<input type="number" min="0.01" step="0.01" class="charge-amount" />` +
        `<div class="task-actions">` +
        `<button type="button" class="btn btn-sm charge-confirm" data-opt="${opt}">Confirm ${opt.toUpperCase()}</button>` +
        `<button type="button" class="btn btn-outline btn-sm charge-cancel">Cancel</button>` +
        `</div>`;
    } else {
      form.hidden = false;
      form.innerHTML =
        `<p><strong>${bodyEsc(CHARGE_LABELS.b)}</strong></p>` +
        `<label>Customer bill lines (one per line: description | amount)</label>` +
        `<textarea class="charge-lines" rows="3" placeholder="Liftgate|75&#10;Detention|150"></textarea>` +
        `<div class="task-actions">` +
        `<button type="button" class="btn btn-sm charge-confirm" data-opt="b">Confirm B</button>` +
        `<button type="button" class="btn btn-outline btn-sm charge-cancel">Cancel</button>` +
        `</div>`;
    }

    form.querySelector(".charge-cancel").addEventListener("click", () => {
      form.hidden = true;
      form.innerHTML = "";
    });
    form.querySelector(".charge-confirm").addEventListener("click", async () => {
      const confirmBtn = form.querySelector(".charge-confirm");
      setButtonBusy(confirmBtn, true, "Applying…");
      try {
        const payload = {
          invoiceId,
          option: opt,
          taskId,
          taskSource,
        };
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
        await postJson("/dashboardAdditionalChargeDecision", payload);
        showRunResult(`Option ${opt.toUpperCase()} applied for ${invoiceId}.`, false);
        await loadTasks();
        await loadNotifications();
      } catch (error) {
        showError(error.message || "Could not apply decision.");
        setButtonBusy(confirmBtn, false);
      }
    });
  }

  async function loadTasks() {
    els.tasksContainer.innerHTML = '<p class="panel-empty">Loading...</p>';
    try {
      const data = await fetchJson("/getDashboardTasks?limit=50");
      renderTasks(data.tasks || []);
    } catch (error) {
      els.tasksContainer.innerHTML =
        '<p class="panel-empty">Could not load tasks.</p>';
      console.error("loadTasks failed:", error);
    }
  }

  function buildInvoiceRow(inv) {
    const status = inv.displayLabel || inv.displayStatus ||
      inv.finalWorkflowStatus || inv.decisionStage || "—";
    const taiCol = TMS === "tai" ?
      `<td>${inv.taiShipmentId || "—"}</td>` : "";
    return `<tr>
      <td class="log-time">${formatLogTime(inv.createdAt)}</td>
      <td>${inv.loadNumber || "—"}</td>
      <td>${inv.proNumber || "—"}</td>
      <td>${inv.carrierName || "—"}</td>
      <td>${formatMoney(inv.invoiceAmount)}</td>
      ${taiCol}
      <td><span class="status-pill ${statusClass(status)}">${status}</span></td>
      <td class="log-message">${inv.decisionReason || inv.currentStep || "—"}</td>
    </tr>`;
  }

  function updateLoadMoreButton(loading) {
    if (!els.invoicesLoadMoreWrap || !els.loadMoreInvoicesBtn) return;
    if (!invoiceHasMore) {
      els.invoicesLoadMoreWrap.hidden = true;
      return;
    }
    els.invoicesLoadMoreWrap.hidden = false;
    els.loadMoreInvoicesBtn.disabled = Boolean(loading);
    els.loadMoreInvoicesBtn.textContent = loading ? "Loading..." : "Load more";
  }

  function renderInvoices(invoices) {
    if (!invoices || invoices.length === 0) {
      els.invoicesContainer.innerHTML =
        '<p class="panel-empty">No invoices yet.</p>';
      updateLoadMoreButton(false);
      return;
    }
    const taiHeader = TMS === "tai" ? "<th>TAI Shipment</th>" : "";
    els.invoicesContainer.innerHTML =
      `<table class="logs-table">
        <thead><tr>
          <th>Created</th><th>Load #</th><th>PRO</th><th>Carrier</th>
          <th>Amount</th>${taiHeader}<th>Status</th><th>Detail</th>
        </tr></thead>
        <tbody>${invoices.map(buildInvoiceRow).join("")}</tbody>
      </table>`;
    updateLoadMoreButton(false);
  }

  function appendInvoices(invoices) {
    if (!invoices || !invoices.length) {
      updateLoadMoreButton(false);
      return;
    }
    const tbody = els.invoicesContainer.querySelector("tbody");
    if (!tbody) {
      renderInvoices(invoices);
      return;
    }
    tbody.insertAdjacentHTML("beforeend", invoices.map(buildInvoiceRow).join(""));
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
        setButtonBusy(els.refreshInvoicesBtn, true, "Refreshing…");
        els.invoicesContainer.innerHTML =
          '<p class="panel-empty">Loading...</p>';
      } else {
        updateLoadMoreButton(true);
      }
      try {
        const data = await fetchJson(
            `/getRecentInvoices?limit=${INVOICE_PAGE_SIZE}&offset=${invoiceOffset}`,
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

  function shortText(value, max) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    if (text.length <= max) return text;
    return text.slice(0, max - 1).trimEnd() + "…";
  }

  function emailLocal(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const angle = raw.match(/<([^>]+)>/);
    const email = (angle ? angle[1] : raw).trim();
    const local = email.split("@")[0] || email;
    return shortText(local, 28);
  }

  function notifKind(n) {
    if (n.type === "additional_charge") {
      return {label: "Extra charge", tone: "charge"};
    }
    if (n.type === "unhandled_email") {
      return {label: "Needs review", tone: "review"};
    }
    if (n.type === "ops_email") {
      return {label: "Alert", tone: "alert"};
    }
    return {label: "Notice", tone: "alert"};
  }

  function notifHeadline(n) {
    if (n.type === "additional_charge") {
      const load = n.loadNumber ? `Load ${n.loadNumber}` : "Load —";
      const amt = n.chargesTotal != null && n.chargesTotal !== "" ?
        formatMoney(n.chargesTotal) : "";
      return amt ? `${load} · ${amt}` : load;
    }
    if (n.type === "unhandled_email") {
      return shortText(n.reason || n.subject || n.title || "Review this email", 72);
    }
    return shortText(n.subject || n.title || "Alert", 72);
  }

  function notifSubline(n) {
    const bits = [];
    if (n.from) bits.push(emailLocal(n.from));
    else if (n.to) bits.push("To " + emailLocal(n.to));
    if (n.loadNumber && n.type !== "additional_charge") {
      bits.push("Load " + String(n.loadNumber));
    }
    if (n.carrierName) bits.push(shortText(n.carrierName, 24));
    return bits.filter(Boolean).join(" · ");
  }

  function decodeHtmlEntities(value) {
    const el = document.createElement("textarea");
    el.innerHTML = String(value || "");
    return el.value;
  }

  function cleanEmailPlainText(raw) {
    let s = String(raw || "");
    if (!s.trim()) return "";

    // Quoted-printable leftovers from some mail paths.
    s = s.replace(/=\r?\n/g, "");
    s = s.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => {
      try { return String.fromCharCode(parseInt(hex, 16)); } catch (_) { return ""; }
    });

    const looksHtml = /<\/?[a-z][\s\S]*>/i.test(s) || /&(?:nbsp|amp|lt|gt|#\d+|#x[0-9a-f]+);/i.test(s);
    if (looksHtml) {
      try {
        const doc = new DOMParser().parseFromString(s, "text/html");
        doc.querySelectorAll("script, style, noscript, head").forEach((el) => el.remove());
        doc.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
        ["p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "blockquote", "pre"]
          .forEach((tag) => {
            doc.querySelectorAll(tag).forEach((el) => {
              el.append("\n");
            });
          });
        s = doc.body ? (doc.body.innerText || doc.body.textContent || "") : s;
      } catch (_) {
        s = s
          .replace(/<\s*br\s*\/?>/gi, "\n")
          .replace(/<\/\s*(p|div|tr|li|h[1-6]|blockquote)\s*>/gi, "\n")
          .replace(/<[^>]+>/g, " ");
      }
      s = decodeHtmlEntities(s);
    }

    s = s
      .replace(/\u00a0/g, " ")
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/\[cid:[^\]]+\]/gi, "")
      .replace(/https?:\/\/\S+/g, (url) => {
        // Keep short links readable; drop tracking junk tails later if needed.
        return url.length > 90 ? url.slice(0, 87) + "..." : url;
      })
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([a-zA-Z])(\d)/g, "$1 $2")
      .replace(/(\d)([a-zA-Z])/g, "$1 $2")
      .replace(/ {2,}/g, " ")
      .trim();

    // Drop near-empty symbol-only lines (----, ====, ****).
    s = s
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !/^[\-_=*~.|]{3,}$/.test(line))
      .join("\n")
      .trim();

    return s;
  }

  function notifEmailBody(n) {
    const cleaned = cleanEmailPlainText(n.body);
    if (cleaned) return cleaned;
    if (n.type === "additional_charge") {
      return "Open Tasks to choose A-E for this charge.";
    }
    return "No email body saved.";
  }

  function renderNotifications(items, opsPrimary) {
    openNotifCount = items ? items.length : 0;
    if (els.notifCountBadge) {
      els.notifCountBadge.textContent = String(openNotifCount);
    }
    if (els.opsPrimaryHint) {
      els.opsPrimaryHint.hidden = !opsPrimary;
    }
    if (!items || !items.length) {
      els.notificationsContainer.innerHTML =
        '<p class="panel-empty">No open notifications.</p>';
      return;
    }

    els.notificationsContainer.innerHTML = items.map((n) => {
      const kind = notifKind(n);
      const unhandled = n.type === "unhandled_email";
      const charge = n.type === "additional_charge";
      const sub = notifSubline(n);
      const metaRows = [
        n.from ? ["From", n.from] : null,
        n.to ? ["To", n.to] : null,
        n.cc ? ["Cc", n.cc] : null,
        n.subject ? ["Subject", n.subject] : null,
        n.loadNumber ? ["Load", n.loadNumber] : null,
        n.carrierName ? ["Carrier", n.carrierName] : null,
      ].filter(Boolean);
      return `<article class="notif-card tone-${kind.tone}" data-notif-id="${bodyEsc(n.id)}" data-notif-type="${bodyEsc(n.type || "")}">
        <button type="button" class="notif-row" aria-expanded="false">
          <span class="notif-kind kind-${kind.tone}">${bodyEsc(kind.label)}</span>
          <span class="notif-title">${bodyEsc(notifHeadline(n))}</span>
          <span class="notif-sub">${bodyEsc(sub)}</span>
          <time class="notif-when">${bodyEsc(formatLogTime(n.createdAt))}</time>
          <span class="notif-chevron" aria-hidden="true"></span>
        </button>
        <div class="notif-expand" hidden>
          <dl class="notif-meta-grid">
            ${metaRows.map(([k, v]) =>
              `<div><dt>${bodyEsc(k)}</dt><dd>${bodyEsc(v)}</dd></div>`
            ).join("")}
          </dl>
          <pre class="notif-body">${bodyEsc(notifEmailBody(n))}</pre>
          <div class="task-actions">
            <button type="button" class="btn btn-outline btn-sm notif-dismiss">Done</button>
            <button type="button" class="btn btn-ghost btn-sm notif-flag">Flag</button>
            ${unhandled ? `
              <button type="button" class="btn btn-outline btn-sm notif-reply">Reply</button>
              <button type="button" class="btn btn-danger btn-sm notif-delete">Delete</button>
            ` : ""}
            ${charge ? `
              <button type="button" class="btn btn-primary btn-sm notif-goto-tasks">Open Tasks</button>
            ` : ""}
          </div>
          <div class="flag-form" hidden></div>
          <div class="reply-form" hidden></div>
        </div>
      </article>`;
    }).join("");

    bindNotificationActions();
  }

  function countNotifCards() {
    return els.notificationsContainer.querySelectorAll(".notif-card").length;
  }

  function afterNotifRemoved() {
    openNotifCount = countNotifCards();
    if (els.notifCountBadge) {
      els.notifCountBadge.textContent = String(openNotifCount);
    }
    if (!openNotifCount) {
      els.notificationsContainer.innerHTML =
        '<p class="panel-empty">No open notifications.</p>';
    }
  }

  function bindNotificationActions() {
    els.notificationsContainer.querySelectorAll(".notif-row").forEach((row) => {
      row.addEventListener("click", () => {
        const card = row.closest(".notif-card");
        const panel = card.querySelector(".notif-expand");
        const open = card.classList.toggle("is-open");
        panel.hidden = !open;
        row.setAttribute("aria-expanded", open ? "true" : "false");
      });
    });

    els.notificationsContainer.querySelectorAll(".notif-goto-tasks").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        switchTab("tasks");
      });
    });

    els.notificationsContainer.querySelectorAll(".notif-dismiss").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const card = btn.closest(".notif-card");
        setButtonBusy(btn, true, "...");
        try {
          await postJson("/dismissDashboardNotification", {id: card.dataset.notifId});
          card.remove();
          afterNotifRemoved();
        } catch (error) {
          showError(error.message);
          setButtonBusy(btn, false);
        }
      });
    });

    els.notificationsContainer.querySelectorAll(".notif-flag").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const card = btn.closest(".notif-card");
        const form = card.querySelector(".flag-form");
        form.hidden = false;
        form.innerHTML =
          `<label>What went wrong?</label>` +
          `<textarea class="flag-note" rows="2" required placeholder="Short note..."></textarea>` +
          `<div class="task-actions">` +
          `<button type="button" class="btn btn-sm flag-submit">Send for review</button>` +
          `<button type="button" class="btn btn-ghost btn-sm flag-cancel">Cancel</button>` +
          `</div>`;
        form.querySelector(".flag-cancel").onclick = () => {
          form.hidden = true;
          form.innerHTML = "";
        };
        form.querySelector(".flag-submit").onclick = async () => {
          const note = form.querySelector(".flag-note").value.trim();
          const submit = form.querySelector(".flag-submit");
          setButtonBusy(submit, true, "Sending...");
          try {
            await postJson("/flagDashboardNotification", {
              id: card.dataset.notifId,
              note,
            });
            showRunResult("Sent for review.", false);
            card.remove();
            afterNotifRemoved();
          } catch (error) {
            showError(error.message);
            setButtonBusy(submit, false);
          }
        };
      });
    });

    els.notificationsContainer.querySelectorAll(".notif-reply").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const card = btn.closest(".notif-card");
        const form = card.querySelector(".reply-form");
        form.hidden = false;
        form.innerHTML =
          `<label>Reply</label>` +
          `<textarea class="reply-text" rows="3" placeholder="Your reply..."></textarea>` +
          `<div class="task-actions">` +
          `<button type="button" class="btn btn-sm reply-submit">Send</button>` +
          `<button type="button" class="btn btn-ghost btn-sm reply-cancel">Cancel</button>` +
          `</div>`;
        form.querySelector(".reply-cancel").onclick = () => {
          form.hidden = true;
          form.innerHTML = "";
        };
        form.querySelector(".reply-submit").onclick = async () => {
          const replyText = form.querySelector(".reply-text").value.trim();
          const submit = form.querySelector(".reply-submit");
          setButtonBusy(submit, true, "Sending...");
          try {
            await postJson("/replyDashboardEmail", {
              id: card.dataset.notifId,
              replyText,
            });
            showRunResult("Reply sent.", false);
            card.remove();
            afterNotifRemoved();
          } catch (error) {
            showError(error.message);
            setButtonBusy(submit, false);
          }
        };
      });
    });

    els.notificationsContainer.querySelectorAll(".notif-delete").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Trash the original email?")) return;
        const card = btn.closest(".notif-card");
        setButtonBusy(btn, true, "Deleting...");
        try {
          await postJson("/deleteDashboardEmail", {id: card.dataset.notifId});
          card.remove();
          afterNotifRemoved();
          showRunResult("Email deleted.", false);
        } catch (error) {
          showError(error.message);
          setButtonBusy(btn, false);
        }
      });
    });
  }

  async function loadNotifications() {
    els.notificationsContainer.innerHTML =
      '<p class="panel-empty">Loading...</p>';
    try {
      const data = await fetchJson("/getDashboardNotifications?limit=50");
      renderNotifications(data.notifications || [], data.opsPrimary);
    } catch (error) {
      els.notificationsContainer.innerHTML =
        '<p class="panel-empty">Could not load notifications. Deploy the new dashboard APIs if this persists.</p>';
      console.error("loadNotifications failed:", error);
    }
  }

  function formatPeriodLabel(period, range) {
    const date = new Date(period);
    if (range === "day") {
      return date.toLocaleTimeString(undefined, {
        hour: "numeric", minute: "2-digit",
      });
    }
    if (range === "year") {
      return date.toLocaleDateString(undefined, {month: "short", year: "numeric"});
    }
    return date.toLocaleDateString(undefined, {month: "short", day: "numeric"});
  }

  function renderChart(series, range) {
    const labels = series.map((row) => formatPeriodLabel(row.period, range));
    const datasets = [
      {
        label: "Invoices processed",
        data: series.map((row) => row.invoicesProcessed),
        borderColor: "#0d6e6e",
        backgroundColor: "#0d6e6e",
        tension: 0.35,
      },
      {
        label: "With added charges",
        data: series.map((row) => row.invoicesWithAddedCharges || 0),
        borderColor: "#c47a12",
        backgroundColor: "#c47a12",
        tension: 0.35,
      },
      {
        label: "Emails replied",
        data: series.map((row) => row.emailsReplied),
        borderColor: "#1a7f4b",
        backgroundColor: "#1a7f4b",
        tension: 0.35,
      },
      {
        label: "Emails forwarded for review",
        data: series.map((row) => row.emailsForwarded),
        borderColor: "#c0392b",
        backgroundColor: "#c0392b",
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
              boxWidth: 10,
              boxHeight: 10,
              usePointStyle: true,
              pointStyle: "circle",
              font: {family: "'Instrument Sans', system-ui, sans-serif", size: 12},
              color: "#5c6b76",
            },
          },
        },
        scales: {
          x: {
            grid: {display: false},
            ticks: {color: "#5c6b76", font: {size: 11}},
          },
          y: {
            beginAtZero: true,
            ticks: {precision: 0, color: "#5c6b76", font: {size: 11}},
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
        el.textContent = "Loading...";
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

  els.connectBtn.addEventListener("click", () => {
    setButtonBusy(els.connectBtn, true, "Connecting…");
    window.location.href = `${BASE_URL}/mailConnect?${tenantQuery}`;
  });

  els.disconnectBtn.addEventListener("click", async () => {
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

  els.refreshInvoicesBtn.addEventListener("click", () => loadInvoices({reset: true}));
  if (els.refreshTasksBtn) {
    els.refreshTasksBtn.addEventListener("click", () => loadTasks());
  }
  if (els.refreshNotifsBtn) {
    els.refreshNotifsBtn.addEventListener("click", () => loadNotifications());
  }
  if (els.loadMoreInvoicesBtn) {
    els.loadMoreInvoicesBtn.addEventListener("click", () => {
      if (invoiceHasMore) loadInvoices({reset: false});
    });
  }
  if (els.logExportDate) els.logExportDate.value = todayEasternIsoDate();
  if (els.exportLogsCsvBtn) {
    els.exportLogsCsvBtn.addEventListener("click", exportLogsCsvForSelectedDay);
  }

  // ---- Support chat (unchanged behavior) ----
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
    chatEls.toggle.classList.toggle("is-open", chatOpen);
    chatEls.toggle.setAttribute("aria-expanded", chatOpen ? "true" : "false");
    if (chatOpen) {
      chatEls.input.focus();
      if (!chatStarted) {
        chatStarted = true;
        appendChatMessage(
            "bot",
            `Hi! I am Jerry, the support assistant for ${client.name}. ` +
            "Ask about a load number, invoice status, or anything on " +
            "the dashboard.",
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
    } catch (error) {
      pending.remove();
      appendChatMessage("bot", "Sorry, I couldn't reach the support assistant.");
    } finally {
      chatBusy = false;
      chatEls.input.disabled = false;
      chatEls.input.focus();
    }
  }

  if (chatEls.toggle && chatEls.panel) {
    chatEls.toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      setChatOpen(!chatOpen);
    });
    if (chatEls.headerToggle) {
      chatEls.headerToggle.addEventListener("click", (event) => {
        event.stopPropagation();
        if (chatOpen) setChatOpen(false);
      });
    }
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
  loadTasks();
  loadNotifications();
})();
