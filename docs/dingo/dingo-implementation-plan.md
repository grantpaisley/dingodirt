# Dingo Implementation Plan

*Sequential, fine-grained tasks for building the trail knowledge system*

---

## How to Use This Plan

1. Work through tasks in order — each depends on previous tasks
2. Check off tasks as completed: `- [ ]` → `- [x]`
3. Each task should be completable in a single Claude Code session
4. Use real GPX/FIT files from your collection as test fixtures
5. "Done when" criteria define acceptance — don't move on until met

---

## Phase 0: Project Scaffolding

### 0.1 Repository & Workspace Setup
- [ ] Initialise git repo with .gitignore (Rust, IDE, .env)
- [ ] Create Cargo workspace with crates/ directory structure
- [ ] Add empty crates: core, geo, ingest, enrich, graph, match, stats, vision, google, daemon, cli
- [ ] Configure shared dependencies in workspace Cargo.toml

**Done when:** `cargo check` passes on empty workspace

### 0.2 Development Environment
- [ ] Create docker-compose.yml with Postgres 16 + PostGIS 3.4
- [ ] Add .env.example with DATABASE_URL template
- [ ] Create scripts/dev-db.sh for start/stop/reset
- [ ] Verify PostGIS extension loads (`SELECT PostGIS_Version()`)

**Done when:** Can connect to local PostGIS from psql

### 0.3 Database Schema Foundation
- [ ] Add sqlx as dependency, configure offline mode
- [ ] Create migrations/ directory
- [ ] Write initial migration: areas, files, rides tables
- [ ] Set up sqlx-cli for migration running

**Done when:** `sqlx migrate run` creates tables, `cargo sqlx prepare` generates query cache

### 0.4 Core Crate Types
- [ ] Define error types (thiserror)
- [ ] Define config struct (serde, figment or config-rs)
- [ ] Define shared domain types: AreaId, FileId, RideId (UUID newtypes)
- [ ] Add db module with connection pool setup

**Done when:** Other crates can import `dingo_core::{Config, Error, Result, db}`

---

## Phase 1: Core MVP

### 1.1 File Ingest Pipeline

#### 1.1.1 File Store
- [ ] Create content-addressed file store in `ingest` crate
- [ ] Implement: hash file → copy to `files/{sha256}.{ext}`
- [ ] Handle duplicates (skip if hash exists)
- [ ] Return FileId + metadata (size, hash, original name)

**Done when:** Can store a file, retrieve path by hash, skip duplicates

#### 1.1.2 Format Detection
- [ ] Detect format from magic bytes (FIT: `.FIT` header, GPX: XML with `<gpx>`)
- [ ] Support: FIT, GPX, KML, GeoJSON, TCX
- [ ] Return enum: `FileFormat::Fit | Gpx | Kml | GeoJson | Tcx | Unknown`

**Done when:** Correctly identifies format for test files of each type

#### 1.1.3 GPX Parser
- [ ] Parse GPX to internal track representation
- [ ] Extract: points (lat, lon, ele, time), name, metadata
- [ ] Handle multi-track files (return Vec<Track>)
- [ ] Determine ride vs route (timestamps present → ride)

**Done when:** Parses your real GPX test files, extracts all points with timestamps

#### 1.1.4 FIT Parser
- [ ] Add fit-rs or fitparser dependency
- [ ] Parse FIT to same internal track representation
- [ ] Extract: points, timestamps, HR, cadence, power if present
- [ ] Handle activity vs course files

**Done when:** Parses real FIT files from Garmin, extracts sensor data

#### 1.1.5 Files Table & Ride Insertion
- [ ] Write migration: files table (id, hash, format, original_name, size, imported_at)
- [ ] Write migration: rides table (id, file_id, name, started_at, raw_geometry, raw_time_series, sensor_data)
- [ ] Implement: insert file record, insert ride record with raw data
- [ ] Store geometry as PostGIS LineString, time series as JSONB

