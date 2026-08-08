# Google Maps URL import & shared turn cues — design

2026-08-03. Brainstormed and validated section-by-section with Grant.

This design has two features. We designed them together, because the first caused the second:

1. **Google Maps URL import** — paste a `maps.app.goo.gl` / `google.com/maps/dir/`
   link into Plan's Import dialog. The link becomes a normal library **plan**
   (a timeless track, `TrackType::Route`).
2. **Turn cues** — every imported track (plans *and* recorded rides) gets
   turn markers where it moves between roads with different names. The system stores them as
   **shared junction marks**. The system writes them into every exported GPX as `<wpt>`
   cues. The cues are quiet in the bush (unnamed trails make no cues). The cues are busy on road rides.

## Decisions made during brainstorming

- Destination: a stored plan in Dingo (not a bare GPX download). Entry point:
  the existing web Import dialog only. (We can add a CLI wrapper easily later.)
- Route geometry: the **Google Routes API** (`computeRoutes`). The point of
  a pasted Google link is the route *as Google shows it*. A key is necessary.
  We rejected OSM re-routing. (It can silently pick different roads.)
- Turn cues apply to **all tracks**, not only to plans. "Export a past ride
  and follow it again" is a real use case. Bush tracks silence themselves.
- Road names come from a **local OSM roads table in PostGIS** (the gazetteer
  pattern). We rejected Valhalla (too much ops). We rejected online APIs. (Rate limits kill
  the backfill, and online APIs go against the local-first rule.)
- Cues live in the **marks concept**, not in a private per-ride table. This is the same
  vocabulary that DingoNav already renders (kind `turn`, dir L|R|S). This is the same
  review/prune idea as pack marks. We add new sibling tables. We do not
  refactor the live `pack_mark_edits` harvest/review/publish flow.
- A mark is **junction-level and direction-agnostic**. There is one row per corner
  (one road pair). Every track through the corner shares the row. The manoeuvre (dir,
  from/onto, distance along the track) lives on the per-ride link. The manoeuvre
  "fires" only for tracks that actually change roads there. A through-rider gets
  no link and no cue.

## 1. Google Maps URL import

Plan's Import dialog gets a "Google Maps URL" input above the file drop
zone. A submit sends `POST /api/import/gmaps { url, source?, origin, owner_id? }`.

Daemon flow:

1. **Resolve shortlink** — follow the redirects (HEAD, no body) from
   `maps.app.goo.gl/…` to the full `/maps/dir/` URL.
2. **Parse the URL** — get the ordered waypoint names from the path segments.
   Get the precise lat/lons from the `data=` blob (`!3d<lat>!4d<lon>` pairs).
   Get the travel mode from `!3e` (0 drive, 1 cycle, 2 walk → the Routes API travel
   mode, default DRIVE). Example (the Greenbank Dr loop): 4 waypoints, `!3e0`.
3. **Call Routes API** — send the waypoints as origin/destination/intermediates.
   Request the encoded polyline. The key comes from `GOOGLE_MAPS_API_KEY`
   (`.env`/config, gitignored — never committed). If the key is missing, return a 422 with a
   setup hint.
4. **Synthesize GPX** — write the decoded polyline as one `<trk>` with **no
   timestamps**. Then the existing parser classifies it as `TrackType::Route`
   (a plan). The GPX metadata records the source URL and the waypoint names.
5. **Feed the normal import pipeline** — this is the same code path as a file upload
   (the default source tag is `google-maps`): the content-addressed store, the cleaning,
   the gazetteer naming, the library placement, and the turn-cue enrichment (below).
   The response uses the result shape of the Import dialog again. Thus the UI shows where
   the plan landed, and the plan shows on the map immediately.

New code: a `google` crate (URL resolve/parse, the Routes API client) + a thin
daemon route.

## 2. Shared junction marks

We add two tables. They are siblings of `pack_mark_edits`, which does not change:

**`turn_marks`** — one row per distinct junction:
- the point geometry (the corner)
- `road_a`, `road_b` — the road pair, stored in normalized (sorted) order, so
  Putty×Cobah ≡ Cobah×Putty
