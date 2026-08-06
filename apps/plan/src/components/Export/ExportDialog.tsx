import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Download, Flame, FolderOutput, Navigation, Plus, Trash2, X } from 'lucide-react'
import {
    useDestinations, useRidesByIds, createDestination, deleteDestination,
    exportToDestination, exportAsDownload, exportDingoNav, exportHeatmapTiles,
    useCoverageEstimate,
    type ExportManifest, type DingoNavManifest, type HeatTilesManifest,
    type LayerCoverage,
} from '../../api/hooks'
import { useBasket, useSettings, useUiState } from '../../store'

/** Bundle name default: the most common first word of the basket's ride names
 *  — usually the suburb (ride names read "Menai loop via …") — plus today's
 *  export date, e.g. "Menai 2026-07-15". Falls back to a dated name. */
export function defaultBundleName(rides: { name: string | null }[]): string {
    // Most common first word across the ride names.
    const counts = new Map<string, number>()
    for (const r of rides) {
        const first = (r.name ?? '').trim().split(/\s+/)[0]
        if (first) counts.set(first, (counts.get(first) ?? 0) + 1)
    }
    let best: string | null = null
    let bestN = 0
    for (const [word, n] of counts) {
        if (n > bestN) { best = word; bestN = n }
    }
    // Today in LOCAL time as YYYY-MM-DD (toISOString would give UTC — a day
    // behind for AU/east-of-UTC in the morning).
    const d = new Date()
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return best ? `${best} ${date}` : `Dingo export ${date}`
}

/** Modal for exporting the basket (or an explicit ride list, e.g. a pack's):
 *  pick a configured device folder (the daemon writes the bundle there;
 *  Syncthing does the rest) or download a zip, choose what the bundle
 *  contains, then review the manifest. Sharing lives in Packs, not here. */
