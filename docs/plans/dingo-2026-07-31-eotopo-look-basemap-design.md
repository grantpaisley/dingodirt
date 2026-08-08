# EOTopo-look basemap as configuration (2026-07-31)

## Goal

A fourth base-style option, "Dingo Topo". It reproduces the cartographic
design of ExplorOz's EOTopo 2026 — its zoom-dependent show/hide mix, its
label sizing, and its palette. Dingo's existing MapTiler vector tiles render
it. We do not use ExplorOz tiles or data. We use their publicly served style
document only as a design reference. We author our style against the
OpenMapTiles schema (their tile schema is entirely different, so we cannot
copy a layer definition verbatim).

## Why a translation works

Both EOTopo's web viewer and Dingo are MapLibre. EOTopo's style is a standard
MapLibre style JSON (229 layers) against a proprietary tile schema
(`landline_road`, `landuse_stateforest`, `contour_10m`, ...). We can
re-express every design decision we care about — the minzoom per feature
class, the width/size interpolation ramps, the colours, and the fonts. The
targets are the OpenMapTiles layers (`transportation`, `place`, `park`,
`landcover`, `landuse`, `water`, ...) plus MapTiler's contour and terrain-RGB
tilesets.

We carry over these signature decisions (the numbers come from their style):

- Tracks/paths from z10 (walk brown rgba(147,114,52), shared black, cycle by
  ref), with white casings, so trails read over the forest green; path labels
  from ~z9–12.
- Roads: primary z4, secondary z7, tertiary z8–9; red-toned; motorway yellow
  rgb(242,191,36) with a red outline; restricted access dimmed where the data
  allows.
- Place labels: italic, with aggressive growth ramps (city 14px@z5 →
  36px@z17, town 12→26); the locality density by rank. DIN Italic ≈ the
  nearest MapTiler italic glyphs.
- National park / state forest green tints from z5, park labels from z7.
- Contours from z9 (brown, 50% opacity), the 50 m index heavier from z11,
  labels z9/z15; hillshade beneath.

We do not carry over the outback-specific features with no OMT equivalent
(sand ridges, bores, tanks, marine hazards).

## Architecture: styles are configuration

The config format IS the MapLibre style spec — editable in Maputnik, with no
custom DSL.

```
web/public/styles/
  index.json          # manifest: [{ id, label, description, url }]
  dingo-topo.json     # first entry; future: dingo-4wd.json, dingo-enduro.json ...
```

- The base-style picker shows the three built-in MapTiler styles plus every
  manifest entry. A new community style = drop in a JSON + one manifest line;
  zero code.
- Style JSONs contain a `{MAPTILER_KEY}` placeholder in the source/glyph
  URLs. We substitute it at load time. Community styles never embed a key.
- `store.ts` persists the selected style id as a string. Unknown persisted
  ids fall back to `outdoor`. The `BaseStyle` union widens to string ids.
- `MapView.tsx` resolves an id to a MapTiler style URL, or to a fetched +
  substituted local style object, before `setStyle`. The overlay re-add
  machinery (`applyExtrasInner`) is unchanged — local styles are only another
  setStyle target.

## Verification

Bring the dev stack up. Screenshot Dingo vs the live EOTopo viewer at an
identical centre/zoom, for z≈8/10/12/14/16, at Palmdale and Kandos. Iterate
the ramps until the show/hide mix and the label sizes match. Deliver the
final side-by-sides as proof.

## Later

DingoNav (also MapLibre) consumes the same JSON unchanged. We curate
community variants under web/public/styles/.
