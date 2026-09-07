/** Plan token applier — hand-aligned sibling of Studio's canonical
 *  js/applier-nav.js (see DingoStudio/sync-appliers.sh for which copies are
 *  canonical vs translated).
 *
 *  What a scheme drives in Plan:
 *    - the app theme: hud.* tokens → Plan's CSS variables
 *    - Dingo's own overlay colours: overlays.heat* → the heat colour settings
 *    - the 'dingo' base style: basemap.* paint tokens, applied by the
 *      canonical core applier inside dingoBasemap.ts (the MapTiler built-ins
 *      and local styles still ignore basemap tokens — they are not the
 *      shared layer lineage).
 *  Day tokens only here — the dingo style resolves the scheme's night
 *  overlay itself via baseStyleMode; local styles keep their dingo:nightMap
 *  machinery. */
import { type DingoScheme, tok } from './scheme'

/** The CSS variables a scheme mounts — cleared together in applySchemeVars. */
const SCHEME_VARS = ['--bg-dark', '--pane-bg', '--text-primary', '--text-secondary', '--accent', '--accent-hover', '--dd-surface-2'] as const

/** True when the scheme's chrome is light (hud.bg nearer white than black).
 *  Such a scheme flips the whole core/ui palette to its light set via
 *  [data-mode="light"] — every token the scheme does not drive itself
 *  (hairlines, toggle fill, raised surfaces, status hues) would otherwise
 *  stay ink-dark on a paper pane: selected rows went black-on-black and an
 *  active toggle was bone on white. */
export function hudIsLight(scheme: DingoScheme): boolean {
    const rgb = parseHex(String(tok(scheme, 'hud.bg')))
    if (!rgb) return false
    const [r, g, b] = rgb
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5
}

/** hud tokens → Plan's CSS variables (App.css :root). --accent-hover is
 *  derived (accent lightened on a dark chrome, darkened on a light one) so
 *  hover states track a schemed accent; --dd-surface-2 (selected rows,
 *  menus) is derived one step off the panel in the same direction, so a
 *  scheme whose panel is already white still shows a raised step. */
export function cssVarsOf(scheme: DingoScheme): Record<string, string> {
    const accent = String(tok(scheme, 'hud.accent'))
    const panel = String(tok(scheme, 'hud.panel'))
    const light = hudIsLight(scheme)
    return {
        '--bg-dark': String(tok(scheme, 'hud.bg')),
        '--pane-bg': panel,
        '--text-primary': String(tok(scheme, 'hud.text')),
        '--text-secondary': String(tok(scheme, 'hud.dim')),
        '--accent': accent,
        '--accent-hover': light ? darken(accent, 0.15) : lighten(accent, 0.15),
        '--dd-surface-2': light ? darken(panel, 0.07) : lighten(panel, 0.07),
    }
}

/** overlay tokens → the heat colour settings. Plan's "Strava overlays" tint
 *  is the closest home for "heat — other riders". */
export function heatColorsOf(scheme: DingoScheme): { own: string; strava: string; planned: string } {
    return {
        own: String(tok(scheme, 'overlays.heatOwn')),
        strava: String(tok(scheme, 'overlays.heatOther')),
        planned: String(tok(scheme, 'overlays.heatPlan')),
    }
}

/** Mount (or clear, with null) a scheme's CSS variables on :root. Clearing
 *  removes the inline overrides so the stylesheet factory values return. */
export function applySchemeVars(scheme: DingoScheme | null): void {
    const root = document.documentElement
    if (!scheme) {
        for (const k of SCHEME_VARS) root.style.removeProperty(k)
        delete root.dataset.mode
        return
    }
    for (const [k, v] of Object.entries(cssVarsOf(scheme))) root.style.setProperty(k, v)
    if (hudIsLight(scheme)) root.dataset.mode = 'light'
    else delete root.dataset.mode
}

/** #rrggbb → [r, g, b], or null for anything else. */
function parseHex(hex: string): [number, number, number] | null {
    const m = /^#([0-9a-fA-F]{6})$/.exec(hex)
    if (!m) return null
    const n = parseInt(m[1], 16)
    return [n >> 16 & 255, n >> 8 & 255, n & 255]
}

/** #rrggbb moved toward white (target 255) or black (target 0) by t (0..1);
 *  non-hex input returned as-is. */
function mix(hex: string, target: number, t: number): string {
    const rgb = parseHex(hex)
    if (!rgb) return hex
    const [r, g, b] = rgb.map(v => Math.round(v + (target - v) * t))
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

function lighten(hex: string, t: number): string {
    return mix(hex, 255, t)
}

function darken(hex: string, t: number): string {
    return mix(hex, 0, t)
}
