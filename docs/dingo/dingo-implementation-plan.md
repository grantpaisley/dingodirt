# Dingo Implementation Plan

*Sequential, fine-grained tasks for building the trail knowledge system*

---

## How to Use This Plan

1. Do the tasks in order. Each task depends on the tasks before it
2. Mark each task when it is complete: `- [ ]` → `- [x]`
3. Make sure that each task is possible in a single Claude Code session
4. Use real GPX/FIT files from your collection as test fixtures
5. The "Done when" criteria define acceptance. Do not continue until you satisfy them

---

## Phase 0: Project Scaffolding

### 0.1 Repository & Workspace Setup
- [ ] Initialise the git repo with a .gitignore (Rust, IDE, .env)
- [ ] Create the Cargo workspace with the crates/ directory structure
- [ ] Add the empty crates: core, geo, ingest, enrich, graph, match, stats, vision, google, daemon, cli
- [ ] Configure the shared dependencies in the workspace Cargo.toml

**Done when:** `cargo check` passes on the empty workspace

### 0.2 Development Environment
- [ ] Create a docker-compose.yml with Postgres 16 + PostGIS 3.4
- [ ] Add .env.example with a DATABASE_URL template
- [ ] Create scripts/dev-db.sh for start/stop/reset
- [ ] Make sure that the PostGIS extension loads (`SELECT PostGIS_Version()`)

**Done when:** You can connect to the local PostGIS from psql

### 0.3 Database Schema Foundation
- [ ] Add sqlx as a dependency. Configure the offline mode
- [ ] Create the migrations/ directory
- [ ] Write the initial migration: the areas, files, and rides tables
- [ ] Set up sqlx-cli to run the migrations

**Done when:** `sqlx migrate run` creates the tables, and `cargo sqlx prepare` generates the query cache

### 0.4 Core Crate Types
- [ ] Define the error types (thiserror)
- [ ] Define the config struct (serde, figment or config-rs)
- [ ] Define the shared domain types: AreaId, FileId, RideId (UUID newtypes)
- [ ] Add a db module with the connection pool setup

**Done when:** The other crates can import `dingo_core::{Config, Error, Result, db}`

---

## Phase 1: Core MVP

### 1.1 File Ingest Pipeline

#### 1.1.1 File Store
- [ ] Create a content-addressed file store in the `ingest` crate
- [ ] Implement: hash the file → copy it to `files/{sha256}.{ext}`
- [ ] Handle duplicates (skip the file if the hash exists)
- [ ] Return the FileId + the metadata (size, hash, original name)

**Done when:** You can store a file, get the path by hash, and skip duplicates

#### 1.1.2 Format Detection
- [ ] Find the format from the magic bytes (FIT: the `.FIT` header, GPX: XML with `<gpx>`)
- [ ] Support: FIT, GPX, KML, GeoJSON, TCX
- [ ] Return the enum: `FileFormat::Fit | Gpx | Kml | GeoJson | Tcx | Unknown`

**Done when:** The code identifies the correct format for test files of each type

#### 1.1.3 GPX Parser
- [ ] Parse GPX to the internal track representation
- [ ] Extract: the points (lat, lon, ele, time), the name, the metadata
- [ ] Handle multi-track files (return a Vec<Track>)
- [ ] Find if the file is a ride or a route (timestamps present → a ride)

**Done when:** The parser reads your real GPX test files and extracts all points with timestamps

#### 1.1.4 FIT Parser
- [ ] Add the fit-rs or fitparser dependency
- [ ] Parse FIT to the same internal track representation
- [ ] Extract: the points, timestamps, HR, cadence, and power if present
- [ ] Handle activity files and course files

**Done when:** The parser reads real FIT files from Garmin and extracts the sensor data

#### 1.1.5 Files Table & Ride Insertion
- [ ] Write the migration: the files table (id, hash, format, original_name, size, imported_at)
- [ ] Write the migration: the rides table (id, file_id, name, started_at, raw_geometry, raw_time_series, sensor_data)
- [ ] Implement: insert the file record, then insert the ride record with the raw data
- [ ] Store the geometry as a PostGIS LineString and the time series as JSONB

