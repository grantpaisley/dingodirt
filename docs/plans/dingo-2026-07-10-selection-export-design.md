# Selection → Export Pipeline + Profile Graph Upgrade

*Design validated with Grant, 2026-07-10.*

Dingo's role: browse/inspect rides and candidate routes, then push GPX tracks and
heatmaps to on-bike nav apps (OsmAnd, Locus, DMD2). This design covers the pipeline
from "select tracks" to "bundle lands on the device", plus the elevation-profile
upgrade. Parked sibling threads are listed in the appendix.

## Decisions

- **Selection model**: an explicit **export basket** you add to across gestures
  (lasso, search, list, detail pane). Persisted per-browser; not a DB entity.
  Named/saved collections deferred.
- **Destinations**: named server-side destinations (path + profile), *plus* a
  zip-download path. The zip path is what survives a future hosted deployment
  (dingodirt.com).
- **Bundle contents**: chosen at export time — `individual tracks` and/or
  `merged heatmap` toggles, default both on.
- **Profiles are code, not config**: `osmand | locus | dmd2 | generic`. `generic`
  (emit all three color dialects, as `export offline` does today) stays the default
  until DMD2 color support is tested on a real device.

## 1. Basket & dimming (web)

Store (`web/src/store.ts`):

- `basketIds: Set<string>` — persisted (localStorage) so reloads don't lose it.
- `dimmedOpacity: number` — persisted setting, default ~0.2, slider 5–60%.

Adding/removing:

- Lasso selection toolbar gains **Add N to basket** / **Remove N** (carve-outs).
- List rows get a basket icon; list header gets **Add all matches** when
  search/filters are active.
- Detail pane: add/remove single ride.

Basket UI: a count chip in the list header (next to Rides/Heatmap toggles).
Clicking it switches the list to *basket view* — basket contents as the ride list
(a filter over the normal list, not a new component), rows removable, with
**Clear** and **Export…**.

Dimming rule: if any highlight context is active, non-highlighted tracks render at
`dimmedOpacity`. Contexts in priority order: transient selection (lasso/click) →
active search matches → basket contents. No context → full opacity. Implemented as
an alpha function in the existing rides `PathLayer` color accessor — no new layer.
Heatmap layers are **not** dimmed; only per-ride tracks.

## 2. Destinations & export profiles

**Destinations** are server-side (daemon writes files; CLI shares the list):
table `export_destinations` (id, name, path, profile, layout), managed via
`GET/POST/DELETE /api/destinations` + a small settings pane.
Examples: *OsmAnd phone* → `~/Sync/osmand-tracks` (profile `osmand`),
*DMD2 tablet* → `~/Sync/dmd2-routes` (profile `dmd2`). Sync to the device stays
Syncthing's job — Dingo never implements sync.

**Profiles** (enum in code) define:

- Color dialect: `osmand:color` / `locus:` + `gpx_style` / bare `<color>` /
  `generic` = all three.
- Layout: flat vs mirrored `State/Region/…` subtree (per-profile default,
  per-destination override) — some apps don't browse nested track dirs well.
- Simplification budget (m) for merged heatmap layers (the OsmAnd 17 MB lesson);
  lighter/none for individual tracks.

**Endpoint**: `POST /api/export` with
`{ ride_ids, destination_id | download: true, include_tracks, include_heatmap, name }`.
`name` becomes the bundle folder `<dest>/<name>/…` or the zip filename.
Destination mode writes to disk and returns a manifest; download mode builds in a
scratch dir then streams a zip. Re-export to the same name overwrites with
stale-file pruning (bundles are regenerable artifacts, never hand-edited).

The GPX writer is `export_offline`'s, refactored into a shared crate function —
one builder, two frontends (daemon + CLI).

## 3. Bundle generation (shared builder)

Input: ride IDs + options. Fetch cleaned geometry (simplified per profile budget),
split by the heatmap SQL's classes (`own | other | plan`).

- **Individual tracks**: one GPX per ride, filenames identical to the library
  export (`organize` naming — underscored, collision-suffixed). Color by class
  (orange/red/blue). Future: `color_by: class | grade` — the writer already takes
  per-track color, so grades (parked thread) slot in as one enum.
