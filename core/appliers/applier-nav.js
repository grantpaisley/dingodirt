/* DingoNav token applier — THE deliberately shared piece (design 2026-08-02).
   applyScheme(scheme, baseLayers) maps design tokens onto Nav's base style
   lineage (basemap/layers.json) plus the knobs Nav reads at runtime.
   Canonical copy for the ES-module form: authored here first. DingoNav
   adopted it 2026-08-05 (PR #53) as a hand-translation into its inline
   single-file runtime — Nav's naming: `overlays.breadcrumb` lands on its
   colCrumb knob; day tokens only until Nav grows a day/night schema mode.
   Grow the vocabulary HERE first, then align the app translations by hand
   (sync-appliers.sh syncs the preset JSONs, not translated appliers).
   Keep it small, keep it boring — Studio preview breakage is low-stakes,
   Nav breaking on a ride is not.

   Returns { layers, hill, adv, marks, css } — each app consumes the pieces it
   understands. Missing tokens fall back to the base style / app defaults;
   unknown tokens were already filtered by the schema layer. */

import { tok } from './scheme.js';

/* basemap token → [layer ids…, paint prop]. Casing layers are left to the base
   style on purpose: v1 vocabulary stays coarse, the ignore/default rules make
   it safe to grow later. */
export const BASE_MAP = {
  'basemap.background': [['background'], 'background-color'],
  'basemap.earth':      [['earth'], 'fill-color'],
  'basemap.park':       [['landuse_park', 'landcover'], 'fill-color'],
  'basemap.green':      [['landuse_urban_green'], 'fill-color'],
  'basemap.water':      [['water'], 'fill-color'],
  'basemap.waterLine':  [['water_stream', 'water_river'], 'line-color'],
  'basemap.buildings':  [['buildings'], 'fill-color'],
  'basemap.roadHighway': [['roads_highway', 'roads_bridges_highway', 'roads_tunnels_highway'], 'line-color'],
  'basemap.roadMajor':  [['roads_major', 'roads_bridges_major', 'roads_tunnels_major',
    'roads_link', 'roads_bridges_link', 'roads_tunnels_link'], 'line-color'],
  'basemap.roadMinor':  [['roads_minor', 'roads_minor_service', 'roads_bridges_minor', 'roads_tunnels_minor'], 'line-color'],
  'basemap.roadTrack':  [['roads_other', 'roads_bridges_other', 'roads_tunnels_other'], 'line-color'],
};

/* per-layer paint overrides for the vector base — same shape as Nav's
   MAP_STYLES ov tables, so Nav can splice it straight into buildStyle() */
export function basePaintOverrides(scheme) {
  const ov = {};
  const put = (id, prop, val) => { (ov[id] = ov[id] || {})[prop] = val; };
  for (const [key, [ids, prop]] of Object.entries(BASE_MAP)) {
    const v = tok(scheme, key);
    if (v == null) continue;
    for (const id of ids) put(id, prop, v);
  }
  if (tok(scheme, 'basemap.trackDashed'))
    put('roads_other', 'line-dasharray', [2.5, 1.6]);
  const lt = tok(scheme, 'basemap.labelText'), lh = tok(scheme, 'basemap.labelHalo');
  if (lt != null || lh != null) {
    ov.__labels = {}; // sentinel: applies to every symbol layer
    if (lt != null) ov.__labels['text-color'] = lt;
    if (lh != null) ov.__labels['text-halo-color'] = lh;
  }
  return ov;
}

/* apply the override table to a base layers array (pure — returns a copy) */
export function applyBaseOverrides(layersArr, ov) {
  const labels = ov.__labels;
  return layersArr.map(l => {
    let patch = ov[l.id];
    if (labels && l.type === 'symbol') patch = { ...labels, ...patch };
    return patch ? { ...l, paint: { ...l.paint, ...patch } } : l;
  });
}

/* hillshade layer paint (null = scheme turned it off) */
export function hillPaint(scheme) {
  if (!tok(scheme, 'basemap.hillshade')) return null;
  return { 'hillshade-exaggeration': tok(scheme, 'basemap.hillshadeStrength'),
    'hillshade-shadow-color': tok(scheme, 'basemap.hillshadeShadow'),
    'hillshade-highlight-color': '#ffffff' };
}

/* overlay tokens → Nav's ADV knob names (S.set.adv in Nav; NavView opts here) */
export function advOverrides(scheme) {
  return {
    colOwn: tok(scheme, 'overlays.heatOwn'), colPlan: tok(scheme, 'overlays.heatPlan'),
    colOther: tok(scheme, 'overlays.heatOther'), heatOp: tok(scheme, 'overlays.heatOpacity'),
    colRoute: tok(scheme, 'overlays.route'),
    routeWOut: tok(scheme, 'overlays.routeWOut'), routeWIn: tok(scheme, 'overlays.routeWIn'),
    caseMode: tok(scheme, 'overlays.caseMode'), colDone: tok(scheme, 'overlays.done'),
    chevSize: tok(scheme, 'overlays.chevSize'), chevGap: tok(scheme, 'overlays.chevGap'),
    colBreadcrumb: tok(scheme, 'overlays.breadcrumb'),
    arrowFill: tok(scheme, 'hud.arrow'), arrowOp: tok(scheme, 'hud.arrowOp'),
  };
}

/* mark-kind colours (Nav's MARKS table) */
export function markColors(scheme) {
  return { turn: tok(scheme, 'marks.turn'), danger: tok(scheme, 'marks.danger'),
    obstacle: tok(scheme, 'marks.obstacle'), gate: tok(scheme, 'marks.gate'),
    creek: tok(scheme, 'marks.creek'), fuel: tok(scheme, 'marks.fuel'),
    food: tok(scheme, 'marks.food'), lookout: tok(scheme, 'marks.lookout'),
    camp: tok(scheme, 'marks.camp'), autoTurn: tok(scheme, 'marks.autoTurn') };
}

/* HUD & chrome → the CSS variables both Nav and Plan read */
export function cssVars(scheme) {
  return {
    '--bg': tok(scheme, 'hud.bg'), '--panel': tok(scheme, 'hud.panel'),
    '--fg': tok(scheme, 'hud.text'), '--dim': tok(scheme, 'hud.dim'),
    '--accent': tok(scheme, 'hud.accent'), '--ok': tok(scheme, 'hud.ok'),
    '--warn': tok(scheme, 'hud.warn'), '--bad': tok(scheme, 'hud.bad'),
    '--own': tok(scheme, 'overlays.heatOwn'), '--plan': tok(scheme, 'overlays.heatPlan'),
    '--other': tok(scheme, 'overlays.heatOther'),
    '--banner': tok(scheme, 'marks.banner'), '--flash': tok(scheme, 'marks.flash'),
    '--arrowFill': tok(scheme, 'hud.arrow'), '--arrowOp': String(tok(scheme, 'hud.arrowOp')),
  };
}

/* the whole contract in one call — what the applier-contract fixture test pins */
export function applyScheme(scheme, baseLayers) {
  const ov = basePaintOverrides(scheme);
  return {
    base: tok(scheme, 'basemap.base'),
    layers: baseLayers ? applyBaseOverrides(baseLayers, ov) : null,
    overrides: ov,
    hill: hillPaint(scheme),
    adv: advOverrides(scheme),
    marks: markColors(scheme),
    css: cssVars(scheme),
  };
}
