/* Google Maps hand-off for a track, plus the link finder the paste path uses.
   Pure logic, no DOM — loaded by index.html and node-testable
   (tests/gmaps-link.test.mjs). Design:
   docs/plans/nav-2026-09-06-gmaps-link-import-design.md

   The Maps URL takes an origin, a destination and at most MAX_STOPS
   intermediate stops, and Google routes between them on its own roads. So
   the stops go where the track bends most: Douglas-Peucker with the
   tolerance searched until at most MAX_STOPS interior points survive. */
(function (root) {
  'use strict';

  const MAX_STOPS = 9;

  /* Equirectangular metres around the track's first point — accurate to
     well under a metre over a ride, and the only thing DP cares about is
     which point sticks out most. */
  function toXY(coordsLL) {
    const lat0 = coordsLL[0][1] * Math.PI / 180;
    const kx = 111320 * Math.cos(lat0), ky = 110540;
    const lon0 = coordsLL[0][0], la0 = coordsLL[0][1];
    return coordsLL.map(p => [(p[0] - lon0) * kx, (p[1] - la0) * ky]);
  }

  /* Douglas-Peucker significance of every point: the deviation (metres) at
     which DP would keep it, capped by its parent's so the ranking is
     monotone. Taking the top N by rank is exactly DP at the tolerance that
     leaves N points — without searching for that tolerance, and it fills
     the budget instead of undershooting it on symmetric shapes. */
  function dpRank(xy) {
    const n = xy.length;
    const rank = new Float64Array(n);
    rank[0] = rank[n - 1] = Infinity;
    const stack = [[0, n - 1, Infinity]];
    while (stack.length) {
      const [a, b, cap] = stack.pop();
      if (b - a < 2) continue;
      const [ax, ay] = xy[a], [bx, by] = xy[b];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
      let mi = -1, md = 0;
      for (let i = a + 1; i < b; i++) {
        const t = Math.max(0, Math.min(1, ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / L2));
        const d = Math.hypot(xy[i][0] - (ax + t * dx), xy[i][1] - (ay + t * dy));
        if (d > md) { md = d; mi = i; }
      }
      if (mi < 0) continue; // every interior point sits on the chord
      rank[mi] = Math.min(md, cap);
      stack.push([a, mi, rank[mi]], [mi, b, rank[mi]]);
    }
    return rank;
  }

  /* coordsLL: [lon, lat] pairs (GeoJSON order, what a nav track carries).
     Returns [lat, lon] stops: first point, ≤ maxStops interior, last point. */
  function pickStops(coordsLL, maxStops) {
    const max = maxStops === undefined ? MAX_STOPS : maxStops;
    if (!coordsLL || coordsLL.length < 2) throw new Error('need at least two points');
    const asStop = i => [coordsLL[i][1], coordsLL[i][0]];
    const n = coordsLL.length;
    if (n - 2 <= max) return coordsLL.map((_, i) => asStop(i));
    const rank = dpRank(toXY(coordsLL));
    const interior = [];
    for (let i = 1; i < n - 1; i++) if (rank[i] > 0) interior.push(i);
    interior.sort((p, q) => rank[q] - rank[p] || p - q);
    const idx = interior.slice(0, max).sort((p, q) => p - q);
    return [0, ...idx, n - 1].map(asStop);
  }

  /* stops: [lat, lon] from pickStops. Google Maps URLs API, directions mode. */
  function directionsUrl(stops, travelmode) {
    if (!stops || stops.length < 2) throw new Error('need at least two stops');
    const f = s => s[0].toFixed(5) + ',' + s[1].toFixed(5);
    const q = ['api=1', 'origin=' + f(stops[0]), 'destination=' + f(stops[stops.length - 1])];
    if (stops.length > 2) q.push('waypoints=' + encodeURIComponent(stops.slice(1, -1).map(f).join('|')));
    q.push('travelmode=' + (travelmode || 'driving'));
    return 'https://www.google.com/maps/dir/?' + q.join('&');
  }

  /* The first Google Maps link in a blob of shared or pasted text, or null.
     Same hosts the site endpoint accepts (its is_gmaps_host twin). */
  const LINK_RE = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl|(?:[a-z0-9-]+\.)*google\.com)\/[^\s<>"'）)]*/i;
  function findLink(text) {
    if (!text) return null;
    const m = String(text).match(LINK_RE);
    return m ? m[0].replace(/[.,;:!?]+$/, '') : null;
  }

  const api = { pickStops, directionsUrl, findLink, MAX_STOPS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DingoGmaps = api;
})(typeof self !== 'undefined' ? self : globalThis);
