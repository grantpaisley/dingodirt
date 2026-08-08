# CLAUDE.md — Dingo

Dingo is a local-first trail knowledge system for off-road riding. It is a Rust
workspace (backend + CLI) plus a React/TypeScript web UI. Rides in PostGIS are the
source of truth. The map renders them as a Strava-style density heatmap plus
per-track layers (mode / HR / speed / grade). Automatic segment extraction was
removed 2026-07-07. A manual segment approach is planned, with AI help later.
The heatmap does the segmentation duty for now. The old segments/runs DB tables
still exist, but nothing reads them.

## Running the app

The app has three processes. Start the database before the daemon. The daemon
connects at startup and runs the migrations itself.

```bash
# 1. Database (PostGIS 16 via Docker, exposed on localhost:5433)
./scripts/dev-db.sh start          # also: stop | reset | logs | psql

# 2. API daemon  ->  http://localhost:3000
cargo run -p dingo_daemon          # binary name: dingo-server; serves /api/*

# 3. Web UI (Vite/React)  ->  http://localhost:5173
cd web && npm install && npm run dev
```

The web app calls `http://localhost:3000/api` directly (see `web/src/api/hooks.ts`).
The daemon sends permissive CORS. Thus the two processes work together on
localhost with no more configuration.

### CLI (batch processing)

```bash
cargo run -p dingo -- <command>    # binary name: dingo
# ingest <path> | clean | enrich | name | area | mode | photos | gazetteer | turns
# organize --src <inbox> --dest <library> | dedupe-plans [--apply --dest <library>]
# merge-parts [--apply --dest <library>]   (stitch multi-part recordings into one ride)
# export offline --area <name> --out <dir>   (colored GPX bundle for OsmAnd/Locus)
# export heatmap-tiles --out <file.mbtiles>   (raster density-heatmap overlay for OsmAnd/Locus)
```

`dingo ingest <path>` parses FIT/GPX files. It stores the raw file
content-addressed under `files/`. It writes a row to the `rides` table in
PostGIS. Dingo then consumes (deletes) the source files after it verifies their
bytes in the store. This is the same convention as `organize`. The
`--keep-sources` flag keeps the source files.

`dingo gazetteer load-roads <australia.osm.pbf>` loads named OSM roads into
PostGIS. With the roads loaded, imports get turn cues (shared junction marks,
exported as GPX `<wpt>`s). `dingo turns --all` backfills the turn cues. Plan's
Import dialog also accepts a Google Maps directions link. This link needs
`GOOGLE_MAPS_API_KEY` in the daemon env (Routes API).

`dingo photos import <dir>` ingests an extracted Google Photos Takeout archive.
It stores thumb/medium JPEGs content-addressed under `photos/`. The full-res
image stays in Google Photos, through the sidecar's link-out URL.
`dingo photos match` links photos to rides. The recording time window qualifies
the candidates. GPS proximity breaks the ties. A photo without a location gets a
position interpolated along the ride's track.

## Build / environment notes

- **Requires a live DB at build time.** sqlx uses compile-time-checked `query!`
  macros against `DATABASE_URL`. The `.sqlx/` offline cache is gitignored. Thus
  `cargo build` needs PostGIS running and `DATABASE_URL` set, e.g.
  `export DATABASE_URL=postgres://dingo:dingo@localhost:5433/dingo` (also in `.env`).
- `.env` is gitignored. Copy it from `.env.example`.
- `Cargo.lock`, `/target/`, `/files/`, `/photos/`, `/models/`, `.sqlx/` are gitignored.

## Repository layout

```
crates/
  core/     domain types, config, errors, DB pool, UUID id newtypes
  ingest/   FIT/GPX/KML parsing, content-addressed file store, repository
  geo/      geometry: jitter removal, simplification, mode classification
  enrich/   weather (Open-Meteo) + solar / time-of-day + gazetteer ride naming
  daemon/   axum API server (dingo-server) — serves the web UI's data
  harvest/  heat tile harvester (dingo-harvest) — mirrors Strava heat into MBTiles
  cli/      dingo CLI
  google/   Google Photos: Takeout import + photo->ride matching
  vision/   photo ML inference      — STUB (Phase 3+, not built)
web/        React + TypeScript + Vite + MapLibre + deck.gl front end
migrations/ sqlx migrations (PostGIS)
samples/    small committed GPX fixtures (see Data, below)
Docs/       architecture & design, implementation plan, UI specs
```

Build status: everything except `vision` is implemented. `vision` is the
photo-ML phase and stays a one-line stub. `google` covers Takeout import. The
Picker API (incremental import) is not built. Note: Google removed the Library
API read scopes in March 2025, so Takeout is the only bulk path (see the update
note in Docs/dingo-architecture-design.md).

## Data conventions — IMPORTANT

- **Ride/test data lives OUTSIDE the repo**, in `~/Desktop/Projects/Dingo-data/`
  (git does not track it). `test_data/` is gitignored.
- **Committed fixtures** are only the 5 small GPX files in `samples/`. Point all
  tests and examples at `samples/`, not at the external data directory.
- **Never commit large ride archives** (FIT zips, Garmin GDPR exports). GitHub
  rejects blobs >100 MB, and these archives hold personal GPS traces. They belong
  in `~/Desktop/Projects/Dingo-data/`.

## Git

- The default branch is `main` (synced to https://github.com/grantpaisley/Dingo).
- Commit only when asked. Branch off `main` for non-trivial work.
