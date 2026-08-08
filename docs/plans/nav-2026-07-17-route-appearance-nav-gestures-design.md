# Route appearance & nav gestures — design draft

**Date:** 2026-07-17
**Status:** VALIDATED 2026-07-17 (option-based grill, four batches + follow-ups).
All questions are resolved. This document replaces parts of the 2026-07-13
route-rendering design (§3). It also replaces the 2026-07-15 ride-UI gesture
grammar where §8 notes this.

## 1. Route line system

### 1.1 Colour tokens

| Role | Value | Note |
|---|---|---|
| Active route core | `#4AA8FF` | **DECIDED** — this replaces the cyan `#00e5ff` as the `colRoute` default. It stays a registry colour setting |
| Active case, option A | `#FFFFFF` | |
| Active case, option B | `#101820` | |
| Travelled route core | `#7F8791` | a neutral grey |
| Travelled route case | `#1A1E24` | near-black |

**DECIDED (was Q2):** the shadow/glow effect is only the swap of the casing
colour, nothing more. The dark case `#101820` shows by day and reads as a
shadow. The white case shows at night and reads as a glow. The existing
day/night style flip controls the swap automatically. There are no extra
effect layers.

The A/B "choice" is thus automatic. Keep a registry override
(auto | always-white | always-dark) for tuning. There is a single casing
layer. We reject the "dark + narrow white rim" double-casing reading of
point 15.

### 1.2 Widths

The default overall width is 6 px. The default core is 4 px (case = 1 px per
side). Settings (registry):

- **Overall width** — a number input. The core scales to keep the case:core
  ratio.
- **Zoomed-in width** and **zoomed-out (full-track) width** — these are the
  two ends of the zoom interpolation.
- **Case:core ratio** — you can adjust this.

