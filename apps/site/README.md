# dingodirt.com

This is the community website and pack service for the Dingo ecosystem. It
is the open-source home of Dingo Plan, Nav, and Studio (AGPL-3.0).

Design docs (in the Dingo repo):
`Docs/plans/2026-08-02-dingodirt-website-design.md` +
`Docs/plans/2026-08-03-dingodirt-open-source-pivot-design.md`.

## What it does

- **Riders** browse the public packs and tap *Ride it*. They do not need an
  account.
- **Authors** sign in (Google/Microsoft, open sign-up) and publish
  `.dingonav` / `.dingoscheme` packs. A pack is private by default → then a
  shareable capability link → then the public gallery (after a quick admin
  review; **trusted** authors skip the queue). The site counts downloads per
  pack.
- **Route safety**: terms of use, a land-access rider notice, a Report
  button, and a pre-publication review for public listings.
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

The app degrades gracefully. With no `DATABASE_URL`, writes get friendly
503s. With no OAuth creds, sign-in shows errors. With no Turnstile, the
captcha is skipped (dev only). With no `BLOB_READ_WRITE_TOKEN`, uploads say
that storage is not configured.

## Database

```bash
npx drizzle-kit push
```

Tables: the four Auth.js tables plus `packs` / `pack_versions` / `folders` /
`reports` / `allowlist`. The `allowlist` table holds elevated roles only —
`trusted` skips the public review, and `admin` moderates. Each signed-in
user can publish.

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
