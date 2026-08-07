import { useQuery, useQueries, keepPreviousData } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

// Daemon base URL. Local dev talks straight to the daemon on :3000; a hosted
// build (e.g. dingodirt.com) sets VITE_API_URL at build time to wherever the
// daemon is reachable.
export const SERVER_BASE: string = import.meta.env.VITE_API_URL || 'http://localhost:3000'
const API_BASE = `${SERVER_BASE}/api`

// CSRF gate: the daemon rejects any non-GET without this header (see
// crates/daemon/src/lib.rs). A cross-origin page can't set a custom header
// without a preflight the daemon denies, so only our own web app can mutate.
const WEB_HEADER: Record<string, string> = { 'x-dingo-web': '1' }

export interface RideSummary {
    id: string
    name: string | null
    started_at: string | null
    distance_m: number | null
    duration_s: number | null
    /** Elapsed minus detected stops — Garmin-style moving time */
    moving_s: number | null
    mode: string
    /** own = recorded (timestamped); other = someone else's; plan = route or
     *  timestamp-less track — anything with speed/duration is a recording */
    class: 'own' | 'other' | 'plan'
    avg_hr: number | null
    max_hr: number | null
    avg_speed: number | null  // km/h
    max_speed: number | null  // km/h
    /** Where the track came from (wikiloc / dsra / strava / a mate's name) */
    source: string | null
    /** Difficulty 1-5 (Grant's scale, manually assigned); null = ungraded */
    grade: number | null
    /** Whose track this is (owners table); null only on lean id-only rows */
    owner_id: string | null
    /** Owner display name ("Grant", "Fabio", "Strava global") */
    owner: string | null
    state: string | null
    region: string | null
    /** All LGAs the ride passes through, in first-encounter order */
    lgas: string[] | null
    /** All suburbs the ride passes through, in first-encounter order */
    suburbs: string[] | null
    /** true = loop (start ≈ end); false = point-to-point; null = degenerate */
    is_loop: boolean | null
    /** recorded = a real ride; planned = an imported/curated route (no timings) */
    kind?: 'recorded' | 'planned'
    /** Collection label grouping a planned-route network ("GOAT NSW North") */
    collection?: string | null
    /** Stored display colour ('#rrggbb') for planned routes */
    color?: string | null
    geometry: {
        type: 'LineString'
        coordinates: [number, number][]
    } | null
}

export interface RideDetail {
    id: string
    name: string | null
    started_at: string | null
    ended_at: string | null
    distance_m: number | null
    duration_s: number | null
    elevation_gain: number | null
    elevation_loss: number | null
    avg_speed: number | null
    max_speed: number | null
    avg_hr: number | null
    max_hr: number | null
    condition: string | null
    time_of_day: string | null
    mode: string
    /** Where the track came from (wikiloc / dsra / strava / a mate's name) */
    source: string | null
    /** Difficulty 1-5; null = ungraded */
    grade: number | null
    /** Whose track this is (owners table) */
    owner: { id: string, name: string, kind: string }
    /** Track name from inside the source file (e.g. "Hampton ATV") */
    original_name: string | null
    /** Original filename as uploaded/ingested */
    file_name: string | null
    imported_at: string
    /** Source folder when genuinely known (CLI ingest); null for web uploads */
    imported_from: string | null
    /** Where the exported GPX lives in the library tree */
    library_path: string | null
    state: string | null
    region: string | null
    /** All LGAs the ride passes through, in first-encounter order */
    lgas: string[] | null
    /** All suburbs the ride passes through, in first-encounter order */
    suburbs: string[] | null
    /** recorded = a real ride; planned = an imported/curated route (no timings) */
    kind?: 'recorded' | 'planned'
    /** Collection label grouping a planned-route network ("GOAT NSW North") */
    collection?: string | null
    /** Stored display colour ('#rrggbb') for planned routes */
    color?: string | null
    /** Planned-route notes (closures, permits) — plain text with \n line
     *  breaks that must be rendered preserved (white-space: pre-wrap). */
    description?: string | null
    geometry: {
        type: 'LineString'
        coordinates: [number, number][]
    } | null
    time_series: unknown[] | null
}

export interface RidePoint {
    idx: number
    lon: number
    lat: number
    elevation: number | null
    timestamp: string | null
    heart_rate: number | null
    speed: number | null
    /** Cumulative distance along the ride (m) — grade = Δelevation/Δdistance */
    distance_m: number | null
}

export interface Bounds {
    minLon: number
    minLat: number
    maxLon: number
    maxLat: number
}

/** Resolution tier for ride geometry — the server simplifies + trims
 *  coordinate precision per tier, which keeps a 30k-ride zoomed-out
 *  viewport payload parseable. Same tiering as the heatmap. */
export function rideTier(zoom: number): number {
    return zoom < 11 ? 10 : zoom < 15 ? 14 : 16
}

async function fetchRides(bounds?: Bounds, tier?: number, q?: string): Promise<RideSummary[]> {
    const params = new URLSearchParams()
    if (bounds) {
        params.set('bounds', `${bounds.minLon},${bounds.minLat},${bounds.maxLon},${bounds.maxLat}`)
    }
    if (tier != null) params.set('zoom', String(tier))
    if (q && q.trim()) params.set('q', q.trim())
    const url = params.toString() ? `${API_BASE}/rides?${params}` : `${API_BASE}/rides`
    const res = await fetch(url)
    if (!res.ok) throw new Error('Failed to fetch rides')
    return res.json()
}

