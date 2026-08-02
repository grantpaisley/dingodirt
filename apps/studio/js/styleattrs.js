/* Style attribute vocabulary — ported verbatim from Dingo Plan's
   components/Map/styleAttrs.ts (the editor now lives in Studio; Plan keeps a
   trimmed read-side copy for rendering night/overlay theming).

   v1 editing rule: literal colour strings, numbers, and all-number arrays
   (dash patterns) are editable; anything that parses as a MapLibre expression
   (array with a string operator head) renders as a read-only summary with an
   "fx" badge — those are edited in the JSON. */

export const FONT_OPTIONS = [
  'Open Sans Regular', 'Open Sans Italic', 'Open Sans Bold',
  'Roboto Condensed Regular', 'Roboto Condensed Italic',
  'Noto Sans Regular', 'Noto Sans Italic', 'Noto Sans Bold',
];

/* Per-type opacity-ish paint props used for flashing a layer: [prop, "on"
   value when the layer doesn't define one]. */
export const FLASH_PROPS = {
  line: [['line-opacity', 1]],
  fill: [['fill-opacity', 1]],
  symbol: [['text-opacity', 1], ['icon-opacity', 1]],
  circle: [['circle-opacity', 1], ['circle-stroke-opacity', 1]],
  background: [['background-opacity', 1]],
  hillshade: [['hillshade-exaggeration', 0.5]],
  raster: [['raster-opacity', 1]],
};

export const ATTRS_BY_TYPE = {
  line: [
    { prop: 'line-color', location: 'paint', kind: 'color', label: 'colour' },
    { prop: 'line-width', location: 'paint', kind: 'number', label: 'width' },
    { prop: 'line-dasharray', location: 'paint', kind: 'dasharray', label: 'dash' },
    { prop: 'line-opacity', location: 'paint', kind: 'number', label: 'opacity' },
  ],
  fill: [
    { prop: 'fill-color', location: 'paint', kind: 'color', label: 'colour' },
    { prop: 'fill-outline-color', location: 'paint', kind: 'color', label: 'outline' },
    { prop: 'fill-opacity', location: 'paint', kind: 'number', label: 'opacity' },
  ],
  symbol: [
    { prop: 'text-color', location: 'paint', kind: 'color', label: 'colour' },
    { prop: 'text-halo-color', location: 'paint', kind: 'color', label: 'halo' },
    { prop: 'text-halo-width', location: 'paint', kind: 'number', label: 'halo width' },
    { prop: 'text-size', location: 'layout', kind: 'number', label: 'size' },
    { prop: 'text-font', location: 'layout', kind: 'font', label: 'font' },
  ],
  circle: [
    { prop: 'circle-color', location: 'paint', kind: 'color', label: 'colour' },
    { prop: 'circle-radius', location: 'paint', kind: 'number', label: 'radius' },
    { prop: 'circle-stroke-color', location: 'paint', kind: 'color', label: 'stroke' },
    { prop: 'circle-stroke-width', location: 'paint', kind: 'number', label: 'stroke width' },
  ],
  hillshade: [
    { prop: 'hillshade-exaggeration', location: 'paint', kind: 'number', label: 'strength' },
    { prop: 'hillshade-shadow-color', location: 'paint', kind: 'color', label: 'shadow' },
    { prop: 'hillshade-highlight-color', location: 'paint', kind: 'color', label: 'highlight' },
  ],
  background: [
    { prop: 'background-color', location: 'paint', kind: 'color', label: 'colour' },
    { prop: 'background-opacity', location: 'paint', kind: 'number', label: 'opacity' },
  ],
  raster: [
    { prop: 'raster-opacity', location: 'paint', kind: 'number', label: 'opacity' },
  ],
};

/* MapLibre expression: an array whose head is a string operator. A literal
   all-number array (dasharray) is NOT an expression. */
export function isExpression(v) {
  return Array.isArray(v) && typeof v[0] === 'string';
}

const NAMED_COLORS = { white: '#ffffff', black: '#000000' };

/* Parse a literal colour into hex + alpha. Returns null for expressions and
   formats we don't handle (hsl etc.) — those render swatch-only. */
export function parseColor(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s in NAMED_COLORS) return { hex: NAMED_COLORS[s], alpha: 1 };
  if (/^#[0-9a-f]{6}$/.test(s)) return { hex: s, alpha: 1 };
  if (/^#[0-9a-f]{3}$/.test(s)) {
    return { hex: `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`, alpha: 1 };
  }
  const m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) {
    const to2 = n => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0');
    return { hex: `#${to2(m[1])}${to2(m[2])}${to2(m[3])}`, alpha: m[4] !== undefined ? Number(m[4]) : 1 };
  }
  return null;
}

