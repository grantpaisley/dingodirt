-- Ride name variants: keep every name a track ever had, side by side, and
-- let `name_source` choose which one displays.
-- (docs/plans/plan-2026-08-11-track-names-and-import-provenance-design.md)
--
-- Before this, the namer overwrote `name` and stashed the previous value in
-- `original_name` exactly once. A manual rename then destroyed the generated
-- name for good, so switching back was impossible. Now each variant has its
-- own column, `name` holds the resolved value, and nothing is ever lost.
--
-- The generated name also stopped embedding the original in brackets --
-- `... on 2025-06-01 (Maroota Secret Track)` -- because the two names now sit
-- in separate columns. The backfill below strips that suffix.

-- 'user' -> 'custom' so the pointer value and the column name read the same
-- word. Renaming keeps the enum OID, so existing rows need no rewrite.
ALTER TYPE ride_name_source RENAME VALUE 'user' TO 'custom';

-- The filename is a distinct variant from the in-file track name: a GPX
-- called '2026-06-01_flinders_day2.gpx' often carries <name>Wisemans Loop</name>.
-- NOTE: a value added here cannot be *used* until this transaction commits
-- (Postgres restriction), which is why resolve_ride_name below takes TEXT
-- rather than ride_name_source.
ALTER TYPE ride_name_source ADD VALUE IF NOT EXISTS 'filename';

ALTER TABLE rides
    ADD COLUMN IF NOT EXISTS filename       TEXT,
    ADD COLUMN IF NOT EXISTS generated_name TEXT,
    ADD COLUMN IF NOT EXISTS custom_name    TEXT;

COMMENT ON COLUMN rides.original_name  IS 'The name inside the file (GPX <trk><name>)';
COMMENT ON COLUMN rides.filename       IS 'The source filename, copied from files.original_name at import';
COMMENT ON COLUMN rides.generated_name IS 'Built by the namer from geography, distance, time and date';
COMMENT ON COLUMN rides.custom_name    IS 'Typed by the user; the namer never touches it';
COMMENT ON COLUMN rides.name           IS 'Resolved display name — see resolve_ride_name()';

-- The one definition of the fallback order, so the daemon and any backfill
-- cannot drift. Takes TEXT (not the enum) for the reason noted above.
CREATE OR REPLACE FUNCTION resolve_ride_name(
    p_source    TEXT,
    p_original  TEXT,
    p_filename  TEXT,
    p_generated TEXT,
    p_custom    TEXT
) RETURNS TEXT AS $$
    SELECT COALESCE(
        NULLIF(btrim(CASE p_source
            WHEN 'original'  THEN p_original
            WHEN 'filename'  THEN p_filename
            WHEN 'generated' THEN p_generated
            WHEN 'custom'    THEN p_custom
        END), ''),
        NULLIF(btrim(p_original),  ''),
        NULLIF(btrim(p_filename),  ''),
        NULLIF(btrim(p_generated), ''),
        'Untitled'
    )
$$ LANGUAGE sql IMMUTABLE;

COMMENT ON FUNCTION resolve_ride_name(TEXT, TEXT, TEXT, TEXT, TEXT) IS
    'Chosen variant, then original, filename, generated, then ''Untitled''.';

-- ---------------------------------------------------------------- backfill

-- 1. Rides still showing their ingested name have it only in `name`.
UPDATE rides
   SET original_name = name
 WHERE name_source = 'original'
   AND (original_name IS NULL OR original_name = '')
   AND name IS NOT NULL;

-- 2. Split the generated name from the bracketed original the old
--    assemble_name appended. Strip ONLY a suffix that is exactly
--    ' (' || original_name || ')' -- a loose bracket match would mangle real
--    names such as 'Blue Mountains (Upper)'.
UPDATE rides
   SET generated_name = CASE
        WHEN original_name IS NOT NULL
         AND original_name <> ''
         AND length(name) > length(original_name) + 3
         AND right(name, length(original_name) + 3) = ' (' || original_name || ')'
        THEN left(name, length(name) - length(original_name) - 3)
        ELSE name
       END
 WHERE name_source = 'generated'
   AND name IS NOT NULL;

-- 3. Manual renames (none exist yet, but the migration must be correct if a
--    parallel branch lands one first).
UPDATE rides
   SET custom_name = name
 WHERE name_source = 'custom'
   AND (custom_name IS NULL OR custom_name = '')
   AND name IS NOT NULL;

-- 4. The filename variant, copied from the file row.
UPDATE rides r
   SET filename = f.original_name
  FROM files f
 WHERE f.id = r.file_id
   AND r.filename IS NULL;

-- 5. Re-resolve every display name through the single definition.
UPDATE rides
   SET name = resolve_ride_name(
        name_source::TEXT, original_name, filename, generated_name, custom_name);

-- ---------------------------------------------------------------- guards

DO $$
DECLARE
    unnamed  INT;
    leftover INT;
    orphan   INT;
BEGIN
    SELECT count(*) INTO unnamed
      FROM rides WHERE name IS NULL OR btrim(name) = '';
    IF unnamed > 0 THEN
        RAISE EXCEPTION 'name backfill left % rides with no name', unnamed;
    END IF;

    -- Every generated name must now be free of its own bracketed original.
    SELECT count(*) INTO leftover
      FROM rides
     WHERE name_source = 'generated'
       AND original_name IS NOT NULL AND original_name <> ''
       AND generated_name IS NOT NULL
       AND length(generated_name) > length(original_name) + 3
       AND right(generated_name, length(original_name) + 3)
           = ' (' || original_name || ')';
    IF leftover > 0 THEN
        RAISE EXCEPTION 'bracket strip missed % generated names', leftover;
    END IF;

    -- The variant a ride points at should normally be populated. Rides that
    -- fall through to the fallback chain are a smell worth seeing in the log,
    -- not an error: a planned route with no file row has no filename.
    SELECT count(*) INTO orphan
      FROM rides
     WHERE name <> resolve_ride_name(
            name_source::TEXT, original_name, filename, generated_name, custom_name);
    IF orphan > 0 THEN
        RAISE EXCEPTION '% rides disagree with resolve_ride_name', orphan;
    END IF;
END $$;
