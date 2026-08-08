-- User labelsets — the multi-membership grouping layer on top of folders
-- (docs/plans/plan-2026-08-07-list-filter-pills-design.md, "Future" section).
--
-- A label set ("Trip", "Surface") is one filter dimension; its labels can
-- nest like folders. An item can carry any number of labels — that is the
-- difference from folders, which are a single home. item_labels covers
-- rides (tracks and routes) and packs through item_type.

CREATE TABLE IF NOT EXISTS label_sets (
    id   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS labels (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    label_set_id UUID NOT NULL REFERENCES label_sets(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    parent_id    UUID REFERENCES labels(id) ON DELETE CASCADE,
    position     INTEGER NOT NULL DEFAULT 0,
    UNIQUE (label_set_id, parent_id, name)
);
-- UNIQUE with a NULL parent_id does not police the set's root level.
CREATE UNIQUE INDEX IF NOT EXISTS labels_root_name
    ON labels (label_set_id, name) WHERE parent_id IS NULL;

CREATE TABLE IF NOT EXISTS item_labels (
    item_type TEXT NOT NULL CHECK (item_type IN ('ride', 'pack')),
    item_id   UUID NOT NULL,
    label_id  UUID NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (item_type, item_id, label_id)
);
-- The facet query walks label -> items; the filter walks item -> labels.
CREATE INDEX IF NOT EXISTS item_labels_label_idx ON item_labels (label_id);
