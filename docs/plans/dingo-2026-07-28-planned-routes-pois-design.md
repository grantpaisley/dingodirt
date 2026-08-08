# Planned routes & POIs — design

2026-07-28. We brainstormed this design against `N_NSW_G.O.A.T-0728060910.gpx`
(39 named tracks with grade, distance, and condition notes, plus 328 waypoints
with Garmin symbols — campgrounds, fuel, bars, hazards). Many files like it
will follow. Planned rides that we author ourselves will also follow.

## Purpose

Curated route files are **planned rides**: routes without timings. They carry
descriptions, colors, and points of interest. They must be visible for planning
(fuel and camping matter most). They must be groupable per network. They must
export as navigable routes (OsmAnd/Locus, packs, DingoNav). They must stay out
of the recorded-ride stats.

## Data model

Planned routes live in the `rides` table (Option A). This reuses geometry
serving, layers, packs, areas, and exports for free:

- `kind ride_kind NOT NULL DEFAULT 'recorded'` — a new enum `('recorded','planned')`.
- `collection text NULL` — a human label that groups a network ("NSW GOAT").
  The label is stable across re-downloads (the file hash changes, the label
  does not). The label is editable.
- `color text NULL` — `#rrggbb`. The color comes from the GPX extensions when
  present. Otherwise the import assigns a color (golden-angle HSL rotation in
  the collection, ordered by track name, so the colors are distinct and
  stable). The user can edit the color later.
- `description text NULL` — the track `<desc>`. The parser already extracts
  it; it just never reached the DB. The import normalises HTML (`<br />`) to
  newlines.

The time, HR, speed, and weather columns stay NULL for planned rides. `grade`
stays NULL — by policy, you assign grades manually. The GOAT names carry their
own G-scale.

A new `pois` table is a standalone layer with provenance. POIs belong to the
map, not to a single route. At export, proximity answers the question "which
POIs go with this route":

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

A static map converts the Garmin `<sym>` to a category (Gas Station→fuel,
Campground/RV Park→camp, Swimming Area/Shower→water, Bar/Restaurant→food,
Skull and Crossbones/Circle with X→hazard, …). Unmapped syms become `poi`,
and `raw_sym` keeps the original.

`files` gains `source_path text NULL` — the absolute source path of an
imported file (`original_name` already exists).

## Import

```
dingo routes import <file.gpx> --collection "NSW GOAT" [--replace]
```

1. Store the file content-addressed as today. Record `source_path`.
2. Each `<trk>` becomes one ride with `kind='planned'`, the collection, the
   description, and the color. The import ignores timestamps, if present.
3. Each top-level `<wpt>` becomes a `pois` row (the gpx crate already exposes
   them).
4. Colors: read the `gpx_style:line`, OsmAnd, or Locus extensions. Otherwise
   assign a color from the palette.
5. `--replace` first deletes the planned rides and POIs of the collection.
   This is the "network got updated, re-download" path. Without it, an import
   of an existing collection errors. There are no silent duplicates.

Planned rides skip enrichment (it needs times), mode classification, dedupe,
merge-parts, and organize. Web drag-drop import can reuse the same service
function later.

## Serving & web UI

- The ride endpoints expose `kind`, `collection`, `color`, and `description`.
  Heat, stats, and aggregates filter to `kind='recorded'` (we audited this
  with grep).
- `GET /api/pois?bbox=&categories=&collections=` — windowed to the viewport.
- `GET /api/collections` — label, route count, POI count, distance, bbox.
- The Layers pane gets a "Planned routes" section. The section lists the
  collections. Each collection has a visibility toggle and a nested POI
  toggle. Focus mode applies as usual.
- Planned routes render through the per-track path machinery with the stored
  `color`. Their style is slightly different from the recorded tracks of
  other people. The detail pane shows the name, the collection, the distance,
  and the description. The pane keeps the line breaks — closure and permit
  notes are the payload.
- POI layer: a deck.gl IconLayer with an atlas built from the same
  lucide-react icons that the UI uses (fuel→Fuel, camp→Tent, water→Droplets,
  food→Beer, lodging→Bed, scenic→Camera, hazard→TriangleAlert, medical→Cross,
  info→Info, summit→Mountain, poi→MapPin). Category filter chips are
  included. Min-zoom and clustering make sure that 328 pins do not smother
  the map. A click opens a popover with the name, the category, and the
  description.

### Planned heat

A density heat layer covers **all** planned geometry. It uses the same tuned
renderer as own heat (constant ~1.5 CSS-px strokes, per-zoom normalization).
You can toggle it independently. The workflow: select a few plans as colored
tracks; the planned heat shows where every other route runs.

The color convention: **orange = me** (own recorded heat); **blue =
everything not ridden by me**. Harvested Strava overlays (MTB, hike) and
planned heat all default to the Strava blue palette. Every heat layer gets a
color override in the settings ("Heat colors": own / Strava overlays /
planned). Planned heat is vector-rendered, so the tint is a uniform. Strava
MBTiles are raster — future harvests request the blue palette parameter of
Strava, and existing archives get a client-side tint (the tiles are
near-monochrome ramps).

## Exports, packs, DingoNav

- `export offline`: planned routes carry the stored color and the `<desc>`.
  The export writes POIs as `<wpt>`, with the `<sym>` mapped back from the
  category — OsmAnd and Locus then show campgrounds and fuel natively.
- Packs can include planned collections and routes as layers. Packs can also
  include the POIs in the pack area (the corridor and box logic exists).
  Planned heat can be a pack layer.
- DingoNav: planned routes and POIs travel in the pack bundle format that
  DingoNav already reads (full-res geometry, color, description). Turn
  guidance is a separate future project. This design only makes sure that
  the data arrives.

## Out of scope (deliberate)

- Authoring or editing of planned rides in the web UI. The schema is ready;
  the feature is import-only for now.
- Auto-parse of GOAT G-grades into `grade`. The manual-only policy stands.
- DingoNav turn-by-turn guidance.
- A POI↔route join table — we use proximity at render and export time
  instead.

## Sequencing note

Implementation starts only after the merge of
`claude/gps-upload-dialog-storage-4c0868` (library storage / placement engine
/ import dialog rework). That branch touches the same import surfaces and
owns migration `20260728000001`.
