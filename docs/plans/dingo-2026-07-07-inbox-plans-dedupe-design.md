# Inbox workflow, Plans/Recorded split, and plan dedupe

*2026-07-07 — implemented on `feat/organize-plans-inbox`*

## Goal

Support the ongoing intake workflow (not only a one-shot bootstrap):

1. Watch → Garmin → Strava, and a monthly Strava export zip
2. GPX from friends (their recordings, sometimes with HR)
3. GPX routes from the internet / friends (no timestamps)
4. Self-created trip plans

Decisions (Grant, 2026-07-07):

- A plan AND its later recording can coexist — the UI separates them.
- Near-identical **plans** are the problem → geometry-based dedupe. Report
  first, then `--apply`.
- The whole library lives in a cloud folder synced into Locus Map. Thus an
  export into the tree **is** the Locus upload. No upload-state tracking.
- A top-level `Recorded/` vs `Plans/` split (a Locus group toggle). Filenames
  use underscores for spaces (directory names keep spaces).

## Library layout

```
DingoLibrary/                    (synced → Locus)
├── Inbox/                       ← drop anything here, any nesting
├── Recorded/<State>/<Region>/<LGA>/*.gpx    (track_type = 'ride')
├── Plans/<State>/<Region>/<LGA>/*.gpx       (track_type = 'route')
├── Archives/                    ← consumed zips
└── Duplicates/                  ← byte-dupe sources + superseded plans
```

Usage: run `dingo organize --src DingoLibrary/Inbox --dest DingoLibrary`.
Then run `dingo dedupe-plans [--apply --dest DingoLibrary]` after you add
plans.

## What changed

- **Recursive source walk** (`collect_sources`): it collects loose
  `.gpx`/`.fit` and `.zip` at any depth under `--src`. It never descends into
  the dest tree and its four zones (safe even for `--src == --dest`). It
  prunes drained Inbox subdirectories.
- **Incremental export**: the new `rides.exported_path` (relative to
  `--dest`) records where each ride's GPX lives. Re-runs skip rides whose
  file still exists. Plans export under `Plans/`, recordings under
  `Recorded/`.
- **`dingo dedupe-plans`**: the pairwise Hausdorff distance (PostGIS,
  web-mercator metres corrected at the centroid latitude, a bbox `&&`
  prefilter) over the live plans; union-find clustering; the keeper = the
  most points, then the newest import. It reports by default. `--apply` sets
  `rides.superseded_by` on the losers and moves their exported files to
  `Duplicates/`. The export and later dedupe passes exclude superseded plans.
  The default threshold is 100 m — Hausdorff means a plan with an extra
  >100 m spur does NOT match its base version.
- **Config fix**: the CLI used `Config::default()` and ignored
  `DATABASE_URL`/`DINGO_*` env entirely. It now uses `Config::load()`
  (defaults overlaid by env). The daemon already read the env directly.

## Migration of an existing tree

`exported_path` starts NULL. Thus the first organize run after this change
re-exports the full library into the new `Recorded/`+`Plans/` layout with
underscore filenames. The run does not touch old `<dest>/<State>/…`
directories from the previous layout. Delete them manually after you eyeball
the new tree.

## Explicitly out of scope (for now)

- Replacement of a plan with its recorded version (they coexist by design).
- Dedupe of recorded rides (the byte-hash at ingest handles exact
  re-imports; time-window overlap detection exists in `dry_run.rs` as
  report-only).
- GPX HR/speed extension parsing on ingest (friend GPX HR survives in the
  stored original but not in `raw_time_series`).
