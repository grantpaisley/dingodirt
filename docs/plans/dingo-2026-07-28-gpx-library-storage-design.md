# GPX library storage — design

*2026-07-28 · brainstormed with Grant · status: agreed, not yet implemented*

## Problem

GPX/FIT tracks now arrive from many directions — Grant's recordings, mates'
recordings, drawn plans, bulk route sets (Wikiloc-style) — and should end up
**saved logically** without the uploader curating folders. Today the browsable
library only updates on CLI `organize` runs, its `Recorded/`/`Plans/` split
can't express ownership, and inbox files pile up in a flat `Duplicates/`.

## Decisions

| Question | Decision |
|---|---|
| Organizing principle | **One common location hierarchy**; `owner` and `plan/recorded` are DB attributes, not folders |
| Hierarchy levels | State → **District** (new) → Region → LGA → Suburb, adaptive split/fold rules unchanged |
| Where District comes from | Manual lookup table `district_map(state, region → district)`; unmapped = level skipped |
| Non-loop placement | A non-loop track sits at the **deepest level where its start and end values agree** (Palmdale→Kandos ⇒ loose in `NSW/`) |
| Loop definition | start–end distance < max(500 m, 2 % of track length) — the naming pass's existing rule (`is_closed_loop`), shared so a track named "X to Y" is never *placed* as a loop. Loops keep today's behaviour (placed by start locality) |
| When the tree is written | **Export-on-import**: daemon places tracks right after clean+name; bulk batches run one layout pass at the end; `organize` remains for re-layouts and on-disk drops |
| Filenames | Own recordings unmarked; others tagged `(Macca)`; plans tagged `(wikiloc, plan)` / `(plan)`; tags double as collision-avoiders before `_2` |
| Originals | **Hash store only** (`files/<sha256>.ext`). No browsable originals mirror. Sources are *consumed*: a fully-ingested inbox file (or zip) is deleted from its load location. `Duplicates/` and `Archives/` retired |
| Per-owner heatmap | Parked follow-up — becomes a filter on `owner_id` once this lands |

## Data model

- `district_map(state TEXT, region TEXT, district TEXT, PRIMARY KEY (state, region))`.
  Resolved by JOIN at placement time (no per-ride backfill needed when the map
  changes; edit → re-run organize → tree re-layouts). Seeded by hand /
  small CLI (`dingo district set NSW Mudgee "NSW North"`).
- Rides gain end-point localities (`end_state`, `end_region`, `end_lga`,
  `end_suburb`) and `is_loop`, filled by the naming pass; existing
  state/region/lgas/suburbs keep serving as the start/track key.
- `track_type` and `owner_id` already exist and stay authoritative.

## Placement engine

Extends today's `assign_dirs` (moves to `dingo_export`, shared daemon+CLI):

1. Level key per ride: `[state, district, region, lga, suburb]` (district often
   NULL ⇒ skipped by the adaptive rules like any absent level).
2. **Placement ceiling**: loops contribute their full start key; non-loops
   truncate the key at the deepest start/end agreement, so they can never be
   foldered deeper than that level and lie loose once it splits.
3. Filename = ride name + owner/type tag; same facts embedded in GPX
   `<metadata>` so they survive the file leaving the library.
4. Relocation stays rename-based via `exported_path`.

## Flow

- **Web upload** (files or folders): ingest → hash store → clean → name →
  place; response reports each file's final library path. Upload folder
  structure is not meaningful and not sent.
- **Daemon config**: `DINGO_LIBRARY_PATH` (same root as organize `--dest`).
- **`dingo organize`**: ingest under `--src`, **delete each fully-ingested
  source** (safety invariant: delete only what the hash store provably holds),
  then run the shared placement pass. Zips with unparseable members stay put
  and are reported.
- **One-time migration** on the first new-code organize run: `Recorded/…`
  relocates (moves, not re-exports) into the unified layout, `Plans/` merges in
  with `(plan)` tags, `Duplicates/`+`Archives/` are ingest-verified then
  deleted, empty zones pruned.

## Testing

- Unit: loop threshold edges; ceiling levels (incl. NULL district one end);
  tagging + `_2` fallback; district resolution.
- Tree: fixture layout over `samples/`; migration test asserting moves-not-
  rewrites and correct zone retirement; **never-delete-unverified** test with a
  corrupted file.
- E2E on a scratch DB: folder upload → tagged path on disk; duplicate re-upload
  no-op; bulk batch = single layout pass.

## Rollout

① schema + naming backfill (end localities, is_loop, 3,804 rides) →
② placement engine + organize (eyeball new layout on a manual run) →
③ daemon export-on-import →
④ remove originals-mirror plumbing (keep the folder-select UI).
Each step lands usable on its own.
