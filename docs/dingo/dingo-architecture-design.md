# Dingo Design Document

*A local-first, segment-centric trail knowledge system for off-road riding*

---

## Overview

Dingo changes raw ride history into a directed trail network that you maintain. The network holds rich metadata, run history, and personal Dingo scores. The system is for individual riders and small crews, not for public sharing.

Segments, not GPX files, are the source of truth. The direction, the conditions, and the riding mode all change how a trail behaves. They also change how rewarding the trail is to ride.

---

## Goals

### Primary Goals

- Maintain a personal trail library across the known riding areas
- Treat segments (not GPX files) as the source of truth
- Support direction-specific, condition-specific, and mode-specific behaviour
- Let you plan rides that make your Dingo score as high as possible
- Keep the ride history as a time series for replay and analysis
- Enrich segments with photo evidence for conditions, obstacles, and POI discovery

### Non-Goals (Initially)

- Public/global GPX sharing
- Real-time navigation or turn-by-turn routing
- Full ML/black-box recommendation systems

---

## Core Architecture

Dingo is a Rust workspace with a hybrid runtime. A long-running daemon serves interactive queries. CLI binaries do the batch processing. Both use a common library layer.

### Technology Stack

| Component | Choice |
|-----------|--------|
| Language | Rust (aggressive performance optimisation) |
| Database | PostGIS (Postgres + PostGIS extension) |
| DB Client | sqlx (compile-time verified async queries) |
| Vector DB | LanceDB (embedded, Rust-native) |
| File Storage | Content-addressed file store (files/{sha256}.{ext}) |
| Photo Storage | Content-addressed (photos/{sha256}_thumb.jpg, photos/{sha256}_medium.jpg) |
| ML Runtime | ONNX (local inference) + Cloud API fallback |

### Crate Structure

```
dingo/
  crates/
    core/       # Domain types, DB schema, config, error handling
    geo/        # Geometry ops: cleaning, snapping, simplification
    ingest/     # Format parsing (FIT, GPX, KML, GeoJSON, TCX), file store
    enrich/     # Context enrichment: weather fetch, solar position
    graph/      # Segment network: creation, splitting, merging
    match/      # Ride → segment run matching
    stats/      # Aggregation, feature extraction, Dingo scoring
    vision/     # Photo processing, ML inference, training pipeline
    google/     # Google Photos API client, OAuth handling
    daemon/     # Async query server, LISTEN/NOTIFY subscriber
    cli/        # Thin wrappers: ingest, clean, rebuild, export, photos, ml
```

### Runtime Split

| Concern | Handler | Why |
|---------|---------|-----|
| Queries, route building, UI | Daemon | Hot connection pool, sub-second response |
| Ingest, cleaning, enrichment, stats | CLI | Runs in parallel, no latency requirement |
| Photo fetch, ML inference | CLI | Batch processing, can use many resources |

### Event Coordination

- **Postgres LISTEN/NOTIFY** makes the daemon react to events
- **File watcher (inotify)** starts the CLI ingest for batch drops
- **Outbox table** controls multi-step workflows (ingest → clean → enrich → match → stats → photos)

---

## Data Model

### Core Entities

| Entity | Purpose |
|--------|---------|
| **areas** | A named riding region. It is hierarchical and has a boundary polygon that the user confirms |
| **files** | The raw source file metadata + SHA256 hash (the bytes are in the file store) |
| **rides** | A timestamped recording: cleaned geometry, time series, sensor data, weather context |
| **routes** | A geometry-only input (no timestamps). It contributes to segment discovery |
| **segments** | The undirected trail identity, with a stable UUID and the current geometry hash |
| **segment_dirs** | A directed edge (A→B or B→A). It holds the direction-specific properties |
| **runs** | One traversal of a directed segment by a ride. It includes the `out_and_back_reason` enum when applicable. |
| **pois** | A point of interest: freestanding or segment-bound |
| **segment_dir_stats** | The aggregated stats for each (direction, mode, condition) |
| **segment_dir_dingo_score** | The Dingo score for each (direction, mode, condition, profile) |
| **photos** | The photo metadata, the segment/run link, and the storage paths |
| **photo_labels** | ML-detected attributes as label/value pairs with confidence |
| **poi_suggestions** | Pending POI candidates from photos. They wait for user review |
| **ml_training_queue** | User corrections that wait for model retraining |
| **rematch_queue** | Rides that wait for a rematch after segment topology changes (split/merge), with a priority |

### Segment Identity

Segments use content-addressable versioning with stable UUIDs:

- **segment_id** — a stable UUID. It stays the same when the geometry becomes more accurate
- **geometry_hash** — the SHA256 of the canonical linestring. It tracks the versions
- **name** — the what3words name from the start point (default). The user can change it
- On a split: the system deletes the old segment and creates new segments. It queues the affected rides for a rematch in the background

### Segment Visibility

| Visibility | Meaning |
|------------|---------|
| visible | A normal segment. It shows in the UI and is used in routing |
| hidden | The segment exists, but the UI and the routing do not use it by default |
| unreviewed | The system found an anomaly (e.g., out-and-back). The segment waits for a user decision |

### Vector Search

The system embeds segment descriptions, tags, derived features, and photo descriptions in LanceDB for semantic search. The index uses the segment_dir UUID and the photo UUID. The daemon queries Postgres for structured filters. It queries LanceDB for natural language matches (e.g., "find me something technical near Beerburrum" or "muddy single track with water crossing"). Both databases are local. No external services are necessary.

