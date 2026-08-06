# Going live — dingodirt.com

Everything below needs your credentials/accounts, so it's yours to do.
~45–60 minutes end to end. Local dev works throughout with whatever subset
you've configured.

> Updated 2026-08-06 for the monorepo. The site now lives at `apps/site` in
> [grantpaisley/dingodirt](https://github.com/grantpaisley/dingodirt), which is
> already public and MIT-licensed — so the old "push the repo" and
> "open-source flip" steps are gone, and the licence is MIT rather than AGPL.
> **The one genuinely new thing is Vercel's Root Directory (step 5).**

## Already done

- Repo is public and MIT (`grantpaisley/dingodirt`)
- Secrets scrubbed from history; the MapTiler key rotated and domain-restricted
- Nav, Studio and Plan deploy to GitHub Pages —
  `grantpaisley.github.io/dingodirt/{nav,studio,plan}/`
- `grantpaisley.github.io/DingoNav/` still serves, mirrored from this repo

Only the **site** is left, because Pages can't host it: it needs a database
and server-side auth.

## 1. Neon Postgres (~5 min)

1. https://neon.tech → new project `dingodirt`, region Sydney/ap-southeast-2.
2. Copy the connection string into `apps/site/.env.local` as `DATABASE_URL`.
3. Create the tables:
   ```bash
   cd ~/Desktop/Projects/dingodirt/apps/site && npx drizzle-kit push
   ```
4. Make yourself admin (Neon SQL editor):
   ```sql
   INSERT INTO allowlist (email, role) VALUES ('grant@angrykoala.com.au', 'admin');
   ```

## 2. Google OAuth (~10 min)

1. https://console.cloud.google.com/apis/credentials → new project `dingodirt`.
2. OAuth consent screen: External, app name `dingodirt`, your email; scopes
   `email`, `profile`, `openid`. Publish the app (or add testers).
3. Credentials → Create OAuth client ID → Web application. Authorized redirect
   URIs:
   - `https://dingodirt.com/api/auth/callback/google`
   - `http://localhost:3000/api/auth/callback/google`
4. Copy → `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`.

## 3. Microsoft OAuth (~10 min)

1. https://entra.microsoft.com → App registrations → New registration.
   Account types: **personal Microsoft accounts + any org**.
   Redirect URI (Web): `https://dingodirt.com/api/auth/callback/microsoft-entra-id`
   plus the localhost twin.
2. Certificates & secrets → new client secret.
3. `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`,
   `AUTH_MICROSOFT_ENTRA_ID_ISSUER=https://login.microsoftonline.com/common/v2.0`.

## 4. Cloudflare Turnstile (~3 min) — protects the Report form

1. Cloudflare dashboard → Turnstile → Add site → domain `dingodirt.com`,
   widget mode Managed.
2. Copy → `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`.

## 5. Vercel (~10 min) — **read the Root Directory note**

1. https://vercel.com → Add New Project → import **`grantpaisley/dingodirt`**.
2. **Set Root Directory to `apps/site`.** This is the step that differs from
   the pre-monorepo instructions. Without it Vercel builds the repo root, finds
   no Next.js app, and fails. Leave "Include files outside the root directory"
   ON — the build doesn't need `core/`, but turning it off has bitten people
   with monorepo lockfiles.
3. Storage → Create → **Blob** → connect to the project. That injects
   `BLOB_READ_WRITE_TOKEN` automatically.
4. Settings → Environment Variables:

   | Variable | Where from |
   |---|---|
   | `DATABASE_URL` | Neon, step 1 |
   | `AUTH_SECRET` | `openssl rand -base64 32` |
   | `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | step 2 |
   | `AUTH_MICROSOFT_ENTRA_ID_ID` / `_SECRET` / `_ISSUER` | step 3 |
   | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | step 4 |
   | `COOKIE_DOMAIN` | `.dingodirt.com` |
   | `BLOB_READ_WRITE_TOKEN` | injected by step 3 |

   `COOKIE_DOMAIN` is what lets a session on `dingodirt.com` be shared with
   `plan.` later — leave it unset locally.
5. Analytics tab → Enable.
6. Redeploy so the env vars take.

Vercel will build on every push to `main`, including pushes that only touch
`apps/nav` or `core/rust`. If that gets noisy, set Settings → Git → Ignored
Build Step to:
```bash
git diff --quiet HEAD^ HEAD -- apps/site/ || exit 1
```

## 6. DNS (~5 min + propagation)

At your DNS host for `dingodirt.com`:

| Record | Name | Value |
|---|---|---|
| A / CNAME per Vercel's instructions | `@` | Vercel gives the exact value |
| CNAME | `nav` | `grantpaisley.github.io` |

Then Vercel → Settings → Domains → add `dingodirt.com`.

For `nav.dingodirt.com`: GitHub → **DingoNav** repo → Settings → Pages →
custom domain + Enforce HTTPS. It stays on the DingoNav repo because that's
what the mirror publishes to and what existing share links already point at.

`studio.` and `plan.` can point at `grantpaisley.github.io` too, but they are
served from the **monorepo's** Pages site under `/dingodirt/studio/` and
`/dingodirt/plan/` — a custom domain serves the whole Pages site from its root,
so pointing a subdomain at them needs either a separate repo per app or a
redirect. Worth deciding deliberately rather than assuming it just works.

## 7. Smoke test (5 min)

1. dingodirt.com → landing renders, Analytics starts counting.
2. Sign in with Google → Admin link appears (you're in `allowlist`).
3. `/publish` → drop a `.dingonav` (export one from Plan: Export → download)
   → lands on its pack page.
4. Dashboard → **Link only** → Copy link → open in a private window →
   download works and the count ticks up.
5. **Public** with a second, non-admin account → "pending review" → approve in
   `/admin` → appears in `/rides`.
6. Signed out, on a public pack page → **Report a problem** → shows in `/admin`.
7. Back to **Private** → the private-window link says "no longer shared".

## 8. Loose ends in code (when you have real values)

- `app/page.tsx` + `app/get-involved/page.tsx`: replace placeholder Facebook
  group / GitHub org / Sponsors URLs. The GitHub link should now be
  `github.com/grantpaisley/dingodirt`.
- Pack-page buttons point at `nav.dingodirt.com` / `studio.dingodirt.com`;
  they come alive as those subdomains do (see the caveat in step 6).
- Set up GitHub Sponsors (or Ko-fi) and update the URL.
- Add a `/self-host` page — `docker-compose` lives at `server/` now.

## Known deferred items

- Shared PMTiles archive + pack format v2 + Nav corridor-tile fetcher, then
  the `/make` GPX→pack page.
- Folder management UI (schema + display exist; create/move UI pending).
- Blob purge job for packs retracted >30 days ago.
- Gallery search box.
