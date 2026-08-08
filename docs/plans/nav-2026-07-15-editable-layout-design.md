# Editable screen layout (edit mode) — design

**Date:** 2026-07-15 · **Status:** shipped, revised same day (see Revisions)

## Revisions (2026-07-15, after hands-on iteration)

- **The dock target is the ride panel (the glove overlay), and its grid IS
  the dock** — the fixed tiles (Auto zoom, Map layers, Profile, Steepness)
  and the docked controls are one collection. The interim settings-panel
  strip and the bottom tray are gone. When you drag a button to the bottom
  edge, the ride panel springs up. A ☰ tap while you edit opens the panel,
  so you can drag items back out.
- **The ride panel is deduped**: the North up, Re-center, and Sound tiles
  are gone (they duplicate the on-screen buttons). A Map layers tile cycles
  Day/Trail/Dark/Sat.
- **START/STOP is one relocatable button** (a screen slot or docked): green
  START when idle, red STOP when riding. STOP is hold-to-confirm — a line
  runs around the button perimeter (~1.15 s, the SVG pathLength trick).
  Only a completed lap ends nav. An early release toasts a hint. The click
  after a completed hold is suppressed, so it cannot re-start.
- **Resize is a drag handle** (a cyan corner dot, 0.4×–6× continuous, snaps
  at 1.0), not tap-to-cycle. Sizes are stored as numeric multipliers
  (legacy S/M/L still reads).
- **The Export button** copies the layout JSON, so we can bake it into the
  main program.
- **Test viewports**: 1440×720 and 720×720 (the split-screen half; it keys
  to the 'portrait' map, which gives split-screen its own layout).
- Parked enhancement: **"+" placeholder tiles** in spare dock slots
  (see future-developments.md).

This design picks up the parked "drag-to-rearrange control layout" entry in
`future-developments.md`. **Purpose note:** this is primarily a *design tool
for Grant* to find the correct UI layout on the tablet — it may never reach
end users. Thus: put function before polish. Apply no glove-ergonomics
constraints inside edit mode itself (the normal riding UI is untouched).

## Decisions (from brainstorm, 2026-07-15)

- **Scope:** buttons + big readouts. The editable set = the floating chrome:
  orient / follow / fit / sound, zoom −/+ and the two zoom presets, the
  START fab, and the ☰ menu button. The readouts: speed (`#hudSpeed`), the
  Varg battery pill (`#vargPill`), the Varg mode digit (`#vargModeBig`),
  and the indicator telltales (`#vargInd`). The **turn strip stays fixed**
  — it is safety-critical, and its top-band layout is load-bearing. The
  bottom bar, the panels, and the pills (`hold`/`lock`) stay untouched.
- **Custom overrides adaptive:** an element with a saved slot gets an
  absolute position (inline styles). It no longer takes part in the
  adaptive shuffling (the `body.navving …` offsets). Elements *without* a
  saved slot keep the stylesheet defaults, including the adaptive rules.
  Edit mode shows the turn-strip zone as a reserved band, and the grid
  starts below it.
- **Resize = tap to cycle S/M/L** on the readouts while you edit
  (multipliers 0.7 / 1 / 1.4 via a CSS var; buttons do not resize).
- **Entry:** the "Edit screen layout" button in ☰ → Settings → General.
  Exit via a floating ✓ Done pill. Edit mode is unreachable while you
  navigate (☰ opens the glove overlay then), so it never coexists with the
  riding hot path.
- **Wobble** while you edit (a single CSS keyframe, a phase offset per
  element) as the "taps are disarmed" indicator. Drop it if it ever fights
  the drag code.

## Data model

```js
S.set.layout = {
  portrait:  { followBtn: { slot: '0-2' }, hudSpeed: { slot: '2-0', size: 'L' }, muteish… },
  landscape: { … }
}
```

- Orientation = `innerWidth > innerHeight ? 'landscape' : 'portrait'`
  (aspect-ratio, **not** `screen.orientation` — split-screen lies).