**Done when:** An ingest of a GPX makes a file row + a ride row, and you can query the geometry with ST_AsGeoJSON

#### 1.1.6 CLI: `dingo ingest`
- [ ] Create the cli crate binary
- [ ] Implement the `dingo ingest <path>` command
- [ ] Support a single file or a directory (non-recursive)
- [ ] Print a summary: the files found, imported, and skipped (duplicates)

**Done when:** `dingo ingest ~/tracks/` imports all GPX/FIT files and skips the duplicates on a second run

---

### 1.2 Ride Cleaning

#### 1.2.1 GPS Jitter Removal
- [ ] Implement a Kalman filter or similar smoothing in the `geo` crate
- [ ] Make the noise threshold configurable (default ~5m)
- [ ] Keep the original points. Output the cleaned geometry

**Done when:** A noisy GPS track becomes smooth and keeps the genuine turns

#### 1.2.2 Point Simplification
- [ ] Implement the Ramer-Douglas-Peucker algorithm
- [ ] Make the epsilon configurable (default: keep the detail for trail use)
- [ ] Balance: decrease the points and keep the trail shape

**Done when:** The track has ~30-50% fewer points and looks identical on the map

#### 1.2.3 Stop Detection
- [ ] Implement a sliding window analysis: the speed + the positional variance
- [ ] Find the stops: low speed AND low variance AND duration > threshold (default 30s)
- [ ] Optional: the HR delta from a rolling baseline if sensor data is present
- [ ] Output: a list of the stop intervals (start_idx, end_idx, duration)

**Done when:** The code correctly finds the lunch stops, not the slow technical sections, in real rides

#### 1.2.4 Time Series Extraction
- [ ] Extract the cleaned time series: timestamp, lat, lon, ele, speed, hr (if present)
- [ ] Calculate the derived fields: distance_cumulative, speed_smoothed
- [ ] Store the data as a JSONB array on the ride

**Done when:** You can query a ride and replay it point by point with the timing

#### 1.2.5 Rides Table Update & Cleaning Storage
- [ ] Add the columns: cleaned_geometry, cleaned_time_series, stops (JSONB), cleaned_at
- [ ] Implement: update the ride with the cleaned data
- [ ] Track the cleaning version (for a replay if the algorithm improves)

**Done when:** The ride row has the raw and the cleaned geometry, and the stops are identified

#### 1.2.6 CLI: `dingo clean`
- [ ] Implement the `dingo clean --ride <id>` command
- [ ] Implement `dingo clean --all` for batch processing
- [ ] Print a summary: the points before/after, the stops found

**Done when:** `dingo clean --ride <id>` updates the ride with the cleaned data

---

### 1.3 Context Enrichment

#### 1.3.1 Open-Meteo Client
- [ ] Create the `enrich` crate
- [ ] Implement a client for the Open-Meteo historical weather API
- [ ] Query by: latitude, longitude, date
- [ ] Parse the response: precipitation, temp_max, temp_min

**Done when:** The client can fetch the weather for a given location + date and returns structured data

#### 1.3.2 Weather Fields Extraction
- [ ] Extract `precip_last_24h` (the day of the ride)
- [ ] Extract `precip_last_48h` (the day of the ride + the day before, summed)
- [ ] Extract `temp_max` and `temp_min` for the ride date
- [ ] Handle API failures safely (mark the data as incomplete)

**Done when:** The weather struct is filled for a real ride location/date

#### 1.3.3 Condition Inference
- [ ] Implement the threshold logic: precip_last_48h > X mm → wet
- [ ] Make the thresholds configurable (default: >5mm = wet)
- [ ] Output: `inferred_condition` (dry/wet/unknown), `condition_confidence` (low/medium/high)

**Done when:** The system classifies real rides as dry/wet, and this agrees with your memory of the conditions

