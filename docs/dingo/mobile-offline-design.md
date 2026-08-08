# Dingo Mobile & Offline Design — decisions record (2026-07-02)

This document records the outcome of the requirements grilling for two
features: (A) an Android app for on-ride use, and (B) a performance strategy to
display all tracks in an area.

## Decisions

| Question | Decision |
|---|---|
| Recording source | The Garmin watch FIT file stays the source of truth (it has HR). The phone records a **backup breadcrumb**, visible live on the map. Dingo auto-ingests the breadcrumb as a ride only if no Garmin file that covers that time window arrives in a few days. |
| Connectivity | **Fully offline on the trail; sync at home.** No cloud and no VPN dependency mid-ride. |
| Whose tracks | Mine plus friends' GPX. Rides gain an `owner` and a `kind` (**recorded** \| **planned**). |
| Friend tracks | **Matched but excluded from the stats.** Friends' rides create runs against segments (so "Dave rode this" is answerable). But the owner filter removes them from segment_dir_stats, the Dingo scores, and *my* heat. |
| Plans | **Plans become segment intents.** Dingo matches a planned route against the segment network: "this plan covers 12 segments, 3 you have never ridden." A plan has no timestamps or HR, and it never contributes to the stats. |
| On-ride display | **Segment lines, heat-coloured.** Segments are the display primitive; raw tracks never ship to the map. **Orange = mine, blue = others** (the Strava convention). Per-direction stats plus the Dingo score show **on tap**. Layer-visibility **toggle icons** (mine / others / plans / direction view). |
| Coverage gaps | **Segmentise everything.** Every ingested ride must end 100% covered by segments. Unmatched portions auto-create `unreviewed` segments. "Never ridden here" must never lie on a remote ride. This makes the consensus-geometry TODO and the split/merge quality the critical path. |
| Bundles | **Region (~50×50 km)** for enduro/MTB days. **Corridor around a plan** for multiday ADV rides. |
| Basemap | **Self-hosted OSM vector tiles** (PMTiles, via Planetiler, from Geofabrik AU extracts). Free, and licensed for offline use. MapTiler (the current web basemap) does not permit bulk offline download. |
| App stack | **Native Kotlin + MapLibre Native.** Performance first: foreground-service GPS, and correct offline tile handling. |

## The performance hack, stated plainly

Strava's map is fast because the clients draw pre-rendered heat tiles, never
raw tracks. Dingo's equivalent: **segments ARE the summarisation.** The bundle
ships segment geometries plus heat attributes (run_count, last_ridden, per-dir
stats, scores), not rides. A 50×50 km region is thousands of segments, near a
few MB of SQLite. No segment MVT is needed initially. PMTiles is only for the
basemap. The web UI gets the same win when it renders segments (currently it
draws rides).

## Derived backend work (Rust)

1. **Schema:** add `owner` on rides (plus an owners table) and a `kind` enum
   (`recorded` | `planned`). Stats/score/heat queries filter `owner = me`.
   Run queries can include all owners.
2. **Segmentise everything:** finish the consensus geometry (the
   `POST /api/segments` TODO). Auto-create unreviewed segments from unmatched
   ride portions. Harden split/merge.
3. **Bundle builder:** an endpoint that produces a downloadable SQLite bundle
   for a region bbox or a plan corridor. The bundle holds segments (geometry +
   heat attrs), segment_dir stats/scores, plans, and the PMTiles basemap slice.
4. **Upload endpoint + auth:** a `POST` for phone breadcrumbs and friend GPX
   (content-addressed, like the FIT files). Use bearer-token auth. The daemon
   currently binds 0.0.0.0 with no auth. That is unacceptable after a phone is
   on the network.
5. **Basemap pipeline:** Planetiler over OSM extracts → PMTiles per region.
   Optionally add contours/hillshade from the ELVIS DEM later.
