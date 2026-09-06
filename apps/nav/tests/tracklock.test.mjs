// node --test apps/nav/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { vehicleFor, offDecision, projectOnTrack, displayPose, HOLD_MS } =
  require("../tracklock.js");

const ADV = { offM: 50, onM: 30, lock: true };
const ENDURO = { offM: 60, onM: 40, lock: false };

// ---- profile selection -------------------------------------------------
test("track mode picks the vehicle; other/absent fall back", () => {
  assert.equal(vehicleFor("adv", "enduro"), "adventure");
  assert.equal(vehicleFor("enduro", "adventure"), "enduro");
  assert.equal(vehicleFor("mtb", "enduro"), "mtb");
  assert.equal(vehicleFor("other", "enduro"), "enduro");
  assert.equal(vehicleFor(undefined, "walk"), "walk");
  assert.equal(vehicleFor(null, "adventure"), "adventure");
});

// ---- hysteresis, unlocked (today's enduro behaviour) -------------------
test("enduro: one fix beyond offM is off, one within onM is back, no flapping between", () => {
  const st = { off: false, beyondSince: null };
  let r = offDecision(st, { ...ENDURO, d: 61, acc: 30, t: 0 });
  assert.equal(r.off, true); assert.equal(r.wentOff, true);
  r = offDecision(st, { ...ENDURO, d: 50, acc: 5, t: 1000 }); // between onM and offM: stays off
  assert.equal(r.off, true); assert.equal(r.cameBack, false);
  r = offDecision(st, { ...ENDURO, d: 39, acc: 5, t: 2000 });
  assert.equal(r.off, false); assert.equal(r.cameBack, true);
  r = offDecision(st, { ...ENDURO, d: 55, acc: 5, t: 3000 }); // between: stays on
  assert.equal(r.off, false); assert.equal(r.wentOff, false);
});

test("enduro: the accuracy guard does not apply", () => {
  const st = { off: false, beyondSince: null };
  // wide accuracy circle that reaches the track would be held for ADV; enduro goes off at once
  const r = offDecision(st, { ...ENDURO, d: 65, acc: 60, t: 0 });
  assert.equal(r.off, true);
});

// ---- ADV: accuracy guard + hold ---------------------------------------
test("adv: a single wide-accuracy fix beyond offM is held", () => {
  const st = { off: false, beyondSince: null };
  const r = offDecision(st, { ...ADV, d: 80, acc: 60, t: 0 }); // 80 - 60 = 20 < 50
  assert.equal(r.off, false);
  assert.equal(st.beyondSince, 0);
});

test("adv: a tight-accuracy fix beyond offM is off at once", () => {
  const st = { off: false, beyondSince: null };
  const r = offDecision(st, { ...ADV, d: 60, acc: 8, t: 0 }); // 60 - 8 = 52 > 50
  assert.equal(r.off, true); assert.equal(r.wentOff, true);
});

test("adv: wide-accuracy fixes that stay beyond offM for the hold are off", () => {
  const st = { off: false, beyondSince: null };
  assert.equal(offDecision(st, { ...ADV, d: 80, acc: 60, t: 0 }).off, false);
  assert.equal(offDecision(st, { ...ADV, d: 82, acc: 60, t: 1000 }).off, false);
  assert.equal(offDecision(st, { ...ADV, d: 79, acc: 60, t: HOLD_MS - 1 }).off, false);
  const r = offDecision(st, { ...ADV, d: 81, acc: 60, t: HOLD_MS });
  assert.equal(r.off, true); assert.equal(r.wentOff, true);
});

test("adv: coming back inside offM before the hold resets it", () => {
  const st = { off: false, beyondSince: null };
  offDecision(st, { ...ADV, d: 80, acc: 60, t: 0 });
  offDecision(st, { ...ADV, d: 40, acc: 60, t: 1500 }); // back inside: hold clock resets
  assert.equal(st.beyondSince, null);
  const r = offDecision(st, { ...ADV, d: 80, acc: 60, t: 2500 }); // a fresh excursion, not 2.5 s old
  assert.equal(r.off, false);
});

test("adv: re-lock has no guard — a fix within onM clears at once", () => {
  const st = { off: true, beyondSince: null };
  const r = offDecision(st, { ...ADV, d: 29, acc: 80, t: 0 });
  assert.equal(r.off, false); assert.equal(r.cameBack, true);
});

// ---- projection ------------------------------------------------------
// a straight track heading due north: (0,0) (0,8) (0,16) (0,24)
const NORTH = Float32Array.from([0, 0, 0, 8, 0, 16, 0, 24]);

test("projectOnTrack finds the foot on the adjacent segment, not the vertex", () => {
  const p = projectOnTrack(NORTH, 4, 1, 5, 12); // beside the 8→16 segment
  assert.ok(Math.abs(p.x - 0) < 1e-6);
  assert.ok(Math.abs(p.y - 12) < 1e-6);
  assert.ok(Math.abs(p.d - 5) < 1e-6);
  assert.equal(Math.round(p.bearing), 0);
});

test("projectOnTrack clamps to the ends of the track", () => {
  const p = projectOnTrack(NORTH, 4, 3, 3, 40);
  assert.ok(Math.abs(p.y - 24) < 1e-6);
  assert.equal(Math.round(p.bearing), 0);
  const q = projectOnTrack(NORTH, 4, 0, -3, -10);
  assert.ok(Math.abs(q.y - 0) < 1e-6);
});

test("projectOnTrack bearing follows track order on a bend", () => {
  // north then east: (0,0) (0,10) (10,10)
  const xy = Float32Array.from([0, 0, 0, 10, 10, 10]);
  const east = projectOnTrack(xy, 3, 1, 6, 12); // nearer the eastbound leg
  assert.equal(Math.round(east.bearing), 90);
  const north = projectOnTrack(xy, 3, 1, -2, 4);
  assert.equal(Math.round(north.bearing), 0);
});

// ---- display pose ----------------------------------------------------
const raw = { x: 5, y: 12, heading: 17 };
const proj = { x: 0, y: 12, bearing: 0 };

test("unlocked profile draws the raw fix and GPS heading", () => {
  const d = displayPose({ lock: false, off: false, raw, proj, course: 17, dir: 1 });
  assert.deepEqual(d, { x: 5, y: 12, heading: 17, locked: false });
});

test("locked and on track draws the projected point with the track bearing", () => {
  const d = displayPose({ lock: true, off: false, raw, proj, course: 17, dir: 1 });
  assert.equal(d.locked, true);
  assert.equal(d.x, 0); assert.equal(d.y, 12);
  assert.equal(d.heading, 0);
});

test("locked but off track falls back to the raw fix", () => {
  const d = displayPose({ lock: true, off: true, raw, proj, course: 17, dir: 1 });
  assert.equal(d.locked, false);
  assert.equal(d.x, 5); assert.equal(d.heading, 17);
});

test("heading is turned to face the GPS course, so it never points backwards", () => {
  const d = displayPose({ lock: true, off: false, raw, proj, course: 190, dir: 1 });
  assert.equal(d.heading, 180);
});

test("with no course yet, the direction vote decides", () => {
  const fwd = displayPose({ lock: true, off: false, raw, proj, course: null, dir: 1 });
  assert.equal(fwd.heading, 0);
  const rev = displayPose({ lock: true, off: false, raw, proj, course: null, dir: -1 });
  assert.equal(rev.heading, 180);
});

test("a projection with no bearing (degenerate track) is not locked", () => {
  const d = displayPose({ lock: true, off: false, raw, proj: { x: 0, y: 0, bearing: null }, course: 1, dir: 1 });
  assert.equal(d.locked, false);
});
