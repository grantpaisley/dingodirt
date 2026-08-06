import { useRef, useState, useCallback } from 'react'
import {
    useSettings, scaleDomain, stopsToPercents, gradientCss, cssColor, activeColors,
    PALETTES, type ColourScale,
} from '../../store'
import { useSchemeIndex } from '../../scheme/scheme'
import { pickRideScheme } from '../../scheme/useRideScheme'

/** One "Heat colors" row: swatch picker + label */
function HeatColorRow({ label, title, value, onChange }: {
    label: string
    title: string
    value: string
    onChange: (hex: string) => void
}) {
    return (
        <label
            title={title}
            style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '4px 0', cursor: 'pointer',
            }}
        >
            <input
                type="color"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                style={{
                    width: 26, height: 18, padding: 0,
                    border: '1px solid #555', borderRadius: 3,
                    background: 'transparent', cursor: 'pointer',
                }}
            />
            <span style={{ color: '#ccc', fontSize: 11 }}>{label}</span>
        </label>
    )
}

/**
 * Settings pane content — HR / speed / grade colour scales. Per scale:
 * pick a palette, toggle which of its colours are used (min 2 — two colours
 * gives a simple below/above threshold look), and drag one stop per active
 * colour to place it along the value axis. Rendered inside the map toolbar.
 */
export function SettingsPaneContent() {
    const {
        hrScale, speedScale, gradeScale,
        setHrScale, setSpeedScale, setGradeScale, resetColourScales,
        heatColorOwn, setHeatColorOwn,
        heatColorStrava, setHeatColorStrava,
        heatColorPlanned, setHeatColorPlanned,
        resetHeatColors,
        rideScheme,
    } = useSettings()
    const schemeEntries = useSchemeIndex()

    return (
        <div style={{ width: 280 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ color: 'white', fontSize: 12, fontWeight: 'bold' }}>Colour scales</span>
                <button
                    onClick={resetColourScales}
                    style={{ background: 'transparent', color: '#888', border: 'none', cursor: 'pointer', fontSize: 10 }}
                >
                    Reset
                </button>
            </div>

            <ScaleEditor label="Heart rate (bpm)" kind="hr" scale={hrScale} onChange={setHrScale} />
            <ScaleEditor label="Speed (km/h)" kind="speed" scale={speedScale} onChange={setSpeedScale} />
            <ScaleEditor label="Grade (% steepness)" kind="grade" scale={gradeScale} onChange={setGradeScale} />
            <div style={{ color: '#777', fontSize: 10, marginTop: 4 }}>
                Pick a palette, click its swatches to choose which colours are
                used (at least two), then drag the markers (or edit the
                numbers) to place each colour&apos;s stop.
            </div>

            {/* Ride schema: Studio's .dingoscheme presets (vendored in
                /public/schemes) — picking one themes the app (CSS variables)
                and overwrites the scheme-driven settings below (heat colours);
                hand-tweaks made afterwards stick. */}
            <div style={{ display: 'flex', justifyContent: 'space-between', margin: '16px 0 4px' }}>
                <span style={{ color: 'white', fontSize: 12, fontWeight: 'bold' }}>Ride schema</span>
            </div>
            <select
                value={rideScheme}
                onChange={(e) => { void pickRideScheme(e.target.value) }}
                title="Look-and-feel preset shared with DingoNav — overwrites heat colours and the app theme"
                style={{
                    width: '100%', padding: '4px 6px', fontSize: 11,
                    background: 'var(--bg-dark)', color: 'var(--text-primary)',
                    border: '1px solid #555', borderRadius: 3, cursor: 'pointer',
                }}
            >
                <option value="default">Dingo default</option>
                {schemeEntries.filter(e => e.id !== 'default').map(e => (
                    <option key={e.id} value={e.id}>{e.label}</option>
                ))}
            </select>

            {/* Heat colours: orange = me, blue = everything not ridden by me
                (Strava overlays + planned heat) — each overridable. */}
            <div style={{ display: 'flex', justifyContent: 'space-between', margin: '16px 0 4px' }}>
                <span style={{ color: 'white', fontSize: 12, fontWeight: 'bold' }}>Heat colors</span>
                <button
                    onClick={resetHeatColors}
                    style={{ background: 'transparent', color: '#888', border: 'none', cursor: 'pointer', fontSize: 10 }}
                >
                    Reset
                </button>
            </div>
            <HeatColorRow
                label="My heatmap"
                title="Density heat from your own rides"
                value={heatColorOwn}
                onChange={setHeatColorOwn}
            />
            <HeatColorRow
                label="Strava overlays"
                title="Harvested Strava ride/hike rasters — applied as an approximate hue tint (the tiles are pre-colourised; the hike purple shifts by the same amount)"
                value={heatColorStrava}
                onChange={setHeatColorStrava}
            />
            <HeatColorRow
                label="Planned heat"
                title="Density heat over every planned route"
                value={heatColorPlanned}
                onChange={setHeatColorPlanned}
            />
        </div>
    )
}