#### 1.3.4 Solar Position Calculation
- [ ] Implement the sunrise/sunset calculation from the timestamp + the coordinates
- [ ] Define the dawn/dusk windows (e.g., 30 min before sunrise, 30 min after sunset)
- [ ] Output: the `time_of_day` enum (day/dawn/dusk/night)

**Done when:** A morning ride = dawn→day, an evening ride = day→dusk, a night ride = night

#### 1.3.5 Rides Table: Enrichment Columns
- [ ] Add a migration: the weather fields (precip_last_24h, precip_last_48h, temp_max, temp_min)
- [ ] Add a migration: inferred_condition, condition_confidence, time_of_day
- [ ] Add a migration: the enriched_at timestamp

**Done when:** The ride row stores all the enrichment fields

#### 1.3.6 CLI: `dingo enrich`
- [ ] Implement the `dingo enrich --ride <id>` command
- [ ] Implement `dingo enrich --all` for batch processing
- [ ] Print a summary: the inferred condition, the time_of_day

**Done when:** `dingo enrich --ride <id>` fetches the weather, calculates the solar position, and updates the ride

---

### 1.4 Area Resolution

#### 1.4.1 Areas Table
- [ ] Add a migration: areas (id, parent_id, name, boundary, mode_affinity, created_at)
- [ ] Store the boundary as a PostGIS Polygon
- [ ] Add a spatial index on the boundary

**Done when:** You can insert an area with a polygon boundary and query it with ST_Contains

#### 1.4.2 Area CRUD Operations
- [ ] Implement: create an area with a name + a boundary polygon
- [ ] Implement: update an area (rename it, adjust the boundary, change the parent)
- [ ] Implement: delete an area (cascade rules TBD)
- [ ] Implement: list the areas (a tree structure via parent_id)

**Done when:** You can create, list, and update areas with the core crate functions

#### 1.4.3 Ride-to-Area Assignment
- [ ] Implement: find the most specific (deepest) area that holds the ride start point
- [ ] Handle rides that cross more than one area (assign the ride to the area of the start point)
- [ ] Add the area_id column to the rides table
- [ ] Update the ride with the area assignment on ingest/clean

**Done when:** The system assigns each ride to the correct area from its start location

#### 1.4.4 CLI: `dingo area`
- [ ] Implement `dingo area create --name <n> --boundary <geojson-file>`
- [ ] Implement `dingo area list` (a tree view)
- [ ] Implement `dingo area show <id>` (a stats summary)

**Done when:** You can create an area from a GeoJSON polygon file, and the list shows the hierarchy

---

### 1.5 Segment Graph Creation

#### 1.5.1 Segments & Segment Dirs Tables
- [ ] Add a migration: segments (id, area_id, geometry_hash, name, visibility, created_at)
- [ ] Add a migration: segment_dirs (id, segment_id, direction, length, elevation_gain, elevation_loss, avg_grade)
- [ ] Store the segment geometry as a PostGIS LineString with a spatial index
- [ ] The direction enum: `a_to_b`, `b_to_a`

**Done when:** You can insert a segment with two segment_dirs and query it by area

#### 1.5.2 Geometry Canonicalisation
- [ ] Implement the canonical direction: the lower lat/lng endpoint first
- [ ] Implement the geometry hash: the SHA256 of the WKB representation
- [ ] Make sure that the direction is consistent for each input order

**Done when:** The same trail, ridden in opposite directions, gives the same geometry_hash

#### 1.5.3 Spatial Grid Snapping
- [ ] Implement point snapping to a configurable grid (default ~1m)
- [ ] Snap the cleaned ride geometry before the comparison
- [ ] This decreases the false "new segment" detections from GPS variance

**Done when:** Two rides on the same trail snap to identical grid points

#### 1.5.4 Segment Matching Logic
- [ ] Implement: compare the ride geometry with the existing segments in the area
- [ ] Calculate the overlap percentage (shared length / total length)
- [ ] Classify: Match (>80% overlap), Fork (partial overlap), New (no overlap)
- [ ] Make the overlap threshold configurable for each area

