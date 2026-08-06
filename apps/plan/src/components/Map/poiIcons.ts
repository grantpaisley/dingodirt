// POI map icons, built from the SAME lucide icon set the rest of the UI uses.
//
// Mechanism: deck.gl's IconLayer wants a raster atlas + an {icon → rect}
// mapping. lucide-react ships React components, so each category's icon is
// rendered to static SVG markup (react-dom/server's renderToStaticMarkup),
// wrapped in a data: URL, loaded into an Image, and drawn onto one shared
// canvas — a coloured circular badge with the white glyph centred on it.
// The canvas is exported as a PNG data URL and handed to IconLayer as
// `iconAtlas` (deck loads URL atlases itself) with the per-category rects as
// `iconMapping`. Built once per session (the categories are a fixed enum)
// and cached in a module promise.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
    Fuel, Tent, Droplets, Beer, Bed, Camera, TriangleAlert, Cross, Info,
    Mountain, MapPin, type LucideIcon,
} from 'lucide-react'
import type { PoiCategory } from '../../store'

export interface PoiCategoryMeta {
    icon: LucideIcon
    label: string
    /** Badge colour ('#rrggbb') — also used by the layers-pane chips */
    color: string
    /** Declutter priority: lower survives grid-thinning first (fuel and camps
     *  matter most when planning; generic pins go first). */
    priority: number
}

/** Category → lucide icon, per the planned-routes design doc. */
export const POI_CATEGORY_META: Record<PoiCategory, PoiCategoryMeta> = {
    fuel: { icon: Fuel, label: 'Fuel', color: '#e67e22', priority: 0 },
    camp: { icon: Tent, label: 'Camping', color: '#2e9e4f', priority: 1 },
    water: { icon: Droplets, label: 'Water', color: '#2f8fd6', priority: 2 },
    food: { icon: Beer, label: 'Food & drink', color: '#d65a8c', priority: 3 },
    lodging: { icon: Bed, label: 'Lodging', color: '#8e6ae0', priority: 4 },
    medical: { icon: Cross, label: 'Medical', color: '#d64545', priority: 5 },
    hazard: { icon: TriangleAlert, label: 'Hazard', color: '#e0b428', priority: 6 },
    info: { icon: Info, label: 'Info', color: '#6b7f95', priority: 7 },
    summit: { icon: Mountain, label: 'Summit', color: '#7a5c3e', priority: 8 },
    scenic: { icon: Camera, label: 'Scenic', color: '#3aa6a0', priority: 9 },
    poi: { icon: MapPin, label: 'Other POI', color: '#8a8a8a', priority: 10 },
}

/** Atlas cell size in device px (drawn at 2x for crisp icons on retina) */
const CELL = 64
const GLYPH = 36

export interface PoiIconAtlas {
    /** PNG data URL of the atlas canvas (IconLayer's `iconAtlas`) */
    atlas: string
    mapping: Record<string, { x: number, y: number, width: number, height: number }>
}

function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = reject
        img.src = url
    })
}

let atlasPromise: Promise<PoiIconAtlas> | null = null

/** Build (once) the shared POI icon atlas. */
export function getPoiIconAtlas(): Promise<PoiIconAtlas> {
    if (!atlasPromise) atlasPromise = buildAtlas()
    return atlasPromise
}

async function buildAtlas(): Promise<PoiIconAtlas> {
    const categories = Object.keys(POI_CATEGORY_META) as PoiCategory[]
    const canvas = document.createElement('canvas')
    canvas.width = CELL * categories.length
    canvas.height = CELL
    const ctx = canvas.getContext('2d')!
    const mapping: PoiIconAtlas['mapping'] = {}

    await Promise.all(categories.map(async (cat, i) => {
        const meta = POI_CATEGORY_META[cat]
        // lucide-react component → static SVG markup → data URL → Image
        const svg = renderToStaticMarkup(createElement(meta.icon, {
            color: 'white',
            size: GLYPH,
            strokeWidth: 2.25,
            absoluteStrokeWidth: false,
        }))
        const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
        const cx = i * CELL + CELL / 2
        const cy = CELL / 2
        // Badge: filled colour disc with a white rim so pins read over both
        // satellite imagery and pale topo ground.
        ctx.beginPath()
        ctx.arc(cx, cy, CELL / 2 - 4, 0, Math.PI * 2)
        ctx.fillStyle = meta.color
        ctx.fill()
        ctx.lineWidth = 3
        ctx.strokeStyle = 'rgba(255,255,255,0.92)'
        ctx.stroke()
        ctx.drawImage(img, cx - GLYPH / 2, cy - GLYPH / 2, GLYPH, GLYPH)
        mapping[cat] = { x: i * CELL, y: 0, width: CELL, height: CELL }
    }))

    return { atlas: canvas.toDataURL('image/png'), mapping }
}