Reference table (Grant's):

| Zoom / use | Core | Total |
|---|---|---|
| Full-track overview | 4 px | 6 px |
| Planning / mid zoom | 5–6 px | 7.5–9 px |
| Turn-by-turn navigation | 6.5–8 px | 10–12 px |

**DECIDED (was Q3):** use a plain zoom interpolation between the two knob
values. The nav zoom levels land at the fat end naturally. There is no width
switch per state.

### 1.3 Surface patterns (per screenshot)

- **Sealed** — solid
- **Track / dirt road** — dashed
- **Single** — dotted

The mapping is the same as today (`surf-dirt` dashed, `surf-single` dotted).
The travelled section keeps the patterns. Thus a rider who reverses direction
can still read the surface. The dash and dot gaps stay fully transparent.

### 1.4 Route states

| State | Core | Case | Effects |
|---|---|---|---|
| Remaining | 100% saturation/opacity | a single case: dark (day) / white (night) — decided, see 1.1 | "shadow"/"glow" = the case colour itself |
| Recent (last 50–100 m behind) | 70–85% strength | keeps a clear connection to the position marker | |
| Older travelled | grey `#7F8791`, 45–60% opacity | reduced `#1A1E24` | flat — the case does not swap day/night |
| Missed (after rejoin) | the core colour at ~50% opacity | **none** | the opacity is registry-tunable |

**Turn-point markers follow the line treatment** (decided 2026-07-17). They
are grey on the travelled sections. They dim to ~50% on the missed sections.
They stay at full strength ahead.

- The travelled section keeps the surface patterns (see 1.3).
- We remove or neutralise the completed uphill chevrons in the travelled
  section. Only the hazards ahead must get attention.
- **DECIDED (was Q5):** the recent band is the last **75 m at 80% strength**.
  The older travelled section is at **50% opacity**. All three values are
  registry-tunable.

### 1.5 Off-route rule (missed segments stay hot)

Progress advances by the **route sequence index, not the nearest geographic
point**. While you are off-track, the index does not advance. The skipped
span stays at full colour (you can still come back for it). **On rejoin, the
missed span drops to ~50% opacity and loses its casing** (decided
2026-07-17). The casing is the exclusive "route ahead" signal.

This gives three weights that you can rank at a glance:
remaining (full colour + case) > missed (half colour, bare) > travelled
(grey). The rationale: near a returning leg, you must tell the in track from
the out track. After the ride, the missed spans stay identifiable as the
parts that you skipped.

**DECIDED (was Q6):** the progress state **stays after STOP**. The
travelled-grey spans and the full-colour missed spans stay on the map for
the post-ride review. The app clears them when a new navigation starts (the
same lifecycle as the breadcrumb trail).

### 1.6 Layering (self-crossing / out-and-back)

The draw order, bottom→top: travelled route → remaining route → position
marker (dot/square). On an out-and-back, the outbound line (travelled, grey)
sits below the inbound line (remaining, colour). The position marker is
always on top.

**DECIDED (was Q7):** both render. The travelled-grey line shows the *route
progress*. The muted dotted breadcrumb (`S.trail`) shows *where you went*.
The breadcrumb sits **under everything** in the stack. It earns its keep
exactly where the two lines diverge — off-route wandering. The full order,
bottom→top: breadcrumb → travelled route → remaining route → position
marker.

### 1.7 Track ends

**A big dot marks the start of the track. An arrowhead marks the end** (as
in the screenshot). These are structural orientation marks, not progress
marks. Unlike the turn-point markers, they do **not** grey out. They stay at
full strength through every route state. They also **stay in the post-ride
view**.

Thus you can read a finished ride start-to-end at a glance (the mock-up's
travelled grey/black lines keep the blue dot and the arrowhead). They apply
to the navigated route. They also apply to an archived ride when it shows
individually (§1.8). The dot and the arrow scale with the line width.

## 1.8 Breadcrumb lifecycle & ride archive (decided 2026-07-17)

Today, only imported bundles feed the heatmap. The bike never contributes.
The app discards the breadcrumb when the next navigation starts. The new
rule:

- **On STOP: archive the ride.** Simplify the trail (Douglas-Peucker, ~10 m
  tolerance, tunable). Append it to a local rides store (IndexedDB, dated,
  named after the navigated track).
- **Archived rides render as 'own rides'** in the existing heat layers
  (`clsMatch` already colours class `own` `#ff7a00`). Thus the trails that
  you rode become solid orange organically. No round-trip to the Dingo web
  is necessary.
- **Each archived ride is exportable as GPX** (menu, stopped-only).
- **The live breadcrumb keeps its current lifecycle.** It stays visible
  after STOP for review and backtracking. The app clears it when the next
  navigation starts.
- A build detail to resolve later: a newly ingested bundle can already hold
  an archived ride. Then remove the duplicate (by date) or accept the
  double-draw.

## 2. Slope chevrons & direction notches

**This repurposes the chevron glyph.** Today, `sel-chevrons` (`›` symbols)
encode the *direction*. The new scheme:

- **Chevrons = steep / very steep slope warnings** (two severity levels).
  The app removes or neutralises them after you travel the section.
- **Direction = V-shaped chunks cut out of the track line** (notches). These
  replace the direction chevrons.

**DECIDED (was Q9):** the colour-=-steepness gradient channel **dies
entirely**. Delete the `steep` setting, the grade-band baking, and the
line-gradient path (2026-07-13 §3). Use one flat core colour always. The
slope chevrons are the only grade signal.

**DECIDED (was Q10):** the direction marks are **case-coloured V overlays**
drawn on top of the line (the same symbol-layer mechanism as today's
chevrons, restyled as V's in the casing colour). They are not true cutouts.
They read on solid, dashed, and dotted segments alike.

**DECIDED (was Q8):** a single chevron shows at **≥10%** grade. A double
chevron shows at **≥17%** grade (registry-tunable). The chevrons point
uphill, drawn in the casing colour.

## 3. Turn arrow

The giant nav arrow stays as-is (shape/size/behaviour, incl. the
indicator-flash reuse). Add registry options for the **fill colour** and the
**surround/outline colour**.

## 4. Chrome: day theme, hamburger, typography

- **The day theme is Mac-like** (samples review, 2026-07-17 second pass —
  this replaces the earlier ☰-always-dark and panel-scope answers):
  - Plates (controls, ☰, dot/square): `#f5f5f7`, hairline `#c9c9ce`, dark
    glyphs (15:1). Contrast, not darkness, meets the ☰ visibility
    requirement.
  - Speed/mode readouts: near-black `#15202b` with a light halo (white
    failed at 1.8:1 on day maps). The countdown amber darkens to `#b45309`
    by day.
  - Accent: **macOS blue `#007AFF` by day** (cyan fails at 1.4:1 on light),
    cyan `#00e5ff` at night. The swap goes via `body.daymode` and is
    mirrored by hand in canvas.
  - Panel: a full Mac light component pass (white buttons + hairlines, blue
    selected segs, green iOS-style switches). It is light by day and keeps
    the original dark look at night.
  - Turn strip: frosted white by day, dark translucent at night.
  - **No riding fade on the day styles** (`--navOp:1`). The night styles
    keep the 0.4 ghost.
  - The route dash gaps read as the **casing colour** (a continuous case).
    Single track = dense square dashes, not dots. The `Dash gaps` seg
    restores the see-through look.
- **Text is mixed case everywhere** (kill ALL-CAPS, incl. the tile labels).
  The **symbols are ~12% larger**.
- New app versions **replace the saved UI layout config** (v4 migration;
  silent for now — a later version can warn). The layout anchors clamp into
  the viewport.

## 5. Nav gestures — DECIDED grammar (was Q13; supersedes 2026-07-15 §1/§2 triggers)

**A double-tap is the mode toggle:**

- **Double-tap (riding view) → TURN MODE**: the map snaps the zoom in and
  sets the compass mode. The MARK TURN button shows. The dot icon changes to
  a **square** (you are centred).
- **Double-tap (in TURN MODE) → back to riding zoom.**

**The dot/square is one stateful re-centre button** (it merges ● and ▢):

| State | Icon | Tap does |
|---|---|---|
| Centred on the rider | **square** | zoom out to the full track |
| Panned away (any drag) | **dot** | re-centre → becomes a square |

- A slide of the screen pans (you look around at the zoomed-in level). The
  instant a scroll starts, the square becomes a dot.
- A drag pans at any time. **Pinch-zoom works only when you are stopped.**
- The full cycle: double-tap → TURN MODE (square) → drag to look around
  (dot) → tap the dot to re-centre (square) → tap the square for the full
  track, or double-tap back to the riding zoom.
- Hold-to-lock (the 2026-07-15 dot grammar) is **dropped** unless it comes
  back.

**Mark a turn (two-step, armed placement):**

1. Tap **MARK TURN**. This arms the placement (prompt: "tap to place
   marker").
2. **Tap to place — DECIDED (was Q14).** We rejected the long-press (gloves
   + vibration). A stray tap costs one tap to fix (tap a point to delete it
   — the 07-15 delete/move grammar stays). The placement snaps to the
   nearest track position.

**The mode digit is tappable (resolved Q15):** a tap on the resident Stark
mode digit replays the **HP / Regen / TC info card**. This is the same ~4 s
flash card that shows automatically on a mode change (2026-07-15 §4). There
is no new UI — only an on-demand replay of the existing card. (The original
gesture item 8 was empty — dropped.)

**DEMO simulates the Stark mode:** the demo ride also feeds simulated Stark
mode telemetry. Thus you can exercise the mode digit, the mode-change flash
card, and the tap-to-replay off the bike.

## 6. Audio grammar

Direction = the count (unchanged: 1 = right, 2 = left). **Phase = the
pitch** (new):

| Event | Right | Left |
|---|---|---|
| Approach | a single **deep** tone | a double **deep** tone |
| At the turn | a single **high** tone | a double **high** tone |

- This replaces the direction-less 660 Hz `far()` beep. The approach becomes
  directional.
- **DECIDED (was Q16):** deep = **460 Hz**, high = 990 Hz (both
  registry-tunable).
- **Approach and departure chimes**: settings set the trigger by **seconds
  or distance** (per chime). **DECIDED (was Q17):** the departure chime =
  the **turn-complete confirmation**. It is a short neutral chirp N s/m
  after you exit the junction on-route ("turn done, carry on"). It reuses
  the back-on-track sound family. It is distinct from the off-track alarm.

## 7. Turn instructions

- **Tap the header/turn strip → the instruction expands briefly (~4 s),
  then collapses.** **DECIDED (was Q18):** this is an accepted exception to
  the exactly-three rule. The strip only exists during the turn approach,
  and the tap is read-only. The rule becomes "three, plus the turn strip
  when present".
- The instructions are in mixed case, with surface-aware naming:
  - A named road: "Left on to Arcadia Rd"
  - On to singletrack: "Left on to Single Track"
  - Sealed → dirt: "Left on to dirt"
  - **DECIDED (was Q19):** if neither the name nor a surface change is
    known → bare "Left" / "Right".

## 8. Conflicts with prior designs (explicit supersessions)

| Prior decision | This doc |
|---|---|
| 2026-07-13 §3 "No outside lines" — the casing deleted, a same-colour halo | **The casing comes back** (auto day/night). The halo system dies — delete the six `*-halo` layers and the `haloOp`/`haloMul` knobs (**decided, was Q20**) |
| Colour = steepness gradient channel | **DEAD (decided)** — a fixed core colour `#4AA8FF` + slope chevrons; delete the `steep` setting & the gradient path |
| `colRoute` default `#00e5ff` cyan | **`#4AA8FF` (decided)** — still a registry colour setting |
| `sel-chevrons` = direction | Chevrons = steepness; direction = **case-coloured V overlays (decided)** — not cutouts |
| The 660 Hz direction-less far beep | A directional deep-tone approach |
| 1-tap map = TURN MODE; the dot tap/tap/hold grammar | **Double-tap = the TURN MODE toggle + the dot/square state button (decided, §5)**; hold-to-lock dropped |
| MARK TURN one-tap drop | Arm (MARK TURN) then place (**Q14 narrowed** — tap vs long-press to place) |

## 9. Registry additions (settings, from this doc)

Route: overall width, zoomed-in/out widths, case:core ratio, case colour
(auto | always-white | always-dark; default auto day/night), core colour
(default `#4AA8FF`), travelled opacities (recent 80% / older 50%),
recent-band length (75 m), missed-span opacity (default 50%). Arrow: fill,
surround. Chevrons: grade thresholds (10% / 17%), size. Direction Vs:
spacing, size. Audio: deep (460 Hz) / high (990 Hz) frequencies, approach
chime (seconds|distance + value), departure chime (same). Chrome: ☰ plate
opacity. Header: expand duration (~4 s).

Deletions: the `steep` setting + the grade-band/line-gradient path; the six
`*-halo` layers + `haloOp`/`haloMul`; the hold-to-lock dot gesture.

## 10. Build order

1. **Route line system** — the casing layers (auto day/night), the widths +
   knobs, the `#4AA8FF` default, the halo/gradient deletion. Pure rendering,
   no state model.
2. **Progress model** — sequence-index progress with span tracking
   (travelled / missed / remaining), persistence past STOP, layering over
   the breadcrumb.
3. **Travelled/recent styling** — grey + fades + preserved patterns, the
   chevron neutralisation on the travelled sections.
4. **Direction Vs + slope chevrons** — restyle `sel-chevrons` into the two
   new symbol layers.
5. **Gesture grammar** — the double-tap TURN MODE toggle, the dot/square
   button, the armed tap-to-place marking.
6. **Audio** — the directional deep/high grammar, the departure chime, the
   chime settings.
7. **Chrome & telemetry taps** — the ☰ plate, the day panel theme, mixed
   case + icon size, the header expand, the arrow colour options, the
   mode-digit tap → flash-card replay, the demo Stark-mode simulation.
8. **Ride archive** — STOP → simplify the breadcrumb → the local rides
   store → the own-rides heat layer + the GPX export (§1.8).
