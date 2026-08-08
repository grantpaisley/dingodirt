# Ride UI Overhaul — Design

**Date:** 2026-07-15
**Trigger:** The first major test ride. The functions are ~80% there, but the UI
fails on the small screen. Verdict: the layout concept does not survive contact
with a small screen. Rebuild it from "what do I need while moving" first.

## Context & constraints

- **Screen today:** 720×720 — DingoNav shares the Varg dash with the stock UI.
- **Screen endgame:** 1440×720. When DingoNav shows the telemetry that the
  stock UI shows, the stock half is redundant. DingoNav then takes the full
  dash.
- **Design for 1440×720 as the true form. 720×720 is a degraded mode that we
  must survive.** This inverts the previous assumption that square is
  first-class.
- **Input:** touch-first (gloves, vibration). A bar controller exists on the
  adventure bike. Map it to the same actions as an accelerator. It is never
  the only path.
- Make the touch targets huge (~80–100px min) and few. Put nothing
  destructive adjacent to anything frequent.

## Glance hierarchy (from the ride)

1. **The map** — the terrain and the corners that come next. The map *is* the
   app.
2. **Next turn** — audio first (1 beep = right, 2 beeps = left). The screen is
   the confirmation.
3. **Speed** (adventure bike) / **battery-range** (Stark) — profile-dependent.

Everything else is hidden-until-needed or stopped-only.

## Section 1 — Ride view

The map is full-bleed, edge to edge. Nothing is opaque except the three
interactive elements. All else is a translucent overlay.

**Overlays (glance-only, non-interactive):**

- **The centre stays clear** — the top-centre is where the trail ahead
  renders. Nothing is ever centred.
- **Battery** on one edge: a small graphic + a percentage ("63%"). **Mode** as
  a single digit on the opposite edge (Stark profile). Adventure profile:
  **speed** takes the battery slot.
- At 720×720 the mode digit auto-fades 4s after any change. The battery
  persists. The wide screen keeps both resident.
- **Turn strip** (the existing slim top bar): the text detail — "→ Bathurst
  St" — shows only when a turn is in audio range.
- **Giant turn arrow**: a solid yellow arrow up to ~¼ of the screen, anchored
  on the side of the turn. A right arrow hugs the right edge; a left arrow
  hugs the left edge. It is readable in peripheral vision. **The same symbol,
  flashing = the indicator is on** (from telemetry). One visual vocabulary.
- **The turn countdown borrows the main number slot.** On turn approach, the
  distance-or-seconds to the intersection temporarily replaces the profile's
  primary number (speed on adventure, battery on Stark). This keeps the
  existing setting, which includes freeze-at-last-value when stopped. The
  countdown is styled in turn amber to match the arrow, so you cannot misread
  it as speed/battery. The primary number returns after the turn. Zero new
  resident elements.

**Interactive elements (exactly three):**

1. **The map** — a clean single tap → TURN MODE; tap again → the previous
   zoom. Pinch/drag is disabled above walking speed (manipulation is a
   stopped activity).
2. **The dot** — tap: centre on me · second tap: whole route · hold:
   lock-to-centre. A ring shows the locked state. Any manual drag (stopped)
   breaks the lock.
3. **☰ Menu** — replaces the whole screen with a tile grid (Section 3).

**Camera rules:**

- The auto-zoom on approaching turns stays. But the app obeys any manual
  zoom-out during it immediately and suppresses the re-zoom for that turn.
  Never fight a stuck camera.
- **North-up look-ahead:** with hold-north on, the position dot drifts slowly
  opposite the direction of travel. Heading south → the dot migrates toward
  the top of the screen. The map ahead thus always gets the biggest share of
  the screen. Track-up uses a fixed low-third placement.
- 720→1440: the identical concept. The wide screen spends its extra width on
  map look-ahead, never on a second column of widgets.

## Section 2 — TURN MODE

This is the signature interaction, for unmarked intersections. One clean tap
anywhere on the map does this:

- **Camera:** snap the zoom tight (~z18), rotate compass-up to the heading,
  and centre the rider low-third. The intersection then fills the view ahead.
- **Shown:** the track line(s) through the junction, bolded; the heading
  vector; any existing turn point.
- **One big button: MARK TURN** (bottom, glove-sized).

**Turn-point editing — a one-tap grammar, all inside this view:**

- **MARK TURN** → drops a point at the nearest track position, with an arrow
  for the exit heading.
