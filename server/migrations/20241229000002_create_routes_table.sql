-- Routes table for planned rides connecting multiple segments
CREATE TABLE IF NOT EXISTS routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    -- Ordered list of segments and their directions
    segment_ids UUID [] NOT NULL,
    segment_directions TEXT [] NOT NULL,
    -- 'a_to_b' or 'b_to_a' per segment
    -- Bridge routing (connectors between segments)
    bridge_geometries geometry(LineString, 4326) [],
    bridge_waypoints JSONB,
    -- User waypoints per bridge for routing
    -- Computed totals
    total_distance REAL,
    total_elevation REAL,
    estimated_time INTERVAL,
    time_range_min INTERVAL,
    -- Fastest from historical runs
    time_range_max INTERVAL,
    -- Slowest from historical runs
    -- Metadata
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
-- Index for finding routes containing a segment
CREATE INDEX IF NOT EXISTS idx_routes_segments ON routes USING gin (segment_ids);
