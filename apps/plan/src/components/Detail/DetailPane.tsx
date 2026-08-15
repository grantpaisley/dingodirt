import { useRide, useRidesByIds, usePhotos, updateRideMode, updateRide, useFolders, createFolder, assignToFolder, useLabels, createLabel, createLabelSet, assignLabel, setRideNameSource, NAME_VARIANT_LABELS, RIDE_MODES, SERVER_BASE, type PhotoSummary, type NameVariant, type RideDetail } from '../../api/hooks'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { PackageMinus, PackagePlus } from 'lucide-react'
import { useBasket, useSettings, type RideMode } from '../../store'
import { OwnerPicker } from '../OwnerPicker'

const NAME_VARIANT_ORDER: NameVariant[] = ['original', 'filename', 'generated', 'custom']

/** Which name a track displays. All four are stored, so this only re-points —
 *  it never rewrites a name, and switching back always works.
 *
 *  Variants with no value are disabled. Junk variants (a FIT sport string, an
 *  "Active Log:" default, a bare date) stay selectable but are marked, because
 *  the honest content of that variant is still worth seeing. */
function NamePicker({ ride, disabled, onChanged }: {
    ride: RideDetail
    disabled?: boolean
    onChanged: () => void
}) {
    const values: Record<NameVariant, string | null> = {
        original: ride.original_name,
        filename: ride.file_name,
        generated: ride.generated_name,
        custom: ride.custom_name,
    }
    const junk = new Set(ride.junk_variants ?? [])

    return (
        <div className="detail-section" style={{ marginTop: 8 }}>
            <div className="detail-label">Name shown</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
                {NAME_VARIANT_ORDER.map(variant => {
                    const value = values[variant]
                    const empty = !value || !value.trim()
                    const isJunk = junk.has(variant)
                    return (
                        <label
                            key={variant}
                            title={empty ? 'This file carried no such name' : value!}
                            style={{
                                display: 'grid',
                                gridTemplateColumns: 'auto 5.5rem 1fr',
                                gap: 6,
                                alignItems: 'baseline',
                                padding: '2px 0',
                                cursor: empty || disabled ? 'default' : 'pointer',
                                opacity: empty ? 0.4 : isJunk ? 0.65 : 1,
                            }}
                        >
                            <input
                                type="radio"
                                name={`name-source-${ride.id}`}
                                checked={ride.name_source === variant}
                                disabled={empty || disabled}
                                onChange={async () => {
                                    await setRideNameSource([ride.id], variant)
                                    onChanged()
                                }}
                            />
                            <span className="detail-label" style={{ margin: 0 }}>
                                {NAME_VARIANT_LABELS[variant]}
                            </span>
                            <span
                                className="detail-value"
                                style={{
                                    wordBreak: 'break-word',
                                    fontStyle: empty ? 'italic' : undefined,
                                }}
                            >
                                {empty ? '—' : value}
                                {isJunk && !empty && (
                                    <span style={{ opacity: 0.7 }}> · not descriptive</span>
                                )}
                            </span>
                        </label>
                    )
                })}
            </div>
        </div>
    )
}

/** Folder home (filter pills): a flat select over the folder tree with
 *  depth-indented names, an Unfiled root, and a "New folder…" creator. */
