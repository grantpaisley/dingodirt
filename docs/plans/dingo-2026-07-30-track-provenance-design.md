# Track provenance: owner + original name in the panel, owner/original-name filtering

**Date:** 2026-07-30
**Status:** Validated with Grant (brainstorm session)

## Problem

Grant imported `Jenolan_loop_clean(Fabio).gpx` with the web Import dialog and
did not pick an owner. The ride landed as `origin=other` but `owner=Grant`
(the column default). Then the ride became unfindable: nothing in the UI shows
or searches the original filename, the in-file track name, or the owner. The
fix for the mistake needed psql.

The plumbing already exists — the `owners` table (the 2026-07-12 design),
`rides.owner_id`, `rides.original_name` (the in-file track name),
`files.original_name` (the filename), and `files.source_path`. But the API
and the UI expose none of it.

## Design

### 1. Backend & API (`crates/daemon/src/routes/rides.rs`)

- **RideSummary** gains `owner_id` and `owner` (the display name) via a join
  to `owners`. This feeds the client-side owner facet.
- **RideDetail** gains a provenance block: `owner {id, name, kind}`,
  `original_name` (the in-file track name), `file_name`
  (`files.original_name`), `imported_at`, `imported_from`, and `library_path`
  (`exported_path`).
- **The folder derivation is server-side:** `imported_from` is NULL when
  `files.source_path` is NULL or a `/dingo-import-` temp dir (web uploads —
  browsers never reveal the real folder). Otherwise it is the parent
  directory of `source_path` (CLI ingest/organize).
- **Search** (the `q` param) adds three ILIKE targets: the owner name,
  `r.original_name`, and `f.original_name`. "fabio", "hampton atv", or
  "jenolan_loop_clean" all match.
- **Owner reassignment:** the ride-update route accepts `owner_id` (a
  validated FK). A multi-select reassign = one PATCH per ride, like
  mode-setting. Owner creation reuses the existing `POST /api/owners`.
- No migrations; every column already exists.

### 2. Right panel (DetailPane)

A new **Provenance** section sits below the stats and above Photos:

- **Owner** — a select styled like the mode dropdown, with all owners +
  "Add new owner…" (a component shared with ImportDialog's create form). It
  PATCHes immediately.
- **Original track name** — shown only when it differs from the display name.
- **Original file** — e.g. `Jenolan_loop_clean(Fabio).gpx`.
- **Imported** — the date + "web import", or the real source folder when
  known.
- **Library file** — `exported_path` relative to the library root.
- **Source tag** — the existing free-text `source`, display-only.

Multi-select: the section collapses to the Owner dropdown ("(mixed)" when the
owners differ). A picked value reassigns all selected rides. The hover
preview renders the section read-only.

### 3. Filtering

- The search box: the server-side change above covers it; no UI work.
- An **owner facet** in the layers pane extends the PR #39 own/other split.
  It is an expandable per-owner checkbox list under "Others", with counts
  from the loaded ride list. It is a client-side filter on `owner_id`, and it
  composes with focus mode, the range filters, and the search. The parent
  checkbox = select all/none. Owners with zero tracks are hidden. The state
  persists like the other layer toggles.

### Explicitly out of scope (YAGNI)

Owner-colored rendering, per-owner heat layers, an owner management page, and
folder-tree browsing of the original paths.

## Verification

Run `cargo build` against the live DB (sqlx checks the new joins). Run the
web typecheck. Then do a browser end-to-end check on the Fabio ride: search
"fabio", toggle the Fabio facet row, check the provenance panel, and do an
owner reassign round-trip.

## Data fix applied during the session

We created the owner **Fabio** (`kind=source`, id
`cc29a002-a0e0-42ad-874b-703e2df01678`). We reassigned the ride
`ce054f0d-7b52-4e64-86e4-eb3310e01c10` to him and set its `source` tag to
"Fabio".
