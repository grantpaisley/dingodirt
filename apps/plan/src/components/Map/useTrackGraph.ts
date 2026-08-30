/* Route and measure modes' engine, seen from React.
 *
 * Owns one Web Worker, keeps the graph inside it in step with the tracks on
 * screen, and hands back a promise per leg. The graph is only built while a
 * tool that needs it is active — an idle Plan session pays nothing.
 *
 * Client-side today, over the viewport plus the margin the map already
 * fetched. When that limit starts to bite, `requestLeg` is the seam the
 * daemon's POST /api/route slides behind (see the design's stage 2). */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GraphRequest, GraphResponse } from './graphWorker'
import type { GraphTrack, LonLat } from '../../../../../core/track-graph/graph.js'

/** Wait this long after the tracks change before rebuilding. A pan fires
 *  many refetches; only the last one is worth a build. */
const DEBOUNCE_MS = 400

/** Vertex budget for one build. Measured on the real library: a Sydney-wide
 *  viewport is 1,291 tracks and 340k points, which costs ~3.3 s in the
 *  worker and a structured-clone big enough to stall the click that started
 *  it. Above the budget the nearest tracks to the viewport centre are kept
 *  and the rest are dropped — and the badge says how many, because a
 *  silently truncated graph reads as "no route exists". */
const VERTEX_BUDGET = 120_000

export interface GraphStatus {
    state: 'off' | 'building' | 'ready'
    trackCount: number
    nodeCount: number
    /** Close approaches judged parallel corridors rather than junctions —
     *  the fire-trail-beside-singletrack count, worth surfacing while the
     *  thresholds are still being tuned. */
    corridorRuns: number
    ms: number
    /** Tracks left out to stay inside the vertex budget. Never silent. */
    dropped: number
}

const IDLE: GraphStatus = { state: 'off', trackCount: 0, nodeCount: 0, corridorRuns: 0, ms: 0, dropped: 0 }

/** Keep the tracks nearest the centre of what is on screen until the vertex
 *  budget runs out. A route is laid where the map is looking, so the tracks
 *  under the cursor are the ones worth spending the budget on. */
function withinBudget(tracks: GraphTrack[]): { kept: GraphTrack[], dropped: number } {
    let total = 0
    for (const t of tracks) total += t.path.length
    if (total <= VERTEX_BUDGET) return { kept: tracks, dropped: 0 }

    let sumLon = 0, sumLat = 0, n = 0
    for (const t of tracks) {
        const mid = t.path[Math.floor(t.path.length / 2)]
        sumLon += mid[0]
        sumLat += mid[1]
        n++
    }
    const cx = sumLon / n
    const cy = sumLat / n
    const ranked = tracks
        .map(t => {
            const mid = t.path[Math.floor(t.path.length / 2)]
            return { t, d2: (mid[0] - cx) ** 2 + (mid[1] - cy) ** 2 }
        })
        .sort((a, b) => a.d2 - b.d2)

    const kept: GraphTrack[] = []
    let used = 0
    for (const { t } of ranked) {
        if (used + t.path.length > VERTEX_BUDGET) continue
        kept.push(t)
        used += t.path.length
    }
    return { kept, dropped: tracks.length - kept.length }
}

export interface RoutedLeg {
    path: LonLat[]
    km: number
    seconds: number
    /** No track connects the two points: this leg is the direct line. */
    straight: boolean
}

/**
 * @param tracks  the tracks currently on the map (id, path, speed, mode)
 * @param active  whether a tool needs the graph right now
 */
