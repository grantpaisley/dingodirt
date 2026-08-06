# Zoom indicator + style layers panel (2026-07-31)

## Goal

Make the style config (dingo-topo.json and future community styles) inspectable
and editable from inside the app:

- A zoom widget under the settings button: current zoom readout with +/- that
  snap between the zoom levels where the active style's detail changes
  (derived from layer min/max zooms; falls back to ±1 when the next threshold
  is more than 2 zooms away).
- Clicking the readout opens a **non-modal** style-layers panel — the map
  stays interactive so stepping zoom levels shows layers appearing and
  disappearing in the list live.

## Panel behaviour

- Layers listed in logical groups from per-layer `metadata["dingo:group"]`
  (all 48 dingo-topo layers tagged; untagged styles group by source-layer).
- Filter pill: "Visible here" (only layers drawn at the current zoom — the
  list gains/loses rows as thresholds are crossed) vs "All layers" (rows out
  of range are dimmed). "hidden" checkbox includes `visibility: none` layers.
- View toggle: **Zoom** (editable min/max zoom steppers; 0/24 delete the key)
  vs **Style** (colour / width / dash / text size editors; MapLibre
  expressions render as a swatch/lo–hi summary with an "fx" badge, read-only —
  edit those in the JSON).
- Per-row eye icon: forces the layer visible on the map (visibility +
  zoom-range override). Runtime-only — never stored, restored from the draft
  on toggle-off or close.
- Edits mutate a **pristine draft** (placeholder text, never the
  key-substituted style) and apply to the live map immediately. Save PUTs the
  draft to the daemon; Revert refetches the file and re-applies the base
  style (styleReloadNonce bypasses MapView's same-id guard).
- Built-in MapTiler styles open read-only (inspect + eye preview only).

## Daemon

`GET/PUT /api/styles/{id}` (crates/daemon/src/routes/styles.rs), resolving
files through the manifest under config `web_styles_path`
(`DINGO_WEB_STYLES_PATH`, default ./web/public/styles; missing → 501 with
hint). PUT validates: 2 MB cap, JSON with version 8 + layers, id/filename
traversal guards, atomic temp+rename write, and **key-leak guards** — a style
that used `{MAPTILER_KEY}` must keep it, and any body carrying a literal
maptiler `key=` is rejected, so the API key can never be baked into the
community-shareable file. PUT added to CORS; the global x-dingo-web middleware
gates writes.

## Web wiring

- `mapRegistry.ts` — module-level map handle (MapView registers; toolbar and
  panel consume) instead of a prop per map operation.
- `mapStyles.ts` — local style cache now keeps `{pristineText, pristine,
  resolved}` per id, with invalidate/update helpers and cache-busted refetch.
- `useUiState` — `mapZoom` (quantised 0.1, deduped) + `styleReloadNonce`.
- `styleZoom.ts` (snap derivation), `styleAttrs.ts` (per-type attribute
  tables + literal/expression helpers), `StyleLayersPanel.tsx`, ZoomWidget in
  `MapToolbar.tsx`.
