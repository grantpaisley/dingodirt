# Strava Heatmap Zoom Parity — Design

**Date:** 2026-07-28
**Branch:** `claude/strava-heatmap-zoom-parity-a1dbcf`
**Goal:** Make Dingo's two heat surfaces *behave* like Strava's surfaces across the
whole zoom range. This covers the line width, the glow falloff, the brightness
accumulation, and how each item changes with zoom. The colours stay Dingo's colours
(own = orange, other = red, plan = blue; the mirrored Strava heat keeps its
per-sport colourise). The goal is behaviour parity, not palette cloning.

## The two pairings

| Strava reference | Dingo surface | Renderer |
|---|---|---|
| "My heatmap" (personal, website) | Own-tracks heat | deck.gl `PathLayer`, additive blend, halo+core passes (`web/src/components/Map/heatmapLayers.ts`) |
| Global heatmap (website) | Mirrored Strava heat tiles | Raster tiles via `/api/heat`, server-side colourise (`MapView.tsx` raster layer + daemon) |

The split matters: Strava bakes the glow/width per zoom into the global-heat tile
PNGs on the server side. Thus that pairing is mostly colour-ramp/opacity fidelity
on our side. The own-tracks pairing is a hand-rolled renderer, and we must tune it
to match.

## Method: capture → measure → tune → verify

### 1. Reference capture (Strava touched once, then frozen)

- **Benches (two):**
  - *Personal bench* — the bounding box with Grant's highest ride-overlap density
    (we query it from the rides DB; likely Kandos). There the personal heat shows
    the full dim → glow → saturated ramp.
  - *Global bench* — a high-traffic corridor (e.g. Manly Dam / Sydney MTB trails),
    where the global heat is dense at every zoom.
- **Zoom ladder:** fixed rungs z6 → z15 (the global tiles stop at z15; the
  personal ladder extends to z16/17 if Strava serves them). Coordinates + a zoom
  number set the viewports, so the Dingo captures use identical framing.
- **Capture mechanism:** drive Grant's logged-in Chrome session (read-only:
  navigate, zoom, screenshot). Together with the screenshots, read the network log
  to collect the raw heat tile PNGs that the page fetched. These PNGs are
  tile-grid-aligned ground truth, free of basemap contamination. The fallback, if
  the UI stepping is brittle: URL-fragment navigation (Strava encodes
  lat/lng/zoom in the URL).
- **Dingo captures:** the same ladders in the dev preview. Solo one layer at a
  time, use a dark neutral basemap, and use the same viewport size and DPR.
- **Storage:** `~/Desktop/Projects/Dingo-data/bench/<surface>/<zoom>/…` with a
  manifest JSON (viewport, zoom, timestamp, DPR). The Strava captures never enter
  the repo.

### 2. Comparator + metrics

A standalone comparator page shows one row per zoom rung — Strava | Dingo | diff,
with a blink toggle. Measurements run on the raw tiles where possible. The
fallback is screenshot-based measurement with dark-basemap subtraction (for the
personal heat, if we cannot capture its tiles cleanly).

Three metrics, each mapped to a knob:

1. **Stroke width profile** — intensity cross-sections perpendicular to the
   tracks: the core width, the halo width, and the falloff shape, per zoom. This
   metric drives `PASS_WIDTHS` and the pixel clamps as zoom curves.
2. **Brightness distribution** — a per-zoom intensity histogram/CDF. This metric
   drives the per-pass alphas. It also shows where Strava's server-side
   normalization diverges from our fixed-alpha additive blend.
3. **Colour ramp** (mirrored layer only) — the Strava served pixel value → our
   colourise output. This confirms that we do not distort their baked-in
   dynamics.

Converged = the per-zoom curves overlap within tolerance AND the blink test
passes. Grant is the final judge.

### 3. Tuning loop

Diagnose → change → re-capture **Dingo only** → re-measure → repeat. The
references are frozen after the single capture pass.

Code touch points:

- `web/src/components/Map/heatmapLayers.ts` — the main target. `PASS_WIDTHS`
  becomes zoom-informed curves. We retune the per-pass alphas. We possibly add a
  third pass, if Strava's falloff needs a smoother gradient. The `zoomScaling`
  slider survives. We redefine its `1` endpoint as "measured Strava behaviour",
  and it becomes the default.
- The mirrored layer — the raster opacity/resampling in `MapView.tsx`; the daemon
  colourise curve only if metric 3 shows distortion.
- The intensity/width sliders remain user multipliers on the matched baseline.

**Gate:** metric 2 can show that Strava's per-zoom histogram equalization is
unreachable with fixed-alpha additive blending. If it does, STOP. Present costed
options (the best tune in the current renderer vs. a render-to-texture
normalization pass) before any change to the renderer architecture.

### 4. Verification & deliverables

- The overfitting check: after convergence, spot-check 2–3 other locations/zooms.
  The fitted curves are functions of zoom, not per-place constants.
- The manifest records the DPR normalization; the comparator rescales before it
  diffs.
- Deliverables: this doc; the frozen capture set + manifest (in Dingo-data, not
  the repo); the comparator page; the code changes on this branch with the
  defaults re-baked; the final before/after blink evidence pack.
