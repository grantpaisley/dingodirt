# Map performance review — harness, baseline, and the first optimisation rounds

*2026-09-09. Companion to `2026-09-09-super-review-shared-modules-and-simplification.md`.
A performance review of the map rendering paths in Nav, Studio, Plan and the
site, a benchmark harness under `tools/perf/` that measures them, and the
changes that were made and measured against it. All numbers come from the
harness at the commits named in the tables; the code references are into
`44d5cd3` unless stated.*

## 0. Summary

- **The harness** (`tools/perf/bench.mjs`) drives Nav, Studio and Plan in
  headless Chromium against the committed Central Coast tile archive and
  records boot-to-idle, style build, zoom and pan time-to-idle, per-tile
  latency, an animated-zoom frame window, and a follow-mode window with frame
  times, long tasks, tile reloads and per-function timings. It reports the
  median of N fresh-context runs and diffs two labels. A `--ref` option serves
  Nav's file from any commit so an A/B runs through one harness build.
- **What the environment can and cannot see.** WebGL here is SwiftShader, a
  software rasteriser, so every frame costs 30 to 50 ms of GPU-substitute time
  and frame medians quantise to multiples of the 16.7 ms vsync. A CPU profile
  of Nav's follow window showed JavaScript idle for 13.7 of 15.6 sampled
  seconds: the long frames are rasteriser stalls, not script. The harness is
  therefore trusted for CPU-side and worker-side costs (boot, style rebuilds,
  tile pipeline, GeoJSON re-tiling, per-fix function time) and for A/B
  deltas, and not for absolute frame rates on a phone.
- **Nav** had the real problems: a second full `setStyle` at every boot in
  shared-archive mode, an auto-zoom that made every 800 ms camera ease a zoom
  change, a corridor prefetch competing with live tile serving on the same
  thread, a route re-projection of every track point every 1.5 s while
  riding, a progress strip redrawn on every animation frame with three
  `innerHTML` writes, and a riding-direction flip that re-sent the whole heat
  map. All six are fixed and measured in §4.
- **Studio** dropped `preserveDrawingBuffer` (a full-canvas copy per frame on
  mobile GPUs) by moving the preview capture into a render callback: tile
  latency fell 19 to 23 percent and the worst follow frame 20 percent.
- **Plan** no longer re-renders its 2,700-line map component on every
  animation frame; deck.gl still gets the exact camera per frame. Not
  measurable in this harness (no ride data can load without the daemon), so
  it is reported on its mechanism.
- **The site's** share page ran ten `queryRenderedFeatures` per mouse move and
  re-sent its whole track collection every 30 seconds whether or not anything
  changed; both are fixed, unmeasured here (the page needs the database).
- **The shared basemap** was checked and left alone: its 4,100-character label
  expression is dead weight for Australian tiles (no feature carries
  `script`, `pgf:name`, `name2` or `name3`) but costs a few property lookups
  on about fifty labelled features per tile, which no metric would show.

## 1. The harness

`tools/perf/` is its own package (Playwright only), like `tools/ui-sweep`.

```
cd tools/perf && npm install
cd apps/plan && VITE_BASE=/plan/ npm run build      # once, for the plan scenario
node tools/perf/bench.mjs --apps nav,studio,plan --runs 3 --label baseline
node tools/perf/bench.mjs --apps nav --runs 3 --label candidate
node tools/perf/bench.mjs --compare baseline candidate
node tools/perf/bench.mjs --apps nav --runs 3 --label main --ref main   # Nav from another commit
node tools/perf/bench.mjs --apps nav --runs 1 --profile                  # CPU profile of the follow window
node tools/perf/bench.mjs --apps navlong --runs 3                        # a 19,000-point ride
```

What it does:

- One static server (`serve.mjs`) serves the repo root with byte-range
  support, so Nav and Studio resolve their `core/` symlinks on disk; mounts
  Plan's `dist` at `/plan/`; serves Studio's committed `central-coast.pmtiles`
  and `hillshade.pmtiles` under the shared-archive names at `/tiles/`; and
  answers Nav's gitignored `bundle.json` from a generated file (the Palm Dale
  sample ride plus the sample heatmap).
- Every run is a fresh browser context: cold IndexedDB, cold tile cache,
  service workers blocked. `localStorage['dtiles-base']` points Nav and Plan at
  the local archive. Plan's daemon calls are answered 503 so react-query
  settles.
- `instrument.js` is injected before any app script: a requestAnimationFrame
  sampler, a `longtask` observer, listeners on every MapLibre map (tile
  loads by source, request-to-load latency per tile, style loads, renders,
  errors), and wrappers that time named app functions. For Nav those are
  global function declarations; for Studio the `NavView` prototype; Plan
  exposes `window.__dingoMap` in every build now, not only dev.
