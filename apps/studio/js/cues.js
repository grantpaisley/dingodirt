/* Cue engine — ported from DingoNav (import-time route analysis).
   Decodes the z14 `roads` layer from the local PMTiles basemap along the route
   corridor, matches the route to ways, and emits a cue only where the obvious
   move is wrong. Same algorithm, same constants; parameterised on the PMTiles
   handle instead of Nav's globals. */

import { REF, toXY, toLL, dist, bearing, angDiff, nearestOnTrack, RESAMPLE_M, heatGrid } from './geom.js';

export const CUE = { SAMPLE: 10, MATCH_D: 15, MATCH_ANG: 50, ALT_D: 35, ALT_ANG: 28,
  DEP_D: 45, TURN_MIN: 25, MERGE_M: 30, REJOIN_M: 300 };

/* minimal MVT decoder — LineString features + string props of one named layer */
function mvtLayerLines(buffer, layerName) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const td = new TextDecoder();
  let p = 0;
  function varint() { let r = 0, s = 0, b; do { b = bytes[p++]; r += s < 28 ? (b & 127) << s : (b & 127) * 2 ** s; s += 7; } while (b & 128); return r; }
  function skip(wt) { if (wt === 0) varint(); else if (wt === 1) p += 8; else if (wt === 2) p += varint(); else if (wt === 5) p += 4; }
  const out = { features: [], extent: 4096 };
  while (p < bytes.length) {
    const tag = varint(), wt = tag & 7;
    if (tag >> 3 === 3 && wt === 2) {
      const end = p + varint();
      const keys = [], values = [], feats = [];
      let name = '', ext = 4096;
      while (p < end) {
        const t2 = varint(), w2 = t2 & 7, f2 = t2 >> 3;
        if (f2 === 1) { const l = varint(); name = td.decode(bytes.subarray(p, p + l)); p += l; }
        else if (f2 === 2) { const l = varint(); feats.push([p, p + l]); p += l; }
        else if (f2 === 3) { const l = varint(); keys.push(td.decode(bytes.subarray(p, p + l))); p += l; }
        else if (f2 === 4) { const l = varint(), e2 = p + l; let v = null;
          while (p < e2) { const t3 = varint(), f3 = t3 >> 3;
            if (f3 === 1) { const l3 = varint(); v = td.decode(bytes.subarray(p, p + l3)); p += l3; }
            else if (f3 === 2) { p += 4; }
            else if (f3 === 3) { p += 8; }
            else if (f3 === 4 || f3 === 5) v = varint();
            else if (f3 === 6) { const z = varint(); v = (z >>> 1) ^ -(z & 1); }
            else if (f3 === 7) v = !!varint();
            else skip(t3 & 7); }
          values.push(v); }
        else if (f2 === 5) ext = varint();
        else skip(w2);
      }
      if (name === layerName) {
        out.extent = ext;
        for (const [fs, fe] of feats) {
          p = fs;
          let type = 0, props = {}, geom = null;
          while (p < fe) {
            const t2 = varint(), w2 = t2 & 7, f2 = t2 >> 3;
            if (f2 === 2) { const l = varint(), e2 = p + l;
              while (p < e2) { const k = varint(), v = varint(); props[keys[k]] = values[v]; } }
            else if (f2 === 3) type = varint();
            else if (f2 === 4) { const l = varint(); geom = [p, p + l]; p += l; }
            else skip(w2);
          }
          if (type !== 2 || !geom) continue;
          p = geom[0];
          const lines = []; let line = null, x = 0, y = 0;
          while (p < geom[1]) {
            const cmd = varint(), op = cmd & 7, count = cmd >> 3;
            if (op === 1) { for (let k = 0; k < count; k++) { const zx = varint(), zy = varint();
              x += (zx >>> 1) ^ -(zx & 1); y += (zy >>> 1) ^ -(zy & 1);
              line = [[x, y]]; lines.push(line); } }
            else if (op === 2) { for (let k = 0; k < count; k++) { const zx = varint(), zy = varint();
              x += (zx >>> 1) ^ -(zx & 1); y += (zy >>> 1) ^ -(zy & 1); line.push([x, y]); } }
            else break;
          }
          out.features.push({ props, lines });
        }
      }
      p = end;
    } else skip(wt);
  }
  return out;
}
function lonLatTile(z, lon, lat) {
  const n = 2 ** z;
  const x = Math.floor((lon + 180) / 360 * n);
  const latR = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}
