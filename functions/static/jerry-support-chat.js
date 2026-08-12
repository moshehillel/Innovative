/* eslint-env browser */
/* eslint-disable require-jsdoc, space-before-function-paren, max-len */
/**
 * Jerry support chat — floating round logo toggle + dashboardSupportChat API.
 *
 * Embed:
 * <script src="https://…/jerrySupportChatWidget?tenantId=default" defer></script>
 */
(function () {
  "use strict";

  if (window.__jerrySupportChatLoaded) return;
  window.__jerrySupportChatLoaded = true;

  const script = document.currentScript;
  const scriptUrl = script && script.src ?
    new URL(script.src, window.location.href) : null;
  const apiBase = (script && script.getAttribute("data-api")) ||
    (scriptUrl ? scriptUrl.origin : "") ||
    "https://us-central1-tai-invoice-automation.cloudfunctions.net";
  const tenantId = (script && script.getAttribute("data-tenant-id")) ||
    (scriptUrl && scriptUrl.searchParams.get("tenantId")) || "default";
  const clientName = (script && script.getAttribute("data-client-name")) ||
    "Innovative Carriers";
  const logoUrl = apiBase + "/jerrySupportChatLogo";

  const CSS = `
#jerry-chat-root {
  --jerry-navy: #0f3460;
  --jerry-orange: #f97316;
  --jerry-shadow: 0 10px 40px rgba(15, 52, 96, 0.22);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  position: fixed;
  right: 22px;
  bottom: 22px;
  z-index: 99999;
}
#jerry-chat-root * { box-sizing: border-box; }
.jerry-chat-panel {
  position: absolute;
  right: 0;
  bottom: 78px;
  width: min(380px, calc(100vw - 32px));
  height: min(520px, calc(100vh - 120px));
  background: #fff;
  border-radius: 16px;
  box-shadow: var(--jerry-shadow);
  border: 1px solid #e5e7eb;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  opacity: 0;
  transform: translateY(12px) scale(0.96);
  pointer-events: none;
  transition: opacity 0.22s ease, transform 0.22s ease;
}
.jerry-chat-panel.open {
  opacity: 1;
  transform: translateY(0) scale(1);
  pointer-events: auto;
}
.jerry-chat-header {
  background: linear-gradient(135deg, #174a94 0%, var(--jerry-navy) 100%);
  color: #fff;
  padding: 14px 16px;
}
.jerry-chat-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
}
.jerry-chat-header p {
  margin: 4px 0 0;
  font-size: 12px;
  opacity: 0.88;
}
.jerry-chat-log {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
  background: #f8fafc;
}
.jerry-chat-msg {
  max-width: 88%;
  margin-bottom: 10px;
  padding: 10px 12px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}
.jerry-chat-msg.user {
  margin-left: auto;
  background: #dbeafe;
  color: #1e3a5f;
  border-bottom-right-radius: 4px;
}
.jerry-chat-msg.bot {
  background: #fff;
  border: 1px solid #e5e7eb;
  color: #1f2937;
  border-bottom-left-radius: 4px;
}
.jerry-chat-msg.typing {
  color: #64748b;
  font-style: italic;
}
.jerry-chat-input {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid #e5e7eb;
  background: #fff;
}
.jerry-chat-input textarea {
  flex: 1;
  resize: none;
  border: 1px solid #d1d5db;
  border-radius: 10px;
  padding: 10px 12px;
  font: inherit;
  font-size: 13px;
  min-height: 42px;
  max-height: 100px;
}
.jerry-chat-input textarea:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
}
.jerry-chat-input button {
  border: 0;
  border-radius: 10px;
  padding: 0 16px;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
  background: var(--jerry-orange);
  color: #fff;
}
.jerry-chat-input button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.jerry-chat-fab {
  position: relative;
  width: 64px;
  height: 64px;
  border: 0;
  border-radius: 50%;
  padding: 0;
  cursor: pointer;
  background: #fff;
  box-shadow: var(--jerry-shadow);
  border: 2px solid #e5e7eb;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.jerry-chat-fab img {
  width: 46px;
  height: 46px;
  object-fit: contain;
  border-radius: 50%;
  pointer-events: none;
}
.jerry-chat-fab:hover,
.jerry-chat-fab:focus-visible {
  transform: scale(1.1);
  box-shadow: 0 14px 36px rgba(15, 52, 96, 0.28);
  outline: none;
}
.jerry-chat-fab.open {
  transform: scale(1.05);
  border-color: var(--jerry-orange);
}
.jerry-chat-tooltip {
  position: absolute;
  right: 74px;
  bottom: 50%;
  transform: translateY(50%) translateX(6px);
  background: var(--jerry-navy);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.35;
  padding: 8px 12px;
  border-radius: 10px;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s ease, transform 0.18s ease;
  box-shadow: 0 6px 18px rgba(15, 52, 96, 0.25);
}
.jerry-chat-tooltip::after {
  content: "";
  position: absolute;
  right: -6px;
  top: 50%;
  transform: translateY(-50%);
  border: 6px solid transparent;
  border-left-color: var(--jerry-navy);
}
.jerry-chat-fab:hover .jerry-chat-tooltip,
.jerry-chat-fab:focus-visible .jerry-chat-tooltip {
  opacity: 1;
  transform: translateY(50%) translateX(0);
}
.jerry-chat-fab.open .jerry-chat-tooltip {
  opacity: 0;
}
@media (max-width: 480px) {
  #jerry-chat-root { right: 14px; bottom: 14px; }
  .jerry-chat-tooltip { display: none; }
}
`;

  const styleEl = document.createElement("style");
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  const root = document.createElement("div");
  root.id = "jerry-chat-root";
  root.innerHTML =
    "<div class=\"jerry-chat-panel\" id=\"jerry-chat-panel\" " +
    "role=\"dialog\" aria-label=\"Jerry support chat\" aria-hidden=\"true\">" +
    "<div class=\"jerry-chat-header\">" +
    "<h3>Jerry</h3>" +
    "<p>Invoice automation support</p>" +
    "</div>" +
    "<div class=\"jerry-chat-log\" id=\"jerry-chat-log\"></div>" +
    "<div class=\"jerry-chat-input\">" +
    "<textarea id=\"jerry-chat-text\" rows=\"1\" " +
    "placeholder=\"Ask about a load, invoice, or the dashboard…\"></textarea>" +
    "<button type=\"button\" id=\"jerry-chat-send\">Send</button>" +
    "</div>" +
    "</div>" +
    "<button type=\"button\" class=\"jerry-chat-fab\" id=\"jerry-chat-fab\" " +
    "aria-label=\"Chat with Jerry\" aria-expanded=\"false\">" +
    "<img src=\"" + logoUrl + "\" alt=\"Jerry\" />" +
    "<span class=\"jerry-chat-tooltip\">Hi, I am Jerry — how can I help?</span>" +
    "</button>";
  document.body.appendChild(root);

  const panel = document.getElementById("jerry-chat-panel");
  const fab = document.getElementById("jerry-chat-fab");
  const logEl = document.getElementById("jerry-chat-log");
  const inputEl = document.getElementById("jerry-chat-text");
  const sendBtn = document.getElementById("jerry-chat-send");

  let open = false;
  let busy = false;
  let messages = [];
  let greeted = false;

  function escapeHtml(text) {
    return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
  }

  function renderMessages() {
    logEl.innerHTML = messages.map((m) => {
      const cls = m.role === "user" ? "user" : "bot";
      return "<div class=\"jerry-chat-msg " + cls + "\">" +
        escapeHtml(m.content) + "</div>";
    }).join("");
    logEl.scrollTop = logEl.scrollHeight;
  }

  function appendMessage(role, content) {
    messages.push({role: role, content: content});
    renderMessages();
  }

  function setOpen(next) {
    open = next;
    panel.classList.toggle("open", open);
    panel.setAttribute("aria-hidden", open ? "false" : "true");
    fab.classList.toggle("open", open);
    fab.setAttribute("aria-expanded", open ? "true" : "false");
    fab.setAttribute(
        "aria-label",
        open ? "Close Jerry chat" : "Chat with Jerry",
    );
    if (open) {
      if (!greeted) {
        greeted = true;
        appendMessage(
            "assistant",
            "Hi! I am Jerry. Ask me about a load number, invoice status, " +
            "or anything on the dashboard.",
        );
      }
      inputEl.focus();
    }
  }

  function dashboardContext() {
    const ctx = {tms: "primus"};
    if (window.__jerryDashboardContext &&
        typeof window.__jerryDashboardContext === "object") {
      Object.assign(ctx, window.__jerryDashboardContext);
    }
    return ctx;
  }

  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || busy) return;
    inputEl.value = "";
    appendMessage("user", text);
    busy = true;
    sendBtn.disabled = true;
    appendMessage("assistant", "…");
    renderMessages();
    logEl.lastElementChild.classList.add("typing");

    try {
      const res = await fetch(apiBase + "/dashboardSupportChat", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          tenantId: tenantId,
          clientName: clientName,
          dashboardContext: dashboardContext(),
          messages: messages.filter((m) => {
            return m.content !== "…";
          }),
        }),
      });
      messages = messages.filter((m) => {
        return m.content !== "…";
      });
      const data = await res.json().catch(() => {
        return {};
      });
      if (!res.ok || !data.ok) {
        throw new Error(
            (data && data.error) ||
            "Sorry, I couldn't reach the support assistant.",
        );
      }
      appendMessage("assistant", data.reply || "How can I help?");
    } catch (err) {
      messages = messages.filter((m) => {
        return m.content !== "…";
      });
      appendMessage(
          "assistant",
          (err && err.message) ||
          "Sorry, I couldn't reach the support assistant. " +
          "Please try again in a moment.",
      );
    } finally {
      busy = false;
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  fab.addEventListener("click", () => {
    setOpen(!open);
  });

  sendBtn.addEventListener("click", sendMessage);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  window.JerrySupportChat = {
    open: function () {
      setOpen(true);
    },
    close: function () {
      setOpen(false);
    },
    toggle: function () {
      setOpen(!open);
    },
  };
})();
