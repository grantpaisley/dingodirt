/* Editor — token panel, scheme lifecycle (New/Duplicate/Import/Export/Save),
   .dingoscheme zip I/O, ?scheme= URL install (the remix flow), test-drive bar. */

import { TOKEN_GROUPS, TOKEN_DEFS, tok, newScheme, validateScheme, resolveScheme, SCHEMA_VERSION } from './scheme.js';
import { BASE_MAP } from './applier-nav.js';
import { NavView, BASE, SOUND, unlockAudio } from './navview.js';
import { Replay } from './replay.js';
import { DemoGrid } from './demogrid.js';
import { wirePlayback } from './playback.js';
import { idb } from './idb.js';

const $ = id => document.getElementById(id);

export function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 3500);
  console.log('[studio]', msg);
}
window.__toast = toast; // playback bar reaches it without importing the editor

export const ED = {
  scheme: null, view: null, grid: null, engine: new Replay(),
  trk: null, heat: null, framing: 'nav', mode: 'day', dirty: false,
};

/* the flattened scheme the preview renders — day tokens + night overlay */
const viewScheme = () => resolveScheme(ED.scheme, ED.mode);

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scheme';

/* ---------------- scheme lifecycle ---------------- */
function saveDraft() {
  localStorage.setItem('dingostudio-draft', JSON.stringify(ED.scheme));
}
export function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem('dingostudio-draft') || 'null');
    if (d) return validateScheme(d);
  } catch (e) {}
  return null;
}

export function setScheme(scheme, { rebuild = false } = {}) {
  ED.scheme = scheme;
  if (!ED.scheme.night) ED.scheme.night = {};
  $('schemeName').value = scheme.name;
  $('schemeAuthor').value = scheme.author;
  buildPanel();
  saveDraft();
  if (ED.view) ED.view.setScheme(viewScheme(), { rebuild });
  if (ED.grid) ED.grid.refreshCurrent().catch(console.error);
  document.title = scheme.name + ' — Dingo Studio';
}

export function setMode(mode) {
  ED.mode = mode;
  for (const b of $('modeSeg').children) b.classList.toggle('active', b.dataset.v === mode);
  buildPanel();
  ED.view.setScheme(viewScheme())
    .catch(e => { console.error(e); toast('Preview update failed: ' + e.message); });
  if (ED.grid) ED.grid.refreshAll().catch(console.error);
}

/* Day edits write the base tokens; Night edits write the night overlay, so a
   scheme carries both looks and apps can flip between them. */
function setToken(key, value) {
  const store = ED.mode === 'night' ? ED.scheme.night : ED.scheme.tokens;
  if (value == null) delete store[key];
  else store[key] = value;
  saveDraft();
  const rebuild = key === 'basemap.base';
  ED.view.setScheme(viewScheme(), { rebuild })
    .catch(e => { console.error(e); toast('Preview update failed: ' + e.message); });
  if (ED.grid) ED.grid.refreshCurrent().catch(console.error);
}

/* base style's own value for an inherit-mode basemap colour (placeholder swatch) */
function baseValueFor(key) {
  const m = BASE_MAP[key];
  const file = tok(viewScheme(), 'basemap.base') === 'light' ? 'layers-light.json' : 'layers.json';
  const layers = BASE.layerCache[file] || [];
  if (key === 'basemap.labelText' || key === 'basemap.labelHalo') {
    const l = layers.find(x => x.id === 'roads_labels_minor');
    const v = l && l.paint && l.paint[key.endsWith('Halo') ? 'text-halo-color' : 'text-color'];
    return typeof v === 'string' ? v : '#888888';
  }
  if (!m) return '#888888';
  const [ids, prop] = m;
  for (const id of ids) {
    const l = layers.find(x => x.id === id);
    const v = l && l.paint && l.paint[prop];
    if (typeof v === 'string' && v.startsWith('#')) return v;
  }
  return '#888888';
}

/* ---------------- token panel ---------------- */
function buildPanel() {
  const panel = $('tokens');
  const openGroups = new Set([...panel.querySelectorAll('details[open]')].map(d => d.dataset.g));
  panel.innerHTML = '';
  for (const g of TOKEN_GROUPS) {
    const det = document.createElement('details');
    det.dataset.g = g.key;
    if (openGroups.size ? openGroups.has(g.key) : g.key === 'basemap') det.open = true;
    const sum = document.createElement('summary'); sum.textContent = g.label;
    det.appendChild(sum);
    for (const [key, def] of Object.entries(g.tokens)) det.appendChild(tokenRow(key, def));
    panel.appendChild(det);
  }
}

