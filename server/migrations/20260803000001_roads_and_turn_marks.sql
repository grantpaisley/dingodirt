-- Roads + shared turn cues (Docs/plans/2026-08-03-gmaps-import-turn-cues-design.md)
--
-- roads: named OSM ways loaded from a Geofabrik extract via
-- `dingo gazetteer load-roads` — the offline source for turn-cue road names.
-- Unnamed bush tracks are never loaded, which is what keeps cues quiet off-road.
--
-- turn_marks: one row per distinct junction (point + normalized road pair),
-- direction-agnostic and shared by every track that turns there. Rejecting a
-- mark suppresses cues in all directions for all current and future tracks.
--
-- ride_turn_marks: the per-ride "firing" details — a row exists only when
-- that ride actually changes named roads at the junction. A ride can pass the
-- same junction more than once (out-and-back, loops), hence the surrogate key.

CREATE TABLE roads (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    highway_class TEXT NOT NULL,
    geom geometry(LineString, 4326) NOT NULL
);

CREATE INDEX idx_roads_geom ON roads USING GIST (geom);

CREATE TABLE turn_marks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location geometry(Point, 4326) NOT NULL,
    -- Normalized pair: road_a <= road_b, so Putty×Cobah ≡ Cobah×Putty
    road_a TEXT NOT NULL,
    road_b TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'roads',      -- roads | rider | google
    status TEXT NOT NULL DEFAULT 'active',     -- active | rejected
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (road_a <= road_b)
);

CREATE INDEX idx_turn_marks_location ON turn_marks USING GIST (location);

CREATE TABLE ride_turn_marks (
    id BIGSERIAL PRIMARY KEY,
    ride_id UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    mark_id UUID NOT NULL REFERENCES turn_marks(id) ON DELETE CASCADE,
    dir TEXT NOT NULL,                         -- L | R | S
    from_road TEXT NOT NULL,
    onto_road TEXT NOT NULL,
    -- Distance along the ride's cleaned track, orders cues at export
    dist_m DOUBLE PRECISION NOT NULL
);

CREATE INDEX idx_ride_turn_marks_ride ON ride_turn_marks (ride_id);
CREATE INDEX idx_ride_turn_marks_mark ON ride_turn_marks (mark_id);
