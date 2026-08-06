# Dingo Design Document

*A local-first, segment-centric trail knowledge system for off-road riding*

---

## Overview

Dingo turns raw ride history into a maintained, directed trail network with rich metadata, run history, and personalised Dingo scores. The system is designed for individual riders and small crews, not public sharing.

Segments—not GPX files—are the source of truth. Direction, conditions, and riding mode all affect how a trail behaves and how rewarding it is to ride.

---

## Goals

### Primary Goals

- Maintain a personal trail library across known riding areas
- Treat segments (not GPX files) as the source of truth
- Support direction-specific, condition-specific, and mode-specific behaviour
- Enable ride planning that optimises for your Dingo score
- Preserve ride history as a time-series for replay and analysis
- Enrich segments with photo evidence for conditions, obstacles, and POI discovery

### Non-Goals (Initially)

- Public/global GPX sharing
- Real-time navigation or turn-by-turn routing
- Full ML/black-box recommendation systems

---

## Core Architecture

Dingo is a Rust workspace with a hybrid runtime: a long-running daemon for interactive queries, and CLI binaries for batch processing. Both share a common library layer.

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
| Ingest, cleaning, enrichment, stats | CLI | Parallelisable, no latency requirement |
| Photo fetch, ML inference | CLI | Batch processing, can be resource intensive |

### Event Coordination

- **Postgres LISTEN/NOTIFY** for daemon reactivity
- **File watcher (inotify)** triggers CLI ingest for batch drops
- **Outbox table** for multi-step workflows (ingest → clean → enrich → match → stats → photos)

---

## Data Model

### Core Entities

| Entity | Purpose |
|--------|---------|
| **areas** | Named riding region, hierarchical, user-confirmed boundary polygon |
| **files** | Raw source file metadata + SHA256 hash (bytes in file store) |
| **rides** | Timestamped recording: cleaned geometry, time series, sensor data, weather context |
| **routes** | Geometry-only input (no timestamps), contributes to segment discovery |
| **segments** | Undirected trail identity, stable UUID, current geometry hash |
| **segment_dirs** | Directed edge (A→B or B→A), holds direction-specific properties |
| **runs** | One traversal of a directed segment by a ride. Includes `out_and_back_reason` enum when applicable. |
| **pois** | Point of interest: freestanding or segment-bound |
| **segment_dir_stats** | Aggregated stats per (direction, mode, condition) |
| **segment_dir_dingo_score** | Dingo score per (direction, mode, condition, profile) |
| **photos** | Photo metadata, segment/run link, storage paths |
| **photo_labels** | ML-detected attributes as label/value pairs with confidence |
| **poi_suggestions** | Pending POI candidates from photos, awaiting user review |
| **ml_training_queue** | User corrections queued for model retraining |
| **rematch_queue** | Rides pending re-matching after segment topology changes (split/merge), with priority |

### Segment Identity

Segments use content-addressable versioning with stable UUIDs:

- **segment_id** — stable UUID, survives geometry refinement
- **geometry_hash** — SHA256 of canonical linestring, tracks versions
- **name** — what3words from start point (default), user can override
- On split: delete old segment, create new ones, queue affected rides for background re-matching

### Segment Visibility

| Visibility | Meaning |
|------------|---------|
| visible | Normal segment, shown in UI, used in routing |
| hidden | Exists but excluded from UI/routing by default |
| unreviewed | System-detected anomaly (e.g., out-and-back), awaiting user decision |

### Vector Search

Segment descriptions, tags, derived features, and photo descriptions are embedded in LanceDB for semantic search. Indexed by segment_dir UUID and photo UUID. Daemon queries Postgres for structured filters, LanceDB for natural language matching (e.g., "find me something technical near Beerburrum" or "muddy single track with water crossing"). Both co-located, no external services.

**Recency Boost:** Photo search results are ranked with a time decay multiplier on similarity score. Recent photos rank higher, but older results still appear for rarely-ridden segments. Decay function configurable (default: exponential decay with 12-month half-life).

---

## Ingest & Cleaning Pipeline

### Supported Formats

FIT is preferred for Garmin (source format with full sensor fidelity). GPX is fallback.

| Format | Notes |
|--------|-------|
| FIT | Garmin native, preferred, full sensor data |
| GPX | Standard, rides + routes |
| KML/KMZ | Google Earth, often routes/POIs |
| GeoJSON | Programmatic imports |
| TCX | Older Garmin, some watches |

### FIT File Import (Detailed)

FIT is the preferred format for Garmin devices—it preserves full sensor fidelity unlike GPX exports.

