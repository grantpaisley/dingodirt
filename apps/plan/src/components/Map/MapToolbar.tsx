import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import {
    Compass, Flame, Bike, Waves, MapPin,
    Layers, Camera,
    Palette, Paintbrush, HeartPulse, Gauge, TrendingUp,
    Eye, Crosshair, ZoomIn,
    Funnel, Lasso, Settings,
    Repeat, MoveRight,
    MousePointer2, Navigation, Route,
    Footprints, Satellite, TreePine, Map as MapIcon, Mountain, MountainSnow, SquareDashed,
    PencilLine, Locate,
} from 'lucide-react'
import { useSettings, useUiState, effectiveLayerState, hasActiveRangeFilters, MODE_COLORS, ALL_POI_CATEGORIES, type RideMode, type TrackClass, type TrackShape, type ArrowMode, type BaseStyle, type GradeKey } from '../../store'
import { useStyleManifest } from '../../mapStyles'
import { getMapInstance } from './mapRegistry'
import { deriveSnapLevels, nextSnap, prevSnap } from './styleZoom'
import { useAllRideMeta, useCollections } from '../../api/hooks'
import { POI_CATEGORY_META } from './poiIcons'
import { FilterPaneContent } from '../Filters/FilterPanel'
import { SettingsPaneContent } from '../Settings/SettingsPanel'

interface MapToolbarProps {
    lassoActive: boolean
    onToggleLasso: () => void
    /** Route drawer mode (draw a plan by clicking vertices) */
    drawActive: boolean
    onToggleDraw: () => void
    shouldLoadGradients: boolean
    filterDefaults: {
        hrMin: number
        hrMax: number
        speedMin: number
        speedMax: number
        distanceMin: number
        distanceMax: number
    }
    /** Fly the camera to a bbox ("zoom to collection") */
    onZoomTo: (bbox: [number, number, number, number]) => void
}

// 46px buttons confirmed right; icons fill most of the button so they read
// at a glance (24px still looked lost inside the 46px hit area).
const BUTTON_SIZE = 46
const ICON_SIZE = 32
const PANE_ICON_SIZE = 20

const MODE_META: Array<[RideMode, string, string, typeof Compass]> = [
    ['adv', 'ADV', 'ADV / Adventure-touring rides', Compass],
    ['enduro', 'Enduro', 'Enduro rides (incl. electric moto)', Flame],
    ['mtb', 'MTB', 'Mountain bike / eMTB rides', Bike],
    ['watersport', 'Water', 'Watersport tracks', Waves],
    ['other', 'Other', 'Hikes, flights, everything else', MapPin],
]

// Class swatches, matching HEAT_COLORS in heatmapLayers.ts. Own/other are
// now expressed as the "My rides" / "Other rides" layer rows rather than a
// separate class filter, so these only feed the layer-row swatches.
const CLASS_SWATCH: Record<TrackClass, string> = {
    own: 'rgb(255,130,45)',
    other: 'rgb(255,45,70)',
    plan: 'rgb(70,140,255)',
}

// Track-shape rows: loop (start ≈ end) vs one-way (point-to-point). A general
// filter over the rides layer and the list.
const SHAPE_META: Array<[TrackShape, string, string, typeof Compass]> = [
    ['loop', 'Loop', 'Loops — start and finish at roughly the same place', Repeat],
    ['oneway', 'One-way', 'Point-to-point tracks that start and end apart', MoveRight],
]

// Base map styles (radio: exactly one active). Built-ins listed here; local
// styles from /styles/index.json are appended at render time (see
// useStyleManifest) so community style JSONs show up with zero code changes.
const BASE_STYLE_META: Array<[BaseStyle, string, string, typeof Compass]> = [
    ['dingo', 'Dingo', 'The shared Dingo basemap — same map as Nav and Studio, themed by the active scheme', Compass],
    ['satellite', 'Satellite', 'Satellite imagery with labels (MapTiler hybrid)', Satellite],
    ['outdoor', 'Outdoor', 'Terrain topo with contours and hillshading built in', TreePine],
    ['topo', 'Topo', 'Classic topographic map', MapIcon],
]

/** Grade tooltips (Grant's published 1-5 difficulty scale) */
const GRADE_LABELS: Record<string, string> = {
    '1': 'Easiest: bitumen, wide flat gravel',
    '2': 'Easy: narrow/bumpy roads, avoidable obstacles',
    '3': 'Medium: twin tracks, loose surfaces, shallow creeks',
    '4': 'Difficult: 4WD tracks, steep hills, knee-deep crossings',
    '5': 'Very difficult: tight singletrack, expert only',
}