- Scenarios: **boot** to the first idle map; a **zoom sweep** of five jumps
  (z10, 12, 14, 16, 18), each on a different part of the archive so no step
  is served from the previous step's cache; a **pan sweep** of five 520 px
  steps at z15 into fresh tiles; an **animated ease** from z13 to z15 over
  three seconds; and a **follow window** of fifteen seconds with the app's
  own demo replay feeding fixes (Nav's `startDemo`, Studio's `#demo`
  engine), started after the route analysis and the corridor prefetch have
  finished so runs compare like for like.

## 2. What the static review found

Findings with `file:line` into `44d5cd3`. The harness targets the ones that
can be measured; the rest are recorded for the phone.

**Shared basemap** (`core/basemap/layers.json`, 69 layers; `layers-light.json`,
71). Thirteen symbol layers, twelve with a `text-field`; ten carry the same
4,100-character expression handling `name`, `name:en`, `pgf:name`, `script`,
`name2`, `name3`. A scan of sixteen tiles from the archive at z8 to z14 found
`name` fifty times, `name:en` eight, and none of the others, so the expression
always takes its last branch. Forty-eight of fifty layers have no `minzoom`;
minor roads are hidden by zero-width ramps instead. The applier passes
themselves are cheap: `applyBaseOverrides` is one shallow `map`
(`core/appliers/applier-nav.js:59-66`), `applyDetailBias` touches fourteen
listed layers (`core/appliers/detail.js`). The style-build cost is MapLibre
parsing 60 KB of expressions once per worker, not the JavaScript.

**Nav** (`apps/nav/index.html`).

- Style: `buildStyle` (2291-2367) is called by `setMapStyle` (2371),
  `reStyle` (2440) and the constructor; the built style never contains the
  twelve overlay sources, so every `setStyle` drops and re-adds all of them
  and `addOverlays` re-indexes every GeoJSON source including the whole pack
  heat. At boot, `Promise.all([basePending, hillPending]).then(reStyle)`
  (2621) ran unconditionally, and in shared-archive mode neither download
  runs, so every boot rebuilt the map once more. Measured: two `setStyle`
  calls per boot.
- Per fix (`onFix` 3900-3921): `renderMain` DOM writes, `navFix`,
  `refreshPosLayers` (two `setData`), `followCamera`; inside `navFix`,
  `refreshTrail` re-sends the entire breadcrumb, `refreshRouteFeatures`
  (debounced 1,500 ms, 4705) re-projected every track point through `toLL`
  (2975-2984) and rebuilt every route segment feature, and a direction-vote
  flip called `refreshMapData` (3947), which re-sends the heat, every other
  track, the selected track and the cue dots.
- Per frame: the `move` handler (2816-2819) redrew the progress strip on
  every frame, and because `followCamera` issues a 900 ms ease every 800 ms
  the map is always moving while riding, so `drawProgress` walked every track
  point, repainted its canvas and wrote three `innerHTML` strings at frame
  rate.
- Camera: `followCamera` (3144-3169) passed a continuous auto-zoom float on
  every ease, so each ease was a zoom change and MapLibre re-derived tile
  cover and symbol placement each frame.
- Tiles: `dtileServe` (1465-1486) does one IndexedDB transaction per tile on
  the main thread; `prefetchCorridor` (1520-1569) ran four workers doing
  decompress plus IndexedDB writes on the same thread while the map was
  live.
- Twelve GeoJSON sources and about twenty-seven overlay layers, no source
  options (`tolerance`, `buffer`, `maxzoom`), selection by `setData` rather
  than feature state. No map construction options beyond `maxPitch`.

**Studio** (`apps/studio/js/navview.js`). One `setStyle` path (404), otherwise
paint patches; `preserveDrawingBuffer: true` (303) for the preview capture;
the editor's `setToken` calls `setScheme` on every input event with no
debounce (`editor.js:72-82`); trail and guide `setData` per 10 Hz tick
(677, 582); `demogrid._wireSync` `jumpTo`s every other view on every move
frame of a drag (147-158).

