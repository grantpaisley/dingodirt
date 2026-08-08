# Collect → Plan → Share roadmap

*We brainstormed this with Grant on 2026-07-12 before he went offline. The
decisions below are locked. Execution is autonomous, in the order A→G. Each
feature follows this path: worktree branch → verify → PR → merge when CI is
green (Grant pre-authorized "do it all").*

Grant's goals: **collect GPX files** (his own plus external sources), **plan
trips**, and **share with friends who ride with DingoNav**.

## Locked decisions

- **Share links**: a secret GitHub gist, made through the local logged-in
  `gh` CLI. Raw gist URLs are unguessable, CORS-friendly, and deletable.
  Link format:
  `https://grantpaisley.github.io/DingoNav/?bundle=<gist-raw-url>`.
- **Privacy (Grant, re-scoped 2026-07-12 after the audit)**: the goal is to
  hide the HOME ADDRESS, not the suburb. "Arcadia" in names is fine. A start
  or a finish in Arcadia is fine. A privacy zone is thus a small circle
  around the home (`dingo privacy add-home`, default 300 m, auto-detected
  from the start/end cluster). The export removes each point inside a zone.
  This rule is universal, with no start/end gate — the circle is tiny, so
  through-rides are naturally untouched. A home-anchored ride exports with a
  start and an end ~300 m from the door. Names are NOT scrubbed. The zones
  apply to the EXPORT paths only (offline / bundle / DingoNav / share). The
  "Hide privacy zones" checkbox in the dialog (default on) or the CLI
  --no-privacy flag controls this. The Dingo app AND the organized library
  on disk stay complete.
- **Strava sync**: build it ready-to-auth. Later, Grant creates a Strava API
  app (settings → API). He puts STRAVA_CLIENT_ID/SECRET in .env. He runs
  `dingo strava auth` one time.
- **dingodirt.com**: registered. Grant does the DNS later. Prepare docs only
  — do NOT commit a CNAME to DingoNav yet (a custom domain without DNS
  breaks the live github.io URL). We recommend the `nav.dingodirt.com`
  subdomain (GitHub Pages cannot serve under a path like /nav) plus a
  Cloudflare redirect rule from dingodirt.com/nav.

## A. Route drawer v1 (plan trips — the missing piece)

The toolbar pencil button starts the draw mode (an overlay like the lasso).
A click adds a vertex. A drag moves one vertex. Backspace removes the last
vertex. Enter or a double-click finishes. Esc cancels. A live readout shows
the running distance. On finish, a dialog asks for the name and the mode,
then calls `POST /api/rides/plan {name, mode, coords}`. The daemon writes a
GPX `<rte>` to a temp file. It reuses `dingo_ingest::ingest_file`
(content-addressed, parsed, track_type='route'). It runs geo clean for that
ride. It applies the user name (name_source user) and best-effort gazetteer
localities. The new plan then flows through the EXISTING pipeline untouched:
list/map (blue plan class), basket, exports, DingoNav bundle + cue engine.
The elevation preview moves to v2.

## B. Privacy zones

Migration `privacy_zones (id, name, boundary geometry(MultiPolygon,4326))`.
Seed: the Arcadia NSW polygon, fetched one time from Nominatim
(`polygon_geojson=1&q=Arcadia,+NSW`) through the new
`dingo privacy add-place` command (re-usable for more zones).
`dingo privacy list|remove` manages the zones. In `dingo_export`: both point
sources (`ride_points`, `build_ride_gpx`) apply
`ST_Difference(geom, (SELECT ST_Union(boundary) FROM privacy_zones))` before
they dump the points. `(dp).path[1]` becomes the trkseg index, so gaps
render as real GPX segment breaks. The export caches the zones per call.
`--no-privacy` plumbs a bool through BundleOptions and the export fns. The
manifest gains a `privacy_trimmed` count.

## C. Share-by-link + DingoNav ?bundle=

