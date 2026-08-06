/* Plan-styles inspector — the style-layers editor moved out of Dingo Plan
   (design: config UI doesn't belong in the plan workflow; Studio is the
   look-and-feel home). Ported from Plan's StyleLayersPanel.tsx.

   Edits the PRISTINE style draft ({MAPTILER_KEY} placeholder intact), applies
   to Studio's own preview map immediately, and saves back through the Dingo
   daemon (PUT /api/styles/{id}) — same endpoint Plan used, so Plan picks the
   change up on its next style load. Requires the daemon running locally;
   without it the inspector opens read-only.

   Group pills are multi-select; rows are Gantt bars of zoom visibility with a
   cursor at the current zoom; eye = solo (preview-only); clicking a row
   selects + flashes it. Day/night is a palette remap in metadata dingo:night;
   heat colours live in dingo:overlays. */

import {
  ATTRS_BY_TYPE, DASH_PRESETS, FLASH_PROPS, FONT_OPTIONS, OVERLAY_KEYS,
  addPaletteColor, applyNightMap, autoNightColor, buildZoomRamp, collectPalette,
  deriveSnapLevels, evalZoomRamp, isExpression, literalColors, nextSnap,
  nightMapOf, numberRange, overlaysOf, parseColor, parseZoomRamp, prevSnap,
  replaceColorGlobal, sortPalette, withAlpha,
} from './styleattrs.js';

const MAPTILER_KEY = 'BWXJWQgUr60zDTSCSOwr'; // public, domain-restricted key from Plan's repo; styles store only the placeholder
export const DAEMON = 'http://localhost:3000';
const MAX_ZOOM = 24, AXIS_MAX = 16;
const DINGO_GROUP = 'Dingo';
const DEFAULT_GROUPS = ['Places', 'Roads', 'Tracks'];
const OVERLAY_LABELS = { heatOwn: 'My heatmap', heatStrava: 'Strava heat', heatPlanned: 'Planned heat' };

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function groupOf(layer) {
  const tagged = layer.metadata && layer.metadata['dingo:group'];
  if (typeof tagged === 'string' && tagged) return tagged;
  const key = layer['source-layer'] ?? layer.type;
  if (!key) return 'Other';
  return key[0].toUpperCase() + key.slice(1).replaceAll('_', ' ');
}

/* tiny rendered example of the layer (SVG string) */
function sampleSvg(layer) {
  const paint = layer.paint || {}, layout = layer.layout || {};
  const colorOf = (v, fb) => typeof v === 'string' ? v : (literalColors(v)[0] || fb);
  const numOf = (v, fb) => { if (typeof v === 'number') return v; const r = numberRange(v); return r ? (r[0] + r[1]) / 2 : fb; };
  const W = 40, H = 16;
  let inner;
  switch (layer.type) {
    case 'line': {
      const w = Math.min(5, Math.max(1.5, numOf(paint['line-width'], 2)));
      const dr = paint['line-dasharray'];
      const dash = Array.isArray(dr) && !isExpression(dr) ? ` stroke-dasharray="${dr.map(d => d * 2).join(' ')}"` : '';
      inner = `<line x1="2" y1="${H / 2}" x2="${W - 2}" y2="${H / 2}" stroke="${colorOf(paint['line-color'], '#888')}" stroke-width="${w}"${dash} stroke-linecap="round"/>`;
      break;
    }
    case 'fill':
      inner = `<rect x="3" y="2" width="${W - 6}" height="${H - 4}" rx="2" fill="${colorOf(paint['fill-color'], '#888')}" stroke="${colorOf(paint['fill-outline-color'], 'transparent')}"/>`;
      break;
    case 'symbol': {
      const fonts = layout['text-font'];
      const italic = Array.isArray(fonts) && fonts.some(f => typeof f === 'string' && f.includes('Italic'));
      const bold = Array.isArray(fonts) && fonts.some(f => typeof f === 'string' && f.includes('Bold'));
      inner = `<text x="${W / 2}" y="${H - 4}" text-anchor="middle" font-size="11"${italic ? ' font-style="italic"' : ''}${bold ? ' font-weight="bold"' : ''} fill="${colorOf(paint['text-color'], '#ddd')}" stroke="${colorOf(paint['text-halo-color'], 'transparent')}" stroke-width="2" paint-order="stroke">Abc</text>`;
      break;
    }
    case 'circle': {
      const r = Math.min(6, Math.max(2, numOf(paint['circle-radius'], 3)));
      inner = `<circle cx="${W / 2}" cy="${H / 2}" r="${r}" fill="${colorOf(paint['circle-color'], '#888')}" stroke="${colorOf(paint['circle-stroke-color'], 'transparent')}"/>`;
      break;
    }
    case 'background':
      inner = `<rect x="3" y="2" width="${W - 6}" height="${H - 4}" rx="2" fill="${colorOf(paint['background-color'], '#888')}"/>`;
      break;
    case 'hillshade':
      inner = `<rect x="3" y="2" width="${W - 6}" height="${H - 4}" rx="2" fill="${colorOf(paint['hillshade-shadow-color'], '#a08c68')}" opacity="0.6"/>`;
      break;
    default:
      inner = `<rect x="3" y="2" width="${W - 6}" height="${H - 4}" rx="2" fill="#666"/>`;
  }
  return `<svg class="si-sample" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">${inner}</svg>`;
}

