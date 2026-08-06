-- Add stopped_time and speed_variance to runs per design spec
ALTER TABLE runs
ADD COLUMN stopped_s REAL;
ALTER TABLE runs
ADD COLUMN speed_variance REAL;
COMMENT ON COLUMN runs.stopped_s IS 'Time spent stationary during run (seconds)';
COMMENT ON COLUMN runs.speed_variance IS 'Speed variance during run (km/h squared)';