**Parser:** `fit-rs` (most complete Rust FIT implementation, exposes raw records)

**Data Flow:**
```
FIT file → fit-rs → ParsedSession → rides table
```

**ParsedSession fields:**

| Field | Type | Description |
|-------|------|-------------|
| `geometry` | `Vec<Coordinate>` | GPS track (semicircles → degrees at boundary) |
| `timestamps` | `Vec<DateTime<Utc>>` | Master time index (FIT epoch → UTC at boundary) |
| `heart_rate` | `Vec<Option<u16>>` | Aligned to timestamps, NULL for missing |
| `cadence` | `Vec<Option<u16>>` | Aligned to timestamps |
| `power` | `Vec<Option<u16>>` | Aligned to timestamps |
| `temperature` | `Vec<Option<f32>>` | Aligned to timestamps |
| `altitude` | `Vec<Option<f32>>` | Enhanced altitude |
| `speed` | `Vec<Option<f32>>` | Enhanced speed |
| `sport` | `Option<String>` | Original FIT sport field |
| `sub_sport` | `Option<String>` | Original FIT sub_sport field |
| `device` | `DeviceInfo` | Manufacturer, product, serial, firmware |
| `sensor_data` | `JSON` | Overflow: developer fields, device extensions |

**Multi-session handling:** One ride per session (matches multi-track GPX behaviour)

**Error Handling:**

| Scenario | Behaviour |
|----------|-----------|
| Valid file, all sessions parsed | `status = Complete`, insert all rides |
| Parse errors but some sessions recovered | `status = Partial`, insert valid rides, log errors |
| No usable data | Quarantine to `files/quarantine/{sha256}.fit`, insert `files` row with `status = quarantine` |

**Coordinate conversion:** Semicircles → degrees in ingest layer (lossless, downstream expects degrees)

**Timestamp conversion:** FIT epoch → UTC in ingest layer (encoding detail, not meaningful data)

**Array Alignment:** FIT records don't guarantee all fields at every timestamp. Approach:

- Timestamp array is master index
- All sensor arrays same length as timestamps
- Missing values → `NULL` at that index

### Garmin Export Zip Handling

**Trigger:** `dingo ingest <path>` where path is a `.zip` file

**Detection flow:**

1. Open zip, inspect structure
2. If contains `DI_CONNECT/DI-Connect-Fitness-Uploaded-Files/` or `DI_CONNECT/DI-Connect-Uploaded-Files/` → Garmin GDPR export
3. Otherwise → generic zip (extract, recurse on contents)

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

1. Iterate nested zips in `DI-Connect-*-Uploaded-Files/`
2. For each nested zip: extract inner FIT file, check `*_ACTIVITY.fit` pattern
3. Pass to FIT parser, normal ingest flow (dedup by SHA256, insert rides, emit events)

**File filtering:**

| File type | Action |
|-----------|--------|
| `*_ACTIVITY.fit` | Process |
| `*_WELLNESS.fit` | Skip (log) |
| `*_SLEEP.fit` | Skip (log) |
| Other | Skip (log) |

**Progress reporting:** For large exports, emit progress: "Processing 142/847 activities..."

### Ingest Process

CLI command: `dingo ingest <path>`

1. Check path: file, directory, or zip
2. For zip: detect Garmin export vs generic zip, process accordingly
3. For files: detect format via magic bytes, parse to internal representation
4. Store raw file in `files/{sha256}.{ext}`
5. Determine type: timestamps → Ride, no timestamps → Route
6. Multi-track/session files: each track/session processed and named independently
7. For FIT: extract sensor arrays, align to master timestamp index
8. Emit event: `ride_ingested` or `route_ingested`

### Cleaning Process

Rides only. Routes skip cleaning—geometry used as-is.

1. Remove GPS jitter (Kalman filter or similar)
2. Simplify points (Ramer-Douglas-Peucker, preserve detail)
3. Detect stops vs technical slow:
   - Primary: speed + positional variance in sliding window
   - Secondary: HR delta from rolling baseline (when available)
   - Stop = low speed AND low variance AND HR dropping AND duration > threshold
4. Split at significant pauses (optional, configurable)
5. Generate ride name using naming convention (see Export section)
6. Emit event: `ride_cleaned`

### Context Enrichment

Runs after cleaning, before graph matching. Captures external context that cannot be derived from GPS data alone.

**Trigger:** `ride_cleaned` event

**Process:**

1. Fetch historical weather from Open-Meteo API using ride start timestamp + location
2. Calculate solar position from timestamp + coordinates

