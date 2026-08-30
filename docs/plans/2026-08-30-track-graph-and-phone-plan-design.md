# Track graph, measure mode, and the phone plan page

*2026-08-30. Four asks for "the plan module", brainstormed against the real
code. One of them turned out to belong to a different app, and one turned out
to be a data problem rather than a style problem. Both corrections are below.*

## The four asks, and where each one landed

| Ask | Lands in | Stage |
|---|---|---|
| Town names appear earlier on every map | `core/basemap` — the shared AU archive | Deferred, after the rest |
| A three-level menu for a phone | `apps/site/app/p/[token]` — the share page | Stage 1 |
| Measure mode: distance and time between clicks | `apps/plan` | Stage 1 |
| Plan mode: clicks follow existing tracks | `apps/plan` | Stage 1, share page later |

### Two names that clash

`docs/plans/2026-08-07-planning-mode-design.md` already owns **planning mode**:
the group-voting share page at `dingodirt.com/p/<token>`. The new Plan-module
tool is therefore **route mode**, never "plan mode". The measuring tool is
**measure mode**.

### Two apps, not one

- **Plan module** — `apps/plan`, a Vite/React desktop workbench against the
  local daemon. Three panes, a nine-flyout map toolbar, the draw tool.
- **Share page** — `apps/site/app/p/[token]`, a Next.js page. The mates open a
  link, see the candidate tracks, and vote Yes/Maybe/No.

They share only `core/basemap` and `core/ui`. The phone work goes on the share
page, because that is what gets opened on a phone. Route and measure mode go
in the Plan module, because that is where the draw tool lives.

## 1 — Town names (deferred)

### What we measured

A Node probe read the live archive (`tiles.dingodirt.com/basemap-au.pmtiles`,
zooms 0–14) and decoded the `places` layer of the tile over each town.

| Town | Population | First zoom the feature exists |
|---|---|---|
| Port Augusta | ~13,000 | z6 |
| Quorn | ~1,200 | z7 |
| Hawker | ~250 | z7 |
| Blinman | ~22 | z12 |

### What this means

The style is **not** the gate. `places_locality` in `core/basemap/layers.json`
carries a non-zero `text-size` at every zoom, so it draws a name the moment the
feature exists in the tile. The gate is the tiler's per-feature `min_zoom`.

No style edit can show Blinman before z12, because Blinman is not in a z11
tile. `applyDetailBias` (`core/appliers/detail.js`) cannot help either — it
shifts zoom ramps, and there is no ramp to shift.

### Decision

Rebuild the AU archive with a lower `min_zoom` for `kind=locality`, so small
settlements enter the tiles around z8 instead of z12. This is a full re-tile of
the continent, so it waits until stages 1 and 2 land. Target: every named
locality present by **z8**, matching Quorn and Hawker today.

The re-tile corrects Plan, Nav, Studio and the share page at once, because all
four read the same archive through the same layer files.

Left open until the re-tile: how much of the remaining loss is label collision
rather than missing data. `text-padding` on `places_locality` grows from 3 to
11 between z5 and z12, and road and POI labels compete for the same space. Count
drawn labels against features present, per zoom, before tuning the padding.

## 2 — The track graph

The foundation for both route mode and measure mode.

**Nodes** are the vertices of every track in scope.

**Along-track edges** join consecutive vertices of one track. The weight is
**time**, not distance: `length ÷ local speed`.

**Cross-track links** are the hard part. A fire trail and the singletrack
beside it must stay separate: they have very different speeds, and welding them
into one line would give one wrong route and one wrong time. A link is made only
when all three tests pass:

1. **Near** — the two vertices are within about 15 m (GPS noise width).
2. **Angled** — the local bearings differ by more than about 30°. Two parallel
   trails fail this along their whole length.
3. **Brief** — the close approach lasts less than about 60 m on both tracks. A
   long shared corridor fails, except at its two ends.

One exception: a track that **ends** near another track always links. A spur
joins its parent, and an end point has no continuation to compare.

**Local speed** is a median over a 200 m window of the recorded points, with
stopped points removed. Fallbacks, in order: the track's `avg_speed`, then a
default for the ride mode.

### Where the graph is built

Client first, server later, with the engine behind one function so the swap is
invisible to the UI.

- **Now**: a Web Worker builds the graph over the tracks in view plus a margin
  of about 20 %. The build is debounced, and the result is cached by zoom tier
  and bounding box.
- **Later**: a persistent node/edge table in the Rust daemon and a
  `POST /api/route`, when the viewport limit starts to bite. Nav and the share
  page can then reuse it.

The hard parts of this feature are the junction tolerance and the behaviour when
no track connects two clicks. Both are learned faster on the client.

## 3 — Route mode (Plan module)