function ganttHtml(min, max, zoom, hidden) {
  const lo = (Math.min(min ?? 0, AXIS_MAX) / AXIS_MAX) * 100;
  const hi = (Math.min(max ?? AXIS_MAX, AXIS_MAX) / AXIS_MAX) * 100;
  const cur = (Math.min(zoom, AXIS_MAX) / AXIS_MAX) * 100;
  return `<span class="si-gantt"><span class="si-gantt-bar${hidden ? ' hid' : ''}" style="left:${lo}%;width:${Math.max(hi - lo, 1)}%"></span><span class="si-gantt-cursor" style="left:${cur}%"></span></span>`;
}

export class StyleInspector {
  constructor({ panelEl, mapEl, toast }) {
    this.panelEl = panelEl;
    this.mapEl = mapEl;
    this.toast = toast || console.log;
    this.map = null;
    this.styleId = null;
    this.manifest = [];
    this.draft = null;
    this.mode = 'day';
    this.editable = false;
    this.dirty = false;
    this.filter = 'all';
    this.showHidden = true;
    this.selectedGroups = null;
    this.eyeOn = new Set();
    this.selected = null;
    this.flashTimers = [];
    this.mapZoom = 12;
  }

  /* ---------------- lifecycle ---------------- */
  async open() {
    if (!this.map) {
      this.map = new maplibregl.Map({
        container: this.mapEl, style: { version: 8, sources: {}, layers: [] },
        center: [151.3, -33.3], zoom: 12, attributionControl: { compact: true },
      });
      this.map.on('zoom', () => this._onZoom());
      this.mapZoom = this.map.getZoom();
    }
    setTimeout(() => this.map.resize(), 60);
    if (!this.manifest.length) {
      try {
        const r = await fetch(DAEMON + '/api/styles');
        if (r.ok) this.manifest = await r.json();
      } catch (e) {}
      if (!Array.isArray(this.manifest)) this.manifest = [];
    }
    this.panelEl.innerHTML = this._shellHtml();
    this._wireShell();
    if (!this.manifest.length) {
      this.panelEl.querySelector('#siNote').textContent =
        'No styles — is the Dingo daemon running? (GET ' + DAEMON + '/api/styles)';
      return;
    }
    await this.loadStyle(this.styleId || this.manifest[0].id);
  }
  close() { this._clearFlash(); }

  async loadStyle(id) {
    this.styleId = id;
    this.draft = null; this.dirty = false; this.selected = null;
    this.eyeOn = new Set(); this.selectedGroups = null; this.mode = 'day';
    try {
      const r = await fetch(DAEMON + '/api/styles/' + id);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      this.pristineText = await r.text();
      this.draft = JSON.parse(this.pristineText);
      this.editable = true;
    } catch (e) {
      this.panelEl.querySelector('#siNote').textContent = 'Style load failed: ' + e.message;
      return;
    }
    this._applyDraftToMap();
    this.renderAll();
  }

  /* ---------------- draft → live map ---------------- */
  _applyDraftToMap() {
    if (!this.draft || !this.map) return;
    const spec = JSON.parse(JSON.stringify(this.draft).replaceAll('{MAPTILER_KEY}', MAPTILER_KEY));
    const nm = nightMapOf(this.draft);
    if (this.mode === 'night' && nm) applyNightMap(spec, nm);
    this.map.setStyle(spec, { diff: true });
  }

  _mutate(fn) {
    if (!this.draft) return null;
    fn(this.draft);
    this.dirty = true;
    this._renderFoot();
    return this.draft;
  }

