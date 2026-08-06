-- Packs: persisted, refreshable share bundles (Docs/plans/2026-07-15-packs-design.md).
-- A pack is a named recipe — an ordered ride list + layer options. A "share" is
-- a pack's published state: slug (frozen at first publish) + published_at.

CREATE TABLE packs (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name              TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    slug              TEXT UNIQUE,          -- frozen at first publish; NULL = never shared
    include_tracks    BOOLEAN NOT NULL DEFAULT true,
    include_heatmap   BOOLEAN NOT NULL DEFAULT false,
    include_strava    BOOLEAN NOT NULL DEFAULT false,
    include_basemap   BOOLEAN NOT NULL DEFAULT false,
    include_satellite BOOLEAN NOT NULL DEFAULT false,
    include_hillshade BOOLEAN NOT NULL DEFAULT false,
    satellite_zoom    INTEGER,
    privacy           BOOLEAN NOT NULL DEFAULT true,
    heatmap_filters   JSONB,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),  -- recipe edits
    published_at      TIMESTAMPTZ,          -- NULL = draft
    published_bytes   BIGINT
);

CREATE TABLE pack_rides (
    pack_id  UUID NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
    ride_id  UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,              -- 0 = default track in DingoNav
    PRIMARY KEY (pack_id, ride_id)
);

CREATE INDEX pack_rides_pack_idx ON pack_rides (pack_id, position);