**Done when:** Ingest a GPX → file row + ride row with geometry queryable via ST_AsGeoJSON

#### 1.1.6 CLI: `dingo ingest`
- [ ] Create cli crate binary
- [ ] Implement `dingo ingest <path>` command
- [ ] Support single file or directory (non-recursive)
- [ ] Print summary: files found, imported, skipped (duplicates)

**Done when:** `dingo ingest ~/tracks/` imports all GPX/FIT files, skips dupes on re-run

---

### 1.2 Ride Cleaning

#### 1.2.1 GPS Jitter Removal
- [ ] Implement Kalman filter or similar smoothing in `geo` crate
- [ ] Configurable noise threshold (default ~5m)
- [ ] Preserve original points, output cleaned geometry

**Done when:** Noisy GPS track becomes smooth without losing genuine turns

#### 1.2.2 Point Simplification
- [ ] Implement Ramer-Douglas-Peucker algorithm
- [ ] Configurable epsilon (default: preserve detail for trail use)
- [ ] Balance: reduce points while keeping trail shape

**Done when:** Track reduced by ~30-50% points, visually identical on map

#### 1.2.3 Stop Detection
- [ ] Implement sliding window analysis: speed + positional variance
- [ ] Detect stops: low speed AND low variance AND duration > threshold (default 30s)
- [ ] Optional: HR delta from rolling baseline if sensor data present
- [ ] Output: list of stop intervals (start_idx, end_idx, duration)

**Done when:** Correctly identifies lunch stops vs slow technical sections in real rides

#### 1.2.4 Time Series Extraction
- [ ] Extract cleaned time series: timestamp, lat, lon, ele, speed, hr (if present)
- [ ] Calculate derived fields: distance_cumulative, speed_smoothed
- [ ] Store as JSONB array on ride

**Done when:** Can query ride and replay point-by-point with timing

#### 1.2.5 Rides Table Update & Cleaning Storage
- [ ] Add columns: cleaned_geometry, cleaned_time_series, stops (JSONB), cleaned_at
- [ ] Implement: update ride with cleaned data
- [ ] Track cleaning version (for replay if algorithm improves)

**Done when:** Ride row has both raw and cleaned geometry, stops identified

#### 1.2.6 CLI: `dingo clean`
- [ ] Implement `dingo clean --ride <id>` command
- [ ] Implement `dingo clean --all` for batch processing
- [ ] Print summary: points before/after, stops detected

**Done when:** `dingo clean --ride <id>` updates ride with cleaned data

---

### 1.3 Context Enrichment

#### 1.3.1 Open-Meteo Client
- [ ] Create `enrich` crate
- [ ] Implement Open-Meteo historical weather API client
- [ ] Query by: latitude, longitude, date
- [ ] Parse response: precipitation, temp_max, temp_min

**Done when:** Can fetch weather for a given location + date, returns structured data

#### 1.3.2 Weather Fields Extraction
- [ ] Extract `precip_last_24h` (day of ride)
- [ ] Extract `precip_last_48h` (day of ride + day before, summed)
- [ ] Extract `temp_max`, `temp_min` for ride date
- [ ] Handle API failures gracefully (mark as incomplete)

**Done when:** Weather struct populated for a real ride location/date

#### 1.3.3 Condition Inference
- [ ] Implement threshold logic: precip_last_48h > X mm → wet
- [ ] Configurable thresholds (default: >5mm = wet)
- [ ] Output: `inferred_condition` (dry/wet/unknown), `condition_confidence` (low/medium/high)

**Done when:** Real rides classified as dry/wet matching your memory of conditions

#### 1.3.4 Solar Position Calculation
- [ ] Implement sunrise/sunset calculation from timestamp + coordinates
- [ ] Define dawn/dusk windows (e.g., 30 min before sunrise, 30 min after sunset)
- [ ] Output: `time_of_day` enum (day/dawn/dusk/night)

**Done when:** Morning ride = dawn→day, evening ride = day→dusk, night ride = night

