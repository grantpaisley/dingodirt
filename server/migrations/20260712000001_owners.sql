-- Owners: provenance for every track (Docs/plans/2026-07-12-owners-and-import-design.md).
-- One concept subsumes "heat source": kind me/friend/source/synthetic, with the
-- UI's mine/others/strava derived from it. Identity key by kind: me/friend →
-- email (re-adding an email reuses the owner), source → unique name.
CREATE TABLE owners (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL CHECK (kind IN ('me', 'friend', 'source', 'synthetic')),
    -- Required for people, meaningless for data sources.
    email TEXT UNIQUE,
    -- Display label for people; the identity key for sources.
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT owners_email_matches_kind CHECK (
        (kind IN ('me', 'friend') AND email IS NOT NULL)
        OR (kind IN ('source', 'synthetic') AND email IS NULL)
    )
);

CREATE UNIQUE INDEX owners_source_name_key ON owners (name) WHERE kind = 'source';
-- Exactly one "me" until the multi-user future arrives.
CREATE UNIQUE INDEX owners_single_me ON owners ((TRUE)) WHERE kind = 'me';

-- Fixed IDs so rides.owner_id can carry a literal DEFAULT (below) and so the
-- harvester can reference the Strava owner without a name lookup.
INSERT INTO owners (id, kind, email, name) VALUES
    ('95e99fec-2494-4e9e-8f1c-82645b847cc5', 'me', 'grant@angrykoala.com.au', 'Grant'),
    ('43aee2c4-f2c9-46b2-930e-c3c7dd8f4a95', 'synthetic', NULL, 'Strava global');

-- Backfill: everything ingested so far is the user's own. The DEFAULT stays so
-- existing ingest INSERTs keep working (new rides are "me") until the Import
-- flow starts assigning owners explicitly.
ALTER TABLE rides
    ADD COLUMN owner_id UUID NOT NULL
    DEFAULT '95e99fec-2494-4e9e-8f1c-82645b847cc5'
    REFERENCES owners (id);

CREATE INDEX rides_owner_id_idx ON rides (owner_id);