**Recency Boost:** The system ranks photo search results with a time decay multiplier on the similarity score. Recent photos rank higher. Older results still appear for segments with few rides. You can configure the decay function (default: exponential decay with 12-month half-life).

---

## Ingest & Cleaning Pipeline

### Supported Formats

FIT is the preferred format for Garmin (the source format with full sensor fidelity). GPX is the fallback.

| Format | Notes |
|--------|-------|
| FIT | Garmin native, preferred, full sensor data |
| GPX | Standard, rides + routes |
| KML/KMZ | Google Earth, often routes/POIs |
| GeoJSON | Programmatic imports |
| TCX | Older Garmin, some watches |

### FIT File Import (Detailed)

FIT is the preferred format for Garmin devices. It keeps full sensor fidelity, which GPX exports do not.

**Parser:** `fit-rs` (the most complete Rust FIT implementation, exposes raw records)

**Data Flow:**
```
FIT file → fit-rs → ParsedSession → rides table
```

**ParsedSession fields:**

| Field | Type | Description |
|-------|------|-------------|
| `geometry` | `Vec<Coordinate>` | The GPS track (semicircles → degrees at the boundary) |
| `timestamps` | `Vec<DateTime<Utc>>` | The master time index (FIT epoch → UTC at the boundary) |
| `heart_rate` | `Vec<Option<u16>>` | Aligned to the timestamps, NULL for missing values |
| `cadence` | `Vec<Option<u16>>` | Aligned to the timestamps |
| `power` | `Vec<Option<u16>>` | Aligned to the timestamps |
| `temperature` | `Vec<Option<f32>>` | Aligned to the timestamps |
| `altitude` | `Vec<Option<f32>>` | Enhanced altitude |
| `speed` | `Vec<Option<f32>>` | Enhanced speed |
| `sport` | `Option<String>` | The original FIT sport field |
| `sub_sport` | `Option<String>` | The original FIT sub_sport field |
| `device` | `DeviceInfo` | Manufacturer, product, serial, firmware |
| `sensor_data` | `JSON` | Overflow: developer fields, device extensions |

**Multi-session handling:** One ride for each session (the same as the multi-track GPX behaviour)

**Error Handling:**

| Scenario | Behaviour |
|----------|-----------|
| The file is valid, all sessions parsed | `status = Complete`, insert all rides |
| Parse errors, but some sessions recovered | `status = Partial`, insert the valid rides, log the errors |
| No usable data | Quarantine to `files/quarantine/{sha256}.fit`, insert a `files` row with `status = quarantine` |

**Coordinate conversion:** Semicircles → degrees in the ingest layer (lossless, and downstream code expects degrees)

**Timestamp conversion:** FIT epoch → UTC in the ingest layer (an encoding detail, not meaningful data)

**Array Alignment:** FIT records do not always have all fields at every timestamp. The approach is:

- The timestamp array is the master index
- All sensor arrays have the same length as the timestamps
- A missing value → `NULL` at that index

### Garmin Export Zip Handling

**Trigger:** `dingo ingest <path>` where the path is a `.zip` file

**Detection flow:**

1. Open the zip file. Examine the structure
2. If it holds `DI_CONNECT/DI-Connect-Fitness-Uploaded-Files/` or `DI_CONNECT/DI-Connect-Uploaded-Files/` → a Garmin GDPR export
3. If not → a generic zip file (extract it, then do the same steps on the contents)

**Garmin export structure:**
```
export.zip
└── DI_CONNECT/
    └── DI-Connect-Fitness-Uploaded-Files/
        ├── {id}_ACTIVITY.zip
        │   └── {id}_ACTIVITY.fit
        └── ...
```

**Processing:**

1. Do a loop through the nested zip files in `DI-Connect-*-Uploaded-Files/`
2. For each nested zip file: extract the inner FIT file. Check it against the `*_ACTIVITY.fit` pattern
3. Send the file to the FIT parser and the normal ingest flow (remove duplicates by SHA256, insert the rides, emit the events)

**File filtering:**

| File type | Action |
|-----------|--------|
| `*_ACTIVITY.fit` | Process |
| `*_WELLNESS.fit` | Skip (log) |
| `*_SLEEP.fit` | Skip (log) |
| Other | Skip (log) |

**Progress reporting:** For large exports, emit the progress: "Processing 142/847 activities..."

### Ingest Process

CLI command: `dingo ingest <path>`

1. Check the path: a file, a directory, or a zip file
2. For a zip file: find if it is a Garmin export or a generic zip file. Then process it
3. For files: find the format from the magic bytes. Parse the file to the internal representation
4. Store the raw file in `files/{sha256}.{ext}`
5. Find the type: timestamps → a Ride, no timestamps → a Route
6. For files with more than one track or session: process and name each track or session independently
7. For FIT: extract the sensor arrays. Align them to the master timestamp index
8. Emit the event: `ride_ingested` or `route_ingested`

### Cleaning Process

The system cleans rides only. It does not clean routes. It uses the route geometry as-is.

1. Remove the GPS jitter (a Kalman filter or similar)
2. Simplify the points (Ramer-Douglas-Peucker, keep the detail)
3. Find the difference between stops and technical slow sections:
   - Primary: the speed + the positional variance in a sliding window
   - Secondary: the HR delta from a rolling baseline (when available)
   - A stop = low speed AND low variance AND a decrease in HR AND duration > threshold
4. Split the ride at significant pauses (optional, configurable)
5. Generate the ride name with the naming convention (see the Export section)
6. Emit the event: `ride_cleaned`

### Context Enrichment

This step runs after the clean step and before the graph match step. It captures external context that GPS data alone cannot supply.

