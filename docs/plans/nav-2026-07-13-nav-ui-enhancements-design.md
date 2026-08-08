# Nav UI enhancements — design

Validated 2026-07-13. This document covers the nine-item enhancement batch for
the riding/navigation UI.

## 1. Zoom control stack

A right-edge column, top to bottom: `+` `−` `min` `med` `max` `▢` `●`.

- `+` / `−` — unchanged (a manual zoom = hold until the next turn approach).
- `▢` — fit the whole track (the existing fitBtn, relocated).
- `●` — re-centre on the location (existing, relocated).
- `min` / `med` / `max` — zoom presets, stored per vehicle in `S.set.zoomPresets[vehicle]`.
  - **Tap** — fly to that level and hold it (the same semantics as the manual zoom-hold; the app releases it at the next turn approach).
  - **Hold ~600 ms** — capture the current zoom as that preset. A toast shows "min zoom set — L12.4". The button label changes from the placeholder word to `L12`.
  - Internal per-vehicle defaults (min = the turn-approach zoom, max = the cruise zoom, med = the midpoint) make auto-zoom work before the user sets a preset. The labels stay `min`/`med`/`max` until the user sets them.

**Auto-zoom simplification.** We remove the speed curve and the ♥ favourite zoom. Cruise rides at `max`; a turn approach dives to `min`; `med` is a manual bookmark only. We rename the setting "Auto-zoom". Existing ♥ favourites migrate into `max` on the first load.

## 2. Compass mode

- **Trigger** — a new setting "Compass when zoomed in": *at turns* (default) / *above zoom threshold* / *off*. *At turns*: when `ns.approach` goes true, the orientation temporarily switches to compass. It reverts to the prior mode (north/course) when the approach ends. *Threshold*: a crossed zoom level drives it (an advanced knob). Manual N-button cycling overrides the automatic flip until the next approach.
- **Damping** — the EMA factor 0.25 → ~0.12 (an advanced slider); a dead-band that ignores heading changes < ~2°; the map rotation rate-limited to ~4 Hz with eased rotation. The damping doubles when the rider is stationary.

## 3. Route rendering

Two independent channels: **colour = steepness, pattern = road surface.** The Settings toggles are "Steepness colouring" (default on) and "Road-surface patterns" (default on):

| Steepness | Surface | Render |
|---|---|---|
| on | on (default) | grade-coloured line, dashed/dotted by surface |
| on | off | grade-coloured solid line |
| off | on | single track-colour, dashed/dotted by surface |
| off | off | plain solid single-colour line |

- Tracks without elevation fall back to surface/plain automatically (the existing arbitration).
- Quick toggles beside the selected track in the ☰ panel permit a mid-ride flip.
- **No outside lines**: we delete the dark `sel-casing` layer. Non-steepness modes get a same-colour translucent halo (~30 % opacity, wider, with the dash pattern matched to each segment). Steepness mode draws the bare gradient with no outline. Dash/dot gaps are fully transparent — no brown underlay.
- The combined mode implementation: intersect the grade bands (already stepped) × the surface runs into features that carry colour + surface. The three surface layers paint `line-color: ['get','c']`.
- **Direction arrows**: the existing `sel-chevrons` layer (`›` along the line, which flips with the riding direction) stays on top of every colour/pattern mode. Give the glyphs a contrasting halo, so they stay legible over grade-coloured dashes. The visuals are configurable in advanced (§10).

## 4. Heatmap / basemap colours (advanced)

Colour pickers: own rides (`#ff7a00`), other riders (`#ff2d2d`), planned (`#3390ff`), and the basemap minor-trail override (`#e06d00` — the orange clash). Plus a "basemap trail prominence" slider (the width/brightness of the override).

## 5. Bottom bar & START/STOP

START/STOP and the ⇄ reverse control move into the ☰ panel as a prominent top row (a big START + a reverse toggle beside the selected track). The bottom bar keeps only ☰ + the track name. STOP remains a glove tile. The freed strip hosts the countdown bar.

## 6. Countdown bar

The bottom strip has two modes:

- **Cruising** — the current viewport-matched progress strip, unchanged.
- **Turn approach** (`ns.approach`, the same signal that drives the compass flip and the min-zoom dive) — a fixed full-width bar. It fills left→right as `dTo` shrinks from the activation distance to zero. A large label counts down in **metres or seconds** (a settings choice; seconds = `dTo ÷ speed`, frozen when stopped). The bar colour: accent, then warn-amber inside the near distance. The bar snaps back to the progress strip after the app confirms the turn. The activation distance is an advanced knob.

## 7. Backtrack trail (breadcrumbs)

While the user navigates, record the actual ridden path — a point every ~20 m (an advanced knob) — in `S.trail`. Persist it to IndexedDB every minute (it survives a restart mid-ride). Render it as a muted dotted line under the route. A Settings toggle turns it on/off. The trail auto-clears when navigation of a *different* track starts. The app keeps the trail after a stop, for post-ride review. The trail continues to record off-track, and gives a visible thread back to the route.

## 8. Buttons transparent while routing

All floating controls (the zoom stack, N, the glove button, the hold pill) drop to a low opacity while `body.navving`. They return to full opacity on a touch, and fade back after a few seconds. The opacity level is an advanced knob.

## 9. Settings tabs

We reorganise the settings panel into tabs: **General** (name, ride code, screen-on, glove side, map style, Strava overlay) · **Nav** (sounds, vehicle, auto-zoom, compass-when-zoomed-in, countdown units, route colouring, backtrack trail) · **Keys** (hardware key bindings) · **Advanced** (hidden behind a "Show advanced" toggle in General).

## 10. Advanced tab (dev-tuning console)

Every row: a slider/stepper with the current value, a live effect, and a per-row reset. The values persist in `S.set.adv{}`. A "Copy tuning" button dumps the JSON. Thus we can hardcode tuned values later, and graduate rows out.

- **Compass & camera** — the heading damping EMA; the heading dead-band (°); the camera ease durations (900 ms follow / 500 ms orient).
- **Alerts & cues** — the per-vehicle far/near alert distances (the `VEH` table); the turn-approach framing multiplier (`farM × 1.5`, floor 250 m); off-track leave/return (`OFF_M 60` / `ON_M 40`); the beep volume.
- **Zoom & countdown** — the default min/med/max per vehicle; the countdown activation distance; metres↔seconds.
- **Rendering & misc** — the routing button opacity; the trail dot spacing/retention; the route halo opacity & width; the direction-arrow size, spacing, colour & halo (on/off included); the heatmap/basemap colours (§4); the GPS accuracy floor.

## Phase 2 (separate design): POIs & track grading

Imported GPX files often carry `<wpt>` waypoints and per-track grading/colours (e.g. multi-track files like G.O.A.T.). `parseGPX` currently drops the waypoints entirely. Phase 2 covers: waypoint parsing + storage, a POI map layer with names, per-track colour/grading extensions, and multi-track file handling. We exclude it from this batch deliberately, to keep the batch reviewable.
