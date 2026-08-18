# Nav holds many packs, one active — a pack switcher

*Design, 2026-08-18. Brainstormed and validated section-by-section with
Grant. Builds directly on `dingo-2026-08-04-shared-tiles-pack-v2-design.md`,
whose shared tile pool and per-pack reference sets make this cheap.*

## Why

Nav holds exactly one pack. Every pack import calls `purgeAllPacks()` and
deletes all the others (`apps/nav/index.html:5190`).

The ADV ride to Dorrigo breaks that. The event ships as three packs: two
transit tracks Sydney→Dorrigo, two Melbourne→Dorrigo, and the loops out of
Dorrigo. A Sydney rider needs **two** packs — the transit pack for days 1–2,
the event pack for the ride, and the transit pack again to get home. Around
800 riders will do this.

The switch happens at Dorrigo, at camp, where signal is not reliable. So a
switch must never touch the network.

## Decision summary

| Question | Decision |
|---|---|
| Shape | **Many packs held, one active.** Not a merged library — only the active pack's tracks are loaded and shown |
| Offline | **A switch is pure local I/O.** Every held pack keeps its tracks, heatmap and tiles resident. Prefetch happens at import, while online |
| Delete | **Full removal** — tracks, heatmap, tiles and the pack record. `removePack()` already does this correctly |
| Switching | **Manual, plus an offer.** Nav offers a switch when the rider is inside another held pack's bbox and away from the active one. It never switches by itself |
| Ride code | **Follows the pack, but asks.** One offer per pack, naming the group, with a plain hint that a rider who wants only their own mates should type their own code |
| Where | **A Packs section in ☰** — one card per pack with track count, size, ⟳, ✕ and "Use this pack", plus the device storage total |
| Prerequisite | **Fix the z8–11 bbox tier first.** It is worth more megabytes than this whole feature |

## What already works

Nav is most of the way there. These are already keyed by pack slug and need
no change:

| Part | Where |
|---|---|
| `S.packs` map (slug → record) | `index.html:1311` |
| `track.pack` tag on every track | `index.html:5250` |
| One heatmap per pack, swapped on track select | `swapHeatToPack`, `index.html:5608` |
| Per-pack tile reference sets, with GC of unreferenced tiles | `dropTileRefs`, `index.html:1552` |
| Track list grouped by pack | `refreshTrackList`, `index.html:5571` |
| Single-pack removal | `removePack`, `index.html:5310` |
| Re-download from the source link | `refreshPack`, `index.html:5321` |

Critically, the tile store is **one shared pool** keyed `source/z/x/y`, not
`pack/z/x/y`. Packs that overlap share their tiles for free, and a pack
holds only a reference list.

## Measurements

Corridor maths run against `apps/nav/corridor.js` with synthetic routes
matching the real ADV geometry. Treat these as the right order of
magnitude, not exact figures.

| Pack | Basemap tiles | of which z8–11 | Hillshade tiles |
|---|---|---|---|
| Syd→Dorrigo (2 tracks) | 1902 | 417 | 866 |
| Mel→Dorrigo (2 tracks) | **6989** | **3424** | **4058** |
| Dorrigo event (4 loops) | 1666 | 73 | 499 |

A Sydney rider holding both packs:

- separate storage would need 4933 tiles
- the shared pool needs **4056** — an 18% saving, already implemented

At roughly 10–30 KB per tile that is about 40–120 MB. Fine on any phone.
**Real tile bytes should be measured against the live archive before the
storage copy quotes numbers to riders.**

## 0. Prerequisite — fix the z8–11 bbox tier

The Melbourne pack is four times the Sydney pack, and route length is not
the cause. The z8–11 tier caches the route bounding box padded 20 km
(`corridor.js:16`). Melbourne→Dorrigo is a long diagonal, so its box is
about 1300 × 800 km. Nav caches most of eastern Australia at z8–11, almost
none of it near the route.

**Fix:** at z8–11, also build a corridor set with a 25 km buffer, and keep
whichever of the two sets is smaller.

| Pack | Tiles now | With the fix | Change |
|---|---|---|---|
| Syd→Dorrigo | 2768 | 2348 | −15% |
| Mel→Dorrigo | 11047 | **5373** | **−51%** |
| Dorrigo event | 2165 | 2205 | +2% |

