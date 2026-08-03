# Nav behaviour framework — `.dingobehavior`

*2026-08-03. Research: two adversarially-verified deep-research passes (204 agents, 44 sources; every claim below marked ✓ survived 3-vote verification against primary docs). Companion code: `js/behavior.js`, `behaviors/*.json`, `tests/behavior.test.mjs`.*

## Goal

A declarative config file that makes Dingo Nav *behave* like Google Maps, Waze, Locus Map, or DMD2 — camera, guidance, off-route, rerouting, voice, HUD — the way `.dingoscheme` already makes it *look* like them. Editable in Dingo Studio later, pushable to Plan and Nav.

## Contract

`.dingobehavior` is a sibling of `.dingoscheme` with the identical compatibility contract:

- apps **ignore unknown** params and **default missing** params (defaults = Dingo Nav's current hardcoded behaviour, so an empty profile changes nothing)
- values only, never executable
- `schemaVersion` major mismatch → plain-message reject at import
- bad values are dropped/clamped at validation — a bad param must never brick Nav mid-ride
- cross-param bad combos (e.g. strict point order + point-priority reroute) produce **warnings** for the editor, never rejects

Types are the scheme's `number | bool | select` plus one new type, `curve`: up to 8 `[speedKmh, viewSpanM]` pairs, auto-sorted — the speed→zoom table every researched app implements in some form.

A **profile pairing** (scheme + behaviour with the same id) is what "make it feel like Waze" means; `behaviors/index.json` mirrors `schemes/index.json` so the Studio dropdowns can offer both side by side, and pack export can embed both the way `bundle.json.scheme` embeds the scheme today.

## What the research established, per app

### Locus Map — the configurability benchmark (all ✓ high confidence, official manual)

The richest source: nearly every behaviour is an explicit user setting, so its docs read like a config schema already.

- **Rerouting is a three-value enum**: *none* (falls back to a guiding line toward the nearest original route point), *point priority* (recalculate to the next via point/finish), *route priority* (rejoin the original line at the nearest point). Trigger = configurable off-route distance (default **100 m**); re-trigger fixed at **30 s** while still deviating. Route priority is what track-following wants.
- **Snap to route** is an explicit toggle — cursor locks to the line, ignoring small GPS wander.
- **Off-route alerting is independent of rerouting**: own distance, repeat interval, and channel (beep / voice announcing direction+distance to the nearest route point / vibration). A recommendation article suggests ~75 m in rugged terrain.
- **Voice verbosity** is a four-level `none/low/medium/high` density setting (applies to shape-derived cues), plus a separate **"Two commands at once"** stacking toggle for close maneuvers.
- **Three guidance paradigms** besides computed turn-by-turn: *navigation along a route* (cues auto-generated from track geometry at significant direction changes — no maneuver data needed), *route guidance* (sequential point-chain), and *point guidance* (pure beeline bearing-to-target). A *maximum allowed deviation* demotes navigation to guidance when exceeded.
- **Auto-zoom is a hardcoded per-activity speed table** — car: speeds {0, 50, 100, 200} km/h → displayed zooms ≈ {18, 17, 16, 13}. Users hit blurry over-zoom beyond offline map levels → a **max-zoom cap** belongs in the schema.
- **UI is per-panel toggleable**: next-turn panel `full/small/disabled`, stats/street panels, dashed line-to-destination; *strict route following* exists and is documented as incompatible with point-priority rerouting (kept as a schema warning).

### DMD2 — the camera model (✓ high, official docs; one ✓ medium)

- **Follow mode is a four-value enum**: Disabled / **Top North** (north-up) / **Face Travel** (course-up) / Paused (auto-suspended after a map gesture) → `followMode` + `pauseOnGesture`.
- **Tilt** is a two-finger gesture, persisted **only in Face Travel** mode; **Auto-Zoom and Auto-Tilt are independent toggles**.
- **GPX tracks render as raw lines — no routing, no instructions by default** ("ideal for off-road because the underlying map is not relevant"), with an optional *attempt turn-by-turn* setting (✓ medium, 2-1 vote) → `cueSource: none` is a legitimate preset value, not an error state.
- Four freely-assignable widget slots rather than a fixed speedo/ETA layout; GPX breadcrumb ride recording; three routing profiles (Road Fast / Road Fun / Off-Road). DMD-Next auto-reroutes silently on routes (unverified for thresholds — preset models the track use-case with `reroute: none`).

### Google Maps — the mainstream reference (✓ high, Help Center + Navigation SDK)

- **Audio is a tiered enum, not a channel matrix**: Mute / **Alerts only** (traffic etc., no turn instructions) / full guidance — the one *refuted* claim in the research was modelling alerts and guidance as independent toggles. → `voice.mode` gains `alertsOnly`.
- **Camera defaults to course-up follow with exactly three perspectives**: tilted-3D (default), heading-up 2D, north-up 2D; compass tap toggles tilted ↔ overview.
- **Overview mode is time-capped** on Android: frames only the next **45 minutes** of driving, not the whole route → `camera.overviewWindowMin`.
- **Turn banner**: primary maneuver + "then" next-step preview + separate distance value/units + lane guidance with highlighted recommended lane; dynamic height.
- **Night mode**: `AUTO` (location + local time, i.e. sunset-style) / force-day / force-night → `hud.nightAuto`.
- **Speedometer**: toggleable, informational, changes colour over the limit; SDK defaults **+8 km/h ≈ +5 mph → red text**, **+16 km/h ≈ +10 mph → red background**.
- Alternate routes render grey during nav, tap-to-switch.

### Waze — the speed stack (✓ high, single official help article)

- Speedometer turns red over the limit; **speeding threshold is user-configurable** (at limit or % over); "show speed limit" is a *when*-condition; the **audible** speeding alert is a separate opt-in from the visual → `hud.speedAlert: none/visual/audible/both` + `hud.speedAlertKmh`.

### What stayed unverified (presets marked ⚠ assumption)

No claims survived for either mainstream app's **announcement distances/tiers, rerouting prompts ("better route found"), off-route detection speed, waypoint auto-advance, ETA bar contents, traveled-route rendering** — nor for Waze's camera/voice/night behaviour at all. The Google/Waze preset values for `offroute.*`, `reroute.triggerM/retrySecs`, `cues.farSecs`, `camera.zoomCurve/pitch` are plausible-behaviour assumptions chosen to *feel* right, not documented numbers. Locus preset zoom spans are derived from its grounded zoom-level table assuming a ~700 px viewport; its `northUp` default and DMD2's pitch/zoom numbers are assumptions. Everything else in the presets is grounded above.

## The parameter registry (54 params, 8 groups)

See `js/behavior.js` for authoritative types/ranges/defaults. The shape:

| Group | Params | Grounding |
|---|---|---|
| `guidance` | mode (track/turnByTurn/routeGuidance/bearing), cueSource (marks/shape/router/none), strictOrder, laneGuidance, stackCues, waypointAdvance | Locus's four paradigms; DMD2's instruction-free tracks; Google's lane guidance + "then" stacking |
| `camera` | followMode, pauseOnGesture, pitch, autoZoom, zoomCurve, maxZoom, approachZoom/-Secs/-Mul/-FloorM, lookAhead, easeMs, overviewWindowMin | DMD2 follow enum + gesture pause; Google perspectives + 45-min overview; Locus speed table + over-zoom cap; Dingo's approach-dive |
| `position` | snapToRoute, marker, breadcrumb, breadcrumbSpacingM | Locus snap toggle; DMD2 ride recording |
| `offroute` | detectM, rejoinM, alert, repeatSecs, banner, guideLine, maxDeviationM | Dingo's 60/40 hysteresis; Locus's independent alert + guide line + max-deviation demotion |
| `reroute` | mode (none/routePriority/pointPriority), triggerM, retrySecs, confirm | Locus's enum verbatim; Google/Waze silent auto ≈ routePriority + confirm:false |
| `cues` | farSecs/farMinM/farMaxM, nearSecs/nearMinM/nearMaxM, dangerFarM/dangerNearM, confirmAfterM | Dingo's speed-scaled two-tier warn model, generalised |
| `voice` | mode (beeps/tts/alertsOnly/silent), density, streetNames | Google's tiered enum; Locus's density levels; Dingo's beep grammar as a first-class mode |
| `hud` | speedo, speedLimit, speedAlert, speedAlertKmh, nextTurnPanel, etaPanel, units, nightAuto | Waze speed stack; Google speedo thresholds + night AUTO; Locus panel modes |

## Update (same day): wired + the ui facet

Rollout steps 1–2a landed the same day, plus a fourth facet the review surfaced:

- **`chrome.*` token group in `.dingoscheme`** (the ui facet — 11 tokens): turn-panel shape (`bar`/`card`) + optional tinted fill, speedo style (`bare`/`circle`/`card`/`cell`) + position, ETA style (`bar`/`pill`/`cells` widget row), speed-limit sign shape, re-centre position/shape, big side arrows, zoom buttons, chrome scale. The rule: **scheme = where it sits and what it looks like; behaviour = whether/when it shows and how it acts.** Old apps ignore the group (ignore-unknown contract).
- **NavView consumes both**: every constant in the table below now reads through `bv(profile,…)`; chrome tokens apply as data-attributes + CSS variants; `setBehavior()` swaps feel live (pitch ease, marker re-bake, orient).
- **`camera.zoomMode`** (`cruise`/`speed`) was added when wiring revealed Nav proper does *not* interpolate zoom by speed — it holds the curve's max span and dives to min on approach (`presetSpan`/`cruiseZoom` in Nav's index.html). `cruise` preserves that grammar (default); `speed` interpolates the curve (Locus/DMD2/Google presets).
- **Camera dead-reckoning**: eases now aim at position + wall-clock velocity × (ease time + half fix gap). Without it, close-zoom profiles (span 150–500 m) trailed the 10×-replay rider clean off-screen; Nav's classic wide cruise had hidden the lag.
- **Multi-view = profile selector**: each view has a scheme dropdown plus a behaviour dropdown defaulting to **⛓ matched** (pairs by preset id — picking "Google Maps" swaps look *and* feel); any explicit behaviour choice is mix-and-match. Community framing: riders pick a profile, tinkerers remix facets, devs add params.

