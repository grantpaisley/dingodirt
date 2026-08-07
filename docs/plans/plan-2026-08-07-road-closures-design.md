# Plan: road closures overlay — design

2026-08-07. Prompted by the Flinders flooding: many outback roads/tracks are
closed and Plan should show them while planning.

## Sources (both free, no keys)

**SA — DIT Outback Road Warnings** (authoritative for the outback tracks):
`https://maps.sa.gov.au/arcgis/rest/services/DPTIExtTransport/FNRR2/MapServer/0/query`
with `f=geojson`. Full road-section polylines with `STATUS` 1 Open / 2 Open
With Warnings / 3 4WD-HV / 4 4WD / 5 Closed, free-text `COMMENTS`,
`AREA_NAME`. ~800 KB statewide, CC-BY 4.0 (Government of South Australia).
CORS is open but we proxy anyway so one endpoint serves everything.

**NSW + VIC — VicTraffic aggregate**:
`https://api.traffic.transport.vic.gov.au/disruptions?baselineId=0&lastSeenId=0&cursor=…`
VicTraffic's own backing API aggregates NSW (full state, TfNSW-sourced) and
all VIC feeds into one schema: `impactType` ("Closures"/"Road Closed" = hard
closure), `kind` Planned/Unplanned, `status`, `start`/`end` ISO datetimes,
`closedRoadName`/`from`/`to`, `eventDueTo`, `description`, `geolinesSet`
(encoded polylines, precision 5, **lon-first** pair order), fallback point
`location` [lon, lat]. Paginated ~2000 items/page, ~29 MB for all ~20k items —
far too heavy for the browser, hence the daemon proxy + cache. No auth;
requires a browser-ish User-Agent.

## Decisions (confirmed with Grant)

- **NSW/VIC region filter**: only closures within ~50 km of existing tracks in
  Plan (recorded rides + planned routes) — `ST_DWithin` against the union of
  simplified `cleaned_geometry`, degree-based (0.45°) since it's a coarse
  relevance filter, not navigation.
- **NSW/VIC severity**: hard closures only (`impactType` Closures/Road
  Closed), currently active (`start <= now <= end`), planned + unplanned
  alike. Roadwork lane restrictions stay hidden. SA keeps its full status
  colouring (closed / warnings / 4WD) since the outback feed is curated and
  small.
- **Refinement from testing**: `kind=Planned && eventType=Roadworks` records
  are ALSO excluded — they're thousands of metro maintenance closures
  (Ferntree Gully Rd, ring-road ramps) that drowned the layer (4,323 kept →
  1,090). Everything condition-based stays, including the DPF feed's
  `Seasonal closure` records, which turn out to be Parks Victoria's winter
  forest-track closures — high-value for this app. Direction-duplicate
  records dedupe on (source, name, detail); NSW's HTML descriptions are
  stripped to plain text server-side.
- **Advisory, not authoritative**: a "closed" road is often passable on a bike
  (e.g. NSW-274696 Wanaaring–Bourke). The click card shows the full source
  description, dates, and links to the source page
  (`traffic.transport.vic.gov.au/disruptions/{id}`, or DIT outback roads for
  SA) so the rider judges. No routing behaviour changes.
- Plan-only, online-only. Nav packs are out of scope (separate work in the
  pack builder if ever wanted).

## Daemon: `GET /api/closures` (`core/rust/daemon/src/routes/closures.rs`)

Modelled on `strava.rs` (shared `reqwest` client, disk cache under
`file_store_path`). Raw upstream pulls cached 15 min (`closures/sa.json`,
`closures/victraffic.json`); the merged output is recomputed per request from
cache (cheap, and the rides table can change).

Returns one GeoJSON FeatureCollection; per-feature properties:
`{ src: 'SA' | 'VIC' | 'NSW', id, name, status: 'closed' | 'warning' | '4wd',
detail, kind, updated, url }`. SA statuses map 2→warning, 3/4→4wd, 5→closed
(status 1 Open dropped); VicTraffic features are always `closed`. Features
with no line geometry ship as Points and render as dots.

Failure mode: each upstream is independent — if one fetch fails, serve the
other plus a `warnings` array in the payload rather than 500ing.

## Plan UI

- `useClosures(enabled)` in `api/hooks.ts` — `staleTime` 5 min,
  `refetchInterval` 15 min.
- deck.gl in `MapView.getLayers()`: `GeoJsonLayer` (`closures-layer`) for
  lines — red `#e5484d` closed, amber `#f5a524` warning, orange `#ff8a3d`
  4wd, `pickable` — plus a `ScatterplotLayer` for point-only closures. Drawn
  above tracks (a closure must beat line clutter), below POIs/photos.
- Click → pinned card (same pattern as the POI card): name, status pill,
  detail text, source link.
- `showClosures` in the settings store (default off, persisted; NOT in
  `EffectiveLayers` — live data is never pack content).
- Layers-pane `PaneRow` ("Road closures", TriangleAlert icon) + a small
  attribution line (data: Gov SA / VicTraffic / TfNSW).
