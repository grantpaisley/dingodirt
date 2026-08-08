# Marks sync — implementation plan

This document is a companion to
[2026-07-18-marks-sync-design.md](2026-07-18-marks-sync-design.md).
The build order: daemon → web → DingoNav (a separate repo). Each step must
compile and test green before the next step.

## Step 1 — Migration (Dingo)

`migrations/20260718000003_pack_marks.sql`:

- The `pack_mark_edits` table per the design (PK `(pack_id, id)`).
- `ALTER TABLE packs ADD COLUMN ride_name text;` — we mint the value at the
  first publish, then freeze it.

## Step 2 — Daemon routes (`crates/daemon/src/routes/packs.rs`)

- The `mark_topic(ride_name)` helper — it does the same sanitisation as DN's
  `friendTopic()`: `'dingonav-' + lowercase + strip [^a-z0-9_-]`.
- `POST /api/packs/{id}/marks/check` — a reqwest GET of
  `https://ntfy.sh/{topic}/json?poll=1`. Parse the line-delimited JSON. Keep
  the messages whose body parses to
  `{k:"turn", id, op:add|remove, la, lo, t, by, kind?, dir?}`. Upsert with
  `ON CONFLICT DO NOTHING`. The route returns `{new, pending}`. It returns a
  clean 404 when the pack has no `ride_name` yet (never published).
- `POST /api/packs/{id}/marks/paste` — the body is `{turnEdits: [...]}`. It
  uses the same validation + upsert path (a shared fn). If `id` is missing →
  compute DN's hash (the same 31-multiply algorithm), so hand-edited blobs
  still dedupe.
- `GET /api/packs/{id}/marks` — the pending + accepted edits, joined against
  the pack's rides. The join finds the nearest track within 250 m via
  `ST_LineLocatePoint` / `ST_ClosestPoint` on `cleaned_geom`. It returns
  `ride_id`, `ride_name`, `km`, and `off_track`. The order: the pack ride
  position, then km. Skip the rejected edits.
- `POST /api/packs/{id}/marks/{markId}` — the body is
  `{status: "accepted"|"rejected"}`. `{markId}` = `all` accepts every pending
  edit. Both set the pack's stale marker (the same mechanism that the recipe
  edits use).
- Unit tests in packs.rs (or a marks.rs module): the ntfy line parsing, the
  malformed-skip, the double-upsert idempotency, and a check that the hash
  fallback matches DN's algorithm.

## Step 3 — Bundle baking (`crates/daemon/src/routes/export.rs` + packs.rs)

- `DingoNavOpts` gains `ride_name: Option<String>` and
  `marks: Vec<MarkEdit>`. `build_dingonav` writes both into `bundle.json`
  (`rideName`, `turnEdits` — wire names that DN already reads and replays).
- The publish flow in packs.rs: mint `ride_name` if it is NULL
  (`format!("{name}{year}")` from the pack name and the publish year, stored
  back). Then do a best-effort `marks_check` first (log and continue on an
  error). Load the accepted marks, and pass them through.
- A plain `.dingonav` export (non-pack) passes empty marks / no rideName —
  the behaviour is unchanged.

## Step 4 — Web review UI (`web/src/`)

- `api/hooks.ts`: `usePackMarks(packId)`, `checkPackMarks`, `pastePackMarks`,
  `setMarkStatus` (an id or `all`).
- `components/Detail/PackDetail.tsx`: a **Mark edits** section (published
  packs only). It has a summary line, a Check button, a Paste toggle +
  textarea, track-ordered rows, and an Accept all button. Each row shows the
  type icon, the kind + by, the ride + km or "off track", and accept/reject.
  A row click → `flyTo` the point + a transient highlight marker (reuse the
  map focus mechanism that the ride list uses).
- The map layer: pending marks (reduced opacity) + accepted marks (full
  opacity) while the pack detail is open. This is a small
  IconLayer/ScatterplotLayer in the existing deck stack, with lucide-ish
  glyphs that match DN's kinds.

## Step 5 — DingoNav (repo `~/Desktop/Projects/DingoNav`, branch `feat/marks`)

All the work is in `index.html` (a single-file PWA):

1. **Record plumbing** — `queueTurnEdit(op, lat, lon, kind, dir)`.
   `kind`/`dir` flow through the outbox, the ntfy publish body,
   `applyRemoteEdit`, the bundle replay, and the clipboard export. Default to
   `kind:'turn'` when the field is absent (old records/clients).
2. **Overlay + rendering** — `ov.added` entries store `kind`/`dir`. Non-turn
   kinds draw as typed glyph markers; turns are unchanged.
3. **Picker** — a full-screen 3×3 panel that replaces the bare add action
   when the user zooms in. A long-press on an existing mark → the same panel,
   pre-set to its kind. The Turn tile shows an inferred L/R/S chip (from the
   local track bearing change). Tap the chip to cycle it.
4. **Barks** — the approach logic: danger fires at 200 m (an urgent tone, a
   distinct BEEP pattern) + a repeat at 50 m, and it is exempt from mute.
   Obstacle/creek/gate use the normal turn announce distance.
   Fuel/food/lookout/camp are silent.
5. **Sync** — on app open with connectivity + on a ride-code change:
   republish the entire outbox (ignore the `sent` flag). On a bundle load:
   the `rideName` field wins over the filename-derived default (it still
   never overwrites a user-typed code).
6. **Labels** — the export button → "Copy mark edits for Dingo".

## Verification

- Run `cargo test -p dingo_daemon` after steps 2–3. Then manually curl the
  four routes against the dev DB.
- Web: run `npm run dev`. Drive the review flow against a real pack.
  Browser-verify the fly-to, and check that accept → the stale banner.
- End-to-end: publish a pack (the bundle carries rideName). DN demo-mode adds
  a danger mark. `/marks/check` pulls it. Accept it, refresh, and re-load the
  bundle in DN → the mark replays with its icon + bark. The DN regression
  check: an old bundle without rideName still defaults from the filename.
