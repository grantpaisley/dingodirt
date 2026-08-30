/* Track graph — the junction rule, the time weighting, and routing.
   (core/track-graph/graph.js, docs/plans/2026-08-30-track-graph-and-phone-
   plan-design.md.)

   The rule under test: two tracks running close and parallel are a fire
   trail and the singletrack beside it. They must stay separate lines with
   separate times, and link only where they truly cross or end. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGraph,
  routeBetween,
  snap,
  speedMs,
  NEAR_M,
  MIN_SPEED_KMH,
  MAX_SPEED_KMH,
} from '../core/track-graph/graph.js';

// A metre in degrees, near the Flinders (lat -31): lon degrees are shorter.
const LAT0 = -31;
const M_LAT = 1 / 110540;
const M_LON = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));

/** A straight west-to-east track: `len` metres, a point every `step` m. */
function eastward(lon0, lat0, len, step = 25) {
  const path = [];
  for (let d = 0; d <= len; d += step) path.push([lon0 + d * M_LON, lat0]);
  return path;
}

/** A straight south-to-north track. */
function northward(lon0, lat0, len, step = 25) {
  const path = [];
  for (let d = 0; d <= len; d += step) path.push([lon0, lat0 + d * M_LAT]);
  return path;
}

const linkCount = (g) => {
  let n = 0;
  for (const list of g.links.values()) n += list.length;
  return n / 2; // stored both ways
};

test('parallel tracks 8 m apart never link along the run', () => {
  // A fire trail and its singletrack: 3 km side by side, 8 m apart. Well
  // inside NEAR_M, so proximity alone would weld them at every vertex.
  const fireTrail = eastward(138.6, LAT0, 3000);
  const singletrack = eastward(138.6, LAT0 + 8 * M_LAT, 3000);
  const g = buildGraph([
    { id: 'fire', path: fireTrail, speedKmh: 24 },
    { id: 'single', path: singletrack, speedKmh: 9 },
  ]);

  assert.ok(NEAR_M > 8, 'the fixture must sit inside the proximity tolerance');
  // The corridor is linked only where it starts and ends — the two places
  // the tracks genuinely part company — and nowhere along its length.
  assert.ok(linkCount(g) <= 2, `expected at most 2 end links, got ${linkCount(g)}`);
  assert.equal(g.corridorRuns, 1, 'the run should be recognised as one corridor');
});

test('each track carries its own time, and the router prefers the fast one', () => {
  const fire = { id: 'fire', path: eastward(138.6, LAT0, 3000), speedKmh: 24 };
  const single = {
    id: 'single',
    path: eastward(138.6, LAT0 + 8 * M_LAT, 3000),
    speedKmh: 9,
  };

  // Alone, each track costs what its own speed says. 3 km at 24 km/h is
  // 7.5 min; the same 3 km of singletrack is 20 min.
  const aOnly = routeBetween(buildGraph([fire]), fire.path[0], fire.path.at(-1));
  const bOnly = routeBetween(buildGraph([single]), single.path[0], single.path.at(-1));
  assert.ok(Math.abs(aOnly.km - 3) < 0.05, `fire trail ~3 km, got ${aOnly.km}`);
  assert.ok(Math.abs(bOnly.km - 3) < 0.05, `singletrack ~3 km, got ${bOnly.km}`);
  assert.ok(Math.abs(aOnly.seconds - 450) < 30, `fire trail ~450 s, got ${aOnly.seconds}`);
  assert.ok(Math.abs(bOnly.seconds - 1200) < 60, `singletrack ~1200 s, got ${bOnly.seconds}`);
  assert.ok(bOnly.seconds > aOnly.seconds * 2);

  // Together, the corridor's two ends are linked (the tracks part company
  // there), so a rider heading up the singletrack CAN step onto the fire
  // trail. Routing by time, they should — and that is the feature: the
  // graph knows the fast line from the slow one.
  const g = buildGraph([fire, single]);
  const both = routeBetween(g, single.path[0], single.path.at(-1));
  assert.equal(both.straight, false);
  assert.ok(
    both.seconds < bOnly.seconds * 0.6,
    `with the fire trail available the time should collapse, got ${both.seconds}`,
  );
});

