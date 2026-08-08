# Shared tile archive & `.dingonav` v2 — tiny packs, corridor caching, personal aerial

*Design, 2026-08-04. Brainstormed and validated section-by-section. This
design executes the tile-strategy direction set in
`2026-08-03-dingodirt-open-source-pivot-design.md`. It amends the scheme
reference contract of `2026-08-02-dingo-studio-design.md` (single → list).*

## Why

A v1 travelling pack (e.g. Kandos2026) is ~40 MB: `bundle.json` (~0.5 MB of
tracks + heatmap) plus an embedded 33 MB `basemap.pmtiles`, a 3 MB
`hillshade.pmtiles`, and a `satellite/` corridor. Nav's Pages deploy bundles
another 41 MB of home-region tiles. Every pack duplicates the geography. The
same ridges ship over and over. v2 makes packs carry **data, not maps** —
the map is shared infrastructure.

## Decision summary

| Question | Decision |
|---|---|
| Archive coverage | **Australia-wide**: OSM vector basemap z0–14 (~2–4 GB), DEM hillshade z4–12 (~5–7 GB); the build scripts are open in the Dingo repo. *Implementation note:* cut the basemap from the Protomaps daily builds with `pmtiles extract` (this matches Nav's existing schema and needs zero build compute), not from a local planetiler run |
| Hosting | **Cloudflare R2** behind `tiles.dingodirt.com` — free egress, range requests, ~6¢/month storage |
| Corridor decided by | **Nav at install**, derived from the pack's own tracks; no build-time tile lists |
| Pack format | `bundle.json` + `formatVersion: 2`; the tile-source URLs are optional (the defaults live in Nav); zip stays the container |
| Schemes | A pack may reference a **list** of schemes (day/night variants); Nav gains a quick switcher + an optional sunset auto-switch |
| Aerial | **A per-device source setting**, corridor-cached locally; never pack content, never on dingodirt storage |
| Home-area cache | **Dropped** — enduro/adventure riding leaves "home" by definition; the pack corridors + organic online caching cover reality |
| Back-compat | v1 packs (embedded tiles, `satellite/`) work unchanged; both directions are tolerated |

## Architecture

```
tiles.dingodirt.com (R2)
  basemap-au.pmtiles     vector basemap, z0–14
  hillshade-au.pmtiles   terrarium hillshade, z0–12
  manifest.json          versions / ETags / coverage bbox

Dingo repo  tools/build-tiles/   planetiler + hillshade + upload scripts
DingoNav    corridor fetcher · tile cache · serving layer · aerial layer
.dingonav v2   bundle.json only (tracks + heatmap + marks + scheme refs)
```

Install flow: the pack arrives (`?dl=`, file, share link) → Nav reads the
tracks → Nav computes the corridor tile lists per source → Nav prefetches
with a progress UI → the tiles land in the local cache → the ride works in
airplane mode.

Nav's Pages deploy drops its bundled region tiles. The fonts + sprites
stay — they are small and shared. The first open with no pack shows the
live map when online (range requests to the shared archive), plus a quiet
"install a pack for offline maps" hint.

## Pack format v2

```json
{
  "formatVersion": 2,
  "tiles": {
    "basemap":   "https://tiles.dingodirt.com/basemap-au.pmtiles",
    "hillshade": "https://tiles.dingodirt.com/hillshade-au.pmtiles"
  },
  "schemes": [
    { "name": "Kandos Day",  "url": "…/kandos-day.dingoscheme",  "variant": "day"   },
    { "name": "Night Rider", "url": "…/night-rider.dingoscheme", "variant": "night" }
  ],
  "heatmap": { "…": "as today" },
  "tracks":  [ "as today" ]
}
```

- **The defaults live in Nav, not in packs.** `tiles` omitted → Nav's
  built-in shared-archive URLs. The block exists for overrides
  (self-hosters, other-region archives). If the tile host moves, a Nav
  update fixes every pack ever published.
- **Schemes are plural** (this amends the Studio contract). The existing
  offer-once prompt covers the set. Installed schemes land in Nav's normal
  list. Nav adds a **quick switcher** in the ride chrome (one glove-tap
  day↔night). The `variant` tags enable an optional auto-switch at local
  sunset — a manual choice always wins and sticks for the ride. A singular
  `scheme` is still accepted (a one-item list). The built-in day/night
  looks stay as the fallback.
- **No aerial field exists.** Aerial is device configuration.
- A v2 `.dingonav` is the same zip on the same rails, typically a few
  hundred KB.

**Back-compat:** v1 packs (no `formatVersion`) load the embedded
`basemap.pmtiles` / `hillshade.pmtiles` / `satellite/` exactly as today.
Nothing is migrated, and nothing is deleted. Old Nav + a v2 pack degrades
to tracks on blank (PWAs update themselves quickly). `make_bundle.py`
emits v2 by default. `--embed-tiles` keeps self-contained builds for
outside-coverage trips. dingodirt marks v1-sized uploads "legacy pack —
contains embedded tiles" (accepted, socially nudged out).

## Corridor fetcher & cache (Nav)

**Corridor:** a track buffer of ~2 km at **z12–14**; the ride bbox padded
~20 km at **z8–11**; **z0–7** Australia-wide, cached once ever. A typical
ride: low thousands of tiles, tens of MB, ~a minute on 4G. The defaults
are tunable in one place. A per-pack *extend cache* re-runs with a bigger
buffer.

**Fetch/store:** Nav pulls the tiles via `pmtiles.js` `getZxy` and stores
them in IndexedDB, keyed `source/z/x/y`, plus a per-pack reference set. A
progress bar shows fetched/total. The prefetch is **resumable** — cached
tiles skip, so retries and version bumps cost only the delta. A failure
degrades to "installed, maps partial — re-run when online". The install
never blocks.

**Serve:** cache-first behind MapLibre's tile protocol. A miss while
online falls through to a live range request and caches the result. Online
browsing thus warms the cache organically. A miss while offline renders
blank.

**Evict:** a pack delete drops its reference set. Unreferenced tiles GC.
Settings shows the per-source cache size + a clear-all. Archive rebuilds
(a new ETag in `manifest.json`) invalidate nothing — stale tiles stay
servable offline and refresh lazily on the next online touch.

## Aerial — personal layer

Settings gains an **aerial source**: a `{z}/{x}/{y}` URL template with
presets (NSW Six Maps imagery, CC BY 4.0, first). The ride chrome gains a
basemap ↔ aerial toggle. If a source is configured, the pack install also
corridor-caches aerial at **z12–15, track buffer only**. There are no
bbox/low-zoom tiers, because imagery is heavy. It uses the same cache and
the same GC. Imagery never enters a pack or dingodirt's storage. Published
packs are imagery-free by construction. The embedded `satellite/` in v1
packs keeps rendering.

## Archive build (open)

`Dingo/tools/build-tiles/`: the planetiler config (AU OSM extract →
`basemap-au.pmtiles`), the DEM pipeline (→ `hillshade-au.pmtiles`), and an
upload script that writes both + `manifest.json` to R2. Document it, so
self-hosters can build any region and point the `tiles` overrides at it.
Rebuilds are manual, quarterly-ish.

## Rollout (each step useful alone)

1. Build + publish the AU archive to R2 (`tiles.dingodirt.com`)
2. Nav: the fetcher + cache + serving layer (v1 packs untouched)
3. Nav: v2 support + the scheme list/switcher + the aerial setting
4. `make_bundle.py` v2 default; slim the Pages deploy
5. dingodirt: the legacy badge; later `/make` builds v2 client-side

## Testing

- **Corridor math:** tracks → the expected tile sets; the buffer edges;
  the zoom-tier boundaries.
- **Cache semantics:** hit / miss-online (caches) / miss-offline (blank);
  the GC refcounting across shared corridors; the resumable prefetch.
- **Back-compat fixtures:** a v1 embedded pack; a v2 default; a v2 with
  overrides; a singular `scheme`.
- **Airplane-mode smoke test:** a scripted replay of a fixture ride
  offline, which asserts zero network requests.

## Deferred (YAGNI'd)

- A **"Cache this map view"** button (pre-cache a touring base town) —
  trivial atop the fetcher; build it when someone asks.
- Delta/partial archive updates; tile-level compression tuning.
- Non-AU shared archives (the self-host docs cover it meanwhile).
- Scheme auto-switch beyond sunset (an ambient light sensor).
