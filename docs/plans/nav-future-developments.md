# Possible future developments

This is a running backlog of ideas that are **not** committed to the roadmap.
They are parked here, so the reasoning survives after we delete any
exploratory branches. Nothing here is scheduled. Each entry records the
decision and enough spec, so you can pick it up later.

## 3D view (tilted/perspective map)

**Decision (2026-07-13): out of the DingoNav navigation product.** A tilted
3D camera does not serve turn-by-turn riding. The nav UI is deliberately
flat 2D, north-up (or heading-up), so the cues, the route line, and the
countdown strip stay legible at a glance on the bars. The offline hillshade
relief under the trails already shows the terrain (see `make_hillshade.py`).
It gives ridge and gully readability without a tilted camera.

**Possible home: Dingo, later — as a "show off a track" flourish, not
navigation.** This is a one-off cinematic or preview mode for the review or
the share of a completed track. It is clearly separate from the riding view.

Sketch specs if picked up:

- **Where:** Dingo (the desktop/library app), not DingoNav. A "preview" /
  "flyover" action on a selected track. It never engages while you navigate.
- **Camera:** MapLibre pitch (~45–60°) + bearing. The DEM is already loaded
  as a `raster-dem` source, and it drives real `terrain` exaggeration (the
  hillshade extract is terrarium-encoded, so the same tiles feed
  `map.setTerrain({ source: 'dem' })`).
- **Motion:** an optional auto-flyover that follows the track polyline from
  start to finish (animate the camera along the line), or a free tilt/orbit
  for a static showcase.
- **Scope guard:** display and marketing only — no cue rendering, no live
  GPS, no auto-zoom. Keep it out of the nav code paths, so it cannot
  regress the riding UI.

**Status of the exploratory branch:** `claude/3d-view-navigation-aolaq8`
never contained any 3D work — its HEAD was the already-merged hillshade
commit. We deleted the branch on 2026-07-13; nothing was lost.

## Drag-to-rearrange control layout (editable button placement)

**Update (2026-07-15): picked up and implemented.** We brainstormed and
built the design — see `2026-07-15-editable-layout-design.md`. The scope
grew beyond this sketch: a wobble edit mode, a 5×6 slot grid with
launcher-style displacement, readout S/M/L sizing, separate
portrait/landscape layouts, and a dock tray → ☰ panel strip. Note the
reframe: it shipped as a **design tool for Grant** (reachable via Settings
→ General), not a rider-facing feature. The glove-ergonomics caveats below
apply to the *use* of the resulting layout, not to edit mode itself. The
original parked entry stays below for the reasoning.

**Decision (2026-07-14): parked as a possible enhancement, not scheduled.**
Phase 1 of the control-layout rework shipped (split left/right groups, a
floating START, a slim hamburger, free-ride, and a **Left-right /
Top-bottom** edges option in Settings → General). This entry is "Phase 2":
let the rider *drag* individual buttons around the screen, or dock them
into the hamburger menu panel, Android-launcher style, with the layout
persisted. We held it back, so Grant could first live with the fixed/preset
layout. If the shipped edge options already feel right on the bike, this
may never be necessary.

Sketch specs if picked up:

- **Explicit Edit mode, never ambient.** A dedicated Edit button (for
  example in the ☰ panel, or a long-press on the hamburger) toggles the
  edit state. Outside Edit mode, the buttons behave exactly as now — a
  plain tap fires instantly. Do **not** make the buttons
  press-and-hold-to-drag during riding. That adds tap-vs-drag latency,
  which fights the gloved, glance-and-go priority.
- **Each button lives on-screen or in the menu panel.** When you drag a
  button down onto the hamburger, the panel opens. Continue the drag to
  drop the button inside (docked = hidden from the map, reachable via ☰).
  Drag a button out of the panel to place it back on the map.
- **Persistence:** store the placement per button in `S.set`, saved via
  `saveSet()`. Store the edge/offset, or x/y as a fraction of the
  viewport, so the placement survives rotation and split-screen. One write
  on drop; nothing during riding.
- **Reset to default:** a one-tap "Reset layout", so you can easily undo a
  mis-drag.

**Performance note (why it is safe):** the hot path (per-GPS-fix,
per-map-frame) is untouched. The positions apply one time from the saved
state on load, via CSS/transform. They are never recomputed while you
navigate. The pointer-drag machinery binds only while Edit mode is active —
it is dormant otherwise. Hand-rolled pointer events, no library, a few KB
in the single-file app. If the rider never opens Edit mode, it is as if the
feature is not there.

**Also skipped in the same round (2026-07-14): a landscape/portrait lock
button.** The request was "clicking toggles landscape/portrait, default
landscape." We dropped it for now for two reasons. A web app cannot force
device rotation on iOS at all (Apple blocks `screen.orientation.lock`). On
Android, the lock only works for an installed PWA in fullscreen — so a true
lock is Android-only and unreliable. The CSS-rotate-the-whole-UI option is
a hack that fights the split-screen support added earlier. Revisit this
only if the app is wrapped natively, or if an Android-only best-effort lock
is judged worth it.

## "+" placeholder tiles in the ride-panel dock (spare slots)

**Requested 2026-07-15 while we built the editable layout, parked as an
enhancement.** The grid of the ride panel is now the dock (the fixed tiles
and the docked controls in one collection). Spare grid cells should render
a ghosted **+** tile. A tap on the tile opens a picker of actions that are
not currently on screen or docked (for example fit-track, the zoom presets,
future Varg toggles). The picker adds the chosen action as a tile. This
complements the editable-layout feature
(`2026-07-15-editable-layout-design.md`): today you can only dock what
already exists on screen — the + is how *new* controls would be born.

## Rider identity + usage telemetry synced to Dingo's database

**Requested 2026-07-20, deferred the same day.** The first-visit card
already captures the name and the email into `S.set`. The launches, the
cumulative visible time, and the last launch already accumulate locally
under the `dingonav-use` localStorage key. This key is deliberately *not*
in `S.set`, which is exported and imported for bench tuning — a shared
config must not carry or overwrite the counters of another rider. Nothing
is sent anywhere. To pick this up means to wire that local tally to Dingo,
and nothing else; the capture side is done.

Findings from the Dingo side, so the groundwork is not repeated:

- **The database exists and already models people.** Dingo runs PostGIS
  behind an axum daemon (`crates/daemon`), mounted at `/api`. The `owners`
  table (migration `20260712000001_owners.sql`) holds `kind`
  (me/friend/source/synthetic), a UNIQUE `email`, and `name` — the same
  identity that DingoNav captures. The two apps already share vocabulary
  via `shares.slug` ("pack key shared with DingoNav").
- **Do not widen `owners`.** That table is about the *provenance of track
  data* — who a ride belongs to. App telemetry is a different concern that
  happens to key on the same email. Also, a `owners_single_me` unique index
  already constrains the semantics of that table. Prefer a new `app_users`
  table keyed on the email, with `launches`, `total_ms`, and
  `last_used_at`. Either way, it needs a migration in the **Dingo** repo,
  not this one.
- **Local-first vs. a phone in the bush.** The daemon binds locally. Its
  CORS allowlist is the Vite dev origins plus an optional
  `DINGO_WEB_ORIGIN`. Every non-safe request needs the `x-dingo-web` CSRF
  header. A phone out of range cannot post at all. Thus the client side
  must queue locally and flush when back on the LAN — the same shape as the
  VargPilot arrangement, not a fire-and-forget POST on launch.

Open question if picked up: does usage telemetry belong in a
trail-knowledge database at all, or in something separate that only shares
the email as a key?
