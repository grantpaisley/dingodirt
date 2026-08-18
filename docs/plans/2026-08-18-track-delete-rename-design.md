# Delete and rename a track (and a pack)

Date: 2026-08-18
Branch: `claude/track-delete-rename-399cce`

## Why

Plan can import tracks but cannot remove one. A bad import stays forever.
Renaming is also unreachable from the UI, although the backend has done the
work since PR #33.

## What exists already

- **Track rename — backend complete.** `PATCH /api/rides/{id}/name` writes the
  typed name into `custom_name` and points `name_source` at `custom`
  (`core/rust/daemon/src/routes/rides.rs:398`). The client function
  `renameRide()` exists (`apps/plan/src/api/hooks.ts:584`) but nothing calls it.
- **Track delete — nothing.** No route, no client function, no control.
- **Pack rename and delete — both complete.** Inline name field that saves on
  blur (`apps/plan/src/components/Detail/PackDetail.tsx:453`) and a trash button
  behind a `window.confirm` (`PackDetail.tsx:459`).

## Decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | What does delete mean? | Hard delete: the ride, its file row, and the stored bytes. Re-import brings it back. |
| 2 | A file with several tracks? | Delete the file only when the last ride from it goes. |
| 3 | Scope? | Single track, plus bulk delete of the current selection. |
| 4 | Confirmation? | Inline two-step panel in the Detail pane, showing counts and collateral. |
| 5 | Rename control? | The "Mine" (custom) row of the name picker becomes editable. |
| 6 | Deleted track in a published pack? | Warn in the confirm, delete anyway, bump the pack revision so it reads as stale. |
| 7 | The placed GPX in the library tree? | Delete it, and prune the folder if it becomes empty. |

The rule that follows from decision 1: **delete means gone; import the file
again to get the track back.** Decisions 2 and 7 exist to keep that rule true.

## Backend

### What a delete does

One transaction, three steps, per track.

1. Delete the `rides` row. Existing foreign keys cascade to `segments`, `runs`,
   `pack_rides`, turn marks and planned-route links. `photos.ride_id` becomes
   NULL, so photos survive un-linked.
2. Delete the placed GPX at `library_path`, then remove the folder if it is now
   empty. Import files this GPX (`core/rust/daemon/src/routes/import.rs:265`).
3. Delete the `files` row and its stored bytes, but only when nothing else
   points at that file. Two tests must both pass: no ride remains with that
   `file_id`, and no POI does. `pois.file_id` carries no cascade rule
   (`server/migrations/20260729000001_planned_routes_and_pois.sql:50`), so a
   plain delete would raise an error rather than orphan a POI.

Database work commits first; file work runs after. The worst failure leaves an
orphan file on disk, never a missing track.

### Packs

Before the delete, count the published packs holding any doomed track, and
return their names. Also before the delete — `pack_rides` cascades, so
afterwards those packs cannot be found — touch each holding pack's
`updated_at`.

Built differently from the first draft, which said to bump `revision`.
Packs already report a `stale` flag driven by `updated_at > published_at`
(`core/rust/daemon/src/routes/packs.rs:245`), and `revision` means "which
version a rider is on", so it must not move without a publish. Touching
`updated_at` lights the existing stale banner and needs no new column.

### Routes

New in `core/rust/daemon/src/routes/rides.rs`:

- `DELETE /api/rides/{id}` — one track.
- `POST /api/rides/delete` with `{ride_ids: [...]}` — the bulk case. A body is
  needed, and `DELETE` with a body is awkward through some proxies.
- `POST /api/rides/delete-preview` — read-only, same body, returns the counts
  the confirm panel shows.

The two delete routes return `{deleted, files_removed, packs_affected}`.

## Frontend

### Rename (tracks)

The "Mine" row of `NamePicker` (`apps/plan/src/components/Detail/DetailPane.tsx:16`)
becomes an input. The other three rows stay read-only — their values come from
the file.

The row saves on blur and on Enter; Escape restores the old value. Saving calls
the existing `renameRide()`, which writes `custom_name` and selects the custom
variant, so the radio moves on its own and the pane must not fight it.

An empty custom row shows the placeholder "Type your own name". A blank field on
blur is a no-op. Clearing a custom name is out of scope.

Rename is single-track only, matching the pane's existing rule for per-track
controls.

### Delete (tracks)

A new action row at the foot of the Detail pane holds one red "Delete…" button,
reading "Delete track" for one and "Delete 12 tracks" for a selection. Clicking
it calls the preview route, then opens the inline two-step panel stating the
track count, the file count, and the affected published packs. A second click
commits. The panel closes on Escape and on an outside click.

After the delete the pane clears the selection and invalidates the ride, item,
folder and pack queries.

Escape closes the panel from the capture phase and stops there. App.tsx
clears the whole selection on Escape, which must not happen just for backing
out of a confirm — the same guard MapView already uses while drawing.

### Packs

Backend unchanged. The only change is replacing the `window.confirm` at
`PackDetail.tsx:401` with the same inline two-step panel, keeping its warning
about the share link. The panel is a shared component so the two features cannot
drift apart.

## Tests

Rust, against a scratch database:

- deleting a ride removes its segments, runs and pack rows, and un-links photos;
- a file with two rides survives the first delete and goes with the second;
- a file with a POI attached is never deleted, and the ride delete still succeeds;
- the placed GPX and an emptied folder both go;
- an affected published pack has its revision bumped.

Then the project rule: rebuild the daemon, restart it with CWD `~/DingoData`,
and verify in a real browser through the dev server with a screenshot.

## Out of scope

- Undo, trash view, or soft delete.
- A CLI delete command.
- Automatic heat-tile rebake — tiles are already built on demand
  (`core/rust/export/src/heat_tiles.rs:363`).
- Clearing a custom name back to empty.
- Bulk rename.
