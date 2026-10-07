# Innovative Jerry dashboard (Netlify)

Static Jerry / invoice-ops dashboard for Innovative Carriers.

## Deploy

This branch (`dashboard`) is the **only** source for the dedicated Netlify site.

- **Site:** https://innovative-jerry.netlify.app  
  (Admin: https://app.netlify.com/projects/innovative-jerry)
- **GitHub repo:** `moshehillel/Innovative`
- **Production branch:** `dashboard` (not `main`)
- **Publish directory:** `.` (site root)

Pushes to `dashboard` auto-deploy. Backend Cloud Functions stay on `main`.

## Netlify env vars

| Variable | Purpose |
| --- | --- |
| `DASHBOARD_PASSWORD` | Basic-auth password (username ignored) |

Set/rotate under Site configuration → Environment variables.

## Backend CORS

Cloud Functions allowlist includes this origin. Optional env
`DASHBOARD_ORIGIN` may be a single origin, a comma-separated list, or `*`:

```text
https://www.advancedautomations.net,https://innovative-jerry.netlify.app
```

## Ops console tabs

| Tab | Purpose |
| --- | --- |
| **Tasks awaiting** | Open tasks + A–E additional-charge decisions |
| **Recent invoices** | Invoice table with pagination |
| **Notifications** | Ops emails / unhandled emails — dismiss, flag (emails Moshe), reply, delete |

When Cloud Functions env `DASHBOARD_OPS_PRIMARY=true`, Jerry parks unhandled
“no rules” emails and ops alerts on the Notifications tab instead of emailing
Lisa/Sarah (customer invoices and system-error emails still send).

## Local preview

Serve the folder with any static server. Edge Basic-auth only runs on Netlify.
Open via a local static server so `fetch` to Cloud Functions works.
