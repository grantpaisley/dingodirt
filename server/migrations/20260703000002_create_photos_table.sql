-- Photos: imported from Google Photos Takeout (Phase 2), later also Picker API.
-- Low-res thumb/medium stored locally (content-addressed by sha256 of the
-- original bytes); full-res stays in Google Photos, reachable via
-- google_photos_url from the Takeout JSON sidecar.

CREATE TYPE photo_match_method AS ENUM ('gps', 'timestamp', 'manual');

CREATE TABLE photos (
    id UUID PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL DEFAULT 'takeout',
    original_filename TEXT,
    google_photos_url TEXT,
    taken_at TIMESTAMPTZ,
    -- EXIF/Takeout GPS when match_method = 'gps'; interpolated ride position
    -- when match_method = 'timestamp'
    location GEOMETRY(POINT, 4326),
    ride_id UUID REFERENCES rides(id) ON DELETE SET NULL,
    run_id UUID REFERENCES runs(id) ON DELETE SET NULL,
    segment_dir_id UUID REFERENCES segment_dirs(id) ON DELETE SET NULL,
    match_method photo_match_method,
    thumbnail_path TEXT,
    medium_path TEXT,
    width INT,
    height INT,
    user_reviewed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_photos_ride ON photos(ride_id);
CREATE INDEX idx_photos_run ON photos(run_id);
CREATE INDEX idx_photos_segment_dir ON photos(segment_dir_id);
CREATE INDEX idx_photos_taken_at ON photos(taken_at);
CREATE INDEX idx_photos_location ON photos USING GIST(location);
