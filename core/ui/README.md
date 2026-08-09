# core/ui — the shared visual library

The Dingo design language as CSS. One canonical copy; apps consume it the
same way they consume `core/schemes`: Nav and Studio symlink, deploys run
`tools/assemble-app.sh` to dereference, Plan and the site import by path.
Design: `docs/plans/2026-08-09-ui-shared-library-design.md`. Language:
`docs/plans/2026-08-09-ui-element-taxonomy.md` (the eleven rules).

## Files

- `tokens.css` — every colour and size as variables. Dark ("ink") default;
  `<html data-mode="light">` flips to warm bone paper; `<html data-glove>`
  grows `--dd-control-size` from 40 to 56 px.
- `chrome.css` — the skins. Classes read tokens only.
- `fonts.css` + `fonts/` — Barlow 400/500, latin woff2, vendored offline.
- `demo.html` — the living style sheet. Open it in a browser; toggle mode
  and glove. Serve the repo root (the page reaches `../..`-free relative
  paths) with any static server.

## Class ↔ rule map

| Class | Rule | Element |
|---|---|---|
| `.dd-stack` / `.dd-single` | 6 | Grouped map-control stack; loose single |
| `.dd-pill` / `.dd-seg` | 7 | Toggle skin (active = bone fill) |
| `.dd-row` (+ `.is-selected`) | 8 | List row; 3 px clay edge bar |
| `.dd-dialog` (+ `.dd-primary`) | 2, 5 | Modal frame; one clay action |
| `.dd-sheet` (+ `.is-half`) | 2, 4 | Picker frame; orientation docking |
| `.dd-readout` | 10 | Big number, mode-aware halo |
| `.dd-chip` / `.dd-alert` | 11 | Muted status / vivid alert |

## Conventions

- Prefix `dd-`, states as `.is-*`, no literal colours outside `tokens.css`.
- Clay appears in exactly two places (Rule 5): `.dd-row.is-selected` and
  `.dd-dialog .dd-primary`. Do not add a third without amending the rules.
- Alerts (`.dd-alert`) must be paired with sound or vibration by the app —
  colour alone is not an alert (Rule 11).
