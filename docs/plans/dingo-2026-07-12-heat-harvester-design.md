# Heat Harvester — unified heat sources + offline Strava mirror

**Date:** 2026-07-12
**Status:** Implemented 2026-07-17 — see "Implemented" update below for the
material corrections (z15 not z14; a better session-authed endpoint). Original
design 2026-07-12.
**Refined by:** `2026-07-12-owners-and-import-design.md` — the `heat_sources`
table below is replaced by an `owners` table (Strava = a `synthetic` owner); the
GPX→tiles baker becomes the "rasterise a `source` owner" path.
**Supersedes:** the live Strava cookie-proxy approach in
`2026-07-11-strava-overlay-bundle-v2-design.md` and its implementation
(`crates/daemon/src/routes/strava.rs`, `tools/strava-connector-extension/`,
migration `20260711000001_strava_heatmap_cookies`). See "Why this replaces the
cookie proxy" below.

## Implemented — 2026-07-17 (corrections to this design)

Built and run end-to-end (PR #29). Key deltas from the plan below:

- **Max zoom is z15, not z14.** Strava's identified/personal heatmaps serve
  through z15 (z16 = 404). The CLI cap and the `harvest_regions.target_zoom`
  check were raised to 15 (migration `20260717000001`); the web `strava-heatmap`
  source maxzoom is 15.
- **Better endpoint discovered — `personal-heatmaps-external.strava.com`.**
  `…/tiles/{athleteId}/grayscale/{z}/{x}/{y}.png?filter_type=<sport list>&include_everyone=true&…`
  authorises on the **long-lived `_strava4_session` cookie alone** — no CloudFront
  signed cookies, no ~24 h expiry, which removes the entire cookie-refresh
  problem the design below wrestles with. `filter_type` is a comma-separated
  list of sport types, so the harvest is **sport-selectable** — we run off-road
  (`sport_MountainBikeRide,sport_GravelRide,sport_EMountainBikeRide`). Set via
  `DINGO_HEAT_URL`; making it the harvester's compiled default (fetch.rs still
  defaults to the old `content-a` CloudFront path) is a pending follow-up.
- **Corridor deepening shipped** as `dingo-harvest region add-corridor` — seeds
  z14/z15 tiles along the user's own `rides.cleaned_geometry` (segmentized,
  dilated by a ring, no descent). But off-road heat is sparse enough that a
  single pruned z6→z15 baseline over a whole region finds every trail cheaply,
  so corridors weren't needed for the off-road layer.
- **Auto-harvest on import** (ties to the owners/import design): the daemon
  seeds + drains the corridor for freshly-imported tracks, fetching if it holds
  valid cookies, else queuing.
- **Result:** all-Australia off-road ≈ **4,929 tiles / ~15 MB / 0 failed**, one
  MBTiles archive, harvested on a single session cookie.

Everything below is the original 2026-07-12 design (content-a CloudFront path,
z14 assumption) — kept for context; read the corrections above first.

## Problem

Dingo's map should show a Strava-grade global heatmap alongside the user's own
rides. The live-proxy attempts failed for compounding reasons:

