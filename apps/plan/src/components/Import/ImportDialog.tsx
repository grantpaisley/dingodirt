import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FolderOpen, Map, Upload, X } from 'lucide-react'
import { importFiles, importGmapsUrl, type ImportResult, type PickedFile, useOwners } from '../../api/hooks'
import { OwnerPicker } from '../OwnerPicker'

const TRACK_FILE = /\.(gpx|fit|zip)$/i

/** Walk a dropped directory entry (webkitGetAsEntry tree), collecting files
 *  with their folder-relative paths. readEntries returns batches of ≤100, so
 *  it must be called until empty. */
function walkEntry(entry: FileSystemEntry, prefix: string, out: PickedFile[]): Promise<void> {
    return new Promise(resolve => {
        if (entry.isFile) {
            (entry as FileSystemFileEntry).file(
                f => { out.push({ file: f, path: prefix + f.name }); resolve() },
                () => resolve(),
            )
        } else if (entry.isDirectory) {
            const reader = (entry as FileSystemDirectoryEntry).createReader()
            const readBatch = () => reader.readEntries(async entries => {
                if (entries.length === 0) { resolve(); return }
                for (const e of entries) await walkEntry(e, prefix + entry.name + '/', out)
                readBatch()
            }, () => resolve())
            readBatch()
        } else {
            resolve()
        }
    })
}

/** Import external GPX/FIT/ZIP files with a source tag (wikiloc / dsra / a
 *  mate's name), origin (self/other), and owner assignment. Files go through
 *  the normal ingest path, are cleaned + located server-side, and get filed
 *  into the library tree by locality (owner/plan become filename tags). */
