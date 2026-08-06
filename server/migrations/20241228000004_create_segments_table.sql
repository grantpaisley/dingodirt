-- Segment visibility enum
CREATE TYPE segment_visibility AS ENUM ('visible', 'hidden', 'deleted');
-- Segment direction enum
CREATE TYPE segment_direction AS ENUM ('a_to_b', 'b_to_a');
-- Segments table - unique trail sections
CREATE TABLE segments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    area_id UUID NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
    geometry GEOMETRY(LineString, 4326) NOT NULL,
    geometry_hash VARCHAR(64) NOT NULL,
    -- SHA256 of canonical WKB
    name VARCHAR(255),
    visibility segment_visibility NOT NULL DEFAULT 'visible',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Spatial index for efficient queries
CREATE INDEX idx_segments_geometry ON segments USING GIST(geometry);
CREATE INDEX idx_segments_area ON segments(area_id);
CREATE UNIQUE INDEX idx_segments_hash ON segments(area_id, geometry_hash);
COMMENT ON TABLE segments IS 'Unique trail sections with canonical geometry';
COMMENT ON COLUMN segments.geometry_hash IS 'SHA256 hash of canonical WKB for deduplication';
-- Segment directions - one for each direction (A→B, B→A)
CREATE TABLE segment_dirs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    segment_id UUID NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    direction segment_direction NOT NULL,
    length_m REAL NOT NULL,
    elevation_gain_m REAL NOT NULL DEFAULT 0,
    elevation_loss_m REAL NOT NULL DEFAULT 0,
    avg_grade_pct REAL NOT NULL DEFAULT 0,
    UNIQUE(segment_id, direction)
);
CREATE INDEX idx_segment_dirs_segment ON segment_dirs(segment_id);
COMMENT ON TABLE segment_dirs IS 'Directional segment data (A→B and B→A for each segment)';
-- Rematch queue for topology changes
CREATE TYPE rematch_reason AS ENUM ('topology_change', 'algorithm_update', 'manual');
CREATE TABLE rematch_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ride_id UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    reason rematch_reason NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);
CREATE INDEX idx_rematch_queue_pending ON rematch_queue(priority DESC, queued_at)
WHERE processed_at IS NULL;
COMMENT ON TABLE rematch_queue IS 'Queue of rides needing segment re-matching after topology changes';
