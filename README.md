# dingodirt

Open-source tools for off-road riding. Turn your ride history into a
maintained trail network. Plan routes from the network. Follow the routes
offline on the bike. Make the maps look the way you want.

There are four apps in one repo, with shared cartography and behaviour.

| App | What it is | Who it's for |
|---|---|---|
| [`apps/nav`](apps/nav) | Offline GPX track follower — a single-file PWA, MapLibre GL + PMTiles basemap | Jules, on the bike |
| [`apps/plan`](apps/plan) | Route planning SPA over the segment network | Macca (online) and Deano (laptop) |
| [`apps/studio`](apps/studio) | Map scheme designer — design, test-drive, publish | Tan |
| [`apps/site`](apps/site) | dingodirt.com — brand landing, pack gallery, cross-app links | everyone |

## Who this is built for

The people below are the reason for each design decision. None of them needs
a GitHub account to use these tools.

- **Jules — the rider.** She opens Nav from a link and installs it as a PWA.
  She rides with it fully offline. She never sees a repo. She never sees a
  settings screen that she did not ask for.
- **Macca — the online pack builder.** He clicks a plan link, and a wizard
  helps him bring his own infrastructure: a Neon or Supabase database, his
  own Strava API app, and an optional MapTiler key. The cost is near $0 on
  the free tiers. Harvest, heatmap, and pack builds run in his browser. His
  library lives in his own database, not ours.
- **Deano — the laptop pack builder.** He clones this repo and runs
  `docker compose up`. He then runs the *same* Plan app, pointed at
  localhost. He gets headless batch jobs, fully local planning, and
  `pg_dump` for migrations. Online use and laptop use are two configurations
  of one app, never two apps.
- **Tan — the hobbyist cartographer.** She opens Studio in a browser and
  designs a scheme. She test-drives the scheme at speed and publishes it to
  the gallery. She contributes JSON tokens, not code.
- **The club.** To share the tool is to share the database. Trusted
  co-admins come in through the project invites of the database provider.
  Because of this, the trust boundary is the database, not the app code.
  Members contribute, and the admin curates.

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

Map schemes, behaviours, and appliers live in `core/` in **exactly one
copy**. Each app reaches them through a symlink. When you edit
`core/schemes/default.json`, the change shows in each app at the same time —
there is nothing to sync.

Symlinks do not stay on a static host. Because of this, deploys run
`tools/assemble-app.sh <nav|studio> <out>` to change the symlinks into real
files. For Nav, this step also adds a content hash of the presets to the
service-worker cache name. Because of this, offline riders get the presets
again when the presets change, and only then.

`npm test` runs the guard that fails if an app gets a local copy again. This
guard replaced a cross-repo sync workflow and its PAT.

Pack share links are served by dingodirt.com (the `site` app). Plan
publishes to the site, and Nav's `?b=` links download from it. The old
`dingo-shares` GitHub-as-CDN repo is retired (archived; its links are dead).

## Getting started

Per-app setup, and the rules that say which app gets a feature, are in
[CONTRIBUTING.md](CONTRIBUTING.md). The short version: Nav is one file on
purpose, Studio is modules, Plan is React, and `core/` is shared. Grow the
shared vocabulary in `core/` first.

## Licence

[MIT](LICENSE).