**Weather Fields (stored on Ride):**

| Field | Description |
|-------|-------------|
| `precip_last_24h` | mm of rain in prior 24 hours |
| `precip_last_48h` | mm of rain in prior 48 hours (ground saturation) |
| `temp_max` | °C at location on ride date |
| `temp_min` | °C at location on ride date |
| `inferred_condition` | dry / wet / unknown, derived from precipitation thresholds |
| `condition_confidence` | low / medium / high, based on data completeness |

**Solar Fields (stored on Ride):**

| Field | Description |
|-------|-------------|
| `time_of_day` | day / dawn / dusk / night, derived from solar position at ride start |

Dawn and dusk periods are significant for ADV riding—animal activity increases danger and forces slower progress on otherwise fast segments.

**Why capture at ingest:** Backfilling weather data later requires re-querying APIs for historical data. Capturing on ingest is simpler and more reliable.

**Emit event:** `ride_enriched`

### Preservation

Raw files never modified, always re-derivable. Cleaning logic versioned—can replay if algorithm improves.

---

## Segment Graph Building

### Trigger

`ride_enriched` or `route_ingested` event, or manual rebuild via `dingo graph rebuild --area <id>`

### Process

1. Load cleaned ride/route geometry
2. Snap to spatial grid (configurable precision, e.g., 1m)
3. Compare against existing segments in the area
4. Outcomes: Match (overlap existing), New (no overlap), Fork (partial overlap, split needed)

### Segment Creation

1. Generate stable UUID
2. Compute canonical linestring (consistent direction: lower lat/lng endpoint first)
3. Hash geometry → geometry_hash
4. Create two segment_dirs (A→B, B→A)
5. Extract per-direction properties: length, elevation gain/loss, average grade

### Segment Splitting

When a new ride reveals a fork mid-segment:

1. Delete old segment (cascades to segment_dirs)
2. Create two new segments with new UUIDs
3. Queue affected rides in `rematch_queue` with reason `topology_change`
4. Background worker processes queue in priority order
5. Old stats cached on runs until re-matched (lazy re-evaluation)

This lazy re-evaluation strategy ensures the UI remains responsive even when topology changes affect many historic rides.

### Out-and-Back Detection

When ride crosses same geometry twice in opposite directions:

- Creates separate segment(s)
- If terminus near POI → mark **visible**, set `out_and_back_reason = poi_detour`
- If terminus has high grade AND speed dropped to near-zero before reversing → mark **visible**, set `out_and_back_reason = attempted_climb`
- Otherwise → mark **unreviewed**, set `out_and_back_reason = unknown`

**out_and_back_reason enum:**

| Value | Meaning |
|-------|---------|
| `poi_detour` | Terminus near a known POI |
| `attempted_climb` | High grade + stall detected at terminus |
| `unknown` | No heuristic matched, awaiting user review |

The `attempted_climb` heuristic captures valuable metadata—"this hill stops people"—useful for route planning.

### Tolerances

- Snap tolerance: ~5m (GPS accuracy)
- Overlap threshold: 80% shared length to count as "same segment"
- Configurable per area (tighter for dense trail networks)

---

## Run Matching

### Trigger

`ride_enriched` event, or manual via `dingo match --ride <id>` or `dingo match --area <id>`

### Process

1. Load cleaned ride geometry + time series
2. Load segment network for the ride's area(s)
3. Walk ride point-by-point, snap to nearest segment, track transitions
4. Record direction of travel (A→B or B→A)
5. For each traversal, extract run with timing, speed, HR summary
6. Emit event: `runs_matched`

### Run Data Captured

| Field | Description |
|-------|-------------|
| `start_time`, `end_time` | When traversal began and ended |
| `elapsed_s` | Total time including stops (seconds) |
| `stopped_s` | Time spent stationary (seconds) |
| `moving_s` | Time in motion (elapsed - stopped) |
| `speed_avg` | Average speed (m/s) |
| `speed_max` | Maximum speed (m/s) |
| `speed_variance` | Speed variance (consistency metric) |
| `hr_avg` | Average heart rate (when available) |
| `hr_max` | Maximum heart rate (when available) |
| `mode` | ADV / Enduro / eBike |
| `condition` | Dry / Wet / Unknown |
| `out_and_back_reason` | `poi_detour`, `attempted_climb`, or `unknown` (when applicable) |


### Edge Cases

- Ride crosses unmapped area → geometry logged, no runs, flagged for review
- GPS drift (< 20m off-segment for < 5 seconds) → bridge it
- Ride reverses mid-segment → two runs, one per direction

