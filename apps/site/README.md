# dingodirt.com

Community website and pack service for the Dingo ecosystem — the open-source
home of Dingo Plan, Nav and Studio (AGPL-3.0).

Design docs (in the Dingo repo):
`Docs/plans/2026-08-02-dingodirt-website-design.md` +
`Docs/plans/2026-08-03-dingodirt-open-source-pivot-design.md`.

## What it does

- **Riders** browse public packs and tap *Ride it* — no account needed.
- **Authors** sign in (Google/Microsoft, open sign-up) and publish
  `.dingonav` / `.dingoscheme` packs: private by default → shareable
  capability link → public gallery (after a quick admin review; **trusted**
  authors skip the queue). Downloads are counted per pack.
- **Route safety**: terms of use, land-access rider notice, Report button,
  pre-publication review for public listings.
- **Developers** self-host Plan from the GitHub org and publish here.

## Stack

Next.js (App Router) on Vercel · Neon Postgres via Drizzle (`db/schema.ts`)
· Auth.js v5 (Google + Microsoft) · Vercel Blob (pack zips) · Cloudflare
Turnstile (report form) · Vercel Analytics.

## Local development

```bash
npm install
cp .env.example .env.local   # AUTH_SECRET is the only must-have locally
npm run dev
npm test                     # vitest
```

Degrades gracefully: no `DATABASE_URL` → friendly 503s on writes; no OAuth
creds → sign-in errors; no Turnstile → captcha skipped (dev only); no
`BLOB_READ_WRITE_TOKEN` → uploads say storage isn't configured.

## Database

```bash
npx drizzle-kit push
```

Tables: Auth.js four + `packs` / `pack_versions` / `folders` / `reports` /
`allowlist` (elevated roles only — `trusted` skips public review, `admin`
moderates; everyone signed-in can publish).

Make yourself admin:

```sql
INSERT INTO allowlist (email, role) VALUES ('you@example.com', 'admin');
```

## Deploy

See `GO-LIVE.md`.

## Status / roadmap

1. ✅ Skeleton, landing, auth
2. ✅ Pack service (upload, visibility + review queue, capability links,
   download counts)
3. ✅ Galleries, pack pages, dashboard, admin
4. ⬜ GitHub org flip + `/self-host` page
5. ⬜ Shared PMTiles + pack format v2 → `/make` GPX pack maker
6. ⬜ Studio/Plan in-app publish buttons