- **Tap an existing point** → removes it. If it drove an auto-zoom, zoom back
  out ("this turn is obvious, stop telling me").
- **Tap elsewhere after a remove** → the point re-places there (move =
  delete + place).
- Points anchor to **geometry, not track index**. An out-and-back segment
  thus carries the turn point in both passes automatically. Attach the point
  to all tracks that share the segment.

**Exit:** a second tap on the empty map → the previous zoom; or
**self-dismiss** ~50m past the junction. The rider never must tap out
mid-corner.

**Sync:** every add/move/delete queues as a pack contribution. The app pushes
it live to the group riders when connected, and back to the Dingo pack for
everyone's next download.

**General POI marking** (hazard, camp, water, photo) is a stopped activity
via the menu (MARK SPOT). It is distinct from turn points.

## Section 3 — The menu

☰ replaces the entire screen with a grid of fat tiles — no panel-over-map
compromise. The menu borrows the whole screen and gives it back.

- **Grid:** 3×3 at 720×720 (~230px tiles); the same tiles, larger and more
  spaced, at 1440×720.
- Tap a tile → act → close. ☰ again or empty space → close, no action.
  Auto-close after ~8s untouched.
- **Ride tiles:** MUTE (state on the tile) · MARK SPOT · ZOOM presets (pinch
  is disabled while moving) · LAYERS · the secondary number (tap to swap
  which number owns the edge slot) · START/STOP.
- **Idle tiles:** START/STOP, the track/pack picker, the ride profile,
  settings, export, DEMO (see Later).
- **START/STOP is one toggle tile, plain tap, no hold-to-stop ring.** The
  menu is already a deliberate two-tap path, so accidental stops cannot
  happen. Delete the hold-ring code.
- **Two-deep maximum:** a tile acts instantly, or it opens exactly one
  full-screen picker (LAYERS → a grid of layers). Never three levels. Deeper
  tuning belongs to the workshop.

## Section 4 — Telemetry & the wide screen

Telemetry is the real-estate unlock. It is first-class in this overhaul, not
a later phase. The verified WebSocket map already covers: battery, mode,
reverse, crawl, horn, indicators.

- **Battery/range:** a resident edge element (Stark profile).
- **Mode:** a resident single digit on the opposite edge (auto-fades at
  720×720).
- **Mode change → the HP / Regen / TC card** flashes ~4s, then vanishes (the
  existing flash-card pattern, kept). Reverse/crawl: the same event-driven
  brief badge.
- **Indicators:** the flashing giant yellow arrows — no new element.
- Nothing else telemetry-related occupies resident pixels.

**Ride profiles stay minimal:** *Adventure* vs *Stark*. A profile sets which
number is resident, and whether the telemetry tiles appear in the menu. Two
presets, not a settings sprawl.

## Section 5 — The workshop (settings registry)

This keeps the "sister settings app" idea in its healthiest form. The idea
was right about *what*: a database of every tweakable, with exposure flags.
It was wrong about *where*: a separate app that duplicates the UI would
drift and lie. It also would not make DingoNav faster — the settings UI is
inert DOM, not the perf cost.

- **Settings registry:** one table defines every tweakable — track width,
  colours, arrow size, beep counts, zoom presets, fade timings… Each entry
  has a type, a range, a default, and exposure flags: `normal | advanced`
  and `menu | settings | hidden`.
- **The registry generates the settings screens** — no more hand-wired
  controls per setting.
- **Config export/import as a file.** Bench-tune on a desktop browser at
  1440×720 in the same app with live preview. Export, then ingest on the
  bike. This is the sister app's whole value, with zero duplicated code, and
  the preview can never lie.
- The registry flags promote/demote settings between normal/advanced without
  a touch on the UI code.

## Later (noted, not in this build)

- **DEMO mode** — a panel tile that helps users understand the app. It can
  speed up the UI, jump to a particular part of the track, and optionally
  replay scripted panel-buttons that show how everything hangs together,
  narrated by voice, text, or both.
- The group live sync transport (turn points already queue for it).

## Build order (suggested)

1. Ride view rebuild: the full-bleed map, the three elements, the edge
   numbers, the giant arrows, the camera rules (zoom-out respect, north-up
   drift).
2. TURN MODE + the turn-point grammar (local only).
3. Menu grid rework (the START/STOP toggle, the two-deep rule).
4. Telemetry residents + the indicator arrows + the profiles.
5. Turn-point pack sync.
6. The settings registry + generated settings + config export/import.
