# Innovative Jerry dashboard (Netlify)

Static Jerry / invoice-ops dashboard for Innovative Carriers.

## Deploy

This branch (`dashboard`) is the **only** source for the dedicated Netlify site.

- **GitHub repo:** `moshehillel/Innovative`
- **Production branch:** `dashboard` (not `main`)
- **Publish directory:** `.` (site root)

Pushes to `dashboard` auto-deploy. Backend Cloud Functions stay on `main`.

## Netlify env vars

| Variable | Purpose |
| --- | --- |
| `DASHBOARD_PASSWORD` | Basic-auth password (username ignored) |

## Backend CORS

Cloud Functions env `DASHBOARD_ORIGIN` should include this site’s origin
(comma-separated if AA should keep working too), e.g.:

```text
https://www.advancedautomations.net,https://innovative.netlify.app
```

## Local preview

Serve the folder with any static server after setting a throwaway password is
not required locally (edge auth only runs on Netlify). Open `index.html` via
a local static server so `fetch` to Cloud Functions works.
