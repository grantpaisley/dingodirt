/** Detail-change zoom levels of a style: the sorted set of every layer's
 *  minzoom/maxzoom. Stepping between these levels (rather than ±1) walks the
 *  zooms where the map actually gains or loses features. */
import type { StyleSpecification } from 'maplibre-gl'

export function deriveSnapLevels(style: StyleSpecification, maxZoom = 22): number[] {
    const raw = new Set<number>([0, maxZoom])
    for (const layer of style.layers ?? []) {
        if (typeof layer.minzoom === 'number') raw.add(layer.minzoom)
        if (typeof layer.maxzoom === 'number' && layer.maxzoom < maxZoom) raw.add(layer.maxzoom)
    }
    const sorted = [...raw].filter(z => z >= 0 && z <= maxZoom).sort((a, b) => a - b)
    // Dedupe against the last KEPT value so runs of near-equal levels collapse
    const levels: number[] = []
    for (const z of sorted) {
        if (levels.length === 0 || z - levels[levels.length - 1] > 0.1) levels.push(z)
    }
    return levels
}

/** Next detail level above z (tolerance avoids getting stuck on a level).
 *  When the next threshold is more than 2 zooms away — e.g. past the last
 *  configured minzoom — fall back to a plain +1 step so the button never
 *  teleports across half the zoom range. */
export function nextSnap(levels: number[], z: number): number {
    for (const l of levels) if (l > z + 0.05) return l - z > 2 ? Math.floor(z + 1) : l
    return levels[levels.length - 1] ?? z
}

/** Previous detail level below z (same ±1 fallback as nextSnap). */
export function prevSnap(levels: number[], z: number): number {
    for (let i = levels.length - 1; i >= 0; i--) {
        if (levels[i] < z - 0.05) return z - levels[i] > 2 ? Math.ceil(z - 1) : levels[i]
    }
    return levels[0] ?? z
}
