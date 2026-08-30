/* Track graph — routing and measuring over tracks you already have.
   Canonical copy (same contract as core/appliers: authored here in plain
   ESM so the root `node --test` job covers it without a build step, and so
   Nav and the site can reuse it — see
   docs/plans/2026-08-30-track-graph-and-phone-plan-design.md).

   The graph answers one question: between these two points on the map,
   what does the ridden line actually look like, how long is it, and how
   long does it take?

   Edges are weighted by TIME, not distance. A fire trail and the
   singletrack beside it are both 4 km; one is a twenty-minute ride and the
   other is an hour. Distance-weighted routing cannot tell them apart, and
   the answer the rider wants is the time.

   Which makes the cross-track link the hard part. Two tracks 8 m apart for
   3 km are a fire trail and its singletrack, NOT one route with a junction
   every few metres. Weld them and you get one wrong line with one wrong
   time. So a link needs all three tests to pass:

     near     within NEAR_M               — GPS noise width
     angled   bearings differ by ANGLE_DEG — parallel lines fail this
     brief    the close approach runs less than RUN_M on BOTH tracks

   A long shared corridor fails `brief`, and is linked only at its two
   ends, where the tracks genuinely part company. One exception: a track
   that ENDS near another always links. A spur joins its parent, and an end
   point has no continuation whose bearing you could compare. */

/** Link tests. Metres and degrees. */
export const NEAR_M = 15;
export const ANGLE_DEG = 30;
export const RUN_M = 60;
/** Cost of stepping between two tracks, on top of the metres. Without it a
 *  router zig-zags between two recordings of the same trail to shave
 *  fractions of a second. */
export const TRANSFER_PENALTY_S = 5;
/** Last-resort speed by ride mode (km/h) when a track carries no average. */
export const MODE_SPEED_KMH = {
  mtb: 14,
  gravel: 20,
  road: 25,
  moto: 30,
  hike: 4.5,
  other: 15,
};
export const DEFAULT_SPEED_KMH = 15;
/** A track's own average is trusted only inside a plausible riding band.
 *  A library holds car trips too — a 91 km/h "track" is a drive down the
 *  highway, and left alone it wins every route by time and reports an hour
 *  you could never ride. The clamp keeps the drive usable as a line without
 *  letting its speed rewrite the plan. The floor rejects a GPS drift track
 *  that would otherwise look like a week-long crawl. */
export const MIN_SPEED_KMH = 3;
export const MAX_SPEED_KMH = 45;

const M_PER_DEG_LAT = 110540;
const mPerDegLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

/** Local flat-earth metres. Exact enough well under a degree, and this runs
 *  in the inner loop of every build. */
