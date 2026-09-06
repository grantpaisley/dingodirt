# build-tiles — the shared AU basemap archive

`basemap-au.pmtiles` is the one map every Dingo app draws: Nav, Plan, Studio
and the site all render it through the same layer files in `core/basemap/`.
It lives at `https://tiles.dingodirt.com/basemap-au.pmtiles`.

Until now it was cut straight out of the Protomaps daily planet build with
`pmtiles extract`. That costs no compute and it kept the schema honest, but
it gives no control over **which zoom a feature first appears at**. This
directory builds the archive locally from the same profile, with one patch.

## Why — town names out bush

The style was never the gate. `places_locality` in `core/basemap/layers.json`
carries a non-zero `text-size` at every zoom, so it draws a name the moment
the tiler ships the feature. The gate is the tiler's per-feature `min_zoom`.

Measured against the stock archive (`probe-places.mjs`, 2026-08-30):

| Town | Population | First zoom the feature exists |
|---|---|---|
| Port Augusta | ~13,000 | z6 |
| Quorn | ~1,200 | z7 |
| Hawker | ~250 | z7 |
| Blinman | ~22 | **z12** |

No style edit can beat that, and `applyDetailBias` cannot either — it shifts
zoom ramps, and there is no ramp to shift. Blinman is simply not in a z11
tile.

Out bush that is wrong. A hamlet IS the town, and it may hold the only fuel
for 200 km. So `places-min-zoom.patch` brings the **settlement** kinds
forward to z8 in the Protomaps places rules:

| kind_detail | upstream | here | |
|---|---|---|---|
| city | 7 | 7 | already early enough |
| town | 7 | 7 | already early enough |
| town, no population tag | 9 | **8** | |
| village | 10 | **8** | |
| hamlet | 11 | **8** | this is what Blinman is |
| locality (generic) | 11 | 11 | **not** a settlement — see below |
| locality, no population tag | 12 | 12 | |
| isolated_dwelling | 13 | 13 | |
| farm | 13 | 13 | |
| allotments | 13 | 13 | |

`place=locality` deliberately does not move. In OSM that tag means a named
place with **no population** — a parish name, an old siding, a bend in the
river. A first attempt moved it too, and the measurement killed the idea:
one z8 tile over the Flinders went from 2 places to 44, and **30 of the 44
were these**. They are not towns, and at z8 they would bury the ones that
are. `isolated_dwelling`, `farm` and `allotments` stay put for the same
reason.

This is why `probe-places.mjs` prints the z8 count *by kind* and not just a
total. A total going up is not evidence of anything.

## Result, measured 2026-09-06

Built from OSM 2026-09-05, 997 MB against the live archive's 0.95 GB.

| | live | this build |
|---|---|---|
| Blinman first exists at | z12 | **z8** |
| Flinders, places in the z8 tile | 2 (town 2) | 13 — hamlet 8, village 3, town 2 |
| Sydney, places in the z8 tile | 26 | 105 — hamlet 45, town 37, village 19, city 4 |
| layers | 9 | 9, none added or lost |
| places fields in use | 55 | 55, none dropped |

Rendered side by side through `core/basemap/layers.json`, z8 over the
Flinders: the live archive shows Leigh Creek and Hawker, and nothing else.
This build adds Parachilna, Blinman, Wilpena Pound, Beltana, Nepabunna,
Cradock and Belton. At z10 the live archive shows no name at all over
Blinman; this build shows Blinman, Blinman North and Parachilna. Road and
water geometry is identical.

## What is pinned, and why

The apps style this archive. A schema change — a layer gained or lost — breaks
all four at once. So the build pins the exact profile that produced the live
archive, read out of its own metadata:

| Pin | Value | Where it came from |
|---|---|---|
| protomaps/basemaps | `2697f293a555` | "Tiles 4.15.1" (#626). The last commit before the 2026-08-09 build; 4.15.2 landed 2026-08-11 |
| planetiler | 0.10.2 | `planetiler:version` in the live archive |
| Java | 21 | `tiles/pom.xml` |
| bounds | 112,-44.2 → 154.5,-9.5 | the live archive's header |
| max zoom | 14 | the live archive's header — **the generator defaults to 15** |

Do not build from their `main`. It has already staged a tenth layer
(`Transit`) that the live archive's nine do not include.

## Build

```bash
./build-basemap-au.sh
```

About 1 GB of OSM extract in, about 1 GB of archive out. It needs Maven and
a JDK 21 (`brew install maven openjdk@21`), and roughly 6 GB of free disk.

## Verify — always, before publishing

```bash
npm install                     # once, for the pmtiles reader
node probe-places.mjs https://tiles.dingodirt.com/basemap-au.pmtiles build/basemap-au.pmtiles
```

The probe prints, for both archives: the layer list and the `places` field
count (schema parity), the first zoom each of the four towns exists at, and
the locality count per tile in a dense sample and a sparse one. With two
archives it compares them and exits non-zero if the schema moved. It ends in
`PARITY OK — safe to publish` or `PARITY BROKEN — do not publish`.

Read the clutter numbers too. Pulling settlements forward is only worth doing
if it does not bury the cities: check what Sydney's z8 count did.

## Publish

Publishing replaces the map in every app, and packs already on riders' phones
pull from the same place. Keep the old one:

```bash
# keep a rollback beside it, then swap
rclone copy r2:tiles/basemap-au.pmtiles r2:tiles/basemap-au.previous.pmtiles
rclone copy build/basemap-au.pmtiles r2:tiles/
```

Rollback is a rename. `localStorage['dtiles-base']` overrides the base URL in
every app, so a single device can be pointed at a candidate archive before
anything is swapped (see `apps/plan/src/dingoBasemap.ts`).

Rebuilds are manual. Quarterly is enough — OSM place data moves slowly.
