/** The shared Dingo basemap — Nav/Studio's Protomaps layer lineage
 *  (core/basemap/layers*.json, served from /public/basemap via symlink)
 *  rendered from the shared AU tile archive and themed by the active
 *  .dingoscheme through the canonical core applier. This is the style that
 *  keeps all three apps looking the same; the MapTiler built-ins and local
 *  styles stay available alongside it.
 *
 *  Tiles come straight off the archive via the pmtiles protocol (range
 *  requests — Plan is an online app, no corridor cache here). The default
 *  base URL is the shared R2 archive; localStorage['dtiles-base'] overrides
 *  it (same key Nav uses) so dev can point at a locally served archive.
 *
 *  Hillshade is NOT baked into this style: Plan already has its own
 *  hillshade/3D-terrain toggles (applyMapExtras in MapView) that layer a DEM
 *  over whatever base style is active, and baking the scheme's hillshade in
 *  as well would double-shade. Once the shared hillshade archive is live,
 *  pointing those toggles at it is a separate, style-agnostic step. */
import maplibregl from 'maplibre-gl'
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import { applyBaseOverrides, basePaintOverrides } from '../../../core/appliers/applier-nav.js'
import { resolveScheme, tok } from '../../../core/appliers/scheme.js'
import type { SchemeLike } from '../../../core/appliers/scheme'
import { useSettings } from './store'
import { getScheme } from './scheme/scheme'

/** BaseStyle id of the shared basemap (not a MapTiler built-in, not a
 *  manifest style — mapStyles.ts branches on it before both). */
export const DINGO_STYLE_ID = 'dingo'

/** Shared tile archive location. The localStorage override key matches Nav's
 *  so one setting redirects every app on the device during dev/self-host. */
const TILES_BASE_KEY = 'dtiles-base'
const DEFAULT_TILES_BASE = 'https://tiles.dingodirt.com/'

function tilesBase(): string {
    try {
        return localStorage.getItem(TILES_BASE_KEY) || DEFAULT_TILES_BASE
    } catch {
        return DEFAULT_TILES_BASE
    }
}

/** Register the pmtiles protocol once, lazily — only sessions that actually
 *  render the Dingo style pay for it. */
let protocolReady = false
function ensurePmtilesProtocol(): void {
    if (protocolReady) return
    maplibregl.addProtocol('pmtiles', new Protocol().tile)
    protocolReady = true
}

/** Base layer files, fetched once per session (they only change on deploy). */
const layerFileCache = new Map<string, Promise<LayerSpecification[]>>()
function fetchLayerFile(file: string): Promise<LayerSpecification[]> {
    let p = layerFileCache.get(file)
    if (!p) {
        // BASE_URL, not a leading slash — see the note in scheme.ts.
        p = fetch(`${import.meta.env.BASE_URL}basemap/${file}`)
            .then(r => {
                if (!r.ok) throw new Error(`failed to load basemap layers '${file}': ${r.status}`)
                return r.json() as Promise<LayerSpecification[]>
            })
        // A transient failure must not poison the session cache.
        p.catch(() => layerFileCache.delete(file))
        layerFileCache.set(file, p)
    }
    return p
}

/** The active .dingoscheme, mode-resolved (night overlay flattened in).
 *  'default' or an unloadable scheme resolves to the factory look — the
 *  applier's defaults, exactly like Nav with no scheme installed. */
async function activeScheme(mode: 'day' | 'night'): Promise<SchemeLike> {
    const id = useSettings.getState().rideScheme
    let scheme: SchemeLike = {}
    if (id !== 'default') {
        try {
            scheme = await getScheme(id)
        } catch {
            scheme = {}
        }
    }
    return resolveScheme(scheme, mode)
}

/** Build the full MapLibre style for the shared basemap. Throws only on a
 *  missing layer file — the caller (resolveBaseStyle) has a fallback. */
export async function buildDingoStyle(mode: 'day' | 'night' = 'day'): Promise<StyleSpecification> {
    ensurePmtilesProtocol()
    const scheme = await activeScheme(mode)
    const flavour = tok(scheme, 'basemap.base') === 'light' ? 'light' : 'dark'
    const baseLayers = await fetchLayerFile(flavour === 'light' ? 'layers-light.json' : 'layers.json')
    const layers = applyBaseOverrides(baseLayers, basePaintOverrides(scheme)) as LayerSpecification[]
    // String concat past the basemap dir — new URL() would %-encode the
    // {fontstack} tokens (Studio's buildStyle carries the same note).
    const assetBase = new URL(`${import.meta.env.BASE_URL}basemap/`, location.href).href
    return {
        version: 8,
        glyphs: `${assetBase}fonts/{fontstack}/{range}.pbf`,
        sprite: `${assetBase}sprites/${flavour}`,
        sources: {
            protomaps: {
                type: 'vector',
                url: `pmtiles://${tilesBase()}basemap-au.pmtiles`,
                attribution: '© OpenStreetMap, Protomaps',
            },
        },
        layers,
    }
}
