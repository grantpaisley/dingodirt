/* .dingobehavior schema — nav behaviour parameter vocabulary, defaults, validation.
   Sibling of scheme.js (visual tokens): a behaviour profile says how Nav *acts*
   (camera, guidance, off-route, rerouting, voice, HUD), a scheme says how it looks.
   Same compatibility contract:
   - apps IGNORE unknown params and DEFAULT missing params
   - a profile is values only — never executable code
   - schemaVersion major mismatch → rejected at import with a plain message
   Grounding: parameter set distilled from verified behaviour research on
   Google Maps / Waze / Locus Map / DMD2 (docs/2026-08-03-nav-behavior-framework.md). */

export const BEHAVIOR_SCHEMA_VERSION = '1.0';

/* Param registry, grouped as the editor presents them. Types:
   number (min/max/step) | bool | select (opts) | curve (≤8 [speedKmh, spanM]
   pairs, sorted by speed — the speed→view-span table behind auto-zoom).
   Defaults = Dingo Nav's current hardcoded behaviour (navview.js constants),
   so an empty profile changes nothing. */
export const PARAM_GROUPS = [
  { key: 'guidance', label: 'Guidance', params: {
    /* track       — follow a pre-made line, cues from authored marks (Dingo today, DMD2 GPX, Locus along-route)
       turnByTurn  — computed road routing with maneuvers (Google, Waze)
       routeGuidance — sequential point-chain guiding, simplified cues (Locus guidance)
       bearing     — straight-line bearing+distance to target, no line (Locus point guidance) */
    'guidance.mode':            { type: 'select', opts: ['track', 'turnByTurn', 'routeGuidance', 'bearing'], def: 'track', label: 'Guidance mode' },
    /* marks = authored cue marks on the track; shape = auto-derived from geometry
       at significant direction changes (Locus); router = maneuvers from a routing
       engine (Google/Waze); none = raw line, no instructions (DMD2 track default) */
    'guidance.cueSource':       { type: 'select', opts: ['marks', 'shape', 'router', 'none'], def: 'marks', label: 'Cue source' },
    'guidance.strictOrder':     { type: 'bool', def: false, label: 'Strict point order' },
    'guidance.laneGuidance':    { type: 'bool', def: false, label: 'Lane guidance' },
    'guidance.stackCues':       { type: 'bool', def: false, label: 'Stack close cues' },
    'guidance.waypointAdvance': { type: 'select', opts: ['auto', 'confirm'], def: 'auto', label: 'At waypoint' },
  } },
  { key: 'camera', label: 'Camera', params: {
    'camera.followMode':      { type: 'select', opts: ['free', 'northUp', 'courseUp'], def: 'courseUp', label: 'Follow mode' },
    'camera.pauseOnGesture':  { type: 'bool', def: true, label: 'Pause follow on gesture' },
    'camera.pitch':           { type: 'number', min: 0, max: 60, step: 5, def: 0, label: 'Pitch (3D tilt)' },
    'camera.autoZoom':        { type: 'bool', def: true, label: 'Auto-zoom' },
    /* cruise = Nav's grammar: hold the curve's max span, dive to its min span on
       approach; speed = interpolate the span from current speed (Locus/DMD2) */
    'camera.zoomMode':        { type: 'select', opts: ['cruise', 'speed'], def: 'cruise', label: 'Auto-zoom model' },
    'camera.zoomCurve':       { type: 'curve', def: [[0, 300], [30, 900], [70, 2500]], label: 'Speed → view span' },
    'camera.maxZoom':         { type: 'number', min: 10, max: 20, step: 0.5, def: 18, label: 'Max zoom cap' },
    'camera.approachZoom':    { type: 'bool', def: true, label: 'Dive on approach' },
    'camera.approachSecs':    { type: 'number', min: 5, max: 60, step: 1, def: 15, label: 'Approach window (s)' },
    'camera.approachMul':     { type: 'number', min: 1, max: 3, step: 0.1, def: 1.5, label: 'Approach multiplier' },
    'camera.approachFloorM':  { type: 'number', min: 50, max: 1000, step: 10, def: 250, label: 'Approach floor (m)' },
    'camera.lookAhead':       { type: 'number', min: 0, max: 0.4, step: 0.05, def: 0.15, label: 'Look-ahead offset' },
    'camera.easeMs':          { type: 'number', min: 200, max: 3000, step: 100, def: 900, label: 'Camera ease (ms)' },
    'camera.overviewWindowMin': { type: 'number', min: 0, max: 120, step: 5, def: 0, label: 'Overview window (min, 0=all)' },
  } },
  { key: 'position', label: 'Position', params: {
    'position.snapToRoute':        { type: 'bool', def: false, label: 'Snap to route' },
    'position.marker':             { type: 'select', opts: ['dart', 'chevron', 'arrow', 'dot'], def: 'dart', label: 'Position marker' },
    'position.breadcrumb':         { type: 'bool', def: true, label: 'Record breadcrumb' },
    'position.breadcrumbSpacingM': { type: 'number', min: 5, max: 100, step: 5, def: 20, label: 'Breadcrumb spacing (m)' },
  } },
  { key: 'offroute', label: 'Off-route', params: {
    'offroute.detectM':       { type: 'number', min: 10, max: 500, step: 5, def: 60, label: 'Off-route at (m)' },
    'offroute.rejoinM':       { type: 'number', min: 5, max: 400, step: 5, def: 40, label: 'Back on at (m)' },
    'offroute.alert':         { type: 'select', opts: ['beep', 'voice', 'vibrate', 'none'], def: 'beep', label: 'Off-route alert' },
    'offroute.repeatSecs':    { type: 'number', min: 5, max: 300, step: 5, def: 30, label: 'Alert repeat (s)' },
    'offroute.banner':        { type: 'bool', def: true, label: 'Off-route banner' },
    'offroute.guideLine':     { type: 'bool', def: false, label: 'Line to nearest point' },
    'offroute.maxDeviationM': { type: 'number', min: 0, max: 5000, step: 50, def: 0, label: 'Demote to bearing at (m, 0=never)' },
  } },
  { key: 'reroute', label: 'Rerouting', params: {
    /* none = never recalculate (alerts only); routePriority = rejoin the original
       line at the nearest point (Locus, and the Google/Waze silent-reroute shape);
       pointPriority = re-route to the next via point / finish (Locus) */
    'reroute.mode':       { type: 'select', opts: ['none', 'routePriority', 'pointPriority'], def: 'none', label: 'Recalculation' },
    'reroute.triggerM':   { type: 'number', min: 20, max: 1000, step: 10, def: 100, label: 'Trigger distance (m)' },
    'reroute.retrySecs':  { type: 'number', min: 5, max: 300, step: 5, def: 30, label: 'Retry interval (s)' },
    'reroute.confirm':    { type: 'bool', def: false, label: 'Ask before applying' },
  } },
  { key: 'cues', label: 'Cue timing', params: {
    'cues.farSecs':       { type: 'number', min: 5, max: 60, step: 1, def: 15, label: 'Far warn (s of travel)' },
    'cues.farMinM':       { type: 'number', min: 10, max: 500, step: 5, def: 60, label: 'Far warn min (m)' },
    'cues.farMaxM':       { type: 'number', min: 50, max: 2000, step: 10, def: 250, label: 'Far warn max (m)' },
    'cues.nearSecs':      { type: 'number', min: 1, max: 20, step: 1, def: 5, label: 'Near warn (s of travel)' },
    'cues.nearMinM':      { type: 'number', min: 5, max: 200, step: 5, def: 25, label: 'Near warn min (m)' },
    'cues.nearMaxM':      { type: 'number', min: 10, max: 500, step: 5, def: 70, label: 'Near warn max (m)' },
    'cues.dangerFarM':    { type: 'number', min: 50, max: 1000, step: 10, def: 200, label: 'Danger far (m)' },
    'cues.dangerNearM':   { type: 'number', min: 10, max: 300, step: 5, def: 50, label: 'Danger near (m)' },
    'cues.confirmAfterM': { type: 'number', min: 0, max: 200, step: 5, def: 30, label: 'Confirm passed after (m)' },
  } },
  { key: 'voice', label: 'Voice & sound', params: {
    /* beeps = Dingo's tone grammar; tts = spoken instructions;
       alertsOnly = speak alerts but not maneuvers (Google tier); silent */
    'voice.mode':        { type: 'select', opts: ['beeps', 'tts', 'alertsOnly', 'silent'], def: 'beeps', label: 'Audio mode' },
    'voice.density':     { type: 'select', opts: ['none', 'low', 'medium', 'high'], def: 'medium', label: 'Cue density' },
    'voice.streetNames': { type: 'bool', def: false, label: 'Say street names' },
  } },
  { key: 'hud', label: 'HUD', params: {
    'hud.speedo':        { type: 'bool', def: true, label: 'Speedometer' },
    'hud.speedLimit':    { type: 'bool', def: false, label: 'Speed limit sign' },
    'hud.speedAlert':    { type: 'select', opts: ['none', 'visual', 'audible', 'both'], def: 'none', label: 'Speeding alert' },
    'hud.speedAlertKmh': { type: 'number', min: 0, max: 30, step: 1, def: 8, label: 'Speeding margin (km/h)' },
    'hud.nextTurnPanel': { type: 'select', opts: ['full', 'small', 'off'], def: 'full', label: 'Next-turn panel' },
    'hud.etaPanel':      { type: 'bool', def: false, label: 'ETA / stats panel' },
    'hud.units':         { type: 'select', opts: ['metric', 'imperial'], def: 'metric', label: 'Units' },
    'hud.nightAuto':     { type: 'bool', def: false, label: 'Auto day/night' },
  } },
];