**Trigger:** the `ride_cleaned` event

**Process:**

1. Fetch the historical weather from the Open-Meteo API. Use the ride start timestamp + the location
2. Calculate the solar position from the timestamp + the coordinates

**Weather Fields (stored on Ride):**

| Field | Description |
|-------|-------------|
| `precip_last_24h` | mm of rain in the 24 hours before |
| `precip_last_48h` | mm of rain in the 48 hours before (ground saturation) |
| `temp_max` | °C at the location on the ride date |
| `temp_min` | °C at the location on the ride date |
| `inferred_condition` | dry / wet / unknown, derived from the precipitation thresholds |
| `condition_confidence` | low / medium / high, based on how complete the data is |

**Solar Fields (stored on Ride):**

| Field | Description |
|-------|-------------|
| `time_of_day` | day / dawn / dusk / night, derived from the solar position at the ride start |

Dawn and dusk periods are significant for ADV riding. Animal activity increases the danger. It also forces slower progress on segments that are usually fast.

**Why capture at ingest:** If you add the weather data later, you must query the APIs again for historical data. Capture at ingest is more simple and more reliable.

**Emit event:** `ride_enriched`

### Preservation

The system never changes the raw files. It can always derive the data from them again. The cleaning logic has a version. The system can replay the clean step if the algorithm improves.

---

## Segment Graph Building

### Trigger

A `ride_enriched` or `route_ingested` event, or a manual rebuild with `dingo graph rebuild --area <id>`

### Process

1. Load the cleaned ride or route geometry
2. Snap the geometry to a spatial grid (configurable precision, e.g., 1m)
3. Compare the geometry with the existing segments in the area
4. The outcomes: Match (it overlaps an existing segment), New (no overlap), Fork (partial overlap, a split is necessary)

### Segment Creation

1. Generate a stable UUID
2. Compute the canonical linestring (a consistent direction: the lower lat/lng endpoint first)
3. Hash the geometry → geometry_hash
4. Create two segment_dirs (A→B, B→A)
5. Extract the properties for each direction: the length, the elevation gain/loss, the average grade

### Segment Splitting

When a new ride shows a fork in the middle of a segment:

1. Delete the old segment (this cascades to the segment_dirs)
2. Create two new segments with new UUIDs
3. Queue the affected rides in the `rematch_queue` with the reason `topology_change`
4. A background worker processes the queue in priority order
5. The runs keep the old stats until the rematch (lazy re-evaluation)

This lazy re-evaluation strategy makes sure that the UI stays responsive when topology changes affect many historic rides.

### Out-and-Back Detection

When a ride crosses the same geometry two times in opposite directions:

- The system creates one or more separate segments
- If the terminus is near a POI → mark the segment **visible**, set `out_and_back_reason = poi_detour`
- If the terminus has a high grade AND the speed dropped to near zero before the reversal → mark the segment **visible**, set `out_and_back_reason = attempted_climb`
- If not → mark the segment **unreviewed**, set `out_and_back_reason = unknown`

**out_and_back_reason enum:**

| Value | Meaning |
|-------|---------|
| `poi_detour` | The terminus is near a known POI |
| `attempted_climb` | A high grade + a stall found at the terminus |
| `unknown` | No heuristic matched. The segment waits for user review |

The `attempted_climb` heuristic captures valuable metadata — "this hill stops people". This is useful for route planning.

### Tolerances

- Snap tolerance: ~5m (GPS accuracy)
- Overlap threshold: 80% shared length to count as the "same segment"
- Configurable for each area (tighter for dense trail networks)

---

## Run Matching

### Trigger

A `ride_enriched` event, or manual with `dingo match --ride <id>` or `dingo match --area <id>`

### Process

1. Load the cleaned ride geometry + the time series
2. Load the segment network for the area(s) of the ride
3. Walk the ride point by point. Snap each point to the nearest segment. Track the transitions
4. Record the direction of travel (A→B or B→A)
5. For each traversal, extract a run with the timing, the speed, and the HR summary
6. Emit the event: `runs_matched`

### Run Data Captured

| Field | Description |
|-------|-------------|
| `start_time`, `end_time` | When the traversal started and ended |
| `elapsed_s` | The total time, stops included (seconds) |
| `stopped_s` | The stationary time (seconds) |
| `moving_s` | The time in motion (elapsed - stopped) |
| `speed_avg` | The average speed (m/s) |
| `speed_max` | The maximum speed (m/s) |
| `speed_variance` | The speed variance (a consistency metric) |
| `hr_avg` | The average heart rate (when available) |
| `hr_max` | The maximum heart rate (when available) |
| `mode` | ADV / Enduro / eBike |
| `condition` | Dry / Wet / Unknown |
| `out_and_back_reason` | `poi_detour`, `attempted_climb`, or `unknown` (when applicable) |


### Edge Cases

- The ride crosses an unmapped area → the system logs the geometry, creates no runs, and flags the ride for review
- GPS drift (< 20m off the segment for < 5 seconds) → the system bridges the gap
- The ride reverses in the middle of a segment → two runs, one for each direction

---

## Photo Enrichment Pipeline

### Overview

After the segment match, the system fetches photos from Google Photos. It matches the photos to segments. It runs ML inference to make labels. It queues POI suggestions for user review.

### Pipeline Stages

```
runs_matched event
       ↓
  Photo Fetch (Google Photos API)
       ↓
  Photo Processing (resize, compress, EXIF extract)
       ↓
  Segment Matching (GPS or timestamp → segment/run)
       ↓
  ML Inference (local model, cloud fallback)
       ↓
  Storage (thumbnails, medium, URLs)
       ↓
  POI Suggestion (queue for user review)
       ↓
  Vector Embedding (description → LanceDB)
```

