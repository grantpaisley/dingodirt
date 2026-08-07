/** Ride-schema wiring: mount-on-boot + the selection handler.
 *
 *  Selection is apply-once: picking a schema overwrites the scheme-driven
 *  settings (heat colours) and mounts the CSS variables; later hand-tweaks
 *  to those settings stick (boot only re-mounts the variables, it never
 *  re-writes settings). 'default' clears the mount and restores factory
 *  heat colours. A schema that fails to load clears back to 'default' —
 *  it must never wedge the app theme. */
import { useEffect, useRef } from 'react'
import { useSettings, useUiState } from '../store'
import { getScheme } from './scheme'
import { applySchemeVars, heatColorsOf } from './applierPlan'
import { DINGO_STYLE_ID } from '../dingoBasemap'

/** The Dingo base style is themed BY the scheme, so a scheme change must
 *  rebuild it (other styles don't care — the nonce bump is gated to avoid
 *  pointless refetches of MapTiler styles). */
function refreshDingoStyle(): void {
    if (useSettings.getState().baseStyle === DINGO_STYLE_ID) {
        useUiState.getState().bumpStyleReload()
    }
}

/** Boot + change: (re-)mount the active schema's CSS variables. */
export function useRideSchemeMount(): void {
    const rideScheme = useSettings(s => s.rideScheme)
    const setRideScheme = useSettings(s => s.setRideScheme)
    // No Dingo-style rebuild on the boot run: the base-style effect is about
    // to build it from this same scheme anyway, and a second setStyle racing
    // the first lands mid-parse. Only a genuine scheme CHANGE rebuilds.
    const mounted = useRef(false)
    useEffect(() => {
        let alive = true
        const changed = mounted.current
        mounted.current = true
        const done = () => { if (changed) refreshDingoStyle() }
        if (rideScheme === 'default') { applySchemeVars(null); done(); return }
        getScheme(rideScheme)
            .then(scheme => { if (alive) { applySchemeVars(scheme); done() } })
            .catch(() => { if (alive) { applySchemeVars(null); setRideScheme('default') } })
        return () => { alive = false }
    }, [rideScheme, setRideScheme])
}

/** Apply a picked schema: persist the id, overwrite the scheme-driven
 *  settings, mount the variables (the mount hook also reacts to the id
 *  change — applySchemeVars is idempotent). */
export async function pickRideScheme(id: string): Promise<void> {
    const s = useSettings.getState()
    s.setRideScheme(id)
    if (id === 'default') {
        s.resetHeatColors()
        applySchemeVars(null)
        return
    }
    const scheme = await getScheme(id)
    const heat = heatColorsOf(scheme)
    s.setHeatColorOwn(heat.own)
    s.setHeatColorStrava(heat.strava)
    s.setHeatColorPlanned(heat.planned)
    applySchemeVars(scheme)
}