**Done when:** A second ride on the same trail returns "Match", and a parallel trail returns "New"

#### 1.5.5 Segment Creation
- [ ] Implement: create a new segment from the geometry
- [ ] Generate the what3words name from the start point (or a placeholder for now)
- [ ] Create both segment_dirs with the computed properties (length, elevation)
- [ ] Set visibility = visible by default

**Done when:** A new trail creates a segment with two dirs, with the length/elevation computed

#### 1.5.6 Segment Splitting
- [ ] Implement: find a fork in the middle of a segment (a new ride diverges partway)
- [ ] Delete the old segment. Create two new segments at the fork point
- [ ] Queue the affected rides in the rematch_queue with the reason `topology_change`
- [ ] Keep the segment history (log the old segment_id)

**Done when:** A ride that shows a new fork splits the existing segment, and the old rides go into the rematch queue

#### 1.5.7 Rematch Queue Table
- [ ] Add a migration: rematch_queue (id, ride_id, reason, priority, queued_at, processed_at)
- [ ] The reason enum: `topology_change`, `algorithm_update`, `manual`
- [ ] Implement: queue a ride, then process the queue in priority order

**Done when:** A topology change queues the rides, and you can list the pending rematch count

#### 1.5.8 CLI: `dingo graph`
- [ ] Implement `dingo graph rebuild --area <id>` (a full rebuild from the rides)
- [ ] Implement `dingo graph stats --area <id>` (the segment count, the total km)
- [ ] Print a summary: the segments created, the splits, the matches

**Done when:** `dingo graph rebuild` creates the segment network from the existing rides

---

### 1.6 Run Matching

#### 1.6.1 Runs Table
- [ ] Add a migration: runs (id, ride_id, segment_dir_id, start_time, end_time, elapsed_time, stopped_time)
- [ ] Add the columns: speed_avg, speed_max, speed_variance, hr_avg, hr_max
- [ ] Add the columns: mode, condition, out_and_back_reason (a nullable enum)
- [ ] Add an index on (segment_dir_id, ride_id)

**Done when:** You can insert a run that links a ride to a segment_dir with the timing stats

#### 1.6.2 Ride-to-Segment Matching
- [ ] Implement: walk the ride points. Snap each point to the nearest segment_dir
- [ ] Track the segment transitions (the ride entered segment X at point N)
- [ ] Find the direction of travel (A→B or B→A) from the point sequence
- [ ] Handle GPS drift: bridge gaps < 20m for < 5 seconds

**Done when:** The ride matches a sequence of segment_dirs with entry/exit points

#### 1.6.3 Run Extraction
- [ ] Extract a run from the ride for each segment traversal
- [ ] Calculate: elapsed_time, stopped_time (from the stop intervals that intersect the run)
- [ ] Calculate: the speed stats from the points in the run
- [ ] Calculate: the HR stats if sensor data is present

**Done when:** Each segment traversal makes a run with accurate timing/speed

#### 1.6.4 Out-and-Back Detection
- [ ] Find when a ride crosses the same segment two times in opposite directions
- [ ] Check if the terminus is near a POI → `poi_detour`
- [ ] Check the terminus grade + a speed stall → `attempted_climb`
- [ ] If not → `unknown`, mark the segment as `unreviewed`

**Done when:** Out-and-back rides get the correct reason tag, and the reviewed flag is set

#### 1.6.5 Mode & Condition Assignment
- [ ] The run gets the condition from the `inferred_condition` of the ride
- [ ] Mode: the default comes from the `mode_affinity` of the area. Permit an override
- [ ] Store both on the run for the per-mode/condition stats later

**Done when:** The runs have the mode + the condition filled

#### 1.6.6 CLI: `dingo match`
- [ ] Implement `dingo match --ride <id>`
- [ ] Implement `dingo match --area <id>` (all rides in the area)
- [ ] Print a summary: the runs created, the segments traversed, the out-and-backs found

**Done when:** `dingo match --ride <id>` creates runs for all the segments traversed

