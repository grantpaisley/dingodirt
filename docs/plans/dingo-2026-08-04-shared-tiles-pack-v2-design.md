# Shared tile archive & `.dingonav` v2 — tiny packs, corridor caching, personal aerial

*Design, 2026-08-04. Brainstormed and validated section-by-section. Executes
the tile-strategy direction set in
`2026-08-03-dingodirt-open-source-pivot-design.md`; amends the scheme
reference contract of `2026-08-02-dingo-studio-design.md` (single → list).*

## Why

A v1 travelling pack (e.g. Kandos2026) is ~40 MB: `bundle.json` (~0.5 MB of
tracks + heatmap) plus an embedded 33 MB `basemap.pmtiles`, 3 MB
`hillshade.pmtiles` and a `satellite/` corridor. Nav's Pages deploy bundles
another 41 MB of home-region tiles. Every pack duplicates geography; the
same ridges ship over and over. v2 makes packs carry **data, not maps** —
the map is shared infrastructure.

## Decision summary

| Question | Decision |
|---|---|
| Archive coverage | **Australia-wide**: OSM vector basemap z0–14 (~2–4 GB), DEM hillshade z4–12 (~5–7 GB); build scripts open in the Dingo repo. *Implementation note:* basemap is cut from Protomaps daily builds via `pmtiles extract` (matches Nav's existing schema; zero build compute) rather than a local planetiler run |
| Hosting | **Cloudflare R2** behind `tiles.dingodirt.com` — free egress, range requests, ~6¢/month storage |
| Corridor decided by | **Nav at install**, derived from the pack's own tracks; no build-time tile lists |
| Pack format | `bundle.json` + `formatVersion: 2`; tile-source URLs optional (defaults live in Nav); zip stays the container |
| Schemes | Pack may reference a **list** of schemes (day/night variants); Nav gains a quick switcher + optional sunset auto-switch |
| Aerial | **Per-device source setting**, corridor-cached locally; never pack content, never on dingodirt storage |
| Home-area cache | **Dropped** — enduro/adventure riding leaves "home" by definition; pack corridors + organic online caching cover reality |
| Back-compat | v1 packs (embedded tiles, `satellite/`) work unchanged, both directions tolerated |

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

Install flow: pack arrives (`?dl=`, file, share link) → Nav reads tracks →
computes corridor tile lists per source → prefetches with progress UI →
tiles land in the local cache → the ride works in airplane mode.

Nav's Pages deploy drops its bundled region tiles (fonts + sprites stay —
small and shared). First open with no pack shows the live map when online
(range requests to the shared archive) plus a quiet "install a pack for
offline maps" hint.

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

- **Defaults live in Nav, not packs.** `tiles` omitted → Nav's built-in
  shared-archive URLs. The block exists for overrides (self-hosters,
  other-region archives). If the tile host moves, a Nav update fixes every
  pack ever published.
- **Schemes plural** (amends the Studio contract): the existing offer-once
  prompt covers the set; installed schemes land in Nav's normal list. Nav
  adds a **quick switcher** in ride chrome (one glove-tap day↔night);
  `variant` tags enable optional auto-switch at local sunset — manual
  choice always wins and sticks for the ride. Singular `scheme` still
  accepted (one-item list). Built-in day/night looks remain the fallback.
- **No aerial field exists.** Aerial is device configuration.
- A v2 `.dingonav` is the same zip on the same rails, typically a few
  hundred KB.

**Back-compat:** v1 packs (no `formatVersion`) load embedded
`basemap.pmtiles` / `hillshade.pmtiles` / `satellite/` exactly as today —
nothing migrated, nothing deleted. Old Nav + v2 pack degrades to tracks on
blank (PWAs update themselves quickly). `make_bundle.py` emits v2 by
default; `--embed-tiles` keeps self-contained builds for outside-coverage
trips. dingodirt marks v1-sized uploads "legacy pack — contains embedded
tiles" (accepted, socially nudged out).

## Corridor fetcher & cache (Nav)

**Corridor:** track buffer ~2 km at **z12–14**; ride bbox padded ~20 km at
**z8–11**; **z0–7** Australia-wide cached once ever. Typical ride: low
thousands of tiles, tens of MB, ~a minute on 4G. Defaults tunable in one
place; per-pack *extend cache* re-runs with a bigger buffer.

**Fetch/store:** tiles pulled via `pmtiles.js` `getZxy`, stored in
IndexedDB keyed `source/z/x/y`, plus a per-pack reference set. Progress bar
(fetched/total), **resumable** — cached tiles skip, so retries and version
bumps cost the delta. Failure degrades to "installed, maps partial — re-run
when online"; install never blocks.

**Serve:** cache-first behind MapLibre's tile protocol; miss-while-online
falls through to a live range request and caches the result (so online
browsing warms the cache organically); miss-offline renders blank.

**Evict:** pack delete drops its reference set; unreferenced tiles GC.
Settings shows per-source cache size + clear-all. Archive rebuilds (new
ETag in `manifest.json`) invalidate nothing — stale tiles stay servable
offline and refresh lazily on next online touch.

## Aerial — personal layer

Settings gains **aerial source**: a `{z}/{x}/{y}` URL template with presets
(NSW Six Maps imagery, CC BY 4.0, first). Ride chrome gains a basemap ↔
aerial toggle. If a source is configured, pack install also corridor-caches
aerial at **z12–15, track buffer only** (no bbox/low-zoom tiers — imagery
is heavy). Same cache, same GC. Imagery never enters a pack or dingodirt's
storage; published packs are imagery-free by construction. v1 packs'
embedded `satellite/` keeps rendering.

## Archive build (open)

`Dingo/tools/build-tiles/`: planetiler config (AU OSM extract →
`basemap-au.pmtiles`), DEM pipeline (→ `hillshade-au.pmtiles`), upload
script writing both + `manifest.json` to R2. Documented for self-hosters to
build any region and point `tiles` overrides at it. Quarterly-ish manual
rebuilds.

## Rollout (each step useful alone)

1. Build + publish the AU archive to R2 (`tiles.dingodirt.com`)
2. Nav: fetcher + cache + serving layer (v1 packs untouched)
3. Nav: v2 support + scheme list/switcher + aerial setting
4. `make_bundle.py` v2 default; slim the Pages deploy
5. dingodirt: legacy badge; later `/make` builds v2 client-side

## Testing

- **Corridor math:** tracks → expected tile sets; buffer edges; zoom-tier
  boundaries.
- **Cache semantics:** hit / miss-online (caches) / miss-offline (blank);
  GC refcounting across shared corridors; resumable prefetch.
- **Back-compat fixtures:** v1 embedded pack; v2 default; v2 with
  overrides; singular `scheme`.
- **Airplane-mode smoke test:** scripted replay of a fixture ride offline
  asserting zero network requests.

## Deferred (YAGNI'd)

- **"Cache this map view"** button (pre-cache a touring base town) —
  trivial atop the fetcher, build when someone asks.
- Delta/partial archive updates; tile-level compression tuning.
- Non-AU shared archives (self-host docs cover it meanwhile).
- Scheme auto-switch beyond sunset (ambient light sensor).