// Direction-arrow display modes (radio: exactly one active)
const ARROW_META: Array<[ArrowMode, string, string, typeof Compass]> = [
    ['hover', 'On hover', 'Arrows only on the hovered or selected track', MousePointer2],
    ['zoom', 'Zoomed in', 'Arrows on all tracks once zoomed in close (z13+)', ZoomIn],
    ['always', 'Always', 'Arrows on all tracks at every zoom level', Navigation],
]

/**
 * Floating map toolbar — a slim vertical strip of icon buttons on the map's
 * left edge. Each button either opens a dropdown pane of related toggles
 * (track types, layers, colour, view, filters, settings) or acts directly
 * (lasso). Only one pane is open at a time.
 */
export function MapToolbar({ lassoActive, onToggleLasso, drawActive, onToggleDraw, shouldLoadGradients, filterDefaults, onZoomTo }: MapToolbarProps) {
    const [openPane, setOpenPane] = useState<string | null>(null)
    const settings = useSettings()
    // Planned-route collections (tiny payload, cached — the section lists them
    // with per-collection visibility toggles + zoom-to-bbox buttons)
    const { data: collections } = useCollections()
    // While a pack preview is on, the layer rows show what the PACK renders,
    // read-only. The preview never writes to settings, so exiting restores the
    // user's own toggles with no bookkeeping.
    const { packPreview, setPackPreview } = useUiState()
    const eff = effectiveLayerState(settings, packPreview)
    const previewing = !!packPreview
    const {
        colorMode, setColorMode,
        enabledModes, toggleMode,
        filters, setFilters,
        requireHr, setRequireHr,
        requireSpeed, setRequireSpeed,
        focusMode, setFocusMode,
        dimmedOpacity, setDimmedOpacity,
        autoZoom, setAutoZoom,
        showPhotos, setShowPhotos,
        showHeatmap, toggleShowHeatmap,
        showStravaRide, toggleShowStravaRide,
        showStravaHike, toggleShowStravaHike,
        toggleMyRides, toggleOtherRides,
        plannedCollectionsOff, togglePlannedCollection,
        showPois, setShowPois,
        poiCategories, togglePoiCategory,
        showPlannedHeat, toggleShowPlannedHeat,
        shapeClasses, toggleShapeClass,
        gradeFilter, toggleGradeKey,
        heatIntensity, setHeatIntensity,
        heatWidth, setHeatWidth,
        heatZoomScaling, setHeatZoomScaling,
        arrowMode, setArrowMode,
        setBaseStyle,
        hillshade, setHillshade,
        terrain3d, setTerrain3d,
        showAreas, setShowAreas,
        ownersOff, toggleOwnerOff,
    } = settings

    // Local base styles from /styles/index.json (community style JSONs)
    const localStyles = useStyleManifest()

    // Per-owner facet under "Other rides": who owns the other-class tracks,
    // with counts. Metadata is fetched once the layers pane opens (whole
    // library, no geometry — same payload the Places tree uses).
    const { data: allMeta } = useAllRideMeta(openPane === 'layers')
    const ownerRows = useMemo(() => {
        const counts = new Map<string, { name: string, count: number }>()
        for (const r of allMeta ?? []) {
            if (r.class !== 'other' || !r.owner_id) continue
            const row = counts.get(r.owner_id)
            if (row) row.count++
            else counts.set(r.owner_id, { name: r.owner ?? 'Unknown', count: 1 })
        }
        return [...counts.entries()]
            .map(([id, v]) => ({ id, ...v }))
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    }, [allMeta])

    const toggle = (pane: string) => setOpenPane(p => (p === pane ? null : pane))

    // Track classes moved to the Layers pane, so they no longer count toward
    // this pane's "something is filtered" badge.
    const modesFiltered = enabledModes.length < MODE_META.length
        || Object.values(shapeClasses).some(v => !v)
        || Object.values(gradeFilter).some(v => !v)
    const viewActive = focusMode || autoZoom || requireHr || requireSpeed
    const filtersActive = hasActiveRangeFilters(filters)

    return (
        <div style={{
            position: 'absolute',
            top: 10,
            left: 10,
            // Above the legend so open panes never get painted over
            zIndex: 3,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
        }}>
            <ToolButton
                icon={<Bike size={ICON_SIZE} />}
                title="Track types — toggle which ride modes are shown"
                active={openPane === 'modes'}
                badge={modesFiltered}
                onClick={() => toggle('modes')}
            >
                {openPane === 'modes' && (
                    <Pane title="Track types">
                        {MODE_META.map(([m, label, title, Icon]) => {
                            const c = MODE_COLORS[m]
                            const on = enabledModes.includes(m)
                            return (
                                <PaneRow
                                    key={m}
                                    icon={<Icon size={PANE_ICON_SIZE} color={`rgb(${c[0]},${c[1]},${c[2]})`} />}
                                    label={label}
                                    title={`${title} — click to show/hide`}
                                    on={on}
                                    onClick={() => toggleMode(m)}
                                    swatch={`rgb(${c[0]},${c[1]},${c[2]})`}
                                />
                            )
                        })}
                        {/* Track shape — loop vs point-to-point (rides + list) */}
                        <div style={{
                            borderTop: '1px solid #555', margin: '8px 0 4px',
                            paddingTop: 8, color: 'white', fontSize: 13, fontWeight: 'bold',
                        }}>
                            Track shape
                        </div>
                        {SHAPE_META.map(([shape, label, title, Icon]) => (
                            <PaneRow
                                key={shape}
                                icon={<Icon size={PANE_ICON_SIZE} />}
                                label={label}
                                title={`${title} — click to show/hide`}
                                on={shapeClasses[shape]}
                                onClick={() => toggleShapeClass(shape)}
                            />
                        ))}
                        {/* Difficulty grade 1-5 + ungraded (Grant's scale) */}
                        <div style={{
                            borderTop: '1px solid #555', margin: '8px 0 4px',
                            paddingTop: 8, color: 'white', fontSize: 13, fontWeight: 'bold',
                        }}>
                            Grade
                        </div>
                        <div style={{ display: 'flex', gap: 4, padding: '4px 2px', flexWrap: 'wrap' }}>
                            {(['1', '2', '3', '4', '5', 'none'] as GradeKey[]).map(g => (
                                <button
                                    key={g}
                                    onClick={() => toggleGradeKey(g)}
                                    title={g === 'none' ? 'Ungraded tracks' : `Grade ${g} — ${GRADE_LABELS[g]}`}
                                    style={{
                                        minWidth: g === 'none' ? 34 : 28,
                                        padding: '4px 6px',
                                        borderRadius: 4,
                                        border: '1px solid #666',
                                        cursor: 'pointer',
                                        fontSize: 12,
                                        background: gradeFilter[g] ? '#4f7cff' : 'transparent',
                                        color: gradeFilter[g] ? 'white' : '#888',
                                    }}
                                >
                                    {g === 'none' ? '—' : g}
                                </button>
                            ))}
                        </div>
                    </Pane>
                )}
            </ToolButton>

            <ToolButton
                icon={<Layers size={ICON_SIZE} />}
                title="Map layers — rides, planned routes, heatmap, photos"
                active={openPane === 'layers'}
                badge={showHeatmap || showPhotos || showStravaRide || showStravaHike || showPois || showPlannedHeat}
                onClick={() => toggle('layers')}
            >
                {openPane === 'layers' && (
                    <Pane title="Layers">
                        {previewing && (
                            <div style={{
                                display: 'flex', alignItems: 'center', gap: 6,
                                background: 'rgba(79,124,255,0.18)',
                                border: '1px solid rgba(79,124,255,0.5)',
                                borderRadius: 4, padding: '6px 8px', marginBottom: 8,
                                color: 'white', fontSize: 12,
                            }}>
                                <span style={{ flex: 1 }}>Previewing pack layers</span>
                                <button
                                    onClick={() => setPackPreview(null)}
                                    style={{
                                        background: 'transparent', border: '1px solid #7f9dff',
                                        color: '#bcccff', borderRadius: 3, fontSize: 11,
                                        padding: '2px 6px', cursor: 'pointer',
                                    }}
                                >Exit</button>
                            </div>
                        )}
                        {/* Rows are listed in DRAW order — top of the list is
                            drawn on top of everything below it. */}
                        <PaneRow
                            icon={<Route size={PANE_ICON_SIZE} color={CLASS_SWATCH.own} />}
                            label="My rides"
                            title="Your recorded rides and planned routes"
                            on={eff.trackClasses.own || eff.trackClasses.plan}
                            disabled={previewing}
                            onClick={toggleMyRides}
                            swatch={CLASS_SWATCH.own}
                        />
                        <PaneRow
                            icon={<Route size={PANE_ICON_SIZE} color={CLASS_SWATCH.other} />}
                            label="Other rides"
                            title="Other people's tracks (ingested with --origin other)"
                            on={eff.trackClasses.other}
                            disabled={previewing}
                            onClick={toggleOtherRides}
                            swatch={CLASS_SWATCH.other}
                        />
                        {/* Per-owner facet: who the other-class tracks belong
                            to. Only filters within "Other rides" — hiding an
                            owner here never touches My rides. */}
                        {eff.trackClasses.other && ownerRows.length > 0 && (
                            <div style={{ marginLeft: 22 }}>
                                {ownerRows.map(o => (
                                    <PaneRow
                                        key={o.id}
                                        icon={null}
                                        label={`${o.name} (${o.count})`}
                                        title={`Other-ride tracks owned by ${o.name}`}
                                        on={!ownersOff.includes(o.id)}
                                        disabled={previewing}
                                        onClick={() => toggleOwnerOff(o.id)}
                                        swatch={CLASS_SWATCH.other}
                                    />
                                ))}
                            </div>
                        )}
                        {/* Planned routes — curated collections (GOAT etc).
                            Each row toggles its collection; the crosshair
                            button flies to its bbox. POIs + planned heat are
                            the section's companion layers. */}
                        {collections && collections.length > 0 && (
                            <>
                                <div style={{
                                    borderTop: '1px solid #555', margin: '8px 0 4px',
                                    paddingTop: 8, color: 'white', fontSize: 13, fontWeight: 'bold',
                                }}>
                                    Planned routes
                                </div>
                                {collections.map(c => {
                                    const on = !plannedCollectionsOff.includes(c.name)
                                    return (
                                        <div key={c.name} style={{ display: 'flex', alignItems: 'center' }}>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <PaneRow
                                                    icon={<Route size={PANE_ICON_SIZE} color={CLASS_SWATCH.plan} />}
                                                    label={`${c.name} (${c.route_count})`}
                                                    title={`${c.name} — ${c.route_count} routes, ${Math.round(c.total_km).toLocaleString()} km — click to show/hide`}
                                                    on={on}
                                                    disabled={previewing}
                                                    onClick={() => togglePlannedCollection(c.name)}
                                                    swatch={CLASS_SWATCH.plan}
                                                />
                                            </div>
                                            <button
                                                onClick={() => c.bbox && onZoomTo(c.bbox)}
                                                disabled={!c.bbox}
                                                title={`Zoom the map to ${c.name}`}
                                                style={{
                                                    background: 'transparent',
                                                    border: 'none',
                                                    color: c.bbox ? '#9ab' : '#555',
                                                    cursor: c.bbox ? 'pointer' : 'default',
                                                    padding: '4px 2px 4px 8px',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    flexShrink: 0,
                                                }}
                                            >
                                                <Locate size={15} />
                                            </button>
                                        </div>
                                    )
                                })}
                                <PaneRow
                                    icon={<MapPin size={PANE_ICON_SIZE} />}
                                    label="POIs"
                                    title="Points of interest from planned-route imports (fuel, camps, water…) — zoom in past z7 to see the pins"
                                    on={showPois}
                                    disabled={previewing}
                                    onClick={() => setShowPois(!showPois)}
                                />
                                {showPois && (
                                    <div style={{ display: 'flex', gap: 4, padding: '2px 2px 4px 34px', flexWrap: 'wrap' }}>
                                        {ALL_POI_CATEGORIES.map(cat => {
                                            const meta = POI_CATEGORY_META[cat]
                                            const catOn = poiCategories[cat]
                                            const Icon = meta.icon
                                            return (
                                                <button
                                                    key={cat}
                                                    onClick={() => togglePoiCategory(cat)}
                                                    title={`${meta.label} — click to show/hide`}
                                                    style={{
                                                        width: 26,
                                                        height: 26,
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'center',
                                                        borderRadius: '50%',
                                                        border: `1px solid ${catOn ? meta.color : '#555'}`,
                                                        background: catOn ? meta.color : 'transparent',
                                                        color: catOn ? 'white' : '#777',
                                                        cursor: 'pointer',
                                                        padding: 0,
                                                    }}
                                                >
                                                    <Icon size={14} />
                                                </button>
                                            )
                                        })}
                                    </div>
                                )}
                                <PaneRow
                                    icon={<Flame size={PANE_ICON_SIZE} color={CLASS_SWATCH.plan} />}
                                    label="Planned heat"
                                    title="Density heat over every planned route, whatever the collection toggles show — where does everything else run?"
                                    on={showPlannedHeat}
                                    disabled={previewing}
                                    onClick={toggleShowPlannedHeat}
                                    swatch={CLASS_SWATCH.plan}
                                />
                                <div style={{ borderTop: '1px solid #555', margin: '8px 0 4px' }} />
                            </>
                        )}
                        <PaneRow
                            icon={<Flame size={PANE_ICON_SIZE} color={CLASS_SWATCH.own} />}
                            label="My heatmap"
                            title="Density heat from your own rides — repeated traversals glow brighter"
                            on={eff.showHeatmap}
                            disabled={previewing}
                            onClick={toggleShowHeatmap}
                            swatch={CLASS_SWATCH.own}
                        />
                        <PaneRow
                            icon={<Bike size={PANE_ICON_SIZE} />}
                            label="Strava rides"
                            title="Strava global off-road ride heat (everyone's MTB / gravel tracks) — blue raster underlay"
                            on={eff.showStravaRide}
                            disabled={previewing}
                            onClick={toggleShowStravaRide}
                        />
                        <PaneRow
                            icon={<Footprints size={PANE_ICON_SIZE} />}
                            label="Strava hikes"
                            title="Strava global hike + trail-run heat — purple raster underlay"
                            on={eff.showStravaHike}
                            disabled={previewing}
                            onClick={toggleShowStravaHike}
                        />
                        <div style={{ borderTop: '1px solid #555', margin: '8px 0 4px' }} />
                        <PaneRow
                            icon={<Camera size={PANE_ICON_SIZE} />}
                            label="Photos"
                            title="Show photo locations as dots — hover to preview, click to pin"
                            on={eff.showPhotos}
                            disabled={previewing}
                            onClick={() => setShowPhotos(!showPhotos)}
                        />
                        <PaneRow
                            icon={<SquareDashed size={PANE_ICON_SIZE} />}
                            label="Areas"
                            title="Show area boundaries (Central Coast, Australia, …) as outlines"
                            on={eff.showAreas}
                            disabled={previewing}
                            onClick={() => setShowAreas(!showAreas)}
                        />
                        {/* Terrain — relief shading + 3D */}
                        <div style={{
                            borderTop: '1px solid #555', margin: '8px 0 4px',
                            paddingTop: 8, color: 'white', fontSize: 13, fontWeight: 'bold',
                        }}>
                            Terrain
                        </div>
                        <PaneRow
                            icon={<MountainSnow size={PANE_ICON_SIZE} />}
                            label="Hillshade"
                            title="Relief shading over the base map — gullies and ridgelines read at a glance"
                            on={eff.hillshade}
                            disabled={previewing}
                            onClick={() => setHillshade(!hillshade)}
                        />
                        <PaneRow
                            icon={<Mountain size={PANE_ICON_SIZE} />}
                            label="3D terrain"
                            title="Raise the map into 3D relief — right-drag to pitch. Tracks render flat, so they can float above steep terrain while pitched"
                            on={terrain3d}
                            onClick={() => setTerrain3d(!terrain3d)}
                        />
                        {/* Base map (radio) */}
                        <div style={{
                            borderTop: '1px solid #555', margin: '8px 0 4px',
                            paddingTop: 8, color: 'white', fontSize: 13, fontWeight: 'bold',
                        }}>
                            Base map
                        </div>
                        {[...BASE_STYLE_META,
                          ...localStyles.map(e =>
                              [e.id, e.label, e.description, MountainSnow] as
                              [BaseStyle, string, string, typeof Compass]),
                        ].map(([style, label, title, Icon]) => (
                            <PaneRow
                                key={style}
                                icon={<Icon size={PANE_ICON_SIZE} />}
                                label={label}
                                title={title}
                                on={eff.baseStyle === style}
                                disabled={previewing}
                                onClick={() => setBaseStyle(style)}
                            />
                        ))}
                        {/* Direction arrows — when the chevrons show (radio) */}
                        <div style={{
                            borderTop: '1px solid #555', margin: '8px 0 4px',
                            paddingTop: 8, color: 'white', fontSize: 13, fontWeight: 'bold',
                        }}>
                            Direction arrows
                        </div>
                        {ARROW_META.map(([mode, label, title, Icon]) => (
                            <PaneRow
                                key={mode}
                                icon={<Icon size={PANE_ICON_SIZE} />}
                                label={label}
                                title={title}
                                on={arrowMode === mode}
                                onClick={() => setArrowMode(mode)}
                            />
                        ))}
                    </Pane>
                )}
            </ToolButton>

            <ToolButton
                icon={<Flame size={ICON_SIZE} />}
                title="Heatmap style (toggle the heatmap itself in the Layers pane)"
                active={openPane === 'heatmap'}
                badge={showHeatmap}
                onClick={() => toggle('heatmap')}
            >
                {openPane === 'heatmap' && (
                    <Pane title="Heatmap">
                        <div style={{ padding: '7px 4px', color: 'white', fontSize: 13 }}>
                            <div style={{ marginBottom: 4, opacity: 0.8 }}>Intensity</div>
                            <input
                                type="range"
                                min={0.3} max={3} step={0.1}
                                value={heatIntensity}
                                onChange={(e) => setHeatIntensity(Number(e.target.value))}
                                title="Heat brightness — how quickly overlapping tracks saturate"
                                style={{ width: '100%' }}
                            />
                            <div style={{ margin: '10px 0 4px', opacity: 0.8 }}>Line width</div>
                            <input
                                type="range"
                                min={0.3} max={2.5} step={0.1}
                                value={heatWidth}
                                onChange={(e) => setHeatWidth(Number(e.target.value))}
                                title="Heat line thickness — scales the glow halo and the core together"
                                style={{ width: '100%' }}
                            />
                            <div style={{ margin: '10px 0 4px', opacity: 0.8 }}>Zoom scaling</div>
                            <input
                                type="range"
                                min={0} max={1} step={0.05}
                                value={heatZoomScaling}
                                onChange={(e) => setHeatZoomScaling(Number(e.target.value))}
                                title="How width responds to zoom — left: fixed pixel width at every zoom; right: full ground-width scaling (thin filaments zoomed out, wide glow zoomed in)"
                                style={{ width: '100%' }}
                            />
                            <div style={{
                                display: 'flex', justifyContent: 'space-between',
                                fontSize: 10, opacity: 0.6, marginTop: 2,
                            }}>
                                <span>fixed</span>
                                <span>scale with zoom</span>
                            </div>
                        </div>
                    </Pane>
                )}
            </ToolButton>

            <ToolButton
                icon={<Palette size={ICON_SIZE} />}
                title="Colour tracks by mode, heart rate, speed or grade"
                active={openPane === 'colour'}
                badge={colorMode !== 'mode'}
                onClick={() => toggle('colour')}
            >
                {openPane === 'colour' && (
                    <Pane title="Colour by">
                        <PaneRow
                            icon={<Paintbrush size={PANE_ICON_SIZE} />}
                            label="Ride mode"
                            title="Colour each track by its ride mode"
                            on={colorMode === 'mode'}
                            onClick={() => setColorMode('mode')}
                        />
                        <PaneRow
                            icon={<HeartPulse size={PANE_ICON_SIZE} />}
                            label="Heart rate"
                            title={shouldLoadGradients ? 'Colour by heart rate' : 'Zoom in (z8+) with ≤100 rides to enable'}
                            on={colorMode === 'hr'}
                            disabled={!shouldLoadGradients}
                            onClick={() => setColorMode('hr')}
                        />
                        <PaneRow
                            icon={<Gauge size={PANE_ICON_SIZE} />}
                            label="Speed"
                            title={shouldLoadGradients ? 'Colour by speed' : 'Zoom in (z8+) with ≤100 rides to enable'}
                            on={colorMode === 'speed'}
                            disabled={!shouldLoadGradients}
                            onClick={() => setColorMode('speed')}
                        />
                        <PaneRow
                            icon={<TrendingUp size={PANE_ICON_SIZE} />}
                            label="Grade"
                            title={shouldLoadGradients
                                ? 'Colour by steepness (ascent and descent alike)'
                                : 'Zoom in (z8+) with ≤100 rides to enable'}
                            on={colorMode === 'grade'}
                            disabled={!shouldLoadGradients}
                            onClick={() => setColorMode('grade')}
                        />
                    </Pane>
                )}
            </ToolButton>

            <ToolButton
                icon={<Eye size={ICON_SIZE} />}
                title="View options — focus, auto-zoom, data-presence requirements"
                active={openPane === 'view'}
                badge={viewActive}
                onClick={() => toggle('view')}
            >
                {openPane === 'view' && (
                    <Pane title="View">
                        <PaneRow
                            icon={<Crosshair size={PANE_ICON_SIZE} />}
                            label="Focus selection"
                            title="Hide all unselected tracks while a selection exists"
                            on={focusMode}
                            onClick={() => setFocusMode(!focusMode)}
                        />
                        <PaneRow
                            icon={<ZoomIn size={PANE_ICON_SIZE} />}
                            label="Auto-zoom"
                            title="Zoom the map to fit the selection whenever it changes"
                            on={autoZoom}
                            onClick={() => setAutoZoom(!autoZoom)}
                        />
                        {/* How faint unhighlighted tracks go while a selection,
                            search, or the export basket is highlighting */}
                        <div style={{ padding: '7px 4px', color: 'white', fontSize: 13 }}>
                            <div style={{ marginBottom: 4, opacity: 0.8 }}>Dim unhighlighted</div>
                            <input
                                type="range"
                                min={0.05} max={0.6} step={0.05}
                                value={dimmedOpacity}
                                onChange={(e) => setDimmedOpacity(Number(e.target.value))}
                                title="Opacity of non-highlighted tracks while a selection, search, or the export basket is active"
                                style={{ width: '100%' }}
                            />
                            <div style={{
                                display: 'flex', justifyContent: 'space-between',
                                fontSize: 10, opacity: 0.6, marginTop: 2,
                            }}>
                                <span>faint</span>
                                <span>visible</span>
                            </div>
                        </div>
                        <PaneRow
                            icon={<HeartPulse size={PANE_ICON_SIZE} />}
                            label="Has heart rate"
                            title="Only show tracks that have heart-rate data"
                            on={requireHr}
                            onClick={() => setRequireHr(!requireHr)}
                        />
                        <PaneRow
                            icon={<Gauge size={PANE_ICON_SIZE} />}
                            label="Has speed"
                            title="Only show tracks that have speed data"
                            on={requireSpeed}
                            onClick={() => setRequireSpeed(!requireSpeed)}
                        />
                    </Pane>
                )}
            </ToolButton>

            <ToolButton
                icon={<Funnel size={ICON_SIZE} />}
                title="Filter by HR / speed / distance ranges"
                active={openPane === 'filters'}
                badge={filtersActive}
                onClick={() => toggle('filters')}
            >
                {openPane === 'filters' && (
                    <Pane>
                        <FilterPaneContent
                            filters={filters}
                            onChange={setFilters}
                            defaults={filterDefaults}
                        />
                    </Pane>
                )}
            </ToolButton>

            <ToolButton
                icon={<Lasso size={ICON_SIZE} />}
                title="Draw a shape to select all tracks inside or crossing it (Shift adds to selection)"
                active={lassoActive}
                onClick={() => { setOpenPane(null); onToggleLasso() }}
            />

            <ToolButton
                icon={<PencilLine size={ICON_SIZE} />}
                title="Draw a route — click to lay points (pan/zoom stay live), Backspace to undo, Enter to save as a plan"
                active={drawActive}
                onClick={() => { setOpenPane(null); onToggleDraw() }}
            />

            <ToolButton
                icon={<Settings size={ICON_SIZE} />}
                title="Colour scale boundaries"
                active={openPane === 'settings'}
                onClick={() => toggle('settings')}
            >
                {openPane === 'settings' && (
                    <Pane>
                        <SettingsPaneContent />
                    </Pane>
                )}
            </ToolButton>
            <ZoomWidget styleId={eff.baseStyle} />
        </div>
    )
}

