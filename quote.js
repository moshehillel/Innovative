/* eslint-env browser */
/* global QD, QuoteAuth */
/**
 * Quote review page — Netlify SPA.
 * Same functionality as the legacy quoteDispatcherPage, plus:
 *  - instant paint from prefetched/session-cached quote data
 *  - endpoint warm-up pings so Save/Generate/Approve respond fast
 */
(function () {
  "use strict";

  const TENANT_ID = QD.TENANT_ID;
  const esc = QD.esc;

  const qp = QD.params;
  const RATE_PAGE_SIZE = 20;
  const QUOTE_ID = qp.get("id") || "";
  const DISPATCHER_ID = qp.get("dispatcherId") || "";
  const TOKEN = qp.get("token") || "";
  const QUOTE_CACHE_KEY = "qd:quote:" + QUOTE_ID;
  const QUOTE_CACHE_TTL = 2 * 60 * 1000;

  QD.warmUp();

  let quote = null;
  const selections = {};
  const customerPrices = {};
  const laneAccessorials = {};
  let draftReady = false;
  const hasLegacyToken = DISPATCHER_ID && TOKEN;
  if (hasLegacyToken) QD.setLegacyAuth(DISPATCHER_ID, TOKEN);
  let accessorialCatalog = null;
  let accessorialCatalogPromise = null;
  let detailsEditMode = false;
  // True once the user touched anything — a late background refresh must
  // never clobber in-progress edits.
  let userDirty = false;

  const CATALOG_KEY = "qd:accCatalog:" + TENANT_ID;
  const CATALOG_TTL = 12 * 60 * 60 * 1000;

  const thinking = QD.createThinking("thinking-status");

  function showThinking(active) {
    const panel = document.getElementById("page-thinking");
    const ready = document.getElementById("quote-ready");
    if (!panel || !ready) return;
    if (active) {
      ready.classList.add("hidden");
      ready.classList.remove("is-visible");
      panel.classList.remove("hidden");
      panel.setAttribute("aria-busy", "true");
      thinking.start();
    } else {
      thinking.stop();
      panel.classList.add("hidden");
      panel.setAttribute("aria-busy", "false");
      ready.classList.remove("hidden");
      // Force reflow so fade-in runs after unhiding.
      void ready.offsetWidth;
      ready.classList.add("is-visible");
    }
  }

  const apiFetch = QD.api;

  function cacheQuote(q) {
    if (q) QD.ssSet(QUOTE_CACHE_KEY, q);
  }

  function showMsg(text, ok) {
    const el = document.getElementById("action-msg");
    el.textContent = text;
    el.className = "msg " + (ok ? "ok" : "err");
    el.classList.remove("hidden");
  }

  function optionRateId(opt) {
    if (!opt) return "";
    const id = opt.rateId != null && opt.rateId !== "" ? opt.rateId :
      (opt.id != null && opt.id !== "" ? opt.id : "");
    const s = String(id);
    return (!s || s === "undefined" || s === "null") ? "" : s;
  }

  function defaultCustomerPrice(opt) {
    function ceilDollar(n) {
      const v = Number(n);
      if (!isFinite(v) || v <= 0) return "";
      return Math.ceil(v);
    }
    // Prefer suggested sell. Only honor a stored override when it is
    // near sell/cost — never a leaked sibling sellRate / ZIP / id.
    const sell = ceilDollar(opt && opt.sellRate);
    const cost = ceilDollar(opt && (opt.cost != null ? opt.cost : opt.total));
    if (opt && opt.customerPrice != null && opt.customerPrice !== "") {
      const override = ceilDollar(opt.customerPrice);
      if (override !== "") {
        const o = Number(override);
        const anchor = sell !== "" ? Number(sell) :
          (cost !== "" ? Number(cost) : null);
        if (anchor == null || (o >= anchor * 0.5 && o <= anchor * 2.5)) {
          return override;
        }
      }
    }
    if (sell !== "") return sell;
    return cost;
  }

  function collectSelections() {
    return (quote.lanes || []).map((lane) => {
      const laneKey = lane.laneKey;
      const rateIds = selections[laneKey] || [];
      const prices = {};
      const byLane = customerPrices[laneKey] || {};
      (lane.options || []).forEach((opt) => {
        const rateId = optionRateId(opt);
        if (!rateId) return;
        const raw = byLane[rateId];
        const n = raw != null && raw !== "" ? Number(raw) :
          Number(defaultCustomerPrice(opt));
        if (isFinite(n) && n > 0) prices[rateId] = Math.ceil(n);
      });
      return {
        laneKey,
        rateIds,
        customerPrices: prices,
      };
    });
  }

  function validateCheckedCustomerRates() {
    const missing = [];
    (quote.lanes || []).forEach((lane) => {
      const rateIds = selections[lane.laneKey] || [];
      const byLane = customerPrices[lane.laneKey] || {};
      rateIds.forEach((rateId) => {
        const opt = (lane.options || [])
            .find((o) => optionRateId(o) === String(rateId));
        const raw = byLane[rateId];
        const n = raw != null && raw !== "" ? Number(raw) :
          Number(defaultCustomerPrice(opt));
        if (!(n > 0)) {
          missing.push((opt && (opt.name || opt.SCAC)) || rateId);
        }
      });
    });
    return missing;
  }

  function renderCustomerMatch(q) {
    const el = document.getElementById("customer-match");
    if (!el) return;
    const bits = [];
    if (q.customerLookupStatus === "no_match" ||
        q.customerMatchMessage === "No Primus match for name") {
      const qName = q.customerLookupQuery || q.shippingLocationName || "";
      bits.push("<span class='badge nomatch'>No Primus match" +
        (qName ? " (“" + esc(qName) + "”)" : "") +
        "</span>");
    } else if (q.customerMatched && q.shippingLocationId) {
      const name = q.shippingLocationName ?
        esc(q.shippingLocationName) + " · " : "";
      bits.push("<span class='badge match'>Primus customer: " +
        name + "ID " + esc(q.shippingLocationId) + "</span>");
    } else {
      bits.push("<span class='badge nomatch'>" +
        "No Primus match — set customer rates manually</span>");
    }
    if (q.rateSource === "market_fallback" ||
        q.rateSource === "market_fallback_fak") {
      bits.push("<span class='badge market'>rate source: market fallback" +
        (q.rateSource === "market_fallback_fak" ? " + FAK" : "") +
        "</span>");
    } else if (q.rateSource === "customer") {
      bits.push("<span class='badge match'>rate source: customer</span>");
    }
    el.innerHTML = bits.join("");
    el.classList.remove("hidden");
  }

  function uniqueWarns(list) {
    const out = [];
    (list || []).forEach((w) => {
      const t = String(w || "").trim();
      if (t && out.indexOf(t) < 0) out.push(t);
    });
    return out;
  }

  function renderQuoteWarnings(q) {
    const el = document.getElementById("quote-warnings");
    if (!el) return;
    const warns = uniqueWarns(q.extractionWarnings);
    (q.lanes || []).forEach((lane) => {
      uniqueWarns(lane.extractionWarnings).forEach((w) => {
        if (warns.indexOf(w) < 0) warns.push(w);
      });
    });
    if ((q.rateSource === "market_fallback" ||
          q.rateSource === "market_fallback_fak") &&
        warns.indexOf("market fallback") < 0 &&
        warns.indexOf("market fallback + FAK markup") < 0) {
      warns.push(q.rateSource === "market_fallback_fak" ?
        "market fallback + FAK markup" : "market fallback");
    }
    if (!warns.length) {
      el.innerHTML = "";
      el.classList.add("hidden");
      return;
    }
    el.innerHTML = warns.map((w) =>
      "<div class='warn'>" + esc(w) + "</div>").join("");
    el.classList.remove("hidden");
  }

  async function persistSelections() {
    try {
      await apiFetch("/saveQuoteSelections", {
        method: "POST",
        body: JSON.stringify({
          tenantId: TENANT_ID,
          quoteId: QUOTE_ID,
          selections: collectSelections(),
          dispatcherId: DISPATCHER_ID || undefined,
          token: TOKEN || undefined,
        }),
      });
    } catch (_) { /* non-fatal */ }
  }

  function fallbackAccessorialCatalog() {
    return {
      origin: [
        {label: "Liftgate at Origin", code: "LFO", selectable: true},
        {label: "Appointment at Origin", code: "APO", selectable: true},
        {label: "Limited Access Pickup", code: "LAO", selectable: true},
        {label: "Residential Pickup", code: "RSO", selectable: true},
      ],
      destination: [
        {label: "Liftgate at Destination", code: "LFD", selectable: true},
        {label: "Appointment at Destination", code: "APD", selectable: true},
        {label: "Limited Access Delivery", code: "LAD", selectable: true},
        {label: "Residential Delivery", code: "RSD", selectable: true},
        {label: "Nursing Home Delivery", code: "NUD", selectable: true},
        {label: "Hotel Delivery", code: "HOD", selectable: true},
      ],
      other: [],
      source: "client-fallback",
    };
  }

  async function loadAccessorialCatalog() {
    const cached = QD.lsGet(CATALOG_KEY, CATALOG_TTL);
    if (cached) {
      accessorialCatalog = cached;
      // Refresh quietly for next time.
      apiFetch("/getQuoteAccessorialCatalog?" + QD.tenantQS)
          .then((res) => {
            if (res && res.ok !== false &&
                (res.origin || res.destination || res.other)) {
              QD.lsSet(CATALOG_KEY, res);
            }
          })
          .catch(() => {});
      return accessorialCatalog;
    }
    try {
      const res = await apiFetch("/getQuoteAccessorialCatalog?" + QD.tenantQS);
      if (res && res.ok !== false &&
          (res.origin || res.destination || res.other)) {
        accessorialCatalog = res;
        QD.lsSet(CATALOG_KEY, res);
        return accessorialCatalog;
      }
    } catch (_) { /* use fallback below */ }
    accessorialCatalog = fallbackAccessorialCatalog();
    return accessorialCatalog;
  }

  function ensureAccessorialCatalog() {
    if (accessorialCatalog) return Promise.resolve(accessorialCatalog);
    if (!accessorialCatalogPromise) {
      accessorialCatalogPromise = loadAccessorialCatalog()
          .catch(() => {
            accessorialCatalog = fallbackAccessorialCatalog();
            return accessorialCatalog;
          })
          .finally(() => {
            accessorialCatalogPromise = null;
          });
    }
    return accessorialCatalogPromise;
  }

  async function load() {
    // Instant paint if the home page prefetched this quote.
    const cached = QD.ssGet(QUOTE_CACHE_KEY, QUOTE_CACHE_TTL);
    const hasCached = !!(cached && cached.lanes);
    if (hasCached) {
      quote = cached;
      applyQuote(quote);
      showThinking(false);
    } else {
      showThinking(true);
    }
    const url = "/getQuoteDispatcherData?id=" +
      encodeURIComponent(QUOTE_ID) + "&" + QD.tenantQS;
    // Kick catalog in parallel — never block first paint on Primus catalog.
    ensureAccessorialCatalog();
    let res;
    try {
      res = await apiFetch(url);
    } catch (err) {
      if (!hasCached) {
        showThinking(false);
        document.getElementById("meta").textContent =
          err.message || "Failed to load";
      }
      return;
    }
    if (!res.ok) {
      if (!hasCached) {
        showThinking(false);
        document.getElementById("meta").textContent =
          res.error || "Failed to load";
      }
      return;
    }
    cacheQuote(res.quote);
    // Never clobber in-progress edits with a background refresh.
    if (hasCached && userDirty) return;
    quote = res.quote;
    applyQuote(quote);
    showThinking(false);
  }

  function applyQuoteStatusChrome(q) {
    if (!q) return;
    const badge = document.getElementById("status-badge");
    if (badge) {
      badge.textContent = q.status || "";
      badge.className = "badge " + (q.status || "");
    }
    const forReview = !!q.forReview;
    const reviewBadge = document.getElementById("review-badge");
    if (reviewBadge) reviewBadge.classList.toggle("hidden", !forReview);
    const reviewBtn = document.getElementById("btn-for-review");
    if (reviewBtn) {
      reviewBtn.textContent = forReview ? "Unmark review" : "For review";
      reviewBtn.classList.toggle("is-on", forReview);
      reviewBtn.disabled = q.status === "dismissed" || q.status === "completed";
    }
    const completeBtn = document.getElementById("btn-complete");
    if (completeBtn) {
      const isCompleted = q.status === "completed" || !!q.completedAt;
      completeBtn.textContent = isCompleted ? "Undo complete" : "Complete";
      completeBtn.disabled = q.status === "dismissed";
      completeBtn.setAttribute("data-completed", isCompleted ? "1" : "0");
    }
    const locked = q.status === "sent" || q.status === "dismissed" ||
      q.status === "completed";
    document.querySelectorAll(".btn-rerun").forEach((el) => {
      el.disabled = locked;
    });
    const approveBtn = document.getElementById("btn-approve");
    if (approveBtn) approveBtn.disabled = !draftReady || locked;
    const copyBtn = document.getElementById("btn-copy");
    const draftEl = document.getElementById("draft-text");
    if (copyBtn) copyBtn.disabled = !(draftEl && draftEl.value);
    const generateBtn = document.getElementById("btn-generate");
    if (generateBtn) generateBtn.disabled = locked;
    const dismissBtn = document.getElementById("btn-dismiss");
    if (dismissBtn) {
      dismissBtn.disabled = locked;
      if (q.status === "dismissed") dismissBtn.textContent = "Dismissed";
      else if (dismissBtn.getAttribute("data-confirm") !== "1") {
        dismissBtn.textContent = "Dismiss";
      }
    }
  }

  function applyQuote(q) {
    quote = q;
    detailsEditMode = false;
    document.getElementById("title").textContent = quote.batchQuoteId || "Quote";
    const custBits = [];
    if (quote.shippingLocationName) custBits.push(quote.shippingLocationName);
    if (quote.shippingLocationId) {
      custBits.push("ID " + quote.shippingLocationId);
    }
    document.getElementById("meta").textContent =
      (custBits.length ? custBits.join(" · ") + " — " : "") +
      (quote.from || "") + " — " + (quote.subject || "");
    renderCustomerMatch(quote);
    renderQuoteWarnings(quote);
    draftReady = quote.status === "draft_ready" || quote.status === "sent" ||
      !!(quote.customerEmailText);
    document.getElementById("draft-text").value =
      quote.customerEmailText || quote.customerDraftText || "";
    applyQuoteStatusChrome(quote);

    (quote.lanes || []).forEach((lane) => {
      selections[lane.laneKey] = (lane.selectedRateIds || []).slice();
      laneAccessorials[lane.laneKey] = (lane.accessorials || []).slice();
      const prices = {};
      (lane.options || []).forEach((opt) => {
        const rateId = optionRateId(opt);
        if (!rateId) return;
        prices[rateId] = defaultCustomerPrice(opt);
      });
      customerPrices[lane.laneKey] = prices;
    });
    renderQuoteDetails(quote);
    renderLanes();
    applyQuoteStatusChrome(quote);
    if (draftReady) collapseRatesSections();
    // If catalog finished while we rendered, fill panels without a second trip.
    if (accessorialCatalog) {
      document.querySelectorAll(".acc-panel").forEach((panel) => {
        if (!panel.dataset.accFilled) {
          fillAccPanel(panel, accessorialCatalog);
          panel.dataset.accFilled = "1";
        }
      });
    } else {
      ensureAccessorialCatalog().then((cat) => {
        document.querySelectorAll(".acc-panel").forEach((panel) => {
          if (panel.dataset.accFilled) return;
          fillAccPanel(panel, cat);
          panel.dataset.accFilled = "1";
        });
      });
    }
  }

  function partyField(party, field) {
    const p = party && typeof party === "object" ? party : {};
    if (field === "zipCode") {
      return p.zipCode || p.zip || p.zipcode || "";
    }
    return p[field] != null ? p[field] : "";
  }

  function siteTypeLabel(meta, fallback) {
    const t = (meta && meta.classifiedAs) || fallback;
    if (!t) return "";
    const labels = {
      nursing_home: "nursing home",
      hotel: "hotel",
      amazon_fc: "Amazon FC",
      menards_dc: "Menards DC",
      aafes_military: "AAFES / military",
      chain_store: "chain store",
      residential: "residential",
      other: "commercial / other",
    };
    return labels[t] || String(t).replace(/_/g, " ");
  }

  function displayText(value) {
    return value == null ? "" : String(value).trim();
  }

  function renderFact(label, value, span2) {
    const v = displayText(value);
    return "<div class='fact" + (span2 ? " span-2" : "") + "'>" +
      "<span class='field-label'>" + esc(label) + "</span>" +
      "<div class='fact-value" + (v ? "" : " muted") + "'>" +
      (v ? esc(v) : "—") + "</div></div>";
  }

  function renderAddressReadonly(party, title, enrichment, fallbackType) {
    const p = party || {};
    const name = displayText(partyField(p, "name"));
    const a1 = displayText(partyField(p, "address1"));
    const a2 = displayText(partyField(p, "address2"));
    const city = displayText(partyField(p, "city"));
    const state = displayText(partyField(p, "state"));
    const zip = displayText(partyField(p, "zipCode"));
    const country = displayText(partyField(p, "country"));
    const phone = displayText(partyField(p, "phone"));
    const cityLine = [city, state].filter(Boolean).join(", ") +
      (zip ? (city || state ? " " : "") + zip : zip);
    const lines = [a1, a2, cityLine, country, phone].filter(Boolean);
    let html = "<div class='addr-block'>";
    html += "<h3>" + esc(title);
    const typeLabel = siteTypeLabel(enrichment, fallbackType);
    if (typeLabel) {
      const place = enrichment && enrichment.placeName ?
        " · " + enrichment.placeName : "";
      html += "<span class='site-type-chip'>" + esc(typeLabel + place) +
        "</span>";
    }
    html += "</h3>";
    if (name) html += "<div class='addr-name'>" + esc(name) + "</div>";
    if (lines.length) {
      html += "<div class='addr-lines'>" + esc(lines.join("\n")) + "</div>";
    } else if (!name) {
      html += "<div class='addr-missing'>No address</div>";
    }
    html += "</div>";
    return html;
  }

  function renderFreightReadonly(freightInfo) {
    const rows = Array.isArray(freightInfo) ?
      freightInfo.filter(Boolean) : [];
    let html = "<div class='freight-block'>";
    html += "<h3>Freight / dimensions</h3>";
    if (!rows.length) {
      html += "<div class='freight-missing'>No freight lines</div></div>";
      return html;
    }
    html += "<table class='freight-table'><thead><tr>" +
      "<th>Qty</th><th>Weight</th><th>Class</th><th>L×W×H</th><th>Type</th>" +
      "</tr></thead><tbody>";
    rows.forEach((f) => {
      // Never show orphan weightType ("total") as the Weight cell —
      // that looks like lbs were parsed as the word "total".
      const numW = Number(f.weight);
      const hasLbs = f.weight != null && f.weight !== "" &&
        Number.isFinite(numW) && numW > 0;
      const wtType = String(f.weightType || "").trim().toLowerCase();
      const wtTypeOk = wtType === "each" || wtType === "total";
      const wt = hasLbs ?
        (String(f.weight) + (wtTypeOk ? " " + wtType : "")) : "";
      const dims = [f.length, f.width, f.height]
          .filter((v) => v != null && v !== "").join("×");
      const dimType = f.dimType || f.packaging || "";
      html += "<tr>" +
        "<td>" + esc(f.qty != null && f.qty !== "" ? f.qty : "—") + "</td>" +
        "<td>" + esc(wt || "—") + "</td>" +
        "<td>" + esc(f.class != null && f.class !== "" ? f.class : "—") +
        "</td>" +
        "<td>" + esc(dims || "—") + "</td>" +
        "<td>" + esc(dimType || "—") + "</td>" +
        "</tr>";
    });
    html += "</tbody></table>";
    const densityRows = rows.filter((f) => f.classSource === "density");
    if (densityRows.length) {
      const bits = densityRows.map((f) => {
        if (f.emailClass != null && Number(f.emailClass) !== Number(f.class)) {
          return "email class " + f.emailClass + " → Primus " + f.class;
        }
        return "Primus class " + f.class;
      });
      html += "<p class='class-hint'>Class from Primus density " +
        "(weight × L×W×H; email class ignored): " +
        esc(bits.join("; ")) + ".</p>";
    }
    html += "</div>";
    return html;
  }

  function rulesStorageKey(laneKey) {
    return "qd-rules-open:" + QUOTE_ID + ":" + laneKey;
  }

  function getRulesOpen(laneKey) {
    try {
      return sessionStorage.getItem(rulesStorageKey(laneKey)) === "1";
    } catch (_) {
      return false;
    }
  }

  function persistRulesOpen(laneKey, open) {
    try {
      sessionStorage.setItem(rulesStorageKey(laneKey), open ? "1" : "0");
    } catch (_) { /* ignore */ }
  }

  function setRulesSectionOpen(section, open) {
    if (!section) return;
    section.classList.toggle("open", !!open);
    const btn = section.querySelector("[data-rules-toggle]");
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
    const laneKey = section.getAttribute("data-lane");
    if (laneKey) persistRulesOpen(laneKey, !!open);
  }

  function bindRulesSectionToggles(root) {
    (root || document).querySelectorAll("[data-rules-toggle]").forEach((btn) => {
      if (btn.dataset.boundRulesToggle === "1") return;
      btn.dataset.boundRulesToggle = "1";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const section = btn.closest(".rules-section");
        if (!section) return;
        setRulesSectionOpen(section, !section.classList.contains("open"));
      });
    });
  }

  function countedAppliedRules(lane) {
    const rules = Array.isArray(lane.appliedRules) ? lane.appliedRules : [];
    if (rules.length) return rules.length;
    return (lane.accessorialWhy || []).length;
  }

  function renderRulesSection(lane) {
    const why = lane.accessorialWhy || [];
    const n = countedAppliedRules(lane);
    const open = getRulesOpen(lane.laneKey);
    let body;
    if (why.length) {
      body = "<ul class='rules-list'>" + why.map((w) => {
        const notes = w.notes ? " — " + w.notes : "";
        return "<li>" + esc(w.name || "Rule") + esc(notes) + "</li>";
      }).join("") + "</ul>";
    } else if ((lane.accessorials || []).length) {
      body = "<div class='rules-list' style='padding-left:0;list-style:none'>" +
        "Applied from quote rules / address classification." +
        (lane.accessorialLabels ? " " + esc(lane.accessorialLabels) : "") +
        "</div>";
    } else {
      body = "<div class='fact-value muted'>No rules applied.</div>";
    }
    return "<div class='rules-section" + (open ? " open" : "") +
      "' data-rules-section='1' data-lane='" + esc(lane.laneKey) + "'>" +
      "<button type='button' class='rates-section-toggle' " +
        "aria-expanded='" + (open ? "true" : "false") +
        "' data-rules-toggle='1'>" +
        "<span class='rates-chevron'>▶</span>" +
        "<h4>Rules (" + n + " applied)</h4>" +
      "</button>" +
      "<div class='rates-list'>" + body + "</div>" +
    "</div>";
  }

  function bindFreightEditors(root) {
    (root || document).querySelectorAll(".btn-add-freight").forEach((btn) => {
      if (btn.dataset.boundFreight === "1") return;
      btn.dataset.boundFreight = "1";
      btn.addEventListener("click", () => {
        userDirty = true;
        const block = btn.closest("[data-freight-lane]");
        if (!block) return;
        const tbody = block.querySelector("tbody");
        if (!tbody) return;
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td><input data-f='qty' value=''></td>" +
          "<td><input data-f='weight' value=''></td>" +
          "<td><select data-f='weightType'>" +
          "<option value='total' selected>total</option>" +
          "<option value='each'>each</option></select></td>" +
          "<td><input data-f='class' value=''></td>" +
          "<td><input data-f='length' value=''></td>" +
          "<td><input data-f='width' value=''></td>" +
          "<td><input data-f='height' value=''></td>" +
          "<td><input data-f='dimType' value='PLT'></td>" +
          "<td><button type='button' class='ghost btn-rm-freight' " +
          "title='Remove line'>×</button></td>";
        tbody.appendChild(tr);
        const rm = tr.querySelector(".btn-rm-freight");
        if (rm) {
          rm.dataset.boundFreight = "1";
          rm.addEventListener("click", () => tr.remove());
        }
      });
    });
    (root || document).querySelectorAll(".btn-rm-freight").forEach((btn) => {
      if (btn.dataset.boundFreight === "1") return;
      btn.dataset.boundFreight = "1";
      btn.addEventListener("click", () => {
        const tr = btn.closest("tr");
        if (tr) tr.remove();
      });
    });
  }

  function setDetailsEditMode(on) {
    detailsEditMode = !!on;
    if (on) userDirty = true;
    renderQuoteDetails(quote);
    document.querySelectorAll(".lane[data-lane-key]").forEach((laneEl) => {
      const laneKey = laneEl.getAttribute("data-lane-key");
      const lane = (quote.lanes || []).find((l) => l.laneKey === laneKey);
      const holder = laneEl.querySelector("[data-lane-summary]");
      if (!holder || !lane) return;
      holder.innerHTML = renderLaneSummaryBody(lane);
      if (detailsEditMode) bindFreightEditors(holder);
    });
  }

  function renderAddressEditor(prefix, party, title, enrichment, fallbackType) {
    const p = party || {};
    let html = "<div class='addr-block addr-edit' data-addr='" + esc(prefix) + "'>";
    html += "<h3>" + esc(title);
    const typeLabel = siteTypeLabel(enrichment, fallbackType);
    if (typeLabel) {
      const place = enrichment && enrichment.placeName ?
        " · " + enrichment.placeName : "";
      html += "<span class='site-type-chip'>" + esc(typeLabel + place) +
        "</span>";
    }
    html += "</h3>";
    html += "<label class='field-label'>Name</label>" +
      "<input class='field-input' data-f='name' value='" +
      esc(partyField(p, "name")) + "'>";
    html += "<label class='field-label'>Address 1</label>" +
      "<input class='field-input' data-f='address1' value='" +
      esc(partyField(p, "address1")) + "'>";
    html += "<label class='field-label'>Address 2</label>" +
      "<input class='field-input' data-f='address2' value='" +
      esc(partyField(p, "address2")) + "'>";
    html += "<div class='addr-row cols-3'>";
    html += "<div><label class='field-label'>City</label>" +
      "<input class='field-input' data-f='city' value='" +
      esc(partyField(p, "city")) + "'></div>";
    html += "<div><label class='field-label'>State</label>" +
      "<input class='field-input' data-f='state' value='" +
      esc(partyField(p, "state")) + "'></div>";
    html += "<div><label class='field-label'>Zip</label>" +
      "<input class='field-input' data-f='zipCode' value='" +
      esc(partyField(p, "zipCode")) + "'></div>";
    html += "</div>";
    html += "<div class='addr-row cols-2'>";
    html += "<div><label class='field-label'>Country</label>" +
      "<input class='field-input' data-f='country' value='" +
      esc(partyField(p, "country") || "US") + "'></div>";
    html += "<div><label class='field-label'>Phone</label>" +
      "<input class='field-input' data-f='phone' value='" +
      esc(partyField(p, "phone")) + "'></div>";
    html += "</div></div>";
    return html;
  }

  function renderFreightEditor(laneKey, freightInfo) {
    const rows = Array.isArray(freightInfo) && freightInfo.length ?
      freightInfo.slice() : [{
        qty: "", weight: "", weightType: "total", class: "",
        length: "", width: "", height: "", dimType: "PLT",
      }];
    let html = "<div class='freight-block' data-freight-lane='" +
      esc(laneKey) + "'>";
    html += "<h3>Freight / dimensions</h3>";
    html += "<table class='freight-edit'><thead><tr>" +
      "<th>Qty</th><th>Weight</th><th>Wt type</th><th>Class</th>" +
      "<th>L</th><th>W</th><th>H</th><th>Dim type</th><th></th>" +
      "</tr></thead><tbody>";
    rows.forEach((f, i) => {
      const wt = f.weightType === "each" ? "each" : "total";
      html += "<tr data-freight-row='" + i + "'>";
      ["qty", "weight"].forEach((k) => {
        html += "<td><input data-f='" + k + "' value='" +
          esc(f[k] != null ? f[k] : "") + "'></td>";
      });
      html += "<td><select data-f='weightType'>" +
        "<option value='total'" + (wt === "total" ? " selected" : "") +
        ">total</option>" +
        "<option value='each'" + (wt === "each" ? " selected" : "") +
        ">each</option></select></td>";
      html += "<td><input data-f='class' value='" +
        esc(f.class != null ? f.class : "") + "'" +
        (f.classSource === "density" ?
          " title='Primus density class from weight and L×W×H'" : "") +
        "></td>";
      ["length", "width", "height"].forEach((k) => {
        html += "<td><input data-f='" + k + "' value='" +
          esc(f[k] != null ? f[k] : "") + "'></td>";
      });
      html += "<td><input data-f='dimType' value='" +
        esc(f.dimType || f.packaging || "PLT") + "'></td>";
      html += "<td><button type='button' class='ghost btn-rm-freight' " +
        "title='Remove line'>×</button></td>";
      html += "</tr>";
    });
    html += "</tbody></table>";
    const densityRows = rows.filter((f) => f.classSource === "density");
    if (densityRows.length) {
      const bits = densityRows.map((f) => {
        if (f.emailClass != null && Number(f.emailClass) !== Number(f.class)) {
          return "email class " + f.emailClass + " → Primus " + f.class;
        }
        return "Primus class " + f.class;
      });
      html += "<p class='class-hint'>Class from Primus density " +
        "(weight × L×W×H; email class ignored): " +
        esc(bits.join("; ")) + ".</p>";
    }
    html += "<button type='button' class='ghost btn-add-freight' " +
      "data-lane='" + esc(laneKey) +
      "' style='margin-top:8px'>Add freight line</button>";
    html += "</div>";
    return html;
  }

  function readAddressBlock(root, selector) {
    const block = root.querySelector(selector);
    if (!block) return null;
    const out = {};
    block.querySelectorAll("[data-f]").forEach((el) => {
      out[el.getAttribute("data-f")] = el.value;
    });
    return out;
  }

  function readFreightBlock(root, laneKey) {
    const block = root.querySelector(
        '[data-freight-lane="' + laneKey + '"]');
    if (!block) return [];
    const rows = [];
    block.querySelectorAll("tbody tr").forEach((tr) => {
      const row = {};
      tr.querySelectorAll("[data-f]").forEach((el) => {
        row[el.getAttribute("data-f")] = el.value;
      });
      rows.push(row);
    });
    return rows;
  }

  function collectQuoteDetailsPayload() {
    const detailsRoot = document.getElementById("quote-details");
    const val = (sel) => {
      const node = detailsRoot && detailsRoot.querySelector(sel);
      return node ? node.value : "";
    };
    const payload = {
      customerRef: val("[data-q='customerRef']"),
      shippingLocationName: val("[data-q='customerName']"),
      readyDate: val("[data-q='readyDate']"),
      specialInstructionsGlobal: val("[data-q='specialGlobal']"),
      shipper: readAddressBlock(detailsRoot, "[data-addr='quote-shipper']"),
      lanes: [],
    };
    document.querySelectorAll(".lane[data-lane-key]").forEach((laneEl) => {
      const laneKey = laneEl.getAttribute("data-lane-key");
      payload.lanes.push({
        laneKey,
        shipper: readAddressBlock(laneEl, "[data-addr='shipper']"),
        consignee: readAddressBlock(laneEl, "[data-addr='consignee']"),
        freightInfo: readFreightBlock(laneEl, laneKey),
        specialInstructions: (laneEl.querySelector("[data-lane-special]") ||
          {value: ""}).value,
      });
    });
    return payload;
  }

  function renderQuoteDetails(q) {
    const el = document.getElementById("quote-details");
    if (!el) return;
    if (!detailsEditMode) {
      let html = "<div class='details-head'><h3>Quote details</h3>" +
        "<button type='button' class='ghost' id='btn-edit-details'>" +
        "Edit</button></div>";
      html += "<div class='facts-grid'>";
      html += renderFact("Customer", q.shippingLocationName);
      html += renderFact("Primus match",
          q.customerMatched && q.shippingLocationId ?
            ("Matched · ID " + q.shippingLocationId) :
            (q.customerMatchMessage || "No Primus match"));
      html += renderFact("Customer ref", q.customerRef);
      html += renderFact("Ready date",
          (q.readyDate || "").toString().slice(0, 10));
      html += renderFact("Special instructions",
          q.specialInstructionsGlobal, true);
      html += "</div>";
      html += renderAddressReadonly(
          q.shipper, "Default from (shipper)",
          q.originEnrichmentMeta, q.originSiteType);
      const accBits = (q.lanes || []).map((lane) => {
        const labels = lane.accessorialLabels ||
          (lane.accessorials || []).join(", ");
        if (!labels) return "";
        return (lane.label || lane.laneKey) + ": " + labels;
      }).filter(Boolean);
      if (accBits.length) {
        html += "<div class='facts-grid' style='margin-top:12px'>" +
          renderFact("Accessorials", accBits.join("\n"), true) +
          "</div>";
      }
      el.innerHTML = html;
      document.getElementById("btn-edit-details")
          .addEventListener("click", () => setDetailsEditMode(true));
      return;
    }

    let html = "<div class='details-head'><h3>Quote details</h3>" +
      "<button type='button' class='ghost' id='btn-cancel-details'>" +
      "Cancel</button></div>";
    html += "<p class='class-hint' style='margin:0 0 10px'>" +
      "From, To, and freight are editable in each lane below.</p>";
    html += "<div class='details-grid'>";
    html += "<div><label class='field-label'>Customer name</label>" +
      "<input class='field-input' data-q='customerName' value='" +
      esc(q.shippingLocationName || "") + "'></div>";
    html += "<div><label class='field-label'>Primus customer ID</label>" +
      "<input class='field-input' data-q='shippingLocationId' readonly " +
      "value='" + esc(q.shippingLocationId || "") + "'></div>";
    html += "<div><label class='field-label'>Customer ref</label>" +
      "<input class='field-input' data-q='customerRef' value='" +
      esc(q.customerRef || "") + "'></div>";
    html += "<div><label class='field-label'>Ready date</label>" +
      "<input class='field-input' data-q='readyDate' type='date' value='" +
      esc((q.readyDate || "").toString().slice(0, 10)) + "'></div>";
    html += "<div class='span-2'><label class='field-label'>" +
      "Special instructions (global)</label>" +
      "<textarea class='field-textarea' data-q='specialGlobal'>" +
      esc(q.specialInstructionsGlobal || "") + "</textarea></div>";
    html += "</div>";
    html += renderAddressEditor(
        "quote-shipper", q.shipper, "Default from (shipper)",
        q.originEnrichmentMeta, q.originSiteType);
    html += "<div class='details-actions'>" +
      "<button type='button' id='btn-save-details'>Save details</button>" +
      "<button type='button' class='ghost' id='btn-save-rerate'>" +
      "Save details &amp; rerun rates</button>" +
      "</div>";
    el.innerHTML = html;

    document.getElementById("btn-cancel-details")
        .addEventListener("click", () => setDetailsEditMode(false));

    const save = async (rerun) => {
      const btn = document.getElementById(
          rerun ? "btn-save-rerate" : "btn-save-details");
      const other = document.getElementById(
          rerun ? "btn-save-details" : "btn-save-rerate");
      btn.disabled = true;
      other.disabled = true;
      const prev = btn.textContent;
      btn.textContent = rerun ? "Saving & re-rating…" : "Saving…";
      try {
        const details = collectQuoteDetailsPayload();
        const res = await apiFetch("/updateQuoteDetails", {
          method: "POST",
          body: JSON.stringify({
            tenantId: TENANT_ID,
            quoteId: QUOTE_ID,
            details,
            dispatcherId: DISPATCHER_ID || undefined,
            token: TOKEN || undefined,
          }),
        });
        if (!res.ok) throw new Error(res.error || "Save details failed");
        if (rerun) {
          const rateRes = await apiFetch("/rerunQuoteRates", {
            method: "POST",
            body: JSON.stringify({
              tenantId: TENANT_ID,
              quoteId: QUOTE_ID,
              dispatcherId: DISPATCHER_ID || undefined,
              token: TOKEN || undefined,
            }),
          });
          if (!rateRes.ok) {
            throw new Error(rateRes.error || "Rerun rates failed");
          }
          applyQuote(rateRes.quote);
          cacheQuote(rateRes.quote);
          const emptyLane = (rateRes.quote && rateRes.quote.lanes || [])
              .find((l) => !(l.options || []).length);
          if (emptyLane && emptyLane.rateError) {
            showMsg(emptyLane.rateError, false);
          } else if (rateRes.customerMatchMessage) {
            showMsg(rateRes.customerMatchMessage +
              " — rates used prior customer id if any.", true);
          } else if (rateRes.customerMatch && rateRes.customerMatch.id) {
            const warn = (rateRes.quote.lanes || [])
                .map((l) => l.rateWarning).find(Boolean);
            showMsg("Details saved, Primus customer matched (" +
              (rateRes.customerMatch.name || rateRes.customerMatch.id) +
              "), rates refreshed." +
              (warn ? " " + warn : ""), true);
          } else {
            showMsg("Details saved and rates refreshed.", true);
          }
        } else {
          applyQuote(res.quote);
          cacheQuote(res.quote);
          if (res.customerMatchMessage) {
            showMsg(res.customerMatchMessage, true);
          } else if (res.customerMatch && res.customerMatch.id) {
            showMsg("Details saved. Primus customer: " +
              (res.customerMatch.name || res.customerMatch.id) +
              ". Rerun rates to refresh carrier options.", true);
          } else {
            showMsg(
                "Details saved. Rerun rates to refresh carrier options.",
                true);
          }
        }
      } catch (err) {
        showMsg(err.message || "Save details failed", false);
      } finally {
        if (btn.isConnected) {
          btn.disabled = false;
          other.disabled = false;
          btn.textContent = prev;
        }
      }
    };
    document.getElementById("btn-save-details")
        .addEventListener("click", () => save(false));
    document.getElementById("btn-save-rerate")
        .addEventListener("click", () => save(true));
  }

  function formatCarrierNote(input) {
    const note = cleanNote(input);
    if (!note) return "";
    return "<div class='carrier-note'><strong>Carrier note:</strong> " +
      esc(note.slice(0, 2000)) + "</div>";
  }

  function selectedCarrierNotesHtml(lane) {
    const selected = new Set(
        (lane.selectedRateIds || []).map(String));
    if (!selected.size && lane.selectedRateId) {
      selected.add(String(lane.selectedRateId));
    }
    const lines = [];
    (lane.options || []).forEach((opt) => {
      const rateId = optionRateId(opt);
      if (!rateId || !selected.has(String(rateId))) return;
      const note = cleanNote(opt.warnings);
      if (!note) return;
      const label = opt.name || opt.SCAC || "Carrier";
      lines.push("<div class='carrier-note'><strong>" + esc(label) +
        ":</strong> " + esc(note.slice(0, 2000)) + "</div>");
    });
    return lines.join("");
  }

  function renderLaneSummaryBody(lane) {
    if (!detailsEditMode) {
      let html = renderAddressReadonly(
          lane.shipper || (quote && quote.shipper) || null,
          "From (shipper)",
          lane.originEnrichmentMeta,
          lane.originSiteType);
      html += renderAddressReadonly(
          lane.consignee || null, "To (consignee)",
          lane.enrichmentMeta, lane.siteType);
      html += renderFreightReadonly(lane.freightInfo);
      html += renderFact("Special instructions (lane)",
          lane.specialInstructions, true);
      if (lane.accessorialLabels || (lane.accessorials || []).length) {
        html += renderFact("Accessorials",
            lane.accessorialLabels || (lane.accessorials || []).join(", "),
            true);
      }
      if (lane.rateWarning || lane.rateError) {
        html += "<div class='warn span-2' style='grid-column:1/-1'>" +
          esc(lane.rateError || lane.rateWarning) + "</div>";
      }
      if (lane.notesForCustomer) {
        html += "<div class='dispatcher-note span-2' style='grid-column:1/-1'>" +
          "<strong>Dispatcher note (not emailed)</strong>" +
          esc(lane.notesForCustomer) + "</div>";
      }
      const carrierNotes = selectedCarrierNotesHtml(lane);
      html += "<div class='span-2' style='grid-column:1/-1' data-selected-notes='1'>" +
        carrierNotes + "</div>";
      return html;
    }
    let html = "";
    html += renderAddressEditor(
        "shipper",
        lane.shipper || (quote && quote.shipper) || null,
        "From (shipper)",
        lane.originEnrichmentMeta,
        lane.originSiteType);
    html += renderAddressEditor(
        "consignee", lane.consignee || null, "To (consignee)",
        lane.enrichmentMeta, lane.siteType);
    html += renderFreightEditor(lane.laneKey, lane.freightInfo);
    html += "<div class='span-2' style='grid-column:1/-1'>" +
      "<label class='field-label'>Special instructions (lane)</label>" +
      "<textarea class='field-textarea' data-lane-special>" +
      esc(lane.specialInstructions || "") + "</textarea></div>";
    if (lane.notesForCustomer) {
      html += "<div class='dispatcher-note span-2' style='grid-column:1/-1'>" +
        "<strong>Dispatcher note (not emailed)</strong>" +
        esc(lane.notesForCustomer) + "</div>";
    }
    return html;
  }

  function renderLaneSummary(lane) {
    return "<div class='lane-summary' data-lane-summary='1'>" +
      renderLaneSummaryBody(lane) + "</div>";
  }

  function countCheckedInItems(items, accSet) {
    let n = 0;
    (items || []).forEach((a) => {
      if (a && a.code && accSet.has(a.code)) n += 1;
    });
    return n;
  }

  function renderAccOptionsHtml(items, accSet, laneKey) {
    let html = "";
    (items || []).forEach((a) => {
      const code = a.code || "";
      const label = a.label || a.name || code;
      const selectable = a.selectable !== false && !!code;
      const checked = code && accSet.has(code) ? " checked" : "";
      const disabled = selectable ? "" : " disabled";
      const cls = selectable ? "" : " disabled";
      const search = (label + " " + code).toLowerCase();
      html += "<label class='" + cls + "' data-search='" + esc(search) + "'>" +
        "<input type='checkbox' data-acc='" + esc(code) +
        "' data-lane='" + esc(laneKey) + "'" + checked + disabled + "> " +
        "<span>" + esc(label) +
        (code ? " <span class='code'>(" + esc(code) + ")</span>" : "") +
        "</span></label>";
    });
    return html;
  }

  function renderAccSection(sectionKey, title, items, accSet, laneKey, opts) {
    const loaded = !!(opts && opts.loaded);
    const loading = !!(opts && opts.loading);
    const checkedCount = loaded ?
      countCheckedInItems(items, accSet) :
      (accSet && accSet.size) || 0;
    let countLabel;
    if (loading) countLabel = "Loading…";
    else if (!loaded) countLabel = checkedCount ?
      checkedCount + " selected · expand to edit" :
      "Expand to load";
    else if (checkedCount) countLabel = checkedCount + " selected";
    else countLabel = (items || []).length + " options";

    let html = "<div class='acc-section' data-section='" + sectionKey + "'>";
    html += "<button type='button' class='acc-section-toggle' " +
      "aria-expanded='false' data-acc-toggle='1'>" +
      "<span class='acc-chevron'>▶</span>" +
      "<h4>" + esc(title) + "</h4>" +
      "<span class='acc-count'>" + esc(countLabel) + "</span>" +
      "</button>";
    html += "<div class='acc-list' data-acc-list='1'>";
    if (loading) {
      html += "<div class='empty' style='padding:8px'>Loading accessorials…</div>";
    } else if (loaded) {
      html += renderAccOptionsHtml(items, accSet, laneKey);
    }
    html += "</div></div>";
    return html;
  }

  function bindAccCheckboxHandlers(root) {
    (root || document).querySelectorAll("input[data-acc]").forEach((input) => {
      if (input.dataset.boundAcc === "1") return;
      input.dataset.boundAcc = "1";
      input.addEventListener("change", () => {
        userDirty = true;
        const laneKey = input.dataset.lane;
        const code = input.dataset.acc;
        if (!code) return;
        const set = new Set(laneAccessorials[laneKey] || []);
        if (input.checked) set.add(code);
        else set.delete(code);
        laneAccessorials[laneKey] = [...set];
      });
    });
  }

  function fillAccPanel(panel, cat) {
    if (!panel || !cat) return;
    const laneKey = panel.getAttribute("data-lane-acc");
    const lane = (quote.lanes || []).find((l) => l.laneKey === laneKey) || {};
    const accSet = new Set(laneAccessorials[laneKey] || lane.accessorials || []);
    const openSections = {};
    panel.querySelectorAll(".acc-section").forEach((section) => {
      openSections[section.getAttribute("data-section")] =
        section.classList.contains("open");
    });
    const searchEl = panel.querySelector(".acc-search");
    const searchVal = searchEl ? searchEl.value : "";

    const sectionsHost = panel.querySelector(".acc-sections");
    if (!sectionsHost) return;
    sectionsHost.innerHTML =
      renderAccSection("origin", "Origin (pickup)", cat.origin, accSet, laneKey,
          {loaded: true}) +
      renderAccSection("destination", "Destination (delivery)", cat.destination,
          accSet, laneKey, {loaded: true}) +
      renderAccSection("other", "Other", cat.other, accSet, laneKey,
          {loaded: true});

    sectionsHost.querySelectorAll(".acc-section").forEach((section) => {
      const key = section.getAttribute("data-section");
      if (openSections[key]) {
        section.classList.add("open");
        const btn = section.querySelector("[data-acc-toggle]");
        if (btn) btn.setAttribute("aria-expanded", "true");
      }
    });
    bindAccSectionToggles(panel);
    bindAccCheckboxHandlers(panel);
    if (searchEl && searchVal) {
      searchEl.value = searchVal;
      searchEl.dispatchEvent(new Event("input"));
    }
  }

  async function ensureCatalogForPanel(panel, openSection) {
    if (!panel) return;
    const sectionKey = openSection && openSection.getAttribute ?
      openSection.getAttribute("data-section") : null;

    function openByKey(key) {
      if (!key) return;
      const fresh = panel.querySelector(
          '.acc-section[data-section="' + key + '"]');
      if (!fresh) return;
      fresh.classList.add("open");
      const btn = fresh.querySelector("[data-acc-toggle]");
      if (btn) btn.setAttribute("aria-expanded", "true");
    }

    if (accessorialCatalog) {
      if (!panel.dataset.accFilled) {
        fillAccPanel(panel, accessorialCatalog);
        panel.dataset.accFilled = "1";
      }
      openByKey(sectionKey);
      return;
    }
    panel.querySelectorAll(".acc-section").forEach((section) => {
      const list = section.querySelector("[data-acc-list]");
      const count = section.querySelector(".acc-count");
      if (list) {
        list.innerHTML =
          "<div class='empty' style='padding:8px'>Loading accessorials…</div>";
      }
      if (count) count.textContent = "Loading…";
    });
    openByKey(sectionKey);
    const cat = await ensureAccessorialCatalog();
    fillAccPanel(panel, cat);
    panel.dataset.accFilled = "1";
    openByKey(sectionKey);
  }

  function bindAccSectionToggles(root) {
    (root || document).querySelectorAll("[data-acc-toggle]").forEach((btn) => {
      if (btn.dataset.boundToggle === "1") return;
      btn.dataset.boundToggle = "1";
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const section = btn.closest(".acc-section");
        const panel = btn.closest(".acc-panel");
        if (!section || !panel) return;
        const willOpen = !section.classList.contains("open");
        if (willOpen) {
          await ensureCatalogForPanel(panel, section);
        } else {
          section.classList.remove("open");
          btn.setAttribute("aria-expanded", "false");
        }
      });
    });
  }

  function ratesSectionCountLabel(rateCount, selectedCount) {
    if (!rateCount) return "No rates";
    if (selectedCount) {
      return selectedCount + " selected · check to include in email";
    }
    return rateCount + " options · check to include in email";
  }

  function updateRatesSectionCount(laneEl, selectedCount) {
    if (!laneEl) return;
    const countEl = laneEl.querySelector(".rates-section .rates-count");
    if (!countEl) return;
    const laneKey = laneEl.getAttribute("data-lane-key");
    const lane = (quote.lanes || []).find((l) => l.laneKey === laneKey);
    const rateCount = ((lane && lane.options) || []).length;
    countEl.textContent = ratesSectionCountLabel(rateCount, selectedCount);
  }

  function setRatesSectionOpen(section, open) {
    if (!section) return;
    section.classList.toggle("open", !!open);
    const btn = section.querySelector("[data-rates-toggle]");
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function collapseRatesSections(root) {
    (root || document).querySelectorAll(".rates-section").forEach((section) => {
      setRatesSectionOpen(section, false);
    });
  }

  function bindRatesSectionToggles(root) {
    (root || document).querySelectorAll("[data-rates-toggle]").forEach((btn) => {
      if (btn.dataset.boundRatesToggle === "1") return;
      btn.dataset.boundRatesToggle = "1";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const section = btn.closest(".rates-section");
        if (!section) return;
        setRatesSectionOpen(section, !section.classList.contains("open"));
      });
    });
  }

  function rateOptionCardHtml(lane, opt) {
    const rateId = optionRateId(opt);
    const selectedSet = new Set(selections[lane.laneKey] || []);
    const isChecked = rateId ? selectedSet.has(rateId) : false;
    const custVal = rateId && customerPrices[lane.laneKey] &&
      customerPrices[lane.laneKey][rateId] != null ?
      customerPrices[lane.laneKey][rateId] : defaultCustomerPrice(opt);
    const custStr = custVal === "" || custVal == null ? "" :
      (isFinite(Number(custVal)) ?
        String(Math.ceil(Number(custVal))) : "");
    const sellHint = Number(opt.sellRate);
    const showSuggested = isFinite(sellHint) &&
      Number(custVal) !== Math.ceil(sellHint);
    const note = cleanNote(opt.warnings);
    return `<div class="opt${isChecked ? " checked" : ""}">
      <input type="checkbox" data-lane="${esc(lane.laneKey)}" data-rate="${esc(rateId)}"${isChecked ? " checked" : ""}>
      <div>
      <div class="tags">${(opt.tags || []).map((t) => '<span class="tag">' + esc(t) + "</span>").join("")}</div>
      <div><strong>${esc(opt.name || opt.SCAC)}</strong></div>
        <div class="rate-row">
          <span class="rate-cost">Cost $${num(opt.cost)}</span>
          <label class="customer-rate-field">Customer rate $
            <input type="number" min="1" step="1"
              data-customer-rate="1"
              data-lane="${esc(lane.laneKey)}"
              data-rate="${esc(rateId)}"
              value="${esc(custStr)}">
          </label>
          ${showSuggested ? `<span class="suggested-sell">suggested sell $${num(opt.sellRate)}</span>` : ""}
          <span class="rate-meta">${opt.transitDays || "?"} days${opt.quoteNumber ? " · Q# " + esc(opt.quoteNumber) : ""}${opt.costQuoteId ? " · saved" : ""}</span>
        </div>
        ${note ? formatCarrierNote(note) : ""}
      </div>
    </div>`;
  }

  function bindRateOptionInputs(scope) {
    if (!scope) return;
    scope.querySelectorAll("input[data-rate]:not([data-customer-rate])").forEach((input) => {
      if (input.dataset.boundRate === "1") return;
      input.dataset.boundRate = "1";
      input.addEventListener("change", () => {
        userDirty = true;
        const laneKey = input.dataset.lane;
        const rateId = String(input.dataset.rate);
        const set = new Set(selections[laneKey] || []);
        if (input.checked) set.add(rateId);
        else set.delete(rateId);
        selections[laneKey] = [...set];
        input.closest(".opt").classList.toggle("checked", input.checked);
        const laneEl = input.closest(".lane");
        const lane = (quote.lanes || []).find((l) => l.laneKey === laneKey);
        const headMeta = laneEl && laneEl.querySelector(".lane-head span:last-child");
        if (headMeta) {
          headMeta.textContent =
            ((lane && lane.options) || []).length + " rates · " +
            set.size + " selected";
        }
        updateRatesSectionCount(laneEl, set.size);
        if (lane) {
          lane.selectedRateIds = [...set];
          const notesEl = laneEl && laneEl.querySelector("[data-selected-notes]");
          if (notesEl) notesEl.innerHTML = selectedCarrierNotesHtml(lane);
        }
        draftReady = false;
        document.getElementById("btn-approve").disabled = true;
        persistSelections();
      });
    });
    scope.querySelectorAll("input[data-customer-rate]").forEach((input) => {
      if (input.dataset.boundCust === "1") return;
      input.dataset.boundCust = "1";
      const sync = () => {
        userDirty = true;
        const laneKey = input.dataset.lane;
        const rateId = String(input.dataset.rate);
        if (!customerPrices[laneKey]) customerPrices[laneKey] = {};
        customerPrices[laneKey][rateId] = input.value;
        draftReady = false;
        document.getElementById("btn-approve").disabled = true;
      };
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("mousedown", (e) => e.stopPropagation());
      input.addEventListener("change", () => {
        sync();
        persistSelections();
      });
      input.addEventListener("blur", () => {
        sync();
        persistSelections();
      });
    });
  }

  function renderLanes() {
    const root = document.getElementById("lanes");
    root.innerHTML = "";
    const cat = accessorialCatalog;
    const loaded = !!cat;

    (quote.lanes || []).forEach((lane, idx) => {
      const div = document.createElement("div");
      div.className = "lane" + (idx === 0 ? " open" : "");
      div.setAttribute("data-lane-key", lane.laneKey);
      const selected = new Set(selections[lane.laneKey] || []);
      const accSet = new Set(laneAccessorials[lane.laneKey] || lane.accessorials || []);

      const whyHtml = renderRulesSection(lane);

      let toggles = "<div class='acc-panel' data-lane-acc='" + esc(lane.laneKey) + "'" +
        (loaded ? " data-acc-filled='1'" : "") + ">";
      toggles += "<input type='search' class='acc-search' placeholder='Search accessorials…' " +
        "data-lane='" + esc(lane.laneKey) + "'>";
      toggles += "<div class='acc-sections'>";
      toggles += renderAccSection("origin", "Origin (pickup)",
          loaded ? cat.origin : [], accSet, lane.laneKey, {loaded});
      toggles += renderAccSection("destination", "Destination (delivery)",
          loaded ? cat.destination : [], accSet, lane.laneKey, {loaded});
      toggles += renderAccSection("other", "Other",
          loaded ? cat.other : [], accSet, lane.laneKey, {loaded});
      toggles += "</div>";
      toggles += "<button type='button' class='ghost btn-rerun' data-lane='" +
        esc(lane.laneKey) + "'>Rerun quote with these accessorials</button>";
      toggles += "</div>";

      let optsHtml = "";
      if (lane.rateError) {
        optsHtml = "<div class='warn'>Rate error: " + esc(lane.rateError) + "</div>";
      } else if (lane.rateWarning) {
        optsHtml = "<div class='warn'>" + esc(lane.rateWarning) + "</div>";
      }
      if ((lane.rateSource === "market_fallback" ||
            lane.rateSource === "market_fallback_fak") &&
          !lane.rateWarning) {
        optsHtml += "<div class='warn'>Showing market rates — no " +
          "customer carrier tariffs on this Primus profile.</div>";
      }
      uniqueWarns(lane.extractionWarnings).forEach((w) => {
        if (lane.rateWarning && lane.rateWarning.indexOf(w) >= 0) return;
        if (w === "market fallback" &&
            (lane.rateSource === "market_fallback" ||
              lane.rateSource === "market_fallback_fak")) {
          return;
        }
        if (w === "market fallback + FAK markup" &&
            lane.rateSource === "market_fallback_fak") {
          return;
        }
        optsHtml += "<div class='warn'>" + esc(w) + "</div>";
      });
      const allRateOpts = lane.options || [];
      const firstRates = allRateOpts.slice(0, RATE_PAGE_SIZE);
      firstRates.forEach((opt) => {
        optsHtml += rateOptionCardHtml(lane, opt);
      });
      if (allRateOpts.length > firstRates.length) {
        optsHtml += "<button type='button' class='ghost btn-load-more-rates' data-lane='" +
          esc(lane.laneKey) + "' data-shown='" + firstRates.length +
          "'>Load more rates</button>";
      }
      if (!(lane.options || []).length && !lane.rateError) {
        optsHtml = "<p style='color:var(--ic-text-muted);font-size:13px'>No rates returned.</p>";
      }

      const ratesCountLabel = ratesSectionCountLabel(
          (lane.options || []).length, selected.size);
      const ratesSectionHtml =
        "<div class='rates-section open' data-rates-section='1'>" +
          "<button type='button' class='rates-section-toggle' " +
            "aria-expanded='true' data-rates-toggle='1'>" +
            "<span class='rates-chevron'>▶</span>" +
            "<h4>Cheapest rates</h4>" +
            "<span class='rates-count'>" + esc(ratesCountLabel) + "</span>" +
          "</button>" +
          "<div class='rates-list'>" + optsHtml + "</div>" +
        "</div>";

      div.innerHTML =
        "<div class='lane-head'>" +
          "<span class='chevron'>▶</span>" +
          "<h2>" + esc(lane.label || lane.laneKey) + "</h2>" +
          "<span style='color:var(--ic-text-faint);font-size:12.5px'>" +
            (lane.options || []).length + " rates · " +
            selected.size + " selected</span>" +
        "</div>" +
        "<div class='lane-body'>" +
          renderLaneSummary(lane) +
          whyHtml +
          "<p style='margin:0 0 4px;font-size:12.5px;font-weight:600;color:var(--ic-text-muted)'>Accessorials for re-rate</p>" +
          toggles +
          ratesSectionHtml +
        "</div>";
      root.appendChild(div);
    });

    root.querySelectorAll(".lane-head").forEach((el) => {
      el.addEventListener("click", () => {
        el.parentElement.classList.toggle("open");
      });
    });

    bindRatesSectionToggles(root);
    bindRulesSectionToggles(root);
    bindAccSectionToggles(root);
    bindAccCheckboxHandlers(root);
    if (detailsEditMode) bindFreightEditors(root);

    bindRateOptionInputs(root);
    root.querySelectorAll(".btn-load-more-rates").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const laneKey = btn.getAttribute("data-lane");
        const lane = (quote.lanes || []).find((l) => l.laneKey === laneKey);
        const all = (lane && lane.options) || [];
        let shown = Number(btn.getAttribute("data-shown")) || 0;
        const next = all.slice(shown, shown + RATE_PAGE_SIZE);
        if (!next.length) {
          btn.remove();
          return;
        }
        btn.insertAdjacentHTML("beforebegin",
            next.map((opt) => rateOptionCardHtml(lane, opt)).join(""));
        bindRateOptionInputs(btn.closest(".rates-list") || root);
        shown += next.length;
        btn.setAttribute("data-shown", String(shown));
        if (shown >= all.length) btn.remove();
      });
    });

    root.querySelectorAll(".acc-search").forEach((input) => {
      input.addEventListener("focus", () => {
        const panel = input.closest(".acc-panel");
        ensureCatalogForPanel(panel, null);
      });
      input.addEventListener("input", async () => {
        const panel = input.closest(".acc-panel");
        if (!panel) return;
        if (!accessorialCatalog) {
          await ensureCatalogForPanel(panel, null);
        }
        const q = String(input.value || "").trim().toLowerCase();
        panel.querySelectorAll("label[data-search]").forEach((lab) => {
          const hay = lab.getAttribute("data-search") || "";
          lab.classList.toggle("hidden-acc", q && hay.indexOf(q) < 0);
        });
        // While searching, auto-expand sections that still have matches.
        panel.querySelectorAll(".acc-section").forEach((section) => {
          const btn = section.querySelector("[data-acc-toggle]");
          if (!q) {
            section.classList.remove("open");
            if (btn) btn.setAttribute("aria-expanded", "false");
            return;
          }
          const visible = section.querySelectorAll(
              "label[data-search]:not(.hidden-acc)");
          const open = visible.length > 0;
          section.classList.toggle("open", open);
          if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
        });
      });
    });

    root.querySelectorAll(".btn-rerun").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const laneKey = btn.dataset.lane;
        btn.disabled = true;
        btn.textContent = "Re-rating…";
        try {
          const codes = laneAccessorials[laneKey] || [];
          const res = await apiFetch("/rerunQuoteRates", {
            method: "POST",
            body: JSON.stringify({
              tenantId: TENANT_ID,
              quoteId: QUOTE_ID,
              laneKey,
              accessorials: codes.map((code) => ({code})),
              accessorialsWithData: codes.map((code) => ({code})),
              dispatcherId: DISPATCHER_ID || undefined,
              token: TOKEN || undefined,
            }),
          });
          if (!res.ok) throw new Error(res.error || "Rerun failed");
          applyQuote(res.quote);
          cacheQuote(res.quote);
          showMsg("Rates refreshed for this lane.", true);
        } catch (err) {
          showMsg(err.message || "Rerun failed", false);
          btn.disabled = false;
          btn.textContent = "Rerun quote with these accessorials";
        }
      });
    });
  }

  document.getElementById("btn-generate").addEventListener("click", async () => {
    const checked = collectSelections().some((s) => s.rateIds.length);
    if (!checked) {
      showMsg("Check at least one rate before generating the email.", false);
      return;
    }
    const missing = validateCheckedCustomerRates();
    if (missing.length) {
      showMsg(
          "Set a customer rate (> 0) for: " + missing.join(", "),
          false);
      return;
    }
    const btn = document.getElementById("btn-generate");
    btn.disabled = true;
    const prevLabel = btn.textContent;
    btn.textContent = "Saving rates…";
    try {
      const res = await apiFetch("/generateQuoteEmail", {
        method: "POST",
        body: JSON.stringify({
          tenantId: TENANT_ID,
          quoteId: QUOTE_ID,
          selections: collectSelections(),
          style: "bullet",
          dispatcherId: DISPATCHER_ID || undefined,
          token: TOKEN || undefined,
        }),
      });
      if (!res.ok) throw new Error(res.error || "Generate failed");
      if (res.quote) {
        applyQuote(res.quote);
        cacheQuote(res.quote);
      }
      document.getElementById("draft-text").value = res.text || "";
      draftReady = true;
      document.getElementById("btn-approve").disabled = false;
      document.getElementById("btn-copy").disabled = false;
      document.getElementById("status-badge").textContent = "draft_ready";
      document.getElementById("status-badge").className = "badge draft_ready";
      collapseRatesSections();
      const draftEl = document.querySelector(".draft");
      if (draftEl && draftEl.scrollIntoView) {
        draftEl.scrollIntoView({behavior: "smooth", block: "nearest"});
      }
      const failed = (res.saveResults || []).filter((r) => !r.ok);
      if (res.partial || failed.length) {
        const names = failed.map((r) => r.name || r.rateId).join(", ");
        showMsg(
            "Draft generated for " + (res.savedCount || 0) +
            " saved rate(s). Failed to save: " + names +
            ". Failed rates were left out of the email.",
            false);
      } else {
        showMsg(
            "Rates saved to Primus and email draft generated. " +
            "Review, then Approve to send.",
            true);
      }
    } catch (err) {
      showMsg(err.message || "Generate failed", false);
    } finally {
      btn.disabled = quote &&
        (quote.status === "sent" || quote.status === "dismissed");
      btn.textContent = prevLabel;
    }
  });

  document.getElementById("btn-approve").addEventListener("click", async () => {
    const missing = validateCheckedCustomerRates();
    if (missing.length) {
      showMsg(
          "Set a customer rate (> 0) for: " + missing.join(", "),
          false);
      return;
    }
    if (!confirm("Send this email to the customer via your connected Outlook?")) return;
    const btn = document.getElementById("btn-approve");
    const prevLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      const res = await apiFetch("/approveQuoteEmail", {
        method: "POST",
        body: JSON.stringify({
          tenantId: TENANT_ID,
          quoteId: QUOTE_ID,
          bodyText: document.getElementById("draft-text").value,
          dispatcherId: DISPATCHER_ID || undefined,
          token: TOKEN || undefined,
        }),
      });
      if (!res.ok) throw new Error(res.error || "Send failed");
      document.getElementById("status-badge").textContent = "sent";
      document.getElementById("status-badge").className = "badge sent";
      document.getElementById("btn-generate").disabled = true;
      document.getElementById("btn-dismiss").disabled = true;
      btn.textContent = "Sent";
      if (quote) {
        quote.status = "sent";
        cacheQuote(quote);
      }
      showMsg("Email sent to " + (res.to && res.to.join(", ")) + ".", true);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = prevLabel;
      showMsg(err.message || "Send failed", false);
    }
  });

  document.getElementById("btn-dismiss").addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const btn = document.getElementById("btn-dismiss");
    if (btn.disabled) return;
    if (btn.getAttribute("data-confirm") !== "1") {
      btn.setAttribute("data-confirm", "1");
      btn.textContent = "Confirm dismiss?";
      setTimeout(() => {
        if (btn.getAttribute("data-confirm") === "1" && !btn.disabled) {
          btn.removeAttribute("data-confirm");
          btn.textContent = "Dismiss";
        }
      }, 4000);
      return;
    }
    btn.disabled = true;
    btn.textContent = "Dismissing…";
    try {
      const res = await apiFetch(
          "/dismissQuote?" + QD.tenantQS +
          "&quoteId=" + encodeURIComponent(QUOTE_ID), {
            method: "POST",
            body: JSON.stringify({
              tenantId: TENANT_ID,
              quoteId: QUOTE_ID,
              id: QUOTE_ID,
              dispatcherId: DISPATCHER_ID || undefined,
              token: TOKEN || undefined,
            }),
          });
      if (!res.ok) throw new Error(res.error || "Dismiss failed");
      document.getElementById("status-badge").textContent = "dismissed";
      document.getElementById("status-badge").className = "badge dismissed";
      if (quote) {
        quote.status = "dismissed";
        quote.forReview = false;
        cacheQuote(quote);
      }
      applyQuoteStatusChrome(quote);
      btn.textContent = "Dismissed";
      showMsg("Quote dismissed.", true);
    } catch (err) {
      btn.disabled = false;
      btn.removeAttribute("data-confirm");
      btn.textContent = "Dismiss";
      showMsg(err.message || "Dismiss failed", false);
    }
  });

  document.getElementById("btn-for-review").addEventListener("click", async () => {
    const btn = document.getElementById("btn-for-review");
    if (btn.disabled) return;
    const currentlyOn = !!(quote && quote.forReview);
    const prevLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Updating…";
    try {
      const res = await apiFetch(
          "/markQuoteForReview?" + QD.tenantQS +
          "&quoteId=" + encodeURIComponent(QUOTE_ID), {
            method: "POST",
            body: JSON.stringify({
              tenantId: TENANT_ID,
              quoteId: QUOTE_ID,
              id: QUOTE_ID,
              forReview: !currentlyOn,
              dispatcherId: DISPATCHER_ID || undefined,
              token: TOKEN || undefined,
            }),
          });
      if (!res.ok) throw new Error(res.error || "Update failed");
      if (quote) {
        quote.forReview = !currentlyOn;
        cacheQuote(quote);
      }
      const reviewBadge = document.getElementById("review-badge");
      if (reviewBadge) {
        reviewBadge.classList.toggle("hidden", currentlyOn);
      }
      btn.textContent = currentlyOn ? "For review" : "Unmark review";
      btn.classList.toggle("is-on", !currentlyOn);
      showMsg(currentlyOn ?
        "Removed from For review. Still on your dashboard." :
        "Tagged For review. Still on your dashboard.", true);
    } catch (err) {
      btn.textContent = prevLabel;
      showMsg(err.message || "Could not update review flag", false);
    } finally {
      btn.disabled = quote && (quote.status === "dismissed" ||
        quote.status === "completed");
    }
  });

  document.getElementById("btn-complete").addEventListener("click", async () => {
    const btn = document.getElementById("btn-complete");
    if (btn.disabled) return;
    const currentlyDone = btn.getAttribute("data-completed") === "1" ||
      (quote && (quote.status === "completed" || quote.completedAt));
    const prevLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = currentlyDone ? "Restoring…" : "Completing…";
    try {
      const res = await apiFetch(
          "/completeQuote?" + QD.tenantQS +
          "&quoteId=" + encodeURIComponent(QUOTE_ID), {
            method: "POST",
            body: JSON.stringify({
              tenantId: TENANT_ID,
              quoteId: QUOTE_ID,
              id: QUOTE_ID,
              completed: !currentlyDone,
              dispatcherId: DISPATCHER_ID || undefined,
              token: TOKEN || undefined,
            }),
          });
      if (!res.ok) throw new Error(res.error || "Update failed");
      if (quote) {
        quote.status = res.status ||
          (currentlyDone ? "draft_ready" : "completed");
        quote.completedAt = currentlyDone ? null : true;
        if (!currentlyDone) quote.forReview = false;
        cacheQuote(quote);
      }
      applyQuoteStatusChrome(quote);
      showMsg(currentlyDone ?
        "Quote restored to your active list." :
        "Quote marked completed.", true);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = prevLabel;
      showMsg(err.message || "Update failed", false);
    }
  });

  document.getElementById("btn-copy").addEventListener("click", () => {
    navigator.clipboard.writeText(document.getElementById("draft-text").value);
    showMsg("Draft copied.", true);
  });

  document.getElementById("draft-text").addEventListener("input", () => {
    userDirty = true;
  });

  document.getElementById("home-link").href = QD.pageUrl("index.html");

  function num(n) {
    const v = Number(n);
    return isFinite(v) ? v.toFixed(2) : "___";
  }

  /** Strip HTML / Word junk from carrier notes before UI display. */
  function cleanNote(input) {
    let text = String(input == null ? "" : input);
    if (!text.trim()) return "";
    text = text
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<\/(?:p|div|tr|li)>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&#160;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, "\"")
        .replace(/\bMso[A-Za-z0-9]+\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!text || /^[\s.,;:/\-_|]+$/.test(text)) return "";
    return text;
  }

  function showApp(show) {
    document.getElementById("login-screen").classList.toggle("hidden", show);
    document.getElementById("app").classList.toggle("hidden", !show);
    if (show) showThinking(true);
  }

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    document.getElementById("login-error").textContent = "";
    document.getElementById("login-error").classList.add("hidden");
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
      const errEl = document.getElementById("login-error");
      errEl.textContent = err.message;
      errEl.classList.remove("hidden");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = prevLabel;
      }
    }
  });

  document.getElementById("btn-forgot").addEventListener("click", async () => {
    document.getElementById("login-error").textContent = "";
    document.getElementById("login-error").classList.add("hidden");
    document.getElementById("login-success").classList.add("hidden");
    const email = document.getElementById("login-email").value;
    if (!email) {
      const errEl = document.getElementById("login-error");
      errEl.textContent = "Enter your email above, then click Forgot password.";
      errEl.classList.remove("hidden");
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
      const errEl = document.getElementById("login-error");
      errEl.textContent = err.message || "Could not send reset email";
      errEl.classList.remove("hidden");
    }
  });

  if (!QUOTE_ID) {
    showThinking(false);
    document.getElementById("meta").textContent = "Missing quote id";
  } else if (hasLegacyToken) {
    showApp(true);
    load();
  } else {
    // Keep thinking motion alive while Firebase auth resolves.
    showThinking(true);
    QuoteAuth.init().then(() => {
      QuoteAuth.onAuth((user) => {
        if (!user) {
          thinking.stop();
          showApp(false);
          return;
        }
        showApp(true);
        load();
      });
    }).catch((e) => {
      thinking.stop();
      showApp(false);
      const errEl = document.getElementById("login-error");
      errEl.textContent = e.message;
      errEl.classList.remove("hidden");
    });
  }
})();
