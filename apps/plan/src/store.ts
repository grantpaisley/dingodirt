// Central UI settings store — persisted to localStorage so colour
// boundaries, filters and toggles survive reloads.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { FilterValues } from './components/Filters/FilterPanel'
import type { RideSummary } from './api/hooks'

/** 'mode' colours rides by ride mode; 'hr' / 'speed' / 'grade' use the
 *  gradient scales (grade = absolute steepness %, ascent and descent alike) */
export type ColorMode = 'mode' | 'hr' | 'speed' | 'grade'
export type RideMode = 'adv' | 'enduro' | 'mtb' | 'watersport' | 'other'
/** Track classes: own recorded rides / other people's / plans (routes or
 *  timestamp-less tracks — anything with speed/duration is a recording).
 *  A general filter — applies to the rides layer, the list, and the heatmap. */
export type TrackClass = 'own' | 'other' | 'plan'
/** Track shape: loop (start ≈ end) vs oneway (point-to-point). A general
 *  filter — applies to the rides layer and the list. */
export type TrackShape = 'loop' | 'oneway'
/** Grade filter keys: difficulty 1-5 plus 'none' (ungraded) */
export type GradeKey = '1' | '2' | '3' | '4' | '5' | 'none'
/** When direction chevrons show: only on the hovered/selected track, on all
 *  tracks once zoomed in past z13, or on all tracks at every zoom. */
export type ArrowMode = 'hover' | 'zoom' | 'always'
/** Base map style id: one of the built-in MapTiler styles ('satellite' |
 *  'outdoor' | 'topo') or the id of a local style from /styles/index.json
 *  (see mapStyles.ts). Unknown ids resolve to satellite at load time. */
export type BaseStyle = string
/** Day/night variant of the active local style (night = the palette remap
 *  stored in the style's metadata; ignored by styles without one). */
export type BaseStyleMode = 'day' | 'night'
/** Detail level of the Dingo base style — when tracks/minor roads appear
 *  (core/appliers/detail.js). 'auto' follows the active scheme's
 *  basemap.detail token; the other values override it. */
export type DetailLevel = 'auto' | 'populated' | 'regional' | 'outback'

export const ALL_MODES: RideMode[] = ['adv', 'enduro', 'mtb', 'watersport', 'other']

/** POI categories (matches the daemon's poi_category enum) */
export type PoiCategory =
    | 'fuel' | 'camp' | 'water' | 'food' | 'lodging'
    | 'scenic' | 'hazard' | 'medical' | 'info' | 'summit' | 'poi'

export const ALL_POI_CATEGORIES: PoiCategory[] = [
    'fuel', 'camp', 'water', 'food', 'lodging',
    'scenic', 'hazard', 'medical', 'info', 'summit', 'poi',
]

const allPoiCategoriesOn = (): Record<PoiCategory, boolean> =>
    Object.fromEntries(ALL_POI_CATEGORIES.map(c => [c, true])) as Record<PoiCategory, boolean>

/** Heat layer colour defaults: orange = me (own recorded heat); blue =
 *  everything not ridden by me — the harvested Strava overlays and planned
 *  heat both default to the Strava-blue family (#1e6ee6 is the mid stop of
 *  the daemon's BLUE colourising ramp for the Strava rasters). */
export const HEAT_COLOR_DEFAULTS = {
    own: '#ff822d',      // matches the heat layer's [255,130,45] orange
    strava: '#1e6ee6',   // daemon ramp mid-blue — hue reference for the raster tint
    planned: '#1e6ee6',
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

/** '#rrggbb' → [r,g,b]; falls back to the given default on malformed input
 *  (per-route colours come from imported GPX files, so trust nothing). */
export function hexToRgb(hex: string | null | undefined, fallback: [number, number, number]): [number, number, number] {
    if (!hex || !HEX_COLOR_RE.test(hex)) return fallback
    return [
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16),
    ]
}

/// Gradient colour scales (HR / speed / grade), user adjustable in settings.
/// Each scale picks a palette, toggles which of its colours are used (min 2),
/// and places one value stop per active colour: at a stop the track is exactly
/// that colour, between stops it blends, outside the ends it clamps.
export interface ColourScale {
    /** Key into PALETTES */
    palette: string
    /** Which palette swatches are in use (same length as the palette) */
    enabled: boolean[]
    /** Ascending values, one per enabled colour */
    stops: number[]
}

export type RGBA = [number, number, number, number]

/** Named colour sets. All the same length so palette switches keep the
 *  enabled-swatch selection and stops intact. */
export const PALETTES: Record<string, { label: string, colors: RGBA[] }> = {
    thermal: {
        label: 'Thermal',
        colors: [[0, 0, 255, 255], [0, 255, 255, 255], [0, 255, 0, 255], [255, 255, 0, 255], [255, 0, 0, 255]],
    },
    spectrum: {
        label: 'Spectrum',
        colors: [[128, 0, 128, 255], [0, 0, 255, 255], [0, 255, 255, 255], [0, 255, 0, 255], [255, 255, 0, 255]],
    },
    heat: {
        label: 'Heat',
        colors: [[0, 200, 80, 255], [255, 255, 0, 255], [255, 150, 0, 255], [255, 30, 30, 255], [230, 0, 255, 255]],
    },
    fire: {
        label: 'Fire',
        colors: [[100, 10, 0, 255], [255, 30, 30, 255], [255, 150, 0, 255], [255, 255, 0, 255], [255, 255, 255, 255]],
    },
    ice: {
        label: 'Ice',
        colors: [[10, 30, 120, 255], [0, 110, 255, 255], [0, 200, 255, 255], [160, 240, 255, 255], [255, 255, 255, 255]],
    },
    viridis: {
        label: 'Viridis',
        colors: [[68, 1, 84, 255], [59, 82, 139, 255], [33, 145, 140, 255], [94, 201, 98, 255], [253, 231, 37, 255]],
    },
}