## Param → current code map (wiring is mechanical)

| Param | Today in `js/navview.js` |
|---|---|
| `camera.zoomCurve` | `VEH.spans` (m/s → span) at :96 |
| `camera.approachSecs/Mul/FloorM` | `APPR_S`, `APPR_MUL`, `APPR_FLOOR` at :97 |
| `cues.far*/near*` | `VEH.farMin/farMax/nearMin/nearMax` + `aSpd * APPR_S` / `aSpd * 5` in `onFix` |
| `cues.dangerFarM/NearM` | `DANGER_FAR/NEAR` (cues.js:278) |
| `cues.confirmAfterM` | `DEPART_M` |
| `offroute.detectM/rejoinM` | `OFF_M`/`ON_M` |
| `offroute.repeatSecs` | `30e3` in the off-beep throttle |
| `camera.followMode` | `opts.orient` ('north'/'course') |
| `camera.lookAhead` | `vh * 0.15` in `_followCamera` |
| `camera.easeMs` | `duration: 900` / `lastEase < 800` |
| `position.breadcrumbSpacingM` | `< 20` in `_trailPush` |
| `hud.nextTurnPanel` | `_setHud` visibility logic |
| `voice.mode` | `BEEP` grammar / `SOUND.on` |

Not yet implemented anywhere (schema is forward-looking, per the ignore-unknown contract old apps just skip them): `reroute.*` (needs a routing engine), `guidance.laneGuidance`, `position.snapToRoute`, `camera.pitch/overviewWindowMin`, `hud.speedLimit/speedAlert` (needs limit data), `voice.tts`.

