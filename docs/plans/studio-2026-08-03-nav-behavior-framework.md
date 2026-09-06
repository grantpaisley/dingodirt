# Nav behaviour framework — `.dingobehavior`

*2026-08-03. Research: two adversarially-verified deep-research passes (204 agents, 44 sources). Every claim below with a ✓ mark survived 3-vote verification against primary docs. Companion code: `js/behavior.js`, `behaviors/*.json`, `tests/behavior.test.mjs`.*

## Goal

We want a declarative config file that makes Dingo Nav *behave* like Google Maps, Waze, Locus Map, or DMD2. The file covers the camera, guidance, off-route, rerouting, voice, and HUD. This is the same way that `.dingoscheme` already makes Nav *look* like those apps. The file is editable in Dingo Studio later. You can push it to Plan and Nav.

## Contract

`.dingobehavior` is a sibling of `.dingoscheme` with the identical compatibility contract:

- Apps **ignore unknown** params and **default missing** params. The defaults = Dingo Nav's current hardcoded behaviour. Thus an empty profile changes nothing.
- The file holds values only, never executable code.
- A `schemaVersion` major mismatch → a plain-message reject at import.
- Validation drops or clamps bad values. A bad param must never brick Nav mid-ride.
- Bad cross-param combos (e.g. strict point order + point-priority reroute) make **warnings** for the editor, never rejects.

The types are the scheme's `number | bool | select` plus one new type, `curve`. A `curve` holds up to 8 `[speedKmh, viewSpanM]` pairs, auto-sorted. This is the speed→zoom table that every researched app implements in some form.

A **profile pairing** (a scheme + a behaviour with the same id) is what "make it feel like Waze" means. `behaviors/index.json` mirrors `schemes/index.json`. Thus the Studio dropdowns can offer both side by side. The pack export can embed both, the same way that `bundle.json.scheme` embeds the scheme today.

## What the research established, per app

### Locus Map — the configurability benchmark (all ✓ high confidence, official manual)

This is the richest source. Nearly every behaviour is an explicit user setting. Thus its docs read like a config schema already.

- **Rerouting is a three-value enum**: *none* (falls back to a guiding line toward the nearest original route point), *point priority* (recalculate to the next via point/finish), *route priority* (rejoin the original line at the nearest point). The trigger = a configurable off-route distance (default **100 m**). The re-trigger is fixed at **30 s** while the deviation continues. Route priority is what track-following wants.
- **Snap to route** is an explicit toggle. The cursor locks to the line and ignores small GPS wander.
- **Off-route alerting is independent of rerouting**. It has its own distance, its own repeat interval, and its own channel (a beep / a voice that announces the direction+distance to the nearest route point / a vibration). A recommendation article suggests about 75 m in rugged terrain.
- **Voice verbosity** is a four-level `none/low/medium/high` density setting (it applies to shape-derived cues). A separate **"Two commands at once"** toggle stacks close maneuvers.
- Locus has **three guidance paradigms** besides computed turn-by-turn. One: *navigation along a route* (the app auto-generates cues from the track geometry at significant direction changes — no maneuver data is needed). Two: *route guidance* (a sequential point-chain). Three: *point guidance* (a pure beeline bearing-to-target). A *maximum allowed deviation* demotes navigation to guidance when the rider exceeds it.
- **Auto-zoom is a hardcoded per-activity speed table**. For a car: speeds {0, 50, 100, 200} km/h → displayed zooms ≈ {18, 17, 16, 13}. Users hit blurry over-zoom beyond the offline map levels. Thus a **max-zoom cap** belongs in the schema.
- **The UI is per-panel toggleable**: the next-turn panel is `full/small/disabled`, plus stats/street panels and a dashed line-to-destination. *Strict route following* exists. The docs say it is incompatible with point-priority rerouting (we keep this as a schema warning).

### DMD2 — the camera model (✓ high, official docs; one ✓ medium)

