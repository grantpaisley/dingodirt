/** Base-map style registry.
 *
 *  Three built-in MapTiler-hosted styles plus any number of local styles
 *  declared in /public/styles/index.json — plain MapLibre style JSONs that
 *  anyone can add or edit (e.g. in Maputnik) without touching code. Local
 *  styles reference MapTiler sources through a {MAPTILER_KEY} placeholder so
 *  community-shared styles never embed a key.
 */
import { useEffect, useState } from 'react'
import type { StyleSpecification } from 'maplibre-gl'
import { applyNightMap, nightMapOf, overlaysOf, parseColor, withAlpha } from './components/Map/styleAttrs'
import { buildDingoStyle, DINGO_STYLE_ID } from './dingoBasemap'

/** Client-side MapTiler key. Public by design — it ships in every browser
 *  bundle — and safe to publish because it is domain-restricted to the
 *  dingodirt.com origins in the MapTiler dashboard. Rotate there, not here. */
export const MAPTILER_KEY = 'BWXJWQgUr60zDTSCSOwr'

export const BUILTIN_STYLE_URLS: Record<string, string> = {
    satellite: `https://api.maptiler.com/maps/hybrid/style.json?key=${MAPTILER_KEY}`,
    outdoor: `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`,
    topo: `https://api.maptiler.com/maps/topo-v2/style.json?key=${MAPTILER_KEY}`,
}

export interface LocalStyleEntry {
    id: string
    label: string
    description: string
    url: string
}

let manifestPromise: Promise<LocalStyleEntry[]> | null = null

/** Resolve a manifest `url` against the app's base path.
 *
 *  Manifest entries are authored as site-absolute ("/styles/foo.json") and the
 *  daemon writes that file too, so the format stays as-is; served from a
 *  subpath (GitHub Pages: /dingodirt/plan/) a leading slash would resolve
 *  against the domain root instead. Full URLs are left alone so a manifest can
 *  point at a style hosted elsewhere. */
