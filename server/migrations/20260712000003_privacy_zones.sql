-- Privacy zones: polygons whose interior is removed from EVERY export that
-- leaves Dingo (offline bundles, basket bundles, the organized library tree,
-- DingoNav bundles, share links). Grant, 2026-07-12: "any exports hide
-- Arcadia suburb entirely for security reasons". Managed by `dingo privacy
-- add-place|list|remove`; the local web app (localhost API) is unaffected.
CREATE TABLE privacy_zones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    boundary geometry(MultiPolygon, 4326) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