- **Follow mode is a four-value enum**: Disabled / **Top North** (north-up) / **Face Travel** (course-up) / Paused (auto-suspended after a map gesture) → `followMode` + `pauseOnGesture`.
- **Tilt** is a two-finger gesture. The app persists it **only in Face Travel** mode. **Auto-Zoom and Auto-Tilt are independent toggles**.
- **GPX tracks render as raw lines — no routing, no instructions by default** ("ideal for off-road because the underlying map is not relevant"). An optional *attempt turn-by-turn* setting exists (✓ medium, a 2-1 vote). Thus `cueSource: none` is a legitimate preset value, not an error state.
- DMD2 has four freely-assignable widget slots, not a fixed speedo/ETA layout. It has GPX breadcrumb ride recording. It has three routing profiles (Road Fast / Road Fun / Off-Road). DMD-Next auto-reroutes silently on routes (the thresholds are unverified — the preset models the track use-case with `reroute: none`).

### Google Maps — the mainstream reference (✓ high, Help Center + Navigation SDK)

- **Audio is a tiered enum, not a channel matrix**: Mute / **Alerts only** (traffic etc., no turn instructions) / full guidance. The one *refuted* claim in the research modelled alerts and guidance as independent toggles. → `voice.mode` gets `alertsOnly`.
- **The camera defaults to course-up follow with exactly three perspectives**: tilted-3D (default), heading-up 2D, and north-up 2D. A compass tap toggles tilted ↔ overview.
- **Overview mode is time-capped** on Android. It frames only the next **45 minutes** of driving, not the whole route → `camera.overviewWindowMin`.
- **Turn banner**: the primary maneuver + a "then" next-step preview + a separate distance value/units + lane guidance with the recommended lane highlighted. The height is dynamic.
- **Night mode**: `AUTO` (location + local time, i.e. sunset-style) / force-day / force-night → `hud.nightAuto`.
- **Speedometer**: toggleable and informational. It changes colour over the limit. The SDK defaults: **+8 km/h ≈ +5 mph → red text**, **+16 km/h ≈ +10 mph → red background**.
- Alternate routes render grey during nav, with tap-to-switch.

### Waze — the speed stack (✓ high, single official help article)

- The speedometer turns red over the limit. **The speeding threshold is user-configurable** (at the limit or a % over). "Show speed limit" is a *when*-condition. The **audible** speeding alert is a separate opt-in from the visual alert → `hud.speedAlert: none/visual/audible/both` + `hud.speedAlertKmh`.

### What stayed unverified (presets marked ⚠ assumption)

No claims survived for either mainstream app's **announcement distances/tiers, rerouting prompts ("better route found"), off-route detection speed, waypoint auto-advance, ETA bar contents, or traveled-route rendering**. No claims survived for Waze's camera/voice/night behaviour at all. The Google/Waze preset values for `offroute.*`, `reroute.triggerM/retrySecs`, `cues.farSecs`, and `camera.zoomCurve/pitch` are plausible-behaviour assumptions. We chose them to *feel* right. They are not documented numbers. The Locus preset zoom spans come from its grounded zoom-level table, with an assumed viewport near 700 px. Its `northUp` default and DMD2's pitch/zoom numbers are assumptions. All other preset values are grounded above.

## The parameter registry (54 params, 8 groups)

See `js/behavior.js` for the authoritative types, ranges, and defaults. The shape:

| Group | Params | Grounding |
|---|---|---|
| `guidance` | mode (track/turnByTurn/routeGuidance/bearing), cueSource (marks/shape/router/none), strictOrder, laneGuidance, stackCues, waypointAdvance | Locus's four paradigms; DMD2's instruction-free tracks; Google's lane guidance + "then" stacking |
| `camera` | followMode, pauseOnGesture, pitch, autoZoom, zoomCurve, maxZoom, approachZoom/-Secs/-Mul/-FloorM, lookAhead, easeMs, overviewWindowMin | DMD2's follow enum + gesture pause; Google's perspectives + 45-min overview; Locus's speed table + over-zoom cap; Dingo's approach-dive |
| `position` | snapToRoute, marker, breadcrumb, breadcrumbSpacingM | Locus's snap toggle; DMD2's ride recording |
| `offroute` | detectM, rejoinM, alert, repeatSecs, banner, guideLine, maxDeviationM | Dingo's 60/40 hysteresis; Locus's independent alert + guide line + max-deviation demotion |
| `reroute` | mode (none/routePriority/pointPriority), triggerM, retrySecs, confirm | Locus's enum verbatim; Google/Waze silent auto ≈ routePriority + confirm:false |
| `cues` | farSecs/farMinM/farMaxM, nearSecs/nearMinM/nearMaxM, dangerFarM/dangerNearM, confirmAfterM | Dingo's speed-scaled two-tier warn model, generalised |
| `voice` | mode (beeps/tts/alertsOnly/silent), density, streetNames | Google's tiered enum; Locus's density levels; Dingo's beep grammar as a first-class mode |
| `hud` | speedo, speedLimit, speedAlert, speedAlertKmh, nextTurnPanel, etaPanel, units, nightAuto | Waze's speed stack; Google's speedo thresholds + night AUTO; Locus's panel modes |