function FolderPicker({ value, disabled, onChange }: {
    value: string | null
    disabled?: boolean
    onChange: (folderId: string | null) => void
}) {
    const { data: folders } = useFolders()
    // Depth-first flatten so children indent under their parents.
    const rows: { id: string, label: string }[] = []
    const walk = (parentId: string | null, depth: number) => {
        for (const f of (folders ?? []).filter(f => f.parent_id === parentId)) {
            rows.push({ id: f.id, label: `${'  '.repeat(depth)}${f.name}` })
            walk(f.id, depth + 1)
        }
    }
    walk(null, 0)
    return (
        <select
            className="mode-select"
            value={value ?? ''}
            disabled={disabled}
            onChange={async e => {
                if (e.target.value === '__new__') {
                    const name = window.prompt('New folder name')
                    if (!name?.trim()) return
                    try {
                        const { id } = await createFolder(name.trim())
                        onChange(id)
                    } catch (err) {
                        window.alert(err instanceof Error ? err.message : String(err))
                    }
                    return
                }
                onChange(e.target.value || null)
            }}
        >
            <option value="">Unfiled</option>
            {rows.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
            <option value="__new__">New folder…</option>
        </select>
    )
}

/** Multi-membership labels: assigned chips (single-ride mode) + an add
 *  select grouped by label set, with per-set "New…" and a set creator.
 *  In bulk mode (assigned = null) the select attaches to every id. */
function LabelEditor({ rideIds, assigned, disabled, onChanged }: {
    rideIds: string[]
    /** The single ride's label ids, or null in bulk mode */
    assigned: string[] | null
    disabled?: boolean
    onChanged: () => void
}) {
    const { data } = useLabels()
    const sets = data?.sets ?? []
    const labels = data?.labels ?? []
    const byId = new Map(labels.map(l => [l.id, l]))
    const setName = (l: { label_set_id: string }) =>
        sets.find(s => s.id === l.label_set_id)?.name ?? '?'
    // Depth via the parent chain, for option indentation.
    const depth = (l: { parent_id: string | null }): number => {
        let d = 0
        let p = l.parent_id
        while (p) { d++; p = byId.get(p)?.parent_id ?? null }
        return d
    }
    const act = async (fn: () => Promise<unknown>) => {
        try { await fn(); onChanged() }
        catch (err) { window.alert(err instanceof Error ? err.message : String(err)) }
    }
    return (
        <div>
            {assigned && assigned.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
                    {assigned.map(id => {
                        const l = byId.get(id)
                        if (!l) return null
                        return (
                            <span key={id} className="pill active" title={`${setName(l)}: ${l.name}`}>
                                <span className="pill-label">{l.name}</span>
                                <button
                                    className="pill-remove"
                                    disabled={disabled}
                                    title="Detach this label"
                                    onClick={() => act(() => assignLabel('ride', rideIds, id, false))}
                                >×</button>
                            </span>
                        )
                    })}
                </div>
            )}
            <select
                className="mode-select"
                value=""
                disabled={disabled}
                onChange={async e => {
                    const v = e.target.value
                    if (!v) return
                    if (v === '__new_set__') {
                        const name = window.prompt('New label set name (e.g. Trip, Surface)')
                        if (name?.trim()) await act(() => createLabelSet(name.trim()))
                        return
                    }
                    if (v.startsWith('__new_label__:')) {
                        const setId = v.slice('__new_label__:'.length)
                        const name = window.prompt('New label name')
                        if (name?.trim()) {
                            await act(async () => {
                                const { id } = await createLabel(setId, name.trim())
                                await assignLabel('ride', rideIds, id, true)
                            })
                        }
                        return
                    }
                    await act(() => assignLabel('ride', rideIds, v, true))
                }}
            >
                <option value="">{rideIds.length > 1 ? `Add label to all ${rideIds.length}…` : 'Add label…'}</option>
                {sets.map(s => (
                    <optgroup key={s.id} label={s.name}>
                        {labels.filter(l => l.label_set_id === s.id).map(l => (
                            <option key={l.id} value={l.id} disabled={assigned?.includes(l.id)}>
                                {'  '.repeat(depth(l))}{l.name}
                            </option>
                        ))}
                        <option value={`__new_label__:${s.id}`}>New label in {s.name}…</option>
                    </optgroup>
                ))}
                <option value="__new_set__">New label set…</option>
            </select>
        </div>
    )
}

/** Difficulty grade 1-5 (Grant's scale) — click sets, click again clears */
function GradePicker({ value, disabled, onChange }: {
    value: number | null
    disabled?: boolean
    onChange: (g: number | null) => void
}) {
    return (
        <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            {[1, 2, 3, 4, 5].map(g => (
                <button
                    key={g}
                    disabled={disabled}
                    onClick={() => onChange(value === g ? null : g)}
                    title={`Grade ${g}${value === g ? ' — click to clear' : ''}`}
                    style={{
                        width: 30,
                        padding: '5px 0',
                        borderRadius: 4,
                        border: '1px solid var(--border-color)',
                        cursor: 'pointer',
                        fontSize: 13,
                        background: value === g ? 'var(--accent)' : 'transparent',
                        color: value === g ? 'white' : 'var(--text-secondary)',
                    }}
                >
                    {g}
                </button>
            ))}
        </div>
    )
}