function tilePointLL(z, tx, ty, px, py, extent) {
  const n = 2 ** z;
  const lon = (tx + px / extent) / n * 360 - 180;
  const yt = (ty + py / extent) / n;
  return [Math.atan(Math.sinh(Math.PI * (1 - 2 * yt))) * 180 / Math.PI, lon];
}
function wayClass(props) {
  const kd = String(props.kind_detail || ''), k = String(props.kind || '');
  if (kd === 'track') return 'fire trail';
  if (['path', 'footway', 'cycleway', 'bridleway', 'steps'].includes(kd) || k === 'path') return 'singletrack';
  return 'road';
}

function addCueSample(g, x, y, brg, cls, name) {
  const j = g.px.length;
  g.px.push(x); g.py.push(y); g.pb.push(brg); g.pc.push(cls); g.pn.push(name);
  const k = ((x / g.cell) | 0) + ',' + ((y / g.cell) | 0);
  let a = g.grid.get(k); if (!a) g.grid.set(k, a = []); a.push(j);
}
function nearCueSamples(g, x, y, r) {
  const out = [], C = g.cell, cx = (x / C) | 0, cy = (y / C) | 0, R = Math.ceil(r / C);
  for (let ix = cx - R; ix <= cx + R; ix++) for (let iy = cy - R; iy <= cy + R; iy++) {
    const a = g.grid.get(ix + ',' + iy); if (!a) continue;
    for (const j of a) { const d = dist(x, y, g.px[j], g.py[j]); if (d <= r) out.push([j, d]); }
  }
  return out;
}

async function decodeCorridor(trk, basePM) {
  const g = { px: [], py: [], pb: [], pc: [], pn: [], grid: new Map(), cell: 24, tiles: 0 };
  if (!basePM) return g;
  const Z = 14, want = new Map();
  for (let i = 0; i < trk.n; i += 2) {
    const [lat, lon] = toLL(trk.xy[i * 2], trk.xy[i * 2 + 1]);
    const t = lonLatTile(Z, lon, lat);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
      want.set((t.x + dx) + '/' + (t.y + dy), [t.x + dx, t.y + dy]);
  }
  for (const [, [tx, ty]] of want) {
    let resp = null;
    try { resp = await basePM.getZxy(Z, tx, ty); } catch (e) {}
    if (!resp || !resp.data) continue;
    let layer = null;
    try { layer = mvtLayerLines(resp.data, 'roads'); } catch (e) { console.warn('[cue] tile decode failed', tx, ty, e); continue; }
    for (const f of layer.features) {
      const cls = wayClass(f.props), nm = f.props.name || null;
      for (const line of f.lines) {
        let prev = null;
        for (const [px, py] of line) {
          const [lat, lon] = tilePointLL(Z, tx, ty, px, py, layer.extent);
          const [x, y] = toXY(lat, lon);
          if (prev) {
            const seg = dist(prev[0], prev[1], x, y);
            if (seg < 2000) {
              const brg = bearing(prev[0], prev[1], x, y);
              const steps = Math.max(1, Math.round(seg / CUE.SAMPLE));
              for (let s2 = 1; s2 <= steps; s2++) {
                const t2 = s2 / steps;
                addCueSample(g, prev[0] + (x - prev[0]) * t2, prev[1] + (y - prev[1]) * t2, brg, cls, nm);
              }
            }
          } else addCueSample(g, x, y, 0, cls, nm);
          prev = [x, y];
        }
      }
    }
    g.tiles++;
  }
  return g;
}

