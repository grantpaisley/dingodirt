/* Hand-maintained declarations for TypeScript consumers (Plan). See the note
   in scheme.d.ts — deliberately loose. A "layer" here is any MapLibre layer
   object; the applier only reads `id`/`type` and merges `paint`. */

import type { SchemeLike } from './scheme'

export interface StyleLayerLike {
    id: string
    type: string
    paint?: Record<string, unknown>
    [key: string]: unknown
}

export const BASE_MAP: Record<string, [string[], string]>

export type PaintOverrides = Record<string, Record<string, unknown>>

export function basePaintOverrides(scheme: SchemeLike): PaintOverrides
export function applyBaseOverrides<T extends StyleLayerLike>(layersArr: T[], ov: PaintOverrides): T[]
export function hillPaint(scheme: SchemeLike): Record<string, unknown> | null
export function advOverrides(scheme: SchemeLike): Record<string, unknown>
export function markColors(scheme: SchemeLike): Record<string, unknown>
export function cssVars(scheme: SchemeLike): Record<string, string>
export function applyScheme(scheme: SchemeLike, baseLayers?: StyleLayerLike[] | null): {
    base: unknown
    layers: StyleLayerLike[] | null
    overrides: PaintOverrides
    hill: Record<string, unknown> | null
    adv: Record<string, unknown>
    marks: Record<string, unknown>
    css: Record<string, string>
}
