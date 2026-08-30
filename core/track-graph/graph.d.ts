/* Hand-maintained declarations for TypeScript consumers (Plan). Same
   convention as core/appliers/*.d.ts — deliberately loose where the shape is
   an internal detail of the build. */

export type LonLat = [number, number]

export interface GraphTrack {
  id: string
  path: LonLat[]
  /** The track's own average, km/h. Null on a planned route. */
  speedKmh?: number | null
  /** Ride mode, used when the track carries no average. */
  mode?: string | null
}

export interface TrackGraph {
  /** Track ids, in the order the graph indexes them. */
  ids: string[]
  lon: Float64Array
  lat: Float64Array
  trackOf: Int32Array
  segSec: Float64Array
  segM: Float64Array
  start: Int32Array
  end: Int32Array
  speeds: Float64Array
  links: Map<number, [number, number][]>
  nodeCount: number
  /** How many close approaches were judged parallel corridors, not junctions. */
  corridorRuns: number
  maxSegM: number
  cellLon: number
  cellLat: number
  near(x: number, y: number, r: number): number[]
}

export interface Snapped {
  a: number
  b: number
  secToA: number
  secToB: number
  point: LonLat
  distM: number
}

export interface Leg {
  path: LonLat[]
  km: number
  seconds: number
}

export const NEAR_M: number
export const ANGLE_DEG: number
export const RUN_M: number
export const TRANSFER_PENALTY_S: number
export const MODE_SPEED_KMH: Record<string, number>
export const DEFAULT_SPEED_KMH: number

export function speedMs(track: { speedKmh?: number | null; mode?: string | null }): number
export function buildGraph(
  tracks: GraphTrack[],
  opts?: { nearM?: number; angleDeg?: number; runM?: number },
): TrackGraph
export function snap(graph: TrackGraph, x: number, y: number, tolM?: number): Snapped | null
export function route(graph: TrackGraph, from: Snapped, to: Snapped): Leg | null
export function routeBetween(
  graph: TrackGraph,
  fromLonLat: LonLat,
  toLonLat: LonLat,
  tolM?: number,
): Leg & { straight: boolean }
export function directKm(fromLonLat: LonLat, toLonLat: LonLat): number
