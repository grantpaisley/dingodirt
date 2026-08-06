-- The match pipeline's batch point query filters segments with
-- ST_DWithin(s.geometry::geography, ...). The cast means the plain geometry
-- GiST index (idx_segments_geometry) is unusable, so every ride point
-- scanned every segment in the area — ~10 min per ride once the network
-- extraction took segment counts from hundreds to thousands. A functional
-- geography index makes it an index probe.
CREATE INDEX IF NOT EXISTS idx_segments_geography
    ON segments USING gist ((geometry::geography));