function metres(ax, ay, bx, by, cosLat) {
  const dx = (bx - ax) * 111320 * cosLat;
  const dy = (by - ay) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/** Bearing in degrees, 0..360. */
function bearingOf(ax, ay, bx, by, cosLat) {
  const dx = (bx - ax) * 111320 * cosLat;
  const dy = (by - ay) * M_PER_DEG_LAT;
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

/** Smallest angle between two bearings, ignoring direction of travel: two
 *  tracks running the same line in opposite directions are parallel, not
 *  crossing, so the answer folds at 90°. */
function angleBetween(a, b) {
  let d = Math.abs(a - b) % 180;
  if (d > 90) d = 180 - d;
  return d;
}

/** Speed of a track in m/s, by the design's fallback chain: the track's own
 *  average, then a default for its ride mode, then a global default. */
export function speedMs(track) {
  const own =
    (Number.isFinite(track.speedKmh) && track.speedKmh > 1 && track.speedKmh) ||
    MODE_SPEED_KMH[track.mode] ||
    DEFAULT_SPEED_KMH;
  const kmh = Math.min(MAX_SPEED_KMH, Math.max(MIN_SPEED_KMH, own));
  return kmh / 3.6;
}

/* ---- build ---------------------------------------------------------- */

/**
 * Build a routable graph over a set of tracks.
 *
 * @param {Array<{id: string, path: [number, number][], speedKmh?: number|null, mode?: string|null}>} tracks
 * @param {{nearM?: number, angleDeg?: number, runM?: number}} [opts]
 */
export function buildGraph(tracks, opts = {}) {
  const nearM = opts.nearM ?? NEAR_M;
  const angleDeg = opts.angleDeg ?? ANGLE_DEG;
  const runM = opts.runM ?? RUN_M;

  // Tracks with fewer than two points cannot carry an edge.
  const kept = tracks.filter((t) => (t.path?.length ?? 0) >= 2);

  let total = 0;
  for (const t of kept) total += t.path.length;

  const lon = new Float64Array(total);
  const lat = new Float64Array(total);
  const trackOf = new Int32Array(total);
  /** Time to the NEXT node of the same track, seconds. 0 at each track's end. */
  const segSec = new Float64Array(total);
  /** Distance to the next node, metres. */
  const segM = new Float64Array(total);
  /** Distance from the track's first node, metres — the run-length ruler. */
  const cumM = new Float64Array(total);
  const start = new Int32Array(kept.length);
  const end = new Int32Array(kept.length);
  const speeds = new Float64Array(kept.length);

  let n = 0;
  let maxSegM = 0;
  for (let ti = 0; ti < kept.length; ti++) {
    const t = kept[ti];
    const v = speedMs(t);
    speeds[ti] = v;
    start[ti] = n;
    let run = 0;
    for (let i = 0; i < t.path.length; i++) {
      const p = t.path[i];
      lon[n] = p[0];
      lat[n] = p[1];
      trackOf[n] = ti;
      cumM[n] = run;
      if (i + 1 < t.path.length) {
        const q = t.path[i + 1];
        const d = metres(p[0], p[1], q[0], q[1], Math.cos((p[1] * Math.PI) / 180));
        segM[n] = d;
        segSec[n] = d / v;
        if (d > maxSegM) maxSegM = d;
        run += d;
      }
      n++;
    }
    end[ti] = n - 1;
  }

  // ---- spatial grid, one cell per nearM ----
  const midLat = total ? lat[(total / 2) | 0] : 0;
  const cellLat = nearM / M_PER_DEG_LAT;
  const cellLon = nearM / Math.max(1, mPerDegLon(midLat));
  const grid = new Map();
  const cellKey = (gx, gy) => `${gx},${gy}`;
  for (let i = 0; i < total; i++) {
    const k = cellKey(Math.floor(lon[i] / cellLon), Math.floor(lat[i] / cellLat));
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  }

  /** Every node within `r` metres of a point, by grid lookup. */
  function near(x, y, r) {
    const out = [];
    // A cell is nearM across, so a radius of r needs ceil(r / nearM) rings.
    const rings = Math.max(1, Math.ceil(r / nearM));
    const gx = Math.floor(x / cellLon);
    const gy = Math.floor(y / cellLat);
    const cosLat = Math.cos((y * Math.PI) / 180);
    for (let dx = -rings; dx <= rings; dx++) {
      for (let dy = -rings; dy <= rings; dy++) {
        const bucket = grid.get(cellKey(gx + dx, gy + dy));
        if (!bucket) continue;
        for (const i of bucket) {
          if (metres(x, y, lon[i], lat[i], cosLat) <= r) out.push(i);
        }
      }
    }
    return out;
  }

  // ---- candidate close approaches, grouped by track pair ----
  const pairs = new Map();
  for (let i = 0; i < total; i++) {
    const cosLat = Math.cos((lat[i] * Math.PI) / 180);
    const gx = Math.floor(lon[i] / cellLon);
    const gy = Math.floor(lat[i] / cellLat);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(cellKey(gx + dx, gy + dy));
        if (!bucket) continue;
        for (const j of bucket) {
          // One direction only, and never within a track: a track meeting
          // itself is a loop closing, and its own edges already carry it.
          if (trackOf[j] <= trackOf[i]) continue;
          const d = metres(lon[i], lat[i], lon[j], lat[j], cosLat);
          if (d > nearM) continue;
          const key = trackOf[i] * kept.length + trackOf[j];
          const list = pairs.get(key);
          if (list) list.push({ i, j, d });
          else pairs.set(key, [{ i, j, d }]);
        }
      }
    }
  }

  const isEnd = (node) => {
    const t = trackOf[node];
    return node === start[t] || node === end[t];
  };

  /** Local bearing at a node, taken across its neighbours so a single noisy
   *  vertex cannot swing it. */
  function localBearing(node) {
    const t = trackOf[node];
    const a = Math.max(start[t], node - 1);
    const b = Math.min(end[t], node + 1);
    if (a === b) return 0;
    return bearingOf(lon[a], lat[a], lon[b], lat[b], Math.cos((lat[a] * Math.PI) / 180));
  }

  const links = new Map();
  const addLink = (a, b, d) => {
    const w = d / Math.min(speeds[trackOf[a]], speeds[trackOf[b]]) + TRANSFER_PENALTY_S;
    for (const [from, to] of [
      [a, b],
      [b, a],
    ]) {
      const list = links.get(from);
      if (list) list.push([to, w]);
      else links.set(from, [[to, w]]);
    }
  };

  let corridorRuns = 0;
  for (const list of pairs.values()) {
    list.sort((p, q) => p.i - q.i);
    // Split into runs of contiguous close approach. A gap of a couple of
    // vertices is still the same approach — tracks are sampled unevenly.
    let runStart = 0;
    for (let k = 1; k <= list.length; k++) {
      if (k < list.length && list[k].i - list[k - 1].i <= 3) continue;
      const run = list.slice(runStart, k);
      runStart = k;

      let minI = Infinity, maxI = -Infinity, minJ = Infinity, maxJ = -Infinity;
      let best = run[0];
      for (const c of run) {
        if (c.i < minI) minI = c.i;
        if (c.i > maxI) maxI = c.i;
        if (c.j < minJ) minJ = c.j;
        if (c.j > maxJ) maxJ = c.j;
        if (c.d < best.d) best = c;
      }
      const lenA = cumM[maxI] - cumM[minI];
      const lenB = cumM[maxJ] - cumM[minJ];
      const brief = lenA < runM && lenB < runM;

      // A brief touch is a junction: link it once, at its closest point.
      // A long corridor is two parallel trails: link only where they part.
      const candidates = brief ? [best] : [run[0], run[run.length - 1]];
      if (!brief) corridorRuns++;
      for (const c of candidates) {
        const ends = isEnd(c.i) || isEnd(c.j);
        if (!ends && angleBetween(localBearing(c.i), localBearing(c.j)) < angleDeg) continue;
        addLink(c.i, c.j, c.d);
      }
    }
  }

  return {
    ids: kept.map((t) => t.id),
    lon,
    lat,
    trackOf,
    segSec,
    segM,
    start,
    end,
    speeds,
    links,
    nodeCount: total,
    corridorRuns,
    maxSegM,
    cellLon,
    cellLat,
    near,
  };
}

