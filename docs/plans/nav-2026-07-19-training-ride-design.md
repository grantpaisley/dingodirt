# Training ride — interactive in-app tutorial

*2026-07-19. Realizes the "DEMO mode" Later item from
[2026-07-15-ride-ui-overhaul-design.md](2026-07-15-ride-ui-overhaul-design.md).*

## Purpose

New riders (mates who receive a shared pack) learn DingoNav by *doing*. A
simulated ride pauses at teaching moments and asks for the real gesture —
a double-tap, a drag, the dot, the ☰ tiles. The ride advances only when the learner does the gesture.
The ride uses text cards + the real beeps. There is no TTS and no video file. The ride works with nothing loaded.

## Decisions (validated)

- **An in-app interactive training ride**, which extends demo mode. Not an MP4.
- **Text callout cards + real BEEP cues.** No spoken narration.
- **Do the action to advance.** Passive phenomena (beeps, banners) are
  watch-then-ack. Gesture steps have a "Can't do this here — skip" link.
- **Launch:** when you start a demo (☰ `#gDemo` or settings `#demoBtn`), a
  chooser opens — *Training ride* vs *Plain demo*. The empty home screen also gets a **"Try the training ride"
  button** (`refreshEmpty`). There is no new glove tile.
- **The training route ships as an inline constant, not a `.dingonav`.** The real
  ingest path purges the loaded packs (`purgeAllPacks`), clobbers the `basemap`
  IDB singleton, and wants a reload. That risk is unacceptable for a tutorial.
  The inline route (~3.5 km, ~220 pts + pre-baked cues, ~10-12 KB in index.html)
  sits inside the auto-downloaded Central Coast basemap. Thus new users get real
  imagery. The route stays fully functional on the dark fallback. The route never touches IDB,
  never shows in the track lists, and is removed on exit. `make_bundle.py` does not change.
- **Setup & packs = 3 pre-ride cards** before the sim starts. Then the ride is one
  continuous ride.
- **No perf cost:** all the training code is inert unless `TRAIN.active`.

## Architecture

### Engine (new section beside demo mode, ~line 3636)

- `TRAIN` state: `{active, i, holdD, offT, prevSel, prevSound}`.
- `TRAIN_STEPS`: one hardcoded array. The step shape is
  `{at, ride, title, html, target, advance: {ev|ack}, before(), after()}`.
  `at` = the sim distance trigger (`-1` = a pre-ride card, `null` = chained
  immediately after the previous step). `ride:true` = a card without a pause
  (an off-track act).
- **Pause semantics:** the demo `setInterval` never stops. Paused = hold `d`
  at `TRAIN.holdD` and feed the same fix with `speed = 0`. The app genuinely
  reads "stopped". Thus `applyMoveGestures` re-enables pinch (the real
  stop-and-manipulate grammar). The `avgSpd` EMA does not change (the spd>1 guard). The warn
  distances do not decay.
- **Event taps:** append a one-line `trainEvent('x')` to 11 existing
  handlers: `enterTurnMode`/`exitTurnMode`, `dragstart`, `zoomend` (gesture),
  dot-recentre, `setLock`, `presetTap`, `setSound`, `openGlove`,
  `northBtn`, and the off-track/back-on transitions in `onFix`. There is no wrapping.
- **Off-track act:** `TRAIN.offT` ticks displace the fix about 90 m perpendicular
  to the local heading (past `offM` 60). Thus the real banner + `BEEP.off` fire.
  The expiry returns the fix inside `onM` 40 → the real `BEEP.back` → advance.
- Orchestration: `startTraining` / `trainCheck(d)` / `trainShow` /
  `trainAdvance` / `endTraining(finished)`. The dev hook is `window.__trainGoto(n)`.
- `stopDemo` calls `endTraining(false)` if the training is active. Thus every exit path
  (✕, ☰ Stop, the demo toggle, the track end) funnels through the cleanup.

### Guards (one line each)

- `friendPub`: never broadcast sim positions during training.
- `gloveArm`: no 8 s auto-close while a card targets a glove tile.
- `refreshTrackList`: skip `t._training`.
- `startTraining` pre-seeds `S.set.seenZoomTip` (this kills the `zoomTipGate` collision).
- `endTraining`: restore the sound if the learner abandons the mute lesson. Set `S.trail = []`
  before `stopNav` (this defeats `archiveRide`). Remove the `__training` track and
  restore the previous selection. The mark lesson is describe-only (no real
  `markSpot` — a real call would queue live turn edits).

### Card UI