---

### 1.7 Segment Stats Aggregation

#### 1.7.1 Segment Dir Stats Table
- [ ] Add a migration: segment_dir_stats (id, segment_dir_id, mode, condition)
- [ ] Add the columns: run_count, time_min, time_max, time_median, time_stddev
- [ ] Add the columns: speed_avg, stop_time_avg, hr_avg, hr_max
- [ ] Add a unique constraint on (segment_dir_id, mode, condition)

**Done when:** You can insert/update the stats for each segment_dir/mode/condition combination

#### 1.7.2 Stats Calculation
- [ ] Implement: aggregate the runs by (segment_dir_id, mode, condition)
- [ ] Calculate: the count, and the min/max/median/stddev for the time
- [ ] Calculate: the averages for the speed, stop_time, and HR
- [ ] Handle sparse data safely (nulls when there are too few runs)

**Done when:** The stats computed from the runs agree with a manual calculation

#### 1.7.3 Confidence Tiers
- [ ] Implement the confidence assignment: unridden (0), provisional (1-2), confident (3+)
- [ ] Add the confidence column to segment_dir_stats
- [ ] Expose the confidence in queries for the UI filters

**Done when:** The segments get the correct tier from the run count

#### 1.7.4 Incremental Updates
- [ ] Implement: update the stats when a new run is added (no full recalculation)
- [ ] Implement: a full rebuild for a segment (after a topology change)
- [ ] Track the stats_updated_at timestamp

**Done when:** A new run starts an incremental stats update, not a full rebuild

#### 1.7.5 CLI: `dingo stats`
- [ ] Implement `dingo stats rebuild --area <id>`
- [ ] Implement `dingo stats show --segment <id>` (a breakdown for each direction)
- [ ] Print a summary: the segments updated, the confidence distribution

**Done when:** `dingo stats rebuild` fills the stats for all the segments in the area

---

### 1.8 Dingo Scoring

#### 1.8.1 Segment Dir Dingo Score Table
- [ ] Add a migration: segment_dir_dingo_score (id, segment_dir_id, mode, condition, profile)
- [ ] Add the columns: score (0-100), computed_at
- [ ] Add a unique constraint on (segment_dir_id, mode, condition, profile)
- [ ] The profile enum: `flow`, `tech`, `scenic`, `efficient`

**Done when:** You can store a Dingo score for each segment_dir/mode/condition/profile combination

#### 1.8.2 Feature Extraction
- [ ] Extract the geometry features: length, elevation_gain/loss, avg_grade, max_grade, twistiness
- [ ] Extract the stats features: speed_avg, stop_density, hr_intensity (if available)
- [ ] Compute pace_vs_shape: the actual speed vs the expected speed for the geometry
- [ ] Output: a feature vector for each segment_dir/mode/condition

**Done when:** The feature vector is computed for a segment with enough runs

#### 1.8.3 Feature Normalisation
- [ ] Normalise each feature to the 0-1 range
- [ ] Use the min/max from the dataset (global or per-area, configurable)
- [ ] Handle missing features (default to a neutral 0.5)

**Done when:** All the features have a consistent scale for the score

#### 1.8.4 Profile Weights & Scoring
- [ ] Define the weight vectors for each profile (flow, tech, scenic, efficient)
- [ ] Implement: score = the weighted sum of the normalised features × 100
- [ ] Flow: high speed, twistiness; low stops, elevation
- [ ] Tech: high pace_vs_shape, hr_intensity; low speed
- [ ] Scenic: low stress overall
- [ ] Efficient: high speed; a penalty for stops and obstacles

**Done when:** The same segment gets different scores for each profile, and the scores agree with intuition

#### 1.8.5 Slog Detection
- [ ] Find technical slow: low speed + high HR + continuous movement
- [ ] Find a slog: low speed + low HR + high stops + negative tags
- [ ] Apply the slog penalty to all profiles except tech

**Done when:** Known slog segments get the penalty, and technical climbs do not