6. **Ingest dedup:** hold the phone breadcrumb as an artifact. Promote it to a
   ride only if no Garmin FIT covers its time window after N days.

## Derived Android work (Kotlin)

- A MapLibre Native map: the PMTiles basemap plus a segment overlay from the
  bundle SQLite. Orange/blue heat styling, toggle icons, and tap → a
  segment_dir bottom sheet.
- A foreground-service GPS breadcrumb recorder (backup only, live display).
- A plan overlay, plus "segments in this plan you have not ridden."
- Home-WiFi sync: upload the breadcrumbs plus the queued friend GPX (an
  Android share-intent "share to Dingo"). Pull refreshed bundles.

## Ingest at scale — bootstrap, sync, classification (added same day)

### Bootstrap (5,000+ historical tracks)

Sources: GPX/FIT on disk, Garmin GDPR export archives, and the Strava bulk
export. All are in `~/Desktop/Projects/Dingo-data/` (never committed). The
history exists 2–3 times over, so:

- **Dry-run first:** `dingo ingest --dry-run` reports the counts, the date
  ranges, the format mix, and the suspected duplicates before it writes
  anything.
- **Dedup policy:** one ride per overlapping time-window. The richest source
  wins (**FIT > Garmin GPX > Strava GPX**). Dingo keeps the losers as
  content-addressed artifacts linked to the winning ride, not as ride rows.
- **Idempotent and restartable:** to run ingest again over the same archives
  is a no-op (content-hash + time-window checks).

### Ongoing sync (nightly + on command)

- **Garmin primary** (original FIT, native HR), via an unofficial client
  (garth / python-garminconnect). Accepted risk: the client is unofficial and
  can break after Garmin changes. Isolate it in its own module, with a
  "sync health" status.
- **Strava secondary**, via the official OAuth API, to fill the gaps. The same
  dedup pass applies.
- Add a `dingo sync` CLI command plus a nightly schedule. The daemon exposes
  the sync status and a trigger, so the phone or the web UI can start a sync.

### Mode auto-classification

- **Metadata first:** use the Strava/Garmin activity type (e.g.
  `EMountainBikeRide`, `Motocross`) when present.
- **Heuristics fallback:** the moving-speed distribution (MTB/ebike ≲30 km/h
  avg; enduro moto is bursty, with 50–80 peaks and high speed variance; ADV is
  sustained 90+ transit plus 200+ km days), the distance, the elevation rate,
  and the HR pattern.
- **Confidence lifecycle:** start in *auto-suggest + confirm* (a review queue
  in the web UI). Graduate to *auto-accept above threshold* as confirmations
  accumulate. The confirmations are the training signal for the thresholds.
- **Prerequisite:** unify the mode enums. `rides.mode` (adv|enduro|mtb|other)
  and `runs.mode` (adv|enduro|ebike) currently disagree. Fix this before a
  bulk import stamps 5,000+ rows.

### Track library → map composition

Dingo keeps every ingested track, and you can browse them all (the library).
Before a ride, you can **add individual raw tracks to a bundle/map** (e.g. a
friend's line from last year). The track becomes an explicit overlay next to
the segment heat. The selection happens at bundle-build time, on the desktop.
The bundle carries the geometry of the chosen tracks.

## Suggested phasing

- **A0 — bootstrap:** unify the mode enums. Add the owner/kind schema. Do a
  dedup-aware bulk ingest (dry-run → import 5,000+ tracks). Add the
  classification suggest+confirm queue.
- **A1 — backend prereqs:** segmentise-everything, the bundle endpoint, the
  upload endpoint + token auth, the PMTiles pipeline, and Garmin/Strava sync
  (nightly + on command).
- **B — app MVP:** map + region bundle + breadcrumb + tap stats + sync.
- **C — richer:** plan intents + corridor bundles, share-intent GPX, the
  direction view toggle, classification auto-accept, and web UI segment
  rendering reuse.
