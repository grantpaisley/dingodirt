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
    instance = m;
    // Debug handle, the __dingoMap convention the site's plan page also
    // follows. Set in every build, not only dev: the UI sweep and the perf
    // harness (tools/perf) drive the production bundle and need to place the
    // camera exactly. It is one window property; nothing else reads it.
    (window as unknown as Record<string, unknown>).__dingoMap = m
}

export function getMapInstance(): maplibregl.Map | null {
    return instance
}