export async function fetchRidesByIds(ids: string[]): Promise<RideSummary[]> {
    if (ids.length === 0) return []
    // Chunked: a folder selection can be thousands of ids, and they travel in
    // the query string — 300 ids ≈ 11 KB URLs, safely under server limits.
    const out: RideSummary[] = []
    for (let i = 0; i < ids.length; i += 300) {
        const chunk = ids.slice(i, i + 300)
        const params = new URLSearchParams({ ids: chunk.join(','), limit: '10000' })
        const res = await fetch(`${API_BASE}/rides?${params}`)
        if (!res.ok) throw new Error('Failed to fetch rides by id')
        out.push(...await res.json())
    }
    // Server returns rows in its own order; restore the caller's id order so
    // basket/selection lists stay stable across chunk boundaries (audit low).
    const byId = new Map(out.map(r => [r.id, r]))
    return ids.map(id => byId.get(id)).filter((r): r is RideSummary => !!r)
}

export interface RideStats {
    ride_count: number
    total_distance_m: number | null
    first_date: string | null
    last_date: string | null
}

async function fetchRideStats(): Promise<RideStats> {
    const res = await fetch(`${API_BASE}/rides/stats`)
    if (!res.ok) throw new Error('Failed to fetch ride stats')
    return res.json()
}

async function fetchRide(id: string): Promise<RideDetail> {
    const res = await fetch(`${API_BASE}/rides/${id}`)
    if (!res.ok) throw new Error('Failed to fetch ride')
    return res.json()
}

async function fetchRidePoints(id: string): Promise<RidePoint[]> {
    const res = await fetch(`${API_BASE}/rides/${id}/points`)
    if (!res.ok) throw new Error('Failed to fetch ride points')
    return res.json()
}

export function useRides(bounds?: Bounds, zoom?: number, q?: string) {
    const tier = zoom != null ? rideTier(zoom) : undefined
    const query = q?.trim() || ''
    return useQuery({
        queryKey: [
            'rides',
            bounds ? `${bounds.minLon},${bounds.minLat},${bounds.maxLon},${bounds.maxLat}` : 'all',
            tier ?? 'full',
            query,
        ],
        queryFn: () => fetchRides(bounds, tier, query),
        placeholderData: keepPreviousData,
    })
}

/** Full summaries for a specific set of ride ids — used for a multi-selection's
 *  aggregate stats, so rides older than the list cap aren't silently dropped. */
export function useRidesByIds(ids: string[]) {
    const key = [...ids].sort().join(',')
    return useQuery({
        queryKey: ['ridesByIds', key],
        queryFn: () => fetchRidesByIds(ids),
        enabled: ids.length > 0,
        placeholderData: keepPreviousData,
    })
}

/** Library-wide aggregate totals (count, distance, date range) computed in SQL. */
export function useRideStats() {
    return useQuery({
        queryKey: ['rideStats'],
        queryFn: fetchRideStats,
        staleTime: 5 * 60 * 1000,
    })
}

export function useRide(id: string | undefined) {
    return useQuery({
        queryKey: ['ride', id],
        queryFn: () => fetchRide(id!),
        enabled: !!id,
        // Hover-previews sweep across many tracks — show the previous ride
        // while the next loads instead of flashing a loading state each time.
        placeholderData: keepPreviousData,
    })
}

export function useRidePoints(id: string | undefined) {
    return useQuery({
        queryKey: ['ridePoints', id],
        queryFn: () => fetchRidePoints(id!),
        enabled: !!id,
    })
}

export function useAllRidePoints(ids: string[]) {
    return useQueries({
        queries: ids.map(id => ({
            queryKey: ['ridePoints', id],
            queryFn: () => fetchRidePoints(id),
            staleTime: 5 * 60 * 1000, // Cache for 5 minutes
        })),
        combine: (results) => ({
            // Map with the ORIGINAL index so each result keeps its own ride id,
            // THEN drop the incomplete ones. Filtering first collapses the array,
            // so `ids[i]` would attribute one ride's points to another whenever
            // any query is still pending or errored.
            data: results
                .map((r, i) => (r.isSuccess && r.data ? { rideId: ids[i], points: r.data } : null))
                .filter((x): x is { rideId: string; points: RidePoint[] } => x !== null),
            isLoading: results.some(r => r.isLoading),
            isError: results.some(r => r.isError),
        })
    })
}

// ---- Heatmap ----

export interface HeatTrack {
    id: string
    class: 'own' | 'other' | 'plan'
    mode: string
    started_at: string | null
    has_hr: boolean
    has_speed: boolean
    /** Present only on planned rows (kind='planned' rides): the collection
     *  label and stored display colour. Their presence is what distinguishes
     *  a curated planned route from a hand-drawn plan-class track. */
    collection?: string | null
    color?: string | null
    geometry: {
        type: 'LineString'
        coordinates: [number, number][]
    } | null
}

/** Resolution tier for the heatmap fetch. Coarse tier is bounds-free (the
 *  whole dataset simplified ~100m is a small payload and caches once);
 *  finer tiers fetch an expanded, grid-quantised viewport so panning
 *  nearby stays on the cached response. */
export function heatTier(zoom: number): number {
    return zoom < 11 ? 10 : zoom < 15 ? 14 : 16
}