---

## Photo Enrichment Pipeline

### Overview

After segment matching, the system fetches photos from Google Photos, matches them to segments, runs ML inference for labelling, and queues POI suggestions for user review.

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

> **Update (2026-07-03):** the OAuth flow below no longer works — Google removed
> the Library API read scopes on 2025-03-31 (403 PERMISSION_DENIED); third-party
> apps can only read app-created content. Implemented instead: **Takeout import**
> (`dingo photos import <extracted-takeout-dir>`, crates/google/src/takeout.rs) —
> the JSON sidecars provide UTC timestamps, geoData, and a permanent
> photos.google.com link-out URL, which the current APIs cannot. Incremental
> imports can later use the **Picker API** (user-selects photos per session; no
> geo, no link-out URL). The fetch/auth design below is retained for reference.

**Authentication (obsolete — see update above):**

1. First run: browser opens Google OAuth consent screen
2. User grants read-only access to Google Photos
3. Refresh token stored in local config (`~/.config/dingo/google_auth.json`)
4. Daemon handles silent token refresh
5. On token expiry/revocation: fallback to browser auth, notify user

**Fetch process:**

1. Query ride's time window: `ride.start_time - 30min` to `ride.end_time + 30min`
2. Filter to images only (skip videos)
3. Check `google_photos_id` against existing photos table (skip duplicates)
4. Download medium-res version (800px) via `baseUrl=w800`
5. Generate thumbnail locally (200px)
6. Extract EXIF: timestamp, GPS, camera info
7. Store in content-addressed store: `photos/{sha256}_thumb.jpg`, `photos/{sha256}_medium.jpg`

**Rate limiting:**

- Google Photos API: 10,000 requests/day
- Batch fetches, respect quotas
- Queue large imports, process incrementally

### Photo-to-Segment Matching

**Matching priority:**

1. **GPS match (preferred):** Photo has EXIF GPS → snap to nearest segment within 50m
2. **Timestamp match (fallback):** No GPS → interpolate position on ride timeline → inherit segment from that point

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
| Photo at junction | Attach to segment from run sequence at that timestamp; junction context captured in ml_description |
| Photo off-trail (>50m) | Store unlinked, flag for review — may indicate unmapped trail |
| Photo timestamp outside any ride | Store unlinked, available for manual association |
| Multiple rides same day | Match to ride with closest time window |

### Photo Storage

**Three tiers:**

| Tier | Size | Storage | Purpose |
|------|------|---------|---------|
| Thumbnail | ~200px, <20KB | Local | List views, quick loading |
| Medium | ~800px, ~50-100KB | Local | Inspector, condition identification |
| Original | Full resolution | Google Photos URL | View original on demand |

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
| photo_id | UUID | Stable identifier |
| google_photos_id | String | Original source reference |
| google_photos_url | String | Link to full-res original |
| run_id | UUID (nullable) | Matched run |
| segment_dir_id | UUID (nullable) | Matched segment direction |
| poi_id | UUID (nullable) | Associated POI if photo depicts one |
| captured_at | Timestamp | EXIF timestamp |
| location | Point (nullable) | EXIF GPS if available |
| match_method | Enum | `gps`, `timestamp`, `manual` |
| thumbnail_path | String | ~200px version |
| medium_path | String | ~800px version |
| ml_description | Text | Natural language description for vector DB |
| ml_confidence | Float | Overall inference confidence |
| user_reviewed | Boolean | Has user confirmed/corrected |
| created_at | Timestamp | |

**photo_labels table:**

| Field | Type | Description |
|-------|------|-------------|
| label_id | UUID | |
| photo_id | UUID | FK to photos |
| label_type | String | Category: `surface`, `trail_type`, `obstacle`, `condition`, `lighting`, `infrastructure`, `vegetation` |
| label_value | String | Detected value: `mud`, `single_track`, `gate`, `wet`, etc. |
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

1. Run local model first
2. If `confidence < 0.7` → flag for cloud fallback
3. Cloud fallback runs if enabled and quota available
4. If both low confidence → queue for user review

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

1. **Cloud API bootstrap:** Process first 500-1000 photos via Claude Vision with domain-specific prompts
2. **Initial training:** Train local model on cloud-generated labels
3. **Deploy local:** Use local model for all new photos
4. **Cloud fallback:** Route low-confidence images to cloud API
5. **Continuous learning:** User corrections feed training queue
6. **Periodic retrain:** Weekly or monthly model updates

---

## POI Suggestion Flow

### Trigger

