-- Add speed tracking to segment_dirs for parallel trail disambiguation
ALTER TABLE segment_dirs
ADD COLUMN speed_avg REAL;
ALTER TABLE segment_dirs
ADD COLUMN speed_min REAL;
ALTER TABLE segment_dirs
ADD COLUMN speed_max REAL;
ALTER TABLE segment_dirs
ADD COLUMN run_count INTEGER DEFAULT 0;
-- Add trail type to segments
ALTER TABLE segments
ADD COLUMN trail_type VARCHAR(50) DEFAULT 'unknown';
-- Values: 'singletrack', 'fireroad', 'road', 'unknown'
COMMENT ON COLUMN segment_dirs.speed_avg IS 'Average speed in km/h from historical runs';
COMMENT ON COLUMN segments.trail_type IS 'Trail surface type: singletrack, fireroad, road, unknown';
