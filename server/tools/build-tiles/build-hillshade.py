#!/usr/bin/env python3
"""Build the shared hillshade archive: Terrarium DEM tiles -> raster-dem .pmtiles.

Australia-scale version of DingoNav/make_hillshade.py: a coarse land mask
(au-region.geojson) prunes open-ocean tiles, and tiles are spooled to disk
first so the build is resumable and memory-flat.

    ./build-hillshade.py                        # Australia, z4-12
    ./build-hillshade.py --bbox 150.85,-33.75,151.85,-32.85 --minzoom 6 -o test.pmtiles
    ./build-hillshade.py --resume               # continue an interrupted fetch

Phase 1 fetches to tiles-spool/ (skips files already present); phase 2
packs them into the .pmtiles in tile-id order (the writer dedupes identical
tiles, so flat-ocean stragglers cost almost nothing).

Needs: pip install pmtiles
Source: AWS Open Data terrain tiles (free, no key).
"""
import argparse, json, math, os, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import urllib.request

from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
ATTRIBUTION = "Terrain: Mapzen/AWS Open Data (SRTM, Geoscience Australia et al.)"
AU_BBOX = (112.0, -44.2, 154.5, -9.5)

HERE = Path(__file__).parent


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    lat = max(min(lat, 85.05), -85.05)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


def tile_bounds(z, x, y):
    n = 2 ** z
    lon0 = x / n * 360 - 180
    lon1 = (x + 1) / n * 360 - 180
    lat0 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    lat1 = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return lon0, lat1, lon1, lat0  # minlon, minlat, maxlon, maxlat


def point_in_ring(lon, lat, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


class LandMask:
    def __init__(self, geojson_path):
        gj = json.load(open(geojson_path))
        geom = gj["geometry"] if gj.get("type") == "Feature" else gj
        self.rings = [poly[0] for poly in geom["coordinates"]]

    def contains(self, lon, lat):
        return any(point_in_ring(lon, lat, r) for r in self.rings)

    def tile_touches(self, z, x, y):
        lon0, lat0, lon1, lat1 = tile_bounds(z, x, y)
        for lon, lat in (
            ((lon0 + lon1) / 2, (lat0 + lat1) / 2),
            (lon0, lat0), (lon0, lat1), (lon1, lat0), (lon1, lat1),
        ):
            if self.contains(lon, lat):
                return True
        return False


def tiles_for(bbox, zmin, zmax, mask):
    min_lon, min_lat, max_lon, max_lat = bbox
    for z in range(zmin, zmax + 1):
        x0, y0 = lonlat_to_tile(min_lon, max_lat, z)
        x1, y1 = lonlat_to_tile(max_lon, min_lat, z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                # keep everything at overview zooms; mask from z8 up where
                # tile counts explode and ocean dominates
                if z < 8 or mask is None or mask.tile_touches(z, x, y):
                    yield z, x, y


def fetch_one(spool, z, x, y, retries=4):
    path = spool / str(z) / str(x) / f"{y}.png"
    if path.exists():
        return False
    url = TILE_URL.format(z=z, x=x, y=y)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                data = r.read()
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(data)
            tmp.rename(path)
            return True
        except Exception as e:
            if attempt == retries - 1:
                raise RuntimeError(f"{url}: {e}") from e
            time.sleep(2 ** attempt)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--bbox", help="minLon,minLat,maxLon,maxLat (default: Australia)")
    p.add_argument("--region", default=str(HERE / "au-region.geojson"),
                   help="land-mask GeoJSON ('' to disable)")
    p.add_argument("--minzoom", type=int, default=4)
    p.add_argument("--maxzoom", type=int, default=12)
    p.add_argument("--spool", default=str(HERE / "tiles-spool"))
    p.add_argument("--workers", type=int, default=16)
    p.add_argument("--resume", action="store_true", help="(fetch always resumes; flag is documentation)")
    p.add_argument("-o", "--out", default=str(HERE / "hillshade-au.pmtiles"))
    a = p.parse_args()

    bbox = tuple(float(v) for v in a.bbox.split(",")) if a.bbox else AU_BBOX
    mask = LandMask(a.region) if a.region else None
    spool = Path(a.spool)

    todo = list(tiles_for(bbox, a.minzoom, a.maxzoom, mask))
    print(f"{len(todo)} tiles (z{a.minzoom}-{a.maxzoom}, land-masked from z8)")

    done = 0
    fetched = 0
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futures = [ex.submit(fetch_one, spool, z, x, y) for z, x, y in todo]
        for f in as_completed(futures):
            fetched += 1 if f.result() else 0
            done += 1
            if done % 500 == 0:
                print(f"  {done}/{len(todo)} ({fetched} new)", flush=True)
    print(f"fetch complete: {done} tiles ({fetched} newly downloaded)")

    min_lon, min_lat, max_lon, max_lat = bbox
    todo.sort(key=lambda t: zxy_to_tileid(*t))
    with open(a.out, "wb") as f:
        w = Writer(f)
        for z, x, y in todo:
            data = (spool / str(z) / str(x) / f"{y}.png").read_bytes()
            w.write_tile(zxy_to_tileid(z, x, y), data)
        w.finalize(
            {
                "tile_type": TileType.PNG,
                "tile_compression": Compression.NONE,
                "min_zoom": a.minzoom,
                "max_zoom": a.maxzoom,
                "min_lon_e7": int(min_lon * 1e7),
                "min_lat_e7": int(min_lat * 1e7),
                "max_lon_e7": int(max_lon * 1e7),
                "max_lat_e7": int(max_lat * 1e7),
                "center_zoom": (a.minzoom + a.maxzoom) // 2,
                "center_lon_e7": int((min_lon + max_lon) / 2 * 1e7),
                "center_lat_e7": int((min_lat + max_lat) / 2 * 1e7),
            },
            {"attribution": ATTRIBUTION},
        )
    print(f"wrote {a.out}: {os.path.getsize(a.out)/1e6:.1f} MB "
          f"(spool kept at {spool} — delete after upload)")


if __name__ == "__main__":
    sys.exit(main())
