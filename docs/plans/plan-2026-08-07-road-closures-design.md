# Plan: road closures overlay — design

2026-08-07. The Flinders flooding prompted this design: many outback
roads/tracks are closed, and Plan must show them while the user plans.

## Sources (both free, no keys)

**SA — DIT Outback Road Warnings** (authoritative for the outback tracks):
`https://maps.sa.gov.au/arcgis/rest/services/DPTIExtTransport/FNRR2/MapServer/0/query`
with `f=geojson`. The feed has full road-section polylines with `STATUS`
1 Open / 2 Open With Warnings / 3 4WD-HV / 4 4WD / 5 Closed, free-text
`COMMENTS`, and `AREA_NAME`. The size is ~800 KB statewide, CC-BY 4.0
(Government of South Australia). CORS is open, but we proxy anyway, so one
endpoint serves everything.

**NSW + VIC — VicTraffic aggregate**:
`https://api.traffic.transport.vic.gov.au/disruptions?baselineId=0&lastSeenId=0&cursor=…`
VicTraffic's own backing API aggregates NSW (the full state, TfNSW-sourced)
and all VIC feeds into one schema: `impactType` ("Closures"/"Road Closed" =
hard closure), `kind` Planned/Unplanned, `status`, `start`/`end` ISO
datetimes, `closedRoadName`/`from`/`to`, `eventDueTo`, `description`,
`geolinesSet` (encoded polylines, precision 5, **lon-first** pair order), and
a fallback point `location` [lon, lat]. The API is paginated at ~2000
items/page, and all ~20k items are ~29 MB. That is far too heavy for the
browser — thus the daemon proxy + cache. There is no auth, but the API needs
a browser-ish User-Agent.

## Decisions (confirmed with Grant)

- **NSW/VIC region filter**: only closures within ~50 km of the existing
  tracks in Plan (recorded rides + planned routes). We use `ST_DWithin`
  against the union of the simplified `cleaned_geometry`. The distance is
  degree-based (0.45°), because this is a coarse relevance filter, not
  navigation.
- **NSW/VIC severity**: hard closures only (`impactType` Closures/Road
  Closed), currently active (`start <= now <= end`), planned + unplanned
  alike. Roadwork lane restrictions stay hidden. SA keeps its full status
  colouring (closed / warnings / 4WD), because the outback feed is curated
  and small.
- **Refinement from testing**: we ALSO exclude
  `kind=Planned && eventType=Roadworks` records. They are thousands of metro
  maintenance closures (Ferntree Gully Rd, ring-road ramps) that drowned the
  layer (4,323 kept → 1,090). Everything condition-based stays. This includes
  the DPF feed's `Seasonal closure` records, which are Parks Victoria's
  winter forest-track closures — high-value for this app. Direction-duplicate
  records dedupe on (source, name, detail). The server strips NSW's HTML
  descriptions to plain text.
- **Advisory, not authoritative**: a "closed" road is often passable on a
  bike (e.g. NSW-274696 Wanaaring–Bourke). The click card shows the full
  source description, the dates, and a link to the source page
  (`traffic.transport.vic.gov.au/disruptions/{id}`, or DIT outback roads for
  SA). Thus the rider judges. No routing behaviour changes.
- The feature is Plan-only and online-only. Nav packs are out of scope
  (separate work in the pack builder, if we ever want it).

## Daemon: `GET /api/closures` (`core/rust/daemon/src/routes/closures.rs`)

The route is modelled on `strava.rs` (a shared `reqwest` client, a disk cache
under `file_store_path`). The raw upstream pulls are cached for 15 min
(`closures/sa.json`, `closures/victraffic.json`). The merged output is
recomputed per request from the cache (this is cheap, and the rides table can
change).

The route returns one GeoJSON FeatureCollection; the per-feature properties:
`{ src: 'SA' | 'VIC' | 'NSW', id, name, status: 'closed' | 'warning' | '4wd',
detail, kind, updated, url }`. SA statuses map 2→warning, 3/4→4wd, 5→closed
(status 1 Open is dropped); VicTraffic features are always `closed`. Features
with no line geometry ship as Points and render as dots.

The failure mode: each upstream is independent. If one fetch fails, serve the
other feed plus a `warnings` array in the payload. Do not return a 500.

## Plan UI

- `useClosures(enabled)` in `api/hooks.ts` — `staleTime` 5 min,
  `refetchInterval` 15 min.
- deck.gl in `MapView.getLayers()`: a `GeoJsonLayer` (`closures-layer`) for
  the lines — red `#e5484d` closed, amber `#f5a524` warning, orange `#ff8a3d`
  4wd, `pickable` — plus a `ScatterplotLayer` for point-only closures. We
  draw it above the tracks (a closure must beat line clutter) and below the
  POIs/photos.
- A click → a pinned card (the same pattern as the POI card): the name, a
  status pill, the detail text, and the source link.
- `showClosures` in the settings store (default off, persisted; NOT in
  `EffectiveLayers` — live data is never pack content).
- A layers-pane `PaneRow` ("Road closures", the TriangleAlert icon) + a small
  attribution line (data: Gov SA / VicTraffic / TfNSW).