/* Re-emit an edited hex colour, preserving the original literal's alpha. */
export function withAlpha(hex, alpha) {
  if (alpha >= 1) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function literalColors(v, out = []) {
  if (typeof v === 'string' && parseColor(v)) out.push(v);
  else if (Array.isArray(v)) for (const item of v) literalColors(item, out);
  return out;
}

export function numberRange(v) {
  const nums = [];
  const walk = x => {
    if (typeof x === 'number') nums.push(x);
    else if (Array.isArray(x)) x.forEach(walk);
  };
  walk(v);
  if (!nums.length) return null;
  return [Math.min(...nums), Math.max(...nums)];
}

/* ---- Colour palette (allocations) ----
   A "colour allocation" is a base colour ignoring alpha; recolouring an
   allocation rewrites all usages while preserving each one's alpha. */

export function collectPalette(style) {
  const seen = new Set();
  const order = [];
  const add = hex => { if (!seen.has(hex)) { seen.add(hex); order.push(hex); } };
  const walk = v => {
    if (typeof v === 'string') {
      const p = parseColor(v);
      if (p) add(p.hex);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };
  for (const l of style.layers) { walk(l.paint); walk(l.layout); }
  const meta = style.metadata;
  walk(meta && meta['dingo:overlays']);
  const extras = meta && meta['dingo:palette'];
  if (Array.isArray(extras)) {
    for (const e of extras) {
      const p = parseColor(e);
      if (p) add(p.hex);
    }
  }
  return order;
}

/* Rewrite every usage of one allocation (base hex) to a new base colour,
   preserving each usage's alpha. Mutates the given (cloned) style. */
export function replaceColorGlobal(style, fromHex, toHex) {
  const conv = v => {
    if (typeof v === 'string') {
      const p = parseColor(v);
      if (p && p.hex === fromHex) return withAlpha(toHex, p.alpha);
      return v;
    }
    if (Array.isArray(v)) return v.map(conv);
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) v[k] = conv(v[k]);
      return v;
    }
    return v;
  };
  for (const l of style.layers) {
    if (l.paint) l.paint = conv(l.paint);
    if (l.layout) l.layout = conv(l.layout);
  }
  const meta = style.metadata;
  if (meta && Array.isArray(meta['dingo:palette'])) {
    meta['dingo:palette'] = meta['dingo:palette'].map(e => {
      const p = typeof e === 'string' ? parseColor(e) : null;
      return p && p.hex === fromHex ? toHex : e;
    });
  }
  if (meta && meta['dingo:overlays'] && typeof meta['dingo:overlays'] === 'object') {
    meta['dingo:overlays'] = conv(meta['dingo:overlays']);
  }
  // Recolouring a day allocation re-keys its night mapping entry
  if (meta && meta['dingo:night'] && typeof meta['dingo:night'] === 'object') {
    const night = meta['dingo:night'];
    if (fromHex in night && !(toHex in night)) {
      night[toHex] = night[fromHex];
      delete night[fromHex];
    }
  }
}

export function addPaletteColor(style, hex) {
  const meta = (style.metadata ??= {});
  const list = Array.isArray(meta['dingo:palette']) ? meta['dingo:palette'] : [];
  if (!list.includes(hex)) meta['dingo:palette'] = [...list, hex];
}

/* ---- Numeric zoom ramps (the width/size "formula") ---- */

export function parseZoomRamp(v) {
  if (!Array.isArray(v) || v[0] !== 'interpolate') return null;
  let base = 1;
  const interp = v[1];
  if (Array.isArray(interp)) {
    if (interp[0] === 'exponential' && typeof interp[1] === 'number') base = interp[1];
    else if (interp[0] !== 'linear') return null;
  } else return null;
  if (!Array.isArray(v[2]) || v[2][0] !== 'zoom') return null;
  const stops = [];
  for (let i = 3; i < v.length; i += 2) {
    if (typeof v[i] !== 'number' || typeof v[i + 1] !== 'number') return null;
    stops.push([v[i], v[i + 1]]);
  }
  return stops.length >= 2 ? { base, stops } : null;
}

export function buildZoomRamp(r) {
  const head = r.base === 1 ? ['linear'] : ['exponential', r.base];
  return ['interpolate', head, ['zoom'], ...r.stops.flat()];
}

