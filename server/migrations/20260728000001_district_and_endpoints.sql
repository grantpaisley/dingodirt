-- GPX library storage (Docs/plans/2026-07-28-gpx-library-storage-design.md)
-- Phase 1: the District level + per-ride endpoint localities.
--
-- district_map is a small manually-curated lookup inserting a grouping level
-- between State and Region in the library tree ("NSW North"). It is JOINed at
-- placement time — editing it never requires a ride backfill, just an
-- organize re-run. Manage with `dingo district set|rm|list`.
CREATE TABLE IF NOT EXISTS district_map (
    state    TEXT NOT NULL,
    region   TEXT NOT NULL,
    district TEXT NOT NULL,
    PRIMARY KEY (state, region)
);

-- End-of-track localities + loop flag, filled by the naming pass. Placement
-- caps a non-loop track at the deepest level where start and end agree
-- (start values live in the existing state/region/lgas[1]/suburbs[1]).
ALTER TABLE rides
    ADD COLUMN IF NOT EXISTS end_state  TEXT,
    ADD COLUMN IF NOT EXISTS end_region TEXT,
    ADD COLUMN IF NOT EXISTS end_lga    TEXT,
    ADD COLUMN IF NOT EXISTS end_suburb TEXT,
    ADD COLUMN IF NOT EXISTS is_loop    BOOLEAN;
