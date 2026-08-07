/* Detail-level zoom bias — when tracks and minor roads appear on the map.
   Canonical copy (same contract as applier-nav.js: authored here first,
   apps reach it through symlinks / direct import; Nav's single-file runtime
   carries a hand-translation — grow the behaviour HERE first).

   Out bush a track IS the road network and should read from a couple of zoom
   levels further out; in town the same rule would bury the suburbs in
   service-lane noise. Three levels, one pure transform over the shared
   Protomaps layer lineage (core/basemap/layers*.json):

     populated  bias  0  — the base style as authored (tracks fade in ~z14)
     regional   bias -1
     outback    bias -2  — tracks from z12

   -2 is not arbitrary: it is the DATA floor. Track features (kind=path/
   kind_detail=track, tiler min_zoom 13) first exist in z12 tiles of the
   Protomaps AU build — measured 2026-08-07 — so no style bias can show them
   earlier than z12. Pushing further needs a custom tile build.

   The transform shifts BOTH visibility mechanisms the base style uses:
   explicit layer minzoom, and the zoom-driven interpolate/step ramps whose
   rise from zero is what actually fades a road class in. Only the layers
   below are touched — highways and major roads already show from far out. */

export const DETAIL_LEVELS = ['populated', 'regional', 'outback'];
export const DETAIL_BIAS = { populated: 0, regional: -1, outback: -2 };

/* Tracks/paths, minor roads (+ their casing/bridge/tunnel variants) and the
   minor-road labels, by base-style layer id. Deliberately NOT pattern-matched:
   an explicit list keeps a future layer rename from silently biasing (or
   silently un-biasing) something. */
export const DETAIL_LAYER_IDS = new Set([
  'roads_other', 'roads_bridges_other', 'roads_bridges_other_casing',
  'roads_tunnels_other', 'roads_tunnels_other_casing',
  'roads_minor', 'roads_minor_casing',
  'roads_minor_service', 'roads_minor_service_casing',
  'roads_bridges_minor', 'roads_bridges_minor_casing',
  'roads_tunnels_minor', 'roads_tunnels_minor_casing',
  'roads_labels_minor',
]);

/* Shift every zoom stop of a ["interpolate", …, ["zoom"], z, v, …] or
   ["step", ["zoom"], …] expression by `bias`, recursing so a ramp nested in
   e.g. a "case" still shifts. Non-expression values pass through untouched. */
function shiftZoomStops(value, bias) {
  if (!Array.isArray(value)) return value;
  const isZoom = (x) => Array.isArray(x) && x.length === 1 && x[0] === 'zoom';
  if (value[0] === 'interpolate' && isZoom(value[2])) {
    // [op, curve, input, z1, v1, z2, v2, …] — zooms at 3, 5, 7, …
    return value.map((x, i) =>
      i >= 3 && (i - 3) % 2 === 0 ? Math.max(0, x + bias) : shiftZoomStops(x, bias));
  }
  if (value[0] === 'step' && isZoom(value[1])) {
    // [op, input, default, z1, v1, z2, v2, …] — zooms at 3, 5, 7, …
    return value.map((x, i) =>
      i >= 3 && (i - 3) % 2 === 0 ? Math.max(0, x + bias) : shiftZoomStops(x, bias));
  }
  return value.map((x) => shiftZoomStops(x, bias));
}

function shiftProps(obj, bias) {
  if (!obj) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = shiftZoomStops(v, bias);
  return out;
}

/* Apply a detail level to a base layers array (pure — returns a copy; the
   input array and its layers are never mutated). Unknown levels and
   'populated' return the input unchanged. */
export function applyDetailBias(layersArr, level) {
  const bias = DETAIL_BIAS[level] || 0;
  if (!bias) return layersArr;
  return layersArr.map((l) => {
    if (!DETAIL_LAYER_IDS.has(l.id)) return l;
    const out = { ...l };
    if (typeof out.minzoom === 'number') out.minzoom = Math.max(0, out.minzoom + bias);
    if (typeof out.maxzoom === 'number') out.maxzoom = Math.max(0, out.maxzoom + bias);
    if (out.paint) out.paint = shiftProps(out.paint, bias);
    if (out.layout) out.layout = shiftProps(out.layout, bias);
    return out;
  });
}
