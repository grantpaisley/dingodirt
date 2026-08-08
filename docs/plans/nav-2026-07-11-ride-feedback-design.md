# Ride-feedback design — 2026-07-11

This design comes from field feedback (a road + MTB singletrack ride, phone at
half screen). The core complaint: **way too many beeps**. The core insight: a
beep must mean *"the obvious move here is wrong"*. Warn when the route leaves
the way that you would naturally continue on.

Build order: §1 cue engine → §2 zoom → §3 riding screen → §4 cue editing → §5 map styles.

---

## 1. Cue engine — beep only when the obvious move is wrong

Drop the two noisy triggers:

- **Geometry fallback** (the `TURN_LONE` beep on sharp bends over unmapped
  ground) — gone. This is most of the singletrack noise: a twisty trail ≠
  decisions.
- **Standalone heatmap-junction cues** — gone as their own beep type. The
  heatmap grid stays as *evidence* for the decision test below.

A cue now fires only where **all three** conditions hold *(revised after the
round-1 field test: hairpin cues and straight-ahead cues are gone — see
below)*:

1. **Way transition** — the smoothed way-class/name under the track changes
   (road→track, named→named, track→path, mapped→unmapped).
2. **The departed way continues** — the engine samples the basemap grid
   around the transition. The way that you were on (matched by name, else by
   class) carries on somewhere the route does not. This keeps shire-boundary
   renames and flow-through trail joins silent (no decision = no beep).
3. **It is an actual turn** — the peak bearing change is ≥ `TURN_MIN` around
   the transition. To go straight ahead needs no warning, even onto another
   way.

Revisions from the round-1 field test (2026-07-11, built as cue4):

- **No hairpin cues** — you can see a hairpin on the map. Also, recorded
  obstacle-retry loops (ride circles to get up or around an obstacle) fake
  them.
- **No straight-ahead cues** — this supersedes the original "straight onto a
  minor way while the main road bends off" case. Only real turns cue.
- **No way data at all** within ~40 m → silent (do not guess). The engine
  still catches a genuinely unmapped route past a *mapped* alternative: test
  2 keys off the alternative.
- **Look-through** — a way-match dropout (<300 m, the same way on both
  sides) is not a departure + rejoin.

**Turn-confirmation chirp**: after you pass a cue and stay on-track for
~40 m / a few seconds, the app plays the existing back-on-track chirp once.
The settings toggle is "Turn confirmation", default **on**. It answers "did
I take the right fork?". The off-track buzz logic is unchanged.

**Per-mode tuning**: the thresholds and lead times live per vehicle mode
(walk/mtb/enduro/adv). Enduro and ADV thus converge on their own numbers.

Bump the cue-cache version, so all tracks re-analyse under the new rules.

## 2. Zoom — vehicle presets, heart favourite, manual hold, centre lock

Speed→screen-span curves per vehicle preset. Span = the metres of visible
map height. The numbers are starting points — tune them in demo mode + on
rides:

| Preset | stopped | mid | fast |
|---|---|---|---|
| Walk   | 150 m | 250 m @ 5 km/h  | 400 m @ 8 km/h    |
| MTB    | 250 m | 500 m @ 15 km/h | 900 m @ 35 km/h   |
| Enduro | 300 m | 900 m @ 30 km/h | 2.5 km @ 70 km/h  |
| ADV    | 400 m | 2 km @ 50 km/h  | 7 km @ 100 km/h   |

One "vehicle" setting drives the beep lead-times, the zoom curve, the
per-mode cue tuning, and the per-mode heart zoom. Walk gets a lead-time row
too (short leads, low speeds).

- **Manual hold**: any manual zoom (pinch / ± / controller) while auto-zoom
  is on switches to *hold*. The zoom stays put and ignores the speed. When
  the next cue's far-warning window approaches (~15 s out), auto-zoom
  re-engages smoothly. A "⤢ held" pill shows while the hold is on; tap it to
  release early.
- **Heart favourite**: after a ± nudge, a heart fades in next to the
  buttons. Tap it → the app saves the current zoom as the favourite (per
  vehicle mode; the heart fills). The favourite replaces the speed curve as
  the cruise zoom: auto-zoom still pulls in to frame each turn, then returns
  to the heart zoom. Tap the filled heart to clear it → back to the pure
  speed curve. No heart = the plain hold behaviour above.
