# Marks sync — typed ride cues that flow DingoNav → Dingo Plan → everyone

*Designed 2026-07-18 with Grant. This design closes the turn-point loop. It also
upgrades turn points into typed **marks**. "Bark" is the flavour word for the audio
side only.*

## Problem

DingoNav (DN) riders add and remove turn points on the trail. The edits publish
live to the pack's ntfy.sh ride topic. Other riders on the same topic apply the
edits in seconds. That half works. But nothing flows back into Dingo Plan (DP).
The "Copy turn edits for Dingo" clipboard export has no receiving end. Curated
edits thus never reach the published bundle. A fresh pack download (or a new
rider) starts from the raw auto-detected cues.

Decisions made in the brainstorm:

- **Everyone contributes, Grant reviews** — the harvest collects the edits from
  all riders. No edit bakes into a bundle without a per-edit accept/reject in DP.
- **Reject = never bakes** (no active retraction). Riders who received an edit
  live keep it locally. New downloads never see it.
- **Turn points become typed marks** with a 9-type picker.
- **Transport = ntfy harvest + outbox re-announce.** Clipboard paste is the
  fallback.

## The mark edit record

This record is the only thing that moves between the systems. It is DN's
existing contribution record, extended:

```json
{ "id": "k3j9x2", "op": "add" | "remove",
  "kind": "turn" | "danger" | "obstacle" | "gate" | "creek" | "fuel" | "food" | "lookout" | "camp",
  "dir": "L" | "R" | "S",
  "la": -32.856001, "lo": 150.081774, "t": 1752871320000, "by": "Macca" }
```

- A missing `kind` → `turn` (all pre-existing records). `dir` is turn-only. DN
  infers it from the track geometry. You can tap to override it in the picker.
- `id` stays DN's hash of op+coords+time. The seen-id set keeps the application
  of edits idempotent everywhere. Old DN clients ignore `kind` and still apply
  the geometry add/remove correctly.
- The `spot` op (friends photo spots) is untouched and stays live-channel-only.
  The system never harvests, reviews, or bakes it.

## Three transports

1. **Live (exists today)**: DN → ntfy topic → other riders, ~seconds. The
   records only gain `kind`/`dir`.
2. **Harvest**: ntfy topic cache → DP daemon. The harvest runs on "Check for
   new edits" and automatically before every publish/refresh. ntfy.sh caches
   ~12 h. DN thus also re-announces its **entire outbox** (not only the unsent
   records) on app open with signal and on ride-code change. Any rider who
   opens DN inside the review window replays the whole group history into the
   cache. The `id` keeps each hop idempotent.
3. **Bake**: the accepted records ship in the bundle as the `turnEdits` array.
   The wire name stays unchanged, because shipped DN clients already replay it
   on load. The bundle also gains a new `rideName` field.

The clipboard stays as the manual fallback. DN's export button (relabelled
"Copy mark edits for Dingo") → the paste box in DP's review section, with the
same `{turnEdits:[…]}` blob.

## Ride name / topic convergence

- DP bakes `rideName` = pack name + publish year (e.g. `Kandos2026`) into the
  bundle. DP mints the name at first publish and **freezes it on the pack
  row** — a January refresh must not move the group to a new topic.
- DN prefers `rideName` over the filename-derived default. DN never overwrites
  a user-typed code. This fixes topic fragmentation from messenger file renames
  (`kandos (1).dingonav`).
- The topic derivation stays unchanged: `dingonav-` + lowercased/sanitised
  code. DP derives the same topic server-side for the harvest.

## DingoNav changes

**Picker.** Tap add-cue zoomed in (or long-press an existing mark to change
it) → a full-screen 3×3 panel:

| | | |
|---|---|---|
| **Turn** (pre-selected, shows the inferred L/R/S chip, tap to cycle) | **Danger !!!** (yellow alert-triangle) | **Obstacle** (log, washout, rut — includes general caution) |
| **Gate** (open or locked) | **Creek** (water crossing) | **Fuel** (servo) |
| **Pub / food** | **Lookout** (view) | **Camp** |

One tap places the mark, queues the outbox record, and closes the panel.

**Rendering.** The per-track cue overlay records gain `kind`/`dir`. Turns keep
the arrow rendering. The other kinds render as small typed icon markers. The
type carries through `applyRemoteEdit` and the bundle replay.

**Audio (barks).**

