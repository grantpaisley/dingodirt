# Heat Harvester — unified heat sources + offline Strava mirror

**Date:** 2026-07-12
**Status:** Implemented 2026-07-17 — see "Implemented" update below for the
material corrections (z15 not z14; a better session-authed endpoint). Original
design 2026-07-12.
**Refined by:** `2026-07-12-owners-and-import-design.md` — an `owners` table
replaces the `heat_sources` table below (Strava = a `synthetic` owner). The
GPX→tiles baker becomes the "rasterise a `source` owner" path.
**Supersedes:** the live Strava cookie-proxy approach in
`2026-07-11-strava-overlay-bundle-v2-design.md` and its implementation
(`crates/daemon/src/routes/strava.rs`, `tools/strava-connector-extension/`,
migration `20260711000001_strava_heatmap_cookies`). See "Why this replaces the
cookie proxy" below.

## Implemented — 2026-07-17 (corrections to this design)

We built this and ran it end-to-end (PR #29). The key deltas from the plan
below:

- **The max zoom is z15, not z14.** Strava's identified/personal heatmaps
  serve through z15 (z16 = 404). We raised the CLI cap and the
  `harvest_regions.target_zoom` check to 15 (migration `20260717000001`). The
  web `strava-heatmap` source maxzoom is 15.
- **We found a better endpoint — `personal-heatmaps-external.strava.com`.**
  `…/tiles/{athleteId}/grayscale/{z}/{x}/{y}.png?filter_type=<sport list>&include_everyone=true&…`
  authorises on the **long-lived `_strava4_session` cookie alone** — no
  CloudFront signed cookies, no ~24 h expiry. This removes the entire
  cookie-refresh problem that the design below wrestles with. `filter_type`
  is a comma-separated list of sport types, so the harvest is
  **sport-selectable** — we run off-road
  (`sport_MountainBikeRide,sport_GravelRide,sport_EMountainBikeRide`). We set
  this via `DINGO_HEAT_URL`. A pending follow-up: make it the harvester's
  compiled default (fetch.rs still defaults to the old `content-a` CloudFront
  path).
- **Corridor deepening shipped** as `dingo-harvest region add-corridor`. It
  seeds z14/z15 tiles along the user's own `rides.cleaned_geometry`
  (segmentized, dilated by a ring, no descent). But the off-road heat is
  sparse. Thus one pruned z6→z15 baseline over a whole region finds every
  trail cheaply, and we did not need the corridors for the off-road layer.
- **Auto-harvest on import** (this ties to the owners/import design): the
  daemon seeds and drains the corridor for freshly imported tracks. It
  fetches if it holds valid cookies, else it queues.
- **The result:** all-Australia off-road ≈ **4,929 tiles / ~15 MB /
  0 failed**, one MBTiles archive, harvested on a single session cookie.

Everything below is the original 2026-07-12 design (the content-a CloudFront
path, the z14 assumption). We keep it for context. Read the corrections above
first.

## Problem

Dingo's map must show a Strava-grade global heatmap next to the user's own
rides. The live-proxy attempts failed for these compounding reasons:

- Strava's heatmap tiles are **CloudFront-gated** (`content-a.strava.com/
  identified/globalheat/sport_Ride/grayscale/{z}/{x}/{y}.png`). They need
  signed `content-` cookies that expire ~weekly. A clean acquisition of the
  cookies is fragile (httpOnly, scope-splicing traps, headless login dead).
- A brief detour proxied `tiles.strava.com/gradient/{quadkey}.png` in the
  belief that it was the heatmap. It is Strava's **terrain hill-shade**, not
  ride heat — hence "no detail". (Committed in `32e30ba`; this work reverts
  it.)
- Even with valid cookies, live per-pan calls hammer Strava. That path is
  slow, rate-limited, and a risk to the account.

The deeper realisation: we do not want a *live* dependency at all. We want to
**get the data once, slowly and politely, and own it locally.**

## The unifying idea: everything is a "heat source"

A heatmap is an aggregate of **sources**. Each source has the tag `mine` /
`others` / `strava` (extensible). A source uses whichever of the two
representations fits:

| Source | Stored as | Why |
|---|---|---|
| `mine` | Vector tracks (PostGIS, as today) | Interactive: select, colour by HR/speed/grade, analyse. Vector is essential. |
| `others` (imported GPX) | Rasterised heat tiles (MBTiles) | You rarely must click a stranger's GPX. A bake to density keeps thousands of tracks cheap — "convert to heatmap for efficiency". |
| `strava` | Harvested raster tiles (MBTiles) | Strava only gives raster. It cannot be vector (yet). |

`others` and `strava` converge on the **same tile shape**, from different
acquisition paths (a GPX→tile baker vs a Strava sweep). One storage path and
one rendering path serve both.

## App boundary

A dedicated crate in the existing Rust workspace: **`crates/harvest`**,
binary **`dingo-harvest`** (daemon + CLI subcommands). It owns everything
that produces heat *tiles*: the Strava sweep, the GPX→tile baker, the
estimator, the MBTiles store, and the frontier job state. Dingo's existing
daemon gains only a thin **read** route to serve the tiles to the map. The
GPX import gains a `--source` flag.

Reuse (little new low-level code):
- `core` — the PostGIS pool, config, ID newtypes.
- `geo` — bbox/tile math; later the skeletonise/trace work.
- `ingest` — GPX parsing for the `others` baker.
- `strava.rs` — the tile-fetch-with-retry and quadkey/xyz code moves into
  `harvest` (we delete the old cookie proxy).
- The export bundler — `corridor_tiles()` for the basket selection; the
  PMTiles pack step for DingoNav.

## The harvester: pruning descent

A resumable, breadth-first descent with pruning. A PostGIS frontier table
drives it, so a month-long run survives restarts.

1. Seed a region as low-zoom tiles (~z6).
2. Fetch each tile. Measure the **heat content** (the ratio of non-empty
   grayscale pixels — a trivial threshold on the intensity tile).
3. If the tile has heat **and** is below the target zoom → enqueue its 4
   children. If it is empty → **prune** (do not descend). This is why ocean,
   desert, and empty jungle cost nothing. Thus "all of AU + SEA over a
   month" is feasible — we only fetch the populated fraction.
4. Store every heat-bearing tile in MBTiles. Record the state in the
   frontier table (`pending`/`done`/`empty`).

**Politeness (built in, not bolted on):** a single-worker token-bucket
limiter, a few tiles/sec, jittered, an off-peak window, and exponential
backoff on 429/5xx. The frontier table makes stop and resume free. The
month-long pace is a feature — it keeps the harvest under the radar and the
account safe.

**What we store:** Strava's raw **grayscale intensity** tiles, *not*
pre-coloured tiles. Grayscale is the honest underlying data. You can
recolour it freely at render time. It is also the natural input for the
later vectorise pass. Colour is a rendering decision. We never bake it into
the archive.

## Mirror depth: z13 baseline + selective z14

Strava heat tiles top out at **z14** (z15 = 404, confirmed).

- **Baseline sweep:** z13 across AU + Thailand + Cambodia + Vietnam. This
  gives strong trail detail at the best detail-per-GB (~15–40 GB, in the
  order of a couple of polite weeks).
- **Selective z14 (and refresh):** on demand, with an estimate first
  (below).

## On-demand deepening + pre-flight estimator

Two selectors, both from existing code:
- **Draw an area** → a bbox.
- **Pick a basket of tracks** → `corridor_tiles()` (unchanged from the
  export bundler).

Either selector yields a tile list. The **estimator dialog** shows, per
zoom:

| Zoom | Tiles total | Already have | To fetch | Est. size | Est. time |
|---|---|---|---|---|---|
| z12 | 340 | 340 | 0 | — | done |
| z13 | 1,360 | 1,290 | 70 | ~3 MB | ~1 min |
| z14 | 5,440 | 0 | 5,440 | ~240 MB | ~35 min |

- **Tiles total**: pure math from the bbox.
- **Already have**: one indexed MBTiles lookup. A re-deepening only counts
  and fetches the gaps.
- **Size/time**: `to-fetch × running-average tile size` and `÷ polite rate`.
  Both sharpen as the archive grows.

The ticked zoom levels enqueue only the missing tiles into the **same
frontier table**. Thus the deepening and the sweep share one worker, one
limiter, and one resume story. **No silent caps:** the dialog states a huge
selection plainly ("z14 here = 3.1 GB / ~7 h"). It never truncates quietly.

## Rendering & integration

**Serve.** Dingo's daemon gains `/api/heat/{source}/{z}/{x}/{y}.png`. It
reads straight from MBTiles (one indexed SQLite lookup — no Strava call, no
cookies, ever). The harvester writes; the daemon reads. That is the whole
contract.

**Colour the grayscale.** MapLibre's `raster-color` maps the intensity to a
colour ramp at render time: `strava` in Strava-blue, `others` in a second
hue. `mine` stays the existing deck.gl vector heat (orange). Each source is
a **toggleable checkbox in the Layers pane** — "heatmap: mine / others /
Strava" becomes literal. *A caveat to check at build time:* `raster-color`
needs a recent MapLibre GL version. If the installed version predates it,
fall back to serve-time colouring in the daemon.

**DingoNav.** MBTiles → PMTiles in one step → drop into a `.dingonav`
bundle, as the basemap already does. Offline nav gets real Strava-grade heat
with no live dependency. It reuses last week's bundle plumbing.

## Data model

Postgres holds the coordination and the provenance (not the tile blobs):
- `heat_sources` — `id`, `kind` (`mine`/`others`/`strava`), `label`,
  `palette`, `attribution`.
- `harvest_regions` — the named targets (AU/TH/KH/VN + ad-hoc
  areas/baskets): geometry, target zoom, created-at.
- `harvest_frontier` — the resumable queue: `source_id`, `z`, `x`, `y`,
  `state` (`pending`/`done`/`empty`), `fetched_at`, `heat_ratio`,
  `attempts`. This is the harvester's memory and the estimator's "already
  have" source.

The tiles live in **MBTiles**, one file per `(source, region)`, standard
schema. Thus `pmtiles`/`mbutil`/QGIS read them directly.

**Vectorise-later hook.** We keep the raw grayscale intensity. Thus a future
pass can, per tile: threshold → skeletonise → trace centrelines → stitch
across tile edges → emit LineStrings tagged `source=strava` into a
`heat_vectors` PostGIS table, rendered through the *same* vector path as
`mine`. Nothing in the harvester or the storage changes to enable it — it is
a downstream reader. That is the point of storing intensity now: the archive
is the substrate, and vectorisation is an optional later consumer.

The **GPX→tiles baker** (the `others` path) writes the identical MBTiles
shape. Thus the renderer cannot tell `others` and `strava` apart — only
their `source_id`s differ.

## Phasing

Each phase is useful alone:

1. **Harvester core** — the frontier table, the pruning descent, the
   token-bucket limiter, the MBTiles writer. Prove it on one small region
   (Central Coast) end-to-end.
2. **Serve + render** — the daemon read route, the `raster-color` layer, the
   source toggles. Real Strava heat becomes visible in Dingo.
3. **Estimator + deepening** — the pre-flight dialog, the area/basket
   selection, z14.
4. **Regional sweep** — AU + TH + KH + VN at z13; let it run.
5. **`others` GPX baker** — `--source` on import, GPX→tiles.
6. **DingoNav export** — MBTiles→PMTiles into `.dingonav`.
7. *(Later, optional)* **Vectorise `strava`→lines.**

## YAGNI — deliberately not building now

Vectorisation (phase 7, hook only); multi-user/friends sources; auto-refresh
schedules; any live Strava fallback (the harvester replaces it — no cookies
anywhere).

## Risks

- **Strava ToS.** A bulk tile harvest is against Strava's terms. The slow,
  jittered, resumable, off-peak pace and the single worker decrease the risk
  — they do not remove it. This is a personal-scale mirror, not a
  redistribution service.
- **The `raster-color` version dependency.** The fallback: serve-time
  colouring.
- **Vectorisation quality.** It is genuinely hard. Hence it is deferred and
  optional, never a promise.

## Why this replaces the cookie proxy

We delete the live cookie-proxy path. We do not keep it in parallel. It and
the harvester solve the same need in incompatible ways, and two half-working
Strava paths are worse than one:

- The proxy needs **fresh signed cookies weekly**. The harvester needs
  **none** after the acquisition.
- The proxy hits Strava **live on every pan** (slow, rate-limited, risky).
  The harvester hits it **once, slowly, off-peak**, then serves locally
  forever.
- The proxy produced a live dependency that users had to nurse (the
  extension, the reconnect dance). The harvester produces an **owned,
  offline, DingoNav-portable archive**.

To remove as part of phase 2: `crates/daemon/src/routes/strava.rs` (the
cookie storage, the `/cookies` POST, `/status`, the live tile proxy), the
`tools/strava-connector-extension/`, the `strava_heatmap_cookies`
table/migration (via a new drop migration), and the `StravaConnect` web
panel. The reusable tile-fetch/quadkey code moves into `crates/harvest`. We
revert the interim `gradient` (terrain) fetch committed in `32e30ba`.