- Strava's heatmap tiles are **CloudFront-gated** (`content-a.strava.com/
  identified/globalheat/sport_Ride/grayscale/{z}/{x}/{y}.png`) and require signed
  `content-` cookies that expire ~weekly. Acquiring them cleanly is fragile
  (httpOnly, scope-splicing traps, headless login dead).
- A brief detour proxied `tiles.strava.com/gradient/{quadkey}.png` thinking it was
  the heatmap; it is Strava's **terrain hill-shade**, not ride heat — hence "no
  detail". (Committed in `32e30ba`; to be reverted by this work.)
- Even with valid cookies, hammering Strava live per-pan is slow, rate-limited,
  and account-risky.

The deeper realisation: we don't want a *live* dependency at all. We want to
**acquire the data once, slowly and politely, and own it locally.**

## The unifying idea: everything is a "heat source"

A heatmap is an aggregate of **sources**, each tagged `mine` / `others` /
`strava` (extensible). Sources use whichever of two representations fits:

| Source | Stored as | Why |
|---|---|---|
| `mine` | Vector tracks (PostGIS, as today) | Interactive: select, colour by HR/speed/grade, analyse. Vector is essential. |
| `others` (imported GPX) | Rasterised heat tiles (MBTiles) | Rarely need to click a stranger's GPX. Baking to density keeps thousands of tracks cheap — "convert to heatmap for efficiency". |
| `strava` | Harvested raster tiles (MBTiles) | Strava only gives raster; can't be vector (yet). |

`others` and `strava` converge on the **same tile shape**, from different
acquisition paths (a GPX→tile baker vs a Strava sweep). One storage path and one
rendering path serve both.

## App boundary

A dedicated crate in the existing Rust workspace: **`crates/harvest`**, binary
**`dingo-harvest`** (daemon + CLI subcommands). It owns everything that produces
heat *tiles*: the Strava sweep, the GPX→tile baker, the estimator, the MBTiles
store, the frontier job state. Dingo's existing daemon gains only a thin **read**
route to serve tiles to the map. GPX import gains a `--source` flag.

Reuse (little new low-level code):
- `core` — PostGIS pool, config, ID newtypes.
- `geo` — bbox/tile math; later the skeletonise/trace work.
- `ingest` — GPX parsing for the `others` baker.
- `strava.rs` — tile-fetch-with-retry + quadkey/xyz code moves into `harvest`
  (the old cookie proxy is deleted).
- Export bundler — `corridor_tiles()` for basket selection; the PMTiles pack step
  for DingoNav.

## The harvester: pruning descent

A resumable, breadth-first descent with pruning, driven by a PostGIS frontier
table so a month-long run survives restarts.

1. Seed a region as low-zoom tiles (~z6).
2. Fetch each tile; measure **heat content** (non-empty grayscale pixel ratio —
   a trivial threshold on the intensity tile).
3. If it has heat **and** below target zoom → enqueue its 4 children. If empty →
   **prune** (don't descend). This is why ocean/desert/empty jungle cost nothing
   and "all of AU + SEA over a month" is feasible — only the populated fraction
   is ever fetched.
4. Store every heat-bearing tile in MBTiles; record state in the frontier table
   (`pending`/`done`/`empty`).

**Politeness (built in, not bolted on):** single-worker token-bucket limiter, a
few tiles/sec, jittered, off-peak window, exponential backoff on 429/5xx. The
frontier table makes stop/resume free. The month-long pace is a feature — it is
what keeps the harvest under the radar and the account safe.

**What we store:** Strava's raw **grayscale intensity** tiles, *not* pre-coloured.
Grayscale is the honest underlying data: recolour freely at render time, and it
is the natural input for the vectorise-later pass. Colour is a rendering
decision, never baked into the archive.

## Mirror depth: z13 baseline + selective z14

Strava heat tiles top out at **z14** (z15 = 404, confirmed).

- **Baseline sweep:** z13 across AU + Thailand + Cambodia + Vietnam. Strong trail
  detail at best detail-per-GB (~15–40 GB, order of a couple of weeks polite).
- **Selective z14 (and refresh):** on demand, estimated first (below).

## On-demand deepening + pre-flight estimator

Two selectors, both from existing code:
- **Draw an area** → bbox.
- **Pick a basket of tracks** → `corridor_tiles()` (unchanged from the export
  bundler).

Either yields a tile list. The **estimator dialog** shows, per zoom:

| Zoom | Tiles total | Already have | To fetch | Est. size | Est. time |
|---|---|---|---|---|---|
| z12 | 340 | 340 | 0 | — | done |
| z13 | 1,360 | 1,290 | 70 | ~3 MB | ~1 min |
| z14 | 5,440 | 0 | 5,440 | ~240 MB | ~35 min |

- **Tiles total**: pure math from the bbox.
- **Already have**: one indexed MBTiles lookup — re-deepening only counts/fetches
  the gaps.
- **Size/time**: `to-fetch × running-average tile size` and `÷ polite rate`;
  both sharpen as the archive grows.

Ticked zoom levels enqueue only the missing tiles into the **same frontier
table** — deepening and sweeping share one worker, one limiter, one resume story.
**No silent caps:** a huge selection is stated plainly ("z14 here = 3.1 GB /
~7 h"), never truncated quietly.

## Rendering & integration

**Serve.** Dingo's daemon gains `/api/heat/{source}/{z}/{x}/{y}.png`, reading
straight from MBTiles (one indexed SQLite lookup — no Strava call, no cookies,
ever). Harvester writes; daemon reads. That is the whole contract.

**Colour the grayscale.** MapLibre's `raster-color` maps intensity → a colour
ramp at render time: `strava` in Strava-blue, `others` in a second hue; `mine`
stays the existing deck.gl vector heat (orange). Each is a **toggleable Layers-
pane checkbox** — "heatmap: mine / others / Strava" becomes literal.
*Caveat to verify at build time:* `raster-color` needs a recent MapLibre GL
version; if the installed version predates it, fall back to serve-time colouring
in the daemon.

**DingoNav.** MBTiles → PMTiles in one step → drop into a `.dingonav` bundle like
the basemap already does. Offline nav gets real Strava-grade heat, no live
dependency, reusing last week's bundle plumbing.

## Data model

Postgres for coordination + provenance (not tile blobs):
- `heat_sources` — `id`, `kind` (`mine`/`others`/`strava`), `label`, `palette`,
  `attribution`.
- `harvest_regions` — named targets (AU/TH/KH/VN + ad-hoc areas/baskets):
  geometry, target zoom, created-at.
- `harvest_frontier` — resumable queue: `source_id`, `z`, `x`, `y`, `state`
  (`pending`/`done`/`empty`), `fetched_at`, `heat_ratio`, `attempts`. This is the
  harvester's memory and the estimator's "already have" source.

Tiles live in **MBTiles**, one file per `(source, region)`, standard schema, so
`pmtiles`/`mbutil`/QGIS read them directly.

**Vectorise-later hook.** Because we keep raw grayscale intensity, a future pass
can, per tile: threshold → skeletonise → trace centrelines → stitch across tile
edges → emit LineStrings tagged `source=strava` into a `heat_vectors` PostGIS
table, rendered through the *same* vector path as `mine`. Nothing in the
harvester or storage changes to enable it — it is a downstream reader. That is
the point of storing intensity now: the archive is the substrate, vectorisation
is an optional later consumer.

**GPX→tiles baker** (the `others` path) writes the identical MBTiles shape, so
`others` and `strava` are indistinguishable to the renderer — different
`source_id`s only.

## Phasing

Each phase is independently useful:

1. **Harvester core** — frontier table, pruning descent, token-bucket limiter,
   MBTiles writer. Prove on one small region (Central Coast) end-to-end.
2. **Serve + render** — daemon read route, `raster-color` layer, source toggles.
   Real Strava heat visible in Dingo.
3. **Estimator + deepening** — pre-flight dialog, area/basket selection, z14.
4. **Regional sweep** — AU + TH + KH + VN at z13; let it run.
5. **`others` GPX baker** — `--source` on import, GPX→tiles.
6. **DingoNav export** — MBTiles→PMTiles into `.dingonav`.
7. *(Later, optional)* **Vectorise `strava`→lines.**

## YAGNI — deliberately not building now

Vectorisation (phase 7, hook only); multi-user/friends sources; auto-refresh
schedules; any live Strava fallback (the harvester replaces it — no cookies
anywhere).

## Risks

- **Strava ToS.** Bulk tile harvesting is against Strava's terms. Mitigated —
  not eliminated — by the slow, jittered, resumable, off-peak pace and a single
  worker. This is a personal-scale mirror, not a redistribution service.
- **`raster-color` version dependency.** Fallback: serve-time colouring.
- **Vectorisation quality.** Genuinely hard; hence deferred and optional, never a
  promise.

## Why this replaces the cookie proxy

The live cookie-proxy path is deleted, not kept alongside, because it and the
harvester solve the same need in incompatible ways and two half-working Strava
paths is worse than one:

- The proxy needs **fresh signed cookies weekly**; the harvester needs **none**
  after acquisition.
- The proxy hits Strava **live on every pan** (slow, rate-limited, risky); the
  harvester hits it **once, slowly, off-peak**, then serves locally forever.
- The proxy produced a live dependency users had to nurse (extension, reconnect
  dance); the harvester produces an **owned, offline, DingoNav-portable archive**.

To be removed as part of phase 2: `crates/daemon/src/routes/strava.rs` (the
cookie storage, `/cookies` POST, `/status`, live tile proxy), the
`tools/strava-connector-extension/`, the `strava_heatmap_cookies` table/migration
(via a new drop migration), and the `StravaConnect` web panel. The reusable
tile-fetch/quadkey code moves into `crates/harvest`. The interim `gradient`
(terrain) fetch committed in `32e30ba` is reverted.
