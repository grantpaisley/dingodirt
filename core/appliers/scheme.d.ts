/* Hand-maintained declarations for TypeScript consumers (Plan imports these
   modules directly through relative paths — same canonical copy the no-build
   apps reach through symlinks). Kept deliberately loose: the runtime contract
   is "values only, unknown ignored", so precise token typing would only rot. */

export const SCHEMA_VERSION: string

export interface TokenDef {
    type: 'color' | 'number' | 'bool' | 'select'
    def: unknown
    label: string
    min?: number
    max?: number
    step?: number
    opts?: string[]
}

export interface TokenGroup {
    key: string
    label: string
    tokens: Record<string, TokenDef>
}

export interface SchemeLike {
    name?: string
    author?: string
    version?: number
    schemaVersion?: string
    tokens?: Record<string, unknown>
    night?: Record<string, unknown>
}

export const TOKEN_GROUPS: TokenGroup[]
export const TOKEN_DEFS: Record<string, TokenDef>
export function defaultTokens(): Record<string, unknown>
export function tok(scheme: SchemeLike, key: string): unknown
export function newScheme(name?: string, author?: string): SchemeLike
export function resolveScheme(scheme: SchemeLike, mode?: 'day' | 'night'): SchemeLike
export function validateScheme(obj: unknown): SchemeLike & { unknown: string[] }