## Update (same day): wired + the ui facet

Rollout steps 1–2a landed the same day. A fourth facet, which the review surfaced, also landed:

- **The `chrome.*` token group in `.dingoscheme`** (the ui facet — 11 tokens): the turn-panel shape (`bar`/`card`) + an optional tinted fill, the speedo style (`bare`/`circle`/`card`/`cell`) + position, the ETA style (`bar`/`pill`/`cells` widget row), the speed-limit sign shape, the re-centre position/shape, big side arrows, zoom buttons, and the chrome scale. The rule: **the scheme = where it sits and what it looks like; the behaviour = whether/when it shows and how it acts.** Old apps ignore the group (the ignore-unknown contract).
- **NavView consumes both**: every constant in the table below now reads through `bv(profile,…)`. The chrome tokens apply as data-attributes + CSS variants. `setBehavior()` swaps the feel live (pitch ease, marker re-bake, orient).
- **`camera.zoomMode`** (`cruise`/`speed`) was added when the wiring showed that Nav proper does *not* interpolate zoom by speed. Nav holds the max span of the curve and dives to the min on approach (`presetSpan`/`cruiseZoom` in Nav's index.html). `cruise` preserves that grammar (the default). `speed` interpolates the curve (the Locus/DMD2/Google presets).
- **Camera dead-reckoning**: the eases now aim at the position + the wall-clock velocity × (the ease time + half the fix gap). Without it, close-zoom profiles (span 150–500 m) trailed the 10×-replay rider clean off-screen. Nav's classic wide cruise had hidden the lag.
- **Multi-view = a profile selector**: each view has a scheme dropdown plus a behaviour dropdown. The behaviour dropdown defaults to **⛓ matched** (it pairs by preset id — when you pick "Google Maps", the look *and* the feel swap). An explicit behaviour choice is mix-and-match. The community framing: riders pick a profile, tinkerers remix facets, devs add params.

## Param → current code map (wiring is mechanical)

| Param | Today in `js/navview.js` |
|---|---|
| `camera.zoomCurve` | `VEH.spans` (m/s → span) at :96 |
| `camera.approachSecs/Mul/FloorM` | `APPR_S`, `APPR_MUL`, `APPR_FLOOR` at :97 |
| `cues.far*/near*` | `VEH.farMin/farMax/nearMin/nearMax` + `aSpd * APPR_S` / `aSpd * 5` in `onFix` |
| `cues.dangerFarM/NearM` | `DANGER_FAR/NEAR` (cues.js:278) |
| `cues.confirmAfterM` | `DEPART_M` |
| `offroute.detectM/rejoinM` | `VEHICLES[v].offM/onM` (per-vehicle since 2026-09-06; was `OFF_M`/`ON_M`) |
| `offroute.repeatSecs` | `30e3` in the off-beep throttle |
| `camera.followMode` | `opts.orient` ('north'/'course') |
| `camera.lookAhead` | `vh * 0.15` in `_followCamera` |
| `camera.easeMs` | `duration: 900` / `lastEase < 800` |
| `position.breadcrumbSpacingM` | `< 20` in `_trailPush` |
| `hud.nextTurnPanel` | `_setHud` visibility logic |
| `voice.mode` | `BEEP` grammar / `SOUND.on` |

Some params are not implemented anywhere yet. The schema is forward-looking. Per the ignore-unknown contract, old apps just skip them: `reroute.*` (needs a routing engine), `guidance.laneGuidance`, `camera.overviewWindowMin`, `hud.speedLimit/speedAlert` (needs limit data), `voice.tts`. (`position.snapToRoute` gained a Nav home on 2026-09-06 as the per-vehicle track lock — `docs/plans/2026-09-06-nav-track-lock-design.md`; `camera.pitch` on 2026-08-15.)

## Rollout (mirrors the scheme rollout)

1. **NavView consumes a profile** — replace the constants above with `bv(profile, …)` reads. Add `opts.behavior` on the constructor, with the default = `defaultParams()`. The multi-view demo gets a behaviour dropdown beside the scheme dropdown → N viewports, the same replay, different *feels* (the whole point of the framework).
2. **Studio editor** — a Behaviour workspace, generated from `PARAM_GROUPS` exactly like the scheme editor is generated from `TOKEN_GROUPS`. `behaviorWarnings()` renders inline.
3. **Pack embedding** — `bundle.json.behavior = {name,url}` reference + an embedded copy, the same as schemes gained on 2026-08-03.
4. **Push to Plan/Nav** — the behaviour applier becomes canonical here first (like `applier-nav.js`). The direction reverses when the apps adopt it. The daemon `PUT /api/behaviors/{id}` mirrors the styles endpoint.

## Update (2026-08-05): DingoNav adopted schemes + behaviours

Nav shipped its schema selector (DingoNav PR #53, design
`DingoNav/docs/plans/2026-08-05-ride-schema-selector-design.md`). This is the first
step-4 adoption:

- **Entry**: the ☰ glove-menu **Schema** tile → a full-screen selector of the preset
  pairs vendored from this repo (`schemes/` + `behaviors/`, SW-precached).
  It has Look and Behaviour rows with the multi-view "⛓ matched" pairing semantic.
  An explicit behaviour pick is mix-and-match.
- **Apply semantics**: reset-then-apply. Nav's settings return to the factory
  defaults, then the preset lands on top. The identity and pairing keys survive.
- **Scheme applier**: `applier-nav.js` was translated into Nav's inline runtime
  (a single-file app, no modules). The basemap overrides splice into `buildStyle()`
  through a dynamic map-style entry (this includes the `__labels` symbol sentinel). The
  overlay tokens land on Nav's ADV knobs (`overlays.breadcrumb` → Nav's
  `colCrumb`). The mark tokens land on the `MARKS` table. The hud tokens land on the shared CSS
  variables. **Day tokens only** — Nav has no day/night schema mode yet, so the
  `night` overlays wait.
