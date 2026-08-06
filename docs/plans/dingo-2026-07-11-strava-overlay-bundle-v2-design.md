# Strava heatmap overlay, export bundle v2, and group ride — design

Date: 2026-07-11
Status: approved, implementation starting with the Strava login spike.

Three related pieces of work, spanning two repos (Dingo + DingoNav at
`~/Desktop/Projects/DingoNav`):

1. Strava global heatmap as a live overlay in the Dingo web UI, authenticated
   via a server-side login rather than pasted cookies.
2. Export "bundle v2": a single `.dingonav` zip carrying Rides, Heatmap, Strava
   heatmap tiles, and map tiles — so a ride is shareable as one URL + one file.
3. Group ride in DingoNav: verify the existing ntfy-based position sharing, add
   rider names (tap-a-dot callout), and make the ride code travel in the bundle.

## Background

Strava never exposes the underlying GPS data behind the global heatmap — it
serves pre-rendered raster PNG tiles. Since 2018 the high-zoom tiles (z ≥ ~12,
the useful ones for trails) require an authenticated session. Tiles come from
`https://heatmap-external-{a,b,c}.strava.com/tiles-auth/all/hot/{z}/{x}/{y}.png`
plus CloudFront signed-cookie params (`Key-Pair-Id`, `Policy`, `Signature`)
taken from a logged-in session. Those cookies expire after ~1 week. OAuth cannot
produce them — only a real strava.com web session can.

Bulk-scraping tiles for offline storage violates Strava's terms; using them as a
live overlay while logged in is the commonly tolerated pattern (Strava permits it
for OSM editing). The design keeps offline Strava tile volume small and throttled
to stay low-profile. This is a personal-account tradeoff Grant has accepted.

## Section 1 — Strava heatmap overlay (Dingo web UI)

### Daemon (`crates/daemon`, new `strava` module)

- Config: `.env` gains `STRAVA_EMAIL` / `STRAVA_PASSWORD` (add to `.env.example`
  as empty keys). Login is lazy — triggered by the first heatmap request, never
  at daemon startup, so a missing/broken Strava login can never block boot.
- Login flow: GET the login page for the CSRF `authenticity_token`, POST
  credentials to the session endpoint, then hit the heatmap auth endpoint to
  receive the three CloudFront cookies.
- Cookie cache: in memory plus a small DB table so it survives daemon restarts.
  Refreshed automatically when a tile fetch starts returning 403, or when the
  Policy's expiry is within ~1 day.
- Proxy route: `GET /api/strava-heatmap/{z}/{x}/{y}.png?color=hot&activity=all`
  attaches the cookies, proxies to `heatmap-external-{a,b,c}.strava.com`, streams
  the PNG back, and caches tiles on disk (`files/strava-tiles/`) with a ~2-week
  TTL so panning doesn't re-hit Strava.

### Spike (do this first — gates all Strava work)

A throwaway test that attempts the login with the real account. Strava moved many
accounts to email-code login (~2024); if the account still accepts password
login, proceed with the daemon module as designed. If it demands an email code,
stop and build plan B: a "Connect Strava" button that opens strava.com login in a
popup, then a bookmarklet/extension grabs the three cookie values and POSTs them
to the daemon. Everything downstream (proxy route, disk cache, UI layer, bundle
export) is identical either way — only the cookie-acquisition module changes.

### Web UI

- New "Strava heatmap" layer toggle alongside existing layer controls.
- MapLibre raster source pointed at the daemon proxy, ~60% opacity, rendered
  *under* the user's own heatmap so their tracks stay dominant.
- `all`/`hot` hardcoded initially; color/activity selectors are a later nicety.

## Section 2 — Export bundle v2 (the one-file handoff)

### Format

DingoNav destination changes from a bare `bundle.json` to a single **zip** named
`<ride-or-area>.dingonav`:

```
ride.dingonav (zip)
├── bundle.json            tracks + heatmap GeoJSON + manifest (versioned "2")
├── basemap.pmtiles        corridor extract (if Map tiles ticked)
└── strava/{z}/{x}/{y}.png corridor tiles (if Strava heatmap ticked)
```

