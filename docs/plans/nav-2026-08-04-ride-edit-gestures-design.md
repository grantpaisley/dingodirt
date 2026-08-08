# Ride & edit gesture redesign — tap-to-add, point menu, double-tap zoom

2026-08-04. This design replaces TURN MODE, the centre lock, and the heatmap
knockout with a flat gesture model. Riding and cue-edit mode share the model.

## Gesture model

Riding (`S.nav`) and edit mode (`S.cueEdit`) share one table:

| Gesture      | On a point        | On the track                  | Empty map |
|--------------|-------------------|-------------------------------|-----------|
| Tap          | Open point menu   | Add a turn point immediately  | —         |
| Double-tap   | Zoom toggle       | Zoom toggle                   | Zoom toggle |
| Long-press   | —                 | Track picker (stopped only)   | —         |
| Drag / pinch | Pan / zoom — always live, no centre lock |         |

- A tap hit-tests the points first (~30 px radius), then the track (25 m). A
  hit on a point opens the menu. This includes a point placed one second
  before. A hit on the bare track places a `turn` mark. The app infers the
  direction from the geometry (`inferTurnDir`) and snaps the mark to the
  nearest track vertex. It saves the mark through the existing
  `addTurnPointAt` → overlay → pack-sync path. There is no arming step and no
  picker on the way in.
- Riding places a mark against any analysed track. Edit mode restricts both
  hit-tests to the selected track.
- When the rider is stopped and *not* in edit mode, taps only select or
  deselect tracks (`trackTap`). Only riding or edit mode permits placement.
- The 280 ms tap/double-tap disambiguation window now applies everywhere
  (planning included). Thus a tap cannot collide with the zoom gesture.

## Double-tap zoom toggle

- While the user rides, a double-tap eases to the "zoom in" preset
  (`max(16.5, zoomForSpan(presetSpan('min')))`). The camera turns compass-up
  to the course bearing, with the rider in the low third (an 18% offset). The
  app stashes the prior zoom. The next double-tap eases straight back to the
  stashed zoom (and to bearing 0 if the orientation is north-up). This
  inherits what was good in TURN MODE and drops the rest.
- The toggle is strictly manual in both directions — there is no auto-return
  when the rider passes the junction.
- The double-tap is exempt from the speed gesture-lock: it works at any
  speed. Pinch and rotate stay guarded.
- Stopped/planning keeps MapLibre's normal incremental double-click zoom.

## Point menu (mark picker regrown)

The picker is full-screen, with a fixed 12-slot grid: 2 rows × 6 columns in
landscape, 4 rows × 3 columns in portrait (a CSS grid switched on
`body.portrait`).

- Slots 1–9: the nine kinds from `MARKS`. Turn keeps its direction chip
  (auto → L → R → S).
- Slot 10: **Delete** — a red tile. It is live only when the picker opened on
  an existing point. Delete is one tap, with no confirm (the point is one tap
  from re-added). In edit mode, a delete of a base cue keeps the restore
  semantics (`ov.removed`). Greyed removed dots open the menu with
  **Restore** in the red slot instead.
- Slots 11–12: blank, reserved for two future POI kinds. We render them as
  faint empty cells, so the grid never reflows when they arrive.

To place a non-turn POI, the user makes two taps, with no modes: tap the
track (a turn point appears) → tap the point → pick the kind.

## Removals

- **Centre lock** — we remove `setLock`, `S.lock`, `#lockPill`, the
  `dotBtn.locked` ring, the lock branches of the long-press handler, and its
  train events and coach references. The code never disables `dragPan`.
- **TURN MODE** — we remove `enterTurnMode`/`exitTurnMode`, `S.turn`,
  `setMarkArm`, `#markTurn`, `#turnHint`, all `body.turnmode` CSS, and the
  arming/removed/move branches of `rideTap`. Its camera behaviour lives on in
  the double-tap zoom toggle.
- **Heatmap knockout** — we remove `maskedHeatData`, `heatMaskCache`, the
  `heatU` source and the `heat-under` layer, and the `heatMask`/`heatUnderOp`
  settings and sliders. The heatmap renders whole under the route.
- **Long-press** shrinks to one job: stopped only, near a track → the track
  picker.

## Recentre dot & base row

- The dot shows only when the map is away from the rider
  (`S.follow === false` — a drag, the box/fit button, or anything that pans
  off sets this). While the map follows, the dot fades to invisible (~200 ms,
  `pointer-events:none`). Its slot in the row is held, so ☰ / − / + never
  move. `recentreTap` is unchanged; the `active` lit-dot styling goes.
- Base row: four equal cells in both orientations (landscape drops the
  clustered auto-margin layout). While the user rides, the tiles become
  larger (~104 px) and near-transparent (an icon + a faint outline, full
  opacity on `:active`). They keep the `--navOp` idle fade. Stopped keeps
  the solid look.

## Touchpoints

`index.html` throughout; the coach/tour steps that taught
double-tap-for-turn-mode and the lock; `docs/settings-reference.md` loses
`heatMask`/`heatUnderOp`.
