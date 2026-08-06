/** Plan token applier — hand-aligned sibling of Studio's canonical
 *  js/applier-nav.js (see DingoStudio/sync-appliers.sh for which copies are
 *  canonical vs translated).
 *
 *  Plan's base maps are MapTiler / local MapLibre style JSONs, not Nav's
 *  basemap layer lineage, so a scheme's basemap paint tokens don't apply
 *  here. What a scheme drives in Plan (per the Studio design's Plan scope):
 *    - the app theme: hud.* tokens → Plan's CSS variables
 *    - Dingo's own overlay colours: overlays.heat* → the heat colour settings
 *  Day tokens only — Plan's night handling stays with the local styles'
 *  dingo:nightMap machinery. */
import { type DingoScheme, tok } from './scheme'

/** hud tokens → Plan's CSS variables (App.css :root). --accent-hover is
 *  derived (lightened accent) so hover states track a schemed accent. */
export function cssVarsOf(scheme: DingoScheme): Record<string, string> {
    const accent = String(tok(scheme, 'hud.accent'))
    return {
        '--bg-dark': String(tok(scheme, 'hud.bg')),
        '--pane-bg': String(tok(scheme, 'hud.panel')),
        '--text-primary': String(tok(scheme, 'hud.text')),
        '--text-secondary': String(tok(scheme, 'hud.dim')),
        '--accent': accent,
        '--accent-hover': lighten(accent, 0.15),
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
        for (const k of ['--bg-dark', '--pane-bg', '--text-primary', '--text-secondary', '--accent', '--accent-hover'])
            root.style.removeProperty(k)
        return
    }
    for (const [k, v] of Object.entries(cssVarsOf(scheme))) root.style.setProperty(k, v)
}

/** #rrggbb lightened toward white by t (0..1); non-hex input returned as-is. */
function lighten(hex: string, t: number): string {
    const m = /^#([0-9a-fA-F]{6})$/.exec(hex)
    if (!m) return hex
    const n = parseInt(m[1], 16)
    const ch = (v: number) => Math.round(v + (255 - v) * t)
    const [r, g, b] = [ch(n >> 16 & 255), ch(n >> 8 & 255), ch(n & 255)]
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}