Take-the-smaller needs no threshold and no tuning. Both are cheap set
builds inside `corridorTiles`, they run before any network call, and the
result is always the better of the two. A compact pack keeps its bbox tier;
a transit pack gets the corridor.

This is its own branch and its own PR, ahead of everything else. It is pure
logic in a node-testable module with existing tests, so it lands with real
coverage and no UI risk.

## 1. Data model

Four fields on the pack record:

| Field | Why |
|---|---|
| `bbox` | `[minLon, minLat, maxLon, maxLat]` of the pack's tracks, written at import. Lets Nav test rider proximity without parsing GPX |
| `bytes` | Tile total, split by source. Written by `prefetchCorridor` |
| `trackCount` | The card says "4 tracks" without loading them |
| `lastUsed` | Sorts the list; picks the fallback if the active pack disappears |

Tile reference records gain a `sizes` array beside `keys`
(`index.html:1531`). Every size sum then comes from three small records per
pack — no scan of a tile store holding tens of thousands of blobs.

**The active pointer lives in its own `localStorage` key, not in `S.set`.**
The scheme switcher's reset wipes settings (`index.html:7736`), and which
pack you are riding must survive that.

**What "active" controls.** `S.tracks` holds the active pack's tracks plus
loose hand-loaded files. Other packs stay in IndexedDB, unparsed. RAM and
boot time stay flat no matter how many packs are held.

Four single-pack assumptions get repointed at the active pack:

1. `DTILES.override()` takes the active pack's tile source, not the first
   one it finds (`index.html:1427`)
2. Boot loads the active pack's heatmap, not the first in the store
   (`index.html:8256`)
3. `_packCfg` becomes one signature per slug (`index.html:5204`)
4. `purgeAllPacks()` on import is deleted. An import replaces only its own
   slug, which `addFile` already does by stable id

## 2. The Packs screen

A section in ☰ above Tracks. One card per pack, sorted by `lastUsed`. Name,
revision, track count, size. The active card carries the accent border and
an "Active" badge; the others carry "Use this pack".

**Size must be honest.** Tiles are shared, so "this pack uses 68 MB" is
false when 12 MB also belongs to another pack. The card shows the
actionable number — the tiles **only this pack references**:

```
Dorrigo event — 4 tracks · frees 41 MB
                +12 MB shared with Syd→Dorrigo
```

The maths is a set difference across the `tilerefs` records, which
`dropTileRefs` already loads together.

Under the list, one line of device truth from `navigator.storage.estimate()`:

```
109 MB used · 24 GB free · offline storage protected
```

**Delete** keeps `removePack(slug)` unchanged. Only the confirm text
changes, to name the size freed. Deleting the active pack activates the
next most recent, or none.

**Re-download** (⟳) keeps `refreshPack` unchanged.

The empty-screen re-download buttons (`index.html:6013`) stay — they serve a
different moment, a device with nothing on it.

The Tracks tab shows the active pack plus loose files. Its pack headers
stay, because loose files still need one, but ⟳ and ✕ leave the header for
the card.

## 3. Switching

`switchPack(slug)` runs five steps. None touch the network:

1. **Archive and stop, never clear.** `stopNav()` calls `archiveRide()`
   first (`index.html:3750`), so the ridden path reaches the own-rides
   archive before anything else. Clear the selection
2. Drop the old pack's tracks from `S.tracks`. Loose files stay
3. Read the new pack's GPX from IndexedDB and parse. Reuse the boot restore
   loop, including its yield to the paint loop (`index.html:8266`), so a big
   pack cannot freeze the screen
4. `swapHeatToPack(slug)` — already exists, already works
5. Redraw, write the pointer, set `lastUsed`

Tiles are untouched. They stay in IndexedDB and are read one at a time by
the `dtile://` handler as the map asks (`index.html:1447`). This is why the
switch is cheap and why it works with no signal.

### The breadcrumb survives

The trail is not pack-scoped and no pack code touches it:

- `stopNav()` does not clear `S.trail`
- the trail persists under its own `{id: 'trail'}` record
  (`index.html:4578`)
- `removePackData` deletes only that pack's tracks and heatmap, so neither a
  switch nor a delete can touch the breadcrumb
- ride archives are `ride-<timestamp>` records with no pack tag, and survive
  every pack operation including a full delete

