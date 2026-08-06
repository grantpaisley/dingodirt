/** Shared handle to the live MapLibre map instance.
 *
 *  MapView registers its map here so siblings that already talk to the
 *  zustand stores directly (MapToolbar, the style-layers panel) can drive
 *  camera and style operations without threading a prop per operation.
 *  Always null-check: the map exists only while MapView is mounted.
 */
import type maplibregl from 'maplibre-gl'

let instance: maplibregl.Map | null = null

export function setMapInstance(m: maplibregl.Map | null): void {
    instance = m
}

export function getMapInstance(): maplibregl.Map | null {
    return instance
}
