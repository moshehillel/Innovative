# Quote dispatcher login — Firebase email / password

Dispatchers sign in with **email and password** (Firebase Authentication).

**No self-registration** — you add users in Firebase Console. Dispatchers can only **reset password via email**.

## URLs

| Page | URL |
|------|-----|
| **Personal dashboard** | `quoteDispatcherHomePage?tenantId=default` |
| **Single quote** | `quoteDispatcherPage?id=<quoteId>&tenantId=default` |

Both show **Sign in** only (no register). **Forgot password?** sends a Firebase reset email.

## One-time Firebase setup (admin)

1. [Firebase Console](https://console.firebase.google.com) → project **tai-invoice-automation**
2. **Authentication** → **Sign-in method** → enable **Email/Password** (do not add a public sign-up page)
3. **Authentication** → **Users** → **Add user** for each dispatcher (work email + temporary password)
4. Optional: **Authentication** → **Templates** → customize **Password reset** email
5. Set env `QUOTE_FIREBASE_WEB_API_KEY` (Firebase web API key from Project settings)

## Environment variables

```
QUOTE_FIREBASE_WEB_API_KEY=     # required — Firebase web API key
QUOTE_FIREBASE_AUTH_DOMAIN=       # optional, default tai-invoice-automation.firebaseapp.com
QUOTE_AUTH_ALLOWED_DOMAINS=innovativecarriers.com
```

## Who can sign in

1. Firebase Auth user **created by admin** (no register on the dashboard)
2. Email domain must match `QUOTE_AUTH_ALLOWED_DOMAINS` (default `@innovativecarriers.com`)
3. Email must exist in Firestore **`quoteDispatchers`** roster (Leo, Barry, Izzy, Leah, Diego, QD seeded by default)

The Firebase user email must match the dispatcher roster email.

## Password reset

Dispatcher enters email on login screen → **Forgot password?** → Firebase emails a reset link.

Only allowed company domains can request a reset (same as sign-in).

## Dispatcher workflow

1. Bookmark: `quoteDispatcherHomePage?tenantId=default`
2. **Sign in** with email + password (or reset password first)
3. See assigned quotes on the dashboard → **Open** → pick carriers → copy draft → send customer reply from Outlook

No email is sent to dispatchers for new quotes — they appear in the dashboard inbox (round-robin assignment).

## Add a new dispatcher

1. Firebase Console → **Authentication** → **Users** → **Add user**
2. Firestore `{tenant}_quoteDispatchers`:

```json
{
  "id": "hanna",
  "name": "Hanna",
  "email": "hannahs@innovativecarriers.com",
  "active": true
}
```

Only `@innovativecarriers.com` emails are allowed unless you extend `QUOTE_AUTH_ALLOWED_DOMAINS`.

## Address classification (optional)

Quote automation classifies delivery site type for accessorials:

1. **Name heuristics first** (e.g. nursing/rehab in the consignee name) — no AI call.
2. **Google Places** strong facility types only — never bare `premise`/`street_address` → residential.
3. **OpenAI Responses + `web_search`** for ambiguous / address-only cases (ChatGPT-like lookup). Plain JSON completions without tools cannot identify facilities from street+city alone.
4. No-tools OpenAI only for leftover residential-vs-commercial judgment; otherwise `other` / no RSD.

| Variable | Purpose |
|----------|---------|
| `GOOGLE_PLACES_API_KEY` or `GOOGLE_MAPS_API_KEY` | Strong facility types / place name (not bare geocode → RSD) |
| `SUPPORT_CHAT_OPENAI_API_KEY` / `OPENAI_API_KEY` | Web-search + optional no-tools classify |
| `QUOTE_ADDRESS_WEB_MODEL` | Model for Responses + web_search (default: Luna) |
| `QUOTE_ADDRESS_AI_MODEL` | Override no-tools classify model |

Classifications are cached in Firestore `{tenant}_quoteAddressClassifications` by normalized street + city + state + zip so repeat deliveries skip external lookup.