### Export dialog

Four checkboxes: **Rides** (selected GPX tracks — today's "Tracks"), **Heatmap**
(own heatmap incl. `other`/`plan` classes — unchanged), **Strava heatmap** (new),
**Map tiles** (new). The existing manifest panel reports what went in: track
count, heatmap ride count, Strava tile count + zoom range, basemap size.

### Corridor logic (daemon, shared by both new checkboxes)

Union the selected tracks, buffer ~1.5 km, compute the covering tile set for
zooms 11–15. One polygon drives both outputs:

- **Strava tiles:** fetched through the Section 1 proxy/cache, so tiles already
  viewed in the web UI cost zero new Strava hits. Throttled (~1/sec, shuffled),
  hard-capped at **600 tiles**. If the corridor needs more, the export trims the
  deepest zoom first and the manifest says so explicitly — never a silent
  overrun.
- **Basemap:** daemon shells `pmtiles extract --bbox=<corridor bbox>` against the
  local area file. If the CLI is missing or the ride falls outside the area file,
  the manifest flags it and the bundle ships without a basemap (DingoNav's
  auto-download still covers Central Coast).

Existing OsmAnd/Locus/DMD2 GPX destinations are untouched.

## Section 3 — DingoNav: opening the bundle, offline layers

- **Open:** "Open bundle…" in the ☰ menu (beside the pmtiles loader), a drag-drop
  target, and a PWA file-handler registration for `.dingonav` so tapping the file
  in WhatsApp/Files offers "Open with DingoNav". Zip parsing via vendored
  **fflate** (~30 KB, preserves the no-CDN/offline rule).
- **Storage:** everything lands in IndexedDB. Tracks + heatmap merge/replace,
  versioned by bundle name so re-import doesn't duplicate. `basemap.pmtiles` is
  stored and offered as active basemap if the current one doesn't cover the
  ride's bbox. Strava tiles go into an IndexedDB tile store.
- **Rendering Strava tiles:** raster layer between basemap and heatmap, backed by
  a MapLibre protocol handler (`stravabundle://{z}/{x}/{y}`) serving from
  IndexedDB. Missing tiles render nothing (basemap shows through — no broken-tile
  placeholders). ☰ toggle; default **on** when a bundle carries tiles.
- **Friend flow:** send app URL + one `.dingonav`. First open online installs the
  PWA; opening the file loads everything; thereafter the whole ride works with
  zero signal. On Central Coast the auto-downloaded basemap makes the extract
  redundant — acceptable for the general case.

## Section 4 — Group ride: verify + names

- **Verify first:** exercise the existing ntfy flow end-to-end (two sessions, one
  ride code) — confirm positions round-trip, dots render and expire. Fix what's
  broken before polishing.
- **Names:** first join of a ride code prompts for a name (stored on-device,
  editable in ☰), carried in the ntfy position payload. **Tapping a dot** shows a
  callout with name, distance from you, and *last seen Xs/min ago* — no permanent
  labels at speed. Deterministic per-rider color (hash of name). Dots fade once a
  position is older than ~2 minutes so a stale dot isn't mistaken for live.
- **Discoverability:** Dingo's export dialog gains an optional "Group ride code"
  field; if set it's written into `bundle.json`, and DingoNav auto-joins that
  code when the bundle loads. The one file then carries the entire ride: map,
  tracks, heatmaps, and the shared-location channel.

## Build order

1. Strava login spike (gates all Strava work).
2. Daemon proxy + web UI layer.
3. Bundle v2 export (zip, corridor tiles, pmtiles extract).
4. DingoNav bundle import + tile layer.
5. Group ride verify + names.

Steps 1–3 in Dingo; 4–5 in DingoNav.

## Risks / open questions

- **Login method** — resolved by the spike (password vs. email-code → plan B).
- **ToS exposure** — mitigated by corridor-only, capped, throttled, disk-cached
  tiles. Personal-account risk accepted.
- **`pmtiles` CLI dependency** — daemon shells out; degrades gracefully to
  no-basemap bundles when absent.
