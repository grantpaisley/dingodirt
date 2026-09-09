// Injected into every page before any app script runs (Playwright
// addInitScript). Collects what the harness reads back: frame intervals from
// a requestAnimationFrame sampler, long tasks from PerformanceObserver, tile
// and style events from every MapLibre map the page constructs, and timings
// for a few app functions the scenarios wrap by name. Plain script, no
// modules — Nav is a classic-script app.
(function () {
  const P = {
    frames: [], longTasks: [], events: { tileLoad: 0, styleLoad: 0, setStyle: 0, render: 0, error: 0 },
    timings: {}, maps: [],
    t0: performance.timeOrigin,
    _raf: null, _last: 0,
  };
  window.__perf = P;

  // ---- frame sampler -------------------------------------------------
  P.startFrames = function () {
    P.frames = [];
    P._last = performance.now();
    const tick = (t) => {
      P.frames.push(t - P._last);
      P._last = t;
      P._raf = requestAnimationFrame(tick);
    };
    P._raf = requestAnimationFrame(tick);
  };
  P.stopFrames = function () {
    cancelAnimationFrame(P._raf);
    P._raf = null;
    return P.stats(P.frames.slice(1));
  };
  P.stats = function (arr) {
    if (!arr.length) return { n: 0 };
    const s = arr.slice().sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    return { n: s.length, mean: +mean.toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) };
  };

  // ---- long tasks ------------------------------------------------------
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) P.longTasks.push({ t: e.startTime, d: e.duration });
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { /* not supported */ }
  P.longTaskStats = function (sinceMs) {
    const lt = P.longTasks.filter((x) => x.t >= (sinceMs || 0));
    return { count: lt.length, totalMs: +lt.reduce((a, b) => a + b.d, 0).toFixed(1), maxMs: +Math.max(0, ...lt.map((x) => x.d)).toFixed(1) };
  };
  P.resetLongTasks = function () { P.longTasks = []; };

  // ---- timing wrappers -------------------------------------------------
  P.wrap = function (obj, name, key) {
    const fn = obj[name];
    if (typeof fn !== 'function') return false;
    const k = key || name;
    P.timings[k] = P.timings[k] || [];
    obj[name] = function () {
      const t = performance.now();
      const r = fn.apply(this, arguments);
      const done = () => P.timings[k].push(performance.now() - t);
      if (r && typeof r.then === 'function') r.then(done, done); else done();
      return r;
    };
    return true;
  };

  // ---- maplibre hooks: patch the constructor once the vendored build lands
  let patched = false;
  function patchMaplibre() {
    if (patched || !window.maplibregl || !window.maplibregl.Map) return;
    patched = true;
    const ML = window.maplibregl;
    const setStyle = ML.Map.prototype.setStyle;
    ML.Map.prototype.setStyle = function () { P.events.setStyle++; return setStyle.apply(this, arguments); };
    const Orig = ML.Map;
    function Map(opts) {
      const m = new Orig(opts);
      P.maps.push(m);
      P.attach(m);
      return m;
    }
    Map.prototype = Orig.prototype;
    Object.setPrototypeOf(Map, Orig);
    ML.Map = Map;
  }
  // The vendored script is a classic <script src>; poll briefly until it defines the global.
  const iv = setInterval(() => { patchMaplibre(); if (patched) clearInterval(iv); }, 5);
  setTimeout(() => clearInterval(iv), 20000);

  // Listeners on one map: tile counts, per-tile latency (dataloading → data
  // for the same tile id: fetch + worker parse + layout, independent of the
  // rasteriser), style loads, renders, and the first 20 error messages.
  P.tileLat = [];
  P.errors = [];
  P.tilesBySource = {}; // which sources the tile loads belong to (GeoJSON sources re-tile on every setData)
  P.attach = function (m) {
    const pending = new Map();
    m.on('dataloading', (e) => { if (e.dataType === 'source' && e.tile) pending.set(e.tile.tileID.key, performance.now()); });
    m.on('data', (e) => {
      if (e.dataType !== 'source' || !e.tile) return;
      P.events.tileLoad++;
      P.tilesBySource[e.sourceId] = (P.tilesBySource[e.sourceId] || 0) + 1;
      const k = e.tile.tileID.key, t = pending.get(k);
      if (t != null) { P.tileLat.push(performance.now() - t); pending.delete(k); }
    });
    m.on('style.load', () => { P.events.styleLoad++; });
    m.on('render', () => { P.events.render++; });
    m.on('error', (e) => { P.events.error++; if (P.errors.length < 20) P.errors.push(String(e && e.error && e.error.message || e)); });
  };
  P.tileLatStats = function () { const s = P.stats(P.tileLat); P.tileLat = []; return s; };

  // ---- helpers the scenarios call --------------------------------------
  P.map = function (i) { return P.maps[i || 0]; };
  P.waitIdle = function (map, timeoutMs, relaxed) {
    return new Promise((ok) => {
      const t = performance.now();
      let done = false;
      const finish = () => { if (done) return; done = true; ok(performance.now() - t); };
      const to = setTimeout(finish, timeoutMs || 30000);
      const check = () => {
        // relaxed: style parsed and tiles in, even if the camera is still easing
        // (a follow-mode map never reports loaded() while it moves)
        const ok = relaxed ? (map.isStyleLoaded() && map.areTilesLoaded()) : (map.loaded() && map.areTilesLoaded());
        if (ok) { clearTimeout(to); finish(); }
        else if (relaxed) setTimeout(check, 50);
        else map.once('idle', check);
      };
      // give the camera call one frame to register before the first check
      requestAnimationFrame(() => setTimeout(check, 0));
    });
  };
  P.snapshot = function () {
    return { events: { ...P.events }, errors: P.errors.slice(), timings: Object.fromEntries(Object.entries(P.timings).map(([k, v]) => [k, P.stats(v)])), maps: P.maps.length };
  };
  // An animated zoom: frames and long tasks over one continuous ease, which
  // is where per-frame app work (move handlers, React state, DOM writes) shows.
  P.easeWindow = function (map, opts) {
    return new Promise((ok) => {
      P.startFrames(); P.resetLongTasks();
      const t = performance.now(); const r0 = P.events.render; const tl0 = P.events.tileLoad;
      map.once('moveend', () => {
        const frames = P.stopFrames(); const wall = performance.now() - t;
        ok({ wallMs: +wall.toFixed(0), frames, longTasks: P.longTaskStats(t), renders: P.events.render - r0, tiles: P.events.tileLoad - tl0 });
      });
      map.easeTo(opts);
    });
  };
})();
