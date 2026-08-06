import { useEffect, useMemo, useRef, useState } from 'react'
import { Bike, Boxes, Crosshair, FolderTree, Link2, List, ListChecks, Map, Package, PackageMinus, PackagePlus, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { ImportDialog } from '../Import/ImportDialog'
import {
    useRides, useRidesByIds, useAllRideMeta, usePacks, createPack, publishPack,
    useCoverageEstimate, type Bounds, type LayerCoverage,
} from '../../api/hooks'
import { useSettings, useBasket, useUiState, rideMatchesFilters, COVERAGE_SHAPE_COLORS } from '../../store'

/** Server-default coverage — the basket preview asks for the shapes, not for a
 *  particular layer config. Module-level so its identity stays stable. */
const EMPTY_COVERAGE: LayerCoverage = {}
import { PlacesTree } from './PlacesTree'
import { defaultBundleName } from '../Export/ExportDialog'

interface ListPaneProps {
    selectedIds: string[]
    onSelect: (ids: string[]) => void
    onHover: (id: string | null) => void
    bounds?: Bounds
    onExport?: () => void
    /** Places view: fly the map to a folder's bounding box */
    onFlyTo?: (bbox: [number, number, number, number]) => void
}

export function ListPane({ selectedIds, onSelect, onHover, bounds, onExport, onFlyTo }: ListPaneProps) {
    // When on, the list only shows tracks intersecting the current map viewport
    const [inViewOnly, setInViewOnly] = useState(true)
    const [importOpen, setImportOpen] = useState(false)
    // Free-text search over name + localities. Shared via the UI store so the
    // map can dim non-matching tracks while a search is active. A non-empty
    // query searches ALL rides (the viewport restriction is bypassed) so a
    // name/place lookup finds tracks anywhere, not just those on screen.
    const {
        searchQuery: search, setSearchQuery: setSearch, listView, setListView,
        selectedPackId, setSelectedPackId,
    } = useUiState()
    const basket = useBasket()
    const queryClient = useQueryClient()

    // Packs view: saved bundles (published ones live on dingodirt.com).
    const { data: packList } = usePacks(listView === 'packs')
    // Sequential refresh state: the pack being re-published now, per-row errors.
    const [refreshingId, setRefreshingId] = useState<string | null>(null)
    const [packErrors, setPackErrors] = useState<Record<string, string>>({})

    const refreshPack = async (id: string) => {
        setRefreshingId(id)
        setPackErrors(e => { const { [id]: _, ...rest } = e; return rest })
        try {
            await publishPack(id)
        } catch (e) {
            setPackErrors(prev => ({ ...prev, [id]: e instanceof Error ? e.message : String(e) }))
        } finally {
            setRefreshingId(null)
            queryClient.invalidateQueries({ queryKey: ['packs'] })
        }
    }

    // Refresh All walks the stale published packs one at a time (parallel
    // publishes would sha-conflict on the shares repo); a failure marks its
    // row red and the walk continues.
    const [refreshingAll, setRefreshingAll] = useState(false)
    const stalePacks = (packList?.packs ?? []).filter(p => p.published_at && p.stale)
    const refreshAll = async () => {
        setRefreshingAll(true)
        for (const p of stalePacks) {
            await refreshPack(p.id)
        }
        setRefreshingAll(false)
    }

    // Basket → new pack: capture the current filter-panel state so the pack's
    // bundled heatmap matches the screen, then jump to the pack's detail.
    const saveBasketAsPack = async () => {
        const name = window.prompt('Pack name', defaultBundleName(basketRides ?? []))
        if (!name?.trim()) return
        try {
            const { id } = await createPack({
                name: name.trim(),
                ride_ids: basket.ids,
                include_tracks: true,
                include_heatmap: true,
                include_basemap: true,
                heatmap_filters: {
                    classes: Object.entries(settings.trackClasses).filter(([, on]) => on).map(([c]) => c),
                    modes: settings.enabledModes,
                    require_hr: settings.requireHr,
                    require_speed: settings.requireSpeed,
                    date_from: settings.dateFrom || null,
                    date_to: settings.dateTo || null,
                },
            })
            queryClient.invalidateQueries({ queryKey: ['packs'] })
            setListView('packs')
            setSelectedPackId(id)
        } catch (e) {
            window.alert(e instanceof Error ? e.message : String(e))
        }
    }
    const searching = search.trim().length > 0
    // A search runs server-side (whole library, ignoring the viewport); an empty
    // query falls back to the viewport list. The server already narrows to the
    // matching rows, so a name/place lookup no longer misses rides past the cap.
    const { data: allRides, isLoading } = useRides(
        inViewOnly && !searching ? bounds : undefined,
        undefined,
        searching ? search : undefined,
    )
    // Basket view shows the basket's contents regardless of viewport/search —
    // fetched by id so rides older than the list cap still appear.
    const { data: basketRides } = useRidesByIds(listView === 'basket' ? basket.ids : [])
    // Places view filters the whole library's metadata client-side, so folder
    // counts share the exact filter semantics of the list and map.
    const { data: allMeta, isLoading: metaLoading } = useAllRideMeta(listView === 'places')
    // Same filter semantics as the map (shared store): mode toggles,
    // has-HR/has-speed, date range, and the range sliders all remove rows.
    const settings = useSettings()
    const { dateFrom, dateTo, setDateFrom, setDateTo } = settings
    // Focus mode fetches the selection BY ID rather than filtering the viewport
    // list: auto-zoom can land with a selected track outside the viewport
    // query's result, and filtering would then show an empty list for a
    // selection the map is clearly drawing.
    const focusIds = settings.focusMode && listView === 'tracks' ? selectedIds : []
    const { data: focusRides } = useRidesByIds(focusIds)
    // Focus mode ("Only selected") narrows the tracks list to the selection, the
    // same rule the map applies. No selection ⇒ everything shows, so the
    // default-on toggle never leaves a blank list.
    const rides = useMemo(
        () => {
            if (listView === 'basket') return basketRides
            if (focusIds.length > 0) return focusRides
            return allRides?.filter(r => rideMatchesFilters(r, settings))
        },
        [listView, basketRides, focusIds, focusRides, allRides, settings]
    )
    const placesRides = useMemo(
        () => (listView === 'places'
            ? (allMeta ?? []).filter(r => rideMatchesFilters(r, settings))
            : []),
        [listView, allMeta, settings]
    )

    // Basket view: draw every coverage shape a pack built from this basket
    // would use — corridor, rect and the zoomed-out region — colour-coded to
    // the legend below the list. Coverage stays at the server defaults; the
    // shapes themselves come back regardless of which layers are picked.
    const inBasketView = listView === 'basket' && basket.ids.length > 0
    const { estimate: basketEstimate } = useCoverageEstimate(basket.ids, EMPTY_COVERAGE, inBasketView)
    const { setCoveragePreview } = useUiState()
    // Only ever clear a preview we put there — the pack detail pane owns the
    // same slot and must not get stomped when the list is on another view.
    const ownsPreview = useRef(false)
    useEffect(() => {
        if (inBasketView && basketEstimate) {
            setCoveragePreview({
                corridor: basketEstimate.corridor,
                rect: basketEstimate.rect,
                showRect: true,
                overview: basketEstimate.overview?.region ?? null,
                mode: 'all',
            })
            ownsPreview.current = true
        } else if (ownsPreview.current) {
            setCoveragePreview(null)
            ownsPreview.current = false
        }
    }, [inBasketView, basketEstimate, setCoveragePreview])
    useEffect(() => () => { if (ownsPreview.current) setCoveragePreview(null) }, [setCoveragePreview])

    const inBasket = useMemo(() => new Set(basket.ids), [basket.ids])
    // Listed rides not yet in the basket — what "add all" would add
    const addableIds = useMemo(
        () => (rides ?? []).map(r => r.id).filter(id => !inBasket.has(id)),
        [rides, inBasket]
    )

    // File-manager selection semantics: plain click = single select,
    // ctrl/cmd-click = toggle one, shift-click = add the range from the last
    // plain-clicked row (the anchor) to this one.
    const anchorId = useRef<string | null>(null)
    const handleItemClick = (id: string, event: React.MouseEvent) => {
        const list = rides ?? []
        if (event.shiftKey && anchorId.current) {
            const a = list.findIndex(r => r.id === anchorId.current)
            const b = list.findIndex(r => r.id === id)
            if (a !== -1 && b !== -1) {
                const range = list.slice(Math.min(a, b), Math.max(a, b) + 1).map(r => r.id)
                onSelect(Array.from(new Set([...selectedIds, ...range])))
                return
            }
        }
        if (event.metaKey || event.ctrlKey) {
            // Toggle one in/out of the selection
            anchorId.current = id
            if (selectedIds.includes(id)) {
                onSelect(selectedIds.filter(sid => sid !== id))
            } else {
                onSelect([...selectedIds, id])
            }
        } else if (selectedIds.length === 1 && selectedIds[0] === id) {
            // Re-clicking the sole selected ride deselects it
            anchorId.current = null
            onSelect([])
        } else {
            // Single select
            anchorId.current = id
            onSelect([id])
        }
    }

    const formatDate = (dateStr: string | null) => {
        if (!dateStr) return ''
        return new Date(dateStr).toLocaleDateString()
    }

    // Whole km from 10 up ("45 km"), one decimal below ("3.2 km")
    const formatDistance = (meters: number | null) => {
        if (!meters) return ''
        const km = meters / 1000
        return km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`
    }

    // h:mm — "4:12"
    const formatHm = (seconds: number) => {
        let h = Math.floor(seconds / 3600)
        let m = Math.round((seconds % 3600) / 60)
        if (m === 60) { h += 1; m = 0 }
        return `${h}:${String(m).padStart(2, '0')}`
    }

    /** "45 km · 4:12 / 3:50" — distance, elapsed, moving (what's available) */
    const formatMeta = (r: { distance_m: number | null, duration_s: number | null, moving_s: number | null }) => {
        const parts: string[] = []
        const dist = formatDistance(r.distance_m)
        if (dist) parts.push(dist)
        if (r.duration_s) {
            parts.push(r.moving_s && Math.round(r.moving_s) < Math.round(r.duration_s)
                ? `${formatHm(r.duration_s)} / ${formatHm(r.moving_s)}`
                : formatHm(r.duration_s))
        }
        return parts.join(' · ')
    }

    if (isLoading && listView === 'tracks') {
        return <div className="loading">Loading...</div>
    }

    return (
        <div className="list-pane">
            <div className="list-header">
                <button
                    className={`list-toggle ${listView === 'tracks' && inViewOnly ? 'active' : ''}`}
                    onClick={() => { setListView('tracks'); setInViewOnly(true) }}
                    title="Tracks in the current map view"
                >
                    <Map size={12} style={{ verticalAlign: -2, marginRight: 3 }} />Map area
                </button>
                <button
                    className={`list-toggle ${listView === 'places' ? 'active' : ''}`}
                    onClick={() => setListView('places')}
                    title="Browse by location — click a folder to select every track in it"
                >
                    <FolderTree size={12} style={{ verticalAlign: -2, marginRight: 3 }} />Places
                </button>
                <button
                    className={`list-toggle ${listView === 'tracks' && !inViewOnly ? 'active' : ''}`}
                    onClick={() => { setListView('tracks'); setInViewOnly(false) }}
                    title="All tracks in the library (newest first)"
                >
                    <List size={12} style={{ verticalAlign: -2, marginRight: 3 }} />Tracks
                </button>
                <button
                    className={`list-toggle basket-chip ${listView === 'basket' ? 'active' : ''}`}
                    onClick={() => setListView('basket')}
                    title="Export basket — tracks collected for export"
                >
                    <Package size={12} style={{ verticalAlign: -2, marginRight: 3 }} />
                    Basket{basket.ids.length > 0 ? ` ${basket.ids.length}` : ''}
                </button>
                <button
                    className={`list-toggle ${listView === 'packs' ? 'active' : ''}`}
                    onClick={() => setListView('packs')}
                    title="Packs — saved, refreshable share bundles"
                >
                    <Boxes size={12} style={{ verticalAlign: -2, marginRight: 3 }} />
                    Packs
                </button>
                <button
                    className="list-toggle"
                    onClick={() => setImportOpen(true)}
                    title="Import external GPX/FIT files with a source tag (wikiloc, DSRA, a mate…)"
                    style={{ marginLeft: 'auto', padding: '6px 8px' }}
                >
                    <Upload size={12} style={{ verticalAlign: -2 }} />
                </button>
            </div>
            {importOpen && <ImportDialog onClose={() => setImportOpen(false)} />}
            {listView === 'tracks' && (
                <>
                    <div className="list-search">
                        <Search size={13} className="list-search-icon" />
                        <input
                            type="text"
                            className="list-search-input"
                            placeholder="Search name or place…"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            title="Find tracks by name, or by a suburb / LGA / region / state they pass through"
                        />
                        {search && (
                            <button
                                className="list-search-clear"
                                onClick={() => setSearch('')}
                                title="Clear search"
                            >
                                <X size={12} />
                            </button>
                        )}
                    </div>
                </>
            )}
            {listView !== 'basket' && listView !== 'packs' && (
                <div className="list-dates">
                    <input
                        type="date"
                        value={dateFrom}
                        onChange={e => setDateFrom(e.target.value)}
                        title="From date"
                    />
                    <span>→</span>
                    <input
                        type="date"
                        value={dateTo}
                        onChange={e => setDateTo(e.target.value)}
                        title="To date"
                    />
                    {(dateFrom || dateTo) && (
                        <button
                            className="list-toggle"
                            onClick={() => { setDateFrom(''); setDateTo('') }}
                            title="Clear date range"
                        >
                            <X size={12} style={{ verticalAlign: -2 }} />
                        </button>
                    )}
                </div>
            )}
            {listView === 'packs' && (
                <div className="list-count">
                    <span>
                        {packList
                            ? `${packList.packs.length} pack${packList.packs.length === 1 ? '' : 's'}`
                            : 'Loading…'}
                    </span>
                    {stalePacks.length > 0 && (
                        <button
                            className="list-toggle active"
                            disabled={refreshingAll || refreshingId !== null}
                            onClick={refreshAll}
                            title={`Re-publish the ${stalePacks.length} changed pack${stalePacks.length === 1 ? '' : 's'}, one at a time`}
                        >
                            <RefreshCw size={12} className={refreshingAll ? 'places-spin' : ''} style={{ verticalAlign: -2, marginRight: 3 }} />
                            Refresh all ({stalePacks.length})
                        </button>
                    )}
                </div>
            )}
            {listView !== 'places' && listView !== 'packs' && (
                <div className="list-count">
                    <span>
                        {rides ? `${rides.length} track${rides.length === 1 ? '' : 's'}${listView === 'basket' ? ' in basket'
                            : settings.focusMode && selectedIds.length > 0 ? ' selected'
                                : searching ? ' matching' : inViewOnly ? ' in view' : ''}` : ''}
                    </span>
                    {listView === 'tracks' && (
                        <span style={{ display: 'flex', gap: 4 }}>
                            <button
                                className={`list-toggle ${settings.focusMode ? 'active' : ''}`}
                                onClick={() => settings.setFocusMode(!settings.focusMode)}
                                title="Only show selected tracks — in the list and on the map. With nothing selected, everything shows."
                            >
                                <Crosshair size={12} style={{ verticalAlign: -2, marginRight: 3 }} />
                                Only selected
                            </button>
                            {(rides?.length ?? 0) > 0 && (
                                <button
                                    className="list-toggle"
                                    onClick={() => onSelect((rides ?? []).map(r => r.id))}
                                    title={`Select all ${rides?.length} listed tracks`}
                                >
                                    <ListChecks size={12} style={{ verticalAlign: -2, marginRight: 3 }} />
                                    Select all
                                </button>
                            )}
                            {addableIds.length > 0 && (
                                <button
                                    className="list-toggle"
                                    onClick={() => basket.add(addableIds)}
                                    title={`Add all ${addableIds.length} listed tracks to the export basket`}
                                >
                                    <PackagePlus size={12} style={{ verticalAlign: -2, marginRight: 3 }} />
                                    Add all
                                </button>
                            )}
                        </span>
                    )}
                    {listView === 'basket' && basket.ids.length > 0 && (
                        <span style={{ display: 'flex', gap: 4 }}>
                            <button
                                className="list-toggle"
                                onClick={() => onSelect(basket.ids)}
                                title="Select every track in the basket"
                            >
                                <ListChecks size={12} style={{ verticalAlign: -2, marginRight: 3 }} />
                                Select all
                            </button>
                            <button
                                className="list-toggle"
                                onClick={() => basket.clear()}
                                title="Empty the export basket"
                            >
                                <Trash2 size={12} style={{ verticalAlign: -2, marginRight: 3 }} />
                                Clear
                            </button>
                            <button
                                className="list-toggle"
                                onClick={saveBasketAsPack}
                                title="Save the basket as a named pack — publishable as a refreshable share link"
                            >
                                <Boxes size={12} style={{ verticalAlign: -2, marginRight: 3 }} />
                                Save as pack…
                            </button>
                            <button
                                className="list-toggle active"
                                onClick={onExport}
                                title="Export the basket to a device folder or a zip download"
                            >
                                Export…
                            </button>
                        </span>
                    )}
                </div>
            )}
            {/* What the basket's outlines on the map mean. Each coverage shape
                is shared by several export layers, so the legend names them. */}
            {inBasketView && basketEstimate && (
                <div className="coverage-legend">
                    {([
                        ['corridor', 'Corridor', 'heatmap, Strava, hillshade'],
                        ['rect', 'Box', 'satellite'],
                        ['region', 'Region', 'zoomed-out basemap'],
                    ] as const).map(([kind, label, layers]) => {
                        const [r, g, b] = COVERAGE_SHAPE_COLORS[kind]
                        return (
                            <span key={kind} title={`${label} coverage — used by ${layers}`}>
                                <i style={{ background: `rgb(${r},${g},${b})` }} />
                                {label} <em>{layers}</em>
                            </span>
                        )
                    })}
                </div>
            )}

            {listView === 'packs' ? (
                <div className="list-items">
                    {packList && packList.packs.length === 0 && (
                        <div className="empty-state" style={{ padding: 16 }}>
                            <p>No packs yet</p>
                            <p style={{ fontSize: 12, marginTop: 8 }}>
                                Fill the basket with tracks for a trip, then "Save as pack…" —
                                packs publish as live links you can refresh anytime.
                            </p>
                        </div>
                    )}
                    {packList?.packs.map(p => (
                        <div
                            key={p.id}
                            className={`list-item ${selectedPackId === p.id ? 'selected' : ''}`}
                            onClick={() => setSelectedPackId(selectedPackId === p.id ? null : p.id)}
                        >
                            <button
                                className={`pack-refresh ${p.stale ? 'stale' : ''} ${packErrors[p.id] ? 'failed' : ''}`}
                                disabled={!p.published_at || refreshingId !== null || refreshingAll}
                                onClick={(e) => { e.stopPropagation(); refreshPack(p.id) }}
                                title={packErrors[p.id]
                                    ? `Refresh failed: ${packErrors[p.id]}`
                                    : !p.published_at
                                        ? 'Draft — publish from the pack panel first'
                                        : p.stale
                                            ? 'Changed since last publish — click to refresh the shared link'
                                            : 'Up to date — click to re-publish anyway'}
                            >
                                <RefreshCw size={13} className={refreshingId === p.id ? 'places-spin' : ''} />
                                {p.stale && refreshingId !== p.id && <span className="pack-stale-dot" />}
                            </button>
                            <div className="list-item-content">
                                <div className="list-item-name">{p.name}</div>
                                <div className="list-item-meta">
                                    {p.ride_count} track{p.ride_count === 1 ? '' : 's'}
                                    {p.published_bytes ? ` · ${p.published_bytes > 1024 * 1024 ? `${(p.published_bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(p.published_bytes / 1024)} KB`}` : ''}
                                    {p.published_at ? ` · ${new Date(p.published_at).toLocaleDateString()}` : ' · draft'}
                                </div>
                            </div>
                            {p.share_url && (
                                <button
                                    className="list-item-basket"
                                    onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(p.share_url!) }}
                                    title={`Copy the live DingoNav link\n${p.share_url}`}
                                >
                                    <Link2 size={14} />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            ) : listView === 'places' ? (
                <div className="list-items">
                    {metaLoading
                        ? <div className="loading">Loading places…</div>
                        : <PlacesTree rides={placesRides} selectedIds={selectedIds} onSelect={onSelect} onFlyTo={onFlyTo} />}
                </div>
            ) : (
                <div className="list-items">
                    {listView === 'basket' && basket.ids.length === 0 && (
                        <div className="empty-state" style={{ padding: 16 }}>
                            <p>Basket is empty</p>
                            <p style={{ fontSize: 12, marginTop: 8 }}>
                                Add tracks from the list, a selection, or a lasso — then export them all at once.
                            </p>
                        </div>
                    )}
                    {rides?.map(ride => (
                        <div
                            key={ride.id}
                            className={`list-item ${selectedIds.includes(ride.id) ? 'selected' : ''}`}
                            onClick={(e) => handleItemClick(ride.id, e)}
                            onMouseEnter={() => onHover(ride.id)}
                            onMouseLeave={() => onHover(null)}
                        >
                            <div className="list-item-icon"><Bike size={16} /></div>
                            <div className="list-item-content">
                                <div className="list-item-name">
                                    {ride.name || formatDate(ride.started_at)}
                                </div>
                                <div className="list-item-meta">
                                    {formatMeta(ride)}
                                </div>
                            </div>
                            <button
                                className={`list-item-basket ${inBasket.has(ride.id) ? 'in-basket' : ''}`}
                                onClick={(e) => { e.stopPropagation(); basket.toggle(ride.id) }}
                                title={inBasket.has(ride.id) ? 'Remove from export basket' : 'Add to export basket'}
                            >
                                {inBasket.has(ride.id) ? <PackageMinus size={14} /> : <PackagePlus size={14} />}
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
