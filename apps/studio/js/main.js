/* Boot — editor by default, public showcase at #demo (replaces Nav's demo mode). */

import { newScheme, validateScheme, resolveScheme } from './scheme.js';
import { parseGPX, processTrack, processHeatmap } from './geom.js';
import { analyzeRoute } from './cues.js';
import { initMapBase, BASE, NavView, unlockAudio } from './navview.js';
import { Replay } from './replay.js';
import { DemoGrid } from './demogrid.js';
import { wirePlayback } from './playback.js';
import { idb } from './idb.js';
import { ED, setScheme, loadDraft, handleSchemeParam, initEditor, toast, parseSchemeFile, builtinList } from './editor.js';
import { StyleInspector } from './styleinspector.js';
import { NavObjects } from './navobjects.js';

const SAMPLE_GPX = 'sample-data/Palm_Dale_loop_23_kms_2.1_hrs_on_2020-02-19.gpx';
const SAMPLE_HEAT = 'sample-data/heatmap-central-coast.geojson';

async function loadSampleData() {
  const heatJson = await (await fetch(SAMPLE_HEAT)).json();
  const heat = processHeatmap(heatJson); // seeds REF from the first feature
  const gpxText = await (await fetch(SAMPLE_GPX)).text();
  const g = parseGPX(gpxText, 'Palm Dale loop');
  const trk = processTrack('sample', g.name, g.pts);
  return { trk, heat };
}

/* cue analysis with an IDB cache — the corridor decode costs a few seconds */
async function cuedTrack(trk, heat) {
  const key = 'cues-' + trk.id + '-' + trk.n + '-v1';
  try { const rec = await idb.get(key); if (rec) { trk.alerts = rec.cues; return; } } catch (e) {}
  await analyzeRoute(trk, BASE.pm, heat);
  try { await idb.put({ id: key, kind: 'cues', cues: trk.alerts }); } catch (e) {}
}

async function bootEditor() {
  const { trk, heat } = await loadSampleData();
  ED.scheme = loadDraft() || newScheme('My scheme', '');
  await initEditor({ trk, heat });
  setScheme(ED.scheme); // sync panel + title (view already has it)
  await handleSchemeParam(); // installs + applies via setScheme when present
  wireWorkspaces();
  cuedTrack(trk, heat).then(() => {
    ED.view.refreshAlerts();
    toast((trk.alerts || []).length + ' cues ready — hit play to test-drive');
  });
}

/* Schemes (the token editor) | Nav objects (object-first) | Plan styles (from Plan) */
let inspector = null, navObjects = null;
function wireWorkspaces() {
  const seg = document.getElementById('wsSeg');
  seg.onclick = e => {
    const ws = e.target.dataset.v;
    if (!ws) return;
    document.body.classList.toggle('ws-styles', ws === 'styles');
    document.body.classList.toggle('ws-objects', ws === 'objects');
    for (const b of seg.children) b.classList.toggle('active', b.dataset.v === ws);
    if (ws === 'styles') {
      ED.engine.pause();
      if (navObjects) navObjects.close();
      if (!inspector) inspector = new StyleInspector({
        panelEl: document.getElementById('inspector'),
        mapEl: document.getElementById('styleMap'), toast });
      inspector.open().catch(e2 => toast('Plan styles failed: ' + e2.message));
    } else if (ws === 'objects') {
      if (inspector) inspector.close();
      if (!navObjects) navObjects = new NavObjects();
      navObjects.open();
      setTimeout(() => ED.view.map.resize(), 60);
    } else {
      if (inspector) inspector.close();
      if (navObjects) navObjects.close();
      setTimeout(() => ED.view.map.resize(), 60);
    }
  };
}

/* #demo — auto-plays the bundled sample ride, no editing UI. The link that
   replaces DingoNav's built-in demo mode. One portrait view by default; the
   add-view chips + per-view scheme dropdowns make it the A/B comparison rig. */
async function bootDemo() {
  document.body.classList.add('demo');
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') === 'night' ? 'night' : 'day';
  let extra = null;
  const p = params.get('scheme');
  if (p) {
    try {
      const resp = await fetch(p.split(',')[0]);
      const s = parseSchemeFile(await resp.arrayBuffer(), p);
      extra = { label: s.name, scheme: s };
    } catch (e) { console.warn('demo scheme load failed', e); }
  }
  const { trk, heat } = await loadSampleData();
  await cuedTrack(trk, heat);
  const engine = new Replay();
  engine.setTrack(trk);
  const grid = new DemoGrid(document.getElementById('demoFrame'), {
    engine, trk, heat,
    builtins: await builtinList(),
    current: null, extra, mode: () => mode,
  });
  await grid.addView('portrait');
  wirePlayback(engine, {
    beforePlay: () => grid.startNavAll(),
    onFinish: () => { engine.seek(0); engine.play(); }, // loop the ride
  });
  grid.startNavAll();
  engine.play();
  document.getElementById('demoStart').onclick = () => { unlockAudio(); document.getElementById('demoStart').remove(); };
  window.__demo = { grid, engine };
}

async function boot() {
  await idb.open();
  await initMapBase(idb);
  if (location.hash === '#demo') await bootDemo();
  else await bootEditor();
  window.addEventListener('hashchange', () => location.reload());
}
boot().catch(e => { console.error(e); toast('Boot failed: ' + e.message); });
window.__ed = ED;