#### 1.3.5 Rides Table: Enrichment Columns
- [ ] Add migration: weather fields (precip_last_24h, precip_last_48h, temp_max, temp_min)
- [ ] Add migration: inferred_condition, condition_confidence, time_of_day
- [ ] Add migration: enriched_at timestamp

**Done when:** Ride row stores all enrichment fields

#### 1.3.6 CLI: `dingo enrich`
- [ ] Implement `dingo enrich --ride <id>` command
- [ ] Implement `dingo enrich --all` for batch processing
- [ ] Print summary: condition inferred, time_of_day

**Done when:** `dingo enrich --ride <id>` fetches weather + calculates solar, updates ride

---

### 1.4 Area Resolution

#### 1.4.1 Areas Table
- [ ] Add migration: areas (id, parent_id, name, boundary, mode_affinity, created_at)
- [ ] Boundary stored as PostGIS Polygon
- [ ] Add spatial index on boundary

**Done when:** Can insert area with polygon boundary, query by ST_Contains

#### 1.4.2 Area CRUD Operations
- [ ] Implement: create area with name + boundary polygon
- [ ] Implement: update area (rename, adjust boundary, change parent)
- [ ] Implement: delete area (cascade rules TBD)
- [ ] Implement: list areas (tree structure via parent_id)

**Done when:** Can create, list, update areas via core crate functions

#### 1.4.3 Ride-to-Area Assignment
- [ ] Implement: find most specific (deepest) area containing ride start point
- [ ] Handle rides spanning multiple areas (assign to start point area)
- [ ] Add area_id column to rides table
- [ ] Update ride with area assignment on ingest/clean

**Done when:** Ride auto-assigned to correct area based on start location

#### 1.4.4 CLI: `dingo area`
- [ ] Implement `dingo area create --name <n> --boundary <geojson-file>`
- [ ] Implement `dingo area list` (tree view)
- [ ] Implement `dingo area show <id>` (stats summary)

**Done when:** Can create area from GeoJSON polygon file, list shows hierarchy

---

### 1.5 Segment Graph Creation

#### 1.5.1 Segments & Segment Dirs Tables
- [ ] Add migration: segments (id, area_id, geometry_hash, name, visibility, created_at)
- [ ] Add migration: segment_dirs (id, segment_id, direction, length, elevation_gain, elevation_loss, avg_grade)
- [ ] Store segment geometry as PostGIS LineString with spatial index
- [ ] Direction enum: `a_to_b`, `b_to_a`

**Done when:** Can insert segment with two segment_dirs, query by area

#### 1.5.2 Geometry Canonicalisation
- [ ] Implement canonical direction: lower lat/lng endpoint first
- [ ] Implement geometry hashing: SHA256 of WKB representation
- [ ] Ensure consistent direction regardless of input order

**Done when:** Same trail ridden in opposite directions produces same geometry_hash

#### 1.5.3 Spatial Grid Snapping
- [ ] Implement point snapping to configurable grid (default ~1m)
- [ ] Snap cleaned ride geometry before comparison
- [ ] Reduces false "new segment" detections from GPS variance

**Done when:** Two rides on same trail snap to identical grid points

#### 1.5.4 Segment Matching Logic
- [ ] Implement: compare ride geometry against existing segments in area
- [ ] Calculate overlap percentage (shared length / total length)
- [ ] Classify: Match (>80% overlap), Fork (partial overlap), New (no overlap)
- [ ] Configurable overlap threshold per area

**Done when:** Second ride on same trail returns "Match", parallel trail returns "New"

#### 1.5.5 Segment Creation
- [ ] Implement: create new segment from geometry
- [ ] Generate what3words name from start point (or placeholder for now)
- [ ] Create both segment_dirs with computed properties (length, elevation)
- [ ] Mark as visibility = visible by default

**Done when:** New trail creates segment with two dirs, length/elevation computed

