# Planned routes & POIs — implementation plan

Companion to `2026-07-28-planned-routes-pois-design.md`.

**Gate: do not start until `claude/gps-upload-dialog-storage-4c0868` is merged
to main**, then rebase this branch on main. That branch reworks
`crates/cli/src/organize.rs` into a shared placement engine, changes
`crates/daemon/src/routes/import.rs` and `web/src/components/Import/ImportDialog.tsx`,
and owns migration `20260728000001_district_and_endpoints.sql` — number the
migration here after it.

## Phase 1 — schema & core types

- Migration `2026072?00000?_planned_routes_and_pois.sql` (date after the gate
  merge):
  - `CREATE TYPE ride_kind AS ENUM ('recorded','planned');`
  - `ALTER TABLE rides ADD COLUMN kind ride_kind NOT NULL DEFAULT 'recorded';`
  - `ALTER TABLE rides ADD COLUMN collection text; ADD COLUMN color text; ADD COLUMN description text;`
  - `CREATE TYPE poi_category …; CREATE TABLE pois …` (see design; GIST index on
    `position`, btree on `collection`, `category`).
  - `ALTER TABLE files ADD COLUMN source_path text;`
  - Partial index `ON rides (collection) WHERE kind = 'planned'`.
- `crates/core`: `RideKind`, `PoiCategory` enums (sqlx Type derives), `PoiId`
  newtype.

## Phase 2 — ingest

- `crates/ingest/src/gpx.rs`:
  - Parse top-level `gpx_data.waypoints` → new `Waypoint` struct
    (name, desc, sym, lat/lon, ele). HTML strip: `<br/?>`→`\n`, tags dropped.
  - Parse color extensions on tracks (`gpx_style:line` color, OsmAnd
    `osmand:color`, Locus `locus:…`) → `Track.color: Option<String>`
    normalised to `#rrggbb`.
- `crates/ingest/src/track.rs`: add `color` field.
- Garmin sym→`PoiCategory` static map (module w/ unit tests; unmapped → `poi`).
- `crates/ingest/src/file_store.rs` + repository: persist `source_path` on the
  files row for all imports (recorded too — Grant wants provenance generally).
- `crates/ingest/src/repository.rs`: rides INSERT gains kind/collection/color/
  description; new `insert_pois`; `delete_collection(label)` removing planned
  rides + POIs (+ their orphaned file rows are left — content-addressed store
  keeps the bytes).
- New `crates/ingest/src/routes_import.rs` service:
  `import_routes(path, collection, replace)` — store file → parse → palette
  colors for tracks lacking one (golden-angle hue rotation over tracks sorted
  by name; fixed S/L tuned for dark map) → insert rides (kind=planned) + POIs.
  Errors if collection exists and `!replace`. Returns counts.

## Phase 3 — CLI

- `dingo routes import <file> --collection <label> [--replace]` in
  `crates/cli/src/main.rs` (new `routes` subcommand namespace, room for future
  `routes list/delete`). Prints routes/POIs imported, colors assigned.

## Phase 4 — daemon

- Audit every query on `rides` for kind filtering
  (`grep -rn "FROM rides\|JOIN rides" crates/`): heat tile SQL, stats/aggregate
  endpoints, area assignment scans, dedupe-plan queries, export listings —
  recorded-only paths get `kind = 'recorded'`; track-serving endpoints return
  both plus `kind, collection, color, description` fields.
- New `routes/pois.rs`: `GET /api/pois?bbox&categories&collections`.
- New `GET /api/collections`: label, route count, poi count, total km, bbox.
- Planned-heat source: extend the heat tile pipeline with a `kind='planned'`
  variant (separate tile endpoint or query param — decide against the existing
  heat.rs structure at implementation time).

## Phase 5 — web

- `api/hooks.ts`: pois + collections hooks; ride typing gains
  kind/collection/color/description.
- Layers pane: "Planned routes" section — per-collection toggle + nested POI
  toggle + planned-heat toggle. Store visibility in the zustand settings slice
  (persisted, with migration marker as done previously).
- Track rendering: use stored `color` for planned paths; detail pane renders
  description with preserved newlines.
- POI IconLayer: build atlas from lucide icons (same set as UI), category
  chips, min-zoom threshold, click popover.
- Planned heat: reuse heat shader with color uniform; default Strava-blue.
  Settings "Heat colors" group: own / Strava overlays / planned color pickers.
  Strava raster overlay tint: apply blue tint client-side (raster color ops),
  harvester later requests blue palette natively.

