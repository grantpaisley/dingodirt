#!/usr/bin/env python3
"""Write manifest.json for the tile archive: versions, sizes, hashes, coverage.

    ./make-manifest.py --version 2026q3 basemap-au.pmtiles hillshade-au.pmtiles

Nav fetches this to know current archive identities for cache bookkeeping
(cached tiles stay servable across rebuilds; refresh is lazy).
"""
import argparse, hashlib, json, os, sys
from datetime import date

AU_BBOX = [112.0, -44.2, 154.5, -9.5]


def sha256(path, bufsize=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(bufsize):
            h.update(chunk)
    return h.hexdigest()


p = argparse.ArgumentParser()
p.add_argument("--version", required=True, help="e.g. 2026q3")
p.add_argument("--coverage", default=",".join(str(v) for v in AU_BBOX))
p.add_argument("files", nargs="+")
p.add_argument("-o", "--out", default="manifest.json")
a = p.parse_args()

manifest = {
    "version": a.version,
    "built": date.today().isoformat(),
    "coverage": [float(v) for v in a.coverage.split(",")],
    "attribution": {
        "basemap": "© OpenStreetMap contributors, Protomaps",
        "hillshade": "Mapzen/AWS Open Data (SRTM, Geoscience Australia et al.)",
    },
    "files": {},
}
for f in a.files:
    if not os.path.exists(f):
        sys.exit(f"missing: {f}")
    manifest["files"][os.path.basename(f)] = {
        "bytes": os.path.getsize(f),
        "sha256": sha256(f),
    }

json.dump(manifest, open(a.out, "w"), indent=2)
print(f"wrote {a.out}:")
print(json.dumps(manifest, indent=2))
