/* NavView — one full independent Nav render (design: "each viewport is a full
   independent Nav render — own MapLibre instance, own auto-zoom, own HUD scaled
   to its frame"). The nav logic is a faithful port of DingoNav's onFix path:
   off-track hysteresis, direction voting, speed-scaled warn distances, the
   beep grammar, HUD drain bar, cruise/approach auto-zoom, look-ahead camera.
   The whole render is driven through onFix(lat,lon,acc,speed,heading) — the
   same seam Nav's demo mode proved. */

import { REF, setRef, toXY, toLL, dist, bearing, angDiff, nearestOnTrack } from './geom.js';
import { SILENT_KINDS, kindOf, DANGER_FAR, DANGER_NEAR, MARKS } from './cues.js';
import { applyScheme, basePaintOverrides, applyBaseOverrides, hillPaint } from './applier-nav.js';
import { tok } from './scheme.js';

/* ---------------- shared map base (PMTiles protocol + layer files) ----------------
   PMTiles are fetched whole and read from an in-memory FileSource (Nav's
   pattern) — serve.js and GitHub Pages don't do range requests reliably.
   Blobs are cached in IndexedDB so reloads skip the 33 MB download. */
export const BASE = { protocol: null, pm: null, has: false, hasHill: false, urlRef: '', layerCache: {} };
async function loadPM(idb, id, path, name) {
  let blob = null;
  try { const rec = await idb.get(id); if (rec) blob = rec.blob; } catch (e) {}
  if (!blob) {
    try {
      const resp = await fetch(path);
      if (resp.ok) {
        const b = await resp.blob();
        // guard against SPA-fallback HTML masquerading as the file
        const magic = new TextDecoder().decode(new Uint8Array(await b.slice(0, 7).arrayBuffer()));
        if (magic === 'PMTiles') { blob = b; await idb.put({ id, kind: id, blob }).catch(() => {}); }
      }
    } catch (e) {}
  }
  if (!blob) return null;
  return new pmtiles.PMTiles(new pmtiles.FileSource(new File([blob], name)));
}
export async function initMapBase(idb) {
  BASE.protocol = new pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', BASE.protocol.tile);
  BASE.pm = await loadPM(idb, 'basemap', 'basemap/central-coast.pmtiles', 'base');
  if (BASE.pm) { BASE.protocol.add(BASE.pm); BASE.has = true; }
  const hill = await loadPM(idb, 'hillshade', 'basemap/hillshade.pmtiles', 'hillshade');
  if (hill) { BASE.protocol.add(hill); BASE.hasHill = true; }
  BASE.urlRef = new URL('basemap/', location.href).href;
  for (const f of ['layers.json', 'layers-light.json'])
    BASE.layerCache[f] = await (await fetch('basemap/' + f)).json();
}

