# dingodirt monorepo — migration design

2026-08-05. Decision: consolidate DingoNav, DingoStudio, Dingo (Plan + core +
server), and the DingoDirt site into one public monorepo,
`grantpaisley/dingodirt`, MIT-licensed. dingo-shares stays separate.

Supersedes the multi-repo assumptions in
`2026-08-02-dingo-studio-design.md` (vendored appliers, sync scripts) and
builds on `2026-08-03-dingodirt-open-source-pivot-design.md`.

## Why

The personas never touch a repository — Jules gets a link, Tan gets a
website, Macca gets a link (online) or a clone (laptop). Everything that
crosses tool boundaries is an artefact (packs, schemes, behaviours, share
links) flowing through the share store, not git. Repo layout is therefore
purely a contributor and drift-management question, and the drift is real:

- schemes/behaviors exist in three copies, bridged by a sync workflow + PAT
  (built 2026-08-05, retired by this migration)
- appliers exist as one canonical module + two hand-aligned translations
- Studio's navview.js/cues.js re-implement Nav's camera + cue behaviour for
  preview, drifting silently from the real thing

With everything open source there is no visibility boundary forcing a split.
The planned direction (Plan as a static SPA + WASM core with BYO backend)
makes all four deliverables static sites — one repo, one deploy pipeline,
shared modules for real.

## Personas (context for every layout decision)

- **Jules — the rider.** Nav loaded via link, installed as a PWA, fully
  offline. Never sees a repo.
- **Macca — the online pack builder.** Clicks a plan link; a wizard walks him
  through BYO infrastructure (Neon/Supabase database, his own Strava API app,
  optional MapTiler key — ~$0 on free tiers). Harvest + heatmap + pack build
  run in the browser (WASM core); his library lives in his database.
- **Deano — the laptop pack builder.** Clones the repo, `docker compose up`;
  the SAME Plan SPA pointed at localhost. Headless batch jobs, fully local
  planning, `pg_dump` migrations. Online vs laptop is a configuration of one
  app, never two apps.
- **Tan — the hobbyist.** Studio in the browser; designs schemes, test-drives
  them at speed, publishes to the gallery. Contributes JSON tokens, not code.
- **The club (g.o.a.t.y).** Tier 0: the admin is Macca, members are Jules —
  no software needed beyond today. Tier 1: trusted co-admins via the database
  provider's project invites (Supabase/Neon) — sharing the tool IS sharing
  the database; zero app code. Tier 2 (future programme): member accounts,
  roles, RLS — real feature work, but nothing in tiers 0–1 is thrown away
  because the trust boundary was always the database. The ride-code cue sync
  already gives members-contribute/admin-curates for marks.

## Target shape

```
dingodirt/
  apps/
    nav/        ← DingoNav (single-file PWA, stays no-build ON PURPOSE)
    studio/     ← DingoStudio
    plan/       ← Dingo web/ (React SPA)
    site/       ← DingoDirt site (gallery, brand landing, cross-app links)
  core/
    schemes/    ← canonical preset pairs — the ONLY copy
    behaviors/
    appliers/   ← applier modules (module form canonical here)
    rust/       ← Dingo crates (native for server/; WASM targets later)
  server/       ← Deano's backend: daemon, migrations, docker-compose, tools
  docs/plans/   ← merged design docs, origin-prefixed, dated convention kept
```

dingo-shares stays out: GitHub-as-CDN is its identity, its history is the
moderation model (revert), and its raw URLs are load-bearing.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Repo name | `grantpaisley/dingodirt` |
| 2 | DingoDirt site | joins as `apps/site` — it's the umbrella brand, renders gallery cards from dingo-shares, and owns the cross-app links; upload endpoint is deploy config, not structure |
| 3 | Domains | unchanged — `nav.` / `studio.` / `plan.` / `dingodirt.com` |
| 4 | Licence | MIT |

## Phases

**Phase 0 — pre-flight** (before anything moves)
- gitleaks over all histories (Dingo especially — previously private)
- lock the MapTiler key (hardcoded in Plan's mapStyles.ts — a client-side
  key, publishable ONLY once domain-restricted in the MapTiler dashboard)
- LICENSE (MIT) + root README naming the personas
- finish or close DingoNav's in-flight PRs (branches don't survive the path
  rewrite gracefully); issues transfer later (same-owner transfer)

**Phase 1 — assemble** (old repos untouched and live throughout)
- fresh clones; `git filter-repo --to-subdirectory-filter apps/nav` (etc.)
  for DingoNav and DingoStudio; merge rewritten histories into `dingodirt`
  with `--allow-unrelated-histories` — blame + design-doc trail survive
- Dingo enters as a SNAPSHOT (apps/plan, core/rust, server/) — history
  grafted later only if its gitleaks scan is clean; published history cannot
  be unpublished
- DingoDirt site snapshot or history per the same scan rule

**Phase 2 — de-duplicate**
- presets → `core/schemes` + `core/behaviors`, all vendored copies deleted
- Nav stays no-build via DEPLOY-TIME assembly: the deploy job copies
  `core/schemes` into the nav artefact and bumps the SW cache when they
  changed (today's sync-workflow logic, relocated, PAT-free)
- Studio imports appliers/presets by relative path; Plan's dist gets presets
  copied at build
- a repo test fails if any app grows a stray local preset copy
- retire `.github/workflows/sync-appliers.yml` + the SYNC_APPLIERS_TOKEN
  secret; `sync-appliers.sh` becomes the local dev helper only (or is
  deleted once relative paths cover dev)
- the canonical-vs-translated applier rule SURVIVES: Nav's inline applier is
  still a hand-aligned translation until Nav adopts native ES modules — a
  good first refactor IN the monorepo, not during migration

**Phase 3 — CI** — one workflow, path-filtered jobs:
- `rust` (core/rust, server), `plan` (tsc + vite build), `studio` (node
  tests), `nav` (corridor tests). A core/schemes change triggers all app jobs.

**Phase 4 — deploy cutover**
- one static-deploy workflow, four artefacts (nav, studio, plan, site)
- staging deploys of all apps from the monorepo BEFORE hosting flips — Nav's
  cache-first service worker makes a bad deploy linger on riders' phones
- THE PUBLIC URLS DO NOT CHANGE: installed PWAs, service workers, and every
  pack share link in the wild point at the current domains; only the source
  behind them moves

**Phase 5 — archive**
- old repos archived with pointer READMEs; DingoNav issues transferred
- CONTRIBUTING.md with the per-app map: nav is one file on purpose, studio
  is modules, plan is React, core is shared — grow vocabularies in core first

## Explicitly out of scope (separate programmes on the new foundation)

- WASM core (crates → browser: harvest, heatmap, corridor, pack build)
- the BYO onboarding wizard (Macca's setup cards: database, Strava app, maps
  key — demo mode first, infrastructure progressively)
- tier-2 club roles (auth, RLS, role-aware UI)
- Nav → native ES modules (unifies the applier for real)
- night-mode schema support in Nav

## Risks

| Risk | Mitigation |
|---|---|
| Secrets in previously-private history | snapshot-first for Dingo/site; graft history only after a clean scan |
| Bad deploy lingers in Nav SWs | staging deploys + unchanged URLs; SW cache bump discipline stays automated |
| History rewrite mistakes | everything happens on fresh clones + a new repo; rollback is free until Phase 4 |
| In-flight community PRs orphaned | Phase 0 closes the queue first; issues transfer |
| Preset drift returns via stray copies | repo test forbids app-local preset copies |
