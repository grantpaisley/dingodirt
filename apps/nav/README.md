# DingoNav

DingoNav is an offline GPX track follower for the bike. It is a separate
project from [Dingo](https://github.com/grantpaisley/Dingo) — it uses
Dingo's exports. It draws MapLibre GL plus a PMTiles vector basemap (roads,
trails, water, labels — fully offline). The Dingo heatmap and the track
overlays draw on top. North is always up.

## What it does

- **Offline basemap**: one `.pmtiles` file covers the full riding area
  (roads, tracks, rivers, place labels). The app downloads the file
  automatically on first open and stores it on-device (IndexedDB). To change
  areas, use ☰ → *Load .pmtiles basemap…*.
- **Shared tile archive (pack v2)**: if there is no local `.pmtiles` file,
  maps come from the shared archive at `tiles.dingodirt.com`. The app
  prefetches the ride corridor of each pack one time (resumable, with
  progress) and caches it for offline use. When you delete a pack, the app
  releases its tiles. v2 packs are a few hundred KB (`bundle.json` only,
  `formatVersion: 2`). v1 packs with embedded tiles continue to work
  unchanged. Self-hosters: point `localStorage['dtiles-base']` (or a pack's
  `tiles` override) at any archive built with `Dingo/tools/build-tiles/`.
  When the shared archive is live, you can drop the bundled
  `basemap/*.pmtiles` from the deploy.
- **Aerial imagery (personal)**: use ☰ to set a `{z}/{x}/{y}` tile URL (an
  NSW Six Maps preset is included, CC BY 4.0). The *Sat* style then renders
  from that URL. The corridor is cached at z12–15 for offline use. This
  setting is device-only, and it is never part of packs.
- **Terrain shading**: an optional second `.pmtiles` file (elevation, ~8 MB
  per area) adds hillshade relief under the trails. Gullies and ridges are
  easy to read at a glance. The map stays flat, north-up 2D, so the
  fast-follower UX does not change. The app downloads the file
  automatically, the same as the basemap. Toggle it in the settings. Cut
  other areas with `make_hillshade.py`.
- Load **GPX tracks** plus a **heatmap GeoJSON** exported from Dingo. The
  app keeps them on-device. After the first load, all functions work with
  zero signal.
- Select a track → **START** → the app follows you from the **nearest point
  on the track**, in either direction. It detects reverse riding
  automatically, and it mirrors the turn arrows and the chevrons.
- **Beeps on approach** give an alert before alert points, plus vibration
  and a big arrow with a distance HUD:
  - ~160 m: one low beep (turns only)
  - ~55 m: 2× high = turn, 3× rising = hairpin, low-high = junction
- Alerts come from the track geometry (a bearing change ≥45° in ~40 m)
  **and from the heatmap**. Each point where another ridden trail crosses at
  an angle becomes a *junction* alert.
- **Off-track**: more than 60 m away = a buzz plus a red banner with the
  live distance. The app chirps when you are back on the track.
- **Auto-zoom with speed** (fire trail = wide, singletrack = close),
  pinch/± zoom, ⛶ to fit the track, ◎ to re-centre. Rotation is off — north
  stays up.
- **Group ride**: share the app plus a ride code. Riders on the same code
  see each other as green dots (ntfy.sh, updates each ~20 s when online, off
  without signal and with no error).
- The screen stays on (wake lock) while you navigate. **Demo mode** replays
  the selected track at 30 km/h.

## Files

```
index.html        the app (single file of app code)
vendor/           maplibre-gl.js/.css, pmtiles.js (vendored, no CDN — offline)
basemap/          layers.json (style), fonts/, sprites/, central-coast.pmtiles, hillshade.pmtiles
sw.js             service worker: index.html network-first, assets cache-first
manifest.json     PWA manifest (Add to Home Screen)
bundle.json       optional pre-baked tracks+heatmap, auto-loaded on first open (gitignored)
make_bundle.py    builds bundle.json from a heatmap + GPX files
make_hillshade.py cuts basemap/hillshade.pmtiles (terrain DEM) for an area
make_icons.py     regenerates the PWA icons
serve.js          tiny static server (node serve.js [port]) for local hosting
sample-data/      Central Coast heatmap export + 4 real loops (gitignored)
```

## Feeding it from Dingo

```bash
# heatmap GeoJSON (what sample-data/heatmap-central-coast.geojson is):
psql $DATABASE_URL -At -c "SELECT jsonb_build_object('type','FeatureCollection','features', jsonb_agg(
  jsonb_build_object('type','Feature','properties', jsonb_build_object('class',
    CASE WHEN origin='other' THEN 'other' WHEN track_type='route' OR started_at IS NULL THEN 'plan' ELSE 'own' END),
  'geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(cleaned_geometry,0.00012),5)::jsonb)))
  FROM rides WHERE superseded_by IS NULL AND area_id='<AREA_UUID>' AND cleaned_geometry IS NOT NULL" > heatmap.geojson

# tracks: GPX straight from the Dingo library (Recorded/...) or `dingo export bundle`
./make_bundle.py --heatmap heatmap.geojson day1.gpx day2.gpx -o bundle.json
```

## Cutting a basemap for another area

```bash
brew install pmtiles
pmtiles extract https://build.protomaps.com/$(date -v-1d +%Y%m%d).pmtiles my-area.pmtiles \
  --bbox=<minLon>,<minLat>,<maxLon>,<maxLat>
```
The Central Coast + Watagans extract (150.85,-33.75 → 151.85,-32.85, zoom
0-15) is 33 MB. Put the file at `basemap/central-coast.pmtiles` for
automatic download, or load any `.pmtiles` file in the app via ☰. Protomaps
daily builds come from OSM data, and they are free (attribution included).

## Cutting terrain shading for another area

```bash
pip install pmtiles
./make_hillshade.py --bbox <minLon>,<minLat>,<maxLon>,<maxLat>   # or --basemap my-area.pmtiles
```
The script downloads Terrarium elevation tiles (AWS Open Data, free, no key)
at z6–12. It packs them into a raster-dem `.pmtiles` file. MapLibre renders
the hillshade on-device (a cheap shading pass — not live 3D terrain). With
no arguments, the script uses the bounds of `basemap/central-coast.pmtiles`
(~8 MB output). Put the file at `basemap/hillshade.pmtiles` for automatic
download, or load any file in the app via ☰ → *Load .pmtiles terrain…*.

## Putting it on the phone

GPS and service workers need a **secure context** (https or localhost):

1. **Host it** (the easy option, works for friends): push this folder to
   GitHub Pages / Netlify / Vercel. Open the page one time on the phone
   (this downloads the app + the 33 MB basemap + the bundle). Then use *Add
   to Home screen*. The app is fully offline from then on. New GPX loads
   from phone storage need no network.
2. **On-device server**: install Termux and run `python -m http.server` in
   this folder on the phone. Open `http://localhost:8000`. This needs zero
   network at all times.

`http://<laptop-ip>:8139` over Wi-Fi renders the app, but Chrome blocks
GPS/SW on insecure origins. This is good for a look, but not for riding.

## Riding it

1. ☰ → select the track → **START**. Mount the phone. The app beeps before
   each turn and each junction.
2. Multi-day: load the GPX files for the week the night before (they stay on
   the device). Select the track for each day.
3. Drag to look around (follow pauses) → ◎ snaps back. Off-track buzz =
   check the banner.

Privacy: the friends layer publishes your name and position to a public
ntfy.sh topic. The topic name is your ride code. Use a code that no one can
guess, or leave the code blank.
