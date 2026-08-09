# Plan share page — feature parity with Dingo Plan

2026-08-09. The public plan page (`dingodirt.com/p/<token>`, `apps/site/app/p/[token]/PlanView.tsx`)
is a small standalone viewer. Six gaps against the Plan app, reported from the
Flinders2026 page. Agreed scope (Grant picked option 1 on all three decisions).

## 1. Track selection

Today: one active track; a click replaces the selection and zooms.
New: a click on a track adds it to the selection. A second click on a selected
track removes it. Escape clears the selection. A list-row click toggles the
same selection; when it selects, it also zooms to the track.

## 2. POIs in the published plan

The public page cannot call the private daemon. The publish step
(`publish_plan` in `core/rust/daemon/src/routes/packs.rs`) now copies POIs
into the `.dingoplan` doc: every POI within ~20 km of the plan's tracks
(decision A1 — no library-wide leakage). Fields: id, lon, lat, name,
description, category, collection. The viewer draws them as pins with a card,
behind a toggle. Existing `marks` (camps entered in Plan) stay separate.

## 3. Road closures

New Next.js route `apps/site/app/api/closures/route.ts` — a TS port of the
daemon's `closures.rs`:

- SA DIT Outback Road Warnings: served whole, statuses closed/4wd/warning.
- VicTraffic aggregate (NSW+VIC): hard closures only, active now, planned
  roadworks dropped. The daemon filters by distance to the ride library; the
  site has no library, so the route filters by the plan's bounding box
  (`?bbox=minLon,minLat,maxLon,maxLat`, padded ~50 km by the caller).
- Cache: 15 min (route responses via CDN s-maxage; upstream pulls via the
  Next data cache). `maxDuration = 60` for the paginated VicTraffic pull.

Same payload shape as the daemon (`FeatureCollection` + `warnings`), so the
card UI is a straight copy from Plan's MapView.

## 4. Basemaps (decision B1)

Free public sources only, no API key on the page:

| id | source |
|----|--------|
| dingo | shared vector archive, `tiles.dingodirt.com/basemap-au.pmtiles` (pmtiles protocol) |
| topo | OSM raster (as today) |
| satellite | Esri World Imagery (as today) |
| outdoor | OpenTopoMap raster |

The Dingo style is built like Plan's `dingoBasemap.ts` but with the factory
scheme: `core/basemap/layers.json` (dark flavour, matching the site theme) +
`applyBaseOverrides` with no scheme. Assets (layers/fonts/sprites) come from a
`public/basemap -> ../../../core/basemap` symlink, same as Plan. New site
dependency: `pmtiles`.

## 5. Detail toggle (City / Regional / Outback)

Shown only while the Dingo basemap is active. Reuses
`core/appliers/detail.js` (`applyDetailBias`) — same z12 outback floor as the
apps.

## 6. Original track colours (decision C1)

`publish_plan` adds `color` and `collection` per track (the GOAT GPX colours
already stored on rides). The viewer gets a "colour by" switch:

- **Original** (default): the track's own colour; tracks without one fall
  back to the clay accent. Vote verdicts stay visible in the list.
- **Votes**: the current verdict colouring (green/amber/red/grey).

Pack format: additive fields only, schemaVersion stays 1. Older packs render
as before. Flinders2026 must be published again to pick up POIs and colours.

## Not in scope

Photos, heatmap, hillshade/3D, route drawing, gradient colouring — Plan-app
features with no place on a share page yet.