- **Merged heatmap**: `heatmap_own/other/plan.gpx` built **from basket rides
  only** (a Snowies basket → Snowies-sized heatmap). Empty classes skipped.
- **Manifest**: response + `manifest.json` in the bundle — every file with ride
  counts and sizes, plus `skipped` (no geometry, superseded). Builder filters
  `superseded_by IS NULL` and *reports* rather than silently drops.
- **Basket hygiene**: exported-but-gone/superseded IDs are reported and removed
  from the basket client-side (self-heals after dedupe/merge runs).
- **CLI parity**: `dingo export bundle --ids-from <file> | --search <q>
  --dest-name <name>` calls the same builder; `export offline` becomes a preset
  over it.

## 4. Errors, edge cases, testing

Errors:

- Destination path missing/unwritable → validate **before** building, clear 4xx,
  no half-written bundles. Per-file temp+rename (audit pattern).
- Empty basket / everything filtered → 400 with reason, never an empty bundle.
- Zip: build fully in scratch dir, then stream — no truncated zips.
- Concurrent exports to same destination+name: last writer wins (single-user OK;
  noted in code for the hosted future).

Edge cases:

- Basket ride without geometry → manifest `skipped`, export proceeds.
- Huge basket: heatmap merge uses the proven 29k-scale simplify path;
  individual-tracks over ~500 rides gets a UI confirmation ("write 2,300 files?").
- Plans + recordings coexist in a basket; class rules apply, no special-casing.

Testing:

- Builder unit tests on `samples/` fixtures: class split, collision suffixes,
  exact per-profile extension XML, empty-class skipping, superseded filtering.
- One integration test: endpoint → temp-dir destination, manifest ↔ disk match.
- Manual: one bundle each in real OsmAnd and Locus. DMD2 compatibility test on a
  real device **before** the `dmd2` profile is written (until then: `generic`).

## 5. Elevation profile: full resolution + map sync

Scope chosen: **full-resolution plotting with drag-to-zoom and pan**, elevation
only, staying in the detail pane. (Extra series, expandable pane, labelled
axes/stats considered and deferred.)

- Data: `/rides/{id}/points` already returns `ele` + `distance_cumulative_m`
  (grade colour mode uses it) — **no API changes**. Plot every cleaned point
  instead of a downsampled sketch; drag on the graph zooms into a distance range,
  drag-pan moves along the ride.
- **Profile → map**: hovering the graph shows a position dot riding along the
  track at that cumulative distance.
- **Map → profile**: hovering the ride's track (deck.gl picking → nearest vertex →
  its cumulative distance) moves a cursor line on the profile with the elevation
  readout. Same grammar as photo dots: hover = transient, click = pinned.

## Appendix — parked threads (from the 2026-07-10 brainstorm)

1. **Import + source tagging**: `Inbox/<source>/` subfolder convention tags rides
   on ingest (`rides.source` free-text: wikiloc, dmd-hub, dsra, …) → searchable,
   filterable. Web upload UI deferred to the dingodirt.com thread (mandatory
   there — a hosted daemon can't see the local filesystem).
2. **Zone level** (Northern/Southern/Central NSW): curated `(state, region) →
   zone` TSV, same pattern as `lga-regions-au.tsv`; becomes a fifth candidate
   level in the adaptive export layout (State → Zone → Region → LGA → Suburb) —
   the existing "skip non-meaningful levels" rule means zones only materialize
   where they split things.
3. **Ride grades 1–5** (Grant's condition scale, easiest → very difficult):
   `rides.grade smallint`, detail-pane selector + bulk-set on a selection, grade
   filter, grade as export color scheme. Overall per-ride rating first;
   per-section grading belongs to the future manual-segments feature.
   Auto-*suggest* from speed/steepness maybe later; never auto-assign.
4. **Heatmap raster tiles**: `dingo export heatmap-tiles` → MBTiles/sqlitedb
   overlay for OsmAnd/Locus — true density glow offline. DMD2 support unknown.
5. **dingodirt.com**: chosen shape = own instance online (VPS or home server +
   tunnel, auth in front), with public read-only sharing as phase 2 — privacy
   zones (trim/blur near home) must be designed in before anything is public.
   Multi-user parked indefinitely.
