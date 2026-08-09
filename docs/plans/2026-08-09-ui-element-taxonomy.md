# UI element taxonomy

Date: 2026-08-09
Status: map stage done (all four inventories); stage-2 design language rules agreed (see "Stage 2" section). Next: stage 3, the shared library.
Scope: all four apps. The parts of the Site beyond the planner page (gallery, dashboard, publish) are conventional web pages and stay outside the taxonomy.

## Purpose

One category system for every UI element in the Dingo apps. Staged use:

1. **Map** (this document) — what exists, sorted into categories.
2. **Design language** — rules per category, so the same control looks and acts the same in all apps.
3. **Shared library** — extract the shared core into `core/`.

## The five roles

Sort axis: **role first, region second**. A widget can hold more than one role; record each role separately.

| Role | Definition | Test |
|---|---|---|
| **Surface** | A region of the screen that holds content. Gives space, borders, resize behavior. Does not act. Can be permanent (Plan's columns) or transient (Nav's slide-in panel). | "Is it a pane?" |
| **Display** | Presents data — on screen, by sound, or by touch. Does not change state by itself. (Nav's beeps and vibration are audio/haptic Displays.) | "Can I only perceive it?" |
| **Control** | Changes what you see or what the data is. | "Does clicking it change state?" |
| **Sync** | A *behavior*, not a widget. Links two surfaces through shared state. The source is a click, a sensor, or a mode flip. | "Does panel B move when I act in panel A?" |
| **Overlay** | Sits on top for a short task, then goes away. | "Is it modal or dismissable?" |

**Modes are not a role.** Navigation-follow, demo, layout-edit, glove, focus mode: a mode is a piece of shared state, the same as a selection. One Control flips it; many elements react.

## Plan inventory

| Element | Code | Role(s) | Region |
|---|---|---|---|
| List pane | `ListPane` | Surface | list |
| Places tree | `PlacesTree` | Display + Control (expand/collapse) + Sync source (select) | list |
| Filter pills | `FilterPanel`, `PillRow` | Control + Sync source (cuts list and map) | list |
| Stats bar | `StatsBar` | Display | list |
| Owner picker | `OwnerPicker` | Control | list |
| Map pane | `MapView` | Surface | map |
| Track/route/pack layers | `MapView` layers | Display + Sync source (click to select) | map |
| POI icons, heatmap | `poiIcons`, `heatmapLayers` | Display | map |
| Map toolbar | `MapToolbar` | Control (scheme, detail level, overlays) | map |
| Road-closure overlay | in `MapView` | Display, toggled by a Control | map |
| Profile pane | `GraphPane` | Surface | profile |
| Elevation curve | `GraphPane` | Display + Sync source (hover → map marker) | profile |
| Detail pane | `DetailPane`, `PackDetail` | Surface + Display | detail |
| Resize handles | `ResizeHandle` | Control (layout) | between surfaces |
| Import dialog | `ImportDialog` | Overlay | — |
| Export dialog | `ExportDialog` | Overlay | — |
| Settings panel | `SettingsPanel`, `StravaConnect`, `DingodirtConnect` | Overlay | — |

Observations:

- Almost every Sync behavior starts from a Display (a row, a track, a curve). The store (`store.ts`) carries the state; the other surfaces react.
- The map toolbar is the only Control cluster that lives *on* a surface. All other controls live in the list column or in overlays.

## Sync patterns

Every sync behavior reduces to four patterns. Each has one **source**, one piece of **shared state**, and one or more **reactions**.

| # | Pattern | Shared state | Plan examples |
|---|---|---|---|
| 1 | **Select** | Selected item id | List row click → map highlight + zoom. Map track click → list select + auto-scroll + detail fill. |
| 2 | **Filter** | Active filter set | Pills cut the list rows and the map layers at the same time. Owner picker does the same. |
| 3 | **Probe** | Transient hover position | Profile hover → point marker on the map. (Map hover → tooltip is display-only, not sync.) |
| 4 | **Camera** | Map view (center, zoom) | Select may move the camera. Detail-level toggle changes what the zoom shows. Focus mode dims non-selected tracks. |

**Scope note.** The four patterns cover *UI state* only (selection, filters, hover, camera). Changes to *domain data* — a vote, a rename, an edit — propagate by rule 1 below (one state, many readers) and need no pattern of their own. The planner's votes proved this: a vote recolours the list row and the map line through plain shared state.

Rules that fall out of the patterns:

1. **One state, many readers.** A sync never wires panel A to panel B directly. The source writes to the store; every surface reacts on its own. Plan already works this way.
2. **Select and Probe must not fight the user.** A select may move the camera once; a probe never moves it. (Selection-stability work, PR #11.)
3. **Filter beats Select.** If a filter removes the selected item, the selection clears. One answer, same in all apps.

## Nav inventory

Nav is a vanilla-JS PWA: one `index.html` (~8,200 lines), one full-screen map, no permanent columns. Its 266 DOM ids group into these elements:

| Element | Ids (sample) | Role(s) | Region |
|---|---|---|---|
| Map | `map` | Surface | map |
| Track panel (slide-in: list, search, tabs) | `panel`, `trackList`, `trackSearch` | Surface (transient) + Display + Sync source (select) | — |
| HUD (speed, distance, road, type) | `hudBox`, `hudSpeed`… | Display | map |
| Turn arrows + direction chip + lane beam | `cdArrowL/R`, `dirChip`, `indBeam` | Display | map |
| Off-track banner, toast, update bar | `banner`, `toast`, `updBar` | Display | map |
| Ride progress bar | `progress`, `progCanvas` | Display + Sync source (tap → jump map) | map |
| Zoom, fit, re-centre, north, orientation | `zoomIn/Out`, `fsBtn`, `orientCtl` | Control | map |
| START / mute / menu | `startBtn`, `muteBtn`, `menuBtn` | Control | map |
| Beeps, vibration, wake lock | (audio/haptic) | Display (non-visual) | — |
| Settings (tabbed), scheme + behavior pickers | `setTabs`, `schemaPicker` | Overlay | — |
| Dialogs: brief, mark picker, colour picker, generic | `briefDlg`, `markPicker`, `dlg` | Overlay | — |
| Startup wizard, training mode, intro | `suCard`, `trainCard` | Overlay | — |
| Layout-edit and glove-mode controls | `layoutEditBtn`, `gloveGrid` | Control (mode switch) | map |
| Varg BLE display + status | `vargPage`, `vargSoc` | Display + Overlay | external device |

In Plan, controls live in the list column. In Nav, **all controls float on the map**, because the map is the only permanent surface.

### Nav sync patterns

Same four patterns; the main source is a sensor, not a click.

| # | Pattern | Nav source | Nav reactions |
|---|---|---|---|
| 1 | **Select** | Tap a track in the panel; tap the progress bar | Map shows the track; START activates; brief fills. |
| 2 | **Filter** | Track search box; tab switch | Panel list cuts down. No map-side filter (one track at a time). |
| 3 | **Probe** | GPS fix (the sensor "hovers" for you) | HUD updates; nearest-point marker moves; reverse detection flips arrows. |
| 4 | **Camera** | GPS position + speed | Follow centres; auto-zoom by trail type; ◎ and ⛶ are manual Camera controls. |

### Verdict

The five roles hold — no new role was needed for Nav. Three amendments (already folded into the definitions above): Display *presents* (screen/sound/touch); Surfaces can be transient; Sync sources are click, sensor, or mode flip.

**Stage-2 finding — overlay budget.** Nav has ~13 overlay/mode element groups (wizard, training, intro, brief, four pickers, generic dialog, 7-tab settings, layout edit, glove, Varg). Plan has 3. The design language should set an overlay budget per app and a standard dialog/picker frame (Nav's `dlg` is already half of one).

## Studio inventory

Studio (461-line HTML, ~4.6k lines JS) inverts Plan's relationship with the map: **the map is not the tool, it is the subject**. The stage shows a live preview; every other element changes or tests what the stage shows.

| Element | Ids / code | Role(s) | Region |
|---|---|---|---|
| Stage (live preview) | `stage`, `navview.js` | Surface + Display | stage |
| Token panel (library + grouped tokens) | `library`, `tokens` | Surface + Display + Sync source (select token) | left |
| Style inspector | `inspector`, `styleinspector.js` | Surface + Control (edits the selected token) | right |
| Test-drive bar | `playBtn`, `scrub`, `rate`, `offBtn`, `muteBtn` | Control (simulated ride) | bottom |
| Topbar (name, author, new/import/export/save/pack) | `topbar`, `schemeTools` | Control + Overlay triggers | top |
| Day/Night seg, framing seg (Nav/Plan/Multi), viewport chips | `modeSeg`, `framingSeg`, `vpSeg` | Control (mode switch) | top |
| Detail-level control | `detail`, `detail.js` | Control (shared with Plan/Nav) | stage |
| Toast, scrub label | `toast`, `scrubLbl` | Display | — |
| Demo showcase (`/#demo`) | `demoFrame`, `demogrid.js` | Display (the whole app becomes one) | — |

Findings:

1. **The inspector is Plan's detail pane, renamed.** Same Select sync: pick a token on the left → the right pane fills → edits repaint the stage. No pattern change.
2. **The test-drive bar is a simulated sensor.** Play, scrub, and off-track simulation feed the same Probe and Camera syncs that real GPS feeds in Nav. No new source kind — a playback is a "sensor" source. Consequence: Nav and Studio should share the ride-follow code path, not just look-alike UI.

## Planner inventory (site `/p/` pages)

The published plan page (`app/p/[token]/PlanView.tsx`, 726 lines): list column + map, Yes/Maybe/No votes, verdict colours, voter-name dialog.

| Element | Code | Role(s) | Region |
|---|---|---|---|
| Track list column | left column | Surface | list |
| Plan header (name, description, voter name) | list header | Display | list |
| Sort select + name-change control | `select`, buttons | Control | list |
| Track rows (name, km, grade, verdict colour) | row divs | Display + Sync source (select) | list |
| Vote buttons (Yes / Maybe / No) per track and mark | row buttons | Control (writes domain data) | list |
| Marks section rows | mark divs | Display + Sync source | list |
| Map | `mapDiv` | Surface | map |
| Track lines coloured by verdict, mark pins | MapLibre layers | Display + Sync source (click) | map |
| Basemap switcher (Topo / Satellite) | top-right buttons | Control | map |
| Attribution box | bottom-left div | Display | map |
| Voter-name dialog | fixed modal | Overlay | — |

Findings:

1. **The roles hold on the fourth app with zero amendments.** The planner is a small Plan: list surface, map surface, Select sync, one overlay.
2. **Votes set the Sync scope.** A vote is a Control that writes domain data; both surfaces react through plain shared state. This produced the scope note in the Sync section: patterns cover UI state only.
3. **First responsive layout.** On a phone the two surfaces stack (map top half, list bottom half). Plan, Nav, and Studio never stack.

## Stage 2 — design language rules

Agreed 2026-08-09, one decision at a time. Each rule applies to every app.

### Rule 1 — Filter beats Select, with a memory

A filter (pill, search, owner) that hides the selected item **clears the selection**: the detail pane empties, the map highlight goes away. The store keeps the cleared selection. When a filter change makes the item visible again, the selection **returns by itself**. No toast, no undo button — the undo *is* the filter.

### Rule 2 — Two frames for every overlay

Every overlay is one of two frames. No cap on count; the budget is structural.

- **Dialog** — short task. Title, body, buttons at the bottom right. Modal.
- **Sheet** — list or picker. Header with title and close, scrolling body. Dismissable.

Nav's ~13 overlay groups keep their jobs but adopt these skeletons (Nav's generic `dlg` is the seed of the Dialog frame).

### Rule 3 — One chrome palette, two modes

The Site's ink-and-clay palette becomes the shared chrome standard for frames and, over time, all app chrome:

- **Dark**: ink surfaces (`#141109` / `#1d1910` / `#272216`), `#35301f` lines, bone text (`#ece4d2` / dim `#a89d83`), clay accent (`#d96f32`).
- **Light ("warm bone paper")**: bone surfaces (`#ece4d2`, raised `#f6f1e4`), `#cfc4a9` lines, ink text (`#141109` / dim `#6d6450`), same clay accent. Ink-on-bone contrast ≈ 13:1 — daylight-safe for Nav.

Schemes keep governing the *map content*; this palette governs the *chrome*. Plan's navy and Nav's slate retire as chrome palettes when their surfaces migrate.

### Rule 4 — Orientation decides docking

**Wider than tall → side. Taller than wide → bottom.** No device detection, no breakpoint list.

- Sheets: dock left on wide screens; rise from the bottom (drag handle, half-open state) on tall screens. In phone landscape the side sheet caps at min(320 px, 40% of screen width).
- Surfaces: portrait stacks them (map on top, list below — the planner's layout today); landscape and desktop sit them side by side (list left, map filling the rest). Profile and detail collapse into the list column on narrow screens.

The one spatial law: **the map takes the long axis; company docks on the short axis.**

### Rule 5 — Clay has two jobs

The clay accent marks **the selected item** and **the primary action** — nothing else. Active filters, toggles, and segs use neutral bone/ink treatments. Restraint is what keeps clay meaningful on a busy map.

### Rule 6 — Map controls are grouped stacks

Controls that float on the map share one skin: ink surface (`#1d1910`), hairline border (`#35301f`), 8 px radius. Related buttons join a vertical **stack** with hairline dividers; loose singles (mute, menu) float alone in the same skin. Every control reads one size token, `--control-size`: **40 px normal** (44 px tap area on touch), **56 px in glove mode**. Glove mode is one variable flip, and stacks, sheet rows, and dialog buttons all grow together.

### Rule 7 — One skin for all toggles

Pills (multi-select filters) and segmented switches (exclusive choices) are the same control in two arrangements:

- **Inactive**: hairline outline, dim bone text.
- **Active**: bone fill, ink text — unmissable, and it leaves clay alone (Rule 5).
- Pills are free-floating and fully rounded; segs are connected containers with hairline dividers — the horizontal cousin of the Rule 6 stack.

### Rule 8 — Selected rows wear a clay edge bar

The selected list row (tree row, vote row, sheet row) gets a **3 px clay bar on its left edge** plus a one-step raised background (`#272216`). Text stays bone. In nested trees the bar indents with the row. This is the list-side face of Rule 5's "selected item" job.

### Rule 9 — Barlow is the chrome typeface

All app chrome is set in **Barlow**, weights **400 and 500 only**, vendored as woff2 (~40 KB) so Nav stays offline. System stack is the fallback. **Big Shoulders** stays reserved for site headlines. Plan's Inter reference retires.

### Rule 10 — Readouts are bare text with a mode-aware halo

Readouts (Nav's HUD, Plan's stats bar, Studio's scrub label) are **big number + small dim unit + label**, tabular numerals, floating as bare text so the map shows through. Legibility comes from a halo that follows the mode: **bone text, ink halo** on dark schemes; **ink text, bone halo** on light schemes. The halo flips with the same switch as the chrome palette.

### Rule 11 — Two-tier status colours

One hue triad (green / amber / red), two intensities, six tokens:

- **Status** (muted — the planner's triad today): `#57a557` / `#c9a227` / `#8a4a42`. For passive information: verdict chips, badges, connection state.
- **Alert** (vivid — Nav's triad today): `#38d178` / `#ffb020` / `#ff4545`. For signals that must interrupt: off-track, GPS lost, battery critical.

Alerts additionally never rely on colour alone — they pair with sound or vibration (the multi-channel Display amendment). Nav's `--own`/`--other` rider-dot colours stay app-specific and outside this rule.

### Stage-3 note — shared ride-follow path

Nav's GPS follow and Studio's test-drive bar feed the same Probe/Camera syncs (a playback is a sensor source). When stage 3 extracts the shared core, the ride-follow state machine is one module with two sources — not two look-alike implementations.

## The same roles across the four apps

| Role | Shared across apps today | App-specific today |
|---|---|---|
| Surface | Map pane — all four apps draw the same basemap. List + detail columns — Plan and Nav. | Studio's editor canvas. Site's article pages. |
| Display | Track/route lines, POI icons, detail-level rendering (z12 floor) — same layer code everywhere. Elevation curve — Plan has it, Nav wants it. | Studio's scheme swatches. Site's vote tallies. |
| Control | Scheme switcher and 3-level detail toggle — already shared by design. Overlay toggles (road closures). | Nav's follow/course controls. Studio's color editors. |
| Sync | Select and Camera — Plan and Nav both need them. Filter — Plan today, Site gallery later. | Nav's GPS-follow is a Camera sync with the sensor as source, not a click. |
| Overlay | Import/Export, Settings, account connect flows — every app needs some. | Plan's publish-to-site dialog. |

Conclusions:

1. The shared core is **the map surface + its toolbar controls + the Select/Camera sync**. It appears in all four apps. First candidate for extraction in stage 3.
2. Nav's GPS-follow fits the existing patterns: no new category, only a new source type (sensor instead of click).