- **Behaviour params with Nav homes today**: `camera.followMode/autoZoom/
  easeMs/approachSecs/approachMul/approachFloorM/zoomCurve` (the curve span ends →
  Nav's min/max zoom presets), `offroute.detectM/rejoinM`, `position.
  snapToRoute` (per-vehicle track lock), `position.breadcrumb/breadcrumbSpacingM`, `voice.mode` (silent → sound off). Nav skips the rest
  (`reroute.*`, `pitch`, lane guidance, TTS, the `chrome.*` ui tokens),
  per the ignore-unknown contract. Nav's chrome does not read the ui facet yet.
- **Vendoring direction**: Nav's copy is a *translation*, not a verbatim
  vendor. Thus this repo's `applier-nav.js` stays canonical for the module form.
  `sync-appliers.sh` (added next to this note) pushes the appliers + presets out
  to the sibling checkouts.

## Open questions

- The Google/Waze announcement-distance tiers and reroute thresholds are unverified. A hands-on drive capture is worth the time before we trust those preset numbers.
- The DMD2-Next "Navigation & Routing" / "Settings & Layers" docs were identified but not mined. They would firm up its reroute and voice presets.
- Should `cues.density` modulate shape-derived cue *generation* (the Locus semantics) or mark *filtering* (the Dingo semantics)? Decide when `cueSource: shape` is implemented.
- The speed-dependence of cue distances is modelled as Dingo's `secs × speed clamped [min,max]`. Locus/Google possibly use road-class tiers instead. Revisit this if a preset feels wrong at speed.
