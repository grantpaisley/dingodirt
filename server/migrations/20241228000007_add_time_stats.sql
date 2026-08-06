-- Add time statistics to segment_dirs
ALTER TABLE segment_dirs
ADD COLUMN time_avg_s REAL,
    ADD COLUMN time_p25_s REAL,
    ADD COLUMN time_p75_s REAL;
COMMENT ON COLUMN segment_dirs.time_avg_s IS 'Average elapsed time in seconds';
COMMENT ON COLUMN segment_dirs.time_p25_s IS '25th percentile time (fast) in seconds';
COMMENT ON COLUMN segment_dirs.time_p75_s IS '75th percentile time (slow) in seconds';
