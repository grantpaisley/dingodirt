-- Add name metadata to segments
CREATE TYPE name_source AS ENUM (
    'poi',
    'road',
    'landmark',
    'area',
    'character',
    'what3words',
    'user'
);
CREATE TYPE name_confidence AS ENUM ('high', 'medium', 'low');
ALTER TABLE segments
ADD COLUMN name_source name_source,
    ADD COLUMN name_confidence name_confidence;
COMMENT ON COLUMN segments.name_source IS 'How the name was generated';
COMMENT ON COLUMN segments.name_confidence IS 'Confidence in auto-generated name';
