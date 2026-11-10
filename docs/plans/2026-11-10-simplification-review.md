# Simplification review — the code as it is on 2026-11-10

Base: `main` at `ba9e0d5`. Read-only review by three agents (Rust and server;
Plan and Site; Nav, Studio, `core/` and `tools/`), each checked by reading the
code path end to end. The baseline is
`2026-09-09-super-review-shared-modules-and-simplification.md` ("the super
review"); this document does not repeat its reasoning, only its status and
what it missed.

## 0. Verdict

1. **Nothing from the super review has landed.** Since 2026-09-09 only the perf
   PR (#76) and a Compose name (#77) touched code. Every roadmap item is still
   open, and its evidence still holds (line numbers moved; see §2).
2. **The super review is still the right plan.** This pass found about
   1,400 more lines that can go, and three items where the super review is now
   wrong (§2.4).
3. **The fastest wins need no decision.** §1 lists about 1,700 lines that can
   go with no or low risk, before any Phase 0 decision.
4. **Phase 1 of the super review is done on branch `chore/simplify-phase-1`**
   (local, not pushed): 10 commits, 77 files, 7,247 lines out, 163 in. It also
   did the safe Phase 9 Rust items (the `vision` crate, the dead workspace
   block, the `lancedb` / `ort` / `tower` pins, 13 unused dependencies). All
   JS tests, `cargo check --workspace --all-targets` and the Plan build pass.
   Two super-review items were wrong and were kept: `apps/plan/public/vite.svg`
   is the favicon, and `apps/plan/src/index.css` has live rules.
5. **Seven real bugs came up on the way** (§3). Two are on the ride-critical
   offline path in Nav.

## 1. Do these first — no decision needed

Ordered by lines out per unit of risk, across the whole repo.

| # | Area | Move | Lines out | Risk |
|---|---|---|---|---|
| 1 | Rust | Delete dead public functions and types the compiler can prove unused: `core/src/area.rs` (`update_area`, `delete_area`, `get_area_boundary_geojson`), `core/src/area_service.rs` (`assign_ride_to_area`, `reassign_all_rides_to_areas`), `geo/src/turns.rs:421-438` (`enrich_ride_turns`), `geo/src/stops.rs:193`, `geo/src/simplify.rs:97`, `ingest/src/format.rs:37,86`, `ingest/src/track.rs:49,159`, `ingest/src/zip.rs:55-63` (`process_garmin_export`), `harvest` `name_slug`, `core/src/ids.rs:53-56` (`RouteId`, `PoiId`, `SavedRouteId`), `ListRidesParams.associated` (`rides.rs:24`), `Config.log_level` and `Config.model_path` | ~200 | none |
| 2 | Plan | Delete `components/Settings/StravaConnect.tsx`. Nothing imports it, and it was never mounted in the repo history | 190 | none |
| 3 | Rust | Delete the Strava tile proxy and the code only it uses (`strava.rs` `get_tile`, `fetch_tile`, `TileError`, the tile cache, `Cookies::header`, `load_cookies`). Export reads harvested MBTiles now (`export.rs:2459-2470`). Move `/status` and `/cookies` into `heat.rs` and keep the URL, because the Chrome extension posts to it | ~185 | low |
| 4 | Tools | One dev server: `tools/perf/serve.mjs` already does Range, CORS, mounts and Content-Length. Give it a small CLI, then delete `apps/nav/serve.js`, `apps/studio/serve.js` and `tools/dev-tile-server.js`. This removes the last CommonJS, so the `type: module` stub `package.json` files in `core/appliers` and `core/track-graph` can go too | ~85 | low |
| 5 | Rust | Merge small copies: tile math in `export.rs:2501-2539` → `dingo_harvest::tiles`; `urlencode_manifest` → `percent_encode_json`; `haversine_m` (`packs.rs:883`, `dry_run.rs:317`) → `dingo_geo::smooth::haversine_distance`; one `deserialize_some` (`labels.rs:176`, `folders.rs:103`) | ~70 | none |
| 6 | Rust | Delete `cli/src/bin/truncate.rs`. It truncates the legacy tables, and `server/scripts/dev-db.sh reset` does the job. It is also the second `.env` parser | 61 | none |
| 7 | Plan | Make one `format.ts`. `formatBytes` is an exact copy (`PackDetail.tsx:62`, `ExportDialog.tsx:192`), and distances have three formats today (`StatsBar.tsx:86`, `DetailPane.tsx:982`, `ListPane.tsx:239`, `useTrackGraph.ts:214`, `GraphPane.tsx:130`) | ~40 | low (choose one format) |
| 8 | Tools | One DB wrapper: dingoctl's `db` entry runs `server/scripts/dev-db.sh`, or `dev-db.sh` goes (keep its `reset` and `pg_isready` wait) | ~40 | low |
| 9 | Site | One publish response: `parseVisibility()` and `publishResponse()` in `lib/packs.ts`, used by `api/packs/route.ts:24-77`, `complete/route.ts:37-106` and `id/[id]/route.ts:9` | ~45 | low |
| 10 | Rust | One loader for `publish_pack` and `publish_plan` (`packs.rs:388-417`, `:544-575`) | ~35 | low |
| 11 | Site | Use `lib/ratelimit.ts` in `lib/publish-auth.ts:9-59` and `api/packs/[token]/feedback/route.ts:51-66`, which copy it | ~25 | none |
| 12 | Plan | Delete the style-editor leftovers in `mapStyles.ts:67-113` (`invalidateLocalStyle`, `updateLocalStyleCache`, `isBuiltinStyle`, the `pristine` copy) and fix the stale comment at `mapRegistry.ts:3-5` | ~25 | none |
| 13 | Rust | Fold the `dingo-harvest` binary into `dingo harvest`. `harvest/src/main.rs` repeats the start-up and its own clap tree | ~25 | low |
| 14 | CI | Remove checks that repeat `assemble-app.sh`: `deploy.yml:83-96` (Nav and Studio parts), `ci.yml:197-202`, `ci.yml:222-223` | ~18 | none |
| 15 | Plan | Vote verdict rule and colours into `core/` (`PackDetail.tsx:20-35`, site `PlanView.tsx:198-262`). The "no" colour has drifted (`#c96a5a` against `#8a4a42`) | ~15 | low |
| 16 | Site | `lib/publish-auth.ts:26-37` → `requestUserOr503` (`lib/tokens.ts:49-73`). This also fixes bug 4 | ~10 | low |
| 17 | Rust | CORS: one predicate for any `localhost` / `127.0.0.1` port, plus `DINGO_WEB_ORIGIN`. This fixes bug 6 | ~10 | low |
| 18 | Nav | `buildStyle` calls `ddCore.applyBaseOverrides` (`index.html:2346-2354` is the same logic as `applier-nav.js:59-65`) | ~8 | low |
| 19 | Small | Nav `TRACK_W` (`:2265`), Studio `DANGER_FAR` / `DANGER_NEAR` (`cues.js:278`), the stale PMTiles rules in `apps/nav/.gitignore:5-10`, the `apps/plan/public/behaviors` symlink and its test row (no Plan code reads behaviours) | ~11 | none |
| 20 | Nav | One `vendor/` in `core/vendor/`, symlinked; `assemble-app.sh` already copies with `cp -RL`. Nav and Studio vendor files have the same md5 | 2.2 MB of binaries | low |

Also low risk, and it fixes bug 1: **hash the whole Nav artefact** in
`assemble-app.sh:80-83` (every file except `sw.js`), then drop the manual
"bump CACHE" rule (`sw.js:2`, CONTRIBUTING). And **do not deploy dev files**:
`assemble-app.sh:43` copies `tests/`, `docs/` (including `varg-ble.html`),
the Python scripts, `serve.js`, `.gitignore` and `.claude/launch.json` to the
public site.

## 2. Status of the super review, by area

### 2.1 Rust and server (§4.5, Phase 9) — all still open

| Item | Now |
|---|---|
| `vision` crate dead; dead `[workspace.dependencies]` block (`Cargo.toml:92-100`); `lancedb` / `ort` pins | done on `chore/simplify-phase-1` |
| 12 unused dependencies | done on `chore/simplify-phase-1` (13 removed; google's `tokio` is used and stays) |
| `routes/export.rs` holds business logic | still true, 2,897 lines |
| Legacy segment/run schema, then squash 58 migrations | still true; live references only `geo/src/service.rs:317` and `truncate.rs:44` |
| One `ApiError`, one `AppState` | still true: 4 `type ApiError`, 67 `Extension(pool)`, 10 `Config::load()`, 6 `OnceLock<reqwest::Client>` |
| Post-ingest pipeline five ways | still true (`import.rs:238`, `rides.rs:283`, `organize.rs:264`, `strava_sync.rs:322`) |
| `.sqlx/` offline cache | not done; CI still runs psql then `cargo check` |
| `dedupe_plans` ordering bug | **confirmed** — bug 3 |

New, medium risk: **one zip-ingest pipeline** (~390 lines). Delete
`ingest_zip*`, `process_garmin_export_*`, `process_generic_zip` and
`is_garmin_export` (`zip.rs:23-384,575-606`); the CLI and `organize` call
`extract_tracks` then `ingest_file`, as the daemon and the new Garmin sync
already do. Test on a real GDPR export first: the old path reads only the
`UploadedFiles_*` parts and honours `--limit`.

Owner's call: `ingest/src/dry_run.rs` (588 lines, bootstrap-only, a third zip
walker); the label rename/delete and `get_owner` endpoints that no client
calls (~195 lines); always using the presigned pack upload (~45 lines).

### 2.2 Plan and Site (§4.1, §4.2) — all still open

Only four Plan/Site files changed since the super review (the perf PR). Every
§4.1 and §4.2 item is still true, with these updates:

- **Satellite source for Plan:** the site already uses ESRI World Imagery with
  no key (`PlanView.tsx:153-158`). That answers the Phase 0 question for the
  basemap collapse.
- **`hooks.ts`:** 58 `fetch(`, 57 `if (!res.ok) throw`, 0 `useMutation`,
  59 `invalidateQueries` (42 in DetailPane).
- **`store.ts` split:** `placesOpen` and `placesActive` must stay in the store
  (`store.ts:653-655`: the places tree unmounts on view change).
- **`sync-core.mjs`:** it copies `scheme.js` and `scheme.d.ts`, which no site
  file imports. The site already imports `core/ui/tokens.css` directly.
- **maplibre-gl:** the site's package says `^6.2.0`; the vendored runtime is
  v5.24.0. PlanView now has 8 `as unknown as` casts.

Moves of code, not removals: split the site's `PlanView.tsx` (1,733 lines)
along `createMap`, the phone sheet and the feedback helpers; move DetailPane's
eight sub-editors (`:9-449`) and MapToolbar's widgets (`:747-937`) to their
own files.

Medium risk: the site's `api/gallery` and the GET handler in
`api/packs/[token]` have no caller in this repo (~88 lines). They are public
CORS endpoints; check the mirrored DingoNav repo first.

### 2.3 Nav, Studio, `core/`, tools (§4.3, §4.4, §4.6) — all still open

The cue engine, geometry/GPX, `MARKS`, demo feed and IDB wrapper are still
copied between Nav and Studio. Varg is still inline. `validSchemaFile`,
`ADV_D.colCrumb`, `boot()` with no timeout and the `REF` reset are unchanged.
Studio still commits 41 MB of PMTiles. The "Plan styles" workspace is still
there, blocked on the Phase 4 decision.

Ride-critical order, unchanged from the super review: add the `boot()`
timeout first, then move the cue engine (~285 Nav lines) and geometry
(~150 lines) into `core/track/`.

### 2.4 Where the super review is now wrong

1. "Plan calls only `/status` and `/cookies`" (§4.5). Plan calls neither.
   `StravaConnect.tsx` was never mounted; the only client of `/cookies` is
   the Chrome extension, and `/status` has none.
2. "Three static servers" (§4.6). There are four: `tools/perf/serve.mjs`
   came later, and it already is the single server the review asked for.
3. The Strava proxy dead code is ~185 lines, not ~130.

## 3. Bugs found on the way

| # | Where | Defect | Effect | Fix | Confidence |
|---|---|---|---|---|---|
| 1 | `apps/nav/sw.js:52-58`, `tools/assemble-app.sh:80-83` | Sidecars (`corridor.js`, `tracklock.js`, `gmaps-link.js`, `vendor/*`, `basemap/layers*.json`) are cache-first, and the cache-name hash does not cover them | A deploy that changes `tracklock.js` without a manual `vN` bump gives riders the new `index.html` with the old `tracklock.js`, offline, until a later bump | Hash the whole artefact (§1) | high |
| 2 | `apps/nav/sw.js:45` | The navigation fetch has no timeout | On a weak signal the rider sees a blank screen until the fetch fails | Race the fetch against ~3 s, then `caches.match` | medium |
| 3 | `core/rust/cli/src/dedupe_plans.rs:245` | The supersede `UPDATE` clears `exported_path` before it moves the file | With no `--dest` (`main.rs:701-704`), every superseded plan's GPX stays in the library with no row that points to it | Use the order from `dedupe_rides.rs:243-276` | high |
| 4 | `apps/site/lib/publish-auth.ts:30` | `userForToken(...).catch(() => null)` | A database outage shows "Invalid or revoked API token" in Plan, and no outage alert is mailed | Remove the `.catch` (or §1 item 16) | high |
| 5 | `apps/site/lib/tokens.ts:97-106` | A failed role lookup for an API token returns role "user"; the cookie path throws on purpose | A trusted user who publishes "public" during a DB blip gets "pending" | Let the error go up, so `requirePublisher` answers 503 | high |
| 6 | `core/rust/daemon/src/lib.rs:41-54` | The CORS list has no port 8139, which dingoctl uses for Studio | Studio's style editor (`GET`/`PUT /api/styles`) fails when started from dingoctl | §1 item 17, or add 8139 | high (code), not run |
| 7 | `apps/site/lib/packs.ts:134,172` | Reads `currentVersion`, then inserts `version + 1`; no unique `(pack_id, version)` | Two refreshes at the same time can both write vN+1 | Unique index, or `UPDATE … RETURNING` in a transaction | medium |

Also from the baseline and still open: `boot()` waits on `ddCoreReady` with no
timeout (`apps/nav/index.html:8534`).

## 4. Decisions only the owner can make

These block the largest removals. They are the super review's Phase 0, with
the new evidence above.

| # | Decision | Blocks | New evidence |
|---|---|---|---|
| 1 | Plan hosting: local app only, or hosted | Two deploy configs, three basemap systems | — |
| 2 | Satellite source for Plan | Basemap collapse (~1,700 lines + 39 KB JSON), Studio "Plan styles" (~1,000 lines) | The site already uses ESRI World Imagery with no key |
| 3 | Host for gmaps and closures | ~1,100 Rust lines | — |
| 4 | Studio keeps committed tiles or not | 41 MB + 8.7 MB in git | `dev-tile-server.js` defaults to these files |
| 5 | Nav demo or Studio `#demo` | ~310 Nav lines | Nav's training ride is the onboarding flow |
| 6 | Are bootstrap imports finished? | `dry_run.rs` (588 lines) | — |
| 7 | Are label rename/delete planned? | ~195 lines of endpoints with no client | — |