### Google Photos Integration

> **Update (2026-07-03):** the OAuth flow below does not work now. Google removed
> the Library API read scopes on 2025-03-31 (403 PERMISSION_DENIED). Third-party
> apps can only read content that the app created. We made the **Takeout import**
> instead (`dingo photos import <extracted-takeout-dir>`, crates/google/src/takeout.rs).
> The JSON sidecars supply UTC timestamps, geoData, and a permanent
> photos.google.com link-out URL. The current APIs cannot supply these. Incremental
> imports can later use the **Picker API** (the user selects photos for each session; no
> geo data, no link-out URL). We keep the fetch/auth design below for reference.

**Authentication (obsolete — see update above):**

1. On the first run: the browser opens the Google OAuth consent screen
2. The user gives read-only access to Google Photos
3. The system stores the refresh token in the local config (`~/.config/dingo/google_auth.json`)
4. The daemon refreshes the token silently
5. When the token expires or is revoked: fall back to browser auth, tell the user

**Fetch process:**

1. Query the time window of the ride: `ride.start_time - 30min` to `ride.end_time + 30min`
2. Filter to images only (skip the videos)
3. Check the `google_photos_id` against the existing photos table (skip the duplicates)
4. Download the medium-res version (800px) with `baseUrl=w800`
5. Generate the thumbnail locally (200px)
6. Extract the EXIF data: the timestamp, the GPS, the camera info
7. Store the files in the content-addressed store: `photos/{sha256}_thumb.jpg`, `photos/{sha256}_medium.jpg`

**Rate limiting:**

- Google Photos API: 10,000 requests/day
- Fetch in batches. Obey the quotas
- Queue large imports. Process them in increments

### Photo-to-Segment Matching

**Matching priority:**

1. **GPS match (preferred):** The photo has EXIF GPS → snap it to the nearest segment in 50m
2. **Timestamp match (fallback):** No GPS → interpolate the position on the ride timeline → the photo gets the segment from that point

**Process:**

```
For each photo:
  1. Extract EXIF GPS coordinates
  2. If GPS present:
     - Find nearest segment_dir within 50m
     - If multiple candidates (junction), pick segment from run sequence at that time
     - Record match_method = 'gps'
  3. If no GPS:
     - Find ride with time window containing photo timestamp
     - Interpolate position along ride geometry at that timestamp
     - Inherit segment_dir from run sequence at that point
     - Record match_method = 'timestamp'
  4. If no match:
     - Photo stored but unlinked (segment_dir_id = null)
     - Flagged for manual review
```

**Edge cases:**

| Situation | Handling |
|-----------|----------|
| A photo at a junction | Attach the photo to the segment from the run sequence at that timestamp. The ml_description captures the junction context |
| A photo off-trail (>50m) | Store the photo with no link. Flag it for review — it can show an unmapped trail |
| The photo timestamp is outside all rides | Store the photo with no link. It stays available for manual association |
| More than one ride on the same day | Match the photo to the ride with the closest time window |

### Photo Storage

**Three tiers:**

| Tier | Size | Storage | Purpose |
|------|------|---------|---------|
| Thumbnail | ~200px, <20KB | Local | List views, quick loading |
| Medium | ~800px, ~50-100KB | Local | The inspector, condition identification |
| Original | Full resolution | Google Photos URL | View the original on demand |

**File structure:**

```
photos/
  {sha256}_thumb.jpg
  {sha256}_medium.jpg
```

### Photo Data Model

**photos table:**

| Field | Type | Description |
|-------|------|-------------|
| photo_id | UUID | The stable identifier |
| google_photos_id | String | The original source reference |
| google_photos_url | String | The link to the full-res original |
| run_id | UUID (nullable) | The matched run |
| segment_dir_id | UUID (nullable) | The matched segment direction |
| poi_id | UUID (nullable) | The related POI, if the photo shows one |
| captured_at | Timestamp | The EXIF timestamp |
| location | Point (nullable) | The EXIF GPS, if available |
| match_method | Enum | `gps`, `timestamp`, `manual` |
| thumbnail_path | String | The ~200px version |
| medium_path | String | The ~800px version |
| ml_description | Text | A natural language description for the vector DB |
| ml_confidence | Float | The overall inference confidence |
| user_reviewed | Boolean | Shows if the user confirmed or corrected the photo |
| created_at | Timestamp | |

**photo_labels table:**

| Field | Type | Description |
|-------|------|-------------|
| label_id | UUID | |
| photo_id | UUID | FK to photos |
| label_type | String | The category: `surface`, `trail_type`, `obstacle`, `condition`, `lighting`, `infrastructure`, `vegetation` |
| label_value | String | The detected value: `mud`, `single_track`, `gate`, `wet`, etc. |
| confidence | Float | 0.0 - 1.0 |
| source | Enum | `ml_local`, `ml_cloud`, `user` |
| created_at | Timestamp | |

**Indexes:** (photo_id), (label_type, label_value), (source) for training queries

---

## ML Vision Module

### Architecture

```
vision/
  src/
    inference/
      mod.rs          # Trait definition for model backends
      local.rs        # Local model (ONNX runtime)
      cloud.rs        # Cloud API (Claude Vision, etc.)
      router.rs       # Confidence-based routing logic
    training/
      queue.rs        # Manages ml_training_queue
      export.rs       # Exports labelled data for retraining
    models/           # Local model weights (git-ignored)
    lib.rs
```

