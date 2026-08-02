/* Replay engine — one engine, N viewports (design 2026-08-02).
   Pure logic ported from DingoNav's demo mode: track in → ticks out.
   Nav conflated SPEED / TICK_MS / playback multiplier; here they're separate:
     speedMs — the ground speed the ride *reports* (default 8.5 m/s ≈ 30 km/h)
     rate    — playback multiplier (default 10×, Nav's demo feel)
   Pause is a genuine speed-0 fix, not a stopped clock — downstream "am I
   stopped?" behaviour (zoom unlock, frozen course bearing) stays honest.
   Ticks carry lat/lon/speed only; heading is null so each viewport's nav
   logic derives bearing from successive positions, exactly like real GPS. */

import { idxAt, toLL, dist, nearestOnTrack } from './geom.js';

const TICK_MS = 100; // 10 Hz, Nav's demo cadence

export class Replay {
  constructor() {
    this.trk = null;
    this.d = 0;             // metres along track
    this.speedMs = 8.5;     // reported ground speed
    this.rate = 10;         // playback multiplier
    this.jitterM = 6;       // ±3 m GPS noise (Nav's demo). 0 = clean line.
    this.offT = 0;          // ticks of simulated off-track left (Nav training's 90 m sidestep)
    this.offSign = null;
    this.playing = false;
    this.timer = null;
    this.sinks = new Set(); // onFix(lat, lon, acc, speed, heading) receivers
    this.onState = null;    // (this) → UI refresh (play state, d, finished)
  }
  setTrack(trk) { this.stop(); this.trk = trk; this.d = 0; this._notify(); }
  addSink(fn) { this.sinks.add(fn); return () => this.sinks.delete(fn); }

  play() {
    if (!this.trk || this.playing) return;
    if (this.d >= this.trk.lengthM - 1) this.d = 0; // replay from the end = start over
    this.playing = true;
    this.timer = setInterval(() => this._tick(), TICK_MS);
    this._notify();
  }
  pause() {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer); this.timer = null;
    this._feed(this.d, 0); // the stopped-rider fix — Nav's TRAIN.holdD grammar
    this._notify();
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  stop() { this.playing = false; clearInterval(this.timer); this.timer = null; this._notify(); }
  seek(d) {
    if (!this.trk) return;
    this.d = Math.max(0, Math.min(this.trk.lengthM, d));
    if (!this.playing) this._feed(this.d, 0); // scrubbing while paused still moves the rider
    this._notify();
  }
  setRate(r) { this.rate = r; this._notify(); }
  setSpeedKmh(kmh) { this.speedMs = kmh / 3.6; this._notify(); }

  _tick() {
    this.d += this.speedMs * this.rate * TICK_MS / 1000;
    if (this.d >= this.trk.lengthM) {
      this.d = this.trk.lengthM;
      this._feed(this.d, 0);
      this.pause();
      this.finished = true; this._notify(); this.finished = false;
      return;
    }
    this._feed(this.d, this.speedMs);
    this._notify(); // scrubber follows the ride
  }
  /* simulate wandering off the route for ~t seconds: 90 m perpendicular, past
     Nav's 60 m off-track threshold. Side picked once per act, away from any
     other leg of the loop (Nav's training-ride trick — drifting toward a
     nearby return leg would ring "back on track" early). */
  simulateOffTrack(seconds = 5) { this.offT = Math.round(seconds * 1000 / TICK_MS); }

  _feed(dd, spd) {
    const trk = this.trk;
    const i = idxAt(trk, dd);
    let x = trk.xy[i * 2], y = trk.xy[i * 2 + 1];
    if (this.offT > 0) {
      const j2 = Math.min(trk.n - 1, i + 1);
      const dx = trk.xy[j2 * 2] - x, dy = trk.xy[j2 * 2 + 1] - y, m = Math.hypot(dx, dy) || 1;
      if (this.offSign == null)
        this.offSign = nearestOnTrack(trk, x - dy / m * 90, y + dx / m * 90).d >=
                       nearestOnTrack(trk, x + dy / m * 90, y - dx / m * 90).d ? 1 : -1;
      x -= this.offSign * dy / m * 90; y += this.offSign * dx / m * 90;
      if (--this.offT === 0) this.offSign = null;
    }
    const j = () => (Math.random() - 0.5) * this.jitterM;
    const [lat, lon] = toLL(x + j(), y + j());
    for (const fn of this.sinks) fn(lat, lon, 8, spd, null);
  }
  _notify() { if (this.onState) this.onState(this); }
}
