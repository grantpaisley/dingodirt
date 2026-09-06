#!/usr/bin/env python3
"""Merge terrarium hillshade PMTiles cuts into one wider archive.

make_hillshade.py cuts a rectangle at a time, so covering several states
means several files — but DINGO_HILLSHADE_PMTILES takes one path, and an
export whose corridor falls outside it errors rather than shipping empty
terrain. Merging the cuts gives one source that covers the lot.

The pmtiles CLI has `merge`, but it refuses inputs that share any tile
("Inputs must be disjoint"), and neighbouring cuts always share their
border tiles. This merges anyway and drops the duplicates: the same z/x/y
came from the same AWS terrain source, so the copies are identical bytes.

    ./merge_hillshade.py -o hillshade-au.pmtiles cut-nsw.pmtiles cut-qld.pmtiles

Needs: pip install pmtiles
"""
import argparse, heapq, os, sys
from contextlib import ExitStack

from pmtiles.reader import MmapSource, Reader, all_tiles
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import write

ATTRIBUTION = 'Terrain: Mapzen/AWS Open Data (SRTM, Geoscience Australia et al.)'


def header_of(f):
    return Reader(MmapSource(f)).header()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('inputs', nargs='+', help='.pmtiles cuts to merge (may overlap)')
    ap.add_argument('-o', '--output', required=True)
    args = ap.parse_args()

    if args.output in args.inputs:
        ap.error('--output would overwrite one of the inputs')

    with ExitStack() as stack:
        files = [stack.enter_context(open(p, 'rb')) for p in args.inputs]

        # Union of the input bounds, and the widest zoom span they cover.
        lo_lon = lo_lat = 2 ** 31
        hi_lon = hi_lat = -2 ** 31
        zmin, zmax = 99, 0
        for path, f in zip(args.inputs, files):
            h = header_of(f)
            lo_lon, lo_lat = min(lo_lon, h['min_lon_e7']), min(lo_lat, h['min_lat_e7'])
            hi_lon, hi_lat = max(hi_lon, h['max_lon_e7']), max(hi_lat, h['max_lat_e7'])
            zmin, zmax = min(zmin, h['min_zoom']), max(zmax, h['max_zoom'])
            print(f"  {os.path.basename(path)}: z{h['min_zoom']}-{h['max_zoom']} "
                  f"({h['min_lon_e7'] / 1e7:.2f},{h['min_lat_e7'] / 1e7:.2f})–"
                  f"({h['max_lon_e7'] / 1e7:.2f},{h['max_lat_e7'] / 1e7:.2f})")

        # Each archive's directory traversal already yields ascending tile ids,
        # so a k-way merge keeps the output clustered and streams the tiles
        # instead of holding a multi-GB archive in memory.
        streams = [((zxy_to_tileid(*zxy), i, data) for zxy, data in all_tiles(MmapSource(f)))
                   for i, f in enumerate(files)]
        written = dupes = 0
        last = -1
        with write(args.output) as w:
            for tileid, _src, data in heapq.merge(*streams):
                if tileid == last:
                    dupes += 1
                    continue
                w.write_tile(tileid, data)
                last = tileid
                written += 1
                if written % 20000 == 0:
                    print(f'\r  merged {written}', end='', flush=True)
            print()
            w.finalize(
                {'tile_type': TileType.PNG, 'tile_compression': Compression.NONE,
                 'min_lon_e7': lo_lon, 'min_lat_e7': lo_lat,
                 'max_lon_e7': hi_lon, 'max_lat_e7': hi_lat,
                 'center_zoom': (zmin + zmax) // 2},
                {'name': os.path.basename(args.output), 'format': 'png',
                 'encoding': 'terrarium', 'attribution': ATTRIBUTION})

    print(f'{args.output}: {written} tiles ({dupes} duplicates dropped), '
          f'{os.path.getsize(args.output) / 1e6:.1f} MB')


if __name__ == '__main__':
    sys.exit(main())