export function evalZoomRamp(r, z) {
  const s = r.stops;
  if (z <= s[0][0]) return s[0][1];
  if (z >= s[s.length - 1][0]) return s[s.length - 1][1];
  for (let i = 0; i < s.length - 1; i++) {
    const [z0, v0] = s[i];
    const [z1, v1] = s[i + 1];
    if (z >= z0 && z <= z1) {
      const t = r.base === 1
        ? (z - z0) / (z1 - z0)
        : (Math.pow(r.base, z - z0) - 1) / (Math.pow(r.base, z1 - z0) - 1);
      return v0 + t * (v1 - v0);
    }
  }
  return s[0][1];
}

/* Hue/lightness sort so the palette reads as a spectrum. */
export function sortPalette(hexes) {
  const hsl = hex => {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [(h * 60 + 360) % 360, s, l];
  };
  return [...hexes].sort((a, b) => {
    const [ha, sa, la] = hsl(a);
    const [hb, sb, lb] = hsl(b);
    const greyA = sa < 0.12, greyB = sb < 0.12;
    if (greyA !== greyB) return greyA ? -1 : 1;
    if (greyA) return la - lb;
    return ha - hb || la - lb;
  });
}

/* ---- Day / night: a palette remap in metadata "dingo:night" ---- */

export function nightMapOf(style) {
  const m = style.metadata && style.metadata['dingo:night'];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === 'string' && parseColor(k) && parseColor(v)) {
      out[parseColor(k).hex] = parseColor(v).hex;
    }
  }
  return Object.keys(out).length ? out : null;
}

/* Starting night colour for a day colour: invert lightness (keep hue). */
export function autoNightColor(dayHex) {
  const r = parseInt(dayHex.slice(1, 3), 16) / 255;
  const g = parseInt(dayHex.slice(3, 5), 16) / 255;
  const b = parseInt(dayHex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0, s = 0;
  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  const nl = Math.min(0.9, Math.max(0.08, 1 - l));
  const ns = s * 0.8;
  const c = (1 - Math.abs(2 * nl - 1)) * ns;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m0 = nl - c / 2;
  let rr = 0, gg = 0, bb = 0;
  if (h < 60) [rr, gg, bb] = [c, x, 0];
  else if (h < 120) [rr, gg, bb] = [x, c, 0];
  else if (h < 180) [rr, gg, bb] = [0, c, x];
  else if (h < 240) [rr, gg, bb] = [0, x, c];
  else if (h < 300) [rr, gg, bb] = [x, 0, c];
  else [rr, gg, bb] = [c, 0, x];
  const to2 = v => Math.round((v + m0) * 255).toString(16).padStart(2, '0');
  return `#${to2(rr)}${to2(gg)}${to2(bb)}`;
}

export function applyNightMap(style, map) {
  for (const [day, night] of Object.entries(map)) {
    if (day !== night) replaceColorGlobal(style, day, night);
  }
}

/* ---- Overlay theming: metadata "dingo:overlays" ---- */
export const OVERLAY_KEYS = ['heatOwn', 'heatStrava', 'heatPlanned'];

export function overlaysOf(style) {
  const m = style.metadata && style.metadata['dingo:overlays'];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

export const DASH_PRESETS = [
  { label: 'solid', value: null },
  { label: '5 3', value: [5, 3] },
  { label: '2 2', value: [2, 2] },
  { label: '4 2', value: [4, 2] },
  { label: '1 2', value: [1, 2] },
  { label: '6 2 1 2', value: [6, 2, 1, 2] },
];

/* ---- Zoom snap levels (from Plan's styleZoom.ts) ----
   The sorted set of every layer's minzoom/maxzoom: stepping between these
   walks the zooms where the map actually gains or loses features. */
export function deriveSnapLevels(style, maxZoom = 22) {
  const raw = new Set([0, maxZoom]);
  for (const layer of style.layers ?? []) {
    if (typeof layer.minzoom === 'number') raw.add(layer.minzoom);
    if (typeof layer.maxzoom === 'number' && layer.maxzoom < maxZoom) raw.add(layer.maxzoom);
  }
  const sorted = [...raw].filter(z => z >= 0 && z <= maxZoom).sort((a, b) => a - b);
  const levels = [];
  for (const z of sorted) {
    if (levels.length === 0 || z - levels[levels.length - 1] > 0.1) levels.push(z);
  }
  return levels;
}
export function nextSnap(levels, z) {
  for (const l of levels) if (l > z + 0.05) return l - z > 2 ? Math.floor(z + 1) : l;
  return levels[levels.length - 1] ?? z;
}
export function prevSnap(levels, z) {
  for (let i = levels.length - 1; i >= 0; i--) {
    if (levels[i] < z - 0.05) return z - levels[i] > 2 ? Math.ceil(z - 1) : levels[i];
  }
  return levels[0] ?? z;
}