/* flat key → def lookup */
export const PARAM_DEFS = {};
for (const g of PARAM_GROUPS) Object.assign(PARAM_DEFS, g.params);

export function defaultParams() {
  const p = {};
  for (const k in PARAM_DEFS) p[k] = structuredClone(PARAM_DEFS[k].def);
  return p;
}

/* effective value: param if set, else registry default */
export function bv(profile, key) {
  const v = profile && profile.params && profile.params[key];
  return v == null ? PARAM_DEFS[key] && PARAM_DEFS[key].def : v;
}

export function newBehavior(name, author) {
  return { name: name || 'Untitled behaviour', author: author || '', version: 1,
    schemaVersion: BEHAVIOR_SCHEMA_VERSION, params: defaultParams() };
}

function validCurve(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 8) return null;
  const out = [];
  for (const p of v) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const [spd, span] = p;
    if (typeof spd !== 'number' || typeof span !== 'number' || !isFinite(spd) || !isFinite(span)) return null;
    if (spd < 0 || spd > 400 || span < 20 || span > 100000) return null;
    out.push([spd, span]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/* Cross-param sanity notes (documented app behaviour, not hard rejects):
   surfaced for the editor UI, never block import — bad combos must not brick Nav. */
export function behaviorWarnings(profile) {
  const w = [];
  const g = k => bv(profile, k);
  if (g('guidance.strictOrder') && g('reroute.mode') === 'pointPriority')
    w.push('Strict point order is defeated by point-priority recalculation (it skips missed points).');
  if (g('offroute.rejoinM') >= g('offroute.detectM'))
    w.push('Back-on distance should be smaller than off-route distance (hysteresis), or the banner will flap.');
  if (g('guidance.cueSource') === 'none' && g('hud.nextTurnPanel') !== 'off')
    w.push('No cue source: the next-turn panel will stay empty.');
  if (g('reroute.mode') !== 'none' && g('reroute.triggerM') < g('offroute.detectM'))
    w.push('Recalculation triggers before the off-route alert — the alert will never fire.');
  return w;
}

/* Validate + normalise an imported behaviour.json object.
   Mirrors validateScheme: throws on bad shape / major version mismatch;
   unknown params kept (round-trip) but flagged; wrong-typed values dropped —
   a bad value must never brick Nav mid-ride. */
export function validateBehavior(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Not a behaviour profile — bad JSON');
  const sv = String(obj.schemaVersion || '');
  const major = parseInt(sv, 10);
  if (!major || isNaN(major)) throw new Error('Missing schemaVersion — not a .dingobehavior');
  if (major !== parseInt(BEHAVIOR_SCHEMA_VERSION, 10))
    throw new Error(`Behaviour needs schema v${major} — this app speaks v${BEHAVIOR_SCHEMA_VERSION}. Update the app to use it.`);
  const out = { name: String(obj.name || 'Unnamed behaviour').slice(0, 60),
    author: String(obj.author || '').slice(0, 60),
    version: Number(obj.version) || 1, schemaVersion: sv, params: {}, unknown: [] };
  const src = obj.params && typeof obj.params === 'object' ? obj.params : {};
  for (const [k, v] of Object.entries(src)) {
    const def = PARAM_DEFS[k];
    if (!def) { out.params[k] = v; out.unknown.push(k); continue; } // ignore-unknown: carried, unused
    if (def.type === 'number') {
      if (typeof v !== 'number' || !isFinite(v)) continue;
      out.params[k] = Math.max(def.min, Math.min(def.max, v));
    } else if (def.type === 'bool') {
      if (typeof v !== 'boolean') continue;
      out.params[k] = v;
    } else if (def.type === 'select') {
      if (!def.opts.includes(v)) continue;
      out.params[k] = v;
    } else if (def.type === 'curve') {
      const c = validCurve(v);
      if (c) out.params[k] = c;
    }
  }
  return out;
}
