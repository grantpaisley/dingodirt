# Planned routes & POIs — implementation plan

Companion to `2026-07-28-planned-routes-pois-design.md`.

**Gate: do not start until `claude/gps-upload-dialog-storage-4c0868` is merged
to main.** Then rebase this branch on main. That branch reworks
`crates/cli/src/organize.rs` into a shared placement engine. It changes
`crates/daemon/src/routes/import.rs` and `web/src/components/Import/ImportDialog.tsx`.
It also owns migration `20260728000001_district_and_endpoints.sql` — number the
migration here after it.

## Phase 1 — schema & core types

- Migration `2026072?00000?_planned_routes_and_pois.sql` (date it after the
  gate merge):
  - `CREATE TYPE ride_kind AS ENUM ('recorded','planned');`
  - `ALTER TABLE rides ADD COLUMN kind ride_kind NOT NULL DEFAULT 'recorded';`
  - `ALTER TABLE rides ADD COLUMN collection text; ADD COLUMN color text; ADD COLUMN description text;`
  - `CREATE TYPE poi_category …; CREATE TABLE pois …` (see the design; GIST
    index on `position`, btree on `collection`, `category`).
  - `ALTER TABLE files ADD COLUMN source_path text;`
  - Partial index `ON rides (collection) WHERE kind = 'planned'`.
- `crates/core`: add the `RideKind` and `PoiCategory` enums (sqlx Type
  derives) and the `PoiId` newtype.

## Phase 2 — ingest

- `crates/ingest/src/gpx.rs`:
  - Parse the top-level `gpx_data.waypoints` → a new `Waypoint` struct
    (name, desc, sym, lat/lon, ele). HTML strip: `<br/?>`→`\n`, drop the
    other tags.
  - Parse the color extensions on tracks (`gpx_style:line` color, OsmAnd
    `osmand:color`, Locus `locus:…`) → `Track.color: Option<String>`,
    normalised to `#rrggbb`.
- `crates/ingest/src/track.rs`: add the `color` field.
- Add a static Garmin sym→`PoiCategory` map (a module with unit tests; an
  unmapped sym → `poi`).
- `crates/ingest/src/file_store.rs` + repository: persist `source_path` on
  the files row for all imports, recorded imports too. Grant wants provenance
  generally.
- `crates/ingest/src/repository.rs`: the rides INSERT gains
  kind/collection/color/description. Add `insert_pois`. Add
  `delete_collection(label)`, which removes the planned rides + POIs. The
  orphaned file rows stay — the content-addressed store keeps the bytes.
- New `crates/ingest/src/routes_import.rs` service:
  `import_routes(path, collection, replace)`. It stores the file, then
  parses it. It then assigns palette colors to the tracks that lack one
  (golden-angle hue rotation over the tracks sorted by name; fixed S/L tuned
  for the dark map). It then inserts the rides (kind=planned) + POIs. It
  errors if the collection exists and `!replace`. It returns the counts.

## Phase 3 — CLI

- Add `dingo routes import <file> --collection <label> [--replace]` in
  `crates/cli/src/main.rs`. This is a new `routes` subcommand namespace, with
  room for a future `routes list/delete`. It prints the routes/POIs imported
  and the colors assigned.

## Phase 4 — daemon

- Audit every query on `rides` for kind filtering
  (`grep -rn "FROM rides\|JOIN rides" crates/`). The queries are: the heat
  tile SQL, the stats/aggregate endpoints, the area assignment scans, the
  dedupe-plan queries, and the export listings. Add `kind = 'recorded'` to
  the recorded-only paths. The track-serving endpoints return both kinds plus
  the `kind, collection, color, description` fields.
- New `routes/pois.rs`: `GET /api/pois?bbox&categories&collections`.
- New `GET /api/collections`: label, route count, poi count, total km, bbox.
- Planned-heat source: extend the heat tile pipeline with a `kind='planned'`
  variant. Use a separate tile endpoint or a query param — decide against the
  existing heat.rs structure at implementation time.

## Phase 5 — web

- `api/hooks.ts`: add the pois + collections hooks. The ride typing gains
  kind/collection/color/description.
- Layers pane: add a "Planned routes" section — a per-collection toggle + a
  nested POI toggle + a planned-heat toggle. Store the visibility in the
  zustand settings slice (persisted, with a migration marker as done
  previously).
- Track rendering: use the stored `color` for the planned paths. The detail
  pane renders the description with preserved newlines.