#### 1.5.6 Segment Splitting
- [ ] Implement: detect fork mid-segment (new ride diverges partway)
- [ ] Delete old segment, create two new segments at fork point
- [ ] Queue affected rides in rematch_queue with reason `topology_change`
- [ ] Preserve segment history (old segment_id logged)

**Done when:** Ride revealing new fork splits existing segment, old rides queued for rematch

#### 1.5.7 Rematch Queue Table
- [ ] Add migration: rematch_queue (id, ride_id, reason, priority, queued_at, processed_at)
- [ ] Reason enum: `topology_change`, `algorithm_update`, `manual`
- [ ] Implement: queue ride, process queue in priority order

**Done when:** Topology change queues rides, can list pending rematch count

#### 1.5.8 CLI: `dingo graph`
- [ ] Implement `dingo graph rebuild --area <id>` (full rebuild from rides)
- [ ] Implement `dingo graph stats --area <id>` (segment count, total km)
- [ ] Print summary: segments created, splits, matches

**Done when:** `dingo graph rebuild` creates segment network from existing rides

---

### 1.6 Run Matching

#### 1.6.1 Runs Table
- [ ] Add migration: runs (id, ride_id, segment_dir_id, start_time, end_time, elapsed_time, stopped_time)
- [ ] Add columns: speed_avg, speed_max, speed_variance, hr_avg, hr_max
- [ ] Add columns: mode, condition, out_and_back_reason (nullable enum)
- [ ] Index on (segment_dir_id, ride_id)

**Done when:** Can insert run linking ride to segment_dir with timing stats

#### 1.6.2 Ride-to-Segment Matching
- [ ] Implement: walk ride points, snap each to nearest segment_dir
- [ ] Track segment transitions (entered segment X at point N)
- [ ] Determine direction of travel (A→B or B→A) from point sequence
- [ ] Handle GPS drift: bridge gaps < 20m for < 5 seconds

**Done when:** Ride matched to sequence of segment_dirs with entry/exit points

#### 1.6.3 Run Extraction
- [ ] Extract run from ride for each segment traversal
- [ ] Calculate: elapsed_time, stopped_time (from stop intervals intersecting run)
- [ ] Calculate: speed stats from points within run
- [ ] Calculate: HR stats if sensor data present

**Done when:** Each segment traversal produces run with accurate timing/speed

#### 1.6.4 Out-and-Back Detection
- [ ] Detect when ride crosses same segment twice in opposite directions
- [ ] Check terminus proximity to POIs → `poi_detour`
- [ ] Check terminus grade + speed stall → `attempted_climb`
- [ ] Otherwise → `unknown`, mark segment as `unreviewed`

**Done when:** Out-and-back rides tagged with correct reason, reviewed flag set

#### 1.6.5 Mode & Condition Assignment
- [ ] Inherit condition from ride's `inferred_condition`
- [ ] Mode: default from area's `mode_affinity`, allow override
- [ ] Store on run for per-mode/condition stats later

**Done when:** Runs have mode + condition populated

#### 1.6.6 CLI: `dingo match`
- [ ] Implement `dingo match --ride <id>`
- [ ] Implement `dingo match --area <id>` (all rides in area)
- [ ] Print summary: runs created, segments traversed, out-and-backs detected

**Done when:** `dingo match --ride <id>` creates runs for all segments traversed

---

### 1.7 Segment Stats Aggregation

#### 1.7.1 Segment Dir Stats Table
- [ ] Add migration: segment_dir_stats (id, segment_dir_id, mode, condition)
- [ ] Add columns: run_count, time_min, time_max, time_median, time_stddev
- [ ] Add columns: speed_avg, stop_time_avg, hr_avg, hr_max
- [ ] Unique constraint on (segment_dir_id, mode, condition)

**Done when:** Can insert/update stats per segment_dir/mode/condition combo

