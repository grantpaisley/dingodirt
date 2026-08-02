/* Editor — token panel, scheme lifecycle (New/Duplicate/Import/Export/Save),
   .dingoscheme zip I/O, ?scheme= URL install (the remix flow), test-drive bar. */

import { TOKEN_GROUPS, TOKEN_DEFS, tok, newScheme, validateScheme, SCHEMA_VERSION } from './scheme.js';
import { BASE_MAP } from './applier-nav.js';
import { NavView, BASE, SOUND, unlockAudio } from './navview.js';
import { Replay } from './replay.js';
import { idb } from './idb.js';

const $ = id => document.getElementById(id);

export function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 3500);
  console.log('[studio]', msg);
}

export const ED = {
  scheme: null, view: null, engine: new Replay(),
  trk: null, heat: null, framing: 'nav', dirty: false,
};

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
  $('schemeName').value = scheme.name;
  $('schemeAuthor').value = scheme.author;
  buildPanel();
  saveDraft();
  if (ED.view) ED.view.setScheme(scheme, { rebuild });
  document.title = scheme.name + ' — Dingo Studio';
}

function setToken(key, value) {
  if (value == null) delete ED.scheme.tokens[key];
  else ED.scheme.tokens[key] = value;
  saveDraft();
  const rebuild = key === 'basemap.base';
  ED.view.setScheme(ED.scheme, { rebuild })
    .catch(e => { console.error(e); toast('Preview update failed: ' + e.message); });
}

/* base style's own value for an inherit-mode basemap colour (placeholder swatch) */
function baseValueFor(key) {
  const m = BASE_MAP[key];
  const file = tok(ED.scheme, 'basemap.base') === 'light' ? 'layers-light.json' : 'layers.json';
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
  const row = document.createElement('div');
  row.className = 'trow';
  const lab = document.createElement('label'); lab.textContent = def.label;
  row.appendChild(lab);
  const cur = ED.scheme.tokens[key];

  if (def.type === 'color') {
    const inherit = def.def == null; // basemap colours can defer to the base style
    const wrap = document.createElement('span'); wrap.className = 'cwrap';
    const inp = document.createElement('input'); inp.type = 'color';
    inp.value = cur != null ? cur.slice(0, 7) : (inherit ? baseValueFor(key) : def.def);
    if (inherit && cur == null) wrap.classList.add('inherited');
    inp.oninput = () => { wrap.classList.remove('inherited'); setToken(key, inp.value); };
    wrap.appendChild(inp);
    if (inherit) {
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
    inp.oninput = () => { val.textContent = inp.value; setToken(key, parseFloat(inp.value)); };
    row.appendChild(inp); row.appendChild(val);
  } else if (def.type === 'bool') {
    const inp = document.createElement('input'); inp.type = 'checkbox';
    inp.checked = cur != null ? cur : def.def;
    inp.onchange = () => setToken(key, inp.checked);
    row.appendChild(inp);
  } else if (def.type === 'select') {
    const seg = document.createElement('span'); seg.className = 'seg';
    for (const o of def.opts) {
      const b = document.createElement('button'); b.textContent = o;
      b.classList.toggle('active', (cur != null ? cur : def.def) === o);
      b.onclick = () => { setToken(key, o);
        for (const x of seg.children) x.classList.toggle('active', x === b); };
      seg.appendChild(b);
    }
    row.appendChild(seg);
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
export async function refreshLibrary() {
  const recs = (await idb.all()).filter(r => r.kind === 'scheme').sort((a, b) => b.savedAt - a.savedAt);
  const sel = $('library');
  sel.innerHTML = '<option value="">Library…</option>' +
    recs.map(r => `<option value="${r.id}">${r.scheme.name}${r.scheme.author ? ' — ' + r.scheme.author : ''}</option>`).join('');
}

/* ---------------- test-drive bar ---------------- */
function fmtKm(m) { return (m / 1000).toFixed(1) + ' km'; }

function wireTestDrive() {
  const eng = ED.engine;
  eng.addSink((...a) => ED.view.onFix(...a));
  eng.onState = () => {
    $('playBtn').innerHTML = `<svg class="ic"><use href="#i-${eng.playing ? 'pause' : 'play'}"/></svg>`;
    const sc = $('scrub');
    if (eng.trk) { sc.max = Math.round(eng.trk.lengthM); if (!sc._drag) sc.value = Math.round(eng.d); }
    $('scrubLbl').textContent = eng.trk ? fmtKm(eng.d) + ' / ' + fmtKm(eng.trk.lengthM) : '—';
    if (eng.finished) { toast('Test drive finished'); ED.view.stopNav(); staticHud(); }
  };
  $('playBtn').onclick = () => {
    unlockAudio();
    if (!eng.playing && !ED.view.navving) { ED.view.startNav(); ED.view.clearTrail(); }
    eng.toggle();
  };
  const sc = $('scrub');
  sc.oninput = () => { sc._drag = true; eng.seek(parseFloat(sc.value)); };
  sc.onchange = () => { sc._drag = false; };
  $('rate').onchange = () => eng.setRate(parseFloat($('rate').value));
  $('offBtn').onclick = () => { if (eng.playing) eng.simulateOffTrack(5); else toast('Press play first'); };
  $('muteBtn').onclick = () => {
    SOUND.on = !SOUND.on;
    $('muteBtn').innerHTML = `<svg class="ic"><use href="#i-volume-${SOUND.on ? '2' : 'x'}"/></svg>`;
    $('muteBtn').classList.toggle('off', !SOUND.on);
  };
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

/* ---------------- framing (Nav mode / Plan mode) + viewport chips ---------------- */
function setFraming(mode) {
  ED.framing = mode;
  $('stage').classList.toggle('plan', mode === 'plan');
  for (const b of $('framingSeg').children) b.classList.toggle('active', b.dataset.v === mode);
  setTimeout(() => ED.view.map.resize(), 50);
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

  ED.view = new NavView($('frame'), { scheme: ED.scheme, orient: 'course' });
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
    if (!e.target.value) return;
    const rec = await idb.get(e.target.value);
    if (rec) { setScheme(validateScheme(rec.scheme), { rebuild: true }); toast('Loaded "' + rec.scheme.name + '"'); }
    e.target.value = '';
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