  applyEdit(id, location, prop, value) {
    const l = this.draft.layers.find(x => x.id === id);
    if (!l) return;
    this._mutate(() => {
      if (location === 'zoom') {
        let v = value;
        if (v !== undefined) {
          if (prop === 'minzoom' && l.maxzoom !== undefined) v = Math.min(v, l.maxzoom);
          if (prop === 'maxzoom' && l.minzoom !== undefined) v = Math.max(v, l.minzoom);
        }
        if (v === undefined || (prop === 'minzoom' && v <= 0) || (prop === 'maxzoom' && v >= MAX_ZOOM)) delete l[prop];
        else l[prop] = v;
      } else {
        const bag = (l[location] ??= {});
        if (value === undefined) delete bag[prop];
        else bag[prop] = value;
      }
    });
    if (!this.map.getLayer(id)) return;
    if (location === 'zoom') {
      if (this.eyeOn.size === 0) this.map.setLayerZoomRange(id, l.minzoom ?? 0, l.maxzoom ?? MAX_ZOOM);
      this._renderRows();
    } else {
      let live = value;
      const nm = nightMapOf(this.draft);
      if (this.mode === 'night' && nm && typeof value === 'string') {
        const p = parseColor(value);
        if (p && nm[p.hex]) live = withAlpha(nm[p.hex], p.alpha);
      }
      if (location === 'paint') this.map.setPaintProperty(id, prop, live);
      else this.map.setLayoutProperty(id, prop, live);
    }
  }

  recolor(fromHex, toHex) { this._mutate(d => replaceColorGlobal(d, fromHex, toHex)); this._applyDraftToMap(); this._renderRows(); this._renderEditor(); }
  setNightColor(dayHex, nightHex) {
    this._mutate(d => { ((d.metadata ??= {})['dingo:night'] ??= {})[dayHex] = nightHex; });
    if (this.mode === 'night') this._applyDraftToMap();
  }
  setOverlayColor(key, val) {
    this._mutate(d => { ((d.metadata ??= {})['dingo:overlays'] ??= {})[key] = val; });
    this._renderRows();
  }
  switchMode(m) {
    if (m === this.mode) return;
    if (m === 'night' && this.draft && !nightMapOf(this.draft)) {
      this._mutate(d => {
        const mapping = {};
        for (const hex of collectPalette(d)) mapping[hex] = autoNightColor(hex);
        (d.metadata ??= {})['dingo:night'] = mapping;
      });
      this.toast('Night palette auto-generated — tune it in the editor');
    }
    this.mode = m;
    this._applyDraftToMap();
    this.renderAll();
  }

  /* ---------------- solo / flash ---------------- */
  _restoreLayer(id) {
    const l = this.draft.layers.find(x => x.id === id);
    if (!l || !this.map.getLayer(id)) return;
    this.map.setLayoutProperty(id, 'visibility', (l.layout && l.layout.visibility) ?? 'visible');
    this.map.setLayerZoomRange(id, l.minzoom ?? 0, l.maxzoom ?? MAX_ZOOM);
  }
  _applySolo() {
    for (const layer of this.draft.layers) {
      if (!this.map.getLayer(layer.id)) continue;
      if (this.eyeOn.size === 0) {
        this.map.setLayoutProperty(layer.id, 'visibility', (layer.layout && layer.layout.visibility) ?? 'visible');
        this.map.setLayerZoomRange(layer.id, layer.minzoom ?? 0, layer.maxzoom ?? MAX_ZOOM);
      } else if (this.eyeOn.has(layer.id)) {
        this.map.setLayoutProperty(layer.id, 'visibility', 'visible');
        this.map.setLayerZoomRange(layer.id, 0, MAX_ZOOM);
      } else {
        this.map.setLayoutProperty(layer.id, 'visibility', 'none');
      }
    }
  }
  toggleEye(id) {
    if (this.eyeOn.has(id)) this.eyeOn.delete(id); else this.eyeOn.add(id);
    this._applySolo();
    this._renderRows();
  }
  _clearFlash() { this.flashTimers.forEach(clearTimeout); this.flashTimers = []; }
  flashLayer(id) {
    const l = this.draft.layers.find(x => x.id === id);
    if (!l || !this.map.getLayer(id)) return;
    this._clearFlash();
    const props = FLASH_PROPS[l.type] ?? [];
    const originals = props.map(([prop]) => this.map.getPaintProperty(id, prop));
    this.map.setLayoutProperty(id, 'visibility', 'visible');
    this.map.setLayerZoomRange(id, 0, MAX_ZOOM);
    for (const [prop] of props) this.map.setPaintProperty(id, prop + '-transition', { duration: 0, delay: 0 });
    const setOp = on => () => {
      if (!this.map.getLayer(id)) return;
      props.forEach(([prop, fb], i) => this.map.setPaintProperty(id, prop, on ? (originals[i] !== undefined ? originals[i] : fb) : 0));
    };
    const steps = [];
    for (let i = 0; i < 5; i++) { steps.push([i * 500, setOp(true)]); steps.push([i * 500 + 250, setOp(false)]); }
    steps.push([2500, () => {
      if (this.map.getLayer(id)) props.forEach(([prop], i) => {
        this.map.setPaintProperty(id, prop, originals[i]);
        this.map.setPaintProperty(id, prop + '-transition', undefined);
      });
      if (this.eyeOn.size > 0) this._applySolo(); else this._restoreLayer(id);
    }]);
    this.flashTimers = steps.map(([ms, fn]) => setTimeout(fn, ms));
  }

