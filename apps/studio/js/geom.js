/* Geometry + track processing — ported from DingoNav index.html (nav math in
   local metres). Kept byte-faithful where it matters: RESAMPLE_M, the grid
   search tiers and idxAt drive the replay engine exactly as they drive Nav. */

export const R_LAT = 110540, R_LON = 111320;
export let REF = null;
export function setRef(lat, lon) {
  if (!isFinite(lat) || !isFinite(lon)) { console.warn('setRef ignored non-finite', lat, lon); return; }
  REF = { lat, lon, kx: R_LON * Math.cos(lat * Math.PI / 180) };
}
/* Replacing ALL loaded data (e.g. opening a pack from a different area) must
   re-anchor the local-metre projection — the linear approximation degrades
   with distance from REF. Every previously processed track is invalid after
   this; callers replace everything. */
export function resetRef() { REF = null; }
export function toXY(lat, lon) { return [(lon - REF.lon) * REF.kx, (lat - REF.lat) * R_LAT]; }
export function toLL(x, y) { return [y / R_LAT + REF.lat, x / REF.kx + REF.lon]; }
export function dist(ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return Math.sqrt(dx * dx + dy * dy); }
export function bearing(ax, ay, bx, by) { return Math.atan2(bx - ax, by - ay) * 180 / Math.PI; }
export function angDiff(a, b) { let d = b - a; while (d > 180) d -= 360; while (d < -180) d += 360; return d; }

/* ---------------- GPX parsing ---------------- */
export function parseGPX(text, fallbackName) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('not valid GPX');
  const pts = [];
  for (const tag of ['trkpt', 'rtept']) {
    for (const el of doc.getElementsByTagName(tag)) {
      const lat = parseFloat(el.getAttribute('lat')), lon = parseFloat(el.getAttribute('lon'));
      if (isFinite(lat) && isFinite(lon)) pts.push([lat, lon]);
    }
    if (pts.length) break;
  }
  if (pts.length < 2) throw new Error('no track points');
  const nameEl = doc.querySelector('trk > name, rte > name, metadata > name');
  return { name: (nameEl && nameEl.textContent.trim()) || fallbackName, pts };
}

/* ---------------- track processing (8 m resample + spatial grid) ---------------- */
export const RESAMPLE_M = 8;
export function processTrack(id, name, ptsLL) {
  if (!REF) setRef(ptsLL[0][0], ptsLL[0][1]);
  const raw = new Float32Array(ptsLL.length * 2);
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (let i = 0; i < ptsLL.length; i++) {
    const [x, y] = toXY(ptsLL[i][0], ptsLL[i][1]); raw[i * 2] = x; raw[i * 2 + 1] = y;
    const la = ptsLL[i][0], lo = ptsLL[i][1];
    if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
    if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
  }
  const rx = [raw[0]], ry = [raw[1]];
  let carry = 0;
  for (let i = 1; i < ptsLL.length; i++) {
    const ax = raw[(i - 1) * 2], ay = raw[(i - 1) * 2 + 1], bx = raw[i * 2], by = raw[i * 2 + 1];
    const seg = dist(ax, ay, bx, by);
    if (seg > 2000) { carry = 0; rx.push(bx); ry.push(by); continue; } // GPS gap — don't interpolate across
    let along = RESAMPLE_M - carry;
    while (along < seg) {
      const t = along / seg;
      rx.push(ax + (bx - ax) * t); ry.push(ay + (by - ay) * t);
      along += RESAMPLE_M;
    }
    carry = seg - (along - RESAMPLE_M);
  }
  rx.push(raw[(ptsLL.length - 1) * 2]); ry.push(raw[(ptsLL.length - 1) * 2 + 1]);
  const n = rx.length;
  const xy = new Float32Array(n * 2), cum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    xy[i * 2] = rx[i]; xy[i * 2 + 1] = ry[i];
    if (i) cum[i] = cum[i - 1] + dist(rx[i - 1], ry[i - 1], rx[i], ry[i]);
  }
  const grid = new Map(), CELL = 64;
  for (let i = 0; i < n; i++) {
    const k = ((xy[i * 2] / CELL) | 0) + ',' + ((xy[i * 2 + 1] / CELL) | 0);
    let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(i);
  }
  const coordsLL = ptsLL.map(p => [p[1], p[0]]); // GeoJSON [lon,lat]
  return { id, name, xy, cum, n, grid, cell: CELL, coordsLL,
    llBounds: [[minLon, minLat], [maxLon, maxLat]], lengthM: cum[n - 1], alerts: null };
}