- `source` (`roads` now; `rider`/`google` possible later)
- `status` (`active` | `rejected`)

One row covers **every direction of travel** through that corner.

**`ride_turn_marks`** — the per-ride firing details:
- `(ride_id, mark_id)`
- `dir` (L|R|S — computed from the bearing change of *that track*)
- `from_road`, `onto_road` (ordered, per the direction of this track)
- `dist_m` — the distance along the track of the ride (this orders the cues at export)

The system makes a link row only when the turn detection sees that the ride changes named
roads at the junction. Thus "fires only if needed" falls out of the model.

**Lifecycle:**
- Import/backfill: compute the turns of the ride → match the existing `turn_marks`
  (≤ 30 m, the same road pair) → link. Else create + link.
- Recompute (per-ride): drop the links of that ride, then run the compute again. This never touches the
  cues of other rides (the dir is on the link, not on the mark).
- Garbage-collect marks with zero links — **except** `status='rejected'`.
  A rejected mark stays. Then a pruned bad cue stays pruned for every current and
  future track through that corner. The rejection is deliberately
  direction-independent. Bad cues almost always come from bad junction
  data (OSM name splits, service-road noise), not from one approach.

## 3. Roads data & turn detection

**Roads table.** `dingo gazetteer load-roads <australia.osm.pbf>`
(a Geofabrik extract, ~1 GB) parses the PBF in Rust (the `osmpbf` crate). It keeps
only **named** roads/tracks. It loads `roads(name, highway_class,
geom LINESTRING)` with a GiST index — the same pattern as `localities`.
Unnamed bush singletrack never enters the table.

**Detection** (in the `geo` crate; runs at import and on backfill):

1. Resample the cleaned track to spacing near 15 m. For each point, do a KNN search for the nearest
   named road within **25 m**. This gives a sequence of road names, with gaps.
2. **Run-length smooth**: a road counts only when it matches ≥ 3 consecutive
   samples (~45 m). This kills flicker from crossings, overpasses, and parallel
   service roads.
3. Each boundary between two different sustained runs = a candidate turn.
   The transition point = the track point at the boundary.
4. Get `dir` from the bearing change over about 30 m on each side: ≥ 25° → L or R;
   below → S ("continue onto…", the name changes but the road continues).
5. Match or create `turn_marks` as in section 2, with `dist_m` for this track.

v1 scope limits: only named→named transitions make a cue (bush→road emits
nothing). A roundabout reads as a short unnamed gap. It makes one A→B cue
with the overall bearing — crude but serviceable.

**Backfill:** `dingo turns [--all | --area <name>]` computes again over the
library. The per-ride recompute follows section 2.

## 4. Export, packs, config & testing

**Where cues surface.** Every GPX that the system writes gets `<wpt>` markers
from the link rows of the ride, ordered by `dist_m`. The system skips rejected marks. This applies to the
re-exported library files, the `export offline` bundles, the web export, and the
stored GPX of the Google import. The waypoint name = `"L onto Cobah Rd"`
(dir + onto_road). The system sets `sym` so OsmAnd/Locus pick a sensible icon.

**Pack publish** merges the junction cues of the bundled rides with the
rider-harvested marks of the pack into the DingoNav bundle. This is the mark format that DingoNav
already renders. Near-duplicates collapse to the mark of the rider. (A near-duplicate is a rider mark within about 30 m of an auto cue, with the
same dir.)

**Config & errors.** `GOOGLE_MAPS_API_KEY` comes from `.env`/config. The endpoint
returns a 422 with a setup hint when the key is missing. An unresolvable shortlink, an un-parseable
URL, or a Routes API failure → a per-file-style error in the existing import
response shape. Turn detection with an empty `roads` table logs a warning
and skips. Thus imports succeed before `load-roads` has ever run.

**Testing.** Unit tests: URL parsing from fixture URLs (this includes the Greenbank
loop), the polyline decode, and the turn detection on synthetic tracks + a small
committed roads fixture (a few named ways around a `samples/` GPX). Test the Routes
API client against a mocked response. A live-key integration test
runs only when the key env var is present. Thus CI stays green.
