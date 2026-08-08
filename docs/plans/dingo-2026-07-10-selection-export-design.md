# Selection → Export Pipeline + Profile Graph Upgrade

*Design validated with Grant, 2026-07-10.*

Dingo's role: browse and inspect the rides and the candidate routes, then push
GPX tracks and heatmaps to the on-bike nav apps (OsmAnd, Locus, DMD2). This
design covers the pipeline from "select tracks" to "bundle lands on the
device", plus the elevation-profile upgrade. The appendix lists the parked
sibling threads.

## Decisions

- **Selection model**: an explicit **export basket**. You add to it across
  gestures (lasso, search, list, detail pane). The basket persists
  per-browser. It is not a DB entity. Named/saved collections are deferred.
- **Destinations**: named server-side destinations (path + profile), *plus* a
  zip-download path. The zip path is what survives a future hosted deployment
  (dingodirt.com).
- **Bundle contents**: chosen at export time — the `individual tracks` and/or
  `merged heatmap` toggles. The default is both on.
- **Profiles are code, not config**: `osmand | locus | dmd2 | generic`.
  `generic` emits all three color dialects, as `export offline` does today.
  It stays the default until the DMD2 color support passes a test on a real
  device.

## 1. Basket & dimming (web)

Store (`web/src/store.ts`):

- `basketIds: Set<string>` — persisted (localStorage), so reloads do not lose
  it.
- `dimmedOpacity: number` — a persisted setting, default ~0.2, slider 5–60%.

Add/remove paths:

- The lasso selection toolbar gains **Add N to basket** / **Remove N**
  (carve-outs).
- The list rows get a basket icon. The list header gets **Add all matches**
  when search/filters are active.
- The detail pane: add/remove a single ride.

Basket UI: a count chip in the list header (next to the Rides/Heatmap
toggles). A click on it switches the list to *basket view*. The basket
contents become the ride list — a filter over the normal list, not a new
component. The rows are removable, with **Clear** and **Export…**.

Dimming rule: if any highlight context is active, the non-highlighted tracks
render at `dimmedOpacity`. The contexts, in priority order: transient
selection (lasso/click) → active search matches → basket contents. No
context → full opacity. Implement it as an alpha function in the existing
rides `PathLayer` color accessor — no new layer. The heatmap layers are
**not** dimmed; only the per-ride tracks are.

## 2. Destinations & export profiles

**Destinations** are server-side. The daemon writes the files; the CLI shares
the list. The table is `export_destinations` (id, name, path, profile,
layout), managed via `GET/POST/DELETE /api/destinations` + a small settings
pane. Examples: *OsmAnd phone* → `~/Sync/osmand-tracks` (profile `osmand`),
*DMD2 tablet* → `~/Sync/dmd2-routes` (profile `dmd2`). Sync to the device
stays Syncthing's job — Dingo never implements sync.

**Profiles** (an enum in code) define:

- The color dialect: `osmand:color` / `locus:` + `gpx_style` / bare
  `<color>` / `generic` = all three.
- The layout: flat vs a mirrored `State/Region/…` subtree (a per-profile
  default, with a per-destination override). Some apps do not browse nested
  track dirs well.
- The simplification budget (m) for the merged heatmap layers (the OsmAnd
  17 MB lesson); lighter or none for the individual tracks.

**Endpoint**: `POST /api/export` with
`{ ride_ids, destination_id | download: true, include_tracks, include_heatmap, name }`.
`name` becomes the bundle folder `<dest>/<name>/…` or the zip filename.
Destination mode writes to disk and returns a manifest. Download mode builds
in a scratch dir, then streams a zip. A re-export to the same name
overwrites, with stale-file pruning. Bundles are regenerable artifacts,
never hand-edited.

The GPX writer is `export_offline`'s writer, refactored into a shared crate
function — one builder, two frontends (daemon + CLI).

## 3. Bundle generation (shared builder)

Input: the ride IDs + options. Fetch the cleaned geometry (simplified per
the profile budget). Split it by the heatmap SQL's classes
(`own | other | plan`).

- **Individual tracks**: one GPX per ride. The filenames are identical to
  the library export (`organize` naming — underscored, collision-suffixed).
  Color by class (orange/red/blue). Future: `color_by: class | grade` — the
  writer already takes a per-track color, so grades (a parked thread) slot
  in as one enum.
