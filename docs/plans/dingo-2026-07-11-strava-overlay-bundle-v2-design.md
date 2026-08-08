# Strava heatmap overlay, export bundle v2, and group ride — design

Date: 2026-07-11
Status: approved, implementation starting with the Strava login spike.

This design has three related pieces of work. The work spans two repos (Dingo + DingoNav at
`~/Desktop/Projects/DingoNav`):

1. Add the Strava global heatmap as a live overlay in the Dingo web UI. Use a server-side login for authentication, not pasted cookies.
2. Make the export "bundle v2". This is one `.dingonav` zip that holds the Rides, the Heatmap, the Strava heatmap tiles, and the map tiles. Then one URL + one file can share a ride.
3. Add the group ride to DingoNav. Check the existing ntfy-based position sharing. Add rider names (tap a dot for a callout). Make the ride code travel in the bundle.

## Background

Strava never shows the GPS data behind the global heatmap. Strava serves pre-rendered raster PNG tiles. Since 2018, the high-zoom tiles (z ≥ ~12, the useful tiles for trails) need an authenticated session. The tiles come from
`https://heatmap-external-{a,b,c}.strava.com/tiles-auth/all/hot/{z}/{x}/{y}.png`
plus CloudFront signed-cookie params (`Key-Pair-Id`, `Policy`, `Signature`). These params come from a logged-in session. The cookies expire after about 1 week. OAuth cannot make these cookies. Only a real strava.com web session can make them.

Bulk-scraping of tiles for offline storage breaks Strava's terms. A live overlay while you are logged in is the commonly tolerated pattern. (Strava permits this pattern for OSM editing.) The design keeps the offline Strava tile volume small and throttled to stay low-profile. This is a personal-account tradeoff that Grant has accepted.

## Section 1 — Strava heatmap overlay (Dingo web UI)

### Daemon (`crates/daemon`, new `strava` module)

- Config: `.env` gets `STRAVA_EMAIL` / `STRAVA_PASSWORD` (add them to `.env.example`
  as empty keys). The login is lazy. The first heatmap request starts the login, never the daemon startup. Thus a missing or broken Strava login can never block boot.
- Login flow: GET the login page for the CSRF `authenticity_token`. POST the credentials to the session endpoint. Then hit the heatmap auth endpoint to get the three CloudFront cookies.
- Cookie cache: keep the cookies in memory plus a small DB table, so they stay through daemon restarts. The daemon refreshes the cookies automatically in two cases. Case one: a tile fetch starts to return a 403. Case two: the expiry of the Policy is within about 1 day.
- Proxy route: `GET /api/strava-heatmap/{z}/{x}/{y}.png?color=hot&activity=all`
  attaches the cookies and proxies to `heatmap-external-{a,b,c}.strava.com`. The route streams the PNG back. The route caches the tiles on disk (`files/strava-tiles/`) with a TTL of about 2 weeks. Then a pan does not hit Strava again.

### Spike (do this first — gates all Strava work)

Write a throwaway test that tries the login with the real account. Strava moved many accounts to email-code login (~2024). If the account still accepts the password login, continue with the daemon module as designed. If the account demands an email code, stop and build plan B. Plan B is a "Connect Strava" button that opens the strava.com login in a popup. Then a bookmarklet or an extension gets the three cookie values and POSTs them to the daemon. All downstream parts (the proxy route, the disk cache, the UI layer, the bundle export) are identical in both plans. Only the module that gets the cookies changes.

### Web UI

- Add a new "Strava heatmap" layer toggle next to the existing layer controls.
- Point a MapLibre raster source at the daemon proxy, with about 60% opacity. Render it *under* the user's own heatmap, so their tracks stay dominant.
- Hardcode `all`/`hot` at the start. Color selectors and activity selectors are a later nicety.

## Section 2 — Export bundle v2 (the one-file handoff)

### Format

The DingoNav destination changes from a bare `bundle.json` to one **zip** named
`<ride-or-area>.dingonav`:

```
ride.dingonav (zip)
├── bundle.json            tracks + heatmap GeoJSON + manifest (versioned "2")
├── basemap.pmtiles        corridor extract (if Map tiles ticked)
└── strava/{z}/{x}/{y}.png corridor tiles (if Strava heatmap ticked)
```

