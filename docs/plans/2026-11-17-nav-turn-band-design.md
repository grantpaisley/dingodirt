# Nav ride screen — two bars and one turn cell

*Design, 2026-11-17, revised 2026-11-18. Brainstormed and validated with
Grant, with a mockup for each visual choice (portrait, landscape and half
phone). Replaces the turn-strip and turn-countdown parts of
`nav-2026-07-15-ride-ui-overhaul-design.md` (Section 1, "Turn strip",
"Giant turn arrow", "The turn countdown borrows the main number slot") and
section 6 of `nav-2026-07-13-nav-ui-enhancements-design.md` ("Countdown
bar"). The first version of this document put the turn in a band at the
bottom; Grant replaced that with the top bar below.*

## Why

On a turn approach Nav shows the next turn in three places:

| Element | Position | Content |
|---|---|---|
| Turn strip (`#hudBox`) | Top centre | The word "Right", the road name, the distance |
| Countdown strip (`#progress.countdown`) | Bottom | A bar that burns down, the distance, an amber arrow on the turn side |
| Large left number (`#hudSpeed.cd`) | Top left | Changes from speed to the distance, in amber |

The distance shows three times. The direction shows two times. The rider
must look from the top of the screen to the bottom for the full message,
and loses the speed number at the moment of braking for the turn. The
controls around these elements are loose buttons with different shapes.

## Decision summary

| Question | Decision |
|---|---|
| Turn elements | **One:** the middle cell of the top bar |
| Top of the screen | **Top bar:** one long frame — a square at the left (north / compass), the turn cell, a square at the right (whole track) |
| Bottom of the screen | **Bottom bar:** one long frame, always four equal cells — ☰, −, +, centre on me |
| When stopped | **START bar** above the bottom bar: direction cell and START cell |
| Ride progress | **A thin line** at the very base. No text, no tap |
| Elevation profile | A **Profile** tile in the ☰ menu. The profile opens above the bottom bar |
| Track name when stopped | In the **turn cell** |
| Cue-edit pen | An **Edit cues** tile in the ☰ menu, shown when stopped |
| Mute | The ☰ **Mute** tile only. The loose mute button goes |
| Large left number | Stays as speed (or battery). No countdown in it |
| Turn cell look | **Transparent**, road name only, metres or seconds (the "Countdown units" setting that exists) |
| Turn image | **A manoeuvre image from the turn angle**: slight, normal, sharp, U-turn |
| No turn near | The next turn in **pale text**. No fill. Dull image |

Options that were not selected: a turn band at the bottom (the first
version of this design); one card at the top over the map; one large arrow
on the turn side; START and direction as two loose buttons; a tap on the
progress line; the track name in its own bar.

## 1. Layout

The same three frames in each layout: portrait, half phone (split screen,
which takes the portrait layout) and landscape. In landscape the bars go
the full width of the screen.

**Frame look.** A thin border in the scheme text colour, cells divided by
thinner lines, a light dark wash behind (as in the mockups). The cells are
the same height as the glove buttons today.

| Frame | Cells | Shows |
|---|---|---|
| Top bar | North / compass · turn cell · whole track | Always, idle and riding |
| START bar | Direction · START | Only when stopped. The direction cell shows only when a track is selected; with no track, START fills the bar and starts a free ride |
| Bottom bar | ☰ · − · + · centre on me | Always |
| Progress line | — | Riding with a track. 4 px, ridden part in the accent colour |

**Below the top bar.** The large number (speed or battery), the Varg pill
and the orientation label move down so they do not touch the top bar. In
landscape the speed is at the right and the battery at the left.

**Short screens** (`max-height: 500px`). The turn cell uses one line:
image, number, road name.

**Profile.** The Profile tile switches the elevation profile on and off
(`S.set.profile`, as the progress tap does today). When on, it opens above
the bottom bar in the same frame look. A track with no elevation data
gives the toast that exists today.

## 2. The turn cell

**Stopped.** The track name and its second line ("142 km · start 1.2 km"),
as the bottom info bar shows them today. A tap opens the track picker, as a
tap on that bar does today. With no track: "No track selected".

**Riding, no turn near.** The next turn in pale text: image in a dull
amber, distance, road name. No fill.

**Riding, turn near** — from the "Countdown from" distance (`cdDist`, 300 m
as standard) to the turn, the timing of `ns.cdOn` today:

| Part | Content |
|---|---|
| Image | The manoeuvre image in the turn-arrow colour, on the side of the turn. A straight or a hazard cue shows its image at the left |
| Number | Distance (rounded to 5 m) or seconds. Seconds stop at the last value when the rider stops, as today |
| Text | The road name. With no name: the surface the turn goes on to ("on to dirt"). For a hazard cue: its word ("Gate", "Creek crossing") |
| Burn-down | A clear fill behind the cell content that gets smaller toward the turn. Accent colour, then warning amber inside the near distance, as today |

No tap during a ride. The number and the text are white with a dark
outline, so that they read on a light map and on a dark map.

**Unchanged.** The sounds (approach tone, turn tone, departure chime).

## 3. Manoeuvre images

Each turn cue already stores its signed turn angle (`deg`). No new data.

| Image | Turn angle |
|---|---|
| Slight left / right | Under 40° |
| Left / right | 40° to 110° |
| Sharp left / right | Over 110°, to 155° |
| U-turn left / right | Over 155° |
| Straight | A junction cue of type `straight` |

Hazard cues keep their own icons: danger and obstacle in the danger
colour, gate and creek in the turn-arrow colour.

**Source.** The Nav icon set (Lucide) has no sharp-turn and no U-turn
image. As built, Nav draws its own five symbols (straight, slight, turn,
sharp, U-turn) in the Lucide 24-unit style, so no second icon set and no
second licence come in. They are right-handed; a left turn shows the same
symbol mirrored.

**Not included:** roundabout and fork images (Nav does not detect those),
and a "then" image for a second turn that follows closely.

## 4. Special cases

| Case | Behaviour |
|---|---|
| Riding the track in reverse | Nav already swaps left and right. The image follows the same swap |
| Off track | The turn cell shows the pale state and the "OFF TRACK" banner shows, as today |
| Bike indicators (Stark Varg) | The flashing telltale stays. Indicator on the side of the turn: the turn image flashes. Other side: the plain arrow flashes there |
| Turn complete | A green edge on the turn cell, with the same chime |
| Schemes | `hud.arrow` and `hud.arrowOp` for the image, `hud.accent` and `hud.warn` for the burn-down, `hud.text` for the frames. The fixed colours in the canvas drawing code go away |
| Layout editor | The two bars are fixed. The editor moves and sizes the readouts only (speed, Varg pill, mode digit, telltales); the bar buttons no longer move or dock into the ☰ grid. Saved slots for those buttons are ignored. The reserve zones follow the bar heights |
| Training ride | The lesson steps that point at `#hudBox` ("Top strip: the next turn") and at the loose buttons change to the turn cell and the bars |

There is no setting to get the old layout back.

## 5. Build

| Part | Change |
|---|---|
| Top bar | New markup. `#orientCtl` and `#boxBtn` become its end cells; `#north` goes if it only duplicates `#orientCtl` |
| Turn cell | Page elements (fill, number, text, image) in place of `#hudBox` and the canvas drawing in `drawCountdown`. Scheme colours apply through CSS variables |
| Bottom bar | `#baseRow` becomes the framed four-cell bar in each layout. START leaves it |
| START bar | `#revToggle` and `#startBtn` move into one framed bar, shown when stopped |
| Progress line | `#progress` becomes the 4 px line; `#progLabels` and the progress tap go. The expanded profile keeps its canvas, placed above the bottom bar |
| ☰ menu | New tiles: Profile, Edit cues (stopped only) |
| Removed | `#hud` markup and styles, the strip tap, the canvas countdown (`drawCountdown`), the amber countdown in `#hudSpeed`, `#bottom` (its text moves into the turn cell), the old progress labels (km done, km to go, time) |
| Kept hidden | `#muteBtn` was already hidden by CSS before this change; its markup stays because the keyboard M binding calls it |
| Image choice | One pure function: cue type + turn angle + riding direction → image name and side. Its own file, `apps/nav/manoeuvre.js`, in the pattern of `corridor.js` and `tracklock.js` |
| Symbols | Four new symbols in the inline sprite |
| Offline cache | `manoeuvre.js` joins the service worker shell list. The cache version goes above the version on `main` |

`setHud` also sets `S._turnCue`, which the indicator arrows read
(`applyCdArrows`). The build keeps one small function that derives the cue
state for the turn cell and for the telltales.

## 6. Tests

1. `apps/nav/tests/manoeuvre.test.mjs`: each angle limit (39°, 40°, 110°,
   111°, 155°, 156°), left and right, reverse riding, straight, each hazard
   type.
2. `tools/ui-sweep`: the states that measured the top strip and the loose
   buttons change to the bars, the START bar and the new ☰ tiles. The turn
   cell text is over the map wash; the outline text is checked by eye.
3. A browser run on the dev server with the Demo ride, with pictures as
   proof: each of the four turn images and a hazard cue; metres and seconds;
   stopped, no turn near, turn near; portrait, half phone and landscape; a
   short screen; a light map and a dark map; each scheme; Profile on.

## 7. As built (2026-11-18)

- The turn cell puts the image and the number on line 1 and the road name
  on line 2, across the full cell width. In the first browser run the road
  name was cut ("Middle …") when it shared line 1 with them.
- The burn-down fill shrinks toward the side of the turn image.
- With Edit cues on, the turn cell's second line reads "Editing cues · ☰ →
  Edit cues to finish".
- The ☰ grid takes a fourth row when ten tiles show (stopped, with a track).
- The Profile setting is in `S.set` as before, so a schema change still
  resets it.
- Verified in the browser (dev server, training ride and plain demo):
  portrait 375×812, landscape 844×390, half phone 400×430, tablet
  1280×800; each turn image, straight, reverse, danger and creek; pale,
  countdown and near states; factory day look and DMD2; Profile on; Edit
  cues on and off; a tap on the turn cell opens the track picker.
- `node --test apps/nav/tests` (39 pass, 7 new) and the contrast sweep
  (8 of 8 pass, enforcing).

## 8. Map credit and cell dividers (2026-11-18, mockups)

- MapLibre's attribution pill is gone. The credit is plain 11 px text in the
  lower-right corner, just above the bottom stack: "OpenStreetMap ·
  Protomaps ©" (built from the attribution of every source in the style, so
  Aerial adds its own). It is open at start; 5 s after the map loads, or at
  the first map touch (drag, pinch, tap), the text rolls into the ©. The ©
  never moves; a tap rolls the text out to its left again. This follows the
  OSMF attribution guidelines (2021): a menu-only credit is not allowed, a
  collapse after 5 s or on map interaction is.
- Every pair of bar cells has a light divider, on at all times (also between
  + and the hidden dot).

## 9. Delivery

One branch, `feat/nav-turn-band`, one pull request, the usual sequence
(branch, verify in the browser, PR, green CI, squash merge).
