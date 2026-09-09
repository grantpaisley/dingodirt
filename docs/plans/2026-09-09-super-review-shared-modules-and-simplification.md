# Super review — shared modules across Plan, Site and Nav, and radical simplification

*2026-09-09. A full-codebase review at HEAD `1b8cd1d`. Two questions were asked:
which code should be one shared module across Plan, the site and Nav, and where
can the whole repo be radically simplified. Every claim below carries a
`file:line` reference into that commit. Nothing was changed; this is the
scoping document that the branch-per-topic work would follow.*

## 0. Verdict

The repo is not mostly duplication. About 66,000 lines of app and crate code
carry roughly 3,000 lines of true copies. A further 7,000 lines of code,
schema and documentation exist only because a decision was never closed or a
migration was never finished. The biggest simplifications are therefore
decisions first and refactors second.

Three decisions drive most of the waste:

1. **Plan is a local app that is deployed as a static site.** Every data call
   in Plan goes to `http://localhost:3000` (`apps/plan/src/api/hooks.ts:7`),
   yet `deploy.yml` publishes it to GitHub Pages and the README describes a
   "Macca" who runs harvest and pack builds in the browser against his own
   database. That in-browser core is "explicitly out of scope" in
   `docs/plans/dingo-2026-08-05-dingodirt-monorepo-migration.md:132`, and
   `docs/plans/2026-08-06-plan-publish-to-dingodirt-design.md` says "Plan stays
   a local app". Until this is settled, Plan keeps two deploy configs, three
   basemap systems and a persona line that the code does not implement.
2. **Anything a phone must reach lives on the site, so the daemon copies are
   the ones to delete.** Nav cannot call a private daemon, which is why
   `apps/site/lib/gmaps.ts` and `apps/site/app/api/closures/route.ts` exist as
   TypeScript ports of `core/rust/google/src/maps.rs` and
   `core/rust/daemon/src/routes/closures.rs`. Two live implementations of each
   feature, two API keys, and a "shared fixtures" claim that is maintained by
   hand.
3. **`core/` is consumed four different ways.** Nav and Studio symlink, Plan
   imports by path, the site copies at prebuild (`apps/site/scripts/sync-core.mjs`),
   and Rust output formats are re-typed by hand in every JavaScript reader. The
   symlink rationale is right for static assets and stale for modules: the
   site's Turbopack root already spans the monorepo (`apps/site/next.config.ts:9-13`)
   and Nav has loaded the core appliers as ES modules since 2026-08-14
   (`apps/nav/index.html:1163-1173`, `tests/no-applier-copies.test.mjs`).

The ten moves with the best value for risk, in the order they should land:

| # | Move | Lines out (approx.) | Risk |
|---|---|---|---|
| 1 | Delete the pre-monorepo documentation root `docs/dingo/`, the Vite template leftovers in Plan, Nav's four Python scripts, the create-next-app SVGs, and the dead exports listed in §4 | 4,500 | none |
| 2 | Collapse Plan to the shared Dingo basemap: remove MapTiler built-ins, local styles, the night remap, `routes/styles.rs`, and Studio's "Plan styles" workspace | 1,700 + 39 KB JSON | satellite imagery in Plan needs a replacement source |
| 3 | One `core/vendor/` for MapLibre, PMTiles and fflate; one static server; one `build-tiles/` | 2 MB of binaries, 100 lines | low |
| 4 | Pack and plan-document contract in `core/formats/`: `.d.ts` plus JSON fixtures the Rust writer tests against | 150 lines, and the drift channel closes | low |
| 5 | `core/track/`: geometry, GPX parsing, and the cue engine, authored from Nav's superset and imported by Studio and the Nav sidecars | 950 | Nav's precache list and `boot()` handshake need a timeout first |
| 6 | Registries into `core/appliers/`: the behaviour registry (from Studio), the POI and mark category table (five copies), and a Dingo style skeleton builder (four copies) | 400 | low |
| 7 | One gmaps and one closures implementation, hosted on the site, with the daemon calling the site | 1,100 Rust | Plan's local import then depends on the public site |
| 8 | One token vocabulary: drop the alias layers in Plan, Studio, Nav and the site's literal palette | 300 lines, 40 KB of hex | contrast test must be re-pointed; screenshot proof per app |
| 9 | Plan internals: a typed API client and generic hooks; MapView split along its existing seams | 400 net, 1,900 moved | handler binding discipline in MapView |
| 10 | Rust and server: drop the dead segment schema and squash 58 migrations; move `routes/export.rs` logic into the export crate; one `ApiError` and `AppState`; one post-ingest pipeline for the CLI; dead crate, dead workspace block, twelve unused dependencies, and a committed `.sqlx/` cache so CI compiles without a database | 1,900 deleted, 2,250 moved | existing databases need an explicit migration reset |

## 1. The shape of the repo today

Code lines exclude `node_modules`, `vendor/`, `dist/`, `target/` and `public/`.

| Area | Files | Code lines | Notes |
|---|---|---|---|
| `apps/nav` | 21 | 9,914 | `index.html` is 8,648 lines, 395 top-level functions, 240 `getElementById` calls |
| `apps/plan` | 52 | 15,711 | `MapView.tsx` 2,696; `api/hooks.ts` 1,708; `App.css` 1,478; `store.ts` 1,033 |
| `apps/site` | 81 | 7,841 | `app/p/[token]/PlanView.tsx` 1,722 |
| `apps/studio` | 26 | 4,577 | plus 41 MB of committed `.pmtiles` and sample data |
| `core/rust` | 107 | 28,075 | `daemon/src/routes/export.rs` 2,897; `routes/rides.rs` 1,631; `cli/src/main.rs` 1,599 |
| `core/ui`, `core/track-graph`, `core/appliers` | 20 | 1,400 | the shared vocabulary that exists today |
| `server` | 76 | 349 | 58 SQL migrations |
| `tools` | 25 | 1,358 | `dingoctl` 886 of them |
| `tests` | 7 | 732 | |
| `docs` | 70 | 11,500 | `docs/plans` 52 files, 7,679 lines; `docs/dingo` 13 files, 3,882 lines; `docs/ecosystem.html` 906 |

Churn over the last 120 days: 50 commits, and `apps/nav/index.html` is in 20 of
them, `apps/nav/sw.js` in 8. Nav is where the work goes and where every change
lands in one file.

The largest tracked files are not code. `apps/studio/basemap/central-coast.pmtiles`
(33 MB), `apps/studio/sample-data/heatmap-central-coast.geojson` (8.5 MB),
`apps/studio/basemap/hillshade.pmtiles` (8 MB), three byte-identical copies of
`maplibre-gl.js` (1 MB each, in `apps/nav/vendor`, `apps/studio/vendor`,
`apps/site/public/vendor`), and `core/rust/samples/*.gpx` (1.2 MB).

