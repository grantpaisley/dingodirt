# Shared UI library (`core/ui/`) — stage-3 design

Date: 2026-08-09
Status: agreed. Implements stage 3 of `2026-08-09-ui-element-taxonomy.md` (the taxonomy and the eleven design-language rules).
Scope: the visual library and its adoption by all four apps. Behavior modules are out of scope (see "Out of scope").

## Decisions

1. **Sharing mechanism: extend the symlink pattern.** `core/ui/` joins `core/schemes`, `core/behaviors`, and `core/appliers` as a canonical copy. Nav and Studio symlink; `tools/assemble-app.sh` dereferences at deploy, and Nav's service-worker cache hash covers it. Plan and Site import by path. No npm package, no web components, no build step anywhere.
2. **Adoption order: planner first.** The planner page already wears ink and clay, so it is the smallest diff and it proves the Next.js import path. Then Plan, then Studio, then Nav last — the safety-critical app adopts a proven library.
3. **Visual only.** The sync store and the ride-follow module each wait for their first real consumer and their own short design doc.

## What lands in `core/ui/`

### `tokens.css`

Every colour and size from the design language, as CSS variables on `:root`, with a `[data-mode="light"]` override block:

- **Chrome palette (Rule 3):** ink surfaces `#141109` / `#1d1910` / `#272216`, line `#35301f`, bone text `#ece4d2` / dim `#a89d83`, clay `#d96f32` / hot `#f28c4b`. Light ("warm bone paper"): bone surfaces `#ece4d2` / raised `#f6f1e4`, line `#cfc4a9`, ink text `#141109` / dim `#6d6450`, same clay.
- **Status triads (Rule 11):** muted `--status-{ok,mid,bad}` = `#57a557` / `#c9a227` / `#8a4a42`; vivid `--alert-{ok,warn,bad}` = `#38d178` / `#ffb020` / `#ff4545`.
- **Sizing (Rule 6):** `--control-size: 40px` (glove mode sets `56px`); radius, gap, and hairline tokens.
- **Type (Rule 9):** `--font-chrome: 'Barlow', -apple-system, 'Segoe UI', Roboto, sans-serif`; the size scale.

### `chrome.css`

The skins as classes that read only tokens — no literal colours:

| Class | Rule | What it is |
|---|---|---|
| `.dd-stack`, `.dd-single` | 6 | Grouped map-control stack; loose single in the same skin |
| `.dd-pill`, `.dd-seg` | 7 | Toggle skin — active is bone fill, ink text |
| `.dd-row` | 8 | List row; `.is-selected` adds the 3 px clay edge bar + raised bg |
| `.dd-dialog` | 2 | Modal frame — title, body, buttons bottom-right |
| `.dd-sheet` | 2, 4 | List/picker frame; docks side when wider-than-tall, bottom otherwise; landscape width cap `min(320px, 40vw)`; bottom form has drag handle + half-open state |
| `.dd-readout` | 10 | Big number + dim unit, tabular numerals, mode-aware halo |

The orientation docking (Rule 4) is pure CSS (`@media (orientation: ...)`); no JS in this library.

### `fonts/`

Barlow 400 and 500 as woff2 (~40 KB total) plus the `@font-face` block (`fonts.css`). Vendored so Nav works fully offline. Big Shoulders stays site-only.

## PR ladder

Each PR follows the standard workflow: branch, real-browser verification with proof, green CI, squash-merge with approval.

1. **PR 1 — create `core/ui/`.** Tokens, chrome, fonts, a `README.md` naming the rules each class implements. No consumers; zero risk. Verification: a static demo page in `core/ui/demo.html` showing every class in both modes (also serves as the living style sheet).
2. **PR 2 — planner adopts.** The `/p/` page reads `tokens.css` and swaps its inline hexes for variables; vote chips move to `--status-*`; the name dialog becomes `.dd-dialog`; the basemap switcher becomes `.dd-seg`. Proves the Next.js import path.
3. **PR 3 — Plan adopts.** `App.css` navy palette retires in favour of the tokens; MapToolbar becomes `.dd-stack`; filter pills become `.dd-pill`; the places tree rows become `.dd-row`; Import/Export/Settings become `.dd-dialog`/`.dd-sheet`.
4. **PR 4 — Studio adopts.** Slate chrome moves to tokens; segs become `.dd-seg`; the test-drive bar controls take `--control-size`.
5. **PR 5 — Nav adopts (last, most careful).** Glove mode becomes the one-token flip (`--control-size: 56px`); the ~13 overlay groups adopt the two frames; HUD and banner move to `.dd-readout` and the alert tokens; slate palette retires. Split further if the diff grows — Nav's follow loop must never destabilise.

## Out of scope

- **Sync store** (selection, filters, the Rule 1 restore) — waits for a second React consumer beyond Plan; own design doc.
- **Ride-follow module** (one state machine, GPS and playback sources) — waits for the Nav/Studio unification; own design doc.
- Rewriting any app's layout or features. Adoption PRs restyle; they do not restructure.
