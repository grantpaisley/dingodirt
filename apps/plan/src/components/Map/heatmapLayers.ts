// Strava-style density heatmap: every track drawn with additive blending so
// overlapping traversals accumulate brightness on the GPU — one pass is
// faint, ten glow, heavy repetition saturates toward white. No aggregation
// step, no rebuild: density falls out of the blend mode.
import { PathLayer } from '@deck.gl/layers'
import { MaskExtension } from '@deck.gl/extensions'
import type { TrackClass } from '../../store'

// Module scope on purpose: a fresh extension instance per render makes deck
// rebuild the layer shaders every frame.
const MASK = new MaskExtension()

export interface HeatPath {
    path: [number, number][]
    cls: TrackClass
}

// Base colours per class. Each carries a small amount of its non-dominant
// channels so heavy accumulation saturates to a white-hot core (pure hues
// would plateau at neon instead).
export const HEAT_COLORS: Record<TrackClass, [number, number, number]> = {
    own: [255, 130, 45],   // orange
    other: [255, 45, 70],  // red
    plan: [70, 140, 255],  // blue
}

// Additive blending (src-alpha, one): fragments add to what's already there
// instead of painting over it. luma.gl v9 parameter names (deck.gl 9.x).
const ADDITIVE = {
    blendColorOperation: 'add' as const,
    blendColorSrcFactor: 'src-alpha' as const,
    blendColorDstFactor: 'one' as const,
    blendAlphaOperation: 'add' as const,
    blendAlphaSrcFactor: 'one' as const,
    blendAlphaDstFactor: 'one' as const,
}

const clampAlpha = (v: number) => Math.max(2, Math.min(255, Math.round(v)))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export interface HeatStyle {
    /** Brightness multiplier (scales per-line alpha) */
    intensity: number
    /** Width multiplier (scales halo + core alike) */
    width: number
    /** 0 = fixed pixel width + fixed alpha at every zoom (original look),
     *  1 = measured Strava behaviour (meter widths with tight pixel clamps
     *  and zoom-graded alpha), between = blend of the two */
    zoomScaling: number
}

// Per-pass tuning, fitted against Strava's own heat tiles (2026-07-28 bench,
// Hornsby/Galston reference — see Docs/plans/2026-07-28-strava-heatmap-zoom-
// parity-design.md). The measured truth: Strava draws each pass as a
// CONSTANT ~1.5-CSS-px stroke at every tile zoom z6-z14 — no ground scaling
// at all. All the apparent widening as you zoom in is emergent (GPS scatter
// across repeated rides, plus brightness normalization), and past their z14
// tile cap the stroke doubles per zoom purely from raster overzoom. That
// maps onto meters+clamps neatly: meters small enough that the min clamp
// rules through display ~z15, with meter growth taking over beyond it,
// mimicking the overzoom. `fixedPx` is the zoomScaling-0 constant width
// (the original heatmap look).
const PASS_WIDTHS = {
    halo: { meters: 5, fixedPx: 7, minPx: 2.5, maxPx: 24 },
    core: { meters: 2.4, fixedPx: 2.2, minPx: 1.5, maxPx: 12 },
}

// Per-pass alpha, by display zoom. Strava's single-pass strokes peak at a
// constant ~90/255 across zooms, but their per-zoom normalization compresses
// accumulation hard when zoomed out (in-corridor p90 ~134 at tile z6, i.e.
// heavy corridors are barely brighter than singles) and opens up with zoom.
// A linear additive blend can't reproduce that compression, so the fit
// matches singles at high zoom (where trails separate and the single-line
// look dominates) and grades alpha down when zoomed out so converging
// corridors don't all slam to white. `fixed` is the zoomScaling-0 constant
// (original look); lo/hi interpolate over display zooms [loZ, hiZ].
const PASS_ALPHAS = {
    halo: { fixed: 12, lo: 5, hi: 12 },
    core: { fixed: 50, lo: 18, hi: 60 },
}
const ALPHA_LO_ZOOM = 9
const ALPHA_HI_ZOOM = 14

/**
 * Two additive passes per class: a wide faint halo (the glow) under a
 * narrow brighter core (the line). Draw order plan → other → own so the
 * user's own heat reads on top where classes overlap.
 *
 * Widths are in ground METERS with pixel clamps: the shader scales the
 * meter width with zoom, and the clamps bound it. `zoomScaling` slides the
 * clamps AND the alphas — at 0 they pinch to the fixed pixel width and
 * constant alpha (zoom changes nothing, the original heatmap look); at 1
 * they follow the curves measured off Strava's heat tiles (fine constant
 * filaments zoomed out, controlled widening + brightening zoomed in).
 *
 * `zoom` is the current display zoom (quantized by the caller so layers
 * aren't rebuilt every animation frame); it only drives the alpha grading.
 *
 * `maskId` clips the heat to another deck layer rendered with
 * `operation: 'mask'` — the pack preview uses it to show only the heat a
 * bundle would actually carry. The MapLibre inverse mask can't do this job:
 * deck renders on its own canvas above every MapLibre layer.
 *
 * `opts.colors` overrides the per-class base colour (the "Heat colors"
 * settings drive own + planned heat through it); `opts.idPrefix` namespaces
 * the layer ids so a second heat stack (planned heat) can coexist with the
 * own-heat stack in the same deck.
 */
export function buildHeatmapLayers(
    data: HeatPath[],
    style: HeatStyle,
    zoom: number,
    maskId?: string,
    opts?: { colors?: Partial<Record<TrackClass, [number, number, number]>>, idPrefix?: string },
) {
    const { intensity, width } = style
    const s = Math.max(0, Math.min(1, style.zoomScaling))
    const zt = Math.max(0, Math.min(1, (zoom - ALPHA_LO_ZOOM) / (ALPHA_HI_ZOOM - ALPHA_LO_ZOOM)))
    const idPrefix = opts?.idPrefix ?? 'heatmap'
    const layers = []
    for (const cls of ['plan', 'other', 'own'] as TrackClass[]) {
        const classData = data.filter(d => d.cls === cls)
        if (classData.length === 0) continue
        const [r, g, b] = opts?.colors?.[cls] ?? HEAT_COLORS[cls]
        for (const [pass, w, a] of [
            ['halo', PASS_WIDTHS.halo, PASS_ALPHAS.halo],
            ['core', PASS_WIDTHS.core, PASS_ALPHAS.core],
        ] as const) {
            const alpha = lerp(a.fixed, lerp(a.lo, a.hi, zt), s)
            layers.push(
                new PathLayer({
                    // The id carries the masked flag: deck can't add or drop an
                    // extension on an existing layer id — it reuses the cached
                    // layer and the mask binding never lands.
                    id: `${idPrefix}-${cls}-${pass}${maskId ? '-masked' : ''}`,
                    data: classData,
                    widthUnits: 'meters',
                    getWidth: w.meters * width,
                    widthMinPixels: lerp(w.fixedPx, w.minPx, s) * width,
                    widthMaxPixels: lerp(w.fixedPx, w.maxPx, s) * width,
                    capRounded: true,
                    jointRounded: true,
                    getPath: (d: HeatPath) => d.path,
                    getColor: [r, g, b, clampAlpha(alpha * intensity)],
                    parameters: ADDITIVE,
                    ...(maskId ? { extensions: [MASK], maskId } : {}),
                }),
            )
        }
    }
    return layers
}