const ALL_ON = [true, true, true, true, true]
export const DEFAULT_HR_SCALE: ColourScale =
    { palette: 'thermal', enabled: [...ALL_ON], stops: [108, 126, 145, 163, 172] }
export const DEFAULT_SPEED_SCALE: ColourScale =
    { palette: 'spectrum', enabled: [...ALL_ON], stops: [0, 5, 15, 30, 80] }
export const DEFAULT_GRADE_SCALE: ColourScale =
    { palette: 'heat', enabled: [...ALL_ON], stops: [0, 4, 8, 14, 22] }

export const DEFAULT_FILTERS: FilterValues = {
    hrAvgMin: null, hrAvgMax: null,
    hrMaxMin: null, hrMaxMax: null,
    speedAvgMin: null, speedAvgMax: null,
    speedMaxMin: null, speedMaxMax: null,
    distanceMin: null, distanceMax: null,
    hrAvgEnabled: false, hrMaxEnabled: false,
    speedAvgEnabled: false, speedMaxEnabled: false,
    distanceEnabled: false,
}

interface SettingsState {
    /** Show ride tracks on the map */
    showRides: boolean
    colorMode: ColorMode
    enabledModes: RideMode[]
    filters: FilterValues
    /** Only show tracks that have heart-rate data */
    requireHr: boolean
    /** Only show tracks that have speed data */
    requireSpeed: boolean
    /** Date range filter (ISO yyyy-mm-dd, empty = open-ended) */
    dateFrom: string
    dateTo: string
    /** Hide all unselected tracks when a selection exists */
    focusMode: boolean
    /** One-time migration marker: focus mode used to default ON, which made a
     *  map click rewrite the track list. Selection now only highlights, so
     *  pre-existing profiles get pulled onto the new off default exactly once. */
    focusOffDefault2026?: boolean
    /** Opacity of non-highlighted tracks while a highlight context (selection,
     *  search matches, or the export basket) is active. 0.05–0.6. */
    dimmedOpacity: number
    /** Zoom the map to fit the selection whenever it changes */
    autoZoom: boolean
    /** Show photo dots on the map */
    showPhotos: boolean
    /** Show the density heatmap (independent overlay, like rides) */
    showHeatmap: boolean
    /** Strava heat as raster overlays under our own layers, split by sport:
     *  ride (blue) and hike (purple). Served from the daemon's harvested
     *  MBTiles at /api/heat/strava-ride and /api/heat/strava-hike. */
    showStravaRide: boolean
    showStravaHike: boolean
    /** Planned-route collections toggled OFF (inverted so newly imported
     *  collections default to visible without a migration). */
    plannedCollectionsOff: string[]
    /** Show the POI layer (fuel, camps, water… from planned-route imports) */
    showPois: boolean
    /** Per-category POI filter chips */
    poiCategories: Record<PoiCategory, boolean>
    /** Density heat over ALL planned geometry, independent of the
     *  per-collection route toggles — "where does every other route run?" */
    showPlannedHeat: boolean
    /** Heat colours ('#rrggbb'): own recorded heat (default orange), the
     *  Strava raster overlays (approximate tint — see MapView), planned heat. */
    heatColorOwn: string
    heatColorStrava: string
    heatColorPlanned: string
    /** Active ride schema id ('.dingoscheme' preset from /public/schemes) —
     *  'default' = factory theme, nothing mounted. Selection overwrites the
     *  scheme-driven settings (heat colours); CSS vars re-mount on boot. */
    rideScheme: string
    /** Base map style — satellite (hybrid imagery), outdoor (terrain topo),
     *  or topo (classic topographic) */
    baseStyle: BaseStyle
    baseStyleMode: BaseStyleMode
    /** Dingo-style detail level ('auto' = the scheme's basemap.detail) */
    detailLevel: DetailLevel
    /** Hillshade relief shading over the base map */
    hillshade: boolean
    /** 3D terrain (visible when the map is pitched — right-drag). Tracks
     *  render flat, so they can detach from steep relief while pitched. */
    terrain3d: boolean
    /** Show area boundaries (the areas table) as outlines */
    showAreas: boolean
    /** Live road-closures overlay (SA outback warnings + NSW/VIC closures near
     *  library tracks). Advisory only — plain settings toggle, deliberately
     *  outside EffectiveLayers: live data is never pack content. */
    showClosures: boolean
    /** Which track classes show — own (orange) / other (red) / plan (blue).
     *  Filters rides, the list, AND the heatmap. */
    trackClasses: Record<TrackClass, boolean>
    /** Owner ids toggled OFF in the per-owner facet under "Other rides" —
     *  default all on, so newly-seen owners show without bookkeeping. Only
     *  filters other-class tracks (own/plan stay governed by their rows). */
    ownersOff: string[]
    /** Which track shapes show — loop (start ≈ end) / oneway (point-to-point).
     *  Filters the rides layer and the list. */
    shapeClasses: Record<TrackShape, boolean>
    /** Which difficulty grades show (1-5 + ungraded) — rides layer, list,
     *  Places counts */
    gradeFilter: Record<GradeKey, boolean>
    /** Heat brightness multiplier (scales per-line alpha) */
    heatIntensity: number
    /** Heat line width multiplier (scales halo + core alike) */
    heatWidth: number
    /** How heat widths respond to zoom: 0 = fixed pixel width at every zoom
     *  (the original look), 1 = full Strava-style ground-meter scaling
     *  (collapses to filaments zoomed out, swells zoomed in). Values between
     *  blend the two by narrowing the pixel clamps around the fixed width. */
    heatZoomScaling: number
    /** One-time migration marker: profiles persisted before the 2026-07-28
     *  heat retune get pulled onto the new zoomScaling default exactly once. */
    heatRetuned2026?: boolean
    /** When ride direction chevrons are shown */
    arrowMode: ArrowMode
    /** HR colour scale (bpm) — palette, colours in use, value stops */
    hrScale: ColourScale
    /** Speed colour scale (km/h) */
    speedScale: ColourScale
    /** Grade colour scale (% steepness, unsigned) */
    gradeScale: ColourScale

