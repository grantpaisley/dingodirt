# Nav turn band — one element for the next turn

*Design, 2026-11-17. Brainstormed and validated section by section with
Grant, with mockups for each visual choice. Replaces the turn-strip and
turn-countdown parts of `nav-2026-07-15-ride-ui-overhaul-design.md`
(Section 1, "Turn strip", "Giant turn arrow", "The turn countdown borrows
the main number slot") and extends section 6 of
`nav-2026-07-13-nav-ui-enhancements-design.md` ("Countdown bar").*

## Why

On a turn approach Nav shows the next turn in three places:

| Element | Position | Content |
|---|---|---|
| Turn strip (`#hudBox`) | Top centre | The word "Right", the road name, the distance |
| Countdown strip (`#progress.countdown`) | Bottom | A bar that burns down, the distance, an amber arrow on the turn side |
| Large left number (`#hudSpeed.cd`) | Top left | Changes from speed to the distance, in amber |

The distance shows three times. The direction shows two times, as a word
at the top and as an arrow at the bottom. The rider must look from the top
of the screen to the bottom for the full message, and loses the speed
number at the moment of braking for the turn.

## Decision summary

| Question | Decision |
|---|---|
| How many elements | **One.** A turn band at the bottom, in the position of the countdown strip |
| Top turn strip | **Removed** |
| Amber countdown in the large left number | **Removed.** The number stays as speed (or battery) |
| Background | **Transparent.** The map shows through |
| Text | **Road name only.** The image gives the direction |
| Units | Metres or seconds — the "Countdown units" setting that exists |
| Image | **A manoeuvre image from the turn angle**, as car navigation shows it: slight, normal, sharp, U-turn |

Options that were not selected: one card at the top (covers the top
centre, where the track ahead shows); one large arrow on the turn side
(covers the map where the turn goes, and loses the burn-down bar).

## 1. The band

**When it shows.** The band replaces the ride-progress strip when the next
cue is nearer than the "Countdown from" distance (`cdDist`, 300 m as
standard). After the cue the progress strip comes back. This is the timing
of the countdown strip today (`ns.cdOn`).

**What it shows.**

| Part | Content |
|---|---|
| Image | The manoeuvre image, in the turn-arrow colour, on the side of the turn. A straight or a hazard cue shows its image on the right |
| Number | Distance (rounded to 5 m) or seconds. Seconds stop at the last value when the rider stops, as today |
| Text line | The road name. With no name: the surface the turn goes on to ("on to dirt"). For a hazard cue: its word ("Gate", "Creek crossing") |
| Burn-down | A clear fill that gets smaller toward the turn. Accent colour, then warning amber inside the near distance, as today |

**Look.** No background plate. A thin border in the text colour marks the
limits of the band. The number and the text line are white with a dark
outline, so that they read on a light map and on a dark map.

**Unchanged.** The sounds (approach tone, turn tone, departure chime). In
landscape the band stays in the left third of the screen.

**Removed with the top strip.** The tap that showed the full instruction in
large text. A tap with gloves during an approach is not practical, and the
band carries the road name.

## 2. Manoeuvre images

Each turn cue already stores its signed turn angle (`deg`). No new data.

| Image | Turn angle |
|---|---|
| Slight left / right | Under 40° |
| Left / right | 40° to 110° |
| Sharp left / right | Over 110°, to 155° |
| U-turn left / right | Over 155° |
| Straight | A junction cue of type `straight` |

Hazard cues keep their own icons in the same position: danger and obstacle
in the danger colour, gate and creek in the turn-arrow colour.

**Source.** The Nav icon set (Lucide) has no sharp-turn and no U-turn
image. Four symbols come from the Tabler set (MIT licence): bear, corner,
sharp turn, U-turn. The left images are the same symbols mirrored.
Straight and the hazard icons exist already.

**Not included:** roundabout and fork images (Nav does not detect those),
and a "then" image for a second turn that follows closely.

## 3. Special cases

| Case | Behaviour |
|---|---|
| Riding the track in reverse | Nav already swaps left and right. The image and its side follow the same swap |
| Off track | The band goes away and the "OFF TRACK" banner shows, as today |
| Bike indicators (Stark Varg) | The flashing telltale stays. Indicator on the side of the turn image: the turn image flashes. Indicator on the other side: the plain arrow flashes there |
| Turn complete | The green edge that the top strip showed moves to the progress strip, with the same chime |
| Schemes | The band uses the scheme values: `hud.arrow` and `hud.arrowOp` for the image, `hud.accent` and `hud.warn` for the burn-down, `hud.text` for the border. The fixed colours in the canvas drawing code go away |
| Layout editor | The top 64 px are reserved today as "turn strip zone — kept clear" (`#editReserve`). With no top strip the zone is free for layout items |
| Training ride | The lesson steps that point at `#hudBox` and say "Top strip: the next turn" change to the band |

There is no setting to get the top strip back. One element is the aim.

## 4. Build

| Part | Change |
|---|---|
| Band | Page elements (fill, number, text line, image) in place of the canvas drawing in `drawCountdown`. Scheme colours then apply through CSS variables, and the outline text is sharp |
| Image choice | One pure function: cue type + turn angle + riding direction → image name and side. Its own file, `apps/nav/manoeuvre.js`, in the pattern of `corridor.js` and `tracklock.js` |
| Symbols | Four new symbols in the inline sprite |
| Removed | `#hud` / `#hudBox` markup and styles, `setHud`'s strip rendering, the strip tap handler, `#hudSpeed.cd` and `cdMain` |
| Offline cache | `manoeuvre.js` joins the service worker shell list. The cache version goes above the version on `main` |

`setHud` also sets `S._turnCue`, which the indicator arrows read
(`applyCdArrows`). The build keeps one small function that derives the cue
state for the band and for the indicator telltales.

## 5. Tests

1. `apps/nav/tests/manoeuvre.test.mjs`: each angle limit (39°, 40°, 110°,
   111°, 155°, 156°), left and right, reverse riding, straight, each hazard
   type.
2. `tools/ui-sweep`: the states that measured the top strip go away. The
   band text is over the map, and the sweep skips text over the map — it
   cannot approve the band. The outline text is checked by eye.
3. A browser run on the dev server with the Demo ride, with pictures as
   proof: each of the four turn images and a hazard cue; metres and seconds;
   portrait and landscape; a light map and a dark map; each scheme.

## 6. Delivery

One branch, `feat/nav-turn-band`, one pull request, the usual sequence
(branch, verify in the browser, PR, green CI, squash merge).
