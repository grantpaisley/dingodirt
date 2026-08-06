-- Mode classification improvements:
-- 1. Track whether a ride's mode was assigned automatically or set by the user,
--    so reclassification never clobbers manual corrections.
-- 2. Align the runs.mode enum (riding_mode) with rides.mode (ride_mode) so runs
--    can inherit mtb/other from their ride. Previously runs could only hold
--    adv/enduro/ebike and defaulted everything to 'adv'.

ALTER TABLE rides
ADD COLUMN IF NOT EXISTS mode_source TEXT NOT NULL DEFAULT 'auto'
    CHECK (mode_source IN ('auto', 'user'));

COMMENT ON COLUMN rides.mode_source IS 'auto = classifier-assigned, user = manual override (never auto-reclassified)';

-- PG16 allows ADD VALUE in a transaction as long as the new value is not used
-- in the same transaction.
ALTER TYPE riding_mode ADD VALUE IF NOT EXISTS 'mtb';
ALTER TYPE riding_mode ADD VALUE IF NOT EXISTS 'other';