function tokenRow(key, def) {
  const night = ED.mode === 'night';
  const dayVal = ED.scheme.tokens[key];
  const overridden = night && key in ED.scheme.night;
  const cur = night ? (overridden ? ED.scheme.night[key] : dayVal) : dayVal;

  const row = document.createElement('div');
  row.className = 'trow' + (overridden ? ' nightset' : '');
  const lab = document.createElement('label'); lab.textContent = def.label;
  row.appendChild(lab);

  // night mode: every row gets a ↺ back to the day value
  const nightReset = () => {
    const rst = document.createElement('button'); rst.className = 'reset'; rst.title = 'Back to day value';
    rst.innerHTML = '&#8634;';
    rst.onclick = () => { setToken(key, null); buildPanel(); };
    return rst;
  };

  if (def.type === 'color') {
    const inherit = def.def == null; // basemap colours can defer to the base style
    const wrap = document.createElement('span'); wrap.className = 'cwrap';
    const inp = document.createElement('input'); inp.type = 'color';
    inp.value = cur != null ? cur.slice(0, 7) : (inherit ? baseValueFor(key) : def.def);
    if ((inherit && cur == null) || (night && !overridden)) wrap.classList.add('inherited');
    inp.oninput = () => { wrap.classList.remove('inherited'); row.classList.toggle('nightset', night); setToken(key, inp.value); };
    wrap.appendChild(inp);
    if (night) wrap.appendChild(nightReset());
    else if (inherit) {
      const rst = document.createElement('button'); rst.className = 'reset'; rst.title = 'Back to base style';
      rst.innerHTML = '&#8634;';
      rst.onclick = () => { setToken(key, null); inp.value = baseValueFor(key); wrap.classList.add('inherited'); };
      wrap.appendChild(rst);
    }
    row.appendChild(wrap);
  } else if (def.type === 'number') {
    const inp = document.createElement('input'); inp.type = 'range';
    inp.min = def.min; inp.max = def.max; inp.step = def.step;
    inp.value = cur != null ? cur : def.def;
    const val = document.createElement('span'); val.className = 'tval'; val.textContent = inp.value;
    inp.oninput = () => { val.textContent = inp.value; row.classList.toggle('nightset', night); setToken(key, parseFloat(inp.value)); };
    row.appendChild(inp); row.appendChild(val);
    if (night) row.appendChild(nightReset());
  } else if (def.type === 'bool') {
    const inp = document.createElement('input'); inp.type = 'checkbox';
    inp.checked = cur != null ? cur : def.def;
    inp.onchange = () => { row.classList.toggle('nightset', night); setToken(key, inp.checked); };
    row.appendChild(inp);
    if (night) row.appendChild(nightReset());
  } else if (def.type === 'select') {
    const seg = document.createElement('span'); seg.className = 'seg';
    for (const o of def.opts) {
      const b = document.createElement('button'); b.textContent = o;
      b.classList.toggle('active', (cur != null ? cur : def.def) === o);
      b.onclick = () => { row.classList.toggle('nightset', night); setToken(key, o);
        for (const x of seg.children) x.classList.toggle('active', x === b); };
      seg.appendChild(b);
    }
    row.appendChild(seg);
    if (night) row.appendChild(nightReset());
  }
  return row;
}

/* ---------------- .dingoscheme I/O ---------------- */
function schemeJson() {
  const { unknown, ...s } = ED.scheme;
  return JSON.stringify(s, null, 2);
}

