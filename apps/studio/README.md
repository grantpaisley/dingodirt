# Dingo Studio

Dingo Studio is the community scheme editor for the Dingo family. Design
complete look-and-feel "schemes" for DingoNav and Dingo Plan. Test-drive
them at speed. Share them as `.dingoscheme` packs. Design doc:
`Dingo/Docs/plans/2026-08-02-dingo-studio-design.md`.

Studio is a static PWA in the DingoNav mould: MapLibre GL + PMTiles,
vendored libraries, no backend, no build step. End-state URL:
`studio.dingodirt.com`.

## Run

```bash
node serve.js          # http://localhost:8138
node --test 'tests/*.test.mjs'
```

## Presets

`schemes/`, `behaviors/`, `js/applier-nav.js`, and `js/scheme.js` are
**symlinks into `core/`**. The monorepo holds exactly one copy of each, and
each app links to it. Edit them at `core/schemes/`, `core/behaviors/`, and
`core/appliers/`. There is nothing to sync and nothing to copy.

This design replaced a cross-repo workflow that kept three vendored copies
aligned through a PAT. `tests/no-stray-presets.test.mjs` at the repo root
fails if an app gets a local copy again.

Symlinks do not stay on a static host. Because of this, deploys run
`tools/assemble-app.sh studio <out>`, which changes the symlinks into real
files. For Nav, the same script also adds a content hash of the presets to
the service-worker cache name. Because of this, offline riders get the
presets again when the presets change — and only then.

The translated appliers (Nav's inline copy, Plan's TS port) stay
hand-aligned. `core/appliers/applier-nav.js` is the canonical module form.
Nav's inline version stays a translation until Nav adopts native ES modules.

## Two faces, one deployment

- `/` — the editor. It has a left panel of grouped design tokens (basemap,
  overlays, marks & alerts, HUD & chrome), with a ☀ Day / ☾ Night mode
  (night edits write a partial overlay carried inside the scheme). The
  centre is a live preview with **Nav mode**, **Plan mode**, and
  **Multi-view** framing, plus viewport chips. The bottom is a test-drive
  bar (play, scrubber, speed multiplier, off-track simulation, mute).
- `/#demo` — the public showcase. It auto-plays the bundled Palm Dale
  sample ride with the default scheme, and it has no editing UI. It
  replaces DingoNav's built-in demo mode. It takes `?scheme=<url>` and
  `&mode=night`.

**Multi-view** (Viewport → Multi-view, or #demo): one replay engine
broadcasts to N simultaneous viewports. The viewports are portrait /
landscape / square, and you can add and remove them. Each viewport is a
full independent Nav render with its own auto-zoom and HUD scale. Each
viewport has a scheme dropdown (the default is the scheme that you edit).
This turns the demo into an A/B comparison rig: remix vs original, in
motion. A user pan/zoom in one viewport drives all viewports (same spot,
different schemes). The dot button of any view re-follows the ride.

**Packs**: Import accepts `.dingonav`. The heatmap and the longest track of
the pack replace the bundled sample as the preview data. Because of this, a
pack author tunes a scheme against the terrain that the pack covers. A pack
that carries a scheme opens with that scheme applied. *Export pack* saves
the scheme back in two ways: **embedded** as `scheme.json` inside the zip
(self-contained offline) and, optionally, **referenced** in `bundle.json`
(`"scheme": { "name", "url"? }`) so apps can offer updates. Nav's importer
offers the pack's scheme one time per pack.

**Plan styles** (the second workspace in the top bar): the style-layers
inspector that moved out of Dingo Plan. It edits Plan's local MapLibre
styles (dingo-topo etc.) on Studio's own MapTiler preview. It has a layer
list with a zoom gantt + solo + flash, literal attrs, zoom-ramp formulas,
style-wide palette recolours, auto night palettes, and dingo:overlays heat
colours. It saves the pristine JSON back through the Dingo daemon
(`/api/styles`, key-leak guards intact). It needs the daemon; without the
daemon, it opens read-only.

## The `.dingoscheme` pack

A `.dingoscheme` pack is a zip. It holds `scheme.json` (tokens +
`name`/`author`/`version`/`schemaVersion`) and `preview.png` (captured
automatically on export). Three rules keep old schemes in operation
forever: apps **ignore unknown tokens**, apps **default missing tokens**,
and apps reject a scheme only on a **major schemaVersion mismatch**. Tokens
are values, never executable style JSON.

Install by URL on any app: `?scheme=<url>[,<url>…]`. Nav/Plan fetch the
scheme and apply it. Studio opens it for editing (the remix flow).

## Layout

```
index.html        editor + #demo shell (markup, CSS incl. NavView chrome)
js/scheme.js      -> core/appliers/scheme.js (symlink) token registry,
                  defaults, validation (schemaVersion 1.0)
js/applier-nav.js -> core/appliers/applier-nav.js (symlink)
                  applyScheme(tokens, baseLayers) — the shared token applier
js/geom.js        Nav's geometry/track/heatmap processing (ported)
js/cues.js        Nav's cue engine (ported) — real turn cues for test-drive
js/replay.js      pure replay engine: track in → fixes out (play/pause/seek/rate)
js/navview.js     one full independent Nav render per viewport (map + chrome +
                  onFix port: off-track, dir votes, beeps, HUD, auto-zoom)
js/demogrid.js    multi-view grid: N NavViews on one engine, per-view schemes
js/playback.js    shared playback-bar wiring (editor test-drive + #demo)
js/styleattrs.js  style attribute/palette/ramp/night vocabulary (from Plan)
js/styleinspector.js  Plan-styles workspace: layer editor + daemon save
js/editor.js      token panel, library (IndexedDB), scheme + pack import/export
js/main.js        boot: editor or #demo; workspace switch
basemap/          central-coast.pmtiles + hillshade + fonts + sprites + layer files
sample-data/      Palm Dale loop GPX + heatmap GeoJSON
schemes/          -> core/schemes (symlink) — canonical preset pairs
behaviors/        -> core/behaviors (symlink)
tests/            schema/applier-contract/replay tests (node --test)
```

## Appliers

`core/appliers/applier-nav.js` is the **canonical** applier in module form.
`core/appliers/scheme.js` holds the token registry that the applier
applies. Studio reaches both through symlinks in `js/`, so
`import './applier-nav.js'` continues to work unchanged in the browser.

Nav's inline applier stays a hand-aligned **translation**, not a vendored
copy. Nav is one file on purpose, and it has no module system yet (its
naming is different: `overlays.breadcrumb` → `colCrumb`, day tokens only).
Plan's `src/scheme/applierPlan.ts` is also a translation, in TS. A full
unification needs Nav on native ES modules, which is a separate programme.

The applier-contract test in `tests/scheme.test.mjs` pins the mapping, so
drift causes a loud failure.

## Not here yet

These items are not here yet: publish-to-dingodirt (a separate website
spec), `.dingonav` track import to preview your own rides, PWA offline
(manifest + service worker), and the GitHub Pages deployment to
`studio.dingodirt.com` (the repo is private for now).
