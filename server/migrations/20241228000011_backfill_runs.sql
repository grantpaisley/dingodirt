-- Backfill mode and condition on existing runs
-- Set mode = 'adv' for all runs without mode
UPDATE runs
SET mode = 'adv'
WHERE mode IS NULL;
-- Inherit condition from ride's inferred_condition
UPDATE runs r
SET condition = ri.inferred_condition
FROM rides ri
WHERE r.ride_id = ri.id
    AND r.condition IS NULL;
-- Set any remaining null conditions to 'unknown'
UPDATE runs
SET condition = 'unknown'
WHERE condition IS NULL;
