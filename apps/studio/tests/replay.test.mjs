/* Replay engine headless tests: track in → expected ticks out. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setRef, processTrack, nearestOnTrack, toXY } from '../js/geom.js';
import { Replay } from '../js/replay.js';

/* straight synthetic track heading due north, ~1 km of points every ~8.8 m */
function straightTrack() {
  setRef(-33.3, 151.3);
  const pts = [];
  for (let i = 0; i <= 125; i++) pts.push([-33.3 + i * 0.00008, 151.3]);
  return processTrack('t', 'straight', pts);
}

test('processTrack resamples to ~8 m and accumulates length', () => {
  const trk = straightTrack();
  assert.ok(trk.lengthM > 1050 && trk.lengthM < 1150, 'length ' + trk.lengthM);
  const step = trk.cum[10] - trk.cum[9];
  assert.ok(step > 7 && step < 9, 'resample step ' + step);
});

test('ticks advance d by speed × rate and report the ground speed', () => {
  const trk = straightTrack();
  const r = new Replay();
  r.trk = trk; r.jitterM = 0; r.speedMs = 8.5; r.rate = 10;
  const fixes = [];
  r.addSink((lat, lon, acc, spd) => fixes.push({ lat, lon, spd }));
  for (let i = 0; i < 10; i++) r._tick();
  assert.ok(Math.abs(r.d - 85) < 1e-6, 'd after 10 ticks = ' + r.d); // 8.5 × 10 × 0.1s × 10
  assert.equal(fixes.length, 10);
  assert.equal(fixes[0].spd, 8.5);                       // reported speed, not playback speed
  assert.ok(fixes[9].lat > fixes[0].lat);                // moving north
});

test('end of track feeds a final speed-0 fix and stops', () => {
  const trk = straightTrack();
  const r = new Replay();
  r.trk = trk; r.jitterM = 0; r.d = trk.lengthM - 5; r.playing = true; r.timer = setInterval(() => {}, 9999);
  const fixes = [];
  r.addSink((lat, lon, acc, spd) => fixes.push(spd));
  r._tick();
  clearInterval(r.timer);
  assert.equal(r.playing, false);
  assert.equal(fixes[fixes.length - 1], 0);              // the stopped-rider fix
  assert.equal(r.d, trk.lengthM);
});

test('seek clamps to track bounds', () => {
  const trk = straightTrack();
  const r = new Replay();
  r.trk = trk; r.jitterM = 0;
  r.seek(-50); assert.equal(r.d, 0);
  r.seek(1e9); assert.equal(r.d, trk.lengthM);
});

test('off-track simulation displaces ~90 m perpendicular, then returns', () => {
  const trk = straightTrack();
  const r = new Replay();
  r.trk = trk; r.jitterM = 0; r.d = 500;
  let last = null;
  r.addSink((lat, lon) => { last = [lat, lon]; });
  r.simulateOffTrack(0.2); // 2 ticks
  r._feed(500, 8.5);
  const [x, y] = toXY(last[0], last[1]);
  const near = nearestOnTrack(trk, x, y, -1);
  assert.ok(near.d > 80 && near.d < 100, 'off by ' + near.d);
  r._feed(500, 8.5);       // second tick consumes the sim
  r._feed(500, 8.5);       // back on track
  const [x2, y2] = toXY(last[0], last[1]);
  assert.ok(nearestOnTrack(trk, x2, y2, -1).d < 5);
});