function rebase(url: string): string {
    if (/^[a-z]+:\/\//i.test(url)) return url
    return import.meta.env.BASE_URL + url.replace(/^\//, '')
}

/** Local style manifest, fetched once per session. Missing or malformed
 *  manifest degrades to "no local styles" rather than an error. */
export function fetchStyleManifest(): Promise<LocalStyleEntry[]> {
    // BASE_URL — see the note in scheme.ts; this manifest is served from the
    // same subpath and silently degrades to "no local styles" if it 404s.
    manifestPromise ??= fetch(`${import.meta.env.BASE_URL}styles/index.json`)
        .then(r => (r.ok ? r.json() : []))
        .then((entries: unknown) => (Array.isArray(entries) ? entries : [])
            .filter((e): e is LocalStyleEntry =>
                !!e && typeof e.id === 'string' && typeof e.url === 'string'
                && !(e.id in BUILTIN_STYLE_URLS) && e.id !== DINGO_STYLE_ID))
        .catch(() => [])
    return manifestPromise
}

/** A fetched local style, kept in both forms: `pristine` is the file as
 *  authored (with the {MAPTILER_KEY} placeholder) — the ONLY form that may
 *  ever be edited or saved back — and `resolved` is the key-substituted copy
 *  the map renders. Layer definitions never contain the placeholder (it only
 *  appears in root glyphs/sources), so layer edits made on the pristine copy
 *  apply verbatim to the live map. */
export interface CachedStyle {
    pristineText: string
    pristine: StyleSpecification
    resolved: StyleSpecification
}

const localStyleCache = new Map<string, CachedStyle>()

function cacheStyle(id: string, pristineText: string): CachedStyle {
    const entry: CachedStyle = {
        pristineText,
        pristine: JSON.parse(pristineText) as StyleSpecification,
        resolved: JSON.parse(pristineText.replaceAll('{MAPTILER_KEY}', MAPTILER_KEY)) as StyleSpecification,
    }
    localStyleCache.set(id, entry)
    return entry
}

/** Fetch (or return cached) local style by manifest id. Throws on failure. */
export async function getLocalStyle(id: string): Promise<CachedStyle> {
    const cached = localStyleCache.get(id)
    if (cached) return cached
    const entry = (await fetchStyleManifest()).find(e => e.id === id)
    if (!entry) throw new Error(`unknown local style '${id}'`)
    // Cache-bust: after a save/invalidate the browser cache may be stale.
    const res = await fetch(`${rebase(entry.url)}?v=${Date.now()}`)
    if (!res.ok) throw new Error(`failed to load style '${id}': ${res.status}`)
    return cacheStyle(id, await res.text())
}

/** Drop a cached local style so the next getLocalStyle refetches it. */
export function invalidateLocalStyle(id: string): void {
    localStyleCache.delete(id)
}

/** Replace the cached entry from freshly saved pristine text (no refetch). */
export function updateLocalStyleCache(id: string, pristineText: string): CachedStyle {
    return cacheStyle(id, pristineText)
}

/** True when the id refers to a manifest style (vs a MapTiler built-in).
 *  Only meaningful once the manifest has loaded; use the async form when
 *  correctness matters. */
export function isBuiltinStyle(id: string): boolean {
    return id in BUILTIN_STYLE_URLS
}

/** Resolve a persisted base-style id to what maplibre's setStyle accepts:
 *  a URL for built-ins, a fetched+key-substituted style object for local
 *  styles (night-remapped when mode is 'night' and the style carries a
 *  mapping). Unknown or unloadable ids fall back to satellite. */
export async function resolveBaseStyle(
    id: string,
    mode: 'day' | 'night' = 'day',
): Promise<string | StyleSpecification> {
    if (id === DINGO_STYLE_ID) {
        // Shared basemap, built in code from the core layer lineage + the
        // active scheme (see dingoBasemap.ts). Only the layer-file fetch can
        // fail; degrade like an unloadable local style.
        try {
            return await buildDingoStyle(mode)
        } catch {
            return BUILTIN_STYLE_URLS.satellite
        }
    }
    if (id in BUILTIN_STYLE_URLS) return BUILTIN_STYLE_URLS[id]
    try {
        const cached = await getLocalStyle(id)
        if (mode === 'night') {
            const map = nightMapOf(cached.pristine as never)
            if (map) {
                const night = structuredClone(cached.resolved)
                applyNightMap(night as never, map)
                return night
            }
        }
        return cached.resolved
    } catch {
        return BUILTIN_STYLE_URLS.satellite
    }
}

/** Overlay theming of a local style for the given mode (heat colours etc.),
 *  or null when the style defines none / isn't local. */
export async function styleOverlaysFor(
    id: string,
    mode: 'day' | 'night' = 'day',
): Promise<Record<string, string> | null> {
    // The Dingo style's overlay colours are already driven by the active
    // scheme (pickRideScheme writes the heat settings) — a second source
    // here would double-drive them.
    if (id === DINGO_STYLE_ID || id in BUILTIN_STYLE_URLS) return null
    try {
        const cached = await getLocalStyle(id)
        const overlays = overlaysOf(cached.pristine as never)
        if (!overlays) return null
        if (mode === 'night') {
            const map = nightMapOf(cached.pristine as never)
            if (map) {
                const out: Record<string, string> = {}
                for (const [k, v] of Object.entries(overlays)) {
                    const p = parseColor(v)
                    out[k] = p && map[p.hex] ? withAlpha(map[p.hex], p.alpha) : v
                }
                return out
            }
        }
        return overlays
    } catch {
        return null
    }
}

/** Manifest as react state — empty until loaded. */
export function useStyleManifest(): LocalStyleEntry[] {
    const [entries, setEntries] = useState<LocalStyleEntry[]>([])
    useEffect(() => {
        let alive = true
        fetchStyleManifest().then(e => { if (alive) setEntries(e) })
        return () => { alive = false }
    }, [])
    return entries
}