After ML inference, if labels contain infrastructure, obstacle, or notable features → create `poi_suggestion` record.

### poi_suggestions table

| Field | Type | Description |
|-------|------|-------------|
| suggestion_id | UUID | |
| photo_id | UUID | Source photo |
| segment_dir_id | UUID | Where on the network |
| location | Point | Suggested POI location |
| suggested_type | String | POI category: `infrastructure`, `hazard`, `navigation` |
| suggested_subtype | String | Specific: `gate`, `log`, `junction` |
| ml_description | Text | Why ML thinks this is a POI |
| confidence | Float | ML confidence |
| status | Enum | `pending`, `accepted`, `rejected`, `merged` |
| reviewed_at | Timestamp (nullable) | |
| created_poi_id | UUID (nullable) | If accepted, link to created POI |
| created_at | Timestamp | |

### Suggestion Rules

| Label detected | Suggested POI type |
|----------------|-------------------|
| gate, fence, sign | infrastructure |
| log, washout, rocks, water_crossing | hazard |
| junction (inferred from multiple segments nearby) | navigation |
| bridge, culvert | infrastructure |

### User Review Flow

1. UI shows pending suggestions grouped by ride or area
2. User can: Accept (creates POI), Reject, Merge (link to existing POI)
3. Accept/Reject feeds `ml_training_queue` with `source = user`
4. Merged suggestions help deduplicate (same gate photographed on multiple rides)

### Deduplication

Before creating suggestion, check for existing POI within 20m of same type. If found → auto-suggest merge instead of new POI.

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
| photo_id | UUID | Source photo |
| label_type | String | What was corrected |
| original_value | String (nullable) | ML prediction |
| corrected_value | String | User's correction |
| action | Enum | `confirm`, `correct`, `reject` |
| created_at | Timestamp | |
| exported_at | Timestamp (nullable) | When included in training export |

### Training Triggers

| Trigger | Action |
|---------|--------|
| POI suggestion accepted | `confirm` for detected labels |
| POI suggestion rejected | `reject` for detected labels |
| User edits photo label | `correct` with original + new value |
| User adds label | `correct` with original = null |

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
| `segment_embeddings` | segment_dir_id | Segment descriptions, tags, features |
| `photo_embeddings` | photo_id | ML-generated description + labels |

### Photo Embedding Content

Concatenate into single text block:

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
| "muddy single track" | Photos/segments with wet + single_track labels |
| "gate near Beerburrum" | Infrastructure POIs + spatial filter |
| "technical rocky descent" | High rock/erosion labels + downhill segments |
| "water crossing" | Obstacle label + associated photos |

### Segment Enrichment

Segment descriptions in vector DB can aggregate from linked photos:

- Most common surface across photos
- Condition variation (wet vs dry appearances)
- Notable features (gates, crossings)

---

## Stats Aggregation & Dingo Scoring

### Stats Per (segment_dir, mode, condition)

| Stat | Description |
|------|-------------|
| run_count | Total traversals |
| time_min/max/median | Fastest, slowest, typical run times |
| time_stddev | Consistency measure |
| speed_avg | Average speed across runs |
| stop_time_avg | Average stopped time |
| hr_avg, hr_max | Heart rate averages (when available) |

### Confidence Tiers

| Tier | Criteria |
|------|----------|
| unridden | 0 runs, geometry only |
| provisional | 1-2 runs, stats exist but high variance |
| confident | 3+ runs, stats stable enough to trust |

*Future enhancement: variance-based confidence (confident when stddev stabilises, regardless of count).*

### Trail Type

| Type | Description |
|------|-------------|
| sealed | Paved road, tarmac |
| dirt_road | Unsealed road, graded |
| fire_trail | Wide track, typically 4WD accessible |
| single_track | Narrow trail, single file |
| technical | Rocky, rooty, challenging terrain |

Source: user-tagged (primary), inferred from photo labels, inferred from geometry + speed patterns (future), or imported from external data (e.g., OSM).

### Feature Extraction

| Feature | Source | Notes |
|---------|--------|-------|
| length | Geometry | |
| elevation_gain/loss | Geometry | Per direction |
| avg/max_grade | Geometry | |
| twistiness | Geometry | Bearing change per meter |
| pace_vs_shape | Stats vs geometry | Slow for shape = technical |
| stop_density | Stats | Stops per km |
| hr_intensity | Stats | HR vs baseline |
| surface_type | Photos | Aggregated from photo_labels |
| obstacle_density | Photos | Count of obstacle labels per km |

### Dingo Profiles

