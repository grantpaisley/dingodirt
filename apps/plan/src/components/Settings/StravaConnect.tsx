import { useState, useEffect, useCallback } from 'react'
import { SERVER_BASE } from '../../api/hooks'

/**
 * Connect the Strava global heatmap overlay by pasting the CloudFront cookies
 * from a logged-in strava.com session. Headless login is dead (React SPA +
 * reCAPTCHA), so this manual paste is the connection mechanism — the daemon
 * caches the cookies and proxies authenticated tiles. Refresh ~weekly when the
 * cookies expire (a tile fetch starts 409-ing and the overlay goes blank).
 *
 * IMPORTANT: the heatmap signing cookies are scoped to
 * heatmap-external-*.strava.com, so they do NOT appear in DevTools'
 * Application → Cookies under www.strava.com — the CloudFront-* rows there
 * belong to Strava's content CDN and CloudFront rejects them with InvalidKey.
 * The only place to read the right trio manually is a tiles-auth request's
 * Cookie header in the Network tab (or via the connector extension).
 */
const STRAVA_API = `${SERVER_BASE}/api/strava-heatmap`

type Status = { connected: boolean; updated_at: string | null }

const COOKIE_NAMES = ['CloudFront-Key-Pair-Id', 'CloudFront-Policy', 'CloudFront-Signature'] as const

/** Pull the three CloudFront values out of a raw Cookie-header paste. */
function parseRawCookie(text: string): { kp?: string, policy?: string, sig?: string } {
    const grab = (name: string) => text.match(new RegExp(`${name}=([^;\\s]+)`))?.[1]
    return {
        kp: grab(COOKIE_NAMES[0]),
        policy: grab(COOKIE_NAMES[1]),
        sig: grab(COOKIE_NAMES[2]),
    }
}

/** Decode a CloudFront policy (base64 with the -_~ substitutions CloudFront
 *  uses) and warn about the classic traps: the content-CDN cookie set that
 *  DevTools shows under www.strava.com, and an already-expired set. Returns
 *  null when the policy looks usable or can't be decoded (server will judge). */
function policyWarning(policy: string): string | null {
    try {
        const json = atob(policy.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'))
        const stmt = JSON.parse(json)?.Statement?.[0]
        const resource: string = stmt?.Resource ?? ''
        if (resource && !resource.includes('heatmap')) {
            return `This set is signed for ${resource} — a different Strava CDN, not the heatmap. ` +
                'Copy the cookies from a tiles-auth request in the Network tab (not the Application tab).'
        }
        const exp = stmt?.Condition?.DateLessThan?.['AWS:EpochTime']
        if (typeof exp === 'number' && exp * 1000 < Date.now()) {
            return 'This cookie set has already expired — reload the heatmap page and grab a fresh one.'
        }
    } catch { /* not decodable — let the daemon try it */ }
    return null
}

export function StravaConnect() {
    const [status, setStatus] = useState<Status | null>(null)
    const [open, setOpen] = useState(false)
    const [kp, setKp] = useState('')
    const [policy, setPolicy] = useState('')
    const [sig, setSig] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const refresh = useCallback(async () => {
        try {
            const res = await fetch(`${STRAVA_API}/status`)
            if (res.ok) setStatus(await res.json())
        } catch { /* daemon down — leave status null */ }
    }, [])

    useEffect(() => { refresh() }, [refresh])

    // Pasting a whole Cookie header into any field fills all three.
    const smartPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
        const text = e.clipboardData.getData('text')
        const { kp: k, policy: p, sig: s } = parseRawCookie(text)
        if (k && p && s) {
            e.preventDefault()
            setKp(k); setPolicy(p); setSig(s)
        }
    }

    const complete = kp.trim() && policy.trim() && sig.trim()
    const warning = policy.trim() ? policyWarning(policy.trim()) : null

    const save = async () => {
        setBusy(true)
        setError(null)
        try {
            const res = await fetch(`${STRAVA_API}/cookies`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    key_pair_id: kp.trim(),
                    policy: policy.trim(),
                    signature: sig.trim(),
                }),
            })
            if (!res.ok) {
                setError(await res.text())
            } else {
                setStatus(await res.json())
                setKp(''); setPolicy(''); setSig('')
                setOpen(false)
            }
        } catch (e) {
            setError(String(e))
        } finally {
            setBusy(false)
        }
    }

    const connected = status?.connected
    const ago = status?.updated_at ? timeAgo(status.updated_at) : null

    return (
        <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid #444' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, color: connected ? '#6bd06b' : '#e0a030' }}>
                    {connected ? `Strava connected${ago ? ` · ${ago}` : ''}` : 'Strava not connected'}
                </span>
                <button
                    onClick={() => setOpen(o => !o)}
                    style={linkBtn}
                >
                    {open ? 'Cancel' : connected ? 'Reconnect' : 'Connect'}
                </button>
            </div>

            {open && (
                <div style={{ marginTop: 6 }}>
                    <ol style={{ margin: '0 0 6px', paddingLeft: 16, color: '#999', fontSize: 10, lineHeight: 1.5 }}>
                        <li>Easiest: click the Dingo connector extension on strava.com — done.</li>
                        <li>Manually: open <span style={{ color: '#ccc' }}>strava.com/maps/global-heatmap</span> logged in.</li>
                        <li>DevTools (⌥⌘I) → <span style={{ color: '#ccc' }}>Network</span> → filter <span style={{ color: '#ccc' }}>tiles-auth</span>, pan the map.</li>
                        <li>Click a tile request → Request Headers → copy the <span style={{ color: '#ccc' }}>Cookie</span> value, paste into any field below (it auto-splits). The Application-tab cookies under www.strava.com are the WRONG set.</li>
                    </ol>
                    {([
                        [COOKIE_NAMES[0], kp, setKp],
                        [COOKIE_NAMES[1], policy, setPolicy],
                        [COOKIE_NAMES[2], sig, setSig],
                    ] as const).map(([name, value, set]) => (
                        <input
                            key={name}
                            value={value}
                            onChange={e => set(e.target.value)}
                            onPaste={smartPaste}
                            placeholder={name}
                            spellCheck={false}
                            style={{
                                width: '100%', boxSizing: 'border-box', marginBottom: 4,
                                background: '#1a1a1a', color: 'white', border: '1px solid #444',
                                borderRadius: 4, padding: 6, fontSize: 10, fontFamily: 'monospace',
                            }}
                        />
                    ))}
                    {warning && <div style={{ color: '#e0a030', fontSize: 10, marginTop: 2 }}>⚠️ {warning}</div>}
                    {error && <div style={{ color: '#e74c3c', fontSize: 10, marginTop: 4 }}>{error}</div>}
                    <button
                        onClick={save}
                        disabled={busy || !complete}
                        style={{
                            marginTop: 6, width: '100%', padding: '5px 0',
                            background: busy || !complete ? '#333' : '#fc5200',
                            color: 'white', border: 'none', borderRadius: 4,
                            fontSize: 11, cursor: busy || !complete ? 'default' : 'pointer',
                        }}
                    >
                        {busy ? 'Saving…' : 'Save cookies'}
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

function timeAgo(iso: string): string {
    const secs = (Date.now() - new Date(iso).getTime()) / 1000
    if (secs < 90) return 'just now'
    const mins = secs / 60
    if (mins < 90) return `${Math.round(mins)}m ago`
    const hrs = mins / 60
    if (hrs < 36) return `${Math.round(hrs)}h ago`
    return `${Math.round(hrs / 24)}d ago`
}