**Plan** (`apps/plan/src/components/Map/MapView.tsx`). `map.on('move',
syncViewState)` (1671-1703) set React state every frame, re-rendering the
whole component; `useRides` is keyed on a zoom tier, so no per-frame
refetch. Hover runs `deck.pickObject` on every mousemove (1883-1887) and
`hoveredId` sits in `updateTriggers` for the rides and gradient layers
(980-983, 1030-1033), so a hover regenerates colour and width attributes for
every ride. `applyExtrasInner` (1428-1557) runs on every style load, every
hillshade or terrain toggle and every z11 crossing, serialising the style
for `firstSymbolLayerId` each time. Two WebGL contexts (deck's own canvas).

**Site** (`apps/site/app/p/[token]/PlanView.tsx`). A basemap or detail change
tears down and recreates the map (673-702); the 30 s poll and every window
focus re-sent the full track collection (359-386); five layers each had
delegated `mouseenter` and `mouseleave` listeners, ten
`queryRenderedFeatures` per mouse move (900-907); marks are DOM markers.

## 3. Baseline

Median of three runs at `44d5cd3`, headless Chromium with SwiftShader, DPR 1.
Nav at 390×780, Studio 900×720, Plan 1280×800. Nav's tile counts include
GeoJSON source tiles, which re-tile on every `setData`.

| Metric | Nav | Studio | Plan |
|---|---|---|---|
| boot → idle ms | 2,347 | 1,038 | 1,171 |
| `setStyle` calls at boot | 2 | 1 | 0 |
| zoom sweep ms (5 steps) | 11,296 | 3,483 | 3,701 |
| first step z10 ms / tiles | 6,620 / 204 | 618 / 27 | 964 / 4 |
| pan sweep ms (5 steps) | 4,363 | 3,224 | 3,204 |
| tile latency p50 / p95 ms | 74.5 / 2,237 | 17.3 / 307 | 57 / 238 |
| ease frame p50 / p95 ms | 33 / 417 | 50 / 133 | 33 / 50 |
| follow frame p50 / p95 ms | 33 / 283 | 50 / 83 | n/a |
| follow long tasks / ms in 15 s | 21 / 4,879 | 0 / 0 | n/a |
| follow tile reloads in 15 s | 2,235 | 401 | n/a |
| `onFix` mean ms | 1.0 | 0.3 | n/a |
| route analysis ms (Nav) | 3,018 | | |

The Nav follow-window CPU profile (500 µs sampling, one run): 13,757 ms idle
of 15,564 ms; the largest script entries were MapLibre's worker message
receive (73 ms), the style `set` and expression evaluation (about 100 ms
across entries), `drawProgress` (39 ms), and `postMessage` (38 ms). The
frame gaps are rasterisation.

## 4. Changes and measurements

### 4.1 Nav

Six changes in one commit (`0d97c7d`), plus a yield-rule correction after the
first measurement (`liveTiles` only, not `isMoving`: a following camera never
stops, and a prefetch that waited for it ran during the ride instead of
before it).

1. The trailing boot `reStyle` runs only when a hillshade archive actually
   arrived late.
2. `followCamera` quantises auto-zoom to 1/20 of a zoom level and drops it
   when it would not change the view.
3. `prefetchCorridor` yields while the map has tile requests in flight
   (`liveTiles`, counted in `dtileServe`).
4. The progress strip redraws at 10 Hz while the map moves, and its three
   readouts are written only when their markup changed (`htmlIf`).
5. `refreshRouteFeatures` reads one projected copy of the route per track
   (`routeLL`, invalidated when the projection origin changes) instead of
   re-projecting every point every 1.5 s.
6. A riding-direction flip refreshes the selected route sources only
   (`refreshSelTrack` plus `refreshRouteFeatures`), not the heat map and every
   other track.

Measured like for like: the same harness build served Nav's file from `main`
(`--ref main`) and from the working tree (`c9f4aac`), three fresh-context
runs each, medians. The follow window starts after the route analysis and the
corridor prefetch in both.

| Metric | `main` | after | change |
|---|---|---|---|
| boot → idle ms | 2,471 | 2,163 | −12% |
| `setStyle` calls at boot | 2 | 1 | −50% |
| zoom sweep ms (5 steps) | 13,324 | 10,624 | −20% |
| first step z10 ms | 8,293 | 5,712 | −31% |
| tile latency p95 ms | 3,877 | 2,312 | −40% |
| route analysis ms | 4,878 | 3,067 | −37% |
| `onFix` mean / p95 ms | 1.1 / 3.2 | 1.0 / 2.7 | −12% / −16% |
| `navFix` mean ms | 0.8 | 0.7 | −13% |
| `drawProgress` mean ms | 0.4 | 0.3 | −26% |
| `refreshMapData` calls in follow | 5 | 4 | −20% |
| follow frame p95 / max ms | 300 / 533 | 283 / 433 | −6% / −19% |
| follow long tasks, count / total ms | 19 / 5,062 | 30 / 6,314 | see note |
| pan sweep ms | 3,767 | 4,398 | see note |

Notes. The follow-window long-task count rose in every run (16 to 22 on
`main`, 27 to 32 after) while the longest task fell (412 to 1,119 ms on
`main`, 400 to 439 ms after) and the totals overlap (4.7 to 7.0 s against
6.0 to 7.4 s): the rasteriser stalls are chopped into more, shorter tasks,
and the frame p95 and maximum improved. The pan totals overlap run to run
(3.7 to 5.3 s against 4.0 to 4.8 s). Neither is a regression the harness can
attribute to a change; both are recorded rather than tuned away.

`drawProgress` calls did not fall in the harness (215 against 226 per
window) because the software rasteriser only reaches about ten renders per
second, so the old per-frame path and the new 10 Hz gate coincide; on a
phone at 60 fps the gate removes about fifty redraws per second.

The tile loads per zoom step are dominated by Nav's twelve GeoJSON sources,
each of which re-tiles on every camera change: on the z10 step, `selSurf` 57,
`slopeChev` 48, `heat` 43, `tracksOther` 37, `alerts` 37, and 17 each for
`friends`, `posAcc` and `pos`, against a handful of vector and DEM tiles.
That is the next lever (§5).

### 4.2 Studio

`f394baa`: `preserveDrawingBuffer: false`; `capturePng` asks for a frame and
reads the canvas inside MapLibre's `render` event; `exportScheme` awaits it.

| Metric (median of 3) | baseline | after | change |
|---|---|---|---|
| boot → idle ms | 1,038 | 980 | −6% |
| tile latency p50 ms | 17.3 | 13.4 | −23% |
| tile latency p95 ms | 307 | 249 | −19% |
| ease frame p95 ms | 133 | 117 | −12% |
| follow frame max ms | 167 | 133 | −20% |
| follow frame p50 / p95 ms | 50 / 83 | 50 / 83 | 0 |

On a tile-based mobile GPU the preserved buffer costs a full-canvas resolve
per frame; the software rasteriser here shows only the tail of that.

### 4.3 Plan

`f259fd1`: `syncViewState` still hands deck.gl the exact camera on every
`move`, but React state updates only when the camera crosses a 0.1-zoom or
0.01-degree step, with an exact flush on `moveend`. Everything React derives
from `viewState` is coarser than that (ride tier at integer zooms, half-zoom
POI and heat quanta, 0.1-degree chevron latitude). Harness delta: none
measurable (boot, zoom, pan and ease within ±3%, no ride data loaded). The
mechanism removes one React commit of the whole component per animation
frame; during a three-second ease that is about eighty commits reduced to
about twenty.

### 4.4 Site

Two changes in `PlanView.tsx`, unmeasured here because the page needs the
database: one `mousemove` hit test replaces ten delegated layer listeners,
and `applyItems` skips `setFeedback` and the track `setData` when the polled
payload is byte-identical to the last one applied. The site's
`package-lock.json` was also out of sync with `package.json` on `main`
(`npm ci` refused it: esbuild 0.28.2 missing), so it was regenerated.

### 4.5 Shared basemap: checked, not changed

Sixteen tiles from `central-coast.pmtiles` at z8, z10, z12 and z14 over four
points were decompressed and scanned for the keys the label expression
tests. `name` appeared fifty times, `name:en` eight, `min_zoom` sixty-four;
`pgf:name`, `script`, `name2`, `name3`, `script2` and `ref:en` never. The
expression could collapse to `["coalesce", ["get","name:en"], ["get","name"]]`
without changing a pixel on this archive, but its per-feature cost is a
handful of property lookups on about fifty labelled features per tile, below
anything the tile-latency metric resolves. Left as authored; it belongs in the
Protomaps lineage the layer files come from.

## 5. What remains, for the phone

Recorded from the static review, not measurable in this environment.

- **Nav**: `setStyle` still drops and re-adds every overlay source on a style
  change; include the overlay sources in the built style or use
  `transformStyle` so the diff keeps them. The chained 900 ms eases every
  800 ms could become one interpolation loop. `refreshTrail` re-sends the
  whole breadcrumb every 20 m; cap and append. The twelve GeoJSON sources
  re-tile on every `setData`; `pos` and `posAcc` are updated per fix and
  could be one source or a marker. `heat-halo` uses `line-blur: 4` with
  widths to 26 px, a fragment cost proportional to heat coverage. No
  `fadeDuration` or `maxTileCacheSize` is set.
- **Studio**: debounce `setToken` to one `setScheme` per animation frame;
  cap the trail; coalesce the multi-view `jumpTo` fan-out.
- **Plan**: throttle `pickObject` to one per frame and take `hoveredId` out of
  the rides and gradient `updateTriggers` (render the hovered ride as its own
  small layer); cache `firstSymbolLayerId`; consider interleaving deck as a
  MapLibre custom layer to drop the second WebGL context.
- **Site**: use `setStyle` on basemap and detail changes instead of
  recreating the map; marks as a symbol layer instead of DOM markers.
- **Harness**: a real-GPU run on a phone (Playwright over USB, or a
  `navlong` run on a laptop GPU) would give absolute frame rates; the CPU-side
  numbers here transfer.