    toggleShowRides: () => void
    /** Layers-pane rows. "My rides" covers own + planned, "Other rides" covers
     *  other. Both write trackClasses — still the single filter source of truth
     *  for the rides layer, the list and rideMatchesFilters — and keep
     *  showRides in sync as the derived master (any class on = rides drawn). */
    toggleMyRides: () => void
    toggleOtherRides: () => void
    setColorMode: (m: ColorMode) => void
    toggleMode: (m: RideMode) => void
    setFilters: (f: FilterValues) => void
    setRequireHr: (v: boolean) => void
    setRequireSpeed: (v: boolean) => void
    setDateFrom: (v: string) => void
    setDateTo: (v: string) => void
    setFocusMode: (v: boolean) => void
    setDimmedOpacity: (v: number) => void
    setAutoZoom: (v: boolean) => void
    setShowPhotos: (v: boolean) => void
    toggleShowHeatmap: () => void
    toggleShowStravaRide: () => void
    toggleShowStravaHike: () => void
    togglePlannedCollection: (name: string) => void
    setShowPois: (v: boolean) => void
    togglePoiCategory: (c: PoiCategory) => void
    toggleShowPlannedHeat: () => void
    setHeatColorOwn: (hex: string) => void
    setHeatColorStrava: (hex: string) => void
    setHeatColorPlanned: (hex: string) => void
    resetHeatColors: () => void
    setRideScheme: (id: string) => void
    setBaseStyle: (s: BaseStyle) => void
    setBaseStyleMode: (m: BaseStyleMode) => void
    setDetailLevel: (d: DetailLevel) => void
    setHillshade: (v: boolean) => void
    setTerrain3d: (v: boolean) => void
    setShowAreas: (v: boolean) => void
    setShowClosures: (v: boolean) => void
    toggleTrackClass: (c: TrackClass) => void
    toggleOwnerOff: (id: string) => void
    toggleShapeClass: (c: TrackShape) => void
    toggleGradeKey: (g: GradeKey) => void
    setHeatIntensity: (v: number) => void
    setHeatWidth: (v: number) => void
    setHeatZoomScaling: (v: number) => void
    setArrowMode: (m: ArrowMode) => void
    setHrScale: (s: ColourScale) => void
    setSpeedScale: (s: ColourScale) => void
    setGradeScale: (s: ColourScale) => void
    resetColourScales: () => void
}

