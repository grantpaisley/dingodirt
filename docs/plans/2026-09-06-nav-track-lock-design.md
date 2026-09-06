# Nav track lock — ADV tracks behave like Google Maps

*Design, 2026-09-06. Brainstormed and validated section-by-section with
Grant. Touches `apps/nav/index.html`, the nav pack builder in
`core/rust/daemon/src/routes/export.rs`, and the behaviour framework docs.*

## Why

Nav was built for enduro. The rider dot sits at the raw GPS fix, the arrow
follows the smoothed GPS course, and a single fix beyond 60 m sounds the
off-track growl. On a single-track loop that is right: you want to see
exactly where you are relative to the line.

On an adventure-bike trip it is wrong. Following a 300 km ADV track down
gravel roads, the dot wanders across the road and into the bush with every
GPS wobble, the arrow twitches at low speed, and tree cover under a cutting
can throw a single 80 m fix that trips the alarm. Google Maps solves this by
assuming you are on the road until you are clearly not: the dot is drawn on
the line, the chevron points along it, and only a real departure lets go.

Nav needs that behaviour for ADV tracks, and only for ADV tracks. Enduro
handling stays exactly as it is.

## Decisions

Recorded in the order they were made.

1. **What locks.** The rider dot, its heading arrow, and the follow-camera
   centre. The breadcrumb, accuracy circle, off-track banner distance, ride
   record, and friend position sharing stay on the raw fix.
2. **Thresholds.** Release the lock at 50 m, re-lock within 30 m, with an
   accuracy guard (below). Google has never published its own numbers; the
   repo's Google Maps preset assumed 30/20 and the behaviour framework doc
   flags that as a guess. 50/30 holds through typical dirt-road GPS error and
   still catches a wrong turn within a few seconds at 80 km/h.
3. **The track decides.** Handling follows the type of the track being
   navigated, not a global toggle. An ADV track gets the broad profile; an
   enduro track gets the narrow one. The server already records this: rides
   carry a `mode` enum of `adv`, `enduro`, `mtb`, `other`.
4. **The guard is ADV-only.** The accuracy guard is part of the lock, not of
   the off-track decision. Enduro riders see no change to when the growl
   fires.
5. **Off track never zooms in.** For every profile, leaving the track releases
   approach zoom and returns to the cruise span. The zoom then holds.
6. **Mode is set in the plan app only**, for now. No per-track editor on the
   phone.

## The model

Track lock is a rendering and camera concern layered on state nav already
computes. Each fix still produces the raw position and the nearest point on
the navigated track, as today. Lock adds one derived value, the **display
position**: the projected point on the track, or the raw fix.

The rule: display position is the projected point when the active profile
locks, a track is being navigated (follow mode, or snap mode while latched),
and the off-track flag is clear. Everything else uses the raw fix.

So lock inherits the existing hysteresis. You leave the track visually at the
instant the growl fires and return to it at the instant the back-on chime
does. There is no second state machine to drift out of sync.

Three consumers switch from raw to display position:

- the rider dot and its heading arrow,
- the follow-camera centre,
- the course-up bearing when the map is oriented to course.

The arrow and course-up bearing take the **track's bearing at the projected
point**, in the rider's direction of travel, instead of the smoothed GPS
course. This is why Google's chevron is steady at walking pace. Nav already
has `trackBearingAt` for this; snap mode uses it to decide which way round to
latch.

Everything that keeps the raw fix keeps it for a reason: the accuracy circle
stays centred on the truth so the rider can see how far the lock is pulling,
and the breadcrumb stays honest for post-ride review and for the "way you
came" line when off track.

## Profiles: the track picks the vehicle

The `VEHICLES` table in nav already holds per-vehicle cue windows, default
speed, and zoom spans. It gains three fields:

| vehicle   | lock  | release (offM) | re-lock (onM) |
|-----------|-------|----------------|---------------|
| walk      | false | 60             | 40            |
| mtb       | false | 60             | 40            |
| enduro    | false | 60             | 40            |
| adventure | true  | 50             | 30            |

The unlocked rows are today's values. `offM` and `onM` move from global
advanced settings into the vehicle table; the advanced tab already supports
per-vehicle overrides (`veh: 1` rows), so the sliders stay and become
per-vehicle. Lock joins them as a per-vehicle toggle, "Lock position to
track". A rider who finds 50 m too tight adjusts it once for adventure and
enduro is untouched.

Each nav track carries a `mode`. When a track is being navigated, its mode
selects the vehicle profile:

| track mode | vehicle profile          |
|------------|--------------------------|
| `adv`      | adventure                |
| `enduro`   | enduro                   |
| `mtb`      | mtb                      |
| `other`    | the vehicle setting      |
| absent     | the vehicle setting      |

