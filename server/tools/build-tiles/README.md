# Shared tile archive build

This tool builds the Australia-wide archive behind `tiles.dingodirt.com`,
per `Docs/plans/2026-08-04-shared-tiles-pack-v2-design.md`. Self-hosters:
the same scripts with `--bbox`/`--region` build any area. Point the `tiles`
override of your packs at your own host.

Note: the design doc says planetiler. In practice, the basemap is cut from
the **Protomaps daily builds** (`pmtiles extract`). This gives the same OSM
data with zero build compute, and it exactly matches DingoNav's
`layers.json` schema (source-layers `earth`/`landuse`/`roads`/…). Planetiler
stays an option if we ever need a custom schema.

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

Expect the basemap near 2–4 GB, and expect the hillshade to be a few GB.
The `tiles-spool/` fetch dir is resumable — run the script again after an
interruption. Delete the dir after a successful pack. Smoke-test each
change on a small area first:

```bash
./build-basemap.sh --bbox 150.85,-33.75,151.85,-32.85 -o test-basemap.pmtiles
./build-hillshade.py --bbox 150.85,-33.75,151.85,-32.85 --minzoom 6 -o test-hillshade.pmtiles
```

## Publish

```bash
./upload-r2.sh    # setup instructions in the script header
```

Do these steps one time after the first upload (Cloudflare dashboard):

1. R2 → `dingodirt-tiles` → Settings → **Custom domains** → add
   `tiles.dingodirt.com` (Cloudflare creates the DNS record).
2. Settings → **CORS policy** → paste `cors.json` (Nav/Studio/Plan need
   cross-origin GET + Range).

Check:

```bash
curl -sI https://tiles.dingodirt.com/manifest.json                  # 200
curl -s -H 'Range: bytes=0-127' -o /dev/null -w '%{http_code}\n' \
  https://tiles.dingodirt.com/basemap-au.pmtiles                    # 206
```

## Costs

R2 storage costs ~$0.015/GB-month (≈10¢/month for the full archive).
Egress is free. Rebuilds overwrite in place. Cached tiles in Nav stay
valid, and they refresh lazily (see the cache semantics in the design doc).
