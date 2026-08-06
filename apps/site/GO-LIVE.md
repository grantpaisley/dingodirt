# Going live — dingodirt.com

Everything below needs your credentials/accounts, so it's yours to do.
Order matters roughly as listed; ~45–60 minutes end to end. Local dev
works throughout with whatever subset you've configured.

## 1. Push the repo to GitHub

```bash
cd ~/Desktop/Projects/DingoDirt
gh repo create DingoDirt --private --source=. --push
```

## 2. Neon Postgres (~5 min)

1. https://neon.tech → new project (call it `dingodirt`, pick Sydney/ap-southeast-2).
2. Copy the connection string into `.env.local` as `DATABASE_URL`.
3. Create the tables:
   ```bash
   npx drizzle-kit push
   ```
4. Make yourself admin (Neon SQL editor):
   ```sql
   INSERT INTO allowlist (email, role) VALUES ('grant@angrykoala.com.au', 'admin');
   ```

## 3. Google OAuth (~10 min)

1. https://console.cloud.google.com/apis/credentials → new project `dingodirt`.
2. OAuth consent screen: External, app name `dingodirt`, your email; add
   scopes `email`, `profile`, `openid`. Publish the app (or add testers).
3. Credentials → Create OAuth client ID → Web application:
   - Authorized redirect URIs:
     `https://dingodirt.com/api/auth/callback/google`
     `http://localhost:3000/api/auth/callback/google` (dev)
4. Copy client ID/secret → `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`.

## 4. Microsoft OAuth (~10 min)

1. https://entra.microsoft.com → App registrations → New registration.
   Supported account types: **personal Microsoft accounts + any org**.
   Redirect URI (Web): `https://dingodirt.com/api/auth/callback/microsoft-entra-id`
   (add the localhost twin for dev).
2. Certificates & secrets → new client secret.
3. Env vars: `AUTH_MICROSOFT_ENTRA_ID_ID` (Application ID),
   `AUTH_MICROSOFT_ENTRA_ID_SECRET`,
   `AUTH_MICROSOFT_ENTRA_ID_ISSUER=https://login.microsoftonline.com/common/v2.0`.

## 5. Cloudflare Turnstile (~3 min) — protects the Report form

1. Cloudflare dashboard → Turnstile → Add site → domain `dingodirt.com`,
   widget mode Managed.
2. Copy keys → `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`.

## 6. Vercel (~10 min)

1. https://vercel.com → Add New Project → import the DingoDirt GitHub repo
   (defaults are fine, it detects Next.js).
2. Storage → Create → **Blob** → connect to the project. This injects
   `BLOB_READ_WRITE_TOKEN` automatically.
3. Settings → Environment Variables — add everything from `.env.example`:
   `DATABASE_URL`, `AUTH_SECRET` (run `npx auth secret` or
   `openssl rand -base64 32`), the four `AUTH_GOOGLE/MICROSOFT` vars +
   issuer, both Turnstile keys, and `COOKIE_DOMAIN=.dingodirt.com`.
4. Analytics tab → Enable. (That's your visitors-by-country. Download
   counts are in the app itself — dashboard + admin.)
5. Redeploy so the env vars take.

## 7. DNS (~5 min + propagation)

At your DNS host for `dingodirt.com`:

| Record | Name | Value |
|---|---|---|
| CNAME (or A per Vercel's instructions) | `@` | `cname.vercel-dns.com` |
| CNAME | `nav` | `grantpaisley.github.io` |

Then Vercel → Project → Settings → Domains → add `dingodirt.com`.
For `nav.`: GitHub → DingoNav repo → Settings → Pages → custom domain
`nav.dingodirt.com` + Enforce HTTPS (per `Dingo/Docs/deploy-dingodirt.md`).
`plan.` / `studio.` / `demo.` follow later when those deploy.

## 8. Smoke test (5 min)

1. Open dingodirt.com → landing renders, Analytics tab starts counting.
2. Sign in with Google → Admin link appears (you're in `allowlist` as admin).
3. `/publish` → drop a `.dingonav` from `~/Desktop/Projects/dingo-shares/shares/`
   → lands on its pack page.
4. Dashboard → flip it to **Link only** → Copy link → open in a private
   window → download works, and the download count ticks up on your
   dashboard.
5. Flip it to **Public** with a second (non-admin) test account → shows
   "pending review" → approve it in `/admin` → it appears in `/rides`.
6. On the public pack page (signed out) → **Report a problem** → report
   appears in `/admin`.
7. Flip the pack back to **Private** → the private-window link now says
   "no longer shared".

## 9. Open-source flip (when ready — order matters)

1. Create the **`dingodirt` GitHub org**; enable org Discussions.
2. **Scrub secrets** from each repo's history (`.env`, tokens) before
   making anything public — check `Dingo/.env` especially.
3. Add per repo: `LICENSE` (AGPL-3.0), `CONTRIBUTING.md`, sample data,
   README pointing at dingodirt.com. **State: open source ≠ open data.**
4. Move/transfer Dingo, DingoNav, (Studio when it exists), DingoDirt into
   the org; flip public.
5. Set up GitHub Sponsors (or Ko-fi) and update the URL in
   `app/get-involved/page.tsx`.
6. Add the `/self-host` page (docker-compose instructions from the Dingo
   repo).

## 10. Loose ends in code (when you have real values)

- `app/page.tsx` + `app/get-involved/page.tsx`: replace the placeholder
  Facebook group / GitHub org / Sponsors URLs.
- The pack-page buttons point at `nav.dingodirt.com` / `studio.dingodirt.com`;
  they'll come alive as those subdomains do.

## Known deferred items

- Shared PMTiles archive + pack format v2 + Nav corridor-tile fetcher
  (design: `2026-08-03-dingodirt-open-source-pivot-design.md`) — then the
  `/make` GPX→pack page.
- Folder management UI (schema + display exist; create/move UI pending).
- Blob purge job for packs retracted >30 days ago.
- Gallery search box (galleries are small enough to skim for now).