/** Current zoom + snap stepper: +/- jump between the zoom levels where the
 *  active style's detail changes (derived from layer min/max zooms).
 *  (Style-layers editing moved to Dingo Studio — Plan stays plan-only.) */
function ZoomWidget({ styleId }: {
    styleId: BaseStyle
}) {
    const mapZoom = useUiState(s => s.mapZoom)
    const snapTo = (dir: 1 | -1) => {
        const m = getMapInstance()
        if (!m) return
        const levels = deriveSnapLevels(m.getStyle())
        const z = dir === 1 ? nextSnap(levels, m.getZoom()) : prevSnap(levels, m.getZoom())
        m.easeTo({ zoom: z, duration: 250 })
    }
    const stepStyle: CSSProperties = {
        width: '100%',
        height: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        color: 'white',
        border: 'none',
        cursor: 'pointer',
        fontSize: 14,
        lineHeight: 1,
        padding: 0,
    }
    return (
        <div style={{
            width: BUTTON_SIZE,
            display: 'flex',
            flexDirection: 'column',
            background: 'rgba(0,0,0,0.85)',
            border: '1px solid #666',
            borderRadius: 8,
            boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
            overflow: 'hidden',
        }}>
            <button title="Zoom in to the next detail level" style={stepStyle}
                onClick={() => snapTo(1)}>+</button>
            <span
                title={`Zoom level (${styleId})`}
                style={{ ...stepStyle, height: 22, fontSize: 12, fontWeight: 'bold', cursor: 'default' }}
            >
                {formatZoom(mapZoom)}
            </span>
            <button title="Zoom out to the previous detail level" style={stepStyle}
                onClick={() => snapTo(-1)}>−</button>
        </div>
    )
}

