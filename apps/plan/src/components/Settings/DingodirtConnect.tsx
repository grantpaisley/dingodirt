import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useDingodirtStatus, setDingodirtToken } from '../../api/hooks'

/**
 * Connect Plan to a dingodirt.com account: paste an API token minted on the
 * site's dashboard ("API tokens" card). The daemon stores it and publishes
 * packs with it; this card only ever sees the paste and a ddt_… suffix back.
 */
export function DingodirtConnect() {
    const queryClient = useQueryClient()
    const { data: status } = useDingodirtStatus()
    const [open, setOpen] = useState(false)
    const [token, setToken] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const apply = async (value: string | null) => {
        setBusy(true)
        setError(null)
        try {
            await setDingodirtToken(value)
            queryClient.invalidateQueries({ queryKey: ['dingodirt-status'] })
            setToken('')
            setOpen(false)
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setBusy(false)
        }
    }

    const connected = status?.connected
    const site = status?.site?.replace(/^https?:\/\//, '') ?? 'dingodirt.com'

    return (
        <div style={{ marginTop: 16, paddingTop: 8, borderTop: '1px solid #444' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, color: connected ? '#6bd06b' : '#e0a030' }}>
                    {connected
                        ? `${site}: ${status?.name || status?.email}${status?.token_suffix ? ` · ${status.token_suffix}` : ''}`
                        : status?.token_suffix
                            ? `${site}: token rejected (${status.token_suffix})`
                            : `${site}: not connected`}
                </span>
                <span style={{ display: 'flex', gap: 8 }}>
                    {connected && (
                        <button onClick={() => apply(null)} disabled={busy} style={linkBtn}>
                            Disconnect
                        </button>
                    )}
                    <button onClick={() => { setOpen(o => !o); setError(null) }} style={linkBtn}>
                        {open ? 'Cancel' : connected ? 'Replace token' : 'Connect'}
                    </button>
                </span>
            </div>
            {!connected && status?.error && !open && (
                <div style={{ color: '#e0a030', fontSize: 10, marginTop: 3 }}>{status.error}</div>
            )}

            {open && (
                <div style={{ marginTop: 6 }}>
                    <div style={{ color: '#999', fontSize: 10, lineHeight: 1.5, marginBottom: 4 }}>
                        Publishing packs needs a {site} account. Sign in there, create a
                        token under <span style={{ color: '#ccc' }}>My packs → API tokens</span>,
                        and paste it here.
                    </div>
                    <input
                        value={token}
                        onChange={e => setToken(e.target.value)}
                        placeholder="ddt_…"
                        spellCheck={false}
                        style={{
                            width: '100%', boxSizing: 'border-box', marginBottom: 4,
                            background: '#1a1a1a', color: 'white', border: '1px solid #444',
                            borderRadius: 4, padding: 6, fontSize: 10, fontFamily: 'monospace',
                        }}
                    />
                    {error && <div style={{ color: '#e74c3c', fontSize: 10, marginBottom: 4 }}>{error}</div>}
                    <button
                        onClick={() => apply(token.trim())}
                        disabled={busy || !token.trim()}
                        style={{
                            width: '100%', padding: '5px 0',
                            background: busy || !token.trim() ? '#333' : '#c96f2e',
                            color: 'white', border: 'none', borderRadius: 4,
                            fontSize: 11, cursor: busy || !token.trim() ? 'default' : 'pointer',
                        }}
                    >
                        {busy ? 'Checking…' : 'Connect'}
                    </button>
                </div>
            )}
        </div>
    )
}

const linkBtn: React.CSSProperties = {
    background: 'transparent', color: '#4a9eff', border: 'none',
    cursor: 'pointer', fontSize: 10, padding: 0,
}