## 2. The decisions that generate the duplication

### 2.1 Plan: local app, static deploy, in-browser persona

- `apps/plan/src/api/hooks.ts:7` hard-codes `SERVER_BASE` to
  `http://localhost:3000`, and 58 fetches go through it to 52 daemon endpoints.
- `.github/workflows/deploy.yml` builds Plan with `VITE_BASE=/dingodirt/plan/`
  and publishes it to GitHub Pages. `.github/pages-index.html` admits "Needs a
  backend". `apps/plan/vercel.json` also exists, with SPA rewrites, and no
  document mentions a Vercel deployment of Plan.
- `README.md:24-28` describes Macca as running harvest, heatmap and pack
  builds in the browser against Neon or Supabase. No such path exists: there is
  no WASM target, no BYO wizard, and the Rust crates are native only.
- The consequence is that Plan carries three basemap systems (MapTiler
  built-ins with a shipped key at `apps/plan/src/mapStyles.ts:17`, a "local
  styles" manifest with key substitution at `mapStyles.ts:25-105`, and the
  shared Dingo basemap at `apps/plan/src/dingoBasemap.ts`), a night-mode remap
  that nothing can switch on (no caller of `setBaseStyleMode`,
  `apps/plan/src/store.ts:413`), and a daemon style editor
  (`core/rust/daemon/src/routes/styles.rs`, 212 lines) whose default path
  `./web/public/styles` (`core/rust/core/src/config.rs:48`) is a pre-monorepo
  location, so the endpoint answers 501 unless `DINGO_WEB_STYLES_PATH` is set.

**Decision to take:** either Plan is local-only (stop deploying it to Pages,
delete `vercel.json`, rewrite the Macca paragraph as a future programme) or the
in-browser core is the next programme and everything below waits for it. The
review recommends the first: it matches every design document since 2026-08-06
and it unlocks §4.1 immediately.

### 2.2 Two planning UIs, two renderers

`apps/plan` draws with deck.gl layers over MapLibre; the share page
`apps/site/app/p/[token]/PlanView.tsx` draws with native MapLibre GeoJSON
layers, loading a vendored MapLibre at runtime because the npm build's worker
URLs 404 under Turbopack (`PlanView.tsx:40-43`). About 600 of PlanView's 1,722
lines are map concerns Plan also implements, but only about 125 are portable
line for line (the POI and closure cards, `PlanView.tsx:1573-1667` against
`MapView.tsx:2255-2405`, plus `CLOSURE_COLORS` and the category fallback rule).
The rest is the same picture through a different engine. Sharing it would mean
giving the site deck.gl (1.5 MB more) or giving Plan MapLibre line layers.
Neither is a shared-module win, and `docs/plans/2026-08-09-ui-shared-library-design.md:9`
already ruled out an npm package. Leave the renderers alone; share the data
contract and the registries (§3).

### 2.3 The daemon cannot be reached from a phone

Nav calls the site for Google Maps links (`apps/nav/index.html:5343`,
`:5657`), and the share page calls the site for closures. Plan calls the daemon
for both (`hooks.ts:847`, `useClosures`). So each feature has two production
implementations:

| Feature | Site | Daemon | Shared |
|---|---|---|---|
| Google Maps link to GPX | `apps/site/lib/gmaps.ts` (276) and `app/api/routes/gmaps/route.ts` (84) | `core/rust/google/src/maps.rs` (364) and `daemon/src/routes/import.rs:295-370` | about 200 lines are 1:1; error strings verbatim; the Rust side has no test for `is_gmaps_host` |
| Road closures | `app/api/closures/route.ts` (298) | `daemon/src/routes/closures.rs` (446) | same upstream URLs, same decode and filter set; different relevance filter (bbox vs PostGIS distance) |

The site also has two polyline decoders (`gmaps.ts:213` lat-first,
`closures/route.ts:46` lon-first), and the daemon two as well.

**Decision to take:** the site is the only host both consumers can reach, so
the site's TypeScript is the copy that must exist. The daemon's `import_gmaps`
can fetch the GPX from `dingodirt.com/api/routes/gmaps` through the client it
already has in `routes/dingodirt.rs`, and `maps.rs` goes. Closures are the same
shape but the 29 MB VicTraffic pull inside a 60-second Vercel function
(`closures/route.ts:19`) is the fragile link, so decide the host before merging
the code. If the daemon must stay the host for closures, nothing can be shared
there and the honest minimum is one fixture file both suites read.

### 2.4 Nav deploys twice, once from an archived repo