async function buildStyle(scheme) {
  const base = tok(scheme, 'basemap.base');
  const file = base === 'light' ? 'layers-light.json' : 'layers.json';
  if (!BASE.has) return { version: 8,
    glyphs: BASE.urlRef + 'fonts/{fontstack}/{range}.pbf',
    sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': tok(scheme, 'hud.bg') || '#0e1216' } }] };
  let layersArr = applyBaseOverrides(BASE.layerCache[file], basePaintOverrides(scheme));
  const sources = { protomaps: { type: 'vector', url: 'pmtiles://base', attribution: '© OpenStreetMap, Protomaps' } };
  const hill = hillPaint(scheme);
  if (BASE.hasHill && hill) {
    sources.dem = { type: 'raster-dem', url: 'pmtiles://hillshade', encoding: 'terrarium', tileSize: 256 };
    const hl = { id: 'hillshade', type: 'hillshade', source: 'dem', paint: hill };
    const at = layersArr.findIndex(l => l.id === 'water'); // relief under water, roads and labels
    layersArr = at < 0 ? [...layersArr, hl] : [...layersArr.slice(0, at), hl, ...layersArr.slice(at)];
  }
  return { version: 8,
    glyphs: BASE.urlRef + 'fonts/{fontstack}/{range}.pbf', // string concat — new URL() would %-encode the tokens
    sprite: BASE.urlRef + 'sprites/' + (base === 'light' ? 'light' : 'dark'),
    sources, layers: layersArr };
}

/* ---------------- audio (Nav's beep grammar, shared across views) ---------------- */
let AC = null;
export const SOUND = { on: true, vol: 0.5 };
function audio() { if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); if (AC.state === 'suspended') AC.resume(); return AC; }
export function unlockAudio() { try { audio(); } catch (e) {} }
function tone(freq, dur, when, vol) {
  vol = vol == null ? SOUND.vol : vol;
  const ctx = audio(), t = ctx.currentTime + when;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'square'; o.frequency.value = freq;
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01);
  g.gain.setValueAtTime(vol, t + dur - 0.03); g.gain.linearRampToValueAtTime(0, t + dur);
  o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + dur + 0.02);
}
/* count = direction (1 right, 2 left); pitch = phase (deep approaching, high at the turn) */
export const BEEP = {
  appr(ty)   { if (!SOUND.on) return; tone(460, .2, 0); if (ty === 'left') tone(460, .2, .3); },
  now(ty)    { if (!SOUND.on) return; tone(990, .16, 0); if (ty === 'left') tone(990, .16, .24); },
  done()     { if (!SOUND.on) return; tone(700, .09, 0); tone(1050, .12, .12); },
  off()      { if (!SOUND.on) return; tone(240, .35, 0); tone(200, .45, .4); },
  back()     { if (!SOUND.on) return; tone(600, .1, 0); tone(900, .12, .13); },
  straight() { if (!SOUND.on) return; tone(990, .3, 0); },
  danger()   { if (!SOUND.on) return; tone(1320, .12, 0); tone(1320, .12, .18); tone(1320, .3, .36); }, // Nav: ignores mute; Studio is a preview, mute is mute
  mark()     { if (!SOUND.on) return; tone(880, .2, 0); },
};

/* speed-scaled warn distances — enduro profile (Nav's default vehicle) */
const VEH = { farMin: 60, farMax: 250, nearMin: 25, nearMax: 70, defSpd: 8, spans: [[0, 300], [8.3, 900], [19.4, 2500]] };
const APPR_S = 15, APPR_MUL = 1.5, APPR_FLOOR = 250, OFF_M = 60, ON_M = 40, DEPART_M = 30;

const EMPTY = { type: 'FeatureCollection', features: [] };
const ICONS = { left: 'corner-up-left', right: 'corner-up-right', straight: 'arrow-up',
  danger: 'triangle-alert', obstacle: 'construction', gate: 'fence', creek: 'waves' };
const LABELS = { left: 'Turn left', right: 'Turn right', straight: 'Straight ahead',
  danger: 'DANGER !!!', obstacle: 'Obstacle', gate: 'Gate', creek: 'Creek crossing' };

function icSvg(name) { return '<svg class="ic"><use href="#i-' + name + '"/></svg>'; }
function setIc(el, name) { const u = el.querySelector('use'); if (u) u.setAttribute('href', '#i-' + name); else el.innerHTML = icSvg(name); }

/* rounded square + glyph for a mark kind, @2x — colour from the scheme */
function markSquareImage(kind, col) {
  const c = document.createElement('canvas'); c.width = c.height = 36;
  const x = c.getContext('2d');
  const i = 2.5, s = 36 - 2 * i, r = 8;
  x.beginPath();
  x.moveTo(i + r, i);
  x.arcTo(i + s, i, i + s, i + s, r); x.arcTo(i + s, i + s, i, i + s, r);
  x.arcTo(i, i + s, i, i, r); x.arcTo(i, i, i + s, i, r);
  x.closePath();
  x.fillStyle = col; x.strokeStyle = '#0e1216'; x.lineWidth = 3;
  x.fill(); x.stroke();
  x.fillStyle = '#0e1216'; x.font = 'bold 20px system-ui, sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(MARKS[kind].glyph || '', 18, 19);
  return x.getImageData(0, 0, 36, 36);
}
function navDartImage() {
  const c = document.createElement('canvas'); c.width = c.height = 56;
  const x = c.getContext('2d');
  x.beginPath(); x.moveTo(28, 5); x.lineTo(47, 49); x.lineTo(28, 38); x.lineTo(9, 49); x.closePath();
  x.fillStyle = '#4096ff'; x.strokeStyle = '#fff'; x.lineWidth = 4; x.lineJoin = 'round';
  x.stroke(); x.fill();
  return x.getImageData(0, 0, 56, 56);
}

