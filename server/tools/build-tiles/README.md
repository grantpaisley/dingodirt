# Shared tile archive build

Builds the Australia-wide archive behind `tiles.dingodirt.com` per
`Docs/plans/2026-08-04-shared-tiles-pack-v2-design.md`. Self-hosters:
same scripts with `--bbox`/`--region` build any area — point your packs'
`tiles` override at your own host.

Note: the design doc says planetiler; in practice the basemap is cut from
**Protomaps daily builds** (`pmtiles extract`) — same OSM data, zero build
compute, and it exactly matches DingoNav's `layers.json` schema
(source-layers `earth`/`landuse`/`roads`/…). Planetiler remains an option
if we ever need a custom schema.

## Prereqs

```bash
brew install pmtiles rclone
pip install pmtiles
```

## Build (quarterly-ish)

```bash
./build-basemap.sh                 # AU extract from yesterday's Protomaps build, z0-14
./build-hillshade.py               # Terrarium DEM z4-12, land-masked, resumable
./make-manifest.py --version 2026q3 basemap-au.pmtiles hillshade-au.pmtiles
```

Expect the basemap around 2–4 GB and the hillshade a few GB (the
`tiles-spool/` fetch dir is resumable — rerun after interruptions; delete
it after a successful pack). Smoke-test any change on a small area first:

```bash
./build-basemap.sh --bbox 150.85,-33.75,151.85,-32.85 -o test-basemap.pmtiles
./build-hillshade.py --bbox 150.85,-33.75,151.85,-32.85 --minzoom 6 -o test-hillshade.pmtiles
```

## Publish

```bash
./upload-r2.sh    # setup instructions in the script header
```

One-time after the first upload (Cloudflare dashboard):

1. R2 → `dingodirt-tiles` → Settings → **Custom domains** → add
   `tiles.dingodirt.com` (Cloudflare creates the DNS record).
2. Settings → **CORS policy** → paste `cors.json` (Nav/Studio/Plan need
   cross-origin GET + Range).

Verify:

```bash
curl -sI https://tiles.dingodirt.com/manifest.json                  # 200
curl -s -H 'Range: bytes=0-127' -o /dev/null -w '%{http_code}\n' \
  https://tiles.dingodirt.com/basemap-au.pmtiles                    # 206
```

## Costs

R2 storage ~$0.015/GB-month (≈10¢/month for the full archive); egress is
free. Rebuilds overwrite in place — cached tiles in Nav stay valid and
refresh lazily (see the design doc's cache semantics).