/** Expand the viewport by half its size each side, then snap outward to a
 *  0.1° grid — a stable react-query key while panning locally. */
function quantizeBounds(b: Bounds): Bounds {
    const padLon = (b.maxLon - b.minLon) / 2
    const padLat = (b.maxLat - b.minLat) / 2
    const g = 0.1
    const down = (v: number) => Math.floor(v / g) * g
    const up = (v: number) => Math.ceil(v / g) * g
    return {
        minLon: +down(b.minLon - padLon).toFixed(4),
        minLat: +down(b.minLat - padLat).toFixed(4),
        maxLon: +up(b.maxLon + padLon).toFixed(4),
        maxLat: +up(b.maxLat + padLat).toFixed(4),
    }
}

export function useHeatmap(enabled: boolean, zoom: number, bounds?: Bounds) {
    const tier = heatTier(zoom)
    const params = new URLSearchParams({ zoom: String(tier) })
    if (tier > 10 && bounds) {
        const q = quantizeBounds(bounds)
        params.set('bounds', `${q.minLon},${q.minLat},${q.maxLon},${q.maxLat}`)
    }
    const qs = params.toString()
    return useQuery({
        queryKey: ['heatmap', qs],
        queryFn: async (): Promise<HeatTrack[]> => {
            const res = await fetch(`${API_BASE}/heatmap?${qs}`)
            if (!res.ok) throw new Error('Failed to fetch heatmap')
            return res.json()
        },
        enabled,
        staleTime: 5 * 60 * 1000,
        // Keep the previous tier on screen while the next one loads —
        // zooming never blanks the heat
        placeholderData: keepPreviousData,
    })
}

// ---- Planned-route collections & POIs ----

/** One planned-route collection (a curated network like "GOAT NSW North") */
export interface CollectionSummary {
    name: string
    route_count: number
    poi_count: number
    total_km: number
    /** [minLon, minLat, maxLon, maxLat]; null for a degenerate collection */
    bbox: [number, number, number, number] | null
}

export function useCollections() {
    return useQuery({
        queryKey: ['collections'],
        queryFn: async (): Promise<CollectionSummary[]> => {
            const res = await fetch(`${API_BASE}/collections`)
            if (!res.ok) throw new Error('Failed to fetch collections')
            return res.json()
        },
        staleTime: 5 * 60 * 1000,
    })
}

export interface Poi {
    id: string
    lon: number
    lat: number
    elevation?: number | null
    name: string
    description?: string | null
    category: string
    collection?: string | null
}

/** POIs for the (expanded, quantised) viewport. Category filtering happens
 *  client-side so toggling chips never refetches — same pattern as the
 *  heatmap's visibility filters. */
export function usePois(enabled: boolean, bounds?: Bounds) {
    const params = new URLSearchParams()
    if (bounds) {
        const q = quantizeBounds(bounds)
        params.set('bounds', `${q.minLon},${q.minLat},${q.maxLon},${q.maxLat}`)
    }
    const qs = params.toString()
    return useQuery({
        queryKey: ['pois', qs],
        queryFn: async (): Promise<Poi[]> => {
            const res = await fetch(`${API_BASE}/pois${qs ? `?${qs}` : ''}`)
            if (!res.ok) throw new Error('Failed to fetch POIs')
            return res.json()
        },
        enabled,
        staleTime: 5 * 60 * 1000,
        placeholderData: keepPreviousData,
    })
}

// ---- Photos ----

export interface PhotoSummary {
    id: string
    lon: number
    lat: number
    taken_at: string | null
    thumb_url: string    // server-relative; prefix with SERVER_BASE
    medium_url: string   // server-relative; prefix with SERVER_BASE
    google_photos_url: string | null
    ride_id: string | null
    match_method: string | null
}

export function usePhotos() {
    return useQuery({
        queryKey: ['photos'],
        queryFn: async (): Promise<PhotoSummary[]> => {
            const res = await fetch(`${API_BASE}/photos`)
            if (!res.ok) throw new Error('Failed to fetch photos')
            return res.json()
        },
        staleTime: 5 * 60 * 1000,
    })
}

// ---- Web import ----

// ---- Owners ----

export interface Owner {
    id: string
    kind: string
    email?: string
    name: string
}

export async function listOwners(): Promise<Owner[]> {
    const res = await fetch(`${API_BASE}/owners`, { method: 'GET', headers: WEB_HEADER })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
}

export function useOwners() {
    return useQuery({
        queryKey: ['owners'],
        queryFn: listOwners,
        staleTime: 5 * 60 * 1000,
    })
}

export async function createOwner(req: {
    kind: string
    email?: string
    name: string
}): Promise<Owner> {
    const res = await fetch(`${API_BASE}/owners`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...WEB_HEADER },
        body: JSON.stringify(req),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
}

// ---- Import ----

export interface ImportedFile {
    name: string
    rides: number
    duplicate: boolean
    error: string | null
    /** Library tree path(s) the ride(s) were filed at (null when ingest failed) */
    stored: string | null
}

/** A file queued for import plus the folder path it was picked with
 *  (display/dedupe only — the server derives placement from the track). */
export interface PickedFile {
    file: File
    path: string
}

export interface ImportResult {
    files: ImportedFile[]
    rides_created: number
    note: string
}

