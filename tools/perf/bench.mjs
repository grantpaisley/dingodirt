#!/usr/bin/env node
// Map performance harness. Drives Nav, Studio and Plan in headless Chromium
// (SwiftShader WebGL) against the committed Central Coast tile archive and
// reports style build, first render, zoom, pan and follow-mode frame times.
//
//   node tools/perf/bench.mjs [--apps nav,studio,plan] [--runs 3] [--label name]
//   node tools/perf/bench.mjs --compare baseline candidate
//
// Numbers are software-rendered, so absolute values are not phone numbers;
// the harness exists for A/B comparison of code changes under one fixed
// setup. Every run uses a fresh browser context (cold IndexedDB, cold tile
// cache) so runs are comparable. Prerequisites: `npm install` here, and for
// Plan `VITE_BASE=/plan/ npm run build` in apps/plan.
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { startServer } from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CACHE = join(HERE, '.cache');
const RESULTS = join(HERE, 'results');
const STUDIO_DATA = join(ROOT, 'apps/studio/sample-data');
const SAMPLE_GPX = join(STUDIO_DATA, 'Palm_Dale_loop_23_kms_2.1_hrs_on_2020-02-19.gpx');
const SAMPLE_HEAT = join(STUDIO_DATA, 'heatmap-central-coast.geojson');

// Palm Dale loop, Central Coast NSW — inside the committed archive.
const TRACK_CENTER = [151.365, -33.3133];
// Each zoom step lands on a different part of the archive so no step is
// served from the tile cache of the previous one (the archive's basemap
// maxzoom is 14; 16 and 18 measure overzoom from fresh z14 tiles).
const ZOOM_STEPS = [
  { z: 10, c: [151.30, -33.35] }, { z: 12, c: [151.40, -33.28] }, { z: 14, c: [151.365, -33.3133] },
  { z: 16, c: [151.35, -33.33] }, { z: 18, c: [151.38, -33.30] },
];
const PAN_STEPS = 5;
const PAN_PX = 520; // more than one 512 px tile per step, so every pan needs new tiles
const FOLLOW_MS = 15000;
const IDLE_TIMEOUT = 90000;

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const APPS = opt('--apps', 'nav,studio,plan').split(',');
const RUNS = +opt('--runs', 3);
const LABEL = opt('--label', 'run');

// ---------------------------------------------------------------- helpers
function median(xs) { const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; }
function medianTree(runs) {
  // runs: array of same-shaped objects; returns the object with numeric leaves replaced by medians
  const first = runs.find(Boolean);
  if (!first || typeof first !== 'object') return median(runs);
  if (Array.isArray(first)) return first.map((_, i) => medianTree(runs.map((r) => r && r[i])));
  const out = {};
  for (const k of Object.keys(first)) {
    const vals = runs.map((r) => r && r[k]);
    out[k] = typeof first[k] === 'number' ? median(vals) : (typeof first[k] === 'object' && first[k] !== null ? medianTree(vals) : first[k]);
  }
  return out;
}
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else if (Array.isArray(v)) v.forEach((x, i) => (x && typeof x === 'object') ? flatten(x, `${key}[${i}]`, out) : (out[`${key}[${i}]`] = x));
    else out[key] = v;
  }
  return out;
}
const fmt = (v) => v == null ? '–' : (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v));

function prepNavBundle() {
  mkdirSync(CACHE, { recursive: true });
  const out = join(CACHE, 'nav-bundle.json');
  if (existsSync(out)) return out;
  const gpx = readFileSync(SAMPLE_GPX, 'utf8');
  const heatmap = JSON.parse(readFileSync(SAMPLE_HEAT, 'utf8'));
  writeFileSync(out, JSON.stringify({ tracks: [{ name: 'Palm Dale loop', gpx }], heatmap, heatmapName: 'heatmap-central-coast.geojson' }));
  return out;
}
// A long ride for the navlong scenario: the eight longest recorded tracks in
// the sample heatmap joined end to end (~19,000 points, all inside the archive).
// Route work in Nav scales with point count; the 542-point loop hides it.
function prepLongBundle() {
  mkdirSync(CACHE, { recursive: true });
  const out = join(CACHE, 'nav-bundle-long.json');
  if (existsSync(out)) return out;
  const heatmap = JSON.parse(readFileSync(SAMPLE_HEAT, 'utf8'));
  const lines = heatmap.features.filter((f) => f.geometry.type === 'LineString').sort((a, b) => b.geometry.coordinates.length - a.geometry.coordinates.length).slice(0, 8);
  let t = 0;
  const pts = lines.flatMap((f) => f.geometry.coordinates.map(([lon, lat]) => `<trkpt lat="${lat}" lon="${lon}"><time>${new Date(1600000000000 + (t += 3000)).toISOString()}</time></trkpt>`));
  const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="dingo-perf"><trk><name>Long ride</name><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
  writeFileSync(out, JSON.stringify({ tracks: [{ name: 'Long ride', gpx }], heatmap, heatmapName: 'heatmap-central-coast.geojson' }));
  return out;
}

