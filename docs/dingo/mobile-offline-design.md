# Dingo Mobile & Offline Design — decisions record (2026-07-02)

Outcome of requirements grilling for two features: (A) Android app for on-ride use,
(B) performance strategy for displaying all tracks in an area.

## Decisions

| Question | Decision |
|---|---|
| Recording source | Garmin watch FIT stays source of truth (has HR). Phone records a **backup breadcrumb**; visible live on the map; auto-ingested as a ride only if no Garmin file covering that time window arrives within a few days. |
| Connectivity | **Fully offline on the trail, sync at home.** No cloud, no VPN dependency mid-ride. |
| Whose tracks | Mine + friends' GPX. Rides gain an `owner` and a `kind` (**recorded** \| **planned**). |
| Friend tracks | **Matched but excluded from stats** — friends' rides create runs against segments (so "Dave rode this" is answerable) but owner-filtered out of segment_dir_stats, Dingo scores, and *my* heat. |
| Plans | **Plans become segment intents** — a planned route is matched against the segment network: "this plan covers 12 segments, 3 you've never ridden." No timestamps/HR, never contributes to stats. |
| On-ride display | **Segment lines, heat-coloured** (segments are the display primitive — raw tracks never ship to the map). **Orange = mine, blue = others** (Strava convention). Per-direction stats + Dingo score **on tap**. Layer-visibility **toggle icons** (mine / others / plans / direction view). |
| Coverage gaps | **Segmentise everything.** Every ingested ride must end 100% covered by segments; unmatched portions auto-create `unreviewed` segments. "Never ridden here" must never lie on a remote ride. Makes the consensus-geometry TODO and split/merge quality the critical path. |
| Bundles | **Region (~50×50 km)** for enduro/MTB days; **corridor around a plan** for multiday ADV rides. |
| Basemap | **Self-hosted OSM vector tiles** (PMTiles via Planetiler from Geofabrik AU extracts). Free, licensed for offline. MapTiler (current web basemap) does not permit bulk offline download. |
| App stack | **Native Kotlin + MapLibre Native** (performance-first: foreground-service GPS, proper offline tile handling). |

## The performance hack, stated plainly

Strava's map is fast because clients draw pre-rendered heat tiles, never raw tracks.
Dingo's equivalent: **segments ARE the summarisation.** The bundle ships segment
geometries + heat attributes (run_count, last_ridden, per-dir stats, scores), not rides.
A 50×50 km region is thousands of segments ≈ a few MB of SQLite — no segment MVT needed
initially. PMTiles is only for the basemap. The web UI gets the same win by rendering
segments (currently it draws rides).

## Derived backend work (Rust)

1. **Schema:** `owner` on rides (+ owners table), `kind` enum (`recorded` | `planned`).
   Stats/score/heat queries filter `owner = me`; run queries can include all owners.
2. **Segmentise everything:** finish consensus geometry (`POST /api/segments` TODO);
   auto-create unreviewed segments from unmatched ride portions; split/merge hardening.
3. **Bundle builder:** endpoint producing a downloadable SQLite bundle for a region bbox
   or a plan corridor: segments (geometry + heat attrs), segment_dir stats/scores, plans,
   plus the PMTiles basemap slice.
4. **Upload endpoint + auth:** `POST` for phone breadcrumbs and friend GPX
   (content-addressed like FIT files); bearer-token auth — daemon currently binds
   0.0.0.0 with no auth, unacceptable once a phone is on the network.
5. **Basemap pipeline:** Planetiler over OSM extracts → PMTiles per region;
   optionally + contours/hillshade from ELVIS DEM later.
6. **Ingest dedup:** phone breadcrumb held as artifact; promoted to ride only if no
   Garmin FIT covers its time window after N days.

## Derived Android work (Kotlin)

- MapLibre Native map: PMTiles basemap + segment overlay from bundle SQLite;
  orange/blue heat styling; toggle icons; tap → segment_dir bottom sheet.
- Foreground-service GPS breadcrumb recorder (backup only, live display).
- Plan overlay + "segments in this plan you haven't ridden."
- Home-WiFi sync: upload breadcrumbs + queued friend GPX (Android share-intent
  "share to Dingo"), pull refreshed bundles.

## Ingest at scale — bootstrap, sync, classification (added same day)

### Bootstrap (5,000+ historical tracks)

Sources: GPX/FIT on disk, Garmin GDPR export archives, Strava bulk export — all in
`~/Desktop/Projects/Dingo-data/` (never committed). History exists 2–3× over, so:

- **Dry-run first:** `dingo ingest --dry-run` reports counts, date ranges, format mix,
  and suspected duplicates before writing anything.
- **Dedup policy:** one ride per overlapping time-window; richest source wins
  (**FIT > Garmin GPX > Strava GPX**); losers kept as content-addressed artifacts
  linked to the winning ride, not ride rows.
- **Idempotent & restartable:** re-running ingest over the same archives is a no-op
  (content hash + time-window checks).

### Ongoing sync (nightly + on command)

- **Garmin primary** (original FIT, native HR) via unofficial client (garth /
  python-garminconnect) — accepted risk: unofficial, may break after Garmin changes;
  isolate in its own module with a "sync health" status.
- **Strava secondary** via official OAuth API to fill gaps; same dedup pass applies.
- `dingo sync` CLI command + nightly schedule; daemon exposes sync status/trigger
  so the phone or web UI can kick it.

### Mode auto-classification

- **Metadata first:** Strava/Garmin activity type (e.g. `EMountainBikeRide`,
  `Motocross`) when present.
- **Heuristics fallback:** moving-speed distribution (MTB/ebike ≲30 km/h avg; enduro
  moto bursty 50–80 peaks, high speed variance; ADV sustained 90+ transit + 200+ km
  days), distance, elevation rate, HR pattern.
- **Confidence lifecycle:** start in *auto-suggest + confirm* (review queue in web UI);
  graduate to *auto-accept above threshold* as confirmations accumulate — confirmations
  are training signal for the thresholds.
- **Prerequisite:** unify the mode enums — `rides.mode` (adv|enduro|mtb|other) vs
  `runs.mode` (adv|enduro|ebike) currently disagree. Fix before bulk import stamps
  5,000+ rows.

### Track library → map composition

Every ingested track is kept and browsable (the library). Before a ride, individual
raw tracks can be **selectively added to a bundle/map** (e.g. a friend's line from last
year) as an explicit overlay alongside the segment heat — selection happens at
bundle-build time on desktop; the bundle carries the chosen tracks' geometry.

## Suggested phasing

- **A0 — bootstrap:** unify mode enums, owner/kind schema, dedup-aware bulk ingest
  (dry-run → import 5,000+ tracks), classification suggest+confirm queue.
- **A1 — backend prereqs:** segmentise-everything, bundle endpoint, upload endpoint +
  token auth, PMTiles pipeline, Garmin/Strava sync (nightly + on command).
- **B — app MVP:** map + region bundle + breadcrumb + tap stats + sync.
- **C — richer:** plan intents + corridor bundles, share-intent GPX, direction view
  toggle, classification auto-accept, web UI segment rendering reuse.