export const useSettings = create<SettingsState>()(
    persist(
        (set) => ({
            showRides: true,
            colorMode: 'mode',
            enabledModes: [...ALL_MODES],
            filters: { ...DEFAULT_FILTERS },
            requireHr: false,
            requireSpeed: false,
            dateFrom: '',
            dateTo: '',
            focusMode: false,
            // In the defaults so fresh stores persist it immediately — only
            // blobs that predate the off default lack it and get migrated.
            focusOffDefault2026: true,
            dimmedOpacity: 0.2,
            autoZoom: false,
            showPhotos: true,
            showHeatmap: false,
            showStravaRide: false,
            showStravaHike: false,
            plannedCollectionsOff: [],
            showPois: false,
            poiCategories: allPoiCategoriesOn(),
            showPlannedHeat: false,
            heatColorOwn: HEAT_COLOR_DEFAULTS.own,
            heatColorStrava: HEAT_COLOR_DEFAULTS.strava,
            heatColorPlanned: HEAT_COLOR_DEFAULTS.planned,
            rideScheme: 'default',
            baseStyle: 'satellite',
            baseStyleMode: 'day',
            detailLevel: 'auto',
            hillshade: false,
            terrain3d: false,
            showAreas: false,
            showClosures: false,
            trackClasses: { own: true, other: true, plan: true },
            ownersOff: [],
            shapeClasses: { loop: true, oneway: true },
            gradeFilter: { '1': true, '2': true, '3': true, '4': true, '5': true, none: true },
            heatIntensity: 1,
            heatWidth: 1,
            heatZoomScaling: 1,
            arrowMode: 'zoom',
            hrScale: structuredClone(DEFAULT_HR_SCALE),
            speedScale: structuredClone(DEFAULT_SPEED_SCALE),
            gradeScale: structuredClone(DEFAULT_GRADE_SCALE),

            toggleShowRides: () => set((s) => ({ showRides: !s.showRides })),
            toggleMyRides: () =>
                set((s) => {
                    const on = !(s.trackClasses.own || s.trackClasses.plan)
                    const trackClasses = { ...s.trackClasses, own: on, plan: on }
                    return { trackClasses, showRides: on || trackClasses.other }
                }),
            toggleOtherRides: () =>
                set((s) => {
                    const trackClasses = { ...s.trackClasses, other: !s.trackClasses.other }
                    return {
                        trackClasses,
                        showRides: trackClasses.own || trackClasses.plan || trackClasses.other,
                    }
                }),
            setColorMode: (colorMode) => set({ colorMode }),
            toggleMode: (m) =>
                set((s) => ({
                    enabledModes: s.enabledModes.includes(m)
                        ? s.enabledModes.filter((x) => x !== m)
                        : [...s.enabledModes, m],
                })),
            setFilters: (filters) => set({ filters }),
            setRequireHr: (requireHr) => set({ requireHr }),
            setRequireSpeed: (requireSpeed) => set({ requireSpeed }),
            setDateFrom: (dateFrom) => set({ dateFrom }),
            setDateTo: (dateTo) => set({ dateTo }),
            setFocusMode: (focusMode) => set({ focusMode }),
            setDimmedOpacity: (dimmedOpacity) => set({ dimmedOpacity }),
            setAutoZoom: (autoZoom) => set({ autoZoom }),
            setShowPhotos: (showPhotos) => set({ showPhotos }),
            toggleShowHeatmap: () => set((s) => ({ showHeatmap: !s.showHeatmap })),
            toggleShowStravaRide: () => set((s) => ({ showStravaRide: !s.showStravaRide })),
            toggleShowStravaHike: () => set((s) => ({ showStravaHike: !s.showStravaHike })),
            togglePlannedCollection: (name) =>
                set((s) => ({
                    plannedCollectionsOff: s.plannedCollectionsOff.includes(name)
                        ? s.plannedCollectionsOff.filter(n => n !== name)
                        : [...s.plannedCollectionsOff, name],
                })),
            setShowPois: (showPois) => set({ showPois }),
            togglePoiCategory: (c) =>
                set((s) => ({ poiCategories: { ...s.poiCategories, [c]: !s.poiCategories[c] } })),
            toggleShowPlannedHeat: () => set((s) => ({ showPlannedHeat: !s.showPlannedHeat })),
            setHeatColorOwn: (heatColorOwn) => set({ heatColorOwn }),
            setHeatColorStrava: (heatColorStrava) => set({ heatColorStrava }),
            setHeatColorPlanned: (heatColorPlanned) => set({ heatColorPlanned }),
            resetHeatColors: () =>
                set({
                    heatColorOwn: HEAT_COLOR_DEFAULTS.own,
                    heatColorStrava: HEAT_COLOR_DEFAULTS.strava,
                    heatColorPlanned: HEAT_COLOR_DEFAULTS.planned,
                }),
            setRideScheme: (rideScheme) => set({ rideScheme }),
            setBaseStyle: (baseStyle) => set({ baseStyle }),
            setBaseStyleMode: (baseStyleMode) => set({ baseStyleMode }),
            setDetailLevel: (detailLevel) => set({ detailLevel }),
            setHillshade: (hillshade) => set({ hillshade }),
            setTerrain3d: (terrain3d) => set({ terrain3d }),
            setShowAreas: (showAreas) => set({ showAreas }),
            setShowClosures: (showClosures) => set({ showClosures }),
            toggleTrackClass: (c) =>
                set((s) => ({ trackClasses: { ...s.trackClasses, [c]: !s.trackClasses[c] } })),
            toggleOwnerOff: (id) =>
                set((s) => ({
                    ownersOff: s.ownersOff.includes(id)
                        ? s.ownersOff.filter(x => x !== id)
                        : [...s.ownersOff, id],
                })),
            toggleShapeClass: (c) =>
                set((s) => ({ shapeClasses: { ...s.shapeClasses, [c]: !s.shapeClasses[c] } })),
            toggleGradeKey: (g) =>
                set((s) => ({ gradeFilter: { ...s.gradeFilter, [g]: !s.gradeFilter[g] } })),
            setHeatIntensity: (heatIntensity) => set({ heatIntensity }),
            setHeatWidth: (heatWidth) => set({ heatWidth }),
            setHeatZoomScaling: (heatZoomScaling) => set({ heatZoomScaling }),
            setArrowMode: (arrowMode) => set({ arrowMode }),
            setHrScale: (hrScale) => set({ hrScale }),
            setSpeedScale: (speedScale) => set({ speedScale }),
            setGradeScale: (gradeScale) => set({ gradeScale }),
            resetColourScales: () =>
                set({
                    hrScale: structuredClone(DEFAULT_HR_SCALE),
                    speedScale: structuredClone(DEFAULT_SPEED_SCALE),
                    gradeScale: structuredClone(DEFAULT_GRADE_SCALE),
                }),
        }),
        {
            name: 'dingo-ui-settings',
            // Older persisted state may carry removed keys (viewMode,
            // trafficSide, showSegments, hrBounds/speedBounds/gradeBounds —
            // harmless leftovers) and a removed 'character' colorMode.
            merge: (persisted, current) => {
                const p = persisted as Partial<SettingsState> & Record<string, unknown>
                const merged = { ...current, ...p }
                // 2026-07-28 heat retune: zoomScaling 1 is now "measured Strava
                // behaviour" and the default. Persisted profiles predating the
                // retune carry the old default (0.5) or 0 without ever having
                // chosen it — pull them onto the new default once, marked so a
                // deliberate later change sticks.
                if (!p.heatRetuned2026) {
                    merged.heatZoomScaling = 1
                    merged.heatRetuned2026 = true
                }
                // 2026-08-08 selection stability: focus mode's old ON default
                // meant a map click rewrote the track list. Selection now only
                // highlights + scrolls the list, so profiles that never chose
                // focus mode move onto the new off default once.
                if (!p.focusOffDefault2026) {
                    merged.focusMode = false
                    merged.focusOffDefault2026 = true
                }
                if (!(['mode', 'hr', 'speed', 'grade'] as const).includes(merged.colorMode)) {
                    merged.colorMode = 'mode'
                }
                // Colour scales: validate persisted shape; migrate the old
                // 4-boundary tuples (pre-palette era) so tuned values survive.
                const validScale = (s: unknown): s is ColourScale => {
                    const c = s as ColourScale
                    return !!c && typeof c === 'object'
                        && !!PALETTES[c.palette]
                        && Array.isArray(c.enabled)
                        && c.enabled.length === PALETTES[c.palette].colors.length
                        && c.enabled.filter(Boolean).length >= 2
                        && Array.isArray(c.stops)
                        && c.stops.length === c.enabled.filter(Boolean).length
                        && c.stops.every((v, i) => typeof v === 'number' && (i === 0 || v > c.stops[i - 1]))
                }
                const oldBounds = (v: unknown): v is number[] =>
                    Array.isArray(v) && v.length === 4 && v.every(x => typeof x === 'number')
                const upgrade = (
                    key: 'hrScale' | 'speedScale' | 'gradeScale',
                    oldKey: string,
                    fallback: ColourScale,
                    fromOld: (b: number[]) => number[],
                ) => {
                    if (validScale(p[key])) return
                    const old = p[oldKey]
                    const stops = oldBounds(old) ? fromOld(old) : null
                    merged[key] = stops && stops.every((v, i) => i === 0 || v > stops[i - 1])
                        ? { ...structuredClone(fallback), stops }
                        : structuredClone(fallback)
                }
                // Old HR bounds meant "red above the last stop"; old speed and
                // grade ramps implicitly started at 0.
                upgrade('hrScale', 'hrBounds', DEFAULT_HR_SCALE, b => [...b, b[3] + 9])
                upgrade('speedScale', 'speedBounds', DEFAULT_SPEED_SCALE, b => [0, ...b])
                upgrade('gradeScale', 'gradeBounds', DEFAULT_GRADE_SCALE, b => [0, ...b])
                if (typeof merged.dimmedOpacity !== 'number'
                    || merged.dimmedOpacity < 0.05 || merged.dimmedOpacity > 0.6) {
                    merged.dimmedOpacity = 0.2
                }
                // Any string id is allowed (local styles come from the
                // /styles manifest); ids that no longer resolve fall back to
                // satellite in mapStyles.resolveBaseStyle, not here.
                if (typeof merged.baseStyle !== 'string' || !merged.baseStyle) {
                    merged.baseStyle = 'satellite'
                }
                // Ride schema id: same rule — any string; ids that no longer
                // resolve clear back to 'default' at mount, not here.
                if (typeof merged.rideScheme !== 'string' || !merged.rideScheme) {
                    merged.rideScheme = 'default'
                }
                if (merged.baseStyleMode !== 'day' && merged.baseStyleMode !== 'night') {
                    merged.baseStyleMode = 'day'
                }
                if (!['auto', 'populated', 'regional', 'outback'].includes(merged.detailLevel)) {
                    merged.detailLevel = 'auto'
                }
                if (!merged.gradeFilter || typeof merged.gradeFilter !== 'object') {
                    merged.gradeFilter = { '1': true, '2': true, '3': true, '4': true, '5': true, none: true }
                }
                // 2026-07-28 planned routes & POIs: validate the new persisted
                // slices. plannedCollectionsOff is inverted (names toggled OFF)
                // so freshly imported collections show without any migration;
                // poiCategories is backfilled key-by-key so a future category
                // enum addition defaults on for existing profiles.
                if (!Array.isArray(merged.plannedCollectionsOff)
                    || !merged.plannedCollectionsOff.every(n => typeof n === 'string')) {
                    merged.plannedCollectionsOff = []
                }
                const poiCats = ((merged.poiCategories && typeof merged.poiCategories === 'object')
                    ? merged.poiCategories : {}) as Partial<Record<PoiCategory, unknown>>
                merged.poiCategories = Object.fromEntries(
                    ALL_POI_CATEGORIES.map(c => {
                        const v = poiCats[c]
                        return [c, typeof v === 'boolean' ? v : true]
                    })
                ) as Record<PoiCategory, boolean>
                for (const key of ['heatColorOwn', 'heatColorStrava', 'heatColorPlanned'] as const) {
                    if (typeof merged[key] !== 'string' || !HEX_COLOR_RE.test(merged[key])) {
                        merged[key] = key === 'heatColorOwn'
                            ? HEAT_COLOR_DEFAULTS.own
                            : key === 'heatColorStrava' ? HEAT_COLOR_DEFAULTS.strava : HEAT_COLOR_DEFAULTS.planned
                    }
                }
                return merged
            },
        }
    )
)