export async function exportScheme() {
  const files = { 'scheme.json': fflate.strToU8(schemeJson()) };
  try {
    const url = ED.view.capturePng();
    const b64 = url.split(',')[1];
    files['preview.png'] = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  } catch (e) { console.warn('preview capture failed', e); }
  const zip = fflate.zipSync(files, { level: 6 });
  const blob = new Blob([zip], { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = slug(ED.scheme.name) + '.dingoscheme';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Exported ' + a.download);
}

export function parseSchemeFile(buf, name) {
  const bytes = new Uint8Array(buf);
  let text;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) { // PK zip
    const files = fflate.unzipSync(bytes);
    const entry = files['scheme.json'] || files[Object.keys(files).find(k => k.endsWith('scheme.json'))];
    if (!entry) throw new Error('No scheme.json inside ' + name);
    text = fflate.strFromU8(entry);
  } else text = new TextDecoder().decode(bytes);
  return validateScheme(JSON.parse(text));
}

export async function importSchemeFile(file) {
  try {
    const scheme = parseSchemeFile(await file.arrayBuffer(), file.name);
    setScheme(scheme, { rebuild: true });
    await saveToLibrary(false);
    toast('Imported "' + scheme.name + '"' + (scheme.unknown.length ? ' (' + scheme.unknown.length + ' unknown tokens kept)' : ''));
  } catch (e) { toast('Import failed: ' + e.message); }
}

/* ?scheme=<url>[,<url>…] — install; the last one opens for editing (remix flow) */
export async function handleSchemeParam() {
  const p = new URLSearchParams(location.search).get('scheme');
  if (!p) return false;
  let last = null;
  for (const url of p.split(',')) {
    try {
      const resp = await fetch(url.trim());
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const scheme = parseSchemeFile(await resp.arrayBuffer(), url);
      await idb.put({ id: 'scheme-' + slug(scheme.name), kind: 'scheme', scheme, savedAt: Date.now() });
      last = scheme;
    } catch (e) { toast('Scheme install failed: ' + e.message); }
  }
  if (last) {
    history.replaceState(null, '', location.pathname + location.hash); // strip only after success
    setScheme(last, { rebuild: true });
    toast('"' + last.name + '" installed — remix away');
    refreshLibrary();
    return true;
  }
  return false;
}

/* ---------------- scheme library (IDB) ---------------- */
export async function saveToLibrary(announce = true) {
  ED.scheme.name = $('schemeName').value.trim() || 'Untitled scheme';
  ED.scheme.author = $('schemeAuthor').value.trim();
  await idb.put({ id: 'scheme-' + slug(ED.scheme.name), kind: 'scheme',
    scheme: JSON.parse(schemeJson()), savedAt: Date.now() });
  await refreshLibrary();
  if (announce) toast('Saved "' + ED.scheme.name + '" to library');
}
let BUILTINS = null;
export async function builtinList() {
  if (BUILTINS) return BUILTINS;
  try { BUILTINS = await (await fetch('schemes/index.json')).json(); }
  catch (e) { BUILTINS = []; }
  return BUILTINS;
}
export async function refreshLibrary() {
  const builtins = await builtinList();
  const recs = (await idb.all()).filter(r => r.kind === 'scheme').sort((a, b) => b.savedAt - a.savedAt);
  const sel = $('library');
  sel.innerHTML = '<option value="">Library…</option>' +
    '<optgroup label="Built-in">' +
    builtins.map(b => `<option value="builtin:${b.id}">${b.label}</option>`).join('') +
    '</optgroup>' +
    (recs.length ? '<optgroup label="My library">' +
      recs.map(r => `<option value="${r.id}">${r.scheme.name}${r.scheme.author ? ' — ' + r.scheme.author : ''}</option>`).join('') +
      '</optgroup>' : '');
}
export async function loadBuiltin(id) {
  const b = (await builtinList()).find(x => x.id === id);
  if (!b) return;
  const scheme = validateScheme(await (await fetch('schemes/' + b.file)).json());
  setScheme(scheme, { rebuild: true });
  toast('Loaded "' + scheme.name + '" — Save or Duplicate to make it yours');
}

/* ---------------- test-drive bar ---------------- */
function wireTestDrive() {
  const eng = ED.engine;
  eng.addSink((...a) => ED.view.onFix(...a));
  wirePlayback(eng, {
    beforePlay() {
      if (!ED.view.navving) { ED.view.startNav(); ED.view.clearTrail(); }
      if (ED.grid) ED.grid.startNavAll();
    },
    onFinish() {
      toast('Test drive finished');
      ED.view.stopNav(); staticHud();
      if (ED.grid) ED.grid.stopNavAll();
    },
  });
}

/* static HUD preview so the chrome is styleable without riding */
function staticHud() {
  const v = ED.view;
  v.$('.nv-hud').classList.add('on');
  v.$('.nv-speed').classList.add('on');
  v.$('.nv-hudBox').style.visibility = '';
  v.$('.nv-hudArrow').innerHTML = '<svg class="ic"><use href="#i-corner-up-left"/></svg>';
  v.$('.nv-hudType').textContent = 'Turn left · onto dirt';
  v.$('.nv-hudDist').innerHTML = '120 <small>m</small>';
  v.$('.nv-hudFill').style.width = '40%';
  v.$('.nv-speed').innerHTML = '34 <small>km/h</small>';
}

/* ---------------- framing (Nav / Plan / Multi-view) + viewport chips ---------------- */
async function ensureGrid() {
  if (ED.grid) return;
  ED.grid = new DemoGrid($('dgWrap'), {
    engine: ED.engine, trk: ED.trk, heat: ED.heat,
    builtins: await builtinList(),
    current: () => ED.scheme,
    mode: () => ED.mode,
  });
  await ED.grid.addView('portrait', 'current'); // the demo doubles as an A/B rig — add views to compare
}
function setFraming(mode) {
  ED.framing = mode;
  $('stage').classList.toggle('plan', mode === 'plan');
  $('stage').classList.toggle('multi', mode === 'multi');
  for (const b of $('framingSeg').children) b.classList.toggle('active', b.dataset.v === mode);
  if (mode === 'multi') ensureGrid().catch(e => { console.error(e); toast('Multi-view failed: ' + e.message); });
  setTimeout(() => { ED.view.map.resize(); if (ED.grid) for (const v of ED.grid.views) v.nav.map && v.nav.map.resize(); }, 60);
}
function setViewport(v) {
  const f = $('frame');
  f.dataset.vp = v;
  for (const b of $('vpSeg').children) b.classList.toggle('active', b.dataset.v === v);
  setTimeout(() => { ED.view.map.resize(); }, 260); // after the CSS transition
}

/* ---------------- boot ---------------- */
export async function initEditor({ trk, heat }) {
  ED.trk = trk; ED.heat = heat;

  ED.view = new NavView($('frame'), { scheme: viewScheme(), orient: 'course' });
  await ED.view.init();
  ED.view.setData({ trk, heat });
  ED.view.fitTrack();
  ED.engine.setTrack(trk);
  staticHud();

  // plan-mode skeleton lives beside the map, themed by the same CSS vars
  buildPlanSkeleton();

  wireTestDrive();
  $('framingSeg').onclick = e => { if (e.target.dataset.v) setFraming(e.target.dataset.v); };
  $('vpSeg').onclick = e => { if (e.target.dataset.v) setViewport(e.target.dataset.v); };
  $('modeSeg').onclick = e => { if (e.target.dataset.v) setMode(e.target.dataset.v); };

  $('schemeName').onchange = () => { ED.scheme.name = $('schemeName').value; saveDraft(); };
  $('schemeAuthor').onchange = () => { ED.scheme.author = $('schemeAuthor').value; saveDraft(); };
  $('newBtn').onclick = () => { if (confirm('Start a new scheme? Unsaved edits are kept in the library only if you saved them.')) setScheme(newScheme('Untitled scheme', ED.scheme.author), { rebuild: true }); };
  $('dupBtn').onclick = () => {
    const c = JSON.parse(schemeJson());
    c.name = c.name.replace(/ remix( \d+)?$/, '') + ' remix';
    setScheme(c); toast('Duplicated — you are editing the copy');
  };
  $('importBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = e => { if (e.target.files[0]) importSchemeFile(e.target.files[0]); e.target.value = ''; };
  $('exportBtn').onclick = exportScheme;
  $('saveBtn').onclick = () => saveToLibrary();
  $('library').onchange = async e => {
    const v = e.target.value;
    e.target.value = '';
    if (!v) return;
    if (v.startsWith('builtin:')) return loadBuiltin(v.slice(8));
    const rec = await idb.get(v);
    if (rec) { setScheme(validateScheme(rec.scheme), { rebuild: true }); toast('Loaded "' + rec.scheme.name + '"'); }
  };
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) importSchemeFile(f);
  });
  await refreshLibrary();
}

function buildPlanSkeleton() {
  const el = document.createElement('div');
  el.id = 'planChrome';
  el.innerHTML = `
    <div class="pc-top"><b>Dingo Plan</b>
      <span class="pc-chips"><span class="chip on">Heat</span><span class="chip on">Tracks</span><span class="chip">Marks</span><span class="chip">Sat</span></span>
    </div>
    <div class="pc-side">
      <div class="pc-search"></div>
      ${'<div class="pc-row"><span class="pc-dot"></span><span class="pc-bar"></span></div>'.repeat(6)}
      <div class="pc-stats"><span></span><span></span><span></span></div>
    </div>`;
  $('frame').appendChild(el);
}
