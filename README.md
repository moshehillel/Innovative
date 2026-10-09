# Innovative Carriers — Quote Dashboard (Netlify)

Static dashboard for the quote automation ("quoting") system. This branch
(`quote-dashboard`) is an **orphan branch** — it contains only this static
site, not the main repo code — and is auto-deployed by Netlify on every push.

## Pages

| Page | Replaces (Cloud Function) | What it does |
|---|---|---|
| `index.html` + `app.js` | `quoteDispatcherHomePage` | Dispatcher inbox: stats, Pending / Sent / For review / Completed tabs, report pull, bulk rate shop, Outlook connect |
| `quote.html` + `quote.js` | `quoteDispatcherPage` | Quote review: lanes, rates, customer prices, accessorials re-rate, details edit, draft generate / approve / dismiss / complete |
| `admin.html` + `admin.js` | `quoteAdminPage` | Quote rules: rules list, AI chat with confirm flow, address tester |
| `shared.js` | `quoteAuthClient` + new | Firebase auth, API fetch with ID-token headers, caches, warm-up pings |
| `config.js` | — | API base URL + tenant (edit here if the backend moves) |

The backend stays 100% in Cloud Functions (`tai-invoice-automation`,
us-central1). This site only replaces the HTML-serving functions; all data
endpoints (`getQuoteDispatcherInbox`, `getQuoteDispatcherData`, etc.) are
unchanged and already send CORS headers (`applyDashboardCors`).

## Deploy

- Netlify watches the `quote-dashboard` branch of the GitHub repo
  (`moshehillel/Innovative`), publish directory `.` — same pattern as the
  Jerry accounting dashboard (`dashboard` branch → innovative-jerry).
- To ship a change: commit on this branch and `git push origin quote-dashboard`.
  Netlify builds in ~20s (no build step, just a publish).
- Bump the `?v=` query on `style.css` / `*.js` tags in the HTML files when
  changing those files, so browsers pick up the new versions despite caching.

Work on this branch via the git worktree at
`..\innovative-quote-dash` (main repo working tree stays on its own branch).

## Why it's faster than the old function-served pages

1. **CDN HTML/CSS/JS** — pages render instantly instead of waiting for a
   1 GiB Cloud Function cold start just to serve HTML.
2. **Cached auth config** (`localStorage`, 7-day TTL, background refresh) —
   the login screen and Firebase init never wait on `getQuoteAuthConfig`.
3. **Stale-while-revalidate inbox** (`sessionStorage`, 10-min TTL) — tabs and
   stats paint from cache instantly, then refresh quietly.
4. **Hover prefetch** — pointing at a quote card prefetches
   `getQuoteDispatcherData` into `sessionStorage` (`qd:quote:<id>`), so the
   review page paints with data already in hand.
5. **Accessorial catalog cache** (`localStorage`, 12-hour TTL).
6. **Warm-up pings** — on page load (throttled to every 4 min per session)
   the client fires `?warm=1` GETs at the hot endpoints so the Cloud Run
   containers are booted before the user clicks Save / Generate / Approve.
7. **Cloud Scheduler warm jobs** (optional, see
   `functions/scripts/setup-quote-warm-scheduler.ps1` in the main branch) —
   pings the same endpoints every 5 minutes, ~$0.10/job/month.

## Auth

- Normal flow: Firebase email/password (same roster as before; config comes
  from `getQuoteAuthConfig`).
- Legacy flow: `quote.html?id=…&dispatcherId=…&token=…` bookmark links keep
  working — the token is appended to API calls exactly like the old page.

## Tenant

Default tenant is `default` (set in `config.js`). Any page accepts a
`?tenantId=…` override and propagates it through internal links.