function formatZoom(z: number): string {
    return Number.isInteger(z) ? `z${z}` : `z${z.toFixed(1)}`
}

function ToolButton({
    icon,
    title,
    active,
    badge,
    onClick,
    children,
}: {
    icon: ReactNode
    title: string
    active: boolean
    badge?: boolean
    onClick: () => void
    children?: ReactNode
}) {
    return (
        // No `position` here: the pane child anchors to the toolbar root
        // instead, so every pane opens at the TOP of the strip rather than
        // beside its button (tall panes were running under the legend).
        <div>
            <button
                onClick={onClick}
                title={title}
                style={{
                    width: BUTTON_SIZE,
                    height: BUTTON_SIZE,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: active ? '#4f7cff' : 'rgba(0,0,0,0.85)',
                    color: 'white',
                    border: `1px solid ${active ? '#7ea0ff' : '#666'}`,
                    borderRadius: 8,
                    cursor: 'pointer',
                    position: 'relative',
                    boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
                }}
            >
                {icon}
                {badge && !active && (
                    <span style={{
                        position: 'absolute',
                        top: 4,
                        right: 4,
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: '#4f7cff',
                        border: '1px solid rgba(0,0,0,0.85)',
                    }} />
                )}
            </button>
            {children}
        </div>
    )
}

