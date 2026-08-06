# Track provenance: owner + original name in the panel, owner/original-name filtering

**Date:** 2026-07-30
**Status:** Validated with Grant (brainstorm session)

## Problem

Grant imported `Jenolan_loop_clean(Fabio).gpx` via the web Import dialog without
picking an owner. The ride landed as `origin=other` but `owner=Grant` (column
default), and then became unfindable: nothing in the UI shows or searches the
original filename, the in-file track name, or the owner. Fixing the mistake
required psql.

The plumbing already exists — `owners` table (2026-07-12 design), `rides.owner_id`,
`rides.original_name` (in-file track name), `files.original_name` (filename),
`files.source_path` — but none of it is exposed in the API or UI.

## Design

### 1. Backend & API (`crates/daemon/src/routes/rides.rs`)

- **RideSummary** gains `owner_id` and `owner` (display name) via a join to
  `owners` — feeds the client-side owner facet.
- **RideDetail** gains a provenance block: `owner {id, name, kind}`,
  `original_name` (in-file track name), `file_name` (`files.original_name`),
  `imported_at`, `imported_from`, `library_path` (`exported_path`).
- **Folder derivation is server-side:** `imported_from` is NULL when
  `files.source_path` is NULL or a `/dingo-import-` temp dir (web uploads —
  browsers never reveal the real folder); otherwise the parent directory of
  `source_path` (CLI ingest/organize).
- **Search** (`q` param) adds three ILIKE targets: owner name, `r.original_name`,
  `f.original_name`. "fabio", "hampton atv", or "jenolan_loop_clean" all match.
- **Owner reassignment:** the ride-update route accepts `owner_id` (validated
  FK). Multi-select reassign = one PATCH per ride, like mode-setting.
  Owner creation reuses the existing `POST /api/owners`.
- No migrations; every column already exists.

### 2. Right panel (DetailPane)

New **Provenance** section below stats, above Photos:

- **Owner** — select styled like the mode dropdown, all owners + "Add new
  owner…" (shared component with ImportDialog's create form). PATCHes
  immediately.
- **Original track name** — only when it differs from the display name.
- **Original file** — e.g. `Jenolan_loop_clean(Fabio).gpx`.
- **Imported** — date + "web import" or the real source folder when known.
- **Library file** — `exported_path` relative to the library root.
- **Source tag** — existing free-text `source`, display-only.

Multi-select: section collapses to the Owner dropdown ("(mixed)" when they
differ); picking a value reassigns all selected. Hover preview renders the
section read-only.

### 3. Filtering

- Search box: covered by the server-side change above; no UI work.
- **Owner facet** in the layers pane, extending the PR #39 own/other split —
  expandable per-owner checkbox list under "Others" with counts from the
  loaded ride list. Client-side filter on `owner_id`, composing with focus
  mode, range filters, and search. Parent checkbox = select all/none; owners
  with zero tracks hidden; state persists like other layer toggles.

### Explicitly out of scope (YAGNI)

Owner-colored rendering, per-owner heat layers, an owner management page,
folder-tree browsing of original paths.

## Verification

`cargo build` against the live DB (sqlx checks the new joins), web typecheck,
then browser end-to-end on the Fabio ride: search "fabio", toggle the Fabio
facet row, check the provenance panel, reassign owner round-trip.

## Data fix applied during the session

Owner **Fabio** created (`kind=source`, id `cc29a002-a0e0-42ad-874b-703e2df01678`);
ride `ce054f0d-7b52-4e64-86e4-eb3310e01c10` reassigned to him and its `source`
tag set to "Fabio".
