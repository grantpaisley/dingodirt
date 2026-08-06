-- Delete existing runs to allow re-matching with timestamps
DELETE FROM runs;
-- Clear dependent stats
DELETE FROM segment_dir_stats;
DELETE FROM segment_dir_dingo_score;
