/* .dingoscheme schema — design-token vocabulary, defaults, validation.
   Compatibility rules (community longevity):
   - apps IGNORE unknown tokens and DEFAULT missing tokens
   - a scheme is never executable style JSON — values only
   - schemaVersion major mismatch → rejected at import with a plain message */

export const SCHEMA_VERSION = '1.0';

/* Token registry, grouped as the editor presents them. Types:
   color | number (min/max/step) | bool | select (opts).
   def:null on basemap colours = "inherit the base style's own value" — a scheme
   that doesn't touch a layer leaves the base look alone, which is what makes
   old schemes survive basemap upgrades. */
export const TOKEN_GROUPS = [
  { key: 'basemap', label: 'Basemap', tokens: {
    'basemap.base':          { type: 'select', opts: ['dark', 'light'], def: 'dark', label: 'Base flavour' },
    'basemap.background':    { type: 'color', def: null, label: 'Background' },
    'basemap.earth':         { type: 'color', def: null, label: 'Earth' },
    'basemap.park':          { type: 'color', def: null, label: 'Parks / bush' },
    'basemap.green':         { type: 'color', def: null, label: 'Urban green' },
    'basemap.water':         { type: 'color', def: null, label: 'Water' },
    'basemap.waterLine':     { type: 'color', def: null, label: 'Streams / rivers' },
    'basemap.buildings':     { type: 'color', def: null, label: 'Buildings' },
    'basemap.roadHighway':   { type: 'color', def: null, label: 'Highways' },
    'basemap.roadMajor':     { type: 'color', def: null, label: 'Major roads' },
    'basemap.roadMinor':     { type: 'color', def: null, label: 'Minor roads' },
    'basemap.roadTrack':     { type: 'color', def: null, label: 'Tracks / paths' },
    'basemap.trackDashed':   { type: 'bool', def: false, label: 'Dash tracks' },
    'basemap.labelText':     { type: 'color', def: null, label: 'Label text' },
    'basemap.labelHalo':     { type: 'color', def: null, label: 'Label halo' },
    'basemap.hillshade':     { type: 'bool', def: true, label: 'Hillshade' },
    'basemap.hillshadeShadow':   { type: 'color', def: '#54524a', label: 'Hillshade shadow' },
    'basemap.hillshadeStrength': { type: 'number', min: 0, max: 1, step: 0.05, def: 0.35, label: 'Hillshade strength' },
  } },
  { key: 'overlays', label: 'Overlays', tokens: {
    'overlays.heatOwn':      { type: 'color', def: '#ff7a00', label: 'Heat — own rides' },
    'overlays.heatPlan':     { type: 'color', def: '#3390ff', label: 'Heat — planned' },
    'overlays.heatOther':    { type: 'color', def: '#ff2d2d', label: 'Heat — others' },
    'overlays.heatOpacity':  { type: 'number', min: 0, max: 1, step: 0.05, def: 0.35, label: 'Heat opacity' },
    'overlays.route':        { type: 'color', def: '#4AA8FF', label: 'Selected track' },
    'overlays.routeWOut':    { type: 'number', min: 1, max: 14, step: 0.5, def: 6, label: 'Route width (overview)' },
    'overlays.routeWIn':     { type: 'number', min: 2, max: 24, step: 0.5, def: 11, label: 'Route width (riding)' },
    'overlays.caseMode':     { type: 'select', opts: ['auto', 'dark', 'white'], def: 'auto', label: 'Casing' },
    'overlays.done':         { type: 'color', def: '#7F8791', label: 'Travelled route' },
    'overlays.chevSize':     { type: 'number', min: 0, max: 30, step: 1, def: 15, label: 'Direction Vs size' },
    'overlays.chevGap':      { type: 'number', min: 30, max: 300, step: 10, def: 90, label: 'Direction Vs spacing' },
    'overlays.breadcrumb':   { type: 'color', def: '#9fb4c6', label: 'Breadcrumb trail' },
  } },
  { key: 'marks', label: 'Marks & alerts', tokens: {
    'marks.turn':     { type: 'color', def: '#42d7f5', label: 'Turn cue' },
    'marks.autoTurn': { type: 'color', def: '#ffb020', label: 'Auto-detected turn' },
    'marks.danger':   { type: 'color', def: '#f0c24b', label: 'Danger' },
    'marks.obstacle': { type: 'color', def: '#ef9f27', label: 'Obstacle' },
    'marks.gate':     { type: 'color', def: '#cfd6da', label: 'Gate' },
    'marks.creek':    { type: 'color', def: '#5dcaa5', label: 'Creek' },
    'marks.fuel':     { type: 'color', def: '#85b7eb', label: 'Fuel' },
    'marks.food':     { type: 'color', def: '#ed93b1', label: 'Pub / food' },
    'marks.lookout':  { type: 'color', def: '#afa9ec', label: 'Lookout' },
    'marks.camp':     { type: 'color', def: '#97c459', label: 'Camp' },
    'marks.banner':   { type: 'color', def: '#ff4545', label: 'Off-track banner' },
    'marks.flash':    { type: 'color', def: '#ffb020', label: 'Approach flash' },
  } },
  { key: 'hud', label: 'HUD & chrome', tokens: {
    'hud.bg':       { type: 'color', def: '#0e1216', label: 'App background' },
    'hud.panel':    { type: 'color', def: '#161c22', label: 'Panels' },
    'hud.text':     { type: 'color', def: '#e8eef4', label: 'Text' },
    'hud.dim':      { type: 'color', def: '#8fa0b0', label: 'Dim text' },
    'hud.accent':   { type: 'color', def: '#00e5ff', label: 'Button accent' },
    'hud.ok':       { type: 'color', def: '#38d178', label: 'OK / confirm' },
    'hud.warn':     { type: 'color', def: '#ffb020', label: 'Warning' },
    'hud.bad':      { type: 'color', def: '#ff4545', label: 'Bad / danger' },
    'hud.arrow':    { type: 'color', def: '#ffb020', label: 'Turn arrow' },
    'hud.arrowOp':  { type: 'number', min: 0.1, max: 1, step: 0.05, def: 0.55, label: 'Turn arrow opacity' },
  } },
];

