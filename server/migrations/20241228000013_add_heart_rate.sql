-- Add heart rate columns to runs per design spec
ALTER TABLE runs
ADD COLUMN hr_avg REAL;
ALTER TABLE runs
ADD COLUMN hr_max REAL;
COMMENT ON COLUMN runs.hr_avg IS 'Average heart rate during run (bpm)';
COMMENT ON COLUMN runs.hr_max IS 'Maximum heart rate during run (bpm)';
-- Add HR to segment_dir_stats per design spec
ALTER TABLE segment_dir_stats
ADD COLUMN hr_avg REAL;
ALTER TABLE segment_dir_stats
ADD COLUMN hr_max REAL;
COMMENT ON COLUMN segment_dir_stats.hr_avg IS 'Average heart rate across runs (bpm)';
COMMENT ON COLUMN segment_dir_stats.hr_max IS 'Maximum heart rate across runs (bpm)';