// ---- Export basket ----
// Rides accumulated for export across any number of gestures (lasso, search,
// list clicks). Persisted so a reload doesn't lose a half-built basket; it is
// per-browser state, not a server-side entity.

interface BasketState {
    ids: string[]
    add: (ids: string[]) => void
    remove: (ids: string[]) => void
    toggle: (id: string) => void
    clear: () => void
    /** Drop ids the server no longer recognises (deleted / superseded rides) */
    prune: (staleIds: string[]) => void
}

export const useBasket = create<BasketState>()(
    persist(
        (set) => ({
            ids: [],
            add: (newIds) =>
                set((s) => ({ ids: Array.from(new Set([...s.ids, ...newIds])) })),
            remove: (removeIds) =>
                set((s) => {
                    const drop = new Set(removeIds)
                    return { ids: s.ids.filter(id => !drop.has(id)) }
                }),
            toggle: (id) =>
                set((s) => ({
                    ids: s.ids.includes(id)
                        ? s.ids.filter(x => x !== id)
                        : [...s.ids, id],
                })),
            clear: () => set({ ids: [] }),
            prune: (staleIds) =>
                set((s) => {
                    const drop = new Set(staleIds)
                    return { ids: s.ids.filter(id => !drop.has(id)) }
                }),
        }),
        { name: 'dingo-export-basket' }
    )
)

