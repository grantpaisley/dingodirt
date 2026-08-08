# GPX library storage — implementation plan

This document is the companion to `2026-07-28-gpx-library-storage-design.md`.
There are four phases. You can land and verify each phase on its own. Branch
note: this branch already carries the folder-*upload* work (dialog
`webkitdirectory` + drop traversal + an originals mirror). This design
supersedes the mirror, and Phase 4 removes it. The dialog folder-selection
work stays.

## Phase 1 — Schema, district CLI, naming backfill

1. **Migration** `20260728xxxxxx_district_and_endpoints.sql`:
   - `CREATE TABLE district_map (state TEXT NOT NULL, region TEXT NOT NULL,
     district TEXT NOT NULL, PRIMARY KEY (state, region))`
   - `ALTER TABLE rides ADD COLUMN end_state TEXT, end_region TEXT,
     end_lga TEXT, end_suburb TEXT, is_loop BOOLEAN`
2. **Naming pass** (`crates/enrich`): where the naming pass resolves the
   start localities of a ride from the gazetteer, also resolve the *end*
   point into the new columns. Store `is_loop` from the existing closure
   rule of the naming pass (max(500 m, 2 % of length) — extracted as
   `is_closed_loop`, so naming and placement can never disagree). A re-run
   of naming updates the existing rides.
3. **CLI** (`crates/cli`): `dingo district set <state> <region> <district>`,
   `dingo district rm <state> <region>`, `dingo district list` — plain
   upserts and deletes on `district_map`.
4. **Tests**: the is_loop threshold edges (around the 500 m floor and the
   2 % rule on a 60 km track); the end-locality resolution on a `samples/`
   fixture.

*Checkpoint: backfill the dev DB. Spot-check `is_loop` and `end_*` on known
rides (a Palmdale loop; any A→B transport leg).*

## Phase 2 — Placement engine + organize rework

1. **Move the layout code** from `crates/cli/src/organize.rs`
   (`assign_dirs`, `unique_path`, `export_tree`, prune helpers) into
   `crates/export`, so the daemon and the CLI share it.
2. **Extend the ride key** to `[state, district, region, lga, suburb]`. The
   district comes from `LEFT JOIN district_map USING (state, region)` in
   the export query. Drop the `Recorded/`/`Plans/` zone split — one tree.
3. **Placement ceiling**: non-loops (`is_loop = false`) truncate their key
   at the deepest level where the start and end values are equal
   (NULL ≠ anything). Loops, and rides with unknown endpoints, keep the
   full start key.
4. **Filenames**: build `name + tag`. The tag is `""` for own recordings
   (owner = the `me` owner or NULL), `(OwnerName)` for others, and
   `(source, plan)` / `(plan)` for `track_type = 'route'`. Try the tagged
   name first. Use `_2` only after the tags collide. Write the same
   owner/source/type/original-name facts into the GPX `<metadata>` in
   `build_ride_gpx`.
5. **Consume sources** in `organize run`: after `ingest_file` succeeds for
   a loose file, make sure that its sha256 exists in the `files` table
   *and* on disk in the hash store. Then delete the source. Do the same
   for a zip after every member is ingested (a zip with any failed member
   stays, and the run reports it). Delete the `move_into`-to-`Duplicates/`
   behaviour entirely.
6. **Migration pass** (the first run with the new code): the existing
   `exported_path` files relocate via the existing rename machinery. The
   `Duplicates/` + `Archives/` contents go through the same
   verify-then-delete ingest. The pass prunes empty `Recorded/`, `Plans/`,
   `Duplicates/`, and `Archives/` folders.
7. **Tests**: a layout fixture over `samples/` (a loop in a suburb, a
   non-loop at the common-ancestor level, a district split that appears
   only when mapped + >30 tracks); a migration test (moves, not rewrites:
   same bytes, new paths); a never-delete-unverified test (corrupt a
   source so ingest fails → the file must survive).

*Checkpoint: run `dingo organize` against a copy of the real library dest.
Eyeball the tree before you point it at the real one.*

## Phase 3 — Daemon export-on-import

1. **Config**: add `library_path` to `dingo_core::Config`
   (`DINGO_LIBRARY_PATH`, default `./library`; Grant sets it to the real
   dest). Document it in `.env.example`.
2. **Import route** (`crates/daemon/src/routes/import.rs`): after the
   existing clean + name steps, run the shared placement pass for the ride
   ids of the batch (a single layout computation per request). The
   per-file `stored` in the response becomes the library path(s) of the
   ride. Update the label of the dialog result view ("saved to …").
3. **Web**: `importFiles` drops the `paths` field. The dialog keeps the
   folder selection (it is the convenient way to queue a big set), but the
   paths are display-only in the queue list.
4. **Tests**: E2E against a scratch DB (the rig from the 2026-07-28
   session): upload a folder of mixed loops and point-to-points with an
   owner → the files appear at the expected tagged paths; re-upload →
   duplicate, no second file; ZIP stays deferred to the CLI.

## Phase 4 — Remove superseded mirror plumbing

1. Delete `mirror_original`/`sanitize_rel_path` + the `paths` handling in
   `import.rs` (keep the per-file scratch-subdir fix that stopped the `N-`
   prefix from landing in `original_name`). Delete `original_store_path`
   from the config and `.env.example`. Delete the `PickedFile.path`
   transport in `hooks.ts`.
2. Keep: the dialog folder input + drop traversal, the extension
   filtering, and dedupe.
3. Sweep: run `rg -n "original_store|originals|paths" crates web` to catch
   strays. Then run the full `cargo test` + `tsc -b` + one E2E re-run.

## Rollout / order of operations on the real stack

1. Land Phase 1. Run the backfill on the 3,804-ride DB.
2. Seed `district_map` with Grant's districts (agreed 2026-07-28): NSW →
   Central / North / South, QLD → North / South; VIC / WA / SA stay
   undivided (no rows → the level is skipped). The region assignments:
   - NSW North: Northern Rivers, New England, Mid North Coast
   - NSW Central: Hunter, Central Coast, Hawkesbury, Sydney, Central West,
     Central Tablelands, Blue Mountains, Orana, Far West
   - NSW South: Southern Highlands, Illawarra, Southern Tablelands, Riverina,
     South Coast, Murray, Snowy Mountains
   - QLD North: Gulf Country, North West Queensland, Central Queensland
   - QLD South: Outback Queensland, Sunshine Coast, South East Queensland,
     Darling Downs
   (adjust at any time with `dingo district set/rm` + an organize re-run)
3. Do Phase 2. Then run a supervised `organize` against a **copy** of the
   library. Then run it against the real one (a one-time relayout).
4. Do Phases 3–4. Rebuild and restart the live :3000 daemon and the :5173
   web.
