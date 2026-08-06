-- Offline gazetteer + ride naming metadata.
--
-- localities: Australian suburbs/localities with their LGA, loaded from
-- data/gazetteer-au.tsv (GeoNames CC-BY) via `dingo gazetteer load`.
-- Used for reverse geocoding ride start/mid/end points when generating
-- ride names like "The Hills:Maroota loop via Canoelands 31 kms 2.8 hrs on 2025-06-01".

CREATE TABLE IF NOT EXISTS localities (
    id BIGSERIAL PRIMARY KEY,
    suburb TEXT NOT NULL,
    lga TEXT,
    location geometry(Point, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_localities_location ON localities USING GIST (location);
-- Dedup guard for idempotent re-loads
CREATE UNIQUE INDEX IF NOT EXISTS idx_localities_unique ON localities (suburb, coalesce(lga, ''), location);

-- Ride name provenance: original (as ingested), generated (by the namer),
-- user (manual rename — never auto-regenerated).
DO $$ BEGIN
    CREATE TYPE ride_name_source AS ENUM ('original', 'generated', 'user');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE rides
ADD COLUMN IF NOT EXISTS name_source ride_name_source NOT NULL DEFAULT 'original';

-- Raw ingested name, preserved when the namer overwrites `name`
ALTER TABLE rides
ADD COLUMN IF NOT EXISTS original_name TEXT;
