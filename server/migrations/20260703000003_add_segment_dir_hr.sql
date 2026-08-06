-- Heart rate aggregates on segment_dirs, mirroring the speed_* quick-access
-- columns. Nullable: only populated from runs that recorded HR (rides without
-- a HR sensor contribute nothing, so NULL means "no HR data", not zero.)
ALTER TABLE segment_dirs
ADD COLUMN hr_avg REAL;
ALTER TABLE segment_dirs
ADD COLUMN hr_min REAL;
ALTER TABLE segment_dirs
ADD COLUMN hr_max REAL;
COMMENT ON COLUMN segment_dirs.hr_avg IS 'Mean of per-run average HR (bpm) across runs with HR data';
COMMENT ON COLUMN segment_dirs.hr_min IS 'Lowest per-run average HR (bpm) — runs store no per-run minimum';
COMMENT ON COLUMN segment_dirs.hr_max IS 'Highest per-run max HR (bpm)';
