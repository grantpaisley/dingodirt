-- Plan dedupe + incremental organize export.
--
-- superseded_by: set on a plan (track_type = 'route') that `dingo dedupe-plans`
-- judged a near-duplicate of another plan (the keeper). Superseded rides are
-- excluded from the organized-tree export and from future dedupe passes.
--
-- exported_path: path of this ride's exported GPX in the organized tree,
-- RELATIVE to the tree root (--dest). Lets `dingo organize` re-runs skip
-- already-exported rides (incremental Inbox workflow) and lets
-- `dedupe-plans --apply` move a superseded plan's file to Duplicates/.
ALTER TABLE rides
    ADD COLUMN superseded_by UUID REFERENCES rides(id) ON DELETE SET NULL,
    ADD COLUMN exported_path TEXT;

COMMENT ON COLUMN rides.superseded_by IS 'Near-duplicate plan: the keeper ride this one was superseded by (dedupe-plans)';
COMMENT ON COLUMN rides.exported_path IS 'Exported GPX path relative to the organized tree root, NULL if not exported';
