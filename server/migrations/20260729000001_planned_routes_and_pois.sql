-- Planned routes & POIs (see Docs/plans/2026-07-28-planned-routes-pois-design.md)
--
-- Curated route files (e.g. the G.O.A.T networks) become planned rides:
-- geometry without timings, grouped into collections, each with a display
-- color and the source file's description. Their waypoints become a
-- standalone POI layer.
CREATE TYPE ride_kind AS ENUM ('recorded', 'planned');
ALTER TABLE rides
ADD COLUMN kind ride_kind NOT NULL DEFAULT 'recorded';
-- Collection label groups a network's routes ("GOAT NSW North"); survives
-- re-downloads (file hash changes, label doesn't). NULL for recorded rides.
ALTER TABLE rides
ADD COLUMN collection text;
-- Display color '#rrggbb': from GPX extensions when the file carried one,
-- else palette-assigned at import. User-editable later.
ALTER TABLE rides
ADD COLUMN color text;
-- Track <desc> from the source file — closure notes, permit requirements.
ALTER TABLE rides
ADD COLUMN description text;
CREATE INDEX idx_rides_planned_collection ON rides (collection)
WHERE kind = 'planned';
-- Points of interest: standalone layer with provenance. POIs belong to the
-- map (fuel matters wherever you are), not to a single route; ride_id is
-- only set for POIs authored on a specific planned ride.
CREATE TYPE poi_category AS ENUM (
    'fuel',
    'camp',
    'water',
    'food',
    'lodging',
    'scenic',
    'hazard',
    'medical',
    'info',
    'summit',
    'poi'
);
CREATE TABLE pois (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    position geometry(Point, 4326) NOT NULL,
    elevation REAL,
    name TEXT NOT NULL,
    description TEXT,
    category poi_category NOT NULL,
    -- Original Garmin <sym>, preserved verbatim so the category mapping can
    -- evolve without data loss
    raw_sym TEXT,
    collection TEXT,
    file_id UUID REFERENCES files(id),
    ride_id UUID REFERENCES rides(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pois_position ON pois USING gist (position);
CREATE INDEX idx_pois_collection ON pois (collection);
CREATE INDEX idx_pois_category ON pois (category);
-- Provenance: where a file was imported from (original_name already exists).
ALTER TABLE files
ADD COLUMN source_path text;
