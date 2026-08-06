-- Reshape corrections v2: a sculpting session in the UI produces a full
-- replacement polyline (many drags, saved once), not a single anchor->target
-- warp. corridor = the ORIGINAL centreline (locator, matched on rebuild),
-- replacement = the user's final geometry. The legacy anchor+target form
-- remains valid for old rows.

ALTER TABLE segment_corrections ADD COLUMN replacement GEOMETRY(LineString, 4326);

ALTER TABLE segment_corrections DROP CONSTRAINT correction_shape;
ALTER TABLE segment_corrections ADD CONSTRAINT correction_shape CHECK (
    (kind = 'reshape' AND (
        (anchor_point IS NOT NULL AND target_point IS NOT NULL) OR
        (corridor IS NOT NULL AND replacement IS NOT NULL)
    )) OR
    (kind = 'split'         AND anchor_point IS NOT NULL) OR
    (kind = 'join'          AND anchor_point IS NOT NULL) OR
    (kind = 'delete'        AND corridor IS NOT NULL) OR
    (kind = 'keep_separate' AND corridor IS NOT NULL)
);