test('a third track crossing them does link, at each crossing', () => {
  const fire = eastward(138.6, LAT0, 3000);
  const single = eastward(138.6, LAT0 + 8 * M_LAT, 3000);
  // A north-south track through the middle of both, at right angles.
  const cross = northward(138.6 + 1500 * M_LON, LAT0 - 200 * M_LAT, 600);
  const g = buildGraph([
    { id: 'fire', path: fire, speedKmh: 24 },
    { id: 'single', path: single, speedKmh: 9 },
    { id: 'cross', path: cross, speedKmh: 15 },
  ]);

  // The crossing track meets each parallel track once.
  const crossIdx = g.ids.indexOf('cross');
  let crossLinks = 0;
  for (const [node, list] of g.links) {
    if (g.trackOf[node] !== crossIdx) continue;
    crossLinks += list.length;
  }
  assert.ok(crossLinks >= 2, `crossing track should link to both, got ${crossLinks}`);

  // And a route from the fire trail onto the singletrack must go through
  // the crossing rather than hopping the 8 m gap.
  const r = routeBetween(g, fire[0], single[single.length - 1]);
  assert.equal(r.straight, false);
  assert.ok(r.km > 3, `a real route detours through the crossing, got ${r.km} km`);
});

test('a spur that ends on another track always links', () => {
  // A dead-end spur meeting a trail head-on: its bearing matches the
  // trail's, so only the end-point exception can link it.
  const trail = eastward(138.6, LAT0, 1000);
  const spur = eastward(138.6 + 1000 * M_LON, LAT0, 400);
  const g = buildGraph([
    { id: 'trail', path: trail, speedKmh: 15 },
    { id: 'spur', path: spur, speedKmh: 15 },
  ]);
  const r = routeBetween(g, trail[0], spur[spur.length - 1]);
  assert.equal(r.straight, false, 'the spur must be reachable from the trail');
  assert.ok(Math.abs(r.km - 1.4) < 0.06, `expected ~1.4 km, got ${r.km}`);
});

test('unconnected pieces give a straight leg, not a refusal', () => {
  const here = eastward(138.6, LAT0, 500);
  const faraway = eastward(139.6, LAT0, 500);
  const g = buildGraph([
    { id: 'here', path: here, speedKmh: 15 },
    { id: 'far', path: faraway, speedKmh: 15 },
  ]);
  const r = routeBetween(g, here[0], faraway[0]);
  assert.equal(r.straight, true);
  assert.equal(r.path.length, 2);
  assert.ok(r.km > 90, `a degree of longitude here is ~95 km, got ${r.km}`);
  assert.ok(r.seconds > 0);
});

test('a click snaps to the nearest point on an edge, not to a vertex', () => {
  // Vertices every 100 m; click level with the middle of one segment.
  const path = eastward(138.6, LAT0, 1000, 100);
  const g = buildGraph([{ id: 'a', path, speedKmh: 15 }]);
  const clickLon = 138.6 + 250 * M_LON;
  const s = snap(g, clickLon, LAT0 + 5 * M_LAT, 40);
  assert.ok(s, 'the click is 5 m off the line and must snap');
  // Nearest vertex is 50 m away; the nearest point on the edge is 5 m away.
  assert.ok(s.distM < 6, `expected ~5 m to the edge, got ${s.distM}`);
  const offset = Math.abs(s.point[0] - clickLon) / M_LON;
  assert.ok(offset < 1, `the snapped point should sit under the click, off by ${offset} m`);
});

test('speed falls back from the track average to the ride mode', () => {
  assert.ok(Math.abs(speedMs({ speedKmh: 18 }) - 5) < 0.01);
  assert.ok(Math.abs(speedMs({ speedKmh: null, mode: 'hike' }) - 4.5 / 3.6) < 0.01);
  // A planned route carries no average at all.
  assert.ok(speedMs({ mode: 'nonesuch' }) > 0);
});

test('a car trip in the library cannot rewrite the plan', () => {
  // Measured against Grant's own library: "Narrandera to Arcadia, 657 km"
  // is a drive, stored as a track, averaging 91.7 km/h. Unclamped it wins
  // every route by time and reports an hour nobody could ride.
  assert.ok(speedMs({ speedKmh: 91.7, mode: 'mtb' }) <= MAX_SPEED_KMH / 3.6 + 1e-9);
  assert.ok(Math.abs(speedMs({ speedKmh: 91.7 }) - MAX_SPEED_KMH / 3.6) < 1e-9);
  // And a drift-ridden track cannot look like a week-long crawl.
  assert.ok(Math.abs(speedMs({ speedKmh: 1.2 }) - MIN_SPEED_KMH / 3.6) < 1e-9);
});

test('an empty or single-point track cannot break the build', () => {
  const g = buildGraph([
    { id: 'empty', path: [], speedKmh: 15 },
    { id: 'dot', path: [[138.6, LAT0]], speedKmh: 15 },
    { id: 'real', path: eastward(138.6, LAT0, 200), speedKmh: 15 },
  ]);
  assert.deepEqual(g.ids, ['real']);
  assert.ok(g.nodeCount > 1);
});
