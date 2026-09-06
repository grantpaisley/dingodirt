// node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { pickStops, directionsUrl, findLink, MAX_STOPS } = require("../gmaps-link.js");

// An out-and-back near Palm Dale (Central Coast NSW), 201 points: a line
// with a few metres of GPS wobble and three real doglegs of different sizes
// (the offset persists past each corner, the way a road turns), then the
// same way home a lane over. The corners and the far-end hairpin are the
// bends that matter; the wobble must not be.
function outAndBack() {
  // corner vertices: [index, lat offset]; straight between them
  const V = [[0, 0], [25, 0.02], [50, -0.01], [75, 0.005], [100, 0]];
  const pts = [];
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    const k = V.findIndex(v => v[0] >= i);
    const [i0, o0] = V[Math.max(0, k - 1)], [i1, o1] = V[k];
    const off = i1 === i0 ? o1 : o0 + (o1 - o0) * (i - i0) / (i1 - i0);
    pts.push([151.32 + t * 0.1, -33.28 - t * 0.05 + Math.sin(t * 20) * 0.00005 + off]);
  }
  for (let i = 99; i >= 0; i--) pts.push([pts[i][0], pts[i][1] - 0.0002]);
  return pts;
}

// A loop: a rough circle of 120 points.
function loop() {
  const pts = [];
  for (let i = 0; i <= 120; i++) {
    const a = (i / 120) * Math.PI * 2;
    pts.push([151.32 + Math.cos(a) * 0.05, -33.28 + Math.sin(a) * 0.04]);
  }
  pts[pts.length - 1] = pts[0].slice();
  return pts;
}

test("pickStops keeps ends, caps interior stops, returns lat,lon", () => {
  const src = outAndBack();
  const stops = pickStops(src);
  assert.ok(stops.length >= 2 && stops.length - 2 <= MAX_STOPS, `got ${stops.length}`);
  assert.deepEqual(stops[0], [src[0][1], src[0][0]]);
  assert.deepEqual(stops[stops.length - 1], [src[src.length - 1][1], src[src.length - 1][0]]);
  // every dogleg out and back, plus the hairpin at the far end, beats the wobble
  const chosen = stops.map(s => src.findIndex(p => p[1] === s[0] && p[0] === s[1]));
  for (const c of [25, 50, 75, 100, 125, 150, 175]) assert.ok(chosen.includes(c), `corner ${c} kept — got ${chosen}`);
});

test("pickStops uses as many stops as it may, in track order", () => {
  const src = loop();
  const stops = pickStops(src, 9);
  assert.equal(stops.length, 11); // a smooth curve fills the budget exactly
  assert.deepEqual(stops[0], stops[stops.length - 1]); // a loop ends where it starts
  // interior stops appear in the same order as along the track
  const idx = stops.slice(1, -1).map(s => src.findIndex(p => p[1] === s[0] && p[0] === s[1]));
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1]);
});

test("pickStops passes short tracks through unchanged", () => {
  const src = [[151.0, -33.0], [151.1, -33.1], [151.2, -33.0]];
  assert.deepEqual(pickStops(src), [[-33.0, 151.0], [-33.1, 151.1], [-33.0, 151.2]]);
  assert.throws(() => pickStops([[151, -33]]));
});

test("directionsUrl builds the Maps URLs API form", () => {
  const url = directionsUrl([[-33.28, 151.32], [-33.3, 151.34], [-33.31, 151.36]]);
  assert.equal(url,
    "https://www.google.com/maps/dir/?api=1&origin=-33.28000,151.32000" +
    "&destination=-33.31000,151.36000&waypoints=-33.30000%2C151.34000&travelmode=driving");
  const two = directionsUrl([[-33.28, 151.32], [-33.31, 151.36]]);
  assert.ok(!two.includes("waypoints="));
  const multi = directionsUrl([[0, 0], [1, 1], [2, 2], [3, 3]]);
  assert.ok(multi.includes("waypoints=1.00000%2C1.00000%7C2.00000%2C2.00000"));
});

test("findLink pulls the Google Maps link out of shared text", () => {
  assert.equal(findLink("Check out this route https://maps.app.goo.gl/452uG78w5P8SiX416"),
    "https://maps.app.goo.gl/452uG78w5P8SiX416");
  assert.equal(findLink("https://www.google.com/maps/dir/A+St/B+Rd/data=!3e0?utm_source=x."),
    "https://www.google.com/maps/dir/A+St/B+Rd/data=!3e0?utm_source=x");
  assert.equal(findLink("nothing here"), null);
  assert.equal(findLink("https://evil.com/maps/dir/A/B"), null);
  assert.equal(findLink("https://notgoogle.com/maps"), null);
  assert.equal(findLink(""), null);
});
