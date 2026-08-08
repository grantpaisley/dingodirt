# GPX library storage — design

*2026-07-28 · brainstormed with Grant · status: agreed, not yet implemented*

## Problem

GPX/FIT tracks now arrive from many directions — Grant's recordings, mates'
recordings, drawn plans, and bulk route sets (Wikiloc-style). The tracks must
end **saved logically**, and the uploader must not curate folders. Today, the
browsable library updates only on CLI `organize` runs. Its
`Recorded/`/`Plans/` split cannot express ownership. Inbox files pile up in a
flat `Duplicates/`.

## Decisions

| Question | Decision |
|---|---|
| Organizing principle | **One common location hierarchy**; `owner` and `plan/recorded` are DB attributes, not folders |
| Hierarchy levels | State → **District** (new) → Region → LGA → Suburb; the adaptive split/fold rules are unchanged |
| Where District comes from | A manual lookup table `district_map(state, region → district)`; unmapped = the level is skipped |
| Non-loop placement | A non-loop track sits at the **deepest level where its start and end values agree** (Palmdale→Kandos ⇒ loose in `NSW/`) |
| Loop definition | start–end distance < max(500 m, 2 % of the track length) — the existing rule of the naming pass (`is_closed_loop`). We share it, so a track named "X to Y" is never *placed* as a loop. Loops keep today's behaviour (placed by the start locality) |
| When the tree is written | **Export-on-import**: the daemon places tracks directly after clean+name. Bulk batches run one layout pass at the end. `organize` remains for re-layouts and on-disk drops |
| Filenames | Own recordings are unmarked; others get the tag `(Macca)`; plans get the tags `(wikiloc, plan)` / `(plan)`. The tags also avoid collisions before `_2` |
| Originals | **Hash store only** (`files/<sha256>.ext`). There is no browsable originals mirror. Sources are *consumed*: we delete a fully-ingested inbox file (or zip) from its load location. `Duplicates/` and `Archives/` are retired |
| Per-owner heatmap | A parked follow-up — it becomes a filter on `owner_id` after this design lands |

## Data model

- `district_map(state TEXT, region TEXT, district TEXT, PRIMARY KEY (state, region))`.
  A JOIN resolves it at placement time (no per-ride backfill is needed when
  the map changes; edit → re-run organize → the tree re-layouts). We seed it
  by hand / with a small CLI (`dingo district set NSW Mudgee "NSW North"`).
- Rides gain end-point localities (`end_state`, `end_region`, `end_lga`,
  `end_suburb`) and `is_loop`. The naming pass fills them. The existing
  state/region/lgas/suburbs continue as the start/track key.
- `track_type` and `owner_id` already exist and stay authoritative.

## Placement engine

This extends today's `assign_dirs` (it moves to `dingo_export`, shared by the
daemon and the CLI):

1. The level key per ride: `[state, district, region, lga, suburb]` (district
   is often NULL ⇒ the adaptive rules skip it, like any absent level).
2. **Placement ceiling**: loops contribute their full start key. Non-loops
   truncate the key at the deepest start/end agreement. Thus we can never
   folder them deeper than that level, and they lie loose once it splits.
3. The filename = the ride name + the owner/type tag. We embed the same facts
   in the GPX `<metadata>`, so they survive when the file leaves the library.
4. Relocation stays rename-based via `exported_path`.

## Flow

- **Web upload** (files or folders): ingest → hash store → clean → name →
  place. The response reports each file's final library path. The upload
  folder structure is not meaningful, and the browser does not send it.
- **Daemon config**: `DINGO_LIBRARY_PATH` (the same root as organize
  `--dest`).
- **`dingo organize`**: ingest under `--src`, then **delete each
  fully-ingested source** (the safety invariant: delete only what the hash
  store provably holds). Then run the shared placement pass. Zips with
  unparseable members stay put, and the CLI reports them.
- **A one-time migration** on the first organize run with the new code:
  `Recorded/…` relocates (moves, not re-exports) into the unified layout.
  `Plans/` merges in with `(plan)` tags. We ingest-verify
  `Duplicates/`+`Archives/`, then delete them. We prune the empty zones.

## Testing

- Unit: the loop threshold edges; the ceiling levels (incl. a NULL district
  at one end); the tagging + the `_2` fallback; the district resolution.
- Tree: a fixture layout over `samples/`; a migration test that asserts
  moves-not-rewrites and the correct zone retirement; a
  **never-delete-unverified** test with a corrupted file.
- E2E on a scratch DB: a folder upload → a tagged path on disk; a duplicate
  re-upload is a no-op; a bulk batch = a single layout pass.

## Rollout

① schema + the naming backfill (end localities, is_loop, 3,804 rides) →
② the placement engine + organize (eyeball the new layout on a manual run) →
③ daemon export-on-import →
④ remove the originals-mirror plumbing (keep the folder-select UI).
Each step lands usable on its own.