Dingo score is computed per (segment_dir, mode, condition, dingo_profile). Score = weighted sum of normalised features, 0-100 scale.

| Profile | Weights |
|---------|---------|
| **flow** | High: speed, twistiness. Low: stops, elevation gain |
| **tech** | High: pace_vs_shape, hr_intensity. Low: speed |
| **scenic** | High: low stress. Low: stop_density, elevation gain |
| **efficient** | High: speed. Penalise: stops, gates, overgrown (tags) |

### Slog Detection

- **Technical slow:** low speed + high hr_intensity + continuous movement
- **Bad slow (slog):** low speed + low HR + high stop_density + negative tags

Slogs are penalised in all profiles except tech.

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

- poi_id (stable UUID), area_id, type, subtype
- geometry (point location)
- Optional: segment_dir_id + distance_along (when segment-bound)
- name, notes, tags (flexible key-value)
- photo_id (optional, source photo if created from suggestion)

Sources: extracted from imported routes, user-created, detected from ride patterns, ML-suggested from photos.

---

## Areas

### Area Structure

Areas are hierarchical. Child area boundary must be contained within parent.

| Field | Description |
|-------|-------------|
| area_id | Stable UUID |
| parent_id | Optional parent area UUID (null = top-level) |
| name | Display name |
| boundary | Polygon geometry |
| mode_affinity | Primary modes: ADV, Enduro, eBike, or mixed |

### Area Creation Flow

1. **Auto-suggest:** System clusters ride density using DBSCAN
2. **User confirms:** Accepts suggested boundary or draws custom polygon
3. Segment assigned to most specific (deepest) containing area

### Area Statistics (Derived)

- total_km, segment_count, run_count
- coverage (% with confident stats)
- photo_count
- last_ridden

---

## Routes & Export

### Routes as Input

Routes are geometry-only imports (no timestamps) that contribute to segment discovery.

Fields: route_id, file_hash, name, source, area_id, geometry, imported_at.

On ingest: geometry fed to segment graph, POIs extracted from waypoints.

### Saved Routes (Output)

A planned route is an ordered list of `(segment_dir_id, direction)`. Geometry is derived on demand from current segment geometries—not stored separately.

### Naming Convention

| Pattern | Template |
|---------|----------|
| Loop with midpoint | `<Start> loop via <Mid> <Dist> kms <Dur> hrs on <Date> (<Orig>).gpx` |
| Loop no midpoint | `<Start> loop <Dist> kms <Dur> hrs on <Date> (<Orig>).gpx` |
| One-way | `<Start> to <End> via <Mid> <Dist> kms <Dur> hrs on <Date> (<Orig>).gpx` |

**Formatting:**
- Distance = integer km
- Duration = 1 decimal if <10h, else integer
- Date = YYYY-MM-DD

Locality resolved via reverse geocode (embedded gazetteer or API, cached).

The naming pass also fills per-ride locality attributes: `suburbs` and `lgas`
(ALL localities the track passes through, nearest-locality sampled ~every km,
first-encounter order), `state` (majority over samples), and `region` (curated
colloquial regions — not a formal AU admin level — mapped from (state, LGA) in
`data/lga-regions-au.tsv`, loaded via `dingo gazetteer load-regions`).

### Export Formats

CLI: `dingo export route <id> --format <fmt>`

| Format | Use Case |
|--------|----------|
| GPX | Universal (Garmin, Locus, etc.) |
| FIT | Garmin devices (course) |
| KML | Google Earth, sharing |
| GeoJSON | Programmatic use |

### Folder Structure for Sync

Export target includes folder path mirroring area hierarchy.

Example: `/Tracks/North NSW/Beerburrum State Forest/<filename>.gpx`

---

## Daemon & CLI Interface

### Daemon (dingo-daemon)

Long-running process for interactive queries:

- Query serving: segment lookup, stats, Dingo scores, route building
- Event subscription: LISTEN/NOTIFY on Postgres events table
- Semantic search: LanceDB queries for natural language matching (segments + photos)
- Photo serving: thumbnails and medium images to UI
- OAuth management: Google Photos token refresh
- ML routing: local vs cloud inference decisions
- WebSocket/HTTP API for frontend UI

### CLI Commands (dingo)