function Pane({ title, children }: { title?: string, children: ReactNode }) {
    return (
        <div style={{
            position: 'absolute',
            left: 'calc(100% + 8px)',
            top: 0,
            background: 'rgba(0,0,0,0.92)',
            border: '1px solid #555',
            borderRadius: 8,
            padding: 12,
            zIndex: 100,
            minWidth: 190,
            // Never run off the map: scroll inside the pane instead
            maxHeight: 'calc(100vh - 180px)',
            overflowY: 'auto',
        }}>
            {title && (
                <div style={{ color: 'white', fontSize: 13, fontWeight: 'bold', marginBottom: 9 }}>
                    {title}
                </div>
            )}
            {children}
        </div>
    )
}

function PaneRow({
    icon,
    label,
    title,
    on,
    disabled,
    onClick,
    swatch,
}: {
    icon: ReactNode
    label: string
    title: string
    on: boolean
    disabled?: boolean
    onClick: () => void
    swatch?: string
}) {
    return (
        <button
            onClick={onClick}
            title={title}
            disabled={disabled}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                background: 'transparent',
                color: disabled ? '#666' : 'white',
                border: 'none',
                padding: '7px 4px',
                borderRadius: 4,
                cursor: disabled ? 'not-allowed' : 'pointer',
                fontSize: 13,
                opacity: on ? 1 : 0.55,
                whiteSpace: 'nowrap',
            }}
        >
            {icon}
            <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
            {/* Toggle state: filled pill when on, hollow when off */}
            <span style={{
                width: 26,
                height: 14,
                borderRadius: 7,
                border: `1px solid ${swatch || '#4f7cff'}`,
                background: on ? (swatch || '#4f7cff') : 'transparent',
                display: 'inline-block',
                flexShrink: 0,
            }} />
        </button>
    )
}
