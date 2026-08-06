# Inbox workflow, Plans/Recorded split, and plan dedupe

*2026-07-07 — implemented on `feat/organize-plans-inbox`*

## Goal

Support the ongoing intake workflow (not just one-shot bootstrap):

1. Watch → Garmin → Strava, monthly Strava export zip
2. GPX from friends (their recordings, possibly with HR)
3. GPX routes from the internet / friends (no timestamps)
4. Self-created trip plans

Decisions (Grant, 2026-07-07):

- A plan AND its later recording may coexist — the UI separates them.
- Near-identical **plans** are the problem → geometry-based dedupe, report
  first then `--apply`.
- The whole library lives in a cloud folder synced into Locus Map, so
  exporting into the tree **is** the Locus upload. No upload-state tracking.
- Top-level `Recorded/` vs `Plans/` split (Locus group toggle); filenames use
  underscores for spaces (directory names keep spaces).

## Library layout

```
DingoLibrary/                    (synced → Locus)
├── Inbox/                       ← drop anything here, any nesting
├── Recorded/<State>/<Region>/<LGA>/*.gpx    (track_type = 'ride')
├── Plans/<State>/<Region>/<LGA>/*.gpx       (track_type = 'route')
├── Archives/                    ← consumed zips
└── Duplicates/                  ← byte-dupe sources + superseded plans
```

Usage: `dingo organize --src DingoLibrary/Inbox --dest DingoLibrary`, then
`dingo dedupe-plans [--apply --dest DingoLibrary]` when plans were added.

## What changed

- **Recursive source walk** (`collect_sources`): loose `.gpx`/`.fit` and
  `.zip` at any depth under `--src`; the dest tree and its four zones are
  never descended into (safe even for `--src == --dest`). Drained Inbox
  subdirectories are pruned.
- **Incremental export**: new `rides.exported_path` (relative to `--dest`)
  records where each ride's GPX lives; re-runs skip rides whose file still
  exists. Plans export under `Plans/`, recordings under `Recorded/`.
- **`dingo dedupe-plans`**: pairwise Hausdorff distance (PostGIS, web-mercator
  metres corrected at centroid latitude, bbox `&&` prefilter) over live plans;
  union-find clustering; keeper = most points, then newest import. Report by
  default; `--apply` sets `rides.superseded_by` on the losers and moves their
  exported files to `Duplicates/`. Superseded plans are excluded from export
  and later dedupe passes. Default threshold 100 m — Hausdorff means a plan
  with an extra >100 m spur does NOT match its base version.
- **Config fix**: the CLI used `Config::default()` and ignored
  `DATABASE_URL`/`DINGO_*` env entirely; it now uses `Config::load()`
  (defaults overlaid by env). The daemon already read the env directly.

## Migration of an existing tree

`exported_path` starts NULL, so the first organize run after this change
re-exports the full library into the new `Recorded/`+`Plans/` layout with
underscore filenames. Old `<dest>/<State>/…` directories from the previous
layout are not touched — delete them manually after eyeballing the new tree.

## Explicitly out of scope (for now)

- Replacing a plan with its recorded version (they coexist by design).
- Dedupe of recorded rides (byte-hash at ingest handles exact re-imports;
  time-window overlap detection exists in `dry_run.rs` as report-only).
- GPX HR/speed extension parsing on ingest (friend GPX HR survives in the
  stored original but not in `raw_time_series`).
