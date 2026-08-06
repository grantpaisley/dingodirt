-- Ride locality attributes: state/region/LGAs/suburbs per ride, plus the
-- supporting gazetteer changes.
--
-- localities gains a state column (gazetteer TSV regenerated with GeoNames
-- admin1 codes; LGA disambiguators like "Central Coast (NSW)" are stripped
-- since state is now its own column). The table is truncated because the
-- stripped LGA names would otherwise coexist with the old suffixed ones —
-- re-run `dingo gazetteer load data/gazetteer-au.tsv` after this migration.
--
-- lga_regions maps (state, LGA) -> curated colloquial region ("Snowy
-- Mountains", "Kimberley"); an empty-string LGA row is the state-wide
-- default (ACT). Loaded from data/lga-regions-au.tsv via
-- `dingo gazetteer load-regions`.
--
-- rides gains: suburbs/lgas = ALL localities the ride passes through
-- (ordered by first encounter, start first); state/region = single values
-- (majority state over sampled points; region of the first mapped LGA).

ALTER TABLE localities ADD COLUMN IF NOT EXISTS state TEXT;
TRUNCATE localities;

CREATE TABLE IF NOT EXISTS lga_regions (
    state TEXT NOT NULL,
    lga TEXT NOT NULL DEFAULT '',  -- '' = state-wide default
    region TEXT NOT NULL,
    PRIMARY KEY (state, lga)
);

ALTER TABLE rides
    ADD COLUMN IF NOT EXISTS state TEXT,
    ADD COLUMN IF NOT EXISTS region TEXT,
    ADD COLUMN IF NOT EXISTS lgas TEXT[],
    ADD COLUMN IF NOT EXISTS suburbs TEXT[];

-- Array-containment search ("rides touching suburb X / LGA Y")
CREATE INDEX IF NOT EXISTS idx_rides_lgas ON rides USING GIN (lgas);
CREATE INDEX IF NOT EXISTS idx_rides_suburbs ON rides USING GIN (suburbs);