  /* ---------------- save / revert ---------------- */
  async save() {
    if (!this.draft || !this.dirty) return;
    const body = JSON.stringify(this.draft, null, 2) + '\n';
    try {
      const res = await fetch(DAEMON + '/api/styles/' + this.styleId, {
        method: 'PUT', headers: { 'content-type': 'application/json', 'x-dingo-web': '1' }, body,
      });
      if (!res.ok) { this._err(res.status + ': ' + (await res.text()).slice(0, 200)); return; }
      this.pristineText = body;
      this.dirty = false;
      this._err('');
      this._renderFoot();
      this.toast('Saved "' + (this.draft.name || this.styleId) + '" — Plan picks it up on next load');
    } catch (e) { this._err(String(e)); }
  }
  revert() {
    if (this.eyeOn.size) { this.eyeOn = new Set(); }
    this.draft = JSON.parse(this.pristineText);
    this.dirty = false;
    this.selected = null;
    this._err('');
    this._applyDraftToMap();
    this.renderAll();
  }
  _err(msg) { const el = this.panelEl.querySelector('#siErr'); if (el) { el.textContent = msg; el.title = msg; } }

  /* ---------------- rendering ---------------- */
  _shellHtml() {
    return `<div class="si">
      <div class="si-head">
        <select id="siStyle" title="Plan basemap style">${this.manifest.map(m =>
          `<option value="${esc(m.id)}"${m.id === this.styleId ? ' selected' : ''}>${esc(m.label || m.id)}</option>`).join('')}</select>
        <span class="seg" id="siMode"><button data-v="day" class="active">Day</button><button data-v="night" title="Night colours (auto-generated palette on first switch)">Night</button></span>
      </div>
      <div class="si-head"><input id="siName" placeholder="Style name" title="Style name — shown in Plan's base map picker"></div>
      <div class="si-controls">
        <span class="seg" id="siFilter"><button data-v="visible" title="Only the layers drawn at the current zoom">Here</button><button data-v="all" class="active" title="Every layer in the style">All</button></span>
        <label class="si-hid" title="Include layers with visibility: none"><input type="checkbox" id="siHidden" checked> hidden</label>
        <span class="si-zoomstep"><button id="siZo" title="Previous detail level">−</button><span id="siZoomLbl">z—</span><button id="siZi" title="Next detail level">+</button></span>
      </div>
      <div class="si-groups" id="siGroups"></div>
      <div class="si-note" id="siNote"></div>
      <div class="si-axis"><span class="si-axis-pad"></span><span class="si-axis-scale"><span>z0</span><span>z4</span><span>z8</span><span>z12</span><span>z16</span></span></div>
      <div class="si-rows" id="siRows"></div>
      <div class="si-editor" id="siEditor"></div>
      <div class="si-foot"><span class="si-err" id="siErr"></span><button id="siRevert">Revert</button><button id="siSave" class="primary">Save to style</button></div>
    </div>`;
  }
  _wireShell() {
    const q = s => this.panelEl.querySelector(s);
    q('#siStyle').onchange = e => this.loadStyle(e.target.value);
    q('#siMode').onclick = e => { if (e.target.dataset.v) {
      this.switchMode(e.target.dataset.v);
      for (const b of q('#siMode').children) b.classList.toggle('active', b.dataset.v === this.mode);
    } };
    q('#siName').onchange = e => this._mutate(d => { d.name = e.target.value; });
    q('#siFilter').onclick = e => { if (e.target.dataset.v) {
      this.filter = e.target.dataset.v;
      for (const b of q('#siFilter').children) b.classList.toggle('active', b.dataset.v === this.filter);
      this._renderRows();
    } };
    q('#siHidden').onchange = e => { this.showHidden = e.target.checked; this._renderRows(); };
    q('#siZo').onclick = () => this._snap(-1);
    q('#siZi').onclick = () => this._snap(1);
    q('#siRevert').onclick = () => this.revert();
    q('#siSave').onclick = () => this.save();
  }
  _snap(dir) {
    if (!this.draft) return;
    const levels = deriveSnapLevels(this.draft);
    const z = dir === 1 ? nextSnap(levels, this.map.getZoom()) : prevSnap(levels, this.map.getZoom());
    this.map.easeTo({ zoom: z, duration: 250 });
  }
  _onZoom() {
    this.mapZoom = Math.round(this.map.getZoom() * 10) / 10;
    const lbl = this.panelEl.querySelector('#siZoomLbl');
    if (lbl) lbl.textContent = Number.isInteger(this.mapZoom) ? 'z' + this.mapZoom : 'z' + this.mapZoom.toFixed(1);
    clearTimeout(this._zoomT);
    this._zoomT = setTimeout(() => this._renderRows(), 150);
  }