let seq = 0;

export class NavView {
  /* opts: { scheme, interactive:true, orient:'course'|'north', chrome:true } */
  constructor(container, opts = {}) {
    this.id = 'nv' + (++seq);
    this.opts = opts;
    this.scheme = opts.scheme;
    this.orient = opts.orient || 'course';
    this.trk = null; this.heat = null;
    this.pos = null; this.courseBearing = null; this.navState = null;
    this.follow = true; this.navving = false;
    this.trail = []; this.trailLast = null;
    this.camOffX = 0; this.camOffY = 0; this.lastEase = 0;
    this.ready = false;
    this._buildDom(container);
    this._applyCss();
  }

  _buildDom(container) {
    const el = this.el = document.createElement('div');
    el.className = 'nv';
    el.innerHTML = `
      <div class="nv-map"></div>
      <div class="nv-chrome">
        <div class="nv-hud"><div class="nv-hudBox">
          <div class="nv-hudFill"></div>
          <div class="nv-hudArrow">${icSvg('arrow-up')}</div>
          <div class="nv-hudType">next turn</div>
          <div class="nv-hudDist">— <small>m</small></div>
        </div></div>
        <div class="nv-speed"></div>
        <div class="nv-banner">OFF TRACK</div>
        <div class="nv-bigArrow nv-bigL">${icSvg('corner-up-left')}</div>
        <div class="nv-bigArrow nv-bigR">${icSvg('corner-up-right')}</div>
        <div class="nv-dot">${icSvg('square')}</div>
      </div>`;
    container.appendChild(el);
    this.$ = s => el.querySelector(s);
    this.mapEl = this.$('.nv-map');
    // HUD scaled to its frame: chrome sizes are em-based off this root font-size
    this.ro = new ResizeObserver(() => this._rescale());
    this.ro.observe(el);
    this._rescale();
  }
  _rescale() {
    const w = this.el.clientWidth || 390;
    this.el.style.fontSize = Math.max(6, 16 * Math.min(w / 390, (this.el.clientHeight || 700) / 700)) + 'px';
    if (this.map) this.map.resize();
  }