## Phase 6 — exports & packs

- `crates/export` offline GPX: write ride `description` into `<desc>`, color
  extension; POIs within corridor/area as `<wpt>` (category → Garmin sym
  reverse map).
- Packs: allow planned collections + POIs as pack layers (follow existing pack
  layer plumbing); planned heat as a layer option.
- DingoNav bundle: include planned routes + POIs in the pack payload.

## Phase 6b — replace previously imported GOAT rides

The 9 GOAT networks were imported before this feature existed: **362 rides**
with `mode='other'`, gazetteer-renamed (original GOAT name in parens), from
files whose `original_name` matches `%G.O.A.T%`/`%G_O_A_T%`. Verified
2026-07-29: every ride from those files has "goat" in its name and vice versa
— file provenance is a safe deletion key.

After the import path works: list the matching rides (count ~362, eyeball a
sample), delete them, then import all 9 fresh downloads (already copied to
`~/Desktop/Projects/Dingo-data/planned-routes/`) as collections:

| File | Collection |
|---|---|
| N_NSW_G.O.A.T | GOAT NSW North |
| The_G.O.A.T_N.S.W_Central | GOAT NSW Central |
| The_G.O.A.T_N.S.W_South | GOAT NSW South |
| The_G.O.A.T_QLD_SE | GOAT QLD SE |
| The_G.O.A.T_QLD_CN | GOAT QLD CN |
| The_G.O.A.T_VIC | GOAT VIC |
| The_G.O.A.T_S.A | GOAT SA |
| G.O.A.T_TAS | GOAT TAS |
| NT_G.O.A.T | GOAT NT |

Expected: ~433 planned rides (371 `<trk>` elements; multi-segment tracks
split into "(segment N)" rides sharing collection/color, matching existing
ingest behaviour), 3,047 POIs across 9 collections. Note some old
GOAT tracks carried contributor timestamps — planned import ignores times, so
these stop polluting recorded-ride stats/heat, which is desired.

## Phase 7 — testing

- Unit: sym→category map; color extension parsing; HTML stripping; palette
  stability (same input → same colors).
- Fixture: create `samples/planned_routes_sample.gpx` — a trimmed hand-made
  file (2 tracks: one with desc + CDATA, one bare; ~6 wpts covering mapped,
  CDATA-desc, and unmapped syms). Committed (small), tests point at it.
- Integration (live DB): `dingo routes import` the real file — first copy
  `~/Downloads/N_NSW_G.O.A.T-0728060910.gpx` to
  `~/Desktop/Projects/Dingo-data/planned-routes/` (data stays outside repo).
  Expect 39 planned rides, 328 POIs, collection "NSW GOAT"; re-run without
  `--replace` errors; with `--replace` counts unchanged, no duplicates.
- Web (browser pane): collections listed, G.O.A.T routes render colored,
  POI icons/filtering work, planned heat blue, recorded heat/stats unchanged
  (spot-check a stats endpoint before/after import).

## Post-merge runbook (shared DB)

Everything above was built and verified against a scratch clone
(`dingo_planned`, worktree `.env`, daemon on :3101) because unmerged
migrations recorded in the shared DB break main-built daemon restarts.
After this branch merges to main:

1. Rebuild + restart the live daemon (it applies `20260729000001` itself).
2. Delete the legacy GOAT imports — provenance key verified 2026-07-29
   (the two filename prefixes; the only regex near-miss was a "Goat Ridge
   Rd" directions file, excluded by the prefixes):
   ```sql
   DELETE FROM rides r USING files f
   WHERE r.file_id = f.id
     AND (f.original_name ILIKE 'The G.O.A.T%'
          OR f.original_name ILIKE 'The\_G\_O\_A\_T%');
   -- 411 rows on the 2026-07-29 snapshot
   ```
3. Import the 9 archives from `~/Desktop/Projects/Dingo-data/planned-routes/`
   with `dingo routes import <file> --collection "<label>"` using the
   collection table above (locality pass runs automatically).
4. `dingo export offline` / library export-on-import will prune the deleted
   rides' library files on the next run (export_tree is now recorded-only,
   so the 433 planned routes stay out of the library tree; they live in
   offline bundles under Routes/<Collection>/ instead).

## Rollout

Single PR is fine (schema + backend + web land together; nothing reads the new
columns until the same PR's UI does). Run `cargo sqlx` build against live DB
per CLAUDE.md. Verify daemon + web with the running stack.
