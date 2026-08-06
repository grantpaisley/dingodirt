# Collect → Plan → Share roadmap

*Brainstormed with Grant 2026-07-12 before he went offline; decisions below are
locked, execution is autonomous, in order A→G. Each feature: worktree branch →
verify → PR → merge when CI green (Grant pre-authorized "do it all").*

Grant's goals: **collect GPX files** (his own + external sources), **plan
trips**, **share with friends who ride with DingoNav**.

## Locked decisions

- **Share links**: secret GitHub gist via the local logged-in `gh` CLI. Raw
  gist URLs are unguessable, CORS-friendly, deletable. Link format:
  `https://grantpaisley.github.io/DingoNav/?bundle=<gist-raw-url>`.
- **Privacy (Grant, re-scoped 2026-07-12 after the audit)**: the goal is to
  hide the HOME ADDRESS, not the suburb — "Arcadia" in names is fine, and
  starting/finishing in Arcadia is fine. So a privacy zone is a small circle
  around home (`dingo privacy add-home`, default 300 m, auto-detected from the
  start/end cluster). Any exported point inside a zone is removed (universal,
  no start/end gate — the circle is tiny so through-rides are naturally
  untouched); a home-anchored ride exports starting/ending ~300 m from the
  door. Names are NOT scrubbed. Applies to the EXPORT paths only (offline / bundle / DingoNav /
  share) via the dialog's "Hide privacy zones" checkbox (default on) or the
  CLI --no-privacy flag; the Dingo app AND the organized library on disk stay
  complete.
- **Strava sync**: build ready-to-auth. Grant later: create a Strava API app
  (settings → API), put STRAVA_CLIENT_ID/SECRET in .env, run
  `dingo strava auth` once.
