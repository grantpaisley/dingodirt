# Contributing

Four apps share this repo. They have different structures *on purpose*, and
the differences are the first thing to learn. A change that is correct in
Plan can be wrong in Nav.

## The per-app map

| Where | What it is | The rule |
|---|---|---|
| `apps/nav` | One HTML file, vendored libraries, **no build step** | Keep it that way. See below. |
| `apps/studio` | Native ES modules, no build step, no dependencies | Add modules, not tooling. |
| `apps/plan` | React + Vite + TypeScript | A normal React app. Run `npm ci`, then `npm run dev`. |
| `apps/site` | Next.js, auth, Postgres | It needs a database and OAuth — see `apps/site/GO-LIVE.md`. |
| `core/` | Shared by all apps | **Grow the shared vocabulary here first.** |
| `server/` | Migrations, docker-compose, tooling | Deano's self-hosted backend. |

### Nav is one file on purpose

`apps/nav/index.html` is large, and this is not an accident. Nav must operate
with no signal, on a phone mounted to a handlebar. It must also operate as a
PWA that the rider installed months before. One file with vendored libraries
gives three protections. There is no module graph that can fail to load.
There is no CDN that can be unreachable. There is no build step between the
source and the app that the rider runs.

So: no bundler, no npm dependencies, no framework. If you want to add a build
step to Nav, start a design discussion. Do not open a pull request.

The result is that **Nav's inline applier is a hand-aligned translation** of
`core/appliers/applier-nav.js`, not a copy of it. Nav has no module system
to import the module with. Its token names are different
(`overlays.breadcrumb` → `colCrumb`, day tokens only). When the vocabulary
grows, align the two by hand. A full unification needs Nav to adopt native
ES modules, and that is a separate piece of work.

## core/ holds exactly one copy of everything shared

```
core/schemes/     map scheme preset pairs
core/behaviors/   nav behaviour profiles
core/appliers/    applier-nav.js + scheme.js (the token registry)
core/rust/        the Cargo workspace
```

Each app reaches these files through a **symlink**. When you edit
`core/schemes/default.json`, the change shows in each app at the same time.
There is nothing to sync.

This design replaced a cross-repo workflow. That workflow kept three copies
aligned through a personal access token. `npm test` runs a guard test. The
guard test fails if an app gets a local copy again, and it gives the exact
path. **If this test fails, do not add an exception — move the item into
`core/`.**

Symlinks do not stay on a static host. Because of this, deploys run
`tools/assemble-app.sh <nav|studio> <out>`, which changes the symlinks into
real files. For Nav, the script also adds a content hash of the presets to
the service-worker cache name. Because of this, offline riders get the
presets again when the presets change, and only then.

### Adding a scheme token

1. Add the token to `TOKEN_DEFS` / `TOKEN_GROUPS` in `core/appliers/scheme.js`.
2. Apply the token in `core/appliers/applier-nav.js`.
3. Hand-align Nav's inline applier and Plan's `applierPlan.ts`.
4. Run `npm run test:studio` — the applier-contract test pins the mapping.

## Running things

```bash
npm test                 # repo guard: no vendored preset copies
npm run test:nav         # corridor tests
npm run test:studio      # schema, applier contract, replay

cd apps/plan  && npm ci && npm run dev      # http://localhost:5173
cd apps/studio && node serve.js             # http://localhost:8138
cd apps/nav    && node serve.js             # http://localhost:8138
cd apps/site   && npm ci && npm run dev     # http://localhost:3000
```

The Rust workspace needs a live PostGIS database. This is because sqlx checks
the queries at **compile time**, and there is no committed `.sqlx` offline
cache:

```bash
cd server && docker compose up -d
cd core/rust && DATABASE_URL=postgres://dingo:dingo@localhost:5433/dingo cargo test
```

If `cargo check` fails with *"set DATABASE_URL to use query macros online"*,
the database is not up. This is not a code error.

## CI

There is one workflow, and it is path-filtered. A Nav-only PR does not
compile the Rust code. A change to a file in `core/` starts **every** app
job. This is because there is one copy now, and the diff does not show which
app the change breaks.

The required status check is **`CI`**, the gate job — not the individual
jobs. Path-filtered jobs report `skipped`. Branch protection counts a
`skipped` job as a job that did not complete.

## Deployment

| App | Where |
|---|---|
| **nav (canonical)** | `nav.dingodirt.com` — the Pages site of the DingoNav repo; its mirror workflow rebuilds it from this repo |
| nav, studio, plan | GitHub Pages from this repo → `grantpaisley.github.io/dingodirt/{nav,studio,plan}/` |
| site | Vercel at `dingodirt.com` — it needs a database and server-side auth, so Pages cannot host it |

The old `grantpaisley.github.io/DingoNav/` URL 301-redirects to
`nav.dingodirt.com`. A GitHub Pages custom domain does this automatically.
Because of this, pack share links minted before 2026-08-06 still resolve.
PWAs installed from the old origin continue to run from their service-worker
cache, but they do not get updates. The fix is to install the PWA again from
`nav.dingodirt.com`.

The DingoNav repo is **not archived**, and it must stay that way. Its Pages
site IS `nav.dingodirt.com`. An archived repo cannot run the Actions
workflow that keeps the site current.

Plan is served from a subpath. Because of this, code that reads a public
asset at runtime must use `import.meta.env.BASE_URL`, not a leading slash. A
leading slash resolves against the domain root, and it fails *silently*. It
fails silently because Plan's manifest fetches degrade to an empty list and
do not throw.

## Design docs

`docs/plans/` holds each design doc from all four original repos. The docs
have the prefixes `nav-` / `studio-` / `dingo-`, and the dated filenames are
intact. They are a historical trail. They tell what was decided and when.
They do not always tell how the code works today. The code is the truth; the
docs are the reasoning.

## Related repos

The old `dingo-shares` GitHub-as-CDN repo is retired. Pack share links are
served by dingodirt.com (the `site` app). The site owns the versioning and
the moderation queue.

## Licence

MIT. When you contribute, you agree that your contributions are licensed
under it.
