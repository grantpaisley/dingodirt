-- Add multi-resolution geometry columns for zoom-based selection
-- Performance optimization: store simplified versions for map display at different zoom levels
ALTER TABLE rides
ADD COLUMN IF NOT EXISTS geometry_z10 geometry(LineString, 4326);
ALTER TABLE rides
ADD COLUMN IF NOT EXISTS geometry_z14 geometry(LineString, 4326);
-- Populate from existing geometries
UPDATE rides
SET geometry_z10 = ST_Simplify(cleaned_geometry, 0.001),
    -- ~100m tolerance for zoom 10
    geometry_z14 = ST_Simplify(cleaned_geometry, 0.0001) -- ~10m tolerance for zoom 14
WHERE cleaned_geometry IS NOT NULL
    AND geometry_z10 IS NULL;
-- Add corridor width to segments for display
ALTER TABLE segments
ADD COLUMN IF NOT EXISTS corridor_width REAL DEFAULT 10.0;
-- Add source tracking for segments (manual vs auto)
ALTER TABLE segments
ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'auto';
-- Create indexes for spatial queries on simplified geometries
CREATE INDEX IF NOT EXISTS idx_rides_geometry_z10 ON rides USING gist (geometry_z10);
CREATE INDEX IF NOT EXISTS idx_rides_geometry_z14 ON rides USING gist (geometry_z14);