/* ---- snapping -------------------------------------------------------- */

/**
 * Nearest point on the nearest edge — not merely the nearest vertex, which
 * misses the middle of a long straight.
 *
 * @returns {{a: number, b: number, secToA: number, secToB: number,
 *            point: [number, number], distM: number}|null}
 */
export function snap(graph, x, y, tolM = 40) {
  // The grid holds vertices, but the answer is a point on an EDGE. A click
  // 5 m off the middle of a 400 m straight has no vertex anywhere near it,
  // so a first pass at the tolerance is widened by the longest segment
  // before giving up. The tolerance still decides the final answer.
  let cands = graph.near(x, y, tolM);
  if (!cands.length) {
    cands = graph.near(x, y, Math.min(tolM + graph.maxSegM, 2000));
  }
  if (!cands.length) return null;
  const cosLat = Math.cos((y * Math.PI) / 180);
  let best = null;

  const consider = (a, b) => {
    if (a < 0 || b < 0 || a === b) return;
    if (graph.trackOf[a] !== graph.trackOf[b]) return;
    const ax = (graph.lon[a] - x) * 111320 * cosLat;
    const ay = (graph.lat[a] - y) * M_PER_DEG_LAT;
    const bx = (graph.lon[b] - x) * 111320 * cosLat;
    const by = (graph.lat[b] - y) * M_PER_DEG_LAT;
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    let t = len2 ? -(ax * vx + ay * vy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * vx;
    const py = ay + t * vy;
    const d = Math.hypot(px, py);
    if (best && d >= best.distM) return;
    const segLen = Math.sqrt(len2);
    const v = graph.speeds[graph.trackOf[a]];
    best = {
      a,
      b,
      secToA: (segLen * t) / v,
      secToB: (segLen * (1 - t)) / v,
      point: [
        graph.lon[a] + (graph.lon[b] - graph.lon[a]) * t,
        graph.lat[a] + (graph.lat[b] - graph.lat[a]) * t,
      ],
      distM: d,
    };
  };

  for (const nIdx of cands) {
    const t = graph.trackOf[nIdx];
    if (nIdx > graph.start[t]) consider(nIdx - 1, nIdx);
    if (nIdx < graph.end[t]) consider(nIdx, nIdx + 1);
  }
  return best && best.distM <= tolM ? best : null;
}

/* ---- routing --------------------------------------------------------- */

/** Binary min-heap of [node, cost]. */
class Heap {
  constructor() {
    this.a = [];
  }
  push(node, cost) {
    const a = this.a;
    a.push([node, cost]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][1] <= a[i][1]) break;
      const tmp = a[p];
      a[p] = a[i];
      a[i] = tmp;
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][1] < a[m][1]) m = l;
        if (r < a.length && a[r][1] < a[m][1]) m = r;
        if (m === i) break;
        const tmp = a[m];
        a[m] = a[i];
        a[i] = tmp;
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

