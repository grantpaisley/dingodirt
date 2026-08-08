# dingodirt monorepo — migration design

2026-08-05. Decision: put DingoNav, DingoStudio, Dingo (Plan + core +
server), and the DingoDirt site into one public monorepo,
`grantpaisley/dingodirt`, MIT-licensed. dingo-shares stays separate.

This document supersedes the multi-repo assumptions in
`2026-08-02-dingo-studio-design.md` (vendored appliers, sync scripts). It
builds on `2026-08-03-dingodirt-open-source-pivot-design.md`.

## Why

The personas never touch a repository. Jules gets a link. Tan gets a
website. Macca gets a link (online) or a clone (laptop). Each thing that
crosses a tool boundary is an artefact (packs, schemes, behaviours, share
links). These artefacts flow through the share store, not git. Thus the repo layout is only a question for contributors and for drift management. The drift is real:

- The schemes and behaviors exist in three copies. A sync workflow + a PAT bridge them
  (built 2026-08-05; this migration retires them).
- The appliers exist as one canonical module + two hand-aligned translations.
- Studio's navview.js/cues.js make Nav's camera + cue behaviour again for the
  preview. They drift silently from the real thing.

With everything open source, no visibility boundary forces a split.
The planned direction (Plan as a static SPA + a WASM core with a BYO backend)
makes all four deliverables static sites. Then we get one repo, one deploy pipeline, and
shared modules for real.

## Personas (context for every layout decision)

- **Jules — the rider.** Jules loads Nav via a link, installs it as a PWA, and uses it fully
  offline. Jules never sees a repo.
- **Macca — the online pack builder.** Macca clicks a plan link. A wizard walks him
  through BYO infrastructure: a Neon/Supabase database, his own Strava API app, and an
  optional MapTiler key (about $0 on the free tiers). The harvest, the heatmap, and the pack build
  run in the browser (the WASM core). His library lives in his database.
- **Deano — the laptop pack builder.** Deano clones the repo and runs `docker compose up`.
  He uses the SAME Plan SPA, pointed at localhost. He gets headless batch jobs, fully local
  planning, and `pg_dump` migrations. Online vs laptop is a configuration of one
  app, never two apps.
- **Tan — the hobbyist.** Tan uses Studio in the browser. Tan designs schemes, test-drives
  them at speed, and publishes them to the gallery. Tan contributes JSON tokens, not code.
- **The club (g.o.a.t.y).** Tier 0: the admin is Macca, and the members are Jules.
  No software beyond today is necessary. Tier 1: trusted co-admins come through the project invites of the database
  provider (Supabase/Neon). To share the tool IS to share the database. There is zero app code. Tier 2 (a future programme): member accounts,
  roles, and RLS. This is real feature work. But we throw away nothing from tiers 0–1,
  because the trust boundary was always the database. The ride-code cue sync
  already lets members contribute marks while the admin curates them.

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

dingo-shares stays out. GitHub-as-CDN is its identity. Its history is the
moderation model (revert). Its raw URLs are load-bearing.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Repo name | `grantpaisley/dingodirt` |
| 2 | DingoDirt site | joins as `apps/site` — it is the umbrella brand, it renders the gallery cards from dingo-shares, and it owns the cross-app links; the upload endpoint is deploy config, not structure |
| 3 | Domains | unchanged — `nav.` / `studio.` / `plan.` / `dingodirt.com` |
| 4 | Licence | MIT |

## Phases

**Phase 0 — pre-flight** (before anything moves)
- Run gitleaks over all the histories (Dingo especially — it was private before).
- Lock the MapTiler key. The key is hardcoded in Plan's mapStyles.ts. It is a client-side
  key. It is publishable ONLY after you domain-restrict it in the MapTiler dashboard.
- Add the LICENSE (MIT) + a root README that names the personas.
- Finish or close DingoNav's in-flight PRs. (Branches do not survive the path
  rewrite gracefully.) Transfer the issues later (a same-owner transfer).

**Phase 1 — assemble** (the old repos stay untouched and live throughout)
- Make fresh clones. Run `git filter-repo --to-subdirectory-filter apps/nav` (etc.)
  for DingoNav and DingoStudio. Merge the rewritten histories into `dingodirt`
  with `--allow-unrelated-histories`. The blame + the design-doc trail survive.
- Dingo enters as a SNAPSHOT (apps/plan, core/rust, server/). Graft its history
  later, and only if its gitleaks scan is clean. You cannot unpublish
  published history.
- The DingoDirt site enters as a snapshot or with history, per the same scan rule.

**Phase 2 — de-duplicate**
- Move the presets to `core/schemes` + `core/behaviors`. Delete all the vendored copies.
- Nav stays no-build through DEPLOY-TIME assembly. The deploy job copies
  `core/schemes` into the nav artefact. The job bumps the SW cache when the schemes
  changed. (This is today's sync-workflow logic, relocated and PAT-free.)
- Studio imports the appliers and presets by relative path. The build copies the presets into Plan's dist.
- A repo test fails if an app grows a stray local preset copy.
- Retire `.github/workflows/sync-appliers.yml` + the SYNC_APPLIERS_TOKEN
  secret. `sync-appliers.sh` becomes the local dev helper only. (Or delete it
  once relative paths cover dev.)
- The canonical-vs-translated applier rule SURVIVES. Nav's inline applier is
  still a hand-aligned translation until Nav adopts native ES modules. That is a
  good first refactor IN the monorepo, not during the migration.

**Phase 3 — CI** — one workflow, path-filtered jobs:
- `rust` (core/rust, server), `plan` (tsc + vite build), `studio` (node
  tests), `nav` (corridor tests). A core/schemes change triggers all the app jobs.

**Phase 4 — deploy cutover**
- Make one static-deploy workflow with four artefacts (nav, studio, plan, site).
- Do staging deploys of all the apps from the monorepo BEFORE the hosting flips. Nav's
  cache-first service worker makes a bad deploy stay on the phones of the riders.
- THE PUBLIC URLS DO NOT CHANGE. The installed PWAs, the service workers, and every
  pack share link in the wild point at the current domains. Only the source
  behind them moves.

**Phase 5 — archive**
- Archive the old repos with pointer READMEs. Transfer the DingoNav issues.
- Write CONTRIBUTING.md with the per-app map: nav is one file on purpose, studio
  is modules, plan is React, and core is shared. Grow vocabularies in core first.

## Explicitly out of scope (separate programmes on the new foundation)

- The WASM core (crates → browser: harvest, heatmap, corridor, pack build)
- The BYO onboarding wizard (Macca's setup cards: the database, the Strava app, the maps
  key — demo mode first, infrastructure step by step)
- Tier-2 club roles (auth, RLS, role-aware UI)
- Nav → native ES modules (this unifies the applier for real)
- Night-mode schema support in Nav

## Risks

| Risk | Mitigation |
|---|---|
| Secrets in previously-private history | snapshot-first for Dingo/site; graft the history only after a clean scan |
| A bad deploy stays in Nav SWs | staging deploys + unchanged URLs; the SW cache bump discipline stays automated |
| History rewrite mistakes | everything happens on fresh clones + a new repo; a rollback is free until Phase 4 |
| In-flight community PRs orphaned | Phase 0 closes the queue first; the issues transfer |
| Preset drift returns via stray copies | a repo test forbids app-local preset copies |
