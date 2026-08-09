import { useEffect, useMemo, useRef, useState } from 'react'
import { Bike, Boxes, Crosshair, FolderTree, Link2, List, ListChecks, Map, Package, PackageMinus, PackagePlus, RefreshCw, Route, Search, Trash2, Upload, X } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { ImportDialog } from '../Import/ImportDialog'
import {
    useRidesByIds, useAllRideMeta, useItemsQuery, usePacks, createPack, publishPack,
    useCoverageEstimate, type Bounds, type ItemSummary, type LayerCoverage, type RideSummary,
} from '../../api/hooks'
import { useSettings, useBasket, useUiState, rideMatchesFilters, COVERAGE_SHAPE_COLORS } from '../../store'
import { PillRow } from '../Filters/PillRow'

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
    // Pills + search drive the unified item query (tracks, routes and packs
    // in one list). Search runs server-side over the whole library — any
    // active search bypasses the viewport restriction so a name/place lookup
    // finds items anywhere.
    const settings = useSettings()
    const { pills, searchPills, addSearchPill } = settings
    const searchAll = useMemo(
        () => (searching ? [...searchPills, search.trim()] : searchPills),
        [searchPills, search, searching],
    )
    const anySearch = searchAll.length > 0
    const pillsActive = anySearch || pills.some(p => p.values.length > 0)
    const { data: viewItems, isLoading } = useItemsQuery(
        pills, searchAll, inViewOnly && !anySearch ? bounds : undefined,
    )
    // Unbounded twin of the same query: the map dims non-matching tracks
    // library-wide, so the matched-id set must not shrink to the viewport.
    // With "in view" off (or a search active) this is the same query and
    // react-query serves it from cache.
    const { data: allItems } = useItemsQuery(pills, searchAll, undefined)
    // Basket view shows the basket's contents regardless of viewport/search —
    // fetched by id so rides older than the list cap still appear.
    const { data: basketRides } = useRidesByIds(listView === 'basket' ? basket.ids : [])
    // Places view filters the whole library's metadata client-side, so folder
    // counts share the exact filter semantics of the list and map.
    const { data: allMeta, isLoading: metaLoading } = useAllRideMeta(listView === 'places')
    const { dateFrom, dateTo, setDateFrom, setDateTo } = settings
    // The pill-filtered set, with the toolbar's client-side filters (modes,
    // shape, grade, dates, range sliders) applied on top for ride rows —
    // exactly the set the map draws at full strength. Packs pass through
    // (they have no mode/shape/grade).
    const items = useMemo(
        () => (viewItems ?? []).filter(it =>
            it.item_type === 'pack'
            || rideMatchesFilters(it as unknown as RideSummary, settings)),
        [viewItems, settings],
    )
    // Share the matched ids with the map: while any pill is active, tracks
    // outside the set dim (the same treatment as search matches today).
    // Selection never changes this — it only highlights.
    const { setPillMatchedIds } = useUiState()
    useEffect(() => {
        if (!pillsActive) { setPillMatchedIds(null); return }
        setPillMatchedIds(new Set(
            (allItems ?? [])
                .filter(it => it.item_type !== 'pack'
                    && rideMatchesFilters(it as unknown as RideSummary, settings))
                .map(it => it.id),
        ))
    }, [pillsActive, allItems, settings, setPillMatchedIds])
    useEffect(() => () => setPillMatchedIds(null), [setPillMatchedIds])
    // Basket view keeps the plain ride list shape.
    const rides = useMemo(
        () => (listView === 'basket' ? basketRides : undefined),
        [listView, basketRides],
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
    // The unified list's ride rows (tracks + routes, never packs) — the set
    // "Select all" and "Add all" operate on.
    const rideItems = useMemo(() => items.filter(it => it.item_type !== 'pack'), [items])
    // Listed rides not yet in the basket — what "add all" would add
    const addableIds = useMemo(
        () => rideItems.map(r => r.id).filter(id => !inBasket.has(id)),
        [rideItems, inBasket]
    )

    // Selecting a track (usually a map click) scrolls the list just enough to
    // bring its row into view — the list itself never refilters or reorders on
    // selection. 'nearest' makes an already-visible row (a list click) a no-op.
    // The pending id survives until the row exists, so a selection that lands
    // before its refetch still gets scrolled to when the data arrives.
    const listItemsRef = useRef<HTMLDivElement>(null)
    const prevSelectedRef = useRef<string[]>([])
    const pendingScrollId = useRef<string | null>(null)
    useEffect(() => {
        const added = selectedIds.filter(id => !prevSelectedRef.current.includes(id))
        prevSelectedRef.current = selectedIds
        if (added.length > 0) pendingScrollId.current = added[added.length - 1]
        const target = pendingScrollId.current
        if (!target) return
        if (!selectedIds.includes(target)) { pendingScrollId.current = null; return }
        const el = listItemsRef.current?.querySelector(`[data-ride-id="${CSS.escape(target)}"]`)
        if (el) {
            el.scrollIntoView({ block: 'nearest' })
            pendingScrollId.current = null
        }
    }, [selectedIds, items, rides])

    // Click-to-toggle selection: first click selects, second deselects —
    // easy multi-select with no modifier keys. Selection drives highlight,
    // the detail pane and map emphasis only; the list never refilters or
    // reorders on selection (only pills change the list).
    const handleItemClick = (id: string) => {
        // A ride click leaves any open pack detail — the right pane shows
        // the selection again.
        setSelectedPackId(null)
        onSelect(selectedIds.includes(id)
            ? selectedIds.filter(sid => sid !== id)
            : [...selectedIds, id])
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
                    title="Import external GPX/FIT files, or a ZIP export (Garmin/Strava), with a source tag (wikiloc, DSRA, a mate…)"
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
                            onKeyDown={e => {
                                // Enter commits the query as a search pill so
                                // several searches can AND together.
                                if (e.key === 'Enter' && search.trim()) {
                                    addSearchPill(search)
                                    setSearch('')
                                }
                            }}
                            title="Find items by name, or by a suburb / LGA / region / state they pass through. Enter keeps the query as a pill."
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
                    <PillRow />
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
                        {listView === 'basket'
                            ? (rides ? `${rides.length} track${rides.length === 1 ? '' : 's'} in basket` : '')
                            : `${items.length} item${items.length === 1 ? '' : 's'}${anySearch ? ' matching'
                                : pillsActive ? ' filtered' : inViewOnly ? ' in view' : ''}`}
                    </span>
                    {listView === 'tracks' && (
                        <span style={{ display: 'flex', gap: 4 }}>
                            <button
                                className={`list-toggle ${settings.focusMode ? 'active' : ''}`}
                                onClick={() => settings.setFocusMode(!settings.focusMode)}
                                title="Only show selected tracks on the map. With nothing selected, everything shows."
                            >
                                <Crosshair size={12} style={{ verticalAlign: -2, marginRight: 3 }} />
                                Only selected
                            </button>
                            {rideItems.length > 0 && (
                                <button
                                    className="list-toggle"
                                    onClick={() => onSelect(rideItems.map(r => r.id))}
                                    title={`Select all ${rideItems.length} listed tracks`}
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
                <div className="list-items" ref={listItemsRef}>
                    {listView === 'basket' && basket.ids.length === 0 && (
                        <div className="empty-state" style={{ padding: 16 }}>
                            <p>Basket is empty</p>
                            <p style={{ fontSize: 12, marginTop: 8 }}>
                                Add tracks from the list, a selection, or a lasso — then export them all at once.
                            </p>
                        </div>
                    )}
                    {(listView === 'basket'
                        // Basket rows keep the plain ride shape; the tracks
                        // view interleaves tracks, routes and packs.
                        ? (rides ?? []).map(r => ({ ...r, item_type: 'track' }) as unknown as ItemSummary)
                        : items
                    ).map(item => (
                        <div
                            key={item.id}
                            data-ride-id={item.id}
                            className={`list-item ${item.item_type === 'pack'
                                ? (selectedPackId === item.id ? 'selected' : '')
                                : (selectedIds.includes(item.id) ? 'selected' : '')}`}
                            onClick={() => {
                                // Packs open their detail pane; ride rows
                                // toggle in and out of the selection.
                                if (item.item_type === 'pack') {
                                    setSelectedPackId(selectedPackId === item.id ? null : item.id)
                                } else {
                                    handleItemClick(item.id)
                                }
                            }}
                            onMouseEnter={() => item.item_type !== 'pack' && onHover(item.id)}
                            onMouseLeave={() => item.item_type !== 'pack' && onHover(null)}
                        >
                            <div className={`list-item-icon ${item.item_type}`}>
                                {item.item_type === 'pack' ? <Boxes size={16} />
                                    : item.item_type === 'route' ? <Route size={16} />
                                        : <Bike size={16} />}
                            </div>
                            <div className="list-item-content">
                                <div className="list-item-name">
                                    {item.name || formatDate(item.started_at)}
                                </div>
                                <div className="list-item-meta">
                                    {item.item_type === 'pack'
                                        ? `pack · ${item.ride_count ?? 0} track${item.ride_count === 1 ? '' : 's'}${item.published_at ? '' : ' · draft'}`
                                        : formatMeta({
                                            distance_m: item.distance_m ?? null,
                                            duration_s: item.duration_s ?? null,
                                            moving_s: item.moving_s ?? null,
                                        })}
                                </div>
                            </div>
                            {item.item_type !== 'pack' && (
                                <button
                                    className={`list-item-basket ${inBasket.has(item.id) ? 'in-basket' : ''}`}
                                    onClick={(e) => { e.stopPropagation(); basket.toggle(item.id) }}
                                    title={inBasket.has(item.id) ? 'Remove from export basket' : 'Add to export basket'}
                                >
                                    {inBasket.has(item.id) ? <PackageMinus size={14} /> : <PackagePlus size={14} />}
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
