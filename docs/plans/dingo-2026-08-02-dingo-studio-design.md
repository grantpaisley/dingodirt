# Dingo Studio — community scheme editor, `.dingoscheme` packs, multi-view demo

*Design, 2026-08-02. Brainstormed and validated section-by-section.*

## Why

Three pains, one new opportunity:

- **Style drift** — the map look is defined twice: DingoNav's `basemap/layers.json`
  and Dingo Plan's `web/src/mapStyles.ts`. Two formats, two repos, diverging.
- **Tweaking is painful** — iterating on colours/widths means editing code and
  reloading apps.
- **App bloat** — Nav and Plan are accumulating config UI that doesn't belong in
  the ride/plan workflows. Nav's demo mode is an occasional-use tool living
  inside a ride-critical app.
- **Community** — members should be able to design complete look-and-feel
  "schemes" and share them for other members to ride with.

## Decision summary

| Question | Decision |
|---|---|
| App structure | One new companion app, **Dingo Studio** (Option A) — not two apps, not a Plan route |
| Scheme depth | **Design tokens only** — never raw MapLibre style JSON |
| Distribution | `.dingoscheme` zips in **dingo-shares** (`schemes/`), same rails as `.dingonav` |
| Packs vs schemes | Separate pack types; a `.dingonav` may **reference** a scheme by URL |
| Reference precedence | **Offer once** per pack; a manual scheme choice is never silently replaced |
| URL install | `?scheme=<url>[,<url>…]` works on Nav, Plan, and Studio |
| Editor preview | Both **Nav mode** and **Plan mode** framing |
| Demo mode | Removed from Nav; one replay engine in Studio serves editor test-drive **and** public showcase |
| Multi-view demo | Simultaneous viewports (portrait / landscape / square / custom), **per-view schemes** for A/B |
| Community saves | Upload endpoint on dingodirt → commits to dingo-shares (details in the separate website spec) |

## Architecture

```
Dingo (Rust + PostGIS)   source of truth, unchanged
Dingo Plan (web/)        + scheme importer, + token applier, themed by scheme
DingoNav                 + scheme importer, + token applier, − demo mode
Dingo Studio  [NEW repo] scheme editor + replay engine (test-drive & #demo)
dingodirt website [NEW]  community gallery + upload endpoint — SEPARATE SPEC (below)
dingo-shares             + schemes/ folder, + index.json build Action
```

Studio is a static PWA in the DingoNav mould: MapLibre GL + PMTiles, vendored
libraries, no backend, `serve.js` for local hosting. End-state URL:
`studio.dingodirt.com` (GitHub Pages, same pattern as `nav.`).

Data flow:
`Studio (edit + test-drive) → .dingoscheme → dingo-shares → Nav / Plan (import + apply)`

Studio has two faces from one deployment:

- `studio/` — the editor (community members; no auth in v1, static app)
- `studio/#demo` — public showcase: auto-plays a bundled sample ride with the
  default scheme, no editing UI. Replaces Nav's demo mode as the "show a mate
  what DingoNav does" link.

## The `.dingoscheme` pack

A zip (same convention as `.dingonav`) containing:

- **`scheme.json`** — tokens + metadata: `name`, `author`, `version`,
  `schemaVersion`
- **`preview.png`** — auto-captured by Studio; shown in scheme pickers and the
  gallery

Token vocabulary, grouped as the editor presents them:

- **Basemap** — background, earth, landuse tints, road/trail casings by class,
  water, label colours/halo, hillshade tint & strength
- **Overlays** — heatmap colours per class (`own` / `plan` / `other`), line
  widths and opacity by zoom, selected-track colour, direction chevrons
- **Marks & alerts** — icon colours per mark type, off-track banner colour,
  approach-alert flash
- **HUD & chrome** — CSS variables: HUD background/text, arrow colour, button
  accent; Plan reuses the same variables for its app theme

**Compatibility rules** (community longevity):

- Apps **ignore unknown tokens** and **default missing tokens** — old schemes
  keep working as apps grow; new schemes degrade gracefully on old apps.
- A scheme is never executable style JSON — values only. Apps apply tokens to
  their own base styles.
- `schemaVersion` major mismatch → rejected at import with a plain message.

**Pack reference:** `bundle.json` in a `.dingonav` gains one optional field:

```json
"scheme": { "name": "Night Rider", "url": "https://…/night-rider.dingoscheme" }
```

Nav shows a one-time prompt ("This pack suggests 'Night Rider' — apply?");
the answer is remembered per pack.

**URL install:** `?scheme=<url>` fetches, stores in IndexedDB, and applies
(Nav/Plan) or opens for editing (Studio — this is also the remix flow).
Comma-separated URLs install several; one is active at a time.

## Studio: the editor

One screen, three zones:

- **Left panel — token controls**, grouped as above. Colour pickers, sliders,
  visibility toggles. Header: scheme name/author + New / Duplicate / Import /
  Export. Duplicating an existing scheme is the expected starting point.
- **Centre — live preview.** Real MapLibre map on the area basemap + hillshade
  with bundled sample heatmap/tracks (or any imported `.dingonav`). Every edit
  applies instantly. A toggle switches framing:
  - *Nav mode* — Nav's chrome: HUD arrow + distance, off-track banner, buttons
  - *Plan mode* — Plan's framing: side panel skeleton, layer chips, app theme
  The preview runs each app's real token applier + base style (vendored copies
  — see Integration).