Cue distances, zoom spans, lock, and off-track thresholds all follow the
selected profile. The vehicle segment in the settings sheet becomes the
**fallback**: used for tracks with no mode, loose GPX files, and explore
mode. Its label says so.

Snap mode latching onto an ADV track switches to the adventure profile;
unlatching reverts to the fallback. Switching tracks by the picker
re-evaluates the profile immediately. The ride brief shows the effective
profile, so a mismatch between fallback and track is visible before riding.

Behaviour presets keep working. `offroute.detectM`, `offroute.rejoinM`, and
the previously unimplemented `position.snapToRoute` write to the override
for whichever vehicle is current when the preset is applied. No new
behaviour file is needed. The Google Maps preset's numbers move to 50/30 to
match what it claims to model.

## Where the mode comes from

The nav pack builder (`DingoNavTrack` in `export.rs`) adds `mode` to each
track entry, read from `rides.mode`. Nav stores it on the track's IDB record
and on the runtime track object. Packs built before this change have no mode
and fall back to the vehicle setting, so nothing regresses.

The site pack already emits `mode` per track; the nav pack catches up.

## Per-fix data flow, navigated track

1. Raw fix arrives. Nearest point on the track is computed as today.
2. **Off-track decision.**
   - Locked profile: off is declared when `distance - accuracy > offM`, or
     when `distance > offM` has held continuously for 2 s. A single 80 m fix
     with a 60 m accuracy circle under a cutting is held; ten in a row are
     not.
   - Unlocked profile: a single fix beyond `offM`, as today.
   - Re-lock has no guard. A fix within `onM` clears the flag at once.
3. **Display values.** Position is the projected point when the profile
   locks and the flag is clear, else the raw fix. Heading is the track
   bearing in the settled travel direction, else the GPS course.
4. Dot, arrow, and camera consume the display values. Breadcrumb, accuracy
   circle, banner distance, ride record, and friend sharing consume the raw
   fix.

The dot jumps between raw and projected rather than sliding. At 50 m the
jump is visible but honest; a slide would show the dot riding across
country for a second.

Direction of travel for the arrow comes from the existing direction votes.
Until they settle, in the first few fixes of a ride, the arrow uses the GPS
course, so it never points backwards down the track at the start.

## Camera when off track

Today `followCamera` freezes the zoom at whatever it was when the off flag
set. A missed turn happens in approach zoom, so the freeze holds the tight
junction zoom while the rider is lost. That is the "zooms in when off track"
behaviour, and it is wrong for every profile.

New rule, all profiles:

- On going off, approach zoom is released and the camera returns to the
  cruise span for the current speed.
- From there the zoom holds. It never tightens while off. Manual zoom is
  still respected.
- On rejoin, normal behaviour resumes, including approach zoom for the next
  turn.

## Edge cases

- **No mode** on the track: fallback vehicle, today's behaviour.
- **Stationary at a junction with poor GPS**: the accuracy guard holds the
  lock; the dot does not bounce.
- **Two tracks within lock range**, follow mode: the track being followed
  wins, as today. Snap mode scores by distance and heading as today and
  applies the latched track's profile.
- **Profile change mid-ride** (picker or snap): cue distances and zoom spans
  change with it; the current zoom eases to the new cruise span on the next
  camera tick.
- **Behaviour preset applied mid-ride**: writes the current vehicle's
  override, takes effect on the next fix.

## Testing

The lock and off-track decision move into a small pure module beside
`corridor.js` (`apps/nav/tracklock.js`), loaded by `index.html` and
node-testable in `apps/nav/tests/`. It covers:

- hysteresis: release at `offM`, re-lock at `onM`, no flapping between;
- the accuracy guard: a single wide-accuracy fix beyond `offM` is held, a
  tight-accuracy fix is not, and a 2 s run of wide fixes is not;
- profile selection from track mode, with the fallback for `other` and
  absent;
- display position and heading for locked, unlocked, and off states.

The demo ride gains an ADV segment that leaves the track under a simulated
poor-accuracy patch, then genuinely departs. Browser proof is a demo-ride
screenshot with the dot on the line and the accuracy circle offset beside
it, and a second after departure showing cruise zoom, not approach zoom.

## Out of scope

- Editing a track's mode on the phone.
- Rerouting. Off track still means the growl, the banner, and the breadcrumb
  home; no routing engine is involved.
- Sliding the dot between raw and projected positions.
- Any change to the breadcrumb or ride record.

## Docs to update alongside

- `apps/nav/docs/settings-reference.md`: off-track rows become per-vehicle;
  add the lock toggle.
- `docs/plans/studio-2026-08-03-nav-behavior-framework.md`: drop
  `position.snapToRoute` from the unimplemented list.
- `apps/nav/behaviors/google-maps.json`: 50/30.
