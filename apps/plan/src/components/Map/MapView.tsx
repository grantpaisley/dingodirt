import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import maplibregl, { type StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Deck } from '@deck.gl/core'
import { PathLayer, LineLayer, ScatterplotLayer, TextLayer, IconLayer } from '@deck.gl/layers'
import { ChevronLeft, ChevronRight, ExternalLink, Magnet, X } from 'lucide-react'
import { GeoJsonLayer } from '@deck.gl/layers'
import { useQueryClient } from '@tanstack/react-query'
import { useRides, useAllRidePoints, usePhotos, useHeatmap, usePois, useAreas, fetchRideIdsInPolygon, fetchRidesByIds, createPlan, SERVER_BASE, type Bounds, type PhotoSummary, type Poi } from '../../api/hooks'
import { MapToolbar } from './MapToolbar'
import { buildHeatmapLayers, HEAT_COLORS, type HeatPath } from './heatmapLayers'
import { getPoiIconAtlas, POI_CATEGORY_META, type PoiIconAtlas } from './poiIcons'
import { useSettings, useBasket, useUiState, rideMatchesFilters, rideMatchesSearch, scaleColor, stopsToPercents, gradientCss, hexToRgb, MODE_COLORS, MODE_COLORS_BRIGHT, COVERAGE_SHAPE_COLORS, HEAT_COLOR_DEFAULTS, effectiveLayerState, type RideMode, type BaseStyle, type MarkPreviewPoint, type PackPreview, type PoiCategory } from '../../store'
import { inverseMask } from './maskGeometry'
import { MAPTILER_KEY, BUILTIN_STYLE_URLS, resolveBaseStyle, styleOverlaysFor } from '../../mapStyles'
import { setMapInstance } from './mapRegistry'

/** Mark-kind dot colours — the DingoNav picker palette. `remove` overrides
 *  (a removal edit is about the spot, not the kind). */
const MARK_COLORS: Record<string, [number, number, number]> = {
    turn: [109, 177, 255],
    danger: [240, 194, 75],
    obstacle: [239, 159, 39],
    gate: [180, 178, 169],
    creek: [93, 202, 165],
    fuel: [133, 183, 235],
    food: [237, 147, 177],
    lookout: [175, 169, 236],
    camp: [151, 196, 89],
    remove: [226, 75, 74],
}

const markGlyph = (d: MarkPreviewPoint) =>
    d.op === 'remove' ? '×' : d.kind === 'danger' ? '!' : (d.kind[0] ?? 't').toUpperCase()

type RGBA = [number, number, number, number]

interface MapViewProps {
    selectedIds: string[]
    hoveredId: string | null
    onSelect: (ids: string[]) => void
    onHover: (id: string | null) => void
    onBoundsChange?: (bounds: Bounds) => void
    /** Profile → map: graph cursor position rendered as a dot on the track */
    graphCursor?: { position: [number, number], pinned?: boolean } | null
    /** Map → profile: reports the cursor's position while hovering a
     *  SELECTED track (the profile graph shows selected rides) */
    onTrackHoverPoint?: (p: { rideId: string, lon: number, lat: number } | null) => void
    /** Fly the camera to a bounding box (Places folder click); nonce lets the
     *  same box fly again */
    flyTo?: { bbox: [number, number, number, number], nonce: number } | null
}

/** Photos within ~11 m (4 decimal places) collapse into one map dot */
interface PhotoGroup {
    lon: number
    lat: number
    photos: PhotoSummary[]
}

/** Photo card state: screen position + the photo group under the cursor.
 *  Hover shows a transient card; clicking the dot pins it (stays until the
 *  X button or a click elsewhere on the map). */
interface PhotoCard {
    x: number
    y: number
    photos: PhotoSummary[]
    index: number
    pinned: boolean
}

const INITIAL_VIEW_STATE = {
    longitude: 151.2,
    latitude: -33.9,
    zoom: 10,
    pitch: 0,
    bearing: 0
}

/** Initial style for the map constructor, which needs a synchronous value:
 *  built-ins are plain URLs; local styles start as an empty stub that the
 *  async resolveBaseStyle swap replaces right after init. */
function initialMapStyle(id: BaseStyle): string | StyleSpecification {
    return BUILTIN_STYLE_URLS[id] ?? { version: 8 as const, sources: {}, layers: [] }
}

/** Terrain elevation tiles (raster-dem) for hillshade + 3D terrain */
const TERRAIN_TILES_URL =
    `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${MAPTILER_KEY}`

/** First symbol (label) layer in the active style — overlays insert below it
 *  so place names stay readable. */
function firstSymbolLayerId(m: maplibregl.Map): string | undefined {
    return m.getStyle().layers?.find(l => l.type === 'symbol')?.id
}

/** Layers in the current style, or 0 if it hasn't parsed yet — getStyle()
 *  throws while a setStyle is mid-flight. */
function styleLayerCount(m: maplibregl.Map): number {
    try {
        return m.getStyle()?.layers?.length ?? 0
    } catch {
        return 0
    }
}

// Pack-preview mask layers (see maskGeometry.ts). Two bands: everything under
// the Strava rasters, and the Strava rasters themselves — they carry different
// coverage in a bundle, so they can't share one mask.
const PACK_MASK_IDS = ['pack-mask-lower', 'pack-mask-strava'] as const
const EMPTY_FEATURES: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
/** Masked-out ground reads as the app's empty background, not as black. */
const MASK_COLOR = '#0f0f1a'
/** A bundle bakes Strava heat at corridor scope from here up; below this only
 *  the coarse region pyramid exists, so the mask widens to match. */
const STRAVA_DETAIL_MIN_ZOOM = 11

/** POI pins hide below this zoom — 1500 pins over half a state is chaff. */
const POI_MIN_ZOOM = 7
/** Below this zoom POIs also grid-thin to roughly one pin per screen cell. */
const POI_FULL_DETAIL_ZOOM = 10

/** Hue (degrees, 0-360) of an '#rrggbb' colour — for the Strava raster tint. */
function hexHueDeg(hex: string): number {
    const [r, g, b] = hexToRgb(hex, [30, 110, 230]).map(v => v / 255)
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    if (max === min) return 0
    const d = max - min
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h *= 60
    return h < 0 ? h + 360 : h
}
const STRAVA_BASE_HUE = hexHueDeg(HEAT_COLOR_DEFAULTS.strava)

interface Chevron {
    position: [number, number]
    angle: number
    color: RGBA
    pixelOffset: [number, number]
}

/** Walk a path (oriented along travel) and emit a direction chevron every
 *  `spacingM` metres, interpolating inside long vertex spans (simplified
 *  geometry can have straights hundreds of metres between vertices).
 *  `shiftPx` moves chevrons perpendicular to travel (positive = left, for
 *  placing them on an offset stripe); `inView` culls to the viewport. */
function emitPathChevrons(
    path: [number, number][],
    spacingM: number,
    shiftPx: number,
    color: RGBA,
    inView: (lon: number, lat: number) => boolean,
    out: Chevron[],
) {
    let travelled = 0
    let next = spacingM / 2
    for (let i = 0; i < path.length - 1; i++) {
        const [lon1, lat1] = path[i]
        const [lon2, lat2] = path[i + 1]
        const dx = (lon2 - lon1) * 111320 * Math.cos(lat1 * Math.PI / 180)
        const dy = (lat2 - lat1) * 110540
        const segLen = Math.hypot(dx, dy)
        if (segLen === 0) continue
        const rad = Math.atan2(dy, dx)
        // Left-of-travel in screen px (+y is down) = [-sin, -cos]
        const pixelOffset: [number, number] =
            [-Math.sin(rad) * shiftPx, -Math.cos(rad) * shiftPx]
        while (next <= travelled + segLen) {
            const t = (next - travelled) / segLen
            next += spacingM
            const lon = lon1 + (lon2 - lon1) * t
            const lat = lat1 + (lat2 - lat1) * t
            if (!inView(lon, lat)) continue
            out.push({
                position: [lon, lat],
                angle: rad * 180 / Math.PI, // deck.gl text angle: CCW degrees
                color,
                pixelOffset,
            })
        }
        travelled += segLen
    }
}

// (Mode colours + HR/speed scales live in ../../store.ts — shared with the toolbar)

/** Unsigned steepness (%) per point, smoothed over a ±75 m distance window.
 *  Raw point-to-point grade from GPS/barometric elevation is far too noisy;
 *  averaging rise over ~150 m of travel reads like a trail's actual pitch.
 *  Points missing elevation or distance stay null (rendered grey). When the
 *  window collapses (sparse points on straights), it falls back to the
 *  immediate neighbours so long straight sections don't grey out. */
function computeGrades(
    points: { elevation: number | null, distance_m: number | null }[]
): (number | null)[] {
    const grades: (number | null)[] = new Array(points.length).fill(null)
    const idxs: number[] = []
    for (let i = 0; i < points.length; i++) {
        if (points[i].elevation != null && points[i].distance_m != null) idxs.push(i)
    }
    if (idxs.length < 2) return grades

    const HALF_WINDOW_M = 75
    const MIN_RUN_M = 10 // under this much travel, grade is meaningless noise
    let lo = 0
    let hi = 0
    for (let k = 0; k < idxs.length; k++) {
        const d = points[idxs[k]].distance_m!
        while (points[idxs[lo]].distance_m! < d - HALF_WINDOW_M) lo++
        while (hi < idxs.length - 1 && points[idxs[hi + 1]].distance_m! <= d + HALF_WINDOW_M) hi++
        let a = Math.min(lo, k)
        let b = Math.max(hi, k)
        if (b === a) {
            a = Math.max(0, k - 1)
            b = Math.min(idxs.length - 1, k + 1)
        }
        const pa = points[idxs[a]]
        const pb = points[idxs[b]]
        const run = pb.distance_m! - pa.distance_m!
        if (run >= MIN_RUN_M) {
            grades[idxs[k]] = Math.abs((pb.elevation! - pa.elevation!) / run) * 100
        }
    }
    return grades
}

