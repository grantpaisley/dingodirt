# Corner-scheme controls — same chrome idle and riding (2026-07-19)

This shipped over four PRs: **#14** (the scheme), **#15** (worded strip,
needle, flank arrows, uncased picker), **#16** (cache bump), **#17** (single
progress-bar arrow, header cleanup, beep timing). This doc describes the
FINAL state. The "review rounds" section at the end records what changed
after #14 and why, because some decisions reversed things that #14
introduced.

## Why

The idle screen used to show control clusters that vanished during
navigation ("riding: exactly three interactive elements"). The ride controls
were buried in the ☰ grid. Riding and planning now share ONE button layout —
what you learn on the driveway is exactly what you use at speed. The layout
also finally makes landscape different from portrait/square (the two blessed
viewports are 1440×720 and 720×720; before, nothing made them different).

## The scheme (all orientations, idle = riding)

- **N** (`#orientCtl`) top-left — the north / course / compass cycle. It
  carries a red needle (`#orientNeedle`) that counter-rotates with the map
  bearing. Thus the needle always points true north (straight up in north-up
  mode).
- **box** (`#boxBtn`) top-right — frame the whole track.
- **Base row** (`#baseRow`) along the bottom: **☰** (`#menuBtn`) · **−** ·
  **+** · **dot** (`#dotBtn`, centre on me, wears the lock ring).
  - Portrait / square (`body.portrait`, from `loOrient()`): the four buttons
    butt up edge-to-edge, each exactly ¼ of the screen width.
  - Landscape: normal-size buttons; ☰/dot pin to the corners, and − / + sit
    together bottom-centre.
  - ☰ stays at full opacity while riding (everything else dims to
    `--navOp`) — a visibility fix that fades is no fix.
- **− / +**: a tap = a step zoom. **Hold + to save the turn zoom. Hold − to
  save the riding zoom.** The auto-zoom flips between the two saved levels.
  The old min/max preset buttons and jump-taps are gone.
- **START** (`#startBtn`) floats above the dot when you are stopped. To
  stop, use the ☰ Demo tile (it flips to a red **Stop ride** mid-ride —
  two-tap mis-tap protection).
- **FORWARD / REVERSE** (`#revToggle`) sits above ☰ — START's twin, amber
  when reversed, on the stopped screen only. It replaces the old `#revBtn`
  in settings.
- The riding readouts sit **below** their corner buttons: the speed under N
  (left), the Varg mode digit under the box (right). The turn strip insets
  between the corners (`#hud{left:106px; right:106px}`, rounded bottom
  corners).
- Everything bottom-anchored stacks off **`--chromeB`** (the idle bar height
  + the progress-strip height, published by `placeProgress()`). Thus, when
  the countdown strip grows, it lifts the whole row.
- Turn mode hides − / + (ADD MARK owns the bottom centre); ☰/dot stay.

## Turn strip — words, no glyph

The direction word sits over the road name, with the distance on the right:
**"Right"** (amber) above **"Arcadia Rd"** (grey), `145 m` on the right.
There is no arrow glyph and no draining amber fill — the distance number and
the countdown bar already carry the proximity. When a cue has no road name,
the strip falls back to the surface word ("dirt"). Danger / gate / creek
cues show their words in their own colours.