/**
 * Fastest path between two snapped points.
 *
 * @returns {{path: [number, number][], km: number, seconds: number}|null}
 *   null when the two points are in unconnected pieces of the graph — the
 *   caller draws that leg as a straight line and says so.
 */
export function route(graph, from, to) {
  const N = graph.nodeCount;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);
  const heap = new Heap();

  const seed = (node, cost) => {
    if (cost < dist[node]) {
      dist[node] = cost;
      heap.push(node, cost);
    }
  };
  seed(from.a, from.secToA);
  seed(from.b, from.secToB);

  const targets = [
    [to.a, to.secToA],
    [to.b, to.secToB],
  ];
  const isTarget = new Map(targets);

  let settled = 0;
  while (heap.size) {
    const [u, c] = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (isTarget.has(u)) {
      settled++;
      if (settled === isTarget.size) break;
    }
    if (c > dist[u]) continue;
    const t = graph.trackOf[u];
    if (u > graph.start[t]) {
      const w = graph.segSec[u - 1];
      if (c + w < dist[u - 1]) {
        dist[u - 1] = c + w;
        prev[u - 1] = u;
        heap.push(u - 1, c + w);
      }
    }
    if (u < graph.end[t]) {
      const w = graph.segSec[u];
      if (c + w < dist[u + 1]) {
        dist[u + 1] = c + w;
        prev[u + 1] = u;
        heap.push(u + 1, c + w);
      }
    }
    const ls = graph.links.get(u);
    if (ls) {
      for (const [v, w] of ls) {
        if (c + w < dist[v]) {
          dist[v] = c + w;
          prev[v] = u;
          heap.push(v, c + w);
        }
      }
    }
  }

  let bestNode = -1;
  let bestCost = Infinity;
  for (const [node, extra] of targets) {
    const total = dist[node] + extra;
    if (total < bestCost) {
      bestCost = total;
      bestNode = node;
    }
  }
  if (!Number.isFinite(bestCost)) return null;

  const nodes = [];
  for (let u = bestNode; u !== -1; u = prev[u]) nodes.push(u);
  nodes.reverse();

  const path = [from.point];
  for (const u of nodes) path.push([graph.lon[u], graph.lat[u]]);
  path.push(to.point);

  let km = 0;
  for (let i = 1; i < path.length; i++) {
    km += metres(
      path[i - 1][0],
      path[i - 1][1],
      path[i][0],
      path[i][1],
      Math.cos((path[i - 1][1] * Math.PI) / 180),
    );
  }
  return { path, km: km / 1000, seconds: bestCost };
}

/**
 * Snap both ends and route between them, in one call.
 *
 * @returns {{path: [number, number][], km: number, seconds: number,
 *            straight: boolean}}
 *   `straight: true` means no track connects the two points — the leg is
 *   the direct line, and the time is the slower end's speed.
 */
export function routeBetween(graph, fromLonLat, toLonLat, tolM = 40) {
  const a = snap(graph, fromLonLat[0], fromLonLat[1], tolM);
  const b = snap(graph, toLonLat[0], toLonLat[1], tolM);
  if (a && b) {
    const r = route(graph, a, b);
    if (r) return { ...r, straight: false };
  }
  const km =
    metres(
      fromLonLat[0],
      fromLonLat[1],
      toLonLat[0],
      toLonLat[1],
      Math.cos((fromLonLat[1] * Math.PI) / 180),
    ) / 1000;
  const v = a
    ? graph.speeds[graph.trackOf[a.a]]
    : b
      ? graph.speeds[graph.trackOf[b.a]]
      : DEFAULT_SPEED_KMH / 3.6;
  return {
    path: [fromLonLat, toLonLat],
    km,
    seconds: (km * 1000) / v,
    straight: true,
  };
}

/** Straight-line distance in km — measure mode's Direct mode. */
export function directKm(fromLonLat, toLonLat) {
  return (
    metres(
      fromLonLat[0],
      fromLonLat[1],
      toLonLat[0],
      toLonLat[1],
      Math.cos((fromLonLat[1] * Math.PI) / 180),
    ) / 1000
  );
}