export function nearestOnTrack(trk, x, y, hintIdx) {
  let best = -1, bd = Infinity;
  if (hintIdx >= 0) {
    const lo = Math.max(0, hintIdx - 60), hi = Math.min(trk.n - 1, hintIdx + 60);
    for (let i = lo; i <= hi; i++) { const d = dist(x, y, trk.xy[i * 2], trk.xy[i * 2 + 1]); if (d < bd) { bd = d; best = i; } }
    if (bd < 60) return { idx: best, d: bd };
  }
  const C = trk.cell, cx = (x / C) | 0, cy = (y / C) | 0;
  for (let r = 0; r <= 8; r++) {
    for (let ix = cx - r; ix <= cx + r; ix++) for (let iy = cy - r; iy <= cy + r; iy++) {
      if (r && Math.abs(ix - cx) !== r && Math.abs(iy - cy) !== r) continue;
      const a = trk.grid.get(ix + ',' + iy); if (!a) continue;
      for (const i of a) { const d = dist(x, y, trk.xy[i * 2], trk.xy[i * 2 + 1]); if (d < bd) { bd = d; best = i; } }
    }
    if (best >= 0 && bd < r * C) break;
  }
  if (best < 0) {
    for (let i = 0; i < trk.n; i += 4) { const d = dist(x, y, trk.xy[i * 2], trk.xy[i * 2 + 1]); if (d < bd) { bd = d; best = i; } }
  }
  return { idx: best, d: bd };
}

export function idxAt(trk, distM) {
  let lo = 0, hi = trk.n - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (trk.cum[m] < distM) lo = m + 1; else hi = m; }
  return lo;
}

/* ---------------- heatmap processing ---------------- */
export function processHeatmap(geojson) {
  // Normalise MultiLineStrings into plain LineStrings — everything downstream
  // assumes LineString (see the NaN-projection war story in Nav).
  const feats = (geojson.features || []).flatMap(f => {
    const g = f.geometry;
    if (g && g.type === 'MultiLineString')
      return g.coordinates.map(cs => ({ ...f, geometry: { type: 'LineString', coordinates: cs } }));
    return [f];
  });
  geojson = { ...geojson, features: feats };
  if (!feats.length) throw new Error('empty GeoJSON');
  if (!REF) {
    const first = feats.find(f => f.geometry && f.geometry.type === 'LineString');
    const c = first && first.geometry.coordinates[0];
    if (c) setRef(c[1], c[0]);
  }
  let count = 0;
  for (const f of feats) if (f.geometry) count++;
  return { geojson, count, grid: null };
}

/* corridor sample grid over the heatmap — cue-engine continuation evidence */
export function heatGrid(heat) {
  if (heat.grid) return heat.grid;
  const CELL = 24, grid = new Map(), px = [], py = [], pb = [];
  const STEP = 12;
  for (const f of heat.geojson.features) {
    const g = f.geometry; if (!g) continue;
    const coordSets = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const coords of coordSets) {
      for (let i = 1; i < coords.length; i++) {
        const [ax, ay] = toXY(coords[i - 1][1], coords[i - 1][0]);
        const [bx, by] = toXY(coords[i][1], coords[i][0]);
        const seg = dist(ax, ay, bx, by); if (seg > 2000) continue;
        const brg = bearing(ax, ay, bx, by);
        const steps = Math.max(1, Math.round(seg / STEP));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
          const j = px.length; px.push(x); py.push(y); pb.push(brg);
          const k = ((x / CELL) | 0) + ',' + ((y / CELL) | 0);
          let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(j);
        }
      }
    }
  }
  heat.grid = { grid, px, py, pb, cell: CELL };
  return heat.grid;
}