**Tap = toggle**: the strip grows to the full instruction ("Right on to
Arcadia Rd") in large writing. Tap again to shrink it. The old 4-second
auto-collapse is gone.

## Turn arrows — one, in the progress bar

The giant translucent mid-map arrows are **deleted**. A single solid amber
arrow lives inside the progress bar, vertically centred, on the side of the
turn — a left arrow at the left end for a left turn, a right arrow at the
right for a right turn, **never both**. It is 54 px, and it grows to 64 px
while the countdown bar is up.

These same arrows are the **Varg indicator telltales**: they flash
(`.blink`) when a blinker is live, which outranks a solid turn cue.
`applyCdArrows()` owns both roles. `updateBigArrows` and the giant-arrow
tuning knobs (fill / opacity / surround) are gone.

## Audio grammar (unchanged meaning, fixed timing)

**One tone = right · two = left · three = danger** (the boat convention).
The count was always correct. #17 fixed the *timing*: two identical 460 Hz
tones 200 ms long, with only 100 ms between them, fused into one long beep
through a helmet:

- **Left** = two SHORT pips (140 ms approach / 120 ms turn) with **220 ms of
  silence** between them — more gap than pip.
- **Right** = one LONGER tone (260 / 220 ms). Thus the duration reinforces
  the count.

If two pips still read as one on the bike, the next lever is a different
pitch for the second left pip — a pitch step survives wind noise better than
a gap.

## Glove grid

One unified 3×3 grid — the same tiles idle and riding: Demo(↔Stop) · map
type · Mute · Tracks · ride type · Auto zoom · Mark spot · Track colour ·
Settings. The `data-m` ride/idle split, `gStartStop`, `gOrient`, and the
zoom-preset tiles are gone. An explicit ☰ close button (`#gloveClose`) sits
bottom-left inside the overlay — the same spot as the ☰ that opened it.
Thus one location toggles both ways (a tap on empty space still closes it
too).

## The map is the track picker

Nothing is pre-selected at boot or after you load files: every GPX draws in
**uncased route blue** at full strength, and `fitSelected()` frames them
all. Tap a track line (~24 px radius, floor 20 m) to select it. It gains the
black/white **casing**, which is the selection signal. Tap the selected line
again to deselect back to the all-tracks view. Non-selected tracks dim only
slightly (0.65), because the casing already arbitrates. Map-tap selection
works on the stopped screen only; a share-link pack ingest still
auto-selects the pack default.

## Track colour (dash patterns retired)

The route is one solid cased line. The casing stays auto dark-on-day /
white-on-night. `S.set.trackColour`: **none** (route blue) / **slope**
(interior brightness by grade, from the smoothed profile; disabled without
elevation) / **surface** (sealed blue · dirt amber · singletrack purple —
this replaces the dash patterns and the `surf` toggle). The interior colour
is baked per feature (`c`), with a dimmed travelled variant (`cd`). Thus
slope/surface still read behind you. The per-surface layer triplets
collapsed to per-state layers
(`surf-core/-case/-done/-done-case/-miss/-recent`).

## Progress strip

The centre label shows the **distance to the next cue** (`→ 240 m` /
`→ 18.1 km`, from `ns.cdD`). It hides while you are off-track, so it cannot
lie. The strip is windowed to the map. Thus, at rider zoom, the next turn is
usually off its right edge — this is the number that matters. The
done/remaining labels flank it as before.

## Settings

A full-screen panel, closed by a **← back arrow top-left** (`#panelClose`) —
no hamburgers on the settings screen. `showAdv` gates the Stark, Keys, and
**UI** tabs together. UI (renamed from Adv) holds the ui rows, the
screen-layout editor, a new **Swap main number** toggle, and the tuning
knobs. `ctlEdges` ("Control buttons on") and `gloveSide` are removed.

## Demo pacing — highlight reel

The plain demo no longer plays at a flat 10×. It sprints each gap at a
**constant per-gap velocity**, so the next audible cue is ~3 s away (capped
just under `progContM`, so travelled spans stay continuous). It drops to
ride pace 250 m out. Thus the auto-zoom dive, the countdown, and the beeps
play in real time (~3 s). It carries 40 m past the turn, then sprints again.
Cue-less tracks fast-forward at the cap. Training keeps its real-time 1 Hz
pacing.

> An implementation note: compute the sprint velocity **once per gap**, not
> per tick. A per-tick `(gap - APPR_M) / TICKS` fraction decays
> asymptotically and never arrives — that bug shipped in the first draft. A
> position sample every second caught it.

## Migration (`_v5`)

It deletes `surf`/`ctlEdges`/`gloveSide` and the dash adv knobs. It seeds
`trackColour:'none'`. It prunes the removed ids from saved layouts and
remaps a saved `followBtn` slot to `dotBtn`.

> The dead-key deletes run **unconditionally**, not inside the `_v5` flag
> check. A cache-first SW means an old app version can re-seed those keys
> from its own defaults after the flag is already stamped.

## Demo (training ride)

The training cards are re-targeted: the box lesson (`ev:'fit'`), the dot
lesson, the − / + hold-to-save lesson (`trainEvent('preset')` moved into
`presetSet`), a new N-cycle card. The glove copy lists the new tiles.
`#trainCard` anchors off `--chromeB`. The position words in the copy track
the #15 swap (box "top right", ☰ "bottom left").

## Review rounds — what changed after #14, and why

| # | Change | Reason |
|---|---|---|
| 15 | ☰ and box swapped (☰ into the base row bottom-left) | ☰ is the most-used control; the base row is the thumb zone |
| 15 | Settings closes via ← top-left, not a hamburger | Two hamburgers on one screen read as two menus |
| 15 | An on-map FORWARD/REVERSE toggle | To reverse a ride was buried in settings |
| 15 | The compass needle on the N button | The mode glyph alone did not show which way north was |
| 15 | Tracks are uncased until selected; the others dim only to 0.65 | The dim hid the tracks that you tried to choose between |
| 17 | The giant map arrows deleted; the progress-bar arrow takes both roles | The translucent arrow covered the map below it |
| 17 | One arrow on the matching side, not both flanks | Two arrows do not say "left" |
| 17 | The header fill bar deleted | Redundant with the distance number and the countdown bar |
| 17 | The beep pips shortened, the gap widened | Two same-pitch tones 100 ms apart fuse under a helmet |

## Verification status

We verified this in the preview browser at 1440×720 and 720×720 only.
Everything physical is **still unvalidated on the bike**: the beep timing
through a helmet, gloved taps on the ¼-width base row, the 600 ms
hold-to-save, the arrow glanceability in peripheral vision, and the compass
needle under real magnetometer jitter.