#### 1.7.2 Stats Calculation
- [ ] Implement: aggregate runs by (segment_dir_id, mode, condition)
- [ ] Calculate: count, min/max/median/stddev for time
- [ ] Calculate: averages for speed, stop_time, HR
- [ ] Handle sparse data gracefully (nulls for insufficient runs)

**Done when:** Stats computed from runs match manual calculation

#### 1.7.3 Confidence Tiers
- [ ] Implement confidence assignment: unridden (0), provisional (1-2), confident (3+)
- [ ] Add confidence column to segment_dir_stats
- [ ] Expose in queries for UI filtering

**Done when:** Segments correctly tiered based on run count

#### 1.7.4 Incremental Updates
- [ ] Implement: update stats when new run added (avoid full recalc)
- [ ] Implement: full rebuild for segment (after topology change)
- [ ] Track stats_updated_at timestamp

**Done when:** New run triggers incremental stats update, not full rebuild

#### 1.7.5 CLI: `dingo stats`
- [ ] Implement `dingo stats rebuild --area <id>`
- [ ] Implement `dingo stats show --segment <id>` (per-direction breakdown)
- [ ] Print summary: segments updated, confidence distribution

**Done when:** `dingo stats rebuild` populates stats for all segments in area

---

### 1.8 Dingo Scoring

#### 1.8.1 Segment Dir Dingo Score Table
- [ ] Add migration: segment_dir_dingo_score (id, segment_dir_id, mode, condition, profile)
- [ ] Add columns: score (0-100), computed_at
- [ ] Unique constraint on (segment_dir_id, mode, condition, profile)
- [ ] Profile enum: `flow`, `tech`, `scenic`, `efficient`

**Done when:** Can store Dingo score per segment_dir/mode/condition/profile combo

#### 1.8.2 Feature Extraction
- [ ] Extract geometry features: length, elevation_gain/loss, avg_grade, max_grade, twistiness
- [ ] Extract stats features: speed_avg, stop_density, hr_intensity (if available)
- [ ] Compute pace_vs_shape: actual speed vs expected speed for geometry
- [ ] Output: feature vector per segment_dir/mode/condition

**Done when:** Feature vector computed for segment with sufficient runs

#### 1.8.3 Feature Normalisation
- [ ] Normalise each feature to 0-1 range
- [ ] Use min/max from dataset (global or per-area configurable)
- [ ] Handle missing features (default to neutral 0.5)

**Done when:** All features scaled consistently for scoring

#### 1.8.4 Profile Weights & Scoring
- [ ] Define weight vectors for each profile (flow, tech, scenic, efficient)
- [ ] Implement: score = weighted sum of normalised features × 100
- [ ] Flow: high speed, twistiness; low stops, elevation
- [ ] Tech: high pace_vs_shape, hr_intensity; low speed
- [ ] Scenic: low stress overall
- [ ] Efficient: high speed; penalise stops, obstacles

**Done when:** Same segment gets different scores per profile matching intuition

#### 1.8.5 Slog Detection
- [ ] Detect technical slow: low speed + high HR + continuous movement
- [ ] Detect slog: low speed + low HR + high stops + negative tags
- [ ] Apply slog penalty to all profiles except tech

**Done when:** Known slog segments penalised, technical climbs not penalised

#### 1.8.6 CLI: `dingo score`
- [ ] Implement `dingo score rebuild --area <id>`
- [ ] Implement `dingo score show --segment <id>` (all profiles)
- [ ] Print summary: segments scored, score distribution per profile

**Done when:** `dingo score rebuild` computes Dingo scores for all segments in area

---

### 1.9 Area Map & Segment Inspector

#### 1.9.1 Daemon Scaffold
- [ ] Create `daemon` crate with async runtime (tokio)
- [ ] Set up HTTP server (axum or actix-web)
- [ ] Configure connection pool sharing
- [ ] Serve static files from embedded directory or filesystem

**Done when:** Daemon starts, responds to health check endpoint

