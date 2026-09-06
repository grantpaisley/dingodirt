#!/usr/bin/env bash
# Build the shared AU vector basemap archive — basemap-au.pmtiles.
#
# The archive every Dingo app renders (Nav, Plan, Studio, the site) used to be
# cut straight out of the Protomaps daily planet build with `pmtiles extract`.
# That costs no compute, but it also gives no control over which zoom a
# feature first appears at, and out bush that is the whole problem: a hamlet
# IS the town, and the stock build holds Blinman (pop ~22) back to z12.
#
# So this builds the archive locally from the same profile, with one patch.
# See README.md for the why and the measurements.
#
# Everything is pinned. Change a pin only on purpose — the apps style this
# archive through core/basemap/layers*.json, and a schema change breaks all
# four at once. Run probe-places.mjs afterwards; it fails on a schema change.
set -euo pipefail

# The commit that produced the live archive: Protomaps basemaps "Tiles
# 4.15.1" (#626, the Natural Earth Geopackage change). It is the last commit
# on their main before the 2026-08-09 build, and 4.15.2 landed after it.
# Their main has since staged a tenth layer (Transit), which the live archive
# does not have — hence the pin, not a branch.
BASEMAPS_COMMIT="${BASEMAPS_COMMIT:-2697f293a555}"

# Matches `planetiler:version` in the live archive's metadata. The pin above
# selects it through tiles/pom.xml; this is here to be asserted, not set.
EXPECT_PLANETILER="0.10.2"

# Australia only. The archive's bounds have never included NZ or the Pacific,
# and the australia-oceania extract is 1.46 GB against 0.90 GB for this one.
GEOFABRIK_AREA="australia"
GEOFABRIK_URL="https://download.geofabrik.de/australia-oceania/australia-latest.osm.pbf"

# Read off the live archive's header, not chosen here: bounds
# 112,-44.2 -> 154.5,-9.5 and z0-14. The generator defaults to maxzoom 15,
# so this MUST be passed or the rebuild is a zoom level deeper than the
# archive it replaces.
BOUNDS="112,-44.2,154.5,-9.5"
MAXZOOM=14

BUILD_DIR="${BUILD_DIR:-$(pwd)/build}"
OUT="${OUT:-$BUILD_DIR/basemap-au.pmtiles}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> build dir: $BUILD_DIR"
mkdir -p "$BUILD_DIR/data/sources"

# --- toolchain ------------------------------------------------------------
# Java 21: tiles/pom.xml sets maven.compiler.source/target to 21.
if [ -z "${JAVA_HOME:-}" ] && [ -d /opt/homebrew/opt/openjdk@21 ]; then
  export JAVA_HOME=/opt/homebrew/opt/openjdk@21
fi
command -v mvn >/dev/null || { echo "maven not found — brew install maven openjdk@21"; exit 1; }
"${JAVA_HOME:-/usr}/bin/java" -version 2>&1 | head -1

# --- profile --------------------------------------------------------------
if [ ! -d "$BUILD_DIR/basemaps" ]; then
  echo "==> cloning protomaps/basemaps"
  git clone --filter=blob:none https://github.com/protomaps/basemaps.git "$BUILD_DIR/basemaps"
fi
git -C "$BUILD_DIR/basemaps" fetch --quiet origin
git -C "$BUILD_DIR/basemaps" checkout --quiet "$BASEMAPS_COMMIT"
git -C "$BUILD_DIR/basemaps" checkout --quiet -- .

got_planetiler=$(grep -o '<planetiler.version>[^<]*' "$BUILD_DIR/basemaps/tiles/pom.xml" | cut -d'>' -f2)
if [ "$got_planetiler" != "$EXPECT_PLANETILER" ]; then
  echo "planetiler version drifted: expected $EXPECT_PLANETILER, pin gives $got_planetiler" >&2
  exit 1
fi

echo "==> applying places min_zoom patch"
git -C "$BUILD_DIR/basemaps" apply "$HERE/places-min-zoom.patch"

echo "==> building the profile jar"
(cd "$BUILD_DIR/basemaps/tiles" && mvn -q -B clean package -DskipTests)
JAR=$(ls "$BUILD_DIR/basemaps/tiles/target/"*-with-deps.jar | head -1)
echo "    $JAR"

# --- input ----------------------------------------------------------------
PBF="$BUILD_DIR/data/sources/${GEOFABRIK_AREA}.osm.pbf"
if [ ! -s "$PBF" ]; then
  echo "==> downloading the OSM extract"
  curl -fL --retry 3 -o "$PBF" "$GEOFABRIK_URL"
fi
ls -lh "$PBF"

# --- tiles ----------------------------------------------------------------
# --download fetches the other sources planetiler needs (Natural Earth, water
# polygons, lake centerlines). It leaves the extract above alone; --force
# would re-fetch it, so it is deliberately not passed.
# planetiler resolves --area and its own downloads against `data/` in the
# WORKING directory, not against the jar. Run it from the build dir, or it
# re-downloads the extract into whatever directory you happened to be in.
echo "==> running planetiler"
(
  cd "$BUILD_DIR"
  "${JAVA_HOME:-/usr}/bin/java" \
    -Xmx24g \
    -jar "$JAR" \
    --area="$GEOFABRIK_AREA" \
    --download \
    --bounds="$BOUNDS" \
    --maxzoom="$MAXZOOM" \
    --nodemap-type=sortedtable \
    --storage=ram \
    --output="$OUT" \
    --force
)

ls -lh "$OUT"
echo
echo "==> verify before you publish:"
echo "    node $HERE/probe-places.mjs https://tiles.dingodirt.com/basemap-au.pmtiles $OUT"
