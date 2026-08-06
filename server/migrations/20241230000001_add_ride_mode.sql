-- Ride mode enum for activity type categorization
CREATE TYPE ride_mode AS ENUM ('adv', 'enduro', 'mtb', 'other');
-- Add mode column to rides table
ALTER TABLE rides
ADD COLUMN mode ride_mode NOT NULL DEFAULT 'other';
-- Index for filtering by mode
CREATE INDEX idx_rides_mode ON rides(mode);
COMMENT ON COLUMN rides.mode IS 'Activity type: adv (adventure/touring), enduro, mtb (mountain bike), other';