This grows the existing draw tool (`MapView.tsx`, the `drawMode` block). The
Snap magnet becomes **Follow**.

- **Snapping**: a click snaps to the nearest point on the nearest edge, not only
  to a vertex. Today's 14 px vertex search misses the middle of a long straight.
- **Legs**: the first click sets the start. Each later click runs A\* over the
  graph from the last node, minimising time, and splices the found path in. One
  click can add many kilometres of real trail.
- **No path**: the tool draws that leg as a dashed straight line and says
  "no track between these points — straight line, 4.2 km". The tool never
  refuses a click.
- **Undo**: Backspace removes the last *leg*, not the last vertex. A leg may
  hold several hundred spliced vertices.
- **Readout**: `6 legs · 84.3 km · 4 h 40 m` in the draw bar, and the leg under
  the cursor shows its own figures.
- Pan and zoom stay live while drawing, as today. Enter still opens Save plan,
  and the route still saves as a plan-class ride.

## 4 — Measure mode (Plan module)

A third tool beside Lasso and Route, with a ruler icon. It shares the whole
engine of section 2 and saves nothing.

- **Follow** (default) routes over the graph, so the answer is what you would
  really ride. **Direct** measures the straight line.
- **Chained legs**: click A, then B. A pill at the leg's middle shows
  `12.4 km · 48 m`. Keep clicking to add legs; the bar holds the running total.
  Escape clears; Backspace removes the last leg.
- **Time**: in Follow it is the sum of the edge weights, so recorded speeds —
  and with them gradient, surface and gates — are already inside the number. In
  Direct the bar carries a speed control, starting at your median moving speed
  for the current ride mode.
- **Keep as route** hands the measured line to route mode, where Enter saves it.

No server change, no new table, nothing stored.

## 5 — The phone shell on the share page

The page is already responsive through Tailwind `md:` breakpoints — on a phone
it is `flex-col`, map on the top half and list on the bottom half. This is a
re-fit, not a new shell. Desktop is untouched.

- **The map takes the whole screen.** The three segmented rows and two pills
  pinned top right, and the legend bottom left, all move into the Map tab. On a
  390 px phone that returns about a third of the map.
- **Level 1** is a tab bar at the foot: Tracks, Map, Trip, Me. Always visible,
  56 px plus the safe-area inset.
- **Level 2** is a sheet that rises over the lower half of the map when a tab is
  tapped. It has a drag handle. Tapping the live tab again lowers it, so a full
  map is always one tap away.
- **Level 3** is a page that slides in *inside* the sheet, with a back arrow in
  the sheet header. The sheet does not grow. A track's page holds its vote
  buttons, tally, comments, distance and grade. Tapping a track on the map opens
  that page directly.
- **Landscape** uses the same components: the tab bar becomes a 56 px rail on
  the left edge, the sheet becomes a 320 px panel beside it. One orientation
  query drives both.
- **The rollup stays on the map.** "32 liked · 17 vetoed · 10 undecided" is the
  one number always wanted, so it sits in a corner chip, not in the Trip tab.
- **Nothing new is stored.** The last open tab sits in `localStorage` beside the
  voter name.

Tab contents: Tracks — the sorted list and its sort control. Map — base map,
detail, colours, overlays, legend. Trip — the rollup, and the liked, vetoed and
undecided groups. Me — your name, your votes, the share link.

## Staging

1. **Stage 1a** — the phone shell on the share page. Self-contained, no daemon
   work, and it is what gets used in the field.
2. **Stage 1b** — the track graph, route mode and measure mode in the Plan
   module. One branch: measure mode is a read of the graph route mode builds.
3. **Stage 2** — the graph moves into the daemon when the viewport limit bites;
   the share page gets a Tools tab with measure and route.
4. **Stage 3** — re-tile the AU archive for early town names.

One branch per stage, per the repo workflow. No shortcut.

## Testing

- The phone shell: Playwright from `tools/ui-sweep`, at 390×844 and 844×390,
  asserting the map is full height with the sheet down and that level 3 does not
  resize the sheet. A hidden Browser pane freezes MapLibre, so drive it headless
  through Playwright.
- The junction rule: a fixture of two parallel tracks 8 m apart with different
  speeds must produce **no** link along the parallel run, and one link where a
  third track crosses them.
- Measure mode: a known ride re-measured Follow end to end must return its
  recorded distance and duration, within tolerance.

## Open questions

- Directional edge weights. Uphill and downhill are not the same time, and a
  recorded track carries both. Deferred: the median-speed model already absorbs
  gradient for the direction ridden.
- The A\* target is fastest time. Shortest distance may be wanted as a switch.
- The re-tile's `min_zoom` rule for localities, and whether Australia needs a
  different rule from the global Protomaps default.
