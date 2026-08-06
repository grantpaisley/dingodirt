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

/** Defaults for the tokens Plan consumes (subset of Studio's TOKEN_DEFS) —
 *  values match Nav/Studio factory so a sparse scheme changes nothing. */
const SCHEME_DEFAULTS: Record<string, unknown> = {
    'overlays.heatOwn': '#ff7a00',
    'overlays.heatPlan': '#3390ff',
    'overlays.heatOther': '#ff2d2d',
    'hud.bg': '#0e1216',
    'hud.panel': '#161c22',
    'hud.text': '#e8eef4',
    'hud.dim': '#8fa0b0',
    'hud.accent': '#00e5ff',
}

/** Effective token value: scheme's if set, else the registry default. */
export function tok(scheme: DingoScheme, key: string): unknown {
    const v = scheme.tokens?.[key]
    return v == null ? SCHEME_DEFAULTS[key] : v
}

let indexPromise: Promise<SchemeEntry[]> | null = null

/** Preset catalogue, fetched once per session. Missing or malformed manifest
 *  degrades to "no schemes" rather than an error (same shape as the local
 *  style manifest in mapStyles.ts). */
export function fetchSchemeIndex(): Promise<SchemeEntry[]> {
    indexPromise ??= fetch('/schemes/index.json')
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
    const res = await fetch(`/schemes/${entry.file}`)
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
