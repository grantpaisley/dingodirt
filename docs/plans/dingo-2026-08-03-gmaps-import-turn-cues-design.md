# Google Maps URL import & shared turn cues — design

2026-08-03. Brainstormed and validated section-by-section with Grant.

Two features, designed together because the second was motivated by the first:

1. **Google Maps URL import** — paste a `maps.app.goo.gl` / `google.com/maps/dir/`
   link into Plan's Import dialog and it becomes a normal library **plan**
   (a timeless track, `TrackType::Route`).
2. **Turn cues** — every imported track (plans *and* recorded rides) gets
   turn markers where it moves between differently-named roads, stored as
   **shared junction marks** and written into every exported GPX as `<wpt>`
   cues. Quiet in the bush (unnamed trails produce no cues), busy on road rides.

## Decisions made during brainstorming

- Destination: stored plan in Dingo (not a bare GPX download). Entry point:
  the existing web Import dialog only (CLI wrapper trivially added later).
- Route geometry: **Google Routes API** (`computeRoutes`) — the point of
  pasting a Google link is the route *as Google shows it*. Key required.
  OSM re-routing was rejected (can silently pick different roads).
- Turn cues apply to **all tracks**, not just plans — "export a past ride
  and follow it again" is a real use case, and bush tracks self-silence.
- Road names come from a **local OSM roads table in PostGIS** (gazetteer
  pattern), not Valhalla (too much ops) or online APIs (rate limits kill
  backfill, contradicts local-first).
- Cues live in the **marks concept**, not a private per-ride table — same
  vocabulary DingoNav already renders (kind `turn`, dir L|R|S), same
  review/prune idea as pack marks. New sibling tables rather than
  refactoring the live `pack_mark_edits` harvest/review/publish flow.
- A mark is **junction-level and direction-agnostic**: one row per corner
  (road pair), shared by every track through it. The manoeuvre (dir,
  from/onto, distance along track) lives on the per-ride link and only
  "fires" for tracks that actually change roads there. A through-rider gets
  no link and no cue.

## 1. Google Maps URL import

Plan's Import dialog gains a "Google Maps URL" input above the file drop
zone. Submit → `POST /api/import/gmaps { url, source?, origin, owner_id? }`.

Daemon flow:

1. **Resolve shortlink** — follow redirects (HEAD, no body) from
   `maps.app.goo.gl/…` to the full `/maps/dir/` URL.
2. **Parse the URL** — ordered waypoint names from the path segments;
   precise lat/lons from the `data=` blob (`!3d<lat>!4d<lon>` pairs);
   travel mode from `!3e` (0 drive, 1 cycle, 2 walk → Routes API travel
   mode, default DRIVE). Example (Greenbank Dr loop): 4 waypoints, `!3e0`.
3. **Call Routes API** — waypoints as origin/destination/intermediates,
   request the encoded polyline. Key from `GOOGLE_MAPS_API_KEY`
   (`.env`/config, gitignored — never committed). Missing key → 422 with a
   setup hint.
4. **Synthesize GPX** — decoded polyline as one `<trk>` with **no
   timestamps**, so the existing parser classifies it `TrackType::Route`
   (a plan). GPX metadata records the source URL and waypoint names.
5. **Feed the normal import pipeline** — same code path as file upload
   (default source tag `google-maps`): content-addressed store, cleaning,
   gazetteer naming, library placement, turn-cue enrichment (below).
   Response reuses the Import dialog's result shape, so the UI shows where
   the plan landed and it appears on the map immediately.

New code: `google` crate (URL resolve/parse, Routes API client) + a thin
daemon route.

## 2. Shared junction marks

Two tables (sibling to `pack_mark_edits`, which is untouched):

**`turn_marks`** — one row per distinct junction:
- point geometry (the corner)
- `road_a`, `road_b` — the road pair, stored in normalized (sorted) order so
  Putty×Cobah ≡ Cobah×Putty
- `source` (`roads` now; `rider`/`google` possible later)
- `status` (`active` | `rejected`)

One row covers **every direction of travel** through that corner.

**`ride_turn_marks`** — the per-ride firing details:
- `(ride_id, mark_id)`
- `dir` (L|R|S — computed from *that track's* bearing change)
- `from_road`, `onto_road` (ordered, per this track's direction)
- `dist_m` — distance along the ride's track (orders cues at export)

A link row is created only when turn detection sees that ride change named
roads at the junction — "fires only if needed" falls out of the model.

**Lifecycle:**
- Import/backfill: compute the ride's turns → match existing `turn_marks`
  (≤ 30 m, same road pair) → link; else create + link.
- Recompute (per-ride): drop that ride's links, re-run. Never touches other
  rides' cues (dir is on the link, not the mark).
- Garbage-collect marks with zero links — **except** `status='rejected'`,
  which is kept so a pruned bad cue stays pruned for every current and
  future track through that corner. Rejection is deliberately
  direction-independent: bad cues almost always come from bad junction
  data (OSM name splits, service-road noise), not from one approach.

## 3. Roads data & turn detection

**Roads table.** `dingo gazetteer load-roads <australia.osm.pbf>`
(Geofabrik extract, ~1 GB) parses the PBF in Rust (`osmpbf` crate), keeps
only **named** roads/tracks, loads `roads(name, highway_class,
geom LINESTRING)` with a GiST index — same pattern as `localities`.
Unnamed bush singletrack never enters the table.

**Detection** (in the `geo` crate; runs at import and on backfill):

1. Resample the cleaned track to ~15 m spacing; per point, KNN nearest
   named road within **25 m** → sequence of road names, with gaps.
2. **Run-length smooth**: a road counts only when matched ≥ 3 consecutive
   samples (~45 m) — kills flicker from crossings, overpasses, parallel
   service roads.
3. Each boundary between two different sustained runs = candidate turn.
   Transition point = track point at the boundary.
4. `dir` from bearing change over ~30 m either side: ≥ 25° → L or R;
   below → S ("continue onto…", name changes but road continues).
5. Match/create `turn_marks` as in section 2, with `dist_m` for this track.

v1 scope limits: only named→named transitions cue (bush→road emits
nothing); roundabouts read as a short unnamed gap, producing one A→B cue
with the overall bearing — crude but serviceable.

**Backfill:** `dingo turns [--all | --area <name>]` recomputes over the
library; per-ride recompute per section 2.

## 4. Export, packs, config & testing

**Where cues surface.** Every GPX the system writes gains `<wpt>` markers
from the ride's link rows, ordered by `dist_m`, skipping rejected: the
re-exported library files, `export offline` bundles, web export, and the
Google import's stored GPX. Waypoint name = `"L onto Cobah Rd"`
(dir + onto_road); `sym` set so OsmAnd/Locus pick a sensible icon.

**Pack publish** merges bundled rides' junction cues with the pack's
rider-harvested marks into the DingoNav bundle — the mark format DingoNav
already renders. Near-duplicates (rider mark within ~30 m of an auto cue,
same dir) collapse to the rider's.

**Config & errors.** `GOOGLE_MAPS_API_KEY` from `.env`/config; endpoint
422s with a setup hint when missing. Unresolvable shortlink, un-parseable
URL, or Routes API failure → per-file-style error in the existing import
response shape. Turn detection with an empty `roads` table logs a warning
and skips — imports still succeed before `load-roads` has ever run.

**Testing.** Unit: URL parsing from fixture URLs (incl. the Greenbank
loop), polyline decode, turn detection on synthetic tracks + a tiny
committed roads fixture (a few named ways around a `samples/` GPX). Routes
API client tested against a mocked response; a live-key integration test
runs only when the key env var is present, so CI stays green.