- **Merged heatmap**: `heatmap_own/other/plan.gpx`, built **from the basket
  rides only** (a Snowies basket → a Snowies-sized heatmap). Empty classes
  are skipped.
- **Manifest**: the response + `manifest.json` in the bundle — every file
  with ride counts and sizes, plus `skipped` (no geometry, superseded). The
  builder filters `superseded_by IS NULL` and *reports* the drops rather
  than silently drop them.
- **Basket hygiene**: the export reports the exported-but-gone/superseded
  IDs, and the client removes them from the basket. The basket thus
  self-heals after dedupe/merge runs.
- **CLI parity**: `dingo export bundle --ids-from <file> | --search <q>
  --dest-name <name>` calls the same builder. `export offline` becomes a
  preset over it.

## 4. Errors, edge cases, testing

Errors:

- The destination path is missing or unwritable → validate **before** the
  build, return a clear 4xx, and write no half-written bundles. Use per-file
  temp+rename (the audit pattern).
- An empty basket / everything filtered → 400 with a reason, never an empty
  bundle.
- Zip: build fully in the scratch dir, then stream — no truncated zips.
- Concurrent exports to the same destination+name: the last writer wins.
  This is OK single-user; note it in code for the hosted future.

Edge cases:

- A basket ride without geometry → manifest `skipped`, and the export
  proceeds.
- A huge basket: the heatmap merge uses the proven 29k-scale simplify path.
  Individual-tracks over ~500 rides gets a UI confirmation ("write 2,300
  files?").
- Plans + recordings coexist in a basket. The class rules apply, with no
  special-casing.

Testing:

- Builder unit tests on the `samples/` fixtures: the class split, the
  collision suffixes, the exact per-profile extension XML, the empty-class
  skipping, and the superseded filtering.
- One integration test: endpoint → a temp-dir destination, with a
  manifest ↔ disk match.
- Manual: one bundle each in real OsmAnd and Locus. Do the DMD2
  compatibility test on a real device **before** you write the `dmd2`
  profile (until then: `generic`).

## 5. Elevation profile: full resolution + map sync

Scope chosen: **full-resolution plotting with drag-to-zoom and pan**,
elevation only, staying in the detail pane. Extra series, an expandable
pane, and labelled axes/stats were considered and deferred.

- Data: `/rides/{id}/points` already returns `ele` +
  `distance_cumulative_m` (the grade colour mode uses it) — **no API
  changes**. Plot every cleaned point instead of a downsampled sketch. A
  drag on the graph zooms into a distance range. A drag-pan moves along the
  ride.
- **Profile → map**: a hover on the graph shows a position dot that rides
  along the track at that cumulative distance.
- **Map → profile**: a hover on the ride's track (deck.gl picking → the
  nearest vertex → its cumulative distance) moves a cursor line on the
  profile with the elevation readout. The same grammar as the photo dots:
  hover = transient, click = pinned.

## Appendix — parked threads (from the 2026-07-10 brainstorm)

1. **Import + source tagging**: the `Inbox/<source>/` subfolder convention
   tags rides on ingest (`rides.source` free-text: wikiloc, dmd-hub, dsra,
   …) → searchable, filterable. The web upload UI is deferred to the
   dingodirt.com thread. It is mandatory there — a hosted daemon cannot see
   the local filesystem.
2. **Zone level** (Northern/Southern/Central NSW): a curated
   `(state, region) → zone` TSV, the same pattern as `lga-regions-au.tsv`.
   It becomes a fifth candidate level in the adaptive export layout
   (State → Zone → Region → LGA → Suburb). The existing "skip
   non-meaningful levels" rule means zones only materialize where they
   split things.
3. **Ride grades 1–5** (Grant's condition scale, easiest → very difficult):
   `rides.grade smallint`, a detail-pane selector + bulk-set on a
   selection, a grade filter, and grade as an export color scheme. The
   overall per-ride rating comes first. Per-section grading belongs to the
   future manual-segments feature. An auto-*suggest* from speed/steepness
   maybe comes later; never auto-assign.
4. **Heatmap raster tiles**: `dingo export heatmap-tiles` →
   MBTiles/sqlitedb overlay for OsmAnd/Locus — a true density glow
   offline. DMD2 support is unknown.
5. **dingodirt.com**: the chosen shape = own instance online (a VPS or a
   home server + tunnel, with auth in front), with public read-only
   sharing as phase 2. Privacy zones (trim/blur near home) must be
   designed in before anything is public. Multi-user is parked
   indefinitely.
