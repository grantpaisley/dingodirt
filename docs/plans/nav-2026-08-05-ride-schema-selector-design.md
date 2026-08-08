# Ride schema selector — Studio preset pairs in the glove menu

2026-08-05. This is the DingoNav side of the scheme importer/switcher. Pack v2
(`pack.schemes`) anticipated it. The Dingo Studio design
(`Dingo/Docs/plans/2026-08-02-dingo-studio-design.md`) and the behaviour
framework (`DingoStudio/docs/2026-08-03-nav-behavior-framework.md`) specify
it.

## Entry

The ☰ glove grid's **Mark spot** tile is now **Schema** (a palette icon).
`markSpot()` stays — friend/pack `spot` sync still lands via the inbox. Only
the tile changed. The tile opens a full-screen selector with two sections:

- **Look — `.dingoscheme`**: Dingo default · Google Maps · Waze · Locus Map ·
  OziExplorer · DMD2
- **Behaviour — `.dingobehavior`**: Matched ⛓ (default) · Dingo default ·
  Google Maps · Waze · Locus · DMD2

A tap on a Look tile applies that scheme plus its same-id behaviour, while
Behaviour is on "Matched" (Studio's profile-pairing semantic). A Behaviour
tile pins that behaviour explicitly — the user can mix and match.
"Dingo default" for a facet means factory: no scheme mounted / no behaviour
overrides.

## Overwrite semantics

To apply a schema is **reset-then-apply**: `S.set` (this includes every `adv`
slider, the zoom presets, and the layout) returns to the factory defaults.
`factorySet()` is the one source of truth, extracted from the old `S.set`
literal. Then the preset's mappings land on top. The result is deterministic:
no merge, no confirm.

These items survive the reset (`SCHEMA_KEEP`): the identity (`name`, `email`,
the ride `code`, `codeAuto`), the controller `keys`, the Varg pairing,
`aerialUrl`, the one-time stamps (`seenIntro`, `seenZoomTip`), and the
migration flags (`_v2`–`_v5`, `_packCfg`).

## Preset files & appliers

`schemes/*.json` + `behaviors/*.json` are vendored from DingoStudio and
SW-precached (CACHE v67) — the selector works fully offline.

The scheme applier is the vendored canonical `applier-nav.js`, translated to
Nav's runtime names:

- basemap tokens → a dynamic `MAP_STYLES.scheme` entry. The base flavour
  picks `layers.json`/`layers-light.json`. The per-layer paint overrides
  splice into `buildStyle()`. The `__labels` sentinel patches every symbol
  layer. The hillshade paint comes from the tokens. The style cycle collapses
  to schema ↔ satellite while a schema is active; `isNightStyle()` reads the
  schema's base.
- overlay tokens → `adv` knobs (`colRoute`, `colOwn/Plan/Other`,
  `routeWOut/In`, `caseMode`, `colDone`, `chevSize/Gap`, breadcrumb→`colCrumb`)
- mark tokens → the `MARKS` colour table (the factory snapshot is in
  `MARKS_D`)
- hud tokens → the `--bg/--panel/--fg/--dim/--accent/--ok/--warn/--bad`
  (+ heat) CSS variables

The behaviour applier maps only the params with Nav homes today:
`followMode`→`orient`, `autoZoom`, `easeMs`,
`approachSecs/Mul/FloorM`→`apprS/Mul/Floor`,
`offroute.detectM/rejoinM`→`offM/onM`, `breadcrumb(SpacingM)`→`trail`/
`trailGap`, `voice.mode: silent`→sound off, and the zoom curve's span ends →
the vehicle's zoom presets. It skips `reroute.*`, `pitch`, lane guidance, and
TTS, per the ignore-unknown contract.

## Persistence & failure

The applied ids + the validated JSON persist as one IDB record
(`id: 'schema'`). Boot re-mounts the look (the CSS vars, the mark colours,
the style entry) before the first `buildStyle()` — thus there is no
default-style flash. The settings half already lives in `S.set`. The contract
handling: `schemaVersion` major ≠ 1 rejects at apply. A stored schema that
fails to mount at boot unmounts, falls back to the factory look, and says so.
Thus a bad schema never bricks Nav. Day tokens only for now (`night` overlays
resolve when Nav grows a day/night schema mode).