### Inference Interface

```rust
trait VisionBackend {
    async fn analyse(&self, image: &[u8]) -> Result<PhotoAnalysis>;
}

struct PhotoAnalysis {
    description: String,           // Natural language for vector DB
    labels: Vec<Label>,            // Structured label/value/confidence
    confidence: f32,               // Overall confidence
}

struct Label {
    label_type: String,            // "surface", "obstacle", etc.
    label_value: String,           // "mud", "log", etc.
    confidence: f32,
}
```

### Routing Logic

1. Run the local model first
2. If `confidence < 0.7` → flag the photo for the cloud fallback
3. The cloud fallback runs if it is enabled and quota is available
4. If both give low confidence → queue the photo for user review

### Label Vocabulary

| Type | Values |
|------|--------|
| surface | dirt, rock, sand, mud, gravel, sealed, grass |
| trail_type | single_track, fire_trail, dirt_road, sealed_road |
| condition | wet, dry, dusty, muddy, flooded |
| lighting | day, dawn, dusk, night |
| obstacle | log, rut, washout, rocks, erosion, water_crossing |
| infrastructure | gate, fence, sign, bridge, culvert |
| vegetation | open, enclosed, overgrown |

### Bootstrap Strategy

1. **Cloud API bootstrap:** Process the first 500-1000 photos with Claude Vision and domain-specific prompts
2. **Initial training:** Train the local model on the labels from the cloud
3. **Deploy local:** Use the local model for all new photos
4. **Cloud fallback:** Send images with low confidence to the cloud API
5. **Continuous learning:** User corrections go to the training queue
6. **Periodic retrain:** Update the model weekly or monthly

---

## POI Suggestion Flow

### Trigger

After the ML inference, if the labels hold infrastructure, obstacles, or notable features → create a `poi_suggestion` record.

### poi_suggestions table

| Field | Type | Description |
|-------|------|-------------|
| suggestion_id | UUID | |
| photo_id | UUID | The source photo |
| segment_dir_id | UUID | Where the suggestion is on the network |
| location | Point | The suggested POI location |
| suggested_type | String | The POI category: `infrastructure`, `hazard`, `navigation` |
| suggested_subtype | String | The specific type: `gate`, `log`, `junction` |
| ml_description | Text | Why the ML thinks this is a POI |
| confidence | Float | The ML confidence |
| status | Enum | `pending`, `accepted`, `rejected`, `merged` |
| reviewed_at | Timestamp (nullable) | |
| created_poi_id | UUID (nullable) | If accepted, the link to the created POI |
| created_at | Timestamp | |

### Suggestion Rules

| Label detected | Suggested POI type |
|----------------|-------------------|
| gate, fence, sign | infrastructure |
| log, washout, rocks, water_crossing | hazard |
| junction (inferred from more than one segment nearby) | navigation |
| bridge, culvert | infrastructure |

### User Review Flow

1. The UI shows the pending suggestions in groups by ride or by area
2. The user can: Accept (this creates a POI), Reject, or Merge (link to an existing POI)
3. Accept/Reject goes to the `ml_training_queue` with `source = user`
4. Merged suggestions help to remove duplicates (the same gate in photos from more than one ride)

### Deduplication

Before the system creates a suggestion, it looks for an existing POI of the same type in 20m. If it finds one → it suggests a merge, not a new POI.

---

## Training Pipeline

### Data Flow

```
User correction (accept/reject/edit label)
       ↓
  ml_training_queue table
       ↓
  Periodic export (weekly or manual trigger)
       ↓
  Training dataset (images + labels)
       ↓
  Model fine-tuning (offline)
       ↓
  New model weights → models/ directory
       ↓
  Hot-reload or daemon restart
```

### ml_training_queue table

| Field | Type | Description |
|-------|------|-------------|
| queue_id | UUID | |
| photo_id | UUID | The source photo |
| label_type | String | What the user corrected |
| original_value | String (nullable) | The ML prediction |
| corrected_value | String | The correction from the user |
| action | Enum | `confirm`, `correct`, `reject` |
| created_at | Timestamp | |
| exported_at | Timestamp (nullable) | When the record went into a training export |

### Training Triggers

| Trigger | Action |
|---------|--------|
| The user accepts a POI suggestion | `confirm` for the detected labels |
| The user rejects a POI suggestion | `reject` for the detected labels |
| The user edits a photo label | `correct` with the original + the new value |
| The user adds a label | `correct` with original = null |

### Export Format

```
training_export/
  YYYY-MM-DD/
    manifest.json        # Photo IDs, labels, actions
    images/
      {photo_id}_medium.jpg
```

---

## Vector Database Integration

### Indexed Tables

| Table | Indexed by | Content |
|-------|-----------|---------|
| `segment_embeddings` | segment_dir_id | The segment descriptions, tags, and features |
| `photo_embeddings` | photo_id | The ML-generated description + the labels |

### Photo Embedding Content

Concatenate the fields into a single text block:

```
{ml_description}
Surface: {surface labels}
Condition: {condition labels}
Trail type: {trail_type labels}
Obstacles: {obstacle labels}
Lighting: {lighting}
```

Example:

```
Rocky descent through eucalypt forest with loose surface and moderate erosion.
Surface: rock, dirt
Condition: dry, dusty
Trail type: single_track
Obstacles: erosion, loose rocks
Lighting: day
```

### Search Use Cases

