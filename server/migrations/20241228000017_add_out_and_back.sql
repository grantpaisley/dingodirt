-- Add out_and_back detection to runs per design spec
-- Values: poi_detour, attempted_climb, unknown
CREATE TYPE out_and_back_reason AS ENUM (
    'poi_detour',
    -- Terminus near a known POI
    'attempted_climb',
    -- High grade + stall detected at terminus
    'unknown' -- No heuristic matched, awaiting review
);
ALTER TABLE runs
ADD COLUMN out_and_back_reason out_and_back_reason;
COMMENT ON COLUMN runs.out_and_back_reason IS 'If run is out-and-back, the detected reason';