#### 1.8.6 CLI: `dingo score`
- [ ] Implement `dingo score rebuild --area <id>`
- [ ] Implement `dingo score show --segment <id>` (all profiles)
- [ ] Print a summary: the segments scored, the score distribution for each profile

**Done when:** `dingo score rebuild` computes the Dingo scores for all the segments in the area

---

### 1.9 Area Map & Segment Inspector

#### 1.9.1 Daemon Scaffold
- [ ] Create the `daemon` crate with an async runtime (tokio)
- [ ] Set up the HTTP server (axum or actix-web)
- [ ] Configure the shared connection pool
- [ ] Serve the static files from an embedded directory or the filesystem

**Done when:** The daemon starts and responds to the health check endpoint

#### 1.9.2 API: Areas & Segments
- [ ] GET /api/areas → list the areas (a tree structure)
- [ ] GET /api/areas/:id → the area detail with the boundary GeoJSON
- [ ] GET /api/areas/:id/segments → the segments as a GeoJSON FeatureCollection
- [ ] Include the segment properties: name, trail_type, confidence, dingo_scores

**Done when:** You can fetch the area segments as GeoJSON and view them in geojson.io

#### 1.9.3 API: Segment Detail
- [ ] GET /api/segments/:id → the segment with both directions
- [ ] Include: the stats for each direction/mode/condition, the dingo scores, the run count
- [ ] GET /api/segments/:id/runs → the run history for the segment

**Done when:** The full segment detail is available from the API

#### 1.9.4 Frontend: Map Shell
- [ ] Set up the frontend (HTMX + Tera or Svelte — your choice at implementation)
- [ ] Integrate MapLibre GL JS
- [ ] Load the area boundary. Centre the map on the area
- [ ] Basic controls: zoom, pan

**Done when:** The map renders and shows the area boundary

#### 1.9.5 Frontend: Segment Layer
- [ ] Fetch the segments GeoJSON from the API
- [ ] Render the segments as a LineString layer on the map
- [ ] Colour by: the Dingo score (default), trail_type, or confidence (switchable)
- [ ] Style: the line width follows the zoom level

**Done when:** The segment network shows on the map, with colours from the score

#### 1.9.6 Frontend: Segment Inspector Panel
- [ ] A segment click → open the inspector panel (RHS)
- [ ] Show: the name, the direction toggle (A→B / B→A)
- [ ] Show: the stats table (time, speed, HR for each mode/condition)
- [ ] Show: the Dingo scores for each profile
- [ ] Show: the run history list

**Done when:** You click a segment and see the full stats breakdown in the panel

#### 1.9.7 Frontend: Map Filters
- [ ] Filter controls: mode, condition, profile, trail_type, visibility
- [ ] Apply the filters to the segment layer (client-side or with a new fetch)
- [ ] Update the colour legend to agree with the active colour mode

**Done when:** You can filter to "Enduro + Dry + Flow" and see the relevant segments

---

### 1.10 Route Builder & Export

#### 1.10.1 Saved Routes Table
- [ ] Add a migration: saved_routes (id, area_id, name, created_at, updated_at)
- [ ] Add a migration: saved_route_segments (id, route_id, segment_dir_id, sequence_order)
- [ ] The route geometry comes from the segment sequence. Do not store it

**Done when:** You can save an ordered list of segment_dirs as a route

#### 1.10.2 API: Route CRUD
- [ ] POST /api/routes → create a route with a segment_dir sequence
- [ ] GET /api/routes/:id → the route with the derived geometry + the stats
- [ ] PUT /api/routes/:id → update the segment sequence
- [ ] DELETE /api/routes/:id → delete the route

**Done when:** You can create, update, and get routes from the API

#### 1.10.3 Route Stats Aggregation
- [ ] Calculate: the total distance (the sum of the segment lengths)
- [ ] Calculate: the total elevation gain/loss
- [ ] Calculate: the estimated time (the sum of the median times from the stats)
- [ ] Calculate: the aggregate Dingo score (a length-weighted average)

**Done when:** The route detail includes the totals and the aggregate score