The daemon endpoint `POST /api/export/share {ride_ids, name}` builds the
privacy-trimmed `.dingonav.json` (the existing dingonav builder from PR #15)
in a scratch dir. It then runs `gh gist create --secret <file>`
(std::process; this needs a logged-in gh CLI — a runtime check gives a clear
error). It parses the gist id, takes the raw URL, and returns
`{share_url, gist_url}`. share_url is the DingoNav Pages URL with
`?bundle=`. ExportDialog: "Share link" appears as a destination option
(DingoNav bundle section). The result view shows the link, a copy button,
and "anyone with the link can view — gists are deletable at
gist.github.com". The DingoNav repo (separate, ~/Desktop/Projects/DingoNav,
deploys from main): on boot, if the `?bundle=` param exists, fetch the URL.
Route the data through the existing addFile JSON logic. Then
history.replaceState strips the param. An error toast shows on failure.

## D. Source tagging + web import

Migration `rides.source text` (free text: wikiloc, dsra, dmd-hub, strava,
mate names). `organize`: files under `Inbox/<source>/…` get that first-level
folder name as the source (zones like Recorded/ stay excluded as today).
The `ingest_file`/service signature gains `source: Option<&str>`. The list
and detail APIs expose the source, and it is searchable (server `q`
haystack + client rideMatchesSearch). Web: an Import button (list header)
opens a dialog with drag-drop/browse for multiple GPX files, a source text
field, and an origin self/other radio. The dialog calls `POST /api/import`
(axum multipart feature) and shows the per-file results. Uploaded files go
through ingest_file via a temp dir (content-addressed like everything else).

## E. Strava auto-sync (ready-to-auth)

The CLI command `dingo strava auth`: it reads STRAVA_CLIENT_ID/SECRET
(env/.env). It opens or prints the authorize URL (scope activity:read_all,
redirect http://localhost:8723). A tiny blocking listener captures the code.
The command exchanges the code for tokens. It saves the refresh token to
`~/.config/dingo/strava.json` (0600). `dingo strava sync`: it refreshes the
access token. It lists the athlete activities `after` the latest
rides.started_at in the DB (paged). It fetches the per-activity streams
(latlng, time, altitude, heartrate). It builds GPX (gpxtpx HR). It ingests
the GPX directly with source='strava'. Skip-if-duplicate comes free from
content hashing. NOTE: stream-built GPX will not byte-match a Garmin
original — dedupe-rides handles that; mention this in the output. Unit
test: fixture streams JSON → GPX golden assertions. Docs:
Docs/strava-sync.md with Grant's 3 steps.

## F. Snap-to-heatmap drawing + grades

Drawer v2 snapping: the candidate is the nearest vertex across the visible
rides within ~12 px (screen-space). When consecutive drawn vertices snap to
the SAME ride, splice the intermediate vertices of that ride between them
(follow-my-track). A toggle sits in the draw UI (magnet icon, default on).
Grades: migration `rides.grade smallint` (1–5, Grant's published scale).
PATCH /rides/{id} extends to `{grade}`. The detail pane gets a selector and
"set grade for all N selected". Grade chips (1–5 + ungraded) filter in the
Track types pane. The grade goes into RideSummary, the meta, and the search
haystack. Export coloring by grade waits for later.

## G. dingodirt.com runbook

We extend Docs/deploy-dingodirt.md with: the exact DNS records for
nav.dingodirt.com (CNAME → grantpaisley.github.io), the GitHub Pages
custom-domain steps plus the HTTPS cert wait, the Cloudflare redirect rule
for /nav, the plan.dingodirt.com (Vercel) records, and the api.dingodirt.com
daemon options from the earlier doc.

## Deferred / out of scope this run

- The route drawer elevation preview; road-network routing (BRouter/Valhalla)
- Export coloring by grade; auto-grade suggestions
- dingodirt.com hosting itself (needs Grant: DNS, VPS, vercel login)
- Strava OAuth completion (needs Grant's API app + one click)

## Ops notes for this run

- Another session works in the SHARED checkout on local main (harvest/Strava
  heat). All work here stays in the map-layers worktree. Never switch
  branches in the shared checkout. Fetch and branch from origin/main per
  feature.
- Worktree servers: daemon :3001 (DINGO_BIND), vite :5175 (VITE_API_URL).
  Real-Chrome verification goes through claude-in-chrome. CDP screenshots
  force frames.
- Migrations: merge them in the same session (sqlx migrate! has no
  ignore_missing).
