/** Read-side style helpers: apply a style's night remap and read its overlay
 *  theming. The style-layers EDITOR (attribute tables, palette tools, zoom
 *  ramps, the inspector panel) moved to Dingo Studio (DingoStudio repo,
 *  js/styleattrs.js + js/styleinspector.js) — Plan only renders styles now;
 *  it never edits them. Saving still goes through the daemon's /api/styles,
 *  which Studio talks to directly. */

const NAMED_COLORS: Record<string, string> = {
    white: '#ffffff',
    black: '#000000',
}

/** Parse a literal colour into hex + alpha. Returns null for expressions and
 *  formats we don't handle (hsl etc.). */
export function parseColor(v: unknown): { hex: string; alpha: number } | null {
    if (typeof v !== 'string') return null
    const s = v.trim().toLowerCase()
    if (s in NAMED_COLORS) return { hex: NAMED_COLORS[s], alpha: 1 }
    if (/^#[0-9a-f]{6}$/.test(s)) return { hex: s, alpha: 1 }
    if (/^#[0-9a-f]{3}$/.test(s)) {
        return { hex: `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`, alpha: 1 }
    }
    const m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/)
    if (m) {
        const to2 = (n: string) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0')
        return { hex: `#${to2(m[1])}${to2(m[2])}${to2(m[3])}`, alpha: m[4] !== undefined ? Number(m[4]) : 1 }
    }
    return null
}

/** Re-emit an edited hex colour, preserving the original literal's alpha. */
export function withAlpha(hex: string, alpha: number): string {
    if (alpha >= 1) return hex
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

type StyleLike = {
    metadata?: unknown
    layers: Array<{ paint?: unknown; layout?: unknown }>
}

/** Rewrite every usage of one allocation (base hex) to a new base colour,
 *  preserving each usage's alpha. Mutates the given (cloned) style. */
function replaceColorGlobal(style: StyleLike, fromHex: string, toHex: string): void {
    const conv = (v: unknown): unknown => {
        if (typeof v === 'string') {
            const p = parseColor(v)
            if (p && p.hex === fromHex) return withAlpha(toHex, p.alpha)
            return v
        }
        if (Array.isArray(v)) return v.map(conv)
        if (v && typeof v === 'object') {
            const o = v as Record<string, unknown>
            for (const k of Object.keys(o)) o[k] = conv(o[k])
            return o
        }
        return v
    }
    for (const l of style.layers) {
        if (l.paint) l.paint = conv(l.paint)
        if (l.layout) l.layout = conv(l.layout)
    }
    const meta = style.metadata as Record<string, unknown> | undefined
    if (meta && meta['dingo:overlays'] && typeof meta['dingo:overlays'] === 'object') {
        meta['dingo:overlays'] = conv(meta['dingo:overlays'])
    }
}

/** A style's night option: a palette remap in metadata "dingo:night"
 *  ({ dayHex: nightHex }), or null when the style defines none. */
export function nightMapOf(style: StyleLike): Record<string, string> | null {
    const m = (style.metadata as Record<string, unknown> | undefined)?.['dingo:night']
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
        if (typeof v === 'string' && parseColor(k) && parseColor(v)) {
            out[parseColor(k)!.hex] = parseColor(v)!.hex
        }
    }
    return Object.keys(out).length ? out : null
}

/** Apply a night mapping to a (cloned) style — layers, overlays, all string
 *  colours, alpha preserved per usage. */
export function applyNightMap(style: StyleLike, map: Record<string, string>): void {
    for (const [day, night] of Object.entries(map)) {
        if (day !== night) replaceColorGlobal(style, day, night)
    }
}

/** metadata "dingo:overlays": the colours for Dingo's own layers so a style
 *  (and its night mode) themes the whole map, heat included. */
export function overlaysOf(style: StyleLike): Record<string, string> | null {
    const m = (style.metadata as Record<string, unknown> | undefined)?.['dingo:overlays']
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v
    }
    return Object.keys(out).length ? out : null
}