| Query | Matches |
|-------|---------|
| "muddy single track" | Photos/segments with the wet + single_track labels |
| "gate near Beerburrum" | Infrastructure POIs + a spatial filter |
| "technical rocky descent" | High rock/erosion labels + downhill segments |
| "water crossing" | The obstacle label + the related photos |

### Segment Enrichment

The segment descriptions in the vector DB can aggregate data from the linked photos:

- The most common surface across the photos
- The condition variation (wet appearances vs dry appearances)
- Notable features (gates, crossings)

---

## Stats Aggregation & Dingo Scoring

### Stats Per (segment_dir, mode, condition)

| Stat | Description |
|------|-------------|
| run_count | The total traversals |
| time_min/max/median | The fastest, slowest, and typical run times |
| time_stddev | A consistency measure |
| speed_avg | The average speed across the runs |
| stop_time_avg | The average stopped time |
| hr_avg, hr_max | The heart rate averages (when available) |

### Confidence Tiers

| Tier | Criteria |
|------|----------|
| unridden | 0 runs, geometry only |
| provisional | 1-2 runs, the stats exist but have high variance |
| confident | 3+ runs, the stats are stable enough to trust |

*Future enhancement: variance-based confidence (confident when the stddev becomes stable, with no count requirement).*

### Trail Type

| Type | Description |
|------|-------------|
| sealed | A paved road, tarmac |
| dirt_road | An unsealed road, graded |
| fire_trail | A wide track, usually accessible by 4WD |
| single_track | A narrow trail, single file |
| technical | Rocky, rooty, challenging terrain |

Sources: user tags (primary), inference from photo labels, inference from geometry + speed patterns (future), or import from external data (e.g., OSM).

### Feature Extraction

| Feature | Source | Notes |
|---------|--------|-------|
| length | Geometry | |
| elevation_gain/loss | Geometry | For each direction |
| avg/max_grade | Geometry | |
| twistiness | Geometry | The bearing change per meter |
| pace_vs_shape | Stats vs geometry | Slow for the shape = technical |
| stop_density | Stats | The stops per km |
| hr_intensity | Stats | The HR vs the baseline |
| surface_type | Photos | Aggregated from the photo_labels |
| obstacle_density | Photos | The count of obstacle labels per km |

### Dingo Profiles

The system computes the Dingo score for each (segment_dir, mode, condition, dingo_profile). The score = the weighted sum of the normalised features, on a 0-100 scale.

| Profile | Weights |
|---------|---------|
| **flow** | High: speed, twistiness. Low: stops, elevation gain |
| **tech** | High: pace_vs_shape, hr_intensity. Low: speed |
| **scenic** | High: low stress. Low: stop_density, elevation gain |
| **efficient** | High: speed. Penalty: stops, gates, overgrown (tags) |

### Slog Detection

- **Technical slow:** low speed + high hr_intensity + continuous movement
- **Bad slow (slog):** low speed + low HR + high stop_density + negative tags

All profiles give slogs a penalty, except the tech profile.

---

## Points of Interest

### POI Types

| Category | Examples |
|----------|----------|
| infrastructure | Parking, fuel, water, camping, gate, fence, sign, bridge, culvert |
| hazard | Log, washout, drop-off, steep descent, rocks, water_crossing |
| navigation | Junction, landmark, trail marker |
| destination | Lookout, swimming hole, café |

### POI Storage

- poi_id (a stable UUID), area_id, type, subtype
- geometry (the point location)
- Optional: segment_dir_id + distance_along (when the POI is segment-bound)
- name, notes, tags (flexible key-value)
- photo_id (optional, the source photo if the POI came from a suggestion)

Sources: extraction from imported routes, user creation, detection from ride patterns, or ML suggestions from photos.

---

## Areas

### Area Structure

Areas are hierarchical. The child area boundary must be inside the parent boundary.

| Field | Description |
|-------|-------------|
| area_id | A stable UUID |
| parent_id | The optional UUID of the parent area (null = top-level) |
| name | The display name |
| boundary | The polygon geometry |
| mode_affinity | The primary modes: ADV, Enduro, eBike, or mixed |

### Area Creation Flow

1. **Auto-suggest:** The system clusters the ride density with DBSCAN
2. **User confirms:** The user accepts the suggested boundary or draws a custom polygon
3. The system assigns each segment to the most specific (deepest) area that holds it

### Area Statistics (Derived)

- total_km, segment_count, run_count
- coverage (the % with confident stats)
- photo_count
- last_ridden

---

## Routes & Export

### Routes as Input

Routes are imports with geometry only (no timestamps). They contribute to segment discovery.

Fields: route_id, file_hash, name, source, area_id, geometry, imported_at.

On ingest: the geometry goes to the segment graph. The system extracts POIs from the waypoints.

### Saved Routes (Output)

A planned route is an ordered list of `(segment_dir_id, direction)`. The system derives the geometry on demand from the current segment geometries. It does not store the geometry separately.

### Naming Convention

| Pattern | Template |
|---------|----------|
| A loop with a midpoint | `<Start> loop via <Mid> <Dist> kms <Dur> hrs on <Date> (<Orig>).gpx` |
| A loop with no midpoint | `<Start> loop <Dist> kms <Dur> hrs on <Date> (<Orig>).gpx` |
| One-way | `<Start> to <End> via <Mid> <Dist> kms <Dur> hrs on <Date> (<Orig>).gpx` |

**Formatting:**
- Distance = integer km
- Duration = 1 decimal if <10h, else integer
- Date = YYYY-MM-DD

The system resolves the locality with a reverse geocode (an embedded gazetteer or an API, cached).