`deploy.yml:12-18` records that the canonical `nav.dingodirt.com` is built by
a mirror workflow inside the old DingoNav repository, which checks this repo
out and runs the same assembly. This repo also publishes Nav to
`grantpaisley.github.io/dingodirt/nav/`. Two pipelines for the safety-critical
app, and the one that riders install lives outside this repo's CI gate. Bring
the Pages deployment for `nav.dingodirt.com` into this repo (a custom domain on
this repo's Pages site, or a second Pages workflow here) and archive the
mirror.

### 2.5 Four ways to consume `core/`

| Consumer | Mechanism | Right for | Wrong for |
|---|---|---|---|
| Nav, Studio | symlinks, dereferenced by `tools/assemble-app.sh` | static assets that must be precached | nothing; this is the right shape |
| Plan | relative imports (`dingoBasemap.ts:23-26`) and `public/` symlinks | modules and assets | nothing |
| Site | `scripts/sync-core.mjs` copies appliers to `lib/core` and assets to `public/basemap` on every dev and build | `public/basemap` (runtime static files) | the JS half: Turbopack already bundles `../../../../../core/ui/tokens.css` from `PlanView.tsx:25`, so it would bundle the appliers too. `GO-LIVE.md:76` still says "the build does not need `core/`", which is now false twice over |
| Site and Nav readers of Rust output | hand-typed shapes | nothing | `.dingonav`, `.dingoplan`, the mark-kind enum and the POI table are each written once in Rust and re-typed two to four times in JavaScript |

## 3. The shared modules that should exist

The rule in `CONTRIBUTING.md` is right: grow the shared vocabulary in `core/`
first. Today `core/` holds schemes, behaviours, three applier modules, the UI
tokens, and the track graph. The table below is the complete list of what else
is duplicated across Plan, the site and Nav, with the proposed home.

| Module | Copies today | Proposed home | Lines out | Risk |
|---|---|---|---|---|
| **Dingo style skeleton** (`pmtiles://` source, glyphs, sprite, `applyBaseOverrides`, `applyDetailBias`) | `apps/site/app/p/[token]/dingoStyle.ts` (69); `apps/plan/src/dingoBasemap.ts` (119); `apps/studio/js/navview.js:50-70`; `apps/nav/index.html:2320-2360` | `core/appliers/dingo-style.js` + `.d.ts`; pure function of layer JSON, asset base, tiles base, resolved scheme, detail level, flavour | 150 | Nav's builder also folds in hillshade, overlays and tile overrides; keep the shared function a skeleton with everything injected. None of the four has a test; add one fixture test first |
| **POI and mark category registry** (label, colour, priority, glyph name, mark-kind aliases) | `apps/site/app/p/[token]/pinIcons.ts:113-171`; `apps/plan/src/components/Map/poiIcons.ts:30-42`; `apps/plan/src/store.ts:39`; `apps/nav/index.html:2148-2162` (`MARKS`); `core/rust/daemon/src/routes/packs.rs:816-829` | `core/appliers/categories.js`; the site's Path2D badge drawer (`pinIcons.ts:176-232`, no React, no lucide) can also feed Plan's `IconLayer` atlas and retire `poiIcons.ts:56-106` | 180 | Nav's `MARKS` colours are a deliberate riding palette; share kinds and glyph names, not necessarily colours. Rust's `mark_display` stays unless generated from the registry |
| **Behaviour registry** | `apps/studio/js/behavior.js` (190) is the only registry not in `core/`; Nav re-derives thresholds in `VEHICLES` (`index.html:3620-3629`) and `ADV_D` (`:1391-1415`) and validates with a weaker `validSchemaFile` (`:7960-7965`) | `core/appliers/behavior.js`, sibling of `scheme.js`; Nav calls `validateScheme` and `validateBehavior` | 10 in Nav, 190 relocated | Forces reconciliation of registry defaults with Nav's truth: `camera.followMode` defaults to `courseUp`, which Nav retired 2026-08-14 (`index.html:7936`); `camera.pitch` 0 vs Nav 55; `adventure` off/on 50/30 has no home; the zoom-curve speed axis is dropped by `applyBehaviorSettings` (`:7950-7957`) |
| **Track geometry and GPX** (`toXY`, `toLL`, `dist`, `bearing`, `angDiff`, `parseGPX`, `processTrack`, `nearestOnTrack`, `idxAt`, `processHeatmap`, `heatGrid`) | `apps/nav/index.html:1289-1303` and `:1594-1796`; `apps/studio/js/geom.js` (158, the 2-tuple subset with no elevation); partial re-implementations in `apps/nav/corridor.js:24-43`, `tracklock.js:52-74`, `gmaps-link.js:18-43`; `core/track-graph/graph.js:57-72,321-332`; `apps/plan/src/components/Map/MapView.tsx:238-242`; `GraphPane.tsx:120-127` | `core/track/geom.js`, `core/track/gpx.js`, authored from Nav's superset; `REF` becomes module-private with `setRef`/`resetRef` (Nav never resets it today, `index.html:1296`) | 300 verbatim, 31 primitive sites in 9 files reduced to one | Nav uses these as bare globals (`nearestOnTrack` has 15 refs); extend the `ddCore` pattern; every new file joins `sw.js` SHELL and the `assemble-app.sh` hash set |
| **Cue engine** (MVT decode, corridor decode, way match, classify) | `apps/nav/index.html:1797-2081` (285); `apps/studio/js/cues.js:13-262` (254): `diff -w` differs only in stripped comments | `core/track/cues.js`; Nav keeps the IDB cache and overlay wrapper (`:2082-2123`) | 250 | Same precache discipline as above. `boot()` awaits `ddCoreReady` at `index.html:8477` with no timeout, so a module missed by the precache hangs an offline boot. Add a timeout and a toast before adding modules |
| **Pack and plan-document contract** | `.dingonav` written at `core/rust/daemon/src/routes/export.rs:552-559`, `:747-766`, `:2650-2700`; read by `apps/nav/index.html:5357-5437` and `:5532-5615`, `apps/site/lib/validate-pack.ts:57-101`, `apps/studio/js/editor.js:288-292`. `.dingoplan` written at `packs.rs:544-753`; read by `validate-pack.ts:112-160` and `PlanView.tsx:70-124`. The extension-to-type map appears in nine site files (`validate-pack.ts:39-46`, `lib/packs.ts:139-145`, `api/packs/[token]/download/route.ts:46-55`, `api/packs/upload/route.ts:13`, `api/packs/route.ts:19`, `db/schema.ts:113`, `components/PublishForm.tsx:64,70`, `components/GalleryPage.tsx:13`) and in `routes/dingodirt.rs:204-350` | `core/formats/`: `pack.d.ts`, `plan-doc.d.ts`, `extensions.js`, and JSON fixtures that a Rust test writes and the site and Nav tests read | 150, and the drift channel closes | Low. Note `validate-pack.ts` never checks `strava-*/` entries, and `upload/route.ts:34` still names only two extensions |
| **Google Maps link import** | see §2.3 | the site's `lib/gmaps.ts`; the daemon proxies | 380 Rust | Plan's local import depends on the public site and its 10 per hour per IP limit (`route.ts:29`) |
| **Road closures** | see §2.3 | the site's route, if the site can host the VicTraffic pull reliably | 400 Rust | decide the host first |
| **Vendored libraries** | three identical `maplibre-gl.js` v5.24.0; `pmtiles.js` and `fflate.js` twice; Plan on npm MapLibre 5.15; the site declares npm `maplibre-gl ^6.2.0` but imports it only as types (`PlanView.tsx:22`, `dingoStyle.ts:7`), so six `as unknown as` casts paper over v6 types on a v5 runtime | `core/vendor/` symlinked by Nav and Studio, copied to `apps/site/public/vendor` by the same prebuild step that copies basemap assets; site's `maplibre-gl` becomes a devDependency at the vendored version | 2 MB of tracked binaries | low |
| **UI tokens** | `core/ui/tokens.css` is the source everywhere, but three apps wrap it in alias layers and one re-literalises it: Plan `App.css:1-13` (8 aliases, 139 uses); Studio `index.html:15-19` (7 aliases); Nav `index.html:20-25` (9 CSS aliases, 254 uses) plus a JavaScript bridge the other way in `mountScheme` (`:7873-7893`); the site `app/globals.css:3-13` (9 hex literals, byte-equal to the tokens) plus a fourth copy in `docs/ecosystem.html:5-8` | one vocabulary, `--dd-*`, in all four apps; `applierPlan.ts` writes `--dd-*` directly or reuses `applier-nav.js cssVars` (`core/appliers/applier-nav.js:100-111`) | 300 lines, 40 KB of hex | `tests/contrast.test.mjs:127` parses Plan's alias block by selector and must be re-pointed; light-mode flip via `data-mode` needs the ui sweep re-run |

Two things that look shareable and are not:

- The PlanView and MapView map layers (§2.2).
- `tools/contrast.mjs` and `tools/ui-sweep/contrast-dom.mjs`: the second imports
  `contrastRatio` from the first (`contrast-dom.mjs:8`); the ten repeated lines
  are alpha compositing that a page function must carry inline.

## 4. Radical simplification, by area

### 4.1 Plan (`apps/plan`, 15,711 lines)

**Collapse to the shared basemap.** Once §2.1 is decided, delete:
`apps/plan/src/mapStyles.ts` except about 15 lines; `components/Map/styleAttrs.ts`
(104, a TypeScript port of `apps/studio/js/styleattrs.js`, whose header says
so); `public/styles/dingo-topo.json` (38.7 KB) and `index.json`; the
`baseStyle*`, `styleReloadNonce`, `styleOverlays` keys in the store; the
style-swap effect and non-builtin init branch in `MapView.tsx:1590-1624`; the
toolbar rows at `MapToolbar.tsx:79-81`, `:160`, `:475-478`; the daemon's
`routes/styles.rs` and `web_styles_path`; and then Studio's "Plan styles"
workspace (`styleinspector.js` 635, `styleattrs.js` 363, about 100 lines of
CSS in `apps/studio/index.html`, `main.js:49-71`). About 1,700 lines. Hillshade
and 3D terrain still fetch MapTiler `terrain-rgb-v2` (`MapView.tsx:139-140`);
Nav already reads the shared `hillshade-au.pmtiles` (`apps/nav/index.html:1439`),
so Plan can switch and lose its last MapTiler dependency. The one product
question is satellite: MapTiler hybrid is Plan's only satellite base, and packs
already use ESRI World Imagery, which could stand in. `README.md:26`'s
"optional MapTiler key" line changes with it.

**Dead code, verified by grep with zero callers outside the defining file:**

- `api/hooks.ts`: `useRidePoints`, `deleteFolder`, `fetchRideIdsByLocation`,
  `exportShare` and `ShareResult` (the gist flow replaced by the 2026-08-06
  publish; the daemon still routes it at `routes/export.rs:44-45`). About 70
  lines, plus the two daemon routes.
- `store.ts`: `ownersOff` and `toggleOwnerOff` (`:229`); `toggleShowRides`,
  `toggleMyRides`, `toggleOtherRides`, `toggleTrackClass`, so `showRides` and
  `trackClasses` can never change after the `pillsMigration2026` reset
  (`:547-551`); `setBaseStyleMode`, so every `mode === 'night'` branch in Plan
  is unreachable (`mapStyles.ts:135-142,163-172`, `styleAttrs.ts:45-92`, the
  `'night'` argument of `buildDingoStyle`). One inconsistency: an invalid
  `baseStyle` falls back to `'satellite'` (`:530`) while the default is
  `'dingo'` (`:337`).
- `package.json`: `@deck.gl/react` has no import.
- Template leftovers: `README.md` is the verbatim Vite template;
  `src/index.css` (68 lines of `#242424`, `#646cff`, `body{display:flex;place-items:center}`)
  is still imported before `App.css`; `src/assets/react.svg` and
  `public/vite.svg` are unreferenced.

**`api/hooks.ts` (1,708 lines).** 53 types (about 450 lines), 26 hooks, 44
fetchers, 58 `fetch(` calls, 57 identical `if (!res.ok) throw` lines, 28
identical header objects, three copy-pasted blob-download blocks (`:1008`,
`:1215`, `:1256`). No typed client and no `useMutation` anywhere: components
call a fetcher and then hand-write `invalidateQueries`, 59 such lines across 6
files, 42 of them in `components/Detail/DetailPane.tsx` (`:470-477`,
`:520-524`, `:539-542`, `:911-913`), each cluster re-deciding which of
`rides`, `allRideMeta`, `rideLocations`, `ride`, `heatmap`, `items`,
`folders`, `labels` to bust. A 15-line `api<T>(path, init)`, an 8-line
`useGet<T>(key, path, opts)`, and a `useApiMutation(fn, invalidates)` over one
central endpoint-to-keys map replaces about 300 lines of boilerplate and 50 of
the 59 invalidation lines, and makes the invalidation set consistent. Escape
hatches are needed for `updateRide` (reads `statusText`) and the downloads that
read the `x-dingo-manifest` header.

**`store.ts` (1,033 lines).** Three slices (`useSettings` with 47 keys and 45
setters plus a 150-line migration block at `:430-585`; `useBasket`;
`useUiState` with 13 keys) and about 340 lines of pure helpers that are not
state (`PALETTES` and colour scales `:90-130`, `effectiveLayerState`
`:740-840`, `rideMatchesSearch` and `rideMatchesFilters` `:880-960`,
`scaleColor` and gradient CSS `:965-1033`). Move the helpers to
`colourScales.ts` and `rideFilters.ts`; move component-local keys
(`placesOpen`, `placesActive` read only by `PlacesTree.tsx:31`; `facetLabels`
read only by `PillRow.tsx`) into their components.

**`MapView.tsx` (2,696 lines).** 15 effects, 11 memos, 24 states, 27 refs, 22
deck layers, 56 inline style objects. The seams already exist
(`heatmapLayers.ts`, `maskGeometry.ts`, `styleZoom.ts`, `poiIcons.ts`,
`useTrackGraph.ts`). Extract along them: `mapExtras.ts` (about 200 lines,
`:1394-1590`, pure functions of the map and a settings snapshot); per-family
layer builders (`:757-1300`, 543 lines, so `getLayers` becomes 60 lines of
composition); `rideGeometry.ts` (chevrons, grades, gradient segments,
`:225-303`, `:630-699`); `useAutoZoom`, `useLasso`, `useDrawMeasure`
(`:1300-1394`, `:1943-2099`); and the card, HUD and legend components
(`:2099-2696`, about 600 lines of JSX). MapView ends near 750 lines. The one
discipline to keep: handlers are bound once at init (`:1787-1943`) and read
`*Ref` mirrors, so hooks must not close over stale state.

**Tests.** Plan has zero unit tests. CI coverage is `tsc -b && vite build`, a
`dist/schemes` symlink assertion, and one Playwright contrast test with the
daemon aborted. The pure code above (the store migration, `rideMatchesFilters`,
`scaleColor`, `effectiveLayerState`, `maskGeometry`, `heatmapLayers`) is where
tests are cheap and would have caught the dead-setter drift. Neither Plan's
nor the site's `lint` script runs in CI.

### 4.2 Site (`apps/site`, 7,841 lines)

- Delete the JavaScript half of `scripts/sync-core.mjs`; import
  `core/appliers/*.js` directly from `dingoStyle.ts` (the Turbopack root permits
  it). Keep only the `public/basemap` copy. Fix `GO-LIVE.md:76`.
- Rewrite `app/globals.css:3-13` as aliases of `--dd-*` with `tokens.css`
  imported once in `layout.tsx` rather than in `PlanView.tsx:25-26`. Today
  `core/ui` is page-local to `/p/[token]`; the marketing pages carry their own
  palette. `#c96a5a` at `PlanView.tsx:1345,1487,1532` matches no token.
- `maplibre-gl` moves to `devDependencies` at the vendored version, or the
  vendoring goes once the worker-URL problem is solved another way.
- Delete `public/{file,globe,next,vercel,window}.svg` (create-next-app
  defaults, zero references). Every runtime dependency is imported somewhere;
  none is dead.
- Over-exported: `pinIcons.ts` exports `drawPin`, `pinImageId`,
  `PIN_PIXEL_RATIO`, `PinCategoryMeta` used only internally, and
  `PlanView.tsx:838` hard-codes `"pin-"` instead of calling `pinImageId`.
- Stale text: `README.md:6-8` points at `Docs/plans/` in "the Dingo repo";
  `sync-core.mjs:2-4`; `api/packs/upload/route.ts:34`.

### 4.3 Nav (`apps/nav`, 9,914 lines)

The "one file" story is already false in a useful way. `index.html` is one
HTML file plus three classic sidecars (`corridor.js`, `tracklock.js`,
`gmaps-link.js`), three ES modules from `core/appliers`, and three CSS files
from `core/ui`, all precached by `sw.js` and hashed into the cache name by
`assemble-app.sh:69-79`. The real constraint is "no build step, everything
precached", and that constraint allows every extraction below.

**Where the 7,473 script lines go.** Verbatim duplication with Studio is about
600 lines (430 byte-identical modulo comments), all in pure-logic sections with
no DOM coupling: the cue engine (`:1797-2081`), geometry and track processing
(`:1289-1303`, `:1594-1796`), the `MARKS` table (`:2148-2162`), the demo feed
(`:4971-4988` equals `apps/studio/js/replay.js:75-91`), and the IDB wrapper.
The rest is feature weight, not copies:

| Section | Lines | Share of script |
|---|---|---|
| Stark Varg BLE telemetry (`:6302-7504`, plus CSS `:76-144`) | 1,202 | 16% |
| MapLibre style, init, overlays, refresh (`:2247-2929`) | 682 | 9% |
| files, packs, share links, gmaps import (`:5338-5771`) | 433 | 6% |
| editable layout and new-version prompt (`:8073-8468`) | 395 | 5% |
| demo mode and training ride (`:4942-5269`) | 327 | 4% |
| cue engine (`:1797-2124`) | 327 | 4% |
| settings registry and renderer (`:7504-7823`) | 319 | 4% |
| panel, list, bottom bar, track picker (`:5771-6098`) | 327 | 4% |

**Extractions that need no build step.** The Varg block is the single largest
lever for making `index.html` readable, and it is not duplication. It is
interleaved through the whole file (578 mentions from `:1310` to `:8088`) but
its telemetry core is a self-contained section. Move it to a `varg.js`
sidecar in the `corridor.js` pattern, behind the same `window` shim, and add it
to `sw.js` SHELL. The cue engine and geometry go to `core/track/` (§3), which
also lets `corridor.js`, `tracklock.js` and `gmaps-link.js` stop carrying
their own `bearing`, `angDiff`, `toXY` and point-to-segment copies (they
re-implement them only because a classic script cannot import from
`index.html`).

**Remnants of the old inline applier.** `buildStyle` at `:2337-2344`
re-implements `applyBaseOverrides` instead of calling
`ddCore.applyBaseOverrides` (7 lines, byte-equivalent). `validSchemaFile` at
`:7960-7965` checks only the major version, so the "a bad value must never
brick Nav" rule in `core/appliers/scheme.js:132` does not hold in Nav.
`ADV_D.colCrumb: '#ff2d2d'` (`:1414`) still differs from the registry's
`overlays.breadcrumb` `#9fb4c6` (`scheme.js:51`), the exact drift that
`:7858-7860` says the unification ended.

**CSS (780 lines).** Nav redefines none of the 35 `tokens.css` names, but
declares 13 legacy properties, nine of them aliases (`:20-25`), used 254 times
against 13 direct `--dd-*` uses. It uses 2 of `chrome.css`'s 11 component
classes and keeps its own `.ctl`, `.tile`, `.row`, `.btn`, `.card`, `.pill`,
`.seg`. The daymode block at `:480-575` (96 lines, 12 with hard-coded colours)
is, by its own comment at `:487-490`, mostly redundant now that
`data-mode="light"` flips the tokens. About 120 to 150 lines can go with
screenshot proof per day, night, scheme and glove state.

**Dead weight.** `make_bundle.py` (its docstring still says "TrailNav" and it
writes the v1 shape `export.rs` superseded), `make_hillshade.py` (its successor
names itself at `server/tools/build-tiles/build-hillshade.py:4`),
`merge_hillshade.py`, `make_icons.py`: 294 lines, invoked by no CI, deploy,
tool or package script. `markSpot` (`:4653-4661`) has zero callers. Stale prose
in `README.md:45-61` (the pre-cue-engine alerts, the old beep grammar, flat
60 m off-track), `README.md:68-70` and `:86` (the Python scripts, a
`Dingo/tools/build-tiles/` path), `CONTRIBUTING.md:30-35` and `:66`, the
headers of `core/appliers/applier-nav.js:4-9` and `detail.js:3-4`, and
`index.html:7834-7835`, all of which describe the inline applier that
`tests/no-applier-copies.test.mjs` forbids.

**The two hazards to fix before extracting anything.** `boot()` awaits
`ddCoreReady` at `:8477` with no timeout or fallback: a module missing from the
precache hangs an offline boot. Add a timeout and a visible toast first.
`REF` (`:1296`) is set once and never reset, so a pack from another region
keeps a stale projection anchor; Studio's `geom.js:11-14` warns about exactly
this and added `resetRef`.

**Product surface.** `apps/nav/docs/settings-reference.md` lists 110 settings
rows across three tiers, including an Advanced tab with per-row reset and a
config export. That is a product question, not a code one, but it is where a
large fraction of the 395 functions come from, and no test covers any of the
8,648 lines (the three suites cover only the sidecars).

### 4.4 Studio (`apps/studio`, 4,577 lines plus 41 MB)

- Studio is the only app that does not read `tiles.dingodirt.com`
  (`tools/build-tiles/README.md` calls it "the exception"). It loads a 33 MB
  `central-coast.pmtiles` and an 8 MB `hillshade.pmtiles` committed to git
  (`apps/studio/js/navview.js:41-43`). Point it at the shared archive with the
  same corridor prefetch Nav uses and drop 41 MB from the repository, or move
  the archives to R2 and fetch them. The 8.5 MB sample heatmap is the same
  question.
- Once Plan renders only the shared basemap (§4.1), the "Plan styles"
  workspace (about 1,100 lines) has no consumer.
- After `core/track/` exists, `geom.js` (158) and the algorithm half of
  `cues.js` (254) become imports. `behavior.js` (190) moves to
  `core/appliers/`. `idb.js` (19) is the subset of Nav's wrapper.
- Studio's test-drive drifts from Nav in three known places: off-track is a
  bare `near.d > offM` (`navview.js:565`) where Nav uses `DingoTrackLock`
  with an accuracy guard and a 2-second hold (`index.html:3941-3944`); the beep
  grammar hard-codes 460 and 990 Hz with different pip spacing
  (`navview.js:75-97` against `index.html:2191-2233`); confirm distance is a
  fixed 30 m against Nav's `departDist`. Sharing the guidance state machine
  (`navFix` and `BEEP`) would fix this but touches the ride-critical path; do
  it last and only if test-drive fidelity is a goal.
- Studio's `#demo` was meant to replace Nav's demo mode
  (`apps/studio/README.md`), and Nav still has a full demo and training ride
  (`index.html:4942-5269`). Decide which one lives.

### 4.5 Rust and server

The workspace is 28,075 lines across ten crates. Only one crate is orphaned,
and only one of the largest files is a real duplicate of another. The weight
is in three places: business logic that lives in axum handlers instead of the
crates, a migration history that carries a schema nothing reads, and a CLI
that re-implements the crates' pipelines.

**Crate graph.** `core` 870, `geo` 2,075, `ingest` 3,601, `enrich` 2,085,
`export` 1,999, `harvest` 1,576, `google` 1,187, `daemon` 10,683, `cli` 3,998.
`vision` is a single doc comment with no dependencies and no dependents
(`core/rust/vision/src/lib.rs`). The `[workspace.dependencies]` block for
internal crates at `core/rust/Cargo.toml:92-100` points at `crates/core` and
so on, a directory that does not exist; every crate uses `path = "../x"`
instead, so the block is dead. `lancedb` and `ort` at `:69-70` are pinned and
unused, as their comment says. `ingest` declares `dingo_geo` and uses none of
it, re-implementing haversine at `ingest/src/dry_run.rs:317`. Twelve
dependency entries have zero references: `core` `anyhow`; `geo` `thiserror`,
`geo`; `ingest` `tokio`, `dingo_geo`; `google` `oauth2`, `thiserror`, `tokio`
(tests only); `daemon` `thiserror`, `base64`, `tower`; plus the workspace pins.

**`daemon/src/routes/export.rs` (2,897 lines).** The export crate holds
per-ride GPX, folder bundles, heat MBTiles and `sanitize`. Everything else in
the `.dingonav` pipeline lives in the route file: bundle assembly and
`bundle.json` (`:269-816`, about 550 lines), the size estimator (`:854-1005`),
the gist publish via a `gh` shell-out (`:1098-1400`, about 300 lines, with no
remaining client for its `list_shares` counterpart), the corridor and heat SQL
with two 60-line near-identical query strings (`:1470-1560`), Protomaps
extraction and tiered merge (`:1971-2250`), ESRI fetch with a disk cache
(`:2251-2499`), the quadtree tile cutter (`:2500-2660`), and the zip writer
(`:2661-2795`). About 2,250 of 2,787 non-test lines are business logic, and
`routes/packs.rs:23,474-490` already imports `build_dingonav`, `DingoNavOpts`,
`LayerCoverage` and `HeatmapFilters` from it: it is a library that happens to
be a route file. `tile_bounds` (`:2501`) and `lon2x`/`lat2y` (`:2534-2539`,
again inside the test at `:2856-2862`) duplicate `harvest/src/tiles.rs:8,19`,
which the daemon already depends on. Three percent-encoders (`:1386`, `:2727`,
`:2745`) plus a fourth in `cli/src/privacy.rs:191`. The monorepo migration
document names harvest, heatmap, corridor and pack build as the future
in-browser core (`dingo-2026-08-05-dingodirt-monorepo-migration.md:132`); that
is impossible while they are axum handlers. Move them section by section into
the export crate: about 2,250 lines leave the daemon and 150 to 200 are deleted
outright.

**Migrations (`server/migrations`, 58 files, 1,361 lines).** Nineteen files and
329 lines (24%) create or alter `segments`, `segment_dirs`, `rematch_queue`,
`runs`, `segment_dir_stats`, `segment_dir_dingo_score`, `segment_corrections`
and `routes`, plus their enums. Segment extraction was removed on 2026-07-07
(`docs/dingo/CLAUDE.md:7-9`), and the only remaining references are an
`UPDATE runs` on an always-empty table at `geo/src/service.rs:317` and the
table list in `cli/src/bin/truncate.rs:44`. Four files are pure one-off data
operations (`backfill_runs`, `clear_runs_for_rematch`, `clear_runs_for_hr`,
`pack_revision_seed`), and five more embed backfills, including the
`resolve_ride_name` calls in `20260811000001` that must survive any rewrite.
Squashing to one or two files is safe for fresh installs under both
`sqlx::migrate!` and CI's `psql` loop (`ci.yml:139-144`). Existing databases
fail with `VersionMissing` or a checksum mismatch when files vanish, which
`tools/dingoctl/services.mjs:12-13` already documents hitting; CI never creates
`_sqlx_migrations`, so it cannot catch that mode. The safe order is a `DROP
TABLE ... CASCADE` migration for the legacy schema first, then a squash with an
explicit reset step for the owner's database. About 650 to 750 lines.

**The daemon has no error type and no state.** `ApiError = (StatusCode,
String)` is declared four times (`routes/export.rs:28`, `owners.rs:9`,
`styles.rs:15`, `import.rs:15`), imported from the export route by six modules,
and spelled inline in six more; 140 `.map_err(internal...)` calls and 29 inline
`INTERNAL_SERVER_ERROR` tuples; no `IntoResponse`. `Extension(pool)` appears 67
times and `State` never. `Config::load()` is re-parsed per request at ten sites
(`rides.rs:270,1354`, `closures.rs:68`, `styles.rs:29,56,148`, `strava.rs:321`,
`import.rs:53,322`, `lib.rs:82`) with four `"./files"` fallbacks, and six
`OnceLock<reqwest::Client>` copies exist. One error enum with `From` impls and
one `AppState { pool, config, http }` removes 250 to 350 lines and all
per-request env parsing. It touches all 19 route files, so it conflicts with
any parallel branch; do it in one quiet window.

**Configuration exists three ways.** figment `Config`
(`core/src/config.rs:30-36`); raw `std::env::var` for 13 variables outside it
(`DATABASE_URL` in `daemon/src/main.rs:36` bypasses `Config`, plus
`DINGO_BIND`, `DINGO_WEB_ORIGIN`, `DINGO_SITE_URL`, `DINGO_NAV_URL`,
`DINGO_OVERVIEW_BBOX`, `DINGO_BASEMAP_PMTILES`, `DINGO_HILLSHADE_PMTILES`,
`DINGO_HEAT_URL`, `STRAVA_HEAT_COOKIES`, `STRAVA_CLIENT_ID`,
`STRAVA_CLIENT_SECRET`, `HOME`); and two hand-rolled `.env` parsers
(`daemon/src/main.rs:9-23`, `cli/src/bin/truncate.rs:9-15`) while the `dingo`
CLI reads no `.env` at all. Port 5433 is written in five places and 3000 in
five. The CORS allowlist at `daemon/src/lib.rs:41-54` covers 5173, 5175, 8138
and 8151, while `dingoctl` runs Studio on 8139 (`services.mjs:82`), so
Studio's `/api/styles` calls are blocked unless `DINGO_WEB_ORIGIN` is set (not
runtime-verified). `server/.env.example` lists `OPEN_METEO_API_URL`,
`ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`STRAVA_EMAIL` and `STRAVA_PASSWORD`, which no Rust code reads, and its note
that the daemon does not read `.env` is backwards. `server/docker-compose.yml`
starts only the database, so the README's "Deano runs `docker compose up`"
does not start the daemon.

**The CLI (`cli/src`, 3,998 lines).** `main.rs` is 1,599 lines with zero
tests: about 490 lines of clap definitions and 1,100 lines of match arms that
are mostly `println!`. The post-ingest pipeline exists five ways, each with a
different step set: `daemon/src/routes/import.rs:265-310` (elevation, clean,
name, turns, place, harvest), `rides.rs:283-314` (clean, name),
`cli/src/organize.rs:264-290` (clean, name, export tree),
`strava_sync.rs:322-328` (clean, name), and `dingo ingest` (none, so the user
must run `clean --all`). `dedupe_plans.rs` (267) and `dedupe_rides.rs` (281)
share 132 identical lines (union-find, display-row load, grouping, report
shape, apply skeleton) and differ deliberately in pairing SQL and keeper
ranking; `merge_parts.rs:92-122,406-433` is a third copy, and it hand-writes
`INSERT INTO rides` at `:347-387` beside `ingest/src/repository.rs insert_ride`.
One real bug falls out: `dedupe_plans.rs:245` clears `exported_path` inside the
supersede `UPDATE`, before the file move, so a failed move orphans the GPX;
`dedupe_rides.rs:257-276` does it in the right order. `export_offline.rs`
duplicates about 120 lines of the export crate (the merged-heatmap loop at
`:197-246` against `export/src/lib.rs:749-803`, `plan_path` against
`bundle_path`). Parametrise one pipeline and one cluster-and-shelve skeleton
rather than unifying semantics: 450 to 550 lines.

**Dead and replaced.** The Strava tile proxy at `daemon/src/routes/strava.rs:208-335`
(about 130 lines) is documented as replaced by the harvester
(`routes/heat.rs:8-9`), and Plan calls only `/status` and `/cookies`; the
cookie header builder there (`strava.rs:71-81`) duplicates
`harvest/src/fetch.rs:112-119`. `GET /api/export/shares` has no client. The
`web_styles_path` default is a pre-monorepo path (§2.1). Eighteen doc comments
cite `Docs/` or `web/`, which no longer exist.

**SQL idioms.** `ST_SimplifyPreserveTopology` at 12 sites with six tolerances;
the zoom-to-tolerance table twice (`rides.rs:559-561`, `heatmap.rs:69-71`); the
ride-class `CASE` eleven times in six files; the privacy-zone `ST_Union` trim
sixteen times in five files; `is_loop` twice (`rides.rs:718`, `items.rs:38`);
five to seven bounds parsers. Three SELECT projections of the same live ride
summary (`RideSummary` at `rides.rs:52` with 25 fields, the `json!` projection
at `items.rs:526-568` with the same 25, `HeatmapTrack` at `heatmap.rs:32`), and
34 handlers return untyped `Json<serde_json::Value>`. Functions or generated
columns for the idioms and one projection type: about 250 lines and one place
to change a rule.

**CI needs a database to compile.** 37 `sqlx::query!` sites in nine files
(against 227 runtime queries) force the PostGIS service and the migration
loop before `cargo check`. Commit a `.sqlx/` offline cache (kept fresh by
`cargo sqlx prepare` in the PR workflow) and the check job runs without a
database; the test job keeps it.

Ranked for the Rust and server side:

| # | Move | Lines | Risk |
|---|---|---|---|
| 1 | Drop the legacy segment and run schema, then squash the migrations | 650 to 750 | existing databases need an explicit reset; keep the embedded backfills |
| 2 | Move `routes/export.rs` business logic into the export crate | 2,250 moved, 150 to 200 deleted | most-churned file; do it a section at a time |
| 3 | One `ApiError` and one `AppState` | 250 to 350 | touches all 19 route files |
| 4 | One post-ingest pipeline and one cluster-and-shelve skeleton for the CLI | 450 to 550 | deliberate semantic differences must stay as parameters |
| 5 | Dead crate, dead workspace block, twelve unused dependencies, the Strava tile proxy, `list_shares`, the second `.env` parser, and a committed `.sqlx/` cache | 250 and a database-free check job | the mirrored DingoNav repo was not checked as a consumer of the tile proxy |

### 4.6 Tooling, tests, CI and docs

- **Two `build-tiles` directories.** `tools/build-tiles` (2026-08-30,
  planetiler with a places patch, own `package.json`) says it supersedes the
  extract approach in `server/tools/build-tiles` (2026-08-04), but the
  hillshade build, the manifest writer, `upload-r2.sh` and `cors.json` exist
  only in the old one, and nothing in the repo references `server/tools`. Merge
  into one directory. `server/tools/strava-connector-extension` (a Chrome
  extension) is likewise undiscoverable where it sits.
- **Three static servers.** `apps/nav/serve.js` (CommonJS) and
  `apps/studio/serve.js` (ESM) are the same 22-line server, both defaulting to
  port 8138 (which is why `dingoctl` overrides one to 8139).
  `tools/dev-tile-server.js` adds Range and CORS for PMTiles. One
  `tools/serve.mjs <dir> <port>` with Range support replaces all three, and the
  CommonJS file is what blocks a root `"type": "module"`.
- **`tools/dingoctl`** (886 lines) is a seven-service process manager. Its
  `db` entry is a second docker-compose wrapper beside
  `server/scripts/dev-db.sh`, and `docs/dingo/CLAUDE.md:19` still tells agents
  to use the latter. Its two tests run in the required `repo` CI job
  (`ci.yml:94`) although they guard a dev convenience, not a repo invariant.
- **CI.** The Rust job needs a live PostGIS service and applies 58 migrations
  before it can compile, because `sqlx::query!` has no committed offline cache.
  A checked-in `.sqlx/` directory would let `cargo check` run without a
  database and would cut the job's setup. No lint job runs for Plan or the site
  despite both having configs. `plan-page-phone.spec.mjs` always skips in CI
  (needs `PLAN_PAGE_URL`).
- **Docs.** `docs/dingo/` (13 files, 3,882 lines) is the pre-monorepo Dingo
  documentation root: a `README.md` that says `cd web && npm run dev`, a
  `CLAUDE.md` an agent could pick up by mistake, `legacy-ci.yml`, two audits,
  and rendered HTML. Reduce it to one history pointer or delete it.
  `docs/ecosystem.html` (906 lines) carries a fourth copy of the palette.
  Twelve plan docs still reference the DingoStudio repo, `sync-appliers.sh`,
  `dingo-shares` or `~/Desktop` paths. Of 57 code comments citing a design doc,
  33 resolve, about 20 use the un-prefixed pre-monorepo name
  (`Docs/plans/2026-07-15-packs-design.md` for
  `dingo-2026-07-15-packs-design.md`), and one cites a file that does not
  exist: `server/migrations/20260811000001_ride_name_variants.sql:3` names
  `plan-2026-08-11-track-names-and-import-provenance-design.md`.
  `film-2026-09-06-trip-film-design.md` states nothing is built and there is no
  `apps/film`.
- **Repository hygiene.** `apps/plan/vercel.json` is undocumented. The
  `cspell.json` word list is Rust-only. `.gitignore` lists `.env*` twice.

## 5. Sequenced roadmap

Each step is one topic branch and one squash-merged PR, per `CLAUDE.md`.
Steps inside a phase are independent; phases are ordered by what they unblock.

**Phase 0, decisions (no code).** Plan hosting (§2.1). Host for gmaps and
closures (§2.3). Satellite source for Plan (§4.1). Whether Studio keeps
committed tiles (§4.4). Whether Nav's demo or Studio's `#demo` lives (§4.4).
Write the answers into this document's successor and into `README.md`.

