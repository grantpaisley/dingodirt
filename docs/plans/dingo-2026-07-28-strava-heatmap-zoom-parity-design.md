# Strava Heatmap Zoom Parity — Design

**Date:** 2026-07-28
**Branch:** `claude/strava-heatmap-zoom-parity-a1dbcf`
**Goal:** Make Dingo's two heat surfaces *behave* like Strava's across the whole zoom
range — line width, glow falloff, brightness accumulation, and how each changes with
zoom. Colours stay Dingo's (own = orange, other = red, plan = blue; mirrored Strava
heat keeps its per-sport colourise). Behaviour parity, not palette cloning.

## The two pairings

| Strava reference | Dingo surface | Renderer |
|---|---|---|
| "My heatmap" (personal, website) | Own-tracks heat | deck.gl `PathLayer`, additive blend, halo+core passes (`web/src/components/Map/heatmapLayers.ts`) |
| Global heatmap (website) | Mirrored Strava heat tiles | Raster tiles via `/api/heat`, server-side colourise (`MapView.tsx` raster layer + daemon) |

The split matters: Strava bakes glow/width per zoom into the global-heat tile PNGs
server-side, so that pairing is mostly colour-ramp/opacity fidelity on our side. The
own-tracks pairing is a hand-rolled renderer that must be tuned to match.

## Method: capture → measure → tune → verify

### 1. Reference capture (Strava touched once, then frozen)

- **Benches (two):**
  - *Personal bench* — the bounding box with Grant's highest ride-overlap density
    (queried from the rides DB; likely Kandos) so the personal heat shows the full
    dim → glow → saturated ramp.
  - *Global bench* — a high-traffic corridor (e.g. Manly Dam / Sydney MTB trails)
    where global heat is dense at every zoom.
- **Zoom ladder:** fixed rungs z6 → z15 (global tiles stop at z15; personal ladder
  extends to z16/17 if served). Viewports set by coordinates + zoom number so Dingo
  captures use identical framing.
- **Capture mechanism:** drive Grant's logged-in Chrome session (read-only:
  navigate, zoom, screenshot). Alongside screenshots, read the network log to
  collect the raw heat tile PNGs the page fetched — tile-grid-aligned ground truth,
  free of basemap contamination. Fallback if UI stepping is brittle: URL-fragment
  navigation (Strava encodes lat/lng/zoom in the URL).
- **Dingo captures:** same ladders in the dev preview, one layer solo'd at a time,
  dark neutral basemap, same viewport size and DPR.
- **Storage:** `~/Desktop/Projects/Dingo-data/bench/<surface>/<zoom>/…` with a
  manifest JSON (viewport, zoom, timestamp, DPR). Strava captures never enter the
  repo.

### 2. Comparator + metrics

A standalone comparator page: one row per zoom rung — Strava | Dingo | diff, with a
blink toggle. Measurements run on raw tiles where possible; screenshot-based with
dark-basemap subtraction as fallback (personal heat, if its tiles aren't cleanly
capturable).

Three metrics, each mapped to a knob:

1. **Stroke width profile** — intensity cross-sections perpendicular to tracks:
   core width, halo width, falloff shape, per zoom → drives `PASS_WIDTHS` and the
   pixel clamps as zoom curves.
2. **Brightness distribution** — per-zoom intensity histogram/CDF → drives per-pass
   alphas and exposes where Strava's server-side normalization diverges from our
   fixed-alpha additive blend.
3. **Colour ramp** (mirrored layer only) — Strava served pixel value → our
   colourise output, confirming we don't distort their baked-in dynamics.

Converged = per-zoom curves overlap within tolerance AND the blink test passes,
with Grant as final judge.

### 3. Tuning loop

Diagnose → change → re-capture **Dingo only** → re-measure → repeat. References are
frozen after the single capture pass.

Code touch points:

- `web/src/components/Map/heatmapLayers.ts` — main target. `PASS_WIDTHS` becomes
  zoom-informed curves; per-pass alphas retuned; possibly a third pass if Strava's
  falloff needs a smoother gradient. The `zoomScaling` slider survives; its `1`
  endpoint is redefined as "measured Strava behaviour" and becomes the default.
- Mirrored layer — raster opacity/resampling in `MapView.tsx`; daemon colourise
  curve only if metric 3 shows distortion.
- Intensity/width sliders remain user multipliers on the matched baseline.

**Gate:** if metric 2 shows Strava's per-zoom histogram equalization is unreachable
with fixed-alpha additive blending, STOP and present costed options (best tune
within current renderer vs. render-to-texture normalization pass) before any
renderer-architecture change.

### 4. Verification & deliverables

- Overfitting check: after convergence, spot-check 2–3 other locations/zooms —
  fitted curves are functions of zoom, not per-place constants.
- DPR normalization recorded in the manifest; comparator rescales before diffing.
- Deliverables: this doc; frozen capture set + manifest (in Dingo-data, not the
  repo); comparator page; code changes on this branch with defaults re-baked;
  final before/after blink evidence pack.
