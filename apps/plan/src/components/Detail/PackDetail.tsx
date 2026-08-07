import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
    AlertTriangle, ArrowUp, Check, ClipboardPaste, Construction, CornerUpLeft, CornerUpRight,
    Copy, Eraser, Eye, Fence, Fuel, GripVertical, Link2, Map as MapIcon, PackagePlus, RefreshCw,
    Tent, Trash2, Upload, UtensilsCrossed, Waves, X,
} from 'lucide-react'
import {
    usePack, useRidesByIds, updatePack, deletePack, publishPack, publishPlan, useCoverageEstimate,
    usePackMarks, checkPackMarks, pastePackMarks, setMarkStatus, useDingodirtStatus,
    type LayerCoverage, type PackMark, type PackRideEntry,
} from '../../api/hooks'
import { useBasket, useUiState, type PackPreview } from '../../store'
import { rectPolygon, type MaskShape } from '../Map/maskGeometry'

/** Icon + label for one mark row. Removal edits show the eraser regardless
 *  of kind — the edit is about deleting a cue at that spot. */
function markIconLabel(m: PackMark): [React.ReactNode, string] {
    const sz = { size: 14 }
    if (m.op === 'remove') return [<Eraser {...sz} />, 'Removed a turn']
    switch (m.kind) {
        case 'danger': return [<AlertTriangle {...sz} />, 'Danger !!!']
        case 'obstacle': return [<Construction {...sz} />, 'Obstacle']
        case 'gate': return [<Fence {...sz} />, 'Gate']
        case 'creek': return [<Waves {...sz} />, 'Creek crossing']
        case 'fuel': return [<Fuel {...sz} />, 'Fuel']
        case 'food': return [<UtensilsCrossed {...sz} />, 'Pub / food']
        case 'lookout': return [<Eye {...sz} />, 'Lookout']
        case 'camp': return [<Tent {...sz} />, 'Camp']
        default: return m.dir === 'L' ? [<CornerUpLeft {...sz} />, 'Turn left']
            : m.dir === 'R' ? [<CornerUpRight {...sz} />, 'Turn right']
                : m.dir === 'S' ? [<ArrowUp {...sz} />, 'Straight ahead']
                    : [<CornerUpRight {...sz} />, 'Turn']
    }
}

const MARK_ROW_COLORS: Record<string, string> = {
    turn: '#6db1ff', danger: '#f0c24b', obstacle: '#ef9f27', gate: '#b4b2a9', creek: '#5dcaa5',
    fuel: '#85b7eb', food: '#ed93b1', lookout: '#afa9ec', camp: '#97c459', remove: '#e24b4a',
}

