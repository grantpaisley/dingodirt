-- List filter pills: folders + pack cached attributes
-- (docs/plans/plan-2026-08-07-list-filter-pills-design.md)
--
-- 1. folders: user-managed single-home tree. NULL folder_id = root
--    ("Unfiled"). Deleting a folder cascades to child folders; items fall
--    back to Unfiled (SET NULL), never deleted.
-- 2. Pack cached attributes mirror the ride locality/boolean columns so
--    packs filter alongside tracks and routes through one dimension API.
-- 3. One-off collection migration: each distinct rides.collection value
--    becomes a root folder and its rides are filed there. The collection
--    column stays as import provenance; the UI stops reading it.

CREATE TABLE IF NOT EXISTS folders (
    id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name      TEXT NOT NULL,
    parent_id UUID REFERENCES folders(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL DEFAULT 0,          -- manual sort within parent
    UNIQUE (parent_id, name)
);
-- UNIQUE (parent_id, name) does not police the root level (NULLs are
-- distinct); a partial unique index does.
CREATE UNIQUE INDEX IF NOT EXISTS folders_root_name
    ON folders (name) WHERE parent_id IS NULL;

ALTER TABLE rides ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES folders(id) ON DELETE SET NULL;
ALTER TABLE packs ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS rides_folder_idx ON rides (folder_id);

-- Touches dimension filters on the locality arrays.
CREATE INDEX IF NOT EXISTS rides_lgas_gin ON rides USING GIN (lgas);
CREATE INDEX IF NOT EXISTS rides_suburbs_gin ON rides USING GIN (suburbs);

-- Pack cached attributes (mirroring rides). Recomputed on every membership
-- change; see recompute_pack_attributes below.
ALTER TABLE packs
    ADD COLUMN IF NOT EXISTS state      TEXT,
    ADD COLUMN IF NOT EXISTS region     TEXT,
    ADD COLUMN IF NOT EXISTS lgas       TEXT[],
    ADD COLUMN IF NOT EXISTS suburbs    TEXT[],
    ADD COLUMN IF NOT EXISTS end_state  TEXT,
    ADD COLUMN IF NOT EXISTS end_region TEXT,
    ADD COLUMN IF NOT EXISTS end_lga    TEXT,
    ADD COLUMN IF NOT EXISTS end_suburb TEXT,
    ADD COLUMN IF NOT EXISTS has_hr     BOOLEAN,
    ADD COLUMN IF NOT EXISTS has_speed  BOOLEAN;

-- Union of member suburbs[]/lgas[] in first-encounter order across members
-- (member order = pack position), start singles from the first member,
-- end_* from the last, booleans OR'd. Synchronous — it is cheap. The one
-- definition serves the daemon (membership changes) and the backfill below,
-- so the two cannot drift.
CREATE OR REPLACE FUNCTION recompute_pack_attributes(p_id UUID) RETURNS void AS $$
BEGIN
    UPDATE packs p SET
        suburbs = agg.suburbs,
        lgas = agg.lgas,
        state = agg.start_state,
        region = agg.start_region,
        end_state = agg.end_state,
        end_region = agg.end_region,
        end_lga = agg.end_lga,
        end_suburb = agg.end_suburb,
        has_hr = agg.has_hr,
        has_speed = agg.has_speed
    FROM (
        SELECT
            (SELECT array_agg(v ORDER BY first_ord) FROM (
                SELECT t.v, MIN(pr.position * 100000 + t.ord) AS first_ord
                FROM pack_rides pr
                JOIN rides r ON r.id = pr.ride_id,
                LATERAL unnest(r.suburbs) WITH ORDINALITY AS t(v, ord)
                WHERE pr.pack_id = p_id
                GROUP BY t.v
            ) s) AS suburbs,
            (SELECT array_agg(v ORDER BY first_ord) FROM (
                SELECT t.v, MIN(pr.position * 100000 + t.ord) AS first_ord
                FROM pack_rides pr
                JOIN rides r ON r.id = pr.ride_id,
                LATERAL unnest(r.lgas) WITH ORDINALITY AS t(v, ord)
                WHERE pr.pack_id = p_id
                GROUP BY t.v
            ) s) AS lgas,
            (SELECT r.state FROM pack_rides pr JOIN rides r ON r.id = pr.ride_id
             WHERE pr.pack_id = p_id ORDER BY pr.position LIMIT 1) AS start_state,
            (SELECT r.region FROM pack_rides pr JOIN rides r ON r.id = pr.ride_id
             WHERE pr.pack_id = p_id ORDER BY pr.position LIMIT 1) AS start_region,
            (SELECT r.end_state FROM pack_rides pr JOIN rides r ON r.id = pr.ride_id
             WHERE pr.pack_id = p_id ORDER BY pr.position DESC LIMIT 1) AS end_state,
            (SELECT r.end_region FROM pack_rides pr JOIN rides r ON r.id = pr.ride_id
             WHERE pr.pack_id = p_id ORDER BY pr.position DESC LIMIT 1) AS end_region,
            (SELECT r.end_lga FROM pack_rides pr JOIN rides r ON r.id = pr.ride_id
             WHERE pr.pack_id = p_id ORDER BY pr.position DESC LIMIT 1) AS end_lga,
            (SELECT r.end_suburb FROM pack_rides pr JOIN rides r ON r.id = pr.ride_id
             WHERE pr.pack_id = p_id ORDER BY pr.position DESC LIMIT 1) AS end_suburb,
            (SELECT bool_or(r.avg_hr IS NOT NULL) FROM pack_rides pr
             JOIN rides r ON r.id = pr.ride_id WHERE pr.pack_id = p_id) AS has_hr,
            (SELECT bool_or(r.avg_speed_kmh IS NOT NULL) FROM pack_rides pr
             JOIN rides r ON r.id = pr.ride_id WHERE pr.pack_id = p_id) AS has_speed
    ) agg
    WHERE p.id = p_id;
END
$$ LANGUAGE plpgsql;

-- One-off backfill for existing packs (idempotent — recompute overwrites).
SELECT recompute_pack_attributes(id) FROM packs;

-- Collection -> folders: a root folder per distinct collection value; rides
-- keep their collection tag (import provenance) but gain a folder home.
-- Imports keep filing new planned routes into the matching folder by name
-- (see the ingest path). Idempotent: ON CONFLICT skips existing folders and
-- the UPDATE only touches unfiled rides.
INSERT INTO folders (name)
SELECT DISTINCT collection FROM rides WHERE collection IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE rides r SET folder_id = f.id
FROM folders f
WHERE f.parent_id IS NULL AND r.collection = f.name AND r.folder_id IS NULL;
