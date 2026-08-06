-- Runs table - individual segment traversals within a ride
CREATE TABLE runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ride_id UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    segment_dir_id UUID NOT NULL REFERENCES segment_dirs(id) ON DELETE CASCADE,
    start_idx INTEGER NOT NULL,
    -- Index in ride geometry
    end_idx INTEGER NOT NULL,
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    elapsed_s REAL,
    moving_s REAL,
    speed_avg REAL,
    -- km/h
    speed_max REAL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_runs_ride ON runs(ride_id);
CREATE INDEX idx_runs_segment_dir ON runs(segment_dir_id);
CREATE UNIQUE INDEX idx_runs_unique ON runs(ride_id, segment_dir_id, start_idx);
COMMENT ON TABLE runs IS 'Individual segment traversals extracted from rides';
COMMENT ON COLUMN runs.start_idx IS 'Starting point index in ride cleaned_geometry';
COMMENT ON COLUMN runs.end_idx IS 'Ending point index in ride cleaned_geometry';