The breadcrumb keeps drawing across the switch, over the new pack's tracks,
unbroken.

Known and correct: starting a track in the new pack gives a different
`trailKey`, so `startNav` begins a fresh breadcrumb (`index.html:3697`).
Arriving at Dorrigo ends the transit ride; the loop is a new one, and the
transit trail is already archived and already in the heat.

### The switch offer

Every 30 s, when Follow is **not** running and a position is known, test the
rider against each held pack's `bbox`. Inside another pack's box and more
than 5 km outside the active one → offer once:

> You are in **Dorrigo event**. Switch to it?

Follow being off is the whole guard. It matches the real moment — standing
at the event start with the transit pack still loaded — and makes a switch
under way impossible. The dialog is the off-track picker's card, which the
rider already knows (`index.html:5645`). "No" is remembered per pack.

### The ride-code offer

After a switch, when the new pack bakes a different ride name:

> Join the **Dorrigo 2026** group? Everyone on this pack shares it.
> To see only your own mates, type your own code in ☰ instead.

Once per pack. It never touches a code the rider typed themselves —
`codeAuto` already tracks that (`index.html:5417`).

## 4. Storage and eviction

Nav has none of this today. There is no `navigator.storage` call anywhere in
the file. This is what makes offline packs trustworthy.

**Persist.** On the first pack import, call `navigator.storage.persist()`.
Without it a browser may evict the whole origin under disk pressure, and the
rider finds out at camp with no signal. Nav is an installed PWA with a
manifest and a service worker, so Chrome usually grants without a prompt.
The Packs screen reports the state: *"offline storage protected"*, or
*"storage not protected — add Nav to your home screen"*.

**Before a prefetch**, compare `estimate()` free space against the
corridor's projected size. If it will not fit, say so before starting, and
name the pack that would free the most:

> Dorrigo event needs about 41 MB. You have 12 MB free.
> Removing *Kandos 2025* frees 78 MB.

**During a prefetch**, `QuotaExceededError` currently vanishes into a silent
`catch` (`index.html:1541`). Give it its own branch: stop, keep what landed
(the fetch is already resumable), and say what happened.

## 5. Edge cases and back-compat

**Existing devices.** A device holding one pack makes it active on first
boot after the update. Nothing is re-downloaded, nothing is lost — the
records, tracks, heatmaps and tile references are already in the right
shape. New fields fill lazily: `bbox` and `trackCount` on first activation,
`bytes` on the next prefetch. Until then the card shows "size unknown".

**v1 packs** embed their basemap into the single `basemap` IDB key, so two
of them would fight over it. Rare and shrinking, but it needs a guard: when
a v1 pack with an embedded basemap is held alongside another, the Packs
screen marks it *"carries its own map — only usable when active"*, and
activating it reloads the map source. No silent wrong basemap.

**Missing active pack** (deleted in another tab, interrupted delete): fall
back to the most recent `lastUsed`, or to none.

## 6. Testing

1. `tests/corridor.test.mjs` gains the tier-choice cases — a long transit
   picks the corridor, a compact pack keeps the bbox, neither loses a z12–14
   tile
2. New node tests for the pure parts: exclusive-versus-shared size maths
   from a set of `tilerefs` records, and the bbox proximity test behind the
   switch offer
3. A browser run through the dev server: load two packs, switch with the
   network disabled, prove the map still draws and the breadcrumb is
   unbroken. Screenshots as proof. Playwright from `tools/ui-sweep` — a
   hidden Browser pane freezes MapLibre

## 7. Order of work

Each is a separate PR, and each is useful on its own.

1. **The bbox tier fix** — pure logic, existing tests, biggest megabyte win
2. **`persist()` + storage reporting** — makes offline trustworthy, no
   multi-pack code needed
3. **The active pointer + the Packs screen** — the feature itself
4. **The two offers** — the switch offer and the ride-code offer

## Out of scope

**The friends layer will not hold 800 riders.** The ride code is set from
the pack name (`index.html:5417`), and each rider publishes their name and
position to a **public** ntfy.sh topic every 20 s. At 800 riders that is
about 2400 messages per minute on one public topic, and the names and
positions are readable by anyone who guesses the code. The ADV ride will
meet this. It needs its own design.