## Rollout (mirrors the scheme rollout)

1. **NavView consumes a profile** — replace the constants above with `bv(profile, …)` reads; `opts.behavior` on the constructor, default = `defaultParams()`. Multi-view demo gets a behaviour dropdown beside the scheme dropdown → N viewports, same replay, different *feels* (the whole point of the framework).
2. **Studio editor** — a Behaviour workspace generated from `PARAM_GROUPS` exactly like the scheme editor is generated from `TOKEN_GROUPS`; `behaviorWarnings()` renders inline.
3. **Pack embedding** — `bundle.json.behavior = {name,url}` reference + embedded copy, same as schemes gained on 2026-08-03.
4. **Push to Plan/Nav** — behaviour applier becomes canonical here first (like `applier-nav.js`), reverses direction when the apps adopt it; daemon `PUT /api/behaviors/{id}` mirrors the styles endpoint.

## Open questions

- Google/Waze announcement-distance tiers and reroute thresholds (unverified — worth a hands-on drive capture before trusting those preset numbers).
- DMD2-Next "Navigation & Routing" / "Settings & Layers" docs were identified but not mined — would firm up its reroute/voice presets.
- Whether `cues.density` should modulate shape-derived cue *generation* (Locus semantics) or mark *filtering* (Dingo semantics) once `cueSource: shape` is implemented.
- Speed-dependence of cue distances is modelled as Dingo's `secs × speed clamped [min,max]`; Locus/Google may use road-class tiers instead — revisit if a preset feels wrong at speed.
