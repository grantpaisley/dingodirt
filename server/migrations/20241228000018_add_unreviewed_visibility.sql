-- Add 'unreviewed' visibility state per design spec
-- Used for system-detected anomalies (e.g., out-and-back) awaiting user decision
ALTER TYPE segment_visibility
ADD VALUE 'unreviewed';
COMMENT ON TYPE segment_visibility IS 'visible=normal, hidden=excluded from UI, unreviewed=awaiting review, deleted=soft delete';