**Phase 1, deletions with no behaviour change.** `docs/dingo/`; Nav's Python
scripts and `markSpot`; Plan's template files, dead exports and dead store
setters, `@deck.gl/react`; the site's SVGs; `exportShare` and the daemon's
`/export/share` routes; `dingoctl` tests out of the required job. Fix the
stale prose in `CONTRIBUTING.md`, the applier headers, the Nav README, and
the mis-pathed doc citations. About 4,500 lines, all verifiable by grep.

**Phase 2, one copy of each asset.** `core/vendor/` with one MapLibre, PMTiles
and fflate; one static server; one `build-tiles/`; the site imports appliers
directly and `sync-core.mjs` shrinks to the basemap copy. Studio moves off its
committed archives if Phase 0 says so.

**Phase 3, contracts and registries into `core/`.** `core/formats/` for the
pack and plan-document shapes with fixtures the Rust tests write;
`core/appliers/categories.js`; `core/appliers/behavior.js` with the defaults
reconciled to Nav; `core/appliers/dingo-style.js`; Nav calls
`ddCore.applyBaseOverrides` and the real validators. Each is small and each
closes a drift channel.

**Phase 4, Plan collapses to the shared basemap.** The §4.1 deletion, the
daemon `routes/styles.rs`, then Studio's Plan-styles workspace. This is the
largest single removal and it depends only on Phase 0.