- POI IconLayer: build the atlas from lucide icons (the same set as the UI).
  Add category chips, a min-zoom threshold, and a click popover.
- Planned heat: reuse the heat shader with a color uniform; the default is
  Strava-blue. The Settings "Heat colors" group gets color pickers for: own /
  Strava overlays / planned. Strava raster overlay tint: apply the blue tint
  client-side (raster color ops). The harvester later requests the blue
  palette natively.

## Phase 6 — exports & packs

- `crates/export` offline GPX: write the ride `description` into `<desc>`,
  plus the color extension. Write the POIs in the corridor/area as `<wpt>`
  (category → Garmin sym reverse map).
- Packs: permit planned collections + POIs as pack layers (follow the
  existing pack layer plumbing). Add planned heat as a layer option.
- DingoNav bundle: include the planned routes + POIs in the pack payload.

## Phase 6b — replace previously imported GOAT rides

The 9 GOAT networks were imported before this feature existed: **362 rides**
with `mode='other'`, gazetteer-renamed (the original GOAT name in parens),
from files whose `original_name` matches `%G.O.A.T%`/`%G_O_A_T%`. Verified
2026-07-29: every ride from those files has "goat" in its name, and vice
versa — the file provenance is a safe deletion key.

After the import path works: list the matching rides (count ~362, look at a
sample). Then delete them. Then import all 9 fresh downloads (already copied
to `~/Desktop/Projects/Dingo-data/planned-routes/`) as collections:

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

Expected: ~433 planned rides (371 `<trk>` elements; the ingest splits
multi-segment tracks into "(segment N)" rides that share collection/color,
which matches the existing ingest behaviour), and 3,047 POIs across the 9
collections. Note: some old GOAT tracks carried contributor timestamps. The
planned import ignores times, so these timestamps stop polluting the
recorded-ride stats/heat. This is desired.

## Phase 7 — testing

- Unit: the sym→category map; the color extension parsing; the HTML
  stripping; the palette stability (the same input → the same colors).
- Fixture: create `samples/planned_routes_sample.gpx` — a trimmed hand-made
  file (2 tracks: one with desc + CDATA, one bare; ~6 wpts that cover
  mapped, CDATA-desc, and unmapped syms). Commit it (it is small); the tests
  point at it.
- Integration (live DB): run `dingo routes import` on the real file. First
  copy `~/Downloads/N_NSW_G.O.A.T-0728060910.gpx` to
  `~/Desktop/Projects/Dingo-data/planned-routes/` (the data stays outside
  the repo). Expect 39 planned rides, 328 POIs, collection "NSW GOAT". A
  re-run without `--replace` errors. A re-run with `--replace` keeps the
  counts unchanged, with no duplicates.
- Web (browser pane): the collections are listed, the G.O.A.T routes render
  colored, the POI icons/filtering work, the planned heat is blue, and the
  recorded heat/stats are unchanged. Spot-check a stats endpoint before and
  after the import.

## Post-merge runbook (shared DB)

Everything above was built and verified against a scratch clone
(`dingo_planned`, worktree `.env`, daemon on :3101). The reason: unmerged
migrations recorded in the shared DB break main-built daemon restarts.
After this branch merges to main:

1. Rebuild + restart the live daemon (it applies `20260729000001` itself).
2. Delete the legacy GOAT imports. The provenance key was verified
   2026-07-29 (the two filename prefixes; the only regex near-miss was a
   "Goat Ridge Rd" directions file, and the prefixes exclude it):
   ```sql
   DELETE FROM rides r USING files f
   WHERE r.file_id = f.id
     AND (f.original_name ILIKE 'The G.O.A.T%'
          OR f.original_name ILIKE 'The\_G\_O\_A\_T%');
   -- 411 rows on the 2026-07-29 snapshot
   ```
3. Import the 9 archives from `~/Desktop/Projects/Dingo-data/planned-routes/`
   with `dingo routes import <file> --collection "<label>"`. Use the
   collection table above. The locality pass runs automatically.
4. `dingo export offline` / library export-on-import will prune the deleted
   rides' library files on the next run. The export_tree is now
   recorded-only, so the 433 planned routes stay out of the library tree.
   They live in offline bundles under Routes/<Collection>/ instead.

## Rollout

A single PR is fine. The schema + backend + web land together, and nothing
reads the new columns until the same PR's UI does. Run the `cargo sqlx` build
against the live DB per CLAUDE.md. Verify the daemon + web with the running
stack.