/** Upload GPX/FIT/ZIP files with a source tag, origin, and owner; they run through the
 *  normal ingest path, are cleaned + located server-side, and get filed into the
 *  library tree (each result row reports where its rides landed). */
export async function importFiles(
    files: PickedFile[],
    source: string,
    origin: 'self' | 'other',
    ownerId?: string,
): Promise<ImportResult> {
    const form = new FormData()
    if (source.trim()) form.set('source', source.trim())
    form.set('origin', origin)
    if (ownerId) form.set('owner_id', ownerId)
    for (const { file } of files) form.append('files', file, file.name)
    const res = await fetch(`${API_BASE}/import`, { method: 'POST', headers: WEB_HEADER, body: form })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
}

/** Import a Google Maps directions link as a plan: the daemon resolves the
 *  share link, routes the waypoints via the Google Routes API, and runs the
 *  synthesized GPX through the normal import pipeline. */
export async function importGmapsUrl(
    url: string,
    source: string,
    origin: 'self' | 'other',
    ownerId?: string,
): Promise<ImportResult> {
    const res = await fetch(`${API_BASE}/import/gmaps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...WEB_HEADER },
        body: JSON.stringify({
            url: url.trim(),
            source: source.trim() || undefined,
            origin,
            owner_id: ownerId,
        }),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
}

// ---- Plans (route drawer) ----

/** Save a drawn route as a plan-class ride. Returns the new ride id. */
export async function createPlan(req: {
    name: string
    mode?: string
    /** [lon, lat] vertices in draw order */
    coords: [number, number][]
}): Promise<{ id: string, name: string }> {
    const res = await fetch(`${API_BASE}/rides/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...WEB_HEADER },
        body: JSON.stringify(req),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
}

// ---- Areas ----

export interface AreaSummary {
    id: string
    name: string
    /** GeoJSON Polygon/MultiPolygon */
    boundary: {
        type: 'Polygon' | 'MultiPolygon'
        coordinates: number[][][] | number[][][][]
    }
}

export function useAreas(enabled: boolean) {
    return useQuery({
        queryKey: ['areas'],
        queryFn: async (): Promise<AreaSummary[]> => {
            const res = await fetch(`${API_BASE}/areas`)
            if (!res.ok) throw new Error('Failed to fetch areas')
            return res.json()
        },
        enabled,
        staleTime: 30 * 60 * 1000,
    })
}

// ---- Location hierarchy (Places view) ----

/** Distinct State/Region/LGA/Suburb combination with its live-ride count —
 *  the same keys the on-disk library tree is built from. */
export interface LocationLeaf {
    state: string
    region: string
    lga: string
    suburb: string
    count: number
    /** [minLon, minLat, maxLon, maxLat] of the tracks under this leaf */
    bbox: [number, number, number, number]
}

export function useLocations(enabled: boolean) {
    return useQuery({
        queryKey: ['rideLocations'],
        queryFn: async (): Promise<LocationLeaf[]> => {
            const res = await fetch(`${API_BASE}/rides/locations`)
            if (!res.ok) throw new Error('Failed to fetch locations')
            return res.json()
        },
        enabled,
        staleTime: 5 * 60 * 1000,
    })
}

/** Every live ride's summary metadata (no geometry) — the whole library is
 *  small enough to filter client-side, so the Places tree can share the exact
 *  filter semantics (rideMatchesFilters) with the list and the map. */
export function useAllRideMeta(enabled: boolean) {
    return useQuery({
        queryKey: ['allRideMeta'],
        queryFn: async (): Promise<RideSummary[]> => {
            const res = await fetch(`${API_BASE}/rides?fields=meta&limit=10000`)
            if (!res.ok) throw new Error('Failed to fetch ride metadata')
            return res.json()
        },
        enabled,
        staleTime: 5 * 60 * 1000,
    })
}

/** Ride ids under a location folder (deeper levels omitted = whole subtree) */
export async function fetchRideIdsByLocation(loc: {
    state?: string, region?: string, lga?: string, suburb?: string
}): Promise<string[]> {
    const params = new URLSearchParams({ fields: 'ids', limit: '10000' })
    if (loc.state) params.set('state', loc.state)
    if (loc.region) params.set('region', loc.region)
    if (loc.lga) params.set('lga', loc.lga)
    if (loc.suburb) params.set('suburb', loc.suburb)
    const res = await fetch(`${API_BASE}/rides?${params}`)
    if (!res.ok) throw new Error('Failed to fetch folder rides')
    const rides: { id: string }[] = await res.json()
    return rides.map(r => r.id)
}

// Lasso selection: ride ids inside or crossing a freehand polygon. fields=ids
// returns an id-only payload — no full-precision geometry for up to 10k rides.
export async function fetchRideIdsInPolygon(points: [number, number][]): Promise<string[]> {
    const polygon = points.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(';')
    const res = await fetch(`${API_BASE}/rides?polygon=${encodeURIComponent(polygon)}&fields=ids&limit=10000`)
    if (!res.ok) throw new Error('Failed to fetch lasso selection')
    const rides: { id: string }[] = await res.json()
    return rides.map(r => r.id)
}

// ---- Export bundles ----

export interface ExportDestination {
    id: string
    name: string
    path: string
    profile: 'osmand' | 'locus' | 'dmd2' | 'generic'
    layout: 'flat' | 'tree'
}

export interface ExportManifestFile {
    path: string
    kind: 'track' | 'heatmap'
    rides: number
    bytes: number
}

