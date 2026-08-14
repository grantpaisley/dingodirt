/** .dingoscheme support for Dingo Plan — the preset catalogue vendored from
 *  Dingo Studio into /public/schemes (synced by DingoStudio/sync-appliers.sh).
 *
 *  Compatibility contract (Docs/plans/2026-08-02-dingo-studio-design.md):
 *  apps IGNORE unknown tokens and DEFAULT missing tokens; a scheme is values
 *  only, never executable style JSON; schemaVersion major mismatch rejects.
 */
import { useEffect, useState } from 'react'

export interface DingoScheme {
    name?: string
    author?: string
    version?: number
    schemaVersion?: string
    tokens?: Record<string, unknown>
    night?: Record<string, unknown>
}

export interface SchemeEntry {
    id: string
    label: string
    file: string
}

/** Effective token value: scheme's if set, else the canonical registry
 *  default (core/appliers TOKEN_DEFS) — the local defaults copy is gone,
 *  so Plan can never drift from Nav/Studio on a missing token. */
export { tok } from '../../../../core/appliers/scheme.js'

let indexPromise: Promise<SchemeEntry[]> | null = null

/** Preset catalogue, fetched once per session. Missing or malformed manifest
 *  degrades to "no schemes" rather than an error (same shape as the local
 *  style manifest in mapStyles.ts). */
export function fetchSchemeIndex(): Promise<SchemeEntry[]> {
    // BASE_URL, not a leading slash: Plan is served from a subpath on GitHub
    // Pages (/dingodirt/plan/) and '/schemes/…' would resolve against the
    // domain root. Vite sets BASE_URL from `base` and it always ends in '/'.
    indexPromise ??= fetch(`${import.meta.env.BASE_URL}schemes/index.json`)
        .then(r => (r.ok ? r.json() : []))
        .then((entries: unknown) => (Array.isArray(entries) ? entries : [])
            .filter((e): e is SchemeEntry =>
                !!e && typeof e.id === 'string' && typeof e.file === 'string'))
        .catch(() => [])
    return indexPromise
}

const schemeCache = new Map<string, DingoScheme>()

/** Fetch (or return cached) a preset by catalogue id. Throws on missing file
 *  or a schemaVersion major mismatch — never applies a scheme it can't read. */
export async function getScheme(id: string): Promise<DingoScheme> {
    const cached = schemeCache.get(id)
    if (cached) return cached
    const entry = (await fetchSchemeIndex()).find(e => e.id === id)
    if (!entry) throw new Error(`unknown scheme '${id}'`)
    const res = await fetch(`${import.meta.env.BASE_URL}schemes/${entry.file}`)
    if (!res.ok) throw new Error(`failed to load scheme '${id}': ${res.status}`)
    const scheme = await res.json() as DingoScheme
    const major = parseInt(String(scheme.schemaVersion ?? ''), 10)
    if (major !== 1) throw new Error(`scheme '${id}' needs schema v${scheme.schemaVersion} — update the app`)
    schemeCache.set(id, scheme)
    return scheme
}

/** Catalogue as react state — empty until loaded. */
export function useSchemeIndex(): SchemeEntry[] {
    const [entries, setEntries] = useState<SchemeEntry[]>([])
    useEffect(() => {
        let alive = true
        fetchSchemeIndex().then(e => { if (alive) setEntries(e) })
        return () => { alive = false }
    }, [])
    return entries
}
