# Going live — dingodirt.com

Each step below needs your credentials or your accounts, so these steps are
yours to do. The full sequence takes ~45–60 minutes. Local dev works at all
times with the subset that you have configured.

> Updated 2026-08-06 for the monorepo. The site now lives at `apps/site` in
> [grantpaisley/dingodirt](https://github.com/grantpaisley/dingodirt). That
> repo is already public and MIT-licensed. Because of this, the old "push
> the repo" and "open-source flip" steps are gone, and the licence is MIT,
> not AGPL. **The one new item is Vercel's Root Directory (step 5).**

## Already done

- The repo is public and MIT (`grantpaisley/dingodirt`)
- The secrets are scrubbed from the history; the MapTiler key is rotated and
  domain-restricted
- Nav, Studio, and Plan deploy to GitHub Pages —
  `grantpaisley.github.io/dingodirt/{nav,studio,plan}/`
- `grantpaisley.github.io/DingoNav/` still serves, mirrored from this repo

Only the **site** remains, because Pages cannot host it. The site needs a
database and server-side auth.

## 1. Neon Postgres (~5 min)

1. https://neon.tech → make a new project `dingodirt`, region
   Sydney/ap-southeast-2.
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

1. https://console.cloud.google.com/apis/credentials → make a new project
   `dingodirt`.
2. Set the OAuth consent screen: External, app name `dingodirt`, your email.
   Set the scopes `email`, `profile`, `openid`. Publish the app (or add
   testers).
3. Credentials → Create OAuth client ID → Web application. Add these
   authorized redirect URIs:
   - `https://dingodirt.com/api/auth/callback/google`
   - `http://localhost:3000/api/auth/callback/google`
4. Copy the values into `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`.

## 3. Microsoft OAuth (~10 min)

1. https://entra.microsoft.com → App registrations → New registration.
   Account types: **personal Microsoft accounts + any org**.
   Redirect URI (Web): `https://dingodirt.com/api/auth/callback/microsoft-entra-id`
   plus the localhost twin.
2. Certificates & secrets → make a new client secret.
3. Set `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`,
   `AUTH_MICROSOFT_ENTRA_ID_ISSUER=https://login.microsoftonline.com/common/v2.0`.

## 4. Cloudflare Turnstile (~3 min) — protects the Report form

1. Cloudflare dashboard → Turnstile → Add site → domain `dingodirt.com`,
   widget mode Managed.
2. Copy the keys into `NEXT_PUBLIC_TURNSTILE_SITE_KEY` /
   `TURNSTILE_SECRET_KEY`.

## 5. Vercel (~10 min) — **read the Root Directory note**

1. https://vercel.com → Add New Project → import
   **`grantpaisley/dingodirt`**.
2. **Set Root Directory to `apps/site`.** This step is different from the
   pre-monorepo instructions. Without this step, Vercel builds the repo
   root. It then finds no Next.js app, and the build fails. Leave "Include
   files outside the root directory" ON. The build does not need `core/`,
   but the OFF setting has caused problems with monorepo lockfiles.
3. Storage → Create → **Blob** → connect it to the project. This injects
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

   `COOKIE_DOMAIN` is the value that lets a later `plan.` subdomain share a
   session with `dingodirt.com`. Do not set it locally.
5. Analytics tab → Enable.
6. Redeploy so the env vars apply.

Vercel builds on each push to `main`. This includes pushes that touch only
`apps/nav` or `core/rust`. If this becomes noisy, set Settings → Git →
Ignored Build Step to:
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
set the custom domain + Enforce HTTPS. The domain stays on the DingoNav
repo because the mirror publishes to that repo, and the existing share
links point at it.

`studio.` and `plan.` can point at `grantpaisley.github.io` too. But they
are served from the **monorepo's** Pages site under `/dingodirt/studio/`
and `/dingodirt/plan/`. A custom domain serves the whole Pages site from
its root. Because of this, to point a subdomain at them, you need a
separate repo per app or a redirect. Make this decision deliberately — do
not assume that it just works.

## 7. Smoke test (5 min)

1. dingodirt.com → the landing page renders, and Analytics starts to count.
2. Sign in with Google → the Admin link appears (you are in `allowlist`).
3. `/publish` → drop a `.dingonav` file (export one from Plan: Export →
   download) → you land on its pack page.
4. Dashboard → **Link only** → Copy link → open the link in a private
   window → the download works, and the count goes up.
5. Set **Public** with a second, non-admin account → "pending review" shows
   → approve it in `/admin` → the pack appears in `/rides`.
6. Signed out, on a public pack page → **Report a problem** → the report
   shows in `/admin`.
7. Set the pack back to **Private** → the private-window link says "no
   longer shared".

## 8. Loose ends in code (when you have real values)

- `app/page.tsx` + `app/get-involved/page.tsx`: replace the placeholder
  Facebook group / GitHub org / Sponsors URLs. The GitHub link must now be
  `github.com/grantpaisley/dingodirt`.
- The pack-page buttons point at `nav.dingodirt.com` /
  `studio.dingodirt.com`. They become live as those subdomains do (see the
  caveat in step 6).
- Set up GitHub Sponsors (or Ko-fi) and update the URL.
- Add a `/self-host` page — the `docker-compose` file lives at `server/`
  now.

## Known deferred items

- The shared PMTiles archive + pack format v2 + the Nav corridor-tile
  fetcher, then the `/make` GPX→pack page.
- The folder management UI (the schema + the display exist; the create/move
  UI is pending).
- A Blob purge job for packs retracted more than 30 days ago.
- A gallery search box.
