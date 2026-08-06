-- Heat harvester coordination state (Docs/plans/2026-07-12-heat-harvester-design.md).
-- Postgres holds provenance + the resumable work queue; tile blobs live in
-- MBTiles files (one per owner+region), written by dingo-harvest.

-- Named harvest targets (AU/TH/KH/VN sweeps, ad-hoc drawn areas, track baskets).
CREATE TABLE harvest_regions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    geom geometry(Polygon, 4326) NOT NULL,
    -- Descent starts by seeding the region's cover at seed_zoom and stops
    -- enqueuing children at target_zoom (Strava heat tops out at z14).
    seed_zoom INT NOT NULL DEFAULT 6 CHECK (seed_zoom BETWEEN 0 AND 14),
    target_zoom INT NOT NULL CHECK (target_zoom BETWEEN 0 AND 14),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (seed_zoom <= target_zoom)
);

-- The harvester's memory: every tile ever considered, so a month-long run
-- survives restarts and the estimator can count what's already fetched.
--   pending → not yet fetched
--   done    → fetched, had heat, stored in MBTiles
--   empty   → fetched blank (or upstream 404) — pruned, children never enqueued
--   failed  → gave up after repeated transient errors (retryable via requeue)
CREATE TABLE harvest_frontier (
    owner_id UUID NOT NULL REFERENCES owners (id),
    region_id UUID NOT NULL REFERENCES harvest_regions (id) ON DELETE CASCADE,
    z INT NOT NULL,
    x INT NOT NULL,
    y INT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'done', 'empty', 'failed')),
    attempts INT NOT NULL DEFAULT 0,
    -- Fraction of non-empty grayscale pixels in the fetched tile (the descent
    -- signal); NULL until fetched, 0 for upstream-404 tiles.
    heat_ratio REAL,
    fetched_at TIMESTAMPTZ,
    PRIMARY KEY (owner_id, region_id, z, x, y)
);

-- The worker drains pending tiles breadth-first (shallow zooms first).
CREATE INDEX harvest_frontier_pending_idx
    ON harvest_frontier (region_id, z, x, y) WHERE state = 'pending';
