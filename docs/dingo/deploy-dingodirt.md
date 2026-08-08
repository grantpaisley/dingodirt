# Deploying Dingo to dingodirt.com

Dingo is three processes: PostGIS, the Rust daemon (`dingo-server`), and the
static React web app. **Only the web app can run on Vercel.** The daemon and the
database need a host that runs long-lived processes (a VPS, or your Mac behind a
tunnel). This document covers the web-on-Vercel piece. It also lays out the
options for the rest.

## 0. DingoNav at nav.dingodirt.com (5-minute job, do first)

DingoNav is fully static and already live at
https://grantpaisley.github.io/DingoNav/. To point the domain at it, you need
one DNS record and one repo setting. GitHub Pages cannot serve under a PATH
(dingodirt.com/nav does not work directly). Use the subdomain, plus an optional
redirect from the path:

1. **DNS** (at your DNS host):
   `nav.dingodirt.com  CNAME  grantpaisley.github.io`
   (Cloudflare: set the record to *DNS only* — grey cloud — until the
   certificate issues. After that, proxying is optional.)
2. **Repo**: GitHub → DingoNav → Settings → Pages → Custom domain →
   `nav.dingodirt.com`. Tick *Enforce HTTPS* after the certificate check passes
   (minutes to an hour). This commits a `CNAME` file to the repo. This is also
   why we do not pre-commit the file: a custom domain without DNS breaks the
   current github.io URL.
3. Optional path redirect (Cloudflare rule):
   `dingodirt.com/nav*  →  https://nav.dingodirt.com/$1` (301).
4. After the domain works, update `DINGO_NAV_URL` for the daemon (share
   links) — e.g. in `.env`: `DINGO_NAV_URL=https://nav.dingodirt.com/`.

The planner web app follows the same pattern later at `plan.dingodirt.com`
(Vercel → Domains → add `plan.dingodirt.com`; DNS CNAME to
`cname.vercel-dns.com`). The daemon follows at `api.dingodirt.com` (section 2).

## 1. Web app on Vercel (ready now)

The web build reads `VITE_API_URL` at build time. It falls back to
`http://localhost:3000` for local dev. `web/vercel.json` configures the Vite
static build.

```bash
cd web
vercel login                      # one-time, interactive (device/browser flow)
vercel link                       # one-time: create/link the Vercel project
vercel --prod \
  --build-env VITE_API_URL=https://api.dingodirt.com
```

Point the `dingodirt.com` domain at the Vercel project (Vercel dashboard →
Domains). Put the daemon behind `api.dingodirt.com` (below).

Notes:
- Until a daemon is reachable at the URL you baked in, the deployed UI loads
  but shows no data. The frontend holds no ride data itself.
- The daemon already sends permissive CORS, so a cross-origin frontend works.

## 2. Daemon + PostGIS — pick one

**a. VPS (the dingodirt.com end state).** Use any small VPS (Hetzner/DO). Run
PostGIS 16 via Docker (same as `scripts/dev-db.sh`). Run a `dingo-server`
release build. Set `DINGO_BIND=0.0.0.0:3000` — the daemon binds localhost by
default. Put Caddy in front for TLS on `api.dingodirt.com`. **Add auth before
you expose it.** The API currently has none. Cloudflare Access in front of the
whole domain is the low-effort private option. The privacy-zone work (trim
tracks near home) must land before anything goes public.

**b. Mac + Cloudflare Tunnel (zero-cost interim).** Keep everything running
locally as today. `cloudflared tunnel` maps `api.dingodirt.com` to
`localhost:3000`. You get access from anywhere while the Mac is awake. The same
auth caveat applies.

## 3. Data sync

A hosted daemon needs the rides. One option: point it at a `pg_dump`/restore of
the local DB. Add the `files/` and `photos/` stores if photo serving matters.
The other option: treat the hosted instance as a read-only mirror, refreshed by
a dump on demand. The web-upload/import UI (parked thread #1 in the 2026-07-10
design doc) is what eventually removes the local-Mac dependency.
