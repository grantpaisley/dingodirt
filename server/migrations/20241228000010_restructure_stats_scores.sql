-- Stats and Scores restructuring per design docs
-- Riding mode enum
CREATE TYPE riding_mode AS ENUM ('adv', 'enduro', 'ebike');
-- Dingo profile enum
CREATE TYPE dingo_profile AS ENUM ('flow', 'tech', 'scenic', 'efficient');
-- Add mode and condition to runs
ALTER TABLE runs
ADD COLUMN mode riding_mode DEFAULT 'adv';
ALTER TABLE runs
ADD COLUMN condition trail_condition DEFAULT 'unknown';
-- Segment dir stats table (aggregated per mode/condition)
CREATE TABLE segment_dir_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    segment_dir_id UUID NOT NULL REFERENCES segment_dirs(id) ON DELETE CASCADE,
    mode riding_mode NOT NULL,
    condition trail_condition NOT NULL,
    run_count INTEGER DEFAULT 0,
    time_min_s REAL,
    time_max_s REAL,
    time_median_s REAL,
    time_stddev_s REAL,
    speed_avg REAL,
    speed_max REAL,
    stop_time_avg_s REAL,
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(segment_dir_id, mode, condition)
);
-- Dingo scores table (per mode/condition/profile)
CREATE TABLE segment_dir_dingo_score (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    segment_dir_id UUID NOT NULL REFERENCES segment_dirs(id) ON DELETE CASCADE,
    mode riding_mode NOT NULL,
    condition trail_condition NOT NULL,
    profile dingo_profile NOT NULL,
    score REAL,
    computed_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(segment_dir_id, mode, condition, profile)
);
-- Indexes
CREATE INDEX idx_segment_dir_stats_lookup ON segment_dir_stats(segment_dir_id, mode, condition);
CREATE INDEX idx_segment_dir_dingo_score_lookup ON segment_dir_dingo_score(segment_dir_id, mode, condition, profile);
COMMENT ON TABLE segment_dir_stats IS 'Aggregated stats per segment direction/mode/condition';
COMMENT ON TABLE segment_dir_dingo_score IS 'Dingo scores per segment direction/mode/condition/profile';
