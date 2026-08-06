#!/usr/bin/env bash
# Cut the shared vector basemap from a Protomaps daily world build.
#
#   ./build-basemap.sh                          # Australia, yesterday's build, z0-14
#   ./build-basemap.sh --maxzoom 15             # bigger, sharper
#   ./build-basemap.sh --bbox 150.85,-33.75,151.85,-32.85 -o test.pmtiles
#   ./build-basemap.sh --build 20260801         # pin a specific daily build
#
# Protomaps daily builds are OSM-derived, free, attribution included, and
# match DingoNav's layers.json schema exactly (source-layer: earth/landuse/
# roads/water/...). `pmtiles extract` streams only the byte ranges it needs.
#
# Needs: brew install pmtiles
set -euo pipefail

cd "$(dirname "$0")"

BUILD=""
MAXZOOM=14
BBOX=""
REGION="au-region.geojson"
OUT="basemap-au.pmtiles"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build)   BUILD="$2"; shift 2 ;;
    --maxzoom) MAXZOOM="$2"; shift 2 ;;
    --bbox)    BBOX="$2"; REGION=""; shift 2 ;;
    --region)  REGION="$2"; BBOX=""; shift 2 ;;
    -o)        OUT="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$BUILD" ]]; then
  # yesterday's build (today's may not be published yet)
  BUILD=$(date -v-1d +%Y%m%d 2>/dev/null || date -d yesterday +%Y%m%d)
fi

SRC="https://build.protomaps.com/${BUILD}.pmtiles"
ARGS=(extract "$SRC" "$OUT" --maxzoom="$MAXZOOM")
if [[ -n "$BBOX" ]]; then
  ARGS+=(--bbox="$BBOX")
else
  ARGS+=(--region="$REGION")
fi

echo "extracting $SRC -> $OUT (maxzoom $MAXZOOM)"
pmtiles "${ARGS[@]}"
ls -lh "$OUT"
pmtiles show "$OUT" | head -20