### Export dialog

The dialog has four checkboxes: **Rides** (the selected GPX tracks — today's "Tracks"), **Heatmap** (your own heatmap with the `other`/`plan` classes — unchanged), **Strava heatmap** (new), and **Map tiles** (new). The existing manifest panel reports what went in: the track count, the heatmap ride count, the Strava tile count + zoom range, and the basemap size.

### Corridor logic (daemon, shared by both new checkboxes)

Union the selected tracks. Buffer them by about 1.5 km. Compute the covering tile set for zooms 11–15. One polygon drives both outputs:

- **Strava tiles:** the daemon fetches them through the Section 1 proxy and cache. Thus tiles that you already viewed in the web UI cost zero new Strava hits. The fetch is throttled (about 1 per second, shuffled) and hard-capped at **600 tiles**. If the corridor needs more tiles, the export trims the deepest zoom first. The manifest says so explicitly. There is never a silent overrun.
- **Basemap:** the daemon shells `pmtiles extract --bbox=<corridor bbox>` against the local area file. In two cases, the manifest flags the problem and the bundle ships without a basemap. Case one: the CLI is missing. Case two: the ride falls outside the area file. (DingoNav's auto-download still covers the Central Coast.)

The existing OsmAnd/Locus/DMD2 GPX destinations do not change.

## Section 3 — DingoNav: opening the bundle, offline layers

- **Open:** add "Open bundle…" in the ☰ menu (next to the pmtiles loader). Add a drag-drop target. Add a PWA file-handler registration for `.dingonav`. Then a tap on the file in WhatsApp or Files offers "Open with DingoNav". Parse the zip with vendored **fflate** (~30 KB, which keeps the no-CDN/offline rule).
- **Storage:** all data lands in IndexedDB. Tracks + heatmap merge or replace, versioned by the bundle name. Then a re-import does not make duplicates. The app stores `basemap.pmtiles`. If the current basemap does not cover the bbox of the ride, the app offers the stored file as the active basemap. The Strava tiles go into an IndexedDB tile store.
- **Rendering Strava tiles:** a raster layer between the basemap and the heatmap. A MapLibre protocol handler (`stravabundle://{z}/{x}/{y}`) serves the layer from IndexedDB. Missing tiles render nothing. The basemap shows through — no broken-tile placeholders. Add a ☰ toggle. The default is **on** when a bundle carries tiles.
- **Friend flow:** send the app URL + one `.dingonav`. The first open online installs the PWA. When the friend opens the file, the app loads all the data. After that, the whole ride works with zero signal. On the Central Coast, the auto-downloaded basemap makes the extract redundant. This is acceptable for the general case.

## Section 4 — Group ride: verify + names

- **Verify first:** run the existing ntfy flow end-to-end (two sessions, one ride code). Make sure that the positions round-trip. Make sure that the dots render and expire. Fix what is broken before you polish.
- **Names:** the first join of a ride code prompts for a name. The app stores the name on-device, and you can edit it in ☰. The ntfy position payload carries the name. When you **tap a dot**, a callout shows the name, the distance from you, and *last seen Xs/min ago*. There are no permanent labels at speed. Each rider gets a deterministic color (a hash of the name). Dots fade when a position is older than about 2 minutes. Then you cannot take a stale dot for a live dot.
- **Discoverability:** Dingo's export dialog gets an optional "Group ride code" field. If you set the field, the export writes the code into `bundle.json`. DingoNav then auto-joins that code when the bundle loads. The one file then carries the whole ride: the map, the tracks, the heatmaps, and the channel for the shared location.

## Build order

1. Strava login spike (gates all Strava work).
2. Daemon proxy + web UI layer.
3. Bundle v2 export (zip, corridor tiles, pmtiles extract).
4. DingoNav bundle import + tile layer.
5. Group ride verify + names.

Do steps 1–3 in Dingo. Do steps 4–5 in DingoNav.

## Risks / open questions

- **Login method** — the spike resolves this (password vs. email-code → plan B).
- **ToS exposure** — corridor-only, capped, throttled, disk-cached tiles decrease this risk. The personal-account risk is accepted.
- **`pmtiles` CLI dependency** — the daemon shells out. When the CLI is absent, the export degrades to bundles with no basemap.