#### 1.9.2 API: Areas & Segments
- [ ] GET /api/areas → list areas (tree structure)
- [ ] GET /api/areas/:id → area detail with boundary GeoJSON
- [ ] GET /api/areas/:id/segments → segments as GeoJSON FeatureCollection
- [ ] Include segment properties: name, trail_type, confidence, dingo_scores

**Done when:** Can fetch area segments as GeoJSON, view in geojson.io

#### 1.9.3 API: Segment Detail
- [ ] GET /api/segments/:id → segment with both directions
- [ ] Include: stats per direction/mode/condition, dingo scores, run count
- [ ] GET /api/segments/:id/runs → run history for segment

**Done when:** Full segment detail available via API

#### 1.9.4 Frontend: Map Shell
- [ ] Set up frontend (HTMX + Tera or Svelte — your choice at implementation)
- [ ] Integrate MapLibre GL JS
- [ ] Load area boundary, centre map on area
- [ ] Basic controls: zoom, pan

**Done when:** Map renders, shows area boundary

#### 1.9.5 Frontend: Segment Layer
- [ ] Fetch segments GeoJSON from API
- [ ] Render as LineString layer on map
- [ ] Colour by: Dingo score (default), trail_type, confidence (switchable)
- [ ] Style: line width by zoom level

**Done when:** Segment network visible on map, coloured by score

#### 1.9.6 Frontend: Segment Inspector Panel
- [ ] Click segment → open inspector panel (RHS)
- [ ] Show: name, direction toggle (A→B / B→A)
- [ ] Show: stats table (time, speed, HR per mode/condition)
- [ ] Show: Dingo scores per profile
- [ ] Show: run history list

**Done when:** Click segment, see full stats breakdown in panel

#### 1.9.7 Frontend: Map Filters
- [ ] Filter controls: mode, condition, profile, trail_type, visibility
- [ ] Apply filters to segment layer (client-side or re-fetch)
- [ ] Update colour legend to match active colouring

**Done when:** Can filter to "Enduro + Dry + Flow" and see relevant segments

---

### 1.10 Route Builder & Export

#### 1.10.1 Saved Routes Table
- [ ] Add migration: saved_routes (id, area_id, name, created_at, updated_at)
- [ ] Add migration: saved_route_segments (id, route_id, segment_dir_id, sequence_order)
- [ ] Route geometry derived from segment sequence, not stored

**Done when:** Can save ordered list of segment_dirs as a route

#### 1.10.2 API: Route CRUD
- [ ] POST /api/routes → create route with segment_dir sequence
- [ ] GET /api/routes/:id → route with derived geometry + stats
- [ ] PUT /api/routes/:id → update segment sequence
- [ ] DELETE /api/routes/:id → delete route

**Done when:** Can create, update, retrieve routes via API

#### 1.10.3 Route Stats Aggregation
- [ ] Calculate: total distance (sum segment lengths)
- [ ] Calculate: total elevation gain/loss
- [ ] Calculate: estimated time (sum median times from stats)
- [ ] Calculate: aggregate Dingo score (length-weighted average)

**Done when:** Route detail includes totals and aggregate score

#### 1.10.4 Frontend: Route Builder Panel
- [ ] Click segments to add to route (sequence order)
- [ ] Display running totals: distance, elevation, time, Dingo score
- [ ] Drag to reorder segments
- [ ] Direction auto-selected from sequence, manual override toggle
- [ ] Remove segment from route

**Done when:** Can build route by clicking segments, see live totals

#### 1.10.5 Route Validation & Warnings
- [ ] Detect discontinuities (gaps between segments)
- [ ] Warn: hidden segments included
- [ ] Warn: low confidence segments
- [ ] Warn: wet-sensitive segments (if condition = dry selected)

**Done when:** Warnings display when building problematic routes

#### 1.10.6 Export: GPX Format
- [ ] Implement GPX export in `ingest` crate (reuse for import/export)
- [ ] Include: track points from segment geometries
- [ ] Include: waypoints for POIs along route (optional)
- [ ] Apply naming convention from design doc

