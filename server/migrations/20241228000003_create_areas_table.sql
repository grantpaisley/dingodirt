-- Areas table for geographic organization of rides
CREATE TABLE areas (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    parent_id UUID REFERENCES areas(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    boundary GEOMETRY(Polygon, 4326) NOT NULL,
    mode_affinity VARCHAR(50),
    -- e.g., 'mtb', 'gravel', 'road'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Spatial index for efficient point-in-polygon queries
CREATE INDEX idx_areas_boundary ON areas USING GIST(boundary);
-- Index for hierarchy queries
CREATE INDEX idx_areas_parent ON areas(parent_id);
-- Index for name lookups
CREATE INDEX idx_areas_name ON areas(name);
-- Add foreign key from rides to areas (column already exists from previous migration)
ALTER TABLE rides
ADD CONSTRAINT fk_rides_area FOREIGN KEY (area_id) REFERENCES areas(id) ON DELETE
SET NULL;
COMMENT ON TABLE areas IS 'Geographic areas for organizing rides, supports hierarchical nesting';
COMMENT ON COLUMN areas.boundary IS 'PostGIS Polygon defining the area boundary';
COMMENT ON COLUMN areas.mode_affinity IS 'Primary activity mode for this area (mtb, gravel, road)';
COMMENT ON COLUMN areas.parent_id IS 'Parent area for hierarchical organization';