  renderAll() {
    if (!this.draft) return;
    const q = s => this.panelEl.querySelector(s);
    q('#siName').value = this.draft.name || this.styleId;
    q('#siNote').textContent = this.editable ? '' : 'Saving unavailable — daemon styles endpoint not reachable';
    this._onZoom();
    this._renderGroups();
    this._renderRows();
    this._renderEditor();
    this._renderFoot();
  }

  _grouped() {
    const order = [];
    const filtered = new Map();
    for (const layer of this.draft.layers) {
      const g = groupOf(layer);
      if (!filtered.has(g)) { filtered.set(g, []); order.push(g); }
      const vis = (layer.layout && layer.layout.visibility) ?? 'visible';
      const inZoom = this.mapZoom >= (layer.minzoom ?? 0) && this.mapZoom < (layer.maxzoom ?? MAX_ZOOM);
      const shown = vis !== 'none' && inZoom;
      const eye = this.eyeOn.has(layer.id);
      if (this.filter === 'visible' && !shown && !eye) continue;
      if (!this.showHidden && vis === 'none' && !eye) continue;
      filtered.get(g).push(layer);
    }
    let selection = this.selectedGroups;
    if (!selection) {
      selection = new Set(DEFAULT_GROUPS.filter(g => filtered.has(g)));
      if (selection.size === 0 && order.length) selection = new Set([order[0]]);
    }
    return { order, filtered, selection };
  }

  _renderGroups() {
    const { order, filtered, selection } = this._grouped();
    const el = this.panelEl.querySelector('#siGroups');
    const pills = order.map(name =>
      `<button class="si-pill${selection.has(name) ? ' on' : ''}" data-g="${esc(name)}">${esc(name)} <span>${filtered.get(name).length}</span></button>`);
    pills.push(`<button class="si-pill${selection.has(DINGO_GROUP) ? ' on' : ''}" data-g="${DINGO_GROUP}" title="Dingo overlay colours saved in the style (dingo:overlays)">${DINGO_GROUP} <span>${OVERLAY_KEYS.length}</span></button>`);
    el.innerHTML = pills.join('');
    el.onclick = e => {
      const b = e.target.closest('[data-g]');
      if (!b) return;
      const { selection } = this._grouped();
      const next = new Set(selection);
      if (next.has(b.dataset.g)) next.delete(b.dataset.g); else next.add(b.dataset.g);
      this.selectedGroups = next;
      this._renderGroups();
      this._renderRows();
    };
  }

  _renderRows() {
    if (!this.draft) return;
    const { order, filtered, selection } = this._grouped();
    const rows = order.filter(g => selection.has(g)).flatMap(g => filtered.get(g))
      .sort((a, b) => (a.minzoom ?? 0) - (b.minzoom ?? 0) || (a.maxzoom ?? MAX_ZOOM) - (b.maxzoom ?? MAX_ZOOM));
    const overlays = overlaysOf(this.draft) || {};
    const el = this.panelEl.querySelector('#siRows');
    let html = rows.map(layer => {
      const vis = (layer.layout && layer.layout.visibility) ?? 'visible';
      const inZoom = this.mapZoom >= (layer.minzoom ?? 0) && this.mapZoom < (layer.maxzoom ?? MAX_ZOOM);
      const shown = vis !== 'none' && inZoom;
      const eye = this.eyeOn.has(layer.id);
      return `<div class="si-row${shown || eye ? '' : ' dim'}${this.selected === layer.id ? ' sel' : ''}" data-id="${esc(layer.id)}" title="${esc(layer.id)} (${layer.type}) — click to edit + flash on the map">
        <button class="si-eye${eye ? ' on' : ''}" data-eye="${esc(layer.id)}" title="Solo: show ONLY this layer (preview, not saved)">${eye ? '◉' : '○'}</button>
        ${sampleSvg(layer)}<span class="si-lname">${esc(layer.id)}</span>${ganttHtml(layer.minzoom, layer.maxzoom, this.mapZoom, vis === 'none')}</div>`;
    }).join('');
    if (selection.has(DINGO_GROUP)) {
      html += OVERLAY_KEYS.map(key => {
        const col = overlays[key] || '#888888';
        return `<div class="si-row${this.selected === 'overlay:' + key ? ' sel' : ''}" data-id="overlay:${key}" title="${OVERLAY_LABELS[key]} — heat colour saved in the style">
          <span class="si-eye" style="visibility:hidden">○</span>
          <svg class="si-sample" width="40" height="16" viewBox="0 0 40 16"><line x1="2" y1="8" x2="38" y2="8" stroke="${esc(col)}" stroke-width="4" stroke-linecap="round" opacity="0.9"/></svg>
          <span class="si-lname">${OVERLAY_LABELS[key]}</span>${ganttHtml(undefined, undefined, this.mapZoom, false)}</div>`;
      }).join('');
    }
    el.innerHTML = html || `<div class="si-note">${selection.size === 0 ? 'Select a group pill above' : 'No layers here at z' + this.mapZoom.toFixed(1)}</div>`;
    el.onclick = e => {
      const eye = e.target.closest('[data-eye]');
      if (eye) { this.toggleEye(eye.dataset.eye); return; }
      const row = e.target.closest('[data-id]');
      if (!row) return;
      this.selected = row.dataset.id;
      if (!this.selected.startsWith('overlay:')) this.flashLayer(this.selected);
      this._renderRows();
      this._renderEditor();
    };
  }

