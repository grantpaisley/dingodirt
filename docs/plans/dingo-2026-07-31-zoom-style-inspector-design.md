# Zoom indicator + style layers panel (2026-07-31)

## Goal

Make the style config (dingo-topo.json and future community styles) easy to
inspect and edit from inside the app:

- A zoom widget under the settings button: a current-zoom readout, with +/-
  buttons. The buttons snap between the zoom levels where the active style's
  detail changes. The widget derives the levels from the layer min/max zooms.
  It falls back to ±1 when the next threshold is more than 2 zooms away.
- A click on the readout opens a **non-modal** style-layers panel. The map
  stays interactive, so a step through the zoom levels shows layers as they
  appear and disappear in the list, live.

## Panel behaviour

- The panel lists layers in logical groups from the per-layer
  `metadata["dingo:group"]` (all 48 dingo-topo layers are tagged; untagged
  styles group by source-layer).
- The filter pill: "Visible here" (only layers drawn at the current zoom —
  the list gains and loses rows as the zoom crosses thresholds) vs
  "All layers" (rows out of range are dimmed). The "hidden" checkbox includes
  `visibility: none` layers.
- The view toggle: **Zoom** (editable min/max zoom steppers; 0/24 delete the
  key) vs **Style** (colour / width / dash / text size editors). MapLibre
  expressions render as a swatch/lo–hi summary with an "fx" badge, read-only
  — edit those in the JSON.
- The per-row eye icon: it forces the layer visible on the map (a
  visibility + zoom-range override). This is runtime-only — the app never
  stores it, and it restores the value from the draft on toggle-off or close.
- Edits mutate a **pristine draft** (the placeholder text, never the
  key-substituted style), and they apply to the live map immediately. Save
  PUTs the draft to the daemon. Revert refetches the file and re-applies the
  base style (styleReloadNonce bypasses MapView's same-id guard).
- Built-in MapTiler styles open read-only (inspect + eye preview only).

## Daemon

`GET/PUT /api/styles/{id}` (crates/daemon/src/routes/styles.rs). The route
resolves files through the manifest under the config `web_styles_path`
(`DINGO_WEB_STYLES_PATH`, default ./web/public/styles; missing → a 501 with a
hint). PUT validates: a 2 MB cap, JSON with version 8 + layers, id/filename
traversal guards, an atomic temp+rename write, and **key-leak guards**. A
style that used `{MAPTILER_KEY}` must keep it. The route rejects any body
that carries a literal maptiler `key=`. Thus the API key can never bake into
the community-shareable file. We add PUT to CORS; the global x-dingo-web
middleware gates the writes.

## Web wiring

- `mapRegistry.ts` — a module-level map handle (MapView registers it; the
  toolbar and the panel consume it). This replaces a prop per map operation.
- `mapStyles.ts` — the local style cache now keeps `{pristineText, pristine,
  resolved}` per id, with invalidate/update helpers and a cache-busted
  refetch.
- `useUiState` — `mapZoom` (quantised 0.1, deduped) + `styleReloadNonce`.
- `styleZoom.ts` (the snap derivation), `styleAttrs.ts` (per-type attribute
  tables + literal/expression helpers), `StyleLayersPanel.tsx`, and the
  ZoomWidget in `MapToolbar.tsx`.
