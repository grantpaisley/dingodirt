-- Per-layer coverage mode for pack bundles: 'corridor' (track-following
-- ST_Buffer polygon, the default) or 'rect' (legacy selection-bbox). Stored as
-- one JSONB blob ({"satellite": "rect", ...}) so future modes (e.g. turn-point
-- "detail") add keys without churn. NULL = all layers corridor.
ALTER TABLE packs ADD COLUMN coverage JSONB;