  /* ---------------- the editor section ---------------- */
  _renderEditor() {
    const el = this.panelEl.querySelector('#siEditor');
    if (!this.selected) { el.innerHTML = ''; return; }
    if (this.selected.startsWith('overlay:')) return this._renderOverlayEditor(el, this.selected.slice(8));
    const layer = this.draft.layers.find(x => x.id === this.selected);
    if (!layer) { el.innerHTML = ''; return; }
    const palette = sortPalette(collectPalette(this.draft));
    const nm = nightMapOf(this.draft);
    const specs = ATTRS_BY_TYPE[layer.type] ?? [];

    let rows = `<div class="si-erow" title="minzoom / maxzoom — blank = no limit"><span class="si-elabel">zoom range</span>
      <span class="si-attr"><input type="number" class="si-num" data-zoom="minzoom" min="0" max="${MAX_ZOOM}" step="1" value="${layer.minzoom ?? ''}" placeholder="0">
      <span class="si-alabel">to</span>
      <input type="number" class="si-num" data-zoom="maxzoom" min="0" max="${MAX_ZOOM}" step="1" value="${layer.maxzoom ?? ''}" placeholder="—"></span></div>`;

    for (const spec of specs) {
      const bag = spec.location === 'paint' ? layer.paint : layer.layout;
      const value = bag && bag[spec.prop];
      if (value === undefined && (spec.kind === 'font' || spec.kind === 'number')) continue;
      rows += `<div class="si-erow" title="${esc(spec.prop)}"><span class="si-elabel">${spec.label}</span>${this._attrControl(layer, spec, value, palette)}</div>`;
    }
    if (palette.length) {
      rows += `<div class="si-erow"><span class="si-elabel">${this.mode === 'night' ? 'night palette' : 'palette'}</span><span class="si-palette">` +
        palette.map(hex => `<input type="color" class="si-swatch-edit" data-pal="${hex}" value="${this.mode === 'night' ? ((nm && nm[hex]) || hex) : hex}" title="${this.mode === 'night' ? hex + ' at night' : hex + ' — change to recolour the whole style'}">`).join('') +
        '</span></div>';
    }

    el.innerHTML = `<div class="si-ehead">${sampleSvg(layer)} <b>${esc(layer.id)}</b><span class="si-etype">${layer.type}</span><button class="si-x" id="siEClose">✕</button></div>
      <div class="si-egrid">${rows}</div>
      <div class="si-note">${this.mode === 'night'
        ? 'Night mode: attribute colours are the DAY values; the night palette maps them.'
        : 'Palette edits recolour every layer using that colour. Complex expressions show as “fx”.'}</div>`;
    this._wireEditor(el, layer, palette);
  }