**Done when:** Exported GPX opens in Garmin/Locus with correct name

#### 1.10.7 Export: Additional Formats
- [ ] Implement FIT course export (Garmin devices)
- [ ] Implement KML export (Google Earth)
- [ ] Implement GeoJSON export (programmatic use)

**Done when:** Can export route in all four formats

#### 1.10.8 API & CLI: Export
- [ ] GET /api/routes/:id/export?format=gpx → download file
- [ ] Implement `dingo export route <id> --format <fmt>`
- [ ] Auto-generate filename from naming convention

**Done when:** Can export routes via UI download button or CLI

---

### 1.11 Locus Sync

#### 1.11.1 Locus Folder Structure
- [ ] Research Locus Maps folder conventions (tracks, points)
- [ ] Define sync directory structure mirroring area hierarchy
- [ ] Configure sync root path in config

**Done when:** Understand Locus import/export paths, config option defined

#### 1.11.2 Push: Export to Locus
- [ ] Export all saved routes in area to GPX in Locus folder
- [ ] Export POIs as GPX waypoints or Locus-native format
- [ ] Organise by area hierarchy: `{sync_root}/{area_path}/{filename}.gpx`
- [ ] Track exported_at to avoid re-exporting unchanged routes

**Done when:** Routes appear in Locus after sync push

#### 1.11.3 Pull: Import from Locus
- [ ] Watch Locus tracks folder for new recordings
- [ ] Import new GPX files via standard ingest pipeline
- [ ] Optionally auto-clean and match after import

**Done when:** Ride recorded in Locus auto-imports to Dingo

#### 1.11.4 CLI: `dingo sync locus`
- [ ] Implement `dingo sync locus --push` (export to Locus)
- [ ] Implement `dingo sync locus --pull` (import from Locus)
- [ ] Implement `dingo sync locus --both` (bidirectional)
- [ ] Print summary: files pushed, files pulled

**Done when:** `dingo sync locus --both` syncs routes and imports new rides

---

## Phase 2: Photos Foundation

### 2.1 Google Photos Integration
- [ ] Create `google` crate with OAuth2 flow (browser-based)
- [ ] Store refresh token in config directory
- [ ] Implement token refresh in daemon
- [ ] CLI: `dingo auth google` for initial auth

**Done when:** OAuth flow completes, token stored and refreshes silently

### 2.2 Photo Fetch Pipeline
- [ ] Query Google Photos API by time window (ride start - 30min to end + 30min)
- [ ] Download medium resolution (800px), generate thumbnail (200px)
- [ ] Store in content-addressed store: `photos/{sha256}_{size}.jpg`
- [ ] Extract EXIF: timestamp, GPS, camera info
- [ ] Add photos table with metadata

**Done when:** `dingo photos fetch --ride <id>` downloads and stores photos

### 2.3 Photo-to-Segment Matching
- [ ] GPS match: snap photo location to nearest segment within 50m
- [ ] Timestamp match (fallback): interpolate position on ride timeline
- [ ] Handle edge cases: junctions, off-trail, unmatched
- [ ] Store match_method on photo record

**Done when:** Photos linked to segment_dirs, viewable in segment inspector

---

## Phase 3: ML Bootstrap

### 3.1 Vision Module Scaffold
- [ ] Create `vision` crate with VisionBackend trait
- [ ] Implement CloudVisionBackend (Claude Vision API)
- [ ] Define PhotoAnalysis struct: description, labels, confidence
- [ ] Define label vocabulary per design doc

**Done when:** Can send image to Claude Vision, receive structured labels

### 3.2 Cloud Inference Pipeline
- [ ] Process photos via cloud API with domain-specific prompts
- [ ] Parse response into photo_labels table
- [ ] Generate ml_description for vector embedding
- [ ] Rate limit and quota tracking

**Done when:** Photos analysed, labels stored, description generated