function matchWays(trk, g) {
  const cls = new Array(trk.n).fill(null), nm = new Array(trk.n).fill(null);
  const brg = new Float32Array(trk.n);
  for (let i = 0; i < trk.n - 1; i++) brg[i] = bearing(trk.xy[i * 2], trk.xy[i * 2 + 1], trk.xy[i * 2 + 2], trk.xy[i * 2 + 3]);
  brg[trk.n - 1] = brg[Math.max(0, trk.n - 2)];
  for (let i = 0; i < trk.n; i++) {
    let best = -1, bs = 1e9;
    for (const [j, d] of nearCueSamples(g, trk.xy[i * 2], trk.xy[i * 2 + 1], CUE.MATCH_D)) {
      const bd = Math.abs(angDiff(brg[i], g.pb[j])), und = Math.min(bd, 180 - bd);
      if (und > CUE.MATCH_ANG) continue;
      if (d < bs) { bs = d; best = j; }
    }
    if (best >= 0) { cls[i] = g.pc[best]; nm[i] = g.pn[best]; }
  }
  const sm = new Array(trk.n).fill(null), smn = new Array(trk.n).fill(null);
  for (let i = 0; i < trk.n; i++) {
    const cnt = new Map();
    for (let j = Math.max(0, i - 3); j <= Math.min(trk.n - 1, i + 3); j++)
      if (cls[j]) { const k = cls[j] + '\x1f' + (nm[j] || ''); cnt.set(k, (cnt.get(k) || 0) + 1); }
    let bk = null, bn = 0;
    for (const [k, n2] of cnt) if (n2 > bn) { bn = n2; bk = k; }
    if (bk) { const parts = bk.split('\x1f'); sm[i] = parts[0]; smn[i] = parts[1] || null; }
  }
  return { cls: sm, name: smn, brg };
}

function classifyCues(trk, g, hg, m) {
  const grids = hg ? [g, hg] : [g];
  const W = 5;
  const turn = new Float32Array(trk.n);
  for (let i = 0; i < trk.n - 1 - W; i++) {
    let sum = 0;
    for (let j = i; j < i + W; j++) sum += angDiff(m.brg[j], m.brg[j + 1]);
    turn[i + ((W / 2) | 0)] = sum;
  }
  const inHeading = i => {
    const from = Math.max(0, i - Math.ceil(30 / RESAMPLE_M));
    let sx = 0, sy = 0;
    for (let j = from; j < i; j++) { sx += Math.sin(m.brg[j] * Math.PI / 180); sy += Math.cos(m.brg[j] * Math.PI / 180); }
    return Math.atan2(sx, sy) * 180 / Math.PI;
  };
  const altContinues = i => {
    const x = trk.xy[i * 2], y = trk.xy[i * 2 + 1], hIn = inHeading(i);
    const dx = Math.sin(hIn * Math.PI / 180), dy = Math.cos(hIn * Math.PI / 180);
    for (const gr of grids) for (const [j] of nearCueSamples(gr, x, y, CUE.ALT_D)) {
      if ((gr.px[j] - x) * dx + (gr.py[j] - y) * dy < 10) continue;
      const bd = Math.abs(angDiff(hIn, gr.pb[j])), und = Math.min(bd, 180 - bd);
      if (und > CUE.ALT_ANG) continue;
      const near = nearestOnTrack(trk, gr.px[j], gr.py[j], i);
      if (near.d < 12 && Math.abs(trk.cum[near.idx] - trk.cum[i]) < 120) continue;
      return true;
    }
    return false;
  };
  const departedContinues = (i, clsB, nameB) => {
    const x = trk.xy[i * 2], y = trk.xy[i * 2 + 1], hIn = inHeading(i);
    const dx = Math.sin(hIn * Math.PI / 180), dy = Math.cos(hIn * Math.PI / 180);
    for (const [j, d] of nearCueSamples(g, x, y, CUE.DEP_D)) {
      if (d < 8) continue;
      if ((g.px[j] - x) * dx + (g.py[j] - y) * dy < -10) continue;
      if (nameB ? g.pn[j] !== nameB : g.pc[j] !== clsB) continue;
      const near = nearestOnTrack(trk, g.px[j], g.py[j], i);
      if (near.d < 12 && Math.abs(trk.cum[near.idx] - trk.cum[i]) < 120) continue;
      return true;
    }
    return false;
  };
  const wayKey = i => m.cls[i] ? m.cls[i] + '\x1f' + (m.name[i] || '') : null;
  const mkCue = (idx, deg) => {
    const after = Math.min(trk.n - 1, idx + Math.ceil(25 / RESAMPLE_M));
    return { at: trk.cum[idx], idx, deg: Math.round(deg), type: deg > 0 ? 'right' : 'left',
      from: m.cls[Math.max(0, idx - 3)] || null, onto: m.cls[after] || null, name: m.name[after] || null,
      outBrg: Math.round(m.brg[after]), inBrg: Math.round(m.brg[Math.max(0, idx - 3)]) };
  };
  const cues = [];
  for (let k = 1; k < trk.n; k++) {
    if (wayKey(k) === wayKey(k - 1)) continue;
    if (!wayKey(k)) {
      let j = k; while (j < trk.n && !wayKey(j)) j++;
      if (j < trk.n && wayKey(j) === wayKey(k - 1) && trk.cum[j] - trk.cum[k] < CUE.REJOIN_M) { k = j; continue; }
    } else if (!wayKey(k - 1)) {
      let j = k - 1; while (j >= 0 && !wayKey(j)) j--;
      if (j >= 0 && wayKey(j) === wayKey(k) && trk.cum[k] - trk.cum[j] < CUE.REJOIN_M) continue;
    }
    let backOk = 0; for (let j = k - 1; j >= 0 && wayKey(j) === wayKey(k - 1); j--) backOk++;
    let fwdOk = 0; for (let j = k; j < trk.n && wayKey(j) === wayKey(k); j++) fwdOk++;
    if (backOk < 5 || fwdOk < 5) continue;
    let deg = 0;
    for (let j = Math.max(0, k - 3); j <= Math.min(trk.n - 1, k + 3); j++)
      if (Math.abs(turn[j]) > Math.abs(deg)) deg = turn[j];
    if (Math.abs(deg) < CUE.TURN_MIN) continue;
    const clsB = m.cls[k - 1], nameB = m.name[k - 1];
    if (!(clsB ? departedContinues(k, clsB, nameB) : altContinues(k))) continue;
    const dup = cues.find(c => Math.abs(c.at - trk.cum[k]) < CUE.MERGE_M);
    if (dup) { dup.from = clsB; dup.onto = m.cls[k]; dup.name = m.name[k] || dup.name; }
    else cues.push(mkCue(k, deg));
  }
  cues.sort((a, b) => a.at - b.at);
  const merged = [];
  for (const c of cues) {
    const last = merged[merged.length - 1];
    if (last && c.at - last.at < CUE.MERGE_M) {
      if (Math.abs(c.deg) > Math.abs(last.deg)) { c.from = c.from || last.from; merged[merged.length - 1] = c; }
      else if (c.onto && c.onto !== last.onto) { last.onto = c.onto; last.name = c.name || last.name; }
    } else merged.push(c);
  }
  return merged;
}