const formatBytes = (b: number) =>
    b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`

/** Right-pane editor for the selected pack: name/description, the ordered
 *  track list (drag to reorder; first = DingoNav's default track), layer
 *  recipe with live size estimates, and the publish/refresh/export actions. */
export function PackDetail({ packId, onSelect, onFlyTo, onExport }: {
    packId: string
    /** Mirror the pack's tracks onto the map (main selection) */
    onSelect: (ids: string[]) => void
    onFlyTo?: (bbox: [number, number, number, number]) => void
    /** Open the export dialog preloaded with this pack's rides + name */
    onExport: (rideIds: string[], name: string) => void
}) {
    const queryClient = useQueryClient()
    const { data: pack, error: loadError } = usePack(packId)
    const basket = useBasket()
    const { setSelectedPackId, setCoveragePreview, setMarkPreview } = useUiState()

    const rideIds = useMemo(() => (pack?.rides ?? []).map(r => r.id), [pack?.rides])
    const rideIdsKey = rideIds.join(',')

    // Selecting a pack shows it on the map: select its rides and fly to their
    // combined bbox (geometry comes from the standard by-ids rides fetch).
    const { data: mapRides } = useRidesByIds(rideIds)
    const flownFor = useRef<string | null>(null)
    useEffect(() => {
        onSelect(rideIds)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [packId, rideIdsKey])
    useEffect(() => {
        if (!onFlyTo || !mapRides?.length || flownFor.current === packId) return
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (const r of mapRides) {
            for (const [lon, lat] of r.geometry?.coordinates ?? []) {
                if (lon < x0) x0 = lon
                if (lat < y0) y0 = lat
                if (lon > x1) x1 = lon
                if (lat > y1) y1 = lat
            }
        }
        if (x0 <= x1 && y0 <= y1) {
            flownFor.current = packId
            onFlyTo([x0, y0, x1, y1])
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapRides, packId])

    // Name / description edit locally, save on blur.
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    useEffect(() => {
        if (pack) { setName(pack.name); setDescription(pack.description) }
    }, [pack?.id, pack?.name, pack?.description]) // eslint-disable-line react-hooks/exhaustive-deps

    const [error, setError] = useState<string | null>(null)
    const invalidate = () => queryClient.invalidateQueries({ queryKey: ['packs'] })
    const patch = async (p: Parameters<typeof updatePack>[1]) => {
        setError(null)
        try { await updatePack(packId, p); invalidate() }
        catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    }

    // Drag-to-reorder: track the dragged row, drop recomputes the id array.
    const [dragIdx, setDragIdx] = useState<number | null>(null)
    const [overIdx, setOverIdx] = useState<number | null>(null)
    const handleDrop = () => {
        if (dragIdx === null || overIdx === null || dragIdx === overIdx) {
            setDragIdx(null); setOverIdx(null); return
        }
        const ids = [...rideIds]
        const [moved] = ids.splice(dragIdx, 1)
        ids.splice(overIdx, 0, moved)
        setDragIdx(null); setOverIdx(null)
        patch({ ride_ids: ids })
    }

    const removeRide = (id: string) => patch({ ride_ids: rideIds.filter(r => r !== id) })
    const addFromBasket = () => {
        const add = basket.ids.filter(id => !rideIds.includes(id))
        if (add.length > 0) patch({ ride_ids: [...rideIds, ...add] })
    }
    const addable = basket.ids.filter(id => !rideIds.includes(id)).length

    // Live per-layer size estimate, debounced (same source as the export
    // dialog). Also feeds the map's coverage preview: the estimate response
    // carries the corridor polygon + rect bbox the bundle would cover.
    const coverage: LayerCoverage = useMemo(() => pack?.coverage ?? {}, [pack?.coverage])
    // Rect outline only when a layer that's actually included uses box mode.
    const anyRect = !!pack && (
        (pack.include_heatmap && coverage.heatmap === 'rect')
        || (pack.include_basemap && coverage.basemap === 'rect')
        || (pack.include_satellite && coverage.satellite === 'rect')
        || (pack.include_strava && coverage.strava === 'rect')
        || (pack.include_hillshade && coverage.hillshade === 'rect')
    )
    const { estimate } = useCoverageEstimate(rideIds, coverage, !!pack)
    useEffect(() => {
        if (!estimate) { setCoveragePreview(null); return }
        setCoveragePreview({
            corridor: estimate.corridor,
            rect: estimate.rect,
            showRect: anyRect,
            overview: estimate.overview?.region ?? null,
        })
    }, [estimate, anyRect, setCoveragePreview])
    // Leaving the pack view drops the preview outlines from the map.
    useEffect(() => () => setCoveragePreview(null), [setCoveragePreview])

    // "Pack layers only": render the map as the bundle will look offline —
    // only the layers the pack carries, each masked to its coverage. Built from
    // the same estimate the size readouts use, so the preview can't disagree
    // with the numbers next to it.
    const { packPreview, setPackPreview } = useUiState()
    const previewOn = packPreview?.packId === packId
    const buildPreview = (): PackPreview | null => {
        if (!pack || !estimate?.corridor) return null
        const shapeFor = (c: LayerCoverage[keyof LayerCoverage]): MaskShape | null =>
            (c === 'rect'
                ? (estimate.rect ? rectPolygon(estimate.rect) : null)
                : estimate.corridor)
        // The lower band (basemap / satellite / hillshade) shares one mask, so
        // mixed modes resolve to the widest included one. rect ⊇ corridor, so
        // that's a pick, not a union — no client-side boolean geometry.
        const lowerLayers = [
            pack.include_basemap && coverage.basemap,
            pack.include_satellite && coverage.satellite,
            pack.include_hillshade && coverage.hillshade,
        ].filter(v => v !== false)
        const lower = lowerLayers.length === 0
            ? null // nothing baked down here — mask the ground entirely
            : shapeFor(lowerLayers.some(c => c === 'rect') ? 'rect' : 'corridor')
        const heat: MaskShape[] = []
        if (pack.include_heatmap) {
            const base = shapeFor(coverage.heatmap)
            if (base) heat.push(base)
            const ov = coverage.heat_overview ?? 'local'
            if (ov === 'local' && estimate.heat_local) heat.push(estimate.heat_local)
            if (ov === 'region' && estimate.overview?.region) heat.push(estimate.overview.region)
        }
        return {
            packId,
            layers: {
                myRides: pack.include_tracks,
                // A bundle carries only the pack's own tracks — there is no
                // offline "other rides" layer to preview.
                otherRides: false,
                myHeatmap: pack.include_heatmap,
                stravaRide: pack.include_strava,
                stravaHike: pack.include_strava,
                photos: false,
                areas: false,
                hillshade: pack.include_hillshade,
            },
            baseStyle: pack.include_satellite && !pack.include_basemap ? 'satellite'
                // Not 'outdoor' — its baked-in hillshading would double up with
                // the hillshade layer.
                : pack.include_basemap && !pack.include_satellite ? 'topo'
                    : null,
            clip: {
                lower,
                stravaDetail: pack.include_strava ? shapeFor(coverage.strava) : null,
                stravaOverview: estimate.overview?.region ?? null,
                heat,
            },
        }
    }
    // Clear on unmount, on a pack switch, and whenever the estimate loses its
    // corridor (an emptied pack) — a stale mask would hide a map it no longer
    // describes.
    useEffect(() => {
        if (previewOn && !estimate?.corridor) setPackPreview(null)
    }, [previewOn, estimate?.corridor, setPackPreview])
    useEffect(() => () => setPackPreview(null), [packId, setPackPreview])

    // Mark edits (DingoNav → review queue). Only meaningful once published —
    // before that there's no ride channel to harvest.
    const { data: marksData, refetch: refetchMarks } = usePackMarks(packId, !!pack?.published_at)
    const marks = marksData?.marks ?? []
    const pendingMarks = marks.filter(m => m.status === 'pending')
    const [checkingMarks, setCheckingMarks] = useState(false)
    const [marksNote, setMarksNote] = useState<string | null>(null)
    const [showPaste, setShowPaste] = useState(false)
    const [pasteText, setPasteText] = useState('')
    const [focusMarkId, setFocusMarkId] = useState<string | null>(null)

    // Mirror the review queue onto the map (pending faded, accepted full);
    // clear it when leaving the pack view.
    const marksKey = marks.map(m => `${m.id}:${m.status}`).join(',')
    useEffect(() => {
        setMarkPreview(marks.length === 0 ? null : {
            marks: marks.map(m => ({ id: m.id, lat: m.lat, lon: m.lon, kind: m.kind, op: m.op, status: m.status })),
            focusId: focusMarkId,
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [marksKey, focusMarkId])
    useEffect(() => () => setMarkPreview(null), [setMarkPreview])

    const handleCheckMarks = async () => {
        setCheckingMarks(true)
        setMarksNote(null)
        setError(null)
        try {
            const res = await checkPackMarks(packId)
            setMarksNote(res.new === 0 ? 'No new edits on the ride channel' : `${res.new} new edit${res.new === 1 ? '' : 's'}`)
            refetchMarks()
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setCheckingMarks(false)
        }
    }

    const handlePasteMarks = async () => {
        setError(null)
        try {
            const res = await pastePackMarks(packId, pasteText)
            setMarksNote(res.new === 0 ? 'Nothing new in that blob' : `${res.new} new edit${res.new === 1 ? '' : 's'}`)
            setPasteText('')
            setShowPaste(false)
            refetchMarks()
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        }
    }

    const handleMarkStatus = async (markId: string, status: 'accepted' | 'rejected') => {
        setError(null)
        try {
            await setMarkStatus(packId, markId, status)
            refetchMarks()
            invalidate() // accept/reject bumps the stale flag
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        }
    }

    // Clicking a row zooms the map to the mark's spot.
    const focusMark = (m: PackMark) => {
        setFocusMarkId(m.id)
        onFlyTo?.([m.lon - 0.003, m.lat - 0.003, m.lon + 0.003, m.lat + 0.003])
    }

    const [publishing, setPublishing] = useState(false)
    const [published, setPublished] = useState<{ share_url: string, bytes: number, replaced: boolean, revision: number, visibility: string } | null>(null)
    // Publish confirm popover: pick Link only vs Public, then go. Defaults to
    // the pack's current state (public/pending → Public) on re-publish.
    const [confirmOpen, setConfirmOpen] = useState(false)
    const [pubVisibility, setPubVisibility] = useState<'unlisted' | 'public'>('unlisted')
    const { data: dingodirt } = useDingodirtStatus()
    const openConfirm = () => {
        setPubVisibility(pack?.visibility === 'public' || pack?.visibility === 'pending' ? 'public' : 'unlisted')
        setError(null)
        setConfirmOpen(o => !o)
    }
    const handlePublish = async () => {
        setPublishing(true)
        setError(null)
        setPublished(null)
        try {
            const res = await publishPack(packId, pubVisibility)
            setPublished({
                share_url: res.share_url, bytes: res.bytes, replaced: res.replaced,
                revision: res.revision, visibility: res.visibility,
            })
            setConfirmOpen(false)
            invalidate()
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setPublishing(false)
        }
    }

    // Planning page: a tiles-free, tracks-only share the group picks a route
    // from. Separate site pack; first publish defaults to unlisted.
    const [planPublishing, setPlanPublishing] = useState(false)
    const [planNote, setPlanNote] = useState<string | null>(null)
    const handlePublishPlan = async () => {
        setPlanPublishing(true)
        setError(null)
        setPlanNote(null)
        try {
            const res = await publishPlan(packId)
            setPlanNote(
                `Plan ${res.replaced ? 'refreshed' : 'published'} — ${res.tracks} tracks, ${formatBytes(res.bytes)}.`,
            )
            invalidate()
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setPlanPublishing(false)
        }
    }

    const handleDelete = async () => {
        const msg = pack?.published_at
            ? `Delete pack "${pack.name}" and its published share? The ?b= link you handed out will stop working.`
            : `Delete pack "${pack?.name}"?`
        if (!window.confirm(msg)) return
        setError(null)
        try {
            await deletePack(packId, true)
            setSelectedPackId(null)
            invalidate()
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        }
    }

    if (loadError) return <div className="empty-state" style={{ padding: 16 }}>{String(loadError)}</div>
    if (!pack) return <div className="loading">Loading pack…</div>

    const sizeLabel = (l?: { bytes: number, capped: boolean }) =>
        estimate && l ? <span className="export-layer-size">~{formatBytes(l.bytes)}{l.capped ? '+' : ''}</span> : null

    // Corridor-vs-box shape picker for one layer (shown while it's checked).
    const covToggle = (layer: keyof LayerCoverage) => {
        const mode = coverage[layer] ?? 'corridor'
        const pick = (m: 'corridor' | 'rect') => (e: React.MouseEvent) => {
            e.preventDefault()
            e.stopPropagation()
            if (m !== mode) patch({ coverage: { ...coverage, [layer]: m } })
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

    const layerCheck = (key: 'include_tracks' | 'include_heatmap' | 'include_satellite' | 'include_basemap' | 'include_hillshade' | 'include_strava',
        label: string, est?: { bytes: number, capped: boolean }, cov?: keyof LayerCoverage) => (
        <label className="export-check">
            <input type="checkbox" checked={pack[key]} onChange={e => patch({ [key]: e.target.checked })} />
            {label}
            {cov && pack[key] ? covToggle(cov) : null}
            {sizeLabel(est)}
        </label>
    )

    const shareUrl = published?.share_url ?? pack.share_url

    return (
        <div className="pack-detail">
            <div className="pack-detail-header">
                <input
                    className="export-input pack-name-input"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onBlur={() => { if (name.trim() && name !== pack.name) patch({ name: name.trim() }) }}
                    title="Pack name — renaming a published pack updates it on dingodirt.com (the share link keeps working)"
                />
                <button className="export-btn" onClick={handleDelete} title="Delete this pack (and its published share)">
                    <Trash2 size={14} />
                </button>
            </div>
            <textarea
                className="export-input pack-desc-input"
                placeholder="Notes for whoever opens this pack — start point, water, hazards…"
                value={description}
                onChange={e => setDescription(e.target.value)}
                onBlur={() => { if (description !== pack.description) patch({ description }) }}
                rows={2}
            />

            {shareUrl && (
                <div className="pack-share-row">
                    <Link2 size={13} style={{ flexShrink: 0 }} />
                    <input className="export-input" readOnly value={shareUrl} onFocus={e => e.target.select()} />
                    <button
                        className="export-btn"
                        title="Copy the live DingoNav link — refreshing the pack updates it in place"
                        onClick={() => navigator.clipboard?.writeText(shareUrl)}
                    ><Copy size={13} /></button>
                </div>
            )}
            {pack.plan_url && (
                <div className="pack-share-row">
                    <MapIcon size={13} style={{ flexShrink: 0 }} />
                    <input className="export-input" readOnly value={pack.plan_url} onFocus={e => e.target.select()} />
                    <button
                        className="export-btn"
                        title="Copy the planning-page link — mates pick tracks on this map in their browser"
                        onClick={() => navigator.clipboard?.writeText(pack.plan_url!)}
                    ><Copy size={13} /></button>
                </div>
            )}
            {planNote && <div className="export-done">{planNote}</div>}
            {published && (
                <div className="export-done">
                    {published.replaced ? 'Refreshed' : 'Published'} — v{published.revision}, {formatBytes(published.bytes)}.
                    {published.visibility === 'pending'
                        ? ' Public listing is awaiting review — the link works now.'
                        : published.visibility === 'public'
                            ? ' Listed publicly on dingodirt.com.'
                            : ' Anyone with the link can open it.'}
                </div>
            )}
            {!published && pack.published_at && pack.visibility && (
                <div className="export-hint">
                    {pack.visibility === 'public' ? 'Public — listed on dingodirt.com'
                        : pack.visibility === 'pending' ? 'Public requested — awaiting review (link works now)'
                            : pack.visibility === 'unlisted' ? 'Link only — not listed on dingodirt.com'
                                : 'Private on dingodirt.com — the ?b= link is disabled'}
                    {pack.file_url && (
                        <> · <a href={pack.file_url} target="_blank" rel="noreferrer">view on dingodirt.com</a></>
                    )}
                </div>
            )}
            {pack.stale && pack.published_at && !published && (
                <div className="export-warning">
                    Changed since last publish — refresh to update the shared link.
                </div>
            )}

            {pack.published_at && (
                <div className="pack-marks">
                    <div className="pack-marks-header">
                        <span className="export-label" style={{ margin: 0 }}>
                            Mark edits{pack.ride_name ? ` — ${pack.ride_name}` : ''}
                        </span>
                        <button
                            className="list-toggle"
                            disabled={checkingMarks}
                            onClick={handleCheckMarks}
                            title="Poll the ride channel for edits riders have made in DingoNav"
                        >
                            <RefreshCw size={11} className={checkingMarks ? 'places-spin' : ''} style={{ verticalAlign: -1, marginRight: 3 }} />
                            Check for new edits
                        </button>
                        <button
                            className="list-toggle"
                            onClick={() => setShowPaste(s => !s)}
                            title='Paste the blob from DingoNav&apos;s "Copy mark edits for Dingo" button'
                        >
                            <ClipboardPaste size={11} style={{ verticalAlign: -1 }} />
                        </button>
                    </div>
                    <div className="pack-marks-summary">
                        {pendingMarks.length} pending · {marksData?.accepted ?? 0} accepted
                        {marksNote ? ` · ${marksNote}` : ''}
                    </div>
                    {showPaste && (
                        <div className="pack-marks-paste">
                            <textarea
                                className="export-input"
                                rows={2}
                                placeholder='{"turnEdits": [...]}'
                                value={pasteText}
                                onChange={e => setPasteText(e.target.value)}
                            />
                            <button className="export-btn" disabled={!pasteText.trim()} onClick={handlePasteMarks}>Add</button>
                        </div>
                    )}
                    {marks.map(m => {
                        const [icon, label] = markIconLabel(m)
                        const when = new Date(m.edited_at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
                        return (
                            <div
                                key={m.id}
                                className={`pack-mark ${m.status} ${focusMarkId === m.id ? 'focused' : ''}`}
                                onClick={() => focusMark(m)}
                                title="Show on the map"
                            >
                                <span className="pack-mark-icon" style={{ color: MARK_ROW_COLORS[m.op === 'remove' ? 'remove' : m.kind] ?? MARK_ROW_COLORS.turn }}>
                                    {icon}
                                </span>
                                <span className="pack-mark-body">
                                    <span className="pack-mark-title">
                                        {label} <span className="pack-mark-by">by {m.edited_by}</span>
                                    </span>
                                    <span className="pack-mark-sub">
                                        {when}
                                        {m.off_track ? ' · off track' : m.ride_name ? ` · ${m.ride_name}${m.km != null ? `, km ${m.km.toFixed(1)}` : ''}` : ''}
                                    </span>
                                </span>
                                {m.status === 'accepted' && <span className="pack-mark-tag">accepted</span>}
                                {m.status === 'pending' && (
                                    <button
                                        className="pack-mark-btn ok"
                                        onClick={e => { e.stopPropagation(); handleMarkStatus(m.id, 'accepted') }}
                                        title="Accept — bakes into the next refresh"
                                    ><Check size={13} /></button>
                                )}
                                <button
                                    className="pack-mark-btn no"
                                    onClick={e => { e.stopPropagation(); handleMarkStatus(m.id, 'rejected') }}
                                    title="Reject — never bakes (riders who got it live keep it locally)"
                                ><X size={13} /></button>
                            </div>
                        )
                    })}
                    {pendingMarks.length > 1 && (
                        <button
                            className="list-toggle pack-marks-acceptall"
                            onClick={() => handleMarkStatus('all', 'accepted')}
                            title="Accept every pending edit"
                        >
                            <Check size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
                            Accept all ({pendingMarks.length})
                        </button>
                    )}
                    {marks.length === 0 && (
                        <div className="pack-marks-empty">
                            No edits yet — riders' turn points, dangers, gates… land here for review.
                        </div>
                    )}
                </div>
            )}

            <div className="list-count" style={{ paddingLeft: 0, paddingRight: 0 }}>
                <span>{pack.rides.length} track{pack.rides.length === 1 ? '' : 's'} · first is DingoNav's default</span>
                {addable > 0 && (
                    <button className="list-toggle" onClick={addFromBasket} title={`Append the ${addable} basket track${addable === 1 ? '' : 's'} not already here`}>
                        <PackagePlus size={12} style={{ verticalAlign: -2, marginRight: 3 }} />
                        Add basket ({addable})
                    </button>
                )}
            </div>
            <div className="pack-tracks">
                {pack.rides.map((r: PackRideEntry, i: number) => (
                    <div
                        key={r.id}
                        className={`pack-track ${overIdx === i && dragIdx !== null && dragIdx !== i ? 'drag-over' : ''}`}
                        draggable
                        onDragStart={() => setDragIdx(i)}
                        onDragOver={e => { e.preventDefault(); setOverIdx(i) }}
                        onDrop={handleDrop}
                        onDragEnd={() => { setDragIdx(null); setOverIdx(null) }}
                        title={r.superseded ? 'Superseded — publish skips this ride' : r.no_geometry ? 'No geometry — publish skips this ride' : undefined}
                    >
                        <GripVertical size={13} className="pack-track-grip" />
                        <span className={`pack-track-name ${r.superseded || r.no_geometry ? 'skipped' : ''}`}>
                            {r.name}
                        </span>
                        {i === 0 && <span className="pack-default-badge">default</span>}
                        {(r.superseded || r.no_geometry) && <AlertTriangle size={12} style={{ color: 'var(--warning, #e6a23c)', flexShrink: 0 }} />}
                        <button
                            className="pack-track-remove"
                            onClick={() => removeRide(r.id)}
                            title="Remove from this pack"
                        ><X size={12} /></button>
                    </div>
                ))}
                {pack.rides.length === 0 && (
                    <div className="empty-state" style={{ padding: 12 }}>
                        <p style={{ fontSize: 12 }}>No tracks yet — add some from the basket.</p>
                    </div>
                )}
            </div>

            <label className="export-label">Contents</label>
            {layerCheck('include_tracks', 'Tracks — full-res GPX')}
            {layerCheck('include_heatmap', 'Heatmap — rides near the selection', undefined, 'heatmap')}
            <label className="export-label">
                Map layers
                <button
                    className={`preview-pill ${previewOn ? 'on' : ''}`}
                    disabled={!estimate?.corridor}
                    onClick={() => setPackPreview(previewOn ? null : buildPreview())}
                    title={estimate?.corridor
                        ? 'Show the map as this pack renders offline — only its layers, masked to its coverage. Two known differences: the bundled heatmap follows the pack’s own class filters, and its zoomed-out heat is capped server-side, so the preview can show a little more than ships.'
                        : 'Add tracks to the pack to preview its coverage'}
                >
                    <Eye size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
                    {previewOn ? 'Previewing' : 'Pack layers only'}
                </button>
            </label>
            {layerCheck('include_satellite', 'Satellite (Esri)', estimate?.satellite, 'satellite')}
            {layerCheck('include_basemap', 'Topo map', estimate?.basemap, 'basemap')}
            {layerCheck('include_hillshade', 'Hillshade', estimate?.hillshade, 'hillshade')}
            {layerCheck('include_strava', 'Strava heatmap', estimate?.strava, 'strava')}
            {estimate?.overview && (pack.include_basemap || pack.include_strava || pack.include_heatmap) && (
                <div className="export-hint" title="Zoomed-out context baked into the bundle: region basemap to z10, coarse Strava heat z8–10, simplified heat lines.">
                    Overview: {estimate.overview.area}
                    {pack.include_basemap ? ` — ~${formatBytes(estimate.overview.basemap.bytes)} map` : ''}
                    {pack.include_strava ? ` · ~${formatBytes(estimate.overview.strava.bytes)} Strava` : ''}
                </div>
            )}
            <label className="export-check" title="Remove points inside your privacy zones from the published files.">
                <input type="checkbox" checked={pack.privacy} onChange={e => patch({ privacy: e.target.checked })} />
                Hide privacy zones
            </label>

            {error && <div className="export-error">{error}</div>}

            {confirmOpen && (
                <div className="export-hint" style={{ border: '1px solid #444', borderRadius: 4, padding: 8 }}>
                    {dingodirt && !dingodirt.connected ? (
                        <div>
                            Publishing needs a dingodirt.com account — paste an API token in
                            Settings (the gear on the map toolbar) first.
                        </div>
                    ) : (
                        <>
                            <label className="export-check" title="The ?b= link works for anyone you send it to; the pack is not listed in the dingodirt.com galleries">
                                <input
                                    type="radio"
                                    name="pack-visibility"
                                    checked={pubVisibility === 'unlisted'}
                                    onChange={() => setPubVisibility('unlisted')}
                                />
                                Link only — share the link with your mates
                            </label>
                            <label className="export-check" title="Submits the pack to the public galleries — it appears after a quick review (the link works immediately either way)">
                                <input
                                    type="radio"
                                    name="pack-visibility"
                                    checked={pubVisibility === 'public'}
                                    onChange={() => setPubVisibility('public')}
                                />
                                Public — list in the dingodirt.com galleries
                            </label>
                            <button
                                className="export-btn primary"
                                style={{ marginTop: 6 }}
                                disabled={publishing}
                                onClick={handlePublish}
                            >
                                <RefreshCw size={13} className={publishing ? 'places-spin' : ''} style={{ verticalAlign: -2, marginRight: 5 }} />
                                {publishing ? 'Publishing…' : pack.published_at ? 'Refresh pack' : 'Publish pack'}
                            </button>
                        </>
                    )}
                </div>
            )}

            <div className="export-actions">
                <button
                    className="export-btn primary"
                    disabled={publishing || pack.rides.length === 0}
                    onClick={openConfirm}
                    title={pack.published_at
                        ? 'Rebuild and re-publish to dingodirt.com — the shared link serves the new contents'
                        : 'Publish to dingodirt.com and get a live DingoNav link'}
                >
                    <RefreshCw size={13} className={publishing ? 'places-spin' : ''} style={{ verticalAlign: -2, marginRight: 5 }} />
                    {publishing ? 'Publishing…' : pack.published_at ? 'Refresh' : 'Publish…'}
                </button>
                <button
                    className="export-btn"
                    disabled={planPublishing || pack.rides.length === 0}
                    onClick={handlePublishPlan}
                    title="Publish a lightweight planning page — every track on one web map (no tiles, ~instant) for the group to pick a route from"
                >
                    <MapIcon size={13} className={planPublishing ? 'places-spin' : ''} style={{ verticalAlign: -2, marginRight: 5 }} />
                    {planPublishing ? 'Publishing…' : pack.plan_url ? 'Refresh plan' : 'Plan page'}
                </button>
                <button
                    className="export-btn"
                    disabled={pack.rides.length === 0}
                    onClick={() => onExport(rideIds, pack.name)}
                    title="Export these tracks to a zip, device folder, or .dingonav download"
                >
                    <Upload size={13} style={{ verticalAlign: -2, marginRight: 5 }} />
                    Export…
                </button>
            </div>
        </div>
    )
}