| Command | Description |
|---------|-------------|
| `dingo ingest <path>` | Import file or watch folder |
| `dingo clean --ride <id>` | Re-clean a ride |
| `dingo enrich --ride <id>` | Re-run context enrichment (weather, solar) |
| `dingo graph rebuild --area <id>` | Rebuild segment network |
| `dingo match --ride/--area <id>` | Rematch rides to segments |
| `dingo stats rebuild --area <id>` | Recompute stats and Dingo scores |
| `dingo export route <id> --format <fmt>` | Export saved route |
| `dingo export area <id> --format <fmt>` | Export all segments/POIs in area |
| `dingo sync locus --push/--pull` | Sync with Locus app |
| `dingo area suggest` | Run DBSCAN, suggest new areas |
| `dingo area create --name <n> --parent <id>` | Create area from drawn boundary |
| `dingo segment hide/show <id>` | Toggle segment visibility |
| `dingo poi add --type <t> --location <lat,lng>` | Add freestanding POI |
| `dingo photos fetch --ride <id>` | Fetch photos for a ride from Google Photos |
| `dingo photos fetch --area <id>` | Fetch photos for all rides in area |
| `dingo photos match --ride <id>` | Re-run segment matching for ride's photos |
| `dingo photos analyse --ride <id>` | Re-run ML inference on ride's photos |
| `dingo photos review` | Open UI to pending POI suggestions |
| `dingo ml export` | Export training queue to dataset |
| `dingo ml status` | Show model version, training queue size, cloud quota |
| `dingo auth google` | Run OAuth flow for Google Photos |
| `dingo queue status` | Show rematch queue size and progress |
| `dingo queue process` | Manually trigger background rematch processing |

**Common flags:** `--area <id>`, `--dry-run`, `--verbose`, `--format <fmt>`

### Event Flow

| Event | Trigger | Action |
|-------|---------|--------|
| `ride_ingested` | File import | Queue cleaning |
| `ride_cleaned` | Cleaning complete | Queue enrichment |
| `ride_enriched` | Enrichment complete | Queue graph + matching |
| `runs_matched` | Matching complete | Queue photo fetch |
| `photos_fetched` | Google Photos download | Queue ML inference |
| `photos_analysed` | ML complete | Create POI suggestions, update vector DB |
| `poi_suggestion_reviewed` | User accepts/rejects | Update training queue |
| `topology_changed` | Segment split/merge | Queue affected rides in rematch_queue |

---

## User Interface

### Stack

Embedded web UI served by daemon. Local-first, no external hosting.

| Component | Choice |
|-----------|--------|
| Frontend | HTMX + Tera templates (SSR), or lightweight JS framework (Svelte) + Rust API |
| Map | MapLibre GL (open source, vector tiles) |
| Served by | Daemon on localhost |

**Trade-offs:**

- **HTMX + Tera:** Logic stays in Rust, minimal frontend complexity, but MapLibre requires JS interop regardless
- **Svelte + API:** Smoother map interactions, cleaner separation, but adds JS build tooling

Decision deferred to implementation phase.

### Views

#### 1. Area Map (Primary)

- Segment network rendered on map
- Colour-coded by: Dingo score, trail type, confidence, or custom
- Filters: Mode, Condition, Dingo profile, Trail type, Visibility, Confidence
- POIs displayed as icons
- Area boundary shown, parent/child areas in sidebar
- Optional layer: photo density heatmap

#### 2. Segment/Ride List (RHS Panel)

Retractable panel on right side:

- Toggle: Segments / Rides
- Search: text filter (name, tags, what3words) + natural language
- Filters: same as map
- Sort by: name, length, Dingo score, last ridden, run count
- Table columns (segments): Name, length, trail type, Dingo score, confidence, last ridden
- Table columns (rides): Date, name, distance, duration, area
- Row click: pan map, open inspector
- Multi-select: bulk hide, tag, add to route
- Export selection

#### 3. Segment Inspector (Panel)

Opens on segment click:

- Direction toggle (A→B / B→A)
- Stats table: time range, speed, HR, stop time
- Dingo scores per profile
- Trail type, surface, tags
- Wet vs dry comparison
- Run history (list of rides that traversed)
- **Photos tab:** grid of linked photos with labels
- Notes field (editable)
- Visibility toggle

#### 4. Route Builder

- Click segments to add to route
- Drag to reorder
- Direction auto-selected, manual override
- Running totals: distance, elevation, estimated time
- Dingo score for route (aggregate, weighted by length)
- Warnings: hidden segments, low confidence, wet-sensitive
- Optimiser (future): "build me a 3-hour loop from here, maximise flow"
- Export button: format picker, folder path, auto-generated name preview

#### 5. Ride Timeline

- Calendar or list of past rides
- Click to replay on map (animated or scrubber)
- Compare runs: same segment, different dates
- Seasonal patterns: wet vs dry behaviour
- **Photo markers along the route**