| Kinds | Behaviour |
|---|---|
| Danger | Announces ~200 m out with a distinct urgent tone, and repeats at 50 m. Never muted. |
| Obstacle, Creek, Gate | Normal turn-style announce at the usual approach distance. |
| Fuel, Pub/food, Lookout, Camp | Silent map markers. |

v1 has no per-type mute settings.

**Outbox re-announce.** On app open with connectivity, and on ride-code change,
DN republishes the full outbox to the topic. The listeners' seen-sets collapse
the duplicates.

## Dingo daemon

One migration:

```sql
CREATE TABLE pack_mark_edits (
  id         text NOT NULL,            -- DN's hash id (idempotency key)
  pack_id    uuid NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  op         text NOT NULL,            -- add | remove
  kind       text NOT NULL DEFAULT 'turn',
  dir        text,                     -- L | R | S, turns only
  lat        double precision NOT NULL,
  lon        double precision NOT NULL,
  edited_at  timestamptz NOT NULL,     -- DN's t
  edited_by  text NOT NULL DEFAULT 'rider',
  status     text NOT NULL DEFAULT 'pending',  -- pending | accepted | rejected
  PRIMARY KEY (pack_id, id)
);
```

Harvest and paste upsert with `ON CONFLICT DO NOTHING`. A re-poll or a double
paste is thus a no-op. Routes (in `crates/daemon/src/routes/packs.rs`):

| Route | Does |
|---|---|
| `POST /api/packs/{id}/marks/check` | Polls `https://ntfy.sh/{topic}/json?poll=1&since=all`, filters the `k:"turn"` messages, and upserts them. Returns the new and pending counts. |
| `POST /api/packs/{id}/marks/paste` | Does the same upsert from a pasted blob. |
| `GET /api/packs/{id}/marks` | Returns the review list. Matches each edit to the nearest pack ride track (PostGIS) for ride + km-along-track ordering. Unmatched edits → `off_track`. |
| `POST /api/packs/{id}/marks/{markId}` | Sets accepted/rejected. A bulk accept-all variant exists. |

Publish/refresh: the harvest-poll runs first (best-effort). Then
`build_dingonav` gains an `accepted_marks` input → the bundle `turnEdits`
array + the `rideName` field.

## Dingo Plan web UI

All of this lives in `PackDetail.tsx`. A **Mark edits** section shows once the
pack has published:

- The queue is ordered by (ride position in pack, km along track). Off-track
  rows come last. A row shows: the type icon, "Danger !!! added by Macca", the
  ride + km, and the accept/reject buttons. **Click a row → the map
  flies/zooms to the point** with a highlight marker.
- The header has: "Check for new edits" (`/marks/check`, reports "3 new"), a
  "Paste edits" textarea fallback, and the summary line "4 pending · 11 baked
  into v3 · last checked 2 h ago".
- An "Accept all" button.
- Accept/reject sets the pack's existing `stale` flag → the existing refresh
  banner nudges a republish.
- Map layer while the section is open: pending marks at reduced opacity,
  accepted marks at full opacity — the visual diff of the next refresh.

## Edge cases

- **Open topic**: the topic is guessable, so anyone can post junk. The review
  queue is the defence. The harvester skips malformed messages. The worst case
  is a bulk-reject.
- **Junction marks** apply to every nearby analysed track in DN. This is the
  existing and desired behaviour — the danger barks whichever way you
  approach. DP's nearest-track match is for display ordering only.
- **Removes with no local match** stay in DN's pending list. They retry after
  each track analysis (existing behaviour).
- **ntfy down / daemon offline**: the check shows an error toast and changes
  nothing. The paste covers it. A harvest failure before publish degrades to
  baking the already-accepted marks.
- **Clock skew** between phones only affects the cosmetic ordering.

## Testing

- Rust unit: the ntfy message parsing; the upsert idempotency (the same blob
  twice → no dupes); the km-ordering query against the `samples/` fixtures;
  the bundle assembly asserts that `turnEdits` + `rideName` are present.
- End-to-end by hand: publish → DN demo mode adds a danger mark → check →
  accept → refresh → a fresh DN load replays it with the right icon and bark.

## Out of scope (deliberate)

- Active retraction of rejected marks from riders' devices.
- Per-type audio mute settings.
- Free-text labels/notes on marks.
- Harvest of `spot` ops.