**Phase 5, `core/track/`.** First the `boot()` timeout and the `REF` reset in
Nav. Then geometry and GPX, then the cue engine, authored from Nav's superset;
Studio and the three sidecars import. Every file joins the SW SHELL and the
assembly hash. Verify with a real device offline, per `CONTRIBUTING.md`.

**Phase 6, one token vocabulary.** Plan's and Studio's aliases, Nav's CSS
aliases and JavaScript bridge, the site's literal palette and `ecosystem.html`.
Re-point `tests/contrast.test.mjs`; screenshot proof per app and mode.

**Phase 7, Plan internals.** The typed client and generic hooks; the MapView
split; the store helpers out; first unit tests for the pure code.

**Phase 8, one implementation per feature.** gmaps and closures per the
Phase 0 host decision; the daemon proxies or the site does.

**Phase 9, Rust and server.** In this order: the dead crate, workspace block,
unused dependencies, Strava tile proxy and `list_shares` (no behaviour
change); the committed `.sqlx/` cache and a database-free check job; the
`DROP TABLE` migration for the legacy schema, then the squash with a
documented reset for the owner's database; `ApiError` and `AppState` in one
quiet window; `routes/export.rs` into the export crate a section at a time;
the CLI pipelines last, fixing the `dedupe_plans` ordering bug on the way.

**Phase 10, Nav's product surface.** Varg into a sidecar; the daymode CSS
block; the guidance state machine shared with Studio if fidelity is wanted.
Last, because it is the ride-critical path.

## 6. What was checked and how

All numbers are from `wc -l` and `grep` at `1b8cd1d`. Dead-code claims were
confirmed by grepping every caller outside the defining file. Duplication
claims between Nav and Studio were confirmed with `diff -w`. The gmaps fixture
claim was checked by diffing the URL strings in `apps/site/lib/gmaps.test.ts`
against `core/rust/google/src/maps.rs`. Line-savings figures are estimates from
the cited ranges, not from a trial refactor.

Not verified: whether a Vercel project for Plan exists; how much the MapTiler
satellite base is used (no telemetry); `npm run lint` and `tsc` were not run
(no `node_modules` in this checkout), so "unused dependency" is grep-based on
import specifiers.
