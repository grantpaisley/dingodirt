import { useMemo, useRef, useState, useCallback, useEffect } from 'react'
import { Gauge, HeartPulse, Mountain, SearchX } from 'lucide-react'
import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend,
    Filler,
    Decimation,
    type Chart,
    type Plugin,
} from 'chart.js'
import zoomPlugin from 'chartjs-plugin-zoom'
import { Line } from 'react-chartjs-2'
import { useAllRidePoints, type RidePoint } from '../../api/hooks'

// Register Chart.js components
ChartJS.register(
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend,
    Filler,
    Decimation,
    zoomPlugin,
)

interface GraphPaneProps {
    selectedIds: string[]
    isOpen: boolean
    onToggle: () => void
    height: number
    onResize: (delta: number) => void
    /** Profile → map: the point under the graph cursor (hover transient,
     *  click pinned), for the position dot on the map */
    onCursorChange?: (cursorInfo: CursorInfo | null) => void
    /** Map → profile: hovering a selected track on the map moves a cursor
     *  line here (lon/lat resolved to the nearest ride point) */
    mapCursor?: { rideId: string, lon: number, lat: number } | null
}

export interface CursorInfo {
    rideId: string
    pointIndex: number
    distance: number
    hr: number | null
    speed: number | null
    elevation: number | null
    elapsedTime: number | null
    position: [number, number]
    pinned?: boolean
}

// Modern color scheme
const ELEVATION_COLOR = '#8b98a5'
const ELEVATION_FILL = 'rgba(139, 152, 165, 0.3)'
const HR_COLOR = '#ff6b6b'
const HR_COLOR_FADED = 'rgba(255, 107, 107, 0.3)'
const SPEED_COLOR = '#4ecdc4'
const SPEED_COLOR_FADED = 'rgba(78, 205, 196, 0.3)'

type XAxisMode = 'distance' | 'time'

interface ProcessedRideData {
    rideId: string
    points: Array<{
        distance: number
        elapsedTime: number // seconds from start
        hr: number | null
        speed: number | null
        elevation: number | null
        lon: number
        lat: number
        index: number
    }>
}

function processRidePoints(points: RidePoint[]): ProcessedRideData['points'] {
    const result: ProcessedRideData['points'] = []
    let cumulativeDistance = 0
    const startTime = points[0]?.timestamp ? new Date(points[0].timestamp).getTime() : 0

    for (let i = 0; i < points.length; i++) {
        const p = points[i]

        // The server provides cumulative distance along the cleaned track;
        // fall back to haversine accumulation for rides that predate it.
        if (p.distance_m != null) {
            cumulativeDistance = p.distance_m
        } else if (i > 0) {
            const prev = points[i - 1]
            cumulativeDistance += haversineDistance(prev.lat, prev.lon, p.lat, p.lon)
        }

        const pointTime = p.timestamp ? new Date(p.timestamp).getTime() : startTime
        const elapsedTime = (pointTime - startTime) / 1000 // seconds

        result.push({
            distance: cumulativeDistance / 1000, // km
            elapsedTime,
            hr: p.heart_rate,
            speed: p.speed != null ? p.speed * 3.6 : null, // m/s to km/h (0 is a real reading, not missing)
            elevation: p.elevation,
            lon: p.lon,
            lat: p.lat,
            index: i,
        })
    }

    return result
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLon = (lon2 - lon1) * Math.PI / 180
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = Math.floor(seconds % 60)
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    return `${m}:${s.toString().padStart(2, '0')}`
}

