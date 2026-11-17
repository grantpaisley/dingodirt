# Nav pack picker — as built

*2026-11-17. Builds step 3 of `2026-08-18-nav-multiple-packs-design.md`
("the active pointer + the Packs screen"). The screen itself follows the
mockups Grant approved on 2026-11-17, which replace section 2 of that design.
Steps 1, 2 and 4 of that design are not in this change.*

## What changed

| Area | Before | Now |
|---|---|---|
| ☰ menu | A tile that cycled the base map style (Day / Trail / Dark / Sat) | A **Packs** tile. It shows the name of the ride pack and opens the pack list |
| Packs on the phone | One. Each download deleted all other packs | Many held, one ridden. A download replaces only its own earlier copy |
| Aerial | One stop of the style cycle tile | A tile in the **Look** row of the schema screen |
| Base style | ☰ tile, or Settings | Settings only (the *Map layers* row above the tabs). The controller key that cycles styles is unchanged |

## The pack list

- One row for each pack: name, version, track count, total size. The ride
  pack is first and has the accent border; the others follow by last use.
- A tap on a row makes that pack the ride pack.
- **Details** switch (off by default, remembered): shows the size of each
  part in the order Map, Aerial, Tracks, Shading. A part with no value is
  blank.
- **Pen** button (off each time the list opens): shows a bin on each row.
  The bin asks for confirmation and names the size that the removal frees.
- A pack that has only a download link (after *Clear all data*, or a first
  download that failed) shows "Not on this phone · tap to download".

## Sizes

Corridor tiles are one shared pool, so three numbers exist and each has its
own place:

| Number | Where | Meaning |
|---|---|---|
| Pack total and part sizes | The row | All the tiles that the pack references, shared ones included |
| "N packs · X MB used" | The summary line | Each tile counted once — the true size on disk |
| "This frees X" | The bin confirmation | Tiles that only this pack references, plus its tracks |

Measured on the dev server with three small test packs in three states:
each row read about 30 MB, the summary read 35 MB, and each removal freed
2 to 3 MB. Almost all of the shading is the low-zoom tier, which all packs
share. This is the z8–11 problem that step 1 of the August design fixes.

Sizes come from one cursor pass over the tile store when the list opens,
cached until tiles change. The August design proposed a `sizes` array on
the tile reference records to avoid that pass; it is not built.

## Data model

| Item | Where | Why |
|---|---|---|
| Ride pack pointer | `localStorage` key `dingonav-active-pack` | Not in `S.set`: a schema change resets `S.set` and a config import replaces it |
| `trackIds` | Pack record | IDB keys of the pack's tracks. Boot skips them for a pack that is not ridden; a removal deletes them without loading the pack |
| `tracksBytes`, `heatBytes` | Pack record | Text sizes for the Tracks part |
| `lastUsed` | Pack record | Order of the list, and the fallback when the ride pack is removed |
| Track record key | `pk-<slug>\|<track id>` | Two packs can carry the same ride. One shared record was lost when either pack was removed. The track id (`tid`) is unchanged, so cue edits re-attach |
| `_packCfg` | `S.set`, now one signature per pack | One slot made each refresh of pack A offer its config again after pack B loaded |

Boot reads the pack records first, then only the ride pack and loose
files. A store from before this change holds one pack: boot adopts it as
the ride pack and writes its track list. Nothing downloads again.

## Differences from the August design

| August design | As built | Reason |
|---|---|---|
| Switch in place, five steps | Switch by a page reload | The local-metre projection is anchored once, at the first track (`setRef`). A pack some hundreds of km away would get the wrong east-west scale. Boot anchors it again, and also attaches the correct basemap for a pack that carries its own. The switch is still local I/O only: it needs no network, and the breadcrumb has its own record |
| A switch stops the ride | The same, after a confirmation | The row is glove-sized; a tap must not end a ride by accident |
| Cards with ⟳, ✕ and "Use this pack" | Rows; tap to use; bins behind the pen; no ⟳ | The 2026-11-17 mockups. ⟳ and ✕ stay on the pack header in the Tracks tab |
| Row shows "frees X / +Y shared" | Row shows the total; "frees" is in the confirmation | The 2026-11-17 mockups |
| `bbox`, `bytes` on the pack record | Not added | `bbox` is for the switch offer (step 4). Sizes are measured live |

## Packs that carry their own map

A `.dingonav` zip can embed a basemap, shading, satellite or Strava tiles.
Each of these has one slot on the device, so the last zip that shipped one
owns the slot. Each is tagged with its pack. Map start ignores the embedded
assets of a pack that is not the ride pack, and they go when their pack is
removed. A pack that lost its slot to a later zip falls back to the shared
archive. The "carries its own map" label from the August design is not
built.

## Not in this change

1. The z8–11 tile tier fix (August design, step 1).
2. `navigator.storage.persist()` and the storage report (step 2).
3. The switch offer and the ride-code offer (step 4).

## Tests

- `tools/ui-sweep/nav.spec.mjs` measures the pack list with Details and the
  bins on, for the factory look and each scheme. The factory daylight case
  now changes the base style through Settings, because the ☰ tile is gone.
- Browser run on the dev server: three packs loaded together; switch;
  refresh of one pack with its tiles kept; removal of a pack that is not
  ridden (shared tiles stay); removal of the ride pack (the most recent
  other pack takes over); a store in the old one-pack shape adopted at boot.
