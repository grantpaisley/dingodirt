// Inverse-mask geometry for the pack preview.
//
// MapLibre can't clip a raster layer to a polygon, so the preview paints the
// INVERSE instead: a world-sized fill with the covered area punched out of it.
// Everything the pack doesn't carry goes flat, which is exactly what the phone
// shows offline.
//
// Winding is load-bearing. MapLibre inherits Mapbox's `classifyRings`: it takes
// the signed area of ring 0 as the polygon's orientation, then treats every
// later ring of the OPPOSITE sign as a hole and every ring of the SAME sign as
// the start of a new polygon. PostGIS ring order can't be trusted through
// ST_Buffer → ST_MakeValid → ST_Multi, so every ring is re-wound explicitly.
//
// Antimeridian-crossing corridors would render wrong. Not a case this data hits.

type Ring = number[][]

/** Shoelace signed area. Positive = counter-clockwise in lon/lat order. */
function signedArea(ring: Ring): number {
    let a = 0
    for (let i = 0, n = ring.length; i < n; i++) {
        const [x0, y0] = ring[i]
        const [x1, y1] = ring[(i + 1) % n]
        a += x0 * y1 - x1 * y0
    }
    return a / 2
}

const asCW = (r: Ring): Ring => (signedArea(r) > 0 ? [...r].reverse() : r)
const asCCW = (r: Ring): Ring => (signedArea(r) < 0 ? [...r].reverse() : r)

/** Web-Mercator's usable latitude range — beyond this MapLibre can't project. */
const LAT_LIMIT = 85.0511

const WORLD_RING: Ring = [
    [-180, -LAT_LIMIT], [180, -LAT_LIMIT], [180, LAT_LIMIT], [-180, LAT_LIMIT], [-180, -LAT_LIMIT],
]

export type MaskShape = GeoJSON.Polygon | GeoJSON.MultiPolygon

/** A rect bbox as a GeoJSON polygon: [minLon, minLat, maxLon, maxLat]. */
export function rectPolygon(rect: [number, number, number, number]): GeoJSON.Polygon {
    const [x0, y0, x1, y1] = rect
    return {
        type: 'Polygon',
        coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
    }
}

/**
 * Everything EXCEPT `shape`, as a single feature.
 *
 * `shape === null` yields the bare world ring — fully opaque, the right render
 * for a pack that carries no map tiles at all.
 *
 * A hole inside the corridor (the middle of a loop, which the bundle does not
 * cover) is re-emitted as its own polygon so it masks too — expressible in one
 * MultiPolygon, no boolean geometry required.
 */
export function inverseMask(shape: MaskShape | null): GeoJSON.Feature<GeoJSON.MultiPolygon> {
    const worldPoly: Ring[] = [asCW(WORLD_RING)]
    const donuts: Ring[][] = []
    if (shape) {
        const polys = shape.type === 'Polygon' ? [shape.coordinates] : shape.coordinates
        for (const rings of polys) {
            if (rings.length === 0) continue
            worldPoly.push(asCCW(rings[0]))
            for (let i = 1; i < rings.length; i++) donuts.push([asCW(rings[i])])
        }
    }
    return {
        type: 'Feature',
        properties: {},
        geometry: { type: 'MultiPolygon', coordinates: [worldPoly, ...donuts] },
    }
}
