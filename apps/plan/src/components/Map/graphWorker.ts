/// <reference lib="webworker" />
/* The track graph, off the main thread.
 *
 * Building over a viewport of tracks is tens of thousands of vertices and a
 * grid pass over all of them. On the main thread that stutters the map
 * mid-draw, which is exactly when route mode is in use. The graph lives
 * here, and only legs cross back.
 *
 * The engine itself is canonical in core/track-graph/graph.js — plain ESM so
 * the root `node --test` job covers it, and so the daemon-side build of
 * stage 2 has one behaviour to match. */
import {
    buildGraph,
    routeBetween,
    type GraphTrack,
    type LonLat,
    type TrackGraph,
} from '../../../../../core/track-graph/graph.js'

export type GraphRequest =
    | { type: 'build', id: number, tracks: GraphTrack[] }
    | { type: 'route', id: number, from: LonLat, to: LonLat, tolM: number }

export type GraphResponse =
    | { type: 'built', id: number, nodeCount: number, trackCount: number, corridorRuns: number, ms: number }
    | { type: 'leg', id: number, path: LonLat[], km: number, seconds: number, straight: boolean }
    | { type: 'error', id: number, message: string }

let graph: TrackGraph | null = null

self.onmessage = (e: MessageEvent<GraphRequest>) => {
    const msg = e.data
    try {
        if (msg.type === 'build') {
            const t0 = performance.now()
            graph = buildGraph(msg.tracks)
            const res: GraphResponse = {
                type: 'built',
                id: msg.id,
                nodeCount: graph.nodeCount,
                trackCount: graph.ids.length,
                corridorRuns: graph.corridorRuns,
                ms: Math.round(performance.now() - t0),
            }
            self.postMessage(res)
            return
        }
        if (msg.type === 'route') {
            if (!graph) throw new Error('no graph built yet')
            const leg = routeBetween(graph, msg.from, msg.to, msg.tolM)
            const res: GraphResponse = {
                type: 'leg',
                id: msg.id,
                path: leg.path,
                km: leg.km,
                seconds: leg.seconds,
                straight: leg.straight,
            }
            self.postMessage(res)
        }
    } catch (err) {
        const res: GraphResponse = {
            type: 'error',
            id: msg.id,
            message: err instanceof Error ? err.message : String(err),
        }
        self.postMessage(res)
    }
}
