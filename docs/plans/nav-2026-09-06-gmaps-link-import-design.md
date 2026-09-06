# Nav: Google Maps link import and "open in Google Maps" — design

2026-09-06. Brainstormed and validated section-by-section with Grant.

Two small features for DingoNav, both about Google Maps:

1. **Import a shared Google Maps route.** Google Maps → Share gives a
   `maps.app.goo.gl/…` link. Paste it (or share it straight to the installed
   PWA) and the route becomes a normal nav track.
2. **Open a track in Google Maps.** A small icon on each track tile opens
   Google Maps directions along the track.

## Decisions made during brainstorming

- The original ask was "KML import" and "convert the GPX to KML and open it
  in Google". Neither survives contact with Google Maps: the consumer app
  cannot open a KML at all (the hosted-KML overlay went in 2015), and the
  real import source is a shared *link*, not a file. KML is out of scope.
- **Icon = directions along the track**, not "navigate to the trailhead"
  and not a Google Earth hand-off. Google Maps takes an origin, a
  destination and at most 9 intermediate stops and routes between them on
  its own roads, so singletrack sections will not match exactly. That is
  accepted: the job is turn-by-turn in the Maps app on the road bits.
- **Travel mode is driving.** Google has no motorbike mode and cycling
  routing avoids the roads we actually ride.
- **Link import goes through a site endpoint**, not the daemon. Nav is a
  static Pages site on a phone; the daemon sits on Grant's home network and
  its own `/api/import/gmaps` files the result into the library rather than
  handing back a GPX. Tunnelling the daemon was rejected. The Rust logic in
  `core/rust/google/src/maps.rs` is ported to TypeScript and stays
  duplicated on purpose, pinned by the same URL fixtures in both test
  suites.
- **The endpoint is open, rate limited per IP**, the same pattern as the
  report route. Sign-in was rejected (nav has no sign-in UI) and Turnstile
  was rejected (a widget inside nav, with gloves). The Google key is
  restricted to the Routes API in the Cloud console, so a leak buys nothing
  else. Worst case abuse is a few dollars.
- **One PR**, site and nav together, so the whole thing lands tonight. The
  icon needs nothing from the site; the link import goes live once
  `GOOGLE_MAPS_API_KEY` is set in the Vercel env.

## 1. The link endpoint on dingodirt.com

`POST /api/routes/gmaps` in `apps/site/app/api/routes/gmaps/route.ts`.
Body: `{ "url": "<pasted link>" }`. Success: the GPX text as
`application/gpx+xml`. Failure: `{ ok: false, error }` with a message nav
shows in a toast. CORS is `*`, with an `OPTIONS` handler for the preflight,
because nav posts JSON from another origin.

`apps/site/lib/gmaps.ts` is a line-for-line port of the Rust module:

- `resolveUrl` — GET the short link following redirects and return the final
  URL. Full `/maps/dir/` links pass straight through.
- `parseDirUrl` — stop names from the path segments up to the `@` or `data=`
  marker; precise lat/lon pairs from the `!3d…!4d…` groups in the data blob;
  travel mode from `!3e`; a raw-coordinate stop parsed as its own position.
- `computeRoute` — the Routes API call with the same body, field mask and
  high-quality polyline flag as the daemon. Key from `GOOGLE_MAPS_API_KEY`.
- `decodePolyline`, `buildRouteGpx` — polyline decoder and the
  timestamp-free GPX writer, same title rule as the daemon so a route
  imported in Plan and in nav gets the same name.

Guards, in order, before any Google call: the host allow-list copied from
the daemon's `is_gmaps_host` (checked on the pasted link *and* on the
resolved link, so a redirect cannot land elsewhere); the per-IP window from
the report route, pulled out into `apps/site/lib/ratelimit.ts` so both
routes share it; a 422 with a setup hint when the key is missing, as the
daemon does.

Tests: `apps/site/lib/gmaps.test.ts` with the Greenbank loop fixture and the
other cases from the Rust tests.

## 2. The link import in nav

A **"Google Maps link…"** button beside *Load files* in the Tracks tab.
Tapping it follows the config-paste pattern already in nav: read the
clipboard, and if that holds a Google Maps link use it, else fall back to a
prompt. Nav posts the link to the endpoint and hands the returned GPX text
to `addFile`. From there nothing is new: content-hash id (re-importing the
same link overwrites rather than duplicates), IndexedDB persistence, offline
use, turn cues from geometry. The imported track is selected, since a shared
route is the one you are about to ride.

`manifest.json` gains a `share_target` so that on Android, Google Maps →
Share → DingoNav lands the link directly. It arrives as a `?share=` query
param and is handled in the same boot block as the `?b=` pack links: import,
then strip the param. iOS has no share target; the button is the path there.

Failure modes, each a toast: no signal, endpoint rate limit, a link that is
not a directions link, a route Google cannot build, the key not yet set.

## 3. The Google icon on the track tile

A second icon beside delete in `trackRow`, using the existing
`i-navigation` sprite, with its own `stopPropagation` handler like the pack
header buttons. Tapping it builds a directions URL and opens it.

Stop selection: the Maps URL takes an origin, a destination and at most 9
intermediate stops. Nav runs Douglas-Peucker over the track and searches the
tolerance until at most 9 interior points remain, so the stops sit where the
track bends most. Origin is the first point, destination the last; a loop
simply ends where it starts. Travel mode is driving.

The link opens through a synthetic anchor with a blank target and
`noopener`, clicked inside the tap handler so popup rules allow it. In
standalone mode on Android that hands off to the Maps app through app
links; on iOS it goes via Safari to the Maps universal link.

The two pure functions, stop picking and URL building, plus the link finder
the paste path uses, live in `apps/nav/gmaps-link.js`, loaded like
`corridor.js`, so they get real node tests. The tile rewrite also fixes the
unescaped track name in the row markup.

## 4. Testing and rollout

- Site: vitest on the URL parser (fixtures from the Rust tests), the
  polyline decoder (Google's documented example), the GPX writer (golden
  substrings), the host allow-list and the rate limiter. The Routes call is
  not exercised in CI; a live check is one curl against the deployed route.
- Nav: node tests on the new module — stop picking on a loop and an
  out-and-back, the 9-stop cap, exact URL output, link finding in shared
  text. Proof in a real browser via the dev server: a screenshot of the
  Tracks panel with the icon, and the generated href read from the tile.
- The service worker precache list gains `gmaps-link.js` and the cache name
  bumps.

**Out of scope, on purpose:** KML files, cycling travel mode, a preview of
what Google will do with the stops, a Google Earth hand-off.

**Cost:** Routes API compute is billed per call; the endpoint caps each IP at
a handful of calls per hour.

**Operator step:** add `GOOGLE_MAPS_API_KEY` (Routes API enabled, API
restriction set to Routes API only) to the Vercel project env and redeploy.
Until then the link import returns a 422 with that hint and nav shows it.
