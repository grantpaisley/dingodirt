-- Enable PostGIS and UUID extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";
-- File format enum
CREATE TYPE file_format AS ENUM ('fit', 'gpx', 'kml', 'geojson', 'tcx', 'unknown');
-- Files table: raw source file metadata
CREATE TABLE files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hash VARCHAR(64) NOT NULL UNIQUE,
    -- SHA256 hex
    format file_format NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    size_bytes BIGINT NOT NULL,
    stored_path VARCHAR(512) NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Index on hash for duplicate detection
CREATE INDEX idx_files_hash ON files(hash);
COMMENT ON TABLE files IS 'Raw source file metadata with SHA256 hash (actual bytes stored in filesystem)';
COMMENT ON COLUMN files.hash IS 'SHA256 hash of file contents for deduplication';
COMMENT ON COLUMN files.stored_path IS 'Path to file in content-addressed store: files/{hash}.{ext}';