export interface ExportManifest {
    files: ExportManifestFile[]
    skipped: { id: string, reason: string }[]
    total_bytes: number
}

export function useDestinations() {
    return useQuery({
        queryKey: ['exportDestinations'],
        queryFn: async (): Promise<ExportDestination[]> => {
            const res = await fetch(`${API_BASE}/export/destinations`)
            if (!res.ok) throw new Error('Failed to fetch destinations')
            return res.json()
        },
    })
}

export async function createDestination(
    dest: Omit<ExportDestination, 'id'>
): Promise<ExportDestination> {
    const res = await fetch(`${API_BASE}/export/destinations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...WEB_HEADER },
        body: JSON.stringify(dest),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
}

export async function deleteDestination(id: string): Promise<void> {
    const res = await fetch(`${API_BASE}/export/destinations/${id}`, { method: 'DELETE', headers: WEB_HEADER })
    if (!res.ok) throw new Error(await res.text())
}

/** Destination-mode export: the daemon writes the bundle folder and returns
 *  the manifest. */
export async function exportToDestination(req: {
    ride_ids: string[]
    destination_id: string
    name: string
    include_tracks: boolean
    include_heatmap: boolean
    privacy: boolean
}): Promise<{ bundle_dir: string, manifest: ExportManifest }> {
    const res = await fetch(`${API_BASE}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...WEB_HEADER },
        body: JSON.stringify(req),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
}

/** Download-mode export: streams a zip; resolves once the browser download is
 *  handed off. */