  _attrControl(layer, spec, value, palette) {
    const d = a => Object.entries(a).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
    const base = { prop: spec.prop, loc: spec.location };
    if (spec.kind === 'color') {
      if (value === undefined) return '<span class="si-attr si-unset">—</span>';
      const parsed = typeof value === 'string' ? parseColor(value) : null;
      if (!parsed) {
        const colors = literalColors(value).slice(0, 2).map(c => `<span class="si-swatch" style="background:${esc(c)}"></span>`).join('');
        return `<span class="si-attr" title="${esc(spec.prop)}: expression — edit in JSON">${colors}<span class="si-fx">fx</span></span>`;
      }
      return `<span class="si-palette">` + palette.map(hex =>
        `<button class="si-swatch-pick${hex === parsed.hex ? ' cur' : ''}" style="background:${hex}" ${d({ ...base, pick: hex, alpha: parsed.alpha })} title="${hex === parsed.hex ? hex + ' (current)' : 'Use ' + hex}"></button>`).join('') +
        `<label class="si-swatch-add" title="Add a new colour to the palette and use it">+<input type="color" ${d({ ...base, add: 1, alpha: parsed.alpha })} value="${parsed.hex}"></label>` +
        (parsed.alpha < 1 ? `<span class="si-alabel">α ${parsed.alpha}</span>` : '') + '</span>';
    }
    if (spec.kind === 'number') {
      const ramp = parseZoomRamp(value);
      if (ramp) return this._formulaHtml(spec, ramp);
      if (typeof value !== 'number') {
        const range = numberRange(value);
        return `<span class="si-attr" title="${esc(spec.prop)}: complex expression">${range ? range[0] + '–' + range[1] : ''}<span class="si-fx">fx</span></span>`;
      }
      const step = spec.prop.includes('opacity') || spec.prop.includes('exaggeration') ? 0.1 : 1;
      return `<span class="si-attr"><input type="number" class="si-num" ${d({ ...base, num: 1 })} step="${step}" value="${value}"></span>`;
    }
    if (spec.kind === 'font') {
      const current = Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined;
      if (current === undefined) return '<span class="si-attr si-unset">—</span>';
      const opts = (FONT_OPTIONS.includes(current) ? [] : [current]).concat(FONT_OPTIONS);
      return `<span class="si-attr"><select class="si-dash" ${d({ ...base, font: 1 })}>` +
        opts.map(f => `<option${f === current ? ' selected' : ''}>${esc(f)}</option>`).join('') + '</select></span>';
    }
    // dasharray
    const current = Array.isArray(value) && !isExpression(value) ? value.join(' ') : value === undefined ? '' : null;
    if (current === null) return `<span class="si-attr"><span class="si-fx">fx</span></span>`;
    const preset = DASH_PRESETS.find(p => (p.value ? p.value.join(' ') : '') === current);
    return `<span class="si-attr"><select class="si-dash" ${d({ ...base, dash: 1 })}>` +
      (!preset ? `<option selected value="__custom">${esc(current || 'custom')}</option>` : '') +
      DASH_PRESETS.map(p => `<option value="${esc(p.label)}"${preset && preset.label === p.label ? ' selected' : ''}>${p.label}</option>`).join('') +
      '</select></span>';
  }

  _formulaHtml(spec, ramp) {
    const [z0] = ramp.stops[0], [z1] = ramp.stops[ramp.stops.length - 1];
    const vals = Array.from({ length: 25 }, (_, i) => evalZoomRamp(ramp, z0 + ((z1 - z0) * i) / 24));
    const vMax = Math.max(...vals, 0.001);
    const pts = vals.map((v, i) => `${2 + (i / 24) * 116},${24 - (v / vMax) * 22}`).join(' ');
    const stops = ramp.stops.map(([z, v], i) =>
      `<span class="si-fstop"><span class="si-alabel">z</span><input type="number" class="si-num narrow" data-fstop="${i}" data-which="0" data-prop="${esc(spec.prop)}" data-loc="${spec.location}" value="${z}" step="1">
       <span class="si-alabel">→</span><input type="number" class="si-num narrow" data-fstop="${i}" data-which="1" data-prop="${esc(spec.prop)}" data-loc="${spec.location}" value="${v}" step="0.25"></span>`).join('');
    return `<span class="si-formula" title="${esc(spec.prop)}: value by zoom">${stops}
      <span class="si-fstop"><span class="si-alabel" title="1 = linear; higher bends toward high zooms">curve</span>
      <input type="number" class="si-num narrow" data-fbase="1" data-prop="${esc(spec.prop)}" data-loc="${spec.location}" value="${ramp.base}" step="0.1" min="0.5" max="2"></span>
      <svg class="si-fcurve" width="120" height="26" viewBox="0 0 120 26"><polyline points="${pts}" fill="none" stroke="#00b6d9" stroke-width="1.5"/></svg></span>`;
  }