export function useTrackGraph(tracks: GraphTrack[], active: boolean) {
    const workerRef = useRef<Worker | null>(null)
    const nextId = useRef(1)
    const pending = useRef(new Map<number, (leg: RoutedLeg | null) => void>())
    const [status, setStatus] = useState<GraphStatus>(IDLE)
    const buildId = useRef(0)
    const droppedRef = useRef(0)
    const built = useRef(false)
    /** Clicks that arrived while the first graph was still building. Holding
     *  them beats answering with a straight line the user did not ask for. */
    const waiting = useRef<(() => void)[]>([])

    // One worker for the session, torn down with the map.
    useEffect(() => {
        const worker = new Worker(new URL('./graphWorker.ts', import.meta.url), {
            type: 'module',
        })
        worker.onmessage = (e: MessageEvent<GraphResponse>) => {
            const msg = e.data
            if (msg.type === 'built') {
                // A stale build finishing after a newer one must not claim
                // to be the current graph.
                if (msg.id !== buildId.current) return
                setStatus({
                    state: 'ready',
                    trackCount: msg.trackCount,
                    nodeCount: msg.nodeCount,
                    corridorRuns: msg.corridorRuns,
                    ms: msg.ms,
                    dropped: droppedRef.current,
                })
                built.current = true
                const held = waiting.current
                waiting.current = []
                for (const go of held) go()
                return
            }
            const resolve = pending.current.get(msg.id)
            if (!resolve) return
            pending.current.delete(msg.id)
            resolve(msg.type === 'leg'
                ? { path: msg.path, km: msg.km, seconds: msg.seconds, straight: msg.straight }
                : null)
        }
        workerRef.current = worker
        const inFlight = pending.current
        return () => {
            worker.terminate()
            workerRef.current = null
            inFlight.clear()
        }
    }, [])

    // Keep the worker's graph in step with what is on screen. Only the
    // geometry matters, so the effect keys on a cheap signature rather than
    // the array identity, which changes on every viewport refetch.
    const signature = active
        ? `${tracks.length}:${tracks.reduce((n, t) => n + t.path.length, 0)}:${tracks[0]?.id ?? ''}:${tracks[tracks.length - 1]?.id ?? ''}`
        : ''
    const tracksRef = useRef(tracks)
    // Declared BEFORE the build effect so the ref is already fresh when that
    // one runs; the build itself reads it a debounce later in any case.
    useEffect(() => {
        tracksRef.current = tracks
    })

    // Every status change happens inside the timer, not synchronously in the
    // effect: the badge then reports what is actually happening (a build
    // starts after the debounce, not when the tracks moved).
    useEffect(() => {
        if (!active) {
            const off = window.setTimeout(() => {
                built.current = false
                setStatus(IDLE)
            }, 0)
            return () => window.clearTimeout(off)
        }
        const timer = window.setTimeout(() => {
            const worker = workerRef.current
            if (!worker) return
            setStatus(s => ({ ...s, state: 'building' }))
            const id = ++buildId.current
            const { kept, dropped } = withinBudget(tracksRef.current)
            droppedRef.current = dropped
            const req: GraphRequest = {
                type: 'build',
                id,
                tracks: kept.map(t => ({
                    id: t.id,
                    path: t.path,
                    speedKmh: t.speedKmh ?? null,
                    mode: t.mode ?? null,
                })),
            }
            worker.postMessage(req)
        }, DEBOUNCE_MS)
        return () => window.clearTimeout(timer)
    }, [active, signature])

    /** One leg, from a point to a point. Resolves null only if the worker
     *  died or no graph exists yet — a missing connection comes back as a
     *  leg with `straight: true`. */
    const requestLeg = useCallback(
        async (from: LonLat, to: LonLat, tolM = 40): Promise<RoutedLeg | null> => {
            if (!workerRef.current) return null
            // The first build takes a second or two over a busy viewport. A
            // click in that window waits for it rather than being answered
            // with a straight line.
            if (!built.current) {
                await new Promise<void>(go => waiting.current.push(go))
            }
            const worker = workerRef.current
            if (!worker) return null
            const id = ++nextId.current + 1_000_000
            const req: GraphRequest = { type: 'route', id, from, to, tolM }
            return new Promise(resolve => {
                pending.current.set(id, resolve)
                worker.postMessage(req)
            })
        },
        [],
    )

    return { status, requestLeg }
}

/** `4 h 40 m`, `48 m`, `35 s` — the readout format for a leg's time. */
export function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '—'
    if (seconds < 60) return `${Math.round(seconds)} s`
    const mins = Math.round(seconds / 60)
    if (mins < 60) return `${mins} m`
    const h = Math.floor(mins / 60)
    return `${h} h ${mins % 60} m`
}
