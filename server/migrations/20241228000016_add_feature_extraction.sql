-- Add twistiness feature to segment_dirs per design spec
-- Twistiness = bearing change per meter (radians/meter)
ALTER TABLE segment_dirs
ADD COLUMN twistiness REAL;
COMMENT ON COLUMN segment_dirs.twistiness IS 'Bearing change per meter (radians/meter) - higher = more winding';
-- Add stop_density to segment_dir_stats
-- Stop density = stops per km
ALTER TABLE segment_dir_stats
ADD COLUMN stop_density REAL;
COMMENT ON COLUMN segment_dir_stats.stop_density IS 'Stops per km based on run history';
