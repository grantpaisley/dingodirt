-- Add Dingo Score to segment_dirs
ALTER TABLE segment_dirs
ADD COLUMN dingo_score REAL;
COMMENT ON COLUMN segment_dirs.dingo_score IS 'Composite fun factor score (0-100)';
