# Deploying Dingo to dingodirt.com

Dingo is three processes — PostGIS, the Rust daemon (`dingo-server`), and the
static React web app. **Only the web app can run on Vercel**; the daemon and
database need a host that runs long-lived processes (VPS, or your Mac behind a
tunnel). This doc covers the web-on-Vercel piece and lays out the options for
the rest.

## 0. DingoNav at nav.dingodirt.com (5-minute job, do first)

DingoNav is fully static and already live at
https://grantpaisley.github.io/DingoNav/ — pointing the domain at it needs
one DNS record and one repo setting. GitHub Pages can't serve under a PATH
(dingodirt.com/nav won't work directly); use the subdomain and optionally a
redirect from the path:

1. **DNS** (at your DNS host):
   `nav.dingodirt.com  CNAME  grantpaisley.github.io`
   (Cloudflare: set the record to *DNS only* — grey cloud — until the cert
   issues, then proxying is optional.)
2. **Repo**: GitHub → DingoNav → Settings → Pages → Custom domain →
   `nav.dingodirt.com`, tick *Enforce HTTPS* once the certificate check
   passes (minutes to an hour). This commits a `CNAME` file to the repo —
   which is also why we don't pre-commit it: a custom domain without DNS
   breaks the current github.io URL.
3. Optional path redirect (Cloudflare rule):
   `dingodirt.com/nav*  →  https://nav.dingodirt.com/$1` (301).
4. After the domain works, update `DINGO_NAV_URL` for the daemon (share
   links) — e.g. in `.env`: `DINGO_NAV_URL=https://nav.dingodirt.com/`.

The planner web app follows the same pattern later at `plan.dingodirt.com`
(Vercel → Domains → add `plan.dingodirt.com`; DNS CNAME to
`cname.vercel-dns.com`), and the daemon at `api.dingodirt.com` (section 2).

## 1. Web app on Vercel (ready now)

The web build reads `VITE_API_URL` at build time (falls back to
`http://localhost:3000` for local dev), and `web/vercel.json` configures the
Vite static build.

```bash
cd web
vercel login                      # one-time, interactive (device/browser flow)
vercel link                       # one-time: create/link the Vercel project
vercel --prod \
  --build-env VITE_API_URL=https://api.dingodirt.com
```

Point the `dingodirt.com` domain at the Vercel project (Vercel dashboard →
Domains), and put the daemon behind `api.dingodirt.com` (below).

Notes:
- Until a daemon is reachable at the URL you baked in, the deployed UI loads
  but shows no data — the frontend contains no ride data itself.
- The daemon already sends permissive CORS, so a cross-origin frontend works.

## 2. Daemon + PostGIS — pick one

**a. VPS (the dingodirt.com end state).** Any small VPS (Hetzner/DO):
PostGIS 16 via Docker (same as `scripts/dev-db.sh`), `dingo-server` release
build (set `DINGO_BIND=0.0.0.0:3000` — it binds localhost by default), Caddy in
front for TLS on `api.dingodirt.com`. **Add auth before exposing it** — the
API currently has none; Cloudflare Access in front of the whole domain is the
low-effort private option, and the privacy-zone work (trim tracks near home)
must land before anything goes public.

**b. Mac + Cloudflare Tunnel (zero-cost interim).** Keep everything running
locally as today; `cloudflared tunnel` maps `api.dingodirt.com` to
`localhost:3000`. Access from anywhere while the Mac is awake; same auth
caveat.

## 3. Data sync

A hosted daemon needs the rides. Either point it at a `pg_dump`/restore of the
local DB (plus the `files/` and `photos/` stores if photo serving matters), or
treat the hosted instance as read-only mirror refreshed by dump on demand.
The web-upload/import UI (parked thread #1 in the 2026-07-10 design doc) is
what eventually removes the local-Mac dependency.
