/* Manoeuvre image for the turn cell — which picture, on which side.
   Pure logic, no DOM — loaded by index.html and node-testable
   (tests/manoeuvre.test.mjs). Design:
   docs/plans/2026-11-17-nav-turn-band-design.md, section 3.

   A turn cue carries its signed turn angle (deg) and a type (left / right /
   straight, or a mark kind: danger, obstacle, gate, creek, …). Riding the
   track in reverse meets every turn from the other side, so left and right
   swap; the size of the turn does not change. */
(function (root) {
  'use strict';

  // limits on |deg|, inclusive at the top of each band
  const SLIGHT_MAX = 39, NORMAL_MAX = 110, SHARP_MAX = 155;
  const DANGER_KINDS = { danger: 1, obstacle: 1 };

  function sizeFor(absDeg) {
    if (absDeg <= SLIGHT_MAX) return 'slight';
    if (absDeg <= NORMAL_MAX) return 'turn';
    if (absDeg <= SHARP_MAX) return 'sharp';
    return 'uturn';
  }

  /* cue  { type, deg }   dir  1 = with the track, -1 = reversed
     → { img, side, mirror, tone }
       img     'slight' | 'turn' | 'sharp' | 'uturn' | 'straight' | 'mark'
       side    'left' | 'right' — where the image sits in the cell
       mirror  true when a right-hand symbol must be drawn mirrored
       tone    'turn' (turn-arrow colour) | 'danger' (danger colour)
       kind    the mark kind, for img 'mark' */
  function pick(cue, dir) {
    if (!cue) return null;
    let type = cue.type;
    if (dir < 0 && type === 'left') type = 'right';
    else if (dir < 0 && type === 'right') type = 'left';
    if (type === 'left' || type === 'right') {
      const img = sizeFor(Math.abs(Math.round(cue.deg || 0)));
      return { img, side: type, mirror: type === 'left', tone: 'turn' };
    }
    if (type === 'straight') return { img: 'straight', side: 'left', mirror: false, tone: 'turn' };
    return { img: 'mark', side: 'left', mirror: false, tone: DANGER_KINDS[type] ? 'danger' : 'turn', kind: type };
  }

  const api = { pick, sizeFor, SLIGHT_MAX, NORMAL_MAX, SHARP_MAX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DingoManoeuvre = api;
})(typeof self !== 'undefined' ? self : globalThis);
