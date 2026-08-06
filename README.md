# dingodirt

Open-source tools for off-road riding: turn ride history into a maintained
trail network, plan routes from it, follow them offline on the bike, and make
the maps look the way you want.

Four apps, one repo, shared cartography and behaviour.

| App | What it is | Who it's for |
|---|---|---|
| [`apps/nav`](apps/nav) | Offline GPX track follower — a single-file PWA, MapLibre GL + PMTiles basemap | Jules, on the bike |
| [`apps/plan`](apps/plan) | Route planning SPA over the segment network | Macca (online) and Deano (laptop) |
| [`apps/studio`](apps/studio) | Map scheme designer — design, test-drive, publish | Tan |
| [`apps/site`](apps/site) | dingodirt.com — brand landing, pack gallery, cross-app links | everyone |

## Who this is built for

The people below are the reason each design decision went the way it did. None
of them needs a GitHub account to use any of this.

- **Jules — the rider.** Opens Nav from a link, installs it as a PWA, rides
  with it fully offline. Never sees a repo, never sees a settings screen she
  didn't ask for.
- **Macca — the online pack builder.** Clicks a plan link and a wizard walks
  him through bringing his own infrastructure: a Neon or Supabase database,
  his own Strava API app, optionally a MapTiler key — roughly $0 on free
  tiers. Harvest, heatmap and pack builds run in his browser; his library
  lives in his own database, not ours.
- **Deano — the laptop pack builder.** Clones this repo, `docker compose up`,
  and runs the *same* Plan app pointed at localhost. Headless batch jobs,
  fully local planning, `pg_dump` for migrations. Online versus laptop is a
  configuration of one app, never two apps.
- **Tan — the hobbyist cartographer.** Opens Studio in a browser, designs a
  scheme, test-drives it at speed, publishes it to the gallery. Contributes
  JSON tokens, not code.
- **The club.** Sharing the tool is sharing the database: trusted co-admins
  come in through the database provider's own project invites, so the trust
  boundary is the database rather than app code. Members contribute, the admin
  curates.

## Layout

```
apps/
  nav/        DingoNav — single-file PWA, deliberately no build step
  studio/     DingoStudio — ES modules, no build step
  plan/       React SPA (Vite)
  site/       dingodirt.com
core/
  schemes/    canonical map scheme preset pairs — the ONLY copy
  behaviors/  nav behaviour profiles
  appliers/   applier-nav.js + scheme.js — the module form is canonical here
  rust/       Dingo crates (native today; WASM targets later)
server/       the backend for local/self-hosted use: migrations,
              docker-compose, tooling
docs/plans/   design docs, origin-prefixed, dated
tools/        assemble-app.sh — deploy-time artefact assembly
tests/        repo-level checks (npm test)
```

Map schemes, behaviours and appliers live in `core/` in **exactly one copy**.
Each app reaches them through a symlink, so editing `core/schemes/default.json`
changes it everywhere at once — there is nothing to sync.

Symlinks don't survive a static host, so deploys run
`tools/assemble-app.sh <nav|studio> <out>` to dereference them into real
files. For Nav that step also appends a content hash of the presets to the
service-worker cache name, so offline riders refetch when presets change and
only then.

`npm test` runs the guard that fails if any app grows a local copy again.
This replaced a cross-repo sync workflow and its PAT.

Related: [`grantpaisley/dingo-shares`](https://github.com/grantpaisley/dingo-shares)
stays a separate repo on purpose — it is GitHub-as-CDN, its raw URLs are
load-bearing, and its commit history *is* the moderation model.

## Getting started

Per-app setup, and the rules for which app to grow a feature in, are in
[CONTRIBUTING.md](CONTRIBUTING.md). The short version: Nav is one file on
purpose, Studio is modules, Plan is React, `core/` is shared — grow shared
vocabulary in `core/` first.

## Licence

[MIT](LICENSE).
