# GPX library storage — implementation plan

Companion to `2026-07-28-gpx-library-storage-design.md`. Four phases, each
landable and verifiable on its own. Branch note: this branch already carries
the folder-*upload* work (dialog `webkitdirectory` + drop traversal + an
originals mirror). The mirror is superseded by this design and is removed in
Phase 4; the dialog folder-selection work is kept.

## Phase 1 — Schema, district CLI, naming backfill

1. **Migration** `20260728xxxxxx_district_and_endpoints.sql`:
   - `CREATE TABLE district_map (state TEXT NOT NULL, region TEXT NOT NULL,
     district TEXT NOT NULL, PRIMARY KEY (state, region))`
   - `ALTER TABLE rides ADD COLUMN end_state TEXT, end_region TEXT,
     end_lga TEXT, end_suburb TEXT, is_loop BOOLEAN`
2. **Naming pass** (`crates/enrich`): where a ride's start localities are
   resolved from the gazetteer, also resolve the *end* point into the new
   columns, and store `is_loop` from the naming pass's existing closure rule
   (max(500 m, 2 % of length) — extracted as `is_closed_loop` so naming and
   placement can never disagree). Re-running naming updates existing rides.
3. **CLI** (`crates/cli`): `dingo district set <state> <region> <district>`,
   `dingo district rm <state> <region>`, `dingo district list` — plain
   upserts/deletes on `district_map`.
4. **Tests**: is_loop threshold edges (around the 500 m floor and the 2 % rule
   on a 60 km track); end-locality resolution on a `samples/` fixture.

*Checkpoint: backfill the dev DB, spot-check `is_loop` and `end_*` on known
rides (a Palmdale loop; any A→B transport leg).*

## Phase 2 — Placement engine + organize rework

1. **Move the layout code** from `crates/cli/src/organize.rs`
   (`assign_dirs`, `unique_path`, `export_tree`, prune helpers) into
   `crates/export` so daemon and CLI share it.
2. **Extend the ride key** to `[state, district, region, lga, suburb]`;
   district comes from `LEFT JOIN district_map USING (state, region)` in the
   export query. Drop the `Recorded/`/`Plans/` zone split — one tree.
3. **Placement ceiling**: non-loops (`is_loop = false`) truncate their key at
   the deepest level where start and end values are equal (NULL ≠ anything).
   Loops and rides with unknown endpoints keep the full start key.
4. **Filenames**: build `name + tag` where tag is `""` for own recordings
   (owner = the `me` owner or NULL), `(OwnerName)` for others,
   `(source, plan)` / `(plan)` for `track_type = 'route'`. Try the tagged name
   first, `_2` only after tags collide. Write the same owner/source/type/
   original-name facts into GPX `<metadata>` in `build_ride_gpx`.
5. **Consume sources** in `organize run`: after `ingest_file` succeeds for a
   loose file, verify its sha256 exists in the `files` table *and* on disk in
   the hash store, then delete the source. Same for a zip once every member
   ingested (a zip with any failed member stays, reported). Delete
   `move_into`-to-`Duplicates/` behaviour entirely.
6. **Migration pass** (first run with new code): existing `exported_path`
   files relocate via the existing rename machinery; `Duplicates/`+`Archives/`
   contents go through the same verify-then-delete ingest; empty `Recorded/`,
   `Plans/`, `Duplicates/`, `Archives/` pruned.
7. **Tests**: layout fixture over `samples/` (loop in suburb, non-loop at
   common-ancestor level, district split appearing only once mapped + >30
   tracks); migration test (moves-not-rewrites: same bytes, new paths);
   never-delete-unverified test (corrupt a source so ingest fails → file must
   survive).

*Checkpoint: run `dingo organize` against a copy of the real library dest and
eyeball the tree before pointing it at the real one.*

## Phase 3 — Daemon export-on-import

1. **Config**: add `library_path` to `dingo_core::Config`
   (`DINGO_LIBRARY_PATH`, default `./library`; Grant sets it to the real dest).
   Document in `.env.example`.
2. **Import route** (`crates/daemon/src/routes/import.rs`): after the existing
   clean + name steps, run the shared placement pass for the batch's ride ids
   (single layout computation per request). Response's per-file `stored`
   becomes the ride's library path(s). Update the dialog result view label
   ("saved to …").
3. **Web**: `importFiles` drops the `paths` field; the dialog keeps folder
   selection (it's the convenient way to queue a big set) but paths are
   display-only in the queue list.
4. **Tests**: E2E against a scratch DB (rig from 2026-07-28 session): upload a
   folder of mixed loops/point-to-points with an owner → files appear at
   expected tagged paths; re-upload → duplicate, no second file; ZIP still
   deferred to CLI.

## Phase 4 — Remove superseded mirror plumbing

1. Delete `mirror_original`/`sanitize_rel_path` + `paths` handling in
   `import.rs` (keep the per-file scratch-subdir fix that stopped the `N-`
   prefix landing in `original_name`), `original_store_path` from config and
   `.env.example`, `PickedFile.path` transport in `hooks.ts`.
2. Keep: dialog folder input + drop traversal, extension filtering, dedupe.
3. Sweep: `rg -n "original_store|originals|paths" crates web` to catch strays;
   full `cargo test` + `tsc -b` + one E2E re-run.

## Rollout / order of operations on the real stack

1. Land Phase 1, run backfill on the 3,804-ride DB.
2. Seed `district_map` with Grant's districts (agreed 2026-07-28): NSW →
   Central / North / South, QLD → North / South; VIC / WA / SA undivided
   (no rows → level skipped). Region assignments:
   - NSW North: Northern Rivers, New England, Mid North Coast
   - NSW Central: Hunter, Central Coast, Hawkesbury, Sydney, Central West,
     Central Tablelands, Blue Mountains, Orana, Far West
   - NSW South: Southern Highlands, Illawarra, Southern Tablelands, Riverina,
     South Coast, Murray, Snowy Mountains
   - QLD North: Gulf Country, North West Queensland, Central Queensland
   - QLD South: Outback Queensland, Sunshine Coast, South East Queensland,
     Darling Downs
   (adjust anytime with `dingo district set/rm` + an organize re-run)
3. Phase 2, then a supervised `organize` run against a **copy** of the
   library, then the real one (one-time relayout).
4. Phases 3–4, rebuild + restart the live :3000 daemon and :5173 web.