export function MapView({ selectedIds, hoveredId, onSelect, onHover, onBoundsChange, graphCursor, onTrackHoverPoint, flyTo }: MapViewProps) {
    const mapContainer = useRef<HTMLDivElement>(null)
    const deckCanvas = useRef<HTMLCanvasElement>(null)
    const map = useRef<maplibregl.Map | null>(null)
    const deck = useRef<Deck | null>(null)
    // Ref so the map-init effect (empty deps) always sees the latest callback
    const onBoundsChangeRef = useRef(onBoundsChange)
    onBoundsChangeRef.current = onBoundsChange
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE)
    // UI settings from the persisted store (shared with ListPane; the map
    // toolbar owns all the setters — this component only reads)
    const {
        showRides: rawShowRides,
        colorMode,
        enabledModes,
        filters,
        requireHr,
        requireSpeed,
        dateFrom, dateTo,
        focusMode,
        dimmedOpacity,
        autoZoom,
        showPhotos: rawShowPhotos,
        showHeatmap: rawShowHeatmap, showStravaRide: rawShowStravaRide,
        showStravaHike: rawShowStravaHike, trackClasses: rawTrackClasses,
        shapeClasses, heatIntensity, heatWidth, heatZoomScaling,
        baseStyle: rawBaseStyle, hillshade: rawHillshade, terrain3d,
        showAreas: rawShowAreas,
        gradeFilter,
        arrowMode,
        hrScale, speedScale, gradeScale,
        plannedCollectionsOff, ownersOff, showPois, poiCategories, showPlannedHeat,
        heatColorOwn: settingsHeatOwn, heatColorStrava: settingsHeatStrava,
        heatColorPlanned: settingsHeatPlanned, baseStyleMode,
    } = useSettings()
    const { ids: basketIds } = useBasket()
    const { searchQuery, coveragePreview, markPreview, packPreview, styleOverlays } = useUiState()
    // Overlay colours: the active style's theming wins over the settings
    // pickers (built-in styles define none, so settings still apply there).
    const heatColorOwn = styleOverlays?.heatOwn ?? settingsHeatOwn
    const heatColorStrava = styleOverlays?.heatStrava ?? settingsHeatStrava
    const heatColorPlanned = styleOverlays?.heatPlanned ?? settingsHeatPlanned
    // While a pack preview is on, the map renders the PACK's layer recipe
    // instead of the user's toggles. Resolved through the same pure function
    // the MapLibre side uses, and never written back into useSettings.
    const {
        showRides, showPhotos, showHeatmap, showStravaRide, showStravaHike,
        trackClasses, baseStyle, hillshade, showAreas,
    } = useMemo(() => effectiveLayerState({
        trackClasses: rawTrackClasses,
        showRides: rawShowRides,
        showHeatmap: rawShowHeatmap,
        showStravaRide: rawShowStravaRide,
        showStravaHike: rawShowStravaHike,
        showPhotos: rawShowPhotos,
        showAreas: rawShowAreas,
        hillshade: rawHillshade,
        baseStyle: rawBaseStyle,
    }, packPreview), [
        rawTrackClasses, rawShowRides, rawShowHeatmap, rawShowStravaRide, rawShowStravaHike,
        rawShowPhotos, rawShowAreas, rawHillshade, rawBaseStyle, packPreview,
    ])
    const [bounds, setBounds] = useState<{ minLon: number, minLat: number, maxLon: number, maxLat: number } | undefined>()
    const queryClient = useQueryClient()
    // Route drawer: click to add vertices, Backspace undo, Enter/Finish saves
    // as a plan-class ride. Pan/zoom stay live while drawing (unlike the
    // lasso) — long routes need mid-draw navigation.
    const [drawMode, setDrawMode] = useState(false)
    const [drawPath, setDrawPath] = useState<[number, number][]>([])
    const drawModeRef = useRef(false)
    drawModeRef.current = drawMode
    // Snap drawing to existing tracks (magnet toggle); when consecutive
    // vertices snap to the SAME ride, the drawn route follows that ride's
    // intermediate points ("follow my track").
    const [snapDraw, setSnapDraw] = useState(true)
    const snapDrawRef = useRef(true)
    snapDrawRef.current = snapDraw
    // Store the snapped POSITION (not just an index): ride geometry is
    // refetched at a different simplification tier across zoom 11/15, so a
    // stored index would point into a differently-sized array. The follow
    // splice re-resolves the previous point against the CURRENT path.
    const lastSnapRef = useRef<{ rideId: string, pt: [number, number] } | null>(null)
    const [savePlanOpen, setSavePlanOpen] = useState(false)
    const [planName, setPlanName] = useState('')
    const [planMode, setPlanMode] = useState('adv')
    const [planSaving, setPlanSaving] = useState(false)
    const [planError, setPlanError] = useState<string | null>(null)
    // Freehand lasso selection (mouse or finger)
    const [lassoActive, setLassoActive] = useState(false)
    const [lassoPath, setLassoPath] = useState<{ x: number, y: number }[]>([])
    const lassoPathRef = useRef<{ x: number, y: number }[]>([])
    const lassoDrawing = useRef(false)
    // Fetch rides filtered by current viewport bounds, geometry simplified
    // to the zoom tier (a 30k-ride zoomed-out payload is unusable at full res)
    const { data: rides, isLoading } = useRides(bounds, viewState.zoom)
    // Photos (small dataset; fetched once, toggled client-side)
    const { data: photos } = usePhotos()
    // Heatmap tracks: tier-simplified classed geometries (own/other/plan).
    // Planned heat is baked from the same feed, so either toggle keeps it hot.
    const { data: heatTracks } = useHeatmap(showHeatmap || showPlannedHeat, viewState.zoom, bounds)
    // Area boundaries (fetched once when the overlay is on)
    const { data: areas } = useAreas(showAreas)
    // POIs (fuel/camps/water… from planned-route imports): viewport-windowed
    // fetch, gated behind the toggle and a min zoom so a zoomed-out map never
    // drowns in pins.
    const poisEnabled = showPois && viewState.zoom >= POI_MIN_ZOOM
    const { data: pois } = usePois(poisEnabled, bounds)
    // deck IconLayer atlas rendered from the lucide icon set (see poiIcons.ts)
    const [poiAtlas, setPoiAtlas] = useState<PoiIconAtlas | null>(null)
    useEffect(() => {
        if (!showPois || poiAtlas) return
        let cancelled = false
        getPoiIconAtlas().then(a => { if (!cancelled) setPoiAtlas(a) })
        return () => { cancelled = true }
    }, [showPois, poiAtlas])
    // POI popover (click a pin → name/category/description card; X or a
    // click elsewhere on the map dismisses)
    const [poiCard, setPoiCard] = useState<{ x: number, y: number, poi: Poi } | null>(null)
    // Photo hover card (kept open while the cursor is over the card itself)
    const [photoCard, setPhotoCard] = useState<PhotoCard | null>(null)

    // Collapse photos taken at (nearly) the same spot into single dots
    const photoGroups = useMemo<PhotoGroup[]>(() => {
        if (!photos) return []
        const groups = new Map<string, PhotoGroup>()
        for (const p of photos) {
            const key = `${p.lon.toFixed(4)},${p.lat.toFixed(4)}`
            const g = groups.get(key)
            if (g) {
                g.photos.push(p)
            } else {
                groups.set(key, { lon: p.lon, lat: p.lat, photos: [p] })
            }
        }
        return Array.from(groups.values())
    }, [photos])

    // Chevron spacing is screen-space (~one per 140 px of track) so density
    // stays constant across zooms instead of exploding as you zoom in.
    // Zoom/lat are quantised so panning/zooming doesn't recompute per frame.
    const chevronZoom = Math.round(viewState.zoom * 2) / 2
    const chevronLat = Math.round(viewState.latitude * 10) / 10

    // Determine if we should load gradient points (zoom >= 8 AND <= 100 rides)
    const shouldLoadGradients = viewState.zoom >= 8 && (rides?.length || 0) <= 100
    const rideIds = useMemo(() => {
        // Point-level data only feeds ride gradients (HR/speed/grade in rides mode)
        if (!shouldLoadGradients || !showRides
            || (colorMode !== 'hr' && colorMode !== 'speed' && colorMode !== 'grade')) return []
        return rides?.map(r => r.id) || []
    }, [rides, shouldLoadGradients, colorMode, showRides])

    // Only fetch points when gradient mode is active and conditions are met
    const { data: allRidePoints, isLoading: isLoadingPoints } = useAllRidePoints(rideIds)

    // Transform rides data for Deck.gl - include mode and stats for coloring/filtering
    const ridesData = useMemo(() =>
        rides?.map(ride => ({
            id: ride.id,
            path: ride.geometry?.coordinates || [],
            name: ride.name,
            mode: ride.mode || 'other',
            avgHr: ride.avg_hr,
            maxHr: ride.max_hr,
            avgSpeed: ride.avg_speed,
            maxSpeed: ride.max_speed,
            distanceKm: ride.distance_m ? ride.distance_m / 1000 : null,
            // Curated planned routes render in their stored colour
            collection: ride.collection ?? null,
            colorHex: ride.color ?? null,
        })) || []
        , [rides])

    // Two-tier filtering (shared semantics with ListPane via the store):
    // - HIDDEN: mode toggled off, missing HR/speed when required, outside date
    //   range, or focus mode with a selection -> removed from the map entirely.
    // - GREYED: visible but outside the enabled range filters -> washed out.
    const hasActiveFilters = filters.hrAvgEnabled || filters.hrMaxEnabled || filters.speedAvgEnabled || filters.speedMaxEnabled || filters.distanceEnabled

    const { hiddenIds, greyIds } = useMemo(() => {
        const hidden = new Set<string>()
        const grey = new Set<string>()
        const visibility = { enabledModes, trackClasses, shapeClasses, gradeFilter, requireHr, requireSpeed, dateFrom, dateTo, plannedCollectionsOff, ownersOff, filters: { ...filters, hrAvgEnabled: false, hrMaxEnabled: false, speedAvgEnabled: false, speedMaxEnabled: false, distanceEnabled: false } }
        const ranges = { enabledModes, trackClasses: { own: true, other: true, plan: true }, shapeClasses: { loop: true, oneway: true }, gradeFilter, requireHr: false, requireSpeed: false, dateFrom: '', dateTo: '', plannedCollectionsOff: [], ownersOff: [], filters }
        for (const ride of rides || []) {
            if (!rideMatchesFilters(ride, visibility)) {
                hidden.add(ride.id)
            } else if (hasActiveFilters && !rideMatchesFilters(ride, ranges)) {
                grey.add(ride.id)
            }
            if (focusMode && selectedIds.length > 0 && !selectedIds.includes(ride.id)) {
                hidden.add(ride.id)
            }
        }
        return { hiddenIds: hidden, greyIds: grey }
    }, [rides, enabledModes, trackClasses, shapeClasses, gradeFilter, requireHr, requireSpeed, dateFrom, dateTo, plannedCollectionsOff, ownersOff, filters, hasActiveFilters, focusMode, selectedIds])

    // Dim-highlight context: while one is active, every non-highlighted track
    // drops to the user's dimmed opacity so the highlighted set pops. Priority:
    // transient selection → active search matches → export basket. No context →
    // null (everything renders at full strength).
    const highlightIds = useMemo<Set<string> | null>(() => {
        if (selectedIds.length > 0) return new Set(selectedIds)
        const q = searchQuery.trim()
        if (q) {
            const matches = new Set<string>()
            for (const r of rides || []) {
                if (rideMatchesSearch(r, q)) matches.add(r.id)
            }
            return matches
        }
        if (basketIds.length > 0) return new Set(basketIds)
        return null
    }, [selectedIds, searchQuery, rides, basketIds])
    const dimAlpha = Math.round(255 * dimmedOpacity)

    // Direction chevrons along ride tracks (both mode-coloured and gradient
    // views). White with a dark outline so they read on any track colour.
    // arrowMode gates them: hovered/selected tracks only, everything once
    // zoomed past z13, or everything always.
    const rideChevrons = useMemo(() => {
        if (!showRides || ridesData.length === 0) return []
        if (arrowMode === 'zoom' && chevronZoom < 13) return []
        const metersPerPixel =
            156543.03392 * Math.cos(chevronLat * Math.PI / 180) / Math.pow(2, chevronZoom)
        const spacingM = 140 * metersPerPixel
        const inView = bounds
            ? (lon: number, lat: number) =>
                lon >= bounds.minLon && lon <= bounds.maxLon &&
                lat >= bounds.minLat && lat <= bounds.maxLat
            : () => true
        const chevrons: Chevron[] = []
        for (const d of ridesData) {
            // No direction cues on hidden or washed-out (filtered) tracks
            if (hiddenIds.has(d.id) || greyIds.has(d.id)) continue
            if (arrowMode === 'hover'
                && hoveredId !== d.id && !selectedIds.includes(d.id)) continue
            emitPathChevrons(d.path as [number, number][], spacingM, 0, [255, 255, 255, 230], inView, chevrons)
        }
        return chevrons
    }, [ridesData, hiddenIds, greyIds, showRides, bounds, arrowMode, chevronZoom, chevronLat, hoveredId, selectedIds])

    // Slider ranges auto-populate from the loaded rides (previously hardcoded
    // to 200 km / 80 km/h, which silently excluded long/fast rides)
    const dataRanges = useMemo(() => {
        let hrMin = 40, hrMax = 200, speedMax = 100, distMax = 100
        for (const r of rides || []) {
            if (r.avg_hr != null) hrMin = Math.min(hrMin, Math.floor(r.avg_hr))
            if (r.max_hr != null) hrMax = Math.max(hrMax, Math.ceil(r.max_hr))
            if (r.max_speed != null) speedMax = Math.max(speedMax, Math.ceil(r.max_speed))
            if (r.distance_m != null) distMax = Math.max(distMax, Math.ceil(r.distance_m / 1000))
        }
        return { hrMin, hrMax, speedMin: 0, speedMax, distanceMin: 0, distanceMax: distMax }
    }, [rides])

    // Create gradient segments from rides' points (only when not in mode color
    // mode). Colours come from the user-adjustable boundary scales; when range
    // filters are active, sections outside the range are greyed and sections
    // inside stay full colour (per-point evaluation).
    const gradientSegments = useMemo(() => {
        if (!allRidePoints || allRidePoints.length === 0
            || (colorMode !== 'hr' && colorMode !== 'speed' && colorMode !== 'grade')) return []

        const segments: Array<{
            rideId: string
            sourcePosition: [number, number]
            targetPosition: [number, number]
            color: [number, number, number, number]
        }> = []

        // Point-level range check (HR in bpm; point speed is m/s, sliders km/h)
        const pointInRange = (hr: number | null, speedKmh: number | null): boolean => {
            const f = filters
            if (f.hrAvgEnabled) {
                if (hr == null) return false
                if (f.hrAvgMin != null && hr < f.hrAvgMin) return false
                if (f.hrAvgMax != null && hr > f.hrAvgMax) return false
            }
            if (f.speedAvgEnabled) {
                if (speedKmh == null) return false
                if (f.speedAvgMin != null && speedKmh < f.speedAvgMin) return false
                if (f.speedAvgMax != null && speedKmh > f.speedAvgMax) return false
            }
            return true
        }
        const sectionFiltering = filters.hrAvgEnabled || filters.speedAvgEnabled

        for (const { rideId, points } of allRidePoints) {
            if (points.length < 2 || hiddenIds.has(rideId)) continue

            // Unsigned steepness % per point, smoothed over a ±75 m window —
            // raw point-to-point grade from GPS/barometric elevation is far
            // too noisy to colour by.
            const grades = colorMode === 'grade' ? computeGrades(points) : null

            for (let i = 0; i < points.length - 1; i++) {
                const p1 = points[i]
                const p2 = points[i + 1]
                const speedKmh = p1.speed != null ? p1.speed * 3.6 : null

                let color = colorMode === 'hr'
                    ? scaleColor(p1.heart_rate, hrScale)
                    : colorMode === 'speed'
                        ? scaleColor(speedKmh, speedScale)
                        : scaleColor(grades![i], gradeScale)

                if (sectionFiltering && !pointInRange(p1.heart_rate, speedKmh)) {
                    color = [80, 80, 80, 60] // outside range -> greyed section
                }

                segments.push({
                    rideId,
                    sourcePosition: [p1.lon, p1.lat],
                    targetPosition: [p2.lon, p2.lat],
                    color,
                })
            }
        }

        return segments
    }, [allRidePoints, colorMode, hrScale, speedScale, gradeScale, filters, hiddenIds])

    // Heatmap paths: "My heatmap" is its own layer row, so it carries own-class
    // tracks only — independent of which ride layers are on. The remaining
    // VISIBILITY filters (mode, has-HR/has-speed, date range) still apply
    // client-side so toggling never refetches, and so heat and list agree about
    // which tracks exist (no-HR rides invisible in the list were lighting up
    // the heat).
    const heatPaths = useMemo<HeatPath[]>(() => {
        if (!showHeatmap || !heatTracks) return []
        return heatTracks
            .filter(t => {
                if (!t.geometry) return false
                if (t.class !== 'own') return false
                if (!enabledModes.includes((t.mode || 'other') as RideMode)) return false
                if (requireHr && !t.has_hr) return false
                // has_speed mirrors the rides list's avg_speed-non-null test, so
                // the heatmap and list agree on which tracks have speed data.
                if (requireSpeed && !t.has_speed) return false
                if (dateFrom && (!t.started_at || t.started_at.slice(0, 10) < dateFrom)) return false
                if (dateTo && (!t.started_at || t.started_at.slice(0, 10) > dateTo)) return false
                return true
            })
            .map(t => ({ path: t.geometry!.coordinates, cls: t.class }))
    }, [showHeatmap, heatTracks, enabledModes, requireHr, requireSpeed, dateFrom, dateTo])

    // Planned heat: density over ALL planned geometry (kind='planned' rows,
    // recognisable by their collection/colour fields), deliberately ignoring
    // the per-collection route toggles — select a few plans as coloured
    // tracks, and planned heat still shows where every other route runs.
    const plannedHeatPaths = useMemo<HeatPath[]>(() => {
        if (!showPlannedHeat || !heatTracks) return []
        return heatTracks
            .filter(t => t.geometry && t.class === 'plan' && (t.collection != null || t.color != null))
            .map(t => ({ path: t.geometry!.coordinates, cls: 'plan' as const }))
    }, [showPlannedHeat, heatTracks])

    // POIs visible on the map: category chips filter client-side (no refetch),
    // and below full-detail zoom a screen-space grid keeps roughly one pin per
    // ~48 px cell — highest-priority category wins the cell, so fuel and camps
    // survive thinning while generic pins drop first.
    const poiZoomQ = Math.round(viewState.zoom * 2) / 2
    const visiblePois = useMemo<Poi[]>(() => {
        if (!poisEnabled || !pois) return []
        const meta = (p: Poi) => POI_CATEGORY_META[(p.category as PoiCategory)] ?? POI_CATEGORY_META.poi
        const filtered = pois.filter(p => poiCategories[(p.category as PoiCategory)] ?? poiCategories.poi)
        if (poiZoomQ >= POI_FULL_DETAIL_ZOOM) return filtered
        const metersPerPixel =
            156543.03392 * Math.cos(chevronLat * Math.PI / 180) / Math.pow(2, poiZoomQ)
        const cellDeg = (48 * metersPerPixel) / 111320
        const cells = new Map<string, Poi>()
        for (const p of filtered) {
            const key = `${Math.round(p.lon / cellDeg)},${Math.round(p.lat / cellDeg)}`
            const cur = cells.get(key)
            if (!cur || meta(p).priority < meta(cur).priority) cells.set(key, p)
        }
        return Array.from(cells.values())
    }, [poisEnabled, pois, poiCategories, poiZoomQ, chevronLat])

    // Heat alpha is graded by zoom (Strava normalizes brightness per zoom
    // level). Quantized to half-zooms so the layer array isn't rebuilt on
    // every animation frame of a zoom gesture — width scaling stays smooth
    // in-shader via meter units, only the alpha steps.
    const heatZoomQ = Math.round(viewState.zoom * 2) / 2

    // Create layers
    const getLayers = useCallback(() => {
        const layers = []

        // Area boundaries: outlines + name labels below the tracks and heat —
        // they're context, not data
        if (showAreas && areas && areas.length > 0) {
            layers.push(new GeoJsonLayer({
                id: 'areas-layer',
                data: areas.map(a => ({
                    type: 'Feature' as const,
                    geometry: a.boundary,
                    properties: { name: a.name },
                })) as unknown as import('geojson').Feature[],
                stroked: true,
                filled: false,
                getLineColor: [255, 255, 255, 160],
                getLineWidth: 2,
                lineWidthUnits: 'pixels',
            }))
            layers.push(new TextLayer({
                id: 'areas-label-layer',
                data: areas.map(a => {
                    // Label at the boundary's bbox centre — cheap and fine for
                    // the rectangular-ish area boundaries in use
                    const rings = a.boundary.type === 'Polygon'
                        ? a.boundary.coordinates as number[][][]
                        : (a.boundary.coordinates as number[][][][]).flat()
                    const pts = rings.flat()
                    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
                    for (const [lon, lat] of pts as [number, number][]) {
                        if (lon < minLon) minLon = lon
                        if (lon > maxLon) maxLon = lon
                        if (lat < minLat) minLat = lat
                        if (lat > maxLat) maxLat = lat
                    }
                    return { name: a.name, position: [(minLon + maxLon) / 2, (minLat + maxLat) / 2] }
                }),
                getPosition: (d: { position: [number, number] }) => d.position,
                getText: (d: { name: string }) => d.name,
                getSize: 13,
                getColor: [255, 255, 255, 210],
                fontWeight: 600,
                getTextAnchor: 'middle',
                getAlignmentBaseline: 'center',
                fontSettings: { sdf: true },
                outlineWidth: 3,
                outlineColor: [0, 0, 0, 200],
            }))
        }

        // Bundle coverage preview: light grey outlines of what a pack/export
        // will cover — the corridor polygon, the rect bbox when a layer is in
        // rect mode, and the overview region fainter still. Context like
        // areas: under the tracks and heat.
        // In 'all' mode (basket view) every shape draws at once, colour-coded to
        // the legend, so each layer's boundary is visible before a pack config
        // exists. 'single' keeps the original grey what-this-config-covers look.
        const showAllShapes = coveragePreview?.mode === 'all'
        if (coveragePreview && (coveragePreview.corridor || coveragePreview.overview
            || ((coveragePreview.showRect || showAllShapes) && coveragePreview.rect))) {
            type ShapeKind = 'corridor' | 'rect' | 'region'
            const features: import('geojson').Feature[] = []
            if (coveragePreview.corridor) {
                features.push({ type: 'Feature', geometry: coveragePreview.corridor, properties: { kind: 'corridor', faint: false } })
            }
            if ((coveragePreview.showRect || showAllShapes) && coveragePreview.rect) {
                const [x0, y0, x1, y1] = coveragePreview.rect
                features.push({
                    type: 'Feature',
                    geometry: {
                        type: 'Polygon',
                        coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
                    },
                    properties: { kind: 'rect', faint: false },
                })
            }
            if (coveragePreview.overview) {
                features.push({ type: 'Feature', geometry: coveragePreview.overview, properties: { kind: 'region', faint: true } })
            }
            layers.push(new GeoJsonLayer({
                id: 'coverage-preview-layer',
                data: features,
                stroked: true,
                filled: false,
                getLineColor: f => {
                    const p = f.properties as { kind: ShapeKind, faint: boolean }
                    if (showAllShapes) {
                        const [r, g, b] = COVERAGE_SHAPE_COLORS[p.kind]
                        return [r, g, b, p.faint ? 150 : 220]
                    }
                    return p.faint ? [190, 190, 190, 70] : [190, 190, 190, 150]
                },
                getLineWidth: showAllShapes ? 2 : 1.5,
                lineWidthUnits: 'pixels',
                updateTriggers: { getLineColor: [showAllShapes] },
            }))
        }

        // Pack mark edits (review section open): pending faded, accepted
        // full — the visual diff of what the next refresh bakes. The clicked
        // review row's mark gets a highlight ring.
        if (markPreview && markPreview.marks.length > 0) {
            const alpha = (s: string) => (s === 'accepted' ? 255 : 130)
            const focused = markPreview.marks.filter(m => m.id === markPreview.focusId)
            if (focused.length > 0) {
                layers.push(new ScatterplotLayer({
                    id: 'mark-focus-layer',
                    data: focused,
                    getPosition: (d: MarkPreviewPoint) => [d.lon, d.lat],
                    getRadius: 14,
                    radiusUnits: 'pixels',
                    stroked: true,
                    filled: false,
                    getLineColor: [255, 255, 255, 230],
                    getLineWidth: 2.5,
                    lineWidthUnits: 'pixels',
                }))
            }
            layers.push(new ScatterplotLayer({
                id: 'mark-preview-layer',
                data: markPreview.marks,
                getPosition: (d: MarkPreviewPoint) => [d.lon, d.lat],
                getRadius: 8,
                radiusUnits: 'pixels',
                stroked: true,
                getFillColor: (d: MarkPreviewPoint) => {
                    const c = MARK_COLORS[d.op === 'remove' ? 'remove' : d.kind] ?? MARK_COLORS.turn
                    return [c[0], c[1], c[2], alpha(d.status)] as [number, number, number, number]
                },
                getLineColor: (d: MarkPreviewPoint) => [20, 23, 26, alpha(d.status)] as [number, number, number, number],
                getLineWidth: 1.5,
                lineWidthUnits: 'pixels',
                pickable: false,
            }))
            layers.push(new TextLayer({
                id: 'mark-preview-glyphs',
                data: markPreview.marks,
                getPosition: (d: MarkPreviewPoint) => [d.lon, d.lat],
                getText: (d: MarkPreviewPoint) => markGlyph(d),
                getSize: 11,
                getColor: (d: MarkPreviewPoint) => [20, 23, 26, alpha(d.status)] as [number, number, number, number],
                fontWeight: 700,
                getTextAnchor: 'middle',
                getAlignmentBaseline: 'center',
                fontSettings: { sdf: true },
            }))
        }

        // Planned heat: the same tuned renderer as own heat (constant ~1.5
        // CSS-px strokes, per-zoom brightness normalization), tinted by the
        // "Heat colors" setting and drawn BELOW own heat so my orange reads on
        // top where they overlap. Independent of the per-collection toggles.
        if (showPlannedHeat && plannedHeatPaths.length > 0) {
            layers.push(...buildHeatmapLayers(plannedHeatPaths, {
                intensity: heatIntensity,
                width: heatWidth,
                zoomScaling: heatZoomScaling,
            }, heatZoomQ, undefined, {
                idPrefix: 'planned-heat',
                colors: { plan: hexToRgb(heatColorPlanned, HEAT_COLORS.plan) },
            }))
        }

        // Density heatmap: BELOW the ride lines, matching the Layers pane order
        // (My rides / Other rides sit above My heatmap). Additive blending keeps
        // the glow readable underneath the tracks.
        if (showHeatmap && heatPaths.length > 0) {
            // Pack preview: clip the heat to what the bundle carries. Several
            // features rasterize into the one mask texture, which is how
            // corridor ∪ overview happens without any boolean geometry.
            const heatMask = packPreview?.clip.heat ?? []
            if (heatMask.length > 0) {
                layers.push(new GeoJsonLayer({
                    id: 'pack-heat-mask',
                    operation: 'mask',
                    data: heatMask.map(geometry => ({
                        type: 'Feature' as const, geometry, properties: {},
                    })) as unknown as import('geojson').Feature[],
                    filled: true,
                    stroked: false,
                }))
            }
            layers.push(...buildHeatmapLayers(heatPaths, {
                intensity: heatIntensity,
                width: heatWidth,
                zoomScaling: heatZoomScaling,
            }, heatZoomQ, heatMask.length > 0 ? 'pack-heat-mask' : undefined, {
                // "Heat colors" setting drives own heat (default orange)
                colors: { own: hexToRgb(heatColorOwn, HEAT_COLORS.own) },
            }))
        }

        // Ride layers: gradient colouring when HR/speed is active
        if (showRides && gradientSegments.length > 0) {
            // Gradient layer for all rides
            layers.push(new LineLayer({
                id: 'gradient-layer',
                data: gradientSegments,
                pickable: true,
                getWidth: (d: typeof gradientSegments[0]) => {
                    if (selectedIds.includes(d.rideId)) return 5
                    if (hoveredId === d.rideId) return 4
                    return 3
                },
                widthMinPixels: 2,
                widthMaxPixels: 10,
                getSourcePosition: d => d.sourcePosition,
                getTargetPosition: d => d.targetPosition,
                getColor: (d: typeof gradientSegments[0]) => {
                    // Selected/hovered rides at full brightness
                    if (selectedIds.includes(d.rideId) || hoveredId === d.rideId) {
                        return d.color
                    }
                    // Non-highlighted tracks drop to the dim slider's opacity
                    // while a highlight context is active; otherwise a slight
                    // dim so hover still reads — but never brighter than the
                    // segment's own alpha, so the alpha-60 wash on out-of-range
                    // (greyed) segments survives instead of being forced to 180.
                    const alpha = highlightIds && !highlightIds.has(d.rideId)
                        ? Math.min(d.color[3], dimAlpha)
                        : Math.min(d.color[3], 180)
                    return [d.color[0], d.color[1], d.color[2], alpha] as [number, number, number, number]
                },
                updateTriggers: {
                    getColor: [selectedIds, hoveredId, highlightIds, dimAlpha],
                    getWidth: [selectedIds, hoveredId],
                },
            }))
        } else if (showRides) {
            // Mode-based colors or fallback layer.
            // Hidden tier (mode off / missing HR-speed / date / focus) is
            // removed from the data; grey tier (range filters) is washed out.
            const visible = ridesData.filter(d => !hiddenIds.has(d.id))
            layers.push(new PathLayer({
                id: 'rides-layer',
                data: visible,
                pickable: true,
                widthMinPixels: 2,
                widthMaxPixels: 8,
                capRounded: true,
                jointRounded: true,
                getPath: (d: typeof ridesData[0]) => d.path,
                getColor: (d: typeof ridesData[0]) => {
                    // Curated planned routes carry their stored colour, a touch
                    // more opaque than other-people's tracks so networks read
                    // as the foreground layer they are while planning.
                    if (d.collection && d.colorHex) {
                        if (greyIds.has(d.id)) return [80, 80, 80, 60] as RGBA
                        const [r, g, b] = hexToRgb(d.colorHex, HEAT_COLORS.plan)
                        const bright = hoveredId === d.id || selectedIds.includes(d.id)
                        const c: RGBA = [r, g, b, bright ? 255 : 235]
                        return highlightIds && !highlightIds.has(d.id) && !bright
                            ? [r, g, b, Math.min(c[3], dimAlpha)] as RGBA
                            : c
                    }
                    if (hoveredId === d.id || selectedIds.includes(d.id)) {
                        return MODE_COLORS_BRIGHT[d.mode] || MODE_COLORS_BRIGHT.other
                    }
                    const c: RGBA = greyIds.has(d.id)
                        ? [80, 80, 80, 60]
                        : MODE_COLORS[d.mode] || MODE_COLORS.other
                    // Non-highlighted tracks drop to the dim slider's opacity
                    // while a highlight context (selection/search/basket) exists
                    return highlightIds && !highlightIds.has(d.id)
                        ? [c[0], c[1], c[2], Math.min(c[3], dimAlpha)] as RGBA
                        : c
                },
                getWidth: (d: typeof ridesData[0]) => {
                    if (selectedIds.includes(d.id)) return 4
                    if (hoveredId === d.id) return 3
                    // Planned routes slightly wider than ordinary tracks
                    return d.collection && d.colorHex ? 2.5 : 2
                },
                updateTriggers: {
                    getColor: [selectedIds, hoveredId, colorMode, greyIds, highlightIds, dimAlpha],
                    getWidth: [selectedIds, hoveredId],
                },
            }))
        }

        // Ride direction chevrons (above the tracks, below photos)
        if (showRides && rideChevrons.length > 0) {
            layers.push(new TextLayer({
                id: 'ride-chevrons-layer',
                data: rideChevrons,
                characterSet: '›', // outside the default ASCII set
                getPosition: (d: Chevron) => d.position,
                getText: () => '›',
                getSize: 12,
                getAngle: (d: Chevron) => d.angle,
                getColor: (d: Chevron) => d.color,
                getPixelOffset: (d: Chevron) => d.pixelOffset,
                fontWeight: 700,
                getTextAnchor: 'middle',
                getAlignmentBaseline: 'center',
                billboard: false,
                // SDF outline: white glyph + dark halo reads on any track colour
                fontSettings: { sdf: true },
                outlineWidth: 3,
                outlineColor: [0, 0, 0, 220],
            }))
        }

        // Profile-graph cursor: a dot riding along the track as the cursor
        // moves across the elevation profile (accent ring, white core)
        if (graphCursor) {
            layers.push(new ScatterplotLayer({
                id: 'graph-cursor-layer',
                data: [graphCursor],
                radiusUnits: 'pixels',
                getPosition: (d: { position: [number, number] }) => d.position,
                getRadius: 7,
                getFillColor: [255, 255, 255, 245],
                getLineColor: graphCursor.pinned ? [255, 130, 45, 255] : [79, 124, 255, 255],
                getLineWidth: 3,
                lineWidthUnits: 'pixels',
                stroked: true,
                updateTriggers: { getPosition: [graphCursor], getLineColor: [graphCursor] },
            }))
        }

        // Route being drawn: accent line + white vertex handles
        if (drawPath.length > 0) {
            layers.push(new PathLayer({
                id: 'draw-path-layer',
                data: [{ path: drawPath }],
                getPath: (d: { path: [number, number][] }) => d.path,
                getColor: [79, 124, 255, 235],
                getWidth: 3.5,
                widthUnits: 'pixels',
                capRounded: true,
                jointRounded: true,
                updateTriggers: { getPath: [drawPath] },
            }))
            layers.push(new ScatterplotLayer({
                id: 'draw-vertices-layer',
                data: drawPath.map((p, i) => ({ position: p, i })),
                radiusUnits: 'pixels',
                getPosition: (d: { position: [number, number] }) => d.position,
                getRadius: (d: { i: number }) => (d.i === 0 || d.i === drawPath.length - 1 ? 6 : 4),
                getFillColor: [255, 255, 255, 245],
                getLineColor: [79, 124, 255, 255],
                getLineWidth: 2,
                lineWidthUnits: 'pixels',
                stroked: true,
                updateTriggers: { getPosition: [drawPath], getRadius: [drawPath] },
            }))
        }

        // POI pins: lucide-icon badges from the shared atlas (see poiIcons.ts).
        // Above the tracks (a fuel stop must beat line clutter), below photos.
        if (poisEnabled && poiAtlas && visiblePois.length > 0) {
            layers.push(new IconLayer({
                id: 'pois-layer',
                data: visiblePois,
                pickable: true,
                iconAtlas: poiAtlas.atlas,
                iconMapping: poiAtlas.mapping,
                getIcon: (d: Poi) =>
                    POI_CATEGORY_META[(d.category as PoiCategory)] ? d.category : 'poi',
                getPosition: (d: Poi) => [d.lon, d.lat],
                sizeUnits: 'pixels',
                getSize: 24,
                updateTriggers: { getIcon: [poiAtlas] },
            }))
        }

        // Photo dots (top): white, line-width sized, grouped when metres apart
        if (showPhotos && photoGroups.length > 0) {
            layers.push(new ScatterplotLayer({
                id: 'photos-layer',
                data: photoGroups,
                pickable: true,
                radiusUnits: 'pixels',
                getPosition: (d: PhotoGroup) => [d.lon, d.lat],
                getRadius: (d: PhotoGroup) => d.photos.length > 1 ? 5 : 3,
                getFillColor: [255, 255, 255, 235],
                getLineColor: [30, 30, 30, 200],
                getLineWidth: 1,
                lineWidthUnits: 'pixels',
                stroked: true,
            }))
            const multi = photoGroups.filter(g => g.photos.length > 1)
            if (multi.length > 0) {
                layers.push(new TextLayer({
                    id: 'photos-count-layer',
                    data: multi,
                    getPosition: (d: PhotoGroup) => [d.lon, d.lat],
                    getText: (d: PhotoGroup) => String(d.photos.length),
                    getSize: 9,
                    getColor: [20, 20, 20, 255],
                    fontWeight: 700,
                    getTextAnchor: 'middle',
                    getAlignmentBaseline: 'center',
                }))
            }
        }

        return layers
    }, [ridesData, selectedIds, hoveredId, gradientSegments, hiddenIds, greyIds, colorMode,
        showPhotos, photoGroups, showRides, rideChevrons, highlightIds, dimAlpha, graphCursor,
        showAreas, areas, drawPath, coveragePreview, markPreview, packPreview,
        showHeatmap, heatPaths, heatIntensity, heatWidth, heatZoomScaling, heatZoomQ,
        showPlannedHeat, plannedHeatPaths, heatColorOwn, heatColorPlanned,
        poisEnabled, poiAtlas, visiblePois])

    // Latest ridesData, read by the auto-zoom effect without being a dependency —
    // ridesData gets a fresh array reference on every viewport refetch, and
    // depending on it snapped the camera back to the selection after every pan.
    const ridesDataRef = useRef(ridesData)
    ridesDataRef.current = ridesData

    // Places folder click: fly to the folder's bounding box (unconditional —
    // the user explicitly asked to go there, unlike the autoZoom setting)
    useEffect(() => {
        if (!flyTo || !map.current) return
        const [minLon, minLat, maxLon, maxLat] = flyTo.bbox
        if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return
        map.current.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
            padding: 60,
            maxZoom: 13,
            duration: 900,
        })
    }, [flyTo])

    // Auto-zoom: fit the map to the selection only when the selection changes.
    // The intent is kept pending until geometry for the whole selection is
    // actually available: the rides payload is viewport-filtered, so a track
    // picked from search / All tracks / a slow refetch often isn't in it yet —
    // the old fire-once effect silently skipped those ("sometimes doesn't
    // zoom"). Retries when rides data lands; if the data settles without the
    // selection, fetches the selection's own summaries. The pending flag (not
    // a rides dependency alone) is what keeps refetches from snapping the
    // camera back after a manual pan.
    const selectionKey = selectedIds.join(',')
    const pendingAutoZoom = useRef(false)
    useEffect(() => {
        pendingAutoZoom.current = autoZoom && selectedIds.length > 0
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoZoom, selectionKey])
    useEffect(() => {
        if (!pendingAutoZoom.current || !map.current) return
        const fit = (paths: [number, number][][]) => {
            let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
            for (const path of paths) {
                for (const [lon, lat] of path) {
                    if (lon < minLon) minLon = lon
                    if (lon > maxLon) maxLon = lon
                    if (lat < minLat) minLat = lat
                    if (lat > maxLat) maxLat = lat
                }
            }
            if (minLon === Infinity || !map.current) return
            pendingAutoZoom.current = false
            map.current.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
                padding: 60,
                maxZoom: 14,
                duration: 600,
            })
        }
        const local = ridesDataRef.current.filter(d => selectedIds.includes(d.id))
        if (local.length === selectedIds.length) {
            fit(local.map(d => d.path as [number, number][]))
            return
        }
        if (isLoading) return // refetch in flight — retry when it lands
        // Selection isn't in the viewport payload at all — fetch it directly.
        let cancelled = false
        fetchRidesByIds(selectedIds)
            .then(rs => {
                if (cancelled || !pendingAutoZoom.current) return
                fit(rs.map(r => (r.geometry?.coordinates ?? []) as [number, number][]))
            })
            .catch(() => { /* keep pending; a later rides refetch may cover it */ })
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoZoom, selectionKey, rides, isLoading])

    // MapLibre-native extras (raster/DEM layers, terrain) must be re-applied
    // after every style change — setStyle wipes custom sources and layers.
    // The latest settings are read through this ref so one idempotent function
    // serves the initial 'load', every 'style.load', and the toggle effects.
    const extrasRef = useRef({ hillshade, terrain3d })
    extrasRef.current = { hillshade, terrain3d }
    // Re-entrancy guard: our own addSource/addLayer calls fire 'styledata',
    // which is what re-drives this function (see the listener at init). Without
    // this, the first add would recurse into a fresh pass mid-run.
    const applyingExtras = useRef(false)

    // Pack-preview mask shapes, mirrored into a ref like extrasRef so
    // applyMapExtras (empty deps, runs on every style.load) can read them.
    // Shape UPDATES go through applyPackMask's setData, never through
    // applyMapExtras — re-adding sources on every debounce tick would flicker.
    const packMaskRef = useRef<{ clip: PackPreview['clip'], detail: boolean } | null>(null)
    const applyPackMask = useCallback(() => {
        const m = map.current
        if (!m) return
        const state = packMaskRef.current
        for (const id of PACK_MASK_IDS) {
            if (!m.getLayer(id)) continue
            // undefined = no preview (hide the mask entirely); null = preview
            // with no coverage for this band (mask everything).
            const shape = !state ? undefined
                : id === 'pack-mask-lower' ? state.clip.lower
                    : state.detail ? state.clip.stravaDetail : state.clip.stravaOverview
            if (shape === undefined) {
                m.setLayoutProperty(id, 'visibility', 'none')
                continue
            }
            const src = m.getSource(id) as maplibregl.GeoJSONSource | undefined
            src?.setData(inverseMask(shape))
            m.setLayoutProperty(id, 'visibility', 'visible')
        }
    }, [])
    const applyPackMaskRef = useRef<() => void>(() => {})
    applyPackMaskRef.current = applyPackMask
    const applyExtrasInner = useCallback((m: maplibregl.Map) => {
        // Mid-PARSE bail: every style mutator below (addSource/addLayer/
        // moveLayer/…) throws "Style is not done loading" while a setStyle is
        // still parsing. That window is unhittable with URL styles ('styledata'
        // first fires post-parse) but real for object styles — a scheme change
        // rebuilding the Dingo style can land while another style load is in
        // flight, and the throw unmounts MapView. styleLayerCount() is the
        // parse probe (getStyle() throws mid-parse → 0); the 'styledata'
        // listener at init re-drives this pass once parsing settles. This is
        // deliberately NOT isStyleLoaded() — that also waits on every source,
        // and the Strava rasters never settle when the daemon 404s their
        // tiles (see the hillshade note below, which learned it the hard way).
        if (!styleLayerCount(m)) return
        // Two Strava heat layers, split by sport: ride (blue) and hike (purple).
        // The daemon serves each from its own harvested MBTiles owner and
        // colourises server-side. Hike added first so RIDE draws above it where
        // they overlap, matching the Layers pane order (Strava rides sits above
        // Strava hikes). Sits directly on the basemap, UNDER the deck.gl canvas.
        for (const owner of ['strava-hike', 'strava-ride'] as const) {
            if (!m.getSource(owner)) {
                m.addSource(owner, {
                    type: 'raster',
                    tiles: [`${SERVER_BASE}/api/heat/${owner}/{z}/{x}/{y}.png`],
                    tileSize: 256,
                    // Strava's heatmap serves through z15 (z16 = 404); cap tile
                    // requests there so MapLibre overzooms past z15 rather than
                    // fetching 404s and blanking the heat.
                    maxzoom: 15,
                    attribution: 'Global heatmap © Strava',
                })
            }
            if (!m.getLayer(owner)) {
                m.addLayer({
                    id: owner,
                    type: 'raster',
                    source: owner,
                    layout: { visibility: 'none' },
                    paint: {
                        'raster-opacity': 0.9,
                        'raster-resampling': 'linear',
                    },
                })
            }
        }
        // Pack-preview masks: a world-sized fill with the pack's coverage
        // punched out, so anything the bundle doesn't carry renders flat.
        // Added unconditionally (hidden with no preview) so the ordering below
        // is re-asserted on every style reload — and, like the rasters above,
        // BEFORE the parsed-style gate, so a style that stalls mid-parse can't
        // leave the mask layers absent and the pill silently inert.
        for (const id of PACK_MASK_IDS) {
            if (!m.getSource(id)) {
                m.addSource(id, { type: 'geojson', data: EMPTY_FEATURES })
            }
            if (!m.getLayer(id)) {
                m.addLayer({
                    id,
                    type: 'fill',
                    source: id,
                    layout: { visibility: 'none' },
                    paint: { 'fill-color': MASK_COLOR, 'fill-opacity': 1, 'fill-antialias': true },
                })
            }
        }
        // The lower mask sits above the basemap AND its labels — an offline
        // bundle has no place names outside the corridor either — but below the
        // Strava rasters, which carry their own coverage and so mask
        // separately, on top. moveLayer runs every pass rather than only on
        // add: dingo-hillshade is added and removed by this same function, and
        // that churn leaves stale ordering behind.
        m.moveLayer('pack-mask-lower', 'strava-hike')
        m.moveLayer('pack-mask-strava')
        applyPackMaskRef.current()

        // Apply the persisted toggles now that the layers exist. Read through
        // the same pure resolver the deck side uses, so a pack preview drives
        // both halves of the map identically.
        const strava = effectiveLayerState(useSettings.getState(), useUiState.getState().packPreview)
        m.setLayoutProperty('strava-ride', 'visibility', strava.showStravaRide ? 'visible' : 'none')
        m.setLayoutProperty('strava-hike', 'visibility', strava.showStravaHike ? 'visible' : 'none')
        // "Heat colors → Strava overlays": the tiles are colourised
        // server-side, so the closest client-side tint is a hue rotation of
        // the raster relative to the daemon's blue ramp. Approximate by
        // design — only the hue of the picked colour applies, and the hike
        // purple rotates by the same delta so the two sports stay distinct.
        // (Exact recolouring would mean re-colourising tiles server-side.)
        const stravaHex = useUiState.getState().styleOverlays?.heatStrava
            ?? useSettings.getState().heatColorStrava
        const rotate = hexHueDeg(stravaHex) - STRAVA_BASE_HUE
        for (const owner of ['strava-ride', 'strava-hike'] as const) {
            m.setPaintProperty(owner, 'raster-hue-rotate', rotate)
        }
        // Hillshade needs the style's symbol layers to exist so it can anchor
        // below the labels — so gate on the style being PARSED. Deliberately not
        // isStyleLoaded(): that also demands every source be loaded, and the
        // Strava rasters above never settle when an owner has no harvested
        // mbtiles (the daemon 404s those tiles). Gating on it left the map
        // permanently one step short — no hillshade, no terrain, no pack mask,
        // and the 'idle' retry below could never fire either, for the same
        // reason. The 'styledata' listener at init re-drives this pass once the
        // style parses.
        if (!styleLayerCount(m)) return
        // Elevation sources: one for hillshade, one for 3D terrain (sharing a
        // raster-dem source between the two causes tile contention artifacts)
        const { hillshade: wantShade, terrain3d: wantTerrain } = extrasRef.current
        for (const src of ['dingo-dem-shade', 'dingo-dem-terrain']) {
            if (!m.getSource(src)) {
                m.addSource(src, { type: 'raster-dem', url: TERRAIN_TILES_URL })
            }
        }
        if (wantShade && !m.getLayer('dingo-hillshade')) {
            // Below the labels so place names stay readable
            m.addLayer(
                {
                    id: 'dingo-hillshade',
                    type: 'hillshade',
                    source: 'dingo-dem-shade',
                    paint: { 'hillshade-exaggeration': 0.5 },
                },
                firstSymbolLayerId(m),
            )
        } else if (!wantShade && m.getLayer('dingo-hillshade')) {
            m.removeLayer('dingo-hillshade')
        }
        const hasTerrain = !!m.getTerrain()
        if (wantTerrain && !hasTerrain) {
            m.setTerrain({ source: 'dingo-dem-terrain', exaggeration: 1.3 })
        } else if (!wantTerrain && hasTerrain) {
            m.setTerrain(null)
        }
    }, [])
    const applyMapExtras = useCallback(() => {
        const m = map.current
        if (!m || applyingExtras.current) return
        applyingExtras.current = true
        try {
            applyExtrasInner(m)
        } finally {
            applyingExtras.current = false
        }
    }, [applyExtrasInner])

    // Hillshade / 3D terrain toggles
    useEffect(() => {
        applyMapExtras()
    }, [hillshade, terrain3d, applyMapExtras])

    // Pack preview: mask shapes and the z11 Strava detail/overview swap.
    const stravaDetailZoom = viewState.zoom >= STRAVA_DETAIL_MIN_ZOOM
    useEffect(() => {
        packMaskRef.current = packPreview ? { clip: packPreview.clip, detail: stravaDetailZoom } : null
        applyPackMask()
        // Strava raster visibility is applied inside applyMapExtras, which
        // reads the preview through effectiveLayerState.
        applyMapExtras()
    }, [packPreview, stravaDetailZoom, applyPackMask, applyMapExtras])

    // Base style switch: setStyle wipes custom layers, so re-apply the extras
    // once the new style is in. Tracks the style the map actually carries
    // (the constructor used the persisted one) rather than a mount flag —
    // this effect first runs before the map exists, so a flag would swallow
    // the first real change.
    const appliedStyle = useRef<BaseStyle>(useSettings.getState().baseStyle)
    const styleReloadNonce = useUiState(s => s.styleReloadNonce)
    const appliedReload = useRef(styleReloadNonce)
    const appliedMode = useRef(baseStyleMode)
    useEffect(() => {
        const m = map.current
        // A nonce bump forces re-applying the SAME id (style file saved or
        // reverted); a day/night switch likewise; otherwise only a genuine
        // id change gets past the guard.
        const forced = appliedReload.current !== styleReloadNonce
            || appliedMode.current !== baseStyleMode
        appliedReload.current = styleReloadNonce
        appliedMode.current = baseStyleMode
        if (!m || (!forced && appliedStyle.current === baseStyle)) return
        appliedStyle.current = baseStyle
        // Async: local styles are fetched + key-substituted (+ night remap).
        // The appliedStyle guard drops a stale resolve on a fast re-switch.
        resolveBaseStyle(baseStyle, baseStyleMode).then(style => {
            if (map.current && appliedStyle.current === baseStyle) {
                map.current.setStyle(style, { diff: true })
            }
        })
        styleOverlaysFor(baseStyle, baseStyleMode).then(o => {
            if (appliedStyle.current === baseStyle) {
                useUiState.getState().setStyleOverlays(o)
            }
        })
        // The overlay stack (incl. the Strava layer + its persisted visibility)
        // is restored by the persistent 'style.load' listener registered at
        // init, which fires on every setStyle — more robust than a per-switch
        // once() that can miss the event on a fast style swap.
    }, [baseStyle, baseStyleMode, styleReloadNonce, applyMapExtras])

    // Initialize map and deck
    useEffect(() => {
        if (!mapContainer.current || !deckCanvas.current || map.current) return

        // Initialize MapLibre. A persisted local style can't be fetched
        // synchronously, so the map starts on an empty stub and swaps to the
        // resolved style as soon as it arrives (built-ins skip the swap).
        const initialId = useSettings.getState().baseStyle
        map.current = new maplibregl.Map({
            container: mapContainer.current,
            style: initialMapStyle(initialId),
            center: [INITIAL_VIEW_STATE.longitude, INITIAL_VIEW_STATE.latitude],
            zoom: INITIAL_VIEW_STATE.zoom,
            pitch: INITIAL_VIEW_STATE.pitch,
            bearing: INITIAL_VIEW_STATE.bearing,
            hash: true, // view state in the URL — shareable + survives reload
        })
        if (!(initialId in BUILTIN_STYLE_URLS)) {
            const initialMode = useSettings.getState().baseStyleMode
            styleOverlaysFor(initialId, initialMode).then(o => {
                if (appliedStyle.current === initialId) {
                    useUiState.getState().setStyleOverlays(o)
                }
            })
            resolveBaseStyle(initialId, initialMode).then(style => {
                if (map.current && appliedStyle.current === initialId) {
                    map.current.setStyle(style)
                }
            })
        }

        map.current.addControl(new maplibregl.NavigationControl())

        // Shared handle for toolbar/panel siblings (see mapRegistry.ts)
        setMapInstance(map.current)

        // Dev/debug handle: lets tooling and the console drive the camera
        // (e.g. __dingoMap.jumpTo({center: [lng, lat], zoom: 14}))
        ;(window as unknown as Record<string, unknown>).__dingoMap = map.current

        // Initialize Deck.gl with WebGL context from canvas
        deck.current = new Deck({
            canvas: deckCanvas.current,
            initialViewState: INITIAL_VIEW_STATE,
            controller: false,
            layers: [],
        })

        // Sync map view state to deck (runs on every move for real-time updates)
        const syncViewState = () => {
            if (!map.current || !deck.current) return
            const center = map.current.getCenter()
            const newViewState = {
                longitude: center.lng,
                latitude: center.lat,
                zoom: map.current.getZoom(),
                pitch: map.current.getPitch(),
                bearing: map.current.getBearing(),
            }
            setViewState(newViewState)
            deck.current.setProps({ viewState: newViewState })
            // Quantised in the setter — a no-op most frames.
            useUiState.getState().setMapZoom(newViewState.zoom)
        }

        // Update bounds for viewport filtering (debounced)
        const updateBounds = () => {
            if (!map.current) return
            const mapBounds = map.current.getBounds()
            const b = {
                minLon: mapBounds.getWest(),
                minLat: mapBounds.getSouth(),
                maxLon: mapBounds.getEast(),
                maxLat: mapBounds.getNorth(),
            }
            setBounds(b)
            onBoundsChangeRef.current?.(b)
        }

        // Sync view state on every move (for shouldLoadGradients)
        map.current.on('move', syncViewState)
        // Update bounds only on moveend (debounced data fetch)
        map.current.on('moveend', updateBounds)
        // Initialize bounds on load
        map.current.on('load', () => {
            // Strava raster + hillshade/terrain, per the current settings
            applyMapExtras()
            syncViewState()
            updateBounds()
        })
        // setStyle (base-map switch) wipes every custom source/layer. Re-apply
        // the overlay stack on every style load so the Strava heat, hillshade,
        // and terrain survive a map-type change. Persistent (not once-per-switch)
        // so it can never miss the event.
        map.current.on('style.load', applyMapExtras)
        // 'style.load' alone is not enough: MapLibre withholds it until the
        // style reports loaded, which never happens while a source is stuck —
        // and our own Strava rasters get stuck whenever an owner has no
        // harvested mbtiles. A base-map switch would then strand the whole
        // overlay stack until a page reload. 'styledata' fires on every style
        // mutation regardless, so it re-drives the pass; the guard re-applies
        // only when the stack is actually incomplete, which also keeps our own
        // addLayer calls (which each fire 'styledata') from looping.
        map.current.on('styledata', () => {
            const m = map.current
            // dingo-dem-shade is added on the far side of the parsed-style gate,
            // so checking it catches a partial pass as well as a wiped style.
            if (!m || (m.getLayer('strava-ride') && m.getSource('dingo-dem-shade'))) return
            applyMapExtras()
        })

        return () => {
            setMapInstance(null)
            map.current?.remove()
            map.current = null
            deck.current?.finalize()
            deck.current = null
        }
    }, [applyMapExtras])

    // Toggle the two Strava heat raster layers (ride / hike). Layers are created
    // in the map 'load' handler; guard for the case where this fires before load.
    useEffect(() => {
        const m = map.current
        if (!m || !m.getLayer('strava-ride')) return
        m.setLayoutProperty('strava-ride', 'visibility', showStravaRide ? 'visible' : 'none')
    }, [showStravaRide])
    useEffect(() => {
        const m = map.current
        if (!m || !m.getLayer('strava-hike')) return
        m.setLayoutProperty('strava-hike', 'visibility', showStravaHike ? 'visible' : 'none')
    }, [showStravaHike])
    // "Heat colors → Strava overlays" tint (approximate hue rotation; the
    // full rationale lives in applyExtrasInner, which re-applies it on every
    // style reload)
    useEffect(() => {
        const m = map.current
        if (!m || !m.getLayer('strava-ride')) return
        const rotate = hexHueDeg(heatColorStrava) - STRAVA_BASE_HUE
        for (const owner of ['strava-ride', 'strava-hike'] as const) {
            if (m.getLayer(owner)) m.setPaintProperty(owner, 'raster-hue-rotate', rotate)
        }
    }, [heatColorStrava])

    // Update deck layers when data changes
    useEffect(() => {
        if (deck.current) {
            deck.current.setProps({ layers: getLayers() })
        }
        if (import.meta.env.DEV) {
            // Debug handle for driving the map from the console / tests
            ;(window as unknown as Record<string, unknown>).__dingo = { map: map.current, deck: deck.current }
        }
    }, [getLayers])

    // Handle clicks via map container - use deck picking
    useEffect(() => {
        if (!map.current || !deck.current) return

        const handleClick = (e: maplibregl.MapMouseEvent) => {
            if (!deck.current) return

            // Route drawer: clicks lay vertices instead of selecting
            if (drawModeRef.current) {
                let next: [number, number] = [e.lngLat.lng, e.lngLat.lat]
                if (snapDrawRef.current && map.current) {
                    // Nearest visible track vertex within ~14 px. A cheap
                    // geo-bbox precheck culls almost every vertex before the
                    // per-vertex screen projection.
                    const m = map.current
                    const metersPerPixel = 156543.03392
                        * Math.cos(e.lngLat.lat * Math.PI / 180) / Math.pow(2, m.getZoom())
                    const tolDeg = (14 * metersPerPixel) / 111320 * 1.5
                    let best: { pt: [number, number], rideId: string, idx: number } | null = null
                    let bestD = 14 * 14
                    // Sticky ride: repeated rides overlap the same trail, so
                    // the plain nearest vertex hops between copies and the
                    // follow-splice never triggers. If the PREVIOUS snap's
                    // ride has a vertex in tolerance, prefer it.
                    let bestPrev: { pt: [number, number], rideId: string, idx: number } | null = null
                    let bestPrevD = 14 * 14
                    for (const d of ridesDataRef.current) {
                        const path = d.path as [number, number][]
                        for (let i = 0; i < path.length; i++) {
                            const [lon, lat] = path[i]
                            if (Math.abs(lon - e.lngLat.lng) > tolDeg
                                || Math.abs(lat - e.lngLat.lat) > tolDeg) continue
                            const px = m.project(path[i])
                            const dx = px.x - e.point.x
                            const dy = px.y - e.point.y
                            const d2 = dx * dx + dy * dy
                            if (d2 < bestD) {
                                bestD = d2
                                best = { pt: path[i], rideId: d.id, idx: i }
                            }
                            if (d.id === lastSnapRef.current?.rideId && d2 < bestPrevD) {
                                bestPrevD = d2
                                bestPrev = { pt: path[i], rideId: d.id, idx: i }
                            }
                        }
                    }
                    if (bestPrev) best = bestPrev
                    if (best) {
                        const prev = lastSnapRef.current
                        const path = ridesDataRef.current
                            .find(d => d.id === best!.rideId)?.path as [number, number][] | undefined
                        // Re-resolve the previous snap against the CURRENT path
                        // (its index may be stale after a tier refetch). Skip the
                        // follow-splice if it no longer exists at this tier.
                        const prevIdx = prev && prev.rideId === best.rideId && path
                            ? path.findIndex(p => p[0] === prev.pt[0] && p[1] === prev.pt[1])
                            : -1
                        if (path && prevIdx >= 0 && prevIdx !== best.idx) {
                            // Both ends on the same ride: splice its vertices in
                            // between so the plan follows the ridden line
                            const step = prevIdx < best.idx ? 1 : -1
                            const between: [number, number][] = []
                            for (let i = prevIdx + step; i !== best.idx && i >= 0 && i < path.length; i += step) {
                                between.push(path[i])
                            }
                            lastSnapRef.current = { rideId: best.rideId, pt: best.pt }
                            setDrawPath(p => [...p, ...between, path[best!.idx]])
                            return
                        }
                        next = best.pt
                        lastSnapRef.current = { rideId: best.rideId, pt: best.pt }
                    } else {
                        lastSnapRef.current = null
                    }
                } else {
                    lastSnapRef.current = null
                }
                setDrawPath(p => [...p, next])
                return
            }

            const pickInfo = deck.current.pickObject({ x: e.point.x, y: e.point.y, radius: 5 })

            if (pickInfo?.object) {
                const layerId = pickInfo.layer?.id
                if (layerId === 'photos-layer' || layerId === 'photos-count-layer') {
                    // Clicking a dot PINS its card open — it stays put (so the
                    // pager is usable) until dismissed via X or a map click
                    const photos = pickInfo.object.photos as PhotoSummary[]
                    setPoiCard(null)
                    setPhotoCard(prev => prev && prev.photos[0]?.id === photos[0]?.id
                        ? { ...prev, pinned: true }
                        : { x: e.point.x, y: e.point.y, photos, index: 0, pinned: true })
                    return
                }
                if (layerId === 'pois-layer') {
                    // POI pin → popover card; never touches the ride selection
                    setPhotoCard(null)
                    setPoiCard({ x: e.point.x, y: e.point.y, poi: pickInfo.object as Poi })
                    return
                }
                // Clicking anything else dismisses a pinned photo/POI card
                setPhotoCard(null)
                setPoiCard(null)
                // Support both rideId (gradient segments) and id (path layer)
                const id = (pickInfo.object.rideId || pickInfo.object.id) as string
                // Clicks BUILD the selection: every track clicked is added, and
                // re-clicking a selected track removes it. (Shift/meta used to
                // be the additive gesture; plain click now behaves the same, so
                // the modifiers are just no-ops on top.) Escape clears the lot.
                if (selectedIds.includes(id)) {
                    onSelect(selectedIds.filter(sid => sid !== id))
                } else {
                    onSelect([...selectedIds, id])
                }
            } else {
                // Clicked empty map — dismiss any pinned photo/POI card
                setPhotoCard(null)
                setPoiCard(null)
            }
        }

        const handleMouseMove = (e: maplibregl.MapMouseEvent) => {
            if (!deck.current) return

            const pickInfo = deck.current.pickObject({ x: e.point.x, y: e.point.y, radius: 5 })
            const hasHit = !!pickInfo?.object

            // Update cursor on map canvas — but keep the crosshair while the
            // route drawer is active (mousemove would otherwise wipe it, audit
            // low).
            if (map.current) {
                map.current.getCanvas().style.cursor =
                    drawModeRef.current ? 'crosshair' : hasHit ? 'pointer' : ''
            }

            const layerId = pickInfo?.layer?.id
            if (layerId === 'pois-layer') {
                // POI pins aren't rides: pointer cursor only, no ride hover
                onHover(null)
                onTrackHoverPoint?.(null)
                return
            }
            if (layerId === 'photos-layer' || layerId === 'photos-count-layer') {
                const photos = pickInfo!.object.photos as PhotoSummary[]
                // Transient hover preview — but never replace a pinned card
                setPhotoCard(prev => prev?.pinned || (prev && prev.photos[0]?.id === photos[0]?.id)
                    ? prev
                    : { x: e.point.x, y: e.point.y, photos, index: 0, pinned: false })
                onHover(null)
                return
            }
            // Cursor moved off the dot: transient previews close, pinned cards
            // stay (dismissed only via X or a click elsewhere on the map)
            setPhotoCard(prev => prev?.pinned ? prev : null)
            // Support both rideId (gradient segments) and id (path layer)
            const rideId = (pickInfo?.object?.rideId || pickInfo?.object?.id || null) as string | null
            onHover(rideId)
            // Map → profile sync: hovering a SELECTED track reports the
            // ground position so the profile can draw its cursor line there
            if (rideId && selectedIds.includes(rideId) && pickInfo?.coordinate) {
                onTrackHoverPoint?.({
                    rideId,
                    lon: pickInfo.coordinate[0],
                    lat: pickInfo.coordinate[1],
                })
            } else {
                onTrackHoverPoint?.(null)
            }
        }

        map.current.on('click', handleClick)
        map.current.on('mousemove', handleMouseMove)

        return () => {
            map.current?.off('click', handleClick)
            map.current?.off('mousemove', handleMouseMove)
        }
    }, [selectedIds, onSelect, onHover, onTrackHoverPoint])

    // --- Lasso selection handlers (overlay captures ALL pointer events while
    // active, so the map never pans/zooms mid-draw; works for mouse + touch) ---
    const lassoPoint = (e: React.PointerEvent<HTMLDivElement>) => {
        const rect = e.currentTarget.getBoundingClientRect()
        return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }

    const handleLassoDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!e.isPrimary) return
        e.currentTarget.setPointerCapture(e.pointerId)
        lassoDrawing.current = true
        lassoPathRef.current = [lassoPoint(e)]
        setLassoPath([...lassoPathRef.current])
    }

    const handleLassoMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!lassoDrawing.current || !e.isPrimary) return
        const pt = lassoPoint(e)
        const last = lassoPathRef.current[lassoPathRef.current.length - 1]
        // Throttle: only record every ~4px of movement
        if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 4) return
        lassoPathRef.current.push(pt)
        setLassoPath([...lassoPathRef.current])
    }

    const handleLassoUp = async (e: React.PointerEvent<HTMLDivElement>) => {
        if (!lassoDrawing.current) return
        lassoDrawing.current = false
        const pts = lassoPathRef.current
        lassoPathRef.current = []
        setLassoPath([])
        setLassoActive(false)

        if (pts.length < 3 || !map.current) return
        // Keep the request URL sane for very long scribbles
        const step = Math.max(1, Math.floor(pts.length / 150))
        const sampled = pts.filter((_, i) => i % step === 0)
        const lngLats = sampled.map(p => {
            const ll = map.current!.unproject([p.x, p.y])
            return [ll.lng, ll.lat] as [number, number]
        })
        try {
            const ids = await fetchRideIdsInPolygon(lngLats)
            // The server matches on geometry alone; keep only rides that pass
            // the active view filters (same rule as the list), so the lasso
            // never selects tracks the user can't see.
            const byId = new Map((rides || []).map(r => [r.id, r]))
            const filterSettings = { enabledModes, trackClasses, shapeClasses, gradeFilter, requireHr, requireSpeed, dateFrom, dateTo, plannedCollectionsOff, ownersOff, filters }
            const visibleIds = ids.filter(id => {
                const r = byId.get(id)
                return r != null && rideMatchesFilters(r, filterSettings)
            })
            if (e.shiftKey || e.metaKey) {
                onSelect(Array.from(new Set([...selectedIds, ...visibleIds])))
            } else {
                onSelect(visibleIds)
            }
        } catch (err) {
            console.error('Lasso selection failed', err)
        }
    }

    // --- Route drawer ---
    const drawDistanceKm = useMemo(() => {
        let m = 0
        for (let i = 1; i < drawPath.length; i++) {
            const [lon1, lat1] = drawPath[i - 1]
            const [lon2, lat2] = drawPath[i]
            const dx = (lon2 - lon1) * 111320 * Math.cos(lat1 * Math.PI / 180)
            const dy = (lat2 - lat1) * 110540
            m += Math.hypot(dx, dy)
        }
        return m / 1000
    }, [drawPath])

    const cancelDraw = useCallback(() => {
        setDrawMode(false)
        setDrawPath([])
        lastSnapRef.current = null
        setSavePlanOpen(false)
        setPlanError(null)
    }, [])

    // Draw-mode keys: Backspace undoes the last vertex, Enter opens save,
    // Escape cancels (registered only while drawing, and never over inputs)
    useEffect(() => {
        if (!drawMode) return
        const onKey = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement)?.tagName
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
            if (e.key === 'Backspace' || e.key === 'Delete') {
                e.preventDefault()
                lastSnapRef.current = null // undo breaks follow-continuity
                setDrawPath(p => p.slice(0, -1))
            } else if (e.key === 'Enter') {
                setDrawPath(p => {
                    if (p.length >= 2) setSavePlanOpen(true)
                    return p
                })
            } else if (e.key === 'Escape') {
                e.stopPropagation()
                cancelDraw()
            }
        }
        // Capture phase so App's Escape-clears-selection doesn't also fire
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
    }, [drawMode, cancelDraw])

    // Crosshair cursor while laying vertices
    useEffect(() => {
        const canvas = map.current?.getCanvas()
        if (!canvas) return
        canvas.style.cursor = drawMode ? 'crosshair' : ''
        return () => { canvas.style.cursor = '' }
    }, [drawMode])

    const handleSavePlan = async () => {
        setPlanSaving(true)
        setPlanError(null)
        try {
            const created = await createPlan({
                name: planName,
                mode: planMode,
                coords: drawPath,
            })
            cancelDraw()
            setPlanName('')
            queryClient.invalidateQueries({ queryKey: ['rides'] })
            queryClient.invalidateQueries({ queryKey: ['allRideMeta'] })
            queryClient.invalidateQueries({ queryKey: ['rideLocations'] })
            queryClient.invalidateQueries({ queryKey: ['rideStats'] })
            queryClient.invalidateQueries({ queryKey: ['heatmap'] })
            onSelect([created.id])
        } catch (e) {
            setPlanError(e instanceof Error ? e.message : String(e))
        } finally {
            setPlanSaving(false)
        }
    }

    return (
        <div
            ref={mapContainer}
            style={{ width: '100%', height: '100%', position: 'relative' }}
        >
            <canvas
                ref={deckCanvas}
                style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    pointerEvents: 'none',
                    zIndex: 1,
                }}
            />

            {/* Lasso draw overlay — swallows all pointer events while active */}
            {lassoActive && (
                <div
                    onPointerDown={handleLassoDown}
                    onPointerMove={handleLassoMove}
                    onPointerUp={handleLassoUp}
                    onPointerCancel={() => { lassoDrawing.current = false; lassoPathRef.current = []; setLassoPath([]); setLassoActive(false) }}
                    style={{
                        position: 'absolute',
                        inset: 0,
                        zIndex: 3,
                        cursor: 'crosshair',
                        touchAction: 'none',
                    }}
                >
                    <svg style={{ width: '100%', height: '100%', display: 'block' }}>
                        {lassoPath.length > 1 && (
                            <polygon
                                points={lassoPath.map(p => `${p.x},${p.y}`).join(' ')}
                                fill="rgba(79, 124, 255, 0.12)"
                                stroke="#4f7cff"
                                strokeWidth={2}
                                strokeDasharray="6 4"
                                strokeLinejoin="round"
                            />
                        )}
                    </svg>
                    {lassoPath.length === 0 && (
                        <div style={{
                            position: 'absolute',
                            top: 50,
                            left: '50%',
                            transform: 'translateX(-50%)',
                            background: 'rgba(0,0,0,0.75)',
                            color: 'white',
                            padding: '6px 14px',
                            borderRadius: 4,
                            fontSize: 12,
                            pointerEvents: 'none',
                        }}>
                            Draw a shape around the tracks to select them
                        </div>
                    )}
                </div>
            )}

            {/* Photo card — hover shows a transient preview; clicking the dot
                pins it (X or a map click dismisses) */}
            {photoCard && (() => {
                const photo = photoCard.photos[photoCard.index]
                const cardW = 336
                const left = Math.min(Math.max(photoCard.x - cardW / 2, 8), (mapContainer.current?.clientWidth || 800) - cardW - 8)
                const showAbove = photoCard.y > 330
                return (
                    <div
                        onMouseLeave={() => setPhotoCard(c => c?.pinned ? c : null)}
                        style={{
                            position: 'absolute',
                            left,
                            ...(showAbove ? { top: photoCard.y - 330 } : { top: photoCard.y + 14 }),
                            width: cardW,
                            background: 'rgba(15, 15, 20, 0.95)',
                            borderRadius: 8,
                            padding: 8,
                            zIndex: 4,
                            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                            color: 'white',
                            fontSize: 12,
                        }}
                    >
                        {photoCard.pinned && (
                            <button
                                onClick={() => setPhotoCard(null)}
                                title="Close"
                                style={{
                                    position: 'absolute',
                                    top: 4,
                                    right: 4,
                                    width: 22,
                                    height: 22,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    background: 'rgba(0,0,0,0.65)',
                                    color: 'white',
                                    border: '1px solid #555',
                                    borderRadius: '50%',
                                    cursor: 'pointer',
                                    zIndex: 1,
                                }}
                            >
                                <X size={12} />
                            </button>
                        )}
                        <a
                            href={photo.google_photos_url || `${SERVER_BASE}${photo.medium_url}`}
                            target="_blank"
                            rel="noreferrer"
                            title={photo.google_photos_url ? 'Open full resolution in Google Photos' : 'Open medium resolution'}
                        >
                            <img
                                src={`${SERVER_BASE}${photo.medium_url}`}
                                alt="ride photo"
                                style={{
                                    width: 320,
                                    height: 240,
                                    objectFit: 'cover',
                                    borderRadius: 4,
                                    display: 'block',
                                    background: '#222',
                                }}
                            />
                        </a>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
                            <span style={{ color: '#bbb' }}>
                                {photo.taken_at ? new Date(photo.taken_at).toLocaleString() : ''}
                            </span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                {photoCard.photos.length > 1 && (
                                    <>
                                        <button
                                            onClick={() => setPhotoCard(c => c && ({ ...c, index: (c.index - 1 + c.photos.length) % c.photos.length }))}
                                            style={{ background: 'none', border: '1px solid #555', color: 'white', borderRadius: 4, cursor: 'pointer', padding: '2px 6px', display: 'inline-flex', alignItems: 'center' }}
                                        ><ChevronLeft size={12} /></button>
                                        <span>{photoCard.index + 1}/{photoCard.photos.length}</span>
                                        <button
                                            onClick={() => setPhotoCard(c => c && ({ ...c, index: (c.index + 1) % c.photos.length }))}
                                            style={{ background: 'none', border: '1px solid #555', color: 'white', borderRadius: 4, cursor: 'pointer', padding: '2px 6px', display: 'inline-flex', alignItems: 'center' }}
                                        ><ChevronRight size={12} /></button>
                                    </>
                                )}
                                {photo.google_photos_url && (
                                    <a
                                        href={photo.google_photos_url}
                                        target="_blank"
                                        rel="noreferrer"
                                        style={{ color: '#7ab5ff', display: 'inline-flex', alignItems: 'center', gap: 3 }}
                                    >
                                        Google Photos <ExternalLink size={11} />
                                    </a>
                                )}
                            </span>
                        </div>
                    </div>
                )
            })()}

            {/* POI popover — name, category, collection, description (multi-
                line notes preserved). Dismissed via X or a click elsewhere. */}
            {poiCard && (() => {
                const meta = POI_CATEGORY_META[(poiCard.poi.category as PoiCategory)] ?? POI_CATEGORY_META.poi
                const cardW = 260
                const left = Math.min(Math.max(poiCard.x - cardW / 2, 8), (mapContainer.current?.clientWidth || 800) - cardW - 8)
                const showAbove = poiCard.y > 220
                return (
                    <div style={{
                        position: 'absolute',
                        left,
                        ...(showAbove ? { bottom: (mapContainer.current?.clientHeight || 600) - poiCard.y + 16 } : { top: poiCard.y + 16 }),
                        width: cardW,
                        background: 'rgba(15, 15, 20, 0.95)',
                        borderRadius: 8,
                        padding: '10px 12px',
                        zIndex: 4,
                        boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                        color: 'white',
                        fontSize: 12,
                    }}>
                        <button
                            onClick={() => setPoiCard(null)}
                            title="Close"
                            style={{
                                position: 'absolute', top: 4, right: 4,
                                width: 22, height: 22,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                background: 'transparent', color: '#aaa',
                                border: 'none', cursor: 'pointer',
                            }}
                        >
                            <X size={13} />
                        </button>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 18 }}>
                            <meta.icon size={16} color={meta.color} style={{ flexShrink: 0 }} />
                            <span style={{ fontWeight: 600, fontSize: 13 }}>{poiCard.poi.name}</span>
                        </div>
                        <div style={{ color: '#999', marginTop: 3 }}>
                            {meta.label}
                            {poiCard.poi.collection ? ` · ${poiCard.poi.collection}` : ''}
                        </div>
                        {poiCard.poi.description && (
                            <div style={{
                                marginTop: 8,
                                color: '#ddd',
                                whiteSpace: 'pre-wrap', // notes carry real line breaks
                                maxHeight: 180,
                                overflowY: 'auto',
                            }}>
                                {poiCard.poi.description}
                            </div>
                        )}
                    </div>
                )
            })()}

            {/* Compact floating toolbar — all layer/colour/filter controls */}
            <MapToolbar
                lassoActive={lassoActive}
                onToggleLasso={() => setLassoActive(a => !a)}
                drawActive={drawMode}
                onToggleDraw={() => (drawMode ? cancelDraw() : setDrawMode(true))}
                shouldLoadGradients={shouldLoadGradients}
                filterDefaults={dataRanges}
                onZoomTo={(bbox) => {
                    // "Zoom to collection" — same camera move as a Places
                    // folder click, capped shallower (collections span states)
                    if (!bbox.every(Number.isFinite)) return
                    map.current?.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], {
                        padding: 60,
                        maxZoom: 12,
                        duration: 900,
                    })
                }}
            />

            {/* Route drawer control panel */}
            {drawMode && (
                <div style={{
                    position: 'absolute',
                    bottom: 24,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    background: 'rgba(0,0,0,0.85)',
                    border: '1px solid #555',
                    borderRadius: 8,
                    padding: '8px 14px',
                    zIndex: 3,
                    color: 'white',
                    fontSize: 12,
                }}>
                    <span style={{ fontWeight: 600 }}>
                        {drawPath.length === 0
                            ? 'Click the map to start a route'
                            : `${drawPath.length} points · ${drawDistanceKm.toFixed(1)} km`}
                    </span>
                    <span style={{ color: '#999' }}>Backspace = undo · Enter = finish</span>
                    <button
                        className={`list-toggle ${snapDraw ? 'active' : ''}`}
                        onClick={() => setSnapDraw(v => !v)}
                        title="Snap to your tracks — consecutive points on the same ride follow it exactly"
                        style={{ padding: '4px 8px' }}
                    >
                        <Magnet size={12} style={{ verticalAlign: -2, marginRight: 3 }} />
                        Snap
                    </button>
                    <button
                        className="export-btn primary"
                        disabled={drawPath.length < 2}
                        onClick={() => setSavePlanOpen(true)}
                    >
                        Finish
                    </button>
                    <button className="export-btn" onClick={cancelDraw}>Cancel</button>
                </div>
            )}

            {/* Save-plan dialog */}
            {savePlanOpen && (
                <div className="export-overlay" onClick={() => setSavePlanOpen(false)}>
                    <div className="export-dialog" onClick={e => e.stopPropagation()}>
                        <div className="export-header"><span>Save plan</span></div>
                        <div className="export-body">
                            <label className="export-label">Name</label>
                            <input
                                className="export-input"
                                value={planName}
                                onChange={e => setPlanName(e.target.value)}
                                placeholder="e.g. Watagans link-up"
                                autoFocus
                            />
                            <label className="export-label">Mode</label>
                            <select
                                className="export-input"
                                value={planMode}
                                onChange={e => setPlanMode(e.target.value)}
                            >
                                <option value="adv">ADV / Touring</option>
                                <option value="enduro">Enduro</option>
                                <option value="mtb">Mountain bike</option>
                                <option value="other">Other</option>
                            </select>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                                {drawPath.length} points · {drawDistanceKm.toFixed(1)} km — saved as a
                                plan (blue), ready for the basket, exports and DingoNav.
                            </div>
                            {planError && <div className="export-error">{planError}</div>}
                            <div className="export-actions">
                                <button
                                    className="export-btn primary"
                                    disabled={planSaving || !planName.trim()}
                                    onClick={handleSavePlan}
                                >
                                    {planSaving ? 'Saving…' : 'Save plan'}
                                </button>
                                <button
                                    className="export-btn"
                                    onClick={() => setSavePlanOpen(false)}
                                    disabled={planSaving}
                                >
                                    Keep drawing
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Legend: mode colours, or the active gradient scale */}
            <div style={{
                position: 'absolute',
                bottom: 24,
                left: 10,
                background: 'rgba(0,0,0,0.75)',
                padding: '8px 12px',
                borderRadius: 8,
                zIndex: 2,
                fontSize: 11,
                color: 'white',
            }}>
                {colorMode === 'mode' ? (
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                        {(['adv', 'enduro', 'mtb', 'watersport', 'other'] as RideMode[])
                            .filter(m => enabledModes.includes(m))
                            .map(m => {
                                const c = MODE_COLORS[m]
                                return (
                                    <span key={m} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                        <span style={{ width: 14, height: 3, background: `rgb(${c[0]},${c[1]},${c[2]})`, display: 'inline-block', borderRadius: 2 }} />
                                        {m}
                                    </span>
                                )
                            })}
                    </div>
                ) : (() => {
                    // Value-proportional gradient with tick lines at each
                    // user-set stop (shared helpers with the settings pane)
                    const kind = colorMode === 'hr' ? 'hr' as const
                        : colorMode === 'grade' ? 'grade' as const : 'speed' as const
                    const scale = colorMode === 'hr' ? hrScale
                        : colorMode === 'grade' ? gradeScale : speedScale
                    const percents = stopsToPercents(kind, scale)
                    return (
                        <div>
                            <div style={{ marginBottom: 3, color: '#aaa' }}>
                                {colorMode === 'hr' ? 'Heart rate (bpm)'
                                    : colorMode === 'grade' ? 'Grade (% steepness)' : 'Speed (km/h)'}
                            </div>
                            <div style={{
                                position: 'relative',
                                width: 180,
                                height: 8,
                                borderRadius: 4,
                                background: gradientCss(kind, scale),
                            }}>
                                {percents.map((p, i) => (
                                    <div key={i} style={{
                                        position: 'absolute',
                                        left: `${p}%`,
                                        top: -2,
                                        width: 2,
                                        height: 12,
                                        background: 'white',
                                        boxShadow: '0 0 1px rgba(0,0,0,0.9)',
                                    }} />
                                ))}
                            </div>
                            <div style={{ position: 'relative', width: 180, height: 12, marginTop: 3 }}>
                                {percents.map((p, i) => (
                                    <span key={i} style={{
                                        position: 'absolute',
                                        left: `${p}%`,
                                        transform: 'translateX(-50%)',
                                        color: '#ddd',
                                        fontSize: 10,
                                    }}>
                                        {scale.stops[i]}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )
                })()}
            </div>

            {(isLoading || isLoadingPoints) && (
                <div style={{
                    position: 'absolute',
                    top: 10,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: 'rgba(0,0,0,0.7)',
                    color: 'white',
                    padding: '8px 16px',
                    borderRadius: 4,
                    zIndex: 2,
                }}>
                    {isLoading ? 'Loading rides...' : 'Loading track data...'}
                </div>
            )}
        </div>
    )
}