/* mark kinds — same table as Nav; colours come from the scheme at render time */
export const MARKS = {
  turn:     { label: 'Turn',       glyph: '' },
  danger:   { label: 'Danger !!!', glyph: '!' },
  obstacle: { label: 'Obstacle',   glyph: 'O' },
  gate:     { label: 'Gate',       glyph: 'G' },
  creek:    { label: 'Creek',      glyph: 'W' },
  fuel:     { label: 'Fuel',       glyph: 'F' },
  food:     { label: 'Pub / food', glyph: 'P' },
  lookout:  { label: 'Lookout',    glyph: 'L' },
  camp:     { label: 'Camp',       glyph: 'C' },
};
export const SILENT_KINDS = { fuel: 1, food: 1, lookout: 1, camp: 1 };
export const kindOf = a => (a.kind && MARKS[a.kind]) ? a.kind : 'turn';
export const DANGER_FAR = 200, DANGER_NEAR = 50;

/* analyse a route: corridor decode + way match + cue classification.
   Sets trk.alerts (sorted by .at). basePM optional; heat optional. */
export async function analyzeRoute(trk, basePM, heat) {
  const t0 = performance.now();
  const g = await decodeCorridor(trk, basePM);
  const hg = heat ? heatGrid(heat) : null;
  const m = matchWays(trk, g);
  const cues = classifyCues(trk, g, hg, m);
  console.log(`[cue] "${trk.name}": ${cues.length} cues from ${g.px.length} samples / ${g.tiles} tiles in ${(performance.now() - t0).toFixed(0)} ms`);
  trk.alerts = cues;
  return cues;
}