#### 1.10.4 Frontend: Route Builder Panel
- [ ] Click segments to add them to the route (in sequence order)
- [ ] Show the running totals: distance, elevation, time, Dingo score
- [ ] Drag to change the segment order
- [ ] The direction is auto-selected from the sequence, with a manual override toggle
- [ ] Remove a segment from the route

**Done when:** You can build a route with segment clicks and see live totals

#### 1.10.5 Route Validation & Warnings
- [ ] Find discontinuities (gaps between segments)
- [ ] Warn: the route includes hidden segments
- [ ] Warn: the route includes low confidence segments
- [ ] Warn: the route includes wet-sensitive segments (if condition = dry is selected)

**Done when:** The warnings show when you build problematic routes

#### 1.10.6 Export: GPX Format
- [ ] Implement the GPX export in the `ingest` crate (use the same code for import/export)
- [ ] Include: the track points from the segment geometries
- [ ] Include: the waypoints for POIs along the route (optional)
- [ ] Apply the naming convention from the design doc

**Done when:** The exported GPX opens in Garmin/Locus with the correct name

#### 1.10.7 Export: Additional Formats
- [ ] Implement the FIT course export (Garmin devices)
- [ ] Implement the KML export (Google Earth)
- [ ] Implement the GeoJSON export (programmatic use)

**Done when:** You can export a route in all four formats

#### 1.10.8 API & CLI: Export
- [ ] GET /api/routes/:id/export?format=gpx → download the file
- [ ] Implement `dingo export route <id> --format <fmt>`
- [ ] Generate the filename automatically from the naming convention

**Done when:** You can export routes with the UI download button or the CLI

---

### 1.11 Locus Sync

#### 1.11.1 Locus Folder Structure
- [ ] Do research on the Locus Maps folder conventions (tracks, points)
- [ ] Define a sync directory structure that mirrors the area hierarchy
- [ ] Configure the sync root path in the config

**Done when:** You know the Locus import/export paths, and the config option is defined

#### 1.11.2 Push: Export to Locus
- [ ] Export all the saved routes in an area to GPX in the Locus folder
- [ ] Export the POIs as GPX waypoints or the Locus-native format
- [ ] Organise by the area hierarchy: `{sync_root}/{area_path}/{filename}.gpx`
- [ ] Track exported_at so the system does not export unchanged routes again

**Done when:** The routes appear in Locus after a sync push

#### 1.11.3 Pull: Import from Locus
- [ ] Watch the Locus tracks folder for new recordings
- [ ] Import the new GPX files with the standard ingest pipeline
- [ ] Optional: clean and match automatically after the import

**Done when:** A ride recorded in Locus imports to Dingo automatically

#### 1.11.4 CLI: `dingo sync locus`
- [ ] Implement `dingo sync locus --push` (export to Locus)
- [ ] Implement `dingo sync locus --pull` (import from Locus)
- [ ] Implement `dingo sync locus --both` (both directions)
- [ ] Print a summary: the files pushed, the files pulled

**Done when:** `dingo sync locus --both` syncs the routes and imports the new rides

---

## Phase 2: Photos Foundation

### 2.1 Google Photos Integration
- [ ] Create the `google` crate with an OAuth2 flow (browser-based)
- [ ] Store the refresh token in the config directory
- [ ] Implement the token refresh in the daemon
- [ ] CLI: `dingo auth google` for the initial auth

**Done when:** The OAuth flow completes, and the token is stored and refreshes silently

### 2.2 Photo Fetch Pipeline
- [ ] Query the Google Photos API by time window (the ride start - 30min to the end + 30min)
- [ ] Download the medium resolution (800px). Generate the thumbnail (200px)
- [ ] Store the files in the content-addressed store: `photos/{sha256}_{size}.jpg`
- [ ] Extract the EXIF data: the timestamp, the GPS, the camera info
- [ ] Add the photos table with the metadata

**Done when:** `dingo photos fetch --ride <id>` downloads and stores the photos

