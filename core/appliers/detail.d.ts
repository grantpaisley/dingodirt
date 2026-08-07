/* Hand-maintained declarations for TypeScript consumers (Plan). See the note
   in scheme.d.ts — deliberately loose. */

import type { StyleLayerLike } from './applier-nav'

export type DetailLevel = 'populated' | 'regional' | 'outback'

export const DETAIL_LEVELS: DetailLevel[]
export const DETAIL_BIAS: Record<DetailLevel, number>
export const DETAIL_LAYER_IDS: Set<string>
export function applyDetailBias<T extends StyleLayerLike>(layersArr: T[], level: string): T[]