function ScaleEditor({
    label,
    kind,
    scale,
    onChange,
}: {
    label: string
    kind: 'hr' | 'speed' | 'grade'
    scale: ColourScale
    onChange: (s: ColourScale) => void
}) {
    const barRef = useRef<HTMLDivElement>(null)
    const [dragging, setDragging] = useState<number | null>(null)

    const [dMin, dMax] = scaleDomain(kind, scale)
    const percents = stopsToPercents(kind, scale)
    const colors = activeColors(scale)
    const palette = PALETTES[scale.palette]

    const update = (i: number, raw: string) => {
        const v = Number(raw)
        if (!Number.isFinite(v)) return
        const stops = [...scale.stops]
        stops[i] = v
        onChange({ ...scale, stops })
    }

    const dragTo = useCallback((clientX: number, i: number) => {
        if (!barRef.current) return
        const rect = barRef.current.getBoundingClientRect()
        const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
        let v = Math.round(dMin + t * (dMax - dMin))
        // Keep stops strictly ascending: clamp between neighbours
        const lo = i > 0 ? scale.stops[i - 1] + 1 : dMin
        const hi = i < scale.stops.length - 1 ? scale.stops[i + 1] - 1 : dMax
        v = Math.max(lo, Math.min(hi, v))
        if (v !== scale.stops[i]) {
            const stops = [...scale.stops]
            stops[i] = v
            onChange({ ...scale, stops })
        }
    }, [scale, dMin, dMax, onChange])

    // Toggle a palette swatch on/off, inserting/removing its stop so the
    // remaining stops keep their user-set positions
    const toggleColor = (idx: number) => {
        const enabled = [...scale.enabled]
        const stops = [...scale.stops]
        // This swatch's position among the active colours
        const activeIdx = enabled.slice(0, idx).filter(Boolean).length
        if (enabled[idx]) {
            if (stops.length <= 2) return // at least two colours
            enabled[idx] = false
            stops.splice(activeIdx, 1)
        } else {
            enabled[idx] = true
            const last = stops.length - 1
            const v = activeIdx === 0
                ? stops[0] - Math.max(1, stops[1] - stops[0])   // extend below
                : activeIdx > last
                    ? stops[last] + Math.max(1, stops[last] - stops[last - 1]) // extend above
                    : (stops[activeIdx - 1] + stops[activeIdx]) / 2            // midpoint
            stops.splice(activeIdx, 0, Math.round(v * 10) / 10)
        }
        onChange({ ...scale, enabled, stops })
    }

    const ascending = scale.stops.every((b, i) => i === 0 || b > scale.stops[i - 1])

    return (
        <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ color: '#ccc', fontSize: 11 }}>{label}</span>
                {/* Palette picker: mini gradient per palette */}
                <span style={{ display: 'flex', gap: 3 }}>
                    {Object.entries(PALETTES).map(([key, p]) => (
                        <button
                            key={key}
                            onClick={() => onChange({ ...scale, palette: key })}
                            title={`${p.label} palette`}
                            style={{
                                width: 24,
                                height: 12,
                                padding: 0,
                                borderRadius: 3,
                                border: scale.palette === key ? '1px solid white' : '1px solid #444',
                                background: `linear-gradient(90deg, ${p.colors.map(cssColor).join(', ')})`,
                                cursor: 'pointer',
                                opacity: scale.palette === key ? 1 : 0.6,
                            }}
                        />
                    ))}
                </span>
            </div>
            {/* Swatch toggles: which of the palette's colours are used */}
            <div style={{ display: 'flex', gap: 5, marginBottom: 6 }}>
                {palette.colors.map((c, i) => {
                    const on = scale.enabled[i]
                    return (
                        <button
                            key={i}
                            onClick={() => toggleColor(i)}
                            title={on ? 'Click to remove this colour from the scale' : 'Click to add this colour to the scale'}
                            style={{
                                width: 20,
                                height: 20,
                                padding: 0,
                                borderRadius: '50%',
                                border: on ? '2px solid white' : '2px solid #555',
                                background: cssColor(c),
                                opacity: on ? 1 : 0.25,
                                cursor: 'pointer',
                                flexShrink: 0,
                            }}
                        />
                    )
                })}
            </div>
            {/* Gradient bar with draggable stop markers (one per active colour) */}
            <div
                ref={barRef}
                onPointerMove={(e) => { if (dragging != null) dragTo(e.clientX, dragging) }}
                onPointerUp={(e) => {
                    if (dragging != null) e.currentTarget.releasePointerCapture(e.pointerId)
                    setDragging(null)
                }}
                style={{
                    position: 'relative',
                    height: 22,
                    borderRadius: 3,
                    background: gradientCss(kind, scale),
                    marginBottom: 6,
                    touchAction: 'none',
                }}
            >
                {percents.map((p, i) => (
                    <div
                        key={i}
                        onPointerDown={(e) => {
                            e.preventDefault()
                            try {
                                (e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId)
                            } catch { /* synthetic pointers can't be captured — drag still works */ }
                            setDragging(i)
                        }}
                        title={`${scale.stops[i]} — drag to adjust`}
                        style={{
                            position: 'absolute',
                            left: `calc(${Math.max(0, Math.min(100, p))}% - 5px)`,
                            top: -3,
                            width: 10,
                            height: 28,
                            cursor: 'ew-resize',
                            display: 'flex',
                            justifyContent: 'center',
                            zIndex: dragging === i ? 3 : 2,
                        }}
                    >
                        <div style={{
                            width: 4,
                            height: '100%',
                            background: cssColor(colors[i]),
                            boxShadow: '0 0 0 1px white, 0 0 3px rgba(0,0,0,0.9)',
                            borderRadius: 2,
                        }} />
                    </div>
                ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
                {scale.stops.map((b, i) => (
                    <input
                        key={i}
                        type="number"
                        value={b}
                        onChange={(e) => update(i, e.target.value)}
                        style={{
                            width: '100%',
                            minWidth: 0,
                            background: '#1a1a1a',
                            color: 'white',
                            border: `1px solid ${ascending ? '#444' : '#c0392b'}`,
                            borderRadius: 4,
                            padding: '3px 5px',
                            fontSize: 11,
                        }}
                    />
                ))}
            </div>
            {!ascending && (
                <div style={{ color: '#e74c3c', fontSize: 10, marginTop: 3 }}>
                    Stops must be ascending
                </div>
            )}
        </div>
    )
}
