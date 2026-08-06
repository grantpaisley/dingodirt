# Dingo

A local-first, segment-centric trail knowledge system for off-road riding.

## Overview

Dingo turns raw ride history into a maintained, directed trail network with
rich metadata, run history, and personalized Dingo scores. Segments—not GPX
files—are the source of truth.

## Quick Start

### Prerequisites

- Rust 1.83+
- Docker (for PostGIS)
- sqlx-cli (`cargo install sqlx-cli`)

### Setup

1. **Start the database:**
   ```bash
   ./scripts/dev-db.sh start
   ```

2. **Copy environment file:**
   ```bash
   cp .env.example .env
   ```

3. **Run migrations:**
   ```bash
   sqlx migrate run
   ```

4. **Build:**
   ```bash
   cargo build
   ```

5. **Run CLI:**
   ```bash
   cargo run -p dingo -- --help
   ```

## Project Structure

```
dingo/
  crates/
    core/       # Domain types, DB schema, config, error handling
    geo/        # Geometry ops: cleaning, snapping, simplification
    ingest/     # Format parsing (FIT, GPX, KML, GeoJSON, TCX)
    enrich/     # Context enrichment: weather, solar position
    graph/      # Segment network: creation, splitting, merging
    match/      # Ride → segment run matching
    stats/      # Aggregation, feature extraction, Dingo scoring
    vision/     # Photo processing, ML inference
    google/     # Google Photos API client, OAuth
    daemon/     # Async query server, API
    cli/        # CLI tool: ingest, clean, rebuild, export
  Docs/         # Design documents
  migrations/   # Database migrations
  scripts/      # Development scripts
```

## Documentation

- [Architecture & Design](Docs/dingo-architecture-design.md)
- [Implementation Plan](Docs/dingo-implementation-plan.md)

## License

MIT