### 2.3 Photo-to-Segment Matching
- [ ] GPS match: snap the photo location to the nearest segment in 50m
- [ ] Timestamp match (fallback): interpolate the position on the ride timeline
- [ ] Handle the edge cases: junctions, off-trail, unmatched
- [ ] Store the match_method on the photo record

**Done when:** The photos link to segment_dirs, and you can view them in the segment inspector

---

## Phase 3: ML Bootstrap

### 3.1 Vision Module Scaffold
- [ ] Create the `vision` crate with the VisionBackend trait
- [ ] Implement CloudVisionBackend (the Claude Vision API)
- [ ] Define the PhotoAnalysis struct: description, labels, confidence
- [ ] Define the label vocabulary from the design doc

**Done when:** You can send an image to Claude Vision and receive structured labels

### 3.2 Cloud Inference Pipeline
- [ ] Process the photos with the cloud API and domain-specific prompts
- [ ] Parse the response into the photo_labels table
- [ ] Generate the ml_description for the vector embedding
- [ ] Add rate limits and quota tracking

**Done when:** The photos are analysed, the labels are stored, and the description is generated

### 3.3 POI Suggestion Flow
- [ ] Create the poi_suggestions table
- [ ] Generate suggestions from the infrastructure/obstacle labels
- [ ] Remove duplicates against the existing POIs in 20m
- [ ] CLI: `dingo photos analyse --ride <id>`

**Done when:** Photos with gates/hazards create POI suggestions

### 3.4 POI Review UI
- [ ] API: GET /api/poi-suggestions, POST accept/reject/merge
- [ ] Frontend: the suggestions queue panel
- [ ] Actions: accept (this creates a POI), reject, merge with an existing POI
- [ ] Send the user decision to the ml_training_queue

**Done when:** You can review and accept/reject POI suggestions in the UI

---

## Phase 4: Search & Discovery

### 4.1 LanceDB Integration
- [ ] Add the LanceDB dependency to the daemon
- [ ] Create the segment_embeddings table (segment_dir_id, vector)
- [ ] Create the photo_embeddings table (photo_id, vector)
- [ ] Implement the embedding generation (sentence-transformers or similar)

**Done when:** You can insert and query vectors in LanceDB

### 4.2 Photo Embeddings
- [ ] Embed the photo ml_description + the labels as concatenated text
- [ ] Index all the analysed photos
- [ ] Implement the recency boost (12-month half-life decay)

**Done when:** You can search photos by semantic similarity with time decay

### 4.3 Photo Search UI
- [ ] API: GET /api/photos/search?q=<query>
- [ ] Frontend: a search bar with natural language input
- [ ] Results: a photo grid with the segment context
- [ ] Click to go to the segment on the map

**Done when:** A search for "muddy single track" returns the relevant photos

---

## Phase 5: Local ML

### 5.1 Training Data Export
- [ ] Export the ml_training_queue to the dataset format
- [ ] Include: the images, the labels, the user corrections
- [ ] CLI: `dingo ml export`

**Done when:** The training dataset exports with the user-corrected labels

### 5.2 Local Model Integration
- [ ] Add the ONNX runtime to the vision crate
- [ ] Implement LocalVisionBackend
- [ ] Load the model weights from the models/ directory
- [ ] The routing logic: local first, cloud fallback if confidence < 0.7

**Done when:** The photos are processed locally, and the cloud runs only for low confidence

### 5.3 Model Hot-Reload
- [ ] Watch the models/ directory for new weights
- [ ] Hot-reload the model with no daemon restart
- [ ] CLI: `dingo ml status` shows the model version and the queue size

**Done when:** You drop a new model file, and the daemon picks it up automatically

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
- Added the HR and speed gradient colours for all tracks on the map
- Added the `useAllRidePoints` hook to fetch the points for all rides, with a cache
- Global min/max normalization gives consistent colours across the rides
- A colour mode toggle (HR/Speed/Off) in the map controls
- Corrected the `speed_ms` field name in the API (the code looked for `speed`)