// ---- Session UI state (not persisted) ----
// The list owns the search box, but the map needs the query too (search
// matches are a dim-highlight context), so it lives here rather than in
// component state.

/** What the left list pane shows: the track list, the export basket, the
 *  Places location tree, or the saved Packs. */
export type ListView = 'tracks' | 'basket' | 'places' | 'packs'

interface UiState {
    searchQuery: string
    setSearchQuery: (q: string) => void
    listView: ListView
    setListView: (v: ListView) => void
    /** Packs view: the pack whose contents the right pane shows */
    selectedPackId: string | null
    setSelectedPackId: (id: string | null) => void
    /** Places tree: open folder keys + the last-clicked folder — session
     *  state, held here so toggling away from Places and back keeps the
     *  tree exactly as it was */
    placesOpen: string[]
    togglePlacesOpen: (key: string) => void
    placesActive: string | null
    setPlacesActive: (key: string | null) => void
    /** Bundle coverage preview: the corridor polygon and/or rect bbox a pack /
     *  export would cover, drawn on the map as light grey outlines while the
     *  pack detail or export dialog is open. Null = nothing to preview. */
    coveragePreview: CoveragePreview | null
    setCoveragePreview: (p: CoveragePreview | null) => void
    /** "Pack layers only" preview: the map renders exactly what the pack's
     *  bundle carries, clipped to its coverage. Transient by design — a preview
     *  surviving a reload with no pack open would be undiagnosable. */
    packPreview: PackPreview | null
    setPackPreview: (p: PackPreview | null) => void
    /** Pack mark edits drawn on the map while the review section is open:
     *  pending at reduced opacity, accepted full — the visual diff of what
     *  the next refresh bakes. Null = nothing to show. */
    markPreview: MarkPreview | null
    setMarkPreview: (p: MarkPreview | null) => void
    /** Live map zoom, quantised to 0.1 so per-frame move events don't cause
     *  render storms. Read by the toolbar zoom widget and the style-layers
     *  panel (rows appear/disappear as thresholds are crossed). */
    mapZoom: number
    setMapZoom: (z: number) => void
    /** Bumped after a style-file save/revert so MapView re-applies the SAME
     *  base style id (its applied-style ref guard otherwise short-circuits). */
    styleReloadNonce: number
    bumpStyleReload: () => void
    /** Overlay theming from the active local style's metadata
     *  ("dingo:overlays", night-remapped when mode is night): heat/planned/
     *  Strava colours. Null = style defines none → settings colours apply. */
    styleOverlays: Record<string, string> | null
    setStyleOverlays: (o: Record<string, string> | null) => void
}

export interface MarkPreviewPoint {
    id: string
    lat: number
    lon: number
    kind: string
    op: 'add' | 'remove'
    status: 'pending' | 'accepted'
}

export interface MarkPreview {
    marks: MarkPreviewPoint[]
    /** Clicked review row — its point gets the highlight ring */
    focusId: string | null
}

export interface CoveragePreview {
    /** Track-following corridor polygon (GeoJSON MultiPolygon) */
    corridor: GeoJSON.MultiPolygon | null
    /** Selection bbox + margin: [minLon, minLat, maxLon, maxLat] */
    rect: [number, number, number, number] | null
    /** Draw the rect outline too (some layer is in rect mode) */
    showRect: boolean
    /** Zoomed-out overview region outline (drawn fainter than the corridor) */
    overview?: GeoJSON.MultiPolygon | null
    /** 'single' (default) — grey outlines of what THIS pack/export config
     *  covers. 'all' — every coverage shape at once, colour-coded, so the
     *  basket can show each layer's boundary before any config is chosen. */
    mode?: 'single' | 'all'
}

/** Coverage-shape colours for the 'all' preview mode, shared by the map layer
 *  and the basket legend so the two can't drift. */
export const COVERAGE_SHAPE_COLORS = {
    corridor: [80, 200, 255] as [number, number, number],
    rect: [255, 190, 80] as [number, number, number],
    region: [190, 140, 255] as [number, number, number],
}

type MaskShape = GeoJSON.Polygon | GeoJSON.MultiPolygon

export interface PackPreview {
    packId: string
    /** Which map layers the bundle actually carries */
    layers: {
        myRides: boolean
        otherRides: boolean
        myHeatmap: boolean
        stravaRide: boolean
        stravaHike: boolean
        photos: boolean
        areas: boolean
        hillshade: boolean
    }
    /** Base style the bundle implies, or null to leave the user's choice */
    baseStyle: BaseStyle | null
    clip: {
        /** Basemap / satellite / hillshade band. null = mask everything. */
        lower: MaskShape | null
        /** Strava heat: detailed corridor at z11+, coarse region below. */
        stravaDetail: MaskShape | null
        stravaOverview: MaskShape | null
        /** Heat mask features — several rasterize into one deck mask texture,
         *  which is how corridor ∪ overview happens without boolean geometry. */
        heat: MaskShape[]
    }
}

