(function () {
  "use strict";

  const client = window.DASHBOARD_CONFIG;
  if (!client || !client.functionsBaseUrl) {
    document.getElementById("dashboardTitle").textContent = "Dashboard not configured";
    document.getElementById("dashboardMain").innerHTML =
      '<p class="error-banner">Missing window.DASHBOARD_CONFIG in config.js.</p>';
    return;
  }

  document.title = `${client.name} — Dashboard`;
  document.getElementById("dashboardTitle").textContent = `${client.name} Dashboard`;

  const BASE_URL = client.functionsBaseUrl;
  const TENANT_ID = client.tenantId || "default";
  const TMS = (client.tms || "primus").toLowerCase();
  const tenantQuery = `tenantId=${encodeURIComponent(TENANT_ID)}`;

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
    invoicesContainer: document.getElementById("invoicesContainer"),
    invoicesLoadMoreWrap: document.getElementById("invoicesLoadMoreWrap"),
    loadMoreInvoicesBtn: document.getElementById("loadMoreInvoicesBtn"),
    tasksContainer: document.getElementById("tasksContainer"),
    taskCountBadge: document.getElementById("taskCountBadge"),
  };

  let chart = null;
  let activeRange = "week";
  let openTaskCount = 0;
  let connectedMailboxEmail = null;
  let statsTotals = null;
  const INVOICE_PAGE_SIZE = 20;
  let invoiceOffset = 0;
  let invoiceHasMore = false;
  let statsInFlight = null;
  let invoicesInFlight = null;

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

  // TMS badge + tenant label
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

  function todayEasternIsoDate() {
    return new Date().toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });
  }

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
        } catch (_) {
          /* not JSON */
        }
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
      console.error("exportLogsCsvForSelectedDay failed:", error);
    } finally {
      setButtonBusy(els.exportLogsCsvBtn, false);
    }
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
      body: body ? JSON.stringify({...body, tenantId: TENANT_ID}) : undefined,
    });
    if (!response.ok) {
      throw new Error(`Request to ${path} failed (${response.status})`);
    }
    return response.json();
  }

  async function loadMailStatus() {
    try {
      const data = await fetchJson("/getMailStatus");
      const provider =
        data.provider === "gmail" ? "Gmail" : "Outlook";
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
          els.connectedMailbox.title =
            "Jerry is reading unread mail from this inbox";
        } else if (els.connectedMailbox) {
          els.connectedMailbox.hidden = true;
          els.connectedMailbox.textContent = "";
        }
      } else {
        els.badge.textContent = `${provider} not connected`;
        els.badge.className = "badge badge-disconnected";
        els.connectBtn.textContent = `Connect ${provider}`;
        els.disconnectBtn.hidden = true;
        connectedMailboxEmail = null;
        if (els.connectedMailbox) {
          els.connectedMailbox.hidden = true;
          els.connectedMailbox.textContent = "";
        }
      }
    } catch (error) {
      els.badge.textContent = "Status unavailable";
      els.badge.className = "badge badge-unknown";
      connectedMailboxEmail = null;
      if (els.connectedMailbox) {
        els.connectedMailbox.hidden = true;
        els.connectedMailbox.textContent = "";
      }
      console.error("loadMailStatus failed:", error);
    }
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

  function bodyEsc(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function taskTypeLabel(type) {
    return String(type || "task").replace(/_/g, " ");
  }

  function renderTasks(tasks) {
    openTaskCount = tasks ? tasks.length : 0;
    if (els.taskCountBadge) {
      els.taskCountBadge.textContent = `${openTaskCount} open`;
    }

    if (!tasks || tasks.length === 0) {
      els.tasksContainer.innerHTML =
        '<p class="panel-empty">No open tasks — you\'re all caught up.</p>';
      return;
    }

    els.tasksContainer.innerHTML = tasks.map((task) => {
      const meta = [
        task.loadNumber ? `Load ${bodyEsc(task.loadNumber)}` : "",
        task.carrierName ? bodyEsc(task.carrierName) : "",
        task.chargesTotal ? formatMoney(task.chargesTotal) : "",
      ].filter(Boolean).join(" · ");
      return `<article class="task-card" data-id="${bodyEsc(task.id)}" data-source="${bodyEsc(task.source || "dashboardTasks")}">
        <div class="task-main">
          <div class="task-title-row">
            <h3 class="task-title">${bodyEsc(task.title || "Task")}</h3>
            <span class="task-type-pill">${bodyEsc(taskTypeLabel(task.type))}</span>
          </div>
          ${meta ? `<p class="task-meta">${meta}</p>` : ""}
          ${task.description ? `<p class="task-desc">${bodyEsc(task.description)}</p>` : ""}
          <p class="task-time">${formatLogTime(task.createdAt)}</p>
        </div>
        <button type="button" class="btn btn-outline btn-sm task-dismiss-btn">Dismiss</button>
      </article>`;
    }).join("");

    els.tasksContainer.querySelectorAll(".task-dismiss-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const card = btn.closest(".task-card");
        const taskId = card.dataset.id;
        const source = card.dataset.source;
        setButtonBusy(btn, true, "Dismissing…");
        try {
          await postJson("/dismissDashboardTask", {taskId, source});
          card.remove();
          openTaskCount = els.tasksContainer.querySelectorAll(".task-card").length;
          if (els.taskCountBadge) {
            els.taskCountBadge.textContent = `${openTaskCount} open`;
          }
          if (!openTaskCount) {
            els.tasksContainer.innerHTML =
              '<p class="panel-empty">No open tasks — you\'re all caught up.</p>';
          }
        } catch (error) {
          showError("Could not dismiss task. Please try again.");
          setButtonBusy(btn, false);
          console.error("dismissTask failed:", error);
        }
      });
    });
  }

  async function loadTasks() {
    els.tasksContainer.innerHTML =
      '<p class="panel-empty">thinking</p>';
    try {
      const data = await fetchJson("/getDashboardTasks?limit=50");
      renderTasks(data.tasks || []);
    } catch (error) {
      els.tasksContainer.innerHTML =
        '<p class="panel-empty">Could not load tasks. Deploy getDashboardTasks ' +
        "to enable the task manager.</p>";
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
    if (!els.invoicesLoadMoreWrap || !els.loadMoreInvoicesBtn) {
      return;
    }
    if (!invoiceHasMore) {
      els.invoicesLoadMoreWrap.hidden = true;
      els.loadMoreInvoicesBtn.disabled = false;
      els.loadMoreInvoicesBtn.textContent = "Load more";
      return;
    }
    els.invoicesLoadMoreWrap.hidden = false;
    els.loadMoreInvoicesBtn.disabled = Boolean(loading);
    els.loadMoreInvoicesBtn.textContent = loading ? "thinking" : "Load more";
  }

  function renderInvoices(invoices) {
    if (!invoices || invoices.length === 0) {
      els.invoicesContainer.innerHTML =
        '<p class="panel-empty">No invoices yet.</p>';
      updateLoadMoreButton(false);
      return;
    }

    const taiHeader = TMS === "tai" ? "<th>TAI Shipment</th>" : "";
    const rows = invoices.map(buildInvoiceRow).join("");

    els.invoicesContainer.innerHTML =
      `<table class="logs-table">
        <thead><tr>
          <th>Created</th><th>Load #</th><th>PRO</th><th>Carrier</th>
          <th>Amount</th>${taiHeader}<th>Status</th><th>Detail</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    updateLoadMoreButton(false);
  }

  function appendInvoices(invoices) {
    if (!invoices || invoices.length === 0) {
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
      try {
        await invoicesInFlight;
      } catch (_) {
        /* surfaced below */
      }
      if (!reset) return;
    }

    invoicesInFlight = (async () => {
      if (reset) {
        invoiceOffset = 0;
        invoiceHasMore = false;
        setButtonBusy(els.refreshInvoicesBtn, true, "Refreshing…");
        updateLoadMoreButton(false);
        els.invoicesContainer.innerHTML =
          '<p class="panel-empty">thinking</p>';
      } else if (els.loadMoreInvoicesBtn) {
        updateLoadMoreButton(true);
      }

      try {
        const data = await fetchJson(
            `/getRecentInvoices?limit=${INVOICE_PAGE_SIZE}&offset=${invoiceOffset}`,
        );
        const invoices = data.invoices || [];
        invoiceHasMore = typeof data.hasMore === "boolean" ?
          data.hasMore :
          invoices.length === INVOICE_PAGE_SIZE;
        invoiceOffset += invoices.length;

        if (reset) {
          renderInvoices(invoices);
        } else {
          appendInvoices(invoices);
        }
      } catch (error) {
        if (reset) {
          els.invoicesContainer.innerHTML =
            '<p class="panel-empty">Could not load invoices.</p>';
          invoiceHasMore = false;
        } else {
          showError("Could not load more invoices. Please try again.");
        }
        console.error("loadInvoices failed:", error);
        updateLoadMoreButton(false);
        throw error;
      } finally {
        if (reset) {
          setButtonBusy(els.refreshInvoicesBtn, false);
        } else {
          updateLoadMoreButton(false);
        }
      }
    })();

    try {
      await invoicesInFlight;
    } finally {
      invoicesInFlight = null;
    }
  }

  async function loadMoreInvoices() {
    if (!invoiceHasMore || els.loadMoreInvoicesBtn.disabled) {
      return;
    }
    await loadInvoices({reset: false});
  }

  function formatPeriodLabel(period, range) {
    const date = new Date(period);
    if (range === "day") {
      return date.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
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
        borderColor: "#4f46e5",
        backgroundColor: "#4f46e5",
        tension: 0.3,
      },
      {
        label: "With added charges",
        data: series.map((row) => row.invoicesWithAddedCharges || 0),
        borderColor: "#d97706",
        backgroundColor: "#d97706",
        tension: 0.3,
      },
      {
        label: "Emails replied",
        data: series.map((row) => row.emailsReplied),
        borderColor: "#16a34a",
        backgroundColor: "#16a34a",
        tension: 0.3,
      },
      {
        label: "Emails forwarded for review",
        data: series.map((row) => row.emailsForwarded),
        borderColor: "#dc2626",
        backgroundColor: "#dc2626",
        tension: 0.3,
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
        scales: {
          y: {beginAtZero: true, ticks: {precision: 0}},
        },
      },
    });
  }

  function setStatsThinking(active) {
    const tiles = [
      els.statInvoices,
      els.statWorkflows,
      els.statAddedCharges,
      els.statReplied,
      els.statForwarded,
    ];
    tiles.forEach((el) => {
      if (!el) return;
      if (active) {
        el.textContent = "thinking";
        el.classList.add("is-thinking");
      } else {
        el.classList.remove("is-thinking");
      }
    });
  }

  async function loadStats(range) {
    if (statsInFlight) {
      return statsInFlight;
    }

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
        console.error("loadStats failed:", error);
        showError("Couldn't load dashboard stats. Please try again shortly.");
        throw error;
      } finally {
        setRangeButtonsDisabled(false);
      }
    })();

    try {
      return await statsInFlight;
    } finally {
      statsInFlight = null;
    }
  }

  function setActiveRange(range) {
    if (range === activeRange && statsInFlight) {
      return;
    }
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
    if (els.connectBtn.disabled) return;
    setButtonBusy(els.connectBtn, true, "Connecting…");
    window.location.href =
      `${BASE_URL}/mailConnect?${tenantQuery}`;
  });

  els.disconnectBtn.addEventListener("click", async () => {
    if (!confirm("Disconnect Outlook? The system will stop processing emails until you reconnect.")) return;
    setButtonBusy(els.disconnectBtn, true, "Disconnecting…");
    try {
      const data = await postJson("/mailDisconnect");
      if (data.ok) {
        await loadMailStatus();
        showRunResult("Outlook disconnected.", false);
      } else {
        showRunResult("Disconnect failed: " + (data.error || "unknown error"), true);
      }
    } catch (error) {
      showRunResult("Could not reach the server.", true);
    } finally {
      setButtonBusy(els.disconnectBtn, false);
    }
  });

  els.refreshInvoicesBtn.addEventListener("click", () => loadInvoices({reset: true}));
  if (els.loadMoreInvoicesBtn) {
    els.loadMoreInvoicesBtn.addEventListener("click", loadMoreInvoices);
  }

  if (els.logExportDate) {
    els.logExportDate.value = todayEasternIsoDate();
  }
  if (els.exportLogsCsvBtn) {
    els.exportLogsCsvBtn.addEventListener("click", exportLogsCsvForSelectedDay);
  }

  // ---- Support chat ----

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
    chatEls.toggle.setAttribute(
        "aria-label",
        chatOpen ? "Close Jerry chat" : "Chat with Jerry",
    );
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
            "Ask about a load number, invoice status, or anything on " +
            "the dashboard.",
        );
      }
    }
  }

  function toggleChat() {
    setChatOpen(!chatOpen);
  }

  function endChat() {
    appendChatMessage(
      "system",
      "This has been passed along to our team — thanks for the details!",
    );
    chatEls.input.disabled = true;
    chatEls.form.querySelector(".support-chat-send").disabled = true;
  }

  async function sendChatMessage(text) {
    chatHistory.push({role: "user", content: text});
    appendChatMessage("user", text);

    const pending = appendChatMessage("bot", "thinking");
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
            tms: TMS,
          },
        }),
      });
      if (!response.ok) {
        throw new Error(`Chat request failed (${response.status})`);
      }
      const data = await response.json();
      pending.remove();

      const reply = (data && data.reply) ||
        "Sorry, something went wrong on our end. Please try again.";
      appendChatMessage("bot", reply);
      chatHistory.push({role: "assistant", content: reply});

      if (data && data.done) {
        endChat();
        return;
      }
    } catch (error) {
      pending.remove();
      appendChatMessage(
          "bot",
          "Sorry, I couldn't reach the support assistant. Please try " +
            "again in a moment.",
      );
      console.error("sendChatMessage failed:", error);
    } finally {
      chatBusy = false;
      chatEls.input.disabled = false;
      chatEls.input.focus();
    }
  }

  function autoGrowChatInput() {
    chatEls.input.style.height = "auto";
    chatEls.input.style.height = `${chatEls.input.scrollHeight}px`;
  }

  if (chatEls.toggle && chatEls.panel) {
    chatEls.toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleChat();
    });
    if (chatEls.headerToggle) {
      chatEls.headerToggle.addEventListener("click", (event) => {
        event.stopPropagation();
        if (chatOpen) {
          setChatOpen(false);
        }
      });
    }
    chatEls.input.addEventListener("input", autoGrowChatInput);

    chatEls.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (chatBusy) {
        return;
      }
      const text = chatEls.input.value.trim();
      if (!text) {
        return;
      }
      chatEls.input.value = "";
      autoGrowChatInput();
      sendChatMessage(text);
    });

    chatEls.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        chatEls.form.requestSubmit();
      }
    });
  }

  loadMailStatus();
  setActiveRange(activeRange);
  loadInvoices({reset: true});
  loadTasks();
})();