  async init() {
    const style = await buildStyle(this.scheme);
    this.map = new maplibregl.Map({
      container: this.mapEl, style,
      center: [151.3, -33.3], zoom: 9,
      maxPitch: 0, pitchWithRotate: false, dragRotate: false,
      attributionControl: { compact: true },
      preserveDrawingBuffer: true, // preview.png capture
      interactive: this.opts.interactive !== false,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();
    this.map.on('dragstart', () => { this.follow = false; });
    await new Promise(res => {
      if (this.map.isStyleLoaded()) return res();
      const t = setInterval(() => { if (this.map.isStyleLoaded()) { clearInterval(t); res(); } }, 250);
      this.map.once('load', () => { clearInterval(t); res(); });
    });
    this.ready = true;
    this._addOverlays();
    this._refreshData();
  }

  /* ---------------- overlays (Studio subset of Nav's ladder) ---------------- */
  _adv(k) { const a = this._advCache || (this._advCache = applyScheme(this.scheme).adv); return a[k]; }
  _caseColor() {
    const m = this._adv('caseMode');
    const night = tok(this.scheme, 'basemap.base') !== 'light';
    return m === 'white' ? '#ffffff' : m === 'dark' ? '#101820' : night ? '#ffffff' : '#101820';
  }
  _totalW() { return ['interpolate', ['linear'], ['zoom'], 10, this._adv('routeWOut'), 17, this._adv('routeWIn')]; }
  _coreW() { const f = 0.67; return ['interpolate', ['linear'], ['zoom'], 10, this._adv('routeWOut') * f, 17, this._adv('routeWIn') * f]; }
  _clsMatch() { return ['match', ['get', 'class'], 'other', this._adv('colOther'), 'plan', this._adv('colPlan'), this._adv('colOwn')]; }

  _addOverlays() {
    const map = this.map;
    // setStyle's diff sometimes carries runtime sources/layers into the new
    // style and sometimes drops them — start from a clean slate either way,
    // or one surviving source throws and takes the whole ladder down with it
    for (const id of ['heat-halo', 'heat-core', 'trail-dots', 'sel-case', 'sel-core', 'dir-vs',
      'alert-dots', 'mark-squares', 'pos-arrow'])
      if (map.getLayer(id)) map.removeLayer(id);
    for (const id of ['heat', 'selTrack', 'alerts', 'trail', 'pos'])
      if (map.getSource(id)) map.removeSource(id);
    map.addSource('heat', { type: 'geojson', data: this.heat ? this.heat.geojson : EMPTY });
    map.addSource('selTrack', { type: 'geojson', data: EMPTY });
    map.addSource('alerts', { type: 'geojson', data: EMPTY });
    map.addSource('trail', { type: 'geojson', data: EMPTY });
    map.addSource('pos', { type: 'geojson', data: EMPTY });

    map.addLayer({ id: 'heat-halo', type: 'line', source: 'heat',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': this._clsMatch(), 'line-opacity': 0.10, 'line-blur': 4,
        'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 8, 2, 12, 6, 15, 14, 17, 26] } });
    map.addLayer({ id: 'heat-core', type: 'line', source: 'heat',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': this._clsMatch(), 'line-opacity': this._adv('heatOp'),
        'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 8, 0.7, 12, 1.6, 15, 3, 17, 6] } });
    map.addLayer({ id: 'trail-dots', type: 'line', source: 'trail',
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': this._adv('colBreadcrumb'), 'line-opacity': 0.85, 'line-width': 3.5, 'line-dasharray': [0.1, 2] } });
    map.addLayer({ id: 'sel-case', type: 'line', source: 'selTrack',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': this._caseColor(), 'line-width': this._totalW() } });
    map.addLayer({ id: 'sel-core', type: 'line', source: 'selTrack',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': this._adv('colRoute'), 'line-width': this._coreW() } });
    map.addLayer({ id: 'dir-vs', type: 'symbol', source: 'selTrack',
      layout: { 'symbol-placement': 'line', 'symbol-spacing': this._adv('chevGap'), 'text-field': '›',
        'text-size': Math.max(1, this._adv('chevSize')), 'text-font': ['Noto Sans Medium'], 'text-keep-upright': false,
        'text-allow-overlap': true, 'text-rotation-alignment': 'map',
        visibility: this._adv('chevSize') > 0 ? 'visible' : 'none' },
      paint: { 'text-color': this._caseColor() } });
    const marks = applyScheme(this.scheme).marks;
    map.addLayer({ id: 'alert-dots', type: 'circle', source: 'alerts', minzoom: 12.5,
      filter: ['==', ['get', 'k'], 'turn'],
      paint: { 'circle-radius': 4.5, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#0e1216',
        'circle-color': ['case', ['get', 'manual'], marks.turn, marks.autoTurn] } });
    for (const k in MARKS) if (k !== 'turn') { // images survive setStyle — always re-bake so colours track the scheme
      if (map.hasImage('mark-' + k)) map.removeImage('mark-' + k);
      map.addImage('mark-' + k, markSquareImage(k, marks[k]), { pixelRatio: 2 });
    }
    map.addLayer({ id: 'mark-squares', type: 'symbol', source: 'alerts', minzoom: 12.5,
      filter: ['!=', ['get', 'k'], 'turn'],
      layout: { 'icon-image': ['concat', 'mark-', ['get', 'k']],
        'icon-allow-overlap': true, 'icon-ignore-placement': true } });
    if (!map.hasImage('nav-dart')) map.addImage('nav-dart', navDartImage(), { pixelRatio: 2 });
    map.addLayer({ id: 'pos-arrow', type: 'symbol', source: 'pos',
      layout: { 'icon-image': 'nav-dart', 'icon-size': 1.5, 'icon-rotate': ['get', 'heading'],
        'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
  }

  /* ---------------- scheme application ---------------- */
  async setScheme(scheme, { rebuild = false } = {}) {
    const baseChanged = !this.scheme || tok(this.scheme, 'basemap.base') !== tok(scheme, 'basemap.base');
    this.scheme = scheme;
    this._advCache = null;
    this._applyCss();
    if (!this.ready) return;
    if (rebuild || baseChanged) {
      this.map.setStyle(await buildStyle(scheme));
      await new Promise(res => {
        const t = setInterval(() => { if (this.map.isStyleLoaded()) { clearInterval(t); res(); } }, 200);
        this.map.once('idle', () => { clearInterval(t); res(); });
      });
      this._addOverlays();
      this._refreshData();
    } else {
      this._patchBase();
      this._patchOverlays();
    }
  }
  _applyCss() {
    if (!this.scheme) return;
    const css = applyScheme(this.scheme).css;
    for (const [k, v] of Object.entries(css)) if (v != null) this.el.style.setProperty(k, v);
  }
  _patchBase() {
    const map = this.map, ov = basePaintOverrides(this.scheme);
    const labels = ov.__labels;
    for (const [id, patch] of Object.entries(ov)) {
      if (id === '__labels') continue;
      if (!map.getLayer(id)) continue;
      for (const [prop, val] of Object.entries(patch)) map.setPaintProperty(id, prop, val);
    }
    // tokens reset to "inherit" need the base value back — cheap full check of ours vs file
    const base = tok(this.scheme, 'basemap.base');
    const file = base === 'light' ? 'layers-light.json' : 'layers.json';
    for (const l of BASE.layerCache[file] || []) {
      if (!map.getLayer(l.id)) continue;
      if (labels && l.type === 'symbol') {
        for (const [prop, val] of Object.entries(labels)) map.setPaintProperty(l.id, prop, val);
      } else if (l.type === 'symbol' && this._hadLabels) {
        for (const prop of ['text-color', 'text-halo-color'])
          if (l.paint && l.paint[prop] != null) map.setPaintProperty(l.id, prop, l.paint[prop]);
      }
      if (!ov[l.id] && this._hadOv && this._hadOv[l.id]) {
        for (const prop of Object.keys(this._hadOv[l.id]))
          if (l.paint && l.paint[prop] != null) map.setPaintProperty(l.id, prop, l.paint[prop]);
      }
    }
    this._hadOv = ov; this._hadLabels = !!labels;
    const hill = hillPaint(this.scheme);
    if (this.map.getLayer('hillshade')) {
      if (hill) { this.map.setLayoutProperty('hillshade', 'visibility', 'visible');
        for (const [p, v] of Object.entries(hill)) this.map.setPaintProperty('hillshade', p, v); }
      else this.map.setLayoutProperty('hillshade', 'visibility', 'none');
    }
  }
  _patchOverlays() {
    const map = this.map;
    const set = (id, p, v) => { if (map.getLayer(id)) map.setPaintProperty(id, p, v); };
    const setL = (id, p, v) => { if (map.getLayer(id)) map.setLayoutProperty(id, p, v); };
    set('heat-halo', 'line-color', this._clsMatch());
    set('heat-core', 'line-color', this._clsMatch());
    set('heat-core', 'line-opacity', this._adv('heatOp'));
    set('trail-dots', 'line-color', this._adv('colBreadcrumb'));
    set('sel-case', 'line-color', this._caseColor());
    set('sel-case', 'line-width', this._totalW());
    set('sel-core', 'line-color', this._adv('colRoute'));
    set('sel-core', 'line-width', this._coreW());
    set('dir-vs', 'text-color', this._caseColor());
    setL('dir-vs', 'symbol-spacing', this._adv('chevGap'));
    setL('dir-vs', 'text-size', Math.max(1, this._adv('chevSize')));
    setL('dir-vs', 'visibility', this._adv('chevSize') > 0 ? 'visible' : 'none');
    const marks = applyScheme(this.scheme).marks;
    set('alert-dots', 'circle-color', ['case', ['get', 'manual'], marks.turn, marks.autoTurn]);
    for (const k in MARKS) if (k !== 'turn') {
      if (map.hasImage('mark-' + k)) map.removeImage('mark-' + k);
      map.addImage('mark-' + k, markSquareImage(k, marks[k]), { pixelRatio: 2 });
    }
  }

  /* ---------------- data ---------------- */
  setData({ trk, heat }) {
    if (trk !== undefined) this.trk = trk;
    if (heat !== undefined) this.heat = heat;
    this._refreshData();
  }
  _refreshData() {
    if (!this.ready) return;
    const map = this.map;
    map.getSource('heat').setData(this.heat ? this.heat.geojson : EMPTY);
    map.getSource('selTrack').setData(this.trk
      ? { type: 'Feature', geometry: { type: 'LineString', coordinates: this.trk.coordsLL } } : EMPTY);
    map.getSource('alerts').setData(this.trk && this.trk.alerts
      ? { type: 'FeatureCollection', features: this.trk.alerts.map(a => {
          const [lat, lon] = toLL(this.trk.xy[a.idx * 2], this.trk.xy[a.idx * 2 + 1]);
          return { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: { k: kindOf(a), manual: !!a.manual } };
        }) } : EMPTY);
  }
  refreshAlerts() { this._refreshData(); }
  fitTrack() {
    if (!this.ready || !this.trk) return;
    this.map.fitBounds(this.trk.llBounds, { padding: 40, duration: 400 });
  }

  /* ---------------- navigation (the onFix port) ---------------- */
  startNav() {
    this.navState = { idx: -1, dir: 1, dirVotes: 0, off: false, lastOffBeep: 0, alertStates: new Map(),
      avgSpd: null, lastFixT: 0, confirmAt: null, lastNext: null, approach: false, apprArmed: false };
    this.navving = true; this.follow = true;
    this.trail = []; this.trailLast = null;
    this.camOffX = this.camOffY = 0;
    this.el.classList.add('navving');
    this.$('.nv-hud').classList.add('on');
    this.$('.nv-speed').classList.add('on');
  }
  stopNav() {
    this.navving = false;
    this.el.classList.remove('navving');
    this.$('.nv-hud').classList.remove('on');
    this.$('.nv-speed').classList.remove('on');
    this.$('.nv-banner').classList.remove('on');
    this._setBig(null);
  }

  onFix(lat, lon, acc, speed, heading) {
    if (!REF) setRef(lat, lon);
    const [x, y] = toXY(lat, lon);
    const t = Date.now();
    const ns = this.navState;
    let spd = speed;
    if ((spd == null || isNaN(spd)) && this.pos && t > this.pos.t) spd = dist(x, y, this.pos.x, this.pos.y) / ((t - this.pos.t) / 1000);
    let hdg = heading;
    if ((hdg == null || isNaN(hdg)) && this.pos && dist(x, y, this.pos.x, this.pos.y) > 3) hdg = bearing(this.pos.x, this.pos.y, x, y);
    this.pos = { x, y, acc: acc || 0, speed: spd || 0, heading: hdg, t };
    if (hdg != null && !isNaN(hdg) && (spd || 0) > 2)
      this.courseBearing = this.courseBearing == null ? hdg : this.courseBearing + angDiff(this.courseBearing, hdg) * 0.4;
    this._renderSpeed();
    this._refreshPos();
    this._followCamera();
    if (!this.navving || !this.trk || !ns) return;
    this._trailPush(x, y);

    const trk = this.trk;
    const near = nearestOnTrack(trk, x, y, ns.idx);
    if (ns.idx >= 0 && near.d < OFF_M) {
      const delta = near.idx - ns.idx;
      if (delta !== 0) ns.dirVotes = Math.max(-8, Math.min(8, ns.dirVotes + Math.sign(delta)));
      const newDir = ns.dirVotes <= -4 ? -1 : ns.dirVotes >= 4 ? 1 : ns.dir;
      if (newDir !== ns.dir) { ns.dir = newDir; ns.confirmAt = null; }
    }
    ns.idx = near.idx;

    if (near.d > OFF_M && !ns.off) ns.off = true;
    if (near.d < ON_M && ns.off) { ns.off = false; BEEP.back(); this.$('.nv-banner').classList.remove('on'); }
    if (ns.off) {
      const bn = this.$('.nv-banner');
      bn.textContent = 'Off track · ' + Math.round(near.d) + ' m'; bn.classList.add('on');
      if (t - ns.lastOffBeep > 30e3) { BEEP.off(); ns.lastOffBeep = t; }
      ns.confirmAt = null;
      this._setHud(null); return;
    }

    const s = trk.cum[near.idx];
    const dts = ns.lastFixT ? Math.min(5, (t - ns.lastFixT) / 1000) : 0;
    ns.lastFixT = t;
    if ((spd || 0) > 1) ns.avgSpd = ns.avgSpd == null ? spd : ns.avgSpd * 0.98 + spd * 0.02;

    const aSpd = ns.avgSpd || VEH.defSpd;
    let farM = Math.min(VEH.farMax, Math.max(VEH.farMin, aSpd * APPR_S));
    let nearM = Math.min(VEH.nearMax, Math.max(VEH.nearMin, aSpd * 5));
    let next = null, dTo = Infinity;
    if (trk.alerts) {
      if (ns.dir > 0) { for (const a of trk.alerts) if (a.at > s + 5 && !SILENT_KINDS[kindOf(a)]) { next = a; dTo = a.at - s; break; } }
      else { for (let i = trk.alerts.length - 1; i >= 0; i--) { const a = trk.alerts[i]; if (a.at < s - 5 && !SILENT_KINDS[kindOf(a)]) { next = a; dTo = s - a.at; break; } } }
    }
    const nextDanger = next && kindOf(next) === 'danger';
    if (nextDanger) { farM = Math.max(farM, DANGER_FAR); nearM = DANGER_NEAR; }
    if (ns.lastNext && next !== ns.lastNext && !ns.off) {
      const p = ns.lastNext, st = ns.alertStates.get(p);
      if (st && !st.near && !st.done) { st.done = true;
        ns.confirmAt = ns.dir > 0 ? p.at + DEPART_M : p.at - DEPART_M; }
    }
    ns.lastNext = next;
    if (ns.confirmAt != null && (ns.dir > 0 ? s >= ns.confirmAt : s <= ns.confirmAt)) {
      ns.confirmAt = null; this._flashCommit(); BEEP.done();
    }
    ns.approach = !!next && dTo <= Math.max(farM * APPR_MUL, APPR_FLOOR);
    this._setHud(next, dTo, ns.dir, farM);
    if (next) {
      let st = ns.alertStates.get(next); if (!st) ns.alertStates.set(next, st = { far: true, near: true });
      if (dTo > farM + 80) { st.far = true; st.near = true; st.done = false; }
      const k = kindOf(next);
      let ty = next.type; if (ns.dir < 0) ty = ty === 'left' ? 'right' : 'left';
      if (dTo <= farM && dTo > nearM && st.far) { st.far = false; nextDanger ? BEEP.danger() : BEEP.appr(ty); }
      if (dTo <= nearM && st.near) {
        st.near = false; st.far = false;
        if (k === 'danger') BEEP.danger();
        else if (k !== 'turn') BEEP.mark();
        else ty === 'straight' ? BEEP.straight() : BEEP.now(ty);
      }
    }
  }

  _trailPush(x, y) {
    if (this.trailLast && dist(x, y, this.trailLast[0], this.trailLast[1]) < 20) return;
    this.trailLast = [x, y];
    const [lat, lon] = toLL(x, y);
    this.trail.push([lon, lat]);
    if (this.ready) this.map.getSource('trail').setData(
      { type: 'Feature', geometry: { type: 'LineString', coordinates: this.trail } });
  }
  clearTrail() {
    this.trail = []; this.trailLast = null;
    if (this.ready) this.map.getSource('trail').setData(EMPTY);
  }
  _refreshPos() {
    if (!this.ready || !this.pos) return;
    const [lat, lon] = toLL(this.pos.x, this.pos.y);
    this.map.getSource('pos').setData({ type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { heading: this.courseBearing || 0 } }); // dart points travel direction on the map, any orientation
  }

  /* camera: cruise at max span, dive to min span on approach, look-ahead offset */
  _zoomForSpan(span, lat) {
    const h = this.mapEl.clientHeight || 700;
    return Math.log2(156543.03392 * Math.cos(lat * Math.PI / 180) * h / span);
  }
  _followCamera() {
    if (!this.ready || !this.pos || !this.follow || !this.navving) return;
    const now = Date.now(); if (now - this.lastEase < 800) return;
    this.lastEase = now;
    const [la, lo] = toLL(this.pos.x, this.pos.y);
    const ns = this.navState;
    const vw = this.el.clientWidth, vh = this.el.clientHeight;
    let tx = 0, ty = Math.round(vh * 0.15);
    if (this.orient === 'north') {
      if (this.courseBearing != null && this.pos.speed >= 1.5) {
        const R = Math.min(vw, vh) * 0.18, r = this.courseBearing * Math.PI / 180;
        tx = -Math.sin(r) * R; ty = Math.cos(r) * R;
      } else { tx = this.camOffX; ty = this.camOffY; }
    }
    this.camOffX += (tx - this.camOffX) * 0.18; this.camOffY += (ty - this.camOffY) * 0.18;
    const opts = { center: [lo, la], duration: 900, easing: t => t,
      offset: [Math.round(this.camOffX), Math.round(this.camOffY)] };
    if (!(ns && ns.off)) { // off track: freeze the zoom, keep centring
      const spans = VEH.spans;
      const span = ns && ns.approach ? spans[0][1] : spans[spans.length - 1][1];
      opts.zoom = this._zoomForSpan(span, la);
    }
    if (this.orient === 'course' && this.courseBearing != null) opts.bearing = this.courseBearing;
    else if (this.orient === 'north') opts.bearing = 0;
    this.map.easeTo(opts);
  }

  /* ---------------- HUD chrome ---------------- */
  _renderSpeed() {
    const el = this.$('.nv-speed');
    el.innerHTML = Math.round((this.pos ? this.pos.speed : 0) * 3.6) + ' <small>km/h</small>';
  }
  _flashCommit() {
    const box = this.$('.nv-hudBox');
    box.classList.add('commit');
    clearTimeout(this._commitT); this._commitT = setTimeout(() => box.classList.remove('commit'), 1200);
  }
  _setBig(type) {
    this.$('.nv-bigL').classList.toggle('on', type === 'left');
    this.$('.nv-bigR').classList.toggle('on', type === 'right');
  }
  _setHud(alert, dTo, dir, farM) {
    const box = this.$('.nv-hudBox'), fill = this.$('.nv-hudFill');
    const arrow = this.$('.nv-hudArrow'), distEl = this.$('.nv-hudDist'), typeEl = this.$('.nv-hudType');
    const win = Math.max((farM || 160) * APPR_MUL, APPR_FLOOR);
    const show = !!alert && dTo <= win;
    box.style.visibility = show || box.classList.contains('commit') ? '' : 'hidden';
    if (!show) { fill.style.width = '0'; this._setBig(null); return; }
    let type = alert.type;
    if (dir < 0 && type === 'left') type = 'right'; else if (dir < 0 && type === 'right') type = 'left';
    this._setBig(type === 'left' || type === 'right' ? type : null);
    const from = dir > 0 ? alert.from : alert.onto, onto = dir > 0 ? alert.onto : alert.from;
    const ontoTxt = onto && onto !== from ? ' · onto ' + ((dir > 0 && alert.name) || onto) : '';
    if ((type === 'left' || type === 'right' || type === 'straight') && this.orient === 'north' && alert.outBrg != null) {
      const exit = dir > 0 ? alert.outBrg : (alert.inBrg + 180) % 360;
      setIc(arrow, 'arrow-up'); arrow.className = 'nv-hudArrow ' + type; arrow.style.transform = 'rotate(' + exit + 'deg)';
    } else {
      setIc(arrow, ICONS[type] || 'arrow-up'); arrow.className = 'nv-hudArrow ' + type; arrow.style.transform = '';
    }
    distEl.innerHTML = (dTo >= 995 ? (dTo / 1000).toFixed(1) + ' <small>km</small>' : Math.round(dTo / 5) * 5 + ' <small>m</small>');
    typeEl.textContent = (LABELS[type] || 'turn') + ontoTxt;
    fill.style.width = Math.max(0, Math.min(100, dTo / win * 100)) + '%';
  }

  capturePng() { return this.map.getCanvas().toDataURL('image/png'); }
  destroy() {
    this.ro.disconnect();
    if (this.map) this.map.remove();
    this.el.remove();
  }
}