export function ExportDialog({ onClose, rideIds, defaultName }: {
    onClose: () => void
    /** Export these rides instead of the basket (the basket is untouched) */
    rideIds?: string[]
    defaultName?: string
}) {
    const basket = useBasket()
    const ids = rideIds ?? basket.ids
    const queryClient = useQueryClient()
    const { data: destinations } = useDestinations()
    // The bundled heatmap honors the filter panel, same as the on-screen one.
    const { enabledModes, trackClasses, requireHr, requireSpeed, dateFrom, dateTo } = useSettings()

    // The exported rides drive the default name ("<suburb> <date>").
    const { data: basketRides } = useRidesByIds(ids)

    // 'download' or a destination id
    const [target, setTarget] = useState<string>('download')
    const [name, setName] = useState('')
    // Prefill from the dominant region once the rides load — but never clobber
    // a name the user has already typed.
    const nameEdited = useRef(false)
    useEffect(() => {
        if (nameEdited.current) return
        setName(defaultName ?? defaultBundleName(basketRides ?? []))
    }, [basketRides, defaultName])

    const [includeTracks, setIncludeTracks] = useState(true)
    const [includeHeatmap, setIncludeHeatmap] = useState(true)
    const [includeStrava, setIncludeStrava] = useState(false)
    const [includeBasemap, setIncludeBasemap] = useState(true)
    const [includeSatellite, setIncludeSatellite] = useState(false)
    const [includeHillshade, setIncludeHillshade] = useState(false)
    const [privacy, setPrivacy] = useState(true)
    // Per-layer coverage shape; missing keys = corridor (the default).
    const [coverage, setCoverage] = useState<LayerCoverage>({})

    // Live per-layer size estimate for the map-tile layers (dingonav target).
    // The estimate covers all four layers regardless of which are checked, so
    // it doesn't depend on the checkbox state. The response also carries the
    // coverage shapes, drawn on the map behind the dialog as grey outlines.
    const { setCoveragePreview } = useUiState()
    const wantsLayers = target === 'dingonav'
    const { estimate, estimating } = useCoverageEstimate(ids, coverage, wantsLayers)
    // Rect outline only when a layer that's actually included uses box mode.
    const anyRect = (includeHeatmap && coverage.heatmap === 'rect')
        || (includeBasemap && coverage.basemap === 'rect')
        || (includeSatellite && coverage.satellite === 'rect')
        || (includeStrava && coverage.strava === 'rect')
        || (includeHillshade && coverage.hillshade === 'rect')
    useEffect(() => {
        if (!estimate) { setCoveragePreview(null); return }
        setCoveragePreview({
            corridor: estimate.corridor,
            rect: estimate.rect,
            showRect: anyRect,
            overview: estimate.overview?.region ?? null,
        })
    }, [estimate, anyRect, setCoveragePreview])
    // Closing the dialog drops the preview outlines from the map.
    useEffect(() => () => setCoveragePreview(null), [setCoveragePreview])

    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [result, setResult] = useState<{ bundleDir: string | null, manifest: ExportManifest | null, dingonav?: DingoNavManifest | null, heattiles?: HeatTilesManifest | null } | null>(null)

    // Inline "new destination" form
    const [showNewDest, setShowNewDest] = useState(false)
    const [newDest, setNewDest] = useState({ name: '', path: '', profile: 'generic', layout: 'flat' })

    const count = ids.length
    const manyTracks = target !== 'heattiles' && includeTracks && count > 500

    const handleExport = async () => {
        setBusy(true)
        setError(null)
        try {
            if (target === 'download') {
                await exportAsDownload({
                    ride_ids: ids, name,
                    include_tracks: includeTracks, include_heatmap: includeHeatmap, privacy,
                })
                setResult({ bundleDir: null, manifest: null })
            } else if (target === 'dingonav') {
                const dingonav = await exportDingoNav({
                    ride_ids: ids, name,
                    include_tracks: includeTracks, include_heatmap: includeHeatmap, privacy,
                    include_strava: includeStrava, include_basemap: includeBasemap,
                    include_satellite: includeSatellite, include_hillshade: includeHillshade,
                    coverage,
                    heatmap_filters: {
                        classes: Object.entries(trackClasses).filter(([, on]) => on).map(([c]) => c),
                        modes: enabledModes,
                        require_hr: requireHr,
                        require_speed: requireSpeed,
                        date_from: dateFrom || null,
                        date_to: dateTo || null,
                    },
                })
                setResult({ bundleDir: null, manifest: null, dingonav })
            } else if (target === 'heattiles') {
                const heattiles = await exportHeatmapTiles({
                    ride_ids: ids, name, privacy,
                })
                setResult({ bundleDir: null, manifest: null, heattiles })
            } else {
                const res = await exportToDestination({
                    ride_ids: ids, destination_id: target, name,
                    include_tracks: includeTracks, include_heatmap: includeHeatmap, privacy,
                })
                setResult({ bundleDir: res.bundle_dir, manifest: res.manifest })
                // Basket self-heal: ids the server no longer recognises
                // (deleted / superseded after they were added) drop out. Only
                // applies when exporting the basket itself.
                const stale = res.manifest.skipped
                    .filter(s => s.reason === 'not_found' || s.reason === 'superseded')
                    .map(s => s.id)
                if (!rideIds && stale.length > 0) basket.prune(stale)
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setBusy(false)
        }
    }

    const handleCreateDest = async () => {
        setError(null)
        try {
            const created = await createDestination({
                name: newDest.name, path: newDest.path,
                profile: newDest.profile as 'osmand' | 'locus' | 'dmd2' | 'generic',
                layout: newDest.layout as 'flat' | 'tree',
            })
            queryClient.invalidateQueries({ queryKey: ['exportDestinations'] })
            setTarget(created.id)
            setShowNewDest(false)
            setNewDest({ name: '', path: '', profile: 'generic', layout: 'flat' })
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        }
    }

    const handleDeleteDest = async (id: string) => {
        try {
            await deleteDestination(id)
            queryClient.invalidateQueries({ queryKey: ['exportDestinations'] })
            if (target === id) setTarget('download')
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        }
    }

    const formatBytes = (b: number) =>
        b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`

    // Right-aligned per-layer size estimate ('…' while loading, '+' if capped).
    const sizeLabel = (l?: { bytes: number, capped: boolean }) =>
        !estimate
            ? (estimating ? <span className="export-layer-size est">…</span> : null)
            : <span className="export-layer-size">~{formatBytes(l?.bytes ?? 0)}{l?.capped ? '+' : ''}</span>

    // Sum of the map-tile layers the user has ticked (for the running total).
    const selectedTileBytes = estimate
        ? (includeSatellite ? estimate.satellite.bytes : 0)
        + (includeBasemap ? estimate.basemap.bytes : 0)
        + (includeHillshade ? estimate.hillshade.bytes : 0)
        + (includeStrava ? estimate.strava.bytes : 0)
        : 0

    // Preflight: ticked map layers whose PMTiles source is missing, dead, or
    // doesn't cover the selection. The export refuses these rather than
    // shipping a pack without the layer, so say so before the click.
    const sourceWarnings = ([
        ['Topo map', 'basemap', includeBasemap],
        ['Hillshade', 'hillshade', includeHillshade],
    ] as const)
        .filter(([, key, on]) => on && estimate?.sources?.[key]?.ok === false)
        .map(([layer, key]) => ({ layer, note: estimate?.sources?.[key]?.note ?? 'source unavailable' }))

    // Corridor-vs-box shape picker for one layer (shown while it's checked).
    const covToggle = (layer: keyof LayerCoverage) => {
        const mode = coverage[layer] ?? 'corridor'
        const pick = (m: 'corridor' | 'rect') => (e: React.MouseEvent) => {
            e.preventDefault()
            e.stopPropagation()
            if (m !== mode) setCoverage({ ...coverage, [layer]: m })
        }
        return (
            <span
                className="coverage-toggle"
                title="Coverage: corridor hugs the tracks (~1.5 km); box covers the whole selection rectangle"
            >
                <button className={mode === 'corridor' ? 'on' : ''} onClick={pick('corridor')}>corridor</button>
                <button className={mode === 'rect' ? 'on' : ''} onClick={pick('rect')}>box</button>
            </span>
        )
    }

    // How far the zoomed-out heat lines reach past the corridor. The third
    // option is labelled with the real region name when the estimate knows it
    // ("NSW"), because "region" alone doesn't convey that it means the state.
    const heatOverview = coverage.heat_overview ?? 'local'
    const heatOverviewToggle = (
        <div
            className="export-suboption"
            title="Zoomed out, how much surrounding heat travels with the pack. Corridor keeps only the lines beside the tracks; the wider options add faded context and bundle size."
        >
            <span className="export-suboption-label">Zoomed-out heat</span>
            <span className="coverage-toggle">
                {([
                    ['none', 'corridor'],
                    ['local', '50 km'],
                    ['region', estimate?.overview?.area ?? 'region'],
                ] as const).map(([mode, label]) => (
                    <button
                        key={mode}
                        className={heatOverview === mode ? 'on' : ''}
                        onClick={e => {
                            e.preventDefault()
                            e.stopPropagation()
                            if (mode !== heatOverview) setCoverage({ ...coverage, heat_overview: mode })
                        }}
                    >
                        {label}
                    </button>
                ))}
            </span>
        </div>
    )

    // The map-layer picker, shared by the DingoNav-bundle and Share-link targets.
    const layerPicker = (
        <>
            <label className="export-label">Rides</label>
            <label className="export-check">
                <input type="checkbox" checked={includeTracks}
                    onChange={e => setIncludeTracks(e.target.checked)} />
                Tracks — selected rides as full-res GPX
            </label>
            <label className="export-check">
                <input type="checkbox" checked={includeHeatmap}
                    onChange={e => setIncludeHeatmap(e.target.checked)} />
                Heatmap — rides near the selection (feeds turn cues)
                {includeHeatmap ? covToggle('heatmap') : null}
            </label>
            {includeHeatmap ? heatOverviewToggle : null}

            <label className="export-label">Map layers</label>
            <label className="export-check" title="ESRI World Imagery aerial tiles baked for the ride coverage.">
                <input type="checkbox" checked={includeSatellite}
                    onChange={e => setIncludeSatellite(e.target.checked)} />
                Satellite — aerial imagery (Esri)
                {includeSatellite ? covToggle('satellite') : null}
                {sizeLabel(estimate?.satellite)}
            </label>
            <label className="export-check" title="Vector basemap extract: roads, trails, water and labels. The size is a rough guide — built-up areas pack several times more into a tile than bush does.">
                <input type="checkbox" checked={includeBasemap}
                    onChange={e => setIncludeBasemap(e.target.checked)} />
                Topo map — roads, trails, water, labels
                {includeBasemap ? covToggle('basemap') : null}
                {sizeLabel(estimate?.basemap)}
            </label>
            <label className="export-check" title="Terrain hillshade relief under the trails (needs a DEM source on the daemon).">
                <input type="checkbox" checked={includeHillshade}
                    onChange={e => setIncludeHillshade(e.target.checked)} />
                Hillshade — terrain relief
                {includeHillshade ? covToggle('hillshade') : null}
                {sizeLabel(estimate?.hillshade)}
            </label>
            <label className="export-check" title="Strava global-heatmap tiles for the ride coverage (needs Strava connected on the daemon).">
                <input type="checkbox" checked={includeStrava}
                    onChange={e => setIncludeStrava(e.target.checked)} />
                Strava heatmap
                {includeStrava ? covToggle('strava') : null}
                {sizeLabel(estimate?.strava)}
            </label>
            {sourceWarnings.map(w => (
                <div key={w.layer} className="export-warning">
                    ⚠ {w.layer} unavailable — {w.note}
                </div>
            ))}
            {estimate?.overview && (includeBasemap || includeStrava || includeHeatmap) && (
                <div className="export-hint" title="Zoomed-out context baked into the bundle: region basemap to z7 plus a local z8–10 band, coarse Strava heat z8–10, simplified heat lines clipped to the region.">
                    Overview: {estimate.overview.area}
                    {includeBasemap ? ` — ~${formatBytes(estimate.overview.basemap.bytes)} map` : ''}
                    {includeStrava ? ` · ~${formatBytes(estimate.overview.strava.bytes)} Strava` : ''}
                </div>
            )}
            {(includeSatellite || includeBasemap || includeHillshade || includeStrava) && estimate && (
                <div className="export-total">
                    Map layers ≈ {formatBytes(selectedTileBytes)} (estimate)
                </div>
            )}
        </>
    )

    return (
        <div className="export-overlay" onClick={onClose}>
            <div className="export-dialog" onClick={e => e.stopPropagation()}>
                <div className="export-header">
                    <span>Export {count} track{count === 1 ? '' : 's'}</span>
                    <button className="export-close" onClick={onClose} title="Close"><X size={16} /></button>
                </div>

                {result ? (
                    <div className="export-body">
                        {result.manifest ? (
                            <>
                                <div className="export-done">
                                    Bundle written to <code>{result.bundleDir}</code>
                                </div>
                                <div className="export-manifest">
                                    {result.manifest.files.map(f => (
                                        <div key={f.path} className="export-manifest-row">
                                            <span className="export-manifest-path">{f.path}</span>
                                            <span className="export-manifest-meta">
                                                {f.kind === 'heatmap' ? `${f.rides} tracks · ` : ''}{formatBytes(f.bytes)}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                                {result.manifest.skipped.length > 0 && (
                                    <div className="export-skipped">
                                        {result.manifest.skipped.length} ride{result.manifest.skipped.length === 1 ? '' : 's'} skipped
                                        ({[...new Set(result.manifest.skipped.map(s => s.reason.replace('_', ' ')))].join(', ')})
                                        — stale entries were removed from the basket.
                                    </div>
                                )}
                                <div className="export-total">
                                    {result.manifest.files.length} files · {formatBytes(result.manifest.total_bytes)}
                                </div>
                            </>
                        ) : result.dingonav ? (
                            <>
                                <div className="export-done">Download started — check your browser downloads.</div>
                                <div className="export-manifest">
                                    <div className="export-manifest-row"><span>Rides</span><span className="export-manifest-meta">{result.dingonav.tracks} GPX{result.dingonav.tracks_bytes ? ` · ${formatBytes(result.dingonav.tracks_bytes)}` : ''}</span></div>
                                    <div className="export-manifest-row"><span>Heatmap</span><span className="export-manifest-meta">{result.dingonav.heatmap_features} tracks{result.dingonav.heatmap_bytes ? ` · ${formatBytes(result.dingonav.heatmap_bytes)}` : ''}</span></div>
                                    <div className="export-manifest-row">
                                        <span>Satellite</span>
                                        <span className="export-manifest-meta">
                                            {result.dingonav.satellite
                                                ? `${result.dingonav.satellite.included}/${result.dingonav.satellite.requested} tiles z${result.dingonav.satellite.zmin}–${result.dingonav.satellite.zmax}${result.dingonav.satellite_bytes ? ` · ${formatBytes(result.dingonav.satellite_bytes)}` : ''}${result.dingonav.satellite.aborted ? ` · ${result.dingonav.satellite.aborted}` : ''}${result.dingonav.satellite.capped ? ' · capped' : ''}`
                                                : 'off'}
                                        </span>
                                    </div>
                                    <div className="export-manifest-row">
                                        <span>Topo map</span>
                                        <span className="export-manifest-meta">
                                            {result.dingonav.basemap.included
                                                ? `included${result.dingonav.basemap_bytes ? ` · ${formatBytes(result.dingonav.basemap_bytes)}` : ''}`
                                                : (result.dingonav.basemap.note || 'off')}
                                        </span>
                                    </div>
                                    <div className="export-manifest-row">
                                        <span>Hillshade</span>
                                        <span className="export-manifest-meta">
                                            {result.dingonav.hillshade.included
                                                ? `included${result.dingonav.hillshade_bytes ? ` · ${formatBytes(result.dingonav.hillshade_bytes)}` : ''}`
                                                : (result.dingonav.hillshade.note || 'off')}
                                        </span>
                                    </div>
                                    <div className="export-manifest-row">
                                        <span>Strava heatmap</span>
                                        <span className="export-manifest-meta">
                                            {result.dingonav.strava
                                                ? `${result.dingonav.strava.ride_included} ride + ${result.dingonav.strava.hike_included} hike tiles z${result.dingonav.strava.zmin}–${result.dingonav.strava.zmax}${result.dingonav.strava_bytes ? ` · ${formatBytes(result.dingonav.strava_bytes)}` : ''}${result.dingonav.strava.capped ? ' · capped' : ''}`
                                                : 'off'}
                                        </span>
                                    </div>
                                </div>
                                <div className="export-total">{formatBytes(result.dingonav.bytes)}</div>
                            </>
                        ) : result.heattiles ? (
                            <>
                                <div className="export-done">Download started — check your browser downloads.</div>
                                <div className="export-manifest">
                                    <div className="export-manifest-row"><span>Tracks rendered</span><span className="export-manifest-meta">{result.heattiles.rides}</span></div>
                                    <div className="export-manifest-row"><span>Tiles</span><span className="export-manifest-meta">{result.heattiles.tiles} · z{result.heattiles.min_zoom}–{result.heattiles.max_zoom}</span></div>
                                    <div className="export-manifest-row"><span>Size</span><span className="export-manifest-meta">{formatBytes(result.heattiles.bytes)}</span></div>
                                </div>
                                <div className="export-skipped" style={{ color: 'var(--text-secondary)' }}>
                                    Add as a raster overlay — OsmAnd: <code>files/tiles/</code> · Locus: <code>mapsRaster/</code>.
                                </div>
                            </>
                        ) : (
                            <div className="export-done">Download started — check your browser downloads.</div>
                        )}
                        <div className="export-actions">
                            <button className="export-btn primary" onClick={onClose}>Done</button>
                        </div>
                    </div>
                ) : (
                    <div className="export-body">
                        <label className="export-label">Name</label>
                        <input
                            className="export-input"
                            value={name}
                            onChange={e => { nameEdited.current = true; setName(e.target.value) }}
                            placeholder="e.g. Dingo Central Coast"
                            title="Shown in DingoNav when the bundle is loaded"
                        />

                        <label className="export-label">Destination</label>
                        <div className="export-dest-list">
                            <label className="export-dest-row">
                                <input
                                    type="radio"
                                    checked={target === 'download'}
                                    onChange={() => setTarget('download')}
                                />
                                <Download size={14} />
                                <span>Download zip</span>
                            </label>
                            <label className="export-dest-row">
                                <input
                                    type="radio"
                                    checked={target === 'dingonav'}
                                    onChange={() => setTarget('dingonav')}
                                />
                                <Navigation size={14} />
                                <span className="export-dest-name">DingoNav bundle</span>
                                <span className="export-dest-meta">one .dingonav · rides + heatmap + map</span>
                            </label>
                            <label className="export-dest-row">
                                <input
                                    type="radio"
                                    checked={target === 'heattiles'}
                                    onChange={() => setTarget('heattiles')}
                                />
                                <Flame size={14} />
                                <span className="export-dest-name">Heatmap tiles</span>
                                <span className="export-dest-meta">.mbtiles raster overlay for OsmAnd/Locus</span>
                            </label>
                            {destinations?.map(d => (
                                <label key={d.id} className="export-dest-row">
                                    <input
                                        type="radio"
                                        checked={target === d.id}
                                        onChange={() => setTarget(d.id)}
                                    />
                                    <FolderOutput size={14} />
                                    <span className="export-dest-name">{d.name}</span>
                                    <span className="export-dest-meta">{d.profile} · {d.layout}</span>
                                    <button
                                        className="export-dest-delete"
                                        onClick={(e) => { e.preventDefault(); handleDeleteDest(d.id) }}
                                        title={`Remove destination (folder ${d.path} is untouched)`}
                                    ><Trash2 size={12} /></button>
                                </label>
                            ))}
                            {showNewDest ? (
                                <div className="export-newdest">
                                    <input
                                        className="export-input"
                                        placeholder="Name (e.g. OsmAnd phone)"
                                        value={newDest.name}
                                        onChange={e => setNewDest({ ...newDest, name: e.target.value })}
                                    />
                                    <input
                                        className="export-input"
                                        placeholder="Folder path (e.g. ~/Sync/osmand-tracks)"
                                        value={newDest.path}
                                        onChange={e => setNewDest({ ...newDest, path: e.target.value })}
                                    />
                                    <div style={{ display: 'flex', gap: 6 }}>
                                        <select
                                            className="export-input"
                                            value={newDest.profile}
                                            onChange={e => setNewDest({ ...newDest, profile: e.target.value })}
                                            title="Nav app the folder syncs to (sets simplification budget; all profiles write all color dialects)"
                                        >
                                            <option value="generic">Generic</option>
                                            <option value="osmand">OsmAnd</option>
                                            <option value="locus">Locus</option>
                                            <option value="dmd2">DMD2</option>
                                        </select>
                                        <select
                                            className="export-input"
                                            value={newDest.layout}
                                            onChange={e => setNewDest({ ...newDest, layout: e.target.value })}
                                            title="flat: all files in the bundle folder (safest) · tree: State/Region subfolders"
                                        >
                                            <option value="flat">Flat</option>
                                            <option value="tree">State/Region tree</option>
                                        </select>
                                    </div>
                                    <div style={{ display: 'flex', gap: 6 }}>
                                        <button
                                            className="export-btn"
                                            disabled={!newDest.name.trim() || !newDest.path.trim()}
                                            onClick={handleCreateDest}
                                        >Add</button>
                                        <button className="export-btn" onClick={() => setShowNewDest(false)}>Cancel</button>
                                    </div>
                                </div>
                            ) : (
                                <button className="export-add-dest" onClick={() => setShowNewDest(true)}>
                                    <Plus size={12} /> New destination…
                                </button>
                            )}
                        </div>

                        {target === 'dingonav' ? (
                            <>
                                {layerPicker}
                                <div className="export-hint">
                                    One file with everything for the ride. On the phone:
                                    DingoNav → ☰ → Load files → pick the .dingonav.
                                </div>
                            </>
                        ) : target === 'heattiles' ? (
                            <>
                                <label className="export-label">Contents</label>
                                <div className="export-hint">
                                    A raster density heatmap of the {count} selected track{count === 1 ? '' : 's'}
                                    {' '}— distinct rides per pixel, orange to white-hot, zoom 5–14. Drops
                                    into a nav app's raster-tiles folder as an offline overlay.
                                </div>
                            </>
                        ) : (
                            <>
                                <label className="export-label">Contents</label>
                                <label className="export-check">
                                    <input
                                        type="checkbox"
                                        checked={includeTracks}
                                        onChange={e => setIncludeTracks(e.target.checked)}
                                    />
                                    Individual tracks — one GPX per ride, colored by class
                                </label>
                                <label className="export-check">
                                    <input
                                        type="checkbox"
                                        checked={includeHeatmap}
                                        onChange={e => setIncludeHeatmap(e.target.checked)}
                                    />
                                    Merged heatmap — own/other/plan layers from these tracks
                                </label>
                            </>
                        )}

                        <label className="export-check" title="Remove points inside your privacy zones (Arcadia) from the exported files. Uncheck for a complete personal copy.">
                            <input
                                type="checkbox"
                                checked={privacy}
                                onChange={e => setPrivacy(e.target.checked)}
                            />
                            Hide privacy zones (Arcadia)
                        </label>

                        {manyTracks && (
                            <div className="export-warning">
                                This will write {count} individual GPX files — consider heatmap-only for
                                very large selections.
                            </div>
                        )}
                        {error && <div className="export-error">{error}</div>}

                        <div className="export-actions">
                            <button
                                className="export-btn primary"
                                disabled={busy || count === 0 || !name.trim()
                                    || (wantsLayers && !includeTracks && !includeHeatmap && !includeStrava
                                        && !includeBasemap && !includeSatellite && !includeHillshade)
                                    || (!wantsLayers && target !== 'heattiles' && !includeTracks && !includeHeatmap)}
                                onClick={handleExport}
                            >
                                {busy ? 'Exporting…' : target === 'download' || target === 'dingonav' || target === 'heattiles' ? 'Download' : 'Export'}
                            </button>
                            <button className="export-btn" onClick={onClose} disabled={busy}>Cancel</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