/* flat key → def lookup */
export const TOKEN_DEFS = {};
for (const g of TOKEN_GROUPS) Object.assign(TOKEN_DEFS, g.tokens);

export function defaultTokens() {
  const t = {};
  for (const k in TOKEN_DEFS) if (TOKEN_DEFS[k].def != null) t[k] = TOKEN_DEFS[k].def;
  return t;
}

/* effective value: token if set, else registry default (null = inherit base) */
export function tok(scheme, key) {
  const v = scheme.tokens && scheme.tokens[key];
  return v == null ? TOKEN_DEFS[key] && TOKEN_DEFS[key].def : v;
}

export function newScheme(name, author) {
  return { name: name || 'Untitled scheme', author: author || '', version: 1,
    schemaVersion: SCHEMA_VERSION, tokens: defaultTokens() };
}

const COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/* Validate + normalise an imported scheme.json object.
   Throws with a plain message on rejection (bad shape, major version mismatch).
   Unknown tokens are kept (round-trip: a newer app's tokens survive a remix in
   an older Studio) but flagged in .unknown for the UI. Known tokens with the
   wrong type are dropped — a bad value must never brick Nav mid-ride. */
export function validateScheme(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Not a scheme — bad JSON');
  const sv = String(obj.schemaVersion || '');
  const major = parseInt(sv, 10);
  if (!major || isNaN(major)) throw new Error('Missing schemaVersion — not a .dingoscheme');
  if (major !== parseInt(SCHEMA_VERSION, 10))
    throw new Error(`Scheme needs schema v${major} — this app speaks v${SCHEMA_VERSION}. Update the app to use it.`);
  const out = { name: String(obj.name || 'Unnamed scheme').slice(0, 60),
    author: String(obj.author || '').slice(0, 60),
    version: Number(obj.version) || 1, schemaVersion: sv, tokens: {}, unknown: [] };
  const src = obj.tokens && typeof obj.tokens === 'object' ? obj.tokens : {};
  for (const [k, v] of Object.entries(src)) {
    const def = TOKEN_DEFS[k];
    if (!def) { out.tokens[k] = v; out.unknown.push(k); continue; } // ignore-unknown: carried, unused
    if (def.type === 'color' && (typeof v !== 'string' || !COLOR_RE.test(v))) continue;
    if (def.type === 'number' && (typeof v !== 'number' || !isFinite(v))) continue;
    if (def.type === 'bool' && typeof v !== 'boolean') continue;
    if (def.type === 'select' && !def.opts.includes(v)) continue;
    out.tokens[k] = def.type === 'number'
      ? Math.max(def.min, Math.min(def.max, v)) : v;
  }
  return out;
}