### 3.3 POI Suggestion Flow
- [ ] Create poi_suggestions table
- [ ] Generate suggestions from infrastructure/obstacle labels
- [ ] Deduplicate against existing POIs within 20m
- [ ] CLI: `dingo photos analyse --ride <id>`

**Done when:** Photos with gates/hazards create POI suggestions

### 3.4 POI Review UI
- [ ] API: GET /api/poi-suggestions, POST accept/reject/merge
- [ ] Frontend: suggestions queue panel
- [ ] Actions: accept (creates POI), reject, merge with existing
- [ ] Feed ml_training_queue on user decision

**Done when:** Can review and accept/reject POI suggestions in UI

---

## Phase 4: Search & Discovery

### 4.1 LanceDB Integration
- [ ] Add LanceDB dependency to daemon
- [ ] Create segment_embeddings table (segment_dir_id, vector)
- [ ] Create photo_embeddings table (photo_id, vector)
- [ ] Implement embedding generation (sentence-transformers or similar)

**Done when:** Can insert and query vectors in LanceDB

### 4.2 Photo Embeddings
- [ ] Embed photo ml_description + labels as concatenated text
- [ ] Index all analysed photos
- [ ] Implement recency boost (12-month half-life decay)

**Done when:** Photos searchable by semantic similarity with time decay

### 4.3 Photo Search UI
- [ ] API: GET /api/photos/search?q=<query>
- [ ] Frontend: search bar with natural language input
- [ ] Results: photo grid with segment context
- [ ] Click to navigate to segment on map

**Done when:** Search "muddy single track" returns relevant photos

---

## Phase 5: Local ML

### 5.1 Training Data Export
- [ ] Export ml_training_queue to dataset format
- [ ] Include: images, labels, user corrections
- [ ] CLI: `dingo ml export`

**Done when:** Training dataset exported with user-corrected labels

### 5.2 Local Model Integration
- [ ] Add ONNX runtime to vision crate
- [ ] Implement LocalVisionBackend
- [ ] Load model weights from models/ directory
- [ ] Routing logic: local first, cloud fallback if confidence < 0.7

**Done when:** Photos processed locally, cloud only for low confidence

### 5.3 Model Hot-Reload
- [ ] Watch models/ directory for new weights
- [ ] Hot-reload model without daemon restart
- [ ] CLI: `dingo ml status` shows model version, queue size

**Done when:** Drop new model file, daemon picks it up automatically

---

## Progress Tracking

| Phase | Tasks | Complete | Status |
|-------|-------|----------|--------|
| 0 - Scaffolding | 4 | 4 | ✅ Complete |
| 1.1 - Ingest | 6 | 6 | ✅ Complete |
| 1.2 - Cleaning | 6 | 6 | ✅ Complete |
| 1.3 - Enrichment | 6 | 6 | ✅ Complete |
| 1.4 - Areas | 4 | 0 | Not started |
| 1.5 - Graph | 8 | 0 | Not started |
| 1.6 - Matching | 6 | 0 | Not started |
| 1.7 - Stats | 5 | 0 | Not started |
| 1.8 - Scoring | 6 | 0 | Not started |
| 1.9 - UI | 7 | 5 | 🔄 In Progress |
| 1.10 - Routes | 8 | 0 | Not started |
| 1.11 - Locus | 4 | 0 | Not started |
| 2 - Photos | 3 | 0 | Not started |
| 3 - ML | 4 | 0 | Not started |
| 4 - Search | 3 | 0 | Not started |
| 5 - Local ML | 3 | 0 | Not started |
| **Total** | **83** | **27** | |

---

## Notes

### 2025-12-30: Web UI Progress
- Implemented HR and speed gradient coloring for all tracks on map
- Added `useAllRidePoints` hook to fetch points for all rides with caching
- Global min/max normalization for consistent coloring across rides
- Color mode toggle (HR/Speed/Off) in map controls
- Fixed `speed_ms` field name in API (was looking for `speed`)