// ------------------------------------------------------------ page driving
async function waitIdle(page, mapExpr, relaxed = false) {
  return page.evaluate(([expr, to, relaxed]) => window.__perf.waitIdle(eval(expr), to, relaxed), [mapExpr, IDLE_TIMEOUT, relaxed]);
}
// one continuous 3 s ease from z13 to z15 over the track: per-frame app work
async function easeWindow(page, mapExpr) {
  await page.evaluate(([expr, c]) => eval(expr).jumpTo({ center: c, zoom: 13 }), [mapExpr, TRACK_CENTER]);
  await waitIdle(page, mapExpr);
  return page.evaluate(([expr, c]) => window.__perf.easeWindow(eval(expr), { center: c, zoom: 15, duration: 3000, easing: (t) => t }), [mapExpr, TRACK_CENTER]);
}
async function cameraSweep(page, mapExpr) {
  // zoom steps then pan steps, each timed to idle; tiles counted per step
  // the camera call and the idle wait run in ONE evaluate, timed in-page, so
  // the Playwright round trip never hides a fast tile load
  const move = (call, arg) => page.evaluate(([expr, call, arg, to]) => {
    const m = eval(expr); const P = window.__perf;
    const tiles0 = P.events.tileLoad; const t = performance.now();
    if (call === 'jumpTo') m.jumpTo(arg); else m.panBy(arg, { duration: 0 });
    return P.waitIdle(m, to).then(() => ({ idleMs: +(performance.now() - t).toFixed(0), tiles: P.events.tileLoad - tiles0 }));
  }, [mapExpr, call, arg, IDLE_TIMEOUT]);
  const zoom = [];
  for (const { z, c } of ZOOM_STEPS) zoom.push({ z, ...(await move('jumpTo', { center: c, zoom: z })) });
  // pan: a straight run west at z15 across the archive, each step into fresh tiles
  await move('jumpTo', { center: [151.42, -33.30], zoom: 15 });
  const pan = [];
  for (let i = 0; i < PAN_STEPS; i++) pan.push((await move('panBy', [-PAN_PX, i % 2 ? 120 : -120])).idleMs);
  const tileLat = await page.evaluate(() => window.__perf.tileLatStats());
  const ease = await easeWindow(page, mapExpr);
  return {
    zoom, zoomTotalMs: zoom.reduce((a, b) => a + b.idleMs, 0), zoomTiles: zoom.reduce((a, b) => a + b.tiles, 0),
    panTotalMs: pan.reduce((a, b) => a + b, 0), panMaxMs: Math.max(...pan), tileLat, ease,
  };
}
// --profile: sample the main thread (CDP Profiler) during the follow window and
// keep the top self-time functions, so a regression or a win has a name.
const PROFILE = args.includes('--profile');
async function profiled(page, fn) {
  if (!PROFILE) return fn();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  const result = await fn();
  const { profile } = await cdp.send('Profiler.stop');
  await cdp.detach();
  const self = new Map(); const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const total = profile.timeDeltas.reduce((a, b) => a + b, 0) / 1000;
  profile.samples.forEach((id, i) => {
    const n = byId.get(id); const cf = n.callFrame;
    const key = `${cf.functionName || '(anonymous)'} ${cf.url.split('/').slice(-1)[0]}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + profile.timeDeltas[i] / 1000);
  });
  const top = [...self.entries()].filter(([k]) => !/^\(idle\)|^\(program\)|^\(garbage collector\)|^\(root\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${v.toFixed(0)}ms ${k}`);
  result.profile = { totalMs: +total.toFixed(0), idleMs: +((self.get('(idle) :0') || 0)).toFixed(0), top };
  return result;
}
async function followWindow(page, ms) {
  return profiled(page, async () => {
    await page.evaluate(() => { const P = window.__perf; P.startFrames(); P.resetLongTasks(); P.tileLat = []; P._t = performance.now(); P._r = P.events.render; P._tl = P.events.tileLoad; });
    await page.waitForTimeout(ms);
    return page.evaluate(() => {
      const P = window.__perf;
      const frames = P.stopFrames();
      const wall = performance.now() - P._t;
      return { frames, longTasks: P.longTaskStats(P._t), renders: P.events.render - P._r, rendersPerSec: +((P.events.render - P._r) / (wall / 1000)).toFixed(1), tiles: P.events.tileLoad - P._tl, tileLat: P.tileLatStats() };
    });
  });
}
async function timings(page, keys) {
  return page.evaluate((keys) => {
    const P = window.__perf; const out = {};
    for (const k of keys) if (P.timings[k] && P.timings[k].length) out[k] = P.stats(P.timings[k]);
    return out;
  }, keys);
}

const scenarios = {
  async navlong(ctx) { return scenarios.nav({ ...ctx, bundle: prepLongBundle() }); },
  async nav({ browser, origin, tilesBase, bundle }) {
    const context = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    if (bundle) await context.route('**/apps/nav/bundle.json', (r) => r.fulfill({ path: bundle, contentType: 'application/json' }));
    await context.addInitScript({ path: join(HERE, 'instrument.js') });
    await context.addInitScript(({ base, names }) => {
      localStorage.setItem('dtiles-base', base);
      localStorage.setItem('dingonav-visited', '1');
      document.addEventListener('DOMContentLoaded', () => { for (const n of names) window.__perf.wrap(window, n); });
    }, { base: tilesBase, names: ['buildStyle', 'initMap', 'addOverlays', 'refreshMapData', 'refreshRouteFeatures', 'refreshTrail', 'drawProgress', 'onFix', 'navFix', 'followCamera', 'setHud', 'analyzeRoute', 'processTrack', 'parseGPX', 'processHeatmap'] });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('  [nav pageerror]', e.message));
    const t0 = Date.now();
    await page.goto(`${origin}/apps/nav/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof mapReady !== 'undefined' && mapReady && window.__perf.maps.length > 0 && S.tracks.length > 0, null, { timeout: IDLE_TIMEOUT });
    const bootIdle = await waitIdle(page, 'map');
    const bootMs = Date.now() - t0;
    const boot = { totalMs: bootMs, mapIdleMs: +bootIdle.toFixed(0), ...(await timings(page, ['buildStyle', 'initMap', 'addOverlays', 'processTrack', 'processHeatmap', 'parseGPX'])) };
    await page.evaluate(() => { selectTrack(0); refreshMapData(); });
    const sweep = await cameraSweep(page, 'map');
    // follow mode: the demo feeds synthetic fixes through onFix at 10 Hz
    await page.evaluate(() => { startDemo(); });
    await page.waitForFunction(() => S.nav === true, null, { timeout: 30000 });
    // route analysis (the cue engine's corridor decode) runs on the first
    // start and is measured on its own; the follow window starts after it
    await page.waitForFunction(() => S.tracks[0] && S.tracks[0].alerts, null, { timeout: IDLE_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(1000);
    const follow = await followWindow(page, FOLLOW_MS);
    follow.fn = await timings(page, ['onFix', 'navFix', 'followCamera', 'setHud', 'refreshMapData', 'refreshRouteFeatures', 'refreshTrail', 'drawProgress', 'analyzeRoute']);
    const snap = await page.evaluate(() => window.__perf.snapshot());
    const events = snap.events, errors = snap.errors;
    await page.evaluate(() => { stopDemo(); stopNav(); }).catch(() => {});
    await context.close();
    return { boot, ...sweep, follow, events, errors };
  },

  async studio({ browser, origin }) {
    const context = await browser.newContext({ viewport: { width: 900, height: 720 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    await context.addInitScript({ path: join(HERE, 'instrument.js') });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('  [studio pageerror]', e.message));
    const t0 = Date.now();
    await page.goto(`${origin}/apps/studio/index.html#demo`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__demo && window.__perf.maps.length > 0 && window.__demo.grid.views[0] && window.__demo.grid.views[0].nav, null, { timeout: IDLE_TIMEOUT });
    await page.evaluate(() => { const nav = window.__demo.grid.views[0].nav; window.__perf.wrap(Object.getPrototypeOf(nav), 'onFix'); window.__perf.wrap(Object.getPrototypeOf(nav), '_ease', 'ease'); });
    const bootIdle = await waitIdle(page, '__perf.maps[0]', true);
    const boot = { totalMs: Date.now() - t0, mapIdleMs: +bootIdle.toFixed(0) };
    // the demo is already replaying at 10x: measure follow first, then pause and sweep
    const follow = await followWindow(page, FOLLOW_MS);
    follow.fn = await timings(page, ['onFix', 'ease']);
    await page.evaluate(() => window.__demo.engine.pause());
    await page.evaluate(() => { const v = window.__demo.grid.views[0].nav; if (v) v.follow = false; });
    const sweep = await cameraSweep(page, '__perf.maps[0]');
    const snap = await page.evaluate(() => window.__perf.snapshot());
    const events = snap.events, errors = snap.errors;
    await context.close();
    return { boot, ...sweep, follow, events, errors };
  },

  async plan({ browser, origin, tilesBase }) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    await context.addInitScript({ path: join(HERE, 'instrument.js') });
    await context.addInitScript(({ base }) => { localStorage.setItem('dtiles-base', base); }, { base: tilesBase });
    const page = await context.newPage();
    // no daemon in the harness: answer its API quickly so react-query settles
    await page.route('http://localhost:3000/**', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"no daemon in perf harness"}' }));
    page.on('pageerror', (e) => console.error('  [plan pageerror]', e.message));
    const t0 = Date.now();
    await page.goto(`${origin}/plan/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__dingoMap && window.__dingoMap.loaded && window.__dingoMap.getStyle(), null, { timeout: IDLE_TIMEOUT });
    // instrument.js cannot patch the bundled maplibre; attach the listeners by hand
    await page.evaluate(() => { const m = window.__dingoMap; window.__perf.maps.push(m); window.__perf.attach(m); });
    const bootIdle = await waitIdle(page, '__dingoMap');
    const boot = { totalMs: Date.now() - t0, mapIdleMs: +bootIdle.toFixed(0), styleLayers: await page.evaluate(() => window.__dingoMap.getStyle().layers.length) };
    const sweep = await cameraSweep(page, '__dingoMap');
    const snap = await page.evaluate(() => window.__perf.snapshot());
    await context.close();
    return { boot, ...sweep, events: snap.events, errors: snap.errors };
  },
};

// ------------------------------------------------------------------ main
async function main() {
  if (args[0] === '--compare') return compare(args[1], args[2]);
  const bundle = prepNavBundle();
  const planDist = join(ROOT, 'apps/plan/dist');
  const { server, port } = await startServer({
    root: ROOT,
    overrides: {
      '/apps/nav/bundle.json': bundle,
      '/tiles/basemap-au.pmtiles': join(ROOT, 'apps/studio/basemap/central-coast.pmtiles'),
      '/tiles/hillshade-au.pmtiles': join(ROOT, 'apps/studio/basemap/hillshade.pmtiles'),
    },
    mounts: { '/plan': planDist },
  });
  const origin = `http://127.0.0.1:${port}`;
  const tilesBase = `${origin}/tiles/`;
  // PERF_CHROMIUM points at a Chromium binary when the Playwright-bundled one
  // is missing (the web session images ship one build under /opt/pw-browsers).
  const executablePath = process.env.PERF_CHROMIUM || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch {}
  const out = { label: LABEL, commit, date: new Date().toISOString(), runs: RUNS, apps: {} };

  for (const app of APPS) {
    if (!scenarios[app]) { console.error(`unknown app ${app}`); continue; }
    if (app === 'plan' && !existsSync(join(planDist, 'index.html'))) { console.error('plan: no dist — run `VITE_BASE=/plan/ npm run build` in apps/plan'); continue; }
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      process.stdout.write(`${app} run ${i + 1}/${RUNS} … `);
      const t = Date.now();
      try {
        const r = await scenarios[app]({ browser, origin, tilesBase });
        runs.push(r);
        console.log(`${((Date.now() - t) / 1000).toFixed(0)}s`);
      } catch (e) {
        console.log(`FAILED: ${e.message.split('\n')[0]}`);
      }
    }
    if (runs.length) out.apps[app] = { median: medianTree(runs), runs };
  }
  await browser.close();
  server.close();

  mkdirSync(RESULTS, { recursive: true });
  const file = join(RESULTS, `${LABEL}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  printSummary(out);
  console.log(`\nsaved ${file}`);
}

const KEY_METRICS = [
  ['boot.totalMs', 'boot total ms'], ['boot.mapIdleMs', 'boot→idle ms'], ['boot.buildStyle.mean', 'buildStyle ms'],
  ['boot.processHeatmap.mean', 'processHeatmap ms'],
  ['zoomTotalMs', 'zoom sweep ms'], ['zoomTiles', 'zoom tiles'], ['panTotalMs', 'pan sweep ms'], ['panMaxMs', 'pan max ms'],
  ['tileLat.p50', 'tile latency p50'], ['tileLat.p95', 'tile latency p95'], ['tileLat.n', 'tiles timed'],
  ['ease.frames.p50', 'ease frame p50'], ['ease.frames.p95', 'ease frame p95'], ['ease.longTasks.count', 'ease long tasks'], ['ease.longTasks.totalMs', 'ease long task ms'], ['ease.renders', 'ease renders'],
  ['follow.frames.p50', 'follow frame p50'], ['follow.frames.p95', 'follow frame p95'], ['follow.frames.max', 'follow frame max'],
  ['follow.rendersPerSec', 'renders/s'], ['follow.tiles', 'follow tiles'], ['follow.longTasks.count', 'long tasks'], ['follow.longTasks.totalMs', 'long task ms'],
  ['follow.fn.onFix.mean', 'onFix mean ms'], ['follow.fn.onFix.p95', 'onFix p95 ms'], ['follow.fn.navFix.mean', 'navFix mean ms'],
  ['follow.fn.refreshMapData.mean', 'refreshMapData ms'], ['follow.fn.refreshMapData.n', 'refreshMapData calls'],
  ['follow.fn.refreshRouteFeatures.mean', 'refreshRouteFeat ms'], ['follow.fn.refreshRouteFeatures.n', 'refreshRouteFeat calls'],
  ['follow.fn.refreshTrail.mean', 'refreshTrail ms'], ['follow.fn.drawProgress.mean', 'drawProgress ms'], ['follow.fn.drawProgress.n', 'drawProgress calls'],
  ['boot.processTrack.mean', 'processTrack ms'],
  ['follow.fn.setHud.mean', 'setHud ms'], ['follow.fn.analyzeRoute.mean', 'analyzeRoute ms'],
  ['events.setStyle', 'setStyle calls'], ['events.error', 'map errors'],
];
function printSummary(out) {
  for (const [app, data] of Object.entries(out.apps)) {
    const flat = flatten(data.median);
    console.log(`\n== ${app} (median of ${data.runs.length}) ==`);
    for (const [k, label] of KEY_METRICS) if (flat[k] != null) console.log(`  ${label.padEnd(22)} ${fmt(flat[k])}`);
    if (data.median.zoom) console.log('  zoom steps            ' + data.median.zoom.map((s) => `z${s.z}:${fmt(s.idleMs)}ms/${s.tiles}t`).join('  '));
    const prof = data.runs[0].follow && data.runs[0].follow.profile;
    if (prof) { console.log(`  follow profile (run 1, ${prof.totalMs} ms sampled, ${prof.idleMs} ms idle):`); for (const l of prof.top) console.log('    ' + l); }
  }
}
function compare(a, b) {
  const A = JSON.parse(readFileSync(join(RESULTS, `${a}.json`), 'utf8'));
  const B = JSON.parse(readFileSync(join(RESULTS, `${b}.json`), 'utf8'));
  for (const app of Object.keys(B.apps)) {
    if (!A.apps[app]) continue;
    const fa = flatten(A.apps[app].median), fb = flatten(B.apps[app].median);
    console.log(`\n== ${app}: ${a} (${A.commit}) → ${b} (${B.commit}) ==`);
    for (const [k, label] of KEY_METRICS) {
      if (fa[k] == null && fb[k] == null) continue;
      const d = (fa[k] != null && fb[k] != null && fa[k] !== 0) ? ((fb[k] - fa[k]) / fa[k] * 100) : null;
      console.log(`  ${label.padEnd(22)} ${fmt(fa[k]).padStart(9)} → ${fmt(fb[k]).padStart(9)}  ${d == null ? '' : (d > 0 ? '+' : '') + d.toFixed(0) + '%'}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