  _wireEditor(el, layer, palette) {
    el.querySelector('#siEClose').onclick = () => { this.selected = null; this._renderRows(); this._renderEditor(); };
    for (const inp of el.querySelectorAll('[data-zoom]')) {
      inp.onchange = () => this.applyEdit(layer.id, 'zoom', inp.dataset.zoom,
        inp.value === '' ? undefined : Number(inp.value));
    }
    el.onclick = e => {
      const pick = e.target.closest('[data-pick]');
      if (pick) {
        this.applyEdit(layer.id, pick.dataset.loc, pick.dataset.prop,
          withAlpha(pick.dataset.pick, Number(pick.dataset.alpha)));
        this._renderRows(); this._renderEditor(); // samples + current-swatch outline follow
      }
    };
    for (const inp of el.querySelectorAll('input[data-add]')) {
      inp.oninput = () => {
        this._mutate(d => addPaletteColor(d, inp.value));
        this.applyEdit(layer.id, inp.dataset.loc, inp.dataset.prop, withAlpha(inp.value, Number(inp.dataset.alpha)));
      };
    }
    for (const inp of el.querySelectorAll('input[data-num]')) {
      inp.oninput = () => { const n = Number(inp.value); if (Number.isFinite(n)) this.applyEdit(layer.id, inp.dataset.loc, inp.dataset.prop, n); };
    }
    for (const sel of el.querySelectorAll('select[data-font]')) {
      sel.onchange = () => this.applyEdit(layer.id, sel.dataset.loc, sel.dataset.prop, [sel.value]);
    }
    for (const sel of el.querySelectorAll('select[data-dash]')) {
      sel.onchange = () => {
        const p = DASH_PRESETS.find(x => x.label === sel.value);
        if (p) { this.applyEdit(layer.id, 'paint', sel.dataset.prop, p.value ?? undefined); this._renderRows(); }
      };
    }
    const rampOf = prop => {
      const bag = layer.paint && layer.paint[prop] !== undefined ? layer.paint : layer.layout;
      return parseZoomRamp(bag && bag[prop]);
    };
    for (const inp of el.querySelectorAll('input[data-fstop]')) {
      inp.onchange = () => {
        const r = rampOf(inp.dataset.prop);
        if (!r) return;
        r.stops[Number(inp.dataset.fstop)][Number(inp.dataset.which)] = Number(inp.value);
        this.applyEdit(layer.id, inp.dataset.loc, inp.dataset.prop, buildZoomRamp(r));
      };
    }
    for (const inp of el.querySelectorAll('input[data-fbase]')) {
      inp.onchange = () => {
        const r = rampOf(inp.dataset.prop);
        const n = Number(inp.value);
        if (r && Number.isFinite(n) && n > 0) { r.base = n; this.applyEdit(layer.id, inp.dataset.loc, inp.dataset.prop, buildZoomRamp(r)); }
      };
    }
    for (const inp of el.querySelectorAll('input[data-pal]')) {
      inp.onchange = () => this.mode === 'night'
        ? this.setNightColor(inp.dataset.pal, inp.value)
        : this.recolor(inp.dataset.pal, inp.value);
    }
  }

  _renderOverlayEditor(el, key) {
    const overlays = overlaysOf(this.draft) || {};
    const val = overlays[key] || '#888888';
    const parsed = parseColor(val) || { hex: '#888888', alpha: 1 };
    const palette = sortPalette(collectPalette(this.draft));
    el.innerHTML = `<div class="si-ehead"><b>${OVERLAY_LABELS[key]}</b><span class="si-etype">Dingo layer</span><button class="si-x" id="siEClose">✕</button></div>
      <div class="si-egrid"><div class="si-erow" title="Saved into the style (dingo:overlays.${key})"><span class="si-elabel">colour</span><span class="si-palette">` +
      palette.map(hex => `<button class="si-swatch-pick${hex === parsed.hex ? ' cur' : ''}" style="background:${hex}" data-opick="${hex}" title="Use ${hex}"></button>`).join('') +
      `<label class="si-swatch-add" title="New colour">+<input type="color" id="siONew" value="${parsed.hex}"></label></span></div></div>
      <div class="si-note">Saved into the style file — Plan's heat layers read it; night mode remaps it with the rest of the palette.</div>`;
    el.querySelector('#siEClose').onclick = () => { this.selected = null; this._renderRows(); this._renderEditor(); };
    el.onclick = e => {
      const b = e.target.closest('[data-opick]');
      if (b) { this.setOverlayColor(key, withAlpha(b.dataset.opick, parsed.alpha)); this._renderEditor(); }
    };
    el.querySelector('#siONew').oninput = e => {
      this._mutate(d => addPaletteColor(d, e.target.value));
      this.setOverlayColor(key, withAlpha(e.target.value, parsed.alpha));
    };
  }

  _renderFoot() {
    const q = s => this.panelEl.querySelector(s);
    if (!q('#siSave')) return;
    q('#siSave').disabled = !this.dirty || !this.editable;
    q('#siRevert').disabled = !this.dirty;
  }
}