export function GraphPane({
    selectedIds,
    isOpen,
    onToggle,
    height,
    onResize,
    onCursorChange,
    mapCursor,
}: GraphPaneProps) {
    const resizing = useRef(false)
    const chartRef = useRef<Chart<'line'> | null>(null)
    const [xAxisMode, setXAxisMode] = useState<XAxisMode>('distance')
    const [showElevation, setShowElevation] = useState(true)
    const [showHR, setShowHR] = useState(true)
    const [showSpeed, setShowSpeed] = useState(true)
    const [isZoomed, setIsZoomed] = useState(false)
    const [hoveredRideId, setHoveredRideId] = useState<string | null>(null)
    // Clicking the graph pins the cursor (map dot stays put); hover is transient
    const pinnedCursor = useRef<CursorInfo | null>(null)
    const [cursorData, setCursorData] = useState<{
        xValue: number
        values: Array<{
            rideId: string
            hr: number | null
            speed: number | null
            elevation: number | null
            elapsedTime: number | null
            distance: number
        }>
    } | null>(null)

    // A folder/lasso selection can be thousands of rides — fetching per-ride
    // point series for all of them would hammer the daemon for an unreadable
    // chart. Above the cap the pane shows a notice instead.
    const MAX_GRAPH_RIDES = 20
    const tooMany = selectedIds.length > MAX_GRAPH_RIDES
    const { data: allRidePoints, isLoading } = useAllRidePoints(tooMany ? [] : selectedIds)

    const processedData = useMemo<ProcessedRideData[]>(() => {
        if (!allRidePoints) return []
        return allRidePoints.map(({ rideId, points }) => ({
            rideId,
            points: processRidePoints(points),
        }))
    }, [allRidePoints])

    // Interpolate value at a given x position
    const interpolateValue = useCallback((
        points: ProcessedRideData['points'],
        targetX: number,
        xField: 'distance' | 'elapsedTime',
        valueField: 'hr' | 'speed' | 'elevation' | 'elapsedTime' | 'distance'
    ): number | null => {
        if (points.length === 0) return null

        let before = points[0]
        let after = points[0]

        for (let i = 0; i < points.length; i++) {
            if (points[i][xField] <= targetX) before = points[i]
            if (points[i][xField] >= targetX) {
                after = points[i]
                break
            }
        }

        if (before[xField] === after[xField]) return before[valueField]

        const beforeVal = before[valueField]
        const afterVal = after[valueField]
        if (beforeVal === null || afterVal === null) return beforeVal ?? afterVal

        const t = (targetX - before[xField]) / (after[xField] - before[xField])
        return beforeVal + t * (afterVal - beforeVal)
    }, [])

    const xField: 'distance' | 'elapsedTime' = xAxisMode === 'distance' ? 'distance' : 'elapsedTime'

    // Full-resolution {x, y} datasets — every cleaned point is plotted (the
    // old version resampled onto a 0.5–5 km grid, which flattened every
    // pitch). The decimation plugin (LTTB) keeps drawing fast zoomed out and
    // re-decimates per visible range, so zooming in reveals full detail.
    const chartData = useMemo(() => {
        if (processedData.length === 0) return { datasets: [] }

        type Dataset = {
            label: string
            data: { x: number, y: number }[]
            parsing: false
            borderColor: string
            backgroundColor: string
            yAxisID: string
            pointRadius: number
            borderWidth: number
            borderDash?: number[]
            fill?: boolean | string
            rideId: string
            order?: number
        }
        const datasets: Dataset[] = []

        processedData.forEach((ride, rideIndex) => {
            const rideLabel = processedData.length > 1 ? `Ride ${rideIndex + 1}` : 'Ride'
            const isHovered = hoveredRideId === ride.rideId
            const hasSomeHovered = hoveredRideId !== null

            // Per-series point arrays; nulls dropped per series (each dataset
            // carries its own x positions, so series with gaps stay honest)
            const series = (field: 'elevation' | 'hr' | 'speed') =>
                ride.points
                    .filter(p => p[field] != null)
                    .map(p => ({ x: p[xField], y: p[field] as number }))

            if (showElevation) {
                datasets.push({
                    label: `${rideLabel} Elevation`,
                    data: series('elevation'),
                    parsing: false,
                    borderColor: hasSomeHovered && !isHovered ? 'rgba(139, 152, 165, 0.2)' : ELEVATION_COLOR,
                    backgroundColor: hasSomeHovered && !isHovered ? 'rgba(139, 152, 165, 0.1)' : ELEVATION_FILL,
                    yAxisID: 'yElev',
                    pointRadius: 0,
                    borderWidth: 1,
                    fill: true,
                    rideId: ride.rideId,
                    order: 2,
                })
            }

            if (showHR) {
                const data = series('hr')
                if (data.length > 0) {
                    datasets.push({
                        label: `${rideLabel} HR`,
                        data,
                        parsing: false,
                        borderColor: hasSomeHovered && !isHovered ? HR_COLOR_FADED : HR_COLOR,
                        backgroundColor: 'transparent',
                        yAxisID: 'yHR',
                        pointRadius: 0,
                        borderWidth: isHovered ? 2.5 : 1.5,
                        rideId: ride.rideId,
                        order: 1,
                    })
                }
            }

            if (showSpeed) {
                const data = series('speed')
                if (data.length > 0) {
                    datasets.push({
                        label: `${rideLabel} Speed`,
                        data,
                        parsing: false,
                        borderColor: hasSomeHovered && !isHovered ? SPEED_COLOR_FADED : SPEED_COLOR,
                        backgroundColor: 'transparent',
                        yAxisID: 'ySpeed',
                        pointRadius: 0,
                        borderWidth: isHovered ? 2.5 : 1.5,
                        borderDash: [5, 5],
                        rideId: ride.rideId,
                        order: 0,
                    })
                }
            }
        })

        return { datasets }
    }, [processedData, xField, showElevation, showHR, showSpeed, hoveredRideId])

    function findNearestPoint(
        points: ProcessedRideData['points'],
        targetX: number,
        field: 'distance' | 'elapsedTime'
    ): ProcessedRideData['points'][0] | null {
        if (points.length === 0) return null
        let nearest = points[0]
        let minDiff = Math.abs(points[0][field] - targetX)
        for (const p of points) {
            const diff = Math.abs(p[field] - targetX)
            if (diff < minDiff) {
                minDiff = diff
                nearest = p
            }
        }
        return nearest
    }

    const cursorInfoAt = useCallback((rideId: string | null, xValue: number): CursorInfo | null => {
        if (processedData.length === 0) return null
        const ride = processedData.find(r => r.rideId === rideId) || processedData[0]
        const point = findNearestPoint(ride.points, xValue, xField)
        if (!point) return null
        return {
            rideId: ride.rideId,
            pointIndex: point.index,
            distance: point.distance,
            hr: point.hr,
            speed: point.speed,
            elevation: point.elevation,
            elapsedTime: point.elapsedTime,
            position: [point.lon, point.lat],
        }
    }, [processedData, xField])

    const reportCursor = useCallback((hover: CursorInfo | null) => {
        onCursorChange?.(pinnedCursor.current ?? hover)
    }, [onCursorChange])

    // Map → profile: resolve the hovered map position to the nearest point of
    // that ride, in graph-x terms, for the cursor line.
    const externalX = useMemo<number | null>(() => {
        if (!mapCursor) return null
        const ride = processedData.find(r => r.rideId === mapCursor.rideId)
        if (!ride || ride.points.length === 0) return null
        let best = ride.points[0]
        let bestD = Infinity
        for (const p of ride.points) {
            // Squared equirectangular distance — plenty for nearest-point
            const dx = (p.lon - mapCursor.lon) * Math.cos(mapCursor.lat * Math.PI / 180)
            const dy = p.lat - mapCursor.lat
            const d = dx * dx + dy * dy
            if (d < bestD) {
                bestD = d
                best = p
            }
        }
        return best[xField]
    }, [mapCursor, processedData, xField])

    // The cursor line is drawn by a plugin reading this ref, so a moving map
    // cursor only needs a cheap no-animation redraw, not new chart data.
    const externalXRef = useRef<number | null>(null)
    useEffect(() => {
        externalXRef.current = externalX
        chartRef.current?.update('none')
    }, [externalX])

    const mapCursorPlugin = useMemo<Plugin<'line'>>(() => ({
        id: 'dingoMapCursor',
        afterDraw(chart) {
            const x = externalXRef.current
            if (import.meta.env.DEV) {
                ;(window as unknown as Record<string, unknown>).__dingoProfileCursorX = x
            }
            if (x == null) return
            const { ctx, chartArea, scales } = chart
            const px = scales.x?.getPixelForValue(x)
            if (px == null || px < chartArea.left || px > chartArea.right) return
            ctx.save()
            ctx.strokeStyle = 'rgba(79, 124, 255, 0.9)'
            ctx.lineWidth = 1.5
            ctx.beginPath()
            ctx.moveTo(px, chartArea.top)
            ctx.lineTo(px, chartArea.bottom)
            ctx.stroke()
            ctx.restore()
        },
    }), [])

    const options = useMemo(() => {
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: false as const,
            interaction: { mode: 'nearest' as const, axis: 'x' as const, intersect: false },
            plugins: {
                legend: { display: false },
                // The header info bar is the readout; per-point tooltips just
                // fight the drag-zoom gesture on full-res data
                tooltip: { enabled: false },
                decimation: {
                    enabled: true,
                    algorithm: 'lttb' as const,
                    samples: 1500,
                    threshold: 3000,
                },
                zoom: {
                    zoom: {
                        drag: { enabled: true, backgroundColor: 'rgba(79, 124, 255, 0.15)' },
                        wheel: { enabled: true },
                        mode: 'x' as const,
                        onZoomComplete: () => setIsZoomed(true),
                    },
                    pan: {
                        enabled: true,
                        mode: 'x' as const,
                        modifierKey: 'shift' as const,
                        onPanComplete: () => setIsZoomed(true),
                    },
                    limits: { x: { min: 'original' as const, max: 'original' as const } },
                },
            },
            scales: {
                x: {
                    type: 'linear' as const,
                    title: {
                        display: true,
                        text: xAxisMode === 'distance' ? 'Distance (km)' : 'Time',
                        color: '#888',
                    },
                    ticks: {
                        color: '#888',
                        maxTicksLimit: 12,
                        callback: (value: number | string) => {
                            const v = typeof value === 'number' ? value : parseFloat(value)
                            return xAxisMode === 'distance' ? Math.round(v * 10) / 10 : formatTime(v)
                        },
                    },
                    grid: { color: 'rgba(255,255,255,0.1)' },
                },
                yElev: {
                    type: 'linear' as const,
                    display: showElevation,
                    position: 'left' as const,
                    title: { display: true, text: 'Elevation (m)', color: ELEVATION_COLOR },
                    ticks: { color: ELEVATION_COLOR },
                    grid: { color: 'rgba(255,255,255,0.05)' },
                },
                yHR: {
                    type: 'linear' as const,
                    display: showHR,
                    position: 'right' as const,
                    title: { display: true, text: 'HR (bpm)', color: HR_COLOR },
                    ticks: { color: HR_COLOR },
                    grid: { drawOnChartArea: false },
                    min: 60,
                    max: 200,
                },
                ySpeed: {
                    type: 'linear' as const,
                    display: showSpeed && !showHR, // Only show if HR is hidden
                    position: 'right' as const,
                    title: { display: true, text: 'Speed (km/h)', color: SPEED_COLOR },
                    ticks: { color: SPEED_COLOR },
                    grid: { drawOnChartArea: false },
                    min: 0,
                    max: 80,
                },
            },
            onHover: (
                event: { x?: number | null },
                elements: Array<{ datasetIndex: number }>,
                chart: Chart<'line'>
            ) => {
                if (event.x == null || processedData.length === 0) return
                const { chartArea, scales } = chart
                if (event.x < chartArea.left || event.x > chartArea.right) {
                    setHoveredRideId(null)
                    setCursorData(null)
                    reportCursor(null)
                    return
                }
                const xValue = scales.x.getValueForPixel(event.x)
                if (xValue == null) return

                const hoveredDataset = elements.length > 0
                    ? (chartData.datasets[elements[0].datasetIndex] as { rideId?: string } | undefined)
                    : undefined
                const rideId = hoveredDataset?.rideId ?? null
                setHoveredRideId(processedData.length > 1 ? rideId : null)

                const values = processedData.map(ride => ({
                    rideId: ride.rideId,
                    hr: interpolateValue(ride.points, xValue, xField, 'hr'),
                    speed: interpolateValue(ride.points, xValue, xField, 'speed'),
                    elevation: interpolateValue(ride.points, xValue, xField, 'elevation'),
                    elapsedTime: interpolateValue(ride.points, xValue, xField, 'elapsedTime'),
                    distance: interpolateValue(ride.points, xValue, xField, 'distance') ?? xValue,
                }))
                setCursorData({ xValue, values })
                reportCursor(cursorInfoAt(rideId, xValue))
            },
            onClick: (
                event: { x?: number | null },
                _elements: unknown,
                chart: Chart<'line'>
            ) => {
                if (event.x == null) return
                const xValue = chart.scales.x.getValueForPixel(event.x)
                if (xValue == null) return
                const info = cursorInfoAt(hoveredRideId, xValue)
                // Toggle: clicking again (or clicking with a pin set) unpins
                pinnedCursor.current = pinnedCursor.current ? null : info && { ...info, pinned: true }
                onCursorChange?.(pinnedCursor.current ?? info)
            },
        }
    }, [xAxisMode, xField, showElevation, showHR, showSpeed, chartData, processedData,
        interpolateValue, cursorInfoAt, reportCursor, onCursorChange, hoveredRideId])

    // Leaving the pane clears the transient cursor (a pinned one stays)
    const handleChartLeave = useCallback(() => {
        setHoveredRideId(null)
        setCursorData(null)
        reportCursor(null)
    }, [reportCursor])

    // Selection changes invalidate the pin + zoom
    const selectionKey = selectedIds.join(',')
    useEffect(() => {
        pinnedCursor.current = null
        onCursorChange?.(null)
        chartRef.current?.resetZoom()
        setIsZoomed(false)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectionKey])

    const handleResetZoom = useCallback(() => {
        chartRef.current?.resetZoom()
        setIsZoomed(false)
    }, [])

    // Dev/debug handle, like window.__dingoMap for the map. A live getter:
    // react-chartjs-2 can swap chart instances without this component
    // re-rendering, so a snapshot would go stale.
    useEffect(() => {
        if (import.meta.env.DEV) {
            Object.defineProperty(window, '__dingoChart', {
                get: () => chartRef.current,
                configurable: true,
            })
        }
    }, [])

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault()
        resizing.current = true
        document.body.style.cursor = 'row-resize'
    }, [])

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (resizing.current) onResize(-e.movementY)
        }
        const handleMouseUp = () => {
            resizing.current = false
            document.body.style.cursor = ''
        }
        window.addEventListener('mousemove', handleMouseMove)
        window.addEventListener('mouseup', handleMouseUp)
        return () => {
            window.removeEventListener('mousemove', handleMouseMove)
            window.removeEventListener('mouseup', handleMouseUp)
        }
    }, [onResize])

    // Toggle button component
    const ToggleBtn = ({ active, color, onClick, children }: {
        active: boolean
        color: string
        onClick: () => void
        children: React.ReactNode
    }) => (
        <button
            onClick={onClick}
            style={{
                background: active ? color : 'transparent',
                color: active ? '#fff' : color,
                border: `1px solid ${color}`,
                padding: '2px 8px',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: 500,
                opacity: active ? 1 : 0.7,
                transition: 'all 0.15s',
            }}
        >
            {children}
        </button>
    )

    if (!isOpen) {
        return (
            <div style={{
                height: 32,
                background: 'var(--pane-bg)',
                borderTop: '1px solid var(--border-color)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
            }}>
                <button
                    onClick={onToggle}
                    style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-secondary)',
                        cursor: 'pointer',
                        fontSize: 12,
                    }}
                >
                    ▲ Show Graph
                </button>
            </div>
        )
    }

    // Get cursor values for display
    const displayValues = cursorData?.values
    const singleRide = displayValues?.length === 1
    const hoveredValues = hoveredRideId ? displayValues?.find(v => v.rideId === hoveredRideId) : null

    return (
        <div style={{
            height,
            background: 'var(--pane-bg)',
            borderTop: '1px solid var(--border-color)',
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
        }}>
            {/* Resize handle */}
            <div
                onMouseDown={handleMouseDown}
                style={{
                    height: 6,
                    cursor: 'row-resize',
                    background: 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                <div style={{ width: 40, height: 4, background: 'var(--border-color)', borderRadius: 2 }} />
            </div>

            {/* Header bar with toggles and info */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '4px 12px',
                borderBottom: '1px solid var(--border-color)',
                flexWrap: 'wrap',
            }}>
                {/* Metric toggles */}
                <div style={{ display: 'flex', gap: 4 }}>
                    <ToggleBtn active={showElevation} color={ELEVATION_COLOR} onClick={() => setShowElevation(!showElevation)}>
                        <Mountain size={12} style={{ verticalAlign: -2, marginRight: 3 }} />Elevation
                    </ToggleBtn>
                    <ToggleBtn active={showSpeed} color={SPEED_COLOR} onClick={() => setShowSpeed(!showSpeed)}>
                        <Gauge size={12} style={{ verticalAlign: -2, marginRight: 3 }} />Speed
                    </ToggleBtn>
                    <ToggleBtn active={showHR} color={HR_COLOR} onClick={() => setShowHR(!showHR)}>
                        <HeartPulse size={12} style={{ verticalAlign: -2, marginRight: 3 }} />HR
                    </ToggleBtn>
                </div>

                {/* X-axis dropdown */}
                <select
                    value={xAxisMode}
                    onChange={e => setXAxisMode(e.target.value as XAxisMode)}
                    style={{
                        background: 'rgba(255,255,255,0.1)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 4,
                        padding: '2px 8px',
                        fontSize: 11,
                        cursor: 'pointer',
                    }}
                >
                    <option value="distance">Distance</option>
                    <option value="time">Time</option>
                </select>

                {isZoomed && (
                    <button
                        onClick={handleResetZoom}
                        title="Reset zoom (drag to zoom into a range, shift-drag to pan, wheel to zoom)"
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            background: 'transparent',
                            border: '1px solid var(--border-color)',
                            borderRadius: 4,
                            color: 'var(--text-secondary)',
                            cursor: 'pointer',
                            fontSize: 11,
                            padding: '2px 8px',
                        }}
                    >
                        <SearchX size={12} />Reset zoom
                    </button>
                )}

                {/* Info bar - spacer */}
                <div style={{ flex: 1 }} />

                {/* Cursor info */}
                {cursorData && (singleRide || hoveredValues) && (
                    <div style={{
                        display: 'flex',
                        gap: 12,
                        fontSize: 11,
                        fontFamily: 'monospace',
                        color: 'var(--text-primary)',
                    }}>
                        {(() => {
                            const v = hoveredValues || displayValues?.[0]
                            if (!v) return null
                            return (
                                <>
                                    {showElevation && (
                                        <span>
                                            <span style={{ color: ELEVATION_COLOR }}>{v.elevation?.toFixed(0) ?? '-'}</span>
                                            <span style={{ color: '#666' }}> m</span>
                                        </span>
                                    )}
                                    {showSpeed && (
                                        <span>
                                            <span style={{ color: SPEED_COLOR }}>{v.speed?.toFixed(1) ?? '-'}</span>
                                            <span style={{ color: '#666' }}> km/h</span>
                                        </span>
                                    )}
                                    <span>
                                        <span style={{ color: '#fff' }}>{formatTime(v.elapsedTime ?? 0)}</span>
                                    </span>
                                    {showHR && (
                                        <span>
                                            <span style={{ color: HR_COLOR }}>{v.hr?.toFixed(0) ?? '-'}</span>
                                            <span style={{ color: '#666' }}> bpm</span>
                                        </span>
                                    )}
                                </>
                            )
                        })()}
                    </div>
                )}

                {/* Multi-ride range display */}
                {cursorData && !singleRide && !hoveredValues && displayValues && (
                    <div style={{
                        display: 'flex',
                        gap: 12,
                        fontSize: 11,
                        fontFamily: 'monospace',
                        color: 'var(--text-secondary)',
                    }}>
                        {showElevation && (
                            <span style={{ color: ELEVATION_COLOR }}>
                                {Math.min(...displayValues.map(v => v.elevation ?? Infinity)).toFixed(0)}-
                                {Math.max(...displayValues.map(v => v.elevation ?? -Infinity)).toFixed(0)} m
                            </span>
                        )}
                        {showSpeed && (
                            <span style={{ color: SPEED_COLOR }}>
                                {Math.min(...displayValues.map(v => v.speed ?? Infinity)).toFixed(1)}-
                                {Math.max(...displayValues.map(v => v.speed ?? -Infinity)).toFixed(1)} km/h
                            </span>
                        )}
                        {showHR && (
                            <span style={{ color: HR_COLOR }}>
                                {Math.min(...displayValues.map(v => v.hr ?? Infinity)).toFixed(0)}-
                                {Math.max(...displayValues.map(v => v.hr ?? -Infinity)).toFixed(0)} bpm
                            </span>
                        )}
                    </div>
                )}

                <button
                    onClick={onToggle}
                    style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-secondary)',
                        cursor: 'pointer',
                        fontSize: 12,
                    }}
                >
                    ▼ Hide
                </button>
            </div>

            {/* Chart area */}
            <div
                style={{ flex: 1, padding: '8px 12px', minHeight: 0 }}
                onMouseLeave={handleChartLeave}
            >
                {selectedIds.length === 0 ? (
                    <div style={{
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--text-secondary)',
                    }}>
                        Select one or more rides to view graph
                    </div>
                ) : tooMany ? (
                    <div style={{
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--text-secondary)',
                    }}>
                        {selectedIds.length} rides selected — profile shows up to {MAX_GRAPH_RIDES}
                    </div>
                ) : isLoading ? (
                    <div style={{
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--text-secondary)',
                    }}>
                        Loading ride data...
                    </div>
                ) : (
                    <Line
                        ref={chartRef}
                        data={chartData}
                        options={options}
                        plugins={[mapCursorPlugin]}
                    />
                )}
            </div>
        </div>
    )
}