export async function exportAsDownload(req: {
    ride_ids: string[]
    name: string
    include_tracks: boolean
    include_heatmap: boolean
    privacy: boolean
}): Promise<void> {
    const res = await fetch(`${API_BASE}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...WEB_HEADER },
        body: JSON.stringify({ ...req, download: true }),
    })
    if (!res.ok) throw new Error(await res.text())
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${req.name}.zip`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
}

export interface DingoNavManifest {
    tracks: number
    tracks_bytes: number       // raw GPX bytes (deflate further inside the zip)
    heatmap_features: number
    heatmap_bytes: number      // raw GeoJSON bytes (ditto)
    skipped: number
    /** Ride (blue) + hike (purple) heat baked from the harvested archives —
     *  no live Strava fetch, so there's no aborted state anymore. */
    strava: { requested: number, ride_included: number, hike_included: number, zmin: number, zmax: number, capped: boolean } | null
    strava_bytes: number       // PNG tiles, stored as-is
    satellite: { requested: number, included: number, zmin: number, zmax: number, capped: boolean, aborted: string | null, attribution?: string } | null
    satellite_bytes: number    // ESRI World Imagery JPEG tiles, stored as-is
    basemap: { included: boolean, note?: string | null }
    basemap_bytes: number      // PMTiles extract, stored as-is
    hillshade: { included: boolean, note?: string | null }
    hillshade_bytes: number    // terrain DEM PMTiles extract, stored as-is
    bytes: number
}

/** The filter panel's visibility state, sent with an export so the bundled
 *  heatmap matches what the on-screen heatmap shows (MapView applies these
 *  same predicates client-side). */
export interface HeatmapFilters {
    classes: string[]          // enabled track classes: own / other / plan
    modes: string[]            // enabled ride modes; a null mode counts as 'other'
    require_hr: boolean
    require_speed: boolean
    date_from: string | null   // YYYY-MM-DD, inclusive
    date_to: string | null
}

/** Coverage shape for a bundle map layer: 'corridor' follows the selected
 *  tracks (~1.5 km buffer polygon, the default); 'rect' is the legacy whole
 *  bounding box of the selection. */
export type Coverage = 'corridor' | 'rect'

/** How far the zoomed-out heat lines reach past the corridor: 'none' ships
 *  only the corridor lines, 'local' adds rides within ~50 km (the default),
 *  'region' adds the whole containing area — which on a Sydney ride means
 *  every track in NSW. */
export type HeatOverview = 'none' | 'local' | 'region'

/** Per-layer coverage; missing keys (or a null blob) mean corridor. */
export interface LayerCoverage {
    heatmap?: Coverage
    basemap?: Coverage
    satellite?: Coverage
    strava?: Coverage
    hillshade?: Coverage
    /** Rides beyond the corridor at low zoom; missing means local. */
    heat_overview?: HeatOverview
}

/** DingoNav bundle: one .dingonav zip with the selected tracks as full-res GPX,
 *  a heatmap clipped around them, and optionally a corridor basemap extract and
 *  Strava heatmap tiles — importable on the phone as a single file. Returns the
 *  build manifest (from the x-dingo-manifest header) so the UI can report it. */
export interface ShareResult {
    share_url: string
    gist_url: string
    /** Pack key: same share name always maps to the same slug/gist/link. */
    slug: string
    /** Bumps on every re-share of the same name; mates refresh to pick it up. */
    revision: number
    /** True when an existing link was updated in place rather than created. */
    updated: boolean
    tracks: number
    heatmap_features: number
    skipped: string[]
    bytes: number
}

/** Publish a privacy-trimmed DingoNav bundle as a secret gist and get a
 *  one-tap DingoNav link. Needs the gh CLI logged in on the daemon machine. */
export async function exportShare(req: {
    ride_ids: string[]
    name: string
    include_tracks: boolean
    include_heatmap: boolean
    heatmap_filters?: HeatmapFilters
    privacy: boolean
}): Promise<ShareResult> {
    const res = await fetch(`${API_BASE}/export/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...WEB_HEADER },
        body: JSON.stringify(req),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
}

export async function exportDingoNav(req: {
    ride_ids: string[]
    name: string
    include_tracks: boolean
    include_heatmap: boolean
    include_strava: boolean
    include_basemap: boolean
    include_satellite: boolean
    include_hillshade: boolean
    satellite_zoom?: number
    heatmap_filters?: HeatmapFilters
    coverage?: LayerCoverage
    privacy: boolean
}): Promise<DingoNavManifest | null> {
    const res = await fetch(`${API_BASE}/export/dingonav`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...WEB_HEADER },
        body: JSON.stringify(req),
    })
    if (!res.ok) throw new Error(await res.text())
    let manifest: DingoNavManifest | null = null
    const raw = res.headers.get('x-dingo-manifest')
    if (raw) { try { manifest = JSON.parse(decodeURIComponent(raw)) } catch { /* header optional */ } }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${req.name}.dingonav`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    return manifest
}

export interface HeatTilesManifest {
    rides: number
    tiles: number
    bytes: number
    min_zoom: number
    max_zoom: number
}

/** Raster heatmap-tiles export: renders the selected rides into a density
 *  heatmap .mbtiles (Strava-style glow, distinct rides per pixel) and streams
 *  it back as a download for use as an offline OsmAnd/Locus overlay. Returns
 *  the build manifest from the x-dingo-manifest header. */
export async function exportHeatmapTiles(req: {
    ride_ids: string[]
    name: string
    privacy: boolean
}): Promise<HeatTilesManifest | null> {
    const res = await fetch(`${API_BASE}/export/heatmap-tiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...WEB_HEADER },
        body: JSON.stringify(req),
    })
    if (!res.ok) throw new Error(await res.text())
    let manifest: HeatTilesManifest | null = null
    const raw = res.headers.get('x-dingo-manifest')
    if (raw) { try { manifest = JSON.parse(decodeURIComponent(raw)) } catch { /* header optional */ } }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${req.name}.mbtiles`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    return manifest
}

// ---- Packs: persisted, refreshable share bundles ----

/** The site's visibility states. "pending" = public requested, in the
 *  review queue (the link already works like unlisted). */
export type PackVisibility = 'private' | 'unlisted' | 'pending' | 'public'

/** One pack row in the Packs list. A pack is a saved recipe — an ordered ride
 *  list + layer options; publishing uploads it to dingodirt.com, whose live
 *  `?b=<share token>` link re-publishing updates in place. */
export interface PackSummary {
    id: string
    name: string
    description: string
    published_at: string | null    // null = never published (draft)
    published_bytes: number | null
    /** Publish counter carried in the bundle — DingoNav's vN badge. 0 = draft. */
    revision: number
    ride_count: number
    /** Recipe or member rides changed since the last publish */
    stale: boolean
    /** Site visibility as of the last publish; null = draft */
    visibility: PackVisibility | null
    share_url: string | null       // live DingoNav link: <nav>/?b=<token>
    file_url: string | null        // the pack's page on dingodirt.com
}

export interface PackList {
    packs: PackSummary[]
}

/** A pack member ride, in pack order (position 0 = DingoNav's default track). */
export interface PackRideEntry {
    id: string
    name: string
    started_at: string | null
    /** Publish skips these rides (kept visible so the pack never silently shrinks) */
    superseded: boolean
    no_geometry: boolean
}

export interface PackDetailData extends Omit<PackSummary, 'ride_count'> {
    include_tracks: boolean
    include_heatmap: boolean
    include_strava: boolean
    include_basemap: boolean
    include_satellite: boolean
    include_hillshade: boolean
    satellite_zoom: number | null
    privacy: boolean
    heatmap_filters: HeatmapFilters | null
    coverage: LayerCoverage | null
    /** Frozen group-ride channel name (pack name + first-publish year, e.g.
     *  Kandos2026); null until first publish. Baked into the bundle. */
    ride_name: string | null
    /** Site planning page (<site>/p/<token>); null = plan never published */
    plan_url: string | null
    rides: PackRideEntry[]
}

export function usePacks(enabled = true) {
    return useQuery({
        queryKey: ['packs'],
        queryFn: async (): Promise<PackList> => {
            const res = await fetch(`${API_BASE}/packs`)
            if (!res.ok) throw new Error(await res.text())
            return res.json()
        },
        enabled,
    })
}

export function usePack(id: string | null) {
    return useQuery({
        queryKey: ['packs', id],
        queryFn: async (): Promise<PackDetailData> => {
            const res = await fetch(`${API_BASE}/packs/${id}`)
            if (!res.ok) throw new Error(await res.text())
            return res.json()
        },
        enabled: !!id,
    })
}

export interface PackInput {
    name: string
    description?: string
    ride_ids?: string[]
    include_tracks?: boolean
    include_heatmap?: boolean
    include_strava?: boolean
    include_basemap?: boolean
    include_satellite?: boolean
    include_hillshade?: boolean
    satellite_zoom?: number | null
    privacy?: boolean
    heatmap_filters?: HeatmapFilters | null
    coverage?: LayerCoverage | null
}

export async function createPack(input: PackInput): Promise<{ id: string }> {
    const res = await fetch(`${API_BASE}/packs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...WEB_HEADER },
        body: JSON.stringify(input),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
}

/** Absent fields stay unchanged; `ride_ids` replaces the whole ordered list. */
export async function updatePack(id: string, patch: Partial<PackInput>): Promise<void> {
    const res = await fetch(`${API_BASE}/packs/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...WEB_HEADER },
        body: JSON.stringify(patch),
    })
    if (!res.ok) throw new Error(await res.text())
}

/** Delete a pack; unpublish also removes the published file from the shares
 *  repo (handed-out `?b=` links go dead; sha-pinned links survive in history). */
export async function deletePack(id: string, unpublish: boolean): Promise<void> {
    const res = await fetch(`${API_BASE}/packs/${id}?unpublish=${unpublish}`, {
        method: 'DELETE',
        headers: WEB_HEADER,
    })
    if (!res.ok) throw new Error(await res.text())
}

export interface PublishResult {
    share_url: string
    file_url: string
    share_token: string
    visibility: PackVisibility
    /** The site's version counter (bumps per upload) */
    site_version: number
    replaced: boolean
    bytes: number
    revision: number
    manifest: DingoNavManifest
}

/** Publish (first time) or refresh (after) the pack on dingodirt.com. The
 *  live `?b=` link serves the new content immediately. Omitting `visibility`
 *  (the refresh buttons) keeps the site pack's current visibility. */
export async function publishPack(
    id: string,
    visibility?: 'unlisted' | 'public',
): Promise<PublishResult> {
    const res = await fetch(`${API_BASE}/packs/${id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...WEB_HEADER },
        body: JSON.stringify(visibility ? { visibility } : {}),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
}

export interface PublishPlanResult {
    /** Site plan page, e.g. https://dingodirt.com/p/<token> */
    plan_url: string
    share_token: string
    visibility: PackVisibility
    site_version: number
    replaced: boolean
    bytes: number
    tracks: number
    marks: number
}

/** Publish the pack as a lightweight planning page (tracks + marks, no
 *  tiles) the group picks a route from — separate site pack from the full
 *  publish; a pack can have both. First publish defaults to unlisted. */
export async function publishPlan(
    id: string,
    visibility?: 'unlisted' | 'public',
): Promise<PublishPlanResult> {
    const res = await fetch(`${API_BASE}/packs/${id}/publish-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...WEB_HEADER },
        body: JSON.stringify(visibility ? { visibility } : {}),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
}

// ---- dingodirt.com connection (Settings) ----

export interface DingodirtStatus {
    connected: boolean
    name?: string
    email?: string
    trusted?: boolean
    /** "ddt_…abcd" — enough to recognise the token, never the whole thing */
    token_suffix?: string
    site?: string
    /** Why a stored token no longer works (revoked, site unreachable…) */
    error?: string
}

export function useDingodirtStatus() {
    return useQuery({
        queryKey: ['dingodirt-status'],
        queryFn: async (): Promise<DingodirtStatus> => {
            const res = await fetch(`${API_BASE}/settings/dingodirt`)
            if (!res.ok) throw new Error(await res.text())
            return res.json()
        },
    })
}

/** Store a pasted API token (validated against the site first) or, with
 *  null, disconnect. Returns the resulting status. */
export async function setDingodirtToken(token: string | null): Promise<DingodirtStatus> {
    const res = await fetch(`${API_BASE}/settings/dingodirt`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...WEB_HEADER },
        body: JSON.stringify({ token }),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
}

// ---- Pack mark edits (DingoNav → review queue → baked into the bundle) ----

/** One harvested DingoNav mark edit, matched to the nearest pack track for
 *  the review ordering. Rejected edits never come back from the API. */
export interface PackMark {
    id: string
    op: 'add' | 'remove'
    kind: string            // turn | danger | obstacle | gate | creek | fuel | food | lookout | camp
    dir: 'L' | 'R' | 'S' | null
    lat: number
    lon: number
    edited_at: string
    edited_by: string
    status: 'pending' | 'accepted'
    ride_id: string | null
    ride_name: string | null
    km: number | null
    /** More than 250 m from every pack track (sorted last) */
    off_track: boolean
}

export interface PackMarksData {
    marks: PackMark[]
    /** Count of accepted edits (baked into the next refresh) */
    accepted: number
}

export function usePackMarks(id: string | null, enabled = true) {
    return useQuery({
        queryKey: ['packs', id, 'marks'],
        queryFn: async (): Promise<PackMarksData> => {
            const res = await fetch(`${API_BASE}/packs/${id}/marks`)
            if (!res.ok) throw new Error(await res.text())
            return res.json()
        },
        enabled: enabled && !!id,
    })
}

/** Poll the pack's ntfy ride topic for new mark edits (cached ~12 h there;
 *  DingoNav re-announces rider outboxes on app open to repopulate it). */
export async function checkPackMarks(id: string): Promise<{ new: number, pending: number }> {
    const res = await fetch(`${API_BASE}/packs/${id}/marks/check`, {
        method: 'POST',
        headers: WEB_HEADER,
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
}

/** Manual fallback: the `{turnEdits:[…]}` blob from DingoNav's copy button. */
export async function pastePackMarks(id: string, blob: string): Promise<{ new: number, pending: number }> {
    let parsed: unknown
    try { parsed = JSON.parse(blob) } catch { throw new Error('Not JSON — paste the blob DingoNav copied') }
    if (!parsed || !Array.isArray((parsed as { turnEdits?: unknown }).turnEdits)) {
        throw new Error('No turnEdits array — paste the blob DingoNav copied')
    }
    const res = await fetch(`${API_BASE}/packs/${id}/marks/paste`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...WEB_HEADER },
        body: JSON.stringify(parsed),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
}

/** Accept/reject one mark, or markId `all` to accept every pending one.
 *  Either bumps the pack's stale flag — refresh to bake. */
export async function setMarkStatus(id: string, markId: string, status: 'accepted' | 'rejected'): Promise<void> {
    const res = await fetch(`${API_BASE}/packs/${id}/marks/${encodeURIComponent(markId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...WEB_HEADER },
        body: JSON.stringify({ status }),
    })
    if (!res.ok) throw new Error(await res.text())
}

/** Per-layer byte estimate for the coverage tile layers of a selection, plus
 *  the coverage shapes themselves for the map preview. */
export interface ExportEstimate {
    satellite: { tiles: number, bytes: number, capped: boolean }
    strava: { tiles: number, bytes: number, capped: boolean }
    basemap: { tiles: number, bytes: number, capped: boolean }
    hillshade: { tiles: number, bytes: number, capped: boolean }
    has_geometry: boolean
    /** Track-following corridor polygon (GeoJSON MultiPolygon), when derivable */
    corridor: GeoJSON.MultiPolygon | null
    /** How far the DEFAULT ('local') heat scope reaches: the corridor buffered
     *  by 50 km. Not derivable from `corridor` client-side. */
    heat_local?: GeoJSON.MultiPolygon | null
    /** Legacy rect coverage: selection bbox + margin, [minLon,minLat,maxLon,maxLat] */
    rect: [number, number, number, number] | null
    /** Zoomed-out overview region (containing area / configured fallback) and
     *  what its low-zoom layers would add; null when neither resolves. */
    overview: {
        area: string
        basemap: { tiles: number, bytes: number }
        strava: { tiles: number, bytes: number }
        region: GeoJSON.MultiPolygon
    } | null
    /** Preflight on the PMTiles sources behind the topo/hillshade layers:
     *  configured, readable, and covering the selection. Reported here so a
     *  dead source (an expired Protomaps build, a moved file) shows up in the
     *  dialog instead of as a note on a pack already on the phone. */
    sources?: Record<'basemap' | 'hillshade', { ok: boolean, note?: string }>
}

/** Pre-build size estimate for the map-tile layers of a selection — pure
 *  tile-math on the daemon, so the export dialog can size each layer live.
 *  Privacy is not a parameter: estimates ignore privacy zones (the trim
 *  barely moves tile counts; the real export still applies it). */
export async function estimateExport(req: {
    ride_ids: string[]
    satellite_zoom?: number
    coverage?: LayerCoverage
}): Promise<ExportEstimate> {
    const res = await fetch(`${API_BASE}/export/estimate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...WEB_HEADER },
        body: JSON.stringify(req),
    })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
}

/** Debounced coverage/size estimate for a ride selection. Shared by the export
 *  dialog, the pack detail pane and the basket boundary preview so they can't
 *  drift on debounce timing or in-flight cancellation. Returns null while
 *  disabled, while the selection is empty, or after a failed request. */
export function useCoverageEstimate(
    ids: string[],
    coverage: LayerCoverage,
    enabled = true,
): { estimate: ExportEstimate | null, estimating: boolean } {
    const [estimate, setEstimate] = useState<ExportEstimate | null>(null)
    const [estimating, setEstimating] = useState(false)
    const idsKey = ids.join(',')
    const coverageKey = JSON.stringify(coverage)
    useEffect(() => {
        if (!enabled || ids.length === 0) { setEstimate(null); return }
        let cancelled = false
        setEstimating(true)
        const t = setTimeout(() => {
            estimateExport({ ride_ids: ids, coverage })
                .then(est => { if (!cancelled) setEstimate(est) })
                .catch(() => { if (!cancelled) setEstimate(null) })
                .finally(() => { if (!cancelled) setEstimating(false) })
        }, 250)
        return () => { cancelled = true; clearTimeout(t) }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, idsKey, coverageKey])
    return { estimate, estimating }
}

// Ride update API (mode, grade, and/or owner)
export async function updateRide(
    id: string,
    patch: { mode?: string, grade?: number, clear_grade?: boolean, owner_id?: string },
): Promise<void> {
    const response = await fetch(`${API_BASE}/rides/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...WEB_HEADER },
        body: JSON.stringify(patch),
    })
    if (!response.ok) {
        throw new Error(`Failed to update ride: ${response.statusText}`)
    }
}

export async function updateRideMode(id: string, mode: string): Promise<void> {
    return updateRide(id, { mode })
}

// Mode options
export const RIDE_MODES = [
    { value: 'adv', label: 'ADV/Touring', icon: '🏍️' },
    { value: 'enduro', label: 'Enduro', icon: '🏁' },
    { value: 'mtb', label: 'Mountain Bike', icon: '🚵' },
    { value: 'watersport', label: 'Watersport', icon: '🌊' },
    { value: 'other', label: 'Other', icon: '❓' },
] as const

export type RideMode = typeof RIDE_MODES[number]['value']