/** Layer state as the map should actually render it: the user's own settings,
 *  or the pack's recipe while a preview is active. Pure, because the MapLibre
 *  side reads it through useSettings.getState() and must resolve identically.
 *  A preview NEVER writes to useSettings — exiting is setPackPreview(null),
 *  with no restore bookkeeping to lose on a reload or a mid-preview crash. */
export interface EffectiveLayers {
    trackClasses: Record<TrackClass, boolean>
    showRides: boolean
    showHeatmap: boolean
    showStravaRide: boolean
    showStravaHike: boolean
    showPhotos: boolean
    showAreas: boolean
    hillshade: boolean
    baseStyle: BaseStyle
}

export function effectiveLayerState(
    s: Pick<SettingsState, 'trackClasses' | 'showRides' | 'showHeatmap' | 'showStravaRide'
        | 'showStravaHike' | 'showPhotos' | 'showAreas' | 'hillshade' | 'baseStyle'>,
    preview: PackPreview | null,
): EffectiveLayers {
    if (!preview) {
        return {
            trackClasses: s.trackClasses,
            showRides: s.showRides,
            showHeatmap: s.showHeatmap,
            showStravaRide: s.showStravaRide,
            showStravaHike: s.showStravaHike,
            showPhotos: s.showPhotos,
            showAreas: s.showAreas,
            hillshade: s.hillshade,
            baseStyle: s.baseStyle,
        }
    }
    const l = preview.layers
    return {
        trackClasses: { own: l.myRides, plan: l.myRides, other: l.otherRides },
        showRides: l.myRides || l.otherRides,
        showHeatmap: l.myHeatmap,
        showStravaRide: l.stravaRide,
        showStravaHike: l.stravaHike,
        showPhotos: l.photos,
        showAreas: l.areas,
        hillshade: l.hillshade,
        baseStyle: preview.baseStyle ?? s.baseStyle,
    }
}

export const useUiState = create<UiState>()((set) => ({
    searchQuery: '',
    setSearchQuery: (searchQuery) => set({ searchQuery }),
    listView: 'tracks',
    setListView: (listView) => set({ listView }),
    selectedPackId: null,
    setSelectedPackId: (selectedPackId) => set({ selectedPackId }),
    placesOpen: [],
    togglePlacesOpen: (key) =>
        set((s) => ({
            placesOpen: s.placesOpen.includes(key)
                ? s.placesOpen.filter(k => k !== key)
                : [...s.placesOpen, key],
        })),
    placesActive: null,
    setPlacesActive: (placesActive) => set({ placesActive }),
    coveragePreview: null,
    setCoveragePreview: (coveragePreview) => set({ coveragePreview }),
    packPreview: null,
    setPackPreview: (packPreview) => set({ packPreview }),
    markPreview: null,
    setMarkPreview: (markPreview) => set({ markPreview }),
    mapZoom: 10,
    setMapZoom: (z) =>
        set((s) => {
            const q = Math.round(z * 10) / 10
            return q === s.mapZoom ? s : { mapZoom: q }
        }),
    styleReloadNonce: 0,
    bumpStyleReload: () => set((s) => ({ styleReloadNonce: s.styleReloadNonce + 1 })),
    styleOverlays: null,
    setStyleOverlays: (styleOverlays) => set({ styleOverlays }),
}))

/** True when any range filter is enabled — drives toolbar badge + grey tier */
export function hasActiveRangeFilters(filters: FilterValues): boolean {
    return (
        filters.hrAvgEnabled ||
        filters.hrMaxEnabled ||
        filters.speedAvgEnabled ||
        filters.speedMaxEnabled ||
        filters.distanceEnabled
    )
}

/** Free-text search over a ride's name and the localities it passes through
 *  (suburbs, LGAs, region, state). Space-separated terms must ALL match
 *  (AND); each term is a case-insensitive substring. Empty query = matches
 *  everything. */
export function rideMatchesSearch(
    ride: Pick<RideSummary, 'name' | 'state' | 'region' | 'lgas' | 'suburbs' | 'source' | 'owner'>,
    query: string
): boolean {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return true
    const haystack = [
        ride.name ?? '',
        ride.source ?? '',
        ride.owner ?? '',
        ride.state ?? '',
        ride.region ?? '',
        ...(ride.lgas ?? []),
        ...(ride.suburbs ?? []),
    ]
        .join(' ')
        .toLowerCase()
    return terms.every(t => haystack.includes(t))
}

/** Shared track-level filter — used by BOTH the map (grey-out / hide) and the
 *  list (rows removed) so they always agree. */
