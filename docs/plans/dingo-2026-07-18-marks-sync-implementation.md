# Marks sync — implementation plan

Companion to [2026-07-18-marks-sync-design.md](2026-07-18-marks-sync-design.md).
Build order: daemon → web → DingoNav (separate repo). Each step compiles/tests green
before the next.

## Step 1 — Migration (Dingo)

`migrations/20260718000003_pack_marks.sql`:

- `pack_mark_edits` table per design (PK `(pack_id, id)`).
- `ALTER TABLE packs ADD COLUMN ride_name text;` — minted at first publish, frozen.

## Step 2 — Daemon routes (`crates/daemon/src/routes/packs.rs`)

- `mark_topic(ride_name)` helper — same sanitisation as DN's `friendTopic()`:
  `'dingonav-' + lowercase + strip [^a-z0-9_-]`.
- `POST /api/packs/{id}/marks/check` — reqwest GET
  `https://ntfy.sh/{topic}/json?poll=1`, parse line-delimited JSON, keep messages
  whose body parses to `{k:"turn", id, op:add|remove, la, lo, t, by, kind?, dir?}`,
  upsert `ON CONFLICT DO NOTHING`. Returns `{new, pending}`. 404s cleanly when the
  pack has no `ride_name` yet (never published).
- `POST /api/packs/{id}/marks/paste` — body `{turnEdits: [...]}`, same validation +
  upsert path (shared fn). Missing `id` → compute DN's hash (same 31-multiply
  algorithm) so hand-edited blobs still dedupe.
- `GET /api/packs/{id}/marks` — pending + accepted edits joined against the pack's
  rides: nearest track within 250 m via `ST_LineLocatePoint` /
  `ST_ClosestPoint` on `cleaned_geom`, returning `ride_id`, `ride_name`, `km`,
  `off_track`. Ordered: pack ride position, then km. Skip rejected.
- `POST /api/packs/{id}/marks/{markId}` — body `{status: "accepted"|"rejected"}`;
  `{markId}` = `all` accepts every pending. Both set the pack's stale marker
  (same mechanism the recipe edits use).
- Unit tests in packs.rs (or a marks.rs module): ntfy line parsing, malformed-skip,
  double-upsert idempotency, hash fallback matches DN's algorithm.

## Step 3 — Bundle baking (`crates/daemon/src/routes/export.rs` + packs.rs)

- `DingoNavOpts` gains `ride_name: Option<String>` and
  `marks: Vec<MarkEdit>`; `build_dingonav` writes both into `bundle.json`
  (`rideName`, `turnEdits` — wire names DN already reads/replays).
- Publish flow in packs.rs: mint `ride_name` if NULL
  (`format!("{name}{year}")` from pack name, publish-year, stored back), best-effort
  `marks_check` first (log-and-continue on error), load accepted marks, pass through.
- Plain `.dingonav` export (non-pack) passes empty marks / no rideName — unchanged
  behaviour.

## Step 4 — Web review UI (`web/src/`)

- `api/hooks.ts`: `usePackMarks(packId)`, `checkPackMarks`, `pastePackMarks`,
  `setMarkStatus` (id or `all`).
- `components/Detail/PackDetail.tsx`: **Mark edits** section (published packs only):
  summary line, Check button, Paste toggle+textarea, track-ordered rows (type icon,
  kind + by, ride + km or "off track", accept/reject), Accept all. Row click →
  `flyTo` the point + transient highlight marker (reuse the map focus mechanism the
  ride list uses).
- Map layer: pending marks (reduced opacity) + accepted (full) while the pack detail
  is open — small IconLayer/ScatterplotLayer in the existing deck stack; lucide-ish
  glyphs matching DN's kinds.

## Step 5 — DingoNav (repo `~/Desktop/Projects/DingoNav`, branch `feat/marks`)

All in `index.html` (single-file PWA):

1. **Record plumbing** — `queueTurnEdit(op, lat, lon, kind, dir)`; `kind`/`dir`
   flow through outbox, ntfy publish body, `applyRemoteEdit`, bundle replay,
   clipboard export. Default `kind:'turn'` when absent (old records/clients).
2. **Overlay + rendering** — `ov.added` entries store `kind`/`dir`; non-turn kinds
   draw as typed glyph markers; turns unchanged.
3. **Picker** — full-screen 3×3 panel replacing the bare add action when zoomed in;
   long-press existing mark → same panel pre-set to its kind; Turn tile shows
   inferred L/R/S chip (from local track bearing change), tap chip to cycle.
4. **Barks** — approach logic: danger fires at 200 m (urgent tone, distinct BEEP
   pattern) + repeat at 50 m, exempt from mute; obstacle/creek/gate use normal turn
   announce distance; fuel/food/lookout/camp silent.
5. **Sync** — on app open with connectivity + on ride-code change: republish entire
   outbox (ignore `sent` flag). Bundle load: `rideName` field wins over
   filename-derived default (still never overwrites a user-typed code).
6. **Labels** — export button → "Copy mark edits for Dingo".

## Verification

- `cargo test -p dingo_daemon` after steps 2–3; manual curl of the four routes
  against the dev DB.
- Web: `npm run dev`, drive the review flow against a real pack, browser-verify
  fly-to + accept → stale banner.
- End-to-end: publish a pack (bundle carries rideName), DN demo-mode adds a danger
  mark, `/marks/check` pulls it, accept, refresh, re-load bundle in DN → mark
  replays with icon + bark. DN regression: old bundle without rideName still
  defaults from filename.