/** Add/remove this ride in the export basket */
function BasketButton({ rideId }: { rideId: string }) {
    const basket = useBasket()
    const inBasket = basket.ids.includes(rideId)
    return (
        <button
            className="mode-select"
            style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginTop: 8 }}
            onClick={() => basket.toggle(rideId)}
            title={inBasket ? 'Remove from export basket' : 'Add to export basket'}
        >
            {inBasket ? <PackageMinus size={14} /> : <PackagePlus size={14} />}
            {inBasket ? 'Remove from basket' : 'Add to basket'}
        </button>
    )
}

interface DetailPaneProps {
    selectedIds: string[]
    /** Track under the cursor (map or list row) — previewed here without a click */
    hoveredId?: string | null
    onSelect: (ids: string[]) => void
}

/** Row of clickable photo thumbnails (opens Google Photos full-res) */
function PhotoStrip({ photos }: { photos: PhotoSummary[] }) {
    if (photos.length === 0) return null
    return (
        <div className="detail-section" style={{ marginTop: 16 }}>
            <div className="detail-label">Photos ({photos.length})</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                {photos.map(p => (
                    <a
                        key={p.id}
                        href={p.google_photos_url || `${SERVER_BASE}${p.medium_url}`}
                        target="_blank"
                        rel="noreferrer"
                        title={p.taken_at ? new Date(p.taken_at).toLocaleString() : ''}
                    >
                        <img
                            src={`${SERVER_BASE}${p.thumb_url}`}
                            alt="ride photo"
                            style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 4, display: 'block' }}
                        />
                    </a>
                ))}
            </div>
        </div>
    )
}

