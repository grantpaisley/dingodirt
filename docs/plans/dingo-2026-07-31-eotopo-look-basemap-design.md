# EOTopo-look basemap as configuration (2026-07-31)

## Goal

A fourth base-style option, "Dingo Topo", that reproduces the cartographic design of
ExplorOz's EOTopo 2026 — its zoom-dependent show/hide mix, label sizing, and palette —
rendered from Dingo's existing MapTiler vector tiles. We do not use ExplorOz tiles or
data; their publicly served style document is used only as a design reference, and our
style is authored against the OpenMapTiles schema (their tile schema is entirely
different, so no layer definitions can be copied verbatim).

## Why a translation works

Both EOTopo's web viewer and Dingo are MapLibre. EOTopo's style is a standard MapLibre
style JSON (229 layers) against a proprietary tile schema (`landline_road`,
`landuse_stateforest`, `contour_10m`, ...). Every design decision we care about —
minzoom per feature class, width/size interpolation ramps, colours, fonts — is
re-expressible against OpenMapTiles layers (`transportation`, `place`, `park`,
`landcover`, `landuse`, `water`, ...) plus MapTiler's contour and terrain-RGB tilesets.

Signature decisions being carried over (numbers from their style):

- Tracks/paths from z10 (walk brown rgba(147,114,52), shared black, cycle by ref),
  white casings so trails read over forest green; path labels from ~z9–12.
- Roads: primary z4, secondary z7, tertiary z8–9; red-toned; motorway yellow
  rgb(242,191,36) with red outline; restricted access dimmed where data allows.
- Place labels: italic, aggressive growth ramps (city 14px@z5 → 36px@z17, town
  12→26); locality density by rank. DIN Italic ≈ nearest MapTiler italic glyphs.
- National park / state forest green tints from z5, park labels from z7.
- Contours from z9 (brown, 50% opacity), 50 m index heavier from z11, labels z9/z15;
  hillshade beneath.

Not carried over: outback-specific features with no OMT equivalent (sand ridges,
bores, tanks, marine hazards).

## Architecture: styles are configuration

The config format IS the MapLibre style spec — editable in Maputnik, no custom DSL.

```
web/public/styles/
  index.json          # manifest: [{ id, label, description, url }]
  dingo-topo.json     # first entry; future: dingo-4wd.json, dingo-enduro.json ...
```

- The base-style picker shows the three built-in MapTiler styles plus every manifest
  entry. New community style = drop a JSON + one manifest line; zero code.
- Style JSONs contain a `{MAPTILER_KEY}` placeholder in source/glyph URLs,
  substituted at load time. Community styles never embed a key.
- `store.ts` persists the selected style id as a string; unknown persisted ids fall
  back to `outdoor`. The `BaseStyle` union widens to string ids.
- `MapView.tsx` resolves an id to either a MapTiler style URL or a fetched+substituted
  local style object before `setStyle`. Overlay re-add machinery (`applyExtrasInner`)
  is unchanged — local styles are just another setStyle target.

## Verification

Dev stack up; screenshot Dingo vs the live EOTopo viewer at identical centre/zoom for
z≈8/10/12/14/16 at Palmdale and Kandos; iterate ramps until the show/hide mix and
label sizes match; final side-by-sides delivered as proof.

## Later

DingoNav (also MapLibre) consumes the same JSON unchanged. Community variants curated
under web/public/styles/.
