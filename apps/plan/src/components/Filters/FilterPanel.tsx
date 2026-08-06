import { useState, useCallback, useRef, useEffect } from 'react'
import { hasActiveRangeFilters } from '../../store'

export interface FilterValues {
    hrAvgMin: number | null
    hrAvgMax: number | null
    hrMaxMin: number | null
    hrMaxMax: number | null
    speedAvgMin: number | null
    speedAvgMax: number | null
    speedMaxMin: number | null
    speedMaxMax: number | null
    distanceMin: number | null
    distanceMax: number | null
    // Track which filters are enabled
    hrAvgEnabled: boolean
    hrMaxEnabled: boolean
    speedAvgEnabled: boolean
    speedMaxEnabled: boolean
    distanceEnabled: boolean
}

interface FilterPanelProps {
    filters: FilterValues
    onChange: (filters: FilterValues) => void
    defaults: {
        hrMin: number
        hrMax: number
        speedMin: number
        speedMax: number
        distanceMin: number
        distanceMax: number
    }
}

/** Range-filter pane content — rendered inside the map toolbar */
export function FilterPaneContent({ filters, onChange, defaults }: FilterPanelProps) {
    const updateRange = useCallback((
        minKey: keyof FilterValues,
        maxKey: keyof FilterValues,
        minVal: number,
        maxVal: number
    ) => {
        onChange({ ...filters, [minKey]: minVal, [maxKey]: maxVal })
    }, [filters, onChange])

    const toggleEnabled = useCallback((enabledKey: keyof FilterValues) => {
        const newEnabled = !filters[enabledKey]
        onChange({ ...filters, [enabledKey]: newEnabled })
    }, [filters, onChange])

    const clearFilters = () => {
        onChange({
            hrAvgMin: defaults.hrMin,
            hrAvgMax: defaults.hrMax,
            hrMaxMin: defaults.hrMin,
            hrMaxMax: defaults.hrMax,
            speedAvgMin: defaults.speedMin,
            speedAvgMax: defaults.speedMax,
            speedMaxMin: defaults.speedMin,
            speedMaxMax: defaults.speedMax,
            distanceMin: defaults.distanceMin,
            distanceMax: defaults.distanceMax,
            hrAvgEnabled: false,
            hrMaxEnabled: false,
            speedAvgEnabled: false,
            speedMaxEnabled: false,
            distanceEnabled: false,
        })
    }

    const hasActiveFilters = hasActiveRangeFilters(filters)

    return (
        <div style={{
            width: 280,
            maxHeight: 'calc(100vh - 120px)',
            overflowY: 'auto',
        }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                        <span style={{ color: 'white', fontSize: 12, fontWeight: 'bold' }}>Range Filters</span>
                        {hasActiveFilters && (
                            <button
                                onClick={clearFilters}
                                style={{
                                    background: 'transparent',
                                    color: '#888',
                                    border: 'none',
                                    cursor: 'pointer',
                                    fontSize: 10,
                                }}
                            >
                                Clear
                            </button>
                        )}
                    </div>

                    {/* Distance */}
                    <DualHandleSlider
                        label="Distance"
                        unit="km"
                        enabled={filters.distanceEnabled}
                        onToggle={() => toggleEnabled('distanceEnabled')}
                        min={defaults.distanceMin}
                        max={defaults.distanceMax}
                        valueMin={filters.distanceMin ?? defaults.distanceMin}
                        valueMax={filters.distanceMax ?? defaults.distanceMax}
                        onChange={(min, max) => updateRange('distanceMin', 'distanceMax', min, max)}
                        step={1}
                        decimals={0}
                    />

                    {/* HR Avg */}
                    <DualHandleSlider
                        label="HR Avg"
                        unit="bpm"
                        enabled={filters.hrAvgEnabled}
                        onToggle={() => toggleEnabled('hrAvgEnabled')}
                        min={defaults.hrMin}
                        max={defaults.hrMax}
                        valueMin={filters.hrAvgMin ?? defaults.hrMin}
                        valueMax={filters.hrAvgMax ?? defaults.hrMax}
                        onChange={(min, max) => updateRange('hrAvgMin', 'hrAvgMax', min, max)}
                        step={1}
                        decimals={0}
                    />

                    {/* HR Max */}
                    <DualHandleSlider
                        label="HR Max"
                        unit="bpm"
                        enabled={filters.hrMaxEnabled}
                        onToggle={() => toggleEnabled('hrMaxEnabled')}
                        min={defaults.hrMin}
                        max={defaults.hrMax}
                        valueMin={filters.hrMaxMin ?? defaults.hrMin}
                        valueMax={filters.hrMaxMax ?? defaults.hrMax}
                        onChange={(min, max) => updateRange('hrMaxMin', 'hrMaxMax', min, max)}
                        step={1}
                        decimals={0}
                    />

                    {/* Speed Avg */}
                    <DualHandleSlider
                        label="Speed Avg"
                        unit="km/h"
                        enabled={filters.speedAvgEnabled}
                        onToggle={() => toggleEnabled('speedAvgEnabled')}
                        min={defaults.speedMin}
                        max={defaults.speedMax}
                        valueMin={filters.speedAvgMin ?? defaults.speedMin}
                        valueMax={filters.speedAvgMax ?? defaults.speedMax}
                        onChange={(min, max) => updateRange('speedAvgMin', 'speedAvgMax', min, max)}
                        step={1}
                        decimals={0}
                    />

                    {/* Speed Max */}
                    <DualHandleSlider
                        label="Speed Max"
                        unit="km/h"
                        enabled={filters.speedMaxEnabled}
                        onToggle={() => toggleEnabled('speedMaxEnabled')}
                        min={defaults.speedMin}
                        max={defaults.speedMax}
                        valueMin={filters.speedMaxMin ?? defaults.speedMin}
                        valueMax={filters.speedMaxMax ?? defaults.speedMax}
                        onChange={(min, max) => updateRange('speedMaxMin', 'speedMaxMax', min, max)}
                        step={1}
                        decimals={0}
                    />
        </div>
    )
}

interface DualHandleSliderProps {
    label: string
    unit: string
    enabled: boolean
    onToggle: () => void
    min: number
    max: number
    valueMin: number
    valueMax: number
    onChange: (min: number, max: number) => void
    step: number
    decimals: number
}

function DualHandleSlider({
    label,
    unit,
    enabled,
    onToggle,
    min,
    max,
    valueMin,
    valueMax,
    onChange,
    step,
    decimals
}: DualHandleSliderProps) {
    const trackRef = useRef<HTMLDivElement>(null)
    const [dragging, setDragging] = useState<'min' | 'max' | null>(null)
    const [hovering, setHovering] = useState<'min' | 'max' | null>(null)

    // Calculate percentage position from value
    const valueToPercent = (val: number) => ((val - min) / (max - min)) * 100

    // Calculate value from percentage position
    const percentToValue = (percent: number) => {
        const rawValue = (percent / 100) * (max - min) + min
        // Round to step
        const stepped = Math.round(rawValue / step) * step
        return Math.max(min, Math.min(max, stepped))
    }

    const leftPercent = valueToPercent(valueMin)
    const rightPercent = valueToPercent(valueMax)

    // Handle mouse move during drag
    const handleMouseMove = useCallback((e: MouseEvent) => {
        if (!dragging || !trackRef.current) return

        const rect = trackRef.current.getBoundingClientRect()
        const percent = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100))
        const newValue = percentToValue(percent)

        if (dragging === 'min') {
            // Don't let min exceed max
            if (newValue <= valueMax) {
                onChange(newValue, valueMax)
            }
        } else {
            // Don't let max go below min
            if (newValue >= valueMin) {
                onChange(valueMin, newValue)
            }
        }
    }, [dragging, valueMin, valueMax, onChange, min, max, step])

    // Handle mouse up to end drag
    const handleMouseUp = useCallback(() => {
        setDragging(null)
    }, [])

    // Add/remove global event listeners for drag
    useEffect(() => {
        if (dragging) {
            window.addEventListener('mousemove', handleMouseMove)
            window.addEventListener('mouseup', handleMouseUp)
            return () => {
                window.removeEventListener('mousemove', handleMouseMove)
                window.removeEventListener('mouseup', handleMouseUp)
            }
        }
    }, [dragging, handleMouseMove, handleMouseUp])

    const handleSize = 14

    return (
        <div style={{
            marginBottom: 16,
            opacity: enabled ? 1 : 0.5,
            transition: 'opacity 0.2s'
        }}>
            {/* Header row with checkbox and label */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                marginBottom: 8
            }}>
                <label style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    cursor: 'pointer'
                }}>
                    <input
                        type="checkbox"
                        checked={enabled}
                        onChange={onToggle}
                        style={{
                            width: 14,
                            height: 14,
                            accentColor: '#4f7cff',
                            cursor: 'pointer'
                        }}
                    />
                    <span style={{ color: '#ccc', fontSize: 11, fontWeight: 500 }}>{label}</span>
                </label>
                <span style={{
                    marginLeft: 'auto',
                    color: '#666',
                    fontSize: 9,
                }}>
                    {unit}
                </span>
            </div>

            {/* Slider track and handles */}
            <div
                ref={trackRef}
                style={{
                    position: 'relative',
                    height: 36,
                    pointerEvents: enabled ? 'auto' : 'none',
                    userSelect: 'none',
                }}
            >
                {/* Track background */}
                <div style={{
                    position: 'absolute',
                    top: 6,
                    left: 0,
                    right: 0,
                    height: 4,
                    background: '#333',
                    borderRadius: 2,
                }} />

                {/* Active range highlight */}
                <div style={{
                    position: 'absolute',
                    top: 6,
                    left: `${leftPercent}%`,
                    width: `${rightPercent - leftPercent}%`,
                    height: 4,
                    background: enabled ? '#4f7cff' : '#555',
                    borderRadius: 2,
                    transition: 'background 0.2s',
                }} />

                {/* Min handle */}
                <div
                    onMouseDown={(e) => {
                        e.preventDefault()
                        if (enabled) setDragging('min')
                    }}
                    onMouseEnter={() => setHovering('min')}
                    onMouseLeave={() => setHovering(null)}
                    style={{
                        position: 'absolute',
                        top: 8 - handleSize / 2,
                        left: `calc(${leftPercent}% - ${handleSize / 2}px)`,
                        width: handleSize,
                        height: handleSize,
                        borderRadius: '50%',
                        background: dragging === 'min' ? '#6b9fff' : (enabled ? '#4f7cff' : '#555'),
                        border: '2px solid #fff',
                        cursor: enabled ? 'grab' : 'default',
                        boxShadow: hovering === 'min' || dragging === 'min'
                            ? '0 0 0 3px rgba(79, 124, 255, 0.3)'
                            : '0 1px 3px rgba(0,0,0,0.4)',
                        zIndex: dragging === 'min' ? 10 : 5,
                        transition: dragging ? 'none' : 'box-shadow 0.15s',
                    }}
                />

                {/* Max handle */}
                <div
                    onMouseDown={(e) => {
                        e.preventDefault()
                        if (enabled) setDragging('max')
                    }}
                    onMouseEnter={() => setHovering('max')}
                    onMouseLeave={() => setHovering(null)}
                    style={{
                        position: 'absolute',
                        top: 8 - handleSize / 2,
                        left: `calc(${rightPercent}% - ${handleSize / 2}px)`,
                        width: handleSize,
                        height: handleSize,
                        borderRadius: '50%',
                        background: dragging === 'max' ? '#6b9fff' : (enabled ? '#4f7cff' : '#555'),
                        border: '2px solid #fff',
                        cursor: enabled ? 'grab' : 'default',
                        boxShadow: hovering === 'max' || dragging === 'max'
                            ? '0 0 0 3px rgba(79, 124, 255, 0.3)'
                            : '0 1px 3px rgba(0,0,0,0.4)',
                        zIndex: dragging === 'max' ? 10 : 5,
                        transition: dragging ? 'none' : 'box-shadow 0.15s',
                    }}
                />

                {/* Min value label */}
                <div style={{
                    position: 'absolute',
                    top: 22,
                    left: `${leftPercent}%`,
                    transform: 'translateX(-50%)',
                    color: enabled ? '#fff' : '#666',
                    fontSize: 10,
                    fontFamily: 'monospace',
                    whiteSpace: 'nowrap',
                    pointerEvents: 'none',
                }}>
                    {valueMin.toFixed(decimals)}
                </div>

                {/* Max value label */}
                <div style={{
                    position: 'absolute',
                    top: 22,
                    left: `${rightPercent}%`,
                    transform: 'translateX(-50%)',
                    color: enabled ? '#fff' : '#666',
                    fontSize: 10,
                    fontFamily: 'monospace',
                    whiteSpace: 'nowrap',
                    pointerEvents: 'none',
                }}>
                    {valueMax.toFixed(decimals)}
                </div>
            </div>
        </div>
    )
}