`#trainCard` is fixed at the bottom-centre, `min(70vw, 400px)`, z-index 27 (above the
glove overlay's 25, so cards that target a tile stay readable). It uses the `#dlg`
palette again. The top row shows "lesson n/14" + "✕ end training". The buttons are "Got it" (ack
steps) and the skip link (ev steps). **There is no backdrop shade** — the map must stay
touchable for the gesture lessons. The spotlight = the `.trainSpot` class on the target:
an accent box-shadow + a 1.2 s pulse. The card must clear `#dotBtn`, `#menuBtn`,
`#progress`, and the big arrows, at both 1440×720 and 720×720.

### Training route

- `TRAIN_PTS` (110 `[lat,lon]`, 5 dp) — a real 4.0 km path with 10 junction
  turns + 1 danger mark. The path uses OSM-derived fire trails in Ourimbah State Forest
  (Middle Ridge Rd / Tank Point Rd / Joes Point Rd), inside the
  `central-coast.pmtiles` coverage.
- `TRAIN_CUES` — baked cues, authored through the dev-console path
  (`window.__cue.cues` after you load the same points as GPX), plus one
  hand-added danger mark. With baked cues, `startNav` skips `analyzeRoute`
  fully. The nav logic needs no tiles.
- `buildTrainingTrack()`: `processTrack('__training', …)`, then set
  `_training`, `baseCues`, `applyCueOverlay`. In-memory only.
- The REF projection skew for users anchored far from NSW is cosmetic
  (HUD metre readouts only). The sim is self-consistent. Put a comment in the code.

## Lesson sequence (14 top-level steps)

The warn maths at 8.5 m/s enduro: approach ≈ 127 m out, turn-now ≈ 42 m,
countdown strip 300 m, danger barks at 200/50 m.

1. *Pre-ride* — welcome; navigation is beeps-first; turn the sound up. (ack)
2. *Pre-ride* — packs: one `.dingonav` from Dingo = tracks + offline maps;
   the re-download lives on the home screen. (ack)
3. *Pre-ride* — the beep grammar: **1 = right, 2 = left; deep = coming up,
   high = turn now**; `before()` plays samples. (ack)
4. `at:60` — a screen tour: the HUD strip, the progress bar, the speed. (ack)
5. `T1−170` — listen to a real approach→turn cue + the giant arrow. (ack, passive)
6. `T1+70` — the rising two-note done-chime. (ack)
7. `T1+250` — drag to look around (always live). (ev drag)
8. chained — tap the dot to snap back. (ev recentre)
9. chained — you are "stopped": pinch/wheel zoom works. Above walking speed,
   finger-zoom locks; ± always works. (ev zoom-gesture + skip)
10. chained — tap ☰: the whole screen becomes glove tiles. (ev glove)
11. chained — Mute, then un-mute (danger still barks). (ev unmute)
12. chained — the Zoom close / Zoom wide presets; hold-to-set. (ev preset + skip)
13. `T2−40` — **double-tap = TURN MODE** at a real fork. A chained card
    describes ADD MARK. Double-tap again to exit. (ev turnmode →
    turnmode-exit)
14. `T2+200` — a scripted off-track: the growl + the red banner, then the return chirp. Note the
    reverse-direction auto-flip. Then the centre-lock long-press (ev lock +
    skip), the danger barks (ack, passive), and the finish card → `endTraining(true)`.

## Build order

1. The engine core: the state, the `trainEvent` taps, the pause/feed/offset in `startDemo`,
   the orchestration, `__trainGoto`. Check it with 3 placeholder steps.
2. The card UI + the spotlight, at both viewports.
3. The route + cues: author the loop, bake `TRAIN_PTS`/`TRAIN_CUES`, set the `at:` values.
4. The launch flow (the `#demoPick` chooser, the `#gDemo`/`#demoBtn` rewire, the empty-state
   button) + the guards.
5. The content pass: the full card text.
6. Verification; bump `sw.js` CACHE v22 → v23.

## Verification (desktop, `node serve.js` :8138)

- Use a fresh profile (clear IDB + localStorage), at both viewports: empty state →
  training via the home button and via ☰ → Demo → the chooser. Do every step
  with real mouse gestures (dblclick, drag, click, a 600 ms hold, wheel).
  The pinch step exercises the skip link.
- During pauses: the speed reads 0, the HUD is frozen, and wheel zoom works. On resume,
  the beeps fire. The off-track step shows and clears `#banner`.
- Exit mid-lesson via ✕: the sound is restored, no `__training` is in the tracks, the previous
  selection is restored, no ride is archived, and a reload → an identical track list.
- Plain-demo regression: the behaviour does not change, including the Stark sim ticks.
- The card geometry at 720×720: the card clears the dot/☰/progress/arrows. The card is readable
  above the open glove overlay.
