# Dashboard — Quote Rules button

Add this to the Jerry dashboard on **advancedautomations.net** (separate from the invoice support chatbot).

## 1. Fetch admin URL on load

```javascript
const API = "https://us-central1-tai-invoice-automation.cloudfunctions.net";
const tenantId = "default"; // or from existing dashboard tenant selector

fetch(`${API}/getQuoteAdminConfig?tenantId=${tenantId}`)
  .then(r => r.json())
  .then(cfg => {
    if (cfg.ok) window.__quoteAdminUrl = cfg.quoteAdminUrl;
  });
```

## 2. Add button (opens new tab — separate from support chat)

```html
<button type="button" id="open-quote-rules" class="dashboard-btn">
  Quote rules
</button>
```

```javascript
document.getElementById("open-quote-rules").addEventListener("click", () => {
  const url = window.__quoteAdminUrl ||
    `${API}/quoteAdminPage?tenantId=${tenantId}`;
  window.open(url, "_blank", "noopener,noreferrer");
});
```

## 3. Cloud Functions (deployed)

| Function | Purpose |
|----------|---------|
| `quoteAdminPage` | Rules admin UI + AI chat (standalone) |
| `quoteRulesChat` | Chatbot API (not `dashboardSupportChat`) |
| `getQuoteRules` | Rules table data |
| `applyQuoteRule` | Confirm save from chat |
| `testQuoteRules` | Test address panel |
| `quoteDispatcherPage` | Dispatcher carrier picker |
| `getQuoteDispatcherData` | Quote JSON for dispatcher page |
| `saveQuoteSelection` | Save selected rate + Primus `/rate/save` |
| `processQuoteWorkflow` | Manual quote test POST |

## 4. Quote flow

Quote RFQs to the connected inbox are classified as `quote_request` → `processQuoteEmail` → assigned to a dispatcher → appears on their **dashboard inbox** (no dispatcher email).

## 5. Env vars (optional)

```
QUOTE_MARGIN_PERCENT=
QUOTE_MARGIN_MIN_DOLLARS=10
QUOTE_DEFAULT_SHIPPING_LOCATION_ID=
QUOTE_RULES_CHAT_OPENAI_API_KEY=   # falls back to SUPPORT_CHAT_OPENAI_API_KEY
QUOTE_FIREBASE_WEB_API_KEY=        # email/password sign-in on dashboard
QUOTE_AUTH_ALLOWED_DOMAINS=innovativecarriers.com
```