#### 6. POI Manager

- List POIs in area, filter by type
- Click to locate on map
- Add/edit/delete
- Bulk import from file
- **Photo column showing associated photo if any**

#### 7. Area Manager

- Tree view of area hierarchy
- Create new area: draw polygon or accept suggestion
- Edit boundary, rename, reassign parent
- Stats summary per area (including photo count)

#### 8. Photo Review Panel

- Grid of photos linked to selected segment or ride
- Filter by: run date, condition, lighting
- Click photo: expand with labels, confirm/edit/reject
- Quick actions: "Mark as POI", "Edit labels"

#### 9. POI Suggestions Queue

- List of pending suggestions, grouped by ride or area
- Each card shows: thumbnail, suggested type, confidence, location on mini-map
- Actions: Accept, Reject, Merge with existing POI
- Bulk actions: accept all high-confidence, reject all low-confidence

#### 10. Photo Search

- Natural language search bar: "rocky single track near Glasshouse"
- Results show photo grid with segment context
- Click to navigate to segment on map

---

## Riding Modes

Three primary modes (views over the same segment network):

### Adventure Bike (ADV)

- Long A→B or full-day rides
- Sealed roads can be highly rewarding
- Slogs heavily penalised
- Dawn/dusk/night periods affect expected pace (animal danger)

### Enduro

- 2–4 hour local loops
- Flow, technical challenge, directionality matter most
- Wet conditions can radically change feasibility

### eBike

- Similar to enduro
- Effort and climb penalties differ
- Battery constraints may apply later

---

## Conditions

Coarse buckets:

- **dry**
- **wet**
- **unknown**

Statistics, feasibility, and Dingo scores are computed per condition.

Condition assignment: manual tag on ride, inferred via weather API (captured at enrichment), or corroborated by photo labels.

---

## Design Principles

1. **Segments are truth** — not GPX files
2. **Direction matters** — many trails only work one way
3. **Conditions matter** — wet changes everything
4. **History is valuable** — preserve and replay
5. **Dingo score is personal** — computed via profiles, not absolute
6. **Local-first** — your data, your machine
7. **Simple > clever** — deterministic, explainable
8. **Photos enrich** — visual evidence supports segment knowledge

---

## MVP Build Order

> **Note:** Segment creation is now user-driven via UI, not automatic graph building.
> See [2025-12-29-ui-specification.md](./2025-12-29-ui-specification.md) for full UI design.

### Phase 1: Core Pipeline (Complete)

1. ✅ GPX/FIT ingest → raw files + metadata
2. ✅ Ride cleaning + time series
3. ✅ Context enrichment (weather + solar)
4. ✅ Area resolution (manual creation)
5. ✅ Basic stats aggregation

### Phase 2: UI Foundation (Current)

6. Backend API (Axum) for rides, segments, routes
7. Multi-resolution geometry (z10, z14, full)
8. Three-pane layout (List, Map, Detail)
9. MapLibre + Deck.gl map rendering
10. Lasso selection + GPU picking

### Phase 3: User-Defined Segments

11. Segment creation from selected runs
12. Consensus geometry algorithm
13. Start/end point marking with snap-to-run
14. Run ↔ Segment association management

### Phase 4: Route Planning

15. Route creation from segments
16. Valhalla bridge routing (OSM data)
17. Waypoint editing for bridges
18. Time estimates from historical runs

### Phase 5: Photos Foundation

12. Google Photos OAuth + fetch
13. Photo → segment matching

### Phase 3: ML Bootstrap

14. Cloud ML inference (bootstrap labels)
15. POI suggestion flow + review UI

### Phase 4: Search & Discovery

16. Vector DB photo embeddings
17. Photo search UI

### Phase 5: Local ML

18. Training pipeline + export
19. Local model fine-tuning

---

## Future Enhancements

- Variance-based confidence (not just run count)
- Trail type inference from geometry + speed patterns
- Recurring stop detection → auto-POI creation
- Route optimiser ("maximise flow, 3 hour budget")
- User-specific Dingo profiles refined from ratings and repeat ride patterns
- Area pack sharing (export/import with friends)
- Video support from Google Photos
- Multi-user photo contributions (crew rides)

---

## Summary

Dingo is not a GPX manager.

It is a **personal trail knowledge system** that:

- Learns from your riding
- Preserves hard-won local knowledge
- Enriches segments with photo evidence
- Discovers POIs automatically from your images
- Lets you plan rides that maximise *your* Dingo score

This document defines the foundation. Everything else is iteration.
