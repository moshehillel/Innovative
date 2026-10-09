/* eslint-env browser */
/* global QD */
/**
 * Quote rules admin — Netlify SPA.
 * Same functionality as the legacy quoteAdminPage (rules list, AI chat
 * with confirm flow, address tester), restyled and served from the CDN.
 */
(function () {
  "use strict";

  const TENANT_ID = QD.TENANT_ID;
  const esc = QD.esc;

  QD.warmUp();
  document.getElementById("status").textContent = "Tenant: " + TENANT_ID;
  document.getElementById("home-link").href = QD.pageUrl("index.html");

  let chatMessages = [];
  let pendingProposal = null;
  let lastAppliedRule = null;
  let lastProposedRule = null;
  let agentState = null;
  const CHAT_STATE_KEY = "quoteAdminChat:" + TENANT_ID;

  function isInternalChatMarker(text) {
    const c = String(text || "").trim();
    return /^\[(APPLIED|PROPOSED)\]/i.test(c);
  }

  function saveChatState() {
    try {
      sessionStorage.setItem(CHAT_STATE_KEY, JSON.stringify({
        chatMessages,
        lastAppliedRule,
        lastProposedRule,
        agentState,
      }));
    } catch (e) { /* quota / private mode */ }
  }

  function hasAgentContext() {
    if (!agentState || typeof agentState !== "object") return false;
    return !!(agentState.goal || agentState.awaiting || agentState.draft ||
      agentState.intentSummary || agentState.openQuestion ||
      agentState.focusRuleId);
  }

  function clearAgentDraftMemory() {
    if (!agentState || typeof agentState !== "object") {
      agentState = null;
      return;
    }
    agentState = {
      ...agentState,
      draft: null,
      awaiting: null,
      openQuestion: null,
    };
  }

  function renderChatLogFromState() {
    const log = document.getElementById("chat-log");
    if (!log) return;
    log.innerHTML = "";
    for (const m of chatMessages) {
      if (!m || !m.content || isInternalChatMarker(m.content)) continue;
      appendChat(m.role || "assistant", m.content);
    }
  }

  function restoreChatState() {
    try {
      const raw = sessionStorage.getItem(CHAT_STATE_KEY);
      if (!raw) return;
      const st = JSON.parse(raw);
      if (!Array.isArray(st.chatMessages) || !st.chatMessages.length) return;
      chatMessages = st.chatMessages;
      lastAppliedRule = st.lastAppliedRule || null;
      lastProposedRule = st.lastProposedRule || null;
      agentState = st.agentState || null;
      renderChatLogFromState();
    } catch (e) { /* ignore corrupt storage */ }
  }

  let pendingQuickReplies = [];
  let thinkingTimer = null;
  let thinkingFadeTimer = null;
  let thinkingStep = 0;
  const THINKING_ROTATE_MS = 1500;
  const THINKING_FADE_MS = 220;
  const THINKING_PHRASES = [
    "Thinking",
    "Looking over data",
    "Processing",
    "Reviewing your request",
    "Preparing a proposal",
  ];

  const ACCESSORIAL_LABELS = {
    LFO: "Liftgate at pickup",
    LFD: "Liftgate at delivery",
    APO: "Appointment pickup",
    APD: "Appointment required",
    LAO: "Limited access pickup",
    LAD: "Limited access delivery",
    RSO: "Residential pickup",
    NUD: "Nursing home delivery",
    HOD: "Hotel delivery",
    RSD: "Residential delivery",
    SCD: "School delivery",
    INS: "Insurance",
  };

  const SITE_TYPE_LABELS = {
    nursing_home: "Nursing home",
    hotel: "Hotel",
    amazon_fc: "Amazon fulfillment center",
    menards_dc: "Menards DC",
    aafes_military: "AAFES / military exchange",
    chain_store: "Chain store",
    residential: "Residential",
    other: "Commercial / other",
  };

  const FLAG_LABELS = {
    residentialDelivery: "Residential delivery",
    residentialPickup: "Residential pickup",
    insuranceRequested: "Insurance requested",
    appointmentRequired: "Appointment required",
  };

  const IDENTIFY_VIA_LABELS = {
    address_text: "Address text",
    ai: "AI classification",
    both: "Address text or AI",
    email: "Sender email",
  };

  function formatIdentifyVia(rule) {
    const key = rule.identifyVia || "both";
    return IDENTIFY_VIA_LABELS[key] || IDENTIFY_VIA_LABELS.both;
  }

  const api = QD.api;

  function quoteList(items) {
    if (!items || !items.length) return "";
    if (items.length === 1) return `"${items[0]}"`;
    const head = items.slice(0, -1).map((i) => `"${i}"`).join(", ");
    return `${head}, or "${items[items.length - 1]}"`;
  }

  function formatAccessorial(code) {
    const label = ACCESSORIAL_LABELS[code];
    return label ? `${label} (${code})` : code;
  }

  function describeMatch(match, applyTo) {
    const lines = [];
    if (!match || typeof match !== "object") {
      lines.push("Always applies (no specific trigger configured).");
      return lines;
    }
    if (applyTo === "origin") {
      lines.push("Applies to pickup / Ship From only");
    } else if (applyTo === "both") {
      lines.push("Applies to pickup and delivery (origin vs dest codes)");
    }
    if (match.consigneeNameContains && match.consigneeNameContains.length) {
      lines.push(`Consignee name includes ${quoteList(match.consigneeNameContains)}`);
    }
    if (match.consigneeAddressContains && match.consigneeAddressContains.length) {
      lines.push(`Delivery address includes ${quoteList(match.consigneeAddressContains)}`);
    }
    if (match.shipperNameContains && match.shipperNameContains.length) {
      lines.push(`Shipper name includes ${quoteList(match.shipperNameContains)}`);
    }
    if (match.instructionsContains && match.instructionsContains.length) {
      lines.push(`Special instructions mention ${quoteList(match.instructionsContains)}`);
    }
    if (match.referenceContains && match.referenceContains.length) {
      lines.push(`Reference / PO number includes ${quoteList(match.referenceContains)}`);
    }
    if (match.flags && match.flags.length) {
      match.flags.forEach((f) => {
        lines.push(`Shipment is flagged as ${FLAG_LABELS[f] || f.replace(/([A-Z])/g, " $1").toLowerCase().trim()}`);
      });
    }
    if (match.siteType) {
      const kind = applyTo === "origin" ? "Pickup site" :
        applyTo === "both" ? "Pickup or delivery site" : "Delivery site";
      lines.push(`${kind} is identified as ${SITE_TYPE_LABELS[match.siteType] || match.siteType.replace(/_/g, " ")}`);
    }
    if (match.carrierNameContains && match.carrierNameContains.length) {
      lines.push(
          `Selected rate carrier name includes ${quoteList(match.carrierNameContains)} ` +
          `(adds a Notes line on the customer email when that carrier is selected)`);
    }
    const fromEmails = [].concat(match.fromEmails || []).concat(match.senderEmails || []);
    if (fromEmails.length) {
      lines.push(`Sender From email is ${quoteList(fromEmails)}`);
    }
    if (match.senderDomains && match.senderDomains.length) {
      lines.push(`Sender domain is ${quoteList(match.senderDomains.map((d) => String(d).startsWith("@") ? d : "@" + d))}`);
    }
    if (match.shipperCityContains && match.shipperCityContains.length) {
      lines.push(`Pickup city includes ${quoteList(match.shipperCityContains)}`);
    }
    if (match.shipperState) {
      lines.push(`Pickup state is ${match.shipperState}`);
    }
    if (match.consigneeCityContains && match.consigneeCityContains.length) {
      lines.push(`Delivery city includes ${quoteList(match.consigneeCityContains)}`);
    }
    if (match.consigneeState) {
      lines.push(`Delivery state is ${match.consigneeState}`);
    }
    if (!lines.length) {
      lines.push("Custom match conditions (see Advanced for details).");
    }
    return lines;
  }

  function describeActions(rule) {
    const lines = [];
    if (rule.customerName) {
      lines.push(`Attach Primus customer "${rule.customerName}"`);
    }
    if (rule.protocolOnly) {
      lines.push("Protocol only — match this customer from the sender email");
    }
    if (rule.defaultDims && typeof rule.defaultDims === "object") {
      const d = rule.defaultDims;
      const L = d.length != null ? d.length : "?";
      const W = d.width != null ? d.width : "?";
      const H = d.height != null ? d.height : "?";
      lines.push(`Default missing pallet dims to ${L}×${W}×${H}`);
    }
    const fillZip = String(rule.fillZipCode || "").replace(/\D/g, "").slice(0, 5);
    if (/^\d{5}$/.test(fillZip)) {
      const side = rule.applyTo === "origin" ? "pickup" :
        rule.applyTo === "dest" ? "delivery" : "pickup or delivery";
      lines.push(`Use rating ZIP ${fillZip} for ${side} when city matches`);
    }
    const acc = rule.addAccessorials || [];
    if (acc.length) {
      lines.push(`Add accessorial${acc.length > 1 ? "s" : ""}: ${acc.map(formatAccessorial).join("; ")}`);
    }
    const rem = rule.removeAccessorials || [];
    if (rem.length) {
      lines.push(`Remove accessorial${rem.length > 1 ? "s" : ""}: ${rem.map(formatAccessorial).join("; ")}`);
    }
    const filters = rule.filterCarrierWarnings || [];
    if (filters.length) {
      lines.push(`Do not use carriers that warn about: ${filters.map((f) => `"${f}"`).join(", ")}`);
    }
    const carrierNeedles = (rule.match && rule.match.carrierNameContains) || [];
    if (carrierNeedles.length && rule.notes) {
      const noteBody = String(rule.notes || "")
          .replace(/^add\s+notes?:\s*/i, "")
          .trim();
      if (noteBody) {
        lines.push(`Add customer email note when selected: ${noteBody}`);
      }
    }
    if (!acc.length && !rem.length && !filters.length && !rule.customerName && !rule.defaultDims &&
        !(carrierNeedles.length && rule.notes)) {
      lines.push("No accessorials or carrier filters — rule may only set flags or notes.");
    }
    if (rule.requiresConfirm) {
      lines.push("Ask dispatcher to confirm before quoting");
    } else if (rule.autoApply !== false) {
      lines.push("Apply automatically — no confirmation needed");
    }
    return lines;
  }

  function priorityLabel(priority) {
    const n = Number(priority);
    if (!Number.isFinite(n)) return "Standard priority";
    if (n <= 15) return `Runs early (priority ${n})`;
    if (n <= 35) return `Normal priority (${n})`;
    return `Runs later (priority ${n})`;
  }

  function compactAccessorialsSummary(rule) {
    const parts = [];
    const acc = rule.addAccessorials || [];
    if (acc.length) {
      parts.push("add " + acc.map((c) => ACCESSORIAL_LABELS[c] || c).join(", "));
    }
    const rem = rule.removeAccessorials || [];
    if (rem.length) {
      parts.push("remove " + rem.map((c) => ACCESSORIAL_LABELS[c] || c).join(", "));
    }
    if (rule.customerName) {
      parts.push("customer " + rule.customerName);
    }
    const filters = rule.filterCarrierWarnings || [];
    if (filters.length) {
      parts.push("filter " + filters.join(", "));
    }
    const carrierNeedles = (rule.match && rule.match.carrierNameContains) || [];
    if (carrierNeedles.length && rule.notes) {
      parts.push("carrier email note");
    }
    if (!parts.length) return "No accessorials";
    return parts.join(" · ");
  }

  function setRuleCardOpen(card, open) {
    if (!card) return;
    card.classList.toggle("open", !!open);
    const btn = card.querySelector("[data-rule-toggle]");
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function bindRuleCardToggles(root) {
    (root || document).querySelectorAll("[data-rule-toggle]").forEach((btn) => {
      if (btn.dataset.boundRuleToggle === "1") return;
      btn.dataset.boundRuleToggle = "1";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const card = btn.closest(".rule-card");
        if (!card) return;
        setRuleCardOpen(card, !card.classList.contains("open"));
      });
    });
  }

  function renderRuleCard(rule) {
    const card = document.createElement("article");
    card.className = "rule-card" + (rule.active === false ? " inactive" : "");

    const whenLines = describeMatch(rule.match, rule.applyTo);
    const thenLines = describeActions(rule);
    const summary = compactAccessorialsSummary(rule);

    const badges = [];
    badges.push(`<span class="badge ${rule.active !== false ? "on" : "off"}">${rule.active !== false ? "Active" : "Turned off"}</span>`);
    if (rule.requiresConfirm) {
      badges.push('<span class="badge confirm">Needs confirmation</span>');
    }
    if (rule.active !== false && rule.wiringStatus === "unwired") {
      badges.push('<span class="badge unwired" title="' +
        esc(rule.wiringReason || "not wired") +
        '">Not wired</span>');
    }

    const isCarrierEmailNote =
      !!(rule.match && Array.isArray(rule.match.carrierNameContains) &&
        rule.match.carrierNameContains.length);
    const identifyMeta = isCarrierEmailNote ? "" :
      `<div class="rule-meta" style="margin-top:6px">Identified via: ${esc(formatIdentifyVia(rule))}</div>`;

    card.innerHTML = `
      <button type="button" class="rule-toggle" data-rule-toggle="1" aria-expanded="false">
        <span class="rule-chevron" aria-hidden="true">▶</span>
        <div class="rule-toggle-main">
          <h3 class="rule-title">${esc(rule.name || rule.id || "Unnamed rule")}</h3>
          <div class="rule-compact-summary">${esc(summary)} · ${esc(priorityLabel(rule.priority))}</div>
        </div>
        <div class="rule-toggle-badges">${badges.join("")}</div>
      </button>
      <div class="rule-body">
        <div class="rule-section">
          <div class="rule-section-label">When this happens</div>
          <ul>${whenLines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
          ${identifyMeta}
        </div>
        <div class="rule-section">
          <div class="rule-section-label">Then do this</div>
          <ul>${thenLines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
        </div>
        ${rule.notes && !isCarrierEmailNote ? `<div class="rule-notes">${esc(rule.notes)}</div>` : ""}
        <details class="rule-advanced">
          <summary>Advanced (rule ID &amp; technical data)</summary>
          <pre>${esc(JSON.stringify({id: rule.id, ruleKind: rule.ruleKind || null, identifyVia: rule.identifyVia || "both", applyTo: rule.applyTo || "dest", match: rule.match, customerName: rule.customerName || null, protocolOnly: !!rule.protocolOnly, defaultDims: rule.defaultDims || null, addAccessorials: rule.addAccessorials, removeAccessorials: rule.removeAccessorials || [], filterCarrierWarnings: rule.filterCarrierWarnings, priority: rule.priority, autoApply: rule.autoApply, requiresConfirm: rule.requiresConfirm}, null, 2))}</pre>
        </details>
      </div>
    `;
    return card;
  }

  const RULES_CACHE_KEY = "qd:rules:" + TENANT_ID;
  const RULES_CACHE_TTL = 5 * 60 * 1000;

  function paintRules(rules) {
    const list = document.getElementById("rules-list");
    const countEl = document.getElementById("rules-count");
    list.innerHTML = "";
    if (!rules.length) {
      list.innerHTML = `
        <div class="empty-state">
          <strong>No rules configured yet</strong>
          Default rules will appear after the first quote is processed, or use the AI chat tab to add one.
        </div>`;
      countEl.textContent = "";
      return;
    }
    const sorted = [...rules].sort((a, b) =>
      (Number(a.priority) || 999) - (Number(b.priority) || 999));
    sorted.forEach((r) => list.appendChild(renderRuleCard(r)));
    bindRuleCardToggles(list);
    const active = rules.filter((r) => r.active !== false).length;
    countEl.textContent = `${active} active · ${rules.length} total`;
  }

  async function loadRules(opts) {
    const useCache = !(opts && opts.force);
    const list = document.getElementById("rules-list");
    const countEl = document.getElementById("rules-count");
    const cached = useCache ? QD.ssGet(RULES_CACHE_KEY, RULES_CACHE_TTL) : null;
    if (cached) {
      paintRules(cached);
    } else {
      list.innerHTML = '<div class="empty-state">Loading rules…</div>';
    }
    try {
      const data = await api("/getQuoteRules?" + QD.tenantQS);
      const rules = data.rules || [];
      QD.ssSet(RULES_CACHE_KEY, rules);
      paintRules(rules);
    } catch (e) {
      if (!cached) {
        list.innerHTML = `<div class="empty-state"><strong>Could not load rules</strong>${esc(e.message)}</div>`;
        countEl.textContent = "";
      }
    }
  }

  function formatClassificationBlock(title, enrichment, addressKey) {
    let html = `<h3>${esc(title)}</h3>`;
    if (!enrichment) {
      html += '<p class="none">Not classified.</p>';
      return html;
    }
    if (enrichment.error) {
      html += `<p class="none">Classification failed: ${esc(enrichment.error)}</p>`;
      return html;
    }
    const cache = enrichment.cacheHit ? "cache hit" : "cache miss (saved)";
    const type = SITE_TYPE_LABELS[enrichment.classifiedAs] || enrichment.classifiedAs;
    html += "<ul>";
    html += `<li><strong>Site type:</strong> ${esc(type || "unknown")}</li>`;
    if (enrichment.placeName) {
      html += `<li><strong>Place name:</strong> ${esc(enrichment.placeName)}</li>`;
    }
    html += `<li><strong>Source:</strong> ${esc(enrichment.source || "unknown")} (${cache})</li>`;
    if (addressKey) {
      html += `<li><strong>Cache key:</strong> <code>${esc(addressKey)}</code></li>`;
    }
    html += "</ul>";
    return html;
  }

  function formatTestResult(result, enrichment, addressKey, originEnrichment, originAddressKey) {
    if (!result) return '<p class="none">No result returned.</p>';
    const applied = result.appliedRules || [];
    const acc = result.accessorials || [];
    const filters = result.filterCarrierWarnings || [];
    let html = "";

    if (originEnrichment || enrichment) {
      if (originEnrichment) {
        html += formatClassificationBlock(
            "From (origin) classification", originEnrichment, originAddressKey);
      }
      if (enrichment) {
        html += formatClassificationBlock(
            "To (destination) classification", enrichment, addressKey);
      }
    }

    html += "<h3>Rules that matched</h3>";
    if (applied.length) {
      html += "<ul>" + applied.map((r) => {
        const sideLabel = r.applyTo === "origin" ? " (pickup)" :
          r.applyTo === "dest" ? " (delivery)" : "";
        const viaLabel = r.fromEnrichment ?
          " (via AI classification)" :
          (r.matchVia === "consigneeName" ? " (via consignee name in email)" :
            r.matchVia === "shipperName" ? " (via shipper name)" :
            r.matchVia === "instructions" ? " (via special instructions)" :
              r.matchVia === "siteType" && r.identifyVia === "address_text" ?
                " (via site type in email)" : "");
        return `<li><strong>${esc(r.name)}</strong>${sideLabel}${viaLabel}${r.notes ? " — " + esc(r.notes) : ""}</li>`;
      }).join("") + "</ul>";
    } else {
      html += '<p class="none">No rules matched this address.</p>';
    }

    html += "<h3>Accessorials that would be added</h3>";
    if (acc.length) {
      html += "<ul>" + acc.map((c) => `<li>${esc(formatAccessorial(c))}</li>`).join("") + "</ul>";
    } else {
      html += '<p class="none">None — no extra accessorials from rules.</p>';
    }

    if (filters.length) {
      html += "<h3>Carrier restrictions</h3>";
      html += "<ul>" + filters.map((f) => `<li>Exclude carriers warning about "${esc(f)}"</li>`).join("") + "</ul>";
    }

    if (result.requiresConfirm) {
      html += '<p style="margin-top:12px;color:var(--ic-amber)"><strong>Dispatcher confirmation would be required</strong> before quoting.</p>';
    }

    return html;
  }

  function isDeleteAction(action) {
    return action === "propose_delete_rule" || action === "delete";
  }

  function isCreateAction(action) {
    return action === "propose_create_rule" || action === "create";
  }

  function normalizeChatProposal(res) {
    if (!res || typeof res !== "object") return res;
    const action = res.action;
    if (!action || action === "none") return res;
    let proposal = res.proposal;
    if (!proposal || typeof proposal !== "object") {
      if (res.ruleId || res.patch || res.deleteRuleId) {
        proposal = {
          ruleId: res.ruleId || res.deleteRuleId || null,
          patch: res.patch || null,
          deleteRuleId: res.deleteRuleId || res.ruleId || null,
        };
      } else {
        return res;
      }
    }
    if (isDeleteAction(action)) {
      const id = proposal.deleteRuleId || proposal.ruleId ||
        (proposal.patch && (proposal.patch.deleteRuleId || proposal.patch.ruleId));
      if (id) {
        proposal = {
          ...proposal,
          ruleId: proposal.ruleId || id,
          deleteRuleId: proposal.deleteRuleId || id,
        };
      }
    }
    return {...res, proposal};
  }

  function summarizeProposal(res) {
    if (!res || !res.proposal) return "The assistant proposed a rule change. Click Confirm to apply it.";
    const p = res.proposal;
    const patch = (p.patch && typeof p.patch === "object") ? p.patch : {};
    const action = res.action || "propose_update_rule";
    const parts = [];
    const ruleLabel = p.ruleId || p.deleteRuleId || patch.id || "unknown";

    if (isDeleteAction(action)) {
      const ids = Array.isArray(p.deleteRuleIds) && p.deleteRuleIds.length ?
        p.deleteRuleIds :
        [ruleLabel];
      parts.push(`<strong>Delete</strong> ${ids.length === 1 ? "the rule" : ids.length + " rules"}: ${ids.map((id) => `"${esc(id)}"`).join(", ")}.`);
      return parts.join("<br>");
    } else if (isCreateAction(action)) {
      parts.push(`<strong>Create a new rule:</strong> "${esc(patch.name || p.ruleId || "new rule")}".`);
    } else {
      parts.push(`<strong>Update rule</strong> "${esc(p.ruleId || patch.id || "existing rule")}".`);
    }

    if (patch.name) parts.push(`Name: ${esc(patch.name)}`);
    if (patch.match) {
      const when = describeMatch(patch.match, patch.applyTo);
      parts.push(`When: ${when.map(esc).join("; ")}`);
    }
    if (patch.identifyVia) {
      parts.push(`Identified via: ${esc(formatIdentifyVia(patch))}`);
    }
    if (patch.addAccessorials) {
      parts.push(`Add: ${patch.addAccessorials.map(formatAccessorial).map(esc).join("; ")}`);
    }
    if (patch.removeAccessorials && patch.removeAccessorials.length) {
      parts.push(`Remove: ${patch.removeAccessorials.map(formatAccessorial).map(esc).join("; ")}`);
    }
    if (patch.customerName) {
      parts.push(`Customer: ${esc(patch.customerName)}`);
    }
    if (patch.protocolOnly) parts.push("Protocol only");
    if (patch.defaultDims && typeof patch.defaultDims === "object") {
      const d = patch.defaultDims;
      parts.push(`Default dims: ${esc([d.length, d.width, d.height].filter((n) => n != null).join("×"))}`);
    }
    const fillZip = String(patch.fillZipCode || "").replace(/\D/g, "").slice(0, 5);
    if (/^\d{5}$/.test(fillZip)) {
      const side = patch.applyTo === "origin" ? "pickup" :
        patch.applyTo === "dest" ? "delivery" : "pickup/delivery";
      parts.push(`Rating ZIP: ${esc(fillZip)} (${esc(side)})`);
    }
    if (patch.active === false) parts.push("This rule will be turned off.");
    if (patch.active === true) parts.push("This rule will be turned on.");

    return parts.join("<br>");
  }

  function summarizeProposalPlain(res) {
    const html = summarizeProposal(res);
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  function recordProposedRule(res) {
    if (!res || !res.proposal) {
      lastProposedRule = null;
      return;
    }
    const proposal = res.proposal;
    const ruleId = proposal.ruleId || proposal.deleteRuleId || null;
    const patch = (proposal.patch && typeof proposal.patch === "object") ?
      proposal.patch :
      {};
    lastProposedRule = {
      ruleId,
      ruleKind: patch.ruleKind || null,
      summary: summarizeProposalPlain(res),
      action: res.action || null,
      proposal: pendingProposal,
    };
    if (ruleId) {
      chatMessages.push({
        role: "assistant",
        content: `[PROPOSED] ruleId="${ruleId}" action="${String(res.action || "")}" kind="${String(patch.ruleKind || "")}"`,
      });
    }
    saveChatState();
  }

  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      ["rules", "chat", "test"].forEach((t) => {
        document.getElementById("panel-" + t).classList.toggle("hidden", t !== btn.dataset.tab);
      });
      if (btn.dataset.tab === "chat" && !chatMessages.length) {
        const welcome = "Ask me to set up a quote rule — I'll confirm before saving.";
        chatMessages.push({role: "assistant", content: welcome});
        appendChat("assistant", welcome);
        saveChatState();
      }
    });
  });

  document.getElementById("reload-rules").addEventListener("click", async () => {
    const btn = document.getElementById("reload-rules");
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Refreshing…";
    try {
      await loadRules({force: true});
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  });

  function clearQuickReplies() {
    pendingQuickReplies = [];
    const el = document.getElementById("chat-quick-replies");
    if (!el) return;
    el.innerHTML = "";
    el.classList.remove("visible");
  }

  function renderQuickReplies(replies) {
    const el = document.getElementById("chat-quick-replies");
    if (!el) return;
    const list = Array.isArray(replies) ?
      replies.map((r) => String(r || "").trim()).filter(Boolean) : [];
    pendingQuickReplies = list;
    el.innerHTML = "";
    if (!list.length) {
      el.classList.remove("visible");
      return;
    }
    list.forEach((label) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        if (document.getElementById("chat-send").disabled) return;
        const input = document.getElementById("chat-input");
        input.value = label;
        clearQuickReplies();
        sendChatMessage();
      });
      el.appendChild(btn);
    });
    el.classList.add("visible");
  }

  function appendChat(role, text) {
    const log = document.getElementById("chat-log");
    const div = document.createElement("div");
    div.className = "msg " + (role === "user" ? "user" : "assistant");
    div.innerHTML = `<div class="bubble">${esc(text)}</div>`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function thinkingDotsEl() {
    const dots = document.createElement("span");
    dots.className = "thinking-dots";
    dots.setAttribute("aria-hidden", "true");
    dots.innerHTML = "<span>.</span><span>.</span><span>.</span>";
    return dots;
  }

  function applyThinkingPhrase(phrase) {
    const statusEl = document.getElementById("chat-thinking-status");
    if (!statusEl) return;
    statusEl.textContent = "";
    statusEl.appendChild(document.createTextNode(phrase));
    statusEl.appendChild(thinkingDotsEl());
  }

  function setThinkingCopy(step, withFade) {
    const phrase = THINKING_PHRASES[step % THINKING_PHRASES.length];
    const statusEl = document.getElementById("chat-thinking-status");
    if (!statusEl) return;
    if (thinkingFadeTimer) {
      clearTimeout(thinkingFadeTimer);
      thinkingFadeTimer = null;
    }
    if (!withFade) {
      statusEl.classList.remove("is-fading");
      applyThinkingPhrase(phrase);
      return;
    }
    statusEl.classList.add("is-fading");
    thinkingFadeTimer = setTimeout(() => {
      applyThinkingPhrase(phrase);
      statusEl.classList.remove("is-fading");
      thinkingFadeTimer = null;
    }, THINKING_FADE_MS);
  }

  function stopThinkingRotation() {
    if (thinkingTimer) {
      clearInterval(thinkingTimer);
      thinkingTimer = null;
    }
    if (thinkingFadeTimer) {
      clearTimeout(thinkingFadeTimer);
      thinkingFadeTimer = null;
    }
  }

  function startThinkingRotation() {
    thinkingStep = 0;
    setThinkingCopy(0, false);
    if (thinkingTimer) clearInterval(thinkingTimer);
    thinkingTimer = setInterval(() => {
      thinkingStep += 1;
      setThinkingCopy(thinkingStep, true);
    }, THINKING_ROTATE_MS);
  }

  function showChatThinking(active) {
    const log = document.getElementById("chat-log");
    if (!log) return;
    let row = document.getElementById("chat-thinking");
    if (active) {
      if (!row) {
        row = document.createElement("div");
        row.id = "chat-thinking";
        row.className = "msg assistant thinking";
        row.setAttribute("aria-live", "polite");
        row.innerHTML =
          '<div class="bubble"><span class="thinking-status" id="chat-thinking-status"></span></div>';
        log.appendChild(row);
      } else {
        log.appendChild(row);
      }
      row.classList.remove("hidden");
      row.setAttribute("aria-busy", "true");
      startThinkingRotation();
      log.scrollTop = log.scrollHeight;
    } else {
      stopThinkingRotation();
      if (row) row.remove();
    }
  }

  function normalizeConfirmText(text) {
    return String(text || "").trim().toLowerCase()
        .replace(/[^\w\s'-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
  }

  function isNaturalReject(text) {
    const raw = String(text || "").trim();
    if (!raw) return false;
    const norm = normalizeConfirmText(raw);
    if (/^(no|nope|nah|cancel|stop|wait|hold on|nevermind|never mind)\.?$/i.test(raw)) return true;
    return /\b(not quite|not right|that'?s wrong|change (it|that)|hold on|wait a sec)\b/.test(norm) ||
      /\b(don'?t|do not)\s+(apply|save|confirm)\b/.test(norm) ||
      (/\b(cancel|scratch that|forget it)\b/.test(norm) && norm.length <= 80);
  }

  function isNaturalConfirm(text, hasPending) {
    const raw = String(text || "").trim();
    if (!raw || isNaturalReject(raw)) return false;
    // Confirm + refine in one utterance — send to chat, do not apply yet.
    if (/^(yes|yeah|yep|ok|okay),?\s+but\b/i.test(raw)) return false;
    if (/\bbut\s+only\s+when\b/i.test(raw)) return false;
    if (/\bonly\s+when\s+(the\s+)?(customer|sender|from)\b/i.test(raw)) return false;
    if (/\bfor\s+this\s+rule\b/i.test(raw)) return false;
    if (/\bbut\b/i.test(raw) &&
        /\b(only|when|except|unless|customer|sender|from)\b/i.test(raw)) {
      return false;
    }
    const norm = normalizeConfirmText(raw);
    if (/^(yes|yep|yeah|yea|yup|ok|okay|k|sure|correct|right|exactly|perfect|absolutely|definitely|confirmed|confirm|apply|proceed|go ahead|do it|save it|looks good|sounds good|that works|please do|please apply|go for it|make it so|do that|that'?s it|that'?s right|that'?s correct|that'?s good|that'?s fine|that'?s perfect)\.?$/i.test(raw)) {
      return true;
    }
    const phrases = [
      /\bthat('s| is) (right|correct|it|good|fine|perfect|what i want)\b/,
      /\b(yes|yeah|yep|yup)[,.]?\s*(that('s| is) (right|correct|it)|go ahead|please|do it|apply|save)\b/,
      /\b(go ahead|please apply|please save|please do|please confirm)\b/,
      /\b(sounds|looks) good\b/,
      /\bgo for it\b/,
      /\bdo (that|this)\b/,
      /\bapply (that|this|it)\b/,
      /\bsave (that|this|it)\b/,
      /\blet'?s do (it|that)\b/,
      /\byou got it\b/,
    ];
    if (phrases.some((re) => re.test(norm))) return true;
    if (hasPending && /^(yes|yep|yeah|yup|ok|okay|sure|right|correct|perfect)\b/i.test(norm) &&
        !/\bbut\b/.test(norm)) {
      return true;
    }
    if (hasPending && /\b(yes|yeah|yep)\b/.test(norm) && norm.length <= 40 &&
        !/\bbut\b/.test(norm)) {
      return true;
    }
    return false;
  }

  function setProposalBoxCopy(action) {
    const titleEl = document.getElementById("proposal-box-title");
    const hintEl = document.getElementById("proposal-box-hint");
    const isUpdate = action === "propose_update_rule";
    if (titleEl) {
      titleEl.textContent = isUpdate ?
        "Proposed update — review below" :
        "Proposed rule — review below";
    }
    if (hintEl) {
      hintEl.textContent = isUpdate ?
        "Reply naturally (yes, sounds good, go ahead, that's right) or click Confirm to save this update." :
        "Reply naturally (yes, sounds good, go ahead, that's right) or click Confirm to save this rule.";
    }
  }

  function buildRulesChatPayload() {
    const referencedRuleId = (lastAppliedRule && lastAppliedRule.ruleId) ||
      (lastProposedRule && lastProposedRule.ruleId) ||
      (pendingProposal && pendingProposal.ruleId) ||
      null;
    return {
      tenantId: TENANT_ID,
      messages: chatMessages,
      history: chatMessages,
      pendingProposal,
      lastAppliedRule,
      lastProposedRule,
      referencedRuleId,
      lastAppliedRuleId: lastAppliedRule && lastAppliedRule.ruleId,
      agentState,
    };
  }

  async function applyPendingProposal() {
    if (!pendingProposal) return;
    clearQuickReplies();
    const confirmBtn = document.getElementById("confirm-proposal");
    const wasDelete = isDeleteAction(pendingProposal.action);
    const ruleId = pendingProposal.ruleId || pendingProposal.deleteRuleId;
    const deleteRuleIds = Array.isArray(pendingProposal.deleteRuleIds) &&
      pendingProposal.deleteRuleIds.length ?
      pendingProposal.deleteRuleIds :
      (ruleId ? [ruleId] : []);
    if (wasDelete && !ruleId && !deleteRuleIds.length) {
      appendChat("assistant", "Failed: missing rule id to delete. Ask the assistant to propose the delete again.");
      return;
    }
    const body = {
      tenantId: TENANT_ID,
      action: pendingProposal.action,
      ruleId: ruleId || deleteRuleIds[0],
      patch: pendingProposal.patch || {},
      deleteRuleId: pendingProposal.deleteRuleId || ruleId || deleteRuleIds[0],
      deleteRuleIds,
      updatedBy: "quote-admin-ui",
    };
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Saving…";
    }
    showChatThinking(true);
    try {
      const res = await api("/applyQuoteRule", {
        method: "POST",
        body: JSON.stringify(body),
      });
      showChatThinking(false);
      if (!res || !res.ok) {
        const errMsg = "Failed: " + ((res && res.error) || "applyQuoteRule did not succeed");
        appendChat("assistant", errMsg);
        chatMessages.push({role: "assistant", content: errMsg});
        return;
      }
      // Ground-truth for later turns — only after applyQuoteRule ok.
      const applied = wasDelete ?
        `[APPLIED] Deleted rule "${ruleId}" via Confirm (applyQuoteRule ok).` :
        `[APPLIED] Saved rule "${ruleId}" via Confirm (applyQuoteRule ok).`;
      const okMsg = wasDelete ?
        `Applied: removed "${ruleId}". It stays gone on refresh.` :
        `Applied: saved "${ruleId}". Refresh the Rules list to see the update.`;
      appendChat("assistant", okMsg);
      chatMessages.push({role: "assistant", content: okMsg});
      chatMessages.push({role: "assistant", content: applied});
      if (!wasDelete && ruleId) {
        const patch = pendingProposal.patch || {};
        lastAppliedRule = {
          ruleId,
          ruleKind: patch.ruleKind || (res.rule && res.rule.ruleKind) || null,
          summary: summarizeProposalPlain({
            action: pendingProposal.action,
            proposal: pendingProposal,
          }),
          action: pendingProposal.action,
          proposal: pendingProposal,
        };
        lastProposedRule = null;
      } else {
        lastAppliedRule = null;
      }
      document.getElementById("proposal-box").classList.add("hidden");
      pendingProposal = null;
      clearAgentDraftMemory();
      if (lastAppliedRule && lastAppliedRule.ruleId) {
        agentState = {
          ...(agentState || {}),
          focusRuleId: lastAppliedRule.ruleId,
          goal: null,
          draft: null,
          awaiting: null,
          openQuestion: null,
          intentSummary: null,
        };
      }
      saveChatState();
      await loadRules({force: true});
    } catch (e) {
      showChatThinking(false);
      const errMsg = "Failed: " + e.message;
      appendChat("assistant", errMsg);
      chatMessages.push({role: "assistant", content: errMsg});
      saveChatState();
    } finally {
      showChatThinking(false);
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = "Confirm";
      }
    }
  }

  function rejectionHasCorrection(text) {
    const raw = String(text || "").trim();
    const stripped = raw.replace(/^(no|nope|nah|wait|hold on)[,.!\s-]+/i, "").trim();
    return stripped.length >= 10 && stripped.toLowerCase() !== raw.toLowerCase();
  }

  async function sendChatMessage() {
    const input = document.getElementById("chat-input");
    const sendBtn = document.getElementById("chat-send");
    const text = input.value.trim();
    if (!text || sendBtn.disabled) return;

    // Natural confirm/reject with a pending proposal — apply locally, not via model.
    if (pendingProposal && isNaturalConfirm(text, true)) {
      input.value = "";
      clearQuickReplies();
      chatMessages.push({role: "user", content: text});
      appendChat("user", text);
      await applyPendingProposal();
      return;
    }
    if (pendingProposal && isNaturalReject(text)) {
      const correction = rejectionHasCorrection(text);
      if (!correction) {
        input.value = "";
        clearQuickReplies();
        chatMessages.push({role: "user", content: text});
        appendChat("user", text);
        document.getElementById("proposal-box").classList.add("hidden");
        pendingProposal = null;
        clearAgentDraftMemory();
        const msg = "Oh sorry — I'll drop that proposal. What should the rule do instead?";
        chatMessages.push({role: "assistant", content: msg});
        appendChat("assistant", msg);
        saveChatState();
        return;
      }
      document.getElementById("proposal-box").classList.add("hidden");
      pendingProposal = null;
      clearAgentDraftMemory();
      saveChatState();
      // Fall through — send correction to the assistant to rework.
    }
    // Only short-circuit bare "yes" when there is truly nothing in flight —
    // including agent working memory (clarify / draft / goal).
    if (!pendingProposal && !hasAgentContext() && isNaturalConfirm(text, false)) {
      input.value = "";
      clearQuickReplies();
      chatMessages.push({role: "user", content: text});
      appendChat("user", text);
      const tip = "Nothing pending right now — tell me what rule you'd like to add or change, and I'll propose it for you to confirm.";
      chatMessages.push({role: "assistant", content: tip});
      appendChat("assistant", tip);
      saveChatState();
      return;
    }

    clearQuickReplies();
    chatMessages.push({role: "user", content: text});
    appendChat("user", text);
    input.value = "";
    sendBtn.disabled = true;
    const sendPrev = sendBtn.textContent;
    sendBtn.textContent = "Sending…";
    showChatThinking(true);
    try {
      let res = await api("/quoteRulesChat", {
        method: "POST",
        body: JSON.stringify(buildRulesChatPayload()),
      });
      showChatThinking(false);
      res = normalizeChatProposal(res) || res;
      if (res.agentState && typeof res.agentState === "object") {
        agentState = res.agentState;
      }
      if (res.action === "dismiss_pending") {
        document.getElementById("proposal-box").classList.add("hidden");
        pendingProposal = null;
        clearAgentDraftMemory();
      }
      if (res.dismissedCorrection) {
        document.getElementById("proposal-box").classList.add("hidden");
        pendingProposal = null;
        clearAgentDraftMemory();
      }
      if (res.reply) {
        chatMessages.push({role: "assistant", content: res.reply});
        appendChat("assistant", res.reply);
      }
      if (res.confirmApply && res.proposal && res.proposal.ruleId) {
        pendingProposal = {
          action: res.action,
          ruleId: res.proposal.ruleId,
          deleteRuleId: res.proposal.deleteRuleId || res.proposal.ruleId,
          deleteRuleIds: res.proposal.deleteRuleIds,
          patch: res.proposal.patch || {},
        };
        await applyPendingProposal();
        sendBtn.disabled = false;
        sendBtn.textContent = sendPrev;
        input.focus();
        return;
      }
      if (res.action === "ask_identify_source" &&
          (!Array.isArray(res.quickReplies) || !res.quickReplies.length)) {
        res.quickReplies = [
          "Can be identified from the email",
          "Cannot be — address / site classification only",
        ];
      }
      // Prefer server-provided identify quick replies (canonical payloads).
      if (res.action === "ask_identify_source" &&
          Array.isArray(res.quickReplies) && res.quickReplies.length >= 2) {
        const canon = [
          "Can be identified from the email",
          "Cannot be — address / site classification only",
        ];
        // Keep exact server strings when present; else force canon labels
        // the identify parser accepts (1/2 and full button text).
        res.quickReplies = res.quickReplies.map((label, i) => {
          const s = String(label || "").trim();
          return s || canon[i] || s;
        });
      }
      if (Array.isArray(res.quickReplies) && res.quickReplies.length) {
        renderQuickReplies(res.quickReplies);
      }
      if (res.action && res.action !== "none" &&
          res.action !== "ask_identify_source" &&
          res.action !== "ask_email_signals" &&
          res.proposal) {
        const proposal = res.proposal;
        const ruleId = proposal.ruleId || proposal.deleteRuleId || null;
        const patch = (proposal.patch && typeof proposal.patch === "object") ?
          proposal.patch :
          (isDeleteAction(res.action) ? {} : proposal);
        pendingProposal = {
          action: res.action,
          ruleId,
          deleteRuleId: proposal.deleteRuleId || ruleId,
          deleteRuleIds: Array.isArray(proposal.deleteRuleIds) ?
            proposal.deleteRuleIds :
            (ruleId ? [ruleId] : []),
          patch,
        };
        recordProposedRule(res);
        setProposalBoxCopy(res.action);
        document.getElementById("proposal-summary").innerHTML = summarizeProposal(res);
        document.getElementById("proposal-json").textContent = JSON.stringify(res, null, 2);
        document.getElementById("proposal-box").classList.remove("hidden");
        document.getElementById("proposal-box").scrollIntoView({behavior: "smooth", block: "nearest"});
      }
      if (Array.isArray(res.activeRuleIds)) {
        await loadRules({force: true});
      }
      saveChatState();
    } catch (e) {
      showChatThinking(false);
      appendChat("assistant", "Error: " + e.message);
      saveChatState();
    }
    showChatThinking(false);
    sendBtn.disabled = false;
    sendBtn.textContent = sendPrev;
    input.focus();
  }

  document.getElementById("chat-send").addEventListener("click", () => {
    sendChatMessage();
  });

  document.getElementById("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  document.getElementById("confirm-proposal").addEventListener("click", async () => {
    await applyPendingProposal();
  });

  document.getElementById("dismiss-proposal").addEventListener("click", () => {
    document.getElementById("proposal-box").classList.add("hidden");
    pendingProposal = null;
    lastProposedRule = null;
    clearAgentDraftMemory();
    clearQuickReplies();
    saveChatState();
  });

  document.getElementById("run-test").addEventListener("click", async () => {
    const btn = document.getElementById("run-test");
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Checking…";
    const resultEl = document.getElementById("test-result");
    resultEl.classList.remove("hidden");
    resultEl.innerHTML = "<p class=\"none\">Checking rules…</p>";
    const sample = {
      shipper: {
        name: document.getElementById("test-from-name").value,
        address1: document.getElementById("test-from-address").value,
      },
      consignee: {
        name: document.getElementById("test-name").value,
        address1: document.getElementById("test-address").value,
      },
      specialInstructions: document.getElementById("test-instructions").value,
    };
    const classifyAddress = document.getElementById("test-classify").checked;
    try {
      const res = await api("/testQuoteRules", {
        method: "POST",
        body: JSON.stringify({tenantId: TENANT_ID, sample, classifyAddress}),
      });
      resultEl.innerHTML = formatTestResult(
          res.result, res.enrichment, res.addressKey,
          res.originEnrichment, res.originAddressKey);
    } catch (e) {
      resultEl.innerHTML = `<p class="none">Error: ${esc(e.message)}</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  });

  restoreChatState();
  loadRules();
})();