export function DetailPane({ selectedIds, hoveredId, onSelect }: DetailPaneProps) {
    const selectedId = selectedIds.length === 1 ? selectedIds[0] : undefined
    // Hovering a track (map or list) previews its details here without
    // touching the selection; un-hovering falls back to the selection view.
    const previewId = hoveredId && hoveredId !== selectedId ? hoveredId : null
    const detailId = previewId ?? selectedId
    const enabledModes = useSettings(s => s.enabledModes)
    const { data: ride, isLoading } = useRide(detailId)
    // Fetch exactly the selected rides by id — filtering the capped list dropped
    // any selection older than the newest 5000 from the totals.
    const { data: selectedRides } = useRidesByIds(selectedIds.length > 1 ? selectedIds : [])
    const { data: photos } = usePhotos()
    const queryClient = useQueryClient()
    const [isUpdating, setIsUpdating] = useState(false)

    const handleModeChange = async (newMode: string) => {
        if (!detailId) return
        setIsUpdating(true)
        try {
            await updateRideMode(detailId, newMode)
            queryClient.invalidateQueries({ queryKey: ['ride', detailId] })
            queryClient.invalidateQueries({ queryKey: ['rides'] })
            // Places tree reads allRideMeta; keep it in sync too (audit M9)
            queryClient.invalidateQueries({ queryKey: ['allRideMeta'] })
            queryClient.invalidateQueries({ queryKey: ['rideLocations'] })
            // The heatmap carries each track's mode and filters on it, so a
            // mode change must refetch it too (it's computed live from rides).
            queryClient.invalidateQueries({ queryKey: ['heatmap'] })
            dropIfHidden(newMode, [detailId])
        } catch (e) {
            console.error('Failed to update mode:', e)
        } finally {
            setIsUpdating(false)
        }
    }

    /** Retyping a track into a mode that's filtered off makes it vanish from
     *  the map while staying selected — which, under focus mode, empties the
     *  map and strands the user. Drop those ids from the selection instead.
     *  Runs after cache invalidation so the list/map settle in one render. */
    const dropIfHidden = (newMode: string, changed: string[]) => {
        if (enabledModes.includes(newMode as RideMode)) return
        const gone = new Set(changed)
        onSelect(selectedIds.filter(id => !gone.has(id)))
    }

    // Bulk override: set the type for every selected track (marks each as a
    // user override so auto-reclassification never touches them again)
    const handleBulkModeChange = async (newMode: string) => {
        if (!newMode || selectedIds.length === 0) return
        setIsUpdating(true)
        try {
            const results = await Promise.allSettled(
                selectedIds.map(id => updateRideMode(id, newMode))
            )
            const failed = results.filter(r => r.status === 'rejected').length
            if (failed > 0) console.error(`Failed to update ${failed} of ${selectedIds.length} rides`)
            queryClient.invalidateQueries({ queryKey: ['rides'] })
            queryClient.invalidateQueries({ queryKey: ['allRideMeta'] })
            queryClient.invalidateQueries({ queryKey: ['rideLocations'] })
            selectedIds.forEach(id => queryClient.invalidateQueries({ queryKey: ['ride', id] }))
            queryClient.invalidateQueries({ queryKey: ['heatmap'] })
            // Only the rides whose PATCH actually landed leave the selection
            dropIfHidden(newMode, selectedIds.filter((_, i) => results[i].status === 'fulfilled'))
        } finally {
            setIsUpdating(false)
        }
    }

    const handleOwnerChange = async (ownerId: string, ids: string[]) => {
        if (!ownerId || ids.length === 0) return
        setIsUpdating(true)
        try {
            const results = await Promise.allSettled(ids.map(id => updateRide(id, { owner_id: ownerId })))
            const failed = results.filter(r => r.status === 'rejected').length
            if (failed > 0) console.error(`Owner update failed for ${failed} of ${ids.length} rides`)
            queryClient.invalidateQueries({ queryKey: ['rides'] })
            queryClient.invalidateQueries({ queryKey: ['allRideMeta'] })
            queryClient.invalidateQueries({ queryKey: ['ridesByIds'] })
            ids.forEach(id => queryClient.invalidateQueries({ queryKey: ['ride', id] }))
        } finally {
            setIsUpdating(false)
        }
    }

    // Multi-select: calculate aggregate stats (a hover preview outranks it —
    // the hovered track's detail shows until the cursor moves off)
    if (!previewId && selectedIds.length > 1 && selectedRides) {
        const totalDistance = selectedRides.reduce((acc, r) => acc + (r.distance_m || 0), 0)
        const totalDuration = selectedRides.reduce((acc, r) => acc + (r.duration_s || 0), 0)

        return (
            <div className="detail-pane">
                <div className="detail-header">
                    {selectedIds.length} Rides Selected
                </div>

                <div className="detail-grid">
                    <div className="detail-section">
                        <div className="detail-label">Total Distance</div>
                        <div className="detail-value">{formatDistance(totalDistance)}</div>
                    </div>

                    <div className="detail-section">
                        <div className="detail-label">Total Duration</div>
                        <div className="detail-value">{formatDuration(totalDuration)}</div>
                    </div>
                </div>

                {/* Bulk grade for the whole selection */}
                <div className="detail-section" style={{ marginTop: 16 }}>
                    <div className="detail-label">Set grade for all {selectedIds.length}</div>
                    <GradePicker
                        value={null}
                        disabled={isUpdating}
                        onChange={async (g) => {
                            if (g == null) return
                            setIsUpdating(true)
                            try {
                                const rs = await Promise.allSettled(selectedIds.map(id => updateRide(id, { grade: g })))
                                const failed = rs.filter(r => r.status === 'rejected').length
                                if (failed > 0) console.error(`Grade update failed for ${failed} of ${selectedIds.length} rides`)
                                queryClient.invalidateQueries({ queryKey: ['rides'] })
                                queryClient.invalidateQueries({ queryKey: ['allRideMeta'] })
                                queryClient.invalidateQueries({ queryKey: ['ridesByIds'] })
                            } finally { setIsUpdating(false) }
                        }}
                    />
                </div>

                {/* Bulk type override for the whole selection */}
                <div className="detail-section" style={{ marginTop: 16 }}>
                    <div className="detail-label">Set type for all {selectedIds.length}</div>
                    <div className="mode-picker" style={{ marginTop: 4 }}>
                        <select
                            value=""
                            onChange={(e) => handleBulkModeChange(e.target.value)}
                            disabled={isUpdating}
                            className="mode-select"
                        >
                            <option value="" disabled>
                                {isUpdating ? 'Updating…' : 'Choose type…'}
                            </option>
                            {RIDE_MODES.map(m => (
                                <option key={m.value} value={m.value}>
                                    {m.icon} {m.label}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>

                {/* Bulk owner reassign — the fix for "imported a mate's folder
                    as my own tracks": select them all, pick the right owner */}
                <div className="detail-section" style={{ marginTop: 16 }}>
                    <div className="detail-label">Set owner for all {selectedIds.length}</div>
                    <div style={{ marginTop: 4 }}>
                        <OwnerPicker
                            value=""
                            disabled={isUpdating}
                            placeholder={isUpdating ? 'Updating…' : 'Choose owner…'}
                            className="mode-select"
                            onChange={ownerId => handleOwnerChange(ownerId, selectedIds)}
                        />
                    </div>
                </div>

                {/* Bulk filing — move the whole selection into one folder */}
                <div className="detail-section" style={{ marginTop: 16 }}>
                    <div className="detail-label">Set folder for all {selectedIds.length}</div>
                    <div style={{ marginTop: 4 }}>
                        <FolderPicker
                            value={null}
                            disabled={isUpdating}
                            onChange={async folderId => {
                                setIsUpdating(true)
                                try {
                                    await assignToFolder('ride', selectedIds, folderId)
                                    queryClient.invalidateQueries({ queryKey: ['items'] })
                                    queryClient.invalidateQueries({ queryKey: ['folders'] })
                                    selectedIds.forEach(id => queryClient.invalidateQueries({ queryKey: ['ride', id] }))
                                } catch (err) {
                                    window.alert(err instanceof Error ? err.message : String(err))
                                } finally {
                                    setIsUpdating(false)
                                }
                            }}
                        />
                    </div>
                </div>

                {/* Bulk labelling — attach one label to the whole selection */}
                <div className="detail-section" style={{ marginTop: 16 }}>
                    <div className="detail-label">Labels for all {selectedIds.length}</div>
                    <div style={{ marginTop: 4 }}>
                        <LabelEditor
                            rideIds={selectedIds}
                            assigned={null}
                            disabled={isUpdating}
                            onChanged={() => {
                                queryClient.invalidateQueries({ queryKey: ['labels'] })
                                queryClient.invalidateQueries({ queryKey: ['items'] })
                                queryClient.invalidateQueries({ queryKey: ['dimensions'] })
                                selectedIds.forEach(id => queryClient.invalidateQueries({ queryKey: ['ride', id] }))
                            }}
                        />
                    </div>
                </div>

                <div className="detail-section" style={{ marginTop: 16 }}>
                    <div className="detail-label">Selected Rides</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                        {selectedRides.map(r => (
                            <div key={r.id} style={{ padding: '4px 0', borderBottom: '1px solid var(--border-color)' }}>
                                {r.name || formatDate(r.started_at)}
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        )
    }

    if (!detailId) {
        return (
            <div className="detail-pane">
                <div className="empty-state">
                    <p>Select a ride</p>
                    <p style={{ fontSize: 12, marginTop: 8 }}>Hover to preview, click to select</p>
                </div>
            </div>
        )
    }

    if (isLoading) {
        return <div className="detail-pane"><div className="loading">Loading...</div></div>
    }

    if (!ride) {
        return <div className="detail-pane"><div className="empty-state">Not found</div></div>
    }

    const currentMode = RIDE_MODES.find(m => m.value === ride.mode) || RIDE_MODES[3]

    return (
        <div className="detail-pane">
            <div className="detail-header">
                {ride.name || 'Untitled Ride'}
            </div>

            {previewId && (
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
                    Hover preview — click the track to select it
                </div>
            )}

            {/* Mode Picker */}
            <div className="mode-picker">
                <span className="mode-icon">{currentMode.icon}</span>
                <select
                    value={ride.mode}
                    onChange={(e) => handleModeChange(e.target.value)}
                    disabled={isUpdating}
                    className="mode-select"
                >
                    {RIDE_MODES.map(m => (
                        <option key={m.value} value={m.value}>
                            {m.icon} {m.label}
                        </option>
                    ))}
                </select>
            </div>

            <div className="detail-section" style={{ marginBottom: 12 }}>
                <div className="detail-label">Grade (1 easiest – 5 expert)</div>
                <GradePicker
                    value={ride.grade}
                    disabled={isUpdating}
                    onChange={async (g) => {
                        setIsUpdating(true)
                        try {
                            await updateRide(ride.id, g == null ? { clear_grade: true } : { grade: g })
                            queryClient.invalidateQueries({ queryKey: ['ride', ride.id] })
                            queryClient.invalidateQueries({ queryKey: ['rides'] })
                            queryClient.invalidateQueries({ queryKey: ['allRideMeta'] })
                        } finally { setIsUpdating(false) }
                    }}
                />
            </div>

            <div className="detail-grid">
                <div className="detail-section">
                    <div className="detail-label">Date</div>
                    <div className="detail-value">{formatDate(ride.started_at)}</div>
                </div>

                <div className="detail-section">
                    <div className="detail-label">Time of Day</div>
                    <div className="detail-value">{ride.time_of_day || 'Unknown'}</div>
                </div>

                <div className="detail-section">
                    <div className="detail-label">Duration</div>
                    <div className="detail-value">{formatDuration(ride.duration_s)}</div>
                </div>

                <div className="detail-section">
                    <div className="detail-label">Distance</div>
                    <div className="detail-value">{formatDistance(ride.distance_m)}</div>
                </div>

                <div className="detail-section">
                    <div className="detail-label">Condition</div>
                    <div className="detail-value">{ride.condition || 'Unknown'}</div>
                </div>

                {ride.state && (
                    <div className="detail-section">
                        <div className="detail-label">State</div>
                        <div className="detail-value">{ride.state}</div>
                    </div>
                )}

                {ride.region && (
                    <div className="detail-section">
                        <div className="detail-label">Region</div>
                        <div className="detail-value">{ride.region}</div>
                    </div>
                )}

                {ride.source && (
                    <div className="detail-section">
                        <div className="detail-label">Source</div>
                        <div className="detail-value">{ride.source}</div>
                    </div>
                )}

                {/* Planned routes: the curated network this route belongs to */}
                {ride.collection && (
                    <div className="detail-section">
                        <div className="detail-label">Collection</div>
                        <div className="detail-value" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {ride.color && (
                                <span style={{
                                    width: 10, height: 10, borderRadius: '50%',
                                    background: ride.color, display: 'inline-block',
                                    flexShrink: 0,
                                }} />
                            )}
                            {ride.collection}
                        </div>
                    </div>
                )}
            </div>

            {/* Planned-route notes (closures, permits) — the \n line breaks
                are the payload, so render them preserved */}
            {ride.description && (
                <div className="detail-section" style={{ marginTop: 16 }}>
                    <div className="detail-label">Notes</div>
                    <div
                        className="detail-value"
                        style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.45 }}
                    >
                        {ride.description}
                    </div>
                </div>
            )}

            {ride.lgas && ride.lgas.length > 0 && (
                <div className="detail-section" style={{ marginTop: 16 }}>
                    <div className="detail-label">{ride.lgas.length > 1 ? 'LGAs' : 'LGA'}</div>
                    <div className="detail-value">{ride.lgas.join(', ')}</div>
                </div>
            )}

            {ride.suburbs && ride.suburbs.length > 0 && (
                <div className="detail-section" style={{ marginTop: 8 }}>
                    <div className="detail-label">{ride.suburbs.length > 1 ? 'Suburbs' : 'Suburb'}</div>
                    <div className="detail-value">{ride.suburbs.join(', ')}</div>
                </div>
            )}

            {/* Elevation */}
            {(ride.elevation_gain || ride.elevation_loss) && (
                <div className="detail-section" style={{ marginTop: 16 }}>
                    <div className="detail-label">Elevation</div>
                    <div className="detail-value">
                        ↑ {Math.round(ride.elevation_gain || 0)}m
                        {' '}↓ {Math.round(ride.elevation_loss || 0)}m
                    </div>
                </div>
            )}

            {/* Speed */}
            {(ride.avg_speed || ride.max_speed) && (
                <div className="detail-section" style={{ marginTop: 8 }}>
                    <div className="detail-label">Speed</div>
                    <div className="detail-value">
                        Avg {formatSpeed(ride.avg_speed)} / Max {formatSpeed(ride.max_speed)}
                    </div>
                </div>
            )}

            {/* Heart Rate */}
            {(ride.avg_hr || ride.max_hr) && (
                <div className="detail-section" style={{ marginTop: 8 }}>
                    <div className="detail-label">Heart Rate</div>
                    <div className="detail-value">
                        Avg {ride.avg_hr || '—'} / Max {ride.max_hr || '—'} bpm
                    </div>
                </div>
            )}

            {/* Provenance — whose track this is and where the file came from */}
            <div className="detail-section" style={{ marginTop: 16 }}>
                <div className="detail-label">Owner</div>
                {previewId ? (
                    // Hover previews are read-only — no accidental reassigns
                    <div className="detail-value">{ride.owner.name}</div>
                ) : (
                    <div style={{ marginTop: 4 }}>
                        <OwnerPicker
                            value={ride.owner.id}
                            disabled={isUpdating}
                            className="mode-select"
                            onChange={ownerId => handleOwnerChange(ownerId, [ride.id])}
                        />
                    </div>
                )}
            </div>

            {!previewId && (
                <div className="detail-section" style={{ marginTop: 8 }}>
                    <div className="detail-label">Folder</div>
                    <div style={{ marginTop: 4 }}>
                        <FolderPicker
                            value={ride.folder_id ?? null}
                            disabled={isUpdating}
                            onChange={async folderId => {
                                setIsUpdating(true)
                                try {
                                    await assignToFolder('ride', [ride.id], folderId)
                                    queryClient.invalidateQueries({ queryKey: ['ride', ride.id] })
                                    queryClient.invalidateQueries({ queryKey: ['items'] })
                                    queryClient.invalidateQueries({ queryKey: ['folders'] })
                                } catch (err) {
                                    window.alert(err instanceof Error ? err.message : String(err))
                                } finally {
                                    setIsUpdating(false)
                                }
                            }}
                        />
                    </div>
                </div>
            )}

            {!previewId && (
                <div className="detail-section" style={{ marginTop: 8 }}>
                    <div className="detail-label">Labels</div>
                    <div style={{ marginTop: 4 }}>
                        <LabelEditor
                            rideIds={[ride.id]}
                            assigned={ride.label_ids ?? []}
                            disabled={isUpdating}
                            onChanged={() => {
                                queryClient.invalidateQueries({ queryKey: ['ride', ride.id] })
                                queryClient.invalidateQueries({ queryKey: ['labels'] })
                                queryClient.invalidateQueries({ queryKey: ['items'] })
                                queryClient.invalidateQueries({ queryKey: ['dimensions'] })
                            }}
                        />
                    </div>
                </div>
            )}

            <NamePicker
                ride={ride}
                disabled={isUpdating}
                onChanged={() => {
                    queryClient.invalidateQueries({ queryKey: ['ride', ride.id] })
                    // 'items' is what the track list renders from — without it
                    // the list keeps showing the old name until a refetch.
                    queryClient.invalidateQueries({ queryKey: ['items'] })
                    queryClient.invalidateQueries({ queryKey: ['allRideMeta'] })
                    queryClient.invalidateQueries({ queryKey: ['ridesByIds'] })
                }}
            />

            <div className="detail-section" style={{ marginTop: 8 }}>
                <div className="detail-label">Imported</div>
                <div className="detail-value" style={{ wordBreak: 'break-all' }}>
                    {formatDate(ride.imported_at)}
                    {ride.imported_from ? ` — from ${ride.imported_from}` : ''}
                </div>
            </div>

            {ride.library_path && (
                <div className="detail-section" style={{ marginTop: 8 }}>
                    <div className="detail-label">Library file</div>
                    <div className="detail-value" style={{ wordBreak: 'break-all' }}>{ride.library_path}</div>
                </div>
            )}

            <BasketButton rideId={ride.id} />

            {/* Photos taken on this ride */}
            <PhotoStrip photos={photos?.filter(p => p.ride_id === ride.id) || []} />
        </div>
    )
}

function formatDate(dateStr: string | null): string {
    if (!dateStr) return 'Unknown'
    return new Date(dateStr).toLocaleString()
}

function formatDistance(meters: number | null): string {
    if (!meters) return 'Unknown'
    return `${(meters / 1000).toFixed(2)} km`
}

function formatDuration(seconds: number | null): string {
    if (!seconds) return 'Unknown'
    const hours = Math.floor(seconds / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
}

function formatSpeed(speedMs: number | null): string {
    if (!speedMs) return '—'
    // Convert m/s to km/h
    return `${(speedMs * 3.6).toFixed(1)} km/h`
}

