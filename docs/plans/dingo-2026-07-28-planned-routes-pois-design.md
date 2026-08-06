# Planned routes & POIs — design

2026-07-28. Brainstormed against `N_NSW_G.O.A.T-0728060910.gpx` (39 named tracks with
grade/distance/condition notes, 328 waypoints with Garmin symbols — campgrounds, fuel,
bars, hazards). Many files like it will follow, plus self-authored planned rides.

## Purpose

Curated route files are **planned rides**: routes without timings that carry
descriptions, colors, and points of interest. They must be visible for planning
(fuel and camping matter most), groupable per network, exportable as navigable
routes (OsmAnd/Locus, packs, DingoNav), and kept out of recorded-ride stats.

## Data model

Planned routes live in the `rides` table (Option A — reuses geometry serving,
layers, packs, areas, exports for free):

- `kind ride_kind NOT NULL DEFAULT 'recorded'` — new enum `('recorded','planned')`.
- `collection text NULL` — human label grouping a network ("NSW GOAT"). Stable
  across re-downloads (file hash changes, label doesn't). Editable.
- `color text NULL` — `#rrggbb`. From GPX extensions when present, else assigned
  at import (golden-angle HSL rotation within the collection, ordered by track
  name, so colors are distinct and stable). User-editable later.
- `description text NULL` — track `<desc>`; the parser already extracts it, it
  just never reached the DB. HTML (`<br />`) normalised to newlines.

Time/HR/speed/weather columns stay NULL for planned rides. `grade` stays NULL —
grades are manually assigned by policy; GOAT names carry their own G-scale.

New `pois` table (standalone layer with provenance — POIs belong to the map, not
to a single route; proximity answers "which POIs go with this route" at export):

```sql
CREATE TYPE poi_category AS ENUM ('fuel','camp','water','food','lodging',
  'scenic','hazard','medical','info','summit','poi');
CREATE TABLE pois (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position geometry(Point, 4326) NOT NULL,
  elevation real,
  name text NOT NULL,
  description text,
  category poi_category NOT NULL,
  raw_sym text,                -- original Garmin <sym>, kept verbatim for lossless remap
  collection text,
  file_id uuid REFERENCES files(id),
  ride_id uuid REFERENCES rides(id),  -- only for POIs authored on a specific planned ride
  created_at timestamptz DEFAULT now()
);
```

Garmin `<sym>` → category via a static map (Gas Station→fuel, Campground/RV
Park→camp, Swimming Area/Shower→water, Bar/Restaurant→food, Skull and
Crossbones/Circle with X→hazard, …); unmapped syms → `poi` with `raw_sym` kept.

`files` gains `source_path text NULL` — the absolute path a file was imported
from (`original_name` already exists).

## Import

```
dingo routes import <file.gpx> --collection "NSW GOAT" [--replace]
```

1. Store file content-addressed as today, recording `source_path`.
2. Each `<trk>` → one ride, `kind='planned'`, with collection/description/color.
   Timestamps, if present, are ignored.
3. Top-level `<wpt>` → `pois` rows (the gpx crate already exposes them).
4. Colors: read `gpx_style:line`/OsmAnd/Locus extensions; else palette-assign.
5. `--replace` deletes the collection's planned rides + POIs first (the
   "network got updated, re-download" path). Without it, importing an existing
   collection errors. No silent duplicates.

Planned rides skip enrichment (needs times), mode classification, dedupe,
merge-parts, and organize. Web drag-drop import can reuse the same service
function later.

## Serving & web UI

- Ride endpoints expose `kind`, `collection`, `color`, `description`. Heat,
  stats, and aggregates filter to `kind='recorded'` (audited by grep).
- `GET /api/pois?bbox=&categories=&collections=` — viewport-windowed.
- `GET /api/collections` — label, route count, POI count, distance, bbox.
- Layers pane: "Planned routes" section listing collections, each with a
  visibility toggle and nested POI toggle. Focus mode applies as usual.
- Planned routes render through the per-track path machinery using stored
  `color`, styled slightly distinct from other-people's recorded tracks.
  Detail pane shows name, collection, distance, description (line breaks kept —
  closure/permit notes are the payload).
- POI layer: deck.gl IconLayer with an atlas built from the same lucide-react
  icons the UI uses (fuel→Fuel, camp→Tent, water→Droplets, food→Beer,
  lodging→Bed, scenic→Camera, hazard→TriangleAlert, medical→Cross, info→Info,
  summit→Mountain, poi→MapPin). Category filter chips; min-zoom/clustering so
  328 pins don't smother the map; click → popover with name/category/description.

### Planned heat

A density heat layer over **all** planned geometry, same tuned renderer as own
heat (constant ~1.5 CSS-px strokes, per-zoom normalization), toggleable
independently. Workflow: select a few plans as colored tracks; planned heat
shows where every other route runs.

Color convention: **orange = me** (own recorded heat); **blue = everything not
ridden by me** — harvested Strava overlays (MTB, hike) and planned heat all
default to the Strava blue palette. Every heat layer gets a color override in
settings ("Heat colors": own / Strava overlays / planned). Planned heat is
vector-rendered so tint is a uniform; Strava MBTiles are raster — future
harvests request Strava's blue palette parameter, existing archives get a
client-side tint (tiles are near-monochrome ramps).

## Exports, packs, DingoNav

- `export offline`: planned routes carry stored color + `<desc>`; POIs written
  as `<wpt>` with `<sym>` mapped back from category — OsmAnd/Locus show
  campgrounds and fuel natively.
- Packs: can include planned collections/routes as layers and POIs within the
  pack area (corridor/box logic exists). Planned heat can be a pack layer.
- DingoNav: planned routes + POIs ride along in the pack bundle format it
  already reads (full-res geometry, color, description). Turn guidance is a
  separate future project; this design only guarantees the data arrives.

## Out of scope (deliberate)

- Authoring/editing planned rides in the web UI (schema is ready; import-only for now).
- Auto-parsing GOAT G-grades into `grade` (manual-only policy stands).
- DingoNav turn-by-turn guidance.
- POI↔route join table — proximity at render/export time instead.

## Sequencing note

Implementation starts only after `claude/gps-upload-dialog-storage-4c0868`
(library storage / placement engine / import dialog rework) is merged — it
touches the same import surfaces and owns migration `20260728000001`.