- Slot id `"<col>-<row>"` on a **5 col × 6 row** grid, or `"panel"`
  (docked).
- An absent key = the stylesheet default. An empty orientation = fully
  default (the adaptive rules live). One `saveSet()` per drop, nothing on
  the hot path.

## Slot grid

- Columns: 5 anchors — the left edge (+10px), 25%, 50%, 75%, and the right
  edge (−10px). The edge columns anchor the edge of the element
  (`left:10px` / `right:10px`). The middle columns centre it
  (`left:X%; translateX(-50%)`).
- Rows: 6 equal cells between a **top reserve** (~64px, the turn-strip
  zone) and a **bottom reserve** (~64px, the menu/progress strip + the dock
  tray). The element is vertically centred in its cell
  (`translateY(-50%)`).
- The layout computes the geometry from the live viewport at apply-time —
  no stored pixels. Rotation and split-screen just re-run `applyLayout()`.

## Edit-mode interactions

- Enter: close the panel, set `body.editing`, and materialise every
  editable element to a fixed pixel rect (its current position). Show the
  grid dots, the reserved band, the dock tray, and the ✓ Done / ↺ Reset
  pills. Bind the pointer handlers. A capture-phase listener suppresses
  all clicks on the editable elements.
- Drag: pointer capture, live `left/top`; the nearest slot dot highlights.
- **Displacement:** when you hover over an occupied slot, the occupant
  moves to the next free slot **below** in its column. Else it moves to
  the next free slot **to the right** in its row, else left, else anywhere
  free. The move recomputes per hovered slot from the committed state, so
  a drag away reverts automatically. Commit on drop.
- **Dock tray:** a slim full-width bar at the very bottom while you edit
  ("drop here to dock into ☰ menu"). Buttons only (not the readouts, not
  ☰ itself). Docked → `slot:'panel'`. In normal use, docked buttons render
  as a strip at the top of the ☰ panel, still tappable. Drag a button out
  of the tray to re-place it on the grid. Each element has one home by
  construction.
- Tap a readout while you edit → cycle S/M/L.
- Reset (per current orientation): wipe `layout[orient]`, back to the
  defaults.
- Exit: unbind the handlers, clear the edit chrome, run `applyLayout()`,
  and do a final `saveSet()`.

## Rendering

- `applyLayout()` runs at boot, on a viewport change (a resize listener +
  the existing 1s watchdog), and on edit exit. Per entry: docked →
  reparent into `#dockStrip`; slotted → inline `position:fixed` + the
  computed left/right/top. Freed buttons stay children of their
  `.ctlgroup` (inline `fixed` removes them from the flex flow; the group
  CSS sizing still applies).
- Readout size: the `data-sz` attr + the `--sz` var. The CSS `calc()`
  rules are scoped to `[data-sz]`, so untouched elements keep the default
  sizing (incl. the media-query sizing).
- Ghosts: `body.editing` forces the conditional elements visible at ~55%
  opacity.
- Hot-path safety: the identical argument to the parked spec — nothing
  per-fix or per-frame touches any of this. The drag machinery binds only
  while you edit.

## Known limits (accepted for v1)

- Only slotted elements occupy grid cells. A default-positioned element
  can visually overlap a dropped one (move it too, or reset).
- No undo beyond Reset. No cross-orientation copy.
- `env(safe-area-inset-*)` is not readable from JS. The reserves use
  constants generous enough for the tablet.

## Test checklist

Drag, snap, and displace by hand. Rotate round-trip (portrait edits do not
leak to landscape). Check that a split-screen resize recomputes the slots.
Do a dock round-trip (dock mute → tap it in ☰ → drag it back out). Check
that ghosted conditionals land where you placed them. Check that a reload
applies the layout with no default-position flash. Check that Reset
restores the defaults and the adaptive rules. Bump the SW cache.