- **Bottom bar — test-drive.** ▶ replays the sample track at speed through the
  scheme: auto-zoom, alerts, HUD updates. Colours that look good static often
  fail at 30 km/h.

**Export** writes the `.dingoscheme` zip, auto-capturing `preview.png`.
**Publish to dingodirt** uploads it to the community (website spec). Manual
fallback: commit to `dingo-shares/schemes/` by hand.

## Replay engine & multi-view demo

**One replay engine, N map instances.** The engine is pure logic (track in →
ticks out): position, speed, bearing, upcoming alerts, broadcast to every
registered viewport. Each viewport is a full independent Nav render — own
MapLibre instance, own auto-zoom (landscape frames differently than portrait,
which is the point), own HUD scaled to its frame.

- Viewport chips: **portrait (9:19.5) / landscape / square (watch or GPS
  unit) / + add view**; views removable.
- **Per-view scheme dropdown**, defaulting to the scheme being edited — the
  demo doubles as an A/B comparison rig (remix vs original, in motion).
- Playback bar: play/pause, scrubber, speed multiplier.
- The same component powers the editor's single-view test-drive and the public
  `#demo` page (defaults to one portrait view; more can be added).

## Nav and Plan integration

**Token applier** — the one deliberately shared piece. Each app keeps its own
base style (Nav's `layers.json` lineage, Plan's `mapStyles.ts`); the mapping
`applyScheme(tokens, baseStyle) → styled map + CSS variables` lives in one
small file per app. Studio **vendors copies** of both appliers and base styles
(same convention as vendored `maplibre-gl.js`); a `sync-appliers.sh` script
copies them in. Appliers are small and change rarely; Studio preview breakage
is visible and low-stakes, unlike Nav breaking on a ride.

**Nav:** ☰ → *Load scheme…* (file or URL) + scheme list with previews. Active
scheme persists in IndexedDB, applied at startup before the map mounts (no
default-style flash). `?scheme=` and the pack-reference prompt funnel into the
same importer. **Demo mode deleted** — menu item, replay code, the lot —
replaced by a link to `studio/#demo`.

> **Adopted 2026-08-05** (DingoNav PR #53): Nav shipped the switcher as a
> ☰ glove-menu **Schema** tile — a full-screen selector of the Studio preset
> pairs (look `.dingoscheme` + behaviour `.dingobehavior`, "matched" pairing),
> vendored in-repo and SW-precached rather than URL-installed. Applying is
> reset-then-apply (factory defaults + preset = deterministic overwrite;
> identity/pairing keys survive); the active schema persists in IDB and
> re-mounts before the first `buildStyle()`. Day tokens only for now. Still
> open from this spec: `?scheme=` URL install, file import, preview cards,
> pack-reference prompt wiring, night overlays, and the demo-mode deletion.

**Plan:** same importer in settings; tokens drive map + app theme via the
shared CSS variables.

**Failure handling:** invalid scheme (bad JSON, size, major version) →
rejected at import, never stored. If applying a stored scheme throws at
startup → fall back to built-in defaults and flag the scheme in the picker.
A bad scheme must never brick Nav mid-ride.

## dingodirt website (community) — separate spec

The community site is its own component and gets its **own design spec**
(planned as a separate session). This design only fixes the contract Studio
and the apps depend on:

- **Gallery** at `dingodirt.com/schemes`: preview cards (from `preview.png`,
  name/author via `schemes/index.json`), three actions per card — *Ride it*
  (`nav.dingodirt.com/?scheme=…`), *Plan with it*, *Remix in Studio*.
- **Upload endpoint** (serverless on dingodirt): accepts `.dingoscheme` +
  shared member passphrase, validates (schema, size cap, name collision →
  version bump), commits to `dingo-shares/schemes/`. GitHub stays the store:
  free hosting, version history, moderation = `git revert`.
- **Index build**: a GitHub Action in dingo-shares regenerates
  `schemes/index.json` (+ preview extraction) on every scheme commit.

Open questions deferred to that spec: membership model beyond a shared
passphrase, ratings/comments, scheme discovery/curation, how the site relates
to the planned `plan.`/`api.` deployments.

## Testing

1. **Applier contract** (the design's one real drift risk): a fixture scheme +
   snapshot of each app's resolved style, run in the app repo **and** against
   Studio's vendored copy. Divergence fails CI.
2. **Schema validation**: unknown tokens ignored, missing tokens defaulted,
   malformed/major-version-mismatch rejected.
3. **Replay engine**: pure logic, tested headless (track in → expected ticks).

## Rollout order (each step useful alone)

1. `scheme.json` schema + both token appliers — Nav/Plan ship *Load scheme…*
   before Studio exists
2. Studio editor + single-view test-drive (replay engine ported from Nav's
   demo code)
3. Delete demo mode from Nav; `studio/#demo` live
4. Multi-view demo + per-view schemes
5. dingodirt gallery + upload endpoint (per the separate website spec)

## Deferred (YAGNI'd out of v1)

- Auth for the Studio editor (static app; passphrase only gates *publishing*)
- Raw MapLibre style sections in schemes (tokens only; revisit if creators
  hit the ceiling)
- Alert distances / beep tuning as scheme sections — behaviour config, not
  look & feel; could become a second pack type later
- Schemes embedded inside `.dingonav` packs (reference-by-URL chosen instead)