export function ImportDialog({ onClose }: { onClose: () => void }) {
    const queryClient = useQueryClient()
    const inputRef = useRef<HTMLInputElement>(null)
    const folderInputRef = useRef<HTMLInputElement>(null)
    const [files, setFiles] = useState<PickedFile[]>([])
    const [gmapsUrl, setGmapsUrl] = useState('')
    const [source, setSource] = useState('')
    const [origin, setOrigin] = useState<'self' | 'other'>('other')
    const { data: owners } = useOwners()
    const [selectedOwnerId, setSelectedOwnerId] = useState<string>('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [result, setResult] = useState<ImportResult | null>(null)
    const [dragOver, setDragOver] = useState(false)

    // Owner follows the origin choice: "my own recordings" default to the
    // 'me' owner; "someone else's" must be attributed deliberately (the old
    // always-default-to-me left mates' tracks owned by Grant).
    const meId = owners?.find(o => o.kind === 'me')?.id
    const handleOriginChange = (o: 'self' | 'other') => {
        setOrigin(o)
        if (o === 'self' && meId && !selectedOwnerId) setSelectedOwnerId(meId)
        if (o === 'other' && meId && selectedOwnerId === meId) setSelectedOwnerId('')
    }

    const addPicked = (incoming: PickedFile[]) => {
        const usable = incoming.filter(p => TRACK_FILE.test(p.file.name))
        setFiles(prev => {
            const seen = new Set(prev.map(p => `${p.path}:${p.file.size}`))
            return [...prev, ...usable.filter(p => !seen.has(`${p.path}:${p.file.size}`))]
        })
    }

    /** Files from an <input type=file>: webkitRelativePath is set (and includes
     *  the picked folder's name) when the folder input was used. */
    const addFromInput = (list: FileList) => {
        addPicked([...list].map(f => ({ file: f, path: f.webkitRelativePath || f.name })))
    }

    const handleDrop = (dt: DataTransfer) => {
        // Grab entries synchronously — the DataTransfer is dead after an await.
        const entries = dt.items
            ? [...dt.items].map(i => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e)
            : []
        if (entries.some(e => e.isDirectory)) {
            const out: PickedFile[] = []
            Promise.all(entries.map(e => walkEntry(e, '', out))).then(() => addPicked(out))
        } else {
            addPicked([...dt.files].map(f => ({ file: f, path: f.name })))
        }
    }

    const handleImport = async () => {
        setBusy(true)
        setError(null)
        try {
            // A pasted Google Maps link and dropped files can ship together —
            // both land through the same server pipeline and merge into one
            // result view.
            let res: ImportResult | null = null
            if (gmapsUrl.trim()) {
                res = await importGmapsUrl(gmapsUrl, source, origin, selectedOwnerId || undefined)
            }
            if (files.length > 0) {
                const fileRes = await importFiles(files, source, origin, selectedOwnerId || undefined)
                res = res
                    ? {
                        files: [...res.files, ...fileRes.files],
                        rides_created: res.rides_created + fileRes.rides_created,
                        note: fileRes.note,
                    }
                    : fileRes
            }
            setResult(res)
            queryClient.invalidateQueries({ queryKey: ['rides'] })
            queryClient.invalidateQueries({ queryKey: ['allRideMeta'] })
            queryClient.invalidateQueries({ queryKey: ['rideLocations'] })
            queryClient.invalidateQueries({ queryKey: ['heatmap'] })
            queryClient.invalidateQueries({ queryKey: ['rideStats'] })
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="export-overlay" onClick={onClose}>
            <div className="export-dialog" onClick={e => e.stopPropagation()}>
                <div className="export-header">
                    <span>Import tracks</span>
                    <button className="export-close" onClick={onClose} title="Close"><X size={16} /></button>
                </div>
                <div className="export-body">
                    {result ? (
                        <>
                            <div className="export-done">
                                {result.rides_created} ride{result.rides_created === 1 ? '' : 's'} imported,
                                cleaned and located.
                            </div>
                            <div className="export-manifest">
                                {result.files.map(f => (
                                    <div key={f.name} className="export-manifest-row">
                                        <span
                                            className="export-manifest-path"
                                            title={f.stored ? `saved to ${f.stored}` : undefined}
                                        >
                                            {f.name}
                                        </span>
                                        <span className="export-manifest-meta">
                                            {f.error ? f.error
                                                : f.duplicate ? 'already in the library'
                                                    : `${f.rides} ride${f.rides === 1 ? '' : 's'}`}
                                        </span>
                                    </div>
                                ))}
                            </div>
                            <div className="export-total">{result.note}</div>
                            <div className="export-actions">
                                <button className="export-btn primary" onClick={onClose}>Done</button>
                            </div>
                        </>
                    ) : (
                        <>
                            <label className="export-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <Map size={13} /> Google Maps route link
                            </label>
                            <input
                                className="export-input"
                                value={gmapsUrl}
                                onChange={e => setGmapsUrl(e.target.value)}
                                placeholder="https://maps.app.goo.gl/…  (imported as a plan)"
                                title="Paste a shared directions link — the route is fetched via the Google Routes API and imported as a plan with turn cues"
                            />
                            <div
                                className="import-drop"
                                style={{ marginTop: 8, ...(dragOver ? { borderColor: 'var(--accent)', background: 'rgba(79,124,255,0.08)' } : undefined) }}
                                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                                onDragLeave={() => setDragOver(false)}
                                onDrop={e => { e.preventDefault(); setDragOver(false); handleDrop(e.dataTransfer) }}
                                onClick={() => inputRef.current?.click()}
                            >
                                <Upload size={18} />
                                <span>
                                    {files.length === 0
                                        ? 'Drop GPX/FIT/ZIP files or folders here, or click to browse'
                                        : `${files.length} file${files.length === 1 ? '' : 's'} ready — drop more or click to add`}
                                </span>
                                <input
                                    ref={inputRef}
                                    type="file"
                                    accept=".gpx,.fit,.zip"
                                    multiple
                                    style={{ display: 'none' }}
                                    // Programmatic .click() bubbles to the drop zone's onClick,
                                    // which would re-open the picker — keep it contained.
                                    onClick={e => e.stopPropagation()}
                                    onChange={e => { if (e.target.files) addFromInput(e.target.files); e.target.value = '' }}
                                />
                                <input
                                    ref={folderInputRef}
                                    type="file"
                                    multiple
                                    style={{ display: 'none' }}
                                    // Non-standard but universal: makes the picker select a
                                    // whole folder (recursively) instead of opening it.
                                    {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                                    // Without this, the click bubbles to the drop zone's onClick,
                                    // whose plain-files picker replaces the folder picker.
                                    onClick={e => e.stopPropagation()}
                                    onChange={e => { if (e.target.files) addFromInput(e.target.files); e.target.value = '' }}
                                />
                            </div>
                            <button
                                className="export-btn"
                                onClick={() => folderInputRef.current?.click()}
                                style={{ marginTop: 8, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                                title="Import a whole folder (recursively) — tracks are filed by locality server-side"
                            >
                                <FolderOpen size={14} /> Select a folder…
                            </button>
                            {files.length > 0 && (
                                <div className="export-manifest" style={{ maxHeight: 120 }}>
                                    {files.map(p => (
                                        <div key={`${p.path}:${p.file.size}`} className="export-manifest-row">
                                            <span className="export-manifest-path">{p.path}</span>
                                            <span className="export-manifest-meta">{Math.round(p.file.size / 1024)} KB</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                            <label className="export-label">Owner</label>
                            <OwnerPicker
                                value={selectedOwnerId}
                                onChange={setSelectedOwnerId}
                                placeholder="Choose owner…"
                                className="export-input"
                            />
                            <label className="export-label">Source</label>
                            <input
                                className="export-input"
                                value={source}
                                onChange={e => setSource(e.target.value)}
                                placeholder="wikiloc · dmd-hub · dsra · a mate's name…"
                                title="Free text — searchable later, and shown on each track"
                            />
                            <label className="export-label">Whose recordings</label>
                            <label className="export-check">
                                <input type="radio" checked={origin === 'other'} onChange={() => handleOriginChange('other')} />
                                Someone else's (blue on the heatmap)
                            </label>
                            <label className="export-check">
                                <input type="radio" checked={origin === 'self'} onChange={() => handleOriginChange('self')} />
                                My own recordings
                            </label>
                            {error && <div className="export-error">{error}</div>}
                            <div className="export-actions">
                                <button
                                    className="export-btn primary"
                                    disabled={busy || (files.length === 0 && !gmapsUrl.trim())}
                                    onClick={handleImport}
                                >
                                    {busy ? 'Importing…' : `Import ${files.length || (gmapsUrl.trim() ? 'route' : '')}`}
                                </button>
                                <button className="export-btn" onClick={onClose} disabled={busy}>Cancel</button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}
