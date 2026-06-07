(function () {
  "use strict";

  const BASE_URL = window.DASHBOARD_CONFIG.FUNCTIONS_BASE_URL;

  const els = {
    badge: document.getElementById("gmailStatusBadge"),
    connectBtn: document.getElementById("connectGmailBtn"),
    rangeBtns: Array.from(document.querySelectorAll(".range-btn")),
    statInvoices: document.getElementById("statInvoices"),
    statReplied: document.getElementById("statReplied"),
    statForwarded: document.getElementById("statForwarded"),
    errorBanner: document.getElementById("errorBanner"),
    chartCanvas: document.getElementById("statsChart"),
  };

  let chart = null;
  let activeRange = "week";

  function showError(message) {
    if (!message) {
      els.errorBanner.hidden = true;
      els.errorBanner.textContent = "";
      return;
    }
    els.errorBanner.hidden = false;
    els.errorBanner.textContent = message;
  }

  async function fetchJson(path) {
    const response = await fetch(`${BASE_URL}${path}`);
    if (!response.ok) {
      throw new Error(`Request to ${path} failed (${response.status})`);
    }
    return response.json();
  }

  async function loadGmailStatus() {
    try {
      const data = await fetchJson("/getGmailStatus");
      if (data.connected) {
        els.badge.textContent = "Gmail connected";
        els.badge.className = "badge badge-connected";
        els.connectBtn.textContent = "Reconnect Gmail";
      } else {
        els.badge.textContent = "Gmail not connected";
        els.badge.className = "badge badge-disconnected";
        els.connectBtn.textContent = "Connect Gmail";
      }
    } catch (error) {
      els.badge.textContent = "Status unavailable";
      els.badge.className = "badge badge-unknown";
      console.error("loadGmailStatus failed:", error);
    }
  }

  function formatPeriodLabel(period, range) {
    const date = new Date(period);
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

  async function loadStats(range) {
    showError(null);
    try {
      const data = await fetchJson(`/getDashboardStats?range=${range}`);
      els.statInvoices.textContent = data.totals.invoicesProcessed;
      els.statReplied.textContent = data.totals.emailsReplied;
      els.statForwarded.textContent = data.totals.emailsForwarded;
      renderChart(data.series, range);
    } catch (error) {
      console.error("loadStats failed:", error);
      showError("Couldn't load dashboard stats. Check the FUNCTIONS_BASE_URL in config.js and try again.");
    }
  }

  function setActiveRange(range) {
    activeRange = range;
    els.rangeBtns.forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.range === range);
    });
    loadStats(range);
  }

  els.rangeBtns.forEach((btn) => {
    btn.addEventListener("click", () => setActiveRange(btn.dataset.range));
  });

  els.connectBtn.addEventListener("click", () => {
    window.location.href = `${BASE_URL}/gmailConnect`;
  });

  loadGmailStatus();
  setActiveRange(activeRange);
})();
