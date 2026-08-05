# Dingo Studio

Community scheme editor for the Dingo family — design complete look-and-feel
"schemes" for DingoNav and Dingo Plan, test-drive them at speed, and share them
as `.dingoscheme` packs. Design doc:
`Dingo/Docs/plans/2026-08-02-dingo-studio-design.md`.

Static PWA in the DingoNav mould: MapLibre GL + PMTiles, vendored libraries, no
backend, no build step. End-state URL: `studio.dingodirt.com`.

## Run

```bash
node serve.js          # http://localhost:8138
node --test 'tests/*.test.mjs'
```

## Preset sync

`schemes/` and `behaviors/` are canonical here and vendored into the apps.
`sync-appliers.sh` copies them to sibling checkouts by hand; the
`sync-appliers` workflow does it automatically — any push to `main` touching
the presets syncs DingoNav (with an SW cache bump) and Dingo via auto-merged
PRs. It needs a fine-grained PAT (Contents + Pull requests read/write on both
app repos) stored as the `SYNC_APPLIERS_TOKEN` Actions secret; the job fails
loudly until that exists. Translated appliers (Nav inline, Plan TS) stay
hand-aligned — see the header in `js/applier-nav.js`.

## Two faces, one deployment

- `/` — the editor. Left panel of grouped design tokens (basemap, overlays,
  marks & alerts, HUD & chrome) with a ☀ Day / ☾ Night mode (night edits write
  a partial overlay carried inside the scheme), centre live preview with
  **Nav mode**, **Plan mode**, and **Multi-view** framing plus viewport chips,
  bottom test-drive bar (play, scrubber, speed multiplier, off-track
  simulation, mute).
- `/#demo` — public showcase: auto-plays the bundled Palm Dale sample ride
  with the default scheme, no editing UI. Replaces DingoNav's built-in demo
  mode. Takes `?scheme=<url>` and `&mode=night`.

**Multi-view** (Viewport → Multi-view, or #demo): one replay engine
broadcasting to N simultaneous viewports — portrait / landscape / square,
addable and removable, each a full independent Nav render with its own
auto-zoom and HUD scale, and a per-view scheme dropdown (defaulting to the
scheme being edited) that turns the demo into an A/B comparison rig: remix vs
original, in motion. User pan/zoom in one viewport drives them all (same spot,
different schemes); any view's dot button re-follows the ride.

**Packs**: Import accepts `.dingonav` — the pack's heatmap and longest track
replace the bundled sample as the preview data, so a pack author tunes a
scheme against the terrain the pack covers; a pack carrying a scheme opens
with it applied. *Export pack* saves the scheme back both ways: **embedded**
as `scheme.json` inside the zip (self-contained offline) and, optionally,
**referenced** in `bundle.json` (`"scheme": { "name", "url"? }`) for apps to
offer updates. Nav's importer offers the pack's scheme once per pack.

**Plan styles** (second workspace in the top bar): the style-layers inspector
moved out of Dingo Plan. Edits Plan's local MapLibre styles (dingo-topo etc.)
on Studio's own MapTiler preview — layer list with zoom gantt + solo + flash,
literal attrs, zoom-ramp formulas, style-wide palette recolours, auto night
palettes, dingo:overlays heat colours — and saves the pristine JSON back
through the Dingo daemon (`/api/styles`, key-leak guards intact). Needs the
daemon running; opens read-only without it.

## The `.dingoscheme` pack

A zip containing `scheme.json` (tokens + `name`/`author`/`version`/
`schemaVersion`) and `preview.png` (auto-captured on export). Rules that keep
old schemes working forever: apps **ignore unknown tokens**, **default missing
tokens**, and reject only on **major schemaVersion mismatch**. Tokens are
values, never executable style JSON.

Install by URL on any app: `?scheme=<url>[,<url>…]` — Nav/Plan fetch and apply;
Studio opens it for editing (the remix flow).

## Layout

```
index.html        editor + #demo shell (markup, CSS incl. NavView chrome)
js/scheme.js      token registry, defaults, validation (schemaVersion 1.0)
js/applier-nav.js applyScheme(tokens, baseLayers) — the shared token applier
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
schemes/          bundled default scheme
tests/            schema/applier-contract/replay tests (node --test)
```

## Applier vendoring

`js/applier-nav.js` is currently the **canonical** applier — Nav and Plan don't
ship scheme support yet (rollout step 1). When they adopt it, the direction
reverses: each app owns its applier, and `sync-appliers.sh` copies them into
Studio (same convention as vendored `maplibre-gl.js`). The applier-contract
test in `tests/scheme.test.mjs` pins the mapping so drift fails loudly.

## Not here yet

Publish-to-dingodirt (separate website spec), `.dingonav` track import for
previewing your own rides, PWA offline (manifest + service worker), and the
GitHub Pages deployment to `studio.dingodirt.com` (repo is private for now).
