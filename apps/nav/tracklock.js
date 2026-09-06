/* Track lock — Google-Maps-style position lock for ADV tracks.
   Pure logic, no DOM/IDB — loaded by index.html and node-testable
   (tests/tracklock.test.mjs). Design:
   docs/plans/2026-09-06-nav-track-lock-design.md

   Three jobs:
     vehicleFor   — a track's ride mode picks the handling profile (vehicle)
     offDecision  — the off-track state machine: hysteresis for every profile,
                    plus an accuracy guard and a short hold for locked ones
     projectOnTrack / displayPose — where to DRAW the rider (on the line while
                    locked, at the raw fix otherwise) and which way to point

   Coordinates are the app's local metres (x east, y north); bearings are
   compass degrees, matching index.html's bearing(). */
(function (root) {
  'use strict';

  /* ride mode (rides.mode on the server, carried per track in the nav pack)
     → vehicle profile. 'other' and absent fall through to the caller's fallback,
     which is the vehicle setting. */
  const MODE_VEHICLE = { adv: 'adventure', enduro: 'enduro', mtb: 'mtb' };
  function vehicleFor(mode, fallback) {
    return (mode && MODE_VEHICLE[mode]) || fallback;
  }

  const HOLD_MS = 2000; // a locked profile tolerates this long beyond offM before letting go

  /* One step of the off-track state machine.
       st   { off, beyondSince }  — mutated in place and returned
       f    { d, acc, t, offM, onM, lock, holdMs? }
            d = metres from the track, acc = fix accuracy radius (m), t = ms clock
     Returns { off, wentOff, cameBack }.
     Unlocked (enduro): one fix beyond offM is off; one fix within onM is back.
     Locked (ADV): a fix beyond offM only counts if its accuracy circle cannot
     reach the track (d - acc > offM), or if fixes have stayed beyond offM for
     holdMs. Re-lock has no guard — coming back should feel immediate. */
  function offDecision(st, f) {
    const hold = f.holdMs == null ? HOLD_MS : f.holdMs;
    const was = !!st.off;
    if (was) {
      if (f.d < f.onM) { st.off = false; st.beyondSince = null; }
    } else if (f.d > f.offM) {
      if (!f.lock || f.d - (f.acc || 0) > f.offM) { st.off = true; st.beyondSince = null; }
      else {
        if (st.beyondSince == null) st.beyondSince = f.t;
        if (f.t - st.beyondSince >= hold) { st.off = true; st.beyondSince = null; }
      }
    } else st.beyondSince = null;
    return { off: !!st.off, wentOff: !was && !!st.off, cameBack: was && !st.off };
  }

  function bearingOf(ax, ay, bx, by) {
    return Math.atan2(bx - ax, by - ay) * 180 / Math.PI;
  }
  function norm(a) { a %= 360; if (a < 0) a += 360; return a; }
  function angDiff(a, b) { let d = b - a; while (d > 180) d -= 360; while (d < -180) d += 360; return d; }

  /* Project (x, y) onto the track around vertex idx (the nearest vertex, from
     nearestOnTrack). Tries the segment into idx and the segment out of it, and
     keeps the closer foot. xy is the flat [x0,y0,x1,y1,…] vertex array, n its
     vertex count. Returns { x, y, d, bearing } — bearing is the segment's
     bearing in track order (vertex i → i+1). */
  function projectOnTrack(xy, n, idx, x, y) {
    let best = null;
    const tryseg = (i, j) => {
      const ax = xy[i * 2], ay = xy[i * 2 + 1], bx = xy[j * 2], by = xy[j * 2 + 1];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      let u = L2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
      u = Math.max(0, Math.min(1, u));
      const px = ax + dx * u, py = ay + dy * u;
      const d = Math.hypot(x - px, y - py);
      if (!best || d < best.d) best = { x: px, y: py, d, bearing: L2 > 0 ? norm(bearingOf(ax, ay, bx, by)) : null };
    };
    if (n <= 1 || idx < 0) return { x: xy[0], y: xy[1], d: Math.hypot(x - xy[0], y - xy[1]), bearing: null };
    if (idx > 0) tryseg(idx - 1, idx);
    if (idx < n - 1) tryseg(idx, idx + 1);
    // a single-segment track with idx at either end already covered it
    if (best.bearing == null) { // zero-length segment(s): borrow the nearest real one
      for (let k = 1; k < n && best.bearing == null; k++) {
        const i = Math.max(0, idx - k), j = Math.min(n - 1, idx + k);
        if (j > i) { const b = bearingOf(xy[i * 2], xy[i * 2 + 1], xy[j * 2], xy[j * 2 + 1]); best.bearing = norm(b); }
      }
    }
    return best;
  }

  /* Which way the arrow points and where the dot sits.
       p { lock, off, raw: {x, y, heading}, proj: {x, y, bearing}, course, dir }
         course — the smoothed GPS course (may be null when not yet moving)
         dir    — riding direction along the track, +1 forward / -1 reverse
     Locked (lock && !off): position is the projected point and heading is the
     track bearing, turned to face the way we're going. Which way that is comes
     from the GPS course when there is one (so it can never point backwards at
     the start of a ride), else from the direction vote. */
  function displayPose(p) {
    const locked = !!p.lock && !p.off && p.proj && p.proj.bearing != null;
    if (!locked) return { x: p.raw.x, y: p.raw.y, heading: p.raw.heading, locked: false };
    let b = p.proj.bearing;
    const flip = (p.course != null && !isNaN(p.course))
      ? Math.abs(angDiff(p.course, b)) > 90
      : p.dir < 0;
    if (flip) b = norm(b + 180);
    return { x: p.proj.x, y: p.proj.y, heading: b, locked: true };
  }

  const api = { vehicleFor, offDecision, projectOnTrack, displayPose, MODE_VEHICLE, HOLD_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DingoTrackLock = api;
})(typeof self !== 'undefined' ? self : globalThis);
