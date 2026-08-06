-- Track type enum (ride with timestamps vs route geometry-only)
CREATE TYPE track_type AS ENUM ('ride', 'route');
-- Inferred trail condition from weather
CREATE TYPE trail_condition AS ENUM ('dry', 'wet', 'unknown');
-- Confidence level for inferred data
CREATE TYPE confidence_level AS ENUM ('low', 'medium', 'high');
-- Time of day based on solar position
CREATE TYPE time_of_day AS ENUM ('day', 'dawn', 'dusk', 'night');
-- Rides table: timestamped recordings with geometry and sensor data
CREATE TABLE rides (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    -- Basic metadata
    name VARCHAR(255),
    track_type track_type NOT NULL DEFAULT 'ride',
    source_format VARCHAR(20) NOT NULL,
    -- Timestamps
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cleaned_at TIMESTAMPTZ,
    enriched_at TIMESTAMPTZ,
    -- Raw data from file
    raw_geometry GEOMETRY(LineString, 4326),
    raw_time_series JSONB,
    -- Array of {time, lat, lon, ele, hr, cadence, power, temp}
    -- Cleaned data (filled after cleaning phase)
    cleaned_geometry GEOMETRY(LineString, 4326),
    cleaned_time_series JSONB,
    stops JSONB,
    -- Array of {start_idx, end_idx, duration_seconds}
    -- Weather enrichment (filled after enrichment phase)
    precip_last_24h REAL,
    -- mm
    precip_last_48h REAL,
    -- mm
    temp_max REAL,
    -- Celsius
    temp_min REAL,
    -- Celsius
    inferred_condition trail_condition DEFAULT 'unknown',
    condition_confidence confidence_level DEFAULT 'low',
    time_of_day time_of_day,
    -- Sensor summary stats
    has_heart_rate BOOLEAN NOT NULL DEFAULT FALSE,
    has_cadence BOOLEAN NOT NULL DEFAULT FALSE,
    has_power BOOLEAN NOT NULL DEFAULT FALSE,
    -- Area assignment (filled after area resolution)
    area_id UUID -- Will add FK after areas table exists
);
-- Indexes
CREATE INDEX idx_rides_file_id ON rides(file_id);
CREATE INDEX idx_rides_started_at ON rides(started_at);
CREATE INDEX idx_rides_area_id ON rides(area_id);
CREATE INDEX idx_rides_raw_geometry ON rides USING GIST(raw_geometry);
CREATE INDEX idx_rides_cleaned_geometry ON rides USING GIST(cleaned_geometry);
COMMENT ON TABLE rides IS 'Timestamped ride recordings with raw and cleaned geometry';
COMMENT ON COLUMN rides.raw_geometry IS 'Original GPS track from file as PostGIS LineString';
COMMENT ON COLUMN rides.cleaned_geometry IS 'Jitter-removed, simplified track after cleaning';
COMMENT ON COLUMN rides.raw_time_series IS 'Point-by-point data: [{time, lat, lon, ele, hr?, cadence?, power?, temp?}, ...]';