- **Centre lock**: a long-press on the map toggles a lock. Locked = pinned
  centred, and the app ignores pans/drags (glove-brush protection at
  speed). A long-press unlocks for free browsing. While unlocked + panned
  away, a long-press snaps back to centre and re-locks in one gesture. A
  small padlock indicator shows the state.
- **Controller (DMD2 etc.)**: it pairs as a Bluetooth HID keyboard → listen
  for `keydown`. Defaults: `+`/`-`, arrow up/down, media next/prev = zoom.
  A settings row captures any keycode ("press your controller button…").
  Mappable actions: zoom in/out, mute, re-centre, north/course toggle, map
  style flip.

## 3. Riding screen — marker, HUD, controls, fullscreen

- **Arrow marker**: replace the dot with a navigation dart/chevron, rotated
  to the smoothed course bearing (held when stopped, as course-up does now).
  The accuracy halo stays underneath.
- **Turn HUD**: replace the centre-screen arrow overlay with one slim
  semi-transparent top strip: the turn arrow + "onto <way name>" on the
  left, the live distance on the right. The strip fill drains left→right
  toward the turn point. Course-up: the arrow shows the turn direction.
  North-up: the arrow rotates to the turn's actual bearing.
- **On-screen controls** (~35% opacity until touched): `+`/`−` stacked on
  the glove-side edge (obeys the glove-side setting), the heart under the ±
  pair, and the mute toggle in the top corner (a slash icon when muted, one
  tap, no menu). Fit / re-centre / glove overlay stay as-is.
- **Fullscreen**: a menu ⛶ entry via the Fullscreen API. Auto-request on
  START, release on STOP. iOS Safari lacks the API → show an "Add to Home
  Screen for fullscreen" hint there. The installed PWA is already
  standalone.
- **North-up discoverability**: make the existing N-button state more
  obvious. It already toggles north-up/course-up, but the rider did not
  find it on the ride.

## 4. Planning — editable turns

Select a track (not navigating) → a "✎ Cues" button next to START enters
edit mode. The cue dots grow tappable, and the route highlights.

- **Remove**: tap a cue dot → it greys out (a soft-delete; it never beeps
  and is hidden from the HUD). Tap it again to restore it.
- **Add**: tap the route line → the app creates a cue at the nearest track
  point. It computes the direction/angle and the "onto" name from the local
  geometry + the way grid. Long-press a dot to cycle turn → hairpin →
  delete.
- **Done** exits, with the toast "n cues (m edited)".

**Persistence**: the app stores the edits as an *overlay* (removals +
additions, keyed by distance-along-track), separate from the analyser
cache. A re-analysis re-runs the algorithm, then re-applies the overlay.
Hand edits thus survive algorithm upgrades. The overlay lives in IndexedDB
and travels with exported/shared bundles (group rides share the curated
cues).

**Tuning loop**: the hand-deleted cues are the classifier's false
positives. Menu → copy diagnostics exports the overlays. Use them to
tighten the per-mode thresholds against real rides.

## 5. Map styles + route surface rendering

Three presets = one base `layers.json` + small colour/width override tables
(not forked files). The same pmtiles, an instant switch, no extra storage.
The picker is in settings (thumbnail swatches). You can map it to a
controller button for day/night flips.

1. **Dark** — the current look, for night.
2. **Daylight** *(the new default)* — light warm ground, dark road casings,
   a green forest tint, strong water. Readable in full sun.
3. **High-contrast trail** — pale ground, loud track/path colours (tracks
   orange, paths magenta-dashed), beefed-up widths.

The overlay colours (heatmap, selected track, position arrow) get
per-style variants — the neon-on-dark palette disappears on light ground.

**Route surface styling**: the route line encodes the surface from the cue
analyser's way-class array (`m.cls` — already sampled under the whole
route, no new data):

- solid = sealed (road classes)
- long dashes = dirt / fire trail (track class)
- short dots = singletrack (path class)
- unmapped stretches = dashed (dirt is the safe guess)

A continuous faint casing renders underneath the patterned line. The route
thus never visually breaks against busy terrain. The pattern reads as
texture on top.

## Settings after all this (⊕ new)

vehicle mode walk ⊕ /mtb/enduro/adv (drives the beep lead-times, the zoom
curve, the per-mode cue tuning, the per-mode heart zoom) · sound on/off ·
⊕turn confirmation chirp · auto-zoom on/off · ⊕map style picker ·
⊕controller key mapping · glove side · orientation north/course · group
ride name/code.
