# Marks sync — typed ride cues that flow DingoNav → Dingo Plan → everyone

*Designed 2026-07-18 with Grant. Closes the turn-point loop and upgrades turn points
into typed **marks**. "Bark" is the flavour word for the audio side only.*

## Problem

DingoNav (DN) riders add/remove turn points on the trail. Edits publish live to the
pack's ntfy.sh ride topic and other riders on the same topic apply them in seconds —
that half works. But nothing flows back into Dingo Plan (DP): the "Copy turn edits
for Dingo" clipboard export has no receiving end, so curated edits never reach the
published bundle, and a fresh pack download (or a new rider) starts from raw
auto-detected cues.

Decisions made in the brainstorm:

- **Everyone contributes, Grant reviews** — all riders' edits are harvested, nothing
  bakes into a bundle without per-edit accept/reject in DP.
- **Reject = never bakes** (no active retraction). Riders who received an edit live
  keep it locally; new downloads never see it.
- **Turn points become typed marks** with a 9-type picker.
- **Transport = ntfy harvest + outbox re-announce**, clipboard paste as fallback.

## The mark edit record

The only thing that moves between systems. DN's existing contribution record, extended:

```json
{ "id": "k3j9x2", "op": "add" | "remove",
  "kind": "turn" | "danger" | "obstacle" | "gate" | "creek" | "fuel" | "food" | "lookout" | "camp",
  "dir": "L" | "R" | "S",
  "la": -32.856001, "lo": 150.081774, "t": 1752871320000, "by": "Macca" }
```

- `kind` missing → `turn` (all pre-existing records). `dir` is turn-only:
  auto-inferred from track geometry, tap-to-override in the picker.
- `id` stays DN's hash of op+coords+time; the seen-id set keeps application
  idempotent everywhere. Old DN clients ignore `kind` and still apply the
  geometry add/remove correctly.
- The `spot` op (friends photo spots) is untouched and stays live-channel-only:
  never harvested, reviewed, or baked.

## Three transports

1. **Live (exists today)**: DN → ntfy topic → other riders, ~seconds. Records just
   gain `kind`/`dir`.
2. **Harvest**: ntfy topic cache → DP daemon, on "Check for new edits" and
   automatically right before every publish/refresh. ntfy.sh caches ~12 h, so DN
   additionally re-announces its **entire outbox** (not just unsent) on app open
   with signal and on ride-code change — any rider opening DN inside the review
   window replays the whole group history into the cache. Idempotent by `id` at
   every hop.
3. **Bake**: accepted records ship in the bundle as the `turnEdits` array
   (wire name unchanged — shipped DN clients already replay it on load), plus a new
   `rideName` bundle field.

Clipboard stays as manual fallback: DN's export button (relabelled "Copy mark edits
for Dingo") → paste box in DP's review section, same `{turnEdits:[…]}` blob.

## Ride name / topic convergence

- DP bakes `rideName` = pack name + publish year (e.g. `Kandos2026`) into the bundle.
  **Minted at first publish and frozen on the pack row** — a January refresh must not
  move the group to a new topic.
- DN prefers `rideName` over the filename-derived default (never overwriting a
  user-typed code). Fixes topic fragmentation from messenger file renames
  (`kandos (1).dingonav`).
- Topic derivation unchanged: `dingonav-` + lowercased/sanitised code. DP derives the
  same topic server-side for harvesting.

## DingoNav changes

**Picker.** Tap add-cue zoomed in (or long-press an existing mark to change it) →
full-screen 3×3 panel:

| | | |
|---|---|---|
| **Turn** (pre-selected, shows inferred L/R/S chip, tap to cycle) | **Danger !!!** (yellow alert-triangle) | **Obstacle** (log, washout, rut — includes general caution) |
| **Gate** (open or locked) | **Creek** (water crossing) | **Fuel** (servo) |
| **Pub / food** | **Lookout** (view) | **Camp** |

One tap places the mark, queues the outbox record, closes the panel.

**Rendering.** Per-track cue overlay records gain `kind`/`dir`. Turns keep the arrow
rendering; other kinds render as small typed icon markers. Type carries through
`applyRemoteEdit` and bundle replay.

**Audio (barks).**

| Kinds | Behaviour |
|---|---|
| Danger | Announces ~200 m out with a distinct urgent tone, repeats at 50 m. Never muted. |
| Obstacle, Creek, Gate | Normal turn-style announce at the usual approach distance. |
| Fuel, Pub/food, Lookout, Camp | Silent map markers. |

No per-type mute settings in v1.

**Outbox re-announce.** On app open with connectivity and on ride-code change,
republish the full outbox to the topic (listeners' seen-sets collapse duplicates).

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

Harvest/paste upsert with `ON CONFLICT DO NOTHING` — re-polling or double-pasting is
a no-op. Routes (in `crates/daemon/src/routes/packs.rs`):

| Route | Does |
|---|---|
| `POST /api/packs/{id}/marks/check` | Poll `https://ntfy.sh/{topic}/json?poll=1&since=all`, filter `k:"turn"` messages, upsert. Returns new/pending counts. |
| `POST /api/packs/{id}/marks/paste` | Same upsert from a pasted blob. |
| `GET /api/packs/{id}/marks` | Review list, each edit matched to nearest pack ride track (PostGIS) for ride + km-along-track ordering; unmatched → `off_track`. |
| `POST /api/packs/{id}/marks/{markId}` | Set accepted/rejected; bulk accept-all variant. |

Publish/refresh: harvest-poll first (best-effort), then `build_dingonav` gains an
`accepted_marks` input → bundle `turnEdits` array + `rideName` field.

## Dingo Plan web UI

All in `PackDetail.tsx`, a **Mark edits** section shown once the pack has published:

- Queue ordered by (ride position in pack, km along track); off-track rows last.
  Row: type icon, "Danger !!! added by Macca", ride + km, accept/reject buttons.
  **Click a row → map flies/zooms to the point** with a highlight marker.
- Header: "Check for new edits" (`/marks/check`, reports "3 new"), "Paste edits"
  textarea fallback, summary line "4 pending · 11 baked into v3 · last checked 2 h ago".
- "Accept all" button.
- Accept/reject sets the pack's existing `stale` flag → the existing refresh banner
  nudges republish.
- Map layer while section open: pending marks at reduced opacity, accepted at full —
  the visual diff of the next refresh.

## Edge cases

- **Open topic**: guessable topic means anyone can post junk; the review queue is the
  defence, the harvester skips malformed messages, worst case is bulk-reject.
- **Junction marks** apply to every nearby analysed track in DN (existing, desired —
  the danger barks whichever way you approach). DP's nearest-track match is
  display-ordering only.
- **Removes with no local match** stay in DN's pending list and retry after each
  track analysis (existing behaviour).
- **ntfy down / daemon offline**: check shows an error toast, changes nothing; paste
  covers it. Harvest failure before publish degrades to baking already-accepted marks.
- **Clock skew** between phones only affects cosmetic ordering.

## Testing

- Rust unit: ntfy message parsing; upsert idempotency (same blob twice → no dupes);
  km-ordering query against `samples/` fixtures; bundle assembly asserts `turnEdits`
  + `rideName` present.
- End-to-end by hand: publish → DN demo mode adds a danger mark → check → accept →
  refresh → fresh DN load replays it with the right icon and bark.

## Out of scope (deliberate)

- Active retraction of rejected marks from riders' devices.
- Per-type audio mute settings.
- Free-text labels/notes on marks.
- Harvesting `spot` ops.
