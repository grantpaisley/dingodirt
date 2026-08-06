# Contributing

Four apps share this repo. They are built very differently *on purpose*, and
the differences are the first thing worth understanding — a change that would
be obviously right in Plan can be obviously wrong in Nav.

## The per-app map

| Where | What it is | The rule |
|---|---|---|
| `apps/nav` | One HTML file, vendored libraries, **no build step** | Keep it that way. See below. |
| `apps/studio` | Native ES modules, no build step, no dependencies | Add modules, not tooling. |
| `apps/plan` | React + Vite + TypeScript | Normal React app; `npm ci` then `npm run dev`. |
| `apps/site` | Next.js, auth, Postgres | Needs a database and OAuth — see `apps/site/GO-LIVE.md`. |
| `core/` | Shared by all of them | **Grow shared vocabulary here first.** |
| `server/` | Migrations, docker-compose, tooling | Deano's self-hosted backend. |

### Nav is one file on purpose

`apps/nav/index.html` is large and that is not an accident. Nav has to work
with no signal, on a phone mounted to a handlebar, after being installed as a
PWA months earlier. One file with vendored libraries means there is no module
graph to fail to load, no CDN to be unreachable, and no build step between the
source and what the rider is running.

So: no bundler, no npm dependencies, no framework. If you are about to add a
build step to Nav, that is a design discussion, not a pull request.

The consequence is that **Nav's inline applier is a hand-aligned translation**
of `core/appliers/applier-nav.js`, not a copy of it — Nav has no module system
to import it with. Its token names differ (`overlays.breadcrumb` → `colCrumb`,
day tokens only). Keep the two aligned by hand when the vocabulary grows.
Unifying them for real requires Nav to adopt native ES modules, which is a
separate piece of work.

## core/ holds exactly one copy of everything shared

```
core/schemes/     map scheme preset pairs
core/behaviors/   nav behaviour profiles
core/appliers/    applier-nav.js + scheme.js (the token registry)
core/rust/        the Cargo workspace
```

Each app reaches these through a **symlink**, so editing
`core/schemes/default.json` changes it everywhere at once. There is nothing to
sync.

This replaced a cross-repo workflow that kept three copies aligned through a
personal access token. `npm test` runs a guard that fails if an app grows a
local copy again, and it names the exact path. **If that test fails, do not add
an exception — move the thing into `core/`.**

Symlinks do not survive a static host, so deploys run
`tools/assemble-app.sh <nav|studio> <out>`, which dereferences them into real
files. For Nav it also appends a content hash of the presets to the
service-worker cache name, so offline riders refetch when presets change and
only then.

### Adding a scheme token

1. Add it to `TOKEN_DEFS` / `TOKEN_GROUPS` in `core/appliers/scheme.js`.
2. Apply it in `core/appliers/applier-nav.js`.
3. Hand-align Nav's inline applier and Plan's `applierPlan.ts`.
4. `npm run test:studio` — the applier-contract test pins the mapping.

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

The Rust workspace needs a live PostGIS, because sqlx checks queries at
**compile time** and there is no committed `.sqlx` offline cache:

```bash
cd server && docker compose up -d
cd core/rust && DATABASE_URL=postgres://dingo:dingo@localhost:5433/dingo cargo test
```

If `cargo check` fails with *"set DATABASE_URL to use query macros online"*,
that is the database not being up — not a code error.

## CI

One workflow, path-filtered: a Nav-only PR does not compile Rust. A change to
anything in `core/` fans out to **every** app job, because there is one copy
now and you cannot tell from the diff which app it breaks.

The required status check is **`CI`**, the gate job — not the individual jobs.
Path-filtered jobs report `skipped`, which branch protection treats as
never-completed.

## Deployment

| App | Where |
|---|---|
| **nav (canonical)** | `nav.dingodirt.com` — DingoNav repo's Pages, rebuilt from this repo by its mirror workflow |
| nav, studio, plan | GitHub Pages from this repo → `grantpaisley.github.io/dingodirt/{nav,studio,plan}/` |
| site | Vercel at `dingodirt.com` — it needs a database and server-side auth, so Pages cannot host it |

The old `grantpaisley.github.io/DingoNav/` URL 301-redirects to
`nav.dingodirt.com` (a GitHub Pages custom domain does that automatically), so
pack share links minted before 2026-08-06 still resolve. PWAs installed from
the old origin keep running from their service-worker cache but no longer
receive updates — reinstalling from `nav.dingodirt.com` is the fix.

The DingoNav repo is **not archived** and must not be: its Pages site IS
`nav.dingodirt.com`, and an archived repo cannot run the Actions workflow that
keeps it current.

Plan is served from a subpath, so anything reading a public asset at runtime
must use `import.meta.env.BASE_URL` rather than a leading slash. A leading
slash resolves against the domain root and — because Plan's manifest fetches
degrade to an empty list rather than throwing — fails *silently*.

## Design docs

`docs/plans/` holds every design doc from all four original repos, prefixed
`nav-` / `studio-` / `dingo-` with the dated filenames intact. They are a
historical trail: they describe what was decided and when, not necessarily how
things work today. The code is the truth; the docs are the reasoning.

## Related repos

[`grantpaisley/dingo-shares`](https://github.com/grantpaisley/dingo-shares)
stays separate on purpose — it is GitHub-as-CDN, its raw URLs are load-bearing,
and its commit history *is* the moderation model (moderation = revert).

## Licence

MIT. By contributing you agree your contributions are licensed under it.