export function rideMatchesFilters(
    ride: Pick<RideSummary, 'mode' | 'class' | 'is_loop' | 'avg_hr' | 'max_hr' | 'avg_speed' | 'max_speed' | 'distance_m' | 'started_at' | 'grade' | 'owner_id'> & { collection?: string | null },
    s: Pick<SettingsState, 'enabledModes' | 'trackClasses' | 'shapeClasses' | 'gradeFilter' | 'filters' | 'requireHr' | 'requireSpeed' | 'dateFrom' | 'dateTo' | 'plannedCollectionsOff' | 'ownersOff'>
): boolean {
    if (!s.enabledModes.includes((ride.mode || 'other') as RideMode)) return false
    // Curated planned routes (imported collections) are governed by the
    // Planned-routes section's per-collection toggles, NOT the class rows —
    // "My rides" shouldn't drag a whole GOAT network on and off with it.
    if (ride.collection) {
        if (s.plannedCollectionsOff.includes(ride.collection)) return false
    } else if (!s.trackClasses[(ride.class || 'own') as TrackClass]) return false
    // Per-owner facet (nested under "Other rides" in the layers pane) — only
    // other-class tracks, so hiding an owner there never touches own/plan rows.
    // `?.`: a mid-flight HMR swap can run this against a store instance created
    // before ownersOff existed — a throw here blanks the whole tracks list.
    if (ride.class === 'other' && ride.owner_id && s.ownersOff?.includes(ride.owner_id)) return false
    // Loops close on themselves; anything else (incl. null/degenerate) reads as
    // point-to-point so it still shows under the default 'oneway' filter.
    if (!s.shapeClasses[ride.is_loop ? 'loop' : 'oneway']) return false
    if (!s.gradeFilter[(ride.grade != null ? String(ride.grade) : 'none') as GradeKey]) return false
    if (s.requireHr && ride.avg_hr == null) return false
    if (s.requireSpeed && ride.avg_speed == null) return false

    if (s.dateFrom && (!ride.started_at || ride.started_at.slice(0, 10) < s.dateFrom)) return false
    if (s.dateTo && (!ride.started_at || ride.started_at.slice(0, 10) > s.dateTo)) return false

    const f = s.filters
    const inRange = (v: number | null | undefined, min: number | null, max: number | null) =>
        v != null && (min == null || v >= min) && (max == null || v <= max)

    if (f.distanceEnabled && !inRange(ride.distance_m != null ? ride.distance_m / 1000 : null, f.distanceMin, f.distanceMax)) return false
    if (f.hrAvgEnabled && !inRange(ride.avg_hr, f.hrAvgMin, f.hrAvgMax)) return false
    if (f.hrMaxEnabled && !inRange(ride.max_hr, f.hrMaxMin, f.hrMaxMax)) return false
    if (f.speedAvgEnabled && !inRange(ride.avg_speed, f.speedAvgMin, f.speedAvgMax)) return false
    if (f.speedMaxEnabled && !inRange(ride.max_speed, f.speedMaxMin, f.speedMaxMax)) return false
    return true
}

// ---- Colour scales (fixed user-set boundaries, not data-normalised) ----

/** Track colour per ride mode */
export const MODE_COLORS: Record<string, RGBA> = {
    adv: [255, 140, 0, 200],        // Orange
    enduro: [220, 20, 60, 200],     // Crimson
    mtb: [34, 139, 34, 200],        // Forest Green
    watersport: [0, 190, 200, 200], // Aqua
    other: [100, 149, 237, 200],    // Cornflower Blue
}

/** Highlighted (hover/selected) versions — brighter */
export const MODE_COLORS_BRIGHT: Record<string, RGBA> = {
    adv: [255, 165, 0, 255],
    enduro: [255, 69, 0, 255],
    mtb: [50, 205, 50, 255],
    watersport: [0, 230, 240, 255],
    other: [135, 206, 250, 255],
}

function lerp(a: RGBA, b: RGBA, t: number): RGBA {
    return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t),
        255,
    ]
}

const GRAY: RGBA = [128, 128, 128, 200]

/** The palette colours a scale actually uses, in palette order */
export function activeColors(scale: ColourScale): RGBA[] {
    return PALETTES[scale.palette].colors.filter((_, i) => scale.enabled[i])
}

/** Colour for a value: exact palette colour at each stop, blended between
 *  stops, clamped to the end colours outside; grey for missing data.
 *  (Grade callers pass unsigned steepness.) */
export function scaleColor(value: number | null, scale: ColourScale): RGBA {
    if (value == null) return GRAY
    const colors = activeColors(scale)
    const stops = scale.stops
    if (value <= stops[0]) return colors[0]
    for (let i = 0; i < stops.length - 1; i++) {
        if (value <= stops[i + 1]) {
            const t = (value - stops[i]) / (stops[i + 1] - stops[i] || 1)
            return lerp(colors[i], colors[i + 1], t)
        }
    }
    return colors[colors.length - 1]
}

// ---- Gradient bar rendering (legend + settings editor share these so the
// bar, stop tick lines and draggable markers all agree on positions) ----

export function cssColor(c: RGBA): string {
    return `rgb(${c[0]},${c[1]},${c[2]})`
}

/** Value domain the gradient bar spans (padded past the outer stops) */
export function scaleDomain(kind: 'hr' | 'speed' | 'grade', scale: ColourScale): [number, number] {
    const first = scale.stops[0]
    const last = scale.stops[scale.stops.length - 1]
    if (kind === 'hr') {
        return [Math.min(40, first - 10), Math.max(200, last + 15)]
    }
    if (kind === 'grade') {
        return [Math.min(0, first), Math.max(30, Math.ceil(last * 1.15))]
    }
    return [Math.min(0, first), Math.max(100, Math.ceil(last * 1.15))]
}

/** Percentage position of each stop within the bar's domain */
export function stopsToPercents(kind: 'hr' | 'speed' | 'grade', scale: ColourScale): number[] {
    const [dMin, dMax] = scaleDomain(kind, scale)
    return scale.stops.map(b => ((b - dMin) / (dMax - dMin)) * 100)
}

/** Value-proportional CSS gradient matching scaleColor (clamped ends) */
export function gradientCss(kind: 'hr' | 'speed' | 'grade', scale: ColourScale): string {
    const colors = activeColors(scale)
    const p = stopsToPercents(kind, scale)
    const parts = [
        `${cssColor(colors[0])} 0%`,
        ...colors.map((c, i) => `${cssColor(c)} ${p[i]}%`),
        `${cssColor(colors[colors.length - 1])} 100%`,
    ]
    return `linear-gradient(90deg, ${parts.join(', ')})`
}
