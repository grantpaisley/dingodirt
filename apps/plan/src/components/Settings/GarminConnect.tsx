import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useGarminStatus, setGarminKey, syncGarmin, type GarminSyncResult } from '../../api/hooks'

const KEY_PAGE = 'https://connect.garmin.com/app/settings/personalApiToken'

/**
 * Pull your own Garmin Connect activities (original FIT files) with a
 * personal API key. The daemon stores the key and does the sync; this card
 * only sees the paste, a "…abcd" suffix and the refresh result. A refresh
 * pulls only activities newer than the newest own ride.
 */
export function GarminConnect() {
    const queryClient = useQueryClient()
    const { data: status } = useGarminStatus()
    const [open, setOpen] = useState(false)
    const [key, setKey] = useState('')
    const [busy, setBusy] = useState<'key' | 'sync' | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [result, setResult] = useState<GarminSyncResult | null>(null)

    const applyKey = async (value: string | null) => {
        setBusy('key')
        setError(null)
        try {
            await setGarminKey(value)
            queryClient.invalidateQueries({ queryKey: ['garmin-status'] })
            setKey('')
            setOpen(false)
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setBusy(null)
        }
    }

    const sync = async () => {
        setBusy('sync')
        setError(null)
        setResult(null)
        try {
            const r = await syncGarmin()
            setResult(r)
            queryClient.invalidateQueries({ queryKey: ['garmin-status'] })
            if (r.imported > 0) {
                // The same queries the import dialog refreshes.
                for (const k of ['rides', 'allRideMeta', 'rideLocations', 'heatmap', 'rideStats']) {
                    queryClient.invalidateQueries({ queryKey: [k] })
                }
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setBusy(null)
        }
    }

    const connected = status?.connected

    return (
        <div style={{ marginTop: 16, paddingTop: 8, borderTop: '1px solid var(--border-color)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, color: connected ? '#6bd06b' : '#e0a030' }}>
                    {connected ? `Garmin: connected · ${status?.key_suffix}` : 'Garmin: not connected'}
                </span>
                <span style={{ display: 'flex', gap: 8 }}>
                    {connected && (
                        <button onClick={() => applyKey(null)} disabled={busy !== null} style={linkBtn}>
                            Disconnect
                        </button>
                    )}
                    <button onClick={() => { setOpen(o => !o); setError(null) }} style={linkBtn}>
                        {open ? 'Cancel' : connected ? 'Replace key' : 'Connect'}
                    </button>
                </span>
            </div>

            {open && (
                <div style={{ marginTop: 6 }}>
                    <div style={{ color: 'var(--text-secondary)', fontSize: 10, lineHeight: 1.5, marginBottom: 4 }}>
                        Make a key on Garmin Connect under{' '}
                        <a href={KEY_PAGE} target="_blank" rel="noreferrer" style={{ color: '#4a9eff' }}>
                            Settings → Personal API
                        </a>{' '}
                        and paste it here. Garmin shows it only once.
                    </div>
                    <input
                        type="password"
                        value={key}
                        onChange={e => setKey(e.target.value)}
                        placeholder="Personal API key"
                        autoComplete="off"
                        spellCheck={false}
                        style={inputStyle}
                    />
                    <button
                        onClick={() => applyKey(key.trim())}
                        disabled={busy !== null || !key.trim()}
                        style={primaryBtn(busy !== null || !key.trim())}
                    >
                        {busy === 'key' ? 'Checking…' : 'Connect'}
                    </button>
                </div>
            )}

            {connected && !open && (
                <div style={{ marginTop: 6 }}>
                    <button onClick={sync} disabled={busy !== null} style={primaryBtn(busy !== null)}>
                        {busy === 'sync' ? 'Refreshing…' : 'Refresh'}
                    </button>
                    <div style={{ color: 'var(--text-secondary)', fontSize: 10, marginTop: 3 }}>
                        {status?.newest_ride ? `Gets activities after ${status.newest_ride} UTC` : 'Gets all activities'}
                    </div>
                    {result && <div style={{ color: 'var(--text-primary)', fontSize: 10, marginTop: 3 }}>{summary(result)}</div>}
                    {result?.failed.slice(0, 3).map(f => (
                        <div key={f.name} style={{ color: '#e0a030', fontSize: 10 }}>{f.name}: {f.error}</div>
                    ))}
                </div>
            )}
            {error && <div style={{ color: '#e74c3c', fontSize: 10, marginTop: 4 }}>{error}</div>}
        </div>
    )
}

function summary(r: GarminSyncResult): string {
    const parts = [`${r.imported} imported`]
    if (r.duplicates) parts.push(`${r.duplicates} already here`)
    if (r.skipped_no_gps) parts.push(`${r.skipped_no_gps} without GPS skipped`)
    if (r.failed.length) parts.push(`${r.failed.length} failed`)
    if (r.rate_limited) parts.push('stopped by the Garmin rate limit')
    if (r.remaining) parts.push(`${r.remaining} more — refresh again`)
    return parts.join(' · ')
}

const linkBtn: React.CSSProperties = {
    background: 'transparent', color: '#4a9eff', border: 'none',
    cursor: 'pointer', fontSize: 10, padding: 0,
}

const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', marginBottom: 4,
    background: 'var(--bg-dark)', color: 'var(--text-primary)', border: '1px solid var(--border-color)',
    borderRadius: 4, padding: 6, fontSize: 10, fontFamily: 'monospace',
}

const primaryBtn = (disabled: boolean): React.CSSProperties => ({
    width: '100%', padding: '5px 0',
    background: disabled ? 'var(--border-color)' : '#007cc3',
    color: 'white', border: 'none', borderRadius: 4,
    fontSize: 11, cursor: disabled ? 'default' : 'pointer',
})
