# DingoNav v2 — Orientation, Progress, Turn Cues

*Designed 2026-07-11 with Grant. Guiding priorities: simplicity and speed. The default
screen stays "a dot and a heatmap."*

## Scope

We add four things to the existing MapLibre+PMTiles nav app:

1. Orientation modes: north-up / course-up (no compass mode in v1)
2. Progress strip: the distance/time done vs to go, turn ticks, an optional elevation profile
3. Import-time route analysis: turn-cue extraction that uses the basemap road/track classes,
   plus steepness coloring
4. Ride-time turn alerts: speed-tuned timing, a glance card, vehicle presets

We explicitly cut these items for v1 (keep it simple):

- **Curve warnings** — turns only. A turn is a *decision point*. A curve is just
  geometry. The import keeps the analysis data (heading changes, severity). Thus we
  can add curve heads-ups later behind a setting, with no re-architecture.
- **Compass-up mode** — phone magnetometers near a running bike are off by 20–40°
  (the ignition, the alternator, bar-mount steel). They need a calibration UX. The frozen
  approach bearing in course-up covers the stopped-at-a-junction case.
- **Rerouting** — this is a follow-the-line app. Off track = a buzz; ride back.
- **Progress-strip interaction** beyond expand/collapse (no scrubbing, no
  tap-a-tick). That is planning behavior. This is a riding screen.
- **Speed coloring on import** — steepness only. Speed ramps are unreadable at nav
  zoom in sunlight. They compete with the heatmap colors. Plans have no timestamps anyway.

## Responsive requirement (added 2026-07-11)

The layout must work in **portrait, landscape, and half-screen** (split-screen /
half of a bar-mounted display). Short viewports (≤500 px tall) compact the HUD.
They hide the bottom bar during navigation (STOP lives in the glove overlay). They pin the
progress strip to the screen edge. They reflow the glove grid (one row of six when
wide, 3×2 otherwise). A 1 s watchdog re-places the chrome on viewport changes that
never fire a resize event (split-screen drags).

## 1. Main screen & orientation

The default screen shows the basemap, the heatmap, the route line, the position dot, the progress strip along the
bottom, and one fat button (~68 px) in the bottom corner on the throttle-free side
(a left/right setting). It shows nothing else.

**Orientation** — a compass rose sits in a fixed corner. A tap toggles north-up ⇄ course-up.

- The course bearing comes only from GPS fixes above about 7 km/h, low-pass smoothed.
- Below that threshold, the map holds the **last valid approach bearing**. Stop at a
  junction, and the map keeps pointing the way that you arrived.
- The rose always shows where north is.

**Glove button** — this opens an overlay of about 6 tiles, each ≥ 80 px: orientation, zoom
lock/auto, mute, the profile strip on/off, steepness coloring on/off, and end nav. Each tile needs one stab.
The overlay auto-dismisses after about 8 s or on a map tap. All other items (the vehicle
preset, friends, bundle management, warning tuning) live in a settings screen for use
while you are stopped.

**Auto-zoom** — the existing speed-driven easeTo stays. The zoom-lock tile freezes it.

## 2. Progress strip

The strip is one component along the bottom edge. It has two states. A tap or the glove tile toggles it.

**Collapsed (default)** — a thin bar (~14 px): the fill = the distance covered; **turn cues as
ticks**; end labels `12.4 km · 0:58` done / `10.7 km · ~0:52` to go.

- The ETA-remaining uses the **rolling moving average** speed (the same window as the warning
  lead). It ignores stopped time. Thus a snack stop does not inflate it.

**Expanded (profile)** — the strip grows to about 70 px. The fill becomes the elevation profile
(an area sketch from `<ele>`, LTTB-decimated once at import). The position dot rides the
profile. The ticks sit along the top edge. With steepness coloring on, the profile fill uses
the steepness ramp.

**Semantics**

- The position on the strip is the **route-distance** from the existing
  follow-from-nearest-point projection. Thus out-and-backs and switchbacks behave.
- Off-track: the strip dims, and the labels freeze (no fake ETA). The strip resumes on rejoin.
- The import pre-computes everything. The ride-time work is "move a dot along an array."

## 3. Import-time route analysis (cue engine)

This is a one-shot analysis when you import a route or select it for nav (a progress spinner,
seconds not minutes). The decision from the brainstorm: **on-device, at import**. It works
with any GPX from anywhere, needs no Dingo round-trip, and has zero per-frame cost. It must read
the track/road class from the basemap, not only the heatmap geometry.

**1. Corridor decode** — compute the z14 tile cover of the route. Fetch those tiles from
the local PMTiles blob (IDB). Decode only the `roads`/`paths` layers plus the loaded
heatmap tracks into line features with the OSM class: `track` (fire trail), `path`
(singletrack), minor/major road, etc.

**2. Way matching** — walk the route. Match each stretch to the underlying way
(the nearest feature within about 15 m, with a compatible bearing). The output is a segment list
("0–4.2 km on *track*, 4.2–6.8 km on *path*…"). The glance card also uses this list for its
"onto singletrack" text.

**3. Cue classification** — apply this at each point where the route heading changes ≥ ~25° over a
short window, *or* where the matched way changes:

- **TURN** ⇔ an alternative continues where you do not go: the way that you were on
  carries straight past the departure point, or another mapped/heatmap way leaves
  the junction. The angle can be shallow — a way-class change alone qualifies (the
  fire-trail→singletrack case, easy to miss at 30°).
- No alternative ⇒ no cue (curves are cut from v1; the severity data is still recorded).
- Cues within about 30 m merge into one (junction clusters).
- Unmatched stretches (an unmapped trail, nothing in the basemap or the heatmap): fall back to
  geometry only. There, a turn needs a much larger angle, because the alternatives are invisible.

**4. Steepness + profile** — the per-point grade from `<ele>` (smoothed over a window near 75 m,
the same approach as Dingo's web profile), plus the LTTB-decimated profile.

The results are cached in IDB, keyed by the route+bundle hash. Thus a re-open imports nothing again.

## 4. Ride-time turn alerts

The nav loop walks the baked cue list. There is no analysis during the ride.

**Timing: time-based, distance-clamped.** The far warning is about 15 s ahead, the near warning about 5 s, from the
rolling moving-average speed. The **vehicle preset** (enduro / MTB / adventure) sets
the min distances (e.g. 40/15 m MTB, 120/40 m adventure). Thus a crawl does not warn too
late. It also sets a max. Thus a fast fire-trail run does not warn 500 m early. The preset also
drives the auto-zoom aggressiveness.

**Sound** — the whole app has three sounds: turn-far (a double beep), turn-near (a higher
triple), and off-track (a buzz). The existing WebAudio implementation stays. The mute tile silences all sounds.

**Glance card** — on the far warning, a large card slides in above the progress
strip. It shows an arrow from the turn geometry, a live countdown distance, and the onto-line when known —
**"↰ 150 m · onto singletrack."** The card stays through the turn. The card flips green briefly when the
position matches the post-turn route direction. Then it dismisses. On a blown turn, the card goes
red, and the off-track buzz takes over.

**Missed-cue guard** — route-distance consumes the cues, not proximity. When you pass
route point *n*, all earlier cues become stale. Thus a GPS jump cannot fire ghost
warnings behind you.

## Implementation notes

- The tile decode needs a vector-tile parser over the pmtiles JS lib. (Both are vendorable —
  no CDN, consistent with the offline rule.)
- A 50 km route covers about 100 z14 tiles. A decode of one layer per tile is at a sub-second
  scale — but show the spinner anyway.
- All the new ride-time state is array-walking + one DOM card. We add nothing to the
  render loop.
