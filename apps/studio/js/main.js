/* Boot — editor by default, public showcase at #demo (replaces Nav's demo mode). */

import { newScheme, validateScheme, resolveScheme } from './scheme.js';
import { parseGPX, processTrack, processHeatmap } from './geom.js';
import { analyzeRoute } from './cues.js';
import { initMapBase, BASE, NavView, unlockAudio } from './navview.js';
import { Replay } from './replay.js';
import { idb } from './idb.js';
import { ED, setScheme, loadDraft, handleSchemeParam, initEditor, toast, parseSchemeFile } from './editor.js';

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
  cuedTrack(trk, heat).then(() => {
    ED.view.refreshAlerts();
    toast((trk.alerts || []).length + ' cues ready — hit play to test-drive');
  });
}

/* #demo — auto-plays the bundled sample ride, no editing UI. The link that
   replaces DingoNav's built-in demo mode. */
async function bootDemo() {
  document.body.classList.add('demo');
  let scheme = null;
  const p = new URLSearchParams(location.search).get('scheme');
  if (p) {
    try { const resp = await fetch(p.split(',')[0]); scheme = parseSchemeFile(await resp.arrayBuffer(), p); }
    catch (e) { console.warn('demo scheme load failed', e); }
  }
  if (!scheme) {
    try { scheme = validateScheme(await (await fetch('schemes/default.json')).json()); }
    catch (e) { scheme = newScheme('Dingo default', 'Dingo'); }
  }
  const mode = new URLSearchParams(location.search).get('mode') === 'night' ? 'night' : 'day';
  const { trk, heat } = await loadSampleData();
  const view = new NavView(document.getElementById('demoFrame'), { scheme: resolveScheme(scheme, mode), orient: 'course' });
  await view.init();
  view.setData({ trk, heat });
  view.fitTrack();
  const engine = new Replay();
  engine.setTrack(trk);
  engine.addSink((...a) => view.onFix(...a));
  engine.onState = () => { if (engine.finished) { engine.seek(0); engine.play(); } }; // loop the ride
  await cuedTrack(trk, heat);
  view.refreshAlerts();
  view.startNav();
  engine.play();
  document.getElementById('demoStart').onclick = () => { unlockAudio(); document.getElementById('demoStart').remove(); };
  window.__demo = { view, engine };
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
