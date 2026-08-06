-- User corrections to the auto-built segment network.
-- Anchored to LOCATIONS (points/corridors in WGS84), never segment ids:
-- graph rebuilds delete and recreate all segments, so corrections are
-- re-applied on every rebuild and re-scored as applied/violated.

CREATE TYPE correction_kind AS ENUM ('reshape', 'split', 'join', 'delete', 'keep_separate');
CREATE TYPE correction_status AS ENUM ('pending', 'applied', 'violated', 'superseded');

CREATE TABLE segment_corrections (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    area_id       UUID NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
    kind          correction_kind NOT NULL,
    status        correction_status NOT NULL DEFAULT 'pending',

    -- Location anchors. Which are required depends on kind (CHECK below).
    anchor_point  GEOMETRY(Point, 4326),      -- reshape: grabbed point on old geometry
                                              -- split:   forced junction point
                                              -- join:    spurious junction to suppress/merge
    target_point  GEOMETRY(Point, 4326),      -- reshape only: dragged-to position
    corridor      GEOMETRY(LineString, 4326), -- delete: phantom centreline
                                              -- keep_separate: protected trail centreline

    influence_m   REAL NOT NULL DEFAULT 100,  -- reshape warp half-window
    tolerance_m   REAL NOT NULL DEFAULT 30,   -- anchor match radius / corridor half-width
    note          TEXT,

    -- Audit / training corpus: what the user was looking at when correcting.
    -- Segment UUIDs die on rebuild; these snapshots don't.
    snapshot_geometry GEOMETRY(MultiLineString, 4326),
    snapshot_name     TEXT,

    -- Application result, rewritten on every rebuild of the area.
    applied_at    TIMESTAMPTZ,
    result_note   TEXT,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT correction_shape CHECK (
        (kind = 'reshape'       AND anchor_point IS NOT NULL AND target_point IS NOT NULL) OR
        (kind = 'split'         AND anchor_point IS NOT NULL) OR
        (kind = 'join'          AND anchor_point IS NOT NULL) OR
        (kind = 'delete'        AND corridor IS NOT NULL) OR
        (kind = 'keep_separate' AND corridor IS NOT NULL)
    )
);

CREATE INDEX idx_corrections_area_live ON segment_corrections(area_id)
    WHERE status != 'superseded';

COMMENT ON TABLE segment_corrections IS
    'User corrections to the auto-built network, anchored to locations (not segment ids) so they re-apply on every rebuild';