- **dingodirt.com**: registered; DNS later by Grant. Prepare docs only — do
  NOT commit a CNAME to DingoNav yet (a custom domain without DNS breaks the
  live github.io URL). Recommend `nav.dingodirt.com` subdomain (GitHub Pages
  can't serve under a path like /nav) + a Cloudflare redirect rule from
  dingodirt.com/nav.

## A. Route drawer v1 (plan trips — the missing piece)

Toolbar pencil button → draw mode (overlay like the lasso): click adds a
vertex, drag moves one, Backspace removes last, Enter/double-click finishes,
Esc cancels; live running distance readout. Finish → dialog: name + mode →
`POST /api/rides/plan {name, mode, coords}`. Daemon: writes a GPX `<rte>` to a
temp file, reuses `dingo_ingest::ingest_file` (content-addressed, parsed,
track_type='route'), runs geo clean for that ride, applies the user name
(name_source user), best-effort gazetteer localities. The new plan then flows
through the EXISTING pipeline untouched: list/map (blue plan class), basket,
exports, DingoNav bundle + cue engine. Elevation preview deferred to v2.

## B. Privacy zones

Migration `privacy_zones (id, name, boundary geometry(MultiPolygon,4326))`.
Seed: Arcadia NSW polygon fetched once from Nominatim
(`polygon_geojson=1&q=Arcadia,+NSW`) via new `dingo privacy add-place` command
(re-usable for more zones); `dingo privacy list|remove` to manage. In
`dingo_export`: both point sources (`ride_points`, `build_ride_gpx`) apply
`ST_Difference(geom, (SELECT ST_Union(boundary) FROM privacy_zones))` before
dumping; `(dp).path[1]` becomes the trkseg index so gaps render as real GPX
segment breaks. Zones cached per-call. `--no-privacy` plumbs a bool through
BundleOptions/export fns. Manifest gains `privacy_trimmed` count.

## C. Share-by-link + DingoNav ?bundle=

Daemon `POST /api/export/share {ride_ids, name}` → builds the privacy-trimmed
`.dingonav.json` (existing dingonav builder from PR #15) in a scratch dir →
`gh gist create --secret <file>` (std::process; requires gh CLI logged in —
runtime-checked with a clear error) → parses gist id → raw URL →
returns `{share_url, gist_url}` where share_url is the DingoNav Pages URL with
`?bundle=`. ExportDialog: "Share link" appears as a destination option
(DingoNav bundle section); result view shows the link + copy button + "anyone
with the link can view — gists are deletable at gist.github.com".
DingoNav repo (separate, ~/Desktop/Projects/DingoNav, deploys from main):
on boot, if `?bundle=` param → fetch URL → route through existing addFile JSON
logic → history.replaceState to strip the param; error toast on failure.

## D. Source tagging + web import

Migration `rides.source text` (free text: wikiloc, dsra, dmd-hub, strava,
mate names). `organize`: files under `Inbox/<source>/…` get that first-level
folder name as source (zones like Recorded/ excluded as today).
`ingest_file`/service signature gains `source: Option<&str>`. Exposed in list
+ detail APIs, searchable (server `q` haystack + client rideMatchesSearch).
Web: Import button (list header) → dialog: drag-drop/browse multi-GPX, source
text field, origin self/other radio → `POST /api/import` (axum multipart
feature) → per-file results shown. Uploaded files go through ingest_file via
temp dir (content-addressed like everything else).

## E. Strava auto-sync (ready-to-auth)

CLI `dingo strava auth`: reads STRAVA_CLIENT_ID/SECRET (env/.env), opens/prints
the authorize URL (scope activity:read_all, redirect http://localhost:8723),
tiny blocking listener captures the code, exchanges for tokens, saves refresh
token to `~/.config/dingo/strava.json` (0600). `dingo strava sync`: refreshes
access token, lists athlete activities `after` the latest rides.started_at in
the DB (paged), fetches per-activity streams (latlng, time, altitude,
heartrate), builds GPX (gpxtpx HR), ingests directly with source='strava'
(skip-if-duplicate comes free from content hashing... NOTE: stream-built GPX
won't byte-match a Garmin original — dedupe-rides handles that, mention in
output). Unit test: fixture streams JSON → GPX golden assertions.
Docs: Docs/strava-sync.md with Grant's 3 steps.

## F. Snap-to-heatmap drawing + grades

Drawer v2 snapping: candidate = nearest vertex across visible rides within
~12 px (screen-space); when consecutive drawn vertices snap to the SAME ride,
splice that ride's intermediate vertices between them (follow-my-track).
Toggle in the draw UI (magnet icon, default on). Grades: migration
`rides.grade smallint` (1–5, Grant's published scale); PATCH /rides/{id}
extended to `{grade}`; detail pane selector + "set grade for all N selected";
grade chips filter (1–5 + ungraded) in the Track types pane; grade added to
RideSummary/meta/search haystack. Export coloring by grade deferred.

## G. dingodirt.com runbook

Docs/deploy-dingodirt.md extended: exact DNS records for nav.dingodirt.com
(CNAME → grantpaisley.github.io), GitHub Pages custom-domain steps + HTTPS
cert wait, Cloudflare redirect rule for /nav, plan.dingodirt.com (Vercel)
records, and the api.dingodirt.com daemon options from the earlier doc.

## Deferred / out of scope this run

- Route drawer elevation preview; road-network routing (BRouter/Valhalla)
- Export coloring by grade; auto-grade suggestions
- dingodirt.com hosting itself (needs Grant: DNS, VPS, vercel login)
- Strava OAuth completion (needs Grant's API app + one click)

## Ops notes for this run

- Another session works in the SHARED checkout on local main (harvest/Strava
  heat). All work here stays in the map-layers worktree; never switch branches
  in the shared checkout. Fetch + branch from origin/main per feature.
- Worktree servers: daemon :3001 (DINGO_BIND), vite :5175 (VITE_API_URL).
  Real-Chrome verification via claude-in-chrome; CDP screenshots force frames.
- Migrations: merge same-session (sqlx migrate! has no ignore_missing).