The naming pass also fills the locality attributes for each ride: `suburbs` and `lgas`
(ALL the localities on the track, sampled at the nearest locality about every km,
in first-encounter order), `state` (the majority over the samples), and `region` (curated
colloquial regions — not a formal AU admin level — mapped from (state, LGA) in
`data/lga-regions-au.tsv`, loaded with `dingo gazetteer load-regions`).

### Export Formats

CLI: `dingo export route <id> --format <fmt>`

| Format | Use Case |
|--------|----------|
| GPX | Universal (Garmin, Locus, etc.) |
| FIT | Garmin devices (course) |
| KML | Google Earth, sharing |
| GeoJSON | Programmatic use |

### Folder Structure for Sync

The export target includes a folder path that mirrors the area hierarchy.

Example: `/Tracks/North NSW/Beerburrum State Forest/<filename>.gpx`

---

## Daemon & CLI Interface

### Daemon (dingo-daemon)

A long-running process for interactive queries:

- Query serving: segment lookup, stats, Dingo scores, route building
- Event subscription: LISTEN/NOTIFY on the Postgres events table
- Semantic search: LanceDB queries for natural language matches (segments + photos)
- Photo serving: thumbnails and medium images for the UI
- OAuth management: the Google Photos token refresh
- ML routing: the decision between local and cloud inference
- A WebSocket/HTTP API for the frontend UI

### CLI Commands (dingo)

| Command | Description |
|---------|-------------|
| `dingo ingest <path>` | Import a file or watch a folder |
| `dingo clean --ride <id>` | Clean a ride again |
| `dingo enrich --ride <id>` | Run the context enrichment again (weather, solar) |
| `dingo graph rebuild --area <id>` | Rebuild the segment network |
| `dingo match --ride/--area <id>` | Match rides to segments again |
| `dingo stats rebuild --area <id>` | Compute the stats and the Dingo scores again |
| `dingo export route <id> --format <fmt>` | Export a saved route |
| `dingo export area <id> --format <fmt>` | Export all segments/POIs in an area |
| `dingo sync locus --push/--pull` | Sync with the Locus app |
| `dingo area suggest` | Run DBSCAN, suggest new areas |
| `dingo area create --name <n> --parent <id>` | Create an area from a drawn boundary |
| `dingo segment hide/show <id>` | Set the segment visibility on or off |
| `dingo poi add --type <t> --location <lat,lng>` | Add a freestanding POI |
| `dingo photos fetch --ride <id>` | Fetch the photos for a ride from Google Photos |
| `dingo photos fetch --area <id>` | Fetch the photos for all rides in an area |
| `dingo photos match --ride <id>` | Run the segment match again for the photos of a ride |
| `dingo photos analyse --ride <id>` | Run the ML inference again on the photos of a ride |
| `dingo photos review` | Open the UI at the pending POI suggestions |
| `dingo ml export` | Export the training queue to a dataset |
| `dingo ml status` | Show the model version, the training queue size, the cloud quota |
| `dingo auth google` | Run the OAuth flow for Google Photos |
| `dingo queue status` | Show the rematch queue size and progress |
| `dingo queue process` | Start the background rematch process manually |

**Common flags:** `--area <id>`, `--dry-run`, `--verbose`, `--format <fmt>`

### Event Flow

| Event | Trigger | Action |
|-------|---------|--------|
| `ride_ingested` | A file import | Queue the clean step |
| `ride_cleaned` | The clean step is complete | Queue the enrichment |
| `ride_enriched` | The enrichment is complete | Queue the graph + match steps |
| `runs_matched` | The match step is complete | Queue the photo fetch |
| `photos_fetched` | The Google Photos download | Queue the ML inference |
| `photos_analysed` | The ML is complete | Create the POI suggestions, update the vector DB |
| `poi_suggestion_reviewed` | The user accepts/rejects | Update the training queue |
| `topology_changed` | A segment split/merge | Queue the affected rides in the rematch_queue |

---

## User Interface

### Stack

The daemon serves an embedded web UI. It is local-first, with no external hosts.

| Component | Choice |
|-----------|--------|
| Frontend | HTMX + Tera templates (SSR), or a lightweight JS framework (Svelte) + a Rust API |
| Map | MapLibre GL (open source, vector tiles) |
| Served by | The daemon on localhost |

**Trade-offs:**

- **HTMX + Tera:** The logic stays in Rust, with minimal frontend complexity. But MapLibre needs JS interop in each case
- **Svelte + API:** The map interactions are smoother and the separation is cleaner. But it adds JS build tools

We defer the decision to the implementation phase.

### Views

#### 1. Area Map (Primary)

- The map shows the segment network
- Colour code by: the Dingo score, the trail type, the confidence, or a custom choice
- Filters: Mode, Condition, Dingo profile, Trail type, Visibility, Confidence
- POIs show as icons
- The map shows the area boundary. The sidebar shows the parent/child areas
- Optional layer: a photo density heatmap

#### 2. Segment/Ride List (RHS Panel)

A retractable panel on the right side:

- Toggle: Segments / Rides
- Search: a text filter (name, tags, what3words) + natural language
- Filters: the same as the map
- Sort by: name, length, Dingo score, last ridden, run count
- Table columns (segments): Name, length, trail type, Dingo score, confidence, last ridden
- Table columns (rides): Date, name, distance, duration, area
- A row click: pan the map, open the inspector
- Multi-select: bulk hide, tag, add to a route
- Export the selection

#### 3. Segment Inspector (Panel)

The panel opens on a segment click:

- The direction toggle (A→B / B→A)
- The stats table: the time range, speed, HR, stop time
- The Dingo scores for each profile
- The trail type, surface, tags
- A wet vs dry comparison
- The run history (a list of the rides that traversed the segment)
- **Photos tab:** a grid of the linked photos with labels
- A notes field (editable)
- The visibility toggle

#### 4. Route Builder

- Click segments to add them to the route
- Drag to change the order
- The direction is auto-selected, with a manual override
- Running totals: distance, elevation, estimated time
- The Dingo score for the route (aggregate, weighted by length)
- Warnings: hidden segments, low confidence, wet-sensitive
- Optimiser (future): "build me a 3-hour loop from here, maximise flow"
- The export button: a format picker, a folder path, a preview of the auto-generated name

#### 5. Ride Timeline

- A calendar or a list of past rides
- Click to replay a ride on the map (animated or with a scrubber)
- Compare runs: the same segment, different dates
- Seasonal patterns: wet vs dry behaviour
- **Photo markers along the route**

#### 6. POI Manager

- List the POIs in an area, filter by type
- Click to find a POI on the map
- Add/edit/delete
- Bulk import from a file
- **A photo column shows the related photo if there is one**

#### 7. Area Manager

- A tree view of the area hierarchy
- Create a new area: draw a polygon or accept a suggestion
- Edit the boundary, rename, change the parent
- A stats summary for each area (photo count included)

#### 8. Photo Review Panel

- A grid of the photos linked to the selected segment or ride
- Filter by: run date, condition, lighting
- Click a photo: it expands with the labels; confirm/edit/reject
- Quick actions: "Mark as POI", "Edit labels"

#### 9. POI Suggestions Queue

- A list of the pending suggestions, in groups by ride or by area
- Each card shows: the thumbnail, the suggested type, the confidence, the location on a mini-map
- Actions: Accept, Reject, Merge with an existing POI
- Bulk actions: accept all with high confidence, reject all with low confidence

#### 10. Photo Search

- A natural language search bar: "rocky single track near Glasshouse"
- The results show a photo grid with the segment context
- Click to go to the segment on the map

---

## Riding Modes

Three primary modes (views over the same segment network):

### Adventure Bike (ADV)

- Long A→B rides or full-day rides
- Sealed roads can be highly rewarding
- Slogs get a heavy penalty
- The dawn/dusk/night periods change the expected pace (animal danger)

### Enduro

- 2–4 hour local loops
- Flow, technical challenge, and directionality matter most
- Wet conditions can radically change the feasibility

### eBike

- Similar to enduro
- The effort and climb penalties differ
- Battery constraints can apply later

---

## Conditions

Coarse buckets:

- **dry**
- **wet**
- **unknown**

The system computes the statistics, the feasibility, and the Dingo scores for each condition.

Condition assignment: a manual tag on the ride, an inference from the weather API (captured at enrichment), or a confirmation from photo labels.

---

## Design Principles

1. **Segments are truth** — not GPX files
2. **Direction matters** — many trails only work one way
3. **Conditions matter** — wet changes everything
4. **History is valuable** — keep it and replay it
5. **Dingo score is personal** — computed with profiles, not absolute
6. **Local-first** — your data, your machine
7. **Simple > clever** — deterministic, explainable
8. **Photos enrich** — visual evidence supports segment knowledge

---

## MVP Build Order

> **Note:** The user now creates segments in the UI. The system does not build the graph automatically.
> See [2025-12-29-ui-specification.md](./2025-12-29-ui-specification.md) for the full UI design.

### Phase 1: Core Pipeline (Complete)

1. ✅ GPX/FIT ingest → raw files + metadata
2. ✅ Ride cleaning + time series
3. ✅ Context enrichment (weather + solar)
4. ✅ Area resolution (manual creation)
5. ✅ Basic stats aggregation

### Phase 2: UI Foundation (Current)

6. A backend API (Axum) for rides, segments, routes
7. Multi-resolution geometry (z10, z14, full)
8. A three-pane layout (List, Map, Detail)
9. MapLibre + Deck.gl map rendering
10. Lasso selection + GPU picking

### Phase 3: User-Defined Segments

11. Segment creation from selected runs
12. A consensus geometry algorithm
13. Start/end point marks with snap-to-run
14. Run ↔ Segment association management

### Phase 4: Route Planning

15. Route creation from segments
16. Valhalla bridge routing (OSM data)
17. Waypoint edits for bridges
18. Time estimates from historical runs

### Phase 5: Photos Foundation

12. Google Photos OAuth + fetch
13. Photo → segment matching

### Phase 3: ML Bootstrap

14. Cloud ML inference (bootstrap labels)
15. The POI suggestion flow + the review UI

### Phase 4: Search & Discovery

16. Vector DB photo embeddings
17. The photo search UI

### Phase 5: Local ML

18. The training pipeline + export
19. Local model fine-tuning

---

## Future Enhancements

- Variance-based confidence (not only the run count)
- Trail type inference from geometry + speed patterns
- Recurring stop detection → automatic POI creation
- A route optimiser ("maximise flow, 3 hour budget")
- User-specific Dingo profiles, refined from ratings and repeat ride patterns
- Area pack sharing (export/import with friends)
- Video support from Google Photos
- Multi-user photo contributions (crew rides)

---

## Summary

Dingo is not a GPX manager.

It is a **personal trail knowledge system** that:

- Learns from your rides
- Keeps hard-won local knowledge
- Enriches segments with photo evidence
- Discovers POIs automatically from your images
- Lets you plan rides that make *your* Dingo score as high as possible

This document defines the foundation. Everything else is iteration.
